# Per-Agent Model Settings — Contract

Owner: team lead (Nueng). Backend: Black (`daemon/server.js`). Frontend: White (`daemon/overlay.html`).
อ้างอิงสถานะปัจจุบัน: `per-agent-model-settings.audit.md`.

เป้าหมาย: ให้ตั้งได้ว่าแต่ละ agent ใช้ Claude model อะไร มี default กลาง และ agent ที่ไม่ตั้งให้ inherit default.

## 1. Models ที่รองรับ (ตายตัว)

| id | label | tier | costHint |
|---|---|---|---|
| `claude-opus-4-8` | Opus 4.8 | flagship | สูงมาก — งานยาก/ลึก |
| `claude-sonnet-4-6` | Sonnet 4.6 | balanced | กลาง — งานทั่วไป (แนะนำเป็น default) |
| `claude-haiku-4-5-20251001` | Haiku 4.5 | fast | ต่ำ — งานเบา/เร็ว |
| `claude-fable-5` | Fable 5 | max | สูงสุด — งานยาวสุด, กินลิมิต ~2× ของ Opus |

`available[]` ใน GET ต้องคืน 4 ตัวนี้ตามนี้ (id/label/tier/costHint).
> หมายเหตุ id: Opus/Sonnet/Fable ใช้ id สั้นได้ แต่ **Haiku id ที่ `claude --model` รับจริงคือแบบลงวันที่ `claude-haiku-4-5-20251001`** — catalog จาก GET คือ source of truth, FE/เทสต์ให้ดึง id จาก `available[]` ไม่ hardcode.

## 2. Endpoints

### `GET /settings/models`
```jsonc
{
  "default": "claude-sonnet-4-6",            // model กลาง (string). null = ใช้ CLI default (ไม่ pin)
  "available": [ {"id","label","tier","costHint"}, … ],   // 4 ตัวข้างบน
  "perAgent": { "แบล็ค": "claude-haiku-4-5", "main": null, … },  // null/ไม่มี key = inherit default
  "ts": 1781060000000
}
```
- `perAgent` คืน "ทุก agent ที่ spawn ได้" (ข้าม `ceo`) โดยค่าที่ไม่ถูกตั้ง = `null`.

### `POST /settings/models`
- body: `{ "default"?: modelId|null, "perAgent"?: { "<agentId>": modelId|null } }` (ส่งมาเฉพาะที่จะแก้ก็ได้ — partial update).
- validate: ทุก modelId ต้องอยู่ใน 4 ตัวที่รองรับ (หรือ `null`); agentId ต้องมีใน roster และ ≠ `ceo`. ผิด → `400`.
- persist: เขียนลง `registry.json` → `reg.defaultModel` และ `reg.agents[id].model`.
- apply: มีผลกับ **run ถัดไป** ทันที (resolve ตอน spawn — ดูข้อ 3). ไม่ตัด run ที่กำลังรันอยู่.
- broadcast event `settings.models` (ดูข้อ 4) เพื่อให้ overlay refresh สด.
- ตอบ `200` ด้วย state ใหม่ (รูปแบบเดียวกับ GET).

## 3. กติกา resolve (ฝั่ง spawn — Black)

```
resolveModel(agentId) =
  reg.agents[agentId]?.model            // ตั้งราย agent
  ?? reg.defaultModel                   // default กลาง
  ?? null                               // ไม่ pin → ไม่ใส่ --model (Claude Code CLI default)
```

จุดแก้ใน `daemon/server.js` (อ้าง audit):
- `runClaude()` ~บรรทัด 1024: หลังสร้าง `args` → `const m = resolveModel(agent); if (m) args.push("--model", m);`
- `runSub()` ~บรรทัด 1445: ghost ใช้ model ของ **agent แม่** → push `--model` แบบเดียวกัน.

## 4. WS event (refresh สด)

```jsonc
{ "type": "models.changed", "default": "...", "perAgent": { … } }   // journaled=false (ไม่ replay)
```
(ชื่อ event ที่ BE ส่งจริงคือ `models.changed`.) overlay ควรฟังใน `route(ev)` → refresh panel.
ปัจจุบัน FE โหลดค่าใหม่ทุกครั้งที่เปิด panel อยู่แล้ว; การ wire ฟัง `models.changed` เพื่อ refresh สดข้ามไคลเอนต์เป็น follow-up เล็กๆ (ไม่บล็อก deploy).

## 5. พิสูจน์ว่า "spawn ใช้ model นั้นจริง"

โค้ด BE (verified): `runClaude()` ทำ `const m = resolveModel(agent); if (m) args.push("--model", m);` (และ `runSub()` สำหรับ ghost). resolve = perAgent → default → null.

วิธีพิสูจน์ runtime (ไม่พึ่งการเดา):
1. e2e ยืนยัน **resolution** ผ่าน round-trip GET/POST (ค่าที่ resolve คือค่าที่ป้อน `--model`).
2. ตอน integrate verify: ตั้ง agent หนึ่งเป็น Haiku → ยิง run สั้นๆ → อ่านไฟล์ session ของ Claude Code (`~/.claude/projects/<cwd-as-dashes>/<sid>.jsonl`) ฟิลด์ `model` = ต้องเป็น `claude-haiku-4-5-20251001` → คืนค่าเดิม.
(ทางเลือก follow-up: ให้ BE ใส่ `model` ลง event `task.started` เพื่อให้ FE/เทสต์อ่านตรงๆ — ปัจจุบันยังไม่ได้ใส่.)

## 6. Frontend (White)
- Panel ใน OFFICE OPS (แท็บใหม่ หรือใต้หน้าแก้ไข agent): dropdown เลือก model ต่อ agent + ช่องตั้ง default กลาง.
- โหลดจาก `GET /settings/models`, เซฟผ่าน `POST /settings/models`, อัปเดตสดจาก event `settings.models`.
- แสดง label + costHint ของแต่ละ model; ค่าที่ไม่ตั้ง = แสดง "ใช้ default (<label>)".

## 7. ทดสอบ
สคริปต์: `tools/model-settings-e2e.js` (zero-dependency).
```bash
node tools/model-settings-e2e.js [port]      # default 8787
```
ทดสอบ: snapshot ค่าเดิม → POST ตั้ง default + ราย agent → GET ยืนยัน round-trip + perAgent ครบทุก agent → คืนค่าเดิม.
การพิสูจน์ spawn ใช้ model จริง: ตอน integrate จะตั้ง agent หนึ่งเป็น haiku แล้วยิง run สั้นๆ อ่าน `task.started.model` ครั้งเดียว (ดูข้อ 5).
