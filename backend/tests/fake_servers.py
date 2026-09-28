"""Tiny stand-ins for Ollama and an OpenAI-compatible server, run on a real port so
the provider clients are exercised over HTTP exactly as in production."""
import json
import socket
import threading
import time

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

REPLY = ["Hello", " from", " the", " fake."]


def _vec(text: str) -> list[float]:
    # Deterministic 8-dim "embedding": character histogram, so similar texts score higher.
    v = [0.0] * 8
    for ch in text.lower():
        v[ord(ch) % 8] += 1
    norm = sum(x * x for x in v) ** 0.5 or 1
    return [x / norm for x in v]


def fake_app() -> FastAPI:
    app = FastAPI()
    app.state.embed_inputs = []
    app.state.chat_bodies = []

    # ---- Ollama -------------------------------------------------------------------
    @app.get("/api/version")
    def version():
        return {"version": "0.0-fake"}

    @app.get("/api/tags")
    def tags():
        return {"models": [
            {"name": "chatty:1b", "size": 1024**3, "details": {"family": "llama", "parameter_size": "1B"}},
            {"name": "nomic-embed-text:latest", "size": 1024**2 * 270, "details": {"family": "nomic-bert"}},
        ]}

    @app.post("/api/chat")
    async def ollama_chat(req: Request):
        body = await req.json()
        app.state.chat_bodies.append(body)
        if body.get("format") and "score" in body["format"].get("properties", {}):  # eval judge
            return {"message": {"content": json.dumps({"score": 4, "reason": "Mostly right."})}, "done": True}
        if body.get("format"):  # structured output: dataset generation
            n = len(app.state.chat_bodies)
            pairs = [{"question": f"Question {n}-{i}?", "answer": f"Answer {n}-{i}."} for i in range(3)]
            return {"message": {"content": json.dumps({"pairs": pairs})}, "done": True,
                    "eval_count": 30, "eval_duration": 1e9}
        if not body.get("stream"):
            return {"message": {"content": "".join(REPLY)}, "done": True, "eval_count": 4, "eval_duration": 2e9}

        def gen():
            for t in REPLY:
                yield json.dumps({"message": {"content": t}, "done": False}) + "\n"
            yield json.dumps({"message": {"content": ""}, "done": True, "prompt_eval_count": 7,
                              "eval_count": 4, "eval_duration": 2e9, "total_duration": 3e9}) + "\n"
        return StreamingResponse(gen(), media_type="application/x-ndjson")

    @app.post("/api/embed")
    async def ollama_embed(req: Request):
        body = await req.json()
        app.state.embed_inputs.extend(body["input"])
        return {"embeddings": [_vec(t) for t in body["input"]]}

    # ---- OpenAI-compatible -------------------------------------------------------
    @app.get("/v1/models")
    def models(req: Request):
        return {"data": [{"id": "Qwen/Qwen3-4B", "owned_by": "llamacpp"}, {"id": "bge-small-embed", "owned_by": "x"}]}

    @app.post("/v1/chat/completions")
    async def oai_chat(req: Request):
        body = await req.json()
        if not body.get("stream"):
            return {"choices": [{"message": {"content": "".join(REPLY)}}],
                    "usage": {"prompt_tokens": 7, "completion_tokens": 4}}

        def gen():
            for t in REPLY:
                yield "data: " + json.dumps({"choices": [{"delta": {"content": t}}]}) + "\n\n"
            yield "data: " + json.dumps({"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 4}}) + "\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")

    @app.post("/v1/embeddings")
    async def oai_embed(req: Request):
        body = await req.json()
        return {"data": [{"index": i, "embedding": _vec(t)} for i, t in enumerate(body["input"])]}

    # ---- ntfy ---------------------------------------------------------------------
    app.state.ntfy = []

    @app.post("/ntfy/{topic}")
    async def ntfy(topic: str, request: Request):
        app.state.ntfy.append({"topic": topic, "params": dict(request.query_params),
                               "auth": request.headers.get("authorization"),
                               "message": (await request.body()).decode("utf-8")})
        return {"id": str(len(app.state.ntfy)), "topic": topic}

    return app


def fake_s3_app(access_key: str, secret_key: str) -> FastAPI:
    """A path-style S3 stand-in: ListObjectsV2 (two keys a page, to exercise continuation) and
    GetObject, refusing any request whose SigV4 signature doesn't check out."""
    from datetime import UTC, datetime
    from email.utils import formatdate
    from urllib.parse import parse_qsl
    from xml.sax.saxutils import escape

    from fastapi.responses import Response

    from app.services.s3 import sign

    app = FastAPI()
    app.state.buckets = {}  # bucket -> {key: (bytes, unix mtime)}
    app.state.requests = []

    def error(status: int, code: str, message: str) -> Response:
        body = f"<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>{code}</Code><Message>{message}</Message></Error>"
        return Response(body, status_code=status, media_type="application/xml")

    def verified(request: Request) -> bool:
        raw_path = request.scope["raw_path"].decode()
        params = parse_qsl(request.scope["query_string"].decode(), keep_blank_values=True)
        stamp = request.headers.get("x-amz-date", "")
        try:
            now = datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
        except ValueError:
            return False
        region = request.headers.get("authorization", "").split("/")[2] if "/" in request.headers.get("authorization", "") else ""
        want = sign(request.method, request.headers["host"], raw_path, params, access_key, secret_key, region, now)
        app.state.requests.append((raw_path, dict(params)))
        return request.headers.get("authorization") == want["authorization"]

    @app.get("/{bucket}")
    def list_objects(bucket: str, request: Request):
        if not verified(request):
            return error(403, "SignatureDoesNotMatch", "The request signature we calculated does not match.")
        if bucket not in app.state.buckets:
            return error(404, "NoSuchBucket", "The specified bucket does not exist")
        q = request.query_params
        prefix = q.get("prefix", "")
        keys = sorted(k for k in app.state.buckets[bucket] if k.startswith(prefix))
        start = int(q.get("continuation-token") or 0)
        page = keys[start:start + min(int(q.get("max-keys") or 2), 2)]
        more = start + len(page) < len(keys)
        items = "".join(
            f"<Contents><Key>{escape(k)}</Key><LastModified>"
            f"{datetime.fromtimestamp(app.state.buckets[bucket][k][1], UTC).strftime('%Y-%m-%dT%H:%M:%S.000Z')}"
            f"</LastModified><ETag>&quot;{hash(app.state.buckets[bucket][k][0]) & 0xffffff:x}&quot;</ETag>"
            f"<Size>{len(app.state.buckets[bucket][k][0])}</Size></Contents>" for k in page)
        body = (f"<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">"
                f"<Name>{bucket}</Name><Prefix>{escape(prefix)}</Prefix><KeyCount>{len(page)}</KeyCount>"
                f"<IsTruncated>{'true' if more else 'false'}</IsTruncated>{items}"
                + (f"<NextContinuationToken>{start + len(page)}</NextContinuationToken>" if more else "")
                + "</ListBucketResult>")
        return Response(body, media_type="application/xml")

    @app.get("/{bucket}/{key:path}")
    def get_object(bucket: str, key: str, request: Request):
        if not verified(request):
            return error(403, "SignatureDoesNotMatch", "The request signature we calculated does not match.")
        obj = app.state.buckets.get(bucket, {}).get(key)
        if obj is None:
            return error(404, "NoSuchKey", "The specified key does not exist.")
        return Response(obj[0], media_type="application/octet-stream",
                        headers={"Last-Modified": formatdate(obj[1], usegmt=True)})

    return app


class FakeServer:
    def __init__(self, app: FastAPI | None = None) -> None:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.app = app or fake_app()
        self.server = uvicorn.Server(uvicorn.Config(self.app, host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def __enter__(self):
        self.thread.start()
        deadline = time.time() + 10
        while not self.server.started and time.time() < deadline:
            time.sleep(0.02)
        return self

    def __exit__(self, *exc):
        self.server.should_exit = True
        self.thread.join(5)
