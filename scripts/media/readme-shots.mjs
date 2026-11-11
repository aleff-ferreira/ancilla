// The README images: 1440x950 at device scale 1 (the size of the images in docs/assets), dark theme, rendered from the
// browser demo (`npm run demo --workspace @ancilla/web`) and named as they are in docs/assets.
// Usage: node scripts/media/readme-shots.mjs <out-folder> [scene|all]
import { mkdirSync } from "node:fs";
import { launch, sleep } from "./cdp.mjs";

const out = process.argv[2];
const only = process.argv[3] ?? "all";
mkdirSync(out, { recursive: true });
const base = `http://127.0.0.1:${process.env.DEMO_PORT ?? "5299"}/demo.html`;
const W = 1440;
const H = 950;
const q = "theme=dark";

const clickButton = (b, text) =>
  b.eval(`(() => { const el = Array.from(document.querySelectorAll('button, [role="tab"], [role="radio"]')).find((e) => !e.closest('aside') && ((e.getAttribute('aria-label') || e.textContent || '').trim() === ${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
const clickTab = (b, text) =>
  b.eval(`(() => { const el = Array.from(document.querySelectorAll('button, [role="tab"]')).find((e) => !e.closest('aside') && e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);
const SCROLLER = `(() => { const c = Array.from(document.querySelectorAll('*')).filter((e) => { if (e.closest('aside')) return false; const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 40 && e.clientWidth > 500; }); c.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth); return c[0] ?? null; })()`;

async function scene(name, fn) {
  if (only !== "all" && only !== name) return;
  const b = await launch({ width: W, height: H, dpr: 1, scheme: "dark" });
  try {
    await fn(b, () => b.shot(`${out}/${name}.png`, { x: 0, y: 0, width: W, height: H }));
    console.log("ok", name);
  } catch (error) {
    console.log(`${name} failed:`, error.message);
  } finally {
    await b.close();
  }
}

await scene("home", async (b, shot) => { await b.goto(`${base}?${q}`, 2600); await shot(); });
await scene("thread", async (b, shot) => { await b.goto(`${base}?view=diff&${q}`, 2800); await b.eval(`(() => { const el = ${SCROLLER}; if (el) el.scrollTop = 0; })()`); await sleep(500); await shot(); });
await scene("agents", async (b, shot) => { await b.goto(`${base}?crew=running&panel=crew&${q}`, 3400); await shot(); });
await scene("usage", async (b, shot) => { await b.goto(`${base}?view=usage&${q}`, 2800); await shot(); });
await scene("research", async (b, shot) => { await b.goto(`${base}?view=research&${q}`, 3200); await shot(); });
await scene("research-report", async (b, shot) => {
  await b.goto(`${base}?view=research&${q}`, 3200);
  console.log("scrolled:", await b.eval(`(() => { const el = ${SCROLLER}; if (!el) return 'no scroller'; const hit = Array.from(el.querySelectorAll('*')).find((n) => n.children.length === 0 && /^What does WCAG require/.test(n.textContent.trim())); if (!hit) return 'no text'; el.scrollTop += hit.getBoundingClientRect().top - 75; return 'ok'; })()`));
  await sleep(600);
  // The menu opens on a real pointer press, so press where the button is.
  const dl = await b.eval(`(() => { const el = Array.from(document.querySelectorAll('button')).find((e) => !e.closest('aside') && /^Download/.test((e.textContent || '').trim())); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  console.log("download at:", JSON.stringify(dl));
  if (dl) await b.click(dl.x, dl.y);
  await sleep(900);
  await shot();
});
await scene("assistant-home", async (b, shot) => { await b.goto(`${base}?${q}#/assistant`, 3200); await shot(); });
// The Persona tab at its Look section: a character chosen, with the preview that follows the reader above the tabs.
await scene("assistant-persona", async (b, shot) => {
  await b.goto(`${base}?${q}#/assistant`, 2600);
  await clickTab(b, "Persona");
  await sleep(1100);
  await clickButton(b, "Orbital Core");
  await sleep(700);
  await b.eval(`(() => { const el = ${SCROLLER}; const t = Array.from(document.querySelectorAll('[role="tablist"]')).find((x) => x.getAttribute('aria-label') === 'How to choose a look'); if (el && t) el.scrollTop += t.getBoundingClientRect().top - el.getBoundingClientRect().top - 300; })()`);
  await sleep(700);
  await shot();
});
// The ready-made characters side by side (the browser demo's gallery of faces).
await scene("assistant-avatars", async (b, shot) => { await b.goto(`${base}?gallery=avatars&section=presets&${q}`, 2200); await shot(); });
await scene("assistant-memory", async (b, shot) => { await b.goto(`${base}?${q}#/assistant`, 2600); await clickTab(b, "Memory"); await sleep(1100); await shot(); });
await scene("assistant-meeting", async (b, shot) => {
  await b.goto(`${base}?assistant=new&${q}#/assistant`, 2600);
  await clickButton(b, "Let's begin");
  await sleep(900);
  await clickButton(b, "Chronometer");
  await sleep(500);
  await clickButton(b, "Amber");
  await sleep(900);
  await shot();
});
