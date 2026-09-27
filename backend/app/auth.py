"""Single-owner password sign-in.

Enabled when LLMCOACH_PASSWORD is set (BoxPilot generates it on install and shows it
in the app's Sign in panel). With no password configured, auth is off for local dev.

Sessions are a signed cookie: "<username>.<expiry>.<hmac>". No server-side state.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import secrets
import time
from http.cookies import SimpleCookie

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from .config import settings

COOKIE = "llmcoach_session"
SESSION_SECONDS = 30 * 24 * 3600
# Paths reachable without a session. Everything else under /api and /ws is protected;
# the static UI itself is public so the login screen can load.
PUBLIC_PATHS = {"/api/health", "/api/auth/login", "/api/auth/me", "/api/auth/logout"}

# Without a configured secret, sessions last until the process restarts.
_secret = (settings.session_secret or secrets.token_hex(32)).encode()


def auth_enabled() -> bool:
    return bool(settings.password)


def _sign(payload: str) -> str:
    return hmac.new(_secret, payload.encode(), hashlib.sha256).hexdigest()


def make_token(username: str, now: float | None = None) -> str:
    payload = f"{username}.{int((now or time.time()) + SESSION_SECONDS)}"
    return f"{payload}.{_sign(payload)}"


def verify_token(token: str | None, now: float | None = None) -> str | None:
    """Returns the username for a valid, unexpired token."""
    if not token:
        return None
    payload, _, sig = token.rpartition(".")
    username, _, expiry = payload.rpartition(".")
    if not (username and expiry.isdigit() and hmac.compare_digest(sig, _sign(payload))):
        return None
    if int(expiry) < (now or time.time()):
        return None
    return username


def _cookie_from_scope(scope) -> str | None:
    for name, value in scope.get("headers", []):
        if name == b"cookie":
            jar = SimpleCookie()
            jar.load(value.decode("latin-1"))
            if COOKIE in jar:
                return jar[COOKIE].value
    return None


class AuthMiddleware:
    """Pure ASGI so it covers WebSockets as well as HTTP."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket") or not auth_enabled():
            return await self.app(scope, receive, send)
        path = scope["path"]
        protected = (path.startswith("/api/") or path.startswith("/ws/")) and path not in PUBLIC_PATHS
        if not protected or verify_token(_cookie_from_scope(scope)):
            return await self.app(scope, receive, send)

        if scope["type"] == "websocket":
            # Accept-then-close so browsers see code 4401 (a pre-accept close is just a 403/1006).
            await receive()  # websocket.connect
            await send({"type": "websocket.accept"})
            await send({"type": "websocket.close", "code": 4401})
            return
        body = b'{"detail":"sign in required"}'
        await send({"type": "http.response.start", "status": 401,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


router = APIRouter(prefix="/api/auth", tags=["auth"])


class Login(BaseModel):
    username: str
    password: str


@router.get("/me")
def me(request: Request) -> dict:
    if not auth_enabled():
        return {"auth_enabled": False, "user": None}
    return {"auth_enabled": True, "user": verify_token(request.cookies.get(COOKIE))}


@router.post("/login")
async def login(body: Login, response: Response) -> dict:
    if not auth_enabled():
        return {"auth_enabled": False, "user": None}
    ok_user = hmac.compare_digest(body.username.encode(), settings.username.encode())
    ok_pass = hmac.compare_digest(body.password.encode(), settings.password.encode())
    if not (ok_user and ok_pass):
        await asyncio.sleep(1)  # slow down guessing
        raise HTTPException(401, "wrong username or password")
    response.set_cookie(COOKIE, make_token(body.username), max_age=SESSION_SECONDS,
                        httponly=True, samesite="lax", path="/")
    return {"auth_enabled": True, "user": body.username}


@router.post("/logout")
def logout(response: Response) -> dict:
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}
