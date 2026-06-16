#!/usr/bin/env node
// Sandbox e2e for /discuss `project` context injection (no live :8787, no HTTP
// boot, no claudeText calls). Exercises the EXACT new pure logic from
// daemon/server.js runDiscussion(): brainContextLine + resolve→getBrain→inject,
// plus the handler's project parse — all against the real brain cache +
// projects.json, read-only.
const path = require("path");
const fs = require("fs");
const brain = require(path.join(__dirname, "..", "daemon", "brain"));
const projects = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "daemon", "projects.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); }
  else { fail++; console.log("  ✗ " + m); } };

// ---- copies of the new server.js helpers (kept byte-identical) --------------
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
// minimal faithful resolver: id | display-name | dir (server.js resolveProjectRef)
function resolveProjectRef(ref) {
  const v = String(ref || "").trim();
  if (!v) return null;
  if (projects.find((x) => x.id === v)) return v;
  const norm = (s) => String(s).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const byDir = projects.find((x) => norm(x.dir) === norm(v));
  if (byDir) return byDir.id;
  const byName = projects.find((x) => x.name.toLowerCase() === v.toLowerCase());
  return byName ? byName.id : null;
}
// the exact project-context block from runDiscussion()
function buildCtx(project) {
  let projCtx = "", proposalHint = "";
  try {
    const pid = resolveProjectRef(project);
    if (pid) {
      const proj = projects.find((x) => x.id === pid);
      const projName = (proj && proj.name) || pid;
      const b = brain.getBrain(pid);
      const facts = b ? brainContextLine(b) : "ยังไม่ได้ scan สมองโปรเจค (POST /project/scan ก่อนได้บริบทเต็ม)";
      projCtx = `บริบทโปรเจค ${projName}: ${facts}\n`;
      proposalHint = `\nโปรเจคที่กำลังโฟกัส: ${projName} — ตั้งชื่อใน PROPOSAL ให้อ้างถึงโปรเจคนี้ ` +
        `(เช่น ปลั๊กอิน/ส่วนต่อยอดของ ${projName}) และให้ไอเดียเจาะจงกับโค้ดเบสนี้.`;
    }
  } catch (e) { /* legacy fallback */ }
  return { projCtx, proposalHint };
}
// the handler's parse line
const parseProject = (p) => (p.project ? String(p.project) : "");

console.log("[1] brainContextLine renders a real scanned brain");
const b0 = brain.getBrain(projects[0].id);
ok(b0, "getBrain returned a cached brain for " + projects[0].name);
const line0 = brainContextLine(b0);
ok(/ไฟล์/.test(line0) && line0.length > 5, "line has ไฟล์ count: " + line0.slice(0, 90));

console.log("[2] resolve by id / name / dir all map to a project");
ok(resolveProjectRef(projects[2].id) === projects[2].id, "by id");
ok(resolveProjectRef("bagidea") === projects[2].id, "by display name");
ok(resolveProjectRef(projects[2].dir) === projects[2].id, "by dir path");
ok(resolveProjectRef("BAGIDEA") === projects[2].id, "by display name, case-insensitive");
ok(resolveProjectRef("bagidea/") === null, "junk ref 'bagidea/' → null (legacy no-ctx, not a valid project)");

console.log("[3] valid project → projCtx + proposalHint injected");
const v = buildCtx("bagidea");
ok(v.projCtx.startsWith("บริบทโปรเจค bagidea: "), "projCtx prefixed with project name");
ok(v.projCtx.endsWith("\n"), "projCtx is one trailing-newline block");
ok(v.proposalHint.includes("bagidea") && v.proposalHint.includes("PROPOSAL"),
  "proposalHint references project + PROPOSAL protocol");

console.log("[4] prompt assembly: ctx sits right AFTER the Meeting topic line");
const topic = "หาไอเดียปรับปรุง";
const prompt = `Meeting topic: ${topic}\n` + v.projCtx +
  "Discussion so far:\nX: hi\n";
const tIdx = prompt.indexOf("Meeting topic:");
const cIdx = prompt.indexOf("บริบทโปรเจค");
const dIdx = prompt.indexOf("Discussion so far:");
ok(tIdx >= 0 && cIdx > tIdx && dIdx > cIdx, "order: topic < projectCtx < discussion");

console.log("[5] BACKWARD-COMPAT: empty / unknown project = legacy (no ctx)");
for (const empty of ["", undefined, null, "   "]) {
  const r = buildCtx(empty);
  ok(r.projCtx === "" && r.proposalHint === "", "empty(" + JSON.stringify(empty) + ") → no injection");
}
const unk = buildCtx("no-such-project-xyz");
ok(unk.projCtx === "" && unk.proposalHint === "", "unknown id → no injection (legacy)");

console.log("[6] handler parse: p.project → string id; missing → ''");
ok(parseProject({ topic: "t", project: "bagidea" }) === "bagidea", "project present");
ok(parseProject({ topic: "t" }) === "", "project absent → '' (legacy path)");
ok(parseProject({ topic: "t", project: "" }) === "", "project empty → ''");

console.log("\n" + (fail ? "❌ FAIL " : "✅ PASS ") + pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
