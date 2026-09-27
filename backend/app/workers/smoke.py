"""Hardware smoke test as a job, so it can be run and watched from the UI.

Config: lora (bool, default False), model (str), require_gpu (bool).
"""
import runpy
import sys
from pathlib import Path

from ..services.device import torch_device_info
from .common import parse_context

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "smoke_gpu.py"


def main() -> None:
    ctx = parse_context()
    info = torch_device_info()
    ctx.emit("device", **info)
    print(f"device info: {info}", flush=True)

    argv = [str(SCRIPT)]
    if ctx.config.get("lora"):
        argv.append("--lora")
    if ctx.config.get("require_gpu"):
        argv.append("--require-gpu")
    if model := ctx.config.get("model"):
        argv += ["--model", model]
    sys.argv = argv
    runpy.run_path(str(SCRIPT), run_name="__main__")


if __name__ == "__main__":
    main()
