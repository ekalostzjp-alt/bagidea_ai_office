// integration-hub-form-persist.test.js — proves the Key/credential form no longer
// gets wiped to null when a poll tick or WS plugin.event re-renders the panel.
//
// ROOT CAUSE (pre-fix): renderCreds()/renderConns()/renderFlows() — fired every 6s by
// setInterval and on every WS plugin.event — unconditionally called renderXForm(),
// which does host.innerHTML="" and rebuilds inputs from state. The text the user was
// typing was never synced back into that state, so it vanished on each re-render.
//
// FIX under test:
//   (1) every input has oninput/onchange that writes its value straight back into the
//       form state (credForm/connForm/flowForm) and marks the form dirty;
//   (2) renderCreds/Conns/Flows SKIP rebuilding a form that is dirty or focused, so the
//       live DOM node the user is typing into is never destroyed mid-edit.
//
// We load the REAL panel.html <script> into a hand-rolled DOM (no jsdom dependency),
// drive the real functions, and assert: open form → type → fire repeated re-renders
// (poll + WS) → value still present AND the input node identity is stable.
//
// Run:  node daemon/tests/integration-hub-form-persist.test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PANEL = path.join(__dirname, "..", "..", "plugins", "integration-hub", "panel.html");
const html = fs.readFileSync(PANEL, "utf8");
const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));

/* ───────────────────────── minimal DOM ───────────────────────── */
const registry = new Map();   // id -> element

function mkClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c),
    toggle: (c, on) => { const has = set.has(c); const want = on === undefined ? !has : !!on; want ? set.add(c) : set.delete(c); },
    contains: (c) => set.has(c),
  };
}

function mkEl(tag) {
  const e = {
    tagName: (tag || "div").toUpperCase(),
    children: [], parentNode: null,
    className: "", title: "", disabled: false, value: "",
    _id: "", textContent: "", dataset: {},
    classList: mkClassList(),
    style: {},
    appendChild(child) { child.parentNode = e; e.children.push(child); return child; },
    contains(node) { for (let n = node; n; n = n.parentNode) if (n === e) return true; return false; },
    focus() { DOC.activeElement = e; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  Object.defineProperty(e, "id", {
    get() { return e._id; },
    set(v) { e._id = v; if (v) registry.set(v, e); },
  });
  Object.defineProperty(e, "innerHTML", {
    get() { return e._html || ""; },
    set(v) {
      // tear down current children (and unregister their ids)
      const drop = (node) => { node.children.forEach(drop); if (node._id) registry.delete(node._id); };
      e.children.forEach(drop);
      e.children = [];
      e._html = String(v);
      // discover ids in the assigned markup and materialize stub children for them
      const re = /id="([^"]+)"/g; let m;
      while ((m = re.exec(e._html))) {
        const child = mkEl(/<select/i.test(e._html) ? "select" : "input");
        child.id = m[1];               // registers in registry
        e.appendChild(child);
      }
    },
  });
  return e;
}

const DOC = {
  activeElement: null,
  createElement: (t) => mkEl(t),
  getElementById: (id) => registry.get(id) || null,
  querySelectorAll: () => [],
};

// pre-seed the static hosts/elements the script wires at boot
["conn","connTxt","nCred","nConn","nFlow","credForm","credList","connForm","connList",
 "flowForm","flowList","addCred","addConn","addFlow","recheckAll"].forEach(id => {
  const e = mkEl("div"); e.id = id;
});

/* ─────────────────── stubbed environment ─────────────────── */
const overviewRes = { ok: true, credentials: [], connections: [], workflows: [] };
let nextRes = overviewRes;
const sandbox = {
  document: DOC,
  console,
  JSON, Math, Object, Array, Number, Date, Set, Boolean, String, parseInt,
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: (fn) => { if (typeof fn === "function") fn(); return 0; },
  WebSocket: function () { return { onmessage: null, close() {} }; },
  fetch: async () => ({ status: 200, json: async () => nextRes }),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

// expose internal state/functions via closure epilogue
const epilogue = `
globalThis.__t = {
  openCredForm, closeCredForm, renderCreds, loadCreds,
  openConnForm, closeConnForm, renderConns,
  openFlowForm, closeFlowForm, renderFlows,
  get credForm(){return credForm}, get credFormDirty(){return credFormDirty},
  get connForm(){return connForm}, get connFormDirty(){return connFormDirty},
  get flowForm(){return flowForm}, get flowFormDirty(){return flowFormDirty},
  set creds(v){creds=v}, set conns(v){conns=v}, set flows(v){flows=v},
};`;

vm.createContext(sandbox);
vm.runInContext(script + epilogue, sandbox, { filename: "panel.html" });
const T = sandbox.__t;

/* ───────────────────────── assertions ───────────────────────── */
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } }
function type(id, val) { const e = DOC.getElementById(id); e.value = val; if (e.oninput) e.oninput({ target: e }); }
function fire(id, fn) { const e = DOC.getElementById(id); if (e && e[fn]) e[fn]({ target: e }); }

console.log("\n[1] CREDENTIAL form survives poll/WS re-renders while focused");
T.openCredForm(null);
type("cLabel", "OpenAI Prod");
type("cHint", "prod account");
type("cVal", "sk-secret-123456");
const credNode = DOC.getElementById("cVal");
ok("typing marked the form dirty", T.credFormDirty === true);
ok("focus is inside the credential form", DOC.activeElement && DOC.getElementById("credForm").contains(DOC.activeElement));
// simulate a poll tick + a WS event arriving with fresh server data
T.creds = [{ id: "x1", label: "other", type: "api_key", hasValue: true, masked: "••••aaaa" }];
T.renderCreds();
T.renderCreds();
ok("secret value preserved after re-render", DOC.getElementById("cVal").value === "sk-secret-123456");
ok("label value preserved after re-render", DOC.getElementById("cLabel").value === "OpenAI Prod");
ok("hint value preserved after re-render", DOC.getElementById("cHint").value === "prod account");
ok("input node identity stable (cursor not lost)", DOC.getElementById("cVal") === credNode);

console.log("\n[2] CREDENTIAL form survives re-render after blur (dirty, not focused)");
DOC.activeElement = null;                  // user clicked away from the field
T.renderCreds();
ok("value still present after blur+re-render", DOC.getElementById("cVal").value === "sk-secret-123456");
ok("node still the same after blur+re-render", DOC.getElementById("cVal") === credNode);

console.log("\n[3] closing the form clears it cleanly");
T.closeCredForm();
ok("credForm state cleared", T.credForm === null);
ok("form host emptied", DOC.getElementById("credForm").children.length === 0);

console.log("\n[4] CONNECTION form survives re-renders while editing");
T.openConnForm(null);
type("kLabel", "OpenAI API");
type("kUrl", "https://api.openai.com/v1/models");
fire("kMethod", "onchange");
const urlNode = DOC.getElementById("kUrl");
ok("connForm dirty after typing", T.connFormDirty === true);
T.conns = [{ id: "c9", label: "z", status: "ok", check: { url: "x" } }];
T.renderConns();
T.renderConns();
ok("url preserved after re-render", DOC.getElementById("kUrl").value === "https://api.openai.com/v1/models");
ok("label preserved after re-render", DOC.getElementById("kLabel").value === "OpenAI API");
ok("url node identity stable", DOC.getElementById("kUrl") === urlNode);
T.closeConnForm();
ok("connForm cleared on close", T.connForm === null);

console.log("\n[5] WORKFLOW form survives re-renders while editing");
T.openFlowForm(null);
type("wLabel", "Notify deploy");
type("wTarget", "https://hooks.slack.com/services/x");
const tgtNode = DOC.getElementById("wTarget");
ok("flowForm dirty after typing", T.flowFormDirty === true);
T.flows = [{ id: "w9", label: "z", trigger: null }];
T.renderFlows();
T.renderFlows();
ok("target preserved after re-render", DOC.getElementById("wTarget").value === "https://hooks.slack.com/services/x");
ok("label preserved after re-render", DOC.getElementById("wLabel").value === "Notify deploy");
ok("target node identity stable", DOC.getElementById("wTarget") === tgtNode);

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
