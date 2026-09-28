from app.services.web import page_name
from tests.test_jobs import wait_final


def test_page_names():
    assert page_name("https://x.org/a", ".html", b"<title>Harbor &amp; Ferry: Guide</title>") == "Harbor Ferry Guide.html"
    assert page_name("https://x.org/docs/install%20guide.pdf", ".pdf", b"%PDF") == "install guide.pdf"
    assert page_name("https://x.org/", ".html", b"<p>no title</p>") == "x.org.html"


def test_add_a_web_page(client, fake):
    pid = client.post("/api/projects", json={"name": "web-pages"}).json()["id"]
    r = client.post(f"/api/projects/{pid}/documents/url", json={"url": f"{fake.url}/pages/redirect"})
    assert r.status_code == 201, r.text
    out = r.json()
    doc = out["documents"][0]
    # Named after its title, and the address it ended up at is kept for citations.
    assert doc["filename"] == "Harbor Ferry Guide.html" and doc["source_url"] == f"{fake.url}/pages/harbor.html"
    assert wait_final(client, out["job"]["id"])["status"] == "done"
    hits = client.post(f"/api/projects/{pid}/search", json={"query": "when does the ferry leave", "top_k": 2}).json()["results"]
    assert hits and "07:40" in hits[0]["text"]

    again = client.post(f"/api/projects/{pid}/documents/url", json={"url": f"{fake.url}/pages/harbor.html"}).json()
    assert again["documents"] == [] and again["skipped"][0]["reason"] == "already in this knowledge base"
    for url, why in ((f"ftp://{fake.url[7:]}/x", "http"), (f"{fake.url}/pages/logo.png", "image/png"),
                     (f"{fake.url}/pages/missing", "404")):
        r = client.post(f"/api/projects/{pid}/documents/url", json={"url": url})
        assert r.status_code == 400 and why in r.json()["detail"], (url, r.text)

    # From a chat, as /add <url> sends it.
    r = client.post(f"/api/projects/{pid}/chat/attach", data={"mode": "remember", "url": f"{fake.url}/pages/notes.txt"})
    card = r.json()["message"]["data"]
    assert [d["filename"] for d in card["documents"]] == ["notes.txt"]
    wait_final(client, card["ingest_job_id"])
    docs = {d["filename"]: d for d in client.get(f"/api/projects/{pid}/documents").json()}
    assert docs["notes.txt"]["source_url"] == f"{fake.url}/pages/notes.txt"
