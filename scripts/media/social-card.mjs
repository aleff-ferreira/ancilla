// The repository's social card, 1280x640 (GitHub's size), drawn in the brand's own type and colours over the demo page so the
// fonts are the app's. Rendered at device scale 2 and brought down to 1280x640 afterwards, so the small type stays crisp.
// Usage: node scripts/media/social-card.mjs <out-2x.png> <assistant-home.png>, then `python3 scripts/media/encode.py card <out-2x.png> <final.png>`.
import { readFileSync } from "node:fs";
import { launch, sleep } from "./cdp.mjs";

const [out, shotPath] = process.argv.slice(2);
const dataUri = `data:image/png;base64,${readFileSync(shotPath).toString("base64")}`;
const b = await launch({ width: 1280, height: 640, dpr: 2, scheme: "dark" });
try {
  await b.goto(`http://127.0.0.1:${process.env.DEMO_PORT ?? "5299"}/demo.html?gallery=avatars&theme=dark`, 1500);
  await b.eval(`window.__shot = ${JSON.stringify(dataUri)}; 'ok'`);
  await b.eval(`(async () => {
    const SANS = "'Inter Variable',Inter,ui-sans-serif,system-ui,sans-serif";
    const SERIF = "'Fraunces Variable',Fraunces,Georgia,serif";
    document.body.innerHTML = '';
    document.documentElement.style.cssText = 'background:#0b1511;margin:0';
    document.body.style.cssText = 'margin:0;background:#0b1511';
    const el = (tag, css, html, parent) => { const e = document.createElement(tag); e.style.cssText = css; if (html !== undefined) e.innerHTML = html; (parent || root).appendChild(e); return e; };
    const root = el('div', 'position:fixed;left:0;top:0;width:1280px;height:640px;overflow:hidden;background:#0b1511;color:#edf4ec;font-family:' + SANS + ';-webkit-font-smoothing:antialiased', undefined, document.body);
    el('div', 'position:absolute;inset:0;background:radial-gradient(760px 480px at 76% 56%,rgba(99,205,169,.20),transparent 70%),radial-gradient(520px 320px at 8% 4%,rgba(99,205,169,.07),transparent 70%)');
    el('div', 'position:absolute;inset:0;opacity:.55;background-image:linear-gradient(rgba(99,205,169,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(99,205,169,.06) 1px,transparent 1px);background-size:64px 64px;-webkit-mask-image:radial-gradient(ellipse at 70% 55%,#000 0,transparent 72%)');
    el('div', 'position:absolute;left:72px;top:58px;display:flex;align-items:center;gap:16px',
      '<svg width="50" height="50" viewBox="0 0 32 32"><path d="M8.25 22.5L16 8.5L23.75 22.5" fill="none" stroke="#edf4ec" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="18.75" r="2" fill="#63cda9"/></svg><span style="font-weight:600;font-size:36px;letter-spacing:-0.9px">Ancilla</span>');
    el('div', 'position:absolute;left:72px;top:172px;width:560px',
      '<div style="font-family:' + SERIF + ';font-weight:400;font-size:84px;line-height:1.03;letter-spacing:-2.6px">Deep research.<br>Agents in view.</div>' +
      '<div style="margin-top:34px;font-size:25px;line-height:1.4;color:#a9bbaf;max-width:500px">An open-source workspace for Muse Code, on desktop and the web.</div>');
    el('div', 'position:absolute;left:72px;bottom:52px;display:flex;gap:12px;font-size:17px;color:#9fb3a7',
      '<span style="padding:8px 16px;border:1px solid rgba(99,205,169,.38);border-radius:999px">Windows, macOS, Linux</span><span style="padding:8px 16px;border:1px solid rgba(99,205,169,.38);border-radius:999px">Unofficial, AGPL-3.0</span>');
    const frame = el('div', 'position:absolute;left:648px;top:112px;width:700px;height:430px;border-radius:18px;overflow:hidden;border:1px solid rgba(255,255,255,.14);box-shadow:0 34px 90px rgba(0,0,0,.65),0 0 0 6px rgba(99,205,169,.05)');
    const img = document.createElement('img');
    // The screenshot is 1440 wide; show the part from x=445, y=25 at 0.82 scale, so the face and what it would do next fill the frame.
    img.style.cssText = 'position:absolute;left:' + (-445 * 0.82) + 'px;top:' + (-25 * 0.82) + 'px;width:' + (1440 * 0.82) + 'px;max-width:none;height:auto;display:block';
    img.src = window.__shot;
    frame.appendChild(img);
    await img.decode();
    await Promise.all([document.fonts.load("400 84px 'Fraunces Variable'"), document.fonts.load("600 36px 'Inter Variable'"), document.fonts.load("400 25px 'Inter Variable'"), document.fonts.load("400 17px 'Inter Variable'")]);
    await document.fonts.ready;
  })()`);
  await sleep(900);
  await b.shot(out, { x: 0, y: 0, width: 1280, height: 640 });
} finally {
  await b.close();
}
