// merge-v0.7.16 routes e2e — proves the upstream v0.7.14→0.7.16 endpoints that
// were FUSED into our diverged server.js actually work, end-to-end, in a
// throwaway sandbox daemon. Covers:
//   • POST /proposals/dismiss   (v0.7.14, UI-gated bulk-clear)
//   • GET  /pluginshub          (v0.7.15, serves the hub page)
//   • GET  /plugins/catalog     (v0.7.15, live catalog + local fallback)
//   • POST /plugins/intent      (v0.7.16, bagidea:// confirm-first install)
//
// SANDBOX-SAFE: spawns its own daemon on a private port with watchers/watchdog/
// auto-resume DISABLED so it never spawns real agents or touches live :8787.
// The daemon's state (registry.json …) is __dirname-relative = this worktree,
// never the live app's data. Boots, asserts, then hard-kills the child.

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const PORT = 8799; // private sandbox port — NOT 8787 (live)
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (m) => { console.log("  ✓ " + m); pass++; };
const bad = (m, e) => { console.log("  ✗ " + m + " — " + (e && e.message || e)); fail++; };

function req(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const r = http.request(BASE + urlPath, {
      method,
      headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers },
      timeout: 8000,
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(new Error("timeout")); });
    if (data) r.write(data);
    r.end();
  });
}

async function waitUp(ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await req("GET", "/version"); if (r.status === 200) return true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("daemon did not come up on " + BASE);
}

(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "daemon", "server.js")], {
    cwd: path.join(ROOT, "daemon"),
    env: {
      ...process.env,
      OEP_PORT: String(PORT),
      BAGIDEA_NO_WATCH: "1",
      BAGIDEA_NO_WATCHDOG: "1",
      OEP_AUTO_RESUME: "0",
    },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  child.on("error", (e) => { console.error("spawn error", e); });

  const kill = () => { try { if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]); else child.kill("SIGKILL"); } catch {} };

  try {
    await waitUp();
    console.log("== merge-v0.7.16 fused routes ==");

    // v0.7.15 — Plugins Hub page
    let r = await req("GET", "/pluginshub");
    try { assert.strictEqual(r.status, 200); assert.ok(/plugin/i.test(r.body), "page mentions plugin"); ok("GET /pluginshub → 200 hub page"); }
    catch (e) { bad("GET /pluginshub", e); }

    // v0.7.15 — catalog (live fetch w/ local fallback → always valid JSON)
    r = await req("GET", "/plugins/catalog");
    try { assert.strictEqual(r.status, 200); const j = JSON.parse(r.body); assert.ok(Array.isArray(j.plugins), "plugins[] present"); ok(`GET /plugins/catalog → 200 JSON (${j.plugins.length} entries)`); }
    catch (e) { bad("GET /plugins/catalog", e); }

    // v0.7.16 — intent must be UI-gated
    r = await req("POST", "/plugins/intent", { body: { repo: "https://github.com/foo/bar" } });
    try { assert.strictEqual(r.status, 403); ok("POST /plugins/intent (no x-bagidea-ui) → 403"); }
    catch (e) { bad("POST /plugins/intent no-header 403", e); }

    // v0.7.16 — intent rejects junk repo url
    r = await req("POST", "/plugins/intent", { headers: { "x-bagidea-ui": "1" }, body: { repo: "not a url" } });
    try { assert.strictEqual(r.status, 400); ok("POST /plugins/intent (bad repo) → 400"); }
    catch (e) { bad("POST /plugins/intent bad-repo 400", e); }

    // v0.7.16 — intent accepts a real repo (broadcast only, no install)
    r = await req("POST", "/plugins/intent", { headers: { "x-bagidea-ui": "1" }, body: { repo: "https://github.com/bagidea/sample-plugin" } });
    try { assert.strictEqual(r.status, 200); assert.ok(JSON.parse(r.body).ok, "ok:true"); ok("POST /plugins/intent (good repo + UI) → 200 ok"); }
    catch (e) { bad("POST /plugins/intent good-repo 200", e); }

    // v0.7.14 — proposals/dismiss must be UI-gated
    r = await req("POST", "/proposals/dismiss", { body: { all: true } });
    try { assert.strictEqual(r.status, 403); ok("POST /proposals/dismiss (no x-bagidea-ui) → 403"); }
    catch (e) { bad("POST /proposals/dismiss no-header 403", e); }

    // v0.7.14 — proposals/dismiss with UI header succeeds (0 pending → dismissed:0)
    r = await req("POST", "/proposals/dismiss", { headers: { "x-bagidea-ui": "1" }, body: { all: true } });
    try { assert.strictEqual(r.status, 200); const j = JSON.parse(r.body); assert.ok(j.ok && typeof j.dismissed === "number"); ok(`POST /proposals/dismiss (UI) → 200 dismissed:${j.dismissed}`); }
    catch (e) { bad("POST /proposals/dismiss UI 200", e); }

  } catch (e) {
    bad("harness", e);
  } finally {
    kill();
    await new Promise((r) => setTimeout(r, 600));
  }

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})();
