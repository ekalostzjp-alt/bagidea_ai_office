# Audit: ทำไมงานที่ Director สั่งไม่มีผลส่งกลับ (task report-back หาย)

ผู้ตรวจ: แบล็ค — 2026-06-10
อาการ: CEO สังเกตว่างานที่ DELEGATE ออกไปหลายรอบ "เงียบหาย" — ไม่มีรายงานผลกลับเข้า chat/feed

## สาเหตุหลัก (root cause)

**daemon self-restart ตัดวงจร report-back กลางคัน** — ไม่ใช่คิวตันหรือ process ค้าง

ลำดับเหตุการณ์ที่เกิดซ้ำๆ:

1. ทีมกำลังแก้ `server.js` / `channels.js` บ่อยมาก (staged deploy ของมิสเตอร์ N,
   งาน overlay ฯลฯ) → watcher (`startWatchers`, server.js:5219-5231) สั่ง
   restart ทุกครั้งที่ไฟล์ code เปลี่ยน
   → **log มี "restart requested" 20 ครั้ง แต่ "deferring restart" แค่ 1 ครั้ง**

2. Guard "ห้ามตัด session" (`requestRestart`, server.js:5125) เช็ค
   `agentBusy.size` เท่านั้น — แต่ `agentBusy` ถูก set เฉพาะงาน scheduled jobs
   ที่มาทาง `dispatchJob` (server.js:1266-1293).
   **งาน DELEGATE (makeDelegateFilter → runClaude ตรง, server.js:1872) และงาน
   แชท CEO (server.js:3303) ไม่เคยแตะ `agentBusy`** → guard เห็นว่า "ว่าง"
   แล้ว restart ทันทีทั้งที่มีงานกำลังรัน

3. `doRestart` (server.js:5190): process เก่า `process.exit(0)` หลัง handoff 6
   วินาที โดยไม่สนใจอะไรทั้งสิ้น → สิ่งที่ตายไปกับมัน:
   - callback `onDone → reportToMain` (server.js:1875) ของทุก delegate ที่กำลังรัน
   - `dirQueue` / `dirBusy` (คิว report-back เข้า Director) — in-memory ล้วน
   - `jobQueue` (งาน scheduled ที่รอคิว) — in-memory
   - `setTimeout` 4500ms ก่อน dispatch DELEGATE (server.js:1853-1877) —
     delegation ที่ยังไม่ทันออกตัวหายเงียบ
   - claude child processes กลายเป็น orphan — บางตัวรันต่อจนจบ (เผา token)
     แต่ stdout ไม่มีใครอ่าน ผลลัพธ์ทิ้งน้ำ

4. daemon ตัวใหม่ boot ขึ้นมา **ไม่มี state ของงาน in-flight เลย** (ไม่มี
   persistence ของ delegation round-trip) → ไม่มีใคร re-dispatch, Director
   ไม่ได้รับรายงาน, CEO เห็นงานเงียบหาย

## หลักฐานสด (จับได้คาหนังคาเขา 2026-06-10 19:31)

- `deploy-restart.log`: restart "changed: server.js" เกิดขณะ 3 งานกำลังรัน —
  t4 (น้องไวท์/modal bug), t5 (มิสเตอร์ N/staged deploy), t6 (แบล็ค/งานตรวจนี้เอง)
- หลัง restart: `GET /activity` ของ daemon ใหม่ตอบ `{"running":[]}` —
  ทั้ง 3 งานหลุดจากระบบติดตามแล้ว และผลของมันจะไม่ถูกส่งกลับทาง pipe ปกติ
- รายงานฉบับนี้จึงต้องส่งผ่าน `POST /event` แทน stdout ของตัวเอง
- ใน usage log มี round-trip ที่สำเร็จอยู่บ้าง (เช่น "📨 รายงานผลจาก น้องไวท์")
  = pipeline ทำงานถูกต้องเมื่อ **ไม่มี restart แทรก** — สอดคล้องกับ diagnosis

## วิธีแก้ (เรียงตามผลกระทบ)

1. **แก้ guard restart ให้ดูงานจริง**: เปลี่ยนเงื่อนไขที่ server.js:5125 จาก
   `agentBusy.size > 0` → `activeRuns.size > 0` (`activeRuns` ครอบคลุมทุก run
   ผ่าน activityStart/End อยู่แล้ว) + ใส่เพดานรอ เช่น เกิน 15 นาทีค่อย force
   พร้อมแจ้ง feed — แก้บรรทัดเดียวได้ผล 80%

2. **Persist delegation round-trip**: ตอน dispatch DELEGATE เขียน journal ลงไฟล์
   (`{target, instruction, session, depth, ts}`) แล้วลบเมื่อ reportToMain จบ.
   ตอน boot ถ้าพบรายการค้าง → ส่ง prompt แจ้ง Director ว่า "งานเหล่านี้อาจถูกตัด
   ระหว่าง restart ให้ตามผล/สั่งใหม่" (หรือ auto re-dispatch เลย)

3. **ตายอย่างมีมารยาท**: ใน `doRestart` ก่อน `process.exit(0)` ถ้ายังมี
   `activeRuns` ให้เขียนรายการลง journal + `broadcast` แจ้ง feed ว่า
   "restart ตัดงาน N ชิ้น: ..." — อย่างน้อย CEO เห็นว่างานหาย ไม่ใช่เงียบ

4. **จัดการ orphan**: ตอน exit ให้ kill child process tree (Windows:
   `taskkill /PID <pid> /T /F`) เพื่อไม่ให้ claude รันต่อแบบเผา token ฟรี —
   ถ้าทำข้อ 1 แล้ว จุดนี้แทบไม่เหลือเคส

5. **ลดตัวจุดชนวน**: ระหว่างออฟฟิศมีงานรัน ห้าม copy/แก้ live `server.js`,
   `channels.js` ตรงๆ — ใช้เส้นทาง staged + review gate ที่มีอยู่ แล้ว deploy
   ตอน `activeRuns` ว่างเท่านั้น

## สิ่งที่ตรวจแล้ว "ไม่ใช่" สาเหตุ

- คิวตัน: `jobQueue`/`dirQueue` ทำงานถูกต้องใน process ที่มีชีวิต
  (`fireDone` ยิงแน่นอนทั้งทาง result/close/error — server.js:1586-1704)
- Permission ค้าง: มี auto-deny 50 วินาที (server.js:4489-4492) ไม่ block ถาวร
- Global cap (`agentBusy.size >= 2`): ใช้กับ scheduled jobs เท่านั้น และคิวถูก
  drain ใน onDone ปกติ
