# Per-Agent Live Status — Contract

Owner: Nueng (CEO order 2026-06-10). Backend: แบล็ค (`daemon/server.js`).
Frontend: น้องไวท์ (`daemon/overlay.html` — Hub-icon pills, ทำคู่ขนานใน t9).

เป้าหมาย: overlay รู้ว่า **แต่ละ agent กำลัง working หรือ idle และทำโปรเจคไหน** แบบ realtime.

## Payload row (ทั้ง endpoint และ ws ใช้ shape เดียวกัน)

```jsonc
{ "agentId": "แบล็ค",
  "status": "working",            // "working" | "idle"
  "project": "tookjorThai",       // ชื่อโปรเจค (display name ตามที่ Director route ด้วย @) | null
  "task": "แก้บั๊ก modal …" }     // คำสั่งแบบสั้น (ตัด 90 ตัวอักษร) | null
```

- `idle` ⇒ `project:null, task:null` เสมอ.
- `project` เป็น **ชื่อ** ไม่ใช่ canonical id — ตรงกับ pill "⚙ <project>" ของ overlay
  (run ภายในเก็บ id; backend map กลับเป็นชื่อตอน snapshot).

## Endpoints / events

- `GET /agents/status` → `{ agents: [row, …] }` **ครบทุก agent ใน registry**
  (รวม main/ceo). หมายเหตุ: ห่อใน `{agents:…}` ไม่ใช่ bare array — ให้ตรงกับ
  `loadAgentStatus()` ใน overlay.html ที่ parse `j.agents` (สัญญาฝั่ง White มาก่อน).
- ws `{type:"agent.status", agents:[…]}` — broadcast **เฉพาะตอนสถานะเปลี่ยนจริง**
  (dedup ด้วย JSON signature), ไม่ลง journal (live-only; overlay ข้าม replay อยู่แล้ว).
- client ที่เพิ่งต่อ ws ได้ snapshot ปัจจุบัน 1 ฉบับทันทีหลัง roster.sync
  (เพราะ event ไม่ replay จาก journal).

## กลไก (reuse ของเดิม — ไม่มี state ใหม่ซ้ำซ้อน)

- สถานะ derive จาก **`activeRuns`** (ตัวเดียวกับ Live Log) ผ่าน
  `agentStatusSnapshot()` — ครอบคลุมทุกชนิด run: DELEGATE, scheduled jobs,
  แชท CEO/Director, heartbeat. Ghost runs (`id#sN`) ถูก roll-up เข้า agent แม่.
- ช่องโหว่เดียวคือ DELEGATE มี hand-over walk 4.5s ก่อน `runClaude()` →
  เพิ่ม `pendingDelegate` map: ตั้งตอน parse บรรทัด `DELEGATE:` (best-effort
  project จาก `@ ชื่อ`), เคลียร์เมื่อ run จริงเริ่ม (activityStart) /
  ถูกปฏิเสธเพราะเจ้าของเปิดโปรเจคอยู่ (projWin lock) / เกิน TTL 30s.
- จุด broadcast: `activityStart`, `activityEnd`, ตั้ง/เคลียร์ `pendingDelegate`.

## Live Log v2 — slots + timers + watchdog (2026-06-11, มิสเตอร์ N)

ws `{type:"activity.update", running:[row,…]}` — shape เดิมทุกฟิลด์ + **ฟิลด์ใหม่ต่อ row** (additive เท่านั้น):

```jsonc
{ "agent": "แบล็ค", "task": "...", "name": "แบล็ค", "label": "...", "project": "...",
  "startedAt": 1760000000000, "lastTool": "Bash", "lastAt": 1760000000000,
  // ---- ใหม่ (White render ใน chat feed เป็น "Claude Live N") ----
  "slot": 1,                      // ลำดับ run ที่รันพร้อมกัน เรียงตาม startedAt (1..N ไม่จำกัด)
  "live": "Claude Live 1",        // ป้ายพร้อมใช้ ไม่ต้องประกอบเอง
  "elapsedMs": 125000,            // now - startedAt (เวลาเดินจริง — re-broadcast ทุก tick ~5s)
  "lastToolAgo": 4200,            // now - lastAt
  "state": "working" }            // "working" | "stuck" (เงียบเกิน OEP_STUCK_MS, default 120s)
```

- ticker re-broadcast `activity.update` ทุก ~5s (`OEP_LIVE_TICK_MS`) ระหว่างมี run ใดๆ รันอยู่ —
  เวลาจึงเดินบนจอโดย client ไม่ต้องคำนวณเอง
- watchdog: run เงียบเกิน threshold → `state:"stuck"` + ยิงบรรทัดเตือนเข้า chat **ครั้งเดียวต่อช่วงเงียบ**:
  ws `{type:"chat.message", agent, task, watchdog:true, live:"Claude Live N", slot, state:"stuck",
  text:"⚠️ Claude Live N (<ชื่อ>) อาจค้าง — เงียบ Xs (งาน: …)"}` — มี tool ใหม่เข้ามา = ต่อเวลา/กลับ working
  อัตโนมัติ และ watchdog re-arm; **ไม่ฆ่า run อัตโนมัติเด็ดขาด**
- `agent.status` shape เดิมไม่ถูกแตะ

### ฝั่ง overlay (ไวท์ wire แล้ว 2026-06-11 — BUILD 2026-06-11 #9)

- render เป็นบรรทัด `💻 Claude Live N · <name> · ⚙ <project> · <label> · ⏱ mm:ss`
  ใน `#liveStrip` (โหมดปกติ ใต้ nowStrip) + `#feedLive` (feedmode), เรียงตาม `slot`.
- ทุก `activity.update` ที่มี `running[]` = full snapshot ⇒ **replace ทั้งชุด**
  (run หายจาก array = บรรทัดหาย, array ว่าง = แผงปิด). replay ถูกข้าม.
- ⏱ tick ฝั่ง client ทุก 1s จาก `startedAt` (fallback `now-elapsedMs`) —
  ระหว่างรอ re-broadcast 5s ของ BE เวลาเดินลื่นไม่กระตุก.
- `state:"stuck"` ⇒ โทนส้มแดง + ป้าย "⚠️ อาจค้าง · เงียบ Xs" (อายุ `lastToolAgo`
  ต่อเองจากเวลารับ snapshot). FE มี fallback ฝั่ง client: เงียบเกิน 120s
  (mirror ค่า default `OEP_STUCK_MS`) ก็ flip เองแม้ BE ยังไม่ส่ง stuck.
- กันค้างถาวร: row ที่ไม่ถูก refresh เกิน 2 นาที (socket/daemon ตาย) ถูกถอดทิ้ง.
- ฟิลด์ v2 ทั้งหมด optional ฝั่ง FE — ขาด `slot`/`live` ประกอบเอง 1..N,
  ขาด `elapsedMs`/`startedAt` นับจากเห็นครั้งแรก, ขาด `state` ถือว่า working.
- FE test: `tools/claude-live-e2e.js` (vm-DOM + fake clock, 29 เคส) — ครอบ render
  N slots / timer เดิน / flip stuck / snapshot replace / degrade / replay+garbage.

## ทดสอบ (ผ่านแล้ว 2026-06-10)

- `tools/agent-status-backend-e2e.js` — sandbox daemon (พอร์ตแยก + stub `claude`
  ไม่เผา token): ครอบ shape/coverage, flip → working ตอน dispatch (ก่อน 4.5s),
  project=ชื่อจริง ระหว่าง run, กลับ idle หลังจบ, ws ยิงทุก flip + snapshot ตอน
  connect — 12/12 PASS. บน live รันแบบ read-only ได้ (ไม่สร้าง state).
- Frontend: `tools/agent-status-e2e.js` (ของ White — vm-DOM ทดสอบ pill rendering).
