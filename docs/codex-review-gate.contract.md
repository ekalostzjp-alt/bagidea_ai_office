# Codex Review Gate — Contract

Owner: team lead (Nueng). Backend: Black (`daemon/server.js`). Frontend: White (`daemon/overlay.html`).

เป้าหมาย CEO: หลัง **มิสเตอร์ N ส่งงาน** → Director (บาร์ท) ให้ **Codex CLI** รีวิวโค้ดอัตโนมัติ (กรรมการกลาง — ตัดสินด้วยผล Codex ไม่ใช่ดุลพินิจ Director). ไม่ผ่าน → ตีกลับให้ N อัตโนมัติพร้อมเหตุผล+จุดที่ต้องแก้. Codex token หมด → **passby (ข้าม)** แล้วพอ Codex กลับมาก็ gate ตามเดิม.

## 0. สิ่งที่ทดสอบจริงบนเครื่องนี้แล้ว (empirical, Codex v0.137.0)
- `codex exec --skip-git-repo-check -s read-only "Reply PONG"` → **exit 0**, stdout `PONG`, model `gpt-5.5`, "tokens used 11,981" (รันจริง). ✅ Codex ใช้งานได้ตอนนี้.
- flags ที่ใช้ได้: `--json` (JSONL events), `--output-last-message <FILE>` (เขียนข้อความสุดท้ายลงไฟล์ → parse ง่าย), **`--output-schema <FILE>`** (บังคับ shape ของคำตอบสุดท้ายตาม JSON Schema), `-C <DIR>` (cwd), `-s read-only` (sandbox อ่านอย่างเดียว — ปลอดภัย), `-m <model>`.
- `codex review --uncommitted` = รีวิว diff ที่ยังไม่ commit (โหมดรีวิวเฉพาะ แต่ output เป็น prose).

## 1. Invocation ที่ parse ได้ (ให้ Black ใช้)

รันใน git dir ของโปรเจค (`-C <projectDir>`), อ่านอย่างเดียว, บังคับ JSON ด้วย schema:
```
codex exec --skip-git-repo-check -s read-only -C "<projectDir>" \
  --output-schema "<tmp>/review.schema.json" \
  --output-last-message "<tmp>/review.out.json" \
  "รีวิวการแก้ล่าสุด (git diff/uncommitted) ของงานที่ <agent> เพิ่งส่ง. ประเมินคุณภาพ/บั๊ก/ความครบ.
   ตอบเป็น JSON ตาม schema เท่านั้น: {pass, reasons[], files[], fixes[]} (reasons/fixes เป็นภาษาไทย)."
```
- `review.schema.json`:
  ```json
  { "type":"object","required":["pass","reasons","files","fixes"],
    "properties":{ "pass":{"type":"boolean"},
      "reasons":{"type":"array","items":{"type":"string"}},
      "files":{"type":"array","items":{"type":"string"}},
      "fixes":{"type":"array","items":{"type":"string"}} } }
  ```
- หลังรัน: `JSON.parse(readFile(review.out.json))` → ได้ `{pass, reasons, files, fixes}`.
- timeout กันค้าง: ~120s → เกิน = `error` (ไม่ใช่ skip).

## 2. ตรวจ "Codex token หมด / quota / 429 / ใช้งานไม่ได้"
ดูจาก **exit code + stderr** ของ `codex exec`:
- `exit 0` + parse JSON ได้ → `codexAvailable=true`, ใช้ verdict จาก Codex.
- `exit != 0` **และ** stderr/stdout เข้าเงื่อนไขใดเงื่อนไขหนึ่ง (regex, case-insensitive):
  `usage limit|rate.?limit|429|quota|exceeded|too many requests|not logged in|unauthor|auth|login`
  → ถือว่า **`codexAvailable=false`** → verdict `skipped` (passby).
- exit != 0 ด้วยเหตุอื่น (เช่น parse พัง, timeout) → `verdict:'error'` (ไม่ bounce, log ไว้ ให้ Director ตัดสินใจ/retry).

## 3. Flow (ให้ Black ทำ)

1. **Trigger**: เมื่อ มิสเตอร์-n ส่งงาน (task/job ของ `มิสเตอร์-n` completed ที่ผูกโปรเจค) → เรียก review-gate กับ `projectDir` ของงานนั้น. (หรือ Director เรียกผ่าน `POST /review/run`.)
2. รัน Codex (ข้อ 1) → ได้ผล.
3. สร้าง result:
   ```jsonc
   { "reviewId":"rv…", "agentId":"มิสเตอร์-n", "verdict":"pass"|"fail"|"skipped"|"error",
     "reasons":[], "files":[], "fixes":[], "codexAvailable":true, "round":1, "ts":… }
   ```
   `verdict` = `pass` ถ้า `codex.pass===true`; `fail` ถ้า `false`; `skipped` ถ้า codexAvailable=false.
4. **broadcast** `{type:"review.result", ...result}`.
5. **ถ้า `fail`** → สร้าง job อัตโนมัติ bounce กลับเข้า dispatch ไปที่ `มิสเตอร์-n` พร้อม feedback (`reasons` + `fixes` + `files`), เพิ่ม `round`.
   - **max รอบ กัน loop**: `REVIEW_MAX_ROUNDS = 3`. ครบแล้วยัง fail → หยุด bounce, `verdict` คงเดิมแต่ตั้ง flag escalate → broadcast แจ้ง Director/CEO ("ครบ 3 รอบยังไม่ผ่าน — ขอ CEO ตัดสิน").
6. **ถ้า `skipped` (passby)** → ปล่อยงานผ่านชั่วคราว + ตั้ง `pendingReReview` (เก็บ {agentId, project, deliverableRef}) + เปิด **retry timer** (เช็คทุก ~5 นาที): ลองรัน Codex probe สั้นๆ; พอ `codexAvailable=true` → กลับมา gate งานที่ค้าง (re-review pendingReReview) แล้วทำ flow ปกติต่อ.

## 4. Endpoints / state (Black)
- `POST /review/run` body `{ agentId, project }` → รัน gate, คืน result, broadcast. (Director/automation เรียก)
- `GET /review/last?agent=<id>` → result ล่าสุดของ agent นั้น.
- `GET /review/status` → `{ codexAvailable, pendingReReview:[], rounds:{<deliverable>:n} }`.
- state file: `daemon/review-gate.json` (codexAvailable, pending, rounds).
- เก็บ schema ชั่วคราวใน tmp (เขียนทุกครั้งก่อนรัน หรือ ship ไฟล์เดียวใน daemon/).

## 5. Frontend (White)
- ฟัง `review.result` → การ์ด: ผ่าน ✅ / ไม่ผ่าน ❌ (โชว์ reasons+fixes+files) / passby ⏭ (Codex ไม่พร้อม) / รอ CEO (ครบ max รอบ).
- badge codexAvailable (เขียว/เทา) จาก `GET /review/status`.

## 6. Neutrality (สำคัญ)
Verdict มาจาก **ผลลัพธ์ Codex เท่านั้น** (`pass` boolean จาก JSON). Director/daemon ห้ามแก้ผล — แค่เดินงานตาม flow. ความเป็นกลางมาจากกรรมการกลาง (Codex/gpt-5.5).

## 7. ความเสี่ยง
- ค่ารัน: Codex turn ~หมื่น token/ครั้ง (วัดได้ 11,981 ในเทสต์ trivial) — review จริงแพงกว่า. ควร gate เฉพาะ "ส่งงานจริง" ไม่ใช่ทุก progress.
- Codex review ตัดสินจาก git diff → งานที่ไม่ commit/ไม่มี diff อาจรีวิวไม่ตรง; ระบุ scope ให้ชัดใน prompt (uncommitted / ไฟล์ที่แตะจาก deliverable).
- ต้องกัน loop: max rounds + escalate (ข้อ 3.5).
- กฎเหล็ก: `codex exec` เป็น process ลูก — ต้องมี timeout + kill ถ้าเกินเวลา ห้ามทิ้งค้าง.
