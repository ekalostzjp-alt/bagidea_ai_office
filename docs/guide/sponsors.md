# การสนับสนุน (Sponsors & Partners)

BagIdea Office เป็นโอเพนซอร์สและใช้ฟรี การสนับสนุนช่วยทุนพัฒนา ค่าลิขสิทธิ์อาร์ต
และ backend ข้ามแพลตฟอร์ม — และทำให้โปรแกรมยังฟรีต่อไป ชื่อ/โลโก้ของผู้สนับสนุน
จะแสดงบน [เว็บ official](https://bagidea.com/#sponsors) และใน README ของ repo

> **ภาพรวมสั้นๆ:** การสนับสนุนเป็น **สมาชิกรายเดือนผ่าน GitHub Sponsors ทั้งหมด**
> (เหมือนสมาชิก YouTube / Patreon) — การจ่ายเงิน ภาษี และ payout เป็นหน้าที่ของ
> GitHub ไม่ใช่เรา เราแค่ดึง "ชื่อ + โลโก้ + ลิงก์" มาแสดงอัตโนมัติ

## Tier (ตามยอดต่อเดือน)

| Tier | ยอด/เดือน | ได้อะไร |
|---|---|---|
| 👑 **Gold Partner** | $3,000+ | โลโก้ใหญ่ตำแหน่งบนสุด (เว็บ + README + เครดิตในแอป) · ร่วมกำหนด roadmap · ขอบคุณใน release notes |
| 🥈 **Silver Partner** | $300+ | โลโก้บนเว็บ + README · กล่าวถึงใน release notes · เข้าถึง build ก่อนใคร |
| 🥉 **Bronze / Backer** | $30+ | โลโก้หรือชื่อ + ลิงก์ บนกำแพงผู้สนับสนุน |
| 💛 **Supporter** | เท่าไหร่ก็ได้ | ชื่อ + ลิงก์ บนกำแพงผู้สนับสนุน |

ทุก tier ได้ **ลิงก์คลิกได้ไปเว็บ/โซเชียลของตัวเอง** เสมอ · เรียงตามยอดมากไปน้อยอัตโนมัติ
· **ไม่แสดงตัวเลขยอด** ที่ไหนทั้งสิ้น

## ขั้นตอนสำหรับผู้ที่อยากสนับสนุน

1. **เลือก tier แล้วกดสนับสนุน** — กดปุ่ม **💖 Sponsor on GitHub** บนเว็บ
   (หรือไป [github.com/sponsors/bagidea](https://github.com/sponsors/bagidea) ตรงๆ)
   เลือก tier รายเดือน แล้วยืนยัน GitHub จะตัดเงินทุกเดือนจนกว่าจะยกเลิก
2. **โลโก้และลิงก์ดึงจากโปรไฟล์ GitHub อัตโนมัติ** — รูป avatar ชื่อ และลิงก์
   ของผู้สนับสนุน ดึงจากบัญชี GitHub ของเขาเองโดยตรง **ไม่ต้องส่งอะไรมาให้เรา**
   - อยากกำหนดลิงก์เอง → ตั้งช่อง **Website** ในโปรไฟล์ GitHub (*Settings → Public profile*)
   - เป็นบริษัท → สนับสนุนในนาม **GitHub Organization** จะได้โลโก้ + เว็บบริษัท
3. **ชื่อขึ้นภายใน ~6 ชั่วโมง** — ขอแค่เลือก **"Make my sponsorship public"** ตอนจ่าย
   ระบบอัตโนมัติจะเพิ่มชื่อขึ้นกำแพงผู้สนับสนุนบนเว็บ + README ให้เอง (คนที่ตั้ง Private
   จะไม่ถูกแสดง ตามความเป็นส่วนตัว)

## ระบบทำงานเบื้องหลังยังไง

```
คนกด Sponsor (เว็บ / repo / profile)
   → GitHub Sponsors ตัดเงินรายเดือน
   → GitHub Action (.github/workflows/sponsors.yml) รันทุก 6 ชม.
   → ดึงรายชื่อ public ผ่าน GitHub Sponsors GraphQL API
   → จัด tier ตามยอด + merge กับรายชื่อนอกแพลตฟอร์ม
   → เขียน web/sponsors.json + บล็อกใน README
   → GitHub Pages redeploy → ขึ้นกำแพงบนเว็บ + README
```

ไฟล์ที่เกี่ยวข้อง:

| ไฟล์ | หน้าที่ |
|---|---|
| `web/sponsors.json` | **(generated — ห้ามแก้มือ)** ข้อมูลที่เว็บใช้ render |
| `web/sponsors.manual.json` | **แก้มือได้** — ผู้สนับสนุนนอกแพลตฟอร์ม (partner / โอนตรง) |
| `web/assets/sponsors.js` | render กำแพงบนเว็บ (โลโก้ → ชื่อ → avatar-chip ตาม tier) |
| `scripts/sync-sponsors.mjs` | ดึงจาก GitHub Sponsors + merge + เขียนไฟล์ |
| `.github/workflows/sponsors.yml` | รัน sync ทุก 6 ชม. + กดเองได้ + commit เมื่อมีการเปลี่ยน |
| `.github/FUNDING.yml` | ปุ่ม 💖 Sponsor บนหน้า repo |

## ผู้สนับสนุนนอกแพลตฟอร์ม (ข้อยกเว้น)

โดยปกติ **ทุกคนสนับสนุนผ่าน GitHub Sponsors** เพื่อให้ระบบทำงานอัตโนมัติเต็มที่
ข้อยกเว้นมีเฉพาะ:

- **WARRIX** — พาร์ตเนอร์หลัก แสดงด้วยมือใน `web/sponsors.manual.json` และ **pin อันดับ 1 เสมอ**
- **Reuannamphung** — จ่ายตรงมาก่อน แสดงให้ชั่วคราว **จนกว่าจะย้ายไปใช้ GitHub Sponsors**

วิธีเพิ่ม/แก้ผู้สนับสนุนนอกแพลตฟอร์ม (สำหรับผู้ดูแล):

1. โหลดโลโก้มาเก็บใน `web/img/sponsors/` (**ห้าม hotlink URL จาก CDN/Facebook** — มันหมดอายุ)
2. เพิ่ม object ใน `web/sponsors.manual.json`:
   ```json
   { "name": "ชื่อ", "tier": "supporter", "weight": 5,
     "url": "https://ลิงก์", "logo": "img/sponsors/ไฟล์.png", "since": "2026-06" }
   ```
   - `weight` = เลขไว้จัดเรียงเท่านั้น (ไม่แสดง) ใส่เท่าไหร่ก็ได้
   - ระบบ sync จะ merge ให้ ไม่ทับกับ GitHub sponsors

> ⚠️ **ห้ามแก้ `web/sponsors.json` ด้วยมือ** — มันถูก generate ทับทุกครั้งที่ sync
> แก้ที่ `web/sponsors.manual.json` เท่านั้นสำหรับรายชื่อนอกแพลตฟอร์ม

## ตั้งค่าครั้งเดียว (ผู้ดูแล)

1. เปิด GitHub Sponsors ที่ [github.com/sponsors](https://github.com/sponsors) → สร้าง
   tier รายเดือนที่ยอด **$5 / $30 / $300 / $3,000** → **Publish** ทุก tier
2. สร้าง **classic PAT** ของบัญชี (scope **`read:user` + `read:org`** — ต้องมีทั้งสอง
   เพราะ sponsor อาจเป็น Organization) → ใส่เป็น repo secret ชื่อ **`SPONSORS_TOKEN`**
3. รัน workflow **"Sync sponsors"** ในแท็บ Actions หนึ่งครั้งเพื่อทดสอบ
