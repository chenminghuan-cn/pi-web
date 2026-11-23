import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Lazy-load builtin slash commands (may not exist in older pi versions)
async function getBuiltinCommands(): Promise<any[]> {
  const candidates = [
    () => import("@earendil-works/pi-coding-agent/dist/core/slash-commands.js"),
    () => import("file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js"),
  ];
  for (const imp of candidates) {
    try { const m = await imp(); return m.BUILTIN_SLASH_COMMANDS ?? []; } catch {}
  }
  // Hardcoded fallback (best effort, kept in sync by version)
  return [
    { name: "settings", description: "Open settings menu" },
    { name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
    { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
    { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
    { name: "import", description: "Import and resume a session from a JSONL file" },
    { name: "share", description: "Share session as a secret GitHub gist" },
    { name: "copy", description: "Copy last agent message to clipboard" },
    { name: "name", description: "Set session display name", argumentHint: "<title>" },
    { name: "session", description: "Show session info and stats" },
    { name: "changelog", description: "Show changelog entries" },
    { name: "hotkeys", description: "Show all keyboard shortcuts" },
    { name: "fork", description: "Create a new fork from a previous user message" },
    { name: "clone", description: "Duplicate the current session at the current position" },
    { name: "tree", description: "Navigate session tree (switch branches)" },
    { name: "trust", description: "Save project trust decision for future sessions" },
    { name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
    { name: "logout", description: "Remove provider authentication" },
    { name: "new", description: "Start a new session" },
    { name: "compact", description: "Manually compact the session context", argumentHint: "[instructions]" },
    { name: "resume", description: "Resume a different session" },
    { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
    { name: "quit", description: "Quit" },
  ];
}
import { dirname, join, normalize, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { stat, readdir, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { attachWebSocketServer, type LiteWebSocket } from "./ws-lite.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const safeJson = (o: unknown) => JSON.stringify(o, (_k, v) => typeof v === "bigint" ? v.toString() : v);

// ---- Session list cache ----
// ---- Session index (SQLite) ----
// pi keeps every session as JSONL under <agentDir>/sessions/<encoded-cwd>/. Walking
// all of them on each sidebar refresh costs seconds once you have hundreds of
// sessions — and the sidebar polls. We mirror the metadata into SQLite
// (<agentDir>/pi-web.sqlite): the JSONL files stay the source of truth, the DB is
// a disposable cache, safe to delete, it rebuilds itself.
const SESS_CACHE_TTL_MS = 3000;
const SESS_DB_FILE = "pi-web.sqlite";
let sessCache: { at: number; list: any[] } | null = null;
let sessForceSync = false;
function invalidateSessCache(force = false) { sessCache = null; if (force) sessForceSync = true; }

function piAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (!env) return join(homedir(), ".pi", "agent");
  return env.startsWith("~") ? join(homedir(), env.slice(1)) : env;
}

let sessDbPromise: Promise<any | null> | undefined;
const SESS_SCHEMA = "2";
function sessionDb(): Promise<any | null> {
  if (!sessDbPromise) sessDbPromise = (async () => {
    try {
      const { DatabaseSync } = (await import("node:sqlite")) as any;
      const db = new DatabaseSync(join(piAgentDir(), SESS_DB_FILE));
      db.exec([
        "PRAGMA journal_mode = WAL",
        "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)",
        "CREATE TABLE IF NOT EXISTS sessions (path TEXT PRIMARY KEY, cwd TEXT, name TEXT, first_message TEXT, last_message TEXT, message_count INTEGER, updated INTEGER, created INTEGER)",
        "CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd, updated DESC)",
      ].join("; "));
      // Schema upgrades: the index is disposable, so just wipe it.
      const version = db.prepare("SELECT v FROM meta WHERE k = 'schema'").get()?.v;
      if (version !== SESS_SCHEMA) {
        db.exec("DELETE FROM sessions; DELETE FROM meta");
        db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)").run(SESS_SCHEMA);
      }
      return db;
    } catch (e: any) {
      console.error(`[pi-web] sqlite session index unavailable (${e?.message ?? e}); falling back to JSONL scan`);
      return null;
    }
  })();
  return sessDbPromise;
}

// Cheap signature of the store: file count + newest mtime. Appending to a session
// bumps its mtime, so any change invalidates the cached rows.
async function sessionStoreSignature(): Promise<string> {
  const root = join(piAgentDir(), "sessions");
  const files: string[] = [];
  try {
    for (const d of await readdir(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const sub = join(root, d.name);
      for (const f of await readdir(sub)) if (f.endsWith(".jsonl")) files.push(join(sub, f));
    }
    const stats = await Promise.all(files.map(f => stat(f).catch(() => null)));
    let newest = 0;
    for (const st of stats) if (st && st.mtimeMs > newest) newest = st.mtimeMs;
    return `${files.length}:${Math.round(newest)}`;
  } catch {
    return "0:0";
  }
}

let sessRebuild: Promise<void> | null = null;
function rebuildSessionIndex(db: any, sig: string): Promise<void> {
  if (sessRebuild) return sessRebuild;
  sessRebuild = (async () => {
    const rows = await SessionManager.listAll();
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM sessions");
      const ins = db.prepare(
        "INSERT OR REPLACE INTO sessions (path, cwd, name, first_message, last_message, message_count, updated, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const s of rows) {
        ins.run(
          String(s.path),
          String(s.cwd ?? ""),
          s.name == null ? null : String(s.name),
          s.firstMessage == null ? null : String(s.firstMessage),
          s.lastMessage == null ? null : String(s.lastMessage),
          Number(s.messageCount ?? 0) || 0,
          Number(s.updated ?? s.created ?? 0) || 0,
          Number(s.created ?? 0) || 0,
        );
      }
      db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('sig', ?)").run(sig);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  })().finally(() => { sessRebuild = null; });
  return sessRebuild;
}

function readSessionIndex(db: any): any[] {
  const out: any[] = [];
  try {
    const rows = db.prepare(
      "SELECT path, cwd, name, first_message, last_message, message_count, updated, created FROM sessions ORDER BY updated DESC"
    ).all() as any[];
    for (const r of rows) {
      out.push({
        path: r.path, cwd: r.cwd, name: r.name ?? undefined,
        firstMessage: r.first_message ?? undefined, lastMessage: r.last_message ?? undefined,
        messageCount: r.message_count ?? 0, updated: r.updated, created: r.created,
      });
    }
  } catch {}
  return out;
}

async function listSessionsCached(): Promise<any[]> {
  const now = Date.now();
  if (sessCache && now - sessCache.at < SESS_CACHE_TTL_MS) return sessCache.list;

  const db = await sessionDb();
  if (!db) {
    const list = await SessionManager.listAll();
    sessCache = { at: now, list };
    return list;
  }

  let sig = "0:0";
  try { sig = await sessionStoreSignature(); } catch {}
  let stored: string | undefined;
  try { stored = db.prepare("SELECT v FROM meta WHERE k = 'sig'").get()?.v; } catch {}

  const mustSync = sessForceSync;
  sessForceSync = false;

  let rows = readSessionIndex(db);
  if (!rows.length || stored !== sig || mustSync) {
    // Rebuild. Block only when we have nothing to serve (first run, or an explicit
    // mutation such as delete/rename); otherwise refresh in the background and
    // answer from the cache so the sidebar never waits on a full JSONL scan.
    const p = rebuildSessionIndex(db, sig).catch((e: any) =>
      console.error("[pi-web] session index rebuild failed:", e?.message ?? e));
    if (!rows.length || mustSync) { await p; rows = readSessionIndex(db); }
  }
  sessCache = { at: now, list: rows };
  return rows;
}

type Handler = (req: IncomingMessage, res: ServerResponse, b?: any, m?: RegExpMatchArray) => Promise<void> | void;
const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
const route = (method: string, pattern: RegExp, handler: Handler) => routes.push({ method, pattern, handler });
const sendJson = (res: ServerResponse, code: number, data: unknown) => { const b = safeJson(data); res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) }); res.end(b); };
const sendText = (res: ServerResponse, code: number, text: string, ct: string) => res.writeHead(code, { "Content-Type": ct + "; charset=utf-8", "Content-Length": Buffer.byteLength(text) }) && res.end(text);
const readBodyJson = (req: IncomingMessage): Promise<any> => new Promise(res => { let b = ""; req.on("data", c => b += c); req.on("end", () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } }); });

interface RpcHandle {
  send(cmd: any): Promise<any>;
  on(type: string, cb: (e: any) => void): void;
  stop(): void;
}

// Kill processes currently listening on the given host:port. Used on
// EADDRINUSE so `pi --web` behaves like "restart" when a previous instance is
// already running. Returns the number of PIDs signalled.
async function killListenersOnPort(port: number, host: string): Promise<number> {
  const { spawnSync, execSync } = await import("node:child_process");
  const pids = new Set<number>();

  // Strategy 1: lsof -iTCP:<port> -sTCP:LISTEN -t  (macOS / Linux)
  try {
    const r = spawnSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-n", "-P", "-t"], { encoding: "utf8" });
    if (!r.error && r.status === 0) {
      for (const line of r.stdout.split(/\r?\n/)) {
        const pid = Number(line.trim());
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
      }
    }
  } catch {}

  // Strategy 2: / fuser -k -n tcp <port>  (Linux fallback) — but we prefer to
  // collect PIDs and SIGTERM ourselves so we can skip our own PID.
  if (pids.size === 0 && process.platform !== "darwin") {
    try {
      const r = spawnSync("fuser", [String(port), "-n", "tcp"], { encoding: "utf8" });
      if (!r.error && r.status === 0) {
        for (const tok of r.stdout.split(/\s+/)) {
          const pid = Number(tok.trim());
          if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
        }
      }
    } catch {}
  }

  if (!pids.size) return 0;

  // When bound to a specific host (e.g. 127.0.0.1) lsof already returns only
  // matching listeners, so we don't filter further.
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  // Give them a moment to exit; SIGKILL any stragglers.
  await new Promise(r => setTimeout(r, 400));
  for (const pid of pids) {
    try { process.kill(pid, 0) && process.kill(pid, "SIGKILL"); } catch {}
  }
  return pids.size;
}

function resolvePiCommand(): { cmd: string; argsPrefix: string[] } {
  if (process.env.PI_BIN) return { cmd: process.env.PI_BIN, argsPrefix: [] };
  const cliCandidates = [
    // installed locally by this package
    join(__dirname, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    // running in place inside ~/.pi/agent/extensions/pi-web
    join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    join(__dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
  ];
  for (const c of cliCandidates) {
    try { if (existsSync(c)) return { cmd: process.execPath, argsPrefix: [c] }; } catch {}
  }
  return { cmd: "pi", argsPrefix: [] };
}

function startRpc(extraArgs: string[] = [], cwd?: string, extraEnv?: NodeJS.ProcessEnv): RpcHandle {
  const { cmd, argsPrefix } = resolvePiCommand();
  const proc = spawn(cmd, [...argsPrefix, "--mode", "rpc", ...extraArgs], {
    cwd, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(extraEnv || {}) },
  });
  const listeners = new Map<string, Set<(e: any) => void>>();
  let buf = ""; let id = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    buf += chunk; let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, ""); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: any; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === "response") {
        // Always broadcast responses to all connected WS clients so the
        // browser can react to prompt rejections (e.g. model doesn't support
        // images). The promise resolution below is for our own in-process
        // callers (REST routes).
        listeners.get("*")?.forEach(cb => cb(msg));
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); if (msg.success === false) p.reject(new Error(msg.error || "rpc error")); else p.resolve(msg.data ?? msg); }
      } else {
        listeners.get(msg.type)?.forEach(cb => cb(msg));
        listeners.get("*")?.forEach(cb => cb(msg));
      }
    }
  });
  proc.stderr.on("data", d => process.stderr.write(`[pi-rpc] ${d}`));
  proc.on("exit", () => listeners.get("exit")?.forEach(cb => cb({})));
  return {
    send: (cmd: any) => new Promise((resolve, reject) => {
      const myId = id++; pending.set(myId, { resolve, reject });
      proc.stdin.write(JSON.stringify({ id: myId, ...cmd }) + "\n");
    }),
    on: (type, cb) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(cb); },
    stop: () => { try { proc.kill("SIGTERM"); } catch {} },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("web", { description: "Start pi-web UI server", type: "boolean", default: false });
  pi.registerFlag("web-host", { description: "pi-web listen host", type: "string", default: "127.0.0.1" });
  pi.registerFlag("web-port", { description: "pi-web listen port", type: "number", default: 5174 });
  pi.registerFlag("web-open", { description: "Open browser automatically", type: "boolean", default: true });

  let server: ReturnType<typeof createServer> | undefined;
  const clients = new Set<LiteWebSocket>();
  let rpc: RpcHandle | undefined;
  let rpcCwd: string = process.env.HOME || process.cwd();

  // ---- persisted web state (last cwd / active session) across server restarts ----
  const webStatePath = join(process.env.HOME || process.cwd(), ".pi", "agent", "web-state.json");
  function saveWebState(patch: any) {
    try {
      let cur: any = {};
      try { cur = JSON.parse(readFileSync(webStatePath, "utf8")); } catch {}
      const next = { ...cur, ...patch, _at: Date.now() };
      writeFileSync(webStatePath, JSON.stringify(next, null, 2));
    } catch {}
  }
  function loadWebState(): any {
    try { return JSON.parse(readFileSync(webStatePath, "utf8")); } catch { return {}; }
  }

  async function persistCurrentSession() {
    try {
      // RPC may need a tick to update its internal sessionFile after switch/new/fork.
      await new Promise(r => setTimeout(r, 150));
      const st = await rpc!.send({ type: "get_state" });
      if (st?.sessionFile) saveWebState({ cwd: rpcCwd, sessionFile: st.sessionFile });
    } catch {}
  }

  function bootRpc(cwd: string, opts: { restoreSession?: string } = {}) {
    rpc?.stop();
    rpcCwd = cwd;
    saveWebState({ cwd });
    rpc = startRpc([], cwd, { PI_WEB_RPC: "1" });
    rpc.on("*", (ev: any) => { const out = safeJson(ev); for (const c of clients) if (c.readyState === 1) c.send(out); });
    setTimeout(async () => {
      // Resume the session the user was on when the server last shut down.
      if (opts.restoreSession && existsSync(opts.restoreSession)) {
        try { await rpc!.send({ type: "switch_session", sessionPath: opts.restoreSession }); } catch {}
      }
      await persistCurrentSession();
      for (const c of clients) if (c.readyState === 1) c.send(safeJson({ type: "project_switched", cwd }));
    }, 600);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!pi.getFlag("web")) return;
    if (process.env.PI_WEB_RPC === "1") return;
    const host = String(pi.getFlag("web-host") ?? "127.0.0.1");
    const port = Number(pi.getFlag("web-port") ?? 5174);

    // Restore the last project + session we were looking at, if that path still exists.
    const saved = loadWebState();
    // The project shown is the directory pi-web was started in — "what I cd'd into"
    // is what the UI should show. Set PI_WEB_RESTORE=1 to reopen the last project
    // instead (the old behaviour, handy when running as a long-lived service).
    let startCwd = ctx.cwd;
    let restoreSession: string | undefined;
    if (process.env.PI_WEB_RESTORE === "1" && saved?.cwd && existsSync(saved.cwd)) startCwd = saved.cwd;
    if (saved?.sessionFile && existsSync(saved.sessionFile)) restoreSession = saved.sessionFile;
    bootRpc(startCwd, { restoreSession });
    // Warm the session index in the background so the first sidebar load is instant.
    void listSessionsCached().catch(() => {});

    routes.length = 0;
    route("GET", /^\/$/, async (_r, res) => sendText(res, 200, await readFile(join(__dirname, "ui", "index.html"), "utf8"), "text/html"));
    route("GET", /^\/(app\.js|app\.css)$/, async (_r, res, _b, m) => {
      const f = m![1]; sendText(res, 200, await readFile(join(__dirname, "ui", f), "utf8"), f.endsWith(".js") ? "application/javascript" : "text/css");
    });

    // ---- direct passthrough RPC commands ----
    const proxy = (method: string, cmdType: string, transform?: (b: any) => any) => {
      route(method, cmdType, async (_r, res, b) => {
        try { sendJson(res, 200, await rpc!.send({ type: cmdType.replace(/^\//, "").replace(/\//g, "_"), ...(transform ? transform(b) : b) })); }
        catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
      });
    };

    // Version shown in the sidebar — read from package.json so it never drifts.
    route("GET", /^\/api\/meta$/, async (_r, res) => {
      try {
        const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
        sendJson(res, 200, { name: pkg.name, version: pkg.version, repo: "https://github.com/chenminghuan-cn/pi-web" });
      } catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
    });

    route("GET", /^\/api\/state$/, async (_r, res) => {
      try {
        const s = await rpc!.send({ type: "get_state" });
        sendJson(res, 200, { ...s, cwd: rpcCwd });
      } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("GET", /^\/api\/stats$/, async (_r, res) => {
      try {
        const stats = await rpc!.send({ type: "get_session_stats" });
        sendJson(res, 200, {
          messages: {
            user: stats.userMessages ?? 0,
            assistant: stats.assistantMessages ?? 0,
            toolCalls: stats.toolCalls ?? 0,
            toolResults: stats.toolResults ?? 0,
            total: stats.totalMessages ?? 0,
          },
          tokens: stats.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: stats.cost ?? 0,
          contextUsage: stats.contextUsage ?? null,
          cwd: rpcCwd,
          sessionFile: stats.sessionFile,
          sessionName: (await rpc!.send({ type: "get_state" })).sessionName,
          model: (await rpc!.send({ type: "get_state" })).model,
          thinkingLevel: (await rpc!.send({ type: "get_state" })).thinkingLevel,
          _firstUserMessage: '',
        });
      } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("GET", /^\/api\/models$/, async (_r, res) => {
      try {
        const data = await rpc!.send({ type: "get_available_models" });
        // Read scoped model ids from settings (same as TUI Ctrl+S persist)
        let scopedIds: string[] | null = null;
        try {
          const { readFileSync } = await import("node:fs");
          const settingsPath = (await import("node:path")).join(process.env.HOME || "~", ".pi", "agent", "settings.json");
          const s = JSON.parse(readFileSync(settingsPath, "utf8"));
          scopedIds = s.enabledModels ?? null;
        } catch {}
        sendJson(res, 200, { ...data, scopedIds });
      } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("GET", /^\/api\/messages$/, async (_r, res) => {
      try { sendJson(res, 200, await rpc!.send({ type: "get_messages" })); } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("GET", /^\/api\/tree$/, async (_r, res) => {
      try { sendJson(res, 200, await rpc!.send({ type: "get_tree" })); } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("GET", /^\/api\/entries$/, async (_r, res) => {
      try { sendJson(res, 200, await rpc!.send({ type: "get_entries" })); } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("GET", /^\/api\/sessions$/, async (req, res) => {
      try {
        // ?limit=N&offset=M pages the list; without them the whole list is returned
        // (275KB for a few hundred sessions). `total` always describes the full set.
        const q = new URL(String(req.url), "http://local");
        const limit = Math.max(0, Number(q.searchParams.get("limit")) || 0);
        const offset = Math.max(0, Number(q.searchParams.get("offset")) || 0);
        const all = await listSessionsCached();
        const st = await rpc!.send({ type: "get_state" });
        const mapped = all.map((s: any) => ({
          file: s.path, name: s.name, cwd: s.cwd,
          firstMessage: s.firstMessage, lastMessage: s.lastMessage,
          messageCount: s.messageCount, updated: s.updated ?? s.created, created: s.created,
          isCurrent: s.path === st.sessionFile && s.cwd === rpcCwd,
        })).sort((a: any, b: any) => b.updated - a.updated);
        // ?cwd= scopes to one project before paging — the sidebar only shows the
        // current project, so a global page would miss it entirely.
        const cwdFilter = q.searchParams.get("cwd");
        const scoped = cwdFilter ? mapped.filter((x: any) => x.cwd === cwdFilter) : mapped;
        const page = limit ? scoped.slice(offset, offset + limit) : scoped;
        sendJson(res, 200, {
          sessions: page, total: scoped.length, offset,
          current: st.sessionFile, cwd: rpcCwd,
        });
      } catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
    });
    route("POST", /^\/api\/sessions\/switch$/, async (_r, res, b) => {
      try { const r = await rpc!.send({ type: "switch_session", sessionPath: b.file }); invalidateSessCache(); persistCurrentSession(); sendJson(res, 200, r); }
      catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("POST", /^\/api\/sessions\/rename$/, async (_r, res, b) => {
      try { const r = await rpc!.send({ type: "set_session_name", name: b.name }); invalidateSessCache(true); sendJson(res, 200, r); }
      catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("POST", /^\/api\/sessions\/delete$/, async (_r, res, b) => {
      try {
        const { rm, existsSync } = await import("node:fs/promises");
        const { existsSync: ex } = await import("node:fs");
        const { spawnSync } = await import("node:child_process");
        if (b.file) {
          const t = spawnSync("trash", [b.file], { encoding: "utf-8" });
          if (t.status !== 0 && ex(b.file)) await rm(b.file, { force: true });
        }
        invalidateSessCache(true);
        sendJson(res, 200, { ok: true });
      } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("POST", /^\/api\/session\/new$/, async (_r, res) => {
      try { const r = await rpc!.send({ type: "new_session" }); invalidateSessCache(); persistCurrentSession(); sendJson(res, 200, r); } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("POST", /^\/api\/session\/fork$/, async (_r, res, b) => {
      try { const r = await rpc!.send({ type: "fork", entryId: b.entryId }); invalidateSessCache(); persistCurrentSession(); sendJson(res, 200, r); } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("POST", /^\/api\/session\/clone$/, async (_r, res) => {
      try { const r = await rpc!.send({ type: "clone" }); invalidateSessCache(); persistCurrentSession(); sendJson(res, 200, r); } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("POST", /^\/api\/model$/, async (_r, res, b) => {
      try { sendJson(res, 200, await rpc!.send({ type: "set_model", provider: b.provider, modelId: b.id })); } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("POST", /^\/api\/thinking$/, async (_r, res, b) => {
      try { sendJson(res, 200, await rpc!.send({ type: "set_thinking_level", level: b.level })); } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    // Persist scoped model selection → settings.enabledModels (same as TUI Ctrl+S)
    route("POST", /^\/api\/scoped-models$/, async (_r, res, b) => {
      try {
        const { readFileSync, writeFileSync } = await import("node:fs");
        const settingsPath = join(piAgentDir(), "settings.json");
        let s: any = {};
        try { s = JSON.parse(readFileSync(settingsPath, "utf8")); } catch {}
        if (b?.all === true || b?.ids === null) s.enabledModels = null;
        else if (Array.isArray(b?.ids)) s.enabledModels = b.ids;
        writeFileSync(settingsPath, JSON.stringify(s, null, 4));
        sendJson(res, 200, { ok: true, count: Array.isArray(s.enabledModels) ? s.enabledModels.length : null });
      } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });

    // ---- Provider / model management ----
    // Everything lives in <agentDir>/models.json, the file pi itself reads. Bring your
    // own key: nothing here talks to a control plane, so a fresh install only needs the
    // user's provider URL and key.
    const providersFile = () => join(piAgentDir(), "models.json");
    const readProvidersFile = (): any => {
      try { return JSON.parse(readFileSync(providersFile(), "utf8")); } catch { return { providers: {} }; }
    };
    const writeProvidersFile = (data: any) => writeFileSync(providersFile(), JSON.stringify(data, null, 2) + "\n");
    // Never send a key to the browser in clear text, and never write a masked one back.
    const maskKey = (k?: string) => (!k ? "" : k.length <= 10 ? "••••" : `${k.slice(0, 4)}…${k.slice(-4)}`);

    route("GET", /^\/api\/providers$/, async (_r, res) => {
      try {
        const cfg = readProvidersFile();
        const providers = Object.entries(cfg.providers ?? {}).map(([id, p]: [string, any]) => ({
          id,
          name: p.name ?? id,
          baseUrl: p.baseUrl ?? "",
          api: p.api ?? "openai-completions",
          hasKey: !!p.apiKey,
          keyMasked: maskKey(p.apiKey),
          models: (Array.isArray(p.models) ? p.models : []).map((m: any) => ({
            id: String(m.id), name: m.name ?? String(m.id), reasoning: !!m.reasoning,
            contextWindow: m.contextWindow, maxTokens: m.maxTokens,
          })),
        }));
        sendJson(res, 200, { providers, path: providersFile() });
      } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });

    route("POST", /^\/api\/providers$/, async (_r, res, b) => {
      try {
        const cfg = readProvidersFile();
        cfg.providers ??= {};
        const id = String(b?.id ?? "").trim();
        if (!id) return sendJson(res, 400, { error: "provider id required" });
        if (b?.delete) {
          delete cfg.providers[id];
          writeProvidersFile(cfg);
          return sendJson(res, 200, { ok: true, deleted: id });
        }
        const prev = cfg.providers[id] ?? {};
        const next: any = {
          ...prev,
          name: b.name ?? prev.name ?? id,
          baseUrl: b.baseUrl ?? prev.baseUrl ?? "",
          api: b.api ?? prev.api ?? "openai-completions",
        };
        // Empty or masked input means "keep the stored key".
        if (typeof b.apiKey === "string" && b.apiKey.trim() && !b.apiKey.includes("…") && !b.apiKey.includes("••")) {
          next.apiKey = b.apiKey.trim();
        }
        if (Array.isArray(b.models)) {
          next.models = b.models.filter((m: any) => m && m.id).map((m: any) => ({
            ...m, id: String(m.id).trim(), name: m.name || String(m.id).trim(),
          }));
        }
        cfg.providers[id] = next;
        writeProvidersFile(cfg);
        sendJson(res, 200, { ok: true, id });
      } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });

    // Model discovery: ask the endpoint what it serves, so the user picks from a list
    // instead of hand-typing ids. Same auth resolution as the probe.
    route("POST", /^\/api\/providers\/discover$/, async (_r, res, b) => {
      try {
        const cfg = readProvidersFile();
        const stored = b?.id ? cfg.providers?.[b.id] : null;
        const baseUrl = String(b?.baseUrl ?? stored?.baseUrl ?? "").replace(/\/$/, "");
        if (!baseUrl) return sendJson(res, 400, { ok: false, error: "baseUrl is empty" });
        const rawKey = typeof b?.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : stored?.apiKey;
        const key = typeof rawKey === "string" && rawKey.startsWith("$") ? process.env[rawKey.slice(1)] : rawKey;
        const r = await fetch(`${baseUrl}/models`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(15000),
        });
        const text = await r.text();
        let models: any[] = [];
        try {
          const j = JSON.parse(text);
          const arr: any[] = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
          models = arr.map((m: any) => ({
            id: String(m.id ?? m.name ?? ""),
            name: m.display_name ?? m.displayName ?? undefined,
            contextWindow: m.context_length ?? m.contextWindow ?? m.max_context_length ?? undefined,
            maxTokens: m.max_tokens ?? m.maxTokens ?? m.max_output_tokens ?? undefined,
          })).filter((m: any) => m.id);
        } catch {}
        sendJson(res, 200, {
          ok: r.ok, status: r.status, models,
          error: r.ok ? undefined : text.slice(0, 300),
        });
      } catch (e: any) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); }
    });

    // Reachability probe: GET {baseUrl}/models with the stored key. Cheap, works for
    // every OpenAI-compatible endpoint, and says “keys wrong” far more clearly than
    // waiting for a chat completion to fail.
    route("POST", /^\/api\/providers\/test$/, async (_r, res, b) => {
      try {
        const cfg = readProvidersFile();
        const p = b?.id ? cfg.providers?.[b.id] : b;
        if (!p) return sendJson(res, 404, { error: "provider not found" });
        const baseUrl = String(p.baseUrl ?? "").replace(/\/$/, "");
        if (!baseUrl) return sendJson(res, 400, { error: "baseUrl is empty" });
        const rawKey = typeof b?.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : p.apiKey;
        // models.json may store "$ARK_API_KEY" instead of the literal key — resolve it.
        const key = typeof rawKey === "string" && rawKey.startsWith("$") ? process.env[rawKey.slice(1)] : rawKey;
        const started = Date.now();
        const r = await fetch(`${baseUrl}/models`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(12000),
        });
        const text = await r.text();
        let count = 0;
        try { const j = JSON.parse(text); count = Array.isArray(j.data) ? j.data.length : Array.isArray(j.models) ? j.models.length : 0; } catch {}
        sendJson(res, 200, {
          ok: r.ok, status: r.status, ms: Date.now() - started, modelCount: count,
          error: r.ok ? undefined : text.slice(0, 300),
        });
      } catch (e: any) { sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }); }
    });

    route("POST", /^\/api\/project\/switch$/, async (_r, res, b) => {
      try {
        if (!b?.cwd) return sendJson(res, 400, { error: "cwd required" });
        bootRpc(b.cwd);
        sendJson(res, 200, { ok: true, cwd: b.cwd });
      } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("GET", /^\/api\/projects$/, async (_r, res) => {
      try {
        const all = await listSessionsCached();
        const groups = new Map<string, { cwd: string; count: number; latest: number; name?: string }>();
        for (const s of all) {
          const k = s.cwd;
          const g = groups.get(k) ?? { cwd: k, count: 0, latest: 0 };
          g.count++; g.latest = Math.max(g.latest, s.updated ?? s.created ?? 0);
          if (s.name) g.name = s.name;
          groups.set(k, g);
        }
        const list = [...groups.values()].sort((a, b) => b.latest - a.latest);
        sendJson(res, 200, { projects: list, current: rpcCwd });
      } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("POST", /^\/api\/project\/open$/, async (_r, res, b) => {
      // Open an existing local folder as a project (just switch cwd)
      try {
        if (!b?.cwd) return sendJson(res, 400, { error: "cwd required" });
        const { existsSync } = await import("node:fs");
        if (!existsSync(b.cwd)) return sendJson(res, 400, { error: "path does not exist" });
        bootRpc(b.cwd);
        sendJson(res, 200, { ok: true, cwd: b.cwd });
      } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });
    route("POST", /^\/api\/project\/create$/, async (_r, res, b) => {
      // Create a new blank folder and switch to it
      try {
        if (!b?.path) return sendJson(res, 400, { error: "path required" });
        const { mkdir } = await import("node:fs/promises");
        await mkdir(b.path, { recursive: true });
        bootRpc(b.path);
        sendJson(res, 200, { ok: true, cwd: b.path });
      } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });

    // ---- File explorer API ----
    // Resolve a requested relative path safely under rpcCwd.
    const resolveFSPath = (rel: string): string => {
      if (!rel || rel === "/" || rel === "~") return rpcCwd;
      let p = rel;
      if (p.startsWith("~")) p = (process.env.HOME || "") + p.slice(1);
      if (!isAbsolute(p)) p = join(rpcCwd, p);
      const n = normalize(p);
      return n;
    };

    route("GET", /^\/api\/fs\/list$/, async (req, res) => {
      try {
        const url = new URL(req.url!, "http://x");
        const rel = url.searchParams.get("path") || "";
        const target = resolveFSPath(rel);
        const st = await stat(target);
        if (!st.isDirectory()) return sendJson(res, 400, { error: "not a directory" });
        const entries = await readdir(target, { withFileTypes: true });
        const IGNORED = new Set(["node_modules", ".git", "__pycache__", ".DS_Store", ".next", "dist", "build", ".venv", "venv", ".tox", ".cache", ".pi"]);
        const list = await Promise.all(entries.map(async (e) => {
          const full = join(target, e.name);
          let size = 0, mtime = 0, isDir = e.isDirectory();
          try {
            if (!isDir && !e.isSymbolicLink()) {
              const s = await stat(full); size = s.size; mtime = s.mtimeMs;
            } else if (e.isSymbolicLink()) {
              try { const s = await stat(full); isDir = s.isDirectory(); size = s.size; mtime = s.mtimeMs; } catch {}
            }
          } catch {}
          return { name: e.name, isDir, size, mtime, ignored: IGNORED.has(e.name) };
        }));
        list.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        sendJson(res, 200, { path: target, cwd: rpcCwd, entries: list });
      } catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
    });

    route("GET", /^\/api\/fs\/read$/, async (req, res) => {
      try {
        const url = new URL(req.url!, "http://x");
        const rel = url.searchParams.get("path") || "";
        const target = resolveFSPath(rel);
        const st = await stat(target);
        if (st.isDirectory()) return sendJson(res, 400, { error: "is a directory" });
        if (st.size > 2 * 1024 * 1024) return sendJson(res, 400, { error: "file too large (>2MB)" });
        const buf = await readFile(target);
        sendJson(res, 200, { path: target, content: buf.toString("utf8"), size: st.size, mtime: st.mtimeMs });
      } catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
    });

    route("POST", /^\/api\/fs\/write$/, async (_r, res, b) => {
      try {
        if (!b?.path) return sendJson(res, 400, { error: "path required" });
        const target = resolveFSPath(b.path);
        await writeFile(target, String(b.content ?? ""), "utf8");
        sendJson(res, 200, { ok: true, path: target });
      } catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
    });

    route("POST", /^\/api\/fs\/rename$/, async (_r, res, b) => {
      try {
        if (!b?.from || !b?.to) return sendJson(res, 400, { error: "from/to required" });
        await rename(resolveFSPath(b.from), resolveFSPath(b.to));
        sendJson(res, 200, { ok: true });
      } catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
    });

    route("POST", /^\/api\/fs\/delete$/, async (_r, res, b) => {
      try {
        if (!b?.path) return sendJson(res, 400, { error: "path required" });
        await rm(resolveFSPath(b.path), { recursive: true, force: true });
        sendJson(res, 200, { ok: true });
      } catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
    });

    route("POST", /^\/api\/fs\/mkdir$/, async (_r, res, b) => {
      try {
        if (!b?.path) return sendJson(res, 400, { error: "path required" });
        await mkdir(resolveFSPath(b.path), { recursive: true });
        sendJson(res, 200, { ok: true });
      } catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
    });

    route("POST", /^\/api\/fs\/newfile$/, async (_r, res, b) => {
      try {
        if (!b?.path) return sendJson(res, 400, { error: "path required" });
        const target = resolveFSPath(b.path);
        if (existsSync(target)) return sendJson(res, 400, { error: "exists" });
        await writeFile(target, "", "utf8");
        sendJson(res, 200, { ok: true, path: target });
      } catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
    });

    // ---- zip / unzip for the file panel ----
    route("POST", /^\/api\/fs\/zip$/, async (_r, res, b) => {
      try {
        if (!b?.path) return sendJson(res, 400, { error: "path required" });
        const target = resolveFSPath(b.path);
        if (!existsSync(target)) return sendJson(res, 404, { error: "not found" });
        const { zipPath, uniquePath } = await import("./fs-zip.ts");
        const base = target.split("/").filter(Boolean).pop() || "archive";
        const parent = dirname(target);
        const out = uniquePath(parent, `${base}.zip`);
        const { buf, count } = await zipPath(target);
        await writeFile(out, buf);
        sendJson(res, 200, { ok: true, file: out, count, bytes: buf.length });
      } catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
    });

    route("POST", /^\/api\/fs\/unzip$/, async (_r, res, b) => {
      try {
        if (!b?.path) return sendJson(res, 400, { error: "path required" });
        const target = resolveFSPath(b.path);
        if (!existsSync(target)) return sendJson(res, 404, { error: "not found" });
        if (!target.toLowerCase().endsWith(".zip")) return sendJson(res, 400, { error: "not a .zip file" });
        const { unzipTo, uniquePath } = await import("./fs-zip.ts");
        const base = (target.split("/").filter(Boolean).pop() || "archive").replace(/\.zip$/i, "");
        const dest = uniquePath(dirname(target), base);
        const { count } = await unzipTo(target, dest);
        sendJson(res, 200, { ok: true, dir: dest, count });
      } catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
    });

    // ---- Browser: drive a shared Chromium via CDP (uses pi's existing headed browser if running) ----
    // We maintain a single long-lived browser connection per server. Connects to an existing
    // Chromium launched by pi (shared profile under ~/.pi/agent/state/browser/profile) if it's
    // running on a loopback CDP port; otherwise launches Chrome on a fixed port with the same
    // user-data-dir so cookies/logins persist across sessions.
    let browserState: {
      wsUrl?: string;
      port: number;
      proc?: ReturnType<typeof spawn>;
      tabs: Map<string, { targetId: string }>;
    } | null = null;

    async function getBrowserWs(): Promise<{ wsUrl: string; port: number }> {
      if (browserState?.wsUrl) {
        // verify CDP is still reachable, otherwise reset and reconnect
        try {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 800);
          const r = await fetch(`http://127.0.0.1:${browserState.port}/json/version`, { signal: ctrl.signal });
          if (r.ok) return { wsUrl: browserState.wsUrl, port: browserState.port };
        } catch {}
        browserState = null;
      }

      // Strategy 1: find an already-running Chromium launched by pi (shared profile).
      // It binds 127.0.0.1 on a random port; scan all listening TCP ports for a CDP endpoint
      // whose Browser string looks like Chromium/Chrome.
      const tryPort = async (p: number) => {
        try {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 600);
          const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: ctrl.signal });
          clearTimeout(to);
          if (!r.ok) return null;
          const j = await r.json() as any;
          if (j.Browser && /Chrom|Chrome/i.test(j.Browser) && j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl as string;
        } catch {}
        return null;
      };
      try {
        const { execSync } = await import("node:child_process");
        // lsof -nP -iTCP -sTCP:LISTEN gives every listening TCP socket. Extract ports bound to 127.0.0.1.
        const out = execSync("lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null", { encoding: "utf8" });
        const ports = new Set<number>();
        for (const line of out.split(/\n/)) {
          const m = line.match(/127\.0\.0\.1:(\d+)\s/);
          if (m) {
            const p = parseInt(m[1], 10);
            if (p >= 1024 && p !== 5174 && p !== port) ports.add(p);
          }
        }
        // Probe every candidate port for a CDP endpoint
        const probes = await Promise.all([...ports].map(async p => ({ p, ws: await tryPort(p) })));
        const hit = probes.find(x => x.ws);
        if (hit) {
          browserState = { wsUrl: hit.ws!, port: hit.p, tabs: new Map() };
          return { wsUrl: hit.ws!, port: hit.p };
        }
      } catch (e) {}


      // Strategy 2: launch Chrome ourselves, reusing pi's profile dir
      const port = 9333;
      const home = process.env.HOME || process.cwd();
      const findChrome = () => {
        const home = process.env.HOME || "";
        const cands = [
          // pi's bundled playwright chromium (auto-discover any version)
          ...(() => {
            try {
              const { readdirSync } = require("node:fs");
              const cache = `${home}/Library/Caches/ms-playwright`;
              const out: string[] = [];
              if (existsSync(cache)) {
                for (const d of readdirSync(cache)) {
                  const bin = `${cache}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
                  if (existsSync(bin)) out.push(bin);
                  const binIntel = `${cache}/${d}/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
                  if (existsSync(binIntel)) out.push(binIntel);
                }
              }
              return out;
            } catch { return []; }
          })(),
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
        for (const c of cands) { if (existsSync(c)) return c; }
        return null;
      };
      const chrome = findChrome();
      if (!chrome) throw new Error("no Chrome/Chromium binary found; install Google Chrome or let pi launch its bundled browser once");
      // reuse pi's browser profile so logins persist
      const userDataDir = `${home}/.pi/agent/state/browser/profile`;
      await mkdir(userDataDir, { recursive: true });
      // Use a separate lock-free profile dir so we don't fight pi's existing instance
      const myDataDir = `${home}/.pi/web-browser-profile`;
      await mkdir(myDataDir, { recursive: true });
      const { openSync } = await import("node:fs");
      const outFd = openSync(`${home}/.pi/web-browser.log`, "a");
      // Headless only when there is no display server (containers, servers). A desktop
      // session keeps the headed browser so the user can see what the agent is doing.
      const headless = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
      const proc = spawn(chrome, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${myDataDir}`,
        ...(headless ? ["--headless=new"] : []),
        "--no-first-run", "--no-default-browser-check", "--disable-features=Translate",
        // Containers run as root with a small /dev/shm: both flags are required there,
        // harmless on a normal desktop.
        "--no-sandbox", "--disable-dev-shm-usage",
        "--remote-allow-origins=*",
        "about:blank",
      ], { stdio: ["ignore", outFd, outFd], detached: true });
      proc.unref?.();
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 250));
        try {
          const ws = await tryPort(port);
          if (ws) {
            // ensure at least one page target exists (use PUT for Chrome 120+)
            try { await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }); } catch {
              try { await fetch(`http://127.0.0.1:${port}/json/new?about:blank`); } catch {}
            }
            browserState = { wsUrl: ws, port, proc, tabs: new Map() };
            return { wsUrl: ws, port };
          }
        } catch {}
      }
      // Read the log file to give a useful error
      let reason = "failed to connect to launched browser";
      try {
        const { readFileSync } = await import("node:fs");
        const log = readFileSync(`${home}/.pi/web-browser.log`, "utf8").split(/\n/).slice(-8).join("\n");
        if (log) reason += "; chrome log: " + log.slice(-1200);
      } catch {}
      throw new Error(reason);
    }

    // Minimal CDP client over WebSocket (resolved from pi's node_modules to avoid bundling ws)
    async function loadWs() {
      try { return await import("ws"); } catch {}
      throw new Error("ws module not found — add it to package.json dependencies");
    }
    async function cdpSend(wsUrl: string, method: string, params?: any, sessionId?: string): Promise<any> {
      const { default: WebSocket } = await loadWs();
      await new Promise<void>((res, rej) => { ws.once("open", res); ws.once("error", rej); });
      const id = Math.floor(Math.random() * 1e9);
      return new Promise<any>((resolve, reject) => {
        const handler = (d: any) => {
          const msg = JSON.parse(d.toString());
          if (msg.id === id) {
            ws.removeListener("message", handler);
            ws.close();
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        };
        ws.on("message", handler);
        ws.send(JSON.stringify({ id, method, params, sessionId }));
        setTimeout(() => { ws.removeListener("message", handler); ws.close(); reject(new Error("cdp timeout: " + method)); }, 15000);
      });
    }

    route("POST", /^\/api\/browser$/, async (_r, res, b) => {
      try {
        const action = String(b?.action || "");
        const { wsUrl, port } = await getBrowserWs();

        // List targets
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
        const pages = targets.filter(t => t.type === "page");

        if (action === "tabs_list") {
          return sendJson(res, 200, { tabs: pages.map((t: any) => ({ id: t.id, title: t.title, url: t.url, active: t.id === b?.activeId })), port });
        }
        if (action === "navigate") {
          let target = pages.find((t: any) => t.id === b?.targetId) || pages.find((t: any) => !t.url.startsWith("devtools://")) || pages[0];
          const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(b.url || "about:blank")}`).catch(() => null);
          // attach
          const version: any = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
          const { default: WebSocket } = await loadWs();
          const ws = new WebSocket(version.webSocketDebuggerUrl) as any;
          await new Promise<void>((res, rej) => { ws.once("open", res); ws.once("error", rej); });
          // find new target after navigation
          await new Promise(r => setTimeout(r, 800));
          const after: any[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          ws.close();
          return sendJson(res, 200, { ok: true });
        }
        if (action === "screenshot") {
          const target = pages.find((t: any) => t.id === b?.targetId) || pages[0];
          if (!target) return sendJson(res, 404, { error: "no page" });
          // attach via CDP and take screenshot via Target.attachToTarget + Page.captureScreenshot
          const version: any = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
          const { default: WebSocket } = await loadWs();
          const rootWs = new WebSocket(version.webSocketDebuggerUrl) as any;
          await new Promise<void>((res, rej) => { rootWs.once("open", res); rootWs.once("error", rej); });
          const id = Math.floor(Math.random() * 1e9);
          const attached: any = await new Promise<any>((resolve, reject) => {
            const h = (d: any) => {
              const m = JSON.parse(d.toString());
              if (m.id === id) { rootWs.removeListener("message", h); m.error ? reject(m.error) : resolve(m.result); }
            };
            rootWs.on("message", h);
            rootWs.send(JSON.stringify({ id, method: "Target.attachToTarget", params: { targetId: target.id, flatten: true } }));
          });
          const sid = attached.sessionId;
          await new Promise<any>((resolve, reject) => {
            const mid = id + 1;
            const h = (d: any) => {
              const m = JSON.parse(d.toString());
              if (m.id === mid) { rootWs.removeListener("message", h); m.error ? reject(m.error) : resolve(m.result); }
            };
            rootWs.on("message", h);
            rootWs.send(JSON.stringify({ id: mid, method: "Page.captureScreenshot", params: { format: "png" }, sessionId: sid }));
          }).then(r => {
            rootWs.close();
            sendJson(res, 200, { image: "data:image/png;base64," + r.data, url: target.url, title: target.title });
          }).catch(e => { rootWs.close(); sendJson(res, 500, { error: String(e) }); });
          return;
        }
        if (action === "navigate_tab") {
          // Strategy: create a new tab at the given URL via HTTP endpoint (reliable, no target attach needed)
          // If a targetId was provided and still exists, reuse it via /json/activate then navigate via CDP attach.
          let target: any = null;
          if (b?.targetId) target = pages.find((t: any) => t.id === b.targetId);
          if (!target) {
            // create new tab (Chrome 120+ requires PUT verb)
            try {
              const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(b.url)}`, { method: "PUT" }).then(r => r.json());
              target = created;
            } catch (e1) {
              try {
                const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(b.url)}`).then(r => r.json());
                target = created;
              } catch (e2) {
                return sendJson(res, 500, { error: "failed to create tab: " + String(e2) });
              }
            }
          } else {
            // navigate existing target via CDP (attach + Page.navigate)
            try {
              const version: any = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
              const { default: WebSocket } = await loadWs();
              const rootWs = new WebSocket(version.webSocketDebuggerUrl) as any;
              await new Promise<void>((res, rej) => { rootWs.once("open", res); rootWs.once("error", rej); setTimeout(()=>rej(new Error("ws open timeout")), 4000); });
              const id = Math.floor(Math.random() * 1e9);
              const attached: any = await new Promise<any>((resolve, reject) => {
                const h = (d: any) => {
                  const m = JSON.parse(d.toString());
                  if (m.id === id) { rootWs.removeListener("message", h); m.error ? reject(m.error) : resolve(m.result); }
                };
                rootWs.on("message", h);
                rootWs.send(JSON.stringify({ id, method: "Target.attachToTarget", params: { targetId: target.id, flatten: true } }));
                setTimeout(()=>reject(new Error("attach timeout")), 4000);
              });
              const mid = id + 1;
              await new Promise<any>((resolve, reject) => {
                const h = (d: any) => {
                  const m = JSON.parse(d.toString());
                  if (m.id === mid) { rootWs.removeListener("message", h); m.error ? reject(m.error) : resolve(m.result); }
                };
                rootWs.on("message", h);
                rootWs.send(JSON.stringify({ id: mid, method: "Page.navigate", params: { url: b.url }, sessionId: attached.sessionId }));
                setTimeout(()=>reject(new Error("navigate timeout")), 6000);
              });
              rootWs.close();
            } catch (e) {
              // fall back: open fresh tab
              try {
                target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(b.url)}`, { method: "PUT" }).then(r => r.json());
              } catch { try { target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(b.url)}`).then(r => r.json()); } catch {} }
            }
          }
          if (!target) return sendJson(res, 404, { error: "no page" });
          sendJson(res, 200, { ok: true, targetId: target.id });
          return;
        }
        if (action === "activate") {
          await fetch(`http://127.0.0.1:${port}/json/activate/${b.targetId}`).catch(()=>{});
          return sendJson(res, 200, { ok: true });
        }
        if (action === "close_tab") {
          await fetch(`http://127.0.0.1:${port}/json/close/${b.targetId}`).catch(()=>{});
          return sendJson(res, 200, { ok: true });
        }
        if (action === "restart") {
          // kill the launched proc if we have one, reset state, reconnect
          try {
            if (browserState?.proc) { try { process.kill(browserState.proc.pid!, "SIGTERM"); } catch {} }
            const { execSync } = await import("node:child_process");
            try { execSync(`lsof -ti:${port} -sTCP:LISTEN | xargs kill -9 2>/dev/null`, { encoding: "utf8" }); } catch {}
          } catch {}
          browserState = null;
          await getBrowserWs();
          return sendJson(res, 200, { ok: true });
        }
        sendJson(res, 400, { error: "unknown action" });
      } catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); }
    });

    // ---- Slash commands: dynamic, synced with CLI ----
    // Builtins that map directly to RPC operations
    const BUILTIN_RPC_MAP: Record<string, string> = {
      new: "new_session", fork: "fork", clone: "clone", compact: "compact",
      abort: "abort",
    };
    // Builtins that need special web-side handling (cannot run headless)
    const TUI_ONLY = new Set(["settings", "login", "logout", "copy", "tree", "changelog",
      "hotkeys", "trust", "resume", "reload", "quit", "debug", "arminsayshi", "dementedelves",
      "scoped-models", "share", "import", "session"]);

    route("GET", /^\/api\/commands$/, async (_r, res) => {
      try {
        const list: any[] = [];
        const BUILTIN_SLASH_COMMANDS = await getBuiltinCommands();
        // Builtins from pi's source (single source of truth)
        for (const c of BUILTIN_SLASH_COMMANDS) {
          list.push({
            name: c.name, description: c.description,
            argumentHint: (c as any).argumentHint,
            source: "builtin",
            webSupport: TUI_ONLY.has(c.name) ? "tui-only" : (BUILTIN_RPC_MAP[c.name] || c.name === "model" || c.name === "name" || c.name === "thinking" || c.name === "export" || c.name === "help" ? "full" : "agent"),
          });
        }
        // Extension / prompt-template / skill commands from RPC
        try {
          const r = await rpc!.send({ type: "get_commands" });
          for (const c of r?.commands ?? []) {
            list.push({ ...c, webSupport: "full" });
          }
        } catch {}
        // Virtual: /help (web provides it), /thinking
        list.push({ name: "thinking", description: "Set thinking level", argumentHint: "<level>", source: "builtin", webSupport: "full" });
        list.push({ name: "help", description: "Show available slash commands", source: "builtin", webSupport: "full" });
        list.push({ name: "clear", description: "Start a fresh session", source: "builtin", webSupport: "full" });
        sendJson(res, 200, { commands: list });
      } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });

    route("POST", /^\/api\/slash$/, async (_r, res, b) => {
      try {
        const raw: string = (b?.command ?? "").trim();
        if (!raw.startsWith("/")) return sendJson(res, 400, { error: "not a slash command" });
        const spaceIdx = raw.indexOf(" ");
        const name = (spaceIdx >= 0 ? raw.slice(1, spaceIdx) : raw.slice(1)).toLowerCase();
        const arg = spaceIdx >= 0 ? raw.slice(spaceIdx + 1).trim() : "";

        // 1. Direct RPC map
        if (BUILTIN_RPC_MAP[name]) {
          const payload: any = { type: BUILTIN_RPC_MAP[name] };
          if (name === "compact") payload.customInstructions = arg || undefined;
          if (name === "fork" && b?.entryId) payload.entryId = b.entryId;
          await rpc!.send(payload);
          return sendJson(res, 200, { action: "rpc", command: name });
        }

        // 2. /model [term] — switch model
        if (name === "model") {
          const models = (await rpc!.send({ type: "get_available_models" }))?.models ?? [];
          if (!arg) return sendJson(res, 200, { action: "showModelPicker", models });
          const needle = arg.toLowerCase();
          const match = models.find((m: any) =>
            m.id.toLowerCase() === needle || m.name.toLowerCase() === needle ||
            m.id.toLowerCase() === needle.replace("/", "") ||
            `${m.provider}/${m.id}`.toLowerCase() === needle ||
            m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle)
          );
          if (!match) return sendJson(res, 404, { error: `No model matches "${arg}"` });
          await rpc!.send({ type: "set_model", provider: match.provider, modelId: match.id });
          return sendJson(res, 200, { action: "switchedModel", model: match });
        }

        // 3. /name <title>
        if (name === "name") {
          if (!arg) return sendJson(res, 200, { action: "showRename" });
          await rpc!.send({ type: "set_session_name", name: arg });
          return sendJson(res, 200, { action: "renamed", name: arg });
        }

        // 4. /thinking <level>
        if (name === "thinking") {
          const levels = (await rpc!.send({ type: "get_available_thinking_levels" }))?.levels ?? [];
          if (!arg) return sendJson(res, 200, { action: "showThinkingPicker", levels });
          const lv = arg.toLowerCase();
          if (!levels.includes(lv)) return sendJson(res, 400, { error: `Unknown thinking level: ${arg}. Try: ${levels.join(", ")}` });
          await rpc!.send({ type: "set_thinking_level", level: lv });
          return sendJson(res, 200, { action: "setThinking", level: lv });
        }

        // 5. /export [path]
        if (name === "export") {
          const r = await rpc!.send({ type: "export_html", outputPath: arg || undefined });
          return sendJson(res, 200, { action: "exported", path: r?.path });
        }

        // 6. /help
        if (name === "help" || name === "?") {
          return sendJson(res, 200, { action: "showHelp" });
        }

        // 7. /clear
        if (name === "clear") {
          await rpc!.send({ type: "new_session" });
          return sendJson(res, 200, { action: "newSession" });
        }

        // 8. TUI-only commands
        if (TUI_ONLY.has(name)) {
          return sendJson(res, 200, { action: "tuiOnly", command: name,
            message: `/${name} requires the interactive TUI. Use \`pi ${name}\` in your terminal.` });
        }

        // 9. Fallback: treat as extension/skill command → send to session via prompt (will be picked up by extension runner)
        // Send as a normal prompt; session.prompt will try extension commands first
        rpc!.send({ type: "prompt", message: raw });
        return sendJson(res, 200, { action: "prompt", command: name });
      } catch (e: any) { sendJson(res, 500, { error: String(e) }); }
    });

    server = createServer((req, res) => {
      const raw = req.url ?? "/"; const qi = raw.indexOf("?");
      const url = (qi >= 0 ? raw.slice(0, qi) : raw) || "/";
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.match(r.pattern);
        if (m) { (async () => { const b = req.method === "POST" ? await readBodyJson(req) : undefined; try { await r.handler(req, res, b, m); } catch (e: any) { sendJson(res, 500, { error: String(e?.message ?? e) }); } })(); return; }
      }
      sendJson(res, 404, { error: "not found", url });
    });

    // ---- Terminal WebSocket (PTY-free, line-buffered shell) ----
    // Spawns the user's shell per connected client; relays stdin/stdout as JSON
    // messages {type:"term_data", data} and {type:"term_input", data}. Size is
    // tracked for best-effort future use (xterm.js sends resize events).
    attachWebSocketServer(server, "/pty", (ws) => {
      const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
      const env = { ...process.env, TERM: "xterm-256color" };
      const proc = spawn(shell, [], { cwd: rpcCwd, env, stdio: ["pipe", "pipe", "pipe"] });
      const send = (o: unknown) => { if (ws.readyState === 1) ws.send(safeJson(o)); };

      const onStdout = (chunk: Buffer) => send({ type: "term_data", data: chunk.toString("utf8") });
      const onStderr = (chunk: Buffer) => send({ type: "term_data", data: chunk.toString("utf8") });
      proc.stdout.on("data", onStdout);
      proc.stderr.on("data", onStderr);
      proc.on("exit", (code) => { send({ type: "term_exit", code: code ?? 0 }); ws.close(); });

      ws.on("message", (raw: string) => {
        let msg: any; try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === "term_input" && typeof msg.data === "string") {
          try { proc.stdin.write(msg.data); } catch {}
        } else if (msg.type === "term_resize") {
          // we don't have a real PTY; ignore cols/rows but acknowledge
        } else if (msg.type === "term_cd") {
          const dir = String(msg.path || "").trim();
          const n = dir ? resolveFSPath(dir) : rpcCwd;
          try { proc.stdin.write(`cd ${JSON.stringify(n)}\n`); } catch {}
        } else if (msg.type === "term_ctrlc") {
          try { proc.kill("SIGINT"); } catch {}
        }
      });
      ws.on("close", () => { try { proc.kill("SIGHUP"); } catch {} });
    });

    attachWebSocketServer(server, "/ws", ws => {
      clients.add(ws);
      ws.on("message", async (raw: string) => {
        let msg: any; try { msg = JSON.parse(raw); } catch { return; }
        try {
          // Normalise images: accept either rpc ImageContent ({type,data,mimeType}) or
          // the browser-side attach shape ({mimeType, dataUrl}) from paste/drag.
          const normImages = (imgs: any[] | undefined): any[] | undefined => {
            if (!Array.isArray(imgs) || !imgs.length) return undefined;
            return imgs.map((im: any) => {
              if (im && typeof im === "object") {
                if (im.type === "image" && im.data && im.mimeType) return { type: "image", data: im.data, mimeType: im.mimeType };
                // dataUrl form: "data:image/png;base64,xxxx"
                if (im.dataUrl && typeof im.dataUrl === "string") {
                  const m = im.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
                  if (m) return { type: "image", data: m[2], mimeType: m[1] };
                }
                if (im.mimeType && im.data) return { type: "image", data: im.data, mimeType: im.mimeType };
              }
              return null;
            }).filter(Boolean);
          };
          switch (msg.type) {
            case "prompt": {
              const imgs = normImages(msg.images);
              const payload: any = { type: "prompt", message: String(msg.text ?? ""), images: imgs };
              console.log(`[pi-web] → prompt  textLen=${payload.message.length}  images=${imgs?.length ?? 0}`);
              rpc!.send(payload).then(
                (r) => console.log(`[pi-web] ← prompt accepted`, safeJson(r).slice(0, 200)),
                (err) => {
                  const emsg = String(err?.message ?? err);
                  console.log(`[pi-web] ✖ prompt rejected: ${emsg}`);
                  try { ws.send(safeJson({ type: "error", message: emsg, command: "prompt" })); } catch {}
                },
              );
              break;
            }
            case "abort": await rpc!.send({ type: "abort" }); break;
            case "fork": await rpc!.send({ type: "fork", entryId: msg.entryId }); break;
            case "new_session": await rpc!.send({ type: "new_session" }); break;
            case "clone": await rpc!.send({ type: "clone" }); break;
            case "compact": await rpc!.send({ type: "compact", customInstructions: msg.customInstructions }); break;
            case "undo": await rpc!.send({ type: "undo" }); break;
            case "export": await rpc!.send({ type: "export_html", outputPath: msg.outputPath }); break;
            case "steer": await rpc!.send({ type: "steer", message: msg.text, images: normImages(msg.images) }); break;
            case "follow_up": await rpc!.send({ type: "follow_up", message: msg.text, images: normImages(msg.images) }); break;
          }
        } catch (e: any) { ws.send(safeJson({ type: "error", message: String(e?.message ?? e) })); }
      });
      ws.on("close", () => clients.delete(ws));
      // Send hello with initial state
      rpc!.send({ type: "get_state" }).then(s => ws.send(safeJson({ type: "hello", state: s }))).catch(() => {});
    });

    server.on("error", async (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        console.log(`  🕸️  pi-web port ${port} in use — attempting to restart the previous instance…`);
        try { pi.ui.notify?.(`pi-web port ${port} busy, restarting…`, "info"); } catch {}
        const killed = await killListenersOnPort(port, host);
        if (killed) {
          // Wait briefly for the OS to release the port, then retry.
          await new Promise(r => setTimeout(r, 600));
          try { server.listen(port, host); } catch (e2: any) { failStart(e2); }
        } else {
          failStart(err);
        }
      } else {
        failStart(err);
      }
    });

    function failStart(err: any) {
      const msg = `pi-web failed to listen on ${host}:${port}: ${err?.message ?? err}`;
      console.error(`  ✖  ${msg}`);
      try { pi.ui.notify?.(msg, "error"); } catch {}
      rpc?.stop(); rpc = undefined;
    }

    server.listen(port, host, () => {
      const url = `http://127.0.0.1:${port}`;
      try { pi.ui.notify?.(`pi-web running at ${url}`, "info"); } catch {}
      console.log(`\n  🕸️  pi-web UI: ${url}\n`);
      if (pi.getFlag("web-open")) {
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        import("node:child_process").then(cp => cp.exec(`${opener} ${url}`).unref()).catch(() => {});
      }
    });
  });

  pi.on("session_shutdown", async () => {
    rpc?.stop(); rpc = undefined;
    try { for (const c of clients) c.close(); clients.clear(); } catch {}
    try { server?.close(); } catch {}
    server = undefined;
  });
}
