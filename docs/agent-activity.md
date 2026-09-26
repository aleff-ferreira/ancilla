# Agent activity in every thread

The **Agents** panel sits below the thread title. It shows the number of delegated
agents recorded in that thread, a count of those working or waiting, and the
completed, failed, stopped, or unknown totals. The lead agent is separate from
these counts; when no children have been reported, the panel indicates solo work.

Expand the panel to see task names, reported assignments and phases, and each
agent's status. Working agents appear first. Duration, tool-call totals and retry
attempts appear only when Muse supplies them. Finished history can be expanded
without crowding out the conversation. Cards adapt to narrow windows, support
keyboard navigation, and respect reduced motion and the existing color theme.

## What the display can establish

- Native workflow children and standalone subagents feed the same view. Retries
  update one agent rather than inflating the count. Internal reminder workers
  are excluded.
- The panel uses the existing Muse notification stream. It makes no model calls,
  adds no polling, and places no limits on spawning or parallel work.
- Task labels survive subsequent status updates and history refreshes for the
  same workflow item, child and attempt. Old outcomes and phases are not retained
  when newer records replace them.
- A disconnected, closed, stalled or unavailable view is explicitly marked
  **Last known activity**; active animations stop. An ended parent turn alone
  does not mean a background child has finished.
- Some Muse workflow records provide only a short task label, status and final
  metrics. The UI cannot display a child's current command or full assignment
  when Muse does not report it. Anonymous children show that task details were
  not reported. No generated workflow code is evaluated to infer assignments.
- Reopening a known running thread reads its current projection rather than
  invoking `session/resume`, preserving active work and pending questions.

## Validation

The UI suite covers identity, revisions, retries, ordering, missing metadata,
reconciliation, history refresh, stable rendering indexes, accessible panel
markup and safe loading of an already-running thread. An actual saved native
workflow replay reached four simultaneous working agents, followed by a fifth
synthesis agent, then five completed agents. Names and metrics matched before
and after reopening that session. Visual checks cover dark and light themes,
narrow cards, stale state, collapse and finished-agent disclosure.
