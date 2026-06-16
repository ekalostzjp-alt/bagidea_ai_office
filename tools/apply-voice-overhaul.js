// Applies the voice-lines overhaul v2 (docs/voice-lines.contract.md: done +
// ambient + interaction scenes, natural Thai, refillPool cost guard, sanitize
// on load) onto a server.js — anchor-based string replacement, so it survives
// CRLF endings and unrelated edits elsewhere in the file (e.g. the NPC set).
// Usage:  node apply-voice-overhaul.js <path-to-server.js>
// Idempotent: refuses to run twice (detects the inserted marker).
const fs = require("fs");

const target = process.argv[2];
if (!target) { console.error("usage: node apply-voice-overhaul.js <server.js>"); process.exit(2); }

const raw = fs.readFileSync(target, "utf8");
const crlf = raw.includes("\r\n");
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("INTERACT_CONTEXTS")) {
  console.log("already applied — nothing to do");
  process.exit(0);
}

let applied = 0;
function rep(name, from, to) {
  const i = src.indexOf(from);
  if (i < 0) throw new Error("anchor not found: " + name);
  if (src.indexOf(from, i + 1) >= 0) throw new Error("anchor not unique: " + name);
  src = src.slice(0, i) + to + src.slice(i + from.length);
  applied++;
  console.log("  ✔ " + name);
}

// 1. done-line prompt → natural spoken Thai
rep("done-line prompt",
`        "แต่ง \\"ประโยคประกาศว่าทำงานเสร็จแล้ว\\" สั้นๆ (ไม่เกิน ~12 คำ) จำนวน 10 ประโยค " +
        "ให้ตรงคาแรกเตอร์นี้เป๊ะๆ หลากหลายแนว ไม่ซ้ำกันเอง ใส่อีโมจิได้เล็กน้อย " +`,
`        "แต่ง \\"ประโยคบอกเพื่อนร่วมทีมว่างานเพิ่งเสร็จ\\" 10 ประโยคสั้นๆ (ไม่เกิน ~12 คำ) " +
        "ให้ฟังเป็นคำพูดคนจริงคุยกันในออฟฟิศ ตรงนิสัยตัวละครนี้เป๊ะๆ " +
        "ห้ามแข็งเป็นหุ่นยนต์ ห้ามสำนวนแปลจากอังกฤษ หลากหลายแนว ไม่ซ้ำกันเอง ใส่อีโมจิได้เล็กน้อย " +`);

// 2. route the existing done-line refill through the cost guard
rep("done refill guard",
`async function refillVoiceBank(agentId) {
  if (voiceRefilling.has(agentId)) return;
  voiceRefilling.add(agentId);
  try {`,
`function refillVoiceBank(agentId) {
  return refillPool("done:" + agentId, () => genDoneLines(agentId));
}
async function genDoneLines(agentId) {
  {`);
rep("done refill guard tail",
`  } catch (e) { console.log("[voice] refill failed (" + agentId + "):", e.message);
  } finally { voiceRefilling.delete(agentId); }
}`,
`  }
}`);

// 3. engine: sanitize on load, refillPool, ambient banks, interaction scenes
rep("voice engine",
`  broadcast({ type: "voice.say", agentId: base, text,
    ...(a.voice ? { voice: a.voice } : {}) }, false);
  broadcast({ type: "agent.done", agentId: base, text }, false);
  return text;
}`,
`  broadcast({ type: "voice.say", agentId: base, text,
    ...(a.voice ? { voice: a.voice } : {}) }, false);
  broadcast({ type: "agent.done", agentId: base, text }, false);
  return text;
}

// 🗨 Dialogue engine v2 (voice-lines.contract.md): ambient lines and
// interaction scenes come from gpt-4o-mini banks too, so every stray line
// sounds like THIS character — and the office cat / corgi / coffee machine get
// talked to in natural Thai instead of floating canned English. Canned Thai
// pools remain the always-works fallback; nothing here ever blocks a tick.

// Single channel to gpt-4o-mini: per-key in-flight guard + 10-min cooldown
// after every attempt, so ticks can never stampede the API.
const REFILL_COOLDOWN_MS = 10 * 60000;
const refillLastTry = {};
async function refillPool(key, fn, force) {
  if (voiceRefilling.has(key)) return false;
  if (!force && Date.now() - (refillLastTry[key] || 0) < REFILL_COOLDOWN_MS) return false;
  voiceRefilling.add(key);
  refillLastTry[key] = Date.now();
  try { await fn(); }
  catch (e) { console.log("[voice] refill failed (" + key + "):", e.message); }
  finally { voiceRefilling.delete(key); }
  return true;
}

// Sanitize on load: drop lines with no Thai script or with U+FFFD (mojibake
// ghosts), and agent keys that aren't in the registry ("@scenes" excepted —
// its sub-keys are checked against participants instead).
(function sanitizeVoiceLines() {
  const okLine = (s) => /[\\u0E00-\\u0E7F]/.test(s) && !/\\uFFFD/.test(s);
  let changed = false;
  const clean = (arr) => {
    const out = (arr || []).filter((s) => typeof s === "string" && okLine(s));
    if (out.length !== (arr || []).length) changed = true;
    return out;
  };
  for (const k of Object.keys(voiceLines)) {
    if (k === "@scenes") {
      const sc = voiceLines[k];
      for (const key of Object.keys(sc)) {
        const ids = String(key.split("::")[1] || "").split("+");
        if (!ids.length || ids.some((id) => !reg.agents[id])) { delete sc[key]; changed = true; continue; }
        const before = (sc[key].bank || []).length;
        sc[key].bank = (sc[key].bank || []).filter((scene) => Array.isArray(scene) &&
          scene.every((l) => l && okLine(String(l.text || ""))));
        sc[key].recent = clean(sc[key].recent);
        if (sc[key].bank.length !== before) changed = true;
      }
      continue;
    }
    if (!reg.agents[k]) { delete voiceLines[k]; changed = true; continue; }
    const v = voiceLines[k];
    v.bank = clean(v.bank);
    v.recent = clean(v.recent);
    if (v.ambient) { v.ambient.bank = clean(v.ambient.bank); v.ambient.recent = clean(v.ambient.recent); }
  }
  if (changed) { saveVoiceLines(); console.log("[voice] sanitized voice-lines.json"); }
})();

// --- ambient lines (per-agent bank; threshold <4 → refill 14, cap 40) ---
const AMBIENT_RECENT_N = 12;
function ambientBankOf(id) {
  const v = voiceBankOf(id);
  return v.ambient || (v.ambient = { bank: [], recent: [] });
}

function refillAmbientBank(agentId) {
  return refillPool("ambient:" + agentId, async () => {
    const a = reg.agents[agentId] || {};
    const px = a.persona || {};
    const txt = await openaiChat([
      { role: "system", content: "คุณแต่งบทพูดสั้นๆ ให้ตัวละครในออฟฟิศเสมือน ตอบเป็น JSON เท่านั้น" },
      { role: "user", content:
        "ตัวละคร: " + (a.name || agentId) + " (ตำแหน่ง " + (a.role || "พนักงาน") + ")\\n" +
        "ตัวตน: " + String(a.prompt || "").slice(0, 600) + "\\n" +
        "นิสัย/โทนเสียง: " + String(px.personality || "").slice(0, 300) + "\\n" +
        "ภาษาหลัก: " + (px.language || "ไทย") + "\\n\\n" +
        "แต่ง \\"คำเปรยยามว่างในออฟฟิศ\\" 14 ประโยคสั้นๆ (ไม่เกิน ~12 คำ) " +
        "ให้ฟังเป็นคำพูดคนจริง ตรงนิสัยตัวละครนี้ ห้ามแข็งเป็นหุ่นยนต์ ห้ามสำนวนแปลจากอังกฤษ " +
        "คละแนวให้ครบ: เปรยกับตัวเอง, บ่น/ชมงานเบาๆ, ชวนคนรอบตัวคุยลอยๆ, " +
        "พูดถึงบรรยากาศออฟฟิศ ใส่อีโมจิได้เล็กน้อย " +
        'ตอบ JSON: {"lines":["...", "..."]}' },
    ], { json: true, maxTokens: 800, timeoutMs: 30000 });
    const lines = (JSON.parse(txt).lines || [])
      .map((s) => String(s).trim().slice(0, 140))
      .filter((s) => s && /[\\u0E00-\\u0E7F]/.test(s));
    if (lines.length) {
      const v = ambientBankOf(agentId);
      v.bank = [...new Set([...v.bank, ...lines])].slice(-40);
      saveVoiceLines();
      console.log("[voice] ambient bank refilled: " + agentId + " +" + lines.length);
    }
  });
}

function pickAmbientLine(agentId) {
  const v = ambientBankOf(agentId);
  const fresh = v.bank.filter((s) => !v.recent.includes(s));
  if (!v.bank.length || fresh.length < 4) refillAmbientBank(agentId);
  const base = fresh.length ? fresh : (v.bank.length ? v.bank : AMBIENT_FALLBACK);
  const last = v.recent[v.recent.length - 1];
  const pool = base.filter((s) => s !== last);
  const text = (pool.length ? pool : base)[Math.floor(Math.random() * (pool.length ? pool.length : base.length))];
  if (v.bank.includes(text)) {
    v.recent = [...v.recent.filter((s) => s !== text), text].slice(-AMBIENT_RECENT_N);
    saveVoiceLines();
  }
  return text;
}

// --- interaction scenes (context + real participants → cached dialogue) ---
const INTERACT_CONTEXTS = [
  { id: "cat",        kind: "solo", label: "แมวส้ม 🐱",       desc: "เจ้าแมวส้มประจำออฟฟิศเดินมาคลอเคลียหรือนอนขวางคีย์บอร์ด ตัวละครพูดกับมัน" },
  { id: "dog",        kind: "solo", label: "หมาคอร์กี้ 🐶",    desc: "เจ้าคอร์กี้ประจำออฟฟิศวิ่งมาหา หางสั่น คาบของเล่นมาด้วย ตัวละครพูดกับมัน" },
  { id: "coffee",     kind: "solo", label: "เครื่องชงกาแฟ ☕", desc: "ตัวละครยืนรอเครื่องชงกาแฟทำงาน แล้วพูดกับเครื่องหรือแก้วกาแฟของตัวเอง" },
  { id: "plant",      kind: "solo", label: "ต้นไม้ 🌱",        desc: "ตัวละครรดน้ำหรือดูต้นไม้ในออฟฟิศ แล้วพูดกับต้นไม้" },
  { id: "canteen",    kind: "pair", label: "แคนทีน 🍜",       desc: "สองคนเจอกันที่แคนทีน คุยเรื่องของกินเมนูวันนี้ แซวกันเรื่องกาแฟหรือขนม" },
  { id: "sofa",       kind: "pair", label: "โซฟา 🛋️",         desc: "สองคนนั่งพักที่โซฟา คุยเล่นเรื่องงานช่วงนี้หรือเรื่องฮาๆ ในออฟฟิศ" },
  { id: "garden",     kind: "pair", label: "สวน 🌿",          desc: "สองคนเดินเล่นในสวนของออฟฟิศ คุยชิลๆ เรื่องบรรยากาศหรือไอเดียใหม่ๆ" },
  { id: "whiteboard", kind: "pair", label: "ไวท์บอร์ด 📝",    desc: "สองคนยืนหน้าไวท์บอร์ด ถกไอเดียแผนงานแบบกันเอง หยอกกันได้" },
];
const SOLO_FALLBACK = {
  cat: ["เจ้าส้มมม มานอนขวางคีย์บอร์ดอีกแล้วนะ 🐱", "แมวส้มวันนี้ขี้อ้อนเป็นพิเศษนะเรา"],
  dog: ["คอร์กี้ขาสั้น วิ่งมาทำไมน่ารักขนาดนี้ 🐶", "เอาของเล่นมาให้อีกแล้วเหรอเจ้าหนู"],
  coffee: ["เครื่องชงวันนี้อย่างอน เร็วหน่อยนะ ☕", "กลิ่นกาแฟแบบนี้ งานเดินแน่นอน"],
  plant: ["โตไวๆ นะเจ้าต้นเขียว 🌱", "แตกใบใหม่อีกแล้ว เก่งมากเลย"],
};

function scenesRoot() { return voiceLines["@scenes"] || (voiceLines["@scenes"] = {}); }
function sceneKey(ctx, ids) { return ctx.id + "::" + [...ids].sort().join("+"); }
function sceneBankOf(key) { const r = scenesRoot(); return r[key] || (r[key] = { bank: [], recent: [] }); }

async function genScenes(ctx, ids) {
  const who = ids.map((id) => {
    const a = reg.agents[id] || {};
    const px = a.persona || {};
    return "- id: " + id + " | ชื่อ: " + (a.name || id) + " | ตำแหน่ง: " + (a.role || "พนักงาน") +
      "\\n  ตัวตน: " + String(a.prompt || "").slice(0, 400) +
      "\\n  นิสัย/โทน: " + String(px.personality || "").slice(0, 200) +
      " | ภาษา: " + (px.language || "ไทย");
  }).join("\\n");
  const shape = ctx.kind === "pair" ? "ฉากละ 3-4 ประโยคโต้ตอบกันสลับคน" : "ฉากละ 1-2 ประโยค (คนเดียวพูด)";
  const txt = await openaiChat([
    { role: "system", content: "คุณเขียนบทพูดสั้นๆ ให้ตัวละครในออฟฟิศเสมือน ตอบเป็น JSON เท่านั้น" },
    { role: "user", content:
      "สถานการณ์: " + ctx.desc + "\\nผู้ร่วมฉาก:\\n" + who + "\\n\\n" +
      "เขียนบทพูด 3 ฉาก " + shape + " ให้เป็นคำพูดภาษาไทยที่คนพูดกันจริงๆ " +
      "ตรงนิสัยแต่ละตัวละคร ห้ามแข็งเป็นหุ่นยนต์ ห้ามสำนวนแปล ใส่อีโมจิได้เล็กน้อย " +
      'ตอบ JSON: {"scenes":[[{"who":"<id>","text":"..."}, ...], ...]} โดย who ต้องเป็น id ที่ให้ไว้เท่านั้น' },
  ], { json: true, maxTokens: 900, timeoutMs: 30000 });
  return (JSON.parse(txt).scenes || [])
    .filter((sc) => Array.isArray(sc) && sc.length >= 1 && sc.length <= 5 &&
      sc.every((l) => l && ids.includes(String(l.who)) && /[\\u0E00-\\u0E7F]/.test(String(l.text || ""))))
    .map((sc) => sc.map((l) => ({ who: String(l.who), text: String(l.text).trim().slice(0, 160) })));
}

function refillScenes(ctx, ids, force) {
  const key = sceneKey(ctx, ids);
  return refillPool("scene:" + key, async () => {
    const scenes = await genScenes(ctx, ids);
    if (scenes.length) {
      const v = sceneBankOf(key);
      const seen = new Set(v.bank.map((sc) => sc[0] && sc[0].text));
      for (const sc of scenes) if (!seen.has(sc[0].text)) v.bank.push(sc);
      v.bank = v.bank.slice(-12);
      saveVoiceLines();
      console.log("[voice] scenes refilled: " + key + " +" + scenes.length);
    }
  }, force);
}

function pickScene(ctx, ids) {
  const v = sceneBankOf(sceneKey(ctx, ids));
  const fresh = v.bank.filter((sc) => !v.recent.includes(sc[0].text));
  if (!v.bank.length || fresh.length < 2) refillScenes(ctx, ids);
  const pool = fresh.length ? fresh : v.bank;
  if (!pool.length) return null;
  const sc = pool[Math.floor(Math.random() * pool.length)];
  v.recent = [...v.recent.filter((s) => s !== sc[0].text), sc[0].text].slice(-6);
  saveVoiceLines();
  return sc;
}

function playPairSceneIn(ctx, pick, now) {
  if (!ctx) {
    const cs = INTERACT_CONTEXTS.filter((c) => c.kind === "pair");
    ctx = cs[Math.floor(Math.random() * cs.length)];
  }
  const sc = pickScene(ctx, pick);
  let lines, source;
  if (sc) { lines = sc; source = "cache"; }
  else {
    // canned BANTER template — zero tokens, always available.
    const nameOf = (id) => (reg.agents[id] || { name: id }).name;
    lines = BANTER[Math.floor(Math.random() * BANTER.length)].map((tpl) => ({
      who: tpl.startsWith("{a}") ? pick[0] : pick[1],
      text: tpl.replace(/\\{a\\}:\\s*/, "").replace(/\\{b\\}:\\s*/, "")
        .replace(/\\{a\\}/g, nameOf(pick[0])).replace(/\\{b\\}/g, nameOf(pick[1])) }));
    source = "fallback";
  }
  const task = "soc" + ((now || Date.now()) % 100000);
  broadcast({ type: "collab.started", agents: pick, task, text: ctx.label });
  lines.forEach((l, i) =>
    setTimeout(() => broadcast({ type: "chat.message", agent: l.who, task, text: l.text, social: true }), 2500 + i * 3600));
  setTimeout(() => broadcast({ type: "collab.ended", agents: pick, task }),
    2500 + lines.length * 3600 + 2500);
  return { ctx: ctx.id, agents: pick, lines, source };
}

function playSoloSceneIn(ctx, id) {
  if (!ctx) {
    const cs = INTERACT_CONTEXTS.filter((c) => c.kind === "solo");
    ctx = cs[Math.floor(Math.random() * cs.length)];
  }
  const sc = pickScene(ctx, [id]);
  const fb = SOLO_FALLBACK[ctx.id] || AMBIENT_FALLBACK;
  const lines = sc || [{ who: id, text: fb[Math.floor(Math.random() * fb.length)] }];
  lines.forEach((l, i) =>
    setTimeout(() => broadcast({ type: "chat.message", agent: l.who, text: l.text, social: true, ambient: true }), i * 3200));
  const a = reg.agents[id] || {};
  if (a.voice && featuresMap().tts && reg.tts !== false && Math.random() < 0.6)
    broadcast({ type: "voice.say", agent: id, text: lines[0].text });
  return { ctx: ctx.id, agents: [id], lines, source: sc ? "cache" : "fallback" };
}`);

// 4. ambientTick → per-agent bank, ~1/3 of beats become a solo scene
rep("ambientTick hook",
`  const id = pool[Math.floor(Math.random() * pool.length)];
  const lines = MOOD_LINES[reg.lang === "th" ? "th" : "en"];
  const text = lines[Math.floor(Math.random() * lines.length)];
  broadcast({ type: "chat.message", agent: id, text, social: true, ambient: true });`,
`  const id = pool[Math.floor(Math.random() * pool.length)];
  // ~1 in 3 ambient beats becomes a solo interaction scene (cat, corgi,
  // coffee machine, plant); otherwise an in-character line from the agent's
  // own bank — canned Thai pool only while the bank warms up.
  if (Math.random() < 1 / 3) return playSoloSceneIn(null, id);
  const text = pickAmbientLine(id);
  broadcast({ type: "chat.message", agent: id, text, social: true, ambient: true });`);

// 5. socialTick canned branch → cached pair scene (BANTER stays as fallback)
rep("socialTick hook",
`    // canned banter — zero tokens, pure life.
    const lines = BANTER[Math.floor(Math.random() * BANTER.length)];
    const nameOf = (id) => (reg.agents[id] || { name: id }).name;
    const task = "soc" + (now % 100000);
    broadcast({ type: "collab.started", agents: pick, task, text: "พักเบรก ☕" });
    lines.forEach((tpl, i) => {
      const who = tpl.startsWith("{a}") ? pick[0] : pick[1];
      const text = tpl.replace(/\\{a\\}:\\s*/, "").replace(/\\{b\\}:\\s*/, "")
        .replace(/\\{a\\}/g, nameOf(pick[0])).replace(/\\{b\\}/g, nameOf(pick[1]));
      setTimeout(() => broadcast({ type: "chat.message", agent: who, task, text, social: true }), 2500 + i * 3600);
    });
    setTimeout(() => broadcast({ type: "collab.ended", agents: pick, task }),
      2500 + lines.length * 3600 + 2500);
  } else {`,
`    // interaction scene — cached gpt-4o-mini dialogue when stocked; the
    // canned BANTER template inside playPairSceneIn is the free fallback.
    playPairSceneIn(null, pick, now);
  } else {`);

// 6. floating-English ambient pool → Thai-only AMBIENT_FALLBACK
rep("AMBIENT_FALLBACK",
`const MOOD_LINES = {
  th: ["วันนี้อยากทำงานจัง 💪", "ขอกาแฟแก้วนึงงง ☕", "เงียบดีนะวันนี้ 🌿", "มีใครอยากได้ idea เด็ดๆ ไหม 💡",
    "ออฟฟิศเราน่าอยู่จริงๆ นะ ✨", "พักสายตาแป๊บ 👀", "เจ้าเหมียวน่ารักอีกแล้ว 🐱", "วันนี้ productive สุดๆ 🚀",
    "ใครว่างมาคุยเล่นกันมั้ย 💬", "อยากลองทำอะไรใหม่ๆ ดูบ้าง 🎨", "หิวแล้วแฮะ 🍜", "เพลงนี้เพราะจัง 🎵",
    "งานวันนี้ลื่นไหลดี 😎", "ขอยืดเส้นยืดสายหน่อย 🤸", "เดี๋ยวพักแล้วลุยต่อ 🔥", "อากาศดีน่านอน 😴",
    "เก่งขึ้นทุกวันเลยเรา 🌟", "ใครเห็นปากกาเรามั้ย ✏️"],
  en: ["Feeling productive today 💪", "Could really go for a coffee ☕", "Nice and quiet today 🌿",
    "Anyone got a cool idea? 💡", "Love this office ✨", "Quick eye break 👀", "Cat's adorable again 🐱",
    "On a roll today 🚀", "Anyone free to chat? 💬", "Itching to build something new 🎨", "Kinda hungry now 🍜",
    "This track slaps 🎵", "Work's flowing today 😎", "Need a quick stretch 🤸", "Break then back at it 🔥",
    "Comfy weather today 😴", "Getting better every day 🌟", "Anyone seen my pen? ✏️"],
};`,
`// CEO spec "ห้ามเหลืออังกฤษลอย": per-agent banks carry each character's own
// language; this canned fallback pool is always natural Thai.
const AMBIENT_FALLBACK = ["วันนี้อยากทำงานจัง 💪", "ขอกาแฟแก้วนึงงง ☕", "เงียบดีนะวันนี้ 🌿",
  "มีใครอยากได้ไอเดียเด็ดๆ ไหม 💡", "ออฟฟิศเราน่าอยู่จริงๆ นะ ✨", "พักสายตาแป๊บ 👀",
  "เจ้าเหมียวน่ารักอีกแล้ว 🐱", "วันนี้งานลื่นสุดๆ 🚀", "ใครว่างมาคุยเล่นกันมั้ย 💬",
  "อยากลองทำอะไรใหม่ๆ ดูบ้าง 🎨", "หิวแล้วแฮะ 🍜", "เพลงนี้เพราะจัง 🎵",
  "งานวันนี้ลื่นไหลดี 😎", "ขอยืดเส้นยืดสายหน่อย 🤸", "เดี๋ยวพักแล้วลุยต่อ 🔥",
  "อากาศดีน่านอน 😴", "เก่งขึ้นทุกวันเลยเรา 🌟", "ใครเห็นปากกาเรามั้ย ✏️"];`);

// 7. GET /voice/lines → + ambient bank + per-agent scenes summary
rep("GET /voice/lines",
`    const v = voiceLines[a] || { bank: [], recent: [] };
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ bank: v.bank, recent: v.recent }));`,
`    const v = voiceLines[a] || { bank: [], recent: [] };
    const ambient = v.ambient || { bank: [], recent: [] };
    const scenes = {};
    const sc = voiceLines["@scenes"] || {};
    for (const key of Object.keys(sc)) {
      const ids = String(key.split("::")[1] || "").split("+");
      if (!a || ids.includes(a)) scenes[key] = { bank: (sc[key].bank || []).length,
        recent: (sc[key].recent || []).length };
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ bank: v.bank, recent: v.recent,
      ambient: { bank: ambient.bank, recent: ambient.recent }, scenes }));`);

// 8. endpoints /voice/ambient + /voice/interact (contract §5)
rep("voice endpoints",
`        const text = voiceAnnounce(base, true);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ text }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.url === "/health") {`,
`        const text = voiceAnnounce(base, true);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ text }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/voice/ambient") {
    // Force one ambient line (e2e hook) — same pick/fallback path as
    // ambientTick. agentId optional: omitted → a random non-CEO agent.
    readBody(req, (body) => {
      try {
        const b = JSON.parse(body || "{}");
        let base = String(b.agentId || "").split("#")[0];
        if (base && !reg.agents[base]) { res.writeHead(404); return res.end("unknown agent"); }
        if (!base) {
          const pool = Object.keys(reg.agents).filter((id) => id !== "ceo");
          if (!pool.length) { res.writeHead(400); return res.end("no agents"); }
          base = pool[Math.floor(Math.random() * pool.length)];
        }
        const text = pickAmbientLine(base);
        broadcast({ type: "chat.message", agent: base, text, social: true, ambient: true });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ agentId: base, text }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/voice/interact") {
    // Force an interaction scene (e2e hook) — broadcasts the real flow and
    // reports where the dialogue came from. Unlike the ticks, a forced play
    // may await ONE refill so a repeat call hits the cache deterministically.
    readBody(req, async (body) => {
      try {
        const b = JSON.parse(body || "{}");
        const pool = Object.keys(reg.agents).filter((id) => id !== "ceo");
        let ids = (Array.isArray(b.agents) ? b.agents : []).map((s) => String(s).split("#")[0]);
        if (ids.some((id) => !reg.agents[id])) { res.writeHead(404); return res.end("unknown agent"); }
        let ctx = INTERACT_CONTEXTS.find((c) => c.id === b.ctx) || null;
        if (!ctx) {
          const kind = ids.length >= 2 ? "pair" : (ids.length === 1 ? "solo"
            : (Math.random() < 0.5 ? "pair" : "solo"));
          const cs = INTERACT_CONTEXTS.filter((c) => c.kind === kind);
          ctx = cs[Math.floor(Math.random() * cs.length)];
        }
        const need = ctx.kind === "pair" ? 2 : 1;
        while (ids.length < need) {
          const left = pool.filter((id) => !ids.includes(id));
          if (!left.length) { res.writeHead(400); return res.end("not enough agents"); }
          ids.push(left[Math.floor(Math.random() * left.length)]);
        }
        ids = ids.slice(0, need);
        if (!sceneBankOf(sceneKey(ctx, ids)).bank.length) await refillScenes(ctx, ids, true);
        const r = ctx.kind === "pair" ? playPairSceneIn(ctx, ids, Date.now())
          : playSoloSceneIn(ctx, ids[0]);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.url === "/health") {`);

if (crlf) src = src.replace(/\n/g, "\r\n");
fs.writeFileSync(target, src);
console.log("applied " + applied + "/9 hunks → " + target);
