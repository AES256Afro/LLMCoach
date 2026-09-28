"""Watched folders ("the inbox"): files dropped into a folder join a project's knowledge base.

A background task polls each enabled source. A file is processed once it has stopped changing
(a copy over SMB can take a while), then hashed, scanned for secrets and personal data, and handed
to the same code path as an upload. Every file gets a row in the ledger (SourceFile) saying what
happened to it, and files that fail the scan wait in a review queue.

Folders are relative to settings.inbox_root, so the API can never be pointed at the rest of the disk.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import time
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import Session, select

from ..config import settings
from ..db import Document, Project, Source, SourceFile, engine, get_session, utcnow
from ..services import notify
from ..services import scan as scanner
from ..services.parsing import SUPPORTED, ParseError, parse
from .knowledge import MAX_FILE_BYTES, _safe_name, document_busy, remove_document, store_documents, submit_ingest
from .projects import get_project_or_404

log = logging.getLogger(__name__)

router = APIRouter(tags=["inbox"])

SETTLE_SECONDS = 5  # a file must look the same on two looks this far apart before it's read
OLD_FILE_SECONDS = 30  # ...unless it was last written longer ago than this
TICK_SECONDS = 5
MODES = ("remember", "learn")
SCANS = ("all", "secrets", "off")
FINAL = ("added", "duplicate", "skipped", "quarantined", "rejected", "failed")
GONE = ("gone", "forgotten")  # deleted from the folder, with or without its document
FORGET_AFTER_SECONDS = 60  # how long a deleted file stays away before its document goes too
# Editors, sync tools and browsers write these while a real file is still on its way.
_TEMP = re.compile(r"(^~\$|^\.|\.(tmp|part|partial|crdownload|download|swp)$)", re.I)

_locks: dict[int, asyncio.Lock] = {}


# ---- folders -------------------------------------------------------------------------------------

def normalize_folder(folder: str) -> str:
    """A folder under the inbox root, as a clean relative POSIX path ("." for the root)."""
    raw = (folder or "").strip().replace("\\", "/")
    absolute = raw.startswith("/") or re.match(r"^[A-Za-z]:", raw)
    raw = raw.strip("/")
    if not absolute and (not raw or raw == "."):
        return "."
    p = PurePosixPath(raw)
    if absolute or any(part in ("..", "") for part in p.parts):
        raise HTTPException(400, "the folder must be a path inside the inbox, such as 'contracts' or 'team/notes'")
    if any(part.startswith(".") for part in p.parts):
        raise HTTPException(400, "hidden folders can't be watched")
    return p.as_posix()


def source_root(src: Source) -> Path:
    root = settings.inbox_root
    path = (root / src.folder).resolve()
    if path != root and root not in path.parents:  # a symlink pointing out of the inbox
        raise HTTPException(400, f"{src.folder} leads outside the inbox")
    return path


def walk(root: Path) -> list[tuple[str, int, float]]:
    """(relative path, size, mtime) of every candidate file under root, skipping hidden and temp files."""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if _TEMP.search(name):
                continue
            path = Path(dirpath) / name
            try:
                st = path.stat()
            except OSError:
                continue  # removed while we looked
            out.append((path.relative_to(root).as_posix(), st.st_size, st.st_mtime))
    return out


def _extract_text(path: Path) -> str:
    return "\n\n".join(t for t, _ in parse(path))


# ---- processing ------------------------------------------------------------------------------------

async def _process(s: Session, src: Source, f: SourceFile, root: Path, review: bool = False) -> int | None:
    """Reads one settled file and records what happened. Returns the id of a newly stored document.
    `review=True` is the owner's "add it anyway": the scan is skipped."""
    path = root / f.relpath
    f.processed_at, f.error = utcnow(), None
    name = Path(f.relpath).name
    if Path(name).suffix.lower() not in SUPPORTED:
        f.status, f.error = "skipped", f"{Path(name).suffix or 'files without an extension'} isn't a supported type"
        return None
    if f.size_bytes > MAX_FILE_BYTES:
        f.status, f.error = "skipped", f"larger than {MAX_FILE_BYTES // 1024**2} MB"
        return None
    try:
        data = await asyncio.to_thread(path.read_bytes)
    except OSError as e:
        f.status, f.error = "failed", f"couldn't read the file: {e.strerror or e}"
        return None
    digest = hashlib.sha256(data).hexdigest()
    if review and f.sha256 and digest != f.sha256:
        # It changed after it was scanned: what the owner approved isn't what's there now.
        f.status, f.sha256, f.findings = "waiting", None, None
        return None
    old_doc = f.doc_id
    if digest == f.sha256 and old_doc and f.status == "waiting" and s.get(Document, old_doc):
        f.status = "added"  # touched, not changed
        return None
    f.sha256 = digest

    if src.scan != "off" and not review:
        try:
            text = await asyncio.to_thread(_extract_text, path)
        except ParseError as e:
            f.status, f.error = "failed", str(e)
            return None
        findings = scanner.scan_text(text, personal=src.scan == "all")
        if findings:
            f.status, f.findings = "quarantined", scanner.as_dicts(findings)
            return None
    f.findings = None if not review else f.findings

    added, skipped = await store_documents(s, src.project_id, [(name, data)])
    if added:
        f.status, f.doc_id = "added", added[0].id
        if old_doc and old_doc != f.doc_id and (doc := s.get(Document, old_doc)) is not None:
            if document_busy(s, doc) is None:
                remove_document(s, doc)  # the new version replaces it
        return added[0].id
    reason = skipped[0]
    if "doc_id" in reason:
        f.status, f.doc_id = "duplicate", reason["doc_id"]
    else:
        f.status, f.error = "skipped", reason["reason"]
    return None


def _forget(s: Session, f: SourceFile) -> None:
    """Removes the document a deleted file added, unless another watched copy still holds it."""
    doc = s.get(Document, f.doc_id) if f.doc_id else None
    if doc is not None:
        heir = s.exec(select(SourceFile).where(SourceFile.doc_id == doc.id, SourceFile.status == "duplicate",
                                               SourceFile.id != f.id, SourceFile.missing_at == None)).first()  # noqa: E711
        if heir is not None:
            heir.status = "added"  # the same content is still in a watched folder: it keeps the document
            s.add(heir)
            f.status, f.missing_at = "gone", None
            return
        if document_busy(s, doc) is not None:
            return  # being indexed; the next look tries again
    f.status, f.doc_id, f.missing_at = "forgotten", None, None
    s.add(f)
    if doc is not None:
        remove_document(s, doc)


def _handle_missing(s: Session, src: Source, rows: dict[str, SourceFile], present: set[str]) -> str | None:
    """Settles ledger rows whose file is no longer in the folder. Returns a warning, if any.

    Files that added nothing are simply dropped from the ledger. An added file becomes "gone" and its
    document stays, unless the source mirrors deletions: then the document is removed once the file
    has been away for FORGET_AFTER_SECONDS (a sync tool swapping a file in place doesn't count)."""
    now = utcnow()
    kept = 0
    for rel, f in rows.items():
        if rel in present or f.status in GONE:
            continue
        if f.status != "added":
            s.delete(f)  # nothing in the knowledge base came from it
        elif not src.mirror_deletes:
            f.status, f.missing_at = "gone", None
            s.add(f)
        elif not present:
            kept += 1  # the whole folder is empty: far more likely an unmounted share than a clear-out
        elif f.missing_at is None:
            f.missing_at = now
            s.add(f)
        elif (now - f.missing_at.replace(tzinfo=now.tzinfo)).total_seconds() >= FORGET_AFTER_SECONDS:
            _forget(s, f)
    s.commit()
    if kept:
        return (f"The folder looks empty, so its {kept} document{'s were' if kept > 1 else ' was'} kept in the "
                "knowledge base. If you emptied it on purpose, remove them on the Knowledge page.")
    return None


async def _after_added(s: Session, src: Source, doc_ids: list[int]) -> dict:
    """Indexes the new documents and, for a "learn" source, queues practice Q&A after them."""
    from .chat import default_chat_model
    from .datasets import learn_into_chat_dataset

    if not doc_ids:
        return {}
    project = s.get(Project, src.project_id)
    job = submit_ingest(s, project, doc_ids)
    out = {"ingest_job_id": job.id}
    if src.mode == "learn":
        try:
            model = project.effective_settings().get("chat_model") or await default_chat_model(s)
        except HTTPException as e:
            src.last_error = f"indexed, but couldn't learn from the files: {e.detail}"
            return out
        d, gen = learn_into_chat_dataset(s, project, model, doc_ids, max_chunks=min(40, 8 * len(doc_ids)), source="inbox")
        out.update(learn_job_id=gen.id, dataset_id=d.id)
    return out


async def poll_source(source_id: int) -> dict:
    """Looks at a source's folder once. Safe to call while the watcher runs: polls of one source queue up."""
    lock = _locks.setdefault(source_id, asyncio.Lock())
    async with lock:
        with Session(engine) as s:
            src = s.get(Source, source_id)
            if src is None:
                return {}
            try:
                root = source_root(src)
                root.mkdir(parents=True, exist_ok=True)
                listing = await asyncio.to_thread(walk, root)
            except (OSError, HTTPException) as e:
                src.last_scan_at, src.last_error = utcnow(), getattr(e, "detail", None) or f"can't read the folder: {e}"
                s.add(src)
                s.commit()
                return {"error": src.last_error}

            now = time.time()
            rows = {f.relpath: f for f in s.exec(select(SourceFile).where(SourceFile.source_id == src.id))}
            ready: list[SourceFile] = []
            for rel, size, mtime in listing:
                f = rows.get(rel)
                if f is not None and f.missing_at is not None:
                    f.missing_at = None  # back again before its document was removed
                    s.add(f)
                if f is None:
                    f = SourceFile(source_id=src.id, project_id=src.project_id, relpath=rel, size_bytes=size, mtime=mtime)
                    s.add(f)
                    if now - mtime >= OLD_FILE_SECONDS:
                        ready.append(f)
                elif f.status in GONE:
                    # Put back after it was deleted: read it again. If its document was kept and the
                    # content is the same, _process just marks it added.
                    f.size_bytes, f.mtime, f.status = size, mtime, "waiting"
                    s.add(f)
                    if now - mtime >= OLD_FILE_SECONDS:
                        ready.append(f)
                elif (f.size_bytes, f.mtime) != (size, mtime):
                    # Being written, or a new version. Only a document this file added is its own to
                    # replace later; a duplicate's doc_id points at someone else's.
                    if f.status != "added":
                        f.doc_id = None
                    f.size_bytes, f.mtime, f.status = size, mtime, "waiting"
                    s.add(f)
                elif f.status == "waiting" and now - mtime >= SETTLE_SECONDS:
                    ready.append(f)
            s.commit()
            warning = _handle_missing(s, src, rows, {rel for rel, _, _ in listing})

            counts: dict[str, int] = {}
            new_docs: list[int] = []
            held: list[str] = []
            for f in ready:
                doc_id = await _process(s, src, f, root)
                if doc_id:
                    new_docs.append(doc_id)
                if f.status == "quarantined":
                    held.append(f.relpath)
                counts[f.status] = counts.get(f.status, 0) + 1
                s.add(f)
                s.commit()
            if held:
                more = f" and {len(held) - 5} more" if len(held) > 5 else ""
                notify.send("review", f"{len(held)} file{'s' if len(held) > 1 else ''} held for review",
                            f"In “{src.name}”: {', '.join(held[:5])}{more}. They may contain secrets or personal data.",
                            4, "lock")
            src.last_scan_at, src.last_error = utcnow(), warning
            jobs = await _after_added(s, src, new_docs)
            s.add(src)
            s.commit()
            waiting = len(s.exec(select(SourceFile.id).where(SourceFile.source_id == src.id,
                                                             SourceFile.status == "waiting")).all())
            return {"seen": len(listing), "processed": counts, "waiting": waiting, **jobs}


async def _tick() -> None:
    with Session(engine) as s:
        sources = list(s.exec(select(Source).where(Source.enabled == True)))  # noqa: E712
        waiting = set(s.exec(select(SourceFile.source_id).where(SourceFile.status == "waiting")).all()) if sources else set()
    now = utcnow()
    for src in sources:
        last = src.last_scan_at.replace(tzinfo=now.tzinfo) if src.last_scan_at else None
        age = (now - last).total_seconds() if last else None
        if age is None or age >= src.poll_seconds or (src.id in waiting and age >= SETTLE_SECONDS):
            try:
                await poll_source(src.id)
            except Exception:
                log.exception("inbox: polling source #%s failed", src.id)


async def watch_forever() -> None:
    from .loop import scheduler_tick  # the nightly learning loop shares the heartbeat

    while True:
        try:
            await _tick()
            await scheduler_tick()
        except Exception:
            log.exception("inbox watcher tick failed")
        await asyncio.sleep(TICK_SECONDS)


# ---- API ---------------------------------------------------------------------------------------------

def _counts(s: Session, source_id: int) -> dict[str, int]:
    out: dict[str, int] = {}
    for status in s.exec(select(SourceFile.status).where(SourceFile.source_id == source_id)).all():
        out[status] = out.get(status, 0) + 1
    return out


def _out(s: Session, src: Source) -> dict:
    return {**src.model_dump(mode="json"), "counts": _counts(s, src.id),
            "path": str(settings.inbox_root / src.folder) if src.folder != "." else str(settings.inbox_root)}


def _get_source(s: Session, project_id: int, source_id: int) -> Source:
    src = s.get(Source, source_id)
    if src is None or src.project_id != project_id:
        raise HTTPException(404, "source not found")
    return src


@router.get("/api/inbox")
def inbox_info() -> dict:
    return {"root": str(settings.inbox_root), "settle_seconds": SETTLE_SECONDS,
            "supported": sorted(SUPPORTED), "max_file_mb": MAX_FILE_BYTES // 1024**2}


@router.get("/api/projects/{project_id}/sources")
def list_sources(project_id: int, session: Session = Depends(get_session)) -> list[dict]:
    get_project_or_404(session, project_id)
    return [_out(session, x) for x in session.exec(select(Source).where(Source.project_id == project_id).order_by(Source.id))]


class SourceCreate(BaseModel):
    name: str | None = None
    folder: str
    mode: str = "remember"
    scan: str = "all"
    poll_seconds: int = 30
    mirror_deletes: bool = False


class SourceUpdate(BaseModel):
    name: str | None = None
    mode: str | None = None
    scan: str | None = None
    enabled: bool | None = None
    poll_seconds: int | None = None
    mirror_deletes: bool | None = None


def _validate(mode: str | None, scan: str | None, poll: int | None) -> None:
    if mode is not None and mode not in MODES:
        raise HTTPException(400, f"mode must be one of {', '.join(MODES)}")
    if scan is not None and scan not in SCANS:
        raise HTTPException(400, f"scan must be one of {', '.join(SCANS)}")
    if poll is not None and not 10 <= poll <= 86400:
        raise HTTPException(400, "poll_seconds must be between 10 and 86400")


@router.post("/api/projects/{project_id}/sources", status_code=201)
def create_source(project_id: int, body: SourceCreate, session: Session = Depends(get_session)) -> dict:
    get_project_or_404(session, project_id)
    _validate(body.mode, body.scan, body.poll_seconds)
    folder = normalize_folder(body.folder)
    for other in session.exec(select(Source)):
        # Folders are watched with their subfolders, so nested sources would read the same files twice.
        a, b = PurePosixPath(folder), PurePosixPath(other.folder)
        if folder == "." or other.folder == "." or a == b or a in b.parents or b in a.parents:
            raise HTTPException(409, f"'{folder}' overlaps '{other.folder}', which '{other.name}' already watches")
    src = Source(project_id=project_id, name=(body.name or (folder if folder != "." else "Inbox")).strip()[:80],
                 folder=folder, mode=body.mode, scan=body.scan, poll_seconds=body.poll_seconds,
                 mirror_deletes=body.mirror_deletes)
    source_root(src).mkdir(parents=True, exist_ok=True)
    session.add(src)
    session.commit()
    session.refresh(src)
    return _out(session, src)


@router.patch("/api/projects/{project_id}/sources/{source_id}")
def update_source(project_id: int, source_id: int, body: SourceUpdate, session: Session = Depends(get_session)) -> dict:
    src = _get_source(session, project_id, source_id)
    _validate(body.mode, body.scan, body.poll_seconds)
    for key, value in body.model_dump(exclude_none=True).items():
        setattr(src, key, value.strip()[:80] if key == "name" else value)
    session.add(src)
    session.commit()
    session.refresh(src)
    return _out(session, src)


@router.delete("/api/projects/{project_id}/sources/{source_id}", status_code=204)
def delete_source(project_id: int, source_id: int, session: Session = Depends(get_session)) -> None:
    """Stops watching. The folder's files and the documents already added stay."""
    src = _get_source(session, project_id, source_id)
    for f in session.exec(select(SourceFile).where(SourceFile.source_id == src.id)):
        session.delete(f)
    session.flush()
    session.delete(src)
    session.commit()


@router.post("/api/projects/{project_id}/sources/{source_id}/scan")
async def scan_now(project_id: int, source_id: int, session: Session = Depends(get_session)) -> dict:
    _get_source(session, project_id, source_id)
    return await poll_source(source_id)


@router.get("/api/projects/{project_id}/sources/{source_id}/files")
def list_files(project_id: int, source_id: int, status: str | None = None, offset: int = 0, limit: int = 100,
               session: Session = Depends(get_session)) -> dict:
    _get_source(session, project_id, source_id)
    q = select(SourceFile).where(SourceFile.source_id == source_id)
    if status:
        q = q.where(SourceFile.status == status)
    rows = list(session.exec(q.order_by(SourceFile.id.desc())))
    return {"files": rows[offset:offset + min(limit, 500)], "total": len(rows)}


@router.get("/api/projects/{project_id}/inbox/review")
def review_queue(project_id: int, session: Session = Depends(get_session)) -> list[dict]:
    get_project_or_404(session, project_id)
    names = {x.id: x.name for x in session.exec(select(Source).where(Source.project_id == project_id))}
    files = session.exec(select(SourceFile).where(SourceFile.project_id == project_id, SourceFile.status == "quarantined")
                         .order_by(SourceFile.id))
    return [{**f.model_dump(mode="json"), "source_name": names.get(f.source_id)} for f in files]


def _get_file(s: Session, project_id: int, file_id: int) -> SourceFile:
    f = s.get(SourceFile, file_id)
    if f is None or f.project_id != project_id:
        raise HTTPException(404, "file not found")
    return f


@router.post("/api/projects/{project_id}/inbox/files/{file_id}/approve")
async def approve_file(project_id: int, file_id: int, session: Session = Depends(get_session)) -> dict:
    """The owner looked at the findings and wants the file in the knowledge base anyway."""
    f = _get_file(session, project_id, file_id)
    if f.status not in ("quarantined", "rejected"):
        raise HTTPException(409, f"this file is {f.status}, not waiting for review")
    src = session.get(Source, f.source_id)
    lock = _locks.setdefault(src.id, asyncio.Lock())
    async with lock:
        doc_id = await _process(session, src, f, source_root(src), review=True)
        f.reviewed_at = utcnow()
        session.add(f)
        session.commit()
        jobs = await _after_added(session, src, [doc_id] if doc_id else [])
        session.add(src)
        session.commit()
    session.refresh(f)
    return {"file": f, **jobs}


@router.post("/api/projects/{project_id}/inbox/files/{file_id}/reject")
def reject_file(project_id: int, file_id: int, session: Session = Depends(get_session)) -> SourceFile:
    """Keeps it out. If the file changes later it's scanned again."""
    f = _get_file(session, project_id, file_id)
    if f.status != "quarantined":
        raise HTTPException(409, f"this file is {f.status}, not waiting for review")
    f.status, f.reviewed_at = "rejected", utcnow()
    session.add(f)
    session.commit()
    session.refresh(f)
    return f


def _free_name(folder: Path, name: str, data: bytes) -> Path | None:
    """Where to write an upload without overwriting a different file; None if the same file is there."""
    stem, suffix = Path(name).stem, Path(name).suffix
    candidate, n = folder / name, 2
    while candidate.exists():
        if candidate.stat().st_size == len(data) and candidate.read_bytes() == data:
            return None
        candidate, n = folder / f"{stem} ({n}){suffix}", n + 1
    return candidate


@router.post("/api/projects/{project_id}/sources/{source_id}/upload")
async def upload_to_source(project_id: int, source_id: int, files: list[UploadFile] = File(...),
                           session: Session = Depends(get_session)) -> dict:
    """Drops files into the source's folder, exactly as if they'd been copied there, and looks at
    them straight away. This is what API tokens with the "inbox" scope may call."""
    src = _get_source(session, project_id, source_id)
    root = source_root(src)
    root.mkdir(parents=True, exist_ok=True)
    written, unchanged = [], []
    for up in files:
        data = await up.read(MAX_FILE_BYTES + 1)
        name = _safe_name(up.filename or "file")
        target = await asyncio.to_thread(_free_name, root, name, data)
        if target is None:
            unchanged.append(name)
            continue
        await asyncio.to_thread(target.write_bytes, data)
        # Written in one go, so there's nothing to wait for.
        os.utime(target, (time.time() - OLD_FILE_SECONDS, time.time() - OLD_FILE_SECONDS))
        written.append(target.name)
    result = await poll_source(src.id)
    return {"written": written, "unchanged": unchanged, **result}


def delete_project_sources(session: Session, project_id: int) -> None:
    for f in session.exec(select(SourceFile).where(SourceFile.project_id == project_id)):
        session.delete(f)
    session.flush()
    for src in session.exec(select(Source).where(Source.project_id == project_id)):
        session.delete(src)
    session.flush()
