// Headless e2e for the 🤖 per-agent model badge in Hub icons (overlay.html #13).
//
// What it proves (no browser, no daemon):
//  1. shortModel() strips "claude-" prefix and trims long date suffix.
//  2. On boot: loadModelCache() (stubbed fetch) populates AGENT_MODEL and
//     renders a .modeltag on each seat for working agents.
//  3. .modeltag CSS class is present: working agents have it, idle don't.
//  4. ws models.changed event updates the cache and re-renders badges live.
//  5. When agentStatus row includes a `model` field (future backend), that
//     takes precedence over the cache value.
//  6. Idle agents: .modeltag element exists on seat but CSS class keeps it
//     hidden (.seat.sworking .modeltag { display: block } — this test verifies
//     the element is there; visual hiding is a CSS concern, not DOM logic).
//
// Exit 0 = pass, 1 = fail.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

// ---- minimal but tree-RETAINING DOM (same as other overlay e2e tests) ------
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
      if (["value", "placeholder", "src", "id", "href", "nodeValue"].includes(k)) return t._props[k] || "";
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

let fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" });

const base = {
  console,
  document: documentObj,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  fetch: (...a) => fetchImpl(...a),
  WebSocket: function () { return makeEl(); },
  MutationObserver: function () { return { observe() {}, disconnect() {}, takeRecords: () => [] }; },
  TextEncoder, TextDecoder,
  navigator: { language: "th", mediaDevices: makeEl(), userAgent: "node", clipboard: { writeText: async () => {} } },
  location: { host: "127.0.0.1:8787", pathname: "/", href: "http://127.0.0.1:8787/", search: "", reload() {}, replace() {} },
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Promise, Map, Set, Symbol,
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

// ---- load overlay.html's script --------------------------------------------
const file = path.join(__dirname, "..", "daemon", "overlay.html");
const html = fs.readFileSync(file, "utf8");
const open = html.indexOf("<script>");
const startLine = html.slice(0, open).split("\n").length;
const body = html.slice(open + "<script>".length, html.lastIndexOf("</script>"));
const padded = "\n".repeat(startLine) + body;

vm.createContext(sandbox);
vm.runInContext(padded, sandbox, { filename: "overlay.html", lineOffset: 0 });

// ---- assertion helpers -----------------------------------------------------
let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; console.log("  ✓ " + msg); } else { fails++; console.log("  ✗ FAIL: " + msg); } }

const rail = () => get$("rail");
const seatOf = (id) => rail().children.find((s) => s && s.dataset && s.dataset.id === id);
const badgeOf = (seat) => seat && seat.children.find((c) => c.__isEl && c.classList && c.classList.contains("modeltag"));
const isWorking = (s) => !!s && s.classList.contains("sworking");

// Boot roster + model settings stub
fetchImpl = async (url) => {
  if (String(url).includes("/settings/models"))
    return { ok: true, status: 200, json: async () => ({
      default: "claude-opus-4-8",
      perAgent: { "น้องไวท์": "claude-sonnet-4-6", "แบล็ค": "claude-opus-4-8",
        "มิสเตอร์-n": "claude-opus-4-8" },
      available: [],
    }) };
  if (String(url).includes("/agents/status"))
    return { ok: true, status: 200, json: async () => ({ agents: [
      { agentId: "main", status: "idle", project: null, task: null },
      { agentId: "ceo", status: "idle", project: null, task: null },
      { agentId: "น้องไวท์", status: "working", project: "bagidea", task: "model badges" },
      { agentId: "แบล็ค", status: "working", project: "bagidea", task: "backend model field" },
      { agentId: "มิสเตอร์-n", status: "idle", project: null, task: null },
    ] }) };
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};

async function main() {
  // ---- 1. shortModel strips prefix and date suffix -------------------------
  console.log("\n[1] shortModel() abbreviates model ids correctly");
  ok(sandbox.shortModel("claude-sonnet-4-6") === "sonnet-4-6", "claude-sonnet-4-6 → sonnet-4-6");
  ok(sandbox.shortModel("claude-opus-4-8") === "opus-4-8", "claude-opus-4-8 → opus-4-8");
  ok(sandbox.shortModel("claude-fable-5") === "fable-5", "claude-fable-5 → fable-5");
  ok(sandbox.shortModel("claude-haiku-4-5-20251001") === "haiku-4-5", "claude-haiku-4-5-20251001 → haiku-4-5 (date trimmed)");
  ok(sandbox.shortModel("") === "", "empty string → empty string (no crash)");
  ok(sandbox.shortModel(null) === "", "null → empty string (no crash)");

  // ---- 2. boot: roster.sync + loadModelCache + loadAgentStatus -------------
  console.log("\n[2] boot: loadModelCache() → model badges paint on working seats");
  sandbox.route({ type: "roster.sync", agents: {
    "main": { name: "บาร์ท", role: "Director", avatar: 7 },
    "ceo": { name: "คุณหนึ่ง", role: "Chairman", avatar: 8 },
    "น้องไวท์": { name: "น้องไวท์", avatar: 4 },
    "แบล็ค": { name: "แบล็ค", avatar: 6 },
    "มิสเตอร์-n": { name: "มิสเตอร์ N", avatar: 1 },
  } });
  await sandbox.loadModelCache();
  await sandbox.loadAgentStatus();

  {
    const w = seatOf("น้องไวท์"), bk = seatOf("แบล็ค"), n = seatOf("มิสเตอร์-n");
    ok(!!badgeOf(w), "น้องไวท์ seat has a .modeltag element");
    ok(badgeOf(w) && badgeOf(w).textContent === "sonnet-4-6",
      "น้องไวท์ badge shows 'sonnet-4-6' (from perAgent setting)");
    ok(!!badgeOf(bk), "แบล็ค seat has a .modeltag element");
    ok(badgeOf(bk) && badgeOf(bk).textContent === "opus-4-8",
      "แบล็ค badge shows 'opus-4-8' (from perAgent setting)");
    ok(!!badgeOf(n), "มิสเตอร์-n seat has a .modeltag element (hidden by CSS while idle)");
    ok(badgeOf(n) && badgeOf(n).textContent === "opus-4-8",
      "มิสเตอร์-n badge text still correct (CSS hides it — element exists)");
    ok(isWorking(w), "น้องไวท์ is sworking → CSS will show the badge");
    ok(!isWorking(n), "มิสเตอร์-n is idle → CSS keeps badge hidden");
  }

  // ---- 3. models.changed ws event updates badges live ----------------------
  console.log("\n[3] models.changed ws event → live badge update");
  sandbox.route({ type: "models.changed",
    default: "claude-fable-5",
    perAgent: { "น้องไวท์": "claude-fable-5", "แบล็ค": "claude-haiku-4-5-20251001" },
  });
  {
    const w = seatOf("น้องไวท์"), bk = seatOf("แบล็ค"), n = seatOf("มิสเตอร์-n");
    ok(badgeOf(w) && badgeOf(w).textContent === "fable-5",
      "น้องไวท์ badge updated to 'fable-5' after models.changed");
    ok(badgeOf(bk) && badgeOf(bk).textContent === "haiku-4-5",
      "แบล็ค badge updated to 'haiku-4-5' (date suffix stripped)");
    // มิสเตอร์-n not in perAgent → falls back to new default "fable-5"
    ok(badgeOf(n) && badgeOf(n).textContent === "fable-5",
      "มิสเตอร์-n falls back to new office default 'fable-5'");
  }

  // ---- 4. agent.status row with model field → row model takes precedence ---
  console.log("\n[4] future backend: agent.status row.model overrides cache");
  sandbox.route({ type: "agent.status", agents: [
    { agentId: "น้องไวท์", status: "working", project: "bagidea",
      task: "test", model: "claude-opus-4-8" },   // backend sends model per run
  ] });
  {
    const w = seatOf("น้องไวท์");
    // renderRail checks st.model first, then agentModel() cache
    ok(badgeOf(w) && badgeOf(w).textContent === "opus-4-8",
      "badge uses the run's model field when backend provides it (st.model)");
  }

  // ---- 5. no model in cache → badge text is empty (no crash, no "null") ---
  console.log("\n[5] no model configured → badge element exists but text is empty (no 'null')");
  sandbox.route({ type: "models.changed", default: null, perAgent: {} });
  {
    const w = seatOf("น้องไวท์");
    // restore a status with no model field so it falls back to cache
    sandbox.route({ type: "agent.status", agents: [
      { agentId: "น้องไวท์", status: "working", project: "bagidea", task: "test" },
    ] });
    const badge = badgeOf(seatOf("น้องไวท์"));
    ok(badge && badge.textContent !== "null" && badge.textContent !== "undefined",
      "no model configured → badge text is not 'null'/'undefined'");
  }

  console.log(`\n${fails === 0 ? "ALL PASS" : "HAS FAILURES"} — ${passes} passed, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error("E2E CRASHED:", e); process.exit(2); });
