# LLMCoach

A self-hosted workbench for making small LLMs good at specific tasks. It covers **RAG** over your documents and **LoRA fine-tuning**, with live logs, loss charts, GPU stats and side-by-side evaluation in a web UI.

It runs on **BigBox** as a BoxPilot app and uses BoxPilot's Ollama for inference. It's CPU-only today and uses an NVIDIA GPU (RTX 4080) once one is installed.

## Status

| Phase | What | State |
|---|---|---|
| 0 | Hardware smoke test (`scripts/smoke_gpu.py`) | ✅ |
| 1 | Job queue (subprocess per job), live log/metric streaming, system stats, Dashboard/Jobs/Logs UI | ✅ |
| 1.5 | BoxPilot packaging: sign-in, Ollama connection, GHCR image | ✅ |
| 2 | Knowledge base (ingest → chunk → embed → LanceDB) + Playground chat with sources | ⏳ |
| 3 | Datasets + LoRA/QLoRA training | ⏳ |
| 4 | Eval + Compare | ⏳ |
| 5 | Export to GGUF / Ollama | ⏳ |

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

Tests: `cd backend && .venv/Scripts/python -m pytest`

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
