# Making the README's pictures and the tour video

Everything in `docs/assets` that shows the interface is rendered from the browser demo, which is the real interface on
fictional sample data (see [the demo](../../README.md#build-from-source)). These scripts redo it when the interface
changes, so the screenshots and the tour do not drift from what ships.

| File | What it makes |
| --- | --- |
| `readme-shots.mjs` | The screenshots: `home`, `thread`, `agents`, `usage`, `research`, `research-report` and the four assistant pages. 1440 x 950, dark theme. |
| `social-card.mjs` | The 1280 x 640 social card (the picture GitHub shows when the link is shared), drawn in the brand's type and colours around one of the screenshots. |
| `tour.mjs`, `tour-lib.mjs`, `tour-overlay.js` | The tour video, one clip at a time: a cursor that moves to real elements and clicks them, captions, fades, a title and a closing card. |
| `encode.py` | Turns recorded frames into clips, joins the clips into the film, cuts the GIFs and finishes the social card. |
| `cdp.mjs` | A small browser driver (Chrome DevTools Protocol) the others share. |

## What you need

- Node 22 and a built checkout (`npm ci`).
- A headless Chromium: `CHROME_BIN` names a `chrome-headless-shell`, or the newest one in Playwright's cache is used
  (`npx playwright install chromium-headless-shell`).
- For the video and the GIFs, `ffmpeg` with `libx264` (`FFMPEG` names it, or it is found on `PATH`). For the social card,
  Python 3 with Pillow.

## Doing it

Start the demo and leave it running (it serves on 5299; `DEMO_PORT` names another):

```bash
npm run demo --workspace @ancilla/web
```

The screenshots:

```bash
node scripts/media/readme-shots.mjs /tmp/shots            # all of them, or name one: ... /tmp/shots home
cp /tmp/shots/*.png docs/assets/
```

The tour. The assistant is only its opening; the rest is the harness: a Deep Research run from the composer, its report,
every agent in view with a request waiting, the plan card, diffs and files, and the usage meter. Each clip is recorded in
real time from a screencast of the page, so do not run anything heavy meanwhile:

```bash
CLIPS="intro assistant ask report crew plan diffs usage outro"
node scripts/media/tour.mjs $CLIPS
python3 scripts/media/encode.py clip $CLIPS
python3 scripts/media/encode.py final docs/assets/ancilla-tour.mp4 26      # the second argument is the quality (lower is better)
```

The GIFs the README plays (GitHub never plays a video that lives in the repository, so the README shows GIFs and links
the MP4 as a download). A GIF is cut from a video by start and length in seconds: look at a clip first with
`encode.py sheet ask` (twelve thumbnails) or `encode.py strip ask 5 1.1 4 3`, then:

```bash
python3 scripts/media/encode.py gif docs/assets/ancilla-tour.mp4 docs/assets/ancilla-tour.gif 22.6 8.4 960 12 128   # the research run
python3 scripts/media/encode.py gif $TOUR_DIR/plan.mp4 docs/assets/run-card.gif 2.4 7 840 10 96                      # a turn finishing
```

The social card (GitHub has no way to set it from a script: upload it in the repository's Settings, under Social preview):

```bash
node scripts/media/social-card.mjs /tmp/card-2x.png docs/assets/agents.png
python3 scripts/media/encode.py card /tmp/card-2x.png docs/assets/social-preview.png
```

## How the tour is built

The page is 1920 x 1080 with the app's own zoom at 1.5, so it lays out like a 1280 x 720 window and draws sharp at 1080p.
A clip fades up from the brand's forest colour and back into it, so clips join with a plain copy. The cursor's moves and
clicks are real mouse events at the element's position, so hover states and menus behave as for a person; captions, cards
and the cursor are drawn by `tour-overlay.js` over the page, outside the app's zoom. A wait that only shows a spinner is
played faster with `S.speed(4)` in the script and put back with `S.speed(1)`. When the interface changes, a clip that
cannot find its target stops with the selector it was looking for: fix the selector in `tour.mjs`.

Frames are timed by a monotonic clock. The screencast's own stamps are on the wall clock, which WSL2 sometimes sets back by
about two seconds in the middle of a recording; `encode.py` carries such a step on instead of reading it as a stall, so a
recording made before this fix still comes out at its real length.

The demo is a development page only, and nothing here ships in the app.
