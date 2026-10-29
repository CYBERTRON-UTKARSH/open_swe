import asyncio
import hashlib
import logging
import re
import secrets
import time
import uuid
from collections import defaultdict, deque

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from groq import RateLimitError
from langgraph.errors import GraphRecursionError
from pydantic import BaseModel, Field

import settings as S
from agent_graph import app_graph
from tools import safe_path, workspace_for

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("openswe.api")

if not S.API_KEYS:
  raise RuntimeError("API_KEYS must be set (comma-separated); refusing to start unauthenticated.")

SID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)

app = FastAPI(title="OpenSWE API", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=S.CORS_ORIGINS,  # explicit origins; never "*" with credentials
    allow_credentials=False,  # auth is header-based, no cookies
    allow_methods=["GET", "POST"],
    allow_headers=["X-API-Key", "Content-Type"],
)


# --------------------------------------------------------------------------
# Auth + rate limiting
# --------------------------------------------------------------------------
async def require_key(x_api_key: str | None = Header(default=None)) -> str:
  if x_api_key:
    supplied = x_api_key.encode()
    for k in S.API_KEYS:
      if secrets.compare_digest(supplied, k.encode()):
        return k
  raise HTTPException(status_code=401, detail="invalid or missing API key")


_hits: dict[str, deque[float]] = defaultdict(deque)


async def rate_limit(key: str = Depends(require_key)) -> str:
  """Sliding window, in-memory (single replica). Use Redis/slowapi for >1 replica."""
  now = time.monotonic()
  q = _hits[key]
  while q and now - q[0] > 60:
    q.popleft()
  if len(q) >= S.RATE_LIMIT_PER_MIN:
    retry = max(1, int(60 - (now - q[0])))
    raise HTTPException(429, "rate limit exceeded", headers={"Retry-After": str(retry)})
  q.append(now)
  return key


def _scope(key: str, session_id: str) -> str:
  """Namespaces sessions per API key so tenants cannot touch each other's workspaces."""
  return f"{hashlib.sha256(key.encode()).hexdigest()[:16]}-{session_id}"


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------
class RunRequest(BaseModel):
  task_description: str = Field(min_length=1, max_length=S.MAX_TASK_CHARS)
  session_id: str = Field(default_factory=lambda: uuid.uuid4().hex, pattern=SID_PATTERN)


class RunResponse(BaseModel):
  status: str
  session_id: str
  output: str
  tools_used: list[str]


class FileItem(BaseModel):
  path: str = Field(min_length=1, max_length=512)
  content: str


class UploadRequest(BaseModel):
  session_id: str = Field(pattern=SID_PATTERN)
  files: list[FileItem] = Field(min_length=1, max_length=200)


def _text(content: object) -> str:
  if isinstance(content, str):
    s = content
  elif isinstance(content, list):
    s = "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in content)
  else:
    s = str(content)
  return _THINK.sub("", s).strip()  # drop Qwen <think> traces


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/")
async def root() -> dict[str, str]:
  return {"status": "online", "message": "OpenSWE Autonomous AI Engineer API is running!"}


@app.get("/healthz")
async def healthz() -> dict[str, str]:
  return {"status": "ok"}


_sem = asyncio.Semaphore(S.MAX_CONCURRENT_RUNS)


@app.post("/api/run-agent", response_model=RunResponse)
async def run_agent(req: RunRequest, key: str = Depends(rate_limit)) -> RunResponse:
  if _sem.locked():
    raise HTTPException(503, "server busy, retry shortly", headers={"Retry-After": "5"})

  cfg = {
      "recursion_limit": S.RECURSION_LIMIT,
      "configurable": {"session_id": _scope(key, req.session_id)},
  }
  inputs = {"messages": [("user", req.task_description)]}
  rid = uuid.uuid4().hex[:8]
  try:
    async with _sem:
      # ainvoke keeps the event loop free; sync tools run in worker threads.
      result = await asyncio.wait_for(app_graph.ainvoke(inputs, cfg), timeout=S.AGENT_TIMEOUT_S)
  except asyncio.TimeoutError:
    raise HTTPException(504, f"agent exceeded {S.AGENT_TIMEOUT_S}s")
  except GraphRecursionError:
    raise HTTPException(422, "agent exceeded its step budget; narrow the task")
  except RateLimitError:
    raise HTTPException(503, "LLM provider rate limit, retry shortly", headers={"Retry-After": "10"})
  except Exception:
    log.exception("agent run failed [%s]", rid)
    raise HTTPException(500, f"internal error (ref {rid})")

  messages = result.get("messages", [])
  final = _text(messages[-1].content) if messages else ""
  tools_used = [m.name for m in messages if getattr(m, "type", "") == "tool" and getattr(m, "name", None)]
  return RunResponse(
      status="success",
      session_id=req.session_id,
      output=final or "No response generated.",
      tools_used=tools_used,
  )


@app.post("/api/workspace/files")
def upload_files(req: UploadRequest, key: str = Depends(rate_limit)) -> dict[str, object]:
  ws = workspace_for(_scope(key, req.session_id))
  written: list[str] = []
  try:
    for f in req.files:
      if len(f.content.encode("utf-8")) > S.MAX_FILE_BYTES:
        raise HTTPException(413, f"{f.path} exceeds {S.MAX_FILE_BYTES} bytes")
      target = safe_path(ws, f.path)
      target.parent.mkdir(parents=True, exist_ok=True)
      target.write_text(f.content, encoding="utf-8")
      written.append(f.path)
  except (ValueError, PermissionError) as e:
    raise HTTPException(400, str(e)) from e
  return {"session_id": req.session_id, "written": written}


@app.get("/api/workspace/files")
def list_files(
    session_id: str = Query(pattern=SID_PATTERN), key: str = Depends(rate_limit)
) -> dict[str, object]:
  ws = workspace_for(_scope(key, session_id))
  files = sorted(
      p.relative_to(ws).as_posix()
      for p in ws.rglob("*")
      if p.is_file()
      and not p.is_symlink()
      and ".git" not in p.parts
      and "__pycache__" not in p.parts
      and not p.name.startswith(".env")
  )
  return {"session_id": session_id, "files": files[:1000]}


@app.get("/api/workspace/file")
def read_file(
    path: str = Query(min_length=1, max_length=512),
    session_id: str = Query(pattern=SID_PATTERN),
    key: str = Depends(rate_limit),
) -> dict[str, str]:
  ws = workspace_for(_scope(key, session_id))
  try:
    target = safe_path(ws, path)
  except (ValueError, PermissionError) as e:
    raise HTTPException(400, str(e)) from e
  if not target.is_file():
    raise HTTPException(404, "file not found")
  if target.stat().st_size > S.MAX_FILE_BYTES:
    raise HTTPException(413, "file too large")
  try:
    return {"path": path, "content": target.read_text(encoding="utf-8")}
  except UnicodeDecodeError:
    raise HTTPException(415, "not a UTF-8 text file")


if __name__ == "__main__":
  import uvicorn

  uvicorn.run(app, host="127.0.0.1", port=8000)
