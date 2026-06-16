#!/usr/bin/env node
// @scenes sanitizer — end-to-end test (zero dependency, fully sandboxed).
//
//   node tools/scenes-sanitize-e2e.js [port]      (default 8801)
//
// Codex review-gate finding (2026-06-10): old English scenes cached in
// voiceLines["@scenes"] replay verbatim through pickScene()/playInteractScene.
// This boots daemon/server.staged.js in a throwaway temp dir with a
// voice-lines.json pre-seeded with English / mixed-English scene caches and
// verifies the on-load sanitizer scrubs them and /voice/interact never says
// a Latin letter. Exit 0 = pass, 1 = fail.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.argv[2] || 8801);
const HOST = "127.0.0.1";
const DAEMON = path.join(__dirname, "..", "daemon");
const LATIN = /[A-Za-z]/;
const THAI = /[฀-๿]/;

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
  console.log(`\n  @scenes sanitizer — sandboxed e2e (server.staged.js) on :${PORT}\n`);

  // ---- sandbox: copy the staged server + its local modules to a temp dir.
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-scenes-e2e-"));
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

  // ---- the poisoned cache the live office could be carrying.
  const VOICE = path.join(sboxDaemon, "voice-lines.json");
  fs.writeFileSync(VOICE, JSON.stringify({
    "@scenes": {
      "cat::shino": { bank: [
        [{ who: "shino", text: "Cats are adorable, aren't they?" }],   // pure English → drop
        [{ who: "shino", text: "Feeling good วันนี้" }],               // mixed → drop
        [{ who: "shino", text: "เจ้าเหมียวอย่าเหยียบคีย์บอร์ดนะ" }],  // Thai → keep
      ], recent: ["Cats are adorable, aren't they?"] },
      "pantry::a+b": { bank: [
        [{ who: "a", text: "Let's grab a coffee" }, { who: "b", text: "Sure thing" }],
      ], recent: [] },                                                  // all English → pool gone
    },
    "ghost-agent": { bank: ["Hello world"], recent: [] },               // unknown agent → gone
  }, null, 2));

  const env = { ...process.env, OEP_PORT: String(PORT),
    PATH: stubBin + path.delimiter + process.env.PATH };
  delete env.OPENAI_API_KEY;   // refills must stay on the template path
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
    try { reg = (await httpJson("GET", "/registry")).json; } catch {}
  }
  if (!reg) { FAIL("sandbox daemon never came up\n" + bootLog.slice(-800)); process.exit(1); }
  PASS("sandbox daemon up (poisoned voice-lines.json seeded)");

  // ---- 1) the on-load sanitizer must have rewritten the file already.
  const after = JSON.parse(fs.readFileSync(VOICE, "utf8"));
  const scenes = after["@scenes"] || {};
  const catPool = scenes["cat::shino"];
  const allTexts = [];
  for (const p of Object.values(scenes))
    for (const sc of p.bank || []) for (const l of sc) allTexts.push(l.text);

  if (allTexts.some((t) => LATIN.test(t)))
    FAIL("English survived in @scenes: " + JSON.stringify(allTexts.filter((t) => LATIN.test(t))));
  else PASS("no Latin letters left anywhere in @scenes");

  if (catPool && catPool.bank.length === 1 && THAI.test(catPool.bank[0][0].text))
    PASS('cat::shino kept exactly the one Thai scene');
  else FAIL("cat::shino wrong shape: " + JSON.stringify(catPool));

  if (catPool && catPool.recent.length === 0)
    PASS("recent purged of dropped scene keys");
  else FAIL("recent still references a dropped scene: " + JSON.stringify(catPool && catPool.recent));

  if (!scenes["pantry::a+b"]) PASS("all-English pantry pool deleted");
  else FAIL("pantry::a+b survived: " + JSON.stringify(scenes["pantry::a+b"]));

  if (!after["ghost-agent"]) PASS("unknown-agent bank deleted");
  else FAIL("ghost-agent bank survived");

  // ---- 2) /voice/interact must never speak a Latin letter (cache or fallback).
  let spoke = 0, latin = [];
  for (let i = 0; i < 12; i++) {
    const r = await httpJson("POST", "/voice/interact", { ctx: ["cat", "dog", "coffee", "plant", "pantry", "sofa"][i % 6] });
    if (r.status !== 200 || !r.json) continue;
    spoke++;
    for (const l of r.json.lines || []) if (LATIN.test(l.text)) latin.push(l.text);
  }
  if (spoke === 0) FAIL("/voice/interact never produced a scene");
  else if (latin.length) FAIL("/voice/interact spoke English: " + JSON.stringify(latin.slice(0, 3)));
  else PASS(`/voice/interact x${spoke} — Thai only, zero Latin`);

  // ---- 2b) pair scenes with an EMPTY cache must fall back through BANTER →
  // PAIR_FALLBACK and still never speak Latin (needs a 2nd non-ceo agent —
  // hire one through the explicit NPC flow, template-persona path).
  const prop = await httpJson("POST", "/npc/request",
    { requesterId: Object.keys((await httpJson("GET", "/registry")).json.agents).find((id) => id !== "ceo"),
      role: "ผู้ช่วยทดสอบ", reason: "ต้องการคู่สนทนาสำหรับเทสต์ฉากคู่", explicit: true });
  let hired = false;
  if (prop.status === 200 && prop.json && prop.json.proposal) {
    const d = await httpJson("POST", "/npc/decision",
      { requestId: prop.json.proposal.requestId, approved: true }, { "x-bagidea-ui": "1" });
    hired = d.status === 200;
  }
  if (!hired) FAIL("could not hire a 2nd agent for pair scenes: " + prop.status + " " + prop.text.slice(0, 120));
  else {
    let pairSpoke = 0, pairLatin = [];
    for (let i = 0; i < 12; i++) {
      const r = await httpJson("POST", "/voice/interact",
        { ctx: ["pantry", "sofa", "garden", "board"][i % 4] });
      if (r.status !== 200 || !r.json) continue;
      pairSpoke++;
      for (const l of r.json.lines || []) if (LATIN.test(l.text)) pairLatin.push(l.text);
    }
    if (pairSpoke === 0) FAIL("pair /voice/interact never produced a scene");
    else if (pairLatin.length) FAIL("pair fallback spoke Latin: " + JSON.stringify(pairLatin.slice(0, 3)));
    else PASS(`pair /voice/interact x${pairSpoke} (empty cache → BANTER/PAIR_FALLBACK) — zero Latin`);
  }

  // ---- 3) /voice/ambient same bar.
  let ambLatin = [], amb = 0;
  for (let i = 0; i < 6; i++) {
    const r = await httpJson("POST", "/voice/ambient", {});
    if (r.status !== 200 || !r.json) continue;
    amb++;
    if (LATIN.test(r.json.text)) ambLatin.push(r.json.text);
  }
  if (amb === 0) FAIL("/voice/ambient never spoke");
  else if (ambLatin.length) FAIL("/voice/ambient spoke English: " + JSON.stringify(ambLatin));
  else PASS(`/voice/ambient x${amb} — Thai only`);

  child.kill();
  await sleep(800);
  console.log("\n  RESULT: " + (process.exitCode ? "\x1b[31mFAIL\x1b[0m" : "\x1b[32mPASS\x1b[0m") + "\n");
  process.exit(process.exitCode || 0);
})().catch((e) => { FAIL("crash: " + (e && e.message)); process.exit(1); });
