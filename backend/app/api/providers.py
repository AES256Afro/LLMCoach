import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

from ..db import Provider, ProviderKind, get_session
from ..services.providers import CLIENTS, client_for, list_providers
from ..services.providers.presets import PRESETS

router = APIRouter(prefix="/api", tags=["providers"])

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")


def _out(p: Provider) -> dict:
    d = p.model_dump(mode="json", exclude={"api_key"})
    d["has_api_key"] = bool(p.api_key)
    d["capabilities"] = PRESETS.get(p.preset, PRESETS["custom"])["capabilities"]
    return d


def _get(session: Session, provider_id: int) -> Provider:
    if (p := session.get(Provider, provider_id)) is None:
        raise HTTPException(404, "provider not found")
    return p


def _slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:32] or "provider"


class ProviderCreate(BaseModel):
    preset: str
    name: str | None = None
    slug: str | None = None
    base_url: str | None = None
    api_key: str | None = None


class ProviderUpdate(BaseModel):
    name: str | None = None
    base_url: str | None = None
    api_key: str | None = None  # "" clears it; omitted/null keeps it
    enabled: bool | None = None


class ProviderTest(BaseModel):
    preset: str
    base_url: str
    api_key: str | None = None


@router.get("/providers/presets")
def get_presets() -> dict:
    return {k: {**v, "kind": v["kind"].value} for k, v in PRESETS.items()}


@router.get("/providers")
def get_providers(session: Session = Depends(get_session)) -> list[dict]:
    return [_out(p) for p in list_providers(session)]


@router.post("/providers", status_code=201)
def create_provider(body: ProviderCreate, session: Session = Depends(get_session)) -> dict:
    preset = PRESETS.get(body.preset)
    if preset is None:
        raise HTTPException(400, f"unknown preset {body.preset!r}")
    name = (body.name or preset["name"]).strip()
    slug = body.slug or _slugify(name)
    if not SLUG_RE.match(slug):
        raise HTTPException(400, "slug must be lowercase letters, digits and dashes (max 32)")
    base_url = (body.base_url or preset["base_url"]).strip().rstrip("/")
    if not re.match(r"^https?://", base_url):
        raise HTTPException(400, "address must start with http:// or https://")
    p = Provider(slug=slug, name=name, kind=preset["kind"], preset=body.preset, base_url=base_url,
                 api_key=body.api_key or None)
    session.add(p)
    try:
        session.commit()
    except IntegrityError:
        raise HTTPException(409, f"a provider with slug {slug!r} already exists; choose another name or slug")
    session.refresh(p)
    return _out(p)


@router.patch("/providers/{provider_id}")
def update_provider(provider_id: int, body: ProviderUpdate, session: Session = Depends(get_session)) -> dict:
    p = _get(session, provider_id)
    if body.name is not None:
        p.name = body.name.strip() or p.name
    if body.base_url is not None:
        if p.builtin:
            raise HTTPException(400, "the built-in Ollama address comes from LLMCOACH_OLLAMA_URL (in BoxPilot: 'Where Ollama is')")
        if not re.match(r"^https?://", body.base_url.strip()):
            raise HTTPException(400, "address must start with http:// or https://")
        p.base_url = body.base_url.strip().rstrip("/")
    if body.api_key is not None:
        p.api_key = body.api_key or None
    if body.enabled is not None:
        p.enabled = body.enabled
    session.add(p)
    session.commit()
    session.refresh(p)
    return _out(p)


@router.delete("/providers/{provider_id}", status_code=204)
def delete_provider(provider_id: int, session: Session = Depends(get_session)) -> None:
    p = _get(session, provider_id)
    if p.builtin:
        raise HTTPException(400, "the built-in Ollama provider can be disabled but not removed")
    session.delete(p)
    session.commit()


@router.post("/providers/test")
async def test_provider(body: ProviderTest) -> dict:
    preset = PRESETS.get(body.preset)
    if preset is None:
        raise HTTPException(400, f"unknown preset {body.preset!r}")
    client = CLIENTS[ProviderKind(preset["kind"])](body.base_url.strip(), body.api_key)
    return await client.status()


async def _statuses(session: Session) -> list[dict]:
    providers = list_providers(session, enabled_only=True)
    results = await asyncio.gather(*(client_for(p).status() for p in providers))
    return [{"provider": _out(p), **r} for p, r in zip(providers, results)]


@router.get("/providers/status")
async def providers_status(session: Session = Depends(get_session)) -> list[dict]:
    return await _statuses(session)


@router.get("/models")
async def list_models(capability: str | None = None, session: Session = Depends(get_session)) -> list[dict]:
    """Every model on every reachable provider, as "<slug>/<model>" references."""
    out = []
    for st in await _statuses(session):
        caps = st["provider"]["capabilities"]
        for m in st["models"]:
            is_embed = m["embedding"]
            if capability == "chat" and (is_embed or "chat" not in caps):
                continue
            if capability == "embeddings" and ("embeddings" not in caps or not (is_embed or caps == ["embeddings"])):
                continue
            out.append({"ref": f"{st['provider']['slug']}/{m['name']}", "provider": st["provider"]["name"], **m})
    return out
