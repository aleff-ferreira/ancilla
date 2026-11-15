// Points git at the repository's hooks (.githooks) so the commit rules in CLAUDE.md hold in every checkout.
// Runs from npm's `prepare` script, which npm ci and npm install both call; a tree that is not a git checkout
// (an unpacked tarball, a shallow CI export) has nothing to configure and is left alone.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (!existsSync(join(root, ".git"))) {
  process.exit(0);
}
try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "ignore" });
} catch {
  // No git on PATH, or a read-only config: the CI check still covers the rules.
}
