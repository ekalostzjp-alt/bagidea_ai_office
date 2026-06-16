// hooks/alerts.sample.js — ตัวอย่างจุดเสียบ "alerts" (เจ้าภาพเฟสถัดไป: แบล็ค).
// เปิดใช้จริง: คัดลอกเป็น hooks/alerts.js (loader ข้าม *.sample.js).
// หน้าที่: อ่าน snapshot แล้วยกระดับเป็น "alert" ที่ดำเนินการได้ (พร้อม dedup/throttle เองที่ ctx.dataDir).
module.exports = {
  id: "alerts",
  async analyze(snapshot, api) {
    const alerts = [];
    const now = snapshot.ts || api.now;

    // ตัวอย่างกฎ 1: agent timeout → alert (ข้อมูลมาจาก source agents)
    const agents = (snapshot.sources.agents && snapshot.sources.agents.data) || {};
    for (const a of agents.agents || []) {
      if (a.timedOut) {
        alerts.push({
          id: "agent-timeout:" + a.id,
          severity: "crit", source: "agents",
          title: "Agent timeout: " + (a.name || a.id),
          detail: (a.project ? "โปรเจค " + a.project + " — " : "") + "heartbeat เงียบเกิน threshold",
          ts: now,
        });
      }
    }

    // ตัวอย่างกฎ 2: state drift ระดับ crit → alert (ข้อมูลมาจาก source state-drift)
    const drift = (snapshot.sources["state-drift"] && snapshot.sources["state-drift"].data) || {};
    for (const c of drift.checks || []) {
      if (c.state === "drift" && c.severity === "crit") {
        alerts.push({ id: "drift:" + c.id, severity: "crit", source: "state-drift",
          title: "State drift: " + c.id, detail: c.detail, ts: now });
      }
    }

    // TODO (แบล็ค): dedup/throttle (อย่าเด้งซ้ำทุก poll), ส่งออกช่องทางจริง (feed/integration-hub),
    //               persist สถานะ alert ที่ ctx.dataDir/alerts-state.json (atomic tmp+rename).
    return { alerts };
  },
};
