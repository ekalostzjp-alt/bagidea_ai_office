// Backend e2e — 0 token, NO daemon boot, NO live state touched.
// Proves the two report-pipeline fixes in daemon/server.staged.js:
//
//   (1) Codex review-gate FAIL-OPEN: when the gate verdict is "error"
//       (codex timeout / crash — NOT a quality fail) it must NOT swallow the
//       deliverable. It posts a "รอ CEO ตัดสินเอง" feed notice, pushes NO
//       bounce job, and resets the round counter (no re-review loop).
//       (docs/codex-review-gate.contract.md fail-open clause)
//
//   (2) DIRECT report-back: a direct order (CEO → agent chat, no DELEGATE)
//       that CHANGES the project tree drops a summary card into the Director
//       feed (chat.message agent:"main", directReport) + a ceo.report ping.
//       A pure chat (tree unchanged) / unreadable git stays silent.
//       (docs/direct-report-back.contract.md)
//
// Method: pull the REAL function source out of server.staged.js by name and
// run each in a sandbox with injected stubs — so the test exercises the exact
// shipped code, never a re-implementation, without requiring the server (which
// would listen on a port + spawn claude + cost tokens).

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "daemon", "server.staged.js"), "utf8");

// Brace-match the source of a top-level function (handles `function f(` and
// `async function f(`). Returns the full `function …{ … }` text.
function fnSource(name) {
  const re = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(", "g");
  const m = re.exec(SRC);
  if (!m) throw new Error("function not found: " + name);
  let i = SRC.indexOf("{", m.index);
  let depth = 0;
  for (let j = i; j < SRC.length; j++) {
    const c = SRC[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return SRC.slice(m.index, j + 1); }
  }
  throw new Error("unbalanced braces in " + name);
}

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log("  ✓ " + msg); }
  else { fails++; console.log("  ✗ FAIL: " + msg); } };

// ---- shared stubs ---------------------------------------------------------
const reg = { agents: { "แบล็ค": { name: "แบล็ค" }, "มิสเตอร์-n": { name: "มิสเตอร์ N" } } };
const resolveProjectRef = (r) => (r ? String(r) : "");
const projectDir = (id) => (id ? "C:/fake/" + id : "");

// spawnSync stub for git: scripted porcelain outputs per call.
let gitScript = [];
const spawnSync = (cmd, argv) => {
  const next = gitScript.shift();
  if (!next) return { status: 1, stdout: "" };
  return { status: next.status, stdout: next.stdout };
};

// Build the report helpers from real source, with deps injected as params.
const helpers = new Function(
  "broadcast", "reg", "resolveProjectRef", "projectDir", "spawnSync", "console",
  fnSource("gitTreeSig") + "\n" + fnSource("reportDirectWork") +
  "\nreturn { gitTreeSig, reportDirectWork };");

function makeHelpers(broadcast) {
  return helpers(broadcast, reg, resolveProjectRef, projectDir, spawnSync, console);
}

// ===========================================================================
console.log("\n[A] gitTreeSig — change detection");
{
  const { gitTreeSig } = makeHelpers(() => {});
  gitScript = [{ status: 0, stdout: " M daemon/server.js\n" }];
  const s1 = gitTreeSig("C:/fake/bagidea");
  gitScript = [{ status: 0, stdout: " M daemon/server.js\n?? new.js\n" }];
  const s2 = gitTreeSig("C:/fake/bagidea");
  ok(s1 !== null && s1 !== s2, "different porcelain → different signature");
  ok(gitTreeSig(null) === null, "no dir → null (can't prove a change)");
  gitScript = [{ status: 128, stdout: "" }];
  ok(gitTreeSig("C:/fake/nope") === null, "git non-zero exit → null");
}

console.log("\n[B] reportDirectWork — fires ONLY on a real deliverable");
{
  // B1: tree changed → summary card + ceo.report
  let evs = [];
  let { reportDirectWork } = makeHelpers((e) => evs.push(e));
  gitScript = [{ status: 0, stdout: " M daemon/server.js\n?? added.txt\n" }]; // nowSig
  reportDirectWork("แบล็ค", "bagidea", "แก้บั๊ก null guard", "แก้แล้ว เพิ่ม guard ก่อน .map ครบ", "C:/fake/bagidea",
    " M daemon/server.js\n"); // baseSig (differs)
  const card = evs.find((e) => e.type === "chat.message");
  ok(!!card, "B1 a changed tree posts a chat.message card");
  ok(card && card.agent === "main", "B1 card targets the Director feed (agent:main)");
  ok(card && card.directReport === true && card.fromAgent === "แบล็ค", "B1 card flagged directReport + fromAgent");
  ok(card && card.text.includes("แบล็ค") && card.text.includes("bagidea"), "B1 card names the agent + project");
  ok(card && card.text.includes("added.txt"), "B1 card lists the changed file");
  ok(card && card.text.includes("null guard"), "B1 card carries the order");
  ok(evs.some((e) => e.type === "ceo.report"), "B1 also pings the CEO view (ceo.report)");

  // B2: tree UNCHANGED (pure Q&A) → silent
  evs = [];
  ({ reportDirectWork } = makeHelpers((e) => evs.push(e)));
  const same = " M daemon/server.js\n";
  gitScript = [{ status: 0, stdout: same }];
  reportDirectWork("แบล็ค", "bagidea", "อธิบายโค้ดให้หน่อย", "อธิบายแล้ว…", "C:/fake/bagidea", same);
  ok(evs.length === 0, "B2 unchanged tree → no broadcast (chat stays quiet)");

  // B3: baseSig null (couldn't read at start) → silent, never cry wolf
  evs = [];
  ({ reportDirectWork } = makeHelpers((e) => evs.push(e)));
  gitScript = [{ status: 0, stdout: " M x\n" }];
  reportDirectWork("แบล็ค", "bagidea", "ทำงาน", "เสร็จ", "C:/fake/bagidea", null);
  ok(evs.length === 0, "B3 null baseline → no broadcast");

  // B4: no project / no dir → silent
  evs = [];
  ({ reportDirectWork } = makeHelpers((e) => evs.push(e)));
  gitScript = [{ status: 1, stdout: "" }];
  reportDirectWork("แบล็ค", "", "คุยเล่น", "ครับ", "", null);
  ok(evs.length === 0, "B4 no project → no broadcast");
}

// ===========================================================================
console.log("\n[C] runReviewGate — fail-OPEN on a codex error/timeout");
(async () => {
  // Inject every dep runReviewGate touches; runCodexReview is forced to the
  // timeout/error path so we observe the fail-open branch end-to-end.
  const reviewState = { codexAvailable: true, pending: [], rounds: {}, last: {}, decisions: [] };
  const jobs = [];
  let bounced = 0;
  const evs = [];
  const env = {
    REVIEW_AGENT: "มิสเตอร์-n",
    REVIEW_MAX_ROUNDS: 3,
    REVIEW_TIMEOUT_MS: 90000,
    resolveProjectRef, projectDir, reg, reviewState, jobs, console, Date,
    runCodexReview: async () => ({ kind: "error", detail: "codex timeout 90s" }),
    reviewStrList: (a, n) => (Array.isArray(a) ? a : []).slice(0, n).map(String),
    drainPendingReviews: () => {},
    saveReview: () => {}, saveJobs: () => {},
    dispatchJob: () => { bounced++; },
    setTimeout: (f) => { return 0; },
    broadcast: (e) => evs.push(e),
  };
  const keys = Object.keys(env);
  const runReviewGate = new Function(...keys, "return (" + fnSource("runReviewGate") + ")")(...keys.map((k) => env[k]));

  const result = await runReviewGate("แบล็ค", "bagidea");
  ok(result.verdict === "error", "C1 codex timeout → verdict 'error' (not 'fail')");
  ok(bounced === 0, "C2 error verdict pushes NO bounce job (deliverable not swallowed)");
  ok(jobs.length === 0, "C3 no re-review job queued");
  ok(reviewState.rounds["bagidea|แบล็ค"] === 0, "C4 round counter reset → no escalation loop");
  const notice = evs.find((e) => e.type === "chat.message");
  ok(!!notice && notice.agent === "main", "C5 posts a Director-feed notice");
  ok(notice && notice.text.includes("รอ CEO"), "C6 notice tells CEO to decide by hand (fail-open)");
  ok(notice && notice.text.includes("แบล็ค"), "C7 notice names the agent whose work it was");

  // The timeout constant was reduced from 120s → 90s (faster, cleaner fail).
  ok(/const REVIEW_TIMEOUT_MS\s*=\s*90000/.test(SRC), "C8 REVIEW_TIMEOUT_MS reduced to 90000ms");

  console.log(`\n${fails === 0 ? "ALL PASS" : "HAS FAILURES"} — ${passes} passed, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("E2E CRASHED:", e); process.exit(2); });
