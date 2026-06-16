// 📊 Agent Status — server side (REAL, single source of truth). เจ้าภาพ: แบล็ค.
//
// ยุบ 2 plugin เดิม (agent-live-status + agent-status-dashboard) เป็น data model
// ชุดเดียว ไม่ซ้ำซ้อน: live snapshot (roster × runs.json × usage) อ่านตรงจากดิสก์
// ในโปรเซสนี้เลย — ไม่มี in-process HTTP passthrough อีก. เลเยอร์กัน task-collision
// (claims/queue/warnings) ใช้ snapshot ก้อนเดียวกันโดยตรง.
//
// state ของเราเก็บที่ ctx.dataDir 2 ไฟล์ (atomic): claims.json (claims+queue),
// alerts.json (dedup การเตือน timeout). ไม่เคยเขียนทับไฟล์ของ daemon.
//
// broadcast {type:'plugin.event',plugin:'agent-status'} ทุกครั้งที่ state เปลี่ยน
// (claim/release/expire/promote หรือ alert ข้าม/ฟื้น).
//
// ════════════════════════════════════════════════════════════════════════════
// CONTRACT — cmd `status` (POST /plugin/agent-status/cmd {"cmd":"status"})  ★ FE ยึดอันนี้
//   payload รวมครบทุกอย่างที่ FE ต้องใช้ใน JSON ก้อนเดียว:
//   {
//     ok: true,
//     ts: 1760000000000,         // epoch ms ตอนคำนวณ snapshot (canonical timestamp)
//     now: <ts>,                 // alias ของ ts (เผื่อ FE เดิมที่อ้าง now)
//     thresholdMs: 120000,       // heartbeat เงียบเกินนี้ ⇒ working agent = timedOut
//     liveSource: "up"|"down",   // "down" = อ่าน snapshot ไม่ได้ (fail-open, agents:[])
//     agents: [                  // ทุก agent ใน roster (idle ก็อยู่ในนี้)
//       { id,                    // registry key (canonical id)
//         name,                  // display name
//         cpu,                   // %CPU per-core (100=เต็ม 1 core), Σ ทั้ง process tree, cap 100 | null ถ้า idle/sample ไม่ได้
//         memMB,                 // RSS รวมทั้ง tree เป็น MB | null ถ้า idle/sample ไม่ได้
//         queueLen,              // จำนวน live run พร้อมกัน (ghost ม้วนเข้า parent แล้ว)
//         state,                 // "working" | "stuck" | "idle"
//         lastHeartbeatMs,       // epoch ms | null
//         timedOut,              // bool — working แต่ heartbeat เงียบเกิน thresholdMs
//         project,               // ชื่อโปรเจค (display) | null  (idle ⇒ null)
//         task } ],              // label ย่อ ≤90 ตัว | null    (idle ⇒ null)
//     claims: [                  // claim ที่ active อยู่
//       { id, agentId, project, files:[rel,…], reason, ts, ttlMs } ],   // files:[]=ทั้งโปรเจค
//     queue: [                   // claim ที่ถูก block รอคิว (FIFO ต่อโปรเจค)
//       { id, claim:{…}, blockedBy:[claimId,…], since } ],
//     warnings: [                // collision ปัจจุบัน
//       { type:"project-overlap"|"file-overlap", project, agents:[], files:[],
//         severity:"warn"|"block", detectedAt } ],
//     msg: "<สรุปสั้นภาษาคน>"
//   }
//   หมายเหตุ: idle ⇒ queueLen:0, timedOut:false, project/task:null เสมอ.
//
// CONTRACT — cmd `board`  : เหมือน status แต่ตัด field cpu/mem ไม่จำเป็น — ใช้ key
//   { ok, now, liveSource, agents, claims, warnings, queue, msg } (ยก 1:1 จาก dashboard เดิม)
// CONTRACT — cmd `claim`  : body={agentId,project,files?,reason?,ttlMs?}
//   → {ok:true,claim} | ชน:{ok:false,conflict:[id…],queued:{id}} (HTTP 200 ทั้งคู่)
// CONTRACT — cmd `release`: body={agentId, claimId? | project?}
//   → {ok:true,released:[id…],queue,claims}
// ════════════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// ── live tunables (mirror agent-live-status เดิม) ──
const TIMEOUT_MS = Number(process.env.AGENT_LIVE_TIMEOUT_MS) || 120000; // heartbeat เงียบ ⇒ timedOut
const TASK_CLIP = 90;                                                   // ตัด label/task
// ── collision/claim tunables (mirror agent-status-dashboard เดิม) ──
const DEFAULT_TTL = 30 * 60 * 1000;   // 30 นาที
const MIN_TTL = 60 * 1000;            // 1 นาที
const MAX_TTL = 4 * 60 * 60 * 1000;   // 4 ชั่วโมง
const SWEEP_MS = Number(process.env.AGENT_STATUS_SWEEP_MS) || 15000;    // คาบ sweep รวม
// ── CPU/MEM sampler tunables ──
const SAMPLE_MS = Math.max(1000, Number(process.env.AGENT_STATUS_SAMPLE_MS) || 2500); // คาบ sample
const SAMPLE_ON = process.env.AGENT_STATUS_SAMPLE !== "0";             // ปิดได้ด้วย =0 (test/safe)

module.exports = (ctx) => {
  const CLAIMS_FILE = path.join(ctx.dataDir, "claims.json");
  const ALERTS_FILE = path.join(ctx.dataDir, "alerts.json");
  const log = (m) => { try { ctx.log && ctx.log("[agent-status] " + m); } catch {} };
  const emit = () => { try { ctx.broadcast({ type: "plugin.event", plugin: "agent-status" }, false); } catch {} };

  // ── persisted state ──────────────────────────────────────────────────────────
  let claims = [];                       // active claims
  let queue = [];                        // blocked claims (FIFO ต่อโปรเจค)
  let alerts = loadAlerts();             // { alerted: { agentId -> heartbeat ts ที่เตือนไป } }
  loadClaims();

  function loadClaims() {
    try {
      const j = JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8"));
      claims = Array.isArray(j.claims) ? j.claims : [];
      queue = Array.isArray(j.queue) ? j.queue : [];
    } catch { claims = []; queue = []; }
  }
  // atomic: เขียน tmp แล้ว rename (กันไฟล์พังถ้าดับกลางคัน)
  function persistClaims() {
    try {
      const tmp = CLAIMS_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ claims, queue }));
      fs.renameSync(tmp, CLAIMS_FILE);
    } catch (e) { log("persist fail: " + e.message); }
  }
  function loadAlerts() {
    try { return JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8")); } catch {}
    return { alerted: {} };
  }
  function saveAlerts() { try { fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts)); } catch (e) { log("alerts save fail: " + e.message); } }

  // ── helpers ───────────────────────────────────────────────────────────────────
  const nonEmptyStr = (s) => typeof s === "string" && s.trim().length > 0;
  const normProj = (p) => String(p || "").trim().toLowerCase();
  const normFile = (f) => String(f).replace(/[\\/]+/g, "/").replace(/^\.\//, "").toLowerCase();
  let _seq = 0;
  const genId = (prefix) => `${prefix}-${Date.now()}-${(_seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

  // path ปลอดภัย: ต้อง relative, ห้าม `..`, ห้าม absolute / UNC / drive-letter
  function badPath(f) {
    if (typeof f !== "string" || !f.trim()) return true;
    if (/^[a-zA-Z]:[\\/]/.test(f)) return true;               // C:\ หรือ C:/
    if (f.startsWith("/") || f.startsWith("\\")) return true; // /abs หรือ \\unc
    if (f.split(/[\\/]+/).includes("..")) return true;        // มี segment ..
    return false;
  }

  function readDaemonJson(name) {
    try { return JSON.parse(fs.readFileSync(path.join(ctx.daemonDir, name), "utf8")); }
    catch { return null; }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 1 — CPU/MEM SAMPLER (background) — per-agent OS process stats ตาม pid.
  //
  // ทำไมต้องเป็น background tick แยก ไม่ sample ตอนถูก poll:
  //   • %CPU ต้องวัด "delta" ของ CPU-time สะสมระหว่าง 2 จังหวะ — on-demand คำนวณไม่ได้
  //   • FE poll `status` ทุก ~1s — ถ้า spawn powershell/ps ทุก poll = ระเบิดโปรเซส
  // sampler จึงเดินรอบตัวเอง (SAMPLE_MS) spawn 1 ครั้ง/รอบ แล้ว cache ค่าไว้;
  // snapshot()/buildStatus() แค่ "อ่าน cache" ราคาถูก (ไม่ spawn).
  //
  //   sampleByAgent[id] = { cpu:0-100|null, memMB:number|null, ts }
  //     cpu   = Σ(%CPU per-core ทั้ง process tree), 100=เต็ม 1 core, cap ที่ 100
  //     memMB = Σ(RSS ทั้ง tree) เป็น MB
  //   pid ตาย/อ่านไม่ได้ ⇒ หลุด cache รอบถัดไป ⇒ snapshot คืน null (ของจริง ไม่ปลอม)
  //
  // รวม "ทั้ง process tree" ของ root pid (เพราะ run.pid มักเป็น launcher บางๆ เช่น
  // cmd/conhost — งานจริง+CPU/MEM อยู่ที่ลูก เช่น claude.exe). ม้วน root+ลูกหลานทั้งหมด.
  // win32 : Win32_Process (UserModeTime+KernelModeTime=วินาทีสะสม, WorkingSetSize, ppid)
  // darwin/linux : ps -axo pid,ppid,%cpu,rss (best-effort: ps %cpu เป็นค่าเฉลี่ย lifetime)
  // ปิด sampler ได้ด้วย env AGENT_STATUS_SAMPLE=0 (เช่นตอน test/headless)
  let sampleByAgent = {};
  let prevCpu = {};          // pid -> { sec, ts }  (เก็บไว้คำนวณ delta CPU บน win32)
  let samplerBusy = false;   // กัน spawn ซ้อนถ้ารอบก่อนยังไม่จบ

  // pid ของ live run ตอนนี้ จัดกลุ่มตาม agent แม่ (ghost ม้วนเข้า parent ผ่าน run.agent)
  function livePidsByAgent() {
    const runs = readDaemonJson("runs.json");
    const live = (runs && runs.live) || {};
    const byAgent = {};
    for (const r of Object.values(live)) {
      if (!r || r.status !== "running" || !r.pid) continue;
      (byAgent[r.agent] = byAgent[r.agent] || []).push(Number(r.pid));
    }
    return byAgent;
  }

  // อ่านตารางโปรเซส "ทั้งเครื่อง" 1 ครั้ง/รอบ (เพื่อม้วน process tree). คืน
  //   procMap: pid -> { ppid, memMB, cpuSec | pcpu }
  //   • win32 : Win32_Process → cpuSec=(UserModeTime+KernelModeTime)/1e7 (วินาทีสะสม),
  //             memMB=WorkingSetSize/1MB, ppid=ParentProcessId  (CIM คอลเดียวครบ)
  //   • posix : ps -axo pid,ppid,%cpu,rss → pcpu (ค่าเฉลี่ย lifetime, best-effort)
  function readAllProcs(cb) {
    if (process.platform === "win32") {
      const psCmd = "Get-CimInstance Win32_Process | Select-Object " +
        "ProcessId,ParentProcessId,WorkingSetSize,UserModeTime,KernelModeTime | ConvertTo-Json -Compress";
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCmd],
        { timeout: 4500, windowsHide: true, maxBuffer: 16 << 20 }, (err, stdout) => {
          const map = new Map();
          let arr = [];
          try { const j = JSON.parse(stdout); arr = Array.isArray(j) ? j : [j]; } catch {}
          for (const p of arr) {
            const pid = Number(p && p.ProcessId);
            if (!Number.isFinite(pid)) continue;
            const ws = Number(p.WorkingSetSize);
            const cpuSec = ((Number(p.UserModeTime) || 0) + (Number(p.KernelModeTime) || 0)) / 1e7;
            map.set(pid, {
              ppid: Number(p.ParentProcessId) || 0,
              memMB: Number.isFinite(ws) ? ws / (1024 * 1024) : null,
              cpuSec, pcpu: null,
            });
          }
          if (err && !map.size) log("win32 procs: " + err.message);
          cb(map);
        });
    } else {
      execFile("ps", ["-axo", "pid=,ppid=,%cpu=,rss="],
        { timeout: 4500, maxBuffer: 16 << 20 }, (err, stdout) => {
          const map = new Map();
          for (const line of String(stdout || "").split(/\r?\n/)) {
            const m = line.trim().split(/\s+/);
            if (m.length < 4) continue;
            const pid = Number(m[0]);
            if (!Number.isFinite(pid)) continue;
            const rssKB = Number(m[3]);
            map.set(pid, {
              ppid: Number(m[1]) || 0,
              memMB: Number.isFinite(rssKB) ? rssKB / 1024 : null,
              cpuSec: null, pcpu: parseFloat(m[2]),
            });
          }
          if (err && !map.size) log("posix procs: " + err.message);
          cb(map);
        });
    }
  }

  // closure ของ root pid + ลูกหลานทั้งหมด (BFS ตาม ppid)
  function treeClosure(roots, childrenOf) {
    const seen = new Set();
    const stack = roots.filter((p) => Number.isFinite(p));
    while (stack.length) {
      const pid = stack.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const kids = childrenOf.get(pid);
      if (kids) for (const k of kids) stack.push(k);
    }
    return seen;
  }

  // rollup: ต่อ agent ม้วน process tree ของ root pid → Σ memMB, Σ %CPU (ทั้งเครื่อง)
  function applyTree(procMap, byAgent) {
    const childrenOf = new Map();
    for (const [pid, info] of procMap) {
      if (!childrenOf.has(info.ppid)) childrenOf.set(info.ppid, []);
      childrenOf.get(info.ppid).push(pid);
    }
    const next = {}; const now = Date.now(); const touched = new Set();
    for (const [agent, roots] of Object.entries(byAgent)) {
      const closure = treeClosure(roots, childrenOf);
      let cpu = 0, mem = 0, anyCpu = false, anyMem = false;
      for (const pid of closure) {
        const info = procMap.get(pid);
        if (!info) continue;
        touched.add(pid);
        if (info.memMB != null) { mem += info.memMB; anyMem = true; }
        if (info.cpuSec != null) {                    // win32: delta ของ CPU-time สะสม
          const prev = prevCpu[pid];
          if (prev && now > prev.ts) {
            const dCpuMs = (info.cpuSec - prev.sec) * 1000;
            cpu += Math.max(0, (dCpuMs / (now - prev.ts)) * 100); // per-core % (100=เต็ม 1 core)
            anyCpu = true;
          }
          prevCpu[pid] = { sec: info.cpuSec, ts: now };
        } else if (Number.isFinite(info.pcpu)) {      // posix: ps %cpu = per-core % อยู่แล้ว
          cpu += info.pcpu; anyCpu = true;
        }
      }
      next[agent] = {
        cpu: anyCpu ? Math.max(0, Math.min(100, Math.round(cpu))) : null,
        memMB: anyMem ? Math.round(mem) : null,
        ts: now,
      };
    }
    sampleByAgent = next;
    // เก็บกวาด prevCpu ของ pid ที่ไม่อยู่ใน tree ใดแล้ว (กัน map โต)
    for (const pid of Object.keys(prevCpu)) if (!touched.has(Number(pid))) delete prevCpu[pid];
  }

  function sampleOnce() {
    if (samplerBusy) return;                       // รอบก่อนยังไม่จบ → ข้าม
    const byAgent = livePidsByAgent();
    if (!Object.keys(byAgent).length) { sampleByAgent = {}; prevCpu = {}; return; }  // ไม่มีใคร working
    samplerBusy = true;
    try {
      readAllProcs((procMap) => {
        try { if (procMap && procMap.size) applyTree(procMap, byAgent); }
        catch (e) { log("apply fail: " + e.message); }
        samplerBusy = false;
      });
    } catch (e) { log("spawn fail: " + e.message); samplerBusy = false; }
  }

  // background sampler — กัน interval รั่วตอน /plugins/reload ผ่าน globalThis guard
  function startSampler() {
    if (globalThis.__agentStatusSampler) clearInterval(globalThis.__agentStatusSampler);
    if (!SAMPLE_ON) { globalThis.__agentStatusSampler = null; return; }
    sampleOnce();   // prime: รอบแรกได้ mem ทันที, cpu มารอบถัดไป (ต้องมี delta ก่อน)
    globalThis.__agentStatusSampler = setInterval(() => {
      try { sampleOnce(); } catch (e) { log("sampler fail: " + e.message); }
    }, SAMPLE_MS);
    if (globalThis.__agentStatusSampler.unref) globalThis.__agentStatusSampler.unref();
  }

  // ════════════════════════════════════════════════════════════════════════════
  // LIVE SNAPSHOT (read-only) — roster × runs.json × usage. คืน agents[] ตาม contract.
  // pure read; รับ now เพื่อ test ได้. (ยกจาก agent-live-status/live-source.js)
  // cpu/memMB อ่านจาก cache ของ sampler (STEP 1) — ไม่ spawn ตอน snapshot.
  // ════════════════════════════════════════════════════════════════════════════

  function snapshot(now) {
    now = now || Date.now();
    const agents = (ctx.reg && ctx.reg.agents) || {};
    const runs = readDaemonJson("runs.json");
    const usage = readDaemonJson("usage-processes.json");
    const live = (runs && runs.live) || {};
    const byAgent = (usage && usage.byAgent) || {};

    // map project id → display name (ตรง pill "⚙ <project>" ของ overlay)
    const projList = readDaemonJson("projects.json");
    const projName = {};
    if (Array.isArray(projList)) for (const p of projList) if (p && p.id) projName[p.id] = p.name || p.id;

    // group live runs ตาม agent แม่ (ghost id#sN ม้วนเข้า parent ผ่าน run.agent อยู่แล้ว)
    const liveByAgent = {};
    for (const r of Object.values(live)) {
      if (!r || r.status !== "running") continue;
      (liveByAgent[r.agent] = liveByAgent[r.agent] || []).push(r);
    }

    const rows = [];
    for (const [id, a] of Object.entries(agents)) {
      const mine = liveByAgent[id] || [];
      const working = mine.length > 0;

      // heartbeat: ใหม่สุดจาก live run, ไม่งั้น fallback usage activity ล่าสุด
      let lastHeartbeatMs = null;
      for (const r of mine) {
        const hb = r.lastHeartbeat || r.startedAt || 0;
        if (hb > (lastHeartbeatMs || 0)) lastHeartbeatMs = hb;
      }
      if (lastHeartbeatMs == null && byAgent[id]) lastHeartbeatMs = byAgent[id].lastTs || null;

      // state: ใช้ state ของ live run (working|stuck) ไม่งั้น idle
      let state = "idle";
      if (working) state = mine.some((r) => r.state === "stuck") ? "stuck" : "working";

      // timedOut: เฉพาะตอน working — heartbeat เงียบเกิน threshold (idle ไม่นับ)
      const ageMs = lastHeartbeatMs ? now - lastHeartbeatMs : null;
      const timedOut = working && ageMs != null && ageMs > TIMEOUT_MS;

      // project/task จาก live run แรก (display)
      const lead = mine[0] || null;
      const projId = working && lead ? (lead.project || null) : null;
      const project = projId ? (projName[projId] || projId) : null;
      const task = working && lead && lead.label ? String(lead.label).slice(0, TASK_CLIP) : null;

      // cpu/memMB: อ่านจาก cache ของ sampler (STEP 1). working แต่ยังไม่มี sample
      // (pid เพิ่งเกิด/รอ delta CPU รอบแรก) ⇒ null — FE โชว์ "—" ไม่ปลอมค่า.
      const smp = working ? sampleByAgent[id] : null;
      rows.push({
        id,
        name: a.name || id,
        cpu: smp ? smp.cpu : null,       // %CPU per-core (100=เต็ม 1 core), cap 100 | null
        memMB: smp ? smp.memMB : null,   // RSS รวม MB | null
        queueLen: mine.length,   // best-effort = จำนวน live run พร้อมกัน
        state,                   // "working" | "stuck" | "idle"
        lastHeartbeatMs,         // epoch ms | null
        timedOut,                // boolean (คำนวณฝั่ง server แล้ว)
        project,                 // display | null
        task,                    // display | null
      });
    }
    return rows;
  }

  // alert: ยิงตอน agent "เพิ่งข้าม" เข้า timedOut, re-arm เมื่อฟื้น. ส่ง broadcast kind:"alert"
  function checkAlerts(rows, now) {
    now = now || Date.now();
    let changed = false;
    const alerted = alerts.alerted;
    for (const row of rows) {
      if (row.timedOut) {
        if (alerted[row.id] !== row.lastHeartbeatMs) {
          alerted[row.id] = row.lastHeartbeatMs; // dedup key = heartbeat ที่ค้าง
          changed = true;
          try {
            ctx.broadcast({
              type: "plugin.event", plugin: "agent-status", kind: "alert",
              agent: row.id, name: row.name, state: row.state,
              lastHeartbeatMs: row.lastHeartbeatMs,
              silentMs: row.lastHeartbeatMs ? now - row.lastHeartbeatMs : null,
              thresholdMs: TIMEOUT_MS,
              text: `⚠️ ${row.name} เงียบเกิน ${Math.round(TIMEOUT_MS / 1000)}s — อาจค้าง`,
            }, false);
          } catch {}
          log("ALERT " + row.id + " silent");
        }
      } else if (alerted[row.id] !== undefined) {
        delete alerted[row.id]; // ฟื้นแล้ว ⇒ re-arm
        changed = true;
      }
    }
    if (changed) saveAlerts();
  }

  // snapshot + alert ในจังหวะเดียว, fail-open (snapshot พังก็คืน [] + liveSource:"down")
  function liveAgents(now) {
    try {
      const rows = snapshot(now);
      checkAlerts(rows, now);
      return { agents: rows, liveSource: "up" };
    } catch (e) {
      log("snapshot fail: " + e.message);
      return { agents: [], liveSource: "down" };
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // COLLISION / CLAIM-QUEUE (mutable) — ยก 1:1 จาก agent-status-dashboard
  // ════════════════════════════════════════════════════════════════════════════
  // file-overlap ระหว่าง 2 claim: โปรเจคเดียวกัน AND (files ตัดกัน OR ฝ่ายใดฝ่ายหนึ่ง files:[])
  function filesOverlap(a, b) {
    if (!a.length || !b.length) return true;                 // [] = ทั้งโปรเจค
    const setA = new Set(a.map(normFile));
    return b.some((f) => setA.has(normFile(f)));
  }
  function conflictsFor(claim) {
    const hits = [];
    for (const c of claims) {
      if (c.id === claim.id) continue;
      if (normProj(c.project) !== normProj(claim.project)) continue;
      if (filesOverlap(c.files || [], claim.files || [])) hits.push(c.id);
    }
    return hits;
  }
  // เลื่อนคิว FIFO: รายการเก่าสุดที่ไม่ชน active claim แล้ว เลื่อนขึ้นเป็น claim
  function promote() {
    let changed = false, again = true;
    while (again) {
      again = false;
      queue.sort((x, y) => x.since - y.since);
      for (let i = 0; i < queue.length; i++) {
        const hits = conflictsFor(queue[i].claim);
        if (hits.length === 0) {
          const q = queue.splice(i, 1)[0];
          claims.push(q.claim);
          changed = true; again = true;
          break;
        } else {
          queue[i].blockedBy = hits;   // refresh เผื่อ blocker เปลี่ยน
        }
      }
    }
    return changed;
  }
  // TTL: claim หมดอายุนับจาก ts, queued entry นับจาก since (กันค้างจาก run ที่ตาย)
  function expire(now) {
    const beforeC = claims.length, beforeQ = queue.length;
    claims = claims.filter((c) => now - c.ts < c.ttlMs);
    queue = queue.filter((q) => now - q.since < q.claim.ttlMs);
    return claims.length !== beforeC || queue.length !== beforeQ;
  }

  // ── warnings ──────────────────────────────────────────────────────────────────
  // project-overlap (warn): จาก live agents — ≥2 ตัว state∈{working,stuck} โปรเจคเดียวกัน
  function projectOverlaps(agents, now) {
    const g = new Map();
    for (const a of agents) {
      const st = String(a.state || a.status || "idle").toLowerCase();
      if (st !== "working" && st !== "stuck") continue;
      if (!a.project) continue;
      const k = normProj(a.project);
      if (!g.has(k)) g.set(k, { project: a.project, agents: [] });
      g.get(k).agents.push(a.id || a.agentId || a.name);
    }
    return [...g.values()].filter((x) => x.agents.length >= 2).map((x) => ({
      type: "project-overlap", project: x.project, agents: x.agents,
      files: [], severity: "warn", detectedAt: now,
    }));
  }
  // file-overlap (block): จากคิวที่ถูก block อยู่ — ใครชนกับใคร
  function fileOverlapWarnings() {
    const byId = new Map(claims.map((c) => [c.id, c]));
    return queue.map((q) => ({
      type: "file-overlap", project: q.claim.project,
      agents: [q.claim.agentId, ...q.blockedBy.map((id) => (byId.get(id) || {}).agentId).filter(Boolean)],
      files: q.claim.files, severity: "block", detectedAt: q.since,
    }));
  }

  // ── sweep รวม: expire/promote claims + ยิง live alert แม้ไม่มี panel poll ──
  function sweepOnce() {
    const now = Date.now();
    const dropped = expire(now);
    const promoted = promote();
    if (dropped || promoted) { persistClaims(); emit(); }
    try { checkAlerts(snapshot(now), now); } catch (e) { log("sweep snapshot fail: " + e.message); }
  }
  function startSweep() {
    if (globalThis.__agentStatusTimer) clearInterval(globalThis.__agentStatusTimer);
    globalThis.__agentStatusTimer = setInterval(() => {
      try { sweepOnce(); } catch (e) { log("sweep fail: " + e.message); }
    }, SWEEP_MS);
    if (globalThis.__agentStatusTimer.unref) globalThis.__agentStatusTimer.unref();
  }
  startSweep();
  startSampler();   // STEP 1: เริ่ม background CPU/MEM sampler

  // ════════════════════════════════════════════════════════════════════════════
  // PAYLOAD BUILDERS
  // ════════════════════════════════════════════════════════════════════════════
  // cmd `status` — ก้อนรวมครบทุกอย่างที่ FE ต้องใช้ (ดู CONTRACT หัวไฟล์)
  function buildStatus() {
    const now = Date.now();
    const dropped = expire(now);           // ปลด claim หมดอายุก่อนตอบ
    const promoted = promote();
    if (dropped || promoted) { persistClaims(); emit(); }
    const { agents, liveSource } = liveAgents(now);
    const warnings = [...projectOverlaps(agents, now), ...fileOverlapWarnings()];
    const to = agents.filter((a) => a.timedOut).map((a) => a.name || a.id);
    const block = warnings.filter((w) => w.severity === "block").length;
    const warn = warnings.filter((w) => w.severity === "warn").length;
    const parts = [];
    if (to.length) parts.push("⚠️ timeout: " + to.join(", "));
    if (block || warn) parts.push(`${block} block / ${warn} warn`);
    parts.push(`claims ${claims.length} · queue ${queue.length}`);
    if (liveSource === "down") parts.push("live down");
    return {
      ok: true, ts: now, now, thresholdMs: TIMEOUT_MS, liveSource,
      agents, claims: claims.slice(), queue: queue.slice(), warnings,
      msg: parts.join(" · "),
    };
  }

  // cmd `board` — บอร์ดกัน collision (ยก 1:1 จาก dashboard เดิม; key ใช้ `now`)
  function buildBoard() {
    const now = Date.now();
    const dropped = expire(now);
    const promoted = promote();
    if (dropped || promoted) { persistClaims(); emit(); }
    const { agents, liveSource } = liveAgents(now);
    const warnings = [...projectOverlaps(agents, now), ...fileOverlapWarnings()];
    return { ok: true, now, liveSource, agents,
      claims: claims.slice(), warnings, queue: queue.slice() };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MUTATIONS — claim / release (ยก 1:1 จาก dashboard เดิม)
  // ════════════════════════════════════════════════════════════════════════════
  function validateClaim(input) {
    if (!input || typeof input !== "object") return { error: "body ต้องเป็น object" };
    if (!nonEmptyStr(input.agentId)) return { error: "agentId ต้องเป็น string ไม่ว่าง" };
    if (!nonEmptyStr(input.project)) return { error: "project ต้องเป็น string ไม่ว่าง" };
    let files = input.files;
    if (files === undefined || files === null) files = [];
    if (!Array.isArray(files)) return { error: "files ต้องเป็น array ของ relative path" };
    for (const f of files) if (badPath(f)) return { error: "files มี path ไม่ปลอดภัย: " + String(f) };
    let ttlMs = input.ttlMs === undefined ? DEFAULT_TTL : Number(input.ttlMs);
    if (!Number.isFinite(ttlMs)) ttlMs = DEFAULT_TTL;
    ttlMs = Math.max(MIN_TTL, Math.min(MAX_TTL, ttlMs));      // clamp 1 นาที–4 ชม.
    return { ttlMs, files: files.map((f) => String(f)) };
  }

  function doClaim(input) {
    const v = validateClaim(input);
    if (v.error) return { http: 400, body: { ok: false, error: v.error } };
    const claim = {
      id: genId("c"), agentId: input.agentId.trim(), project: input.project.trim(),
      files: v.files, reason: input.reason ? String(input.reason).slice(0, 300) : "",
      ts: Date.now(), ttlMs: v.ttlMs,
    };
    const hits = conflictsFor(claim);
    if (hits.length) {
      // ชน = คำตอบปกติ (HTTP 200) — เข้าคิว FIFO อัตโนมัติ, ไม่ใช่ error
      const q = { id: genId("q"), claim, blockedBy: hits, since: claim.ts };
      queue.push(q); persistClaims(); emit();
      return { http: 200, body: { ok: false, conflict: hits, queued: { id: q.id } } };
    }
    claims.push(claim); persistClaims(); emit();
    return { http: 200, body: { ok: true, claim } };
  }

  function doRelease(input) {
    if (!input || typeof input !== "object") return { http: 400, body: { ok: false, error: "body ต้องเป็น object" } };
    if (!nonEmptyStr(input.agentId)) return { http: 400, body: { ok: false, error: "agentId ต้องเป็น string ไม่ว่าง" } };
    const agentId = input.agentId.trim();
    const claimId = nonEmptyStr(input.claimId) ? input.claimId.trim() : null;
    const project = nonEmptyStr(input.project) ? input.project.trim() : null;
    if (!claimId && !project) return { http: 400, body: { ok: false, error: "ต้องระบุ claimId หรือ project" } };
    const owns = (agent, id, proj) => agent === agentId &&
      (claimId ? id === claimId : normProj(proj) === normProj(project));

    const released = claims.filter((c) => owns(c.agentId, c.id, c.project)).map((c) => c.id);
    claims = claims.filter((c) => !owns(c.agentId, c.id, c.project));
    const beforeQ = queue.length;
    queue = queue.filter((q) => !owns(q.claim.agentId, q.claim.id, q.claim.project));

    const promoted = promote();
    if (released.length || beforeQ !== queue.length || promoted) { persistClaims(); emit(); }
    return { http: 200, body: { ok: true, released, queue: queue.slice(), claims: claims.slice() } };
  }

  // ── command channel (agent สั่งผ่าน /cmd) ──────────────────────────────────────
  function parseInput(args, payload) {
    if (args && typeof args === "object") return args;
    if (typeof args === "string" && args.trim().startsWith("{")) { try { return JSON.parse(args); } catch {} }
    if (payload && typeof payload === "object") { const { cmd, args: _a, ...rest } = payload; return rest; }
    return {};
  }
  function onCommand(cmd, args, reply, payload) {
    if (cmd === "status") return buildStatus();
    if (cmd === "board") {
      const b = buildBoard();
      const block = b.warnings.filter((w) => w.severity === "block").length;
      const warn = b.warnings.filter((w) => w.severity === "warn").length;
      b.msg = (b.warnings.length
        ? `⚠️ ${block} block / ${warn} warn · claims ${b.claims.length} · queue ${b.queue.length}`
        : `ไม่มี collision · claims ${b.claims.length} · queue ${b.queue.length}`) +
        (b.liveSource === "down" ? " · live down" : "");
      return b;
    }
    if (cmd === "claim") return doClaim(parseInput(args, payload)).body;
    if (cmd === "release") return doRelease(parseInput(args, payload)).body;
    return { ok: false, msg: "ไม่รู้จักคำสั่ง: " + cmd };
  }

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  const readJsonBody = (req, api, cb) => api.readBody(req, (body) => {
    let p; try { p = JSON.parse(body || "{}"); } catch { p = {}; }
    cb(p && typeof p === "object" ? p : {});
  });

  return {
    onCommand,
    routes: {
      // GET /plugin/agent-status/status — CONTRACT กลาง (ก้อนรวมครบ, read-only)
      status(req, res) { sendJson(res, 200, buildStatus()); },
      // GET /plugin/agent-status/board — บอร์ดกัน collision (fail-open)
      board(req, res) {
        try { sendJson(res, 200, buildBoard()); }
        catch (e) {
          log("board error: " + e.message);
          sendJson(res, 200, { ok: true, now: Date.now(), liveSource: "down",
            agents: [], claims: claims.slice(), warnings: fileOverlapWarnings(), queue: queue.slice() });
        }
      },
      // POST /plugin/agent-status/claim — body=claim; ชน=200+conflict/queued
      claim(req, res, api) {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "ใช้ POST" });
        readJsonBody(req, api, (p) => { const r = doClaim(p); sendJson(res, r.http, r.body); });
      },
      // POST /plugin/agent-status/release — {agentId, claimId?|project?}
      release(req, res, api) {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "ใช้ POST" });
        readJsonBody(req, api, (p) => { const r = doRelease(p); sendJson(res, r.http, r.body); });
      },
    },
  };
};
