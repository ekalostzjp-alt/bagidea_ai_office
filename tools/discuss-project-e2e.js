#!/usr/bin/env node
// e2e: ยืนยันว่า openDiscuss() มี field PROJECT (#dProject) และส่ง project เข้า /discuss
// ตรวจแบบ static — ไม่ยิง POST /discuss จริง เพราะมันสตาร์ทประชุมจริง (state-creating)
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "daemon", "overlay.html"), "utf8");

// ตัดเฉพาะตัว openDiscuss() ออกมาตรวจ (กันชนกับ field id เดียวกันที่อื่น)
const start = html.indexOf("async function openDiscuss()");
if (start < 0) throw new Error("FAIL: openDiscuss() ไม่ใช่ async (ต้อง await fetch /projects ได้)");
const end = html.indexOf("\n  function openMap", start);
const fn = html.slice(start, end > 0 ? end : start + 4000);

const checks = [
  ['label PROJECT', /PROJECT — ให้ทีมเสนอไอเดียเจาะจงโปรเจค/],
  ['select#dProject', /<select id="dProject">/],
  ['option ว่างตัวแรก', /<option value="">\(ไม่เจาะจง — ไอเดียทั่วไป\)<\/option>/],
  ['fetch /projects เมื่อ cache ว่าง', /if \(!PROJECTS_CACHE\.length\)[\s\S]*?fetch\("\/projects"\)/],
  ['render option จาก PROJECTS_CACHE', /for \(const p of PROJECTS_CACHE\)[\s\S]*?o\.value = p\.id;[\s\S]*?o\.textContent = p\.name/],
  ['guard modal ปิดก่อน fetch เสร็จ', /if \(!sel\) return;/],
  ['ส่ง project เข้า api /discuss', /api\("\/discuss",[\s\S]*?project: projSel \? projSel\.value : ""/],
];

let ok = true;
for (const [name, re] of checks) {
  const pass = re.test(fn);
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) ok = false;
}

if (!ok) { console.error("\n❌ e2e FAILED"); process.exit(1); }
console.log("\n✅ openDiscuss() wiring ครบ — PROJECT field + ส่ง project เข้า /discuss");
