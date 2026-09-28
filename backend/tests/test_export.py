import json

from sqlmodel import Session

from app.api import training as training_api
from app.config import settings
from app.db import FineTune, FineTuneStatus, Job, engine
from app.workers.export import chat_format, legacy_merges


def _ft(pid: int, status=FineTuneStatus.ready, output_dir="finetunes/9/adapter") -> int:
    with Session(engine) as s:
        ft = FineTune(project_id=pid, name="x", base_model="Qwen/Qwen2.5-0.5B-Instruct", status=status, output_dir=output_dir)
        s.add(ft)
        s.commit()
        return ft.id


def test_export_endpoint_checks(client, monkeypatch):
    submitted = []
    # Capture the job instead of running it: the worker would load a real base model.
    monkeypatch.setattr(training_api.manager, "submit",
                        lambda session, kind, config, project_id=None: submitted.append((kind, config)) or Job(id=0, kind=kind, config=config))
    pid = client.post("/api/projects", json={"name": "Export Checks!"}).json()["id"]
    training = _ft(pid, FineTuneStatus.training)
    assert client.post(f"/api/projects/{pid}/finetunes/{training}/export", json={}).status_code == 409
    missing = _ft(pid, output_dir="finetunes/nowhere/adapter")
    assert client.post(f"/api/projects/{pid}/finetunes/{missing}/export", json={}).json()["detail"] == "this fine-tune's adapter files are missing"
    ready = _ft(pid, output_dir="finetunes/export-test/adapter")
    adapter = settings.data_dir / "finetunes" / "export-test" / "adapter"
    adapter.mkdir(parents=True, exist_ok=True)
    (adapter / "adapter_config.json").write_text("{}")
    assert client.post(f"/api/projects/{pid}/finetunes/{ready}/export", json={"quantize": "q2"}).status_code == 400
    assert client.post(f"/api/projects/{pid}/finetunes/{ready}/export", json={"name": "Bad Name!"}).status_code == 400
    r = client.post(f"/api/projects/{pid}/finetunes/{ready}/export", json={}).json()
    # The default name comes from the project and the fine-tune, in characters Ollama accepts.
    assert r["model"] == f"ollama/llmcoach-export-checks-ft{ready}"
    assert submitted == [("export", {"finetune_id": ready, "name": f"llmcoach-export-checks-ft{ready}", "quantize": "q8_0", "provider": "ollama"})]


def test_legacy_merges_rewrites_pairs_only(tmp_path):
    new = tmp_path / "new.json"
    new.write_text(json.dumps({"model": {"type": "BPE", "merges": [["Ġ", "Ġ"], ["a", "b"]]}}), encoding="utf-8")
    assert legacy_merges(new) is True
    assert json.loads(new.read_text(encoding="utf-8"))["model"]["merges"] == ["Ġ Ġ", "a b"]
    old = tmp_path / "old.json"
    old.write_text(json.dumps({"model": {"type": "BPE", "merges": ["a b"]}}), encoding="utf-8")
    assert legacy_merges(old) is False


def test_chat_format_by_family():
    qwen = "{% for m in messages %}<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>{% endfor %}"
    llama = "<|start_header_id|>{{ role }}<|end_header_id|>"
    gemma = "<start_of_turn>user"
    assert chat_format(qwen)[1] == ["<|im_end|>", "<|im_start|>"]
    assert chat_format(llama)[1][0] == "<|eot_id|>"
    assert chat_format(gemma)[1] == ["<end_of_turn>"]
    assert chat_format("plain {{ prompt }}") is None and chat_format(None) is None
    template = chat_format(qwen)[0]
    assert ".Messages" in template and "<|im_start|>assistant" in template
