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

function renderTranscript(foldData: ThreadFold, isReadOnlyMode = false): string {
  const activeThread: ThreadState = {
    load: "ready",
    error: null,
    readOnly: isReadOnlyMode,
    readOnlyReason: isReadOnlyMode ? "Another Muse session has it open." : null,
    truncated: false,
    fold: foldData,
    attachments: [],
    shellRuns: [],
    researchRuns: [],
    stalled: false,
  };
  const baseAppState = initialState(defaultPrefs());
  const dataStore = new Store({ ...baseAppState, threads: { s1: activeThread } });
  const mockController = { store: dataStore } as unknown as AncillaController;

  const transcriptComponent = createElement(Transcript, { sessionId: "s1", thread: activeThread });
  const wrappedWithTooltip = createElement(TooltipProvider, { children: transcriptComponent });
  return renderToStaticMarkup(
    createElement(ControllerProvider, { controller: mockController, children: wrappedWithTooltip }),
  );
}

function createUserMessageEvent(
  itemId: string,
  turnId: string,
  messageContent: string,
  timestampIso?: string,
): ViewEvent {
  return {
    method: "item/completed",
    params: {
      item: {
        itemId,
        kind: "userMessage",
        status: "completed",
        revision: 1,
        turnId,
        text: messageContent,
        ...(timestampIso ? { recordedAt: timestampIso } : {}),
      },
    },
  };
}

function createFailureEvent(turnId: string, errorMessage: string): ViewEvent {
  return {
    method: "turn/completed",
    params: {
      turnId,
      terminal: "failed",
      error: { kind: "provider", message: errorMessage, retryable: true },
    },
  };
}

function createCompactionTurnFold(failureReason: string): ThreadFold {
  const sequence: ViewEvent[] = [
    { method: "turn/started", params: { turnId: "A" } },
    createUserMessageEvent("uA", "A", "hello"),
    {
      method: "item/completed",
      params: {
        item: { itemId: "mA", kind: "agentMessage", status: "completed", revision: 1, turnId: "A", text: "hi" },
      },
    },
    { method: "turn/completed", params: { turnId: "A", terminal: "completed" } },
    { method: "turn/started", params: { turnId: "C" } },
    {
      method: "item/completed",
      params: { item: { itemId: "cmp", kind: "compaction", status: "completed", revision: 1, turnId: "C" } },
    },
    createFailureEvent("C", failureReason),
  ];
  return applyEvents(emptyFold(), sequence);
}

describe("Transcript Failure Notice Presentation", () => {
  it("attributes failure directly to latest turn even when that turn contains no prompt", () => {
    const compactedFold = createCompactionTurnFold("context too long");
    const markup = renderTranscript(compactedFold);

    assert.match(markup, /This turn failed/);
    assert.doesNotMatch(markup, /An earlier turn failed/);
  });

  it("shifts attribution to an earlier turn once a new echo prompt begins dispatch", () => {
    const compactedFold = createCompactionTurnFold("context too long");
    const withEcho = addEcho(compactedFold, {
      localId: "e",
      text: "next",
      turnId: null,
      disposition: "sending",
      createdAt: 1,
    });
    const markup = renderTranscript(withEcho);

    assert.match(markup, /An earlier turn failed/);
  });

  it("preserves fatal unrecoverable banner across subsequent user input attempts", () => {
    const terminalErrorFold = createCompactionTurnFold("invalid image data at input[3]");
    const candidateFolds = [
      terminalErrorFold,
      addEcho(terminalErrorFold, {
        localId: "e",
        text: "next",
        turnId: null,
        disposition: "sending",
        createdAt: 1,
      }),
    ];

    for (const foldItem of candidateFolds) {
      const renderedHtml = renderTranscript(foldItem);
      assert.match(renderedHtml, /This thread cannot go on as it is/);
      assert.doesNotMatch(renderedHtml, /An earlier turn failed/);
    }
  });

  it("orders turns chronologically and restricts full failure card and retry action to final turn", () => {
    // Arrival order has turn B first, but sent timestamps place turn A earlier
    const interleavedEvents: ViewEvent[] = [
      createUserMessageEvent("uB", "B", "newer", "2026-09-26T10:05:00.000Z"),
      { method: "turn/completed", params: { turnId: "B", terminal: "completed" } },
      createUserMessageEvent("uA", "A", "older", "2026-09-26T10:00:00.000Z"),
      createFailureEvent("A", "Provider down"),
    ];
    const orderedFold = applyEvents(emptyFold(), interleavedEvents);
    const markup = renderTranscript(orderedFold);

    assert.ok(markup.indexOf("older") < markup.indexOf("newer"), "Older message must appear prior to newer one");
    assert.match(markup, /Failed/);
    assert.doesNotMatch(markup, /This turn failed|Retry/);
  });
});

describe("Transcript Prompt & Turn Action Controls", () => {
  it("exposes Edit and Resend actions on stopped turns and suppresses them in read-only sessions", () => {
    const stoppedEvents: ViewEvent[] = [
      createUserMessageEvent("uA", "A", "refactor the parser", "2026-09-26T10:00:00.000Z"),
      { method: "turn/completed", params: { turnId: "A", terminal: "cancelled", durationMs: 12_000 } },
    ];
    const stoppedFold = applyEvents(emptyFold(), stoppedEvents);
    const activeHtml = renderTranscript(stoppedFold);

    assert.match(activeHtml, /Stopped/);
    const editMatches = (activeHtml.match(/>Edit</g) ?? []).length;
    const resendMatches = (activeHtml.match(/>Resend</g) ?? []).length;
    assert.strictEqual(editMatches, 2);
    assert.strictEqual(resendMatches, 2);
    assert.doesNotMatch(activeHtml, /<button[^>]*disabled=""[^>]*>Resend/);

    const readOnlyHtml = renderTranscript(stoppedFold, true);
    assert.doesNotMatch(readOnlyHtml, /Edit|Resend/);

    const completedFold = applyEvents(emptyFold(), [
      createUserMessageEvent("uB", "B", "add tests"),
      { method: "turn/completed", params: { turnId: "B", terminal: "completed" } },
    ]);
    const completedEditCount = (renderTranscript(completedFold).match(/>Edit</g) ?? []).length;
    assert.strictEqual(completedEditCount, 1);

    const inFlightFold = applyEvents(emptyFold(), [
      { method: "turn/started", params: { turnId: "C" } },
      createUserMessageEvent("uC", "C", "still going"),
    ]);
    assert.match(renderTranscript(inFlightFold), /<button[^>]*disabled=""[^>]*>Resend</);
  });
});

describe("Transcript Indeterminate Turn Status", () => {
  it("renders pending unconfirmed outcome gracefully without diagnosing false failure", () => {
    const unknownOutcomeEvents: ViewEvent[] = [
      { method: "turn/started", params: { turnId: "A" } },
      createUserMessageEvent("uA", "A", "refactor"),
      { method: "turn/completed", params: { turnId: "A", terminal: "unknown" } },
    ];
    const unknownFold = applyEvents(emptyFold(), unknownOutcomeEvents);
    const html = renderTranscript(unknownFold);

    assert.match(html, /Outcome not saved yet/);
    assert.match(html, /Nothing was sent again/);
    assert.match(html, /Reload results/);
    assert.doesNotMatch(html, /failed|Retry|Completed/i);
  });
});
