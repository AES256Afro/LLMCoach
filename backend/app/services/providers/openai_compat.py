"""Any OpenAI-compatible API: llama.cpp's llama-server, vLLM, LM Studio, LocalAI,
text-generation-webui, OpenRouter, OpenAI...

base_url is the API root including the version segment, e.g. http://host:8080/v1.
"""
from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator

import httpx

from .base import ProviderClient, ProviderError, connection_hint, embed_prefix, looks_like_embedding_model


def _usage_stats(usage: dict | None, elapsed_s: float, first_token_s: float | None) -> dict:
    usage = usage or {}
    n = usage.get("completion_tokens")
    gen_s = elapsed_s - (first_token_s or 0)
    return {
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": n,
        "tokens_per_sec": round(n / gen_s, 1) if n and gen_s > 0 else None,
        "total_ms": round(elapsed_s * 1000),
    }


class OpenAICompatClient(ProviderClient):
    kind = "openai"

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}

    async def status(self) -> dict:
        out: dict = {"reachable": False, "version": None, "models": [], "error": None, "hint": None}
        try:
            async with httpx.AsyncClient(timeout=6, headers=self._headers()) as c:
                r = await c.get(f"{self.base_url}/models")
                r.raise_for_status()
                data = r.json().get("data", [])
        except (httpx.HTTPError, ValueError) as e:
            out["error"] = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
            out["hint"] = connection_hint(self.base_url, e)
            return out
        out["reachable"] = True
        out["models"] = [
            {"name": m.get("id"), "size_gb": None, "family": m.get("owned_by"), "parameters": None,
             "embedding": looks_like_embedding_model(m.get("id") or "")}
            for m in data
        ]
        return out

    def _chat_body(self, model: str, messages: list[dict], options: dict | None, stream: bool) -> dict:
        o = options or {}
        body: dict = {"model": model, "messages": messages, "stream": stream}
        # Map Ollama-style option names onto the OpenAI ones.
        for src, dst in (("temperature", "temperature"), ("top_p", "top_p"), ("num_predict", "max_tokens"),
                         ("seed", "seed"), ("stop", "stop")):
            if o.get(src) is not None:
                body[dst] = o[src]
        if stream:
            body["stream_options"] = {"include_usage": True}
        return body

    async def chat_stream(self, model: str, messages: list[dict], options: dict | None = None) -> AsyncIterator[dict]:
        body = self._chat_body(model, messages, options, stream=True)
        start, first, usage = time.perf_counter(), None, None
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=600), headers=self._headers()) as c:
                async with c.stream("POST", f"{self.base_url}/chat/completions", json=body) as r:
                    if r.status_code != 200:
                        raise ProviderError(f"server returned {r.status_code}: {(await r.aread()).decode(errors='replace')[:300]}")
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            break
                        chunk = json.loads(payload)
                        if "error" in chunk:
                            raise ProviderError(str(chunk["error"]))
                        usage = chunk.get("usage") or usage
                        for choice in chunk.get("choices") or []:
                            delta = (choice.get("delta") or {}).get("content") or ""
                            if delta:
                                first = first or (time.perf_counter() - start)
                                yield {"delta": delta, "done": False, "stats": None}
        except httpx.HTTPError as e:
            raise self._err(e, "chat") from e
        yield {"delta": "", "done": True, "stats": _usage_stats(usage, time.perf_counter() - start, first)}

    def _embed_body(self, model: str, texts: list[str], kind: str) -> dict:
        p = embed_prefix(model, kind)
        return {"model": model, "input": [p + t for t in texts]}

    @staticmethod
    def _vectors(r: httpx.Response, model: str) -> list[list[float]]:
        if r.status_code != 200:
            raise ProviderError(f"embedding with {model} failed ({r.status_code}): {r.text[:300]}")
        rows = sorted(r.json()["data"], key=lambda d: d.get("index", 0))
        return [row["embedding"] for row in rows]

    async def embed(self, model: str, texts: list[str], kind: str = "query") -> list[list[float]]:
        try:
            async with httpx.AsyncClient(timeout=120, headers=self._headers()) as c:
                r = await c.post(f"{self.base_url}/embeddings", json=self._embed_body(model, texts, kind))
        except httpx.HTTPError as e:
            raise self._err(e, "embed") from e
        return self._vectors(r, model)

    def sync_embed(self, model: str, texts: list[str], kind: str = "document", timeout: float = 300) -> list[list[float]]:
        try:
            r = httpx.post(f"{self.base_url}/embeddings", json=self._embed_body(model, texts, kind),
                           headers=self._headers(), timeout=timeout)
        except httpx.HTTPError as e:
            raise self._err(e, "embed") from e
        return self._vectors(r, model)

    def sync_chat(self, model: str, messages: list[dict], options: dict | None = None,
                  json_schema: dict | None = None, timeout: float = 600) -> dict:
        body = self._chat_body(model, messages, options, stream=False)
        if json_schema is not None:
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": "output", "schema": json_schema}}
        start = time.perf_counter()
        try:
            r = httpx.post(f"{self.base_url}/chat/completions", json=body, headers=self._headers(), timeout=timeout)
        except httpx.HTTPError as e:
            raise self._err(e, "chat") from e
        if r.status_code != 200:
            raise ProviderError(f"chat with {model} failed ({r.status_code}): {r.text[:300]}")
        data = r.json()
        content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        return {"content": content, "stats": _usage_stats(data.get("usage"), time.perf_counter() - start, None)}
