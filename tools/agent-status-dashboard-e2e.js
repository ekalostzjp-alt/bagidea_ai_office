// e2e: 🛰 Agent Status Dashboard — board endpoint + collision detection.
// รัน: node tools/agent-status-dashboard-e2e.js   (ต้องมี daemon :8787 รันอยู่)
const http = require("http");

const BASE = "http://127.0.0.1:8787";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.error("  ✗ " + m)); if (c) console.log("  ✓ " + m); };

function get(p) {
  return new Promise((res, rej) => {
    http.get(BASE + p, { headers: { "x-bagidea-ui": "1" } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => { try { res({ status: r.statusCode, json: JSON.parse(d) }); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

// จำลอง detectCollisions ของ panel (ตรงตาม panel.html) — ยืนยัน logic เดียวกัน
function detect(agents) {
  const g = new Map();
  for (const a of agents) {
    const working = ["working", "busy", "stuck"].includes((a.status || a.state || "idle").toLowerCase());
    if (!working || !a.project) continue;
    const k = a.project.trim().toLowerCase();
    if (!g.has(k)) g.set(k, { project: a.project, ids: [] });
    g.get(k).ids.push(a.agentId);
  }
  return [...g.values()].filter((x) => x.ids.length >= 2)
    .map((x) => ({ project: x.project, n: x.ids.length, level: x.ids.length >= 3 ? "alert" : "warn" }));
}

(async () => {
  console.log("🛰 Agent Status Dashboard e2e\n");
  const r = await get("/plugin/agent-status-dashboard/board");
  ok(r.status === 200, "GET /board → 200");
  ok(Array.isArray(r.json.agents), "payload มี agents[]");
  ok(r.json.agents.every((a) => a.agentId && a.status), "ทุก row มี agentId+status");

  const idle = r.json.agents.filter((a) => a.status === "idle");
  ok(idle.every((a) => a.project == null && a.task == null), "idle ⇒ project/task = null");

  const cols = detect(r.json.agents);
  ok(cols.length >= 1, "ตรวจเจอ collision อย่างน้อย 1 (panel logic)");
  ok(cols.some((c) => c.level === "warn"), "มี collision ระดับ warn (2 agent = ส้ม)");
  ok(cols.some((c) => c.level === "alert"), "มี collision ระดับ alert (≥3 agent = แดง)");

  // ไม่มี false-positive: โปรเจคที่มี agent เดียวต้องไม่ขึ้น collision
  const single = r.json.agents.filter((a) =>
    a.status !== "idle" && r.json.agents.filter((b) => b.project === a.project).length === 1);
  ok(single.every((a) => !cols.find((c) => c.project === a.project)), "agent เดี่ยวไม่ถูกนับเป็น collision");

  console.log(`\n${fail ? "❌" : "✅"} pass ${pass} / fail ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("e2e error:", e.message); process.exit(1); });
