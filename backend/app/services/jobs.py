"""Single-GPU job queue.

Every job runs as its own Python subprocess (`python -m app.workers.<kind>`), so an
OOM or segfault in training can never take the API down. A job's files live in
data/runs/<job_id>/:
    config.json    - input written by the queue
    log.txt        - combined stdout/stderr of the worker
    metrics.jsonl  - structured events written by the worker (see workers/common.py)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path

from sqlmodel import Session, select

from ..config import settings
from ..db import Job, JobStatus, engine, utcnow

log = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parents[2]

# Whitelist of runnable job kinds -> worker module.
WORKERS: dict[str, str] = {
    "demo": "app.workers.demo",
    "smoke": "app.workers.smoke",
    "ingest": "app.workers.ingest",
    "generate": "app.workers.generate",
    "train": "app.workers.train",
    "evaluate": "app.workers.evaluate",
}

# Called with the finished Job (any final status, including orphaned-at-startup) so a
# kind can tidy state its worker didn't get to, e.g. documents left mid-ingest.
FINISH_HOOKS: dict[str, Callable[[Job], None]] = {}


def job_dir(job_id: int) -> Path:
    return settings.runs_dir / str(job_id)


class JobManager:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[int] = asyncio.Queue()
        self._procs: dict[int, subprocess.Popen] = {}
        self._cancelled: set[int] = set()
        self._task: asyncio.Task | None = None
        # cancel() runs in a request thread while _run() runs on the event loop; this makes
        # "queued -> running", "start the process" and "cancel" atomic with respect to each other.
        # Only short DB writes happen under it.
        self._lock = threading.Lock()

    # ---- lifecycle -------------------------------------------------------
    async def start(self) -> None:
        with Session(engine) as s:
            # Anything "running" at startup was orphaned by a previous crash/restart.
            orphans = list(s.exec(select(Job).where(Job.status == JobStatus.running)))
            for job in orphans:
                job.status, job.error, job.finished_at = JobStatus.failed, "orphaned by server restart", utcnow()
                s.add(job)
            s.commit()
            for job in orphans:
                _run_hook(job)
            for job in s.exec(select(Job).where(Job.status == JobStatus.queued).order_by(Job.id)):
                self._queue.put_nowait(job.id)
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        for proc in self._procs.values():
            proc.terminate()
        if self._task:
            self._task.cancel()

    # ---- public API ------------------------------------------------------
    def submit(self, session: Session, kind: str, config: dict, project_id: int | None = None) -> Job:
        if kind not in WORKERS:
            raise ValueError(f"unknown job kind {kind!r}; expected one of {sorted(WORKERS)}")
        job = Job(kind=kind, config=config, project_id=project_id)
        session.add(job)
        session.commit()
        session.refresh(job)
        log.info("job #%s (%s) queued", job.id, kind)
        d = job_dir(job.id)
        d.mkdir(parents=True, exist_ok=True)
        (d / "config.json").write_text(json.dumps(config, indent=2))
        self._queue.put_nowait(job.id)
        return job

    def cancel(self, session: Session, job: Job) -> None:
        finished = None
        with self._lock:
            session.refresh(job)  # the runner may have started it since the caller loaded it
            if job.status.is_final:
                return
            if job.status == JobStatus.queued:
                # Final before the lock is released, so the runner can no longer start it.
                finished = self._set_final(job.id, JobStatus.cancelled)
            else:
                # If the process isn't registered yet, the runner checks this flag right after starting it.
                self._cancelled.add(job.id)
                if proc := self._procs.get(job.id):
                    proc.terminate()
        if finished is not None:
            log.info("job #%s cancelled before it started", job.id)
            _run_hook(finished)
        session.refresh(job)

    @property
    def running_job_id(self) -> int | None:
        return next(iter(self._procs), None)

    # ---- internals -------------------------------------------------------
    async def _run_loop(self) -> None:
        while True:
            job_id = await self._queue.get()
            try:
                await self._run(job_id)
            except Exception as e:  # never let the loop die
                log.exception("job %s crashed the runner", job_id)
                self._finish(job_id, JobStatus.failed, error=f"runner error: {e}")

    async def _run(self, job_id: int) -> None:
        with self._lock, Session(engine) as s:
            job = s.get(Job, job_id)
            if job is None or job.status != JobStatus.queued:
                return
            job.status, job.started_at = JobStatus.running, utcnow()
            s.add(job)
            s.commit()
            kind, config = job.kind, job.config

        d = job_dir(job_id)
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONPATH": str(BACKEND_DIR),
               # Friendlier download logs than tqdm's carriage-return bars.
               "HF_HUB_DISABLE_PROGRESS_BARS": "1", "TOKENIZERS_PARALLELISM": "false"}
        if (gpu := config.get("gpu")) is not None:
            env["CUDA_VISIBLE_DEVICES"] = str(gpu)

        log.info("job #%s (%s) started", job_id, kind)
        with open(d / "log.txt", "ab") as logf:
            proc = subprocess.Popen(
                [sys.executable, "-m", WORKERS[kind], "--job-dir", str(d)],
                cwd=BACKEND_DIR, env=env, stdout=logf, stderr=subprocess.STDOUT,
            )
            with self._lock:
                self._procs[job_id] = proc
                if job_id in self._cancelled:  # cancelled between "running" and now
                    proc.terminate()
            try:
                code = await asyncio.to_thread(proc.wait)
            finally:
                with self._lock:
                    self._procs.pop(job_id, None)

        if job_id in self._cancelled:
            self._finish(job_id, JobStatus.cancelled, exit_code=code)
        elif code == 0:
            self._finish(job_id, JobStatus.done, exit_code=code)
        else:
            self._finish(job_id, JobStatus.failed, exit_code=code, error=_tail(d / "log.txt"))

    def _finish(self, job_id: int, status: JobStatus, exit_code: int | None = None, error: str | None = None) -> None:
        with self._lock:
            job = self._set_final(job_id, status, exit_code, error)
        if job is None:
            return
        (log.warning if job.status == JobStatus.failed else log.info)(
            "job #%s %s (exit=%s)", job_id, job.status.value, exit_code)
        _run_hook(job)

    def _set_final(self, job_id: int, status: JobStatus, exit_code: int | None = None,
                   error: str | None = None) -> Job | None:
        """Records a final status (call with the lock held). A job already cancelled stays cancelled."""
        self._cancelled.discard(job_id)
        with Session(engine) as s:
            job = s.get(Job, job_id)
            if job is None:
                return None
            if job.status == JobStatus.cancelled:
                status, error = JobStatus.cancelled, job.error
            job.status, job.exit_code, job.error = status, exit_code, error
            job.finished_at = job.finished_at or utcnow()
            s.add(job)
            s.commit()
            s.refresh(job)
            s.expunge(job)
            return job


def _run_hook(job: Job) -> None:
    if hook := FINISH_HOOKS.get(job.kind):
        try:
            hook(job)
        except Exception:
            log.exception("finish hook for job #%s (%s) failed", job.id, job.kind)


_ANSI = re.compile(r"\x1b\[[\d;]*m")


def _tail(path: Path, n: int = 15) -> str:
    """Last lines of the log, with ANSI colours stripped (stored as plain error text)."""
    try:
        return _ANSI.sub("", "\n".join(path.read_text(errors="replace").splitlines()[-n:]))
    except OSError:
        return ""


manager = JobManager()
