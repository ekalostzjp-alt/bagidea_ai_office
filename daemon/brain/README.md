# daemon/brain — Project Brain engine

Standalone, zero-dependency. **Does not touch server.js.** Black wires the daemon to `require("./brain")`.

- `engine.js` — `scan`, `buildGraph`, `buildMapping` (bounded; safe on huge repos).
- `index.js` — `buildBrain({id,name,dir},{now})` → `{summary,brain}`, `getBrain(id,full?)`; persists `../brain-cache/<id>.json`; auto-inits `<projectDir>/.claude|.codex/PROJECT_BRAIN.md`.
- `mcp-server.js` — MCP stdio server (`brain_summary`/`brain_search`/`brain_neighbors`); `node mcp-server.js <projectId>`.

Wire snippet + endpoints + MCP config: see `app/docs/project-brain.contract.md`.

Verified on tookjorThai (6 GB): scan 169ms → 1893 files / 168k loc / 1607 edges; MCP round-trip OK.
