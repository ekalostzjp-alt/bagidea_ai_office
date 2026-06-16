# Work Summary Modal — Contract

Owner: team lead (Nueng). Backend: Black (`daemon/server.js`). Frontend: White (`daemon/overlay.html`).

เมื่อทีมทำฟีเจอร์เสร็จ ให้มี Modal เด้งบน overlay สรุปเป็นภาษาไทยว่า **ใครแก้อะไร ทำอะไรไปบ้าง แตะไฟล์ไหน**. เอกสารนี้คือ "สัญญากลาง" ที่ทั้ง backend และ frontend ต้องยึดตรงกัน ห้ามเปลี่ยน schema โดยไม่แจ้งหัวหน้าทีม.

## 1. WS event / schema

ทุกฝั่งใช้ event เดียวกันนี้ (broadcast ผ่าน WebSocket ของออฟฟิศที่ `ws://127.0.0.1:8787/ws`):

```jsonc
{
  "type": "work.modal",
  "title": "string",                         // หัวข้องาน เช่น "ฟีเจอร์ Work Summary Modal เสร็จแล้ว"
  "members": [                                // ใครทำอะไร (0..50 คน)
    {
      "name": "string",                       // ชื่อสมาชิก
      "did":  "string",                       // ทำอะไรไป (อธิบายเป็นภาษาไทย)
      "files": ["string", "..."]              // ไฟล์ที่แตะ (path, 0..200 ไฟล์)
    }
  ],
  "summaryTh": "string",                      // สรุปรวมเป็นภาษาไทย
  "ts": 1234567890                            // daemon ใส่ให้เองตอน broadcast (epoch ms)
}
```

หมายเหตุ field:
- `title`, `summaryTh`, `members[].name`, `members[].did`, `members[].files[]` ทั้งหมดเป็น string. daemon coerce + ตัดความยาวให้ (กัน payload พังทำ bus ล่ม).
- `ts` ฝั่ง client **ไม่ต้องส่ง** — daemon stamp ให้ตอน broadcast.

## 2. Backend — `daemon/server.js` (Black)

### `POST /work/summary`
- รับ body = `{ title, members:[{name,did,files[]}], summaryTh }`.
- coerce + cap ทุก field (title ≤200, summaryTh ≤8000, members ≤50, did ≤2000, files ≤200×500).
- ถ้า `title`, `summaryTh`, `members` ว่างทั้งหมด → `400 empty payload`.
- สำเร็จ →
  1. `broadcast({type:"work.modal", title, members, summaryTh})` ออก WS ของออฟฟิศ (daemon stamp `ts`).
  2. persist payload ล่าสุดลง `daemon/work-summary.json` รูปแบบ `{ "summary": <evt> }`.
  3. ตอบ `200 { ok:true, summary:<evt> }`.

### `GET /work/summary`
- คืน payload ล่าสุด `{ "summary": <evt> }`.
- ยังไม่เคยมี POST → `{ "summary": null }`.
- ใช้เพื่อให้ overlay ที่เพิ่งต่อกลับมา rebuild modal ได้โดยไม่ต้องรอ broadcast ใหม่.

## 3. Frontend — `daemon/overlay.html` (White)

- overlay ฟัง event ใน `route(ev)`: เจอ `type === "work.modal"` → เปิด Modal.
- **ข้าม journal replay** (`if (!ev.replay) openWorkModal(ev)`) — กัน reconnect แล้ว modal เก่าเด้งทับจอ.
- Modal (`#workModal`) แสดง: หัวข้อ, สรุปภาษาไทย, การ์ดรายคน (ชื่อ + ทำอะไร + chip ไฟล์ที่แตะ).
- ฉีดข้อความด้วย `textContent` เท่านั้น (กัน XSS จากชื่อ/ชื่อไฟล์).
- ปิดได้ด้วยปุ่ม ✕ / คลิกฉากหลัง / กด Esc.

## 4. ทดสอบ end-to-end

สคริปต์: `tools/work-summary-e2e.js` (zero-dependency, มี WebSocket client ในตัว).

```bash
# ยิงใส่ daemon ที่พอร์ตไหนก็ได้ (default 8787)
node tools/work-summary-e2e.js            # ทดสอบ :8787
node tools/work-summary-e2e.js 8799       # ทดสอบ instance อื่น
```

สคริปต์จะ: เปิด WS → `POST /work/summary` (ตัวอย่าง 3 คน) → ยืนยันว่า **broadcast `work.modal` ออกจริงทาง WS** → `GET /work/summary` แล้วเทียบว่าตรงกับที่ส่ง → exit 0 ถ้าผ่าน, 1 ถ้าไม่ผ่าน.

## 5. Integrate / deploy

ตามกฎ **Restart-on-change**: แก้ `server.js` → daemon graceful self-restart เมื่อ idle; แก้ `overlay.html` → overlay reload หน้าเอง. ดู `workspace/OFFICE.md` หัวข้อ Office rules.
