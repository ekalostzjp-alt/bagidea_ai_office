# Project Brain — Contract + Wire (READY for Black)

Owner: team lead (Nueng). Engine: **เสร็จ + ทดสอบจริงแล้ว** (`daemon/brain/*`). Backend ต่อท่อ: Black (`daemon/server.js`). Frontend: White.

ฟีเจอร์: scan โปรเจค → **CodeGraph** (import edges) → **Mapping** (modules/entry/hotspots/deps) → **Brain** (สรุป) → **MCP server** ให้ session ใดๆ query แผนที่โปรเจคได้ → **auto-init** `.claude/.codex/PROJECT_BRAIN.md`.

## 0. ผลทดสอบจริง (tookjorThai, 6.0 GB)
- scan **169ms**, ปลอดภัยกับ repo ยักษ์ (ignore node_modules/dist/bin/obj/.git/… + cap 20k files/512KB/depth12).
- ได้ **1893 source files · 168,199 loc · 1607 import edges · 62 external deps** (ไม่ truncate).
- จับถูก: entry `backend/src/main.ts`, deps `@nestjs/common`,`mongoose`,…, hotspots = guards/decorators/services, modules backend(922)/desktop(881 `.cs`)/frontend(52 astro/ts).
- MCP: `initialize`→`tools/list`→`tools/call` ผ่านครบ, exit สะอาดเมื่อ stdin ปิด.

## 1. โมดูล (เสร็จแล้ว — Black แค่ require)
- `daemon/brain/engine.js` — `scan()`, `buildGraph()`, `buildMapping()` (pure, bounded).
- `daemon/brain/index.js` — **API หลัก**: `buildBrain({id,name,dir}, {now})` → `{summary, brain}`; `getBrain(projectId, full?)`; persist `daemon/brain-cache/<id>.json`; auto-init `.claude/.codex/PROJECT_BRAIN.md`.
- `daemon/brain/mcp-server.js` — MCP stdio server (zero-dep), tools: `brain_summary`,`brain_search`,`brain_neighbors`.

## 2. วิธี wire ใน server.js (ให้แบล็ค — ~6 บรรทัด)
```js
const brain = require("./brain");                       // ด้านบนไฟล์

// POST /project/scan  { project: "<id|path|name>" }
} else if (req.method === "POST" && req.url === "/project/scan") {
  readBody(req, (body) => {
    try {
      const p = JSON.parse(body);
      const pid = resolveProjectRef(p.project);         // ใช้ resolver เดิม
      const proj = projects.find((x) => x.id === pid);
      if (!proj) { res.writeHead(404); return res.end("unknown project"); }
      const { summary } = brain.buildBrain(proj, { now: Date.now() });
      broadcast({ type: "brain.ready", project: proj.id, projectName: proj.name,
        stats: summary.stats }, false);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(summary));
    } catch (e) { res.writeHead(400); res.end(String(e.message)); }
  });

// GET /project/brain?project=<id|path|name>   (cached; full=1 → รวม graph)
} else if (req.method === "GET" && req.url.split("?")[0] === "/project/brain") {
  const q = new URL(req.url, "http://x").searchParams;
  const b = brain.getBrain(resolveProjectRef(q.get("project")), q.get("full") === "1");
  res.writeHead(b ? 200 : 404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(b || { error: "not scanned — POST /project/scan first" }));
```
> `buildBrain` เป็น sync + bounded (scan tookjorThai 169ms) — เรียกตรงใน handler ได้ ไม่บล็อกนาน. โปรเจคใหญ่กว่านี้มาก ค่อยพิจารณายัดใน worker/ทำ async.

## 3. MCP — ต่อให้ session ของโปรเจคใช้
auto-init เขียน `.claude/PROJECT_BRAIN.md` ให้แล้ว. ถ้าต้องการให้ agent **query brain สดผ่าน MCP** ให้เพิ่ม mcpServers ใน `.claude/settings.json` ของโปรเจค (หรือ inject ตอน runClaude):
```jsonc
{ "mcpServers": { "project-brain": {
    "command": "node",
    "args": ["<app>/daemon/brain/mcp-server.js", "<projectId>"] } } }
```
tools ที่ได้: `brain_summary`, `brain_search {query}`, `brain_neighbors {file}`.

## 4. WS event
`{ type:"brain.ready", project, projectName, stats }` (journaled=false) → overlay แสดง/รีเฟรชการ์ด Brain ของโปรเจค.

## 5. Frontend (White)
- แท็บ/การ์ด 🧠 "Project Brain" ต่อโปรเจค: ปุ่ม "Scan" → `POST /project/scan`; โชว์ stats, modules, entryPoints, hotspots, deps จาก `GET /project/brain`.
- ฟัง `brain.ready` เติมสด.

## 6.5 Auto-scan policy (enforced — กฎประจำจาก CEO)
daemon บังคับใช้เองแล้วใน `server.js` ผ่าน `autoScanBrain(ref, phase)`:
- **pre-work**: ทุก DELEGATE ที่ route เข้าโปรเจค (`@ <project>` / inherit / from-prompt) — ถ้ายังไม่มี `brain-cache/<id>.json` จะ `buildBrain()` ให้เสร็จก่อน `runClaude` ของผู้รับงานเริ่ม (PROJECT_BRAIN.md พร้อมตั้งแต่ข้อความแรก). มี cache แล้ว = ข้าม (idempotent).
- **post-work**: `onDone` ของ run ที่ถูก DELEGATE เข้าโปรเจค → re-scan อัตโนมัติ + broadcast `brain.ready` ก่อน report เดินกลับหา Director.
- กันพังด้วย try/catch ทั้งก้อน — scan fail ไม่บล็อก dispatch/report. log: `[brain] auto-scan: <name> (pre-work|post-work)`.
- e2e: `node tools/brain-autoscan-e2e.js` (sandbox + stub claude, ไม่แตะ :8787, ไม่เผา token) — 9/9 PASS.

## 6. เหลือ / ความเสี่ยง
- **เหลือ**: Black ต่อ 2 endpoint (ข้อ 2) + White ทำ UI (ข้อ 5). Engine + MCP **พร้อม integrate ทันที**.
- graph แก้ import แบบ regex (JS/TS/Astro/Svelte/Vue/py) — ครอบเคสหลัก; alias `@/…` ของ tsconfig ยังไม่ resolve (นับเป็น external) — เป็น follow-up ถ้าต้องการแม่นขึ้น.
- auto-init เขียนไฟล์ `PROJECT_BRAIN.md` ลง `.claude`/`.codex` ของโปรเจคจริง (ไม่ทับไฟล์อื่น) — ตอนทดสอบได้เขียนลง tookjorThai แล้ว (ลบได้ถ้าไม่ต้องการ).
- repo > cap (20k files) → `stats.truncated=true`; ปรับ cap ผ่าน opts ได้.
