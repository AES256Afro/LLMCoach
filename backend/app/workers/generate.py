"""Generate a Q&A dataset from a project's knowledge base with any chat model.

Config: project_id, dataset_id, model, pairs_per_chunk (3), max_chunks (40), doc_ids (optional),
        style ("closed" = question -> answer, "grounded" = passage + question -> answer),
        val (0.1), test (0.1), seed (42), system_prompt (optional, put on every example).

Passages are sampled evenly across the documents. Each one gets a structured-output request,
so replies parse reliably even from small models; bad replies are logged and skipped.
"""
import json
import random
import time

from sqlmodel import Session, select

from ..db import Dataset, DatasetStatus, Document, engine
from ..services import datasets as ds
from ..services import kb
from ..services.providers import resolve
from .common import parse_context

SCHEMA = {
    "type": "object",
    "properties": {
        "pairs": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"question": {"type": "string"}, "answer": {"type": "string"}},
                "required": ["question", "answer"],
            },
        }
    },
    "required": ["pairs"],
}

PROMPT = """Write {n} question-and-answer pairs that someone might realistically ask about the passage below.

Rules:
- Every answer must be fully supported by the passage. Don't add outside facts.
- Questions must make sense on their own, without seeing the passage (no "according to the passage").
- Vary the questions: facts, how-to, why, and comparisons where the passage allows.
- Answers should be complete sentences, concise, and in a helpful assistant's voice.
- Skip trivia about formatting, images, links or file names.

Source: {source}

Passage:
\"\"\"
{text}
\"\"\"

Reply with JSON: {{"pairs": [{{"question": "...", "answer": "..."}}]}}"""


def _sample_chunks(project_id: int, doc_ids: list[int], max_chunks: int, seed: int) -> list[dict]:
    """Round-robin across documents so one long document doesn't crowd out the rest."""
    per_doc = []
    for d in doc_ids:
        rows, _ = kb.list_chunks(project_id, d, 0, 100_000)
        rows = [r for r in rows if len(r["text"]) >= 200]  # too short to ask good questions about
        random.Random(seed + d).shuffle(rows)
        per_doc.append([{**r, "doc_id": d} for r in rows])
    out: list[dict] = []
    while len(out) < max_chunks and any(per_doc):
        for rows in per_doc:
            if rows and len(out) < max_chunks:
                out.append(rows.pop())
    return out


# Pairs that talk about "the passage" teach the fine-tuned model to do the same.
_LEAKS = ("the passage", "the text", "the context", "the document", "according to the", "this passage",
          "the provided", "the given text", "the excerpt")


def _leaks_source(q: str, a: str) -> bool:
    text = f"{q} {a}".lower()
    return any(p in text for p in _LEAKS)


def _parse(content: str) -> list[dict]:
    text = content.strip()
    if text.startswith("```"):
        text = text.strip("`").split("\n", 1)[-1]
    start, end = text.find("{"), text.rfind("}")
    data = json.loads(text[start:end + 1] if start >= 0 else text)
    pairs = data.get("pairs", data if isinstance(data, list) else [])
    return [p for p in pairs if isinstance(p, dict) and str(p.get("question", "")).strip() and str(p.get("answer", "")).strip()]


def main() -> None:
    ctx = parse_context()
    c = ctx.config
    pid, dsid = int(c["project_id"]), int(c["dataset_id"])
    n_pairs = int(c.get("pairs_per_chunk", 3))
    style = c.get("style", "closed")
    seed = int(c.get("seed", 42))
    system_prompt = (c.get("system_prompt") or "").strip() or None

    with Session(engine) as s:
        docs = {d.id: d.filename for d in s.exec(select(Document).where(Document.project_id == pid))}
    doc_ids = [d for d in (c.get("doc_ids") or list(docs)) if d in docs]
    chunks = _sample_chunks(pid, doc_ids, int(c.get("max_chunks", 40)), seed)
    if not chunks:
        _finish(dsid, [], error="the knowledge base has no passages long enough to generate from")
        raise SystemExit("no passages to generate from: add documents to the knowledge base first")

    client, model, provider = resolve(c["model"])
    # Append mode (the chat's "Learn from this"): keep the dataset's existing rows and their splits,
    # so an earlier test question never drifts into training between runs.
    base_rows = ds.read_rows(ds.dataset_path(pid, dsid)) if c.get("append") else []
    for r in base_rows:
        r.setdefault("split", "train")
    if base_rows:
        print(f"[generate] appending to {len(base_rows)} existing examples", flush=True)
    print(f"[generate] {len(chunks)} passages from {len(doc_ids)} document(s), {n_pairs} pairs each", flush=True)
    print(f"[generate] model: {provider.name} / {model}   style: {style}", flush=True)

    rows: list[dict] = []
    seen: set[str] = set()
    started = time.perf_counter()
    for i, chunk in enumerate(chunks):
        source = docs[chunk["doc_id"]] + (f", page {chunk['page']}" if chunk.get("page") else "")
        ctx.progress(i, len(chunks), f"passage {i + 1}/{len(chunks)} · {len(rows)} pairs so far")
        prompt = PROMPT.format(n=n_pairs, source=source, text=chunk["text"])
        t0 = time.perf_counter()
        try:
            reply = client.sync_chat(model, [{"role": "user", "content": prompt}],
                                     options={"temperature": 0.7, "think": False}, json_schema=SCHEMA)
            pairs = _parse(reply["content"])
        except Exception as e:
            print(f"\x1b[33m[passage {i + 1}] skipped: {e}\x1b[0m", flush=True)
            continue
        added = 0
        for p in pairs[:n_pairs]:
            q, a = str(p["question"]).strip(), str(p["answer"]).strip()
            key = q.lower()
            if key in seen:
                continue
            if _leaks_source(q, a):
                print(f"  dropped (refers to its source): {q[:80]}", flush=True)
                continue
            seen.add(key)
            user = q if style == "closed" else f"Context:\n{chunk['text']}\n\nQuestion: {q}"
            messages = ([{"role": "system", "content": system_prompt}] if system_prompt else []) + [
                {"role": "user", "content": user}, {"role": "assistant", "content": a}]
            rows.append({"messages": messages, "meta": {"doc_id": chunk["doc_id"], "chunk_id": chunk["id"],
                                                        "source": source, "generated_by": c["model"]}})
            added += 1
        took = time.perf_counter() - t0
        ctx.metric(step=i + 1, pairs=len(rows), seconds=round(took, 1))
        example = pairs[0]["question"] if pairs else "(none)"
        print(f"[passage {i + 1}/{len(chunks)}] +{added} pairs in {took:.1f}s  e.g. {example[:90]}", flush=True)
        _checkpoint(dsid, pid, base_rows + rows)

    ctx.progress(len(chunks), len(chunks), "done")
    elapsed = time.perf_counter() - started
    print(f"[generate] {len(rows)} pairs from {len(chunks)} passages in {elapsed / 60:.1f} min", flush=True)
    _finish(dsid, base_rows + rows, val=float(c.get("val", 0.1)), test=float(c.get("test", 0.1)), seed=seed,
            error=None if rows else "the model produced no usable pairs")
    if not rows:
        raise SystemExit(1)


def _checkpoint(dsid: int, pid: int, rows: list[dict]) -> None:
    """Write progress so far, so a stopped job still leaves what it made. New rows are written
    without a split; one is assigned when the job finishes (or by the salvage hook)."""
    ds.write_rows(ds.dataset_path(pid, dsid), rows)
    with Session(engine) as s:
        d = s.get(Dataset, dsid)
        if d is not None:
            d.row_count = len(rows)
            s.add(d)
            s.commit()


def _finish(dsid: int, rows: list[dict], val: float = 0.1, test: float = 0.1, seed: int = 42,
            error: str | None = None) -> None:
    with Session(engine) as s:
        d = s.get(Dataset, dsid)
        if d is None:
            return
        splits = ds.assign_new_splits(rows, val, test, seed)
        ds.write_rows(ds.dataset_path(d.project_id, dsid), rows)
        d.path = str(ds.dataset_path(d.project_id, dsid).relative_to(ds.settings.data_dir))
        d.row_count, d.splits, d.stats = len(rows), splits, ds.compute_stats(rows)
        d.status = DatasetStatus.ready if rows else DatasetStatus.failed
        d.error = error
        s.add(d)
        s.commit()


if __name__ == "__main__":
    main()
