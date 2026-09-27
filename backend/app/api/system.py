import asyncio
import logging
from collections import deque

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..services import ollama
from ..services.device import system_stats
from ..services.jobs import manager

router = APIRouter(tags=["system"])


class RingBufferHandler(logging.Handler):
    """Keeps the most recent server log records in memory for the Logs page."""

    def __init__(self, capacity: int = 2000) -> None:
        super().__init__()
        self.records: deque[dict] = deque(maxlen=capacity)
        self.counter = 0

    def emit(self, record: logging.LogRecord) -> None:
        self.counter += 1
        self.records.append({
            "id": self.counter,
            "ts": record.created,
            "level": record.levelname,
            "logger": record.name,
            "message": self.format(record),
        })


app_logs = RingBufferHandler()
app_logs.setFormatter(logging.Formatter("%(message)s"))


def _snapshot() -> dict:
    return {**system_stats().to_dict(), "running_job_id": manager.running_job_id}


@router.get("/api/system")
def get_system() -> dict:
    return _snapshot()


@router.get("/api/ollama")
async def get_ollama() -> dict:
    return await ollama.status()


@router.get("/api/logs/app")
def get_app_logs(after: int = 0) -> list[dict]:
    return [r for r in app_logs.records if r["id"] > after]


@router.websocket("/ws/system")
async def stream_system(ws: WebSocket) -> None:
    await ws.accept()
    last_log_id = 0
    try:
        while True:
            stats = await asyncio.to_thread(_snapshot)
            new_logs = [r for r in app_logs.records if r["id"] > last_log_id]
            if new_logs:
                last_log_id = new_logs[-1]["id"]
            await ws.send_json({"type": "stats", "stats": stats, "logs": new_logs})
            await asyncio.sleep(2)
    except WebSocketDisconnect:
        pass
