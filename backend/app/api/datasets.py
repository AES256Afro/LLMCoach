from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..config import settings
from ..db import Dataset, DatasetStatus, Job, engine, get_session
from ..services import datasets as ds
from ..services import kb
from ..services.jobs import FINISH_HOOKS, manager
from .projects import get_project_or_404

router = APIRouter(prefix="/api/projects/{project_id}/datasets", tags=["datasets"])

MAX_UPLOAD = 200 * 1024 * 1024


def _get(session: Session, project_id: int, dataset_id: int) -> Dataset:
    d = session.get(Dataset, dataset_id)
    if d is None or d.project_id != project_id:
        raise HTTPException(404, "dataset not found")
    return d


def _salvage(job: Job) -> None:
    """A stopped or crashed generation keeps the pairs it already wrote."""
    with Session(engine) as s:
        d = s.get(Dataset, int(job.config.get("dataset_id", 0)))
        if d is None or d.status != DatasetStatus.generating:
            return
        path = ds.dataset_path(d.project_id, d.id)
        rows = [{"messages": r["messages"], "meta": r.get("meta", {})} for r in ds.read_rows(path)]
        d.splits = ds.assign_splits(rows, float(job.config.get("val", 0.1)), float(job.config.get("test", 0.1)),
                                    int(job.config.get("seed", 42))) if rows else None
        ds.write_rows(path, rows)
        d.path = str(path.relative_to(settings.data_dir))
        d.row_count, d.stats = len(rows), ds.compute_stats(rows)
        d.status = DatasetStatus.ready if rows else DatasetStatus.failed
        d.error = f"generation {job.status.value} early; kept {len(rows)} pairs" if rows else f"generation {job.status.value}"
        s.add(d)
        s.commit()


FINISH_HOOKS["generate"] = _salvage


@router.get("")
def list_datasets(project_id: int, session: Session = Depends(get_session)) -> list[Dataset]:
    get_project_or_404(session, project_id)
    return list(session.exec(select(Dataset).where(Dataset.project_id == project_id).order_by(Dataset.id.desc())))


@router.post("", status_code=201)
async def upload_dataset(project_id: int, file: UploadFile = File(...), name: str = Form(""),
                         val: float = Form(0.1), test: float = Form(0.1), seed: int = Form(42),
                         session: Session = Depends(get_session)) -> dict:
    get_project_or_404(session, project_id)
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, f"file is larger than {MAX_UPLOAD // 1024**2} MB")
    errors: list[dict] = []
    try:
        rows, errors, n_err = ds.validate(ds.read_records(file.filename or "data.jsonl", data))
        if not rows:
            raise ds.DatasetError("no valid examples found")
        splits = ds.assign_splits(rows, val, test, seed)
    except ds.DatasetError as e:
        raise HTTPException(400, {"message": str(e), "errors": errors})
    d = Dataset(project_id=project_id, name=(name or file.filename or "dataset").strip()[:120], source="upload",
                row_count=len(rows), splits=splits, stats=ds.compute_stats(rows))
    session.add(d)
    session.commit()
    session.refresh(d)
    path = ds.dataset_path(project_id, d.id)
    ds.write_rows(path, rows)
    d.path = str(path.relative_to(settings.data_dir))
    session.add(d)
    session.commit()
    session.refresh(d)
    return {"dataset": d, "errors": errors, "error_count": n_err}


class GenerateBody(BaseModel):
    name: str | None = None
    model: str
    pairs_per_chunk: int = 3
    max_chunks: int = 40
    doc_ids: list[int] | None = None
    style: str = "closed"  # "closed" | "grounded"
    system_prompt: str | None = None
    val: float = 0.1
    test: float = 0.1
    seed: int = 42


@router.post("/generate", status_code=201)
def generate(project_id: int, body: GenerateBody, session: Session = Depends(get_session)) -> dict:
    project = get_project_or_404(session, project_id)
    if kb.count(project_id) == 0:
        raise HTTPException(400, "the knowledge base is empty; add documents first")
    if body.style not in ("closed", "grounded"):
        raise HTTPException(400, "style must be 'closed' or 'grounded'")
    if not (1 <= body.pairs_per_chunk <= 10 and 1 <= body.max_chunks <= 2000):
        raise HTTPException(400, "pairs_per_chunk must be 1-10 and max_chunks 1-2000")
    d = Dataset(project_id=project_id, name=(body.name or f"Generated from {project.name}")[:120],
                source="generated", status=DatasetStatus.generating)
    session.add(d)
    session.commit()
    session.refresh(d)
    job = manager.submit(session, "generate", {**body.model_dump(), "project_id": project_id, "dataset_id": d.id},
                         project_id=project_id)
    d.job_id = job.id
    session.add(d)
    session.commit()
    session.refresh(d)
    session.refresh(job)  # the commit expired it; an expired object serializes as {}
    return {"dataset": d, "job": job}


@router.get("/{dataset_id}")
def get_dataset(project_id: int, dataset_id: int, session: Session = Depends(get_session)) -> Dataset:
    return _get(session, project_id, dataset_id)


@router.get("/{dataset_id}/rows")
def get_rows(project_id: int, dataset_id: int, split: str | None = None, q: str | None = None,
             offset: int = 0, limit: int = 50, session: Session = Depends(get_session)) -> dict:
    d = _get(session, project_id, dataset_id)
    rows = ds.read_rows(ds.dataset_path(project_id, d.id))
    indexed = list(enumerate(rows))
    if split:
        indexed = [(i, r) for i, r in indexed if r.get("split") == split]
    if q:
        ql = q.lower()
        indexed = [(i, r) for i, r in indexed if any(ql in m["content"].lower() for m in r["messages"])]
    page = indexed[offset:offset + min(limit, 500)]
    return {"rows": [{"index": i, **r} for i, r in page], "total": len(indexed)}


class Resplit(BaseModel):
    val: float = 0.1
    test: float = 0.1
    seed: int = 42


@router.post("/{dataset_id}/split")
def resplit(project_id: int, dataset_id: int, body: Resplit, session: Session = Depends(get_session)) -> Dataset:
    d = _get(session, project_id, dataset_id)
    if d.status != DatasetStatus.ready:
        raise HTTPException(409, "the dataset isn't ready")
    path = ds.dataset_path(project_id, d.id)
    rows = ds.read_rows(path)
    try:
        d.splits = ds.assign_splits(rows, body.val, body.test, body.seed)
    except ds.DatasetError as e:
        raise HTTPException(400, str(e))
    ds.write_rows(path, rows)
    session.add(d)
    session.commit()
    session.refresh(d)
    return d


class Rename(BaseModel):
    name: str


@router.patch("/{dataset_id}")
def rename(project_id: int, dataset_id: int, body: Rename, session: Session = Depends(get_session)) -> Dataset:
    d = _get(session, project_id, dataset_id)
    if body.name.strip():
        d.name = body.name.strip()[:120]
    session.add(d)
    session.commit()
    session.refresh(d)
    return d


@router.get("/{dataset_id}/download")
def download(project_id: int, dataset_id: int, session: Session = Depends(get_session)):
    d = _get(session, project_id, dataset_id)
    path = ds.dataset_path(project_id, d.id)
    if not path.exists():
        raise HTTPException(404, "dataset file is missing")
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in d.name) or "dataset"
    return FileResponse(path, media_type="application/x-ndjson", filename=f"{safe}.jsonl")


@router.delete("/{dataset_id}", status_code=204)
def delete_dataset(project_id: int, dataset_id: int, session: Session = Depends(get_session)) -> None:
    d = _get(session, project_id, dataset_id)
    if d.status == DatasetStatus.generating:
        raise HTTPException(409, "this dataset is still being generated; cancel its job first")
    from ..db import EvalRun, FineTune
    if session.exec(select(FineTune).where(FineTune.dataset_id == d.id)).first():
        raise HTTPException(409, "fine-tunes were trained on this dataset; delete them first")
    if session.exec(select(EvalRun).where(EvalRun.dataset_id == d.id)).first():
        raise HTTPException(409, "evaluations used this dataset; delete them first")
    ds.dataset_path(project_id, d.id).unlink(missing_ok=True)
    session.delete(d)
    session.commit()


def delete_project_datasets(session: Session, project_id: int) -> None:
    for d in session.exec(select(Dataset).where(Dataset.project_id == project_id)):
        ds.dataset_path(project_id, d.id).unlink(missing_ok=True)
        session.delete(d)
    session.flush()
