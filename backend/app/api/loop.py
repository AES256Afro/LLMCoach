"""The learning loop: retrain on a schedule, and keep the new adapter only if it scores better.

A run trains on the project's learned dataset, evaluates the new adapter against the promoted one
on the dataset's test questions, and promotes it only when its F1 beats the current one by the
configured margin. The steps are ordinary jobs; an after-hook moves the run along as each finishes.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import (Dataset, DatasetStatus, EvalRun, FineTune, FineTuneStatus, Job, JobStatus, LearningLoop, LoopRun,
                  Project, engine, get_session, utcnow)
from ..services import training
from ..services.jobs import AFTER_HOOKS
from .evals import EvalCreate, Variant, create_eval
from .projects import get_project_or_404
from .training import FineTuneCreate, create_finetune

router = APIRouter(prefix="/api/projects/{project_id}", tags=["learning loop"])

ACTIVE = ("training", "evaluating")
NEW_LABEL, CURRENT_LABEL = "New adapter", "Current adapter"


def _aware(dt: datetime | None) -> datetime | None:
    return dt.replace(tzinfo=timezone.utc) if dt is not None and dt.tzinfo is None else dt


def next_occurrence(hour: int, minute: int, after: datetime) -> datetime:
    candidate = after.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return candidate if candidate > after else candidate + timedelta(days=1)


def get_loop(s: Session, project_id: int) -> LearningLoop:
    loop = s.exec(select(LearningLoop).where(LearningLoop.project_id == project_id)).first()
    if loop is None:
        loop = LearningLoop(project_id=project_id)
        s.add(loop)
        s.commit()
        s.refresh(loop)
    return loop


def pick_dataset(s: Session, project_id: int, loop: LearningLoop) -> Dataset | None:
    if loop.dataset_id:
        d = s.get(Dataset, loop.dataset_id)
        return d if d is not None and d.project_id == project_id else None
    for source in ("inbox", "chat"):  # what the project has been learning, in order of preference
        d = s.exec(select(Dataset).where(Dataset.project_id == project_id, Dataset.source == source)).first()
        if d is not None:
            return d
    return None


def promoted(s: Session, project_id: int) -> FineTune | None:
    return s.exec(select(FineTune).where(FineTune.project_id == project_id, FineTune.promoted_at != None)  # noqa: E711
                  .order_by(FineTune.promoted_at.desc())).first()


def promote(s: Session, ft: FineTune) -> None:
    for other in s.exec(select(FineTune).where(FineTune.project_id == ft.project_id, FineTune.promoted_at != None)):  # noqa: E711
        other.promoted_at = None
        s.add(other)
    ft.promoted_at = utcnow()
    s.add(ft)
    s.commit()


def _end(s: Session, run: LoopRun, status: str, reason: str) -> LoopRun:
    run.status, run.reason, run.finished_at = status, reason, utcnow()
    s.add(run)
    s.commit()
    s.refresh(run)
    return run


def start_run(s: Session, project: Project, loop: LearningLoop, trigger: str) -> LoopRun:
    active = s.exec(select(LoopRun).where(LoopRun.project_id == project.id, LoopRun.status.in_(ACTIVE))).first()
    if active:
        raise HTTPException(409, f"run #{active.id} is still {active.status}")
    run = LoopRun(project_id=project.id, trigger=trigger)
    s.add(run)
    s.commit()  # its number names the adapter
    s.refresh(run)
    d = pick_dataset(s, project.id, loop)
    if d is None:
        return _end(s, run, "skipped", "There's nothing to learn from yet. Drop files onto Learn in the chat, "
                                       "or add a watched folder set to Learn.")
    run.dataset_id, run.rows = d.id, d.row_count
    if d.status != DatasetStatus.ready:
        return _end(s, run, "skipped", f"“{d.name}” is still being written. The next run will try again.")
    new_rows = d.row_count - loop.last_rows if d.row_count >= loop.last_rows else d.row_count
    if trigger == "schedule" and new_rows < loop.min_new_rows:
        return _end(s, run, "skipped", f"No new examples since the last run ({d.row_count} in “{d.name}”).")
    if not (d.splits or {}).get("test"):
        return _end(s, run, "skipped", f"“{d.name}” has no test questions yet, so a new adapter couldn't be judged. "
                                       "It needs about ten examples.")
    baseline = promoted(s, project.id)
    base_model = loop.base_model or training.recommended_base_model(training.hardware())
    short = base_model.split("/")[-1]
    try:
        r = create_finetune(project.id, FineTuneCreate(
            name=f"{short} on {d.name}, loop run #{run.id}", base_model=base_model, dataset_id=d.id,
            preset=loop.preset), s)
    except HTTPException as e:
        return _end(s, run, "failed", f"Training couldn't start: {e.detail}")
    run.finetune_id = r["finetune"].id
    run.baseline_finetune_id = baseline.id if baseline else None
    s.add(run)
    s.commit()
    s.refresh(run)
    return run


# ---- following the jobs ------------------------------------------------------------------------

def _after_train(job: Job) -> None:
    ft_id = int(job.config.get("finetune_id", 0))
    with Session(engine) as s:
        run = s.exec(select(LoopRun).where(LoopRun.finetune_id == ft_id, LoopRun.status == "training")).first()
        if run is None:
            return
        ft = s.get(FineTune, ft_id)
        if job.status != JobStatus.done or ft is None or ft.status != FineTuneStatus.ready:
            detail = (ft.error if ft else None) or job.error or ""
            _end(s, run, "failed", f"Training {job.status.value}. {detail}".strip()[:500])
            return
        variants = [Variant(kind="finetune", ref=str(ft.id), label=NEW_LABEL)]
        baseline = s.get(FineTune, run.baseline_finetune_id) if run.baseline_finetune_id else None
        if baseline is not None and baseline.status == FineTuneStatus.ready:
            variants.append(Variant(kind="finetune", ref=str(baseline.id), label=CURRENT_LABEL))
        loop = get_loop(s, run.project_id)
        try:
            r = create_eval(run.project_id, EvalCreate(name=f"Learning loop run #{run.id}", dataset_id=run.dataset_id,
                                                       split="test", variants=variants,
                                                       max_examples=loop.max_examples), s)
        except HTTPException as e:
            _end(s, run, "failed", f"The evaluation couldn't start: {e.detail}")
            return
        run.eval_id, run.status = r["eval"].id, "evaluating"
        s.add(run)
        s.commit()


def _after_eval(job: Job) -> None:
    eval_id = int(job.config.get("eval_id", 0))
    with Session(engine) as s:
        run = s.exec(select(LoopRun).where(LoopRun.eval_id == eval_id, LoopRun.status == "evaluating")).first()
        if run is None:
            return
        e = s.get(EvalRun, eval_id)
        if job.status != JobStatus.done or e is None or e.status != "done":
            _end(s, run, "failed", f"The evaluation {job.status.value}. {(e.error if e else None) or ''}".strip()[:500])
            return
        summary = e.summary or {}
        cand = (summary.get(NEW_LABEL) or {}).get("f1")
        base = (summary.get(CURRENT_LABEL) or {}).get("f1")
        run.candidate_f1, run.baseline_f1 = cand, base
        loop = get_loop(s, run.project_id)
        ft = s.get(FineTune, run.finetune_id)
        if cand is None or ft is None:
            _end(s, run, "failed", "The evaluation produced no score for the new adapter.")
            return
        if base is None:
            promote(s, ft)
            why = ("It's the project's first adapter" if run.baseline_finetune_id is None
                   else "The current adapter couldn't be scored")
            _end(s, run, "promoted", f"{why}, so the new one was promoted (F1 {cand:.2f}).")
        elif cand > base + loop.margin:
            promote(s, ft)
            _end(s, run, "promoted", f"Scored F1 {cand:.2f} against {base:.2f} for the current adapter: promoted.")
        else:
            need = f", and needed to beat it by {loop.margin:.2f}" if loop.margin else ""
            _end(s, run, "kept", f"Scored F1 {cand:.2f} against {base:.2f} for the current adapter{need}: "
                                 "kept the current one.")
        loop.last_rows, loop.last_run_at = run.rows, utcnow()
        s.add(loop)
        s.commit()


def _follow(job: Job) -> None:
    if job.kind == "train":
        _after_train(job)
    elif job.kind == "evaluate":
        _after_eval(job)


AFTER_HOOKS.append(_follow)


async def scheduler_tick(now: datetime | None = None) -> None:
    """Starts the runs that are due. Called by the inbox watcher's heartbeat."""
    now = now or utcnow()
    with Session(engine) as s:
        for loop in list(s.exec(select(LearningLoop).where(LearningLoop.enabled == True))):  # noqa: E712
            due = _aware(loop.next_run_at)
            loop.next_run_at = next_occurrence(loop.hour_utc, loop.minute, now) if due is None or due <= now else due
            s.add(loop)
            s.commit()
            if due is None or due > now:
                continue
            try:
                start_run(s, s.get(Project, loop.project_id), loop, "schedule")
            except HTTPException:
                pass  # the previous run is still going; tomorrow, then


# ---- API ----------------------------------------------------------------------------------------

def _state(s: Session, project_id: int) -> dict:
    loop = get_loop(s, project_id)
    fts = list(s.exec(select(FineTune).where(FineTune.project_id == project_id).order_by(FineTune.id.desc())))
    names = {f.id: f.name for f in fts}
    runs = list(s.exec(select(LoopRun).where(LoopRun.project_id == project_id).order_by(LoopRun.id.desc()).limit(20)))
    d = pick_dataset(s, project_id, loop)
    return {
        "loop": loop,
        "dataset": {"id": d.id, "name": d.name, "rows": d.row_count, "splits": d.splits, "status": d.status} if d else None,
        "recommended_base_model": training.recommended_base_model(training.hardware()),
        "runs": [{**r.model_dump(mode="json"), "finetune_name": names.get(r.finetune_id),
                  "baseline_name": names.get(r.baseline_finetune_id)} for r in runs],
        "registry": [{"id": f.id, "name": f.name, "base_model": f.base_model, "status": f.status,
                      "dataset_id": f.dataset_id, "created_at": f.created_at, "promoted_at": f.promoted_at,
                      "train_loss": (f.metrics or {}).get("train_loss")} for f in fts],
    }


@router.get("/loop")
def get_state(project_id: int, session: Session = Depends(get_session)) -> dict:
    get_project_or_404(session, project_id)
    return _state(session, project_id)


class LoopUpdate(BaseModel):
    enabled: bool | None = None
    hour_utc: int | None = None
    minute: int | None = None
    dataset_id: int | None = None  # 0 = pick automatically
    base_model: str | None = None  # "" = the recommended model
    preset: str | None = None
    min_new_rows: int | None = None
    margin: float | None = None
    max_examples: int | None = None


@router.put("/loop")
def update_loop(project_id: int, body: LoopUpdate, session: Session = Depends(get_session)) -> dict:
    get_project_or_404(session, project_id)
    loop = get_loop(session, project_id)
    checks = [("hour_utc", 0, 23), ("minute", 0, 59), ("min_new_rows", 0, 1_000_000), ("max_examples", 1, 500)]
    for key, lo, hi in checks:
        value = getattr(body, key)
        if value is not None and not lo <= value <= hi:
            raise HTTPException(400, f"{key} must be between {lo} and {hi}")
    if body.margin is not None and not 0 <= body.margin <= 1:
        raise HTTPException(400, "margin is an F1 difference between 0 and 1")
    if body.preset is not None and body.preset not in training.PRESETS:
        raise HTTPException(400, f"preset must be one of {', '.join(training.PRESETS)}")
    if body.dataset_id:
        d = session.get(Dataset, body.dataset_id)
        if d is None or d.project_id != project_id:
            raise HTTPException(404, "dataset not found")
    for key, value in body.model_dump(exclude_none=True).items():
        if key == "dataset_id":
            value = value or None
        elif key == "base_model":
            value = value.strip() or None
        setattr(loop, key, value)
    loop.next_run_at = next_occurrence(loop.hour_utc, loop.minute, utcnow()) if loop.enabled else None
    session.add(loop)
    session.commit()
    return _state(session, project_id)


@router.post("/loop/run", status_code=201)
def run_now(project_id: int, session: Session = Depends(get_session)) -> LoopRun:
    project = get_project_or_404(session, project_id)
    return start_run(session, project, get_loop(session, project_id), "manual")


def _ft(s: Session, project_id: int, ft_id: int) -> FineTune:
    ft = s.get(FineTune, ft_id)
    if ft is None or ft.project_id != project_id:
        raise HTTPException(404, "fine-tune not found")
    return ft


@router.post("/finetunes/{ft_id}/promote")
def promote_finetune(project_id: int, ft_id: int, session: Session = Depends(get_session)) -> dict:
    ft = _ft(session, project_id, ft_id)
    if ft.status != FineTuneStatus.ready:
        raise HTTPException(409, "only a finished fine-tune can be promoted")
    promote(session, ft)
    return _state(session, project_id)


@router.post("/finetunes/{ft_id}/demote")
def demote_finetune(project_id: int, ft_id: int, session: Session = Depends(get_session)) -> dict:
    ft = _ft(session, project_id, ft_id)
    ft.promoted_at = None
    session.add(ft)
    session.commit()
    return _state(session, project_id)


def delete_project_loop(session: Session, project_id: int) -> None:
    for row in session.exec(select(LoopRun).where(LoopRun.project_id == project_id)):
        session.delete(row)
    for row in session.exec(select(LearningLoop).where(LearningLoop.project_id == project_id)):
        session.delete(row)
    session.flush()
