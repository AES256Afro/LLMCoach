"""The project as a pipeline: what the Canvas studio draws, and "Run pipeline".

Running the pipeline looks at every watched folder (the ledger skips files it has already seen),
waits for the indexing and practice-Q&A jobs that produces, then starts a learning-loop run, which
skips training when neither the dataset nor the training settings changed since the last run.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from ..db import Conversation, Dataset, Document, EvalRun, FineTune, Job, JobStatus, LoopRun, Source, SourceFile, get_session
from ..services import kb
from .inbox import _out as source_out
from .inbox import poll_source
from .loop import get_loop, pick_dataset, start_pending
from .projects import get_project_or_404

router = APIRouter(prefix="/api/projects/{project_id}/pipeline", tags=["pipeline"])


@router.get("")
def pipeline(project_id: int, session: Session = Depends(get_session)) -> dict:
    project = get_project_or_404(session, project_id)
    cfg = project.effective_settings()
    docs = list(session.exec(select(Document).where(Document.project_id == project_id).order_by(Document.id.desc())))
    by_status: dict[str, int] = {}
    for d in docs:
        by_status[d.status.value] = by_status.get(d.status.value, 0) + 1
    # Which documents came in through a watched folder, and which were uploaded or dropped in a chat.
    via_source = {f.doc_id: f.source_id for f in session.exec(select(SourceFile).where(
        SourceFile.project_id == project_id, SourceFile.status == "added", SourceFile.doc_id != None))}  # noqa: E711
    convs = list(session.exec(select(Conversation).where(Conversation.project_id == project_id)
                              .order_by(Conversation.updated_at.desc())))
    loop = get_loop(session, project_id)
    learned = pick_dataset(session, project_id, loop)
    runs = list(session.exec(select(LoopRun).where(LoopRun.project_id == project_id).order_by(LoopRun.id.desc()).limit(5)))
    active = list(session.exec(select(Job).where(Job.project_id == project_id,
                                                 Job.status.in_([JobStatus.queued, JobStatus.running])).order_by(Job.id)))
    return {
        "project": {"id": project.id, "name": project.name},
        "sources": [source_out(session, x) for x in session.exec(select(Source).where(Source.project_id == project_id))],
        "documents": {
            "count": len(docs), "bytes": sum(d.size_bytes for d in docs), "by_status": by_status,
            "recent": [d.filename for d in docs[:3]],
            "from_sources": len([d for d in docs if d.id in via_source]),
        },
        "knowledge": {"chunks": kb.count(project_id), "embed_model": cfg["embed_model"]},
        "chat": {"conversations": len(convs), "model": convs[0].model if convs else cfg.get("chat_model"),
                 "last_title": convs[0].title if convs else None, "last_id": convs[0].id if convs else None},
        "datasets": [{"id": d.id, "name": d.name, "source": d.source, "status": d.status, "rows": d.row_count,
                      "splits": d.splits, "job_id": d.job_id} for d in session.exec(
            select(Dataset).where(Dataset.project_id == project_id).order_by(Dataset.id))],
        "finetunes": [{"id": f.id, "name": f.name, "base_model": f.base_model, "dataset_id": f.dataset_id, "status": f.status,
                       "job_id": f.job_id, "promoted_at": f.promoted_at, "metrics": f.metrics, "method": f.method,
                       "config": f.config, "finished_at": f.finished_at, "ollama_model": f.ollama_model} for f in session.exec(
            select(FineTune).where(FineTune.project_id == project_id).order_by(FineTune.id))],
        "evals": [{"id": e.id, "name": e.name, "dataset_id": e.dataset_id, "status": e.status, "variants": e.variants,
                   "summary": e.summary, "job_id": e.job_id} for e in session.exec(
            select(EvalRun).where(EvalRun.project_id == project_id).order_by(EvalRun.id))],
        "loop": {**loop.model_dump(mode="json"), "dataset_id_effective": learned.id if learned else None,
                 "runs": [r.model_dump(mode="json") for r in runs]},
        "active_jobs": [{"id": j.id, "kind": j.kind, "status": j.status, "config": j.config} for j in active],
    }


@router.post("/run")
async def run_pipeline(project_id: int, session: Session = Depends(get_session)) -> dict:
    get_project_or_404(session, project_id)
    looked = []
    for src in list(session.exec(select(Source).where(Source.project_id == project_id, Source.enabled == True))):  # noqa: E712
        looked.append({"source_id": src.id, "name": src.name, **(await poll_source(src.id))})
    loop = get_loop(session, project_id)
    loop.pending_run = True
    session.add(loop)
    session.commit()
    run = start_pending(project_id)  # right away if nothing is being indexed or written
    return {"sources": looked, "run": run.model_dump(mode="json") if run else None, "waiting": run is None}
