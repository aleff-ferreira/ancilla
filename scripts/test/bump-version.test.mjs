// bump-version.mjs against a small tree of the files it reads, built fresh for each test, plus one run against the
// repository itself. The release body (shown in the app as the update's notes) and the README heading must name
// the version being released, or --check fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const realScript = fileURLToPath(new URL("../bump-version.mjs", import.meta.url));
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const json = (data) => `${JSON.stringify(data, null, 2)}\n`;

/** A tree of every file bump-version.mjs reads, all at `version` unless a heading is told otherwise. */
function makeTree({ version = "0.20.3", releaseHeading = version, readmeHeading = version, eol = "\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ancilla-bump-"));
  dirs.push(root);
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put("package.json", json({ name: "ancilla", version, workspaces: ["packages/*", "apps/*"] }));
  put("packages/server/package.json", json({ name: "@ancilla/server", version }));
  put("apps/desktop/package.json", json({ name: "ancilla-desktop", version }));
  put(
    "package-lock.json",
    json({
      name: "ancilla",
      version,
      lockfileVersion: 3,
      packages: {
        "": { name: "ancilla", version },
        "packages/server": { name: "@ancilla/server", version },
        "apps/desktop": { name: "ancilla-desktop", version },
      },
    }),
  );
  put("apps/desktop/src-tauri/tauri.conf.json", json({ productName: "Ancilla", version }));
  put("apps/desktop/src-tauri/Cargo.toml", `[package]\nname = "ancilla-desktop"\nversion = "${version}"\nedition = "2021"\n`);
  put("apps/desktop/src-tauri/Cargo.lock", `[[package]]\nname = "ancilla-desktop"\nversion = "${version}"\n`);
  put("packages/server/src/server.ts", `export const ANCILLA_VERSION = "${version}";\n`);
  put("docs/CHANGELOG.md", `# Changelog\n\n## ${version}\n\n- A change.\n`);
  put("packages/ui/src/model/changelog.generated.ts", `export const CHANGELOG = [{ "version": "${version}" }];\n`);
  const crlf = (text) => text.replace(/\n/g, eol);
  put(
    ".github/workflows/release.yml",
    crlf(`env:\n  RELEASE_BODY: |\n    Ancilla \${{ github.ref_name }}\n\n    **New in ${releaseHeading}**\n    - Something.\n\njobs: {}\n`),
  );
  put("README.md", crlf(`# Ancilla\n\n> **New in ${readmeHeading}:** Something.\n> [Read the release notes](docs/CHANGELOG.md#0203).\n`));
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(realScript, join(root, "scripts", "bump-version.mjs"));
  return root;
}

function run(root, ...args) {
  const done = spawnSync(process.execPath, [join(root, "scripts", "bump-version.mjs"), ...args], { encoding: "utf8" });
  return { code: done.status, out: done.stdout, err: done.stderr };
}

const read = (root, path) => readFileSync(join(root, path), "utf8");

describe("the release body and README name the version", () => {
  test("a tree that agrees passes, with or without the tag", () => {
    const root = makeTree();
    assert.equal(run(root, "--check").code, 0, run(root, "--check").err);
    assert.equal(run(root, "--check", "v0.20.3").code, 0);
  });

  test("a stale release body fails and names the file and the version it expected", () => {
    const root = makeTree({ releaseHeading: "0.20.2" });
    const result = run(root, "--check");
    assert.equal(result.code, 1);
    assert.match(result.err, /\.github\/workflows\/release\.yml\s+release notes "New in" heading\s+0\.20\.2\s+<- expected 0\.20\.3/);
    assert.doesNotMatch(result.err, /README\.md\s+README "New in" heading\s+0\.20\.3\s+<-/);
  });

  test("a stale README heading fails", () => {
    const root = makeTree({ readmeHeading: "0.19.0" });
    const result = run(root, "--check", "v0.20.3");
    assert.equal(result.code, 1);
    assert.match(result.err, /README\.md\s+README "New in" heading\s+0\.19\.0\s+<- expected 0\.20\.3/);
  });

  test("the release job's tag check catches a body left at an older version", () => {
    const root = makeTree({ version: "0.20.4", releaseHeading: "0.20.3", readmeHeading: "0.20.3" });
    const result = run(root, "--check", "v0.20.4");
    assert.equal(result.code, 1);
    assert.match(result.err, /Not every version is 0\.20\.4/);
    assert.match(result.err, /release\.yml/);
    assert.match(result.err, /README\.md/);
  });

  test("a heading that is not there, or there twice, is an error rather than a skip", () => {
    const missing = makeTree();
    writeFileSync(join(missing, ".github/workflows/release.yml"), "env:\n  RELEASE_BODY: |\n    Nothing new here.\n");
    const none = run(missing, "--check");
    assert.equal(none.code, 1);
    assert.match(none.err, /release\.yml: expected exactly one release notes "New in" heading, found 0/);

    const twice = makeTree();
    writeFileSync(join(twice, "README.md"), "> **New in 0.20.3:** a\n> **New in 0.20.3:** b\n");
    assert.match(run(twice, "--check").err, /README\.md: expected exactly one README "New in" heading, found 2/);
  });

  test("works with the CRLF line endings a Windows checkout gives", () => {
    const root = makeTree({ eol: "\r\n", releaseHeading: "0.20.2" });
    assert.equal(run(root, "--check").code, 1);
    run(root, "0.20.3");
    assert.equal(run(root, "--check").code, 1, "the stale heading was renamed, which is not the same as the notes being rewritten");
    finish(root, "0.20.3");
    assert.equal(run(root, "--check").code, 0);
    assert.match(read(root, "README.md"), /\*\*New in 0\.20\.3:\*\*[^\n]*\r\n/);
  });
});

/** What a person does after a bump: writes the changelog entry and the notes, and takes the marker lines out. */
function finish(root, version) {
  writeFileSync(join(root, "docs/CHANGELOG.md"), `# Changelog\n\n## ${version}\n\n- A change.\n`);
  writeFileSync(join(root, "packages/ui/src/model/changelog.generated.ts"), `export const CHANGELOG = [{ "version": "${version}" }];\n`);
  for (const path of [".github/workflows/release.yml", "README.md"]) {
    writeFileSync(join(root, path), read(root, path).replace(/^.*notes for \d+\.\d+\.\d+ not written yet.*\r?\n/gm, ""));
  }
}

describe("bumping writes the headings", () => {
  test("sets the release body and README heading with every other version, and says the notes still need words", () => {
    const root = makeTree();
    const result = run(root, "0.21.0");
    assert.equal(result.code, 0, result.err);
    assert.match(read(root, ".github/workflows/release.yml"), /^ {4}\*\*New in 0\.21\.0\*\*$/m);
    assert.match(read(root, "README.md"), /^> \*\*New in 0\.21\.0:\*\* Something\.$/m);
    assert.match(result.out, /\.github\/workflows\/release\.yml\s+release notes "New in" heading\s+0\.21\.0/);
    assert.match(result.out, /Only the headings were renamed\. Rewrite the notes under "New in 0\.21\.0" in \.github\/workflows\/release\.yml and README\.md/);
    // The rest of the files are untouched.
    assert.match(read(root, ".github/workflows/release.yml"), /- Something\.\n/);
    assert.match(read(root, "README.md"), /docs\/CHANGELOG\.md#0203/);
  });

  test("leaves a marker line under each heading, in the heading's own place and indent", () => {
    const root = makeTree();
    run(root, "0.21.0");
    assert.match(read(root, ".github/workflows/release.yml"), /^ {4}\*\*New in 0\.21\.0\*\*\n {4}\[notes for 0\.21\.0 not written yet: [^\]\n]+\]\n {4}- Something\.$/m);
    assert.match(read(root, "README.md"), /^> \*\*New in 0\.21\.0:\*\* Something\.\n> \[notes for 0\.21\.0 not written yet: [^\]\n]+\]\n> \[Read the release notes\]/m);
  });

  test("the check fails while a marker is there, naming the file, and passes once it is taken out", () => {
    const root = makeTree();
    run(root, "0.21.0");
    writeFileSync(join(root, "docs/CHANGELOG.md"), "# Changelog\n\n## 0.21.0\n\n- A change.\n");
    writeFileSync(join(root, "packages/ui/src/model/changelog.generated.ts"), 'export const CHANGELOG = [{ "version": "0.21.0" }];\n');
    const blocked = run(root, "--check", "v0.21.0");
    assert.equal(blocked.code, 1, "every version agrees and the changelog is there, and the words are still the old ones");
    assert.match(blocked.err, /notes for 0\.21\.0 are not written yet/);
    assert.match(blocked.err, /\.github\/workflows\/release\.yml/);
    assert.match(blocked.err, /README\.md/);
    assert.match(blocked.err, /delete the marker line/);
    finish(root, "0.21.0");
    const result = run(root, "--check", "v0.21.0");
    assert.equal(result.code, 0, result.err);
  });

  test("one marker taken out and the other left still fails, naming only the other", () => {
    const root = makeTree();
    run(root, "0.21.0");
    finish(root, "0.21.0");
    writeFileSync(join(root, "README.md"), read(root, "README.md").replace("> [Read", "> [notes for 0.21.0 not written yet: x]\n> [Read"));
    const result = run(root, "--check");
    assert.equal(result.code, 1);
    assert.match(result.err, /README\.md/);
    assert.doesNotMatch(result.err, /release\.yml/);
  });

  test("bumping twice to the same version leaves one marker, and notes written before the bump get none", () => {
    const root = makeTree();
    run(root, "0.21.0");
    run(root, "0.21.0");
    assert.equal(read(root, ".github/workflows/release.yml").match(/not written yet/g).length, 1);
    assert.equal(read(root, "README.md").match(/not written yet/g).length, 1);

    const written = makeTree({ releaseHeading: "0.21.0", readmeHeading: "0.21.0" });
    run(written, "0.21.0");
    assert.doesNotMatch(read(written, ".github/workflows/release.yml"), /not written yet/);
    assert.doesNotMatch(read(written, "README.md"), /not written yet/);
  });

  test("a second bump to another version before the notes were written replaces the marker, not adds to it", () => {
    const root = makeTree();
    run(root, "0.21.0");
    run(root, "0.21.1");
    for (const path of [".github/workflows/release.yml", "README.md"]) {
      const text = read(root, path);
      assert.equal(text.match(/not written yet/g).length, 1, path);
      assert.match(text, /notes for 0\.21\.1 not written yet/, path);
      assert.doesNotMatch(text, /notes for 0\.21\.0 not written yet/, path);
    }
  });

  test("markers are written, found and taken out with the CRLF line endings of a Windows checkout", () => {
    const root = makeTree({ eol: "\r\n" });
    run(root, "0.21.0");
    assert.match(read(root, ".github/workflows/release.yml"), /\*\*New in 0\.21\.0\*\*\r\n {4}\[notes for 0\.21\.0 not written yet[^\]]*\]\r\n {4}- Something\./);
    assert.doesNotMatch(read(root, "README.md"), /[^\r]\n/, "no bare line feed in a CRLF file");
    writeFileSync(join(root, "docs/CHANGELOG.md"), "# Changelog\n\n## 0.21.0\n\n- A change.\n");
    writeFileSync(join(root, "packages/ui/src/model/changelog.generated.ts"), 'export const CHANGELOG = [{ "version": "0.21.0" }];\n');
    assert.equal(run(root, "--check").code, 1);
    finish(root, "0.21.0");
    assert.equal(run(root, "--check").code, 0);
  });

  test("after the changelog entry exists and the notes are written, the bumped tree passes the check", () => {
    const root = makeTree();
    run(root, "0.21.0");
    assert.equal(run(root, "--check").code, 1, "the changelog still has no entry");
    finish(root, "0.21.0");
    const result = run(root, "--check", "v0.21.0");
    assert.equal(result.code, 0, result.err);
  });

  test("a tree with no heading to write stops without changing a file", () => {
    const root = makeTree();
    writeFileSync(join(root, "README.md"), "# Ancilla\n");
    const before = read(root, "package.json");
    const result = run(root, "0.21.0");
    assert.equal(result.code, 1);
    assert.match(result.err, /README\.md: expected exactly one/);
    assert.equal(read(root, "package.json"), before);
    assert.match(read(root, ".github/workflows/release.yml"), /New in 0\.20\.3/);
  });
});

describe("this repository", () => {
  test("its release body and README heading name its version", () => {
    const done = spawnSync(process.execPath, [realScript, "--check"], { encoding: "utf8" });
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /All \d+ versions are \d+\.\d+\.\d+\./);
  });
});
