"""Hardware detection and live system stats.

Works with no GPU, an NVIDIA GPU (nvidia-smi), or an AMD GPU (rocm-smi).
Never imports torch at module level: the API process should stay light and
start even where torch isn't installed.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from functools import lru_cache

import psutil


@dataclass
class GpuStats:
    index: int
    name: str
    util_pct: float | None = None
    vram_used_gb: float | None = None
    vram_total_gb: float | None = None
    temp_c: float | None = None
    power_w: float | None = None


@dataclass
class SystemStats:
    backend: str  # "cpu" | "cuda" | "rocm"
    cpu_pct: float
    ram_used_gb: float
    ram_total_gb: float
    gpus: list[GpuStats] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _run(cmd: list[str]) -> str | None:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=5, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None


def _float(v) -> float | None:
    try:
        return float(str(v).strip().split()[0])
    except (ValueError, IndexError):
        return None


def _nvidia_stats() -> list[GpuStats]:
    out = _run([
        "nvidia-smi",
        "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
        "--format=csv,noheader,nounits",
    ])
    gpus = []
    for line in (out or "").strip().splitlines():
        p = [x.strip() for x in line.split(",")]
        if len(p) < 7:
            continue
        gpus.append(GpuStats(
            index=int(p[0]), name=p[1], util_pct=_float(p[2]),
            vram_used_gb=(_float(p[3]) or 0) / 1024, vram_total_gb=(_float(p[4]) or 0) / 1024,
            temp_c=_float(p[5]), power_w=_float(p[6]),
        ))
    return gpus


def _rocm_stats() -> list[GpuStats]:
    out = _run(["rocm-smi", "--showuse", "--showmeminfo", "vram", "--showtemp",
                "--showpower", "--showproductname", "--json"])
    if not out:
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []
    gpus = []
    for i, (key, card) in enumerate(sorted(data.items())):
        if not key.startswith("card") or not isinstance(card, dict):
            continue

        # rocm-smi key names vary by version, so match by substring.
        def pick(*needles: str):
            for k, v in card.items():
                kl = k.lower()
                if all(n in kl for n in needles):
                    return v
            return None

        used = _float(pick("vram", "used"))
        total = _float(pick("vram", "total", "memory"))
        gpus.append(GpuStats(
            index=i,
            name=str(pick("card series") or pick("product name") or key),
            util_pct=_float(pick("gpu use")),
            vram_used_gb=used / 1024**3 if used else None,
            vram_total_gb=total / 1024**3 if total else None,
            temp_c=_float(pick("temperature", "edge") or pick("temperature")),
            power_w=_float(pick("power")),
        ))
    return gpus


@lru_cache(maxsize=1)
def detect_backend() -> str:
    """Best guess at the compute backend without importing torch."""
    if shutil.which("nvidia-smi") and _nvidia_stats():
        return "cuda"
    if shutil.which("rocm-smi") and _rocm_stats():
        return "rocm"
    return "cpu"


def system_stats() -> SystemStats:
    backend = detect_backend()
    vm = psutil.virtual_memory()
    gpus = _nvidia_stats() if backend == "cuda" else _rocm_stats() if backend == "rocm" else []
    return SystemStats(
        backend=backend,
        cpu_pct=psutil.cpu_percent(interval=None),
        ram_used_gb=(vm.total - vm.available) / 1024**3,
        ram_total_gb=vm.total / 1024**3,
        gpus=gpus,
    )


def torch_device_info() -> dict:
    """Torch-level view. Only called from workers, where torch is installed."""
    try:
        import torch
    except ImportError:
        return {"torch": None, "device": "cpu", "bf16": False}
    info = {"torch": torch.__version__, "hip": getattr(torch.version, "hip", None)}
    if torch.cuda.is_available():
        info.update(device="cuda", name=torch.cuda.get_device_name(0),
                    vram_gb=torch.cuda.get_device_properties(0).total_memory / 1024**3,
                    bf16=torch.cuda.is_bf16_supported())
    else:
        info.update(device="cpu", bf16=False)
    return info
