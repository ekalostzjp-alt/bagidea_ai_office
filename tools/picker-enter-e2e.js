// Behavioral e2e for the project picker: simulate the CEO pressing Enter in the
// chat input and assert the pcModal actually ENDS UP visible (class "open").
//
// Why this exists: send() opens the modal synchronously inside #inp's keydown
// handler — but that same Enter keystroke keeps bubbling to the document-level
// handler ("Enter while pcModal is open = confirm"), which can close the modal
// in the very same keystroke, before a single frame is painted. To the user the
// picker "never pops" while the message still silently dispatches.
//
// Harness: run overlay.html's <script> in a vm with a STATEFUL fake DOM —
// real classList sets + recorded event listeners — then replay the browser's
// dispatch order for one Enter keydown: target (#inp) handlers first, then
// document handlers (bubble phase), honoring stopPropagation().
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const file = path.join(__dirname, "..", "daemon", "overlay.html");
const html = fs.readFileSync(file, "utf8");
const open = html.indexOf("<script>");
const startLine = html.slice(0, open).split("\n").length;
const body = html.slice(open + "<script>".length, html.lastIndexOf("</script>"));
const padded = "\n".repeat(startLine) + body;

// ---- stateful element stubs -------------------------------------------------
const ELEMENTS = new Map();   // id/selector → stub (so #inp is the SAME object everywhere)
function makeEl(key) {
  if (key && ELEMENTS.has(key)) return ELEMENTS.get(key);
  const state = { classes: new Set(), handlers: {}, props: { value: "" }, children: {} };
  const fn = function () {};
  const el = new Proxy(fn, {
    get(t, k) {
      if (k === "__state") return state;
      if (k === "classList") return {
        add: (...c) => c.forEach((x) => state.classes.add(x)),
        remove: (...c) => c.forEach((x) => state.classes.delete(x)),
        contains: (c) => state.classes.has(c),
        toggle: (c, on) => { (on === undefined ? !state.classes.has(c) : on) ? state.classes.add(c) : state.classes.delete(c); },
      };
      if (k === "addEventListener") return (type, h) => { (state.handlers[type] = state.handlers[type] || []).push(h); };
      if (k === "removeEventListener") return () => {};
      if (k === "querySelector") return (sel) => makeEl((key || "?") + " " + sel);
      if (k === "querySelectorAll" || k === "getElementsByClassName") return () => [];
      if (k === "style") return new Proxy({}, { get: () => "", set: () => true });
      if (k === "dataset") return state.props.dataset || (state.props.dataset = {});
      if (k in state.props) return state.props[k];
      if (k === "value" || k === "textContent" || k === "innerHTML" || k === "placeholder") return "";
      if (k === "getBoundingClientRect") return () => ({ top: 0, left: 0, width: 0, height: 0 });
      if (k === Symbol.toPrimitive) return () => "";
      return makeEl();   // anonymous child stub
    },
    apply() { return makeEl(); },
    set(t, k, v) { state.props[k] = v; return true; },
  });
  if (key) ELEMENTS.set(key, el);
  return el;
}

const DOC_STATE = { handlers: {} };
const fakeDoc = new Proxy({}, {
  get(t, k) {
    if (k === "getElementById") return (id) => makeEl("#" + id);
    if (k === "querySelector") return (sel) => makeEl(sel);
    if (k === "createElement" || k === "createElementNS") return () => makeEl();
    if (k === "querySelectorAll" || k === "getElementsByClassName") return () => [];
    if (k === "addEventListener") return (type, h) => { (DOC_STATE.handlers[type] = DOC_STATE.handlers[type] || []).push(h); };
    if (k === "removeEventListener") return () => {};
    if (k === "body" || k === "documentElement" || k === "head") return makeEl("#__body");
    if (k === "cookie" || k === "title") return "";
    if (k === "createTreeWalker") return () => ({ nextNode: () => null });
    return makeEl();
  },
});

const base = {
  console: { log() {}, warn() {}, error() {} },   // keep test output clean
  document: fakeDoc,
  // simulate a CEO who picked a project before: lastProject remembered
  localStorage: { getItem: (k) => (k === "lastProject" ? "tookjorThai" : null), setItem() {}, removeItem() {} },
  setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  requestAnimationFrame: () => 0,
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
  WebSocket: function () { return makeEl(); },
  navigator: { language: "en", mediaDevices: makeEl(), userAgent: "node" },
  location: { host: "x", pathname: "/", href: "/", reload() {}, replace() {} },
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Promise, Map, Set,
  parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, Intl,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  getComputedStyle: () => new Proxy({}, { get: () => "" }),
};
const sandbox = new Proxy(base, {
  has: () => true,
  get(t, k) { return k in t ? t[k] : makeEl(); },
  set(t, k, v) { t[k] = v; return true; },
});
base.window = sandbox; base.self = sandbox; base.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(padded, sandbox, { filename: "overlay.html" });

const inp = makeEl("#inp");
const pcModal = makeEl("#pcModal");

// One Enter keydown, browser dispatch order: target handlers → document (bubble)
function pressEnter() {
  const ev = {
    key: "Enter", target: inp, _stopped: false, _defaulted: false,
    stopPropagation() { this._stopped = true; },
    stopImmediatePropagation() { this._stopped = true; },
    preventDefault() { this._defaulted = true; },
  };
  for (const h of (inp.__state.handlers.keydown || [])) h(ev);
  if (!ev._stopped) for (const h of (DOC_STATE.handlers.keydown || [])) h(ev);
  return ev;
}

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? "  — " + detail : ""));
  if (!ok) fail = 1;
}

console.log("listeners: #inp keydown=" + (inp.__state.handlers.keydown || []).length +
  ", document keydown=" + (DOC_STATE.handlers.keydown || []).length);

// 1) THE bug path: type + Enter → modal must END UP open (not open-then-confirmed)
inp.__state.props.value = "ทดสอบ picker";
pressEnter();
check("Enter in chat → pcModal stays OPEN", pcModal.__state.classes.has("open"),
  "open=" + pcModal.__state.classes.has("open"));

// 2) Enter AGAIN while modal is open → must confirm (close) — normal confirm UX
const second = pressEnter();
check("Enter again (separate keystroke) → confirms & closes", !pcModal.__state.classes.has("open"),
  "open=" + pcModal.__state.classes.has("open") + " defaulted=" + second._defaulted);

// 3) click ➤ button path → modal opens too
inp.__state.props.value = "ทดสอบ click";
const sendBtn = makeEl("#send");
if (typeof sendBtn.__state.props.onclick === "function") sendBtn.__state.props.onclick();
check("click ➤ → pcModal opens", pcModal.__state.classes.has("open"),
  "open=" + pcModal.__state.classes.has("open"));

process.exit(fail);
