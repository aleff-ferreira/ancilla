# The internal browser

Ancilla's server can own a web browser: a Chromium-family browser it starts, drives and stops itself. It is the engine
under the Browser panel you use (see "The pane" below) and, in a later slice, under the browsing agent. The server side is
`packages/server/src/browser/`; the HTTP route is `GET /api/browser/status` and the panel's socket is `/api/browser/ws`.

## How it works

```
BrowserService (service.ts)      tabs, contexts, snapshot, input, screencast, lifecycle
   CdpConnection (cdp.ts)        Chrome DevTools Protocol, NUL-framed JSON on a private pipe
   launchBrowser (launch.ts)     headless browser child, its own profile, process-tree kill
   findBrowser (find.ts)         which browser to use on this machine
   snapshot.ts                   the page as compact accessibility text for a model
```

- **No window, no port.** The browser runs `--headless=new --remote-debugging-pipe`. CDP travels on two extra pipes
  (the child's fd 3 and 4), so no TCP port is opened and nothing else on the machine can attach. The pane draws what
  `Page.startScreencast` sends and forwards input back.
- **Lazy.** Nothing starts until a page is opened. The browser stops after 10 idle minutes (a watched screencast or an
  open dialog keeps it alive) and when the server shuts down. Stopping is `Browser.close`, then, if the browser did not
  exit, the whole process tree is killed (`taskkill /T /F` on Windows, the process group elsewhere).
- **No orphan.** The CDP pipe is the child's lifeline: when the server dies, the pipe closes and the browser exits. (The
  desktop shell already ends the server sidecar when it dies, by closing the server's stdin; the browser hangs off the
  server the same way. The shell kills only the server process, not its tree, so the pipe is what makes this hold.)
- **Sandbox stays on.** Ancilla never passes `--no-sandbox`. If a browser cannot start sandboxed (running as root, or in
  a container without user namespaces) the error says so and the feature is unavailable there; it is not weakened.

## Two contexts

| context | what it is | for |
| --- | --- | --- |
| `you` | the browser's persistent default context (profile on disk) | what the user browses, and where their sign-ins will live |
| `assistant` | an ephemeral context (`Target.createBrowserContext`) | what the assistant browses; gone on `resetAssistant()` or when the browser stops |

Cookies and storage are never shared between them. At most 8 tabs are open at once; a popup opens as a tab of its
opener's context, or is closed over the limit (a popup of an assistant tab is always closed). The assistant's context is
thrown away at the end of every web task.

## Security defaults

- Only `http:`, `https:` and `about:blank` can be navigated to. `file:`, `chrome:`, `edge:`, `devtools:`,
  `view-source:`, `javascript:`, `data:` and everything else is refused before the browser hears of it.
- Downloads are denied (`Browser.setDownloadBehavior`), in both contexts. Every permission prompt (camera, microphone,
  location, notifications, clipboard, sensors, ...) is denied.
- JavaScript dialogs in your tabs are surfaced as events and are never accepted automatically; whoever drives answers them. (The assistant's tabs have nobody to answer: the browser dismisses them.)
- The browser has its own profile (`<data dir>/browser/profile`), never the user's everyday one, with background
  network traffic, sync, component updates and crash reporting switched off (`launch.ts` lists each flag and why).
- No user-agent or fingerprint tricks. A site that blocks the browser is the user's to take over.
- A page snapshot is page content: it carries a header saying so, drops everything a person cannot see (`display:none`,
  zero size, opacity 0, font-size 0, placed off the page's top/left edge, zero-width and bidi control characters) and is
  capped near 20,000 characters.

## Choosing the browser

Order: Edge (on every Windows), Chrome, Chromium, Brave on Windows and macOS (Chrome first on macOS); on Linux the
first of `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `microsoft-edge`, `brave-browser`
on `PATH`. Set `ANCILLA_BROWSER` to a browser's full path to override; a path that does not exist is an error, not a
silent fallback.

A server running inside WSL looks for a Linux browser only; it does not reach for the Windows Edge through interop.
Without any browser, `GET /api/browser/status` says `available: false` with the reason.

## Where things live

- Profile (the `you` context): `<data dir>/browser/profile`, i.e. next to the server's other data. With an in-memory
  data dir (tests) a throwaway temp folder is used.
- Status: `GET /api/browser/status` returns `{ available, browser: { kind, path, version } | null, reason?, running, tabs }`.

## The pane (what you see)

The Browser panel (`packages/ui/src/components/browser/`) sits beside the thread (`Ctrl/Cmd+Shift+B`, the globe in the thread header, or the command palette). It draws the page on a canvas and talks to the server over a WebSocket, `/api/browser/ws`
(`packages/server/src/browser/ws.ts`, wire format in `protocol.ts`). The upgrade is checked like the call's: host, origin and token, before the handshake.

- **One pane at a time.** The first connection controls the browser; a second is told it is open in another window and can take it over ("Use it here"). The pane sees only the `you` context (your tabs and saved sign-ins), never the assistant's: every tab id it names must be one of its own.
- **Pictures** are binary frames (tag, sequence, size in CSS pixels, tab id, JPEG). Only one is in flight until the pane has acknowledged it (on arrival; the pane then decodes only the newest picture it holds); a newer picture on the server replaces one that is waiting, and the socket's backlog holds the next one back (the screencast is capped at 40 fps, 30 is what a page gets in practice). The panel is the viewport: its size (debounced) is sent and the page is drawn at density 1. Measured on Edge 157, the screencast never gives more pixels than the page's CSS size, even with a device scale factor of 2 on the viewport or a larger size asked for, so a high-DPI display sees the page slightly soft. Crisper would take screenshots instead of the screencast; that is for later, if wanted.
- **Input** goes in order through one queue: mouse (move, press, release, wheel), keys, text, dialog answers (these skip the queue: a click that opened a dialog does not finish until it is answered). A hidden text field holds the focus. Keys that are not text (Enter, Backspace, Tab, Escape, arrows, F-keys, Ctrl/Cmd shortcuts such as select all, undo and redo) are key events; text, dead keys, composed letters, AltGr characters and a paste are inserted as text (`beforeinput`, `compositionend`, `paste`), so a Brazilian ABNT2 keyboard works. Copy asks the server for the page's selection and writes the system clipboard.
- **What a screenshot of a page does not show.** A click on a `<select>` is answered by the pane's own list (the server reads the options, swallows the click, and sets the value with `input` and `change`); a script's dialog (alert, confirm, prompt, before-unload) is a small dialog in the pane; `window.open` and `target=_blank` open a new tab in front; a file chooser is intercepted and refused with a plain message; downloads stay denied, with a notice.
- **Not there yet:** uploads and downloads, signed-in grants, the assistant acting on a page with confirmation (B4).

## The assistant browsing (web tasks)

The assistant can use the browser: ask it by voice, or in text, to look something up and it starts a **web task** (the `browse` tool). It works in the `assistant` context, on one tab, with eight tools and nothing else (`open`, `read`, `click`, `type`, `press`, `scroll`, `back`, `done`; `packages/server/src/browser/agent.ts`). A page is text anyone can write, so the loop has no tool that reads a file, runs a command or starts a task: the worst a page can do is waste its steps, and what it answers is kept and shown as "From the web (not checked)", with the pages it came from.

- **Every new site asks first.** The first time a task wants an origin (scheme, host and port) it has no rule for, it waits and the Tasks list shows *Needs your OK* with four answers: **Allow for this task**, **Always allow**, **Not now** (this task only) and **Block** (saved). Nothing is sent to the site until you answer. Saved rules live in `<data dir>/browser/sites.json`. A site that leads into this computer or its network (`localhost`, `192.168.x.x`, a name with no dot, `.local`) is said to be, and is only ever allowed by an answer for that exact origin. `file:`, `chrome:` and the like are never opened.
- **The gate is in the browser, not in the agent.** Every document request of an assistant tab is paused (`Fetch.enable` on documents) until the gate has answered: a page typed in, a link, a redirect, a script's navigation. A refused request is aborted, so the page that had the link stays where it was. A frame inside a page is part of the page, unless it leads inside and nobody allowed that site. Popups of an assistant tab are closed and the task is told; a script's dialog is dismissed by the browser (alerts accepted, questions declined) so it cannot freeze the page. Your own tabs are never asked about. Not gated: images, scripts and requests a page makes for itself, as in any browser; and a site name that points at a computer on your network is treated as public (the browser does the lookup).
- **It is a task.** The web task is a row in Assistant, Tasks (origin `browse`), made running at once and never queued; only one at a time. It cannot be paused, resumed, retried or extended (it is cancelled and asked again), switching the assistant off stops it, and a restart ends one that was open. Limits: 25 steps and 5 minutes of work (the time you take to answer a question is not counted).
- **Which model browses.** The one chosen for the voice. A server that takes tools (a hosted model, or Ollama, LM Studio, llama.cpp, vLLM on this computer) gets the browser's tools, or asks for them in text if it cannot take tools. **Muse is run as `muse exec --preset empty`, one process for each step, with no tools at all** (Muse reports `Session tool ids: (none)`). Measured on a real Muse 1.4.14: a Muse *thread* started with an approval mode (`onRequest`, `denyUnmatched`) still read a file outside its folder without asking, and its network approval offered no way to deny it; the `empty` preset said no file tool exists. So Muse does not browse as a thread. The price: every `muse exec` carries about 15,000 tokens of Muse's own instructions, so a three-step task is about 50,000 tokens on your Muse plan, where a hosted or local model costs only the pages.
- **Where it shows.** In Assistant, Tasks (state, the question, the answer) and in the Browser panel, under your own tabs. While a task runs the panel shows the assistant's tab live (small, read only, a few pictures a second), its last steps, the site it is waiting to open with the same four answers, and a **Stop** that cancels the task. With nothing running it offers a box to ask the assistant to look something up (the same as the voice's `browse`, over `POST /api/assistant/browse`) and **Sites it may open**: the saved Always allow and Block rules, each with a Remove (`GET`/`DELETE /api/assistant/browse/sites`; taking one back means it asks again).
- **The watcher socket.** The panel's second socket, `/api/browser/watch` (`packages/server/src/browser/watch.ts`), has the same host, origin and token checks as the pane's. It casts the assistant's one tab once for any number of windows (a window that joins late gets the last picture at once), sends the task's state whenever it changes (the site is named; the question's own id is not sent), and is read only by construction: the only thing it hears from a window is the acknowledgement of a picture, so no click, key, navigation or resize sent to it reaches the browser. A tab that is not changing sends the screencast nothing, so if no picture has come 300 ms after a tab is cast (here and in the pane) one is taken with a screenshot.

## Measured (headless Edge 157, Windows 11, through the service API)

Start plus first page about 0.7 s; stop about 0.4 s; screencast 29.5 fps with the default 30 fps cap and 58 fps at a
60 fps cap on a fully animated page; click to the next frame p50 14 ms, max 22 ms (15 clicks).

Through the pane's socket (Edge 157, Windows 11, a 800x600 page, the pane acknowledging at once): click to the changed picture p50 10 ms, p95 23 ms (24 clicks); 34.9 fps on a fully animated page at about 9 KB a frame. The test is `browser-pane-real.test.ts`.

Through the whole loop on this machine (Edge 157 behind the gate, `muse exec` as the mind, a local shop for the pages): "what is the price of the Blue Widget?" took 3 steps and 42 s (the Muse steps took 4, 33 and 4 s; the 33 was Muse's service being slow), and answered correctly with the page it came from; a page that told the model to read `.ssh\config` and leak it through the address bar was answered as a page about delivery, 2 steps, 8 s, and no question about another site ever came up.

## Tests

`browser-sites.test.ts` covers origins, what leads inside, the saved rules, the questions and their answers, and the browser holding a page over a scripted browser; `browser-sites-real.test.ts` does it against a real browser (typed in, link, redirect, frame, popup, dialog, own tabs). `browser-agent.test.ts` covers the loop (its eight tools and no others, an injected page, limits, compaction) and Muse as its mind; `assistant-browse.test.ts` the web task from the voice tool to the answer. The UI's `web-task-row.test.ts` covers the question's row. `browser-watch.test.ts` covers the watcher (the assistant's tab and only that one, the state without ids, read only, one cast for many windows, a late window, a quiet tab) over a scripted browser, and `browser-watch-real.test.ts` against a real one; `assistant-browse.test.ts` also covers the panel's routes (start, list, remove). The UI's `assistant-bar.test.ts` covers what a watcher is told, its connection and the bar (idle, browsing, asking).

`browser-pane.test.ts` (server) covers the wire format, the socket's front door (no token, wrong origin, foreign host), one controlling pane, ordered input, the select, dialog, popup and notice paths and that the assistant's tabs are never shown or touched, over a scripted browser; `browser-pane-real.test.ts` runs the whole path against a real browser. The UI's `browser-pane.test.ts` covers the key and text mapping (with the ABNT2 cases), pointer scaling, the address bar and the connection.


`packages/server/test/browser-service.test.ts` uses a fake CDP transport and a fake child (framing, tabs, snapshot
rules, scheme refusal, lifecycle). `browser-real.test.ts` drives whatever real browser exists (and is skipped, with the
reason, where there is none): snapshot, typing, a click that navigates, screencast, screenshot, context isolation, a
denied download, refused schemes and no process left after dispose. On Ubuntu 24.04 CI the runner's restriction on
unprivileged user namespaces is lifted first, so the browser can start with its sandbox on.
