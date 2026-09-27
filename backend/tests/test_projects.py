import sqlite3

from sqlalchemy import create_engine, inspect

from app import db


def test_settings_merge_and_reset(client):
    p = client.post("/api/projects", json={"name": "settings-test"}).json()
    assert p["settings"]["embed_model"] == "ollama/nomic-embed-text"

    p = client.patch(f"/api/projects/{p['id']}", json={"settings": {"chunk_size": 400, "chat_model": "hermes3:8b"}}).json()
    assert p["settings"]["chunk_size"] == 400 and p["settings"]["chat_model"] == "hermes3:8b"
    assert p["settings"]["chunk_overlap"] == 150  # untouched default

    p = client.patch(f"/api/projects/{p['id']}", json={"settings": {"chunk_size": None}}).json()
    assert p["settings"]["chunk_size"] == 1000  # reset to default
    assert p["settings"]["chat_model"] == "hermes3:8b"

    r = client.patch(f"/api/projects/{p['id']}", json={"settings": {"bogus": 1}})
    assert r.status_code == 400


def test_migration_adds_columns_to_old_database(tmp_path, monkeypatch):
    # The schema BigBox's v0.1.1 install created: project has no settings column.
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE project (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, description VARCHAR NOT NULL, created_at DATETIME NOT NULL)")
    con.execute("INSERT INTO project VALUES (1, 'old', '', '2026-09-27 00:00:00')")
    con.commit()
    con.close()

    old_engine = create_engine(f"sqlite:///{path}")
    monkeypatch.setattr(db, "engine", old_engine)
    db.SQLModel.metadata.create_all(old_engine)
    db._add_missing_columns()

    cols = {c["name"] for c in inspect(old_engine).get_columns("project")}
    assert "settings" in cols
    assert inspect(old_engine).has_table("document")
    with db.Session(old_engine) as s:
        p = s.get(db.Project, 1)
        assert p.name == "old" and p.effective_settings()["top_k"] == 5
