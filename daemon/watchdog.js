// 🐕 WatchDog — STEP 1: pure evaluator (เจ้าภาพ: แบล็ค)
//
// PURE MODULE โดยตั้งใจ: ไม่มี fs / timer / network / Date.now / random ในไฟล์นี้
// ทุก input มาจาก payload + opts → deterministic + เทสต์ได้ 100%. STEP 2
// (loop / auto-wake / broadcast) ค่อยห่อ evaluate() ทีหลังหลังรีวิว —
// ห้ามใส่ side-effect ใดๆ ลงในไฟล์นี้.
//
// evaluate(payload, opts) :
//   payload = ผลของ agent-status `cmd status` (ดู CONTRACT ใน plugins/agent-status/index.js):
//     { now, thresholdMs,
//       agents:[{ id, name, state:"working"|"stuck"|"idle", lastHeartbeatMs, timedOut, ... }],
//       claims:[{ agentId, files:[…], ts, ttlMs, … }],
//       queue :[{ claim:{ agentId, … } }],
//       warnings:[{ type:"project-overlap"|"file-overlap", … }] }
//   opts = { aliases?, cooldownMs?, wokenAt?, now? }
//     aliases  : แม็พ id ข้ามภาษา เช่น {"mister-n":"มิสเตอร์-n"} — claim.agentId เป็น
//                latin แต่ roster id เป็นไทย; รองรับการ match 2 ทาง.
//     cooldownMs + wokenAt : กันปลุกซ้ำถี่ — wokenAt[id] = epoch ms ที่ปลุกล่าสุด;
//                ถ้า now - wokenAt[id] < cooldownMs ⇒ ข้าม agent นั้น (lookup ทั้ง
//                raw id และ canonical id).
//
// คืน { now, thresholdMs, wake:[{ id, name, reason, detail }], overlaps:[…] }
//   reason ∈ "stuck-heartbeat" | "idle-holding-work".
//
// กติกา 3 ข้อ:
//   (1) stuck-heartbeat   : state ∈ {working,stuck} แต่ now - lastHeartbeatMs > thresholdMs
//   (2) idle-holding-work : state == idle แต่ยังถือ active claim (now - ts < ttlMs)
//                           หรือมี queued entry ของตัวเอง  ← รูที่ agent-status เดิมจับไม่ได้
//   (3) overlaps          : ส่งต่อ warnings ชนิด project-overlap ตรงๆ

"use strict";

// เกณฑ์ heartbeat เงียบที่ WatchDog ใช้ "ตัดสินใจปลุก" agent จริง — แยกจาก
// thresholdMs ของ agent-status (ไฟเตือนบนแผง ~2 นาที / AGENT_LIVE_TIMEOUT_MS).
// ปลุกฟรีตอน agent ยังเดิน heartbeat ปกติ = เปลือง token; จึงรอจน "เงียบเกิน
// 10 นาทีจริงๆ" ค่อยปลุก. caller ฉีด opts.wakeThresholdMs มาทับได้ (เทสต์/ทูน).
const STUCK_HEARTBEAT_MS = 10 * 60_000;   // 600000 ms = 10 นาที

// สร้าง canonicalizer จาก aliases: ทั้งสองฝั่งของคู่ map ไปยัง "ค่า" เป็น canonical
// ของกลุ่ม → ป้อน id ฝั่งไหนเข้าไปก็ได้ canonical เดียวกัน (claim ⇄ roster).
function buildCanon(aliases) {
  const m = new Map();
  if (aliases && typeof aliases === "object") {
    for (const [k, v] of Object.entries(aliases)) {
      if (k == null || v == null) continue;
      const kk = String(k), vv = String(v);
      m.set(kk, vv);   // mister-n → มิสเตอร์-n
      m.set(vv, vv);   // มิสเตอร์-n → มิสเตอร์-n (idempotent)
    }
  }
  return (id) => {
    const s = String(id == null ? "" : id);
    return m.has(s) ? m.get(s) : s;
  };
}

// active = ยังถืออยู่จริง. fail-open: ts/ttlMs ขาด/ไม่ใช่ตัวเลข ⇒ ถือว่ายัง active
// (อย่าปล่อยให้ claim ที่ข้อมูลไม่ครบหลุดการตรวจไปเงียบๆ — นั่นคือเคสที่อันตราย).
function claimActive(claim, now) {
  if (!claim) return false;
  const ts = Number(claim.ts);
  const ttl = Number(claim.ttlMs);
  if (!Number.isFinite(ts) || !Number.isFinite(ttl)) return true;
  return now - ts < ttl;
}

function evaluate(payload, opts) {
  payload = payload || {};
  opts = opts || {};

  const now = Number(payload.now != null ? payload.now : opts.now) || 0;
  const thresholdRaw = Number(payload.thresholdMs);
  const thresholdMs = Number.isFinite(thresholdRaw) ? thresholdRaw : null;

  // เกณฑ์ที่ใช้ "ตัดสินใจปลุก" กติกา 1 (stuck-heartbeat): opts.wakeThresholdMs ถ้าฉีดมา,
  // ไม่งั้น fallback เป็น thresholdMs ของ payload (คงพฤติกรรมเดิม — เทสต์/caller ที่ไม่
  // ฉีดค่าใหม่ยังได้เกณฑ์เดิมเป๊ะ). runtime จริงฉีด STUCK_HEARTBEAT_MS (10 นาที) เข้ามา.
  // ระวัง: Number(null)===0 และ Number("")===0 — ทั้งคู่ finite. ถ้าเช็ค Number.isFinite
  // เฉยๆ ค่า null/"" จะถูกตีเป็นเกณฑ์ปลุก 0ms (ปลุกทุก agent ที่เงียบ >0ms ทันที). จึง
  // ต้องคัด null/undefined/""/whitespace ออกก่อน ⇒ ถือว่า explicit เฉพาะตัวเลข finite จริงๆ,
  // ไม่งั้น fallback ไป payload.thresholdMs ตามสัญญา comment :75-77.
  const wakeRaw = opts.wakeThresholdMs;
  const wakeStr = typeof wakeRaw === "string" ? wakeRaw.trim() : wakeRaw;
  const wakeThrNum = Number(wakeStr);
  const hasExplicitWakeThreshold =
    wakeStr != null && wakeStr !== "" && Number.isFinite(wakeThrNum);   // caller ฉีดเกณฑ์ปลุกมาเอง?
  const wakeThresholdMs = hasExplicitWakeThreshold ? wakeThrNum : thresholdMs;

  const agents = Array.isArray(payload.agents) ? payload.agents : [];
  const claims = Array.isArray(payload.claims) ? payload.claims : [];
  const queue = Array.isArray(payload.queue) ? payload.queue : [];
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];

  const canon = buildCanon(opts.aliases);
  const cooldownMs = Number(opts.cooldownMs) || 0;
  const wokenAt = (opts.wokenAt && typeof opts.wokenAt === "object") ? opts.wokenAt : {};

  // index claim/queue ตาม canonical agentId (claim ใช้ latin, roster ใช้ไทย)
  const heldByAgent = new Map();    // canonId -> [claim,…] (เฉพาะที่ยัง active)
  for (const c of claims) {
    if (!claimActive(c, now)) continue;
    const k = canon(c.agentId);
    (heldByAgent.get(k) || heldByAgent.set(k, []).get(k)).push(c);
  }
  const queuedByAgent = new Map();  // canonId -> [claim,…]
  for (const q of queue) {
    const claim = q && q.claim;
    if (!claim) continue;
    const k = canon(claim.agentId);
    (queuedByAgent.get(k) || queuedByAgent.set(k, []).get(k)).push(claim);
  }

  // cooldown: ถ้า agent เพิ่งถูกปลุกภายใน cooldownMs ⇒ ข้าม (กัน wake ถี่ๆ).
  // lookup ทั้ง raw id และ canonical เผื่อ caller เก็บ wokenAt ด้วย id ฝั่งใดก็ได้.
  function inCooldown(id) {
    if (!cooldownMs) return false;
    for (const key of [id, canon(id)]) {
      const w = Number(wokenAt[key]);
      if (Number.isFinite(w) && now - w < cooldownMs) return true;
    }
    return false;
  }

  const wake = [];
  for (const a of agents) {
    if (!a || a.id == null) continue;
    const state = String(a.state || "idle").toLowerCase();
    const cid = canon(a.id);

    // กติกา 1 — working/stuck แต่ heartbeat เงียบเกิน threshold
    if (state === "working" || state === "stuck") {
      // ระวัง (เหมือน wakeThresholdMs :78-81): Number(null)===0 และ Number("")===0
      // ทั้งคู่ finite. ถ้า Number() ดื้อๆ ค่า null/undefined/""/whitespace จะถูกตีเป็น
      // heartbeat=0 → silent = now (ค่ามหาศาลตั้งแต่ epoch) → overThreshold เป็น true
      // เสมอ → ปลุกทั้งที่ "คำนวณ silence ไม่ได้". จึงต้องคัดค่าว่างออกก่อน ⇒ เฉพาะ
      // ตัวเลข finite จริงเท่านั้นถึงคำนวณ silent; ไม่งั้น silent=null (uncomputable)
      // แล้วปล่อยให้ trustTimedOut (fail-toward-detect) ตัดสินตาม timedOut ของ server.
      const hbRaw = a.lastHeartbeatMs;
      const hbStr = typeof hbRaw === "string" ? hbRaw.trim() : hbRaw;
      const hb = (hbStr == null || hbStr === "") ? NaN : Number(hbStr);
      const silent = Number.isFinite(hb) ? now - hb : null;
      const overThreshold = silent != null && wakeThresholdMs != null && silent > wakeThresholdMs;
      // เคารพ timedOut ที่ server คำนวณมา (fail-toward-detect) ใน 2 กรณี:
      //   (ก) heartbeat หาย คำนวณ silence เองไม่ได้ (silent == null) → เชื่อ server เสมอ; หรือ
      //   (ข) caller ไม่ได้ฉีด wakeThresholdMs (fallback mode) → คงพฤติกรรมเดิมตามสัญญา
      //       comment :75-77 ที่ว่า "ไม่ฉีดค่าใหม่ = ได้เกณฑ์/พฤติกรรมเดิมเป๊ะ".
      // ตัด timedOut ทิ้งเฉพาะตอน "ฉีด wakeThresholdMs มา + silence คำนวณได้" เท่านั้น —
      // กันไม่ให้ timedOut เกณฑ์ ~2 นาทีของแผง ลัดวงจรเกณฑ์ปลุก 10 นาทีของ WatchDog
      // ขณะ heartbeat ยังเดินอยู่ (runtime จริงฉีด stuckHeartbeatMs เข้ามาเสมอ).
      const trustTimedOut = a.timedOut === true && (silent == null || !hasExplicitWakeThreshold);
      if (overThreshold || trustTimedOut) {
        if (inCooldown(a.id)) continue;
        wake.push({
          id: a.id,
          name: a.name || a.id,
          reason: "stuck-heartbeat",
          detail: silent != null
            ? `${state} แต่ heartbeat เงียบ ${Math.round(silent / 1000)}s` +
              (wakeThresholdMs != null ? ` (เกิน ${Math.round(wakeThresholdMs / 1000)}s)` : "")
            : `${state} แต่ถูกมาร์ค timedOut`,
        });
      }
      continue;   // working/stuck ไม่เข้ากติกา 2
    }

    // กติกา 2 — idle แต่ยังถือ active claim หรือมี queued entry ของตัวเอง
    if (state === "idle") {
      const held = heldByAgent.get(cid) || [];
      const queued = queuedByAgent.get(cid) || [];
      if (!held.length && !queued.length) continue;
      if (inCooldown(a.id)) continue;
      const files = [];
      for (const c of held) for (const f of (c.files || [])) files.push(f);
      const parts = [];
      if (held.length) {
        parts.push(`ถือ ${held.length} active claim` +
          (files.length ? ` (${files.slice(0, 5).join(", ")})` : ""));
      }
      if (queued.length) parts.push(`มี queued ${queued.length} รายการ`);
      wake.push({
        id: a.id,
        name: a.name || a.id,
        reason: "idle-holding-work",
        detail: `idle แต่ ${parts.join(" + ")}`,
      });
    }
  }

  // กติกา 3 — ส่งต่อ project-overlap warnings → overlaps (file-overlap ไม่นับ)
  const overlaps = warnings.filter((w) => w && w.type === "project-overlap");

  return { now, thresholdMs, wake, overlaps };
}

module.exports = { evaluate, buildCanon, claimActive, STUCK_HEARTBEAT_MS };
