import asyncio
import logging
import time
from collections import deque

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

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


# The last five minutes of load, recorded while anyone is watching (at most one sample per two
# seconds however many pages are open), so a page that connects draws its trend at once.
HISTORY_SECONDS = 300
history: deque[dict] = deque(maxlen=HISTORY_SECONDS // 2 + 10)


def _record(stats: dict) -> None:
    now = time.time()
    if history and now - history[-1]["t"] / 1000 < 1.5:
        return
    g = (stats.get("gpus") or [None])[0] or {}
    ram_total = stats.get("ram_total_gb") or 0
    history.append({
        "t": round(now * 1000), "cpu": stats.get("cpu_pct", 0),
        "ram": stats["ram_used_gb"] / ram_total * 100 if ram_total else 0,
        "gpuUtil": g.get("util_pct"),
        "vram": g["vram_used_gb"] / g["vram_total_gb"] * 100 if g.get("vram_used_gb") is not None and g.get("vram_total_gb") else None,
        "temp": g.get("temp_c"), "power": g.get("power_w"),
    })


def recent_history() -> list[dict]:
    cutoff = (time.time() - HISTORY_SECONDS) * 1000
    return [h for h in history if h["t"] >= cutoff]


@router.get("/api/system")
def get_system() -> dict:
    return _snapshot()


@router.get("/api/logs/app")
def get_app_logs(after: int = 0) -> list[dict]:
    return [r for r in app_logs.records if r["id"] > after]


@router.websocket("/ws/system")
async def stream_system(ws: WebSocket) -> None:
    await ws.accept()
    last_log_id = 0
    try:
        await ws.send_json({"type": "history", "samples": recent_history()})
        while True:
            stats = await asyncio.to_thread(_snapshot)
            _record(stats)
            new_logs = [r for r in app_logs.records if r["id"] > last_log_id]
            if new_logs:
                last_log_id = new_logs[-1]["id"]
            await ws.send_json({"type": "stats", "stats": stats, "logs": new_logs})
            await asyncio.sleep(2)
    except WebSocketDisconnect:
        pass
