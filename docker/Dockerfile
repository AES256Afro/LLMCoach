# One image for CPU and NVIDIA builds; docker-compose.gpu.yml switches the base.
ARG BASE_IMAGE=python:3.12-slim

# ---- frontend build ----------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- backend -----------------------------------------------------------------
FROM ${BASE_IMAGE}
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
ARG CUDA_EXTRAS=0
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    LLMCOACH_DATA_DIR=/data HF_HOME=/data/hf-cache \
    LLMCOACH_OLLAMA_URL=http://host.docker.internal:11434

RUN apt-get update && apt-get install -y --no-install-recommends git curl && rm -rf /var/lib/apt/lists/*

# CUDA base images ship torch already; CPU images get the (small) CPU wheel.
RUN python -c "import torch" 2>/dev/null || pip install torch --index-url "$TORCH_INDEX"

WORKDIR /app/backend
COPY backend/requirements*.txt ./
RUN pip install -r requirements.txt -r requirements-ml.txt \
 && if [ "$CUDA_EXTRAS" = "1" ]; then pip install -r requirements-cuda.txt; fi

COPY backend/ ./
COPY scripts/ /app/scripts/
COPY --from=web /web/dist /app/frontend/dist

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://localhost:8000/api/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
