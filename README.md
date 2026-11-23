# pi-web

Codex-style web UI for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — browse, fork and drive your pi sessions from any browser.

![pi-web UI](docs/screenshot.png)

pi is a terminal coding agent. `pi-web` serves a full chat front-end over HTTP + WebSocket, so you can keep long sessions running on a machine and talk to them from a laptop, phone, or tablet on the same network.

## Features

- **Session browser** — every session file under `~/.pi/agent/sessions/`, grouped by project directory
- **Branch a conversation** — fork a session at any message, keep exploring without losing the original
- **Live streaming** — token-by-token over WebSocket, with tool calls and thinking blocks rendered inline
- **Model + thinking level switching** — from the composer, no restart
- **Live stats** — context usage, tokens, cost per session
- **Built-in PTY terminal** — a real shell at `/pty`, not a fake one
- **File browser** — read files from the project workspace (`/api/fs/list`)
- **Zero front-end dependencies** — 1.7k lines of hand-written ES modules, no framework, no bundler; the WebSocket server (`ws-lite.ts`) is a 182-line RFC 6455 implementation

## Docker

The whole thing runs in a clean container — no host tooling beyond Docker:

```bash
docker build -t pi-web .                                   # includes Chromium for the browser panel
docker build -t pi-web --build-arg WITH_BROWSER=0 .        # slim, no browser panel
docker run --rm -p 5174:5174 \
  -v "$HOME/.pi/agent:/root/.pi/agent" \
  -v "$PWD:/workspace" pi-web
```

`docker compose up` does the same thing. Mount `~/.pi/agent` to keep your sessions,
`auth.json` and the sqlite index; mount your project at `/workspace` so the agent and
the file panel see real files.

In a container Chromium is started headless (`--no-sandbox`, no `/dev/shm`); on a
desktop with a display it stays headed so you can watch the agent drive it.

## Requirements

- Node.js >= 22.5 (the session index uses `node:sqlite`)
- pi installed (`npm i -g @earendil-works/pi-coding-agent`) — pi-web is a control panel for pi, it is **not** a standalone agent

## Install

```bash
npm i -g pi-web       # installs pi as a dependency too
pi-web                # http://127.0.0.1:5174
pi-web --port 8080 --host 0.0.0.0 --no-open
```

Or use it as a regular pi extension (no separate install):

```bash
# inside ~/.pi/agent/extensions/pi-web
pi --web                       # opens the UI automatically
pi --web --web-port 8080
```

## Security

The server has **no authentication**, by default it listens on `127.0.0.1` only. It can read your sessions, spawn shell commands and write files through the agent — binding it to `0.0.0.0` exposes all of that to your network. Put it behind a reverse proxy with auth (or an SSH tunnel) if you need remote access.

## Session index (SQLite)

pi stores every session as JSONL under `<agentDir>/sessions/<encoded-cwd>/`. Walking
those files on each sidebar refresh costs seconds once you have a few hundred sessions.
pi-web mirrors the metadata into `<agentDir>/pi-web.sqlite` and serves `/api/sessions`
from there:

| | 405 sessions, cold start | afterwards |
|---|---|---|
| JSONL scan (pi's `SessionManager.listAll`) | 6.0 s | 2.0 s |
| SQLite index | 6.0 s (one-time build) | **0.02 s** |

The JSONL files remain the source of truth — the DB is a disposable cache. Delete
`pi-web.sqlite` at any time and it rebuilds itself. A cheap signature (file count +
newest mtime) decides when to rebuild; on a warm start the sidebar never waits for a
full scan.

## Testing

```bash
node test/smoke.mjs http://127.0.0.1:5174
```

Covers static assets, every read-only API, the WebSocket round-trip and the CDP
browser (tabs / navigate / screenshot). Exits non-zero on failure, safe to re-run.

Verified end to end in a clean container (`--network none`, no host files mounted):
13/13 checks pass, three consecutive runs.

## Architecture

```
bin/pi-web.mjs ──► index.ts (HTTP + WebSocket server)
                     │
                     └── spawn "pi --mode rpc" ──► the actual agent
```

`index.ts` is a pi extension (`export default function (pi)`) that registers the `--web*` flags and starts the server on `session_start`. The browser talks to it over `/ws`; the server proxies the conversation to a `pi --mode rpc` child process over stdin/stdout JSON lines. `bin/pi-web.mjs` is a standalone entry point that supplies the few `ExtensionAPI` members the extension needs, so it can run without the pi TUI.

## Notes / limitations

- `/api/sessions` still returns the whole list (~275KB for 405 sessions, ~30KB gzipped) — pagination is the next step.
- One browser session drives one pi child process; single-user by design.
- `PI_BIN` overrides which pi executable is spawned.

## License

MIT
