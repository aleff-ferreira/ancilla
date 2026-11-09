# The internal browser (engine)

Ancilla's server can own a web browser: a Chromium-family browser it starts, drives and stops itself. It is the engine
under the browser pane (a later slice) and under the browsing agent (a slice after that). This page describes what
exists today: `packages/server/src/browser/`, with no UI and no agent on top yet. The only HTTP route is
`GET /api/browser/status`.

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
opener's context, or is closed over the limit.

## Security defaults

- Only `http:`, `https:` and `about:blank` can be navigated to. `file:`, `chrome:`, `edge:`, `devtools:`,
  `view-source:`, `javascript:`, `data:` and everything else is refused before the browser hears of it.
- Downloads are denied (`Browser.setDownloadBehavior`), in both contexts. Every permission prompt (camera, microphone,
  location, notifications, clipboard, sensors, ...) is denied.
- JavaScript dialogs are surfaced as events and are never accepted automatically; whoever drives answers them.
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

## Measured (headless Edge 157, Windows 11, through the service API)

Start plus first page about 0.7 s; stop about 0.4 s; screencast 29.5 fps with the default 30 fps cap and 58 fps at a
60 fps cap on a fully animated page; click to the next frame p50 14 ms, max 22 ms (15 clicks).

## Tests

`packages/server/test/browser-service.test.ts` uses a fake CDP transport and a fake child (framing, tabs, snapshot
rules, scheme refusal, lifecycle). `browser-real.test.ts` drives whatever real browser exists (and is skipped, with the
reason, where there is none): snapshot, typing, a click that navigates, screencast, screenshot, context isolation, a
denied download, refused schemes and no process left after dispose. On Ubuntu 24.04 CI the runner's restriction on
unprivileged user namespaces is lifted first, so the browser can start with its sandbox on.
