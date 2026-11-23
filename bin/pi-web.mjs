#!/usr/bin/env node
// Standalone launcher for pi-web — runs the extension outside the pi TUI.
//
// pi normally hosts this extension in-process (`pi --web`), which requires a
// PTY because pi itself is a TUI. This entry point instead mimics the handful
// of ExtensionAPI members the extension actually uses, then fires the
// `session_start` hook. The agent backend is still a `pi --mode rpc` child
// process, so pi must be installed and on PATH.
import { createJiti } from "jiti";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") flags.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) flags.port = Number(a.slice(7));
    else if (a === "--host") flags.host = argv[++i];
    else if (a.startsWith("--host=")) flags.host = a.slice(7);
    else if (a === "--no-open") flags.open = false;
    else if (a === "--help" || a === "-h") flags.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return flags;
}

let cli;
try {
  cli = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(2);
}

if (cli.help) {
  console.log(`pi-webui-panel — browser UI for pi

Usage: pi-webui-panel [--port 5174] [--host 127.0.0.1] [--no-open]

Requires pi (@earendil-works/pi-coding-agent) installed and on PATH.`);
  process.exit(0);
}

const flags = {
  web: true,
  "web-host": cli.host ?? "127.0.0.1",
  "web-port": cli.port ?? 5174,
  "web-open": cli.open ?? true,
};
const handlers = {};

const pi = {
  // Only record defaults for flags the user did not set on the CLI.
  registerFlag: (name, def) => {
    if (!(name in flags)) flags[name] = def.default;
  },
  getFlag: (name) => flags[name],
  on: (event, fn) => {
    handlers[event] = fn;
  },
  ui: { notify: (msg, level) => console.error(`[pi-web:${level ?? "info"}] ${msg}`) },
};

const jiti = createJiti(import.meta.url);
const mod = await jiti.import(join(root, "index.ts"));
mod.default(pi);

if (!handlers.session_start) {
  console.error("pi-web: extension did not register a session_start hook");
  process.exit(1);
}

await handlers.session_start({}, { cwd: process.cwd() });
