// Postgres persistence layer — Codex round-2 guards:
//   * NO hardcoded credentials in source (env / .env.db only).
//   * schema is bootstrapped (CREATE TABLE IF NOT EXISTS) so a fresh DB works.
//   * the layer cleanly disables (enabled=false, helpers no-op) without a URL.
// The round-trip test self-skips when no reachable Postgres is configured, so it
// is safe in CI without a database.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const db = require("../db");

test("source ships no hardcoded connection string / password", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "db.js"), "utf8");
  assert.ok(!/postgresql:\/\/[^"'\s]*:[^"'@\s]+@/.test(src),
    "db.js must not contain a postgresql://user:password@host literal");
  assert.ok(!/1A2b3c4d5e/.test(src), "the old leaked password must be gone");
});

test("exposes the documented fail-soft API", () => {
  for (const fn of ["ping", "end", "q", "init", "ensureSchema",
    "saveOrchContext", "lastOrchContext", "saveTokenMetrics", "tokenTotals"]) {
    assert.strictEqual(typeof db[fn], "function", `db.${fn} must be a function`);
  }
  assert.strictEqual(typeof db.enabled, "boolean");
});

test("helpers reject bad input without touching the DB", async () => {
  assert.strictEqual(await db.saveOrchContext({ sessionId: "", summary: "x" }), null);
  assert.strictEqual(await db.saveOrchContext({ sessionId: "s", summary: "" }), null);
  assert.strictEqual(await db.saveTokenMetrics([]), 0);
  assert.strictEqual(await db.saveTokenMetrics(null), 0);
});

test("round-trip: schema bootstrap + orch_context + token_metrics", async (t) => {
  if (!db.enabled || !(await db.ping())) {
    t.skip("no reachable Postgres (DATABASE_URL_BAGIDEA unset or down)");
    return;
  }
  assert.strictEqual(await db.ensureSchema(), true, "schema bootstrap must succeed");

  const sid = "__dbtest_sess_" + process.pid + "_" + process.hrtime.bigint();
  try {
    const ins = await db.saveOrchContext({ sessionId: sid, turn: 7, summary: "carryover probe", tokenCount: 99 });
    assert.ok(ins && ins.id, "insert returns a row id");
    const last = await db.lastOrchContext(sid);
    assert.strictEqual(last.summary_text, "carryover probe");
    assert.strictEqual(Number(last.turn), 7);
    assert.strictEqual(Number(last.token_count), 99);

    const agent = "__dbtest_agent_" + process.pid;
    const n = await db.saveTokenMetrics([{ agent, name: "probe", inputTokens: 11, outputTokens: 4, costUsd: 0.02 }]);
    assert.strictEqual(n, 1, "one token_metrics row written");
    const totals = await db.tokenTotals(24);
    assert.ok(totals.some((r) => r.agent === agent), "token totals include the probe agent");

    await db.q("DELETE FROM orch_context WHERE session_id = $1", [sid]);
    await db.q("DELETE FROM token_metrics WHERE agent = $1", [agent]);
  } finally {
    await db.end();
  }
});
