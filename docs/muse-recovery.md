# Muse Session Recovery & Runtime Operations

When Muse's live notification stream stalls or marks `projectionUnavailable` mid-turn, Ancilla keeps the thread legible without sending duplicate prompts, dispatching unsafe `session/resume` calls during active work, or altering Muse's delegation limits. Recovery operates strictly in read-only mode against state Muse has already persisted.

## Read-Only Stalled-Feed Recovery

When an open thread goes silent mid-turn or reports `projectionUnavailable`:

1. **Snapshot polling:** Ancilla periodically queries `session/read` and `view/page` and merges results chronologically without discarding already-visible transcript entries, pending approvals, or newer streamed items.
2. **Synthetic incomplete filtering:** Temporary `failed` / `incomplete` records returned by `view/page` while `session/read` still shows the turn running are suppressed until a terminal outcome lands.
3. **Polling cadence:**
   - **Readable history, selected thread:** every `15 s`.
   - **Readable history, background thread:** every `120 s`.
   - **Failed or unreadable read (initial backoff):** every `30 s`, then `120 s`.
4. **UI transparency:** Active threads display **Syncing saved progress** (with `Last checked`, `Progress updated`, and **Reload results**), while the [Crew card](agent-activity.md) freezes elapsed timers under **Last known**. Recovery ends automatically once a real completion or new live turn progress arrives.

## Local thread titles

To avoid triggering MSP workflow decode errors caused by pre-workflow `session/rename` frames, `syncSessionNames` defaults to `false`: Ancilla generates and saves user/auto thread titles inside its local SQLite database without calling `session/rename`. Setting `"syncSessionNames": true` in `runtime.json` enables two-way title synchronization and automatically disables syncing for any host that emits a `missing field kind` decode error.

## Runtime configuration

On startup, `ancilla-server` checks for an optional `runtime.json` (UTF-8 or UTF-16) inside its active data directory:

- **Desktop (Windows / macOS / Linux):** `%APPDATA%\app.ancilla.desktop` / `~/Library/Application Support/app.ancilla.desktop` / `~/.local/share/app.ancilla.desktop`
- **Standalone CLI / Server:** `~/.ancilla` or the `--data-dir` path

Supported `runtime.json` fields:

| Setting | Purpose |
| --- | --- |
| `runtime` | Windows only (`auto`, `native`, `wsl`), overridden by `--runtime` or `ANCILLA_MUSE_RUNTIME` |
| `distro` | Target WSL distribution (overridden by `--distro`) |
| `musePath` | Explicit path to the `muse` binary inside the target runtime (`--muse`) |
| `syncSessionNames` | Set `true` to send thread titles to Muse via `session/rename` |
| `wslEnv` | Windows-only env map forwarded via `WSLENV` to WSL child processes (`PATH` and `WSLENV` excluded) |
| `allowHosts` | Extra permitted HTTP `Host` headers beyond loopback (`["ancilla.example"]`) |
| `hostStartTimeoutMs` | Startup timeout (`0–2147483647` ms, default `300000`; `ANCILLA_HOST_START_TIMEOUT_MS` overrides) |
| `dataDirLock` | Set `false` only on network shares where process locking cannot run safely |

Environment variables such as `ANCILLA_RESEARCH_STARTUP_MS` (minimum `1000` ms) adjust Deep Research session initialization budgets when starting WSL or native hosts.

### Reaching the server by another name

By default, HTTP requests must present a loopback `Host` header (`127.0.0.1`, `localhost`, `::1`, or the explicitly bound `--host` loopback IP) unless carrying a valid `Authorization: Bearer` header. Reverse proxies or tunnels using custom DNS names receive `403` (`kind: "host"`) unless permitted via `--allow-host <name>`, `--allow-origin`, or `"allowHosts"` in `runtime.json`. Refused host names are logged (capped at five unique hosts) and counted in `GET /api/health` under `diagnostics.hostRefusals` and `diagnostics.lastRefusedHost`.

## The event stream

SSE `/api/events` enforces backpressure limits (`4 MiB` queued frames or `90 s` without completed writes) so stalled tabs or proxies cannot exhaust memory. Disconnected clients reconnect cleanly and refetch session lists and thread snapshots without replaying turns. Backpressure counters (`diagnostics.sse`), active/queued research counts, `closing` status, and host exits (`diagnostics.hostExits`) are exposed at `/api/health`.

## When the server stops

- **Graceful shutdown (`SIGINT`, `SIGTERM`, `SIGHUP`, Windows `SIGBREAK`, or `--close-on-stdin-eof` from Tauri):** Immediately returns `503` on non-health routes while leaving `GET /api/health` reporting `closing: true`. Ongoing research runs mark themselves interrupted within `5 s`, active MSP hosts and foreground commands drain up to shutdown deadlines (`11.5 s` / `20 s` CLI, `25 s` desktop wrapper), and active process groups receive `SIGTERM` followed by `SIGKILL`.
- **Hard kills:** `SIGKILL` or process termination prevents draining; interrupted research runs and unclosed turns are reconciled automatically at the next startup.

## One server per data folder

Each running server claims its data directory via `<dataDir>/ancilla.owner` (instance UUID, PID, host, port, timestamp, version, platform) before opening SQLite. Starting a second instance checks whether the recorded PID and `/api/health` instance are alive—exiting with code `75` if active, or reaping stale records left after crashes (`dataDirLock: false` bypasses this guard when explicitly needed). Database lock waits remain capped at five seconds.

## Verification & Scope

Automated unit and integration suites in `packages/server/test/server.test.ts` and `packages/ui/test/{controller,fold,stalled-notice}.test.ts` validate polling cadences, backoff, snapshot merging, incomplete-record suppression, and local title retention. Recovery never rewrites Muse history files or retries failed execution on its own.
