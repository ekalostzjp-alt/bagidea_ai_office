// hooks/alerts.js — จุดเสียบ "alerts" ของ BagIdea Monitoring. เจ้าภาพ: แบล็ค (Backend).
// ─────────────────────────────────────────────────────────────────────────────
// หน้าที่: อ่าน snapshot ที่ aggregator ประกอบเสร็จแล้ว (sources + metrics) แล้ว derive
// เป็น "alert" ที่ดำเนินการได้. แพทเทิร์นเดียวกับ daemon-state-monitor:
//   • read-only   — อ่าน snapshot อย่างเดียว, ไม่ mutate ของที่รับมา, ไม่เขียน state นอก dataDir
//   • fail-open   — ไม่ throw เด็ดขาด; กฎไหนพังให้ข้ามกฎนั้น ปล่อยกฎอื่นทำงานต่อ
//   • stateless   — loader ลบ require.cache ทุก snapshot (ดู lib/aggregate.js) → state ใน
//                   module หายทุกครั้ง. จึง "ไม่" พึ่ง throttle ในหน่วยความจำ; แทนที่ด้วย
//                   alert.id ที่คงที่ต่อเงื่อนไข → consumer (panel/feed) dedup ตาม id เองได้.
//
// กฎเริ่มต้น (ขั้นต่ำตามที่ CEO สั่ง + ส่วนเสริมที่ actionable):
//   crit  daemon down ........... daemon ไม่ตอบ /health
//   crit  agents.stuck > 0 ...... มี agent ค้าง
//   crit  agents.timedOut > 0 ... มี agent heartbeat เงียบเกิน threshold (ราย agent)
//   crit  collision block ....... agent-status เตือน block (จองชนกันระดับ block)
//   crit  drift check crit ...... state-drift มี check drift ระดับ crit (ราย check)
//   warn  drift check warn ...... state-drift มี check drift ระดับ warn (ราย check)
//   warn  daemon.updateAvailable  มีอัปเดต daemon ค้าง
//   warn  daemon.pendingPerms>0   มี permission ค้างรออนุมัติ
//   warn  source down ........... data source (agents/state-drift) ติดต่อไม่ได้ = จุดบอด monitor
//
// alert shape (ตาม HOOK CONTRACT): { id, severity:"info"|"warn"|"crit", source, title, detail, ts }
// aggregator จะเติม field `hook` ให้เอง และม้วน severity เข้า health รวม.
module.exports = {
  id: "alerts",

  async analyze(snapshot, api) {
    const alerts = [];
    const now = (snapshot && snapshot.ts) || (api && api.now) || 0;
    const sources = (snapshot && snapshot.sources) || {};

    // helper: ดึง data ของ source แบบปลอดภัย (source อาจถูกปิดผ่าน config = ไม่มี key)
    const src = (id) => sources[id] || null;
    const dataOf = (id) => { const s = src(id); return s && s.data ? s.data : null; };
    const push = (a) => alerts.push({ ts: now, ...a });

    // แต่ละกฎห่อ try/catch ของตัวเอง: กฎเดียวพังห้ามลากกฎอื่นล้ม (fail-open จริง ไม่พึ่ง aggregator)
    const rule = (fn) => { try { fn(); } catch (e) { try { api && api.log && api.log("alerts rule error: " + e.message); } catch {} } };

    // ── daemon: down / update / permission ค้าง ───────────────────────────────
    rule(() => {
      const d = src("daemon");
      if (!d) return;                                   // source ปิด → ไม่ตัดสิน
      if (d.status === "down" || d.ok === false) {
        push({ id: "daemon-down", severity: "crit", source: "daemon",
          title: "Daemon ไม่ตอบ", detail: d.detail || "GET /health ไม่ตอบ" });
        return;                                         // down แล้ว version/perm ไม่มีความหมาย
      }
      const v = (d.data && d.data.version) || null;
      if (v && v.updateAvailable) {
        push({ id: "daemon-update", severity: "warn", source: "daemon",
          title: "มีอัปเดต daemon ค้าง", detail: "เวอร์ชันล่าสุด " + (v.latest || "?") + " (ปัจจุบัน " + (v.version || "?") + ")" });
      }
      const h = (d.data && d.data.health) || null;
      const pending = h ? Number(h.pendingPerms) || 0 : 0;
      if (pending > 0) {
        push({ id: "daemon-pending-perms", severity: "warn", source: "daemon",
          title: pending + " permission ค้างรออนุมัติ", detail: "มีคำขอสิทธิ์ค้างใน daemon รอผู้ใช้อนุมัติ" });
      }
    });

    // ── agents: stuck / timedOut(ราย agent) / collision block ──────────────────
    rule(() => {
      const a = src("agents");
      if (!a) return;
      if (a.status === "down" || a.ok === false) {
        push({ id: "source-down:agents", severity: "warn", source: "agents",
          title: "Agent source ติดต่อไม่ได้", detail: a.detail || "agent-status ไม่ตอบ — monitor มองไม่เห็นสถานะ agent" });
        return;
      }
      const data = a.data || {};
      const counts = data.counts || {};
      const list = Array.isArray(data.agents) ? data.agents : [];

      if (Number(counts.stuck) > 0) {
        const names = list.filter((x) => String(x.state || "").toLowerCase() === "stuck")
          .map((x) => x.name || x.id).filter(Boolean);
        push({ id: "agents-stuck", severity: "crit", source: "agents",
          title: counts.stuck + " agent ค้าง", detail: names.length ? names.join(", ") : "มี agent อยู่สถานะ stuck" });
      }

      // ราย agent ที่ timeout → id คงที่ต่อ agent (consumer dedup/clear ตาม id ได้)
      for (const x of list) {
        if (!x || !x.timedOut) continue;
        push({ id: "agent-timeout:" + (x.id || x.name || "?"), severity: "crit", source: "agents",
          title: "Agent timeout: " + (x.name || x.id || "?"),
          detail: (x.project ? "โปรเจค " + x.project + " — " : "") + "heartbeat เงียบเกิน threshold" });
      }

      // collision board: block-severity = มีคนจองชนกันระดับ block (ต้องเคลียร์ก่อนเดินต่อ)
      const warnings = Array.isArray(data.warnings) ? data.warnings : [];
      const blocks = warnings.filter((w) => w && w.severity === "block");
      if (blocks.length) {
        push({ id: "agents-collision-block", severity: "crit", source: "agents",
          title: blocks.length + " collision ระดับ block", detail: "มีการจอง/แก้ไฟล์ชนกันระดับ block บนบอร์ด agent-status" });
      }
    });

    // ── state-drift: ราย check ที่ drift (severity ตาม check) ───────────────────
    rule(() => {
      const sd = src("state-drift");
      if (!sd) return;
      if (sd.status === "down" || sd.ok === false) {
        push({ id: "source-down:state-drift", severity: "warn", source: "state-drift",
          title: "State-drift source ติดต่อไม่ได้", detail: sd.detail || "daemon-state-monitor ไม่ตอบ — ไม่เห็น drift" });
        return;
      }
      const data = sd.data || {};
      const checks = Array.isArray(data.checks) ? data.checks : [];
      for (const c of checks) {
        if (!c || c.state !== "drift") continue;
        const crit = c.severity === "crit";
        push({ id: "drift:" + (c.id || "?"), severity: crit ? "crit" : "warn", source: "state-drift",
          title: "State drift: " + (c.id || "?"), detail: c.detail || ("drift ระดับ " + (c.severity || "warn")) });
      }
    });

    return { alerts };
  },
};
