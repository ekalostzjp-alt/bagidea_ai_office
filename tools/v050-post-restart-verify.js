#!/usr/bin/env node
// v0.5.0 post-restart verifier — runs DETACHED, survives the daemon handoff.
// The deploy watcher only restarts after every agent goes idle, so the agent
// that did the swap can never see the successor itself. This script waits for
// the new daemon (runs.json appearing at boot is the marker — old code never
// creates it), runs the verify suite, then reports into the office chat via
// POST /event and writes daemon/v050-verify-result.json. Exits on its own —
// hard cap 15 min, no lingering process.
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const DAEMON = path.join(ROOT, "daemon");
const RUNS = path.join(DAEMON, "runs.json");
const RESULT = path.join(DAEMON, "v050-verify-result.json");
const PORT = 8787;
const HOME_ID = "p1781139305599"; // bagidea — the office's own root project
const APP_DIR = ROOT.replace(/\//g, "\\").toLowerCase();
const DEADLINE = Date.now() + 15 * 60000;

function req(method, p, body, headers) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p,
      headers: Object.assign({ "content-type": "application/json" },
        data ? { "content-length": data.length } : {}, headers || {}),
      timeout: 11 * 60000 },
      (res) => { let b = ""; res.setEncoding("utf8");
        res.on("data", (c) => (b += c));
        res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {}
          resolve({ status: res.statusCode, body: b, json: j }); });
      });
    r.on("error", () => resolve(null));
    r.on("timeout", () => { r.destroy(); resolve(null); });
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const checks = [];
  const mark = (name, ok, detail) => { checks.push({ name, ok, detail });
    log((ok ? "PASS " : "FAIL ") + name + " — " + detail); };
  const logFile = path.join(DAEMON, "v050-verify.log");
  const log = (m) => { const line = new Date().toISOString() + " " + m;
    console.log(line); try { fs.appendFileSync(logFile, line + "\n"); } catch {} };

  log("waiting for daemon handoff (marker: runs.json appears)…");
  let booted = false;
  while (Date.now() < DEADLINE) {
    if (fs.existsSync(RUNS)) { const s = await req("GET", "/stats");
      if (s && s.json) { booted = true; break; } }
    await sleep(2000);
  }
  if (!booted) {
    log("TIMEOUT — daemon ใหม่ยังไม่ขึ้น (อาจมี agent อื่นยังทำงานค้าง ทำให้ restart ถูกเลื่อน)");
    try { fs.writeFileSync(RESULT, JSON.stringify({ ok: false,
      error: "restart ไม่เกิดภายใน 15 นาที — watcher ยังรอ agent ว่าง", checks }, null, 2)); } catch {}
    await req("POST", "/event", { type: "chat.message", agent: "แบล็ค",
      text: "🛟 v0.5.0 verifier: daemon ยังไม่ restart ภายใน 15 นาที (มีงานอื่นวิ่งอยู่ทำให้ watcher เลื่อน handoff) — ไฟล์ swap แล้ว ปลอดภัย แค่รอออฟฟิศว่างแล้วมันจะ restart เอง สั่ง verify ซ้ำได้ด้วย: node tools/v050-post-restart-verify.js" });
    process.exit(1);
  }
  log("daemon ใหม่ขึ้นแล้ว — settle 3s");
  await sleep(3000);

  // 1) /stats — pendingPerms ต้องเป็น 0 (ไม่มี ghost chip ค้าง)
  const stats = await req("GET", "/stats");
  mark("stats.pendingPerms=0", !!stats && stats.json && stats.json.pendingPerms === 0,
    stats && stats.json ? "pendingPerms=" + stats.json.pendingPerms +
      ", uptimeSec=" + stats.json.uptimeSec : "no response");

  // 2) /projects — 3 โปรเจคจริง ไม่มี Default, home ชี้ bagidea
  const pj = await req("GET", "/projects");
  const plist = (pj && pj.json && pj.json.projects) || [];
  mark("projects=3,noDefault",
    plist.length === 3 && !plist.some((p) => /^default$/i.test(p.name)),
    plist.map((p) => p.name).join(",") || "no response");
  mark("projects.home=bagidea", !!pj && pj.json && pj.json.home === HOME_ID,
    "home=" + (pj && pj.json && pj.json.home));

  // 3) runs.json — สร้างจริง schema ครบ
  let runsOk = false, runsDetail = "missing";
  try { const j = JSON.parse(fs.readFileSync(RUNS, "utf8"));
    runsOk = j && typeof j.live === "object" && Array.isArray(j.interrupted) &&
      Array.isArray(j.history);
    runsDetail = "schemaVersion=" + j.schemaVersion + " live=" +
      Object.keys(j.live).length + " interrupted=" + j.interrupted.length +
      " history=" + j.history.length;
  } catch (e) { runsDetail = e.message; }
  mark("runs.json schema", runsOk, runsDetail);

  // 4) run สั้น ไม่เอ่ยชื่อโปรเจค → ต้อง route เข้า home (bagidea) ไม่ตก fallback
  log("ยิง run ทดสอบสั้นๆ (no-project → ต้องเข้า bagidea)…");
  const chat = await req("POST", "/chat",
    { agent: "น้องไวท์", prompt: "ทดสอบระบบ: ตอบคำเดียวว่า pong แล้วจบงานทันที ไม่ต้องทำอะไรเพิ่ม",
      wait: true }, { "x-bagidea-ui": "1" });
  const chatOk = !!chat && chat.status === 200 && chat.json && chat.json.ok !== false;
  mark("test run finished", chatOk,
    chat ? "status=" + chat.status + " text=" + String((chat.json || {}).text || chat.body).slice(0, 60)
         : "no response (daemon gone?)");

  // routing proof จาก runs.json history (record เก็บ project + cwd)
  await sleep(2500);
  let routeOk = false, routeDetail = "no record";
  try { const j = JSON.parse(fs.readFileSync(RUNS, "utf8"));
    const rec = (j.history || []).find((r) => r.agent === "น้องไวท์") ||
      Object.values(j.live || {}).find((r) => r.agent === "น้องไวท์");
    if (rec) {
      const cwdNorm = String(rec.cwd || "").replace(/\//g, "\\").toLowerCase();
      routeOk = rec.project === HOME_ID && cwdNorm === APP_DIR;
      routeDetail = "project=" + rec.project + " cwd=" + rec.cwd +
        " status=" + rec.status + " runId=" + rec.runId;
    }
  } catch (e) { routeDetail = e.message; }
  mark("routing→home(bagidea)", routeOk, routeDetail);

  const allOk = checks.every((c) => c.ok);
  try { fs.writeFileSync(RESULT,
    JSON.stringify({ ok: allOk, at: new Date().toISOString(), checks }, null, 2)); } catch {}

  const lines = checks.map((c) => "| " + c.name + " | " + (c.ok ? "✅" : "❌") +
    " | " + String(c.detail).slice(0, 110) + " |");
  await req("POST", "/event", { type: "chat.message", agent: "แบล็ค",
    text: (allOk ? "✅ v0.5.0 LIVE — verify หลัง restart ผ่านครบทุกข้อ:\n"
                 : "⚠️ v0.5.0 restart แล้ว แต่ verify ไม่ผ่านบางข้อ (ดูตาราง) — rollback: copy daemon/server.js.pre-v050.bak → server.js แล้ว watcher จะ restart กลับเอง:\n") +
      "\n| check | ผล | รายละเอียด |\n|---|---|---|\n" + lines.join("\n") +
      "\n\nผลเต็ม: daemon/v050-verify-result.json" });
  log("done — allOk=" + allOk);
  process.exit(allOk ? 0 : 2);
})().catch((e) => { try {
    fs.writeFileSync(RESULT, JSON.stringify({ ok: false, error: e.message }, null, 2));
  } catch {} process.exit(3); });
