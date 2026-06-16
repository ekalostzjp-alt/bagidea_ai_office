# Staged patch — render `iconText` ใน overlay.html (มิสเตอร์ N)

> สถานะ: **STAGED — ยังไม่ apply**
> เหตุผล: แบล็คกำลังแก้ `overlay.html` (บั๊กปุ่ม Token Usage) สดอยู่ → แตะตอนนี้ชนงานเขา
> (full-file write ทับกัน). apply พร้อมกับ `apply-character-lock.js --write` ตอน office idle / แบล็คออกจาก overlay.html แล้ว.

ส่วน `protected` (🔒 + ซ่อนปุ่มลบ + ป้าย "core staff") overlay.html รองรับอยู่แล้ว
(บรรทัด 3770, 4047, 4236) — ไม่ต้องแก้. patch นี้แค่เพิ่ม **render ของ iconText**.

## จุดที่ 1 — roster row (แท็บ Settings ▸ Agents, ~บรรทัด 3768)

หา:
```js
          `<div class="meta"><b>${a.name}</b><span>${a.role} · ${id}` +
```
แก้เป็น (prepend อีโมจิประจำตัวหน้าชื่อ):
```js
          `<div class="meta"><b>${a.iconText ? a.iconText + " " : ""}${a.name}</b><span>${a.role} · ${id}` +
```

## จุดที่ 2 — หัว editor (~บรรทัด 4236, เลือกทำหรือไม่ก็ได้)

หา:
```js
        <div class="uid">ID · ${id}${a.protected ? " · 🔒 core staff" : ""}</div>
```
แก้เป็น:
```js
        <div class="uid">${a.iconText ? a.iconText + " " : ""}ID · ${id}${a.protected ? " · 🔒 core staff" : ""}</div>
```

## ขั้นตอน deploy (ตอน idle เท่านั้น)
1. ยืนยันไม่มี run ค้าง: `POST /plugin/agent-status/cmd {"cmd":"board"}` → ทุกคน idle
2. `node daemon/apply-character-lock.js --write`   (ลง registry.json + .bak)
3. แก้ overlay.html 2 จุดข้างบน (Edit ทีละจุด)
4. restart daemon (loadReg อ่าน registry ใหม่เข้า memory)
5. ตรวจ: Settings ▸ Agents เห็น 🎬บาร์ท / 🛡มิสเตอร์ N / 🎨น้องไวท์ / ⚙แบล็ค / 🖌มูท + ทุกตัวมี 🔒, ปุ่มลบหาย
