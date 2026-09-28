import io
import os
import time
from datetime import timedelta
from pathlib import Path

import pytest
from sqlmodel import Session, select

from app.api import loop as loop_api
from app.config import settings
from app.db import Dataset, DatasetStatus, EvalRun, FineTune, FineTuneStatus, Job, JobStatus, LearningLoop, LoopRun, engine, utcnow
from app.services import scan
from tests.test_jobs import wait_final

AWS = "AKIA" + "ABCDEFGHIJKLMNOP"  # split so this file doesn't trip secret scanners itself


def _text(topic: str, n: int = 3) -> str:
    return "\n\n".join(f"{topic} section {i}. " + f"{topic} facts help the support bot answer. " * 8 for i in range(n))


def _write(folder: Path, name: str, body: str, age: float = 120) -> Path:
    path = folder / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    t = time.time() - age
    os.utime(path, (t, t))
    return path


def _project(client, name: str) -> int:
    return client.post("/api/projects", json={"name": name}).json()["id"]


def _source(client, pid: int, folder: str, **kw) -> dict:
    r = client.post(f"/api/projects/{pid}/sources", json={"folder": folder, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def _files(client, pid: int, sid: int) -> dict[str, dict]:
    return {f["relpath"]: f for f in client.get(f"/api/projects/{pid}/sources/{sid}/files").json()["files"]}


# ---- scanner ---------------------------------------------------------------------------------

def test_scanner_finds_secrets_and_masks_them():
    found = {f.kind: f for f in scan.scan_text(f"aws = {AWS}\npassword: hunter2hunter2\nnothing here")}
    assert set(found) == {"aws_key", "assigned_secret"}
    assert found["aws_key"].sample == "AKIA…OP" and AWS not in found["aws_key"].sample
    assert found["assigned_secret"].category == scan.SECRET
    # Placeholders in docs aren't secrets.
    assert scan.scan_text("password: <your-password>\napi_key = ${API_KEY}") == []


def test_scanner_personal_data_thresholds():
    one_email = "Questions? Write to help@example.com."
    assert scan.scan_text(one_email) == []
    contacts = "\n".join(f"person{i}@example.com" for i in range(6))
    assert [f.kind for f in scan.scan_text(contacts)] == ["emails"]
    assert scan.scan_text(contacts, personal=False) == []
    card = "Card: 4111 1111 1111 1111"  # a Luhn-valid test number
    assert [f.kind for f in scan.scan_text(card)] == ["card"]
    assert scan.scan_text("Order 4111 1111 1111 1112") == []  # fails the Luhn check
    assert [f.kind for f in scan.scan_text("SSN 123-45-6789")] == ["ssn"]


# ---- sources ---------------------------------------------------------------------------------

def test_source_folders_stay_inside_the_inbox(client):
    pid = _project(client, "inbox-folders")
    for bad in ("../etc", "/etc", "C:/Windows", "a/../../b", ".secret"):
        r = client.post(f"/api/projects/{pid}/sources", json={"folder": bad})
        assert r.status_code == 400, bad
    src = _source(client, pid, "folders-test/team")
    assert src["folder"] == "folders-test/team" and src["mode"] == "remember" and src["scan"] == "all"
    assert (settings.inbox_root / "folders-test" / "team").is_dir()
    # Nested folders would read the same files twice.
    assert client.post(f"/api/projects/{pid}/sources", json={"folder": "folders-test"}).status_code == 409
    assert client.post(f"/api/projects/{pid}/sources", json={"folder": "folders-test/team/sub"}).status_code == 409
    assert client.post(f"/api/projects/{pid}/sources", json={"folder": "folders-test/team", "mode": "x"}).status_code == 400
    info = client.get("/api/inbox").json()
    assert info["root"] == str(settings.inbox_root) and ".md" in info["supported"]


def test_poll_adds_skips_and_quarantines(client):
    pid = _project(client, "inbox-poll")
    src = _source(client, pid, "poll")
    root = settings.inbox_root / "poll"
    _write(root, "guide.md", _text("Guide"))
    _write(root, "sub/faq.txt", _text("Faq"))
    _write(root, "copy-of-guide.md", _text("Guide"))
    _write(root, "tool.exe", "MZ")
    _write(root, "keys.md", f"# Deploy notes\n\nThe key is {AWS}.")
    _write(root, "~$lock.docx", "temp")  # an editor's lock file is never looked at
    _write(root, "fresh.md", _text("Fresh"), age=0)  # still being written, as far as anyone knows

    out = client.post(f"/api/projects/{pid}/sources/{src['id']}/scan").json()
    files = _files(client, pid, src["id"])
    assert "~$lock.docx" not in files
    assert files["sub/faq.txt"]["status"] == "added"
    # Two copies of one file (whichever is read first is added): the knowledge base keeps one.
    assert sorted(f["status"] for n, f in files.items() if "guide" in n) == ["added", "duplicate"]
    assert files["guide.md"]["doc_id"] == files["copy-of-guide.md"]["doc_id"]
    assert files["tool.exe"]["status"] == "skipped"
    keys = files["keys.md"]
    assert keys["status"] == "quarantined" and keys["doc_id"] is None
    assert keys["findings"][0]["kind"] == "aws_key" and AWS not in str(keys["findings"])
    assert files["fresh.md"]["status"] == "waiting" and out["waiting"] == 1
    assert wait_final(client, out["ingest_job_id"])["status"] == "done"
    assert client.get(f"/api/projects/{pid}/knowledge").json()["documents"] == 2

    listed = client.get(f"/api/projects/{pid}/sources").json()[0]
    assert listed["counts"]["added"] == 2 and listed["counts"]["quarantined"] == 1

    # The waiting file is read once it has stopped changing.
    os.utime(root / "fresh.md", (time.time() - 10, time.time() - 10))
    client.post(f"/api/projects/{pid}/sources/{src['id']}/scan")  # sees it changed: waits again
    assert _files(client, pid, src["id"])["fresh.md"]["status"] == "waiting"
    out = client.post(f"/api/projects/{pid}/sources/{src['id']}/scan").json()
    assert _files(client, pid, src["id"])["fresh.md"]["status"] == "added"
    wait_final(client, out["ingest_job_id"])


def test_review_queue_approve_and_reject(client):
    pid = _project(client, "inbox-review")
    src = _source(client, pid, "review")
    root = settings.inbox_root / "review"
    _write(root, "a.md", f"Setup notes.\n\napi_key = {AWS}")
    _write(root, "b.md", "\n".join(f"user{i}@example.com wrote in about billing" for i in range(8)))
    client.post(f"/api/projects/{pid}/sources/{src['id']}/scan")
    queue = client.get(f"/api/projects/{pid}/inbox/review").json()
    assert sorted(q["relpath"] for q in queue) == ["a.md", "b.md"] and queue[0]["source_name"] == "review"
    by_name = {q["relpath"]: q for q in queue}

    r = client.post(f"/api/projects/{pid}/inbox/files/{by_name['b.md']['id']}/approve").json()
    assert r["file"]["status"] == "added" and r["file"]["reviewed_at"] and r["ingest_job_id"]
    wait_final(client, r["ingest_job_id"])
    rej = client.post(f"/api/projects/{pid}/inbox/files/{by_name['a.md']['id']}/reject").json()
    assert rej["status"] == "rejected"
    assert client.get(f"/api/projects/{pid}/inbox/review").json() == []
    assert client.post(f"/api/projects/{pid}/inbox/files/{by_name['b.md']['id']}/reject").status_code == 409

    # A scan set to secrets only lets a contact list through.
    src2 = _source(client, pid, "review-secrets-only", scan="secrets")
    _write(settings.inbox_root / "review-secrets-only", "contacts.md", "\n".join(f"p{i}@example.com" for i in range(8)))
    out = client.post(f"/api/projects/{pid}/sources/{src2['id']}/scan").json()
    assert _files(client, pid, src2["id"])["contacts.md"]["status"] == "added"
    wait_final(client, out["ingest_job_id"])


def test_changed_file_replaces_its_document(client):
    pid = _project(client, "inbox-replace")
    src = _source(client, pid, "replace")
    root = settings.inbox_root / "replace"
    path = _write(root, "policy.md", _text("Policy v1"))
    out = client.post(f"/api/projects/{pid}/sources/{src['id']}/scan").json()
    wait_final(client, out["ingest_job_id"])
    old = _files(client, pid, src["id"])["policy.md"]["doc_id"]

    path.write_text(_text("Policy v2, rewritten"), encoding="utf-8")
    os.utime(path, (time.time() - 60, time.time() - 60))
    client.post(f"/api/projects/{pid}/sources/{src['id']}/scan")  # notices the change
    out = client.post(f"/api/projects/{pid}/sources/{src['id']}/scan").json()  # reads the new version
    new = _files(client, pid, src["id"])["policy.md"]
    assert new["status"] == "added" and new["doc_id"] != old
    wait_final(client, out["ingest_job_id"])
    docs = client.get(f"/api/projects/{pid}/documents").json()
    assert [d["id"] for d in docs] == [new["doc_id"]]  # the old version is gone

    # Touched but unchanged: nothing new.
    os.utime(path, (time.time() - 30, time.time() - 30))
    client.post(f"/api/projects/{pid}/sources/{src['id']}/scan")
    client.post(f"/api/projects/{pid}/sources/{src['id']}/scan")
    assert _files(client, pid, src["id"])["policy.md"]["doc_id"] == new["doc_id"]
    assert len(client.get(f"/api/projects/{pid}/documents").json()) == 1


def test_deleted_files_are_kept_or_forgotten(client, monkeypatch):
    from app.api import inbox as inbox_api

    pid = _project(client, "inbox-deletes")
    keep = _source(client, pid, "deletes-keep")
    mirror = _source(client, pid, "deletes-mirror", mirror_deletes=True)
    assert mirror["mirror_deletes"] is True and keep["mirror_deletes"] is False
    kroot, mroot = settings.inbox_root / "deletes-keep", settings.inbox_root / "deletes-mirror"
    a = _write(kroot, "a.md", _text("Alpha"))
    b = _write(mroot, "b.md", _text("Bravo"))
    c = _write(mroot, "c.md", _text("Charlie"))
    stay = _write(mroot, "stay.md", _text("Echo"))
    keys = _write(mroot, "keys.md", f"aws = {AWS}\n" + _text("Delta"))
    scan_ = lambda src: client.post(f"/api/projects/{pid}/sources/{src['id']}/scan").json()  # noqa: E731
    wait_final(client, scan_(mirror)["ingest_job_id"])
    _write(kroot, "copy-of-b.md", _text("Bravo"))  # the same content in the other folder: a duplicate
    wait_final(client, scan_(keep)["ingest_job_id"])
    assert _files(client, pid, keep["id"])["copy-of-b.md"]["status"] == "duplicate"
    docs = lambda: sorted(d["filename"] for d in client.get(f"/api/projects/{pid}/documents").json())  # noqa: E731
    assert docs() == ["a.md", "b.md", "c.md", "stay.md"]

    for p in (a, b, c, keys):
        p.unlink()
    scan_(keep)
    assert _files(client, pid, keep["id"])["a.md"]["status"] == "gone"  # this folder doesn't mirror deletions
    scan_(mirror)
    files = _files(client, pid, mirror["id"])
    assert "keys.md" not in files  # nothing came of it, so its row just goes
    assert client.get(f"/api/projects/{pid}/inbox/review").json() == []
    assert files["c.md"]["status"] == "added" and files["c.md"]["missing_at"]  # one look isn't enough
    monkeypatch.setattr(inbox_api, "FORGET_AFTER_SECONDS", 0)
    scan_(mirror)
    files = _files(client, pid, mirror["id"])
    assert files["c.md"]["status"] == "forgotten" and files["c.md"]["doc_id"] is None
    # b.md's document lives on: copy-of-b.md, still in a watched folder, holds the same content.
    assert files["b.md"]["status"] == "gone"
    assert _files(client, pid, keep["id"])["copy-of-b.md"]["status"] == "added"
    assert docs() == ["a.md", "b.md", "stay.md"]

    # Put back: read again, and the kept document is recognised rather than added twice.
    old = _files(client, pid, keep["id"])["a.md"]["doc_id"]
    _write(kroot, "a.md", _text("Alpha"))
    scan_(keep)
    back = _files(client, pid, keep["id"])["a.md"]
    assert back["status"] == "added" and back["doc_id"] == old and docs() == ["a.md", "b.md", "stay.md"]

    # An empty folder is most likely an unmounted share: nothing is removed.
    stay.unlink()
    scan_(mirror)
    scan_(mirror)
    assert _files(client, pid, mirror["id"])["stay.md"]["status"] == "added"
    src = next(x for x in client.get(f"/api/projects/{pid}/sources").json() if x["id"] == mirror["id"])
    assert "looks empty" in src["last_error"] and "stay.md" in docs()


def test_upload_into_a_learning_source(client):
    pid = _project(client, "inbox-upload")
    src = _source(client, pid, "upload", mode="learn")
    body = _text("Harbor", 6).encode()
    r = client.post(f"/api/projects/{pid}/sources/{src['id']}/upload",
                    files=[("files", ("harbor.md", io.BytesIO(body), "text/markdown"))])
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["written"] == ["harbor.md"] and out["processed"] == {"added": 1}
    assert (settings.inbox_root / "upload" / "harbor.md").read_bytes() == body
    wait_final(client, out["ingest_job_id"])
    assert wait_final(client, out["learn_job_id"])["status"] == "done"
    d = client.get(f"/api/projects/{pid}/datasets/{out['dataset_id']}").json()
    assert d["name"] == "Learned from the inbox" and d["source"] == "inbox" and d["row_count"] > 0

    again = client.post(f"/api/projects/{pid}/sources/{src['id']}/upload",
                        files=[("files", ("harbor.md", io.BytesIO(body), "text/markdown"))]).json()
    assert again["written"] == [] and again["unchanged"] == ["harbor.md"]
    other = client.post(f"/api/projects/{pid}/sources/{src['id']}/upload",
                        files=[("files", ("harbor.md", io.BytesIO(b"# Other\n\n" + body), "text/markdown"))]).json()
    assert other["written"] == ["harbor (2).md"]  # never overwrites a different file


def test_delete_source_and_project(client):
    pid = _project(client, "inbox-delete")
    src = _source(client, pid, "delete-me")
    _write(settings.inbox_root / "delete-me", "a.md", _text("A"))
    out = client.post(f"/api/projects/{pid}/sources/{src['id']}/scan").json()
    wait_final(client, out["ingest_job_id"])
    assert client.delete(f"/api/projects/{pid}/sources/{src['id']}").status_code == 204
    assert client.get(f"/api/projects/{pid}/sources").json() == []
    assert len(client.get(f"/api/projects/{pid}/documents").json()) == 1  # stays in the knowledge base
    assert (settings.inbox_root / "delete-me" / "a.md").exists()  # and on disk
    _source(client, pid, "delete-me-too")
    client.put(f"/api/projects/{pid}/loop", json={"enabled": True})
    assert client.delete(f"/api/projects/{pid}").status_code == 204


# ---- tokens ------------------------------------------------------------------------------------

def test_tokens_are_shown_once_and_scoped(client, monkeypatch):
    pid = _project(client, "inbox-tokens")
    src = _source(client, pid, "tokens")
    made = client.post("/api/tokens", json={"name": "scanner script"}).json()
    token = made["token"]
    assert token.startswith("lc_") and made["scope"] == "inbox" and "token_hash" not in made
    listed = client.get("/api/tokens").json()
    assert all("token" not in t and "token_hash" not in t for t in listed)
    assert any(t["prefix"] == token[:10] for t in listed)
    full = client.post("/api/tokens", json={"name": "admin", "scope": "full"}).json()["token"]
    assert client.post("/api/tokens", json={"name": " "}).status_code == 400

    monkeypatch.setattr(settings, "password", "pw")  # turn sign-in on
    bearer = {"Authorization": f"Bearer {token}"}
    assert client.get(f"/api/projects/{pid}/documents").status_code == 401
    assert client.get(f"/api/projects/{pid}/documents", headers=bearer).status_code == 401  # outside its scope
    assert client.get(f"/api/projects/{pid}/sources", headers=bearer).status_code == 200
    up = client.post(f"/api/projects/{pid}/sources/{src['id']}/upload", headers=bearer,
                     files=[("files", ("note.md", io.BytesIO(_text("Note").encode()), "text/markdown"))])
    assert up.status_code == 200 and up.json()["written"] == ["note.md"]
    assert client.get("/api/tokens", headers=bearer).status_code == 401
    full_bearer = {"Authorization": f"Bearer {full}"}
    assert client.get(f"/api/projects/{pid}/documents", headers=full_bearer).status_code == 200
    assert client.get("/api/tokens", headers=full_bearer).status_code == 401  # tokens never manage tokens
    assert client.get(f"/api/projects/{pid}/sources", headers={"Authorization": "Bearer lc_wrong"}).status_code == 401
    monkeypatch.setattr(settings, "password", "")

    wait_final(client, up.json()["ingest_job_id"])
    assert client.delete(f"/api/tokens/{made['id']}").status_code == 204
    assert all(t["id"] != made["id"] for t in client.get("/api/tokens").json())


# ---- learning loop ------------------------------------------------------------------------------

def _dataset(pid: int, rows: int, test: int, source: str = "inbox") -> int:
    with Session(engine) as s:
        d = Dataset(project_id=pid, name="Learned from the inbox", source=source, status=DatasetStatus.ready,
                    row_count=rows, splits={"train": rows - test, "val": 0, "test": test})
        s.add(d)
        s.commit()
        return d.id


def _ready_ft(pid: int, name: str) -> int:
    with Session(engine) as s:
        ft = FineTune(project_id=pid, name=name, base_model="Qwen/Qwen2.5-0.5B-Instruct", status=FineTuneStatus.ready)
        s.add(ft)
        s.commit()
        return ft.id


def _eval_outcome(pid: int, run_id: int, summary: dict) -> dict:
    """Plays a finished evaluation for a run into the loop's after-hook and returns the run."""
    with Session(engine) as s:
        e = EvalRun(project_id=pid, name="loop", status="done", summary=summary)
        s.add(e)
        s.commit()
        run = s.get(LoopRun, run_id)
        run.eval_id, run.status = e.id, "evaluating"
        s.add(run)
        s.commit()
        job = Job(kind="evaluate", status=JobStatus.done, config={"eval_id": e.id})
    loop_api._after_eval(job)
    with Session(engine) as s:
        return s.get(LoopRun, run_id).model_dump()


def test_loop_skips_until_there_is_something_to_judge(client):
    pid = _project(client, "loop-skips")
    state = client.get(f"/api/projects/{pid}/loop").json()
    assert state["loop"]["enabled"] is False and state["dataset"] is None and state["recommended_base_model"]
    r = client.post(f"/api/projects/{pid}/loop/run").json()
    assert r["status"] == "skipped" and "nothing to learn from" in r["reason"]
    _dataset(pid, rows=4, test=0)
    r = client.post(f"/api/projects/{pid}/loop/run").json()
    assert r["status"] == "skipped" and "no test questions" in r["reason"]

    assert client.put(f"/api/projects/{pid}/loop", json={"hour_utc": 24}).status_code == 400
    assert client.put(f"/api/projects/{pid}/loop", json={"preset": "nope"}).status_code == 400
    state = client.put(f"/api/projects/{pid}/loop", json={"enabled": True, "hour_utc": 2, "minute": 30, "margin": 0.02}).json()
    loop = state["loop"]
    assert loop["enabled"] and loop["next_run_at"] and loop["margin"] == 0.02
    assert len(state["runs"]) == 2


def test_loop_promotes_only_a_better_adapter(client):
    pid = _project(client, "loop-gate")
    ds_id = _dataset(pid, rows=40, test=5)
    current, first, better, worse = (_ready_ft(pid, n) for n in ("current", "first", "better", "worse"))
    with Session(engine) as s:
        runs = []
        for ft, base in ((first, None), (better, current), (worse, current)):
            run = LoopRun(project_id=pid, dataset_id=ds_id, rows=40, finetune_id=ft, baseline_finetune_id=base)
            s.add(run)
            s.commit()
            runs.append(run.id)

    r = _eval_outcome(pid, runs[0], {"New adapter": {"f1": 0.31}})
    assert r["status"] == "promoted" and "first adapter" in r["reason"]
    state = client.get(f"/api/projects/{pid}/loop").json()
    assert [f["id"] for f in state["registry"] if f["promoted_at"]] == [first]
    assert state["loop"]["last_rows"] == 40

    client.put(f"/api/projects/{pid}/loop", json={"margin": 0.05})
    r = _eval_outcome(pid, runs[2], {"New adapter": {"f1": 0.50}, "Current adapter": {"f1": 0.47}})
    assert r["status"] == "kept" and "0.50 against 0.47" in r["reason"] and "0.05" in r["reason"]
    r = _eval_outcome(pid, runs[1], {"New adapter": {"f1": 0.60}, "Current adapter": {"f1": 0.47}})
    assert r["status"] == "promoted" and r["candidate_f1"] == 0.60 and r["baseline_f1"] == 0.47
    state = client.get(f"/api/projects/{pid}/loop").json()
    assert [f["id"] for f in state["registry"] if f["promoted_at"]] == [better]

    # By hand, too.
    state = client.post(f"/api/projects/{pid}/finetunes/{current}/promote").json()
    assert [f["id"] for f in state["registry"] if f["promoted_at"]] == [current]
    state = client.post(f"/api/projects/{pid}/finetunes/{current}/demote").json()
    assert not any(f["promoted_at"] for f in state["registry"])


def test_loop_keeps_a_current_model_in_ollama(client, monkeypatch):
    submitted = []
    # Record the export instead of running it: the worker would merge a real base model.
    monkeypatch.setattr(loop_api, "submit_export", lambda s, pid, ft, name, quantize="q8_0": submitted.append((ft.id, name)))
    pid = _project(client, "Loop Export")
    ds_id = _dataset(pid, rows=40, test=5)
    first = _ready_ft(pid, "first")
    with Session(engine) as s:
        ft = s.get(FineTune, first)
        ft.output_dir = f"finetunes/{first}/adapter"
        s.add(ft)
        run = LoopRun(project_id=pid, dataset_id=ds_id, rows=40, finetune_id=first)
        s.add(run)
        s.commit()
        run_id = run.id
    state = client.put(f"/api/projects/{pid}/loop", json={"export_on_promote": True}).json()
    assert state["loop"]["export_on_promote"] is True and state["current_model"] == "ollama/llmcoach-loop-export-current"
    r = _eval_outcome(pid, run_id, {"New adapter": {"f1": 0.4}})
    assert r["status"] == "promoted" and r["reason"].endswith("Rebuilding ollama/llmcoach-loop-export-current from it.")
    assert submitted == [(first, "llmcoach-loop-export-current")]
    client.post(f"/api/projects/{pid}/finetunes/{first}/promote")  # promoting by hand rebuilds it too
    assert len(submitted) == 2
    client.put(f"/api/projects/{pid}/loop", json={"export_on_promote": False})
    client.post(f"/api/projects/{pid}/finetunes/{first}/promote")
    assert len(submitted) == 2


def test_loop_failed_training_ends_the_run(client):
    pid = _project(client, "loop-fail")
    ft = _ready_ft(pid, "broken")
    with Session(engine) as s:
        f = s.get(FineTune, ft)
        f.status, f.error = FineTuneStatus.failed, "out of memory"
        s.add(f)
        run = LoopRun(project_id=pid, finetune_id=ft)
        s.add(run)
        s.commit()
        run_id = run.id
    loop_api._after_train(Job(kind="train", status=JobStatus.failed, config={"finetune_id": ft}))
    with Session(engine) as s:
        run = s.get(LoopRun, run_id)
        assert run.status == "failed" and "out of memory" in run.reason


@pytest.mark.anyio
async def test_scheduler_starts_due_runs_once(client):
    pid = _project(client, "loop-schedule")
    client.put(f"/api/projects/{pid}/loop", json={"enabled": True, "hour_utc": 3})
    now = utcnow()
    with Session(engine) as s:
        loop = loop_api.get_loop(s, pid)
        loop.next_run_at = now - timedelta(minutes=1)
        s.add(loop)
        s.commit()
    await loop_api.scheduler_tick(now)
    state = client.get(f"/api/projects/{pid}/loop").json()
    assert [r["trigger"] for r in state["runs"]] == ["schedule"]  # skipped: nothing to learn from yet
    await loop_api.scheduler_tick(now)
    assert len(client.get(f"/api/projects/{pid}/loop").json()["runs"]) == 1  # not again until tomorrow
    with Session(engine) as s:
        nxt = loop_api._aware(s.exec(select(LearningLoop).where(LearningLoop.project_id == pid)).first().next_run_at)
    assert nxt > now and nxt.hour == 3


def test_next_occurrence():
    base = utcnow().replace(hour=10, minute=0, second=0, microsecond=0)
    assert loop_api.next_occurrence(11, 0, base) == base.replace(hour=11)
    assert loop_api.next_occurrence(9, 0, base) == base.replace(hour=9) + timedelta(days=1)
    assert loop_api.next_occurrence(10, 0, base) == base + timedelta(days=1)


@pytest.mark.anyio
async def test_watcher_does_not_wait_for_a_slow_source(client, monkeypatch):
    import asyncio

    from app.api import inbox as inbox_api

    pid = _project(client, "parallel-polls")
    a, b = _source(client, pid, "par-a"), _source(client, pid, "par-b")
    started: list[int] = []
    release = asyncio.Event()

    async def slow(source_id: int) -> dict:  # a source reading a long recording
        started.append(source_id)
        await release.wait()
        return {}

    monkeypatch.setattr(inbox_api, "poll_source", slow)
    await asyncio.wait_for(inbox_api._tick(), 2)  # the tick returns at once
    await asyncio.sleep(0)
    assert {a["id"], b["id"]} <= set(started)
    await inbox_api._tick()  # still reading: not started a second time
    assert started.count(a["id"]) == 1 and started.count(b["id"]) == 1
    release.set()
    await asyncio.sleep(0.05)
    assert a["id"] not in inbox_api._polling and b["id"] not in inbox_api._polling
