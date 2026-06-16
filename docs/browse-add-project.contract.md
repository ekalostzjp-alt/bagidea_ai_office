# Browse / Add Project — Contract

Owner: team lead (Nueng). Backend: Black (`daemon/server.js`). Frontend: White (`daemon/overlay.html`).

เป้าหมาย: ผู้ใช้เดินดูโฟลเดอร์ในเครื่อง (folder picker ในธีมออฟฟิศ) แล้ว "เพิ่มโปรเจคที่มีอยู่แล้ว" เข้า roster ได้ — **อย่างปลอดภัย** (กัน path traversal / leak ระบบ).

## 1. `GET /fs/list?path=<abs dir>`  — list directory (dirs-only)

คืน:
```jsonc
{ "path":"D:\\project", "parent":"D:\\", "dirs":[{"name":"tookjorThai","path":"D:\\project\\tookjorThai"}, …], "drives":["C:\\","D:\\"] }
```
- `path` ว่าง → คืน drive roots ใน `drives[]` + `dirs=[]` (เริ่มที่หน้าเลือกไดรฟ์).
- `parent` = โฟลเดอร์แม่ (null ถ้าเป็น root ของไดรฟ์).

### 🔒 Safety ของ /fs/list (บังคับ — ให้แบล็คทำตามเป๊ะ)
1. **dirs-only**: คืนเฉพาะ "ชื่อโฟลเดอร์ย่อย" เท่านั้น — **ห้ามคืนรายชื่อไฟล์ และห้ามอ่านเนื้อหาไฟล์ใดๆ** (เป็น picker เลือกโฟลเดอร์ ไม่ใช่ file browser). ตัด leak เนื้อไฟล์ที่ต้นทาง.
2. **normalize + absolute**: `const real = path.resolve(String(path))`. ถ้าไม่ใช่ absolute → 400. การ resolve ยุบ `..` ให้แล้วค่อยตรวจ policy (กัน `D:\x\..\..\Windows`).
3. **ต้องเป็นไดเรกทอรีจริง**: `fs.statSync(real).isDirectory()` ไม่จริง/ไม่มี → `400 "not a directory"` (ไม่ throw, ไม่ leak stack).
4. **denylist ระบบ** (prefix, case-insensitive) → `403 "restricted"`:
   `C:\Windows`, `C:\Program Files\WindowsApps`, `C:\ProgramData\Microsoft`,
   path ที่มี `\System32\`, `\AppData\Local\Microsoft\`, recycle (`$Recycle`), `System Volume Information`.
   (ดูชื่อโฟลเดอร์ระบบได้ผิวๆ แต่ปิด tree อ่อนไหวที่สุด ตามที่ CEO สั่ง "ไม่ leak ไฟล์ระบบ/ไดรฟ์นอกขอบเขต")
5. **ซ่อน hidden/system entries**: ตัด entry ที่ขึ้นต้นด้วย `.` หรือ `$` (มีอยู่แล้วใน /fs เดิม — คงไว้).
6. **ไม่ตาม symlink ออกนอกขอบเขต**: ถ้า entry เป็น symlink/junction ที่ชี้ออกไป tree ต้องห้าม → ไม่แสดง (หรือ resolve แล้วเช็ค denylist ซ้ำ).
7. **cap**: คืน dirs ไม่เกิน ~1000 รายการ/ครั้ง (กัน response บวม).
8. **errors เงียบ+สุภาพ**: readdir ที่ permission denied → คืน `dirs:[]` (ไม่ throw), ไม่หลุด path ระบบใน error.

> หมายเหตุ: `/fs` เดิม (`?dir=`) ใช้ folder picker อยู่แล้วแต่ **ไม่จำกัด dir** — `/fs/list` ตัวใหม่ต้องเพิ่ม policy ข้อ 2–8. แนะนำให้ `/fs` เดิมเรียกใช้ logic เดียวกัน (รวมจุดเดียว) เพื่อไม่ให้มีช่องเก่าหลุด.

## 2. `POST /projects/add  { path, name? }`

- validate `path` ด้วย safety เดียวกับ /fs/list (resolve, isDirectory, ไม่อยู่ใน denylist) — ผิด → 400/403.
- `name` ดีฟอลต์ = `path.basename(real)`.
- ใช้กติกา `createProject()` เดิม: **ห้าม path ซ้ำ, ห้ามชื่อซ้ำ, ห้ามเป็นโฟลเดอร์ของ place** → ถ้าชน คืน 400 พร้อมข้อความไทยที่ createProject โยน.
- ลงทะเบียน (ไม่ต้อง mkdir เพราะโฟลเดอร์มีอยู่แล้ว, `created:false`) → persist `projects.json`.
- broadcast **`{ type:"project.added", id, name, dir }`** + `projects.changed`.
- คืน `200 { id, name, dir }`.

> ต่างจาก `POST /projects` (สร้างใหม่/place): `/projects/add` = "ผูกโฟลเดอร์ที่มีอยู่แล้ว" ตรงๆ จาก browse.

## 3. WS event
`{ type:"project.added", id, name, dir }` → overlay เติมโปรเจคเข้า list สด (แยกตามโปรเจคตามระบบเดิม).

## 4. Frontend (White)
- ปุ่ม "📂 เลือกของเดิม" → เปิด folder picker (`#fsList`) เดิน `/fs/list` (คลิกโฟลเดอร์ = ลงลึก, ปุ่มขึ้น parent, เลือกไดรฟ์).
- กดยืนยันโฟลเดอร์ → `POST /projects/add {path}` → ฟัง `project.added` เติม list.

## 5. ทดสอบ (e2e)
1. `GET /fs/list?path=D:\` → มี dirs (รวม `project`), ไม่มีไฟล์, มี drives.
2. `GET /fs/list?path=C:\Windows` → **403 restricted**.
3. `GET /fs/list?path=D:\project\..\project` → resolve เป็น D:\project (กัน traversal), คืนปกติ.
4. `GET /fs/list?path=D:\noexist` → 400 not a directory.
5. `POST /projects/add {path:"D:\\project\\tookjorThai"}` → 400 (ซ้ำ, มีแล้ว) — พิสูจน์กติกา createProject; เพิ่มโฟลเดอร์ใหม่จริง → 200 + `project.added` + อยู่ใน `GET /projects`.
6. ปิดท้าย: ถ้า add โปรเจคทดสอบ ต้อง remove ออก (cleanup) — **ยกเว้นห้ามแตะ tookjorThai**.

## 6. ความเสี่ยง
- policy denylist เป็น "ปิดที่อ่อนไหวสุด" ไม่ใช่ allowlist เข้ม (เพราะ picker ต้องเดินได้ทั้งเครื่องเพื่อหาโปรเจค) — ถ้าต้องการเข้มกว่า ทำ allowlist roots (เช่น เฉพาะไดรฟ์ที่ไม่ใช่ C: หรือเฉพาะ home) ได้เป็น follow-up.
- ต้องรวม logic /fs เดิมกับ /fs/list ให้ใช้ guard เดียว — ไม่งั้นช่องเก่า (`/fs?dir=C:\Windows`) ยังหลุด.
- `/projects/add` ห้ามทำ removeDisk/ลบ ใดๆ — เพิ่มอย่างเดียว.
