#!/usr/bin/env node
// Review Decision + Process Step feed (BACKEND) — end-to-end, zero dependency.
// Boots a throwaway sandbox daemon from daemon/server.STAGED.js (the candidate,
// NOT live), with a stub `claude`/`codex` so it bills nothing and touches no
// live state. Verifies the two features Black staged:
//
//   (1) Manual approve/reject — POST /review/decision
//       • invalid decision → 400
//       • approve → 200 {ok, decision}, clears rounds, broadcasts review.decision
//       • reject  → 200, dispatches a rework job to the agent, broadcasts
//       • GET /review/status carries decisions[]
//   (2) Process Step feed — the REAL work, not just "working"
//       • a live run emits ws task.step {agent,task,seq,tool,detail,...}
//       • detail is distilled from tool input (file basename / command / …)
//       • GET /process/feed → {running, steps:{task:[…]}, lastSummary}
//       • activity.update rows carry lastDetail (additive)
//
//   node tools/review-decision-feed-e2e.js [port]    (default 8799)
// Exit 0 = pass, 1 = fail.

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.argv[2] || 8799);
const HOST = "127.0.0.1";
const DAEMON = path.join(__dirname, "..", "daemon");
const TICK_MS = 1000, STUCK_MS = 60000;

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

// Minimal WS client — collect by type into the supplied arrays.
function wsListen(bins) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({ host: HOST, port: PORT, path: "/ws",
      headers: { Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key } });
    req.on("upgrade", (_res, sock) => {
      let buf = Buffer.alloc(0), seq = 0;
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
            m._seq = seq++;
            if (bins[m.type]) bins[m.type].push(m);
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

async function bootSandbox() {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-reviewfeed-e2e-"));
  const sbox = path.join(box, "daemon");
  fs.mkdirSync(sbox, { recursive: true });
  // ⚠️ boot the STAGED candidate, not live server.js — this is what we're testing.
  fs.copyFileSync(path.join(DAEMON, "server.staged.js"), path.join(sbox, "server.js"));
  for (const f of ["channels.js", "plugins.js", "retrieval.js"])
    fs.copyFileSync(path.join(DAEMON, f), path.join(sbox, f));
  fs.cpSync(path.join(DAEMON, "brain"), path.join(sbox, "brain"), { recursive: true });

  fs.writeFileSync(path.join(sbox, "registry.json"), JSON.stringify({
    agents: { "แบล็ค": { name: "แบล็ค", role: "วิศวกร", avatar: 1, prompt: "",
      skills: [], tools: ["Read", "Bash"] } } }));

  const projDir = path.join(box, "proj");
  fs.mkdirSync(projDir);
  fs.writeFileSync(path.join(projDir, "a.txt"), "e2e\n");

  const stubBin = path.join(box, "stubbin");
  fs.mkdirSync(stubBin);
  // The delegated run emits real tool_use INPUTS so toolDetail() has something
  // to distill: Read→file basename, Bash→command, Grep→pattern.
  fs.writeFileSync(path.join(stubBin, "claude-stub.js"), `
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  const tool = (name, inp) => line({ type: "assistant",
    message: { content: [{ type: "tool_use", name, id: "t" + Date.now(), input: inp || {} }] } });
  const text = (t) => line({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
  const result = () => line({ type: "result", is_error: false,
    session_id: "e2e-" + Date.now() + "-" + Math.floor(Math.random() * 1e6),
    usage: {}, total_cost_usd: 0 });
  if (input.includes("E2E_ORDER")) {
    text("จัดให้ครับ\\nDELEGATE: แบล็ค @ tookjorThai :: E2E_STEPS งานทดสอบ step feed");
    result();
  } else if (input.includes("E2E_STEPS")) {
    await sleep(400);
    tool("Read", { file_path: "C:/proj/src/server.js" });
    await sleep(900);
    tool("Bash", { command: "npm run build --silent" });
    await sleep(900);
    tool("Grep", { pattern: "review/decision" });
    await sleep(900);
    text("E2E ขั้นตอนครบแล้วครับ"); result();
  } else { text("รับทราบครับ"); result(); }
});
`);
  fs.writeFileSync(path.join(stubBin, "claude.cmd"), `@node "%~dp0claude-stub.js" %*\r\n`);
  fs.writeFileSync(path.join(stubBin, "codex.cmd"), "@echo off\r\nexit /b 0\r\n");

  const env = { ...process.env, OEP_PORT: String(PORT),
    OEP_LIVE_TICK_MS: String(TICK_MS), OEP_STUCK_MS: String(STUCK_MS),
    PATH: stubBin + path.delimiter + process.env.PATH };
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  const child = spawn(process.execPath, ["server.js"],
    { cwd: sbox, env, stdio: ["ignore", "pipe", "pipe"] });
  let bootLog = "";
  child.stdout.on("data", (d) => (bootLog += d));
  child.stderr.on("data", (d) => (bootLog += d));
  const cleanup = () => {
    try { child.kill(); } catch {}
    try { fs.rmSync(box, { recursive: true, force: true }); } catch {}
  };
  process.on("exit", cleanup);

  let up = null;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(500);
    up = await httpJson("GET", "/registry").catch(() => null);
  }
  if (!up || !up.json || !up.json.agents || !up.json.agents["แบล็ค"]) {
    FAIL("sandbox daemon never came up — log:\n" + bootLog.slice(-1500));
    process.exit(1);
  }
  const add = await httpJson("POST", "/projects/add", { path: projDir, name: "tookjorThai" });
  if (add.status !== 200) { FAIL(`POST /projects/add → ${add.status}`); process.exit(1); }
  PASS("sandbox daemon up from server.staged.js (isolated state, stub claude, no API keys)");
  return cleanup;
}

(async () => {
  console.log(`\n  Review Decision + Process Step feed (backend) — e2e on http://${HOST}:${PORT}  [sandbox]\n`);
  const cleanup = await bootSandbox();
  const bins = { "review.decision": [], "task.step": [], "activity.update": [], "chat.message": [] };
  const sock = await wsListen(bins);
  await sleep(300);

  // ===================== (1) Manual approve/reject =========================
  console.log("  — Feature 1: manual approve/reject —");

  // status carries decisions[] from the start
  const st0 = await httpJson("GET", "/review/status");
  if (st0.status === 200 && Array.isArray(st0.json.decisions)) PASS("GET /review/status → decisions[] present");
  else FAIL("GET /review/status missing decisions[]: " + JSON.stringify(st0.json));

  // invalid decision → 400
  const bad = await httpJson("POST", "/review/decision", { agentId: "แบล็ค", decision: "maybe" });
  if (bad.status === 400) PASS("invalid decision → 400");
  else FAIL(`invalid decision → ${bad.status} (want 400)`);

  // unknown agent on reject → 404
  const unk = await httpJson("POST", "/review/decision",
    { agentId: "no-such-agent", decision: "reject", note: "x" });
  if (unk.status === 404) PASS("reject with unknown agent → 404");
  else FAIL(`reject unknown agent → ${unk.status} (want 404)`);

  // approve → 200, ok, persisted, broadcast
  const decBefore = bins["review.decision"].length;
  const ap = await httpJson("POST", "/review/decision",
    { agentId: "แบล็ค", project: "tookjorThai", decision: "approve", by: "CEO", note: "ผ่านครับ" });
  if (ap.status === 200 && ap.json && ap.json.ok && ap.json.decision &&
      ap.json.decision.decision === "approve" && ap.json.decision.by === "CEO" &&
      ap.json.decision.decisionId)
    PASS("approve → 200 {ok, decision{decision:approve, by:CEO, decisionId}}");
  else FAIL("approve response wrong: " + JSON.stringify(ap.json || ap.text));
  await sleep(200);
  if (bins["review.decision"].slice(decBefore).some((e) =>
      e.decision === "approve" && e.agentId === "แบล็ค"))
    PASS("ws review.decision broadcast on approve");
  else FAIL("no ws review.decision after approve");

  // reject → 200 + a rework job dispatched to the agent
  const jobsBefore = (await httpJson("GET", "/jobs").catch(() => ({ json: { jobs: [] } })));
  const nJobsBefore = ((jobsBefore.json || {}).jobs || []).length;
  const rj = await httpJson("POST", "/review/decision",
    { agentId: "แบล็ค", project: "tookjorThai", decision: "reject", by: "CEO", note: "แก้ตรง X" });
  if (rj.status === 200 && rj.json && rj.json.decision.decision === "reject")
    PASS("reject → 200 {ok, decision{decision:reject}}");
  else FAIL("reject response wrong: " + JSON.stringify(rj.json || rj.text));
  await sleep(300);
  const jobsAfter = (await httpJson("GET", "/jobs").catch(() => ({ json: { jobs: [] } })));
  const nJobsAfter = ((jobsAfter.json || {}).jobs || []).length;
  if (nJobsAfter > nJobsBefore) PASS(`reject dispatched a rework job to the agent (${nJobsBefore}→${nJobsAfter})`);
  else FAIL(`reject did not create a job (${nJobsBefore}→${nJobsAfter})`);

  // decisions[] now reflects both, newest first
  const st1 = await httpJson("GET", "/review/status");
  const ds = (st1.json || {}).decisions || [];
  if (ds.length >= 2 && ds[0].decision === "reject" && ds[1].decision === "approve")
    PASS("decisions[] persisted, newest-first (reject, approve)");
  else FAIL("decisions[] wrong: " + JSON.stringify(ds.slice(0, 3)));

  // ===================== (2) Process Step feed =============================
  console.log("\n  — Feature 2: process step feed —");

  // /process/feed shape even when idle
  const f0 = await httpJson("GET", "/process/feed");
  if (f0.status === 200 && Array.isArray(f0.json.running) && f0.json.steps &&
      typeof f0.json.steps === "object" && ("lastSummary" in f0.json))
    PASS("GET /process/feed → {running[], steps{}, lastSummary}");
  else FAIL("/process/feed shape wrong: " + JSON.stringify(f0.json));

  // Drive a real run that emits tool steps with inputs.
  const stepBefore = bins["task.step"].length;
  const order = await httpJson("POST", "/chat", { agent: "main", prompt: "E2E_ORDER สั่งงานทดสอบ step" });
  if (order.status !== 200) { FAIL(`POST /chat → ${order.status}`); }

  // Poll /process/feed while the delegated run is alive — keep the RICHEST
  // snapshot (one whose step ring has reached the Bash step, ideally), so the
  // assertions below see the full Read+Bash sequence, not a half-filled ring.
  let liveFeed = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const f = await httpJson("GET", "/process/feed");
    const tasks = Object.keys((f.json || {}).steps || {});
    const hit = tasks.find((t) => (f.json.steps[t] || []).some((s) => s.tool === "Read"));
    if (hit) liveFeed = { feed: f.json, task: hit };
    // Stop once we've captured a snapshot that includes the Bash step.
    if (liveFeed && (liveFeed.feed.steps[liveFeed.task] || []).some((s) => s.tool === "Bash")) break;
  }
  if (liveFeed) {
    PASS("GET /process/feed exposes live run steps while it runs");
    const steps = liveFeed.feed.steps[liveFeed.task];
    const shapeOk = steps.every((s) => Number.isInteger(s.seq) &&
      typeof s.tool === "string" && typeof s.detail === "string" && typeof s.ts === "number");
    if (shapeOk) PASS("each step = {seq:int, tool, detail, ts}");
    else FAIL("step shape wrong: " + JSON.stringify(steps[0]));
    const readStep = steps.find((s) => s.tool === "Read");
    if (readStep && readStep.detail === "server.js")
      PASS('toolDetail distilled Read input → basename "server.js"');
    else FAIL("Read detail wrong: " + JSON.stringify(readStep));
    const bashStep = steps.find((s) => s.tool === "Bash");
    if (bashStep && /npm run build/.test(bashStep.detail))
      PASS('toolDetail distilled Bash input → command "npm run build …"');
    else FAIL("Bash detail wrong: " + JSON.stringify(bashStep));
  } else FAIL("never saw the live run's steps in /process/feed");

  // ws task.step events streamed with detail
  await sleep(1500);
  const steps = bins["task.step"].slice(stepBefore);
  if (steps.length >= 2 &&
      steps.every((s) => typeof s.tool === "string" && typeof s.detail === "string" &&
        Number.isInteger(s.seq) && typeof s.task === "string"))
    PASS(`ws task.step streamed (${steps.length} events, each {agent,task,seq,tool,detail})`);
  else FAIL(`ws task.step wrong (count=${steps.length}): ` + JSON.stringify(steps[0] || null));
  if (steps.some((s) => s.detail === "server.js") && steps.some((s) => /npm run build/.test(s.detail)))
    PASS("ws task.step carries the distilled detail (file + command)");
  else FAIL("ws task.step missing distilled detail");

  // activity.update rows carry lastDetail (additive)
  const withDetail = bins["activity.update"].flatMap((e) => e.running || [])
    .filter((r) => typeof r.lastDetail === "string" && r.lastDetail);
  if (withDetail.some((r) => r.lastDetail === "server.js" || /npm run build/.test(r.lastDetail)))
    PASS("activity.update rows carry lastDetail (Live Log shows WHAT, not just the tool)");
  else FAIL("activity.update never carried lastDetail");

  // steps ring is dropped once the run ends (RAM-only, no leak)
  let drained = false;
  for (let i = 0; i < 30 && !drained; i++) {
    await sleep(400);
    const f = await httpJson("GET", "/process/feed");
    if (Object.keys((f.json || {}).steps || {}).length === 0 &&
        (f.json.running || []).length === 0) drained = true;
  }
  if (drained) PASS("step rings + runs cleared after the run ends (no RAM leak)");
  else FAIL("steps/running not cleared after the run ended");

  try { sock.destroy(); } catch {}
  cleanup();
  const ok = process.exitCode !== 1;
  console.log("\n  " + (ok ? "\x1b[32mRESULT: PASS\x1b[0m" : "\x1b[31mRESULT: FAIL\x1b[0m") + "\n");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log("  \x1b[31m✗\x1b[0m fatal: " + e.message); process.exit(1); });
