// Project Brain scanner — regression guard for the Codex round-2 finding:
// `packages` (monorepo/workspaces) and `wwwroot` (ASP.NET) are REAL source
// roots and must NOT be name-ignored, or whole projects scan to an empty brain.
// Big-repo safety comes from the maxFiles/maxDepth/maxFileBytes caps instead.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const E = require("../brain/engine");

const TMP_BASE = process.env.BAGIDEA_TEST_TMP || os.tmpdir();
let TMP_SKIP = false;
try {
  const probe = fs.mkdtempSync(path.join(TMP_BASE, "bagidea-probe-"));
  fs.rmSync(probe, { recursive: true, force: true });
} catch (e) {
  TMP_SKIP = `temp dir not writable (${TMP_BASE}: ${e.code || e.message}); set BAGIDEA_TEST_TMP`;
  console.error(`[brain-engine.test] ${TMP_SKIP} — skipping fs tests`);
}

function mk(root, rel, body = "// x\n") {
  const fp = path.join(root, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, body);
}

test("scan covers monorepo source under packages/* and wwwroot, still skips node_modules", { skip: TMP_SKIP }, () => {
  const root = fs.mkdtempSync(path.join(TMP_BASE, "bagidea-mono-"));
  try {
    // real source the brain MUST see
    mk(root, "packages/api/src/index.ts", "export const x = 1;\n");
    mk(root, "packages/web/app.tsx", "export default () => null;\n");
    mk(root, "wwwroot/js/site.js", "console.log('site');\n");
    mk(root, "src/server.js", "module.exports = {};\n");
    // noise the brain MUST skip
    mk(root, "node_modules/leftpad/index.js", "module.exports = 0;\n");
    mk(root, "dist/bundle.js", "/*built*/\n");

    const r = E.scan(root);
    const rels = new Set(r.files.map((f) => f.rel));

    assert.ok(rels.has("packages/api/src/index.ts"), "packages/* TS source must be scanned");
    assert.ok(rels.has("packages/web/app.tsx"), "packages/* TSX source must be scanned");
    assert.ok(rels.has("wwwroot/js/site.js"), "wwwroot source must be scanned");
    assert.ok(rels.has("src/server.js"), "top-level source must be scanned");

    assert.ok(![...rels].some((p) => p.startsWith("node_modules/")), "node_modules must stay ignored");
    assert.ok(![...rels].some((p) => p.startsWith("dist/")), "dist must stay ignored");

    // and the IGNORE set itself must not re-introduce the source roots
    assert.ok(!E.IGNORE_DIRS.has("packages"), "`packages` must not be ignored");
    assert.ok(!E.IGNORE_DIRS.has("wwwroot"), "`wwwroot` must not be ignored");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scan honours the file-count cap so a huge tree can't blow up (not name ignores)", { skip: TMP_SKIP }, () => {
  const root = fs.mkdtempSync(path.join(TMP_BASE, "bagidea-cap-"));
  try {
    for (let i = 0; i < 50; i++) mk(root, `packages/p${i}/index.js`, "//\n");
    const r = E.scan(root, { maxFiles: 10 });
    assert.ok(r.truncated, "should report truncation when over maxFiles");
    assert.ok(r.files.length <= 10, "must not exceed the maxFiles cap");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
