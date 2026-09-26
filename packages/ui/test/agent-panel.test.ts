import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentPanel } from "../src/components/thread/AgentPanel.js";
import type { AgentActivity, AgentActivityView } from "../src/model/agents.js";

function agent(id: string, status: AgentActivity["status"], extra: Partial<AgentActivity> = {}): AgentActivity {
  return { id, name: id, objective: null, activity: null, status, source: "workflow", turnId: "turn", durationMs: null, toolCalls: null, attempt: 1, workflowRunId: "run", childSessionId: null, ...extra };
}

function render(agents: AgentActivity[], props: { leadRunning?: boolean; stale?: boolean } = {}): string {
  const view: AgentActivityView = { agents, total: agents.length, working: 0, waiting: 0, completed: 0, failed: 0, stopped: 0, unknown: 0 };
  for (const item of agents) view[item.status]++;
  return renderToStaticMarkup(createElement(AgentPanel, { sessionId: "session", view, leadRunning: false, stale: false, ...props }));
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
});
