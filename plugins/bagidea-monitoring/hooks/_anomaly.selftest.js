// _anomaly.selftest.js — sandbox selftest ของ hooks/anomaly.js (เลนน้องไวท์).
// ขึ้นต้น "_" → aggregator loader ข้ามไฟล์นี้ (ไม่โหลดเป็น hook).
//
// PURE: hook ไม่ยิง network เลย (analyze รับ snapshot สำเร็จรูป) → ไม่ต้องบูต daemon/stub OEP_PORT.
// เขียน baseline ลง TEMP dir (ผ่าน env BAGMON_ANOMALY_DATADIR) — ไม่แตะ data/ จริง.
// รัน:  node plugins/bagidea-monitoring/hooks/_anomaly.selftest.js
const os = require("os");
const fs = require("fs");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bagmon-anomaly-"));
process.env.BAGMON_ANOMALY_DATADIR = TMP;   // ต้องตั้ง "ก่อน" require hook (อ่าน env ตอน load)

const hookPath = path.join(__dirname, "anomaly.js");
let hook = require(hookPath);

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.error("  ✗ " + name); } };

// helper: ประกอบ snapshot ขั้นต่ำตาม contract
function snap(metricsObj, agents, ts) {
  const metrics = Object.entries(metricsObj || {}).map(([key, value]) => ({ key, label: key, value, status: "ok", source: "metrics" }));
  return {
    ok: true, ts, metrics,
    sources: { agents: { data: { agents: agents || [] } } },
    alerts: [], anomalies: [], health: "ok",
  };
}
const run = (s) => hook.analyze(s, { now: s.ts, log: () => {}, cfg: {} });

(async () => {
  console.log("[selftest] anomaly.js  tmp=" + TMP);

  // ── 1) WARMUP เงียบ: ป้อนค่าคงที่ < minSamples ไม่ควรมี anomaly ──────────────
  console.log("[1] warmup quiet");
  let t = 1000, quiet = true;
  for (let i = 0; i < 7; i++, t += 5000) {
    const r = await run(snap({ "agents.working": 2, "agents.queue": 0, "daemon.clients": 3 }, [], t));
    if (r.anomalies.length) quiet = false;
  }
  ok("ไม่ flag ระหว่าง warmup (n<minSamples)", quiet);

  // ── 2) DETECT spike: หลัง baseline นิ่ง → working พุ่ง ควรเป็น anomaly ──────────
  console.log("[2] detect spike (constant→jump)");
  // ป้อนค่านิ่งอีกหลายรอบให้พ้น warmup ก่อน
  for (let i = 0; i < 6; i++, t += 5000) await run(snap({ "agents.working": 2, "agents.queue": 0, "daemon.clients": 3 }, [], t));
  const spike = await run(snap({ "agents.working": 9, "agents.queue": 0, "daemon.clients": 3 }, [], t)); t += 5000;
  const aw = spike.anomalies.find((a) => a.key === "agents.working");
  ok("จับ spike agents.working ได้", !!aw);
  ok("anomaly มี field ครบ {id,key,observed,expected,severity,ts}", !!aw && aw.id && aw.key && aw.observed === 9 && aw.expected != null && aw.severity && aw.ts === t - 5000);
  ok("severity เป็น warn/crit", !!aw && (aw.severity === "warn" || aw.severity === "crit"));
  ok("ไม่ flag metric ที่นิ่ง (daemon.clients)", !spike.anomalies.some((a) => a.key === "daemon.clients"));

  // ── 3) PER-AGENT cpu/mem เกิน baseline ────────────────────────────────────
  console.log("[3] per-agent cpu spike");
  const ag = (cpu) => [{ id: "white", name: "ไวท์", project: "p1", cpu, mem: 20 }];
  for (let i = 0; i < 10; i++, t += 5000) await run(snap({}, ag(10), t));   // baseline cpu≈10
  const cpuSpike = await run(snap({}, ag(85), t)); t += 5000;
  const ac = cpuSpike.anomalies.find((a) => a.key === "agent.cpu" && a.agent === "white");
  ok("จับ cpu agent พุ่ง (10→85) ได้", !!ac);
  ok("anomaly per-agent แนบ agent/project", !!ac && ac.agent === "white" && ac.project === "p1");

  // ── 4) TREND: queue ไต่ขึ้นต่อเนื่องทุก poll ───────────────────────────────
  console.log("[4] trend (monotonic growth)");
  hook._reset(); fs.rmSync(path.join(TMP, "anomaly-baseline.json"), { force: true });
  let t2 = 5000;
  // warmup ให้นิ่งก่อน แล้วค่อยไต่ขึ้นทีละ 1 ให้ครบ ring
  for (let i = 0; i < 9; i++, t2 += 5000) await run(snap({ "agents.queue": 0 }, [], t2));
  let trendHit = null;
  for (let q = 1; q <= 6 && !trendHit; q++, t2 += 5000) {
    const r = await run(snap({ "agents.queue": q }, [], t2));
    trendHit = r.anomalies.find((a) => a.key === "agents.queue");
  }
  ok("จับ trend/spike ของ queue ที่ไต่ขึ้นได้", !!trendHit);

  // ── 5) PERSISTENCE: baseline เขียน atomic เป็น JSON valid + reload ได้ ─────────
  // (ใช้ ts เป็น epoch-scale คงเส้นคงวา เพื่อให้ prune ไม่ลบ series ระหว่างเทสต์)
  console.log("[5] persistence + reload");
  hook._reset(); fs.rmSync(path.join(TMP, "anomaly-baseline.json"), { force: true });
  const baseFile = path.join(TMP, "anomaly-baseline.json");
  let t3 = 1700000000000;                                  // epoch ms จริงๆ
  for (let i = 0; i < 10; i++, t3 += 5000) await run(snap({ "agents.queue": 3 }, [], t3));
  ok("baseline file ถูกเขียน", fs.existsSync(baseFile));
  let parsed = null; try { parsed = JSON.parse(fs.readFileSync(baseFile, "utf8")); } catch {}
  ok("baseline เป็น JSON valid มี series", !!parsed && !!parsed.series);
  ok("ไม่มีไฟล์ .tmp ตกค้าง", !fs.readdirSync(TMP).some((f) => f.includes(".tmp")));
  const seriesCount = parsed ? Object.keys(parsed.series).length : 0;
  ok("series ถูก persist (" + seriesCount + " series)", seriesCount > 0);
  // reload: ล้าง require cache + STATE → ต้องโหลด baseline เดิมจาก disk (ไม่ warmup ใหม่)
  delete require.cache[require.resolve(hookPath)];
  hook = require(hookPath);
  const reSpike = await run(snap({ "agents.queue": 99 }, [], t3 + 5000));
  ok("หลัง reload baseline ยังอยู่ (จับ spike ทันทีไม่ต้อง warmup ใหม่)", reSpike.anomalies.some((a) => a.key === "agents.queue"));

  // ── 6) FAIL-OPEN: snapshot พัง/ว่าง ต้องไม่ throw และคืน anomalies:[] ──────────
  // เรียก analyze ตรงๆ (ไม่ผ่าน helper run() ที่ deref s.ts) เพื่อทดสอบ hook ล้วนๆ
  console.log("[6] fail-open on junk input");
  const api = { now: t3, log: () => {}, cfg: {} };
  let threw = false, res;
  try {
    res = await hook.analyze({}, api);                       // ไม่มี metrics/sources
    await hook.analyze(null, api);                           // null ทั้งก้อน
    await hook.analyze({ metrics: "ไม่ใช่ array", sources: null }, api); // ชนิดผิด
    res = await hook.analyze(undefined, undefined);          // api ก็หาย
  } catch (e) { threw = true; }
  ok("ไม่ throw กับ input พัง/หาย", !threw);
  ok("คืน { anomalies: [] } เสมอ", res && Array.isArray(res.anomalies));

  // ── cleanup ───────────────────────────────────────────────────────────────
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  console.log("\n[selftest] pass=" + pass + " fail=" + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("selftest crashed:", e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
