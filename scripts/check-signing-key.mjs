/**
 * Ancilla Updater Signing Key Validator
 *
 * Verifies that TAURI_SIGNING_PRIVATE_KEY is present, valid, and matches the
 * public key configured in apps/desktop/src-tauri/tauri.conf.json.
 *
 * Invoked during pre-release CI workflows and manual workflow dispatch.
 *
 * Usage:
 *   node scripts/check-signing-key.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Extracts the 8-byte minisign Key ID formatted as an uppercase hex string
 * from a base64-encoded signature or public key file.
 */
export function extractMinisignKeyId(encodedText) {
  const rawText = Buffer.from(encodedText.trim(), "base64").toString("utf8");
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    throw new Error("Invalid minisign data: expected at least two lines");
  }
  const payloadBytes = Buffer.from(lines[1], "base64");
  if (payloadBytes.length < 10) {
    throw new Error("Invalid minisign payload: expected at least 10 bytes");
  }
  const keyIdBytes = payloadBytes.subarray(2, 10);
  return Buffer.from(keyIdBytes).reverse().toString("hex").toUpperCase();
}

export function main() {
  const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
  if (!privateKey) {
    console.log(
      "::error title=TAURI_SIGNING_PRIVATE_KEY is not set::Add the updater's private key as the repository secret TAURI_SIGNING_PRIVATE_KEY (docs/RELEASING.md, one-time setup). Without it nothing can be signed, and installed copies refuse an unsigned update.",
    );
    process.exit(1);
  }

  const scratchDir = mkdtempSync(join(tmpdir(), "ancilla-signing-"));
  const scratchFile = join(scratchDir, "ancilla-signing-check.txt");
  writeFileSync(scratchFile, `Ancilla signing verification ${new Date().toISOString()}\n`);

  try {
    const tauriCli = "node_modules/@tauri-apps/cli/tauri.js";
    const args = [tauriCli, "signer", "sign"];
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
      args.push("--password=");
    }
    args.push(scratchFile);

    const signProcess = spawnSync(process.execPath, args, { stdio: "inherit" });
    if (signProcess.status !== 0) {
      console.log(
        "::error title=The updater signing key does not open::tauri signer sign could not sign with TAURI_SIGNING_PRIVATE_KEY (its error is above). The secret must be the whole of ~/.tauri/ancilla-updater.key, which has no password; only a key that has one also needs TAURI_SIGNING_PRIVATE_KEY_PASSWORD (docs/RELEASING.md).",
      );
      process.exitCode = 1;
      return;
    }

    const tauriConfPath = "apps/desktop/src-tauri/tauri.conf.json";
    const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
    const configuredPubkey = tauriConf?.plugins?.updater?.pubkey;

    if (!configuredPubkey) {
      console.log("::error title=Config missing updater pubkey::plugins.updater.pubkey is not defined in tauri.conf.json.");
      process.exitCode = 1;
      return;
    }

    const signaturePath = `${scratchFile}.sig`;
    const signatureContent = readFileSync(signaturePath, "utf8");

    const signingKeyId = extractMinisignKeyId(signatureContent);
    const trustedKeyId = extractMinisignKeyId(configuredPubkey);

    if (signingKeyId === trustedKeyId) {
      console.log(
        `::notice title=The signing key is the configured one::Signing key ${signingKeyId} matches plugins.updater.pubkey.`,
      );
    } else {
      console.log(
        `::warning title=The signing key is not the configured one::TAURI_SIGNING_PRIVATE_KEY is key ${signingKeyId}, but plugins.updater.pubkey in tauri.conf.json is key ${trustedKeyId}. Installed copies accept only an update signed with the key they trust, so unless this release replaces the key (docs/RELEASING.md), the secret holds the wrong key.`,
      );
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main();
}
