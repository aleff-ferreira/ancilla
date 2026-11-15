import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addEcho,
  applyEvent,
  emptyFold,
  foldFromLoad,
  updateEcho,
  type LocalEcho,
} from "../src/model/fold.js";
import type { MspItem, TranscriptLoad, ViewEvent } from "../src/types.js";

function makeEchoItem(patch: Partial<LocalEcho> = {}): LocalEcho {
  return {
    localId: "local",
    text: "Review the attached report",
    turnId: "turn",
    disposition: "started",
    createdAt: 1,
    ...patch,
  };
}

function makePromptEvent(patch: Partial<MspItem> = {}): ViewEvent {
  const item: MspItem = {
    itemId: "user",
    kind: "userMessage",
    revision: 2,
    status: "completed",
    turnId: "turn",
    commandId: "turn",
    text: "Review the attached report\n\n@.ancilla/attachments/report.pdf[Image #1]",
    ...patch,
  };
  return {
    method: "item/completed",
    params: { item },
  };
}

function makeLoadSnapshot(eventList: ViewEvent[]): TranscriptLoad {
  return {
    session: null,
    msp: null,
    events: eventList,
    truncated: false,
    pending: { approvals: [], userInputs: [] },
    readOnly: false,
    readOnlyReason: null,
  };
}

describe("prompt attachment and local preview reconciliation", () => {
  it("replaces an acknowledged PDF/image preview despite Muse's expanded body", () => {
    const priorState = addEcho(emptyFold(), makeEchoItem());
    const nextState = applyEvent(priorState, makePromptEvent());

    assert.strictEqual(nextState.echoes.length, 0);
    assert.strictEqual(nextState.order.length, 1);
    assert.strictEqual(priorState.echoes.length, 1, "the previous fold is immutable");
  });

  it("replaces the preview just the same when the prompt mentions an attachment folder", () => {
    const promptWithFolder = makePromptEvent({
      text: "Review the attached report\n\n@.ancilla/attachments/report.pdf[Image #1]",
    });
    const foldWithEcho = addEcho(emptyFold(), makeEchoItem());
    const updated = applyEvent(foldWithEcho, promptWithFolder);
    assert.strictEqual(updated.echoes.length, 0);

    const reloaded = foldFromLoad(makeLoadSnapshot([promptWithFolder]), foldWithEcho);
    assert.strictEqual(reloaded.echoes.length, 0, "a thread reloads without duplicate bubble");
    assert.strictEqual(reloaded.order.length, 1);
  });

  it("reconciles an attachment-only prompt when its item arrives before the ack", () => {
    const pendingSendEcho = makeEchoItem({ text: "", turnId: null, disposition: "sending" });
    let foldState = addEcho(emptyFold(), pendingSendEcho);

    foldState = applyEvent(foldState, makePromptEvent({ text: "[Image #1]" }));
    assert.strictEqual(foldState.echoes.length, 1);

    foldState = updateEcho(foldState, "local", { turnId: "turn", disposition: "started" });
    assert.strictEqual(foldState.echoes.length, 0);
    assert.strictEqual(foldState.order.length, 1);
  });

  it("recognizes the command id when a prompt does not carry a turn id", () => {
    const targetEvent = makePromptEvent({ turnId: undefined });
    const foldState = applyEvent(addEcho(emptyFold(), makeEchoItem()), targetEvent);
    assert.strictEqual(foldState.echoes.length, 0);
  });
});

describe("concurrency and duplicate prompt disambiguation", () => {
  it("reconciles rewritten prompts across reload without dropping queued or unacknowledged repeats", () => {
    let baseFold = addEcho(emptyFold(), makeEchoItem());
    baseFold = addEcho(baseFold, makeEchoItem({ localId: "queued", turnId: "future", disposition: "queued" }));
    baseFold = addEcho(baseFold, makeEchoItem({ localId: "sending", turnId: null, disposition: "sending" }));

    const reloadedFold = foldFromLoad(makeLoadSnapshot([makePromptEvent()]), baseFold);
    assert.deepStrictEqual(reloadedFold.echoes.map((entry) => entry.localId), ["queued", "sending"]);
    assert.strictEqual(reloadedFold.order.length, 1);
  });

  it("does not consume another acknowledged send when an older identical prompt is revised", () => {
    let workingFold = applyEvent(emptyFold(), makePromptEvent({ text: "continue" }));
    workingFold = addEcho(workingFold, makeEchoItem({ text: "continue", turnId: "future", disposition: "queued" }));

    workingFold = applyEvent(workingFold, makePromptEvent({ text: "continue", revision: 3 }));
    assert.strictEqual(workingFold.echoes.length, 1);

    const nextPrompt = makePromptEvent({ itemId: "next", turnId: "future", commandId: "future", text: "continue" });
    workingFold = applyEvent(workingFold, nextPrompt);
    assert.strictEqual(workingFold.echoes.length, 0);
    assert.strictEqual(workingFold.order.length, 2, "both real repeated prompts remain in history");
  });

  it("does not let an older identical prompt's revision take a send still waiting for its ack", () => {
    let workingFold = applyEvent(emptyFold(), makePromptEvent({ text: "continue" }));
    workingFold = addEcho(workingFold, makeEchoItem({ localId: "later", text: "continue", turnId: null, disposition: "queued" }));

    workingFold = applyEvent(workingFold, makePromptEvent({ text: "continue", revision: 3 }));
    assert.deepStrictEqual(workingFold.echoes.map((entry) => entry.localId), ["later"]);

    const subsequentPrompt = makePromptEvent({ itemId: "next", turnId: "future", commandId: "future", text: "continue" });
    workingFold = applyEvent(workingFold, subsequentPrompt);
    assert.strictEqual(workingFold.echoes.length, 0, "its own prompt still replaces it before the ack");
  });

  it("pairs two queued sends with the same text with their own turns", () => {
    let foldState = applyEvent(emptyFold(), { method: "turn/started", params: { turnId: "turn" } });
    foldState = addEcho(foldState, makeEchoItem({ localId: "q1", text: "then tests", turnId: null, disposition: "queued" }));
    foldState = addEcho(foldState, makeEchoItem({ localId: "q2", text: "then tests", turnId: null, disposition: "queued" }));

    foldState = updateEcho(foldState, "q1", { turnId: "next", disposition: "queued" });
    foldState = updateEcho(foldState, "q2", { turnId: "later", disposition: "queued" });

    foldState = applyEvent(foldState, { method: "turn/started", params: { turnId: "next" } });
    foldState = applyEvent(foldState, makePromptEvent({ itemId: "n", turnId: "next", commandId: "next", text: "then tests" }));
    assert.deepStrictEqual(
      foldState.echoes.map((entry) => [entry.localId, entry.disposition]),
      [["q2", "queued"]],
    );

    foldState = applyEvent(foldState, { method: "turn/started", params: { turnId: "later" } });
    foldState = applyEvent(foldState, makePromptEvent({ itemId: "l", turnId: "later", commandId: "later", text: "then tests" }));
    assert.strictEqual(foldState.echoes.length, 0);
  });
});

describe("steered prompt echo lifecycle", () => {
  it("does not match a steer to the original prompt sharing its active turn", () => {
    let foldState = applyEvent(emptyFold(), makePromptEvent({ text: "continue" }));
    foldState = addEcho(foldState, makeEchoItem({ text: "continue", turnId: null, disposition: "steered" }));
    foldState = updateEcho(foldState, "local", { turnId: "turn", disposition: "steered" });
    assert.strictEqual(foldState.echoes.length, 1);

    foldState = applyEvent(foldState, makePromptEvent({ text: "continue", revision: 3 }));
    assert.strictEqual(foldState.echoes.length, 1);

    const steerEvent = makePromptEvent({ itemId: "steer", commandId: "steer-command", text: "continue", steered: true });
    foldState = applyEvent(foldState, steerEvent);
    assert.strictEqual(foldState.echoes.length, 0);
  });

  it("keeps a second identical steer's bubble until its own item lands", () => {
    let foldState = applyEvent(emptyFold(), makePromptEvent({ text: "build it" }));
    foldState = addEcho(foldState, makeEchoItem({ localId: "s1", text: "continue", turnId: null, disposition: "steered" }));
    foldState = updateEcho(foldState, "s1", { turnId: "turn", disposition: "steered" });

    const firstSteer = makePromptEvent({ itemId: "st1", commandId: "c1", text: "continue", steered: true, revision: 1 });
    foldState = applyEvent(foldState, firstSteer);
    assert.strictEqual(foldState.echoes.length, 0);

    foldState = addEcho(foldState, makeEchoItem({ localId: "s2", text: "continue", turnId: null, disposition: "steered" }));
    foldState = updateEcho(foldState, "s2", { turnId: "turn", disposition: "steered" });
    assert.deepStrictEqual(foldState.echoes.map((entry) => entry.localId), ["s2"], "the first steer's item is not the second one's");

    const firstSteerRev2 = makePromptEvent({ itemId: "st1", commandId: "c1", text: "continue", steered: true, revision: 2 });
    foldState = applyEvent(foldState, firstSteerRev2);
    assert.strictEqual(foldState.echoes.length, 1, "nor is a later revision of it");

    const reloadSnapshot = makeLoadSnapshot([
      makePromptEvent({ text: "build it" }),
      makePromptEvent({ itemId: "st1", commandId: "c1", text: "continue", steered: true }),
    ]);
    assert.strictEqual(foldFromLoad(reloadSnapshot, foldState).echoes.length, 1, "nor after a reload");

    const secondSteer = makePromptEvent({ itemId: "st2", commandId: "c2", text: "continue", steered: true, revision: 1 });
    foldState = applyEvent(foldState, secondSteer);
    assert.strictEqual(foldState.echoes.length, 0);
  });

  it("matches two identical steers sent together to their items in turn", () => {
    let foldState = addEcho(emptyFold(), makeEchoItem({ localId: "s1", text: "go", disposition: "steered" }));
    foldState = addEcho(foldState, makeEchoItem({ localId: "s2", text: "go", disposition: "steered" }));

    const steerItem1 = makePromptEvent({ itemId: "st1", commandId: "c1", text: "go", steered: true, revision: 1 });
    const steerItem1Rev = makePromptEvent({ itemId: "st1", commandId: "c1", text: "go", steered: true, revision: 2 });
    foldState = applyEvent(foldState, steerItem1);
    foldState = applyEvent(foldState, steerItem1Rev);
    assert.deepStrictEqual(foldState.echoes.map((entry) => entry.localId), ["s2"], "one item stands for one send");

    const steerItem2 = makePromptEvent({ itemId: "st2", commandId: "c2", text: "go", steered: true, revision: 1 });
    foldState = applyEvent(foldState, steerItem2);
    assert.strictEqual(foldState.echoes.length, 0);

    let reloadedState = addEcho(emptyFold(), makeEchoItem({ localId: "s1", text: "go", disposition: "steered" }));
    reloadedState = addEcho(reloadedState, makeEchoItem({ localId: "s2", text: "go", disposition: "steered" }));
    const singleReload = foldFromLoad(
      makeLoadSnapshot([makePromptEvent({ itemId: "st1", commandId: "c1", text: "go", steered: true })]),
      reloadedState,
    );
    assert.deepStrictEqual(singleReload.echoes.map((entry) => entry.localId), ["s2"], "a reload matches one item to one send as well");
  });

  it("replaces a steer sent with files whose saved text carries only the file mentions", () => {
    const initialEcho = addEcho(emptyFold(), makeEchoItem({ disposition: "steered" }));
    const arrivalEvent = makePromptEvent({ itemId: "steer", commandId: "c", steered: true });
    const resolvedFold = applyEvent(initialEcho, arrivalEvent);
    assert.strictEqual(resolvedFold.echoes.length, 0);
  });

  it("pairs two identical steers with their own items when both land before either ack", () => {
    let foldState = addEcho(emptyFold(), makeEchoItem({ localId: "s1", text: "go", turnId: null, disposition: "steered" }));
    foldState = addEcho(foldState, makeEchoItem({ localId: "s2", text: "go", turnId: null, disposition: "steered" }));

    const steerA = makePromptEvent({ itemId: "st1", commandId: "c1", text: "go", steered: true });
    foldState = applyEvent(foldState, steerA);
    assert.deepStrictEqual(foldState.echoes.map((entry) => entry.localId), ["s2"]);

    const steerB = makePromptEvent({ itemId: "st2", commandId: "c2", text: "go", steered: true });
    foldState = applyEvent(foldState, steerB);
    assert.strictEqual(foldState.echoes.length, 0);

    foldState = updateEcho(updateEcho(foldState, "s1", { turnId: "turn", disposition: "steered" }), "s2", {
      turnId: "turn",
      disposition: "steered",
    });
    assert.strictEqual(foldState.echoes.length, 0, "late acknowledgements change nothing");
    assert.strictEqual(foldState.order.length, 2, "both steers stay in the thread");
  });

  it("does not match a normal prompt to a steered item with a shared turn id", () => {
    const foldState = applyEvent(
      addEcho(emptyFold(), makeEchoItem()),
      makePromptEvent({ itemId: "steer", commandId: "other", steered: true }),
    );
    assert.strictEqual(foldState.echoes.length, 1);
  });
});

describe("turn completion boundaries and race condition defenses", () => {
  it("cleans up all acknowledged echoes when their turn finishes, preserving other pending sends", () => {
    let foldState = addEcho(emptyFold(), makeEchoItem());
    foldState = addEcho(foldState, makeEchoItem({ localId: "steer", disposition: "steered" }));
    foldState = addEcho(foldState, makeEchoItem({ localId: "future", turnId: "future", disposition: "queued" }));

    foldState = applyEvent(foldState, {
      method: "turn/completed",
      params: { turnId: "turn", terminal: "completed" },
    });
    assert.deepStrictEqual(foldState.echoes.map((entry) => entry.localId), ["future"]);
  });

  it("does not resurrect a Sent bubble when the turn completed before the HTTP ack", () => {
    let foldState = addEcho(emptyFold(), makeEchoItem({ turnId: null, disposition: "sending" }));
    foldState = applyEvent(foldState, {
      method: "turn/completed",
      params: { turnId: "turn", terminal: "completed" },
    });
    foldState = updateEcho(foldState, "local", { turnId: "turn", disposition: "started" });
    assert.strictEqual(foldState.echoes.length, 0);
  });
});
