#!/usr/bin/env node
// Pre-deploy smoke for the reviewfeed batch (server.staged.js → server.js).
//
//   node tools/reviewfeed-deploy-smoke.js [port]      (default 8899)
//
// Boots daemon/server.staged.js fully sandboxed in a temp dir (stubbed
// claude/codex, no API keys) and verifies the endpoints the 2026-06-12
// deploy depends on:
//   1. GET /review/status  → 200 with a decisions[] array
//   2. GET /process/feed   → 200
//   3. GET /activity       → 200 with running[]
// Exit 0 = pass, 1 = fail. No state is touched on the live :8787 daemon.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.argv[2] || 8899);
const HOST = "127.0.0.1";
const DAEMON = path.join(__dirname, "..", "daemon");

const PASS = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const FAIL = (m) => { console.log("  \x1b[31m✗\x1b[0m " + m); process.exitCode = 1; };

function httpJson(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: HOST, port: PORT, path: p, method,
      headers: { ...(headers || {}),
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } },
      (res) => { const ch = []; res.on("data", (d) => ch.push(d));
        res.on("end", () => { const t = Buffer.concat(ch).toString("utf8");
          try { resolve({ status: res.statusCode, json: JSON.parse(t), text: t }); }
          catch { resolve({ status: res.statusCode, json: null, text: t }); } }); });
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`\n  reviewfeed deploy smoke — sandboxed (server.staged.js) on :${PORT}\n`);

  const box = fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-reviewfeed-smoke-"));
  const sboxDaemon = path.join(box, "daemon");
  fs.mkdirSync(sboxDaemon, { recursive: true });
  fs.copyFileSync(path.join(DAEMON, "server.staged.js"), path.join(sboxDaemon, "server.js"));
  for (const f of ["channels.js", "plugins.js", "retrieval.js"])
    fs.copyFileSync(path.join(DAEMON, f), path.join(sboxDaemon, f));
  fs.cpSync(path.join(DAEMON, "brain"), path.join(sboxDaemon, "brain"), { recursive: true });
  // Stub claude/codex so no background tick can spawn a real (billed) CLI.
  const stubBin = path.join(box, "stubbin");
  fs.mkdirSync(stubBin);
  for (const n of ["claude", "codex"])
    fs.writeFileSync(path.join(stubBin, n + ".cmd"), "@echo off\r\nexit /b 0\r\n");

  const env = { ...process.env, OEP_PORT: String(PORT),
    PATH: stubBin + path.delimiter + process.env.PATH };
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  const child = spawn(process.execPath, ["server.js"], { cwd: sboxDaemon, env, stdio: ["ignore", "pipe", "pipe"] });
  let bootLog = "";
  child.stdout.on("data", (d) => (bootLog += d));
  child.stderr.on("data", (d) => (bootLog += d));

  const cleanup = () => {
    try { child.kill(); } catch {}
    try { fs.rmSync(box, { recursive: true, force: true }); } catch {}
  };
  process.on("exit", cleanup);

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(500);
    try { up = (await httpJson("GET", "/registry")).status === 200; } catch {}
  }
  if (!up) { FAIL("sandbox daemon never came up\n" + bootLog.slice(-800)); process.exit(1); }
  PASS("sandbox daemon up");

  // 1) /review/status carries decisions[]
  const rs = await httpJson("GET", "/review/status");
  if (rs.status === 200 && rs.json && Array.isArray(rs.json.decisions))
    PASS("/review/status → 200, decisions[] present (" + rs.json.decisions.length + " entries)");
  else
    FAIL("/review/status bad: status=" + rs.status + " body=" + rs.text.slice(0, 200));

  // 2) /process/feed answers 200
  const pf = await httpJson("GET", "/process/feed");
  if (pf.status === 200) PASS("/process/feed → 200");
  else FAIL("/process/feed bad: status=" + pf.status + " body=" + pf.text.slice(0, 200));

  // 3) /activity still normal
  const ac = await httpJson("GET", "/activity");
  if (ac.status === 200 && ac.json && Array.isArray(ac.json.running))
    PASS("/activity → 200, running[] present");
  else
    FAIL("/activity bad: status=" + ac.status + " body=" + ac.text.slice(0, 200));

  cleanup();
  console.log(process.exitCode ? "\n  RESULT: FAIL\n" : "\n  RESULT: PASS 3/3\n");
})().catch((e) => { console.error("smoke crashed:", e); process.exit(1); });
