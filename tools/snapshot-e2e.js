#!/usr/bin/env node
// Per-Project Preview Snapshot — end-to-end test (zero dependency).
//
//   node tools/snapshot-e2e.js [port]      (default 8787)
//
// Runs a real snapshot of tookjorThai and asserts: a record is produced, it is
// tagged to the right project (and excluded from others), the image is fetchable
// (when status=ok), a snapshot.ready broadcast fires, and — critically — NO
// preview process is left listening on the project port. Exit 0 = pass.
// See docs/per-project-preview-snapshot.contract.md.

const http = require("http");
const net = require("net");

const PORT = Number(process.argv[2] || process.env.OEP_PORT || 8787);
const HOST = "127.0.0.1";
const PASS = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const FAIL = (m) => { console.log("  \x1b[31m✗\x1b[0m " + m); process.exitCode = 1; };

function httpJson(method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: HOST, port: PORT, path, method,
      headers: { "x-bagidea-ui": "1",
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } },
      (res) => { const ch = []; res.on("data", (d) => ch.push(d));
        res.on("end", () => { const t = Buffer.concat(ch).toString("utf8");
          try { resolve({ status: res.statusCode, json: JSON.parse(t), len: t.length }); }
          catch { resolve({ status: res.statusCode, json: null, text: t, len: t.length }); } }); });
    req.on("error", reject);
    req.setTimeout(timeoutMs || 15000, () => req.destroy(new Error("timeout")));
    if (data) req.write(data);
    req.end();
  });
}
function httpHead(path) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port: PORT, path, method: "GET",
      headers: { "x-bagidea-ui": "1" } }, (res) => {
      let n = 0; res.on("data", (d) => (n += d.length));
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], len: n }));
    });
    req.on("error", () => resolve({ status: 0 }));
    req.setTimeout(15000, () => req.destroy());
    req.end();
  });
}
// returns true if SOMETHING is listening on the port (i.e. a leftover preview)
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}
function drainFrames(buf, onText) {
  let off = 0;
  while (off + 2 <= buf.length) {
    const b1 = buf[off + 1]; let len = b1 & 0x7f, hdr = 2;
    if (len === 126) { if (off + 4 > buf.length) break; len = buf.readUInt16BE(off + 2); hdr = 4; }
    else if (len === 127) { if (off + 10 > buf.length) break; len = Number(buf.readBigUInt64BE(off + 2)); hdr = 10; }
    if (off + hdr + len > buf.length) break;
    if ((buf[off] & 0x0f) === 0x1) onText(buf.slice(off + hdr, off + hdr + len).toString("utf8"));
    off += hdr + len;
  }
  return buf.slice(off);
}

(async () => {
  console.log(`\n  Per-Project Preview Snapshot — e2e against http://${HOST}:${PORT}\n`);

  const pr = await httpJson("GET", "/projects").catch(() => null);
  const projects = pr && pr.json && pr.json.projects || [];
  const tj = projects.find((p) => /tookjor/i.test(p.name));
  if (!tj) { FAIL("tookjorThai project not registered"); process.exit(1); }
  PASS(`target project = ${tj.name} (${tj.id})`);

  // pre-check endpoint exists
  const probe = await httpJson("GET", "/snapshots?project=all").catch(() => null);
  if (!probe || probe.status === 404) { FAIL("GET /snapshots not implemented yet (Black not done)"); process.exit(1); }
  PASS("GET /snapshots responds");

  // WS subscribe (capture snapshot.ready)
  const seen = [];
  const http2 = require("http");
  const crypto = require("crypto");
  const wsReq = http2.request({ host: HOST, port: PORT, path: "/ws",
    headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64") } });
  let sock = null;
  wsReq.on("upgrade", (res, s) => { sock = s; let acc = Buffer.alloc(0);
    s.on("data", (c) => { acc = drainFrames(Buffer.concat([acc, c]), (t) => {
      try { const e = JSON.parse(t); if (e.type === "snapshot.ready") seen.push(e); } catch {} }); });
    s.on("error", () => {}); });
  wsReq.on("error", () => {});
  wsReq.end();
  await new Promise((r) => setTimeout(r, 500));

  // RUN snapshot (build+preview+screenshot+stop) — allow up to 150s
  console.log("  … running snapshot (build+preview+screenshot, up to 150s)");
  let run;
  try { run = await httpJson("POST", "/snapshot/run", { project: tj.id }, 150000); }
  catch (e) { FAIL("POST /snapshot/run failed: " + e.message); if (sock) sock.destroy(); process.exit(1); }
  if (run.status !== 200 || !run.json) { FAIL(`POST /snapshot/run → ${run.status} ${run.text || ""}`); if (sock) sock.destroy(); process.exit(1); }
  const rec = run.json;
  PASS(`snapshot ran → status=${rec.status} project=${rec.projectName} port=${rec.port || "-"}`);

  if (!["ok", "skipped", "error"].includes(rec.status)) FAIL("status must be ok|skipped|error");
  if (rec.project !== tj.id) FAIL(`record.project should be ${tj.id} (got ${rec.project})`);
  else PASS("record tagged to the right project");

  if (rec.status === "ok") {
    if (!rec.url) FAIL("status ok but no url");
    else { const img = await httpHead(rec.url);
      if (img.status === 200 && img.len > 1000) PASS(`image fetchable (${img.len}B, ${img.type})`);
      else FAIL(`image not fetchable (status ${img.status}, ${img.len}B)`); }
  } else { PASS(`status=${rec.status} (${rec.reason || "no reason"}) — accepted, no image expected`); }

  // project separation
  const mine = await httpJson("GET", `/snapshots?project=${encodeURIComponent(tj.id)}`);
  const has = (mine.json && mine.json.snapshots || []).some((s) => s.snapshotId === rec.snapshotId);
  if (has) PASS("appears under its own project filter"); else FAIL("missing from its own project filter");
  const other = await httpJson("GET", "/snapshots?project=__none__");
  const leak = (other.json && other.json.snapshots || []).some((s) => s.snapshotId === rec.snapshotId);
  if (!leak) PASS("excluded from a different project filter"); else FAIL("leaked into another project's filter");

  // broadcast
  await new Promise((r) => setTimeout(r, 400));
  if (seen.some((e) => e.snapshotId === rec.snapshotId)) PASS("snapshot.ready broadcast received");
  else FAIL("no snapshot.ready broadcast for this snapshot");

  // CRITICAL: no leftover preview process on the project port
  if (rec.port) {
    const open = await portOpen(rec.port);
    if (!open) PASS(`no leftover preview process on port ${rec.port}`);
    else FAIL(`preview STILL listening on port ${rec.port} — process leak!`);
  } else PASS("no preview port used (skipped/non-web) — nothing to leak");

  if (sock) sock.destroy();
  const ok = process.exitCode !== 1;
  console.log("\n  " + (ok ? "\x1b[32mRESULT: PASS\x1b[0m" : "\x1b[31mRESULT: FAIL\x1b[0m") + "\n");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log("  \x1b[31m✗\x1b[0m fatal: " + e.message); process.exit(1); });
