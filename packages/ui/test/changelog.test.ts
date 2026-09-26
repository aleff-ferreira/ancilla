import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { CHANGELOG, compareVersions, newEntries } from "../src/model/changelog.js";

const entries = [
  { version: "0.14.2", body: "### Fixed\n\n- Threads stop freezing." },
  { version: "0.14.1", body: "The Linux AppImage is repacked." },
  { version: "0.14.0", body: "### New\n\n- Session statistics." },
  { version: "0.13.1", body: "### Fixed\n\n- Subagent threads." },
];

describe("compareVersions", () => {
  it("orders by each part in turn, not as text", () => {
    assert.ok(compareVersions("0.9.0", "0.10.0") < 0);
    assert.ok(compareVersions("0.14.2", "0.14.10") < 0);
    assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
    assert.equal(compareVersions("0.14.2", "0.14.2"), 0);
  });

  it("does not throw on something that is not a version", () => {
    assert.equal(compareVersions("dev", "dev"), 0);
    assert.ok(compareVersions("dev", "0.14.2") !== 0);
  });
});

describe("newEntries", () => {
  it("says nothing on a first run, when no version has been seen", () => {
    assert.deepEqual(newEntries(null, "0.14.2", entries), []);
  });

  it("says nothing before the running version is known", () => {
    assert.deepEqual(newEntries("0.14.0", null, entries), []);
  });

  it("says nothing when the running version is the one already seen", () => {
    assert.deepEqual(newEntries("0.14.2", "0.14.2", entries), []);
  });

  it("says nothing on a downgrade", () => {
    assert.deepEqual(newEntries("0.14.2", "0.14.0", entries), []);
  });

  it("gives the one entry after a single update", () => {
    assert.deepEqual(
      newEntries("0.14.1", "0.14.2", entries).map((e) => e.version),
      ["0.14.2"],
    );
  });

  it("gives every entry missed when releases were skipped", () => {
    assert.deepEqual(
      newEntries("0.13.1", "0.14.2", entries).map((e) => e.version),
      ["0.14.2", "0.14.1", "0.14.0"],
    );
  });

  it("never includes a version newer than the one running", () => {
    assert.deepEqual(
      newEntries("0.13.1", "0.14.0", entries).map((e) => e.version),
      ["0.14.0"],
    );
  });
});

describe("the generated changelog", () => {
  it("is in step with the released version", () => {
    // scripts/sync-changelog.mjs was not run if this fails, and the app would ship notes that stop
    // short of the version it is.
    // The suite runs from dist as well as from source, so the package root is found by walking up.
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) {
      dir = dirname(dir);
    }
    const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
    assert.equal(CHANGELOG[0]?.version, version);
  });

  it("is newest first, with no repeats and no empty entries", () => {
    const seen = new Set<string>();
    for (const [index, entry] of CHANGELOG.entries()) {
      assert.ok(entry.body.trim().length > 0, `${entry.version} has no notes`);
      assert.ok(!seen.has(entry.version), `${entry.version} appears twice`);
      seen.add(entry.version);
      const next = CHANGELOG[index + 1];
      if (next) {
        assert.ok(compareVersions(entry.version, next.version) > 0, `${entry.version} is not newer than ${next.version}`);
      }
    }
  });
});
