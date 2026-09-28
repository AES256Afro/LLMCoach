import re
import shutil

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..config import settings
from ..db import Dataset, DatasetStatus, FineTune, FineTuneStatus, Job, JobStatus, engine, get_session, utcnow
from ..services import datasets as ds
from ..services import training
from ..services.jobs import FINISH_HOOKS, manager
from .projects import get_project_or_404

router = APIRouter(tags=["training"])


def _finish(job: Job) -> None:
    """Mirror a stopped or crashed training job onto its fine-tune."""
    if job.status == JobStatus.done:
        return
    with Session(engine) as s:
        ft = s.get(FineTune, int(job.config.get("finetune_id", 0)))
        if ft is None or ft.status == FineTuneStatus.ready:
            return
        ft.status = FineTuneStatus.cancelled if job.status == JobStatus.cancelled else FineTuneStatus.failed
        ft.error = job.error or f"training {job.status.value}"
        ft.finished_at = utcnow()
        s.add(ft)
        s.commit()


FINISH_HOOKS["train"] = _finish


@router.get("/api/training/options")
def options() -> dict:
    hw = training.hardware()
    return {"base_models": training.BASE_MODELS, "presets": training.PRESETS, "hardware": hw,
            "recommended_base_model": training.recommended_base_model(hw),
            "cpu_max_params_b": training.CPU_MAX_PARAMS_B, "hf_token_set": bool(settings.hf_token)}


class FineTuneCreate(BaseModel):
    name: str | None = None
    base_model: str
    dataset_id: int
    preset: str = "quick"
    method: str = "lora"
    backend: str = "auto"
    overrides: dict = {}
    dry_run: bool = False  # validate and return the plan without starting


def _train_rows(session: Session, project_id: int, dataset_id: int) -> tuple[Dataset, int]:
    d = session.get(Dataset, dataset_id)
    if d is None or d.project_id != project_id:
        raise HTTPException(404, "dataset not found")
    if d.status != DatasetStatus.ready:
        raise HTTPException(409, "the dataset isn't ready")
    n = (d.splits or {}).get("train") or sum(1 for r in ds.read_rows(ds.dataset_path(project_id, d.id))
                                             if r.get("split", "train") == "train")
    if not n:
        raise HTTPException(400, "the dataset has no training examples")
    return d, n


@router.post("/api/projects/{project_id}/finetunes", status_code=201)
def create_finetune(project_id: int, body: FineTuneCreate, session: Session = Depends(get_session)) -> dict:
    get_project_or_404(session, project_id)
    dataset, n_train = _train_rows(session, project_id, body.dataset_id)
    try:
        plan = training.plan(body.base_model.strip(), body.preset, body.overrides, body.method, body.backend, n_train)
    except training.PlanError as e:
        raise HTTPException(400, str(e))
    plan["base_model"] = body.base_model.strip()
    if body.dry_run:
        return {"plan": plan}
    short = plan["base_model"].split("/")[-1]
    ft = FineTune(project_id=project_id, name=(body.name or f"{short} on {dataset.name}")[:120],
                  base_model=plan["base_model"], dataset_id=dataset.id, method=plan["method"],
                  backend=plan["backend"], config={**plan, "preset": body.preset})
    session.add(ft)
    session.commit()
    session.refresh(ft)
    job = manager.submit(session, "train", {**plan, "finetune_id": ft.id}, project_id=project_id)
    ft.job_id = job.id
    session.add(ft)
    session.commit()
    session.refresh(ft)
    session.refresh(job)
    return {"finetune": ft, "job": job, "plan": plan}


@router.get("/api/projects/{project_id}/finetunes")
def list_finetunes(project_id: int, session: Session = Depends(get_session)) -> list[FineTune]:
    get_project_or_404(session, project_id)
    return list(session.exec(select(FineTune).where(FineTune.project_id == project_id).order_by(FineTune.id.desc())))


@router.get("/api/projects/{project_id}/finetunes/{ft_id}")
def get_finetune(project_id: int, ft_id: int, session: Session = Depends(get_session)) -> FineTune:
    ft = session.get(FineTune, ft_id)
    if ft is None or ft.project_id != project_id:
        raise HTTPException(404, "fine-tune not found")
    return ft


@router.delete("/api/projects/{project_id}/finetunes/{ft_id}", status_code=204)
def delete_finetune(project_id: int, ft_id: int, session: Session = Depends(get_session)) -> None:
    ft = get_finetune(project_id, ft_id, session)
    if ft.status in (FineTuneStatus.queued, FineTuneStatus.training):
        raise HTTPException(409, "this fine-tune is still training; cancel its job first")
    from ..db import EvalRun
    for e in session.exec(select(EvalRun).where(EvalRun.project_id == project_id, EvalRun.status.in_(["queued", "running"]))):
        if any(v["kind"] == "finetune" and v["ref"] == str(ft.id) for v in e.variants or []):
            raise HTTPException(409, "an evaluation using this fine-tune is running")
    shutil.rmtree(settings.data_dir / "finetunes" / str(ft.id), ignore_errors=True)
    session.delete(ft)
    session.commit()


class ExportBody(BaseModel):
    name: str | None = None
    quantize: str | None = "q8_0"  # "q8_0" | "q4_K_M" | None (keep 16-bit)


QUANTIZE = (None, "q8_0", "q4_K_M")


def _slug(project_name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", project_name.lower()).strip("-")[:30] or "project"


def ollama_name(project_name: str, ft: FineTune) -> str:
    return f"llmcoach-{_slug(project_name)}-ft{ft.id}"


def current_model_name(project_name: str) -> str:
    """The Ollama model the learning loop keeps pointed at the promoted adapter."""
    return f"llmcoach-{_slug(project_name)}-current"


def submit_export(session: Session, project_id: int, ft: FineTune, name: str, quantize: str | None = "q8_0") -> Job:
    return manager.submit(session, "export", {"finetune_id": ft.id, "name": name, "quantize": quantize, "provider": "ollama"},
                          project_id=project_id)


@router.post("/api/projects/{project_id}/finetunes/{ft_id}/export", status_code=201)
def export_finetune(project_id: int, ft_id: int, body: ExportBody, session: Session = Depends(get_session)) -> dict:
    """Merges the adapter into its base model and builds it as a model on the Ollama server."""
    project = get_project_or_404(session, project_id)
    ft = get_finetune(project_id, ft_id, session)
    if ft.status != FineTuneStatus.ready or not ft.output_dir:
        raise HTTPException(409, "only a finished fine-tune can be exported")
    if not (settings.data_dir / ft.output_dir / "adapter_config.json").exists():
        raise HTTPException(409, "this fine-tune's adapter files are missing")
    if body.quantize not in QUANTIZE:
        raise HTTPException(400, "quantize must be q8_0, q4_K_M, or null to keep 16-bit weights")
    name = (body.name or ollama_name(project.name, ft)).strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,62}(:[a-z0-9._-]{1,32})?", name):
        raise HTTPException(400, "the model name may use lowercase letters, digits, '.', '_' and '-'")
    job = submit_export(session, project_id, ft, name, body.quantize)
    return {"job": job, "model": f"ollama/{name}"}


def delete_project_finetunes(session: Session, project_id: int) -> None:
    for ft in session.exec(select(FineTune).where(FineTune.project_id == project_id)):
        shutil.rmtree(settings.data_dir / "finetunes" / str(ft.id), ignore_errors=True)
        session.delete(ft)
    session.flush()
