#!/usr/bin/env node
// 403 → model-fallback — unit test (zero dependency, no daemon needed).
//
//   node tools/model-403-fallback-unit.js [path-to-server.js]
//
// The brick-guard (a 403/no-entitlement spawn must auto-downgrade, never die
// silently) lives in three PURE helpers in the daemon: looksLikeModelDenied,
// fallbackModelAfter, and the AVAILABLE_MODELS/UNAVAILABLE_MODELS catalog. This
// test EXTRACTS those exact snippets from the source and runs them in a vm
// sandbox — so it proves the real shipping logic, not a copy. Exit 0 = pass.
//
// Defaults to daemon/server.staged.js (where changes are staged); pass the live
// daemon/server.js to re-verify after deploy.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = process.argv[2] ||
  path.join(__dirname, "..", "daemon", "server.staged.js");
const PASS = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const FAIL = (m) => { console.log("  \x1b[31m✗\x1b[0m " + m); process.exitCode = 1; };

const text = fs.readFileSync(SRC, "utf8");

// Pull each declaration out of the source by name. Each regex is anchored so a
// missing/renamed helper fails loudly here rather than silently passing.
function grab(re, label) {
  const m = text.match(re);
  if (!m) { FAIL(`could not find ${label} in ${path.basename(SRC)}`); process.exit(1); }
  return m[0];
}
const snippets = [
  grab(/const AVAILABLE_MODELS = \[[\s\S]*?\n\];/, "AVAILABLE_MODELS"),
  grab(/const UNAVAILABLE_MODELS = new Set\([\s\S]*?\);/, "UNAVAILABLE_MODELS"),
  grab(/const MODEL_FALLBACK_CHAIN = \[[^\]]*\];/, "MODEL_FALLBACK_CHAIN"),
  grab(/function looksLikeModelDenied\(text\) \{[\s\S]*?\n\}/, "looksLikeModelDenied"),
  grab(/function fallbackModelAfter\(failed, tried\) \{[\s\S]*?\n\}/, "fallbackModelAfter"),
];

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(snippets.join("\n\n") +
  "\nthis.AVAILABLE_MODELS = AVAILABLE_MODELS;" +
  "\nthis.UNAVAILABLE_MODELS = UNAVAILABLE_MODELS;" +
  "\nthis.MODEL_FALLBACK_CHAIN = MODEL_FALLBACK_CHAIN;" +
  "\nthis.looksLikeModelDenied = looksLikeModelDenied;" +
  "\nthis.fallbackModelAfter = fallbackModelAfter;", sandbox);

const { looksLikeModelDenied, fallbackModelAfter, UNAVAILABLE_MODELS } = sandbox;

console.log(`\n  403 → model-fallback unit — against ${path.basename(SRC)}\n`);

// 1) catalog: fable-5 must be flagged unavailable (the model that bricked us).
if (UNAVAILABLE_MODELS.has("claude-fable-5")) PASS("fable-5 is flagged unavailable in the catalog");
else FAIL("fable-5 must be in UNAVAILABLE_MODELS");

// 2) detection: real 403 / no-entitlement stderr signatures must match …
const DENIED = [
  "API Error: 403 Forbidden",
  `The model "claude-fable-5" may not exist or you may not have access to it.`,
  "permission_error: you do not have access to this model",
  "model_not_found",
  "This model is not entitled for your account",
];
for (const s of DENIED) {
  if (looksLikeModelDenied(s)) PASS(`detects denial: "${s.slice(0, 48)}…"`);
  else FAIL(`should detect as denial: "${s}"`);
}
// … and ordinary failures must NOT (or the fallback would fire on every error).
const OK = [
  "", "rate_limit_error: 429 too many requests",
  "Error: connect ECONNRESET", "tool execution failed: file not found",
  "the user denied permission for Bash",   // permission DENIED by broker ≠ model 403
];
for (const s of OK) {
  if (!looksLikeModelDenied(s)) PASS(`ignores non-denial: "${(s || "(empty)").slice(0, 48)}"`);
  else FAIL(`should NOT treat as model denial: "${s}"`);
}

// 3) downgrade order: configured → sonnet → haiku, skipping the failed one.
const T = (failed, tried, want) => {
  const got = fallbackModelAfter(failed, new Set(tried));
  if (got === want) PASS(`fallbackModelAfter(${failed || "null"}, [${tried}]) = ${want}`);
  else FAIL(`fallbackModelAfter(${failed || "null"}, [${tried}]) → got ${got}, want ${want}`);
};
T("claude-fable-5", ["claude-fable-5"], "claude-sonnet-4-6");      // the brick case
T("claude-opus-4-8", ["claude-opus-4-8"], "claude-sonnet-4-6");
T(null, [], "claude-sonnet-4-6");                                  // CLI-default 403
T("claude-sonnet-4-6", ["claude-sonnet-4-6"], "claude-haiku-4-5-20251001");
T("claude-haiku-4-5-20251001",
  ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"], null);       // chain exhausted

// 4) a fallback target must never itself be an unavailable model.
let everUnavail = false;
for (const failed of [null, "claude-opus-4-8", "claude-fable-5"]) {
  const got = fallbackModelAfter(failed, new Set());
  if (got && UNAVAILABLE_MODELS.has(got)) everUnavail = true;
}
if (!everUnavail) PASS("fallback never returns an unavailable model");
else FAIL("fallback returned an unavailable model");

const ok = process.exitCode !== 1;
console.log("\n  " + (ok ? "\x1b[32mRESULT: PASS\x1b[0m" : "\x1b[31mRESULT: FAIL\x1b[0m") + "\n");
process.exit(ok ? 0 : 1);
