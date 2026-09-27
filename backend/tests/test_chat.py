import io
import json

from tests.test_jobs import wait_final


def chat(client, pid, **body):
    r = client.post(f"/api/projects/{pid}/chat", json=body)
    assert r.status_code == 200, r.text
    return [json.loads(line) for line in r.text.splitlines() if line.strip()]


def test_chat_with_rag_streams_and_saves(client, fake):
    pid = client.post("/api/projects", json={"name": "chat-rag"}).json()["id"]
    up = client.post(f"/api/projects/{pid}/documents",
                     files=[("files", ("zoo.txt", io.BytesIO(b"zebras zigzag in the zoo. " * 20), "text/plain"))]).json()
    assert wait_final(client, up["job"]["id"])["status"] == "done"

    events = chat(client, pid, message="Where do zebras zigzag?")
    meta, *mid, done = events
    assert meta["type"] == "meta" and meta["model"] == "ollama/chatty:1b"  # smallest chat model, not the embedder
    assert meta["sources"] and meta["sources"][0]["filename"] == "zoo.txt"
    assert "".join(e["text"] for e in mid if e["type"] == "delta") == "Hello from the fake."
    assert done["type"] == "done" and done["message"]["content"] == "Hello from the fake."
    assert done["message"]["stats"]["completion_tokens"] == 4 and done["message"]["sources"]

    sent = fake.app.state.chat_bodies[-1]["messages"]
    assert sent[0]["role"] == "system" and "[1] (zoo.txt)" in sent[0]["content"] and "Cite" in sent[0]["content"]
    assert sent[-1] == {"role": "user", "content": "Where do zebras zigzag?"}

    conv_id = meta["conversation"]["id"]
    assert meta["conversation"]["title"] == "Where do zebras zigzag?"

    # Second turn: history goes along, RAG switched off.
    events = chat(client, pid, message="Thanks!", conversation_id=conv_id, use_rag=False)
    assert events[0]["sources"] is None
    sent = fake.app.state.chat_bodies[-1]["messages"]
    assert [m["role"] for m in sent] == ["system", "user", "assistant", "user"]
    assert "Context:" not in sent[0]["content"]

    conv = client.get(f"/api/projects/{pid}/conversations/{conv_id}").json()
    assert [m["role"] for m in conv["messages"]] == ["user", "assistant", "user", "assistant"]
    assert conv["use_rag"] is False
    assert [c["id"] for c in client.get(f"/api/projects/{pid}/conversations").json()] == [conv_id]

    assert client.delete(f"/api/projects/{pid}/conversations/{conv_id}").status_code == 204
    assert client.delete(f"/api/projects/{pid}").status_code == 204


def test_chat_without_documents_skips_retrieval(client, fake):
    pid = client.post("/api/projects", json={"name": "chat-plain"}).json()["id"]
    events = chat(client, pid, message="hi", model="ollama/chatty:1b", system_prompt="Talk like a pirate.")
    assert events[0]["sources"] is None and events[-1]["type"] == "done"
    assert fake.app.state.chat_bodies[-1]["messages"][0]["content"] == "Talk like a pirate."


def test_chat_unknown_provider_is_rejected(client):
    pid = client.post("/api/projects", json={"name": "chat-bad"}).json()["id"]
    client.post("/api/providers", json={"preset": "custom", "name": "Off", "base_url": "http://127.0.0.1:1/v1"})
    off = next(p for p in client.get("/api/providers").json() if p["slug"] == "off")
    client.patch(f"/api/providers/{off['id']}", json={"enabled": False})
    r = client.post(f"/api/projects/{pid}/chat", json={"message": "hi", "model": "off/some-model"})
    assert r.status_code == 400 and "disabled" in r.json()["detail"]
    client.delete(f"/api/providers/{off['id']}")


def test_chat_provider_error_is_streamed(client):
    pid = client.post("/api/projects", json={"name": "chat-down"}).json()["id"]
    p = client.post("/api/providers", json={"preset": "custom", "name": "Down", "base_url": "http://127.0.0.1:1/v1"}).json()
    events = chat(client, pid, message="hi", model="down/m")
    assert events[-1]["type"] == "error" and "ConnectError" in events[-1]["message"]
    conv = client.get(f"/api/projects/{pid}/conversations/{events[0]['conversation']['id']}").json()
    assert conv["messages"][-1]["error"]
    client.delete(f"/api/providers/{p['id']}")


def test_failed_chat_leaves_no_empty_conversation(client):
    pid = client.post("/api/projects", json={"name": "chat-nothing-saved"}).json()["id"]
    p = client.post("/api/providers", json={"preset": "custom", "name": "Gone", "base_url": "http://127.0.0.1:1/v1"}).json()
    client.patch(f"/api/providers/{p['id']}", json={"enabled": False})
    r = client.post(f"/api/projects/{pid}/chat", json={"message": "hi", "model": "gone/m"})
    assert r.status_code == 400
    assert client.get(f"/api/projects/{pid}/conversations").json() == []
    client.delete(f"/api/providers/{p['id']}")


def test_unexpected_stream_error_is_reported_not_stopped(client, monkeypatch):
    from app.services.providers.ollama import OllamaClient

    async def broken(self, model, messages, options=None):
        yield {"delta": "partial", "thinking": "", "done": False, "stats": None}
        raise ValueError("bad chunk")

    monkeypatch.setattr(OllamaClient, "chat_stream", broken)
    pid = client.post("/api/projects", json={"name": "chat-broken"}).json()["id"]
    events = chat(client, pid, message="hi", model="ollama/chatty:1b")
    assert events[-1]["type"] == "error" and "ValueError: bad chunk" in events[-1]["message"]
    conv = client.get(f"/api/projects/{pid}/conversations/{events[0]['conversation']['id']}").json()
    assert conv["messages"][-1]["content"] == "partial" and conv["messages"][-1]["error"] != "stopped"
