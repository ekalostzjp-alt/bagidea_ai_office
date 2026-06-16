#!/usr/bin/env node
// Default-root removal — routing e2e (zero dependency, zero tokens).
//
//   node tools/default-root-routing-e2e.js [port]
//     boots its OWN sandbox daemon (temp dir, stub claude, no API keys) on
//     [port|8799]. NEVER touches the live daemon on :8787.
//
// Verifies the "no more Default/workspace fallback" routing rules:
//   1. GET /projects exposes home = the project registered at the app root
//   2. /chat with NO project → run adopts the home project (cwd = app root,
//      thread bound to home) — not the legacy bare workspace
//   3. /chat with explicit project id (the picker's payload) → routes there
//   4. /chat with project by NAME → resolves and routes there
//   5. /chat with no project on a thread already bound elsewhere → keeps its
//      home (the fallback must never steal bound threads / fork them)
// Cleans up: kills the sandbox daemon, removes the temp dir, and strips the
// trust entries ensureTrusted() wrote into ~/.claude.json for temp paths.
// Exit 0 = pass, 1 = fail.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.argv[2] || 8799);
const HOST = "127.0.0.1";
const DAEMON = path.join(__dirname, "..", "daemon");

const PASS = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const FAIL = (m) => { console.log("  \x1b[31m✗\x1b[0m " + m); process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: HOST, port: PORT, path: p, method,
      headers: { "x-bagidea-ui": "1",
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } },
      (res) => { const ch = []; res.on("data", (d) => ch.push(d));
        res.on("end", () => { const t = Buffer.concat(ch).toString("utf8");
          try { resolve({ status: res.statusCode, json: JSON.parse(t) }); }
          catch { resolve({ status: res.statusCode, json: null, text: t }); } }); });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log(`\n  Default-root routing — sandbox e2e on http://${HOST}:${PORT}\n`);

  // ---- sandbox: box/ is the "app root", box/daemon holds server.js --------
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-defroot-e2e-"));
  const sboxDaemon = path.join(box, "daemon");
  fs.mkdirSync(sboxDaemon, { recursive: true });
  fs.copyFileSync(path.join(DAEMON, "server.js"), path.join(sboxDaemon, "server.js"));
  // Keep in lockstep with server.js's own require() list — every sibling module
  // it pulls in at boot must exist in the sandbox or the daemon dies with
  // MODULE_NOT_FOUND before a single case runs.
  for (const f of ["channels.js", "plugins.js", "retrieval.js", "constants.js",
    "maintenance.js", "skills.js", "osutil.js", "watchdog.js", "watchdog-runtime.js"])
    fs.copyFileSync(path.join(DAEMON, f), path.join(sboxDaemon, f));
  fs.cpSync(path.join(DAEMON, "brain"), path.join(sboxDaemon, "brain"), { recursive: true });
  // db.js intentionally NOT copied — server.js is fail-soft about it.

  fs.writeFileSync(path.join(sboxDaemon, "registry.json"), JSON.stringify({
    agents: { "แบล็ค": { name: "แบล็ค", role: "วิศวกร", avatar: 1, prompt: "",
      skills: [], tools: ["Read", "Bash"] } } }));

  // Two registered projects: HOME (dir = the sandbox app root itself, like the
  // real bagidea registration) and a sibling like tookjorThai.
  const projDir = path.join(box, "proj");
  fs.mkdirSync(projDir);
  fs.writeFileSync(path.join(projDir, "a.txt"), "e2e\n");
  const HOME_ID = "phome1", PROJ_ID = "pother1";
  fs.writeFileSync(path.join(sboxDaemon, "projects.json"), JSON.stringify([
    { id: HOME_ID, name: "bagidea", dir: box, ts: 1, created: false },
    { id: PROJ_ID, name: "tookjorThai", dir: projDir, ts: 2, created: false },
  ]));

  // Stub claude: records its cwd (= where the daemon routed the run) per tag.
  const stubBin = path.join(box, "stubbin");
  fs.mkdirSync(stubBin);
  const cwdLog = path.join(box, "cwdlog.jsonl");
  fs.writeFileSync(path.join(stubBin, "claude-stub.js"), `
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const fsx = require("fs");
  const tag = (input.match(/E2E_TAG_[A-Z]+/) || [""])[0];
  if (process.env.E2E_CWD_LOG)
    fsx.appendFileSync(process.env.E2E_CWD_LOG,
      JSON.stringify({ tag, cwd: process.cwd() }) + "\\n");
  const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  line({ type: "assistant", message: { content: [{ type: "text", text: "รับทราบครับ" }] } });
  line({ type: "result", is_error: false,
    session_id: "e2e-" + Date.now() + "-" + Math.floor(Math.random() * 1e6),
    usage: {}, total_cost_usd: 0 });
});
`);
  fs.writeFileSync(path.join(stubBin, "claude.cmd"), `@node "%~dp0claude-stub.js" %*\r\n`);
  fs.writeFileSync(path.join(stubBin, "codex.cmd"), "@echo off\r\nexit /b 0\r\n");

  const env = { ...process.env, OEP_PORT: String(PORT), E2E_CWD_LOG: cwdLog,
    PATH: stubBin + path.delimiter + process.env.PATH };
  delete env.OPENAI_API_KEY;   // nothing in the sandbox may bill anything
  delete env.GEMINI_API_KEY;
  const child = spawn(process.execPath, ["server.js"],
    { cwd: sboxDaemon, env, stdio: ["ignore", "pipe", "pipe"] });
  let bootLog = "";
  child.stdout.on("data", (d) => (bootLog += d));
  child.stderr.on("data", (d) => (bootLog += d));
  const cleanup = () => {
    try { child.kill(); } catch {}
    try { fs.rmSync(box, { recursive: true, force: true }); } catch {}
    // ensureTrusted() pre-trusts project dirs in the REAL ~/.claude.json —
    // strip the temp-dir entries this test created.
    try {
      const cj = path.join(os.homedir(), ".claude.json");
      const j = JSON.parse(fs.readFileSync(cj, "utf8"));
      const boxKey = String(box).replace(/\\/g, "/").toLowerCase();
      let dirty = false;
      for (const k of Object.keys(j.projects || {}))
        if (k.toLowerCase().startsWith(boxKey)) { delete j.projects[k]; dirty = true; }
      if (dirty) fs.writeFileSync(cj, JSON.stringify(j, null, 2));
    } catch {}
  };
  process.on("exit", cleanup);

  let up = null;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(500);
    up = await httpJson("GET", "/registry").catch(() => null);
  }
  if (!up || !up.json || !up.json.agents) {
    FAIL("sandbox daemon never came up — log:\n" + bootLog.slice(-1500));
    process.exit(1);
  }

  const norm = (s) => String(s).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const readCwdLog = () => fs.existsSync(cwdLog)
    ? fs.readFileSync(cwdLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const readSess = () => {
    try { return JSON.parse(fs.readFileSync(path.join(sboxDaemon, "sessions.json"), "utf8")); }
    catch { return {}; }
  };
  const chat = (prompt, project) =>
    httpJson("POST", "/chat", { agent: "แบล็ค", prompt, wait: true,
      ...(project ? { project } : {}) });

  // 1 — /projects exposes home
  const pr = await httpJson("GET", "/projects");
  if (pr.json && pr.json.home === HOME_ID) PASS("GET /projects → home = app-root project (" + HOME_ID + ")");
  else FAIL("GET /projects home: expected " + HOME_ID + ", got " + JSON.stringify(pr.json && pr.json.home));

  // 2 — no project → adopted by home (NOT the bare workspace)
  await chat("E2E_TAG_NOPROJ งานทดสอบไม่ระบุโปรเจค");
  let rec = readCwdLog().find((r) => r.tag === "E2E_TAG_NOPROJ");
  if (rec && norm(rec.cwd) === norm(box)) PASS("no project → cwd = app root (home), not workspace");
  else FAIL("no project: expected cwd " + box + ", got " + JSON.stringify(rec));
  let th = (readSess()["แบล็ค"] || []);
  if (th.length === 1 && th[0].proj === HOME_ID) PASS("thread bound to home project");
  else FAIL("thread binding: " + JSON.stringify(th.map((t) => t.proj)));

  // 3 — explicit project id (what the picker sends) → routes there
  await chat("E2E_TAG_EXPLICIT งานทดสอบระบุ id", PROJ_ID);
  rec = readCwdLog().find((r) => r.tag === "E2E_TAG_EXPLICIT");
  if (rec && norm(rec.cwd) === norm(projDir)) PASS("explicit project id → cwd = that project");
  else FAIL("explicit id: expected cwd " + projDir + ", got " + JSON.stringify(rec));

  // 4 — project by NAME resolves too (resolveProjectRef)
  await chat("E2E_TAG_BYNAME งานทดสอบระบุชื่อ", "tookjorThai");
  rec = readCwdLog().find((r) => r.tag === "E2E_TAG_BYNAME");
  if (rec && norm(rec.cwd) === norm(projDir)) PASS("project by name → cwd = that project");
  else FAIL("by name: expected cwd " + projDir + ", got " + JSON.stringify(rec));

  // 5 — no project on a thread already bound elsewhere → binding kept, no fork
  const before = (readSess()["แบล็ค"] || []).length;
  await chat("E2E_TAG_KEEP งานต่อเนื่องไม่ระบุโปรเจค");
  rec = readCwdLog().find((r) => r.tag === "E2E_TAG_KEEP");
  th = readSess()["แบล็ค"] || [];
  const latest = th.length ? th.reduce((a, b) => (a.ts > b.ts ? a : b)) : null;
  if (rec && norm(rec.cwd) === norm(projDir) && latest && latest.proj === PROJ_ID &&
      th.length === before)
    PASS("bound thread keeps its project (no home-steal, no fork)");
  else FAIL("keep-binding: cwd=" + JSON.stringify(rec) + " proj=" +
    (latest && latest.proj) + " threads " + before + "→" + th.length);

  cleanup();
  const ok = process.exitCode !== 1;
  console.log("\n  " + (ok ? "\x1b[32mRESULT: PASS\x1b[0m" : "\x1b[31mRESULT: FAIL\x1b[0m") + "\n");
  process.exit(ok ? 0 : 1);
})();
