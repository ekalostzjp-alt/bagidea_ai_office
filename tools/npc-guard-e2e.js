#!/usr/bin/env node
// NPC Hire explicit-guard — end-to-end test (zero dependency, fully sandboxed).
//
//   node tools/npc-guard-e2e.js [port]      (default 8799)
//
// Boots daemon/server.staged.js in a throwaway temp dir (own registry.json,
// npc-proposals.json, …) with API keys stripped, so nothing touches the live
// office state and no OpenAI/image tokens are spent (persona = template
// fallback path). Verifies docs/npc-hire.contract.md §4 cases 0-3 incl. the
// new explicit guard, PLUS the governance roster gate (G1-G4): unapproved
// agent ids can't run via /chat, /registry/agent creation requires the CEO
// editor header, and a full-office approval never consumes the proposal.
// Then kills the sandbox and removes the temp dir. Exit 0 = pass, 1 = fail.

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
    req.setTimeout(90000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`\n  NPC Hire guard — sandboxed e2e (server.staged.js) on :${PORT}\n`);

  // ---- sandbox: copy the staged server + its local modules to a temp dir.
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-npc-e2e-"));
  const sboxDaemon = path.join(box, "daemon");
  fs.mkdirSync(sboxDaemon, { recursive: true });
  fs.copyFileSync(path.join(DAEMON, "server.staged.js"), path.join(sboxDaemon, "server.js"));
  for (const f of ["channels.js", "plugins.js", "retrieval.js"])
    fs.copyFileSync(path.join(DAEMON, f), path.join(sboxDaemon, f));
  fs.cpSync(path.join(DAEMON, "brain"), path.join(sboxDaemon, "brain"), { recursive: true });
  // db.js intentionally NOT copied — server.js is fail-soft about it.
  // Stub claude/codex so no background tick can spawn a real (billed) CLI.
  const stubBin = path.join(box, "stubbin");
  fs.mkdirSync(stubBin);
  for (const n of ["claude", "codex"])
    fs.writeFileSync(path.join(stubBin, n + ".cmd"), "@echo off\r\nexit /b 0\r\n");

  const env = { ...process.env, OEP_PORT: String(PORT),
    PATH: stubBin + path.delimiter + process.env.PATH };
  delete env.OPENAI_API_KEY;   // force the template-persona fallback path
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

  // wait for listen
  let reg = null;
  for (let i = 0; i < 60 && !reg; i++) {
    await sleep(500);
    reg = await httpJson("GET", "/registry").catch(() => null);
  }
  if (!reg || !reg.json || !reg.json.agents) {
    FAIL("sandbox daemon never came up — boot log:\n" + bootLog.slice(-1500));
    process.exit(1);
  }
  if (!reg.json.agents.main) { FAIL("default registry has no 'main' agent"); process.exit(1); }
  PASS("sandbox daemon up (isolated state, no API keys, stub claude/codex)");

  const pending = async () =>
    ((await httpJson("GET", "/npc/proposals")).json || {}).proposals || [];

  // ---- case 0a: the exact "นัท" scenario — non-explicit junk must NOT queue.
  let r = await httpJson("POST", "/npc/request", { requesterId: "main", role: "x", reason: "test" });
  if (r.status === 202 && r.json && r.json.created === false)
    PASS(`non-explicit role:"x" → 202 created:false (the "นัท" path is closed)`);
  else FAIL(`non-explicit junk → expected 202 created:false, got ${r.status} ${r.text.slice(0, 120)}`);
  if ((await pending()).length === 0) PASS("…and no proposal was queued");
  else FAIL("…but a proposal WAS queued");

  // ---- case 0b: explicit but failing the quality guard (short role/reason).
  r = await httpJson("POST", "/npc/request", { requesterId: "main", role: "x", reason: "test", explicit: true });
  if (r.status === 202 && (await pending()).length === 0)
    PASS("explicit:true but role/reason too short → 202, nothing queued");
  else FAIL(`quality guard miss — got ${r.status}, pending=${(await pending()).length}`);

  // ---- case 1: explicit + sane payload → real proposal (template persona).
  r = await httpJson("POST", "/npc/request",
    { requesterId: "main", role: "QA", reason: "งานเทสต์เยอะมากช่วงนี้", explicit: true });
  const prop = r.json && (r.json.proposal || null);
  if (r.status === 200 && prop && r.json.requestId && prop.name && prop.model)
    PASS(`explicit request → 200 proposal "${prop.name}" (${prop.model})`);
  else { FAIL(`explicit request → expected 200+proposal, got ${r.status} ${r.text.slice(0, 200)}`); process.exit(1); }
  if ((await pending()).length === 1) PASS("proposal pending = 1");
  else FAIL(`pending should be 1, got ${(await pending()).length}`);

  // ---- case 1b: duplicate requester+role while pending → 409.
  r = await httpJson("POST", "/npc/request",
    { requesterId: "main", role: "qa", reason: "ยิงซ้ำตำแหน่งเดิมต้องโดนกัน", explicit: true });
  if (r.status === 409) PASS("duplicate requester+role (case-insensitive) → 409");
  else FAIL(`duplicate → expected 409, got ${r.status}`);

  // ---- case 3: reject → proposal gone, roster untouched.
  r = await httpJson("POST", "/npc/decision", { requestId: prop.requestId, approved: false });
  if (r.status === 200 && (await pending()).length === 0) PASS("decision approved:false → pending cleared");
  else FAIL(`reject failed — ${r.status}, pending=${(await pending()).length}`);

  // ---- UI path: header x-bagidea-ui:1 counts as explicit (no body flag).
  r = await httpJson("POST", "/npc/request",
    { requesterId: "main", role: "QA", reason: "ทดสอบเส้นทางยิงจาก UI ของ CEO" },
    { "x-bagidea-ui": "1" });
  const prop2 = r.json && r.json.proposal;
  if (r.status === 200 && prop2) PASS("x-bagidea-ui:1 header (no body flag) → 200 proposal");
  else { FAIL(`UI-header path → expected 200, got ${r.status} ${r.text.slice(0, 120)}`); process.exit(1); }

  // ---- case 2: approve → agent actually joins the (sandbox) roster.
  r = await httpJson("POST", "/npc/decision", { requestId: prop2.requestId, approved: true });
  const newId = r.json && r.json.agentId;
  if (r.status === 200 && newId) PASS(`decision approved:true → 200, agentId="${newId}"`);
  else FAIL(`approve → expected 200+agentId, got ${r.status} ${r.text.slice(0, 120)}`);
  const reg2 = await httpJson("GET", "/registry");
  if (newId && reg2.json && reg2.json.agents && reg2.json.agents[newId])
    PASS("new agent present in /registry (sandbox roster — auto-discarded)");
  else FAIL("approved agent missing from /registry");

  // ================= governance: the roster gate =================
  // Regression of the "?????" rogue (2026-06-10): an agent id that never
  // passed CEO approval must not be able to run, enter the registry, or
  // appear in the scene — and a CEO approval must never be silently lost.

  // ---- G1: /chat under an unapproved agent id → 404, no run, no session.
  r = await httpJson("POST", "/chat", { agent: "ghost-rogue", prompt: "ping" });
  if (r.status === 404) PASS("/chat as unapproved agent → 404 (no run starts)");
  else FAIL(`/chat rogue → expected 404, got ${r.status} ${r.text.slice(0, 120)}`);
  const sessAll = await httpJson("GET", "/sessions/all");
  if (!((sessAll.json || {}).all || {})["ghost-rogue"])
    PASS("…and no session bucket was created for the rogue id");
  else FAIL("…but a session bucket WAS created for the rogue id");

  // ---- G2: direct /registry/agent create without the CEO-editor header → 403.
  r = await httpJson("POST", "/registry/agent", { name: "Backdoor Bob", role: "hacker" });
  const regG2 = await httpJson("GET", "/registry");
  if (r.status === 403 && !Object.values(regG2.json.agents).some((a) => a.name === "Backdoor Bob"))
    PASS("/registry/agent create without x-bagidea-ui → 403, registry untouched");
  else FAIL(`backdoor create → expected 403+absent, got ${r.status}`);

  // ---- G2b: the CEO editor path (header) still creates fine.
  r = await httpJson("POST", "/registry/agent",
    { name: "Editor Eve", role: "ทดสอบ editor" }, { "x-bagidea-ui": "1" });
  const eveId = r.json && r.json.id;
  if (r.status === 200 && eveId) PASS("editor path (x-bagidea-ui) create → 200");
  else FAIL(`editor create → expected 200, got ${r.status} ${r.text.slice(0, 120)}`);

  // ---- G2c: updating an EXISTING agent without the header keeps working.
  r = await httpJson("POST", "/registry/agent", { id: eveId, name: "Editor Eve", role: "อัปเดตแล้ว" });
  if (r.status === 200) PASS("update of existing agent without header still works");
  else FAIL(`existing-agent update → expected 200, got ${r.status}`);
  await httpJson("POST", "/registry/agent/delete", { id: eveId });

  // ---- G3: approve while the office is full must NOT consume the proposal.
  r = await httpJson("POST", "/npc/request",
    { requesterId: "main", role: "Ops", reason: "งานดูแลระบบเยอะขึ้นมาก", explicit: true });
  const prop3 = r.json && r.json.proposal;
  if (!(r.status === 200 && prop3)) {
    FAIL(`G3 setup: proposal → expected 200, got ${r.status} ${r.text.slice(0, 120)}`);
  } else {
    // fill the roster to MAX_STAFF via the editor path
    const fillers = [];
    for (let i = 0; i < 30; i++) {
      const cur = await httpJson("GET", "/registry");
      const staff = Object.keys(cur.json.agents).filter((k) => k !== "ceo").length;
      if (staff >= 18) break;
      const f = await httpJson("POST", "/registry/agent",
        { name: "Filler " + i, role: "เติมโต๊ะ" }, { "x-bagidea-ui": "1" });
      if (f.status === 200) fillers.push(f.json.id);
      else break;
    }
    r = await httpJson("POST", "/npc/decision", { requestId: prop3.requestId, approved: true });
    const stillPending = (await pending()).some((x) => x.requestId === prop3.requestId);
    if (r.status === 409 && stillPending)
      PASS("approve while office full → 409 AND proposal stays pending (modal can re-pop)");
    else FAIL(`full-office approve → expected 409+pending, got ${r.status} pending=${stillPending}`);
    // free one seat → the SAME card now approves cleanly
    if (fillers.length) await httpJson("POST", "/registry/agent/delete", { id: fillers[0] });
    r = await httpJson("POST", "/npc/decision", { requestId: prop3.requestId, approved: true });
    const opsId = r.json && r.json.agentId;
    if (r.status === 200 && opsId)
      PASS(`same proposal approves after a seat frees up → agentId="${opsId}"`);
    else FAIL(`re-approve → expected 200, got ${r.status} ${r.text.slice(0, 120)}`);
    // ---- G4: the approved agent is genuinely delegate-able via /chat.
    if (opsId) {
      r = await httpJson("POST", "/chat", { agent: opsId, prompt: "ping" });
      if (r.status === 200 && r.json && r.json.task)
        PASS("approved agent can run via /chat (task " + r.json.task + ")");
      else FAIL(`approved agent /chat → expected 200+task, got ${r.status}`);
    }
  }

  // ---- teardown: kill sandbox, confirm port freed, wipe temp dir.
  child.kill();
  await sleep(700);
  const gone = await httpJson("GET", "/registry").then(() => false).catch(() => true);
  if (gone) PASS(`sandbox daemon stopped — :${PORT} free, temp dir removed`);
  else FAIL("sandbox daemon still answering after kill");
  cleanup();

  console.log(process.exitCode ? "\n  RESULT: FAIL\n" : "\n  RESULT: PASS\n");
})().catch((e) => { FAIL("harness error: " + e.message); process.exit(1); });
