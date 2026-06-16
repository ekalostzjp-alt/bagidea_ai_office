#!/usr/bin/env node
// Work Summary Modal — end-to-end test (zero dependency).
//
//   node tools/work-summary-e2e.js [port]      (default 8787)
//
// Opens the office WebSocket, fires POST /work/summary with a 3-member sample,
// and asserts BOTH halves of the contract:
//   1. the daemon broadcasts a non-replay {type:'work.modal', ...} on the WS,
//   2. GET /work/summary returns that exact payload as { summary: <evt> }.
// Exit 0 = pass, 1 = fail. See docs/work-summary-modal.contract.md.

const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.argv[2] || process.env.OEP_PORT || 8787);
const HOST = "127.0.0.1";

// Unique nonce so we never match a stale broadcast left in the journal.
const NONCE = `${process.pid}-${Date.now()}`;
const SAMPLE = {
  title: `ฟีเจอร์ Work Summary Modal เสร็จแล้ว [${NONCE}]`,
  members: [
    { name: "Nueng", did: "คุมสัญญากลาง + เขียนเทสต์ e2e + integrate/restart",
      files: ["docs/work-summary-modal.contract.md", "tools/work-summary-e2e.js"] },
    { name: "Black", did: "ทำ backend: POST/GET /work/summary + broadcast work.modal",
      files: ["daemon/server.js"] },
    { name: "White", did: "ทำ frontend: overlay ฟัง work.modal แล้วเด้ง Modal",
      files: ["daemon/overlay.html"] },
  ],
  summaryTh: "ทีมทำฟีเจอร์ Work Summary Modal เสร็จ — เด้งสรุปบน overlay ว่าใครแก้อะไร แตะไฟล์ไหน",
};

const PASS = (m) => { console.log("  \x1b[32m✓\x1b[0m " + m); };
const FAIL = (m) => { console.log("  \x1b[31m✗\x1b[0m " + m); process.exitCode = 1; };
function die(m) { FAIL(m); process.exit(1); }

// ---- minimal WS frame parser (server frames are unmasked text) --------------
function drainFrames(buf, onText) {
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, hdr = 2;
    if (len === 126) { if (off + 4 > buf.length) break; len = buf.readUInt16BE(off + 2); hdr = 4; }
    else if (len === 127) { if (off + 10 > buf.length) break; len = Number(buf.readBigUInt64BE(off + 2)); hdr = 10; }
    const mlen = masked ? 4 : 0;
    if (off + hdr + mlen + len > buf.length) break;     // frame not fully arrived
    let pay = buf.slice(off + hdr + mlen, off + hdr + mlen + len);
    if (masked) {
      const mask = buf.slice(off + hdr, off + hdr + 4);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = pay[i] ^ mask[i % 4];
      pay = out;
    }
    if (opcode === 0x1) onText(pay.toString("utf8"));
    off += hdr + mlen + len;
  }
  return buf.slice(off);
}

function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: HOST, port: PORT, path, method,
      headers: { "x-bagidea-ui": "1",
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } },
      (res) => {
        const ch = [];
        res.on("data", (d) => ch.push(d));
        res.on("end", () => {
          const t = Buffer.concat(ch).toString("utf8");
          try { resolve({ status: res.statusCode, json: JSON.parse(t) }); }
          catch { resolve({ status: res.statusCode, json: null, text: t }); }
        });
      });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function sameSummary(a, b) {
  if (!a || !b) return false;
  if (a.title !== b.title || a.summaryTh !== b.summaryTh) return false;
  if (!Array.isArray(a.members) || a.members.length !== b.members.length) return false;
  for (let i = 0; i < a.members.length; i++) {
    const x = a.members[i], y = b.members[i];
    if (x.name !== y.name || x.did !== y.did) return false;
    if ((x.files || []).join("|") !== (y.files || []).join("|")) return false;
  }
  return true;
}

console.log(`\n  Work Summary Modal — e2e against http://${HOST}:${PORT}\n`);

const key = crypto.randomBytes(16).toString("base64");
const wsReq = http.request({ host: HOST, port: PORT, path: "/ws",
  headers: { Connection: "Upgrade", Upgrade: "websocket",
    "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key } });

const TIMEOUT = setTimeout(() => die("timed out waiting for work.modal broadcast (5s)"), 5000);

let gotBroadcast = false;

wsReq.on("upgrade", async (res, socket) => {
  PASS("WS connected");
  let acc = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    acc = drainFrames(Buffer.concat([acc, chunk]), (txt) => {
      let ev; try { ev = JSON.parse(txt); } catch { return; }
      if (ev.type === "work.modal" && !ev.replay && ev.title === SAMPLE.title) {
        gotBroadcast = true;
        PASS("received broadcast work.modal on WS (live, not replay)");
        if (!sameSummary(ev, SAMPLE)) FAIL("broadcast payload did not match what was sent");
        else PASS("broadcast payload matches sent data (title/members/files/summaryTh)");
        finish(socket);
      }
    });
  });
  socket.on("error", (e) => die("WS socket error: " + e.message));

  // POST after the socket is live so the broadcast can't be missed.
  const r = await httpJson("POST", "/work/summary", SAMPLE);
  if (r.status !== 200) die(`POST /work/summary returned ${r.status} ${r.text || ""}`);
  if (!r.json || r.json.ok !== true) die("POST /work/summary did not return { ok:true }");
  PASS("POST /work/summary → 200 { ok:true }");
});

wsReq.on("error", (e) => die("could not open WS (is the daemon up?): " + e.message));
wsReq.end();

async function finish(socket) {
  clearTimeout(TIMEOUT);
  try {
    const g = await httpJson("GET", "/work/summary");
    if (g.status !== 200) FAIL(`GET /work/summary returned ${g.status}`);
    else if (!g.json || !g.json.summary) FAIL("GET /work/summary returned no { summary }");
    else if (!sameSummary(g.json.summary, SAMPLE)) FAIL("GET /work/summary payload did not match");
    else PASS("GET /work/summary returns the stored payload, matches sent data");
  } catch (e) { FAIL("GET /work/summary failed: " + e.message); }
  try { socket.destroy(); } catch {}
  const ok = process.exitCode !== 1 && gotBroadcast;
  console.log("\n  " + (ok ? "\x1b[32mRESULT: PASS\x1b[0m" : "\x1b[31mRESULT: FAIL\x1b[0m") + "\n");
  process.exit(ok ? 0 : 1);
}
