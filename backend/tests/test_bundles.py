import io
import json
import zipfile

from sqlmodel import Session

from app.config import settings
from app.db import FineTune, FineTuneStatus, Message, engine, utcnow
from tests.test_jobs import wait_final


def _bundle(entries: dict[str, bytes | str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return buf.getvalue()


def test_export_and_import_a_project(client, fake):
    pid = client.post("/api/projects", json={"name": "Bundle source", "description": "moves between boxes"}).json()["id"]
    client.patch(f"/api/projects/{pid}", json={"settings": {"chunk_size": 700}})
    page = client.post(f"/api/projects/{pid}/documents/url", json={"url": f"{fake.url}/pages/harbor.html"}).json()
    wait_final(client, page["job"]["id"])
    lines = [json.dumps({"messages": [{"role": "user", "content": f"Question {i}?"}, {"role": "assistant", "content": f"Answer {i}."}]})
             for i in range(12)]
    ds = client.post(f"/api/projects/{pid}/datasets", data={"name": "faq"},
                     files={"file": ("faq.jsonl", io.BytesIO("\n".join(lines).encode()), "application/jsonl")}).json()["dataset"]
    with Session(engine) as s:
        ft = FineTune(project_id=pid, name="faq tune", base_model="Qwen/Qwen2.5-0.5B-Instruct", dataset_id=ds["id"],
                      status=FineTuneStatus.ready, output_dir="finetunes/bundle-src/adapter", promoted_at=utcnow(),
                      metrics={"train_loss": 1.23})
        s.add(ft)
        s.commit()
    adapter = settings.data_dir / "finetunes" / "bundle-src" / "adapter"
    (adapter / "sub").mkdir(parents=True, exist_ok=True)
    (adapter / "adapter_config.json").write_text('{"r": 8}')
    (adapter / "sub" / "weights.bin").write_bytes(b"\x00\x01weights")
    conv = client.post(f"/api/projects/{pid}/conversations", json={}).json()
    with Session(engine) as s:
        for role, text in (("user", "When does the ferry leave?"), ("assistant", "At 07:40."), ("event", "Training started")):
            s.add(Message(conversation_id=conv["id"], role=role, content=text, data={"card": "train"} if role == "event" else None))
        s.commit()

    r = client.get(f"/api/projects/{pid}/export")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert "llmcoach-bundle-source.zip" in r.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        manifest = json.loads(z.read("manifest.json"))
        assert manifest["project"]["settings"]["chunk_size"] == 700
        assert [d["filename"] for d in manifest["documents"]] == ["Harbor Ferry Guide.html"]
        key = manifest["finetunes"][0]["key"]
        assert z.read(f"adapters/{key}/sub/weights.bin") == b"\x00\x01weights"
        readme = z.read(f"adapters/{key}/README.md").decode()  # the model card travels with the adapter
        assert readme.startswith("# faq tune") and "“faq” (upload): 12 examples" in readme and "the adapter in use" in readme
    card = client.get(f"/api/projects/{pid}/finetunes/{key}/card")
    assert card.status_code == 200 and card.text.startswith("# faq tune") and "It hasn't been evaluated yet." in card.text
    without = client.get(f"/api/projects/{pid}/export?adapters=false")
    assert json.loads(zipfile.ZipFile(io.BytesIO(without.content)).read("manifest.json"))["finetunes"] == []

    out = client.post("/api/projects/import", files={"file": ("b.zip", io.BytesIO(r.content), "application/zip")}).json()
    assert out["project"]["name"] == "Bundle source (imported)"  # the original is still here
    assert (out["documents"], out["datasets"], out["finetunes"], out["conversations"]) == (1, 1, 1, 1)
    new = out["project"]["id"]
    assert out["project"]["settings"]["chunk_size"] == 700
    assert wait_final(client, out["ingest_job_id"])["status"] == "done"
    doc = client.get(f"/api/projects/{new}/documents").json()[0]
    assert doc["status"] == "ready" and doc["source_url"] == f"{fake.url}/pages/harbor.html"
    d = client.get(f"/api/projects/{new}/datasets").json()[0]
    assert d["name"] == "faq" and d["row_count"] == 12 and sum(d["splits"].values()) == 12
    f = client.get(f"/api/projects/{new}/finetunes").json()[0]
    assert f["status"] == "ready" and f["dataset_id"] == d["id"] and f["promoted_at"] and f["metrics"]["train_loss"] == 1.23
    assert (settings.data_dir / f["output_dir"] / "sub" / "weights.bin").read_bytes() == b"\x00\x01weights"
    c = client.get(f"/api/projects/{new}/conversations").json()[0]
    msgs = client.get(f"/api/projects/{new}/conversations/{c['id']}").json()["messages"]
    assert [(m["role"], m["content"]) for m in msgs] == [("user", "When does the ferry leave?"), ("assistant", "At 07:40.")]


def test_import_refuses_bad_bundles(client):
    post = lambda data: client.post("/api/projects/import", files={"file": ("b.zip", io.BytesIO(data), "application/zip")})  # noqa: E731
    assert post(b"not a zip").status_code == 400
    assert "manifest" in post(_bundle({"readme.txt": "hi"})).json()["detail"]
    assert post(_bundle({"manifest.json": json.dumps({"format": "something-else"})})).status_code == 400
    evil = {"format": "llmcoach-project", "version": 1, "project": {"name": "evil"},
            "finetunes": [{"key": 1, "name": "x", "base_model": "m", "adapter": "adapters/1/"}]}
    r = post(_bundle({"manifest.json": json.dumps(evil), "adapters/1/../../../../escape.txt": "boom"}))
    assert r.status_code == 400 and "unsafe" in r.json()["detail"]
    assert not (settings.data_dir.parent / "escape.txt").exists()
    assert "evil" not in [x["name"] for x in client.get("/api/projects").json()]  # the half-import was removed
