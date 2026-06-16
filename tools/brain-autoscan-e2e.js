#!/usr/bin/env node
// Project Brain auto-scan policy — end-to-end test (zero dependency, sandboxed).
//
//   node tools/brain-autoscan-e2e.js [port]      (default 8801)
//
// Verifies the CEO's standing order (docs/project-brain.contract.md + the
// autoScanBrain hooks in daemon/server.js):
//   • pre-work  — a DELEGATE routed `@ <project>` into a NEVER-scanned project
//                 builds the Brain BEFORE the assignee's run starts
//                 (brain-cache/<id>.json exists while the agent is mid-run)
//   • idempotent — a second DELEGATE into the now-scanned project does NOT
//                 re-scan pre-work (cache file is enough)
//   • post-work — every finished project job triggers a re-scan + brain.ready
//   • deleted cache — wiping brain-cache/<id>.json makes the next DELEGATE
//                 pre-work scan again
//
// Boots a copy of daemon/server.js in a throwaway temp dir with a stub
// `claude` on PATH (instant, token-free, emits the stream-json the daemon
// parses), so the full Director → DELEGATE → agent-run → report-back cycle
// runs for real without touching live :8787 state or spending tokens.
// Exit 0 = pass, 1 = fail.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = Number(process.argv[2] || 8801);
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
          try { resolve({ status: res.statusCode, json: JSON.parse(t), text: t }); }
          catch { resolve({ status: res.statusCode, json: null, text: t }); } }); });
    req.setTimeout(90000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Minimal WS client — collects {type:"brain.ready"} events.
function wsListen(events) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({ host: HOST, port: PORT, path: "/ws",
      headers: { Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key } });
    req.on("upgrade", (_res, sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.slice(off, off + len);
          buf = buf.slice(off + len);
          if (op !== 1) continue;
          try {
            const m = JSON.parse(payload.toString("utf8"));
            if (m.type === "brain.ready") events.push(m);
          } catch {}
        }
      });
      sock.on("error", () => {});
      resolve(sock);
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  console.log(`\n  Project Brain auto-scan — sandboxed e2e on :${PORT}\n`);

  // ---- sandbox: copy the daemon + brain engine to a temp dir ---------------
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-brain-e2e-"));
  const sboxDaemon = path.join(box, "daemon");
  fs.mkdirSync(sboxDaemon, { recursive: true });
  fs.copyFileSync(path.join(DAEMON, "server.js"), path.join(sboxDaemon, "server.js"));
  for (const f of ["channels.js", "plugins.js", "retrieval.js"])
    fs.copyFileSync(path.join(DAEMON, f), path.join(sboxDaemon, f));
  fs.cpSync(path.join(DAEMON, "brain"), path.join(sboxDaemon, "brain"), { recursive: true });
  // db.js intentionally NOT copied — server.js is fail-soft about it.

  // Seed a delegate-able teammate (default registry only ships main + ceo).
  fs.writeFileSync(path.join(sboxDaemon, "registry.json"), JSON.stringify({
    agents: { black: { name: "Black", role: "วิศวกร", avatar: 1, prompt: "",
      skills: [], tools: ["Read", "Bash"] } } }));

  // The project the DELEGATE routes into — tiny but real (scan finds files).
  const projDir = path.join(box, "brainproj");
  fs.mkdirSync(projDir);
  fs.writeFileSync(path.join(projDir, "a.js"), 'const b = require("./b");\nmodule.exports = () => b() + 1;\n');
  fs.writeFileSync(path.join(projDir, "b.js"), "module.exports = () => 41;\n");

  // Stub claude: reads the prompt on stdin, answers with the stream-json the
  // daemon parses. Director order → a DELEGATE line into the project; the
  // delegated job sleeps 3s (so pre-work timing is observable mid-run).
  const stubBin = path.join(box, "stubbin");
  fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, "claude-stub.js"), `
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  let text = "รับทราบครับ";
  let wait = 0;
  if (input.includes("E2E_BRAIN_ORDER")) {
    text = "จัดให้ครับ\\nDELEGATE: black @ brainproj :: E2E_BRAIN_TASK งานทดสอบในโปรเจค";
  } else if (input.includes("E2E_BRAIN_TASK")) {
    wait = 3000;
    text = "E2E งานในโปรเจคเสร็จแล้วครับ";
  }
  if (wait) await new Promise((r) => setTimeout(r, wait));
  process.stdout.write(JSON.stringify({ type: "assistant",
    message: { content: [{ type: "text", text }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", is_error: false,
    session_id: "e2e-" + Date.now() + "-" + Math.floor(Math.random() * 1e6),
    usage: {}, total_cost_usd: 0 }) + "\\n");
});
`);
  fs.writeFileSync(path.join(stubBin, "claude.cmd"),
    `@node "%~dp0claude-stub.js" %*\r\n`);
  fs.writeFileSync(path.join(stubBin, "codex.cmd"), "@echo off\r\nexit /b 0\r\n");

  const env = { ...process.env, OEP_PORT: String(PORT),
    PATH: stubBin + path.delimiter + process.env.PATH };
  delete env.OPENAI_API_KEY;   // nothing in the sandbox may bill anything
  delete env.GEMINI_API_KEY;
  const child = spawn(process.execPath, ["server.js"],
    { cwd: sboxDaemon, env, stdio: ["ignore", "pipe", "pipe"] });
  let daemonLog = "";
  child.stdout.on("data", (d) => (daemonLog += d));
  child.stderr.on("data", (d) => (daemonLog += d));

  const cleanup = () => {
    try { child.kill(); } catch {}
    try { fs.rmSync(box, { recursive: true, force: true }); } catch {}
  };
  process.on("exit", cleanup);

  // wait for listen
  let up = null;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(500);
    up = await httpJson("GET", "/registry").catch(() => null);
  }
  if (!up || !up.json || !up.json.agents || !up.json.agents.black) {
    FAIL("sandbox daemon never came up (or lost the seeded agent) — log:\n" + daemonLog.slice(-1500));
    process.exit(1);
  }
  PASS("sandbox daemon up (isolated state, stub claude, no API keys)");

  const brainEvents = [];
  const sock = await wsListen(brainEvents);

  // ---- register the project (existing folder — /projects/add) --------------
  const add = await httpJson("POST", "/projects/add", { path: projDir, name: "brainproj" });
  if (add.status !== 200) { FAIL(`POST /projects/add → ${add.status} ${add.text.slice(0, 200)}`); process.exit(1); }
  const plist = await httpJson("GET", "/projects");
  const proj = (((plist.json || {}).projects) || []).find((p) => p.name === "brainproj");
  if (!proj) { FAIL("registered project not in GET /projects"); process.exit(1); }
  PASS(`project registered: ${proj.id} → ${projDir}`);
  const cacheFile = path.join(sboxDaemon, "brain-cache", proj.id + ".json");
  if (!fs.existsSync(cacheFile)) PASS("fresh project has NO brain cache (never scanned)");
  else { FAIL("cache file exists before any work?!"); process.exit(1); }

  const preScans = () => (daemonLog.match(/auto-scan: brainproj \(pre-work\)/g) || []).length;
  const postScans = () => (daemonLog.match(/auto-scan: brainproj \(post-work\)/g) || []).length;
  const waitFor = async (cond, ms) => {
    for (let i = 0; i < ms / 250; i++) { if (cond()) return true; await sleep(250); }
    return cond();
  };

  // ---- cycle 1: never-scanned project → pre-work scan BEFORE the run -------
  let r = await httpJson("POST", "/chat", { agent: "main", prompt: "E2E_BRAIN_ORDER สั่งงานเข้าโปรเจค" });
  if (r.status !== 200) { FAIL(`POST /chat → ${r.status}`); process.exit(1); }

  // dispatch delay is 4.5s; the stub job then runs 3s. Catch the cache file
  // while the job is still in flight = the scan really ran BEFORE the work.
  const preSeen = await waitFor(() => preScans() >= 1 && fs.existsSync(cacheFile), 7000);
  const duringRun = preScans() >= 1 && postScans() === 0;
  if (preSeen && duringRun)
    PASS("pre-work: brain built BEFORE the agent run (cache present mid-run, no post-work yet)");
  else FAIL(`pre-work scan missing/late — pre=${preScans()} post=${postScans()} cache=${fs.existsSync(cacheFile)}`);

  if (await waitFor(() => postScans() >= 1, 15000))
    PASS("post-work: job finished → automatic re-scan");
  else FAIL("post-work re-scan never happened — log:\n" + daemonLog.slice(-1200));
  await sleep(1200);   // let brain.ready frames drain
  const evs1 = brainEvents.filter((e) => e.project === proj.id).length;
  if (evs1 >= 2) PASS(`brain.ready broadcast on both scans (${evs1} events)`);
  else FAIL(`expected ≥2 brain.ready events, got ${evs1}`);

  // ---- cycle 2: already scanned → pre-work must SKIP (idempotent) ----------
  await sleep(2500);   // let the report-back director turn settle
  r = await httpJson("POST", "/chat", { agent: "main", prompt: "E2E_BRAIN_ORDER งานรอบสองโปรเจคเดิม" });
  if (r.status !== 200) { FAIL(`POST /chat (2) → ${r.status}`); process.exit(1); }
  if (await waitFor(() => postScans() >= 2, 20000)) {
    if (preScans() === 1) PASS("idempotent: scanned project NOT re-scanned pre-work (post-work still fired)");
    else FAIL(`pre-work ran again on a cached project — pre=${preScans()}`);
  } else FAIL("cycle 2 post-work never fired");

  // ---- cycle 3: cache deleted → pre-work scans again ------------------------
  await sleep(2500);
  fs.rmSync(cacheFile);
  r = await httpJson("POST", "/chat", { agent: "main", prompt: "E2E_BRAIN_ORDER งานรอบสามหลังลบ cache" });
  if (r.status !== 200) { FAIL(`POST /chat (3) → ${r.status}`); process.exit(1); }
  if (await waitFor(() => preScans() >= 2 && fs.existsSync(cacheFile), 10000))
    PASS("deleted cache → next DELEGATE pre-work scans again (cache rebuilt)");
  else FAIL(`cache-delete path broken — pre=${preScans()} cache=${fs.existsSync(cacheFile)}`);
  await waitFor(() => postScans() >= 3, 20000);

  // ---- the cached brain is actually servable -------------------------------
  const gb = await httpJson("GET", "/project/brain?project=brainproj");
  if (gb.status === 200 && gb.json && gb.json.stats && gb.json.stats.files >= 2)
    PASS(`GET /project/brain → 200 (${gb.json.stats.files} files, ${gb.json.stats.edges} edges)`);
  else FAIL(`GET /project/brain → ${gb.status} ${gb.text.slice(0, 120)}`);

  try { sock.destroy(); } catch {}
  // Graceful teardown: the exit-hook rmSync races the dying child's open
  // handles (Windows holds them a beat) — kill, wait, then sweep here.
  try { child.kill(); } catch {}
  await sleep(800);
  for (let i = 0; i < 5 && fs.existsSync(box); i++) {
    try { fs.rmSync(box, { recursive: true, force: true }); } catch { await sleep(400); }
  }
  const ok = process.exitCode !== 1;
  console.log("\n  " + (ok ? "\x1b[32mRESULT: PASS\x1b[0m" : "\x1b[31mRESULT: FAIL\x1b[0m") + "\n");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log("  \x1b[31m✗\x1b[0m fatal: " + e.message); process.exit(1); });
