/**
 * The server's side of choosing the Muse model a call thinks with: a thread the call makes starts on that model, a
 * thread the conversation already had is put on it once (and left alone when it is on it), and a switch Muse refuses is
 * an error that changes nothing. It runs through the host the voice and the task executive share, against a Muse double
 * that keeps whatever model it was last given, the way a live host does.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AncillaStore } from "@ancilla/daemon";
import type { ExecutiveHost } from "../src/assistant/executive.js";
import { FakeConnection, start } from "./harness.js";

const SPARK = "muse-spark-1.3";
const WONDER = "muse-wonder-1.0";

/** What a Muse 1.4.7 host answers to `model/list`: its built-in list, one row, with the provider and profile on the answer. */
const BUNDLED_CATALOG = {
  models: [{ contextLimit: null, cost: null, description: null, displayLabel: SPARK, isActive: false, isDefault: false, modelId: SPARK, outputLimit: null, profileId: null, providerId: "meta", reasoningEffortVariants: [] }],
  profileId: "tbh",
  providerId: "meta",
  source: "bundledCatalog",
};

async function rig() {
  const connection = new FakeConnection();
  let hostModel = SPARK;
  let made = 0;
  connection.replies.set("model/list", BUNDLED_CATALOG);
  connection.replies.set("session/start", (params: Record<string, unknown>) => {
    hostModel = typeof params["modelId"] === "string" ? params["modelId"] : SPARK;
    return { session: { sessionId: `s${++made}`, modelId: hostModel } };
  });
  connection.replies.set("session/setModel", (params: Record<string, unknown>) => {
    hostModel = (params["model"] as { modelId: string }).modelId;
    return { ok: true };
  });
  const { server } = await start(connection);
  const host = server["assistantHost"]() as ExecutiveHost;
  const store = server["store"] as AncillaStore;
  return { connection, host, store };
}

describe("the Muse host a call thinks in, with a model chosen for the voice", () => {
  it("starts the thread on the model, names it for the call, and remembers it as the pick", async () => {
    const { connection, host, store } = await rig();
    const { sessionId } = await host.startSession({ cwd: "/work/proj", account: null, title: "Voice with Vesper", modelId: WONDER });
    assert.equal(connection.of("session/start")[0]?.params?.["modelId"], WONDER, "Muse is asked to start on it");
    assert.deepEqual({ modelId: store.getSession(sessionId)?.modelId, chosen: store.getSession(sessionId)?.chosenModelId }, { modelId: WONDER, chosen: WONDER });
    assert.equal(store.getSession(sessionId)?.title, "Voice with Vesper");
  });

  it("leaves the model to Muse when none was chosen, as a task does", async () => {
    const { connection, host } = await rig();
    await host.startSession({ cwd: "/work/proj", account: null, title: "Voice" });
    await host.startSession({ cwd: "/work/proj", account: null, title: "Voice", modelId: null });
    for (const call of connection.of("session/start")) assert.equal("modelId" in (call.params ?? {}), false, "no model is named");
  });

  it("puts a thread that began on another model on the chosen one, once", async () => {
    const { connection, host, store } = await rig();
    const { sessionId } = await host.startSession({ cwd: "/work/proj", account: null, title: "Voice", modelId: WONDER });
    await host.setModel?.(sessionId, SPARK);
    assert.equal(connection.of("session/setModel").length, 1);
    // The model is in the catalog, so the selection is the catalog's own row.
    assert.deepEqual(connection.of("session/setModel")[0]?.params?.["model"], { modelId: SPARK, providerId: "meta", profileId: null, displayLabel: SPARK });
    assert.equal(store.getSession(sessionId)?.chosenModelId, SPARK, "the voice's pick is the thread's pick");
    await host.setModel?.(sessionId, SPARK);
    assert.equal(connection.of("session/setModel").length, 1, "a thread that is on it is not asked again");
  });

  it("tries a model the list does not name, for this thread only, as the picker does", async () => {
    const { connection, host, store } = await rig();
    const { sessionId } = await host.startSession({ cwd: "/work/proj", account: null, title: "Voice" });
    await host.setModel?.(sessionId, WONDER);
    assert.deepEqual(connection.of("session/setModel")[0]?.params?.["model"], { modelId: WONDER, providerId: "meta", profileId: "tbh" }, "the provider and profile of the list itself");
    assert.deepEqual({ modelId: store.getSession(sessionId)?.modelId, chosen: store.getSession(sessionId)?.chosenModelId }, { modelId: WONDER, chosen: null }, "a trial is no pick");
  });

  it("says so when Muse refuses the switch, and changes nothing", async () => {
    const { connection, host, store } = await rig();
    const { sessionId } = await host.startSession({ cwd: "/work/proj", account: null, title: "Voice", modelId: SPARK });
    connection.replies.set("session/setModel", new Error("That model is not offered."));
    await assert.rejects(() => host.setModel?.(sessionId, WONDER) ?? Promise.resolve(), /not offered/);
    assert.deepEqual({ modelId: store.getSession(sessionId)?.modelId, chosen: store.getSession(sessionId)?.chosenModelId }, { modelId: SPARK, chosen: SPARK });
  });
});
