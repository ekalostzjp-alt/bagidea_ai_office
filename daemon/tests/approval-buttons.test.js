// approval-buttons.test.js — proves the overlay renders an actionable APPROVE
// button for BOTH approval renderers, by extracting the REAL functions from
// overlay.html and running them on a recording DOM shim (no jsdom needed).
//
//   • "model"  approval  -> openReviewModal()  (event review.result, verdict fail)
//   • "agent"  approval  -> buildNpcCard()     (event npc.request — hire helper)
//   • "wish"   discovery -> parseHelperWish() + addWishCard()
//        a plain "อยากได้ผู้ช่วย" chat.message (the npc/request non-explicit
//        fallback, server.js ~7008) becomes a one-tap HIRE button that fires
//        POST /npc/request with explicit:true — same gate, no shell IPC.
//
// Run:  node daemon/tests/approval-buttons.test.js
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

// --- recording DOM shim: every node remembers its kids, class, text, onclick --
function makeNode(tag) {
  const node = {
    _tag: tag, children: [], _text: "", className: "", id: "", title: "",
    style: {}, onclick: null, disabled: false,
    classList: { _s: new Set(),
      add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { for (const c of cs) this.children.push(c); },
    querySelector() { return makeNode("stub"); },
    querySelectorAll() { return []; },
    addEventListener() {},
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    createTextNode(t) { return { _text: String(t) }; },
  };
  return node;
}
const REGISTRY = {};
const document = {
  createElement: (t) => makeNode(t),
  createTextNode: (t) => ({ _text: String(t), nodeType: 3 }),
  getElementById: (id) => (REGISTRY[id] = REGISTRY[id] || makeNode("#" + id)),
  addEventListener() {},
};

// walk a card subtree and collect every clickable approve-ish button
function findApproveButtons(root) {
  const out = [];
  const seen = new Set();
  (function walk(n) {
    if (!n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    const txt = (n._text || "") + "";
    const isBtn = n._tag === "button" || /primary/.test(n.className || "");
    if (isBtn && typeof n.onclick === "function" &&
        /(อนุมัติ|จ้าง|ตกลง|allow|approve)/i.test(txt)) out.push(txt.trim());
    for (const c of (n.children || [])) walk(c);
  })(root);
  return out;
}

// --- sandbox: real render fns + minimal stubs for their collaborators --------
const reviewModal = makeNode("#reviewModal");
const npcModal = makeNode("#npcModal");
const npcCard = makeNode("#npcCard");
REGISTRY.reviewModal = reviewModal;
REGISTRY.reviewCard = makeNode("#reviewCard");
REGISTRY.reviewTitle = makeNode("#reviewTitle");
REGISTRY.reviewBody = makeNode("#reviewBody");

const ctx = {
  document, encodeURI, console,
  nameOf: (x) => String(x || "?"),
  uiSnd: () => {},
  closeReviewModal: () => {},
  reviewDecision: () => {},
  closeNpc: () => {},
  openNpcList: () => {},
  reviewModal, npcModal, npcCard,
  _npcShown: null, _npcMode: "queue",
  // --- wish-card collaborators (recording stubs) ---------------------------
  _apiCalls: [], _chips: [],
  // addMsg returns the bubble node so addWishCard can graft the button onto it
  addMsg: (cls, who, text) => { const n = makeNode("div"); n._text = String(text); return n; },
  addChip: (h) => { ctx._chips.push(String(h)); },
  // addWishCard reads HTTP status + raw body itself (it needs to tell a 200
  // create apart from a 409 dedupe / 429 cap), so it calls fetch directly, not
  // api(). Record the POST and reply like a successful npc.request creation.
  api: (url, body) => { ctx._apiCalls.push({ url, body }); return Promise.resolve({ requestId: "npc1" }); },
  fetch: (url, opts) => {
    ctx._apiCalls.push({ url, body: JSON.parse(opts.body) });
    return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify({ requestId: "npc1" })) });
  },
};
vm.createContext(ctx);

const code = [
  extract("rvSection"), extract("specRow"), extract("chipRow"),
  extract("openReviewModal"), extract("buildNpcCard"),
  extract("parseHelperWish"), extract("addWishCard"),
  // expose REGISTRY's reviewCard/Body to the modal fn via getElementById (already wired)
  // invoke both renderers and stash the cards we want to inspect
  `var _modelEv = { reviewId:"rv1", agentId:"n", project:"p1781139305599", round:3,
     escalate:true, verdict:"fail", reasons:["x"], files:["a.js"], fixes:["y"],
     codexAvailable:false };
   openReviewModal(_modelEv);
   var _agentEv = { requestId:"npc1", requester:"black", name:"ผู้ช่วย",
     role:"Backend Helper", why:"ช่วยงานหนัก", benefit:"เร็วขึ้น", model:"claude-opus-4-8",
     skills:["api"], tools:["Bash"], persona:"นิ่ง" };
   buildNpcCard(_agentEv);
   // ---- wish discovery: parse the EXACT server fallback text, build the card --
   var _wishText = 'อยากได้ผู้ช่วยตำแหน่ง "Backend Helper" (ช่วยงานหนักมากตอนนี้คนเดียวไม่ไหว) — ถ้าท่านเห็นด้วย สั่ง hire ได้เลยครับ';
   var _wish = parseHelperWish(_wishText);
   var _wishCard = _wish ? addWishCard("black", _wishText, 0, "black", _wish.role, _wish.reason) : null;
   // a non-wish chat line must NOT mint a card (no false positives)
   var _plainWish = parseHelperWish("วันนี้อากาศดีจังเลยนะครับ");`,
].join("\n");

vm.runInContext(code, ctx);

// reviewBody holds the review (model) card; npcCard holds the agent card
const modelBtns = findApproveButtons(REGISTRY.reviewBody);
const agentBtns = findApproveButtons(npcCard);

// return the first <button> node carrying an onclick (so we can actually click)
function findButtonNode(root) {
  const seen = new Set();
  let hit = null;
  (function walk(n) {
    if (hit || !n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    if (n._tag === "button" && typeof n.onclick === "function") { hit = n; return; }
    for (const c of (n.children || [])) walk(c);
  })(root);
  return hit;
}

let fail = 0;
function check(label, ok, detail) {
  console.log((ok ? "  PASS " : "  FAIL ") + label + (detail ? " — " + detail : ""));
  if (!ok) fail++;
}

(async () => {
  console.log("approval-buttons.test.js");
  check('model approval (review.result fail) renders an APPROVE button',
    modelBtns.length >= 1, JSON.stringify(modelBtns));
  check('agent approval (npc.request) renders an APPROVE button',
    agentBtns.length >= 1, JSON.stringify(agentBtns));

  // --- wish discovery regression ------------------------------------------
  const wish = ctx._wish;
  check('parseHelperWish() pulls {role, reason} from the server fallback text',
    !!wish && wish.role === "Backend Helper" && wish.reason.length >= 10,
    JSON.stringify(wish));
  check('parseHelperWish() ignores ordinary chatter (no false positive)',
    ctx._plainWish === null);

  const hireBtn = findButtonNode(ctx._wishCard);
  check('wish chat.message renders a clickable HIRE button',
    !!hireBtn && /จ้าง/.test(hireBtn._text || ""), hireBtn && hireBtn._text);

  if (hireBtn) {
    await hireBtn.onclick();   // CEO taps HIRE — the explicit signal
    const call = ctx._apiCalls[0];
    check('clicking HIRE fires POST /npc/request',
      !!call && call.url === "/npc/request", call && call.url);
    check('the request carries explicit:true (passes the npc.request gate)',
      !!call && call.body && call.body.explicit === true);
    check('the request relays the parsed role + reason + requester',
      !!call && call.body && call.body.role === "Backend Helper" &&
      call.body.reason.length >= 10 && call.body.requesterId === "black",
      call && JSON.stringify(call.body));
    check('after a successful fire the button shows it was sent',
      /ส่งคำขอแล้ว/.test(hireBtn._text || ""), hireBtn._text);
  }

  if (fail) { console.error("\n" + fail + " check(s) failed"); process.exit(1); }
  console.log("\nall checks passed");
})();
