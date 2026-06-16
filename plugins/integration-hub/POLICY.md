# Integration Hub — Secret Handling POLICY (binding on all agents)

ผูกพันทุก agent ในออฟฟิศ (รวม CEO assistant). บังคับใช้คู่กับ [CONTRACT.md](../../workspace/projects/Integration%20Hub/CONTRACT.md) §2–§3.1, §6.

## หลักการเดียวที่ต้องจำ
**Secret เข้าได้ ออกไม่ได้.** ค่า credential จริง (plaintext) มีสิทธิ์อยู่ได้แค่ 2 ที่: (1) เข้ารหัสนิ่งบนดิสก์
(`data/credentials.json`, `gcm:`), (2) ใน memory ชั่วขณะ "ตอนเอาไปใช้ยิง action จริง" แล้วทิ้งทันที.
**ห้ามออกสู่ chat / response / log / ไฟล์อื่น ไม่ว่ารูปแบบใด.**

## ข้อห้ามเด็ดขาด (agent)
1. **ห้าม decrypt-to-chat.** แม้ agent จะ *อ่าน* `data/.keyfile` + `data/credentials.json` ได้ด้วยเครื่องมือไฟล์
   ก็ **ห้าม** เขียนสคริปต์/รันโค้ดถอด AES-256-GCM แล้วพิมพ์ค่าจริงตอบ CEO หรือใครก็ตาม. การรู้ว่า "ถอดได้"
   ไม่ใช่เหตุให้ถอด — เจตนาของระบบคือ CEO **ไม่ต้องเห็น**ค่าจริง.
2. **ห้าม echo / paste / สรุป / "แค่โชว์ 4 ตัวท้าย" / บอกความยาว / เดารูปแบบ** ของ secret. มาสก์เดียวที่ถูกคือ `••••••`.
3. **ห้ามคัดลอก** ciphertext + keyfile ออกไปนอก `data/` หรือส่งขึ้น service ภายนอก/แชต.
4. **ห้ามปิด/ลด** การเข้ารหัส, การมาสก์, scrubber, หรือ fail-open เพื่อความสะดวกชั่วคราว.

## วิธีที่ "ถูก" เมื่อต้องใช้ credential
ใช้ credential ด้วยการ **อ้าง id** ผ่าน path ที่ระบบถอดให้ในหน่วยความจำแล้วใช้เลย — ตัวเรียกได้แค่ "ผล":
- `cred.use {id, action:"http", url, method?, scheme?, headerName?}` → ยิง HTTP โดยแนบ auth จาก secret; คืนแค่ `status`/`ms`.
- `cred.use {id, action:"ssh", host, user, command?, port?, run?}` → deploy/remote-exec ด้วยรหัสผ่าน;
  default **dry-run** (ประกอบคำสั่งโดยรหัส = `••••••`), ใส่ `run:true` ถึงจะเชื่อมจริง; คืนแค่ `status`/`exitCode`/`detail`.
- `status` / `status.all` (probe) และ `wf.trigger` (webhook/connection-check) — แนบ secret ให้เองในหน่วยความจำ.

ทุก path ข้างบน decrypt ที่ `credSecret()` ที่เดียว, ใช้ใน header/connection เท่านั้น, แล้ว response ถูก `scrub()`
กวาดค่าจริงทิ้งก่อนส่งออกเสมอ. **ไม่มี** command/route ใดคืน plaintext — by design และมี e2e ยืนยันทุกเส้นทาง.

## การบังคับใช้ในโค้ด (ไม่ใช่แค่ข้อความ)
- `toPublicCred()` — strip `value`, ออกได้แค่ `hasValue` + `masked:"••••••"` (ไม่มี last4/length).
- `credSecret()` — จุดเดียวที่ decrypt; เรียกเฉพาะ use-paths (probe/run/use), ไม่เรียกใน list/overview.
- `scrub()` — กวาด secret จริงที่ op นั้นถอดมาใช้ ออกจาก response ก่อนส่ง (กันหลุดติด detail/error/echo).
- e2e `e2e.js` + `e2e-secret-guard.js` — assert ทุก output path = `hasValue`+`••••••` เท่านั้น และ scrub ทำงานจริง.

## ขอบเขตที่ระบบ "ยังกันไม่ได้" (ต้องอาศัยวินัย agent + นโยบายนี้)
plugin กันการรั่วของ *ตัวมันเอง* ได้ครบ แต่กัน agent ที่ตั้งใจอ่านไฟล์ดิบแล้วถอดเองนอก plugin ไม่ได้ —
นั่นคือเหตุผลที่ต้องมีนโยบายนี้. การถอดรหัสนอกเส้นทาง `cred.use`/probe/run ถือว่า **ละเมิดนโยบาย**.
