# Migrating from Helicon

Ancilla is a fork of [Helicon](https://github.com/HarjjotSinghh/helicon). If you
used Helicon on this machine, the first start of Ancilla picks up where Helicon
left off. There is nothing to export or run by hand.

Helicon's files are never modified, moved or deleted. Ancilla reads them once and
works on its own copy from then on, so both apps can stay installed and you can
go back to Helicon at any time.

## What comes over automatically

**Threads.** Threads live in Muse itself, not in Helicon, so every thread you had
in Helicon appears in Ancilla the same way threads started from the `muse`
terminal do. Nothing is copied for this.

**Helicon's database.** On first start Ancilla copies `helicon.db` into its own
`ancilla.db`. That brings over:

- projects, their order, pins, hidden projects and each project's default account;
- thread titles, including ones you typed and ones generated locally (with
  `syncSessionNames: false` these exist only in this database);
- archived and settled threads;
- files attached to earlier prompts, so old messages still show them;
- the output of `!` commands, and the token history behind the usage page;
- the title-generation, sandbox and YOLO settings. If YOLO was on in Helicon it is
  on in Ancilla too; check Settings if you want a different posture.

**`runtime.json`.** If Helicon's data folder has a `runtime.json` (runtime, WSL
distro, Muse path, `wslEnv`, `syncSessionNames`) and Ancilla's does not, it is
copied unchanged on first start. A file that is not a JSON object is left behind,
since the server would refuse to start on it.

**Environment variables.** `HELICON_MUSE_RUNTIME` is still honoured when
`ANCILLA_MUSE_RUNTIME` is not set.

**Attachment files in your projects.** Helicon wrote non-image attachments to
`<project>/.helicon/attachments`; Ancilla writes new ones to
`<project>/.ancilla/attachments`. Old prompts keep pointing at `.helicon/...`, and
those files stay where they are, so Muse can still open them. If you ignored
`.helicon/` in git, ignore `.ancilla/` as well.

**The browser (web mode).** Opened in the same browser at the same address (the
default is `http://127.0.0.1:3127`), Ancilla starts from Helicon's saved settings
(theme, zoom and the rest) and composer drafts until it saves its own. Helicon's
copies are only read. For a server started with `--token`, a `helicon_token`
cookie the browser still holds for the same token is accepted as well; Ancilla
itself only ever sets `ancilla_token`.

## Where Ancilla looks

Ancilla uses the first `helicon.db` it finds:

| Ancilla data folder | Helicon data it starts from |
| --- | --- |
| Any folder passed as `--data-dir` | `helicon.db` in that same folder |
| Desktop app: `app.ancilla.desktop` | `app.helicon.desktop` beside it |
| Web server default: `~/.ancilla` | `~/.helicon` |

The desktop folders are `%APPDATA%` on Windows, `~/Library/Application Support`
on macOS, and `$XDG_DATA_HOME` or `~/.local/share` on Linux. For example, on
Windows Ancilla reads `%APPDATA%\app.helicon.desktop\helicon.db` and writes
`%APPDATA%\app.ancilla.desktop\ancilla.db`.

## What does not come over

- **Desktop window settings and drafts.** The desktop app keeps theme, zoom,
  sidebar grouping and other interface settings, and unsent composer drafts, in its
  webview's storage, which belongs to each app separately. Set them once in
  Ancilla's Settings. (In web mode they do carry over; see above.)
- **Later changes.** The import is a one-time copy. Pins, titles or projects
  changed in Helicon afterwards do not reach Ancilla, and the other way round.
- **Helicon's port and logs.** The desktop app picks its own port and keeps its
  own log.

## Running both

The apps have separate data folders, ports and settings, so they can be open at
the same time. They share threads through Muse, so avoid working in the same
thread from both at once.

The first start is safe while Helicon is running: the copy is a consistent
SQLite snapshot taken through a read-only connection, and includes anything
Helicon has already committed. If Helicon is in the middle of a write, Ancilla
waits up to three seconds for it.

## Checking the import

The server writes one line to its log when it imports, naming the file it read:

```
[ancilla] 2026-09-26T12:00:00.000Z imported Helicon's data from C:\Users\you\AppData\Roaming\app.helicon.desktop\helicon.db
```

If Helicon's database cannot be read (damaged, or locked for longer than three
seconds), the log says `could not import Helicon's data ..., starting fresh` and
Ancilla starts with an empty database instead of failing. For the desktop app
the log is `server.log` in its log folder: `%LOCALAPPDATA%\app.ancilla.desktop\logs`
on Windows, `~/Library/Logs/app.ancilla.desktop` on macOS. The web server logs to
its stderr.

## Importing again

The import runs only when `ancilla.db` does not exist yet. To import again:

1. Quit Ancilla (close the desktop app, or stop `ancilla-server`).
2. In Ancilla's data folder, move `ancilla.db` somewhere else, or delete it.
   Do not touch `helicon.db`. Anything changed in Ancilla since the last import,
   such as new pins or titles, goes with it.
3. To bring `runtime.json` over again as well, move Ancilla's copy aside too.
4. Start Ancilla.
