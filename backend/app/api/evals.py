import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import Dataset, DatasetStatus, EvalRun, FineTune, FineTuneStatus, Job, JobStatus, engine, get_session
from ..services.jobs import FINISH_HOOKS, manager
from ..services.providers import ProviderError, resolve
from ..workers.evaluate import results_path
from .projects import get_project_or_404

router = APIRouter(prefix="/api/projects/{project_id}/evals", tags=["evals"])


def _finish(job: Job) -> None:
    if job.status == JobStatus.done:
        return
    with Session(engine) as s:
        e = s.get(EvalRun, int(job.config.get("eval_id", 0)))
        if e is not None and e.status not in ("done",):
            e.status = "cancelled" if job.status == JobStatus.cancelled else "failed"
            e.error = job.error or f"evaluation {job.status.value}"
            s.add(e)
            s.commit()


FINISH_HOOKS["evaluate"] = _finish


class Variant(BaseModel):
    kind: str  # "model" | "finetune"
    ref: str
    rag: bool = False
    label: str | None = None


class EvalCreate(BaseModel):
    name: str | None = None
    dataset_id: int
    split: str = "test"
    variants: list[Variant]
    judge_model: str | None = None
    max_examples: int = 30
    max_new_tokens: int = 256


def _get(session: Session, project_id: int, eval_id: int) -> EvalRun:
    e = session.get(EvalRun, eval_id)
    if e is None or e.project_id != project_id:
        raise HTTPException(404, "evaluation not found")
    return e


@router.post("", status_code=201)
def create_eval(project_id: int, body: EvalCreate, session: Session = Depends(get_session)) -> dict:
    get_project_or_404(session, project_id)
    d = session.get(Dataset, body.dataset_id)
    if d is None or d.project_id != project_id:
        raise HTTPException(404, "dataset not found")
    if d.status != DatasetStatus.ready:
        raise HTTPException(409, "the dataset isn't ready")
    if not 1 <= len(body.variants) <= 6:
        raise HTTPException(400, "compare between 1 and 6 variants")
    if not 1 <= body.max_examples <= 1000:
        raise HTTPException(400, "max_examples must be 1-1000")
    if body.split not in ("test", "val", "train"):
        raise HTTPException(400, "split must be 'test', 'val' or 'train'")
    variants, labels = [], set()
    for v in body.variants:
        if v.kind == "model":
            try:
                resolve(v.ref, session)
            except ProviderError as e:
                raise HTTPException(400, str(e))
            label = v.label or v.ref
        elif v.kind == "finetune":
            ft = session.get(FineTune, int(v.ref)) if v.ref.isdigit() else None
            if ft is None or ft.project_id != project_id:
                raise HTTPException(404, f"fine-tune {v.ref} not found")
            if ft.status != FineTuneStatus.ready:
                raise HTTPException(409, f"fine-tune '{ft.name}' isn't ready")
            label = v.label or f"{ft.name} (fine-tune)"
        else:
            raise HTTPException(400, "variant kind must be 'model' or 'finetune'")
        if v.rag:
            label += " + knowledge base"
        base, n = label, 2
        while label in labels:
            label, n = f"{base} #{n}", n + 1
        labels.add(label)
        variants.append({"kind": v.kind, "ref": v.ref, "rag": v.rag, "label": label})
    if body.judge_model:
        try:
            resolve(body.judge_model, session)
        except ProviderError as e:
            raise HTTPException(400, f"judge: {e}")
    run = EvalRun(project_id=project_id, name=(body.name or f"Eval on {d.name}")[:120], dataset_id=d.id,
                  split=body.split, variants=variants, judge_model=body.judge_model or None)
    session.add(run)
    session.commit()
    session.refresh(run)
    job = manager.submit(session, "evaluate", {"eval_id": run.id, "max_examples": body.max_examples,
                                               "max_new_tokens": body.max_new_tokens}, project_id=project_id)
    run.job_id = job.id
    session.add(run)
    session.commit()
    session.refresh(run)
    session.refresh(job)
    return {"eval": run, "job": job}


@router.get("")
def list_evals(project_id: int, session: Session = Depends(get_session)) -> list[EvalRun]:
    get_project_or_404(session, project_id)
    return list(session.exec(select(EvalRun).where(EvalRun.project_id == project_id).order_by(EvalRun.id.desc())))


@router.get("/{eval_id}")
def get_eval(project_id: int, eval_id: int, session: Session = Depends(get_session)) -> dict:
    e = _get(session, project_id, eval_id)
    path = results_path(e.id)
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()] if path.exists() else []
    return {**e.model_dump(mode="json"), "results": rows}


@router.delete("/{eval_id}", status_code=204)
def delete_eval(project_id: int, eval_id: int, session: Session = Depends(get_session)) -> None:
    e = _get(session, project_id, eval_id)
    if e.status in ("queued", "running"):
        raise HTTPException(409, "this evaluation is still running; cancel its job first")
    results_path(e.id).unlink(missing_ok=True)
    session.delete(e)
    session.commit()


def delete_project_evals(session: Session, project_id: int) -> None:
    for e in session.exec(select(EvalRun).where(EvalRun.project_id == project_id)):
        results_path(e.id).unlink(missing_ok=True)
        session.delete(e)
    session.flush()
