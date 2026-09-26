# Agent activity in every thread

Muse Code can delegate work to native subagents and to workflow children that run in parallel. The transcript shows
the lead agent's steps, but not what those delegated agents are doing. Ancilla's **Agents** panel does.

## The panel

The panel sits below the thread title. Collapsed, it shows how many delegated agents the thread has recorded and a
one-line summary: how many are working or waiting, and how many completed, failed, stopped, or are in an unknown state.
The lead agent is not counted; while it works with no children reported, the panel says it is working solo.

Expand it to see one card per agent: its task name, the assignment and phase Muse reported, its status, and whether it
is a workflow agent or a subagent. Working agents come first. Duration, tool-call totals and retry attempts appear only
when Muse supplies them. Finished agents fold behind a **Show N finished agents** control so a long run does not crowd out
the conversation. Cards reflow for narrow windows, the panel works from the keyboard, and it follows the color theme
and reduced-motion settings.

## What it can and cannot tell you

- Native workflow children and standalone subagents feed the same view. A retry updates the same agent rather than
  adding another, and Muse's internal reminder workers are left out.
- The panel reads the notification stream Ancilla already receives from Muse. It makes no model calls, adds no
  polling, and places no limits on spawning or parallel work.
- A task label survives later status updates and history reloads for the same workflow item, child and attempt.
  Outcomes and phases are replaced when a newer record replaces them.
- When the view is disconnected, closed, stalled or unavailable, the panel says **Last known activity**, working agents
  read "Was working", and animations stop. See [muse-recovery.md](muse-recovery.md) for how a stalled thread keeps
  updating. An ended parent turn alone does not mean a background child has finished.
- Some Muse workflow records carry only a short task label, a status and final metrics. The panel cannot show a child's
  current command or full assignment when Muse does not report it; such agents say that task details were not
  reported. Ancilla never evaluates generated workflow code to guess an assignment.
- Reopening a thread that is still running reads its current state instead of issuing `session/resume`, so active work
  and pending questions are left alone.

## Verifying it

The UI tests (`packages/ui/test/agents.test.ts` and `agent-panel.test.ts`, run by `npm test`) cover agent identity,
revisions, retries, ordering, missing metadata, reconciliation, history reloads, stable rendering, accessible panel
markup and safely loading a thread that is already running.

A saved native workflow replayed from real Muse showed four agents working at once, then a fifth synthesis agent, then
five completed agents, with the same names and metrics before and after reopening the thread. Visual checks covered dark
and light themes, narrow cards, stale state, collapsing, and the finished-agent disclosure.

To check it yourself, ask Muse for a task that delegates, for example a workflow that reads several parts of a project
in parallel and then summarizes them. The count should rise as children start, the summary should move from working to
completed as they finish, and reopening the thread afterwards should show the same agents.
