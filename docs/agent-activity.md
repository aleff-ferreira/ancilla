# Agents and tasks in every thread

Muse Code can delegate work: a native workflow fans out to agents that run in parallel, a subagent takes a
side task, a shell command keeps running in the background. The transcript shows the lead agent's steps, not
what the delegated work is doing. Ancilla shows that in three places that grow out of one another: the
**Crew card** in the dock, the **Crew panel** beside the thread, and the **Activity** drawer over the sidebar.
Each is one keystroke deeper than the last, and `Esc` always goes back exactly one level.

Everything on these surfaces is something Muse sent, or something Ancilla can derive from the order it
arrived in. Nothing is inferred from the clock alone; see [what Muse reports](#what-muse-reports-and-what-the-surface-says-when-it-does-not).

## The Crew card

A thread with a live run, subagent or background task gets one card in the dock, above the request panel and
the composer. A thread with nothing running gets no card and no strip: the idle cost is zero.

**Collapsed**, the card is one line per run or task, and that line answers three questions at once: is
everything fine, what needs me, how far along is it. Left to right: a status glyph, the run's name (the name the
launch was given, such as `v2-breaking-change-audit`), a strip with one cell per agent grouped by phase, the
progress (`Judge · 6 of 10`), chips only when something needs attention, and the elapsed time. When everything is
fine the line carries no chips; absence is the signal. The chips are `1 needs you` and `1 failed`; `1 no update`
appears only when neither of the others does, since one chip is calmer than three. More than three lines fold
into `+N more`.

**Expanded** (click the line, or `Enter` on it), the card shows:

- a head with the run's name and a sub line (`Workflow · started 14:02 · 10 agents · 1.1M tokens · ~$4.18 est.`);
- the **phase rail**, an accordion of the run's phases (`Research 4 of 4 · Design 2 of 3 · Judge 0 of 2 ·
  Synthesize 1 planned`) with exactly one phase open at a time, the current one by default;
- the **attention list**: agents that are waiting on you, then failed, then quiet, each as a two-line row with the
  reason and the action (`Review`, `Answer`, `Retry`, `Skip`, `Stop`, `Inspect`). A request Muse raised while the
  run is live sits at the top of this list as a run-level row, because Muse does not say which agent asked;
- the open phase's compact rows (sigil, name, state word, tokens, time, a share bar against the longest finished
  agent), and one row per background task with the command, who sent it to the background, its last output line
  and `Stop`, `Output`, `Run again` or `Bring back`;
- a footer with the counts (`6 done · 1 failed · 2 running · 1 planned`), `All 10 agents` and `Timeline` (both
  open the panel) and `Stop run`, which confirms first: `Stop the run offline-sync-research-design? 2 working
  agents will be cancelled. Finished work stays.`

After `Retry` the row reads `Retrying · attempt 3 starting · Muse has not confirmed yet` until a revision shows
the new attempt; after `Skip` or `Stop` it reads `Stopping…` until the outcome arrives. A retry is a new attempt
on the same row; the earlier attempts stay in the agent's lifecycle. If Muse refuses the control because the
agent moved on, the row goes back to what it was and a toast says so.

Every agent carries a **sigil**: a small mirrored pixel mark derived from its name, the same wherever the agent
appears. It breathes while the agent works and holds still under reduced motion. Hue is reserved for status.

**When the run ends** the card becomes a short report: a headline that says exactly what happened (`All ten
landed.`, `Nine of ten landed, one skipped.`, `Stopped by you after 12m; four of ten had landed.`), a fact line
(`Every phase reached its end · 1 agent needed 3 attempts`), the counts, wall time, tokens and estimated cost, at
most four highlights (what did not land first, then the longest agent, the most tokens or tool calls, and the time
the run waited on you or its peak concurrency), a "Where the time went" picture with one lane per agent, and the
first lines of the report Muse attached. The strip gets one sheen, once, only when every scheduled agent landed;
a run with a failure, a skip or an unreported outcome gets the report without it. If you were away five minutes
or more, a "Since you left" line above the report says what changed meanwhile. There is no confetti, no score and
no percentage.

The transcript keeps one work-log row at the launch point, `Started workflow … · 10 agents in 4 phases · in
the dock`, which becomes `Workflow finished … · 10 agents · 45m 10s · report in the dock`; the button on it
focuses the card.

## The Crew panel

The panel opens from the toggle in the thread header, from `Ctrl/Cmd+Shift+M`, from the command palette, or
from the card's footer. It takes the files panel's slot: the slot shows Files or Crew, never both, and opening
one closes the other. It docks beside the thread while the thread keeps at least 560 px; otherwise it overlays
the thread's right edge over a scrim, and `Esc` closes it. The transcript never loses its scroll position either
way. The panel is 520 px by default and can be dragged between 400 and 800.

From the top:

- the run's name, a status pill (`Running`, `Finished`, `Stopped`, `Failed`) and `Stop run`;
- a summary sentence: `6 of 10 done · Judge · 1 needs you · 1 failed · 1 no update`, or `7 done · 3 working ·
  more may start` when the plan is not known;
- a **KPI strip** of six cells: agents (`9 +1 planned / 2 working now`), tokens so far (`1.1M / 5 of 9
  reported`), estimated cost (always labelled `at list price`), slots (`2 of 16 / launch policy`, only when the
  launch reported a policy), a pulse sparkline of events per minute over the last ten minutes, and the elapsed
  time. A missing value renders as `—` with the reason under it. A finished run shows wall time, agent time
  across all agents and the peak concurrency instead;
- the **Timeline**: one lane per agent under phase bands, retries as new segments on the same lane, a hatched
  tail from the moment an agent went quiet, a dashed placeholder for an agent the script plans but Muse has not
  scheduled, an amber marker on the axis for a request raised during the run, and a `now` line that moves once a
  second (an `ok` end line once the run finished). `t` collapses it;
- filter chips (`All 10 · Needs you 1 · Failed 1 · No update 1 · Working 2 · Done 6`) and a `Find agent` box
  (`/`), which matches a name or a `judge:` prefix;
- the **roster**, grouped by phase with sticky headers (`Design 2/3 · 1 failed · 506.7k · 11m 04s`), one row per
  agent with its state word, tokens, time and share; more than twelve finished agents in a phase fold behind
  `Show N finished`, and the whole list is virtualized past sixty rows;
- the **inspector**, opened with `Enter` on a row or a click on a cell or sigil. Past 760 px it is a column beside
  the roster; below that it replaces the roster, and the head becomes a crumb (`‹ run › agent`). It stacks the
  agent's identity (`Design · Workflow agent · attempt 2`), a callout by state (failed: `Retry agent` and `Skip
  and continue`; quiet: `Stop agent` and `Keep waiting`; waiting: `Review request`), tabs `Overview`,
  `Lifecycle` and `Result`, "What happened" per attempt with the times Ancilla recorded, the agent's task read
  from the workflow script, facts that never leave a blank, a comparison with the run's longest and most costly
  agents, and a note on what Muse does not stream.

Keys, inside the panel: `j` `k` `↑` `↓` move, `Enter` inspects, `Space` peeks, `n` and `Shift+n` jump between
issues, `f` cycles the chips, `[` and `]` fold the current phase, `r` retries, `s` skips, `x` stops, and `Esc`
goes back one level: inspector, then roster, then closed. In the inspector, `j` and `k` step through agents in
roster order and `1` `2` `3` switch tabs. None of these keys fire while the composer or a text field has focus.

## The Activity drawer

The footer's `Activity` button (`Ctrl/Cmd+Shift+A`, also in the command palette) carries a badge with the
number of live runs, background tasks and pending requests; the badge turns amber when anything needs you. The
drawer slides over the sidebar with three sections, `Needs you`, `Working` and `Finished today`, each item with
the thread it belongs to, `Open` and `Stop`. `Stop everything` confirms with what it will stop (`Stop
everything? Stops 2 runs and 1 task. Approvals stay open.`), is hidden when there is nothing to stop, and never
answers a request for you. When nothing runs and nothing waits, the drawer says `All quiet.`

In this release the drawer lists every thread's pending requests, and the runs and tasks of the threads this
window has opened. Other threads keep their word in the sidebar and a note says so: `Other threads appear here
once Ancilla tracks them (coming in 1.1)`.

Around all of this, the ambient signals: the sidebar row gets a second line with a micro strip, `Judge · 6/10`
and the attention counts (`10 landed` once the run ends, `Last known 12m` when the feed is stale, the command
when a thread only has a background task); the thread header shows `Needs you · N`, `Working 41m 16s`, `Waiting
for you`, `Crew landed 45m 10s` for a few seconds after the end, or `Last known`; and the window title starts
with `(N)` while N requests wait across threads. None of these carry a live region: the card's announcer is the
only one in the document, and it says only that a request needs you, that an agent failed, that a phase or the
run finished, that the feed went stale, or that a background task failed, at most once every ten seconds.

## What Muse reports, and what the surface says when it does not

A workflow agent reaches Ancilla as part of the run's item, which Muse re-sends whole on every change. Each
agent's lifecycle runs `scheduled`, `started`, `usage`, `completed`, `terminal`; its label is sent only when it is
scheduled, its tokens once, just before it ends, its duration when it ends, and its tool-call count, the run's
report and the text of the last failure only on the run's final revision. Ancilla's fold keeps what the wire
forgets: the label, the tokens, and the moment each step first showed up. Those moments are the times the card and
the panel show, so a start time is when Ancilla first saw the agent started, never earlier.

The rules that follow from that:

- **No heartbeat, so no verdicts.** Muse says nothing about a working agent between its lifecycle steps.
  Ancilla shows the fact, `No update for 4m 12s · running 16m 02s`, and only once it is remarkable: past four
  minutes, or past the longest agent that has finished in this run, whichever is longer (`Longer than any
  finished agent (12m 40s)`). Before any agent has finished, nothing is flagged, because there is nothing to
  compare with. The words *stalled*, *hung* and *stuck* never appear. A background task's liveness is its output,
  so its row says `No output for 4m 10s` after four minutes of silence, which is a fact about its output.
- **Requests are not attributed.** The wire has no field linking an approval or a question to a workflow agent,
  so a request raised during a run is shown at run level: `Waiting for you · Muse wants to run npm test …`,
  `Asked 1m 40s ago, during Judge. Muse does not say which agent asked.` No cell or lane turns amber for it. A
  background task's own request is tied to the task, and that row does say `Waiting for you`.
- **Absences are sentences.** Tool calls per agent: `At run end`. Tokens: `Reported near the end of the agent`.
  A failed agent's reason: `Muse has not reported a reason yet. The run's report may explain it when it
  finishes.` An agent's model: `Not reported for workflow agents · the lead runs muse-spark-1.3`. Its result:
  `Muse does not share a workflow agent's result. The run's report cites it.` An agent the run ended without an
  outcome: `Outcome not reported`, never `Done`.
- **The plan is read, never run.** The agents a run will schedule come from the `host.parallel([{ label, input
  }])` literals in the launch script, read as text; a planned agent shows as a hollow cell and `Planned · not
  scheduled yet`, and its task, in the inspector, is that literal's `input`. A script that builds its agents in a
  loop gives no plan: the line reads `6 done · 3 working · more may start`, and there is no `of N`. Ancilla never
  evaluates generated workflow code.
- **Phases come from names.** A label like `judge:perf` puts the agent in the `Judge` phase; without prefixes,
  agents scheduled in the same burst form a wave; otherwise there is one group, `Agents`.
- **Loaded history is said to be loaded history.** Muse's history read is capped, so a long run can lose its
  earliest revisions. An agent whose scheduling revision was cut has no name and is numbered (`Agent 1`), the
  elapsed time reads `about 41m`, the Timeline is labelled `from loaded history`, and a notice says: `Counts are
  from loaded history. The earliest revisions of this run were not loaded, so 2 agents have no name yet and the
  start time is approximate. Nothing here is lost; it is just not loaded.` Counts can then differ from the plan:
  an unnamed agent cannot be matched to the plan entry it came from.
- **A stale feed freezes everything.** When Muse's view is unavailable, or the stream dropped while the thread
  was in the background, every clock stops at the last moment Ancilla heard from it, cells lose their accent,
  spinners stop, no agent is promoted to no update, and the line reads `Last known · 41m 16s · at 14:43`. See
  [muse-recovery.md](muse-recovery.md) for how a thread keeps reading saved progress meanwhile.
- **Cost is an estimate.** Muse does not send an agent's model or a price, so the panel multiplies the tokens
  Muse reported by the list price of the session's model and says so: `~$4.18 · at list price`. The composer's
  cost still counts the lead only.
- **Nothing is inferred from time.** No progress bar grows with the clock, there is no ETA and no percentage;
  counts include only scheduled agents, planned ones are labelled planned, and the pulse counts real revisions.
- **Native subagents** that Muse surfaces as `subagent_spawn` and `subagent_wait` tool calls appear as rows
  with the objective from the spawn and the outcome and summary from the wait; the same controls apply when Muse
  emits subagent items. Muse's internal reminder workers stay hidden.
- Reopening a thread that is still running reads its current state instead of issuing `session/resume`, so
  active work and pending questions are left alone.

## Coming in 1.1

These need a wire field or server work Ancilla does not have yet. Each shows its fallback meanwhile:

| Item | Fallback shown now |
| --- | --- |
| A request under the agent that asked for it, with an amber cell and lane | the run-level need row: `Muse does not say which agent asked.` |
| Strips, badge counts and drawer items for threads this window has not opened | the sidebar's word for the thread; the drawer's note |
| An Activity tab in the inspector with a subagent's tool calls | the Overview note: `Muse does not stream a workflow agent's tool calls to this thread.` |
| An agent's own result | `Muse does not share a workflow agent's result. The run's report cites it.` |
| The crew's tokens in the composer's cost | the composer counts the lead only, with a tooltip `excludes agents` |
| `Load earlier history` past the capped read | the partial-history notice without the button |
| A sigil in the approval panel | the panel unchanged |

## Verifying it

The model has unit tests in `packages/ui/test/crew.test.ts` (phases, counts, the no-update threshold, retries
and the optimistic pending flags, run-level requests, partial history, a stale feed, the completion report, the
plan read from a script, sigils, announcements, the sidebar summary, the drawer) and `fold.test.ts` (the
transition times and the latched usage), and `crew.bench.test.ts` builds a 2000-agent run over a hundred
revisions and holds each recompute under budget. The surfaces have SSR tests beside them, and
`apps/web/test/demo-seed.test.ts` folds every demo scenario through the same model.

To see it without Muse, run `npm run demo --workspace @ancilla/web` and open `/demo.html?crew=running`. The
audit thread plays the reference scenario: ten agents in four phases, 41m 16s in, one failed after two attempts,
one quiet past the threshold, one finishing, one planned, a request Muse raised during Judge and a background
task. `crew=stalled`, `failed`, `waiting`, `partial`, `reconnect`, `done`, `big` (two thousand agents) and
`task` (three background tasks and no run) isolate the other states, and `workflow=done` lets whichever run is
loaded finish as the page opens.

With real Muse, ask for a task that delegates, for example a workflow that reads several parts of a project in
parallel and then summarizes them. The strip fills as agents are scheduled and land, the phase word moves along
the rail, an agent you retry keeps its row and gains an attempt, and reopening the thread afterwards shows the
same agents with the same times, read back from history.
