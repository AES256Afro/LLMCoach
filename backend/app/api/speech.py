"""The speech-to-text setting: where recordings are sent to be transcribed."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session

from ..config import settings
from ..db import Setting, get_session
from ..services import speech

router = APIRouter(prefix="/api/speech", tags=["speech"])


class SpeechConfig(BaseModel):
    url: str = ""


@router.get("")
def get_speech() -> dict:
    return {"url": speech.whisper_url(), "env_url": settings.whisper_url, "formats": sorted(speech.AUDIO)}


@router.put("")
def put_speech(body: SpeechConfig, session: Session = Depends(get_session)) -> dict:
    row = session.get(Setting, speech.SETTING_KEY) or Setting(key=speech.SETTING_KEY)
    row.value = {"url": body.url.strip().rstrip("/")}
    session.add(row)
    session.commit()
    return get_speech()
