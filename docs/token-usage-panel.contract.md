# Token Usage Panel — Research + Contract (design only)

สถานะ: **วิจัย+ออกแบบเท่านั้น** ยังไม่แตะ `daemon/server.js` / `daemon/overlay.html` (Work Summary Modal กำลัง integrate). เอกสารนี้ให้แบ่งงาน BE (แบล็ค) / FE (ไวท์) ต่อ.

เป้าหมาย: แสดงว่า Claude Code และ Codex เหลือ quota เท่าไหร่ + จะรีเซ็ตเมื่อไหร่.

---

## 1. แหล่งข้อมูลที่ทดสอบแล้วว่าได้ค่าจริง

### Claude Code (เครื่องนี้ = แผน **Max 5x**, login แบบ OAuth)
- ❌ ไฟล์ local **ไม่มี** remaining/reset สด. `~/.claude.json` มีแค่ guest-pass (`passesLastSeenRemaining`), `~/.claude/stats-cache.json` เป็นสถิติย้อนหลัง, `~/.claude/.credentials.json` มีแค่ token + `expiresAt` (หมดอายุ token ไม่ใช่ quota).
- ✅ **แหล่งสด = response headers ของ Anthropic API** เรียกด้วย OAuth token:
  - `POST https://api.anthropic.com/v1/messages`
  - headers: `authorization: Bearer <claudeAiOauth.accessToken จาก ~/.claude/.credentials.json>`, `anthropic-version: 2023-06-01`, `anthropic-beta: oauth-2025-04-20`
  - body จิ๋ว: `{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}`
  - **headers ที่ได้กลับ (ทดสอบจริง 2026-06-10):**
    ```
    anthropic-ratelimit-unified-5h-utilization: 0.11      # ใช้ไป 11% → เหลือ 89%
    anthropic-ratelimit-unified-5h-reset: 1781063400      # epoch s → 2026-06-10T03:50Z
    anthropic-ratelimit-unified-5h-status: allowed
    anthropic-ratelimit-unified-7d-utilization: 0.02      # ใช้ไป 2%
    anthropic-ratelimit-unified-7d-reset: 1781283600      # 2026-06-12T17:00Z
    anthropic-ratelimit-unified-7d-status: allowed
    anthropic-ratelimit-unified-representative-claim: five_hour   # window ที่ binding ตอนนี้
    anthropic-ratelimit-unified-overage-status: rejected
    ```
  - `remainingPct = (1 - utilization) * 100`. มีสอง window: **5h** และ **7d**. ไม่มีตัวเลข token สัมบูรณ์ — เป็น % utilization.
  - ต้นทุน: ต้องยิง API จริง ~1 token ต่อครั้ง (ไม่มี local source ฟรี).

### Codex (เครื่องนี้ = login **ChatGPT Plus**, `auth_mode: chatgpt`)
- ✅ **แหล่ง passive (อ่านไฟล์ ฟรี) = session rollout ล่าสุด**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` → event `event_msg` ตัวท้ายที่มี `payload.rate_limits`:
  ```jsonc
  "rate_limits": {
    "primary":   { "used_percent": 1, "window_minutes": 300,   "resets_at": 1780378791 },  // 5h
    "secondary": { "used_percent": 0, "window_minutes": 10080,  "resets_at": 1780965591 },  // 7d
    "plan_type": "plus"
  }
  ```
  - `remainingPct = 100 - used_percent`. resets_at = epoch s.
  - ⚠️ **ค่านี้อัปเดตเฉพาะตอน Codex รันจริง** — เครื่องนี้ snapshot ล่าสุดคือ 2026-06-02 (เก่า 8 วัน).
- 🔁 รีเฟรชสดได้ด้วยการรัน turn จิ๋ว `codex exec "."` แล้วอ่านไฟล์ใหม่ — แต่เสีย ChatGPT turn จริง (ยังไม่รันในรอบวิจัยนี้).
- plan อ่านได้จาก claim ของ `~/.codex/auth.json` → `tokens.id_token` (JWT) → `chatgpt_plan_type = "plus"`.

### หมายเหตุ: OpenAI API key ≠ Codex quota
- ออฟฟิศมี `OPENAI_API_KEY`. ยิง `POST api.openai.com/v1/chat/completions` ได้ headers `x-ratelimit-limit-tokens: 200000 / remaining-tokens: 199997 / reset-tokens: 0s` (+ requests). **แต่นี่คือลิมิต TPM/RPM ต่อนาทีของ API key (pay-as-you-go) คนละโควตากับ ChatGPT-plan ที่ Codex ใช้จริง** — อย่าเอามาปนกับ panel ของ Codex.

---

## 2. Contract ที่เสนอ

### `GET /tokens`  (และ event `tokens.update` payload เดียวกัน + `ts`)
ทำให้ค่า normalize เหมือนกันทั้งสองฝั่ง (window-based, %):
```jsonc
{
  "claude": {
    "ok": true, "plan": "max_5x", "stale": false, "fetchedAt": 1781064000000,
    "primary":   { "label": "5h", "usedPct": 11, "remainingPct": 89, "resetAt": 1781063400, "status": "allowed" },
    "secondary": { "label": "7d", "usedPct": 2,  "remainingPct": 98, "resetAt": 1781283600, "status": "allowed" },
    "representative": "primary",       // window ที่กำลัง binding (จาก representative-claim)
    "note": null
  },
  "codex": {
    "ok": true, "plan": "plus", "stale": true, "fetchedAt": 1781064000000, "snapshotAt": 1780378791,
    "primary":   { "label": "5h", "usedPct": 1, "remainingPct": 99,  "resetAt": 1780378791 },
    "secondary": { "label": "7d", "usedPct": 0, "remainingPct": 100, "resetAt": 1780965591 },
    "representative": "primary",
    "note": "snapshot from last Codex run; may be stale"
  }
}
```
- `resetAt` = **epoch วินาที** (ตามที่ API ให้มา) — FE คูณ 1000 ก่อนทำ Date.
- `remainingPct` คือเลขหลักที่ panel โชว์; แสดงทั้ง 5h และ 7d, ไฮไลต์ `representative`.
- event WS: `{ "type":"tokens.update", "claude":{…}, "codex":{…}, "ts":… }` ส่งเมื่อค่าเปลี่ยน.

### หน้าที่ BE (แบล็ค)
- `GET /tokens`: คืน cache ล่าสุด (ไม่บล็อก). มี refresher แยกที่:
  - Claude: ยิง 1-token call (อ่าน token จาก `~/.claude/.credentials.json` **สดทุกครั้ง** เพื่อรับ token ที่ Claude Code refresh ให้), parse `anthropic-ratelimit-unified-*`.
  - Codex: อ่าน rollout ล่าสุด, parse `rate_limits`, ตั้ง `stale=true` ถ้า snapshotAt เก่ากว่า ~10 นาที.
  - เก็บ cache + broadcast `tokens.update` เมื่อค่าเปลี่ยน.
- **ห้าม broadcast token/secret** — ส่งเฉพาะ % / resetAt ที่คำนวณแล้ว.

### หน้าที่ FE (ไวท์)
- ฟัง `tokens.update` (+ เรียก `GET /tokens` ตอนเปิด panel) → เรนเดอร์ 2 การ์ด (Claude / Codex): แถบ %, "เหลือ X%", "รีเซ็ตอีก … (จาก resetAt)", badge `stale` ถ้า stale.

---

## 3. วิธี refresh + fallback

- **Claude** — ต้องยิง API จริง ⇒ ไม่ poll ถี่:
  - on-demand ตอนเปิด panel + background poll ช้า ๆ (แนะนำทุก 5 นาที) เฉพาะตอน panel เปิด.
  - ทางที่ดีสุด (ต้นทุน 0): ถ้า adapter ของ daemon ที่รัน Claude Code อยู่แล้ว ดัก unified headers จาก agent run ปกติได้ → ได้ค่าสดฟรี (แต่ headless `claude -p` ปัจจุบันไม่ปล่อย response headers ออกมา — ต้องตรวจเพิ่ม).
  - fallback: ยิงไม่ได้/401/ออฟไลน์ → `ok:false` + คืน cache เก่า + `stale:true`; FE โชว์ค่าเดิม + badge. ถ้า token หมดอายุ ให้พึ่ง Claude Code refresh ไฟล์ creds เอง (อ่านสดทุกครั้ง).
- **Codex** — อ่านไฟล์ฟรี ⇒ poll newest rollout ทุก 30–60s (เปลี่ยนเฉพาะตอน Codex รัน). refresh สดจริงต้อง `codex exec` (เสีย turn) ⇒ ทำเฉพาะปุ่ม "refresh now".
  - fallback: ไม่เคยรัน Codex/ไม่มีไฟล์ → คืน `plan` จาก id_token, windows = null, `ok:false, note:"no Codex run yet"`.

---

## 4. ความเสี่ยง

1. **Claude ไม่มี source ฟรี** — ต้องยิง API จริงเสีย quota นิดทุกครั้ง. คุม cadence ให้ประหยัด.
2. **ใช้ OAuth token ของผู้ใช้ยิง API = เลียน Claude Code** — ได้จริง (ทดสอบแล้ว) แต่: token หมดอายุต้อง refresh, `anthropic-beta: oauth-2025-04-20` อาจเปลี่ยนตามเวอร์ชัน (เปราะ), และมีประเด็น ToS.
3. **Codex ค่า stale** — อัปเดตเฉพาะตอน Codex รัน (เครื่องนี้เก่า 8 วัน). ต้องโชว์ "as of …" + badge เสมอ กันเข้าใจผิด.
4. **อย่าปน OpenAI API-key limits (TPM/RPM ต่อนาที) กับ Codex/ChatGPT quota** — คนละตัว.
5. **หน่วยเวลา/รูปแบบต่างกัน** — Claude/Codex = epoch s; OpenAI key = relative ("8.64s"). normalize เป็น epoch s ที่ BE.
6. **ความปลอดภัย** — token อยู่ฝั่ง server เท่านั้น, ไม่หลุดผ่าน WS/`GET /tokens`.
