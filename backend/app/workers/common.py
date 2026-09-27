"""Shared plumbing for job worker processes.

A worker is launched as `python -m app.workers.<kind> --job-dir <dir>`. Plain
print() output lands in log.txt; structured events go to metrics.jsonl through
JobContext.emit(), which the UI streams as live charts and status.
"""
from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path
from typing import Any


class JobContext:
    def __init__(self, job_dir: Path) -> None:
        self.dir = job_dir
        self.config: dict[str, Any] = json.loads((job_dir / "config.json").read_text())
        self._metrics = open(job_dir / "metrics.jsonl", "a", buffering=1)

    def emit(self, type_: str, **data: Any) -> None:
        """Write a structured event, e.g. emit("metric", step=10, loss=1.23)."""
        self._metrics.write(json.dumps({"type": type_, "ts": time.time(), **data}) + "\n")

    def metric(self, **data: Any) -> None:
        self.emit("metric", **data)

    def progress(self, current: int, total: int, message: str = "") -> None:
        self.emit("progress", current=current, total=total, message=message)


def parse_context() -> JobContext:
    p = argparse.ArgumentParser()
    p.add_argument("--job-dir", type=Path, required=True)
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # One line per HTTP request drowns the job's own progress lines.
    for noisy in ("httpx", "httpcore", "urllib3", "filelock"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    return JobContext(args.job_dir)
