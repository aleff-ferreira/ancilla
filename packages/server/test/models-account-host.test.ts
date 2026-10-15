import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAonia } from "@harjjotsinghh/aonia";
import type { ServeTarget } from "@ancilla/daemon";
import type { HostHandle } from "../src/server.js";
import { FakeConnection, fakeFactory, get, send, start, type FactoryProbe } from "./harness.js";

/** A `model/list` answer in Muse's shape; `profileId` tells one host's catalog from another's. */
function catalog(ids: string[], profileId: string) {
  return {
    source: "providerCatalog",
    providerId: "meta",
    profileId,
    models: ids.map((modelId) => ({ modelId, displayLabel: modelId, providerId: "meta", profileId, isActive: false })),
  };
}

/**
 * The default login on one fake connection, and a named account whose hosts take the next of `work` in the order
 * they are started: the first host the account gets is `work[0]`, the second `work[1]`.
 */
async function accounts(t: { after: (fn: () => Promise<void>) => void }, work: FakeConnection[]) {
  const defaults = new FakeConnection();
  const home = await mkdtemp(join(tmpdir(), "ancilla-models-host-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
  await aonia.createProfile("work");
  const probe: FactoryProbe = { targets: [], exits: [] };
  const workTargets: ServeTarget[] = [];
  let started = 0;
  const factory = (target: ServeTarget): HostHandle => {
    const isWork = target.env?.["XDG_CONFIG_HOME"]?.replaceAll("\\", "/").includes("/work/");
    if (!isWork) {
      return fakeFactory(defaults, probe)(target);
    }
    workTargets.push(target);
    const connection = work[Math.min(started, work.length - 1)] as FakeConnection;
    started += 1;
    return fakeFactory(connection, probe)(target);
  };
  const { base, server } = await start(defaults, { hostFactory: factory, aonia });
  defaults.replies.set("model/list", catalog(["muse-spark-1.3"], "tbh"));
  return { defaults, base, server, workTargets };
}

const modelLists = (connection: FakeConnection) => connection.requests.filter((call) => call.method === "model/list");
const profileOf = (answer: { models: { profileId: string } }) => answer.models.profileId;

describe("GET /api/models for a named account", () => {
  it("answers from a host of that account that is already running, and starts none of its own", async (t) => {
    const threadHost = new FakeConnection();
    const listingHost = new FakeConnection();
    threadHost.replies.set("model/list", catalog(["muse-spark-1.3", "muse-wonder-1.0"], "thread-host"));
    threadHost.replies.set("session/start", { session: { sessionId: "w1" } });
    listingHost.replies.set("model/list", catalog(["muse-spark-1.3"], "listing-host"));
    const { base, workTargets } = await accounts(t, [threadHost, listingHost]);

    assert.equal((await send(base, "/api/sessions", { cwd: "/proj", accountId: "work" })).status, 200);
    assert.equal(workTargets.length, 1, "the thread's own host");

    const answer = await get(base, "/api/models?accountId=work");
    assert.equal(profileOf(answer), "thread-host", "the running host of the account answered");
    assert.equal(workTargets.length, 1, "no listing host was started beside it");
    assert.equal(modelLists(threadHost).length, 1);
    assert.equal(modelLists(listingHost).length, 0);
    assert.equal(answer.hostVersion, "1.1.1");

    // Asked again, as every navigation does: still the same one host.
    await get(base, "/api/models?accountId=work");
    assert.equal(workTargets.length, 1);
    assert.equal(modelLists(threadHost).length, 2);
  });

  it("starts a listing host only when the account has none running, and then keeps asking that one", async (t) => {
    const listingHost = new FakeConnection();
    const threadHost = new FakeConnection();
    listingHost.replies.set("model/list", catalog(["muse-spark-1.3"], "listing-host"));
    threadHost.replies.set("model/list", catalog(["muse-spark-1.3", "muse-wonder-1.0"], "thread-host"));
    threadHost.replies.set("session/start", { session: { sessionId: "w1" } });
    const { base, workTargets } = await accounts(t, [listingHost, threadHost]);

    assert.equal(profileOf(await get(base, "/api/models?accountId=work")), "listing-host");
    assert.equal(workTargets.length, 1, "nothing of the account was running, so one host started to answer");

    // A thread in a folder runs on a host of its own; both are of the account.
    assert.equal((await send(base, "/api/sessions", { cwd: "/proj", accountId: "work" })).status, 200);
    assert.equal(workTargets.length, 2);

    assert.equal(profileOf(await get(base, "/api/models?accountId=work")), "listing-host", "the listing host first");
    assert.equal(workTargets.length, 2, "and no third host");
    assert.equal(modelLists(listingHost).length, 2);
    assert.equal(modelLists(threadHost).length, 0);
  });

  it("starts a host again, once, when a restart has left the account none", async (t) => {
    const threadHost = new FakeConnection();
    threadHost.replies.set("model/list", catalog(["muse-spark-1.3", "muse-wonder-1.0"], "thread-host"));
    threadHost.replies.set("session/start", { session: { sessionId: "w1" } });
    const listingHost = new FakeConnection();
    listingHost.replies.set("model/list", catalog(["muse-spark-1.3"], "listing-host"));
    const { base, workTargets } = await accounts(t, [threadHost, listingHost]);
    await send(base, "/api/sessions", { cwd: "/proj", accountId: "work" });
    assert.equal(profileOf(await get(base, "/api/models?accountId=work")), "thread-host");

    // After a restart nothing of the account is running, so the next ask starts a host again, once.
    assert.equal((await send(base, "/api/hosts/restart", {})).status, 200);
    assert.equal(profileOf(await get(base, "/api/models?accountId=work")), "listing-host");
    assert.equal(workTargets.length, 2);
    await get(base, "/api/models?accountId=work");
    assert.equal(workTargets.length, 2);
  });

  it("leaves the default login and a thread's own list as they were", async (t) => {
    const workHost = new FakeConnection();
    workHost.replies.set("model/list", catalog(["muse-spark-1.3", "muse-wonder-1.0"], "work-host"));
    workHost.replies.set("session/start", { session: { sessionId: "w1" } });
    const { defaults, base, workTargets } = await accounts(t, [workHost]);
    await send(base, "/api/sessions", { cwd: "/proj", accountId: "work" });

    assert.equal(profileOf(await get(base, "/api/models")), "tbh", "no account: the default login's host");
    assert.equal(modelLists(defaults).length, 1);
    assert.equal(modelLists(workHost).length, 0);

    const own = await get(base, "/api/models?sessionId=w1");
    assert.equal(profileOf(own), "work-host");
    assert.equal(modelLists(workHost).at(-1)?.params?.["sessionId"], "w1", "a thread's list still flags its active row");
    assert.equal(workTargets.length, 1);
  });

  it("still refuses an account that is gone, even while a host of it is up", async (t) => {
    const workHost = new FakeConnection();
    workHost.replies.set("model/list", catalog(["muse-spark-1.3"], "work-host"));
    workHost.replies.set("session/start", { session: { sessionId: "w1" } });
    const { base } = await accounts(t, [workHost]);
    await send(base, "/api/sessions", { cwd: "/proj", accountId: "work" });
    assert.equal((await send(base, "/api/models?accountId=work", undefined, "GET")).status, 200);

    assert.equal((await send(base, "/api/accounts/work", undefined, "DELETE")).status, 200);
    const gone = await send(base, "/api/models?accountId=work", undefined, "GET");
    assert.equal(gone.status, 400);
    assert.equal(modelLists(workHost).length, 1, "the host of a removed account is not asked");
  });
});
