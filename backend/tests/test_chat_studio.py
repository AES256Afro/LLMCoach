import io
import json

from tests.test_jobs import wait_final


def _text(n: int, topic: str) -> bytes:
    return "\n\n".join(f"{topic} section {i}. " + f"{topic} facts are useful for the support bot. " * 10
                       for i in range(n)).encode()


def test_empty_conversation_and_events(client):
    pid = client.post("/api/projects", json={"name": "studio-events"}).json()["id"]
    conv = client.post(f"/api/projects/{pid}/conversations", json={}).json()
    assert conv["title"] == "New chat" and conv["messages"] == []

    bad = client.post(f"/api/projects/{pid}/conversations/{conv['id']}/events", json={"text": "x", "data": {}})
    assert bad.status_code == 400  # needs a card type
    ev = client.post(f"/api/projects/{pid}/conversations/{conv['id']}/events",
                     json={"text": "Training started", "data": {"card": "train", "job_id": 7}}).json()
    assert ev["role"] == "event" and ev["data"] == {"card": "train", "job_id": 7}
    msgs = client.get(f"/api/projects/{pid}/conversations/{conv['id']}").json()["messages"]
    assert [m["role"] for m in msgs] == ["event"]


def test_remember_drop_indexes_files_and_text(client):
    pid = client.post("/api/projects", json={"name": "studio-remember"}).json()["id"]
    r = client.post(f"/api/projects/{pid}/chat/attach", data={"mode": "remember", "text": "Pasted note about zebras. " * 20,
                                                              "title": "zebra note"},
                    files=[("files", ("guide.md", io.BytesIO(_text(3, "Guide")), "text/markdown")),
                           ("files", ("tool.exe", io.BytesIO(b"MZ"), "application/octet-stream"))])
    assert r.status_code == 201, r.text
    out = r.json()
    card = out["message"]["data"]
    assert card["card"] == "attach" and card["mode"] == "remember" and card["learn"] is None
    assert {d["filename"] for d in card["documents"]} == {"guide.md", "zebra note.md"}
    assert card["skipped"][0]["reason"] == "unsupported file type"
    assert out["conversation"]["title"].startswith("Added 2 files")
    assert wait_final(client, card["ingest_job_id"])["status"] == "done"
    assert client.get(f"/api/projects/{pid}/knowledge").json()["documents"] == 2

    empty = client.post(f"/api/projects/{pid}/chat/attach", data={"mode": "remember"})
    assert empty.status_code == 400


def test_private_looking_files_are_held_back(client):
    pid = client.post("/api/projects", json={"name": "studio-held"}).json()["id"]
    contacts = "\n".join(f"Customer {i}: person{i}@example.com" for i in range(8)).encode() + b"\n\n" + _text(2, "CRM")
    r = client.post(f"/api/projects/{pid}/chat/attach", data={"mode": "learn", "model": "ollama/chatty:1b"},
                    files=[("files", ("contacts.md", io.BytesIO(contacts), "text/markdown")),
                           ("files", ("faq.md", io.BytesIO(_text(3, "FAQ")), "text/markdown"))])
    card = r.json()["message"]["data"]
    assert [d["filename"] for d in card["documents"]] == ["faq.md"]
    held = card["held"]
    assert [h["filename"] for h in held] == ["contacts.md"] and held[0]["findings"][0]["kind"] == "emails"
    wait_final(client, card["ingest_job_id"])
    wait_final(client, card["learn"]["job_id"])
    docs = {d["filename"]: d for d in client.get(f"/api/projects/{pid}/documents").json()}
    assert docs["contacts.md"]["status"] == "held"  # stored, but nothing can quote it
    assert docs["contacts.md"]["error"].startswith("Held back: may contain list of email addresses")
    assert docs["faq.md"]["status"] == "ready"

    # "Index anyway" is an ordinary re-index of that one document.
    job = client.post(f"/api/projects/{pid}/documents/reindex", json={"doc_ids": [held[0]["doc_id"]]}).json()
    assert wait_final(client, job["id"])["status"] == "done"
    docs = {d["filename"]: d for d in client.get(f"/api/projects/{pid}/documents").json()}
    assert docs["contacts.md"]["status"] == "ready"

    # Only held back, nothing else: the conversation title says so. The Classic upload holds too,
    # and check=false skips the check.
    only = client.post(f"/api/projects/{pid}/chat/attach", data={"mode": "remember"},
                       files=[("files", ("keys.md", io.BytesIO(b"password = hunter2hunter2\n" + _text(1, "Ops")), "text/markdown"))]).json()
    assert only["conversation"]["title"] == "Held back 1 file: it looks private"
    up = client.post(f"/api/projects/{pid}/documents", files=[("files", ("keys2.md", io.BytesIO(b"token: sk-" + b"a" * 40), "text/markdown"))]).json()
    assert up["job"] is None and up["held"][0]["filename"] == "keys2.md"
    assert client.delete(f"/api/projects/{pid}/documents/{up['held'][0]['doc_id']}").status_code == 204  # "Remove"
    free = client.post(f"/api/projects/{pid}/documents?check=false",
                       files=[("files", ("keys3.md", io.BytesIO(b"password = hunter3hunter3\n" + _text(1, "Ops2")), "text/markdown"))]).json()
    assert free["held"] == [] and free["job"] is not None
    wait_final(client, free["job"]["id"])


def test_review_drop_waits_for_the_owner(client, fake):
    pid = client.post("/api/projects", json={"name": "studio-review"}).json()["id"]
    r = client.post(f"/api/projects/{pid}/chat/attach", data={"mode": "review", "model": "ollama/chatty:1b"},
                    files=[("files", ("manual.md", io.BytesIO(_text(4, "Manual")), "text/markdown"))])
    out = r.json()
    learn = out["message"]["data"]["learn"]
    assert learn["review"] is True and learn["dataset_name"] == "To review: manual.md"
    assert out["conversation"]["title"] == "Added 1 file; writing practice Q&A for you to review"
    wait_final(client, out["message"]["data"]["ingest_job_id"])
    assert wait_final(client, learn["job_id"])["status"] == "done"
    staged = client.get(f"/api/projects/{pid}/datasets/{learn['dataset_id']}").json()
    assert staged["source"] == "review" and staged["row_count"] >= 3
    datasets = client.get(f"/api/projects/{pid}/datasets").json()
    assert not any(d["source"] == "chat" for d in datasets)  # nothing joined "Learned in chat" yet

    acc = client.post(f"/api/projects/{pid}/datasets/{learn['dataset_id']}/accept", json={"rows": [0, 2, 2, 99]}).json()
    assert acc["accepted"] == 2 and acc["discarded"] == staged["row_count"] - 2
    assert acc["dataset"]["name"] == "Learned in chat" and acc["dataset"]["row_count"] == 2
    assert sum(acc["dataset"]["splits"].values()) == 2
    assert client.get(f"/api/projects/{pid}/datasets/{learn['dataset_id']}").status_code == 404
    # Only review datasets can be accepted.
    assert client.post(f"/api/projects/{pid}/datasets/{acc['dataset']['id']}/accept", json={"rows": [0]}).status_code == 409


def test_learn_drop_appends_and_keeps_splits(client, fake):
    pid = client.post("/api/projects", json={"name": "studio-learn"}).json()["id"]
    first = client.post(f"/api/projects/{pid}/chat/attach", data={"mode": "learn", "model": "ollama/chatty:1b"},
                        files=[("files", ("a.md", io.BytesIO(_text(6, "Alpha")), "text/markdown"))]).json()
    conv_id = first["conversation"]["id"]
    card = first["message"]["data"]
    assert card["learn"]["dataset_name"] == "Learned in chat"
    wait_final(client, card["ingest_job_id"])
    assert wait_final(client, card["learn"]["job_id"])["status"] == "done"
    ds_id = card["learn"]["dataset_id"]
    d1 = client.get(f"/api/projects/{pid}/datasets/{ds_id}").json()
    assert d1["status"] == "ready" and d1["source"] == "chat" and d1["row_count"] > 0
    rows1 = client.get(f"/api/projects/{pid}/datasets/{ds_id}/rows", params={"limit": 500}).json()["rows"]
    split_of = {json.dumps(r["messages"]): r["split"] for r in rows1}

    # A second drop into the same conversation appends to the same dataset.
    second = client.post(f"/api/projects/{pid}/chat/attach",
                         data={"mode": "learn", "conversation_id": str(conv_id), "model": "ollama/chatty:1b"},
                         files=[("files", ("b.md", io.BytesIO(_text(6, "Beta")), "text/markdown"))]).json()
    assert second["conversation"]["id"] == conv_id
    assert second["message"]["data"]["learn"]["dataset_id"] == ds_id
    wait_final(client, second["message"]["data"]["ingest_job_id"])
    wait_final(client, second["message"]["data"]["learn"]["job_id"])
    d2 = client.get(f"/api/projects/{pid}/datasets/{ds_id}").json()
    assert d2["row_count"] > d1["row_count"]
    rows2 = client.get(f"/api/projects/{pid}/datasets/{ds_id}/rows", params={"limit": 500}).json()["rows"]
    for r in rows2:
        key = json.dumps(r["messages"])
        if key in split_of:
            assert r["split"] == split_of[key]  # earlier rows never change split
    assert sum(d2["splits"].values()) == d2["row_count"]

    # Dropping a file that's already there still learns from it.
    again = client.post(f"/api/projects/{pid}/chat/attach", data={"mode": "learn", "conversation_id": str(conv_id),
                                                                  "model": "ollama/chatty:1b"},
                        files=[("files", ("a-copy.md", io.BytesIO(_text(6, "Alpha")), "text/markdown"))]).json()
    data = again["message"]["data"]
    assert data["documents"] == [] and data["ingest_job_id"] is None and data["learn"]
    assert again["message"]["content"].startswith("Learning from 1 file already")
    wait_final(client, data["learn"]["job_id"])

    # Events never reach the model.
    fake.app.state.chat_bodies.clear()
    lines = client.post(f"/api/projects/{pid}/chat", json={"message": "hi", "conversation_id": conv_id,
                                                          "model": "ollama/chatty:1b", "use_rag": False}).text
    assert '"type": "done"' in lines
    sent = fake.app.state.chat_bodies[-1]["messages"]
    assert [m["role"] for m in sent] == ["system", "user"]


def test_learn_from_whole_knowledge_base(client):
    pid = client.post("/api/projects", json={"name": "studio-learn-kb"}).json()["id"]
    assert client.post(f"/api/projects/{pid}/chat/learn", json={"model": "ollama/chatty:1b"}).status_code == 400
    up = client.post(f"/api/projects/{pid}/chat/attach", data={"mode": "remember"},
                     files=[("files", ("kb.md", io.BytesIO(_text(4, "Gamma")), "text/markdown"))]).json()
    wait_final(client, up["message"]["data"]["ingest_job_id"])
    r = client.post(f"/api/projects/{pid}/chat/learn", json={"model": "ollama/chatty:1b", "max_chunks": 3,
                                                              "conversation_id": up["conversation"]["id"]})
    assert r.status_code == 201, r.text
    card = r.json()["message"]["data"]
    assert card["card"] == "learn"
    assert wait_final(client, card["learn"]["job_id"])["status"] == "done"


def test_training_options_recommend_a_base_model(client):
    opts = client.get("/api/training/options").json()
    assert opts["recommended_base_model"] in {m["id"] for m in opts["base_models"]}


def test_failed_learn_keeps_what_was_already_learned(client, fake):
    """A learn run on a document that never got indexed (say its indexing job was cut short by a
    restart) must fail without emptying the dataset it appends to."""
    from sqlmodel import Session

    from app.api.datasets import learn_into_chat_dataset
    from app.db import Document, DocStatus, Project, engine

    pid = client.post("/api/projects", json={"name": "studio-learn-keep"}).json()["id"]
    first = client.post(f"/api/projects/{pid}/chat/attach", data={"mode": "learn", "model": "ollama/chatty:1b"},
                        files=[("files", ("a.md", io.BytesIO(_text(6, "Alpha")), "text/markdown"))]).json()
    card = first["message"]["data"]
    wait_final(client, card["ingest_job_id"])
    wait_final(client, card["learn"]["job_id"])
    ds_id = card["learn"]["dataset_id"]
    before = client.get(f"/api/projects/{pid}/datasets/{ds_id}").json()
    assert before["row_count"] > 0

    with Session(engine) as s:
        doc = Document(project_id=pid, filename="big.pdf", path="", sha256="x" * 64, status=DocStatus.failed)
        s.add(doc)
        s.commit()
        _, job = learn_into_chat_dataset(s, s.get(Project, pid), "ollama/chatty:1b", [doc.id], max_chunks=8)
        job_id = job.id
    assert wait_final(client, job_id)["status"] == "failed"
    after = client.get(f"/api/projects/{pid}/datasets/{ds_id}").json()
    assert after["row_count"] == before["row_count"] and after["status"] == "ready"
    assert after["splits"] == before["splits"]
    rows = client.get(f"/api/projects/{pid}/datasets/{ds_id}/rows", params={"limit": 500}).json()
    assert rows["total"] == before["row_count"]
