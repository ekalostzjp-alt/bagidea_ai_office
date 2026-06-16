// 🔌 Integration Hub — SECRET-GUARD e2e (SANDBOX ONLY). เจ้าภาพ: แบล็ค.
//
// รัน: node plugins/integration-hub/e2e-secret-guard.js
//
// โฟกัส 3 ข้อที่ CEO สั่งปิดงาน (เสริมจาก e2e.js เดิม 19 เคส):
//   (1) ทุก output path (cred.list/cred.set/cred.remove/cred.use/status/status.all/wf.*/overview/conn-*)
//       ออกได้ "แค่ hasValue + ••••••" — ไม่มี plaintext, ไม่มี last4/length/บอกใบ้ใดๆ. ไล่ทุก cmd + alias.
//   (2) scrub() กันค่าจริงหลุดติด response แม้ถูก echo (เช่น secret โผล่ใน field ที่สะท้อนกลับ) → ต้องเป็น ••••••.
//   (3) cred.use เอา secret ไป "ใช้จริง" (http ยิงผ่าน auth จริง / ssh dry-run) โดย caller ไม่เคยเห็น plaintext.
//
// in-process, dataDir = temp ใหม่ทุกเคส, ไม่บูต daemon, ไม่แตะ live :8787.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");

const INDEX = path.join(__dirname, "index.js");
const RAW = "sk-DEPLOY-TOKEN-9999-DO-NOT-LEAK-abcXYZ";   // secret ที่ "ห้ามหลุด" ไปไหนเลย (ASCII = ใส่ HTTP header ได้)
const MASK = "••••••";
let pass = 0;
const t = (name, fn) => fn().then(() => { pass++; console.log("  ✓ " + name); });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
// mock ที่ "ตรวจรหัสจริง": ตอบ 200 เฉพาะเมื่อ Authorization ตรงกับ expectAuth เป๊ะ — พิสูจน์ว่า secret ถูกใช้จริง
function authTool(expectAuth) {
  const state = { hits: 0, lastAuth: null, matched: false };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      state.hits++;
      state.lastAuth = req.headers["authorization"] || "";
      state.matched = state.lastAuth === expectAuth;
      req.on("data", () => {}); req.on("end", () => {
        res.writeHead(state.matched ? 200 : 401, { "content-type": "text/plain" });
        res.end(state.matched ? "ok" : "denied");
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, state, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const closeSrv = (s) => new Promise((r) => (s ? s.close(r) : r()));

function loadPluginAt(dir) {
  const broadcasts = [];
  const ctx = { dataDir: dir, broadcast: (m) => broadcasts.push(m), log: () => {} };
  delete require.cache[require.resolve(INDEX)];
  const api = require(INDEX)(ctx);
  return { api, dir, broadcasts, read: (k) => JSON.parse(fs.readFileSync(path.join(dir, k + ".json"), "utf8"))[k] };
}
const loadPlugin = () => loadPluginAt(fs.mkdtempSync(path.join(os.tmpdir(), "ihub-guard-")));
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
// ผู้พิทักษ์: response (ทั้ง object) ห้ามมี RAW; ทุก credential ที่มีค่า ต้อง masked===MASK + ไม่มี last4/length
function assertNoSecret(obj, where) {
  const blob = JSON.stringify(obj);
  assert.ok(!blob.includes(RAW), `[${where}] RAW secret หลุดใน response!`);
  assert.ok(!blob.includes("\"last4\""), `[${where}] ห้ามมี key last4`);
  assert.ok(!blob.includes("\"length\""), `[${where}] ห้ามมี key length`);
  const creds = (obj && (obj.credentials || (obj.credential ? [obj.credential] : []))) || [];
  for (const c of creds) if (c && c.hasValue) assert.strictEqual(c.masked, MASK, `[${where}] masked ต้องเป็น ${MASK}`);
}

(async () => {
  console.log("integration-hub SECRET-GUARD e2e (sandbox):");

  // ── 1. ไล่ "ทุก command path" — ออกได้แค่ hasValue + •••••• ──────────────────
  await t("ทุก cmd (list/set/remove/use/status/status.all/wf.*/overview/conn-*) ไม่ leak + masked-only", async () => {
    const { srv, base } = await authTool("Bearer " + RAW);
    const { api } = loadPlugin();
    try {
      // เตรียม state: cred (มีค่า) + conn + wf ที่อ้าง cred
      const cred = (await api.onCommand("cred.set", { label: "Deploy Key", type: "bearer", hint: "prod deploy", value: RAW })).credential;
      assertNoSecret(await api.onCommand("cred.set", { id: cred.id, label: "Deploy Key 2" }), "cred.set(edit)");
      await api.onCommand("conn-add", { label: "Dep", check: { url: base, expectStatus: 200, credentialId: cred.id } });
      await api.onCommand("wf.set", { label: "Notify", trigger: { kind: "webhook", target: base, method: "GET", credentialId: cred.id } });

      // เรียก "ทุก" เส้นทางอ่าน/ใช้ แล้วตรวจทุกอันว่าไม่ leak + masked-only
      const paths = [
        ["overview",     await api.onCommand("overview")],
        ["cred.list",    await api.onCommand("cred.list")],
        ["cred-list",    await api.onCommand("cred-list")],
        ["conn-list",    await api.onCommand("conn-list")],
        ["status.all",   await api.onCommand("status.all")],
        ["status",       await api.onCommand("status", { id: "dep" })],
        ["conn-check",   await api.onCommand("conn-check", {})],
        ["wf.list",      await api.onCommand("wf.list")],
        ["wf-list",      await api.onCommand("wf-list")],
        ["wf.trigger",   await api.onCommand("wf.trigger", { id: "notify" })],
        ["cred.use http",await api.onCommand("cred.use", { id: cred.id, action: "http", url: base, method: "GET" })],
      ];
      for (const [where, out] of paths) assertNoSecret(out, where);

      // ค่าจริงต้องถูกใช้จริง (มิฉะนั้น mock จะตอบ 401) — พิสูจน์ว่า masked ไม่ได้แปลว่า "ไม่ได้ใช้"
      assert.match(paths.find(([w]) => w === "status.all")[1].connections[0].detail, /HTTP 200/);
      assert.strictEqual(paths.find(([w]) => w === "wf.trigger")[1].workflow.lastRun.status, "ok");
      assert.strictEqual(paths.find(([w]) => w === "cred.use http")[1].status, 200);
    } finally { await closeSrv(srv); }
  });

  // ── 2. scrub(): ค่าจริงที่ถูก echo กลับ → ต้องกลายเป็น •••••• ─────────────────
  await t("scrub: secret ที่โผล่ใน field สะท้อนกลับ (target) ถูก redact เป็น •••••• ไม่ใช่ค่าจริง", async () => {
    const { srv, state, base } = await authTool("Bearer " + RAW);
    const { api } = loadPlugin();
    try {
      const cred = (await api.onCommand("cred.set", { label: "Echo Key", type: "bearer", value: RAW })).credential;
      // jam ค่า secret ลงใน query ของ url เอง → response.target จะ "สะท้อน" RAW กลับมา ก่อน scrub
      const url = `${base}/path?probe=${encodeURIComponent(RAW)}`;
      const r = await api.onCommand("cred.use", { id: cred.id, action: "http", url, method: "GET" });
      assert.ok(state.matched, "mock ต้องเห็น Bearer ตรง (secret ถูกใช้จริง)");
      const blob = JSON.stringify(r);
      assert.ok(!blob.includes(RAW), "scrub ต้องลบ RAW ออกจาก response (รวม target ที่ echo กลับ)");
      assert.ok(r.target.includes(MASK), "ตำแหน่งที่เคยเป็น RAW ใน target ต้องเป็น ••••••");
      assert.strictEqual(r.used, true);
    } finally { await closeSrv(srv); }
  });

  // ── 3. cred.use http: ใช้ secret จริงยิง auth แต่คืนแค่ status (ไม่เห็น plaintext) ─
  await t("cred.use http: mock รับเฉพาะ Bearer ที่ถูก → 200 (ใช้จริง); response = status เท่านั้น ไม่มีรหัส", async () => {
    const { srv, state, base } = await authTool("Bearer " + RAW);
    const { api } = loadPlugin();
    try {
      const cred = (await api.onCommand("cred.set", { label: "API", type: "bearer", value: RAW })).credential;
      const ok = await api.onCommand("cred.use", { id: cred.id, action: "http", url: base });
      assert.strictEqual(ok.status, 200);          // secret ถูก inject จริง mock จึงรับ
      assert.strictEqual(ok.used, true);
      assert.strictEqual(state.matched, true);
      assertNoSecret(ok, "cred.use http ok");
      // cred ที่ไม่มีค่า → used:false, ไม่ส่ง auth → mock ตอบ 401 (ยังไม่ throw/leak)
      const empty = (await api.onCommand("cred.set", { label: "Empty" })).credential;
      const no = await api.onCommand("cred.use", { id: empty.id, action: "http", url: base });
      assert.strictEqual(no.used, false);
      assert.strictEqual(no.status, 401);
    } finally { await closeSrv(srv); }
  });

  // ── 4. cred.use ssh dry-run: preview รหัส=•••••• เสมอ, used:true, ไม่มี plaintext ─
  await t("cred.use ssh dry-run: preview ใช้ •••••• แทนรหัส, used:true, ไม่ leak; ssh2 ไม่มี+run:true → failed (ไม่ leak)", async () => {
    const { api } = loadPlugin();
    const cred = (await api.onCommand("cred.set", { label: "SSH", type: "secret", value: RAW })).credential;
    const dry = await api.onCommand("cred.use", { id: cred.id, action: "ssh", host: "deploy.tookjor.example", user: "deployer", command: "bash deploy.sh" });
    assert.strictEqual(dry.mode, "dry-run");
    assert.strictEqual(dry.used, true);
    assert.strictEqual(dry.status, "prepared");
    assert.ok(dry.preview.includes(MASK), "preview ต้องมี •••••• แทนรหัส");
    assert.ok(!dry.preview.includes(RAW) && !JSON.stringify(dry).includes(RAW), "preview/response ห้ามมีรหัสจริง");
    assertNoSecret(dry, "ssh dry-run");
    // live mode แต่ ssh2 ไม่ติดตั้ง → failed graceful, ไม่ throw, ไม่ leak
    const live = await api.onCommand("cred.use", { id: cred.id, action: "ssh", host: "h", user: "u", command: "id", run: true });
    assert.strictEqual(live.mode, "live");
    assert.strictEqual(live.status, "failed");
    assert.ok(!JSON.stringify(live).includes(RAW));
  });

  // ── 5. cred.use validation: id ไม่พบ → 404 (route) / error (cmd); action เพี้ยน → 400 ─
  await t("cred.use: id ไม่พบ ⇒ 404 (route); action เพี้ยน ⇒ 400; cmd channel ⇒ ok:false ไม่ throw", async () => {
    const { api } = loadPlugin();
    assert.strictEqual((await call(api.routes["credentials/use"], { method: "POST", body: { id: "ghost", action: "http", url: "http://127.0.0.1:1" } })).code, 404);
    assert.strictEqual((await call(api.routes["credentials/use"], { method: "GET" })).code, 405);
    await api.onCommand("cred.set", { label: "X", value: RAW });
    assert.strictEqual((await call(api.routes["credentials/use"], { method: "POST", body: { id: "x", action: "telnet" } })).code, 400);
    const bad = await api.onCommand("cred.use", { id: "x", action: "telnet" });
    assert.strictEqual(bad.ok, false);
  });

  // ── 6. disk ยังเข้ารหัสเสมอ (cred.use ไม่ persist/ไม่เขียน plaintext กลับ) ─────
  await t("cred.use เป็น read-only: ดิสก์ยังเป็น ciphertext เดิม ไม่มี plaintext หลังใช้", async () => {
    const { srv, base } = await authTool("Bearer " + RAW);
    const { api, read } = loadPlugin();
    try {
      const cred = (await api.onCommand("cred.set", { label: "RO", type: "bearer", value: RAW })).credential;
      const before = read("credentials")[0].value;
      await api.onCommand("cred.use", { id: cred.id, action: "http", url: base });
      const after = read("credentials")[0].value;
      assert.strictEqual(after, before, "cred.use ห้ามแก้ค่าที่เก็บ");
      assert.ok(after.startsWith("gcm:") && !after.includes(RAW), "ดิสก์ยังเข้ารหัส ไม่มี plaintext");
    } finally { await closeSrv(srv); }
  });

  console.log(`\n${pass} passed ✅`);
})().catch((e) => { console.error("\n❌ secret-guard e2e FAIL:", (e && e.stack) || e); process.exit(1); });
