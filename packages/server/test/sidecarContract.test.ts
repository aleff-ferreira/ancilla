/**
 * What the desktop shell and the server agree on, read from the shell's source: the exit code of a refused data
 * folder, the stdin watchdog flag, the grace the shell gives a closing sidecar (the server's deadline and the exit),
 * and the handshake it waits for the ready line (longer than the boot budget). The shell is written apart from the
 * server; until its side is in, this is skipped rather than failed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_DATA_DIR_OWNED } from "../src/exitCodes.js";
import { SHUTDOWN_DEADLINE_MS, STDIN_EOF_FLAG } from "../src/shutdown.js";

const MAIN_RS = join(__dirname, "..", "..", "..", "..", "apps", "desktop", "src-tauri", "src", "main.rs");

function shellSource(): string {
  try {
    return readFileSync(MAIN_RS, "utf8");
  } catch {
    return "";
  }
}

const source = shellSource();
const NOT_MERGED = source.includes("EXIT_DATA_DIR_OWNED") ? false : "WP7B shell not merged yet";

describe("the desktop shell's side of the contract", () => {
  it("refuses a data folder with the same exit code", { skip: NOT_MERGED }, () => {
    assert.match(source, new RegExp(`const EXIT_DATA_DIR_OWNED: i32 = ${EXIT_DATA_DIR_OWNED};`));
  });

  it("passes the stdin watchdog flag, spelled as the server reads it", { skip: NOT_MERGED }, () => {
    assert.ok(source.includes(`"${STDIN_EOF_FLAG}"`), `main.rs does not pass ${STDIN_EOF_FLAG}`);
  });

  it("gives a closing sidecar the server's deadline and five seconds to exit before it kills it", { skip: NOT_MERGED }, () => {
    assert.equal(SHUTDOWN_DEADLINE_MS, 20_000, "the shell's grace is written from this number");
    assert.match(source, /20_000 \+ 5_000/);
  });

  it("waits 45 seconds for the ready line, which the boot budget stays under", { skip: NOT_MERGED }, () => {
    assert.match(source, /from_secs\(45\)/);
  });
});
