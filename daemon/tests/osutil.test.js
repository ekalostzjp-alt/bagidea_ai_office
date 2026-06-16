const test = require("node:test");
const assert = require("node:assert");
const { appleScriptStringLiteral, terminalLaunchScript } = require("../osutil");

test("terminalLaunchScript wraps the path in AppleScript quoted form", () => {
  assert.strictEqual(
    terminalLaunchScript("/Users/me/proj"),
    `tell application "Terminal" to do script ("cd " & quoted form of "/Users/me/proj")`,
  );
});

test("a single quote in the path survives literally (quoted form shell-escapes it at runtime)", () => {
  // The ' must NOT be escaped at the AppleScript layer — it stays inside the
  // string literal so `quoted form of` can turn it into a safe shell token.
  const s = terminalLaunchScript("/Users/o'brien/my proj");
  assert.match(s, /quoted form of "\/Users\/o'brien\/my proj"\)$/);
});

test("double quotes and backslashes are escaped in the AppleScript literal", () => {
  assert.strictEqual(appleScriptStringLiteral('a"b\\c'), '"a\\"b\\\\c"');
});

test("an injection attempt is neutralised, not interpolated", () => {
  const s = terminalLaunchScript('/tmp/x"; rm -rf /');
  // the closing quote is escaped, so the command never breaks out of the literal
  assert.match(s, /quoted form of "\/tmp\/x\\"; rm -rf \/"\)$/);
});

test("appleScriptStringLiteral handles null/undefined as an empty literal", () => {
  assert.strictEqual(appleScriptStringLiteral(null), '""');
  assert.strictEqual(appleScriptStringLiteral(undefined), '""');
});
