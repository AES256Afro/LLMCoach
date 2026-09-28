import asyncio
import hashlib
import re
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import Session, select

from ..config import settings
from ..db import Document, DocStatus, Job, JobStatus, Project, engine, get_session
from ..services import kb, web
from ..services import scan as scanner
from ..services.jobs import FINISH_HOOKS, manager
from ..services.parsing import SUPPORTED, ParseError, parse
from ..services.providers import ProviderError, resolve
from .projects import get_project_or_404

router = APIRouter(prefix="/api/projects/{project_id}", tags=["knowledge"])

MAX_FILE_BYTES = 100 * 1024 * 1024


def docs_dir(project_id: int) -> Path:
    return settings.data_dir / "docs" / str(int(project_id))


def _safe_name(name: str) -> str:
    name = Path(name or "file").name
    return re.sub(r"[^\w.\- ]+", "_", name).strip() or "file"


def _submit_ingest(session: Session, project: Project, doc_ids: list[int], reset: bool = False) -> Job:
    for d in doc_ids:
        doc = session.get(Document, d)
        doc.status, doc.error = DocStatus.pending, None
        session.add(doc)
    session.commit()
    return manager.submit(session, "ingest", {"project_id": project.id, "doc_ids": doc_ids, "reset": reset},
                          project_id=project.id)


def _mark_unprocessed(job: Job) -> None:
    """Documents the ingest job never reached (cancelled, crashed) shouldn't stay 'pending'."""
    with Session(engine) as s:
        for d in job.config.get("doc_ids", []):
            doc = s.get(Document, int(d))
            if doc is not None and doc.status in (DocStatus.pending, DocStatus.ingesting):
                doc.status = DocStatus.failed
                doc.error = f"ingest job #{job.id} {job.status.value} before this document was processed"
                s.add(doc)
        s.commit()


FINISH_HOOKS["ingest"] = _mark_unprocessed


@router.get("/documents")
def list_documents(project_id: int, session: Session = Depends(get_session)) -> list[Document]:
    get_project_or_404(session, project_id)
    return list(session.exec(select(Document).where(Document.project_id == project_id).order_by(Document.id.desc())))


@router.post("/documents", status_code=201)
async def upload_documents(project_id: int, files: list[UploadFile] = File(...), check: bool = True,
                           session: Session = Depends(get_session)) -> dict:
    project = get_project_or_404(session, project_id)
    items = [(f.filename or "file", await f.read(MAX_FILE_BYTES + 1)) for f in files]
    added, skipped = await store_documents(session, project_id, items)
    ready, held = await hold_suspicious(session, added) if check else (added, [])
    job = _submit_ingest(session, project, [d.id for d in ready]) if ready else None
    for d in added:
        session.refresh(d)
    return {"documents": added, "skipped": skipped, "held": held, "job": job}


class AddUrl(BaseModel):
    url: str


@router.post("/documents/url", status_code=201)
async def add_url(project_id: int, body: AddUrl, check: bool = True, session: Session = Depends(get_session)) -> dict:
    """Fetches a web page (or a PDF or text file by its address) and adds it like an upload."""
    project = get_project_or_404(session, project_id)
    try:
        name, data, final = await web.fetch(body.url, MAX_FILE_BYTES)
    except web.WebError as e:
        raise HTTPException(400, str(e)) from e
    added, skipped = await store_documents(session, project_id, [(name, data)], source_url=final)
    ready, held = await hold_suspicious(session, added) if check else (added, [])
    job = _submit_ingest(session, project, [d.id for d in ready]) if ready else None
    for d in added:
        session.refresh(d)
    return {"documents": added, "skipped": skipped, "held": held, "job": job}


async def hold_suspicious(session: Session, docs: list[Document]) -> tuple[list[Document], list[dict]]:
    """Splits newly stored documents into those to index and those held back because they look like
    they contain secrets or personal data (the same check as the inbox). A held document stays
    stored but unindexed, so nothing can quote it, until the owner indexes or removes it."""
    ready, held = [], []
    for d in docs:
        try:
            text = await asyncio.to_thread(lambda p=settings.data_dir / d.path: "\n\n".join(t for t, _ in parse(p)))
        except ParseError:
            ready.append(d)  # the indexing job reports why it can't be read
            continue
        findings = scanner.scan_text(text)
        if findings:
            held.append({"doc_id": d.id, "filename": d.filename, "findings": scanner.as_dicts(findings)})
            d.status = DocStatus.held
            d.error = "Held back: may contain " + ", ".join(f.label.lower() for f in findings) + ". Index it anyway, or remove it."
            session.add(d)
            session.commit()
        else:
            ready.append(d)
    return ready, held


async def store_documents(session: Session, project_id: int, items: list[tuple[str, bytes]],
                          source_url: str | None = None) -> tuple[list[Document], list[dict]]:
    """Saves (filename, bytes) pairs as knowledge-base documents, skipping unsupported, empty,
    oversized and duplicate files. Shared by the upload page and the chat's drop zone."""
    target = docs_dir(project_id)
    target.mkdir(parents=True, exist_ok=True)
    existing = {d.sha256: d.id for d in session.exec(select(Document).where(Document.project_id == project_id))}
    added: list[Document] = []
    skipped: list[dict] = []
    for filename, data in items:
        name = _safe_name(filename)
        if Path(name).suffix.lower() not in SUPPORTED:
            skipped.append({"filename": name, "reason": "unsupported file type"})
            continue
        if len(data) > MAX_FILE_BYTES:
            skipped.append({"filename": name, "reason": f"larger than {MAX_FILE_BYTES // 1024**2} MB"})
            continue
        if not data:
            skipped.append({"filename": name, "reason": "empty file"})
            continue
        digest = await asyncio.to_thread(lambda: hashlib.sha256(data).hexdigest())
        if digest in existing:
            skipped.append({"filename": name, "reason": "already in this knowledge base", "doc_id": existing[digest]})
            continue
        doc = Document(project_id=project_id, filename=name, path="", size_bytes=len(data), sha256=digest,
                       source_url=source_url)
        session.add(doc)
        session.commit()
        session.refresh(doc)
        existing[digest] = doc.id
        path = target / f"{doc.id}_{name}"
        await asyncio.to_thread(path.write_bytes, data)
        doc.path = str(path.relative_to(settings.data_dir))
        session.add(doc)
        session.commit()
        added.append(doc)
    return added, skipped


def submit_ingest(session: Session, project: Project, doc_ids: list[int]) -> Job:
    return _submit_ingest(session, project, doc_ids)


class Reindex(BaseModel):
    doc_ids: list[int] | None = None  # None = every document (and rebuild the index)


@router.post("/documents/reindex")
def reindex(project_id: int, body: Reindex, session: Session = Depends(get_session)) -> Job:
    project = get_project_or_404(session, project_id)
    docs = list(session.exec(select(Document).where(Document.project_id == project_id)))
    if body.doc_ids is not None:
        wanted = set(body.doc_ids)
        docs = [d for d in docs if d.id in wanted]
    if not docs:
        raise HTTPException(400, "no documents to re-index")
    return _submit_ingest(session, project, [d.id for d in docs], reset=body.doc_ids is None)


@router.delete("/documents/{doc_id}", status_code=204)
def delete_document(project_id: int, doc_id: int, session: Session = Depends(get_session)) -> None:
    doc = session.get(Document, doc_id)
    if doc is None or doc.project_id != project_id:
        raise HTTPException(404, "document not found")
    if busy := document_busy(session, doc):
        raise HTTPException(409, busy)
    remove_document(session, doc)


def document_busy(session: Session, doc: Document) -> str | None:
    """Why a document can't be removed right now, or None."""
    if doc.status == DocStatus.ingesting:
        return "this document is being ingested; wait for the job or cancel it first"
    if doc.status == DocStatus.pending:
        active = session.exec(select(Job).where(Job.kind == "ingest", Job.project_id == doc.project_id,
                                                Job.status.in_([JobStatus.queued, JobStatus.running])))
        if any(doc.id in (job.config or {}).get("doc_ids", []) for job in active):
            return "this document is queued for ingest; wait for the job or cancel it first"
    return None


def remove_document(session: Session, doc: Document) -> None:
    """Deletes a document and its passages. Check document_busy() first."""
    # No full-text index rebuild: the deleted rows simply stop matching, and the next ingest rebuilds it.
    kb.delete_doc(doc.project_id, doc.id)
    if doc.path:
        (settings.data_dir / doc.path).unlink(missing_ok=True)
    session.delete(doc)
    session.commit()


@router.get("/documents/{doc_id}/chunks")
def document_chunks(project_id: int, doc_id: int, offset: int = 0, limit: int = 50,
                    session: Session = Depends(get_session)) -> dict:
    doc = session.get(Document, doc_id)
    if doc is None or doc.project_id != project_id:
        raise HTTPException(404, "document not found")
    rows, total = kb.list_chunks(project_id, doc_id, offset, min(limit, 500))
    return {"chunks": rows, "total": total}


@router.get("/knowledge")
def knowledge_stats(project_id: int, session: Session = Depends(get_session)) -> dict:
    project = get_project_or_404(session, project_id)
    embed_model = project.effective_settings()["embed_model"]
    docs = list(session.exec(select(Document).where(Document.project_id == project_id)))
    by_status = {s.value: 0 for s in DocStatus}
    for d in docs:
        by_status[d.status.value] += 1
    stale = [d.id for d in docs if d.status == DocStatus.ready and d.embed_model != embed_model]
    return {
        "documents": len(docs),
        "by_status": by_status,
        "chunks": kb.count(project_id),
        "dimension": kb.dimension(project_id),
        "embed_model": embed_model,
        "stale_doc_ids": stale,  # embedded with a different model than the current setting
        "bytes": sum(d.size_bytes for d in docs),
    }


class SearchBody(BaseModel):
    query: str
    top_k: int | None = None
    doc_ids: list[int] | None = None


async def retrieve(session: Session, project: Project, query: str, top_k: int | None = None,
                   doc_ids: list[int] | None = None) -> dict:
    """Embeds the query and searches the project's index. Shared with chat (RAG)."""
    cfg = project.effective_settings()
    k = max(1, min(int(top_k or cfg["top_k"]), 50))
    started = time.perf_counter()
    try:
        client, model, _ = resolve(cfg["embed_model"], session)
        vec = (await client.embed(model, [query], kind="query"))[0]
    except ProviderError as e:
        raise HTTPException(502, str(e))
    embed_ms = (time.perf_counter() - started) * 1000
    try:
        text = query if cfg.get("search_mode", "hybrid") == "hybrid" else None
        hits, mode = await asyncio.to_thread(kb.search, project.id, vec, k, doc_ids, text=text)
    except kb.KBError as e:
        raise HTTPException(409, str(e))
    names = {d.id: d.filename for d in session.exec(select(Document).where(Document.project_id == project.id))}
    for h in hits:
        h["filename"] = names.get(h["doc_id"], f"document {h['doc_id']}")
    return {"results": hits, "mode": mode, "embed_ms": round(embed_ms),
            "total_ms": round((time.perf_counter() - started) * 1000)}


@router.post("/search")
async def search(project_id: int, body: SearchBody, session: Session = Depends(get_session)) -> dict:
    project = get_project_or_404(session, project_id)
    if not body.query.strip():
        raise HTTPException(400, "query is empty")
    return await retrieve(session, project, body.query.strip(), body.top_k, body.doc_ids)


def delete_project_knowledge(session: Session, project_id: int) -> None:
    """Used when a project is deleted."""
    for d in session.exec(select(Document).where(Document.project_id == project_id)):
        session.delete(d)
    session.flush()
    kb.drop(project_id)
    shutil.rmtree(docs_dir(project_id), ignore_errors=True)
