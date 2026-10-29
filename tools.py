"""Agent tools: sandboxed file I/O, resource-limited pytest, cached RAG search.

Every tool resolves paths against a per-session workspace. Symlinks are resolved
before the containment check, so link-based escapes are rejected.
"""
import hashlib
import logging
import os
import re
import signal
import subprocess
import sys
import threading
from collections import OrderedDict
from pathlib import Path
from typing import TYPE_CHECKING, Iterator, Optional

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from langchain_text_splitters import RecursiveCharacterTextSplitter

import settings as S

if TYPE_CHECKING:  # heavy imports are deferred to first use
    from langchain_community.vectorstores import FAISS
    from langchain_huggingface import HuggingFaceEmbeddings

log = logging.getLogger("openswe.tools")

# --------------------------------------------------------------------------
# Path sandbox
# --------------------------------------------------------------------------
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_DENY_PARTS = {".git", ".ssh"}
_DENY_SUFFIX = {".pem", ".key", ".p12"}


def workspace_for(session_id: str) -> Path:
  """Returns the resolved, existing workspace directory for a session."""
  if not _ID_RE.fullmatch(session_id):
    raise ValueError("invalid session_id")
  root = (S.WORKSPACE_ROOT / session_id).resolve()
  root.mkdir(parents=True, exist_ok=True)
  return root


def safe_path(workspace: Path, rel: str) -> Path:
  """Resolves `rel` inside `workspace` or raises. `workspace` must be resolved."""
  if not rel or "\x00" in rel:
    raise ValueError("empty or invalid path")
  target = (workspace / rel).resolve()  # absolute `rel` discards `workspace`
  if not target.is_relative_to(workspace):
    raise PermissionError("path escapes the workspace")
  parts = target.relative_to(workspace).parts
  if (
      any(p in _DENY_PARTS or p.startswith(".env") for p in parts)
      or target.suffix.lower() in _DENY_SUFFIX
  ):
    raise PermissionError("access to this path is denied")
  return target


def _session(config: RunnableConfig) -> tuple[str, Path]:
  sid = (config.get("configurable") or {}).get("session_id")
  if not isinstance(sid, str):
    raise ValueError("missing session_id in run config")
  return sid, workspace_for(sid)


def _clip(text: str, limit: Optional[int] = None) -> str:
  limit = limit or S.MAX_OUTPUT_CHARS
  if len(text) <= limit:
    return text
  head = limit * 2 // 3
  tail = limit - head
  return f"{text[:head]}\n...[{len(text) - limit} chars truncated]...\n{text[-tail:]}"


# --------------------------------------------------------------------------
# File tools
# --------------------------------------------------------------------------
@tool
def read_code_file(file_path: str, config: RunnableConfig) -> str:
  """Reads a UTF-8 text file. file_path is relative to the workspace root."""
  try:
    _, ws = _session(config)
    target = safe_path(ws, file_path)
    if not target.is_file():
      return f"Error: {file_path} not found."
    if target.stat().st_size > S.MAX_FILE_BYTES:
      return f"Error: {file_path} exceeds {S.MAX_FILE_BYTES} bytes."
    return target.read_text(encoding="utf-8")
  except UnicodeDecodeError:
    return "Error: file is not valid UTF-8 text."
  except (ValueError, OSError) as e:  # PermissionError is an OSError
    return f"Error: {e}"


@tool
def write_code_file(file_path: str, content: str, config: RunnableConfig) -> str:
  """Writes (creates or overwrites) a UTF-8 file. file_path is relative to the workspace root."""
  try:
    if len(content.encode("utf-8")) > S.MAX_FILE_BYTES:
      return f"Error: content exceeds {S.MAX_FILE_BYTES} bytes."
    _, ws = _session(config)
    target = safe_path(ws, file_path)
    if target.is_dir():
      return f"Error: {file_path} is a directory."
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, target)  # atomic on POSIX
    return f"Saved {file_path} ({len(content)} chars)."
  except (ValueError, OSError) as e:
    return f"Error: {e}"


# --------------------------------------------------------------------------
# pytest runner (defense-in-depth only; real isolation = container boundary)
# --------------------------------------------------------------------------
_RUNNER = """\
import sys
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    resource.setrlimit(resource.RLIMIT_AS, (2 << 30, 2 << 30))
    resource.setrlimit(resource.RLIMIT_FSIZE, (50 << 20, 50 << 20))
except ImportError:
    pass
import pytest
sys.exit(pytest.main(sys.argv[1:]))
"""


@tool
def run_pytest_suite(config: RunnableConfig, test_path: str = "tests/") -> str:
  """Runs pytest on a path inside the workspace and returns the exit code and output."""
  try:
    _, ws = _session(config)
    target = safe_path(ws, test_path)
    if not target.exists():
      return f"Error: {test_path} not found."
    rel = target.relative_to(ws).as_posix() or "."
    # Scrubbed environment: the API key must never reach agent-written code.
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(ws),
        "PYTHONPATH": str(ws),
        "PYTHONDONTWRITEBYTECODE": "1",
        "LANG": "C.UTF-8",
    }
    if os.name == "nt":  # Windows needs these for Python/pytest to start
      env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", "")
      env["TEMP"] = os.environ.get("TEMP", str(ws))
      env["TMP"] = os.environ.get("TMP", str(ws))
    cmd = [
        sys.executable, "-c", _RUNNER,
        "-x", "-q", "-p", "no:cacheprovider", "--", rel,
    ]
    proc = subprocess.Popen(
        cmd, cwd=ws, env=env, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        start_new_session=True,  # own process group -> killable as a unit
    )
    try:
      out, _ = proc.communicate(timeout=S.PYTEST_TIMEOUT_S)
    except subprocess.TimeoutExpired:
      if hasattr(os, "killpg"):
        os.killpg(proc.pid, signal.SIGKILL)
      else:
        proc.kill()
      proc.communicate()
      return f"Error: pytest exceeded {S.PYTEST_TIMEOUT_S}s and was killed."
    return _clip(f"Exit Code: {proc.returncode}\n{out}")
  except (ValueError, OSError) as e:
    return f"Execution error: {e}"


# --------------------------------------------------------------------------
# RAG: lazy singleton embedder + fingerprint-cached per-session FAISS index
# --------------------------------------------------------------------------
_INDEX_EXT = {".py", ".js", ".ts", ".md", ".json", ".txt", ".toml", ".yaml", ".yml", ".cfg", ".ini"}
_SKIP_DIRS = {".git", "__pycache__", "node_modules", "venv", ".venv", "env", ".pytest_cache", "dist", "build", ".mypy_cache"}

_embed_lock = threading.Lock()
_embeddings: "Optional[HuggingFaceEmbeddings]" = None
_index_lock = threading.Lock()
_indexes: "OrderedDict[str, tuple[str, FAISS]]" = OrderedDict()


def _get_embeddings() -> "HuggingFaceEmbeddings":
  global _embeddings
  with _embed_lock:
    if _embeddings is None:
      from langchain_huggingface import HuggingFaceEmbeddings

      _embeddings = HuggingFaceEmbeddings(
          model_name=S.EMBED_MODEL,
          model_kwargs={"device": "cpu"},
          encode_kwargs={"normalize_embeddings": True},
      )
    return _embeddings


def _iter_index_files(ws: Path) -> Iterator[Path]:
  for dirpath, dirnames, filenames in os.walk(ws):  # followlinks=False
    dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
    for name in filenames:
      p = Path(dirpath) / name
      if (
          p.suffix.lower() in _INDEX_EXT
          and not name.startswith(".env")
          and not p.is_symlink()
      ):
        try:
          if p.stat().st_size <= S.MAX_FILE_BYTES:
            yield p
        except OSError:
          continue


def _fingerprint(ws: Path, files: list[Path]) -> str:
  h = hashlib.sha1()
  for p in files:
    try:
      st = p.stat()
    except OSError:
      continue
    h.update(f"{p.relative_to(ws).as_posix()}:{st.st_mtime_ns}:{st.st_size}".encode())
  return h.hexdigest()


def _get_store(session_id: str, ws: Path) -> "Optional[FAISS]":
  files = sorted(_iter_index_files(ws))
  if not files:
    return None
  fp = _fingerprint(ws, files)
  # Lock is held during a rebuild: serializes CPU-bound embedding, which is
  # intentional (bounded memory); a per-session lock is the next refinement.
  with _index_lock:
    hit = _indexes.get(session_id)
    if hit and hit[0] == fp:
      _indexes.move_to_end(session_id)
      return hit[1]
    from langchain_community.vectorstores import FAISS

    texts: list[str] = []
    metas: list[dict[str, str]] = []
    for p in files:
      try:
        texts.append(p.read_text(encoding="utf-8"))
      except (OSError, UnicodeDecodeError):
        continue
      metas.append({"source": p.relative_to(ws).as_posix()})
    if not texts:
      return None
    splitter = RecursiveCharacterTextSplitter(chunk_size=700, chunk_overlap=200)
    docs = splitter.create_documents(texts, metadatas=metas)  # metadata on EVERY chunk
    store = FAISS.from_documents(docs, _get_embeddings())
    _indexes[session_id] = (fp, store)
    _indexes.move_to_end(session_id)
    while len(_indexes) > S.MAX_INDEX_SESSIONS:
      _indexes.popitem(last=False)
    return store


@tool
def search_codebase_rag(query: str, config: RunnableConfig) -> str:
  """Semantic search over the workspace's source files. Returns the top matching chunks with file paths."""
  try:
    q = query.strip()[:500]
    if not q:
      return "Error: empty query."
    sid, ws = _session(config)
    store = _get_store(sid, ws)
    if store is None:
      return "No indexable files found in the workspace."
    hits = store.similarity_search(q, k=S.RAG_TOP_K)
    if not hits:
      return "No relevant code segments found."
    body = "\n\n".join(
        f"--- {d.metadata.get('source', '?')} ---\n{d.page_content}" for d in hits
    )
    return _clip(f"RAG results for '{q}':\n\n{body}")
  except (ValueError, PermissionError) as e:
    return f"Error: {e}"
  except Exception:  # never leak internals to the model/user
    log.exception("RAG search failed")
    return "RAG search failed internally."