import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { Inspector, type InspectorProps } from "../src/components/crew/Inspector.js";
import {
  AT_RUN_END,
  NEAR_END,
  NOT_REPORTED,
  factsOf,
  lifecycleItems,
} from "../src/components/crew/InspectorSections.js";
import { withPending } from "../src/components/crew/panel.js";
import { crewView, pendingKey, type AgentVM, type RunVM } from "../src/model/crew.js";
import { applyEvents, emptyFold } from "../src/model/fold.js";
import type { MspItem, ViewEvent } from "../src/types.js";
import { S, lanternDone, lanternRun, panelStore, renderWith, textOf as extractPlainText } from "./crew-panel-fixture.js";

function findAgentByName(runData: RunVM, agentName: string): AgentVM {
  const match = runData.agents.find((candidate) => candidate.name === agentName);
  assert.ok(match, `Expected agent "${agentName}" to exist in run data`);
  return match;
}

function renderInspectorView(
  runData: RunVM,
  agentName: string,
  propOverrides: Partial<InspectorProps> = {},
): string {
  const targetAgent = findAgentByName(runData, agentName);
  const inspectorProps: InspectorProps = {
    run: runData,
    agent: targetAgent,
    tab: "overview",
    layout: "full",
    model: "muse-spark-1.3",
    readOnly: false,
    stale: false,
    confirm: null,
    hasPrevious: true,
    hasNext: true,
    onTab: () => undefined,
    onBack: () => undefined,
    onPrevious: () => undefined,
    onNext: () => undefined,
    onAction: () => undefined,
    onConfirm: () => undefined,
    ...propOverrides,
  };
  return renderWith(panelStore(), createElement(Inspector, inspectorProps));
}

function queryFactValue(renderedMarkup: string, factIdentifier: string): string {
  const regex = new RegExp(`data-fact="${factIdentifier}"><dt[^>]*>([^<]*)</dt><dd[^>]*>([^<]*)</dd>`);
  const match = regex.exec(renderedMarkup);
  assert.ok(match, `Expected fact "${factIdentifier}" to exist in markup`);
  return extractPlainText(match[2] as string);
}

describe("Inspector Component - Workflow Agent Inspection", () => {
  it("structures sections sequentially: identity, callout, tabs, activity, task, facts, comparison, honesty notice", () => {
    const html = renderInspectorView(lanternRun(), "design:conflict-ledger");
    const prose = extractPlainText(html);
    const expectedSequence = [
      "conflict-ledger",
      "Design · Workflow agent · attempt 2",
      "Failed · 2 attempts",
      "Failed on attempt 2 after 3m 51s",
      "Overview",
      "Lifecycle",
      "Result",
      "What happened",
      "Task",
      "from the workflow script",
      "Facts",
      "Compared with the run",
      "What Muse does not stream:",
    ];

    let cursorPosition = -1;
    for (const heading of expectedSequence) {
      const foundIdx = prose.indexOf(heading, cursorPosition + 1);
      assert.ok(foundIdx > cursorPosition, `Section "${heading}" should appear in expected order`);
      cursorPosition = foundIdx;
    }

    assert.match(html, /class="crew-sigil s36 fail"/);
    assert.match(html, /class="crew-badge fail"/);
    assert.match(html, /data-inspector="full"/);
    assert.doesNotMatch(html, /back to the run/);
  });

  it("articulates failure details and exposes retry and skip action buttons", () => {
    const html = renderInspectorView(lanternRun(), "design:conflict-ledger");
    assert.match(html, /data-callout="failed"/);
    const text = extractPlainText(html);
    assert.match(text, /Failed on attempt 2 after 3m 51s/);
    assert.match(
      text,
      /Muse has not reported a reason yet\. Workflow agents report reasons only in the run's final report, if at all\./,
    );
    assert.match(
      text,
      /Muse reported this at \d+:\d\d:\d\d\. Retry starts attempt 3 with the same task\. Skip lets the run go on without it\./,
    );
    assert.match(text, /Retry agent/);
    assert.match(text, /Skip and continue/);
    assert.match(text, /Design the conflict ledger: define how two devices reconcile\./);
  });

  it("presents confirmation prompt before skipping and suppresses mutating actions in read-only mode", () => {
    const activeRun = lanternRun();
    const agentId = findAgentByName(activeRun, "design:conflict-ledger").id;

    const confirmingHtml = extractPlainText(
      renderInspectorView(activeRun, "design:conflict-ledger", { confirm: { kind: "skip", id: agentId } }),
    );
    assert.match(confirmingHtml, /Skip design:conflict-ledger\? The run continues without it\. Skip Keep/);
    assert.doesNotMatch(confirmingHtml, /Retry agent/);

    const readOnlyHtml = extractPlainText(
      renderInspectorView(activeRun, "design:conflict-ledger", { readOnly: true }),
    );
    assert.doesNotMatch(readOnlyHtml, /Retry agent|Skip and continue/);
  });

  it("populates telemetry fact values across terminal, quiet, completed, and unreported agents", () => {
    const run = lanternRun();

    const failedMarkup = renderInspectorView(run, "design:conflict-ledger");
    assert.strictEqual(queryFactValue(failedMarkup, "status"), "Failed, terminal · the run went on without it");
    assert.strictEqual(queryFactValue(failedMarkup, "attempts"), "2 · 2m 08s + 3m 51s");
    assert.match(queryFactValue(failedMarkup, "started"), /^\d+:\d\d:\d\d · 14m 18s into the run$/);
    assert.strictEqual(queryFactValue(failedMarkup, "tokens"), "59k · in 52k · out 6.4k · incl. reasoning 5.7k");
    assert.strictEqual(queryFactValue(failedMarkup, "tool-calls"), AT_RUN_END);
    assert.strictEqual(
      queryFactValue(failedMarkup, "model"),
      "Not reported for workflow agents · the lead runs muse-spark-1.3",
    );
    assert.strictEqual(queryFactValue(failedMarkup, "result"), "None · this agent did not finish");
    assert.strictEqual(queryFactValue(failedMarkup, "child-id"), "c-cf");

    const quietMarkup = renderInspectorView(run, "judge:perf");
    assert.strictEqual(queryFactValue(quietMarkup, "status"), "Working · no update for 16m 02s");
    assert.strictEqual(queryFactValue(quietMarkup, "tokens"), NEAR_END);
    assert.strictEqual(queryFactValue(quietMarkup, "longest"), "design:crdt-ledger · 12m 40s");
    assert.strictEqual(queryFactValue(quietMarkup, "result"), AT_RUN_END);

    const doneMarkup = renderInspectorView(run, "research:field-notes");
    assert.strictEqual(queryFactValue(doneMarkup, "status"), "Done · 12m 00s");
    assert.strictEqual(queryFactValue(doneMarkup, "result"), "Not shared · the run's report cites it");
    assert.match(queryFactValue(doneMarkup, "ended"), /^\d+:\d\d:\d\d$/);

    const finishedRun = lanternRun(S(46, 0), [], lanternDone());
    assert.strictEqual(queryFactValue(renderInspectorView(finishedRun, "research:field-notes"), "tool-calls"), "41");
    assert.strictEqual(queryFactValue(renderInspectorView(finishedRun, "judge:perf"), "tool-calls"), NOT_REPORTED);

    const unprovidedTokens = factsOf(
      { ...findAgentByName(finishedRun, "judge:perf"), tokens: null },
      finishedRun,
      null,
    ).find((item) => item.key === "tokens");
    assert.deepStrictEqual(unprovidedTokens, {
      key: "tokens",
      label: "Tokens",
      value: NOT_REPORTED,
      nr: true,
    });
    assert.doesNotMatch(renderInspectorView(run, "judge:perf"), /<dd[^>]*><\/dd>/);
  });

  it("contextualizes quiet agent silence against longest peer with stop and keep waiting actions", () => {
    const html = renderInspectorView(lanternRun(), "judge:perf");
    assert.match(html, /data-callout="no-update"/);
    const text = extractPlainText(html);
    assert.match(text, /No update for 16m 02s/);
    assert.match(
      text,
      /Running for 16m 02s, longer than any finished agent \(12m 40s\)\. Muse does not report what a workflow agent is doing between its start and its result, so this is a fact, not a verdict\./,
    );
    assert.match(text, /Stop agent/);
    assert.doesNotMatch(text, /stalled|hung|stuck/i);
    assert.match(text, /Keep waiting/);
    assert.ok(
      text.includes("No revision from Muse since Muse only reports lifecycle changes for workflow agents now"),
    );
  });

  it("suppresses callouts for healthy agents and reports factual metrics for active execution", () => {
    const baselineRun = lanternRun();
    const finishingHtml = renderInspectorView(baselineRun, "judge:correctness");
    assert.doesNotMatch(finishingHtml, /data-callout/);
    assert.match(extractPlainText(finishingHtml), /Finishing/);
    assert.strictEqual(queryFactValue(finishingHtml, "status"), "Finishing · usage reported, completion follows");

    const earlyRun = lanternRun(S(3, 0));
    const workingHtml = renderInspectorView(earlyRun, "research:field-notes");
    assert.doesNotMatch(workingHtml, /data-callout/);
    assert.strictEqual(
      queryFactValue(workingHtml, "status"),
      "Working · running 2m 54s · no update since it started · no agent has finished yet",
    );
    assert.strictEqual(queryFactValue(workingHtml, "longest"), "None yet · no agent has finished");
  });

  it("displays task prompt for planned agents and identifies unscheduled status", () => {
    const html = renderInspectorView(lanternRun(), "synthesize:report");
    const prose = extractPlainText(html);
    assert.match(prose, /Synthesize · Workflow agent/);
    assert.doesNotMatch(prose, /attempt/);
    assert.match(prose, /Planned · not scheduled yet/);
    assert.match(prose, /Planned In the workflow script, not scheduled yet/);
    assert.match(prose, /Write the report\./);
    assert.strictEqual(queryFactValue(html, "result"), "None yet · not scheduled");
    assert.doesNotMatch(html, /data-fact="attempts"/);
  });

  it("indicates pending retry operation prior to backend confirmation", () => {
    const activeWithRetry = withPending(lanternRun(), "s1", {
      [pendingKey("s1", "c-cf", 2)]: "retry",
    });
    assert.strictEqual(
      findAgentByName(activeWithRetry, "design:conflict-ledger").pending,
      "retry",
    );
    const prose = extractPlainText(renderInspectorView(activeWithRetry, "design:conflict-ledger"));
    assert.match(prose, /Retrying · attempt 3 starting/);
    assert.match(prose, /Muse has not confirmed yet\./);
    assert.doesNotMatch(prose, /Retry agent/);
  });

  it("aggregates lifecycle history across attempts and describes result availability", () => {
    const currentRun = lanternRun();
    const historySteps = lifecycleItems(findAgentByName(currentRun, "design:conflict-ledger"), currentRun);
    assert.deepStrictEqual(
      historySteps.map((step) => [step.attempt, step.title]),
      [
        [1, "Scheduled"],
        [1, "Attempt 1 started"],
        [1, "Attempt 1 failed after 2m 08s"],
        [2, "Attempt 2 scheduled"],
        [2, "Attempt 2 started"],
        [2, "Usage reported"],
        [2, "Attempt 2 failed after 3m 51s"],
      ],
    );
    assert.strictEqual(historySteps[0]!.sub, "Design phase, with 2 other agents");
    assert.strictEqual(historySteps[2]!.sub, "Retried as attempt 2");
    assert.strictEqual(historySteps[6]!.sub, "Muse has not reported a reason yet");

    const overviewHtml = renderInspectorView(currentRun, "design:conflict-ledger");
    assert.match(overviewHtml, /data-tab="lifecycle"[^>]*>Lifecycle<span[^>]*>7<\/span>/);

    const lifecycleProse = extractPlainText(
      renderInspectorView(currentRun, "design:conflict-ledger", { tab: "lifecycle" }),
    );
    assert.match(lifecycleProse, /Attempt 1 failed .* Attempt 2 failed/);
    assert.doesNotMatch(lifecycleProse, /Facts/);

    const resultProse = extractPlainText(
      renderInspectorView(currentRun, "design:conflict-ledger", { tab: "result" }),
    );
    assert.match(resultProse, /Muse does not share a workflow agent's result\. The run's report cites it\./);
    assert.doesNotMatch(resultProse, /The run's report is in the transcript/);

    const completedRun = lanternRun(S(46, 0), [], lanternDone());
    assert.match(
      extractPlainText(renderInspectorView(completedRun, "research:field-notes", { tab: "result" })),
      /The run's report is in the transcript\./,
    );
  });

  it("benchmarks duration and token usage against run extremes", () => {
    const run = lanternRun();
    const failedHtml = renderInspectorView(run, "design:conflict-ledger");
    assert.match(failedHtml, /data-compare="time"[\s\S]*?3m 51s of 12m 40s longest/);
    assert.match(failedHtml, /data-compare="tokens"[\s\S]*?59k of 270k most/);

    const quietHtml = renderInspectorView(run, "judge:perf");
    assert.match(quietHtml, /data-compare="time"[\s\S]*?16m 02s · past the longest/);
    assert.doesNotMatch(quietHtml, /data-compare="tokens"/);
    assert.doesNotMatch(renderInspectorView(lanternRun(S(3, 0)), "research:field-notes"), /Compared with the run/);
  });

  it("renders in column layout with breadcrumbs, close trigger, and stepping navigation", () => {
    const columnHtml = renderInspectorView(lanternRun(), "judge:perf", { layout: "column", hasNext: false });
    assert.match(columnHtml, /data-inspector="column"/);
    assert.match(columnHtml, /class="[^"]*w-\[360px\]/);
    assert.match(columnHtml, /back to the run/);
    assert.match(columnHtml, /aria-label="Previous agent"/);
    assert.match(columnHtml, /aria-label="Next agent"[^>]*disabled=""/);
    assert.match(columnHtml, /aria-label="Close the inspector"/);
  });

  it("formats background task facts cleanly without workflow-specific jargon", () => {
    const taskFacts = factsOf(
      {
        id: "task-1",
        attempt: 1,
        name: "npm run docs:build",
        label: "npm run docs:build",
        display: { prefix: null, short: "npm run docs:build" },
        phase: "Background",
        kind: "task",
        state: "working",
        pending: null,
        skippedBy: null,
        startedAt: S(30, 0),
        endedAt: null,
        lastEventAt: S(30, 0),
        silenceMs: 60_000,
        runningMs: 60_000,
        durationMs: null,
        approx: false,
        tokens: null,
        toolCalls: null,
        attempts: [],
        failure: null,
        task: null,
        shareOfLongest: null,
        quiet: null,
        needs: null,
        runItemId: null,
        workflowRunId: null,
        taskInfo: {
          command: "npm run docs:build",
          tail: "built 12 pages",
          lastOutputAt: S(30, 30),
          initiator: "user",
          approvalId: null,
        },
      },
      null,
      null,
    );

    assert.deepStrictEqual(
      taskFacts.map((factItem) => [factItem.key, factItem.value]),
      [
        ["status", "Running · 1m 00s"],
        ["command", "npm run docs:build"],
        ["initiator", "You"],
        [
          "started",
          `${new Date(S(30, 0)).getHours()}:${String(new Date(S(30, 0)).getMinutes()).padStart(2, "0")}:00`,
        ],
        [
          "output",
          `${new Date(S(30, 30)).getHours()}:${String(new Date(S(30, 30)).getMinutes()).padStart(2, "0")}:30`,
        ],
        ["tokens", "Not reported for background tasks"],
        ["exit", "Not finished"],
      ],
    );
  });
});

const EPOCH_BASE = Date.UTC(2026, 8, 28, 12);
const INITIATE_TURN: ViewEvent = {
  method: "turn/started",
  at: EPOCH_BASE,
  params: { turnId: "turn-1" },
};
const SAMPLE_TOOL_ITEM: MspItem = {
  itemId: "tool",
  kind: "toolCall",
  tool: "bash",
  args: '{"command":"npm run check"}',
  turnId: "turn-1",
  revision: 1,
  status: "inProgress",
};

function buildPromptRun(toolItemOverrides?: Partial<MspItem>, extraEventsList: ViewEvent[] = []): RunVM {
  const eventStream: ViewEvent[] = [INITIATE_TURN];
  if (toolItemOverrides) {
    eventStream.push({
      method: "item/updated",
      at: EPOCH_BASE + 1_000,
      params: { item: { ...SAMPLE_TOOL_ITEM, ...toolItemOverrides } },
    });
  }
  eventStream.push(...extraEventsList);

  const resolvedRuns = crewView(applyEvents(emptyFold(), eventStream), null, EPOCH_BASE + 3_000).runs;
  const turnRun = resolvedRuns.find((r) => r.kind === "turn");
  assert.ok(turnRun, "Expected turn run to be present in crew view");
  return turnRun;
}

describe("Inspector Component - Ordinary Prompts & Tools", () => {
  it("displays lead agent model and transcript prompts without workflow or subagent attributes", () => {
    const run = buildPromptRun();
    const overview = renderInspectorView(run, "Muse");
    assert.strictEqual(queryFactValue(overview, "model"), "muse-spark-1.3");
    assert.strictEqual(queryFactValue(overview, "tool-calls"), "0");
    assert.strictEqual(queryFactValue(overview, "tokens"), "Not reported yet");

    const overviewProse = extractPlainText(overview);
    assert.match(overviewProse, /Lead agent/);
    assert.match(overviewProse, /Activity Working on your prompt/);
    assert.match(overviewProse, /What Muse reports: this turn's status, tool activity and usage/);
    assert.doesNotMatch(overviewProse, /workflow|subagent|background|objective Muse gave/i);

    const resultProse = extractPlainText(renderInspectorView(run, "Muse", { tab: "result" }));
    assert.match(resultProse, /Read the transcript for this turn's messages, response and tool results/);
    assert.doesNotMatch(resultProse, /workflow|run's report/i);

    assert.deepStrictEqual(
      factsOf(findAgentByName(run, "Muse"), run, null).find((entry) => entry.key === "model"),
      { key: "model", label: "Model", value: NOT_REPORTED, nr: true },
    );
  });

  it("preserves explicit zero values in token reporting without discarding them as absent", () => {
    const run = buildPromptRun();
    const leadWithZero = {
      ...findAgentByName(run, "Muse"),
      tokens: { inputTokens: 0, outputTokens: 0 },
    };
    const tokenFact = factsOf(leadWithZero, run, null).find((entry) => entry.key === "tokens");
    assert.strictEqual(tokenFact?.value, "0 · in 0 · out 0");
    assert.strictEqual(tokenFact?.nr, undefined);
  });

  it("identifies foreground tools accurately and acknowledges potential exit code reporting", () => {
    const run = buildPromptRun({});
    const toolHtml = renderInspectorView(run, "npm run check");
    const prose = extractPlainText(toolHtml);
    assert.match(prose, /Tools · Foreground tool/);
    assert.strictEqual(queryFactValue(toolHtml, "execution"), "Foreground");
    assert.strictEqual(queryFactValue(toolHtml, "tokens"), "Not reported for individual tools");
    assert.strictEqual(queryFactValue(toolHtml, "exit"), "Not finished");
    assert.match(prose, /Exit code or signal is shown when reported/);
    assert.doesNotMatch(prose, /background|workflow|Sent by|does not report an exit code/i);
    assert.strictEqual(lifecycleItems(findAgentByName(run, "npm run check"), run)[0]?.title, "Started");
  });

  it("displays exit code 0 and final output when process completes successfully", () => {
    const run = buildPromptRun({ status: "completed", exitCode: 0, visibleOutput: "Checks passed" });
    const targetAgent = findAgentByName(run, "npm run check");
    assert.strictEqual(targetAgent.taskInfo?.exitCode, 0);

    const html = renderInspectorView(run, targetAgent.name);
    assert.strictEqual(queryFactValue(html, "exit"), "0");
    assert.strictEqual(queryFactValue(html, "output"), "Time not reported");
    assert.match(extractPlainText(html), /Finished · exit code 0/);
    assert.match(
      extractPlainText(renderInspectorView(run, targetAgent.name, { tab: "result" })),
      /Checks passed/,
    );
    assert.doesNotMatch(extractPlainText(html), /No output yet|does not report an exit code/);
  });

  it("reflects failed exit status code or Unix termination signal accurately", () => {
    const errorRun = buildPromptRun({ status: "completed", exitCode: 7 });
    assert.strictEqual(queryFactValue(renderInspectorView(errorRun, "npm run check"), "exit"), "7");

    const signalRun = buildPromptRun({ status: "completed", exitSignal: 15 });
    const signalHtml = renderInspectorView(signalRun, "npm run check");
    assert.strictEqual(queryFactValue(signalHtml, "signal"), "15");
    assert.strictEqual(queryFactValue(signalHtml, "exit"), NOT_REPORTED);
    assert.match(extractPlainText(signalHtml), /Stopped by signal 15/);
    assert.doesNotMatch(extractPlainText(signalHtml), /no failure reported/);
  });

  it("preserves background terminology alongside reported process termination metrics", () => {
    const baseRun = buildPromptRun();
    const backgroundAgent: AgentVM = {
      ...findAgentByName(buildPromptRun({ status: "completed", exitCode: 0 }), "npm run check"),
      phase: "Background",
      taskInfo: {
        command: "npm run check",
        tail: "Finished",
        lastOutputAt: EPOCH_BASE + 2_000,
        initiator: "user",
        approvalId: null,
        background: true,
        exitCode: 0,
      },
    };
    const html = renderInspectorView(baseRun, "Muse", { agent: backgroundAgent });
    assert.strictEqual(queryFactValue(html, "tokens"), "Not reported for background tasks");
    assert.strictEqual(queryFactValue(html, "exit"), "0");
    assert.strictEqual(queryFactValue(html, "initiator"), "You");
    assert.match(extractPlainText(html), /What Muse reports for a background task/);
    assert.doesNotMatch(extractPlainText(html), /does not report an exit code/);
  });

  it("annotates indeterminate outcomes within lifecycle tracking and result views", () => {
    const completionEvent: ViewEvent = {
      method: "turn/completed",
      at: EPOCH_BASE + 2_000,
      params: { turnId: "turn-1", terminal: "unknown" },
    };
    const indeterminateRun = buildPromptRun({}, [completionEvent]);
    for (const agentRow of indeterminateRun.agents) {
      assert.strictEqual(agentRow.state, "unknown");
      assert.strictEqual(lifecycleItems(agentRow, indeterminateRun).at(-1)?.title, "Outcome not reported");
    }

    assert.match(
      extractPlainText(renderInspectorView(indeterminateRun, "Muse", { tab: "result" })),
      /The turn ended without a reported outcome/,
    );
    const inFlightStop = { ...findAgentByName(buildPromptRun(), "Muse"), pending: "stop" as const };
    assert.strictEqual(lifecycleItems(inFlightStop, null).at(-1)?.title, "Stopping…");
  });
});
