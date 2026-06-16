// BagIdea Office — native skill sync (P3).
// Projects each agent's assigned skills (a.skills[]) to real Claude Code Skill
// files so headless sessions disclose them PROGRESSIVELY (only the frontmatter
// description is in context until Claude invokes one) via `--add-dir`, instead
// of inlining every skill body into the prompt. a.skills[] stays the source of
// truth; the files are a derived projection.
//
// Verified mechanism: `claude -p --add-dir <dir>` discovers
// <dir>/.claude/skills/<id>/SKILL.md with no extra --allowedTools entry and no
// trust prompt. So we pass --add-dir <agentDir> and the session sees exactly
// that agent's skills.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// The dir handed to --add-dir; Claude Code reads its .claude/skills/ child.
function agentDir(agentsRoot, agentId) {
  return path.join(agentsRoot, String(agentId).replace(/[^\w-]/g, "_"));
}
function skillsRoot(agentsRoot, agentId) {
  return path.join(agentDir(agentsRoot, agentId), ".claude", "skills");
}

// Skill name/description are user-controlled (an agent can be assigned a custom
// skill). They land in the SKILL.md YAML frontmatter, where a raw ':' '#' '"' or
// a stray control char would break the document and make Claude silently fail to
// discover the skill. Emit every value as a double-quoted YAML scalar with the
// two escapes that quoting requires (`\` and `"`); collapse line breaks/tabs and
// strip remaining control chars first. Emoji / non-ASCII pass through untouched
// (valid UTF-8 in a double-quoted YAML scalar).
function yamlScalar(v) {
  const s = String(v == null ? "" : v)
    .replace(/[\r\n\t]+/g, " ")        // no line breaks inside a single scalar
    .replace(/[\x00-\x1f\x7f]/g, "")   // drop any other control chars
    .trim();
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Claude Code discovers a skill by the `name` in its frontmatter and that name
// MUST be a safe id matching the directory the SKILL.md lives in — never the
// human display name. sk.name is a display label ("Deep Research", "🔀 Foo")
// with spaces/emoji/colons, so a skill named after it silently fails discovery.
// Project the registry id (same transform as the dir name) as `name`, and keep
// the human label as an H1 heading in the body when present.
function skillId(id) {
  return String(id == null ? "" : id).replace(/[^\w-]/g, "-");
}

function frontmatter(sk, id) {
  const name = yamlScalar(skillId(id));
  const desc = yamlScalar(sk.description || "");
  const human = String(sk.name == null ? "" : sk.name).trim();
  const heading = human ? `# ${human}\n\n` : "";
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${heading}${String(sk.content || "").trim()}\n`;
}

// Write one agent's assigned skills as SKILL.md files; prune dirs for skills no
// longer assigned. Hash-gated via .synced.json so unchanged files aren't
// rewritten. Returns {wrote, pruned}.
function syncAgent(agentsRoot, agentId, assignedIds, skills) {
  const root = skillsRoot(agentsRoot, agentId);
  fs.mkdirSync(root, { recursive: true });
  const syncedFile = path.join(root, ".synced.json");
  let synced = {};
  try { synced = JSON.parse(fs.readFileSync(syncedFile, "utf8")); } catch {}
  const want = {};
  let wrote = 0, pruned = 0;
  for (const id of assignedIds || []) {
    const sk = skills[id];
    if (!sk) continue;
    const safe = skillId(id);
    const body = frontmatter(sk, id);
    const hash = crypto.createHash("sha1").update(body).digest("hex").slice(0, 12);
    want[safe] = hash;
    const dir = path.join(root, safe);
    if (synced[safe] !== hash || !fs.existsSync(path.join(dir, "SKILL.md"))) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, ".SKILL.md.tmp");
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, path.join(dir, "SKILL.md"));
      wrote++;
    }
  }
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory() && !want[d.name]) {
        fs.rmSync(path.join(root, d.name), { recursive: true, force: true });
        pruned++;
      }
    }
  } catch { /* fresh dir */ }
  try { fs.writeFileSync(syncedFile, JSON.stringify(want)); } catch {}
  return { wrote, pruned };
}

// Sync every agent in the registry (boot).
function syncAll(agentsRoot, agents, skills) {
  let wrote = 0, pruned = 0;
  for (const [id, a] of Object.entries(agents || {})) {
    const r = syncAgent(agentsRoot, id, a.skills || [], skills || {});
    wrote += r.wrote; pruned += r.pruned;
  }
  return { wrote, pruned };
}

module.exports = { agentDir, skillsRoot, yamlScalar, skillId, frontmatter, syncAgent, syncAll };
