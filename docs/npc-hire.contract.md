# NPC Hire — Contract ("ตัวละครขอลูกน้องเพิ่ม")

Owner: team lead (Nueng), สเปคจาก Director. Backend: Black (`daemon/server.js`). Frontend: White (`daemon/overlay.html`).

เป้าหมาย: ตัวละครในออฟฟิศ "ขอลูกน้องเพิ่ม" ได้ — ระบบ draft NPC **รายละเอียดครบเท่า agent ที่กดสร้างเองใน editor** (prompt + persona 4 ช่อง + skills/tools จาก catalog จริง + aura/voice/model + avatar) เป็น **proposal** ให้ CEO อนุมัติผ่าน Modal; อนุมัติแล้วเข้า roster ใช้ delegate ได้จริง.

หลักการใหญ่ 2 ข้อ:
1. **Explicit only** — ใบเสนอเกิดได้เฉพาะคำขอ explicit (จาก UI หรือ Director ที่ relay คำสั่งผู้ใช้จริง) ห้าม auto-spawn จากรอบเวลา/สคริปต์/การทดสอบ.
2. **Pending ≠ ตัวจริง** — proposal อยู่แค่ใน `daemon/npc-proposals.json` **ห้ามเข้า `reg.agents` และห้าม render เป็นตัวละครบนฉาก** จนกว่า `/npc/decision approved:true`.

## 1. Endpoints

### `POST /npc/request`  body `{ requesterId, role, reason, benefit?, explicit? }`
- validate: `requesterId` ต้องอยู่ใน roster; `role`, `reason` ไม่ว่าง.
- **explicit guard (กัน auto-spawn ใบขยะ):** จะสังเคราะห์ proposal ก็ต่อเมื่อคำขอเป็น
  explicit เท่านั้น — มี header `x-bagidea-ui: 1` (ยิงจาก UI ของ CEO) **หรือ**
  body `explicit:true` (Director ส่งต่อคำสั่งจริงของผู้ใช้) **และ** ผ่าน quality guard
  (`role` ≥ 2 ตัวอักษร, `reason` ≥ 10 ตัวอักษร — กัน `role:"x"` แบบที่เคยหลุด).
  - คำขอที่ไม่ explicit / ไม่ผ่าน quality → **ไม่สร้าง proposal**: ตอบ
    `202 { ok:false, created:false, hint }` + broadcast `chat.message` (social)
    บอกความต้องการแทน — smoke test / automation หลงมาจะไม่ทิ้งใบค้างให้ CEO.
  - กันใบซ้ำ: requester เดิม + role เดิม (case-insensitive) ที่ยัง pending → `409`.
- caps: pending ≥ 5 → `429`; roster เต็ม (`MAX_STAFF`, ไม่นับ CEO) → `409`.
- **generator** — reuse **Persona Copilot ตัวเดียวกับปุ่ม ✨ Draft ใน agent editor**
  (`draftAgentPersona()` หลังบ้านเดียวกับ `/assist/prompt`; รันบน claude `LIGHT_MODEL`
  ตาม cost rule; มี template fallback ทุก field ถ้า draft ล่ม — ใบเสนอต้องไม่มี field ว่าง):
  1. **persona เต็มชุด** — `name` (โมเดลตั้งชื่อเล่นเอง), `prompt` (ตัวตน+ภารกิจ),
     `persona{expertise, personality, language, rules}` (4 ช่องเดียวกับ editor), `why` (เหตุผลที่ควรจ้าง).
  2. **skills/tools ของจริงเท่านั้น** — `skills[]` กรองเหลือ id ที่มีใน office skill catalog
     (`reg.skills`); `tools[]` กรองจาก `BUILTIN_TOOLS` (ว่าง → fallback `["Read","Glob","Grep"]`).
  3. **cosmetics จากชุดจริงของ editor** — `aura` ∈ `"" | fire | ice | nature | arcane | shadow | gold`;
     `voice` ∈ `VOICE_PRESETS` ids (เลือก deterministic จาก hash ชื่อ+role — ไม่เรียกโมเดลเพิ่ม).
  4. **model** — งานเบา/ตอบเร็ว → `claude-haiku-4-5-20251001`; งานหนัก/ออกแบบ/วิจัย → `claude-sonnet-4-6`. (อิง catalog เดียวกับ Per-Agent Model)
  5. **avatar** — เรียก `POST /gen/image` → `avatarPath` (best-effort, timeout 60s; ล่ม → `""` ไม่ fail ใบ).
- **broadcast** `{ type:"npc.request", ...proposal }` (ให้ overlay เด้ง Modal ขออนุมัติ).
- ตอบ `200 { requestId, proposal }`.

#### Proposal schema (source of truth ที่ White render ใน Modal — field names ตรง registry agent เป๊ะ)
```jsonc
{
  "requestId": "npc<ts>",
  "requester": "<requesterId>",        // ใครขอ
  "name": "ชื่อเล่น",                   // ≤40
  "role": "ตำแหน่ง",                   // ≤40
  "prompt": "ตัวตน+ภารกิจ (system prompt)",          // ≤4000
  "persona": {                          // 4 ช่องเดียวกับ agent editor
    "expertise": "ความเชี่ยวชาญ/ขอบเขตงาน",         // ≤1500
    "personality": "บุคลิก/น้ำเสียง",                // ≤1500
    "language": "ไทย",                               // ≤80
    "rules": "กฎการทำงาน บรรทัดละข้อ"                // ≤1500
  },
  "tier": 3,                            // NPC เข้าเป็น Staff เสมอ
  "aura": "nature",                    // จากชุด AURAS ของ editor
  "voice": "buddy",                    // VOICE_PRESETS id
  "skills": ["code-review", "..."],    // office skill ids จริงเท่านั้น
  "tools": ["Read", "Grep", "..."],    // BUILTIN_TOOLS จริงเท่านั้น
  "model": "claude-haiku-4-5-20251001",
  "avatarPath": "/uploads/gen_….png",  // "" ได้ถ้า image ล่ม
  "why": "เหตุผลที่ควรจ้าง — ต้องชัด",   // ≤1000, ห้ามว่าง
  "benefit": "ประโยชน์ที่คาดหวัง",       // ≤500 (ตามที่ผู้ขอส่งมา)
  "ts": 1781060865924
}
```

### Governance — roster gate (regression fix หลัง merge v0.5.0, เคส "?????")
agent ที่ไม่เคยผ่าน `npc.request → /npc/decision approved:true` ต้อง**รัน/โผล่ในฉากไม่ได้**:
- `startClaudeRun` (choke point ของทุก dispatch: chat / delegate / jobs / plugins /
  runs-resume) ปฏิเสธ id ที่ base (`id.split("#")[0]`) ไม่อยู่ใน `reg.agents` —
  throw + broadcast เตือน; ไม่มี session / sprite event / usage row เกิดขึ้น.
- `POST /chat` เช็คซ้ำแบบ sync → `404` (ไม่ใช่คืน task id ตาย ๆ).
- `dispatchJob` เช็คก่อน spawn — job ของ agent ที่ถูกไล่ออก/ไม่เคยอนุมัติถูกปิด (`done`)
  พร้อมแจ้งในแชท ไม่ใช่รันต่อ.
- `POST /registry/agent` **สร้าง id ใหม่**ได้เฉพาะ request ที่มี header `x-bagidea-ui: 1`
  (หน้า editor ของ CEO เท่านั้น) — ทางอื่น `403` ชี้ไปที่ npc.request flow;
  การ**แก้ไข** agent ที่มีอยู่แล้วไม่ถูกกระทบ.

### `POST /npc/decision`  body `{ requestId, approved:boolean }`
- `approved=true` → **ลงทะเบียน NPC เข้า roster จริง** (จุดเดียวที่ proposal กลายเป็นตัวละคร):
  - เพิ่ม `reg.agents[<newId>] = { name, role, avatar(1-12 จาก hash), aura, prompt, persona{…}, tier:3, voice, skills, tools, avatarPath? }` — ครบเท่า agent ที่สร้างมือ; aura/voice ถูก validate กับชุด valid อีกชั้นก่อนลง; persist `registry.json`.
  - `newId` = slug จากชื่อ (กันชนกับ id เดิม).
  - ผูก model ผ่านระบบ Per-Agent Model: `modelSettings.perAgent[newId]=model` + broadcast `models.changed`.
  - `pushRoster()` → ทุก client เห็น NPC ใหม่ **ตอนนี้เท่านั้น**; **Director delegate ไปได้จริง** (runClaude รับ agent นี้ได้).
  - broadcast `{ type:"npc.created", agentId, name, role, avatarPath }`.
  - (ใบ legacy ก่อน schema นี้ที่ `persona` เป็น string → map เข้า `prompt` ให้อัตโนมัติ ยัง approve ได้.)
- `approved=false` → ทิ้ง proposal (ลบจาก pending), broadcast `{ type:"npc.rejected", requestId }`.
- **ออฟฟิศเต็มตอน approve → `409` และ proposal ต้อง "ยังค้างใน pending"** (เช็ค
  `staffCount()` ก่อน consume ใบ) — คำอนุมัติของ CEO ห้ามหายเงียบ; Modal ดึงใบเดิม
  กลับมาจาก `GET /npc/proposals` แล้ว approve ซ้ำได้เมื่อมีที่ว่าง.
- ลบ proposal ออกจาก pending เมื่อ reject หรือ approve สำเร็จเท่านั้น.

### `GET /npc/proposals` → `{ proposals:[<pending>] }` (ให้ Modal โหลดซ้ำได้).

## 2. Frontend (White)
- ฟัง `npc.request` → เด้ง **Modal อนุมัติ** render จาก schema ด้านบน: avatar (`avatarPath`), `name`, `role`, `prompt`, `persona.expertise / personality / language / rules`, `skills`, `tools`, `aura`, `voice`, `model`, **`why` + `benefit` (ต้องชัด)**; ปุ่ม ✅ อนุมัติ / ✕ ไม่อนุมัติ → `POST /npc/decision`.
- ⚠ **breaking change จาก schema เก่า:** `persona` เปลี่ยนจาก string → object และเพิ่ม `prompt` / `aura` / `voice` / `tier` — Modal เดิมที่ render `persona` ตรงๆ ต้องอัปเดตพร้อมรอบ deploy นี้.
- ฟัง `npc.created` → เติม NPC เข้า roster UI (โต๊ะ/การ์ดทีม); `npc.rejected` → ปิดการ์ด.
- **ห้าม** render pending proposal เป็นตัวละคร/โต๊ะบนฉาก — ฉากอิงข้อมูล roster (`pushRoster`) เท่านั้น.

## 3. Storage
- `daemon/npc-proposals.json` = pending proposals เท่านั้น (ไม่ใช่ roster).
- approved → เขียนลง `registry.json` (`reg.agents`) + `model-settings.json` (perAgent).
- avatar = ไฟล์จาก `/gen/image` (path ที่ระบบคืนมา).

## 4. ทดสอบ (e2e — `tools/npc-hire-e2e.js` รันกับ sandbox แยก state)
0. **guard:** `POST /npc/request {requesterId:<มีจริง>, role:"x", reason:"test"}`
   (ไม่มี `explicit`/header UI) → `202 {created:false}` + ไม่มี proposal เพิ่มใน
   `GET /npc/proposals`; ยิงซ้ำแบบ `explicit:true` แต่ role/reason สั้นเกิน → `202` เช่นกัน.
1. `POST /npc/request {requesterId:<มีจริง>, role:"QA", reason:"งานเทสต์เยอะช่วงนี้", explicit:true}`
   (หรือยิงพร้อม header `x-bagidea-ui: 1`) → `200` + proposal **ครบทุก field ตาม schema**
   (prompt ≥ 30 ตัวอักษร, persona 4 ช่องไม่ว่าง, aura/voice/model จากชุด valid, why ไม่ว่าง) +
   broadcast `npc.request`; ยิงซ้ำ requester+role เดิม → `409`.
2. **gating:** หลังข้อ 1 — `GET /registry` ต้อง**ไม่มี** agent ใหม่ (จำนวนเท่าเดิม) จนกว่าจะ decision.
3. `POST /npc/decision {requestId, approved:true}` → `GET /registry` มี agent ใหม่ครบ field
   (prompt + persona object + aura/voice/tier 3 + skills/tools) + broadcast `npc.created`; ลองสั่งงาน agent ใหม่ได้ (delegate-able).
4. `approved:false` → proposal หาย, ไม่เข้า roster.
5. ปิดท้าย: ลบ NPC ทดสอบออกจาก roster (cleanup ให้ไม่รก) — e2e ต้องคืนสภาพ + ไม่ทิ้ง process ค้าง.
6. **governance (อยู่ใน `tools/npc-guard-e2e.js` G1-G4):** `/chat` ด้วย agent id
   ที่ไม่อยู่ใน roster → `404` + ไม่มี session เกิด; `POST /registry/agent` สร้าง id ใหม่
   โดยไม่มี header UI → `403` + registry ไม่เปลี่ยน (มี header → `200` ตามเดิม,
   อัปเดต agent เดิมไม่กระทบ); approve ตอนออฟฟิศเต็ม → `409` + ใบยังอยู่ใน
   `/npc/proposals` แล้ว approve ใบเดิมซ้ำได้เมื่อมีที่ว่าง; agent ที่เพิ่งอนุมัติ
   ต้องสั่งงานผ่าน `/chat` ได้จริง.

## 5. ความเสี่ยง
- generator พึ่ง claude CLI + gen/image → ช้า/อาจล่ม: template fallback ทุก field + ข้าม avatar ได้ — ไม่ปล่อยให้ค้าง และไม่ส่งใบ field ว่างให้ CEO.
- กันสร้าง NPC มั่ว/เกินจำเป็น: explicit guard + quality guard + dedupe + จำกัด pending 5 ใบ + ต้องผ่าน CEO เท่านั้น (why+benefit ชัด).
- id ชนกัน: ต้อง slug + กันซ้ำกับ roster เดิม.
- token cost: draft ใช้ claude `LIGHT_MODEL` (haiku) ครั้งเดียวต่อ request ตาม cost rule (เลิกพึ่ง OpenAI ในเส้นนี้); NPC ที่จ้างแล้วถ้างานเบาให้ใช้ haiku คุม cost.
