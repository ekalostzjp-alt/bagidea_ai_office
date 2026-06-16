// 📈 BagIdea Monitoring — config (NO hardcoded endpoints; ผู้ดูแลแก้ได้).
// เจ้าภาพ: มิสเตอร์ N.
//
// ลำดับการ resolve (ทับกันจากซ้ายไปขวา): DEFAULTS  ←  data/config.json  ←  ENV
//   • data/config.json : ผู้ดูแลแก้ได้สด ๆ (เขียน default ให้รอบแรกถ้ายังไม่มี)
//   • ENV : BAGMON_BASE_URL, BAGMON_POLL_MS, BAGMON_TIMEOUT_MS — override ชั่วคราว/test
//
// endpoints ทั้งหมดอยู่ใน config — source module อ่านจาก cfg.endpoints เท่านั้น
// ห้าม hardcode path ลับใน source (กฎข้อ: "อย่า hardcode ลับๆ ให้ config ได้").
const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  // ปลายทาง daemon ของเราเอง — loopback. เปลี่ยนได้ผ่าน config/env ถ้าต้อง monitor ตัวอื่น.
  baseUrl: "http://127.0.0.1:8787",
  pollMs: 5000,            // panel poll cadence (FE ใช้ค่านี้)
  timeoutMs: 2500,         // ต่อ 1 request ของ data source
  // เปิด/ปิด data source ทีละตัว (key ตรงกับ source.enabledKey)
  sources: { daemon: true, agents: true, "state-drift": true },
  // endpoint ที่แต่ละ source ใช้ — แก้ที่นี่ที่เดียว
  endpoints: {
    health: "/health",                                            // GET  daemon health
    version: "/version",                                          // GET  version cache vs latest
    agentStatus: { plugin: "agent-status", cmd: "status" },       // POST /cmd — roster+claims+queue
    stateDrift: { plugin: "daemon-state-monitor", cmd: "health" },// POST /cmd — state drift report
  },
};

// deep-merge ตื้นๆ พอใช้ (object ซ้อน object; ค่าอื่นทับทั้งก้อน)
function merge(base, over) {
  if (!over || typeof over !== "object") return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over)) {
    const b = base ? base[k] : undefined;
    const o = over[k];
    out[k] = (b && o && typeof b === "object" && typeof o === "object" && !Array.isArray(b) && !Array.isArray(o))
      ? merge(b, o) : o;
  }
  return out;
}

function load(dataDir, log) {
  const file = path.join(dataDir, "config.json");
  let onDisk = null;
  try { onDisk = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch {
    // เขียน default ให้รอบแรก เพื่อให้ผู้ดูแลเห็น/แก้ได้ (best-effort)
    try { fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2)); } catch (e) { log && log("config write fail: " + e.message); }
  }
  let cfg = merge(DEFAULTS, onDisk);

  // ENV overrides (ชนะ config.json) — สำหรับ test/ชั่วคราว
  if (process.env.BAGMON_BASE_URL) cfg.baseUrl = process.env.BAGMON_BASE_URL;
  if (process.env.BAGMON_POLL_MS) cfg.pollMs = Number(process.env.BAGMON_POLL_MS) || cfg.pollMs;
  if (process.env.BAGMON_TIMEOUT_MS) cfg.timeoutMs = Number(process.env.BAGMON_TIMEOUT_MS) || cfg.timeoutMs;

  // เตือนถ้า baseUrl ไม่ใช่ loopback (ไม่ block — แค่ surface ความเสี่ยง)
  try {
    const h = new URL(cfg.baseUrl).hostname;
    if (h !== "127.0.0.1" && h !== "localhost" && h !== "::1") log && log("baseUrl ไม่ใช่ loopback: " + cfg.baseUrl + " (ตรวจให้แน่ใจว่าตั้งใจ)");
  } catch { log && log("baseUrl ผิดรูปแบบ: " + cfg.baseUrl); }

  return cfg;
}

module.exports = { DEFAULTS, load, merge };
