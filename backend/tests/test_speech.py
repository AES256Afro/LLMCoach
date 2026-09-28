import io

import pytest

from app.services import parsing
from tests.test_jobs import wait_final


def test_voice_notes_are_transcribed_and_indexed(client, fake, tmp_path):
    assert client.put("/api/speech", json={"url": f"{fake.url}/"}).json()["url"] == fake.url
    pid = client.post("/api/projects", json={"name": "voice-notes"}).json()["id"]
    before = fake.app.state.asr_calls
    r = client.post(f"/api/projects/{pid}/documents", files={"files": ("memo.m4a", io.BytesIO(b"fake audio bytes"), "audio/mp4")}).json()
    assert [d["filename"] for d in r["documents"]] == ["memo.m4a"] and r["held"] == []  # the upload's check doesn't wait on speech
    assert wait_final(client, r["job"]["id"])["status"] == "done"
    doc = client.get(f"/api/projects/{pid}/documents").json()[0]
    assert doc["status"] == "ready" and doc["chunk_count"] >= 1
    hits = client.post(f"/api/projects/{pid}/search", json={"query": "when does the ferry leave", "top_k": 1}).json()["results"]
    assert "seven forty" in hits[0]["text"]
    assert fake.app.state.asr_calls == before + 1

    # Transcripts are cached by content: the same recording isn't sent twice.
    copy = tmp_path / "again.m4a"
    copy.write_bytes(b"fake audio bytes")
    assert "seven forty" in parsing.parse(copy)[0][0]
    assert fake.app.state.asr_calls == before + 1

    # An OpenAI-compatible server is addressed by its /v1 URL.
    client.put("/api/speech", json={"url": f"{fake.url}/v1"})
    other = tmp_path / "standup.wav"
    other.write_bytes(b"other audio")
    assert parsing.parse(other)[0][0] == "Transcript of standup.wav: the office opens at eight."


def test_recordings_without_a_speech_service_say_what_is_missing(client, tmp_path):
    client.put("/api/speech", json={"url": ""})
    note = tmp_path / "note.mp3"
    note.write_bytes(b"audio")
    with pytest.raises(parsing.ParseError, match="Whisper"):
        parsing.parse(note)
    with pytest.raises(parsing.ParseError, match="transcribed when it's indexed"):
        parsing.parse(note, ocr=False)
