// 📈 source: agents — roster + claims + queue + collision จาก plugin agent-status.
// เจ้าภาพ: มิสเตอร์ N.  ดึงผ่าน POST /plugin/agent-status/cmd {cmd:"status"} (ช่องทางเดียวกับ agent).
// payload contract ของ agent-status: ดู plugins/agent-status/index.js หัวไฟล์.
module.exports = {
  id: "agents",
  label: "Agents & Chat",
  enabledKey: "agents",

  async collect(api) {
    const { cfg, client } = api;
    const cmdSpec = (cfg.endpoints && cfg.endpoints.agentStatus) || { plugin: "agent-status", cmd: "status" };
    const r = await client.postCmd(cmdSpec.plugin, cmdSpec.cmd, "");

    if (r.error || !r.json || r.json.ok !== true) {
      return {
        ok: false, status: "down",
        detail: "agent-status ไม่ตอบ: " + (r.error || "body แปลก"),
        data: null,
        metrics: [{ key: "agents.source", label: "Agent source", value: 0, unit: "bool", status: "crit" }],
      };
    }

    const p = r.json;                         // {agents,claims,queue,warnings,liveSource,thresholdMs,...}
    const agents = Array.isArray(p.agents) ? p.agents : [];
    const claims = Array.isArray(p.claims) ? p.claims : [];
    const queue = Array.isArray(p.queue) ? p.queue : [];
    const warnings = Array.isArray(p.warnings) ? p.warnings : [];

    const counts = { total: agents.length, working: 0, idle: 0, stuck: 0, timedOut: 0 };
    for (const a of agents) {
      const st = String(a.state || "idle").toLowerCase();
      if (st === "working") counts.working++;
      else if (st === "stuck") counts.stuck++;
      else counts.idle++;
      if (a.timedOut) counts.timedOut++;
    }
    const blockW = warnings.filter((w) => w.severity === "block").length;
    const warnW = warnings.filter((w) => w.severity === "warn").length;
    const liveDown = p.liveSource === "down";

    // status: crit ถ้ามี stuck/timedOut/block หรือ live source ล่ม; warn ถ้ามี warn-collision; else ok
    let status = "ok";
    if (counts.stuck || counts.timedOut || blockW || liveDown) status = "crit";
    else if (warnW) status = "warn";

    const parts = [counts.working + " ทำงาน / " + counts.idle + " ว่าง"];
    if (counts.stuck) parts.push(counts.stuck + " ค้าง");
    if (counts.timedOut) parts.push(counts.timedOut + " timeout");
    if (blockW || warnW) parts.push(blockW + " block / " + warnW + " warn");
    if (liveDown) parts.push("live down");

    return {
      ok: true, status,
      detail: parts.join(" · "),
      // ส่ง raw ทั้งก้อนให้ downstream/hook (ไวท์ต้องใช้ agents[] ดิบทำ anomaly)
      data: { agents, claims, queue, warnings, counts, thresholdMs: p.thresholdMs, liveSource: p.liveSource, ts: p.ts },
      metrics: [
        { key: "agents.total", label: "Agents", value: counts.total, unit: "", status: "ok" },
        { key: "agents.working", label: "ทำงาน", value: counts.working, unit: "", status: "ok" },
        { key: "agents.idle", label: "ว่าง", value: counts.idle, unit: "", status: "ok" },
        { key: "agents.stuck", label: "ค้าง", value: counts.stuck, unit: "", status: counts.stuck ? "crit" : "ok" },
        { key: "agents.timedOut", label: "Timeout", value: counts.timedOut, unit: "", status: counts.timedOut ? "crit" : "ok" },
        { key: "agents.claims", label: "Claims", value: claims.length, unit: "", status: "ok" },
        { key: "agents.queue", label: "Queue", value: queue.length, unit: "", status: queue.length ? "warn" : "ok" },
        { key: "agents.warnBlock", label: "Block", value: blockW, unit: "", status: blockW ? "crit" : "ok" },
        { key: "agents.warnWarn", label: "Warn", value: warnW, unit: "", status: warnW ? "warn" : "ok" },
      ],
    };
  },
};
