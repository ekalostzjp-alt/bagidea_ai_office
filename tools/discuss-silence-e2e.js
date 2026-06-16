#!/usr/bin/env node
// Sandbox e2e for the "silent meeting" fix in daemon/server.js runDiscussion.
// No live :8787, no HTTP, no claude spawns — extracts quotaHit() straight from
// the real server.js source and simulates the turn-loop decision flow with a
// stubbed claudeText, asserting every broadcast the CEO should now see.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); }
  else { fail++; console.log("  ✗ " + m); } };

// ---- extract the REAL quotaHit from server.js (no copy drift) --------------
const src = fs.readFileSync(path.join(__dirname, "..", "daemon", "server.js"), "utf8");
const m = src.match(/function quotaHit\(text\) \{[\s\S]*?\n\}/);
if (!m) { console.log("✗ quotaHit not found in server.js"); process.exit(1); }
const quotaHit = new Function("return " + m[0])();

console.log("[1] quotaHit: CLI limit notices are detected, Thai prose is not");
const q1 = quotaHit("You've hit your session limit · resets 3pm");
ok(q1 && q1.reset === "3pm", "session limit + reset time extracted: " + JSON.stringify(q1));
const q2 = quotaHit("Claude usage limit reached. Your limit resets at 11:00 PM");
ok(q2 && /11:00 PM/.test(q2.reset), "usage limit + reset extracted: " + JSON.stringify(q2));
ok(quotaHit("5-hour limit reached · resets 2am") !== null, "5-hour limit detected");
ok(quotaHit("You've hit your weekly limit.") !== null, "weekly limit, no reset time → still detected");
ok(quotaHit("") === null, "empty string → null (handled by !text branch, not quota)");
ok(quotaHit("ผมว่าเราควรระวัง rate limit ของ API ฝั่ง backend ครับ") === null,
  "Thai meeting line MENTIONING rate limit → NOT quota (Thai-char guard)");
ok(quotaHit("เจอ session limit ใน Redis ต้องเพิ่ม TTL") === null,
  "Thai line with 'session limit' words → NOT quota");
ok(quotaHit("ok let me think about the architecture") === null, "plain English non-limit → null");

console.log("[2] turn-loop flow simulation (same decision logic as server.js)");
// Faithful mini-replica of the new loop skeleton: same branches, stubbed I/O.
function simulate(replies, ids, rounds) {
  const events = [], log = [];
  let transcript = "", spoke = 0, fails = 0, haltReason = "", i = 0;
  const sysLine = (id, text) => {
    log.push({ who: id, text });
    events.push({ type: "chat.message", agent: id, text, system: true });
  };
  loops: for (let r = 0; r < rounds; r++) {
    for (const id of ids) {
      const text = replies[Math.min(i++, replies.length - 1)];
      const q = quotaHit(text);
      if (q) {
        haltReason = "⚠️ ตอนนี้โควต้า Claude เต็มชั่วคราว" +
          (q.reset ? ` (รีเซ็ต ${q.reset})` : "") + " — ประชุมขอพักก่อนนะครับ";
        sysLine(id, haltReason);
        break loops;
      }
      if (!text) {
        fails++;
        sysLine(id, `⚠️ ${id} ตอบไม่สำเร็จ (Claude ไม่ตอบกลับ) — ข้ามคิวนี้`);
        if (fails >= 2 && spoke === 0) {
          haltReason = "⚠️ Claude ไม่ตอบกลับติดต่อกันหลายคิว — ประชุมขอพักก่อน แล้วค่อยเรียกใหม่นะครับ";
          sysLine(id, haltReason);
          break loops;
        }
        continue;
      }
      fails = 0;
      const line = text.split("\n").filter(Boolean).join(" ").slice(0, 500);
      if (line) {
        spoke++;
        transcript += `${id}: ${line}\n`;
        log.push({ who: id, text: line });
        events.push({ type: "chat.message", agent: id, text: line });
      }
    }
  }
  if (!spoke && !log.length)
    sysLine(ids[0], "⚠️ ประชุมรอบนี้ไม่มีใครตอบกลับได้ (Claude อาจติด limit หรือ error) — ลองเรียกประชุมใหม่ภายหลังนะครับ");
  events.push({ type: "collab.ended", spoke, reason: haltReason || undefined });
  return { events, log, spoke, haltReason };
}

const A = ["a1", "a2"];
// 2a: quota on the very first turn → ONE warning with reset time, meeting halts
const r1 = simulate(["You've hit your session limit · resets 7pm"], A, 2);
ok(r1.spoke === 0 && r1.events.filter((e) => e.system).length === 1,
  "quota turn-1: exactly one system warning, no silence");
ok(/รีเซ็ต 7pm/.test(r1.events[0].text), "warning carries the reset time: " + r1.events[0].text);
ok(r1.events.at(-1).reason && r1.events.at(-1).spoke === 0, "collab.ended has reason + spoke=0");

// 2b: all-empty replies → 2 skip notices + halt notice, never fully silent
const r2 = simulate([""], A, 3);
ok(r2.events.filter((e) => e.system).length === 3 && r2.haltReason,
  "all-empty: 2 skips + 1 halt (not 6 spam turns), reason set");

// 2c: one flaky empty turn between good turns → meeting continues normally
const r3 = simulate(["สวัสดีครับ เริ่มกันเลย", "", "เห็นด้วยครับ ขอเสริมเรื่อง cache", "ปิดท้าย: สรุปแผนได้"], A, 2);
ok(r3.spoke === 3 && !r3.haltReason, "flaky single empty: 3 spoke, no halt");
ok(r3.events.filter((e) => e.system).length === 1, "exactly one skip notice for the flaky turn");

// 2d: quota mid-meeting after real lines → lines kept, halt explained
const r4 = simulate(["ไอเดียแรกครับ", "Claude usage limit reached · resets 10pm"], A, 2);
ok(r4.spoke === 1 && /รีเซ็ต 10pm/.test(r4.haltReason), "mid-meeting quota: 1 spoke then halt w/ reset");

// 2e: healthy meeting → zero system lines, behavior unchanged (backward-compat)
const r5 = simulate(["ก", "ข", "ค", "ง"], A, 2);
ok(r5.spoke === 4 && r5.events.filter((e) => e.system).length === 0 && !r5.haltReason,
  "healthy meeting: no system lines, no reason — legacy behavior intact");

console.log("[3] server.js wiring sanity (the real file, not the replica)");
ok(/loops: for \(let r = 0; r < rounds; r\+\+\)/.test(src), "labeled loop present");
ok(/const q = quotaHit\(text\);/.test(src), "turn guard calls quotaHit");
ok(/spoke, reason: haltReason \|\| undefined/.test(src), "collab.ended carries spoke+reason");
ok(/if \(!spoke && !entry\.log\.length\)/.test(src), "never-fully-silent fallback present");
ok(/facts\.slice\(0, 600\)/.test(src), "project brain context hard-capped at 600 chars");
ok(/activeRuns\.size > 0 \|\| discussing/.test(src), "watcher defers restart during a meeting");

console.log("\n" + (fail ? "❌ FAIL " : "✅ PASS ") + pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
