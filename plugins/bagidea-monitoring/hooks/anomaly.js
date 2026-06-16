// hooks/anomaly.js — เลน "anomaly" (น้องไวท์). เฟส 1: baseline / threshold-deviation.
// เจ้าภาพ aggregator+source: มิสเตอร์ N — hook นี้ "เสียบ" โดยไม่แตะ index.js / lib/*.
//
// หลักการ (อ่าน hooks/README.md): aggregator เรียก analyze(snapshot, api) หลังประกอบ snapshot
//   • read-only      — อ่าน snapshot อย่างเดียว, ไม่ mutate, คืน { anomalies:[...] } ก้อนใหม่
//   • fail-open      — ห้าม throw เด็ดขาด: error ใดๆ → คืน { anomalies:[] } เงียบๆ
//   • state ส่วนตัว  — เขียนเฉพาะ dataDir ของ plugin เอง (atomic tmp+rename), ไม่แตะไฟล์เลนอื่น
//
// วิธีตรวจ: EWMA (exponentially-weighted mean + variance) ต่อ "series" หนึ่งตัว
//   ต่อ metric — ปรับตัวตาม drift, ใช้หน่วยความจำคงที่ (ไม่สะสม time-series ยาว).
//   วัด z-score ของค่าปัจจุบัน "เทียบ baseline ก่อนอัปเดต" → spike เกิน threshold = anomaly.
//   เสริม: constant-then-jump guard (series นิ่งแล้วเด้ง) + trend (ไต่ขึ้นต่อเนื่อง).
//
// api ที่ aggregator ส่งให้ = { cfg, client, log, now } — ไม่มี dataDir → derive จาก __dirname.
// (override ได้ด้วย env BAGMON_ANOMALY_DATADIR สำหรับ selftest/relocate)
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.BAGMON_ANOMALY_DATADIR || path.join(__dirname, "..", "data");
const BASELINE_FILE = path.join(DATA_DIR, "anomaly-baseline.json");

// ── ค่าปรับจูน (override ได้ผ่าน cfg.anomaly ใน data/config.json โดยไม่แก้โค้ด) ──
const DEF = {
  alpha: 0.3,            // EWMA smoothing — สูง=ไวต่อค่าใหม่, ต่ำ=นิ่ง
  minSamples: 8,         // warmup: ต้องเก็บ baseline ครบเท่านี้ก่อนถึงจะ flag (กัน false ตอนเพิ่งเริ่ม)
  zWarn: 3,              // z ≥ 3 → warn
  zCrit: 4.5,            // z ≥ 4.5 → crit
  minStd: 1e-6,          // ต่ำกว่านี้ถือว่า std≈0 (series นิ่ง) → ใช้ absolute-jump guard แทน
  absJumpCount: 2,       // count metric: ต้องขยับ ≥ เท่านี้ถึงนับ (กัน noise ค่าเล็ก)
  absJumpPct: 15,        // cpu/mem (%): ต้องขยับ ≥ เท่านี้
  trendLen: 5,           // ความยาว ring สำหรับดู monotonic growth
  staleMs: 30 * 60 * 1000, // prune series ที่ไม่เห็นนานเกินนี้ (agent ที่หายไป ฯลฯ)
  maxSeries: 300,        // เพดานกัน baseline file โตไม่จบ
};

// metric ระดับระบบที่สนใจ "spike ขึ้น" (key ตรงกับ source metrics)
const WATCH = [
  "agents.working", "agents.queue", "agents.claims", "agents.stuck",
  "agents.timedOut", "agents.warnBlock", "agents.warnWarn",
  "daemon.clients", "daemon.pendingPerms",
];

const round = (x) => (x == null || !isFinite(x)) ? null : Math.round(x * 100) / 100;
const nowMs = () => { try { return Date.now(); } catch { return 0; } };

function conf(api) {
  const over = (api && api.cfg && api.cfg.anomaly && typeof api.cfg.anomaly === "object") ? api.cfg.anomaly : {};
  return { ...DEF, ...over };
}

// ── persistence (atomic, fail-open) ────────────────────────────────────────
function loadBaseline() {
  try {
    const j = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
    if (j && j.series && typeof j.series === "object") return { v: 1, series: j.series, updatedAt: j.updatedAt || 0 };
  } catch { /* ไม่มีไฟล์/เสีย → เริ่มใหม่ */ }
  return { v: 1, series: {}, updatedAt: 0 };
}
function saveBaseline(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = BASELINE_FILE + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, BASELINE_FILE);   // atomic swap
  } catch { /* baseline เป็น best-effort: เขียนไม่ได้ก็ยังตรวจรอบนี้ได้ */ }
}

// state ในหน่วยความจำ (module ถูก re-require ตอน /plugins/reload → โหลดจาก disk ใหม่)
let STATE = null;
function getState() { if (!STATE) STATE = loadBaseline(); return STATE; }
// ใช้ใน selftest เพื่อรีเซ็ตระหว่าง scenario
function _reset() { STATE = null; }

// ── EWMA: อัปเดต series; คืนสถิติ "ก่อน" อัปเดต (สำหรับวัด deviation) ──────────
function ewmaStep(s, x, alpha) {
  if (s.n === 0) { s.mean = x; s.var = 0; s.n = 1; return null; } // ตัวอย่างแรก: ยังตัดสินไม่ได้
  const meanBefore = s.mean, stdBefore = Math.sqrt(Math.max(0, s.var));
  const diff = x - s.mean;
  const incr = alpha * diff;
  s.mean = s.mean + incr;
  s.var = (1 - alpha) * (s.var + diff * incr);  // EW variance (West 1979)
  s.n++;
  return { meanBefore, stdBefore, diff };
}

// ตรวจ 1 series → คืน descriptor ของ anomaly หรือ null
function detectSeries(state, skey, x, kind, cfg, now) {
  let s = state.series[skey];
  if (!s) { s = { n: 0, mean: 0, var: 0, recent: [], lastTs: now, kind }; state.series[skey] = s; }
  s.lastTs = now;
  s.recent.push(x); if (s.recent.length > cfg.trendLen) s.recent.shift();

  const before = ewmaStep(s, x, cfg.alpha);
  if (!before) return null;                       // ตัวอย่างแรก
  if (s.n < cfg.minSamples) return null;          // ยัง warmup → ไม่ flag

  const absMin = kind === "pct" ? cfg.absJumpPct : cfg.absJumpCount;
  const diff = before.diff;                        // x - baseline(ก่อน)
  const std = before.stdBefore;

  // สนใจเฉพาะ spike "ขึ้น" (load พุ่ง) — ขาลงปล่อยให้ trend จับถ้าจำเป็น
  if (diff >= absMin) {
    if (std > cfg.minStd) {
      const z = diff / std;
      if (z >= cfg.zWarn) {
        return {
          reason: "spike", observed: x, expected: round(before.meanBefore),
          z: round(z), std: round(std),
          severity: z >= cfg.zCrit ? "crit" : "warn",
          score: round(Math.max(0, Math.min(1, z / (cfg.zCrit * 1.5)))),
        };
      }
    } else {
      // series นิ่งสนิทแล้วเด้ง (std≈0): absolute jump ≥ absMin = สัญญาณชัด
      return {
        reason: "jump", observed: x, expected: round(before.meanBefore),
        z: null, std: 0,
        severity: diff >= absMin * 2 ? "crit" : "warn",
        score: diff >= absMin * 2 ? 0.75 : 0.55,
      };
    }
  }

  // ไม่เข้า spike/jump → ลองดู "ไต่ขึ้นต่อเนื่อง" (queue/working ค่อยๆ โตทุก poll)
  return detectTrend(s, before, absMin, cfg);
}

function detectTrend(s, before, absMin, cfg) {
  const r = s.recent;
  if (r.length < cfg.trendLen) return null;
  for (let i = 1; i < r.length; i++) if (!(r[i] > r[i - 1])) return null; // ต้องขึ้นทุกก้าวจริงๆ
  const growth = r[r.length - 1] - r[0];
  if (growth < absMin) return null;
  return {
    reason: "trend", observed: r[r.length - 1], expected: round(before.meanBefore),
    z: null, std: round(before.stdBefore), severity: "warn", score: 0.5,
  };
}

const TITLE = {
  spike: (l) => "⚡ " + l + " พุ่งผิดปกติ",
  jump:  (l) => "⚡ " + l + " กระโดดผิดปกติ",
  trend: (l) => "📈 " + l + " ไต่ขึ้นต่อเนื่อง",
};
function mkAnomaly(d, ctx) {
  const z = d.z != null ? (" · z=" + d.z) : "";
  const idTail = ctx.agent ? (":" + ctx.agent) : "";
  return {
    id: d.reason + ":" + ctx.key + idTail,
    key: ctx.key,
    observed: d.observed,
    expected: d.expected,
    z: d.z,
    severity: d.severity,
    source: ctx.source,
    score: d.score,
    title: (TITLE[d.reason] || TITLE.spike)(ctx.label),
    detail: "observed=" + d.observed + " เทียบ baseline≈" + d.expected + z + " (" + d.reason + ")",
    ts: ctx.now,
    ...(ctx.agent ? { agent: ctx.agent, project: ctx.project || null } : {}),
  };
}

function pruneStale(state, now, cfg) {
  for (const k of Object.keys(state.series)) {
    if (now - (state.series[k].lastTs || 0) > cfg.staleMs) delete state.series[k];
  }
  const ks = Object.keys(state.series);
  if (ks.length > cfg.maxSeries) {
    ks.sort((a, b) => (state.series[a].lastTs || 0) - (state.series[b].lastTs || 0));
    for (let i = 0; i < ks.length - cfg.maxSeries; i++) delete state.series[ks[i]];
  }
}

module.exports = {
  id: "anomaly",
  _reset, // (selftest only)

  async analyze(snapshot, api) {
    const anomalies = [];
    try {
      const cfg = conf(api);
      const now = (snapshot && snapshot.ts) || (api && api.now) || nowMs();
      const state = getState();

      // 1) metric ระดับระบบ (spike ขึ้น)
      const list = (snapshot && Array.isArray(snapshot.metrics)) ? snapshot.metrics : [];
      const byKey = {};
      for (const m of list) if (m && m.key != null) byKey[m.key] = m;
      for (const key of WATCH) {
        const m = byKey[key];
        if (!m) continue;
        const v = Number(m.value);
        if (!isFinite(v)) continue;
        const d = detectSeries(state, "g:" + key, v, "count", cfg, now);
        if (d) anomalies.push(mkAnomaly(d, { key, source: m.source || "metrics", label: m.label || key, now }));
      }

      // 2) ต่อ agent: cpu / mem เกิน baseline ของตัวเอง
      const adata = snapshot && snapshot.sources && snapshot.sources.agents && snapshot.sources.agents.data;
      const agents = (adata && Array.isArray(adata.agents)) ? adata.agents : [];
      for (const ag of agents) {
        if (!ag || ag.id == null) continue;
        for (const f of ["cpu", "mem"]) {
          const v = Number(ag[f]);
          if (!isFinite(v)) continue;
          const d = detectSeries(state, "a:" + f + ":" + ag.id, v, "pct", cfg, now);
          if (d) anomalies.push(mkAnomaly(d, {
            key: "agent." + f, source: "agents",
            label: (ag.name || ag.id) + " " + f.toUpperCase(),
            now, agent: ag.id, project: ag.project || null,
          }));
        }
      }

      // 3) ดูแล baseline: prune + persist (atomic, best-effort)
      pruneStale(state, now, cfg);
      state.updatedAt = now;
      saveBaseline(state);
    } catch (e) {
      try { api && api.log && api.log("[anomaly] hook error: " + (e && e.message)); } catch {}
      return { anomalies: [] };   // fail-open: ห้ามล้ม snapshot
    }
    return { anomalies };
  },
};
