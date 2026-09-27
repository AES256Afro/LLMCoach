import pytest
from starlette.websockets import WebSocketDisconnect

from app import auth
from app.config import settings


@pytest.fixture
def auth_on(client, monkeypatch):
    monkeypatch.setattr(settings, "username", "owner")
    monkeypatch.setattr(settings, "password", "s3cret")
    client.cookies.clear()
    yield client
    client.cookies.clear()


def test_auth_disabled_without_password(client):
    assert client.get("/api/auth/me").json() == {"auth_enabled": False, "user": None}
    assert client.get("/api/jobs").status_code == 200


def test_protected_routes_require_session(auth_on):
    c = auth_on
    assert c.get("/api/health").status_code == 200  # healthcheck stays public
    assert c.get("/api/jobs").status_code == 401
    assert c.get("/api/system").status_code == 401
    assert c.get("/api/auth/me").json() == {"auth_enabled": True, "user": None}


def test_wrong_password_rejected(auth_on):
    r = auth_on.post("/api/auth/login", json={"username": "owner", "password": "nope"})
    assert r.status_code == 401
    assert auth_on.get("/api/jobs").status_code == 401


def test_login_then_logout(auth_on):
    c = auth_on
    r = c.post("/api/auth/login", json={"username": "owner", "password": "s3cret"})
    assert r.status_code == 200
    assert c.get("/api/auth/me").json() == {"auth_enabled": True, "user": "owner"}
    assert c.get("/api/jobs").status_code == 200
    c.post("/api/auth/logout")
    c.cookies.clear()  # TestClient keeps the deleted cookie around
    assert c.get("/api/jobs").status_code == 401


def test_websocket_rejected_without_session(auth_on):
    with pytest.raises(WebSocketDisconnect) as e:
        with auth_on.websocket_connect("/ws/system") as ws:
            ws.receive_json()
    assert e.value.code == 4401


def test_token_tamper_and_expiry():
    token = auth.make_token("owner", now=1000)
    assert auth.verify_token(token, now=1000) == "owner"
    assert auth.verify_token(token.replace("owner", "admin"), now=1000) is None
    assert auth.verify_token(token[:-1] + ("0" if token[-1] != "0" else "1"), now=1000) is None
    assert auth.verify_token(token, now=1000 + auth.SESSION_SECONDS + 1) is None
    assert auth.verify_token(None) is None
    assert auth.verify_token("garbage") is None


def test_ollama_status_unreachable(client, monkeypatch):
    monkeypatch.setattr(settings, "ollama_url", "http://127.0.0.1:1")
    s = client.get("/api/ollama").json()
    assert s["reachable"] is False and s["error"]
