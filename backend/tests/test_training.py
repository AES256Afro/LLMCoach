import io
import json

import pytest

from app.services import training
from tests.test_jobs import wait_final


def test_params_for():
    assert training.params_for("Qwen/Qwen2.5-0.5B-Instruct") == 0.49
    assert training.params_for("someone/My-Model-7B") == 7
    assert training.params_for("org/tiny-350m-chat") == 0.35
    assert training.params_for("org/mystery") is None


def test_memory_estimates_are_ordered():
    lora = training.estimate(4, "lora", 2048, 2, "cuda")["gb"]
    qlora = training.estimate(4, "qlora", 2048, 2, "cuda")["gb"]
    assert qlora < lora < 16  # a 4B LoRA fits a 16 GB card; QLoRA needs much less
    assert training.estimate(8, "lora", 2048, 2, "cuda")["gb"] > 16
    assert training.estimate(0.5, "lora", 512, 1, "cpu")["where"] == "RAM"


def test_plan_on_cpu_guards(monkeypatch):
    monkeypatch.setattr(training, "hardware", lambda: {
        "backend": "cpu", "vram_gb": None, "ram_gb": 32, "unsloth_installed": False, "recommended_backend": "hf"})
    p = training.plan("Qwen/Qwen2.5-0.5B-Instruct", "balanced", {}, "lora", "auto", rows_train=100)
    assert p["backend"] == "hf" and p["device"] == "cpu" and p["max_seq_len"] == 512 and p["micro_batch"] == 1
    assert p["grad_accum"] == 16 and p["total_steps"] == 14  # ceil(100/16)=7 steps x 2 epochs
    with pytest.raises(training.PlanError, match="too large"):
        training.plan("Qwen/Qwen3-4B", "quick", {}, "lora", "auto", 100)
    with pytest.raises(training.PlanError, match="QLoRA needs"):
        training.plan("Qwen/Qwen3-0.6B", "quick", {}, "qlora", "auto", 100)
    with pytest.raises(training.PlanError, match="Unsloth needs"):
        training.plan("Qwen/Qwen3-0.6B", "quick", {}, "lora", "unsloth", 100)
    with pytest.raises(training.PlanError, match="unknown settings"):
        training.plan("Qwen/Qwen3-0.6B", "quick", {"rm_rf": 1}, "lora", "auto", 100)
    assert training.plan("Qwen/Qwen3-0.6B", "quick", {"max_steps": 3}, "lora", "auto", 100)["total_steps"] == 3


def test_plan_on_gpu(monkeypatch):
    monkeypatch.setattr(training, "hardware", lambda: {
        "backend": "cuda", "vram_gb": 16, "ram_gb": 64, "unsloth_installed": True, "recommended_backend": "unsloth"})
    p = training.plan("Qwen/Qwen3-4B", "balanced", {}, "qlora", "auto", 1000)
    assert p["backend"] == "unsloth" and p["memory"]["fits"] and p["max_seq_len"] == 2048
    with pytest.raises(training.PlanError, match="estimated"):
        training.plan("someone/Big-14B", "balanced", {}, "lora", "hf", 1000)


def _upload_dataset(client, pid, n=24):
    rows = [{"messages": [{"role": "user", "content": f"What is {i} plus {i}?"},
                          {"role": "assistant", "content": f"{i} plus {i} is {2 * i}."}]} for i in range(n)]
    data = "\n".join(json.dumps(r) for r in rows).encode()
    return client.post(f"/api/projects/{pid}/datasets",
                       files={"file": ("math.jsonl", io.BytesIO(data), "application/jsonl")}).json()["dataset"]


def test_dry_run_and_validation(client):
    pid = client.post("/api/projects", json={"name": "train-plan"}).json()["id"]
    d = _upload_dataset(client, pid)
    r = client.post(f"/api/projects/{pid}/finetunes", json={
        "base_model": "Qwen/Qwen2.5-0.5B-Instruct", "dataset_id": d["id"], "preset": "quick", "dry_run": True})
    assert r.status_code == 201 and r.json()["plan"]["memory"]["gb"] > 0
    assert not client.get(f"/api/projects/{pid}/finetunes").json()
    bad = client.post(f"/api/projects/{pid}/finetunes", json={
        "base_model": "Qwen/Qwen2.5-0.5B-Instruct", "dataset_id": 9999})
    assert bad.status_code == 404
    opts = client.get("/api/training/options").json()
    assert {"quick", "balanced", "thorough"} <= set(opts["presets"]) and opts["base_models"]


@pytest.mark.slow
def test_real_lora_training_on_cpu(client):
    """Trains a tiny model for a few steps: exercises TRL, PEFT, metrics and the saved adapter."""
    pytest.importorskip("torch")
    pytest.importorskip("trl")
    pid = client.post("/api/projects", json={"name": "train-real"}).json()["id"]
    d = _upload_dataset(client, pid)
    r = client.post(f"/api/projects/{pid}/finetunes", json={
        "base_model": "trl-internal-testing/tiny-Qwen2ForCausalLM-2.5", "dataset_id": d["id"],
        "preset": "quick", "overrides": {"max_steps": 4, "effective_batch": 2}})
    assert r.status_code == 201, r.text
    job = wait_final(client, r.json()["job"]["id"], timeout=600)
    log = client.get(f"/api/jobs/{job['id']}/log").text
    assert job["status"] == "done", log[-3000:]
    ft = client.get(f"/api/projects/{pid}/finetunes/{r.json()['finetune']['id']}").json()
    assert ft["status"] == "ready" and ft["backend"] == "hf"
    assert ft["metrics"]["steps"] == 4 and ft["metrics"]["train_loss"] > 0
    events = client.get(f"/api/jobs/{job['id']}/metrics").json()
    assert sum(1 for e in events if e["type"] == "metric" and "loss" in e) >= 4
    assert any("eval_loss" in e for e in events)
    from app.config import settings
    adapter = settings.data_dir / ft["output_dir"]
    assert (adapter / "adapter_config.json").exists()
    # A dataset that was trained on can't be deleted out from under its fine-tune.
    assert client.delete(f"/api/projects/{pid}/datasets/{d['id']}").status_code == 409
    assert client.delete(f"/api/projects/{pid}/finetunes/{ft['id']}").status_code == 204
    assert not adapter.exists()
