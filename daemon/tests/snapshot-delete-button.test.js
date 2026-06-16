// snapshot-delete-button.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Regression for the 🗑 "ลบรูป" button on each Office-Ops 📸 SNAPSHOTS card.
//
// Proves, by running the REAL overlay.html main script in a fake-DOM vm:
//   (1) buildSnapCard() renders a .snapdel button on every card;
//   (2) the FIRST tap only ARMS (no network) — two-tap confirm, matching the
//       project-row "กดซ้ำเพื่อยืนยัน" idiom (native confirm() is unreliable in
//       the shell);
//   (3) the SECOND tap fires POST /snapshot/delete with the correct body
//       (snapshotId + image path) so the backend can remove file + record;
//   (4) skipped/placeholder cards (non-web, no image) STILL get a delete button
//       (you must be able to purge junk records too).
//
// Run:  node daemon/tests/snapshot-delete-button.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const OVERLAY = path.join(__dirname, "..", "overlay.html");
const html = fs.readFileSync(OVERLAY, "utf8");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };
const noop = () => {};

// ── fake DOM (same shape as token-pill-drag-swallow.test.js) ────────────────
const NODES = new Map();
const MISSING = [];
const events = [];
function cl() { const s = new Set(); return { add:(...a)=>a.forEach(x=>s.add(x)), remove:(...a)=>a.forEach(x=>s.delete(x)), toggle:(c,f)=>{const h=s.has(c);const on=f===undefined?!h:f;on?s.add(c):s.delete(c);return on;}, contains:(c)=>s.has(c) }; }
function node(tag, id) {
  return { _tag: tag, id: id || "", _text: "", _html: "", className: "", title: "", disabled: false, value: "", type: "",
    classList: cl(), style: new Proxy({}, { get:()=>"", set:()=>true }), dataset: {}, _listeners: {},
    onclick: null, loading: "", alt: "", src: "", children: [],
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

// fetch recorder — captures every call so we can assert the delete request.
const FETCHES = [];
function recordFetch(url, opts) {
  FETCHES.push({ url, opts: opts || {} });
  return Promise.resolve({ ok: true, status: 200,
    json: () => Promise.resolve({ ok: true, deleted: "x", fileDeleted: true }),
    text: () => Promise.resolve("{}") });
}

const localStore = {};
const sandbox = {
  document,
  localStorage: { getItem: (k) => (k in localStore ? localStore[k] : null), setItem: (k, v) => { localStore[k] = String(v); }, removeItem: (k) => { delete localStore[k]; } },
  navigator: { userAgent: "test", platform: "Win32", language: "th" },
  location: { href: "http://127.0.0.1:8787/overlay.html", search: "", hash: "", reload: noop, origin: "http://127.0.0.1:8787" },
  console: { log: noop, warn: noop, error: noop, info: noop },
  fetch: recordFetch,
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

const open2 = html.indexOf("<script>", html.indexOf("<script>") + 1);
const close2 = html.indexOf("</script>", open2);
const script = html.slice(open2 + "<script>".length, close2);
let initErr = null;
vm.createContext(sandbox);
try { vm.runInContext(script, sandbox, { filename: "overlay-main.js" }); } catch (e) { initErr = e; }

console.log("1) overlay init");
ok(!initErr, "overlay main script runs without error" + (initErr ? " — " + initErr.message : ""));
ok(typeof sandbox.buildSnapCard === "function", "buildSnapCard is defined");
ok(typeof sandbox.deleteSnap === "function", "deleteSnap is defined");

// helper: find the .snapdel button among a card's children
const findDel = (card) => (card.children || []).find((c) => c.className === "snapdel");

// ── 2. delete button exists on a normal (web) card ─────────────────────────
console.log("2) every card carries a 🗑 delete button");
const snap = { snapshotId: "snap_TEST_1", project: "bagidea", projectName: "BagIdea",
  imagePath: "daemon/snapshots/bagidea-123.png", url: "/snapshots/img/bagidea-123.png",
  status: "ok", kind: "", ts: 1781490000000 };
const card = sandbox.buildSnapCard(snap);
const del = findDel(card);
ok(!!del, "buildSnapCard renders a .snapdel button");

// skipped/placeholder card (non-web, no image) must ALSO be deletable
const skip = { snapshotId: "snap_TEST_skip", project: "x", projectName: "X",
  imagePath: "", url: "", status: "skipped", kind: "", ts: 1781490000001 };
ok(!!findDel(sandbox.buildSnapCard(skip)), "skipped/placeholder card is still deletable");

// ── 3. two-tap confirm: first tap arms, no network ─────────────────────────
console.log("3) two-tap confirm");
FETCHES.length = 0;
del.onclick({ target: del, stopPropagation: noop, preventDefault: noop });
ok(FETCHES.length === 0, "first tap does NOT hit the network (arming only)");
ok(del.dataset.armed === "1", "first tap arms the button (dataset.armed='1')");
ok(del.classList.contains("armed"), "first tap adds the .armed class");

// ── 4. second tap fires POST /snapshot/delete with the right body ──────────
console.log("4) second tap deletes via the backend");
del.onclick({ target: del, stopPropagation: noop, preventDefault: noop });
const call = FETCHES.find((f) => String(f.url).indexOf("/snapshot/delete") >= 0);
ok(!!call, "second tap POSTs to /snapshot/delete");
ok(call && (call.opts.method || "").toUpperCase() === "POST", "method is POST");
let body = {};
try { body = JSON.parse(call.opts.body); } catch {}
ok(body.snapshotId === "snap_TEST_1", "body carries the correct snapshotId");
ok(body.path === "daemon/snapshots/bagidea-123.png", "body carries the image path (path-safety arg)");
ok(call && call.opts.headers && call.opts.headers["x-bagidea-ui"] === "1", "request is tagged x-bagidea-ui:1 (UI-origin)");

console.log("\n" + (fail ? "❌ FAIL " : "✅ PASS ") + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
