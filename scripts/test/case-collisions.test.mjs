// Two source files whose names differ only by case ("Avatar.tsx" beside "avatar.ts") are two files on Linux and one
// name on Windows and macOS, where an import of the first finds the second and the compiler stops. Nothing on a Linux
// machine shows it, so it is caught here, before a Windows or macOS runner is the one to say so.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", "target", "build", "gen", ".git"]);
const CODE = /\.(m?[jt]sx?|c[jt]s)$/;

/** Groups of paths that name one module on a case-insensitive disk and several on a case-sensitive one. */
export function caseClashes(paths) {
  const groups = new Map();
  for (const path of paths) {
    const key = path.replace(CODE, "").toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(path);
    groups.set(key, group);
  }
  // The same stem with another extension ("a.ts" and "a.tsx") is a different matter; the stem itself must differ in case.
  return [...groups.values()].filter((group) => new Set(group.map((path) => path.replace(CODE, ""))).size > 1);
}

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (CODE.test(entry.name)) found.push(path);
  }
  return found;
}

describe("no two source files differ only by case", () => {
  test("the check finds a clash in a name, a folder and an extension apart, and leaves the rest alone", () => {
    assert.deepEqual(caseClashes(["a/Avatar.tsx", "a/avatar.ts"]), [["a/Avatar.tsx", "a/avatar.ts"]]);
    assert.deepEqual(caseClashes(["a/Foo/x.ts", "a/foo/y.ts", "a/foo/x.ts"]), [["a/Foo/x.ts", "a/foo/x.ts"]]);
    assert.deepEqual(caseClashes(["a/index.ts", "a/index.tsx", "a/Index.test.ts", "b/index.ts", "a/foo.test.ts", "a/foo.ts", "a/styles.css"]), []);
  });

  test("none of the packages, apps or scripts has one", () => {
    const files = ["packages", "apps", "scripts"].flatMap(sourceFiles);
    assert.ok(files.length > 200, `only ${files.length} files were looked at`);
    assert.deepEqual(caseClashes(files), []);
  });
});
