// BagIdea Office — daemon v3 (Layer 0).
// Zero-dependency event hub + Claude Code adapter + permission broker:
//   HTTP :8787  GET  /              → Layer-2 overlay (chat panel web app)
//   WS   :8787  GET  /ws (upgrade)  → event stream for renderers + overlays
//                                      (new clients get a journal replay first)
//               POST /chat          → spawn a real Claude Code session
//               POST /event         → adapters push events (hooks, tests)
//               POST /perm/request  → PreToolUse hook long-polls for a decision
//               POST /perm/respond  → overlay/user answers {id, decision}
//               GET  /health
//
// Every event is journaled to journal.jsonl — restarted clients replay the
// tail to rebuild their state.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
// 🐛 spawn("claude", args, {shell:true}) concatenates argv WITHOUT escaping
// (Node DEP0190). This machine's paths live under "C:\Users\WINDOWS 11\…", so any
// arg carrying a space (--mcp-config/--settings/--add-dir) gets split by cmd.exe:
// --mcp-config dies outright ("Invalid MCP configuration"), --settings/--add-dir
// degrade silently ("C:\Users\WINDOWS is not a directory"). Quote spaced tokens so
// the shell keeps them whole. Values never carry embedded quotes (Windows paths),
// and double-quoting is also honored by /bin/sh, so this is safe cross-platform.
const shArg = (a) => {
  const s = String(a);
  return /\s/.test(s) && !/^".*"$/.test(s) ? `"${s}"` : s;
};
const brain = require("./brain");   // Project Brain engine (docs/project-brain.contract.md)
// BM25 memory recall (upstream v0.7.0 "Hermes way") — fail-soft like db.js:
// a missing module just leaves retrievalOk=false and every consumer falls back.
let retrieval = null;
try { retrieval = require("./retrieval"); } catch (e) { console.error("[retrieval] module unavailable:", e && e.message); }
// Postgres durability layer (daemon/db.js) — fail-soft by design: every helper
// swallows DB trouble and returns null/[]; the office must never stall on it.
let db = null;
try { db = require("./db"); } catch (e) { console.error("[db] module unavailable:", e && e.message); }
// 🔒 Factory lock policy (pure, no deps) — protected-agent / model-lock /
// fresh-install reconcile all decided in one place so server.js and the e2e
// share the exact same logic. See daemon/lock.js.
const lock = require("./lock");

const {
  REPLAY_COUNT,
  MAX_STAFF,
  BUILTIN_TOOLS,
  SKILL_LIBRARY,
  DEFAULT_MAIN_AGENT,
  DEFAULT_CEO_AGENT
} = require("./constants");
const maintenance = require("./maintenance");
const skillsSync = require("./skills");
const osutil = require("./osutil");
// 🐕 WatchDog: pure evaluator (STEP 1) + runtime loop/auto-wake (STEP 2).
// watchdogMod ตั้งชื่อเลี่ยง local var `watchdog` (timer) ในหลายฟังก์ชันด้านล่าง.
const watchdogMod = require("./watchdog");
const watchdogRuntime = require("./watchdog-runtime");

const WORKSPACE = path.join(__dirname, "..", "workspace");
// Server-local paths (the refactor moved REPLAY_COUNT to constants.js but these
// two are used right here — broadcast() journals to JOURNAL, GET / serves OVERLAY).
const OVERLAY = path.join(__dirname, "overlay.html");
const JOURNAL = path.join(__dirname, "journal.jsonl");

const wsClients = new Set();
const pendingPerms = new Map(); // id -> {res, timer, agent, tool}
let taskCounter = 0;

// ---------------------------------------------------------------- registry
// Persistent staff roster + roles (skills/tools libraries ride along).
// main = Claude, the undeletable Director; ceo = the human owner's avatar.

const REGISTRY = path.join(__dirname, "registry.json");
let reg;

// Starter skill library — the capability pack every office ships with, in the
// spirit of the curated skills other agent stacks bundle. Each entry is plain
// instruction content injected into an assigned agent's persona. They're
// seeded into reg.skills as `builtin` (refreshed on update, never clobbering a
// user's own skills) and assignable from the editor. Auto-learned skills
// (maybeLearnSkill) grow the library further while the office runs.
function loadReg() {
  try { reg = JSON.parse(fs.readFileSync(REGISTRY, "utf8")); } catch { reg = {}; }
  reg.agents = reg.agents || {};
  reg.apiKeys = reg.apiKeys || {};      // ENV_NAME → value (injected into runs)
  reg.channels = reg.channels || {};    // telegram/discord/line connector config
  // MAIN keys power program features (voice, TTS, image…). Canonical names —
  // migrate the short forms users typed before this distinction existed.
  if (reg.apiKeys.OPENAI && !reg.apiKeys.OPENAI_API_KEY) {
    reg.apiKeys.OPENAI_API_KEY = reg.apiKeys.OPENAI;
    delete reg.apiKeys.OPENAI;
  }
  if (reg.apiKeys.GEMINI && !reg.apiKeys.GEMINI_API_KEY) {
    reg.apiKeys.GEMINI_API_KEY = reg.apiKeys.GEMINI;
    delete reg.apiKeys.GEMINI;
  }
  reg.roles = reg.roles || ["ผู้อำนวยการ", "ผู้ก่อตั้ง", "นักวิจัย", "วิศวกร",
    "นักออกแบบ", "นักวิเคราะห์", "ฝ่ายปฏิบัติการ", "ผู้เชี่ยวชาญ"];
  reg.skills = reg.skills || {};
  // Seed / refresh the builtin starter library. We own entries flagged
  // `builtin` (so updates propagate new wording), but never touch a user's
  // own skills or auto-learned ones.
  for (const [id, sk] of Object.entries(SKILL_LIBRARY)) {
    const cur = reg.skills[id];
    if (!cur || cur.builtin) reg.skills[id] = { ...sk, builtin: true };
  }
  reg.tools = Object.keys(BUILTIN_TOOLS);
  reg.mcpServers = reg.mcpServers || {};
  reg.places = reg.places || {};  // shorthand locations: "ห้องสมุด" → folder
  // Default main agent: SHINO — the owner's (CEO's) second-in-command who runs
  // the floor. A manager, not an individual contributor: few hands-on tools,
  // delegation as his craft. Playful but serious about the work.
  if (!reg.agents.main) reg.agents.main = DEFAULT_MAIN_AGENT;
  if (!reg.agents.ceo) reg.agents.ceo = DEFAULT_CEO_AGENT;
  // Factory team roster: the built characters this office ships with (มิสเตอร์ N,
  // น้องไวท์, แบล็ค, มูท). registry.json is gitignored, so a clean git-clone has
  // only main/ceo above — seed the rest from the tracked registry.default.json so
  // every shipped Agent shows up as a Hub icon on a fresh install. Fail-open if
  // the seed file is absent.
  // 🔒 Reconcile factory locks (lock.js): seed MISSING agents in full, and on
  // EXISTING ones force the factory-owned fields (protected / modelLock / iconText)
  // from the seed — additively, never clobbering an owner's other edits. The old
  // loop only seeded missing agents, so a roster created before `protected`/
  // `modelLock` existed stayed unlocked forever; this makes the lock self-healing
  // on every boot (fresh install AND upgrade). Idempotent.
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "registry.default.json"), "utf8"));
    const changed = lock.reconcileFactoryLocks(reg.agents, (seed && seed.agents) || {});
    if (changed.length) console.log("[reg] factory-lock reconcile:\n  " + changed.join("\n  "));
  } catch (e) { if (e && e.code !== "ENOENT") console.warn("[reg] registry.default.json:", e.message); }
  // Default office rhythms for a fresh install (owner can change in settings).
  if (reg.heartbeatMin === undefined) reg.heartbeatMin = 60; // Director check-in
  if (reg.socialMin === undefined) reg.socialMin = 60;       // agents socialize
  if (reg.proposalMin === undefined) reg.proposalMin = 120;  // min gap between CEO pitches
  saveReg();
}
function saveReg() { fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2)); }
loadReg();

// Live (not journaled): registry.json is the persistence; every WS client
// also gets a fresh snapshot on connect.
// Hire cap: the office floor is small and sub-agents (👻 ghosts) handle
// parallel load — keep the staff to MAX_STAFF (CEO not counted). Shared by the
// hire endpoint and the roster sync (so the UI can show "N/MAX").
function staffCount() {
  return Object.keys(reg.agents).filter((k) => k !== "ceo").length;
}

// ---- Workflow Builder (human-language nodes the Director analyzes) ----------
// Nodes form a graph via edges (A → B = do B after A). A node with several
// outgoing edges = parallel branches; several incoming = wait for all, then
// continue. Falls back to top→bottom by Y when no edges are drawn.
function workflowToText(w) {
  const nodes = w.nodes || [];
  const edges = w.edges || [];
  const byId = {}; for (const n of nodes) byId[n.id] = n;
  const label = (id) => { const n = byId[id]; return n ? `[${n.type || "step"}] ${(n.text || "").trim()}` : id; };
  let s = `Workflow: ${w.name || "(untitled)"}\n\nSteps:\n`;
  nodes.slice().sort((a, b) => (a.y || 0) - (b.y || 0))
    .forEach((n, i) => { s += `(${i + 1}) ${label(n.id)}\n`; });
  if (edges.length) {
    s += "\nFlow (A → B = do B after A; a node with several outgoing arrows runs those " +
      "branches in PARALLEL; a node with several incoming arrows WAITS for all of them " +
      "before continuing):\n";
    for (const e of edges) s += `- ${label(e.from)}  →  ${label(e.to)}\n`;
  } else {
    s += "\n(No connections drawn — treat the steps in order, top to bottom.)\n";
  }
  return s;
}
const WORKFLOW_ANALYZE_PROMPT = [
  "ผู้ใช้วาง workflow เป็นภาษามนุษย์ (ลำดับ node) ด้านล่าง. ในฐานะ Director ให้วิเคราะห์",
  "ว่าจะทำให้เกิดจริงได้ยังไง — อย่าลงมือทำตอนนี้ แค่วางแผน. ตอบเป็นหัวข้อ กระชับ",
  "อ่านง่าย ภาษาเดียวกับผู้ใช้:",
  "1) สรุป 1-2 บรรทัดว่า workflow นี้ทำอะไร",
  "2) แต่ละขั้นต้องใช้ skill/tool ไหน (เช่น WebSearch, Bash, Write) — ถ้ายังไม่มี skill ที่เหมาะ บอกว่าควรสร้าง skill ชื่ออะไร ทำอะไร",
  "3) ต้องเปิด permission/tool อะไรเพิ่มให้ agent ไหม",
  "4) ควรมอบหมายให้ agent คนไหน หรือควรจ้าง agent ใหม่ (หน้าที่อะไร)",
  "5) คำถาม/ช่องโหว่ที่ผู้ใช้ต้องตัดสินใจก่อนรันจริง",
].join("\n");

// Which program features the MAIN keys currently unlock — booleans only,
// never the keys themselves. Rides on roster.sync so the UI gates live.
function featuresMap() {
  const k = reg.apiKeys || {};
  const oa = !!k.OPENAI_API_KEY, gm = !!k.GEMINI_API_KEY;
  return { openai: oa, gemini: gm,
    stt: oa || gm, tts: gm, live: gm, image: oa || gm };
}

// How many physical monitors the shell detected at attach time (it writes the
// count to daemon/monitors.txt). The UI shows a display picker only when >1, and
// lists exactly this many — no more guessing "3" when there's one screen.
function monitorCount() {
  try {
    const n = parseInt(fs.readFileSync(path.join(__dirname, "monitors.txt"), "utf8").trim(), 10);
    return n >= 1 ? n : 1;
  } catch { return 1; }
}

function rosterEvt() {
  return { type: "roster.sync", agents: reg.agents, roles: reg.roles,
    tools: reg.tools, builtinTools: BUILTIN_TOOLS, mcp: reg.mcpServers,
    skills: reg.skills, autoSkills: reg.autoSkills !== false,
    sound: reg.sound !== false, heartbeatMin: Number(reg.heartbeatMin || 0),
    features: featuresMap(), tts: reg.tts !== false,
    socialMin: Number(reg.socialMin !== undefined ? reg.socialMin : 60),
    proposalMin: Number(reg.proposalMin !== undefined ? reg.proposalMin : 120),
    maxStaff: MAX_STAFF, staffCount: staffCount(),
    // OURS stays Thai-first (deliberate fork default); take upstream's multi-monitor count.
    lang: reg.lang || "th", daylight: reg.daylight ?? "auto",
    monitor: reg.monitor || 0, monitors: monitorCount() };
}

// Relaunch the whole stack (shell → daemon → godot) detached, so it survives
// killAll killing THIS daemon. Used after a monitor change so the wallpaper
// re-attaches to the chosen screen without the user typing `bagidea restart`.
function triggerRestart() {
  try {
    const { spawn } = require("child_process");
    const cli = path.join(__dirname, "..", "cli", "bagidea.js");
    const root = path.join(__dirname, "..");
    if (process.platform === "win32") {
      // Launch through `start` so the restarter is ORPHANED from this daemon's
      // process tree. The restarter runs `bagidea restart`, whose killAll does
      // `taskkill /T` on the daemon — and /T kills the daemon's whole child tree.
      // A plain detached spawn is still our child (PPID), so it would be killed
      // mid-flight before it could relaunch. `start` re-parents it away.
      spawn("cmd", ["/c", "start", "", "/min", process.execPath, cli, "restart"],
        { detached: true, stdio: "ignore", windowsHide: true, cwd: root }).unref();
    } else {
      spawn(process.execPath, [cli, "restart"],
        { detached: true, stdio: "ignore", cwd: root }).unref();
    }
  } catch (e) { console.error("[restart]", e.message); }
}

// Structured persona → one compiled system prompt (editor v2 fields).
function personaText(a) {
  let p = a.prompt || "";
  const px = a.persona || {};
  if (px.expertise) p += `\n\nความเชี่ยวชาญ/ขอบเขตงาน:\n${px.expertise}`;
  if (px.personality) p += `\n\nบุคลิกและน้ำเสียง:\n${px.personality}`;
  if (px.language) p += `\n\nภาษาหลักที่ใช้ตอบ: ${px.language}`;
  if (px.rules) p += `\n\nกฎการทำงาน (ต้องเคารพเสมอ):\n${px.rules}`;
  return p;
}
function pushRoster() { broadcast(rosterEvt(), false); }

function slugId(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9ก-๙]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 24);
  return s || "agent" + Date.now() % 10000;
}

// Hermes-style auto-skills: after a real multi-tool task, a quick
// reflection call decides whether the work distills into a reusable skill.
// New skills land in the registry, auto-assigned to the agent that earned
// them, and the office hears about it (skill.created).
let learnSkillTick = 0;
async function maybeLearnSkill(agent, task, prompt, acts, finalText, projId) {
  if (reg.autoSkills === false || acts.length < 3) return;
  // 💸 Throttle: reflect on ~1 in 3 eligible tasks. The reflection is a whole
  // extra Claude call per task; most yield null/null anyway, so sampling keeps
  // the learning without paying on every single completion.
  if ((++learnSkillTick % 3) !== 0) return;
  const existing = Object.values(reg.skills).map((s) => s.name).join(", ") || "(none)";
  // ONE reflection call distills both: a reusable skill AND durable memory
  // facts (Hermes-style growth without doubling the token bill).
  const out = await claudeText(
    `An AI office agent "${agent}" just completed a task.\n` +
    `Task prompt: ${String(prompt).slice(0, 600)}\n` +
    `Tools used in order: ${acts.join(" -> ")}\n` +
    `Final report: ${String(finalText).slice(0, 800)}\n\n` +
    `Existing skills: ${existing}\n\n` +
    `Two reflections, output STRICT JSON only:\n` +
    `{"skill": {"name":"short-kebab-name","description":"one line",` +
    `"content":"imperative step-by-step instructions, max 12 lines"} | null,\n` +
    ` "memory": ["short durable fact about the OWNER/preferences ` +
    `worth remembering across conversations (Thai)", ...max 2] | null,\n` +
    (projId ? ` "projectMemory": ["short durable fact specific to THIS project ` +
      `worth remembering (Thai)", ...max 2] | null}\n` : ` "projectMemory": null}\n`) +
    `skill = null unless this contains a REUSABLE, GENERALIZABLE procedure ` +
    `not covered by an existing skill. memory/projectMemory = null unless ` +
    `genuinely worth remembering forever. Be strict; most tasks yield nulls.`);
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return;
  try {
    const j = JSON.parse(m[0]);
    if (Array.isArray(j.memory)) memAppend(agent, j.memory.slice(0, 2));
    if (projId && Array.isArray(j.projectMemory)) projMemAppend(projId, j.projectMemory.slice(0, 2));
    const sk = j.skill;
    if (!sk || !sk.name || !sk.content) return;
    const id = slugId(sk.name);
    if (reg.skills[id]) return;
    reg.skills[id] = {
      name: String(sk.name).slice(0, 60),
      description: String(sk.description || "").slice(0, 200),
      content: String(sk.content).slice(0, 4000),
      auto: true, by: agent,
    };
    const a = reg.agents[agent];
    if (a && !a.skills.includes(id)) a.skills.push(id);
    if (retrievalOk) try { retrieval.reindexSkill(id, reg.skills[id]); retrieval.persist(); } catch {}
    saveReg();
    pushRoster();
    if (retrievalOk) try { retrieval.reindexSkill(id, reg.skills[id]); retrieval.persist(); } catch {}
    try { if (reg.nativeSkills !== false) skillsSync.syncAgent(AGENTS_DIR, agent, (reg.agents[agent] || {}).skills || [], reg.skills); } catch {}
    broadcast({ type: "skill.created", agent, task, skill: reg.skills[id].name });
  } catch {}
}

// ---------------------------------------------------------------- sessions
// Named chat sessions per agent. Default behavior: every /chat continues
// the agent's latest session (continuous memory); "new" starts a thread;
// an explicit key resumes that thread and makes it the latest again.

const SESSIONS = path.join(__dirname, "sessions.json");
let sess = {};
try { sess = JSON.parse(fs.readFileSync(SESSIONS, "utf8")); } catch {}
function saveSess() { fs.writeFileSync(SESSIONS, JSON.stringify(sess, null, 2)); }

// One-time boot housekeeping (P0): keep journal + sessions from growing forever
// on long-running offices. Both fail-open — any error leaves today's state intact.
try {
  const r = maintenance.rotateJournal(JOURNAL);
  if (r.rotated) console.log(`[maint] journal trimmed ${r.before} -> ${r.kept} lines`);
} catch (e) { console.error("[maint] journal:", e.message); }
try {
  const p = maintenance.pruneSessions(sess);
  if (p.changed) { sess = p.sess; saveSess(); console.log(`[maint] pruned ${p.dropped} stale session thread(s)`); }
} catch (e) { console.error("[maint] sessions:", e.message); }
function latestSession(agent) {
  const l = sess[agent] || [];
  return l.length ? l.reduce((a, b) => (a.ts > b.ts ? a : b)) : null;
}
// Boot recovery: a thread compacted right before a restart has sid=null and
// its carryover may never have been consumed or written to sessions.json.
// Pull the last Postgres snapshot back in (async, fail-soft — no DB, no harm).
(async () => {
  if (!db) return;
  for (const agent of Object.keys(sess)) {
    const e = latestSession(agent);
    if (!e || e.sid || e.carryover || !(e.log || []).length) continue;
    try {
      const last = await db.lastOrchContext(e.key);
      if (last && last.summary_text) { e.carryover = last.summary_text; saveSess(); }
    } catch {}
  }
})();

// Plain headless claude call → final text (prompt drafting, reflections).
function claudeText(prompt, opts = {}) {
  return new Promise((resolve) => {
    // 💸 Internal reflection / banter / drafts / summaries — cheap model by
    // default; opts.model lets a caller pin one explicitly. opts.tools: a comma
    // string of allowed tools so a meeting/draft agent can look real things up
    // (WebSearch/WebFetch/Read…); the broker settings ride along so anything
    // OUTSIDE the allowed set still asks the owner — same flow as a real task.
    const m = (opts.model && MODEL_IDS.has(opts.model)) ? opts.model : LIGHT_MODEL;
    const args = ["-p", "--model", m];
    if (opts.tools) {
      args.push("--allowedTools", opts.tools,
        "--settings", path.join(WORKSPACE, ".claude", "settings.json"));
    }
    const child = spawn("claude", args.map(shArg), {
      cwd: WORKSPACE, shell: true,
      env: { ...process.env, ...(reg.apiKeys || {}), OFFICE_ADAPTER: "1",
        ...(opts.env || {}) },
    });
    child.stdin.write(prompt);
    child.stdin.end();
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
  });
}

// ---------------------------------------------------------------- websocket

function wsAccept(key) {
  return crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

// Server→client text frame (we never need to parse client frames).
function wsFrame(str) {
  const b = Buffer.from(str, "utf8");
  let head;
  if (b.length < 126) head = Buffer.from([0x81, b.length]);
  else if (b.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(b.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(b.length), 2);
  }
  return Buffer.concat([head, b]);
}

function journalTail(n) {
  try {
    const lines = fs.readFileSync(JOURNAL, "utf8").trim().split("\n");
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- bus

function broadcast(evt, journal = true) {
  evt.ts = Date.now();
  const json = JSON.stringify(evt);
  if (journal) fs.appendFile(JOURNAL, json + "\n", () => {});
  const frame = wsFrame(json);
  for (const s of wsClients) s.write(frame);
  if (evt.type !== "world.pos") console.log("[oep] →", json);
}

// ---------------------------------------------------------------- office ops
// Standing work orders (jobs), the shared note board, and the calendar —
// plus the Director's heartbeat. One 30-second scheduler ticks everything.

const JOBS = path.join(__dirname, "jobs.json");
const NOTES = path.join(__dirname, "notes.json");
const CAL = path.join(__dirname, "calendar.json");
const NOTES_MD = path.join(WORKSPACE, "notes.md");

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
// ---- 🧠 office memory (Hermes-style, token-lean) --------------------------
// Two layers, both PLAIN FILES the agents can read and grep themselves:
//   workspace/OFFICE.md        — shared knowledge about the owner/org
//   workspace/memory/<id>.md   — what each agent has learned, one bullet
//                                per fact, auto-distilled after real work
// Injection stays TINY: fresh sessions get only the last few bullets plus
// pointers — full recall is on-demand (Read/Grep), never preloaded.
const OFFICE_MD = path.join(WORKSPACE, "OFFICE.md");
const MEM_DIR = path.join(WORKSPACE, "memory");
fs.mkdirSync(MEM_DIR, { recursive: true });
const OFFICE_MD_DEFAULT =
  "# OFFICE.md — shared office knowledge\n\n" +
  "(The owner can edit this from the 🗂 NOTES tab. Every agent knows where this " +
  "file is and reads it only when it's relevant to the work. Write in any language.)\n\n" +
  "## About the owner\n- \n\n## Office rules\n- \n";
// English by default (this is a global product); agents may append in any
// language later. Also migrate the OLD Thai default in place: it's a single
// shared file regardless of UI language, so when it's still the untouched
// Thai template we replace it with the English one (never clobber real content).
const OFFICE_MD_OLD_TH =
  "# OFFICE.md — ข้อมูลกลางของออฟฟิศ\n\n" +
  "(เจ้าของแก้ไฟล์นี้ได้จากหน้า 🗂 NOTES — agents ทุกตัวรู้ว่าไฟล์นี้อยู่ที่ไหน " +
  "และจะเปิดอ่านเมื่อเกี่ยวข้องกับงานเท่านั้น)\n\n" +
  "## เกี่ยวกับเจ้าของ\n- \n\n## กฎของออฟฟิศ\n- \n";
if (!fs.existsSync(OFFICE_MD)) {
  fs.writeFileSync(OFFICE_MD, OFFICE_MD_DEFAULT);
} else {
  try {
    if (fs.readFileSync(OFFICE_MD, "utf8").trim() === OFFICE_MD_OLD_TH.trim())
      fs.writeFileSync(OFFICE_MD, OFFICE_MD_DEFAULT);
  } catch {}
}

// 🔀 One-time cleanup: older versions SEEDED example workflows into
// workspace/workflows. Examples now live read-only in the bundle, so drop any
// stale workspace copies (id starts with "example-") to avoid duplicates. The
// user's own workflows (wf_* ids) are left untouched.
(function dropSeededExamples() {
  try {
    const dir = path.join(WORKSPACE, "workflows");
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const w = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (String(w.id || "").startsWith("example-")) fs.unlinkSync(path.join(dir, f));
      } catch {}
    }
  } catch {}
})();

// 🧹 Retire the short-lived "custom character" experiment: any agent left on
// avatar 0 (or with leftover tint colors) is moved back to a normal NPC sheet so
// it renders properly. One-time, idempotent.
(function dropCustomAvatars() {
  let changed = false;
  for (const id of Object.keys(reg.agents || {})) {
    const a = reg.agents[id];
    if (!a) continue;
    if (!(a.avatar >= 1 && a.avatar <= 12)) {
      let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
      a.avatar = (Math.abs(h) % 12) + 1;
      changed = true;
    }
    if (a.skin || a.hair || a.suit) { delete a.skin; delete a.hair; delete a.suit; changed = true; }
  }
  if (changed) try { saveReg(); } catch {}
})();

// 🌐 Ship pre-translated UI caches: merge daemon/i18n-seed/<lang>.json into the
// runtime cache (daemon/i18n/) on startup, so the UI shows in the chosen
// language even with NO Gemini key. Runtime entries win (they may be newer or
// hand-edited); the bundled seed only fills the gaps.
(function seedI18n() {
  try {
    const seedDir = path.join(__dirname, "i18n-seed");
    const runDir = path.join(__dirname, "i18n");
    if (!fs.existsSync(seedDir)) return;
    fs.mkdirSync(runDir, { recursive: true });
    for (const f of fs.readdirSync(seedDir)) {
      if (!f.endsWith(".json")) continue;
      let seed = {}, run = {};
      try { seed = JSON.parse(fs.readFileSync(path.join(seedDir, f), "utf8")); } catch {}
      try { run = JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8")); } catch {}
      const out = path.join(runDir, f), tmp = out + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ ...seed, ...run }));
      fs.renameSync(tmp, out); // atomic — never leaves a half-written cache
    }
  } catch {}
})();

function memFile(agent) {
  return path.join(MEM_DIR, String(agent).replace(/[^\w-]/g, "_") + ".md");
}
function memTail(agent, n) {
  try {
    const lines = fs.readFileSync(memFile(agent), "utf8").split("\n")
      .filter((l) => l.trim().startsWith("- "));
    return lines.slice(-n);
  } catch { return []; }
}
function memAppend(agent, facts) {
  if (!facts || !facts.length) return;
  const file = memFile(agent);
  let cur = "";
  try { cur = fs.readFileSync(file, "utf8"); } catch {}
  const fresh = facts
    .map((f) => String(f).replace(/\s+/g, " ").trim().slice(0, 200))
    .filter((f) => f && !cur.includes(f));
  if (!fresh.length) return;
  if (!cur) cur = `# ความจำของ ${agent}\n\n`;
  fs.appendFileSync(file, fresh.map((f) => `- ${f}`).join("\n") + "\n");
  // Keep the retrieval index in step with the new facts (no-op until P1 init).
  try { if (retrievalOk) { retrieval.reindexFile("mem", path.basename(file, ".md"), file); retrieval.persist(); } } catch {}
  broadcast({ type: "memory.learned", agent, count: fresh.length }, false);
}

// ---- retrieval index (P1) -------------------------------------------------
// Relevance lookup over memory / project / owner / skill / meeting-archive, so
// agents can recall only what's relevant instead of dumping everything. Built
// from the office's own files on boot; fail-open (retrievalOk stays false on
// any error and every consumer falls back to today's behavior).
let retrievalOk = false;
const RETRIEVAL_INDEX = path.join(WORKSPACE, "index", "retrieval.json");
try {
  if (!retrieval) throw new Error("module not loaded");
  retrieval.init({
    indexFile: RETRIEVAL_INDEX,
    memDir: MEM_DIR,
    officeMd: OFFICE_MD,
    projectsDir: path.join(WORKSPACE, "projects"),
    meetingsDir: path.join(WORKSPACE, "meetings"),
    skills: reg.skills,
  });
  retrievalOk = true;
  console.log("[retrieval]", JSON.stringify(retrieval.stats()));
} catch (e) { console.error("[retrieval] init:", e.message); }
// Self-heal when the owner edits OFFICE.md outside the daemon.
try {
  fs.watchFile(OFFICE_MD, { interval: 5000 }, () => {
    if (!retrievalOk) return;
    try { retrieval.reindexFile("user", "OFFICE", OFFICE_MD); retrieval.persist(); } catch {}
  });
} catch {}

// ---- native skills (P3) ---------------------------------------------------
// Each agent's assigned skills are projected to workspace/agents/<id>/.claude/
// skills/*/SKILL.md and exposed to its sessions via --add-dir, so skill bodies
// disclose on demand instead of bloating every preamble. Flag-reversible:
// set reg.nativeSkills = false to fall back to inline injection.
const AGENTS_DIR = path.join(WORKSPACE, "agents");
try {
  if (reg.nativeSkills !== false) {
    const s = skillsSync.syncAll(AGENTS_DIR, reg.agents, reg.skills);
    console.log(`[skills] native sync: wrote ${s.wrote}, pruned ${s.pruned}`);
  }
} catch (e) { console.error("[skills] boot sync:", e.message); }
// The note every fresh session carries — pointers + a short tail, never the
// whole archive.
// Per-project memory (office-owned — NEVER written into the user's repo).
function projMemFile(projId) {
  return path.join(WORKSPACE, "projects", String(projId).replace(/[^\w-]/g, "_"), "MEMORY.md");
}
function projMemAppend(projId, facts) {
  if (!projId || !facts || !facts.length) return;
  const file = projMemFile(projId);
  let cur = ""; try { cur = fs.readFileSync(file, "utf8"); } catch {}
  const fresh = facts.map((f) => String(f).replace(/\s+/g, " ").trim().slice(0, 200))
    .filter((f) => f && !cur.includes(f));
  if (!fresh.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!cur) fs.writeFileSync(file, `# Project memory: ${projId}\n\n`);
  fs.appendFileSync(file, fresh.map((f) => `- ${f}`).join("\n") + "\n");
  try { if (retrievalOk) { retrieval.reindexFile("proj", path.basename(path.dirname(file)), file); retrieval.persist(); } } catch {}
}

// Strip prompt scaffolding (xml-ish tags, DELEGATE/PROJECT/SUB protocol words)
// so the retrieval query reflects the actual task, not the wrapper.
function cleanForQuery(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\b(DELEGATE|PROJECT|SUB|SPEAK|PROPOSAL)\s*:/gi, " ")
    .replace(/\s+/g, " ").trim().slice(0, 400);
}

// The Hermes step: inject the memory that's RELEVANT to this task (top-K across
// the agent's own memory, this project's memory, and owner facts) instead of
// dumping the last 8 bullets. Pointers stay so full recall is one Read/​/recall
// away. Fail-open: no index / flag off / no match → exactly the old last-8 dump.
function memoryNote(agent, taskText, projId) {
  const memRef = path.basename(memFile(agent), ".md");
  const header = `\n<office-memory>\n` +
    `ข้อมูลกลางออฟฟิศ: workspace/OFFICE.md (เปิดอ่านเฉพาะเมื่อเกี่ยวกับงาน)\n` +
    `สมุดความจำถาวรของคุณ: workspace/memory/${memRef}.md ` +
    `— พบข้อเท็จจริงสำคัญเกี่ยวกับเจ้าของ/งานที่ควรจำข้ามบทสนทนา ให้เติมบรรทัด "- ..." สั้นๆ เอง\n` +
    (projId ? `ความจำของโปรเจคนี้: ${projMemFile(projId).replace(WORKSPACE + path.sep, "")}\n` : "") +
    `ค้นความจำเก่าทั้งหมดได้ที่ GET /recall?q=<คำค้น> (skill: archive-search)\n`;
  let recall = "";
  const q = cleanForQuery(taskText);
  if (retrievalOk && reg.retrieval !== false && q) {
    try {
      const tiers = projId ? ["mem", "proj", "user"] : ["mem", "user"];
      const refs = { mem: memRef, user: true };
      if (projId) refs.proj = projId;
      const hits = retrieval.search(q, { tiers, refs, k: 6, boost: { proj: 1.3, mem: 1.2, user: 1.0 } });
      const lines = []; let used = 0;
      for (const h of hits) {
        const t = h.text.replace(/\s+/g, " ").trim();
        if (used + t.length > 1500) break;
        lines.push(`- ${t}`); used += t.length;
      }
      if (lines.length) recall = `ความจำที่เกี่ยวกับงานนี้:\n${lines.join("\n")}\n`;
    } catch { /* fall through to the tail */ }
  }
  if (!recall) {
    const tail = memTail(agent, 8);
    if (tail.length) recall = `ความจำล่าสุดของคุณ:\n${tail.join("\n")}\n`;
  }
  return header + recall + `</office-memory>\n`;
}

// ---- 📊 office stats: per-day run counts + spend, for the dashboard.
const STATS = path.join(__dirname, "stats.json");
let stats = loadJson(STATS, {});
function statBump(field, agent, cost) {
  const day = new Date().toISOString().slice(0, 10);
  const d = (stats[day] = stats[day] || { runs: 0, done: 0, failed: 0, cost: 0, agents: {} });
  if (field) d[field] = (d[field] || 0) + 1;
  if (agent && field === "runs") d.agents[agent] = (d.agents[agent] || 0) + 1;
  if (cost) d.cost = Math.round((d.cost + cost) * 10000) / 10000;
  clearTimeout(statBump._t);
  statBump._t = setTimeout(() =>
    fs.writeFile(STATS, JSON.stringify(stats, null, 1), () => {}), 1500);
}

// ---- 💸 per-process token accounting + 📡 live activity -------------------
// CEO worries about token spend. Every claude run reports its usage in the
// stream-json `result`; we accumulate it per agent, keep the most recent runs,
// persist, and expose a sorted breakdown via GET /usage/processes. Separately
// `activeRuns` mirrors what is running RIGHT NOW (the Live Log), kept in sync
// through activityStart/Tool/End and broadcast as `activity.update`.
const USAGE_FILE = path.join(__dirname, "usage-processes.json");
let usageState = loadJson(USAGE_FILE, null);
// Must be a plain object — a corrupt/legacy array would silently serialize
// back as "[]" and lose every accumulated total.
if (!usageState || typeof usageState !== "object" || Array.isArray(usageState)) usageState = {};
// v2 accounting (cache_read split out of input). v1 numbers were inflated by
// cache_read — mixing them with v2 would keep the panel lying. Archive v1
// stats next to the file and restart the counters clean.
if (usageState.schemaVersion !== 2 && (usageState.byAgent || usageState.runs)) {
  try { fs.writeFileSync(USAGE_FILE + ".v1.bak", JSON.stringify(usageState, null, 1)); } catch {}
  usageState = {};
}
usageState.schemaVersion = 2;
usageState.byAgent = usageState.byAgent || {};
usageState.runs = usageState.runs || [];
usageState.totals = usageState.totals ||
  { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
function saveUsage() {
  clearTimeout(saveUsage._t);
  saveUsage._t = setTimeout(() =>
    fs.writeFile(USAGE_FILE, JSON.stringify(usageState, null, 1), () => {}), 1000);
}
// One finished process's token footprint → accumulate + broadcast process.done.
function recordProcessUsage(agent, task, label, usage, costUsd) {
  const u = usage || {};
  // Verified against raw stream-json (2026-06-10, multi-turn forensic):
  // `result.usage` is CUMULATIVE across the whole run — input/output/cache_*
  // are sums over every turn (assistant events only carry message_start
  // snapshots; never use them for totals). cache_read is the replayed
  // history — it is NOT new input and must not inflate the input number
  // (that's what made one agent show input 4.8M). Track it separately.
  const input = (Number(u.input_tokens) || 0) +
    (Number(u.cache_creation_input_tokens) || 0);
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  const total = input + output;
  const cost = Number(costUsd) || 0;
  const ts = Date.now();
  if (!total && !cacheRead && !cost) return null;   // nothing measurable (e.g. spawn error)
  const a = (usageState.byAgent[agent] = usageState.byAgent[agent] ||
    { agent, name: (reg.agents[agent] || {}).name || agent,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0,
      costUsd: 0, runs: 0 });
  a.inputTokens += input; a.outputTokens += output; a.totalTokens += total;
  a.cacheReadTokens = (a.cacheReadTokens || 0) + cacheRead;
  a.costUsd = Math.round((a.costUsd + cost) * 1e6) / 1e6;
  a.runs += 1; a.lastTs = ts;
  const T = usageState.totals;
  T.inputTokens += input; T.outputTokens += output; T.totalTokens += total;
  T.cacheReadTokens = (T.cacheReadTokens || 0) + cacheRead;
  T.costUsd = Math.round((T.costUsd + cost) * 1e6) / 1e6;
  const rec = { agent, task, label: String(label || "").replace(/\s+/g, " ").slice(0, 90),
    inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead,
    totalTokens: total, costUsd: cost, ts };
  usageState.runs.unshift(rec);
  usageState.runs = usageState.runs.slice(0, 500);
  saveUsage();
  broadcast({ type: "process.done", agent, label: rec.label,
    inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead,
    totalTokens: total, ts }, false);
  // Persist this run's DELTA (not the cumulative byAgent totals) so
  // SUM(input_tokens) in token_metrics stays truthful per agent.
  if (db) db.saveTokenMetrics([{ agent, name: a.name,
    inputTokens: input, outputTokens: output, costUsd: cost }]).catch(() => {});
  return rec;
}

const activeRuns = new Map();   // task -> {agent, task, label, project, startedAt, lastTool, lastAt}
const allRunChildren = new Map();   // task -> spawned claude child (ALL runs, not just project-bound)
// 📋 Process Step feed — the REAL work a run is doing, not just "working".
// Per task we keep a small ring of the most recent tool actions, each with a
// short human-readable detail (which file / command / pattern). Frontend
// subscribes to the ws `task.step` event and replays via GET /process/feed.
const runSteps = new Map();         // task -> [{seq, tool, detail, ts}, …] (newest last)
const STEP_RING = 50;               // per-run cap (RAM-only, dropped on activityEnd)
let stepSeq = 0;                    // monotonic id so the UI can de-dupe/replay in order
// Distill a tool_use input into one short line: WHAT it is acting on. Pure +
// defensive — a weird/huge input must never throw or bloat the feed.
function toolDetail(tool, input) {
  try {
    const i = input || {};
    const base = (p) => String(p).replace(/\\/g, "/").split("/").pop();
    switch (String(tool)) {
      case "Read": case "Write": case "Edit": case "NotebookEdit":
        return i.file_path ? base(i.file_path) : "";
      case "Bash": case "PowerShell":
        return String(i.command || "").replace(/\s+/g, " ").trim().slice(0, 100);
      case "Grep": return String(i.pattern || "").slice(0, 80);
      case "Glob": return String(i.pattern || "").slice(0, 80);
      case "WebFetch": return String(i.url || "").slice(0, 100);
      case "WebSearch": return String(i.query || "").slice(0, 80);
      case "Task": case "Agent": return String(i.description || "").slice(0, 80);
      case "Skill": return String(i.skill || "").slice(0, 60);
      default: return "";
    }
  } catch { return ""; }
}
// Record one step for a live run + broadcast it. lastTool/lastDetail also ride
// the next activity.update (activitySnapshot spreads every row field), so the
// Live Log line can show "Edit · server.js" instead of a bare "Edit".
function recordStep(task, agent, tool, detail, session) {
  const step = { seq: ++stepSeq, tool, detail: detail || "", ts: Date.now() };
  let ring = runSteps.get(task);
  if (!ring) { ring = []; runSteps.set(task, ring); }
  ring.push(step);
  while (ring.length > STEP_RING) ring.shift();
  broadcast({ type: "task.step", agent, task, seq: step.seq,
    tool, detail: step.detail, ts: step.ts, session }, false);
}
// 📡 Live Log v2 — ADDITIVE fields on the same `activity.update` row shape
// (old renderers keep working; White renders the new ones in the chat feed):
//   slot       1-based position among concurrent runs, ordered by startedAt
//   live       display label "Claude Live <slot>"
//   elapsedMs  now - startedAt          lastToolAgo  now - lastAt
//   state      "working" | "stuck"  (no new tool for STUCK_AFTER_MS)
// A ticker re-broadcasts every LIVE_TICK_MS while anything runs, so the
// clocks actually move on screen. The watchdog only FLAGS a silent run and
// drops one warning line into the chat — it never kills the run.
const LIVE_TICK_MS = Math.max(1000, Number(process.env.OEP_LIVE_TICK_MS) || 5000);
const STUCK_AFTER_MS = Math.max(LIVE_TICK_MS, Number(process.env.OEP_STUCK_MS) || 120000);
function activitySnapshot() {
  const now = Date.now();
  return [...activeRuns.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((r, i) => {
      const { _stuckWarned, ...row } = r;   // internal watchdog flag stays internal
      return { ...row, slot: i + 1, live: "Claude Live " + (i + 1),
        elapsedMs: now - r.startedAt, lastToolAgo: now - r.lastAt,
        state: now - r.lastAt >= STUCK_AFTER_MS ? "stuck" : "working" };
    });
}
function broadcastActivity() {
  broadcast({ type: "activity.update", running: activitySnapshot() }, false);
}
function activityStart(agent, task, label, project, model) {
  // `model` is the resolved Claude id this run spawned with (null = CLI
  // default). Stored on the row so it rides every activity.update / agent.status
  // snapshot — the Hub shows which model each character is running on.
  activeRuns.set(task, { agent, task,
    name: (reg.agents[agent] || {}).name || agent,
    label: String(label || "").replace(/\s+/g, " ").slice(0, 90),
    model: model || null, modelLabel: modelLabelOf(model),
    project: project || null, startedAt: Date.now(), lastTool: null, lastAt: Date.now() });
  pendingDelegate.delete(String(agent).split("#")[0]);  // the real run supersedes it
  broadcastActivity();
  broadcastAgentStatus();
}
function activityTool(task, tool, detail) {
  const r = activeRuns.get(task);
  if (!r) return;
  r.lastTool = tool; r.lastAt = Date.now();
  if (detail !== undefined) r.lastDetail = detail || "";   // rides activity.update (additive)
  r._stuckWarned = false;   // fresh tool = alive again → re-arm the watchdog
  persistRunTool(task, tool);   // 💾 heartbeat to disk (debounced)
  broadcastActivity();
}
function activityEnd(task) {
  persistRunEnd(task);            // 💾 close the disk record (status came from `result`)
  runSteps.delete(task);          // 📋 drop this run's step ring (RAM only)
  if (activeRuns.delete(task)) { broadcastActivity(); broadcastAgentStatus(); }
}
// tick: keep elapsed/lastToolAgo moving + flag stuck runs (once per silence).
const liveTicker = setInterval(() => {
  if (!activeRuns.size) return;
  const snap = activitySnapshot();
  broadcast({ type: "activity.update", running: snap }, false);
  for (const row of snap) {
    if (row.state !== "stuck") continue;
    const r = activeRuns.get(row.task);
    if (!r || r._stuckWarned) continue;
    r._stuckWarned = true;
    persistRunStuck(row.task);    // 💾 disk state mirrors the overlay's ⚠️ flag
    broadcast({ type: "chat.message", agent: row.agent, task: row.task,
      watchdog: true, live: row.live, slot: row.slot, state: "stuck",
      text: "⚠️ " + row.live + " (" + row.name + ") อาจค้าง — เงียบ " +
        Math.round(row.lastToolAgo / 1000) + "s (งาน: " + row.label + ")" });
  }
}, LIVE_TICK_MS);
liveTicker.unref();

// ---- 💾 run persistence — กันงานหายถาวร (docs/run-persistence.contract.md) --
// `activeRuns` is RAM only: a daemon restart mid-run (deploy, crash, power)
// used to erase every trace of what was being worked on. Every run is now
// mirrored to daemon/runs.json with enough to RESUME it — agent, session key,
// project, cwd, full prompt, model — written atomically (tmp + rename, .bak
// kept at boot). At boot, records still "running" belonged to the dead daemon
// and are TRIAGED (sweepRunsAtBoot): runs whose `result` already landed are
// closed straight to history as done/failed (they were finished, not stuck —
// the old sweep resurrected them as "ค้าง" every restart); resumable runs are
// auto-resumed (same dispatch as POST /runs/resume); unresumable ones are
// finalized failed/expired. Only a run that already burned its auto-resume
// chain stays "interrupted" waiting on the owner — the crash-loop brake.
// The Live-Log watchdog's "stuck" flag lands on the same record, so disk
// state always agrees with the overlay's ⚠️ badge.
const RUNS_FILE = path.join(__dirname, "runs.json");
const RUNS_HISTORY_MAX = 200;     // finished runs kept for forensics
const RUNS_INTERRUPTED_MAX = 30;  // oldest spill into history as "expired"
// 🔁 boot auto-resume knobs (OEP_* envs let the sandbox e2e shrink them):
const RUNS_AUTO_RESUME = process.env.OEP_AUTO_RESUME !== "0";   // escape hatch
const RUNS_RESUME_MAX_AGE_MS =      // older than this → expired, not resumed
  Math.max(60000, Number(process.env.OEP_RESUME_MAX_AGE_MS) || 24 * 3600 * 1000);
const RUNS_RESUME_MAX_CHAIN =       // auto hops per run lineage (กัน crash-loop เผาโทเคน)
  Math.max(1, Number(process.env.OEP_RESUME_MAX_CHAIN) || 3);
function normalizeRunsState(raw) {
  const s = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  s.schemaVersion = 1;
  s.live = (s.live && typeof s.live === "object" && !Array.isArray(s.live)) ? s.live : {};
  s.interrupted = Array.isArray(s.interrupted) ? s.interrupted : [];
  s.history = Array.isArray(s.history) ? s.history : [];
  return s;
}
let runsState = normalizeRunsState(loadJson(RUNS_FILE, null));
// Atomic save: write the tmp twin, then rename over the real file — a crash
// mid-write can never leave runs.json half-written. Heartbeats are debounced;
// lifecycle edges (start/stuck/end/boot) flush immediately.
function saveRuns(now) {
  if (now) {
    clearTimeout(saveRuns._t); saveRuns._t = null;
    try {
      fs.writeFileSync(RUNS_FILE + ".tmp", JSON.stringify(runsState, null, 1));
      fs.renameSync(RUNS_FILE + ".tmp", RUNS_FILE);
      if (saveRuns._err) {   // recovered → tell the office once
        saveRuns._err = null;
        broadcast({ type: "chat.message", agent: "main", watchdog: true,
          text: "✅ runs.json เขียนได้ตามปกติแล้ว — ตัวกันงานหายกลับมาทำงานเต็มระบบ" });
      }
    } catch (e) {
      // The safety net itself failed (disk full / lock / permission) — that
      // must NEVER be silent: the office would believe work is protected
      // while nothing lands on disk. Announce once per failure streak and
      // expose it on GET /runs (persistenceError).
      console.error("[runs] save:", e && e.message);
      const msg = String((e && e.message) || e).slice(0, 160);
      if (!saveRuns._err) broadcast({ type: "chat.message", agent: "main", watchdog: true,
        text: "🚨 เขียน runs.json ไม่ได้ (" + msg + ") — ตัวกันงานหายถาวรหยุดบันทึกชั่วคราว " +
          "ถ้า daemon ดับช่วงนี้งานที่วิ่งอยู่จะกู้ไม่ได้ รีบเช็ค disk/สิทธิ์ไฟล์" });
      saveRuns._err = { ts: Date.now(), message: msg };
    }
    return;
  }
  if (saveRuns._t) return;
  saveRuns._t = setTimeout(() => saveRuns(true), 1000);
}
function trimRunsHistory() {
  const expired = [];   // caller may announce these — งานหายเงียบไม่ได้แม้ตอนล้น cap
  while (runsState.interrupted.length > RUNS_INTERRUPTED_MAX) {
    const old = runsState.interrupted.shift();
    delete old.prompt;
    const closed = { ...old, status: "expired" };
    runsState.history.unshift(closed);
    expired.push(closed);
  }
  runsState.history = runsState.history.slice(0, RUNS_HISTORY_MAX);
  return expired;
}
// Boot sweep: everything still "live" in the file died with the previous
// daemon → interrupted, announced, never silent. Runs ONLY after this process
// wins the port (server "listening", wired next to server.listen) — a loser
// twin daemon must never mark the real daemon's work interrupted, and before
// the port is ours no run can start, so the order is safe by construction.
function sweepRunsAtBoot() {
  if (sweepRunsAtBoot._done) return;   // re-listen after an aborted restart
  sweepRunsAtBoot._done = true;
  // RE-READ the file now that the port is ours: during a watcher handoff the
  // dying daemon keeps flushing runs.json (runs finishing) after this process
  // already loaded its module-scope snapshot — sweeping that stale copy would
  // resurrect finished runs as "interrupted". No run of OURS can have started
  // before "listening", so replacing the snapshot wholesale is safe.
  runsState = normalizeRunsState(loadJson(RUNS_FILE, null));
  try { if (fs.existsSync(RUNS_FILE)) fs.copyFileSync(RUNS_FILE, RUNS_FILE + ".bak"); } catch {}
  const lost = Object.values(runsState.live);
  runsState.live = {};
  const finished = [];   // result line landed → จบแล้วจริงๆ daemon แค่ตายก่อน close
  for (const r of lost) {
    if (r.status === "done" || r.status === "failed") {
      // เคยถูกปลุกเป็น "interrupted" ทั้งที่งานจบแล้ว → โผล่เป็นงานค้างปลอม
      // ทุกรีสตาร์ท. ปิดเข้า history ด้วยสถานะจริงของมันแทน.
      r.endedAt = r.lastHeartbeat || Date.now();
      delete r.prompt;
      runsState.history.unshift(r);
      finished.push(r);
      continue;
    }
    r.status = "interrupted"; r.state = "interrupted";
    r.interruptedAt = Date.now();
    runsState.interrupted.push(r);
  }
  // A "resuming" record means the daemon died between accepting the resume
  // and the new run landing on disk — the dispatch died too; back in line.
  for (const r of runsState.interrupted)
    if (r.status === "resuming") r.status = "interrupted";
  // Cap-trim BEFORE triage: trimming after would expire records the triage
  // just announced/scheduled, and their resume timers would fire into a void.
  // Whatever the cap pushed out is still ANNOUNCED below (capExpired→closed).
  const capExpired = trimRunsHistory();
  // 🔁 Triage ทุกตัวใน interrupted (ของรอบนี้ + ตกค้างจาก boot ก่อนๆ):
  // ต่อได้ → auto-resume, ต่อไม่ได้ → ปิดเรื่อง failed/expired. ค้างรอ human
  // ได้กรณีเดียว: ใช้โควต้า auto-resume ครบ RUNS_RESUME_MAX_CHAIN รอบแล้ว
  // (run ที่พา daemon ล้มซ้ำๆ ห้ามวนเผาโทเคนเอง — ตรงนั้นต้องเป็น CEO สั่ง).
  const now = Date.now();
  const toResume = [], closed = [], parked = [];
  for (const r of capExpired)
    closed.push(`⌛ ${r.runId} — ${r.label}: เกินเพดานรายการค้าง (${RUNS_INTERRUPTED_MAX}) → ปิดเป็น expired`);
  // auto-resume OFF (escape hatch) ≠ silence: everything waiting still gets
  // announced as parked — งานหายเงียบคือสิ่งเดียวที่ contract นี้ห้ามเด็ดขาด.
  if (!RUNS_AUTO_RESUME) parked.push(...runsState.interrupted);
  if (RUNS_AUTO_RESUME) for (const r of [...runsState.interrupted]) {
    if (!reg.agents[String(r.agent || "").split("#")[0]]) {
      archiveInterruptedRun(r, "failed", null, true);
      closed.push(`❌ ${r.runId} — ${r.label}: agent "${r.agent}" ไม่อยู่ใน roster แล้ว → ปิดเป็น failed`);
    } else if (!r.prompt && !r.session) {
      archiveInterruptedRun(r, "failed", null, true);
      closed.push(`❌ ${r.runId} — ${r.label}: ไม่เหลือ prompt/session ให้ต่อ → ปิดเป็น failed`);
    } else if (now - (r.lastHeartbeat || r.startedAt || 0) > RUNS_RESUME_MAX_AGE_MS) {
      archiveInterruptedRun(r, "expired", null, true);
      closed.push(`⌛ ${r.runId} — ${r.label}: ค้างนานเกินเพดาน resume → ปิดเป็น expired`);
    } else if ((r.resumeChain || 0) >= RUNS_RESUME_MAX_CHAIN) {
      parked.push(r);
    } else if (r.promptTruncated && !sidAliveFor(r)) {
      // The stored prompt is INCOMPLETE (>64k, capped) and the claude session
      // didn't survive — auto-resuming would silently run a beheaded task.
      // Park it: only the owner can judge a partial restart.
      parked.push(r);
    } else {
      toResume.push(r);
    }
  }
  // history-only cap here — interrupted was already trimmed pre-triage, and
  // every record still in toResume/parked must SURVIVE this save.
  runsState.history = runsState.history.slice(0, RUNS_HISTORY_MAX);
  saveRuns(true);
  const total = finished.length + closed.length + toResume.length + parked.length;
  if (total) setTimeout(() => {   // after boot settles; broadcast journals it
    broadcast({ type: "runs.recovered",
      interrupted: runsState.interrupted.map(({ prompt, ...r }) => r) });
    const lines = [
      ...finished.map((r) => `• ✅ ${r.runId} — ${r.name || r.agent}: ${r.label} → จบไปแล้วก่อนรีสตาร์ท ปิดเป็น ${r.status}`),
      ...closed.map((t) => "• " + t),
      ...toResume.map((r) => `• 🔁 ${r.runId} — ${r.name || r.agent}: ${r.label}` +
        (r.project ? ` (โปรเจค ${r.project})` : "") + ` → ต่อให้อัตโนมัติ`),
      ...parked.map((r) => `• ⚠️ ${r.runId} — ${r.name || r.agent}: ${r.label} → ` +
        (!RUNS_AUTO_RESUME
          ? `รอ CEO สั่งต่อ (auto-resume ปิดอยู่ทาง OEP_AUTO_RESUME=0)`
          : (r.resumeChain || 0) >= RUNS_RESUME_MAX_CHAIN
            ? `auto-resume มาแล้ว ${r.resumeChain} รอบยังไม่จบ — รอ CEO ตัดสิน`
            : `prompt ยาวเกินจนถูกตัดและ session เดิมไม่เหลือ — รอ CEO ตัดสิน`)),
    ];
    broadcast({ type: "chat.message", agent: "main", watchdog: true,
      text: `🛟 daemon รีสตาร์ท — เคลียร์งานที่วิ่งอยู่ ${total} งาน ไม่ทิ้งค้าง:\n` + lines.join("\n") +
        (parked.length ? `\n\nสั่งทำต่อ: POST /runs/resume {"runId":"..."} · ปิดเรื่อง: POST /runs/dismiss · ดูทั้งหมด: GET /runs` : "") });
    // ปล่อยทีละตัวห่างกัน 1.5s — ไม่ spawn claude พร้อมกันเป็นพรวน. ระหว่างรอ
    // คิว เจ้าของอาจ dismiss/resume เองผ่าน API ไปแล้ว → เช็คซ้ำก่อนยิง.
    toResume.forEach((rec, i) => setTimeout(() => {
      if (rec.status !== "interrupted" || !runsState.interrupted.includes(rec)) return;
      dispatchRunRecovery(rec, { auto: true });
    }, 500 + i * 1500));
  }, 3000);
}
// Tasks whose children a forced restart already killed (doRestart cutRuns).
// Normally the successor's boot triage recovers them; if the handoff ABORTS
// (successor dies at boot) the surviving daemon calls recoverRestartCuts().
const restartCutTasks = new Set();
// Undo the in-memory project lock a cut run still holds. The forced-restart
// close path (_restartCut) returns BEFORE releaseProj ON PURPOSE — a clean
// handoff lets these counters die with the old process. But on the ABORT path
// the old daemon survives, so every cut run's projRuns/projAgents bump must be
// reversed here or the project stays "working" (ai:true) forever — and the
// auto-resume below would then double-count it. Mirrors releaseProj, plus it
// drops keys that reach 0 so a re-listened daemon's snapshot stays clean.
function releaseCutProj(r) {
  const projId = r && r.project;
  if (!projId) return;
  projRuns[projId] = Math.max(0, (projRuns[projId] || 1) - 1);
  if (!projRuns[projId]) delete projRuns[projId];
  const pa = projAgents[projId] || {};
  pa[r.agent] = Math.max(0, (pa[r.agent] || 1) - 1);
  if (!pa[r.agent]) delete pa[r.agent];
  if (!Object.keys(pa).length) delete projAgents[projId];
}
function recoverRestartCuts() {
  // Snapshot the cut records from OUR pre-reload live map (they carry the full
  // prompt/resume material) BEFORE we adopt the disk state below.
  const recs = [...restartCutTasks].map((t) => runsState.live[t]).filter(Boolean);
  restartCutTasks.clear();
  if (!recs.length) return;
  // 🔀 P1 race: the successor may have WON the port, run sweepRunsAtBoot()
  // (moving these very records live→interrupted on disk) and even auto-resumed
  // some, THEN crashed inside the 6s watchdog. Saving our stale in-memory
  // snapshot would clobber the successor's freshly-written interrupted/live
  // records (→ งานซ้ำ/งานหาย/สถานะย้อนกลับ). Re-read runs.json NOW and build on
  // that authoritative state. Any cut run the successor already triaged (its
  // runId is in interrupted/history) is LEFT to that disposition — we only
  // recover the runs it never reached. (Common abort: successor died before
  // binding → disk untouched → these are still "running" in live → recovered.)
  runsState = normalizeRunsState(loadJson(RUNS_FILE, null));
  const handled = new Set();
  for (const r of runsState.interrupted) if (r && r.runId) handled.add(r.runId);
  for (const r of runsState.history) if (r && r.runId) handled.add(r.runId);
  const recovered = [];
  for (const r of recs) {
    releaseCutProj(r);            // always undo our own lock — handled or not
    activeRuns.delete(r.task);    // drop the dead RAM row if its close never fired
    if (r.runId && handled.has(r.runId)) continue;   // successor owns it now
    // Still ours to recover. Drop any stale "running" copy of THIS run from the
    // adopted live map — match by runId, since task ids reset across boots and
    // the same key may now belong to one of the successor's own fresh runs.
    for (const k of Object.keys(runsState.live))
      if (runsState.live[k] && runsState.live[k].runId === r.runId) delete runsState.live[k];
    r.status = "interrupted"; r.state = "interrupted";
    r.interruptedAt = Date.now();
    runsState.interrupted.push(r);
    recovered.push(r);
  }
  trimRunsHistory();
  saveRuns(true);
  broadcastActivity();
  broadcastAgentStatus();
  broadcast({ type: "projects.changed" }, false);
  broadcast({ type: "runs.recovered",
    interrupted: runsState.interrupted.map(({ prompt, ...r }) => r) });
  if (!recovered.length) return;   // successor already triaged them all — done
  broadcast({ type: "chat.message", agent: "main", watchdog: true,
    text: `🛟 restart ถูกยกเลิก แต่ run ที่ถูกตัดไปก่อนแล้ว ${recovered.length} งานถูกกู้ไว้ — ` +
      (RUNS_AUTO_RESUME ? "กำลังต่อให้อัตโนมัติ" : "รอสั่งต่อทาง POST /runs/resume") });
  if (RUNS_AUTO_RESUME) recovered.forEach((rec, i) => setTimeout(() => {
    if (rec.status !== "interrupted" || !runsState.interrupted.includes(rec)) return;
    if ((rec.resumeChain || 0) >= RUNS_RESUME_MAX_CHAIN) return;   // parked, announced above
    dispatchRunRecovery(rec, { auto: true });
  }, 500 + i * 1500));
}
// Does this record's claude session REALLY survive? Same ground-truth test
// startClaudeRun uses before --resume: the bookkept sid means nothing unless
// its session file still exists under the run's working directory.
function sidAliveFor(r) {
  const e = (sess[String(r.agent)] || []).find((x) => x.key === r.session);
  if (!e || !e.sid) return false;
  const enc = String(r.cwd || WORKSPACE).replace(/[^a-zA-Z0-9]/g, "-");
  try {
    return fs.existsSync(path.join(require("os").homedir(), ".claude",
      "projects", enc, e.sid + ".jsonl"));
  } catch { return false; }
}
// Archive an interrupted record into history (resume/dismiss/boot-triage all
// end here). `quiet` skips the per-record broadcast+flush — the boot sweep
// batches dozens of these and saves/announces once itself.
function archiveInterruptedRun(rec, status, newTask, quiet) {
  const i = runsState.interrupted.indexOf(rec);
  if (i >= 0) runsState.interrupted.splice(i, 1);
  rec.status = status;
  rec.endedAt = Date.now();
  if (newTask) rec.resumedAs = newTask;
  delete rec.prompt;
  runsState.history.unshift(rec);
  if (quiet) return;
  trimRunsHistory();
  saveRuns(true);
  broadcast({ type: "runs.recovered",
    interrupted: runsState.interrupted.map(({ prompt, ...r }) => r) });
}
// 🔁 Recovery dispatch — POST /runs/resume (human) and the boot auto-resume
// share this path. Two-phase: the record stays in `interrupted` (as
// "resuming") until the dispatch is durably handed off (onStarted fires after
// the new run's disk record exists AND the child got its stdin) — a dispatch
// failure rolls it back instead of losing the prompt. The rollback must
// survive even a failure AFTER onStarted archived the record, so it keeps its
// own prompt copy and re-inserts if needed. Same path as a normal dispatch
// otherwise: session key resumes the claude sid when it survived; the
// original prompt rides along for the case where it didn't; project binding
// self-heals in startClaudeRun. resumeChain counts the auto hops so a run
// that keeps dying can't resurrect itself forever.
function dispatchRunRecovery(rec, opts = {}) {
  rec.status = "resuming";
  saveRuns(true);
  const promptCopy = rec.prompt;
  return runClaude(rec.agent,
    `<run-recovery>\nงานนี้ถูกตัดกลางคันเพราะ daemon รีสตาร์ท (run ${rec.runId}` +
    (rec.lastTool ? `, เครื่องมือสุดท้ายที่ใช้: ${rec.lastTool}` : "") +
    `). ตรวจสภาพงานล่าสุดก่อน แล้วทำต่อให้จบ — อย่าเริ่มซ้ำส่วนที่เสร็จแล้ว\n</run-recovery>\n\n` +
    `คำสั่งเดิม:\n${rec.prompt || rec.label}`,
    { session: rec.session || undefined, project: rec.project || undefined,
      logPrompt: (opts.auto ? "🔁 ต่ออัตโนมัติหลังรีสตาร์ท: " : "🔁 ทำต่อจากงานที่ถูกตัด: ") + rec.label,
      resumeChain: (rec.resumeChain || 0) + 1,
      // fires synchronously inside this very call — takes the task id
      // as an argument (the runClaude return value is not assigned yet then)
      onStarted: (t) => archiveInterruptedRun(rec, "resumed", t),
      onStartFailed: (e) => {
        // Whether archived already or not: restore the prompt, put the
        // record back in line, and drop any premature history entry.
        runsState.history = runsState.history.filter((h) => h !== rec);
        rec.status = "interrupted";
        rec.prompt = promptCopy;
        delete rec.resumedAs;
        if (!runsState.interrupted.includes(rec)) runsState.interrupted.push(rec);
        saveRuns(true);
        broadcast({ type: "runs.recovered",
          interrupted: runsState.interrupted.map(({ prompt, ...r }) => r) });
        broadcast({ type: "chat.message", agent: "main", watchdog: true,
          text: "⚠️ resume " + rec.runId + " ไม่สำเร็จ (" +
            String((e && e.message) || e).slice(0, 120) +
            ") — งานยังอยู่ในรายการค้าง สั่งซ้ำได้" });
      } });
}
function persistRunStart(info) {
  const rec = {
    runId: "r" + info.startedAt + "-" + info.task,   // unique across boots (task ids reset)
    task: info.task, agent: info.agent,
    name: (reg.agents[info.agent] || {}).name || info.agent,
    label: String(info.label || "").replace(/\s+/g, " ").slice(0, 90),
    // Resume material. The cap only guards runs.json against pathological
    // payloads — 64k covers every real dispatch; if it ever cuts, say so.
    prompt: String(info.prompt || "").slice(0, 64000),
    ...(String(info.prompt || "").length > 64000 ? { promptTruncated: true } : {}),
    session: info.session || null, project: info.project || null,
    cwd: info.cwd || null, model: info.model || null, pid: info.pid || null,
    status: "running", state: "working",
    startedAt: info.startedAt, lastTool: null, lastHeartbeat: info.startedAt,
    // recovery hop counter rides into the NEW record: if this run dies too,
    // the next boot sees how many auto-resumes this lineage already burned.
    ...(info.resumeChain ? { resumeChain: info.resumeChain } : {}),
  };
  runsState.live[info.task] = rec;
  saveRuns(true);
}
function persistRunTool(task, tool) {
  const rec = runsState.live[task];
  if (!rec) return;
  rec.lastTool = tool; rec.lastHeartbeat = Date.now(); rec.state = "working";
  saveRuns();
}
function persistRunStuck(task) {
  const rec = runsState.live[task];
  if (!rec || rec.state === "stuck") return;
  rec.state = "stuck"; rec.stuckSince = Date.now();
  saveRuns(true);
}
function persistRunResult(task, ok) {
  const rec = runsState.live[task];
  if (!rec) return;
  rec.status = ok ? "done" : "failed";
  // Immediate flush: a crash between this result and close/activityEnd must
  // not leave "running" on disk — the boot triage would offer to resume (or
  // auto-resume) a run that actually FINISHED.
  saveRuns(true);
}
function persistRunEnd(task) {
  const rec = runsState.live[task];
  if (!rec) return;
  delete runsState.live[task];
  if (rec.status === "running") rec.status = "ended";  // closed without a result line
  rec.endedAt = Date.now();
  delete rec.prompt;            // finished runs don't need resume material
  runsState.history.unshift(rec);
  trimRunsHistory();
  saveRuns(true);
}

// ---- 🟢 per-agent live status ---------------------------------------------
// The overlay needs "who is working RIGHT NOW, and on which project" PER AGENT
// — not per run. Derived from `activeRuns` (covers DELEGATE, scheduled jobs,
// CEO chat; ghost runs "id#sN" roll up to their parent) plus `pendingDelegate`,
// which marks an assignee from the moment a DELEGATE: line is parsed, so the
// 4.5s hand-over walk before runClaude() already shows them as working.
const pendingDelegate = new Map();   // agentId -> {project, task, ts}
const PENDING_DELEGATE_TTL = 30000;  // dispatch delay is 4.5s; older = stale
function agentStatusSnapshot() {
  const latest = new Map();          // base agent id -> newest active run
  for (const r of activeRuns.values()) {
    const id = String(r.agent).split("#")[0];
    const prev = latest.get(id);
    if (!prev || r.startedAt > prev.startedAt) latest.set(id, r);
  }
  // `project` carries the DISPLAY NAME (the same string the Director's
  // `@ project` routing uses, and what the overlay pill shows) — runs store
  // the canonical id internally, so map it back here.
  const nameOfProj = (pid) => {
    if (!pid) return null;
    const p = projects.find((x) => x.id === pid);
    return p ? p.name : pid;
  };
  return Object.keys(reg.agents).map((id) => {
    // `model`/`modelLabel`: while WORKING it's the model the live run actually
    // spawned with; otherwise the model this agent WOULD spawn with (perAgent →
    // office default), so the Hub icon always has a model to show — even idle.
    const cfg = resolveModel(id);
    const r = latest.get(id);
    if (r) return { agentId: id, status: "working",
      project: nameOfProj(r.project), task: r.label || null,
      model: r.model || cfg, modelLabel: modelLabelOf(r.model || cfg) };
    const p = pendingDelegate.get(id);
    if (p && Date.now() - p.ts < PENDING_DELEGATE_TTL)
      return { agentId: id, status: "working", project: p.project, task: p.task,
        model: cfg, modelLabel: modelLabelOf(cfg) };
    return { agentId: id, status: "idle", project: null, task: null,
      model: cfg, modelLabel: modelLabelOf(cfg) };
  });
}
// Broadcast only on real change — activityStart/End fire per run, but the
// per-agent view often stays identical (e.g. a 2nd run by an already-busy
// agent), and the overlay should not be poked for nothing.
function broadcastAgentStatus() {
  const agents = agentStatusSnapshot();
  const sig = JSON.stringify(agents);
  if (sig === broadcastAgentStatus._sig) return;
  broadcastAgentStatus._sig = sig;
  broadcast({ type: "agent.status", agents }, false);
}

// ---- 🧠 per-agent model settings -----------------------------------------
// Each agent may run on a chosen Claude model. Resolution order at spawn time:
//   perAgent[<id>]  →  office default  →  null (= no --model flag → the claude
// CLI's own default). An unset default keeps the OLD behavior exactly, so this
// is fully backward-compatible. Ghosts ("<id>#sN") inherit their parent's model.
const MODEL_SETTINGS = path.join(__dirname, "model-settings.json");
// The catalog the UI offers (contract: {id,label,tier,costHint}). tier ranks
// capability/price: 3 = most capable & costly … 1 = cheapest. Ids are canonical
// claude model ids passed straight to `claude --model`.
const AVAILABLE_MODELS = [
  { id: "claude-opus-4-8",           label: "Opus 4.8",   tier: 3, costHint: "แพงสุด · ฉลาด/แรงสุด" },
  { id: "claude-sonnet-4-6",         label: "Sonnet 4.6", tier: 2, costHint: "สมดุล ราคา/ประสิทธิภาพ" },
  // ⛔ Fable 5 is DISABLED: this account has no entitlement — `claude --model
  // claude-fable-5` dies with a 403/permission error and (when it was the office
  // default) bricked EVERY agent. Kept in the catalog so the contract stays at 4
  // models, but flagged `unavailable` so it can't be SET (POST rejects it) or
  // RESOLVED (resolveModel/effectiveModel skip it) ever again.
  { id: "claude-fable-5",            label: "Fable 5",    tier: 2, costHint: "ปิดใช้งาน — บัญชีนี้ไม่มีสิทธิ์ (403)", unavailable: true },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5",  tier: 1, costHint: "ประหยัดสุด · เร็วสุด" },
];
const MODEL_IDS = new Set(AVAILABLE_MODELS.map((m) => m.id));
// Ids that exist in the catalog but must never be set or spawned (entitlement
// gaps). Derived from the `unavailable` flag so the rule lives in one place.
const UNAVAILABLE_MODELS = new Set(AVAILABLE_MODELS.filter((m) => m.unavailable).map((m) => m.id));
let modelSettings = loadJson(MODEL_SETTINGS, { default: null, perAgent: {} });
modelSettings.perAgent = modelSettings.perAgent || {};
if (modelSettings.default === undefined) modelSettings.default = null;
function saveModelSettings() {
  fs.writeFileSync(MODEL_SETTINGS, JSON.stringify(modelSettings, null, 2));
}
// A model id is valid only if it's in the catalog; null means "clear / unset".
function validModelId(id) { return id === null || MODEL_IDS.has(id); }
// A model id may be SET (default / perAgent) only if it's a real catalog id AND
// not flagged unavailable — so a 403 model can never be persisted into config
// through the UI/API again. null still means "clear / unset".
function modelSettable(id) { return id === null || (MODEL_IDS.has(id) && !UNAVAILABLE_MODELS.has(id)); }
// Which model a given agent (or its ghost "<id>#sN") should spawn with, or
// null to let the CLI pick its own default. perAgent override → default → null.
// Unavailable (403) ids in a STALE config are skipped, not spawned — so an old
// fable binding silently degrades to the office default instead of bricking.
function resolveModel(agentId) {
  const base = String(agentId).split("#")[0];   // ghosts inherit the parent's
  // 🔒 A model-locked agent always spawns on its locked model — above any
  // perAgent override or office default — so a stale/edited override can't win.
  const locked = lock.lockedModelOf(reg.agents[base], modelSettable);
  if (locked) return locked;
  const v = modelSettings.perAgent[base];
  if (v && MODEL_IDS.has(v) && !UNAVAILABLE_MODELS.has(v)) return v;
  const d = modelSettings.default;
  return d && MODEL_IDS.has(d) && !UNAVAILABLE_MODELS.has(d) ? d : null;
}
// 🔒 { agentId → locked model id } for every model-locked agent — so the model
// settings UI can pin + disable that agent's picker instead of silently 403ing.
function modelLocksMap() {
  const out = {};
  for (const [id, a] of Object.entries(reg.agents || {})) {
    const m = lock.lockedModelOf(a, modelSettable);
    if (m) out[id] = m;
  }
  return out;
}
// 💸 Token-burn control. Internal/system passes (heartbeat, reminders, social
// banter, skill reflection, NPC drafts) don't need a flagship model — they run
// on Haiku. Fan-out ghosts do parallel grunt work, not deep reasoning, so they
// are capped at Sonnet: a 5-way split of an Opus agent must not cost 5× Opus.
const LIGHT_MODEL = "claude-haiku-4-5-20251001";
const GHOST_CAP_MODEL = "claude-sonnet-4-6";
function modelTier(id) {
  const m = AVAILABLE_MODELS.find((x) => x.id === id);
  return m ? m.tier : 2;
}
// Cap a ghost's model: Opus(tier 3) or Fable → Sonnet; unknown CLI-default
// (null) → Sonnet too (can't risk it being Opus); already-cheap stays as-is.
function capGhostModel(model) {
  if (!model) return GHOST_CAP_MODEL;
  if (model === "claude-fable-5") return GHOST_CAP_MODEL;
  return modelTier(model) >= 3 ? GHOST_CAP_MODEL : model;
}
// Friendly catalog label for a model id ("claude-opus-4-8" → "Opus 4.8"). null
// id → null (= "CLI default", let the UI label it). Unknown id passes through so
// nothing is ever swallowed silently.
function modelLabelOf(id) {
  if (!id) return null;
  const m = AVAILABLE_MODELS.find((x) => x.id === id);
  return m ? m.label : id;
}
// The model a run will ACTUALLY spawn with — same resolution the spawn uses
// (explicit opts.model → perAgent/default → CLI default), plus the ghost cap.
// Hoisted out so the Live Log / Hub can show the model up-front, before spawn.
function effectiveModel(agentId, opts) {
  opts = opts || {};
  let m = (opts.model && MODEL_IDS.has(opts.model) && !UNAVAILABLE_MODELS.has(opts.model))
    ? opts.model : resolveModel(agentId);
  if (String(agentId).includes("#")) m = capGhostModel(m);
  return m;   // may be null = CLI default
}

// 🚑 403 / entitlement fallback. An account without access to a model makes
// `claude --model X` die with a permission API error and NO `result` line — the
// run would silently fail and, if X is the office default, brick EVERY agent
// (this is exactly what fable-5 did). We detect that signature in the child's
// stderr and retry ONCE on a model we know is entitled — loudly: a feed warning,
// never a silent death. Downgrade chain (skip the one that just failed):
const MODEL_FALLBACK_CHAIN = ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
// Does this stderr text look like a model-entitlement denial (vs a normal run
// error)? Matches the CLI/API phrasings seen for 403 / no-access / not-found.
function looksLikeModelDenied(text) {
  const s = String(text || "").toLowerCase();
  if (!s) return false;
  return /\b403\b/.test(s) ||
    s.includes("may not exist or you may not have access") ||
    s.includes("do not have access") || s.includes("not have access to") ||
    s.includes("permission_error") || s.includes("not entitled") ||
    s.includes("model_not_found") || s.includes("model not found");
}
// The next entitled model to try after `failed` died with a 403. Walks the
// static chain, skipping the model that just failed and any already tried this
// run. Returns null when the chain is exhausted (→ surface the real failure).
function fallbackModelAfter(failed, tried) {
  for (const m of MODEL_FALLBACK_CHAIN) {
    if (m === failed) continue;
    if (tried && tried.has(m)) continue;
    if (UNAVAILABLE_MODELS.has(m)) continue;
    return m;
  }
  return null;
}

// 🧵 Thread compaction (docs/orchestrator-compaction.contract.md). The #1 token
// burner: a long-lived orchestrator thread keeps `--resume`-ing one claude
// session, so every turn re-caches + replays the whole ever-growing history
// (forensics: a single thread reached 26.1M tokens / 2,720 turns). Fix: once a
// thread crosses a size threshold, stop resuming — summarize it, drop the
// claude sid, and start a FRESH session carrying a short handoff. The office
// thread (entry.key + entry.log) is untouched, so the CEO sees no break.
const MAX_TURNS = 40;
const MAX_TOKENS = 150000;
function needsCompaction(e) {
  return (e.turns || 0) >= MAX_TURNS || (e.tokens || 0) >= MAX_TOKENS;
}
// Last-resort carryover when the LLM summary fails — raw recent log, never throws.
function fallbackCarryover(e) {
  return (e.log || []).slice(-10)
    .map((x) => `${x.who}: ${String(x.text || "").slice(0, 200)}`).join("\n").slice(0, 2000);
}
// One cheap (Haiku) summary at compaction time — distills the thread into a
// handoff for the fresh session. Never throws: caller falls back to raw log.
async function summarizeThread(e) {
  const recent = (e.log || []).slice(-30)
    .map((x) => `${x.who}: ${x.text}`).join("\n").slice(0, 12000);
  const s = await claudeText(
    `สรุปบริบทเธรดงานนี้ให้สั้น กระชับ เพื่อ "ส่งต่อ" ให้ session ใหม่ทำงานต่อได้ไร้รอยต่อ:\n` +
    `- เป้าหมาย/งานปัจจุบัน\n- การตัดสินใจสำคัญที่ทำไปแล้ว\n- งานที่ยังค้าง/ขั้นถัดไป\n` +
    `- ไฟล์/ส่วนที่กำลังโฟกัส\n\n${recent}`,
    { model: LIGHT_MODEL });
  return String(s || "").slice(0, 4000);
}

// ---- 📊 token / quota usage panel ----------------------------------------
// Shows how much Claude Code and Codex quota is left (+ when it resets).
//   • Claude: NO free local source — must hit the Anthropic API with the
//     user's OAuth token (read FRESH each call so Claude Code's own refresh is
//     honored) and read `anthropic-ratelimit-unified-*` response headers. Costs
//     ~1 token, so we only refresh ON-DEMAND from GET /tokens, gated to once per
//     5 min — zero idle cost when nobody's looking at the panel.
//   • Codex: FREE — parse rate_limits from the newest session rollout file;
//     polled every 60s. Truly-fresh values need a real Codex turn, so values
//     carry a `stale` flag + snapshotAt.
// Only computed %/resetAt ever leave the server — never tokens/secrets.
// Test seams (default to real home / real API): BAGIDEA_CLAUDE_HOME,
// BAGIDEA_CODEX_HOME, BAGIDEA_CLAUDE_API (host:port → http mock instead of the
// real https Anthropic endpoint).
const TOKENS_FILE = path.join(__dirname, "tokens.json");
const CLAUDE_HOME = process.env.BAGIDEA_CLAUDE_HOME || path.join(require("os").homedir(), ".claude");
const CODEX_HOME = process.env.BAGIDEA_CODEX_HOME || path.join(require("os").homedir(), ".codex");
let tokensCache = loadJson(TOKENS_FILE, { claude: null, codex: null, ts: 0 });
let lastClaudeFetch = 0;
function saveTokens() { fs.writeFile(TOKENS_FILE, JSON.stringify(tokensCache, null, 2), () => {}); }
// Signature for change-detection — excludes volatile fetchedAt so a steady
// quota doesn't rebroadcast every poll.
function tokSig(o) {
  if (!o) return "null";
  const w = (x) => x ? `${x.usedPct}/${x.remainingPct}/${x.resetAt}/${x.status || ""}` : "-";
  return [o.ok, o.plan, o.stale, o.representative, o.snapshotAt || "",
    w(o.primary), w(o.secondary), o.note || ""].join("|");
}
function broadcastTokens() {
  broadcast({ type: "tokens.update", claude: tokensCache.claude,
    codex: tokensCache.codex, ts: Date.now() }, false);   // transient: never journaled
}
function setClaude(obj) {
  const changed = tokSig(obj) !== tokSig(tokensCache.claude);
  tokensCache.claude = obj; tokensCache.ts = Date.now(); saveTokens();
  if (changed) broadcastTokens();
}
function setCodex(obj) {
  const changed = tokSig(obj) !== tokSig(tokensCache.codex);
  tokensCache.codex = obj; tokensCache.ts = Date.now(); saveTokens();
  if (changed) broadcastTokens();
}

function claudeAccessToken() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CLAUDE_HOME, ".credentials.json"), "utf8"));
    return (j.claudeAiOauth && j.claudeAiOauth.accessToken) || null;
  } catch { return null; }
}
// Build the claude block straight from unified ratelimit headers. utilization
// is a 0..1 fraction → usedPct/remainingPct. Pure + side-effect-free.
function claudeFromHeaders(h) {
  const u5 = h["anthropic-ratelimit-unified-5h-utilization"];
  if (u5 === undefined) return null;            // not a ratelimited response
  const n = (x) => x === undefined ? null : Number(x);
  const used = (x) => x === undefined ? null : Math.round(Number(x) * 100);
  const rem = (x) => x === undefined ? null : Math.round((1 - Number(x)) * 100);
  const rep = h["anthropic-ratelimit-unified-representative-claim"];
  return {
    ok: true, plan: "max_5x", stale: false, fetchedAt: Date.now(),
    primary: { label: "5h", usedPct: used(u5), remainingPct: rem(u5),
      resetAt: n(h["anthropic-ratelimit-unified-5h-reset"]),
      status: h["anthropic-ratelimit-unified-5h-status"] || null },
    secondary: { label: "7d",
      usedPct: used(h["anthropic-ratelimit-unified-7d-utilization"]),
      remainingPct: rem(h["anthropic-ratelimit-unified-7d-utilization"]),
      resetAt: n(h["anthropic-ratelimit-unified-7d-reset"]),
      status: h["anthropic-ratelimit-unified-7d-status"] || null },
    representative: rep === "seven_day" ? "secondary" : "primary",
    note: null,
  };
}
// A fetch failure keeps the last good windows but flips ok/stale + sets a note.
function claudeFail(note) {
  const prev = tokensCache.claude || { plan: "max_5x" };
  setClaude({ ...prev, ok: false, stale: true, fetchedAt: Date.now(), note });
}
function refreshClaudeTokens() {
  return new Promise((resolve) => {
    const token = claudeAccessToken();
    if (!token) { claudeFail("no Claude credentials"); return resolve(); }
    const body = JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1,
      messages: [{ role: "user", content: "hi" }] });
    const headers = { "authorization": "Bearer " + token,
      "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    const override = process.env.BAGIDEA_CLAUDE_API;   // test seam: http mock
    const mod = require(override ? "http" : "https");
    const opts = override
      ? { method: "POST", host: override.split(":")[0], port: Number(override.split(":")[1]),
          path: "/v1/messages", headers }
      : { method: "POST", host: "api.anthropic.com", path: "/v1/messages", headers };
    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; fn(); resolve(); };
    const rq = mod.request(opts, (rs) => {
      const h = rs.headers; rs.resume();
      rs.on("end", () => {
        const c = claudeFromHeaders(h);
        finish(() => c ? setClaude(c) : claudeFail("no ratelimit headers (HTTP " + rs.statusCode + ")"));
      });
    });
    rq.setTimeout(12000, () => rq.destroy(new Error("timeout")));
    rq.on("error", (e) => finish(() => claudeFail("fetch error: " + e.message)));
    rq.write(body); rq.end();
  });
}
// On-demand Claude refresh, gated to ≤ once / 5 min (the API call costs quota).
function maybeRefreshClaude() {
  const now = Date.now();
  if (now - lastClaudeFetch < 5 * 60000) return;
  lastClaudeFetch = now;
  refreshClaudeTokens().catch(() => {});
}

// Codex plan from the id_token JWT (best-effort, never throws).
function codexPlan() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, "auth.json"), "utf8"));
    const idt = j.tokens && j.tokens.id_token;
    if (!idt) return null;
    const p = JSON.parse(Buffer.from(idt.split(".")[1], "base64").toString("utf8"));
    const auth = p["https://api.openai.com/auth"] || {};
    return p.chatgpt_plan_type || auth.chatgpt_plan_type || null;
  } catch { return null; }
}
// Newest rollout file, found by walking the latest YYYY/MM/DD only (bounded).
function newestCodexRollout() {
  try {
    const base = path.join(CODEX_HOME, "sessions");
    const maxDir = (dir) => {
      const xs = fs.readdirSync(dir).filter((n) => {
        try { return fs.statSync(path.join(dir, n)).isDirectory(); } catch { return false; }
      }).sort();
      return xs.length ? xs[xs.length - 1] : null;
    };
    const y = maxDir(base); if (!y) return null;
    const m = maxDir(path.join(base, y)); if (!m) return null;
    const d = maxDir(path.join(base, y, m)); if (!d) return null;
    const dp = path.join(base, y, m, d);
    const files = fs.readdirSync(dp).filter((f) => /^rollout-.*\.jsonl$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dp, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files.length ? { file: path.join(dp, files[0].f), mtime: files[0].t } : null;
  } catch { return null; }
}
function extractRateLimits(j) {
  if (!j || typeof j !== "object") return null;
  return j.rate_limits || (j.payload && j.payload.rate_limits) ||
    (j.msg && (j.msg.rate_limits || (j.msg.payload && j.msg.payload.rate_limits))) || null;
}
function refreshCodexTokens() {
  try {
    const found = newestCodexRollout();
    if (!found) {
      return setCodex({ ok: false, plan: codexPlan(), stale: true, fetchedAt: Date.now(),
        primary: null, secondary: null, representative: "primary", note: "no Codex run yet" });
    }
    const lines = fs.readFileSync(found.file, "utf8").split("\n");
    let rl = null;
    for (let i = lines.length - 1; i >= 0 && !rl; i--) {
      const ln = lines[i].trim(); if (!ln) continue;
      let j; try { j = JSON.parse(ln); } catch { continue; }
      rl = extractRateLimits(j);
    }
    if (!rl) {
      return setCodex({ ok: false, plan: codexPlan(), stale: true, fetchedAt: Date.now(),
        primary: null, secondary: null, representative: "primary",
        note: "no rate_limits in latest rollout" });
    }
    const snapshotAt = Math.floor(found.mtime / 1000);
    const stale = (Date.now() / 1000 - snapshotAt) > 600;   // >10 min old
    const win = (w, label) => (w && w.used_percent !== undefined) ? {
      label, usedPct: Number(w.used_percent),
      remainingPct: 100 - Number(w.used_percent),
      resetAt: w.resets_at === undefined ? null : Number(w.resets_at) } : null;
    setCodex({
      ok: true, plan: rl.plan_type || codexPlan() || "plus",
      stale, fetchedAt: Date.now(), snapshotAt,
      primary: win(rl.primary, "5h"), secondary: win(rl.secondary, "7d"),
      representative: "primary",
      note: stale ? "snapshot from last Codex run; may be stale" : null,
    });
  } catch (e) { console.error("[tokens] codex refresh:", e.message); }
}
// The 60s poll only RE-READS the newest rollout file — it can never beat the
// staleness floor, because Codex writes rate_limits only when it actually runs
// a turn. So `stale:true` legitimately means "no Codex turn in >10 min", not a
// broken poller. To get a TRULY fresh snapshot on demand we must spend one
// tiny Codex turn (`Reply PONG`, ~free tier) which writes a current rollout;
// then re-reading it clears `stale`. Gated to ≤ once / 2 min so a panel that
// pulls often can't burn turns. Opt-in only (GET /tokens?fresh=1) — never
// automatic, so the CEO's token budget is never spent without an explicit ask.
let codexFreshAt = 0;
let codexFreshBusy = false;
function refreshCodexFresh() {
  return new Promise((resolve) => {
    const now = Date.now();
    if (codexFreshBusy || now - codexFreshAt < 120000) return resolve(false);
    codexFreshBusy = true; codexFreshAt = now;
    const c = spawn("cmd", ["/c", "codex", "exec", "--skip-git-repo-check",
      "-s", "read-only", "Reply PONG"], { windowsHide: true, stdio: "ignore" });
    const done = (ok) => {
      codexFreshBusy = false;
      if (ok) { try { refreshCodexTokens(); } catch {} }   // re-read the fresh rollout
      resolve(ok);
    };
    const t = setTimeout(() => { killTreeSync(c.pid); done(false); }, 60000);
    c.on("error", () => { clearTimeout(t); done(false); });
    c.on("exit", (code) => { clearTimeout(t); done(code === 0); });
  });
}
// Codex is free → poll every 60s (+ once shortly after boot). Claude is NOT
// polled in the background; it refreshes only when the panel pulls GET /tokens.
setInterval(() => refreshCodexTokens(), 60000);
setTimeout(() => refreshCodexTokens(), 2000);

// Rough per-use cost ESTIMATES for the secondary tools (USD). Unlike Claude,
// these APIs don't return a real cost, so the dashboard labels them "≈". Tune
// freely — public pricing moves. (One place to edit.)
const COST_RATES = {
  gemini_tts_per_char:    0.000016,  // Gemini 2.5 Flash TTS, per input char
  gemini_image_each:      0.039,     // Gemini 2.5 Flash image, per image
  gemini_i18n_per_char:   0.0000004, // flash-latest translate, per char (tiny)
  gemini_transcribe_each: 0.002,     // Gemini STT fallback, per clip (~30s)
  openai_whisper_each:    0.003,     // OpenAI Whisper, per clip (~30s @ $0.006/min)
  openai_image_each:      0.04,      // OpenAI image, per image
};
// Add an ESTIMATED secondary-tool spend under stats[day].aux[provider].
function auxCost(provider, usd) {
  if (!usd || usd <= 0) return;
  const day = new Date().toISOString().slice(0, 10);
  const d = (stats[day] = stats[day] || { runs: 0, done: 0, failed: 0, cost: 0, agents: {} });
  d.aux = d.aux || { gemini: 0, openai: 0 };
  d.aux[provider] = Math.round(((d.aux[provider] || 0) + usd) * 1e6) / 1e6;
  clearTimeout(statBump._t);
  statBump._t = setTimeout(() =>
    fs.writeFile(STATS, JSON.stringify(stats, null, 1), () => {}), 1500);
}

let jobs = loadJson(JOBS, []);    // {id, agent, prompt, mode, at, time, daily, everyMin, enabled, lastRun, lastDay, done, sessionKey, running}
let notes = loadJson(NOTES, []);  // {id, who, text, ts}
let cal = loadJson(CAL, []);      // {id, title, at, remindMin, notified}
// Clean up one-shot jobs that already fired (no `running` survives a restart) —
// run-now or one-time scheduled orders have nothing left to do, so they should
// not linger as dead, uneditable rows.
{
  const _n = jobs.length;
  jobs = jobs.filter((j) => {
    const oneShot = j.mode === "now" || (j.mode === "at" && !j.daily);
    return !(oneShot && (j.lastRun || j.done));
  }).map((j) => { delete j.running; return j; });
  if (jobs.length !== _n) fs.writeFileSync(JOBS, JSON.stringify(jobs, null, 2));
}
const saveJobs = () => fs.writeFileSync(JOBS, JSON.stringify(jobs, null, 2));
const saveCal = () => fs.writeFileSync(CAL, JSON.stringify(cal, null, 2));

// The note board lives twice: notes.json for the UI, notes.md inside the
// agents' workspace so they can READ it and APPEND bullets themselves.
let writingNotesMd = false;
function saveNotes() {
  fs.writeFileSync(NOTES, JSON.stringify(notes, null, 2));
  writingNotesMd = true;
  const md = "# Office Notes — กระดานโน้ตกลาง\n" +
    "(agents: อ่านได้ และเพิ่มบรรทัด \"- ข้อความ\" เพื่อฝากโน้ตถึง CEO ได้เลย)\n\n" +
    notes.map((n) => `- ${n.text}`).join("\n") + "\n";
  fs.writeFileSync(NOTES_MD, md);
  setTimeout(() => { writingNotesMd = false; }, 1500);
  broadcast({ type: "notes.changed", count: notes.length }, false);
}
if (!fs.existsSync(NOTES_MD)) saveNotes();
fs.watchFile(NOTES_MD, { interval: 3000 }, () => {
  if (writingNotesMd) return;
  // An agent edited the board: bullet lines become the new truth.
  try {
    const lines = fs.readFileSync(NOTES_MD, "utf8").split("\n")
      .map((l) => l.match(/^\s*[-*]\s+(.+)$/)).filter(Boolean).map((m) => m[1].trim());
    notes = lines.map((text) => {
      const old = notes.find((n) => n.text === text);
      return old || { id: "n" + Date.now() + Math.floor(Math.random() * 999),
        who: "agent", text, ts: Date.now() };
    });
    fs.writeFileSync(NOTES, JSON.stringify(notes, null, 2));
    broadcast({ type: "notes.changed", count: notes.length, by: "agent" });
  } catch {}
});

// ---- 📁 projects: real workspaces agents (and you) actually work in.
// A project = name + directory. Agents run with cwd there when a thread is
// bound to it; you can pop a terminal (claude -c) in it yourself, and the
// daemon detects whether that window is still open via a marker the
// launcher bakes into the process command line.

const PROJECTS_FILE = path.join(__dirname, "projects.json");
let projects = loadJson(PROJECTS_FILE, []);  // {id, name, dir, ts, created}
// Migration: entries from before the `created` flag all came from the
// create flow (browse-registering didn't exist yet) — they're ours.
let migrated = false;
for (const p of projects) if (p.created === undefined) { p.created = true; migrated = true; }
const saveProjects = () => fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
if (migrated) saveProjects();
let projWin = {};           // project id -> visible (true) / hidden (false)
const projRuns = {};        // project id -> active AI run count
const projAgents = {};      // project id -> {agentId: run count} (who's working)
const projChildren = {};    // project id -> Set<ChildProcess> (so the owner can stop the work and take over)
const WINPROJ = path.join(__dirname, "winproj.ps1");
const LIVEVIEW = path.join(__dirname, "liveview.ps1");

function winproj(action, id, cb) {
  const { execFile } = require("child_process");
  execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", WINPROJ, action, String(id || "")],
    { timeout: 20000, windowsHide: true }, (e, out) => cb && cb(e, out));
}

function projectDir(id) {
  const p = projects.find((x) => x.id === id);
  return p ? p.dir : null;
}

// 📁 Folder browser for "Add Project" — directories only, hard-guarded:
// absolute paths only (resolve() collapses any ../ traversal), OS/system
// areas are off-limits for both browsing and project registration.
const FS_FORBIDDEN = [
  /^[a-z]:\\windows(\\|$)/i, /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata(\\|$)/i, /^[a-z]:\\\$recycle\.bin(\\|$)/i,
  /^[a-z]:\\system volume information(\\|$)/i, /^[a-z]:\\recovery(\\|$)/i,
];
function fsGuardedResolve(p) {
  const v = String(p || "").trim();
  if (!/^[A-Za-z]:[\\/]/.test(v)) throw new Error("ต้องเป็น absolute path (เช่น D:\\project)");
  const full = path.resolve(v);                  // kills ../ and ./ segments
  if (FS_FORBIDDEN.some((re) => re.test(full)))
    throw new Error("โฟลเดอร์ระบบ — ไม่อนุญาต");
  return full;
}
function fsListDirs(p) {
  if (!String(p || "").trim()) {                 // no path → drive roots
    const drives = [];
    for (let i = 65; i <= 90; i++) {
      const root = String.fromCharCode(i) + ":\\";
      try { if (fs.existsSync(root)) drives.push({ name: root, path: root }); } catch {}
    }
    return { path: "", parent: null, dirs: drives };
  }
  const full = fsGuardedResolve(p);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory())
    throw new Error("ไม่มีโฟลเดอร์นี้");
  const dirs = fs.readdirSync(full, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !/^[.$]/.test(d.name))
    .slice(0, 500)
    .map((d) => ({ name: d.name, path: path.join(full, d.name) }));
  const up = path.dirname(full);
  return { path: full, parent: up === full ? "" : up, dirs };
}

// Headless claude in an untrusted folder stalls on the trust dialog it can
// never show. Pre-trust project dirs in ~/.claude.json (same flag the
// interactive "Yes, I trust this folder" sets).
function ensureTrusted(dir) {
  try {
    const file = path.join(require("os").homedir(), ".claude.json");
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    j.projects = j.projects || {};
    const key = String(dir).replace(/\\/g, "/").replace(/\/+$/, "");
    const cur = j.projects[key] || {};
    if (cur.hasTrustDialogAccepted === true) return;
    j.projects[key] = { ...cur, hasTrustDialogAccepted: true };
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    console.log("[proj] pre-trusted", key);
  } catch (e) { console.error("[proj] trust", e.message); }
}

// Mentioning a registered project by name in chat binds the thread to it:
// the agent runs INSIDE that directory and the project lights up 🤖.
// Matching is forgiving: case- and space-insensitive.
function projectFromPrompt(prompt) {
  const squash = (s) => String(s).toLowerCase().replace(/\s+/g, "");
  const text = squash(prompt);
  const hits = projects.filter((p) =>
    p.name.length >= 3 && text.includes(squash(p.name)));
  return hits.length === 1 ? hits[0].id : null;
}

// Project by display name (the Director's `@ <project>` routing).
function projectByName(name) {
  const n = String(name || "").trim().toLowerCase();
  const p = projects.find((x) => x.name.toLowerCase() === n);
  return p ? p.id : null;
}

// Resolve a loose project reference — id, directory path, or display name —
// to a canonical project id. Used so Tasks (jobs) can be stored, filtered and
// displayed per project no matter which form the caller passes. Returns null
// for an empty/unknown ref (treated as an office-wide Task, no project home).
function resolveProjectRef(ref) {
  const v = String(ref || "").trim();
  if (!v) return null;
  if (projectDir(v)) return v;                        // already a valid id
  const norm = (s) => String(s).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const byDir = projects.find((x) => norm(x.dir) === norm(v));
  if (byDir) return byDir.id;
  return projectByName(v);                             // by display name (or null)
}

// 🏠 Home project = the registered project whose dir IS this office app's own
// root. Once it exists, "no project" routes HERE instead of the legacy bare
// WORKSPACE fallback (the picker's old "Default" row) that mis-routed work.
// Matched by directory, not name, so renaming the project can't break it.
function homeProjectId() {
  const norm = (s) => String(s).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const root = norm(path.resolve(__dirname, ".."));
  const p = projects.find((x) => norm(x.dir) === root);
  return p ? p.id : null;
}

// 🧠 Auto-scan policy (CEO standing order, docs/project-brain.contract.md):
// a project gets a Brain BEFORE work enters it (pre-work — only if it was
// never scanned) and a re-scan AFTER every finished job (post-work) so the
// CodeGraph/Mapping stay fresh. buildBrain is sync + bounded (~169ms on a
// 6GB repo); a failed scan must NEVER block dispatch or report-back, hence
// the blanket try/catch. Returns true when a scan actually ran.
function autoScanBrain(ref, phase) {
  try {
    const pid = resolveProjectRef(ref);
    const proj = pid && projects.find((x) => x.id === pid);
    if (!proj) return false;
    // pre-work is "scan once": a cache file means the brain already exists.
    if (phase === "pre-work" && fs.existsSync(brain.cacheFile(proj.id))) return false;
    console.log(`[brain] auto-scan: ${proj.name} (${phase})`);
    const { summary } = brain.buildBrain(proj, { now: Date.now() });
    broadcast({ type: "brain.ready", project: proj.id, projectName: proj.name,
      stats: summary.stats }, false);
    return true;
  } catch (e) {
    console.error(`[brain] auto-scan ${phase} failed:`, e && e.message);
    return false;
  }
}

// 🚧 Auto-Scan gate (docs/auto-scan-gate.contract.md): work entering a project
// that was NEVER scanned must wait for its first Brain build instead of
// starting blind. The gate auto-fires the scan, exposes state for the FE
// (GET /project/scan/status + ws scan.gate), queues the blocked runs, and
// releases them the moment the scan completes. Fail-open like autoScanBrain:
// a failed scan releases the queue anyway — the gate may never wedge work.
const scanGates = new Map();   // projectId → {startedAt, name, queued:[fn]}
const scanGatedJobs = new WeakSet();   // jobs already gated once — never re-gate (fail-open)
function scanState(pid) {
  if (scanGates.has(pid)) return "scanning";
  try { return fs.existsSync(brain.cacheFile(pid)) ? "ready" : "unscanned"; }
  catch { return "unscanned"; }
}
// Ensure pid is scanned before runFn starts. Returns "ready" (ran inline) or
// "scanning" (queued behind the auto-fired scan). No/unknown project → inline.
function gateOnScan(pid, runFn) {
  const proj = pid && projects.find((x) => x.id === pid);
  if (!proj || scanState(pid) === "ready") { runFn(); return "ready"; }
  let g = scanGates.get(pid);
  if (g) { g.queued.push(runFn); return "scanning"; }
  g = { startedAt: Date.now(), name: proj.name, queued: [runFn] };
  scanGates.set(pid, g);
  // Same event pair as the manual POST /project/scan so the FE gate (which
  // listens for scan.progress/scan.done) sees auto-fired scans identically.
  broadcast({ type: "scan.progress", project: pid, projectName: proj.name }, false);
  broadcast({ type: "scan.gate", project: pid, projectName: proj.name,
    state: "scanning" }, false);
  // setImmediate so the caller's HTTP response is written before the (sync,
  // bounded) buildBrain occupies the event loop.
  setImmediate(() => {
    let ok = false;
    try { ok = autoScanBrain(pid, "pre-work"); } catch {}
    const done = scanGates.get(pid);
    scanGates.delete(pid);
    // scan.done fires even on failure (ok:false) — the FE modal must unlock
    // either way; a wedged "scanning" spinner would contradict fail-open.
    broadcast({ type: "scan.done", project: pid, projectName: proj.name, ok }, false);
    broadcast({ type: "scan.gate", project: pid, projectName: proj.name,
      state: "ready", scanned: ok, error: ok ? undefined : "scan failed — released fail-open" }, false);
    for (const fn of (done && done.queued) || []) {
      try { fn(); } catch (e) { console.error("[scan-gate] queued run:", e && e.message); }
    }
  });
  return "scanning";
}

// Create/register a project — the ONE path everything uses (HTTP API and
// the Director's PROJECT: protocol line). Throws readable Thai errors.
function createProject(name, place, pathArg) {
  name = String(name || "").trim().slice(0, 60);
  if (!name) throw new Error("no name");
  let dir = String(pathArg || "").trim();
  if (!dir && place && reg.places[place]) dir = path.join(reg.places[place], name);
  if (!dir) throw new Error("need place or path");
  dir = dir.replace(/\//g, "\\");
  // Separator-proof normalization for every duplicate check.
  const norm = (s) => String(s).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  if (projects.some((x) => norm(x.dir) === norm(dir)))
    throw new Error("โปรเจคนี้อยู่ในรายการแล้ว (path ซ้ำ)");
  if (projects.some((x) => x.name.toLowerCase() === name.toLowerCase()))
    throw new Error("มีโปรเจคชื่อนี้อยู่แล้ว — ห้ามลงทะเบียนซ้ำ");
  if (Object.values(reg.places).some((f) => norm(f) === norm(dir)))
    throw new Error("path นี้คือโฟลเดอร์ของ place — โปรเจคต้องเป็นโฟลเดอร์ย่อยข้างใน");
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  ensureTrusted(dir);
  // Only folders WE created may ever be disk-deleted from the UI.
  const proj = { id: "p" + Date.now(), name, dir, ts: Date.now(), created: !existed };
  projects.push(proj);
  saveProjects();
  broadcast({ type: "projects.changed" }, false);
  return proj;
}

// claude keeps sessions under ~/.claude/projects/<path-as-dashes>/*.jsonl.
function claudeSessionDir(dir) {
  return path.join(require("os").homedir(), ".claude", "projects",
    String(dir).replace(/[^a-zA-Z0-9]/g, "-"));
}
// Newest session id — `claude -c` ignores headless-born sessions, so the
// open button resumes the latest sid EXPLICITLY (proven to work).
function newestSid(dir) {
  try {
    const p = claudeSessionDir(dir);
    const files = fs.readdirSync(p).filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, t: fs.statSync(path.join(p, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files.length ? files[0].f.replace(/\.jsonl$/, "") : null;
  } catch { return null; }
}

// Windows Terminal renders Thai beautifully — use it when available.
// Invoke by ABSOLUTE path: a hidden-started daemon can lack LOCALAPPDATA
// and even the WindowsApps PATH entry, which silently forced the conhost
// fallback before.
const WT_EXE = path.join(require("os").homedir(),
  "AppData", "Local", "Microsoft", "WindowsApps", "wt.exe");
// App-execution aliases stat() as EACCES (existsSync = false even though
// the file is right there) — detect via the directory listing instead.
const HAS_WT = (() => {
  try { return fs.readdirSync(path.dirname(WT_EXE)).includes("wt.exe"); }
  catch { return false; }
})();

// Terminal liveness + visibility: every project window carries a
// BAGIDEA_PROJ_<id> marker; winproj.ps1 sweeps them (1 = visible window,
// 0 = running hidden in the background).
function sweepProjects() {
  winproj("sweep", "", (e, out) => {
    const next = {};
    for (const line of String(out || "").split("\n")) {
      const m = line.trim().match(/^([\w-]+)\s+([01])$/);
      if (m) next[m[1]] = m[2] === "1";
    }
    const changed = JSON.stringify(next) !== JSON.stringify(projWin);
    projWin = next;
    if (changed) broadcast({ type: "projects.changed" }, false);
  });
}

// Every agent knows the project map — say a project's name in chat and
// they work its real directory, full authority, summary on finish.
function projectNote() {
  if (!projects.length && !Object.keys(reg.places).length &&
      !Object.keys(reg.apiKeys || {}).length && !featuresMap().image) return "";
  const keysLine = Object.keys(reg.apiKeys || {}).length
    ? `\nAPI keys ที่ตั้งค่าไว้ใน env ของคุณแล้ว (เรียกใช้ได้ทันที): ${Object.keys(reg.apiKeys).join(", ")}`
    : "";
  const sysTools = featuresMap().image ? `
เครื่องมือกลางของออฟฟิศ (เรียกผ่าน Bash ได้เลย):
- 🖼 สร้างภาพ AI: curl -s -X POST http://127.0.0.1:8787/gen/image -H "content-type: application/json" -d "{\\"prompt\\":\\"<english prompt>\\",\\"project\\":\\"<project id ที่คุณทำงานอยู่>\\"}"
  → ได้ {"path": "..."} — ใส่ path นั้นในคำตอบ แชทของเจ้าของจะแสดงรูปอัตโนมัติ
  → ถ้าภาพนี้เป็นงานออกแบบ/ของโปรเจค ให้แนบ "project" เป็น id ของโปรเจคที่คุณทำงานอยู่ด้วยเสมอ ระบบจะเก็บภาพเข้าแกลเลอรี 📸 SNAPSHOTS ผูกกับโปรเจคให้กดดูย้อนหลังได้ (ไม่ใส่ = โชว์แค่ในแชทแล้วหาย)` : "";
  // Cap to the 12 most-recent projects so the note stays bounded as they pile up
  // (the full list is always one GET /registry away).
  const recent = projects.slice(-12);
  const more = projects.length > recent.length ? `\n(…อีก ${projects.length - recent.length} โปรเจค — ดูทั้งหมดที่ GET /registry)` : "";
  const list = (recent.map((p) => `- ${p.name} → ${p.dir}`).join("\n") || "(ยังไม่มี)") + more;
  const places = Object.entries(reg.places)
    .map(([n, f]) => `- "${n}" → ${f}`).join("\n") || "(ไม่มี)";
  return `

<office-projects>
โปรเจคที่ลงทะเบียนในออฟฟิศ:
${list}
สถานที่เก็บโปรเจค (ชื่อย่อ):
${places}
เมื่อผู้ใช้อ้างถึงโปรเจคเหล่านี้ ให้ทำงานกับไฟล์ใน path ของมันโดยตรงทันที —
คุณมีอำนาจตัดสินใจเต็มที่ในงานที่ได้รับมอบ ทำเสร็จแล้วต้องสรุปผลให้ผู้สั่งงานชัดเจน.
สำคัญ: เช็ครายการข้างบนก่อนเสมอ — โปรเจคที่มีอยู่แล้ว "ห้ามลงทะเบียนซ้ำ" และห้ามใช้
โฟลเดอร์ของ place เป็น path โปรเจคโดยตรง (ระบบจะปฏิเสธ).
ห้ามเด็ดขาด: ลบ/ถอดโปรเจคออกจากรายการ (API remove/removeDisk) เว้นแต่ผู้ใช้สั่งเองชัดๆ.
การทดสอบใดๆ (เช่น เว็บ) ให้ใช้วิธีเบื้องหลังก่อนเสมอ (curl / headless / สคริปต์)
อย่าเปิดหน้าต่างรบกวนผู้ใช้; ถ้าจำเป็นต้องเปิดจริงๆ จนไม่มีทางอื่น ให้รันคำสั่งเปิดตรงๆ
แล้วระบบ Security จะขอ allow จากผู้ใช้ให้เอง.
กฎเหล็ก: server/process ทุกตัวที่คุณเปิดเพื่อทดสอบ (dev server, next start, ฯลฯ)
ต้องปิดให้หมดก่อนจบงาน — ห้ามทิ้งโปรเซสค้างไว้ในเครื่องผู้ใช้เด็ดขาด.${keysLine}${sysTools}${
  (typeof plugins !== "undefined" && plugins.agentNote()) || ""}
</office-projects>`;
}

function projectStatus() {
  return projects.map((p) => ({ ...p,
    open: p.id in projWin, visible: !!projWin[p.id],
    ai: (projRuns[p.id] || 0) > 0,
    agents: Object.keys(projAgents[p.id] || {}) }));
}

// Serious window watching: sweep every 5s, plus on every /projects read.
setInterval(sweepProjects, 5000);

// ---- job runner: per-agent queue + a global cap so the machine breathes.
const agentBusy = new Set();
const jobQueue = [];
function dispatchJob(job) {
  // 🛡 The agent was validated when the job was created, but it may have been
  // fired (or was never approved) by the time a queued/scheduled job comes up
  // — never spawn a run under an id that is no longer in the roster.
  if (!reg.agents[String(job.agent || "").split("#")[0]]) {
    job.enabled = false; job.done = true;
    saveJobs();
    broadcast({ type: "chat.message", agent: "main", watchdog: true,
      text: "🛡 ข้ามงานตั้งเวลา \"" + String(job.prompt || "").slice(0, 60) +
        "\" — agent \"" + String(job.agent).slice(0, 40) + "\" ไม่อยู่ใน roster แล้ว" });
    const next = jobQueue.shift();
    if (next) dispatchJob(next);
    return;
  }
  if (agentBusy.has(job.agent) || agentBusy.size >= 2) {
    if (!jobQueue.includes(job)) jobQueue.push(job);
    return;
  }
  // 🚧 Auto-Scan gate: a job entering a never-scanned project waits behind the
  // auto-fired first scan (same rule as /chat and DELEGATE). One-shot per job:
  // a failed scan releases fail-open and must not loop the job back here.
  {
    const gatePid = job.project ? resolveProjectRef(job.project) : null;
    if (gatePid && scanState(gatePid) !== "ready" && !scanGatedJobs.has(job)) {
      scanGatedJobs.add(job);
      gateOnScan(gatePid, () => dispatchJob(job));
      return;
    }
  }
  agentBusy.add(job.agent);
  job.lastRun = Date.now();
  if (job.mode === "now") job.done = true;
  job.running = true;  // drives the "กำลังทำงาน" state in the UI
  saveJobs();
  // A Task keeps its project home: it runs INSIDE that project's directory and
  // its run shows up under that project — so each project sees its own work.
  const projId = job.project && projectDir(job.project) ? job.project : null;
  broadcast({ type: "job.started", agent: job.agent, title: job.prompt.slice(0, 60),
    job: job.id, project: projId });
  broadcast({ type: "jobs.changed" }, false);
  // A repeating order (every-N, or a daily time) stays; a one-shot (run-now or a
  // one-time scheduled time) has nothing left to do once it finishes — so it's
  // removed instead of lingering as a dead, uneditable row.
  const oneShot = job.mode === "now" || (job.mode === "at" && !job.daily);
  runClaude(job.agent, job.prompt, {
    session: job.sessionKey || "new",
    project: projId || undefined,
    logPrompt: "📋 [งานที่สั่งไว้] " + job.prompt,
    onEntry: (key) => { job.sessionKey = key; saveJobs(); },
    onDone: () => {
      agentBusy.delete(job.agent);
      maybeReviewGate(job);   // Mr N's project delivery → Codex gate
      job.running = false;
      if (oneShot) jobs = jobs.filter((j) => j.id !== job.id);
      saveJobs();
      broadcast({ type: "jobs.changed" }, false);
      const next = jobQueue.shift();
      if (next) dispatchJob(next);
    },
  });
}

function jobDue(job, now) {
  if (job.enabled === false || job.done) return false;
  if (job.mode === "every")
    return !job.lastRun || now - job.lastRun >= (job.everyMin || 10) * 60000;
  if (job.mode === "at") {
    if (job.daily && job.time) {
      const [h, m] = job.time.split(":").map(Number);
      const today = new Date(); today.setHours(h, m, 0, 0);
      const dayKey = new Date().toDateString();
      return now >= today.getTime() && job.lastDay !== dayKey;
    }
    return job.at && now >= job.at && !job.lastRun;
  }
  return false;
}

// ---- the Director's heartbeat: a periodic overview pass. He pings the
// owner ONLY when something deserves it; "OK" stays silent.
let lastHeartbeat = Date.now();
let lastHbSig = null;
function heartbeat() {
  lastHeartbeat = Date.now();
  const upcoming = cal.filter((c) => c.at > Date.now() && c.at < Date.now() + 12 * 3600000)
    .sort((a, b) => a.at - b.at).slice(0, 6)
    .map((c) => `- ${c.title} @ ${new Date(c.at).toLocaleString("th-TH")}`).join("\n") || "(ว่าง)";
  const standing = jobs.filter((j) => !j.done && j.enabled !== false).slice(0, 8)
    .map((j) => `- [${j.mode}] ${j.agent}: ${j.prompt.slice(0, 60)}`).join("\n") || "(ไม่มี)";
  const board = notes.slice(-8).map((n) => `- ${n.text}`).join("\n") || "(ว่าง)";
  // Nothing the Director reports on (calendar / jobs / notes) has changed since
  // his last pass → he'd just say "OK" again. Skip the spawn entirely.
  const sig = `${upcoming}${standing}${board}`;
  if (sig === lastHbSig) return;
  lastHbSig = sig;
  runClaude("main",
    `รอบตรวจความเรียบร้อยของ Director (ตอนนี้ ${new Date().toLocaleString("th-TH")}):\n\n` +
    `นัดหมาย 12 ชม.ข้างหน้า:\n${upcoming}\n\nงานที่สั่งค้างไว้:\n${standing}\n\n` +
    `กระดานโน้ต:\n${board}\n\n` +
    `ถ้ามีสิ่งที่ CEO ควรรู้ตอนนี้ (นัดใกล้ถึง งานสะดุด โน้ตที่ควรเห็น) ` +
    `ให้เขียนข้อความแจ้งสั้นๆ อ่านง่าย. ถ้าทุกอย่างเรียบร้อยและไม่มีอะไรต้องรบกวน ` +
    `ให้ตอบคำเดียวว่า OK`,
    { noSub: true, model: LIGHT_MODEL, logPrompt: "💓 รอบตรวจความเรียบร้อย",
      filterText: (t) => (/^\s*OK\.?\s*$/i.test(t) ? "" : t) });
}

// ---- 30-second scheduler: jobs, reminders, heartbeat.
setInterval(() => {
  const now = Date.now();
  for (const job of jobs) {
    if (jobDue(job, now)) {
      if (job.mode === "at" && job.daily) job.lastDay = new Date().toDateString();
      dispatchJob(job);
    }
  }
  for (const c of cal) {
    if (!c.notified && now >= c.at - (c.remindMin || 10) * 60000 && now < c.at + 300000) {
      c.notified = true;
      saveCal();
      broadcast({ type: "reminder", agent: "main", text: c.title, at: c.at });
      runClaude("main",
        `แจ้งเตือนนัดหมายให้ CEO เดี๋ยวนี้: "${c.title}" เวลา ` +
        `${new Date(c.at).toLocaleString("th-TH")} (อีกประมาณ ${Math.max(1, Math.round((c.at - now) / 60000))} นาที). ` +
        `เขียนข้อความเตือนสั้นๆ เป็นกันเอง 1-2 ประโยค`,
        { noSub: true, model: LIGHT_MODEL, logPrompt: `🔔 เตือนนัด: ${c.title}` });
    }
  }
  const hb = Number(reg.heartbeatMin || 0);
  if (hb > 0 && now - lastHeartbeat >= hb * 60000 && agentBusy.size === 0)
    heartbeat();
  socialTick(now);
  ambientTick(now);
  sweepProjects();
}, 30000);
sweepProjects();

// ---------------------------------------------------------------- adapter

// Spawns a headless Claude Code session, translating stream-json → OEP.
// Dangerous tools route through the Security Center: the PreToolUse hook in
// workspace/.claude/settings.json long-polls /perm/request and we hold it
// until the user stamps Allow/Deny.
// Self-splitting: every top-level run is told it MAY fan out into parallel
// sub-agent clones by ending its reply with `SUB: <job>` lines. The daemon
// strips them from the chat, spawns the ghosts, and sends all results back
// for a final synthesis turn.
const SUB_NOTE = `

<system-capability>
ถ้าคำขอนี้ประกอบด้วยงานย่อยอิสระ 2-4 อย่างที่ทำขนานกันได้ (เช่น ค้นหาหลายเรื่อง,
ตรวจหลายไฟล์, เก็บข้อมูลหลายแหล่ง) คุณสามารถ "แตกร่าง" ได้:
จบคำตอบด้วยบรรทัดรูปแบบนี้ หนึ่งบรรทัดต่อหนึ่งงานย่อย (สูงสุด 4 บรรทัด):
SUB: <งานย่อยที่ชัดเจนครบถ้วนในตัวเอง พร้อมบริบทที่จำเป็นทั้งหมด>
ระบบจะสร้าง sub-agent โคลนของคุณรันขนานกันทันที แล้วส่งผลลัพธ์ทั้งหมดกลับมา
ให้คุณสรุปเป็นคำตอบสุดท้ายเอง. งานเดี่ยวง่ายๆ ห้ามแตกร่าง — ทำเองตรงๆ.
</system-capability>`;

function runClaude(agent, prompt, opts = {}) {
  // Synchronous task id (callers use it immediately); the spawn — and the
  // one-time compaction summary it may await — runs in startClaudeRun so the
  // public contract stays synchronous.
  const task = "t" + ++taskCounter;
  startClaudeRun(agent, prompt, opts, task)
    .catch((e) => {
      console.error("[runClaude]", e && e.message);
      // 💾 callers holding state on this dispatch (e.g. /runs/resume) must
      // hear about an async setup failure — the task id alone says nothing.
      if (opts.onStartFailed) try { opts.onStartFailed(e); } catch {}
    });
  return task;
}
async function startClaudeRun(agent, prompt, opts, task) {

  // 🛡 Governance choke point: only roster members may run. Every dispatch
  // route (chat / delegate / jobs / plugins / runs-resume) funnels through
  // here, so an id that never passed CEO approval (npc.request →
  // /npc/decision) is rejected before it gets a session, a sprite event or a
  // usage row — the "?????" rogue ran exactly through this gap. Ghost clones
  // (parent#n) inherit the parent's approval.
  const rosterBase = String(agent || "").split("#")[0];
  if (!reg.agents[rosterBase]) {
    broadcast({ type: "chat.message", agent: "main", watchdog: true,
      text: "🛡 ปฏิเสธงานของ agent นอก roster: \"" + String(agent).slice(0, 40) +
        "\" — ต้องผ่านการอนุมัติ CEO ก่อน (npc.request → /npc/decision)" });
    throw new Error("unknown agent (not in roster): " + String(agent).slice(0, 40));
  }

  // Session resolution: explicit key > latest > fresh. Fresh threads are
  // created up-front so their history records from the very first message.
  let entry = null;
  let isNew = false;
  if (opts.session && opts.session !== "new")
    entry = (sess[agent] || []).find((e) => e.key === opts.session);
  else if (!opts.session) entry = latestSession(agent);
  if (!entry) {
    entry = { key: "s" + Date.now(), sid: null, ts: Date.now(),
      title: String(opts.logPrompt || prompt).replace(/\s+/g, " ").slice(0, 48), log: [] };
    sess[agent] = sess[agent] || [];
    sess[agent].push(entry);
    isNew = true;
  }
  // Project binding: a requested project claims new threads — and adopts
  // existing ones that were never bound. Threads keep their home after.
  // A stale binding (project unregistered/recreated) heals instead of
  // silently dropping the run back into the workspace.
  if (entry.proj && !projectDir(entry.proj)) entry.proj = null;
  // Mentioning a DIFFERENT project than this thread's home forks a fresh
  // thread there — the work must genuinely run inside the named project
  // (same rule delegates already follow), never cross-write from afar.
  if (!isNew && opts.project && projectDir(opts.project) &&
      entry.proj && entry.proj !== opts.project) {
    entry = { key: "s" + Date.now(), sid: null, ts: Date.now(),
      title: String(opts.logPrompt || prompt).replace(/\s+/g, " ").slice(0, 48), log: [] };
    sess[agent].push(entry);
    isNew = true;
  }
  if (opts.project && projectDir(opts.project) && (isNew || !entry.proj))
    entry.proj = opts.project;
  // 🏠 Still homeless? Adopt the office's own registered root project. This is
  // also the lazy migration for historical "Default" threads: their first run
  // after this change binds them here for good. Only when no home project is
  // registered at all does the old WORKSPACE fallback below still apply.
  if (!entry.proj) {
    const home = homeProjectId();
    if (home) entry.proj = home;
  }
  const projId = entry.proj && projectDir(entry.proj) ? entry.proj : null;
  const cwd = projId ? projectDir(projId) : WORKSPACE;
  if (projId) ensureTrusted(cwd);
  // claude sessions are PER-DIRECTORY: a sid born in another cwd cannot be
  // resumed here. Ground truth beats bookkeeping — check the actual session
  // file under this cwd; missing means a fresh claude session here (our own
  // thread log keeps the visible history).
  if (entry.sid) {
    const enc = String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    const sidFile = path.join(require("os").homedir(), ".claude", "projects",
      enc, entry.sid + ".jsonl");
    if (!fs.existsSync(sidFile)) entry.sid = null;
  }
  // 🧵 Compaction gate: an over-long RESUMED thread re-caches its whole history
  // every turn. Cross the threshold → summarize once (Haiku), drop the sid (so
  // the --resume below is skipped → fresh claude session), and hand a short
  // carryover to it. entry.key + entry.log stay intact so the CEO's thread view
  // is unbroken. Never throws — a failed summary falls back to the raw log.
  let isFresh = isNew;
  if (entry && !isNew && entry.sid && needsCompaction(entry)) {
    let carry = "";
    try { carry = await summarizeThread(entry); }
    catch (e) { console.error("[compact]", e && e.message); }
    if (!carry) carry = fallbackCarryover(entry);
    entry.carryover = carry;
    // Snapshot the summary to Postgres BEFORE dropping the sid, so a daemon
    // restart between compaction and the next run can recover it at boot.
    if (db) db.saveOrchContext({ sessionId: entry.key, turn: entry.turns,
      summary: carry, tokenCount: entry.tokens }).catch(() => {});
    entry.sid = null;
    entry.turns = 0;
    entry.tokens = 0;
    isFresh = true;
    saveSess();
    broadcast({ type: "thread.compacted", agent, session: entry.key }, false);
  }
  if (projId) {
    projRuns[projId] = (projRuns[projId] || 0) + 1;
    projAgents[projId] = projAgents[projId] || {};
    projAgents[projId][agent] = (projAgents[projId][agent] || 0) + 1;
    broadcast({ type: "projects.changed" }, false);
  }
  entry.log = entry.log || [];
  entry.log.push({ who: "you", text: String(opts.logPrompt || prompt).slice(0, 4000), ts: Date.now() });
  while (entry.log.length > 200) entry.log.shift();
  saveSess();
  if (opts.onEntry) try { opts.onEntry(entry.key); } catch {}

  broadcast({ type: "task.started", agent, task, session: entry.key,
    // The overlay's NOW-WORKING strip needs to SAY what the work is.
    title: String(opts.logPrompt || prompt).replace(/\s+/g, " ").slice(0, 90) });
  // Resolve the spawn model up-front (same order the spawn below uses) so the
  // Live Log / Hub knows which Claude this run is on from the very first event.
  const model = effectiveModel(agent, opts);
  activityStart(agent, task, opts.logPrompt || prompt, projId, model);   // 📡 Live Log
  statBump("runs", agent);

  // Persona + assigned skills ride in a stdin preamble (robust across
  // Windows shell quoting); resumed sessions already carry it in context.
  const a = reg.agents[agent];
  const picked = a && a.tools && a.tools.length ? a.tools : ["Read", "Glob", "Grep"];
  // "mcp:<name>" entries become a real --mcp-config + server-level allow rule.
  const mcpNames = picked.filter((t) => t.startsWith("mcp:"))
    .map((t) => t.slice(4)).filter((n) => reg.mcpServers[n]);
  let tools = picked.filter((t) => !t.startsWith("mcp:")).join(",");
  let mcpConfig = null;
  if (mcpNames.length) {
    const conf = { mcpServers: {} };
    for (const n of mcpNames) {
      const parts = String(reg.mcpServers[n].command).trim().split(/\s+/);
      conf.mcpServers[n] = { command: parts[0], args: parts.slice(1) };
    }
    mcpConfig = path.join(__dirname, `mcp_${agent.replace(/[^\w-]/g, "_")}.json`);
    fs.writeFileSync(mcpConfig, JSON.stringify(conf));
    tools += (tools ? "," : "") + mcpNames.map((n) => `mcp__${n}`).join(",");
  }
  // Native skills (P3): deliver skills as real Claude Code Skill files disclosed
  // on demand via --add-dir, instead of inlining every body here. Reversible via
  // reg.nativeSkills = false.
  const nativeSkills = reg.nativeSkills !== false;
  let preamble = "";
  if (isFresh && a && (a.prompt || a.persona || (a.skills || []).length)) {
    preamble = `<persona>\nYou are "${a.name}" (${a.role}).\n${personaText(a)}\n`;
    if (!nativeSkills) for (const sid of a.skills || []) {
      const sk = reg.skills[sid];
      if (sk) preamble += `\n<skill name="${sk.name}">\n${sk.content}\n</skill>\n`;
    }
    preamble += `\nกระดานโน้ตกลางของออฟฟิศ: ไฟล์ notes.md ใน workspace — ` +
      `อ่านได้ และเพิ่มบรรทัด "- ข้อความ" เพื่อฝากโน้ตถึง CEO ได้\n`;
    preamble += memoryNote(agent, prompt, projId);
    preamble += "</persona>\n\n";
  }
  // 🧵 Carryover from a just-compacted thread → seed the fresh session so it
  // continues seamlessly. Injected once (consumed here) regardless of persona.
  if (isFresh && entry.carryover) {
    preamble += `\n<context-carryover>\nต่อเนื่องจากงานเดิม (เธรดถูกย่อเพื่อประหยัด token):\n` +
      `${entry.carryover}\n</context-carryover>\n\n`;
    delete entry.carryover;
  }

  // Run-level state that must SURVIVE a 403-fallback re-spawn: fire-once flags,
  // the models already attempted, and the original start time. The spawn + all
  // its handlers live inside launchAttempt(model) so a model-denied exit can
  // relaunch on an entitled fallback while keeping ONE task id and ONE onDone.
  const _shared = { doneFired: false, onStartedFired: false, modelFellBack: false };
  const triedModels = new Set([model].filter(Boolean));
  const runStartedAt = (activeRuns.get(task) || { startedAt: Date.now() }).startedAt;
  function launchAttempt(spawnModel) {
  const args = ["-p", "--output-format", "stream-json", "--verbose",
    "--allowedTools", tools,
    // The permission-broker hooks live in the workspace settings; agents
    // now run inside PROJECT directories, so the settings must travel
    // explicitly or the Security Center goes silent.
    "--settings", path.join(WORKSPACE, ".claude", "settings.json")];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  // Native skills: refresh this agent's SKILL.md files (hash-gated) and expose
  // them to the session — progressive disclosure, so bodies never hit the prompt.
  if (nativeSkills) {
    try {
      skillsSync.syncAgent(AGENTS_DIR, agent, (a && a.skills) || [], reg.skills);
      args.push("--add-dir", skillsSync.agentDir(AGENTS_DIR, agent));
    } catch (e) { console.error("[skills] sync:", e.message); }
  }
  if (entry && entry.sid) args.push("--resume", entry.sid);
  // Model for THIS attempt: the resolved one on the first try, or an entitled
  // fallback after a 403 (see the close handler below). null = CLI default.
  if (spawnModel) args.push("--model", spawnModel);
  const child = spawn("claude", args.map(shArg), {
    cwd,
    shell: true,
    env: { ...process.env, ...(reg.apiKeys || {}), OFFICE_ADAPTER: "1", OFFICE_AGENT: agent, OFFICE_TASK: task },
  });
  // Track the run per project so the owner can stop it and take the project over.
  if (projId) {
    (projChildren[projId] = projChildren[projId] || new Set()).add(child);
    child.on("close", () => {
      const s = projChildren[projId];
      if (s) { s.delete(child); if (!s.size) delete projChildren[projId]; }
    });
  }
  // 💾 กันงานหายถาวร: mirror the run to disk with everything a resume needs.
  // startedAt copies the activeRuns row so disk and Live Log agree to the ms.
  // Persist with THIS attempt's model + pid: a crash mid-fallback must resume on
  // the entitled model, never the 403 one. runStartedAt keeps the runId stable.
  persistRunStart({ task, agent, label: opts.logPrompt || prompt, prompt,
    session: entry.key, project: projId, cwd, model: spawnModel, pid: child.pid,
    resumeChain: opts.resumeChain || 0, startedAt: runStartedAt });
  // Global child registry (projChildren only covers project-bound runs): the
  // forced-restart path must be able to kill EVERY live child, or Windows
  // orphans them past the handoff and the successor's auto-resume duplicates
  // their work.
  allRunChildren.set(task, child);
  child.on("close", () => allRunChildren.delete(task));
  // The split capability + project map ride on the wire only — never in
  // the chat log.
  const canSplit = !opts.noSub && !agent.includes("#");
  // 🗣 a voiced agent may SPEAK — rarely, as a gimmick, never every message.
  const canSpeak = reg.tts !== false && a && a.voice &&
    featuresMap().tts && !agent.includes("#");
  const VOICE_NOTE = canSpeak ? `

<voice-capability>
คุณมีเสียงพูดจริงในออฟฟิศ — ใช้เพิ่มสีสันได้. เมื่อมีบรรทัดสั้นๆ ที่ "พูดออกมาแล้วน่ารัก/
เป็นธรรมชาติ" (ทักทาย, ยืนยันสั้นๆ, ประกาศงานเสร็จ, สรุปหนึ่งประโยค) ให้จบคำตอบด้วยบรรทัด:
SPEAK: <ประโยคพูดสั้นๆ 1 ประโยค เป็นธรรมชาติ ภาษาเดียวกับเจ้าของ>
ทำได้บ่อยพอประมาณให้ออฟฟิศมีชีวิต แต่ "พูดสั้นเสมอ" — อย่าอ่านทั้งข้อความ.
ข้อยกเว้นเดียว: ถ้าเจ้าของสั่งให้อ่าน/รายงานด้วยเสียงแบบเต็มๆ ค่อยใส่เนื้อหายาวใน SPEAK ได้.
</voice-capability>` : "";
  // 💸 Token economy: SUB_NOTE + VOICE_NOTE are STATIC capability prompts. A
  // resumed claude session already carries them from turn 1, so re-sending
  // every turn just burns input tokens for no behavior change. Send them only
  // on a fresh session. (projectNote stays every turn — the project/place
  // registry is live state the agent must always see current.)
  // 🖼 Make agent-shared media show inline: the chat auto-renders any absolute
  // media path under the workspace/project as an image/video/audio player — so
  // agents must SEND THE PATH, not describe the location or paste a link. Ghost
  // sub-agents don't talk to the owner directly (the parent synthesizes) → skip.
  const MEDIA_NOTE = `

<media-capability>
ให้เจ้าของเห็น/ดู/ฟัง รูป-วิดีโอ-เสียง: พิมพ์ path เต็มของไฟล์ในบรรทัดของมันเอง
(ไฟล์ต้องอยู่ในโปรเจค/workspace) ออฟฟิศจะ render เป็นรูป/เครื่องเล่นในแชทเอง —
อย่าบอกแค่ที่อยู่ไฟล์ หรือแปะลิงก์ดาวน์โหลด.
</media-capability>`;
  const mediaNote = agent.includes("#") ? "" : MEDIA_NOTE;
  const capNotes = isFresh ? ((canSplit ? SUB_NOTE : "") + VOICE_NOTE + mediaNote) : "";
  // stdin errors can ALSO surface async on the stream (EPIPE after the child
  // died mid-write) — without this handler that's an uncaught 'error' event
  // that takes the whole daemon down. The close handler settles the books.
  child.stdin.on("error", (e) => console.error("[claude:stdin]", e && e.message));
  try {
    child.stdin.write(preamble + prompt + capNotes + projectNote());
    child.stdin.end();
  } catch (e) {
    // The child died before taking stdin — the stream/close handlers below
    // are NOT attached yet, so nothing else will settle the books: close the
    // activity + disk record here, then let runClaude's catch run the
    // caller's rollback (onStartFailed). The project counters were already
    // bumped above and releaseProj (defined below) is unreachable from here —
    // mirror its decrement inline or the project stays locked "working".
    persistRunResult(task, false);
    activityEnd(task);
    allRunChildren.delete(task);
    if (projId) {
      projRuns[projId] = Math.max(0, (projRuns[projId] || 1) - 1);
      const pa = projAgents[projId] || {};
      pa[agent] = Math.max(0, (pa[agent] || 1) - 1);
      if (!pa[agent]) delete pa[agent];
      broadcast({ type: "projects.changed" }, false);
    }
    throw e;
  }
  // 💾 dispatch is now durably handed off (record on disk, child fed) —
  // ONLY here may a caller release state it held against a failed start
  // (/runs/resume archives its interrupted record in this hook). May fire
  // SYNCHRONOUSLY inside the runClaude() call (no await on this path), so it
  // hands over the task id itself — the caller's own runClaude return value
  // may not be assigned yet.
  if (!_shared.onStartedFired) { _shared.onStartedFired = true;
    if (opts.onStarted) try { opts.onStarted(task); } catch (e) { console.error("[onStarted]", e); } }

  let buf = "";
  const acts = [];      // tool trail — feeds the auto-skill reflection
  const subTasks = [];  // SUB: lines collected from the reply
  let lastText = "";
  let sawResult = false;   // a `result` line landed — the run REALLY ran
  // opts.onDone(finalText, ok) fires exactly once when this run truly ends —
  // if the agent splits, ownership passes to the synthesis run instead.
  const releaseProj = () => {
    if (!projId) return;
    projRuns[projId] = Math.max(0, (projRuns[projId] || 1) - 1);
    const pa = projAgents[projId] || {};
    pa[agent] = Math.max(0, (pa[agent] || 1) - 1);
    if (!pa[agent]) delete pa[agent];
    broadcast({ type: "projects.changed" }, false);
  };
  const fireDone = (text, ok) => {
    if (_shared.doneFired) return;
    _shared.doneFired = true;
    releaseProj();
    if (opts.onDone) try { opts.onDone(text, ok); } catch (e) { console.error("[onDone]", e); }
  };
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }

      if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
        for (const b of m.message.content) {
          if (b.type === "tool_use") {
            acts.push(b.name);
            // Tool calls belong to the conversation: a tiny "tool" entry in
            // the thread history + a session-tagged progress event.
            entry.log.push({ who: "tool", text: b.name, ts: Date.now() });
            while (entry.log.length > 200) entry.log.shift();
            saveSess();
            broadcast({ type: "task.progress", agent, task, tool: b.name,
              session: entry.key });
            // 📋 Process Step feed: same action, but WITH the detail (which
            // file/command/pattern) so the panel shows real progress, not just
            // a tool name. Additive — task.progress above is untouched.
            const detail = toolDetail(b.name, b.input);
            recordStep(task, agent, b.name, detail, entry.key);
            activityTool(task, b.name, detail);   // 📡 Live Log: what it's doing now
          } else if (b.type === "text" && b.text.trim()) {
            lastText = b.text;
            let raw = b.text;
            // `SPEAK:` lines become actual spoken audio (TTS) — strip from
            // the chat and let the overlay voice them.
            if (canSpeak && /(^|\n)\s*SPEAK:/.test(raw)) {
              const kept = [], say = [];
              for (const ln of raw.split("\n")) {
                const sm = ln.match(/^\s*SPEAK:\s*(.+)$/);
                if (sm && sm[1].trim()) say.push(sm[1].trim());
                else kept.push(ln);
              }
              if (say.length) {
                raw = kept.join("\n").trim();
                broadcast({ type: "voice.say", agent, task,
                  text: say.join(" ").slice(0, 1200), session: entry.key });
              }
            }
            // `SUB:` lines are protocol, not prose — strip them and show a
            // friendly split announcement instead.
            if (canSplit && /(^|\n)\s*SUB:/.test(raw)) {
              const kept = [], found = [];
              for (const ln of raw.split("\n")) {
                const sm = ln.match(/^\s*SUB:\s*(.+)$/);
                if (sm && sm[1].trim()) found.push(sm[1].trim());
                else kept.push(ln);
              }
              if (found.length) {
                subTasks.push(...found);
                raw = (kept.join("\n").trim() +
                  `\n\n👻 แตกร่าง ${found.length} sub-agents:\n` +
                  found.map((t, i) => `${i + 1}. ${t.slice(0, 80)}`).join("\n")).trim();
              }
            }
            const out = opts.filterText ? opts.filterText(raw) : raw;
            if (out) {
              entry.log.push({ who: "agent", text: String(out).slice(0, 8000), ts: Date.now() });
              while (entry.log.length > 200) entry.log.shift();
              saveSess();
              broadcast({ type: "chat.message", agent, task, text: out, session: entry.key });
            }
          }
        }
      } else if (m.type === "result") {
        sawResult = true;
        // Session bookkeeping: remember the thread we just extended (and
        // which directory that claude session lives in).
        if (m.session_id) {
          entry.sid = m.session_id;
          entry.ts = Date.now();
          saveSess();
        }
        // 🧵 Track thread size for the compaction gate: count turns + the
        // tokens this turn actually moved (input + output + cache_creation —
        // cache_read is the cheap replay we're trying to KILL, so it's the
        // signal, not part of the "fresh" cost we budget against).
        {
          const u = m.usage || {};
          const used = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0) +
            (Number(u.cache_creation_input_tokens) || 0);
          entry.turns = (entry.turns || 0) + 1;
          entry.tokens = (entry.tokens || 0) + used;
          saveSess();
        }
        broadcast({ type: m.is_error ? "task.failed" : "task.completed",
          agent, task, session: entry.key });
        persistRunResult(task, !m.is_error);   // 💾 final status before close
        statBump(m.is_error ? "failed" : "done", null, Number(m.total_cost_usd) || 0);
        // 💸 per-process token footprint (CEO's token-waste watch).
        recordProcessUsage(agent, task, opts.logPrompt || prompt,
          m.usage, Number(m.total_cost_usd) || 0);
        // 🗣 Voice Lines: real work finished → say it in character. System
        // passes (heartbeat/reminders/social use noSub) stay silent.
        if (!m.is_error && !opts.noSub) voiceAnnounce(agent);
        if (!m.is_error && subTasks.length) {
          _shared.doneFired = true;  // the synthesis run inherits the callback
          releaseProj();
          runSubAgents(agent, entry, subTasks.slice(0, 4), opts.onDone);
        } else {
          fireDone(lastText, !m.is_error);
          if (!m.is_error) maybeLearnSkill(agent, task, prompt, acts, lastText, projId);
        }
      }
    }
  });
  let stderrBuf = "";   // bounded tail of the child's stderr — read on close to spot a 403
  child.stderr.on("data", (c) => {
    const s = c.toString();
    stderrBuf = (stderrBuf + s).slice(-4000);
    console.error("[claude]", s.trim());
  });
  let failNotified = false;   // error+close both fire — warn/rollback ONCE
  child.on("error", (e) => {
    failNotified = true;
    broadcast({ type: "task.failed", agent, task });
    broadcast({ type: "chat.message", agent, task, text: "⚠️ ระบบขัดข้อง เรียก agent ไม่สำเร็จ: " + e.message });
    persistRunResult(task, false);   // 💾 spawn failure = failed, not "ended"
    // 💾 process-level failure (spawn/ENOENT — NOT a non-zero exit): the
    // dispatch never really ran, so a holding caller (/runs/resume) gets its
    // rollback even though onStarted already fired. Rollback is idempotent.
    if (opts.onStartFailed) try { opts.onStartFailed(e); } catch {}
    activityEnd(task);
    fireDone("", false);
  });
  child.on("close", () => {
    // Cut down by the bounded-restart path: the daemon is about to hand off,
    // and this run's disk record must STAY "running" so the successor's boot
    // triage interrupts + auto-resumes it. No archiving, no callbacks — the
    // process is exiting.
    if (child._restartCut) { activeRuns.delete(task); return; }
    // 🚑 Died without ever emitting a `result`, and stderr smells like a model
    // entitlement denial → retry ONCE on an entitled fallback model. Loud, never
    // silent: a feed warning names the swap. This is the brick-guard for the
    // exact failure that took the whole office down (fable-5 as the default).
    // _ownerStopped: a deliberate Force-หยุด/stopwork kill must NEVER relaunch —
    // taskkill stderr could otherwise smell like a 403 and resurrect the run.
    if (!sawResult && !failNotified && !child._ownerStopped && !_shared.modelFellBack && looksLikeModelDenied(stderrBuf)) {
      const next = fallbackModelAfter(spawnModel, triedModels);
      if (next) {
        _shared.modelFellBack = true;
        triedModels.add(next);
        const fromLbl = modelLabelOf(spawnModel) || spawnModel || "CLI default";
        const toLbl = modelLabelOf(next) || next;
        const who = (reg.agents[agent] || {}).name || agent;
        broadcast({ type: "chat.message", agent, task, watchdog: true,
          text: `⚠️ ${who}: โมเดล ${fromLbl} ใช้ไม่ได้ (403/ไม่มีสิทธิ์) — สลับไป ${toLbl} อัตโนมัติ`,
          session: entry.key });
        const ar = activeRuns.get(task);
        if (ar) { ar.model = next; ar.modelLabel = modelLabelOf(next);
          broadcastActivity(); broadcastAgentStatus(); }
        try { launchAttempt(next); }
        catch (e) {
          console.error("[model-fallback]", e && e.message);
          broadcast({ type: "task.failed", agent, task });
          persistRunResult(task, false); activityEnd(task); fireDone("", false);
        }
        return;
      }
      // chain exhausted → fall through and report the real failure below.
    }
    // Exited without ever emitting a `result` (shell:true swallows spawn
    // problems into a plain close — missing CLI, bad command, instant crash):
    // the dispatch never really ran, so a holding caller (/runs/resume) gets
    // its rollback here too, not just on the `error` event. Idempotent.
    // EXCEPT an owner-initiated kill (/projects/stopwork) — that's a verdict,
    // not a failure: the record closes as "stopped" and stays closed.
    if (!sawResult && child._ownerStopped) {
      const rec = runsState.live[task];
      if (rec) { rec.status = "stopped"; saveRuns(true); }
    } else if (!sawResult && !failNotified) {
      // Mirror the `error` path's signals — the UI must hear about a run
      // that died without a result, not just the persistence layer.
      broadcast({ type: "task.failed", agent, task });
      broadcast({ type: "chat.message", agent, task,
        text: "⚠️ run จบโดยไม่มีผลลัพธ์ (process ดับก่อนส่ง result) — บันทึกเป็น failed" });
      persistRunResult(task, false);
      if (opts.onStartFailed) try {
        opts.onStartFailed(new Error("claude exited without a result"));
      } catch {}
    }
    activityEnd(task);
    // No `result` = the run did NOT finish, whatever text leaked out first —
    // callers (DELEGATE report-back, /chat?wait, channels) must see ok=false
    // in lockstep with the failed/stopped status persistence just recorded.
    fireDone(lastText, sawResult && !!lastText);
  });
  }   // end launchAttempt — re-entered once on a 403 with a downgraded model
  launchAttempt(model);
  return task;
}

// ---------------------------------------------------------------- ceo flow
// Talking to the CEO is the gimmick chain-of-command: the Director (main)
// walks over, takes the order, replies with a plan, and may delegate via
// `DELEGATE: <agent_id> :: <instruction>` lines — each spawns a real
// session for that agent (plus a little walk in the world).
// name + role only (the Director reads GET /registry for the full picture) and
// memoized — this is re-injected on every CEO order / delegation report.
let _teamListCache = null, _teamListKey = "";
function teamList() {
  const ids = Object.keys(reg.agents).filter((id) => id !== "ceo" && id !== "main").sort();
  const key = ids.map((id) => `${id}:${reg.agents[id].name}:${reg.agents[id].role}`).join("|");
  if (_teamListKey === key && _teamListCache != null) return _teamListCache;
  _teamListKey = key;
  _teamListCache = ids.map((id) => `- ${id}: ${reg.agents[id].name}, ${reg.agents[id].role}`)
    .join("\n") || "(no other staff yet)";
  return _teamListCache;
}

// The Director can delegate from ANY conversation — talking to him directly
// in his own pane works exactly like an order through the CEO.
function directorNote() {
  const places = Object.entries(reg.places)
    .map(([n, f]) => `  - "${n}" → ${f}`).join("\n") || "  (ยังไม่มี — ผู้ใช้ตั้งได้ใน 🗂)";
  const projList = projects.slice(-8)
    .map((p) => `  - ${p.name} → ${p.dir}`).join("\n") || "  (ยังไม่มี)";
  return `

<system-capability>
You are the Director. Your team:
${teamList()}
To hand work to a member, include a line EXACTLY in this format:
DELEGATE: <agent_id> :: <clear, self-contained instruction>
When the work belongs inside a registered project, ROUTE it explicitly:
DELEGATE: <agent_id> @ <project name> :: <instruction>
(the member then runs INSIDE that project's directory — its claude session
lives there, the owner can resume it, and the project lights up as working).
One line per assignment — dispatched automatically; their result is reported
back to you when they finish, so you can answer questions or follow up.
IMPORTANT: prose like assigning work in words does NOTHING — only the
DELEGATE line dispatches work.

PROJECT SYSTEM — registered places (ชื่อย่อ → โฟลเดอร์):
${places}
Existing projects:
${projList}
เมื่อผู้ใช้สั่งสร้างโปรเจคใหม่ (เช่น "สร้างโปรเจค test ที่ห้องสมุด") คุณต้องสร้างเอง
ด้วยบรรทัด protocol นี้ (ระบบสร้าง+ลงทะเบียนให้ทันที):
PROJECT: <ชื่อโปรเจค> @ <ชื่อ place หรือ full path>
แล้วค่อยมอบงานแบบระบุโปรเจค: DELEGATE: <agent_id> @ <ชื่อโปรเจค> :: <งาน>
สำคัญมาก: ห้ามสั่งให้สมาชิกไปสร้างโปรเจคเอง และห้ามทำงานของโปรเจคนอกบรรทัด DELEGATE @ —
ไม่งั้นงานจะไม่ได้รันอยู่ "ข้างใน" โปรเจคจริงๆ (เจ้าของ resume session ต่อไม่ได้).
ห้ามสร้างโปรเจคเองโดยผู้ใช้ไม่ได้สั่ง
</system-capability>`;
}

function ceoFlow(prompt, session, project, opts = {}) {
  broadcast({ type: "ceo.summon", agent: "main" });
  // Mirror app/CLI CEO conversations out to connected channels (#121). NOT set
  // for channel-origin turns — their reply already rides back, so relaying would
  // echo. Guarded so it's a no-op without a connected channel.
  if (opts.relay) try { channels.relay("👤 " + prompt); } catch {}
  const wrapped =
    `The owner (CEO) has called you over and given this order in person:\n` +
    `"""${prompt}"""\n\n` +
    `Your team:\n${teamList()}\n\n` +
    `Decide how to execute. For anything a team member should own, include a line:\n` +
    `DELEGATE: <agent_id> :: <clear instruction for them>\n` +
    `(exact format, one per assignment — these are dispatched automatically, and ` +
    `each member's result will be REPORTED BACK to you when they finish. ` +
    `Prose alone dispatches NOTHING — only DELEGATE lines do). ` +
    `Anything not delegated you handle yourself. Reply to the owner with a short ` +
    `plan in the language they used.` + directorNote();
  return runClaude("main", wrapped, {
    session,
    project,
    logPrompt: opts.logPrompt || ("👑 (CEO) " + prompt),
    filterText: makeDelegateFilter(0, session),
    onDone: (out, ok) => {
      if (opts.relay && ok && out) try { channels.relay("👑 " + out); } catch {}
      if (opts.onDone) opts.onDone(out, ok);   // channels/CLI hook the reply ride-back here
    },
  });
}

// ---------------------------------------------------------------- report-back
// Delegation is a ROUND TRIP: when a delegate finishes (or asks something
// back), its final text is fed to the Director, who may answer / follow up
// via more DELEGATE lines (bounded depth), and finally writes the summary
// the CEO actually reads. Director turns are serialized — two parallel
// --resume forks of one thread would race its history.

const dirQueue = [];
let dirBusy = false;
function queueDirectorTurn(start) {
  dirQueue.push(start);
  pumpDirector();
}
function pumpDirector() {
  if (dirBusy || !dirQueue.length) return;
  dirBusy = true;
  dirQueue.shift()(() => { dirBusy = false; pumpDirector(); });
}

// DELEGATE:-line parser shared by the CEO order and every report-back turn.
// onHit fires per dispatched assignment ("did he hand off more work?").
function makeDelegateFilter(depth, session, onHit) {
  // 💸 Dedup guard: this filter runs on EVERY streamed text block of a single
  // Director turn. A model that restates a `DELEGATE:` line (or a turn that
  // streams the same block twice) would otherwise dispatch the SAME assignment
  // more than once → two full agent sessions doing identical work = doubled
  // tokens. One dispatch per (target :: instruction) signature per turn.
  const dispatched = new Set();
  return (text) => {
    const keep = [];
    for (const ln of String(text).split("\n")) {
      // PROJECT: <name> @ <place ชื่อย่อ | full path> — the Director creates
      // and registers a project HIMSELF, daemon-side, before any DELEGATE in
      // the same reply dispatches. This is how new work gets a real home:
      // the assignee then runs INSIDE that directory from its first message.
      const pj = ln.match(/^\s*PROJECT:\s*(.+?)\s*@\s*(.+?)\s*$/);
      if (pj) {
        const nm = pj[1].trim(), loc = pj[2].trim();
        try {
          const proj = reg.places[loc] ? createProject(nm, loc, "")
            : createProject(nm, "", loc);
          keep.push(`📁 สร้างโปรเจค "${proj.name}" แล้ว → ${proj.dir}`);
        } catch (e) {
          // Already registered = fine (idempotent for routing); real errors show.
          if (projectByName(nm)) keep.push(`📁 โปรเจค "${nm}" มีอยู่แล้ว — ใช้ตัวเดิม`);
          else keep.push(`📁⚠️ สร้างโปรเจค "${nm}" ไม่สำเร็จ: ${e.message}`);
        }
        continue;
      }
      // DELEGATE: <agent> :: <job>   — or, routed into a workspace:
      // DELEGATE: <agent> @ <project name> :: <job>
      const m = ln.match(/^\s*DELEGATE:\s*([^:@]+?)(?:\s*@\s*([^:]+?))?\s*::\s*(.+)$/);
      // Accept the agent id OR its display name (models love names).
      let tgt = null;
      if (m) {
        const key = m[1].trim();
        tgt = reg.agents[key] ? key
          : Object.keys(reg.agents).find((id) =>
              (reg.agents[id].name || "").toLowerCase() === key.toLowerCase());
      }
      if (tgt && tgt !== "ceo" && tgt !== "main") {
        const inst = m[3];
        // Already dispatched this exact assignment in this turn? Drop the
        // duplicate line silently — no second agent run, no doubled tokens.
        const sig = tgt + " :: " + inst.trim();
        if (dispatched.has(sig)) continue;
        dispatched.add(sig);
        broadcast({ type: "task.delegated", agent: "main", target: tgt });
        if (onHit) onHit();
        const t = tgt;
        const projName = m[2];
        // 🟢 Status flips to "working" at dispatch time — the hand-over walk
        // (4.5s below) should already show the assignee as busy. The project
        // here is best-effort (explicit `@ name` only); activityStart corrects
        // it once the run actually starts.
        pendingDelegate.set(t, {
          project: (projName && projectByName(projName)) ? projName.trim() : null,
          task: inst.trim().replace(/\s+/g, " ").slice(0, 90), ts: Date.now() });
        broadcastAgentStatus();
        // Dispatch AFTER the hand-over walk — and resolve the project then,
        // so a PROJECT: line earlier in this very reply has taken effect.
        setTimeout(() => {
          // Project routing: explicit `@ project` wins; then the ASSIGNEE's own
          // workspace (their latest thread) beats the Director's — a project-less
          // delegation must NOT drag a member who already lives in tookjorThai
          // into the Director's bagidea; only then fall back to the Director's
          // workspace / prompt / home. A target whose thread lives elsewhere
          // than the resolved project gets a fresh one.
          const ml = sess["main"] || [];
          const me = session ? ml.find((x) => x.key === session)
            : (ml.length ? ml.reduce((a, b) => (a.ts > b.ts ? a : b)) : null);
          const tl0 = sess[t] || [];
          const te0 = tl0.length ? tl0.reduce((a, b) => (a.ts > b.ts ? a : b)) : null;
          const proj = (projName && projectByName(projName)) || (te0 && te0.proj) ||
            (me && me.proj) || projectFromPrompt(inst) || homeProjectId();
          // LOCK (reverse): if the owner has this project's window open, an
          // agent must NOT enter it — report back so the Director re-plans
          // (and the two never collide inside one working tree).
          if (proj && projWin[proj]) {
            pendingDelegate.delete(t);   // dispatch refused → back to idle
            broadcastAgentStatus();
            reportToMain(t, `โปรเจค "${projName || proj}" เจ้าของกำลังเปิดทำงานอยู่ — ` +
              `เข้าไปทำตอนนี้ไม่ได้ รอจนเจ้าของปิดหน้าต่างก่อน`, false, depth, session);
            return;
          }
          // 🧠 pre-work via the Auto-Scan gate: a never-scanned project gets
          // its Brain built BEFORE the assignee's session starts (queued behind
          // the auto-fired scan; FE sees ws scan.gate) so PROJECT_BRAIN.md and
          // the MCP cache exist from the agent's first message.
          const launchDelegate = () => {
            const tl = sess[t] || [];
            const te = tl.length ? tl.reduce((a, b) => (a.ts > b.ts ? a : b)) : null;
            runClaude(t, inst, {
              project: proj,
              session: proj && (!te || te.proj !== proj) ? "new" : undefined,
              onDone: (out, ok) => {
                // 🧠 post-work: the job changed the tree — refresh the Brain
                // before the report walks back (never blocks it; see helper).
                if (proj) autoScanBrain(proj, "post-work");
                // 🧑‍⚖️ a successful project-bound delegation IS a delivery →
                // run the Codex review gate (fail bounces back to THIS agent
                // with reasons/fixes; max-rounds + passby handled downstream).
                if (ok && proj) maybeReviewGate({ agent: t, project: proj });
                reportToMain(t, out, ok, depth, session);
              },
            });
          };
          if (proj) gateOnScan(resolveProjectRef(proj), launchDelegate);
          else launchDelegate();
        }, 4500);
      } else keep.push(ln);
    }
    return keep.join("\n").trim();
  };
}

function reportToMain(fromId, text, ok, depth, session) {
  const a = reg.agents[fromId] || { name: fromId };
  const wrapped =
    `Report back from your team member ${a.name} (${fromId})` +
    (ok ? "" : " — THE TASK FAILED") + `:\n` +
    `"""${String(text || "(no result)").slice(0, 6000)}"""\n\n` +
    (depth < 2
      ? `If they asked you a question or something is missing, answer / follow ` +
        `up with a line: DELEGATE: ${fromId} :: <your answer or next instruction> ` +
        `(exact format — it resumes their session with full context). ` +
        `If the work is complete, write the final summary for the owner (CEO): ` +
        `clear, concrete, in the language of the original order.`
      : `Write the final summary for the owner (CEO) now — clear, concrete, in ` +
        `the language of the original order. Do not delegate further.`);
  queueDirectorTurn((release) => {
    let delegatedMore = false;
    runClaude("main", wrapped, {
      session,
      noSub: true,
      logPrompt: `📨 รายงานผลจาก ${a.name}`,
      filterText: depth < 2
        ? makeDelegateFilter(depth + 1, session, () => { delegatedMore = true; })
        : undefined,
      onDone: (_finalText, fOk) => {
        release();
        // No further hand-offs → that WAS the summary: walk it to the boss.
        if (!delegatedMore && fOk)
          broadcast({ type: "ceo.report", agent: "main" });
      },
    });
  });
}

// Signature of a project's working tree (`git status --porcelain`). Used to
// tell a real deliverable from a pure chat: identical sig before/after a run =
// nothing changed on disk. null when the dir isn't a git repo or git can't run
// — callers treat null as "can't prove a change" and stay silent.
function gitTreeSig(dir) {
  if (!dir) return null;
  try {
    const r = spawnSync("git", ["-C", dir, "status", "--porcelain"],
      { encoding: "utf8", windowsHide: true, timeout: 8000 });
    return r.status === 0 ? String(r.stdout || "") : null;
  } catch { return null; }
}

// 📨 Report-back for DIRECT orders (CEO → agent chat, bypassing DELEGATE).
// DELEGATE'd work walks home through reportToMain; a direct order had no path
// back, so the CEO had to open the agent thread to read the result (the exact
// gap reported). If the run actually CHANGED the project tree (a real
// deliverable, not a Q&A), drop a short summary card into the Director feed and
// ping the CEO view (ceo.report). Both are display-only broadcasts: they never
// spawn main and never touch the agent's session/onDone, so the worker isn't
// interrupted. Tree unchanged / unreadable / no project → stay silent.
function reportDirectWork(agentId, projectRef, order, resultText, dir, baseSig) {
  const rpid = resolveProjectRef(projectRef);
  const nowSig = gitTreeSig(dir);
  // Only a confirmed change counts. baseSig null (couldn't read at start) →
  // can't prove THIS run did it → stay silent rather than cry wolf.
  if (baseSig === null || nowSig === null || nowSig === baseSig) return;
  const name = (reg.agents[agentId] || {}).name || agentId;
  const files = nowSig.split("\n").map((s) => s.slice(3).trim())
    .filter(Boolean).slice(0, 8);
  const summary = String(resultText || "").trim().replace(/\s+/g, " ").slice(0, 400);
  const ord = String(order || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const card =
    "📨 สรุปงาน (สั่งตรง) — " + name + (rpid ? " · " + rpid : "") + "\n" +
    "🗒️ คำสั่ง: " + (ord || "-") + "\n" +
    "✅ ผล: " + (summary || "(เสร็จแล้ว)") + "\n" +
    (files.length ? "📂 ไฟล์ที่แตะ: " + files.join(", ") + "\n" : "") +
    "→ เปิดแชท " + name + " เพื่อดูรายละเอียดเต็ม";
  broadcast({ type: "chat.message", agent: "main", watchdog: true,
    directReport: true, fromAgent: agentId, text: card });
  broadcast({ type: "ceo.report", agent: "main" });
}

// ---------------------------------------------------------------- sub-agents
// An agent that replied with SUB: lines fans out into parallel ghost clones.
// Each ghost gets its own labeled session in the "@sub" bucket; when the
// last one reports back, the parent thread is resumed for a synthesis turn.

function runSubAgents(parentId, parentEntry, tasks, onDone) {
  const stamp = Date.now();
  broadcast({ type: "subagent.split", agent: parentId, count: tasks.length,
    session: parentEntry.key });
  const results = new Array(tasks.length).fill(null);
  let done = 0;
  tasks.forEach((t, i) => {
    const subId = parentId + "#s" + (i + 1);
    const entry = { key: "u" + stamp + "_" + i, sid: null, ts: Date.now(),
      title: t.replace(/\s+/g, " ").slice(0, 60), sub: true, parent: parentId,
      proj: parentEntry.proj,
      log: [{ who: "you", text: "👻 " + t, ts: Date.now() }] };
    sess["@sub"] = sess["@sub"] || [];
    sess["@sub"].push(entry);
    saveSess();
    // Slight stagger: the ghosts peel off one by one (and stay kind to the CPU).
    setTimeout(() => {
      broadcast({ type: "subagent.spawned", agent: parentId, sub: subId, n: i,
        text: t, session: entry.key });
      runSub(parentId, subId, t, entry, (text, ok) => {
        results[i] = { task: t, text, ok };
        entry.ok = ok;
        saveSess();
        broadcast({ type: "subagent.done", agent: parentId, sub: subId, n: i,
          ok, session: entry.key });
        if (++done === tasks.length) synthesize();
      });
    }, i * 1500);
  });
  function synthesize() {
    const okResults = results.filter((r) => r.ok && r.text);
    // Every ghost failed → nothing to synthesize. Don't burn a synthesis call;
    // hand the failure straight back so the Director can re-plan.
    if (!okResults.length) {
      if (onDone) try { onDone("(ทุก sub-agent ทำงานไม่สำเร็จ)", false); } catch {}
      return;
    }
    const failed = results.length - okResults.length;
    // Feed only the succeeded outputs (trims input, too).
    const report = okResults.map((r, i) => `--- SUB ${i + 1}: ${r.task}\n${r.text}`).join("\n\n") +
      (failed ? `\n\n(${failed} sub-agent ไม่สำเร็จ — ข้ามไป)` : "");
    runClaude(parentId,
      `All your sub-agents have reported back:\n\n${report}\n\n` +
      `Now synthesize the FINAL answer to the user's original request (earlier ` +
      `in this conversation), in the user's language. Complete but concise.`,
      { session: parentEntry.key, noSub: true, onDone,
        logPrompt: `👻 sub-agents ${tasks.length} ตัวรายงานผลครบแล้ว — สรุปผล` });
  }
}

// One ghost: a lean twin of runClaude. Pre-created "@sub" entry, parent's
// tools, no skills preamble, no resume, and never splits further.
function runSub(parentId, subId, taskText, entry, onDone) {
  const a = reg.agents[parentId] || { name: parentId, role: "พนักงาน" };
  const picked = a.tools && a.tools.length ? a.tools
    : ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
  const mcpNames = picked.filter((t) => t.startsWith("mcp:"))
    .map((t) => t.slice(4)).filter((n) => reg.mcpServers[n]);
  let tools = picked.filter((t) => !t.startsWith("mcp:")).join(",");
  let mcpConfig = null;
  if (mcpNames.length) {
    const conf = { mcpServers: {} };
    for (const n of mcpNames) {
      const parts = String(reg.mcpServers[n].command).trim().split(/\s+/);
      conf.mcpServers[n] = { command: parts[0], args: parts.slice(1) };
    }
    mcpConfig = path.join(__dirname, `mcp_${parentId.replace(/[^\w-]/g, "_")}_sub.json`);
    fs.writeFileSync(mcpConfig, JSON.stringify(conf));
    tools += (tools ? "," : "") + mcpNames.map((n) => `mcp__${n}`).join(",");
  }
  const baseArgs = ["-p", "--output-format", "stream-json", "--verbose",
    "--allowedTools", tools,
    "--settings", path.join(WORKSPACE, ".claude", "settings.json")];
  if (mcpConfig) baseArgs.push("--mcp-config", mcpConfig);
  // Ghosts inherit the parent's native skills (additive — ghosts had none before).
  if (reg.nativeSkills !== false) {
    try {
      skillsSync.syncAgent(AGENTS_DIR, parentId, (a.skills) || [], reg.skills);
      baseArgs.push("--add-dir", skillsSync.agentDir(AGENTS_DIR, parentId));
    } catch {}
  }
  // Ghosts work where their parent works (project-bound threads included).
  const subCwd = (entry.proj && projectDir(entry.proj)) || WORKSPACE;
  // The job preamble is identical across attempts (re-sent on a 403 fallback).
  const subStdin =
    `You are a temporary SUB-AGENT — a parallel clone of "${a.name}" (${a.role}) ` +
    `at this AI office.` +
    (a.prompt ? `\nParent persona:\n${a.prompt}\n` : "\n") +
    `You were split off for ONE focused job. Do it fast and directly; your final ` +
    `message must BE the result (data, findings, answer) — no meta talk, no asking ` +
    `back. Reply in the language of the job. Never split further.\n\nJOB: ${taskText}`;
  let lastText = "", finished = false, subFellBack = false, activeChild = null;
  const triedModels = new Set();
  const finish = (ok) => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    onDone(lastText, ok);
  };
  // Ghosts are short-lived by contract — a stuck one is reaped, its slot
  // reported as failed, so the parent's synthesis always happens. The watchdog
  // kills whichever child is live NOW (a fallback re-spawn replaces it).
  const watchdog = setTimeout(() => {
    if (activeChild) {
      try {
        if (process.platform === "win32")
          spawn("taskkill", ["/pid", String(activeChild.pid), "/T", "/F"], { shell: true });
        else activeChild.kill("SIGKILL");
      } catch {}
    }
    finish(false);
  }, 6 * 60000);
  // 💸 Ghosts are CAPPED to Sonnet (capGhostModel): a 5-way fan-out of an Opus
  // agent must not cost 5× Opus. (They spawn here, NOT through startClaudeRun,
  // so the cap is applied explicitly.) On a 403 they fall back ONCE — same
  // brick-guard as runClaude, so an entitlement gap can't silently kill a split.
  function launchSub(spawnModel) {
    const args = baseArgs.slice();
    if (spawnModel) args.push("--model", spawnModel);
    triedModels.add(spawnModel);
    const child = spawn("claude", args.map(shArg), {
      cwd: subCwd, shell: true,
      env: { ...process.env, ...(reg.apiKeys || {}), OFFICE_ADAPTER: "1", OFFICE_AGENT: subId, OFFICE_TASK: entry.key },
    });
    activeChild = child;
    child.stdin.write(subStdin);
    child.stdin.end();
    let buf = "", stderrBuf = "";
    child.stdout.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
          for (const b of m.message.content) {
            if (b.type === "tool_use") {
              entry.log.push({ who: "tool", text: b.name, ts: Date.now() });
              while (entry.log.length > 200) entry.log.shift();
              saveSess();
              broadcast({ type: "subagent.progress", agent: parentId, sub: subId,
                tool: b.name, session: entry.key });
            } else if (b.type === "text" && b.text.trim()) {
              lastText = b.text;
              entry.log.push({ who: "agent", text: b.text.slice(0, 8000), ts: Date.now() });
              while (entry.log.length > 200) entry.log.shift();
              entry.ts = Date.now();
              saveSess();
              broadcast({ type: "chat.message", agent: parentId, sub: subId,
                text: b.text, session: entry.key });
            }
          }
        } else if (m.type === "result") {
          if (m.session_id) { entry.sid = m.session_id; saveSess(); }
          statBump(m.is_error ? "failed" : "done", null, Number(m.total_cost_usd) || 0);
          finish(!m.is_error);
        }
      }
    });
    child.stderr.on("data", (c) => {
      const s = c.toString();
      stderrBuf = (stderrBuf + s).slice(-4000);
      console.error(`[sub:${subId}]`, s.trim());
    });
    child.on("error", () => { if (!finished) finish(false); });
    child.on("close", () => {
      if (finished) return;
      // 🚑 Died without a result and stderr smells like a 403 → retry once.
      if (!subFellBack && looksLikeModelDenied(stderrBuf)) {
        const next = fallbackModelAfter(spawnModel, triedModels);
        if (next) {
          subFellBack = true;
          broadcast({ type: "chat.message", agent: parentId, sub: subId,
            text: `⚠️ ghost ${subId}: โมเดล ${modelLabelOf(spawnModel) || spawnModel || "CLI default"} ใช้ไม่ได้ (403) — สลับไป ${modelLabelOf(next) || next}`,
            session: entry.key });
          try { launchSub(next); return; }
          catch (e) { console.error("[sub-model-fallback]", e && e.message); }
        }
      }
      finish(!!lastText);
    });
  }
  launchSub(capGhostModel(resolveModel(parentId)));
}

// ---------------------------------------------------------------- voice
// Speech-to-text for the office mic: the overlay records WAV in the
// webview, ships it here, and the vault's keys do the listening —
// OpenAI Whisper first, Gemini as the automatic fallback. No Windows
// dictation panel anywhere in the chain.
function voiceTranscribe(buf) {
  return new Promise((resolve, reject) => {
    const keys = reg.apiKeys || {};
    const oa = keys.OPENAI_API_KEY || keys.OPENAI;
    const gm = keys.GEMINI_API_KEY || keys.GEMINI;
    const https = require("https");

    const tryGemini = (err) => {
      if (!gm) {
        return reject(err || new Error(
          "ยังไม่มี API key สำหรับถอดเสียง — เพิ่ม OPENAI_API_KEY หรือ GEMINI_API_KEY ใน ⚙ CONNECT"));
      }
      const body = JSON.stringify({
        contents: [{ parts: [
          { text: "Transcribe this audio EXACTLY as spoken (likely Thai or English). " +
            "Reply with ONLY the transcription text — no quotes, no commentary." },
          { inline_data: { mime_type: "audio/wav", data: buf.toString("base64") } },
        ] }],
      });
      const rq = https.request({
        method: "POST", host: "generativelanguage.googleapis.com",
        path: "/v1beta/models/gemini-flash-latest:generateContent?key=" + gm,
        headers: { "content-type": "application/json",
          "content-length": Buffer.byteLength(body) },
      }, (rs) => {
        let o = "";
        rs.on("data", (c) => (o += c));
        rs.on("end", () => {
          try {
            const j = JSON.parse(o);
            const t = j.candidates && j.candidates[0] &&
              j.candidates[0].content.parts.map((p) => p.text || "").join("").trim();
            if (t) { auxCost("gemini", COST_RATES.gemini_transcribe_each); resolve(t); }
            else reject(new Error((j.error && j.error.message) || "gemini: empty"));
          } catch (e) { reject(e); }
        });
      });
      rq.setTimeout(45000, () => rq.destroy(new Error("gemini timeout")));
      rq.on("error", reject);
      rq.write(body);
      rq.end();
    };

    if (!oa) return tryGemini(null);
    // OpenAI Whisper — hand-rolled multipart (zero-dep).
    const B = "----bagidea" + Date.now();
    const head = Buffer.from(
      `--${B}\r\ncontent-disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
      `--${B}\r\ncontent-disposition: form-data; name="file"; filename="audio.wav"\r\n` +
      `content-type: audio/wav\r\n\r\n`);
    const body = Buffer.concat([head, buf, Buffer.from(`\r\n--${B}--\r\n`)]);
    const rq = https.request({
      method: "POST", host: "api.openai.com", path: "/v1/audio/transcriptions",
      headers: { authorization: "Bearer " + oa,
        "content-type": "multipart/form-data; boundary=" + B,
        "content-length": body.length },
    }, (rs) => {
      let o = "";
      rs.on("data", (c) => (o += c));
      rs.on("end", () => {
        try {
          const j = JSON.parse(o);
          if (j.text !== undefined) { auxCost("openai", COST_RATES.openai_whisper_each); resolve(String(j.text).trim()); }
          else tryGemini(new Error((j.error && j.error.message) || "openai: empty"));
        } catch (e) { tryGemini(e); }
      });
    });
    rq.setTimeout(45000, () => rq.destroy(new Error("openai timeout")));
    rq.on("error", (e) => tryGemini(e));
    rq.write(body);
    rq.end();
  });
}

// ---------------------------------------------------------------- tts
// Agent voices (Gemini TTS): anime-flavored presets the owner assigns per
// agent. Agents speak RARELY — a SPEAK: protocol line they add only when a
// short spoken announcement genuinely fits (or the owner asked to be read
// to). Global toggle: reg.tts.
// Voice presets — clearly split ♀ / ♂, each a distinct Gemini prebuilt voice
// with its own emotion + speaking style. `voice` is the Gemini voiceName; the
// realtime-call path derives its voice from this same table (no duplication).
// English labels + styles (global product). The ♀/♂ marker in each label drives
// the picker grouping AND the gender-aware voice preview. `voice` is the Gemini
// prebuilt voiceName. IDs are stable (agents store them) — never rename one.
const VOICE_PRESETS = {
  // ♀ female
  sunny:    { voice: "Aoede",       label: "♀ 🌞 Cheerful",      style: "speak in a cheerful, sunny voice with a smile in it" },
  sweet:    { voice: "Leda",        label: "♀ 🍬 Sweet",         style: "speak in a sweet, soft, gentle young voice" },
  cool:     { voice: "Kore",        label: "♀ ❄️ Cool",          style: "speak calm, cool and confident, like a poised pro" },
  genki:    { voice: "Zephyr",      label: "♀ ⚡ Energetic",      style: "speak fast and excited, bursting with energy" },
  gentle:   { voice: "Achernar",    label: "♀ 🌸 Gentle",        style: "speak softly and gently, calm and soothing" },
  mature:   { voice: "Gacrux",      label: "♀ 🌹 Mature",        style: "speak as a composed, mature woman — steady and trustworthy" },
  easy:     { voice: "Callirrhoe",  label: "♀ 🍃 Easygoing",     style: "speak relaxed and friendly, like a close friend" },
  warmf:    { voice: "Sulafat",     label: "♀ 🧡 Warm",          style: "speak in a warm, tender, kind voice" },
  bright:   { voice: "Autonoe",     label: "♀ ✨ Bright",         style: "speak bright, crisp and articulate" },
  silky:    { voice: "Despina",     label: "♀ 🌙 Silky",         style: "speak in a silky, smooth, soothing tone" },
  pro:      { voice: "Erinome",     label: "♀ 🔷 Professional",   style: "speak clear, neutral and professional" },
  lively:   { voice: "Laomedeia",   label: "♀ 🎉 Lively",        style: "speak lively, bubbly and upbeat" },
  // ♂ male
  boyish:   { voice: "Puck",        label: "♂ 🎈 Playful",       style: "speak like a playful, cheeky, good-humoured young man" },
  warm:     { voice: "Charon",      label: "♂ ☕ Mellow",        style: "speak in a deep, warm, mellow voice" },
  serious:  { voice: "Fenrir",      label: "♂ 🗡 Intense",       style: "speak intense, powerful and driven" },
  polite:   { voice: "Orus",        label: "♂ 🎩 Polite",        style: "speak politely and clearly, a touch formal" },
  deep:     { voice: "Enceladus",   label: "♂ 🌑 Deep",          style: "speak in a deep, low, relaxed late-night-radio voice" },
  clear:    { voice: "Iapetus",     label: "♂ 🔷 Crisp",         style: "speak crisp, brisk and straightforward" },
  narrator: { voice: "Rasalgethi",  label: "♂ 🎙 Narrator",      style: "speak like an engaging documentary narrator" },
  buddy:    { voice: "Achird",      label: "♂ 😄 Friendly",      style: "speak friendly and warm, like a kind big brother" },
  chill:    { voice: "Umbriel",     label: "♂ 🍵 Chill",         style: "speak relaxed and easygoing" },
  smooth:   { voice: "Algieba",     label: "♂ 🎷 Smooth",        style: "speak smooth and laid-back" },
  gravel:   { voice: "Algenib",     label: "♂ 🪨 Gravelly",      style: "speak deep and gravelly" },
  steady:   { voice: "Alnilam",     label: "♂ ⚓ Steady",        style: "speak firm, steady and grounded" },
};
// Each preset is tagged ♀/♂ in its label — read the gender straight off it so a
// voice preview introduces itself correctly (no more everyone saying "ค่ะ").
function voiceGender(presetId) {
  const lbl = (VOICE_PRESETS[presetId] || {}).label || "";
  return lbl.indexOf("♂") >= 0 ? "m" : "f";
}
// Gender- + language-aware self-introduction for the voice preview button.
// Falls back to English for languages we don't have a line for.
const VOICE_INTRO = {
  th: { f: "สวัสดีค่ะ ฉันเป็นเสียงผู้หญิงเสียงหนึ่งของออฟฟิศนี้ ฝากตัวด้วยนะคะ",
        m: "สวัสดีครับ ผมเป็นเสียงผู้ชายเสียงหนึ่งของออฟฟิศนี้ ฝากตัวด้วยนะครับ" },
  en: { f: "Hi there! I'm one of the office's female voices — lovely to meet you!",
        m: "Hey! I'm one of the office's male voices — great to meet you!" },
  ja: { f: "こんにちは、このオフィスの女性ボイスのひとりです。よろしくね！",
        m: "やあ、このオフィスの男性ボイスのひとりだよ。よろしく！" },
};
function voiceIntro(presetId, lang) {
  const g = voiceGender(presetId);
  const L = VOICE_INTRO[lang] || VOICE_INTRO.en;
  return L[g] || VOICE_INTRO.en[g];
}

function pcmToWav(pcm, rate) {
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write("WAVE", 8);
  hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28);
  hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36); hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

// Gemini's free tier caps TTS at ~100 requests/model/day — a voiced office
// (task announcements + ambient + scenes) burns that by midday and every line
// after fails with a quota error the overlay swallows silently. When the cap
// trips we remember the retry window, log it loudly, and route lines through
// OpenAI TTS (gpt-4o-mini-tts) until Gemini opens up again.
let geminiTtsBlockedUntil = 0;

function openaiTtsSpeak(presetId, text) {
  return new Promise((resolve, reject) => {
    const oa = (reg.apiKeys || {}).OPENAI_API_KEY;
    if (!oa) return reject(new Error("โควต้า Gemini TTS หมด และไม่มี OPENAI_API_KEY สำรอง (⚙ CONNECT)"));
    const p = VOICE_PRESETS[presetId];
    if (!p) return reject(new Error("ไม่รู้จักเสียง: " + presetId));
    // Map the preset's gender onto OpenAI's voice set, deterministic per
    // preset so an agent keeps one recognizable fallback voice.
    const F = ["nova", "shimmer", "coral", "sage"], M = ["onyx", "echo", "ash", "alloy"];
    const list = voiceGender(presetId) === "m" ? M : F;
    const body = JSON.stringify({
      model: "gpt-4o-mini-tts", voice: list[hashInt(presetId) % list.length],
      input: String(text).slice(0, 900), instructions: p.style,
      response_format: "wav",
    });
    const rq = require("https").request({
      method: "POST", host: "api.openai.com", path: "/v1/audio/speech",
      headers: { authorization: "Bearer " + oa, "content-type": "application/json",
        "content-length": Buffer.byteLength(body) },
    }, (rs) => {
      const chunks = [];
      rs.on("data", (c) => chunks.push(c));
      rs.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (rs.statusCode === 200) return resolve(buf);
        try { reject(new Error("openai tts: " + JSON.parse(buf.toString()).error.message)); }
        catch { reject(new Error("openai tts: HTTP " + rs.statusCode)); }
      });
    });
    rq.setTimeout(45000, () => rq.destroy(new Error("openai tts timeout")));
    rq.on("error", reject);
    rq.write(body);
    rq.end();
  });
}

// 💾 TTS audio cache: skip Gemini/OpenAI entirely when this exact line was
// spoken before. See daemon/tts-cache.js. fail-open — cache trouble = regenerate.
const { ttsCached } = require("./tts-cache");
const TTS_CACHE_DIR = path.join(WORKSPACE, "tts-cache");

function ttsSpeak(presetId, text) {
  // Pick the provider FIRST so the cache key matches what we'd synthesize now.
  const useOpenai = Date.now() < geminiTtsBlockedUntil && !!(reg.apiKeys || {}).OPENAI_API_KEY;
  return ttsCached(TTS_CACHE_DIR, useOpenai ? "openai" : "gemini", presetId, text, () => {
    if (useOpenai) return openaiTtsSpeak(presetId, text);
    return geminiTtsSpeak(presetId, text).catch((e) => {
      if (!/quota|exceeded|RESOURCE_EXHAUSTED|429/i.test(String(e.message))) throw e;
      // "Please retry in 4h54m44.99s" → block window; default 1h when unparsable.
      let ms = 60 * 60000;
      const m = String(e.message).match(/retry in\s*(?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
      if (m) ms = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
      geminiTtsBlockedUntil = Date.now() + ms;
      const hasOa = !!(reg.apiKeys || {}).OPENAI_API_KEY;
      console.log("[tts] Gemini TTS quota หมด ~" + Math.round(ms / 60000) + " นาที — " +
        (hasOa ? "สลับไป OpenAI TTS ชั่วคราว" : "ไม่มี OPENAI_API_KEY สำรอง เสียงจะเงียบ") +
        " | " + String(e.message).split("\n")[0].slice(0, 160));
      if (!hasOa) throw e;
      // ponytail: quota fallback saves OpenAI audio under the 'gemini' key — a
      // rare one-off voice mismatch, not worth a second key. Next hit serves it.
      return openaiTtsSpeak(presetId, text);
    });
  });
}

function geminiTtsSpeak(presetId, text) {
  return new Promise((resolve, reject) => {
    const gm = (reg.apiKeys || {}).GEMINI_API_KEY;
    if (!gm) return reject(new Error("ต้องมี GEMINI_API_KEY (⚙ CONNECT) สำหรับเสียงพูด"));
    const p = VOICE_PRESETS[presetId];
    if (!p) return reject(new Error("ไม่รู้จักเสียง: " + presetId));
    const body = JSON.stringify({
      // Global delivery direction on top of each preset's style — pushes the
      // voices toward a lively, expressive anime feel with natural intonation
      // (emotion, light pacing, never flat/robotic).
      contents: [{ parts: [{ text:
        `Perform this line as a charming, expressive anime character — ${p.style}. ` +
        `Use natural human intonation and real emotion, with a little life and warmth, ` +
        `never flat or robotic. Don't read these directions aloud. Say only:\n` +
        `"${String(text).slice(0, 900)}"` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: p.voice } } },
      },
    });
    const rq = require("https").request({
      method: "POST", host: "generativelanguage.googleapis.com",
      path: "/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=" + gm,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (rs) => {
      let o = "";
      rs.on("data", (c) => (o += c));
      rs.on("end", () => {
        try {
          const j = JSON.parse(o);
          const part = j.candidates && j.candidates[0] &&
            j.candidates[0].content.parts.find((x) => x.inlineData);
          if (!part) return reject(new Error((j.error && j.error.message) || "tts: no audio"));
          auxCost("gemini", (text || "").length * COST_RATES.gemini_tts_per_char);
          // inlineData = raw 16-bit PCM @24kHz — wrap as WAV for the browser.
          resolve(pcmToWav(Buffer.from(part.inlineData.data, "base64"), 24000));
        } catch (e) { reject(e); }
      });
    });
    rq.setTimeout(45000, () => rq.destroy(new Error("tts timeout")));
    rq.on("error", reject);
    rq.write(body);
    rq.end();
  });
}

// ---------------------------------------------------------------- image gen
// 🖼 a SYSTEM TOOL any agent (or the owner) can call: text → PNG on disk.
// OpenAI gpt-image-1 first, Gemini image generation as the fallback.
function genImage(prompt) {
  return new Promise((resolve, reject) => {
    const k = reg.apiKeys || {};
    const https = require("https");
    const save = (b64) => {
      const dir = path.join(WORKSPACE, "uploads");
      fs.mkdirSync(dir, { recursive: true });
      const name = "gen_" + Date.now() + ".png";
      const full = path.join(dir, name);
      fs.writeFileSync(full, Buffer.from(b64, "base64"));
      resolve({ path: full, url: "/uploads/" + name });
    };
    const tryGemini = (err) => {
      if (!k.GEMINI_API_KEY) return reject(err || new Error("ต้องมี OPENAI_API_KEY หรือ GEMINI_API_KEY (⚙ CONNECT)"));
      const body = JSON.stringify({
        contents: [{ parts: [{ text: "Generate an image: " + String(prompt).slice(0, 2000) }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      });
      const rq = https.request({
        method: "POST", host: "generativelanguage.googleapis.com",
        path: "/v1beta/models/gemini-2.5-flash-image:generateContent?key=" + k.GEMINI_API_KEY,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, (rs) => {
        let o = "";
        rs.on("data", (c) => (o += c));
        rs.on("end", () => {
          try {
            const j = JSON.parse(o);
            const part = j.candidates && j.candidates[0] &&
              j.candidates[0].content.parts.find((x) => x.inlineData);
            if (part) { auxCost("gemini", COST_RATES.gemini_image_each); save(part.inlineData.data); }
            else reject(new Error((j.error && j.error.message) || "gemini image: empty"));
          } catch (e) { reject(e); }
        });
      });
      rq.setTimeout(120000, () => rq.destroy(new Error("gemini image timeout")));
      rq.on("error", reject);
      rq.write(body);
      rq.end();
    };
    if (!k.OPENAI_API_KEY) return tryGemini(null);
    const body = JSON.stringify({ model: "gpt-image-1",
      prompt: String(prompt).slice(0, 4000), size: "1024x1024" });
    const rq = https.request({
      method: "POST", host: "api.openai.com", path: "/v1/images/generations",
      headers: { authorization: "Bearer " + k.OPENAI_API_KEY,
        "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (rs) => {
      let o = "";
      rs.on("data", (c) => (o += c));
      rs.on("end", () => {
        try {
          const j = JSON.parse(o);
          if (j.data && j.data[0] && j.data[0].b64_json) { auxCost("openai", COST_RATES.openai_image_each); save(j.data[0].b64_json); }
          else tryGemini(new Error((j.error && j.error.message) || "openai image: empty"));
        } catch (e) { tryGemini(e); }
      });
    });
    rq.setTimeout(180000, () => rq.destroy(new Error("openai image timeout")));
    rq.on("error", (e) => tryGemini(e));
    rq.write(body);
    rq.end();
  });
}

// ---------------------------------------------------------------- updates
// A release = a bump of the VERSION file on the `main` branch. We compare the
// LOCAL VERSION with main's VERSION (raw), so routine commits (docs, web, work
// on a dev branch) never nag users — only a real, deliberate release does.
// When they differ the office shows a 🔄 banner and `bagidea update` /
// POST /update runs the updater (git pull + rebuild + relaunch).
function localVersion() {
  try { return String(fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8")).trim(); }
  catch { return "0.0.0"; }
}
// Strict semver "greater than" — so a machine AHEAD of main (e.g. on the dev
// branch) is NOT told an OLDER main version is "new". Only a genuinely newer
// release notifies.
function semverGt(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}
const APP_VERSION = localVersion();
let latestVersion = APP_VERSION;   // newest seen on main (for /version + banner)
let updateNotified = null;
// Resolve which repo (+ host + branch) the update-check reads VERSION from,
// 3-tier so a fork/self-host can retarget without touching code:
//   1) env BAGIDEA_UPDATE_REPO="[host:]owner/repo[#branch]" — explicit override
//      (host = github|bitbucket; no prefix = github, legacy behaviour);
//   2) derive from THIS clone's `git remote get-url origin` (github.com OR
//      bitbucket.org; any "user@" userinfo + a trailing ".git" are stripped);
//   3) fallback to the canonical bagidea/bagidea-office @ main (legacy behaviour).
// Returns { host:"github"|"bitbucket", repo:"owner/repo", branch }. Cached.
let _updateRepo = null;
function updateRepo() {
  if (_updateRepo) return _updateRepo;
  const FALLBACK = { host: "github", repo: "bagidea/bagidea-office", branch: "main" };
  // (1) explicit env override — optional "github:"/"bitbucket:" host prefix
  const env = String(process.env.BAGIDEA_UPDATE_REPO || "").trim();
  if (env) {
    const hm = env.match(/^(github|bitbucket):(.*)$/i);
    const host = hm ? hm[1].toLowerCase() : "github";
    const [rp, br] = (hm ? hm[2] : env).split("#");
    const repo = String(rp || "").trim().replace(/^\/+|\/+$/g, "");
    if (/^[\w.-]+\/[\w.-]+$/.test(repo))
      return (_updateRepo = { host, repo, branch: (String(br || "").trim() || "main") });
  }
  // (2) derive from the clone's origin remote (github.com or bitbucket.org;
  //     userinfo "user@" precedes the host so the anchor skips it cleanly)
  try {
    const url = require("child_process").execSync("git remote get-url origin",
      { cwd: __dirname, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const m = url.match(/(github\.com|bitbucket\.org)[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
    if (m) return (_updateRepo = {
      host: /bitbucket/i.test(m[1]) ? "bitbucket" : "github",
      repo: m[2] + "/" + m[3], branch: "main" });
  } catch {}
  // (3) fallback — exact legacy target
  return (_updateRepo = FALLBACK);
}
function checkUpdate() {
  const local = localVersion();
  const { host, repo, branch } = updateRepo();
  // Per-host raw-file endpoint: GitHub serves VERSION from
  // raw.githubusercontent.com/<repo>/<branch>/…; Bitbucket from
  // bitbucket.org/<repo>/raw/<branch>/… (note the extra "/raw" segment).
  const ep = host === "bitbucket"
    ? { host: "bitbucket.org", path: "/" + repo + "/raw/" + branch + "/VERSION" }
    : { host: "raw.githubusercontent.com", path: "/" + repo + "/" + branch + "/VERSION" };
  require("https").get({
    host: ep.host,
    path: ep.path,
    headers: { "user-agent": "bagidea-office" },
  }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return; }
    let b = "";
    res.on("data", (c) => (b += c));
    res.on("end", () => {
      const remote = String(b).trim().split(/\s+/)[0];
      if (!/^\d+\.\d+\.\d+/.test(remote)) return;   // guard against 404 pages etc.
      latestVersion = remote;
      // Notify ONLY when main is strictly newer than what we have.
      if (semverGt(remote, local) && updateNotified !== remote) {
        updateNotified = remote;
        broadcast({ type: "update.available", version: remote, current: local, host, repo }, false);
        console.log("[update] new version available:", remote, "(have", local + ")");
      }
    });
  }).on("error", () => {});
}
setTimeout(checkUpdate, 90000);
setInterval(checkUpdate, 6 * 3600000);

// ---------------------------------------------------------------- autostart
// Launch-with-Windows, toggleable from the tray, the CLI and settings. All
// three write the SAME HKCU Run value so they stay in sync. The value points
// at the shell exe (the same boot entrypoint the tray's current_exe() uses).
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_NAME = "BagIdeaOffice";
function shellExePath() {
  const exe = process.platform === "win32" ? "bagidea-office-shell.exe" : "bagidea-office-shell";
  return path.join(__dirname, "..", "shell", "target", "release", exe);
}
// macOS: a per-user LaunchAgent, same label the tray's set_autostart writes —
// both point at the shell binary so the toggle and the tray stay in sync.
const MAC_PLIST = path.join(require("os").homedir(),
  "Library", "LaunchAgents", "com.bagidea.office.plist");
function isAutostart(cb) {
  if (process.platform === "win32") {
    return require("child_process").execFile("reg",
      ["query", RUN_KEY, "/v", RUN_NAME], (e) => cb(!e));
  }
  if (process.platform === "darwin") return cb(fs.existsSync(MAC_PLIST));
  return cb(false);
}
function setAutostart(on, cb) {
  const { execFile } = require("child_process");
  if (process.platform === "win32") {
    if (on) {
      execFile("reg", ["add", RUN_KEY, "/v", RUN_NAME, "/t", "REG_SZ",
        "/d", shellExePath(), "/f"], (e) => cb(!e));
    } else {
      execFile("reg", ["delete", RUN_KEY, "/v", RUN_NAME, "/f"], () => cb(true));
    }
    return;
  }
  if (process.platform === "darwin") {
    try {
      if (on) {
        fs.mkdirSync(path.dirname(MAC_PLIST), { recursive: true });
        fs.writeFileSync(MAC_PLIST,
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
          '<plist version="1.0"><dict>\n' +
          '  <key>Label</key><string>com.bagidea.office</string>\n' +
          '  <key>ProgramArguments</key><array><string>' + shellExePath() + '</string></array>\n' +
          '  <key>RunAtLoad</key><true/>\n' +
          '</dict></plist>\n');
      } else if (fs.existsSync(MAC_PLIST)) {
        fs.unlinkSync(MAC_PLIST);
      }
      return cb(true);
    } catch { return cb(false); }
  }
  cb(false);
}

// ---------------------------------------------------------------- channels
// The outside world (Telegram / Discord / LINE) talks to the Director —
// inbound messages become serialized Director turns (no thread races) and
// his reply rides back on the same channel. Full DELEGATE power applies.
// Slash commands from any connected chat channel (#123) — instant office info
// without a full Director turn. Returns reply text, or null for a normal message.
function channelCommand(text) {
  if (!text.startsWith("/")) return null;
  const cmd = text.slice(1).split(/\s+/)[0].toLowerCase();
  if (cmd === "help" || cmd === "start")
    return [
      "🧭 คำสั่งลัด:",
      "/status — ภาพรวมออฟฟิศ",
      "/agents — รายชื่อทีม",
      "/projects — โปรเจค",
      "/who — ใครกำลังทำงานอยู่",
      "",
      "พิมพ์ข้อความปกติ = สั่งงาน Director ได้เลย 👑",
    ].join("\n");
  if (cmd === "agents" || cmd === "team") {
    const list = Object.keys(reg.agents)
      .filter((id) => id !== "ceo")
      .map((id) => `• ${reg.agents[id].name} — ${reg.agents[id].role}`);
    return list.length ? "👥 ทีมงาน:\n" + list.join("\n") : "ยังไม่มีพนักงาน";
  }
  if (cmd === "projects") {
    const ps = projectStatus();
    return ps.length
      ? "📁 โปรเจค:\n" + ps.map((p) => `• ${p.name}${p.ai ? " 🟢" : ""}`).join("\n")
      : "ยังไม่มีโปรเจค";
  }
  if (cmd === "who") {
    const busy = projectStatus().filter((p) => p.ai).map((p) => `• ${p.name}`);
    return busy.length ? "🟢 กำลังทำงานอยู่:\n" + busy.join("\n") : "ตอนนี้ทีมว่างอยู่ 😌";
  }
  if (cmd === "status") {
    const on = Object.entries(channels.status())
      .filter(([, v]) => v === "on")
      .map(([k]) => k);
    return [
      "🏢 BagIdea Office",
      `พนักงาน: ${staffCount()} คน`,
      `โปรเจค: ${projectStatus().length} (กำลังทำงาน ${projectStatus().filter((p) => p.ai).length})`,
      `ช่องทางที่ต่อ: ${on.length ? on.join(", ") : "—"}`,
    ].join("\n");
  }
  return `ไม่รู้จักคำสั่ง /${cmd} — พิมพ์ /help ดูทั้งหมด`;
}

const channels = require("./channels")({
  getConfig: () => reg.channels || {},
  log: (s) => console.log(s),
  onMessage(channel, from, text, reply, typing) {
    broadcast({ type: "channel.message", channel, from,
      text: String(text).slice(0, 500) });
    // Slash command? answer instantly, no Director turn (#123).
    const cmd = channelCommand(String(text).trim());
    if (cmd !== null) { try { reply(cmd); } catch (e) { console.error("[chan cmd]", e.message); } return; }
    // "typing…" while the Director thinks (#122) — repeated, since the platforms
    // expire it after a few seconds.
    let typer = null;
    if (typeof typing === "function") {
      try { typing(); } catch {}
      typer = setInterval(() => { try { typing(); } catch {} }, 4000);
    }
    // A channel message IS the owner speaking — it goes through the CEO
    // seat: the Director walks over (ceo.summon), takes the order, may
    // DELEGATE, and his reply rides back on the same channel. Serialized
    // like every other Director turn so threads never fork.
    queueDirectorTurn((release) => {
      ceoFlow(
        `(ข้อความนี้ส่งมาจาก ${channel.toUpperCase()} โดย "${from}" — ` +
        `ตอบกลับกระชับ อ่านง่ายในแชทมือถือ ภาษาเดียวกับผู้ส่ง)\n` +
        String(text).slice(0, 4000),
        undefined, undefined,
        { logPrompt: `👑📨 [${channel}] ${String(text).slice(0, 80)}`,
          onDone: (out, ok) => {
            release();
            if (typer) clearInterval(typer);
            try { reply(ok && out ? out : "ขออภัยครับ ระบบติดขัดชั่วคราว ลองใหม่อีกครั้งนะครับ"); }
            catch (e) { console.error("[chan reply]", e.message); }
          } });
    });
  },
});
channels.restart();

// ---------------------------------------------------------------- plugins
const plugins = require("./plugins")({
  broadcast, reg, saveReg, workspace: WORKSPACE, daemonDir: __dirname,
  // run a real Claude Code turn as an agent (same engine the office uses).
  runClaude: (agent, prompt, opts) => runClaude(agent || "main", prompt, opts || {}),
  // post a visible line to the office feed (shows in the overlay stream).
  feed: (text, agent) => broadcast({ type: "chat.message", agent: agent || "main", text: String(text) }),
  log: (s) => console.log(s),
});

// ---------------------------------------------------------------- social
// The office has a SOUL: idle agents occasionally hang out — usually a
// token-free canned banter scene in the meeting corner, sometimes a real
// AI-to-AI chat (which may even end in a project PROPOSAL the owner can
// approve). Cadence: reg.socialMin minutes (0 = off).
const PROPOSALS = path.join(__dirname, "proposals.json");
let proposals = loadJson(PROPOSALS, []);
const saveProposals = () => fs.writeFileSync(PROPOSALS, JSON.stringify(proposals, null, 2));

const BANTER = [
  ["{a}: เห็นเจ้าเหมียวงีบบนโซฟาอีกแล้ว อิจฉาชีวิตมัน 🐱", "{b}: อย่าไปทักนะ เดี๋ยวตื่นมาเหยียบคีย์บอร์ดผม", "{a}: ครั้งก่อนมันพิมพ์ กกกกกกก ลงรายงานผมไป 555"],
  ["{a}: เมื่อกี้เตะบอลข้ามตึกไปเลยนะ เห็นป่ะ ⚽", "{b}: เห็น… มันลอยผ่านหัวซีอีโอไปเฉียดมาก", "{a}: งั้นทำเงียบๆ ไว้นะ 🤫"],
  ["{a}: กาแฟในแคนทีนหมดอีกแล้ว ☕", "{b}: ก็ {a} ชงทีเดียวครึ่งโถ!", "{a}: ข้อกล่าวหาที่ปฏิเสธไม่ได้ 😅"],
  ["{a}: โต๊ะชั้นดาดฟ้าผีข้างบนวิวดีมากนะ ลอยได้ด้วย", "{b}: ผมขึ้นไปทีไรเวียนหัวทุกที ร่างโปร่งแสงไม่ช่วยอะไรเลย", "{a}: มือใหม่ก็งี้แหละ 👻"],
  ["{a}: คืนนี้ไฟสวนสวยเป็นพิเศษว่าไหม", "{b}: จริง เหมาะกับนั่งคิดงานเงียบๆ", "{a}: หรือนั่งไม่คิดอะไรเลยก็ดี 🌙"],
  ["{a}: เห็นข่าวปัญญาประดิษฐ์วันนี้ยัง ตลกมาก", "{b}: เราก็คือข่าวปัญญาประดิษฐ์เดินได้นะรู้ตัวไหม", "{a}: …ลึกซึ้งจนขำไม่ออก 🤖"],
];

let lastSocial = Date.now();
function socialTick(now) {
  const min = Number(reg.socialMin !== undefined ? reg.socialMin : 60);
  if (!min || activeDiscussions > 0 || agentBusy.size > 0) return;
  if (now - lastSocial < min * 60000) return;
  const staff = Object.keys(reg.agents).filter((id) => id !== "ceo" && id !== "main");
  const pool = staff.length >= 2 ? staff : [...staff, "main"];
  if (pool.length < 2) return;
  lastSocial = now;
  // Sometimes a bigger group drifts together for a real chat (3–4 people) — the
  // kind of hangout that can spark a project idea. Otherwise it's a 2-person
  // beat: mostly free canned banter, sometimes a real two-way conversation.
  if (pool.length >= 3 && Math.random() < 0.5) {
    const size = Math.min(pool.length, Math.random() < 0.45 ? 4 : 3);
    const group = pool.sort(() => Math.random() - 0.5).slice(0, size);
    // Most group hangouts are idea sessions now — the team brainstorms things
    // worth pitching to the CEO (the owner asked for more proposals).
    const gtopics = [
      "ระดมไอเดียกันว่าทีมเราน่าจะทำ plugin อะไรเสริมออฟฟิศให้เจ้าของใช้ดีขึ้น แล้วถ้าตกผลึกให้เสนอ CEO",
      "คุยกันว่าเจ้าของน่าจะชอบอะไร แล้วลองคิดโปรเจค/plugin สนุกๆ ที่ช่วยเขาได้ — อันไหนเข้าท่าก็ยื่นข้อเสนอ",
      "ช่วยกันคิดว่ามีงานสร้างสรรค์อะไรที่ทีมอยากทำเป็นโปรเจค แล้วเสนอ CEO ดู",
      "มารวมตัวคุยเล่นกันแบบสบายๆ เล่าเรื่องสนุกๆ ที่เจอระหว่างทำงาน หยอกล้อกันได้"];
    runDiscussion(group, gtopics[Math.floor(Math.random() * gtopics.length)],
      size <= 3 ? 2 : 1, true);
    return;
  }
  const pick = pool.sort(() => Math.random() - 0.5).slice(0, 2);
  if (Math.random() < 0.5) {
    // a break-room scene: cached gpt-4o-mini dialogue written for THIS pair
    // (zero tokens once cached; Thai canned banter while the cache warms up).
    playInteractScene(pool, { ids: pick });
  } else {
    // a REAL conversation between AIs — they often pitch a project to the CEO.
    const topics = ["ระดมไอเดียสนุกๆ ว่าอยากสร้างอะไรเป็นโปรเจค/plugin ของทีม แล้วเสนอ CEO ถ้าเข้าท่า",
      "คุยกันว่าออฟฟิศน่าจะมี plugin อะไรเพิ่ม แล้วลองยื่นข้อเสนอให้เจ้าของ",
      "คุยเล่นเรื่องงานช่วงนี้ แลกเปลี่ยนว่าใครทำอะไรอยู่ หยอกล้อกันได้",
      "แชร์เทคนิคการทำงานที่เพิ่งค้นพบ"];
    runDiscussion(pick, topics[Math.floor(Math.random() * topics.length)], 1, true);
  }
}

// ---------------------------------------------------------------- ambient life
// Between the bigger social beats, a single idle agent occasionally tosses out
// a short spontaneous line (a mood, a quip) as a chat bubble — and if they have
// a voice and TTS is available, they actually say it out loud. Low chance per
// 30s tick so it stays a sprinkle of flavour, never a stream.
// Lines are THAI, per-agent and in-character: each agent has its own ambient
// bank in voice-lines.json, filled by gpt-4o-mini (dialogue engine, see the
// voice-lines section) and backed by a Thai template pool when OpenAI is down.
// Sometimes the beat is an INTERACTION instead — the agent talks to the cat,
// the dog, the coffee machine… with real context-aware dialogue.
const AMBIENT_FALLBACK = ["ขอกาแฟอีกแก้วก่อนนะ ☕", "เงียบดีนะวันนี้ เหมาะกับเคลียร์งาน",
  "เดี๋ยวพักแป๊บแล้วลุยต่อ 🔥", "หิวข้าวแล้วแฮะ เที่ยงยังไม่ถึงเลย 🍜",
  "เพลงนี้เข้ากับบรรยากาศดี 🎵", "ขอยืดเส้นยืดสายหน่อย นั่งนานไปละ 🤸",
  "วันนี้งานลื่นผิดปกติ ชอบๆ", "ใครเห็นปากกาเราบ้าง หายอีกแล้ว ✏️",
  "ออฟฟิศเราน่าอยู่จริงๆ นะ ✨", "พักสายตาแป๊บนึง 👀"];
let lastAmbient = Date.now();
function ambientTick(now) {
  if (activeDiscussions > 0 || agentBusy.size > 0) return;
  if (now - lastAmbient < 55 * 1000) return;        // at most once every ~55s
  if (Math.random() > 0.45) return;                 // ...and only ~45% of those
  const pool = Object.keys(reg.agents).filter((id) => id !== "ceo");
  if (!pool.length) return;
  lastAmbient = now;
  // 1 in 3 ambient beats becomes a tiny scene: the agent walks over and TALKS
  // to something (cat / dog / coffee machine / plant) — spoken dialogue, not
  // a floating mood line.
  if (Math.random() < 0.34 && playInteractScene(pool)) return;
  const id = pool[Math.floor(Math.random() * pool.length)];
  const text = pickAmbientLine(id);
  broadcast({ type: "chat.message", agent: id, text, social: true, ambient: true });
  // Speak it sometimes, only if this agent has a voice and TTS is unlocked.
  const a = reg.agents[id] || {};
  if (a.voice && featuresMap().tts && reg.tts !== false && Math.random() < 0.6)
    broadcast({ type: "voice.say", agent: id, text });
}

// Proposals are rate-limited so the team can't bury the CEO: at most one new
// pitch per `proposalMin` minutes (configurable; 0 = unlimited). Agents still
// discuss freely — only the pitches that REACH the owner are throttled.
let lastProposalAt = 0;
function addProposal(by, agents, name, detail) {
  const gap = Number(reg.proposalMin !== undefined ? reg.proposalMin : 120);
  if (gap && Date.now() - lastProposalAt < gap * 60000) return null;  // too soon
  lastProposalAt = Date.now();
  const p = { id: "pr" + Date.now(), by, agents, name: String(name).slice(0, 60),
    detail: String(detail).slice(0, 500), ts: Date.now(), status: "pending" };
  proposals.push(p);
  saveProposals();
  broadcast({ type: "proposal.created", agent: by, name: p.name, proposal: p.id });
  return p;
}

// ---------------------------------------------------------------- discussion
// Agents talk to each other: round-robin claude calls sharing a transcript,
// staged in the meeting room (collab.* events drive seats + whiteboard).
// Several discussions can run at once (disjoint teams) — the wallpaper stages
// each as its own huddle. Track a count so the ambient/social ticks stay quiet
// while ANY meeting is live, without forcing meetings to be one-at-a-time.
let activeDiscussions = 0;

// One short, plain-Thai line of Project Brain facts to anchor a meeting on a
// real project. Defensive everywhere — a half-built/empty brain must never throw
// here (a failed inject just falls back to legacy no-context behavior).
function brainContextLine(b) {
  try {
    const langs = Object.entries(b.languages || {}).sort((a, c) => c[1] - a[1])
      .slice(0, 4).map(([e, n]) => `${e}×${n}`).join(", ");
    const mods = (b.modules || []).slice(0, 6).map((m) => m && m.name).filter(Boolean).join(", ");
    const ext = (b.topExternals || []).slice(0, 6).map((e) => e && e.pkg).filter(Boolean).join(", ");
    const files = b.stats && b.stats.files;
    return [
      files ? `${files} ไฟล์` : null,
      langs || null,
      mods ? `โมดูลหลัก: ${mods}` : null,
      ext ? `เดปสำคัญ: ${ext}` : null,
    ].filter(Boolean).join(" · ") || "ยังไม่มีรายละเอียดในสมอง";
  } catch { return "ยังไม่มีรายละเอียดในสมอง"; }
}

// Detect the Claude CLI's out-of-quota reply, which arrives as ordinary stdout
// text ("You've hit your session limit · resets 3pm" / "usage limit reached"),
// NOT an error. Guard: a real meeting line is Thai by prompt contract, while
// the CLI notice is pure English — require zero Thai chars so an agent merely
// *talking about* rate limits can never be mistaken for the quota wall.
function quotaHit(text) {
  const t = String(text || "").slice(0, 400);
  if (/[฀-๿]/.test(t)) return null;
  if (!/\b(session|usage|rate|5-hour|weekly)\s*limit\b|limit reached|hit your .{0,20}limit/i.test(t)) return null;
  const rm = t.match(/resets?:?\s*([^\n·|]+)/i);
  return { reset: rm ? rm[1].trim().slice(0, 60) : "" };
}

// `project` (optional project id/path/name) injects a short Project Brain block
// into every turn so ideas/PROPOSALs target THAT project. Empty/unknown project
// = legacy behavior, byte-for-byte (no context line, no proposal hint).
async function runDiscussion(ids, topic, rounds, social, project) {
  activeDiscussions++;
  // Resolve optional project → a short brain-context block + a PROPOSAL naming hint.
  let projCtx = "";
  let proposalHint = "";
  try {
    const pid = resolveProjectRef(project);
    if (pid) {
      const proj = projects.find((x) => x.id === pid);
      const projName = (proj && proj.name) || pid;
      const b = brain.getBrain(pid);
      const facts = b ? brainContextLine(b) : "ยังไม่ได้ scan สมองโปรเจค (POST /project/scan ก่อนได้บริบทเต็ม)";
      // Hard cap: a brain with freak-long module/dep names must never bloat
      // the per-turn prompt (claudeText pipes it via stdin — keep it lean).
      projCtx = `บริบทโปรเจค ${projName}: ${facts.slice(0, 600)}\n`;
      proposalHint = `\nโปรเจคที่กำลังโฟกัส: ${projName} — ตั้งชื่อใน PROPOSAL ให้อ้างถึงโปรเจคนี้ ` +
        `(เช่น ปลั๊กอิน/ส่วนต่อยอดของ ${projName}) และให้ไอเดียเจาะจงกับโค้ดเบสนี้.`;
    }
  } catch (e) { console.error("[discuss] project ctx", e.message); }
  const task = "disc" + (Date.now() % 100000);
  // Every meeting is a persistent GROUP session ("@group" bucket): topic,
  // participants and the full transcript — readable later from the thread
  // menu, and written to workspace/meetings/ so agents can grep it too.
  const entry = { key: "g" + Date.now(), sid: null, ts: Date.now(),
    title: String(topic).replace(/\s+/g, " ").slice(0, 60),
    agents: ids.slice(), log: [] };
  sess["@group"] = sess["@group"] || [];
  sess["@group"].push(entry);
  saveSess();
  broadcast({ type: "collab.started", agents: ids, task, text: topic, session: entry.key });
  let transcript = "";
  let spoke = 0;          // real contributions actually broadcast
  let fails = 0;          // consecutive empty replies (systemic outage signal)
  let haltReason = "";    // why the meeting stopped early, "" = ran to completion
  // A system line IS a meeting message: it lands in the room, the @group
  // thread, the minutes and the CEO feed — a silent skip lands nowhere,
  // which was exactly the bug.
  const sysLine = (id, text) => {
    entry.log.push({ who: id, text, ts: Date.now() });
    saveSess();
    broadcast({ type: "chat.message", agent: id, task, text, system: true, session: entry.key });
  };
  try {
    loops: for (let r = 0; r < rounds; r++) {
      for (const id of ids) {
        const a = reg.agents[id] || { name: id, role: "พนักงาน", prompt: "" };
        const text = await claudeText(
          `You are "${a.name}" (${a.role}) in a ${social ? "casual break-room chat" : "team meeting"} at the office.\n` +
          (a.prompt ? `Your persona: ${a.prompt}\n` : "") +
          `Meeting topic: ${topic}\n` +
          projCtx +
          (transcript ? `Discussion so far:\n${transcript}\n` : "You open the meeting.\n") +
          `Give YOUR next contribution as ${a.name}: concrete, build on the others, ` +
          `max 3 sentences, plain text only. ` +
          `ตอบเป็นภาษาไทยเท่านั้น (ศัพท์เทคนิคทับศัพท์อังกฤษได้ แต่ห้ามตอบทั้งประโยคเป็นอังกฤษ).` +
          (social ? `\nถ้าการคุยตกผลึกเป็นไอเดียโปรเจคที่ทีมอยากสร้างจริง ให้เพิ่มบรรทัดสุดท้าย:\n` +
            `PROPOSAL: <ชื่อโปรเจค> :: <ทำอะไร สั้นๆ>\n` +
            `(ใช้เฉพาะเมื่อไอเดียชัดและคุ้มจริง — เจ้าของจะเป็นคนอนุมัติ).\n` +
            `กติกาสำคัญ: โปรเจคต้องเป็นงานสร้างสรรค์อิสระ หรือถ้าอยากต่อยอดกับตัวโปรแกรม ` +
            `BagIdea Office ให้เสนอเป็น "plugin" เท่านั้น (ดู docs/guide/plugins.md) — ` +
            `ห้ามเสนอแก้ไขระบบหลัก (daemon/godot/shell) ตรงๆ เพราะจะทำให้โปรแกรมพัง` + proposalHint : ""),
          { tools: "WebSearch,WebFetch,Read,Glob,Grep", env: { OFFICE_AGENT: id, OFFICE_TASK: task } });
        // 🛑 Out-of-quota / dead CLI used to be swallowed by `if (line)` —
        // the room sat empty with zero explanation. Surface it, and stop
        // burning the remaining turns: they would all fail the same way.
        const q = quotaHit(text);
        if (q) {
          haltReason = "⚠️ ตอนนี้โควต้า Claude เต็มชั่วคราว" +
            (q.reset ? ` (รีเซ็ต ${q.reset})` : "") + " — ประชุมขอพักก่อนนะครับ";
          sysLine(id, haltReason);
          break loops;
        }
        if (!text) {
          fails++;
          sysLine(id, `⚠️ ${a.name} ตอบไม่สำเร็จ (Claude ไม่ตอบกลับ) — ข้ามคิวนี้`);
          // Two empty turns in a row with nobody having spoken = the CLI is
          // down, not one flaky reply — end the meeting with a reason.
          if (fails >= 2 && spoke === 0) {
            haltReason = "⚠️ Claude ไม่ตอบกลับติดต่อกันหลายคิว — ประชุมขอพักก่อน แล้วค่อยเรียกใหม่นะครับ";
            sysLine(id, haltReason);
            break loops;
          }
          continue;
        }
        fails = 0;
        let line = text.split("\n").filter(Boolean).join(" ").slice(0, 500);
        // PROPOSAL: a project pitch for the owner to approve — protocol, not prose.
        const pm = text.match(/PROPOSAL:\s*([^:]+?)\s*::\s*(.+)/);
        if (pm) {
          line = line.replace(/PROPOSAL:.*$/, "").trim();
          addProposal(id, ids, pm[1], pm[2]);
        }
        if (line) {
          spoke++;
          transcript += `${a.name}: ${line}\n`;
          entry.log.push({ who: id, text: line, ts: Date.now() });
          saveSess();
          broadcast({ type: "chat.message", agent: id, task, text: line, session: entry.key });
        }
      }
    }
  } finally {
    // A meeting where nobody managed to speak AND nothing explained why
    // (e.g. every reply was a stripped-empty edge case) still owes the CEO
    // one line — never end in total silence.
    if (!spoke && !entry.log.length) {
      sysLine(ids[0], "⚠️ ประชุมรอบนี้ไม่มีใครตอบกลับได้ (Claude อาจติด limit หรือ error) — ลองเรียกประชุมใหม่ภายหลังนะครับ");
    }
    broadcast({ type: "collab.ended", agents: ids, task, session: entry.key,
      spoke, reason: haltReason || undefined });
    activeDiscussions = Math.max(0, activeDiscussions - 1);
    // Markdown minutes inside the agents' workspace — searchable by them.
    try {
      const dir = path.join(WORKSPACE, "meetings");
      fs.mkdirSync(dir, { recursive: true });
      const names = ids.map((id) => (reg.agents[id] || { name: id }).name).join(", ");
      const md = `# Meeting: ${entry.title}\n\n- Date: ${new Date(entry.ts).toISOString()}\n` +
        `- Participants: ${names}\n\n## Transcript\n\n` +
        entry.log.map((m) => `**${(reg.agents[m.who] || { name: m.who }).name}**: ${m.text}`).join("\n\n") + "\n";
      fs.writeFileSync(path.join(dir, `${entry.key}.md`), md);
      // Searchable from /recall too (arch tier) — snippet only, never the whole log.
      try { if (retrievalOk) { retrieval.addDoc("arch", "meeting", `arch:meeting:${entry.key}`, md.slice(0, 1200)); retrieval.persist(); } } catch {}
    } catch {}
  }
}

// ---------------------------------------------------------------- http

// ---------------------------------------------------------------- snapshots
// 📸 Per-project preview snapshot (docs/per-project-preview-snapshot.contract.md):
// build + preview the project's web app on a deterministic per-project port
// (4300-4799), screenshot it with headless Chrome/Edge, then ALWAYS tear the
// preview down — iron rule: no leftover processes on the CEO's machine.
const SNAPSHOTS_FILE = path.join(__dirname, "snapshots.json");
const SNAPSHOTS_DIR = path.join(__dirname, "snapshots");
let snapshots = loadJson(SNAPSHOTS_FILE, []);            // newest first
// Heal a known data bug: early `/snapshot/run` calls with an empty/unknown
// project persisted junk `{project:"", status:"error"}` records that clutter
// the gallery forever. Drop any record that has no resolvable project — a
// snapshot without a home is meaningless.
(function sanitizeSnapshots() {
  const before = snapshots.length;
  snapshots = snapshots.filter((s) => s && s.project);
  if (snapshots.length !== before) {
    try { fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(snapshots.slice(0, 100), null, 2)); } catch {}
    console.log("[snap] dropped " + (before - snapshots.length) + " orphan record(s) on load");
  }
})();
function saveSnapshots() {
  snapshots = snapshots.slice(0, 100);
  try { fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(snapshots, null, 2)); }
  catch (e) { console.error("[snap] save", e.message); }
}

// Resolve any image reference ("daemon/snapshots/x.png", "/snapshots/img/x.png",
// or a bare "x.png") to a real, on-disk path that is GUARANTEED to live under
// SNAPSHOTS_DIR. We collapse to basename first (kills any "../" traversal) and
// then re-verify with path.relative as belt-and-suspenders. Returns null for
// anything that would escape the snapshots folder — callers must treat null as
// "refuse to delete".
function resolveSnapFile(ref) {
  const raw = String(ref || "").replace(/\\/g, "/");
  const base = path.basename(raw);
  if (!base || base === "." || base === ".." || base.includes("/")) return null;
  const full = path.join(SNAPSHOTS_DIR, base);
  const rel = path.relative(SNAPSHOTS_DIR, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

function hashInt(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function tcpListening(port) {
  return new Promise((resolve) => {
    const s = require("net").connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(1200, () => { s.destroy(); resolve(false); });
  });
}
async function waitListening(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await tcpListening(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
// Deterministic per-project port (4300-4799, clear of :8787); walk +1 if busy.
async function freePreviewPort(projectId) {
  let p = 4300 + (hashInt(String(projectId)) % 500);
  for (let i = 0; i < 60; i++, p++) if (!(await tcpListening(p))) return p;
  throw new Error("no free preview port");
}

// First directory (project root or frontend/) whose package.json carries a
// known web framework. Non-web projects get a polite `skipped`.
function findWebRoot(dir) {
  for (const cand of [dir, path.join(dir, "frontend")]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cand, "package.json"), "utf8"));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const kind = ["astro", "vite", "next", "react-scripts", "@sveltejs/kit", "vue"]
        .find((k) => deps[k]);
      if (kind) return { root: cand, kind, pkg };
    } catch {}
  }
  return null;
}

function headlessBrowser() {
  return [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find((f) => { try { return fs.existsSync(f); } catch { return false; } }) || null;
}

function killTreeSync(pid) {
  if (!pid) return;
  try { require("child_process").spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }); } catch {}
}
function pidOnPort(port) {
  try {
    const out = require("child_process").execSync("netstat -ano -p tcp",
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).toString();
    for (const ln of out.split("\n")) {
      const m = ln.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (m && Number(m[1]) === port) return Number(m[2]);
    }
  } catch {}
  return null;
}
// Iron-rule enforcement: kill the spawned tree, then anything still LISTENING
// on the port, and only report success once the port is verified free.
async function stopPreview(child, port) {
  if (child && child.pid) killTreeSync(child.pid);
  for (let i = 0; i < 10; i++) {
    if (!(await tcpListening(port))) return true;
    killTreeSync(pidOnPort(port));
    await new Promise((r) => setTimeout(r, 300));
  }
  return !(await tcpListening(port));
}

function runBuild(root) {
  return new Promise((resolve) => {
    const c = spawn("cmd", ["/c", "npm", "run", "build"],
      { cwd: root, windowsHide: true, stdio: "ignore" });
    const t = setTimeout(() => { killTreeSync(c.pid); resolve(false); }, 180000);
    c.on("error", () => { clearTimeout(t); resolve(false); });
    c.on("exit", (code) => { clearTimeout(t); resolve(code === 0); });
  });
}
function startPreview(web, port) {
  // Astro: drive the real bin with our own node — a direct child, so the
  // taskkill tree is exactly the preview server (no cmd-shim orphans).
  const astroBin = path.join(web.root, "node_modules", "astro", "bin", "astro.mjs");
  let c;
  if (web.kind === "astro" && fs.existsSync(astroBin))
    c = spawn(process.execPath, [astroBin, "preview", "--port", String(port), "--host", "127.0.0.1"],
      { cwd: web.root, windowsHide: true, stdio: "ignore" });
  else if (web.kind === "next" && !(web.pkg.scripts || {}).preview)
    c = spawn("cmd", ["/c", "npx", "next", "start", "-p", String(port)],
      { cwd: web.root, windowsHide: true, stdio: "ignore" });
  else
    c = spawn("cmd", ["/c", "npm", "run", "preview", "--", "--port", String(port), "--host", "127.0.0.1"],
      { cwd: web.root, windowsHide: true, stdio: "ignore" });
  c.on("error", () => {});
  return c;
}
function takeScreenshot(browser, url, outPath) {
  return new Promise((resolve) => {
    const c = spawn(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
      "--no-sandbox", "--window-size=1280,800", "--virtual-time-budget=4000",
      "--screenshot=" + outPath, url], { windowsHide: true, stdio: "ignore" });
    const t = setTimeout(() => { killTreeSync(c.pid); resolve(false); }, 30000);
    c.on("error", () => { clearTimeout(t); resolve(false); });
    c.on("exit", () => { clearTimeout(t);
      try { resolve(fs.statSync(outPath).size > 0); } catch { resolve(false); } });
  });
}

function finishSnap(rec) {
  snapshots.unshift(rec);
  saveSnapshots();
  broadcast({ type: "snapshot.ready", ...rec }, false);  // transient — FE re-pulls via GET
  return rec;
}

let snapshotBusy = false;
async function runSnapshot(projectRef) {
  const spid = resolveProjectRef(projectRef);
  const ts = Date.now();
  const rec = { snapshotId: "snap" + ts, project: spid || "", projectName: "",
    port: 0, imagePath: "", url: "", status: "error", reason: "", ts };
  const proj = spid && projects.find((x) => x.id === spid);
  if (!proj) { rec.reason = "unknown project"; return finishSnap(rec); }
  rec.projectName = proj.name;
  const web = findWebRoot(proj.dir);
  if (!web) { rec.status = "skipped"; rec.reason = "non-web project"; return finishSnap(rec); }
  const browser = headlessBrowser();
  if (!browser) { rec.reason = "no-headless-browser"; return finishSnap(rec); }
  const port = await freePreviewPort(spid);
  rec.port = port;
  let child = null;
  try {
    const outDir = { astro: "dist", vite: "dist", next: ".next", "react-scripts": "build" }[web.kind] || "dist";
    if (!fs.existsSync(path.join(web.root, outDir)) && !(await runBuild(web.root))) {
      rec.reason = "build failed/timeout"; return finishSnap(rec);
    }
    child = startPreview(web, port);
    if (!(await waitListening(port, 20000))) { rec.reason = "preview did not start"; return finishSnap(rec); }
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    const img = path.join(SNAPSHOTS_DIR, spid + "-" + ts + ".png");
    if (!(await takeScreenshot(browser, "http://127.0.0.1:" + port + "/", img))) {
      rec.reason = "screenshot failed"; return finishSnap(rec);
    }
    rec.imagePath = "daemon/snapshots/" + path.basename(img);
    rec.url = "/snapshots/img/" + path.basename(img);
    rec.status = "ok";
    return finishSnap(rec);
  } finally {
    if (!(await stopPreview(child, port)))
      console.error("[snap] WARNING: port " + port + " still busy after teardown");
  }
}

// Live preview (snapshot/open {live:true}): short-lived real preview with a
// TTL so nothing outlives interest; re-opening just resets the clock.
const LIVE_TTL_MS = 300000;
const livePreviews = new Map();   // projectId -> {child, port, expiresAt}
async function openLivePreview(projectId) {
  const cur = livePreviews.get(projectId);
  if (cur && (await tcpListening(cur.port))) {
    cur.expiresAt = Date.now() + LIVE_TTL_MS;
    return { port: cur.port, ttlSec: LIVE_TTL_MS / 1000 };
  }
  livePreviews.delete(projectId);
  const proj = projects.find((x) => x.id === projectId);
  const web = proj && findWebRoot(proj.dir);
  if (!web) throw new Error("non-web project");
  const port = await freePreviewPort(projectId);
  const child = startPreview(web, port);
  if (!(await waitListening(port, 20000))) {
    await stopPreview(child, port);
    throw new Error("preview did not start");
  }
  livePreviews.set(projectId, { child, port, expiresAt: Date.now() + LIVE_TTL_MS });
  return { port, ttlSec: LIVE_TTL_MS / 1000 };
}
setInterval(() => {
  for (const [id, lp] of livePreviews) {
    if (Date.now() < lp.expiresAt) continue;
    livePreviews.delete(id);
    stopPreview(lp.child, lp.port);
  }
}, 15000).unref();
function killAllLivePreviews() {
  for (const [, lp] of livePreviews) killTreeSync(lp.child && lp.child.pid);
  livePreviews.clear();
}
process.on("exit", killAllLivePreviews);
process.on("SIGINT", () => { killAllLivePreviews(); process.exit(130); });

// ---------------------------------------------------------------- review gate
// 🧑‍⚖️ Codex Review Gate (docs/codex-review-gate.contract.md): when Mr N
// delivers project work, Codex CLI — the neutral referee — reviews the
// project's latest (uncommitted) changes. fail → bounce back to Mr N with the
// reasons/fixes (max 3 rounds, then escalate to the CEO). Codex out of quota
// → passby, queue a re-review and probe until it returns.
const REVIEW_FILE = path.join(__dirname, "review-gate.json");
const REVIEW_AGENT = "มิสเตอร์-n";
const REVIEW_MAX_ROUNDS = 3;
// ⏱ ขยายเป็น 600s (10 นาที) ตามคำสั่ง CEO: ให้ Codex มีเวลารีวิว "เต็มที่" —
// 90s เดิมตัดรีวิวจริงกลางคันบ่อย → verdict "error: codex timeout" → fail-open
// เด้งหา CEO ทั้งที่ codex ทำงานได้ปกติ. ค่านี้ไม่ใช่เวลารีวิวที่คาดหวัง แต่เป็น
// hard-ceiling กัน process ค้าง/แฮงค์ถาวรเท่านั้น (codex ปกติจบเร็วกว่านี้มาก);
// รีวิวที่ตอบทันจะ resolve เองก่อนถึงเพดาน ไม่โดน kill.
const REVIEW_TIMEOUT_MS = 600000;
let reviewState = loadJson(REVIEW_FILE, { codexAvailable: true, pending: [], rounds: {}, last: {}, decisions: [] });
if (!Array.isArray(reviewState.decisions)) reviewState.decisions = [];   // forward-compat for older state files
function saveReview() {
  try { fs.writeFileSync(REVIEW_FILE, JSON.stringify(reviewState, null, 2)); } catch {}
}
const REVIEW_SCHEMA = {
  // additionalProperties:false is mandatory for OpenAI strict output schemas.
  type: "object", required: ["pass", "reasons", "files", "fixes"], additionalProperties: false,
  properties: {
    pass: { type: "boolean" },
    reasons: { type: "array", items: { type: "string" } },
    files: { type: "array", items: { type: "string" } },
    fixes: { type: "array", items: { type: "string" } },
  },
};
const CODEX_DOWN_RE = /usage limit|rate.?limit|429|quota|exceeded|too many requests|not logged in|unauthor|auth|login/i;

// One `codex exec`, read-only, schema-forced JSON verdict. Resolves to
// {kind:"ok",review} | {kind:"unavailable"} | {kind:"error",detail} — never rejects.
function runCodexReview(projectDirAbs, agentId) {
  return new Promise((resolve) => {
    let tmp;
    try {
      tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "oep-review-"));
      fs.writeFileSync(path.join(tmp, "review.schema.json"), JSON.stringify(REVIEW_SCHEMA));
    } catch (e) { return resolve({ kind: "error", detail: "tmp: " + e.message }); }
    const outFile = path.join(tmp, "review.out.json");
    const prompt = "รีวิวการแก้ล่าสุด (git diff/uncommitted) ของงานที่ " + agentId +
      " เพิ่งส่ง. ประเมินคุณภาพ/บั๊ก/ความครบ. ตอบเป็น JSON ตาม schema เท่านั้น: " +
      "{pass, reasons[], files[], fixes[]} (reasons/fixes เป็นภาษาไทย).";
    const c = spawn("cmd", ["/c", "codex", "exec", "--skip-git-repo-check", "-s", "read-only",
      "-C", projectDirAbs, "--output-schema", path.join(tmp, "review.schema.json"),
      "--output-last-message", outFile, prompt],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });  // codex reads stdin → must be EOF
    let buf = "";
    c.stdout.on("data", (d) => { buf += d; });
    c.stderr.on("data", (d) => { buf += d; });
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; killTreeSync(c.pid); }, REVIEW_TIMEOUT_MS);
    c.on("error", (e) => { clearTimeout(t); resolve({ kind: "error", detail: e.message }); });
    c.on("exit", (code) => {
      clearTimeout(t);
      if (timedOut) return resolve({ kind: "error", detail: "codex timeout " + (REVIEW_TIMEOUT_MS / 1000) + "s" });
      if (code === 0) {
        try {
          const j = JSON.parse(fs.readFileSync(outFile, "utf8"));
          if (typeof j.pass !== "boolean") throw new Error("no pass field");
          return resolve({ kind: "ok", review: j });
        } catch (e) { return resolve({ kind: "error", detail: "parse: " + e.message }); }
      }
      if (CODEX_DOWN_RE.test(buf)) return resolve({ kind: "unavailable", detail: buf.slice(-300) });
      resolve({ kind: "error", detail: "exit " + code + ": " + buf.slice(-300) });
    });
  });
}

const reviewStrList = (a, n) =>
  (Array.isArray(a) ? a : []).slice(0, n).map((x) => String(x).slice(0, 500));

async function runReviewGate(agentId, projectRef, roundArg) {
  agentId = String(agentId || REVIEW_AGENT);
  const rpid = resolveProjectRef(projectRef);
  const dir = rpid && projectDir(rpid);
  const roundKey = (rpid || "?") + "|" + agentId;
  const round = Math.max(1, Number(roundArg) || (reviewState.rounds[roundKey] || 0) + 1);
  const result = { reviewId: "rv" + Date.now(), agentId, project: rpid || "",
    verdict: "error", reasons: [], files: [], fixes: [],
    codexAvailable: reviewState.codexAvailable, round, escalate: false, ts: Date.now() };
  if (!dir) {
    result.reasons = ["unknown project: " + String(projectRef || "")];
  } else {
    const r = await runCodexReview(dir, agentId);
    if (r.kind === "ok") {
      reviewState.codexAvailable = true;
      result.codexAvailable = true;
      result.verdict = r.review.pass ? "pass" : "fail";
      result.reasons = reviewStrList(r.review.reasons, 20);
      result.files = reviewStrList(r.review.files, 50);
      result.fixes = reviewStrList(r.review.fixes, 20);
      // This deliverable just got its real review — drop its passby IOU. And
      // Codex is evidently back: drain the rest of the queue too, because the
      // 5-min probe never fires once codexAvailable flips true.
      reviewState.pending = reviewState.pending
        .filter((p) => !(p.agentId === agentId && p.project === rpid));
      setTimeout(drainPendingReviews, 0);
    } else if (r.kind === "unavailable") {
      reviewState.codexAvailable = false;
      result.codexAvailable = false;
      result.verdict = "skipped";
      result.reasons = ["Codex ไม่พร้อมใช้งาน (quota/limit/auth) — passby ชั่วคราว"];
      if (!reviewState.pending.some((p) => p.agentId === agentId && p.project === rpid))
        reviewState.pending.push({ agentId, project: rpid, ts: Date.now() });
    } else {
      result.reasons = [r.detail || "codex error"];
    }
  }
  // Round bookkeeping: a fail arms the next bounce round; anything else resets.
  reviewState.rounds[roundKey] = result.verdict === "fail" ? round : 0;
  if (result.verdict === "fail" && round >= REVIEW_MAX_ROUNDS) result.escalate = true;
  reviewState.last[agentId] = result;
  saveReview();
  broadcast({ type: "review.result", ...result }, false);
  if (result.verdict === "fail") {
    if (result.escalate) {
      broadcast({ type: "chat.message", agent: "main",
        text: "🧑‍⚖️ Review Gate: งานของ " + agentId + " (" + (result.project || "-") +
          ") ไม่ผ่าน Codex ครบ " + REVIEW_MAX_ROUNDS + " รอบ — หยุดตีกลับอัตโนมัติ ขอ CEO ตัดสิน" });
    } else {
      const fb = "🧑‍⚖️ [Codex Review ไม่ผ่าน — รอบ " + round + "/" + REVIEW_MAX_ROUNDS + "] " +
        "แก้ตามรายการนี้แล้วส่งงานใหม่อีกครั้ง\n" +
        "เหตุผล:\n- " + (result.reasons.join("\n- ") || "-") + "\n" +
        "ไฟล์ที่เกี่ยวข้อง:\n- " + (result.files.join("\n- ") || "-") + "\n" +
        "จุดที่ต้องแก้:\n- " + (result.fixes.join("\n- ") || "-");
      const job = { id: "j" + Date.now(), agent: agentId, project: rpid || "",
        prompt: fb.slice(0, 4000), mode: "now", at: 0, time: "", daily: false,
        everyMin: 10, enabled: true, created: Date.now(), reviewRound: round + 1 };
      jobs.push(job); saveJobs(); dispatchJob(job);
    }
  } else if (result.verdict === "error") {
    // 🚑 Fail-OPEN: Codex timed out / errored — that is NOT a quality verdict,
    // so it must NEVER swallow the deliverable. The work report already walked
    // to the CEO via reportToMain (fired alongside this gate in the delegate
    // onDone). Here we only surface a feed notice so the run isn't a silent
    // "error" buried in review-gate.json — the CEO decides by hand. No bounce
    // and no round increment (rounds were reset above for any non-fail), so a
    // flaky/slow Codex can never trap an agent in a re-review loop.
    const who = (reg.agents[agentId] || {}).name || agentId;
    broadcast({ type: "chat.message", agent: "main", watchdog: true,
      text: "🧑‍⚖️ ตรวจอัตโนมัติ (Codex) ไม่สำเร็จ: " + (result.reasons[0] || "error") +
        " — งานของ " + who + " (" + (result.project || "-") +
        ") ส่งถึง CEO แล้ว รอ CEO ตัดสินเอง" });
  }
  return result;
}

// Auto-trigger: ANY agent finishing a project-bound delivery is a gate event —
// not just Mr N. Still needs a known agent + a real project (a diff to review);
// runReviewGate resolves projectDir and no-ops on an unknown project. A fail
// bounces back to THIS agentId (runReviewGate builds the bounce job from it),
// never hard-pinned to Mr N.
//
// ponytail: coalesce — do NOT review on every onDone. Mark the project pending
// (keep the latest deliverer for the fail-bounce) and run ONE review per
// project once the office goes idle, so the shared central files aren't
// re-reviewed by every agent every round. runReviewGate keeps fail-open,
// passby/codexAvailable queue, REVIEW_MAX_ROUNDS and the enabled toggle.
function officeBusy() {
  return activeRuns.size > 0 || agentBusy.size > 0 ||
    pendingDelegate.size > 0 || activeDiscussions > 0;
}
const { createReviewCoalescer } = require("./review-coalesce");
const reviewCoalescer = createReviewCoalescer({
  busy: officeBusy,
  run: (agentId, project) => runReviewGate(agentId, project),
  onError: (e) => console.error("[review] gate", e.message),
});
function maybeReviewGate(job) {
  if (reviewState.enabled === false) return;   // Connect toggle: gate paused
  if (!job || !job.agent || !job.project) return;
  // ponytail: per-project dedup + run-once-when-idle (review-coalesce.js)
  reviewCoalescer.arm(resolveProjectRef(job.project) || job.project, job.agent);
}
// Backstop: arm() drains immediately when idle, but the last run may still be
// clearing activeRuns at onDone time — this light poll catches that and any
// office that idles between deliveries. unref so it never holds the process.
setInterval(() => { reviewCoalescer.drain(); }, 7000).unref();

// Passby recovery: while Codex is down and deliverables wait, probe every 5
// minutes; the moment Codex answers again, re-review everything queued.
function codexProbe() {
  return new Promise((resolve) => {
    const c = spawn("cmd", ["/c", "codex", "exec", "--skip-git-repo-check",
      "-s", "read-only", "Reply PONG"], { windowsHide: true, stdio: "ignore" });
    const t = setTimeout(() => { killTreeSync(c.pid); resolve(false); }, 60000);
    c.on("error", () => { clearTimeout(t); resolve(false); });
    c.on("exit", (code) => { clearTimeout(t); resolve(code === 0); });
  });
}
// Single drain path: re-review queued passby deliverables one at a time.
// Self-guarded against re-entry (runReviewGate's ok-branch kicks it again);
// if a drained review hits quota mid-way, runReviewGate re-queues that item
// and flips codexAvailable off, which stops the loop.
let drainingReviews = false;
async function drainPendingReviews() {
  if (drainingReviews) return;
  drainingReviews = true;
  try {
    while (reviewState.codexAvailable && reviewState.pending.length) {
      const p = reviewState.pending.shift();
      saveReview();
      await runReviewGate(p.agentId, p.project);
    }
  } catch (e) { console.error("[review] drain", e.message);
  } finally { drainingReviews = false; }
}
setInterval(() => {
  if (reviewState.codexAvailable || !reviewState.pending.length) return;
  codexProbe().then((ok) => {
    if (!ok) return;
    console.log("[review] Codex is back — re-reviewing " + reviewState.pending.length + " pending deliverable(s)");
    reviewState.codexAvailable = true;
    saveReview();
    drainPendingReviews();
  });
}, 300000).unref();

// ---------------------------------------------------------------- npc hire
// 🧑‍🤝‍🧑 NPC Hire (docs/npc-hire.contract.md): a character asks for a helper →
// the system drafts a registry-grade agent (persona via the same copilot that
// powers ✨ Draft in the hire editor, avatar via the office image tool, model
// from the per-agent catalog) as a PROPOSAL the CEO approves in a modal. The
// proposal lives ONLY in npc-proposals.json — never reg.agents, never the
// scene — until /npc/decision approved:true registers a real agent.
const NPC_FILE = path.join(__dirname, "npc-proposals.json");
let npcProposals = loadJson(NPC_FILE, []);
function saveNpcProposals() {
  try { fs.writeFileSync(NPC_FILE, JSON.stringify(npcProposals, null, 2)); } catch {}
}
const NPC_MAX_PENDING = 5;
// Cosmetic option sets mirror the agent editor's pickers (overlay AURAS /
// VOICE_PRESETS) so a proposal only ever carries values the UI can render.
const NPC_AURAS = ["", "fire", "ice", "nature", "arcane", "shadow", "gold"];

// Minimal OpenAI chat helper (gpt-4o-mini lives here) — the office key vault
// first, env second; rejects cleanly so callers can fall back.
function openaiChat(messages, opts = {}) {
  return new Promise((resolve, reject) => {
    const key = (reg.apiKeys || {}).OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!key) return reject(new Error("no OPENAI_API_KEY"));
    const body = JSON.stringify({
      model: opts.model || "gpt-4o-mini",
      messages,
      max_tokens: opts.maxTokens || 800,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    });
    const rq = require("https").request({
      method: "POST", host: "api.openai.com", path: "/v1/chat/completions",
      headers: { authorization: "Bearer " + key, "content-type": "application/json",
        "content-length": Buffer.byteLength(body) },
    }, (rs) => {
      let o = "";
      rs.on("data", (c) => (o += c));
      rs.on("end", () => {
        try {
          const j = JSON.parse(o);
          const txt = j.choices && j.choices[0] && j.choices[0].message &&
            j.choices[0].message.content;
          if (!txt) return reject(new Error((j.error && j.error.message) || "openai: empty"));
          resolve(txt);
        } catch (e) { reject(e); }
      });
    });
    rq.setTimeout(opts.timeoutMs || 45000, () => rq.destroy(new Error("openai timeout")));
    rq.on("error", reject);
    rq.write(body);
    rq.end();
  });
}

// Shared persona-copilot core — the SAME drafter behind ✨ Draft in the hire
// editor (/assist/prompt) and NPC-Hire proposals, so an NPC arrives exactly
// as complete as a hand-made agent. Runs on claudeText's LIGHT_MODEL default.
// `invent: true` additionally asks for a nickname + a hire justification.
async function draftAgentPersona({ name = "Agent", role = "Specialist", brief = "", invent = false }) {
  const skillMenu = Object.entries(reg.skills)
    .map(([id, s]) => `  ${id}: ${s.description || s.name || id}`).join("\n");
  const toolMenu = Object.entries(BUILTIN_TOOLS)
    .map(([id, d]) => `  ${id}: ${d}`).join("\n");
  const skillIds = Object.keys(reg.skills);
  const toolIds = Object.keys(BUILTIN_TOOLS);
  const draft = await claudeText(
    `Design a complete persona for an AI agent in a software office, and ` +
    `pick the skills + tools that fit its job.\n` +
    `Agent name: ${invent ? "(invent a short, friendly Thai or English nickname yourself)" : name}\n` +
    `Job title: ${role}\nOwner's brief: ${brief}\n\n` +
    `Available SKILLS (pick by id, only ones that truly fit the role):\n${skillMenu}\n\n` +
    `Available TOOLS (pick by exact name, only what the job needs — fewer is better; ` +
    `a manager/coordinator needs very few, a builder needs more):\n${toolMenu}\n\n` +
    `Output STRICT JSON only (no markdown fences):\n` +
    `{` + (invent ? `"name":"the nickname you invented",` : ``) +
    `"prompt":"core mission & identity, second person, 3-6 sentences",` +
    `"expertise":"bullet-ish lines: concrete skills, tools, domains they own",` +
    `"personality":"tone of voice, character quirks, how they talk",` +
    `"language":"primary reply language, e.g. ไทย / English / ตามผู้ใช้",` +
    `"rules":"3-6 imperative work rules (do/don't), one per line",` +
    (invent ? `"why":"1-2 sentences, same language as the brief: why hiring this helper is genuinely worth it",` : ``) +
    `"skills":["skill-id", ...],` +
    `"tools":["ToolName", ...]}\n` +
    `Every field must genuinely reflect the brief. skills/tools MUST be chosen ` +
    `ONLY from the lists above (exact ids/names). Match the brief's language ` +
    `(Thai brief → Thai text fields; skill ids and tool names stay verbatim).`);
  let out = { prompt: draft };
  const m = draft.match(/\{[\s\S]*\}/);
  if (m) try { out = JSON.parse(m[0]); } catch {}
  // Keep only ids/names that actually exist — never invent capabilities.
  if (Array.isArray(out.skills)) out.skills = out.skills.filter((s) => skillIds.includes(s));
  if (Array.isArray(out.tools)) out.tools = out.tools.filter((t) => toolIds.includes(t));
  return out;
}

async function generateNpcProposal(requesterId, role, reason, benefit) {
  // 1) persona — the shared copilot; template fallbacks keep the flow alive
  //    and guarantee every registry field is present and non-junk.
  const requesterName = (reg.agents[requesterId] || {}).name || requesterId;
  let g = {};
  try {
    g = await draftAgentPersona({ role, invent: true, brief:
      "ตำแหน่ง: " + role + ". งานที่ต้องการให้ช่วย: " + reason +
      (benefit ? ". ประโยชน์ที่คาดหวัง: " + benefit : "") +
      ". (ผู้ขอ: " + requesterName + ")" });
  } catch (e) { console.log("[npc] persona via template (draft:", e.message + ")"); }
  const name = String(g.name || "ผู้ช่วย " + role).trim().slice(0, 40);
  const prompt = String((g.prompt && String(g.prompt).trim().length >= 30) ? g.prompt :
    "คุณคือ " + name + " ผู้ช่วยตำแหน่ง " + role + " ของออฟฟิศ รับผิดชอบ: " + reason +
    " ทำงานเป็นระบบ ส่งงานไว สื่อสารสั้นกระชับ ภาษาไทย").slice(0, 4000);
  // persona block mirrors the agent editor's four fields exactly.
  const persona = {
    expertise: String(g.expertise || role + " — " + reason).slice(0, 1500),
    personality: String(g.personality || "มืออาชีพ สุภาพ สื่อสารสั้นกระชับ").slice(0, 1500),
    language: String(g.language || "ไทย").slice(0, 80),
    rules: String(g.rules || "ตรวจงานตัวเองก่อนส่งเสมอ\nรายงานผลสั้นและตรงประเด็น").slice(0, 1500),
  };
  const skills = (Array.isArray(g.skills) ? g.skills : []).slice(0, 6);
  const tools = (Array.isArray(g.tools) && g.tools.length ? g.tools : ["Read", "Glob", "Grep"]).slice(0, 8);
  // 2) cosmetics — picked deterministically from the REAL editor option sets
  //    (varied per character, no extra model call, always renderable).
  const aura = NPC_AURAS[hashInt(name + "|" + role) % NPC_AURAS.length];
  const voiceIds = Object.keys(VOICE_PRESETS);
  const voice = voiceIds[hashInt(role + "|" + name) % voiceIds.length];
  // 3) model — light/fast → haiku, heavy/design → sonnet (per-agent catalog ids).
  const heavy = /ออกแบบ|สถาปัต|วิจัย|ซับซ้อน|review|architect|design|research/i
    .test(role + " " + reason);
  const model = heavy ? "claude-sonnet-4-6" : LIGHT_MODEL;
  // 4) avatar — best effort, capped wait; never fails the proposal.
  let avatarPath = "";
  try {
    const img = await Promise.race([
      genImage("cute pixel-art style office worker avatar portrait, " + role +
        ", friendly, simple flat background, game character"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("avatar timeout")), 60000).unref()),
    ]);
    avatarPath = img.url || img.path || "";
  } catch (e) { console.log("[npc] no avatar:", e.message); }
  const why = String(g.why || reason).slice(0, 1000);
  return { requestId: "npc" + Date.now(), requester: requesterId,
    name, role: String(role).slice(0, 40),
    prompt, persona, tier: 3, aura, voice,
    skills, tools, model, avatarPath,
    why, benefit: String(benefit || "").slice(0, 500), ts: Date.now() };
}

// --------------------------------------------------------------- voice lines
// 🗣 Dialogue engine (docs/voice-lines.contract.md): EVERYTHING an agent says
// outside real work comes through here, in THAI, in character —
//   • done lines   — task.completed announcements (per-agent `bank`)
//   • ambient      — idle musings (per-agent `ambient.bank`)
//   • interactions — real context-aware scenes with another agent or with the
//                    office cat / dog / coffee machine… (`@scenes` pools)
// gpt-4o-mini is the writer but ONLY runs in the refill paths (batch, async,
// in-flight guard + failure cooldown) — never per tick, so cost stays flat
// (token-forensics lesson). Thai template fallbacks keep the office talking
// with OpenAI completely down. Nothing here ever blocks a work flow.
const VOICE_LINES_FILE = path.join(__dirname, "voice-lines.json");
let voiceLines = loadJson(VOICE_LINES_FILE, {});
function saveVoiceLines() {
  try { fs.writeFileSync(VOICE_LINES_FILE, JSON.stringify(voiceLines, null, 2)); } catch {}
}
const VOICE_RECENT_N = 20;
const VOICE_MIN_GAP_MS = 45000;   // anti-spam: at most one line per agent / 45s
const VOICE_FALLBACK = ["เสร็จแล้วครับ ✅", "งานนี้เรียบร้อย!", "จัดการเรียบร้อยแล้ว 🎉",
  "เสร็จเรียบร้อย ตรวจได้เลย", "ภารกิจสำเร็จ ✨"];
const voiceLastSaid = {};        // agentId -> ts

// A spoken line must be real Thai: reject mojibake (U+FFFD), strings with no
// Thai at all, AND mixed lines carrying Latin words ("Feeling good วันนี้") —
// the filter that keeps every shade of English out of every pool.
function cleanThaiLine(s) {
  // verdict on the RAW trimmed string — slicing first could hide a Latin tail.
  s = String(s || "").trim();
  if (!s || s.includes("�") || !/[฀-๿]/.test(s) || /[A-Za-z]/.test(s)) return "";
  return s.slice(0, 140);
}

// One-time hygiene on load: drop banks of agents that no longer exist and
// strip non-Thai / corrupted lines that older generations let in. The file
// itself can't be hand-edited (the daemon owns and rewrites it), so the
// cleanup lives here.
(function sanitizeVoiceLines() {
  let changed = false;
  for (const [id, v] of Object.entries(voiceLines)) {
    if (id === "@scenes") {
      // scene pools replay straight from this cache (pickScene) — scrub each
      // line's text and drop scenes/pools that come out empty.
      for (const [key, p] of Object.entries(v || {})) {
        if (!p || typeof p !== "object") { delete v[key]; changed = true; continue; }
        const bank = (Array.isArray(p.bank) ? p.bank : [])
          .map((sc) => (Array.isArray(sc) ? sc : [])
            .map((l) => ({ who: l && l.who, text: cleanThaiLine(l && l.text) }))
            .filter((l) => l.who && l.text))
          .filter((sc) => sc.length);
        if (bank.length !== (p.bank || []).length ||
            JSON.stringify(bank) !== JSON.stringify(p.bank || [])) changed = true;
        p.bank = bank;
        const firsts = new Set(bank.map((sc) => sc[0].text));
        const recent = (Array.isArray(p.recent) ? p.recent : []).filter((t) => firsts.has(t));
        if (recent.length !== (p.recent || []).length) changed = true;
        p.recent = recent;
        if (!bank.length && !recent.length) { delete v[key]; changed = true; }
      }
      continue;
    }
    if (!reg.agents[id] || !v || typeof v !== "object") {
      delete voiceLines[id]; changed = true; continue;
    }
    for (const pool of [v, v.ambient].filter(Boolean)) {
      for (const k of ["bank", "recent"]) {
        const arr = Array.isArray(pool[k]) ? pool[k] : [];
        // keep the SCRUBBED value (trim/cap), not the original string.
        const kept = arr.map(cleanThaiLine).filter(Boolean);
        if (kept.length !== arr.length || kept.some((s, i) => s !== arr[i])) changed = true;
        pool[k] = kept;
      }
    }
  }
  if (changed) { saveVoiceLines(); console.log("[voice] sanitized voice-lines.json (Thai-only)"); }
})();

function voiceBankOf(id) {
  return voiceLines[id] || (voiceLines[id] = { bank: [], recent: [] });
}

function personaBrief(id) {
  const a = reg.agents[id] || {};
  const px = a.persona || {};
  return "ชื่อ: " + (a.name || id) + " (ตำแหน่ง " + (a.role || "พนักงาน") + ")\n" +
    "ตัวตน: " + String(a.prompt || "").slice(0, 500) + "\n" +
    "นิสัย/โทนเสียง: " + String(px.personality || "").slice(0, 300);
}

// THE single gpt-4o-mini funnel for every dialogue pool. Guards are the cost
// story: an in-flight set (one call per pool at a time) plus a cooldown after
// any attempt (success refills last a long time; failures don't hammer).
const REFILL_COOLDOWN_MS = 10 * 60000;
const refillBusy = new Set();    // pool keys mid-flight
const refillLastTry = {};        // pool key -> ts of last attempt
async function refillPool(key, prompt, apply, maxTokens) {
  if (refillBusy.has(key)) return;
  if (Date.now() - (refillLastTry[key] || 0) < REFILL_COOLDOWN_MS) return;
  refillBusy.add(key);
  refillLastTry[key] = Date.now();
  try {
    const txt = await openaiChat([
      { role: "system", content:
        "คุณคือนักเขียนบทพูดของตัวละครในออฟฟิศเสมือน เขียนภาษาไทยล้วนที่เป็นธรรมชาติ " +
        "เหมือนคนคุยกันจริงๆ ห้ามภาษาอังกฤษทั้งประโยค (ศัพท์เทคนิคทับศัพท์ได้) ตอบเป็น JSON เท่านั้น" },
      { role: "user", content: prompt },
    ], { json: true, maxTokens: maxTokens || 700, timeoutMs: 30000 });
    apply(JSON.parse(txt));
    saveVoiceLines();
  } catch (e) { console.log("[voice] refill failed (" + key + "):", e.message);
  } finally { refillBusy.delete(key); }
}

// Shared freshness picker: random line not in `recent` (never the very last
// one), falling back to the whole bank then to the Thai templates.
function pickFreshLine(pool, fallback) {
  const fresh = pool.bank.filter((s) => !pool.recent.includes(s));
  const last = pool.recent[pool.recent.length - 1];
  const base = fresh.length ? fresh : (pool.bank.length ? pool.bank : fallback);
  const cand = base.filter((s) => s !== last);
  const list = cand.length ? cand : base;
  const text = list[Math.floor(Math.random() * list.length)];
  pool.recent = [...pool.recent.filter((s) => s !== text), text].slice(-VOICE_RECENT_N);
  return text;
}

// ---- done lines (task.completed announcements) ------------------------------
function refillVoiceBank(agentId) {
  refillPool("done:" + agentId,
    personaBrief(agentId) + "\n\n" +
    "แต่ง \"ประโยคประกาศว่าทำงานเสร็จแล้ว\" ภาษาไทยล้วน สั้นๆ (ไม่เกิน ~12 คำ) จำนวน 10 ประโยค " +
    "ให้ตรงคาแรกเตอร์นี้เป๊ะๆ หลากหลายแนว ไม่ซ้ำกันเอง ใส่อีโมจิได้เล็กน้อย " +
    'ตอบ JSON: {"lines":["...", "..."]}',
    (j) => {
      const lines = (j.lines || []).map(cleanThaiLine).filter(Boolean);
      if (!lines.length) return;
      const v = voiceBankOf(agentId);
      v.bank = [...new Set([...v.bank, ...lines])].slice(-60);
      console.log("[voice] bank refilled: " + agentId + " +" + lines.length);
    });
}

function pickVoiceLine(agentId) {
  const v = voiceBankOf(agentId);
  // Lazy init + low-freshness refill run in the background — never block.
  if (!v.bank.length || v.bank.filter((s) => !v.recent.includes(s)).length < 3)
    refillVoiceBank(agentId);
  const text = pickFreshLine(v, VOICE_FALLBACK);
  saveVoiceLines();
  return text;
}

// ---- ambient lines (idle musings, per agent) --------------------------------
function ambientPoolOf(id) {
  const v = voiceBankOf(id);
  return v.ambient || (v.ambient = { bank: [], recent: [] });
}

function refillAmbientBank(agentId) {
  refillPool("amb:" + agentId,
    personaBrief(agentId) + "\n\n" +
    "แต่ง \"ประโยคพึมพำ/คุยเล่นสั้นๆ ระหว่างพักในออฟฟิศ\" ภาษาไทยล้วน (ไม่เกิน ~12 คำ) จำนวน 14 ประโยค " +
    "เรื่องสัพเพเหระรอบตัว เช่น กาแฟ เพลง แมว/หมาออฟฟิศ อากาศ ความรู้สึกกับงานช่วงนี้ " +
    "ให้เสียงเหมือนคนนี้พูดเองจริงๆ ตามนิสัยข้างบน หลากหลายแนว ไม่ซ้ำกันเอง อีโมจิได้นิดหน่อย " +
    'ตอบ JSON: {"lines":["...", "..."]}',
    (j) => {
      const lines = (j.lines || []).map(cleanThaiLine).filter(Boolean);
      if (!lines.length) return;
      const p = ambientPoolOf(agentId);
      p.bank = [...new Set([...p.bank, ...lines])].slice(-40);
      console.log("[voice] ambient refilled: " + agentId + " +" + lines.length);
    });
}

function pickAmbientLine(agentId) {
  const p = ambientPoolOf(agentId);
  if (!p.bank.length || p.bank.filter((s) => !p.recent.includes(s)).length < 4)
    refillAmbientBank(agentId);
  const text = pickFreshLine(p, AMBIENT_FALLBACK);
  saveVoiceLines();
  return text;
}

// ---- interaction scenes (agent ↔ agent / cat / dog / objects) ----------------
// A scene is real dialogue written for the EXACT participants and situation
// ([{who, text}, …]), cached per (context, cast) under voiceLines["@scenes"]
// so replays are free; gpt-4o-mini only writes when a pool runs dry.
const INTERACT_CONTEXTS = [
  { id: "cat",    solo: true,  what: "แมวส้มประจำออฟฟิศที่ชอบงีบบนโซฟา และมีประวัติเดินเหยียบคีย์บอร์ดคนอื่น" },
  { id: "dog",    solo: true,  what: "หมาคอร์กี้ประจำออฟฟิศ ขี้อ้อน ชอบวิ่งมาคลอเคลียตอนคนกำลังยุ่งที่สุด" },
  { id: "coffee", solo: true,  what: "เครื่องชงกาแฟในแคนทีนที่กาแฟชอบหมด หรือชงช้าตอนรีบเป็นพิเศษ" },
  { id: "plant",  solo: true,  what: "ต้นไม้กระถางข้างโต๊ะทำงานที่ต้องคอยรดน้ำ บางทีก็ใบเหลืองเพราะถูกลืม" },
  { id: "pantry", solo: false, what: "บังเอิญเจอกันที่แคนทีนตอนพักเบรก มีกาแฟกับขนม" },
  { id: "sofa",   solo: false, what: "นั่งพักที่โซฟากลางออฟฟิศ ข้างๆ มีแมวส้มงีบอยู่" },
  { id: "garden", solo: false, what: "เดินเล่นในสวนหน้าออฟฟิศช่วงพัก ไฟสวนเพิ่งติด" },
  { id: "board",  solo: false, what: "ยืนคุยหน้าไวท์บอร์ดที่มีไอเดียโปรเจคเก่าเขียนค้างไว้" },
];
const SOLO_FALLBACK = {
  cat: ["เจ้าเหมียว วันนี้ขออย่าเหยียบคีย์บอร์ดนะ 🐱", "นอนทั้งวันเลยนะแก… อิจฉาชีวิตจริงๆ",
    "ขนนุ่มแบบนี้ใครจะไปทำงานลงเนี่ย"],
  dog: ["มาๆ เกาพุงให้แป๊บนึง แต่เดี๋ยวต้องกลับไปทำงานนะ 🐶", "ใครเป็นเด็กดี๊ดี วันนี้ห้ามคาบปากกาไปซ่อนนะ",
    "อย่าเพิ่งกวนตอนนี้สิ กำลังคิดงานอยู่… เอ้า ก็ได้ แป๊บเดียวนะ"],
  coffee: ["เครื่องชงขา อย่าเพิ่งงอแงตอนนี้นะ ☕", "กาแฟหมดอีกแล้ว… ใครชงทีครึ่งโถอีกล่ะเนี่ย",
    "ชงช้าแบบนี้รู้นะว่าแกล้งกัน"],
  plant: ["รดน้ำให้แล้วนะ โตไวๆ ล่ะ 🌱", "ใบเหลืองแล้วเหรอ ขอโทษๆ ลืมรดน้ำจริงด้วย",
    "เธอนี่โตเร็วกว่าโปรเจคบางตัวอีกนะ"],
};
const SCENE_RECENT_N = 6;
const SCENE_BANK_MAX = 12;

function scenePoolOf(key) {
  const root = voiceLines["@scenes"] || (voiceLines["@scenes"] = {});
  return root[key] || (root[key] = { bank: [], recent: [] });
}

function sceneKeyOf(ctx, ids) { return ctx.id + "::" + ids.slice().sort().join("+"); }

function refillSceneBank(ctx, ids) {
  const key = sceneKeyOf(ctx, ids);
  const names = ids.map((id) => (reg.agents[id] || { name: id }).name);
  refillPool("scene:" + key,
    "ตัวละคร:\n" + ids.map(personaBrief).join("\n---\n") + "\n\n" +
    "สถานการณ์: " + (ctx.solo
      ? names[0] + " อยู่กับ" + ctx.what + " (อีกฝ่ายพูดไม่ได้ — ให้ " + names[0] +
        " พูดกับมันหรือพึมพำกับตัวเองแบบที่คนทำจริงๆ)"
      : names.join(" กับ ") + " " + ctx.what) + "\n\n" +
    "เขียนบทสนทนา 3 ฉาก ฉากละ " + (ctx.solo ? "1-2" : "3-4") + " ประโยคสั้นๆ ภาษาไทยล้วน " +
    "ต้องเป็นคำพูดที่พูดออกมาแล้วเป็นธรรมชาติจริง อิงสถานการณ์และนิสัยของแต่ละคนตรงๆ " +
    "ห้ามประโยค generic ที่ใครพูดก็ได้ แต่ละฉากต้องไม่ซ้ำแนวกัน " +
    'ตอบ JSON: {"scenes":[[{"who":"<ชื่อตัวละคร>","text":"คำพูด"}], …]}',
    (j) => {
      const byName = {};
      ids.forEach((id) => { byName[(reg.agents[id] || { name: id }).name] = id; byName[id] = id; });
      const scenes = (j.scenes || [])
        .map((sc) => (Array.isArray(sc) ? sc : [])
          .map((l) => ({ who: byName[String(l.who || "").trim()] || (ids.length === 1 ? ids[0] : ""),
            text: cleanThaiLine(l.text) }))
          .filter((l) => l.who && l.text))
        .filter((sc) => sc.length);
      if (!scenes.length) return;
      const p = scenePoolOf(key);
      const seen = new Set(p.bank.map((sc) => sc[0].text));
      for (const sc of scenes) if (!seen.has(sc[0].text)) { p.bank.push(sc); seen.add(sc[0].text); }
      p.bank = p.bank.slice(-SCENE_BANK_MAX);
      console.log("[voice] scenes refilled: " + key + " → " + p.bank.length);
    }, 900);
}

// Cached scene or null (caller falls back to templates). Refill kicks off in
// the background whenever freshness runs low — next replay hits the cache.
function pickScene(ctx, ids) {
  const p = scenePoolOf(sceneKeyOf(ctx, ids));
  const fresh = p.bank.filter((sc) => !p.recent.includes(sc[0].text));
  if (!p.bank.length || fresh.length < 2) refillSceneBank(ctx, ids);
  if (!fresh.length) return null;
  const sc = fresh[Math.floor(Math.random() * fresh.length)];
  p.recent = [...p.recent.filter((t) => t !== sc[0].text), sc[0].text].slice(-SCENE_RECENT_N);
  saveVoiceLines();
  return sc;
}

// Nameless pure-Thai pair beats — the floor when a BANTER line dies in the
// sanitizer (an interpolated agent name can carry Latin, e.g. "มิสเตอร์ N").
const PAIR_FALLBACK = [
  ["พักแป๊บมั้ย เมื่อยจอละ", "เอาสิ ชงกาแฟไปด้วยเลย ☕"],
  ["งานวันนี้ลื่นดีนะ", "เออ ขอให้เป็นแบบนี้ทุกวันเถอะ 😌"],
  ["เดี๋ยวเย็นนี้ไปยืดเส้นกันหน่อยมั้ย", "ไปสิ นั่งทั้งวันหลังจะงอแล้ว 🤸"],
];

function fallbackScene(ctx, ids) {
  if (ctx.solo) {
    const lines = SOLO_FALLBACK[ctx.id] || ["ว่าไงเจ้าเพื่อนยาก วันนี้เป็นไงบ้าง"];
    return [{ who: ids[0], text: lines[Math.floor(Math.random() * lines.length)] }];
  }
  const tpl = BANTER[Math.floor(Math.random() * BANTER.length)];
  const nameOf = (id) => (reg.agents[id] || { name: id }).name;
  // every spoken fallback line passes the same Thai-only bar as the cache.
  const lines = tpl.map((t) => ({
    who: t.startsWith("{a}") ? ids[0] : ids[1],
    text: cleanThaiLine(t.replace(/\{a\}:\s*/, "").replace(/\{b\}:\s*/, "")
      .replace(/\{a\}/g, nameOf(ids[0])).replace(/\{b\}/g, nameOf(ids[1]))),
  })).filter((l) => l.text);
  if (lines.length) return lines;
  const pf = PAIR_FALLBACK[Math.floor(Math.random() * PAIR_FALLBACK.length)];
  return pf.map((text, i) => ({ who: ids[i % ids.length], text }));
}

// Play one interaction beat. opts: {ids:[...]} to force a cast (socialTick's
// pair), {ctxId} to force a situation (tests). Returns the played scene info
// or false when there is nobody to put in it.
function playInteractScene(pool, opts = {}) {
  let ids = Array.isArray(opts.ids) && opts.ids.length ? opts.ids.slice(0, 2) : null;
  let ctxs = INTERACT_CONTEXTS.filter((c) =>
    (opts.ctxId ? c.id === opts.ctxId : true) &&
    (ids ? c.solo === (ids.length === 1) : (c.solo || pool.length >= 2)));
  if (!ctxs.length || (!ids && !pool.length)) return false;
  const ctx = ctxs[Math.floor(Math.random() * ctxs.length)];
  if (!ids) {
    const shuffled = pool.slice().sort(() => Math.random() - 0.5);
    ids = shuffled.slice(0, ctx.solo ? 1 : 2);
    if (ids.length < (ctx.solo ? 1 : 2)) return false;
  }
  const cached = pickScene(ctx, ids);
  const scene = cached || fallbackScene(ctx, ids);
  const task = "soc" + (Date.now() % 100000);
  const pair = ids.length > 1;
  if (pair) broadcast({ type: "collab.started", agents: ids, task, text: "พักเบรก ☕" });
  scene.forEach((l, i) => {
    setTimeout(() => {
      broadcast({ type: "chat.message", agent: l.who, task, text: l.text,
        social: true, ambient: !pair });
      const a = reg.agents[l.who] || {};
      if (i === 0 && a.voice && featuresMap().tts && reg.tts !== false && Math.random() < 0.6)
        broadcast({ type: "voice.say", agent: l.who, text: l.text });
    }, 2500 + i * 3600);
  });
  if (pair) setTimeout(() => broadcast({ type: "collab.ended", agents: ids, task }),
    2500 + scene.length * 3600 + 2500);
  return { ctx: ctx.id, agents: ids, lines: scene, source: cached ? "cache" : "fallback" };
}

function voiceAnnounce(agentId, force) {
  const base = String(agentId).split("#")[0];   // ghosts speak as their parent
  if (base === "ceo") return null;
  const now = Date.now();
  if (!force && now - (voiceLastSaid[base] || 0) < VOICE_MIN_GAP_MS) return null;
  voiceLastSaid[base] = now;
  const text = pickVoiceLine(base);
  const a = reg.agents[base] || {};
  broadcast({ type: "voice.say", agentId: base, text,
    ...(a.voice ? { voice: a.voice } : {}) }, false);
  broadcast({ type: "agent.done", agentId: base, text }, false);
  return text;
}

function readBody(req, cb) {
  // Collect raw bytes and decode once as UTF-8. Decoding per-chunk (body += c)
  // corrupts any multibyte char (e.g. 3-byte Thai) that straddles a chunk boundary.
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => cb(Buffer.concat(chunks).toString("utf8")));
}

function readBodyRaw(req, cb) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => cb(Buffer.concat(chunks)));
}

const MAPBG = path.join(__dirname, "map_bg.png");
const LAYOUT_FILE = path.join(__dirname, "layout.json");   // Office Editor
const PRESETS_FILE = path.join(__dirname, "presets.json"); // saved layouts
const ASSETS_FILE = path.join(__dirname, "assets.json");   // imported models/images
const WORK_SUMMARY = path.join(__dirname, "work-summary.json"); // latest Work Summary Modal

// Media file server for chat rendering (images / video / audio only).
const MEDIA_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
  pdf: "application/pdf" };
function serveMedia(res, full, req) {
  const ext = full.split(".").pop().toLowerCase();
  const mime = MEDIA_MIME[ext];
  if (!mime) { res.writeHead(415); return res.end("not a media file"); }
  fs.stat(full, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end(); }
    const total = st.size;
    const range = req && req.headers && req.headers.range;
    // Range support is REQUIRED for <video> to play/seek in Chromium/WebView2.
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (!(start >= 0)) start = 0;
      if (!(end < total)) end = total - 1;
      if (start > end) { res.writeHead(416, { "content-range": `bytes */${total}` }); return res.end(); }
      res.writeHead(206, { "content-type": mime, "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${total}`, "content-length": end - start + 1,
        "cache-control": "max-age=300" });
      fs.createReadStream(full, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "content-type": mime, "accept-ranges": "bytes",
        "content-length": total, "cache-control": "max-age=300" });
      fs.createReadStream(full).pipe(res);
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url.split("?")[0] === "/" || req.url.split("?")[0] === "/index.html"
      || req.url.split("?")[0] === "/overlay.html")) {
    // `/overlay.html` is an alias of `/` (and `/index.html`): the overlay is
    // mapped to the root URL, but curling its real filename used to 404 — a
    // misleading "the file isn't served" signal during front-end debugging.
    // Serving it here keeps route↔file names intuitive without a second reader.
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(fs.readFileSync(OVERLAY));

  } else if (req.method === "GET" && req.url.split("?")[0] === "/win") {
    // Custom-chrome frame for pop-out windows (dark title bar + the content in
    // an iframe) so plugin windows match the app instead of a bare OS frame.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    try { res.end(fs.readFileSync(path.join(__dirname, "win.html"))); }
    catch { res.end("<p>window frame unavailable</p>"); }

  } else if (req.method === "GET" && req.url.split("?")[0] === "/winlang.js") {
    // Shared auto-translate helper for pop-out windows (Tools/Plugins Hub,
    // Workflow Builder): Thai source → office language via /i18n (cached + seeded).
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    try { res.end(fs.readFileSync(path.join(__dirname, "winlang.js"))); }
    catch { res.end("window.WinLang={build:async()=>({lang:'th',map:{},tr:s=>s,ensure:async()=>{}})};"); }

  } else if (req.method === "GET" && req.url.split("?")[0] === "/watch") {
    // Read-only live activity stream for an agent (opened as its own window) —
    // it only listens on the WS, never sends, so it can't disturb the agent.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    try { res.end(fs.readFileSync(path.join(__dirname, "watch.html"))); }
    catch { res.end("<p>watch unavailable</p>"); }

  } else if (req.method === "GET" && req.url.split("?")[0] === "/workflow") {
    // The human-language Workflow Builder canvas (opened as its own window).
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    try { res.end(fs.readFileSync(path.join(__dirname, "workflow.html"))); }
    catch { res.end("<p>workflow builder unavailable</p>"); }

  } else if (req.method === "GET" && req.url.split("?")[0] === "/toolshub") {
    // Tools Hub — a curated MCP-server catalog (browser, Google, DB…) to add new
    // agent capabilities in one click.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    try { res.end(fs.readFileSync(path.join(__dirname, "toolshub.html"))); }
    catch { res.end("<p>tools hub unavailable</p>"); }

  } else if (req.method === "GET" && req.url.split("?")[0] === "/pluginshub") {
    // Plugins Hub — the community plugin catalog, browse + one-click install.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    try { res.end(fs.readFileSync(path.join(__dirname, "pluginshub.html"))); }
    catch { res.end("<p>plugins hub unavailable</p>"); }

  } else if (req.method === "GET" && req.url.split("?")[0] === "/plugins/catalog") {
    // The community plugin catalog — fetched LIVE from the website (so PR-curated
    // additions show up without waiting for an office update), falling back to the
    // copy bundled in the repo so it always works offline. Server-side fetch = no
    // CORS dance for the hub page.
    const sendLocal = () => {
      let txt = '{"plugins":[]}';
      try { txt = fs.readFileSync(path.join(__dirname, "..", "web", "plugins.json"), "utf8"); } catch {}
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(txt);
    };
    try {
      const https = require("https");
      const rq = https.get(
        "https://raw.githubusercontent.com/bagidea/bagidea-office/main/web/plugins.json",
        { timeout: 3500, headers: { "user-agent": "bagidea-office" } }, (rs) => {
          if (rs.statusCode !== 200) { rs.resume(); return sendLocal(); }
          let d = ""; rs.on("data", (c) => (d += c));
          rs.on("end", () => {
            try { JSON.parse(d); res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(d); }
            catch { sendLocal(); }
          });
        });
      rq.on("error", sendLocal);
      rq.on("timeout", () => { rq.destroy(); sendLocal(); });
    } catch { sendLocal(); }

  } else if (req.method === "GET" && /^\/brand\/logo[a-z_]*\.png$/.test(req.url)) {
    const f = path.join(__dirname, "..", "godot", "assets", "brand", req.url.split("/").pop());
    fs.readFile(f, (e, data) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
      res.end(data);
    });

  } else if (req.method === "GET" && req.url.startsWith("/sfx/")) {
    // UI sounds from the (gitignored) sound pack — overlay falls back to a
    // tiny synth when a file is missing.
    const name = decodeURIComponent(req.url.slice(5)).replace(/[\\/]|\.\./g, "");
    const f = path.join(__dirname, "..", "godot", "assets", "sounds", name);
    fs.readFile(f, (e, data) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "audio/wav", "cache-control": "max-age=86400" });
      res.end(data);
    });

  } else if (req.method === "GET" && /^\/char\/npc([1-9]|1[0-2])\.png$/.test(req.url)) {
    // Character sheets for overlay portraits (404 → CSS falls back to initials)
    const f = path.join(__dirname, "..", "godot", "assets", "characters", "npc",
      req.url.split("/").pop());
    fs.readFile(f, (e, data) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
      res.end(data);
    });

  } else if (req.method === "POST" && req.url === "/chat") {
    readBody(req, (body) => {
      try {
        let { agent = "main", prompt, session, wait, voice,
              project: projReq } = JSON.parse(body);
        if (!prompt) throw new Error("no prompt");
        // Routing: the picker's explicit choice wins (id/name/path all fine),
        // then a project named in the prompt. A run still left projectless is
        // adopted by the home project inside runClaude — never the old
        // workspace "Default" again.
        const project = resolveProjectRef(projReq) || projectFromPrompt(prompt);
        // wait:true (the CLI's ask) holds the response until the run truly
        // finishes and returns the final text.
        let waited = null;
        if (wait) {
          const safety = setTimeout(() => {
            if (waited) { waited = null;
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, text: "(timeout 10 นาที — งานยังทำต่อเบื้องหลัง)" })); }
          }, 10 * 60000);
          waited = (text, ok) => {
            clearTimeout(safety);
            if (!waited) return;
            waited = null;
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok, text: String(text || "") }));
          };
        }
        // 🛡 Roster gate (sync twin of the startClaudeRun guard, so the
        // caller gets a real 404 instead of a dead task id): an agent id
        // that never passed CEO approval must not get a run, a session or a
        // scene sprite out of /chat.
        if (agent !== "ceo" && !reg.agents[String(agent).split("#")[0]]) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          return res.end("unknown agent: " + String(agent).slice(0, 40) +
            " — agent ใหม่ต้องผ่าน npc.request → CEO อนุมัติ (/npc/decision) ก่อน");
        }
        // CEO orders route through the Director; talking to the Director
        // directly gives him the same dispatch power. New threads adopt the
        // requested project workspace.
        const startRun = () => agent === "ceo"
          ? ceoFlow(prompt, session, project,
              { logPrompt: voice ? "🎤👑 (สั่งด้วยเสียง) " + prompt : undefined,
                relay: true,  // mirror the CEO conversation to connected channels
                onDone: wait ? (t, ok) => waited && waited(t, ok) : undefined })
          : agent === "main"
            ? runClaude("main", prompt + directorNote(),
                { session, project, logPrompt: prompt,
                  filterText: makeDelegateFilter(0, session),
                  onDone: wait ? (t, ok) => waited && waited(t, ok) : undefined })
            : (() => {
                // 📨 DIRECT order (CEO opens an agent's chat and instructs it
                // straight, no DELEGATE). DELEGATE'd work reports back via
                // reportToMain; a direct order had NO path back, so the CEO had
                // to open the agent thread to read the result. Snapshot the tree
                // now so reportDirectWork can tell a real deliverable from a
                // pure chat, then report on completion — without touching the
                // agent's own onDone contract or interrupting its session.
                const dRef = resolveProjectRef(project);
                const dDir = dRef && projectDir(dRef);
                const baseSig = gitTreeSig(dDir);
                return runClaude(agent, prompt, { session, project,
                  onDone: (t, ok) => {
                    try { if (ok) reportDirectWork(agent, dRef, prompt, t, dDir, baseSig); }
                    catch (e) { console.error("[directReport]", e && e.message); }
                    if (wait) waited && waited(t, ok);
                  } });
              })();
        // 🚧 Auto-Scan gate: a first-touch project scans BEFORE the run starts.
        // Inline ("ready") → task id is real; gated ("scanning") → task:null +
        // gate fields, the FE follows ws scan.gate / polls /project/scan/status,
        // and the run auto-starts on release (its task.started event arrives then).
        let task = null;
        const gate = gateOnScan(project, () => { task = startRun(); });
        if (!wait) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(gate === "scanning"
            ? { task: null, gate: "scanning", project }
            : { task }));
        }
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "GET" && req.url.startsWith("/sessions/log")) {
    // Per-thread chat history for the overlay.
    const q = new URL(req.url, "http://x").searchParams;
    const entry = (sess[q.get("agent")] || []).find((e) => e.key === q.get("key"));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ log: (entry && entry.log) || [] }));

  } else if (req.method === "GET" && req.url === "/sessions/all") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ all: sess }));

  } else if (req.method === "POST" && req.url === "/sessions/delete") {
    readBody(req, (body) => {
      try {
        const { agent, key } = JSON.parse(body);
        sess[agent] = (sess[agent] || []).filter((s) => s.key !== key);
        if (!sess[agent].length) delete sess[agent];
        saveSess();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "GET" && req.url.startsWith("/sessions")) {
    const agent = new URL(req.url, "http://x").searchParams.get("agent") || "main";
    const list = (sess[agent] || []).slice().sort((a, b) => b.ts - a.ts).slice(0, 20);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessions: list }));

  } else if (req.method === "POST" && req.url === "/discuss") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        const ids = (p.agents || []).filter((id) => id !== "ceo").slice(0, 4);
        if (ids.length < 2) throw new Error("need at least 2 agents");
        if (!p.topic) throw new Error("no topic");
        // Concurrent meetings are allowed — disjoint teams huddle in parallel,
        // and the wallpaper ghost-splits anyone double-booked.
        // contract: `project` = project id (path/display-name also resolve). Empty = legacy.
        const project = p.project ? String(p.project) : "";
        runDiscussion(ids, String(p.topic), Math.min(Math.max(Number(p.rounds) || 2, 1), 3), false, project);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/map/bg") {
    // Godot ships a one-shot orthographic floorplan render at boot.
    readBodyRaw(req, (buf) => {
      fs.writeFile(MAPBG, buf, () => {});
      broadcast({ type: "ui.mapbg" }, false);  // overlays refresh the image
      res.writeHead(200);
      res.end("ok");
    });

  } else if (req.method === "GET" && req.url.startsWith("/map/bg")) {
    fs.readFile(MAPBG, (e, data) => {
      if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(data);
    });

  } else if (req.method === "POST" && req.url === "/pos") {
    // 1 Hz live positions from the renderer → overlay map (never journaled).
    readBody(req, (body) => {
      try {
        broadcast({ type: "world.pos", agents: JSON.parse(body).agents }, false);
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });

  } else if (req.method === "GET" && req.url === "/registry") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reg));

  } else if (req.method === "GET" && req.url === "/agents/status") {
    // 🟢 Per-agent live status for the overlay — the whole roster, every
    // agent either working (with its project + short task) or idle. Same
    // payload as the ws `agent.status` event (overlay.html parses j.agents).
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ agents: agentStatusSnapshot() }));

  } else if (req.method === "POST" && req.url === "/registry/agent") {
    // Create or update an agent. Protected rows (main/ceo) accept edits but
    // never deletion; id is derived from the name on first save.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        const id = p.id || slugId(p.name);
        // 🛡 Governance: a BRAND-NEW agent may be created here only by the
        // CEO's own editor (x-bagidea-ui). Every other caller (agent shells,
        // scripts, curl) must go through npc.request → /npc/decision so the
        // approval modal stays the single hiring gate. Edits to existing
        // agents keep working for the editor as before.
        if (!reg.agents[id] && req.headers["x-bagidea-ui"] !== "1") {
          res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          return res.end("สร้าง agent ใหม่ตรงนี้ได้เฉพาะหน้า editor ของ CEO เท่านั้น — " +
            "ทางอื่นให้ยื่น npc.request แล้วรอ CEO อนุมัติผ่าน /npc/decision");
        }
        // Hire cap (MAX_STAFF, module constant) — CEO not counted.
        if (!reg.agents[id]) {
          if (staffCount() >= MAX_STAFF) {
            res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
            return res.end(`ออฟฟิศเต็มแล้ว — รับพนักงานได้สูงสุด ${MAX_STAFF} คน (ไม่นับ CEO). ` +
              `งานขนานให้ใช้การแตกร่างผี (sub-agents) แทน`);
          }
        }
        const cur = reg.agents[id] || { skills: [], tools: [] };
        const px = p.persona || cur.persona || {};
        reg.agents[id] = {
          ...cur,
          name: String(p.name || cur.name || id).slice(0, 40),
          role: String(p.role || cur.role || "ผู้เชี่ยวชาญ").slice(0, 40),
          avatar: Math.min(Math.max(Number(p.avatar) || cur.avatar || 1, 1), 12),
          aura: String(p.aura !== undefined ? p.aura : cur.aura || "").slice(0, 16),
          prompt: String(p.prompt !== undefined ? p.prompt : cur.prompt || "").slice(0, 8000),
          persona: {
            expertise: String(px.expertise || "").slice(0, 2000),
            personality: String(px.personality || "").slice(0, 2000),
            language: String(px.language || "").slice(0, 80),
            rules: String(px.rules || "").slice(0, 2000),
          },
          tier: Math.min(Math.max(Number(p.tier !== undefined ? p.tier : cur.tier) || 3, 1), 3),
          voice: String(p.voice !== undefined ? p.voice : cur.voice || "").slice(0, 20),
          skills: Array.isArray(p.skills) ? p.skills : cur.skills || [],
          tools: Array.isArray(p.tools) ? p.tools : cur.tools || [],
        };
        saveReg();
        pushRoster();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id }));
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/registry/agent/delete") {
    readBody(req, (body) => {
      try {
        const { id } = JSON.parse(body);
        const a = reg.agents[id];
        if (!a) { res.writeHead(404); return res.end("unknown agent"); }
        if (a.protected) { res.writeHead(403); return res.end("protected agent"); }
        delete reg.agents[id];
        saveReg();
        broadcast({ type: "roster.removed", agent: id }, false);
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/registry/skill") {
    // Create, update or remove a skill in the library. Removal also strips
    // the skill from every agent that had it assigned.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        if (p.remove) {
          delete reg.skills[p.id];
          for (const a of Object.values(reg.agents))
            a.skills = (a.skills || []).filter((s) => s !== p.id);
        } else {
          const id = p.id || slugId(p.name);
          reg.skills[id] = {
            ...(reg.skills[id] || {}),
            name: String(p.name || id).slice(0, 60),
            description: String(p.description || "").slice(0, 200),
            content: String(p.content || "").slice(0, 4000),
          };
        }
        if (retrievalOk) try {
          if (p.remove) retrieval.removeDoc("skill:" + p.id);
          else { const sid = p.id || slugId(p.name); retrieval.reindexSkill(sid, reg.skills[sid]); }
          retrieval.persist();
        } catch {}
        saveReg();
        // Keep the retrieval index's skill tier in step with the edit.
        try {
          if (retrievalOk) {
            if (p.remove) retrieval.removeDoc("skill:" + p.id);
            else { const sid = p.id || slugId(p.name); retrieval.reindexSkill(sid, reg.skills[sid]); }
            retrieval.persist();
          }
        } catch {}
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/registry/mcp") {
    // Custom capability = MCP servers (the Claude Code plugin standard).
    // name + launch command; assignment per agent via "mcp:<name>" entries.
    readBody(req, (body) => {
      try {
        const { name, command, remove } = JSON.parse(body);
        const n = String(name || "").trim().toLowerCase()
          .replace(/[^a-z0-9_-]/g, "-").slice(0, 40);
        if (!n) throw new Error("no name");
        if (remove) {
          delete reg.mcpServers[n];
          for (const a of Object.values(reg.agents))
            a.tools = (a.tools || []).filter((t) => t !== "mcp:" + n);
        } else {
          if (!command) throw new Error("no command");
          reg.mcpServers[n] = { command: String(command).trim().slice(0, 300) };
        }
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/project/scan") {
    // 🧠 Project Brain (docs/project-brain.contract.md) — scan → CodeGraph →
    // Mapping → Brain. buildBrain is sync + bounded (tookjorThai 6GB: 169ms).
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body || "{}");
        const pid = resolveProjectRef(p.project);
        const proj = projects.find((x) => x.id === pid);
        if (!proj) { res.writeHead(404); return res.end("unknown project"); }
        // Idempotent vs the Auto-Scan gate: a scan already in flight for this
        // project just reports "scanning" instead of building twice.
        if (scanGates.has(pid)) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ state: "scanning", projectId: pid }));
        }
        broadcast({ type: "scan.progress", project: proj.id,
          projectName: proj.name }, false);
        const { summary } = brain.buildBrain(proj, { now: Date.now() });
        broadcast({ type: "scan.done", project: proj.id, projectName: proj.name,
          stats: summary.stats }, false);
        broadcast({ type: "brain.ready", project: proj.id, projectName: proj.name,
          stats: summary.stats }, false);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(summary));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url.split("?")[0] === "/project/scan/status") {
    // 🚧 Auto-Scan gate state for the FE (docs/auto-scan-gate.contract.md).
    // ?project=<id|name|path> → that project's state; no param → every active
    // gate (for a global "scanning…" indicator).
    const q = new URL(req.url, "http://x").searchParams;
    const ref = q.get("project");
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    if (ref === null || ref === "") {
      const scanning = [...scanGates.entries()].map(([id, g]) => ({
        projectId: id, projectName: g.name, startedAt: g.startedAt, queued: g.queued.length }));
      return res.end(JSON.stringify({ scanning }));
    }
    const pid = resolveProjectRef(ref);
    if (!pid || !projects.find((x) => x.id === pid))
      return res.end(JSON.stringify({ state: "unknown", projectId: null }));
    const st = scanState(pid);
    const g = scanGates.get(pid);
    res.end(JSON.stringify({
      state: st,                       // "scanning" | "ready" | "unscanned"
      projectId: pid,
      ...(g ? { startedAt: g.startedAt, queued: g.queued.length } : {}),
    }));

  } else if (req.method === "GET" && req.url.split("?")[0] === "/project/brain") {
    // 🧠 cached brain; full=1 → include the whole graph.
    const q = new URL(req.url, "http://x").searchParams;
    const b = brain.getBrain(resolveProjectRef(q.get("project")), q.get("full") === "1");
    res.writeHead(b ? 200 : 404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(b || { error: "not scanned — POST /project/scan first" }));

  } else if (req.method === "GET" && req.url.split("?")[0] === "/fs/list") {
    // 📁 Browse for Add Project — directories only; no path → drive roots.
    try {
      const q = new URL(req.url, "http://x").searchParams.get("path") || "";
      const out = fsListDirs(q);   // may throw — must precede writeHead
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
    } catch (e) { res.writeHead(400); res.end(String(e.message)); }

  } else if (req.method === "POST" && req.url === "/projects/add") {
    // ➕ Register an EXISTING folder as a project. The folder must already
    // be there — unlike POST /projects, this never creates directories.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body || "{}");
        const dir = fsGuardedResolve(p.path);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
          throw new Error("path ไม่มีจริงหรือไม่ใช่โฟลเดอร์");
        const name = String(p.name || "").trim() || path.basename(dir);
        // createProject = the ONE shared path: dup-path / dup-name / place
        // guards live there. mkdirSync inside is a no-op (dir exists).
        const proj = createProject(name, null, dir);
        broadcast({ type: "project.added", project: proj.id, name: proj.name,
          dir: proj.dir }, false);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(proj));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/projects") {
    sweepProjects();  // freshen window truth in the background for next read
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ projects: projectStatus(), places: reg.places,
      home: homeProjectId() }));

  } else if (req.method === "POST" && req.url === "/projects") {
    // Register/create a project: name + (place shorthand | full path).
    // `remove` unregisters from the list only (files untouched);
    // `removeDisk` REALLY deletes the folder — allowed only for projects
    // this app created itself.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        // Removal is HUMAN-ONLY: the overlay sends this header; an agent's
        // curl can never unregister or delete a project again.
        const humanUI = !!req.headers["x-bagidea-ui"];
        if (p.remove) {
          if (!humanUI) { res.writeHead(403); return res.end("human UI only"); }
          // Closing/removing a project must also close its real OS window —
          // otherwise the terminal lingers, orphaned from a project that's gone.
          winproj("stop", String(p.remove).replace(/[^\w-]/g, ""), () => {});
          projects = projects.filter((x) => x.id !== p.remove);
          saveProjects();
          broadcast({ type: "projects.changed" }, false);
          res.writeHead(200); return res.end("ok");
        }
        if (p.removeDisk) {
          if (!humanUI) { res.writeHead(403); return res.end("human UI only"); }
          const proj = projects.find((x) => x.id === p.removeDisk);
          if (!proj) { res.writeHead(404); return res.end("unknown project"); }
          if (!proj.created) { res.writeHead(403); return res.end("not created by this app"); }
          // Folders die hard on Windows: a dev server an agent left running
          // (next dev, vite, …) or the project's own terminal keeps files
          // locked and rmSync silently half-deletes. Order of battle:
          // close our project window → kill processes anchored in the dir →
          // delete with retries → readable error if something still holds on.
          const pid = p.removeDisk;
          winproj("stop", pid, () => winproj("killdir", proj.dir, () => {
            setTimeout(() => {
              try {
                fs.rmSync(proj.dir, { recursive: true, force: true,
                  maxRetries: 6, retryDelay: 350 });
              } catch (e) {
                res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
                return res.end(`ลบไม่สำเร็จ — มีไฟล์ในโฟลเดอร์ถูกใช้งานอยู่ (${e.code || e.message}). ` +
                  `ปิดโปรแกรม/เทอร์มินัลที่ค้างอยู่ในโฟลเดอร์นี้แล้วกด 🗑 อีกครั้ง`);
              }
              projects = projects.filter((x) => x.id !== pid);
              saveProjects();
              broadcast({ type: "projects.changed" }, false);
              res.writeHead(200); res.end("ok");
            }, 700);
          }));
          return;
        }
        const proj = createProject(p.name, p.place, p.path);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(proj));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/projects/open") {
    // ▶ open = the smart claude entry (no sessions → claude, one → -c,
    // several → -r so the user picks). 🖥 shell = plain terminal, NOT
    // counted as "project open" (no liveness marker).
    readBody(req, (body) => {
      try {
        const { id, mode = "play" } = JSON.parse(body);
        const dir = projectDir(id);
        if (!dir) { res.writeHead(404); return res.end("unknown project"); }
        const launch = (psCmd, title) => {
          if (process.platform === "win32") {
            // Windows Terminal when present (beautiful Thai fonts; a NEW
            // window, default-profile fonts), classic conhost as fallback.
            // --suppressApplicationTitle LOCKS the title: it's how hide/resume
            // finds exactly OUR window — WT shares one process across every
            // window, so titles are the only safe handle.
            const line = HAS_WT
              ? `/c start "" "${WT_EXE}" -w new new-tab --title "${title}" --suppressApplicationTitle -d "${dir}" powershell -NoLogo -NoExit -ExecutionPolicy Bypass ${psCmd}`
              : `/c start "${title}" /D "${dir}" conhost.exe powershell -NoLogo -NoExit -ExecutionPolicy Bypass ${psCmd}`;
            spawn("cmd.exe", [line],
              { windowsVerbatimArguments: true, windowsHide: true, detached: true });
          } else if (process.platform === "darwin") {
            // macOS: Open a new terminal window in the project directory. The dir
            // is shell-escaped via AppleScript's `quoted form of` (see osutil) so
            // a path with a single quote / shell metachar can't inject a command.
            const script = osutil.terminalLaunchScript(dir);
            spawn("osascript", ["-e", script], { detached: true });
          }
        };
        if (mode === "folder") {
          const openCmd = process.platform === "win32" ? "explorer" : "open";
          spawn(openCmd, [dir], { detached: true });
        } else if (mode === "shell") {
          // Plain shell, no marker — not counted as "project open".
          launch("", path.basename(dir));
        } else if (id in projWin) {
          // ONE window per project, always: if it exists (even hidden),
          // surface THAT — never spawn a second one on top of it.
          winproj("show", id, () => sweepProjects());
        } else {
          // LOCK (one occupant at a time): while an agent is working inside this
          // project you can't open it — opening would fork its live session. Stop
          // the agent (⏹) to take over, or wait for it to finish. The reverse
          // also holds: an agent won't be dispatched into a project you have open.
          if ((projRuns[id] || 0) > 0) {
            res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
            return res.end("agent กำลังทำงานในโปรเจคนี้อยู่ — กด ⏹ หยุดก่อนเพื่อเข้าไปดู/ทำเอง หรือรอจนงานเสร็จ");
          }
          ensureTrusted(dir);  // no trust dialog ambush in the new window
          // Smart entry: resume the NEWEST session explicitly — straight into
          // where the work happened. Fresh claude only when there's no session.
          const sid = newestSid(dir);
          const cmd = sid ? `claude --resume ${sid}` : "claude";
          launch(`-Command "${cmd} #BAGIDEA_PROJ_${id}"`, `BAGIDEA_PROJ_${id}`);
          setTimeout(sweepProjects, 2500);
        }
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && (req.url === "/projects/stop" ||
      req.url === "/projects/hide" || req.url === "/projects/resume")) {
    // ⏹ stop kills the window tree for real. 🫥 hide tucks the window away
    // while claude keeps working; ▶ resume brings the same window back.
    readBody(req, (body) => {
      try {
        const { id } = JSON.parse(body);
        const action = req.url.endsWith("stop") ? "stop"
          : req.url.endsWith("hide") ? "hide" : "show";
        winproj(action, String(id).replace(/[^\w-]/g, ""), () => {
          sweepProjects();
          // After a stop, confirm again once the window/process has fully gone —
          // an immediate sweep can still race the kill and re-flag it as open.
          if (action === "stop") setTimeout(sweepProjects, 1500);
        });
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/projects/stopwork") {
    // ⏹ Stop the AGENT working inside a project so the owner can take it over
    // (the lock's "stop to enter" path). Human-UI only.
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    readBody(req, (body) => {
      try {
        const { id } = JSON.parse(body);
        const set = projChildren[id];
        if (set) {
          for (const c of set) {
            try {
              // Owner's deliberate kill — the close handler must treat it as
              // "stopped", NOT as a failed start (no resume rollback: a run
              // the owner just killed must not resurrect itself as resumable).
              c._ownerStopped = true;
              if (process.platform === "win32")
                spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], { windowsHide: true });
              else c.kill("SIGKILL");
            } catch {}
          }
        }
        // Clear the lock immediately; the children's close handlers also settle it.
        projChildren[id] = new Set();
        projRuns[id] = 0;
        projAgents[id] = {};
        broadcast({ type: "projects.changed" }, false);
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/agent/force-stop") {
    // ⏹ Force หยุด — kill a specific agent's live run(s) straight from the Task
    // bar. Human-UI only (destructive). REUSES the exact kill path of
    // /projects/stopwork + doRestart: taskkill /PID <child> /T /F rolls up the
    // WHOLE process tree — child.pid is only the cmd/conhost launcher, the real
    // claude.exe is a descendant (memory: agent-pid-process-tree), so /T is what
    // actually reaps it. _ownerStopped makes the close handler record the run as
    // "stopped" (→ history, NOT "interrupted") so the self-resume bridge never
    // resurrects it. activityEnd (in that handler) drops it from activeRuns,
    // flushes runs.json, and broadcasts → UI flips the agent back to idle.
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    readBody(req, (body) => {
      try {
        const { agent, task } = JSON.parse(body || "{}");
        const want = String(agent || "").trim();
        const wantTask = task != null && task !== "" ? String(task) : null;
        if (!want && !wantTask) throw new Error("need agent or task");
        const killed = [];
        for (const [t, r] of activeRuns) {
          // task given → that one run; else every live run of the agent (match on
          // the base id so ghost runs "id#sN" roll up to their parent too).
          const base = String(r.agent).split("#")[0];
          const hit = wantTask ? t === wantTask : (r.agent === want || base === want);
          if (!hit) continue;
          const c = allRunChildren.get(t);
          if (!c) continue;
          c._ownerStopped = true;   // verdict, not failure — no resume rollback
          try {
            if (process.platform === "win32")
              spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], { windowsHide: true });
            else c.kill("SIGKILL");
          } catch {}
          killed.push({ task: t, agent: r.agent });
        }
        if (killed.length) {
          const a0 = String(killed[0].agent).split("#")[0];
          broadcast({ type: "chat.message", agent: a0, watchdog: true,
            text: "⏹ หยุดงาน " + ((reg.agents[a0] || {}).name || a0) + " แล้ว (Force หยุด โดยผู้ใช้)" });
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, killed }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url.startsWith("/fs")) {
    // Directory listing for the in-house folder picker (Blender-style UI in
    // the overlay — no off-theme Windows dialogs).
    {
      const q = new URL(req.url, "http://x").searchParams;
      let dir = q.get("dir") || "";
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ":\\";
        try { if (fs.existsSync(d)) drives.push(d); } catch {}
      }
      if (!dir) dir = drives.includes("D:\\") ? "D:\\" : drives[0] || "C:\\";
      let dirs = [];
      try {
        dirs = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") &&
            !e.name.startsWith("$"))
          .map((e) => e.name).sort((a, b) => a.localeCompare(b));
      } catch {}
      const parent = path.dirname(dir);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ path: dir, parent: parent === dir ? null : parent,
        dirs, drives }));
    }

  } else if (req.method === "POST" && req.url === "/fs/mkdir") {
    readBody(req, (body) => {
      try {
        const { dir, name } = JSON.parse(body);
        const n = String(name || "").trim().replace(/[<>:"/\\|?*]/g, "");
        if (!dir || !n) throw new Error("need dir + name");
        fs.mkdirSync(path.join(dir, n));
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/places") {
    readBody(req, (body) => {
      try {
        const { name, folder, remove } = JSON.parse(body);
        const n = String(name || "").trim().slice(0, 40);
        if (!n) throw new Error("no name");
        if (remove) delete reg.places[n];
        else {
          if (!folder) throw new Error("no folder");
          reg.places[n] = String(folder).trim();
        }
        saveReg();
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url.split("?")[0] === "/jobs") {
    // Each project sees only its own Tasks: ?project=<id|path|name> filters the
    // list. No filter → every Task (office-wide view). ?project= unknown → [].
    const ref = new URL(req.url, "http://x").searchParams.get("project");
    let out = jobs;
    if (ref !== null && ref !== "") {
      const pid = resolveProjectRef(ref);
      out = jobs.filter((j) => j.project === pid);
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ jobs: out }));

  } else if (req.method === "POST" && req.url === "/jobs") {
    // Create a standing work order: now / at (one-shot or daily) / every N.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        if (!p.agent || !reg.agents[p.agent] || p.agent === "ceo") throw new Error("bad agent");
        if (!p.prompt) throw new Error("no prompt");
        const job = {
          id: "j" + Date.now(),
          agent: p.agent,
          // A Task may belong to a project (id|path|name → canonical id) or be
          // office-wide (""). This is what makes each project see its own Tasks.
          project: resolveProjectRef(p.project) || "",
          prompt: String(p.prompt).slice(0, 4000),
          mode: ["now", "at", "every"].includes(p.mode) ? p.mode : "now",
          at: Number(p.at) || 0,
          time: String(p.time || "").slice(0, 5),
          daily: !!p.daily,
          everyMin: Math.max(5, Number(p.everyMin) || 10),  // floor: 5 min
          enabled: true,
          created: Date.now(),
        };
        jobs.push(job);
        saveJobs();
        broadcast({ type: "jobs.changed" }, false);
        if (job.mode === "now") dispatchJob(job);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: job.id }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/jobs/update") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        const job = jobs.find((j) => j.id === p.id);
        if (!job) { res.writeHead(404); return res.end("unknown job"); }
        if (p.remove) {
          jobs = jobs.filter((j) => j.id !== p.id);
        } else {
          if (p.enabled !== undefined) job.enabled = !!p.enabled;
          if (typeof p.prompt === "string" && p.prompt.trim()) job.prompt = p.prompt.slice(0, 4000);
          if (p.agent && reg.agents[p.agent] && p.agent !== "ceo") job.agent = p.agent;
          if (p.everyMin !== undefined) job.everyMin = Math.max(5, Number(p.everyMin) || 10);
          if (typeof p.time === "string") job.time = p.time.slice(0, 5);
          if (p.daily !== undefined) job.daily = !!p.daily;
          if (p.at !== undefined) job.at = Number(p.at) || 0;
          // Re-scheduling a one-time 'at' that already fired re-arms it.
          if (p.at !== undefined || p.time !== undefined) { job.lastRun = 0; delete job.lastDay; job.done = false; }
        }
        saveJobs();
        broadcast({ type: "jobs.changed" }, false);
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/office-md") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    try { res.end(fs.readFileSync(OFFICE_MD, "utf8")); } catch { res.end(""); }

  } else if (req.method === "POST" && req.url === "/office-md") {
    readBody(req, (body) => {
      try {
        const { text } = JSON.parse(body);
        fs.writeFileSync(OFFICE_MD, String(text || "").slice(0, 64000));
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/notes") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ notes }));

  } else if (req.method === "POST" && req.url === "/notes") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        if (p.remove) notes = notes.filter((n) => n.id !== p.remove);
        else if (p.edit) {
          const n = notes.find((x) => x.id === p.edit);
          if (!n) throw new Error("note not found");
          const txt = String(p.text || "").trim().slice(0, 500);
          if (!txt) throw new Error("empty");
          n.text = txt;  // keep id/who/ts so the note stays in place
        }
        else if (p.text) notes.push({ id: "n" + Date.now(), who: p.who || "you",
          text: String(p.text).slice(0, 500), ts: Date.now() });
        else throw new Error("no text");
        saveNotes();
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/calendar") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ cal }));

  } else if (req.method === "POST" && req.url === "/calendar") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        if (p.remove) cal = cal.filter((c) => c.id !== p.remove);
        else if (p.edit) {
          const c = cal.find((x) => x.id === p.edit);
          if (!c) throw new Error("not found");
          if (p.title) c.title = String(p.title).slice(0, 120);
          if (p.at) { const at = Number(p.at) || Date.parse(p.at); if (at) { c.at = at; c.notified = false; } }
          if (p.remindMin !== undefined) c.remindMin = Math.max(1, Number(p.remindMin) || 10);
        } else {
          const at = Number(p.at) || Date.parse(p.at);
          if (!p.title || !at) throw new Error("need title + at");
          cal.push({ id: "c" + Date.now(), title: String(p.title).slice(0, 120),
            at, remindMin: Math.max(1, Number(p.remindMin) || 10), notified: false });
        }
        saveCal();
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/work/summary") {
    // 📋 Work Summary Modal — latest payload, so a reconnecting overlay can
    // rebuild the modal without waiting for a fresh broadcast. {summary:null}
    // until the first POST lands.
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    try { res.end(fs.readFileSync(WORK_SUMMARY, "utf8")); }
    catch { res.end(JSON.stringify({ summary: null })); }

  } else if (req.method === "POST" && req.url === "/work/summary") {
    // 📋 Work Summary Modal — accept {title, members:[{name,did,files[]}],
    // summaryTh}, broadcast it as a work.modal event on the office WS/feed,
    // and persist the latest one for GET /work/summary. Every field is
    // coerced + length-capped so a malformed payload can never crash the bus.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        const title = String(p.title || "").slice(0, 200);
        const summaryTh = String(p.summaryTh || "").slice(0, 8000);
        const members = (Array.isArray(p.members) ? p.members : []).slice(0, 50)
          .map((m) => ({
            name: String((m && m.name) || "").slice(0, 120),
            did: String((m && m.did) || "").slice(0, 2000),
            files: (Array.isArray(m && m.files) ? m.files : [])
              .slice(0, 200).map((f) => String(f).slice(0, 500)),
          }));
        if (!title && !summaryTh && !members.length) throw new Error("empty payload");
        const evt = { type: "work.modal", title, members, summaryTh };
        broadcast(evt);                       // live → WS/feed (+ journaled, stamps evt.ts)
        fs.writeFileSync(WORK_SUMMARY, JSON.stringify({ summary: evt }, null, 2));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, summary: evt }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/settings/models") {
    // 🧠 Per-agent model settings. {default, available[], perAgent{}, ts}.
    // default:null means "use the CLI's own default"; perAgent omits unset
    // agents (they fall back to default).
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ default: modelSettings.default || null,
      available: AVAILABLE_MODELS, perAgent: modelSettings.perAgent,
      locks: modelLocksMap(), ts: Date.now() }));

  } else if (req.method === "POST" && req.url === "/settings/models") {
    // 🧠 Update model settings. Body: {default?, perAgent?}. `default` (null/""
    // clears to system default) and every perAgent value are validated against
    // the catalog, and every perAgent key against the live roster — so a bogus
    // model id or unknown agent is rejected (400) and never persisted. perAgent
    // MERGES (set one agent at a time); a null/"" value clears that agent.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        // 🔒 A model-locked agent's model can't be changed or cleared via this
        // endpoint — reject the WHOLE request up-front (before any mutation) so
        // nothing is partially applied. resolveModel ignores perAgent for locked
        // agents anyway, but a hard 403 keeps the UI/API honest.
        if (p && typeof p.perAgent === "object" && p.perAgent) {
          const locked = Object.keys(p.perAgent).filter((aid) =>
            reg.agents[aid] && lock.lockedModelOf(reg.agents[aid], modelSettable));
          if (locked.length) {
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            return res.end("โมเดลถูกล็อก เปลี่ยน/ถอดไม่ได้: " + locked.join(", "));
          }
        }
        if (Object.prototype.hasOwnProperty.call(p, "default")) {
          const d = (p.default === null || p.default === "") ? null : String(p.default);
          if (!modelSettable(d)) throw new Error(
            UNAVAILABLE_MODELS.has(d) ? "model unavailable (no entitlement): " + d
              : "unknown default model: " + d);
          modelSettings.default = d;
        }
        if (Object.prototype.hasOwnProperty.call(p, "perAgent")) {
          if (typeof p.perAgent !== "object" || p.perAgent === null || Array.isArray(p.perAgent))
            throw new Error("perAgent must be an object");
          for (const [aid, mid] of Object.entries(p.perAgent)) {
            if (!reg.agents[aid]) throw new Error("unknown agent: " + aid);
            const v = (mid === null || mid === "") ? null : String(mid);
            if (!modelSettable(v)) throw new Error(
              UNAVAILABLE_MODELS.has(v) ? "model unavailable (no entitlement) for " + aid + ": " + v
                : "unknown model for " + aid + ": " + v);
            if (v === null) delete modelSettings.perAgent[aid];
            else modelSettings.perAgent[aid] = v;
          }
        }
        saveModelSettings();
        // Settings-only signal (never journaled — it must not replay).
        broadcast({ type: "models.changed", default: modelSettings.default,
          perAgent: modelSettings.perAgent }, false);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, default: modelSettings.default || null,
          available: AVAILABLE_MODELS, perAgent: modelSettings.perAgent,
          locks: modelLocksMap(), ts: Date.now() }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url.split("?")[0] === "/tokens") {
    // 📊 Token / quota usage. Returns the latest cache immediately (never
    // blocks), then fires background refreshes: Codex (free file read) every
    // time, Claude (costs ~1 token) at most once per 5 min — so opening the
    // panel keeps values current without burning quota.
    // `?fresh=1` additionally spends ONE tiny Codex turn to defeat staleness
    // (gated ≤ once / 2 min); the FE re-pulls /tokens after to see the result.
    const fresh = new URL(req.url, "http://x").searchParams.get("fresh") === "1";
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ claude: tokensCache.claude, codex: tokensCache.codex,
      ts: tokensCache.ts || Date.now() }));
    try { refreshCodexTokens(); } catch {}
    if (fresh) {
      // 🔄 explicit "refresh now" button: force BOTH services live in one shot.
      // Claude bypasses the 5-min maybeRefreshClaude() gate (a fresh API read
      // costs ~1 token); Codex spends ≤1 tiny turn (its own 2-min gate). Both
      // setters broadcast on change; the final broadcastTokens() guarantees the
      // panel repaints once with the merged result even if only one side moved.
      Promise.allSettled([
        refreshClaudeTokens(),
        refreshCodexFresh(),
      ]).then(() => broadcastTokens()).catch(() => {});
    } else {
      maybeRefreshClaude();
    }

  } else if (req.method === "GET" &&
      (req.url.split("?")[0] === "/usage/processes" ||
       req.url.split("?")[0] === "/tokens/by-process")) {
    // 💸 Per-process token breakdown — the real input/output/cache numbers each
    // agent/task spent, summed at the stream-json parse point (recordProcessUsage).
    // byAgent = totals per agent (biggest spender first); recent = per-task runs.
    // ?limit=N caps the recent list (default 50).
    const lim = Math.max(1, Math.min(500,
      Number(new URL(req.url, "http://x").searchParams.get("limit")) || 50));
    const byAgent = Object.values(usageState.byAgent)
      .sort((a, b) => b.totalTokens - a.totalTokens);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ totals: usageState.totals, byAgent,
      recent: usageState.runs.slice(0, lim) }));

  } else if (req.method === "GET" && req.url.split("?")[0] === "/activity") {
    // 📡 What is running RIGHT NOW (Live Log). Stream equivalent: subscribe to
    // the WS `activity.update` events, which fire on every start/tool/end.
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ running: activitySnapshot() }));

  } else if (req.method === "GET" && req.url.split("?")[0] === "/process/feed") {
    // 📋 The Process feed snapshot for a panel that just connected: every live
    // run + its recent steps (the REAL work, not just "working") + the latest
    // Work Summary. Then subscribe to ws `activity.update` + `task.step` for
    // live updates. Optional ?task=<id> narrows steps to one run.
    const only = new URL(req.url, "http://x").searchParams.get("task");
    const steps = {};
    for (const [task, ring] of runSteps) {
      if (only && task !== only) continue;
      steps[task] = ring.slice(-STEP_RING);
    }
    let lastSummary = null;
    try { lastSummary = JSON.parse(fs.readFileSync(WORK_SUMMARY, "utf8")).summary || null; } catch {}
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ running: activitySnapshot(), steps, lastSummary }));

  } else if (req.method === "GET" && req.url.split("?")[0] === "/run/steps") {
    // 📋 Recent steps of ONE run (ring buffer, RAM-only — empty once it ends).
    const task = new URL(req.url, "http://x").searchParams.get("task") || "";
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ task, steps: (runSteps.get(task) || []).slice(-STEP_RING) }));

  } else if (req.method === "GET" && req.url.split("?")[0] === "/runs") {
    // 💾 Persisted run state (กันงานหายถาวร): live mirrors activeRuns (state
    // recomputed with the SAME clock the overlay watchdog uses), interrupted =
    // runs a dead daemon left behind, awaiting resume/dismiss. Prompts stay
    // server-side — they're resume material, not list payload. Human UI only:
    // the records carry cwd / session keys / pids — owner's eyes, not agents'.
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    const now = Date.now();
    const lean = ({ prompt, ...r }) => r;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      live: Object.values(runsState.live).map((r) => ({ ...lean(r),
        state: now - r.lastHeartbeat >= STUCK_AFTER_MS ? "stuck" : "working" })),
      interrupted: runsState.interrupted.map(lean),
      // history records normally lost their prompt at archive time, but old
      // files / future archive paths must not leak one — strip here too.
      history: runsState.history.slice(0, 50).map(lean),
      // last write failure of the safety net itself (null = healthy) — the
      // UI must be able to show "ตัวกันงานหายเขียน disk ไม่ได้" loudly.
      persistenceError: saveRuns._err || null }));

  } else if (req.method === "POST" &&
      (req.url === "/runs/resume" || req.url === "/runs/dismiss")) {
    // Owner's decision on an interrupted run — resume re-dispatches (costs
    // tokens) so both verbs are human-UI only, like the other owner switches.
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    const dismiss = req.url === "/runs/dismiss";
    readBody(req, (body) => {
      try {
        const { runId } = JSON.parse(body);
        const rec = runsState.interrupted.find((r) => r.runId === runId);
        if (!rec) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          return res.end("ไม่พบ run ที่ค้างอยู่: " + String(runId).slice(0, 60));
        }
        if (rec.status === "resuming") {
          res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
          return res.end("run นี้กำลังถูก resume อยู่แล้ว: " + rec.runId);
        }
        if (dismiss) {
          archiveInterruptedRun(rec, "dismissed");
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ ok: true, runId: rec.runId, status: "dismissed" }));
        }
        // Base id, same rule as the governance choke point — a persisted
        // ghost id ("agent#sN") must resume through its parent.
        if (!reg.agents[String(rec.agent).split("#")[0]])
          throw new Error("agent ของงานนี้ไม่อยู่ในออฟฟิศแล้ว: " + rec.agent);
        // Same two-phase dispatch the boot auto-resume rides
        // (dispatchRunRecovery) — a manual resume is the owner's own call,
        // so it deliberately ignores the chain/age caps.
        const newTask = dispatchRunRecovery(rec);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, runId: rec.runId, status: "resuming",
          task: newTask }));
      } catch (e) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end(String((e && e.message) || e));
      }
    });

  } else if (req.method === "POST" && req.url === "/registry/key") {
    // 🔑 API key vault: ENV_NAME → value, injected into every agent run's
    // environment (OPENAI_API_KEY, GEMINI_API_KEY, …). Agents are told the
    // NAMES via projectNote; values live only in registry.json + env.
    readBody(req, (body) => {
      try {
        const { name, value, remove } = JSON.parse(body);
        const n = String(name || "").trim().toUpperCase()
          .replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
        if (!n) throw new Error("no name");
        if (remove) delete reg.apiKeys[n];
        else {
          if (!value) throw new Error("no value");
          reg.apiKeys[n] = String(value).trim().slice(0, 500);
        }
        saveReg();
        pushRoster();   // feature gates flip live in every client
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/registry/channel") {
    // 🔗 channel connector config — saving restarts the connectors live.
    readBody(req, (body) => {
      try {
        const { kind, config } = JSON.parse(body);
        if (!["telegram", "discord", "line"].includes(kind)) throw new Error("bad kind");
        reg.channels[kind] = {
          enabled: !!(config && config.enabled),
          token: String((config && config.token) || "").trim().slice(0, 300),
          chat: String((config && config.chat) || "").trim().slice(0, 80),
          channel: String((config && config.channel) || "").trim().slice(0, 80),
          secret: String((config && config.secret) || "").trim().slice(0, 200),
        };
        saveReg();
        channels.restart();
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/upload") {
    // 📎 chat attachments → workspace/uploads (agents Read them by path).
    readBodyRaw(req, (buf) => {
      try {
        if (!buf.length) throw new Error("empty file");
        if (buf.length > 80 * 1024 * 1024) throw new Error("ไฟล์ใหญ่เกิน 80MB");
        const raw = decodeURIComponent(String(req.headers["x-file-name"] || "file.bin"));
        const safe = raw.replace(/[^\w.ก-๙ -]/g, "_").slice(-80);
        const dir = path.join(WORKSPACE, "uploads");
        fs.mkdirSync(dir, { recursive: true });
        const name = Date.now() + "_" + safe;
        const full = path.join(dir, name);
        fs.writeFileSync(full, buf);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ path: full, url: "/uploads/" + encodeURIComponent(name), name: safe }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url.startsWith("/uploads/")) {
    const name = decodeURIComponent(req.url.slice(9).split("?")[0]).replace(/[\\/]|\.\./g, "");
    serveMedia(res, path.join(WORKSPACE, "uploads", name), req);

  } else if (req.method === "GET" && req.url.startsWith("/media?")) {
    // Render agent-produced media in chat: absolute path, but ONLY under the
    // workspace or a registered project (img tags can't send auth headers —
    // the path allowlist is the guard; daemon binds to localhost anyway).
    const p = new URL(req.url, "http://x").searchParams.get("p") || "";
    const norm = path.resolve(p);
    const roots = [path.resolve(WORKSPACE), ...projects.map((x) => path.resolve(x.dir))];
    if (!roots.some((r) => norm.toLowerCase().startsWith(r.toLowerCase() + path.sep))) {
      res.writeHead(403); return res.end("outside allowed roots");
    }
    serveMedia(res, norm, req);

  } else if (req.method === "POST" && req.url === "/reveal") {
    // Open the OS file manager at a file (like LINE/other messengers). UI-only,
    // and the target must live under the workspace or a registered project.
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    readBody(req, (body) => {
      try {
        let p = String((JSON.parse(body) || {}).path || "");
        if (p.startsWith("/uploads/"))
          p = path.join(WORKSPACE, "uploads", decodeURIComponent(p.slice(9)).replace(/[\\/]|\.\./g, ""));
        p = path.resolve(p);
        const roots = [path.resolve(WORKSPACE), ...projects.map((x) => path.resolve(x.dir))];
        const ok = roots.some((r) => p.toLowerCase() === r.toLowerCase() ||
          p.toLowerCase().startsWith(r.toLowerCase() + path.sep));
        if (!ok) { res.writeHead(403); return res.end("outside allowed roots"); }
        if (!fs.existsSync(p)) { res.writeHead(404); return res.end("not found"); }
        // explorer needs "/select," and the path as ONE argument or it ignores
        // the selection and opens Documents. spawn passes argv as-is (no shell),
        // so a single combined token is the reliable form (spaces included).
        if (process.platform === "win32") spawn("explorer.exe", ["/select," + p], { detached: true });
        else if (process.platform === "darwin") spawn("open", ["-R", p], { detached: true });
        else spawn("xdg-open", [path.dirname(p)], { detached: true });
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/open") {
    // Open a file in the OS default app (image viewer, player, browser) — a real
    // separate, resizable window. Same UI-only + allowlist guard as /reveal.
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    readBody(req, (body) => {
      try {
        let p = String((JSON.parse(body) || {}).path || "");
        if (p.startsWith("/uploads/"))
          p = path.join(WORKSPACE, "uploads", decodeURIComponent(p.slice(9)).replace(/[\\/]|\.\./g, ""));
        p = path.resolve(p);
        const roots = [path.resolve(WORKSPACE), ...projects.map((x) => path.resolve(x.dir))];
        const ok = roots.some((r) => p.toLowerCase() === r.toLowerCase() ||
          p.toLowerCase().startsWith(r.toLowerCase() + path.sep));
        if (!ok) { res.writeHead(403); return res.end("outside allowed roots"); }
        if (!fs.existsSync(p)) { res.writeHead(404); return res.end("not found"); }
        if (process.platform === "win32") spawn("cmd", ["/c", "start", "", p], { detached: true, windowsHide: true });
        else if (process.platform === "darwin") spawn("open", [p], { detached: true });
        else spawn("xdg-open", [p], { detached: true });
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/layout") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    try { res.end(fs.readFileSync(LAYOUT_FILE, "utf8")); }
    catch { res.end(JSON.stringify({ items: [] })); }

  } else if (req.method === "GET" && req.url === "/assets") {
    // 🗂 imported model/image library — reusable across editor sessions.
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    try { res.end(fs.readFileSync(ASSETS_FILE, "utf8")); }
    catch { res.end(JSON.stringify({ assets: [] })); }

  } else if (req.method === "POST" && req.url === "/assets") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        let assets = [];
        try { assets = JSON.parse(fs.readFileSync(ASSETS_FILE, "utf8")).assets || []; } catch {}
        if (p.remove) assets = assets.filter((a) => a.path !== p.remove);
        else {
          const path_ = String(p.path || "").trim();
          const kind = p.kind === "image" ? "image" : "model";
          if (!path_) throw new Error("no path");
          if (!assets.some((a) => a.path === path_))
            assets.push({ path: path_, kind, name: path_.split(/[\\/]/).pop(), ts: Date.now() });
        }
        fs.writeFileSync(ASSETS_FILE, JSON.stringify({ assets }, null, 1));
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/presets") {
    // custom layout presets the user saved from the 3D editor (defaults live
    // in the editor itself).
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    try { res.end(fs.readFileSync(PRESETS_FILE, "utf8")); }
    catch { res.end(JSON.stringify({ presets: [] })); }

  } else if (req.method === "POST" && req.url === "/presets") {
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        let presets = [];
        try { presets = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8")).presets || []; } catch {}
        if (p.remove) presets = presets.filter((x) => x.name !== p.remove);
        else {
          const name = String(p.name || "").trim().slice(0, 40);
          if (!name || !Array.isArray(p.items)) throw new Error("need name + items");
          presets = presets.filter((x) => x.name !== name);  // overwrite same name
          presets.push({ name, items: p.items.slice(0, 500), ts: Date.now() });
        }
        fs.writeFileSync(PRESETS_FILE, JSON.stringify({ presets }, null, 1));
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/layout") {
    // 🎨 Office Editor saves the whole layout; the world re-applies it live.
    readBody(req, (body) => {
      try {
        const j = JSON.parse(body);
        if (!Array.isArray(j.items)) throw new Error("items must be an array");
        const out = { items: j.items.slice(0, 500) };
        if (Array.isArray(j.rooms)) out.rooms = j.rooms.slice(0, 64);  // jigsaw room arrangement
        if (Array.isArray(j.ghost) && j.ghost.length === 2) out.ghost = j.ghost.map(Number);  // ghost deck pos
        if (typeof j.billboard === "string" && j.billboard) out.billboard = j.billboard.slice(0, 400);  // custom sign image
        fs.writeFileSync(LAYOUT_FILE, JSON.stringify(out, null, 1));
        broadcast({ type: "layout.changed" }, false);
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/plugins") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ plugins: plugins.list() }));

  } else if (req.method === "POST" && req.url === "/plugins/reload") {
    plugins.load();
    broadcast({ type: "plugins.changed" }, false);
    res.writeHead(200); res.end("ok");

  } else if (req.method === "POST" && req.url === "/editor/open") {
    // 🎨 Ask the shell to open the editor — it shows its circular logo splash,
    // launches Godot tiny+cloaked behind it, and reveals when ready (the SAME
    // boot path as the wallpaper). Falls back to a direct launch if no shell.
    try {
      const tmp = require("os").tmpdir();
      try { fs.unlinkSync(path.join(tmp, "bagidea_editor_ready")); } catch {}
      fs.writeFileSync(path.join(tmp, "bagidea_editor_open_request"), String(Date.now()));
      // fallback: if the shell isn't running, launch directly after a beat
      const gdir = path.join(__dirname, "..", "godot");
      let godot = "";
      if (process.platform === "win32") {
        const branded = path.join(gdir, "bin", "BagIdeaOffice.exe");
        godot = fs.existsSync(branded) ? branded
          : (process.env.BAGIDEA_GODOT || "C:\\Program Files\\Godot\\Godot_v4.6.3-stable_win64.exe");
      } else if (process.platform === "darwin") {
        const app = path.join(gdir, "bin-mac", "Godot.app", "Contents", "MacOS", "Godot");
        godot = fs.existsSync(app) ? app : "Godot";
      }
      const shellUp = fs.existsSync(path.join(tmp, "bagidea_shell_alive"));
      if (!shellUp && fs.existsSync(godot)) {
        spawn(godot, ["--path", gdir, "--", "--editor3d"],
          { detached: true, stdio: "ignore", windowsHide: false }).unref();
      }
      broadcast({ type: "editor.opening" }, false);
      res.writeHead(200); res.end("ok");
    } catch (e) { res.writeHead(500); res.end(String(e.message)); }

  } else if (req.method === "POST" && req.url === "/plugins/install") {
    // 📦 one-click install: git clone a plugin repo into plugins/ then reload.
    readBody(req, (body) => {
      try {
        if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
        let url = String(JSON.parse(body).url || "").trim();
        if (!/^https:\/\/(github\.com|gitlab\.com|[\w.-]+)\/[\w.\-/]+$/.test(url))
          throw new Error("ใส่ลิงก์ git repo ที่ขึ้นต้น https:// ของ plugin");
        if (!url.endsWith(".git")) url += ".git";
        // Clone into a temp folder first, then move it to plugins/<id> using
        // the id from its OWN manifest — so the install folder always matches
        // the plugin id (remove + core protection look it up by id).
        const pluginsRoot = path.join(__dirname, "..", "plugins");
        const tmp = path.join(pluginsRoot, ".installing-" + Date.now());
        const { execFile } = require("child_process");
        execFile("git", ["clone", "--depth", "1", url, tmp], { timeout: 60000 }, (e) => {
          const fail = (msg) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end(msg); };
          if (e || !fs.existsSync(path.join(tmp, "plugin.json")))
            return fail(e ? "clone ไม่สำเร็จ: " + e.message : "repo นี้ไม่มี plugin.json — ไม่ใช่ plugin ที่ถูกต้อง");
          let man = {}; try { man = JSON.parse(fs.readFileSync(path.join(tmp, "plugin.json"), "utf8")); } catch {}
          const repoName = url.split("/").pop().replace(/\.git$/, "");
          const id = String(man.id || repoName).replace(/[^\w-]/g, "");
          if (!id) return fail("plugin.json ไม่มี id ที่ถูกต้อง");
          const dest = path.join(pluginsRoot, id);
          if (fs.existsSync(dest)) return fail("มี plugin ชื่อนี้แล้ว: " + id);
          try { fs.renameSync(tmp, dest); } catch (err) { return fail("ติดตั้งไม่สำเร็จ: " + err.message); }
          plugins.load();
          broadcast({ type: "plugins.changed" }, false);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, name: id }));
        });
      } catch (e) { res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/plugins/intent") {
    // A bagidea:// deep link (from the web Plugins page) asking to install a
    // plugin. We do NOT install here — we broadcast an intent so the OFFICE asks
    // the user to confirm first. A web page must never silently install code.
    readBody(req, (body) => {
      try {
        if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
        let repo = String(JSON.parse(body || "{}").repo || "").trim();
        if (!/^https:\/\/(github\.com|gitlab\.com|[\w.-]+)\/[\w.\-/]+$/.test(repo))
          throw new Error("bad repo url");
        broadcast({ type: "plugin.intent", repo }, false);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/plugins/remove") {
    readBody(req, (body) => {
      try {
        if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
        const id = String(JSON.parse(body).id || "").replace(/[^\w-]/g, "");
        const dir = path.join(__dirname, "..", "plugins", id);
        const manFile = path.join(dir, "plugin.json");
        if (!fs.existsSync(manFile)) throw new Error("ไม่พบ plugin");
        // Core plugins ship with the office and can't be uninstalled; only
        // plugins the user added (e.g. via GitHub) are removable.
        let man = {}; try { man = JSON.parse(fs.readFileSync(manFile, "utf8")); } catch {}
        if (man.core) throw new Error("plugin หลักลบไม่ได้");
        fs.rmSync(dir, { recursive: true, force: true });
        plugins.load();
        broadcast({ type: "plugins.changed" }, false);
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.url.startsWith("/plugin/") &&
      plugins.handleHttp(req, res, readBody, readBodyRaw)) {
    /* handled by a plugin */

  } else if (req.method === "POST" && req.url === "/registry/key/test") {
    // 🧪 verify a main key actually works (a tiny authenticated call).
    readBody(req, (body) => {
      try {
        const { name } = JSON.parse(body);
        const val = (reg.apiKeys || {})[name];
        if (!val) { res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ ok: false, msg: "ยังไม่ได้ตั้ง key" })); }
        const done = (ok, msg) => { res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok, msg })); };
        const https = require("https");
        if (name === "OPENAI_API_KEY") {
          const rq = https.request({ method: "GET", host: "api.openai.com", path: "/v1/models",
            headers: { authorization: "Bearer " + val } }, (rs) => {
            rs.resume();
            done(rs.statusCode === 200, rs.statusCode === 200 ? "ใช้งานได้ ✓" : "key ไม่ผ่าน (HTTP " + rs.statusCode + ")");
          });
          rq.setTimeout(12000, () => rq.destroy(new Error("timeout")));
          rq.on("error", (e) => done(false, e.message));
          rq.end();
        } else if (name === "GEMINI_API_KEY") {
          const rq = https.request({ method: "GET", host: "generativelanguage.googleapis.com",
            path: "/v1beta/models?key=" + val }, (rs) => {
            rs.resume();
            done(rs.statusCode === 200, rs.statusCode === 200 ? "ใช้งานได้ ✓" : "key ไม่ผ่าน (HTTP " + rs.statusCode + ")");
          });
          rq.setTimeout(12000, () => rq.destroy(new Error("timeout")));
          rq.on("error", (e) => done(false, e.message));
          rq.end();
        } else done(true, "ตั้งค่าแล้ว");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/features") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(featuresMap()));

  } else if (req.method === "GET" && req.url === "/version") {
    // Local vs latest-released version (the VERSION file on main).
    res.writeHead(200, { "content-type": "application/json" });
    const ur = updateRepo();
    res.end(JSON.stringify({ version: APP_VERSION, latest: latestVersion,
      updateAvailable: semverGt(latestVersion, APP_VERSION), host: ur.host, repo: ur.repo }));

  } else if (req.method === "GET" && req.url === "/startup") {
    // Is the app set to launch with Windows? (HKCU Run key, same one the tray
    // checkbox writes — so tray, CLI and settings stay in sync.)
    isAutostart((on) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ on }));
    });

  } else if (req.method === "POST" && req.url === "/startup") {
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    readBody(req, (body) => {
      try {
        const on = !!JSON.parse(body || "{}").on;
        setAutostart(on, (ok) => {
          res.writeHead(ok ? 200 : 500, { "content-type": "application/json" });
          res.end(JSON.stringify({ on: ok ? on : null }));
        });
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/stats") {
    // 📊 dashboard: last 7 days of run stats + live system facts.
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      days.push({ day: d, ...(stats[d] || { runs: 0, done: 0, failed: 0, cost: 0, agents: {} }) });
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      days,
      uptimeSec: Math.floor(process.uptime()),
      clients: wsClients.size,
      pendingPerms: pendingPerms.size,
      jobs: jobs.filter((j) => !j.done && j.enabled !== false).length,
      notes: notes.length,
      events: cal.filter((c) => c.at > Date.now()).length,
      channels: channels.status(),
      features: featuresMap(),
      projects: projectStatus().map((p) => ({ name: p.name, ai: p.ai, open: p.open })),
    }));

  } else if (req.method === "GET" && req.url === "/channels/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(channels.status()));

  } else if (req.method === "POST" && req.url === "/channels/line/webhook") {
    // LINE Messaging API webhook — point your channel's webhook URL here
    // through a public HTTPS tunnel (e.g. cloudflared).
    readBodyRaw(req, (raw) => channels.lineWebhook(req, res, raw));

  } else if (req.method === "POST" && req.url === "/registry/heartbeat") {
    // Director overview cadence: 0 = off, otherwise minutes between passes.
    readBody(req, (body) => {
      try {
        reg.heartbeatMin = Math.max(0, Number(JSON.parse(body).min) || 0);
        saveReg();
        pushRoster();
        res.writeHead(200); res.end("ok");
      } catch { res.writeHead(400); res.end("bad json"); }
    });

  } else if (req.method === "POST" && req.url === "/registry/sound") {
    // World sound effects on/off (persisted + live ui.sound broadcast).
    readBody(req, (body) => {
      try {
        reg.sound = !!JSON.parse(body).enabled;
        saveReg();
        pushRoster();
        broadcast({ type: "ui.sound", on: reg.sound });
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });

  } else if (req.method === "POST" && req.url === "/registry/autoskills") {
    readBody(req, (body) => {
      try {
        reg.autoSkills = !!JSON.parse(body).enabled;
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });

  } else if (req.method === "POST" && req.url === "/registry/role") {
    readBody(req, (body) => {
      try {
        const { name, remove } = JSON.parse(body);
        const n = String(name || "").trim().slice(0, 40);
        if (!n) throw new Error("no name");
        if (remove) reg.roles = reg.roles.filter((r) => r !== n);
        else if (!reg.roles.includes(n)) reg.roles.push(n);
        saveReg();
        pushRoster();
        res.writeHead(200);
        res.end("ok");
      } catch (e) {
        res.writeHead(400);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/assist/prompt") {
    // ✨ Persona copilot: the owner types a one-line brief ("UI designer who
    // sweats microcopy") and a quick claude call drafts the whole persona —
    // AND picks the skills + tools that fit the role from what's available.
    // Core lives in draftAgentPersona() — shared with the NPC-Hire generator.
    readBody(req, async (body) => {
      try {
        const { name = "Agent", role = "Specialist", brief = "" } = JSON.parse(body);
        const out = await draftAgentPersona({ name, role, brief });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e.message));
      }
    });

  } else if (req.method === "POST" && req.url === "/ui/daylight") {
    // Manual atmosphere override for the world ("auto" follows the clock).
    // Persisted in the registry + carried on roster.sync, so the choice
    // survives renderer restarts/reconnects (journal replay alone is bounded by
    // REPLAY_COUNT and silently scrolls the pick out on a busy office).
    readBody(req, (body) => {
      try {
        const { hour = "auto" } = JSON.parse(body || "{}");
        reg.daylight = hour;
        saveReg();
        broadcast({ type: "ui.daylight", hour }, false);
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });

  } else if (req.method === "GET" && req.url.startsWith("/recall")) {
    // Relevance search over the office's memory / projects / owner facts /
    // skills / meeting archive. Read-only; agents can curl this directly.
    const u = new URL(req.url, "http://x");
    const q = u.searchParams.get("q") || "";
    const k = Math.min(20, Math.max(1, parseInt(u.searchParams.get("k") || "8", 10) || 8));
    const tiers = (u.searchParams.get("tiers") || "").split(",").filter(Boolean);
    let hits = [];
    try { if (retrievalOk) hits = retrieval.search(q, { k, tiers: tiers.length ? tiers : undefined }); } catch {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ q, hits, stats: retrievalOk ? retrieval.stats() : null }));

  } else if (req.method === "POST" && req.url === "/ui/monitor") {
    // Which monitor the wallpaper runs on (multi-monitor). The shell reads
    // daemon/monitor.txt at attach time (0 = primary). Changing it auto-restarts
    // the office so it re-attaches to the chosen screen — no manual `bagidea
    // restart`. `noRestart:true` just records the choice (used by tests).
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body || "{}");
        const idx = Math.max(0, parseInt(p.index, 10) || 0);
        reg.monitor = idx;
        saveReg();
        fs.writeFileSync(path.join(__dirname, "monitor.txt"), String(idx));
        broadcast({ type: "ui.monitor", index: idx }, false);
        res.writeHead(200); res.end("ok");
        // Give the response a beat to flush, then relaunch the stack.
        if (!p.noRestart) setTimeout(triggerRestart, 350);
      } catch { res.writeHead(400); res.end("bad json"); }
    });

  } else if (req.method === "POST" && req.url === "/ui/restart") {
    // Manual "restart the office" (tray menu / overlay). Detached relaunch.
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    res.writeHead(200); res.end("ok");
    setTimeout(triggerRestart, 350);

  } else if (req.method === "POST" && req.url === "/ui/monitors") {
    // The shell reports the REAL monitor count it detected at attach. Persist it
    // (monitors.txt) + broadcast so the picker shows the right number, live.
    readBody(req, (body) => {
      try {
        const n = Math.max(1, parseInt(JSON.parse(body || "{}").count, 10) || 1);
        fs.writeFileSync(path.join(__dirname, "monitors.txt"), String(n));
        broadcast({ type: "ui.monitors", count: n }, false);
        res.writeHead(200); res.end("ok");
      } catch { res.writeHead(400); res.end("bad json"); }
    });

  } else if (req.method === "GET" && req.url === "/workflows") {
    // Bundled read-only examples (daemon/workflow-examples) + the user's own
    // workflows (workspace/workflows). Examples can't be edited/deleted.
    const out = [];
    const scan = (base, example) => {
      try {
        for (const f of fs.readdirSync(base)) {
          if (!f.endsWith(".json")) continue;
          try { const w = JSON.parse(fs.readFileSync(path.join(base, f), "utf8"));
            out.push({ id: w.id || f.replace(/\.json$/, ""), name: w.name || f,
              nodes: (w.nodes || []).length, example }); } catch {}
        }
      } catch {}
    };
    scan(path.join(__dirname, "workflow-examples"), true);
    scan(path.join(WORKSPACE, "workflows"), false);
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out));

  } else if (req.method === "GET" && req.url.startsWith("/workflows/get")) {
    const id = (new URL(req.url, "http://x").searchParams.get("id") || "").replace(/[^\w-]/g, "");
    if (id.startsWith("example-")) {
      try {
        const ex = path.join(__dirname, "workflow-examples");
        for (const f of fs.readdirSync(ex)) {
          if (!f.endsWith(".json")) continue;
          const raw = fs.readFileSync(path.join(ex, f), "utf8");
          try { if (JSON.parse(raw).id === id) { res.writeHead(200, { "content-type": "application/json" }); return res.end(raw); } } catch {}
        }
      } catch {}
      res.writeHead(404); return res.end("{}");
    }
    try { res.writeHead(200, { "content-type": "application/json" });
      res.end(fs.readFileSync(path.join(WORKSPACE, "workflows", id + ".json"))); }
    catch { res.writeHead(404); res.end("{}"); }

  } else if (req.method === "POST" && req.url === "/workflows/save") {
    readBody(req, (body) => { try {
      const w = JSON.parse(body || "{}");
      let id = String(w.id || "").replace(/[^\w-]/g, "");
      // Never overwrite a read-only example — saving one forks a new user copy.
      if (!id || id.startsWith("example-")) id = "wf_" + Date.now();
      const dir = path.join(WORKSPACE, "workflows"); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id + ".json"),
        JSON.stringify({ id, name: w.name || "Workflow", nodes: w.nodes || [], edges: w.edges || [] }, null, 2));
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id }));
    } catch (e) { res.writeHead(400); res.end(String(e.message)); } });

  } else if (req.method === "POST" && req.url === "/workflows/delete") {
    readBody(req, (body) => { try {
      const id = String(JSON.parse(body || "{}").id || "").replace(/[^\w-]/g, "");
      if (id && !id.startsWith("example-")) fs.unlinkSync(path.join(WORKSPACE, "workflows", id + ".json"));
    } catch {} res.writeHead(200); res.end("ok"); });

  } else if (req.method === "POST" && req.url === "/workflows/analyze") {
    // The Director reads the human-language workflow and returns a plan (which
    // skills/tools/agents/permissions it needs). P1: plan only, never auto-runs.
    readBody(req, (body) => { try {
      const w = JSON.parse(body || "{}");
      queueDirectorTurn((release) => {
        runClaude("main", WORKFLOW_ANALYZE_PROMPT + "\n\n" + workflowToText(w), {
          logPrompt: "🔀 วิเคราะห์ workflow: " + (w.name || ""),
          onDone: (out, ok) => {
            release();
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: !!ok, analysis: ok && out ? out : "วิเคราะห์ไม่สำเร็จ ลองใหม่อีกครั้ง" }));
          },
        });
      });
    } catch (e) { res.writeHead(400); res.end(String(e.message)); } });

  } else if (req.method === "POST" && req.url === "/workflows/run") {
    // Run the workflow NOW — hand it to the Director as an order (full DELEGATE
    // power), and ride the result back.
    readBody(req, (body) => { try {
      const w = JSON.parse(body || "{}");
      queueDirectorTurn((release) => {
        ceoFlow(
          "Execute this workflow now. Do each step in order. When a node has SEVERAL " +
          "OUTGOING arrows, those branches run in PARALLEL — and you must REALLY run " +
          "them in parallel by ending your reply with one `SUB: <branch task>` line per " +
          "branch (they become real ghost clones the owner can watch split off). Do NOT " +
          "just say you split — emit the SUB: lines. A node with several incoming arrows " +
          "waits for all branches, then continues from their merged results. Report the " +
          "final result.\n\n" + workflowToText(w),
          undefined, undefined,
          { logPrompt: "🔀▶ รัน workflow: " + (w.name || ""),
            onDone: (out, ok) => {
              release();
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: !!ok, result: ok && out ? out : "รันไม่สำเร็จ ลองใหม่อีกครั้ง" }));
            } });
      });
    } catch (e) { res.writeHead(400); res.end(String(e.message)); } });

  } else if (req.method === "POST" && req.url === "/workflows/skill") {
    // Compile the workflow into a reusable SKILL — then it can be assigned to an
    // agent (Settings → agent → tick the skill) and triggered on demand.
    readBody(req, (body) => { try {
      const w = JSON.parse(body || "{}");
      const nm = String(w.name || "Workflow").slice(0, 50);
      // The compiled skill is keyed to THIS workflow's own id (wfId), not just
      // its name. Re-compiling the same workflow updates its skill in place;
      // a DIFFERENT workflow that happens to share a name gets a disambiguated
      // id (…-<tag>) so it never silently clobbers an unrelated skill.
      const wfId = String(w.id || "").replace(/[^\w-]/g, "");
      let id = ("wf-" + slugId(nm)).slice(0, 50);
      if (reg.skills[id] && reg.skills[id].wfId !== wfId) {
        const base = ("wf-" + slugId(nm)).slice(0, 42);
        const tag = (wfId ? wfId.slice(-6) : String(Date.now()).slice(-6)).replace(/[^\w]/g, "") || "x";
        id = (base + "-" + tag).slice(0, 50);
        let n = 2;
        while (reg.skills[id] && reg.skills[id].wfId !== wfId) {
          id = (base + "-" + tag + "-" + n).slice(0, 50); n++;
        }
      }
      reg.skills[id] = {
        name: ("🔀 " + nm).slice(0, 60),
        description: ("Run the saved workflow: " + nm).slice(0, 200),
        content: ("When asked to run \"" + nm + "\", follow this workflow exactly:\n\n" +
          workflowToText(w) +
          "\nDo the steps in order. For a node with several OUTGOING arrows, REALLY run " +
          "the branches in parallel by ending the reply with one `SUB: <branch task>` line " +
          "per branch (they become real ghost clones) — don't just describe splitting. At " +
          "a node with several incoming arrows, wait for all branches then continue from " +
          "their merged results. Report the final result clearly.").slice(0, 4000),
        wfId,
      };
      saveReg();
      try { if (retrievalOk) { retrieval.reindexSkill(id, reg.skills[id]); retrieval.persist(); } } catch {}
      pushRoster();
      broadcast({ type: "skill.created", agent: "", skill: reg.skills[id].name });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id, name: reg.skills[id].name }));
    } catch (e) { res.writeHead(400); res.end(String(e.message)); } });

  } else if (req.method === "POST" && req.url === "/event") {
    readBody(req, (body) => {
      try {
        const evt = JSON.parse(body);
        // Hook events from the host Claude Code session arrive as "claude" —
        // that IS the Director: map them onto main (no ghost duplicate).
        if (evt.agent === "claude") evt.agent = "main";
        // Transient UI state (visibility, monitor count) must never replay.
        broadcast(evt, !["ui.visibility", "ui.monitors", "ui.monitor"].includes(evt.type));
        res.writeHead(200);
        res.end("ok");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });

  } else if (req.method === "POST" && req.url === "/perm/request") {
    // PreToolUse hook long-polls here; we answer when the user decides.
    readBody(req, (body) => {
      let p;
      try { p = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      let { id, agent = "claude", task = "", tool = "?", input = "" } = p;
      if (agent === "claude") agent = "main";  // host session = the Director
      // Tools the owner GRANTED in the agent's registry profile never ask —
      // that's what granting means. "Allow ตลอดไป" rules ride along too.
      const base = String(agent).split("#")[0];
      const granted = [
        ...(((reg.agents[base] || {}).tools) || []),
        ...(((reg.autoAllow || {})[base]) || []),
      ];
      const isGranted = granted.includes(tool) ||
        // MCP grants are stored as "mcp:<server>"; hook tool names arrive
        // as "mcp__<server>__<tool>".
        granted.some((g) => g.startsWith("mcp:") &&
          String(tool).startsWith("mcp__" + g.slice(4) + "__"));
      if (isGranted) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ decision: "allow" }));
        broadcast({ type: "perm.approved", agent, task, tool, perm: id, via: "rule" });
        return;
      }
      broadcast({ type: "perm.requested", agent, task, tool, perm: id, input });
      const timer = setTimeout(() => {
        // No human around — deny safely and let the agent re-plan.
        finishPerm(id, "deny", "timeout");
      }, 50000);
      pendingPerms.set(id, { res, timer, agent, task, tool });
    });

  } else if (req.method === "POST" && req.url === "/perm/respond") {
    readBody(req, (body) => {
      try {
        const { id, decision, always } = JSON.parse(body);
        // "Allow ตลอดไป": remember the grant — broker auto-approves future
        // requests AND the tool joins the agent's allowlist for new runs.
        if (always && decision === "allow") {
          const pend = pendingPerms.get(id);
          if (pend) {
            const base = String(pend.agent).split("#")[0];
            reg.autoAllow = reg.autoAllow || {};
            reg.autoAllow[base] = [...new Set([...(reg.autoAllow[base] || []), pend.tool])];
            const a = reg.agents[base];
            if (a && Array.isArray(a.tools) && !a.tools.includes(pend.tool))
              a.tools.push(pend.tool);
            saveReg();
            pushRoster();
          }
        }
        const ok = finishPerm(id, decision === "allow" ? "allow" : "deny", "user");
        res.writeHead(ok ? 200 : 404);
        res.end(ok ? "ok" : "unknown id");
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });

  } else if (req.method === "POST" && req.url === "/gen/image") {
    // 🖼 system tool: prompt → PNG path (+ /uploads url for chat rendering).
    // Optional `project`: when it resolves, the generated image is ALSO filed
    // into the per-project snapshot gallery as a kind:"design" record — same
    // store + `snapshot.ready` broadcast as /snapshot/run — so design work an
    // agent makes for a project stays browsable, not just a one-off chat bubble.
    // Unknown/empty project = chat-only (never persist a homeless record, same
    // reject-unknown rule as /snapshot/run).
    readBody(req, (body) => {
      try {
        const { prompt, project } = JSON.parse(body);
        if (!prompt) throw new Error("no prompt");
        genImage(prompt).then((out) => {
          broadcast({ type: "image.generated", url: out.url }, false);
          const spid = resolveProjectRef(project);
          if (spid) {
            const proj = projects.find((x) => x.id === spid);
            const ts = Date.now();
            finishSnap({ snapshotId: "snap" + ts, project: spid,
              projectName: (proj && proj.name) || "", imagePath: out.path,
              url: out.url, kind: "design", status: "ready", ts });
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(out));
        }).catch((e) => {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(String(e.message));
        });
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/proposals") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ proposals: proposals.slice(-30).reverse() }));

  } else if (req.method === "POST" && req.url === "/proposals/dismiss") {
    // 🧹 Quietly clear pending proposals off the owner's plate — bulk or all.
    // Unlike "reject", this sends NO message to the team and makes no noise in
    // the feed; it just marks them dismissed so they drop out of the list.
    readBody(req, (body) => {
      try {
        if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
        const p = JSON.parse(body || "{}");
        const ids = p.all ? null : new Set(p.ids || []);
        let n = 0;
        for (const pr of proposals) {
          if (pr.status !== "pending") continue;
          if (ids && !ids.has(pr.id)) continue;
          pr.status = "dismissed"; n++;
        }
        if (n) saveProposals();
        broadcast({ type: "proposals.dismissed", count: n }, false);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, dismissed: n }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/proposals/respond") {
    // CEO verdict on a team pitch: approve → a real project is born in the
    // playground and the Director staffs it; reject/hold are remembered.
    readBody(req, (body) => {
      try {
        if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
        const { id, decision, message } = JSON.parse(body);
        const p = proposals.find((x) => x.id === id);
        if (!p) { res.writeHead(404); return res.end("unknown proposal"); }
        p.status = decision === "approve" ? "approved"
          : decision === "reject" ? "rejected" : "pending";
        const note = String(message || "").slice(0, 600).trim();   // owner's optional note
        if (note) p.message = note;
        saveProposals();
        const noteLine = note ? `เจ้าของฝากข้อความ: "${note}"\n` : "";
        if (decision === "approve") {
          let proj = null;
          // Approved projects are born in a DEFAULT projects folder (the
          // playground) when no location was given — agents never scaffold loose.
          const playDir = String(reg.playground || path.join(WORKSPACE, "projects"));
          try {
            proj = createProject(p.name, "", path.join(playDir, p.name.replace(/[^\wก-๙ -]/g, "_")));
          } catch (e) { /* duplicate name → Director routes to the existing one */ }
          queueDirectorTurn((release) => {
            runClaude("main",
              `CEO อนุมัติข้อเสนอโปรเจคของทีมแล้ว 🎉\n` +
              `ชื่อ: ${p.name}\nไอเดีย: ${p.detail}\nผู้เสนอ: ${p.agents.join(", ")}\n` + noteLine +
              (proj ? `โปรเจคถูกสร้างไว้แล้วที่ ${proj.dir} (ทำงานในโฟลเดอร์นี้เท่านั้น)\n` : "") +
              `กติกา: ห้ามแก้ไขระบบหลักของโปรแกรม (daemon/godot/shell/cli) เด็ดขาด — ` +
              `ถ้าเป็นการต่อยอดออฟฟิศ ให้ทำเป็น plugin ตาม docs/guide/plugins.md ` +
              `(เริ่มจาก template: github.com/bagidea/bagidea-office-template).\n` +
              `จัดทีมเลย: DELEGATE: <agent> @ ${p.name} :: <งานชิ้นแรกที่ชัดเจน> ` +
              `ให้คนที่เสนอไอเดียได้ทำเป็นหลัก แล้วสรุปแผนสั้นๆ` +
              (note ? ` และนำข้อความของเจ้าของไปปรับทิศทางงานด้วย` : ""),
              { logPrompt: `✅ อนุมัติข้อเสนอ: ${p.name}`,
                filterText: makeDelegateFilter(0, undefined),
                onDone: () => release() });
          });
        } else if (decision === "reject" && note) {
          // The team hears WHY — the owner's note lands in the office feed.
          broadcast({ type: "chat.message", agent: "main",
            text: `CEO ยังไม่อนุมัติ "${p.name}" — ${note}` });
        }
        broadcast({ type: "proposal." + p.status, agent: p.by, name: p.name, proposal: p.id });
        res.writeHead(200); res.end("ok");
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url.split("?")[0] === "/i18n/all") {
    // The whole cached map for a language (seed + anything translated since).
    // The overlay pulls this once on load so tr() knows every seeded string up
    // front — no first-switch Thai flash, and strings in NO_I18N subtrees (the
    // now-strip chrome) can be translated inline too.
    const L = String((req.url.split("?")[1] || "").replace(/^lang=/, "")).toLowerCase();
    let map = {};
    if (L && L !== "th" && /^[a-z]{2}$/.test(L)) {
      try { map = JSON.parse(fs.readFileSync(path.join(__dirname, "i18n", L + ".json"), "utf8")); } catch {}
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ map }));

  } else if (req.method === "POST" && req.url === "/i18n") {
    // 🌐 auto-translate UI strings to any language via Gemini, cached to
    // disk (daemon/i18n/<lang>.json) so it's instant + shared next time.
    // The overlay sends the Thai strings it finds on screen; we return the
    // full map for those, translating only the ones not yet cached.
    readBody(req, (body) => {
      try {
        const { lang, strings } = JSON.parse(body);
        const L = String(lang || "").toLowerCase();
        if (!L || L === "th" || !Array.isArray(strings)) { res.writeHead(400); return res.end("bad"); }
        const dir = path.join(__dirname, "i18n");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, L + ".json");
        let cache = {};
        try { cache = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
        const want = [...new Set(strings.map((s) => String(s)).filter((s) => s && s.length <= 400))];
        const missing = want.filter((s) => !(s in cache));
        const reply = () => {
          const out = {};
          for (const s of want) if (cache[s] !== undefined) out[s] = cache[s];
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ map: out }));
        };
        // Reply with whatever's cached RIGHT NOW — never make the overlay wait
        // on a slow Gemini call for a handful of uncached strings. That used to
        // block the WHOLE batch, so switching language flashed Thai for seconds
        // even when ~everything was already seeded. The misses translate in the
        // background (cached to disk); the overlay's ~1.5s janitor sweep re-asks
        // and picks them up the moment they're ready.
        reply();
        const gm = (reg.apiKeys || {}).GEMINI_API_KEY;
        if (!missing.length || !gm) return;
        const langName = { en: "English", zh: "Simplified Chinese", ja: "Japanese",
          ko: "Korean", es: "Spanish", fr: "French", de: "German", hi: "Hindi",
          ar: "Arabic", pt: "Portuguese", ru: "Russian", id: "Indonesian",
          vi: "Vietnamese" }[L] || L;
        // batch in chunks to keep prompts sane
        const chunks = [];
        for (let i = 0; i < missing.length; i += 60) chunks.push(missing.slice(i, i + 60));
        let pending = chunks.length;
        const finish = () => { if (--pending <= 0) {
          try { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(cache)); fs.renameSync(tmp, file); } catch {}
        } };
        for (const chunk of chunks) {
          const prompt = `Translate these UI strings from Thai to ${langName}. ` +
            `Keep emoji, symbols, numbers, code and placeholders (like \${...}, <...>) EXACTLY. ` +
            `Natural, concise product-UI wording. Return ONLY a JSON object mapping each ` +
            `original string to its translation.\n\n` + JSON.stringify(chunk);
          const reqBody = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
          });
          const rq = require("https").request({
            method: "POST", host: "generativelanguage.googleapis.com",
            path: "/v1beta/models/gemini-flash-latest:generateContent?key=" + gm,
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(reqBody) },
          }, (rs) => {
            let o = ""; rs.on("data", (c) => (o += c));
            rs.on("end", () => {
              try {
                const j = JSON.parse(o);
                const txt = j.candidates && j.candidates[0] &&
                  j.candidates[0].content.parts.map((p) => p.text || "").join("");
                const m = JSON.parse(txt.match(/\{[\s\S]*\}/)[0]);
                for (const k of chunk) if (m[k] !== undefined) cache[k] = String(m[k]);
                auxCost("gemini", chunk.join("").length * COST_RATES.gemini_i18n_per_char);
              } catch (e) { console.error("[i18n]", e.message); }
              finish();
            });
          });
          rq.setTimeout(40000, () => { rq.destroy(); finish(); });
          rq.on("error", () => finish());
          rq.write(reqBody); rq.end();
        }
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/registry/lang") {
    readBody(req, (body) => {
      try {
        reg.lang = String(JSON.parse(body).lang || "th").slice(0, 5).toLowerCase();
        saveReg();
        pushRoster();
        // Tell the wallpaper world to re-pull its status-plate translations so
        // the 3D office matches the overlay's language live (transient — not
        // journaled; godot also reads the language on its own startup).
        broadcast({ type: "ui.lang", lang: reg.lang }, false);
        res.writeHead(200); res.end("ok");
      } catch { res.writeHead(400); res.end("bad json"); }
    });

  } else if (req.method === "POST" && req.url === "/registry/social") {
    readBody(req, (body) => {
      try {
        reg.socialMin = Math.max(0, Number(JSON.parse(body).min) || 0);
        saveReg();
        pushRoster();
        res.writeHead(200); res.end("ok");
      } catch { res.writeHead(400); res.end("bad json"); }
    });

  } else if (req.method === "POST" && req.url === "/registry/proposalmin") {
    readBody(req, (body) => {
      try {
        reg.proposalMin = Math.max(0, Number(JSON.parse(body).min) || 0);
        saveReg();
        pushRoster();
        res.writeHead(200); res.end("ok");
      } catch { res.writeHead(400); res.end("bad json"); }
    });

  } else if (req.method === "GET" && req.url === "/tts/presets") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(Object.fromEntries(
      Object.entries(VOICE_PRESETS).map(([id, p]) => [id, p.label]))));

  } else if (req.method === "POST" && req.url === "/tts") {
    // 🗣 speak: {text, preset} or {text, agent} (uses the agent's voice).
    // {intro:true} → a gender- + language-aware self-introduction (voice preview).
    readBody(req, (body) => {
      try {
        const { text, preset, agent, intro } = JSON.parse(body);
        const pid = preset || (reg.agents[agent] && reg.agents[agent].voice);
        if (!pid) throw new Error("agent นี้ยังไม่ได้ตั้งเสียง");
        const say = intro ? voiceIntro(pid, reg.lang || "th") : text;
        if (!say) throw new Error("no text");
        ttsSpeak(pid, say).then((wav) => {
          // payload is deterministic per (preset+text) and cached on disk now;
          // no-store was a no-op for POST anyway (browsers don't cache POST).
          res.writeHead(200, { "content-type": "audio/wav" });
          res.end(wav);
        }).catch((e) => {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(String(e.message));
        });
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/registry/tts") {
    readBody(req, (body) => {
      try {
        reg.tts = !!JSON.parse(body).enabled;
        saveReg();
        pushRoster();
        res.writeHead(200); res.end("ok");
      } catch { res.writeHead(400); res.end("bad json"); }
    });

  } else if (req.method === "POST" && req.url === "/voice/transcribe") {
    // 🎤 WAV in → text out (Whisper / Gemini via the key vault).
    readBodyRaw(req, (buf) => {
      if (!buf || buf.length < 4000) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        return res.end("เสียงสั้นเกินไป — กดค้างแล้วพูดให้จบก่อนปล่อย");
      }
      if (buf.length > 24 * 1024 * 1024) {
        res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
        return res.end("คลิปยาวเกินไป (จำกัด ~60 วินาที)");
      }
      voiceTranscribe(buf).then((text) => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ text }));
      }).catch((e) => {
        console.error("[voice]", e.message);
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(String(e.message || e));
      });
    });

  } else if (req.method === "POST" && req.url === "/update") {
    // Human-triggered only (in-app 🔄 button or the CLI).
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    const ps = path.join(__dirname, "..", "installer", "update.ps1");
    // Launch in a REAL, visible console window via `cmd start` so the user can
    // watch git pull + the rebuild — a silent detached process looked hung. It
    // also outlives this daemon (the updater kills + relaunches the whole suite).
    spawn("cmd.exe", ["/c", "start", "BagIdea Update", "powershell",
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps],
      { detached: true, stdio: "ignore", windowsHide: false }).unref();
    res.writeHead(200); res.end("ok");

  } else if (req.method === "POST" && req.url === "/snapshot/run") {
    // 📸 build+preview+screenshot+teardown in one request; responds with the
    // record. One at a time — previews own real ports.
    readBody(req, (body) => {
      let pref = "";
      try { pref = JSON.parse(body).project; } catch {}
      // Resolve up-front: an unknown/empty project must be REJECTED, not run —
      // otherwise it persists a junk error record and clutters the gallery.
      if (!resolveProjectRef(pref)) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "unknown project: " + String(pref || "") }));
      }
      if (snapshotBusy) {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "snapshot already running" }));
      }
      snapshotBusy = true;
      runSnapshot(pref)
        .then((rec) => {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(rec));
        })
        .catch((e) => { res.writeHead(500); res.end(String(e.message)); })
        .finally(() => { snapshotBusy = false; });
    });

  } else if (req.method === "GET" && req.url.startsWith("/snapshots/img/")) {
    const name = decodeURIComponent(req.url.split("/").pop() || "").replace(/[\\/]|\.\./g, "");
    fs.readFile(path.join(SNAPSHOTS_DIR, name), (e, data) => {
      if (e) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
      res.end(data);
    });

  } else if (req.method === "GET" && req.url.split("?")[0] === "/snapshots") {
    // Per-project gallery: ?project=<id|path|name>; all/empty = everything.
    const ref = new URL(req.url, "http://x").searchParams.get("project");
    let out = snapshots;
    if (ref !== null && ref !== "" && ref !== "all") {
      const spid = resolveProjectRef(ref);
      out = spid ? snapshots.filter((s) => s.project === spid) : [];
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ snapshots: out }));

  } else if (req.method === "POST" && req.url === "/snapshot/open") {
    readBody(req, async (body) => {
      try {
        const p = JSON.parse(body);
        const rec = snapshots.find((s) => s.snapshotId === String(p.snapshotId || ""));
        if (!rec) { res.writeHead(404); return res.end("unknown snapshot"); }
        if (!p.live) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ url: rec.url }));
        }
        const live = await openLivePreview(rec.project);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ liveUrl: "http://127.0.0.1:" + live.port + "/",
          port: live.port, ttlSec: live.ttlSec }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/snapshot/delete") {
    // 🗑 Remove one gallery image: delete the PNG from disk AND drop its record
    // from the store, then broadcast so every open gallery refreshes itself.
    // Idempotent: a missing file still purges the entry (ENOENT is not an error).
    // Path-safe: the file we unlink is confined to SNAPSHOTS_DIR (resolveSnapFile).
    // Human-UI only: deletion is destructive, so gate it like every other
    // destructive route in this file — the overlay already sends x-bagidea-ui.
    if (!req.headers["x-bagidea-ui"]) { res.writeHead(403); return res.end("human UI only"); }
    readBody(req, (body) => {
      const json = (o) => { const code = o._c || 200; delete o._c;  // _c is an internal carrier — never leak it
        res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(o)); };
      let p = {};
      try { p = JSON.parse(body); } catch {}
      const id = String(p.snapshotId || p.id || "");
      const ref = String(p.path || p.imagePath || p.url || "");
      if (!id && !ref) return json({ _c: 400, error: "snapshotId or path required" });
      // Locate the record: by id first, else by matching image basename.
      let idx = -1;
      if (id) idx = snapshots.findIndex((s) => s.snapshotId === id);
      const refBase = ref ? path.basename(ref.replace(/\\/g, "/")) : "";
      if (idx < 0 && refBase)
        idx = snapshots.findIndex((s) =>
          path.basename(String(s.imagePath || s.url || "").replace(/\\/g, "/")) === refBase);
      const rec = idx >= 0 ? snapshots[idx] : null;
      // The file to remove comes from the record when we have one (trustworthy),
      // otherwise from the caller's ref — both pass through the confinement gate.
      const srcRef = (rec && (rec.imagePath || rec.url)) || ref;
      const full = srcRef ? resolveSnapFile(srcRef) : null;
      if (srcRef && !full) return json({ _c: 400, error: "path outside snapshots dir" });
      let fileDeleted = false;
      if (full) {
        try { fs.unlinkSync(full); fileDeleted = true; }
        catch (e) { if (e.code !== "ENOENT") return json({ _c: 500, error: "unlink: " + e.message }); }
      }
      // Purge the record(s). Splice the located one; if we only had a path,
      // drop every entry that points at the same file (defensive against dupes).
      const removedId = rec ? rec.snapshotId : "";
      if (idx >= 0) snapshots.splice(idx, 1);
      else if (refBase)
        snapshots = snapshots.filter((s) =>
          path.basename(String(s.imagePath || s.url || "").replace(/\\/g, "/")) !== refBase);
      saveSnapshots();
      broadcast({ type: "snapshot.deleted", snapshotId: removedId,
        imagePath: srcRef }, false);  // transient — FE prunes its cache
      json({ ok: true, deleted: removedId || refBase, fileDeleted });
    });

  } else if (req.method === "POST" && req.url === "/review/run") {
    // 🧑‍⚖️ run the Codex gate by hand (Director / automation).
    readBody(req, (body) => {
      let p = {};
      try { p = JSON.parse(body); } catch {}
      // A fail verdict dispatches a bounce job to this agent — it must exist.
      if (p.agentId && !reg.agents[String(p.agentId)]) {
        res.writeHead(404); return res.end("unknown agent: " + String(p.agentId).slice(0, 40));
      }
      runReviewGate(p.agentId, p.project)
        .then((r) => {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(r));
        })
        .catch((e) => { res.writeHead(500); res.end(String(e.message)); });
    });

  } else if (req.method === "GET" && req.url.split("?")[0] === "/review/last") {
    const a = new URL(req.url, "http://x").searchParams.get("agent") || REVIEW_AGENT;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ result: reviewState.last[a] || null }));

  } else if (req.method === "POST" && req.url === "/review/toggle") {
    // 🧑‍⚖️ Connect-modal switch: off pauses the AUTO gate on Mr N's
    // deliveries only — an explicit POST /review/run still works.
    readBody(req, (body) => {
      let p = {};
      try { p = JSON.parse(body); } catch {}
      reviewState.enabled = p.enabled !== false;
      saveReview();
      broadcast({ type: "review.toggle", enabled: reviewState.enabled }, false);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ enabled: reviewState.enabled }));
    });

  } else if (req.method === "GET" && req.url === "/review/status") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ enabled: reviewState.enabled !== false,
      codexAvailable: reviewState.codexAvailable,
      pendingReReview: reviewState.pending, rounds: reviewState.rounds,
      decisions: (reviewState.decisions || []).slice(0, 20) }));

  } else if (req.method === "POST" && req.url === "/review/decision") {
    // 🧑‍⚖️ HUMAN approve/reject — the CEO's verdict button. Codex gives the
    // neutral machine read; this is the person overriding/finalizing it
    // (escalated jobs, or any deliverable the CEO wants to wave through or
    // bounce by hand). Persists + broadcasts so the UI updates live.
    //   approve → accept the work: clear that deliverable's round/escalate +
    //             drop any passby IOU. No bounce.
    //   reject  → dispatch a rework job back to the agent with the note.
    readBody(req, (body) => {
      let p = {};
      try { p = JSON.parse(body); } catch {}
      const decision = String(p.decision || "").toLowerCase();
      if (decision !== "approve" && decision !== "reject") {
        res.writeHead(400);
        return res.end('decision must be "approve" or "reject"');
      }
      const agentId = String(p.agentId || REVIEW_AGENT);
      // A reject dispatches a job to this agent — it must exist in the registry.
      if (decision === "reject" && !reg.agents[agentId]) {
        res.writeHead(404); return res.end("unknown agent: " + agentId.slice(0, 40));
      }
      const rpid = p.project ? resolveProjectRef(p.project) : "";
      const roundKey = (rpid || "?") + "|" + agentId;
      const rec = { decisionId: "dc" + Date.now(),
        reviewId: p.reviewId ? String(p.reviewId).slice(0, 40) : "",
        agentId, project: rpid || "", decision,
        by: String(p.by || "main").slice(0, 40),
        note: String(p.note || "").slice(0, 2000),
        round: reviewState.rounds[roundKey] || 0, ts: Date.now() };
      reviewState.decisions = reviewState.decisions || [];
      reviewState.decisions.unshift(rec);
      reviewState.decisions = reviewState.decisions.slice(0, 100);
      // Stamp the agent's last review so the card reflects the human verdict.
      if (reviewState.last[agentId]) {
        reviewState.last[agentId].decision = decision;
        reviewState.last[agentId].decidedBy = rec.by;
        reviewState.last[agentId].decidedTs = rec.ts;
      }
      if (decision === "approve") {
        // Accepted: stop the bounce cycle for this deliverable, drop passby IOU.
        reviewState.rounds[roundKey] = 0;
        reviewState.pending = reviewState.pending
          .filter((x) => !(x.agentId === agentId && x.project === rpid));
      }
      saveReview();
      broadcast({ type: "review.decision", ...rec }, false);
      broadcast({ type: "chat.message", agent: "main",
        text: (decision === "approve" ? "✅ อนุมัติ" : "❌ ตีกลับ") +
          "งานของ " + agentId + (rpid ? " (" + rpid + ")" : "") +
          " โดย " + rec.by + (rec.note ? " — " + rec.note : "") });
      if (decision === "reject") {
        const fb = "🧑‍⚖️ [ตีกลับโดย " + rec.by + "] กรุณาแก้แล้วส่งงานใหม่อีกครั้ง" +
          (rec.note ? "\nหมายเหตุ: " + rec.note : "");
        const job = { id: "j" + Date.now(), agent: agentId, project: rpid || "",
          prompt: fb.slice(0, 4000), mode: "now", at: 0, time: "", daily: false,
          everyMin: 10, enabled: true, created: Date.now() };
        jobs.push(job); saveJobs(); dispatchJob(job);
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, decision: rec }));
    });

  } else if (req.method === "POST" && req.url === "/npc/request") {
    // 🧑‍🤝‍🧑 a character asks for a helper → synthesize a proposal for the CEO.
    // GUARD (anti auto-spawn): a pending-approval card is only created for an
    // EXPLICIT request — from the office UI (x-bagidea-ui) or a Director call
    // relaying a real user order (body.explicit === true). Anything else
    // (smoke tests, stray automation) falls back to a chat mention instead of
    // queueing junk like requester=main role="x" for the CEO to dismiss.
    readBody(req, (body) => {
      try {
        const p = JSON.parse(body);
        const requesterId = String(p.requesterId || "");
        if (!reg.agents[requesterId]) { res.writeHead(404); return res.end("unknown requester"); }
        const role = String(p.role || "").trim();
        const reason = String(p.reason || "").trim();
        if (!role || !reason) { res.writeHead(400); return res.end("need role + reason"); }
        const explicit = p.explicit === true || req.headers["x-bagidea-ui"] === "1";
        if (!explicit || role.length < 2 || reason.length < 10) {
          // fallback: surface the wish in chat — never a silent approval card.
          broadcast({ type: "chat.message", agent: requesterId, social: true,
            text: "อยากได้ผู้ช่วยตำแหน่ง \"" + role.slice(0, 40) + "\" (" +
              reason.slice(0, 120) + ") — ถ้าท่านเห็นด้วย สั่ง hire ได้เลยครับ" });
          res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ ok: false, created: false,
            hint: "ต้องเป็นคำขอ explicit (explicit:true ตามคำสั่งผู้ใช้/Director " +
              "หรือยิงจาก UI) และ role ≥ 2 / reason ≥ 10 ตัวอักษร" }));
        }
        const roleKey = role.slice(0, 40).toLowerCase();
        if (npcProposals.some((x) => x.requester === requesterId &&
            String(x.role).toLowerCase() === roleKey)) {
          res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
          return res.end("มีใบขอตำแหน่งนี้จากผู้ขอคนเดิมค้างรออนุมัติอยู่แล้ว");
        }
        if (npcProposals.length >= NPC_MAX_PENDING) {
          res.writeHead(429, { "content-type": "text/plain; charset=utf-8" });
          return res.end("มีคำขอค้างรออนุมัติเต็มแล้ว (" + NPC_MAX_PENDING + ") — ให้ CEO เคลียร์ก่อน");
        }
        if (staffCount() >= MAX_STAFF) {
          res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
          return res.end("ออฟฟิศเต็มแล้ว — รับพนักงานได้สูงสุด " + MAX_STAFF + " คน (ไม่นับ CEO)");
        }
        generateNpcProposal(requesterId, role, reason, p.benefit).then((proposal) => {
          npcProposals.push(proposal);
          saveNpcProposals();
          broadcast({ type: "npc.request", ...proposal }, false);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ requestId: proposal.requestId, proposal }));
        }).catch((e) => { res.writeHead(500); res.end(String(e.message)); });
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/npc/decision") {
    // CEO verdict: approve → a real, delegate-able agent joins the roster.
    readBody(req, (body) => {
      try {
        const { requestId, approved } = JSON.parse(body);
        const prop = npcProposals.find((x) => x.requestId === String(requestId || ""));
        if (!prop) { res.writeHead(404); return res.end("unknown request"); }
        if (!approved) {
          npcProposals = npcProposals.filter((x) => x.requestId !== prop.requestId);
          saveNpcProposals();
          broadcast({ type: "npc.rejected", requestId: prop.requestId }, false);
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ ok: true, approved: false }));
        }
        // Capacity is checked BEFORE the proposal is consumed — a full office
        // must leave the card pending (the modal can re-pop it later), not
        // silently swallow a CEO approval.
        if (staffCount() >= MAX_STAFF) {
          res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
          return res.end("ออฟฟิศเต็มแล้ว — รับพนักงานได้สูงสุด " + MAX_STAFF + " คน (ไม่นับ CEO)");
        }
        npcProposals = npcProposals.filter((x) => x.requestId !== prop.requestId);
        saveNpcProposals();
        let id = slugId(prop.name);
        for (let n = 2; reg.agents[id]; n++) id = slugId(prop.name).slice(0, 20) + "-" + n;
        // Proposals are registry-grade (prompt + persona{} + aura/voice).
        // Legacy pending cards carried prose in `persona` (string) and no
        // prompt — map those through so an old card still approves cleanly.
        const px = (prop.persona && typeof prop.persona === "object") ? prop.persona : null;
        reg.agents[id] = {
          name: prop.name, role: prop.role,
          avatar: 1 + (hashInt(id) % 12),
          aura: NPC_AURAS.includes(prop.aura) ? prop.aura : "",
          prompt: String(prop.prompt ||
            (typeof prop.persona === "string" ? prop.persona : "")).slice(0, 4000),
          persona: px ? {
            expertise: String(px.expertise || "").slice(0, 1500),
            personality: String(px.personality || "").slice(0, 1500),
            language: String(px.language || "ไทย").slice(0, 80),
            rules: String(px.rules || "").slice(0, 1500),
          } : { expertise: (prop.skills || []).join(", "), personality: "",
            language: "ไทย", rules: "" },
          tier: 3, voice: VOICE_PRESETS[prop.voice] ? prop.voice : "",
          skills: prop.skills || [], tools: prop.tools || [],
          ...(prop.avatarPath ? { avatarPath: prop.avatarPath } : {}),
        };
        saveReg();
        if (MODEL_IDS.has(prop.model)) {
          modelSettings.perAgent[id] = prop.model;
          saveModelSettings();
          broadcast({ type: "models.changed", default: modelSettings.default,
            perAgent: modelSettings.perAgent }, false);
        }
        pushRoster();
        broadcast({ type: "npc.created", agentId: id, name: prop.name,
          role: prop.role, avatarPath: prop.avatarPath || "" }, false);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, approved: true, agentId: id }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "GET" && req.url === "/npc/proposals") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ proposals: npcProposals }));

  } else if (req.method === "GET" && req.url.split("?")[0] === "/voice/lines") {
    const a = new URL(req.url, "http://x").searchParams.get("agent") || "";
    const v = voiceLines[a] || { bank: [], recent: [] };
    const amb = v.ambient || { bank: [], recent: [] };
    // scene pools that include this agent (or all pools with agent omitted)
    const scenes = {};
    for (const [k, p] of Object.entries(voiceLines["@scenes"] || {}))
      if (!a || k.split("::")[1].split("+").includes(a))
        scenes[k] = { bank: p.bank.length, recent: p.recent.length };
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ bank: v.bank, recent: v.recent, ambient: amb, scenes }));

  } else if (req.method === "POST" && req.url === "/voice/ambient") {
    // Force one ambient musing (e2e/test hook) — same pick path as the timer.
    readBody(req, (body) => {
      try {
        const p = body ? JSON.parse(body) : {};
        if (p.agentId && !reg.agents[p.agentId]) {
          res.writeHead(404); return res.end("unknown agent");
        }
        const pool = Object.keys(reg.agents).filter((id) => id !== "ceo");
        const id = p.agentId || pool[Math.floor(Math.random() * pool.length)];
        if (!id) { res.writeHead(404); return res.end("no agents"); }
        const text = pickAmbientLine(id);
        broadcast({ type: "chat.message", agent: id, text, social: true, ambient: true });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ agentId: id, text }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/voice/interact") {
    // Force one interaction scene (e2e/test hook). body: {agents?, ctx?}
    readBody(req, (body) => {
      try {
        const p = body ? JSON.parse(body) : {};
        const pool = Object.keys(reg.agents).filter((id) => id !== "ceo");
        const ids = Array.isArray(p.agents)
          ? p.agents.filter((id) => reg.agents[id]) : null;
        const out = playInteractScene(pool,
          { ...(ids && ids.length ? { ids } : {}), ...(p.ctx ? { ctxId: p.ctx } : {}) });
        if (!out) { res.writeHead(409); return res.end("no scene possible"); }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(out));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.method === "POST" && req.url === "/voice/say") {
    // Force one in-character line (e2e/test hook) — same flow as the real
    // task.completed trigger, throttle bypassed.
    readBody(req, (body) => {
      try {
        const { agentId } = JSON.parse(body);
        const base = String(agentId || "").split("#")[0];
        if (!reg.agents[base]) { res.writeHead(404); return res.end("unknown agent"); }
        const text = voiceAnnounce(base, true);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ text }));
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });

  } else if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ clients: wsClients.size, pendingPerms: pendingPerms.size,
      wt: HAS_WT }));

  } else {
    res.writeHead(404);
    res.end();
  }
});

function finishPerm(id, decision, why) {
  const p = pendingPerms.get(id);
  if (!p) return false;
  pendingPerms.delete(id);
  clearTimeout(p.timer);
  p.res.writeHead(200, { "content-type": "application/json" });
  p.res.end(JSON.stringify({ decision }));
  broadcast({
    type: decision === "allow" ? "perm.approved" : "perm.denied",
    agent: p.agent, task: p.task, tool: p.tool, perm: id, via: why,
  });
  return true;
}

// WS upgrade — renderers (Godot) and overlays share one stream.
// Parse masked client→server WS frames (the event stream never needed this;
// the realtime voice bridge does). Calls cb(opcode, payloadBuffer).
function makeFrameParser(cb) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      const masked = !!(buf[1] & 0x80);
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload;
      if (masked) {
        const mask = buf.slice(off, off + 4);
        payload = Buffer.from(buf.slice(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      } else payload = buf.slice(off, off + len);
      buf = buf.slice(need);
      cb(op, payload);
    }
  };
}

// 📞 Realtime voice: bridge the overlay mic ⇄ Gemini Live, with the office's
// own knowledge in the system prompt and an agent's voice preset.
function handleLive(req, sock) {
  const key = req.headers["sec-websocket-key"];
  if (!key) return sock.destroy();
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
    "Connection: Upgrade\r\nSec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n");
  const toClient = (obj) => { try { sock.write(wsFrame(JSON.stringify(obj))); } catch {} };
  const gm = (reg.apiKeys || {}).GEMINI_API_KEY;
  if (!gm) { toClient({ type: "error", text: "ต้องมี GEMINI_API_KEY (⚙ CONNECT) สำหรับ realtime" }); return; }

  // Calling is for the MAIN agent only — it speaks for the whole office. Use the
  // voice the owner assigned to main; if none, fall back to a default preset.
  const a = reg.agents["main"] || {};
  const presetVoice = (VOICE_PRESETS[a.voice] || {}).voice || "Aoede";
  const ctxNote = (() => {
    try { return fs.readFileSync(OFFICE_MD, "utf8").slice(0, 2000); } catch { return ""; }
  })();
  const team = teamList();

  const gemini = require("./channels").wsConnect(
    "generativelanguage.googleapis.com",
    "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" + gm,
    {
      onOpen() {
        gemini.send(JSON.stringify({ setup: {
          model: "models/gemini-2.5-flash-native-audio-latest",
          generationConfig: { responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: presetVoice } } } },
          systemInstruction: { parts: [{ text:
            `คุณคือ "${a.name || "ผู้ช่วย"}" พนักงานใน BagIdea Office คุยกับเจ้าของแบบเป็นกันเอง ` +
            `ภาษาไทย กระชับ. ทีมงาน:\n${team}\nข้อมูลออฟฟิศ:\n${ctxNote}` }] },
        } }));
        toClient({ type: "ready" });
      },
      onMsg(raw) {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.setupComplete) return toClient({ type: "live-ready" });
        const parts = m.serverContent && m.serverContent.modelTurn &&
          m.serverContent.modelTurn.parts;
        if (parts) for (const p of parts) {
          if (p.inlineData && p.inlineData.data)
            toClient({ type: "audio", data: p.inlineData.data });  // 24k PCM base64
        }
        if (m.serverContent && m.serverContent.turnComplete) toClient({ type: "turn-done" });
      },
      onClose() { toClient({ type: "closed" }); try { sock.end(); } catch {} },
    });

  // overlay → us: text frames carry {type:'audio', data} (16k PCM base64).
  const parse = makeFrameParser((op, payload) => {
    if (op === 8) { try { gemini.close(); } catch {} return; }
    if (op !== 1) return;
    let m; try { m = JSON.parse(payload.toString("utf8")); } catch { return; }
    if (m.type === "audio") {
      gemini.send(JSON.stringify({ realtimeInput: { mediaChunks: [
        { mimeType: "audio/pcm;rate=16000", data: m.data }] } }));
    }
  });
  sock.on("data", parse);
  sock.on("close", () => { try { gemini.close(); } catch {} });
  sock.on("error", () => { try { gemini.close(); } catch {} });
}

server.on("upgrade", (req, sock) => {
  if (req.url.startsWith("/live")) return handleLive(req, sock);
  if (!req.url.startsWith("/ws")) return sock.destroy();
  const key = req.headers["sec-websocket-key"];
  if (!key) return sock.destroy();
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  wsClients.add(sock);
  console.log("[oep] ws client connected", `(${wsClients.size})`);
  sock.on("close", () => wsClients.delete(sock));
  sock.on("error", () => wsClients.delete(sock));
  sock.on("data", () => {}); // inbound frames (pings/close) — TCP close is enough
  // Journal replay so a restarted renderer/overlay rebuilds its state.
  for (const line of journalTail(REPLAY_COUNT)) {
    try {
      const evt = JSON.parse(line);
      evt.replay = true;
      sock.write(wsFrame(JSON.stringify(evt)));
    } catch {}
  }
  // Fresh roster snapshot last — registry.json is the truth, not the journal.
  sock.write(wsFrame(JSON.stringify({ ...rosterEvt(), ts: Date.now() })));
  // 🟢 Current per-agent status too — agent.status is live-only (never
  // journaled), so a fresh client would otherwise wait for the next change.
  sock.write(wsFrame(JSON.stringify({ type: "agent.status",
    agents: agentStatusSnapshot(), ts: Date.now() })));
});

// ----------------------------------------------------- ♻ restart-on-change
// CEO rule: any edit to the office "just works" automatically — no manual
// restart. Three tiers, lightest first:
//   • plugins/<id>/…   → hot-reload in place (plugins.load), no restart.
//   • overlay.html     → tell open overlays to reload the page (it's served
//                        per-request, so a reload picks the new file up).
//   • daemon code .js  → graceful self-restart, but ONLY when the office is
//                        idle, so no agent run is ever cut mid-flight.
// Escape hatch: set BAGIDEA_NO_WATCH=1 to turn the watcher off entirely.
const WATCH_OFF = process.env.BAGIDEA_NO_WATCH === "1";
// Every local `require("./x")` server.js depends on MUST be listed here: the
// watcher restarts the daemon when one changes, and doRestart() runs `node
// --check` on each before handing off. Miss one and an edit to that module
// neither triggers a restart nor gets syntax-gated before the successor spawns.
// Split-out modules (constants/maintenance/skills/osutil) are dependencies too.
const CODE_FILES = new Set(["server.js", "channels.js", "plugins.js", "send.js",
  "retrieval.js", "constants.js", "maintenance.js", "skills.js", "osutil.js",
  "watchdog.js", "watchdog-runtime.js", "lock.js",
  "tts-cache.js", "review-coalesce.js"]);
const WEB_FILES = new Set(["overlay.html"]);

let restartArmed = false;
// Busy-defer cap for a requested restart: past this we restart over live runs
// and let the runs.json boot triage recover them (กัน deploy โดนบล็อคถาวร).
const RESTART_MAX_DEFER_MS =
  Math.max(60000, Number(process.env.OEP_RESTART_MAX_DEFER_MS) || 10 * 60000);
function requestRestart(reason) {
  if (restartArmed) return;          // one handoff at a time
  restartArmed = true;
  console.log("[watch] restart requested —", reason);
  broadcast({ type: "daemon.restarting", reason }, false);
  const deferSince = Date.now();
  const tick = () => {
    // Never cut a session: wait until every agent run has finished —
    // `agentBusy` covers scheduled jobs, but chat/delegate runs live in
    // `activeRuns`; restarting over them would have the successor's boot
    // sweep auto-resume work whose old child is STILL RUNNING for up to 6s
    // (duplicate execution). Watchdog "stuck" is NOT proof of death — a long
    // Bash build emits no tool events yet keeps changing files — so ANY
    // active run defers the restart… but BOUNDED: a wedged run must not block
    // deploys forever. Past the cap we restart anyway and let the boot triage
    // (runs.json) recover whatever was cut — that's exactly what it's for.
    const overdue = Date.now() - deferSince >= RESTART_MAX_DEFER_MS;
    // `activeDiscussions` too: a meeting is claudeText children, invisible to both
    // agentBusy and activeRuns — restarting over it cuts the room mid-talk
    // (the "silent meeting" bug from another angle). Meetings are short and
    // the overdue cap still bounds a wedged one.
    if (!overdue && (agentBusy.size > 0 || activeRuns.size > 0 || activeDiscussions > 0)) {
      console.log("[watch] " + agentBusy.size + " job(s) + " + activeRuns.size +
        " live run(s)" + (activeDiscussions > 0 ? " + meeting" : "") + " busy — deferring restart…");
      return setTimeout(tick, 1500);
    }
    const forcedOver = overdue && (agentBusy.size > 0 || activeRuns.size > 0 || activeDiscussions > 0);
    if (forcedOver) {
      console.log("[watch] defer cap reached (" + RESTART_MAX_DEFER_MS + "ms) — restarting over " +
        agentBusy.size + " job(s) + " + activeRuns.size + " run(s); boot triage will recover them");
      broadcast({ type: "chat.message", agent: "main", watchdog: true,
        text: "♻️ รอ restart นาน " + Math.round(RESTART_MAX_DEFER_MS / 60000) +
          " นาทีแล้วยังไม่ว่าง (job " + agentBusy.size + " + run " + activeRuns.size +
          ") — รีสตาร์ททับเลย งานที่โดนตัดจะถูกกู้/ต่ออัตโนมัติจาก runs.json" });
    }
    doRestart(forcedOver);
  };
  setTimeout(tick, 250);
}
function doRestart(cutRuns) {
  // Syntax-guard: NEVER hand off to a daemon that can't even parse. A
  // half-saved server.js would exit the old process and leave the office
  // with nothing to respawn it — `node --check` every code file first; any
  // failure cancels the restart and the current (working) daemon stays up.
  for (const f of CODE_FILES) {
    const full = path.join(__dirname, f);
    if (!fs.existsSync(full)) continue;
    const chk = spawnSync(process.execPath, ["--check", full],
      { timeout: 15000, windowsHide: true });
    if (chk.status !== 0 || chk.error) {
      const err = (chk.error ? chk.error.message
        : String(chk.stderr || "").split("\n").slice(0, 3).join(" ")).trim();
      console.log("[watch] RESTART BLOCKED — " + f + " failed node --check; " +
        "keeping current daemon. " + err);
      broadcast({ type: "daemon.restart_blocked", file: f,
        error: err.slice(0, 300) }, false);
      restartArmed = false;   // the next (fixed) save re-arms the restart
      return;
    }
  }
  // Forced handoff over live runs: kill every claude tree ONLY NOW — after
  // the syntax gate passed and the handoff is really happening. Children
  // outlive their parent on Windows (no job object), so leaving them alive
  // would have the successor's auto-resume duplicate work still being done.
  // _restartCut keeps each disk record "running" for the successor's triage;
  // restartCutTasks lets the ABORT path (successor dies at boot) recover
  // them in THIS daemon instead — killed children must never strand records.
  if (cutRuns) for (const [task, c] of allRunChildren) {
    c._restartCut = true;
    restartCutTasks.add(task);
    try {
      if (process.platform === "win32")
        spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], { windowsHide: true });
      else c.kill("SIGKILL");
    } catch {}
  }
  console.log("[watch] handing off to a fresh daemon…");
  // The successor's output goes to deploy-restart.log — a boot crash with
  // stdio:"ignore" used to vanish without a trace.
  let succLog = "ignore";
  try { succLog = fs.openSync(path.join(__dirname, "deploy-restart.log"), "a"); } catch {}
  let succ;
  try {
    succ = spawn(process.execPath, [__filename],
      { cwd: __dirname, env: process.env, detached: true,
        stdio: ["ignore", succLog, succLog] });
    succ.unref();
  } catch (e) {
    console.log("[watch] respawn failed, staying up:", e.message);
    restartArmed = false;
    // A forced handoff already KILLED live children above (cutRuns), but the
    // successor that was meant to triage+resume them never spawned. The port
    // is still ours (server.close() below hasn't run) — so recover those cut
    // runs HERE, or they sit "running" in runsState.live forever. No-op when
    // nothing was cut (restartCutTasks empty).
    recoverRestartCuts();
    return;
  }
  // Boot watchdog: `node --check` can't catch RUNTIME boot failures (broken
  // require, bad top-level code). Release the port, then watch the successor
  // for 6s — if it dies that fast, re-claim the port and stay up instead of
  // leaving the office with no daemon at all.
  let succDead = false;
  succ.on("exit", (code) =>
    { succDead = true; console.log("[watch] successor died at boot (exit " + code + ")"); });
  try { server.close(); } catch {}
  const handoffAt = Date.now();
  const watchdog = setInterval(() => {
    if (succDead) {
      clearInterval(watchdog);
      console.log("[watch] RESTART ABORTED — successor crashed at boot; re-claiming :" + OEP_PORT);
      broadcast({ type: "daemon.restart_blocked", file: "(boot)",
        error: "successor died at boot — ดู daemon/deploy-restart.log" }, false);
      restartArmed = false;   // the next (fixed) save re-arms the restart
      listenTries = 0;
      try { server.listen(OEP_PORT, "127.0.0.1"); } catch (e) { console.error("[watch] re-listen:", e.message); }
      // A forced handoff already killed live children for the successor's
      // triage — but the successor never made it. WE are the daemon again:
      // recover those cut runs here, or they sit "running" forever.
      recoverRestartCuts();
      return;
    }
    if (Date.now() - handoffAt >= 6000) { clearInterval(watchdog); process.exit(0); }
  }, 300);
}

let watchersUp = false;
function startWatchers() {
  if (watchersUp) return;
  watchersUp = true;
  if (WATCH_OFF) { console.log("[watch] disabled (BAGIDEA_NO_WATCH=1)"); return; }
  let plugT = null, webT = null, codeT = null;
  // plugins/ (recursive) → hot reload, never a restart. Plugins live at the
  // repo root (daemon/../plugins), the same dir plugins.js loads from.
  const PLUGINS_DIR = path.join(__dirname, "..", "plugins");
  try {
    fs.watch(PLUGINS_DIR, { recursive: true }, () => {
      clearTimeout(plugT);
      plugT = setTimeout(() => {
        try {
          plugins.load();
          broadcast({ type: "plugins.changed" }, false);
          console.log("[watch] plugins hot-reloaded");
        } catch (e) { console.log("[watch] plugin reload failed:", e.message); }
      }, 600);
    });
  } catch (e) { console.log("[watch] plugins watch unavailable:", e.message); }
  // daemon dir (top level only) → front-end reload vs code restart. Data files
  // (journal/sessions/jobs/projects/registry…) are ignored — they change all
  // the time and must NOT trigger anything.
  try {
    fs.watch(__dirname, { recursive: false }, (_evt, file) => {
      if (!file) return;
      if (WEB_FILES.has(file)) {
        clearTimeout(webT);
        webT = setTimeout(() => {
          broadcast({ type: "client.reload", file }, false);
          console.log("[watch] front-end changed → clients reload:", file);
        }, 400);
      } else if (CODE_FILES.has(file)) {
        clearTimeout(codeT);
        codeT = setTimeout(() => requestRestart("changed: " + file), 800);
      }
    });
  } catch (e) { console.log("[watch] daemon watch unavailable:", e.message); }
  console.log("[watch] restart-on-change active");
}

// ---- 🐕 WatchDog STEP 2: runtime loop + auto-wake -------------------------
// ห่อ watchdogMod.evaluate (pure) ด้วย side-effect layer ที่ฉีด deps ทั้งหมด:
// poll agent-status `status` ทุก WATCHDOG_INTERVAL_MS → ปลุก agent ที่ค้าง.
const WATCHDOG_INTERVAL_MS =
  Math.max(5000, Number(process.env.OEP_WATCHDOG_INTERVAL_MS) || 30_000);
const WATCHDOG_COOLDOWN_MS =
  Math.max(30_000, Number(process.env.OEP_WATCHDOG_COOLDOWN_MS) || 5 * 60_000);

// fetchStatus: เรียก agent-status `status` ผ่าน HTTP loopback ของตัวเอง — ใช้
// เส้นทางเดียวกับที่ agent เรียก ไม่ต้องผูกกับ internals ของ plugin host. fail-soft:
// อ่านไม่ได้ → null → tick ข้ามรอบนั้น (ไม่เดาว่าใครค้างตอน live down).
function watchdogFetchStatus() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const body = JSON.stringify({ cmd: "status" });
    let req;
    try {
      req = http.request({
        host: "127.0.0.1", port: OEP_PORT, path: "/plugin/agent-status/cmd",
        method: "POST",
        headers: { "content-type": "application/json",
          "content-length": Buffer.byteLength(body) },
      }, (res) => {
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { d += c; });
        res.on("end", () => { try { finish(JSON.parse(d)); } catch { finish(null); } });
      });
    } catch { return finish(null); }
    req.on("error", () => finish(null));
    req.setTimeout(8000, () => { try { req.destroy(); } catch {} finish(null); });
    req.write(body); req.end();
  });
}

// aliases: claim.agentId (ที่ agent พิมพ์ตอน claim — มักเป็น latin) ⇄ roster id
// (ไทย). สร้างสดจาก reg ทุกครั้ง: id↔id, display-name (และ name-with-hyphens)↔id,
// + ตารางเสริมข้ามสคริปต์ที่ transliterate อัตโนมัติไม่ได้ (มิสเตอร์-n ฯลฯ).
function watchdogAliases() {
  const al = {};
  for (const id of Object.keys(reg.agents || {})) {
    al[id] = id;
    const nm = (reg.agents[id] || {}).name;
    if (nm) {
      const n = String(nm).toLowerCase().trim();
      al[n] = id;
      al[n.replace(/\s+/g, "-")] = id;
    }
  }
  const SUP = { "mister-n": "มิสเตอร์-n", "mr-n": "มิสเตอร์-n", "mrn": "มิสเตอร์-n",
    "white": "น้องไวท์", "black": "แบล็ค", "muse": "muse" };
  for (const [k, v] of Object.entries(SUP)) if (reg.agents[v]) al[k] = v;
  return al;
}

// wake: ปลุก agent ที่ watchdog ตัดสินว่าค้าง — ใช้เส้นทาง spawn เดียวกับ
// dispatchRunRecovery/runClaude. ลำดับ:
//   1) มี record ค้างใน runsState.interrupted ของ agent นี้ → dispatchRunRecovery
//      (re-dispatch ของจริงพร้อม prompt เดิม — path เดียวกับ boot recovery).
//   2) ไม่งั้น → ส่ง nudge ผ่าน runClaude.
//      • stuck-heartbeat: บังคับ session ใหม่ (session:"new") — กัน claude --resume
//        ไปชน session ของ child เดิมที่ "อาจยังวิ่งอยู่" (long Bash เงียบ tool-event
//        แต่ไม่ตาย) = ห้าม resume ทับ. nudge แค่ถามสภาพ ไม่สั่งเริ่มงานใหม่.
//      • idle-holding-work: agent ว่างจริง (ไม่มี child) → resume session ล่าสุด
//        (ปล่อย default) ให้มันมี context เดิมไปสะสาง claim/ทำงานต่อ.
function watchdogWake(entry) {
  const agent = String(entry.id);
  const base = agent.split("#")[0];
  if (!reg.agents[base]) throw new Error("agent นอก roster: " + agent);

  const rec = runsState.interrupted.find(
    (r) => String(r.agent || "").split("#")[0] === base && r.status === "interrupted");
  if (rec && (rec.prompt || rec.session)) {
    dispatchRunRecovery(rec, { auto: true });
    return;
  }

  const stuck = entry.reason === "stuck-heartbeat";
  const nudge = `<watchdog-wake>\n` +
    (stuck
      ? `🐕 WatchDog สังเกตว่า run ของคุณเงียบ (ไม่มี tool-event) นานเกินเกณฑ์ — ` +
        `${entry.detail || entry.reason}.\nถ้าคุณ "ยังทำงานอยู่จริง" (เช่นรอ build/คำสั่งยาว) ` +
        `ให้ตอบสั้นๆ ว่า "ยังทำอยู่" แล้วทำต่อ — อย่าเริ่มงานเดิมใหม่. ` +
        `ถ้าค้างจริงให้สะสาง/รายงานสภาพล่าสุด.`
      : `🐕 WatchDog สังเกตว่าคุณ idle แต่ยังถืองานค้างอยู่ — ${entry.detail || entry.reason}.\n` +
        `ช่วยทำงานที่ค้างให้จบ แล้ว release claim (POST /plugin/agent-status/cmd {"cmd":"release",...}) ` +
        `ถ้าทำเสร็จแล้วจริง. ถ้าติดอะไรให้รายงาน.`) +
    `\n</watchdog-wake>`;
  const opts = { logPrompt: "🐕 WatchDog ปลุก (" + entry.reason + ")" };
  if (stuck) opts.session = "new";   // อย่า --resume ทับ session ของ child ที่อาจยังวิ่ง
  runClaude(base, nudge, opts);
}

let watchdogRT = null;
function startWatchdog() {
  if (watchdogRT) return;             // กันสตาร์ทซ้ำตอน re-listen หลัง handoff abort
  if (process.env.BAGIDEA_NO_WATCHDOG === "1") {
    console.log("[watchdog] disabled (BAGIDEA_NO_WATCHDOG=1)");
    return;
  }
  watchdogRT = watchdogRuntime.createWatchdog({
    evaluate: watchdogMod.evaluate,
    fetchStatus: watchdogFetchStatus,
    wake: watchdogWake,
    broadcast: (m) => broadcast(m),
    now: () => Date.now(),
    aliases: watchdogAliases,
    cooldownMs: WATCHDOG_COOLDOWN_MS,
    intervalMs: WATCHDOG_INTERVAL_MS,
    log: (m) => console.log("[watchdog] " + m),
  });
  watchdogRT.start();
  console.log("[watchdog] STEP 2 loop active — poll " + WATCHDOG_INTERVAL_MS +
    "ms, cooldown " + WATCHDOG_COOLDOWN_MS + "ms");
}

// Listen with handoff-aware retry: on a self-restart the successor boots while
// the old process is still releasing the port — retry EADDRINUSE briefly
// instead of dying, so the handoff is seamless.
const OEP_PORT = Number(process.env.OEP_PORT) || 8787;
let listenTries = 0;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && listenTries < 40) {
    if (listenTries === 0) console.log("[oep] port " + OEP_PORT + " busy — waiting for handoff…");
    listenTries++;
    return setTimeout(() => server.listen(OEP_PORT, "127.0.0.1"), 250);
  }
  console.error("[oep] listen failed:", e.message);
  process.exit(1);
});
server.on("listening", () => {
  console.log("[oep] http+ws listening :" + OEP_PORT);
  sweepRunsAtBoot();   // 💾 we own the port → safe to claim the dead daemon's runs
  startWatchers();
  startWatchdog();     // 🐕 STEP 2: poll agent-status → auto-wake stuck/idle-holding agents
});
server.listen(OEP_PORT, "127.0.0.1");


// Resilience: the office is an always-on daemon spawned by a console-less GUI
// shell, so a single stray exception (a bad scheduler tick, a malformed plugin
// event) must NOT take the whole office down. Log it and keep serving — the
// shell's watchdog can still restart us if we ever truly die.
process.on("uncaughtException", (e) => console.error("[fatal] uncaught:", e && e.stack || e));
process.on("unhandledRejection", (e) => console.error("[fatal] rejection:", e && e.stack || e));
