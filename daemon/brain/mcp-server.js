#!/usr/bin/env node
// Project Brain — MCP server (stdio, JSON-RPC 2.0, newline-delimited, zero-dep).
//
//   node daemon/brain/mcp-server.js <projectId>
//   (or env BRAIN_PROJECT=<id>; defaults to the newest brain-cache entry)
//
// Exposes the cached Project Brain as MCP tools so any Claude Code / Codex
// session can query the project's map. Exits cleanly on stdin EOF — no hang.
// Wire into a project's .claude/.codex via mcpServers config (see README).
"use strict";
const fs = require("fs");
const path = require("path");
const { getBrain, CACHE_DIR } = require("./index");

function pickProject() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.BRAIN_PROJECT) return process.env.BRAIN_PROJECT;
  try {
    const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (files[0]) return files[0].f.replace(/\.json$/, "");
  } catch {}
  return null;
}
const PROJECT = pickProject();
function brain(full) { return PROJECT ? getBrain(PROJECT, full) : null; }

const TOOLS = [
  { name: "brain_summary", description: "Project map: stats, languages, modules, entry points, core files, key deps.",
    inputSchema: { type: "object", properties: {} } },
  { name: "brain_search", description: "Find source files whose path matches a query (substring, case-insensitive).",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "brain_neighbors", description: "Imports and imported-by for a file (its edges in the CodeGraph).",
    inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } },
];

function callTool(name, args) {
  const b = brain(true);
  if (!b) return { content: [{ type: "text", text: "No brain cached. Run POST /project/scan first." }], isError: true };
  if (name === "brain_summary") {
    const s = { project: b.projectName, root: b.root, stats: b.stats, languages: b.languages,
      modules: b.modules.slice(0, 12), entryPoints: b.entryPoints, hotspots: b.hotspots.slice(0, 10),
      topExternals: b.topExternals.slice(0, 12) };
    return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
  }
  if (name === "brain_search") {
    const q = String((args && args.query) || "").toLowerCase();
    const hits = (b.graph.nodes || []).filter((n) => n.toLowerCase().includes(q)).slice(0, 60);
    return { content: [{ type: "text", text: hits.length ? hits.join("\n") : "(no matches)" }] };
  }
  if (name === "brain_neighbors") {
    const f = String((args && args.file) || "");
    const imports = b.graph.edges.filter((e) => e.from === f).map((e) => e.to);
    const importedBy = b.graph.edges.filter((e) => e.to === f).map((e) => e.from);
    return { content: [{ type: "text", text: JSON.stringify({ file: f, imports, importedBy }, null, 2) }] };
  }
  return { content: [{ type: "text", text: "unknown tool: " + name }], isError: true };
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize")
    return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05",
      capabilities: { tools: {} }, serverInfo: { name: "project-brain", version: "1.0.0", project: PROJECT } } };
  if (method === "tools/list")
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    try { return { jsonrpc: "2.0", id, result: callTool(params && params.name, params && params.arguments) }; }
    catch (e) { return { jsonrpc: "2.0", id, error: { code: -32000, message: e.message } }; }
  }
  if (method === "notifications/initialized" || (method && method.startsWith("notifications/"))) return null;
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } };
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const res = handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  }
});
process.stdin.on("end", () => process.exit(0));
