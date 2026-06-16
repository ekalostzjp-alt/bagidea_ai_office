# Review Decision (ปุ่มอนุมัติ) + Process Step Feed — Contract

Owner: CEO order 2026-06-12. Backend: แบล็ค (`daemon/server.js`, staged ใน `server.staged.js`).
Frontend: น้องไวท์ (`daemon/overlay.html`).

สองงานที่ CEO สั่ง: (1) แผงงานมีแค่ "กำลังทำ" แต่ไม่มี **ปุ่มอนุมัติ** → เพิ่ม route อนุมัติ/ปฏิเสธของคน.
(2) เห็นแค่สถานะ working แต่ไม่เห็น **Process จริง** → stream ขั้นตอน/บรรทัด log ของงานที่รันอยู่เป็น feed.

> สถานะ: staged + ผ่าน sandbox e2e ครบ (`tools/review-decision-feed-e2e.js`, 18/18 PASS, พอร์ตแยก 8799,
> stub claude, 0 token, ไม่แตะ state สด). รอ N deploy `server.staged.js` → `server.js` ตอน office ว่าง.

---

## 1. Manual Approve / Reject — ปุ่มอนุมัติของคน

Codex review-gate เดิม (auto) ให้ verdict ของ "กรรมการเครื่อง". **อันนี้คือ verdict ของคน** —
CEO/Director กดอนุมัติให้ผ่าน หรือ ตีกลับด้วยมือ (โดยเฉพาะงานที่ escalate ครบ 3 รอบ).

### `POST /review/decision`
Request body:
```jsonc
{ "agentId": "มิสเตอร์-n",     // ใครคืองานที่ตัดสิน (default "มิสเตอร์-n")
  "project": "bagidea",         // optional — id/path/ชื่อ ก็ได้ (resolve ภายใน)
  "decision": "approve" | "reject",   // บังคับ — อื่นนอกจากนี้ → 400
  "by": "CEO",                  // optional — คนตัดสิน (default "main")
  "note": "ผ่านครับ / แก้ตรง X", // optional — เหตุผล/หมายเหตุ (≤2000)
  "reviewId": "rv…" }           // optional — โยงกับการ์ด review.result ใบไหน
```
Response `200`:
```jsonc
{ "ok": true,
  "decision": { "decisionId":"dc…", "reviewId":"", "agentId":"มิสเตอร์-n",
    "project":"bagidea", "decision":"approve", "by":"CEO", "note":"ผ่านครับ",
    "round": 0, "ts": 1781… } }
```
Errors: `decision` ไม่ใช่ approve/reject → **400**. `reject` กับ agent ที่ไม่มีใน registry → **404**.

พฤติกรรม:
- **approve** → ยอมรับงาน: เคลียร์ `rounds[project|agent]=0` + ถอด deliverable ออกจาก passby pending. ไม่ bounce.
- **reject** → สร้าง job ตีกลับไปหา agent นั้นทันที (`dispatchJob`) พร้อม note. (เหมือน fail-bounce แต่คนสั่ง)
- ทั้งสองกรณี stamp `reviewState.last[agent].decision/decidedBy/decidedTs` + เก็บใน `decisions[]` (cap 100, newest-first) ใน `daemon/review-gate.json`.

### WS event (ฟังเพื่ออัปเดตสด — live-only, ไม่ replay)
```jsonc
{ "type": "review.decision", "decisionId":"dc…", "reviewId":"", "agentId":"มิสเตอร์-n",
  "project":"bagidea", "decision":"approve"|"reject", "by":"CEO", "note":"…", "round":0, "ts":… }
```
ตามด้วย `{type:"chat.message", agent:"main", text:"✅ อนุมัติงานของ … โดย CEO — …"}` (หรือ ❌ ตีกลับ).

### `GET /review/status` (เพิ่ม field)
เดิม + `"decisions": [ <record ล่าสุด 20 ใบ> ]`. ใช้ replay การ์ดตอน panel เพิ่งเปิด.

> FE: การ์ด review.result เดิมเพิ่ม 2 ปุ่ม [อนุมัติ]/[ตีกลับ] → POST /review/decision.
> ฟัง `review.decision` แล้วอัปเดตสถานะการ์ด (✅/❌ + ใครตัดสิน + note). โหลดประวัติจาก `GET /review/status`.decisions.

---

## 2. Process Step Feed — ขั้นตอนงานจริง ไม่ใช่แค่ "working"

เดิม overlay เห็นแค่ `agent.status` working/idle + `activity.update` (ชื่อ tool). เพิ่ม **รายละเอียดขั้นตอน**:
ทุก tool ที่ run เรียกใช้ จะมี `detail` ที่กลั่นจาก input — ไฟล์/คำสั่ง/pattern จริง.

### WS event ใหม่ (additive — `task.progress` เดิมไม่แตะ)
```jsonc
{ "type": "task.step", "agent":"แบล็ค", "task":"<taskId>", "seq": 42,
  "tool": "Edit", "detail": "server.js", "ts": 1781…, "session":"<sessKey>" }
```
- `seq` = running id ทั่วทั้งระบบ (de-dupe/เรียงลำดับ replay ได้).
- `detail` = กลั่นจาก tool input: Read/Write/Edit→ชื่อไฟล์ (basename), Bash/PowerShell→คำสั่ง (≤100),
  Grep/Glob→pattern, WebFetch→url, WebSearch→query, Task/Agent→description, Skill→ชื่อ skill. ไม่เข้าเคส→`""`.

### `activity.update` row — เพิ่ม `lastDetail` (additive)
row เดิมทุก field + `"lastDetail":"server.js"` → Live Log โชว์ "Edit · server.js" แทน "Edit" เปล่าๆ.

### `GET /process/feed` — snapshot สำหรับ panel ที่เพิ่งเปิด (replay)
```jsonc
{ "running": [ <activity row + lastDetail>, … ],         // = /activity
  "steps": { "<taskId>": [ {seq, tool, detail, ts}, … ] },// ring ≤50/งาน, RAM-only
  "lastSummary": { …work-summary.json.summary… } | null } // บริบทงานที่เพิ่งเสร็จ
```
`?task=<id>` กรอง steps เหลืองานเดียว. **steps เป็น RAM-only** — งานจบ → ring ถูกลบ (ไม่ leak),
panel ที่ต่อทีหลังเห็นเฉพาะงานที่ยังรัน. ต้องการประวัติงานเสร็จ ใช้ `lastSummary` / chat feed.

### `GET /run/steps?task=<id>` — steps ของงานเดียว
`{ "task":"…", "steps":[ {seq,tool,detail,ts}, … ] }`

> FE: subscribe `activity.update` (อ่าน `lastDetail`) + `task.step` (ต่อบรรทัด log ใต้แต่ละ Claude Live N).
> เปิด panel → `GET /process/feed` replay running+steps ก่อน. งานจบ → row หาย, ลบบรรทัดตามเดิม.

---

## 3. หมายเหตุ deploy (สำหรับ N)
- `server.staged.js` ถูก **rebuild จาก live `server.js`** (staged เก่า behind live 91 บรรทัด — brain-ctx/quota/restart-guard).
  staged ตอนนี้ = live + 2 ฟีเจอร์นี้เท่านั้น → deploy เป็น fast-forward สะอาด. staged เก่าเซฟไว้ที่ `server.staged.js.pre-reviewfeed.bak`.
- ของเดิมที่ไม่แตะ: Codex auto-gate, `task.progress`, `agent.status`, `activity.update` shape เดิม, work-summary.
- deploy ตอน `activeRuns` ว่างเท่านั้น (กฎ audit `task-report-pipeline`).
