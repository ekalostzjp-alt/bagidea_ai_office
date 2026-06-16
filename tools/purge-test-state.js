#!/usr/bin/env node
// purge-test-state.js — remove smoke-test residue from daemon state files.
// Idempotent: safe to run any number of times; only touches the known
// test artifacts below, never live data.
//
// Artifacts (all from the 2026-06-10 deploy-verification smoke tests):
//   1. usage-processes.json  byAgent/runs entry for ghost agent "?????"
//      (Thai agent name mojibaked by a non-UTF8 console curl; pong test)
//   2. voice-lines.json      voice bank for the same ghost agent "?????"
//   3. review-gate.json      rounds["?|main"] + last.main error review
//      rv1781060845005 from the empty-project /review/run smoke test
//
// IMPORTANT: the daemon holds these files in memory and rewrites them
// wholesale on its own events, so run this script EITHER while the daemon
// is stopped OR immediately after a daemon restart (before new events fire).
// If a later save resurrects the residue, just run it again after the next
// restart — it converges.
const fs = require("fs");
const path = require("path");
const DAEMON = path.join(__dirname, "..", "daemon");
const GHOST = "?????";
const TEST_REVIEW_ID = "rv1781060845005";

function load(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DAEMON, file), "utf8")); }
  catch { return null; }
}
function save(file, data) {
  fs.writeFileSync(path.join(DAEMON, file), JSON.stringify(data, null, 1));
}

let changed = 0;

// 1) usage-processes.json — drop the ghost row + its runs, fix totals.
const usage = load("usage-processes.json");
if (usage && usage.byAgent && usage.byAgent[GHOST]) {
  const g = usage.byAgent[GHOST];
  const T = usage.totals || {};
  for (const [tk, gk] of [["inputTokens", "inputTokens"], ["outputTokens", "outputTokens"],
    ["totalTokens", "totalTokens"], ["cacheReadTokens", "cacheReadTokens"]])
    if (typeof T[tk] === "number") T[tk] = Math.max(0, T[tk] - (g[gk] || 0));
  if (typeof T.costUsd === "number")
    T.costUsd = Math.max(0, Math.round((T.costUsd - (g.costUsd || 0)) * 1e6) / 1e6);
  delete usage.byAgent[GHOST];
  usage.runs = (usage.runs || []).filter((r) => r.agent !== GHOST);
  save("usage-processes.json", usage);
  console.log("[purge] usage-processes.json: removed ghost agent row (" +
    (g.totalTokens || 0) + " tok, $" + (g.costUsd || 0) + ")");
  changed++;
}

// 2) voice-lines.json — drop the ghost agent's generated bank.
const voice = load("voice-lines.json");
if (voice && voice[GHOST]) {
  delete voice[GHOST];
  save("voice-lines.json", voice);
  console.log("[purge] voice-lines.json: removed ghost agent voice bank");
  changed++;
}

// 3) review-gate.json — drop the empty-project smoke-test round + result.
const gate = load("review-gate.json");
if (gate) {
  let dirty = false;
  if (gate.rounds && Object.prototype.hasOwnProperty.call(gate.rounds, "?|main")) {
    delete gate.rounds["?|main"]; dirty = true;
  }
  if (gate.last && gate.last.main && gate.last.main.reviewId === TEST_REVIEW_ID) {
    delete gate.last.main; dirty = true;
  }
  if (dirty) {
    save("review-gate.json", gate);
    console.log("[purge] review-gate.json: removed smoke-test round/result");
    changed++;
  }
}

console.log(changed ? "[purge] done — " + changed + " file(s) cleaned"
  : "[purge] nothing to clean — state already clear");
