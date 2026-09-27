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
