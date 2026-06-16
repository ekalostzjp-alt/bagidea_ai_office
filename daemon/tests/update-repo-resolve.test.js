// update-repo-resolve.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Regression for the configurable update-source resolver (updateRepo()).
//
// Extracts the REAL updateRepo() source from daemon/server.js and runs it in a
// vm with a controlled process.env + __dirname, proving the 3-tier contract:
//   (a) no env, origin = canonical clone  → bagidea/bagidea-office @ main (LEGACY)
//   (b) BAGIDEA_UPDATE_REPO=owner/repo     → that repo @ main
//       …and owner/repo#branch             → honours the branch
//   (c) no env, origin = a made-up github  → derived owner/repo
//   (d) no env, NOT a git repo             → fallback bagidea/bagidea-office
// Also asserts the checkUpdate() path is built as /${repo}/${branch}/VERSION,
// i.e. the canonical case reproduces the old hard-coded path BYTE-FOR-BYTE.
//
// Run:  node daemon/tests/update-repo-resolve.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const cp = require("child_process");

const SERVER = path.join(__dirname, "..", "server.js");
const src = fs.readFileSync(SERVER, "utf8");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

// ── pull the exact updateRepo() block (and its _updateRepo cache) from source ──
const start = src.indexOf("let _updateRepo = null;");
const end = src.indexOf("function checkUpdate()");
ok(start >= 0 && end > start, "found updateRepo() block in server.js");
const block = src.slice(start, end);

// Build the checkUpdate path the SAME way server.js does, to prove the wiring.
function pathFor(repo, branch) { return "/" + repo + "/" + branch + "/VERSION"; }

// Run the extracted block in a fresh vm with a controlled env + __dirname, then
// return updateRepo()'s result. Fresh context each call → the cache never leaks.
function resolveWith({ env, dir }) {
  const sandbox = {
    process: { env: env || {} },
    require,                  // real require → real child_process/git
    __dirname: dir,
    console: { log: () => {}, error: () => {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(block + "\n;globalThis.__out = updateRepo();", sandbox, { filename: "updateRepo.js" });
  return sandbox.__out;
}

// ── (a) canonical clone, no env → legacy target, byte-for-byte path ──────────
console.log("a) no env + canonical origin → legacy bagidea/bagidea-office @ main");
const realDir = path.join(__dirname, "..");      // the daemon dir of THIS clone
const a = resolveWith({ env: {}, dir: realDir });
ok(a.repo === "bagidea/bagidea-office" && a.branch === "main",
  "resolves bagidea/bagidea-office @ main (got " + a.repo + " @ " + a.branch + ")");
ok(pathFor(a.repo, a.branch) === "/bagidea/bagidea-office/main/VERSION",
  "path is the EXACT legacy /bagidea/bagidea-office/main/VERSION");

// ── (b) explicit env override ────────────────────────────────────────────────
console.log("b) BAGIDEA_UPDATE_REPO override");
const b1 = resolveWith({ env: { BAGIDEA_UPDATE_REPO: "someone/new-repo" }, dir: realDir });
ok(b1.repo === "someone/new-repo" && b1.branch === "main",
  "owner/repo → someone/new-repo @ main");
ok(pathFor(b1.repo, b1.branch) === "/someone/new-repo/main/VERSION",
  "checkUpdate would GET /someone/new-repo/main/VERSION");
const b2 = resolveWith({ env: { BAGIDEA_UPDATE_REPO: "acme/office#dev" }, dir: realDir });
ok(b2.repo === "acme/office" && b2.branch === "dev", "owner/repo#branch honours the branch (acme/office @ dev)");
const b3 = resolveWith({ env: { BAGIDEA_UPDATE_REPO: "garbage-no-slash" }, dir: realDir });
ok(b3.repo === "bagidea/bagidea-office", "malformed env value is ignored → falls through");

// ── (c) derive from a made-up github origin ─────────────────────────────────
console.log("c) derive from a fake git origin");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "urepo-"));
let cErr = null;
try {
  cp.execSync("git init -q", { cwd: tmp, windowsHide: true });
  cp.execSync("git remote add origin https://github.com/madeup-owner/madeup-repo.git", { cwd: tmp, windowsHide: true });
} catch (e) { cErr = e; }
ok(!cErr, "scaffolded a temp git repo with a fake origin");
const c = resolveWith({ env: {}, dir: tmp });
ok(c.repo === "madeup-owner/madeup-repo" && c.branch === "main",
  "derives madeup-owner/madeup-repo @ main (got " + c.repo + " @ " + c.branch + ")");

// ── (d) no git at all → fallback ─────────────────────────────────────────────
console.log("d) no git → fallback");
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "urepo-nogit-"));
const d = resolveWith({ env: {}, dir: tmp2 });
ok(d.repo === "bagidea/bagidea-office" && d.branch === "main", "non-git dir → fallback bagidea/bagidea-office @ main");

// ── (e) checkUpdate() actually ISSUES the request to the resolved path ───────
// Extract the real checkUpdate() too, stub https.get to capture the options,
// and prove the outbound GET targets the new path under an env override.
console.log("e) checkUpdate() fires to the resolved path");
const cuStart = src.indexOf("function checkUpdate()");
const cuEnd = src.indexOf("setTimeout(checkUpdate", cuStart);
const cuBlock = src.slice(cuStart, cuEnd);
function fireCheckUpdate(env, dir) {
  let captured = null;
  const fakeHttps = { get: (opts) => { captured = opts; return { on: () => ({}) }; } };
  const sandbox = {
    process: { env },
    require: (m) => (m === "https" ? fakeHttps : require(m)),
    __dirname: dir || realDir,
    console: { log: () => {}, error: () => {} },
    localVersion: () => "0.0.0",
    semverGt: () => false,
    broadcast: () => {},
    latestVersion: "0.0.0", updateNotified: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(block + "\n" + cuBlock + "\n;checkUpdate();", sandbox, { filename: "checkUpdate.js" });
  return captured;
}
const eOverride = fireCheckUpdate({ BAGIDEA_UPDATE_REPO: "someone/new-repo" });
ok(eOverride && eOverride.host === "raw.githubusercontent.com", "GET targets raw.githubusercontent.com");
ok(eOverride && eOverride.path === "/someone/new-repo/main/VERSION",
  "with env override → GET " + (eOverride && eOverride.path));
const eLegacy = fireCheckUpdate({});
ok(eLegacy && eLegacy.host === "raw.githubusercontent.com" &&
  eLegacy.path === "/bagidea/bagidea-office/main/VERSION",
  "without env → GET the legacy GitHub path (no behaviour change)");

// ── (f) GitHub: derive from the REAL clone-style origin (.git stripped) ───────
// The actual clone URL is https://github.com/ekalostzjp-alt/begidea_ai_office.git
// → must strip the ".git" suffix, host=github, raw.githubusercontent.com path.
console.log("f) derive from the real GitHub origin (.git stripped)");
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "urepo-gh-"));
let fErr = null;
try {
  cp.execSync("git init -q", { cwd: tmp3, windowsHide: true });
  cp.execSync('git remote add origin "https://github.com/ekalostzjp-alt/begidea_ai_office.git"',
    { cwd: tmp3, windowsHide: true });
} catch (e) { fErr = e; }
ok(!fErr, "scaffolded a temp git repo with the real GitHub origin");
const f = resolveWith({ env: {}, dir: tmp3 });
ok(f.host === "github" && f.repo === "ekalostzjp-alt/begidea_ai_office" && f.branch === "main",
  "derives github ekalostzjp-alt/begidea_ai_office @ main (got " + f.host + " " + f.repo + " @ " + f.branch + ")");
// …and checkUpdate() must hit raw.githubusercontent.com with the /<branch>/ path
const fEp = fireCheckUpdate({}, tmp3);
ok(fEp && fEp.host === "raw.githubusercontent.com", "GitHub origin → GET targets raw.githubusercontent.com");
ok(fEp && fEp.path === "/ekalostzjp-alt/begidea_ai_office/main/VERSION",
  "GitHub path is /owner/repo/branch/VERSION (got " + (fEp && fEp.path) + ")");

// ── (g) Bitbucket via env host-prefix override (no git needed) ───────────────
// The runtime origin is GitHub now, but the resolver still supports Bitbucket
// via an explicit env prefix — keep that two-host capability covered.
console.log("g) BAGIDEA_UPDATE_REPO=bitbucket:owner/repo override (host-aware)");
const g1 = resolveWith({ env: { BAGIDEA_UPDATE_REPO: "bitbucket:someone/bb-repo" }, dir: realDir });
ok(g1.host === "bitbucket" && g1.repo === "someone/bb-repo" && g1.branch === "main",
  "bitbucket:owner/repo → host bitbucket, repo someone/bb-repo @ main");
const g2 = resolveWith({ env: { BAGIDEA_UPDATE_REPO: "bitbucket:acme/office#dev" }, dir: realDir });
ok(g2.host === "bitbucket" && g2.repo === "acme/office" && g2.branch === "dev",
  "bitbucket:owner/repo#branch honours host + branch");
const g3 = resolveWith({ env: { BAGIDEA_UPDATE_REPO: "github:ekalostzjp-alt/begidea_ai_office" }, dir: realDir });
ok(g3.host === "github" && g3.repo === "ekalostzjp-alt/begidea_ai_office",
  "explicit github: prefix → host github (same target as bare owner/repo)");
const gEp = fireCheckUpdate({ BAGIDEA_UPDATE_REPO: "bitbucket:someone/bb-repo" }, realDir);
ok(gEp && gEp.host === "bitbucket.org" && gEp.path === "/someone/bb-repo/raw/main/VERSION",
  "env bitbucket override → checkUpdate GETs the bitbucket /raw/ path");

// cleanup temp dirs (iron rule: leave nothing behind)
for (const t of [tmp, tmp2, tmp3]) { try { fs.rmSync(t, { recursive: true, force: true }); } catch {} }

console.log("\n" + (fail ? "❌ FAIL " : "✅ PASS ") + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
