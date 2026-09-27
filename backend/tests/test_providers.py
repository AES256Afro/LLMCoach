import asyncio

import pytest

from app.services.providers import ProviderError, resolve, split_ref
from app.services.providers.base import embed_prefix
from app.services.providers.ollama import OllamaClient
from app.services.providers.openai_compat import OpenAICompatClient


def collect(agen):
    async def run():
        return [c async for c in agen]
    return asyncio.run(run())


@pytest.mark.parametrize("client_cls,suffix", [(OllamaClient, ""), (OpenAICompatClient, "/v1")])
def test_clients_normalize_chat_and_embeddings(fake, client_cls, suffix):
    c = client_cls(fake.url + suffix)
    st = asyncio.run(c.status())
    assert st["reachable"] and len(st["models"]) == 2
    assert [m["embedding"] for m in st["models"]] == [False, True]

    chunks = collect(c.chat_stream("m", [{"role": "user", "content": "hi"}]))
    assert "".join(ch["delta"] for ch in chunks) == "Hello from the fake."
    assert chunks[-1]["done"] and chunks[-1]["stats"]["completion_tokens"] == 4

    out = c.sync_chat("m", [{"role": "user", "content": "hi"}])
    assert out["content"] == "Hello from the fake." and out["stats"]["completion_tokens"] == 4

    vecs = c.sync_embed("nomic-embed-text", ["a", "b"])
    assert len(vecs) == 2 and len(vecs[0]) == 8
    assert len(asyncio.run(c.embed("x", ["q"]))[0]) == 8


def test_ollama_status_unreachable_has_hint():
    st = asyncio.run(OllamaClient("http://host.docker.internal:1").status())
    assert not st["reachable"]
    assert st["hint"]


def test_embed_prefixes():
    assert embed_prefix("nomic-embed-text:latest", "document") == "search_document: "
    assert embed_prefix("ollama-ish/nomic-embed-text", "query") == "search_query: "
    assert embed_prefix("bge-small", "query") == ""


def test_split_ref():
    known = {"ollama", "llamacpp"}
    assert split_ref("ollama/hermes3:8b", known) == ("ollama", "hermes3:8b")
    assert split_ref("llamacpp/Qwen/Qwen3-4B", known) == ("llamacpp", "Qwen/Qwen3-4B")
    assert split_ref("hermes3:8b", known) == ("ollama", "hermes3:8b")  # bare name -> built-in
    assert split_ref("Qwen/Qwen3-4B", known) == ("ollama", "Qwen/Qwen3-4B")  # unknown slug -> built-in


def test_provider_crud_and_model_listing(client, fake):
    presets = client.get("/api/providers/presets").json()
    assert {"ollama", "llamacpp", "vllm", "sglang", "localai", "tei", "custom"} <= set(presets)

    builtin = client.get("/api/providers").json()[0]
    assert builtin["slug"] == "ollama" and builtin["builtin"] and builtin["base_url"] == fake.url
    assert client.delete(f"/api/providers/{builtin['id']}").status_code == 400
    assert client.patch(f"/api/providers/{builtin['id']}", json={"base_url": "http://x"}).status_code == 400

    r = client.post("/api/providers", json={"preset": "llamacpp", "name": "llama.cpp on BigBox",
                                            "base_url": fake.url + "/v1", "api_key": "sk-test"})
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["slug"] == "llama-cpp-on-bigbox" and p["has_api_key"] and "api_key" not in p
    assert client.post("/api/providers", json={"preset": "llamacpp", "name": "llama.cpp on BigBox"}).status_code == 409

    chat = client.get("/api/models", params={"capability": "chat"}).json()
    refs = {m["ref"] for m in chat}
    assert {"ollama/chatty:1b", "llama-cpp-on-bigbox/Qwen/Qwen3-4B"} <= refs
    assert not any("embed" in r for r in refs)
    embeds = {m["ref"] for m in client.get("/api/models", params={"capability": "embeddings"}).json()}
    assert "ollama/nomic-embed-text:latest" in embeds

    client_, model, row = resolve("llama-cpp-on-bigbox/Qwen/Qwen3-4B")
    assert model == "Qwen/Qwen3-4B" and client_.api_key == "sk-test"

    client.patch(f"/api/providers/{p['id']}", json={"enabled": False})
    with pytest.raises(ProviderError, match="disabled"):
        resolve("llama-cpp-on-bigbox/Qwen/Qwen3-4B")
    assert client.delete(f"/api/providers/{p['id']}").status_code == 204


def test_test_endpoint_does_not_save(client, fake):
    before = len(client.get("/api/providers").json())
    st = client.post("/api/providers/test", json={"preset": "vllm", "base_url": fake.url + "/v1"}).json()
    assert st["reachable"] and st["models"][0]["name"] == "Qwen/Qwen3-4B"
    assert len(client.get("/api/providers").json()) == before
