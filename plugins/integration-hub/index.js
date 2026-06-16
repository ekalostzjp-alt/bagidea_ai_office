// 🔌 Integration Hub — server side. เจ้าภาพ: แบล็ค (Backend).
// Source of truth: ../../workspace/projects/Integration Hub/CONTRACT.md
//
// สามโดเมน เก็บแยกไฟล์ใน ctx.dataDir/ (atomic write: tmp→rename):
//   credentials.json  — secret เข้ารหัส AES-256-GCM (field `value`); ห้ามออก response เด็ดขาด
//                        ออกได้ทาง toPublicCred() ที่มาสก์ด้วย placeholder คงที่ "••••••" เท่านั้น
//   connections.json  — สถานะ external tool (ok|down|unknown) + วิธี probe (check)
//   workflows.json    — trigger (webhook|command|connection-check) + lastRun
//
// ความปลอดภัย (CEO order, hardening §6):
//   • มาสก์เต็มรูปแบบ — placeholder คงที่ "••••••" ห้ามบอกใบ้ความยาว/4 ตัวท้าย/รูปแบบใดๆ.
//   • secret at-rest เข้ารหัส AES-256-GCM; key อยู่นอกไฟล์ credential (env IHUB_SECRET_KEY หรือ keyfile สิทธิ์จำกัด).
//     ไฟล์ storage ห้ามมี plaintext — migration เข้ารหัสทับค่าเก่าอัตโนมัติตอนโหลดครั้งแรก.
//   • decrypt เฉพาะตอน "ใช้จริง" (probe/run) ผ่าน credSecret(); cred.list/overview ไม่ decrypt.
//
// กติกาเหล็ก (CONTRACT §2): route namespaced + method-agnostic, secret ไม่เคยออก UI,
// persist atomic, fail-open (probe/run ล้ม = down/failed ไม่ throw/ไม่ 500), broadcast หลังเปลี่ยน state.
// HTTP: 200 ปกติ · 400 input ผิด · 404 ไม่พบ id · 405 method ผิด · ไม่มี 500 จาก probe/run.
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");

const CRED_TYPES = ["api_key", "bearer", "basic", "oauth", "webhook", "secret"];
const CONN_STATUS = ["ok", "down", "unknown"];
const WF_KINDS = ["webhook", "command", "connection-check"];
const USE_ACTIONS = ["http", "ssh"];     // cred.use — เอา credential ไปยิง action จริง (caller ไม่เห็น plaintext)
const MAX_VALUE = 16 * 1024;   // secret value cap (วัดที่ plaintext ก่อนเข้ารหัส)
const MAX_STR = 2 * 1024;
const HINT_MAX = 200;
const DESC_MAX = 500;          // description — "key นี้ใช้ทำอะไร" (ไม่ใช่ secret)
const PROJ_MAX = 128;          // project id ปลายทางที่ credential ผูกอยู่ (ว่าง = ไม่ผูก)

// placeholder มาสก์คงที่ — เท่ากันทุก secret ที่มีค่า ไม่ผูกกับความยาว/เนื้อหา (ห้ามบอกใบ้)
const MASK = "••••••";
const ENC_PREFIX = "gcm:";          // มาร์คเกอร์ ciphertext (AES-256-GCM) แยกจาก plaintext เก่า
const KEY_ENV = "IHUB_SECRET_KEY";  // 32-byte key เป็น hex(64)/base64 — มาก่อน keyfile ถ้าตั้งไว้

// validation error → HTTP code (probe/run ไม่ใช้ตัวนี้ เพราะต้อง fail-open)
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

module.exports = (ctx) => {
  try { fs.mkdirSync(ctx.dataDir, { recursive: true }); } catch {}
  const FILES = {
    credentials: path.join(ctx.dataDir, "credentials.json"),
    connections: path.join(ctx.dataDir, "connections.json"),
    workflows: path.join(ctx.dataDir, "workflows.json"),
  };
  const KEYFILE = path.join(ctx.dataDir, ".keyfile");   // แยกจาก credentials.json; data/ ถูก gitignore
  const now = () => Date.now();

  // ── secret at-rest: AES-256-GCM ─────────────────────────────────────────────
  // key มาจาก env (production) ถ้าตั้งไว้ ไม่งั้น gen keyfile 32 ไบต์ครั้งเดียว (mode 0600).
  let _key = null;
  function secretKey() {
    if (_key) return _key;
    const env = (process.env[KEY_ENV] || "").trim();
    if (env) {
      const raw = /^[0-9a-fA-F]{64}$/.test(env) ? Buffer.from(env, "hex") : Buffer.from(env, "base64");
      if (raw.length === 32) { _key = raw; return _key; }
    }
    try {
      const buf = Buffer.from(fs.readFileSync(KEYFILE, "utf8").trim(), "hex");
      if (buf.length === 32) { _key = buf; return _key; }
    } catch {}
    _key = crypto.randomBytes(32);
    try { fs.writeFileSync(KEYFILE, _key.toString("hex"), { mode: 0o600 }); fs.chmodSync(KEYFILE, 0o600); } catch {}
    return _key;
  }
  const isEncrypted = (v) => typeof v === "string" && v.startsWith(ENC_PREFIX);
  function encryptValue(plain) {
    if (plain == null || plain === "") return "";              // ค่าว่าง = ไม่เก็บอะไร
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
    const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    return ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");  // iv(12)|tag(16)|ct
  }
  function decryptValue(stored) {
    if (stored == null || stored === "") return "";
    if (!isEncrypted(stored)) return String(stored);            // legacy plaintext (ก่อน migration)
    try {
      const raw = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
      const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch { return ""; }                                      // key ผิด/ไฟล์เสีย → fail-open (ไม่มี secret ใช้)
  }
  // migration: เข้ารหัสค่าเก่าที่ยังเป็น plaintext ทับให้อัตโนมัติ (idempotent — รอบสองเป็น no-op)
  function migratePlaintext() {
    try {
      const arr = readAll("credentials");
      let changed = false;
      for (const c of arr) {
        if (c && typeof c.value === "string" && c.value !== "" && !isEncrypted(c.value)) {
          c.value = encryptValue(c.value); changed = true;
        }
      }
      if (changed) writeAll("credentials", arr);
    } catch {}
  }

  // ── persistence (fail-open read · atomic write) ─────────────────────────────
  function readAll(key) {
    try {
      const o = JSON.parse(fs.readFileSync(FILES[key], "utf8"));
      const arr = o && o[key];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }   // ไฟล์หาย/พัง → array ว่าง (fail-open)
  }
  function writeAll(key, arr) {
    const file = FILES[key];
    const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(tmp, JSON.stringify({ [key]: arr }, null, 2));
    fs.renameSync(tmp, file);   // atomic บน FS เดียวกัน
  }
  function broadcast() {
    try { ctx.broadcast({ type: "plugin.event", plugin: "integration-hub" }, false); } catch {}
  }

  // ── masking (CONTRACT §3.1, CEO order) — secret ไม่เคยออกแบบดิบ และห้ามบอกใบ้ ──
  // ออกได้แค่ hasValue (มี/ไม่มีค่า) + masked เป็น placeholder คงที่. ไม่มี last4/length เด็ดขาด.
  function toPublicCred(c) {
    const hasValue = !!(c.value != null && String(c.value) !== "");
    return {
      id: c.id, label: c.label, type: c.type, hint: c.hint || "",
      description: c.description || "", project: c.project || "",   // non-secret meta (ผูกโปรเจค + คำอธิบาย)
      createdAt: c.createdAt, updatedAt: c.updatedAt,
      hasValue, masked: hasValue ? MASK : "",
    };
  }
  // ใช้ค่าจริง "ภายในเท่านั้น" (probe/run/use) — decrypt ตรงนี้ที่เดียว, ห้าม return ออก response.
  // ถ้าส่ง collector array มา จะเก็บ plaintext ที่ถอดได้ไว้ให้ scrub() กวาดออกจาก response ทีหลัง.
  function credSecret(id, used) {
    if (!id) return null;
    const c = readAll("credentials").find((x) => x.id === id);
    if (!c) return null;
    const v = decryptValue(c.value);
    if (used && v && v.length >= 4) used.push(v);   // defense-in-depth: จำไว้ไป redact
    return v;
  }

  // ── output scrubber (defense-in-depth) ──────────────────────────────────────
  // กันพลาดสุดทาง: ถ้า "ค่าจริง" ที่ถอดมาใช้ใน op นี้ ดันโผล่ใน response (เช่นใน detail/error/echo)
  // ให้แทนด้วย MASK ก่อนส่งออก. `used` = เฉพาะ secret ที่ op นี้ถอดมาใช้จริง (ไม่ใช่ทั้งคลัง) —
  // คงหลักการ "decrypt เฉพาะตอนใช้จริง" ไว้ ไม่ได้ไปไล่ถอดทุกตัวมา match.
  function scrub(obj, used) {
    if (!used || used.length === 0) return obj;
    let s = JSON.stringify(obj);
    for (const sec of used) {
      if (typeof sec !== "string" || sec.length < 4) continue;
      const esc = JSON.stringify(sec).slice(1, -1);    // รูปแบบ string ที่ถูก escape ใน JSON
      if (esc) s = s.split(esc).join(MASK);
      if (sec !== esc) s = s.split(sec).join(MASK);     // เผื่อ raw form (ไม่มี escape char)
    }
    try { return JSON.parse(s); } catch { return obj; }  // ถ้าพังด้วยเหตุใด คืนของเดิม (ยังปลอดภัยกว่า throw)
  }

  // ── helpers ─────────────────────────────────────────────────────────────────
  function asObj(args) {
    if (args && typeof args === "object") return args;
    if (typeof args === "string" && args.trim()) {
      try { const o = JSON.parse(args); if (o && typeof o === "object") return o; } catch {}
    }
    return {};
  }
  function reqStr(v, field, max = MAX_STR) {
    if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `field ${field} จำเป็น`);
    if (v.length > max) throw new HttpError(400, `field ${field} ยาวเกินกำหนด`);
    return v.trim();
  }
  // optional string — null/undefined/ว่าง = "" (อนุญาตให้ "ล้างค่า" ได้ ต่างจาก reqStr ที่ throw)
  function optStr(v, field, max) {
    if (v == null) return "";
    if (typeof v !== "string") throw new HttpError(400, `field ${field} ต้องเป็น string`);
    const t = v.trim();
    if (t.length > max) throw new HttpError(400, `field ${field} ยาวเกินกำหนด`);
    return t;
  }
  function slugify(s) {
    const base = String(s || "").toLowerCase().trim()
      .replace(/[^\w฀-๿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    return base || "item";
  }
  function uniqueId(want, arr) {
    let id = want, n = 1;
    while (arr.some((x) => x.id === id)) id = `${want}-${++n}`;
    return id;
  }
  function checkUrl(u, field) {
    let parsed;
    try { parsed = new URL(u); } catch { throw new HttpError(400, `field ${field} ไม่ใช่ URL ที่ถูกต้อง`); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new HttpError(400, `field ${field} อนุญาตเฉพาะ http/https`);
    return parsed;
  }
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // ── HTTP probe — never throws; คืน {ok2xx,status,ms,detail} ──────────────────
  function httpProbe({ url, method = "GET", headers = {}, body = null, timeoutMs = 8000 }) {
    return new Promise((resolve) => {
      let parsed;
      try { parsed = new URL(url); } catch { return resolve({ status: 0, ms: 0, detail: "bad url" }); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        return resolve({ status: 0, ms: 0, detail: "unsupported protocol" });
      const lib = parsed.protocol === "https:" ? https : http;
      const started = now();
      let done = false;
      const finish = (r) => { if (done) return; done = true; resolve({ ...r, ms: now() - started }); };
      let req;
      try {
        req = lib.request(parsed, { method, headers, timeout: timeoutMs }, (res) => {
          // ดูดทิ้งให้ socket ปิด (ไม่เก็บ body — กัน leak/หน่วง)
          res.on("data", () => {});
          res.on("end", () => finish({ status: res.statusCode, detail: "HTTP " + res.statusCode }));
        });
      } catch (e) { return finish({ status: 0, detail: String(e.message) }); }
      req.on("timeout", () => { try { req.destroy(); } catch {} finish({ status: 0, detail: "timeout" }); });
      req.on("error", (e) => finish({ status: 0, detail: String(e.message) }));
      if (body != null) { try { req.write(body); } catch {} }
      req.end();
    });
  }
  function bearer(credentialId, used) {
    const v = credSecret(credentialId, used);
    return v ? { authorization: "Bearer " + v } : {};
  }

  // ── credentials ──────────────────────────────────────────────────────────────
  function credList() { return { ok: true, credentials: readAll("credentials").map(toPublicCred) }; }

  function credUpsert(a) {
    a = asObj(a);
    const label = reqStr(a.label, "label");
    const type = a.type ? reqStr(a.type, "type", 32) : "api_key";
    if (!CRED_TYPES.includes(type)) throw new HttpError(400, "type ต้องเป็นหนึ่งใน " + CRED_TYPES.join("/"));
    const hint = a.hint == null ? "" : reqStr(a.hint, "hint", HINT_MAX);
    const description = optStr(a.description, "description", DESC_MAX);  // "key นี้ใช้ทำอะไร"
    const project = optStr(a.project, "project", PROJ_MAX);              // โปรเจคปลายทาง (id) ว่าง = ไม่ผูก
    const value = a.value == null ? undefined : reqStr(a.value, "value", MAX_VALUE);

    const arr = readAll("credentials");
    let c;
    if (a.id) {
      c = arr.find((x) => x.id === a.id);
      if (!c) throw new HttpError(404, "ไม่พบ credential id: " + a.id);
      c.label = label; c.type = type; c.hint = hint;
      c.description = description; c.project = project;
      // ไม่ส่ง value = คงค่าเดิม (ciphertext เดิมอยู่แล้ว ไม่ต้องแตะ); ส่ง = เข้ารหัสใหม่ (CONTRACT §3.1)
      if (value !== undefined) c.value = encryptValue(value);
      c.updatedAt = now();
    } else {
      c = {
        id: uniqueId(slugify(label), arr), label, type, hint, description, project,
        value: value === undefined ? "" : encryptValue(value), createdAt: now(), updatedAt: now(),
      };
      arr.push(c);
    }
    writeAll("credentials", arr);
    broadcast();
    return { ok: true, credential: toPublicCred(c) };
  }

  function credDelete(a) {
    a = asObj(a);
    const id = reqStr(a.id, "id", 128);
    const arr = readAll("credentials");
    const i = arr.findIndex((x) => x.id === id);
    if (i < 0) return { ok: true, removed: 0 };
    arr.splice(i, 1);
    writeAll("credentials", arr);
    broadcast();
    return { ok: true, removed: 1 };
  }

  // ── connections ───────────────────────────────────────────────────────────────
  function connList() { return { ok: true, connections: readAll("connections") }; }

  function normCheck(check) {
    if (check == null) return null;
    if (typeof check !== "object") throw new HttpError(400, "check ต้องเป็น object หรือ null");
    const url = reqStr(check.url, "check.url");
    checkUrl(url, "check.url");
    const method = (check.method ? reqStr(check.method, "check.method", 8) : "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method)) throw new HttpError(400, "check.method ต้องเป็น GET|HEAD");
    const expectStatus = Number.isFinite(check.expectStatus) ? check.expectStatus : 200;
    const credentialId = check.credentialId == null ? null : reqStr(check.credentialId, "check.credentialId", 128);
    const timeoutMs = clamp(Number.isFinite(check.timeoutMs) ? check.timeoutMs : 8000, 1000, 30000);
    return { url, method, expectStatus, credentialId, timeoutMs };
  }

  function connUpsert(a) {
    a = asObj(a);
    const label = reqStr(a.label, "label");
    const check = normCheck(a.check);
    const arr = readAll("connections");
    let c;
    if (a.id) {
      c = arr.find((x) => x.id === a.id);
      if (!c) throw new HttpError(404, "ไม่พบ connection id: " + a.id);
      c.label = label; c.check = check;
    } else {
      c = { id: uniqueId(slugify(label), arr), label, status: "unknown", lastChecked: null, detail: "", check };
      arr.push(c);
    }
    writeAll("connections", arr);
    broadcast();
    return { ok: true, connection: c };
  }

  function connDelete(a) {
    a = asObj(a);
    const id = reqStr(a.id, "id", 128);
    const arr = readAll("connections");
    const i = arr.findIndex((x) => x.id === id);
    if (i < 0) return { ok: true, removed: 0 };
    arr.splice(i, 1);
    writeAll("connections", arr);
    broadcast();
    return { ok: true, removed: 1 };
  }

  // TODO(แบล็ค) ✓ — probe จริง, fail-open, เคารพ timeoutMs, แนบ Bearer จาก credential
  async function probeOne(c, used) {
    if (!c.check) { c.status = "unknown"; c.lastChecked = now(); c.detail = "ไม่ได้ตั้ง check"; return c; }
    const headers = bearer(c.check.credentialId, used);
    let r;
    try {
      r = await httpProbe({ url: c.check.url, method: c.check.method, headers, timeoutMs: c.check.timeoutMs });
    } catch (e) { r = { status: 0, ms: 0, detail: String(e && e.message) }; }  // กันสุดทาง — ห้าม throw
    const want = c.check.expectStatus;
    const pass = r.status > 0 && (want === 0 ? (r.status >= 200 && r.status < 300) : r.status === want);
    c.status = pass ? "ok" : "down";
    c.lastChecked = now();
    c.detail = r.status > 0 ? `HTTP ${r.status}${pass ? "" : ` (คาดหวัง ${want === 0 ? "2xx" : want})`}` : (r.detail || "down");
    return c;
  }

  // connCheck(id?) — id ว่าง = เช็คทั้งหมด. fail-open เสมอ.
  async function connCheck(a) {
    a = asObj(a);
    const arr = readAll("connections");
    let targets;
    if (a.id != null && a.id !== "") {
      const c = arr.find((x) => x.id === a.id);
      if (!c) throw new HttpError(404, "ไม่พบ connection id: " + a.id);
      targets = [c];
    } else targets = arr;
    const used = [];
    for (const c of targets) {
      try { await probeOne(c, used); }
      catch (e) { c.status = "down"; c.lastChecked = now(); c.detail = String(e && e.message); }
    }
    try { writeAll("connections", arr); } catch {}
    broadcast();
    return scrub({ ok: true, connections: targets }, used);
  }

  // ── workflows ─────────────────────────────────────────────────────────────────
  function wfList() { return { ok: true, workflows: readAll("workflows") }; }

  function normTrigger(trigger) {
    if (trigger == null) return null;
    if (typeof trigger !== "object") throw new HttpError(400, "trigger ต้องเป็น object หรือ null");
    const kind = reqStr(trigger.kind, "trigger.kind", 32);
    if (!WF_KINDS.includes(kind)) throw new HttpError(400, "trigger.kind ต้องเป็น " + WF_KINDS.join("/"));
    const target = reqStr(trigger.target, "trigger.target");
    const credentialId = trigger.credentialId == null ? null : reqStr(trigger.credentialId, "trigger.credentialId", 128);
    let method = (trigger.method ? reqStr(trigger.method, "trigger.method", 8) : "POST").toUpperCase();
    if (kind === "webhook") {
      checkUrl(target, "trigger.target");
      if (!["POST", "GET"].includes(method)) throw new HttpError(400, "webhook method ต้องเป็น POST|GET");
    }
    return { kind, target, method, credentialId };
  }

  function wfUpsert(a) {
    a = asObj(a);
    const label = reqStr(a.label, "label");
    const trigger = normTrigger(a.trigger);
    const arr = readAll("workflows");
    let w;
    if (a.id) {
      w = arr.find((x) => x.id === a.id);
      if (!w) throw new HttpError(404, "ไม่พบ workflow id: " + a.id);
      w.label = label; w.trigger = trigger;
    } else {
      w = { id: uniqueId(slugify(label), arr), label, trigger, lastRun: { at: null, status: "never", detail: "" } };
      arr.push(w);
    }
    writeAll("workflows", arr);
    broadcast();
    return { ok: true, workflow: w };
  }

  function wfDelete(a) {
    a = asObj(a);
    const id = reqStr(a.id, "id", 128);
    const arr = readAll("workflows");
    const i = arr.findIndex((x) => x.id === id);
    if (i < 0) return { ok: true, removed: 0 };
    arr.splice(i, 1);
    writeAll("workflows", arr);
    broadcast();
    return { ok: true, removed: 1 };
  }

  // TODO(แบล็ค) ✓ — exec จริงตาม trigger.kind, อัปเดต lastRun atomic, fail-open (ล้ม=failed)
  async function execTrigger(w, used) {
    const tg = w.trigger;
    if (!tg) return { status: "failed", detail: "ยังตั้ง trigger ไม่ครบ" };
    try {
      if (tg.kind === "webhook") {
        const headers = { ...bearer(tg.credentialId, used) };
        let body = null;
        if (tg.method === "POST") { headers["content-type"] = "application/json"; body = JSON.stringify({ workflow: w.id, at: now() }); }
        const r = await httpProbe({ url: tg.target, method: tg.method, headers, body, timeoutMs: 20000 });
        const ok = r.status >= 200 && r.status < 300;
        return { status: ok ? "ok" : "failed", detail: r.status > 0 ? "HTTP " + r.status : (r.detail || "failed") };
      }
      if (tg.kind === "connection-check") {
        const arr = readAll("connections");
        const c = arr.find((x) => x.id === tg.target);
        if (!c) return { status: "failed", detail: "ไม่พบ connection: " + tg.target };
        await probeOne(c, used);
        try { writeAll("connections", arr); } catch {}
        return { status: c.status === "ok" ? "ok" : "failed", detail: c.detail || c.status };
      }
      if (tg.kind === "command") {
        if (typeof ctx.runClaude !== "function") return { status: "failed", detail: "command kind ไม่พร้อมใช้ (ไม่มี runClaude)" };
        try { await ctx.runClaude("main", String(tg.target)); return { status: "ok", detail: "dispatched" }; }
        catch (e) { return { status: "failed", detail: String(e && e.message) }; }
      }
      return { status: "failed", detail: "kind ไม่รองรับ" };
    } catch (e) { return { status: "failed", detail: String(e && e.message) }; }  // กันสุดทาง
  }

  async function wfRun(a) {
    a = asObj(a);
    const id = reqStr(a.id, "id", 128);
    const arr = readAll("workflows");
    const w = arr.find((x) => x.id === id);
    if (!w) throw new HttpError(404, "ไม่พบ workflow id: " + id);
    const used = [];
    const res = await execTrigger(w, used);
    w.lastRun = { at: now(), status: res.status, detail: res.detail || "" };
    try { writeAll("workflows", arr); } catch {}
    broadcast();
    return scrub({ ok: true, workflow: w }, used);
  }

  // ── cred.use — เอา credential ไป "ใช้จริง" ยิง action โดย caller ไม่เคยเห็น plaintext ──
  // decrypt เข้า memory เฉพาะตรงนี้ ใช้เสร็จทิ้ง (ไม่ persist, ไม่ broadcast — read-only ต่อ state).
  // response คืนแค่ "ผลของ action" (status/detail) + ผ่าน scrub() กันค่าจริงหลุดติดมา.
  async function credUse(a) {
    a = asObj(a);
    const id = reqStr(a.id, "id", 128);
    const action = reqStr(a.action, "action", 16).toLowerCase();
    if (!USE_ACTIONS.includes(action)) throw new HttpError(400, "action ต้องเป็น " + USE_ACTIONS.join("/"));
    const cred = readAll("credentials").find((x) => x.id === id);
    if (!cred) throw new HttpError(404, "ไม่พบ credential id: " + id);

    const used = [];
    const secret = credSecret(id, used);          // 🔓 decrypt in-memory ที่เดียว
    const hasValue = !!(secret && secret !== "");

    let out;
    if (action === "http") {
      const url = reqStr(a.url, "url");
      checkUrl(url, "url");
      const method = (a.method ? reqStr(a.method, "method", 8) : "GET").toUpperCase();
      const scheme = a.scheme ? reqStr(a.scheme, "scheme", 16) : (cred.type === "basic" ? "Basic" : "Bearer");
      const headerName = (a.headerName ? reqStr(a.headerName, "headerName", 64) : "authorization").toLowerCase();
      const headers = {};
      if (hasValue) headers[headerName] = scheme + " " + secret;    // ค่าจริงอยู่ใน header เท่านั้น
      const r = await httpProbe({ url, method, headers, timeoutMs: 15000 });
      out = {
        ok: true, used: hasValue, action: "http", target: url, method,
        status: r.status, ms: r.ms,
        detail: r.status > 0 ? "HTTP " + r.status : (r.detail || "no response"),
      };
    } else {  // ssh — deploy/remote exec ด้วยรหัสผ่าน โดยไม่ echo
      const host = reqStr(a.host, "host", 255);
      const user = reqStr(a.user, "user", 64);
      const command = a.command == null ? "" : reqStr(a.command, "command", MAX_STR);
      const port = clamp(Number.isFinite(a.port) ? a.port : 22, 1, 65535);
      const run = a.run === true;
      // preview แสดงโครงคำสั่งโดย "รหัสผ่าน = ••••••" เสมอ (ไม่เคยเป็นค่าจริง)
      const preview = `sshpass -p ${MASK} ssh -p ${port} ${user}@${host}` + (command ? ` ${command}` : "");
      if (!run) {
        out = {
          ok: true, used: hasValue, action: "ssh", mode: "dry-run",
          target: `${user}@${host}:${port}`, command: command || null, preview,
          status: hasValue ? "prepared" : "no-credential",
          detail: hasValue
            ? "credential ถูกโหลดเข้า memory พร้อมยิง ssh (dry-run: ยังไม่เชื่อมต่อจริง)"
            : "credential ตัวนี้ไม่มีค่า secret",
        };
      } else {
        const r = await sshExec({ host, user, port, command, password: secret });
        out = {
          ok: true, used: hasValue, action: "ssh", mode: "live",
          target: `${user}@${host}:${port}`, command: command || null,
          status: r.status, detail: r.detail, exitCode: r.exitCode,
        };
      }
    }
    return scrub(out, used);   // 🧹 กวาดค่าจริงออกจาก response กันพลาด
  }

  // ssh จริง — best-effort ผ่าน module `ssh2` (optional); ไม่มี = failed (ไม่ throw, ไม่ echo รหัส).
  // password อยู่ใน memory ส่งเข้า ssh2 โดยตรง — ไม่เคยลง argv/ลง response.
  function sshExec({ host, user, port, command, password }) {
    let Client;
    try { Client = require("ssh2").Client; } catch { return Promise.resolve({ status: "failed", exitCode: null, detail: "โมดูล ssh2 ไม่พร้อมใช้ (ใช้ dry-run แทน)" }); }
    return new Promise((resolve) => {
      const conn = new Client();
      let done = false;
      const finish = (r) => { if (done) return; done = true; try { conn.end(); } catch {} resolve(r); };
      const tmr = setTimeout(() => finish({ status: "failed", exitCode: null, detail: "timeout" }), 20000);
      conn.on("ready", () => {
        if (!command) { clearTimeout(tmr); return finish({ status: "ok", exitCode: 0, detail: "authenticated (no command)" }); }
        conn.exec(command, (err, stream) => {
          if (err) { clearTimeout(tmr); return finish({ status: "failed", exitCode: null, detail: "exec error" }); }
          let code = null;
          stream.on("close", (c) => { clearTimeout(tmr); finish({ status: c === 0 ? "ok" : "failed", exitCode: c, detail: "exit " + c }); })
                .on("data", () => {}).stderr.on("data", () => {});
        });
      }).on("error", (e) => { clearTimeout(tmr); finish({ status: "failed", exitCode: null, detail: "ssh: " + (e && e.level || "error") }); })
        .connect({ host, port, username: user, password, readyTimeout: 15000 });
    });
  }

  // ── overview ──────────────────────────────────────────────────────────────────
  function overview() {
    return {
      ok: true, now: now(),
      credentials: readAll("credentials").map(toPublicCred),
      connections: readAll("connections"),
      workflows: readAll("workflows"),
    };
  }

  // ── command channel (agents) — รองรับชื่อ contract + alias เก่า กัน manifest พัง ──
  async function onCommand(cmd, args) {
    try {
      switch (cmd) {
        case "overview": return overview();
        case "cred-list": case "cred.list": return credList();
        case "cred-add": case "cred.set": return credUpsert(args);
        case "cred-remove": case "cred.remove": return credDelete(args);
        case "cred-use": case "cred.use": return await credUse(args);
        case "conn-list": return connList();
        case "conn-add": return connUpsert(args);
        case "conn-remove": return connDelete(args);
        case "conn-check": case "status": case "status.all": return await connCheck(args);
        case "wf-list": case "wf.list": return wfList();
        case "wf-add": case "wf.set": return wfUpsert(args);
        case "wf-remove": case "wf.remove": return wfDelete(args);
        case "wf-run": case "wf.trigger": return await wfRun(args);
        default: return { ok: false, error: "ไม่รู้จักคำสั่ง: " + cmd };
      }
    } catch (e) { return { ok: false, error: String(e && e.message) }; }   // cmd channel = 200 เสมอ
  }

  // ── HTTP routes (CONTRACT §4) — method-agnostic, slash sub แบบ exact ─────────
  function send(res, code, obj) {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  }
  // เรียก core ที่ throw HttpError → map เป็น HTTP code; ปกติ = 200
  function run(res, fn) {
    Promise.resolve().then(fn).then((out) => send(res, 200, out))
      .catch((e) => send(res, e instanceof HttpError ? e.status : 400, { ok: false, error: String(e && e.message) }));
  }
  function withBody(req, res, readBody, fn) {
    readBody(req, (raw) => {
      let p;
      try { p = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { ok: false, error: "bad json" }); }
      run(res, () => fn(p));
    });
  }
  const GET = (req) => req.method === "GET";
  const POST = (req) => req.method === "POST";

  const routes = {
    overview(req, res) { if (!GET(req)) return send(res, 405, { ok: false, error: "method not allowed" }); send(res, 200, overview()); },

    credentials(req, res, { readBody }) {
      if (GET(req)) return send(res, 200, credList());
      if (POST(req)) return withBody(req, res, readBody, (p) => credUpsert(p));
      send(res, 405, { ok: false, error: "method not allowed" });
    },
    "credentials/delete"(req, res, { readBody }) {
      if (!POST(req)) return send(res, 405, { ok: false, error: "method not allowed" });
      withBody(req, res, readBody, (p) => credDelete(p));
    },
    "credentials/use"(req, res, { readBody }) {
      if (!POST(req)) return send(res, 405, { ok: false, error: "method not allowed" });
      withBody(req, res, readBody, (p) => credUse(p));   // fail-open: action ล้ม=status ใน body (เว้น id ไม่พบ=404)
    },

    connections(req, res, { readBody }) {
      if (GET(req)) return send(res, 200, connList());
      if (POST(req)) return withBody(req, res, readBody, (p) => connUpsert(p));
      send(res, 405, { ok: false, error: "method not allowed" });
    },
    "connections/delete"(req, res, { readBody }) {
      if (!POST(req)) return send(res, 405, { ok: false, error: "method not allowed" });
      withBody(req, res, readBody, (p) => connDelete(p));
    },
    "connections/check"(req, res, { readBody }) {
      if (!POST(req)) return send(res, 405, { ok: false, error: "method not allowed" });
      withBody(req, res, readBody, (p) => connCheck(p));   // fail-open → 200 (เว้น id ไม่พบ = 404)
    },

    workflows(req, res, { readBody }) {
      if (GET(req)) return send(res, 200, wfList());
      if (POST(req)) return withBody(req, res, readBody, (p) => wfUpsert(p));
      send(res, 405, { ok: false, error: "method not allowed" });
    },
    "workflows/delete"(req, res, { readBody }) {
      if (!POST(req)) return send(res, 405, { ok: false, error: "method not allowed" });
      withBody(req, res, readBody, (p) => wfDelete(p));
    },
    "workflows/run"(req, res, { readBody }) {
      if (!POST(req)) return send(res, 405, { ok: false, error: "method not allowed" });
      withBody(req, res, readBody, (p) => wfRun(p));       // fail-open → 200 (เว้น id ไม่พบ = 404)
    },
  };

  migratePlaintext();   // เข้ารหัส plaintext เก่าทับอัตโนมัติตอนโหลด (idempotent)
  return { onCommand, routes };
};
