// 📈 BagIdea Monitoring — server side. เจ้าภาพ: มิสเตอร์ N (Backend).
// CONTRACT: workspace/projects/BagIdea Monitoring Plugin/CONTRACT.md
//
// เฟส 1 = real-time metrics รวมหลายแหล่งในแผงเดียว (read-only, fail-open):
//   • daemon  health+version  (GET /health, /version)
//   • agents  roster/claims/queue/collision (POST /plugin/agent-status/cmd status)
//   • state-drift  รวม Daemon State Monitor ตามที่ CEO สั่ง (POST .../daemon-state-monitor/cmd health)
// ทุกปลายทางอยู่ใน config (data/config.json) — ไม่ hardcode, ผู้ดูแลแก้ได้.
//
// สถาปัตยกรรม data-source + hook (ดู lib/aggregate.js): index.js เป็น orchestrator บางๆ
//   - data source ใหม่  → หย่อนไฟล์ sources/<id>.js
//   - แบล็ค (alerts)     → hooks/alerts.js   (จุดเสียบ — ไม่แตะ index.js)
//   - น้องไวท์ (anomaly) → hooks/anomaly.js  (จุดเสียบ — ไม่แตะ index.js)
//
// commands (agent + panel ใช้ช่องทางเดียวกัน POST /plugin/bagidea-monitoring/cmd):
//   snapshot  → snapshot รวมครบ (sources+metrics+alerts+anomalies+health)
//   metrics   → เฉพาะ flat metrics[] (เบากว่า)
//   sources   → รายชื่อ source/hook ที่ลงทะเบียน (introspect)
//   config    → config ที่ใช้งานจริง (debug)
const path = require("path");
const { load: loadConfig } = require("./lib/config");
const { makeClient } = require("./lib/httpc");
const { makeAggregator } = require("./lib/aggregate");

const CACHE_MS = Math.max(1000, Number(process.env.BAGMON_CACHE_MS) || 2000);  // กัน busy-loop จาก poll ถี่

module.exports = (ctx) => {
  const log = (m) => { try { ctx.log && ctx.log("[bagidea-monitoring] " + m); } catch {} };
  let cfg = loadConfig(ctx.dataDir, log);

  const agg = makeAggregator({
    sourcesDir: path.join(ctx.pluginDir || __dirname, "sources"),
    hooksDir: path.join(ctx.pluginDir || __dirname, "hooks"),
    makeClient,
    getCfg: () => cfg,
    log,
  });

  // cache สั้นๆ: panel poll ทุก ~5s + agent เรียกพร้อมกัน ไม่ควรยิงปลายทางซ้ำถี่ๆ
  let _cache = null;   // { ts, snap }
  async function getSnapshot() {
    const now = Date.now();
    if (_cache && now - _cache.ts < CACHE_MS) return _cache.snap;
    const snap = await agg.snapshot(now);
    _cache = { ts: now, snap };
    // ปลุก panel ที่เปิดอยู่ให้รู้ว่ามีข้อมูลใหม่ (ไม่ persist)
    try { ctx.broadcast({ type: "plugin.event", plugin: "bagidea-monitoring", health: snap.health }, false); } catch {}
    return snap;
  }

  async function onCommand(cmd, args, reply, payload) {
    if (cmd === "snapshot") return await getSnapshot();
    if (cmd === "metrics") { const s = await getSnapshot(); return { ok: true, ts: s.ts, health: s.health, metrics: s.metrics }; }
    if (cmd === "sources") return { ok: true, ...agg.registry() };
    if (cmd === "config") {
      cfg = loadConfig(ctx.dataDir, log);   // reload เผื่อผู้ดูแลแก้ config.json
      return { ok: true, config: cfg };
    }
    return { ok: false, msg: "ไม่รู้จักคำสั่ง: " + cmd };
  }

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };

  return {
    onCommand,
    routes: {
      // GET /plugin/bagidea-monitoring/snapshot — panel poll (fail-open, ห้าม 500)
      snapshot(req, res) {
        getSnapshot().then((s) => sendJson(res, 200, s)).catch((e) => {
          log("snapshot error: " + e.message);
          sendJson(res, 200, { ok: false, ts: Date.now(), sources: {}, metrics: [], alerts: [], anomalies: [], health: "warn", error: e.message });
        });
      },
    },
  };
};
