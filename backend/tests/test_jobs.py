import time

from app.services.stream import FileTail


def wait_final(client, job_id: int, timeout: float = 30) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "failed", "cancelled"):
            return job
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} did not finish: {job}")


def test_health(client):
    assert client.get("/api/health").json() == {"ok": True, "version": "dev"}


def test_system_stats(client):
    s = client.get("/api/system").json()
    assert s["backend"] in ("cpu", "cuda", "rocm")
    assert s["ram_total_gb"] > 0


def test_projects_crud(client):
    r = client.post("/api/projects", json={"name": "support-bot"})
    assert r.status_code == 201
    pid = r.json()["id"]
    assert client.post("/api/projects", json={"name": "support-bot"}).status_code == 409
    assert any(p["id"] == pid for p in client.get("/api/projects").json())
    assert client.delete(f"/api/projects/{pid}").status_code == 204


def test_unknown_kind_rejected(client):
    r = client.post("/api/jobs", json={"kind": "rm -rf", "config": {}})
    assert r.status_code == 400


def test_demo_job_runs_and_records_metrics(client):
    job = client.post("/api/jobs", json={"kind": "demo", "config": {"steps": 5, "delay": 0.01, "eval_every": 2}}).json()
    job = wait_final(client, job["id"])
    assert job["status"] == "done", job
    assert job["exit_code"] == 0

    metrics = client.get(f"/api/jobs/{job['id']}/metrics").json()
    losses = [m for m in metrics if m["type"] == "metric" and "loss" in m]
    assert [m["step"] for m in losses] == [1, 2, 3, 4, 5]
    assert any("eval_loss" in m for m in metrics)
    assert "step    5/5" in client.get(f"/api/jobs/{job['id']}/log").text


def test_failing_job_captures_error(client):
    job = client.post("/api/jobs", json={"kind": "demo", "config": {"steps": 5, "delay": 0.01, "fail_at": 3}}).json()
    job = wait_final(client, job["id"])
    assert job["status"] == "failed"
    assert "simulated failure at step 3" in job["error"]
    assert "\x1b[" not in job["error"]


def test_cancel_running_job(client):
    job = client.post("/api/jobs", json={"kind": "demo", "config": {"steps": 1000, "delay": 0.05}}).json()
    deadline = time.time() + 10
    while client.get(f"/api/jobs/{job['id']}").json()["status"] != "running" and time.time() < deadline:
        time.sleep(0.05)
    client.post(f"/api/jobs/{job['id']}/cancel")
    assert wait_final(client, job["id"])["status"] == "cancelled"
    # The API is still healthy and runs the next job.
    nxt = client.post("/api/jobs", json={"kind": "demo", "config": {"steps": 2, "delay": 0.01}}).json()
    assert wait_final(client, nxt["id"])["status"] == "done"


def test_cancel_while_the_process_is_starting(client, monkeypatch):
    """Cancel lands after the job is marked running but before its process is registered."""
    import subprocess

    from sqlmodel import Session

    from app.db import Job, engine
    from app.services import jobs

    real_popen = subprocess.Popen

    def popen(cmd, *args, **kw):
        proc = real_popen(cmd, *args, **kw)
        if isinstance(cmd, list) and "app.workers.demo" in cmd:
            job_id = int(cmd[cmd.index("--job-dir") + 1].replace("\\", "/").rsplit("/", 1)[-1])
            with Session(engine) as s:
                jobs.manager.cancel(s, s.get(Job, job_id))
        return proc

    monkeypatch.setattr(jobs.subprocess, "Popen", popen)
    started = time.time()
    job = client.post("/api/jobs", json={"kind": "demo", "config": {"steps": 5, "delay": 2}}).json()
    job = wait_final(client, job["id"])
    assert job["status"] == "cancelled" and time.time() - started < 8  # terminated, not run to completion


def test_finish_keeps_a_cancelled_status(client):
    from app.db import JobStatus
    from app.services.jobs import manager

    job = client.post("/api/jobs", json={"kind": "demo", "config": {"steps": 1000, "delay": 0.05}}).json()
    client.post(f"/api/jobs/{job['id']}/cancel")
    assert wait_final(client, job["id"])["status"] == "cancelled"
    manager._finish(job["id"], JobStatus.done, exit_code=0)  # a late finish must not flip it to done
    assert client.get(f"/api/jobs/{job['id']}").json()["status"] == "cancelled"


def test_websocket_streams_history_and_final_status(client):
    job = client.post("/api/jobs", json={"kind": "demo", "config": {"steps": 3, "delay": 0.01}}).json()
    wait_final(client, job["id"])
    lines, events, statuses = [], [], []
    with client.websocket_connect(f"/ws/jobs/{job['id']}") as ws:
        while True:
            try:
                msg = ws.receive_json()
            except Exception:
                break
            if msg["type"] == "log":
                lines += msg["lines"]
            elif msg["type"] == "events":
                events += msg["events"]
            elif msg["type"] == "status":
                statuses.append(msg["job"]["status"])
    assert any("step    3/3" in ln for ln in lines)
    assert sum(1 for e in events if e["type"] == "metric") == 3
    assert statuses[-1] == "done"


def test_websocket_sends_all_of_a_large_finished_log(client):
    from sqlmodel import Session

    from app.db import Job, JobStatus, engine
    from app.services.jobs import job_dir

    with Session(engine) as s:
        job = Job(kind="demo", config={}, status=JobStatus.done, exit_code=0)
        s.add(job)
        s.commit()
        s.refresh(job)
        job_id = job.id
    d = job_dir(job_id)
    d.mkdir(parents=True, exist_ok=True)
    n = 60_000  # ~3.5 MB: several read_new() chunks
    (d / "log.txt").write_text("".join(f"line {i:06d} " + "x" * 48 + "\n" for i in range(n - 1)) + "last, no newline")
    (d / "metrics.jsonl").write_text("".join(f'{{"type": "metric", "step": {i}, "pad": "{"y" * 40}"}}\n' for i in range(30_000)))
    lines, events = [], []
    with client.websocket_connect(f"/ws/jobs/{job_id}") as ws:
        while True:
            try:
                msg = ws.receive_json()
            except Exception:
                break
            if msg["type"] == "log":
                lines += msg["lines"]
            elif msg["type"] == "events":
                events += msg["events"]
    assert len(lines) == n and lines[-1] == "last, no newline"
    assert len(events) == 30_000


def test_file_tail_handles_partial_lines(tmp_path):
    p = tmp_path / "log.txt"
    tail = FileTail(p)
    assert tail.read_new() == []
    p.write_bytes(b"one\ntw")
    assert tail.read_new() == ["one"]
    with open(p, "ab") as f:
        f.write(b"o\nthree\n")
    assert tail.read_new() == ["two", "three"]


def test_restart_requeues_indexing_and_fails_the_rest(client):
    """An app update restarts the server mid-job: indexing starts again (ahead of the Q&A job that
    waits on it); a training run is failed rather than silently started over."""
    from sqlmodel import Session

    from app.db import Job, JobStatus, engine
    from app.services.jobs import recover_orphans

    with Session(engine) as s:
        ingest = Job(kind="ingest", status=JobStatus.running, config={"doc_ids": []})
        train = Job(kind="train", status=JobStatus.running, config={})
        s.add_all([ingest, train])
        s.commit()
        ingest_id, train_id = ingest.id, train.id
    recover_orphans()
    with Session(engine) as s:
        i, t = s.get(Job, ingest_id), s.get(Job, train_id)
        assert i.status == JobStatus.queued and i.started_at is None and i.error is None
        assert t.status == JobStatus.failed and t.error == "orphaned by server restart"
        # Leave nothing queued for the running queue to pick up.
        i.status = JobStatus.cancelled
        s.add(i)
        s.commit()
