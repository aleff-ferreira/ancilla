# Desktop mode: the Sentinel

Status: preview, Windows only, off until you switch it on. This is the first part of Desktop mode: a watcher that reads what
Windows records about Wi-Fi and power, judges it with fixed rules, and keeps a history and an audit. It acts on nothing yet;
standing orders that are approved on the screen come in the next part. There is no model in it.

## What it reads, and what it never does

A PowerShell 5.1 script (`packages/server/src/sentinel/collector-script.ts`, the same on every Windows 10 and 11) runs as a
child of the server. It is read-only:

- the WLAN-AutoConfig operational log, as events are written (`EventLogWatcher`): 8000 an attempt started, 8001 connected,
  8002 failed, 8003 disconnected, with the numeric reason code, which does not depend on the display language;
- the sleep and resume events (Kernel-Power 42, 107, 506, 507 and Power-Troubleshooter 1);
- a reading of the adapter every 30 s from `netsh wlan show interfaces`: signal quality, RSSI in dBm where this Windows
  reports it, channel, rates, radio type and band. Values are found by their shape, not by their label, so the display language
  does not matter. Names of networks are never read from `netsh` (it garbles some); they come from the event log.

It opens no network connection, writes no file, changes no setting, runs with your rights and never asks for more. It ends
when the server ends. When Watch is switched on it also reads the event log back, up to 45 days or from the last event it
kept, because Windows keeps that log at about 1 MB and rolls it over.

## Where things are kept

In the data folder, under `sentinel/`: `history.sqlite` (events 90 days, adapter readings one a minute for 14 days, findings
180 days), `audit.jsonl`, `settings.json` and a copy of `collector.ps1`. Nothing is created until something asks about the
Sentinel or Watch is on. Network names are kept as plain text, only on this machine.

## What counts as a problem

Measured on one real PC over 40 days: 82 disconnects, 45 by the driver, 27 by the person, 10 by policy or a state change; 35
within 90 s of a sleep or a resume; 20 real drops in the middle of a session. Reconnecting on every disconnect would act 82
times for about 13 cases that needed it, so the rules are about intent (`packages/server/src/sentinel/wifi.ts`):

| Seen | Treated as |
| --- | --- |
| A disconnect the person asked for (reason 2 or 3), policy (5, 7), a state change such as the radio switched off (11), or a reason not understood | Not a drop. Never acted on. |
| Any disconnect within 90 s before or after a sleep or a resume | The system's own doing. A sleep has 15 s to follow a disconnect to count; after a suspension the timers wait 20 s for the log's late events before they judge anything. |
| A driver disconnect that recovers within 10 s | A blip: counted, listed in the daily digest, never announced. |
| A driver disconnect that has not recovered after 15 s | A drop (warn), closed when the connection returns. Still not back after 5 minutes, and the machine did not sleep meanwhile, a critical "down" finding says so. |
| 3 real drops in 10 minutes (6 is critical) | Flapping (warn). |
| An attempt connecting for more than 20 s | Stuck (warn). |
| Signal at or under 40% for three readings in a row (clears at 50% for three) | Weak signal (warn), with the RSSI Windows reports, or the dBm it maps the percentage to when it reports none. |
| 3 failed attempts on one profile within 10 minutes | Cannot connect (warn). A network that asks for a login nobody gave it (802.1X) and an attempt the person cancelled are not failures. |

Every threshold is in one table (`RULES`). Names of networks are data: they are compared and shown, never interpreted, and they
are not part of any finding's text or identifier.

## The audit

Every finding raised or closed, every change of a setting and every start or stop is a line in `audit.jsonl` that holds the
hash of the line before it, so an edited, removed or reordered line breaks the chain at that line, and `GET .../audit/verify`
says where. The newest hash is also kept in the history, so a file cut short is noticed. This guards against corruption and
against a bug or a tool rewriting history. It is not a defense against a process running as you with both files in reach.

## The interface

Under `/api/assistant/desktop` (same authentication as the rest of `/api`): `GET` the status, `PATCH /settings` with
`{"watch": true}` (and `act`, which does nothing yet), `GET /findings?open=1`, `GET /digest`, `GET /history?days=14&offset=-180`
(findings per day in a time zone; `offset` is minutes east of UTC), `GET /audit` and `GET /audit/verify`. Both settings start
off. Switching Watch on is refused off Windows.

## Measured

On the PC the rules were first drawn from (Windows 11 25H2, a Wi-Fi 7 adapter, 24 logical cores), read-only:

- The rules judged the real log of 51 days exactly as it had been counted by hand: 82 disconnects (45 driver, 27 person, 8
  policy, 2 state change), 35 within 90 s of a sleep or a resume, 20 real drops of which 7 were blips, 122 attempts of which 23
  failed (10, 4, 4, 1 and 3 by cause, and 1 cancelled), 4 attempts stuck for more than 20 s.
- Windows reuses one `ConnectionId` for many attempts of a profile, so an outcome is paired with its attempt by profile. Pairing
  by id gave 22 false "stuck" findings on the real log and 4 by profile.
- The collector at rest, sampling every 30 s: 0.17% of one core (0.007% of the CPU), 113 MB working set (93 MB private), 0.8 s
  of CPU to start and read an hour of log back, 11 threads, no process left behind. That is the price of a PowerShell script
  with no new toolchain; a compiled collector would be smaller.
- Reading the log back from the start (51 days, 834 lines) took 3.5 s.

## Limits

- It runs inside the Ancilla server, so it stops when the app does. Watching with the window closed needs a start at logon,
  which is not built.
- The reason codes are the ones Windows 11 writes. A code the table does not know is never acted on.
- Not measured: Defender or other security software that blocks a PowerShell script; an adapter that is not Wi-Fi.
