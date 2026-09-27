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


def test_api_docs_need_a_session(auth_on):
    assert auth_on.get("/openapi.json").status_code == 401
    assert auth_on.get("/docs").status_code == 401


def test_session_cookie_is_secure_behind_https(auth_on):
    creds = {"username": "owner", "password": "s3cret"}
    plain = auth_on.post("/api/auth/login", json=creds)
    assert "secure" not in plain.headers["set-cookie"].lower()
    proxied = auth_on.post("/api/auth/login", json=creds, headers={"X-Forwarded-Proto": "https"})
    assert "secure" in proxied.headers["set-cookie"].lower()


def test_spa_fallback_is_not_used_for_unknown_api_paths(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.main import SPAStaticFiles

    (tmp_path / "index.html").write_text("<html>app</html>")
    spa = FastAPI()
    spa.mount("/", SPAStaticFiles(directory=tmp_path, html=True))
    with TestClient(spa) as c:
        assert c.get("/some/client/route").text == "<html>app</html>"
        r = c.get("/api/nope")
        assert r.status_code == 404 and r.json() == {"detail": "Not Found"}


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


