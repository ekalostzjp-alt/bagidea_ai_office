// Headless e2e for the 🧑‍💼 NPC hire-approval modal + 🛡 scene gate in
// overlay.html. (same vm-DOM harness as tools/agent-status-e2e.js — no browser,
// no daemon, no tokens.)
//
// Regression under test (overlay #12) — the CEO must ALWAYS get the approval
// modal, even across the overlay's known stale-cache / missed-event traps:
//  1. a live ws {type:"npc.request",…} pops #npcModal with the proposal —
//     proves the handler is wired in the running build, not just present.
//  2. 🔁 missed-event recovery: the npc.request broadcast is fire-and-forget
//     (server.js:5394, never replayed). A window that reloaded/reconnected when
//     it fired would lose the card forever. On (re)connect repopMissedNpc()
//     re-derives pending approvals from GET /npc/proposals and re-pops the
//     modal: 1 pending → its card, many → the revisit list.
//  3. the re-pop must NOT stomp a card already on screen (guard).
//  4. 🛡 scene gate: a run/status carrying an agent id that is NOT an approved
//     registry member must NEVER seat a sprite; it appears only once roster.sync
//     approves it.
//
// Exit 0 = pass, 1 = fail.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

// ---- minimal but tree-RETAINING DOM (same as agent-status-e2e.js) ----------
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

// ---- controllable fetch (GET /npc/proposals + POST /npc/decision) -----------
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

const npcModal = () => get$("npcModal");
const npcCard = () => get$("npcCard");
const modalOpen = () => npcModal().classList.contains("open");
const cardText = () => npcCard().textContent;
const rail = () => get$("rail");
const seatOf = (id) => rail().children.find((s) => s && s.dataset && s.dataset.id === id);

// GET /npc/proposals returns whatever this is set to; POST /npc/decision → ok.
let PROPOSALS = [];
fetchImpl = async (url, opts) => {
  const u = String(url);
  if (u.includes("/npc/proposals"))
    return { ok: true, status: 200, json: async () => ({ proposals: PROPOSALS }) };
  if (u.includes("/npc/decision"))
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  if (u.includes("/agents/status"))
    return { ok: true, status: 200, json: async () => ({ agents: [] }) };
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};

const PROP_A = { requestId: "req-A", name: "น้องเขียว", role: "QA Engineer",
  requester: "main", why: "ต้องมีคนคุมคุณภาพก่อนปล่อย", benefit: "บั๊กหลุดน้อยลง",
  model: "claude-sonnet-4-6", skills: ["test", "review"] };
const PROP_B = { requestId: "req-B", name: "น้องฟ้า", role: "DevOps",
  requester: "แบล็ค", why: "deploy เริ่มซับซ้อน", benefit: "ปล่อยของไวขึ้น" };

// seat the approved roster first (mirrors the daemon's roster.sync)
sandbox.route({ type: "roster.sync", agents: {
  "main": { name: "บาร์ท", role: "Director", avatar: 7 },
  "ceo": { name: "คุณหนึ่ง", role: "Chairman", avatar: 8 },
  "แบล็ค": { name: "แบล็ค", avatar: 6 },
  "น้องไวท์": { name: "น้องไวท์", avatar: 4 },
} });

async function main() {
  // ---- 1. a live npc.request pops the modal --------------------------------
  console.log("\n[1] live ws npc.request → #npcModal pops with the proposal");
  PROPOSALS = [PROP_A];     // server has also persisted it
  sandbox.route({ type: "npc.request", ...PROP_A });
  ok(modalOpen(), "#npcModal is open after the npc.request event");
  ok(cardText().includes("น้องเขียว"), "card shows the proposed name");
  ok(cardText().includes("QA Engineer"), "card shows the proposed role");
  ok(cardText().includes("ขออนุมัติจ้าง"), "card is the approval card (not the list)");

  // a replay of the SAME event must not re-queue / disturb the open card
  sandbox.route({ type: "npc.request", replay: true, ...PROP_A });
  ok(modalOpen() && cardText().includes("น้องเขียว"), "replay npc.request ignored — card unchanged");

  // CEO closes WITHOUT deciding (the ✕ / backdrop) → proposal still pending
  sandbox.closeNpc(false);
  ok(!modalOpen(), "modal closed after dismiss (no verdict sent)");

  // ---- 2. missed-event recovery on (re)connect -----------------------------
  // Simulate the bug: the window NEVER received the npc.request (it was mid
  // reload when the fire-and-forget broadcast went out). The only trace is the
  // persisted proposal. repopMissedNpc() is exactly what ws.onopen calls.
  console.log("\n[2] reconnect with a pending proposal → modal re-pops from /npc/proposals");
  PROPOSALS = [PROP_A];
  await sandbox.repopMissedNpc();
  ok(modalOpen(), "#npcModal re-popped on reconnect — missed event recovered");
  ok(cardText().includes("น้องเขียว"), "re-popped card carries the pending proposal");

  // ---- 3. guard: re-pop must not stomp a card already on screen ------------
  console.log("\n[3] re-pop is a no-op while a card is already open (no stomp)");
  PROPOSALS = [PROP_B];     // a DIFFERENT proposal is now pending too
  await sandbox.repopMissedNpc();
  ok(modalOpen() && cardText().includes("น้องเขียว"),
    "still showing the first card — re-pop did not replace it");
  sandbox.closeNpc(false);

  // many pending → reconnect opens the REVISIT LIST, not a single card
  console.log("\n[3b] reconnect with MANY pending → opens the revisit list");
  PROPOSALS = [PROP_A, PROP_B];
  await sandbox.repopMissedNpc();
  ok(modalOpen(), "#npcModal open for the multi-pending case");
  ok(cardText().includes("รออนุมัติ"), "shows the 'NPC รออนุมัติ' revisit list");
  ok(cardText().includes("น้องเขียว") && cardText().includes("น้องฟ้า"),
    "both pending proposals are listed");
  sandbox.closeNpc(false);

  // nothing pending → reconnect opens nothing
  console.log("\n[3c] reconnect with zero pending → modal stays closed");
  PROPOSALS = [];
  await sandbox.repopMissedNpc();
  ok(!modalOpen(), "no pending proposals → no modal");

  // ---- 4. 🛡 scene gate: unapproved agent never seats a sprite -------------
  console.log("\n[4] scene gate: a run with an UNKNOWN agent id renders no sprite");
  ok(!seatOf("intruder"), "precondition: no 'intruder' seat exists");
  sandbox.route({ type: "task.started", agent: "intruder", task: "t-x", title: "งานลึกลับ" });
  ok(!seatOf("intruder"), "task.started for unapproved 'intruder' did NOT seat a sprite");
  sandbox.route({ type: "agent.status", agents: [
    { agentId: "intruder", status: "working", project: "ghost_lab", task: "แอบทำงาน" },
  ] });
  ok(!seatOf("intruder"), "agent.status for unapproved 'intruder' did NOT seat a sprite either");
  // approved members are unaffected — the gate keys on approval, not noise
  ok(!!seatOf("แบล็ค") && !!seatOf("main"), "approved roster members still have their seats");

  // once approved (roster.sync), the very same id is allowed to appear
  console.log("\n[4b] after approval (roster.sync), the same id may seat");
  sandbox.route({ type: "roster.sync", agents: {
    "main": { name: "บาร์ท", role: "Director", avatar: 7 },
    "ceo": { name: "คุณหนึ่ง", role: "Chairman", avatar: 8 },
    "แบล็ค": { name: "แบล็ค", avatar: 6 },
    "น้องไวท์": { name: "น้องไวท์", avatar: 4 },
    "intruder": { name: "อินทรูเดอร์", role: "Specialist", avatar: 2 },
  } });
  ok(!!seatOf("intruder"), "approved 'intruder' now has a seat");

  console.log(`\n${fails === 0 ? "ALL PASS" : "HAS FAILURES"} — ${passes} passed, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error("E2E CRASHED:", e); process.exit(2); });
