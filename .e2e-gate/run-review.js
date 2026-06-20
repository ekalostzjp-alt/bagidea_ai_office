const { spawn } = require("child_process");
const prompt = `รีวิว diff ที่ไฟล์ .e2e-gate/staged.diff — เป็นการเพิ่ม "run persistence (กันงานหายถาวร)" ใน daemon/server.staged.js เทียบกับ daemon/server.js:
- persist ทุก run ลง daemon/runs.json (atomic: เขียน .tmp แล้ว rename, .bak ตอน boot)
- boot recovery: record ที่ค้าง "running" → "interrupted" + ประกาศ chat (journaled)
- endpoints: GET /runs, POST /runs/resume, POST /runs/dismiss (สองตัวหลัง human-UI-only)
- ผูก stuck watchdog ของ Live Log ให้สถานะบน disk ตรงกับ overlay
อ่านไฟล์ daemon/server.staged.js ประกอบได้เต็มที่. ประเมิน: บั๊ก, race condition, edge case, ความปลอดภัยของ endpoint, ความถูกต้องของ atomic write. ตอบ JSON ตาม schema เท่านั้น (reasons/fixes ภาษาไทย).`;
const c = spawn("cmd", ["/c", "codex", "exec", "--skip-git-repo-check", "-s", "read-only",
  "--output-schema", ".e2e-gate/review.schema.json",
  "--output-last-message", ".e2e-gate/review.out.json", prompt],
  { stdio: ["ignore", "pipe", "pipe"] });
let out = "";
c.stdout.on("data", d => out += d); c.stderr.on("data", d => out += d);
const t = setTimeout(() => { try { c.kill(); } catch {} console.log("TIMEOUT"); process.exit(3); }, 280000);
c.on("close", code => { clearTimeout(t); console.log(out.slice(-600)); console.log("EXIT:" + code); });
