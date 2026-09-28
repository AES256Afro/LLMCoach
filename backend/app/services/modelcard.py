"""A model card for a fine-tune, written from what LLMCoach recorded: where it came from, how it was
trained, and how it scored. Markdown, so it can sit next to the adapter as its README."""
from __future__ import annotations

from sqlmodel import Session, select

from ..db import Dataset, EvalRun, FineTune, LoopRun, Project


def _pct(x: float | None) -> str:
    return "—" if x is None else f"{x * 100:.0f}%"


def model_card(s: Session, ft: FineTune) -> str:
    project = s.get(Project, ft.project_id)
    ds = s.get(Dataset, ft.dataset_id) if ft.dataset_id else None
    c, m = ft.config or {}, ft.metrics or {}
    lines = [f"# {ft.name}", ""]
    status = []
    if ft.promoted_at:
        status.append(f"**the adapter in use** for “{project.name}” since {ft.promoted_at:%Y-%m-%d}")
    if ft.ollama_model:
        status.append(f"exported to Ollama as `{ft.ollama_model}`")
    lines.append(f"A LoRA adapter for **{ft.base_model}**, trained with LLMCoach for the project “{project.name}”"
                 + (f": {'; '.join(status)}." if status else "."))
    lines += ["", "## Training data", ""]
    if ds:
        sp = ds.splits or {}
        lines.append(f"“{ds.name}” ({ds.source}): {ds.row_count} examples, {sp.get('train', 0)} for training, "
                     f"{sp.get('val', 0)} for validation, {sp.get('test', 0)} held out for testing.")
        if m.get("train_examples"):
            lines.append(f"Training used {m['train_examples']} of them.")
    else:
        lines.append("The dataset it was trained on has since been deleted.")
    lines += ["", "## Settings", "", "| | |", "|---|---|"]
    rows = [("Method", {"lora": "LoRA", "qlora": "QLoRA"}.get(ft.method or "lora", ft.method)), ("Trainer", {"hf": "TRL + PEFT", "unsloth": "Unsloth"}.get(ft.backend or "", ft.backend or "—")),
            ("Preset", c.get("preset")), ("Epochs", c.get("epochs")), ("Learning rate", c.get("learning_rate")),
            ("LoRA rank / alpha", f"{c.get('lora_r')} / {c.get('lora_alpha')}" if c.get("lora_r") else None),
            ("Max sequence length", c.get("max_seq_len")), ("Effective batch", c.get("effective_batch")),
            ("Steps", m.get("steps") or c.get("total_steps")), ("Device", c.get("device")),
            ("Trainable parameters", f"{m['trainable_params']:,}" if m.get("trainable_params") else None),
            ("Time", f"{m['seconds'] / 60:.1f} min" if m.get("seconds") else None)]
    lines += [f"| {k} | {v} |" for k, v in rows if v not in (None, "")]
    lines += ["", "## Results", ""]
    if m.get("train_loss") is not None or m.get("eval_loss") is not None:
        lines.append(f"Final training loss {m.get('train_loss', '—')}, validation loss {m.get('eval_loss', '—')}.")
    scored = []
    for e in s.exec(select(EvalRun).where(EvalRun.project_id == ft.project_id, EvalRun.status == "done").order_by(EvalRun.id)):
        mine = [v for v in (e.variants or []) if v.get("kind") == "finetune" and str(v.get("ref")) == str(ft.id)]
        if not mine or not e.summary:
            continue
        scored.append(e)
        lines += ["", f"**{e.name}**: {e.examples} {e.split} questions.", "",
                  "| Variant | F1 | Exact | Judge |", "|---|---|---|---|"]
        for v in e.variants or []:
            r = e.summary.get(v["label"]) or {}
            name = f"**{v['label']}**" if v in mine else v["label"]
            judge = f"{r['judge']:.1f} / 5" if r.get("judge") is not None else "—"
            lines.append(f"| {name} | {_pct(r.get('f1'))} | {_pct(r.get('exact_match'))} | {judge} |")
    if not scored:
        lines.append("It hasn't been evaluated yet.")
    runs = list(s.exec(select(LoopRun).where(LoopRun.finetune_id == ft.id)))
    for r in runs:
        lines += ["", f"The learning loop trained it (run #{r.id}): {r.reason or r.status}"]
    lines += ["", "## Using it", "",
              "Fine-tuning teaches format and behaviour; facts should come from the project's knowledge base, "
              "so ask it with the knowledge base on. "
              + (f"In any LLMCoach chat, pick `{ft.ollama_model}`." if ft.ollama_model else
                 "Export it to Ollama from LLMCoach to chat with it anywhere."),
              "", f"*Written by LLMCoach from its records on {ft.finished_at or ft.created_at:%Y-%m-%d}.*", ""]
    return "\n".join(lines)
