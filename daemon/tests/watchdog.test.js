// WatchDog STEP 1 — proves evaluate() against the 3 rules + alias + cooldown.
// Pure module: no fs/timer/network, so every case feeds a fixed `now` and reads
// the returned wake[]/overlaps[] directly. No daemon boot, no clock dependency.
const test = require("node:test");
const assert = require("node:assert");
const { evaluate } = require("../watchdog");

const NOW = 1_000_000_000;
const THRESH = 120_000;          // 2 นาที (ตรงกับ AGENT_LIVE_TIMEOUT_MS เริ่มต้น)
const TTL = 30 * 60 * 1000;      // 30 นาที

// helper สร้าง payload ขั้นต่ำตาม contract
const P = (over) => Object.assign(
  { now: NOW, thresholdMs: THRESH, agents: [], claims: [], queue: [], warnings: [] },
  over,
);
const find = (wake, id) => wake.find((w) => w.id === id) || null;

// ── กติกา 1: stuck-heartbeat ───────────────────────────────────────────────────
test("rule1: working agent silent past threshold → stuck-heartbeat", () => {
  const r = evaluate(P({
    agents: [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: NOW - (THRESH + 5000) }],
  }));
  const w = find(r.wake, "black");
  assert.ok(w, "ต้องปลุก black");
  assert.equal(w.reason, "stuck-heartbeat");
  assert.equal(w.name, "แบล็ค");
});

test("rule1: stuck state also triggers; fresh working does NOT", () => {
  const r = evaluate(P({
    agents: [
      { id: "s", name: "S", state: "stuck", lastHeartbeatMs: NOW - (THRESH + 1) },
      { id: "ok", name: "OK", state: "working", lastHeartbeatMs: NOW - 1000 },
    ],
  }));
  assert.equal(find(r.wake, "s").reason, "stuck-heartbeat");
  assert.equal(find(r.wake, "ok"), null, "working สดๆ ต้องไม่ถูกปลุก");
});

test("rule1: respects server-computed timedOut even without heartbeat math", () => {
  const r = evaluate(P({
    agents: [{ id: "t", name: "T", state: "working", lastHeartbeatMs: null, timedOut: true }],
  }));
  assert.equal(find(r.wake, "t").reason, "stuck-heartbeat");
});

// ★ 10-นาที wake threshold: opts.wakeThresholdMs คุมการปลุก แยกจาก payload.thresholdMs
test("constant: STUCK_HEARTBEAT_MS = 600000 (10 นาที)", () => {
  assert.equal(require("../watchdog").STUCK_HEARTBEAT_MS, 600_000);
});

test("rule1: wakeThresholdMs (10m) gates wake — silent < 10m NOT woken even past payload threshold + timedOut", () => {
  const TEN = 600_000;
  // เงียบ 3 นาที: เกิน payload thresholdMs (2m) และ agent-status มาร์ค timedOut แล้ว
  // แต่ < เกณฑ์ปลุก 10 นาที ⇒ ยังถือว่าทำงานปกติ ห้ามปลุก (นี่คือบั๊กเดิมที่ปลุกถี่)
  const r1 = evaluate(P({
    agents: [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: NOW - 180_000, timedOut: true }],
  }), { wakeThresholdMs: TEN });
  assert.equal(find(r1.wake, "black"), null, "เงียบ < 10 นาที ต้องไม่ถูกปลุก แม้ timedOut(2m)=true");
  // เงียบ 11 นาที > เกณฑ์ปลุก ⇒ ปลุก
  const r2 = evaluate(P({
    agents: [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: NOW - 660_000 }],
  }), { wakeThresholdMs: TEN });
  assert.equal(find(r2.wake, "black").reason, "stuck-heartbeat");
  assert.match(find(r2.wake, "black").detail, /เกิน 600s/);
});

test("rule1: timedOut still trusted when heartbeat is uncomputable (silent==null)", () => {
  // heartbeat หาย คำนวณ silence ไม่ได้ → ต้องเชื่อ timedOut ของ server (fail-toward-detect)
  const r = evaluate(P({
    agents: [{ id: "t", name: "T", state: "working", lastHeartbeatMs: null, timedOut: true }],
  }), { wakeThresholdMs: 600_000 });
  assert.equal(find(r.wake, "t").reason, "stuck-heartbeat");
});

// ★ regression (Codex รอบ 2): lastHeartbeatMs:null ต้องถือเป็น "คำนวณไม่ได้" (silent==null)
// ไม่ใช่ถูก Number() coerce เป็น 0 → silent = now (มหาศาลตั้งแต่ epoch) → ปลุกผิดเสมอ.
// แยกแยะ bug ด้วย timedOut:false: ถ้า null→0 (bug) overThreshold จะ true ทั้งที่ไม่ควร;
// ถ้า null→uncomputable (fix) silent==null + timedOut:false ⇒ ไม่มีเหตุปลุกเลย.
test("rule1 regression: lastHeartbeatMs:null + timedOut:false → NOT woken (null is uncomputable, NOT 0)", () => {
  const r = evaluate(P({
    agents: [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: null, timedOut: false }],
  }), { wakeThresholdMs: 600_000 });
  assert.equal(find(r.wake, "black"), null,
    "null heartbeat คำนวณ silence ไม่ได้ + ไม่ timedOut ⇒ ต้องไม่ปลุก (ห้าม coerce null เป็น 0)");
});

// คู่กัน: ค่าว่าง/whitespace string ก็ต้องถือเป็นคำนวณไม่ได้เช่นกัน (Number(""/"  ")===0 = finite)
test('rule1 regression: lastHeartbeatMs="" / whitespace + timedOut:false → NOT woken', () => {
  for (const empty of ["", "   "]) {
    const r = evaluate(P({
      agents: [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: empty, timedOut: false }],
    }), { wakeThresholdMs: 600_000 });
    assert.equal(find(r.wake, "black"), null,
      `"${empty}" heartbeat ต้องถือเป็นคำนวณไม่ได้ ⇒ ไม่ปลุก (ห้าม coerce เป็น 0ms)`);
  }
});

// และเมื่อ null/empty แต่ server มาร์ค timedOut ⇒ ยังต้องปลุก (fail-toward-detect คงเดิม)
test('rule1 regression: lastHeartbeatMs="" + timedOut:true → still woken via trustTimedOut', () => {
  const r = evaluate(P({
    agents: [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: "", timedOut: true }],
  }), { wakeThresholdMs: 600_000 });
  assert.equal(find(r.wake, "black").reason, "stuck-heartbeat",
    "คำนวณ silence ไม่ได้ แต่ server timedOut ⇒ เชื่อ server (fail-toward-detect)");
  assert.match(find(r.wake, "black").detail, /ถูกมาร์ค timedOut/,
    "silent==null ต้องเข้า path 'ถูกมาร์ค timedOut' ไม่ใช่รายงานตัวเลขเงียบมั่ว");
});

// ★ regression (Codex รอบ 1): ไม่ฉีด wakeThresholdMs (fallback mode) → ต้องคงสัญญาเดิม
// fail-toward-detect: heartbeat เป็นตัวเลข เงียบยังไม่ถึง thresholdMs แต่ server มาร์ค
// timedOut=true ⇒ ยังต้องปลุก. (เคยพังตอน trustTimedOut ผูกกับ silent==null อย่างเดียว.)
test("rule1 fallback: no explicit wakeThresholdMs → server timedOut wakes even when silent < threshold", () => {
  const r = evaluate(P({
    agents: [{ id: "black", name: "แบล็ค", state: "working",
      lastHeartbeatMs: NOW - 1000, timedOut: true }],   // เงียบ 1s << thresholdMs(2m)
  }), {});   // ← ไม่ฉีด wakeThresholdMs
  assert.equal(find(r.wake, "black").reason, "stuck-heartbeat",
    "fallback mode ต้องเชื่อ server-computed timedOut ตามสัญญา comment :75-77");
});

// คู่ตรงข้าม: ฉีด wakeThresholdMs (explicit) แล้ว silence คำนวณได้ → timedOut ของแผง
// ต้องถูก "เพิกเฉย" ไม่ลัดวงจรเกณฑ์ปลุก (ยืนยันว่าการแยก flag ไม่กลับไปเชื่อ timedOut มั่ว).
test("rule1 explicit: wakeThresholdMs set + silent computable → panel timedOut is IGNORED below threshold", () => {
  const r = evaluate(P({
    agents: [{ id: "black", name: "แบล็ค", state: "working",
      lastHeartbeatMs: NOW - 1000, timedOut: true }],
  }), { wakeThresholdMs: 600_000 });
  assert.equal(find(r.wake, "black"), null,
    "ฉีด threshold + silence คำนวณได้ + ยังไม่ถึงเกณฑ์ ⇒ ไม่ปลุกแม้ timedOut=true");
});

// ★ regression (Codex รอบ 1): wakeThresholdMs = null / "" ต้อง fallback ไป payload.thresholdMs
// ไม่ใช่ถูก Number() coerce เป็น 0ms (Number(null)===0, Number("")===0 ทั้งคู่ finite).
// ถ้าเป็น 0ms agent ที่เงียบเกิน now แม้นิดเดียวจะถูกปลุกทันที — บั๊กที่ Codex จับ.
test("rule1 regression: wakeThresholdMs=null falls back to payload.thresholdMs (NOT 0ms)", () => {
  // เงียบ 1s << thresholdMs(2m) → ภายใต้ fallback ต้องไม่ปลุก. ถ้า bug (=0ms) จะถูกปลุก.
  const r1 = evaluate(P({
    agents: [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: NOW - 1000 }],
  }), { wakeThresholdMs: null });
  assert.equal(find(r1.wake, "black"), null, "null → fallback thresholdMs(2m), เงียบ 1s ห้ามปลุก");
  // เงียบเกิน thresholdMs จริง → ปลุก (ยืนยันว่า fallback ใช้ thresholdMs ของ payload เป๊ะ)
  const r2 = evaluate(P({
    agents: [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: NOW - (THRESH + 5000) }],
  }), { wakeThresholdMs: null });
  assert.equal(find(r2.wake, "black").reason, "stuck-heartbeat", "null → fallback แล้วเกินเกณฑ์ต้องปลุก");
});

test('rule1 regression: wakeThresholdMs="" (และ whitespace) falls back to payload.thresholdMs (NOT 0ms)', () => {
  for (const empty of ["", "   "]) {
    const r1 = evaluate(P({
      agents: [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: NOW - 1000 }],
    }), { wakeThresholdMs: empty });
    assert.equal(find(r1.wake, "black"), null,
      `"${empty}" → fallback thresholdMs(2m), เงียบ 1s ห้ามปลุก (ห้าม coerce เป็น 0ms)`);
    const r2 = evaluate(P({
      agents: [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: NOW - (THRESH + 5000) }],
    }), { wakeThresholdMs: empty });
    assert.equal(find(r2.wake, "black").reason, "stuck-heartbeat",
      `"${empty}" → fallback แล้วเกินเกณฑ์ต้องปลุก`);
  }
});

test('rule1 regression: numeric-string wakeThresholdMs="600000" is honored as explicit', () => {
  // เงียบ 3 นาที: เกิน thresholdMs(2m) แต่ < 10 นาที → ถ้า "600000" ถูกอ่านเป็น explicit จะไม่ปลุก
  const r = evaluate(P({
    agents: [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: NOW - 180_000, timedOut: true }],
  }), { wakeThresholdMs: "600000" });
  assert.equal(find(r.wake, "black"), null, 'numeric-string "600000" ต้องถือเป็นเกณฑ์ปลุก 10m');
});

// ── กติกา 2: idle-holding-work (รูที่ agent-status เดิมจับไม่ได้) ─────────────────
test("rule2: idle agent still holding an active claim → idle-holding-work", () => {
  const r = evaluate(P({
    agents: [{ id: "mister-n", name: "มิสเตอร์ N", state: "idle", lastHeartbeatMs: NOW - 10 }],
    claims: [{ agentId: "mister-n", project: "bagidea", files: ["content_script.js"], ts: NOW - 1000, ttlMs: TTL }],
  }));
  const w = find(r.wake, "mister-n");
  assert.ok(w, "idle-but-holding ต้องถูกจับ");
  assert.equal(w.reason, "idle-holding-work");
  assert.match(w.detail, /content_script\.js/);
});

test("rule2: idle with own queued entry → idle-holding-work", () => {
  const r = evaluate(P({
    agents: [{ id: "white", name: "White", state: "idle" }],
    queue: [{ claim: { agentId: "white", project: "bagidea", files: ["overlay.html"] } }],
  }));
  assert.equal(find(r.wake, "white").reason, "idle-holding-work");
});

test("rule2: idle with EXPIRED claim → not woken; idle clean → not woken", () => {
  const r = evaluate(P({
    agents: [
      { id: "exp", name: "Exp", state: "idle" },
      { id: "clean", name: "Clean", state: "idle" },
    ],
    claims: [{ agentId: "exp", project: "p", files: [], ts: NOW - (TTL + 1000), ttlMs: TTL }],
  }));
  assert.equal(find(r.wake, "exp"), null, "claim หมดอายุแล้วไม่ปลุก");
  assert.equal(find(r.wake, "clean"), null, "idle ว่างจริงไม่ปลุก");
});

test("rule2: claim missing ts/ttlMs → fail-open (treated as active)", () => {
  const r = evaluate(P({
    agents: [{ id: "n", name: "N", state: "idle" }],
    claims: [{ agentId: "n", project: "p", files: ["x.js"] }],   // no ts/ttlMs
  }));
  assert.equal(find(r.wake, "n").reason, "idle-holding-work");
});

// ── กติกา 3: overlaps ───────────────────────────────────────────────────────────
test("rule3: project-overlap warnings forwarded; file-overlap dropped", () => {
  const r = evaluate(P({
    warnings: [
      { type: "project-overlap", project: "bagidea", agents: ["black", "white"], severity: "warn" },
      { type: "file-overlap", project: "bagidea", agents: ["a", "b"], severity: "block" },
    ],
  }));
  assert.equal(r.overlaps.length, 1);
  assert.equal(r.overlaps[0].type, "project-overlap");
  assert.deepEqual(r.overlaps[0].agents, ["black", "white"]);
});

// ── alias: claim.agentId (latin) ⇄ roster id (ไทย) ─────────────────────────────
test("alias: latin claim agentId matches Thai roster id via opts.aliases", () => {
  const payload = P({
    agents: [{ id: "มิสเตอร์-n", name: "มิสเตอร์ N", state: "idle" }],
    claims: [{ agentId: "mister-n", project: "bagidea", files: ["content_script.js"], ts: NOW - 500, ttlMs: TTL }],
  });
  // ไม่มี alias ⇒ จับไม่ได้ (พิสูจน์ว่า match พึ่ง alias จริง)
  assert.equal(find(evaluate(payload).wake, "มิสเตอร์-n"), null);
  // มี alias ⇒ จับได้
  const r = evaluate(payload, { aliases: { "mister-n": "มิสเตอร์-n" } });
  assert.equal(find(r.wake, "มิสเตอร์-n").reason, "idle-holding-work");
});

// ── cooldown: กันปลุกซ้ำถี่ ข้ามภาษาด้วย ───────────────────────────────────────
test("cooldown: recently-woken agent is suppressed, then fires once cooled", () => {
  const agents = [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: NOW - (THRESH + 5000) }];
  // เพิ่งปลุกไป 10s ที่แล้ว, cooldown 60s ⇒ ข้าม
  const suppressed = evaluate(P({ agents }), { cooldownMs: 60_000, wokenAt: { black: NOW - 10_000 } });
  assert.equal(find(suppressed.wake, "black"), null, "ภายใน cooldown ต้องไม่ปลุกซ้ำ");
  // ปลุกไปแล้ว 90s ที่แล้ว > cooldown ⇒ ปลุกได้
  const fired = evaluate(P({ agents }), { cooldownMs: 60_000, wokenAt: { black: NOW - 90_000 } });
  assert.equal(find(fired.wake, "black").reason, "stuck-heartbeat");
});

test("cooldown: works across alias (wokenAt keyed by latin, agent id Thai)", () => {
  const payload = P({
    agents: [{ id: "มิสเตอร์-n", name: "มิสเตอร์ N", state: "idle" }],
    claims: [{ agentId: "mister-n", project: "bagidea", files: ["x.js"], ts: NOW - 500, ttlMs: TTL }],
  });
  const opts = { aliases: { "mister-n": "มิสเตอร์-n" }, cooldownMs: 60_000, wokenAt: { "มิสเตอร์-n": NOW - 5_000 } };
  assert.equal(find(evaluate(payload, opts).wake, "มิสเตอร์-n"), null, "cooldown ต้องครอบทั้ง canonical id");
});

// ── shape: คืน now/thresholdMs ตามสัญญา ────────────────────────────────────────
test("shape: returns now + thresholdMs echoed from payload", () => {
  const r = evaluate(P({}));
  assert.equal(r.now, NOW);
  assert.equal(r.thresholdMs, THRESH);
  assert.deepEqual(r.wake, []);
  assert.deepEqual(r.overlaps, []);
});

// ════════════════════════════════════════════════════════════════════════════
// STEP 2 — runtime loop + auto-wake (watchdog-runtime.js)
// ทุก side-effect ฉีดเป็น deps + clock ฉีดเอง → deterministic, ไม่บูต daemon,
// ไม่พึ่ง Date.now/timer จริง. tick() ถูกเรียกตรงๆ เพื่อพิสูจน์ loop/wake/cooldown.
// ════════════════════════════════════════════════════════════════════════════
const { createWatchdog } = require("../watchdog-runtime");

// harness: clock ที่เลื่อนได้ + บันทึก wake/broadcast เพื่อ assert.
function harness(over) {
  const env = {
    clock: NOW,
    woke: [],          // [{id, reason}]
    msgs: [],          // broadcast payloads
    payload: P({}),    // ปรับได้ก่อน/ระหว่างเทสต์
    wakeThrow: null,   // ถ้าตั้ง → wake() จะ throw ค่านี้
  };
  Object.assign(env, over || {});
  const wd = createWatchdog({
    evaluate,
    // agent-status stamps a fresh `ts`/`now` each call → จำลองด้วยการ sync now=clock.
    fetchStatus: async () => (env.payload == null ? null : { ...env.payload, now: env.clock }),
    wake: async (entry) => {
      if (env.wakeThrow) throw env.wakeThrow;
      env.woke.push({ id: entry.id, reason: entry.reason });
    },
    broadcast: (m) => env.msgs.push(m),
    now: () => env.clock,
    aliases: () => env.aliases || {},
    cooldownMs: 60_000,
    intervalMs: 30_000,
    // เคสในชุดนี้เขียนรอบ THRESH (2 นาที); ฉีดเป็นเกณฑ์ปลุกให้ตรง ไม่งั้นโดน default
    // ใหม่ 10 นาทีกลืน. เคสที่อยากทดสอบ default จริงสร้าง watchdog เองด้านล่าง.
    stuckHeartbeatMs: env.stuckHeartbeatMs != null ? env.stuckHeartbeatMs : THRESH,
  });
  return { env, wd };
}

test("step2: tick wakes every wake[] entry + broadcasts a notice each", async () => {
  const { env, wd } = harness({
    payload: P({
      agents: [
        { id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: NOW - (THRESH + 5000) },
        { id: "white", name: "White", state: "idle" },
        { id: "ok", name: "OK", state: "working", lastHeartbeatMs: NOW - 1000 },
      ],
      queue: [{ claim: { agentId: "white", project: "bagidea", files: ["overlay.html"] } }],
    }),
  });
  const r = await wd.tick();
  assert.equal(r.wake.length, 2, "black(stuck) + white(idle-holding)");
  assert.deepEqual(env.woke.map((w) => w.id).sort(), ["black", "white"]);
  assert.equal(env.woke.find((w) => w.id === "black").reason, "stuck-heartbeat");
  // broadcast หนึ่งครั้งต่อ wake
  const wakeMsgs = env.msgs.filter((m) => /WatchDog ปลุก/.test(m.text || ""));
  assert.equal(wakeMsgs.length, 2);
});

// ★ เคส verify หลัก: มิสเตอร์ N idle + ถือ claim ค้าง (claim เป็น latin) → ต้องโดนปลุก
test("step2: VERIFY — idle มิสเตอร์ N holding a stale latin claim is woken", async () => {
  const { env, wd } = harness({
    aliases: { "mister-n": "มิสเตอร์-n" },
    payload: P({
      agents: [{ id: "มิสเตอร์-n", name: "มิสเตอร์ N", state: "idle", lastHeartbeatMs: NOW - 10 }],
      claims: [{ agentId: "mister-n", project: "bagidea", files: ["server.js"], ts: NOW - 1000, ttlMs: TTL }],
    }),
  });
  const r = await wd.tick();
  assert.equal(r.wake.length, 1);
  assert.equal(env.woke[0].id, "มิสเตอร์-n");
  assert.equal(env.woke[0].reason, "idle-holding-work");
});

test("step2: cooldown across ticks — same agent not re-woken until cooled (inject clock)", async () => {
  const { env, wd } = harness({
    payload: P({
      agents: [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: NOW - (THRESH + 5000) }],
    }),
  });
  // รอบ 1: ปลุก
  await wd.tick();
  assert.equal(env.woke.length, 1, "รอบแรกต้องปลุก");
  // heartbeat ยังเงียบเท่าเดิมเทียบ clock ใหม่ (เลื่อน clock + เลื่อน lastHeartbeat ตาม)
  env.clock = NOW + 30_000;          // < cooldown 60s
  env.payload.agents[0].lastHeartbeatMs = env.clock - (THRESH + 5000);
  await wd.tick();
  assert.equal(env.woke.length, 1, "ภายใน cooldown ต้องไม่ปลุกซ้ำ");
  // เลื่อนเลย cooldown
  env.clock = NOW + 70_000;          // > cooldown 60s นับจาก NOW
  env.payload.agents[0].lastHeartbeatMs = env.clock - (THRESH + 5000);
  await wd.tick();
  assert.equal(env.woke.length, 2, "พ้น cooldown แล้วปลุกได้อีก");
});

test("step2: fail-soft — fetchStatus null → no wake, returns error marker", async () => {
  const { env, wd } = harness({ payload: null });
  const r = await wd.tick();
  assert.equal(r.error, "no-payload");
  assert.equal(env.woke.length, 0);
});

test("step2: wake() throwing is contained — loop survives + cooldown still marked", async () => {
  const { env, wd } = harness({
    wakeThrow: new Error("spawn boom"),
    payload: P({
      agents: [{ id: "black", name: "แบล็ค", state: "working", lastHeartbeatMs: NOW - (THRESH + 5000) }],
    }),
  });
  const r1 = await wd.tick();              // ไม่ throw ออกมา
  assert.equal(r1.wake.length, 1);
  assert.equal(env.woke.length, 0, "wake พังจึงไม่ถูกบันทึก");
  assert.ok(env.msgs.some((m) => /ไม่สำเร็จ/.test(m.text || "")), "ต้อง broadcast แจ้ง wake พัง");
  // wokenAt ถูกมาร์คก่อนเรียก wake → รอบถัดไปในช่วง cooldown ต้องไม่ retry รัวๆ
  env.clock = NOW + 30_000;
  env.payload.agents[0].lastHeartbeatMs = env.clock - (THRESH + 5000);
  const r2 = await wd.tick();
  assert.equal(r2.wake.length, 0, "ยังอยู่ใน cooldown — ไม่ retry ถี่ๆ");
});

test("step2: clean office wakes nobody; start()/stop() are safe no-ops", async () => {
  const { env, wd } = harness({
    payload: P({ agents: [{ id: "idleok", name: "Idle", state: "idle" }] }),
  });
  const r = await wd.tick();
  assert.equal(r.wake.length, 0);
  assert.equal(env.woke.length, 0);
  wd.start(); wd.start(); wd.stop(); wd.stop();   // idempotent, ไม่ throw
});

// ★ VERIFY: default wake threshold ของ runtime = 10 นาที (production path ไม่ฉีด override)
test("step2: default wake threshold is 10 min — heartbeat < 10m NOT woken, > 10m woken", async () => {
  const MIN = 60_000;
  let clock = NOW;
  let payload;
  const woke = [];
  const wd = createWatchdog({
    evaluate,
    fetchStatus: async () => (payload == null ? null : { ...payload, now: clock }),
    wake: async (e) => woke.push(e.id),
    now: () => clock,
  });
  assert.equal(wd.stuckHeartbeatMs, 600_000, "default = STUCK_HEARTBEAT_MS (10 นาที)");

  // เงียบ 9 นาที (< 10) แม้ agent-status มาร์ค timedOut (เกณฑ์ 2 นาที) → ต้องไม่ปลุก
  payload = P({ agents: [{ id: "black", name: "แบล็ค", state: "working",
    lastHeartbeatMs: NOW - 9 * MIN, timedOut: true }] });
  const r1 = await wd.tick();
  assert.equal(r1.wake.length, 0, "heartbeat เงียบ 9 นาที (<10) ต้องไม่ถูกปลุก แม้ timedOut=true");
  assert.equal(woke.length, 0);

  // เงียบ 11 นาที (> 10) → ปลุก
  clock = NOW + 11 * MIN;
  payload = P({ agents: [{ id: "black", name: "แบล็ค", state: "working",
    lastHeartbeatMs: clock - 11 * MIN }] });
  const r2 = await wd.tick();
  assert.equal(r2.wake.length, 1, "heartbeat เงียบ 11 นาที (>10) ต้องถูกปลุก");
  assert.equal(woke[0], "black");
});

test("step2: in-flight guard — overlapping tick is skipped, not stacked", async () => {
  // fetchStatus ที่ค้างจนกว่าจะปลด → tick แรกยังไม่จบ, tick ที่สองต้องโดนข้าม.
  let release;
  const gate = new Promise((res) => { release = res; });
  const wd = createWatchdog({
    evaluate,
    fetchStatus: async () => { await gate; return P({}); },
    wake: async () => {},
    now: () => NOW,
  });
  const first = wd.tick();
  const second = await wd.tick();          // first ยังค้างที่ gate
  assert.equal(second.skipped, "in-flight");
  release(P({}));
  await first;
});
