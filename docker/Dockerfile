# One image for CPU and NVIDIA builds. The NVIDIA build (published as :X.Y.Z-cuda, or built by
# docker-compose.gpu.yml) sets BASE_IMAGE to PyTorch's CUDA runtime image and CUDA_EXTRAS=1;
# UNSLOTH=1 also installs Unsloth, which pins its own torch and transformers versions.
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
ARG UNSLOTH=0
ARG VERSION=dev
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 LLMCOACH_VERSION=${VERSION} \
    LLMCOACH_DATA_DIR=/data HF_HOME=/data/hf-cache \
    LLMCOACH_OLLAMA_URL=http://host.docker.internal:11434

# tesseract-ocr reads scanned PDFs (English; add tesseract-ocr-<lang> packages for other languages).
RUN apt-get update && apt-get install -y --no-install-recommends git curl tesseract-ocr tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

# CUDA base images ship torch already; CPU images get the (small) CPU wheel.
RUN python -c "import torch" 2>/dev/null || pip install torch --index-url "$TORCH_INDEX"

WORKDIR /app/backend
COPY backend/requirements*.txt ./
RUN pip install -r requirements.txt -r requirements-ml.txt \
 && if [ "$CUDA_EXTRAS" = "1" ]; then pip install -r requirements-cuda.txt; fi \
 && if [ "$UNSLOTH" = "1" ]; then pip install -r requirements-unsloth.txt; fi \
 && python -c "import torch, transformers, peft, trl; print('torch', torch.__version__, 'cuda', torch.version.cuda)"

COPY backend/ ./
# Fails the build on code the base image's Python can't compile.
RUN python -m compileall -q app
COPY scripts/ /app/scripts/
COPY --from=web /web/dist /app/frontend/dist

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://localhost:8000/api/health || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
