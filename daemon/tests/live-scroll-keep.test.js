// live-scroll-keep.test.js — proves the Status panel keeps the CEO's scroll
// position when a new event re-renders it. The bug: renderClaudeLive() rebuilds
// the whole panel with box.innerHTML="" on every task.step/activity event, which
// destroys the scrollable .nowlist and snaps scrollTop back to 0 — yanking
// anyone who scrolled down to inspect a run back to the top.
//
// We pull the REAL renderClaudeLive() out of overlay.html and run it on a
// recording DOM shim that tracks scrollTop and resolves querySelector(".nowlist")
// — no jsdom needed. Scenario: render with several live runs, scroll the list
// down, fire another render (= new event), assert scrollTop survived.
//
// Run:  node daemon/tests/live-scroll-keep.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const OVERLAY = path.join(__dirname, "..", "overlay.html");
const src = fs.readFileSync(OVERLAY, "utf8");

// --- pull one `function NAME(...) { ... }` out of the source by brace-match ---
function extract(name) {
  const sig = "function " + name + "(";
  const at = src.indexOf(sig);
  if (at < 0) throw new Error("function not found in overlay.html: " + name);
  let i = src.indexOf("{", at), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) throw new Error("unbalanced braces for " + name);
  return src.slice(at, end);
}

// --- recording DOM shim: tracks children, className, scrollTop; querySelector
//     resolves a ".class" token against the descendant tree (depth-first). ----
function makeNode(tag) {
  const node = {
    _tag: tag, children: [], _text: "", className: "", id: "", title: "",
    style: {}, onclick: null, scrollTop: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { for (const c of cs) this.children.push(c); },
    set innerHTML(v) { if (v === "") this.children = []; },
    get innerHTML() { return ""; },
    querySelector(sel) {
      const cls = sel[0] === "." ? sel.slice(1) : null;
      const match = (n) => cls
        ? (" " + (n.className || "") + " ").includes(" " + cls + " ")
        : false;
      const walk = (n) => {
        for (const c of (n.children || [])) {
          if (match(c)) return c;
          const deep = walk(c);
          if (deep) return deep;
        }
        return null;
      };
      return walk(this);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
  };
  return node;
}
const REGISTRY = {};
const bodyNode = makeNode("body");
const document = {
  createElement: (t) => makeNode(t),
  createTextNode: (t) => ({ _text: String(t), nodeType: 3 }),
  getElementById: (id) => (REGISTRY[id] = REGISTRY[id] || makeNode("#" + id)),
  body: bodyNode,
  addEventListener() {},
};

// --- sandbox: the real renderClaudeLive + minimal stubs for collaborators -----
const CLAUDE_LIVE = new Map();
const LIVE_STEPS = new Map();
const STEP_LIVE = new Set();
const sandbox = {
  document,
  CLAUDE_LIVE, LIVE_STEPS, STEP_LIVE,
  LIVE_STEP_CAP: 8,
  LIVE_STUCK_FALLBACK_MS: 130000,
  NOW_OPEN: true,
  _liveTimer: null,
  _liveTick() {},
  nameOf: (a) => String(a || ""),
  face() {},
  fmtClock: () => "00:01",
  agoStr: () => "1 วิ",
  setTarget() {},
  setTimeout: () => 1,   // don't actually schedule the realtime clock tick
  Date,
  console,
};
vm.createContext(sandbox);
vm.runInContext(extract("renderClaudeLive"), sandbox);

// seed several live runs so the .nowlist has rows (and would overflow on a real
// screen → scrollable). startedAt epoch is fixed so render is deterministic.
const now = Date.now();
for (let i = 1; i <= 6; i++) {
  const key = "task-" + i;
  CLAUDE_LIVE.set(key, {
    agent: "agent" + i, live: "Claude Live " + i, slot: i,
    name: "นัท" + i, project: "bagidea", label: "งาน " + i,
    startedAt: now - i * 1000, state: "working",
    lastTool: "Edit", lastDetail: "server.js", steps: [],
    lastToolAgo: 2000, syncAt: now,
  });
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

// 1) first render seats the panel + builds the .nowlist
sandbox.renderClaudeLive();
const box = REGISTRY["nowStrip"];
const list1 = box.querySelector(".nowlist");
ok(!!list1, "first render builds a .nowlist under #nowStrip");
ok(list1 && list1.children.length === 6, "all 6 live runs rendered as rows");

// 2) CEO scrolls down the process list to inspect a lower run
list1.scrollTop = 96;

// 3) a new task.step event fires → another full re-render (innerHTML="" rebuild)
sandbox.renderClaudeLive();
const list2 = box.querySelector(".nowlist");
ok(list2 && list2 !== list1, "re-render replaces the .nowlist with a fresh node (old one destroyed)");
ok(list2 && list2.scrollTop === 96, "scroll offset (96) is restored onto the rebuilt list — no jump to top");

// 4) a fresh panel (scrollTop 0) must NOT get a bogus scroll forced on it
const box2 = REGISTRY["feedTasks"];
const fl = box2.querySelector(".nowlist");
ok(fl && fl.scrollTop === 0, "an untouched list stays at the top (no spurious restore)");

console.log("\n" + (fail ? "FAIL" : "PASS") + ` — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
