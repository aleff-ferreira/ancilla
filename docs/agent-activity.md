# Agents and Task Activity

Crew tracks both single-prompt execution and parallel agent orchestration across threads. Whether a session invokes foreground tools, launches a workflow pipeline, spawns native subagents, runs Deep Research, or leaves background shell commands running, Ancilla surfaces live telemetry across three keyboard-accessible layers (`Esc` steps back one level at a time):

1. **Crew card** in the composer dock (`Enter` expands/collapses).
2. **Crew panel** beside the thread (`Ctrl/Cmd+Shift+M`).
3. **Activity drawer** over the sidebar (`Ctrl/Cmd+Shift+A`).

Every status indicator reflects messages emitted by Muse or event arrival ordering observed directly by Ancilla; time-based guesses are never synthesized ([What Muse reports, and what the surface says when it does not](#what-muse-reports-and-what-the-surface-says-when-it-does-not)).

## The Crew Card

Threads with active turns, workflows, research runs, subagents, or background shell tasks display a unified Crew card docked above pending approval banners and the composer. Inactive threads render no card.

- **Collapsed glance:** Shows an animated status glyph, the active step or tool description (rate-limited to hold each headline at least `0.9 s`), live call heartbeat ticks (blue while active, green on success, red on failure), attention pills (`needs you`, `no update`, `failed`) only when action or inspection is relevant, and a progress spine (discrete plan segments, phase rail, or a traveling activity track for un-planned prompts).
- **Expanded details:** Lists attention-needing items (`Review`, `Answer`, `Retry`, `Skip`, `Stop`, `Inspect`), active plan checklists and recent foreground tool invocations, the currently active workflow phase with agent rows (`5x5` deterministic pixel sigil, state, tokens, duration bar), background task controls (`Stop`, `Output`, `Run again`, `Bring back`), and footer links into the Crew panel and **Stop** confirmation dialog.
- **Completion summary:** Finished workflows and research runs transition the card into a structured completion banner summarizing landed counts, wall time, list-price token estimates (`latest attempt of each agent`), key highlights, per-agent duration lanes, and report excerpts.

## The Crew Panel

Triggered via the header toggle, `Ctrl/Cmd+Shift+M`, the command palette, or the card footer, the Crew panel shares the right-hand slot with the Files browser (docked at `520 px`, resizable `400–800 px`, or overlaid below `560 px` thread width without disturbing transcript scroll).

Key sections include:
- Run title, status badge, **Stop run**, and summary counts.
- **Six-cell KPI strip:** Scheduled/planned counts, tokens reported so far, estimated list-price cost (or explicit `mixed models` / `no usage reported yet` reasons), concurrency policy slots, events-per-minute pulse sparkline, and elapsed / wall-plus-agent timing.
- **Interactive Timeline (`t`):** Per-agent lanes organized by phase, retry segments, hatched silent-agent tails, planned placeholders, approval axis markers, and a `now` / `ok` cursor.
- **Filter chips & searchable roster (`/`):** Filter by attention state (`Needs you`, `Failed`, `No update`, `Working`, `Done`) and inspect virtualized phase-grouped agent rows (`j`/`k`/`↑`/`↓` navigate, `Enter` inspects, `r`/`s`/`x` retry/skip/stop).
- **Agent Inspector:** Displays attempt history, extracted workflow input prompts, recorded lifecycle timestamps, comparative metrics, and explicit notes where protocol details are absent (`Overview`, `Lifecycle`, `Result` tabs via `1`/`2`/`3`).

## The Activity Drawer

Accessible from the sidebar footer (`Ctrl/Cmd+Shift+A`), the drawer aggregates **Needs you**, **Working**, and **Finished today** items across open threads alongside global **Stop everything** (which stops runs and tasks while keeping open approval prompts untouched). While active, an accessible live announcer on the card reports state transitions cleanly at most once every ten seconds.

## What Muse reports, and what the surface says when it does not

Because Muse re-emits full run items on state transitions and omits certain intermediate fields, Ancilla persists lifecycle timestamps, agent labels, and latest usage counters across revisions and presents missing facts transparently:

- **Explicit silence thresholds (`No update`):** Working workflow agents emit no heartbeat between lifecycle steps. Ancilla flags `No update` only once silence exceeds `4` minutes *and* the longest completed agent in the run (`Longer than any finished agent`). Background tasks report `No output` after `4` minutes without stream bytes.
- **Run-level approval attribution:** Wire approval requests during workflows do not identify which child agent prompted them, so pending requests surface at the run level rather than highlighting a guessed agent row.
- **Honest missing fields:** Unavailable reasons, unstreamed child tool calls, unshared child results, and missing terminal states render explicit fallback copy (`Outcome not reported`, `Reported near the end of the agent`) rather than fabricated values.
- **Static plan inspection:** Planned agent slots are parsed statically from `host.parallel([...])` literals in workflow scripts without executing user script code, grouped by `<phase>:` name prefixes or scheduling waves.
- **Capped history & stale streams:** Truncated initial loads label unnamed early agents numerically (`Agent 1`), mark timelines `from loaded history`, and adjust banners accordingly; disconnected feeds freeze clocks, disable accents/spinners, and label statuses `Last known`.
- **Token & cost scope:** Reasoning tokens count inside output totals without double-counting, composer spend covers only the lead turn (`>=` floor badge when subagents report usage), and workflow/research cost estimates explicitly note the pricing model used (`at list price` or `Mixed models`).
- **Native subagents & recovery safety:** `subagent_spawn` and `subagent_wait` render inline beside lead calls while internal reminder helpers stay hidden, and reopening active threads uses read-only state inspection ([muse-recovery.md](muse-recovery.md)).

## Task Plans

Reported checklists (`in_progress`, completed, cancelled) associate strictly with the turn that emitted them. Ending a turn preserves unconfirmed checklist items until updated rather than marking steps complete automatically, while starting a newer prompt dismisses completed prior plans and moves unconfirmed checklists into a collapsible **Previous plan** card (queued follow-ups and steers leave the active prompt's plan intact).

## Verification & Simulation

- **Unit & fold tests:** `packages/ui/test/{crew,fold,crew-totals,crew-coverage,fold-calls,crew.bench}.test.ts` and `apps/web/test/demo-seed.test.ts` verify state folding, token deduplication, missing-field copy, and 2,000-agent recomputation budgets.
- **Offline demo states:** Run `npm run demo --workspace @ancilla/web` and append query flags such as `?crew=running`, `stalled`, `failed`, `waiting`, `partial`, `reconnect`, `done`, `big`, `task`, or `turn`.
