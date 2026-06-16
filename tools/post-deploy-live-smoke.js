#!/usr/bin/env node
// Post-deploy live smoke — v0.7.x port + Auto-Scan gate batch (2026-06-12).
//
// Launched DETACHED right before the deployer's run ends, because the live
// daemon defers its restart until activeRuns is empty — so the deployer can
// never observe the new code itself. This script:
//   1. polls GET /project/scan/status on :8787 until it answers 200 (the old
//      code 404s it → 200 means the new server.js is live), max 6 min
//   2. smoke-checks /recall, /i18n/all, /review/status, /activity, /process/feed
//   3. POSTs client.reload so open overlay windows pick up the latest BUILD
//   4. reports the verdict via POST /event chat.message + workspace/notes.md
// Then exits. Read-only against live except the reload/report events.

const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1", PORT = 8787;
const NOTES = path.join(__dirname, "..", "workspace", "notes.md");
const LOG = path.join(__dirname, "..", "daemon", "deploy-restart.log");
const DEADLINE = Date.now() + 6 * 60 * 1000;

const log = (m) => {
  const line = `[post-deploy-smoke ${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + "\n"); } catch {}
};

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: HOST, port: PORT, path: p, method,
      headers: data ? { "content-type": "application/json", "content-length": data.length } : {} },
      (res) => { const ch = []; res.on("data", (d) => ch.push(d));
        res.on("end", () => { const t = Buffer.concat(ch).toString("utf8");
          let j = null; try { j = JSON.parse(t); } catch {}
          resolve({ status: res.statusCode, json: j, text: t }); }); });
    r.setTimeout(10000, () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function report(text) {
  try {
    await req("POST", "/event", { type: "chat.message", agent: "มิสเตอร์-n", text });
  } catch (e) { log("report via /event failed: " + e.message); }
  try {
    fs.appendFileSync(NOTES, "- " + text.replace(/\n/g, " | ") + "\n");
  } catch (e) { log("notes.md append failed: " + e.message); }
}

(async () => {
  log("waiting for new server.js (probe: GET /project/scan/status → 200)…");
  let live = false;
  while (Date.now() < DEADLINE && !live) {
    try { live = (await req("GET", "/project/scan/status")).status === 200; } catch {}
    if (!live) await sleep(2000);
  }
  if (!live) {
    log("TIMEOUT — /project/scan/status never returned 200");
    await report("⚠️ post-deploy smoke (v0.7.x port + scan gate): หมดเวลา 6 นาที — daemon ยังไม่ขึ้น code ใหม่ ตรวจ deploy-restart.log / rollback ด้วย server.js.pre-v074.bak");
    process.exit(1);
  }
  log("new code live — /project/scan/status → 200");

  const results = [];
  const ck = async (label, p, test) => {
    const r = await req("GET", p).catch((e) => ({ status: 0, text: e.message }));
    results.push(test(r) ? "✓ " + label : "✗ " + label + " (status=" + r.status + ")");
  };
  await ck("/project/scan/status {scanning[]}", "/project/scan/status",
    (r) => r.status === 200 && r.json && Array.isArray(r.json.scanning));
  await ck("/recall", "/recall?q=test",
    (r) => r.status === 200 && r.json && Array.isArray(r.json.hits));
  await ck("/i18n/all", "/i18n/all?lang=en",
    (r) => r.status === 200 && r.json && r.json.map !== undefined);
  await ck("/review/status decisions[]", "/review/status",
    (r) => r.status === 200 && r.json && Array.isArray(r.json.decisions));
  await ck("/process/feed", "/process/feed", (r) => r.status === 200);
  await ck("/activity", "/activity",
    (r) => r.status === 200 && r.json && Array.isArray(r.json.running));

  // Open overlay windows may run stale JS — force them onto the latest BUILD
  // now that the new daemon is up.
  try {
    await req("POST", "/event", { type: "client.reload", file: "overlay.html" });
    results.push("✓ client.reload → overlay");
  } catch (e) { results.push("✗ client.reload: " + e.message); }

  const allPass = results.every((r) => r.startsWith("✓"));
  const verdict = (allPass
    ? "✅ deploy v0.7.x port + Auto-Scan gate ขึ้น live สำเร็จ — smoke: "
    : "⚠️ deploy ขึ้นแล้วแต่ smoke ไม่ผ่านบางข้อ — ตรวจด่วน: ") + results.join(", ")
    + " | rollback: daemon/server.js.pre-v074.bak | gate contract: docs/auto-scan-gate.contract.md";
  log(verdict);
  await report(verdict);
  process.exit(allPass ? 0 : 1);
})().catch(async (e) => {
  log("crashed: " + (e && e.message));
  await report("⚠️ post-deploy smoke crash: " + (e && e.message));
  process.exit(1);
});
