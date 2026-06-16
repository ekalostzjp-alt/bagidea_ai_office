# hooks/ — จุดเสียบ alerts (แบล็ค) + anomaly (น้องไวท์)

aggregator (`lib/aggregate.js`) จะ **auto-discover** ทุกไฟล์ `hooks/*.js`
(ยกเว้นไฟล์ `*.sample.js` และไฟล์ที่ขึ้นต้นด้วย `_`) แล้วเรียก `analyze(snapshot, api)`
หลังประกอบ snapshot เสร็จ. ผลที่คืนจะถูก merge เข้า `snapshot.alerts` / `snapshot.anomalies`.

**ไม่มีใครต้องแก้ `index.js` หรือ `lib/*`** — แต่ละเลนสร้างไฟล์ของตัวเอง ไม่ชนกัน:

| เลน | ไฟล์ที่สร้าง | คืนค่า |
|---|---|---|
| แบล็ค (alerts)     | `hooks/alerts.js`  | `{ alerts: [...] }` |
| น้องไวท์ (anomaly) | `hooks/anomaly.js` | `{ anomalies: [...] }` |

ดูตัวอย่างที่รันได้จริงใน `alerts.sample.js` และ `anomaly.sample.js`
(เปลี่ยนชื่อให้ตัด `.sample` ออกเมื่อพร้อมเปิดใช้).

## HOOK CONTRACT

```js
module.exports = {
  id: "alerts",                          // ชื่อสั้นๆ (โผล่ใน field hook ของแต่ละ alert)
  async analyze(snapshot, api) {
    // snapshot = { ts, sources:{daemon,agents,"state-drift"}, metrics:[...],
    //              alerts:[], anomalies:[], health }   ← ก่อน hook (read-only; อย่า mutate)
    // api      = { cfg, client:{get,postCmd}, log, now }
    return {
      alerts: [
        { id, severity:"info"|"warn"|"crit", source, title, detail, ts }
      ],
      // หรือ anomalies: [ { id, severity, source, title, detail, score?, ts } ]
    };
  }
};
```

### snapshot ที่ hook ได้รับ (ของจริงในเฟส 1)
- `snapshot.sources.daemon.data`     = `{ health:{clients,pendingPerms,wt}, version:{version,latest,updateAvailable} }`
- `snapshot.sources.agents.data`     = `{ agents:[], claims:[], queue:[], warnings:[], counts:{total,working,idle,stuck,timedOut}, thresholdMs, liveSource, ts }`
- `snapshot.sources["state-drift"].data` = `{ overall, checks:[{id,severity,state,detail}], version:{runtime,file}, build:{disk,served,clients} }`
- `snapshot.metrics`                 = flat `[{key,label,value,unit,status,source}]` — ทุก source รวมกัน

### กฎ (สำคัญ)
- **อย่า throw** — aggregator จับ error แล้วข้าม hook ตัวนั้น (fail-open) แต่อย่าพึ่ง.
- **อย่า mutate** `snapshot` ที่รับมา — อ่านอย่างเดียว, คืนของใหม่.
- มี timeout (`cfg.timeoutMs + 1500ms`) ต่อ hook — งานหนัก (เช่นเรียก AI ของไวท์) ให้ใส่ timeout เองด้วย.
- เก็บ state ส่วนตัว (เช่น dedup ของแบล็ค, baseline ของไวท์) ที่ `ctx.dataDir` — **ไม่เขียนไฟล์ของ source/เลนอื่น**.
  (hook เข้าถึง dataDir ผ่าน closure ได้ ถ้าต้องการ ให้ขอ N เพิ่ม field ลง `api` — ตอนนี้ api มี cfg/client/log/now)
