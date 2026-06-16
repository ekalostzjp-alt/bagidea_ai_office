# Run Persistence (กันงานหายถาวร) — Contract

Owner: มิสเตอร์ N (backend, `daemon/server.js`). คู่กับตัวจับ "⚠️ อาจค้าง" ของ Live Log v2
(`docs/agent-live-status.contract.md`) ซึ่ง "ตรวจจับ" อย่างเดียว — contract นี้คือฝั่ง "กันหาย".

เป้าหมาย CEO: daemon ดับ/รีสตาร์ท/crash ระหว่างมีงานวิ่งอยู่ → งานต้อง **ไม่หายเงียบ**.
ทุก run ถูก mirror ลง disk ตั้งแต่เริ่ม พร้อมข้อมูลพอที่จะ "ทำต่อ" ได้ และตอน boot
งานที่ตายค้างจะถูกประกาศ + รอให้ผู้ใช้กดทำต่อหรือปิดเรื่อง.

## 1. ไฟล์: `daemon/runs.json` (schemaVersion 1)

```json
{ "schemaVersion": 1,
  "live":        { "<task>": Record },   // กำลังวิ่งใน daemon ตัวปัจจุบัน
  "interrupted": [ Record ],             // ตายค้างจาก daemon ตัวก่อน รอ resume/dismiss (cap 30)
  "history":     [ Record ] }            // จบแล้ว (done/failed/ended/resumed/dismissed/expired, cap 200)
```

Record (ครบพอ resume):
`runId` ("r<startedAt>-<task>" — unique ข้าม boot เพราะ task counter รีเซ็ต), `task`,
`agent`, `name`, `label`, `prompt` (cap 64k + `promptTruncated:true` ถ้าโดนตัด —
**เฉพาะ live/interrupted**; ลบทิ้งเมื่อเข้า history),
`session` (thread key ใน sessions.json → resume claude sid ได้ถ้ายังอยู่), `project` (id),
`cwd`, `model`, `pid`, `status`, `state` ("working"|"stuck"|"interrupted"),
`startedAt`, `lastTool`, `lastHeartbeat`, `stuckSince?`, `interruptedAt?`, `endedAt?`, `resumedAs?`,
`resumeChain?` (จำนวนรอบที่สาย run นี้ถูก recovery-dispatch มาแล้ว — นับต่อข้าม generation).

การเขียน: **atomic เสมอ** (เขียน `runs.json.tmp` แล้ว rename ทับ) — ไฟล์ไม่มีวันครึ่งๆ กลางๆ.
ขอบเหตุการณ์ (start/**result**/stuck/end/boot) flush ทันที; heartbeat จาก tool debounce 1s.
ตอน boot เก็บ `runs.json.bak` ไว้ rollback ก่อนแตะไฟล์.
Safety net พังต้องไม่เงียบ: เขียนไฟล์ fail (disk เต็ม/lock/สิทธิ์) → ประกาศ 🚨 ใน chat
ครั้งเดียวต่อ failure streak + โชว์ใน `GET /runs → persistenceError`, หายแล้วประกาศ ✅.

## 2. จุดเกี่ยว lifecycle (ใน server.js)

- `startClaudeRun` หลัง spawn → `persistRunStart` (startedAt ตรงกับแถว activeRuns เป๊ะ)
- `activityTool` → `persistRunTool` (lastTool/lastHeartbeat, state กลับ "working")
- watchdog ใน `liveTicker` ตอนปัก `_stuckWarned` → `persistRunStuck` —
  **state บน disk ตรงกับ badge ⚠️ บน overlay เสมอ** (ใช้ STUCK_AFTER_MS ตัวเดียวกัน)
- `result` จาก stream-json → `persistRunResult` (done/failed)
- `activityEnd` (close/error) → `persistRunEnd` → ย้ายเข้า history
- ghost runs (`runSub`) ไม่เข้า activeRuns อยู่แล้ว → ไม่ persist (parent ครอบงานอยู่)

## 3. Boot recovery — auto-resume (คำสั่ง CEO: restart แล้วงานต้องเดินต่อเอง)

ทุก record ที่ยังอยู่ใน `live` ตอน boot = ตายไปกับ daemon ตัวก่อน → **triage**
(`sweepRunsAtBoot`) แทนการกองเป็น "ค้าง" รอ human:

1. `status` เป็น `done`/`failed` อยู่แล้ว (result ลง disk แล้ว แค่ตายก่อน close
   event) → ปิดเข้า history ด้วยสถานะจริง (`endedAt` = lastHeartbeat) —
   เดิม record พวกนี้ถูกปลุกเป็น "interrupted" = งานค้างปลอมโผล่ทุกรีสตาร์ท.
2. ที่เหลือเข้า `interrupted` แล้ว triage ต่อ (รวมของตกค้างจาก boot ก่อนๆ ด้วย):
   - agent หายจาก roster หรือไม่เหลือ prompt/session → ปิดเป็น `failed`
   - `lastHeartbeat` เก่ากว่า `OEP_RESUME_MAX_AGE_MS` (default 24h) → `expired`
   - `resumeChain` ≥ `OEP_RESUME_MAX_CHAIN` (default 3) → **ค้างรอ CEO** —
     เบรกกัน crash-loop: run ที่พา daemon ล้มซ้ำๆ ห้ามวนเผาโทเคนเอง
   - ที่เหลือ → **auto-resume**: dispatch เดียวกับ POST /runs/resume
     (`dispatchRunRecovery`) ปล่อยทีละตัวห่าง 1.5s, archive เป็น "resumed"
     เมื่อ handoff สำเร็จ; fail → rollback กลับ interrupted + ประกาศ.

`resumeChain` ส่งต่อเข้า record ของ run ใหม่ (+1 ต่อ hop) — สายที่ตายซ้ำนับสะสม.
หลัง boot ~3s broadcast (ลง journal ทั้งคู่ → client ต่อทีหลังเห็นจาก replay):
- `{type:"runs.recovered", interrupted:[...]}` (ไม่มี prompt)
- `chat.message` จาก main ขึ้นต้น 🛟 สรุปผล triage รายตัว (✅ ปิด / 🔁 ต่ออัตโนมัติ /
  ⚠️ ค้างรอ CEO — แสดงวิธีสั่งต่อเฉพาะเมื่อมีตัวค้าง)
ปิด auto-resume ทั้งระบบได้ด้วย env `OEP_AUTO_RESUME=0` (escape hatch).

## 4. HTTP API

- `GET /runs` → `{live, interrupted, history(≤50), persistenceError}` —
  **human UI only (`x-bagidea-ui`)**: record มี cwd/session key/pid ไม่ใช่ของ agent;
  prompt ถูกตัดออกทุกตัว; `live[].state` คำนวณสดด้วย STUCK_AFTER_MS เดียวกับ overlay.
- `POST /runs/resume {"runId"}` — **human UI only (`x-bagidea-ui`)**, 404 ถ้าไม่พบ.
  ใช้ `dispatchRunRecovery` ตัวเดียวกับ boot auto-resume: ส่งงานกลับผ่าน
  `runClaude(agent, "<run-recovery>…คำสั่งเดิม…", {session, project, resumeChain+1})`
  (sid รอด → ต่อเนื่อง, sid หาย → prompt เดิมพากลับ; project binding heal เองใน startClaudeRun).
  คำสั่ง human **ข้าม chain/age cap ได้** (เป็นการตัดสินใจของเจ้าของเอง).
  record → history เป็น "resumed" + `resumedAs:<task ใหม่>`.
- `POST /runs/dismiss {"runId"}` — human UI only; → history เป็น "dismissed".

## 5. การทดสอบ

`node tools/runs-persistence-e2e.js [port=8799]` — boot sandbox daemon ของตัวเอง
(temp dir, stub claude, ไม่มี API key, ศูนย์โทเคน) จาก `daemon/server.staged.js`
(override ด้วย env `RUNS_E2E_SERVER`), ฆ่า daemon กลาง run แล้วพิสูจน์:
record ครบ field → stuck ลง disk → reboot แล้ว **auto-resume เองจนจบ**
(archive "resumed", recovery run "done", resumeChain:1, ไม่มีค้าง) →
boot triage ปิด done/failed/expired ครบทุก path + ค้างเฉพาะ chain-capped →
guard 403/404 → manual resume ข้าม cap (chain นับต่อ) → dismiss →
run ปกติเข้า history "done". เก็บกวาดโปรเซส+temp เองทั้งหมด.

Rollback หลัง deploy: `daemon/server.js.pre-runresume.bak` (รอบ auto-resume),
`daemon/server.js.pre-runpersist.bak` (รอบ persistence แรก).
