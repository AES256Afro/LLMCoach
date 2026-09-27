import io
import json

import pytest

from app.services import datasets as ds
from tests.test_jobs import wait_final


def test_normalize_formats():
    chat = ds.normalize({"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]})
    assert chat["messages"][-1] == {"role": "assistant", "content": "hello"}
    alpaca = ds.normalize({"instruction": "Translate", "input": "hola", "output": "hello", "system": "Be brief."})
    assert alpaca["messages"] == [{"role": "system", "content": "Be brief."},
                                  {"role": "user", "content": "Translate\n\nhola"},
                                  {"role": "assistant", "content": "hello"}]
    assert ds.normalize({"prompt": "p", "completion": "c"})["messages"][0] == {"role": "user", "content": "p"}
    assert ds.normalize({"Question": "q", "Answer": "a"})["messages"][1]["content"] == "a"
    sharegpt = ds.normalize({"conversations": [{"from": "human", "value": "q"}, {"from": "gpt", "value": "a"}]})
    assert [m["role"] for m in sharegpt["messages"]] == ["user", "assistant"]


@pytest.mark.parametrize("row,reason", [
    ({"messages": [{"role": "user", "content": "hi"}]}, "last message"),
    ({"messages": [{"role": "robot", "content": "x"}, {"role": "assistant", "content": "y"}]}, "unknown role"),
    ({"messages": []}, "non-empty"),
    ({"prompt": "only a prompt"}, "needs messages"),
    ({"messages": [{"role": "assistant", "content": "x"}]}, "no user message"),
])
def test_normalize_rejects(row, reason):
    with pytest.raises(ValueError, match=reason):
        ds.normalize(row)


def test_splits_are_seeded_and_cover_small_sets():
    rows = [{"messages": []} for _ in range(20)]
    counts = ds.assign_splits(rows, 0.1, 0.1, seed=1)
    assert counts == {"train": 16, "val": 2, "test": 2}
    first = [r["split"] for r in rows]
    ds.assign_splits(rows, 0.1, 0.1, seed=1)
    assert [r["split"] for r in rows] == first
    small = [{"messages": []} for _ in range(12)]
    assert ds.assign_splits(small, 0.05, 0.05)["test"] == 1  # always something to evaluate on
    with pytest.raises(ds.DatasetError):
        ds.assign_splits(rows, 0.6, 0.5)


def test_upload_reports_bad_rows_and_keeps_good_ones(client):
    pid = client.post("/api/projects", json={"name": "ds-upload"}).json()["id"]
    good = [{"question": f"q{i}", "answer": f"a{i}"} for i in range(20)]
    lines = [json.dumps(r) for r in good] + ['{"prompt": "no answer"}', "not json"]
    r = client.post(f"/api/projects/{pid}/datasets", data={"name": "faq", "val": "0.1", "test": "0.1"},
                    files={"file": ("faq.jsonl", io.BytesIO("\n".join(lines).encode()), "application/jsonl")})
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["dataset"]["row_count"] == 20 and out["error_count"] == 2
    assert {e["line"] for e in out["errors"]} == {21, 22}
    d = out["dataset"]
    assert d["splits"] == {"train": 16, "val": 2, "test": 2}
    assert d["stats"]["tokens_total"] > 0

    rows = client.get(f"/api/projects/{pid}/datasets/{d['id']}/rows", params={"split": "test"}).json()
    assert rows["total"] == 2 and all(r["split"] == "test" for r in rows["rows"])
    found = client.get(f"/api/projects/{pid}/datasets/{d['id']}/rows", params={"q": "a13"}).json()
    assert found["total"] == 1

    d2 = client.post(f"/api/projects/{pid}/datasets/{d['id']}/split", json={"val": 0.25, "test": 0.25}).json()
    assert d2["splits"] == {"train": 10, "val": 5, "test": 5}
    dl = client.get(f"/api/projects/{pid}/datasets/{d['id']}/download")
    assert dl.status_code == 200 and len(dl.text.splitlines()) == 20

    csv_data = "instruction,output\nSay hi,Hi!\nSay bye,Bye!\n"
    r = client.post(f"/api/projects/{pid}/datasets", files={"file": ("x.csv", io.BytesIO(csv_data.encode()), "text/csv")})
    assert r.json()["dataset"]["row_count"] == 2

    bad = client.post(f"/api/projects/{pid}/datasets", files={"file": ("x.jsonl", io.BytesIO(b'{"a":1}'), "application/jsonl")})
    assert bad.status_code == 400 and bad.json()["detail"]["errors"][0]["line"] == 1

    assert client.delete(f"/api/projects/{pid}/datasets/{d['id']}").status_code == 204
    assert client.delete(f"/api/projects/{pid}").status_code == 204


def test_generate_from_knowledge_base(client, fake):
    pid = client.post("/api/projects", json={"name": "ds-generate"}).json()["id"]
    assert client.post(f"/api/projects/{pid}/datasets/generate", json={"model": "ollama/chatty:1b"}).status_code == 400

    text = "\n\n".join(f"Section {i}. " + "LLMCoach helps you fine tune small models. " * 12 for i in range(6))
    up = client.post(f"/api/projects/{pid}/documents",
                     files=[("files", ("guide.md", io.BytesIO(text.encode()), "text/markdown"))]).json()
    wait_final(client, up["job"]["id"])

    r = client.post(f"/api/projects/{pid}/datasets/generate",
                    json={"model": "ollama/chatty:1b", "max_chunks": 4, "pairs_per_chunk": 2, "style": "grounded",
                          "system_prompt": "You answer questions about LLMCoach.", "val": 0.2, "test": 0.2})
    assert r.status_code == 201, r.text
    job = wait_final(client, r.json()["job"]["id"])
    assert job["status"] == "done", client.get(f"/api/jobs/{job['id']}/log").text
    d = client.get(f"/api/projects/{pid}/datasets/{r.json()['dataset']['id']}").json()
    assert d["status"] == "ready" and d["source"] == "generated"
    assert 0 < d["row_count"] <= 8  # at most 2 pairs from each of 4 passages
    assert sum(d["splits"].values()) == d["row_count"]
    rows = client.get(f"/api/projects/{pid}/datasets/{d['id']}/rows").json()["rows"]
    first = rows[0]["messages"]
    assert first[0] == {"role": "system", "content": "You answer questions about LLMCoach."}
    assert first[1]["content"].startswith("Context:\n") and "Question: Question" in first[1]["content"]
    assert rows[0]["meta"]["generated_by"] == "ollama/chatty:1b"
    # The generation request asked for structured output.
    assert fake.app.state.chat_bodies[-1]["format"]["required"] == ["pairs"]

    # Split fractions are checked up front, before any dataset or job is created.
    n_datasets = len(client.get(f"/api/projects/{pid}/datasets").json())
    r = client.post(f"/api/projects/{pid}/datasets/generate", json={"model": "ollama/chatty:1b", "val": 0.5, "test": 0.5})
    assert r.status_code == 400 and "fractions" in r.json()["detail"]
    assert len(client.get(f"/api/projects/{pid}/datasets").json()) == n_datasets


def test_salvage_with_bad_fractions_still_finalizes_and_deletes(client):
    from sqlmodel import Session

    from app.api.datasets import _salvage
    from app.db import Dataset, DatasetStatus, Job, JobStatus, engine

    pid = client.post("/api/projects", json={"name": "ds-salvage"}).json()["id"]
    with Session(engine) as s:
        d = Dataset(project_id=pid, name="stuck", source="generated", status=DatasetStatus.generating)
        s.add(d)
        s.commit()
        s.refresh(d)
        job = Job(kind="generate", config={"dataset_id": d.id, "val": 0.6, "test": 0.6}, status=JobStatus.failed)
        s.add(job)
        s.commit()
        s.refresh(job)
        d.job_id = job.id
        s.add(d)
        s.commit()
        dsid = d.id
        s.refresh(job)
        s.expunge(job)
    rows = [{"messages": [{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": f"a{i}"}], "split": "train"}
            for i in range(12)]
    ds.write_rows(ds.dataset_path(pid, dsid), rows)
    _salvage(job)
    d = client.get(f"/api/projects/{pid}/datasets/{dsid}").json()
    assert d["status"] == "ready" and sum(d["splits"].values()) == 12

    # A dataset stuck in "generating" whose job is over can still be deleted.
    with Session(engine) as s:
        stuck = s.get(Dataset, dsid)
        stuck.status = DatasetStatus.generating
        s.add(stuck)
        s.commit()
    assert client.delete(f"/api/projects/{pid}/datasets/{dsid}").status_code == 204
