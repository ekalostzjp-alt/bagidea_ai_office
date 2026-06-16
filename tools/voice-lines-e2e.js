// e2e for the voice-lines overhaul v2 (docs/voice-lines.contract.md §7)
// against a sandbox daemon. Phase from argv: "up" (OpenAI live) or "down"
// (key broken — Thai fallback must still speak). Exits non-zero on failure.
const BASE = process.env.VOICE_E2E_BASE || "http://127.0.0.1:8799";
const PHASE = process.argv[2] || "up";
const AGENT = "มิสเตอร์-n";          // bank-building agent (phase up)
const AGENT2 = "แบล็ค";              // pair partner
const FRESH = "น้องไวท์";            // stays bank-less until fallback test
const TH = /[฀-๿]/;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name + (extra ? " — " + extra : "")); }
  else { fail++; console.log("  ❌ " + name + (extra ? " — " + extra : "")); }
}

function api(method, path, body) {
  // plain http (not fetch/undici): keeps the event loop clean so exit codes
  // survive on Windows.
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const rq = require("http").request(BASE + path, {
      method, headers: { "content-type": "application/json", "x-bagidea-ui": "1",
        ...(payload ? { "content-length": payload.length } : {}) } }, (rs) => {
      let t = "";
      rs.setEncoding("utf8");
      rs.on("data", (c) => (t += c));
      rs.on("end", () => {
        let j = null; try { j = JSON.parse(t); } catch {}
        resolve({ status: rs.statusCode, json: j, text: t });
      });
    });
    rq.on("error", reject);
    if (payload) rq.write(payload);
    rq.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollLines(agent, test, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const r = await api("GET", "/voice/lines?agent=" + encodeURIComponent(agent));
    if (test(r.json)) return r.json;
    if (Date.now() - t0 > timeoutMs) return r.json;
    await sleep(1500);
  }
}

(async () => {
  console.log("== voice e2e v2 phase:", PHASE);
  const h = await api("GET", "/health");
  ok("health", h.status === 200);

  if (PHASE === "up") {
    // §7.1+2 done lines: say x5 — Thai, no consecutive repeats; bank refills
    const says = [];
    for (let i = 0; i < 5; i++) says.push((await api("POST", "/voice/say", { agentId: AGENT })).json.text);
    ok("say x5 non-empty Thai", says.every((s) => s && TH.test(s)), JSON.stringify(says.slice(0, 2)));
    ok("say no consecutive repeat", says.every((s, i) => i === 0 || s !== says[i - 1]));
    const gl1 = await pollLines(AGENT, (j) => j.bank.length >= 8, 30000);
    ok("done bank refilled", gl1.bank.length >= 8, "bank=" + gl1.bank.length);
    ok("done bank all Thai", gl1.bank.every((s) => TH.test(s)), JSON.stringify(gl1.bank.slice(0, 2)));

    // §7.3 ambient: x5 — Thai, no consecutive repeats; ambient.bank refills
    const ambs = [];
    for (let i = 0; i < 5; i++) ambs.push((await api("POST", "/voice/ambient", { agentId: AGENT })).json.text);
    ok("ambient x5 non-empty Thai", ambs.every((s) => s && TH.test(s)), JSON.stringify(ambs.slice(0, 2)));
    ok("ambient no consecutive repeat", ambs.every((s, i) => i === 0 || s !== ambs[i - 1]));
    const gl2 = await pollLines(AGENT, (j) => j.ambient.bank.length >= 8, 30000);
    ok("ambient bank refilled", gl2.ambient.bank.length >= 8, "amb=" + gl2.ambient.bank.length);
    const rnd = await api("POST", "/voice/ambient", {});
    ok("ambient random agent", rnd.status === 200 && !!rnd.json.agentId && TH.test(rnd.json.text),
      rnd.json.agentId);

    // §7.4 interact pair: real participants, Thai; repeat → cache, no new API
    const i1 = await api("POST", "/voice/interact", { agents: [AGENT, AGENT2], ctx: "sofa" });
    ok("interact pair 200", i1.status === 200 && i1.json.ctx === "sofa");
    ok("interact pair who real", (i1.json.lines || []).length >= 2 &&
      i1.json.lines.every((l) => [AGENT, AGENT2].includes(l.who) && TH.test(l.text)),
      JSON.stringify((i1.json.lines || [])[0] || {}).slice(0, 140));
    const i2 = await api("POST", "/voice/interact", { agents: [AGENT, AGENT2], ctx: "sofa" });
    ok("interact pair repeat = cache", i2.json.source === "cache", "source=" + i2.json.source);

    // interact solo (cat) — speaker is the requested agent
    const s1 = await api("POST", "/voice/interact", { agents: [AGENT], ctx: "cat" });
    ok("interact solo 200", s1.status === 200 && s1.json.ctx === "cat");
    ok("interact solo who+Thai", (s1.json.lines || []).every((l) => l.who === AGENT && TH.test(l.text)),
      JSON.stringify((s1.json.lines || [])[0] || {}).slice(0, 140));
    const s2 = await api("POST", "/voice/interact", { agents: [AGENT], ctx: "cat" });
    ok("interact solo repeat = cache", s2.json.source === "cache", "source=" + s2.json.source);

    // GET /voice/lines shape: ambient + scenes summary for this agent
    const gl3 = await api("GET", "/voice/lines?agent=" + encodeURIComponent(AGENT));
    const sk = Object.keys(gl3.json.scenes || {});
    ok("scenes summary present", sk.some((k) => k.startsWith("sofa::")) && sk.some((k) => k.startsWith("cat::")),
      JSON.stringify(sk));

    // unknown agent → 404
    const r404 = await api("POST", "/voice/ambient", { agentId: "ghost-xyz" });
    ok("unknown agent 404", r404.status === 404);
  }

  if (PHASE === "down") {
    // §7.5 OpenAI broken in this boot — everything still answers in Thai.
    const a1 = await api("POST", "/voice/ambient", { agentId: FRESH });
    ok("ambient fallback Thai", a1.status === 200 && TH.test(a1.json.text), JSON.stringify(a1.json.text));
    const s1 = await api("POST", "/voice/say", { agentId: FRESH });
    ok("say fallback Thai", s1.status === 200 && TH.test(s1.json.text), JSON.stringify(s1.json.text));
    const s2 = await api("POST", "/voice/say", { agentId: AGENT });
    ok("say from persisted bank", s2.status === 200 && TH.test(s2.json.text), JSON.stringify(s2.json.text));
    const i1 = await api("POST", "/voice/interact", { agents: [FRESH, AGENT2], ctx: "garden" });
    ok("interact pair fallback", i1.status === 200 && i1.json.source === "fallback" &&
      i1.json.lines.every((l) => TH.test(l.text)), "source=" + (i1.json || {}).source);
    const i2 = await api("POST", "/voice/interact", { agents: [FRESH], ctx: "dog" });
    ok("interact solo fallback", i2.status === 200 && i2.json.source === "fallback" &&
      i2.json.lines.every((l) => l.who === FRESH && TH.test(l.text)),
      JSON.stringify((i2.json.lines || [])[0] || {}).slice(0, 120));
    const h2 = await api("GET", "/health");
    ok("daemon alive after failures", h2.status === 200);
  }

  console.log("== result:", pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("E2E crashed:", e); process.exit(2); });
