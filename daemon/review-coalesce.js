// ponytail: coalesce the Codex review gate to ONE pass per project per work
// session. Every agent finishing a project-bound delivery used to fire the gate
// immediately (server.js onDone × N agents), so the shared central files
// (PROJECT_BRAIN.md / CLAUDE.md / CLAUDE_CHANGELOG.md) got re-reviewed every
// round by every agent — pure token waste. Instead we mark the project pending
// (keeping the LATEST deliverer to bounce a fail back to) and run a single
// review once the office goes idle.
//
// Pure mechanism: no timers / fs / network. server.js injects busy() (office
// idle check) and run(agentId, project) (= runReviewGate); the test injects
// stubs. State is RAM-only — a daemon restart drops the queue, and the next
// delivery simply re-arms it (the passby re-review queue in review-gate.json is
// the durable layer, untouched here).
function createReviewCoalescer({ busy, run, onError }) {
  const pending = new Map();   // projectId -> agentId (latest deliverer)
  let draining = false;

  function arm(project, agentId) {
    pending.set(project, agentId);   // dedup per project, keep the latest agent
    return drain();
  }

  async function drain() {
    if (draining || !pending.size || busy()) return;   // wait — caller re-triggers when idle
    draining = true;
    try {
      // Re-check busy() each lap: a fail bounce dispatches a new job (office
      // busy again) → stop and let the next idle drain it. Preserves the
      // bounce→rework→re-review cycle and REVIEW_MAX_ROUNDS in runReviewGate.
      while (!busy() && pending.size) {
        const [project, agentId] = pending.entries().next().value;
        pending.delete(project);
        try { await run(agentId, project); }
        catch (e) { if (onError) onError(e); }   // fail-open: one bad review never wedges the rest
      }
    } finally { draining = false; }
  }

  return { arm, drain, pending };
}

module.exports = { createReviewCoalescer };
