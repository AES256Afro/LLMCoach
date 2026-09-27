"""Provider registry.

Model references are "<provider slug>/<model>", e.g. "ollama/hermes3:8b" or
"llamacpp/Qwen/Qwen3-4B" (only the first "/" separates the slug). A bare name
without a known slug is taken to mean the built-in Ollama provider.
"""
from __future__ import annotations

from sqlmodel import Session, select

from ...config import settings
from ...db import Provider, ProviderKind, engine
from .base import ProviderClient, ProviderError
from .ollama import OllamaClient
from .openai_compat import OpenAICompatClient

BUILTIN_SLUG = "ollama"
CLIENTS: dict[ProviderKind, type[ProviderClient]] = {
    ProviderKind.ollama: OllamaClient,
    ProviderKind.openai: OpenAICompatClient,
}

__all__ = ["ProviderError", "ensure_builtin", "client_for", "resolve", "split_ref", "list_providers"]


def ensure_builtin(session: Session) -> None:
    """Creates or refreshes the built-in Ollama provider from LLMCOACH_OLLAMA_URL."""
    p = session.exec(select(Provider).where(Provider.slug == BUILTIN_SLUG)).first()
    if p is None:
        p = Provider(slug=BUILTIN_SLUG, name="Ollama", kind=ProviderKind.ollama, preset="ollama",
                     base_url=settings.ollama_url, builtin=True)
    else:
        p.base_url, p.kind, p.preset, p.builtin = settings.ollama_url, ProviderKind.ollama, "ollama", True
    session.add(p)
    session.commit()


def client_for(p: Provider) -> ProviderClient:
    return CLIENTS[p.kind](p.base_url, p.api_key)


def list_providers(session: Session, enabled_only: bool = False) -> list[Provider]:
    q = select(Provider).order_by(Provider.builtin.desc(), Provider.name)
    if enabled_only:
        q = q.where(Provider.enabled == True)  # noqa: E712
    return list(session.exec(q))


def split_ref(ref: str, known_slugs: set[str]) -> tuple[str, str]:
    slug, sep, model = ref.partition("/")
    if sep and slug in known_slugs:
        return slug, model
    return BUILTIN_SLUG, ref


def resolve(ref: str, session: Session | None = None) -> tuple[ProviderClient, str, Provider]:
    """Turns a model reference into (client, model name, provider row)."""
    own = session is None
    s = session or Session(engine)
    try:
        providers = {p.slug: p for p in list_providers(s)}
        slug, model = split_ref(ref, set(providers))
        p = providers.get(slug)
        if p is None:
            raise ProviderError(f"unknown provider {slug!r} in model reference {ref!r}")
        if not p.enabled:
            raise ProviderError(f"provider {p.name!r} is disabled")
        if not model:
            raise ProviderError(f"no model named in {ref!r}")
        s.expunge(p)
        return client_for(p), model, p
    finally:
        if own:
            s.close()
