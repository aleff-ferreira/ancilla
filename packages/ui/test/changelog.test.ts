import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { CHANGELOG, compareVersions, newEntries } from "../src/model/changelog.js";

const SYNTHETIC_CHANGELOG_ENTRIES = [
  { version: "1.4.2", body: "### Fixed\n\n- Improved streaming transcript stability." },
  { version: "1.4.1", body: "Updated desktop packaging pipeline." },
  { version: "1.4.0", body: "### Added\n\n- Multi-provider model routing." },
  { version: "1.3.0", body: "### Added\n\n- Sub-agent process monitoring." },
];

describe("compareVersions semantic versioning ordering", () => {
  it("orders versions numerically by major, minor, and patch segments", () => {
    assert.ok(compareVersions("0.9.0", "0.10.0") < 0);
    assert.ok(compareVersions("1.4.2", "1.4.10") < 0);
    assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
    assert.equal(compareVersions("1.4.2", "1.4.2"), 0);
  });

  it("handles non-semver identifier strings without throwing", () => {
    assert.equal(compareVersions("canary", "canary"), 0);
    assert.ok(compareVersions("canary", "1.4.2") !== 0);
  });
});

describe("newEntries changelog filtering", () => {
  it("returns no entries on initial startup when no prior version was recorded", () => {
    assert.deepEqual(newEntries(null, "1.4.2", SYNTHETIC_CHANGELOG_ENTRIES), []);
  });

  it("returns no entries if current running version is null", () => {
    assert.deepEqual(newEntries("1.4.0", null, SYNTHETIC_CHANGELOG_ENTRIES), []);
  });

  it("returns no entries when running version matches last recorded version", () => {
    assert.deepEqual(newEntries("1.4.2", "1.4.2", SYNTHETIC_CHANGELOG_ENTRIES), []);
  });

  it("suppresses changelog display upon version downgrade", () => {
    assert.deepEqual(newEntries("1.4.2", "1.4.0", SYNTHETIC_CHANGELOG_ENTRIES), []);
  });

  it("extracts single upgrade entry across sequential minor patch bump", () => {
    const results = newEntries("1.4.1", "1.4.2", SYNTHETIC_CHANGELOG_ENTRIES);
    assert.deepEqual(
      results.map((entry) => entry.version),
      ["1.4.2"],
    );
  });

  it("aggregates all intervening release entries when intermediate versions were skipped", () => {
    const results = newEntries("1.3.0", "1.4.2", SYNTHETIC_CHANGELOG_ENTRIES);
    assert.deepEqual(
      results.map((entry) => entry.version),
      ["1.4.2", "1.4.1", "1.4.0"],
    );
  });

  it("restricts returned entries to running version ceiling", () => {
    const results = newEntries("1.3.0", "1.4.0", SYNTHETIC_CHANGELOG_ENTRIES);
    assert.deepEqual(
      results.map((entry) => entry.version),
      ["1.4.0"],
    );
  });
});

describe("Generated CHANGELOG asset consistency", () => {
  it("matches package.json release version as top entry", () => {
    let currentDir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(currentDir, "package.json")) && dirname(currentDir) !== currentDir) {
      currentDir = dirname(currentDir);
    }
    const packageJsonContent = JSON.parse(
      readFileSync(join(currentDir, "package.json"), "utf8"),
    ) as { version: string };

    assert.equal(CHANGELOG[0]?.version, packageJsonContent.version);
  });

  it("maintains descending chronological order with non-empty descriptions", () => {
    const uniqueVersions = new Set<string>();

    for (let index = 0; index < CHANGELOG.length; index += 1) {
      const entry = CHANGELOG[index];
      assert.ok(entry.body.trim().length > 0, `Release ${entry.version} body is empty`);
      assert.ok(!uniqueVersions.has(entry.version), `Version ${entry.version} is duplicated`);
      uniqueVersions.add(entry.version);

      const nextEntry = CHANGELOG[index + 1];
      if (nextEntry) {
        assert.ok(
          compareVersions(entry.version, nextEntry.version) > 0,
          `Version ${entry.version} should be strictly newer than ${nextEntry.version}`,
        );
      }
    }
  });
});
