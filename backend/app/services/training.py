"""Training plans: base models, presets, backend choice and memory estimates.

Kept free of torch imports so the API can plan and validate a run cheaply; the heavy
lifting happens in workers/train.py.
"""
from __future__ import annotations

import importlib.util
import re

import psutil

from .device import detect_backend, system_stats

# Open-weight models that fine-tune well at small sizes. "gated" ones need a Hugging Face token
# and accepting the model's license on huggingface.co first.
BASE_MODELS = [
    {"id": "HuggingFaceTB/SmolLM2-360M-Instruct", "params_b": 0.36, "license": "Apache-2.0", "gated": False,
     "note": "Tiny and fast. The practical choice for training on a CPU."},
    {"id": "Qwen/Qwen2.5-0.5B-Instruct", "params_b": 0.49, "license": "Apache-2.0", "gated": False,
     "note": "Small, capable, multilingual. Trains on a CPU in minutes for small datasets."},
    {"id": "Qwen/Qwen3-0.6B", "params_b": 0.6, "license": "Apache-2.0", "gated": False,
     "note": "Newest small Qwen, with optional reasoning."},
    {"id": "Qwen/Qwen3-1.7B", "params_b": 1.7, "license": "Apache-2.0", "gated": False,
     "note": "A big step up in quality. Wants a GPU."},
    {"id": "Qwen/Qwen3-4B", "params_b": 4.0, "license": "Apache-2.0", "gated": False,
     "note": "Strong for its size. GPU with 12 GB+ (LoRA) or 8 GB+ (QLoRA)."},
    {"id": "microsoft/Phi-4-mini-instruct", "params_b": 3.8, "license": "MIT", "gated": False,
     "note": "Good at reasoning and instruction following. GPU needed."},
    {"id": "meta-llama/Llama-3.2-1B-Instruct", "params_b": 1.2, "license": "Llama 3.2", "gated": True,
     "note": "Needs a Hugging Face token and license acceptance."},
    {"id": "meta-llama/Llama-3.2-3B-Instruct", "params_b": 3.2, "license": "Llama 3.2", "gated": True,
     "note": "Needs a Hugging Face token and license acceptance."},
]

PRESETS = {
    "quick": {"label": "Quick", "epochs": 1, "learning_rate": 2e-4, "lora_r": 8, "lora_alpha": 16,
              "lora_dropout": 0.05, "effective_batch": 8, "max_seq_len": 1024,
              "note": "One pass. Checks the pipeline and gives a first result fast."},
    "balanced": {"label": "Balanced", "epochs": 2, "learning_rate": 2e-4, "lora_r": 16, "lora_alpha": 32,
                 "lora_dropout": 0.05, "effective_batch": 16, "max_seq_len": 2048,
                 "note": "Sensible default for a few hundred to a few thousand examples."},
    "thorough": {"label": "Thorough", "epochs": 3, "learning_rate": 1e-4, "lora_r": 32, "lora_alpha": 64,
                 "lora_dropout": 0.05, "effective_batch": 16, "max_seq_len": 2048,
                 "note": "More capacity and passes. Watch eval loss for overfitting."},
}

TUNABLE = {"epochs", "learning_rate", "lora_r", "lora_alpha", "lora_dropout", "effective_batch", "max_seq_len",
           "max_steps", "micro_batch", "seed"}

# CPU training is only realistic for tiny models.
CPU_MAX_PARAMS_B = 1.0


def params_for(model_id: str) -> float | None:
    for m in BASE_MODELS:
        if m["id"] == model_id:
            return m["params_b"]
    hit = re.search(r"(\d+(?:\.\d+)?)\s*([bm])\b", model_id.lower().replace("-", " ").replace("_", " "))
    if hit:
        n = float(hit.group(1))
        return n / 1000 if hit.group(2) == "m" else n
    return None


def hardware() -> dict:
    st = system_stats()
    gpu = st.gpus[0] if st.gpus else None
    unsloth = importlib.util.find_spec("unsloth") is not None
    return {
        "backend": detect_backend(),
        "gpu": gpu.name if gpu else None,
        "vram_gb": round(gpu.vram_total_gb, 1) if gpu and gpu.vram_total_gb else None,
        "ram_gb": round(psutil.virtual_memory().total / 1024**3, 1),
        "cpu_threads": psutil.cpu_count(),
        "unsloth_installed": unsloth,
        "recommended_backend": "unsloth" if detect_backend() == "cuda" and unsloth else "hf",
    }


def recommended_base_model(hw: dict) -> str:
    """A sensible default for one-click training (the chat studio's /train): the largest open
    model that trains comfortably on this machine."""
    if hw.get("backend") == "cuda":
        return "Qwen/Qwen3-4B" if (hw.get("vram_gb") or 0) >= 15 else "Qwen/Qwen3-1.7B"
    return "Qwen/Qwen2.5-0.5B-Instruct"


def estimate(params_b: float | None, method: str, max_seq_len: int, micro_batch: int, device: str) -> dict:
    """Rough peak memory for LoRA training. Deliberately conservative: better to warn early."""
    if params_b is None:
        return {"gb": None, "where": "GPU" if device == "cuda" else "RAM", "note": "unknown model size"}
    if device != "cuda":
        # fp32 weights + LoRA optimizer state + activations; CPU runs use no gradient checkpointing.
        gb = params_b * 4 * 1.3 + 0.004 * max_seq_len * micro_batch * params_b ** 0.5 + 1.0
        return {"gb": round(gb, 1), "where": "RAM", "note": "fp32 on CPU"}
    weights = params_b * (0.55 if method == "qlora" else 2.0)
    activations = 0.0006 * max_seq_len * micro_batch * params_b ** 0.5  # with gradient checkpointing
    gb = weights + activations + 1.5  # CUDA context, LoRA params + optimizer, fragmentation
    return {"gb": round(gb, 1), "where": "VRAM", "note": "bf16" if method == "lora" else "4-bit base (QLoRA)"}


class PlanError(ValueError):
    pass


# setting -> (whole number?, lowest, highest, bounds inclusive?) for user overrides.
_LIMITS: dict[str, tuple[bool, float, float | None, bool]] = {
    "epochs": (False, 0, 100, False),
    "learning_rate": (False, 0, 1, False),
    "lora_dropout": (False, 0, 0.9, True),
    "lora_r": (True, 1, 1024, True),
    "lora_alpha": (True, 1, 4096, True),
    "effective_batch": (True, 1, 4096, True),
    "micro_batch": (True, 1, 1024, True),
    "max_seq_len": (True, 64, 32768, True),
    "max_steps": (True, 1, None, True),
    "seed": (True, 0, None, True),
}


def _checked(overrides: dict) -> dict:
    """Type- and range-checks overrides (None = use the preset), so a bad value fails here with a
    clear message instead of deep inside the training worker."""
    out = {}
    for k, v in overrides.items():
        if v is None:
            continue
        whole, lo, hi, inclusive = _LIMITS[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
            raise PlanError(f"{k} must be a number, not {v!r}")
        if whole:
            if v != int(v):
                raise PlanError(f"{k} must be a whole number, not {v!r}")
            v = int(v)
        if v < lo or (hi is not None and v > hi) or (not inclusive and v in (lo, hi)):
            rng = (f"at least {lo:g}" if inclusive else f"more than {lo:g}") + (
                "" if hi is None else f" and at most {hi:g}" if inclusive else f" and less than {hi:g}")
            raise PlanError(f"{k} must be {rng}, not {v!r}")
        out[k] = v
    return out


def plan(base_model: str, preset: str, overrides: dict, method: str, backend: str, rows_train: int) -> dict:
    """Validates a request against the hardware and returns the full training config."""
    if preset not in PRESETS:
        raise PlanError(f"unknown preset {preset!r}")
    unknown = set(overrides) - TUNABLE
    if unknown:
        raise PlanError(f"unknown settings: {sorted(unknown)}")
    overrides = _checked(overrides)
    hw = hardware()
    device = "cuda" if hw["backend"] == "cuda" else "cpu"
    if method not in ("lora", "qlora"):
        raise PlanError("method must be lora or qlora")
    if method == "qlora" and device != "cuda":
        raise PlanError("QLoRA needs an NVIDIA GPU (4-bit kernels); use LoRA on this machine")
    if backend == "auto":
        backend = hw["recommended_backend"]
    if backend == "unsloth" and not (device == "cuda" and hw["unsloth_installed"]):
        raise PlanError("Unsloth needs an NVIDIA GPU and the unsloth package (the GPU image includes it)")
    if backend not in ("hf", "unsloth"):
        raise PlanError("backend must be auto, hf or unsloth")

    cfg = {k: v for k, v in PRESETS[preset].items() if k not in ("label", "note")}
    cfg.update({k: v for k, v in overrides.items() if v is not None})
    params_b = params_for(base_model)
    if device == "cpu":
        if params_b is not None and params_b > CPU_MAX_PARAMS_B:
            raise PlanError(f"{base_model} (~{params_b}B parameters) is too large to train on a CPU; "
                            f"pick a model under {CPU_MAX_PARAMS_B:g}B or add a GPU")
        cfg["max_seq_len"] = min(int(cfg["max_seq_len"]), 512)
        cfg.setdefault("micro_batch", 1)
    else:
        cfg.setdefault("micro_batch", 4 if (params_b or 8) <= 2 else 2)
    micro = int(cfg["micro_batch"])
    cfg["grad_accum"] = max(1, int(cfg["effective_batch"]) // micro)
    steps_per_epoch = max(1, -(-rows_train // (micro * cfg["grad_accum"])))
    cfg["total_steps"] = int(cfg.get("max_steps") or steps_per_epoch * float(cfg["epochs"]))
    mem = estimate(params_b, method, int(cfg["max_seq_len"]), micro, device)
    budget = hw["vram_gb"] if device == "cuda" else hw["ram_gb"] * 0.8
    fits = mem["gb"] is None or budget is None or mem["gb"] <= budget
    if not fits:
        raise PlanError(f"estimated {mem['gb']} GB {mem['where']} but this machine has {budget:.0f} GB; "
                        "use QLoRA, a shorter max sequence length, or a smaller model")
    return {**cfg, "device": device, "backend": backend, "method": method, "params_b": params_b,
            "memory": {**mem, "budget_gb": round(budget, 1) if budget else None, "fits": fits}}
