import io
import json

import pytest

from app.services import metrics
from tests.test_jobs import wait_final


def test_metrics():
    assert metrics.exact_match("The answer is 42.", "answer is 42") == 1.0
    assert metrics.f1("a cat sat", "the cat sat down") == pytest.approx(0.8)
    assert metrics.f1("", "") == 1.0 and metrics.f1("x", "") == 0.0
    assert metrics.rouge_l("cat sat mat", "cat sat on mat") == pytest.approx(2 * 1 * 0.75 / 1.75)
    assert metrics.rouge_l("totally different", "cat sat") == 0.0


def _dataset(client, pid):
    rows = [{"messages": [{"role": "system", "content": "Be brief."},
                          {"role": "user", "content": f"Question {i}?"},
                          {"role": "assistant", "content": "Hello from the fake." if i % 2 else f"Other answer {i}."}]}
            for i in range(20)]
    data = "\n".join(json.dumps(r) for r in rows).encode()
    return client.post(f"/api/projects/{pid}/datasets", data={"test": "0.25", "val": "0.1"},
                       files={"file": ("qa.jsonl", io.BytesIO(data), "application/jsonl")}).json()["dataset"]


def test_eval_models_with_rag_and_judge(client, fake):
    pid = client.post("/api/projects", json={"name": "eval-models"}).json()["id"]
    up = client.post(f"/api/projects/{pid}/documents",
                     files=[("files", ("kb.txt", io.BytesIO(b"facts about questions. " * 40), "text/plain"))]).json()
    wait_final(client, up["job"]["id"])
    d = _dataset(client, pid)
    assert d["splits"]["test"] == 5

    bad = client.post(f"/api/projects/{pid}/evals", json={"dataset_id": d["id"], "variants": [{"kind": "model", "ref": "ollama/"}]})
    assert bad.status_code == 400
    r = client.post(f"/api/projects/{pid}/evals", json={
        "dataset_id": d["id"], "judge_model": "ollama/chatty:1b",
        "variants": [{"kind": "model", "ref": "ollama/chatty:1b"}, {"kind": "model", "ref": "ollama/chatty:1b", "rag": True}]})
    assert r.status_code == 201, r.text
    job = wait_final(client, r.json()["job"]["id"])
    assert job["status"] == "done", client.get(f"/api/jobs/{job['id']}/log").text[-2000:]

    e = client.get(f"/api/projects/{pid}/evals/{r.json()['eval']['id']}").json()
    assert e["status"] == "done" and e["examples"] == 5
    labels = ["ollama/chatty:1b", "ollama/chatty:1b + knowledge base"]
    assert list(e["summary"]) == labels
    assert all(e["summary"][l]["judge"] == 4 and e["summary"][l]["n"] == 5 for l in labels)
    row = e["results"][0]
    assert set(row["outputs"]) == set(labels)
    assert row["outputs"][labels[1]]["sources"] == ["kb.txt"] * len(row["outputs"][labels[1]]["sources"])
    # The fake always answers "Hello from the fake.", so exact match equals the share of such references.
    refs = [x["reference"] for x in e["results"]]
    expected_em = sum(r == "Hello from the fake." for r in refs) / len(refs)
    assert e["summary"][labels[0]]["exact_match"] == pytest.approx(expected_em)
    # The system prompt from the dataset was used, and RAG put context into it.
    assert any("Be brief." in b["messages"][0]["content"] and "Context:" in b["messages"][0]["content"]
               for b in fake.app.state.chat_bodies if "messages" in b)

    assert client.delete(f"/api/projects/{pid}/datasets/{d['id']}").status_code == 409  # used by an eval
    assert client.delete(f"/api/projects/{pid}").status_code == 204


@pytest.mark.slow
def test_eval_finetune_variant(client):
    pytest.importorskip("torch")
    from tests.test_training import _upload_dataset
    pid = client.post("/api/projects", json={"name": "eval-ft"}).json()["id"]
    d = _upload_dataset(client, pid)
    r = client.post(f"/api/projects/{pid}/finetunes", json={
        "base_model": "trl-internal-testing/tiny-Qwen2ForCausalLM-2.5", "dataset_id": d["id"],
        "overrides": {"max_steps": 2, "effective_batch": 2}}).json()
    assert wait_final(client, r["job"]["id"], timeout=600)["status"] == "done"
    ft_id = r["finetune"]["id"]
    ev = client.post(f"/api/projects/{pid}/evals", json={
        "dataset_id": d["id"], "max_examples": 2, "max_new_tokens": 8,
        "variants": [{"kind": "finetune", "ref": str(ft_id)}, {"kind": "model", "ref": "ollama/chatty:1b"}]})
    assert ev.status_code == 201, ev.text
    job = wait_final(client, ev.json()["job"]["id"], timeout=600)
    assert job["status"] == "done", client.get(f"/api/jobs/{job['id']}/log").text[-2000:]
    e = client.get(f"/api/projects/{pid}/evals/{ev.json()['eval']['id']}").json()
    ft_label = next(l for l in e["summary"] if "fine-tune" in l)
    assert e["summary"][ft_label]["n"] == 2 and e["summary"][ft_label]["errors"] == 0
