// 🎵 Music Player plugin — server side.
// Holds the authoritative player STATE (what to play, paused, volume, loop,
// playlist) and broadcasts it. Actual audio plays in the overlay panel (the
// webview can decode mp3); agents and the UI both mutate state through
// commands, so an agent saying "loop this playlist" really controls the
// panel that's open in front of the user.
//
// Built on the BagIdea Office plugin template — uses ctx.pluginDir (bundled
// tracks), ctx.dataDir (state) and ctx.broadcast (live panel sync), and shows
// custom routes incl. ranged audio streaming + raw-body upload. The template
// (bagidea-office-template) documents the full ctx API.
const fs = require("fs");
const path = require("path");

module.exports = (ctx) => {
  const TRACKS_DIR = path.join(ctx.pluginDir, "tracks");   // drop .mp3 files here
  fs.mkdirSync(TRACKS_DIR, { recursive: true });
  const STATE_FILE = path.join(ctx.dataDir, "state.json");

  let state = load();
  function load() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
    return { playing: false, index: 0, volume: 60, loop: true, track: null };
  }
  function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); }

  function playlist() {
    try {
      return fs.readdirSync(TRACKS_DIR)
        .filter((f) => /\.(mp3|ogg|wav|m4a)$/i.test(f))
        .sort();
    } catch { return []; }
  }

  // push state to every open panel + the office feed
  function push(note) {
    const list = playlist();
    state.track = list[state.index] || null;
    save();
    ctx.broadcast({ type: "plugin.event", plugin: "music",
      event: "state", state: { ...state, count: list.length }, note }, false);
  }

  function onCommand(cmd, args, reply) {
    const list = playlist();
    const a = String(args || "").trim();
    switch (cmd) {
      case "play":
        if (a) {
          // by number, or fuzzy filename match
          const n = parseInt(a, 10);
          if (!isNaN(n) && n >= 1 && n <= list.length) state.index = n - 1;
          else {
            const i = list.findIndex((f) => f.toLowerCase().includes(a.toLowerCase()));
            if (i >= 0) state.index = i;
          }
        }
        state.playing = true;
        push("▶ เล่น");
        return reply({ ok: true, track: list[state.index] || null,
          msg: list.length ? "กำลังเล่น: " + (list[state.index] || "") : "ยังไม่มีเพลงในโฟลเดอร์ plugins/music/tracks" });
      case "pause": state.playing = false; push("⏸ หยุด"); return reply({ ok: true });
      case "next": state.index = list.length ? (state.index + 1) % list.length : 0; state.playing = true; push("⏭"); return reply({ ok: true, track: list[state.index] });
      case "prev": state.index = list.length ? (state.index - 1 + list.length) % list.length : 0; state.playing = true; push("⏮"); return reply({ ok: true, track: list[state.index] });
      case "loop": state.loop = a !== "off"; push(state.loop ? "🔁 วนเปิด" : "วนปิด"); return reply({ ok: true, loop: state.loop });
      case "volume": { const v = Math.max(0, Math.min(100, parseInt(a, 10) || state.volume)); state.volume = v; push("🔊 " + v); return reply({ ok: true, volume: v }); }
      case "remove": {
        if (!list.length) return reply({ ok: false, msg: "ไม่มีเพลงให้ลบ" });
        const n = parseInt(a, 10);
        const idx = (!isNaN(n) && n >= 1 && n <= list.length) ? n - 1
          : list.findIndex((f) => f.toLowerCase().includes(a.toLowerCase()));
        const f = list[idx];
        if (idx < 0 || !f) return reply({ ok: false, msg: "ไม่พบเพลง: " + a });
        try { fs.unlinkSync(path.join(TRACKS_DIR, f)); } catch (e) { return reply({ ok: false, msg: e.message }); }
        const after = playlist();
        if (state.index >= after.length) state.index = Math.max(0, after.length - 1);
        if (!after.length) state.playing = false;
        push("🗑 ลบ " + f);
        return reply({ ok: true, removed: f, count: after.length });
      }
      case "status": return reply({ ok: true, ...state, count: list.length, track: list[state.index] || null });
      default: return reply({ ok: false, msg: "ไม่รู้จักคำสั่ง: " + cmd });
    }
  }

  return {
    onCommand,
    routes: {
      // GET /plugin/music/state — panel polls this on open
      state(req, res) {
        const list = playlist();
        state.track = list[state.index] || null;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ...state, list, count: list.length }));
      },
      // GET /plugin/music/track?i=N — stream a track (with Range, so the panel
      // can seek/scrub).
      track(req, res) {
        const i = parseInt(new URL(req.url, "http://x").searchParams.get("i"), 10) || 0;
        const list = playlist();
        const f = list[i];
        if (!f) { res.writeHead(404); return res.end(); }
        const full = path.join(TRACKS_DIR, f);
        const ext = f.split(".").pop().toLowerCase();
        const mime = { mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4" }[ext];
        const size = fs.statSync(full).size;
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range) || [];
          const start = parseInt(m[1], 10) || 0;
          const end = m[2] ? parseInt(m[2], 10) : size - 1;
          res.writeHead(206, { "content-type": mime, "accept-ranges": "bytes",
            "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
          fs.createReadStream(full, { start, end }).pipe(res);
        } else {
          res.writeHead(200, { "content-type": mime, "accept-ranges": "bytes", "content-length": size });
          fs.createReadStream(full).pipe(res);
        }
      },
      // POST /plugin/music/upload?name=song.mp3 — add a track (raw file body)
      upload(req, res, { readBodyRaw }) {
        const name = (new URL(req.url, "http://x").searchParams.get("name") || "")
          .replace(/[^\w.\- ก-๙]/g, "_");
        if (!/\.(mp3|ogg|wav|m4a)$/i.test(name)) { res.writeHead(400); return res.end("need .mp3/.ogg/.wav/.m4a"); }
        readBodyRaw(req, (buf) => {
          try {
            fs.writeFileSync(path.join(TRACKS_DIR, name), buf);
            push("➕ เพิ่ม " + name);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, name }));
          } catch (e) { res.writeHead(500); res.end(String(e.message)); }
        });
      },
    },
  };
};
