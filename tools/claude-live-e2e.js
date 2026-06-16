// Headless e2e for the 💻 "Claude Live N" run lines in overlay.html.
// (builds on the vm-DOM harness of tools/agent-status-e2e.js)
//
// Contract under test: docs/agent-live-status.contract.md §"Live Log v2" —
// ws {type:"activity.update", running:[row,…]} where each row is ONE run:
// {agent, task, name, label, project, startedAt, lastTool, lastAt,
//  slot, live, elapsedMs, lastToolAgo, state:"working"|"stuck"}.
// Every event is a FULL snapshot (backend re-broadcasts every ~5s).
//
// What it proves (no browser, no daemon):
//  1. a running[] snapshot renders one line per run, sorted by slot, under the
//     merged "กำลังทำ N งาน" summary header, in BOTH containers (#nowStrip
//     normal mode, #feedTasks feedmode):
//     "💻 Claude Live N · <name> · ⚙ <project> · <label> · ⏱ mm:ss".
//  2. the ⏱ clock TICKS client-side between the backend's 5s re-broadcasts
//     (fake clock + re-render = what the 1s timer does in the real overlay).
//  3. state:"stuck" flips that row (and only that row) to the warning tone
//     (.stuck class + "⚠️ อาจค้าง" badge incl. quiet-time from lastToolAgo).
//  4. snapshot semantics: a run missing from the next event drops its line;
//     an empty running[] turns the strip off — no stale rows ever.
//  5. graceful degrade: rows missing the v2 extras (slot/live/elapsedMs/state)
//     still render with composed labels and a first-sight clock.
//  6. replay events are ignored; malformed payloads never throw.
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

// ---- ⏰ controllable clock — the whole point of this harness ----------------
// overlay.html reads Date.now() through the sandbox global, so swapping Date
// for a frozen fake lets the test advance time deterministically and assert
// the ⏱ clock actually walks.
const RealDate = Date;
let FAKE_NOW = 1_780_000_000_000;
function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(FAKE_NOW); }
FakeDate.now = () => FAKE_NOW;
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;
FakeDate.prototype = RealDate.prototype;

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

// ---- load overlay.html's script --------------------------------------------
const file = path.join(__dirname, "..", "daemon", "overlay.html");
const html = fs.readFileSync(file, "utf8");
const open = html.indexOf("<script>");
const startLine = html.slice(0, open).split("\n").length;
const body = html.slice(open + "<script>".length, html.lastIndexOf("</script>"));
const padded = "\n".repeat(startLine) + body;

vm.createContext(sandbox);
vm.runInContext(padded, sandbox, { filename: "overlay.html", lineOffset: 0 });

// ---- assertion helpers -------------------------------------------------------
let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; console.log("  ✓ " + msg); } else { fails++; console.log("  ✗ FAIL: " + msg); } }

// merged status panel: the runs now live in #nowStrip (normal) / #feedTasks
// (feedmode), under a "กำลังทำ N งาน" summary header (.nowsum) inside a
// collapsible .nowlist. Single source = activity.update {running}.
const strip = () => get$("nowStrip");
const feed = () => get$("feedTasks");
const sumOf = (box) => box.children.find((c) => c && c.classList && c.classList.contains("nowsum"));
const listOf = (box) => box.children.find((c) => c && c.classList && c.classList.contains("nowlist"));
// each run is a .livewrap holding a .liverow header (clock/label/warn) + a
// .livesteps process trail, seated inside the .nowlist. Treat the wrap as "the
// row"; reach into the header for the clock/warn parts so assertions keep meaning.
const rowsOf = (box) => { const l = listOf(box); return l ? l.children.filter((c) => c && c.classList && c.classList.contains("livewrap")) : []; };
const headOf = (wrap) => wrap.children.find((c) => c.__isEl && c.classList && c.classList.contains("liverow")) || wrap;
const stepsOf = (wrap) => wrap.children.find((c) => c.__isEl && c.classList && c.classList.contains("livesteps"));
const stepChips = (wrap) => { const st = stepsOf(wrap); return st ? st.children.filter((c) => c.classList && c.classList.contains("step")) : []; };
function partOf(wrap, cls) {
  for (const c of wrap.children) {
    if (c.__isEl && c.classList && c.classList.contains(cls)) return c;
    if (c.children) for (const g of c.children) if (g.__isEl && g.classList && g.classList.contains(cls)) return g;
  }
  return undefined;
}
const lineOf = (wrap) => headOf(wrap).children.map((c) => c.textContent || "").join(" ");

// helper: a full backend-shaped row (server.js activitySnapshot())
const T0 = FAKE_NOW;
function row(agent, task, label, project, slot, elapsedMs, lastToolAgo, state) {
  return { agent, task, name: agent, label, project,
    startedAt: FAKE_NOW - elapsedMs, lastTool: "Bash", lastAt: FAKE_NOW - lastToolAgo,
    slot, live: "Claude Live " + slot, elapsedMs, lastToolAgo, state };
}

// seat the real production roster (mirrors the daemon's roster.sync)
sandbox.route({ type: "roster.sync", agents: {
  "main": { name: "บาร์ท", role: "Director", avatar: 7 },
  "ceo": { name: "คุณหนึ่ง", role: "Chairman", avatar: 8 },
  "มิสเตอร์-n": { name: "มิสเตอร์ N", avatar: 1 },
  "น้องไวท์": { name: "น้องไวท์", avatar: 4 },
  "แบล็ค": { name: "แบล็ค", avatar: 6 },
} });

async function main() {
  // ---- 1. running[] snapshot renders Claude Live lines, sorted by slot ------
  console.log("\n[1] running[] snapshot → 'Claude Live N' lines in BOTH containers");
  sandbox.route({ type: "activity.update", running: [
    row("แบล็ค", "t-b1", "wire backend fields", "tookjorThai", 2, 95_000, 4_000, "working"),
    row("น้องไวท์", "t-w1", "Claude Live overlay", "tookjorThai", 1, 10_000, 1_000, "working"),
    row("มิสเตอร์-n", "t-n1", "Live Log backend", "tookjorThai", 3, 5_000, 2_000, "working"),
  ] });
  {
    const rs = rowsOf(strip());
    ok(strip().classList.contains("on"), "#nowStrip turned on");
    ok(feed().classList.contains("on"), "#feedTasks (feedmode mirror) turned on too");
    ok(rs.length === 3, "3 runs → 3 lines");
    ok(rowsOf(feed()).length === 3, "feedTasks mirrors the same 3 lines");
    // 🔑 the summary count comes from the SAME running set as the rows below
    ok(sumOf(strip()).textContent.includes("กำลังทำ 3 งาน"),
      "summary header counts the SAME 3 runs (single source of truth)");
    const l1 = lineOf(rs[0]), l2 = lineOf(rs[1]);
    ok(l1.includes("💻 Claude Live 1") && l1.includes("น้องไวท์"), "slot 1 sorts first: " + l1.trim());
    ok(l2.includes("💻 Claude Live 2") && l2.includes("แบล็ค"), "slot 2 second");
    ok(l1.includes("⚙ tookjorThai") && l1.includes("Claude Live overlay"), "line carries ⚙ project + task label");
    ok(partOf(rs[0], "liveclock").textContent === "⏱ 00:10", "slot 1 clock from elapsedMs=10s → '⏱ 00:10'");
    ok(partOf(rs[1], "liveclock").textContent === "⏱ 01:35", "slot 2 clock from elapsedMs=95s → '⏱ 01:35'");
    ok(!rs.some((r) => r.classList.contains("stuck")), "all rows calm (no .stuck)");
  }

  // ---- 2. the clock TICKS client-side ---------------------------------------
  console.log("\n[2] ⏱ ticks client-side between backend re-broadcasts (+65s)");
  FAKE_NOW += 65_000;
  sandbox.renderClaudeLive();   // what the 1s timer does in the real overlay
  {
    const rs = rowsOf(strip());
    ok(partOf(rs[0], "liveclock").textContent === "⏱ 01:15", "slot 1 walked 00:10 → 01:15 with NO new ws event");
    ok(partOf(rs[1], "liveclock").textContent === "⏱ 02:40", "slot 2 walked 01:35 → 02:40");
  }

  // ---- 3. state:"stuck" flips the row to the warning tone -------------------
  console.log("\n[3] state:'stuck' → warning tone + ⚠️ badge on THAT row only");
  sandbox.route({ type: "activity.update", running: [
    row("น้องไวท์", "t-w1", "Claude Live overlay", "tookjorThai", 1, 75_000, 3_000, "working"),
    row("แบล็ค", "t-b1", "wire backend fields", "tookjorThai", 2, 160_000, 130_000, "stuck"),
  ] });
  {
    const rs = rowsOf(strip());
    ok(rs.length === 2, "next snapshot replaces the set (มิสเตอร์-n's run ended → line gone)");
    ok(rs[1].classList.contains("stuck"), "แบล็ค's row flipped to .stuck (amber-red tone)");
    const warn = partOf(rs[1], "livewarn");
    ok(!!warn && warn.textContent.includes("⚠️ อาจค้าง"), "row shows the '⚠️ อาจค้าง' badge");
    ok(warn.textContent.includes("เงียบ") && warn.textContent.includes("2 นาที"),
      "badge carries quiet-time from lastToolAgo (130s → '2 นาที')");
    ok(!rs[0].classList.contains("stuck"), "slot 1 (น้องไวท์) stays calm — tone is per-row");
    ok(rowsOf(feed())[1].classList.contains("stuck"), "feedTasks mirror flipped too");
    const sm = sumOf(strip());
    ok(sm.classList.contains("stuck") && sm.textContent.includes("ค้าง 1"),
      "summary header shows '⚠ ค้าง 1' from the same set");
    ok(sm.textContent.includes("กำลังทำ 2 งาน"), "and the count tracks the new set (2 งาน)");
  }

  // ---- 4. snapshot semantics: lines drop, empty array turns the strip off ---
  console.log("\n[4] runs ending drop their lines — no stale rows");
  sandbox.route({ type: "activity.update", running: [
    row("น้องไวท์", "t-w1", "Claude Live overlay", "tookjorThai", 1, 80_000, 1_000, "working"),
  ] });
  {
    const rs = rowsOf(strip());
    ok(rs.length === 1 && lineOf(rs[0]).includes("น้องไวท์"), "แบล็ค's line is GONE after its run ended");
  }
  sandbox.route({ type: "activity.update", running: [] });
  ok(!strip().classList.contains("on") && rowsOf(strip()).length === 0,
    "empty running[] → strip turns OFF entirely");

  // ---- 5. graceful degrade: rows missing the v2 extras still render ---------
  console.log("\n[5] rows without slot/live/elapsedMs/state still render");
  sandbox.route({ type: "activity.update", running: [
    { agent: "main", task: "t-m1", label: "👑 (CEO) สั่งงาน…", project: null },
    { agent: "มิสเตอร์-n", task: "t-n2", label: "Live Log backend", project: "tookjorThai" },
  ] });
  {
    const rs = rowsOf(strip());
    ok(rs.length === 2, "2 lines render even with no v2 extras");
    ok(lineOf(rs[0]).includes("💻 Claude Live 1") && lineOf(rs[1]).includes("💻 Claude Live 2"),
      "labels composed client-side when `live`/`slot` are missing");
    ok(partOf(rs[0], "liveclock").textContent === "⏱ 00:00", "clock starts from first sight");
    ok(lineOf(rs[0]).includes("⚙ —"), "project:null shows '⚙ —' (not blank/crash)");
    ok(lineOf(rs[0]).includes("บาร์ท"), "missing `name` falls back to the roster name");
    FAKE_NOW += 9_000;
    sandbox.renderClaudeLive();
    ok(partOf(rowsOf(strip())[0], "liveclock").textContent === "⏱ 00:09", "and it ticks: 00:00 → 00:09");
  }

  // ---- 6. replay ignored; malformed payloads never throw --------------------
  console.log("\n[6] replay + garbage safety");
  sandbox.route({ type: "activity.update", replay: true, running: [] });
  ok(rowsOf(strip()).length === 2, "replay event ignored — lines untouched");
  let threw = false;
  try {
    sandbox.route({ type: "activity.update", running: null });
    sandbox.route({ type: "activity.update" });   // legacy single-run touch shape
    sandbox.route({ type: "activity.update", running: [null, {}, "nope",
      { agent: "x", task: "t-x", slot: "junk", elapsedMs: "NaN", state: 42 }] });
  } catch (e) { threw = true; console.log("    threw:", e && e.message); }
  ok(!threw, "garbage payloads handled without throwing");
  {
    const rs = rowsOf(strip());
    ok(rs.length === 1 && lineOf(rs[0]).includes("Claude Live 1"),
      "the one salvageable garbage row rendered; junk fields normalized");
  }

  // ---- 7. 🔧 live process trail — lastTool steps accumulate + de-dupe -------
  console.log("\n[7] 🔧 live process trail — the steps a run actually takes");
  function stepRow(agent, task, tool, lastAt, elapsedMs, slot, state) {
    return { agent, task, name: agent, label: "งาน", project: "tookjorThai",
      startedAt: FAKE_NOW - elapsedMs, lastTool: tool, lastAt,
      slot, live: "Claude Live " + slot, elapsedMs, lastToolAgo: FAKE_NOW - lastAt,
      state: state || "working" };
  }
  sandbox.route({ type: "activity.update", running: [ stepRow("แบล็ค", "t-s1", "Read", FAKE_NOW - 3000, 20_000, 1) ] });
  {
    const w = rowsOf(strip())[0];
    ok(!!stepsOf(w), "a .livesteps trail renders under the run");
    const chips = stepChips(w);
    ok(chips.length === 1 && chips[0].textContent === "Read", "first tool 'Read' → one step chip");
    ok(chips[0].classList.contains("cur"), "the only step is the current step (.cur)");
    ok(chips[0].classList.contains("live"), "current step pulses (.live) while working");
  }
  sandbox.route({ type: "activity.update", running: [ stepRow("แบล็ค", "t-s1", "Grep", FAKE_NOW - 1000, 22_000, 1) ] });
  {
    const chips = stepChips(rowsOf(strip())[0]);
    ok(chips.length === 2 && chips.map((c) => c.textContent).join(",") === "Read,Grep",
      "next tool appends → trail [Read › Grep]");
    ok(chips[1].classList.contains("cur") && !chips[0].classList.contains("cur"),
      "only the latest is .cur (Grep); earlier steps dim");
    const seps = stepsOf(rowsOf(strip())[0]).children.filter((c) => c.classList && c.classList.contains("stepsep"));
    ok(seps.length === 1, "a › separator sits between the two steps");
  }
  // same lastAt re-broadcast (the backend repeats every ~5s) must NOT double-log
  sandbox.route({ type: "activity.update", running: [ stepRow("แบล็ค", "t-s1", "Grep", FAKE_NOW - 1000, 27_000, 1) ] });
  ok(stepChips(rowsOf(strip())[0]).length === 2, "duplicate snapshot (same lastAt) → trail unchanged, de-duped");
  // run ends, then a NEW run reuses the same task key → trail starts clean
  sandbox.route({ type: "activity.update", running: [] });
  sandbox.route({ type: "activity.update", running: [ stepRow("แบล็ค", "t-s1", "Edit", FAKE_NOW - 500, 1_000, 1) ] });
  {
    const chips = stepChips(rowsOf(strip())[0]);
    ok(chips.length === 1 && chips[0].textContent === "Edit",
      "run dropped → its trail forgotten; reused key starts fresh [Edit]");
  }
  // a stuck run keeps the .cur step but stops the pulse (.live)
  sandbox.route({ type: "activity.update", running: [ stepRow("แบล็ค", "t-s1", "Bash", FAKE_NOW - 130_000, 200_000, 1, "stuck") ] });
  {
    const w = rowsOf(strip())[0];
    ok(w.classList.contains("stuck"), "row flips to .stuck");
    const cur = stepChips(w).find((c) => c.classList.contains("cur"));
    ok(!!cur && !cur.classList.contains("live"), "stuck → current step stops pulsing (.cur without .live)");
  }

  console.log(`\n${fails === 0 ? "ALL PASS" : "HAS FAILURES"} — ${passes} passed, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error("E2E CRASHED:", e); process.exit(2); });
