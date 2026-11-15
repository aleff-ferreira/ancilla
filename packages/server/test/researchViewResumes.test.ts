/**
 * The run view carries a `resumes` counter from the release that teaches clients to compare it, two releases before
 * anything resumes a run: every view says 0 for now, and a client that reads a missing one as 0 sees no difference.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RESEARCH_CONFIG, type ResearchRunRecord, type ResearchStatus } from "@ancilla/daemon";
import { runView } from "../src/research/views.js";

function record(status: ResearchStatus): ResearchRunRecord {
  return {
    id: "run-1",
    sessionId: "s1",
    commandId: "c1",
    status,
    question: "What is the answer?",
    config: DEFAULT_RESEARCH_CONFIG,
    state: null,
    report: null,
    failure: null,
    reportPath: null,
    createdAt: "2026-09-26T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
  };
}

describe("the research run view's resumes counter", () => {
  it("is 0 for a run in every status, with or without its report", () => {
    const statuses: ResearchStatus[] = ["queued", "running", "completed", "partial", "failed", "cancelled", "interrupted"];
    for (const status of statuses) {
      assert.equal(runView(record(status), [], { withReport: false }).resumes, 0, status);
      assert.equal(runView(record(status), [], { withReport: true }).resumes, 0, `${status} with its report`);
    }
  });

  it("travels on the wire as a number next to the fields the view already had", () => {
    const view = runView(record("running"), [], { withReport: false });
    const wire = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
    assert.equal(wire["resumes"], 0);
    for (const key of ["runId", "sessionId", "status", "phase", "question", "round", "failure", "reportAvailable", "report", "config", "workers", "sources", "usage"]) {
      assert.ok(key in wire, `${key} is still there`);
    }
  });
});
