from app.services.web import page_name
from tests.test_jobs import wait_final


def test_page_names():
    assert page_name("https://x.org/a", ".html", b"<title>Harbor &amp; Ferry: Guide</title>") == "Harbor Ferry Guide.html"
    assert page_name("https://x.org/docs/install%20guide.pdf", ".pdf", b"%PDF") == "install guide.pdf"
    assert page_name("https://x.org/", ".html", b"<p>no title</p>") == "x.org.html"


def test_web_source_rereads_its_pages(client, fake):
    pid = client.post("/api/projects", json={"name": "web-source"}).json()["id"]
    base = f"{fake.url}/pages"
    assert client.post(f"/api/projects/{pid}/sources", json={"kind": "web", "urls": []}).status_code == 400
    assert client.post(f"/api/projects/{pid}/sources", json={"kind": "web", "urls": ["notaurl"]}).status_code == 400
    r = client.post(f"/api/projects/{pid}/sources", json={
        "kind": "web", "name": "Harbor site", "poll_seconds": 86400,
        "urls": [f"{base}/harbor.html", f"{base}/changelog.html", f"{base}/missing", f"{base}/harbor.html"]})
    assert r.status_code == 201, r.text
    src = r.json()
    assert src["kind"] == "web" and len(src["urls"]) == 3 and src["path"] == "3 web pages"  # duplicates dropped
    scan = lambda: client.post(f"/api/projects/{pid}/sources/{src['id']}/scan").json()  # noqa: E731
    fake.app.state.page_version = 1
    out = scan()
    assert out["processed"] == {"added": 2}
    wait_final(client, out["ingest_job_id"])
    listed = next(x for x in client.get(f"/api/projects/{pid}/sources").json() if x["id"] == src["id"])
    assert "404" in listed["last_error"] and "keep their last version" in listed["last_error"]
    docs = {d["filename"]: d for d in client.get(f"/api/projects/{pid}/documents").json()}
    assert docs["Changelog.html"]["source_url"] == f"{base}/changelog.html"

    # Unchanged pages are left alone; a changed one replaces its document in the same look.
    assert scan()["processed"] == {}
    fake.app.state.page_version = 2
    out = scan()
    assert out["processed"] == {"added": 1}
    wait_final(client, out["ingest_job_id"])
    docs2 = {d["filename"]: d for d in client.get(f"/api/projects/{pid}/documents").json()}
    assert docs2["Changelog.html"]["id"] != docs["Changelog.html"]["id"]
    assert docs2["Harbor Ferry Guide.html"]["id"] == docs["Harbor Ferry Guide.html"]["id"]

    # Taking an address off the list is like deleting the file: its document stays unless mirroring.
    client.patch(f"/api/projects/{pid}/sources/{src['id']}", json={"urls": [f"{base}/harbor.html"]})
    scan()
    files = {f["relpath"]: f for f in client.get(f"/api/projects/{pid}/sources/{src['id']}/files").json()["files"]}
    assert files["Changelog.html"]["status"] == "gone"
    r = client.post(f"/api/projects/{pid}/sources/{src['id']}/upload", files=[("files", ("x.md", b"# x", "text/markdown"))])
    assert r.status_code == 400 and "web pages" in r.json()["detail"]
    assert client.delete(f"/api/projects/{pid}/sources/{src['id']}").status_code == 204


def test_web_source_follows_a_sitemap(client, fake):
    pid = client.post("/api/projects", json={"name": "web-sitemap"}).json()["id"]
    src = client.post(f"/api/projects/{pid}/sources", json={"kind": "web", "urls": [f"{fake.url}/pages/sitemap.xml"]}).json()
    out = client.post(f"/api/projects/{pid}/sources/{src['id']}/scan").json()
    assert out["processed"] == {"added": 2}  # the index -> one sitemap -> two pages
    wait_final(client, out["ingest_job_id"])
    docs = {d["filename"]: d["source_url"] for d in client.get(f"/api/projects/{pid}/documents").json()}
    assert docs == {"Harbor Ferry Guide.html": f"{fake.url}/pages/harbor.html", "notes.txt": f"{fake.url}/pages/notes.txt"}


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
