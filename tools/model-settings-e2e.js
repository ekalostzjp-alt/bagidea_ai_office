#!/usr/bin/env node
// Per-Agent Model Settings — end-to-end test (zero dependency).
//
//   node tools/model-settings-e2e.js [port]      (default 8787)
//
// Verifies the GET/POST /settings/models contract end-to-end and ALWAYS
// restores the office's original settings afterwards. Spawn-uses-the-model is
// proven separately at integration time via task.started.model (see contract).
// Exit 0 = pass, 1 = fail. See docs/per-agent-model-settings.contract.md.

const http = require("http");

const PORT = Number(process.argv[2] || process.env.OEP_PORT || 8787);
const HOST = "127.0.0.1";
const SUPPORTED = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5"];

const PASS = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const FAIL = (m) => { console.log("  \x1b[31m✗\x1b[0m " + m); process.exitCode = 1; };

function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: HOST, port: PORT, path, method,
      headers: { "x-bagidea-ui": "1",
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } },
      (res) => { const ch = []; res.on("data", (d) => ch.push(d));
        res.on("end", () => { const t = Buffer.concat(ch).toString("utf8");
          try { resolve({ status: res.statusCode, json: JSON.parse(t) }); }
          catch { resolve({ status: res.statusCode, json: null, text: t }); } }); });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log(`\n  Per-Agent Model Settings — e2e against http://${HOST}:${PORT}\n`);

  // roster (to pick a real spawnable agent)
  const reg = await httpJson("GET", "/registry").catch(() => null);
  if (!reg || !reg.json || !reg.json.agents) { FAIL("could not read /registry"); process.exit(1); }
  const agents = Object.keys(reg.json.agents).filter((a) => a !== "ceo");
  const target = agents.includes("แบล็ค") ? "แบล็ค" : agents.find((a) => a !== "main") || agents[0];
  PASS(`roster ok — target agent = ${target}`);

  // GET (snapshot original) — must exist
  const before = await httpJson("GET", "/settings/models");
  if (before.status === 404 || !before.json) {
    FAIL("GET /settings/models not implemented yet (404 / no JSON) — Black not done");
    process.exit(1);
  }
  const orig = before.json;
  PASS("GET /settings/models responds");

  // shape checks — match by family (ids are whatever the catalog declares; the
  // canonical Haiku id is dated, e.g. claude-haiku-4-5-20251001).
  const avail = Array.isArray(orig.available) ? orig.available : [];
  const families = ["opus", "sonnet", "haiku", "fable"];
  const pick = (fam) => (avail.find((m) => new RegExp(fam, "i").test(m.id)) || {}).id;
  if (avail.length !== 4) FAIL(`available[] should list 4 models (got ${avail.length})`);
  else if (families.some((f) => !pick(f))) FAIL("available[] must cover opus/sonnet/haiku/fable");
  else if (avail.some((m) => !m.label || m.tier == null || !m.costHint)) FAIL("each available[] needs id/label/tier/costHint");
  else PASS("available[] = 4 models (opus/sonnet/haiku/fable) with id/label/tier/costHint");
  const MID = pick("sonnet"), CHEAP = pick("haiku");

  if (typeof orig.perAgent !== "object" || orig.perAgent === null) FAIL("perAgent missing");
  else PASS("perAgent present");

  // POST — set default + per-agent, partial update
  const want = { default: MID, perAgent: { [target]: CHEAP } };
  const post = await httpJson("POST", "/settings/models", want);
  if (post.status !== 200) FAIL(`POST /settings/models → ${post.status} ${post.text || ""}`);
  else PASS("POST /settings/models → 200");

  // GET — confirm round-trip
  const after = await httpJson("GET", "/settings/models");
  if (after.json && after.json.default === MID) PASS(`default persisted = ${MID}`);
  else FAIL(`default did not persist (got ${after.json && after.json.default})`);
  if (after.json && after.json.perAgent && after.json.perAgent[target] === CHEAP)
    PASS(`perAgent[${target}] persisted = ${CHEAP}`);
  else FAIL(`perAgent[${target}] did not persist (got ${after.json && after.json.perAgent && after.json.perAgent[target]})`);

  // negative: invalid model + invalid agent must 400
  const bad1 = await httpJson("POST", "/settings/models", { default: "gpt-4o" });
  if (bad1.status === 400) PASS("rejects unsupported model (400)");
  else FAIL(`unsupported model should 400, got ${bad1.status}`);
  const bad2 = await httpJson("POST", "/settings/models", { perAgent: { "no_such_agent_xyz": "claude-haiku-4-5" } });
  if (bad2.status === 400) PASS("rejects unknown agent (400)");
  else FAIL(`unknown agent should 400, got ${bad2.status}`);

  // RESTORE original (always). Black's POST MERGES perAgent, so the key we
  // added must be explicitly cleared (null) unless it existed originally.
  const restore = await httpJson("POST", "/settings/models",
    { default: orig.default, perAgent: Object.assign({ [target]: null }, orig.perAgent) });
  if (restore.status === 200) PASS("restored original settings");
  else FAIL(`could not restore original settings (status ${restore.status}) — CHECK MANUALLY`);

  const ok = process.exitCode !== 1;
  console.log("\n  " + (ok ? "\x1b[32mRESULT: PASS\x1b[0m" : "\x1b[31mRESULT: FAIL\x1b[0m") + "\n");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log("  \x1b[31m✗\x1b[0m fatal: " + e.message); process.exit(1); });
