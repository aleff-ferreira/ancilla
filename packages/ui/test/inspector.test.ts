import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { Inspector, type InspectorProps } from "../src/components/swarm/Inspector.js";
import { AT_RUN_END, NEAR_END, NOT_REPORTED, factsOf, lifecycleItems } from "../src/components/swarm/InspectorSections.js";
import { withPending } from "../src/components/swarm/panel.js";
import { pendingKey, type AgentVM, type RunVM } from "../src/model/swarm.js";
import { S, lanternDone, lanternRun, panelStore, renderWith, textOf } from "./swarm-panel-fixture.js";

function agent(run: RunVM, name: string): AgentVM {
  const found = run.agents.find((candidate) => candidate.name === name);
  assert.ok(found, `no agent ${name}`);
  return found;
}

function render(run: RunVM, name: string, extra: Partial<InspectorProps> = {}): string {
  const props: InspectorProps = {
    run, agent: agent(run, name), tab: "overview", layout: "full", model: "muse-spark-1.3", readOnly: false, stale: false, confirm: null,
    hasPrevious: true, hasNext: true, onTab: () => undefined, onBack: () => undefined, onPrevious: () => undefined, onNext: () => undefined,
    onAction: () => undefined, onConfirm: () => undefined, ...extra,
  };
  return renderWith(panelStore(), createElement(Inspector, props));
}

function fact(markup: string, key: string): string {
  const match = new RegExp(`data-fact="${key}"><dt[^>]*>([^<]*)</dt><dd[^>]*>([^<]*)</dd>`).exec(markup);
  assert.ok(match, `no fact ${key}`);
  return textOf(match[2] as string);
}

describe("Inspector", () => {
  it("stacks identity, callout, tabs, what happened, task, facts, comparison and the honesty note, in that order", () => {
    const markup = render(lanternRun(), "design:conflict-ledger");
    const text = textOf(markup);
    const order = ["conflict-ledger", "Design · Workflow agent · attempt 2", "Failed · 2 attempts", "Failed on attempt 2 after 3m 51s", "Overview", "Lifecycle", "Result", "What happened", "Task", "from the workflow script", "Facts", "Compared with the run", "What Muse does not stream:"];
    let at = -1;
    for (const part of order) {
      const index = text.indexOf(part, at + 1);
      assert.ok(index > at, `${part} comes after the previous section`);
      at = index;
    }
    assert.match(markup, /class="swarm-sigil s36 fail"/, "a 36 px sigil with the failure badge");
    assert.match(markup, /class="swarm-badge fail"/);
    assert.match(markup, /data-inspector="full"/);
    assert.doesNotMatch(markup, /back to the run/, "the crumb is the panel head's when the inspector fills the panel");
  });

  it("explains a failure with the retry and skip copy and the two actions", () => {
    const markup = render(lanternRun(), "design:conflict-ledger");
    assert.match(markup, /data-callout="failed"/);
    const text = textOf(markup);
    assert.match(text, /Failed on attempt 2 after 3m 51s/);
    assert.match(text, /Muse has not reported a reason yet\. Workflow agents report reasons only in the run's final report, if at all\./);
    assert.match(text, /Muse reported this at \d+:\d\d:\d\d\. Retry starts attempt 3 with the same task\. Skip lets the run go on without it\./);
    assert.match(text, /Retry agent/);
    assert.match(text, /Skip and continue/);
    assert.match(text, /Design the conflict ledger: define how two devices reconcile\./);
  });

  it("asks before a skip, inline, and hides the actions from a read-only thread", () => {
    const run = lanternRun();
    const id = agent(run, "design:conflict-ledger").id;
    const asking = textOf(render(run, "design:conflict-ledger", { confirm: { kind: "skip", id } }));
    assert.match(asking, /Skip design:conflict-ledger\? The run continues without it\. Skip Keep/);
    assert.doesNotMatch(asking, /Retry agent/);
    const readOnly = textOf(render(run, "design:conflict-ledger", { readOnly: true }));
    assert.doesNotMatch(readOnly, /Retry agent|Skip and continue/);
  });

  it("keeps every fact filled: not reported, at run end, reported near the end", () => {
    const run = lanternRun();
    const failed = render(run, "design:conflict-ledger");
    assert.equal(fact(failed, "status"), "Failed, terminal · the run went on without it");
    assert.equal(fact(failed, "attempts"), "2 · 2m 08s + 3m 51s");
    assert.match(fact(failed, "started"), /^\d+:\d\d:\d\d · 14m 18s into the run$/, "the latest attempt's start");
    assert.equal(fact(failed, "tokens"), "64k · in 52k · out 6.4k · reasoning 5.7k");
    assert.equal(fact(failed, "tool-calls"), AT_RUN_END);
    assert.equal(fact(failed, "model"), "Not reported for workflow agents · the lead runs muse-spark-1.3");
    assert.equal(fact(failed, "result"), "None · this agent did not finish");
    assert.equal(fact(failed, "child-id"), "c-cf");
    const quiet = render(run, "judge:perf");
    assert.equal(fact(quiet, "status"), "Working · no update for 16m 02s");
    assert.equal(fact(quiet, "tokens"), NEAR_END);
    assert.equal(fact(quiet, "longest"), "design:crdt-ledger · 12m 40s");
    assert.equal(fact(quiet, "result"), AT_RUN_END);
    const done = render(run, "research:field-notes");
    assert.equal(fact(done, "status"), "Done · 12m 00s");
    assert.equal(fact(done, "result"), "Not shared · the run's report cites it");
    assert.match(fact(done, "ended"), /^\d+:\d\d:\d\d$/);
    const finished = lanternRun(S(46, 0), [], lanternDone());
    assert.equal(fact(render(finished, "research:field-notes"), "tool-calls"), "41", "reported with the run's reconciliation");
    assert.equal(fact(render(finished, "judge:perf"), "tool-calls"), NOT_REPORTED, "the run ended without a count for it");
    const unreported = factsOf({ ...agent(finished, "judge:perf"), tokens: null }, finished, null).find((f) => f.key === "tokens");
    assert.deepEqual(unreported, { key: "tokens", label: "Tokens", value: NOT_REPORTED, nr: true }, "a finished agent Muse sent no usage for");
    assert.doesNotMatch(render(run, "judge:perf"), /<dd[^>]*><\/dd>/, "no blank fact");
  });

  it("states a quiet agent's silence as a fact against the longest sibling, with Stop agent and Keep waiting", () => {
    const markup = render(lanternRun(), "judge:perf");
    assert.match(markup, /data-callout="no-update"/);
    const text = textOf(markup);
    assert.match(text, /No update for 16m 02s/);
    assert.match(text, /Running for 16m 02s, longer than any finished agent \(12m 40s\)\. Muse does not report what a workflow agent is doing between its start and its result, so this is a fact, not a verdict\./);
    assert.match(text, /Stop agent/);
    assert.match(text, /Keep waiting/);
    assert.doesNotMatch(text, /stalled|hung|stuck/i);
    assert.match(text, /No revision from Muse since Muse only reports lifecycle changes for workflow agents now/);
  });

  it("shows no callout for an agent that needs nothing, and a working one's facts say what is known", () => {
    const run = lanternRun();
    const finishing = render(run, "judge:correctness");
    assert.doesNotMatch(finishing, /data-callout/);
    assert.match(textOf(finishing), /Finishing/);
    assert.equal(fact(finishing, "status"), "Finishing · usage reported, completion follows");
    const early = lanternRun(S(3, 0));
    const working = render(early, "research:field-notes");
    assert.doesNotMatch(working, /data-callout/);
    assert.equal(fact(working, "status"), "Working · running 2m 54s · no update since it started · no agent has finished yet");
    assert.equal(fact(working, "longest"), "None yet · no agent has finished");
  });

  it("shows a planned agent's task from the script and says it is not scheduled", () => {
    const markup = render(lanternRun(), "synthesize:report");
    const text = textOf(markup);
    assert.match(text, /Synthesize · Workflow agent/);
    assert.doesNotMatch(text, /attempt/);
    assert.match(text, /Planned · not scheduled yet/);
    assert.match(text, /Planned In the workflow script, not scheduled yet/);
    assert.match(text, /Write the report\./);
    assert.equal(fact(markup, "result"), "None yet · not scheduled");
    assert.doesNotMatch(markup, /data-fact="attempts"/);
  });

  it("shows a pending retry as such until Muse confirms", () => {
    const run = withPending(lanternRun(), "s1", { [pendingKey("s1", "c-cf", 2)]: "retry" });
    assert.equal(agent(run, "design:conflict-ledger").pending, "retry", "the store's flag lands on the settled attempt the retry was sent against");
    const text = textOf(render(run, "design:conflict-ledger"));
    assert.match(text, /Retrying · attempt 3 starting/);
    assert.match(text, /Muse has not confirmed yet\./);
    assert.doesNotMatch(text, /Retry agent/);
  });

  it("counts the lifecycle steps on the tab, per attempt in the Lifecycle tab, and says what Result holds", () => {
    const run = lanternRun();
    const items = lifecycleItems(agent(run, "design:conflict-ledger"), run);
    assert.deepEqual(items.map((item) => [item.attempt, item.title]), [
      [1, "Scheduled"], [1, "Attempt 1 started"], [1, "Attempt 1 failed after 2m 08s"],
      [2, "Attempt 2 scheduled"], [2, "Attempt 2 started"], [2, "Usage reported"], [2, "Attempt 2 failed after 3m 51s"],
    ]);
    assert.equal(items[0]!.sub, "Design phase, with 2 other agents");
    assert.equal(items[2]!.sub, "Retried as attempt 2");
    assert.equal(items[6]!.sub, "Muse has not reported a reason yet");
    const overview = render(run, "design:conflict-ledger");
    assert.match(overview, /data-tab="lifecycle"[^>]*>Lifecycle<span[^>]*>7<\/span>/);
    const lifecycle = textOf(render(run, "design:conflict-ledger", { tab: "lifecycle" }));
    assert.match(lifecycle, /Attempt 1 failed .* Attempt 2 failed/);
    assert.doesNotMatch(lifecycle, /Facts/);
    const result = textOf(render(run, "design:conflict-ledger", { tab: "result" }));
    assert.match(result, /Muse does not share a workflow agent's result\. The run's report cites it\./);
    assert.doesNotMatch(result, /The run's report is in the transcript/);
    const finished = lanternRun(S(46, 0), [], lanternDone());
    assert.match(textOf(render(finished, "research:field-notes", { tab: "result" })), /The run's report is in the transcript\./);
  });

  it("compares the agent with the run's longest and its biggest token user", () => {
    const run = lanternRun();
    const failed = render(run, "design:conflict-ledger");
    assert.match(failed, /data-compare="time"[\s\S]*?3m 51s of 12m 40s longest/);
    assert.match(failed, /data-compare="tokens"[\s\S]*?64k of 288k most/);
    const quiet = render(run, "judge:perf");
    assert.match(quiet, /data-compare="time"[\s\S]*?16m 02s · past the longest/);
    assert.doesNotMatch(quiet, /data-compare="tokens"/, "nothing reported, nothing to compare");
    assert.doesNotMatch(render(lanternRun(S(3, 0)), "research:field-notes"), /Compared with the run/, "no finished agent yet, so no comparison");
  });

  it("opens as a column with its own crumb, stepping buttons and close beside a wide roster", () => {
    const markup = render(lanternRun(), "judge:perf", { layout: "column", hasNext: false });
    assert.match(markup, /data-inspector="column"/);
    assert.match(markup, /class="[^"]*w-\[360px\]/);
    assert.match(markup, /back to the run/);
    assert.match(markup, /aria-label="Previous agent"/);
    assert.match(markup, /aria-label="Next agent"[^>]*disabled=""/);
    assert.match(markup, /aria-label="Close the inspector"/);
  });

  it("fills the facts of a background task without a workflow's words", () => {
    const facts = factsOf({
      id: "task-1", attempt: 1, name: "npm run docs:build", label: "npm run docs:build", display: { prefix: null, short: "npm run docs:build" }, phase: "Background", kind: "task",
      state: "working", pending: null, skippedBy: null, startedAt: S(30, 0), endedAt: null, lastEventAt: S(30, 0), silenceMs: 60_000, runningMs: 60_000, durationMs: null, approx: false,
      tokens: null, toolCalls: null, attempts: [], failure: null, task: null, shareOfLongest: null, quiet: null, needs: null, runItemId: null, workflowRunId: null,
      taskInfo: { command: "npm run docs:build", tail: "built 12 pages", lastOutputAt: S(30, 30), initiator: "user", approvalId: null },
    }, null, null);
    assert.deepEqual(facts.map((f) => [f.key, f.value]), [
      ["status", "Running · 1m 00s"],
      ["command", "npm run docs:build"],
      ["initiator", "You"],
      ["started", `${new Date(S(30, 0)).getHours()}:${String(new Date(S(30, 0)).getMinutes()).padStart(2, "0")}:00`],
      ["output", `${new Date(S(30, 30)).getHours()}:${String(new Date(S(30, 30)).getMinutes()).padStart(2, "0")}:30`],
      ["tokens", "Not reported for background tasks"],
      ["exit", "Not reported for background tasks"],
    ]);
  });
});
