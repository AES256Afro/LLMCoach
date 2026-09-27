"""LoRA / QLoRA supervised fine-tuning.

Config: finetune_id, plus the plan from services/training.plan() (base_model, backend, method,
device, epochs, learning_rate, lora_*, micro_batch, grad_accum, max_seq_len, total_steps, seed).

Backends:
  unsloth  NVIDIA GPU: faster, less memory (FastLanguageModel + TRL's SFTTrainer)
  hf       anywhere, including CPU: transformers + PEFT + TRL

Every logged step becomes a metric event (loss, eval_loss, learning rate) for the live charts.
The adapter is saved to data/finetunes/<id>/adapter.
"""
import inspect
import json
import math
import os
import time
from pathlib import Path

from sqlmodel import Session

from ..config import settings
from ..db import FineTune, FineTuneStatus, engine, utcnow
from ..services import datasets as ds
from .common import JobContext, parse_context


def _update(ft_id: int, **fields) -> None:
    with Session(engine) as s:
        ft = s.get(FineTune, ft_id)
        if ft is None:
            return
        for k, v in fields.items():
            setattr(ft, k, v)
        s.add(ft)
        s.commit()


def _load_rows(ft: FineTune) -> tuple[list[dict], list[dict]]:
    rows = ds.read_rows(ds.dataset_path(ft.project_id, ft.dataset_id))
    train = [{"messages": r["messages"]} for r in rows if r.get("split", "train") == "train"]
    val = [{"messages": r["messages"]} for r in rows if r.get("split") == "val"]
    return train, val


def _sft_config(cfg: dict, out_dir: Path, has_eval: bool, bf16: bool):
    from trl import SFTConfig

    params = inspect.signature(SFTConfig).parameters
    eval_every = max(1, cfg["total_steps"] // 10)
    kw = dict(
        output_dir=str(out_dir / "checkpoints"),
        num_train_epochs=float(cfg["epochs"]),
        max_steps=int(cfg["max_steps"]) if cfg.get("max_steps") else -1,
        per_device_train_batch_size=int(cfg["micro_batch"]),
        per_device_eval_batch_size=int(cfg["micro_batch"]),
        gradient_accumulation_steps=int(cfg["grad_accum"]),
        learning_rate=float(cfg["learning_rate"]),
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        logging_steps=1,
        save_strategy="no",
        report_to=[],
        seed=int(cfg.get("seed", 42)),
        bf16=bf16,
        gradient_checkpointing=cfg["device"] == "cuda",
        dataloader_num_workers=0,
        disable_tqdm=True,  # carriage-return bars garble a log file; Metrics prints clean lines
    )
    kw["eval_strategy" if "eval_strategy" in params else "evaluation_strategy"] = "steps" if has_eval else "no"
    if has_eval:
        kw["eval_steps"] = eval_every
    # TRL renamed max_seq_length -> max_length.
    kw["max_length" if "max_length" in params else "max_seq_length"] = int(cfg["max_seq_len"])
    if cfg["device"] != "cuda":
        kw["use_cpu" if "use_cpu" in params else "no_cuda"] = True
    return SFTConfig(**{k: v for k, v in kw.items() if k in params})


def _metrics_callback(ctx: JobContext, total_steps: int):
    from transformers import TrainerCallback

    class Metrics(TrainerCallback):
        def __init__(self) -> None:
            self.started = time.perf_counter()

        def on_log(self, args, state, control, logs=None, **kw):
            logs = logs or {}
            m = {"step": state.global_step, "epoch": round(state.epoch or 0, 3)}
            for src, dst in (("loss", "loss"), ("eval_loss", "eval_loss"), ("learning_rate", "lr"),
                             ("grad_norm", "grad_norm")):
                v = logs.get(src)
                if isinstance(v, (int, float)) and math.isfinite(v):
                    m[dst] = round(float(v), 6)
            if len(m) > 2:
                ctx.metric(**m)
                parts = [f"{k}={m[k]:.4g}" for k in ("loss", "eval_loss", "lr", "grad_norm") if k in m]
                total = max(total_steps, state.max_steps or 0)
                print(f"step {state.global_step:>4}/{total}  epoch {m['epoch']:.2f}  " + "  ".join(parts), flush=True)
            elapsed = time.perf_counter() - self.started
            ctx.progress(state.global_step, max(total_steps, state.max_steps or 0),
                         f"epoch {m['epoch']:.2f} · {elapsed / max(state.global_step, 1):.1f}s/step")

    return Metrics()


def _load_hf(cfg: dict, token: str | None):
    import torch
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer

    kw: dict = {"token": token}
    if cfg["device"] == "cuda":
        kw["dtype"] = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        if cfg["method"] == "qlora":
            from transformers import BitsAndBytesConfig
            kw["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                bnb_4bit_compute_dtype=kw["dtype"])
    else:
        kw["dtype"] = torch.float32
    tokenizer = AutoTokenizer.from_pretrained(cfg["base_model"], token=token)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(cfg["base_model"], **kw)
    peft_config = LoraConfig(r=int(cfg["lora_r"]), lora_alpha=int(cfg["lora_alpha"]),
                             lora_dropout=float(cfg["lora_dropout"]), target_modules="all-linear",
                             task_type="CAUSAL_LM")
    return model, tokenizer, peft_config


def _load_unsloth(cfg: dict, token: str | None):
    from unsloth import FastLanguageModel

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=cfg["base_model"], max_seq_length=int(cfg["max_seq_len"]),
        load_in_4bit=cfg["method"] == "qlora", token=token)
    model = FastLanguageModel.get_peft_model(
        model, r=int(cfg["lora_r"]), lora_alpha=int(cfg["lora_alpha"]), lora_dropout=float(cfg["lora_dropout"]),
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth", random_state=int(cfg.get("seed", 42)))
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    return model, tokenizer, None


def main() -> None:
    ctx = parse_context()
    cfg = ctx.config
    ft_id = int(cfg["finetune_id"])
    with Session(engine) as s:
        ft = s.get(FineTune, ft_id)
        if ft is None:
            raise SystemExit(f"fine-tune {ft_id} not found")
        s.expunge(ft)

    out_dir = settings.data_dir / "finetunes" / str(ft_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    token = settings.hf_token or os.environ.get("HF_TOKEN") or None
    backend = cfg["backend"]
    _update(ft_id, status=FineTuneStatus.training, backend=backend, error=None,
            output_dir=str((out_dir / "adapter").relative_to(settings.data_dir)))

    train_rows, val_rows = _load_rows(ft)
    if not train_rows:
        raise SystemExit("the dataset has no training examples")
    val_rows = val_rows[:200]  # keep evaluation quick
    print(f"[train] {ft.name}: {cfg['base_model']} · {cfg['method'].upper()} via {backend} on {cfg['device']}", flush=True)
    print(f"[train] {len(train_rows)} train / {len(val_rows)} eval examples · "
          f"{cfg['epochs']} epoch(s) · ~{cfg['total_steps']} steps · lr {cfg['learning_rate']} · "
          f"r={cfg['lora_r']} alpha={cfg['lora_alpha']} · batch {cfg['micro_batch']}x{cfg['grad_accum']} · "
          f"max {cfg['max_seq_len']} tokens", flush=True)
    ctx.emit("plan", **{k: cfg[k] for k in ("base_model", "backend", "method", "device", "total_steps")})

    started = time.perf_counter()
    ctx.progress(0, cfg["total_steps"], "loading base model (first use downloads it)")
    import torch
    from datasets import Dataset
    from trl import SFTTrainer

    torch.manual_seed(int(cfg.get("seed", 42)))
    model, tokenizer, peft_config = (_load_unsloth if backend == "unsloth" else _load_hf)(cfg, token)
    bf16 = cfg["device"] == "cuda" and torch.cuda.is_bf16_supported()
    print(f"[train] model loaded in {time.perf_counter() - started:.0f}s", flush=True)

    trainer_kw = dict(
        model=model,
        args=_sft_config(cfg, out_dir, bool(val_rows), bf16),
        train_dataset=Dataset.from_list(train_rows),
        eval_dataset=Dataset.from_list(val_rows) if val_rows else None,
        callbacks=[_metrics_callback(ctx, cfg["total_steps"])],
    )
    if peft_config is not None:
        trainer_kw["peft_config"] = peft_config
    params = inspect.signature(SFTTrainer.__init__).parameters
    trainer_kw["processing_class" if "processing_class" in params else "tokenizer"] = tokenizer
    trainer = SFTTrainer(**trainer_kw)
    from transformers.trainer_callback import PrinterCallback
    trainer.remove_callback(PrinterCallback)  # prints raw dicts; Metrics already logs each step

    trainable = sum(p.numel() for p in trainer.model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in trainer.model.parameters())
    print(f"[train] trainable parameters: {trainable:,} of {total:,} ({100 * trainable / total:.2f}%)", flush=True)

    result = trainer.train()
    eval_loss = None
    if val_rows:
        eval_loss = trainer.evaluate().get("eval_loss")
        ctx.metric(step=trainer.state.global_step, eval_loss=round(float(eval_loss), 6))

    trainer.model.save_pretrained(str(out_dir / "adapter"))
    tokenizer.save_pretrained(str(out_dir / "adapter"))
    took = time.perf_counter() - started
    metrics = {
        "train_loss": round(float(result.training_loss), 4),
        "eval_loss": round(float(eval_loss), 4) if eval_loss is not None else None,
        "steps": trainer.state.global_step,
        "seconds": round(took),
        "trainable_params": trainable,
        "train_examples": len(train_rows),
    }
    (out_dir / "summary.json").write_text(json.dumps({"config": cfg, "metrics": metrics}, indent=2))
    _update(ft_id, status=FineTuneStatus.ready, metrics=metrics, finished_at=utcnow())
    ctx.progress(trainer.state.global_step, trainer.state.global_step, "done")
    summary = f"done in {took / 60:.1f} min · train loss {metrics['train_loss']}"
    if metrics["eval_loss"] is not None:
        summary += f" · eval loss {metrics['eval_loss']}"
    print(f"\x1b[32m[train] {summary}\x1b[0m", flush=True)
    print(f"[train] adapter saved to {out_dir / 'adapter'}", flush=True)


if __name__ == "__main__":
    main()
