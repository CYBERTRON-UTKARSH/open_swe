FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/hf \
    WORKSPACE_ROOT=/data/workspace

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential git \
    && rm -rf /var/lib/apt/lists/*

# CPU-only torch first (avoids multi-GB CUDA wheels), then the rest.
COPY requirements.txt .
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install -r requirements.txt

# Bake the embedding model into the image: no cold-start download per container.
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

COPY . .

# Non-root runtime user; agent-executed code never runs as root.
RUN useradd -m -u 10001 app \
    && mkdir -p /data/workspace \
    && chown -R app:app /app /data /opt/hf
USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).status == 200 else 1)"

# Single worker: the FAISS cache and rate limiter are in-process state.
# Run with: --memory 2g --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
