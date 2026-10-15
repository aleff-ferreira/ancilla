// Release tooling is code that holds the signing key's output and decides what gets published, so it is read by
// people: nothing in it may be a character a reviewer cannot see (a byte order mark, a zero-width space, a
// bidirectional control). A pattern that needs one is written with its escape, as \u{FEFF} with the u flag.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));
// Soft hyphen, zero-width and direction marks, bidirectional embeddings and isolates, word joiner and invisible
// operators, and the byte order mark.
const RANGES = [
  [0x00ad, 0x00ad],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const hex = (code) => `\\u{${code.toString(16)}}`;
const INVISIBLE = new RegExp(`[${RANGES.map(([from, to]) => (from === to ? hex(from) : `${hex(from)}-${hex(to)}`)).join("")}]`, "u");

function filesUnder(dir, keep) {
  const found = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path, keep));
    else if (keep(entry.name)) found.push(path);
  }
  return found;
}

describe("release tooling holds no invisible characters", () => {
  test("the pattern finds each of them, and leaves ordinary text alone", () => {
    for (const code of [0xfeff, 0x200b, 0x200e, 0x202e, 0x2066, 0x00ad, 0x2060]) {
      assert.match(`a${String.fromCodePoint(code)}b`, INVISIBLE, code.toString(16));
    }
    assert.doesNotMatch("plain text, a tab\t and a newline\n and a hyphen-minus -", INVISIBLE);
    assert.doesNotMatch(`a visible non-ASCII letter: ${String.fromCodePoint(0xe9)}`, INVISIBLE);
  });

  test("scripts, workflows, hooks, the desktop shell scripts and the release guide are plain to read", () => {
    const files = [
      ...filesUnder("scripts", (name) => /\.(mjs|json|sh)$/.test(name)),
      ...filesUnder(".github/workflows", (name) => name.endsWith(".yml")),
      ...filesUnder(".githooks", () => true),
      ...filesUnder("apps/desktop/scripts", (name) => name.endsWith(".sh")),
      "docs/RELEASING.md",
    ];
    assert.ok(files.length > 30, `only ${files.length} files were looked at`);
    const found = files.filter((file) => INVISIBLE.test(readFileSync(join(root, file), "utf8")));
    assert.deepEqual(found.map((file) => relative(root, join(root, file))), []);
  });
});
