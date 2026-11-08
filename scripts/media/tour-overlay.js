// Installed into the demo page while a tour clip is recorded: a veil to fade through, captions, the title and closing
// cards, and a cursor with a click ripple. It sits outside the app's own zoom (the page is 1920x1080 with the app's zoom
// at 1.5, so the overlay counter-zooms to draw in real pixels). Brand: forest #0b1511, ink #edf4ec, emerald #63cda9.
(() => {
  if (window.__tour) return "already";
  const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
  const W = innerWidth;
  const H = innerHeight;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const SANS = '"Inter Variable",Inter,ui-sans-serif,system-ui,sans-serif';
  const SERIF = '"Fraunces Variable",Fraunces,Georgia,serif';
  const MONO = '"JetBrains Mono Variable","JetBrains Mono",ui-monospace,monospace';

  const style = document.createElement("style");
  style.textContent = `
  #tour-root{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;overflow:hidden;font-family:${SANS};-webkit-font-smoothing:antialiased}
  #tour-root *{box-sizing:border-box}
  #tour-veil{position:absolute;inset:0;background:#0b1511;opacity:1;transition:opacity .7s cubic-bezier(.4,0,.2,1)}
  #tour-card{position:absolute;inset:0;background:#0b1511;opacity:0;transition:opacity .6s ease}
  #tour-card.on{opacity:1}
  #tour-cap{position:absolute;left:50%;max-width:1360px;min-width:560px;padding:18px 40px 20px;border-radius:22px;background:rgba(8,16,12,.95);border:1px solid rgba(99,205,169,.36);box-shadow:0 22px 70px rgba(0,0,0,.62);text-align:center;opacity:0;transition:opacity .5s ease,transform .55s cubic-bezier(.2,.8,.2,1)}
  #tour-cap.top{top:36px;transform:translate(-50%,-18px)}
  #tour-cap.bottom{bottom:44px;transform:translate(-50%,18px)}
  #tour-cap.on{opacity:1;transform:translate(-50%,0)}
  #tour-cap b{display:block;font-weight:600;font-size:40px;line-height:1.15;letter-spacing:-.5px;color:#edf4ec}
  #tour-cap span{display:block;margin-top:8px;font-size:25px;line-height:1.35;color:#a9bbaf}
  #tour-cursor{position:absolute;left:0;top:0;width:38px;height:38px;opacity:0;transition:opacity .3s ease;will-change:transform;filter:drop-shadow(0 4px 6px rgba(0,0,0,.6))}
  .tour-ripple{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:3px solid #63cda9;background:rgba(99,205,169,.18);animation:tour-rip .65s ease-out forwards}
  @keyframes tour-rip{from{transform:scale(.4);opacity:1}to{transform:scale(3.4);opacity:0}}

  .tc{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 150px;color:#edf4ec}
  .tc-grid{position:absolute;inset:0;opacity:.5;background-image:linear-gradient(rgba(99,205,169,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(99,205,169,.07) 1px,transparent 1px);background-size:96px 96px;mask-image:radial-gradient(ellipse at 72% 50%,#000 0,transparent 68%);-webkit-mask-image:radial-gradient(ellipse at 72% 50%,#000 0,transparent 68%)}
  .tc-brand{position:relative;display:flex;align-items:center;gap:22px;margin-bottom:64px;opacity:0;animation:tc-up .8s .15s cubic-bezier(.2,.8,.2,1) forwards}
  .tc-brand svg{width:84px;height:84px}
  .tc-brand strong{font-weight:600;font-size:58px;line-height:1;letter-spacing:-1.4px}
  .tc-top{position:absolute;right:150px;top:92px;font-size:22px;letter-spacing:7px;color:#a4b4a9}
  .tc h1{position:relative;margin:0;font-family:${SERIF};font-weight:400;font-size:138px;line-height:1.04;letter-spacing:-3.5px}
  .tc h1 span{display:block;opacity:0;transform:translateY(30px);animation:tc-up 1s cubic-bezier(.2,.8,.2,1) forwards}
  .tc h1 span:nth-child(1){animation-delay:.55s}
  .tc h1 span:nth-child(2){animation-delay:.95s}
  .tc p{position:relative;margin:44px 0 0;font-size:34px;color:#a9bbaf;opacity:0;animation:tc-up .9s 1.5s cubic-bezier(.2,.8,.2,1) forwards}
  .tc small{position:absolute;left:150px;bottom:70px;font-size:22px;letter-spacing:.4px;color:#7d9186;opacity:0;animation:tc-up .8s 2s ease forwards}
  .tc-url{position:relative;margin:30px 0 0;font:500 70px/1.1 ${MONO};letter-spacing:-1.5px;color:#63cda9;opacity:0;animation:tc-up .9s 1.1s cubic-bezier(.2,.8,.2,1) forwards}
  .tc-os{position:relative;margin:34px 0 0;font-size:34px;color:#a9bbaf;opacity:0;animation:tc-up .9s 1.5s cubic-bezier(.2,.8,.2,1) forwards}
  .tc-art{position:absolute;right:120px;top:50%;width:800px;height:392px;transform:translateY(-50%)}
  .tc-art .ln{fill:none;stroke:#63cda9;stroke-opacity:.5;stroke-width:1.8;stroke-dasharray:1;stroke-dashoffset:1;animation:tc-draw 2.4s .7s ease forwards}
  .tc-art .nd{fill:#0b1511;stroke:#63cda9;stroke-width:1.8;opacity:0;animation:tc-pop .6s ease forwards}
  .tc-art .dot{fill:#63cda9;opacity:0;animation:tc-pop .6s ease forwards}
  .tc-art .live{fill:#6bb8e7;opacity:0;animation:tc-pop .6s ease forwards}
  .tc-art .cell{fill:#63cda9;fill-opacity:.14;stroke:#63cda9;stroke-opacity:.45;opacity:0;animation:tc-pop .6s ease forwards}
  .tc-art text{font-family:${MONO};font-size:15px;letter-spacing:1.4px;fill:#8ea298;opacity:0;animation:tc-pop .8s 2s ease forwards}
  .tc.outro h1{font-size:104px;letter-spacing:-2.6px}
  .tc.outro .tc-url{font-size:42px;letter-spacing:-.8px;margin-top:34px}
  .tc.outro .tc-os{font-size:30px;margin-top:26px;max-width:880px;line-height:1.4}
  @keyframes tc-up{to{opacity:1;transform:none}}
  @keyframes tc-draw{to{stroke-dashoffset:0}}
  @keyframes tc-pop{from{opacity:0;transform-box:fill-box;transform-origin:center;transform:scale(.4)}to{opacity:1;transform-box:fill-box;transform-origin:center;transform:scale(1)}}
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "tour-root";
  root.style.cssText = `width:${W}px;height:${H}px;zoom:${1 / zoom}`;
  root.innerHTML = `<div id="tour-card"></div><div id="tour-cap"></div>
    <svg id="tour-cursor" viewBox="0 0 24 24"><path d="M4 2.5l0 17 4.6-4.1 3 6.9 3-1.3-3-6.8 6.2-.2z" fill="#fff" stroke="#0b1511" stroke-width="1.5" stroke-linejoin="round"/></svg>
    <div id="tour-veil"></div>`;
  document.documentElement.appendChild(root);
  const $ = (id) => root.querySelector(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const mark = `<svg viewBox="0 0 32 32"><path d="M8.25 22.5L16 8.5L23.75 22.5" fill="none" stroke="#edf4ec" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="18.75" r="2" fill="#63cda9"/></svg>`;
  const art = `<svg class="tc-art" viewBox="940 176 510 250">
      <g><path class="ln" pathLength="1" d="M960 304C1016 304 1010 216 1080 216H1214"/><path class="ln" pathLength="1" d="M960 304C1022 304 1056 304 1080 304H1214"/><path class="ln" pathLength="1" d="M960 304C1016 304 1010 392 1080 392H1214"/>
      <path class="ln" pathLength="1" d="M1250 216H1320C1370 216 1366 304 1430 304"/><path class="ln" pathLength="1" d="M1250 304H1430"/><path class="ln" pathLength="1" d="M1250 392H1320C1370 392 1366 304 1430 304"/></g>
      <circle class="nd" style="animation-delay:.5s" cx="960" cy="304" r="13"/><circle class="dot" style="animation-delay:.7s" cx="960" cy="304" r="4"/>
      <circle class="nd" style="animation-delay:1.3s" cx="1080" cy="216" r="5"/><circle class="nd" style="animation-delay:1.4s" cx="1080" cy="304" r="5"/><circle class="nd" style="animation-delay:1.5s" cx="1080" cy="392" r="5"/>
      <rect class="cell" style="animation-delay:1.9s" x="1214" y="198" width="36" height="36" rx="5"/><rect class="cell" style="animation-delay:2s" x="1214" y="286" width="36" height="36" rx="5"/><rect class="cell" style="animation-delay:2.1s" x="1214" y="374" width="36" height="36" rx="5"/>
      <circle class="dot" style="animation-delay:2.2s" cx="1232" cy="216" r="4"/><circle class="live" style="animation-delay:2.3s" cx="1232" cy="304" r="4"/><circle class="dot" style="animation-delay:2.4s" cx="1232" cy="392" r="4"/>
      <circle class="nd" style="animation-delay:2.7s" cx="1430" cy="304" r="13"/><circle class="dot" style="animation-delay:2.8s" cx="1430" cy="304" r="4"/>
      <text x="1097" y="194">RESEARCH</text><text x="1097" y="282">MONITOR</text><text x="1097" y="370">SYNTHESIZE</text></svg>`;

  const cards = {
    title: (o) => `<div class="tc"><div class="tc-grid"></div>${art}<div class="tc-top">AMAZONIA WORKS</div>
      <div class="tc-brand">${mark}<strong>Ancilla</strong></div>
      <h1><span>Deep research.</span><span>Agents in view.</span></h1>
      <p>${esc(o?.sub ?? "A workspace for Muse Code, on desktop and web")}</p>
      <small>Unofficial community project, not affiliated with Meta. Shown with sample data.</small></div>`,
    outro: () => `<div class="tc outro"><div class="tc-grid"></div>${art}<div class="tc-top">AMAZONIA WORKS</div>
      <div class="tc-brand">${mark}<strong>Ancilla</strong></div>
      <h1><span>Free and open source.</span></h1>
      <div class="tc-url">github.com/aleff-ferreira/ancilla</div>
      <div class="tc-os">Windows, macOS and Linux. Uses your Muse login, no extra API keys.</div>
      <small>Unofficial community project, not affiliated with Meta. AGPL-3.0. Shown with sample data.</small></div>`,
  };

  window.__tour = {
    veil(o, ms) { const v = $("#tour-veil"); v.style.transitionDuration = `${ms}ms`; v.style.opacity = String(o); },
    card(name, opts) {
      // Instantly opaque (no crossfade with the page behind it): the veil is what fades.
      const c = $("#tour-card");
      c.innerHTML = cards[name](opts);
      c.style.transition = "none";
      c.classList.add("on");
      void c.offsetWidth;
      c.style.transition = "";
    },
    cardOff() { $("#tour-card").classList.remove("on"); },
    async caption(title, sub, pos) {
      const c = $("#tour-cap");
      if (c.classList.contains("on")) { c.classList.remove("on"); await wait(380); }
      c.className = pos === "top" ? "top" : "bottom";
      c.innerHTML = `<b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ""}`;
      void c.offsetWidth;
      c.classList.add("on");
    },
    captionOff() { $("#tour-cap").classList.remove("on"); },
    cursor(x, y) { $("#tour-cursor").style.transform = `translate(${x}px,${y}px)`; },
    cursorVis(on) { $("#tour-cursor").style.opacity = on ? "1" : "0"; },
    pulse(x, y) { const r = document.createElement("div"); r.className = "tour-ripple"; r.style.left = `${x}px`; r.style.top = `${y}px`; root.insertBefore(r, $("#tour-veil")); setTimeout(() => r.remove(), 800); },
  };
  return "installed";
})()
