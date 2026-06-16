# Contract: Report-back ครบทุกเส้นทาง + Review-gate fail-open

ผู้แก้: แบล็ค — 2026-06-14
อาการที่ CEO รายงาน: "ไม่มีสรุปงานแก้โค้ดเด้งกลับมาที่ Director/CEO แล้ว ต้องกดเข้าไป
อ่านในแชท agent เอง" — มี 2 รูรั่วในไฟล์ `daemon/server.js` (แก้ผ่าน `server.staged.js`).

---

## (1) Codex review-gate fail-OPEN เมื่อ timeout/error

**ปัญหา:** `review-gate.json` ฟ้อง verdict `"error"` reason `"codex timeout 120s"` กับทั้ง
มิสเตอร์-n / แบล็ค / น้องไวท์. verdict `"error"` ไม่ใช่ "งานไม่ผ่าน" — มันคือ "ตรวจไม่สำเร็จ"
แต่เดิมมันเงียบหายไปใน `review-gate.json` ไม่มี notice เข้า feed เลย.

**สัญญา (runReviewGate, server.js ~`else if (result.verdict === "error")`):**
- verdict `"error"` (codex timeout/crash) **ห้ามกลืน deliverable** — รายงานงานต้อง
  เดินถึง CEO เสมอผ่าน `reportToMain` (ถูกเรียกคู่กับ gate ใน delegate `onDone`,
  สอง path แยกกัน gate ไม่ได้ block report).
- โพสต์ notice เข้า Director feed: `chat.message` agent `"main"` ข้อความ
  "🧑‍⚖️ ตรวจอัตโนมัติ (Codex) ไม่สำเร็จ: … — งานของ <agent> (<project>) ส่งถึง CEO แล้ว
  รอ CEO ตัดสินเอง" → ไม่ค้างเป็น pending เงียบ.
- **ไม่ bounce job** และ **ไม่นับ round** (round bookkeeping reset เป็น 0 สำหรับ verdict
  ที่ไม่ใช่ `"fail"`) → codex ช้า/ล่มซ้ำ ก็ติดวน re-review ไม่ได้.
- `REVIEW_TIMEOUT_MS` ลด 120000 → **90000ms** (fail เร็วและสะอาดขึ้น).
- กันวน escalate: `"fail"` จริงเท่านั้นที่ bounce, ครบ `REVIEW_MAX_ROUNDS` (3) → `escalate`
  หยุดตีกลับ ขอ CEO ตัดสิน (ของเดิม คงไว้).

## (2) Report-back ของงานสั่งตรง (ไม่ผ่าน DELEGATE)

**ปัญหา:** report-back ผูกอยู่แค่ใน `makeDelegateFilter.onDone` (→ `reportToMain`).
งานที่ CEO เปิดแชท agent สั่งเอง (`POST /chat` สาขา agent ที่ไม่ใช่ main/ceo) วิ่งผ่าน
`runClaude(agent, …)` ตรง ๆ — ไม่มีสรุปเด้งเข้า Director.

**สัญญา (`POST /chat` direct-agent branch + `reportDirectWork`):**
- ก่อนเริ่ม run: snapshot `gitTreeSig(dir)` = `git status --porcelain` ของโปรเจค (baseSig).
- ตอน `onDone(text, ok=true)`: ถ้า tree **เปลี่ยนจริง** (nowSig ≠ baseSig, ทั้งคู่อ่านได้)
  → deliverable จริง → `reportDirectWork`:
  - `chat.message` agent `"main"` (`watchdog:true`, `directReport:true`, `fromAgent:<id>`) —
    การ์ดสรุป 3–4 บรรทัด: ชื่อ agent · project / คำสั่งย่อ / ผลย่อ (≤400 ตัว) /
    ไฟล์ที่แตะ (≤8) / "→ เปิดแชท <agent> เพื่อดูรายละเอียดเต็ม".
  - `ceo.report` ping → CEO view ขึ้น chip "📨 เดินมาส่งสรุปงานแล้ว".
- **เงียบ** เมื่อ: tree ไม่เปลี่ยน (ถาม-ตอบเฉย ๆ) / baseSig อ่านไม่ได้ / ไม่มี project /
  git ไม่พร้อม → ไม่ cry-wolf.
- **ไม่แตะ session/onDone ของ agent**: ทั้งสองเป็น broadcast display-only ไม่ spawn main
  ไม่ขัด/ตัด session ของผู้ทำงาน. wait-path เดิม (`waited`) ยังทำงานครบ.

---

## ทดสอบ

`node tools/direct-report-and-gate-failopen-e2e.js` — 0 token, ไม่บูต daemon, ไม่แตะ state สด.
ดึง source จริงของ `gitTreeSig` / `reportDirectWork` / `runReviewGate` มารันใน sandbox พร้อม stub
(git ผ่าน spawnSync stub, broadcast เป็น spy, runCodexReview บังคับ error). 21 เคสผ่านครบ:
change-detection, การ์ดสรุปเด้งเฉพาะ deliverable จริง, เงียบเมื่อถาม-ตอบ, fail-open ไม่ bounce
ไม่วน round โพสต์ notice "รอ CEO".

## Deploy

`server.staged.js` → `server.js` **เฉพาะตอน `activeRuns` ว่าง** (ตามกฎ audit
`task-report-pipeline`: restart ตัด report-back กลางคัน). ห้าม deploy ทับงานที่กำลังรัน.
