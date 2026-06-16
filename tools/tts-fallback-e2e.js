#!/usr/bin/env node
// e2e for the OpenAI TTS fallback (Gemini quota → gpt-4o-mini-tts).
//
//   node tools/tts-fallback-e2e.js [candidateFile] [port]
//     candidateFile  daemon file to boot (default: daemon/server.staged.js —
//                    the merge candidate); promoted live file also works.
//     port           sandbox port (default 8788)
//
// Boots a THROWAWAY copy of the candidate in a temp dir (no real API keys in
// env, fake keys seeded via registry.json, zero live state) with an https
// mock preloaded via --require:
//   • generativelanguage.googleapis.com TTS → always a 429/RESOURCE_EXHAUSTED
//     quota error with "Please retry in 30.5s"
//   • api.openai.com /v1/audio/speech       → 200 + a tiny fake WAV
// so no network call ever leaves the box and nothing bills.
//
// Proves:
//   1. POST /tts during Gemini quota → 200 audio/wav (RIFF) via the fallback
//   2. the quota log line fires ("[tts] Gemini TTS quota หมด … สลับไป OpenAI")
//   3. the block window sticks: 2nd /tts goes STRAIGHT to OpenAI
//      (gemini called exactly once, openai twice)
// Exit 0 = pass, 1 = fail.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const DAEMON = path.join(__dirname, "..", "daemon");
const CANDIDATE = path.resolve(process.argv[2] || path.join(DAEMON, "server.staged.js"));
const PORT = Number(process.argv[3] || 8788);
const HOST = "127.0.0.1";

const PASS = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const FAIL = (m) => { console.log("  \x1b[31m✗\x1b[0m " + m); process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p, body, raw) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const rq = http.request({ host: HOST, port: PORT, path: p, method,
      headers: { "x-bagidea-ui": "1",
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } },
      (rs) => { const ch = []; rs.on("data", (d) => ch.push(d));
        rs.on("end", () => {
          const buf = Buffer.concat(ch);
          resolve({ status: rs.statusCode, headers: rs.headers,
            buf, text: raw ? "" : buf.toString("utf8") });
        }); });
    rq.on("error", reject);
    if (data) rq.write(data);
    rq.end();
  });
}

// the https mock the sandbox daemon preloads (--require). Counts go to stdout
// as [mock] lines the parent parses.
const MOCK_SRC = `
const https = require("https");
const { EventEmitter } = require("events");
const real = https.request.bind(https);
let gm = 0, oa = 0;
function fakeResponse(status, payload) {
  const rs = new EventEmitter();
  rs.statusCode = status;
  rs.headers = {};
  rs.setEncoding = () => {};
  process.nextTick(() => { rs.emit("data", payload); rs.emit("end"); });
  return rs;
}
https.request = function (opts, cb) {
  const host = (opts && (opts.host || opts.hostname)) || "";
  const p = (opts && opts.path) || "";
  const rq = new EventEmitter();
  rq.setTimeout = () => rq; rq.write = () => true; rq.destroy = () => rq;
  if (host === "generativelanguage.googleapis.com" && p.includes("tts")) {
    gm++; console.log("[mock] gemini-tts call #" + gm);
    rq.end = () => process.nextTick(() => cb(fakeResponse(429, Buffer.from(JSON.stringify({
      error: { code: 429, status: "RESOURCE_EXHAUSTED",
        message: "You exceeded your current quota. RESOURCE_EXHAUSTED: " +
          "generate_requests_per_model_per_day. Please retry in 30.5s." } })))));
    return rq;
  }
  if (host === "api.openai.com" && p === "/v1/audio/speech") {
    oa++; console.log("[mock] openai-tts call #" + oa);
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4),
      Buffer.from("WAVEfmt "), Buffer.alloc(24), Buffer.from("data"), Buffer.alloc(44)]);
    rq.end = () => process.nextTick(() => cb(fakeResponse(200, wav)));
    return rq;
  }
  return real(opts, cb);
};
`;

async function main() {
  console.log(`\n  TTS fallback e2e — candidate: ${path.basename(CANDIDATE)} on :${PORT}\n`);
  if (!fs.existsSync(CANDIDATE)) { FAIL("candidate not found: " + CANDIDATE); process.exit(1); }

  const box = fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-tts-e2e-"));
  const sbox = path.join(box, "daemon");
  fs.mkdirSync(sbox, { recursive: true });
  fs.copyFileSync(CANDIDATE, path.join(sbox, "server.js"));
  for (const f of ["channels.js", "plugins.js", "retrieval.js"])
    if (fs.existsSync(path.join(DAEMON, f)))
      fs.copyFileSync(path.join(DAEMON, f), path.join(sbox, f));
  if (fs.existsSync(path.join(DAEMON, "brain")))
    fs.cpSync(path.join(DAEMON, "brain"), path.join(sbox, "brain"), { recursive: true });
  // fake keys via registry (reg.apiKeys is the only key source for tts)
  fs.writeFileSync(path.join(sbox, "registry.json"), JSON.stringify({
    agents: {}, tts: true, lang: "th",
    apiKeys: { GEMINI_API_KEY: "e2e-fake-gm", OPENAI_API_KEY: "e2e-fake-oa" } }));
  const mockPath = path.join(box, "https-mock.js");
  fs.writeFileSync(mockPath, MOCK_SRC);

  const env = { ...process.env, OEP_PORT: String(PORT), BAGIDEA_NO_WATCH: "1" };
  delete env.OPENAI_API_KEY;   // nothing in the sandbox may bill anything
  delete env.GEMINI_API_KEY;
  const child = spawn(process.execPath, ["--require", mockPath, "server.js"],
    { cwd: sbox, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const cleanup = () => {
    try { child.kill(); } catch {}
    try { fs.rmSync(box, { recursive: true, force: true }); } catch {}
  };
  process.on("exit", cleanup);

  let up = null;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(500);
    up = await req("GET", "/health").catch(() => null);
  }
  if (!up) { FAIL("sandbox daemon never came up — log:\n" + out.slice(-1500)); process.exit(1); }
  PASS("sandbox daemon up on :" + PORT + " (isolated, fake keys, https mocked)");

  // 1) quota-hit → fallback answers with audio
  const r1 = await req("POST", "/tts", { text: "ทดสอบระบบเสียงสำรอง", preset: "sunny" }, true);
  const riff1 = r1.buf.slice(0, 4).toString() === "RIFF";
  if (r1.status === 200 && riff1) PASS("/tts #1 → 200 + RIFF wav while Gemini is quota-blocked");
  else FAIL(`/tts #1 → ${r1.status}, RIFF=${riff1}, body: ${r1.buf.slice(0, 200)}`);
  if ((r1.headers["content-type"] || "").includes("audio/wav")) PASS("content-type audio/wav");
  else FAIL("content-type: " + r1.headers["content-type"]);

  await sleep(300);   // let the daemon's console line land in `out`
  if (out.includes("[tts] Gemini TTS quota หมด") && out.includes("สลับไป OpenAI TTS"))
    PASS("quota log line fired (block window + loud switch notice)");
  else FAIL("missing quota log line — log tail:\n" + out.slice(-600));

  // 2) block window sticks: second call must NOT touch Gemini again
  const r2 = await req("POST", "/tts", { text: "รอบสองต้องไป OpenAI ตรงๆ", preset: "deep" }, true);
  if (r2.status === 200 && r2.buf.slice(0, 4).toString() === "RIFF")
    PASS("/tts #2 → 200 + RIFF wav");
  else FAIL(`/tts #2 → ${r2.status}`);
  await sleep(300);
  const gmCalls = (out.match(/\[mock\] gemini-tts call/g) || []).length;
  const oaCalls = (out.match(/\[mock\] openai-tts call/g) || []).length;
  if (gmCalls === 1) PASS("Gemini called exactly once — 2nd call skipped it (block window)");
  else FAIL("gemini-tts calls = " + gmCalls + " (want 1)");
  if (oaCalls === 2) PASS("OpenAI fallback served both lines (calls = 2)");
  else FAIL("openai-tts calls = " + oaCalls + " (want 2)");

  cleanup();
  console.log("\n  " + (process.exitCode ? "\x1b[31mHAS FAILURES\x1b[0m" : "\x1b[32mALL PASS\x1b[0m") + "\n");
  process.exit(process.exitCode || 0);
}
main().catch((e) => { console.error("E2E CRASHED:", e); process.exit(2); });
