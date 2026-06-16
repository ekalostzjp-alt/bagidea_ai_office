// Headless e2e for the 🎟 TOKEN / QUOTA refresh button (overlay.html).
// Reuses the vm-DOM harness shape of tools/review-gate-decision-e2e.js.
//
// Contract under test: docs/token-usage-panel.contract.md §2/§3 + CEO order:
//   pressing refresh must hit GET /tokens?fresh=1 (NOT plain /tokens), show a
//   spinner while waiting, re-pull /tokens on the tokens.update broadcast (so the
//   Claude + Codex numbers bounce live), and stale data must show a "as of …"
//   line beside the ⚠ badge.
//
// What it proves (no browser, no daemon):
//   1. pullTokens(true)  → fetches /tokens?fresh=1  with x-bagidea-ui:1
//   2. pullTokens(false) → fetches plain /tokens     (cache, cheap)
//   3. refreshTokens()   → drives the fresh=1 pull (the button's job)
//   4. ws tokens.update (panel open) → RE-PULLS /tokens so fresh numbers land
//   5. replayed tokens.update → ignored (no fetch)
//   6. tokCard(stale)  → renders ⚠ badge + "as of …" (snapshotAt / fetchedAt)
//   7. tokCard(fresh)  → no badge, no as-of line
const fs = require("fs");
const vm = require("vm");
const path = require("path");

// ---- minimal but tree-RETAINING DOM (same as review-gate-decision-e2e.js) ----
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

// swappable fetch — captures the call so we can assert URL + headers
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

// ---- extract the MAIN app <script> block --------------------------------------
// overlay.html now has TWO <script> blocks (a tiny macOS platform-tag shim up
// top + the big app script). Grab the LARGEST one so the shim can't poison the
// parse — the single-block assumption broke when macOS support landed.
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
const TOKJSON = {
  claude: { ok: true, plan: "max_5x", stale: false, fetchedAt: 1781064000000,
    primary: { label: "5h", usedPct: 11, remainingPct: 89, resetAt: 1781063400, status: "allowed" },
    secondary: { label: "7d", usedPct: 2, remainingPct: 98, resetAt: 1781283600, status: "allowed" },
    representative: "primary" },
  codex: { ok: true, plan: "plus", stale: true, fetchedAt: 1781064000000, snapshotAt: 1780378791,
    primary: { label: "5h", usedPct: 1, remainingPct: 99, resetAt: 1780378791 },
    secondary: { label: "7d", usedPct: 0, remainingPct: 100, resetAt: 1780965591 },
    representative: "primary", note: "snapshot from last Codex run; may be stale" },
  ts: FAKE_NOW,
};
const okFetch = async () => ({ ok: true, status: 200, json: async () => TOKJSON, text: async () => "" });

async function main2() {
  // ---- 1. pullTokens(true) → /tokens?fresh=1 -------------------------------
  console.log("\n[1] pullTokens(true) → GET /tokens?fresh=1 (live re-fetch)");
  fetchImpl = okFetch;
  lastFetch = null;
  await sandbox.pullTokens(true);
  ok(lastFetch && lastFetch[0] === "/tokens?fresh=1", "fresh pull hits /tokens?fresh=1 (not plain /tokens)");
  ok(((lastFetch[1] || {}).headers || {})["x-bagidea-ui"] === "1", "carries x-bagidea-ui:1");

  // ---- 2. pullTokens(false) → plain /tokens --------------------------------
  console.log("\n[2] pullTokens(false) → GET /tokens (cache)");
  lastFetch = null;
  await sandbox.pullTokens(false);
  ok(lastFetch && lastFetch[0] === "/tokens", "cache pull hits plain /tokens");

  // ---- 3. refreshTokens() → drives the fresh=1 pull ------------------------
  console.log("\n[3] refreshTokens() → fresh=1 pull (the button's job)");
  lastFetch = null;
  await sandbox.refreshTokens();
  ok(lastFetch && lastFetch[0] === "/tokens?fresh=1", "refresh button triggers a fresh=1 pull");

  // ---- 4. ws tokens.update (panel open) → RE-PULL /tokens ------------------
  console.log("\n[4] ws tokens.update (panel open) → re-pull /tokens for live numbers");
  get$("modal").classList.add("open");   // simulate the quota panel being open
  lastFetch = null;
  sandbox.route({ type: "tokens.update", claude: TOKJSON.claude, codex: TOKJSON.codex, ts: FAKE_NOW });
  await new Promise((r) => setTimeout(r, 15));
  ok(lastFetch && lastFetch[0] === "/tokens", "tokens.update re-pulls /tokens (snappy live refresh)");

  // ---- 5. replayed tokens.update → ignored --------------------------------
  console.log("\n[5] replayed tokens.update → ignored (no fetch)");
  lastFetch = null;
  sandbox.route({ type: "tokens.update", replay: true, claude: TOKJSON.claude, codex: TOKJSON.codex, ts: FAKE_NOW });
  await new Promise((r) => setTimeout(r, 15));
  ok(lastFetch === null, "replay does not trigger a re-pull");

  // ---- 6. tokCard(stale) → ⚠ badge + "as of …" ----------------------------
  console.log("\n[6] tokCard(stale codex) → ⚠ ข้อมูลเก่า + 'as of …'");
  const cStale = sandbox.tokCard("Codex (ChatGPT)", "🟢", TOKJSON.codex);
  const badge = findByClass(cStale, "tokstale");
  ok(!!badge && badge.textContent.includes("ข้อมูลเก่า"), "stale card shows ⚠ badge");
  const asof = findByClass(cStale, "tokasof");
  ok(!!asof && asof.textContent.includes("as of"), "stale card shows 'as of …' line");
  ok(!!asof && asof.textContent.length > "as of ".length, "as-of carries an actual timestamp");

  // ---- 7. tokCard(fresh) → no badge, no as-of -----------------------------
  console.log("\n[7] tokCard(fresh claude) → no badge, no as-of");
  const cFresh = sandbox.tokCard("Claude Code", "🟣", TOKJSON.claude);
  ok(!findByClass(cFresh, "tokstale"), "fresh card has no stale badge");
  ok(!findByClass(cFresh, "tokasof"), "fresh card has no as-of line");

  console.log(`\n${fails === 0 ? "ALL PASS" : "HAS FAILURES"} — ${passes} passed, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}
main2().catch((e) => { console.error("E2E CRASHED:", e); process.exit(2); });
