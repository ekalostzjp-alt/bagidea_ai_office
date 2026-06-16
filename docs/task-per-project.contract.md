# Per-Project Task Filtering — Contract

Owner: Nueng. สถานะ: **implemented + tested + LIVE** (ทำ inline รอบแรก, ไม่ได้แบ่ง Black/White).
เอกสารนี้บันทึกสัญญาย้อนหลังให้ครบใน `app/docs/`.

เป้าหมาย CEO: แต่ละโปรเจคเห็น **Task ของตัวเองแยกกัน**.

## Endpoints
- `POST /jobs` — เพิ่มฟิลด์ `project` (เก็บ canonical project id; ว่าง = งานทั้งออฟฟิศ).
- `GET /jobs?project=<id|path|name>` — กรอง Task เฉพาะโปรเจคนั้น; ไม่ใส่/ว่าง = ทุกงาน.
- resolver กลาง `resolveProjectRef(ref)` — รับ id / path / ชื่อ → canonical id (ใช้ซ้ำได้กับ `/snapshots`, `/review`).
- `dispatchJob()` ส่ง `project` เข้า `runClaude({project})` → Task รันใน **โฟลเดอร์โปรเจคจริง** + ใส่ `project` ใน event `job.started`.

## Frontend
- แท็บ 📋 TASKS: dropdown `#jFilter` กรองตามโปรเจค + `#jProject` ตั้งโปรเจคตอนสร้าง Task + แสดง 📁 ชื่อโปรเจคต่อแถว.

## ทดสอบ (ผ่านแล้ว)
- กรองตาม id / path / name → คืนเฉพาะของโปรเจคนั้น; unknown → []; ว่าง → ทั้งหมด. (verified บน instance แยกพอร์ต)
- backward-compatible: job เก่าที่ไม่มี `project` = งานทั้งออฟฟิศ.
