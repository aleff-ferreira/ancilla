// Records a clip of the demo as a screencast (60 Hz compositor, every second frame kept, JPEG) while a script drives it
// like a person would: a visible cursor that glides to real elements, real mouse and keyboard events, captions, fades.
// The page is 1920x1080 with the app's own zoom at 1.5, so it lays out like a 1280x720 window and draws crisp at 1080p.
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, sleep } from "./cdp.mjs";

export { sleep };
export const W = 1920;
export const H = 1080;
export const ZOOM = 1.5;
export const ROOT = process.env.TOUR_DIR ?? join(tmpdir(), "ancilla-tour");
const BASE = `http://127.0.0.1:${process.env.DEMO_PORT ?? "5299"}/demo.html`;
const OVERLAY = readFileSync(new URL("./tour-overlay.js", import.meta.url), "utf8");

/** The page-side lookup: one element by selector, by its label or text, or by the text of a leaf node. */
const finder = (spec) => `(() => {
  const spec = ${JSON.stringify(spec)};
  const scope = spec.within ? document.querySelector(spec.within) : document;
  if (!scope) return null;
  let els = spec.selector ? Array.from(scope.querySelectorAll(spec.selector)) : Array.from(scope.querySelectorAll(spec.leafRe ? '*' : 'button, a, [role="tab"], [role="radio"], [role="button"], input, textarea, summary, label, [role="menuitem"]'));
  els = els.filter((e) => !e.closest('#tour-root') && (spec.sidebar || !e.closest('aside')));
  if (spec.leafRe) { const re = new RegExp(spec.leafRe); els = els.filter((e) => e.children.length === 0 && re.test(e.textContent.trim())); }
  if (spec.text) {
    els = els.filter((e) => {
      const t = (e.getAttribute('aria-label') || e.textContent || '').trim();
      return spec.has ? t.includes(spec.text) : spec.starts ? t.startsWith(spec.text) : t === spec.text;
    });
  }
  els = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (spec.minY === undefined || r.y + r.height / 2 >= spec.minY) && (spec.minX === undefined || r.x + r.width / 2 >= spec.minX) && (spec.maxX === undefined || r.x + r.width / 2 <= spec.maxX) && (spec.maxY === undefined || r.y + r.height / 2 <= spec.maxY); });
  const el = els[spec.nth ?? 0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width * (spec.fx ?? 0.5), y: r.y + r.height * (spec.fy ?? 0.5), w: r.width, h: r.height, text: (el.textContent || '').trim().slice(0, 40) };
})()`;

/** The main scrolling region of the page, away from the sidebar. */
const SCROLLER = `(() => { const c = Array.from(document.querySelectorAll('*')).filter((e) => { if (e.closest('aside') || e.closest('#tour-root')) return false; const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 40 && e.clientWidth > 600; }); c.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth); return c[0] ?? null; })()`;

function stage(b) {
  const S = { b, sleep, pos: { x: W * 0.62, y: H * 0.6 }, shown: false };
  const js = (code) => b.eval(code);
  S.veil = (o, ms = 700) => js(`__tour.veil(${o}, ${ms})`);
  S.caption = (t, s = "", pos = "bottom") => js(`__tour.caption(${JSON.stringify(t)}, ${JSON.stringify(s)}, ${JSON.stringify(pos)})`);
  S.captionOff = () => js(`__tour.captionOff()`);
  S.card = (name, opts) => js(`__tour.card(${JSON.stringify(name)}, ${JSON.stringify(opts ?? null)})`);
  S.cardOff = () => js(`__tour.cardOff()`);
  S.cursorVis = (on) => js(`__tour.cursorVis(${on})`);
  S.find = (spec) => js(finder(spec));

  S.moveTo = async (x, y, ms) => {
    if (!S.shown) {
      S.shown = true;
      await js(`__tour.cursor(${S.pos.x}, ${S.pos.y}); __tour.cursorVis(true)`);
    }
    const from = { ...S.pos };
    const dist = Math.hypot(x - from.x, y - from.y);
    const dur = ms ?? Math.min(1500, Math.max(520, 380 + dist * 0.6));
    const nx = -(y - from.y) / (dist || 1);
    const ny = (x - from.x) / (dist || 1);
    const bend = Math.min(70, dist * 0.08);
    const cx = (from.x + x) / 2 + nx * bend;
    const cy = (from.y + y) / 2 + ny * bend;
    const t0 = performance.now();
    for (;;) {
      const p = Math.min(1, (performance.now() - t0) / dur);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const px = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * cx + e * e * x;
      const py = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * cy + e * e * y;
      await Promise.all([b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py }), js(`__tour.cursor(${px}, ${py})`)]);
      if (p >= 1) break;
      await sleep(6);
    }
    S.pos = { x, y };
  };
  S.hover = async (spec, o = {}) => {
    let t = await S.find(spec);
    if (!t) throw new Error(`hover: not found ${JSON.stringify(spec)}`);
    // A target outside the comfortable part of the screen is scrolled to first, smoothly, as a person would.
    if (t.y < 160 || t.y > H - 200) {
      await S.scrollBy(t.y - H * 0.48, 800);
      await sleep(120);
      t = (await S.find(spec)) ?? t;
    }
    await S.moveTo(t.x, t.y, o.ms);
    return t;
  };
  S.press = async (x, y, count = 1) => {
    await js(`__tour.pulse(${x}, ${y})`);
    await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: count });
    await sleep(70);
    await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: count });
  };
  S.click = async (spec, o = {}) => {
    const t = await S.hover(spec, o);
    await sleep(o.pause ?? 140);
    await S.press(t.x, t.y);
    return t;
  };
  S.type = async (text, per = 75) => {
    for (const ch of text) {
      await b.send("Input.insertText", { text: ch });
      await sleep(per * (0.7 + Math.random() * 0.6));
    }
  };
  S.select = () => js(`document.activeElement && document.activeElement.select && document.activeElement.select()`);
  S.key = (name) => b.press(name);

  S.scrollBy = (dy, ms = 1200) => js(`new Promise((done) => { const el = ${SCROLLER}; if (!el) return done(null); const from = el.scrollTop; const to = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, from + ${dy})); const t0 = performance.now(); const step = (now) => { const p = Math.min(1, (now - t0) / ${ms}); const e = p < .5 ? 4*p*p*p : 1 - Math.pow(-2*p+2, 3)/2; el.scrollTop = from + (to - from) * e; if (p < 1) requestAnimationFrame(step); else done(el.scrollTop); }; requestAnimationFrame(step); })`);
  S.scrollTop = (y, ms = 1200) => js(`new Promise((done) => { const el = ${SCROLLER}; if (!el) return done(null); const from = el.scrollTop; const to = ${y} < 0 ? el.scrollHeight - el.clientHeight : ${y}; const t0 = performance.now(); const step = (now) => { const p = Math.min(1, (now - t0) / ${ms}); const e = p < .5 ? 4*p*p*p : 1 - Math.pow(-2*p+2, 3)/2; el.scrollTop = from + (to - from) * e; if (p < 1) requestAnimationFrame(step); else done(el.scrollTop); }; requestAnimationFrame(step); })`);

  /** Waits (up to `timeout` ms) until some leaf node's text matches `re`; resolves true, or false on timeout. */
  S.waitText = async (re, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await js(`(() => { const rx = new RegExp(${JSON.stringify(re)}); return Array.from(document.querySelectorAll('*')).some((n) => !n.closest('#tour-root') && n.children.length === 0 && rx.test(n.textContent.trim())); })()`)) return true;
      await sleep(150);
    }
    return false;
  };

  /** Scrolls so the first leaf node whose text matches `re` sits `offsetTop` px below the top of the page. */
  S.scrollToText = (re, offsetTop = 240, ms = 1400) => js(`new Promise((done) => { const el = ${SCROLLER}; if (!el) return done('no scroller'); const rx = new RegExp(${JSON.stringify(re)}); const hit = Array.from(el.querySelectorAll('*')).find((n) => n.children.length === 0 && rx.test(n.textContent.trim())); if (!hit) return done('no text'); const from = el.scrollTop; const to = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, from + hit.getBoundingClientRect().top - ${offsetTop})); const t0 = performance.now(); const step = (now) => { const p = Math.min(1, (now - t0) / ${ms}); const e = p < .5 ? 4*p*p*p : 1 - Math.pow(-2*p+2, 3)/2; el.scrollTop = from + (to - from) * e; if (p < 1) requestAnimationFrame(step); else done('ok'); }; requestAnimationFrame(step); })`);

  /** A camera move: scale the app about a point and slide that point to a place on screen, then back with `cameraReset`. */
  // Points are screen pixels; inside the app's own zoom a CSS length is ZOOM times a screen pixel, so they are divided by it.
  S.camera = (fx, fy, scale, ms = 900, toX = W / 2, toY = H / 2) => js(`(() => { const r = document.getElementById('root'); if (!r) return; r.style.transformOrigin = '${fx / ZOOM}px ${fy / ZOOM}px'; r.style.transition = 'transform ${ms}ms cubic-bezier(.65,0,.35,1)'; void r.offsetWidth; r.style.transform = 'translate(${(toX - fx) / ZOOM}px, ${(toY - fy) / ZOOM}px) scale(${scale})'; })()`);
  S.cameraReset = (ms = 900) => js(`(() => { const r = document.getElementById('root'); if (!r) return; r.style.transition = 'transform ${ms}ms cubic-bezier(.65,0,.35,1)'; r.style.transform = 'none'; })()`);
  return S;
}

/** Records `script(S)` against a fresh page of the demo and writes the frames and their times next to each other. */
export async function clip(name, { query = "", hash = "", settle = 1800 } = {}, script) {
  const dir = `${ROOT}/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const b = await launch({ width: W, height: H, dpr: 1, scheme: "dark" });
  const frames = [];
  b.on("Page.screencastFrame", (p) => {
    const file = `${dir}/f${String(frames.length).padStart(6, "0")}.jpg`;
    // "m" is when the frame arrived on a monotonic clock. "t" is the screencast's own stamp, on the wall clock, which the
    // machine can set back (WSL2 does, by about two seconds); encode.py uses "m" and repairs recordings that have only "t".
    frames.push({ t: p.metadata.timestamp, m: performance.now() / 1000, file });
    writeFileSync(file, Buffer.from(p.data, "base64"));
    b.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  });
  let tEnd = 0;
  let tEndM = 0;
  try {
    await b.goto(`${BASE}?${query}${query ? "&" : ""}theme=dark&zoom=${ZOOM}${hash}`, settle);
    await b.eval(OVERLAY);
    const m0 = performance.now() / 1000;
    await b.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 2 });
    await script(stage(b));
    tEnd = Date.now() / 1000;
    tEndM = performance.now() / 1000;
    await b.send("Page.stopScreencast");
    console.log(`timing: script ${(tEndM - m0).toFixed(2)} s, first frame at +${((frames[0]?.m ?? m0) - m0).toFixed(2)} s, last frame at +${((frames.at(-1)?.m ?? m0) - m0).toFixed(2)} s`);
  } finally {
    await b.close();
  }
  writeFileSync(`${dir}/frames.json`, JSON.stringify({ tEnd, tEndM, frames }));
  console.log(`${name}: ${frames.length} frames over ${(tEndM - frames[0].m).toFixed(1)} s`);
}
