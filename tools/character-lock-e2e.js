#!/usr/bin/env node
// tools/character-lock-e2e.js — มิสเตอร์ N
// ───────────────────────────────────────────────────────────────────────────
// e2e for "ล็อกชุด Default (Agent + Model + Plugin)". SANDBOX by design: it
// loads the PURE policy module (daemon/lock.js) and asserts the SHIPPED config
// files read-only — it never boots a daemon and never touches live state
// (registry.json / model-settings.json / :8787), so it's safe to run anytime.
//
// Covers:
//   1) lock.js logic: isProtected / lockedModelOf / reconcileFactoryLocks
//   2) registry.default.json: team protected + modelLock pinned to a settable id
//   3) the 5 shipped plugins are all core:true (un-deletable)
//   4) constants.js: main/ceo protected
//   5) secret-free default (no apiKeys leaked into the tracked seed)
//   6) the exact guard expressions server.js uses for the 403/400 rejects

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const lock = require(path.join(ROOT, "daemon", "lock.js"));

// Mirror of server.js model-settable rule: catalog id AND not unavailable (403).
const SETTABLE = new Set(["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
const isSettable = (id) => id === null || SETTABLE.has(id);

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log("  ✓ " + name); };
const bad = (name, e) => { fail++; console.log("  ✗ " + name + " — " + (e && e.message || e)); };
function t(name, fn) { try { fn(); ok(name); } catch (e) { bad(name, e); } }

console.log("== 1. lock.js — isProtected / lockedModelOf ==");
t("isProtected: protected:true → true", () => assert.strictEqual(lock.isProtected({ protected: true }), true));
t("isProtected: protected:false → false", () => assert.strictEqual(lock.isProtected({ protected: false }), false));
t("isProtected: missing field → false", () => assert.strictEqual(lock.isProtected({}), false));
t("isProtected: null agent → false", () => assert.strictEqual(lock.isProtected(null), false));
t("lockedModelOf: settable lock → returns it", () =>
  assert.strictEqual(lock.lockedModelOf({ modelLock: "claude-opus-4-8" }, isSettable), "claude-opus-4-8"));
t("lockedModelOf: no modelLock → null", () =>
  assert.strictEqual(lock.lockedModelOf({}, isSettable), null));
t("lockedModelOf: unavailable lock (fable) → null (won't brick spawn)", () =>
  assert.strictEqual(lock.lockedModelOf({ modelLock: "claude-fable-5" }, isSettable), null));

console.log("== 2. lock.js — reconcileFactoryLocks ==");
t("seeds a MISSING agent in full (deep clone, not aliased)", () => {
  const seed = { bob: { name: "Bob", protected: true, modelLock: "claude-opus-4-8", skills: ["x"] } };
  const live = {};
  const ch = lock.reconcileFactoryLocks(live, seed);
  assert.ok(live.bob && live.bob.protected === true && live.bob.modelLock === "claude-opus-4-8");
  live.bob.skills.push("y");                       // mutate the clone…
  assert.deepStrictEqual(seed.bob.skills, ["x"]);  // …seed must be untouched
  assert.ok(ch.length >= 1);
});
t("forces protected + modelLock + iconText onto an EXISTING unlocked agent", () => {
  const seed = { n: { protected: true, modelLock: "claude-opus-4-8", iconText: "🛡" } };
  const live = { n: { name: "N", skills: ["a"] } };
  lock.reconcileFactoryLocks(live, seed);
  assert.strictEqual(live.n.protected, true);
  assert.strictEqual(live.n.modelLock, "claude-opus-4-8");
  assert.strictEqual(live.n.iconText, "🛡");
  assert.deepStrictEqual(live.n.skills, ["a"]);    // owner edits preserved
});
t("never CLEARS a live value when the seed lacks the field (additive only)", () => {
  const seed = { n: { protected: true } };          // no modelLock in seed
  const live = { n: { protected: true, modelLock: "claude-sonnet-4-6" } };
  lock.reconcileFactoryLocks(live, seed);
  assert.strictEqual(live.n.modelLock, "claude-sonnet-4-6");
});
t("is idempotent (2nd run reports no changes)", () => {
  const seed = { n: { protected: true, modelLock: "claude-opus-4-8" } };
  const live = {};
  lock.reconcileFactoryLocks(live, seed);
  const ch2 = lock.reconcileFactoryLocks(live, seed);
  assert.strictEqual(ch2.length, 0);
});

console.log("== 3. registry.default.json — team locked + settable models ==");
const def = JSON.parse(fs.readFileSync(path.join(ROOT, "daemon", "registry.default.json"), "utf8"));
const EXPECT_MODEL = {
  "มิสเตอร์-n": "claude-opus-4-8",
  "น้องไวท์": "claude-opus-4-8",
  "แบล็ค": "claude-opus-4-8",
  "muse": "claude-sonnet-4-6",
};
for (const [id, model] of Object.entries(EXPECT_MODEL)) {
  t(`default '${id}': protected + modelLock=${model} (settable)`, () => {
    const a = def.agents[id];
    assert.ok(a, "agent missing from default seed");
    assert.strictEqual(a.protected, true, "not protected");
    assert.strictEqual(a.modelLock, model, "wrong/absent modelLock");
    assert.ok(isSettable(a.modelLock), "locked model is not settable (would brick spawn)");
  });
}

console.log("== 4. shipped plugins — all core:true (un-deletable) ==");
const SHIPPED = ["music", "calculator", "agent-status", "bagidea-monitoring", "integration-hub"];
for (const id of SHIPPED) {
  t(`plugin '${id}' core:true`, () => {
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", id, "plugin.json"), "utf8"));
    assert.strictEqual(man.core, true, "core flag not set");
  });
}

console.log("== 5. constants.js — main/ceo protected ==");
const { DEFAULT_MAIN_AGENT, DEFAULT_CEO_AGENT } = require(path.join(ROOT, "daemon", "constants.js"));
t("DEFAULT_MAIN_AGENT.protected === true", () => assert.strictEqual(DEFAULT_MAIN_AGENT.protected, true));
t("DEFAULT_CEO_AGENT.protected === true", () => assert.strictEqual(DEFAULT_CEO_AGENT.protected, true));

console.log("== 6. secret-free default seed ==");
t("registry.default.json has NO apiKeys", () => assert.ok(!def.apiKeys, "apiKeys leaked into tracked seed"));
t("no value in the seed looks like an OpenAI/Gemini key", () => {
  const blob = JSON.stringify(def);
  assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(blob), "OpenAI-style secret in seed");
  assert.ok(!/AIza[0-9A-Za-z_\-]{30,}/.test(blob), "Gemini-style secret in seed");
});

console.log("== 7. server guard expressions (same calls server.js makes) ==");
t("delete guard: protected agent would be refused (403)", () => {
  const reg = { agents: { "มิสเตอร์-n": { protected: true }, tmp: { protected: false } } };
  assert.strictEqual(lock.isProtected(reg.agents["มิสเตอร์-n"]), true);   // → res 403
  assert.strictEqual(lock.isProtected(reg.agents.tmp), false);            // → deletable
});
t("/settings/models pre-pass: locked agent in perAgent is detected (403)", () => {
  const reg = { agents: { "แบล็ค": { modelLock: "claude-opus-4-8" }, free: {} } };
  const body = { perAgent: { "แบล็ค": "claude-haiku-4-5-20251001", free: "claude-sonnet-4-6" } };
  const locked = Object.keys(body.perAgent).filter((aid) =>
    reg.agents[aid] && lock.lockedModelOf(reg.agents[aid], isSettable));
  assert.deepStrictEqual(locked, ["แบล็ค"]);   // request rejected, "free" alone would pass
});

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
