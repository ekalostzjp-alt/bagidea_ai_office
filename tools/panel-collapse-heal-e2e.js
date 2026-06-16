// panel-collapse-heal-e2e.js — headless behavioral verify for the collapse trap fix.
// Drives the REAL served overlay (http://127.0.0.1:8787/) in installed Chrome and
// proves, by behavior (not grep), that:
//   A. a machine stuck collapsed:true heals itself to a full panel on reload
//   B. while collapsed, the header + ▢ expand button stay visible & clickable
//   C. menus/modals still pop (the regression), including WHILE collapsed
//   D. the prompt input is interactive (typeable + send button live)
//
// Run:  NODE_PATH=<tmp>/node_modules CHROME=<chrome.exe> node tools/panel-collapse-heal-e2e.js
const puppeteer = require("puppeteer-core");
const URL = "http://127.0.0.1:8787/";
const CHROME = process.env.CHROME ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m) => { fail++; console.log("  ✗ " + m); };
const expect = (cond, m) => (cond ? ok(m) : bad(m));

// settle for the panelChrome IIFE + CSS to apply
const settle = (p) => p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 600, height: 760 });
  page.on("pageerror", (e) => console.log("  [pageerror] " + e.message));

  // visibility helper run in-page: truly rendered (box + not display:none/hidden)
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.__vis = (id) => {
      const el = document.getElementById(id);
      if (!el) return { exists: false };
      const cs = getComputedStyle(el);
      return {
        exists: true,
        display: cs.display, visibility: cs.visibility,
        // offsetParent null + zero box == not laid out
        shown: cs.display !== "none" && cs.visibility !== "hidden" &&
               (el.offsetWidth > 0 || el.offsetHeight > 0),
      };
    };
  });

  // ---- A. STUCK-MACHINE SELF-HEAL ----------------------------------------
  console.log("\nA) Stuck collapsed:true + maximized:true heals on reload");
  await page.evaluate(() => localStorage.setItem("officePanel",
    JSON.stringify({ collapsed: true, maximized: true, w: 560, h: 700 })));
  await page.reload({ waitUntil: "domcontentloaded" });
  await settle(page);
  // re-inject helper after reload
  await page.evaluate(() => {
    window.__vis = (id) => {
      const el = document.getElementById(id);
      if (!el) return { exists: false };
      const cs = getComputedStyle(el);
      return { exists: true, display: cs.display, visibility: cs.visibility,
        shown: cs.display !== "none" && cs.visibility !== "hidden" &&
               (el.offsetWidth > 0 || el.offsetHeight > 0) };
    };
  });
  const A = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("officePanel") || "{}");
    return {
      pcollapsed: document.body.classList.contains("pcollapsed"),
      pmax: document.body.classList.contains("pmax"),
      storedCollapsed: stored.collapsed, storedMax: stored.maximized,
      header: window.__vis("titlebar"), collapseBtn: window.__vis("collapseBtn"),
      footer: window.__vis("inp"), rail: !!document.getElementById("rail"),
      main: !!document.querySelector("main"),
      mainShown: getComputedStyle(document.querySelector("main")).display !== "none",
      feed: !!document.getElementById("feed"),
    };
  });
  expect(A.pcollapsed === false, "body is NOT pcollapsed after reload (healed)");
  expect(A.pmax === false, "body is NOT pmax after reload (healed)");
  expect(A.storedCollapsed === false, "stored officePanel.collapsed rewritten to false");
  expect(A.storedMax === false, "stored officePanel.maximized rewritten to false");
  expect(A.header.shown, "header strip visible");
  expect(A.footer.shown, "prompt input (#inp) visible");
  expect(A.mainShown, "main content region visible");
  expect(A.rail && A.main && A.feed, "rail/main/feed all present in DOM");

  // ---- B. COLLAPSE ESCAPE HATCH ------------------------------------------
  console.log("\nB) Manual collapse keeps header + ▢ visible & clickable");
  await page.click("#collapseBtn"); await settle(page);
  const B = await page.evaluate(() => ({
    pcollapsed: document.body.classList.contains("pcollapsed"),
    header: window.__vis("titlebar"), collapseBtn: window.__vis("collapseBtn"),
    footerDisplay: getComputedStyle(document.querySelector("footer")).display,
    btnText: document.getElementById("collapseBtn").textContent,
  }));
  expect(B.pcollapsed === true, "clicking collapse enters pcollapsed mode");
  expect(B.header.shown, "header STILL visible while collapsed");
  expect(B.collapseBtn.shown, "▢ expand button STILL visible while collapsed");
  expect(B.btnText.includes("▢"), "button shows ▢ (expand affordance) when collapsed");
  expect(B.footerDisplay === "none", "footer/content hidden while collapsed (by design)");

  // ---- C. MODAL POPS WHILE COLLAPSED (the original regression) ------------
  console.log("\nC) Menus/modals still pop — even while collapsed");
  await page.click("#opsBtn"); await settle(page);
  const C = await page.evaluate(() => {
    const m = document.getElementById("modal");
    const cs = getComputedStyle(m);
    return { open: m.classList.contains("open"), display: cs.display,
             shown: cs.display !== "none" && m.offsetHeight > 0 };
  });
  expect(C.open, "#modal got .open from clicking 🗂 while collapsed");
  expect(C.shown && C.display === "flex", "#modal actually renders (display:flex, has box)");
  await page.evaluate(() => document.getElementById("modal").classList.remove("open"));

  // click ▢ to escape back to full panel
  await page.click("#collapseBtn"); await settle(page);
  const Cexp = await page.evaluate(() => ({
    pcollapsed: document.body.classList.contains("pcollapsed"),
    footerShown: getComputedStyle(document.querySelector("footer")).display !== "none",
  }));
  expect(Cexp.pcollapsed === false, "clicking ▢ expands back to full panel");
  expect(Cexp.footerShown, "footer/content restored after expand");

  // ---- D. PROMPT INPUT INTERACTIVE (no live send fired) -------------------
  console.log("\nD) Prompt input is interactive (typeable, send button live)");
  await page.focus("#inp");
  await page.type("#inp", "verify-headless-typing");
  const D = await page.evaluate(() => {
    const inp = document.getElementById("inp"), send = document.getElementById("send");
    const sc = getComputedStyle(send);
    return { val: inp.value, disabled: inp.disabled,
             sendShown: sc.display !== "none" && send.offsetWidth > 0,
             sendDisabled: send.disabled };
  });
  expect(D.val === "verify-headless-typing", "typed text lands in #inp");
  expect(!D.disabled, "#inp is enabled");
  expect(D.sendShown && !D.sendDisabled, "send ➤ button visible & enabled (not firing — avoid live run)");
  await page.evaluate(() => { document.getElementById("inp").value = ""; });

  await browser.close();
  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
