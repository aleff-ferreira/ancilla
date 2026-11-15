// Unit tests for path resolution and directory endpoints
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as asyncFs from "node:fs/promises";
import * as osContext from "node:os";
import * as pathUtils from "node:path";
import { PathError, resolveUserPath } from "../src/paths.js";
import { AncillaServer } from "../src/server.js";
async function executeJsonQuery(
  apiRoot: string,
  relativePath: string,
  dataPayload?: unknown,
  httpVerb = dataPayload === undefined ? "GET" : "POST",
) {
  const fetchResponse = await fetch(`${apiRoot}${relativePath}`, {
    method: httpVerb,
    headers: dataPayload === undefined ? undefined : { "content-type": "application/json" },
    body: dataPayload === undefined ? undefined : JSON.stringify(dataPayload),
  });
  return { status: fetchResponse.status, json: (await fetchResponse.json()) as any };
}
describe("typed paths resolution", () => {
  it("translates WSL distribution, mount points, and home directories to Windows paths", () => {
    const winHostEnv = { platform: "win32", home: "C:\\Users\\dev", distro: "Ubuntu" };
    assert.deepEqual(resolveUserPath("/mnt/d/work/", winHostEnv), {
      local: "D:\\work",
      display: "/mnt/d/work",
      flavor: "posix",
    });
    assert.equal(
      resolveUserPath("/home/dev/app", winHostEnv).local,
      "\\\\wsl.localhost\\Ubuntu\\home\\dev\\app",
    );
    assert.equal(resolveUserPath("~/code", winHostEnv).display, "C:\\Users\\dev\\code");
    assert.equal(resolveUserPath("D:/Projects/", winHostEnv).display, "D:\\Projects");
    assert.throws(() => resolveUserPath("projects", winHostEnv), PathError);
    assert.throws(() => resolveUserPath("/home/dev", { ...winHostEnv, distro: null }), PathError);
  });
  it("handles directory listing, on-demand folder creation, and clone target validation via REST API", async () => {
    const tempWorkspace = await asyncFs.mkdtemp(pathUtils.join(osContext.tmpdir(), "ancilla-clean-fs-"));
    after(() => asyncFs.rm(tempWorkspace, { recursive: true, force: true }));
    await asyncFs.mkdir(pathUtils.join(tempWorkspace, "beta"));
    await asyncFs.mkdir(pathUtils.join(tempWorkspace, "Alpha"));
    await asyncFs.mkdir(pathUtils.join(tempWorkspace, ".cache"));
    await asyncFs.writeFile(pathUtils.join(tempWorkspace, "notes.txt"), "");
    await asyncFs.writeFile(pathUtils.join(tempWorkspace, "beta", "README.md"), "");
    const runningServer = new AncillaServer({
      port: 0,
      dataDir: ":memory:",
      platform: process.platform === "win32" ? "win32" : "linux",
      home: tempWorkspace,
      distro: "Ubuntu",
      musePath: "muse",
      hostFactory: () => {
        throw new Error("No Muse host needed for fs test");
      },
      opener: async () => {},
    });
    after(() => runningServer.close());
    const boundInfo = await runningServer.listen();
    const serverOrigin = `http://127.0.0.1:${boundInfo.port}`;
    const listReply = await executeJsonQuery(serverOrigin, `/api/fs/list?path=${encodeURIComponent("~/")}`);
    assert.equal(listReply.status, 200);
    assert.equal(listReply.json.exists, true);
    assert.equal(listReply.json.directory, tempWorkspace);
    assert.deepEqual(
      [...listReply.json.entries.map((item: { name: string }) => item.name)].sort(),
      [".cache", "Alpha", "beta"],
    );
    const missingReply = await executeJsonQuery(serverOrigin, `/api/fs/list?path=${encodeURIComponent("~/nonexistent/")}`);
    assert.equal(missingReply.json.exists, false);
    const relativeReply = await executeJsonQuery(serverOrigin, `/api/fs/list?path=relative_path`);
    assert.equal(relativeReply.status, 400);
    const createProjectCall = await executeJsonQuery(serverOrigin, "/api/projects", { cwd: "~/fresh/app", create: true });
    assert.equal(createProjectCall.status, 200);
    assert.equal(createProjectCall.json.project.cwd, pathUtils.join(tempWorkspace, "fresh", "app"));
    assert.equal((await asyncFs.stat(pathUtils.join(tempWorkspace, "fresh", "app"))).isDirectory(), true);
    const conflictCloneCall = await executeJsonQuery(serverOrigin, "/api/projects/clone", {
      url: "https://example.com/repo.git",
      path: "~/beta",
    });
    assert.equal(conflictCloneCall.status, 409);
    const invalidCloneCall = await executeJsonQuery(serverOrigin, "/api/projects/clone", {
      url: "not a url",
      path: "~/invalid",
    });
    assert.equal(invalidCloneCall.status, 400);
    const revealTargetCall = await executeJsonQuery(serverOrigin, "/api/fs/reveal", { path: "~/beta" });
    assert.equal(revealTargetCall.status, 200);
    const revealMissingCall = await executeJsonQuery(serverOrigin, "/api/fs/reveal", { path: "~/nonexistent" });
    assert.equal(revealMissingCall.status, 404);
  });
});
