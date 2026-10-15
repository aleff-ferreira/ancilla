// The command line around lib/minisign.mjs, run as a child process the way the release workflow runs it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { PAYLOAD, PUBLIC_KEY, SIGNATURE } from "./fixtures/tauri-signed.mjs";
import { generateKey, publicKeyText, signatureText } from "./helpers/minisign.mjs";

const script = fileURLToPath(new URL("../verify-updater-signature.mjs", import.meta.url));

function run(...args) {
  const done = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { code: done.status, out: done.stdout, err: done.stderr };
}

describe("verify-updater-signature.mjs", () => {
  let dir;
  const artifact = () => join(dir, "payload.txt");
  const stranger = generateKey();

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ancilla-verify-cli-"));
    writeFileSync(artifact(), PAYLOAD);
    writeFileSync(`${artifact()}.sig`, SIGNATURE);
    writeFileSync(join(dir, "tauri.conf.json"), JSON.stringify({ plugins: { updater: { pubkey: PUBLIC_KEY } } }));
    writeFileSync(join(dir, "other.conf.json"), JSON.stringify({ plugins: { updater: { pubkey: publicKeyText(stranger) } } }));
    writeFileSync(join(dir, "no-key.conf.json"), JSON.stringify({ plugins: {} }));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("verifies an artifact against the key in a tauri.conf.json, finding <artifact>.sig itself", () => {
    const result = run("--conf", join(dir, "tauri.conf.json"), artifact());
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /Verified payload\.txt: ED, key 7EE8E6630D893C5B, trusted comment: timestamp:\d+\tfile:payload\.txt/);
  });

  test("takes the key on the command line and the signature file as a second path", () => {
    const sigFile = join(dir, "copy.sig");
    writeFileSync(sigFile, `${SIGNATURE}\r\n`);
    const result = run("--pubkey", PUBLIC_KEY, artifact(), sigFile);
    assert.equal(result.code, 0, result.err);
  });

  test("fails, with a reason, for the wrong key", () => {
    const result = run("--conf", join(dir, "other.conf.json"), artifact());
    assert.equal(result.code, 1);
    assert.match(result.err, /verify-updater-signature: The signature was made with key 7EE8E6630D893C5B/);
    assert.equal(result.out, "");
  });

  test("fails for a changed artifact", () => {
    const changed = join(dir, "changed.txt");
    writeFileSync(changed, Buffer.concat([PAYLOAD, Buffer.from("!")]));
    writeFileSync(`${changed}.sig`, SIGNATURE);
    const result = run("--conf", join(dir, "tauri.conf.json"), changed);
    assert.equal(result.code, 1);
    assert.match(result.err, /does not match the file/);
  });

  test("fails for a missing artifact, a missing signature and a missing config", () => {
    assert.match(run("--conf", join(dir, "tauri.conf.json"), join(dir, "absent.bin")).err, /Cannot read .*absent\.bin/);
    writeFileSync(join(dir, "lonely.bin"), "x");
    assert.match(run("--conf", join(dir, "tauri.conf.json"), join(dir, "lonely.bin")).err, /Cannot read .*lonely\.bin\.sig/);
    assert.match(run("--conf", join(dir, "nope.json"), artifact()).err, /Cannot read .*nope\.json/);
    for (const result of [run("--conf", join(dir, "tauri.conf.json"), join(dir, "absent.bin")), run("--conf", join(dir, "nope.json"), artifact())]) {
      assert.equal(result.code, 1);
    }
  });

  test("fails for a config with no key and for an empty signature file", () => {
    const noKey = run("--conf", join(dir, "no-key.conf.json"), artifact());
    assert.equal(noKey.code, 1);
    assert.match(noKey.err, /has no plugins\.updater\.pubkey/);
    writeFileSync(join(dir, "empty.sig"), "");
    const empty = run("--conf", join(dir, "tauri.conf.json"), artifact(), join(dir, "empty.sig"));
    assert.equal(empty.code, 1);
    assert.match(empty.err, /signature is empty/);
  });

  test("a usage mistake is exit 2, never a pass", () => {
    for (const args of [[], [artifact()], ["--conf", join(dir, "tauri.conf.json")], ["--conf", "a", "--pubkey", "b", artifact()], ["--bogus", artifact()], ["--conf"]]) {
      const result = run(...args);
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.err, /Usage:/);
    }
  });

  test("verifies a legacy 'Ed' signature too", () => {
    const key = generateKey();
    const file = join(dir, "legacy.bin");
    const data = Buffer.from("legacy signed bytes");
    writeFileSync(file, data);
    writeFileSync(`${file}.sig`, signatureText(key, data, { algorithm: "Ed" }));
    const result = run("--pubkey", publicKeyText(key), file);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /: Ed, key /);
  });
});
