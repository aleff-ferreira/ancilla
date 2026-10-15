import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAonia } from "@harjjotsinghh/aonia";
import { FakeConnection, get, send, start } from "./harness.js";

describe("removing an account", () => {
  it("takes it off every project that had it as the default, and only those", async () => {
    const home = await mkdtemp(join(tmpdir(), "ancilla-account-removal-"));
    const aonia = createAonia({ home, platform: "linux", musePath: "muse" });
    await aonia.createProfile("work");
    await aonia.createProfile("other");
    const connection = new FakeConnection();
    let n = 0;
    connection.replies.set("session/start", () => ({ session: { sessionId: `s${++n}` } }));
    const { base } = await start(connection, { aonia });
    for (const cwd of ["/work/a", "/work/b", "/work/c", "/work/d"]) {
      assert.equal((await send(base, "/api/sessions", { cwd })).status, 200);
    }
    for (const [cwd, accountId] of [["/work/a", "work"], ["/work/b", "work"], ["/work/c", "other"]]) {
      await send(base, "/api/projects/default-account", { cwd, accountId }, "PATCH");
    }
    const defaults = async () => Object.fromEntries((await get(base, "/api/projects")).projects
      .map((project: { cwd: string; defaultAccountId: string | null }) => [project.cwd, project.defaultAccountId]));
    assert.deepEqual(await defaults(), { "/work/a": "work", "/work/b": "work", "/work/c": "other", "/work/d": null });

    assert.equal((await send(base, "/api/accounts/work", undefined, "DELETE")).status, 200);
    assert.deepEqual(await defaults(), { "/work/a": null, "/work/b": null, "/work/c": "other", "/work/d": null },
      "a reload cannot point a project back at the account that is gone");
  });
});
