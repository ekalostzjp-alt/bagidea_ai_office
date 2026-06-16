// Codex review round 2/3 — proves the two P1 fixes in recoverRestartCuts():
//   P1#1 forced-restart ABORT must release projRuns/projAgents (no stuck lock)
//   P1#2 must re-read runs.json and NOT clobber the successor's records
//
// We can't boot a second daemon (shared dataDir) so we lift the REAL source of
// releaseCutProj / recoverRestartCuts / normalizeRunsState out of the RUNTIME
// file server.js and run them in a sandbox with stubbed dependencies. Reading
// server.js (not the server.staged.js copy) is deliberate: it proves the code
// that actually ships and runs, not a paraphrase that could drift from live.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// Pull a top-level `function NAME(...) { ... }` out of the source by counting
// braces from its opening `{` — robust against nested blocks/strings-of-braces
// in normal code (no brace-in-string pathologies live in these three fns).
function extractFn(name) {
  const sig = "function " + name + "(";
  const at = SRC.indexOf(sig);
  assert(at >= 0, "cannot find " + name);
  const open = SRC.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) return SRC.slice(at, i + 1); }
  }
  throw new Error("unbalanced braces in " + name);
}

const fnSrc = [extractFn("normalizeRunsState"),
  extractFn("releaseCutProj"), extractFn("recoverRestartCuts")].join("\n");

// Build a fresh sandbox per scenario: real fn bodies, stubbed collaborators.
function makeEnv(disk, ram) {
  const env = {
    projRuns: ram.projRuns,
    projAgents: ram.projAgents,
    runsState: ram.runsState,
    restartCutTasks: ram.restartCutTasks,
    activeRuns: ram.activeRuns,
    RUNS_AUTO_RESUME: true,
    RUNS_RESUME_MAX_CHAIN: 3,
    RUNS_FILE: "(stub)",
    // loadJson(RUNS_FILE) → a deep clone of the simulated on-disk runs.json
    loadJson: () => JSON.parse(JSON.stringify(disk)),
    // recoverRestartCuts reassigns its local `runsState`; the returned final
    // state (env.runsState, set below) is what got saved — just record the call.
    saveRuns: () => { env._savedCalled = true; },
    trimRunsHistory: () => [],
    broadcastActivity: () => { env._calls.activity++; },
    broadcastAgentStatus: () => { env._calls.agentStatus++; },
    broadcast: (m) => { env._calls.bcast.push(m && m.type); },
    dispatchRunRecovery: (rec) => { env._resumed.push(rec.runId); },
    // synchronous setTimeout so the auto-resume scheduling resolves in-test
    setTimeout: (fn) => { try { fn(); } catch (e) { env._timerErr = e; } },
    Date: { now: () => 1000000 },
    _calls: { activity: 0, agentStatus: 0, bcast: [] },
    _resumed: [],
    _savedCalled: false,
  };
  // `env.runsState` is read AND reassigned inside recoverRestartCuts, so the fn
  // must see the live binding — wrap the bodies in a function whose params are
  // the env keys, but route runsState through the env object via closure.
  const keys = Object.keys(env).filter((k) => k !== "runsState");
  const body = "return (function(){ " + fnSrc +
    "\n recoverRestartCuts(); return runsState; })();";
  // runsState lives as a local `let` so the fn's reassignment sticks; seed it
  // from env and read it back out after.
  const runner = new Function(...keys, "let runsState = arguments[arguments.length-1];" + body);
  const finalState = runner(...keys.map((k) => env[k]), env.runsState);
  env.runsState = finalState;
  return env;
}

let pass = 0;
function ok(name) { console.log("  ✓ " + name); pass++; }

// ── Scenario 1: ABORT, successor never bound — disk untouched ────────────────
// The cut run is still "running" in live both in RAM and on disk. Must release
// the project lock AND recover the run to interrupted + auto-resume it.
{
  const cut = { runId: "rA", task: 5, agent: "black", project: "p1",
    status: "running", state: "working", prompt: "do X", session: "s1" };
  const disk = { schemaVersion: 1, live: { 5: cut }, interrupted: [], history: [] };
  const env = makeEnv(disk, {
    projRuns: { p1: 1 },
    projAgents: { p1: { black: 1 } },
    runsState: { schemaVersion: 1, live: { 5: cut }, interrupted: [], history: [] },
    restartCutTasks: new Set([5]),
    activeRuns: new Map([[5, { agent: "black" }]]),
  });

  assert(!("p1" in env.projRuns), "projRuns.p1 must be released (deleted at 0)");
  assert(!("p1" in env.projAgents), "projAgents.p1 must be released (deleted)");
  assert.equal(Object.keys(env.runsState.live).length, 0, "live cleared");
  assert.equal(env.runsState.interrupted.length, 1, "run moved to interrupted");
  assert.equal(env.runsState.interrupted[0].runId, "rA");
  assert.equal(env.runsState.interrupted[0].status, "interrupted");
  assert(!env.activeRuns.has(5), "RAM activeRuns row dropped");
  assert.deepEqual(env._resumed, ["rA"], "recovered run auto-resumed once");
  assert(env._calls.bcast.includes("projects.changed"), "projects.changed broadcast");
  assert(env._calls.agentStatus === 1, "agent.status broadcast");
  assert(env._calls.activity === 1, "activity.update broadcast");
  assert(env._savedCalled, "state persisted to disk");
  ok("P1#1 abort/disk-untouched: lock released, run recovered + resumed");
}

// ── Scenario 2: successor WON the port, swept + auto-resumed, then crashed ────
// Disk now holds the successor's work: the cut run rA moved to interrupted, AND
// a brand-new live record rB (the successor's auto-resume) under a RESET task
// id that happens to collide (5). The old daemon must NOT clobber any of it:
// rB stays live, rA stays interrupted exactly once, no double-resume — but the
// stale in-memory project counter is STILL released.
{
  const cut = { runId: "rA", task: 5, agent: "black", project: "p1",
    status: "running", state: "working", prompt: "do X", session: "s1" };
  const succSwept = { runId: "rA", task: 5, agent: "black", project: "p1",
    status: "interrupted", state: "interrupted", prompt: "do X" };
  const succLive = { runId: "rB", task: 5, agent: "black", project: "p1",
    status: "running", state: "working", prompt: "do X (resumed)" };
  // successor's runs.json after sweep+resume: rA interrupted, rB live (task 5)
  const disk = { schemaVersion: 1, live: { 5: succLive },
    interrupted: [succSwept], history: [] };
  const env = makeEnv(disk, {
    projRuns: { p1: 1 },
    projAgents: { p1: { black: 1 } },
    // old daemon's stale RAM snapshot still shows rA live under task 5
    runsState: { schemaVersion: 1, live: { 5: cut }, interrupted: [], history: [] },
    restartCutTasks: new Set([5]),
    activeRuns: new Map([[5, { agent: "black" }]]),
  });

  // stale lock released even though the successor already owns the run
  assert(!("p1" in env.projRuns), "stale projRuns.p1 released");
  assert(!("p1" in env.projAgents), "stale projAgents.p1 released");
  // successor's live record rB must SURVIVE (not overwritten by our stale rA)
  assert.equal(env.runsState.live[5] && env.runsState.live[5].runId, "rB",
    "successor live record rB preserved");
  // rA must appear in interrupted exactly once (no duplicate)
  const rAcount = env.runsState.interrupted.filter((r) => r.runId === "rA").length;
  assert.equal(rAcount, 1, "rA interrupted exactly once (no duplicate)");
  // we must NOT re-resume rA — successor already had it
  assert.deepEqual(env._resumed, [], "no double-resume of successor-owned run");
  // the persisted (returned) state reflects merged disk truth, not stale RAM
  assert(env._savedCalled, "merged state persisted");
  ok("P1#2 successor-won race: disk merged, no clobber, no double-resume");
}

// ── Scenario 3: mixed — one cut run handled by successor, one missed ──────────
// rC the successor swept to interrupted (skip+adopt); rD it never reached
// (still "running" on disk) → recover + resume rD only. Both locks released.
{
  const cutC = { runId: "rC", task: 7, agent: "black", project: "p1",
    status: "running", prompt: "C", session: "sc" };
  const cutD = { runId: "rD", task: 8, agent: "white", project: "p2",
    status: "running", prompt: "D", session: "sd" };
  const disk = { schemaVersion: 1,
    live: { 8: { ...cutD } },                       // rD never triaged by succ
    interrupted: [{ runId: "rC", task: 7, agent: "black", project: "p1",
      status: "interrupted", prompt: "C" }],         // rC swept by succ
    history: [] };
  const env = makeEnv(disk, {
    projRuns: { p1: 1, p2: 1 },
    projAgents: { p1: { black: 1 }, p2: { white: 1 } },
    runsState: { schemaVersion: 1, live: { 7: cutC, 8: cutD }, interrupted: [], history: [] },
    restartCutTasks: new Set([7, 8]),
    activeRuns: new Map([[7, {}], [8, {}]]),
  });

  assert(!("p1" in env.projRuns) && !("p2" in env.projRuns), "both locks released");
  assert.deepEqual(env._resumed, ["rD"], "only the un-triaged run resumed");
  const ids = env.runsState.interrupted.map((r) => r.runId).sort();
  assert.deepEqual(ids, ["rC", "rD"], "rC adopted + rD recovered, each once");
  assert.equal(Object.keys(env.runsState.live).length, 0, "no stale live left");
  ok("P1 mixed: handled run adopted, missed run recovered — each once");
}

console.log("\nrestart-cuts: " + pass + "/3 passed");
process.exit(pass === 3 ? 0 : 1);
