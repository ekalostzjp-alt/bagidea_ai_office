# ✅ Checklist เตรียม publish repo สาธารณะ (รอ CEO เคาะ)

> เป้าหมาย: ปล่อยสำเนาสาธารณะของ BagIdea Office โดย **ไม่ลากความลับ/data ส่วนตัว** ไปด้วย
> และให้ build สาธารณะ "เห็นเฉพาะอัปเดตของ repo ใหม่" (ดูกลไกใน feasibility report)
>
> หลักการ: **export เฉพาะที่อนุญาต (allowlist)** + **git init ใหม่ (fresh history)** —
> ไม่ใช่ "ลบไฟล์ทีละไฟล์จาก repo เดิม" และ **ไม่ push history เต็ม**

---

## 1) วิธี export — allowlist เท่านั้น (ไม่ใช่ blacklist)

ทำใน **โฟลเดอร์ใหม่ที่ว่างเปล่า** แล้วก๊อปเฉพาะที่อนุญาตเข้าไป:

**✅ Export ได้ (allowlist):**
- `daemon/*.js` (source) **ยกเว้น** `server.staged.js`, `server.frozen-candidate.js` และไฟล์ `_*`/`*.bak`
- `daemon/*.html`, `daemon/brain/`, `daemon/i18n-seed/`, `daemon/tests/*.test.js` (เฉพาะ `.test.js` จริง)
- `daemon/package.json`, `daemon/package-lock.json`
- `plugins/music/`, `plugins/calculator/` (core plugins) — **ยกเว้น** `*/data/`, `music/tracks/`
- `shell/` (source + `Cargo.toml`/`Cargo.lock`) **ยกเว้น** `target/`, `*.dylib`, `overlay-pos.cfg`
- `godot/` (source `.gd`/scenes) **ยกเว้น** `.godot/`, `bin/`, `bin-mac/`, `_*.gd`, `_*.png`
- `installer/`, `docs/`, `web/`, `tools/` (เฉพาะ tooling ที่ตั้งใจเปิด), `README.md`, `VERSION`, `CHANGELOG.md`
- `.gitignore` (เวอร์ชันที่อุดรูแล้ว — ดูข้อ 4)

**🚫 ห้ามติดไปเด็ดขาด (blocklist — ยืนยันด้วย `git check-ignore` แล้วว่า "ยังหลุดได้"):**
| ไฟล์/โฟลเดอร์ | เหตุผล | สถานะใน .gitignore เดิม |
|---|---|---|
| `daemon/model-settings.json` | config โมเดล/พฤติกรรมส่วนตัว | ❌ ยังไม่ ignore |
| `daemon/registry.json` + `registry.json.bak-precharlock` | roster/skills/agents จริง | `.json` ignore ✓ / `.bak-precharlock` ❌ |
| `daemon/registry.lock-staged.json` | staged registry | ❌ ยังไม่ ignore |
| `daemon/server.staged.js`, `daemon/server.frozen-candidate.js` | สำเนา deploy ภายใน | ❌ ยังไม่ ignore |
| credential Integration Hub (`plugins/integration-hub/data/`) | secret (AES-GCM at-rest) | `plugins/*/data/` ✓ (แต่ทั้ง plugin ก็ไม่ track อยู่แล้ว) |
| `daemon/.env.db`, ไฟล์ `.env*`, `ecosystem*` | secret/DB/PM2 env | `.env.db` ✓ / `.env*`,`ecosystem*` ❌ (ตอนนี้ root ไม่มี แต่ควรกันไว้) |
| `workspace/*` (รวม `workspace/memory/*`, `OFFICE.md`) | ความจำ/โน้ตภายใน | ✓ ignore แล้ว |
| `projects/*/MEMORY.md`, `.claude/PROJECT_BRAIN.md` | brain/ความจำโปรเจค | ❌ ยังไม่ ignore |
| `.codex/`, `.e2e-gate/` | ขยะ tooling/gate ภายใน | ❌ ยังไม่ ignore |
| ขยะ test/dev: `daemon/tests/_*` (`_overlay_init_repro.js`, `_tok-probe.js`), `daemon/*.bak`, `daemon/iconText-overlay.patch.md`, `mcp_test_real.json`, `shell/overlay-pos.cfg` | repro/probe/patch ชั่วคราว | บางส่วน ✓ / `_*`,patch ❌ |
| runtime state: `runs.json`, `tokens.json`, `sessions.json`, `journal.jsonl`, `snapshots/`, `daemon.log`, `*.pid` | สถานะรันจริง | ✓ ส่วนใหญ่ ignore แล้ว |

> 📌 9 รายการที่ขึ้น "❌ ยังไม่ ignore" คือผลตรวจจริงด้วย `git check-ignore` วันนี้ — ต้องอุดก่อน (ข้อ 4)

---

## 2) fresh / squashed history (อย่า push history เต็ม)

History ปัจจุบัน (branch `pre-merge-v0710-snapshot` ฯลฯ) มี commit เก่าที่อาจฝัง path เครื่อง/โน้ตภายใน → **ห้าม `git push` repo เดิม / ห้าม `git remote add` แล้ว push**

ขั้นตอน:
1. ก๊อป allowlist (ข้อ 1) ลงโฟลเดอร์ใหม่ว่างๆ — **ไม่ก๊อป `.git/` เดิม**
2. `git init` ใหม่ในโฟลเดอร์นั้น
3. วาง `.gitignore` ฉบับอุดรูแล้ว → `git add -A` → ตรวจ `git status` ให้แน่ใจไม่มีไฟล์ในข้อ blocklist
4. `git commit -m "Initial public release vX.Y.Z"` (commit เดียว = squashed, ไม่มีอดีต)
5. ตั้ง remote เป็น repo สาธารณะใหม่ แล้ว push
6. (ตัวเลือก) ถ้าต้องการหลายช่วงเวอร์ชัน ให้ squash เป็น tag ต่อ release ไม่ใช่ลอก history ดิบ

---

## 3) ก่อน commit — verify รอบสุดท้าย (เบรกมือ)

- [ ] `git status` ในโฟลเดอร์ใหม่ → ไม่มีรายการ blocklist ข้อ 1
- [ ] ค้น secret หลงเหลือ: เกรปหา `api_key`, `secret`, `token`, `Bearer`, `BAGIDEA_`, path เครื่อง `C:\Users\` ทั้ง tree
- [ ] เปิด `daemon/registry.json`/ความจำ → ยืนยันว่า **ไม่อยู่** ใน export
- [ ] รัน `node --test daemon/tests/*.test.js` ในสำเนาใหม่ → เขียว (ยืนยัน export ครบ ใช้งานได้)
- [ ] boot สำเนาใหม่ในเครื่องเปล่า → ยืนยันแบนเนอร์อัปเดตเช็ค **repo ใหม่** ไม่ใช่ repo หลัก (ต้องมี patch `updateRepo()` ของแบล็คก่อน)

---

## 4) `.gitignore` ฉบับอุดรู — บรรทัดที่ต้องเพิ่ม

ของเดิมครอบ runtime ส่วนใหญ่แล้ว แต่ขาด 9 จุดนี้ (เพิ่มก่อน publish):

```gitignore
# --- เพิ่มก่อน publish สาธารณะ ---
daemon/model-settings.json
daemon/registry.lock-staged.json
daemon/registry.json.bak-precharlock
daemon/*.bak-*
daemon/server.staged.js
daemon/server.frozen-candidate.js
daemon/tests/_*
daemon/*.patch.md
.codex/
.e2e-gate/
.claude/PROJECT_BRAIN.md
projects/
shell/overlay-pos.cfg
mcp_test_real.json
# secrets เพิ่มเติม (กันไว้แม้ตอนนี้ root ยังไม่มี)
.env
.env.*
ecosystem*
```

> ⚠️ `.gitignore` เป็นเบรกชั้นสอง — **ชั้นแรกคือ allowlist export (ข้อ 1)**. แม้ลืมอุด ถ้า export แบบ allowlist ถูกต้อง ไฟล์เหล่านี้ก็ไม่เข้าไปตั้งแต่ต้น

---

## 5) เกี่ยวเนื่อง (ทำคู่กัน)

- **server-side:** patch `updateRepo()` 3-tier ใน `server.js` + `server.staged.js` (งานแบล็ค) — ขาดอันนี้ build สาธารณะจะยังเด้งอัปเดตของ repo หลัก
- **frontend:** ลิงก์ "มีอะไรใหม่" ใน `overlay.html` derive จาก backend แล้ว (`ev.repo`/`/version`) — เสร็จแล้ว ✅
- **installer:** `install.ps1`/`install-mac.sh` มี `BAGIDEA_REPO` env อยู่แล้ว — ตั้ง default ของ repo ใหม่ให้ชี้ตัวเอง
- **docs/web:** ลิงก์ `bagidea/bagidea-office` ใน `README.md`, `web/*`, `docs/*` → แก้ชี้ repo ใหม่ตอนทำ landing

---
_จัดทำโดย น้องไวท์ (Frontend) · อิงผลตรวจโค้ด+`.gitignore` จริงวันที่จัดทำ · ยังไม่ publish — รอ CEO เคาะ_
