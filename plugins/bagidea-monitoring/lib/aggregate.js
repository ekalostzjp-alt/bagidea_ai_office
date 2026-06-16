// 📈 BagIdea Monitoring — aggregator (snapshot assembler + auto-loader).
// เจ้าภาพ: มิสเตอร์ N.  หัวใจของ plugin: รวมทุก data source เป็น snapshot ก้อนเดียว
// แล้วเปิดให้ "hook" (analyzer) เสียบต่อยอด alert/anomaly ได้โดย "ไม่แก้ไฟล์นี้".
//
// ════════════════════════════════════════════════════════════════════════════
// จุดเสียบของอีก 2 เลน (ออกแบบให้ไม่ชนไฟล์กัน — แต่ละคนสร้างไฟล์ของตัวเอง):
//   • แบล็ค (alerts)      → สร้าง  hooks/alerts.js     (ตัวอย่าง: hooks/alerts.sample.js)
//   • น้องไวท์ (anomaly)  → สร้าง  hooks/anomaly.js    (ตัวอย่าง: hooks/anomaly.sample.js)
// loader นี้ auto-discover ทุก hooks/*.js (ยกเว้น *.sample.js / ขึ้นต้น _). ทั้งคู่รับ
// snapshot เดียวกัน คืน { alerts?:[], anomalies?:[] } — ผลถูก merge เข้า snapshot ให้เอง.
// เพิ่ม data source ใหม่ก็แค่หย่อนไฟล์ sources/<id>.js (รูปแบบตาม SOURCE CONTRACT).
// ════════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

const RANK = { ok: 0, warn: 1, down: 2, crit: 3 };           // ใช้ม้วน health รวม
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);
// down ของ source เดียวถือเป็น warn ระดับ health รวม (fail-open: ไม่ลากทั้งระบบเป็น crit)
const toHealth = (s) => (s === "down" ? "warn" : (s === "crit" ? "crit" : (s === "warn" ? "warn" : "ok")));

// โหลดไฟล์ .js ในโฟลเดอร์แบบทนพัง: ไฟล์ไหนพังข้ามตัวนั้น (ไม่ให้ล้มทั้ง monitor)
function loadDir(dir, log, skipSample) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(".js")) continue;
    if (name.startsWith("_")) continue;
    if (skipSample && name.endsWith(".sample.js")) continue;
    const full = path.join(dir, name);
    try {
      delete require.cache[require.resolve(full)];   // hot-reload ตาม /plugins/reload
      const mod = require(full);
      if (mod && typeof mod === "object") out.push({ name, mod });
    } catch (e) { log && log("skip " + name + ": " + e.message); }
  }
  return out;
}

// รัน fn พร้อม timeout กันค้าง (source/hook ตัวเดียวห้ามแขวนทั้ง snapshot)
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(onTimeout); } }, ms);
    Promise.resolve(promise).then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
      .catch((e) => { if (!done) { done = true; clearTimeout(t); resolve({ ...onTimeout, detail: "error: " + e.message }); } });
  });
}

function makeAggregator(opts) {
  const { sourcesDir, hooksDir, makeClient, getCfg, log } = opts;

  async function snapshot(now) {
    now = now || Date.now();
    const cfg = getCfg();
    const client = makeClient(cfg.baseUrl, cfg.timeoutMs);
    const api = { cfg, client, log, now };
    const hardMs = (cfg.timeoutMs || 2500) + 1500;            // เผื่อมากกว่า http timeout เล็กน้อย

    // ── 1) collect data sources (ขนาน, fail-open ต่อตัว) ───────────────────────
    const mods = loadDir(sourcesDir, log, false);
    const results = await Promise.all(mods.map(async ({ name, mod }) => {
      if (typeof mod.collect !== "function") return null;
      const key = mod.enabledKey || mod.id;
      if (cfg.sources && cfg.sources[key] === false) return null;   // ปิดผ่าน config
      const down = { ok: false, status: "down", detail: "timeout/empty", data: null, metrics: [] };
      const res = await withTimeout(mod.collect(api), hardMs, down);
      return { id: mod.id || name.replace(/\.js$/, ""), label: mod.label || mod.id || name, res: res || down };
    }));

    const sources = {};
    let metrics = [];
    let health = "ok";
    for (const r of results) {
      if (!r) continue;
      const { id, label, res } = r;
      sources[id] = {
        ok: !!res.ok, status: res.status || "ok", label,
        detail: res.detail || "", data: res.data != null ? res.data : null,
      };
      const ms = Array.isArray(res.metrics) ? res.metrics.map((m) => ({ ...m, source: id })) : [];
      metrics = metrics.concat(ms);
      health = worst(health, toHealth(res.status || "ok"));
    }

    // snapshot ฐาน (ก่อน hook) — นี่คือสิ่งที่ hook จะได้รับ
    const snap = {
      ok: true, ts: now, baseUrl: cfg.baseUrl,
      sources, metrics,
      alerts: [],        // ← แบล็ค เติมผ่าน hook
      anomalies: [],     // ← ไวท์ เติมผ่าน hook
      health,            // ม้วนจาก source status (hook อาจดันขึ้นได้)
    };

    // ── 2) run hooks (analyzers) — แบล็ค/ไวท์ เสียบที่นี่ ──────────────────────
    const hooks = loadDir(hooksDir, log, true);
    for (const { name, mod } of hooks) {
      if (typeof mod.analyze !== "function") continue;
      const out = await withTimeout(Promise.resolve(mod.analyze(snap, api)), hardMs, null)
        .catch((e) => { log && log("hook " + name + " error: " + e.message); return null; });
      if (!out || typeof out !== "object") continue;
      if (Array.isArray(out.alerts)) snap.alerts = snap.alerts.concat(out.alerts.map((a) => ({ hook: mod.id || name, ...a })));
      if (Array.isArray(out.anomalies)) snap.anomalies = snap.anomalies.concat(out.anomalies.map((a) => ({ hook: mod.id || name, ...a })));
    }

    // health ม้วนรวม alert/anomaly severity ด้วย (crit/warn)
    for (const a of snap.alerts.concat(snap.anomalies)) {
      const sev = String(a.severity || "").toLowerCase();
      if (sev === "crit" || sev === "critical") health = worst(health, "crit");
      else if (sev === "warn" || sev === "warning") health = worst(health, "warn");
    }
    snap.health = health;
    snap.hooks = hooks.map((h) => h.mod.id || h.name);
    return snap;
  }

  // รายชื่อ source/hook ที่ลงทะเบียน (ไว้ debug/introspect ให้ทีม)
  function registry() {
    const cfg = getCfg();
    return {
      sources: loadDir(sourcesDir, log, false).map(({ name, mod }) => ({
        id: mod.id || name, label: mod.label || null,
        enabledKey: mod.enabledKey || mod.id || null,
        enabled: !(cfg.sources && cfg.sources[mod.enabledKey || mod.id] === false),
      })),
      hooks: loadDir(hooksDir, log, true).map(({ name, mod }) => ({ id: mod.id || name, file: name })),
    };
  }

  return { snapshot, registry };
}

module.exports = { makeAggregator };
