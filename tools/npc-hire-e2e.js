#!/usr/bin/env node
// NPC Hire — end-to-end test (zero dependency). See docs/npc-hire.contract.md §4.
//
//   node tools/npc-hire-e2e.js [port]      (default 8809 — a SANDBOX daemon,
//                                           never the live office on 8787)
//
// Run against an isolated copy of server.staged.js with a stubbed `claude`
// CLI on PATH (deterministic persona JSON, zero tokens) and no API keys
// (avatar path falls back to "" — allowed by contract).
// Exit 0 = pass, 1 = fail.

const http = require("http");

const PORT = Number(process.argv[2] || 8809);
const HOST = "127.0.0.1";

const AURAS = ["", "fire", "ice", "nature", "arcane", "shadow", "gold"];
const VOICES = ["sunny", "sweet", "cool", "genki", "gentle", "mature", "easy", "warmf",
  "bright", "silky", "pro", "lively", "boyish", "warm", "serious", "polite", "deep",
  "clear", "narrator", "buddy", "chill", "smooth", "gravel", "steady"];
const SKILL_IDS = ["deep-research", "office-control", "office-ops", "plugin-builder",
  "code-review", "doc-writer", "debug-detective", "data-wrangler", "project-kickoff",
  "diagram-maker"];
const MODELS = ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"];

const PASS = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const FAIL = (m) => { console.log("  \x1b[31m✗\x1b[0m " + m); process.exitCode = 1; };
const ok = (cond, m) => (cond ? PASS(m) : FAIL(m));

function httpJson(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: HOST, port: PORT, path, method,
      headers: { ...headers,
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } },
      (res) => { const ch = []; res.on("data", (d) => ch.push(d));
        res.on("end", () => { const t = Buffer.concat(ch).toString("utf8");
          try { resolve({ status: res.statusCode, json: JSON.parse(t), text: t }); }
          catch { resolve({ status: res.statusCode, json: null, text: t }); } }); });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("timeout")));
    if (data) req.write(data);
    req.end();
  });
}

const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

(async () => {
  console.log(`\n  NPC Hire — e2e against http://${HOST}:${PORT} (sandbox)\n`);

  // baseline roster
  const reg0 = await httpJson("GET", "/registry");
  if (!reg0.json || !reg0.json.agents) { FAIL("GET /registry unreadable"); process.exit(1); }
  const baseIds = Object.keys(reg0.json.agents);
  ok(baseIds.includes("main"), `baseline roster ok (${baseIds.length} agents, has "main")`);

  // ── 0. guard: non-explicit junk must NOT create a proposal ──────────────
  const junk = await httpJson("POST", "/npc/request",
    { requesterId: "main", role: "x", reason: "test" });
  ok(junk.status === 202 && junk.json && junk.json.created === false,
    `non-explicit junk (role:"x") → 202 created:false (got ${junk.status})`);
  const shortQ = await httpJson("POST", "/npc/request",
    { requesterId: "main", role: "QA", reason: "сั้น", explicit: true });
  ok(shortQ.status === 202, `explicit but reason too short → 202 (got ${shortQ.status})`);
  const pend0 = await httpJson("GET", "/npc/proposals");
  ok(pend0.json && pend0.json.proposals.length === 0,
    `no junk proposal queued (pending=${pend0.json && pend0.json.proposals.length})`);

  // ── 1. explicit request → full registry-grade proposal ──────────────────
  const r1 = await httpJson("POST", "/npc/request", {
    requesterId: "main", role: "QA",
    reason: "งานเทสต์เยอะช่วงนี้ ต้องการคนช่วยทำ regression ก่อน deploy",
    benefit: "ลดเวลาตรวจงานก่อนปล่อยของ", explicit: true });
  ok(r1.status === 200 && r1.json && r1.json.proposal,
    `explicit request → 200 + proposal (got ${r1.status} ${r1.text.slice(0, 80)})`);
  const p = (r1.json && r1.json.proposal) || {};
  ok(/^npc\d+$/.test(p.requestId || ""), `requestId shape ok (${p.requestId})`);
  ok(p.requester === "main", `requester = main`);
  ok(nonEmpty(p.name) && p.name.length <= 40, `name present ("${p.name}")`);
  ok(p.role === "QA", `role preserved`);
  ok(nonEmpty(p.prompt) && p.prompt.trim().length >= 30,
    `prompt ≥ 30 chars (${(p.prompt || "").length})`);
  const px = p.persona || {};
  ok(typeof px === "object" && ["expertise", "personality", "language", "rules"]
    .every((k) => nonEmpty(px[k])), "persona{expertise,personality,language,rules} all non-empty");
  ok(p.tier === 3, `tier = 3`);
  ok(AURAS.includes(p.aura), `aura from editor set ("${p.aura}")`);
  ok(VOICES.includes(p.voice), `voice from VOICE_PRESETS ("${p.voice}")`);
  ok(Array.isArray(p.skills) && p.skills.every((s) => SKILL_IDS.includes(s)),
    `skills ⊆ office catalog [${(p.skills || []).join(", ")}]`);
  ok(Array.isArray(p.tools) && p.tools.length > 0,
    `tools non-empty [${(p.tools || []).join(", ")}]`);
  ok(MODELS.includes(p.model), `model from per-agent catalog (${p.model})`);
  ok(typeof p.avatarPath === "string", `avatarPath field present ("${p.avatarPath}")`);
  ok(nonEmpty(p.why), `why non-empty ("${(p.why || "").slice(0, 60)}…")`);
  ok(nonEmpty(p.benefit), `benefit carried through`);

  // ── 2. gating: pending proposal must NOT be on the roster/scene ──────────
  const reg1 = await httpJson("GET", "/registry");
  const ids1 = Object.keys(reg1.json.agents);
  ok(ids1.length === baseIds.length &&
     !Object.values(reg1.json.agents).some((a) => a.name === p.name),
    `pending proposal NOT in reg.agents (roster still ${ids1.length})`);

  // ── dedupe ───────────────────────────────────────────────────────────────
  const dup = await httpJson("POST", "/npc/request", {
    requesterId: "main", role: "qa",
    reason: "งานเทสต์เยอะช่วงนี้ ขอเพิ่มอีกใบ", explicit: true });
  ok(dup.status === 409, `duplicate requester+role (case-insensitive) → 409 (got ${dup.status})`);

  // ── 3. approve → registry-grade agent on the roster ─────────────────────
  const d1 = await httpJson("POST", "/npc/decision", { requestId: p.requestId, approved: true });
  ok(d1.status === 200 && d1.json && d1.json.approved === true && d1.json.agentId,
    `approve → 200 + agentId (${d1.json && d1.json.agentId})`);
  const newId = d1.json && d1.json.agentId;
  const reg2 = await httpJson("GET", "/registry");
  const a = (reg2.json.agents || {})[newId] || {};
  ok(!!reg2.json.agents[newId], `agent "${newId}" registered after approval`);
  ok(a.prompt === p.prompt, "agent.prompt = proposal.prompt");
  ok(a.persona && ["expertise", "personality", "language", "rules"]
    .every((k) => a.persona[k] === px[k]), "agent.persona matches proposal persona");
  ok(a.tier === 3 && a.aura === p.aura && a.voice === p.voice,
    `tier/aura/voice carried (3/"${a.aura}"/"${a.voice}")`);
  ok(JSON.stringify(a.skills) === JSON.stringify(p.skills) &&
     JSON.stringify(a.tools) === JSON.stringify(p.tools), "skills/tools carried verbatim");
  ok(a.avatar >= 1 && a.avatar <= 12, `avatar sprite assigned (${a.avatar})`);
  const pend1 = await httpJson("GET", "/npc/proposals");
  ok(pend1.json.proposals.length === 0, "approved proposal removed from pending");

  // per-agent model binding
  const ms = await httpJson("GET", "/settings/models");
  ok(ms.json && ms.json.perAgent && ms.json.perAgent[newId] === p.model,
    `modelSettings.perAgent[${newId}] = ${p.model}`);

  // ── 4. reject path ───────────────────────────────────────────────────────
  const r2 = await httpJson("POST", "/npc/request", {
    requesterId: "main", role: "Docs Helper",
    reason: "เอกสาร onboarding ค้างเยอะ ต้องมีคนช่วยเขียน", explicit: true });
  ok(r2.status === 200, `second explicit request → 200 (got ${r2.status})`);
  const rid2 = r2.json && r2.json.proposal && r2.json.proposal.requestId;
  const d2 = await httpJson("POST", "/npc/decision", { requestId: rid2, approved: false });
  ok(d2.status === 200 && d2.json && d2.json.approved === false, "reject → 200 approved:false");
  const reg3 = await httpJson("GET", "/registry");
  ok(Object.keys(reg3.json.agents).length === baseIds.length + 1,
    "rejected proposal never reached the roster");
  const pend2 = await httpJson("GET", "/npc/proposals");
  ok(pend2.json.proposals.length === 0, "pending empty after reject");

  // ── regression: /assist/prompt (the ✨ Draft copilot) still answers ──────
  const ap = await httpJson("POST", "/assist/prompt",
    { name: "Test", role: "QA", brief: "นัก QA ใจเย็น" });
  ok(ap.status === 200 && ap.json && nonEmpty(ap.json.prompt) &&
     (ap.json.skills || []).every((s) => SKILL_IDS.includes(s)),
    "/assist/prompt regression ok (same shared drafter)");

  console.log(process.exitCode ? "\n  RESULT: FAIL\n" : "\n  RESULT: PASS\n");
  process.exit(process.exitCode || 0);
})().catch((e) => { FAIL("fatal: " + e.message); process.exit(1); });
