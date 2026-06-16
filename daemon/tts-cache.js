// ponytail: persistent on-disk cache for synthesized speech. Identical
// (provider+preset+text) lines — intros, ambient musings, repeated announcements
// — used to re-bill Gemini/OpenAI every single time. Now the first gen is saved
// as a .wav and every later hit is served from disk with ZERO network/token cost.
//
// Pure + fail-open: any fs error (unwritable dir, corrupt read) just falls back to
// regenerating, so a broken cache can never silence the office.
// ponytail: no eviction — wavs are small (~50-100KB) and the key space is the set
// of distinct lines, which is naturally bounded. Add an LRU sweep only if
// workspace/tts-cache/ is ever measured to bloat.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Stable key: provider matters because Gemini and OpenAI render the same text in
// different voices, so they must not share a cache entry.
function ttsCacheKey(provider, presetId, text) {
  return crypto.createHash("sha1")
    .update(String(provider) + "\0" + String(presetId) + "\0" + String(text))
    .digest("hex");
}

// gen: () => Promise<Buffer>  (the real Gemini/OpenAI synth call).
// Hit  → resolves the cached Buffer and NEVER calls gen (no network, no tokens).
// Miss → calls gen, writes the .wav, returns it. Cache write failure is swallowed.
function ttsCached(dir, provider, presetId, text, gen) {
  let file = null;
  try {
    file = path.join(dir, ttsCacheKey(provider, presetId, text) + ".wav");
    if (fs.existsSync(file)) return Promise.resolve(fs.readFileSync(file));
  } catch { file = null; }   // fail-open: unreadable cache → regenerate
  return Promise.resolve().then(gen).then((wav) => {
    if (file && wav && wav.length) {
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, wav); } catch {}
    }
    return wav;
  });
}

module.exports = { ttsCacheKey, ttsCached };
