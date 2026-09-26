import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TERMINAL_FAILURES, reconciled } from "../src/model/workflow.js";

const CALL = "call_01a08dd7";

/** The reconciliation payload, wrapped the way Muse wraps it inside the item's `message`. */
function payload(extra: Record<string, unknown> = {}): string {
  const body = {
    type: "workflow-launch-reconciled",
    call_id: CALL,
    route: "guidance",
    launch_admitted: true,
    deferred_to_background: true,
    agents_activity: [
      { agent: "a1", duration_ms: 4000, tool_calls: 3 },
      { agent: "a2", duration_ms: 9000, tool_calls: 5 },
    ],
    final_summary: { status: "success", summary: "# Findings\n\nTen ideas." },
    latest_failure: null,
    ...extra,
  };
  return `Some preamble.\n<workflow-launch-reconciled>${JSON.stringify(body)}</workflow-launch-reconciled>`;
}

describe("reconciled", () => {
  it("reads the payload out of its wrapper", () => {
    const parsed = reconciled(payload());
    assert.equal(parsed?.call_id, CALL);
    assert.equal(parsed?.agents_activity?.length, 2);
  });

  it("accepts a bare JSON message", () => {
    assert.equal(reconciled(JSON.stringify({ call_id: "x" }))?.call_id, "x");
  });

  it("returns null for nothing, prose, or broken JSON", () => {
    assert.equal(reconciled(undefined), null);
    assert.equal(reconciled("just text"), null);
    assert.equal(reconciled("<workflow-launch-reconciled>{oops</workflow-launch-reconciled>"), null);
  });
});

describe("TERMINAL_FAILURES", () => {
  it("names every status that means the run did not succeed", () => {
    assert.deepEqual([...TERMINAL_FAILURES].sort(), ["cancelled", "failed", "rejected", "timedOut"]);
  });
});
