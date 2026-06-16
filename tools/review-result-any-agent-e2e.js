// Headless e2e proving the 🤖 review.result card is AGENT-AGNOSTIC (overlay.html).
// Reuses the vm-DOM harness shape of tools/review-gate-decision-e2e.js.
//
// Contract under test: docs/codex-review-gate.contract.md §5 + CEO order:
//   the verdict card must fire for EVERY agent — the render branches on
//   ev.verdict, never on the agent name (มิสเตอร์-n is only a fallback label).
//   pass ✅ / fail ❌ (reasons+fixes+files) / skipped ⏭ / escalate → รอ CEO,
//   and the CEO approve/reject buttons POST /review/decision for any agent.
//
// What it proves (no browser, no daemon), driving the REAL ws path route():
//   1. review.result fail for น้องไวท์  → card opens, names น้องไวท์
//   2. review.result fail for แบล็ค      → card opens, names แบล็ค (not gated to N)
//   3. review.result fail w/ no agentId → card opens, falls back to มิสเตอร์-n
//   4. fail card shows reasons + files + fixes sections
//   5. round ≥ 3 → escalate banner "รอ CEO" (stops auto-bounce)
//   6. pass / skipped → NO modal (chat ping only), no crash, for any agent
//   7. approve on a non-N agent → POST /review/decision carries that agentId
const fs = require("fs");
const vm = require("vm");
const path = require("path");

function mkText(s) {
  return { __isEl: true, nodeType: 3, textContent: s == null ? "" : String(s),
    parentNode: null, children: [], classList: { contains: () => false } };
}
function makeEl(tag) {
  const t = { tag: (tag || "div").toUpperCase(), children: [], dataset: {},
    _cls: new Set(), _text: "", _html: "", _props: {}, parentNode: null };
  t.style = new Proxy({}, { get: (s, k) => (k in s ? s[k] : ""), set: (s, k, v) => { s[k] = v; return true; } });
  let self;
  const classList = {
    add: (...c) => c.forEach((x) => x && t._cls.add(x)),
    remove: (...c) => c.forEach((x) => t._cls.delete(x)),
    contains: (x) => t._cls.has(x),
    toggle: (x, f) => { const on = f === undefined ? !t._cls.has(x) : !!f; on ? t._cls.add(x) : t._cls.delete(x); return on; },
  };
  const adopt = (n) => { const node = n && n.__isEl ? n : mkText(n); try { node.parentNode = self; } catch {} return node; };
  const api = {
    __isEl: true,
    get tagName() { return t.tag; },
    get children() { return t.children; },
    get dataset() { return t.dataset; },
    get style() { return t.style; },
    get classList() { return classList; },
    get className() { return [...t._cls].join(" "); },
    set className(v) { t._cls = new Set(String(v == null ? "" : v).split(/\s+/).filter(Boolean)); },
    get textContent() { return t._text || t.children.map((c) => c.textContent || "").join(""); },
    set textContent(v) { t._text = v == null ? "" : String(v); t.children = []; },
    get innerHTML() { return t._html; },
    set innerHTML(v) { t._html = v == null ? "" : String(v); t.children = []; },
    get title() { return t._props.title || ""; },
    set title(v) { t._props.title = v == null ? "" : String(v); },
    get parentNode() { return t.parentNode; },
    set parentNode(v) { t.parentNode = v; },
    append(...ns) { for (const n of ns) t.children.push(adopt(n)); },
    appendChild(n) { const node = adopt(n); t.children.push(node); return n; },
    prepend(n) { const node = adopt(n); t.children.unshift(node); return n; },
    removeChild(n) { t.children = t.children.filter((c) => c !== n); return n; },
    remove() { if (t.parentNode && t.parentNode.removeChild) t.parentNode.removeChild(self); },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    addEventListener() {}, removeEventListener() {},
    setAttribute(k, v) { t._props[k] = v; }, getAttribute(k) { return t._props[k]; }, removeAttribute(k) { delete t._props[k]; },
    focus() {}, blur() {}, click() {}, scrollIntoView() {},
  };
  const handler = {
    has: () => true,
    get(o, k) {
      if (k in api) return api[k];
      if (typeof k === "symbol") return k === Symbol.toPrimitive ? () => "" : undefined;
      if (k in t._props) return t._props[k];
      if (["value", "placeholder", "src", "id", "href", "nodeValue", "disabled"].includes(k)) return t._props[k] || "";
      if (k === "nodeType") return 1;
      return makeEl();
    },
    set(o, k, v) {
      const d = Object.getOwnPropertyDescriptor(api, k);
      if (d && d.set) { api[k] = v; return true; }
      t._props[k] = v; return true;
    },
  };
  self = new Proxy(api, handler);
  return self;
}

const elById = {};
const get$ = (id) => (elById[id] || (elById[id] = makeEl()));
const documentObj = {
  getElementById: get$,
  createElement: (t) => makeEl(t),
  createElementNS: (ns, t) => makeEl(t),
  createTextNode: (s) => mkText(s),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  getElementsByClassName: () => [],
  addEventListener() {}, removeEventListener() {},
  createTreeWalker: () => ({ nextNode: () => null }),
  get body() { return get$("__body"); },
  get documentElement() { return get$("__html"); },
  get head() { return get$("__head"); },
  cookie: "", title: "", hidden: false, activeElement: null,
};

const RealDate = Date;
let FAKE_NOW = 1_780_000_000_000;
function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(FAKE_NOW); }
FakeDate.now = () => FAKE_NOW;
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;
FakeDate.prototype = RealDate.prototype;

let lastFetch = null;
let fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" });

const base = {
  console,
  document: documentObj,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  fetch: (...a) => { lastFetch = a; return fetchImpl(...a); },
  WebSocket: function () { return makeEl(); },
  MutationObserver: function () { return { observe() {}, disconnect() {}, takeRecords: () => [] }; },
  TextEncoder, TextDecoder,
  navigator: { language: "th", mediaDevices: makeEl(), userAgent: "node", clipboard: { writeText: async () => {} } },
  location: { host: "127.0.0.1:8787", pathname: "/", href: "http://127.0.0.1:8787/", search: "", reload() {}, replace() {} },
  Date: FakeDate, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Promise, Map, Set, Symbol,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, Intl, Error, URL,
};
base.addEventListener = () => {};
base.removeEventListener = () => {};
base.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} });
base.getComputedStyle = () => new Proxy({}, { get() { return ""; } });

const sandbox = new Proxy(base, {
  has: () => true,
  get(t, k) { return k in t ? t[k] : makeEl(); },
  set(t, k, v) { t[k] = v; return true; },
});
base.window = sandbox; base.self = sandbox; base.globalThis = sandbox;

// ---- extract the MAIN app <script> block (largest; skips the macOS shim) ------
const file = path.join(__dirname, "..", "daemon", "overlay.html");
const html = fs.readFileSync(file, "utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!blocks.length) { console.error("no <script> block found"); process.exit(2); }
const main = blocks.reduce((a, b) => (b[1].length > a[1].length ? b : a));
const startLine = html.slice(0, main.index).split("\n").length;
const padded = "\n".repeat(startLine) + main[1];

vm.createContext(sandbox);
vm.runInContext(padded, sandbox, { filename: "overlay.html", lineOffset: 0 });

let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; console.log("  ✓ " + msg); } else { fails++; console.log("  ✗ FAIL: " + msg); } }
function findByClass(el, cls) {
  if (!el) return null;
  if (el.classList && el.classList.contains && el.classList.contains(cls)) return el;
  for (const c of (el.children || [])) { const f = findByClass(c, cls); if (f) return f; }
  return null;
}
const buttonsIn = (el) => {
  const out = [];
  (function walk(n) { if (!n) return; if (n.tagName === "BUTTON") out.push(n); for (const c of (n.children || [])) walk(c); })(el);
  return out;
};

sandbox.route({ type: "roster.sync", agents: {
  "main": { name: "บาร์ท", role: "Director", avatar: 7 },
  "ceo": { name: "คุณหนึ่ง", role: "Chairman", avatar: 8 },
  "มิสเตอร์-n": { name: "มิสเตอร์ N", avatar: 1 },
  "น้องไวท์": { name: "น้องไวท์", avatar: 4 },
  "แบล็ค": { name: "แบล็ค", avatar: 6 },
} });

const reviewModal = () => get$("reviewModal");
const reviewBody = () => get$("reviewBody");
const reviewTitle = () => get$("reviewTitle");
const fail = (agentId, extra) => ({ type: "review.result", verdict: "fail", reviewId: "rv-" + (agentId || "none"),
  agentId, project: "tookjorThai", round: 1,
  reasons: ["ยังขาด null guard"], files: ["daemon/server.js"], fixes: ["เพิ่ม guard ก่อน .map"],
  codexAvailable: true, ...(extra || {}) });

async function main2() {
  // ---- 1+2. fail card fires for agents OTHER than มิสเตอร์-n ---------------
  console.log("\n[1] review.result fail (น้องไวท์) → card opens + names น้องไวท์");
  sandbox.route(fail("น้องไวท์"));
  ok(reviewModal().classList.contains("open"), "card opens for น้องไวท์ (not gated to N)");
  ok(reviewBody().textContent.includes("น้องไวท์"), "card names น้องไวท์");
  ok(reviewTitle().textContent.includes("ไม่ผ่าน"), "title = ❌ ไม่ผ่าน Review by Codex");
  sandbox.closeReviewModal();

  console.log("\n[2] review.result fail (แบล็ค) → card opens + names แบล็ค");
  sandbox.route(fail("แบล็ค"));
  ok(reviewModal().classList.contains("open"), "card opens for แบล็ค too");
  ok(reviewBody().textContent.includes("แบล็ค"), "card names แบล็ค");

  // ---- 3. no agentId → falls back to มิสเตอร์-n (label only, not a gate) ----
  console.log("\n[3] review.result fail (no agentId) → fallback label มิสเตอร์");
  sandbox.closeReviewModal();
  sandbox.route(fail(undefined));
  ok(reviewModal().classList.contains("open"), "card still opens with no agentId (verdict-driven)");
  ok(reviewBody().textContent.includes("มิสเตอร์"), "falls back to มิสเตอร์ N label");

  // ---- 4. fail card shows reasons + files + fixes --------------------------
  console.log("\n[4] fail card → reasons + files + fixes sections");
  sandbox.closeReviewModal();
  sandbox.route(fail("น้องไวท์"));
  const reasons = findByClass(reviewBody(), "reasons");
  const files = findByClass(reviewBody(), "files");
  const fixes = findByClass(reviewBody(), "fixes");
  ok(!!reasons && reasons.textContent.includes("null guard"), "reasons section rendered");
  ok(!!files && files.textContent.includes("server.js"), "files section rendered");
  ok(!!fixes && fixes.textContent.includes("guard"), "fixes section rendered");

  // ---- 5. round ≥ 3 → escalate banner รอ CEO ------------------------------
  console.log("\n[5] round 3 → escalate banner (รอ CEO, stop auto-bounce)");
  sandbox.closeReviewModal();
  sandbox.route(fail("น้องไวท์", { round: 3 }));
  const bounce = findByClass(reviewBody(), "rvbounce");
  ok(!!bounce && bounce.classList.contains("escalate"), "bounce block flips to .escalate");
  ok(!!bounce && bounce.textContent.includes("CEO"), "escalate banner says รอ CEO");

  // ---- 6. pass / skipped → NO modal for any agent -------------------------
  console.log("\n[6] pass / skipped → no modal (chat ping only), any agent");
  sandbox.closeReviewModal();
  ok(!reviewModal().classList.contains("open"), "(card closed)");
  let threw = false;
  try { sandbox.route({ type: "review.result", verdict: "pass", agentId: "แบล็ค", reviewId: "rvp" }); }
  catch (e) { threw = true; }
  ok(!threw && !reviewModal().classList.contains("open"), "pass for แบล็ค → no modal, no crash");
  try { sandbox.route({ type: "review.result", verdict: "skipped", agentId: "น้องไวท์", reviewId: "rvs", codexAvailable: false }); }
  catch (e) { threw = true; }
  ok(!threw && !reviewModal().classList.contains("open"), "skipped for น้องไวท์ → no modal, no crash");

  // ---- 7. approve on a non-N agent → POST carries that agentId -------------
  console.log("\n[7] CEO approve on แบล็ค's card → POST /review/decision w/ agentId แบล็ค");
  sandbox.route(fail("แบล็ค", { reviewId: "rvX" }));
  const act = findByClass(reviewBody(), "rvact");
  const yes = buttonsIn(act).find((b) => b.classList.contains("primary"));
  ok(!!yes, "approve button present on แบล็ค's card");
  lastFetch = null;
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" });
  await yes.onclick();
  ok(lastFetch && lastFetch[0] === "/review/decision", "POSTs to /review/decision");
  const sent = JSON.parse(((lastFetch && lastFetch[1]) || {}).body || "{}");
  ok(sent.decision === "approve" && sent.agentId === "แบล็ค" && sent.reviewId === "rvX",
    "payload carries decision + แบล็ค's agentId + reviewId (not hard-coded to N)");

  console.log(`\n${fails === 0 ? "ALL PASS" : "HAS FAILURES"} — ${passes} passed, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}
main2().catch((e) => { console.error("E2E CRASHED:", e); process.exit(2); });
