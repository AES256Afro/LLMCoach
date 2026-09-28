"""Watched folders ("the inbox"): files dropped into a folder join a project's knowledge base.

A background task polls each enabled source. A file is processed once it has stopped changing
(a copy over SMB can take a while), then hashed, scanned for secrets and personal data, and handed
to the same code path as an upload. Every file gets a row in the ledger (SourceFile) saying what
happened to it, and files that fail the scan wait in a review queue.

Folders are relative to settings.inbox_root, so the API can never be pointed at the rest of the disk.
A bucket source (S3, MinIO...) is mirrored into data/buckets/<id> before each look, and the mirror is
then treated as its folder, so settling, checks, the ledger and deletions all work the same way.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import time
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import Session, select

from ..config import settings
from ..db import Document, Project, Source, SourceFile, engine, get_session, utcnow
from ..services import notify
from ..services import scan as scanner
from ..services import web
from ..services.s3 import Bucket, S3Error, normalize_endpoint
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
MAX_WEB_PAGES = 200
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


MIRRORED = ("bucket", "web")  # kinds read into a folder of LLMCoach's own before each look
WEB_MANIFEST = ".pages.json"  # hidden, so walk() skips it: address -> the file its page was saved as


def source_root(src: Source) -> Path:
    if src.kind == "bucket":
        return settings.data_dir / "buckets" / str(src.id)
    if src.kind == "web":
        return settings.data_dir / "web" / str(src.id)
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


def _open_bucket(src: Source) -> Bucket:
    return Bucket(src.endpoint or "", src.bucket or "", src.access_key or "", src.secret_key or "", src.region or "us-east-1")


def _placeholder(path: Path, size: int, mtime: float) -> None:
    """Stands in for an object that won't be read (too large, or a type LLMCoach can't parse): the
    ledger still records it and why, without downloading it. Sparse where the disk allows."""
    with open(path, "wb") as f:
        f.truncate(size)
    os.utime(path, (mtime, mtime))


def sync_bucket(src: Source, root: Path) -> None:
    """Makes root a copy of the bucket's objects under the source's prefix. Only new or changed
    objects are downloaded; files whose object is gone are deleted, which the ledger then notices."""
    prefix = src.prefix or ""
    seen: set[str] = set()
    with _open_bucket(src) as b:
        for obj in b.list(prefix):
            rel = PurePosixPath(obj.key[len(prefix):].lstrip("/"))
            if not rel.parts or obj.key.endswith("/") or any(p in ("..", ".") for p in rel.parts):
                continue  # "folder" markers, and keys that would climb out of the mirror
            if any(p.startswith(".") for p in rel.parts) or _TEMP.search(rel.name):
                continue
            seen.add(rel.as_posix())
            path = root.joinpath(*rel.parts)
            try:
                st = path.stat()
                if st.st_size == obj.size and abs(st.st_mtime - obj.mtime) < 1:
                    continue  # unchanged since the last look
            except OSError:
                pass
            path.parent.mkdir(parents=True, exist_ok=True)
            if obj.size > MAX_FILE_BYTES or path.suffix.lower() not in SUPPORTED:
                _placeholder(path, obj.size, obj.mtime)
                continue
            part = path.with_name(path.name + ".part")  # walk() skips .part files while they download
            b.download(obj.key, part)
            os.replace(part, path)
            os.utime(path, (obj.mtime, obj.mtime))
    for rel, _, _ in walk(root):
        if rel not in seen:
            (root / rel).unlink(missing_ok=True)


def _web_manifest(root: Path) -> dict[str, str]:
    try:
        return json.loads((root / WEB_MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


async def sync_web(src: Source, root: Path) -> list[str]:
    """Fetches each page into root, rewriting a file only when its page changed. A page that can't
    be fetched this time keeps its file (a site being down isn't a deletion); an address taken off
    the list loses its file, which the ledger then treats like a deleted file. Returns the errors."""
    before = _web_manifest(root)
    now_names: dict[str, str] = {}
    errors = []
    pages: list[str] = []
    for url in src.urls or []:
        if not web.is_listing(url):
            pages.append(url)
            continue
        try:  # a sitemap or feed stands for the pages it lists
            pages += await web.listed_pages(url, MAX_WEB_PAGES)
        except web.WebError as e:
            errors.append(str(e))
            pages += [u for u in before if u not in pages]  # keep what it listed last time
    for url in list(dict.fromkeys(pages))[:MAX_WEB_PAGES]:
        try:
            name, data, _ = await web.fetch(url, MAX_FILE_BYTES)
        except web.WebError as e:
            errors.append(str(e))
            if url in before:
                now_names[url] = before[url]
            continue
        name = _safe_name(name)
        taken = set(now_names.values())
        stem, suffix, n = Path(name).stem, Path(name).suffix, 2
        while name in taken:  # two pages with the same title
            name, n = f"{stem} ({n}){suffix}", n + 1
        now_names[url] = name
        path = root / name
        if path.exists() and path.read_bytes() == data:
            continue  # unchanged: the ledger sees the same size and time
        part = path.with_name(path.name + ".part")
        await asyncio.to_thread(part.write_bytes, data)
        os.replace(part, path)
        settled = time.time() - OLD_FILE_SECONDS  # written in one go: nothing to wait for
        os.utime(path, (settled, settled))
    keep = set(now_names.values())
    for rel, _, _ in walk(root):
        if rel not in keep:
            (root / rel).unlink(missing_ok=True)
    (root / WEB_MANIFEST).write_text(json.dumps(now_names, indent=1), encoding="utf-8")
    return errors


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

    url = next((u for u, n in _web_manifest(root).items() if n == f.relpath), None) if src.kind == "web" else None
    added, skipped = await store_documents(s, src.project_id, [(name, data)], source_url=url)
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
    from .chat import writer_model
    from .datasets import learn_into_chat_dataset

    if not doc_ids:
        return {}
    project = s.get(Project, src.project_id)
    job = submit_ingest(s, project, doc_ids)
    out = {"ingest_job_id": job.id}
    if src.mode == "learn":
        try:
            model = await writer_model(s, project)
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
                fetch_errors: list[str] = []
                if src.kind == "bucket":
                    await asyncio.to_thread(sync_bucket, src, root)
                elif src.kind == "web":
                    fetch_errors = await sync_web(src, root)
                listing = await asyncio.to_thread(walk, root)
            except S3Error as e:
                src.last_scan_at, src.last_error = utcnow(), f"can't read the bucket: {e}"
                s.add(src)
                s.commit()
                return {"error": src.last_error}
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
                    if src.kind in MIRRORED and now - mtime >= OLD_FILE_SECONDS:
                        ready.append(f)  # LLMCoach wrote it in one go: no need to look again
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
            if fetch_errors:
                more = f" (and {len(fetch_errors) - 1} more)" if len(fetch_errors) > 1 else ""
                warning = f"{fetch_errors[0]}{more}. Pages that couldn't be fetched keep their last version."
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
    if src.kind == "bucket":
        path = f"{src.endpoint}/{src.bucket}/{src.prefix or ''}"
    elif src.kind == "web":
        n = len(src.urls or [])
        path = f"{n} web page{'s' if n != 1 else ''}"
    else:
        path = str(settings.inbox_root / src.folder) if src.folder != "." else str(settings.inbox_root)
    return {**src.model_dump(mode="json", exclude={"secret_key"}), "has_secret": bool(src.secret_key),
            "counts": _counts(s, src.id), "path": path}


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
    kind: str = "folder"  # "folder" | "bucket" | "web"
    folder: str = ""
    urls: list[str] | None = None  # web sources
    endpoint: str | None = None
    bucket: str | None = None
    prefix: str | None = None
    region: str | None = None
    access_key: str | None = None
    secret_key: str | None = None
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
    # A bucket's connection; the bucket and prefix themselves can't change (watch a new one instead).
    endpoint: str | None = None
    region: str | None = None
    access_key: str | None = None
    secret_key: str | None = None
    urls: list[str] | None = None  # web sources: the page list, replaced whole


_BUCKET_NAME = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")


def _check_bucket(src: Source) -> None:
    """Refuses a bucket source that can't be listed, with the store's own reason."""
    try:
        with _open_bucket(src) as b:
            b.list(src.prefix or "", limit=1)
    except S3Error as e:
        raise HTTPException(400, f"couldn't list the bucket: {e}") from e


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
    if body.kind == "bucket":
        return _create_bucket_source(session, project_id, body)
    if body.kind == "web":
        src = Source(project_id=project_id, kind="web", folder="", urls=_check_urls(body.urls),
                     name=(body.name or "Web pages").strip()[:80], mode=body.mode, scan=body.scan,
                     poll_seconds=body.poll_seconds, mirror_deletes=body.mirror_deletes)
        session.add(src)
        session.commit()
        session.refresh(src)
        return _out(session, src)
    if body.kind != "folder":
        raise HTTPException(400, "kind must be folder, bucket or web")
    folder = normalize_folder(body.folder)
    for other in session.exec(select(Source).where(Source.kind == "folder")):
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


def _check_urls(urls: list[str] | None) -> list[str]:
    cleaned = list(dict.fromkeys(u.strip() for u in urls or [] if u.strip()))
    if not cleaned:
        raise HTTPException(400, "give at least one web address")
    if len(cleaned) > MAX_WEB_PAGES:
        raise HTTPException(400, f"at most {MAX_WEB_PAGES} pages per source")
    for u in cleaned:
        try:
            web.check_url(u)
        except web.WebError as e:
            raise HTTPException(400, f"{u}: {e}") from e
    return cleaned


def _create_bucket_source(session: Session, project_id: int, body: SourceCreate) -> dict:
    try:
        endpoint = normalize_endpoint(body.endpoint or "")
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    bucket = (body.bucket or "").strip()
    if not _BUCKET_NAME.match(bucket):
        raise HTTPException(400, "bucket names are 3 to 63 lowercase letters, digits, dots and hyphens")
    prefix = (body.prefix or "").strip().lstrip("/")
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    if ".." in PurePosixPath(prefix).parts:
        raise HTTPException(400, "the prefix can't contain '..'")
    for other in session.exec(select(Source).where(Source.kind == "bucket", Source.endpoint == endpoint,
                                                   Source.bucket == bucket)):
        a, b = prefix, other.prefix or ""
        if a.startswith(b) or b.startswith(a):
            raise HTTPException(409, f"'{bucket}/{prefix}' overlaps '{bucket}/{b}', which '{other.name}' already watches")
    if not body.access_key or not body.secret_key:
        raise HTTPException(400, "an access key and a secret key are needed; a read-only pair is enough")
    src = Source(project_id=project_id, kind="bucket", folder="", endpoint=endpoint, bucket=bucket, prefix=prefix,
                 region=(body.region or "").strip() or "us-east-1", access_key=body.access_key.strip(),
                 secret_key=body.secret_key.strip(), name=(body.name or f"{bucket}/{prefix}".rstrip("/")).strip()[:80],
                 mode=body.mode, scan=body.scan, poll_seconds=body.poll_seconds, mirror_deletes=body.mirror_deletes)
    _check_bucket(src)
    session.add(src)
    session.commit()
    session.refresh(src)
    return _out(session, src)


@router.patch("/api/projects/{project_id}/sources/{source_id}")
def update_source(project_id: int, source_id: int, body: SourceUpdate, session: Session = Depends(get_session)) -> dict:
    src = _get_source(session, project_id, source_id)
    _validate(body.mode, body.scan, body.poll_seconds)
    patch = body.model_dump(exclude_none=True)
    if "urls" in patch:
        if src.kind != "web":
            raise HTTPException(400, "only a web source has a page list")
        patch["urls"] = _check_urls(patch["urls"])
    connection = {k: patch.pop(k) for k in ("endpoint", "region", "access_key", "secret_key") if k in patch}
    if connection and src.kind != "bucket":
        raise HTTPException(400, "only a bucket source has a connection to change")
    for key, value in connection.items():
        try:
            value = normalize_endpoint(value) if key == "endpoint" else value.strip()
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        setattr(src, key, value)
    if connection:
        _check_bucket(src)
    for key, value in patch.items():
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
    if src.kind in MIRRORED:
        shutil.rmtree(source_root(src), ignore_errors=True)  # only the mirror; the bucket or site is untouched
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
    if src.kind in MIRRORED:
        raise HTTPException(400, f"this source reads {'a bucket; put files in the bucket' if src.kind == 'bucket' else 'web pages; add the address to its list'} instead")
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
        if src.kind in MIRRORED:
            shutil.rmtree(source_root(src), ignore_errors=True)
        session.delete(src)
    session.flush()
