"""Evaluate variants on a dataset split.

Config: eval_id, max_examples (30), max_new_tokens (256).
Variants come from the EvalRun row. Each answers every question; answers are scored against
the reference (exact match, F1, ROUGE-L) and, optionally, by a judge model (1-5).
"""
import json
import time
from pathlib import Path

from sqlmodel import Session, select

from ..config import settings
from ..db import Dataset, Document, EvalRun, FineTune, Project, engine
from ..services import datasets as ds
from ..services import kb, metrics, rag
from ..services.providers import resolve
from .common import parse_context

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {"score": {"type": "integer", "minimum": 1, "maximum": 5}, "reason": {"type": "string"}},
    "required": ["score", "reason"],
}

JUDGE_PROMPT = """You are grading an AI assistant's answer against a reference answer.

Question:
{question}

Reference answer:
{reference}

Assistant's answer:
{answer}

Score the assistant's answer from 1 to 5:
5 = fully correct and complete, consistent with the reference
4 = correct with minor omissions
3 = partly correct, or correct but with notable gaps or extra unsupported claims
2 = mostly wrong or unhelpful
1 = wrong, contradicts the reference, or doesn't answer

Reply with JSON: {{"score": <1-5>, "reason": "<one sentence>"}}"""


def results_path(eval_id: int) -> Path:
    return settings.data_dir / "evals" / f"{int(eval_id)}.jsonl"


def _update(eval_id: int, **fields) -> None:
    with Session(engine) as s:
        e = s.get(EvalRun, eval_id)
        if e is None:
            return
        for k, v in fields.items():
            setattr(e, k, v)
        s.add(e)
        s.commit()


def _examples(dataset: Dataset, split: str, limit: int) -> list[dict]:
    rows = ds.read_rows(ds.dataset_path(dataset.project_id, dataset.id))
    chosen = [r for r in rows if r.get("split") == split] or [r for r in rows if r.get("split") == "val"]
    out = []
    for i, r in enumerate(chosen[:limit]):
        msgs = r["messages"]
        system = msgs[0]["content"] if msgs[0]["role"] == "system" else None
        convo = [m for m in msgs[:-1] if m["role"] != "system"]
        out.append({"index": i, "system": system, "history": convo[:-1], "question": convo[-1]["content"],
                    "reference": msgs[-1]["content"]})
    return out


class Retriever:
    """Knowledge-base lookups for RAG variants, run synchronously inside the worker."""

    def __init__(self, project: Project) -> None:
        cfg = project.effective_settings()
        self.project_id = project.id
        self.k = int(cfg["top_k"])
        self.hybrid = cfg.get("search_mode", "hybrid") == "hybrid"
        self.client, self.model, _ = resolve(cfg["embed_model"])
        with Session(engine) as s:
            self.names = {d.id: d.filename for d in s.exec(select(Document).where(Document.project_id == project.id))}

    def __call__(self, question: str) -> list[dict]:
        vec = self.client.sync_embed(self.model, [question], kind="query")[0]
        hits, _ = kb.search(self.project_id, vec, self.k, text=question if self.hybrid else None)
        for h in hits:
            h["filename"] = self.names.get(h["doc_id"], "document")
        return hits


def main() -> None:
    ctx = parse_context()
    eval_id = int(ctx.config["eval_id"])
    max_new = int(ctx.config.get("max_new_tokens", 256))
    with Session(engine) as s:
        run = s.get(EvalRun, eval_id)
        dataset = s.get(Dataset, run.dataset_id)
        project = s.get(Project, run.project_id)
        variants = list(run.variants or [])
        judge_ref = run.judge_model
        split = run.split
        finetunes = {f.id: f for f in s.exec(select(FineTune).where(FineTune.project_id == run.project_id))}
        for f in finetunes.values():
            s.expunge(f)
        s.expunge(project)
        s.expunge(dataset)

    examples = _examples(dataset, split, int(ctx.config.get("max_examples", 30)))
    if not examples:
        raise SystemExit(f"the dataset has no {split} (or val) examples to evaluate on")
    _update(eval_id, status="running", examples=len(examples))
    print(f"[eval] {len(examples)} questions from '{dataset.name}' ({split}) × {len(variants)} variants", flush=True)
    retriever = Retriever(project) if any(v.get("rag") for v in variants) and kb.count(project.id) else None
    judge = resolve(judge_ref) if judge_ref else None

    results = [{"index": e["index"], "question": e["question"], "reference": e["reference"], "outputs": {}} for e in examples]
    total = len(examples) * len(variants)
    done = 0
    for v in variants:
        label = v["label"]
        print(f"\n[eval] variant: {label}", flush=True)
        local = None
        if v["kind"] == "finetune":
            from ..services.local_infer import load_finetune
            ft = finetunes.get(int(v["ref"]))
            if ft is None:
                raise SystemExit(f"fine-tune {v['ref']} not found")
            print(f"[eval] loading {ft.base_model} + adapter '{ft.name}'", flush=True)
            local = load_finetune(ft)
        else:
            client, model, _ = resolve(v["ref"])

        for e, res in zip(examples, results):
            ctx.progress(done, total, f"{label}: question {e['index'] + 1}/{len(examples)}")
            hits = retriever(e["question"]) if (v.get("rag") and retriever) else None
            messages = rag.build_messages(e["question"], e["history"], hits, e["system"])
            started = time.perf_counter()
            try:
                if local is not None:
                    reply = local.generate(messages, max_new)
                else:
                    reply = client.sync_chat(model, messages, options={"temperature": 0, "num_predict": max_new, "think": False})
                answer, err = reply["content"].strip(), None
            except Exception as ex:
                answer, err = "", str(ex)[:300]
            out = {"answer": answer, "latency_ms": round((time.perf_counter() - started) * 1000), "error": err,
                   "sources": [h["filename"] for h in hits] if hits else None, **metrics.score(answer, e["reference"])}
            if judge and answer:
                jc, jm, _ = judge
                try:
                    verdict = json.loads(jc.sync_chat(jm, [{"role": "user", "content": JUDGE_PROMPT.format(
                        question=e["question"], reference=e["reference"], answer=answer)}],
                        options={"temperature": 0, "think": False}, json_schema=JUDGE_SCHEMA)["content"])
                    out["judge"] = max(1, min(5, int(verdict["score"])))
                    out["judge_reason"] = str(verdict.get("reason", ""))[:300]
                except Exception as ex:
                    out["judge_error"] = str(ex)[:200]
            res["outputs"][label] = out
            done += 1
            ctx.metric(step=done, variant=label, f1=out["f1"], rouge_l=out["rouge_l"], judge=out.get("judge"))
            line = f"  Q{e['index'] + 1}: f1={out['f1']:.2f} rougeL={out['rouge_l']:.2f}"
            if "judge" in out:
                line += f" judge={out['judge']}"
            line += f" {out['latency_ms'] / 1000:.1f}s"
            if err:
                line += f"  ERROR {err}"
            print(line, flush=True)
        if local is not None:
            del local

        path = results_path(eval_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            for r in results:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        _update(eval_id, summary=summarize(results, variants))

    summary = summarize(results, variants)
    _update(eval_id, status="done", summary=summary)
    ctx.progress(total, total, "done")
    print("\n[eval] summary", flush=True)
    for label, m in summary.items():
        line = f"  {label:<40} f1={m['f1']:.3f}  rougeL={m['rouge_l']:.3f}  em={m['exact_match']:.2f}"
        if m.get("judge") is not None:
            line += f"  judge={m['judge']:.2f}"
        print(f"{line}  {m['latency_ms'] / 1000:.1f}s/answer", flush=True)


def summarize(results: list[dict], variants: list[dict]) -> dict:
    out = {}
    for v in variants:
        outs = [r["outputs"][v["label"]] for r in results if v["label"] in r["outputs"]]
        if not outs:
            continue
        mean = lambda k: round(sum(o[k] for o in outs) / len(outs), 4)  # noqa: E731
        judged = [o["judge"] for o in outs if "judge" in o]
        out[v["label"]] = {
            "n": len(outs), "exact_match": mean("exact_match"), "f1": mean("f1"), "rouge_l": mean("rouge_l"),
            "judge": round(sum(judged) / len(judged), 3) if judged else None,
            "latency_ms": round(sum(o["latency_ms"] for o in outs) / len(outs)),
            "errors": sum(1 for o in outs if o.get("error")),
        }
    return out


if __name__ == "__main__":
    main()
