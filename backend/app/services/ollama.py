"""Client for the Ollama server (on BigBox: BoxPilot's Ollama app)."""
from __future__ import annotations

import httpx

from ..config import settings


async def status() -> dict:
    """Reachability, version and installed models. Never raises."""
    base = settings.ollama_url.rstrip("/")
    out: dict = {"url": base, "reachable": False, "version": None, "models": [], "error": None}
    try:
        async with httpx.AsyncClient(timeout=4) as client:
            out["version"] = (await client.get(f"{base}/api/version")).json().get("version")
            tags = (await client.get(f"{base}/api/tags")).json().get("models", [])
    except (httpx.HTTPError, ValueError) as e:
        out["error"] = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
        return out
    out["reachable"] = True
    out["models"] = [
        {
            "name": m.get("name"),
            "size_gb": round(m.get("size", 0) / 1024**3, 2),
            "family": (m.get("details") or {}).get("family"),
            "parameters": (m.get("details") or {}).get("parameter_size"),
            "embedding": "embed" in (m.get("name") or "") or "bert" in ((m.get("details") or {}).get("family") or ""),
        }
        for m in tags
    ]
    return out
