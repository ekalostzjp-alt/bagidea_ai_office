// Postgres foundation for the office — self-contained, lazy, never touches
// server.js logic. Black wires the daemon to THIS when ready:
//
//   const db = require("./db");
//   await db.init();                                    // bootstrap schema once
//   await db.saveOrchContext({ sessionId, turn, summary, tokenCount });
//   await db.saveTokenMetrics(byAgentArrayFromUsageEndpoint);
//   const last = await db.lastOrchContext(sessionId);   // carryover on boot
//
// Connection: env DATABASE_URL_BAGIDEA (set in daemon/.env.db, loaded here) →
// postgresql://…/bagidea. NO connection string ships in source — if the env is
// unset the whole layer is cleanly DISABLED (db.enabled === false) and every
// helper no-ops (returns null/[]/0). The pool is created on first use.
// Every helper is fail-soft: on DB trouble it logs once and returns null/[] so
// the office NEVER stalls on persistence.
"use strict";
const fs = require("fs");
const path = require("path");

// minimal .env loader (daemon/.env.db) — no dotenv dependency
(() => {
  try {
    const txt = fs.readFileSync(path.join(__dirname, ".env.db"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
})();

// Source-of-truth: env only. No hardcoded credentials/fallback — when unset the
// persistence layer is disabled rather than dialing a guessed local Postgres.
const URL = process.env.DATABASE_URL_BAGIDEA || "";
const enabled = !!URL;

let pool = null;
let warned = false;
let schemaReady = null; // cached promise; null until first ensureSchema()

function getPool() {
  if (!enabled) return null;
  if (pool) return pool;
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: URL, max: 4, idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 4000 });
  pool.on("error", (e) => console.error("[db] pool error:", e.message));
  return pool;
}

// ---- schema bootstrap: idempotent CREATE TABLE IF NOT EXISTS so a fresh
// Postgres (no migration tooling) gets the tables on first use. Without this
// every query would fail-soft to null and durability would silently never work.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS orch_context (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT        NOT NULL,
  turn        INTEGER     NOT NULL DEFAULT 0,
  summary_text TEXT       NOT NULL,
  token_count INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orch_context_session_idx
  ON orch_context (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS token_metrics (
  id            BIGSERIAL PRIMARY KEY,
  agent         TEXT         NOT NULL,
  name          TEXT         NOT NULL DEFAULT '',
  input_tokens  INTEGER      NOT NULL DEFAULT 0,
  output_tokens INTEGER      NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
  ts            TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS token_metrics_ts_idx ON token_metrics (ts);
`;

// Run once per process. Cached so it never blocks the hot path twice. On failure
// the cache is cleared so a later call can retry (e.g. DB came up after boot).
function ensureSchema() {
  if (!enabled) return Promise.resolve(false);
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const p = getPool();
    if (!p) return false;
    try {
      await p.query(SCHEMA_SQL);
      return true;
    } catch (e) {
      if (!warned) { warned = true; console.error("[db] schema bootstrap failed (fail-soft):", e.message); }
      schemaReady = null; // allow a retry on the next call
      return false;
    }
  })();
  return schemaReady;
}

async function q(text, params) {
  if (!enabled) return null;
  try {
    await ensureSchema();
    return await getPool().query(text, params);
  } catch (e) {
    if (!warned) { warned = true; console.error("[db] query failed (fail-soft):", e.message); }
    return null;
  }
}

// ---- orch_context: rolling summaries so compaction carryover survives restarts
async function saveOrchContext({ sessionId, turn = 0, summary, tokenCount = 0 }) {
  if (!sessionId || !summary) return null;
  const r = await q(
    `INSERT INTO orch_context (session_id, turn, summary_text, token_count)
     VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
    [String(sessionId), turn | 0, String(summary), tokenCount | 0]);
  return r && r.rows[0] || null;
}
async function lastOrchContext(sessionId) {
  const r = await q(
    `SELECT id, session_id, turn, summary_text, token_count, created_at
     FROM orch_context WHERE session_id = $1
     ORDER BY created_at DESC LIMIT 1`, [String(sessionId)]);
  return r && r.rows[0] || null;
}

// ---- token_metrics: persist /tokens/by-process rows so the baseline survives
async function saveTokenMetrics(byAgent) {
  if (!Array.isArray(byAgent) || !byAgent.length) return 0;
  let n = 0;
  for (const a of byAgent) {
    const r = await q(
      `INSERT INTO token_metrics (agent, name, input_tokens, output_tokens, cost_usd)
       VALUES ($1,$2,$3,$4,$5)`,
      [String(a.agent || "?"), String(a.name || ""),
       Math.round(a.inputTokens || 0), Math.round(a.outputTokens || 0),
       Number(a.costUsd || 0)]);
    if (r) n++;
  }
  return n;
}
async function tokenTotals(sinceHours = 24) {
  const r = await q(
    `SELECT agent, max(name) AS name,
            sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
            sum(cost_usd) AS cost_usd, count(*) AS samples
     FROM token_metrics
     WHERE ts > now() - ($1 || ' hours')::interval
     GROUP BY agent ORDER BY sum(input_tokens) DESC`, [String(sinceHours | 0)]);
  return r && r.rows || [];
}

async function ping() {
  if (!enabled) return false;
  try {
    const r = await getPool().query("SELECT 1 AS ok");
    return !!(r && r.rows && r.rows[0] && r.rows[0].ok === 1);
  } catch { return false; }
}
async function end() { if (pool) { await pool.end().catch(() => {}); pool = null; schemaReady = null; } }

// init() is an explicit alias for ensureSchema() — call once on daemon boot to
// bootstrap the schema up front (otherwise it lazily runs on the first query).
module.exports = { ping, end, q, init: ensureSchema, ensureSchema,
  saveOrchContext, lastOrchContext, saveTokenMetrics, tokenTotals, enabled };
