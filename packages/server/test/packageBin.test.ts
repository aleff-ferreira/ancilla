/**
 * The command the package advertises is a file the build produces: `bin` once named `dist/cli.js`, which the server's
 * build (rootDir is the package, so `src/cli.ts` compiles to `dist/src/cli.js`) never wrote, and a launcher that
 * trusted it (the Linux smoke's `--server`) found nothing there.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLI } from "./cliRig.js";

describe("the server package's bin", () => {
  it("names the compiled command line, which exists after the build", () => {
    const packageDir = resolve(__dirname, "..", "..");
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { bin?: Record<string, string> };
    const command = manifest.bin?.["ancilla-server"];
    assert.equal(typeof command, "string", "package.json has no ancilla-server bin");
    assert.equal(resolve(packageDir, command as string), CLI, "bin is not the file the build writes the command line to");
    assert.equal(existsSync(resolve(packageDir, command as string)), true);
  });
});
