// Checks the updater signing key in TAURI_SIGNING_PRIVATE_KEY the way a release would use it: signs a scratch
// file with `tauri signer sign`, then compares the key that signed it with plugins.updater.pubkey in
// tauri.conf.json, the one installed copies trust. A key that does not open is an error. One that opens but is
// not the configured key is a warning, since a release that replaces the key signs with the old one on purpose
// (docs/RELEASING.md).
//
// Run from the repository root, after npm ci:   node scripts/check-signing-key.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  console.log(
    "::error title=TAURI_SIGNING_PRIVATE_KEY is not set::Add the updater's private key as the repository secret TAURI_SIGNING_PRIVATE_KEY (docs/RELEASING.md, one-time setup). Without it nothing can be signed, and installed copies refuse an unsigned update.",
  );
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ancilla-signing-"));
const scratch = path.join(dir, "ancilla-signing-check.txt");
fs.writeFileSync(scratch, `Ancilla signing check ${new Date().toISOString()}\n`);
try {
  // The CLI itself, with no npx or cmd.exe in between. `tauri signer sign` asks on the terminal when it gets no
  // password at all, so a key without one gets an empty one as `--password=`: an argument, which reaches it on
  // Windows too, where an empty variable passed through Git Bash might not.
  const args = ["node_modules/@tauri-apps/cli/tauri.js", "signer", "sign"];
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) args.push("--password=");
  args.push(scratch);
  const sign = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (sign.status !== 0) {
    console.log(
      "::error title=The updater signing key does not open::tauri signer sign could not sign with TAURI_SIGNING_PRIVATE_KEY (its error is above). The secret must be the whole of ~/.tauri/ancilla-updater.key, which has no password; only a key that has one also needs TAURI_SIGNING_PRIVATE_KEY_PASSWORD (docs/RELEASING.md).",
    );
    process.exitCode = 1;
  } else {
    const conf = JSON.parse(fs.readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8"));
    const signing = keyId(fs.readFileSync(`${scratch}.sig`, "utf8"));
    const trusted = keyId(conf.plugins.updater.pubkey);
    if (signing === trusted) {
      console.log(
        `::notice title=The signing key is the configured one::Signing key ${signing} matches plugins.updater.pubkey.`,
      );
    } else {
      console.log(
        `::warning title=The signing key is not the configured one::TAURI_SIGNING_PRIVATE_KEY is key ${signing}, but plugins.updater.pubkey in tauri.conf.json is key ${trusted}. Installed copies accept only an update signed with the key they trust, so unless this release replaces the key (docs/RELEASING.md), the secret holds the wrong key.`,
      );
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// A minisign key or signature is base64 of text whose second line, decoded in turn, is a two-byte algorithm
// and then the key id, which minisign prints as a little-endian hex number.
function keyId(text) {
  const line = Buffer.from(text.trim(), "base64").toString("utf8").split(/\r?\n/)[1];
  return Buffer.from(Buffer.from(line, "base64").subarray(2, 10)).reverse().toString("hex").toUpperCase();
}
