const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const S = require("../skills");

const SKILLS = {
  "deep-research": { name: "Deep Research", description: "Methodical web research into a sourced brief.", content: "1. Restate.\n2. Search.\n3. Cross-check." },
  "office-ops": { name: "Office Operations", description: "Run the office well.", content: "Delegate with DELEGATE: lines." },
};

// Pick a writable temp base: honour BAGIDEA_TEST_TMP (for locked-down CI/
// sandboxes where os.tmpdir() is read-only), else fall back to os.tmpdir().
// If neither can be written, the fs-touching tests skip with a clear reason
// instead of failing on EPERM.
const TMP_BASE = process.env.BAGIDEA_TEST_TMP || os.tmpdir();
let TMP_SKIP = false;
try {
  const probe = fs.mkdtempSync(path.join(TMP_BASE, "bagidea-probe-"));
  fs.rmSync(probe, { recursive: true, force: true });
} catch (e) {
  TMP_SKIP = `temp dir not writable (${TMP_BASE}: ${e.code || e.message}); set BAGIDEA_TEST_TMP to a writable path`;
  console.error(`[skills.test] ${TMP_SKIP} — skipping fs tests`);
}
function tmp() { return fs.mkdtempSync(path.join(TMP_BASE, "bagidea-skills-")); }

// ----- YAML frontmatter escaping (pure, no fs) -----

test("frontmatter name is the safe skill id, not the human display name", () => {
  const fm = S.frontmatter(SKILLS["deep-research"], "deep-research");
  // Claude Code discovers by `name`, which must be the id (matches the dir).
  assert.match(fm, /^---\nname: "deep-research"\ndescription: "Methodical web research into a sourced brief\."\n---\n/);
  // the human label survives as an H1 in the body.
  assert.match(fm, /\n---\n\n# Deep Research\n\n/);
});

test("frontmatter projects an emoji workflow id to a safe name + keeps label in body", () => {
  const fm = S.frontmatter({
    name: "🔀 Daily News",
    description: "Run the saved workflow: Daily News",
    content: "step one",
  }, "wf-daily-news");
  assert.match(fm, /\nname: "wf-daily-news"\n/);
  assert.match(fm, /\n---\n\n# 🔀 Daily News\n\nstep one\n$/);
});

test("skillId strips spaces/emoji/colons so name always matches the dir", () => {
  assert.strictEqual(S.skillId("Deep Research"), "Deep-Research");
  assert.strictEqual(S.skillId("🔀 wf"), "---wf"); // emoji is a surrogate pair → 2 dashes
  assert.strictEqual(S.skillId("ok-id_1"), "ok-id_1");
});

test("frontmatter escapes user-controlled colon, hash, quote, backslash in description & keeps emoji", () => {
  const fm = S.frontmatter({
    name: 'Weird: skill #1 "quoted"',
    description: 'has: colon # hash "q" and emoji 🚀 \\ back',
    content: "body here",
  }, "weird-id");
  // name is the (safe) id — no user-controlled chars reach the YAML key.
  assert.match(fm, /\nname: "weird-id"\n/);
  assert.match(fm, /\ndescription: "has: colon # hash \\"q\\" and emoji 🚀 \\\\ back"\n/);
  // delimiters and body survive intact, with the display label as a heading.
  assert.ok(fm.startsWith("---\n"));
  assert.match(fm, /\n---\n\n# Weird: skill #1 "quoted"\n\nbody here\n$/);
});

test("yamlScalar collapses newlines/tabs and strips control chars", () => {
  assert.strictEqual(S.yamlScalar("a\nb\tc"), '"a b c"');
  assert.strictEqual(S.yamlScalar("clean\x07bell"), '"cleanbell"');
  assert.strictEqual(S.yamlScalar(null), '""');
});

test("frontmatter falls back to the id when name is missing", () => {
  const fm = S.frontmatter({ description: "d", content: "c" }, "fallback-id");
  assert.match(fm, /\nname: "fallback-id"\n/);
});

// ----- filesystem projection (gated on a writable temp dir) -----

test("syncAgent writes a SKILL.md per assigned skill with frontmatter", { skip: TMP_SKIP }, () => {
  const root = tmp();
  const r = S.syncAgent(root, "shino", ["deep-research", "office-ops"], SKILLS);
  assert.strictEqual(r.wrote, 2);
  const f = path.join(S.skillsRoot(root, "shino"), "deep-research", "SKILL.md");
  assert.ok(fs.existsSync(f));
  const body = fs.readFileSync(f, "utf8");
  assert.match(body, /^---\nname: "deep-research"\ndescription: "Methodical web research into a sourced brief\."\n---/);
  assert.match(body, /Restate/);
  // --add-dir target is the agent dir whose .claude/skills child holds these
  assert.strictEqual(S.agentDir(root, "shino"), path.join(root, "shino"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("syncAgent is hash-gated: unchanged second run rewrites nothing", { skip: TMP_SKIP }, () => {
  const root = tmp();
  S.syncAgent(root, "shino", ["deep-research"], SKILLS);
  const r2 = S.syncAgent(root, "shino", ["deep-research"], SKILLS);
  assert.strictEqual(r2.wrote, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("syncAgent rewrites when a skill's content changes", { skip: TMP_SKIP }, () => {
  const root = tmp();
  S.syncAgent(root, "shino", ["deep-research"], SKILLS);
  const changed = { ...SKILLS, "deep-research": { ...SKILLS["deep-research"], content: "1. New steps." } };
  const r = S.syncAgent(root, "shino", ["deep-research"], changed);
  assert.strictEqual(r.wrote, 1);
  assert.match(fs.readFileSync(path.join(S.skillsRoot(root, "shino"), "deep-research", "SKILL.md"), "utf8"), /New steps/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("syncAgent prunes a skill dir once it's unassigned", { skip: TMP_SKIP }, () => {
  const root = tmp();
  S.syncAgent(root, "shino", ["deep-research", "office-ops"], SKILLS);
  const r = S.syncAgent(root, "shino", ["deep-research"], SKILLS); // dropped office-ops
  assert.strictEqual(r.pruned, 1);
  assert.ok(fs.existsSync(path.join(S.skillsRoot(root, "shino"), "deep-research")));
  assert.ok(!fs.existsSync(path.join(S.skillsRoot(root, "shino"), "office-ops")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("syncAll covers every agent in the roster", { skip: TMP_SKIP }, () => {
  const root = tmp();
  const agents = { shino: { skills: ["deep-research"] }, sahara: { skills: ["office-ops"] }, ceo: { skills: [] } };
  const r = S.syncAll(root, agents, SKILLS);
  assert.strictEqual(r.wrote, 2);
  assert.ok(fs.existsSync(path.join(S.skillsRoot(root, "shino"), "deep-research", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(S.skillsRoot(root, "sahara"), "office-ops", "SKILL.md")));
  fs.rmSync(root, { recursive: true, force: true });
});
