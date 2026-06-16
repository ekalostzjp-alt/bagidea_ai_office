# Per-Agent Model Settings — Audit (current state)

วันที่ออดิต: 2026-06-10. ออดิตจาก roster จริง (`GET /registry`) + โค้ด `daemon/server.js`.

## สรุปสั้น
ตอนนี้ **ไม่มีการกำหนด model ราย agent เลย** และ daemon **ไม่ได้ส่ง `--model`** ตอน spawn `claude` →
ทุก agent รันด้วย **model default ของ Claude Code CLI/บัญชี** (ไม่ถูก pin ไว้ใน repo).

## ตาราง: agent → model ปัจจุบัน + ที่มา

| agent id | ชื่อ | tier | model ปัจจุบัน | ที่มาของค่า |
|---|---|---|---|---|
| `main` | บาร์ท (Director) | 2 | Claude Code CLI default | ไม่มี `--model` ใน spawn |
| `ceo` | คุณหนึ่ง (Founder) | 3 | — (เป็น "ผู้ใช้/CEO" ไม่ถูก spawn เป็น worker) | CEO prompt ถูก route เข้า `main` (ceoFlow) |
| `มิสเตอร์-n` | มิสเตอร์ N (Engineer) | 3 | Claude Code CLI default | ไม่มี `--model` ใน spawn |
| `น้องไวท์` | น้องไวท์ (Engineer) | 3 | Claude Code CLI default | ไม่มี `--model` ใน spawn |
| `แบล็ค` | แบล็ค (Engineer) | 3 | Claude Code CLI default | ไม่มี `--model` ใน spawn |

> `tier` (main=2, ที่เหลือ=3) เป็นแค่ "ระดับองค์กร" สำหรับแสดงผล/จัดทีม — **ไม่ได้** ใช้เลือก model.

## ที่มาของค่าในโค้ด (จุดจริง)

1. **`daemon/server.js` — `runClaude()` (spawn หลัก)** ราว บรรทัด **1024–1036**:
   ```js
   const args = ["-p", "--output-format", "stream-json", "--verbose",
     "--allowedTools", tools,
     "--settings", path.join(WORKSPACE, ".claude", "settings.json")];
   if (mcpConfig) args.push("--mcp-config", mcpConfig);
   if (entry && entry.sid) args.push("--resume", entry.sid);
   const child = spawn("claude", args, { cwd, shell: true,
     env: { ...process.env, ...(reg.apiKeys||{}), OFFICE_ADAPTER:"1", OFFICE_AGENT:agent, OFFICE_TASK:task } });
   ```
   → **ไม่มี `--model`** และ **ไม่มี `ANTHROPIC_MODEL`/`CLAUDE_*` ใน env**. นี่คือจุดเดียวที่ต้อง inject model หลัก.

2. **`daemon/server.js` — `runSub()` (ghost/sub-agent)** ราว บรรทัด **1445–1451**: สร้าง `args` แบบเดียวกัน ก็ **ไม่มี `--model`** เช่นกัน. ต้อง inject ด้วยให้สอดคล้อง.

3. **`daemon/server.js` — `maybeLearnSkill()`** บรรทัด **408**: `spawn("claude", ["-p"])` (งานเล็กเรียนสกิล) — ไม่มี model; ปล่อยใช้ default ได้ (ไม่ critical).

4. **`~/.claude/settings.json`** = `{enabledPlugins, autoUpdatesChannel, skipDangerousModePermissionPrompt}` → **ไม่มี key `model`** → ไม่ pin default.

5. **`daemon/registry.json`** (`reg.agents[id]`) มี: `name, role, tier, tools, skills, persona…` → **ไม่มี field `model`**. ยังไม่มี `reg.defaultModel`.

## ช่องที่จะต่อยอด (ส่งให้แบล็ค)
- เพิ่ม `reg.defaultModel` + `reg.agents[id].model` ใน `registry.json`.
- ตอนสร้าง `args` (ทั้ง 1024 และ 1445): resolve model ของ agent แล้ว `args.push("--model", <resolved>)` เมื่อมีค่า.
- กติกา resolve: `reg.agents[agent].model || reg.defaultModel || (ไม่ใส่ --model = CLI default)`.

รายละเอียด endpoint/UI ดูใน `per-agent-model-settings.contract.md`.
