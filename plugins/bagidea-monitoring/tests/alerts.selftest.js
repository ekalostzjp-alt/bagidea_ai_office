// tests/alerts.selftest.js — selftest ของ hooks/alerts.js (เจ้าภาพ: แบล็ค).
// รัน:  node plugins/bagidea-monitoring/tests/alerts.selftest.js
//
// ครอบ 2 ชั้น โดย "ไม่บูต daemon ตัวที่ 2":
//   A) unit  — เรียก alerts.analyze(snapshot) ตรงๆ ด้วย snapshot สังเคราะห์
//              → fire / no-fire / fail-open / read-only
//   B) e2e   — รัน aggregator ตัวจริง (lib/aggregate.js) ชี้ baseUrl ไปที่ stub HTTP
//              server (port 0, ใน process เดียว) → ยืนยัน snap.alerts มีค่า + snap.hooks มี "alerts"
const assert = require("assert");
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");

const PLUGIN_DIR = path.join(__dirname, "..");
const alerts = require(path.join(PLUGIN_DIR, "hooks", "alerts.js"));

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log("  ✔ " + name); };
const bad = (name, e) => { fail++; console.log("  ✖ " + name + "  → " + (e && e.message || e)); };
const t = (name, fn) => Promise.resolve().then(fn).then(() => ok(name)).catch((e) => bad(name, e));

const api = { now: 1700000000000, log: () => {} };
const idsOf = (r) => (r.alerts || []).map((a) => a.id);
const find = (r, id) => (r.alerts || []).find((a) => a.id === id);

// snapshot ฐานที่ "สุขภาพดีทุกอย่าง" — แต่ละเทสต์ override เฉพาะ source ที่สนใจ
function healthySnap() {
  return {
    ts: api.now,
    sources: {
      daemon: { ok: true, status: "ok", detail: "ปกติ",
        data: { health: { clients: 2, pendingPerms: 0, wt: 1 }, version: { version: "0.7.16", latest: "0.7.16", updateAvailable: false } } },
      agents: { ok: true, status: "ok", detail: "ปกติ",
        data: { agents: [{ id: "a1", name: "แบล็ค", state: "working", timedOut: false }], claims: [], queue: [], warnings: [],
          counts: { total: 1, working: 1, idle: 0, stuck: 0, timedOut: 0 } } },
      "state-drift": { ok: true, status: "ok", detail: "ปกติ",
        data: { overall: "ok", checks: [{ id: "version-cache", severity: "warn", state: "ok", detail: "" }] } },
    },
    metrics: [], alerts: [], anomalies: [], health: "ok",
  };
}

async function unitTests() {
  console.log("A) unit — alerts.analyze ตรงๆ");

  // ── NO-FIRE ────────────────────────────────────────────────────────────────
  await t("no-fire: ทุกอย่างปกติ → 0 alert", async () => {
    const r = await alerts.analyze(healthySnap(), api);
    assert.deepStrictEqual(r.alerts, []);
  });

  await t("no-fire: source ถูกปิด (ไม่มี key) → 0 alert", async () => {
    const r = await alerts.analyze({ ts: api.now, sources: {}, metrics: [], alerts: [] }, api);
    assert.deepStrictEqual(r.alerts, []);
  });

  // ── FIRE: daemon ─────────────────────────────────────────────────────────────
  await t("fire: daemon down → daemon-down (crit)", async () => {
    const s = healthySnap();
    s.sources.daemon = { ok: false, status: "down", detail: "GET /health ไม่ตอบ", data: { health: null, version: null } };
    const r = await alerts.analyze(s, api);
    const a = find(r, "daemon-down");
    assert.ok(a, "ต้องมี daemon-down"); assert.strictEqual(a.severity, "crit"); assert.strictEqual(a.ts, api.now);
  });

  await t("fire: daemon down → ไม่เด้ง update/perm ซ้อน (down กลบหมด)", async () => {
    const s = healthySnap();
    s.sources.daemon = { ok: false, status: "down", detail: "x", data: { health: { pendingPerms: 5 }, version: { updateAvailable: true } } };
    const r = await alerts.analyze(s, api);
    assert.deepStrictEqual(idsOf(r), ["daemon-down"]);
  });

  await t("fire: updateAvailable → daemon-update (warn)", async () => {
    const s = healthySnap();
    s.sources.daemon.data.version = { version: "0.7.15", latest: "0.7.16", updateAvailable: true };
    const r = await alerts.analyze(s, api);
    const a = find(r, "daemon-update");
    assert.ok(a); assert.strictEqual(a.severity, "warn"); assert.ok(/0\.7\.16/.test(a.detail));
  });

  await t("fire: pendingPerms>0 → daemon-pending-perms (warn)", async () => {
    const s = healthySnap();
    s.sources.daemon.data.health.pendingPerms = 3;
    const r = await alerts.analyze(s, api);
    const a = find(r, "daemon-pending-perms");
    assert.ok(a); assert.strictEqual(a.severity, "warn"); assert.ok(/3/.test(a.title));
  });

  // ── FIRE: agents ─────────────────────────────────────────────────────────────
  await t("fire: stuck>0 → agents-stuck (crit) + ชื่อ agent", async () => {
    const s = healthySnap();
    s.sources.agents.data.agents = [{ id: "a1", name: "มิสเตอร์ N", state: "stuck", timedOut: false }];
    s.sources.agents.data.counts = { total: 1, working: 0, idle: 0, stuck: 1, timedOut: 0 };
    const r = await alerts.analyze(s, api);
    const a = find(r, "agents-stuck");
    assert.ok(a); assert.strictEqual(a.severity, "crit"); assert.ok(/มิสเตอร์ N/.test(a.detail));
  });

  await t("fire: timedOut → agent-timeout:<id> (crit) ราย agent", async () => {
    const s = healthySnap();
    s.sources.agents.data.agents = [
      { id: "a1", name: "X", state: "working", timedOut: true, project: "bagidea" },
      { id: "a2", name: "Y", state: "working", timedOut: true },
    ];
    s.sources.agents.data.counts.timedOut = 2;
    const r = await alerts.analyze(s, api);
    assert.ok(find(r, "agent-timeout:a1")); assert.ok(find(r, "agent-timeout:a2"));
    assert.ok(/โปรเจค bagidea/.test(find(r, "agent-timeout:a1").detail));
    assert.strictEqual(find(r, "agent-timeout:a2").severity, "crit");
  });

  await t("fire: collision block → agents-collision-block (crit)", async () => {
    const s = healthySnap();
    s.sources.agents.data.warnings = [{ type: "x", severity: "block" }, { type: "y", severity: "warn" }];
    const r = await alerts.analyze(s, api);
    const a = find(r, "agents-collision-block");
    assert.ok(a); assert.strictEqual(a.severity, "crit");
  });

  await t("no-fire: warn-collision อย่างเดียว ไม่เด้ง block", async () => {
    const s = healthySnap();
    s.sources.agents.data.warnings = [{ type: "y", severity: "warn" }];
    const r = await alerts.analyze(s, api);
    assert.ok(!find(r, "agents-collision-block"));
  });

  await t("fire: agents source down → source-down:agents (warn)", async () => {
    const s = healthySnap();
    s.sources.agents = { ok: false, status: "down", detail: "agent-status ไม่ตอบ", data: null };
    const r = await alerts.analyze(s, api);
    const a = find(r, "source-down:agents");
    assert.ok(a); assert.strictEqual(a.severity, "warn");
  });

  // ── FIRE: state-drift ────────────────────────────────────────────────────────
  await t("fire: drift crit/warn → drift:<id> ตาม severity", async () => {
    const s = healthySnap();
    s.sources["state-drift"].data = { overall: "drift", checks: [
      { id: "version-cache", severity: "crit", state: "drift", detail: "cache ค้าง" },
      { id: "overlay-stale", severity: "warn", state: "drift", detail: "overlay เก่า" },
      { id: "panel-collapse", severity: "warn", state: "ok", detail: "" },
    ] };
    const r = await alerts.analyze(s, api);
    assert.strictEqual(find(r, "drift:version-cache").severity, "crit");
    assert.strictEqual(find(r, "drift:overlay-stale").severity, "warn");
    assert.ok(!find(r, "drift:panel-collapse"), "check state=ok ห้ามเด้ง");
  });

  await t("fire: state-drift source down → source-down:state-drift (warn)", async () => {
    const s = healthySnap();
    s.sources["state-drift"] = { ok: false, status: "down", detail: "ไม่ตอบ", data: null };
    const r = await alerts.analyze(s, api);
    assert.ok(find(r, "source-down:state-drift"));
  });

  // ── FAIL-OPEN ────────────────────────────────────────────────────────────────
  await t("fail-open: snapshot ว่าง/พัง → ไม่ throw, คืน {alerts:[]}", async () => {
    for (const junk of [undefined, null, {}, { sources: null }, { sources: { daemon: null } }, { sources: { agents: "x" } }]) {
      const r = await alerts.analyze(junk, api);
      assert.ok(r && Array.isArray(r.alerts), "ต้องคืน {alerts:[]} เสมอ");
    }
  });

  await t("fail-open: data รูปแปลก (agents=number, checks=string) → ไม่ throw", async () => {
    const s = healthySnap();
    s.sources.agents.data = { agents: 123, counts: null, warnings: "nope" };
    s.sources["state-drift"].data = { checks: "broken" };
    const r = await alerts.analyze(s, api);
    assert.ok(Array.isArray(r.alerts));
  });

  await t("read-only: ไม่ mutate snapshot ที่รับมา", async () => {
    const s = healthySnap();
    s.sources.daemon.data.version.updateAvailable = true;   // ให้มี alert จริง
    const before = JSON.stringify(s);
    await alerts.analyze(s, api);
    assert.strictEqual(JSON.stringify(s), before, "snapshot ต้องไม่ถูกแก้");
  });
}

// ── B) e2e ผ่าน aggregator จริง + stub server (ไม่บูต daemon ตัวที่ 2) ──────────
function makeStub(responses) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reply = (obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.method === "GET" && req.url === "/health") return reply(responses.health);
      if (req.method === "GET" && req.url === "/version") return reply(responses.version);
      if (req.method === "POST" && req.url === "/plugin/agent-status/cmd") return reply(responses.agents);
      if (req.method === "POST" && req.url === "/plugin/daemon-state-monitor/cmd") return reply(responses.drift);
      res.writeHead(404); res.end("{}");
    });
  });
  return server;
}

async function e2eTests() {
  console.log("B) e2e — aggregator จริง ผ่าน stub server (no 2nd daemon)");
  const { makeAggregator } = require(path.join(PLUGIN_DIR, "lib", "aggregate.js"));
  const { makeClient } = require(path.join(PLUGIN_DIR, "lib", "httpc.js"));

  // temp dataDir แยก (กัน config.load ไปแตะ data/ จริงของ plugin)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bagmon-alerts-"));

  async function runWith(responses) {
    const server = makeStub(responses);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const cfg = {
      baseUrl: "http://127.0.0.1:" + port, timeoutMs: 1500,
      sources: { daemon: true, agents: true, "state-drift": true },
      endpoints: { health: "/health", version: "/version",
        agentStatus: { plugin: "agent-status", cmd: "status" },
        stateDrift: { plugin: "daemon-state-monitor", cmd: "health" } },
    };
    const agg = makeAggregator({
      sourcesDir: path.join(PLUGIN_DIR, "sources"),
      hooksDir: path.join(PLUGIN_DIR, "hooks"),
      makeClient, getCfg: () => cfg, log: () => {},
    });
    try { return await agg.snapshot(Date.now()); }
    finally { await new Promise((r) => server.close(r)); }
  }

  const healthyResp = {
    health: { clients: 1, pendingPerms: 0, wt: 1 },
    version: { version: "0.7.16", latest: "0.7.16", updateAvailable: false },
    agents: { ok: true, agents: [{ id: "a1", name: "X", state: "working", timedOut: false }], claims: [], queue: [], warnings: [], liveSource: "up" },
    drift: { ok: true, overall: "ok", checks: [{ id: "version-cache", severity: "warn", state: "ok" }] },
  };
  const problemResp = {
    health: { clients: 1, pendingPerms: 2, wt: 1 },
    version: { version: "0.7.15", latest: "0.7.16", updateAvailable: true },
    agents: { ok: true, liveSource: "up", claims: [], queue: [], warnings: [],
      agents: [{ id: "a1", name: "X", state: "working", timedOut: true, project: "bagidea" }] },
    drift: { ok: true, overall: "drift", checks: [{ id: "version-cache", severity: "crit", state: "drift", detail: "cache ค้าง" }] },
  };

  await t("e2e: snapshot สุขภาพดี → alerts ว่าง + hooks มี 'alerts'", async () => {
    const snap = await runWith(healthyResp);
    assert.ok(Array.isArray(snap.alerts), "alerts ต้องเป็น array");
    assert.deepStrictEqual(snap.alerts, [], "ไม่มีปัญหา = ไม่มี alert");
    assert.ok(snap.hooks.includes("alerts"), "hooks ต้องมี 'alerts'");
  });

  await t("e2e: snapshot มีปัญหา → alerts มีค่า (update+perm+timeout+drift) + hook=alerts + health=crit", async () => {
    const snap = await runWith(problemResp);
    const ids = snap.alerts.map((a) => a.id);
    assert.ok(snap.alerts.length >= 4, "ควรมีหลาย alert, ได้ " + snap.alerts.length);
    for (const id of ["daemon-update", "daemon-pending-perms", "agent-timeout:a1", "drift:version-cache"])
      assert.ok(ids.includes(id), "ขาด alert: " + id + " (ได้ " + ids.join(",") + ")");
    assert.ok(snap.alerts.every((a) => a.hook === "alerts"), "ทุก alert ต้องมี hook=alerts");
    assert.strictEqual(snap.health, "crit", "มี crit alert → health รวม = crit");
  });

  await t("e2e: fail-open — daemon ปลายทางตาย → snapshot ยังคืน + alert daemon-down", async () => {
    // ปลายทาง health คืน body ที่ parse ไม่ได้ → source daemon = down
    const broken = { ...healthyResp };
    const server = http.createServer((req, res) => {
      if (req.url === "/health") { res.writeHead(200); res.end("NOT-JSON"); return; }
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url === "/version") return res.end(JSON.stringify(broken.version));
        if (req.url === "/plugin/agent-status/cmd") return res.end(JSON.stringify(broken.agents));
        return res.end(JSON.stringify(broken.drift));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const cfg = { baseUrl: "http://127.0.0.1:" + port, timeoutMs: 1500,
      sources: { daemon: true, agents: true, "state-drift": true },
      endpoints: { health: "/health", version: "/version",
        agentStatus: { plugin: "agent-status", cmd: "status" }, stateDrift: { plugin: "daemon-state-monitor", cmd: "health" } } };
    const { makeAggregator } = require(path.join(PLUGIN_DIR, "lib", "aggregate.js"));
    const { makeClient } = require(path.join(PLUGIN_DIR, "lib", "httpc.js"));
    const agg = makeAggregator({ sourcesDir: path.join(PLUGIN_DIR, "sources"), hooksDir: path.join(PLUGIN_DIR, "hooks"), makeClient, getCfg: () => cfg, log: () => {} });
    let snap;
    try { snap = await agg.snapshot(Date.now()); } finally { await new Promise((r) => server.close(r)); }
    assert.ok(snap && Array.isArray(snap.alerts), "ต้องได้ snapshot กลับ");
    assert.ok(snap.alerts.some((a) => a.id === "daemon-down"), "ต้องมี daemon-down");
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

(async () => {
  console.log("\n=== alerts.selftest ===");
  await unitTests();
  await e2eTests();
  console.log("\n" + (fail ? "✖ FAIL " : "✔ PASS ") + pass + " ผ่าน / " + fail + " ล้ม\n");
  process.exit(fail ? 1 : 0);
})();
