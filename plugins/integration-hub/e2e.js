// 🔌 Integration Hub — e2e (SANDBOX ONLY). เจ้าภาพ: แบล็ค.  ยึด CONTRACT.md.
//
// รัน: node plugins/integration-hub/e2e.js
//
// ทดสอบ index.js (backend จริง) แบบ in-process — ไม่บูต daemon, ไม่แตะ live :8787:
//   • dataDir = temp dir ใหม่ทุกเคส
//   • external tool = fake http server บน ephemeral port (จองพอร์ตเอง กัน reuse race)
//   • endpoint ที่ "ล่ม" = พอร์ตว่างที่ไม่มีใครฟัง → ECONNREFUSED
//
// ครอบคลุม: masking §3.1+CEO (placeholder คงที่ "••••••" ไม่มี last4/length, ไม่ leak value),
// secret at-rest AES-256-GCM (disk ไม่มี plaintext, encrypt→decrypt roundtrip, migration จาก plaintext เก่า),
// upsert keep-value, credentials/connections/workflows CRUD + validation (400), connCheck ok/down/unknown +
// Bearer inject + fail-open (ไม่ throw/500), expectStatus 0=2xx, wfRun webhook/connection-check/
// command fail-open + lastRun shape, overview, route layer (GET/POST/405/404/bad-json), persist.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");

const INDEX = path.join(__dirname, "index.js");
const RAW = "sk-SUPERSECRET-VALUE-9999";   // ค่า secret ที่ "ห้ามหลุด" ไปไหน
const MASK = "••••••";                      // placeholder คงที่ (ต้องตรงกับ index.js)
let pass = 0;
const t = (name, fn) => fn().then(() => { pass++; console.log("  ✓ " + name); });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function fakeTool({ code = 200 } = {}) {
  const state = { last: null, hits: 0 };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        state.hits++;
        state.last = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
        res.writeHead(code, { "content-type": "text/plain" }); res.end("ok");
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, state, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const closeSrv = (s) => new Promise((r) => (s ? s.close(r) : r()));

function loadPluginAt(dir, ctxExtra = {}) {
  const broadcasts = [];
  const ctx = { dataDir: dir, broadcast: (m) => broadcasts.push(m), log: () => {}, ...ctxExtra };
  delete require.cache[require.resolve(INDEX)];
  const api = require(INDEX)(ctx);
  return {
    api, ctx, dir, broadcasts,
    read: (k) => JSON.parse(fs.readFileSync(path.join(dir, k + ".json"), "utf8"))[k],
  };
}
function loadPlugin(ctxExtra = {}) {
  return loadPluginAt(fs.mkdtempSync(path.join(os.tmpdir(), "ihub-e2e-")), ctxExtra);
}
function call(route, { method = "GET", body } = {}) {
  return new Promise((resolve) => {
    const req = { method, _body: body == null ? "" : (typeof body === "string" ? body : JSON.stringify(body)) };
    const res = {
      _code: 0, _json: null,
      writeHead(code) { this._code = code; return this; },
      end(s) { try { this._json = JSON.parse(s); } catch { this._json = s; } resolve({ code: this._code, json: this._json }); },
    };
    route(req, res, { readBody: (rq, cb) => cb(rq._body) });
  });
}
const noLeak = (obj) => assert.ok(!JSON.stringify(obj).includes(RAW), "RAW secret หลุดใน response!");

(async () => {
  console.log("integration-hub e2e (sandbox, CONTRACT):");

  // ── 1. cred upsert + masking (placeholder คงที่) + encrypt-at-rest + no leak ──
  await t("cred-add: masked=placeholder คงที่, ไม่มี last4/length, ไม่ leak value, ดิสก์เข้ารหัส", async () => {
    const { api, read, broadcasts } = loadPlugin();
    const r = await api.onCommand("cred-add", { label: "OpenAI Prod", type: "api_key", hint: "prod", value: RAW });
    assert.strictEqual(r.ok, true);
    const c = r.credential;
    assert.strictEqual(c.id, "openai-prod");
    assert.strictEqual(c.hasValue, true);
    assert.strictEqual(c.masked, MASK);
    assert.ok(!("last4" in c), "response ห้ามมี last4 (บอกใบ้ตัวท้าย)");
    assert.ok(!("length" in c), "response ห้ามมี length (บอกใบ้ความยาว)");
    assert.ok(!("value" in c), "ผลลัพธ์ห้ามมี field value");
    noLeak(r);
    const disk = read("credentials")[0].value;
    assert.ok(disk.startsWith("gcm:"), "ดิสก์ต้องเป็น ciphertext (gcm:)");
    assert.ok(!disk.includes(RAW), "ดิสก์ห้ามมี plaintext secret");
    assert.ok(broadcasts.length >= 1);
  });

  // ── 2. mask edge cases — placeholder คงที่ไม่ผูกความยาว; ไม่มีค่า → masked:'' ──
  await t("mask: ค่าสั้น/ยาว → masked เท่ากันเสมอ (ไม่บอกใบ้ len); ไม่มี value → masked:'' hasValue:false", async () => {
    const { api } = loadPlugin();
    const short = (await api.onCommand("cred-add", { label: "s", value: "ab" })).credential;
    const long = (await api.onCommand("cred-add", { label: "l", value: "x".repeat(120) })).credential;
    assert.strictEqual(short.masked, MASK); assert.strictEqual(long.masked, MASK);   // 2 ตัว vs 120 ตัว → เท่ากัน
    assert.ok(!("last4" in short) && !("length" in short));
    const none = (await api.onCommand("cred-add", { label: "n" })).credential;
    assert.strictEqual(none.masked, ""); assert.strictEqual(none.hasValue, false);
  });

  // ── 3. upsert: omit value = คงเดิม; ส่ง = เปลี่ยน; แก้ label ────────────────
  await t("cred edit: omit value ⇒ คง ciphertext เดิม, ส่ง value ⇒ เปลี่ยน, label อัปเดต", async () => {
    const { api, read } = loadPlugin();
    const c = (await api.onCommand("cred-add", { label: "A", value: "first-1234" })).credential;
    const enc1 = read("credentials")[0].value;
    assert.ok(enc1.startsWith("gcm:") && !enc1.includes("first-1234"));
    await api.onCommand("cred-add", { id: c.id, label: "A-renamed" });        // ไม่ส่ง value
    assert.strictEqual(read("credentials")[0].value, enc1, "ไม่ส่ง value ⇒ ciphertext เดิมไม่ถูกแตะ");
    assert.strictEqual(read("credentials")[0].label, "A-renamed");
    await api.onCommand("cred-add", { id: c.id, label: "A-renamed", value: "second-5678" });
    const enc2 = read("credentials")[0].value;
    assert.notStrictEqual(enc2, enc1, "ส่ง value ใหม่ ⇒ ciphertext เปลี่ยน");
    assert.ok(enc2.startsWith("gcm:") && !enc2.includes("second-5678"));
  });

  // ── 3b. project binding + description: เก็บ/แก้/ล้าง, ออก UI ได้ (non-secret), ไม่กระทบ mask ──
  await t("cred project+description: set/edit/clear, ออก public, persist, ไม่ leak", async () => {
    const { api, read } = loadPlugin();
    const r = await api.onCommand("cred.set", {
      label: "GPT key", type: "api_key", value: RAW,
      project: "p1781069462905", description: "เรียก GPT-4 ในฟีเจอร์แปลภาษาของ momo",
    });
    const c = r.credential;
    assert.strictEqual(c.project, "p1781069462905");
    assert.strictEqual(c.description, "เรียก GPT-4 ในฟีเจอร์แปลภาษาของ momo");
    assert.strictEqual(c.masked, MASK);                 // มี 2 field ใหม่ ไม่ทำ mask พัง
    assert.ok(!("value" in c));
    // persist ลงดิสก์ (non-secret อยู่ plaintext ได้, secret ยังเข้ารหัส)
    const disk = read("credentials")[0];
    assert.strictEqual(disk.project, "p1781069462905");
    assert.ok(disk.value.startsWith("gcm:") && !disk.value.includes(RAW));
    // แก้: เปลี่ยน project, ล้าง description (ส่ง "" ⇒ ล้างได้ ต่างจาก hint ที่ reqStr)
    const e = (await api.onCommand("cred.set", { id: c.id, label: "GPT key", project: "p1781139305599", description: "" })).credential;
    assert.strictEqual(e.project, "p1781139305599");
    assert.strictEqual(e.description, "");
    // cred.list ออก field ใหม่ครบ และไม่ leak ค่า secret
    const pub = (await api.onCommand("cred.list")).credentials[0];
    assert.strictEqual(pub.project, "p1781139305599");
    assert.ok("description" in pub);
    noLeak(await api.onCommand("cred.list"));
  });

  // ── 3c. description ยาวเกิน 500 ⇒ 400 (validation) ───────────────────────────
  await t("cred description เกิน 500 ตัว ⇒ error (ไม่บันทึก)", async () => {
    const { api } = loadPlugin();
    const r = await api.onCommand("cred.set", { label: "x", description: "ก".repeat(501) });
    assert.strictEqual(r.ok, false);
    assert.ok(/description/.test(r.error || ""));
  });

  // ── 4. cred-list ไม่ leak + delete removed 0|1 ──────────────────────────────
  await t("cred-list ไม่ leak; credentials/delete ⇒ removed 1 แล้ว 0", async () => {
    const { api } = loadPlugin();
    const c = (await api.onCommand("cred-add", { label: "A", value: RAW })).credential;
    noLeak(await api.onCommand("cred-list"));
    assert.deepStrictEqual(await api.onCommand("cred-remove", { id: c.id }), { ok: true, removed: 1 });
    assert.deepStrictEqual(await api.onCommand("cred-remove", { id: c.id }), { ok: true, removed: 0 });
  });

  // ── 5. validation ⇒ 400 (ผ่าน route) / error (ผ่าน cmd) ─────────────────────
  await t("validate: label ว่าง, type เพี้ยน, check.url ไม่ใช่ http(s) ⇒ 400", async () => {
    const { api } = loadPlugin();
    assert.strictEqual((await call(api.routes.credentials, { method: "POST", body: { label: "" } })).code, 400);
    assert.strictEqual((await api.onCommand("cred-add", { label: "a", type: "magic" })).ok, false);
    assert.strictEqual((await call(api.routes.connections, { method: "POST", body: { label: "x", check: { url: "ftp://h" } } })).code, 400);
    assert.strictEqual((await call(api.routes.credentials, { method: "POST", body: "{bad json" })).code, 400);
  });

  // ── 6. connCheck: ok + Bearer inject + ไม่ leak ─────────────────────────────
  await t("conn-check: 200+expect200 ⇒ ok, แนบ Bearer จาก credential, ไม่ leak value", async () => {
    const { srv, state, base } = await fakeTool({ code: 200 });
    const { api, read } = loadPlugin();
    try {
      const cred = (await api.onCommand("cred-add", { label: "key", type: "bearer", value: RAW })).credential;
      await api.onCommand("conn-add", { label: "API", check: { url: base, method: "GET", expectStatus: 200, credentialId: cred.id } });
      const r = await api.onCommand("conn-check", {});
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.connections[0].status, "ok");
      assert.match(r.connections[0].detail, /HTTP 200/);
      assert.ok(Number.isFinite(r.connections[0].lastChecked));
      assert.strictEqual(state.last.headers["authorization"], "Bearer " + RAW);   // inject จริง
      noLeak(r);
      assert.strictEqual(read("connections")[0].status, "ok");                     // persist
    } finally { await closeSrv(srv); }
  });

  // ── 7. connCheck: down (mismatch) / down (port ปิด) / unknown (ไม่มี check) — fail-open ─
  await t("conn-check: status mismatch ⇒ down; port ปิด ⇒ down(ไม่ throw); ไม่มี check ⇒ unknown", async () => {
    const { srv, base } = await fakeTool({ code: 500 });
    const { api } = loadPlugin();
    try {
      await api.onCommand("conn-add", { label: "mismatch", check: { url: base, expectStatus: 200 } });
      const r1 = await api.onCommand("conn-check", {});
      assert.strictEqual(r1.connections[0].status, "down");
    } finally { await closeSrv(srv); }
    const dead = await freePort();
    await api.onCommand("conn-add", { label: "dead", check: { url: `http://127.0.0.1:${dead}`, expectStatus: 0, timeoutMs: 1000 } });
    await api.onCommand("conn-add", { label: "nocheck" });   // check:null ⇒ unknown
    const r2 = await api.onCommand("conn-check", {});
    assert.strictEqual(r2.ok, true);                          // fail-open: คำสั่งสำเร็จ
    const byLabel = Object.fromEntries(r2.connections.map((c) => [c.label, c.status]));
    assert.strictEqual(byLabel["dead"], "down");
    assert.strictEqual(byLabel["nocheck"], "unknown");
  });

  // ── 8. expectStatus 0 ⇒ ยอมรับ 2xx ใดๆ ──────────────────────────────────────
  await t("conn-check: expectStatus 0 ⇒ 2xx ใดๆ = ok", async () => {
    const { srv, base } = await fakeTool({ code: 204 });
    const { api } = loadPlugin();
    try {
      await api.onCommand("conn-add", { label: "any2xx", check: { url: base, expectStatus: 0 } });
      assert.strictEqual((await api.onCommand("conn-check", {})).connections[0].status, "ok");
    } finally { await closeSrv(srv); }
  });

  // ── 9. connCheck id ไม่พบ ⇒ 404 (route) ─────────────────────────────────────
  await t("connections/check id ไม่พบ ⇒ 404", async () => {
    const { api } = loadPlugin();
    assert.strictEqual((await call(api.routes["connections/check"], { method: "POST", body: { id: "ghost" } })).code, 404);
  });

  // ── 10. wfRun webhook: ok + Bearer inject + lastRun shape ───────────────────
  await t("wf-run webhook: 200 ⇒ lastRun.status ok + Bearer inject + shape {at,status,detail}", async () => {
    const { srv, state, base } = await fakeTool({ code: 200 });
    const { api, read } = loadPlugin();
    try {
      const cred = (await api.onCommand("cred-add", { label: "hook", type: "webhook", value: RAW })).credential;
      const w = (await api.onCommand("wf-add", { label: "Notify", trigger: { kind: "webhook", target: base, method: "POST", credentialId: cred.id } })).workflow;
      const r = await api.onCommand("wf-run", { id: w.id });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.workflow.lastRun.status, "ok");
      assert.match(r.workflow.lastRun.detail, /HTTP 200/);
      assert.ok(Number.isFinite(r.workflow.lastRun.at));
      assert.strictEqual(state.last.headers["authorization"], "Bearer " + RAW);
      noLeak(r);
      assert.strictEqual(read("workflows")[0].lastRun.status, "ok");
    } finally { await closeSrv(srv); }
  });

  // ── 11. wfRun webhook ล่ม ⇒ failed (fail-open, ไม่ throw) ────────────────────
  await t("wf-run webhook port ปิด ⇒ lastRun.status failed (ไม่ throw)", async () => {
    const dead = await freePort();
    const { api } = loadPlugin();
    const w = (await api.onCommand("wf-add", { label: "Dead", trigger: { kind: "webhook", target: `http://127.0.0.1:${dead}`, method: "POST" } })).workflow;
    const r = await api.onCommand("wf-run", { id: w.id });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.workflow.lastRun.status, "failed");
    assert.ok(r.workflow.lastRun.detail);
  });

  // ── 12. wfRun connection-check kind ──────────────────────────────────────────
  await t("wf-run connection-check: เรียก probe connection แล้วสรุป ok/failed", async () => {
    const { srv, base } = await fakeTool({ code: 200 });
    const { api } = loadPlugin();
    try {
      const conn = (await api.onCommand("conn-add", { label: "dep", check: { url: base, expectStatus: 200 } })).connection;
      const w = (await api.onCommand("wf-add", { label: "ChkDep", trigger: { kind: "connection-check", target: conn.id } })).workflow;
      assert.strictEqual((await api.onCommand("wf-run", { id: w.id })).workflow.lastRun.status, "ok");
    } finally { await closeSrv(srv); }
  });

  // ── 13. wfRun command kind ไม่มี runClaude ⇒ failed (ไม่ throw) ──────────────
  await t("wf-run command: ไม่มี ctx.runClaude ⇒ failed (fail-open)", async () => {
    const { api } = loadPlugin();   // ctx ไม่มี runClaude
    const w = (await api.onCommand("wf-add", { label: "Cmd", trigger: { kind: "command", target: "do something" } })).workflow;
    const r = await api.onCommand("wf-run", { id: w.id });
    assert.strictEqual(r.workflow.lastRun.status, "failed");
  });

  // ── 14. overview shape ───────────────────────────────────────────────────────
  await t("overview: { ok, now, credentials:[masked], connections, workflows } ไม่ leak", async () => {
    const { api } = loadPlugin();
    await api.onCommand("cred-add", { label: "k", value: RAW });
    const o = await api.onCommand("overview");
    for (const k of ["ok", "now", "credentials", "connections", "workflows"]) assert.ok(k in o, "ขาด " + k);
    assert.ok(Number.isFinite(o.now));
    assert.ok(Array.isArray(o.credentials) && Array.isArray(o.connections) && Array.isArray(o.workflows));
    noLeak(o);
  });

  // ── 15. route layer: GET/POST/405 + slash routes + 200 ไม่มี 500 จาก run ────
  await t("route: overview GET, credentials GET/POST, delete POST-only 405, run ไม่ 500", async () => {
    const { api } = loadPlugin();
    assert.strictEqual((await call(api.routes.overview, { method: "GET" })).code, 200);
    assert.strictEqual((await call(api.routes.overview, { method: "POST" })).code, 405);
    const add = await call(api.routes.credentials, { method: "POST", body: { label: "R", value: RAW } });
    assert.strictEqual(add.code, 200); assert.strictEqual(add.json.credential.masked, MASK); noLeak(add.json);
    assert.strictEqual((await call(api.routes["credentials/delete"], { method: "GET" })).code, 405);
    const del = await call(api.routes["credentials/delete"], { method: "POST", body: { id: add.json.credential.id } });
    assert.strictEqual(del.json.removed, 1);
    // workflows/run บน workflow ที่ trigger ล่ม → ยัง 200 (fail-open)
    const w = await call(api.routes.workflows, { method: "POST", body: { label: "W", trigger: { kind: "webhook", target: "http://127.0.0.1:1/x", method: "POST" } } });
    const runRes = await call(api.routes["workflows/run"], { method: "POST", body: { id: w.json.workflow.id } });
    assert.strictEqual(runRes.code, 200);
    assert.strictEqual(runRes.json.workflow.lastRun.status, "failed");
  });

  // ── 16. persist รอด restart ──────────────────────────────────────────────────
  await t("persist: cred/conn/wf คงอยู่หลัง restart (โหลด dataDir เดิมซ้ำ)", async () => {
    const { api, dir } = loadPlugin();
    await api.onCommand("cred-add", { label: "keep", value: "survive-9090" });
    await api.onCommand("conn-add", { label: "ckeep", check: { url: "http://127.0.0.1:9/x" } });
    await api.onCommand("wf-add", { label: "wkeep", trigger: { kind: "webhook", target: "http://127.0.0.1:9/x" } });
    delete require.cache[require.resolve(INDEX)];
    const api2 = require(INDEX)({ dataDir: dir, broadcast: () => {}, log: () => {} });
    assert.strictEqual((await api2.onCommand("cred-list")).credentials[0].masked, MASK);
    assert.strictEqual((await api2.onCommand("overview")).connections[0].label, "ckeep");
    assert.strictEqual((await api2.onCommand("wf-list")).workflows[0].label, "wkeep");
  });

  // ── 17. encrypt→decrypt roundtrip ข้าม reload (decrypt เฉพาะตอนใช้จริง) ──────
  await t("at-rest: ดิสก์เข้ารหัส, reload ใหม่แล้ว Bearer คืน plaintext เดิมได้ (roundtrip)", async () => {
    const { srv, state, base } = await fakeTool({ code: 200 });
    const { api, dir, read } = loadPlugin();
    try {
      await api.onCommand("cred-add", { label: "key", type: "bearer", value: RAW });
      const disk = read("credentials")[0].value;
      assert.ok(disk.startsWith("gcm:") && !disk.includes(RAW), "ดิสก์ต้องเข้ารหัส ไม่มี plaintext");
      // reload จาก dataDir เดิม (ใช้ keyfile เดิม) → decrypt ตอน probe เท่านั้น
      const { api: api2 } = loadPluginAt(dir);
      await api2.onCommand("conn-add", { label: "API", check: { url: base, method: "GET", expectStatus: 200, credentialId: "key" } });
      const r = await api2.onCommand("conn-check", {});
      assert.strictEqual(r.connections[0].status, "ok");
      assert.strictEqual(state.last.headers["authorization"], "Bearer " + RAW);   // decrypt คืนค่าตรงเป๊ะ
      noLeak(r);
    } finally { await closeSrv(srv); }
  });

  // ── 18. migration: plaintext เก่าบนดิสก์ → เข้ารหัสทับอัตโนมัติตอนโหลด ────────
  await t("migration: credentials.json เก่าเป็น plaintext ⇒ โหลดแล้วเข้ารหัสทับ + ยังใช้ได้", async () => {
    const { srv, state, base } = await fakeTool({ code: 200 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ihub-mig-"));
    const legacy = "legacy-PLAINTEXT-7777";
    // จำลองไฟล์เก่า: value เป็น plaintext ดิบ (ก่อนมีการเข้ารหัส)
    fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
      credentials: [{ id: "old", label: "Old", type: "bearer", hint: "", value: legacy, createdAt: 1, updatedAt: 1 }],
    }));
    try {
      const { api, read } = loadPluginAt(dir);   // โหลด = trigger migration
      const disk = read("credentials")[0].value;
      assert.ok(disk.startsWith("gcm:"), "migration ต้องเข้ารหัสทับ");
      assert.ok(!disk.includes(legacy), "ดิสก์ห้ามเหลือ plaintext เดิม");
      assert.strictEqual((await api.onCommand("cred-list")).credentials[0].masked, MASK);
      // ค่าเก่ายังใช้ได้จริง (decrypt คืน plaintext เดิม)
      await api.onCommand("conn-add", { label: "API", check: { url: base, expectStatus: 200, credentialId: "old" } });
      await api.onCommand("conn-check", {});
      assert.strictEqual(state.last.headers["authorization"], "Bearer " + legacy);
    } finally { await closeSrv(srv); }
  });

  // ── 19. mask ไม่รั่วความยาว/4 ตัวท้าย ในทุก output ──────────────────────────
  await t("mask regression: cred-list/overview ไม่มี key last4/length และ masked คงที่ทุกความยาว", async () => {
    const { api } = loadPlugin();
    await api.onCommand("cred-add", { label: "tiny", value: "x" });
    await api.onCommand("cred-add", { label: "huge", value: "y".repeat(200) });
    for (const out of [await api.onCommand("cred-list"), await api.onCommand("overview")]) {
      const blob = JSON.stringify(out);
      assert.ok(!blob.includes("\"last4\""), "ห้ามมี key last4");
      assert.ok(!blob.includes("\"length\""), "ห้ามมี key length");
      for (const c of out.credentials) assert.strictEqual(c.masked, MASK);   // 1 ตัว กับ 200 ตัว → เท่ากัน
    }
  });

  console.log(`\n${pass} passed ✅`);
})().catch((e) => { console.error("\n❌ e2e FAIL:", (e && e.stack) || e); process.exit(1); });
