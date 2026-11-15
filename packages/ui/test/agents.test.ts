import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentFeedRecovered, agentNumbers, markAgentFeed } from "../src/model/agents.js";
import { applyEvents, emptyFold, foldFromLoad } from "../src/model/fold.js";
import type { MspItem, TranscriptLoad, WorkflowChild } from "../src/types.js";

function createWorkflowItem(children: WorkflowChild[], extra: Partial<MspItem> = {}): MspItem {
  return {
    itemId: "wf_exec_01",
    kind: "workflow",
    revision: 1,
    status: "inProgress",
    turnId: "turn_lead_01",
    workflowRunId: "run_alpha",
    children,
    ...extra,
  };
}

function createSubagentItem(id: string, extra: Partial<MspItem> = {}): MspItem {
  return {
    itemId: `subagent_${id}`,
    kind: "subagent",
    revision: 1,
    status: "inProgress",
    turnId: "turn_lead_01",
    subagentId: id,
    ...extra,
  };
}

function createWorkflowChild(
  id: string,
  status: string,
  extra: Partial<WorkflowChild> = {},
): WorkflowChild {
  return { childId: id, attempt: 1, status, ...extra };
}

function buildFoldWithItems(...items: MspItem[]) {
  return applyEvents(
    emptyFold(),
    items.map((item) => ({ method: "item/updated", params: { item } })),
  );
}

function buildTranscriptLoad(...items: MspItem[]): TranscriptLoad {
  return {
    session: null,
    msp: null,
    truncated: true,
    readOnly: false,
    readOnlyReason: null,
    pending: { approvals: [], userInputs: [] },
    events: items.map((item) => ({ method: "item/updated", params: { item } })),
  };
}

describe("agentNumbers LRU map cache", () => {
  it("maintains thread-specific agent numbering independently across sessions", () => {
    const threadAlphaNumbers = agentNumbers("th_coord_alpha");
    assert.equal(agentNumbers("th_coord_alpha"), threadAlphaNumbers);
    assert.notEqual(agentNumbers("th_coord_beta"), threadAlphaNumbers);

    threadAlphaNumbers.set("worker_x", 1);
    threadAlphaNumbers.set("worker_y", 2);

    assert.equal(agentNumbers("th_coord_alpha").get("worker_y"), 2);
    assert.equal(agentNumbers("th_coord_beta").get("worker_y"), undefined);
  });

  it("evicts oldest threads from LRU cache when exceeding 64 registered sessions", () => {
    const initialSession = agentNumbers("th_evict_0");
    initialSession.set("initial_subagent", 1);

    for (let index = 1; index <= 64; index += 1) {
      agentNumbers(`th_evict_${index}`);
    }

    assert.notEqual(agentNumbers("th_evict_0"), initialSession);
    assert.equal(agentNumbers("th_evict_0").get("initial_subagent"), undefined);
  });
});

describe("Agent feed status monitoring and recovery detection", () => {
  it("recognizes agent activity after live disconnection as recovery progress when lead is idle", () => {
    const loadedFold = buildFoldWithItems(
      createWorkflowItem([createWorkflowChild("child_worker", "started", { label: "SearchWorker" })], {
        turnId: "finished",
      }),
    );
    const getItems = () => loadedFold.agentItems!;

    let feedMark = markAgentFeed(null, "sess_01", true, "loading", emptyFold().agentItems!);
    assert.equal(
      markAgentFeed(feedMark, "sess_01", true, "loading", emptyFold().agentItems!),
      feedMark,
    );
    assert.equal(agentFeedRecovered(feedMark, "sess_01", getItems(), true), false);

    feedMark = markAgentFeed(feedMark, "sess_01", true, "ready", getItems());
    assert.equal(feedMark?.items, getItems());
    assert.equal(markAgentFeed(feedMark, "sess_01", true, "ready", getItems()), feedMark);
    assert.equal(agentFeedRecovered(feedMark, "sess_01", getItems(), true), false);

    const replayedFold = applyEvents(loadedFold, [
      {
        method: "item/updated",
        params: {
          item: {
            itemId: "note_msg",
            kind: "agentMessage",
            revision: 1,
            status: "completed",
            text: "ready",
          },
        },
      },
      {
        method: "item/updated",
        params: {
          item: createWorkflowItem([createWorkflowChild("child_worker", "started")], {
            turnId: "finished",
          }),
        },
      },
    ]);
    assert.equal(
      agentFeedRecovered(
        markAgentFeed(feedMark, "sess_01", true, "ready", replayedFold.agentItems!),
        "sess_01",
        replayedFold.agentItems!,
        true,
      ),
      false,
    );

    const progressedFold = applyEvents(loadedFold, [
      {
        method: "item/updated",
        params: {
          item: createWorkflowItem(
            [createWorkflowChild("child_worker", "terminal", { terminal: "completed" })],
            { turnId: "finished", revision: 2, status: "completed" },
          ),
        },
      },
    ]);

    const activeMark = markAgentFeed(feedMark, "sess_01", true, "ready", progressedFold.agentItems!);
    assert.equal(activeMark, feedMark);
    assert.equal(agentFeedRecovered(activeMark, "sess_01", progressedFold.agentItems!, true), true);
    assert.equal(agentFeedRecovered(activeMark, "sess_01", progressedFold.agentItems!, false), false);
    assert.equal(agentFeedRecovered(activeMark, "other_sess", progressedFold.agentItems!, true), false);

    const spawnedFold = applyEvents(loadedFold, [
      {
        method: "item/updated",
        params: { item: createSubagentItem("dynamic_sub", { turnId: "finished" }) },
      },
    ]);
    assert.equal(agentFeedRecovered(feedMark, "sess_01", spawnedFold.agentItems!, true), true);

    assert.equal(
      markAgentFeed(activeMark, "sess_01", false, "ready", progressedFold.agentItems!),
      null,
    );
    assert.equal(
      markAgentFeed(null, "sess_01", true, "ready", progressedFold.agentItems!)?.items,
      progressedFold.agentItems,
    );
    assert.equal(
      markAgentFeed(activeMark, "sess_02", true, "ready", spawnedFold.agentItems!)?.sessionId,
      "sess_02",
    );
  });

  it("isolates live-streamed agent events from historical transcript reloads", () => {
    const loadedFold = buildFoldWithItems(
      createWorkflowItem([createWorkflowChild("child_worker", "started", { label: "SearchWorker" })], {
        turnId: "finished",
      }),
    );
    const initialMark = markAgentFeed(null, "sess_01", true, "ready", loadedFold.agentItems!);

    const reloadInFlightMark = markAgentFeed(
      initialMark,
      "sess_01",
      true,
      "loading",
      loadedFold.agentItems!,
    );
    assert.notEqual(reloadInFlightMark, initialMark);
    assert.equal(
      markAgentFeed(reloadInFlightMark, "sess_01", true, "loading", loadedFold.agentItems!),
      reloadInFlightMark,
    );

    const loadedTranscriptFold = foldFromLoad(
      {
        ...buildTranscriptLoad(
          createWorkflowItem(
            [createWorkflowChild("historic_child", "terminal", { terminal: "completed" })],
            { itemId: "wf_exec_00", turnId: "turn_lead_00", status: "completed" },
          ),
          createWorkflowItem(
            [createWorkflowChild("child_worker", "started", { label: "SearchWorker", phase: "Indexing" })],
            { turnId: "finished", revision: 2 },
          ),
        ),
        historyUnavailable: true,
      },
      loadedFold,
    );

    assert.deepEqual(Object.keys(loadedTranscriptFold.agentItems!).sort(), [
      "wf_exec_00",
      "wf_exec_01",
    ]);
    assert.equal(
      agentFeedRecovered(reloadInFlightMark, "sess_01", loadedTranscriptFold.agentItems!, true),
      false,
    );

    const finishedLoadMark = markAgentFeed(
      reloadInFlightMark,
      "sess_01",
      true,
      "ready",
      loadedTranscriptFold.agentItems!,
    );
    assert.equal(finishedLoadMark?.items, loadedTranscriptFold.agentItems);
    assert.equal(finishedLoadMark?.reading, false);
    assert.equal(
      agentFeedRecovered(finishedLoadMark, "sess_01", loadedTranscriptFold.agentItems!, true),
      false,
    );

    const subsequentLiveFold = applyEvents(loadedTranscriptFold, [
      {
        method: "item/updated",
        params: {
          item: createWorkflowItem(
            [createWorkflowChild("child_worker", "terminal", { terminal: "completed" })],
            { turnId: "finished", revision: 3, status: "completed" },
          ),
        },
      },
    ]);
    assert.equal(
      agentFeedRecovered(finishedLoadMark, "sess_01", subsequentLiveFold.agentItems!, true),
      true,
    );

    const failedLoadMark = markAgentFeed(
      reloadInFlightMark,
      "sess_01",
      true,
      "error",
      loadedFold.agentItems!,
    );
    assert.equal(failedLoadMark?.items, loadedFold.agentItems);
    assert.equal(failedLoadMark?.reading, false);
    assert.equal(
      agentFeedRecovered(failedLoadMark, "sess_01", loadedFold.agentItems!, true),
      false,
    );
    assert.equal(
      agentFeedRecovered(failedLoadMark, "sess_01", subsequentLiveFold.agentItems!, true),
      true,
    );
  });
});
