import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addEcho, applyEvent, emptyFold, foldFromLoad, updateEcho, type LocalEcho } from "../src/model/fold.js";
import type { MspItem, TranscriptLoad, ViewEvent } from "../src/types.js";

function echo(extra: Partial<LocalEcho> = {}): LocalEcho {
  return { localId: "local", text: "Review the attached report", turnId: "turn", disposition: "started", createdAt: 1, ...extra };
}
function prompt(extra: Partial<MspItem> = {}): ViewEvent {
  return { method: "item/completed", params: { item: {
    itemId: "user", kind: "userMessage", revision: 2, status: "completed", turnId: "turn", commandId: "turn",
    text: "Review the attached report\n\n@.helicon/attachments/report.pdf[Image #1]", ...extra,
  } } };
}
function load(events: ViewEvent[]): TranscriptLoad {
  return { session: null, msp: null, events, truncated: false, pending: { approvals: [], userInputs: [] }, readOnly: false, readOnlyReason: null };
}

describe("prompt echo reconciliation", () => {
  it("replaces an acknowledged PDF/image preview despite Muse's expanded body", () => {
    const before = addEcho(emptyFold(), echo());
    const after = applyEvent(before, prompt());
    assert.equal(after.echoes.length, 0);
    assert.equal(after.order.length, 1);
    assert.equal(before.echoes.length, 1, "the previous fold is immutable");
  });

  it("reconciles an attachment-only prompt when its item arrives before the ack", () => {
    let fold = addEcho(emptyFold(), echo({ text: "", turnId: null, disposition: "sending" }));
    fold = applyEvent(fold, prompt({ text: "[Image #1]" }));
    assert.equal(fold.echoes.length, 1);
    fold = updateEcho(fold, "local", { turnId: "turn", disposition: "started" });
    assert.equal(fold.echoes.length, 0);
    assert.equal(fold.order.length, 1);
  });

  it("recognizes the command id when a prompt does not carry a turn id", () => {
    const fold = applyEvent(addEcho(emptyFold(), echo()), prompt({ turnId: undefined }));
    assert.equal(fold.echoes.length, 0);
  });

  it("reconciles rewritten prompts across reload without dropping queued or unacknowledged repeats", () => {
    let previous = addEcho(emptyFold(), echo());
    previous = addEcho(previous, echo({ localId: "queued", turnId: "future", disposition: "queued" }));
    previous = addEcho(previous, echo({ localId: "sending", turnId: null, disposition: "sending" }));
    const fold = foldFromLoad(load([prompt()]), previous);
    assert.deepEqual(fold.echoes.map((item) => item.localId), ["queued", "sending"]);
    assert.equal(fold.order.length, 1);
  });

  it("does not consume another acknowledged send when an older identical prompt is revised", () => {
    let fold = applyEvent(emptyFold(), prompt({ text: "continue" }));
    fold = addEcho(fold, echo({ text: "continue", turnId: "future", disposition: "queued" }));
    fold = applyEvent(fold, prompt({ text: "continue", revision: 3 }));
    assert.equal(fold.echoes.length, 1);
    fold = applyEvent(fold, prompt({ itemId: "next", turnId: "future", commandId: "future", text: "continue" }));
    assert.equal(fold.echoes.length, 0);
    assert.equal(fold.order.length, 2, "both real repeated prompts remain in history");
  });

  it("does not match a steer to the original prompt sharing its active turn", () => {
    let fold = applyEvent(emptyFold(), prompt({ text: "continue" }));
    fold = addEcho(fold, echo({ text: "continue", turnId: null, disposition: "steered" }));
    fold = updateEcho(fold, "local", { turnId: "turn", disposition: "steered" });
    assert.equal(fold.echoes.length, 1);
    fold = applyEvent(fold, prompt({ text: "continue", revision: 3 }));
    assert.equal(fold.echoes.length, 1);
    fold = applyEvent(fold, prompt({ itemId: "steer", commandId: "steer-command", text: "continue", steered: true }));
    assert.equal(fold.echoes.length, 0);
  });

  it("does not match a normal prompt to a steered item with a shared turn id", () => {
    const fold = applyEvent(addEcho(emptyFold(), echo()), prompt({ itemId: "steer", commandId: "other", steered: true }));
    assert.equal(fold.echoes.length, 1);
  });

  it("cleans up all acknowledged echoes when their turn finishes, preserving other pending sends", () => {
    let fold = addEcho(emptyFold(), echo());
    fold = addEcho(fold, echo({ localId: "steer", disposition: "steered" }));
    fold = addEcho(fold, echo({ localId: "future", turnId: "future", disposition: "queued" }));
    fold = applyEvent(fold, { method: "turn/completed", params: { turnId: "turn", terminal: "completed" } });
    assert.deepEqual(fold.echoes.map((item) => item.localId), ["future"]);
  });

  it("does not resurrect a Sent bubble when the turn completed before the HTTP ack", () => {
    let fold = addEcho(emptyFold(), echo({ turnId: null, disposition: "sending" }));
    fold = applyEvent(fold, { method: "turn/completed", params: { turnId: "turn", terminal: "completed" } });
    fold = updateEcho(fold, "local", { turnId: "turn", disposition: "started" });
    assert.equal(fold.echoes.length, 0);
  });
});
