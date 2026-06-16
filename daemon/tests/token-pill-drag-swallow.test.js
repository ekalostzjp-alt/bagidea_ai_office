// token-pill-drag-swallow.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Regression for the silent "Token Usage" header pill.
//
// ROOT CAUSE: #tokPill is a <span> (not <button>/.winbtn) living INSIDE the
// draggable #titlebar. The titlebar mousedown handler fires shellPost("drag-overlay")
// for any target that isn't a button/.winbtn → the native shell's overlay.drag_window()
// enters the OS window-move loop on mousedown and SWALLOWS the click, so the pill's
// onclick (= openTokens) never runs and the Token/quota modal never opens. Every
// other header control is a <button>/.winbtn (excluded), and the overflow-menu
// #tokBtn lives at body level — which is why ONLY the header pill was dead.
//
// FIX: the titlebar mousedown guard must also exclude #tokPill so its click survives.
//
// This test extracts the REAL guard selector from overlay.html and proves:
//   (1) a mousedown ON the pill does NOT start a drag (click survives);
//   (2) a mousedown on bare titlebar chrome (the logo/text) STILL starts a drag;
//   (3) the header pill + overflow item are both wired to openTokens, and a click
//       on each flips #modal to the "open" state.
//
// Run:  node daemon/tests/token-pill-drag-swallow.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const OVERLAY = path.join(__dirname, "..", "overlay.html");
const html = fs.readFileSync(OVERLAY, "utf8");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

// ── 1+2. the titlebar drag guard ───────────────────────────────────────────
// Pull the exact selector the titlebar mousedown handler tests against.
const guardM = html.match(/titlebar"\)\.addEventListener\("mousedown"[\s\S]*?\.closest\((["'])([^"']+)\1\)/);
console.log("1) titlebar drag guard excludes the pill");
ok(!!guardM, "found titlebar mousedown closest(...) guard");
const guardSel = guardM ? guardM[2] : "";
// emulate e.target.closest(sel) for each candidate target using its tag/id/class.
const matches = (sel, el) =>
  sel.split(",").map((s) => s.trim()).some((s) => {
    if (s.startsWith("#")) return el.id === s.slice(1);
    if (s.startsWith(".")) return (el.cls || []).includes(s.slice(1));
    return el.tag === s;                                  // bare tag e.g. "button"
  });
const pill = { tag: "span", id: "tokPill", cls: [] };
const logo = { tag: "span", id: "", cls: ["logo"] };     // bare titlebar chrome
const setBtn = { tag: "button", id: "setBtn", cls: [] };
const maxBtn = { tag: "div", id: "maxBtn", cls: ["winbtn"] };
// guard is used as: if (!e.target.closest(guardSel)) startDrag()  → drag starts when NO match
const dragStarts = (el) => !matches(guardSel, el);
ok(!dragStarts(pill), "mousedown on #tokPill does NOT start a window drag (click survives)");
ok(dragStarts(logo), "mousedown on bare titlebar chrome STILL starts a drag");
ok(!dragStarts(setBtn), "buttons stay excluded from drag (regression guard)");
ok(!dragStarts(maxBtn), ".winbtn stays excluded from drag (regression guard)");

// ── 3. both token controls open the shared modal ───────────────────────────
console.log("2) header pill + overflow item open the Token/quota modal");
const NODES = new Map();
const MISSING = [];
const events = [];
const noop = () => {};
function cl() { const s = new Set(); return { add:(...a)=>a.forEach(x=>s.add(x)), remove:(...a)=>a.forEach(x=>s.delete(x)), toggle:(c,f)=>{const h=s.has(c);const on=f===undefined?!h:f;on?s.add(c):s.delete(c);return on;}, contains:(c)=>s.has(c) }; }
function node(tag, id) {
  return { _tag: tag, id: id || "", _text: "", _html: "", className: "", title: "", disabled: false, value: "",
    classList: cl(), style: new Proxy({}, { get:()=>"", set:()=>true }), dataset: {}, _listeners: {},
    onclick: null, children: [],
    appendChild(c){this.children.push(c);return c;}, append(...c){this.children.push(...c);}, prepend(...c){this.children.unshift(...c);},
    removeChild(c){const i=this.children.indexOf(c);if(i>=0)this.children.splice(i,1);return c;}, remove(){}, insertBefore(c){this.children.push(c);return c;},
    addEventListener(t,f){(this._listeners[t]=this._listeners[t]||[]).push(f);}, removeEventListener(){},
    setAttribute(){}, getAttribute(){return null;}, removeAttribute(){}, hasAttribute(){return false;},
    querySelector(s){return resolve(s);}, querySelectorAll(){return [];}, closest(){return null;}, contains(){return false;},
    focus(){}, blur(){}, click(){if(this.onclick)this.onclick({target:this,stopPropagation:noop,preventDefault:noop});},
    scrollIntoView(){}, getBoundingClientRect(){return {top:0,left:0,width:100,height:20,right:100,bottom:20};},
    cloneNode(){return node(this._tag);}, getContext(){return null;},
    set textContent(v){this._text=String(v);}, get textContent(){return this._text;},
    set innerHTML(v){this._html=String(v);}, get innerHTML(){return this._html;},
    set innerText(v){this._text=String(v);}, get innerText(){return this._text;},
    get firstChild(){return this.children[0]||null;}, get lastChild(){return this.children[this.children.length-1]||null;},
    get parentNode(){return null;}, get parentElement(){return null;},
    get offsetHeight(){return 100;}, get scrollHeight(){return 100;}, get clientHeight(){return 100;}, scrollTop: 0 };
}
for (const m of html.matchAll(/id="([^"]+)"/g)) if (!NODES.has(m[1])) NODES.set(m[1], node("div", m[1]));
function resolve(sel) { if (typeof sel !== "string") return null; const m = sel.match(/#([A-Za-z0-9_-]+)/); if (m && NODES.has(m[1])) return NODES.get(m[1]); return node("div"); }
const document = {
  getElementById: (id) => { if (!NODES.has(id)) { MISSING.push(id); return null; } return NODES.get(id); },
  querySelector: resolve, querySelectorAll: () => [], createElement: (t) => node(t),
  createTextNode: (t) => ({ _text: String(t), nodeType: 3 }), createDocumentFragment: () => node("fragment"),
  addEventListener: (t, f) => events.push({ type: t, fn: f }), removeEventListener: noop,
  documentElement: node("html"), head: node("head"), body: node("body"), cookie: "", hidden: false, visibilityState: "visible",
};
const localStore = {};
const sandbox = {
  document,
  localStorage: { getItem: (k) => (k in localStore ? localStore[k] : null), setItem: (k, v) => { localStore[k] = String(v); }, removeItem: (k) => { delete localStore[k]; } },
  navigator: { userAgent: "test", platform: "Win32", language: "th" },
  location: { href: "http://127.0.0.1:8787/overlay.html", search: "", hash: "", reload: noop, origin: "http://127.0.0.1:8787" },
  console: { log: noop, warn: noop, error: noop, info: noop },
  fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve("{}") }),
  WebSocket: function () { return new Proxy({ readyState: 1, send: noop, close: noop, addEventListener: noop, removeEventListener: noop }, { get: (t, p) => (p in t ? t[p] : noop), set: () => true }); },
  setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
  requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
  alert: noop, confirm: () => true, prompt: () => null,
  matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
  Audio: function () { return { play: () => Promise.resolve(), pause: noop, addEventListener: noop }; },
  Image: function () { return node("img"); },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: noop }, Blob: function () { return {}; }, FormData: function () { return { append: noop }; },
  Notification: Object.assign(function () {}, { permission: "granted", requestPermission: () => Promise.resolve("granted") }),
  performance: { now: () => 0 },
  MutationObserver: function () { return { observe: noop, disconnect: noop }; },
  ResizeObserver: function () { return { observe: noop, disconnect: noop }; },
  IntersectionObserver: function () { return { observe: noop, disconnect: noop }; },
};
sandbox.addEventListener = (t, f) => events.push({ type: t, fn: f });
sandbox.removeEventListener = noop;
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;

// main <script> body = the SECOND <script>…</script> block (derive bounds so the
// test survives line-number drift from edits above it).
const open2 = html.indexOf("<script>", html.indexOf("<script>") + 1);
const close2 = html.indexOf("</script>", open2);
const script = html.slice(open2 + "<script>".length, close2);
let initErr = null;
vm.createContext(sandbox);
try { vm.runInContext(script, sandbox, { filename: "overlay-main.js" }); } catch (e) { initErr = e; }

ok(!initErr, "overlay init runs without error" + (initErr ? " — " + initErr.message : ""));
ok([...new Set(MISSING)].length === 0, "no getElementById(null) at init (every referenced id exists)");
const modal = NODES.get("modal"), pillEl = NODES.get("tokPill"), btnEl = NODES.get("tokBtn");
ok(typeof pillEl.onclick === "function", "#tokPill has an onclick bound");
ok(typeof btnEl.onclick === "function", "#tokBtn has an onclick bound");

function click(el) { modal.classList.remove("open"); el.onclick({ target: el, stopPropagation: noop, preventDefault: noop }); return modal.classList.contains("open"); }
ok(click(pillEl), "clicking #tokPill opens #modal");
ok(click(btnEl), "clicking #tokBtn opens #modal");

console.log("\n" + (fail ? "❌ FAIL " : "✅ PASS ") + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
