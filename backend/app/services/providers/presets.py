"""Known model servers. All open source and Linux-friendly.

A preset only fills in defaults for the "add provider" form and describes what the
server can do; every non-Ollama preset talks through the OpenAI-compatible client.
"""
from __future__ import annotations

from ...db import ProviderKind

PRESETS: dict[str, dict] = {
    "ollama": {
        "name": "Ollama",
        "kind": ProviderKind.ollama,
        "base_url": "http://host.docker.internal:11434",
        "license": "MIT",
        "hardware": "CPU, NVIDIA, AMD",
        "capabilities": ["chat", "embeddings"],
        "website": "https://ollama.com",
        "note": "Runs GGUF models with automatic downloads. BoxPilot installs and manages it.",
    },
    "llamacpp": {
        "name": "llama.cpp server",
        "kind": ProviderKind.openai,
        "base_url": "http://host.docker.internal:8080/v1",
        "license": "MIT",
        "hardware": "CPU, NVIDIA, AMD, Vulkan",
        "capabilities": ["chat", "embeddings"],
        "website": "https://github.com/ggml-org/llama.cpp",
        "note": "The engine under Ollama, with full control over sampling, grammars and context. Start with "
                "`llama-server -m model.gguf --host 0.0.0.0` (add `--embeddings` for an embedding model).",
    },
    "vllm": {
        "name": "vLLM",
        "kind": ProviderKind.openai,
        "base_url": "http://host.docker.internal:8000/v1",
        "license": "Apache-2.0",
        "hardware": "NVIDIA (AMD via ROCm)",
        "capabilities": ["chat", "embeddings", "lora"],
        "website": "https://github.com/vllm-project/vllm",
        "note": "Fastest serving on a GPU, and it can load LoRA adapters while running "
                "(`--enable-lora`), so a fine-tuned model can be tested without exporting it.",
    },
    "sglang": {
        "name": "SGLang",
        "kind": ProviderKind.openai,
        "base_url": "http://host.docker.internal:30000/v1",
        "license": "Apache-2.0",
        "hardware": "NVIDIA, AMD",
        "capabilities": ["chat", "embeddings", "lora"],
        "website": "https://github.com/sgl-project/sglang",
        "note": "GPU serving like vLLM, particularly strong at structured (JSON) output.",
    },
    "localai": {
        "name": "LocalAI",
        "kind": ProviderKind.openai,
        "base_url": "http://host.docker.internal:8080/v1",
        "license": "MIT",
        "hardware": "CPU, NVIDIA, AMD",
        "capabilities": ["chat", "embeddings"],
        "website": "https://localai.io",
        "note": "One server for many kinds of model: language, embeddings, rerankers, speech.",
    },
    "tei": {
        "name": "Text Embeddings Inference",
        "kind": ProviderKind.openai,
        "base_url": "http://host.docker.internal:8081/v1",
        "license": "Apache-2.0",
        "hardware": "CPU, NVIDIA",
        "capabilities": ["embeddings"],
        "website": "https://github.com/huggingface/text-embeddings-inference",
        "note": "Hugging Face's dedicated embedding server; very fast for large knowledge bases.",
    },
    "custom": {
        "name": "Other OpenAI-compatible API",
        "kind": ProviderKind.openai,
        "base_url": "http://host.docker.internal:8080/v1",
        "license": None,
        "hardware": None,
        "capabilities": ["chat", "embeddings"],
        "website": None,
        "note": "Anything that speaks the OpenAI API: text-generation-webui, a hosted API, and so on. "
                "The address must include the version path, usually /v1.",
    },
}
