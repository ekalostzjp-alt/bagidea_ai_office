// daemon/lock.js — Factory lock policy (pure, dependency-injected).
// ───────────────────────────────────────────────────────────────────────────
// One place that decides what "ล็อกชุด Default" means, so server.js wiring AND
// the e2e test the SAME logic. No I/O, no daemon boot — every dependency is
// passed in, so this module is trivially unit-testable against synthetic
// rosters and against the shipped registry.default.json.
//
// Three locks:
//   • protected agent  → POST /registry/agent/delete refuses (403). Factory team
//                         (main/ceo + the built characters) can never be deleted.
//   • model lock       → agent.modelLock pins the spawn model; POST /settings/models
//                         refuses to change/clear it (403); resolveModel honors it
//                         ABOVE perAgent/default so a stale override can't win.
//   • factory reconcile → loadReg() backfills protected + modelLock + iconText onto
//                         the LIVE roster from the seed every boot. The old loadReg
//                         only seeded MISSING agents, so a roster created before a
//                         field existed (e.g. the team had no `protected`) stayed
//                         unlocked forever. Reconcile makes the lock self-healing on
//                         both fresh installs and upgrades — idempotent.

"use strict";

// Is this agent record deletion-protected? (factory team / main / ceo)
function isProtected(agent) {
  return !!(agent && agent.protected === true);
}

// The model an agent is LOCKED to, or null if unlocked. `isSettable(id)` is the
// caller's validity gate (catalog id AND not an unavailable/403 model) — a lock
// to a now-unavailable model is treated as no lock so it can't brick spawning.
function lockedModelOf(agent, isSettable) {
  const m = agent && agent.modelLock;
  if (!m) return null;
  if (typeof isSettable === "function" && !isSettable(m)) return null;
  return m;
}

// Reconcile factory locks from a seed onto the live roster, in place.
//   • missing live agent → cloned in whole from the seed (fresh-install seeding).
//   • existing live agent → only the FACTORY-OWNED fields are forced from the
//     seed: protected, modelLock, iconText. Everything else the owner edited is
//     left untouched. A seed agent without one of these fields never clears the
//     live value (we only set, never delete) — so this is purely additive/locking.
// Returns a list of human-readable change strings (for logs/tests). Idempotent.
function reconcileFactoryLocks(liveAgents, seedAgents) {
  const changes = [];
  if (!liveAgents || !seedAgents) return changes;
  for (const [id, seed] of Object.entries(seedAgents)) {
    if (!seed || typeof seed !== "object") continue;
    if (!liveAgents[id]) {
      liveAgents[id] = JSON.parse(JSON.stringify(seed));   // clone: never alias the seed
      changes.push(`+ seeded '${id}' (protected=${!!seed.protected} modelLock=${seed.modelLock || "-"})`);
      continue;
    }
    const a = liveAgents[id];
    if (seed.protected === true && a.protected !== true) {
      a.protected = true;
      changes.push(`~ '${id}' protected → true`);
    }
    if (seed.modelLock && a.modelLock !== seed.modelLock) {
      const from = a.modelLock || "-";
      a.modelLock = seed.modelLock;
      changes.push(`~ '${id}' modelLock ${from} → ${seed.modelLock}`);
    }
    if (seed.iconText && a.iconText !== seed.iconText) {
      const from = a.iconText || "-";
      a.iconText = seed.iconText;
      changes.push(`~ '${id}' iconText '${from}' → '${seed.iconText}'`);
    }
  }
  return changes;
}

module.exports = { isProtected, lockedModelOf, reconcileFactoryLocks };
