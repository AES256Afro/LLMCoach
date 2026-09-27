"""Incremental file tailing used by the WebSocket endpoints."""
from __future__ import annotations

import json
from pathlib import Path


class FileTail:
    """Returns only the new complete lines of a file each time read_new() is called."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.offset = 0
        self._partial = b""

    def read_new(self, max_bytes: int = 1 << 20) -> list[str]:
        try:
            with open(self.path, "rb") as f:
                f.seek(self.offset)
                chunk = f.read(max_bytes)
        except FileNotFoundError:
            return []
        if not chunk:
            return []
        self.offset += len(chunk)
        data = self._partial + chunk
        lines = data.split(b"\n")
        self._partial = lines.pop()  # incomplete trailing line (or b"")
        return [ln.decode("utf-8", errors="replace").rstrip("\r") for ln in lines]


def parse_jsonl(lines: list[str]) -> list[dict]:
    out = []
    for ln in lines:
        if ln.strip():
            try:
                out.append(json.loads(ln))
            except json.JSONDecodeError:
                pass
    return out
