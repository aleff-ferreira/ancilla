import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AncillaServer } from "../src/server.js";
import { FakeConnection, fakeFactory, get, send } from "./harness.js";

/** The Sentinel's routes through a real server: that they are wired in, behind the same door as the rest of `/api`, and idle by default. */

async function start() {
  const home = await mkdtemp(join(tmpdir(), "ancilla-sentinel-home-"));
  const server = new AncillaServer({
    port: 0,
    dataDir: ":memory:",
    platform: "linux",
    musePath: "muse",
    home,
    hostFactory: fakeFactory(new FakeConnection()),
    exec: async () => ({ stdout: "", exitCode: 127 }),
  });
  after(async () => {
    await server.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });
  return `http://127.0.0.1:${(await server.listen()).port}`;
}

describe("the Sentinel through the server", () => {
  it("answers under /api/assistant/desktop with Watch and Act off, and nothing running", async () => {
    const base = await start();
    const status = await get(base, "/api/assistant/desktop");
    assert.deepEqual(status.settings, { watch: false, act: false });
    assert.equal(status.watching, false);
    assert.equal(status.collector.state, "off");
    assert.deepEqual(status.open, []);
  });

  it("changes a setting, refuses a bad one, and keeps an audit whose chain holds", async () => {
    const base = await start();
    const changed = await send(base, "/api/assistant/desktop/settings", { act: true }, "PATCH");
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.json.settings, { watch: false, act: true });
    assert.equal((await get(base, "/api/assistant/desktop")).settings.act, true);
    const refused = await send(base, "/api/assistant/desktop/settings", { elevate: true }, "PATCH");
    assert.equal(refused.status, 400);
    assert.equal(refused.json.kind, "invalid");
    const audit = await get(base, "/api/assistant/desktop/audit/verify");
    assert.equal(audit.check.ok, true);
    assert.equal(audit.check.entries, 1);
  });

  it("lists nothing for a machine that has not been watched, and says nothing is at a path it does not have", async () => {
    const base = await start();
    assert.deepEqual((await get(base, "/api/assistant/desktop/findings")).findings, []);
    assert.equal((await get(base, "/api/assistant/desktop/digest")).digest.total, 0);
    const missing = await send(base, "/api/assistant/desktop/nothing", undefined, "GET");
    assert.equal(missing.status, 404);
  });
});
