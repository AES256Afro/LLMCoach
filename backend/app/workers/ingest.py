"""Ingest documents into a project's knowledge base: parse -> chunk -> embed -> LanceDB.

Config: project_id, doc_ids (list), reset (bool: drop the index first, used when the
embedding model changes). One bad file never stops the others; the job fails only if
every document failed.
"""
import time
from pathlib import Path

from sqlmodel import Session

from ..config import settings
from ..db import Document, DocStatus, Project, engine, utcnow
from ..services import kb
from ..services.chunking import chunk_sections
from ..services.parsing import parse
from ..services.providers import resolve
from .common import parse_context

BATCH = 32


def _update(doc_id: int, **fields) -> None:
    with Session(engine) as s:
        doc = s.get(Document, doc_id)
        if doc is None:
            return
        for k, v in fields.items():
            setattr(doc, k, v)
        s.add(doc)
        s.commit()


def main() -> None:
    ctx = parse_context()
    pid = int(ctx.config["project_id"])
    with Session(engine) as s:
        project = s.get(Project, pid)
        if project is None:
            raise SystemExit(f"project {pid} not found")
        cfg = project.effective_settings()
        docs = [s.get(Document, int(d)) for d in ctx.config.get("doc_ids", [])]
        docs = [(d.id, d.filename, d.path) for d in docs if d is not None and d.project_id == pid]

    client, model, provider = resolve(cfg["embed_model"])
    size, overlap = int(cfg["chunk_size"]), int(cfg["chunk_overlap"])
    print(f"[ingest] {len(docs)} document(s) into project '{project.name}'", flush=True)
    print(f"[ingest] embeddings: {provider.name} / {model}   chunks: {size} chars, {overlap} overlap", flush=True)

    if ctx.config.get("reset"):
        print("[ingest] embedding model changed: clearing the index", flush=True)
        kb.drop(pid)

    ok = failed = total_chunks = 0
    for i, (doc_id, filename, rel_path) in enumerate(docs):
        ctx.progress(i, len(docs), filename)
        _update(doc_id, status=DocStatus.ingesting, error=None)
        started = time.perf_counter()
        try:
            sections = parse(settings.data_dir / Path(rel_path))
            chunks = chunk_sections(sections, size, overlap)
            chars = sum(len(t) for t, _ in sections)
            print(f"[{filename}] {len(sections)} section(s), {chars:,} chars -> {len(chunks)} chunks", flush=True)

            vectors: list[list[float]] = []
            for b in range(0, len(chunks), BATCH):
                batch = chunks[b:b + BATCH]
                vectors += client.sync_embed(model, [c.text for c in batch], kind="document")
                ctx.progress(i, len(docs), f"{filename}: embedded {len(vectors)}/{len(chunks)} chunks")

            kb.delete_doc(pid, doc_id)
            kb.add_chunks(pid, [
                {"id": f"{doc_id}-{c.index}", "doc_id": doc_id, "chunk_index": c.index, "page": c.page,
                 "text": c.text, "vector": v}
                for c, v in zip(chunks, vectors)
            ])
            _update(doc_id, status=DocStatus.ready, chunk_count=len(chunks), char_count=chars,
                    embed_model=cfg["embed_model"], ingested_at=utcnow())
            took = time.perf_counter() - started
            ctx.metric(step=i + 1, doc_id=doc_id, chunks=len(chunks), seconds=round(took, 2))
            print(f"\x1b[32m[{filename}] ready\x1b[0m in {took:.1f}s", flush=True)
            ok += 1
            total_chunks += len(chunks)
        except Exception as e:
            failed += 1
            _update(doc_id, status=DocStatus.failed, error=str(e)[:1000])
            print(f"\x1b[31m[{filename}] failed: {e}\x1b[0m", flush=True)

    if ok:
        print("[ingest] updating the keyword index", flush=True)
        kb.ensure_text_index(pid)
    ctx.progress(len(docs), len(docs), "done")
    print(f"[ingest] finished: {ok} ready, {failed} failed, {total_chunks} chunks added", flush=True)
    if docs and ok == 0:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
