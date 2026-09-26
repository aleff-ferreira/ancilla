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

The [Agents panel](agent-activity.md) labels its contents **Last known activity** while the feed is unavailable, and
stops animating agents that were working when the feed went quiet.

### When it ends

- A recorded completion of the turn ends recovery and removes the notice, even if Muse still reports the view as
  unavailable.
- Fresh progress for the current turn arriving over the live feed ends recovery and clears the unavailable marker.
- Session metadata and replayed revisions of old items do not count as the feed recovering.

## Local thread titles

`syncSessionNames` controls whether Ancilla shares thread titles with Muse. It defaults to `true`: a title you type,
or one Ancilla generates, is sent to Muse with `session/rename`, and names chosen in Muse or another client show up in
Ancilla.

Set it to `false` in [`runtime.json`](#runtime-configuration) if you hit the workflow failure above. Ancilla then:

- never sends `session/rename`;
- keeps generated and typed titles in its own database;
- takes a name from Muse only for a thread that has no title of its own yet.

Title generation and agent delegation keep working. Muse's session logs are not rewritten, so an older session that
already recorded a rename can still fail its workflows; start a fresh thread for that work. Saved work and transcripts
stay available.

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
| `distro` | the WSL distribution Muse runs in (default `Ubuntu`) |
| `musePath` | an explicit `muse` binary path, as the chosen runtime sees it |
| `syncSessionNames` | `false` keeps thread titles local; see [above](#local-thread-titles) |
| `wslEnv` | Windows only: environment variables for Muse inside WSL, as `{"NAME": "value"}` |

Command-line flags (`--runtime`, `--distro`, `--muse`) override the file, and `ANCILLA_MUSE_RUNTIME` overrides its
`runtime`. For example, for Muse inside WSL:

```json
{
  "runtime": "wsl",
  "distro": "Ubuntu",
  "musePath": "/home/USER/.local/bin/muse",
  "syncSessionNames": false,
  "wslEnv": {
    "BASH_ENV": "/home/USER/.config/muse/runtime-env.sh",
    "TBH_CREDENTIAL_BACKEND": "file"
  }
}
```

`wslEnv` names must be uppercase environment variable names and values must be strings. Each one is set for the
server unless it is already set, and forwarded into WSL through `WSLENV`, including for in-app `muse login`. The example
uses `BASH_ENV` to point Muse's non-interactive tool shells at a file that selects the intended Node installation; that
file must already exist. Never put API keys or other secrets in `runtime.json`.

The file is read once at startup, so restart Ancilla after changing it. A file that is not valid JSON, or an invalid
`wslEnv` entry, stops the server from starting; the reason is written to the server log.

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
   the transcript and the Agents panel keep filling in.
3. The server's `/api/health` shows how long each session's feed has been quiet (`diagnostics.sessions`). For the web
   server that is `http://127.0.0.1:3127/api/health`.
4. When the run finishes, the notice disappears and the turn shows its real outcome. The thread holds one copy of your
   prompt, and Muse's own session history shows no extra turn.

These are smoke tests, not a guarantee against provider outages or arbitrarily long runs.

## Limits

Recovery does not modify Muse, hide real errors, retry execution, or repair event records that are already damaged. It
can only show what Muse makes readable: if Muse has saved no progress yet, there is nothing to show until it does.
