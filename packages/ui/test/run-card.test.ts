import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Hairline, PlanSteps, Spine, Trail } from "../src/components/crew/RunParts.js";
import { crewView, type RunVM } from "../src/model/crew.js";
import { applyEvents, emptyFold, type ThreadFold } from "../src/model/fold.js";
import {
  actionText,
  activeStep,
  attentionOf,
  callTime,
  chipsOf,
  endedCount,
  glyphOf,
  lastEnded,
  liveActions,
  oneLine,
  planMerges,
  recentActions,
  stepSegs,
  subAction,
  subText,
  titleOf,
  trailOf,
  type Seg,
} from "../src/model/runCard.js";
import { taskPlanView } from "../src/model/taskPlan.js";
import type { SessionSummary, ViewEvent } from "../src/types.js";

const T = Date.UTC(2026, 8, 28, 12);
const SESSION: SessionSummary = { sessionId: "thread", title: "Ordinary prompt", cwd: "/work", titleSource: "user", turnCount: 1, modelId: "muse", origin: "ancilla", archived: false, createdAt: new Date(T).toISOString(), activityAt: new Date(T).toISOString(), settled: false, settledAt: null, unsettledAt: null, sandboxDisabled: false, accountId: null, live: null };

const started: ViewEvent = { method: "turn/started", at: T, params: { turnId: "t1" } };
const ended = (terminal = "completed"): ViewEvent => ({ method: "turn/completed", at: T + 60_000, params: { turnId: "t1", terminal } });
function call(id: string, tool: string, args: Record<string, unknown>, at: number, patch: Record<string, unknown> = {}): ViewEvent {
  const status = (patch["status"] as string | undefined) ?? "inProgress";
  return { method: status === "inProgress" ? "item/started" : "item/completed", at, params: { item: { itemId: id, kind: "toolCall", tool, args: JSON.stringify(args), turnId: "t1", status, revision: status === "inProgress" ? 1 : 2, ...patch } } };
}
const plan = (items: unknown[], turnId = "t1"): ViewEvent => ({ method: "session/todoListChanged", at: T + 500, params: { items, turnId } });

function build(events: ViewEvent[], now = T + 10_000): { run: RunVM; fold: ThreadFold } {
  const fold = applyEvents(emptyFold(), events);
  const run = crewView(fold, SESSION, now).runs[0];
  if (!run) throw new Error("no run");
  return { run, fold };
}

const editing = call("e1", "edit_file", { path: "src/scene.ts" }, T + 1_000);
const finishedRead = [call("r1", "read_file", { path: "package.json" }, T + 1_000), call("r1", "read_file", { path: "package.json" }, T + 1_400, { status: "completed" })];

describe("the words of a prompt's card", () => {
  it("names the call going now when there is no plan, in the transcript's words", () => {
    const { run } = build([started, editing]);
    assert.deepEqual(titleOf(run, null), { text: "Editing src/scene.ts", source: "action" });
    assert.equal(actionText(liveActions(run)[0]!), "Editing src/scene.ts");
    assert.equal(subAction(run)?.live, true);
    const two = build([started, editing, call("e2", "bash", { command: "npm test" }, T + 2_000)]).run;
    assert.deepEqual(titleOf(two, null), { text: "2 actions running", source: "action" });
  });

  it("says the step Muse marked active when there is a plan, and the call beneath it", () => {
    const { run, fold } = build([started, plan([{ text: "Read the code", status: "completed" }, { text: "Build it", status: "in_progress", active_form: "Building it" }, { text: "Test it", status: "pending" }]), editing]);
    const view = taskPlanView(fold)!;
    assert.equal(activeStep(view), "Building it");
    assert.deepEqual(titleOf(run, view), { text: "Building it", source: "step" });
    assert.equal(actionText(subAction(run)!), "Editing src/scene.ts");
    assert.equal(subText(run, titleOf(run, view)), null, "the second line is the call, not a count");
    assert.equal(subText(run, titleOf(run, null)), null, "a single call has no count to say");
  });

  it("counts the calls when they are the title, and says what the run is doing when none is going", () => {
    const { run } = build([started, ...finishedRead, call("e1", "edit_file", { path: "a.ts" }, T + 2_000, { status: "completed" })]);
    assert.deepEqual(titleOf(run, null), { text: "Working on your prompt", source: "run" });
    assert.equal(subText(run, { text: "x", source: "action" }), "2 actions");
    assert.equal(lastEnded(run)?.verb, "Edited", "while the model thinks, the second line says what just ended, in the past tense");
  });

  it("puts a request waiting on you before everything else", () => {
    const approval: ViewEvent = { method: "approval/requested", at: T + 3_000, params: { approvalId: "a1", sessionId: "thread", turnId: "t1", subject: { kind: "shell", command: "rm -rf build" } } };
    const { run, fold } = build([started, plan([{ text: "Build it", status: "in_progress" }]), editing, approval]);
    assert.deepEqual(titleOf(run, taskPlanView(fold)), { text: "Waiting for your approval", source: "need" });
    assert.equal(glyphOf(run), "waiting");
  });

  it("gives a workflow or research run its own name and leaves the second line to the model's progress", () => {
    const { run } = build([started, editing]);
    const workflow = { ...run, kind: "workflow" as const, name: "audit-the-api" };
    assert.deepEqual(titleOf(workflow, null), { text: "audit-the-api", source: "run" });
    assert.equal(subAction(workflow), null);
    assert.match(subText(workflow, titleOf(workflow, null)) ?? "", /done|working|Starting/);
  });

  it("says how a prompt ended once it did", () => {
    const { run } = build([started, ...finishedRead, ended()], T + 70_000);
    assert.equal(titleOf(run, null).source, "end");
    assert.equal(glyphOf(run), "done");
    assert.equal(glyphOf(build([started, ended("failed")], T + 70_000).run), "failed");
    assert.equal(glyphOf(build([started, ended("cancelled")], T + 70_000).run), "stopped");
    assert.equal(glyphOf({ ...run, stale: true }), "stale");
  });
});

describe("the heartbeat", () => {
  it("is one tick per call, the newest last, each toned by where the call stands", () => {
    const failed = call("f1", "bash", { command: "npm test" }, T + 2_000);
    const failedEnd = call("f1", "bash", { command: "npm test" }, T + 3_000, { status: "failed", failureReason: "exited with 1", exitCode: 1 });
    const later = call("e1", "edit_file", { path: "src/scene.ts" }, T + 4_000);
    const { run } = build([started, ...finishedRead, failed, failedEnd, later]);
    assert.deepEqual(trailOf(run).map((tick) => [tick.id, tick.tone]), [["r1", "done"], ["f1", "fail"], ["e1", "work"]]);
    assert.equal(trailOf(run, 2).length, 2);
    assert.equal(trailOf(run, 2)[1]?.id, "e1", "the newest are the ones kept");
    assert.equal(endedCount(run), 2, "the read and the failure have ended; the edit has not");
  });

  it("lists the last calls with their verb, what they acted on and how long they took", () => {
    const { run } = build([started, ...finishedRead, editing]);
    const [done, running] = recentActions(run, 4);
    assert.deepEqual([done?.verb, done?.subject, done?.tone, done?.ms], ["Read", "package.json", "done", 400]);
    assert.deepEqual([running?.verb, running?.subject, running?.tone, running?.ms], ["Editing", "src/scene.ts", "work", null]);
    assert.equal(recentActions(run, 1)[0]?.id, "e1");
  });

  it("keeps a failed call out of what needs you while the prompt goes on, but not a request or a quiet one", () => {
    const failed = [call("f1", "bash", { command: "npm test" }, T + 2_000), call("f1", "bash", { command: "npm test" }, T + 3_000, { status: "failed", failureReason: "exited with 1", exitCode: 1 })];
    const { run } = build([started, ...failed, editing]);
    assert.equal(run.attention.some((agent) => agent.state === "failed"), true, "the model still knows");
    assert.equal(attentionOf(run).some((agent) => agent.state === "failed"), false, "the card does not put it first");
    assert.deepEqual(chipsOf(run).map((chip) => chip.kind), [], "and does not say it in red");
    const workflow = { ...run, kind: "workflow" as const };
    assert.equal(attentionOf(workflow).some((agent) => agent.state === "failed"), true, "a workflow's failed agent still needs you");
    const finished = build([started, ...failed, ended()], T + 70_000).run;
    assert.deepEqual(chipsOf(finished).map((chip) => chip.kind), [], "a finished prompt counts its failures in its second line");
    assert.equal(glyphOf(finished), "done", "a call that failed is not a failed prompt");
  });
});

describe("the plan inside the card", () => {
  it("is taken in only when it is the run's own", () => {
    const { run, fold } = build([started, plan([{ text: "Build it", status: "in_progress" }]), editing]);
    const view = taskPlanView(fold)!;
    assert.equal(planMerges(run, view), true);
    assert.equal(planMerges(run, { ...view, turnId: "t2" }), false, "another turn's plan is its own card");
    assert.equal(planMerges(run, { ...view, turnId: null }), false, "a plan nobody can place is its own card");
    assert.equal(planMerges({ ...run, kind: "workflow" }, view), false, "a workflow's plan is beside it, not in it");
    assert.equal(planMerges(null, view), false);
    assert.equal(planMerges(run, null), false);
  });

  it("turns the steps into spine segments: only an active step of a running plan moves", () => {
    const view = taskPlanView(build([started, plan([
      { text: "One", status: "completed" },
      { text: "Two", status: "in_progress", active_form: "Doing two" },
      { text: "Three", status: "pending" },
      { text: "Four", status: "cancelled" },
      { text: "Five", status: "failed" },
    ])]).fold)!;
    assert.deepEqual(stepSegs(view).map((seg) => [seg.tone, seg.label]), [["done", "One"], ["live", "Doing two"], ["todo", "Three"], ["skip", "Four"], ["fail", "Five"]]);
    const waiting = { ...view, animate: false, state: "waiting" as const };
    assert.equal(stepSegs(waiting)[1]?.tone, "hold", "waiting on you, the step holds still");
    assert.equal(activeStep(waiting), null, "and the card does not claim it is being worked on");
  });
});

describe("the numbers", () => {
  it("gives a call its time with the tenths a quick one needs", () => {
    assert.deepEqual([400, 3_200, 9_960, 41_000, 65_000, 3_900_000].map((ms) => callTime(ms)), ["0.4s", "3.2s", "10.0s", "41s", "1m 05s", "1h 05m"]);
    assert.equal(callTime(null), "");
    assert.equal(callTime(Number.NaN), "");
    assert.equal(callTime(-5), "");
  });

  it("keeps a command to its first line and a sane length", () => {
    assert.equal(oneLine("npm test\nnpm run build"), "npm test");
    assert.equal(oneLine("\n  \n  echo hi  "), "echo hi");
    assert.equal(oneLine(null), null);
    assert.equal(oneLine(""), null);
    assert.equal(oneLine("x".repeat(300))?.length, 140);
    assert.ok(oneLine("x".repeat(300))?.endsWith("…"));
  });
});

describe("the spine, the hairline, the heartbeat and the steps as markup", () => {
  const segs: Seg[] = [
    { key: "0:a", tone: "done", label: "First" },
    { key: "1:b", tone: "live", label: "Second" },
    { key: "2:c", tone: "todo", label: "Third" },
  ];

  it("draws a progress bar of equal segments that says how many are done", () => {
    const markup = renderToStaticMarkup(createElement(Spine, { segs, label: "Plan steps completed" }));
    assert.match(markup, /role="progressbar" aria-label="Plan steps completed" aria-valuemin="0" aria-valuemax="3" aria-valuenow="1" aria-valuetext="1 of 3"/);
    assert.deepEqual([...markup.matchAll(/<i class="([^"]*)"/g)].map((m) => m[1]), ["done", "live", "todo"]);
    assert.match(markup, /title="Second"/);
    assert.equal((markup.match(/<b class="dn">/g) ?? []).length, 3);
  });

  it("merges neighbours of one tone past forty steps, so a long plan stays a line", () => {
    const many: Seg[] = Array.from({ length: 90 }, (_, index) => ({ key: `${index}:s`, tone: index < 30 ? "done" : index === 30 ? "live" : "todo", label: `Step ${index}` }));
    const markup = renderToStaticMarkup(createElement(Spine, { segs: many, label: "Plan steps completed" }));
    assert.deepEqual([...markup.matchAll(/<i class="([^"]*)"( style="flex-grow:(\d+)")?/g)].map((m) => [m[1], m[3] ?? "1"]), [["done", "30"], ["live", "1"], ["todo", "59"]]);
    assert.match(markup, /aria-valuemax="90" aria-valuenow="30"/, "the count is still of the steps, not the segments");
  });

  it("is a hairline with a pulse for each call that ended, none when it has ended nothing or the run is over", () => {
    const quiet = renderToStaticMarkup(createElement(Hairline, { beat: 0 }));
    assert.match(quiet, /class="run-spine rhythm" aria-hidden="true"/);
    assert.doesNotMatch(quiet, /class="pulse"/);
    assert.match(renderToStaticMarkup(createElement(Hairline, { beat: 3 })), /<b class="pulse">/);
    const over = renderToStaticMarkup(createElement(Hairline, { beat: 3, finished: true }));
    assert.match(over, /class="run-spine rhythm done"/);
    assert.doesNotMatch(over, /class="pulse"/);
  });

  it("is a row of ticks, hidden from readers, and nothing when there is nothing to tick", () => {
    assert.equal(renderToStaticMarkup(createElement(Trail, { ticks: [] })), "");
    const markup = renderToStaticMarkup(createElement(Trail, { ticks: [{ id: "a", tone: "done" }, { id: "b", tone: "fail" }, { id: "c", tone: "work" }] }));
    assert.match(markup, /class="run-trail" aria-hidden="true"/);
    assert.deepEqual([...markup.matchAll(/<i class="([^"]*)"/g)].map((m) => m[1]), ["done", "fail", "work"]);
  });

  it("lists the steps with their marks, the active one named and the finished ones labelled", () => {
    const view = taskPlanView(build([started, plan([{ text: "Read the code", status: "completed" }, { text: "Build it", status: "in_progress", active_form: "Building it" }, { text: "Test it", status: "pending" }])]).fold)!;
    const markup = renderToStaticMarkup(createElement(PlanSteps, { view }));
    assert.deepEqual([...markup.matchAll(/<li class="([^"]*)"/g)].map((m) => m[1]), ["done", "live", ""]);
    assert.match(markup, /aria-current="step"/);
    assert.match(markup, /aria-label="Done"/);
    assert.match(markup, /aria-label="In progress"/);
    assert.match(markup, /aria-label="To do"/);
    assert.match(markup, /Building it/);
    assert.doesNotMatch(markup, /class="[^"]*run-pop/, "opening the card plays nothing: only a step that lands while it is open earns the pop");
  });
});
