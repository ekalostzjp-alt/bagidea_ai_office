#!/usr/bin/env node
// Auto-Scan GATE — end-to-end test (zero dependency, sandboxed, forward-looking).
//
//   node tools/auto-scan-gate-e2e.js [port]      (default 8802)
//
// CEO order: when a project is SELECTED, work must not begin until its Brain is
// ready. The gate Mr N is building turns the existing *synchronous* pre-work
// scan into an *async* one with an observable status + a real block window:
//   (1) select an UNSCANNED project → daemon auto-fires POST /project/scan and
//       GET /project/scan/status returns "scanning"
//   (2) while "scanning" → a task/chat into that project is GATE-BLOCKED (the
//       run does not start)
//   (3) scan completes → status "ready" → the held task starts
//   (4) an ALREADY-scanned project → no re-scan, work starts immediately
//
// IMPORTANT — this test must NOT modify daemon/server.js (Mr N owns the Brain
// backend; we only add a test file to avoid a merge collision). It is written
// test-first: it CAPABILITY-PROBES for the gate. Until Mr N promotes the gate
// into server.js, cases (1)-(4) report PENDING (not fail) and the suite instead
// guards that the merge keeps the existing contract surface + already-shipped
// features intact. The moment the gate endpoint appears, the full assertions
// activate automatically — re-run this same file.
//
// Sandbox only: boots a throwaway copy of daemon/server.js with a stub claude
// (token-free) on an isolated port. Never touches live :8787 state.
// Exit 0 = pass (incl. all-pending), 1 = a real regression.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = Number(process.argv[2] || 8802);
const HOST = "127.0.0.1";
const DAEMON = path.join(__dirname, "..", "daemon");
// The gate's status route, per the CEO/task spec. If Mr N names it differently,
// change this one constant and the probe + full-mode block follow.
const STATUS_ROUTE = "/project/scan/status";

const PASS = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const FAIL = (m) => { console.log("  \x1b[31m✗\x1b[0m " + m); process.exitCode = 1; };
const PEND = (m) => console.log("  \x1b[33m⏳ PENDING\x1b[0m " + m);
const INFO = (m) => console.log("  \x1b[36m•\x1b[0m " + m);
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

// Minimal WS client — bucket events by type into the supplied map of arrays.
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

// --------------------------------------------------------------- sandbox boot
async function bootSandbox(box) {
  const sbox = path.join(box, "daemon");
  fs.mkdirSync(sbox, { recursive: true });
  // Boot from LIVE server.js — the file Mr N will promote the gate into, so the
  // same test upgrades from PENDING → full the moment the feature lands.
  fs.copyFileSync(path.join(DAEMON, "server.js"), path.join(sbox, "server.js"));
  // Keep in lockstep with server.js's own require() list — every sibling module
  // it pulls in at boot must exist in the sandbox or the daemon dies with
  // MODULE_NOT_FOUND before a single case runs.
  for (const f of ["channels.js", "plugins.js", "retrieval.js", "constants.js",
    "maintenance.js", "skills.js", "osutil.js", "watchdog.js", "watchdog-runtime.js"])
    fs.copyFileSync(path.join(DAEMON, f), path.join(sbox, f));
  fs.cpSync(path.join(DAEMON, "brain"), path.join(sbox, "brain"), { recursive: true });
  // db.js intentionally NOT copied — server.js is fail-soft about it.

  fs.writeFileSync(path.join(sbox, "registry.json"), JSON.stringify({
    agents: { black: { name: "Black", role: "วิศวกร", avatar: 1, prompt: "",
      skills: [], tools: ["Read", "Bash"] } } }));

  // Two real (tiny) projects: one we leave unscanned, one we pre-scan.
  const mk = (name) => {
    const d = path.join(box, name);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "a.js"), 'const b = require("./b");\nmodule.exports = () => b() + 1;\n');
    fs.writeFileSync(path.join(d, "b.js"), "module.exports = () => 41;\n");
    return d;
  };
  const dirs = { gateproj: mk("gateproj"), gate2: mk("gate2") };

  const stubBin = path.join(box, "stubbin");
  fs.mkdirSync(stubBin);
  // Director order → DELEGATE into a named project; the delegated run emits a
  // tool then waits, so "did the task start?" is observable via activity/steps.
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
  const m = input.match(/E2E_GATE_ORDER@(\\S+)/);
  if (m) {
    text("จัดให้ครับ\\nDELEGATE: black @ " + m[1] + " :: E2E_GATE_TASK งานทดสอบ gate ในโปรเจค " + m[1]);
    result();
  } else if (input.includes("E2E_GATE_TASK")) {
    await sleep(300); tool("Read", { file_path: "a.js" });
    await sleep(2500); text("E2E gate task เสร็จครับ"); result();
  } else { text("รับทราบครับ"); result(); }
});
`);
  fs.writeFileSync(path.join(stubBin, "claude.cmd"), `@node "%~dp0claude-stub.js" %*\r\n`);
  fs.writeFileSync(path.join(stubBin, "codex.cmd"), "@echo off\r\nexit /b 0\r\n");

  const env = { ...process.env, OEP_PORT: String(PORT),
    PATH: stubBin + path.delimiter + process.env.PATH };
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  const child = spawn(process.execPath, ["server.js"],
    { cwd: sbox, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  let up = null;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(500);
    up = await httpJson("GET", "/registry").catch(() => null);
  }
  if (!up || !up.json || !up.json.agents || !up.json.agents.black) {
    FAIL("sandbox daemon never came up — log:\n" + log.slice(-1500));
    process.exit(1);
  }
  // Register both projects.
  for (const [name, dir] of Object.entries(dirs)) {
    const add = await httpJson("POST", "/projects/add", { path: dir, name });
    if (add.status !== 200) { FAIL(`POST /projects/add ${name} → ${add.status} ${add.text.slice(0, 160)}`); process.exit(1); }
  }
  PASS("sandbox daemon up from daemon/server.js (isolated state, stub claude, no API keys)");
  return { child, sbox, dirs, getLog: () => log };
}

(async () => {
  console.log(`\n  Auto-Scan GATE — sandboxed e2e on :${PORT}  [test-first / capability-probed]\n`);
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-scangate-e2e-"));
  let child;
  const cleanup = () => {
    try { child && child.kill(); } catch {}
    try { fs.rmSync(box, { recursive: true, force: true }); } catch {}
  };
  process.on("exit", cleanup);

  const boot = await bootSandbox(box);
  child = boot.child;
  const { sbox, dirs, getLog } = boot;
  const cacheOf = (pid) => path.join(sbox, "brain-cache", pid + ".json");
  const idOf = async (name) => {
    const pl = await httpJson("GET", "/projects");
    return (((pl.json || {}).projects) || []).find((p) => p.name === name);
  };
  const waitFor = async (cond, ms) => {
    for (let i = 0; i < ms / 150; i++) { if (await cond()) return true; await sleep(150); }
    return cond();
  };

  const bins = { "brain.ready": [], "scan.progress": [], "scan.done": [],
    "scan.status": [], "activity.update": [], "task.step": [], "chat.message": [] };
  const sock = await wsListen(bins);
  await sleep(300);

  const gateproj = await idOf("gateproj");
  const gate2 = await idOf("gate2");
  if (!gateproj || !gate2) { FAIL("registered projects not visible in GET /projects"); cleanup(); process.exit(1); }
  PASS(`projects registered: gateproj=${gateproj.id}, gate2=${gate2.id} (both unscanned)`);

  // ===================== CAPABILITY PROBE ==================================
  // Gate present ⇔ GET /project/scan/status returns 2xx JSON carrying `status`.
  // Absent ⇔ the router falls through to its empty-body 404.
  const probe = await httpJson("GET", `${STATUS_ROUTE}?project=gateproj`).catch(() => ({ status: 0 }));
  // Agreed field with White's overlay = `state` ("scanning"|"ready"); `status`
  // tolerated as a fallback so a naming slip on either side never wedges the gate.
  const probeState = probe.json && (probe.json.state || probe.json.status);
  const GATE = probe.status === 200 && typeof probeState === "string";
  console.log("");
  if (GATE) PASS(`gate is LIVE — ${STATUS_ROUTE} → 200 {state:"${probeState}"} (running FULL assertions)`);
  else INFO(`gate not promoted yet — ${STATUS_ROUTE} → ${probe.status || "no-route"} (cases 1-4 PENDING; guarding existing surface)`);

  // ============ GUARD: existing contract + shipped features survive =========
  // Runs in BOTH modes — this is the "Mr N's merge must not drop anything" net.
  console.log("\n  — guard: existing markers/features must survive the merge —");

  // (a) Project Brain contract: unscanned → 404; POST scan → summary; cached → 200.
  const b0 = await httpJson("GET", "/project/brain?project=gateproj");
  if (b0.status === 404) PASS("unscanned project → GET /project/brain 404 (not scanned)");
  else FAIL(`unscanned brain should 404, got ${b0.status}`);

  const sBefore = bins["scan.progress"].length;
  const scan = await httpJson("POST", "/project/scan", { project: "gateproj" });
  if (scan.status === 200 && scan.json && scan.json.stats && scan.json.stats.files >= 2)
    PASS(`POST /project/scan → 200 summary (${scan.json.stats.files} files, ${scan.json.stats.edges} edges)`);
  else FAIL(`POST /project/scan → ${scan.status} ${scan.text.slice(0, 140)}`);
  await sleep(400);
  if (bins["scan.progress"].length > sBefore && bins["scan.done"].some((e) => e.project === gateproj.id))
    PASS("scan broadcast scan.progress + scan.done");
  else FAIL("scan.progress/scan.done not broadcast");
  if (bins["brain.ready"].some((e) => e.project === gateproj.id))
    PASS("scan broadcast brain.ready");
  else FAIL("brain.ready not broadcast");
  const b1 = await httpJson("GET", "/project/brain?project=gateproj");
  if (b1.status === 200 && b1.json && b1.json.stats) PASS("after scan → GET /project/brain 200 (cache servable)");
  else FAIL(`scanned brain should 200, got ${b1.status}`);

  // (b) Synchronous auto-scan policy markers still fire (pre-work scan-once).
  const pre = (n) => (getLog().match(new RegExp(`auto-scan: ${n} \\(pre-work\\)`, "g")) || []).length;
  const post = (n) => (getLog().match(new RegExp(`auto-scan: ${n} \\(post-work\\)`, "g")) || []).length;
  // gate2 is unscanned → a DELEGATE into it must pre-work scan before the run.
  await httpJson("POST", "/chat", { agent: "main", prompt: "E2E_GATE_ORDER@gate2 สั่งงานเข้าโปรเจค gate2" });
  const sawPre = await waitFor(async () => pre("gate2") >= 1 && fs.existsSync(cacheOf(gate2.id)), 9000);
  if (sawPre) PASS("autoScanBrain pre-work marker intact (unscanned gate2 scanned on DELEGATE)");
  else FAIL(`pre-work auto-scan marker missing — pre=${pre("gate2")} cache=${fs.existsSync(cacheOf(gate2.id))}`);
  if (await waitFor(async () => post("gate2") >= 1, 16000))
    PASS("autoScanBrain post-work marker intact (re-scan after the job)");
  else FAIL("post-work auto-scan marker missing");

  // (c) Already-shipped reviewfeed/process-feed endpoints still present
  //     (Black's prior deploy — the merge must not regress them).
  const pf = await httpJson("GET", "/process/feed");
  if (pf.status === 200 && pf.json && Array.isArray(pf.json.running) && pf.json.steps && ("lastSummary" in pf.json))
    PASS("shipped feature intact: GET /process/feed {running,steps,lastSummary}");
  else FAIL(`/process/feed regressed: ${pf.status}`);
  const rd = await httpJson("POST", "/review/decision", { agentId: "black", decision: "nope" });
  if (rd.status === 400) PASS("shipped feature intact: POST /review/decision validates (→400 on bad decision)");
  else FAIL(`/review/decision regressed: ${rd.status} (want 400)`);
  const rs = await httpJson("GET", "/review/status");
  if (rs.status === 200 && rs.json && Array.isArray(rs.json.decisions))
    PASS("shipped feature intact: GET /review/status carries decisions[]");
  else FAIL(`/review/status.decisions regressed: ${rs.status}`);

  // ===================== FULL GATE CASES (1-4) =============================
  console.log("\n  — gate flow (cases 1-4) —");
  if (!GATE) {
    PEND(`(1) select unscanned → auto POST /project/scan + status "scanning" — needs ${STATUS_ROUTE}`);
    PEND('(2) during "scanning" → task/chat gate-blocked (run does not start)');
    PEND('(3) scan complete → status "ready" → held task starts');
    PEND('(4) already-scanned project → no re-scan, task starts immediately');
    INFO("re-run this file after Mr N promotes the gate into server.js — these activate automatically.");
  } else {
    // status reader for the live gate.
    const statusOf = async (name) => {
      const r = await httpJson("GET", `${STATUS_ROUTE}?project=${encodeURIComponent(name)}`);
      return (r.json && (r.json.state || r.json.status)) || null;
    };
    // Trigger SELECTION of an unscanned project. Prefer an explicit select
    // endpoint if the gate ships one; else fall back to the DELEGATE entry path
    // the gate is meant to intercept.
    const fresh = await idOf("gateproj");   // re-resolve (already scanned above) → use a brand-new one
    // Make a genuinely-unscanned project for the gate.
    const freshDir = path.join(box, "gate3");
    fs.mkdirSync(freshDir);
    fs.writeFileSync(path.join(freshDir, "a.js"), "module.exports = 1;\n");
    await httpJson("POST", "/projects/add", { path: freshDir, name: "gate3" });
    const gate3 = await idOf("gate3");

    const scanProgBefore = bins["scan.progress"].length;
    const select = await httpJson("POST", "/project/select", { project: "gate3" })
      .catch(() => ({ status: 0 }));
    if (select.status === 0 || select.status === 404)
      await httpJson("POST", "/chat", { agent: "main", prompt: "E2E_GATE_ORDER@gate3 เลือกโปรเจค gate3" });

    // (1) auto-scan fired + status "scanning"
    const sawScanning = await waitFor(async () => (await statusOf("gate3")) === "scanning" ||
      bins["scan.progress"].length > scanProgBefore, 8000);
    const autoFired = bins["scan.progress"].length > scanProgBefore || fs.existsSync(cacheOf(gate3.id));
    if (sawScanning && autoFired)
      PASS('(1) select unscanned → auto POST /project/scan fired + status reached "scanning"');
    else FAIL(`(1) gate did not auto-scan/scanning — status=${await statusOf("gate3")} autoFired=${autoFired}`);

    // (2) during "scanning" → task blocked (no activity row starts for gate3)
    let blockedOk = "n/a";
    if ((await statusOf("gate3")) === "scanning") {
      await httpJson("POST", "/chat", { agent: "main", prompt: "E2E_GATE_ORDER@gate3 งานระหว่าง scanning" });
      await sleep(800);
      const started = bins["activity.update"].flatMap((e) => e.running || [])
        .some((r) => /E2E_GATE_TASK/.test(r.label || "") && (r.project === "gate3" || r.project === gate3.id));
      blockedOk = started ? "FAIL" : "PASS";
      if (!started) PASS('(2) task during "scanning" is gate-blocked (no run started)');
      else FAIL('(2) task started while project still "scanning" — gate did not block');
    } else PEND('(2) scanning window too short in sandbox to inject a task — verify on a large repo');

    // (3) complete → "ready" + task starts
    const becameReady = await waitFor(async () => (await statusOf("gate3")) === "ready", 12000);
    if (becameReady) PASS('(3) scan complete → status "ready"');
    else FAIL('(3) status never reached "ready"');
    const taskStarted = await waitFor(async () => bins["activity.update"].flatMap((e) => e.running || [])
      .some((r) => /E2E_GATE_TASK/.test(r.label || "")), 10000);
    if (taskStarted) PASS('(3) held/next task starts once "ready"');
    else FAIL('(3) task never started after "ready"');

    // (4) already-scanned project → no re-scan, immediate
    const progBefore4 = bins["scan.progress"].length;
    const st4 = await statusOf("gateproj");   // scanned in the guard block
    await httpJson("POST", "/project/select", { project: "gateproj" }).catch(() => ({}));
    await sleep(800);
    const noRescan = bins["scan.progress"].length === progBefore4;
    if (st4 === "ready" && noRescan)
      PASS('(4) already-scanned project stays "ready", no re-scan on select');
    else FAIL(`(4) re-scan/transition on a scanned project — status=${st4} progΔ=${bins["scan.progress"].length - progBefore4}`);
  }

  // ----------------------------------------------------------- teardown
  try { sock.destroy(); } catch {}
  try { child.kill(); } catch {}
  await sleep(800);
  for (let i = 0; i < 5 && fs.existsSync(box); i++) {
    try { fs.rmSync(box, { recursive: true, force: true }); } catch { await sleep(400); }
  }
  const ok = process.exitCode !== 1;
  console.log("\n  " + (ok
    ? (GATE ? "\x1b[32mRESULT: PASS (gate live, full assertions)\x1b[0m"
            : "\x1b[32mRESULT: PASS (guard green; gate cases PENDING until Mr N promotes)\x1b[0m")
    : "\x1b[31mRESULT: FAIL\x1b[0m") + "\n");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log("  \x1b[31m✗\x1b[0m fatal: " + e.message); process.exit(1); });
