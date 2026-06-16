// wish-card-hire.test.js — click-sim for the in-chat "ขออนุมัติจ้าง" (HIRE) button.
// Extracts the REAL parseHelperWish() + addWishCard() from overlay.html and drives
// them on a recording DOM with a SCRIPTED fetch, proving the 4 contract cautions
// mister-n flagged for POST /npc/request {requesterId, role, reason, explicit:true}:
//
//   (1) the POST carries the REAL requesterId (the message author), never a
//       hardcoded ceo/main → no L7001 404 / wrong-attribution proposal;
//   (2) role(≥2) / reason(≥10) live in the PAYLOAD (forwarded from the proposing
//       message), not just the button label → no silent L7006 202 created:false;
//   (3) a rapid double-tap fires EXACTLY ONE POST, and a 409 dedupe (L7017) stays
//       SOFT — button spent, no red failure;
//   (4) caps surface the server's OWN message to the CEO via addChip — 429
//       pending-full (L7022) and 409 office-full (L7026) never fail silently, and
//       office-full is NOT mis-handled as a dedupe.
//
// Run:  node daemon/tests/wish-card-hire.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const OVERLAY = path.join(__dirname, "..", "overlay.html");
const src = fs.readFileSync(OVERLAY, "utf8");

// --- pull one `function NAME(...) { ... }` out of the source by brace-match ----
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

// --- recording DOM: every button created is tracked so we can "click" it -------
const BUTTONS = [];
function makeNode(tag) {
  const node = {
    _tag: tag, children: [], _text: "", className: "", id: "",
    title: "", style: {}, onclick: null, disabled: false,
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { for (const c of cs) this.children.push(c); },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
  };
  if (tag === "button") BUTTONS.push(node);
  return node;
}
const document = {
  createElement: (t) => makeNode(t),
  createTextNode: (t) => ({ _text: String(t), nodeType: 3 }),
};

// --- scripted fetch: one response per POST, records every call's parsed body ---
const FETCH_CALLS = [];   // [{url, body:{...}}]
const FETCH_QUEUE = [];   // [{status, body:string}] consumed FIFO
function fetchStub(url, opts) {
  FETCH_CALLS.push({ url, body: JSON.parse(opts.body) });
  const resp = FETCH_QUEUE.shift() || { status: 200, body: "{}" };
  return Promise.resolve({
    status: resp.status,
    text: () => Promise.resolve(resp.body),
    json: () => Promise.resolve(JSON.parse(resp.body)),
  });
}

const CHIPS = [];   // every addChip() message the CEO would see
const ctx = {
  document, console, fetch: fetchStub,
  addMsg: () => makeNode("div"),          // stub the bubble; we only test the button
  addChip: (h) => CHIPS.push(String(h)),
};
vm.createContext(ctx);
vm.runInContext(extract("parseHelperWish") + "\n" + extract("addWishCard"), ctx);

// --- harness helpers ----------------------------------------------------------
function setup(resp) {
  BUTTONS.length = 0; FETCH_CALLS.length = 0; CHIPS.length = 0; FETCH_QUEUE.length = 0;
  if (resp) FETCH_QUEUE.push(resp);
}
function hireBtn() { return BUTTONS.find((b) => typeof b.onclick === "function"); }
// mimic the browser: a disabled button does not dispatch its onclick.
function tap(btn) { if (btn.disabled) return false; return btn.onclick(); }

let fail = 0;
function check(label, ok, detail) {
  console.log((ok ? "  PASS " : "  FAIL ") + label + (detail ? " — " + detail : ""));
  if (!ok) fail++;
}

// The exact non-explicit fallback phrasing the server broadcasts (server.js L7008),
// with agent = the requester. role="Backend Helper", reason ≥ 10 chars.
const WISH =
  'อยากได้ผู้ช่วยตำแหน่ง "Backend Helper" (ช่วยแบกงาน API ตอนทราฟฟิกพีค) — ถ้าท่านเห็นด้วย สั่ง hire ได้เลยครับ';

async function main() {
  console.log("wish-card-hire.test.js");

  // ---- parser gate mirrors the server (role≥2 / reason≥10) -------------------
  const w = ctx.parseHelperWish(WISH);
  check("parseHelperWish pulls role+reason from the fallback text",
    !!w && w.role === "Backend Helper" && /API/.test(w.reason), JSON.stringify(w));
  check("parseHelperWish rejects reason < 10 (no dead button)",
    ctx.parseHelperWish('อยากได้ผู้ช่วยตำแหน่ง "DB" (สั้นไป) —') === null);

  // ===========================================================================
  // CAUTION 1 + 2 — real requesterId in payload + role/reason forwarded (200 OK)
  // ===========================================================================
  setup({ status: 200, body: JSON.stringify({ requestId: "npc-1" }) });
  // call site forwards ev.agent as BOTH `who` and `requesterId` (overlay L6717)
  ctx.addWishCard("black", WISH, 111, "black", w.role, w.reason);
  let b = hireBtn();
  await tap(b);
  const sent = FETCH_CALLS[0] && FETCH_CALLS[0].body;
  check("[1] POST hits /npc/request", FETCH_CALLS[0] && FETCH_CALLS[0].url === "/npc/request");
  check("[1] requesterId is the REAL author (black), not ceo/main",
    sent && sent.requesterId === "black", JSON.stringify(sent));
  check("[2] role in payload, length ≥ 2",
    sent && sent.role === "Backend Helper" && sent.role.length >= 2);
  check("[2] reason in payload, length ≥ 10",
    sent && typeof sent.reason === "string" && sent.reason.length >= 10,
    sent && ("len=" + sent.reason.length));
  check("[2] explicit:true rides along (belt-and-suspenders w/ x-bagidea-ui)",
    sent && sent.explicit === true);
  check("[1/2] success → button spent (disabled, confirms queued)",
    b.disabled === true && /ส่งคำขอแล้ว/.test(b.textContent), b.textContent);

  // ===========================================================================
  // CAUTION 3a — rapid double-tap fires EXACTLY ONE POST
  // ===========================================================================
  setup({ status: 200, body: JSON.stringify({ requestId: "npc-2" }) });
  ctx.addWishCard("white", WISH, 222, "white", w.role, w.reason);
  b = hireBtn();
  const p1 = tap(b);          // fires; disables synchronously before its await
  const p2 = tap(b);          // blocked: button already disabled
  await p1;
  check("[3] double-tap → exactly ONE POST", FETCH_CALLS.length === 1,
    "calls=" + FETCH_CALLS.length);
  check("[3] second tap was blocked by disabled guard", p2 === false);

  // ===========================================================================
  // CAUTION 3b — 409 dedupe (L7017) stays SOFT (no red error, stays spent)
  // ===========================================================================
  setup({ status: 409, body: "มีใบขอตำแหน่งนี้จากผู้ขอคนเดิมค้างรออนุมัติอยู่แล้ว" });
  ctx.addWishCard("black", WISH, 333, "black", w.role, w.reason);
  b = hireBtn();
  await tap(b);
  check("[3] 409 dedupe → stays disabled (already pending = done)", b.disabled === true);
  check("[3] 409 dedupe → soft ✅ message, NOT a failure chip",
    /รออนุมัติอยู่แล้ว/.test(b.textContent) && CHIPS.length === 0, b.textContent);

  // ===========================================================================
  // CAUTION 4a — 429 pending-full (L7022) surfaces the cap message to the CEO
  // ===========================================================================
  setup({ status: 429, body: "มีคำขอค้างรออนุมัติเต็มแล้ว (5) — ให้ CEO เคลียร์ก่อน" });
  ctx.addWishCard("black", WISH, 444, "black", w.role, w.reason);
  b = hireBtn();
  await tap(b);
  check("[4] 429 cap → CEO sees the server's cap message (not silent)",
    CHIPS.some((c) => /เต็มแล้ว/.test(c)), JSON.stringify(CHIPS));
  check("[4] 429 cap → button re-armed for retry after clearing", b.disabled === false);

  // ===========================================================================
  // CAUTION 4b — 409 office-full (L7026) shown, NOT mistaken for a dedupe
  // ===========================================================================
  setup({ status: 409, body: "ออฟฟิศเต็มแล้ว — รับพนักงานได้สูงสุด 18 คน (ไม่นับ CEO)" });
  ctx.addWishCard("black", WISH, 555, "black", w.role, w.reason);
  b = hireBtn();
  await tap(b);
  check("[4] 409 office-full → cap message shown to CEO",
    CHIPS.some((c) => /ออฟฟิศเต็ม/.test(c)), JSON.stringify(CHIPS));
  check("[4] 409 office-full → NOT swallowed as dedupe (re-armed, no soft ✅)",
    b.disabled === false && !/รออนุมัติอยู่แล้ว/.test(b.textContent), b.textContent);

  if (fail) { console.error("\n" + fail + " check(s) failed"); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
