// usage-cache-read-e2e.js — ยืนยัน frontend แยก cacheReadTokens ออกจาก total/breakdown
// ตรงกับ logic ใน daemon/overlay.html (PER-PROCESS TOKEN USAGE). รัน: node tools/usage-cache-read-e2e.js
// เป้าหมาย: cache-read = history replay → โชว์ป้ายแยก, ห้ามรวมเข้า total ที่ใช้จริง (กันบั๊กเลขโป่ง)

const CACHE_READ_KEYS = ["cacheReadTokens", "cacheRead", "cache_read", "cache_read_tokens", "cacheReadInputTokens"];

function pickCacheRead(ev) {
  if (ev.cacheReadTokens != null) return Number(ev.cacheReadTokens) || 0;
  const b = ev.breakdown || {};
  for (const k of CACHE_READ_KEYS) if (b[k] != null) return Number(b[k]) || 0;
  return 0;
}
function sumBreakdown(b) {
  return Object.entries(b || {}).reduce((a, [k, v]) =>
    CACHE_READ_KEYS.includes(k) ? a : a + (Number(v) || 0), 0);
}
function totalOf(ev) {
  return Number(ev.tokens != null ? ev.tokens : (ev.breakdown ? sumBreakdown(ev.breakdown) : 0));
}
function visibleBreakdownKeys(ev) {
  return Object.keys(ev.breakdown || {}).filter((k) => !CACHE_READ_KEYS.includes(k));
}

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✅" : "❌"} ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
}

// 1) backend ส่ง total สำเร็จรูป + cacheReadTokens ที่ top-level → total ห้ามรวม cache
const a = { tokens: 1200, cacheReadTokens: 50000, breakdown: { input: 800, output: 400 } };
check("top-level cacheRead: total ไม่โป่ง", totalOf(a), 1200);
check("top-level cacheRead: ดึงป้ายได้", pickCacheRead(a), 50000);
check("top-level cacheRead: breakdown ปกติครบ", visibleBreakdownKeys(a), ["input", "output"]);

// 2) ไม่มี total → fallback sum breakdown ที่ดันมี cache_read ปน → ต้องตัด cache ทิ้ง
const b = { breakdown: { input: 800, output: 400, cache_creation: 300, cache_read: 99999 } };
check("fallback sum: ตัด cache_read ออกจาก total", totalOf(b), 1500);
check("fallback sum: ดึง cache_read เป็นป้าย", pickCacheRead(b), 99999);
check("fallback sum: chip ไม่โชว์ cache_read", visibleBreakdownKeys(b), ["input", "output", "cache_creation"]);

// 3) cacheReadTokens อยู่ใน breakdown (alias) → ก็ต้องไม่เข้า total และไม่ซ้ำใน chip
const c = { breakdown: { input: 1000, cacheReadTokens: 12345 } };
check("breakdown alias: total เฉพาะ input", totalOf(c), 1000);
check("breakdown alias: ดึงป้ายได้", pickCacheRead(c), 12345);
check("breakdown alias: chip เหลือแค่ input", visibleBreakdownKeys(c), ["input"]);

// 4) ไม่มี cache เลย → ป้ายไม่ขึ้น (0), total ปกติ
const d = { tokens: 700, breakdown: { input: 500, output: 200 } };
check("no cache: pickCacheRead = 0", pickCacheRead(d), 0);
check("no cache: total ปกติ", totalOf(d), 700);

console.log(`\n${fail ? "❌ FAIL" : "🎉 PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
