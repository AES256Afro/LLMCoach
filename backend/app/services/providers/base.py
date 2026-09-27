"""Common interface for places models run.

Every provider normalizes to the same shapes, so pages and workers never care whether a
model lives in Ollama, llama.cpp, vLLM or a hosted API:

    model info:  {"name", "size_gb", "family", "parameters", "embedding"}
    chat chunk:  {"delta": str, "thinking": str, "done": bool, "stats": {...} | None}
                 ("thinking" is a reasoning model's reasoning, kept out of the answer)
    stats:       {"prompt_tokens", "completion_tokens", "tokens_per_sec", "total_ms"}  (any may be None)
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from urllib.parse import urlparse

import httpx


class ProviderError(RuntimeError):
    pass


def connection_hint(base_url: str, error: Exception) -> str:
    """Explains the usual reasons a provider can't be reached."""
    host = urlparse(base_url).hostname or ""
    if isinstance(error, httpx.ConnectError):
        if host == "host.docker.internal":
            return ("Nothing answered on this server at that port. For Ollama: install the Ollama app in BoxPilot and "
                    "keep its reach on LAN. A server bound only to 127.0.0.1 (Tailscale-only reach, or a standalone "
                    "install) can't be reached from inside LLMCoach's container.")
        if host in ("localhost", "127.0.0.1"):
            return "Nothing is listening there. Inside a container, localhost is the container itself; use host.docker.internal."
        return f"Couldn't connect to {host}. Check the address, and that the server listens on 0.0.0.0, not only 127.0.0.1."
    if isinstance(error, httpx.TimeoutException):
        return "The server didn't answer in time. It may be busy loading a large model."
    if isinstance(error, httpx.HTTPStatusError) and error.response.status_code in (401, 403):
        return "The server refused the request. Check the API key."
    return "Unexpected response. Check that the address points at the model server's API."


class ProviderClient(ABC):
    kind: str

    def __init__(self, base_url: str, api_key: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or None

    def _err(self, e: Exception, what: str) -> ProviderError:
        return ProviderError(f"{what}: {type(e).__name__}: {e}. {connection_hint(self.base_url, e)}")

    @abstractmethod
    async def status(self) -> dict:
        """{"reachable", "version", "models", "error", "hint"}. Never raises."""

    @abstractmethod
    def chat_stream(self, model: str, messages: list[dict], options: dict | None = None) -> AsyncIterator[dict]:
        """Yields normalized chat chunks; the last has done=True and stats."""

    @abstractmethod
    async def embed(self, model: str, texts: list[str], kind: str = "query") -> list[list[float]]: ...

    @abstractmethod
    def sync_chat(self, model: str, messages: list[dict], options: dict | None = None,
                  json_schema: dict | None = None, timeout: float = 600) -> dict:
        """Non-streaming chat for workers: {"content": str, "thinking": str, "stats": {...}}."""

    @abstractmethod
    def sync_embed(self, model: str, texts: list[str], kind: str = "document", timeout: float = 300) -> list[list[float]]: ...


# Some embedding models are trained with task prefixes; using them noticeably improves retrieval.
EMBED_PREFIXES = {
    "nomic-embed-text": ("search_document: ", "search_query: "),
    "mxbai-embed-large": ("", "Represent this sentence for searching relevant passages: "),
}


def embed_prefix(model: str, kind: str) -> str:
    base = model.split(":")[0].split("/")[-1].lower()
    for name, (doc, query) in EMBED_PREFIXES.items():
        if base.startswith(name):
            return doc if kind == "document" else query
    return ""


def looks_like_embedding_model(name: str, family: str = "") -> bool:
    n = name.lower()
    return "embed" in n or "bge-" in n or "e5-" in n or family in ("bert", "nomic-bert")
