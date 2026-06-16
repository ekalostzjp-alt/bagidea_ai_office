# Review Gate — Manual CEO Decision (FE→BE handoff)

Owner of this note: น้องไวท์ (frontend). Backend ที่ต้องเสียบ: แบล็ค (`daemon/server.js`).
สถานะ: **FE พร้อมแล้ว (overlay BUILD 2026-06-12 #14) — รอ backend route**.

เสริมจาก `docs/codex-review-gate.contract.md`. Codex ยังเป็นกรรมการกลางเหมือนเดิม
(neutrality ไม่เปลี่ยน) — อันนี้คือ **ปุ่ม override ของ CEO** ที่ CEO สั่งเพิ่ม:
อนุมัติให้ผ่าน หรือ ปฏิเสธเพื่อตีกลับ จากการ์ด review บน overlay โดยตรง.

## 1. Endpoint ที่ FE ยิง (ขอให้แบล็คเปิด)

```
POST /review/decision        (header x-bagidea-ui: 1)
body = {
  reviewId: "rv…",           // จาก review.result.reviewId (อาจว่างถ้า escalate เก่า)
  agentId:  "มิสเตอร์-n",     // เจ้าของงานที่ถูกรีวิว
  project:  "tookjorThai",    // ชื่อโปรเจค
  round:    2,                // รอบรีวิวล่าสุด (จาก review.result.round)
  decision: "approve" | "reject"
}
```

พฤติกรรม FE ตาม HTTP status:
- `2xx` → ถือว่าสำเร็จ, ปิดการ์ด, ขึ้น chip; UI สุดท้ายรอจาก ws (ข้อ 2).
- `404` → FE ขึ้นโน้ต "backend ยังไม่เปิด (404)" + เปิดปุ่มให้กดใหม่ (degrade ปลอดภัย).
- status อื่น/เชื่อมต่อไม่ได้ → โน้ต error + retry ได้.

## 2. WS broadcast ที่ FE ฟัง (ขอให้ broadcast หลังบันทึกผล)

```jsonc
{ "type":"review.decision", "reviewId":"rv…", "agentId":"มิสเตอร์-n",
  "project":"tookjorThai", "decision":"approve"|"reject", "by":"CEO", "ts": <epoch ms> }
```

- FE: เจอ event นี้ (ข้าม `replay`) → ปิดการ์ดที่เปิดอยู่ + ขึ้น chip/log ผล.
  จึง sync ข้ามทุกหน้าต่าง (กดจากเครื่องเดียว เด้งปิดทุกจอ).
- ฝั่ง flow ของแบล็ค (ตาม contract เดิม): `approve` → ปล่อยงานผ่าน/เคลียร์ bounce+escalate;
  `reject` → สร้าง bounce job กลับไป `agentId` พร้อมเหตุผล "CEO ปฏิเสธ" (+round).

## 3. จุดเชื่อมฝั่ง FE (อ้างอิงโค้ด)
- ปุ่ม + `reviewDecision()` อยู่ใน `daemon/overlay.html` (openReviewModal → `.rvact .btnrow`).
- handler `review.decision` อยู่ใน `route()` ถัดจาก `review.result`.
- e2e: `tools/review-gate-decision-e2e.js` (18 เคส ผ่าน) — ครอบ render ปุ่ม / payload POST /
  degrade 404 / ปิดการ์ดด้วย ws.
