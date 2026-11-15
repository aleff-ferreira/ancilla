import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import { CrewCard, defaultOpenPhase, footMeta, footStats, headSub, phaseHeadText, reportVisible, withPendingRetries, type CrewCardProps } from "../src/components/crew/CrewCard.js";
import { AnnouncementQueue } from "../src/components/crew/CrewAnnouncer.js";
import { resolveCardKey } from "../src/components/crew/useCardKeys.js";
import { railCount } from "../src/components/crew/PhaseRail.js";
import { compactState, runNeedLine, stateSentence } from "../src/components/crew/cardCopy.js";
import { pendingKey, summaryLine, type AgentVM, type RunVM } from "../src/model/crew.js";
import { APPROVAL, NOW, S, agentNamed, finishedRun, flatten, mkAgent, mkRun, mkTask, referenceAgents, runningRun, textOf as text } from "./fixtures/lantern.js";

const dummyCallback = () => {};

function renderCard(customConfig: Partial<CrewCardProps> & { run: RunVM | null }): string {
  const finalProps: CrewCardProps = {
    readOnly: false,
    selectedId: null,
    openPhase: null,
    expanded: false,
    sessionId: "s1",
    sinceYouLeft: null,
    tasks: [],
    completion: null,
    onReview: dummyCallback,
    onToggle: dummyCallback,
    onStopRun: dummyCallback,
    onInspect: dummyCallback,
    onAction: dummyCallback,
    onDismissReport: dummyCallback,
    onOpenPhase: dummyCallback,
    onDismissRecap: dummyCallback,
    onOpenPanel: dummyCallback,
    ...customConfig,
  };
  return renderToStaticMarkup(createElement(TooltipProvider, { children: createElement(CrewCard, finalProps) }));
}

function parseCardChips(html: string): string[] {
  const matches = [...flatten(html).matchAll(/class="crew-chip ([a-z-]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span class="lbl">([^<]*)<\/span>/g)];
  return matches.map((m) => `${m[1]}:${m[2]}`);
}

describe("CrewCard compact glance presentation and phase rail", () => {
  it("displays glyph, run name, progress summary, and elapsed time without extra chips during healthy runs", () => {
    const sanitizedAgents = referenceAgents().map((ag) => {
      if (ag.state === "failed") return { ...ag, state: "done" as const, attempt: 1, failure: null };
      if (ag.state === "no-update") return { ...ag, state: "working" as const, quiet: null };
      return ag;
    });
    const runInstance = mkRun(sanitizedAgents);
    const html = renderCard({ run: runInstance });

    assert.equal(summaryLine(runInstance).progress, "Judge · 7 of 10");
    assert.match(html, /aria-expanded="false"/);
    assert.deepEqual(parseCardChips(html), []);
    assert.match(html, /data-open="false"/);
    assert.match(html, /data-live="true"/);
    assert.match(html, /class="run-glyph work"[^>]*>[\s\S]{0,400}?class="pixel-loader/);

    const railSegments = html.match(/class="crew-strip rail"/g) ?? [];
    assert.equal(railSegments.length, 4);

    assert.match(text(html), /^offline-sync-research-design Judge · 7 of 10 41m 16s/);
    assert.match(html, /aria-label="offline-sync-research-design, Judge · 7 of 10, 41m 16s"/);
    assert.doesNotMatch(html, /class="run-body|class="run-foot/);
  });

  it("aligns progress indicator text with summaryLine model across all execution states", () => {
    const statuses = ["running", "finished", "finished-with-failures", "stopped", "failed"] as const;
    for (const st of statuses) {
      const candidateRun = mkRun(referenceAgents(), {
        status: st,
        endedAt: st === "running" ? null : S(45, 0),
      });
      const outputText = text(renderCard({ run: candidateRun }));
      const expectedProgress = summaryLine(candidateRun).progress.replace(/\s+/g, " ");
      assert.ok(outputText.includes(expectedProgress), `status ${st} should contain ${expectedProgress}`);
    }
  });
});

describe("CrewCard attention chips and anomaly indicators", () => {
  it("chips only items demanding user attention with strict prioritization", () => {
    const failedRun = mkRun(referenceAgents());
    assert.deepEqual(parseCardChips(renderCard({ run: failedRun })), ["fail:1 failed"]);

    const needsAttentionRun = mkRun(referenceAgents(), {
      runNeeds: [{ kind: "approval", command: "npm test -- --run conflict", askedAt: S(39, 36), requestId: "ap1", phase: "Judge" }],
    });
    assert.deepEqual(parseCardChips(renderCard({ run: needsAttentionRun })), ["need:1 needs you", "fail:1 failed"]);

    const quietRun = mkRun(referenceAgents().map((ag) => (ag.state === "failed" ? { ...ag, state: "done" as const, failure: null } : ag)));
    assert.deepEqual(parseCardChips(renderCard({ run: quietRun })), ["quiet:1 no update"]);

    const multiQueryRun = mkRun(referenceAgents(), {
      runNeeds: [
        { kind: "approval", command: "npm test", askedAt: S(39, 36), requestId: "ap1", phase: "Judge" },
        { kind: "input", command: "Which passkey provider should go first?", askedAt: S(40, 0), requestId: "q1", phase: "Judge" },
      ],
    });
    assert.deepEqual(parseCardChips(renderCard({ run: multiQueryRun })), ["need:2 need you", "fail:1 failed"]);
  });

  it("gracefully reflects partial plan knowledge, approximate timing, and stale feed states", () => {
    const knownAgents = referenceAgents().filter((ag) => ag.state !== "planned");
    const unknownPlanRun = mkRun(knownAgents, { plannedKnown: false });
    assert.match(text(renderCard({ run: unknownPlanRun })), /6 done · 2 working · more may start/);

    const approxHistoryRun = mkRun(referenceAgents(), { elapsedApprox: true, partialHistory: true });
    assert.match(text(renderCard({ run: approxHistoryRun })), /about 41m/);

    const staleRun = mkRun(referenceAgents(), { stale: true, staleAt: S(41, 16) });
    const staleHtml = renderCard({ run: staleRun, stale: true });
    assert.deepEqual(parseCardChips(staleHtml), ["stale:Last known"]);
    assert.doesNotMatch(staleHtml, /spin-ring|pixel-loader|data-live/);
    assert.match(staleHtml, /data-stale="true"/);
    assert.match(staleHtml, /class="crew-card run-card @container enter-up overflow-hidden rounded-xl bg-raised shadow-panel crew-stale"/);
    assert.match(text(staleHtml), /41m 16s · at /);
  });
});

describe("CrewCard terminal execution outcomes and task rendering", () => {
  it("handles diverse termination outcomes including completions, skips, cancellations, and failures", () => {
    const successRun = mkRun(
      referenceAgents().map((ag) => ({ ...ag, state: "done" as const, failure: null, quiet: null })),
      { status: "finished", endedAt: S(45, 10), elapsedMs: S(45, 10) - S(0, 0) },
    );
    const successHtml = renderCard({ run: successRun });
    assert.match(text(successHtml), /Done · 10 of 10 45m 10s/);
    assert.match(successHtml, /class="crew-strip rail finale"/);
    assert.deepEqual(parseCardChips(successHtml), []);

    const skippedRun = mkRun(
      referenceAgents().map((ag) =>
        ag.name === "design:conflict-ledger"
          ? { ...ag, state: "skipped" as const, skippedBy: "you" as const }
          : { ...ag, state: "done" as const, quiet: null },
      ),
      { status: "finished-with-failures", endedAt: S(43, 2), elapsedMs: S(43, 2) - S(0, 0) },
    );
    assert.match(text(renderCard({ run: skippedRun })), /Finished · 9 of 10/);
    assert.deepEqual(parseCardChips(renderCard({ run: skippedRun })), ["quiet:1 skipped"]);

    const cancelledRun = mkRun(
      referenceAgents().slice(0, 9).map((ag, idx) =>
        idx < 4
          ? { ...ag, state: "done" as const }
          : { ...ag, state: "skipped" as const, skippedBy: "run" as const, quiet: null, failure: null },
      ),
      { status: "stopped", endedAt: S(12, 10), elapsedMs: 12 * 60_000 + 10_000 },
    );
    assert.match(text(renderCard({ run: cancelledRun })), /Stopped · 4 of 9 had landed/);
    assert.match(text(renderCard({ run: cancelledRun })), /5 skipped 12m 10s/);

    const failedRun = mkRun(referenceAgents(), { status: "failed", endedAt: S(3, 0) });
    assert.deepEqual(parseCardChips(renderCard({ run: failedRun })), ["fail:run failed", "fail:1 failed"]);

    const bootstrapRun = mkRun([], { status: "starting", elapsedMs: 4000 });
    const bootstrapHtml = renderCard({ run: bootstrapRun });
    assert.match(text(bootstrapHtml), /Starting · no agents scheduled yet 4s/);
    assert.doesNotMatch(bootstrapHtml, /crew-strip/);
  });

  it("renders background tasks with command, tail output, elapsed time, and cancellation controls", () => {
    const liveTask = mkTask("npm run test:e2e -- --grep sync", "working");
    const liveTaskHtml = renderCard({ run: null, tasks: [liveTask] });

    assert.match(liveTaskHtml, /class="cmd">npm run test:e2e -- --grep sync</);
    assert.match(liveTaskHtml, /class="tail">12 passed · 3 pending · running/);
    assert.match(liveTaskHtml, /aria-label="Stop npm run test:e2e -- --grep sync"/);
    assert.match(text(liveTaskHtml), /1m 23s/);

    const silentTask = mkTask("npm run test:e2e -- --grep sync", "no-update", { silenceMs: 250_000 });
    assert.match(text(renderCard({ run: null, tasks: [silentTask] })), /No output for 4m 10s/);

    const endedTask = mkTask("npm run docs:build", "done");
    const endedHtml = renderCard({ run: null, tasks: [endedTask] });
    assert.match(endedHtml, /class="tail ok">finished · no failure reported</);
    assert.doesNotMatch(endedHtml, /aria-label="Stop /);

    const failedTask = mkTask("pnpm vitest run packages/sync", "failed", { failure: { text: "tool_error", at: S(44, 44) } });
    assert.match(renderCard({ run: null, tasks: [failedTask] }), /class="tail fail">failed · tool_error</);
    assert.doesNotMatch(renderCard({ run: null, tasks: [liveTask], readOnly: true }), /aria-label="Stop /);
  });

  it("folds additional items beyond limit into +N badge with runs prioritized over tasks", () => {
    const mainRun = mkRun(referenceAgents());
    const priorRun = mkRun(
      referenceAgents().map((ag) => ({ ...ag, state: "done" as const, failure: null, quiet: null })),
      { itemId: "wf-0", name: "earlier-run", status: "finished", endedAt: S(20, 0) },
    );
    const taskList = [
      mkTask("npm run a", "working", { id: "t1" }),
      mkTask("npm run b", "working", { id: "t2" }),
      mkTask("npm run c", "working", { id: "t3" }),
    ];

    const collapsedHtml = renderCard({ run: mainRun, otherRuns: [priorRun], tasks: taskList });
    const displayedNames = [...collapsedHtml.matchAll(/class="name">([^<]*)<|class="cmd">([^<]*)</g)].map((m) => m[1] ?? m[2]);
    assert.deepEqual(displayedNames, ["earlier-run", "npm run a", "npm run b"]);
    assert.match(collapsedHtml, /run-title/);
    assert.match(text(collapsedHtml), /\+1 more/);

    const expandedHtml = renderCard({ run: mainRun, otherRuns: [priorRun], tasks: taskList, expanded: true });
    assert.doesNotMatch(expandedHtml, /class="crew-line task"/);
    assert.match(expandedHtml, /Background <span class="n">3<\/span>/);
  });
});

describe("CrewCard expanded mode layout, phase tabs, and attention list", () => {
  const activeRunWithApproval = runningRun({}, [APPROVAL]);

  it("renders expanded card shell, tooltip telemetry metadata, and container hooks", () => {
    const html = renderCard({ run: activeRunWithApproval, expanded: true });

    assert.match(html, /<span class="run-glyph need"/);
    assert.match(renderCard({ run: runningRun(), expanded: true }), /<span class="run-glyph work"[^>]*>[\s\S]{0,400}?class="pixel-loader/);
    assert.doesNotMatch(html, /data-live/);
    assert.match(html, /title="offline-sync-research-design"[^>]*>offline-sync-research-design</);

    const subText = headSub(activeRunWithApproval).text;
    assert.match(subText, /^Workflow · started [^·]+ · 9 agents · 1 planned · 1\.2M tokens so far \(8 of 9 reported\) · ~\$[\d.]+ est\.$/);
    assert.ok(html.includes(`class="stats" title="${subText}"`));
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /data-open="true"/);
    assert.doesNotMatch(html, /crew-tile|class="crew-head"/);

    assert.match(html, /<section aria-label="Agents and tasks" data-crew-card="s1" data-open="true"( data-wait="true")? class="crew-card run-card @container/);
    for (const hook of ['class="run-sub"', 'class="crew-el run-el-sub"', 'class="lbl"', 'class="crew-body run-body"', 'class="run-foot"']) {
      assert.ok(html.includes(hook), `must contain hook: ${hook}`);
    }
    assert.doesNotMatch(html, /aria-live|role="status"/);
    assert.match(renderCard({ run: activeRunWithApproval, expanded: true, compact: true }), /class="crew-body run-body compact"/);
  });

  it("configures phase rail segments as interactive tabs with default phase selection", () => {
    const html = renderCard({ run: activeRunWithApproval, expanded: true, openPhase: defaultOpenPhase(activeRunWithApproval) });

    assert.equal(defaultOpenPhase(activeRunWithApproval), "Judge");
    const tabs = [...html.matchAll(/role="tab" aria-selected="(true|false)"[^>]*aria-label="([^"]*)"/g)].map((m) => [m[1], m[2]]);
    assert.equal(tabs.length, 4);
    assert.deepEqual(tabs[0], ["false", "Research, 4 of 4 done"]);
    assert.deepEqual(tabs[1], ["false", "Design, 2 of 3 done"]);
    assert.deepEqual(tabs[2], ["true", "Judge, 0 of 2 done"]);
    assert.deepEqual(tabs[3], ["false", "Synthesize, 1 planned"]);

    const openSegments = html.match(/class="crew-seg [^"]*open"/g) ?? [];
    assert.equal(openSegments.length, 1);
    assert.equal((html.match(/class="crew-strip rail"/g) ?? []).length, 4);
    assert.equal(railCount(activeRunWithApproval.phases[1] as RunVM["phases"][number], true), "2 of 3 · 1 failed");

    const fullyListedRun = mkRun(
      referenceAgents().map((ag) =>
        ag.name === "judge:correctness"
          ? { ...ag, state: "no-update" as const, silenceMs: 900_000, quiet: { thresholdMs: 760_000, longestFinishedMs: 760_000 } }
          : ag,
      ),
    );
    assert.equal(defaultOpenPhase(fullyListedRun), null);
  });

  it("prioritizes attention rows: user confirmation requests, failed agents, and quiet warnings", () => {
    const html = renderCard({ run: activeRunWithApproval, expanded: true, openPhase: "Judge" });
    const attentionRows = [...flatten(html).matchAll(/class="crew-att( run)?"[^>]*aria-label="([^"]*)"/g)].map((m) => m[2]);

    assert.equal(attentionRows.length, 3);
    assert.match(attentionRows[0] as string, /^Waiting for you: Muse wants to run npm test -- --run conflict\. Asked 1m 40s ago, during Judge\. Muse does not say which agent asked\./);
    assert.match(attentionRows[1] as string, /^design:conflict-ledger, Failed · 2 attempts\. Muse has not reported a reason yet\. The run's report may explain it when it finishes\./);
    assert.match(attentionRows[2] as string, /^judge:perf, No update for 16m 02s\. Longer than any finished agent \(12m 40s\)\. Muse does not report what it is doing\./);

    assert.match(html, /Needs attention <span class="n">3<\/span>/);
    assert.match(html, /class="chipm">npm test -- --run conflict</);
    assert.match(html, /aria-label="Review the request"/);
    assert.match(html, /aria-label="Retry design:conflict-ledger"/);
    assert.match(html, /aria-label="Skip design:conflict-ledger"/);
    assert.match(html, /aria-label="Stop judge:perf"/);

    assert.match(text(html), /Failed after 2 attempts · 3m 51s/);
    assert.match(text(html), /No update for 16m 02s · since it started/);
    assert.doesNotMatch(html, /stalled|stuck|hung/i);
  });

  it("tracks pending retry and stop operations until remote agent host confirmation", () => {
    const flags = {
      [pendingKey("s1", "c-cf", 2)]: "retry" as const,
      [pendingKey("s1", "c-jp", 1)]: "stop" as const,
    };
    const pendingRun = withPendingRetries(runningRun({ pending: flags }), "s1", flags);
    assert.equal(agentNamed(pendingRun, "design:conflict-ledger").pending, "retry");

    const neutralRun = runningRun();
    assert.equal(withPendingRetries(neutralRun, "s1", {}), neutralRun);

    const pendingText = text(renderCard({ run: pendingRun, expanded: true }));
    assert.match(pendingText, /Retrying · attempt 3 starting Muse has not confirmed yet\./);
    assert.match(pendingText, /Stopping… · ran 16m 02s Muse has not confirmed yet\./);
    assert.doesNotMatch(renderCard({ run: pendingRun, expanded: true }), /aria-label="Retry design:conflict-ledger"/);
  });

  it("renders phase agent roster rows with token consumption and proportional duration bars", () => {
    assert.equal(phaseHeadText(activeRunWithApproval, "Judge"), "2 agents · 0 done · 1 listed above · 138k");
    assert.equal(phaseHeadText(activeRunWithApproval, "Design"), "3 agents · 2 done · 1 failed · 1 listed above · 12m 40s · 445k");

    const designHtml = renderCard({ run: activeRunWithApproval, expanded: true, openPhase: "Design" });
    const rowLabels = [...flatten(designHtml).matchAll(/class="crew-ag"[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(rowLabels, ["design:crdt-ledger, Done, 226k tokens, 12m 40s", "design:op-log, Done, 160k tokens, 9m 12s"]);

    assert.match(designHtml, /class="crew-share" aria-hidden="true"><span class="" style="width:100%">/);
    assert.match(designHtml, /Design <span class="n">3 agents · 2 done · 1 failed · 1 listed above · 12m 40s · 445k<\/span>/);

    const judgeHtml = renderCard({ run: activeRunWithApproval, expanded: true, openPhase: "Judge" });
    assert.match(text(judgeHtml), /judge:correctness Finishing · usage reported 53s ago/);
    assert.match(judgeHtml, /class="crew-share" aria-hidden="true"><span class="work" style="width:100%"><\/span><span class="over"/);
  });

  it("renders background task rows in expanded view and provides output review hooks", () => {
    const backgroundTask = mkTask("npm run test:e2e -- --grep sync", "working");
    const taskHtml = renderCard({ run: activeRunWithApproval, expanded: true, tasks: [backgroundTask] });

    assert.match(taskHtml, /Background <span class="n">1<\/span>/);
    assert.match(text(taskHtml), /npm run test:e2e -- --grep sync You sent it to the background 12 passed · 3 pending · running "merges concurrent edits" 1m 23s Stop/);

    const timedOutTask = mkTask("npm run docs:build", "no-update", { silenceMs: 250_000 }, { initiator: "timeout", tail: "RUN v2.1.0 packages/sync/merge.test.ts" });
    assert.match(text(renderCard({ run: null, tasks: [timedOutTask], expanded: true })), /Muse backgrounded it after a timeout No output for 4m 10s RUN v2\.1\.0/);

    const errorTask = mkTask("pnpm vitest run packages/sync", "failed", { failure: { text: "tool_error", at: S(44, 44) } });
    const errorHtml = renderCard({ run: null, tasks: [errorTask], expanded: true, outputOf: () => "FAIL merge.test.ts" });
    assert.match(errorHtml, /class="out fail">failed · tool_error</);
    assert.match(errorHtml, />Output</);
    assert.match(errorHtml, /Run again<\/span><\/button>/);
    assert.match(errorHtml, /disabled=""[^>]*aria-label="Run pnpm vitest run packages\/sync again"/);
  });

  it("renders card footer controls including timeline link, aggregate counters, and stop button", () => {
    const html = renderCard({ run: activeRunWithApproval, expanded: true });
    assert.equal(footMeta(activeRunWithApproval), "6 done · 1 failed · 2 running · 1 planned");
    assert.equal(footStats(activeRunWithApproval), "6 done · 1 failed · 2 running · 1 planned");
    assert.match(text(html), /All 10 agents Timeline 6 done · 1 failed · 2 running · 1 planned Stop/);

    assert.match(html, /<span class="lbl">Stop<\/span>/);
    assert.doesNotMatch(renderCard({ run: activeRunWithApproval, expanded: true, readOnly: true }), /<span class="lbl">Stop<\/span>/);

    const finishedWithFailures = mkRun(referenceAgents(), { status: "finished-with-failures", endedAt: S(45, 0) });
    assert.doesNotMatch(renderCard({ run: finishedWithFailures, expanded: true }), /<span class="lbl">Stop<\/span>/);
  });

  it("freezes interactive actions and reflects last-known timestamp when feed disconnects", () => {
    const frozenRun = runningRun({ stale: true, staleAt: S(41, 16) });
    const frozenHtml = renderCard({ run: frozenRun, expanded: true, stale: true, openPhase: "Judge" });

    assert.doesNotMatch(frozenHtml, /spin-ring|pixel-loader/);
    assert.doesNotMatch(frozenHtml, /Needs attention/);
    assert.match(text(frozenHtml), /Last known at [^·]+ · Muse is not reachable, nothing has been lost/);
    assert.doesNotMatch(frozenHtml, /aria-label="Stop judge:perf"|<span class="lbl">Stop<\/span>/);
    assert.match(text(frozenHtml), /judge:perf Last known · working/);
  });

  it("mounts SinceYouLeft summary badge above card and renders head-less container for tasks only", () => {
    const recapPayload = { leftAt: S(31, 0), finished: 3, failed: 0, phasesStarted: ["Synthesize"], runFinishedAt: S(47, 0) };
    const recapHtml = renderCard({ run: activeRunWithApproval, expanded: true, sinceYouLeft: recapPayload });
    assert.match(text(recapHtml), /Since you left at [^·]+ · 3 agents finished, Synthesize ran, the run finished at /);
    assert.match(recapHtml, /aria-label="Dismiss the recap"/);

    const taskOnlyHtml = renderCard({ run: null, tasks: [mkTask("npm run a", "working")], expanded: true });
    assert.doesNotMatch(taskOnlyHtml, /crew-head|crew-rail/);
    assert.match(taskOnlyHtml, /Background <span class="n">1<\/span>/);
  });

  it("controls completion report presentation eligibility in the dock", () => {
    const finishedItem = finishedRun();
    assert.equal(reportVisible(finishedItem, S(50, 0), false), true);
    assert.equal(reportVisible(finishedItem, S(50, 0), true), false);
    assert.equal(reportVisible(finishedItem, S(45, 10) + 25 * 3_600_000, false), false);
    assert.equal(reportVisible(runningRun(), NOW, false), false);
  });
});

describe("CrewCard state sentences, announcement queue, and keyboard navigation", () => {
  it("translates agent lifecycle states into localized sentence descriptions", () => {
    const describeState = (st: AgentVM["state"], extraFields: Partial<AgentVM> = {}) =>
      stateSentence(mkAgent("judge:perf", st, extraFields));

    assert.equal(describeState("planned"), "Planned · not scheduled yet");
    assert.equal(describeState("scheduled"), "Queued · waiting for a slot");
    assert.equal(describeState("working", { runningMs: 242_000 }), "Working · started 4m ago");
    assert.equal(describeState("finishing", { silenceMs: 53_000 }), "Finishing · usage reported 53s ago");
    assert.equal(describeState("no-update", { silenceMs: 962_000 }), "No update for 16m 02s");
    assert.equal(describeState("waiting-on-you"), "Waiting for you");
    assert.equal(describeState("failed", { attempt: 2 }), "Failed · 2 attempts");
    assert.equal(describeState("skipped", { skippedBy: "you" }), "Skipped by you");
    assert.equal(describeState("skipped", { skippedBy: "run" }), "Stopped with the run");
    assert.equal(describeState("done", { attempt: 3 }), "Done · attempt 3");
    assert.equal(describeState("unknown"), "Outcome not reported");

    assert.equal(compactState(mkAgent("a", "working"), true).text, "Last known · working");
    assert.equal(compactState(mkAgent("a", "working", { pending: "retry", attempt: 2 })).text, "Retrying");

    assert.equal(
      runNeedLine({ kind: "approval", command: null, askedAt: S(39, 36), requestId: "ap1", phase: "Judge" }, NOW),
      "Asked 1m 40s ago, during Judge. Muse does not say which agent asked.",
    );
    assert.equal(
      runNeedLine({ kind: "approval", command: null, askedAt: null, requestId: "ap1", phase: null }, NOW),
      "Muse does not say which agent asked.",
    );
  });

  it("throttles assistive announcements to 10-second intervals and flushes queued notices", () => {
    let mockClock = 0;
    const activeTimers: { fn: () => void; at: number }[] = [];
    const speechLog: string[] = [];

    const announcer = new AnnouncementQueue((msg) => speechLog.push(msg), 10_000, {
      now: () => mockClock,
      set: (callback, delayMs) => {
        const handle = { fn: callback, at: mockClock + delayMs };
        activeTimers.push(handle);
        return handle;
      },
      clear: (handle) => {
        const found = activeTimers.indexOf(handle as { fn: () => void; at: number });
        if (found >= 0) activeTimers.splice(found, 1);
      },
    });

    const stepTime = (targetTimestamp: number) => {
      mockClock = targetTimestamp;
      for (const t of [...activeTimers].sort((a, b) => a.at - b.at)) {
        if (t.at <= mockClock) {
          activeTimers.splice(activeTimers.indexOf(t), 1);
          t.fn();
        }
      }
    };

    announcer.push(["A request needs you."]);
    assert.deepEqual(speechLog, ["A request needs you."]);

    stepTime(3000);
    announcer.push(["design:conflict-ledger failed, attempt 2 of 2."]);
    stepTime(6000);
    announcer.push(["Design phase finished, 3 of 3."]);
    assert.equal(speechLog.length, 1);

    stepTime(10_000);
    assert.deepEqual(speechLog, [
      "A request needs you.",
      "design:conflict-ledger failed, attempt 2 of 2. Design phase finished, 3 of 3.",
    ]);

    stepTime(25_000);
    announcer.push(["All ten landed."]);
    assert.equal(speechLog[2], "All ten landed.");

    announcer.push([]);
    assert.equal(speechLog.length, 3);
    announcer.dispose();
  });

  it("maps hotkeys according to SPEC §11 based on focused UI region", () => {
    const evalKey = (keyName: string, focusTarget: Parameters<typeof resolveCardKey>[1], hasShift = false) =>
      resolveCardKey({ key: keyName, shiftKey: hasShift }, focusTarget);

    assert.deepEqual(evalKey("Enter", { kind: "line" }), { type: "toggle" });
    assert.deepEqual(evalKey(" ", { kind: "head" }), { type: "toggle" });
    assert.deepEqual(evalKey("Enter", { kind: "seg" }), { type: "openPhase" });
    assert.deepEqual(evalKey("Enter", { kind: "row" }), { type: "inspect" });
    assert.deepEqual(evalKey(" ", { kind: "row" }), { type: "peek" });
    assert.deepEqual(evalKey("j", { kind: "row" }), { type: "move", delta: 1 });
    assert.deepEqual(evalKey("ArrowUp", { kind: "row" }), { type: "move", delta: -1 });
    assert.deepEqual(evalKey("ArrowRight", { kind: "seg" }), { type: "segment", delta: 1 });
    assert.equal(evalKey("ArrowRight", { kind: "row" }), null);
    assert.deepEqual(evalKey("n", { kind: "row" }), { type: "attention", delta: 1 });
    assert.deepEqual(evalKey("n", { kind: "row" }, true), { type: "attention", delta: -1 });

    assert.deepEqual(evalKey("r", { kind: "row", state: "failed", agentKind: "workflow" }), { type: "retry" });
    assert.equal(evalKey("r", { kind: "row", state: "working", agentKind: "workflow" }), null);
    assert.deepEqual(evalKey("s", { kind: "row", state: "no-update", agentKind: "workflow" }), { type: "skip" });
    assert.equal(evalKey("s", { kind: "row", state: "working", agentKind: "task" }), null);
    assert.deepEqual(evalKey("x", { kind: "row", state: "working", agentKind: "task" }), { type: "stop" });
    assert.deepEqual(evalKey("x", { kind: "head" }), { type: "stopRun" });
    assert.deepEqual(evalKey("Escape", { kind: null }), { type: "escape" });

    assert.equal(resolveCardKey({ key: "j", ctrlKey: true }, { kind: "row" }), null);
    assert.equal(evalKey("q", { kind: "row" }), null);
  });

  it("retrieves agent entities by identifier from composite run model", () => {
    const activeTestRun = runningRun();
    assert.equal(agentNamed(activeTestRun, "judge:perf").state, "no-update");
  });
});
