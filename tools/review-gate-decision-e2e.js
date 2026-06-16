// Headless e2e for the 🧑‍⚖️ CEO manual gate buttons in the review-gate card
// (overlay.html). Reuses the vm-DOM harness of tools/claude-live-e2e.js.
//
// Contract under test: docs/codex-review-gate.contract.md §5 (Frontend, White)
// + the CEO order to add manual อนุมัติ/ปฏิเสธ. The buttons POST a verdict to
// the gate route Black opens (POST /review/decision) and the authoritative UI
// update comes back over ws {type:"review.decision", agentId, decision}.
//
// What it proves (no browser, no daemon):
//  1. opening the review card renders ✅ อนุมัติ + ❌ ปฏิเสธ buttons.
//  2. approve → POST /review/decision with the right payload, then the card
//     closes (the ws broadcast drives the final UI).
//  3. route-not-live-yet (404) degrades gracefully: an honest note, the card
//     stays open, both buttons re-enable so the CEO can retry.
//  4. ws review.decision (from this or another window) closes the open card.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

// ---- minimal but tree-RETAINING DOM (same as claude-live-e2e.js) ------------
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

// swappable fetch — each test sets what POST /review/decision returns + captures the call
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

const file = path.join(__dirname, "..", "daemon", "overlay.html");
const html = fs.readFileSync(file, "utf8");
// Grab the LARGEST <script> block (the app), not the first — overlay.html gained
// a tiny macOS platform-tag shim <script> up top, and a first..last slice would
// swallow the shim's </script> and crash the parse.
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const mainBlock = blocks.reduce((a, b) => (b[1].length > a[1].length ? b : a));
const startLine = html.slice(0, mainBlock.index).split("\n").length;
const body = mainBlock[1];
const padded = "\n".repeat(startLine) + body;

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
const EV = { type: "review.result", verdict: "fail", reviewId: "rv123",
  agentId: "มิสเตอร์-n", project: "tookjorThai", round: 2,
  reasons: ["ยังขาด null guard"], files: ["daemon/server.js"], fixes: ["เพิ่ม guard ก่อน .map"],
  codexAvailable: true };

async function main() {
  // ---- 1. the card renders approve + reject buttons ------------------------
  console.log("\n[1] review card → ✅ อนุมัติ + ❌ ปฏิเสธ buttons");
  sandbox.openReviewModal(EV);
  ok(reviewModal().classList.contains("open"), "review card opened");
  const act = findByClass(reviewBody(), "rvact");
  ok(!!act, "a .rvact manual-gate block is appended under the card");
  const btns = buttonsIn(act);
  ok(btns.length === 2, "exactly 2 buttons (approve + reject)");
  const yes = btns.find((b) => b.classList.contains("primary"));
  const no = btns.find((b) => b.classList.contains("danger"));
  ok(!!yes && yes.textContent.includes("อนุมัติ"), "primary button = '✅ อนุมัติผ่าน'");
  ok(!!no && no.textContent.includes("ปฏิเสธ"), "danger button = '❌ ปฏิเสธ — ตีกลับ'");

  // ---- 2. approve → POST /review/decision + card closes --------------------
  console.log("\n[2] approve → POST /review/decision then close");
  lastFetch = null;
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" });
  await yes.onclick();
  ok(lastFetch && lastFetch[0] === "/review/decision", "POSTs to /review/decision");
  const opts = (lastFetch && lastFetch[1]) || {};
  ok(opts.method === "POST", "method POST");
  ok((opts.headers || {})["x-bagidea-ui"] === "1", "carries x-bagidea-ui:1");
  const sent = JSON.parse(opts.body || "{}");
  ok(sent.decision === "approve", "body.decision === 'approve'");
  ok(sent.reviewId === "rv123" && sent.agentId === "มิสเตอร์-n" && sent.project === "tookjorThai",
    "body carries reviewId + agentId + project from the event");
  ok(!reviewModal().classList.contains("open"), "card closes on success (ws drives final UI)");

  // ---- 3. route not live yet (404) → graceful, retryable -------------------
  console.log("\n[3] 404 (Black's route not up yet) → honest note, card stays, retryable");
  sandbox.openReviewModal(EV);
  fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
  const act3 = findByClass(reviewBody(), "rvact");
  const no3 = buttonsIn(act3).find((b) => b.classList.contains("danger"));
  await no3.onclick();
  ok(reviewModal().classList.contains("open"), "card stays OPEN on 404 (nothing was decided)");
  const note = findByClass(reviewBody(), "rvactnote");
  ok(!!note && note.classList.contains("err") && note.textContent.includes("404"),
    "note flips to error + names the 404 so the CEO knows it's a backend gap");
  ok(no3.disabled === false, "reject button re-enabled for a retry");
  const yes3 = buttonsIn(act3).find((b) => b.classList.contains("primary"));
  ok(yes3.disabled === false, "approve button re-enabled too");

  // ---- 4. ws review.decision closes the open card -------------------------
  console.log("\n[4] ws review.decision → close the open card");
  ok(reviewModal().classList.contains("open"), "(card still open from step 3)");
  sandbox.route({ type: "review.decision", reviewId: "rv123", agentId: "มิสเตอร์-n", decision: "approve" });
  ok(!reviewModal().classList.contains("open"), "broadcast verdict closes the card");
  // replay must be ignored (no crash, no action)
  let threw = false;
  try { sandbox.route({ type: "review.decision", replay: true, agentId: "x", decision: "reject" }); }
  catch (e) { threw = true; }
  ok(!threw, "replayed review.decision ignored safely");

  console.log(`\n${fails === 0 ? "ALL PASS" : "HAS FAILURES"} — ${passes} passed, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error("E2E CRASHED:", e); process.exit(2); });
