# LLMCoach

A self-hosted workbench for making small LLMs good at specific tasks. It covers **RAG** over your documents and **LoRA fine-tuning**, with live logs, loss charts, GPU stats and side-by-side evaluation in a web UI.

It runs on **BigBox** as a BoxPilot app and uses BoxPilot's Ollama for inference. It's CPU-only today and uses an NVIDIA GPU (RTX 4080) once one is installed.

## What it does

The typical loop: put your documents in the **Knowledge Base**, chat with them in the **Playground**, **generate a dataset** of Q&A pairs from them, **fine-tune** a small model on it, then **compare** the base model, the base model with the knowledge base, and your fine-tune on held-out questions.

| Page | What you can do |
|---|---|
| **Knowledge Base** | Upload PDF, Markdown, text, HTML, DOCX, CSV and JSON. It's chunked (Markdown-section aware), embedded, and stored in LanceDB, with **hybrid search** (keywords + vectors). Browse chunks and test retrieval with scores. |
| **Playground** | Streaming chat with any model on any provider. The knowledge-base toggle gives **cited answers** with the passages shown. Reasoning models' thinking shows in its own panel. tok/s, time to first token, and saved conversations. |
| **Datasets** | Import JSONL, JSON or CSV (chat, Alpaca, prompt/completion, question/answer, ShareGPT), with row-level validation and a seeded train/val/test split. You can also **generate Q&A pairs from the knowledge base** with any chat model. |
| **Train** | LoRA / QLoRA fine-tuning with Quick/Balanced/Thorough presets and a **memory estimate against your hardware** before launch, plus live loss, eval-loss and learning-rate charts. It uses **Unsloth** on an NVIDIA GPU and **TRL + PEFT** elsewhere (CPU included, for models under 1B). |
| **Compare** | Run a test split through up to six variants: models, fine-tunes, each with or without the knowledge base. Scores are exact match, F1 and ROUGE-L, plus an optional **LLM judge** (1–5 with reasons), shown side by side with overlap highlighting. |
| **Providers** | Ollama (default) plus any OpenAI-compatible server, with presets for **llama.cpp, vLLM, SGLang, LocalAI and Text Embeddings Inference**. Models are named `provider/model`, so tasks can mix them. |
| **Jobs / Logs** | Everything heavy runs as a queued job in its own process, with live logs, progress, charts and cancel. |

All of it is open source and Linux-friendly: Ollama (MIT), llama.cpp (MIT), vLLM/SGLang/TEI (Apache 2.0), LanceDB (Apache 2.0), Hugging Face TRL/PEFT/transformers (Apache 2.0), Unsloth (Apache 2.0).

## Status

| Phase | What | State |
|---|---|---|
| 0–1 | Job queue, live streaming, system stats, Dashboard/Jobs/Logs | ✅ |
| 1.5 | BoxPilot packaging: sign-in, Ollama connection, GHCR image | ✅ |
| 2 | Providers, Knowledge Base, Playground | ✅ |
| 3 | Datasets (import + generation), LoRA/QLoRA training | ✅ |
| 4 | Eval + Compare | ✅ |
| 5 | Export fine-tunes to GGUF / Ollama; vLLM live adapter loading; Axolotl (DPO/ORPO) | ⏳ |

## Local development

```bash
# backend (API on :8000)
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # Linux/macOS: .venv/bin/pip
.venv/Scripts/python -m uvicorn app.main:app --reload

# frontend (UI on :5173, proxies /api and /ws to :8000)
cd frontend
npm install
npm run dev
```

Tests: `cd backend && .venv/Scripts/python -m pytest` (add `-m "not slow"` to skip the ones that download a tiny model and train it; those need `pip install torch -r requirements-ml.txt`).

Point development at any Ollama by putting `LLMCOACH_OLLAMA_URL=http://bigbox:11434` in a `.env` at the repo root.

Try **Run demo training** on the dashboard. It simulates a training run, so you can see the live loss chart, logs and cancel button without a GPU or torch.

## Deploy on BigBox (through BoxPilot)

LLMCoach is a [BoxPilot](https://github.com/AES256Afro/BoxPilot) catalog app:

1. In BoxPilot, install **Ollama** from the catalog (if it isn't already). Pull a chat model (e.g. `qwen3:4b`) and `nomic-embed-text`.
2. Install **LLMCoach** from the catalog. BoxPilot generates the owner password and shows it in the app's **Sign in** panel. It also handles LAN/Tailscale reach with HTTPS, updates, backups and logs.
3. Open LLMCoach. The dashboard's **Ollama** card should say *connected* and list your models.

LLMCoach reaches BoxPilot's Ollama at `http://host.docker.internal:11434`. That works while Ollama's reach is **LAN**. If you make Ollama Tailscale-only, set *Where Ollama is* in LLMCoach's settings to Ollama's tailnet address.

### Releasing

Pushing a `v*` tag runs `.github/workflows/image.yml`, which tests and publishes `ghcr.io/aes256afro/llmcoach:<version>`. Bump `image.reference`/`version` in BoxPilot's `catalog/llmcoach.yaml` to ship it. The first time, set the GHCR package's visibility to **public** so BigBox can pull it without credentials.

### Standalone (without BoxPilot)

```bash
cp .env.example .env        # set LLMCOACH_PASSWORD
docker compose up -d --build
```

### After installing the RTX 4080

1. Power: the card takes a 16-pin 12VHPWR / 12V-2x6 plug. Use a native cable from an ATX 3.x PSU, or the 3× 8-pin adapter that came with the card, with three *separate* PSU cables. Seat it fully. An 850W+ PSU is recommended.
2. Install the NVIDIA driver and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html), then check with `nvidia-smi`.
3. BoxPilot doesn't pass NVIDIA GPUs to apps yet (planned). Until it does, run standalone with `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build`.
4. Run **Smoke test + LoRA** from the Jobs page.

## Layout

```
backend/app/
  main.py              FastAPI app; also serves the built UI
  auth.py              single-owner sign-in (signed cookie; off when no password is set)
  api/                 REST + WebSocket routes (jobs, projects, system, ollama)
  services/jobs.py     single-GPU queue; each job = python -m app.workers.<kind>
  services/device.py   CPU / nvidia-smi / rocm-smi detection and stats
  workers/             job processes; write log.txt + metrics.jsonl in data/runs/<id>/
frontend/src/          React + Vite + Tailwind + Recharts
scripts/smoke_gpu.py   hardware check
```

### Adding a job type

1. Create `backend/app/workers/<kind>.py`. Call `ctx = parse_context()`, then `print()` for logs and `ctx.metric(step=…, loss=…)` / `ctx.progress(i, n)` for structured events.
2. Register it in `WORKERS` in `services/jobs.py`.

The UI picks up logs, loss charts and progress automatically.
