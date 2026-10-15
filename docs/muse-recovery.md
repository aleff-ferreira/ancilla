# Muse session recovery

Muse's live feed of a running turn can stall while the turn itself carries on. Helicon, which Ancilla is forked from,
reloaded such a thread twice by resuming the session, then said the thread had stopped receiving updates and left the
rest to a manual reload; it could also show a failure for a turn that was still working. Ancilla keeps the thread
readable and moving for as long as the run lasts, by reading the progress Muse has already saved.

Recovery only ever reads. It never resends a prompt, never issues `session/resume` into a running turn, and never
restarts delegation. Native subagents, automatic workflow selection, the selected model, your permissions and the
number of agents a run may use are all left to Muse; Ancilla adds no cap of its own.

It was developed and tested against Muse Code 1.4.0 on Windows, with Muse running in Ubuntu under WSL2.

## What goes wrong without it

1. **A stalled live feed.** Muse can report that a session's live view is unavailable (`projectionUnavailable`) while
   the turn keeps running. No further updates arrive, so the thread stops moving even though saved progress, and later
   the final result, can still be read.
2. **A synthetic failure for a running turn.** During an active run, `session/read` can report the active turn while
   `view/page` returns a terminal `failed` record with reason `incomplete` for that same turn. A later read reports the
   real completion. Shown as-is, that record looks like the turn failed.
3. **Renames that break workflows.** Sending MSP `session/rename` before a native workflow runs can make the workflow
   fail with:
   `workflow cancel registration failed before admission: event log failed: record decode failed: payload decode failed: missing field kind`.
   The same workflow without the rename completes. This is a compatibility defect in Muse; Ancilla works around it with
   [local thread titles](#local-thread-titles) rather than changing Muse.

## How recovery works

When a loaded thread's feed goes quiet mid-turn, or Muse reports its view as unavailable, Ancilla reloads the thread in
read-only mode: `session/read` plus `view/page`, the same calls used to show history. It does not reattach the turn,
which may still be executing or waiting on a question.

The result is merged into what the thread already shows, not swapped in:

- Visible history and pending questions or approvals stay when the new snapshot does not include them.
- A response that started before newer live activity arrived cannot overwrite that newer activity.
- Item revisions from the read are folded in, so the newest revision of each item wins.
- The synthetic `failed`/`incomplete` record is dropped only for the turn the session still reports as active. Every
  other failure, including a real failure of that turn later, stays visible.

### Cadence

| Situation | Check interval |
| --- | --- |
| Saved history is readable, thread is selected | every 15 seconds |
| Saved history is readable, thread is loaded but not selected | every 120 seconds |
| A read failed, or history is unreadable (first attempts) | every 30 seconds |
| After the first attempts are spent | every 120 seconds |

A failed read keeps the transcript that is already on screen and leaves the fast path. A successful read with usable
history for the current turn can put the selected thread back on the 15-second cadence.

### What you see

The thread shows **Syncing saved progress**, explaining that Muse's live feed is unavailable and that Ancilla checks
saved progress without resending the task. **Last checked** is the latest successful check; **Progress updated** is
when a check last found something new, so a check that finds nothing new moves only **Last checked**. **Reload
results** reads immediately.

The [Crew card](agent-activity.md) reads **Last known** while the feed is unavailable, freezes every clock at the
last moment Ancilla heard from Muse, and stops animating agents that were working when the feed went quiet.

### When it ends

- A recorded completion of the turn ends recovery and removes the notice, even if Muse still reports the view as
  unavailable.
- Fresh progress for the current turn arriving over the live feed ends recovery and clears the unavailable marker.
- Session metadata and replayed revisions of old items do not count as the feed recovering.

## Local thread titles

`syncSessionNames` controls whether Ancilla shares thread titles with Muse. It defaults to `false`, so out of the box
Ancilla:

- never sends `session/rename`;
- keeps generated and typed titles in its own database;
- takes a name from Muse only for a thread that has no title of its own yet.

Set it to `true` in [`runtime.json`](#runtime-configuration) to share titles: a title you type, or one Ancilla
generates, is then sent to Muse with `session/rename`, and names chosen in Muse or another client show up in Ancilla.
Even then, once a Muse host reports the `missing field kind` failure above, from a rename or from a workflow in one of
its threads, Ancilla sends that host no more titles and writes one line to the server log saying so.

Title generation and agent delegation keep working either way. Muse's session logs are not rewritten, so an older
session that already recorded a rename can still fail its workflows; start a fresh thread for that work. Saved work and
transcripts stay available.

## Runtime configuration

The server reads an optional `runtime.json` from its data directory when it starts:

| Where Ancilla runs | Data directory |
| --- | --- |
| Desktop app, Windows | `%APPDATA%\app.ancilla.desktop` |
| Desktop app, macOS | `~/Library/Application Support/app.ancilla.desktop` |
| Desktop app, Linux | `~/.local/share/app.ancilla.desktop` |
| Standalone server (`packages/server`) | `~/.ancilla`, or the `--data-dir` you pass |

| Key | Meaning |
| --- | --- |
| `runtime` | Windows only: `native`, `wsl` or `auto` (the default: native Muse once it is installed) |
| `distro` | the WSL distribution Muse runs in; without it, `Ubuntu` when Muse is installed there, else WSL's default distribution |
| `musePath` | an explicit `muse` binary path, as the chosen runtime sees it; a Linux path is checked in that distribution |
| `syncSessionNames` | `true` shares thread titles with Muse; see [above](#local-thread-titles) |
| `wslEnv` | Windows only: environment variables for Muse inside WSL, as `{"NAME": "value"}` |
| `allowHosts` | host names the server answers besides `127.0.0.1`, `localhost` and `::1`, as `["ancilla.example"]`; see [Reaching the server by another name](#reaching-the-server-by-another-name) |

Command-line flags (`--runtime`, `--distro`, `--muse`) override the file, and `ANCILLA_MUSE_RUNTIME` overrides its
`runtime`. `ANCILLA_RESEARCH_STARTUP_MS` sets how long a research run waits for Muse to open a session (whole
milliseconds, 1000 or more; the default is two minutes, three on Windows with Muse in WSL or not yet detected). For
example, for Muse inside WSL:

```json
{
  "runtime": "wsl",
  "distro": "Ubuntu",
  "musePath": "/home/USER/.local/bin/muse",
  "wslEnv": {
    "BASH_ENV": "/home/USER/.config/muse/runtime-env.sh",
    "TBH_CREDENTIAL_BACKEND": "file"
  }
}
```

The distribution named here, or found as described above, is the one Ancilla starts Muse in, runs CLI calls through
and checks `\\wsl.localhost\` project folders against, so a folder from another distribution is refused with a message
naming both.

`wslEnv` names are environment variable names (letters, digits and underscores, in any case); `PATH` and `WSLENV`
are refused because WSL sets them itself. The values go only to processes Ancilla starts through `wsl.exe`: Muse
hosts, the environment probe, CLI calls, in-app `muse login` and `git clone` into a Linux folder. They are forwarded
through `WSLENV`, replace a Windows variable of the same name for those processes, and are never set on the server
itself, so the file opener, native Muse and the updater see none of them. The example uses `BASH_ENV` to point Muse's
non-interactive tool shells at a file that selects the intended Node installation; that file must already exist.
Never put API keys or other secrets in `runtime.json`.

The file is read once at startup, so restart Ancilla after changing it. It may be UTF-8 with or without a byte order
mark, or UTF-16, which is what Windows PowerShell writes. A file that is not a JSON object is ignored as a whole, and a
field of the wrong type or an unusable `wslEnv` or `allowHosts` entry is ignored on its own; each is one line in the
server log, and the server starts either way.

### Reaching the server by another name

The server answers a request only when its `Host` header names `127.0.0.1`, `localhost` or `::1` (any port), so a web
page that was pointed at your own machine under some other name cannot use it. A proxy, tunnel or alias that forwards
the public name gets `403` with `"kind": "host"` and a message naming the host it refused. Fix that by listing the name:
`--allow-host ancilla.example` on the command line (repeatable), or `"allowHosts": ["ancilla.example"]` in
`runtime.json`, which is how desktop users add one. The hosts of the `--allow-origin` URLs are allowed as well. The
refusal is also logged to the server's stderr (the desktop app's `server.log`), once for each different host and for at
most five of them. The log line and the message offer an `--allow-host` command only for a real name or address, never
for a header that is not one. A client that sends the server's
token as `Authorization: Bearer <token>` is not asked for a listed host; the event stream and images cannot send that
header, so a browser behind a proxy still needs the name listed. A server bound to one specific loopback address
(`--host 127.0.0.2`) trusts that address as a `Host` too, besides the three names above.

The count of refused requests is kept as well, since the log stops after five different hosts: `/api/health` shows
`diagnostics.hostRefusals` (every request refused for its `Host`) and `diagnostics.lastRefusedHost` (the most recent
refused name that could be listed, lower case and without the port, or `null`), so a proxy that was set up wrongly can
still be found once the log has gone quiet.

## Verifying it

Automated coverage (`npm test`) includes: a missed completion, projection health, active `incomplete` snapshots,
concurrent newer turns, unknown `notLoaded` snapshots, pending questions, history preservation, recovery backoff, the
selected-thread and background cadences, failed reads, unchanged saved revisions, genuine live progress, completion
while unavailable health is still reported, and local title retention. The tests live in
`packages/server/test/server.test.ts` and `packages/ui/test/{controller,fold,stalled-notice}.test.ts`.

With real Muse, the fixes were smoke-tested with native CLI helpers, a CLI workflow, a three-child workflow and a
five-child workflow (four parallel readers and a dependent synthesis step) started from Ancilla. To check a build
yourself:

1. Start a long workflow from a thread and keep that thread selected.
2. If the feed stalls, **Syncing saved progress** appears and **Last checked** advances about every 15 seconds, while
   the transcript and the Crew card keep filling in.
3. The server's `/api/health` shows how long each session's feed has been quiet (`diagnostics.sessions`). For the web
   server on its default port that is `http://127.0.0.1:3127/api/health`; if you started it with `--token`, the
   endpoint needs that token like the rest of the API (sign in on that address first, or send
   `Authorization: Bearer <token>`); address it as `127.0.0.1` or `localhost`, since another name is refused unless it
   was listed with `--allow-host`. The desktop app's server picks its own port and keeps it in the `server-port`
   file in the app's [data directory](#runtime-configuration).
4. When the run finishes, the notice disappears and the turn shows its real outcome. The thread holds one copy of your
   prompt, and Muse's own session history shows no extra turn.

These are smoke tests, not a guarantee against provider outages or arbitrarily long runs.

## The event stream

The event stream itself is bounded. A client that stops reading `/api/events` (a suspended webview, a proxy that
stopped forwarding) is disconnected once more than 4 MiB of frames are still waiting behind the one being sent at the
end of the turn of the event loop, or once it has completed no write for 90 seconds. A slow client stays as long as
it finishes a batch of writes within that time. Node sends what is queued behind a write in flight as one batch and
reports it done only when all of it has gone, and nothing readable shows bytes moving inside a batch, so a client taking
the batch more slowly than its size over 90 seconds (about 46 KB/s for a backlog at the 4 MiB limit) is cut even
though it is still reading. The browser reconnects, the server says hello, and the app rereads the lists and the open
thread, which is the whole recovery. Nothing is replayed and no prompt is ever sent again. The counters are under `diagnostics.sse` in
`/api/health`: `clients`, `overflowDisconnects`, `stallDisconnects`, `backlogHighWaterBytes`, `serializationFailures`
and `researchFramesSkipped`, next to the two limits (`maxBacklogBytes`, `stallMs`). A research run's own sessions are
not sent to the browser at all; their progress arrives as `research-run`.

## Limits

Recovery does not modify Muse, hide real errors, retry execution, or repair event records that are already damaged. It
can only show what Muse makes readable: if Muse has saved no progress yet, there is nothing to show until it does.
