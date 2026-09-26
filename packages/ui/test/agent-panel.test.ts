import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPanel, agentAnnouncement } from "../src/components/thread/AgentPanel.js";
import type { AgentActivity, AgentActivityStatus, AgentActivityView } from "../src/model/agents.js";

function agent(id: string, status: AgentActivity["status"], extra: Partial<AgentActivity> = {}): AgentActivity {
  return { id, name: id, objective: null, activity: null, status, source: "workflow", turnId: "turn", durationMs: null, toolCalls: null, attempt: 1, workflowRunId: "run", childSessionId: null, ...extra };
}

function viewOf(agents: AgentActivity[]): AgentActivityView {
  const view: AgentActivityView = { agents, total: agents.length, working: 0, waiting: 0, completed: 0, failed: 0, stopped: 0, unknown: 0 };
  for (const item of agents) view[item.status]++;
  return view;
}

function render(agents: AgentActivity[], props: { leadRunning?: boolean; stale?: boolean; load?: "ready" | "loading" | "failed"; partial?: boolean } = {}): string {
  return renderToStaticMarkup(createElement(AgentPanel, { sessionId: "session", view: viewOf(agents), leadRunning: false, stale: false, ...props }));
}

function statuses(entries: [string, AgentActivityStatus][]): Map<string, AgentActivityStatus> {
  return new Map(entries);
}

describe("AgentPanel", () => {
  it("distinguishes solo work from no recorded agents without presenting a live child", () => {
    assert.match(render([], { leadRunning: true }), /Lead agent is working solo/);
    assert.match(render([]), /No agents yet/);
    const stale = render([], { leadRunning: true, stale: true });
    assert.match(stale, /Last known activity/);
    assert.doesNotMatch(stale, /working solo|spin-ring/);
  });

  it("marks historical working and waiting states as last known, with no live animation", () => {
    const markup = render([agent("Build", "working"), agent("Review", "waiting")], { stale: true });
    assert.match(markup, /Last known activity/);
    assert.match(markup, /Was working/);
    assert.match(markup, /Was waiting/);
    assert.doesNotMatch(markup, /spin-ring/);
  });

  it("keeps active, failed, and unknown agents visible while folding large completed history", () => {
    const history = Array.from({ length: 8 }, (_, index) => agent(`finished-${index}`, "completed"));
    const markup = render([...history, agent("Unknown child", "unknown"), agent("Failed child", "failed"), agent("Working child", "working")]);
    assert.equal((markup.match(/<article /g) ?? []).length, 3);
    assert.match(markup, /Show 8 finished agents/);
    assert.match(markup, /Status unknown/);
    assert.ok(markup.indexOf('<article aria-label="Working child') < markup.indexOf('<article aria-label="Failed child'));
    assert.doesNotMatch(markup, /<article aria-label="finished-/);
  });

  it("shows reported zero metrics but leaves absent telemetry and duplicate descriptions out", () => {
    const unknown = render([agent("Inspect fixtures", "unknown")]);
    assert.doesNotMatch(unknown, /tool calls|Reported duration|Task details not reported/);
    const known = render([agent("Inspect fixtures", "working", { objective: "Inspect fixtures", activity: "Inspect fixtures", durationMs: 0, toolCalls: 0 })]);
    assert.match(known, /0ms/);
    assert.match(known, /0 tool calls/);
    assert.equal((known.match(/>Inspect fixtures</g) ?? []).length, 1);
  });

  it("reports missing details only for anonymous agents with no task or activity", () => {
    assert.match(render([agent("Agent 1", "working")]), /Task details not reported/);
    assert.match(render([agent("", "unknown")]), /Task details not reported/);
    assert.doesNotMatch(render([agent("Inspect fixtures", "working")]), /Task details not reported/);
    assert.doesNotMatch(render([agent("Agent 1", "working", { objective: "Inspect fixtures" })]), /Task details not reported/);
    assert.doesNotMatch(render([agent("Agent 1", "working", { activity: "Reading test output" })]), /Task details not reported/);
  });

  it("keeps the changing summary out of live regions and the button, with one separate live region", () => {
    const markup = render([agent("Build", "working"), agent("Review", "completed")]);
    const button = markup.slice(markup.indexOf("<button"), markup.indexOf("</button>"));
    assert.doesNotMatch(button, /role="status"|aria-live/);
    assert.match(button, /aria-label="Collapse agents\. 1 working · 1 completed"/);
    assert.match(button, /aria-expanded="true"/);
    assert.equal((markup.match(/aria-live=/g) ?? []).length, 1);
    // Nothing is announced for what was already there when the thread opened.
    assert.match(markup, /<div role="status" aria-live="polite" class="sr-only"><\/div><button/);
  });

  it("announces agents starting, finishing, and failing, but not re-counts, queueing, or pauses", () => {
    const before = statuses([["a", "working"], ["b", "working"], ["c", "waiting"]]);
    assert.equal(agentAnnouncement(before, viewOf([agent("a", "working"), agent("b", "working"), agent("c", "waiting")])), null);
    assert.equal(agentAnnouncement(before, viewOf([agent("a", "working"), agent("b", "waiting"), agent("c", "waiting"), agent("d", "waiting")])), null);
    assert.equal(agentAnnouncement(before, viewOf([agent("a", "working"), agent("b", "working"), agent("c", "working"), agent("d", "working")])), "2 agents started.");
    assert.equal(agentAnnouncement(before, viewOf([agent("a", "completed"), agent("b", "failed"), agent("c", "working")])), "1 agent started, 1 finished, 1 failed.");
    assert.equal(agentAnnouncement(before, viewOf([agent("a", "completed"), agent("b", "working"), agent("c", "waiting")])), "1 agent finished.");
    assert.equal(agentAnnouncement(before, viewOf([agent("a", "completed"), agent("b", "failed"), agent("c", "stopped"), agent("e", "completed")])), "All agents finished: 2 completed, 1 failed, 1 stopped.");
    // Settling into an unrecorded outcome is not a finish to announce.
    assert.equal(agentAnnouncement(before, viewOf([agent("a", "unknown"), agent("b", "working"), agent("c", "waiting")])), null);
  });

  it("does not claim an empty thread before its history has been read", () => {
    for (const props of [{ load: "loading" as const }, { load: "loading" as const, leadRunning: true }, { load: "loading" as const, stale: true }]) {
      const markup = render([], props);
      assert.match(markup, /Loading agent activity/);
      assert.doesNotMatch(markup, /No agents yet|working solo|no agents recorded/);
    }
    assert.match(render([], { load: "failed" }), /Agent activity not loaded/);
    // Agents already known are shown while a reload is in flight.
    assert.match(render([agent("Build", "working")], { load: "loading" }), /1 working/);
  });

  it("labels totals from a partial history as covering only what was loaded", () => {
    const markup = render([agent("Build", "completed")], { partial: true });
    assert.match(markup, /in loaded history/);
    assert.match(markup, /aria-label="Collapse agents\. 0 working · 1 completed, in loaded history"/);
    assert.match(render([], { partial: true }), /No agents in loaded history/);
    assert.match(render([], { partial: true, leadRunning: true }), /No agents in loaded history/);
    assert.doesNotMatch(render([agent("Build", "completed")]), /loaded history/);
  });
});
