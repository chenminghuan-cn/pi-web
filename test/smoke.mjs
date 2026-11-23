#!/usr/bin/env node
// Smoke test against a running pi-web instance.
//
//   node test/smoke.mjs http://127.0.0.1:5174
//
// Exits non-zero if anything fails. Safe to run repeatedly — it only reads.
// The browser checks are skipped when the instance has no Chromium available.

const base = (process.argv[2] || "http://127.0.0.1:5174").replace(/\/$/, "");
let pass = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function get(path, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(base + path, { signal: ctrl.signal });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  } finally {
    clearTimeout(t);
  }
}

async function post(path, body, ms = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  } finally {
    clearTimeout(t);
  }
}

function wsRoundTrip(ms = 12000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve({ ok: false, error: "timeout" }); }, ms);
    ws.onerror = () => { clearTimeout(t); resolve({ ok: false, error: "ws error" }); };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data));
        if (m.type === "response" && m.command === "get_state") {
          clearTimeout(t);
          ws.close();
          resolve({ ok: true, data: m.data });
        }
      } catch {}
    };
  });
}

console.log(`\npi-web smoke test → ${base}\n`);

console.log("static:");
const home = await get("/");
check("GET /", home.status === 200 && home.text.includes("π"), `status ${home.status}`);
const js = await get("/app.js");
check("GET /app.js", js.status === 200 && js.text.length > 50000, `${js.text.length} bytes`);
const css = await get("/app.css");
check("GET /app.css", css.status === 200 && css.text.length > 5000, `${css.text.length} bytes`);

console.log("\napi:");
const state = await get("/api/state");
check("GET /api/state", state.status === 200 && !!state.json, `status ${state.status}`);
const sessions = await get("/api/sessions");
check("GET /api/sessions", sessions.status === 200 && Array.isArray(sessions.json?.sessions), `status ${sessions.status}`);
console.log(`       sessions: ${sessions.json?.sessions?.length ?? 0}`);
const projects = await get("/api/projects");
check("GET /api/projects", projects.status === 200 && Array.isArray(projects.json?.projects), `status ${projects.status}`);
const models = await get("/api/models");
check("GET /api/models", models.status === 200, `status ${models.status}`);
const fs = await get("/api/fs/list?path=");
check("GET /api/fs/list", fs.status === 200, `status ${fs.status}`);
const cmds = await get("/api/commands");
check("GET /api/commands", cmds.status === 200, `status ${cmds.status}`);

console.log("\nwebsocket:");
const ws = await wsRoundTrip();
check("/ws get_state", ws.ok, ws.error || "");

console.log("\nbrowser (CDP):");
const tabs = await post("/api/browser", { action: "tabs_list" });
// 500 here means no Chrome in the image — report it as skipped, not failed.
if (tabs.status === 500 && /chrome|chromium|browser/i.test(tabs.text)) {
  console.log(`  skip browser checks — ${tabs.text.slice(0, 120)}`);
} else {
  check("POST /api/browser tabs_list", tabs.status === 200 && Array.isArray(tabs.json?.tabs), `status ${tabs.status} ${tabs.text.slice(0, 120)}`);
  const nav = await post("/api/browser", { action: "navigate", url: "about:blank" });
  check("POST /api/browser navigate", nav.status === 200, `status ${nav.status} ${nav.text.slice(0, 120)}`);
  const shot = await post("/api/browser", { action: "screenshot" });
  check("POST /api/browser screenshot", shot.status === 200 && String(shot.json?.image || "").startsWith("data:image/png"), `status ${shot.status} ${shot.text.slice(0, 120)}`);
}

console.log(`\n${failures.length ? "FAILED" : "PASSED"}: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
