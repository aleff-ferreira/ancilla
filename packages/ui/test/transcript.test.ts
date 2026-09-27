import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { Transcript } from "../src/components/thread/Transcript.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { addEcho, applyEvents, emptyFold, type ThreadFold } from "../src/model/fold.js";
import { defaultPrefs, initialState, Store, type ThreadState } from "../src/model/store.js";
import type { ViewEvent } from "../src/types.js";

function render(fold: ThreadFold, readOnly = false): string {
  const thread: ThreadState = {
    load: "ready", error: null, readOnly, readOnlyReason: readOnly ? "Another Muse session has it open." : null, truncated: false,
    fold, attachments: [], shellRuns: [], researchRuns: [], stalled: false,
  };
  const state = initialState(defaultPrefs());
  const store = new Store({ ...state, threads: { s1: thread } });
  const controller = { store } as unknown as AncillaController;
  const transcript = createElement(Transcript, { sessionId: "s1", thread });
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: transcript }) }));
}

const said = (itemId: string, turnId: string, text: string, recordedAt?: string): ViewEvent => ({
  method: "item/completed",
  params: { item: { itemId, kind: "userMessage", status: "completed", revision: 1, turnId, text, ...(recordedAt ? { recordedAt } : {}) } },
});
const failed = (turnId: string, message: string): ViewEvent => ({
  method: "turn/completed", params: { turnId, terminal: "failed", error: { kind: "provider", message, retryable: true } },
});

describe("Transcript failure notices", () => {
  const compaction = (message: string) => applyEvents(emptyFold(), [
    { method: "turn/started", params: { turnId: "A" } },
    said("uA", "A", "hello"),
    { method: "item/completed", params: { item: { itemId: "mA", kind: "agentMessage", status: "completed", revision: 1, turnId: "A", text: "hi" } } },
    { method: "turn/completed", params: { turnId: "A", terminal: "completed" } },
    // Compaction runs as a turn of its own, with no prompt in it.
    { method: "turn/started", params: { turnId: "C" } },
    { method: "item/completed", params: { item: { itemId: "cmp", kind: "compaction", status: "completed", revision: 1, turnId: "C" } } },
    failed("C", message),
  ]);
  const compacted = compaction("context too long");

  it("calls the latest turn's failure its own, even when that turn had no prompt", () => {
    const markup = render(compacted);
    assert.match(markup, /This turn failed/);
    assert.doesNotMatch(markup, /An earlier turn failed/);
  });

  it("calls it earlier once a newer prompt is on its way", () => {
    const markup = render(addEcho(compacted, { localId: "e", text: "next", turnId: null, disposition: "sending", createdAt: 1 }));
    assert.match(markup, /An earlier turn failed/);
  });

  it("never lets that replace the heading of a thread that cannot go on", () => {
    const stuck = compaction("invalid image data at input[3]");
    for (const fold of [stuck, addEcho(stuck, { localId: "e", text: "next", turnId: null, disposition: "sending", createdAt: 1 })]) {
      const markup = render(fold);
      assert.match(markup, /This thread cannot go on as it is/);
      assert.doesNotMatch(markup, /An earlier turn failed/);
    }
  });

  it("gives the full notice and Retry only to the turn shown last", () => {
    // Stream order has the newer turn first; the transcript shows turns by when they were sent.
    const fold = applyEvents(emptyFold(), [
      said("uB", "B", "newer", "2026-09-26T10:05:00.000Z"),
      { method: "turn/completed", params: { turnId: "B", terminal: "completed" } },
      said("uA", "A", "older", "2026-09-26T10:00:00.000Z"),
      failed("A", "Provider down"),
    ]);
    const markup = render(fold);
    assert.ok(markup.indexOf("older") < markup.indexOf("newer"), "the older turn is shown first");
    assert.match(markup, /Failed/);
    assert.doesNotMatch(markup, /This turn failed|Retry/);
  });
});

describe("Transcript prompt actions", () => {
  it("offers Edit and Resend on a stopped turn's line and on every prompt, but not in a read-only thread", () => {
    const fold = applyEvents(emptyFold(), [
      said("uA", "A", "refactor the parser", "2026-09-26T10:00:00.000Z"),
      { method: "turn/completed", params: { turnId: "A", terminal: "cancelled", durationMs: 12_000 } },
    ]);
    const markup = render(fold);
    assert.match(markup, /Stopped/);
    // Once beside the prompt (hover actions) and once inline on the Stopped line.
    assert.equal((markup.match(/>Edit</g) ?? []).length, 2);
    assert.equal((markup.match(/>Resend</g) ?? []).length, 2);
    assert.doesNotMatch(markup, /<button[^>]*disabled=""[^>]*>Resend</, "a stopped turn's Resend is live");
    assert.doesNotMatch(render(fold, true), /Edit|Resend/);
    // A finished turn keeps the hover actions only; a running one cannot resend yet.
    const done = applyEvents(emptyFold(), [said("uB", "B", "add tests"), { method: "turn/completed", params: { turnId: "B", terminal: "completed" } }]);
    assert.equal((render(done).match(/>Edit</g) ?? []).length, 1);
    const running = applyEvents(emptyFold(), [{ method: "turn/started", params: { turnId: "C" } }, said("uC", "C", "still going")]);
    assert.match(render(running), /<button[^>]*disabled=""[^>]*>Resend</);
  });
});

describe("Transcript unconfirmed outcomes", () => {
  it("shows a turn whose saved outcome is not readable yet without calling it failed", () => {
    const fold = applyEvents(emptyFold(), [
      { method: "turn/started", params: { turnId: "A" } },
      said("uA", "A", "refactor"),
      { method: "turn/completed", params: { turnId: "A", terminal: "unknown" } },
    ]);
    const markup = render(fold);
    assert.match(markup, /Outcome not saved yet/);
    assert.match(markup, /Nothing was sent again/);
    assert.match(markup, /Reload results/);
    assert.doesNotMatch(markup, /failed|Retry|Completed/i);
  });
});
