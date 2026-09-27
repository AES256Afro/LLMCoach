"""Alert settings and the job alerts themselves (see services/notify.py)."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import Dataset, EvalRun, FineTune, Job, JobStatus, LoopRun, engine, get_session
from ..services import notify
from ..services.jobs import AFTER_HOOKS

router = APIRouter(prefix="/api/notify", tags=["alerts"])

KIND_NAME = {"train": "Training", "evaluate": "Evaluation", "generate": "Writing practice Q&A",
             "ingest": "Indexing", "smoke": "Hardware check", "demo": "Demo training"}


def _duration(job: Job) -> str:
    if not (job.started_at and job.finished_at):
        return ""
    s = int((job.finished_at - job.started_at).total_seconds())
    return f"{s // 60}m {s % 60:02d}s" if s >= 60 else f"{s}s"


def job_alert(job: Job) -> tuple[str, str, str, int, str] | None:
    """(event, title, message, priority, tags) for a finished job, or None if it isn't worth a buzz."""
    with Session(engine) as s:
        ft_id, eval_id = job.config.get("finetune_id"), job.config.get("eval_id")
        # The learning loop sends one alert per run with its decision; its steps stay quiet.
        if ft_id and s.exec(select(LoopRun).where(LoopRun.finetune_id == int(ft_id))).first():
            return None
        if eval_id and s.exec(select(LoopRun).where(LoopRun.eval_id == int(eval_id))).first():
            return None
        took = _duration(job)
        if job.status in (JobStatus.failed, JobStatus.cancelled):
            if job.status == JobStatus.cancelled:
                return None  # someone pressed cancel; they know
            last = (job.error or "").strip().splitlines()[-1:] or ["no error message"]
            return ("failed", f"{KIND_NAME.get(job.kind, job.kind)} failed · job #{job.id}", last[0][:300], 4, "warning")
        if job.kind == "train":
            ft = s.get(FineTune, int(ft_id or 0))
            m = (ft.metrics if ft else None) or {}
            loss = f"loss {m['train_loss']:.3f}" if m.get("train_loss") is not None else "done"
            name = ft.name if ft else f"job #{job.id}"
            return ("train", f"Training finished · {name}", f"{loss}, {m.get('steps', '?')} steps in {took}.", 3, "white_check_mark")
        if job.kind == "evaluate":
            e = s.get(EvalRun, int(eval_id or 0))
            if e is None or not e.summary:
                return None
            ranked = sorted(e.summary.items(), key=lambda kv: kv[1].get("f1") or 0, reverse=True)
            lines = [f"{label}: F1 {v.get('f1', 0):.2f}" for label, v in ranked]
            return ("evaluate", f"Evaluation finished · {e.name}", "\n".join(lines), 3, "bar_chart")
        if job.kind == "generate":
            d = s.get(Dataset, int(job.config.get("dataset_id", 0)))
            if d is None:
                return None
            return ("generate", f"Practice Q&A written · {d.name}", f"“{d.name}” now has {d.row_count} examples.", 2, "pencil")
    return None


def _notify_job(job: Job) -> None:
    alert = job_alert(job)
    if alert:
        notify.send(*alert)


AFTER_HOOKS.append(_notify_job)


class NotifyConfig(BaseModel):
    url: str = ""
    token: str | None = None  # None keeps the stored token; "" clears it
    events: list[str] = []


def _out(cfg: dict) -> dict:
    return {"url": cfg["url"], "token_set": bool(cfg.get("token")), "events": cfg["events"], "available": notify.EVENTS}


@router.get("")
def get_notify(session: Session = Depends(get_session)) -> dict:
    return _out(notify.get_config(session))


@router.put("")
def put_notify(body: NotifyConfig, session: Session = Depends(get_session)) -> dict:
    url = body.url.strip()
    if url and not url.startswith(("http://", "https://")):
        raise HTTPException(400, "the topic URL starts with http:// or https://, e.g. https://ntfy.sh/my-llmcoach")
    unknown = set(body.events) - set(notify.EVENTS)
    if unknown:
        raise HTTPException(400, f"unknown events: {sorted(unknown)}")
    current = notify.get_config(session)
    token = current.get("token", "") if body.token is None else body.token.strip()
    return _out(notify.save_config(session, {"url": url, "token": token, "events": body.events}))


@router.post("/test")
async def test_notify(session: Session = Depends(get_session)) -> dict:
    cfg = notify.get_config(session)
    if not cfg["url"]:
        raise HTTPException(400, "set a topic URL first")
    try:
        await asyncio.to_thread(notify.post, cfg["url"], cfg.get("token", ""), "LLMCoach test alert",
                                "Alerts work. You'll hear from LLMCoach when runs finish.", 3, "bell")
    except Exception as e:
        raise HTTPException(502, f"ntfy didn't accept it: {e}")
    return {"ok": True}
