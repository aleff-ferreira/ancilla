# Local Muse 1.4.0 compatibility repair

This patch preserves native Muse subagents, automatic workflow selection, the
selected model, and the user's existing permissions. It introduces no agent-count
cap. It was tested against Helicon 0.17.1 and Muse 1.4.0 on Windows with Ubuntu WSL.

## Reproduced failures

1. Sending MSP `session/rename` before a native workflow reproduced:
   `workflow cancel registration failed before admission: event log failed: record decode failed: payload decode failed: missing field kind`.
   The same SDK workflow without that command completed. A patched Helicon workflow
   with local titles also completed. This is an observed compatibility defect; the
   internal Muse decoder has not been changed.
2. During an active run, `session/read` reported the active turn while `view/page`
   produced a synthetic failed terminal with reason `incomplete`. A subsequent read
   reported the real successful completion. The adapter now omits only that
   synthetic failure for the known active turn. Other failures remain visible.
3. Lost live updates left the UI stale. Recovery now reads saved state without
   sending `session/resume` into a running turn or resending its prompt. It preserves
   visible history and pending questions when their replacement snapshot is missing,
   protects newer activity from an older response, and keeps readable saved progress
   moving in the selected thread while the live feed is unavailable.

## Saved-progress recovery

When an active thread has readable saved history but its live feed is unavailable,
Helicon checks that history on a 15-second interval in the selected thread. Loaded
active threads outside the selected chat use a 120-second interval. These checks
read the existing task's results; they do not resend its prompt, issue
`session/resume` into the active turn, or restart native delegation.

The active thread shows **Syncing saved progress**, explaining that Muse's live
feed is unavailable and Helicon checks saved progress automatically. **Last
checked** records the latest successful history check; **Progress updated** records
when Helicon last found new saved progress. Repeated snapshots update the check
time without advancing the progress time. **Reload results** still requests an
immediate read. The agent panel labels its information **Last known activity** and
does not animate saved working states as if they were live updates.

Failed reads preserve the usable transcript and leave the fast polling path.
Recovery uses a bounded initial retry window with a 30-second retry interval, then
continues at 120-second intervals after the initial attempts are spent. Unreadable
history uses the same backoff instead of repeated 15-second requests. Background
fallback checks remain on the longer interval. A successful read with usable
current-turn history can return the selected thread to the normal saved-history
cadence.

A recorded turn completion clears the fallback state and removes its notice even
if the response still reports unavailable live-feed health. Fresh progress for the
current turn arriving through the live feed clears stale recovery state; genuine
live progress also clears the server's stale health marker. Session metadata and
replayed item revisions do not establish that the live feed has recovered.

The upstream Muse live feed may remain unavailable while saved progress and final
results are readable. This fallback improves result visibility without changing
Muse's execution, native subagents, automatic workflow selection, model choice,
permissions, or agent count.

## Runtime configuration

The server reads `runtime.json` inside its data directory. Command-line runtime,
distro and executable choices override the file; `HELICON_MUSE_RUNTIME` also
overrides its runtime selection. An example machine configuration is:

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

`syncSessionNames: false` keeps generated and manually edited titles in Helicon's
local database instead of sending the failing rename command. Title generation
and agent delegation remain enabled. The default is `true` for other installations.
The environment file must already exist; select the intended Node installation
there for noninteractive tool shells. Do not put API keys in this configuration.

## Build and stage on Windows

Build the daemon, server, UI and web workspaces using Node 22 or later, then run
`npm run bundle:server --workspace helicon-desktop`. The existing bundle script
replaces only its generated `apps/desktop/src-tauri/resources` directory.

Run `scripts/stage-desktop-recovery.ps1 -WslHome /home/USER` in PowerShell 7 after
checking the installation and WSL user. Optional `-InstallRoot`, `-DataDir` and
`-Distro` parameters support an isolated validation installation.

The staging script saves a resource backup and any existing runtime configuration,
then stages the new server and UI together. It replaces the server entry point with
a small bootstrap. The running process and current frontend assets are left in
place. On the next normal app start, the bootstrap installs the matching frontend
and loads the repaired server. Its activation message appears in the server log.
`resources/muse-recovery/deployment.json` records the backup and build hash.

The desktop launcher reads the first stdout line as the server's readiness URL,
then closes that pipe. The bootstrap's activation message must therefore go to
stderr. `npm run test:recovery-bootstrap` verifies this contract and frontend
activation; it also runs as the first step of the root `npm test` command. Test
the actual desktop launcher as well as the standalone server when changing startup.

Do not restart while user tasks or background agents are running. Old session logs
are not rewritten: use a fresh task after activation if an old session retains
the problematic rename record. Saved work and transcripts remain available.

An official Helicon update may overwrite this local repair. Retain the source and
deployment receipt, then compare with upstream before reapplying it. The staging
script refuses to overwrite an existing staged repair.

## Validation and limits

Automated regression coverage checks missed completion, projection health, active
`incomplete` snapshots, concurrent newer turns, unknown `notLoaded` snapshots,
pending questions, history preservation, recovery backoff, and local title retention.
Additional regression cases cover the selected-thread and background history
cadences, failed reads, unchanged saved revisions, genuine live progress, and
completion while unavailable health is still reported.
Real Muse tests completed native CLI helpers, a CLI workflow, a three-child Helicon
workflow and a five-child Helicon workflow (four parallel readers and a dependent
synthesis). These are smoke tests, not a guarantee against provider outages or
arbitrary long-running tasks.

The work does not modify Muse's closed-source engine, remove real errors, silently
retry execution, or repair already damaged event records. Read-only recovery can
only display results that Muse makes available. No upstream issue or private log
was published by this repair.

## Rollback

After all tasks finish, close Helicon. Restore `server.cjs` and the contents of the
`frontend` directory from the receipt's `backup/resources` into the installed
resources directory. Restore the saved `runtime.json` if present; otherwise rename
the repair-created configuration out of the data directory. Retain the staged
directory and diagnostic evidence until the restored application is verified.
No session database or Muse log needs to be deleted or restored.
