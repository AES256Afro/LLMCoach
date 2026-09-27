# LLMCoach

A self-hosted workbench for making small LLMs good at specific tasks. It covers **RAG** over your documents and **LoRA fine-tuning**, with live logs, loss charts, GPU stats and side-by-side evaluation in a web UI.

It targets **BigBox** (Ubuntu). It runs CPU-only today and uses an NVIDIA GPU (RTX 4080) once one is installed.

## Status

| Phase | What | State |
|---|---|---|
| 0 | Hardware smoke test (`scripts/smoke_gpu.py`) | ✅ |
| 1 | Job queue (subprocess per job), live log/metric streaming, system stats, Dashboard/Jobs/Logs UI | ✅ |
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

## Deploy on BigBox

```bash
git clone <repo> llmcoach && cd llmcoach
cp .env.example .env
docker compose up -d --build            # CPU-only
```

Open `http://bigbox:8000` from your LAN. The app has **no authentication**, so don't port-forward it to the internet.

### After installing the RTX 4080

1. Power: the card takes a 16-pin 12VHPWR / 12V-2x6 plug. Use a native cable from an ATX 3.x PSU, or the 3× 8-pin adapter that came with the card, with three *separate* PSU cables. Seat it fully. An 850W+ PSU is recommended.
2. Install the NVIDIA driver and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html), then check with `nvidia-smi`.
3. Rebuild with the GPU override:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
   ```
4. Run **Smoke test + LoRA** from the Jobs page, or:
   ```bash
   docker compose exec llmcoach python /app/scripts/smoke_gpu.py --require-gpu --lora
   ```

## Layout

```
backend/app/
  main.py              FastAPI app; also serves the built UI
  api/                 REST + WebSocket routes (jobs, projects, system)
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
