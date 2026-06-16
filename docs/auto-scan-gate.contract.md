# Auto-Scan Gate — Contract (White → Mr N / Black)

Owner of the wire: **Mr N** (Brain backend) + **Black** (`server.js` router). Frontend (gate UI + poll + chat-lock): **White** — **DONE** in `daemon/overlay.html` (BUILD `2026-06-12 #17`).

## เป้าหมาย (คำสั่ง CEO)
เมื่อ CEO เลือกโปรเจคใน picker 🧠 แล้ว **ยืนยันเริ่มงาน** ถ้าโปรเจคนั้น **ยังไม่ scan** → เด้ง modal บล็อก "กำลัง Scan โปรเจค…" (spinner) + **ล็อกช่องแชท** (พิมพ์/ส่ง Task ไม่ได้) → poll สถานะจาก backend → พอ `ready` ปิด modal เอง ปลดล็อกแชท แล้ว dispatch prompt ที่ค้างไว้อัตโนมัติ.

## Endpoint ที่ frontend เรียก (รอ Mr N promote)
```
GET /project/scan/status?project=<id|path|name>
→ 200 { "state": "scanning" | "ready" }
```
- **field ที่ตกลงกัน = `state`** (ค่า `"scanning"` หรือ `"ready"`).
- Frontend ทนรับ fallback: `status` (ชื่อเก่า) และ boolean `{scanning}|{ready}` — แต่ **ขอให้ส่ง `state` เป็นหลัก**.
- `404`/ไม่มี route = degrade graceful: gate จะพึ่ง WS event แทน (ดูล่าง) ไม่ค้างถาวร.

## WS events (มีอยู่แล้ว — gate ใช้ปิดตัวเอง)
gate ปลดล็อกทันทีเมื่อได้ event ใด event หนึ่งของโปรเจคที่กำลัง gate:
- `scan.done { project, scannedAt, stats }` — มีแล้วใน live.
- `brain.ready { project, projectName, stats }` — ชื่อใน Project Brain contract; overlay map → scan.done ให้เอง.

ดังนั้นแม้ `GET /project/scan/status` ยังไม่มา gate ก็ทำงานได้จาก WS — แต่มี `state` แล้ว poll จะแม่นกว่า (รู้ "scanning" ตั้งแต่ต้น + กันพลาด event).

## พฤติกรรม frontend (สรุป)
1. `pcConfirm()` — ถ้า `pid` เป็นโปรเจคจริง และ `BRAIN[pid].scanned != true` → `openScanGate()` แทนการ dispatch ทันที (home/empty-id ข้าม — ถือว่า scan แล้วเสมอ).
2. `openScanGate()` — โชว์ `#scanGate`, `lockChat(true)` (disable `#inp`+`#send`), ยิง `POST /project/scan` (idempotent), เริ่ม `pollScanGate()` ทุก 1.5s.
3. `pollScanGate()` — `state==="ready"` → `scanGateReady()`; `unknown` + WS เคยตั้ง scanned แล้ว → ปลดเช่นกัน.
4. `scanGateReady()` — ปิด modal, `lockChat(false)`, mark `BRAIN[pid].scanned=true`, เรียก `onReady()` → `dispatchSend()` (งานเริ่มเอง).
5. ปุ่ม "ยกเลิก รอ Scan" / Esc → ปิด gate, คืน prompt ลงช่อง (ไฟล์แนบยังอยู่).

## หมายเหตุ overlay cache
overlay window ที่เปิดอยู่จะรัน JS เก่า — server serve `#17` แล้ว (verified) แต่หน้าต่างเดิมต้อง **POST /event reload + CEO restart app** ถึงจะเห็นของใหม่.

## Test
`node tools/auto-scan-gate-e2e.js` — sandbox + stub claude (ไม่แตะ :8787, ไม่เผา token). ตอนนี้ guard เขียวหมด, cases 1–4 = **PENDING** จนกว่า `/project/scan/status` จะ live แล้ว re-run ไฟล์เดิมเคสจะ activate เอง (probe ยึด field `state`).

---

# Backend (Mr N) — IMPLEMENTED ใน server.staged.js (รอ promote ตอน office idle)

นิยาม "เคย scan" = มี Brain cache (`brain.cacheFile(pid)` ใน `daemon/brain-cache/`).
**Fail-open เสมอ**: scan พัง → ปล่อยงานที่ค้างคิวทันที gate ห้ามค้างงานเด็ดขาด.

## `GET /project/scan/status?project=<id|name|path>` (ตามที่ไวท์ขอ + เพิ่มเติม)
```json
{ "state": "scanning" | "ready" | "unscanned",
  "projectId": "p1781139305599",
  "startedAt": 1781241000000,   // เฉพาะ scanning
  "queued": 2 }                 // เฉพาะ scanning — จำนวนงานรอ gate
```
- `state` เป็น field หลักตามตกลง; ค่าเพิ่ม `"unscanned"` = ยังไม่มี cache และไม่มี
  scan วิ่งอยู่ (FE: ไม่ใช่ ready — คง gate ไว้ + POST /project/scan ได้เลย)
- โปรเจคไม่รู้จัก → `{ "state": "unknown", "projectId": null }` (HTTP 200)
- ไม่ใส่ `?project` → `{ "scanning": [ {projectId, projectName, startedAt, queued} ] }`
  (indicator รวมทั้งออฟฟิศ)

## Gate ครอบ 3 เส้นทางฝั่ง backend (อัตโนมัติ ไม่ต้องรอ FE ยิง scan)
1. **`POST /chat`** เข้าโปรเจคที่ยังไม่ scan → daemon ยิง scan เอง + ตอบทันที
   `{ "task": null, "gate": "scanning", "project": "<pid>" }` (ปกติ: `{task}` เดิม);
   run จริงต่อคิวและเริ่มเองหลัง scan → FE จะเห็น `task.started` ตอนนั้น
   (**ไม่ต้องส่ง /chat ซ้ำ**). `wait:true` ใช้ได้เหมือนเดิม (response รอจนงานจบจริง).
2. **Task/Job (`dispatchJob`)** → job ต่อคิวหลัง scan, ปล่อยอัตโนมัติ (one-shot:
   scan fail ก็ปล่อย ไม่วนลูป).
3. **`DELEGATE: agent @ project`** → ผ่าน gate เดียวกัน.

## WS event ใหม่: `scan.gate` (transient, ไม่ journal)
- เริ่ม: `{type:"scan.gate", project, projectName, state:"scanning"}`
- จบ+ปล่อยคิว: `{type:"scan.gate", project, projectName, state:"ready", scanned:true|false, error?}`
  (`scanned:false` = fail-open). `brain.ready` เดิมยัง broadcast เมื่อ scan สำเร็จ
  → gate ของไวท์ที่ฟัง `brain.ready`/`scan.done` ปิดตัวเองได้เหมือนเดิม.

## `POST /project/scan` — idempotent ขึ้น
มี scan วิ่งอยู่ (จาก gate) → ตอบ `{ "state": "scanning", "projectId": "<pid>" }`
ทันที ไม่ build ซ้ำ; กรณีอื่นพฤติกรรม + broadcast (`scan.progress`/`scan.done`/
`brain.ready`) เดิมครบ.

## ขอบเขต v1
- `buildBrain` sync (~169ms บน repo 6GB) — "scanning" มีไว้กันงานเริ่มก่อน Brain
  พร้อม ไม่ใช่ progress bar ละเอียด.
- gate เฉพาะโปรเจค "ไม่เคย scan เลย"; post-work re-scan เดิมไม่เปลี่ยน
  (docs/project-brain.contract.md).
