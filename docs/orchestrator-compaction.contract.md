# Orchestrator Thread Compaction — Contract v2 (Rolling Summary + Postgres)

Owner: Nueng. Backend: Black (`daemon/server.js`). DB (`orch_context` + `db.*`): มิสเตอร์ N.
สถานะ: **v1 (sid-reset + carryover) ลง live แล้ว 2026-06-10** · **v2 (เอกสารนี้) = design พร้อมสั่ง implement รอบหน้า — ยังไม่แตะโค้ด**

เป้าหมาย: ฆ่าตัวเผา token อันดับ 1 (เธรด orchestration replay ทุกเทิร์น) **โดย context ไม่หาย แม้ daemon restart**.

> เลขบรรทัดทุกจุดในเอกสารนี้อ้าง **live `server.js` build 2026-06-10 11:22 (275,529 bytes)** — ตรวจด้วยชื่อ function ก่อนแก้เสมอ (บรรทัดเลื่อนได้ ชื่อไม่เลื่อน).

---

## 0. หลักฐาน + สิ่งที่ v1 ทำไปแล้ว

Forensics จาก transcript จริง: เธรด orchestration เดียว = **26.1M tokens**
(cache_creation 21.8M + output 4.1M, **2,720 เทิร์น**, opus).

v1 ที่ live แล้ว (อย่าทำซ้ำ):
- นับขนาดเธรด: `entry.turns/tokens` สะสมที่ result parse (**~1625–1633**, นับ input+output+cache_creation; ไม่นับ cache_read)
- เกณฑ์: `needsCompaction()` (**713–718**) — `MAX_TURNS=40 || MAX_TOKENS=150k`
- gate: ใน `startClaudeRun` (**1407–1419**) — summarize ครั้งเดียว (Haiku) → `entry.sid=null` → turns/tokens=0 → broadcast `thread.compacted`
- ฉีด `<context-carryover>` ใน preamble (**1470–1475**, consume แล้วลบ)
- `summarizeThread` (**725**) + `fallbackCarryover` (**719**) · `claudeText(prompt,{model})` (**412**, default Haiku)

ช่องโหว่ของ v1 ที่ v2 ต้องปิด:
1. **carryover อยู่ใน RAM/sessions.json เท่านั้น** — daemon restart กลางเธรด = summary หาย เริ่มจำศูนย์
2. **summarize เป็น one-shot ตอน compact** — อ่านแค่ `entry.log` 30 บรรทัดล่าสุด: เธรดที่ยาวจริง การตัดสินใจช่วงต้น (เทิร์น 1–10 จาก 40) หายไปจาก summary
3. **ระหว่าง 2 จุด compact ยัง replay เต็ม** — เทิร์น 1→39 ยัง resume ก้อนโตขึ้นเรื่อยๆ (แค่ถูก cap ที่ 40)

---

## 1. ตอน resume มัน replay อะไรบ้าง (anatomy ของการบวม)

การประกอบ prompt ต่อเทิร์นเกิดที่ `startClaudeRun` จุดเดียว:

```
1525:  child.stdin.write(preamble + prompt + capNotes + projectNote());
```

แยกเป็น 4 ก้อน + 1 ก้อนที่มองไม่เห็นจากโค้ดเรา:

| ก้อน | ส่งเมื่อไหร่ | ขนาด | สถานะ |
|---|---|---|---|
| **(ก) history ภายใน claude session** | ทุกเทิร์นที่มี `--resume` (gate ที่ **~1478** `if (entry && entry.sid) args.push("--resume", entry.sid)`) | **โตไม่จำกัด** — ไฟล์ `~/.claude/projects/<enc>/<sid>.jsonl` ทั้งก้อนถูก replay/re-cache ฝั่ง API ทุกเทิร์น (นี่คือ cache_creation 21.8M) | 🔴 ตัวการหลัก — **daemon ตัดแต่งไฟล์นี้ไม่ได้** ทางเดียวคือทิ้ง sid (v1) → v2 ทำให้การทิ้ง "ถูกและบ่อย" ได้เพราะมี rolling summary พร้อมเสมอ |
| (ข) `preamble` (persona+skills+memory) | เฉพาะ session ใหม่ (`isFresh`, **~1455–1469**) | 1–4k | ✅ ไม่บวม |
| (ค) `capNotes` (SUB_NOTE+VOICE_NOTE) | เฉพาะ fresh (**~1517–1523** `const capNotes = isFresh ? …`) | ~0.7k | ✅ แก้แล้ว |
| (ง) `projectNote()` (**1182**) | **ทุกเทิร์น** | ~0.4–1k (โตตามจำนวนโปรเจค/places/keys) | 🟡 จำเป็นต้องสด แต่ trim ได้ (ดู §5.7) |
| (จ) `directorNote()` (**1680**) ผ่าน caller: ceoFlow (**1727**), `/chat` main (**3260**) | ทุกเทิร์น orchestration ของ main | ~1.5–3k (teamList+places+projects+protocol) | 🟡 เป้า trim รอง (ดู §5.7) |

ข้อเท็จจริงสำคัญ: `entry.log` (cap 200 รายการ, **1428**) เป็นประวัติ **ฝั่งออฟฟิศไว้โชว์ UI เท่านั้น** — ไม่ใช่สิ่งที่ claude replay. ก้อนที่บวมจริงคือ (ก) ซึ่งอยู่นอกการควบคุมเรา ยกเว้นตัดวงจรด้วยการเปิด session ใหม่.

**สมการ v2**: ทำให้ "เปิด session ใหม่" ราคาถูกพอที่จะทำบ่อย (ทุก ~20 เทิร์น แทน 40) เพราะ context สำหรับ session ใหม่ถูกเตรียมไว้แล้วแบบ rolling — ไม่ต้องจ่าย summarize ก้อนใหญ่ตอน compact และไม่เสีย context ช่วงต้นเธรด.

---

## 2. กลยุทธ์ trim: เก็บอะไรเต็ม ยุบอะไร cadence เท่าไหร่

โครง context ของเธรด orchestration แบ่ง 3 ชั้น (tiered):

```
┌─────────────────────────────────────────────┐
│ HEAD  — โครงงานถาวร (ไม่ยุบ, อัปเดตแทนที่)        │  ≤ 600 tok
│   goal, decisions[], pending[], focusFiles[]  │
├─────────────────────────────────────────────┤
│ BODY  — rolling summary (ยุบสะสม)              │  ≤ 1,400 tok
│   เนื้อเรื่องเทิร์นเก่าทั้งหมด ย่อแบบ incremental      │
├─────────────────────────────────────────────┤
│ TAIL  — เทิร์นล่าสุด K=8 รายการ "เก็บเต็ม"         │  ≤ 2,000 tok
│   verbatim จาก entry.log (who/text, ตัด 500     │
│   chars/รายการ; รวมบรรทัด tool ด้วย)             │
└─────────────────────────────────────────────┘
รวม carryover ≤ ~4,000 tok ต่อการเปิด session ใหม่
```

กติกาเก็บเต็ม vs ยุบ:
- **เก็บเต็ม**: 8 เทิร์นล่าสุด (งานที่กำลังทำอยู่ — ห้ามเสียรายละเอียด), ทุก decision/บรรทัด `DELEGATE:`/`PROJECT:` (เป็น structure ใน HEAD ไม่ใช่ข้อความเต็ม), error/failure ล่าสุดของแต่ละ delegate
- **ยุบเป็น summary**: เทิร์นที่เก่ากว่า K, รายงาน sub-agent ที่ปิดงานแล้ว, ผล tool ระหว่างทาง, small talk
- **ทิ้งได้เลย** (ไม่ต้องเข้า summary): บรรทัด tool progress ซ้ำๆ, ข้อความ system ping, banter

Cadence (สองเงื่อนไข อันไหนถึงก่อนทำก่อน):
- **ทุก SUMMARIZE_EVERY = 10 เทิร์น** → อัปเดต rolling summary แบบ incremental
- **หรือ tokensSinceSummary > 50k** (เธรดที่เทิร์นหนักผิดปกติ)

Incremental summarize (Haiku, ~1 call ขนาดเล็กต่อ 10 เทิร์น):
```
input  = HEAD เดิม + BODY เดิม + เทิร์นใหม่ 10 รายการ (จาก entry.log)
output = HEAD ใหม่ (แทนที่) + BODY ใหม่ (≤1,400 tok)
```
ต้นทุน ≈ 4k in / 2k out บน Haiku ต่อ 10 เทิร์น — เทียบกับ replay 150k+/เทิร์นที่มันไปฆ่า = จิ๋ว.

เกณฑ์ compact (sid reset) ปรับจาก v1:
```
MAX_TURNS:  40 → 20      (ทำบ่อยขึ้นได้เพราะ carryover พร้อมเสมอ ราคา ~0)
MAX_TOKENS: 150_000 (คงเดิม — กันเทิร์นหนักผิดปกติ)
```
ตอน compact: **ไม่ต้อง summarize ใหม่** — ใช้ HEAD+BODY+TAIL ที่ rolling ไว้แล้วประกอบเป็น carryover ทันที (sync, ไม่มี LLM call ใน hot path → ตัด `await summarizeThread` ที่ทำให้ start ช้าออกได้ด้วย).

---

## 3. รูปแบบ rolling summary ลง Postgres (`orch_context` ของ N)

สมมติ interface ที่ N กำลังทำ (ปรับชื่อ field ได้ตอน N ส่งโมดูลจริง — Black เขียนเป็น adapter ชั้นบางไว้):

```js
// daemon/db.js (ของ N) — สัญญาที่ Black จะเรียก
await db.saveContext(threadKey, ctx)   // upsert by threadKey; ไม่ throw ขึ้น caller
const ctx = await db.loadContext(threadKey)   // null ถ้าไม่มี
```

`ctx` (JSON ก้อนเดียว — แนะนำคอลัมน์ JSONB + คอลัมน์ index แยก):

```jsonc
{
  "threadKey": "s1781051443562",      // = entry.key (PK ฝั่ง daemon)
  "agent": "main",
  "project": "p1781051476704" ,        // หรือ null
  "version": 7,                        // ++ ทุก save (optimistic, กัน write เก่าทับใหม่)
  "updatedAt": 1781070000000,

  "head": {                            // ≤600 tok — แทนที่ทั้งก้อนทุกรอบ summarize
    "goal": "ทำฟีเจอร์ X ของโปรเจค Y ให้เสร็จ",
    "decisions": ["ใช้ Postgres ไม่ใช่ SQLite", "UI รอ White"],
    "pending":   ["รอผลรีวิวจาก Codex", "deploy หลังเทสต์"],
    "focusFiles": ["daemon/server.js:1407", "docs/x.contract.md"]
  },
  "body": "rolling summary เนื้อเรื่องเทิร์นเก่า ≤1,400 tok …",
  "tail": [                            // 8 เทิร์นล่าสุด verbatim (ตัด 500 chars/รายการ)
    { "who": "you",   "text": "…", "ts": 1781069990000 },
    { "who": "agent", "text": "…", "ts": 1781069995000 }
  ],

  "stats": { "turns": 17, "tokens": 91000, "compactions": 3,
             "summarizedThroughTs": 1781069900000 }   // กันยุบเทิร์นซ้ำ
}
```

DDL ที่เสนอให้ N (ปรับได้):
```sql
CREATE TABLE orch_context (
  thread_key  text PRIMARY KEY,
  agent       text NOT NULL,
  project     text,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  ctx         jsonb NOT NULL
);
CREATE INDEX orch_context_agent_idx ON orch_context (agent, updated_at DESC);
```

จุดเขียน (write-path) มี 2 จุดเท่านั้น:
1. หลังอัปเดต rolling summary สำเร็จ (ทุก 10 เทิร์น) — fire-and-forget
2. ตอน compact (ก่อน sid=null) — fire-and-forget เช่นกัน

Degradation บังคับ: **db ล่ม/ช้า/ยังไม่มี → ไม่บล็อก ไม่ throw** — เก็บ ctx mirror ใน `entry.ctx` (sessions.json) เหมือนเดิม = v1 behavior. db เป็น durability layer ไม่ใช่ dependency.

---

## 4. Flow ตอน resume (โหลดจาก db แทน replay เต็ม)

```
startClaudeRun(agent, prompt, opts, task)
  │ session resolution เดิม (explicit key > latest > fresh)
  ▼
[A] เธรดมี entry.sid + ยังไม่ถึง threshold
  → resume ตามปกติ (ไม่แตะ — เคส 19/20 เทิร์น)

[B] เธรดมี entry.sid + needsCompaction()           ← v1 gate เดิม (1407)
  → carry = buildCarryover(entry.ctx)               // HEAD+BODY+TAIL ที่ rolling ไว้ (sync!)
  → ถ้า entry.ctx ว่าง (เพิ่งอัปเกรด/ไฟล์หาย) → await db.loadContext(entry.key) → ถ้ายังว่าง → fallbackCarryover(entry.log)
  → db.saveContext(entry.key, ctx)                  // fire-and-forget snapshot ก่อนตัด
  → entry.sid = null; turns=0; tokens=0; isFresh=true
  → broadcast thread.compacted

[C] เธรด resume แต่ entry.sid == null และไม่มี carryover ใน RAM
    (= daemon เพิ่ง restart กลางเธรด — เคสที่ v1 ทำ context หาย)
  → ctx = await db.loadContext(entry.key)
  → มี → carry = buildCarryover(ctx); isFresh=true   // ต่อเนื่องข้าม restart ได้
  → ไม่มี → เริ่มสด (เท่า v1)

[ฉีด] isFresh && carry → preamble += <context-carryover>…  (จุดเดิม 1470–1475)
```

ผลลัพธ์: ทุก session ใหม่เริ่มที่ ~5–8k tok (persona+carryover+projectNote) แทนการลาก history 150k+ — และเธรดอยู่รอดข้าม daemon restart.

---

## 5. จุด integration ใน server.js (สำหรับรอบ implement — คนเดียวลงมือได้เลย)

> ทุกข้อ: ยึดชื่อ function เป็นหลัก เลขบรรทัด = build 2026-06-10 11:22.

| # | จุด | ที่อยู่ | ทำอะไร |
|---|---|---|---|
| 5.1 | require db adapter | หัวไฟล์ ใกล้ `const brain = require("./brain")` (~20) | `let db = null; try { db = require("./db"); } catch {}` — ไม่มีโมดูล = โหมด in-memory |
| 5.2 | result parse — cadence trigger | `startClaudeRun` บล็อก `entry.turns/tokens` (**1625–1633**) | เพิ่ม `entry.turnsSinceSummary`, `entry.tokensSinceSummary`; ถ้า ≥10 เทิร์น หรือ >50k → `queueRollingSummary(entry)` (async, ห้าม await ใน hot path, กัน re-entry ด้วย flag ต่อ entry) |
| 5.3 | `queueRollingSummary(entry)` ใหม่ | วางถัดจาก `summarizeThread` (**725**) | Haiku ผ่าน `claudeText(…, {model: LIGHT_MODEL})`: input = head+body เดิม (จาก `entry.ctx`) + เทิร์นใหม่จาก `entry.log` ที่ ts > `summarizedThroughTs`; output JSON `{head, body}`; เขียน `entry.ctx` + `db.saveContext` fire-and-forget; ล้มเหลว = log แล้วเงียบ (รอบหน้า 10 เทิร์นถัดไปลองใหม่) |
| 5.4 | `buildCarryover(ctx)` ใหม่ (sync) | ข้าง `fallbackCarryover` (**719**) | ประกอบ string: goal/decisions/pending/focusFiles + body + tail 8 รายการ; cap 4,000 chars; ctx ว่าง → คืน "" |
| 5.5 | compaction gate | **1407–1419** | เปลี่ยน `await summarizeThread(entry)` → `buildCarryover(entry.ctx)` (sync); เพิ่ม db.loadContext fallback + db.saveContext snapshot ตาม §4[B]; `MAX_TURNS` **713** ปรับ 40→20 |
| 5.6 | restart-recovery [C] | หลัง sid-file existence check (**~1395–1400**) | `if (!entry.sid && !isNew && !entry.carryover && db) { … await db.loadContext … }` — เคสเดียวที่อนุญาต await db (เกิดครั้งเดียวหลัง restart ต่อเธรด) ใส่ timeout ~1.5s กัน db ค้าง |
| 5.7 | (optional, แยก PR ได้) trim โน้ตต่อเทิร์น | `projectNote` (**1182**) ที่จุดส่ง **1525**; `directorNote` (**1680**) ที่ caller **1727**, **3260** | ส่งฉบับเต็มเฉพาะ `isFresh`; เทิร์น resume ส่งฉบับย่อ (เฉพาะรายการที่เปลี่ยนจาก hash ล่าสุด หรือ 1 บรรทัด "registry ไม่เปลี่ยน") — ประหยัด ~2–4k/เทิร์น ทุกเทิร์น orchestration |
| 5.8 | sub-agent ghosts | `runSubAgents` (**1879**) | **ไม่ทำ compaction** — ghost เป็น one-shot session อยู่แล้ว (sid ไม่ resume) ยืนยันว่าไม่มีใครเผลอใส่ |
| 5.9 | sessions.json schema | `entry` fields | เพิ่ม: `ctx` (mirror ของ §3), `turnsSinceSummary`, `tokensSinceSummary`; ลบไม่ได้: `turns`, `tokens`, `carryover` (v1 compat ระหว่างเปลี่ยนผ่าน) |

ค่าคงที่ใหม่ (วางข้าง `MAX_TURNS` **713**):
```js
const SUMMARIZE_EVERY   = 10;      // เทิร์น
const SUMMARIZE_TOKENS  = 50_000;  // หรือ token สะสมตั้งแต่ summary ล่าสุด
const TAIL_KEEP         = 8;       // เทิร์นล่าสุดเก็บเต็มใน ctx.tail
const CARRYOVER_MAX     = 4_000;   // chars
const DB_LOAD_TIMEOUT   = 1_500;   // ms (เฉพาะเคส [C])
```

ลำดับ implement ที่แนะนำ (แต่ละขั้น ship ได้เดี่ยวๆ):
1. **Phase A (ไม่ต้องรอ N)**: 5.2 + 5.3 + 5.4 + 5.5 + 5.9 — rolling summary เก็บใน sessions.json mirror; db calls เป็น no-op เมื่อไม่มีโมดูล
2. **Phase B (เมื่อ N ส่ง daemon/db.js + orch_context)**: 5.1 + 5.6 + เปิด save/load จริง — ไม่ต้องแก้ logic อื่น เพราะ adapter คั่นไว้แล้ว
3. **Phase C (optional)**: 5.7 trim โน้ตต่อเทิร์น

## 6. Safety (สืบทอด v1 + เพิ่ม)

- `entry.key` + `entry.log` ห้ามแตะ — CEO เห็นเธรดต่อเนื่องเสมอ
- ห้าม throw/บล็อกในทุกเส้นทาง summary/db — งานหลักต้องเดินต่อได้เสมอ; db = durability ไม่ใช่ dependency
- LLM call เดียวที่เพิ่ม = Haiku ทุก 10 เทิร์น (จิ๋ว); **ไม่มี** LLM call ใน compact hot path อีกต่อไป (เร็วขึ้นกว่า v1)
- เธรดสั้น (<10 เทิร์น) ไม่โดนอะไรเลย
- optimistic version ใน ctx กัน write เก่าทับใหม่ (เคส daemon ซ้อน/restart race)

## 7. Verify (รอบ implement)

- sandbox :8799 + stub claude (แบบเดียวกับที่ใช้เทสต์ v1 — stub เขียน sid file จริง + token ปรับผ่าน prompt):
  1. 12 เทิร์น → เห็น `queueRollingSummary` ยิง 1 ครั้ง (เทิร์น 10), `entry.ctx.head/body/tail` ครบ
  2. ทะลุ 20 เทิร์น → compact: carryover มาจาก ctx (ไม่มี Haiku call ตอน compact), resume=no + `<context-carryover>` มี goal/decisions
  3. ฆ่า daemon กลางเธรด → start ใหม่ → เทิร์นถัดไปได้ carryover จาก db (เคส [C]) — เทสต์ด้วย stub db ก่อน N ส่งจริงได้
  4. db โยน error ทุก call → ทุกอย่างยังเดิน (= Phase A behavior)
- ตัวชี้วัดบน live: `GET /tokens/by-process` ของ main — cache_creation/เทิร์น ตกกลับฐานทุก ~20 เทิร์น; fresh tokens ต่อ 100 เทิร์น ลดลงเทียบ baseline 1.53M ที่บันทึกไว้ 2026-06-10

---
*v2 drafted 2026-06-10 โดย Black (design-only round — no code touched). v1 spec เดิมถูก supersede โดยเอกสารนี้; พฤติกรรม v1 ที่ live อยู่คือ baseline ของ Phase A.*
