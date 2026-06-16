// 📈 source: state-drift — รวม Daemon State Monitor เข้ามาในแผงเดียว (CEO สั่ง).
// เจ้าภาพ: มิสเตอร์ N.  ดึงผ่าน POST /plugin/daemon-state-monitor/cmd {cmd:"health"}.
// daemon-state-monitor คืน: { ok, overall:"ok"|"drift", checks:[{id,severity,state,detail}],
//                             version:{runtime,file}, build:{disk,served,clients} }
module.exports = {
  id: "state-drift",
  label: "State Drift",
  enabledKey: "state-drift",

  async collect(api) {
    const { cfg, client } = api;
    const cmdSpec = (cfg.endpoints && cfg.endpoints.stateDrift) || { plugin: "daemon-state-monitor", cmd: "health" };
    const r = await client.postCmd(cmdSpec.plugin, cmdSpec.cmd, "");

    if (r.error || !r.json) {
      return {
        ok: false, status: "down",
        detail: "daemon-state-monitor ไม่ตอบ: " + (r.error || "body แปลก"),
        data: null,
        metrics: [{ key: "drift.source", label: "Drift source", value: 0, unit: "bool", status: "crit" }],
      };
    }

    const p = r.json;
    const checks = Array.isArray(p.checks) ? p.checks : [];
    const drift = checks.filter((c) => c.state === "drift");
    const hasCrit = drift.some((c) => c.severity === "crit");
    const hasWarn = drift.some((c) => c.severity === "warn");

    // status: crit ถ้ามี drift severity crit; warn ถ้ามี drift อื่น; else ok
    let status = "ok";
    if (hasCrit) status = "crit";
    else if (drift.length) status = hasWarn ? "warn" : "warn";

    const detail = drift.length
      ? "drift: " + drift.map((c) => c.id + "(" + c.severity + ")").join(", ")
      : "ทุก check ปกติ";

    // metric ต่อ check (key คงที่ตาม id ของ check — panel/hook อ้างอิงได้)
    const checkMetrics = checks.map((c) => ({
      key: "drift." + c.id,
      label: c.id,
      value: c.state,                                 // ok|drift|error|unknown
      unit: "",
      status: c.state === "drift" ? (c.severity === "crit" ? "crit" : "warn") : "ok",
    }));

    return {
      ok: true, status,
      detail,
      // raw ทั้งก้อน: hook (แบล็ค) อยากเด้ง alert ตาม check.detail ได้เลย
      data: { overall: p.overall, checks, version: p.version || null, build: p.build || null },
      metrics: [
        { key: "drift.overall", label: "State", value: p.overall || "?", unit: "", status: drift.length ? (hasCrit ? "crit" : "warn") : "ok" },
        { key: "drift.count", label: "Drift checks", value: drift.length, unit: "", status: drift.length ? (hasCrit ? "crit" : "warn") : "ok" },
        ...checkMetrics,
      ],
    };
  },
};
