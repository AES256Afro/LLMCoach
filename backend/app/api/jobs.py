import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import Job, JobStatus, engine, get_session
from ..services.jobs import WORKERS, job_dir, manager
from ..services.stream import FileTail, parse_jsonl

router = APIRouter(tags=["jobs"])


class JobCreate(BaseModel):
    kind: str
    config: dict[str, Any] = {}
    project_id: int | None = None


def _get(session: Session, job_id: int) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return job


@router.get("/api/jobs/kinds")
def list_kinds() -> list[str]:
    return sorted(WORKERS)


@router.get("/api/jobs")
def list_jobs(
    project_id: int | None = None,
    status: JobStatus | None = None,
    limit: int = 50,
    session: Session = Depends(get_session),
) -> list[Job]:
    q = select(Job).order_by(Job.id.desc()).limit(min(limit, 500))
    if project_id is not None:
        q = q.where(Job.project_id == project_id)
    if status is not None:
        q = q.where(Job.status == status)
    return list(session.exec(q))


@router.post("/api/jobs", status_code=201)
def create_job(body: JobCreate, session: Session = Depends(get_session)) -> Job:
    try:
        return manager.submit(session, body.kind, body.config, body.project_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/api/jobs/{job_id}")
def get_job(job_id: int, session: Session = Depends(get_session)) -> Job:
    return _get(session, job_id)


@router.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: int, session: Session = Depends(get_session)) -> Job:
    job = _get(session, job_id)
    manager.cancel(session, job)
    return job


@router.get("/api/jobs/{job_id}/log", response_class=PlainTextResponse)
def get_log(job_id: int, session: Session = Depends(get_session)) -> str:
    _get(session, job_id)
    path = job_dir(job_id) / "log.txt"
    return path.read_text(errors="replace") if path.exists() else ""


@router.get("/api/jobs/{job_id}/metrics")
def get_metrics(job_id: int, session: Session = Depends(get_session)) -> list[dict]:
    _get(session, job_id)
    path = job_dir(job_id) / "metrics.jsonl"
    return parse_jsonl(path.read_text().splitlines()) if path.exists() else []


@router.websocket("/ws/jobs/{job_id}")
async def stream_job(ws: WebSocket, job_id: int) -> None:
    """Streams {type: "log"|"event"|"status"} messages until the job finishes.

    History is sent first, so the same socket works for live and finished jobs.
    """
    await ws.accept()
    d = job_dir(job_id)
    log_tail, metric_tail = FileTail(d / "log.txt"), FileTail(d / "metrics.jsonl")
    last_status = None
    try:
        while True:
            with Session(engine) as s:
                job = s.get(Job, job_id)
            if job is None:
                await ws.send_json({"type": "error", "message": "job not found"})
                break
            if (lines := log_tail.read_new()):
                await ws.send_json({"type": "log", "lines": lines})
            if (events := parse_jsonl(metric_tail.read_new())):
                await ws.send_json({"type": "events", "events": events})
            if job.status != last_status:
                last_status = job.status
                await ws.send_json({"type": "status", "job": job.model_dump(mode="json")})
            if job.status.is_final:
                break
            await asyncio.sleep(0.3)
        await ws.close()
    except WebSocketDisconnect:
        pass
