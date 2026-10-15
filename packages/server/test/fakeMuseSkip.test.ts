/**
 * When the fake muse is skipped: a script with a `#!<node>` line runs only on a POSIX system and only when the node
 * path holds no whitespace. The decision is a pure function of its two inputs, so it is pinned here for every system.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FAKE_MUSE_SKIP, fakeMuseSkipReason } from "./fakeMuse.js";

describe("the reason the fake muse is skipped", () => {
  it("is none on a POSIX system with a plain node path", () => {
    assert.equal(fakeMuseSkipReason("linux", "/usr/local/bin/node"), false);
    assert.equal(fakeMuseSkipReason("darwin", "/opt/homebrew/bin/node"), false);
  });

  it("is a stated reason on Windows, whatever the path", () => {
    assert.match(String(fakeMuseSkipReason("win32", "C:\\nodejs\\node.exe")), /POSIX/);
  });

  it("is a stated reason when the node path has whitespace, which a shebang cannot quote", () => {
    for (const execPath of ["/Users/Jo Doe/.nvm/versions/node/v22/bin/node", "/opt/my\tnode/bin/node", "/opt/node /bin/node"]) {
      assert.match(String(fakeMuseSkipReason("darwin", execPath)), /whitespace/, execPath);
    }
  });

  it("is the one every suite that starts the fake as a process passes as its skip option", () => {
    assert.equal(FAKE_MUSE_SKIP, fakeMuseSkipReason(process.platform, process.execPath));
  });
});
