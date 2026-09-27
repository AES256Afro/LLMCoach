"""Ollama's native API (on BigBox: BoxPilot's Ollama app)."""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator

import httpx

from .base import ProviderClient, ProviderError, connection_hint, embed_prefix, looks_like_embedding_model


def _stats(final: dict) -> dict:
    ns = final.get("eval_duration") or 0
    n = final.get("eval_count")
    return {
        "prompt_tokens": final.get("prompt_eval_count"),
        "completion_tokens": n,
        "tokens_per_sec": round(n / (ns / 1e9), 1) if n and ns else None,
        "total_ms": round((final.get("total_duration") or 0) / 1e6) or None,
    }


# model name -> (capabilities reported by /api/show ("completion", "thinking", "embedding", ...), expiry).
# Successful lookups are kept for good; failed ones (server down, model not pulled yet) are retried.
_CAPS: dict[tuple[str, str], tuple[set[str], float]] = {}
_CAPS_RETRY_SECONDS = 60

# Ollama's default context window is small (2048-4096 tokens) and it silently drops the start of a
# longer prompt, which is where the system message with the retrieved passages is.
MIN_CTX, MAX_CTX = 4096, 32768
REPLY_BUDGET = 1024  # tokens reserved for the reply when the caller sets no num_predict


def _context_window(messages: list[dict], options: dict) -> None:
    """Sets options["num_ctx"] big enough for the prompt plus the reply, unless the caller chose one."""
    if "num_ctx" in options:
        return
    prompt = sum(len(m.get("content") or "") for m in messages) // 4 + 8 * len(messages)  # ~4 chars/token
    predict = options.get("num_predict")
    need = prompt + (predict if isinstance(predict, int) and predict > 0 else REPLY_BUDGET)
    ctx = MIN_CTX
    while ctx < need and ctx < MAX_CTX:
        ctx *= 2
    options["num_ctx"] = ctx


class OllamaClient(ProviderClient):
    kind = "ollama"

    def _think_setting(self, model: str, options: dict) -> bool | None:
        """Reasoning models (qwen3, deepseek-r1...) put their reasoning in a separate field when
        asked to think; without it, it leaks into the answer. Others reject the flag entirely."""
        want = options.pop("think", True)
        caps, expiry = _CAPS.get((self.base_url, model), (None, 0.0))
        if caps is None or time.monotonic() >= expiry:
            try:
                r = httpx.post(f"{self.base_url}/api/show", json={"model": model}, headers=self._headers(), timeout=10)
                ok = r.status_code == 200
                caps = set(r.json().get("capabilities") or []) if ok else set()
            except (httpx.HTTPError, ValueError):
                ok, caps = False, set()
            _CAPS[(self.base_url, model)] = (caps, float("inf") if ok else time.monotonic() + _CAPS_RETRY_SECONDS)
        return bool(want) if "thinking" in caps else None

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}

    async def status(self) -> dict:
        out: dict = {"reachable": False, "version": None, "models": [], "error": None, "hint": None}
        try:
            async with httpx.AsyncClient(timeout=4, headers=self._headers()) as c:
                out["version"] = (await c.get(f"{self.base_url}/api/version")).json().get("version")
                r = await c.get(f"{self.base_url}/api/tags")
                r.raise_for_status()
                tags = r.json().get("models", [])
        except (httpx.HTTPError, ValueError) as e:
            out["error"] = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
            out["hint"] = connection_hint(self.base_url, e)
            return out
        out["reachable"] = True
        for m in tags:
            d = m.get("details") or {}
            out["models"].append({
                "name": m.get("name"),
                "size_gb": round(m.get("size", 0) / 1024**3, 2),
                "family": d.get("family"),
                "parameters": d.get("parameter_size"),
                "embedding": looks_like_embedding_model(m.get("name") or "", d.get("family") or ""),
            })
        return out

    async def chat_stream(self, model: str, messages: list[dict], options: dict | None = None) -> AsyncIterator[dict]:
        options = dict(options or {})
        think = await asyncio.to_thread(self._think_setting, model, options)
        _context_window(messages, options)
        body = {"model": model, "messages": messages, "stream": True, "options": options}
        if think is not None:
            body["think"] = think
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=600), headers=self._headers()) as c:
                async with c.stream("POST", f"{self.base_url}/api/chat", json=body) as r:
                    if r.status_code != 200:
                        raise ProviderError(f"Ollama returned {r.status_code}: {(await r.aread()).decode(errors='replace')[:300]}")
                    async for line in r.aiter_lines():
                        if not line.strip():
                            continue
                        chunk = json.loads(line)
                        if "error" in chunk:
                            raise ProviderError(chunk["error"])
                        done = bool(chunk.get("done"))
                        msg = chunk.get("message") or {}
                        yield {"delta": msg.get("content", ""), "thinking": msg.get("thinking") or "", "done": done,
                               "stats": _stats(chunk) if done else None}
        except httpx.HTTPError as e:
            raise self._err(e, "chat") from e

    def _embed_body(self, model: str, texts: list[str], kind: str) -> dict:
        p = embed_prefix(model, kind)
        return {"model": model, "input": [p + t for t in texts], "truncate": True}

    async def embed(self, model: str, texts: list[str], kind: str = "query") -> list[list[float]]:
        try:
            async with httpx.AsyncClient(timeout=120, headers=self._headers()) as c:
                r = await c.post(f"{self.base_url}/api/embed", json=self._embed_body(model, texts, kind))
        except httpx.HTTPError as e:
            raise self._err(e, "embed") from e
        if r.status_code != 200:
            raise ProviderError(f"embedding with {model} failed ({r.status_code}): {r.text[:300]}")
        return r.json()["embeddings"]

    def sync_embed(self, model: str, texts: list[str], kind: str = "document", timeout: float = 300) -> list[list[float]]:
        try:
            r = httpx.post(f"{self.base_url}/api/embed", json=self._embed_body(model, texts, kind),
                           headers=self._headers(), timeout=timeout)
        except httpx.HTTPError as e:
            raise self._err(e, "embed") from e
        if r.status_code != 200:
            raise ProviderError(f"embedding with {model} failed ({r.status_code}): {r.text[:300]}")
        return r.json()["embeddings"]

    def sync_chat(self, model: str, messages: list[dict], options: dict | None = None,
                  json_schema: dict | None = None, timeout: float = 600) -> dict:
        options = dict(options or {})
        think = self._think_setting(model, options)
        _context_window(messages, options)
        body: dict = {"model": model, "messages": messages, "stream": False, "options": options}
        if think is not None:
            body["think"] = think
        if json_schema is not None:
            body["format"] = json_schema
        try:
            r = httpx.post(f"{self.base_url}/api/chat", json=body, headers=self._headers(), timeout=timeout)
        except httpx.HTTPError as e:
            raise self._err(e, "chat") from e
        if r.status_code != 200:
            raise ProviderError(f"chat with {model} failed ({r.status_code}): {r.text[:300]}")
        data = r.json()
        msg = data.get("message") or {}
        return {"content": msg.get("content", ""), "thinking": msg.get("thinking") or "", "stats": _stats(data)}
