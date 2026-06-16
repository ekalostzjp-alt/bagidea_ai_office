// Headless e2e for the 🟢 Hub-icon project-status feature in overlay.html.
//
// What it proves (no browser, no daemon):
//  1. boot snapshot: GET /agents/status (stubbed) paints the right pills.
//  2. live ws event {type:"agent.status",agents:[...]} updates the RIGHT seat
//     to the RIGHT state — working → green ring (.sworking) + "⚙ <project>" pill
//     + full task in the hover title; idle → quiet, no pill.
//  3. real-time flip (working → idle) clears the pill — no STALE cache left over.
//  4. status for an agent the roster hasn't seated yet still creates its seat.
//  5. a REPLAY event is ignored (snapshot is authoritative — no stale repaint).
//  6. malformed / partial payloads never throw.
//
// Strategy: run overlay.html's real <script> in a vm against a tiny DOM that
// actually RETAINS the node tree (unlike the pure-Proxy fake in
// picker-headless-e2e.js), so we can inspect the rendered rail and assert.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

// ---- minimal but tree-RETAINING DOM ---------------------------------------
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
      return makeEl(); // unknown member → forgiving callable element
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

// ---- controllable fetch ----------------------------------------------------
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

// ---- load overlay.html's script -------------------------------------------
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
const isWorking = (s) => !!s && s.classList.contains("sworking");
const isIdle = (s) => !!s && s.classList.contains("sidle");
const pillOf = (s) => (s ? s.children.find((c) => c.__isEl && c.classList && c.classList.contains("projtag")) : null);

// seat the team first (mirrors the daemon's roster.sync)
sandbox.route({ type: "roster.sync", agents: { momo: { name: "Momo", role: "Engineer" }, black: { name: "Black", role: "Backend" } } });

async function main() {
  // ---- 1. boot snapshot via GET /agents/status ----------------------------
  console.log("\n[1] GET /agents/status snapshot paints pills");
  fetchImpl = async (url) => {
    if (String(url).includes("/agents/status"))
      return { ok: true, status: 200, json: async () => ({ agents: [
        { agentId: "momo", status: "working", project: "momo_project", task: "สร้างหน้า dashboard ใหม่" },
        { agentId: "black", status: "idle", project: "", task: "" },
      ] }) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  await sandbox.loadAgentStatus();
  {
    const m = seatOf("momo"), b = seatOf("black");
    ok(isWorking(m), "momo seat has the green working ring (.sworking)");
    ok(pillOf(m) && pillOf(m).textContent === "⚙ momo_project", "momo shows pill '⚙ momo_project'");
    ok(m.title.includes("สร้างหน้า dashboard ใหม่"), "momo hover title carries the FULL task");
    ok(isIdle(b) && !isWorking(b), "black seat is quiet (idle, no working ring)");
    ok(!pillOf(b), "black shows NO project pill while idle");
  }

  // ---- 2. live ws event updates the RIGHT seat ----------------------------
  console.log("\n[2] live ws agent.status flips black → working, momo → idle");
  sandbox.route({ type: "agent.status", agents: [
    { agentId: "black", status: "working", project: "tookjorThai", task: "เชื่อม API /agents/status" },
    { agentId: "momo", status: "idle", project: "", task: "" },
  ] });
  {
    const m = seatOf("momo"), b = seatOf("black");
    ok(isWorking(b), "black is now working");
    ok(pillOf(b) && pillOf(b).textContent === "⚙ tookjorThai", "black pill is '⚙ tookjorThai'");
    ok(b.title.includes("เชื่อม API /agents/status"), "black hover title carries its task");
    // ---- 3. no STALE pill left on momo after flip to idle ----
    ok(!isWorking(m) && isIdle(m), "momo flipped to idle (ring gone)");
    ok(!pillOf(m), "momo's old 'momo_project' pill is GONE — no stale cache");
  }

  // ---- 4. 🛡 scene gate: a status for an UNAPPROVED agent must NOT seat -----
  // (contract flip, overlay #12) An agent id that isn't in the registry/roster
  // — a stray run, a half-removed hire — must never materialize a sprite. The
  // status is still cached (the pill paints once roster.sync seats it), but no
  // character appears until the CEO has approved it.
  console.log("\n[4] status for an UNAPPROVED agent does NOT create a sprite (scene gate)");
  sandbox.route({ type: "agent.status", agents: [
    { agentId: "ghost", status: "working", project: "secret_lab", task: "วิจัยลับ" },
  ] });
  ok(!seatOf("ghost"), "ghost gets NO seat — not in the approved roster");
  // …and the moment roster.sync approves it, its seat appears (and a later
  // status paints the pill) — proving the gate keys on approval, not identity.
  sandbox.route({ type: "roster.sync", agents: {
    momo: { name: "Momo", role: "Engineer" }, black: { name: "Black", role: "Backend" },
    ghost: { name: "Ghost", role: "Researcher" },
  } });
  sandbox.route({ type: "agent.status", agents: [
    { agentId: "ghost", status: "working", project: "secret_lab", task: "วิจัยลับ" },
  ] });
  {
    const g = seatOf("ghost");
    ok(!!g, "ghost seats once it's in the approved roster");
    ok(g && isWorking(g) && pillOf(g) && pillOf(g).textContent === "⚙ secret_lab", "ghost shows its pill after approval");
  }

  // ---- 5. REPLAY event is ignored -----------------------------------------
  console.log("\n[5] replay event must NOT repaint (snapshot is authoritative)");
  sandbox.route({ type: "agent.status", replay: true, agents: [
    { agentId: "black", status: "idle", project: "", task: "" },
  ] });
  ok(isWorking(seatOf("black")), "black stays working — replay was ignored");

  // ---- 6. malformed payloads never throw ----------------------------------
  console.log("\n[6] malformed / partial payloads are safe");
  let threw = false;
  try {
    sandbox.route({ type: "agent.status", agents: null });
    sandbox.route({ type: "agent.status" });
    sandbox.route({ type: "agent.status", agents: [null, {}, { status: "working" }, "nope"] });
  } catch (e) { threw = true; console.log("    threw:", e && e.message); }
  ok(!threw, "garbage payloads handled without throwing");
  ok(isWorking(seatOf("black")), "garbage didn't disturb black's good state");

  // ---- 7. THAI agentIds — the REAL production roster ----------------------
  // The live registry keys agents by Thai strings ("น้องไวท์", "แบล็ค", …).
  // This mirrors the exact GET /agents/status payload seen on the live daemon
  // (curl 2026-06-10), including main working with project:null → pill "⚙ —".
  console.log("\n[7] Thai agentIds map to the right seats (live payload mirror)");
  sandbox.route({ type: "roster.sync", agents: {
    "main": { name: "บาร์ท", role: "Director", avatar: 7 },
    "ceo": { name: "คุณหนึ่ง", role: "Chairman", avatar: 8 },
    "มิสเตอร์-n": { name: "มิสเตอร์ N", avatar: 1 },
    "น้องไวท์": { name: "น้องไวท์", avatar: 4 },
    "แบล็ค": { name: "แบล็ค", avatar: 6 },
  } });
  sandbox.route({ type: "agent.status", agents: [
    { agentId: "main", status: "working", project: null, task: "👑 (CEO) เมื่อจบงานแล้ว ต้อง Scan + Mapping" },
    { agentId: "ceo", status: "idle", project: null, task: null },
    { agentId: "มิสเตอร์-n", status: "idle", project: null, task: null },
    { agentId: "น้องไวท์", status: "working", project: "momo_project", task: "แก้ hub icon pills" },
    { agentId: "แบล็ค", status: "idle", project: null, task: null },
  ] });
  {
    const w = seatOf("น้องไวท์"), m = seatOf("main"), b = seatOf("แบล็ค"), n = seatOf("มิสเตอร์-n");
    ok(!!w && !!m && !!b && !!n, "every Thai-id seat exists (no duplicate/orphan seats created)");
    ok(isWorking(w), "น้องไวท์ has the working ring");
    ok(pillOf(w) && pillOf(w).textContent === "⚙ momo_project", "น้องไวท์ pill is '⚙ momo_project'");
    ok(w && w.title.includes("แก้ hub icon pills"), "น้องไวท์ hover title carries the task");
    ok(isWorking(m), "main (บาร์ท) shows working");
    ok(pillOf(m) && pillOf(m).textContent === "⚙ —", "main with project:null shows '⚙ —' (not crash/blank)");
    ok(isIdle(b) && !pillOf(b), "แบล็ค idle — no pill");
    ok(isIdle(n) && !pillOf(n), "มิสเตอร์-n idle — no pill");
    // a Thai id must land on its EXISTING seat, not mint a lookalike sibling
    const whiteSeats = rail().children.filter((s) => s && s.dataset && s.dataset.id === "น้องไวท์");
    ok(whiteSeats.length === 1, "exactly ONE seat for น้องไวท์ — status row merged onto the existing icon");
  }

  console.log(`\n${fails === 0 ? "ALL PASS" : "HAS FAILURES"} — ${passes} passed, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error("E2E CRASHED:", e); process.exit(2); });
