"""Speech to text for voice notes and recordings, through a Whisper service on the network.

BoxPilot's catalog has one (whisper-asr-webservice: POST /asr). A URL ending in /v1 is treated as
an OpenAI-compatible server instead (POST /v1/audio/transcriptions), which covers faster-whisper
servers and Speaches. The address comes from the "speech" setting, else LLMCOACH_WHISPER_URL.
"""
from __future__ import annotations

from pathlib import Path

import httpx
from sqlmodel import Session

AUDIO = {".mp3", ".m4a", ".wav", ".ogg", ".opus", ".webm", ".flac", ".aac"}
SETTING_KEY = "speech"


class SpeechError(ValueError):
    pass


def whisper_url() -> str:
    from ..config import settings
    from ..db import Setting, engine

    with Session(engine) as s:
        row = s.get(Setting, SETTING_KEY)
    return ((row.value or {}).get("url") if row else None) or settings.whisper_url or ""


def transcribe(path: Path, url: str | None = None, timeout: float = 1800) -> str:
    url = (url if url is not None else whisper_url()).rstrip("/")
    if not url:
        raise SpeechError("reading recordings needs a speech-to-text service: install Whisper from BoxPilot's catalog "
                          "and give its address on the Providers page")
    try:
        with httpx.Client(timeout=httpx.Timeout(30, read=timeout)) as client, open(path, "rb") as f:
            if url.endswith("/v1"):
                r = client.post(f"{url}/audio/transcriptions", files={"file": (path.name, f)}, data={"model": "whisper-1"})
                r.raise_for_status()
                return (r.json().get("text") or "").strip()
            r = client.post(f"{url}/asr", params={"task": "transcribe", "encode": "true"},  # plain text is the default output
                            files={"audio_file": (path.name, f)})
            r.raise_for_status()
            return r.text.strip()
    except httpx.HTTPStatusError as e:
        raise SpeechError(f"the speech-to-text service answered {e.response.status_code}") from e
    except httpx.HTTPError as e:
        raise SpeechError(f"couldn't reach the speech-to-text service at {url}: {e}") from e
