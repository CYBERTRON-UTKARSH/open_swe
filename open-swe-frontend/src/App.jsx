import { useCallback, useEffect, useRef, useState } from 'react';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */
const DEFAULT_URL = 'http://127.0.0.1:8000';
const MAX_FILE_BYTES = 200_000; // must match backend MAX_FILE_BYTES
const MAX_TASK_CHARS = 4000; // must match backend MAX_TASK_CHARS
const UPLOAD_CHUNK = 25;
const MAX_UPLOAD_FILES = 400;
const RUN_TIMEOUT_MS = 130_000;

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'env', '__pycache__', 'dist',
  'build', '.next', '.pytest_cache', '.idea', '.vscode', '.mypy_cache',
]);
const TEXT_EXT = new Set([
  'py', 'js', 'jsx', 'ts', 'tsx', 'json', 'md', 'txt', 'toml', 'yaml', 'yml',
  'cfg', 'ini', 'html', 'css', 'scss', 'sql', 'sh', 'java', 'c', 'h', 'cpp',
  'go', 'rs', 'rb', 'php', 'csv',
]);
const TEXT_NAMES = new Set([
  'dockerfile', 'makefile', 'license', '.gitignore', '.dockerignore',
]);

const TOOL_LABELS = {
  search_codebase_rag: 'RAG search',
  read_code_file: 'Read file',
  write_code_file: 'Wrote file',
  run_pytest_suite: 'Ran tests',
};

const SUGGESTIONS = [
  'Explain how this codebase is structured.',
  'Find bugs in the main module, fix them, then run the tests.',
  'Add unit tests for the core functions and make sure they pass.',
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const newSid = () => crypto.randomUUID().replaceAll('-', '');

function useStored(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) return stored;
      const init = typeof initial === 'function' ? initial() : initial;
      localStorage.setItem(key, init);
      return init;
    } catch {
      return typeof initial === 'function' ? initial() : initial;
    }
  });
  const set = useCallback(
    (next) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [value, set];
}

function shouldUpload(path) {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return false;
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) return false;
  const name = parts[parts.length - 1].toLowerCase();
  if (name.startsWith('.env')) return false; // backend denies these anyway
  if (/\.(pem|key|p12)$/.test(name)) return false;
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return TEXT_EXT.has(ext) || TEXT_NAMES.has(name);
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(cfg, path, { method = 'GET', body, params, signal } = {}) {
  const url = new URL(cfg.url.replace(/\/+$/, '') + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.key },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const d = data?.detail;
    const msg = Array.isArray(d) ? d.map((x) => x.msg).join('; ') : d || res.statusText;
    throw new ApiError(res.status, msg);
  }
  return data;
}

function friendlyError(err) {
  if (err?.name === 'AbortError') {
    return 'The agent ran longer than 130 seconds and was stopped. Try a smaller, more specific task.';
  }
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return 'The backend rejected your API key. Open Settings and paste a key from API_KEYS in the backend .env file.';
      case 413:
        return `Something was too large: ${err.message}`;
      case 422:
        return `The request was not accepted: ${err.message}`;
      case 429:
        return 'Too many requests. Wait a few seconds and try again.';
      case 503:
        return `The backend is busy: ${err.message}`;
      case 504:
        return 'The agent hit the server time limit. Try a smaller task.';
      default:
        return `Server error ${err.status}: ${err.message}`;
    }
  }
  return "Cannot reach the backend. Check that uvicorn is running and that this page's address is listed in CORS_ORIGINS.";
}

function parseBlocks(text) {
  const out = [];
  const re = /```(\w+)?\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    out.push({ t: 'code', lang: m[1] || '', v: m[2].replace(/\n$/, '') });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

function toolSummary(tools = []) {
  const counts = {};
  tools.forEach((t) => {
    counts[t] = (counts[t] || 0) + 1;
  });
  return Object.entries(counts).map(([k, n]) => ({ label: TOOL_LABELS[k] || k, n }));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Small UI pieces                                                     */
/* ------------------------------------------------------------------ */
const ICONS = {
  send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4 20-7z'],
  sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  folder: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
  file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
  copy: ['M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
  menu: ['M3 12h18', 'M3 6h18', 'M3 18h18'],
  refresh: ['M23 4v6h-6', 'M1 20v-6h6', 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10', 'M1 14l4.64 4.36A9 9 0 0 0 20.49 15'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  plus: ['M12 5v14', 'M5 12h14'],
  spark: ['M12 2l2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5z'],
};

function Icon({ name, size = 16 }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

function Inline({ text }) {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.length > 2 && p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    if (p.length > 4 && p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    return <span key={i}>{p}</span>;
  });
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (await copyText(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang || 'code'}</span>
        <button className="link-btn" onClick={onCopy}>
          <Icon name="copy" size={13} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Message({ msg }) {
  const isUser = msg.role === 'user';
  const blocks = isUser ? [{ t: 'text', v: msg.content }] : parseBlocks(msg.content);
  const tools = toolSummary(msg.tools);
  return (
    <div className={`msg ${msg.role}${msg.error ? ' error' : ''}`}>
      <div className="avatar">{isUser ? 'You' : <Icon name="spark" size={15} />}</div>
      <div className="bubble">
        {blocks.map((b, i) =>
          b.t === 'code' ? (
            <CodeBlock key={i} lang={b.lang} code={b.v} />
          ) : b.v.trim() ? (
            <p key={i} className="prose">
              <Inline text={b.v.trim()} />
            </p>
          ) : null,
        )}
        {tools.length > 0 && (
          <div className="chips">
            {tools.map((t) => (
              <span key={t.label} className="chip">
                {t.label}
                {t.n > 1 ? ` ×${t.n}` : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Modal({ title, onClose, wide, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SettingsModal({ url, apiKey, onSave, onClose }) {
  const [u, setU] = useState(url);
  const [k, setK] = useState(apiKey);
  return (
    <Modal title="Connection settings" onClose={onClose}>
      <label className="field">
        <span>Backend URL</span>
        <input value={u} onChange={(e) => setU(e.target.value)} placeholder={DEFAULT_URL} spellCheck="false" />
      </label>
      <label className="field">
        <span>API key</span>
        <input
          type="password"
          value={k}
          onChange={(e) => setK(e.target.value)}
          placeholder="A value from API_KEYS in your backend .env"
          spellCheck="false"
          autoComplete="off"
        />
      </label>
      <p className="note">
        Stored only in this browser. For a public website, keep the key on your own server and call the
        backend through a small proxy instead of pasting it here.
      </p>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onSave(u.trim() || DEFAULT_URL, k.trim())}>
          Save
        </button>
      </div>
    </Modal>
  );
}

function FileViewer({ viewer, onClose }) {
  const download = () => {
    const blob = new Blob([viewer.content ?? ''], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = viewer.path.split('/').pop();
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <Modal title={viewer.path} onClose={onClose} wide>
      {viewer.content === null ? (
        <p className="note">Loading…</p>
      ) : (
        <>
          <CodeBlock lang={viewer.path.split('.').pop()} code={viewer.content} />
          <div className="modal-actions">
            <button className="btn ghost" onClick={download}>
              <Icon name="download" size={14} /> Download
            </button>
            <button className="btn primary" onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */
export default function App() {
  const [url, setUrl] = useStored('openswe.url', DEFAULT_URL);
  const [key, setKey] = useStored('openswe.key', '');
  const [sid, setSid] = useStored('openswe.sid', newSid);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const [files, setFiles] = useState([]);
  const [filesBusy, setFilesBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [viewer, setViewer] = useState(null);

  const [online, setOnline] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(!key);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState(null);

  const endRef = useRef(null);
  const taRef = useRef(null);
  const fileInputRef = useRef(null);
  const dirInputRef = useRef(null);

  const notify = useCallback((text, kind = 'info') => setToast({ text, kind, id: Date.now() }), []);

  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  /* backend health indicator */
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      try {
        const r = await fetch(url.replace(/\/+$/, '') + '/healthz');
        if (alive) setOnline(r.ok);
      } catch {
        if (alive) setOnline(false);
      }
    };
    ping();
    const id = setInterval(ping, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [url]);

  /* elapsed timer while the agent works */
  useEffect(() => {
    if (!loading) return undefined;
    setElapsed(0);
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [loading]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  const refreshFiles = useCallback(async () => {
    if (!key) return;
    setFilesBusy(true);
    try {
      const d = await request({ url, key }, '/api/workspace/files', { params: { session_id: sid } });
      setFiles(d.files || []);
    } catch (e) {
      notify(friendlyError(e), 'error');
    } finally {
      setFilesBusy(false);
    }
  }, [url, key, sid, notify]);

  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  const uploadFiles = async (fileList) => {
    if (!key) return setSettingsOpen(true);
    const picked = Array.from(fileList);
    const items = [];
    let skipped = 0;
    for (const f of picked) {
      let path = f.webkitRelativePath || f.name;
      if (f.webkitRelativePath) path = path.split('/').slice(1).join('/'); // drop the folder's own name
      if (!path || !shouldUpload(path) || f.size > MAX_FILE_BYTES || items.length >= MAX_UPLOAD_FILES) {
        skipped += 1;
        continue;
      }
      try {
        items.push({ path, content: await f.text() });
      } catch {
        skipped += 1;
      }
    }
    if (!items.length) return notify('No supported text files found to upload.', 'error');

    setUploading(true);
    try {
      for (let i = 0; i < items.length; i += UPLOAD_CHUNK) {
        await request({ url, key }, '/api/workspace/files', {
          method: 'POST',
          body: { session_id: sid, files: items.slice(i, i + UPLOAD_CHUNK) },
        });
      }
      notify(`Uploaded ${items.length} file${items.length > 1 ? 's' : ''}${skipped ? ` (${skipped} skipped)` : ''}.`, 'ok');
      await refreshFiles();
    } catch (e) {
      notify(friendlyError(e), 'error');
    } finally {
      setUploading(false);
    }
  };

  const onPick = (e) => {
    if (e.target.files?.length) uploadFiles(e.target.files);
    e.target.value = '';
  };

  const openFile = async (path) => {
    setViewer({ path, content: null });
    try {
      const d = await request({ url, key }, '/api/workspace/file', { params: { path, session_id: sid } });
      setViewer({ path, content: d.content });
    } catch (e) {
      setViewer(null);
      notify(friendlyError(e), 'error');
    }
  };

  const newSession = () => {
    if (!window.confirm('Start a new session? This gives you an empty workspace (your old files stay on the server).')) return;
    setSid(newSid());
    setMessages([]);
    setFiles([]);
  };

  const send = async (text) => {
    const task = text.trim();
    if (!task || loading) return;
    if (!key) return setSettingsOpen(true);

    setInput('');
    setMessages((m) => [...m, { id: Date.now(), role: 'user', content: task }]);
    setLoading(true);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
    try {
      const data = await request({ url, key }, '/api/run-agent', {
        method: 'POST',
        body: { task_description: task, session_id: sid },
        signal: ctrl.signal,
      });
      setMessages((m) => [
        ...m,
        {
          id: Date.now() + 1,
          role: 'assistant',
          content: data.output || 'The task finished, but the agent returned no text.',
          tools: data.tools_used || [],
        },
      ]);
      refreshFiles();
    } catch (e) {
      setMessages((m) => [...m, { id: Date.now() + 1, role: 'assistant', content: friendlyError(e), error: true }]);
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const statusLabel = online === null ? 'Checking…' : online ? 'Backend online' : 'Backend offline';
  const statusClass = online === null ? 'pending' : online ? 'on' : 'off';

  return (
    <div className="app">
      {/* ---------------- Sidebar ---------------- */}
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="brand">
          <div className="logo"><Icon name="spark" size={18} /></div>
          <div>
            <b>OpenSWE</b>
            <span>AI software engineer</span>
          </div>
        </div>

        <section className="card">
          <div className="row between">
            <div>
              <div className="label">Session</div>
              <code className="sid">{sid.slice(0, 8)}</code>
            </div>
            <button className="btn ghost small" onClick={newSession}>
              <Icon name="plus" size={14} /> New
            </button>
          </div>
        </section>

        <section className="card grow">
          <div className="row between">
            <div className="label">Workspace · {files.length} file{files.length === 1 ? '' : 's'}</div>
            <button className="icon-btn" onClick={refreshFiles} aria-label="Refresh files" disabled={filesBusy}>
              <span className={filesBusy ? 'spin' : ''}><Icon name="refresh" size={15} /></span>
            </button>
          </div>

          <div className="row gap">
            <button className="btn soft small" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              <Icon name="upload" size={14} /> Files
            </button>
            <button className="btn soft small" onClick={() => dirInputRef.current?.click()} disabled={uploading}>
              <Icon name="folder" size={14} /> Folder
            </button>
          </div>
          <input ref={fileInputRef} type="file" multiple hidden onChange={onPick} />
          <input ref={dirInputRef} type="file" webkitdirectory="" multiple hidden onChange={onPick} />

          <div className="files">
            {uploading && <div className="note">Uploading…</div>}
            {!uploading && files.length === 0 && (
              <div className="note">
                Nothing here yet. Upload your code so the agent can search, edit and test it.
              </div>
            )}
            {files.map((f) => (
              <button key={f} className="file" onClick={() => openFile(f)} title={f}>
                <Icon name="file" size={14} />
                <span>{f}</span>
              </button>
            ))}
          </div>
        </section>

        <p className="foot">Your files live in a private workspace on the server, separate from other users.</p>
      </aside>
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}

      {/* ---------------- Main ---------------- */}
      <main className="main">
        <header className="topbar">
          <button className="icon-btn menu" onClick={() => setSidebarOpen(true)} aria-label="Open workspace">
            <Icon name="menu" size={18} />
          </button>
          <h1>Autonomous AI Engineer</h1>
          <div className="spacer" />
          <span className={`status ${statusClass}`}>
            <i /> {statusLabel}
          </span>
          <button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings">
            <Icon name="sliders" size={17} />
          </button>
        </header>

        <div className="chat">
          <div className="chat-inner">
            {messages.length === 0 && !loading && (
              <div className="hero">
                <div className="hero-logo"><Icon name="spark" size={26} /></div>
                <h2>What should we build or fix today?</h2>
                <p>
                  Upload your project on the left, then describe the task. I'll search your code, make the edits and
                  run your tests.
                </p>
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="suggestion" onClick={() => { setInput(s); taRef.current?.focus(); }}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <Message key={m.id} msg={m} />
            ))}

            {loading && (
              <div className="msg assistant">
                <div className="avatar"><Icon name="spark" size={15} /></div>
                <div className="bubble working">
                  <div className="dots"><i /><i /><i /></div>
                  <div>
                    <div>Working on it… {elapsed}s</div>
                    <div className="sub">Searching, editing and testing can take up to two minutes.</div>
                  </div>
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>
        </div>

        <div className="composer">
          <div className="composer-box">
            <textarea
              ref={taRef}
              rows={1}
              value={input}
              maxLength={MAX_TASK_CHARS}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Describe the bug, feature or refactor you want…"
            />
            <button
              className="send"
              onClick={() => send(input)}
              disabled={loading || !input.trim()}
              aria-label="Run agent"
            >
              <Icon name="send" size={17} />
            </button>
          </div>
          <div className="composer-foot">
            <span>Enter to send · Shift+Enter for a new line</span>
            <span>{input.length}/{MAX_TASK_CHARS}</span>
          </div>
        </div>
      </main>

      {settingsOpen && (
        <SettingsModal
          url={url}
          apiKey={key}
          onClose={() => setSettingsOpen(false)}
          onSave={(u, k) => {
            setUrl(u);
            setKey(k);
            setSettingsOpen(false);
            notify('Settings saved.', 'ok');
          }}
        />
      )}
      {viewer && <FileViewer viewer={viewer} onClose={() => setViewer(null)} />}
      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
    </div>
  );
}
