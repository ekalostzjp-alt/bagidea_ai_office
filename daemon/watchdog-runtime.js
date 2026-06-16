// 🐕 WatchDog — STEP 2: runtime loop + auto-wake (เจ้าภาพ: แบล็ค)
//
// ห่อ pure evaluate() ของ watchdog.js (STEP 1) ด้วย side-effect layer:
//   poll agent-status `status` เป็นช่วงๆ → evaluate() → ปลุก agent ใน wake[] จริง
//   + broadcast แจ้งในแชท + cooldown กันปลุกซ้ำถี่.
//
// ตั้งใจให้ "ทุก side-effect ฉีดเข้ามาเป็น deps" — ไม่มี fs/network/timer-logic/
// Date.now ฝังในไฟล์นี้ (setInterval เป็นแค่ scheduler ของ tick, ตัว tick เอง
// deterministic เพราะ clock มาจาก deps.now). เทสต์เรียก tick() ตรงๆ พร้อม clock
// ฉีด → พิสูจน์ loop/wake/cooldown ได้ 100% โดยไม่บูต daemon และไม่พึ่งเวลาจริง.
//
// createWatchdog(deps) → { tick, start, stop, state }
//   deps = {
//     evaluate,      // ฟังก์ชัน pure จาก watchdog.js (บังคับ)
//     fetchStatus,   // async () => payload ของ agent-status `status` | null ถ้าอ่านไม่ได้ (บังคับ)
//     wake,          // async (entry, payload) => void — ปลุก/re-dispatch agent ตัวนั้นจริง (บังคับ)
//     broadcast,     // (msg) => void — ยิง chat.message/แจ้งเตือน (optional, no-op ถ้าไม่ให้)
//     now,           // () => epoch ms — CLOCK ที่ฉีดเข้ามา (default Date.now; เทสต์ฉีดเอง)
//     aliases,       // () => aliasMap | aliasMap — แม็พ id ข้ามภาษาให้ evaluate (optional)
//     cooldownMs,    // กันปลุกซ้ำถี่ ต่อ agent (default 5 นาที)
//     intervalMs,    // คาบ poll (default 30s)
//     log,           // (msg) => void (optional)
//   }
//
// คืน wokenAt (เก็บใน state) เป็น { canonId|rawId : epoch ms ที่ปลุกล่าสุด } — ส่ง
// กลับเข้า evaluate ทุกรอบ ให้ rule cooldown ใน STEP 1 ทำงานข้ามรอบได้.

"use strict";

const watchdogPure = require("./watchdog");   // single source ของ STUCK_HEARTBEAT_MS

const DEFAULT_INTERVAL_MS = 30_000;       // poll ทุก 30 วินาที
const DEFAULT_COOLDOWN_MS = 5 * 60_000;   // ปลุก agent เดิมซ้ำได้เร็วสุดทุก 5 นาที
// เกณฑ์ "heartbeat เงียบเกินนี้ ⇒ ปลุก" — แยกจาก thresholdMs ของ agent-status (ไฟ
// เตือนบนแผง ~2 นาที). ปลุกจริงเฉพาะเงียบเกิน 10 นาที กันปลุกฟรีเปลือง token.
const DEFAULT_STUCK_HEARTBEAT_MS = watchdogPure.STUCK_HEARTBEAT_MS;   // 600000 ms

function createWatchdog(deps) {
  deps = deps || {};
  const evaluate = deps.evaluate;
  const fetchStatus = deps.fetchStatus;
  const wake = deps.wake;
  if (typeof evaluate !== "function") throw new Error("watchdog-runtime: deps.evaluate ต้องเป็นฟังก์ชัน");
  if (typeof fetchStatus !== "function") throw new Error("watchdog-runtime: deps.fetchStatus ต้องเป็นฟังก์ชัน");
  if (typeof wake !== "function") throw new Error("watchdog-runtime: deps.wake ต้องเป็นฟังก์ชัน");

  const broadcast = typeof deps.broadcast === "function" ? deps.broadcast : () => {};
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const cooldownMs = Number(deps.cooldownMs) > 0 ? Number(deps.cooldownMs) : DEFAULT_COOLDOWN_MS;
  const intervalMs = Number(deps.intervalMs) > 0 ? Number(deps.intervalMs) : DEFAULT_INTERVAL_MS;
  const stuckHeartbeatMs = Number(deps.stuckHeartbeatMs) > 0
    ? Number(deps.stuckHeartbeatMs) : DEFAULT_STUCK_HEARTBEAT_MS;
  const aliasesOf = () => {
    try { return typeof deps.aliases === "function" ? deps.aliases() : (deps.aliases || {}); }
    catch (e) { log("aliases() พัง: " + (e && e.message)); return {}; }
  };

  // เก็บข้ามรอบ — ส่งกลับเข้า evaluate ให้ cooldown rule ทำงานต่อเนื่อง.
  const wokenAt = {};
  let timer = null;
  let ticking = false;   // กัน tick ซ้อน (รอบก่อนยังปลุกไม่เสร็จ)

  // หนึ่งรอบตรวจ — return ผล evaluate (หรือ {skipped/error}) เพื่อให้เทสต์ยืนยันได้.
  async function tick() {
    if (ticking) return { skipped: "in-flight" };
    ticking = true;
    try {
      let payload = null;
      try { payload = await fetchStatus(); }
      catch (e) { log("fetchStatus พัง: " + (e && e.message)); return { error: "fetch" }; }
      // อ่าน snapshot ไม่ได้ (live down) → ไม่ปลุกใครรอบนี้ (fail-safe: ไม่เดาว่าใครค้าง)
      if (!payload || typeof payload !== "object") return { error: "no-payload" };

      const result = evaluate(payload, {
        aliases: aliasesOf(),
        cooldownMs,
        wokenAt,
        wakeThresholdMs: stuckHeartbeatMs,   // เกณฑ์ปลุก 10 นาที (ทับ thresholdMs ~2 นาทีของแผง)
        now: now(),     // fallback clock เมื่อ payload ไม่มี now (agent-status มักส่ง now มาเอง)
      });
      // ใช้ "นาฬิกาเดียวกับที่ evaluate ใช้จริง" (result.now = payload.now ถ้ามี ไม่งั้น
      // opts.now) มาร์ค wokenAt — cooldown rule รอบถัดไปจึงเทียบฐานเวลาเดียวกันเป๊ะ.
      const evalNow = Number(result.now) || now();

      for (const entry of (result.wake || [])) {
        if (!entry || entry.id == null) continue;
        // มาร์ค wokenAt "ก่อน" ปลุก: ถ้า wake() ใช้เวลานานหรือพัง รอบถัดไปก็ยังเคารพ
        // cooldown — กันยิงซ้ำตอน tick รอบหน้ามาก่อน wake รอบนี้จบ.
        wokenAt[entry.id] = evalNow;
        try {
          await wake(entry, payload);
          broadcast({
            type: "chat.message", agent: "main", watchdog: true,
            text: `🐕 WatchDog ปลุก ${entry.name || entry.id} — ${entry.detail || entry.reason}`,
          });
          log(`woke ${entry.id} (${entry.reason})`);
        } catch (e) {
          log(`wake ${entry.id} พัง: ${e && e.message}`);
          broadcast({
            type: "chat.message", agent: "main", watchdog: true,
            text: `🐕⚠️ WatchDog ปลุก ${entry.name || entry.id} ไม่สำเร็จ (${String((e && e.message) || e).slice(0, 120)})`,
          });
        }
      }

      // project-overlap: แจ้งครั้งเดียวต่อ "ชุด" (กัน spam ทุก 30s) — เทียบ signature.
      const overlaps = result.overlaps || [];
      const sig = JSON.stringify(overlaps.map((o) => [o.project, (o.agents || []).slice().sort()]));
      if (overlaps.length && sig !== tick._overlapSig) {
        tick._overlapSig = sig;
        broadcast({
          type: "chat.message", agent: "main", watchdog: true,
          text: "🐕 WatchDog เจอ project-overlap: " +
            overlaps.map((o) => `${o.project} (${(o.agents || []).join(", ")})`).join(" · "),
        });
      } else if (!overlaps.length) {
        tick._overlapSig = "";
      }

      return result;
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    // ยิงรอบแรกหน่วงสั้นๆ ให้ boot นิ่งก่อน (ไม่ปลุกใครระหว่าง daemon เพิ่งตื่น).
    timer = setInterval(() => { tick().catch((e) => log("tick พัง: " + (e && e.message))); }, intervalMs);
    if (timer.unref) timer.unref();   // อย่าให้ loop กัน process ปิดตอน test/exit
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { tick, start, stop, state: { wokenAt }, intervalMs, cooldownMs, stuckHeartbeatMs };
}

module.exports = { createWatchdog, DEFAULT_INTERVAL_MS, DEFAULT_COOLDOWN_MS, DEFAULT_STUCK_HEARTBEAT_MS };
