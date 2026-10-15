// Checks an artifact's updater signature the way an installed copy of Ancilla would, against the public key in a
// tauri.conf.json (plugins.updater.pubkey) or given directly, and fails unless it verifies. The release workflow
// runs it before anything is published (docs/RELEASING.md).
//
//   node scripts/verify-updater-signature.mjs --conf apps/desktop/src-tauri/tauri.conf.json Ancilla_0.20.4_amd64.AppImage
//   node scripts/verify-updater-signature.mjs --pubkey <base64 key> <artifact> [<signature file>]
//
// The signature file defaults to <artifact>.sig. Exit status: 0 verified, 1 not verified (the reason is on
// stderr), 2 the command was used wrongly. Anything unexpected also exits non-zero, so a pass is never a guess.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { SignatureError, publicKeyFromConfig, verifyArtifactFile } from "./lib/minisign.mjs";

const USAGE = `Usage: node scripts/verify-updater-signature.mjs (--conf <tauri.conf.json> | --pubkey <base64 key>) <artifact> [<signature file>]`;

function usage(message) {
  if (message) console.error(`verify-updater-signature: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function read(path, what) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new SignatureError("io", `Cannot read ${what} ${path}: ${error.code ?? error.message}`);
  }
}

const positional = [];
let conf;
let pubkey;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--conf" || arg === "--pubkey") {
    const value = args[++i];
    if (value === undefined) usage(`${arg} needs a value`);
    if (arg === "--conf") conf = value;
    else pubkey = value;
  } else if (arg.startsWith("--")) {
    usage(`unknown option ${arg}`);
  } else {
    positional.push(arg);
  }
}
if ((conf === undefined) === (pubkey === undefined)) usage("give exactly one of --conf and --pubkey");
if (positional.length < 1 || positional.length > 2) usage("give the artifact and, optionally, its signature file");

const [artifactPath, signaturePath = `${positional[0]}.sig`] = positional;
try {
  const publicKeyText = conf === undefined ? pubkey : publicKeyFromConfig(read(conf, "the config"), conf);
  const signatureText = read(signaturePath, "the signature");
  const result = await verifyArtifactFile({ artifactPath, signatureText, publicKeyText });
  console.info(`Verified ${basename(artifactPath)}: ${result.algorithm}, key ${result.keyId}, trusted comment: ${result.trustedComment}`);
} catch (error) {
  if (!(error instanceof SignatureError)) throw error;
  console.error(`verify-updater-signature: ${error.message}`);
  process.exitCode = 1;
}
