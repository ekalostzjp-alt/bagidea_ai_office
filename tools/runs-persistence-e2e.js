#!/usr/bin/env node
// 💾 Run persistence (กันงานหายถาวร + boot auto-resume) — end-to-end test.
//
//   node tools/runs-persistence-e2e.js [port]
//     Boots its OWN sandbox daemon (temp dir, stub claude, no API keys —
//     zero tokens, zero live state) from daemon/server.staged.js, then
//     KILLS it mid-run and reboots it to prove nothing is ever lost AND
//     nothing stays "ค้าง" — the boot triage resumes or closes everything.
//
// Verifies docs/run-persistence.contract.md:
//   • a started run lands in daemon/runs.json (atomic tmp+rename) with the
//     resume material: runId, agent, session, project, cwd, prompt, model,
//     status:"running", startedAt, lastTool, lastHeartbeat
//   • tool heartbeats update lastTool/lastHeartbeat on disk
//   • the Live-Log watchdog's "stuck" flag is persisted (state:"stuck")
//   • hard daemon kill mid-run → next boot AUTO-RESUMES it: stub sees
//     <run-recovery> + the original prompt, the record archives as
//     "resumed" (+resumedAs), the recovery run finishes "done" with
//     resumeChain:1 — ไม่มีงานค้างโผล่ ไม่ต้องมี human กด
//   • boot triage closes what cannot/should not resume: records whose
//     `result` already landed → done/failed (no fake "ค้าง"), agent gone
//     from the roster → failed, heartbeat older than OEP_RESUME_MAX_AGE_MS
//     → expired. Only a run that burned its auto-resume chain
//     (resumeChain ≥ OEP_RESUME_MAX_CHAIN) parks as "interrupted" for the CEO.
//   • POST /runs/resume (human) overrides the chain cap; resumeChain keeps
//     counting on the new run. POST /runs/dismiss archives as "dismissed".
//   • finished runs archive as "done" with endedAt; live stays empty
//   • guards: no x-bagidea-ui → 403, unknown runId → 404
// Exit 0 = pass, 1 = fail. Cleans up every process + temp dir it created.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const PORT = Number(process.argv[2] || 8799);
const HOST = "127.0.0.1";
const DAEMON = path.join(__dirname, "..", "daemon");
const SERVER_SRC = process.env.RUNS_E2E_SERVER ||
  path.join(DAEMON, "server.staged.js");
const TICK_MS = 1000, STUCK_MS = 3000, RESUME_AGE_MS = 60000;

const PASS = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const FAIL = (m) => { console.log("  \x1b[31m✗\x1b[0m " + m); process.exitCode = 1; };
const ok = (cond, m) => (cond ? PASS(m) : FAIL(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll until fn() returns truthy (or time runs out) — boot triage + the
// staggered dispatches land on their own clock, fixed sleeps are flaky.
async function until(fn, timeoutMs = 20000, step = 300) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch {}
    if (v) return v;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(step);
  }
}

function httpJson(method, p, body, noUiHeader) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: HOST, port: PORT, path: p, method,
      headers: { ...(noUiHeader ? {} : { "x-bagidea-ui": "1" }),
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

// ---------------------------------------------------------------- sandbox
let box, sboxDaemon, daemonProc = null;

function killTree(proc) {
  if (!proc || proc.pid == null) return;
  try { spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"],
    { windowsHide: true }); } catch {}
}

function makeSandbox() {
  box = fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-runs-e2e-"));
  sboxDaemon = path.join(box, "daemon");
  fs.mkdirSync(sboxDaemon, { recursive: true });
  fs.copyFileSync(SERVER_SRC, path.join(sboxDaemon, "server.js"));
  for (const f of ["channels.js", "plugins.js", "retrieval.js"])
    fs.copyFileSync(path.join(DAEMON, f), path.join(sboxDaemon, f));
  fs.cpSync(path.join(DAEMON, "brain"), path.join(sboxDaemon, "brain"), { recursive: true });
  // db.js intentionally NOT copied — server.js is fail-soft about it.
  fs.writeFileSync(path.join(sboxDaemon, "registry.json"), JSON.stringify({
    agents: { "แบล็ค": { name: "แบล็ค", role: "วิศวกร", avatar: 1, prompt: "",
      skills: [], tools: ["Read", "Bash"] } } }));

  // Stub claude: E2E_LONG = 2 tools then a long sleep (stuck + kill window);
  // <run-recovery> and everything else finish fast.  ORDER MATTERS — the
  // recovery prompt embeds the original E2E_LONG text.
  const stubBin = path.join(box, "stubbin");
  fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, "claude-stub.js"), `
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  const tool = (name) => line({ type: "assistant",
    message: { content: [{ type: "tool_use", name, id: "t" + Date.now(), input: {} }] } });
  const text = (t) => line({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
  const result = () => line({ type: "result", is_error: false,
    session_id: "e2e-" + Date.now() + "-" + Math.floor(Math.random() * 1e6),
    usage: {}, total_cost_usd: 0 });
  if (input.includes("<run-recovery>")) {
    tool("Read");
    await sleep(300); text("E2E กู้งานต่อเสร็จแล้ว"); result();
  } else if (input.includes("E2E_LONG")) {
    tool("Read");
    await sleep(1000); tool("Bash");
    await sleep(120000);   // parked: stuck flips at 3s, the test kills the daemon
  } else { text("รับทราบครับ"); result(); }
});
`);
  fs.writeFileSync(path.join(stubBin, "claude.cmd"), `@node "%~dp0claude-stub.js" %*\r\n`);
  fs.writeFileSync(path.join(stubBin, "codex.cmd"), "@echo off\r\nexit /b 0\r\n");
  return stubBin;
}

async function bootDaemon(stubBin, gen) {
  const env = { ...process.env, OEP_PORT: String(PORT),
    OEP_LIVE_TICK_MS: String(TICK_MS), OEP_STUCK_MS: String(STUCK_MS),
    OEP_RESUME_MAX_AGE_MS: String(RESUME_AGE_MS),   // shrink the expiry window
    PATH: stubBin + path.delimiter + process.env.PATH };
  delete env.OPENAI_API_KEY;   // nothing in the sandbox may bill anything
  delete env.GEMINI_API_KEY;
  const child = spawn(process.execPath, ["server.js"],
    { cwd: sboxDaemon, env, stdio: ["ignore", "pipe", "pipe"] });
  let bootLog = "";
  child.stdout.on("data", (d) => (bootLog += d));
  child.stderr.on("data", (d) => (bootLog += d));
  let up = null;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(500);
    up = await httpJson("GET", "/health").catch(() => null);
  }
  if (!up) {
    FAIL(`daemon gen${gen} never came up — log:\n` + bootLog.slice(-1500));
    killTree(child);
    process.exit(1);
  }
  // The daemon answering /health must be OURS: a zombie sandbox daemon from
  // an earlier run (or a parallel e2e) on the same port answers too, while
  // our own process sits parked in its EADDRINUSE retry loop. runs.json is
  // written inside OUR temp sandbox at "listening" — its appearance is proof.
  const t0 = Date.now();
  while (!fs.existsSync(runsFile()) && Date.now() - t0 < 15000) await sleep(300);
  if (!fs.existsSync(runsFile())) {
    FAIL(`daemon gen${gen}: /health answers but ${runsFile()} never appeared — ` +
      `another daemon owns :${PORT} (zombie or parallel run). Re-run on a free port.`);
    killTree(child);
    process.exit(1);
  }
  daemonProc = child;
  PASS(`daemon gen${gen} up on :${PORT} (isolated, stub claude, no API keys)`);
  return child;
}

const runsFile = () => path.join(sboxDaemon, "runs.json");
const readRuns = () => JSON.parse(fs.readFileSync(runsFile(), "utf8"));
const journalText = () => fs.readFileSync(path.join(sboxDaemon, "journal.jsonl"), "utf8");

(async () => {
  console.log(`\n  💾 run persistence + boot auto-resume — sandbox e2e on :${PORT}\n` +
    `  server under test: ${SERVER_SRC}\n`);
  const stubBin = makeSandbox();
  process.on("exit", () => {
    killTree(daemonProc);
    try { fs.rmSync(box, { recursive: true, force: true }); } catch {}
  });

  // ---- [1] fresh boot creates the file -------------------------------------
  console.log("[1] fresh boot");
  await bootDaemon(stubBin, 1);
  ok(fs.existsSync(runsFile()), "runs.json created at boot");
  {
    const s = readRuns();
    ok(s.schemaVersion === 1 && s.live && Array.isArray(s.interrupted) &&
      Array.isArray(s.history), "schema v1: {live, interrupted, history}");
  }

  // ---- [2] a started run is mirrored to disk with resume material ----------
  console.log("\n[2] run start → disk record");
  const chat = await httpJson("POST", "/chat",
    { agent: "แบล็ค", prompt: "E2E_LONG งานยาวทดสอบกันหาย" });
  ok(chat.status === 200 && chat.json && chat.json.task, "POST /chat dispatched: " + (chat.json && chat.json.task));
  const task1 = chat.json.task;
  await sleep(2500);   // stub: Read at ~0s, Bash at ~1s
  let rec;
  {
    const s = readRuns();
    rec = s.live[task1];
    ok(!!rec, "live record exists on disk for " + task1);
    ok(rec && /^r\d+-t\d+$/.test(rec.runId), "runId unique across boots: " + (rec && rec.runId));
    ok(rec && rec.agent === "แบล็ค" && rec.status === "running", "agent + status:running");
    ok(rec && typeof rec.session === "string" && !!rec.cwd, "session key + cwd persisted");
    ok(rec && rec.prompt.includes("E2E_LONG"), "full prompt persisted (resume material)");
    ok(rec && rec.lastTool === "Bash" && rec.lastHeartbeat > rec.startedAt,
      "heartbeat updated by tools (lastTool=Bash)");
  }
  {
    const r = await httpJson("GET", "/runs");
    const live = (r.json && r.json.live) || [];
    ok(r.status === 200 && live.length === 1 && live[0].task === task1,
      "GET /runs shows the live run");
    ok(live[0].prompt === undefined, "GET /runs strips prompts (server-side only)");
  }

  // ---- [3] watchdog stuck flag lands on disk too ----------------------------
  console.log("\n[3] stuck state mirrors the overlay watchdog");
  await sleep(4000);   // last tool ~1s in; STUCK_MS=3s → flagged by now
  {
    const r = await httpJson("GET", "/runs");
    ok(r.json.live[0] && r.json.live[0].state === "stuck",
      "GET /runs live state = stuck (same clock as overlay)");
    const s = readRuns();
    ok(s.live[task1] && s.live[task1].state === "stuck" && s.live[task1].stuckSince > 0,
      "runs.json record persisted state:stuck + stuckSince");
  }

  // ---- [4] hard kill mid-run → next boot RESUMES IT, no human ---------------
  console.log("\n[4] daemon dies mid-run → reboot → ต่อเองอัตโนมัติ ไม่มีงานค้าง");
  killTree(daemonProc); daemonProc = null;
  await sleep(1500);
  await bootDaemon(stubBin, 2);
  ok(fs.existsSync(runsFile() + ".bak"), "runs.json.bak kept (rollback copy)");
  // boot triage fires ~3s after boot, dispatch staggers +0.5s, recovery ~1s
  const resumed = await until(() =>
    readRuns().history.find((h) => h.runId === rec.runId && h.status === "resumed"));
  ok(!!resumed, "killed run auto-archived as resumed — ไม่ต้องมี human กด");
  ok(resumed && !!resumed.resumedAs,
    "resumedAs points at the recovery task: " + (resumed && resumed.resumedAs));
  const recDone = await until(() => resumed &&
    readRuns().history.find((h) => h.task === resumed.resumedAs && h.status === "done"));
  ok(!!recDone && recDone.endedAt > 0, "recovery run finished → history done");
  ok(!!recDone && recDone.resumeChain === 1, "recovery run carries resumeChain:1");
  {
    const s = readRuns();
    ok(s.interrupted.length === 0, "interrupted empty — ไม่มีงานค้างโผล่หลัง restart");
    ok(Object.keys(s.live).length === 0, "live empty after the recovery run ended");
    const j = journalText();
    ok(j.includes('"runs.recovered"'), "runs.recovered event journaled");
    ok(j.includes("🛟") && j.includes(rec.runId) && j.includes("ต่อให้อัตโนมัติ"),
      "🛟 announce journaled: run listed as ต่อให้อัตโนมัติ");
    ok(j.includes("E2E กู้งานต่อเสร็จแล้ว"),
      "stub saw <run-recovery> + the original prompt (reply journaled)");
  }

  // ---- [5] boot triage closes everything it must not resume -----------------
  console.log("\n[5] triage: จบแล้วปิด done/failed, เก่าเกินปิด expired, chain ครบค้างรอ CEO");
  killTree(daemonProc); daemonProc = null;
  await sleep(1200);
  const now = Date.now();
  const mk = (task, extra) => ({
    runId: "r" + (now - 60000) + "-" + task, task, agent: "แบล็ค", name: "แบล็ค",
    label: "crafted " + task, prompt: "งานทดสอบ triage " + task,
    session: "s-crafted-" + task, project: null, cwd: sboxDaemon, model: null,
    pid: 0, status: "running", state: "working",
    startedAt: now - 60000, lastTool: "Bash", lastHeartbeat: now - 5000, ...extra });
  const crafted = {
    doneRec:   mk("t91", { status: "done" }),   // result landed, close event never did
    failRec:   mk("t92", { status: "failed" }),
    ghostRec:  mk("t93", { agent: "ผีนอกroster", name: "ผี" }),
    oldRec:    mk("t94", { lastHeartbeat: now - 5 * 60000 }),  // > 60s age cap
    parkedA:   mk("t95", { resumeChain: 3 }),   // = OEP_RESUME_MAX_CHAIN default
    parkedB:   mk("t96", { resumeChain: 7 }),
  };
  {
    const file = readRuns();
    file.live = {};
    for (const r of Object.values(crafted)) file.live[r.task] = r;
    file.interrupted = [];
    fs.writeFileSync(runsFile(), JSON.stringify(file, null, 1));
  }
  await bootDaemon(stubBin, 3);
  await until(() => readRuns().history.some((x) => x.runId === crafted.doneRec.runId));
  {
    const s = readRuns();
    const h = (r, st) => s.history.find((x) => x.runId === r.runId && x.status === st);
    ok(!!h(crafted.doneRec, "done"), "result-landed record closed as done (ไม่ปลุกเป็นค้างปลอม)");
    ok(!!h(crafted.failRec, "failed"), "failed-result record closed as failed");
    ok(!!h(crafted.ghostRec, "failed"), "agent หายจาก roster → ปิดเป็น failed");
    ok(!!h(crafted.oldRec, "expired"), "heartbeat เก่าเกินเพดาน → ปิดเป็น expired");
    ok(s.interrupted.length === 2 &&
      s.interrupted.every((r) => (r.resumeChain || 0) >= 3),
      "เฉพาะ run ที่ใช้โควต้า auto-resume ครบเท่านั้นที่ค้างรอ CEO (กัน crash-loop)");
    ok(Object.keys(s.live).length === 0, "live empty");
    const everyDone = [crafted.doneRec, crafted.failRec, crafted.ghostRec, crafted.oldRec]
      .every((r) => { const x = s.history.find((y) => y.runId === r.runId);
        return x && x.endedAt > 0 && x.prompt === undefined; });
    ok(everyDone, "closed records all have endedAt and dropped their prompt");
  }

  // ---- [6] endpoint guards ----------------------------------------------------
  console.log("\n[6] endpoint guards");
  {
    const noUi = await httpJson("POST", "/runs/resume", { runId: crafted.parkedA.runId }, true);
    ok(noUi.status === 403, "resume without x-bagidea-ui → 403");
    const unknown = await httpJson("POST", "/runs/resume", { runId: "r0-t0" });
    ok(unknown.status === 404, "unknown runId → 404");
  }

  // ---- [7] manual resume overrides the chain cap -------------------------------
  console.log("\n[7] POST /runs/resume — คำสั่งเจ้าของข้าม chain cap ได้");
  {
    const before7 = Date.now();
    const r = await httpJson("POST", "/runs/resume", { runId: crafted.parkedA.runId });
    ok(r.status === 200 && r.json && r.json.ok && r.json.task,
      "manual resume accepted แม้ chain ครบโควต้า, new task " + (r.json && r.json.task));
    const arch = await until(() =>
      readRuns().history.find((h) => h.runId === crafted.parkedA.runId && h.status === "resumed"));
    ok(!!arch, "archived as resumed → " + (arch && arch.resumedAs));
    // task ids reset per daemon generation ("t1" exists in older history too)
    // — match the RECOVERY run by startedAt, not by bare task id.
    const done7 = await until(() => arch &&
      readRuns().history.find((h) => h.task === arch.resumedAs &&
        h.status === "done" && h.startedAt >= before7));
    ok(!!done7, "the manual recovery run finished → history done");
    ok(!!done7 && done7.resumeChain === 4, "resumeChain keeps counting on the lineage (4)");
  }

  // ---- [8] dismiss path ---------------------------------------------------------
  console.log("\n[8] dismiss archives without re-dispatch");
  {
    const d = await httpJson("POST", "/runs/dismiss", { runId: crafted.parkedB.runId });
    ok(d.status === 200 && d.json && d.json.status === "dismissed", "dismiss accepted");
    const s = readRuns();
    ok(s.interrupted.length === 0 &&
      s.history.some((h) => h.runId === crafted.parkedB.runId && h.status === "dismissed"),
      "archived as dismissed, nothing re-dispatched");
  }

  // ---- [9] normal completion archives as done ------------------------------------
  console.log("\n[9] ปกติ: run จบเอง → history done");
  {
    const c = await httpJson("POST", "/chat", { agent: "แบล็ค", prompt: "สวัสดีสั้นๆ" });
    const h = await until(() =>
      readRuns().history.find((x) => x.task === c.json.task && x.status === "done"));
    ok(!!h && h.endedAt > 0 && h.prompt === undefined,
      "finished run archived as done (prompt dropped, endedAt set)");
    // "empty" is an EVENTUAL state — the [7] recovery run may still be
    // closing a beat behind this one; what matters is nothing stays behind.
    const emptied = await until(() => Object.keys(readRuns().live).length === 0);
    if (!emptied) console.log("    live leftovers:", JSON.stringify(
      Object.values(readRuns().live).map(({ prompt, ...r }) => r)));
    ok(!!emptied, "live empty");
    ok(readRuns().interrupted.length === 0, "no interrupted leftovers at the end");
  }

  // ---- cleanup ----------------------------------------------------------------
  killTree(daemonProc); daemonProc = null;
  await sleep(500);
  try { fs.rmSync(box, { recursive: true, force: true }); } catch {}
  const fails = process.exitCode === 1;
  console.log(`\n${fails ? "HAS FAILURES" : "ALL PASS"} — sandbox cleaned, no processes left`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("E2E CRASHED:", e);
  killTree(daemonProc);
  try { fs.rmSync(box, { recursive: true, force: true }); } catch {}
  process.exit(2);
});
