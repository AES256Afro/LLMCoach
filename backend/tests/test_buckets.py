import time
from datetime import UTC, datetime
from urllib.parse import quote

import pytest

from app.config import settings
from app.services.s3 import normalize_endpoint, sign
from tests.fake_servers import FakeServer, fake_s3_app
from tests.test_inbox import AWS, _files, _project, _text
from tests.test_jobs import wait_final

KEY, SECRET = "llmcoach-reader", "s3cr3t-key-for-tests"


@pytest.fixture(scope="module")
def s3():
    with FakeServer(fake_s3_app(KEY, SECRET)) as server:
        yield server


def _put(s3, bucket: str, key: str, body: str | bytes, age: float = 120) -> None:
    data = body.encode() if isinstance(body, str) else body
    s3.app.state.buckets.setdefault(bucket, {})[key] = (data, time.time() - age)


def test_signatures_match_botocore():
    # Reference signatures computed with botocore 1.43 (S3SigV4Auth) for the same requests.
    now = datetime(2026, 9, 27, 12, 0, 0, tzinfo=UTC)
    k, s = "AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
    cases = [
        ("127.0.0.1:9000", "/my-bucket", [("list-type", "2"), ("prefix", "team/notes/")], "us-east-1",
         "dcd3cce2523208dd90361404b79e936b5b8369fc1dac91b7f3628a3638aa599c"),
        ("127.0.0.1:9000", "/my-bucket/" + quote("team/notes/a b+cé.md"), [], "us-east-1",
         "deb188c0b0de8a93a675f03e8761da0b429d667962d3700ccf0147b8f340adcd"),
        ("s3.eu-west-2.amazonaws.com", "/docs",
         [("list-type", "2"), ("prefix", ""), ("continuation-token", "abc/def="), ("max-keys", "1")], "eu-west-2",
         "2f4313510bfdb4dc691b33a1cf54d30ad1b49c1f347a1000dd021044512b09af"),
    ]
    for host, path, params, region, want in cases:
        assert sign("GET", host, path, params, k, s, region, now)["authorization"].endswith(f"Signature={want}")


def test_endpoint_normalization():
    assert normalize_endpoint("minio:9000/") == "http://minio:9000"
    assert normalize_endpoint("https://s3.amazonaws.com") == "https://s3.amazonaws.com"
    for bad in ("ftp://x", "http://x/bucket", "", "http://x?y=1"):
        with pytest.raises(ValueError):
            normalize_endpoint(bad)


def test_bucket_source_end_to_end(client, s3):
    pid = _project(client, "bucket-source")
    base = {"kind": "bucket", "endpoint": s3.url, "bucket": "team-docs", "prefix": "notes", "access_key": KEY}
    _put(s3, "team-docs", "notes/policy.md", _text("Refund policy"))
    _put(s3, "team-docs", "notes/sub/ferry times.md", _text("Ferry"))
    _put(s3, "team-docs", "notes/photo.bin", b"\x00" * 2048)  # not a type LLMCoach reads: never downloaded
    _put(s3, "team-docs", "notes/.draft.md", _text("Draft"))  # hidden: ignored
    _put(s3, "team-docs", "notes/keys.md", f"aws = {AWS}\n" + _text("Keys"))
    _put(s3, "team-docs", "archive/old.md", _text("Old"))  # outside the prefix

    r = client.post(f"/api/projects/{pid}/sources", json={**base, "secret_key": "wrong"})
    assert r.status_code == 400 and "SignatureDoesNotMatch" in r.json()["detail"]
    r = client.post(f"/api/projects/{pid}/sources", json={**base, "bucket": "Bad_Name", "secret_key": SECRET})
    assert r.status_code == 400
    r = client.post(f"/api/projects/{pid}/sources", json={**base, "secret_key": SECRET})
    assert r.status_code == 201, r.text
    src = r.json()
    assert src["kind"] == "bucket" and src["prefix"] == "notes/" and src["name"] == "team-docs/notes"
    assert "secret_key" not in src and src["has_secret"] is True
    assert src["path"] == f"{s3.url}/team-docs/notes/"
    # Overlapping prefixes in the same bucket would read the same objects twice.
    assert client.post(f"/api/projects/{pid}/sources", json={**base, "prefix": "notes/sub", "secret_key": SECRET}).status_code == 409

    scan = lambda: client.post(f"/api/projects/{pid}/sources/{src['id']}/scan").json()  # noqa: E731
    out = scan()
    wait_final(client, out["ingest_job_id"])
    files = _files(client, pid, src["id"])
    assert set(files) == {"policy.md", "sub/ferry times.md", "photo.bin", "keys.md"}
    assert files["policy.md"]["status"] == "added" and files["sub/ferry times.md"]["status"] == "added"
    assert files["photo.bin"]["status"] == "skipped" and files["keys.md"]["status"] == "quarantined"
    fetched = [path for path, params in s3.app.state.requests if "list-type" not in params]
    assert not any("photo.bin" in p or "draft" in p for p in fetched)  # only readable files were downloaded
    assert any(p.endswith("/sub/ferry%20times.md") for p in fetched)
    docs = sorted(d["filename"] for d in client.get(f"/api/projects/{pid}/documents").json())
    assert docs == ["ferry times.md", "policy.md"]

    # A changed object replaces its document; a deleted one leaves its document (mirroring is off).
    old = files["policy.md"]["doc_id"]
    _put(s3, "team-docs", "notes/policy.md", _text("Refund policy, second edition"), age=60)
    del s3.app.state.buckets["team-docs"]["notes/sub/ferry times.md"]
    out = scan()  # a changed object is read in the same look: LLMCoach wrote its copy in one go
    files = _files(client, pid, src["id"])
    assert files["policy.md"]["status"] == "added" and files["policy.md"]["doc_id"] != old
    assert files["sub/ferry times.md"]["status"] == "gone"
    wait_final(client, out["ingest_job_id"])

    # Uploads go to the bucket itself, not through LLMCoach.
    r = client.post(f"/api/projects/{pid}/sources/{src['id']}/upload", files=[("files", ("x.md", b"# x", "text/markdown"))])
    assert r.status_code == 400

    # Rotating the key is checked before it's saved.
    assert client.patch(f"/api/projects/{pid}/sources/{src['id']}", json={"secret_key": "nope"}).status_code == 400
    assert client.patch(f"/api/projects/{pid}/sources/{src['id']}", json={"secret_key": SECRET}).status_code == 200

    # An unreachable store is reported on the source, and nothing is removed.
    client.patch(f"/api/projects/{pid}/sources/{src['id']}", json={"poll_seconds": 60})
    s3.app.state.buckets["team-docs-backup"] = s3.app.state.buckets.pop("team-docs")
    out = scan()
    assert "NoSuchBucket" in out["error"]
    assert len(client.get(f"/api/projects/{pid}/documents").json()) == 2
    s3.app.state.buckets["team-docs"] = s3.app.state.buckets.pop("team-docs-backup")

    mirror = settings.data_dir / "buckets" / str(src["id"])
    assert (mirror / "policy.md").exists()
    assert client.delete(f"/api/projects/{pid}/sources/{src['id']}").status_code == 204
    assert not mirror.exists() and "notes/policy.md" in s3.app.state.buckets["team-docs"]


def test_folder_sources_refuse_bucket_settings(client):
    pid = _project(client, "bucket-settings")
    src = client.post(f"/api/projects/{pid}/sources", json={"folder": "not-a-bucket"}).json()
    assert client.patch(f"/api/projects/{pid}/sources/{src['id']}", json={"endpoint": "http://x:9000"}).status_code == 400
    assert client.post(f"/api/projects/{pid}/sources", json={"kind": "ftp", "folder": "x"}).status_code == 400
