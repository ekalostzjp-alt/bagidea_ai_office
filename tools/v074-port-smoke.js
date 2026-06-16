#!/usr/bin/env node
// Smoke for the upstream v0.7.x port batch (server.staged.js, 2026-06-12).
//
//   node tools/v074-port-smoke.js [port]      (default 8809)
//
// Sandboxed boot of server.staged.js (stub claude/codex, no API keys, temp
// dir), then checks every newly-ported surface:
//   /recall, /i18n/all (+seed merge), /win, /watch, /open + /reveal guards,
//   /project/scan/status, jobs editable (/jobs/update prompt edit).
// Exit 0 = pass, 1 = fail. Never touches the live :8787 daemon.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.argv[2] || 8809);
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
  console.log(`\n  v0.7.x port smoke — sandboxed (server.staged.js) on :${PORT}\n`);

  const box = fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-v074-smoke-"));
  const sbox = path.join(box, "daemon");
  fs.mkdirSync(sbox, { recursive: true });
  fs.copyFileSync(path.join(DAEMON, "server.staged.js"), path.join(sbox, "server.js"));
  for (const f of ["channels.js", "plugins.js", "retrieval.js", "win.html", "watch.html"])
    fs.copyFileSync(path.join(DAEMON, f), path.join(sbox, f));
  fs.cpSync(path.join(DAEMON, "brain"), path.join(sbox, "brain"), { recursive: true });
  fs.cpSync(path.join(DAEMON, "i18n-seed"), path.join(sbox, "i18n-seed"), { recursive: true });
  const stubBin = path.join(box, "stubbin");
  fs.mkdirSync(stubBin);
  for (const n of ["claude", "codex"])
    fs.writeFileSync(path.join(stubBin, n + ".cmd"), "@echo off\r\nexit /b 0\r\n");

  const env = { ...process.env, OEP_PORT: String(PORT),
    PATH: stubBin + path.delimiter + process.env.PATH };
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  const child = spawn(process.execPath, ["server.js"], { cwd: sbox, env, stdio: ["ignore", "pipe", "pipe"] });
  let bootLog = "";
  child.stdout.on("data", (d) => (bootLog += d));
  child.stderr.on("data", (d) => (bootLog += d));
  const cleanup = () => {
    try { child.kill(); } catch {}
    try { fs.rmSync(box, { recursive: true, force: true }); } catch {}
  };
  process.on("exit", cleanup);

  let reg = null;
  for (let i = 0; i < 60 && !reg; i++) {
    await sleep(500);
    try { reg = (await httpJson("GET", "/registry")).json; } catch {}
  }
  if (!reg) { FAIL("sandbox daemon never came up\n" + bootLog.slice(-800)); process.exit(1); }
  PASS("sandbox daemon up");
  if (/\[retrieval\] \{/.test(bootLog) && !/\[retrieval\] (module unavailable|init:)/.test(bootLog))
    PASS("retrieval index initialized at boot");
  else FAIL("retrieval did not initialize: " + (bootLog.match(/\[retrieval\][^\n]*/) || ["no log line"])[0]);

  // /recall
  const rc = await httpJson("GET", "/recall?q=test");
  if (rc.status === 200 && rc.json && Array.isArray(rc.json.hits)) PASS("/recall → 200 {hits[]}");
  else FAIL("/recall bad: " + rc.status + " " + rc.text.slice(0, 120));

  // /i18n/all + seed merge
  const i18n = await httpJson("GET", "/i18n/all?lang=en");
  if (i18n.status === 200 && i18n.json && i18n.json.map && Object.keys(i18n.json.map).length > 0)
    PASS("/i18n/all?lang=en → 200, seeded map (" + Object.keys(i18n.json.map).length + " strings)");
  else FAIL("/i18n/all bad: " + i18n.status + " keys=" + (i18n.json && i18n.json.map ? Object.keys(i18n.json.map).length : "none"));

  // /win + /watch
  const win = await httpJson("GET", "/win");
  const wat = await httpJson("GET", "/watch");
  if (win.status === 200 && /<html|<!doctype/i.test(win.text)) PASS("/win → 200 html frame");
  else FAIL("/win bad: " + win.status);
  if (wat.status === 200 && /<html|<!doctype/i.test(wat.text)) PASS("/watch → 200 html page");
  else FAIL("/watch bad: " + wat.status);

  // /open + /reveal guards
  const openNoUi = await httpJson("POST", "/open", { path: "C:\\Windows\\system32\\calc.exe" });
  if (openNoUi.status === 403) PASS("/open without x-bagidea-ui → 403 (human-only guard)");
  else FAIL("/open guard broken: " + openNoUi.status);
  const revealOut = await httpJson("POST", "/reveal", { path: "C:\\Windows\\notepad.exe" }, { "x-bagidea-ui": "1" });
  if (revealOut.status === 403) PASS("/reveal outside allowed roots → 403 (allowlist guard)");
  else FAIL("/reveal allowlist broken: " + revealOut.status);

  // /project/scan/status (no param → global list)
  const ss = await httpJson("GET", "/project/scan/status");
  if (ss.status === 200 && ss.json && Array.isArray(ss.json.scanning)) PASS("/project/scan/status → 200 {scanning[]}");
  else FAIL("/project/scan/status bad: " + ss.status + " " + ss.text.slice(0, 120));

  // jobs editable: create (mode "at" far future so it never dispatches) → edit prompt → verify
  const agentId = Object.keys((reg && reg.agents) || {}).find((a) => a !== "ceo");
  if (!agentId) FAIL("no agent in sandbox registry to create a job with");
  else {
    const mk = await httpJson("POST", "/jobs", { agent: agentId, prompt: "SMOKE_JOB_BEFORE", mode: "at", at: Date.now() + 86400000 });
    if (mk.status !== 200 || !mk.json || !mk.json.id) FAIL("POST /jobs create failed: " + mk.status);
    else {
      const up = await httpJson("POST", "/jobs/update", { id: mk.json.id, prompt: "SMOKE_JOB_AFTER" });
      const list = await httpJson("GET", "/jobs");
      const row = list.json && list.json.jobs && list.json.jobs.find((j) => j.id === mk.json.id);
      if (up.status === 200 && row && row.prompt === "SMOKE_JOB_AFTER")
        PASS("jobs editable: /jobs/update prompt edit persists");
      else FAIL("jobs edit failed: up=" + up.status + " prompt=" + (row && row.prompt));
      await httpJson("POST", "/jobs/update", { id: mk.json.id, remove: true });   // cleanup in-sandbox
    }
  }

  cleanup();
  const fails = process.exitCode ? "FAIL" : "PASS";
  console.log(`\n  RESULT: ${fails}\n`);
})().catch((e) => { console.error("smoke crashed:", e); process.exit(1); });
