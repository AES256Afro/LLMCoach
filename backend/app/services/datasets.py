"""Training datasets: import, validation, normalization, splitting and statistics.

Everything is normalized to chat format, the shape trainers (TRL, Unsloth) consume:
    {"messages": [{"role": "system"?, ...}, {"role": "user", ...}, {"role": "assistant", ...}],
     "split": "train" | "val" | "test", "meta": {...}}
"""
from __future__ import annotations

import csv
import io
import json
import random
from pathlib import Path

from ..config import settings

ROLES = {"system", "user", "assistant"}
MAX_ERRORS_REPORTED = 50


class DatasetError(ValueError):
    pass


def dataset_path(project_id: int, dataset_id: int) -> Path:
    return settings.data_dir / "datasets" / str(int(project_id)) / f"{int(dataset_id)}.jsonl"


def _pick(row: dict, *names: str) -> str | None:
    for n in names:
        for key in (n, n.capitalize(), n.upper()):
            v = row.get(key)
            if isinstance(v, str) and v.strip():
                return v
    return None


def normalize(row: dict) -> dict:
    """One record in any supported shape -> {"messages": [...]}. Raises ValueError with a reason."""
    if not isinstance(row, dict):
        raise ValueError("row is not an object")
    if "messages" in row or "conversations" in row:
        raw = row.get("messages", row.get("conversations"))
        if not isinstance(raw, list) or not raw:
            raise ValueError("'messages' must be a non-empty list")
        messages = []
        for i, m in enumerate(raw):
            if not isinstance(m, dict):
                raise ValueError(f"message {i} is not an object")
            # ShareGPT style ({"from": "human", "value": ...}) as well as OpenAI style.
            role = m.get("role") or {"human": "user", "gpt": "assistant", "system": "system"}.get(m.get("from", ""))
            content = m.get("content", m.get("value"))
            if role not in ROLES:
                raise ValueError(f"message {i} has unknown role {role!r}")
            if not isinstance(content, str) or not content.strip():
                raise ValueError(f"message {i} has no text")
            messages.append({"role": role, "content": content})
    else:
        system = _pick(row, "system")
        instruction = _pick(row, "instruction", "prompt", "question", "input", "query")
        extra = _pick(row, "input") if _pick(row, "instruction") else None
        output = _pick(row, "output", "completion", "answer", "response", "chosen")
        if not instruction or not output:
            raise ValueError("needs messages, or a prompt field (instruction/prompt/question/input) and an answer "
                             "field (output/completion/answer/response)")
        user = f"{instruction}\n\n{extra}" if extra and extra != instruction else instruction
        messages = ([{"role": "system", "content": system}] if system else []) + [
            {"role": "user", "content": user}, {"role": "assistant", "content": output}]
    if messages[-1]["role"] != "assistant":
        raise ValueError("the last message must be the assistant's reply (that's what the model learns)")
    if not any(m["role"] == "user" for m in messages):
        raise ValueError("there is no user message")
    out = {"messages": messages}
    if isinstance(row.get("meta"), dict):
        out["meta"] = row["meta"]
    return out


def read_records(filename: str, data: bytes) -> list[tuple[int, object]]:
    """(line/row number, raw record) pairs. JSONL, a JSON array, or CSV with a header row."""
    text = data.decode("utf-8-sig", errors="replace")
    ext = Path(filename).suffix.lower()
    if ext == ".csv":
        return [(i + 2, dict(r)) for i, r in enumerate(csv.DictReader(io.StringIO(text)))]
    stripped = text.lstrip()
    if ext == ".json" or stripped.startswith("["):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as e:
            raise DatasetError(f"invalid JSON: {e}") from e
        if isinstance(parsed, dict):
            parsed = parsed.get("data") or parsed.get("rows") or [parsed]
        if not isinstance(parsed, list):
            raise DatasetError("a JSON dataset must be an array of records")
        return list(enumerate(parsed, 1))
    out: list[tuple[int, object]] = []
    for n, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            out.append((n, json.loads(line)))
        except json.JSONDecodeError as e:
            out.append((n, ValueError(f"invalid JSON: {e.msg}")))
    return out


def validate(records: list[tuple[int, object]]) -> tuple[list[dict], list[dict], int]:
    """-> (normalized rows, first errors, total error count). Bad rows are skipped, not fatal."""
    rows, errors, n_err = [], [], 0
    for n, rec in records:
        try:
            if isinstance(rec, Exception):
                raise rec
            rows.append(normalize(rec))  # type: ignore[arg-type]
        except ValueError as e:
            n_err += 1
            if len(errors) < MAX_ERRORS_REPORTED:
                errors.append({"line": n, "error": str(e)})
    return rows, errors, n_err


def assign_splits(rows: list[dict], val: float = 0.1, test: float = 0.1, seed: int = 42) -> dict[str, int]:
    """Seeded shuffle into train/val/test. Tiny datasets still get at least one eval example
    when there are 10+ rows, so there's always something to measure against."""
    if not (0 <= val < 1 and 0 <= test < 1 and val + test < 1):
        raise DatasetError("val and test fractions must be between 0 and 1, and add up to less than 1")
    order = list(range(len(rows)))
    random.Random(seed).shuffle(order)
    n = len(rows)
    n_test = round(n * test)
    n_val = round(n * val)
    if n >= 10:
        n_test = max(n_test, 1 if test > 0 else 0)
        n_val = max(n_val, 1 if val > 0 else 0)
    for rank, idx in enumerate(order):
        rows[idx]["split"] = "test" if rank < n_test else "val" if rank < n_test + n_val else "train"
    counts = {"train": 0, "val": 0, "test": 0}
    for r in rows:
        counts[r["split"]] += 1
    return counts


def estimate_tokens(text: str) -> int:
    # ~4 characters per token for English with modern tokenizers; good enough for planning.
    return max(1, round(len(text) / 4))


def compute_stats(rows: list[dict]) -> dict:
    if not rows:
        return {}
    totals = [sum(estimate_tokens(m["content"]) for m in r["messages"]) for r in rows]
    answers = [estimate_tokens(r["messages"][-1]["content"]) for r in rows]
    turns = [sum(1 for m in r["messages"] if m["role"] == "user") for r in rows]
    edges = [0, 64, 128, 256, 512, 1024, 2048, 4096]
    hist = [0] * len(edges)
    for t in totals:
        hist[max(i for i, e in enumerate(edges) if t >= e)] += 1
    s = sorted(totals)
    return {
        "tokens_total": sum(totals),
        "tokens_mean": round(sum(totals) / len(totals)),
        "tokens_p95": s[min(len(s) - 1, int(len(s) * 0.95))],
        "tokens_max": s[-1],
        "answer_tokens_mean": round(sum(answers) / len(answers)),
        "multi_turn": sum(1 for t in turns if t > 1),
        "with_system": sum(1 for r in rows if r["messages"][0]["role"] == "system"),
        "length_histogram": [{"from": e, "count": c} for e, c in zip(edges, hist)],
    }


def write_rows(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    tmp.replace(path)


def read_rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]
