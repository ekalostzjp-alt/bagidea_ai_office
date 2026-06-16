// 📈 BagIdea Monitoring — in-process HTTP client (loopback-first, fail-open).
// เจ้าภาพ: มิสเตอร์ N. data source ทุกตัวเรียกผ่านที่นี่ที่เดียว — จะได้คุม timeout,
// fail-open และ surface ความปลอดภัยจุดเดียว (อย่ายิง http ตรงๆ ใน source module).
//
// ความปลอดภัย (threat model สั้นๆ):
//   • ค่า baseUrl มาจาก config ของ "ผู้ดูแล" ไม่ใช่ input จากเว็บ → ไม่ใช่ SSRF จากผู้ใช้,
//     แต่ default = loopback (127.0.0.1) เสมอ. ถ้าตั้ง remote host ให้ log เตือน.
//   • ทุก request มี timeout + ไม่เคย throw ออกไป (คืน {error} แทน) → monitor ห้ามล่ม
//     เพราะปลายทางตัวเดียวค้าง.
const http = require("http");
const https = require("https");

// GET/POST แบบ low-level: คืน { status, body } หรือ { error } เสมอ — ไม่เคย reject.
function request(method, baseUrl, pathname, bodyObj, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let u;
    try { u = new URL(pathname, baseUrl); } catch { return finish({ error: "bad url: " + pathname }); }
    if (u.protocol !== "http:" && u.protocol !== "https:") return finish({ error: "unsupported protocol " + u.protocol });
    const lib = u.protocol === "https:" ? https : http;
    const data = bodyObj != null ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const headers = { "user-agent": "bagidea-monitoring" };
    if (data) { headers["content-type"] = "application/json"; headers["content-length"] = data.length; }
    const req = lib.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search, method, headers },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => finish({ status: res.statusCode, body: b }));
      }
    );
    req.on("error", (e) => finish({ error: e.message }));
    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ error: "timeout" }); });
    if (data) req.write(data);
    req.end();
  });
}

// คืน object client ผูกกับ baseUrl + timeout เดียว ส่งให้ source module ใช้ (api.get / api.postCmd)
function makeClient(baseUrl, timeoutMs) {
  const to = Number(timeoutMs) || 2500;
  return {
    baseUrl,
    // GET <baseUrl><path> → { status, json } | { error }
    async get(pathname) {
      const r = await request("GET", baseUrl, pathname, null, to);
      if (r.error) return { error: r.error };
      let json = null;
      try { json = JSON.parse(r.body); } catch {}
      return { status: r.status, json, body: r.body };
    },
    // POST <baseUrl>/plugin/<plugin>/cmd {cmd,args}  (ช่องทางเดียวกับที่ agent ใช้)
    async postCmd(plugin, cmd, args) {
      const r = await request("POST", baseUrl, `/plugin/${plugin}/cmd`, { cmd, args: args == null ? "" : args }, to);
      if (r.error) return { error: r.error };
      let json = null;
      try { json = JSON.parse(r.body); } catch {}
      return { status: r.status, json, body: r.body };
    },
  };
}

module.exports = { request, makeClient };
