// Minisign verification for the updater's signatures, with nothing but node:crypto.
//
// An installed copy of Ancilla accepts an update only when the minisign signature in latest.json verifies against
// the public key baked into its own build (plugins.updater.pubkey in tauri.conf.json). This module does the same
// check on the release machine, before a release is published, so a signature that no installed copy would accept
// is found while the release is still a private draft.
//
// Formats, as the Tauri CLI writes them (and as minisign defines them):
//   public key  base64 of a two-line text: "untrusted comment: ...", then base64 of 'Ed' + key id (8) + key (32).
//   signature   base64 of a four-line text: "untrusted comment: ...", base64 of algorithm (2) + key id (8) +
//               signature (64), "trusted comment: ...", base64 of the global signature (64).
// Algorithm 'Ed' signs the file's bytes; 'ED' signs their BLAKE2b-512 digest (the Tauri CLI writes 'ED'). The global
// signature covers the file signature followed by the trusted comment, so the comment cannot be edited afterwards.
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";

/** Every failure this module reports, with a stable `code` for callers and tests. */
export class SignatureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SignatureError";
    this.code = code;
  }
}

const UNTRUSTED = "untrusted comment:";
const TRUSTED = "trusted comment: ";
// What an Ed25519 public key looks like in SubjectPublicKeyInfo form, in front of the 32 raw key bytes.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Base64 that must be exactly that: no stray characters, no missing padding (which is what truncation looks like),
 * and nothing in the bits no byte uses. Several texts decode to the same bytes when those bits are free, and the
 * decoder in the updater takes only the one an encoder writes; so does this.
 */
function decodeBase64(text, what, code) {
  const compact = text.replace(/\s+/g, "");
  if (compact === "") {
    throw new SignatureError(code, `${what} is empty`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new SignatureError(code, `${what} is not valid base64 (cut short or damaged?)`);
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.toString("base64") !== compact) {
    throw new SignatureError(code, `${what} is not canonical base64 (its padding bits are not zero)`);
  }
  return bytes;
}

/** The lines of a decoded minisign text, whichever line ending it was saved with, without trailing blank lines. */
function linesOf(text) {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines.at(-1).trim() === "") {
    lines.pop();
  }
  return lines;
}

/** minisign prints a key id as the little-endian number its eight bytes make up. */
export function formatKeyId(bytes) {
  return Buffer.from(bytes).reverse().toString("hex").toUpperCase();
}

/**
 * The text of a minisign file given either as it is on disk (Tauri: base64 of it) or already decoded.
 *
 * `canonical` is how the updater reads latest.json's signature and the configured pubkey: the string is base64 exactly
 * as it stands, with no trimming, no whitespace skipped and no decoded text accepted in its place. A trailing newline
 * or a wrapped line that a lenient reading takes is an update error in every installed copy. The lenient reading is
 * for a .sig or .pub file on disk, where editors and shells leave newlines.
 */
function plainText(input, what, code, canonical = false) {
  if (canonical) {
    const exact = String(input ?? "");
    if (exact === "") {
      throw new SignatureError(code, `${what} is empty`);
    }
    if (/\s/.test(exact)) {
      throw new SignatureError(code, `${what} has whitespace or line breaks in it: the updater decodes the text exactly as it stands and would refuse it`);
    }
    return decodeBase64(exact, what, code).toString("utf8");
  }
  const trimmed = String(input ?? "").trim();
  if (trimmed === "") {
    throw new SignatureError(code, `${what} is empty`);
  }
  if (trimmed.startsWith(UNTRUSTED)) {
    return trimmed;
  }
  return decodeBase64(trimmed, what, code).toString("utf8");
}

/**
 * A public key, as plugins.updater.pubkey holds it. `{ canonical: true }` reads it the way the updater does (see plainText).
 * @returns {{ keyId: string, keyIdBytes: Buffer, publicKey: Buffer, comment: string }}
 */
export function parsePublicKey(input, { canonical = false } = {}) {
  const lines = linesOf(plainText(input, "The public key", "pubkey-format", canonical));
  if (lines.length !== 2 || !lines[0].startsWith(UNTRUSTED)) {
    throw new SignatureError("pubkey-format", `The public key is not a minisign public key (expected 2 lines starting with "${UNTRUSTED}", found ${lines.length})`);
  }
  const raw = decodeBase64(lines[1], "The public key's second line", "pubkey-format");
  if (raw.length !== 42) {
    throw new SignatureError("pubkey-format", `The public key's key line is ${raw.length} bytes, expected 42`);
  }
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (algorithm !== "Ed") {
    throw new SignatureError("pubkey-format", `The public key's algorithm is "${algorithm}", expected "Ed"`);
  }
  const keyIdBytes = raw.subarray(2, 10);
  return { keyId: formatKeyId(keyIdBytes), keyIdBytes, publicKey: raw.subarray(10, 42), comment: lines[0].slice(UNTRUSTED.length).trim() };
}

/**
 * A signature file (the .sig next to an artifact; Tauri also copies its text into latest.json, where the updater reads it
 * exactly as it stands: `{ canonical: true }`).
 * @returns {{ algorithm: string, prehashed: boolean, keyId: string, keyIdBytes: Buffer, signature: Buffer, trustedComment: string, globalSignature: Buffer, untrustedComment: string }}
 */
export function parseSignature(input, { canonical = false } = {}) {
  const lines = linesOf(plainText(input, "The signature", "signature-format", canonical));
  if (lines.length !== 4) {
    throw new SignatureError("signature-format", `The signature has ${lines.length} lines, expected 4 (untrusted comment, signature, trusted comment, global signature)`);
  }
  if (!lines[0].startsWith(UNTRUSTED)) {
    throw new SignatureError("signature-format", `The signature's first line does not start with "${UNTRUSTED}"`);
  }
  if (!lines[2].startsWith(TRUSTED)) {
    throw new SignatureError("signature-format", `The signature's third line does not start with "${TRUSTED}"`);
  }
  const body = decodeBase64(lines[1], "The signature's second line", "signature-format");
  if (body.length !== 74) {
    throw new SignatureError("signature-format", `The signature's second line is ${body.length} bytes, expected 74 (algorithm, key id, signature)`);
  }
  const algorithm = body.subarray(0, 2).toString("latin1");
  if (algorithm !== "Ed" && algorithm !== "ED") {
    throw new SignatureError("unsupported-algorithm", `The signature's algorithm is "${algorithm}"; only "Ed" and "ED" (prehashed) are supported`);
  }
  const globalSignature = decodeBase64(lines[3], "The signature's global signature", "signature-format");
  if (globalSignature.length !== 64) {
    throw new SignatureError("signature-format", `The global signature is ${globalSignature.length} bytes, expected 64`);
  }
  const keyIdBytes = body.subarray(2, 10);
  return {
    algorithm,
    prehashed: algorithm === "ED",
    keyId: formatKeyId(keyIdBytes),
    keyIdBytes,
    signature: body.subarray(10, 74),
    trustedComment: lines[2].slice(TRUSTED.length),
    globalSignature,
    untrustedComment: lines[0].slice(UNTRUSTED.length).trim(),
  };
}

function ed25519(publicKey) {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: "der", type: "spki" });
}

/** What the file signature covers: the bytes themselves for 'Ed', their BLAKE2b-512 digest for 'ED'. */
export function messageFor(parsedSignature, bytes) {
  return parsedSignature.prehashed ? createHash("blake2b512").update(bytes).digest() : bytes;
}

function requireSameKey(publicKey, signature) {
  if (!signature.keyIdBytes.equals(publicKey.keyIdBytes)) {
    throw new SignatureError("key-mismatch", `The signature was made with key ${signature.keyId}, but the trusted public key is ${publicKey.keyId}`);
  }
}

/**
 * Checks only the global signature, which covers the file signature and the trusted comment. This needs no file,
 * so it can be run on a signature whose artifact is not at hand.
 */
export function verifyTrustedComment(publicKey, signature) {
  requireSameKey(publicKey, signature);
  // The trusted comment (timestamp, file name) is only trustworthy because this signature covers it.
  const covered = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment, "utf8")]);
  if (!verify(null, covered, ed25519(publicKey.publicKey), signature.globalSignature)) {
    throw new SignatureError("bad-trusted-comment", "The trusted comment does not match its signature: it was edited after signing");
  }
}

/**
 * Checks a parsed signature against a parsed key and the message it covers (see messageFor).
 * @returns {{ algorithm: string, keyId: string, trustedComment: string }}
 */
export function verifyParsed(publicKey, signature, message) {
  requireSameKey(publicKey, signature);
  if (!verify(null, message, ed25519(publicKey.publicKey), signature.signature)) {
    throw new SignatureError("bad-signature", "The signature does not match the file: it was changed after signing, or the signature belongs to another file");
  }
  verifyTrustedComment(publicKey, signature);
  return { algorithm: signature.algorithm, keyId: signature.keyId, trustedComment: signature.trustedComment };
}

/** Verifies an artifact held in memory. `signatureText` and `publicKeyText` are the files' text, base64 or decoded. */
export function verifyArtifact({ artifact, signatureText, publicKeyText }) {
  if (!Buffer.isBuffer(artifact)) {
    throw new SignatureError("io", "The artifact is not a buffer");
  }
  const publicKey = parsePublicKey(publicKeyText);
  const signature = parseSignature(signatureText);
  return verifyParsed(publicKey, signature, messageFor(signature, artifact));
}

function blake2bOfFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("blake2b512");
    createReadStream(path).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest()));
  });
}

/**
 * Verifies an artifact on disk. A prehashed signature streams the file; a legacy 'Ed' one needs the whole file in
 * memory, which minisign itself requires too.
 */
export async function verifyArtifactFile({ artifactPath, signatureText, publicKeyText }) {
  const publicKey = parsePublicKey(publicKeyText);
  const signature = parseSignature(signatureText);
  let message;
  try {
    message = signature.prehashed ? await blake2bOfFile(artifactPath) : readFileSync(artifactPath);
  } catch (error) {
    throw new SignatureError("io", `Cannot read ${artifactPath}: ${error.code ?? error.message}`);
  }
  return verifyParsed(publicKey, signature, message);
}

/** The public key out of a tauri.conf.json text, with an error that names the file when it is not there. */
export function publicKeyFromConfig(configText, label = "tauri.conf.json") {
  let config;
  try {
    config = JSON.parse(configText);
  } catch {
    throw new SignatureError("pubkey-format", `${label} is not valid JSON`);
  }
  const key = config?.plugins?.updater?.pubkey;
  if (typeof key !== "string" || key.trim() === "") {
    throw new SignatureError("pubkey-format", `${label} has no plugins.updater.pubkey`);
  }
  return key;
}
