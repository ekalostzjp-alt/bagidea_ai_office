#!/usr/bin/env node
// Per-Agent Live Status + Live Log v2 (BACKEND) — end-to-end test (zero dependency).
// Frontend counterpart: tools/agent-status-e2e.js (overlay rail, by White).
//
//   node tools/agent-status-backend-e2e.js [port]
//     E2E_SANDBOX=1 → boots its OWN sandbox daemon (temp dir, stub claude,
//                     no API keys — zero tokens, zero live state) on [port|8798]
//     otherwise     → read-only checks against the daemon at [port|8787]
//
// Verifies docs/agent-live-status.contract.md:
//   • GET /agents/status → {agents:[...]} — full roster, each row
//     {agentId, status:"working"|"idle", project, task}
//   • DELEGATE dispatch → assignee flips to "working" (+project +task)
//   • run finishes      → back to "idle", project/task null
//   • every flip is broadcast over WS as {type:"agent.status", agents:[...]}
//   • a fresh WS client gets a current agent.status snapshot on connect
//   Live Log v2 (additive fields on activity.update rows):
//   • slot / live="Claude Live N" numbering, ordered by startedAt
//   • elapsedMs/lastToolAgo tick — clocks move without new tools
//   • silence > OEP_STUCK_MS → state:"stuck" + ONE chat.message watchdog line
//   • a new tool after stuck → back to "working" (watchdog re-arms, no kill)
// Exit 0 = pass, 1 = fail.

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const SANDBOX = process.env.E2E_SANDBOX === "1";
const PORT = Number(process.argv[2] || process.env.OEP_PORT || (SANDBOX ? 8798 : 8787));
const HOST = "127.0.0.1";
const DAEMON = path.join(__dirname, "..", "daemon");
// fast clocks in the sandbox so the stuck flip is observable in seconds
const TICK_MS = 1000, STUCK_MS = 3000;

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

// Minimal WS client (server→client frames are unmasked text). Collects
// agent.status into `events`, activity.update into `acts`, chat.message
// into `chats` (each stamped with arrival order for before/after checks).
function wsListen(events, acts, chats) {
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
            if (m.type === "agent.status") events.push(m);
            else if (m.type === "activity.update" && acts) acts.push(m);
            else if (m.type === "chat.message" && chats) chats.push(m);
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

const shapeOk = (a) =>
  a && typeof a.agentId === "string" &&
  (a.status === "working" || a.status === "idle") &&
  (a.project === null || typeof a.project === "string") &&
  (a.task === null || typeof a.task === "string") &&
  (a.status === "working" || (a.project === null && a.task === null));

// Live Log v2 row: old fields intact + the additive ones, all well-typed.
const liveRowOk = (r) =>
  r && typeof r.agent === "string" && typeof r.task === "string" &&
  typeof r.startedAt === "number" &&
  Number.isInteger(r.slot) && r.slot >= 1 &&
  r.live === "Claude Live " + r.slot &&
  typeof r.elapsedMs === "number" && r.elapsedMs >= 0 &&
  typeof r.lastToolAgo === "number" && r.lastToolAgo >= 0 &&
  (r.state === "working" || r.state === "stuck");

// ---------------------------------------------------------------- sandbox
// Boots a throwaway copy of daemon/server.js with a stub `claude` that plays
// a scripted run: tools at t=0/1.5s, a 5s silence (> STUCK_MS → watchdog),
// then a recovery tool — so slots, ticks, stuck and un-stuck are all visible.
async function bootSandbox() {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-livelog-e2e-"));
  const sboxDaemon = path.join(box, "daemon");
  fs.mkdirSync(sboxDaemon, { recursive: true });
  fs.copyFileSync(path.join(DAEMON, "server.js"), path.join(sboxDaemon, "server.js"));
  for (const f of ["channels.js", "plugins.js", "retrieval.js"])
    fs.copyFileSync(path.join(DAEMON, f), path.join(sboxDaemon, f));
  fs.cpSync(path.join(DAEMON, "brain"), path.join(sboxDaemon, "brain"), { recursive: true });
  // db.js intentionally NOT copied — server.js is fail-soft about it.

  // Seed the delegate target (default registry only ships main + ceo).
  fs.writeFileSync(path.join(sboxDaemon, "registry.json"), JSON.stringify({
    agents: { "แบล็ค": { name: "แบล็ค", role: "วิศวกร", avatar: 1, prompt: "",
      skills: [], tools: ["Read", "Bash"] } } }));

  // The project the DELEGATE routes into (display name must be "tookjorThai").
  const projDir = path.join(box, "proj");
  fs.mkdirSync(projDir);
  fs.writeFileSync(path.join(projDir, "a.txt"), "e2e\n");

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
  if (input.includes("E2E_ORDER")) {
    text("จัดให้ครับ\\nDELEGATE: แบล็ค @ tookjorThai :: E2E_STATUS_TEST งานทดสอบสถานะ");
    result();
  } else if (input.includes("E2E_STATUS_TEST")) {
    tool("Read");
    await sleep(1500); tool("Bash");   // normal activity
    await sleep(5000); tool("Grep");   // 5s silence > 3s stuck → flag, then recover
    await sleep(1000); text("E2E งานเสร็จครับ"); result();
  } else if (input.includes("E2E_SECOND")) {
    tool("Read");
    await sleep(2500); text("E2E second done"); result();
  } else { text("รับทราบครับ"); result(); }
});
`);
  fs.writeFileSync(path.join(stubBin, "claude.cmd"), `@node "%~dp0claude-stub.js" %*\r\n`);
  fs.writeFileSync(path.join(stubBin, "codex.cmd"), "@echo off\r\nexit /b 0\r\n");

  const env = { ...process.env, OEP_PORT: String(PORT),
    OEP_LIVE_TICK_MS: String(TICK_MS), OEP_STUCK_MS: String(STUCK_MS),
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
  };
  process.on("exit", cleanup);

  let up = null;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(500);
    up = await httpJson("GET", "/registry").catch(() => null);
  }
  if (!up || !up.json || !up.json.agents || !up.json.agents["แบล็ค"]) {
    FAIL("sandbox daemon never came up (or lost seeded agent) — log:\n" + bootLog.slice(-1500));
    process.exit(1);
  }
  const add = await httpJson("POST", "/projects/add", { path: projDir, name: "tookjorThai" });
  if (add.status !== 200) { FAIL(`POST /projects/add → ${add.status}`); process.exit(1); }
  PASS("sandbox daemon up (isolated state, stub claude, no API keys, tick=1s stuck=3s)");
  return cleanup;
}

(async () => {
  console.log(`\n  Live Status + Live Log v2 (backend) — e2e against http://${HOST}:${PORT}` +
    (SANDBOX ? "  [sandbox: full cycle]" : "  [live: read-only]") + "\n");

  let cleanup = () => {};
  if (SANDBOX) cleanup = await bootSandbox();

  const reg = await httpJson("GET", "/registry").catch(() => null);
  if (!reg || !reg.json || !reg.json.agents) { FAIL("could not read /registry"); process.exit(1); }
  const roster = Object.keys(reg.json.agents);
  PASS(`roster ok — ${roster.length} agents`);

  // ---- read-only: endpoint shape + roster coverage -------------------------
  const st = await httpJson("GET", "/agents/status");
  if (st.status !== 200 || !st.json || !Array.isArray(st.json.agents)) {
    FAIL(`GET /agents/status → ${st.status} (need {agents:[...]})`); process.exit(1);
  }
  PASS("GET /agents/status → 200, {agents:[...]}");
  const rows = st.json.agents;
  const ids = rows.map((a) => a.agentId);
  const missing = roster.filter((id) => !ids.includes(id));
  if (missing.length) FAIL(`missing agents: ${missing.join(", ")}`);
  else PASS("covers every agent in the registry");
  const bad = rows.filter((a) => !shapeOk(a));
  if (bad.length) FAIL("bad row shape: " + JSON.stringify(bad[0]));
  else PASS("every row is {agentId, status:working|idle, project, task}");

  if (!SANDBOX) {
    console.log("\n  (skip working/idle + Live Log cycle — set E2E_SANDBOX=1 to self-boot a sandbox)");
    const ok0 = process.exitCode !== 1;
    console.log("\n  " + (ok0 ? "\x1b[32mRESULT: PASS\x1b[0m" : "\x1b[31mRESULT: FAIL\x1b[0m") + "\n");
    process.exit(ok0 ? 0 : 1);
  }

  // ---- full cycle (sandbox): order → DELEGATE → working → idle -------------
  const TARGET = "แบล็ค";
  const events = [], acts = [], chats = [];
  const sock = await wsListen(events, acts, chats);
  await sleep(500);
  if (events.length >= 1) PASS("WS pushes a fresh agent.status snapshot on connect");
  else FAIL("no agent.status snapshot on WS connect");

  const evCountBefore = events.length;
  const order = await httpJson("POST", "/chat",
    { agent: "main", prompt: "E2E_ORDER สั่งงานทดสอบสถานะ" });
  if (order.status !== 200) { FAIL(`POST /chat → ${order.status}`); process.exit(1); }
  PASS("Director order sent (stub claude will DELEGATE: แบล็ค @ tookjorThai :: …)");

  // The DELEGATE line is parsed when the Director's text streams (~0.5-1s);
  // status must flip BEFORE the 4.5s dispatch delay ends (pendingDelegate).
  let pendingSeen = null;
  for (let i = 0; i < 16 && !pendingSeen; i++) {
    await sleep(250);
    const s = await httpJson("GET", "/agents/status");
    const row = ((s.json || {}).agents || []).find((a) => a.agentId === TARGET);
    if (row && row.status === "working") pendingSeen = row;
  }
  if (pendingSeen) PASS(`${TARGET} → working at dispatch time: ` + JSON.stringify(pendingSeen));
  else FAIL(`${TARGET} never flipped to working within 4s of the DELEGATE line`);

  // While the (~8s) stub run is alive: project must be the display name.
  await sleep(5500);
  const mid = await httpJson("GET", "/agents/status");
  const midRow = ((mid.json || {}).agents || []).find((a) => a.agentId === TARGET);
  if (midRow && midRow.status === "working" && midRow.project === "tookjorThai" &&
      midRow.task && /E2E_STATUS_TEST/.test(midRow.task))
    PASS(`${TARGET} working mid-run: ` + JSON.stringify(midRow));
  else FAIL(`${TARGET} mid-run row wrong: ` + JSON.stringify(midRow));

  // Fire a second, overlapping run (the Director itself) → 2 concurrent slots.
  await httpJson("POST", "/chat", { agent: "main", prompt: "E2E_SECOND งานซ้อน" });

  // Wait for the run to finish + report-back turn to settle → idle again.
  let idleRow = null;
  for (let i = 0; i < 40 && !idleRow; i++) {
    await sleep(500);
    const s = await httpJson("GET", "/agents/status");
    const row = ((s.json || {}).agents || []).find((a) => a.agentId === TARGET);
    if (row && row.status === "idle") idleRow = row;
  }
  if (idleRow && idleRow.project === null && idleRow.task === null)
    PASS(`${TARGET} back to idle with project=null task=null`);
  else FAIL(`${TARGET} did not return to idle: ` + JSON.stringify(idleRow));
  await sleep(2500);   // let the overlapping run + ticks drain fully

  // WS: the cycle must have broadcast agent.status flips (working AND idle).
  const cycleEvts = events.slice(evCountBefore);
  const sawWorking = cycleEvts.some((e) =>
    (e.agents || []).some((a) => a.agentId === TARGET && a.status === "working"));
  const lastState = [...cycleEvts].reverse().find((e) =>
    (e.agents || []).some((a) => a.agentId === TARGET));
  const sawIdleAfter = lastState &&
    lastState.agents.find((a) => a.agentId === TARGET).status === "idle";
  if (sawWorking) PASS(`WS broadcast ${TARGET}=working during the cycle (${cycleEvts.length} agent.status events)`);
  else FAIL("WS never broadcast the working flip");
  if (sawIdleAfter) PASS(`WS's last agent.status has ${TARGET}=idle`);
  else FAIL("WS never broadcast the idle flip");
  const evBad = cycleEvts.flatMap((e) => e.agents || []).filter((a) => !shapeOk(a));
  if (evBad.length) FAIL("WS event row shape: " + JSON.stringify(evBad[0]));
  else PASS("WS payload rows match the endpoint shape exactly");

  // ---- Live Log v2: slot / live label / elapsed tick / watchdog ------------
  const aRows = (e) => (e.running || []).filter((r) => /E2E_STATUS_TEST/.test(r.label || ""));
  const withA = acts.filter((e) => aRows(e).length === 1);
  if (!withA.length) { FAIL("no activity.update carried the delegated run"); process.exit(1); }

  const badLive = acts.flatMap((e) => e.running || []).filter((r) => !liveRowOk(r));
  if (badLive.length) FAIL("Live Log v2 row shape: " + JSON.stringify(badLive[0]));
  else PASS("every activity.update row has slot/live/elapsedMs/lastToolAgo/state (old fields intact)");

  // slot numbering: while only the delegated run lives it is "Claude Live 1";
  // during the overlap there must be a frame with slots [1,2] ordered by startedAt.
  const soloOk = withA.some((e) => (e.running || []).length === 1 &&
    aRows(e)[0].slot === 1 && aRows(e)[0].live === "Claude Live 1");
  if (soloOk) PASS('single run → slot 1, label "Claude Live 1"');
  else FAIL("never saw the delegated run alone as Claude Live 1");
  const overlap = acts.find((e) => (e.running || []).length === 2);
  if (overlap) {
    const [r1, r2] = overlap.running;
    if (r1.slot === 1 && r2.slot === 2 && r1.startedAt <= r2.startedAt &&
        r2.live === "Claude Live 2")
      PASS("2 concurrent runs → slots [1,2] ordered by startedAt");
    else FAIL("overlap slots wrong: " + JSON.stringify(overlap.running.map((r) => [r.slot, r.live])));
  } else FAIL("never saw 2 concurrent runs in activity.update");

  // elapsed tick: ≥2 frames for the SAME task with growing elapsedMs while
  // lastTool is unchanged (i.e. tick-driven, not tool-driven).
  let tickPairs = 0;
  for (let i = 1; i < withA.length; i++) {
    const a = aRows(withA[i - 1])[0], b = aRows(withA[i])[0];
    if (a.task === b.task && a.lastTool === b.lastTool && b.elapsedMs > a.elapsedMs) tickPairs++;
  }
  if (tickPairs >= 2) PASS(`elapsedMs advances on tick frames (${tickPairs} growing pairs)`);
  else FAIL(`elapsedMs not advancing on ticks (growing pairs=${tickPairs})`);

  // watchdog: the 5s silence must flip → stuck (lastToolAgo ≥ threshold) …
  const stuckFrame = withA.find((e) => aRows(e)[0].state === "stuck");
  if (stuckFrame && aRows(stuckFrame)[0].lastToolAgo >= STUCK_MS)
    PASS(`silence > ${STUCK_MS / 1000}s → state:"stuck" (lastToolAgo=${aRows(stuckFrame)[0].lastToolAgo}ms)`);
  else FAIL("run never flipped to stuck during the 5s silence");
  // … emit EXACTLY ONE chat warning per silence, with the Live label …
  const warns = chats.filter((c) => c.watchdog === true && /อาจค้าง/.test(c.text || ""));
  if (warns.length === 1 && warns[0].live === "Claude Live 1" && warns[0].slot === 1 &&
      warns[0].state === "stuck" && warns[0].agent === TARGET)
    PASS('watchdog chat line: ⚠️ "Claude Live 1 (แบล็ค) อาจค้าง — เงียบ Xs" (once per silence)');
  else FAIL(`watchdog chat lines wrong (count=${warns.length}): ` + JSON.stringify(warns[0] || null));
  // … and the recovery tool un-sticks it (no kill — the run finished normally).
  const stuckSeq = stuckFrame ? stuckFrame._seq : -1;
  const recovered = withA.find((e) => e._seq > stuckSeq &&
    aRows(e)[0].state === "working" && aRows(e)[0].lastToolAgo < STUCK_MS);
  if (recovered) PASS("new tool after stuck → state back to working (time extended, run not killed)");
  else FAIL("run never recovered to working after the stuck flag");

  try { sock.destroy(); } catch {}
  cleanup();
  const ok = process.exitCode !== 1;
  console.log("\n  " + (ok ? "\x1b[32mRESULT: PASS\x1b[0m" : "\x1b[31mRESULT: FAIL\x1b[0m") + "\n");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log("  \x1b[31m✗\x1b[0m fatal: " + e.message); process.exit(1); });
