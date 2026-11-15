import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AncillaStore } from "@ancilla/daemon";
import { FakeConnection, fakeFactory, send, start, type FactoryProbe } from "./harness.js";

const RANGE = { first: { id: "r", sequence: 1 }, last: { id: "r", sequence: 1 }, stream: { id: "s", kind: "session" } };

class MspTestError extends Error {
  constructor(
    message: string,
    readonly kind: string,
  ) {
    super(message);
  }
}

/**
 * The `model/list` answer a Muse 1.4.7 host gave on this machine: Muse's built-in list, one row, with no
 * `profileId` of its own on the row and the provider and profile on the answer itself.
 */
const BUNDLED_CATALOG = {
  models: [
    {
      contextLimit: null,
      cost: null,
      defaultReasoningEffort: "high",
      description: null,
      displayLabel: "muse-spark-1.3",
      isActive: false,
      isDefault: false,
      modelId: "muse-spark-1.3",
      outputLimit: null,
      profileId: null,
      providerId: "meta",
      reasoningEffortVariants: [],
      releaseDate: null,
      variants: ["minimal", "low", "medium", "high", "xhigh"],
    },
  ],
  profileId: "tbh",
  providerId: "meta",
  source: "bundledCatalog",
};

const SPARK = "muse-spark-1.3";
const WONDER = "muse-wonder-1.0";

/**
 * One thread on a fake host that keeps whatever model it was last given, the way a live host does, and answers a
 * resume with it. `restartOn` is a host that came back (after a restart) on another model.
 */
async function bundledThread(options: { pin?: string; probe?: FactoryProbe } = {}) {
  const connection = new FakeConnection();
  let hostModel = SPARK;
  connection.replies.set("model/list", BUNDLED_CATALOG);
  connection.replies.set("session/start", (params: Record<string, unknown>) => {
    hostModel = typeof params["modelId"] === "string" ? params["modelId"] : hostModel;
    return { session: { sessionId: "s1", modelId: hostModel } };
  });
  connection.replies.set("session/setModel", (params: Record<string, unknown>) => {
    hostModel = (params["model"] as { modelId: string }).modelId;
    return { ok: true };
  });
  connection.replies.set("session/resume", () => ({ session: { sessionId: "s1", status: "idle", activeTurnId: null, turnCount: 1, modelId: hostModel } }));
  connection.replies.set("view/page", { events: [], nextCursor: null });
  connection.replies.set("approval/listPending", { approvals: [], userInputs: [] });
  const { server, base } = await start(connection, options.probe ? { hostFactory: fakeFactory(connection, options.probe) } : {});
  await send(base, "/api/sessions", { cwd: "/work/proj", ...(options.pin ? { modelId: options.pin } : {}) });
  const store = server["store"] as AncillaStore;
  return {
    connection,
    server,
    base,
    store,
    sets: () => connection.calls.filter((call) => call.method === "session/setModel"),
    model: (modelId: string) => send(base, "/api/sessions/s1/model", { model: { modelId } }),
    resume: async () => (await send(base, "/api/sessions/s1/resume", {})).json.msp.modelId as string,
    restartOn: (modelId: string) => {
      hostModel = modelId;
    },
    stored: () => {
      const record = store.getSession("s1");
      return { modelId: record?.modelId ?? null, chosenModelId: record?.chosenModelId ?? null };
    },
    notify: (method: string, params: Record<string, unknown>) =>
      connection.notify(method, { sessionId: "s1", viewCursor: "v:1", sourceRange: RANGE, ...params }),
  };
}

describe("a model switch on a host that sends only Muse's built-in list (Muse 1.4.7)", () => {
  it("tries Wonder on a thread started with a pin, and does not put the pin back on the next resume", async () => {
    const { store, sets, model, resume, restartOn, stored } = await bundledThread({ pin: SPARK });
    assert.deepEqual(stored(), { modelId: SPARK, chosenModelId: SPARK }, "the thread starts with the saved pick pinned");

    assert.equal((await model(WONDER)).status, 200);
    // The list has no Wonder row, so the selection takes the provider and profile of the answer itself.
    assert.deepEqual(sets()[0]?.params?.["model"], { modelId: WONDER, providerId: "meta", profileId: "tbh" });
    assert.deepEqual(stored(), { modelId: WONDER, chosenModelId: null }, "a trial is no pick, and the old pin is not left standing");

    assert.equal(await resume(), WONDER, "the host kept the trial, so the thread reads as on Wonder");
    assert.equal(sets().length, 1, "and nothing was put back");

    // A host that comes back after a restart answers with the model it started on; the host's model wins.
    restartOn(SPARK);
    assert.equal(await resume(), SPARK);
    assert.equal(sets().length, 1, "the pin is not restored over the trial");
    assert.equal(store.getSession("s1")?.chosenModelId, null);
  });

  it("clears the older pin at the moment Muse announces the trial, even before the reply", async () => {
    const { connection, sets, model, resume, restartOn, notify, store } = await bundledThread({ pin: SPARK });
    let chosenWhenAnnounced: string | null | undefined;
    connection.replies.set("session/setModel", () => {
      notify("session/modelChanged", { modelId: WONDER, source: "user" });
      chosenWhenAnnounced = store.getSession("s1")?.chosenModelId;
      return { ok: true };
    });
    assert.equal((await model(WONDER)).status, 200);
    assert.equal(chosenWhenAnnounced, null, "the announcement of a trial is not a pick and leaves no older one behind");
    restartOn(SPARK);
    assert.equal(await resume(), SPARK);
    assert.equal(sets().length, 1);
  });

  it("does not put a typo Muse accepted back on a later resume", async () => {
    const { sets, model, resume, restartOn, stored } = await bundledThread({ pin: SPARK });
    // 1.4.7 accepts any id and finds a wrong one out at the next turn.
    assert.equal((await model("muse-wonder-1.O")).status, 200);
    assert.deepEqual(stored(), { modelId: "muse-wonder-1.O", chosenModelId: null });
    restartOn(SPARK);
    assert.equal(await resume(), SPARK);
    assert.equal(sets().length, 1, "the typo is never sent again");
  });

  it("stores nothing for a switch Muse refuses, and the pin stands", async () => {
    const { connection, sets, model, resume, restartOn, stored } = await bundledThread({ pin: SPARK });
    connection.replies.set("session/setModel", new MspTestError("That model is not offered.", "modelNotOffered"));
    const refused = await model(WONDER);
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /not offered/);
    assert.deepEqual(stored(), { modelId: SPARK, chosenModelId: SPARK }, "neither the id nor the pick changed");
    // The pin is still the pick: a host that comes back on another model has it put back.
    connection.replies.set("session/setModel", { ok: true });
    restartOn("muse-spark-1.2");
    assert.equal(await resume(), SPARK);
    assert.equal(sets().length, 2);
  });

  it("keeps a pick the list names, and puts it back when the host comes back elsewhere", async () => {
    const { sets, model, resume, restartOn, stored } = await bundledThread();
    assert.equal((await model(SPARK)).status, 200);
    assert.deepEqual(sets()[0]?.params?.["model"], { modelId: SPARK, providerId: "meta", profileId: null, displayLabel: "muse-spark-1.3" }, "the row's own selection");
    assert.deepEqual(stored(), { modelId: SPARK, chosenModelId: SPARK });
    restartOn("muse-spark-1.2");
    assert.equal(await resume(), SPARK);
    assert.equal(sets().length, 2, "a listed id is a pick, restored when the host answers with another model");
  });

  it("lets a listed pick replace a trial", async () => {
    const { model, stored, resume, restartOn } = await bundledThread({ pin: SPARK });
    await model(WONDER);
    assert.equal(stored().chosenModelId, null);
    await model(SPARK);
    assert.deepEqual(stored(), { modelId: SPARK, chosenModelId: SPARK });
    restartOn(WONDER);
    assert.equal(await resume(), SPARK);
  });
});

describe("the trials a thread is remembered by", () => {
  it("are dropped when the session closes", async () => {
    const { server, model, notify, stored } = await bundledThread({ pin: SPARK });
    await model(WONDER);
    assert.equal(server["modelTrials"].size, 1);
    notify("session/closed", {});
    assert.equal(server["modelTrials"].size, 0);
    // With the mark gone, the same id announced by the user later is a pick like any other.
    notify("session/modelChanged", { modelId: WONDER, source: "user" });
    assert.deepEqual(stored(), { modelId: WONDER, chosenModelId: WONDER });
  });

  it("are dropped when the host is forgotten", async () => {
    const probe: FactoryProbe = { targets: [], exits: [] };
    const { server, base, model } = await bundledThread({ pin: SPARK, probe });
    await model(WONDER);
    assert.equal(server["modelTrials"].size, 1);
    assert.equal((await send(base, "/api/hosts/restart", {})).status, 200);
    assert.equal(server["modelTrials"].size, 0);
  });

  it("are kept for the id tried, and cleared by a pick the list names", async () => {
    const { server, model } = await bundledThread({ pin: SPARK });
    await model(WONDER);
    assert.equal(server["modelTrials"].get("s1"), WONDER);
    await model(SPARK);
    assert.equal(server["modelTrials"].has("s1"), false);
  });
});

describe("the log line for a trial", () => {
  /** Everything the server writes to stderr while `work` runs, one string per record. */
  async function logging(work: () => Promise<void>): Promise<string[]> {
    const logged: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await work();
    } finally {
      process.stderr.write = write;
    }
    return logged.join("").split("\n").filter((line) => line.length > 0);
  }

  it("names the list it came from and keeps an id with a line break in it in one record", async () => {
    const { model } = await bundledThread({ pin: SPARK });
    const forged = `${WONDER}\n[ancilla] forged record`;
    const records = await logging(async () => {
      assert.equal((await model(forged)).status, 200);
    });
    const tried = records.filter((line) => line.includes(" tries "));
    assert.equal(tried.length, 1);
    assert.match(tried[0] ?? "", /Muse's bundledCatalog list does not name/);
    assert.match(tried[0] ?? "", /forged record/, "the id is in the record, escaped");
    assert.ok(!records.some((line) => line.startsWith("[ancilla] forged")), "and it did not start a record of its own");
  });

  it("does not make up a source when the list names none", async () => {
    const { connection, model } = await bundledThread({ pin: SPARK });
    connection.replies.set("model/list", { ...BUNDLED_CATALOG, source: null });
    const records = await logging(async () => {
      assert.equal((await model(WONDER)).status, 200);
    });
    const tried = records.filter((line) => line.includes(" tries "));
    assert.equal(tried.length, 1);
    assert.match(tried[0] ?? "", /which Muse's list does not name/);
    assert.doesNotMatch(tried[0] ?? "", /unknown/);
  });

  it("says nothing for a pick the list names", async () => {
    const { model } = await bundledThread({ pin: SPARK });
    const records = await logging(async () => {
      assert.equal((await model(SPARK)).status, 200);
    });
    assert.equal(records.some((line) => line.includes(" tries ")), false);
  });
});
