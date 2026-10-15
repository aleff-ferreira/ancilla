// Test-only minisign writer: makes key pairs and signatures in both formats, so the verifier is tested against
// keys it has never seen, not only against the one real key it ships with.
import { createHash, generateKeyPairSync, sign } from "node:crypto";

export function generateKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keyIdBytes = createHash("sha256").update(raw).digest().subarray(0, 8);
  return { privateKey, raw, keyIdBytes, keyId: Buffer.from(keyIdBytes).reverse().toString("hex").toUpperCase() };
}

const b64 = (buffer) => Buffer.from(buffer).toString("base64");

/** The text of a minisign public key file; `encoded` wraps it in base64 the way tauri.conf.json holds it. */
export function publicKeyText(key, { encoded = true, algorithm = "Ed" } = {}) {
  const body = Buffer.concat([Buffer.from(algorithm, "latin1"), key.keyIdBytes, key.raw]);
  const text = `untrusted comment: minisign public key: ${key.keyId}\n${b64(body)}\n`;
  return encoded ? b64(text) : text;
}

/**
 * The text of a signature file. `algorithm` is 'ED' (prehashed, what the Tauri CLI writes) or 'Ed' (legacy).
 * `eol` is the line ending of the decoded text; `encoded` wraps it in base64 as the .sig file does.
 */
export function signatureText(key, bytes, { algorithm = "ED", trustedComment = "timestamp:1790000000\tfile:artifact.bin", eol = "\n", encoded = true } = {}) {
  const message = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
  const signature = sign(null, message, key.privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]), key.privateKey);
  const body = Buffer.concat([Buffer.from(algorithm, "latin1"), key.keyIdBytes, signature]);
  const lines = ["untrusted comment: signature from a test key", b64(body), `trusted comment: ${trustedComment}`, b64(global)];
  const text = `${lines.join(eol)}${eol}`;
  return encoded ? b64(text) : text;
}

/** Decodes a base64 signature file, lets `change` edit its lines, and encodes it again. */
export function editSignature(encodedText, change) {
  const lines = Buffer.from(encodedText, "base64").toString("utf8").split("\n");
  lines.pop();
  return b64(`${change(lines).join("\n")}\n`);
}
