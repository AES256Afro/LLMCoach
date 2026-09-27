"""Knowledge-base vector store: one LanceDB table per project, in data/lancedb/.

Rows: id, doc_id, chunk_index, page, text, vector. The vector width is fixed per table,
so changing a project's embedding model means dropping the table and re-indexing.
"""
from __future__ import annotations

import math

import lancedb
import pyarrow as pa
from lancedb.index import FTS
from lancedb.rerankers import RRFReranker

from ..config import settings


class KBError(RuntimeError):
    pass


def _db():
    return lancedb.connect(str(settings.data_dir / "lancedb"))


def table_name(project_id: int) -> str:
    return f"kb_{int(project_id)}"


def _tables(db) -> list[str]:
    r = db.list_tables() if hasattr(db, "list_tables") else db.table_names()
    return list(getattr(r, "tables", r))


def _open(project_id: int):
    db = _db()
    name = table_name(project_id)
    return db.open_table(name) if name in _tables(db) else None


def dimension(project_id: int) -> int | None:
    t = _open(project_id)
    return t.schema.field("vector").type.list_size if t is not None else None


def add_chunks(project_id: int, rows: list[dict]) -> None:
    if not rows:
        return
    dim = len(rows[0]["vector"])
    db = _db()
    name = table_name(project_id)
    if name in _tables(db):
        t = db.open_table(name)
        have = t.schema.field("vector").type.list_size
        if have != dim:
            raise KBError(f"this knowledge base holds {have}-dimension vectors but the embedding model produced {dim}. "
                          "Re-index all documents after changing the embedding model.")
        t.add(rows)
    else:
        schema = pa.schema([
            pa.field("id", pa.string()),
            pa.field("doc_id", pa.int64()),
            pa.field("chunk_index", pa.int32()),
            pa.field("page", pa.int32()),
            pa.field("text", pa.string()),
            pa.field("vector", pa.list_(pa.float32(), dim)),
        ])
        db.create_table(name, data=rows, schema=schema)


def ensure_text_index(project_id: int) -> None:
    """(Re)builds the full-text index used by hybrid search. Rows added since the last build are
    still found (LanceDB scans them), so this only needs to run after each ingest."""
    if (t := _open(project_id)) is not None and t.count_rows():
        t.create_index("text", config=FTS(), replace=True)


def _has_text_index(t) -> bool:
    try:
        return any(getattr(i, "name", "") == "text_idx" or "text" in getattr(i, "columns", []) for i in t.list_indices())
    except Exception:
        return False


def _cosine(a: list[float], b) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(float(y) * float(y) for y in b))
    return dot / (na * nb) if na and nb else 0.0


def delete_doc(project_id: int, doc_id: int) -> None:
    if (t := _open(project_id)) is not None:
        t.delete(f"doc_id = {int(doc_id)}")


def drop(project_id: int) -> None:
    db = _db()
    if table_name(project_id) in _tables(db):
        db.drop_table(table_name(project_id))


def count(project_id: int) -> int:
    t = _open(project_id)
    return t.count_rows() if t is not None else 0


def list_chunks(project_id: int, doc_id: int, offset: int = 0, limit: int = 50) -> tuple[list[dict], int]:
    t = _open(project_id)
    if t is None:
        return [], 0
    rows = (t.search().where(f"doc_id = {int(doc_id)}").select(["id", "chunk_index", "page", "text"])
            .limit(1_000_000).to_list())
    rows.sort(key=lambda r: r["chunk_index"])
    return [{k: r[k] for k in ("id", "chunk_index", "page", "text")} for r in rows[offset:offset + limit]], len(rows)


def search(project_id: int, vector: list[float], k: int = 5, doc_ids: list[int] | None = None,
           text: str | None = None) -> tuple[list[dict], str]:
    """Returns (hits, mode). With `text` and a full-text index, the ranking fuses keyword and
    vector matches (reciprocal-rank fusion); otherwise it is vector-only. `score` is always the
    cosine similarity to the query, so it means the same thing in both modes."""
    t = _open(project_id)
    if t is None:
        return [], "vector"
    have = t.schema.field("vector").type.list_size
    if have != len(vector):
        raise KBError(f"the query embedding has {len(vector)} dimensions but the index has {have}. "
                      "The embedding model changed; re-index the documents.")
    where = f"doc_id IN ({', '.join(str(int(d)) for d in doc_ids)})" if doc_ids else None
    if text and _has_text_index(t):
        q = t.search(query_type="hybrid").vector(vector).text(text)
        if where:
            q = q.where(where, prefilter=True)
        rows = q.rerank(RRFReranker()).limit(k).to_list()
        return [
            {"id": r["id"], "doc_id": r["doc_id"], "chunk_index": r["chunk_index"], "page": r["page"],
             "text": r["text"], "score": round(_cosine(vector, r["vector"]), 4)}
            for r in rows
        ], "hybrid"
    q = t.search(vector).metric("cosine").select(["id", "doc_id", "chunk_index", "page", "text"]).limit(k)
    if where:
        q = q.where(where, prefilter=True)
    return [
        {"id": r["id"], "doc_id": r["doc_id"], "chunk_index": r["chunk_index"], "page": r["page"],
         "text": r["text"], "score": round(1 - r["_distance"], 4)}
        for r in q.to_list()
    ], "vector"
