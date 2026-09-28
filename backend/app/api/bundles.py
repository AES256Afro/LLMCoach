"""Moving a project between LLMCoach installs: export it as one zip, import it elsewhere.

A bundle holds the project's settings, its documents as the original files, its datasets, its
conversations (the user's and the model's turns; event cards refer to jobs that won't exist on the
other side), and optionally the trained adapters, whose fine-tunes then arrive ready to use.
Evaluations, watched folders and jobs stay behind: they belong to the install, not the project.
Importing creates a new project and indexes its documents with that install's embedding model.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from ..config import settings
from ..db import (Conversation, Dataset, DatasetStatus, Document, FineTune, FineTuneStatus, Message, Project,
                  get_session, utcnow)
from ..services import datasets as ds
from .knowledge import MAX_FILE_BYTES, store_documents, submit_ingest
from .projects import _out as project_out
from .projects import get_project_or_404

router = APIRouter(tags=["bundles"])

FORMAT, VERSION = "llmcoach-project", 1
MAX_BUNDLE_BYTES = 20 * 1024**3  # uncompressed; a 7B adapter is well under this
MAX_MEMBER_BYTES = 8 * 1024**3


def _safe_rel(name: str) -> PurePosixPath:
    p = PurePosixPath(name)
    if p.is_absolute() or not p.parts or any(part in ("", ".", "..") for part in p.parts) or ":" in name:
        raise HTTPException(400, f"the bundle has an unsafe path: {name}")
    return p


def _write_bundle(project_id: int, adapters: bool, out: Path) -> None:
    from ..db import engine

    with Session(engine) as s, zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as z:
        project = s.get(Project, project_id)
        manifest: dict = {"format": FORMAT, "version": VERSION, "exported_at": utcnow().isoformat(),
                          "app_version": settings.version,
                          "project": {"name": project.name, "description": project.description, "settings": project.settings or {}},
                          "documents": [], "datasets": [], "finetunes": [], "conversations": []}
        for i, d in enumerate(s.exec(select(Document).where(Document.project_id == project_id).order_by(Document.id))):
            src = settings.data_dir / d.path if d.path else None
            if src is None or not src.is_file():
                continue
            member = f"documents/{i + 1}_{d.filename}"
            z.write(src, member)
            manifest["documents"].append({"file": member, "filename": d.filename, "source_url": d.source_url})
        for d in s.exec(select(Dataset).where(Dataset.project_id == project_id).order_by(Dataset.id)):
            path = ds.dataset_path(project_id, d.id)
            if d.status != DatasetStatus.ready or not path.is_file():
                continue
            member = f"datasets/{d.id}.jsonl"
            z.write(path, member)
            manifest["datasets"].append({"key": d.id, "file": member, "name": d.name, "source": d.source})
        kept = {x["key"] for x in manifest["datasets"]}
        for f in s.exec(select(FineTune).where(FineTune.project_id == project_id).order_by(FineTune.id)):
            adapter = settings.data_dir / f.output_dir if f.output_dir else None
            if f.status != FineTuneStatus.ready or not adapters or adapter is None or not adapter.is_dir():
                continue
            prefix = f"adapters/{f.id}/"
            for file in sorted(p for p in adapter.rglob("*") if p.is_file()):
                z.write(file, prefix + file.relative_to(adapter).as_posix())
            manifest["finetunes"].append({
                "key": f.id, "name": f.name, "base_model": f.base_model, "method": f.method, "backend": f.backend,
                "dataset": f.dataset_id if f.dataset_id in kept else None, "config": f.config, "metrics": f.metrics,
                "promoted": f.promoted_at is not None, "adapter": prefix,
                "finished_at": f.finished_at.isoformat() if f.finished_at else None})
        for c in s.exec(select(Conversation).where(Conversation.project_id == project_id).order_by(Conversation.id)):
            msgs = s.exec(select(Message).where(Message.conversation_id == c.id, Message.role.in_(["user", "assistant"]))
                          .order_by(Message.id))
            manifest["conversations"].append({
                "title": c.title, "model": c.model, "use_rag": c.use_rag, "system_prompt": c.system_prompt,
                "messages": [{"role": m.role, "content": m.content, "thinking": m.thinking, "model": m.model,
                              "sources": m.sources, "stats": m.stats} for m in msgs]})
        z.writestr("manifest.json", json.dumps(manifest, indent=1, ensure_ascii=False))


@router.get("/api/projects/{project_id}/export")
async def export_project(project_id: int, background: BackgroundTasks, adapters: bool = True,
                         session: Session = Depends(get_session)) -> FileResponse:
    project = get_project_or_404(session, project_id)
    tmp = Path(tempfile.mkdtemp(prefix="llmcoach-export-"))
    out = tmp / "bundle.zip"
    await asyncio.to_thread(_write_bundle, project_id, adapters, out)
    background.add_task(shutil.rmtree, tmp, True)
    slug = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in project.name.lower()).strip("-") or "project"
    return FileResponse(out, media_type="application/zip", filename=f"llmcoach-{slug}.zip")


def _free_project_name(s: Session, name: str) -> str:
    taken = set(s.exec(select(Project.name)).all())
    if name not in taken:
        return name
    n = 1
    while (candidate := f"{name} (imported{'' if n == 1 else f' {n}'})") in taken:
        n += 1
    return candidate


@router.post("/api/projects/import", status_code=201)
async def import_project(file: UploadFile = File(...), session: Session = Depends(get_session)) -> dict:
    tmp = Path(tempfile.mkdtemp(prefix="llmcoach-import-"))
    try:
        bundle = tmp / "bundle.zip"
        with open(bundle, "wb") as fh:
            await asyncio.to_thread(shutil.copyfileobj, file.file, fh, 1 << 20)
        return await _import(session, bundle)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def _import(s: Session, bundle: Path) -> dict:
    try:
        z = zipfile.ZipFile(bundle)
    except zipfile.BadZipFile as e:
        raise HTTPException(400, "that isn't a zip file") from e
    with z:
        infos = {i.filename: i for i in z.infolist()}
        if sum(i.file_size for i in infos.values()) > MAX_BUNDLE_BYTES:
            raise HTTPException(400, "the bundle is too large")
        try:
            manifest = json.loads(z.read("manifest.json"))
        except (KeyError, ValueError) as e:
            raise HTTPException(400, "not an LLMCoach project bundle: manifest.json is missing or unreadable") from e
        if manifest.get("format") != FORMAT or manifest.get("version", 0) > VERSION:
            raise HTTPException(400, "not an LLMCoach project bundle this version can read")

        def read(member: str, limit: int = MAX_MEMBER_BYTES) -> bytes:
            _safe_rel(member)
            info = infos.get(member)
            if info is None:
                raise HTTPException(400, f"the bundle lists {member} but doesn't contain it")
            if info.file_size > limit:
                raise HTTPException(400, f"{member} is too large")
            return z.read(info)

        meta = manifest.get("project") or {}
        project = Project(name=_free_project_name(s, str(meta.get("name") or "Imported project")[:100]),
                          description=str(meta.get("description") or ""), settings=meta.get("settings") or None)
        s.add(project)
        s.commit()
        s.refresh(project)
        pid = project.id
        try:
            counts = await _fill(s, project, manifest, infos, read)
        except BaseException:
            from .projects import delete_project

            s.rollback()
            delete_project(pid, s)  # nothing half-imported is left behind
            raise
    added_ids = counts.pop("added_ids")
    job = submit_ingest(s, project, added_ids) if added_ids else None  # last, once everything is in
    s.refresh(project)
    return {"project": project_out(project), **counts, "ingest_job_id": job.id if job else None}


async def _fill(s: Session, project: Project, manifest: dict, infos: dict, read) -> dict:
    pid = project.id
    # Documents: stored like uploads (the bundle came from a knowledge base, so no privacy hold).
    items, urls = [], {}
    for d in manifest.get("documents", []):
        items.append((d["filename"], read(d["file"], MAX_FILE_BYTES)))
        urls[d["filename"]] = d.get("source_url")
    added, _ = await store_documents(s, pid, items)
    for doc in added:
        if urls.get(doc.filename):
            doc.source_url = urls[doc.filename]
            s.add(doc)
    s.commit()

    datasets: dict[int, int] = {}
    for d in manifest.get("datasets", []):
        rows = [json.loads(line) for line in read(d["file"]).decode("utf-8").splitlines() if line.strip()]
        new = Dataset(project_id=pid, name=str(d.get("name") or "dataset")[:120], source=d.get("source") or "upload",
                      status=DatasetStatus.ready)
        s.add(new)
        s.commit()
        s.refresh(new)
        path = ds.dataset_path(pid, new.id)
        path.parent.mkdir(parents=True, exist_ok=True)
        new.splits = ds.assign_new_splits(rows)
        ds.write_rows(path, rows)
        new.path, new.row_count, new.stats = str(path.relative_to(settings.data_dir)), len(rows), ds.compute_stats(rows)
        s.add(new)
        s.commit()
        datasets[int(d["key"])] = new.id

    finetunes = 0
    for f in manifest.get("finetunes", []):
        prefix = str(f.get("adapter") or "")
        members = [n for n in infos if prefix and n.startswith(prefix) and not n.endswith("/")]
        if not members:
            continue
        new = FineTune(project_id=pid, name=str(f.get("name") or "fine-tune")[:200], base_model=f["base_model"],
                       dataset_id=datasets.get(f.get("dataset")), method=f.get("method") or "lora",
                       backend=f.get("backend"), status=FineTuneStatus.ready, config=f.get("config"),
                       metrics=f.get("metrics"), finished_at=utcnow())
        s.add(new)
        s.commit()
        s.refresh(new)
        target = settings.data_dir / "finetunes" / str(new.id) / "adapter"
        for n in members:
            rel = _safe_rel(n[len(prefix):])
            dest = target.joinpath(*rel.parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(read(n))
        new.output_dir = str(target.relative_to(settings.data_dir))
        if f.get("promoted"):
            for other in s.exec(select(FineTune).where(FineTune.project_id == pid, FineTune.promoted_at != None)):  # noqa: E711
                other.promoted_at = None
                s.add(other)
            new.promoted_at = utcnow()
        s.add(new)
        s.commit()
        finetunes += 1

    conversations = 0
    for c in manifest.get("conversations", []):
        conv = Conversation(project_id=pid, title=str(c.get("title") or "Imported chat")[:200], model=c.get("model"),
                            use_rag=bool(c.get("use_rag", True)), system_prompt=c.get("system_prompt"))
        s.add(conv)
        s.commit()
        s.refresh(conv)
        for m in c.get("messages", []):
            if m.get("role") not in ("user", "assistant"):
                continue
            s.add(Message(conversation_id=conv.id, role=m["role"], content=str(m.get("content") or ""),
                          thinking=m.get("thinking"), model=m.get("model"), sources=m.get("sources"), stats=m.get("stats")))
        s.commit()
        conversations += 1
    return {"added_ids": [d.id for d in added], "documents": len(added), "datasets": len(datasets),
            "finetunes": finetunes, "conversations": conversations}
