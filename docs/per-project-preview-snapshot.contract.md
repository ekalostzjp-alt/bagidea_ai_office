# Per-Project Preview Snapshot — Contract

Owner: team lead (Nueng). Backend: Black (`daemon/server.js`). Frontend: White (`daemon/overlay.html`).

เป้าหมาย CEO: งาน Frontend ของโปรเจคเสร็จ → ระบบรันแอปของโปรเจคบน **port แยกต่อโปรเจค** → ถ่าย **Snapshot** ให้ CEO ดูว่าหน้าตาเป็นยังไง, เปิดดูได้ตรงๆ, แยกชัดว่าเป็นของโปรเจคไหน. ต้อง **ไม่ทิ้ง process ค้าง** (กฎเหล็ก).

## 0. สิ่งที่ทดสอบจริงบนเครื่องนี้แล้ว (empirical)
| เรื่อง | ผลที่ยืนยันแล้ว |
|---|---|
| Headless screenshot | **Chrome** `C:\Program Files\Google\Chrome\Application\chrome.exe` `--headless=new --screenshot` → ได้ PNG 1280×800 จริง (ไม่ต้องใช้ puppeteer/playwright — ไม่ได้ติดตั้ง). Edge เป็น fallback. |
| tookjorThai frontend | `D:\project\tookjorThai\frontend` = **Astro** (`build`/`preview`), มี `node_modules` + `dist` แล้ว → `astro preview` เสิร์ฟได้ทันที |
| โปรเจค root | เป็น .NET/backend (ไม่ใช่เว็บ) → ต้อง **skip อย่างสุภาพ** |
| Lifecycle | start `astro preview` → screenshot → `taskkill /T /F` ตาม PID ที่ฟัง port → **port ว่าง ไม่มี process ค้าง** (พิสูจน์แล้ว) |

## 1. กลไก (ให้ Black ทำตาม)

### 1.1 จัดสรร port ต่อโปรเจค (deterministic, แยกต่อโปรเจค)
```
previewPort(projectId) = 4300 + (hashInt(projectId) % 500)   // ช่วง 4300–4799, เลี่ยง 8787
```
ถ้า port ชน (มีคนฟังอยู่) → +1 จนว่าง. เก็บ port ที่ใช้จริงลง record. (port "แยกของแต่ละโปรเจค" ตาม CEO)

### 1.2 ตรวจชนิดโปรเจค + หา web root
- web root = ไดเรกทอรีแรกที่มี `package.json` ซึ่ง deps มี `astro|vite|next|react-scripts|@sveltejs|vue` ใน: `projectDir` หรือ `projectDir/frontend` (tookjorThai = `frontend/`).
- ถ้าไม่พบ web root → **status `skipped`** + `reason:"non-web project"` (ทำ build-status card แทน, ไม่ screenshot).

### 1.3 build + preview
- ถ้าไม่มี `dist`/build output → build ก่อน: Astro=`npm run build`, ทั่วไป=สคริปต์ `build`. (tookjorThai มี `dist` แล้ว → ข้าม build ได้)
- start preview: `node <webRoot>/node_modules/.bin/astro preview --port <p> --host 127.0.0.1` (หรือ `npm run preview -- --port <p> --host 127.0.0.1`). Vite/Next ใช้ `preview`/`start -p` ตามชนิด.
- poll จน port ฟัง (timeout ~20s).

### 1.4 screenshot (confirmed flags)
```
"<chrome>" --headless=new --disable-gpu --hide-scrollbars --no-sandbox \
  --window-size=1280,800 --virtual-time-budget=4000 \
  --screenshot="<imagePath>" "http://127.0.0.1:<port>/"
```
chrome path lookup: Chrome ก่อน → Edge (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`) เป็น fallback. ไม่มีทั้งคู่ → status `error` reason `no-headless-browser`.
เก็บภาพที่ `daemon/snapshots/<projectId>-<ts>.png`.

### 1.5 lifecycle ปลอดภัย (กฎเหล็ก)
- `POST /snapshot/run`: **try/finally** — ไม่ว่าจะ build/preview/screenshot fail ก็ต้อง **kill preview tree เสมอ** (`taskkill /T /F /PID <pid ที่ฟัง port>`), แล้วยืนยัน port ว่าง.
- preview ที่ start เพื่อ snapshot = อายุสั้น (start→shot→stop ภายในคำขอเดียว).
- **live preview** (`/snapshot/open {live:true}`): spin preview บน port โปรเจค + ตั้ง **TTL auto-stop** (ดีฟอลต์ 300s) ใน map `livePreviews[project]={child,port,expiresAt}`; เปิดซ้ำ = รีเซ็ต TTL; ต้อง kill ทั้งหมดตอน daemon ปิด (`process.on("exit")`/SIGINT) — ห้ามค้าง.

## 2. Endpoints (contract)

### `POST /snapshot/run`  body `{ project: "<id|path|name>" }`
ทำ build+preview+screenshot+stop แล้วบันทึก record + broadcast. ตอบ record:
```jsonc
{ "snapshotId":"snap…", "project":"p1781…", "projectName":"tookjorThai",
  "port":4571, "imagePath":"daemon/snapshots/p1781…-<ts>.png",
  "url":"/snapshots/img/p1781…-<ts>.png", "status":"ok"|"skipped"|"error",
  "reason":"", "ts":1781… }
```

### `GET /snapshots?project=<id|path|name|all>`
```jsonc
{ "snapshots":[ <record>, … ] }   // กรองตามโปรเจค; all/ว่าง = ทุกโปรเจค (ใหม่สุดก่อน)
```
(ใช้ตัว resolve โปรเจคแบบเดียวกับ `/jobs?project=` — id/path/name).

### `POST /snapshot/open`  body `{ snapshotId, live?:bool }`
- ปกติ → `{ url:"/snapshots/img/<file>" }` (ภาพเต็ม static).
- `live:true` → spin preview สดบน port โปรเจค (TTL) → `{ liveUrl:"http://127.0.0.1:<port>/", port, ttlSec:300 }`.

### static image: `GET /snapshots/img/<file>` → ไฟล์ PNG (content-type image/png).

### WS event
```jsonc
{ "type":"snapshot.ready", "snapshotId","project","projectName","url","status","ts" }
```
overlay ฟังใน `route(ev)` → เด้ง/อัปเดตการ์ด snapshot ของโปรเจคนั้น (แยกตามโปรเจค).

## 3. Frontend (White)
- การ์ด/แท็บ "📸 Snapshots" แยกตามโปรเจค: ปุ่ม "ถ่าย snapshot" ต่อโปรเจค → `POST /snapshot/run`.
- แสดง thumbnail (`url`), ชื่อโปรเจค, เวลา, status; คลิก = เปิดภาพเต็ม (`POST /snapshot/open`) หรือ "เปิด preview สด".
- ฟัง `snapshot.ready` เพื่อเติมการ์ดสด.
- โปรเจค non-web แสดง badge "skipped — non-web".

## 4. Storage
- `daemon/snapshots.json` = array ของ record (cap ~100 ล่าสุด).
- `daemon/snapshots/*.png` = ไฟล์ภาพ.

## 5. ทดสอบ (e2e)
สคริปต์ `tools/snapshot-e2e.js`:
1. `POST /snapshot/run {project:tookjorThai}` → status `ok` + `imagePath` มีไฟล์จริง (>1KB) **หรือ** `skipped` พร้อม reason (ไม่ fail แข็ง).
2. `GET /snapshots?project=<id>` มี record; `?project=<อื่น>` ไม่มี → แยกโปรเจคถูก.
3. หลังจบ: **ไม่มี process ฟังบน preview port** (ยืนยัน lifecycle ปลอด process ค้าง).
4. broadcast `snapshot.ready` ออก WS.

## 6. ความเสี่ยง
- Astro build ครั้งแรกของโปรเจคที่ยังไม่ build = ช้า (สิบวินาที–นาที) → ต้องมี timeout + คืน status `error`/`building` ไม่บล็อกยาว.
- หน้าเว็บที่ต้อง backend/API จริง อาจ render ไม่ครบใน preview (โชว์ skeleton) — เป็นภาพ "เปล่า/loading"; ปรับ `--virtual-time-budget` ช่วยได้บางส่วน.
- กฎเหล็ก: ทุก path ที่ start preview ต้องมี kill ใน finally + TTL — ถ้าพลาด = process ค้างบนเครื่อง CEO.
