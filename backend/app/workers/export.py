"""Export a fine-tune to Ollama, so the chat can use it like any other model.

Config: finetune_id, name (the Ollama model name), quantize ("q8_0" | "q4_K_M" | None), provider (slug).

The adapter is merged into its base model and saved as safetensors; each file is uploaded to the
Ollama server as a blob (skipped when Ollama already has it), and Ollama builds the model from them
with /api/create, converting and quantizing it itself. No llama.cpp is needed, and the Ollama
server can be another machine.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import time
from pathlib import Path

import httpx
from sqlmodel import Session, select

from ..config import settings
from ..db import FineTune, Provider, engine
from .common import parse_context


# Ollama converts the weights but doesn't always recognise the chat format, and without one every
# conversation reaches the model as bare text. These are Ollama message templates for the families
# LLMCoach trains, keyed by a marker from the tokenizer's own chat template.
TEMPLATES: list[tuple[str, str, list[str]]] = [
    ("<|im_start|>", """{{- range $i, $_ := .Messages }}
{{- $last := eq (len (slice $.Messages $i)) 1 -}}
<|im_start|>{{ .Role }}
{{ .Content }}{{ if not (and $last (eq .Role "assistant")) }}<|im_end|>
{{ end }}
{{- if and $last (ne .Role "assistant") }}<|im_start|>assistant
{{ end }}
{{- end }}""", ["<|im_end|>", "<|im_start|>"]),
    ("<|start_header_id|>", """{{- range $i, $_ := .Messages }}
{{- $last := eq (len (slice $.Messages $i)) 1 -}}
<|start_header_id|>{{ .Role }}<|end_header_id|>

{{ .Content }}{{ if not (and $last (eq .Role "assistant")) }}<|eot_id|>{{ end }}
{{- if and $last (ne .Role "assistant") }}<|start_header_id|>assistant<|end_header_id|>

{{ end }}
{{- end }}""", ["<|eot_id|>", "<|start_header_id|>"]),
    ("<start_of_turn>", """{{- range $i, $_ := .Messages }}
{{- $last := eq (len (slice $.Messages $i)) 1 -}}
<start_of_turn>{{ if eq .Role "assistant" }}model{{ else }}user{{ end }}
{{ .Content }}{{ if not (and $last (eq .Role "assistant")) }}<end_of_turn>
{{ end }}
{{- if and $last (ne .Role "assistant") }}<start_of_turn>model
{{ end }}
{{- end }}""", ["<end_of_turn>"]),
]


def chat_format(chat_template: str | None) -> tuple[str, list[str]] | None:
    for marker, template, stop in TEMPLATES:
        if chat_template and marker in chat_template:
            return template, stop
    return None


def legacy_merges(tokenizer_json: Path) -> bool:
    """Rewrites BPE merges from pairs (["Ġ", "Ġ"], what newer tokenizers save) to "Ġ Ġ" strings.

    Ollama's converter reads only the string form; given pairs it builds a tokenizer without merges
    and the model answers in question marks. Tokens never contain a literal space, so this is lossless."""
    data = json.loads(tokenizer_json.read_text(encoding="utf-8"))
    merges = data.get("model", {}).get("merges")
    if not merges or not isinstance(merges[0], list):
        return False
    data["model"]["merges"] = [" ".join(pair) for pair in merges]
    tokenizer_json.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return True


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _upload(client: httpx.Client, path: Path) -> str:
    digest = f"sha256:{_sha256(path)}"
    if client.head(f"/api/blobs/{digest}").status_code == 200:
        print(f"[export] {path.name}: already on the server", flush=True)
        return digest

    def chunks():
        with open(path, "rb") as f:
            yield from iter(lambda: f.read(1 << 20), b"")

    started = time.perf_counter()
    r = client.post(f"/api/blobs/{digest}", content=chunks(), timeout=None)
    r.raise_for_status()
    mb = path.stat().st_size / 1024**2
    print(f"[export] {path.name}: uploaded {mb:.0f} MB in {time.perf_counter() - started:.0f}s", flush=True)
    return digest


def main() -> None:
    ctx = parse_context()
    c = ctx.config
    with Session(engine) as s:
        ft = s.get(FineTune, int(c["finetune_id"]))
        if ft is None or not ft.output_dir:
            raise SystemExit("that fine-tune has no saved adapter")
        base_model, adapter = ft.base_model, settings.data_dir / ft.output_dir
        provider = s.exec(select(Provider).where(Provider.slug == c.get("provider", "ollama"))).first()
        if provider is None:
            raise SystemExit(f"no provider called {c.get('provider', 'ollama')}")
        base_url = provider.base_url
    name = c["name"]
    out = settings.data_dir / "exports" / str(c["finetune_id"])

    ctx.progress(0, 4, "merging the adapter into the base model")
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    print(f"[export] {base_model} + {adapter.relative_to(settings.data_dir)} -> Ollama model '{name}' at {base_url}", flush=True)
    from huggingface_hub import snapshot_download

    token = settings.hf_token or None
    model = AutoModelForCausalLM.from_pretrained(base_model, dtype=torch.bfloat16, token=token)
    model = PeftModel.from_pretrained(model, str(adapter)).merge_and_unload()
    tokenizer = AutoTokenizer.from_pretrained(base_model, token=token)
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    model.save_pretrained(str(out), safe_serialization=True)
    del model
    # The tokenizer files go over exactly as the base model ships them (LoRA training never changes
    # the tokenizer). Re-saved by newer tokenizers they come out in a layout Ollama's converter
    # misreads, and the model then answers in question marks.
    snap = Path(snapshot_download(base_model, token=token, allow_patterns=[
        "tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt", "special_tokens_map.json",
        "added_tokens.json", "tokenizer.model", "generation_config.json"]))
    for p in snap.iterdir():
        if p.is_file():
            shutil.copyfile(p, out / p.name)
    if (out / "tokenizer.json").exists() and legacy_merges(out / "tokenizer.json"):
        print("[export] tokenizer merges rewritten in the classic format Ollama reads", flush=True)
    files = sorted(p for p in out.iterdir() if p.is_file())
    print(f"[export] merged model saved: {', '.join(p.name for p in files)}", flush=True)

    ctx.progress(1, 4, "uploading to Ollama")
    with httpx.Client(base_url=base_url, timeout=httpx.Timeout(60, read=None)) as client:
        blobs = {p.name: _upload(client, p) for p in files}

        ctx.progress(2, 4, "Ollama is building the model")
        body: dict = {"model": name, "files": blobs, "stream": True}
        if c.get("quantize"):
            body["quantize"] = c["quantize"]
        if fmt := chat_format(tokenizer.chat_template):
            body["template"], body["parameters"] = fmt[0], {"stop": fmt[1]}
            print(f"[export] chat format: {fmt[1][0]} turns", flush=True)
        else:
            print("[export] warning: unknown chat format; Ollama will use its own guess", flush=True)
        last = ""
        with client.stream("POST", "/api/create", json=body, timeout=None) as r:
            if r.status_code >= 400:
                r.read()
                raise SystemExit(f"Ollama refused the model: {r.text}")
            for line in r.iter_lines():
                if not line.strip():
                    continue
                msg = json.loads(line)
                if msg.get("error"):
                    raise SystemExit(f"Ollama: {msg['error']}")
                status = msg.get("status", "")
                if status and status != last:
                    print(f"[ollama] {status}", flush=True)
                    last = status
        if last != "success":
            raise SystemExit(f"Ollama stopped at '{last}' without finishing")

    ref = f"{c.get('provider', 'ollama')}/{name}"
    with Session(engine) as s:
        ft = s.get(FineTune, int(c["finetune_id"]))
        ft.ollama_model = ref
        s.add(ft)
        s.commit()
    shutil.rmtree(out, ignore_errors=True)  # Ollama has its own copy now
    ctx.progress(4, 4, "done")
    print(f"[export] ready: chat with it as {ref}", flush=True)


if __name__ == "__main__":
    main()
