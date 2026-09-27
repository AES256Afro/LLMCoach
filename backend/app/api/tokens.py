"""API tokens, for scripts that push files into an inbox (or, with the "full" scope, use the whole API).

The token is shown once, when it's created; only its SHA-256 is stored."""
from __future__ import annotations

import hashlib
import re
import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import ApiToken, engine, get_session, utcnow

router = APIRouter(prefix="/api/tokens", tags=["tokens"])

PREFIX = "lc_"
SCOPES = ("inbox", "full")
# What an "inbox" token may do: find a project's sources and upload into one.
INBOX_ROUTES = [
    ("GET", re.compile(r"^/api/projects/?$")),
    ("GET", re.compile(r"^/api/projects/\d+/sources/?$")),
    ("POST", re.compile(r"^/api/projects/\d+/sources/\d+/upload/?$")),
]
# Never reachable with a token, whatever its scope: tokens can't mint tokens or touch sign-in.
TOKEN_FORBIDDEN = ("/api/tokens", "/api/auth")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def allowed(scope: str, method: str, path: str) -> bool:
    if path.startswith(TOKEN_FORBIDDEN):
        return False
    if scope == "full":
        return True
    return any(method == m and rx.match(path) for m, rx in INBOX_ROUTES)


def check_bearer(token: str, method: str, path: str) -> bool:
    """True if this bearer token may make this request. Records when it was last used."""
    if not token.startswith(PREFIX):
        return False
    with Session(engine) as s:
        row = s.exec(select(ApiToken).where(ApiToken.token_hash == hash_token(token))).first()
        if row is None or not allowed(row.scope, method, path):
            return False
        now = utcnow()
        last = row.last_used_at.replace(tzinfo=now.tzinfo) if row.last_used_at else None
        if last is None or now - last > timedelta(minutes=1):
            row.last_used_at = now
            s.add(row)
            s.commit()
        return True


class TokenCreate(BaseModel):
    name: str
    scope: str = "inbox"


def _out(t: ApiToken) -> dict:
    return t.model_dump(mode="json", exclude={"token_hash"})


@router.get("")
def list_tokens(session: Session = Depends(get_session)) -> list[dict]:
    return [_out(t) for t in session.exec(select(ApiToken).order_by(ApiToken.id.desc()))]


@router.post("", status_code=201)
def create_token(body: TokenCreate, session: Session = Depends(get_session)) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "give the token a name, such as the script or machine that will use it")
    if body.scope not in SCOPES:
        raise HTTPException(400, f"scope must be one of {', '.join(SCOPES)}")
    token = PREFIX + secrets.token_urlsafe(32)
    row = ApiToken(name=name[:80], prefix=token[:10], token_hash=hash_token(token), scope=body.scope)
    session.add(row)
    session.commit()
    session.refresh(row)
    return {**_out(row), "token": token}


@router.delete("/{token_id}", status_code=204)
def revoke_token(token_id: int, session: Session = Depends(get_session)) -> None:
    row = session.get(ApiToken, token_id)
    if row is None:
        raise HTTPException(404, "token not found")
    session.delete(row)
    session.commit()
