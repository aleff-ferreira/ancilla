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
    text: "Review the attached report\n\n@.ancilla/attachments/report.pdf[Image #1]", ...extra,
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

  it("replaces the preview just the same when the prompt mentions Helicon's attachment folder", () => {
    const legacy = prompt({ text: "Review the attached report\n\n@.helicon/attachments/report.pdf[Image #1]" });
    assert.equal(applyEvent(addEcho(emptyFold(), echo()), legacy).echoes.length, 0);
    const reloaded = foldFromLoad(load([legacy]), addEcho(emptyFold(), echo()));
    assert.equal(reloaded.echoes.length, 0, "a thread sent from Helicon reloads without a duplicate bubble");
    assert.equal(reloaded.order.length, 1);
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

  it("keeps a second identical steer's bubble until its own item lands", () => {
    let fold = applyEvent(emptyFold(), prompt({ text: "build it" }));
    fold = addEcho(fold, echo({ localId: "s1", text: "continue", turnId: null, disposition: "steered" }));
    fold = updateEcho(fold, "s1", { turnId: "turn", disposition: "steered" });
    fold = applyEvent(fold, prompt({ itemId: "st1", commandId: "c1", text: "continue", steered: true, revision: 1 }));
    assert.equal(fold.echoes.length, 0);
    fold = addEcho(fold, echo({ localId: "s2", text: "continue", turnId: null, disposition: "steered" }));
    fold = updateEcho(fold, "s2", { turnId: "turn", disposition: "steered" });
    assert.deepEqual(fold.echoes.map((item) => item.localId), ["s2"], "the first steer's item is not the second one's");
    fold = applyEvent(fold, prompt({ itemId: "st1", commandId: "c1", text: "continue", steered: true, revision: 2 }));
    assert.equal(fold.echoes.length, 1, "nor is a later revision of it");
    assert.equal(foldFromLoad(load([prompt({ text: "build it" }), prompt({ itemId: "st1", commandId: "c1", text: "continue", steered: true })]), fold).echoes.length, 1, "nor after a reload");
    fold = applyEvent(fold, prompt({ itemId: "st2", commandId: "c2", text: "continue", steered: true, revision: 1 }));
    assert.equal(fold.echoes.length, 0);
  });

  it("matches two identical steers sent together to their items in turn", () => {
    let fold = addEcho(emptyFold(), echo({ localId: "s1", text: "go", disposition: "steered" }));
    fold = addEcho(fold, echo({ localId: "s2", text: "go", disposition: "steered" }));
    fold = applyEvent(fold, prompt({ itemId: "st1", commandId: "c1", text: "go", steered: true, revision: 1 }));
    fold = applyEvent(fold, prompt({ itemId: "st1", commandId: "c1", text: "go", steered: true, revision: 2 }));
    assert.deepEqual(fold.echoes.map((item) => item.localId), ["s2"], "one item stands for one send");
    fold = applyEvent(fold, prompt({ itemId: "st2", commandId: "c2", text: "go", steered: true, revision: 1 }));
    assert.equal(fold.echoes.length, 0);
    let reloaded = addEcho(emptyFold(), echo({ localId: "s1", text: "go", disposition: "steered" }));
    reloaded = addEcho(reloaded, echo({ localId: "s2", text: "go", disposition: "steered" }));
    const once = foldFromLoad(load([prompt({ itemId: "st1", commandId: "c1", text: "go", steered: true })]), reloaded);
    assert.deepEqual(once.echoes.map((item) => item.localId), ["s2"], "a reload matches one item to one send as well");
  });

  it("replaces a steer sent with files whose saved text carries only the file mentions", () => {
    const fold = applyEvent(addEcho(emptyFold(), echo({ disposition: "steered" })), prompt({ itemId: "steer", commandId: "c", steered: true }));
    assert.equal(fold.echoes.length, 0);
  });

  it("does not let an older identical prompt's revision take a send still waiting for its ack", () => {
    let fold = applyEvent(emptyFold(), prompt({ text: "continue" }));
    fold = addEcho(fold, echo({ localId: "later", text: "continue", turnId: null, disposition: "queued" }));
    fold = applyEvent(fold, prompt({ text: "continue", revision: 3 }));
    assert.deepEqual(fold.echoes.map((item) => item.localId), ["later"]);
    fold = applyEvent(fold, prompt({ itemId: "next", turnId: "future", commandId: "future", text: "continue" }));
    assert.equal(fold.echoes.length, 0, "its own prompt still replaces it before the ack");
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
