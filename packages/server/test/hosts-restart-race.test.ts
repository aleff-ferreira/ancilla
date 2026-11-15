import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ServeTarget } from "@ancilla/daemon";
import type { HostHandle } from "../src/server.js";
import { FakeConnection, get, send, start } from "./harness.js";

/** A step of the fake host a test holds where the race has to be: `reached` says it got there, `open` lets it go on. */
function gate() {
  let open!: () => void;
  let reach!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { open, opened, reached, reach };
}

/** A host factory whose start and close each wait for a gate, and say when they have been asked. */
function gatedHosts(connection: FakeConnection) {
  const starting = gate();
  const closing = gate();
  let holdStart = false;
  let holdClose = false;
  const targets: ServeTarget[] = [];
  const factory = (target: ServeTarget): HostHandle => {
    targets.push(target);
    return {
      start: async () => {
        if (holdStart) {
          starting.reach();
          await starting.opened;
        }
        return { initializeResult: { serverInfo: { name: "muse", version: "1.1.1" } } };
      },
      connection: connection as never,
      close: async () => {
        if (holdClose) {
          closing.reach();
          await closing.opened;
        }
        return { code: 0, signal: null };
      },
      onExit: () => undefined,
    };
  };
  return {
    factory,
    targets,
    starting,
    closing,
    holdStart: () => {
      holdStart = true;
    },
    holdClose: () => {
      holdClose = true;
    },
  };
}

const POSTED = /still open/;

async function thread(connection: FakeConnection, hosts = gatedHosts(connection)) {
  connection.replies.set("session/start", { session: { sessionId: "s1" } });
  const { base } = await start(connection, { hostFactory: hosts.factory });
  await send(base, "/api/sessions", { cwd: "/work/proj" });
  return { base, hosts };
}

describe("POST /api/hosts/restart and work that holds a host without a turn", () => {
  it("refuses while a compaction is in flight, and goes ahead once it is done", async () => {
    const connection = new FakeConnection();
    const compaction = gate();
    connection.replies.set("session/compact", async () => {
      compaction.reach();
      await compaction.opened;
      return { compacted: true };
    });
    const { base } = await thread(connection);
    const compacting = send(base, "/api/sessions/s1/compact", {});
    await compaction.reached;

    const refused = await send(base, "/api/hosts/restart", {});
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, POSTED);
    assert.match(refused.json.error, /compaction/);

    compaction.open();
    assert.equal((await compacting).status, 200);
    assert.equal((await send(base, "/api/hosts/restart", {})).status, 200);
  });

  it("refuses while a fork is in flight, and goes ahead once it is done", async () => {
    const connection = new FakeConnection();
    const fork = gate();
    connection.replies.set("session/fork", async () => {
      fork.reach();
      await fork.opened;
      return { session: { sessionId: "s2" } };
    });
    const { base } = await thread(connection);
    const forking = send(base, "/api/sessions/s1/fork", {});
    await fork.reached;

    assert.equal((await send(base, "/api/hosts/restart", {})).status, 409);

    fork.open();
    assert.equal((await forking).json.session.sessionId, "s2");
    assert.equal((await send(base, "/api/hosts/restart", {})).status, 200);
  });

  it("counts a compaction that fails as over", async () => {
    const connection = new FakeConnection();
    connection.replies.set("session/compact", new Error("Muse could not compact."));
    const { base } = await thread(connection);
    assert.equal((await send(base, "/api/sessions/s1/compact", {})).status >= 400, true);
    assert.equal((await send(base, "/api/hosts/restart", {})).status, 200, "a failed call does not hold the restart off for good");
  });

  it("refuses while a host is still starting, and goes ahead once it is up", async () => {
    const connection = new FakeConnection();
    const hosts = gatedHosts(connection);
    hosts.holdStart();
    const { base } = await start(connection, { hostFactory: hosts.factory });
    const listing = get(base, "/api/models");
    await hosts.starting.reached;

    // A restart that did not refuse would wait for the starting host, so the wait is bounded: a failure is a failure, not a hang.
    const slow = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000));
    const refused = await Promise.race([send(base, "/api/hosts/restart", {}), slow]);
    hosts.starting.open();
    assert.notEqual(refused, null, "the restart answered instead of waiting for the host to start");
    assert.equal(refused?.status, 409);
    assert.match(refused?.json.error, /host start/);
    // The host here starts for a model list: no thread exists, so the reason must not promise one.
    assert.doesNotMatch(refused?.json.error, /thread/);
    assert.equal(hosts.targets.length, 1, "nothing was closed or started for it");

    await listing;
    assert.equal((await send(base, "/api/hosts/restart", {})).status, 200);
  });
});

describe("POST /api/hosts/restart queued behind another restart", () => {
  it("asks again when its turn comes, and answers 409 if something started meanwhile", async () => {
    const connection = new FakeConnection();
    const compaction = gate();
    connection.replies.set("session/compact", async () => {
      compaction.reach();
      await compaction.opened;
      return { compacted: true };
    });
    const hosts = gatedHosts(connection);
    const { base } = await thread(connection, hosts);

    // A settings flip restarts the hosts, and closing the one this thread is on takes a while.
    hosts.holdClose();
    assert.equal((await send(base, "/api/yolo-settings", { enabled: true }, "PATCH")).status, 200);
    await hosts.closing.reached;

    // Idle now, so the restart is accepted and queued behind the flip's.
    let answered: { status: number; json: any } | null = null;
    const restart = send(base, "/api/hosts/restart", {}).then((answer) => {
      answered = answer;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(answered, null, "it waits for the flip's restart");

    // The thread's host is still up while it is being closed, so a compaction can begin on it meanwhile.
    const compacting = send(base, "/api/sessions/s1/compact", {});
    await compaction.reached;

    hosts.closing.open();
    const late = await restart;
    assert.equal(late.status, 409, "the restart that was idle when it queued is not idle when its turn comes");
    assert.match(late.json.error, POSTED);

    compaction.open();
    assert.equal((await compacting).status, 200);
    assert.equal((await send(base, "/api/hosts/restart", {})).status, 200, "and goes ahead once the compaction is over");
  });

  it("goes ahead when nothing started meanwhile", async () => {
    const connection = new FakeConnection();
    const hosts = gatedHosts(connection);
    const { base } = await thread(connection, hosts);
    hosts.holdClose();
    await send(base, "/api/yolo-settings", { enabled: true }, "PATCH");
    await hosts.closing.reached;
    let answered = false;
    const restart = send(base, "/api/hosts/restart", {}).then((answer) => {
      answered = true;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(answered, false, "queued behind the flip's restart");
    hosts.closing.open();
    assert.equal((await restart).status, 200);
  });
});
