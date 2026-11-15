import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { extractMinisignKeyId } from "../check-signing-key.mjs";

describe("check-signing-key", () => {
  const samplePubkey =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc0NEJBNzA3OThCNTRDN0IKUldSN1RMV1lCNmRMZER4SDViQTNKVXlQYlpmR3l0RE9MMy9LWjU5c3ZYT0J4ZVlhdU1IZGNXNDkK";

  test("extracts uppercase 8-byte hex key ID from valid base64 public key", () => {
    const keyId = extractMinisignKeyId(samplePubkey);
    assert.equal(keyId, "744BA70798B54C7B");
  });

  test("throws error when minisign input is malformed or has insufficient lines", () => {
    assert.throws(() => extractMinisignKeyId(""), /Invalid minisign data/);
    assert.throws(() => extractMinisignKeyId(Buffer.from("only one line").toString("base64")), /Invalid minisign data/);
  });

  test("throws error when payload bytes are truncated", () => {
    const truncatedPayload = Buffer.from("line1\nshort\n").toString("base64");
    assert.throws(() => extractMinisignKeyId(truncatedPayload), /Invalid minisign payload/);
  });

  test("exits with status 1 when TAURI_SIGNING_PRIVATE_KEY is missing", () => {
    const res = spawnSync(process.execPath, ["scripts/check-signing-key.mjs"], {
      env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: "" },
      encoding: "utf8",
    });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /::error title=TAURI_SIGNING_PRIVATE_KEY is not set::/);
  });
});
