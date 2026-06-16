// Headless load-time check for overlay.html's main <script>.
// Goal: prove whether the script body runs top-to-bottom WITHOUT throwing —
// if it throws mid-way, every declaration AFTER the throw (incl. send() and its
// click/Enter wiring) never happens, so the project picker can never open.
// Strategy: run the script in a vm with a Proxy-based fake DOM/global so genuine
// browser globals never ReferenceError, while SAME-SCRIPT lexical errors (const
// TDZ) and logic throws at module-load still surface. We do NOT flush timers —
// we only care about the synchronous top-level pass.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const file = path.join(__dirname, "..", "daemon", "overlay.html");
const html = fs.readFileSync(file, "utf8");
const open = html.indexOf("<script>");
const startLine = html.slice(0, open).split("\n").length; // 1-based line of <script>
const body = html.slice(open + "<script>".length, html.lastIndexOf("</script>"));
// pad so vm line numbers ≈ overlay.html line numbers
const padded = "\n".repeat(startLine) + body;

function makeEl() {
  const fn = function () {};
  return new Proxy(fn, {
    get(t, k) {
      if (k === "classList") return { add() {}, remove() {}, contains() { return false; }, toggle() {} };
      if (k === "style") return new Proxy({}, { get() { return ""; }, set() { return true; } });
      if (k === "dataset") return {};
      if (k === "value" || k === "textContent" || k === "innerHTML" ||
          k === "placeholder" || k === "src" || k === "id") return "";
      if (k === "children" || k === "files") return [];
      if (k === "querySelectorAll") return () => [];
      if (k === "getBoundingClientRect") return () => ({ top: 0, left: 0, width: 0, height: 0 });
      if (k === Symbol.toPrimitive) return () => "";
      return makeEl();
    },
    apply() { return makeEl(); },
    set() { return true; },
  });
}

const fakeDoc = new Proxy({}, {
  get(t, k) {
    if (k === "getElementById" || k === "querySelector" || k === "createElement" ||
        k === "createElementNS") return () => makeEl();
    if (k === "querySelectorAll" || k === "getElementsByClassName") return () => [];
    if (k === "addEventListener" || k === "removeEventListener") return () => {};
    if (k === "body" || k === "documentElement" || k === "head") return makeEl();
    if (k === "cookie" || k === "title") return "";
    if (k === "createTreeWalker") return () => ({ nextNode: () => null });
    return makeEl();
  },
});

const base = {
  console,
  document: fakeDoc,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  requestAnimationFrame: () => 0,
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") }),
  WebSocket: function () { return makeEl(); },
  navigator: { language: "en", mediaDevices: makeEl(), userAgent: "node" },
  location: { host: "127.0.0.1:8787", pathname: "/", href: "http://127.0.0.1:8787/", reload() {}, replace() {} },
  Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Promise, Map, Set,
  parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, Intl,
};
base.addEventListener = () => {};
base.removeEventListener = () => {};
base.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
base.getComputedStyle = () => new Proxy({}, { get() { return ""; } });

// has:()=>true so undeclared *globals* resolve to a no-op via get(); same-script
// const/let stay lexically bound, so their TDZ violations still throw for real.
const sandbox = new Proxy(base, {
  has: () => true,
  get(t, k) { return k in t ? t[k] : makeEl(); },
  set(t, k, v) { t[k] = v; return true; },
});
// window/self/globalThis must be the PROXY so window.foo() absorbs unknowns too.
base.window = sandbox;
base.self = sandbox;
base.globalThis = sandbox;

vm.createContext(sandbox);
try {
  vm.runInContext(padded, sandbox, { filename: "overlay.html", lineOffset: 0 });
  const sendType = typeof sandbox.send;
  console.log("LOAD_OK — script body ran to completion with no throw.");
  console.log("send is defined at module scope? typeof send =", sendType,
    "(note: send is a function declaration inside the script's top scope)");
  process.exit(0);
} catch (e) {
  console.log("LOAD_THREW — module-load aborted; everything after this line never ran:");
  console.log("  name:", e && e.name);
  console.log("  message:", e && e.message);
  console.log("  stack:\n", e && e.stack);
  process.exit(2);
}
