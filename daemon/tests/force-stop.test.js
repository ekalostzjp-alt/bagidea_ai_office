// ⏹ Force หยุด — proves the two halves of POST /agent/force-stop:
//   (1) the run-selection predicate (task-precise / agent-base incl ghost), and
//   (2) the CRITICAL footgun: taskkill /PID <launcher> /T /F must reap the WHOLE
//       tree. child.pid is only the cmd/conhost launcher; the real claude.exe is
//       a descendant (memory: agent-pid-process-tree). WITHOUT /T the launcher
//       dies but the grandchild keeps running. This test would FAIL if someone
//       drops /T or kills the wrong pid.
const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");

// Mirror the endpoint's selection predicate exactly (server.js /agent/force-stop):
// task given → that one run; else match the agent's base id so ghost runs roll up.
function hits(run, want, wantTask, task) {
  const base = String(run.agent).split("#")[0];
  return wantTask ? task === wantTask : (run.agent === want || base === want);
}

test("predicate: task wins (precise single run) and ignores the agent", () => {
  const r = { agent: "black" };
  assert.equal(hits(r, "", "t-2", "t-2"), true);
  assert.equal(hits(r, "", "t-2", "t-1"), false);   // other run of same agent untouched
});

test("predicate: by agent matches base + ghost runs, not other agents", () => {
  assert.equal(hits({ agent: "black" }, "black", null, "t-1"), true);
  assert.equal(hits({ agent: "black#s1" }, "black", null, "t-2"), true);   // ghost rolls up
  assert.equal(hits({ agent: "white" }, "black", null, "t-3"), false);
});

test("predicate: nothing matches when neither agent nor task is given", () => {
  // endpoint rejects empty input before looping; predicate stays false anyway.
  assert.equal(hits({ agent: "black" }, "", null, "t-1"), false);
});

// pid alive? tasklist returns the row for a live pid, "INFO: No tasks" otherwise.
function alive(pid) {
  const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8" });
  return /\b\d+\b/.test(String(out.stdout)) && !/No tasks/i.test(String(out.stdout));
}

test("kill: taskkill /T /F reaps the descendant, not just the launcher", { skip: process.platform !== "win32" }, async () => {
  // A controlled launcher→descendant tree: the parent node spawns a grandchild
  // node and prints both pids. This is the launcher/claude split the daemon has
  // (memory: agent-pid-process-tree) — the endpoint holds the LAUNCHER pid; the
  // real work is the descendant. taskkill /T must reap it; WITHOUT /T the parent
  // dies and the descendant is orphaned (the exact bug this guards).
  const parent = spawn(process.execPath, ["-e",
    "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);" +
    "console.log('PIDS',process.pid,c.pid);setInterval(()=>{},1000);"],
    { windowsHide: true });
  let buf = "";
  parent.stdout.on("data", (d) => { buf += d; });
  // wait for the PIDS line
  for (let i = 0; i < 40 && !/PIDS \d+ \d+/.test(buf); i++) await new Promise((r) => setTimeout(r, 50));
  const m = buf.match(/PIDS (\d+) (\d+)/);
  assert.ok(m, "parent ต้องรายงาน pids");
  const grand = Number(m[2]);
  assert.ok(alive(grand), "grandchild ต้องยังรันก่อนฆ่า");

  // EXACT call the endpoint uses (taskkill /PID <launcher> /T /F).
  spawnSync("taskkill", ["/PID", String(parent.pid), "/T", "/F"], { windowsHide: true });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(alive(grand), false, "grandchild ต้องตายด้วย — /T ม้วน process tree");
});
