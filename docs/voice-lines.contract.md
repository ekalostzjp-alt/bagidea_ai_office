# Voice Lines — Contract (dialogue engine: งานเสร็จ + ambient + interaction)

Owner: team lead (Nueng), สเปคจาก Director + CEO. Backend: Black (`daemon/server.js`). Frontend: White (`daemon/overlay.html`).

เป้าหมาย: ทุกคำพูดนอกเนื้องานของ agent ต้องเป็น **ภาษาไทยธรรมชาติ ตรงคาแรกเตอร์** ครอบคลุม 3 ชนิด:
1. **done lines** — ประโยคแจ้งงานเสร็จ (ของเดิม)
2. **ambient lines** — บทพึมพำ/คุยเล่นตอนว่าง **ราย agent** (แทน pool กลาง EN/TH เดิม — ห้ามเหลืออังกฤษลอย)
3. **interaction scenes** — บทโต้ตอบจริงตามบริบท เวลา agent คุยกันเอง หรือกับสิ่งของ/หมา/แมว

ทั้งหมดแต่งด้วย **gpt-4o-mini** แบบ batch ลงคลัง (cache) เรียก API เฉพาะตอนเติมคลัง ไม่ใช่ทุก tick; มี fallback template ไทยเสมอถ้า OpenAI ล่ม.

## 1. Trigger + flow
เมื่อ agent ทำงานเสร็จ (`task.completed` / `job` done สำเร็จ):
1. หยิบประโยคแจ้งเสร็จให้ agent นั้น — เลือกจาก **คลังราย agent** (`daemon/voice-lines.json`) ที่ยังไม่เพิ่งใช้.
2. **broadcast**:
   - `{ type:"voice.say", agentId, text, voice? }` — (มี `voice.say` ใช้อยู่แล้วในระบบ + agent มี field `voice`) → overlay/TTS พูด.
   - `{ type:"agent.done", agentId, text }` — สำหรับ feed/log.
3. บันทึก text ลงประวัติ "N ล่าสุด" (กันพูดซ้ำ).

## 2. คลัง dialogue + เรียนรู้เอง
- `daemon/voice-lines.json`:
  ```jsonc
  {
    "<agentId>": {
      "bank":["ประโยคแจ้งเสร็จ…"], "recent":["ที่เพิ่งใช้ (เก็บ N≈20)"],
      "ambient": { "bank":["บทพึมพำราย agent…"], "recent":[…] }
    },
    "@scenes": {            // cache บทโต้ตอบ ราย (บริบท::ผู้ร่วมฉาก เรียง id)
      "<ctxId>::<idA>+<idB>": { "bank":[[{"who":"<agentId>","text":"…"}, …], …],
                                "recent":["text บรรทัดแรกของฉากที่เพิ่งเล่น"] }
    }
  }
  ```
- เลือกประโยค/ฉาก: สุ่มจาก `bank` ที่ไม่อยู่ใน `recent` (ห้ามซ้ำตัวล่าสุดเสมอ). ใช้แล้ว push เข้า `recent` (ตัดให้เหลือ N; ฉาก N≈6).
- **self-learning refill**: ถ้า bank เหลือ "ใหม่" ต่ำกว่า threshold (done <3, ambient <4, scene <2) → เรียก **gpt-4o-mini** สร้างชุดใหม่ (done 10 / ambient 14 ประโยค / scene 3 ฉาก) ตาม **persona/role/voice** ของ agent → เติมเข้า `bank` (dedupe, cap: done 60 / ambient 40 / scene 12). ทำแบบ async ไม่บล็อกการพูดรอบปัจจุบัน.
- ครั้งแรกที่ยังไม่มี bank → gpt-4o-mini gen ชุดเริ่มต้นทันที (lazy init); ระหว่างรอใช้ fallback ไทย.
- **คุม cost (token forensics)**: gpt-4o-mini ถูกเรียกผ่านช่องเดียว (`refillPool`) เท่านั้น มี in-flight guard (คีย์ละ 1 call) + cooldown 10 นาทีต่อคีย์หลังพยายามแต่ละครั้ง — tick ปกติไม่แตะ API เลย.
- **sanitize on load**: โหลดไฟล์แล้วตัดทิ้งทันที — บรรทัดที่ไม่มีอักษรไทย (อังกฤษลอย), มี U+FFFD (ตัวอักษรพัง), และ key ของ agent ที่ไม่มีใน registry (`@scenes` ยกเว้น).

## 2.1 Ambient lines (บทพึมพำตอนว่าง)
- `ambientTick` (~55s, โอกาส ~45%): หยิบประโยคจาก `ambient.bank` ของ agent ที่สุ่มได้ → broadcast `chat.message {social, ambient}` (+`voice.say` ถ้ามี voice และ TTS เปิด).
- **ห้ามมี pool อังกฤษ** — pool กลางตายตัวเหลือเพียง `AMBIENT_FALLBACK` ภาษาไทย (ใช้เมื่อ bank ยังว่าง/OpenAI ล่ม).
- ~1 ใน 3 ของ ambient beat จะกลายเป็น interaction scene แทน (ข้อ 2.2).

## 2.2 Interaction scenes (บทโต้ตอบจริงตามบริบท)
- บริบทใน `INTERACT_CONTEXTS`: เดี่ยว (แมวส้ม, หมาคอร์กี้, เครื่องชงกาแฟ, ต้นไม้) และคู่ (แคนทีน, โซฟา, สวน, ไวท์บอร์ด).
- gpt-4o-mini ได้รับ **persona เต็มของผู้ร่วมฉากจริง + คำอธิบายสถานการณ์** → เขียน 3 ฉาก ฉากละ 1-2 (เดี่ยว) / 3-4 (คู่) ประโยค เป็นคำพูดที่พูดออกมาแล้วธรรมชาติจริง ไม่ใช่ template ลอยๆ → cache ใน `@scenes` รายคู่ (บริบท, ผู้ร่วมฉาก) → เล่นซ้ำจาก cache ฟรี.
- จังหวะเล่น: `socialTick` ฝั่ง canned-banter เดิม + ~1/3 ของ ambient beat. คู่ broadcast เป็น `collab.started` → `chat.message` ทีละบรรทัด → `collab.ended` (เหมือน banter เดิม); เดี่ยวเป็น `chat.message {ambient}` (+`voice.say` บรรทัดแรกตามเงื่อนไข TTS).
- fallback ตอน cache ว่าง/OpenAI ล่ม: คู่ = `BANTER` (template ไทย), เดี่ยว = `SOLO_FALLBACK` รายบริบท — ระบบพูดได้เสมอ.

## 3. gpt-4o-mini invocation (แต่งประโยค)
- เรียก OpenAI `chat/completions` model `gpt-4o-mini` (ยืนยันแล้วว่า key ใช้ได้: rate-limit headers ตอบ 200) ด้วย prompt อิง: ชื่อ, role, persona, voice/โทน, ภาษาที่ตัวละครใช้ → ขอ "ประโยคแจ้งงานเสร็จสั้นๆ หลากหลาย ตามคาแรกเตอร์ ไม่ซ้ำแนว".
- ใช้ได้ 2 จังหวะ: (ก) แต่งสดต่อครั้ง (1 ประโยค) หรือ (ข) gen เป็นชุดเติมคลัง (แนะนำ ข เพื่อคุม cost — ไม่ยิง API ทุกครั้งที่งานเสร็จ).

## 4. Fallback (OpenAI ล่ม)
- ถ้า gpt-4o-mini ล่ม/timeout → ใช้ `bank` เดิม (ถ้ามี) หรือชุด **template กลาง** ราย-โทน เช่น "เสร็จแล้วครับ ✅" / "งานนี้เรียบร้อย!" — ระบบยังพูดได้เสมอ ไม่ค้าง ไม่ error.

## 5. Endpoints (เสริม, ให้ test/ปรับได้)
- `GET /voice/lines?agent=<id>` → `{ bank:[], recent:[], ambient:{bank,recent}, scenes:{<key>:{bank:n,recent:n}} }` ของ agent.
- `POST /voice/say` body `{ agentId }` → บังคับให้พูด 1 ประโยค (สำหรับ e2e/ทดสอบ) → broadcast เหมือน flow ปกติ, คืน `{ text }`.
- `POST /voice/ambient` body `{ agentId? }` (ไม่ส่ง = สุ่ม) → บังคับ ambient line 1 ประโยค → broadcast + คืน `{ agentId, text }`.
- `POST /voice/interact` body `{ agents?:[], ctx? }` → บังคับเล่น interaction scene → broadcast ตาม flow จริง + คืน `{ ctx, agents, lines:[{who,text}], source:"cache"|"fallback" }`.
- (จังหวะจริงคือ auto ตอน task.completed / ambientTick / socialTick; endpoints นี้ไว้เทสต์.)

## 6. Frontend (White)
- ฟัง `voice.say` (มีอยู่แล้ว) → ป้ายคำพูด/ฟอง + TTS ตาม `voice`.
- ฟัง `agent.done` → บรรทัด feed "✅ <ชื่อ>: <text>".

## 7. ทดสอบ (e2e — `tools/voice-lines-e2e.js`, รันกับ sandbox ของ staged server)
1. `POST /voice/say {agentId:<มีจริง>}` → ได้ `{text}` ไม่ว่าง **เป็นไทย** + broadcast `voice.say` + `agent.done` (เช็คผ่าน WS).
2. เรียกซ้ำหลายครั้ง → ข้อความ **ไม่ซ้ำติดกัน** (ใช้ recent กัน); หลังเกิน threshold → `bank` ของ agent โตขึ้น (refill ทำงาน) — เช็คผ่าน `GET /voice/lines`.
3. `POST /voice/ambient` ซ้ำหลายครั้ง → ทุกประโยคเป็นไทย ไม่ซ้ำติดกัน; `ambient.bank` โตขึ้นเมื่อ refill ทำงาน.
4. `POST /voice/interact` → ได้ฉากที่ `who` เป็นผู้ร่วมฉากจริง ทุกบรรทัดเป็นไทย; เรียกซ้ำบริบท/คู่เดิม → `source:"cache"` (ไม่ยิง API ใหม่).
5. จำลอง OpenAI ล่ม (boot โดยไม่มี key) → say/ambient/interact ยังคืนบทไทย (fallback), ไม่ error.

## 8. ความเสี่ยง
- คุม cost: อย่ายิง gpt-4o-mini ทุกครั้งงานเสร็จ — ใช้คลัง + เติมเป็นชุดเมื่อจวนซ้ำ (gpt-4o-mini ถูกอยู่แล้วแต่ปริมาณงานเสร็จเยอะได้).
- กันสแปม: ถ้า agent งานเสร็จรัวๆ → throttle การพูด (เช่น เว้นขั้นต่ำต่อ agent).
- ภาษา/โทน: prompt ต้องล็อกให้ตรงคาแรกเตอร์ (เด็ก/สุภาพ/ห้าว) ไม่หลุดเป็นกลางๆ.
- OpenAI ล่ม = ต้องมี fallback เสมอ (ข้อ 4) — ห้ามทำให้ flow งานเสร็จพัง.
