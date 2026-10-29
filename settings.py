"""Central configuration. Every value is overridable via environment variables."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _csv(name: str) -> list[str]:
    return [v.strip() for v in os.getenv(name, "").split(",") if v.strip()]


# --- Model / embeddings -----------------------------------------------------
# Verify the model id against Groq's GET /openai/v1/models before deploying.
LLM_MODEL: str = os.getenv("LLM_MODEL", "qwen/qwen3.8-27b")
EMBED_MODEL: str = os.getenv("EMBED_MODEL", "all-MiniLM-L6-v2")

# --- Security ---------------------------------------------------------------
API_KEYS: list[str] = _csv("API_KEYS")  # comma-separated client keys
CORS_ORIGINS: list[str] = _csv("CORS_ORIGINS")  # explicit origins only

# --- Workspace (MUST be separate from the application source tree) ----------
WORKSPACE_ROOT: Path = Path(os.getenv("WORKSPACE_ROOT", "./workspace")).resolve()

# --- Limits -----------------------------------------------------------------
MAX_TASK_CHARS: int = _int("MAX_TASK_CHARS", 4000)
MAX_FILE_BYTES: int = _int("MAX_FILE_BYTES", 200_000)
MAX_OUTPUT_CHARS: int = _int("MAX_OUTPUT_CHARS", 8000)
AGENT_TIMEOUT_S: int = _int("AGENT_TIMEOUT_S", 120)
RECURSION_LIMIT: int = _int("RECURSION_LIMIT", 25)
MAX_CONCURRENT_RUNS: int = _int("MAX_CONCURRENT_RUNS", 4)
RATE_LIMIT_PER_MIN: int = _int("RATE_LIMIT_PER_MIN", 10)
PYTEST_TIMEOUT_S: int = _int("PYTEST_TIMEOUT_S", 60)
RAG_TOP_K: int = _int("RAG_TOP_K", 4)
MAX_INDEX_SESSIONS: int = _int("MAX_INDEX_SESSIONS", 16)
