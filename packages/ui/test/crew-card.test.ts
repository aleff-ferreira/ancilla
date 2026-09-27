import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import { CrewCard, defaultOpenPhase, footMeta, headSub, phaseHeadText, reportVisible, withPendingRetries, type CrewCardProps } from "../src/components/crew/CrewCard.js";
import { AnnouncementQueue } from "../src/components/crew/CrewAnnouncer.js";
import { resolveCardKey } from "../src/components/crew/useCardKeys.js";
import { railCount } from "../src/components/crew/PhaseRail.js";
import { compactState, runNeedLine, stateSentence } from "../src/components/crew/cardCopy.js";
import { pendingKey, summaryLine, type AgentVM, type RunVM } from "../src/model/crew.js";
import { APPROVAL, NOW, S, agentNamed, finishedRun, flatten, mkAgent, mkRun, mkTask, referenceAgents, runningRun, textOf as text } from "./fixtures/lantern.js";

const noop = () => {};

function render(overrides: Partial<CrewCardProps> & { run: RunVM | null }): string {
  const props: CrewCardProps = {
    sessionId: "s1",
    tasks: [],
    completion: null,
    sinceYouLeft: null,
    expanded: false,
    openPhase: null,
    selectedId: null,
    readOnly: false,
    onToggle: noop,
    onOpenPhase: noop,
    onInspect: noop,
    onOpenPanel: noop,
    onAction: noop,
    onStopRun: noop,
    onDismissReport: noop,
    onDismissRecap: noop,
    onReview: noop,
    ...overrides,
  };
  return renderToStaticMarkup(createElement(TooltipProvider, { children: createElement(CrewCard, props) }));
}

/** The collapsed line's words: the line is the whole card while collapsed. */
function line(run: RunVM, extra: Partial<CrewCardProps> = {}): string {
  return text(render({ run, ...extra }));
}

function chips(markup: string): string[] {
  return [...flatten(markup).matchAll(/class="crew-chip ([a-z-]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span class="lbl">([^<]*)<\/span>/g)].map((m) => `${m[1]}:${m[2]}`);
}

describe("the collapsed line", () => {
  it("reads glyph · name · strip · progress · elapsed with no chip while everything is fine", () => {
    const agents = referenceAgents().map((agent) => (agent.state === "failed" ? { ...agent, state: "done" as const, attempt: 1, failure: null } : agent.state === "no-update" ? { ...agent, state: "working" as const, quiet: null } : agent));
    const run = mkRun(agents);
    const markup = render({ run });
    assert.match(markup, /aria-expanded="false"/);
    assert.match(markup, /class="crew-strip"/, "the sm strip");
    assert.match(markup, /spin-ring/, "the lead ring while live");
    assert.deepEqual(chips(markup), []);
    const words = text(markup);
    assert.match(words, /offline-sync-research-design Judge · 7 of 10 41m 16s/);
    assert.equal(summaryLine(run).progress, "Judge · 7 of 10");
    assert.match(markup, /<span class="word">Judge · <\/span>/, "the phase word leaves before the count in a narrow card");
  });

  it("chips only what needs attention: needs you, failed, both, and no update only on its own", () => {
    const failed = mkRun(referenceAgents());
    assert.deepEqual(chips(render({ run: failed })), ["fail:1 failed"], "no update stays in the card beside a failure");
    const needs = mkRun(referenceAgents(), { runNeeds: [{ kind: "approval", command: "npm test -- --run conflict", askedAt: S(39, 36), requestId: "ap1", phase: "Judge" }] });
    assert.deepEqual(chips(render({ run: needs })), ["need:1 needs you", "fail:1 failed"]);
    const quiet = mkRun(referenceAgents().map((agent) => (agent.state === "failed" ? { ...agent, state: "done" as const, failure: null } : agent)));
    assert.deepEqual(chips(render({ run: quiet })), ["quiet:1 no update"]);
    const two = mkRun(referenceAgents(), { runNeeds: [
      { kind: "approval", command: "npm test", askedAt: S(39, 36), requestId: "ap1", phase: "Judge" },
      { kind: "input", command: "Which passkey provider should go first?", askedAt: S(40, 0), requestId: "q1", phase: "Judge" },
    ] });
    assert.deepEqual(chips(render({ run: two })), ["need:2 need you", "fail:1 failed"]);
  });

  it("says what it knows when the plan is unknown, the history partial, or the feed stale", () => {
    const agents = referenceAgents().filter((agent) => agent.state !== "planned");
    const noPlan = mkRun(agents, { plannedKnown: false });
    assert.match(line(noPlan), /6 done · 2 working · more may start/);
    assert.match(render({ run: noPlan }), /crew-cell more/, "the strip ends with a dashed cell");
    const partial = mkRun(referenceAgents(), { elapsedApprox: true, partialHistory: true });
    assert.match(line(partial), /about 41m/);
    const stale = mkRun(referenceAgents(), { stale: true, staleAt: S(41, 16) });
    const markup = render({ run: stale });
    assert.deepEqual(chips(markup), ["stale:Last known"], "last known replaces every other chip");
    assert.doesNotMatch(markup, /spin-ring/, "nothing spins while the feed is not live");
    assert.match(text(markup), /41m 16s · at /);
    assert.match(markup, /class="crew-line stale"/);
  });

  it("covers the endings: all landed, one skipped, stopped by you, and a run that failed", () => {
    const landed = mkRun(referenceAgents().map((agent) => ({ ...agent, state: "done" as const, failure: null, quiet: null })), { status: "finished", endedAt: S(45, 10), elapsedMs: S(45, 10) - S(0, 0) });
    const markup = render({ run: landed });
    assert.match(text(markup), /Done · 10 of 10 45m 10s/);
    assert.match(markup, /class="crew-strip finale"/);
    assert.deepEqual(chips(markup), []);
    const skipped = mkRun(referenceAgents().map((agent) => (agent.name === "design:conflict-ledger" ? { ...agent, state: "skipped" as const, skippedBy: "you" as const } : { ...agent, state: "done" as const, quiet: null })), { status: "finished-with-failures", endedAt: S(43, 2), elapsedMs: S(43, 2) - S(0, 0) });
    assert.match(line(skipped), /Finished · 9 of 10/);
    assert.deepEqual(chips(render({ run: skipped })), ["quiet:1 skipped"]);
    const stopped = mkRun(referenceAgents().slice(0, 9).map((agent, index) => (index < 4 ? { ...agent, state: "done" as const } : { ...agent, state: "skipped" as const, skippedBy: "run" as const, quiet: null, failure: null })), { status: "stopped", endedAt: S(12, 10), elapsedMs: 12 * 60_000 + 10_000 });
    // The model adds the skipped count as a chip on a stopped run; the line shows what the model says.
    assert.match(line(stopped), /Stopped · 4 of 9 had landed 5 skipped 12m 10s/);
    const failed = mkRun(referenceAgents(), { status: "failed", endedAt: S(3, 0) });
    assert.deepEqual(chips(render({ run: failed })), ["fail:run failed", "fail:1 failed"]);
    const starting = mkRun([], { status: "starting", elapsedMs: 4000 });
    const early = render({ run: starting });
    assert.match(text(early), /Starting · no agents scheduled yet 4s/);
    assert.doesNotMatch(early, /crew-strip/);
  });

  it("gives a background task the command, its last line, a Stop button and the elapsed time", () => {
    const running = mkTask("npm run test:e2e -- --grep sync", "working");
    const markup = render({ run: null, tasks: [running] });
    assert.match(markup, /class="cmd">npm run test:e2e -- --grep sync</);
    assert.match(markup, /class="tail">12 passed · 3 pending · running/);
    assert.match(markup, /aria-label="Stop npm run test:e2e -- --grep sync"/);
    assert.match(text(markup), /1m 23s/);
    const quiet = mkTask("npm run test:e2e -- --grep sync", "no-update", { silenceMs: 250_000 });
    assert.match(text(render({ run: null, tasks: [quiet] })), /No output for 4m 10s/);
    const done = mkTask("npm run docs:build", "done");
    const finished = render({ run: null, tasks: [done] });
    assert.match(finished, /class="tail ok">finished · no failure reported</);
    assert.doesNotMatch(finished, /aria-label="Stop /);
    const failed = mkTask("pnpm vitest run packages/sync", "failed", { failure: { text: "tool_error", at: S(44, 44) } });
    assert.match(render({ run: null, tasks: [failed] }), /class="tail fail">failed · tool_error</);
    assert.doesNotMatch(render({ run: null, tasks: [running], readOnly: true }), /aria-label="Stop /);
  });

  it("folds more than three lines into +N more, runs first, then tasks", () => {
    const run = mkRun(referenceAgents());
    const older = mkRun(referenceAgents().map((agent) => ({ ...agent, state: "done" as const, failure: null, quiet: null })), { itemId: "wf-0", name: "earlier-run", status: "finished", endedAt: S(20, 0) });
    const tasks = [mkTask("npm run a", "working", { id: "t1" }), mkTask("npm run b", "working", { id: "t2" }), mkTask("npm run c", "working", { id: "t3" })];
    const markup = render({ run, otherRuns: [older], tasks });
    const names = [...markup.matchAll(/class="name">([^<]*)<|class="cmd">([^<]*)</g)].map((m) => m[1] ?? m[2]);
    assert.deepEqual(names, ["earlier-run", "offline-sync-research-design", "npm run a"]);
    assert.match(text(markup), /\+2 more/);
  });

  it("keeps the progress phrase in step with the model's summary line for every status", () => {
    for (const status of ["running", "finished", "finished-with-failures", "stopped", "failed"] as const) {
      const run = mkRun(referenceAgents(), { status, endedAt: status === "running" ? null : S(45, 0) });
      const words = text(render({ run }));
      assert.ok(words.includes(summaryLine(run).progress.replace(/\s+/g, " ")), `${status}: ${words}`);
    }
  });
});

describe("the expanded card", () => {
  const run = runningRun({}, [APPROVAL]);

  it("shows the head with the run's facts and the elapsed clock", () => {
    const markup = render({ run, expanded: true });
    assert.match(markup, /class="crew-tile"[^>]*><span[^>]*class="spin-ring/);
    assert.match(markup, /class="nm">offline-sync-research-design</);
    const sub = headSub(run).text;
    assert.match(sub, /^Workflow · started [^·]+ · 9 agents · 1 planned · 1\.3M tokens · ~\$[\d.]+ est\.$/);
    assert.match(markup, /<span class="opt">~\$/, "the cost leaves the sub line in a narrow card");
    assert.match(markup, /class="sub short">Workflow · /);
    assert.match(markup, /aria-label="Collapse"/);
  });

  it("draws the rail as tabs with one phase open by default, the current one", () => {
    const markup = render({ run, expanded: true, openPhase: defaultOpenPhase(run) });
    assert.equal(defaultOpenPhase(run), "Judge");
    const tabs = [...markup.matchAll(/role="tab" aria-selected="(true|false)"[^>]*aria-label="([^"]*)"/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(tabs, [
      ["false", "Research, 4 of 4 done"],
      ["false", "Design, 2 of 3 done"],
      ["true", "Judge, 0 of 2 done"],
      ["false", "Synthesize, 1 planned"],
    ]);
    assert.equal((markup.match(/class="crew-seg [^"]*open"/g) ?? []).length, 1, "exactly one open segment");
    assert.equal((markup.match(/class="crew-strip rail"/g) ?? []).length, 4);
    assert.equal(railCount(run.phases[1] as RunVM["phases"][number], true), "2 of 3 · 1 failed");
    // Every agent of the current phase listed above: the accordion opens nothing.
    const allListed = mkRun(referenceAgents().map((agent) => (agent.name === "judge:correctness" ? { ...agent, state: "no-update" as const, silenceMs: 900_000, quiet: { thresholdMs: 760_000, longestFinishedMs: 760_000 } } : agent)));
    assert.equal(defaultOpenPhase(allListed), null);
  });

  it("lists what needs attention first: the run-level request, then the failure, then the silence, with the actions", () => {
    const markup = render({ run, expanded: true, openPhase: "Judge" });
    const rows = [...flatten(markup).matchAll(/class="crew-att( run)?"[^>]*aria-label="([^"]*)"/g)].map((m) => m[2]);
    assert.equal(rows.length, 3);
    assert.match(rows[0] as string, /^Waiting for you: Muse wants to run npm test -- --run conflict\. Asked 1m 40s ago, during Judge\. Muse does not say which agent asked\./);
    assert.match(rows[1] as string, /^design:conflict-ledger, Failed · 2 attempts\. Muse has not reported a reason yet\. The run's report may explain it when it finishes\./);
    assert.match(rows[2] as string, /^judge:perf, No update for 16m 02s\. Longer than any finished agent \(12m 40s\)\. Muse does not report what it is doing\./);
    assert.match(markup, /Needs attention <span class="n">3<\/span>/);
    assert.match(markup, /class="chipm">npm test -- --run conflict</);
    assert.match(markup, /aria-label="Review the request"/);
    assert.match(markup, /aria-label="Retry design:conflict-ledger"/);
    assert.match(markup, /aria-label="Skip design:conflict-ledger"/);
    assert.match(markup, /aria-label="Stop judge:perf"/);
    // Muse's own duration for the attempt that failed, not the span of both attempts.
    assert.match(text(markup), /Failed after 2 attempts · 3m 51s/);
    assert.match(text(markup), /No update for 16m 02s · since it started/);
    assert.doesNotMatch(markup, /stalled|stuck|hung/i);
  });

  it("says a retry or a stop is pending until Muse confirms it", () => {
    const flags = { [pendingKey("s1", "c-cf", 2)]: "retry" as const, [pendingKey("s1", "c-jp", 1)]: "stop" as const };
    const pending = withPendingRetries(runningRun({ pending: flags }), "s1", flags);
    assert.equal(agentNamed(pending, "design:conflict-ledger").pending, "retry", "the clicked row carries the retry until attempt 3 shows");
    const base = runningRun();
    assert.equal(withPendingRetries(base, "s1", {}), base, "nothing pending, nothing copied");
    const words = text(render({ run: pending, expanded: true }));
    assert.match(words, /Retrying · attempt 3 starting Muse has not confirmed yet\./);
    assert.match(words, /Stopping… · ran 16m 02s Muse has not confirmed yet\./);
    assert.doesNotMatch(render({ run: pending, expanded: true }), /aria-label="Retry design:conflict-ledger"/, "no second retry while one is pending");
  });

  it("opens one phase's rows under the attention list and says who is listed above", () => {
    assert.equal(phaseHeadText(run, "Judge"), "2 agents · 0 done · 1 listed above · 148k");
    assert.equal(phaseHeadText(run, "Design"), "3 agents · 2 done · 1 failed · 1 listed above · 12m 40s · 468k");
    const markup = render({ run, expanded: true, openPhase: "Design" });
    const rows = [...flatten(markup).matchAll(/class="crew-ag"[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(rows, ["design:crdt-ledger, Done, 236k tokens, 12m 40s", "design:op-log, Done, 168k tokens, 9m 12s"]);
    assert.match(markup, /class="crew-share" aria-hidden="true"><span class="" style="width:100%">/, "the longest agent fills its bar");
    assert.match(markup, />Hide </);
    const judge = render({ run, expanded: true, openPhase: "Judge" });
    assert.match(text(judge), /judge:correctness Finishing · usage reported 53s ago/);
    assert.match(judge, /class="crew-share" aria-hidden="true"><span class="work" style="width:100%"><\/span><span class="over"/, "past the longest agent the bar hatches");
  });

  it("puts background tasks in their own section with the initiator, the last line and the controls", () => {
    const task = mkTask("npm run test:e2e -- --grep sync", "working");
    const markup = render({ run, expanded: true, tasks: [task] });
    assert.match(markup, /Background <span class="n">1<\/span>/);
    assert.match(text(markup), /npm run test:e2e -- --grep sync You sent it to the background 12 passed · 3 pending · running "merges concurrent edits" 1m 23s Stop/);
    const timeout = mkTask("npm run docs:build", "no-update", { silenceMs: 250_000 }, { initiator: "timeout", tail: "RUN v2.1.0 packages/sync/merge.test.ts" });
    const quiet = text(render({ run: null, tasks: [timeout], expanded: true }));
    assert.match(quiet, /Muse backgrounded it after a timeout No output for 4m 10s RUN v2\.1\.0/);
    const failed = mkTask("pnpm vitest run packages/sync", "failed", { failure: { text: "tool_error", at: S(44, 44) } });
    const ended = render({ run: null, tasks: [failed], expanded: true, outputOf: () => "FAIL merge.test.ts" });
    assert.match(ended, /class="out fail">failed · tool_error</);
    assert.match(ended, />Output</);
    assert.match(ended, /Run again<\/span><\/button>/);
    assert.match(ended, /disabled=""[^>]*aria-label="Run pnpm vitest run packages\/sync again"/, "not routed yet, so it is offered disabled");
  });

  it("ends with the footer: the panel buttons, the counts, and Stop run", () => {
    const markup = render({ run, expanded: true });
    assert.equal(footMeta(run), "6 done · 1 failed · 2 running · 1 planned");
    assert.match(text(markup), /All 10 agents Timeline 6 done · 1 failed · 2 running · 1 planned Stop run/);
    assert.doesNotMatch(render({ run, expanded: true, readOnly: true }), /Stop run/);
    const finished = mkRun(referenceAgents(), { status: "finished-with-failures", endedAt: S(45, 0) });
    assert.doesNotMatch(render({ run: finished, expanded: true }), /Stop run/);
  });

  it("freezes the card when the feed is stale: a note, no spinner, no attention list, no actions", () => {
    const stale = runningRun({ stale: true, staleAt: S(41, 16) });
    const markup = render({ run: stale, expanded: true, stale: true, openPhase: "Judge" });
    assert.doesNotMatch(markup, /spin-ring/);
    assert.doesNotMatch(markup, /Needs attention/);
    assert.match(text(markup), /Last known at [^·]+ · Muse is not reachable, nothing has been lost/);
    assert.doesNotMatch(markup, /aria-label="Stop judge:perf"|Stop run/);
    assert.match(text(markup), /judge:perf Last known · working/);
  });

  it("carries the container hooks the theme adapts to, and no live region of its own", () => {
    const markup = render({ run, expanded: true, openPhase: "Judge" });
    assert.match(markup, /<section aria-label="Agents and tasks" data-crew-card="s1" class="crew-card @container/);
    for (const hook of ['class="sub long"', 'class="sub short"', 'class="opt"', 'class="lbl"', 'class="crew-body"']) assert.ok(markup.includes(hook), hook);
    assert.doesNotMatch(markup, /aria-live|role="status"/);
    assert.match(render({ run, expanded: true, compact: true }), /class="crew-body compact"/);
  });

  it("shows the recap above the card and a thread with only tasks without a head", () => {
    const recap = { leftAt: S(31, 0), finished: 3, failed: 0, phasesStarted: ["Synthesize"], runFinishedAt: S(47, 0) };
    const markup = render({ run, expanded: true, sinceYouLeft: recap });
    assert.match(text(markup), /Since you left at [^·]+ · 3 agents finished, Synthesize ran, the run finished at /);
    assert.match(markup, /aria-label="Dismiss the recap"/);
    const tasksOnly = render({ run: null, tasks: [mkTask("npm run a", "working")], expanded: true });
    assert.doesNotMatch(tasksOnly, /crew-head|crew-rail/);
    assert.match(tasksOnly, /Background <span class="n">1<\/span>/);
  });
});

describe("the report's place in the dock", () => {
  it("keeps a finished run's report for a day unless dismissed, and never a live one", () => {
    const run = finishedRun();
    assert.equal(reportVisible(run, S(50, 0), false), true);
    assert.equal(reportVisible(run, S(50, 0), true), false);
    assert.equal(reportVisible(run, S(45, 10) + 25 * 3_600_000, false), false);
    assert.equal(reportVisible(runningRun(), NOW, false), false);
  });
});

describe("the words", () => {
  it("says every state the way the rows do", () => {
    const words = (state: AgentVM["state"], extra: Partial<AgentVM> = {}) => stateSentence(mkAgent("judge:perf", state, extra));
    assert.equal(words("planned"), "Planned · not scheduled yet");
    assert.equal(words("scheduled"), "Queued · waiting for a slot");
    assert.equal(words("working", { runningMs: 242_000 }), "Working · started 4m ago");
    assert.equal(words("finishing", { silenceMs: 53_000 }), "Finishing · usage reported 53s ago");
    assert.equal(words("no-update", { silenceMs: 962_000 }), "No update for 16m 02s");
    assert.equal(words("waiting-on-you"), "Waiting for you");
    assert.equal(words("failed", { attempt: 2 }), "Failed · 2 attempts");
    assert.equal(words("skipped", { skippedBy: "you" }), "Skipped by you");
    assert.equal(words("skipped", { skippedBy: "run" }), "Stopped with the run");
    assert.equal(words("done", { attempt: 3 }), "Done · attempt 3");
    assert.equal(words("unknown"), "Outcome not reported");
    assert.equal(compactState(mkAgent("a", "working"), true).text, "Last known · working");
    assert.equal(compactState(mkAgent("a", "working", { pending: "retry", attempt: 2 })).text, "Retrying");
    assert.equal(runNeedLine({ kind: "approval", command: null, askedAt: S(39, 36), requestId: "ap1", phase: "Judge" }, NOW), "Asked 1m 40s ago, during Judge. Muse does not say which agent asked.");
    assert.equal(runNeedLine({ kind: "approval", command: null, askedAt: null, requestId: "ap1", phase: null }, NOW), "Muse does not say which agent asked.");
  });
});

describe("the announcer", () => {
  it("says the first thing at once, gathers what follows, and speaks once per ten seconds", () => {
    let now = 0;
    const timers: { fn: () => void; at: number }[] = [];
    const spoken: string[] = [];
    const queue = new AnnouncementQueue((textOut) => spoken.push(textOut), 10_000, {
      now: () => now,
      set: (fn, ms) => {
        const timer = { fn, at: now + ms };
        timers.push(timer);
        return timer;
      },
      clear: (handle) => {
        const index = timers.indexOf(handle as { fn: () => void; at: number });
        if (index >= 0) timers.splice(index, 1);
      },
    });
    const advance = (to: number) => {
      now = to;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at <= now) {
          timers.splice(timers.indexOf(timer), 1);
          timer.fn();
        }
      }
    };
    queue.push(["A request needs you."]);
    assert.deepEqual(spoken, ["A request needs you."]);
    advance(3000);
    queue.push(["design:conflict-ledger failed, attempt 2 of 2."]);
    advance(6000);
    queue.push(["Design phase finished, 3 of 3."]);
    assert.equal(spoken.length, 1, "nothing more inside the window");
    advance(10_000);
    assert.deepEqual(spoken, ["A request needs you.", "design:conflict-ledger failed, attempt 2 of 2. Design phase finished, 3 of 3."]);
    advance(25_000);
    queue.push(["All ten landed."]);
    assert.equal(spoken[2], "All ten landed.", "a quiet spell lets the next one out at once");
    queue.push([]);
    assert.equal(spoken.length, 3);
    queue.dispose();
  });
});

describe("the keyboard map", () => {
  it("resolves every key of SPEC §11 on the element that holds focus", () => {
    const key = (k: string, focus: Parameters<typeof resolveCardKey>[1], shift = false) => resolveCardKey({ key: k, shiftKey: shift }, focus);
    assert.deepEqual(key("Enter", { kind: "line" }), { type: "toggle" });
    assert.deepEqual(key(" ", { kind: "head" }), { type: "toggle" });
    assert.deepEqual(key("Enter", { kind: "seg" }), { type: "openPhase" });
    assert.deepEqual(key("Enter", { kind: "row" }), { type: "inspect" });
    assert.deepEqual(key(" ", { kind: "row" }), { type: "peek" });
    assert.deepEqual(key("j", { kind: "row" }), { type: "move", delta: 1 });
    assert.deepEqual(key("ArrowUp", { kind: "row" }), { type: "move", delta: -1 });
    assert.deepEqual(key("ArrowRight", { kind: "seg" }), { type: "segment", delta: 1 });
    assert.equal(key("ArrowRight", { kind: "row" }), null);
    assert.deepEqual(key("n", { kind: "row" }), { type: "attention", delta: 1 });
    assert.deepEqual(key("n", { kind: "row" }, true), { type: "attention", delta: -1 });
    assert.deepEqual(key("r", { kind: "row", state: "failed", agentKind: "workflow" }), { type: "retry" });
    assert.equal(key("r", { kind: "row", state: "working", agentKind: "workflow" }), null);
    assert.deepEqual(key("s", { kind: "row", state: "no-update", agentKind: "workflow" }), { type: "skip" });
    assert.equal(key("s", { kind: "row", state: "working", agentKind: "task" }), null);
    assert.deepEqual(key("x", { kind: "row", state: "working", agentKind: "task" }), { type: "stop" });
    assert.deepEqual(key("x", { kind: "head" }), { type: "stopRun" });
    assert.deepEqual(key("Escape", { kind: null }), { type: "escape" });
    assert.equal(resolveCardKey({ key: "j", ctrlKey: true }, { kind: "row" }), null, "modifiers belong to the app");
    assert.equal(key("q", { kind: "row" }), null);
  });
});

describe("agents by name", () => {
  it("finds the reference agents in the model's run", () => {
    const run = runningRun();
    assert.equal(agentNamed(run, "judge:perf").state, "no-update");
  });
});
