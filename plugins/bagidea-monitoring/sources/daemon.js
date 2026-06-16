// 📈 source: daemon — health + version ของ daemon เอง (read-only).
// เจ้าภาพ: มิสเตอร์ N.  ดึงจาก GET /health และ GET /version (config.endpoints).
//
// SOURCE CONTRACT (ทุก source ใน sources/*.js ต้องคืน object รูปนี้จาก collect(api)):
//   { ok:boolean, status:"ok"|"warn"|"crit"|"down", detail:string,
//     data:object,                              // raw ดิบ เผื่อ downstream/hook ใช้
//     metrics:[ {key,label,value,unit,status} ] }   // flat สำหรับ panel + hook
// api = { cfg, client(get/postCmd), log, now }
module.exports = {
  id: "daemon",
  label: "Daemon",
  enabledKey: "daemon",

  async collect(api) {
    const { cfg, client } = api;
    const ep = cfg.endpoints || {};
    const [health, version] = await Promise.all([
      client.get(ep.health || "/health"),
      client.get(ep.version || "/version"),
    ]);

    // health ไม่ตอบ = ถือว่า daemon down (มองจากปลายทางนี้) — fail-open ไม่ throw
    if (health.error || !health.json) {
      return {
        ok: false, status: "down",
        detail: "GET " + (ep.health || "/health") + " ไม่ตอบ: " + (health.error || "body แปลก"),
        data: { health: null, version: version.json || null },
        metrics: [{ key: "daemon.up", label: "Daemon", value: 0, unit: "bool", status: "crit" }],
      };
    }

    const h = health.json;          // {clients,pendingPerms,wt}
    const v = version.json || null; // {version,latest,updateAvailable}
    const clients = Number(h.clients) || 0;
    const pending = Number(h.pendingPerms) || 0;
    const updateAvailable = !!(v && v.updateAvailable);

    // status: warn ถ้ามี permission ค้าง หรือมีอัปเดตค้าง; ปกติ = ok
    let status = "ok";
    const notes = [];
    if (pending > 0) { status = "warn"; notes.push(pending + " permission ค้าง"); }
    if (updateAvailable) { if (status === "ok") status = "warn"; notes.push("มีอัปเดต " + (v.latest || "?")); }

    return {
      ok: true, status,
      detail: notes.length ? notes.join(" · ") : ("ปกติ · " + clients + " client"),
      data: { health: h, version: v },
      metrics: [
        { key: "daemon.up", label: "Daemon", value: 1, unit: "bool", status: "ok" },
        { key: "daemon.clients", label: "Clients", value: clients, unit: "", status: "ok" },
        { key: "daemon.pendingPerms", label: "Perm ค้าง", value: pending, unit: "", status: pending > 0 ? "warn" : "ok" },
        { key: "daemon.watchtower", label: "Watchtower", value: h.wt ? 1 : 0, unit: "bool", status: "ok" },
        { key: "daemon.version", label: "Version", value: v ? v.version : "?", unit: "", status: updateAvailable ? "warn" : "ok" },
        { key: "daemon.updateAvailable", label: "อัปเดตค้าง", value: updateAvailable ? 1 : 0, unit: "bool", status: updateAvailable ? "warn" : "ok" },
      ],
    };
  },
};
