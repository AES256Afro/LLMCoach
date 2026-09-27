import time
from datetime import timedelta

from sqlmodel import Session

from app.api import loop as loop_api
from app.api.notify import job_alert
from app.config import settings
from app.db import Dataset, DatasetStatus, EvalRun, FineTune, FineTuneStatus, Job, JobStatus, LoopRun, engine, utcnow
from app.services import notify
from tests.test_inbox import _project, _source, _write


def _wait_for(fake, n: int, timeout: float = 5) -> list[dict]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if len(fake.app.state.ntfy) >= n:
            return fake.app.state.ntfy
        time.sleep(0.05)
    raise AssertionError(f"expected {n} alerts, got {fake.app.state.ntfy}")


def _configure(client, fake, topic: str, events=None) -> None:
    body = {"url": f"{fake.url}/ntfy/{topic}", "token": "tk_secret"}
    if events is not None:
        body["events"] = events
    else:
        body["events"] = list(notify.DEFAULTS["events"])
    r = client.put("/api/notify", json=body)
    assert r.status_code == 200, r.text


def test_settings_and_test_alert(client, fake):
    state = client.get("/api/notify").json()
    assert state["url"] == "" and state["token_set"] is False and "train" in state["available"]
    assert client.post("/api/notify/test").status_code == 400  # nothing set yet
    assert client.put("/api/notify", json={"url": "ntfy.sh/x", "events": []}).status_code == 400
    assert client.put("/api/notify", json={"url": "https://ntfy.sh/x", "events": ["nope"]}).status_code == 400

    _configure(client, fake, "settings")
    state = client.get("/api/notify").json()
    assert state["token_set"] is True and "token" not in state  # the token never comes back
    before = len(fake.app.state.ntfy)
    assert client.post("/api/notify/test").json() == {"ok": True}
    sent = fake.app.state.ntfy[before]
    assert sent["topic"] == "settings" and sent["auth"] == "Bearer tk_secret"
    assert sent["params"]["title"] == "LLMCoach test alert" and "Alerts work" in sent["message"]

    # Leaving the token out keeps it; an empty string clears it.
    client.put("/api/notify", json={"url": f"{fake.url}/ntfy/settings", "events": ["train"]})
    assert client.get("/api/notify").json()["token_set"] is True
    client.put("/api/notify", json={"url": f"{fake.url}/ntfy/settings", "token": "", "events": ["train"]})
    assert client.get("/api/notify").json()["token_set"] is False

    bad = client.put("/api/notify", json={"url": "http://127.0.0.1:9/ntfy/x", "events": []})
    assert bad.status_code == 200
    assert client.post("/api/notify/test").status_code == 502


def test_job_alerts(client):
    pid = _project(client, "notify-jobs")
    now = utcnow()
    with Session(engine) as s:
        ft = FineTune(project_id=pid, name="Qwen on FAQ", base_model="Qwen/Qwen2.5-0.5B-Instruct",
                      status=FineTuneStatus.ready, metrics={"train_loss": 2.8431, "steps": 40})
        e = EvalRun(project_id=pid, name="FAQ eval", status="done",
                    summary={"base": {"f1": 0.21}, "base + knowledge base": {"f1": 0.44}})
        d = Dataset(project_id=pid, name="FAQ", status=DatasetStatus.ready, row_count=30)
        s.add_all([ft, e, d])
        s.commit()
        ft_id, e_id, d_id = ft.id, e.id, d.id
    ran = dict(started_at=now - timedelta(seconds=372), finished_at=now)

    event, title, message, priority, _ = job_alert(Job(id=1, kind="train", status=JobStatus.done, config={"finetune_id": ft_id}, **ran))
    assert event == "train" and title == "Training finished · Qwen on FAQ" and message == "loss 2.843, 40 steps in 6m 12s."
    event, _, message, _, _ = job_alert(Job(id=2, kind="evaluate", status=JobStatus.done, config={"eval_id": e_id}, **ran))
    assert event == "evaluate" and message.splitlines()[0] == "base + knowledge base: F1 0.44"  # best first
    event, _, message, _, _ = job_alert(Job(id=3, kind="generate", status=JobStatus.done, config={"dataset_id": d_id}, **ran))
    assert event == "generate" and "30 examples" in message
    event, title, message, priority, _ = job_alert(Job(id=4, kind="ingest", status=JobStatus.failed, config={},
                                                       error="Traceback...\nParseError: no text found", **ran))
    assert event == "failed" and title == "Indexing failed · job #4" and message == "ParseError: no text found" and priority == 4
    assert job_alert(Job(id=5, kind="train", status=JobStatus.cancelled, config={"finetune_id": ft_id}, **ran)) is None
    assert job_alert(Job(id=6, kind="ingest", status=JobStatus.done, config={}, **ran)) is None  # routine

    # A loop's own steps stay quiet: the loop sends one alert with its decision.
    with Session(engine) as s:
        s.add(LoopRun(project_id=pid, finetune_id=ft_id, eval_id=e_id))
        s.commit()
    assert job_alert(Job(id=7, kind="train", status=JobStatus.done, config={"finetune_id": ft_id}, **ran)) is None
    assert job_alert(Job(id=8, kind="evaluate", status=JobStatus.done, config={"eval_id": e_id}, **ran)) is None


def test_loop_and_review_alerts_respect_the_event_list(client, fake):
    pid = _project(client, "notify-loop")
    _configure(client, fake, "loop", events=["loop", "review"])
    with Session(engine) as s:
        run = LoopRun(project_id=pid)
        s.add(run)
        s.commit()
        before = len(fake.app.state.ntfy)
        loop_api._end(s, run, "promoted", "Scored F1 0.60 against 0.47 for the current adapter: promoted.")
    sent = _wait_for(fake, before + 1)[before]
    assert sent["params"]["title"].startswith("New adapter promoted") and "0.60 against 0.47" in sent["message"]
    with Session(engine) as s:
        run = LoopRun(project_id=pid)
        s.add(run)
        s.commit()
        loop_api._end(s, run, "skipped", "No new examples.")  # not news
    time.sleep(0.3)
    assert len(fake.app.state.ntfy) == before + 1

    src = _source(client, pid, "notify-review")
    _write(settings.inbox_root / "notify-review", "env.md", "api_key = " + "AKIA" + "ABCDEFGHIJKLMNOP")
    client.post(f"/api/projects/{pid}/sources/{src['id']}/scan")
    sent = _wait_for(fake, before + 2)[before + 1]
    assert sent["params"]["title"] == "1 file held for review" and "env.md" in sent["message"]
    assert "AKIA" not in sent["message"]  # the alert names the file, never the secret

    assert notify.send("train", "x", "y") is False  # not in this list
    client.put("/api/notify", json={"url": "", "events": ["train"]})
    assert notify.send("train", "x", "y") is False  # alerts off
