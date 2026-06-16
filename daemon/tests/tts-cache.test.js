// Self-check for the TTS audio cache: proves a second identical request is
// served from disk WITHOUT calling the generator (= no Gemini/OpenAI / no tokens).
// Run: node daemon/tests/tts-cache.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ttsCacheKey, ttsCached } = require("../tts-cache");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ttscache-"));
let n = 0;

(async () => {
  const gen = () => { n++; return Promise.resolve(Buffer.from("WAVDATA-" + n)); };

  // 1) miss → generator runs once, file written
  const a = await ttsCached(dir, "gemini", "kore", "สวัสดีครับ", gen);
  assert.strictEqual(n, 1, "first call must invoke the generator");
  assert.strictEqual(a.toString(), "WAVDATA-1");
  const f = path.join(dir, ttsCacheKey("gemini", "kore", "สวัสดีครับ") + ".wav");
  assert.ok(fs.existsSync(f), "miss must persist a .wav");

  // 2) HIT → same bytes, generator NOT called again (the whole point)
  const b = await ttsCached(dir, "gemini", "kore", "สวัสดีครับ", gen);
  assert.strictEqual(n, 1, "second identical call must NOT invoke the generator");
  assert.strictEqual(b.toString(), "WAVDATA-1", "hit must return the cached bytes");

  // 3) different provider / preset / text → distinct keys → real misses
  await ttsCached(dir, "openai", "kore", "สวัสดีครับ", gen);
  await ttsCached(dir, "gemini", "puck", "สวัสดีครับ", gen);
  await ttsCached(dir, "gemini", "kore", "อีกประโยค", gen);
  assert.strictEqual(n, 4, "provider/preset/text variants must each be a fresh gen");

  // 4) fail-open: an unwritable dir must still return audio (just no caching)
  const bad = path.join(dir, "nope.wav", "sub"); // path under a file = unwritable
  const c = await ttsCached(bad, "gemini", "kore", "x", gen);
  assert.strictEqual(c.toString(), "WAVDATA-5", "cache write failure must not block synthesis");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("✓ tts-cache: hit avoids network, keys isolate, fail-open holds (5 gens, 1 hit)");
})().catch((e) => { console.error("✗", e); process.exit(1); });
