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

    return app


class FakeServer:
    def __init__(self) -> None:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.app = fake_app()
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
