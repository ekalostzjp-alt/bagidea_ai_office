// changelog-host-aware.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Regression for the host-aware update-banner CHANGELOG link (the Bitbucket
// migration left this hard-coded to github.com → Bitbucket builds linked to the
// wrong host). Proves END-TO-END coherence:
//
//   FRONT-END (overlay.html, in a fake-DOM vm): setChangelogRepo(repo, host)
//     (1) github host  → https://github.com/<slug>/blob/main/CHANGELOG.md
//     (2) bitbucket    → https://bitbucket.org/<slug>/src/main/CHANGELOG.md
//     (3) normalization strips a full github.com/ OR bitbucket.org/ prefix,
//         a trailing ".git", and a trailing "/"
//     (4) junk repo leaves the static fallback href untouched
//     (5) host defaults to github when omitted (legacy contract)
//
//   BACK-END (static source guard over all 3 server files): both the /version
//     payload and the update.available broadcast carry host + repo, so the
//     overlay actually RECEIVES what setChangelogRepo() needs.
//
// Run:  node daemon/tests/changelog-host-aware.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const OVERLAY = path.join(__dirname, "..", "overlay.html");
const html = fs.readFileSync(OVERLAY, "utf8");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };
const noop = () => {};

// ── fake DOM (same shape as snapshot-delete-button.test.js) ──────────────────
const NODES = new Map();
const MISSING = [];
const events = [];
function cl() { const s = new Set(); return { add:(...a)=>a.forEach(x=>s.add(x)), remove:(...a)=>a.forEach(x=>s.delete(x)), toggle:(c,f)=>{const h=s.has(c);const on=f===undefined?!h:f;on?s.add(c):s.delete(c);return on;}, contains:(c)=>s.has(c) }; }
function node(tag, id) {
  return { _tag: tag, id: id || "", _text: "", _html: "", className: "", title: "", disabled: false, value: "", type: "", href: "",
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

const open2 = html.indexOf("<script>", html.indexOf("<script>") + 1);
const close2 = html.indexOf("</script>", open2);
const script = html.slice(open2 + "<script>".length, close2);
let initErr = null;
vm.createContext(sandbox);
try { vm.runInContext(script, sandbox, { filename: "overlay-main.js" }); } catch (e) { initErr = e; }

console.log("1) overlay init + setChangelogRepo present");
ok(!initErr, "overlay main script runs without error" + (initErr ? " — " + initErr.message : ""));
ok(typeof sandbox.setChangelogRepo === "function", "setChangelogRepo is defined");

const updWhat = NODES.get("updWhat");
ok(!!updWhat, "#updWhat element exists in overlay");
const href = () => updWhat.href;

// the SHIPPED static fallback href (before any JS touches it) must be the GitHub
// /blob/main/ link for the real public repo — no stale Bitbucket host left over.
ok(/id="updWhat"[^>]*href="https:\/\/github\.com\/ekalostzjp-alt\/begidea_ai_office\/blob\/main\/CHANGELOG\.md"/.test(html),
  "overlay static fallback href is the GitHub /blob/main/ link for ekalostzjp-alt/begidea_ai_office");

// ── 2. github host → /blob/main/ ─────────────────────────────────────────────
console.log("2) github host builds a /blob/main/ link");
sandbox.setChangelogRepo("owner/name", "github");
ok(href() === "https://github.com/owner/name/blob/main/CHANGELOG.md",
  "github → " + href());

// ── 3. bitbucket host → /src/main/ (two-host capability kept, generic owner) ──
console.log("3) bitbucket host builds a /src/main/ link");
sandbox.setChangelogRepo("bbowner/bbrepo", "bitbucket");
ok(href() === "https://bitbucket.org/bbowner/bbrepo/src/main/CHANGELOG.md",
  "bitbucket → " + href());

// ── 4. normalization (strip full URL prefix for BOTH hosts, .git, trailing /) ─
console.log("4) normalization strips github.com/ OR bitbucket.org/ prefix, .git, trailing /");
sandbox.setChangelogRepo("https://bitbucket.org/o/r.git", "bitbucket");
ok(href() === "https://bitbucket.org/o/r/src/main/CHANGELOG.md", "bitbucket full URL + .git normalized → " + href());
sandbox.setChangelogRepo("https://github.com/o/r/", "github");
ok(href() === "https://github.com/o/r/blob/main/CHANGELOG.md", "github full URL + trailing slash normalized → " + href());

// ── 5. junk repo leaves the (static fallback) href untouched ─────────────────
// The static fallback is the REAL shipped href in overlay.html (GitHub now).
console.log("5) junk repo is ignored — static fallback href untouched");
const STATIC_FALLBACK = "https://github.com/ekalostzjp-alt/begidea_ai_office/blob/main/CHANGELOG.md";
updWhat.href = STATIC_FALLBACK;
sandbox.setChangelogRepo("not-a-valid-slug", "github");
ok(href() === STATIC_FALLBACK, "no slash → href unchanged");
sandbox.setChangelogRepo("", "github");
ok(href() === STATIC_FALLBACK, "empty repo → href unchanged");

// ── 6. host omitted → defaults to github (legacy contract) ───────────────────
console.log("6) missing host defaults to github");
sandbox.setChangelogRepo("o/r");
ok(href() === "https://github.com/o/r/blob/main/CHANGELOG.md", "no host → github default → " + href());

// ── 7. BACK-END coherence: /version + update.available carry host + repo ──────
console.log("7) backend ships host+repo on /version and update.available (all 3 server files)");
for (const file of ["server.js", "server.staged.js", "server.frozen-candidate.js"]) {
  const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  // /version payload: must include host: ur.host AND repo: ur.repo (with the ur = updateRepo() line)
  const versionOk = /const ur = updateRepo\(\);/.test(src) &&
    /updateAvailable: semverGt\(latestVersion, APP_VERSION\), host: ur\.host, repo: ur\.repo/.test(src);
  ok(versionOk, file + ": /version payload carries host + repo");
  // broadcast: update.available must carry host + repo
  const bcastOk = /broadcast\(\{ type: "update\.available", version: remote, current: local, host, repo \}, false\);/.test(src);
  ok(bcastOk, file + ": update.available broadcast carries host + repo");
}

console.log("\n" + (fail ? "❌ FAIL " : "✅ PASS ") + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
