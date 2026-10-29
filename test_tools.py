import os

import pytest

import settings as S
from tools import read_code_file, run_pytest_suite, safe_path, workspace_for, write_code_file

CFG = {"configurable": {"session_id": "t1"}}


@pytest.fixture
def ws(tmp_path, monkeypatch):
  monkeypatch.setattr(S, "WORKSPACE_ROOT", tmp_path.resolve())
  return workspace_for("t1")


@pytest.mark.parametrize("bad", ["../x", "/etc/passwd", "a/../../x"])
def test_traversal_blocked(ws, bad):
  with pytest.raises(PermissionError):
    safe_path(ws, bad)


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
def test_symlink_escape_blocked(ws, tmp_path):
  outside = tmp_path / "secret.txt"
  outside.write_text("s")
  (ws / "link").symlink_to(outside)
  with pytest.raises(PermissionError):
    safe_path(ws, "link")


def test_env_and_git_denied(ws):
  for p in [".env", ".env.local", ".git/config"]:
    with pytest.raises(PermissionError):
      safe_path(ws, p)


def test_write_read_roundtrip_without_directory(ws):
  assert write_code_file.invoke({"file_path": "a.py", "content": "x=1\n"}, config=CFG).startswith("Saved")
  assert read_code_file.invoke({"file_path": "a.py"}, config=CFG) == "x=1\n"


def test_write_traversal_returns_error(ws):
  out = write_code_file.invoke({"file_path": "../evil.py", "content": "x"}, config=CFG)
  assert out.startswith("Error")


def test_pytest_tool_runs_and_scrubs_env(ws, monkeypatch):
  monkeypatch.setenv("GROQ_API_KEY", "super-secret")
  write_code_file.invoke(
      {
          "file_path": "tests/test_ok.py",
          "content": "import os\n\ndef test_ok():\n    assert 1 + 1 == 2\n    assert 'GROQ_API_KEY' not in os.environ\n",
      },
      config=CFG,
  )
  out = run_pytest_suite.invoke({"test_path": "tests/"}, config=CFG)
  assert "Exit Code: 0" in out and "passed" in out


def test_pytest_tool_rejects_option_injection(ws):
  out = run_pytest_suite.invoke({"test_path": "--rootdir=/"}, config=CFG)
  assert out.startswith("Error")
