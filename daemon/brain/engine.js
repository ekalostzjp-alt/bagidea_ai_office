// Project Brain — engine: scan → CodeGraph → mapping → brain summary.
// Standalone (no daemon coupling). Safe on huge repos: the hard caps below
// (maxFiles / maxDepth / maxFileBytes) — NOT name-based ignores — are what keep
// a 6 GB tree from blowing up memory or time. So IGNORE_DIRS holds ONLY true
// non-source noise (deps, VCS, build output, caches). It must never list real
// source roots like `packages` (monorepo/workspaces) or `wwwroot` (ASP.NET) —
// doing so would silently drop the main code of whole classes of projects.
"use strict";
const fs = require("fs");
const path = require("path");

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "bin", "obj",
  ".next", ".nuxt", ".astro", ".svelte-kit", "target", "coverage", ".vs", ".idea",
  ".vscode", "vendor", "__pycache__", ".cache", "tmp", "temp",
  "Debug", "Release", ".turbo", ".parcel-cache",
]);
const SRC_EXT = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".astro", ".svelte", ".vue",
  ".py", ".cs", ".go", ".rs", ".java", ".rb", ".php", ".json", ".md",
  ".css", ".scss", ".html",
]);
// extensions we parse for an import graph
const CODE_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".astro", ".svelte", ".vue", ".py"]);

// ---- 1. scan ---------------------------------------------------------------
function scan(root, opts = {}) {
  const maxFiles = opts.maxFiles || 20000;
  const maxFileBytes = opts.maxFileBytes || 512 * 1024;
  const maxDepth = opts.maxDepth || 12;
  const files = [];
  const langs = {};
  let truncated = false;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > maxDepth) continue;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        if (e.name.startsWith(".") && e.name !== ".claude" && e.name !== ".github") continue;
        stack.push([fp, depth + 1]);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (!SRC_EXT.has(ext)) continue;
        let st; try { st = fs.statSync(fp); } catch { continue; }
        if (st.size > maxFileBytes) continue;
        const rel = path.relative(root, fp).replace(/\\/g, "/");
        let loc = 0;
        if (CODE_EXT.has(ext) || ext === ".md") {
          try { loc = fs.readFileSync(fp, "utf8").split("\n").length; } catch {}
        }
        files.push({ rel, ext, bytes: st.size, loc });
        langs[ext] = (langs[ext] || 0) + 1;
        if (files.length >= maxFiles) { truncated = true; break; }
      }
    }
    if (truncated) break;
  }
  return { root, files, langs, truncated, count: files.length };
}

// ---- 2. CodeGraph (import/require edges) ------------------------------------
const IMPORT_RE = [
  /\bimport\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g,   // import x from "y" / import "y"
  /\bexport\s+(?:[^'"]*?\sfrom\s+)\s*["']([^"']+)["']/g, // export ... from "y"
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,             // require("y")
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,              // dynamic import("y")
];
const RESOLVE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro", ".svelte", ".vue"];

function buildGraph(scanRes) {
  const root = scanRes.root;
  const set = new Set(scanRes.files.map((f) => f.rel));
  const edges = [];
  const externals = {};
  const resolve = (fromRel, spec) => {
    if (!spec.startsWith(".")) return null; // bare = external pkg
    const baseDir = path.posix.dirname(fromRel);
    let target = path.posix.normalize(path.posix.join(baseDir, spec));
    if (set.has(target)) return target;
    for (const ext of RESOLVE_EXT) if (set.has(target + ext)) return target + ext;
    for (const ext of RESOLVE_EXT) if (set.has(path.posix.join(target, "index" + ext))) return path.posix.join(target, "index" + ext);
    return null;
  };
  for (const f of scanRes.files) {
    if (!CODE_EXT.has(f.ext)) continue;
    let src;
    try { src = fs.readFileSync(path.join(root, f.rel), "utf8"); } catch { continue; }
    if (src.length > 400000) src = src.slice(0, 400000);
    const seen = new Set();
    for (const re of IMPORT_RE) {
      re.lastIndex = 0; let m;
      while ((m = re.exec(src))) {
        const spec = m[1];
        if (seen.has(spec)) continue;
        seen.add(spec);
        const to = resolve(f.rel, spec);
        if (to) edges.push({ from: f.rel, to });
        else if (!spec.startsWith(".")) {
          const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
          externals[pkg] = (externals[pkg] || 0) + 1;
        }
      }
    }
  }
  return { nodes: scanRes.files.map((f) => f.rel), edges, externals };
}

// ---- 3. mapping (modules, entry points, hotspots) --------------------------
function buildMapping(scanRes, graph) {
  const byModule = {};
  for (const f of scanRes.files) {
    const top = f.rel.includes("/") ? f.rel.split("/")[0] : ".";
    (byModule[top] = byModule[top] || { files: 0, loc: 0 }).files++;
    byModule[top].loc += f.loc || 0;
  }
  const modules = Object.entries(byModule)
    .map(([name, v]) => ({ name, files: v.files, loc: v.loc }))
    .sort((a, b) => b.files - a.files);

  // in-degree = how many files import this one → likely core files
  const indeg = {};
  for (const e of graph.edges) indeg[e.to] = (indeg[e.to] || 0) + 1;
  const hotspots = Object.entries(indeg).sort((a, b) => b[1] - a[1])
    .slice(0, 15).map(([rel, n]) => ({ rel, importedBy: n }));

  // entry points: package.json main/scripts + common entry filenames
  const entryPoints = [];
  for (const f of scanRes.files) {
    const base = f.rel.split("/").pop();
    if (/^(index|main|server|app|cli)\.(c?[jt]sx?|mjs)$/.test(base) && f.rel.split("/").length <= 3)
      entryPoints.push(f.rel);
  }
  const topExternals = Object.entries(graph.externals)
    .sort((a, b) => b[1] - a[1]).slice(0, 20).map(([pkg, n]) => ({ pkg, uses: n }));

  return { modules, hotspots, entryPoints: entryPoints.slice(0, 20), topExternals };
}

module.exports = { scan, buildGraph, buildMapping, IGNORE_DIRS, SRC_EXT, CODE_EXT };
