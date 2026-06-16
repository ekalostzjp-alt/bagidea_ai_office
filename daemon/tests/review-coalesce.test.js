// Coalesced Codex review gate — proves ONE review per project per work session
// instead of one per agent per onDone. Pure module: busy()/run() are stubs, no
// daemon boot, no timers. Mirrors server.js wiring (busy=officeBusy, run=runReviewGate).
const test = require("node:test");
const assert = require("node:assert");
const { createReviewCoalescer } = require("../review-coalesce");

// many agents finish in one project while the office is busy → exactly one
// review fires once it idles, against the LATEST deliverer (fail bounces to them).
test("multiple agents, one project → ONE review after idle, latest agent", async () => {
  let busy = true;
  const calls = [];
  const c = createReviewCoalescer({ busy: () => busy, run: async (a, p) => calls.push([a, p]) });
  await c.arm("proj1", "black");   // agent 1 done (office still busy)
  await c.arm("proj1", "white");   // agent 2 done, same project
  await c.arm("proj1", "ned");     // agent 3 done
  assert.equal(calls.length, 0, "busy → nothing reviewed yet");
  assert.equal(c.pending.size, 1, "deduped to a single pending project");
  busy = false;
  await c.drain();
  assert.equal(calls.length, 1, "review runs exactly once");
  assert.deepEqual(calls[0], ["ned", "proj1"], "reviews as the latest deliverer");
});

// distinct projects are independent — each reviewed once.
test("separate projects each reviewed once", async () => {
  const calls = [];
  const c = createReviewCoalescer({ busy: () => false, run: async (a, p) => calls.push(p) });
  await c.arm("p1", "a");
  await c.arm("p2", "b");
  assert.deepEqual(calls.sort(), ["p1", "p2"]);
});

// office never goes idle → review stays armed, nothing fires (no premature burn).
test("stays armed while busy", async () => {
  const c = createReviewCoalescer({ busy: () => true, run: async () => assert.fail("must not run") });
  await c.arm("p1", "a");
  await c.arm("p1", "a");
  assert.equal(c.pending.size, 1, "queued, deduped, not run");
});

// a fail bounce makes the office busy again mid-drain → drainer stops, resumes
// only when idle (preserves the bounce→rework→re-review cycle).
test("re-busy mid-drain stops the loop until idle again", async () => {
  let busy = false;
  const order = [];
  const c = createReviewCoalescer({
    busy: () => busy,
    run: async (a, p) => { order.push(p); if (p === "p1") busy = true; },  // p1 review "bounces" → busy
  });
  await c.arm("p1", "a");
  await c.arm("p2", "b");   // queued behind p1
  assert.deepEqual(order, ["p1"], "p2 deferred while office re-busied");
  assert.equal(c.pending.size, 1);
  busy = false;
  await c.drain();
  assert.deepEqual(order, ["p1", "p2"], "p2 drains once idle returns");
});

// fail-open: a throwing review surfaces via onError and never wedges the drainer.
test("review error is fail-open, drainer recovers", async () => {
  let err = null;
  const c = createReviewCoalescer({
    busy: () => false,
    run: async () => { throw new Error("codex boom"); },
    onError: (e) => { err = e; },
  });
  await c.arm("p1", "a");
  assert.ok(err && /boom/.test(err.message), "error surfaced, not thrown");
  assert.equal(c.pending.size, 0, "drainer cleared and is ready for the next arm");
  await c.arm("p2", "b");   // still usable
  assert.equal(c.pending.size, 0);
});
