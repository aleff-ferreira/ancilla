import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  generateTypeScriptChangelog,
  parseChangelogMarkdown,
  syncChangelog,
} from "../sync-changelog.mjs";

const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("sync-changelog", () => {
  test("extracts semver versions and preserves body markdown", () => {
    const markdown = `# Ancilla Changelog

## 0.29.0
- Added voice recognition streaming support.
- Fixed session persistence edge cases.

\`\`\`ts
const x = 1;
\`\`\`

## 0.28.1
- Minor stability improvements.
`;

    const entries = parseChangelogMarkdown(markdown);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].version, "0.29.0");
    assert.match(entries[0].body, /Added voice recognition/);
    assert.match(entries[0].body, /const x = 1;/);
    assert.equal(entries[1].version, "0.28.1");
    assert.equal(entries[1].body, "- Minor stability improvements.");
  });

  test("excludes non-version sections like Unreleased and notes", () => {
    const markdown = `# Changelog

## Unreleased
- Work in progress feature that is not yet published.

## 0.29.0
- Official release notes.

## Historical Archive Notes
- Pre-release historical context omitted from release data.
`;

    const entries = parseChangelogMarkdown(markdown);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].version, "0.29.0");
    assert.equal(entries[0].body, "- Official release notes.");
  });

  test("throws error when no version headings are discovered", () => {
    assert.throws(
      () => syncChangelog("/nonexistent/CHANGELOG.md", "/tmp/dummy.ts"),
      /ENOENT/,
    );

    const tempDir = mkdtempSync(join(tmpdir(), "ancilla-changelog-"));
    dirs.push(tempDir);
    const emptyFile = join(tempDir, "EMPTY.md");
    writeFileSync(emptyFile, "# No Versions Here\nJust notes.");
    assert.throws(
      () => syncChangelog(emptyFile, join(tempDir, "out.ts")),
      /No "## <version>" headings found/,
    );
  });

  test("generates valid TypeScript file exporting ChangelogEntry and CHANGELOG", () => {
    const entries = [
      { version: "0.29.0", body: "Initial note" },
      { version: "0.28.0", body: "Older note" },
    ];
    const tsCode = generateTypeScriptChangelog(entries);
    assert.match(tsCode, /export interface ChangelogEntry/);
    assert.match(tsCode, /export const CHANGELOG: readonly ChangelogEntry\[\] = /);
    assert.match(tsCode, /"version": "0\.29\.0"/);
  });

  test("syncs real repo changelog without altering changelog.generated.ts content", () => {
    const currentGenerated = readFileSync("packages/ui/src/model/changelog.generated.ts", "utf8");
    const tempDir = mkdtempSync(join(tmpdir(), "ancilla-changelog-sync-"));
    dirs.push(tempDir);
    const outTarget = join(tempDir, "changelog.generated.ts");

    const entries = syncChangelog("docs/CHANGELOG.md", outTarget);
    assert.ok(entries.length > 0);
    assert.equal(entries[0].version, "0.29.0");

    const newGenerated = readFileSync(outTarget, "utf8");
    assert.equal(newGenerated, currentGenerated);
  });
});
