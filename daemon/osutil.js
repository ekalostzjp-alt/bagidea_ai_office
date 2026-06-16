// BagIdea Office — tiny OS/shell launch helpers.
// Kept pure and dependency-free so they can be unit-tested without booting the
// whole daemon (server.js can't be require()'d in isolation).

// Emit `s` as a double-quoted AppleScript string literal. AppleScript string
// escaping only needs `\` and `"` handled; a single quote (') is an ordinary
// character inside a double-quoted literal and must NOT be touched — that's the
// whole point: it survives intact so `quoted form of` can shell-escape it.
function appleScriptStringLiteral(s) {
  return '"' + String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"') + '"';
}

// Build the AppleScript that opens Terminal.app and cd's into `dir`. The path is
// carried inside an AppleScript string literal and then shell-escaped at runtime
// by AppleScript's own `quoted form of`, so a path containing a single quote (or
// any shell metacharacter) becomes a safe single-quoted shell token instead of a
// command/script-injection vector. `do script` takes a single string expression,
// so the concatenation is parenthesised to bind before `do script` sees it.
function terminalLaunchScript(dir) {
  return `tell application "Terminal" to do script ("cd " & quoted form of ${appleScriptStringLiteral(dir)})`;
}

module.exports = { appleScriptStringLiteral, terminalLaunchScript };
