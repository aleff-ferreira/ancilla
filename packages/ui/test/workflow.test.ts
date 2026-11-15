import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TERMINAL_FAILURES, reconciled } from "../src/model/workflow.js";

const SYNTHETIC_CALL_ID = "wf_call_88291";

function buildWorkflowPayload(extraProperties: Record<string, unknown> = {}): string {
  const payloadData = {
    type: "workflow-launch-reconciled",
    call_id: SYNTHETIC_CALL_ID,
    agents_activity: [
      { agent: "planner_worker", duration_ms: 4500, tool_calls: 4 },
      { agent: "exec_worker", duration_ms: 8500, tool_calls: 6 },
    ],
    launch_admitted: true,
    latest_failure: null,
    deferred_to_background: true,
    final_summary: { status: "success", summary: "# Synthesis\n\nExecution finished successfully." },
    ...extraProperties,
  };

  return `Preamble text output.\n<workflow-launch-reconciled>${JSON.stringify(payloadData)}</workflow-launch-reconciled>\nTrailing output.`;
}

describe("reconciled workflow payload parser", () => {
  it("extracts and parses structured payload enclosed within XML boundary tags", () => {
    const parsedPayload = reconciled(buildWorkflowPayload());
    assert.equal(parsedPayload?.call_id, SYNTHETIC_CALL_ID);
    assert.equal(parsedPayload?.agents_activity?.length, 2);
    assert.equal(parsedPayload?.agents_activity?.[0]?.agent, "planner_worker");
  });

  it("parses bare JSON objects when boundary tags are absent", () => {
    const rawJson = JSON.stringify({ call_id: "bare_call_007", launch_admitted: true });
    assert.equal(reconciled(rawJson)?.call_id, "bare_call_007");
  });

  it("returns null gracefully for undefined, plain text prose, or invalid JSON", () => {
    assert.equal(reconciled(undefined), null);
    assert.equal(reconciled("Standard transcript prose without JSON payload"), null);
    assert.equal(reconciled("<workflow-launch-reconciled>{corrupted_json</workflow-launch-reconciled>"), null);
  });
});

describe("TERMINAL_FAILURES definition", () => {
  it("contains all recognized non-successful workflow termination states", () => {
    assert.deepEqual([...TERMINAL_FAILURES].sort(), [
      "cancelled",
      "failed",
      "rejected",
      "timedOut",
    ]);
  });
});
