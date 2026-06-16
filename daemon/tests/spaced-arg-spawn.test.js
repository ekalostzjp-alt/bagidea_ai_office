// Proves the spawn-300ms-death fix: spawn(cmd, args, {shell:true}) concatenates
// argv WITHOUT escaping (Node DEP0190). On this machine paths live under
// "C:\Users\WINDOWS 11\…", so a spaced --mcp-config arg gets split by the shell
// and `claude` rejects the MCP config → instant exit, no result, sid=null orphan.
// (see memory: agent-spawn-credit-reject-300ms)
//
// We extract the REAL `shArg` helper out of the shipping server.js (not a copy),
// then spawn a tiny argv-echo child through shell:true to observe what the child
// process ACTUALLY receives — raw spaced path splits; shArg-quoted stays whole.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { spawnSync } = require("child_process");

// Lift `const shArg = (a) => { ... };` verbatim from the shipping source so the
// test binds to code that actually runs, not a paraphrase that could drift. The
// daemon runs server.js but is batch-deployed FROM server.staged.js, so the fix
// can legitimately live in either at any moment — accept whichever carries it.
function loadShArg() {
  for (const f of ["server.js", "server.staged.js"]) {
    let src;
    try { src = fs.readFileSync(path.join(__dirname, "..", f), "utf8"); } catch { continue; }
    const m = src.match(/const shArg = (\(a\) => \{[\s\S]*?\n\});/);
    // eslint-disable-next-line no-eval
    if (m) return eval("(" + m[1] + ")");
  }
  return null;
}
const shArg = loadShArg();
assert.ok(shArg, "shArg helper must exist in server.js or server.staged.js");

// A child that prints argv after the script path as JSON. We pass our spaced
// path as a SINGLE logical arg; if the shell splits it, argv.length grows.
const ECHO = path.join(__dirname, "_argv-echo.js");
fs.writeFileSync(ECHO, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");

const SPACED = "C:\\Users\\WINDOWS 11\\AppData\\Local\\mcp_x.json";

// Bare "node" (PATH-resolved, no space) mirrors how server.js invokes bare
// "claude" — only the ARGS carry spaces, which is exactly the bug under test.
// (process.execPath would be "C:\Program Files\nodejs\node.exe" — a spaced
//  COMMAND that shell:true breaks before args ever matter.)
// The harness script path is itself spaced on this machine, so we ALWAYS quote
// it (shArg) to get a clean run; only `arg` — argv[2], printed by the child — is
// the token under test, passed raw or shArg-quoted by the caller.
function childArgv(arg) {
  const r = spawnSync("node", [shArg(ECHO), arg], { shell: true, encoding: "utf8" });
  return JSON.parse(r.stdout || "[]");
}

try {
  // 1) RAW spaced path through shell:true → the shell splits it on the space,
  //    so the child sees TWO argv entries. This is the live bug.
  const raw = childArgv(SPACED);
  assert.deepStrictEqual(
    raw, ["C:\\Users\\WINDOWS", "11\\AppData\\Local\\mcp_x.json"],
    "expected raw spaced arg to split into two — if this fails the platform shell "
    + "no longer splits and the whole premise needs rechecking");

  // 2) shArg-quoted spaced path → child sees ONE intact argv entry. The fix.
  const fixed = childArgv(shArg(SPACED));
  assert.strictEqual(fixed.length, 1, "shArg-quoted arg must stay a single token");
  assert.strictEqual(fixed[0], SPACED, "shArg-quoted arg must arrive byte-identical");

  // 3) shArg must NOT touch tokens that have no whitespace (flags, model ids,
  //    comma-joined tool lists) — no stray quotes, no behavior change.
  assert.strictEqual(shArg("--mcp-config"), "--mcp-config");
  assert.strictEqual(shArg("claude-opus-4-8"), "claude-opus-4-8");
  assert.strictEqual(shArg("Read,Glob,Grep"), "Read,Glob,Grep");

  // 4) Idempotent: an already-quoted token is not double-wrapped.
  assert.strictEqual(shArg('"already quoted"'), '"already quoted"');

  console.log("ok - spaced-arg-spawn: raw splits, shArg keeps spaced paths whole (4 checks)");
} finally {
  try { fs.unlinkSync(ECHO); } catch {}
}
