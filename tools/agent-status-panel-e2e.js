#!/usr/bin/env node
// Headless e2e for plugins/agent-status/panel.html (📊 Agent Status — FE: น้องไวท์).
//
// พิสูจน์ว่า panel render ครบจาก cmd `status` ก้อนเดียว โดยไม่ต้องเปิดเบราว์เซอร์/จอ:
//   1. live payload → grid มีการ์ดเท่าจำนวน agents, การ์ด timedOut ติด class .timeout,
//      alertBar โผล่, warnings band มีแถวเท่า warnings, claims strip มี chip = claims+queue.
//   2. cmd ล่ม (fetch reject) → โหมด DEMO: ยัง render mock ได้ ไม่ throw (src=demo).
//   3. liveSource:"down" → grid ว่าง แต่ claims/warnings ยังโชว์ (degrade ไม่พังหน้า).
//   4. payload เพี้ยน/field หาย → ไม่ throw.
//
// รัน: node tools/agent-status-panel-e2e.js   (exit 0 = ผ่าน)
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const PANEL = path.join(__dirname, "..", "plugins", "agent-status", "panel.html");
const html = fs.readFileSync(PANEL, "utf8");
const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
if (!script) { console.error("✗ ไม่พบ <script> ใน panel.html"); process.exit(1); }

let PASS = 0, FAIL = 0;
const ok = (m) => { PASS++; console.log("  \x1b[32m✓\x1b[0m " + m); };
const bad = (m) => { FAIL++; console.log("  \x1b[31m✗\x1b[0m " + m); };

// ── minimal tree-RETAINING DOM ───────────────────────────────────────────────
function mkCtx2d() {
  const noop = () => {};
  return new Proxy({ clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
    stroke: noop, arc: noop, fill: noop }, { get: (o, k) => (k in o ? o[k] : noop), set: () => true });
}
function makeEl(tag) {
  const t = { tag: (tag || "div").toUpperCase(), children: [], dataset: {}, _cls: new Set(),
    _text: "", _html: "", _props: {}, parent: null };
  let self;
  const classList = {
    add: (...c) => c.forEach((x) => x && t._cls.add(x)),
    remove: (...c) => c.forEach((x) => t._cls.delete(x)),
    contains: (x) => t._cls.has(x),
    toggle: (x, f) => { const on = f === undefined ? !t._cls.has(x) : !!f; on ? t._cls.add(x) : t._cls.delete(x); return on; },
  };
  const api = {
    __isEl: true, tagName: t.tag,
    get children() { return t.children; },
    get dataset() { return t.dataset; },
    get classList() { return classList; },
    get className() { return [...t._cls].join(" "); },
    set className(v) { t._cls = new Set(String(v == null ? "" : v).split(/\s+/).filter(Boolean)); },
    get textContent() { return t._text; },
    set textContent(v) { t._text = v == null ? "" : String(v); },
    get innerHTML() { return t._html; },
    set innerHTML(v) { t._html = v == null ? "" : String(v); if (t._html === "") t.children = []; },
    style: new Proxy({}, { get: (s, k) => (k in s ? s[k] : ""), set: (s, k, v) => { s[k] = v; return true; } }),
    appendChild(n) { if (n.parent && n.parent.children) n.parent.children = n.parent.children.filter((c) => c !== n);
      n.parent = self; if (!t.children.includes(n)) t.children.push(n); return n; },
    removeChild(n) { t.children = t.children.filter((c) => c !== n); return n; },
    remove() { if (t.parent && t.parent.removeChild) t.parent.removeChild(self); },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    getContext() { return mkCtx2d(); },
    addEventListener() {}, removeEventListener() {},
    setAttribute(k, v) { t._props[k] = v; }, getAttribute(k) { return t._props[k]; },
  };
  const handler = {
    has: () => true,
    get(o, k) {
      if (k in api) return api[k];
      if (typeof k === "symbol") return undefined;
      if (k in t._props) return t._props[k];
      if (k === "width") return 440; if (k === "height") return 104;
      if (k === "parent") return t.parent;
      return makeEl();
    },
    set(o, k, v) {
      const d = Object.getOwnPropertyDescriptor(api, k);
      if (d && d.set) { api[k] = v; return true; }
      if (k === "parent") { t.parent = v; return true; }
      t._props[k] = v; return true;
    },
  };
  self = new Proxy({}, handler);
  return self;
}

// ── run the panel script against a payload, return the live DOM registry ─────
function runPanel({ payload, reject = false, liveDown = false }) {
  const ids = {};
  const KNOWN = ["dot", "src", "meta", "alertBar", "alertText", "warnings", "clear",
    "grid", "empty", "claims", "nClaims", "nQueue"];
  for (const id of KNOWN) ids[id] = makeEl("div");

  const document = {
    getElementById: (id) => ids[id] || (ids[id] = makeEl("div")),
    createElement: (tag) => makeEl(tag),
    querySelectorAll: (sel) => {
      // tickTtl ถาม #claims .chip.claim — คืน chip ที่เป็น claim จริง
      if (sel.includes("#claims")) return ids.claims.children.filter((c) => c.classList.contains("claim"));
      return [];
    },
  };
  let pulls = 0;
  const sandbox = {
    document,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    fetch: () => { pulls++; return reject
      ? Promise.reject(new Error("cmd down"))
      : Promise.resolve({ ok: true, json: () => Promise.resolve(
          liveDown ? { ...payload, liveSource: "down", agents: [] } : payload) }); },
    WebSocket: function () { this.onmessage = null; },
    setInterval: () => 0, setTimeout: (fn) => 0,   // กันลูป — เราเรียก pull เองครั้งเดียว
    clearInterval: () => {}, console,
    Math, Date, JSON, Number, String, Array, Object,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { timeout: 5000 });
  return { ids, sandbox };
}

const REAL = {
  ok: true, ts: Date.now(), now: Date.now(), thresholdMs: 120000, liveSource: "up",
  agents: [
    { id: "main", name: "บาร์ท", cpu: 42, memMB: 610, queueLen: 1, state: "working", timedOut: false, project: "bagidea", task: "overlay" },
    { id: "white", name: "น้องไวท์", cpu: 70, memMB: 880, queueLen: 2, state: "working", timedOut: false, project: "bagidea", task: "panel" },
    { id: "n", name: "มิสเตอร์ N", cpu: null, memMB: null, queueLen: 4, state: "stuck", timedOut: true, project: "momo_project", task: "ค้าง" },
    { id: "ceo", name: "คุณหนึ่ง", cpu: null, memMB: null, queueLen: 0, state: "idle", timedOut: false, project: null, task: null },
  ],
  claims: [
    { id: "c1", agentId: "น้องไวท์", project: "bagidea", files: ["plugins/agent-status/panel.html"], reason: "FE", ts: Date.now() - 60000, ttlMs: 1800000 },
    { id: "c2", agentId: "แบล็ค", project: "bagidea", files: [], reason: "BE", ts: Date.now() - 120000, ttlMs: 1800000 },
  ],
  queue: [
    { id: "q1", claim: { agentId: "มิสเตอร์ N", project: "bagidea", files: ["x.js"], reason: "รอ" }, blockedBy: ["แบล็ค"], since: Date.now() - 30000 },
  ],
  warnings: [
    { type: "project-overlap", project: "bagidea", agents: ["บาร์ท", "น้องไวท์", "แบล็ค"], files: [], severity: "warn", detectedAt: Date.now() },
    { type: "file-overlap", project: "bagidea", agents: ["แบล็ค", "มิสเตอร์ N"], files: ["x.js"], severity: "block", detectedAt: Date.now() },
  ],
  msg: "1 block / 1 warn",
};

const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log("📊 agent-status panel e2e\n");

  // ── 1. live payload ──
  console.log("1) live payload render");
  let r = runPanel({ payload: REAL });
  await flush(); await flush();
  const grid = r.ids.grid, warn = r.ids.warnings, claims = r.ids.claims;
  grid.children.length === REAL.agents.length
    ? ok(`grid มี ${grid.children.length} การ์ด = จำนวน agents`)
    : bad(`grid ได้ ${grid.children.length} ควรเป็น ${REAL.agents.length}`);
  const stuckCard = grid.children.find((c) => c.classList.contains("timeout"));
  stuckCard ? ok("agent ที่ timedOut ติด class .timeout (ไฟแดง)") : bad("ไม่มีการ์ด .timeout");
  r.ids.alertBar.classList.contains("show") ? ok("alertBar timeout โผล่") : bad("alertBar ไม่โผล่");
  warn.children.length === 2 ? ok("warnings band มี 2 แถว (warn+block)") : bad(`warnings ได้ ${warn.children.length}`);
  const hasBlock = warn.children.some((w) => w.classList.contains("block"));
  hasBlock ? ok("มี warning severity=block (file-overlap)") : bad("ไม่มี block warning");
  claims.children.length === 3
    ? ok(`claims strip มี 3 chip (2 claim + 1 queued)`)
    : bad(`claims ได้ ${claims.children.length} ควรเป็น 3`);
  const queued = claims.children.find((c) => c.classList.contains("queued"));
  queued ? ok("queued chip แยกแสดง (#1)") : bad("ไม่มี queued chip");
  r.ids.src.classList.contains("live") ? ok("src indicator = live") : bad("src ไม่ใช่ live");
  /agents/.test(r.ids.meta.textContent) ? ok("meta สรุป: " + r.ids.meta.textContent) : bad("meta ว่าง");

  // ── 2. cmd ล่ม → DEMO ──
  console.log("\n2) cmd ล่ม → โหมด DEMO");
  r = runPanel({ payload: REAL, reject: true });
  await flush(); await flush();
  r.ids.src.classList.contains("demo") ? ok("src = DEMO เมื่อ fetch reject") : bad("ไม่เข้าโหมด demo");
  r.ids.grid.children.length > 0 ? ok(`DEMO render การ์ด ${r.ids.grid.children.length} ใบ (เห็นเลย์เอาต์ทันที)`) : bad("DEMO ไม่ render");

  // ── 3. liveSource:"down" → agents ว่าง แต่ claims/warnings ยังอยู่ ──
  console.log("\n3) liveSource down → degrade");
  r = runPanel({ payload: REAL, liveDown: true });
  await flush(); await flush();
  r.ids.grid.children.length === 0 ? ok("grid ว่างเมื่อ live down") : bad("grid ควรว่าง");
  r.ids.claims.children.length === 3 ? ok("claims/queue ยังโชว์ครบตอน live down") : bad("claims หายตอน live down");
  r.ids.src.classList.contains("down") ? ok("src = live: down") : bad("src ไม่ใช่ down");

  // ── 4. payload เพี้ยน ──
  console.log("\n4) payload เพี้ยน/field หาย → ไม่ throw");
  try {
    r = runPanel({ payload: { ok: true, agents: [{}, { state: "working" }], ts: Date.now() } });
    await flush(); await flush();
    ok("normalize agent ที่ field หายได้ (" + r.ids.grid.children.length + " การ์ด)");
  } catch (e) { bad("throw: " + e.message); }

  console.log(`\n${FAIL ? "\x1b[31m" : "\x1b[32m"}สรุป: ${PASS} ผ่าน / ${FAIL} fail\x1b[0m`);
  process.exit(FAIL ? 1 : 0);
})();
