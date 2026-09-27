import time

from sqlmodel import Session, select

from app.api import loop as loop_api
from app.config import settings
from app.db import Dataset, DatasetStatus, LearningLoop, LoopRun, engine, utcnow
from app.services import training
from tests.test_inbox import _project, _source, _text, _write
from tests.test_jobs import wait_final


def _runs(pid: int) -> list[LoopRun]:
    with Session(engine) as s:
        return list(s.exec(select(LoopRun).where(LoopRun.project_id == pid).order_by(LoopRun.id)))


def test_pipeline_graph(client):
    pid = _project(client, "pipe-graph")
    src = _source(client, pid, "pipe-graph")
    _write(settings.inbox_root / "pipe-graph", "a.md", _text("Alpha"))
    out = client.post(f"/api/projects/{pid}/sources/{src['id']}/scan").json()
    wait_final(client, out["ingest_job_id"])
    g = client.get(f"/api/projects/{pid}/pipeline").json()
    assert g["project"]["name"] == "pipe-graph"
    assert [x["name"] for x in g["sources"]] == ["pipe-graph"] and g["sources"][0]["counts"] == {"added": 1}
    assert g["documents"]["count"] == 1 and g["documents"]["from_sources"] == 1 and g["documents"]["recent"] == ["a.md"]
    assert g["knowledge"]["chunks"] > 0
    assert g["chat"]["conversations"] == 0 and g["datasets"] == [] and g["finetunes"] == [] and g["evals"] == []
    assert g["loop"]["enabled"] is False and g["loop"]["runs"] == [] and g["active_jobs"] == []


def test_run_waits_for_indexing_and_learning_then_starts_the_loop(client):
    pid = _project(client, "pipe-run")
    src = _source(client, pid, "pipe-run", mode="learn")
    _write(settings.inbox_root / "pipe-run", "short.md", _text("Harbor", 2))
    r = client.post(f"/api/projects/{pid}/pipeline/run").json()
    looked = r["sources"][0]
    assert looked["processed"] == {"added": 1} and looked["ingest_job_id"] and looked["learn_job_id"]
    assert r["waiting"] is True and r["run"] is None  # indexing and Q&A are still queued

    wait_final(client, looked["ingest_job_id"])
    wait_final(client, looked["learn_job_id"])
    deadline = time.time() + 5
    while time.time() < deadline and not _runs(pid):
        time.sleep(0.05)
    runs = _runs(pid)
    assert [x.trigger for x in runs] == ["pipeline"]
    # One short file makes too few examples for a test split, so the run stops before training.
    assert runs[0].status == "skipped" and "no test questions" in runs[0].reason
    with Session(engine) as s:
        assert s.exec(select(LearningLoop).where(LearningLoop.project_id == pid)).first().pending_run is False

    # Nothing new in the folder: the ledger skips the file and the run starts at once.
    again = client.post(f"/api/projects/{pid}/pipeline/run").json()
    assert again["sources"][0]["processed"] == {} and again["waiting"] is False and again["run"]["trigger"] == "pipeline"


def test_rerun_skips_training_when_nothing_changed(client):
    pid = _project(client, "pipe-unchanged")
    with Session(engine) as s:
        d = Dataset(project_id=pid, name="Learned from the inbox", source="inbox", status=DatasetStatus.ready,
                    row_count=40, splits={"train": 40, "val": 0, "test": 0})
        s.add(d)
        s.commit()
        loop = loop_api.get_loop(s, pid)
        loop.last_rows, loop.last_run_at = 40, utcnow()
        loop.last_config = f"{training.recommended_base_model(training.hardware())}|quick"
        s.add(loop)
        s.commit()
    r = client.post(f"/api/projects/{pid}/pipeline/run").json()
    assert r["run"]["status"] == "skipped" and r["run"]["reason"].startswith("Unchanged")

    # New settings are a change, even with the same data (this dataset then stops at "no test questions").
    client.put(f"/api/projects/{pid}/loop", json={"preset": "balanced"})
    r = client.post(f"/api/projects/{pid}/pipeline/run").json()
    assert not r["run"]["reason"].startswith("Unchanged") and "no test questions" in r["run"]["reason"]
    assert r["run"]["config"].endswith("|balanced")
