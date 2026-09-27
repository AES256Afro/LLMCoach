"""Push alerts through ntfy (https://ntfy.sh, or a self-hosted server such as BoxPilot's).

Configured at runtime (Mission Control's alerts view, or PUT /api/notify): a topic URL, an optional
access token, and which events to send. Sending happens on a background thread so a slow or
unreachable ntfy server can never hold up the job queue.
"""
from __future__ import annotations

import logging
import threading
from typing import Any

import httpx
from sqlmodel import Session

from ..db import Setting, engine

log = logging.getLogger(__name__)

KEY = "notify"
EVENTS = {
    "train": "a training run finishes",
    "evaluate": "an evaluation finishes",
    "generate": "practice Q&A is written",
    "loop": "the learning loop promotes or keeps an adapter",
    "review": "files are held for review",
    "failed": "any job fails",
}
DEFAULTS: dict[str, Any] = {"url": "", "token": "", "events": ["train", "evaluate", "loop", "review", "failed"]}


def get_config(session: Session | None = None) -> dict[str, Any]:
    def read(s: Session) -> dict[str, Any]:
        row = s.get(Setting, KEY)
        return {**DEFAULTS, **(row.value if row and row.value else {})}

    if session is not None:
        return read(session)
    with Session(engine) as s:
        return read(s)


def save_config(session: Session, config: dict[str, Any]) -> dict[str, Any]:
    row = session.get(Setting, KEY) or Setting(key=KEY)
    row.value = {k: config[k] for k in DEFAULTS if k in config}
    session.add(row)
    session.commit()
    return get_config(session)


def post(url: str, token: str, title: str, message: str, priority: int = 3, tags: str = "") -> None:
    """Sends one message now. Raises on failure (used by the test button)."""
    # Title and tags go as query parameters rather than headers: headers can't carry UTF-8.
    params = {"title": title, "priority": str(priority)}
    if tags:
        params["tags"] = tags
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    r = httpx.post(url, params=params, content=message.encode("utf-8"), headers=headers, timeout=10)
    r.raise_for_status()


def send(event: str, title: str, message: str, priority: int = 3, tags: str = "") -> bool:
    """Queues an alert if alerts are on and this event is wanted. Never raises."""
    try:
        cfg = get_config()
    except Exception:  # the DB being busy must not break the caller
        log.exception("notify: couldn't read settings")
        return False
    if not cfg.get("url") or event not in cfg.get("events", []):
        return False

    def run() -> None:
        try:
            post(cfg["url"], cfg.get("token", ""), title, message, priority, tags)
        except Exception as e:
            log.warning("notify: sending '%s' failed: %s", title, e)

    threading.Thread(target=run, name="notify", daemon=True).start()
    return True
