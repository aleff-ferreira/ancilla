import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

import {
  SignatureError,
  parsePublicKey,
  parseSignature,
  publicKeyFromConfig,
  verifyArtifact,
  verifyArtifactFile,
  verifyTrustedComment,
} from "../lib/minisign.mjs";
import { PAYLOAD, PUBLIC_KEY, RELEASE_PUBLIC_KEY, SIGNATURE } from "./fixtures/tauri-signed.mjs";
import { editSignature, generateKey, publicKeyText, signatureText } from "./helpers/minisign.mjs";

const repoFile = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const bytes = Buffer.from("the bytes of an installer\n".repeat(50), "utf8");

function rejects(fn, code, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof SignatureError, `expected a SignatureError, got ${error}`);
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

describe("verifying signatures in both minisign formats", () => {
  for (const algorithm of ["ED", "Ed"]) {
    describe(`algorithm ${algorithm}`, () => {
      const key = generateKey();
      const publicKeyText64 = publicKeyText(key);
      const sig = signatureText(key, bytes, { algorithm });
      const check = (over = {}) => verifyArtifact({ artifact: bytes, signatureText: sig, publicKeyText: publicKeyText64, ...over });

      test("accepts the file it was made for", () => {
        const result = check();
        assert.equal(result.algorithm, algorithm);
        assert.equal(result.keyId, key.keyId);
        assert.equal(result.trustedComment, "timestamp:1790000000\tfile:artifact.bin");
      });

      test("accepts the key and the signature as plain text as well as base64", () => {
        check({ publicKeyText: publicKeyText(key, { encoded: false }), signatureText: signatureText(key, bytes, { algorithm, encoded: false }) });
      });

      test("accepts an empty file that was signed", () => {
        const empty = Buffer.alloc(0);
        verifyArtifact({ artifact: empty, signatureText: signatureText(key, empty, { algorithm }), publicKeyText: publicKeyText64 });
      });

      test("accepts CRLF line endings inside the signature and whitespace around it", () => {
        const crlf = signatureText(key, bytes, { algorithm, eol: "\r\n" });
        check({ signatureText: crlf });
        check({ signatureText: `\r\n  ${sig}\r\n\r\n` });
        check({ signatureText: signatureText(key, bytes, { algorithm, eol: "\r\n", encoded: false }) });
        check({ publicKeyText: `${publicKeyText64}\r\n` });
      });

      test("rejects another file", () => {
        rejects(() => check({ artifact: Buffer.concat([bytes, Buffer.from("x")]) }), "bad-signature", /changed after signing/);
        rejects(() => check({ artifact: Buffer.from("something else entirely") }), "bad-signature");
      });

      test("rejects a trusted comment that was edited after signing", () => {
        const edited = editSignature(sig, (lines) => [lines[0], lines[1], "trusted comment: timestamp:1790000001\tfile:artifact.bin", lines[3]]);
        rejects(() => check({ signatureText: edited }), "bad-trusted-comment", /edited after signing/);
      });

      test("rejects a signature whose global signature is another one", () => {
        const other = signatureText(key, bytes, { algorithm, trustedComment: "timestamp:2\tfile:artifact.bin" });
        const swapped = editSignature(sig, (lines) => [lines[0], lines[1], lines[2], Buffer.from(other, "base64").toString("utf8").split("\n")[3]]);
        rejects(() => check({ signatureText: swapped }), "bad-trusted-comment");
      });

      test("rejects a key that is not the one that signed", () => {
        const stranger = generateKey();
        rejects(() => check({ publicKeyText: publicKeyText(stranger) }), "key-mismatch", new RegExp(`${key.keyId}.*${stranger.keyId}`));
      });

      test("rejects a different key that claims the signing key's id", () => {
        const stranger = generateKey();
        const forged = { ...stranger, keyIdBytes: key.keyIdBytes, keyId: key.keyId };
        rejects(() => check({ publicKeyText: publicKeyText(forged) }), "bad-signature");
      });
    });
  }

  test("prehashed and legacy signatures of one file differ, and neither verifies as the other", () => {
    const key = generateKey();
    const prehashed = signatureText(key, bytes, { algorithm: "ED" });
    const legacy = signatureText(key, bytes, { algorithm: "Ed" });
    assert.notEqual(prehashed, legacy);
    // Relabelling the algorithm byte makes the signature cover something else.
    const relabelled = editSignature(legacy, (lines) => {
      const body = Buffer.from(lines[1], "base64");
      body.write("ED", 0, "latin1");
      return [lines[0], body.toString("base64"), lines[2], lines[3]];
    });
    rejects(() => verifyArtifact({ artifact: bytes, signatureText: relabelled, publicKeyText: publicKeyText(key) }), "bad-signature");
  });
});

describe("malformed signatures and keys", () => {
  const key = generateKey();
  const pub = publicKeyText(key);
  const sig = signatureText(key, bytes);
  const verifySig = (signatureTextValue) => () => verifyArtifact({ artifact: bytes, signatureText: signatureTextValue, publicKeyText: pub });

  test("an empty signature", () => {
    rejects(verifySig(""), "signature-format", /empty/);
    rejects(verifySig("  \r\n"), "signature-format", /empty/);
    rejects(verifySig(undefined), "signature-format", /empty/);
  });

  test("a signature cut short", () => {
    rejects(verifySig(sig.slice(0, sig.length - 7)), "signature-format", /base64/);
    rejects(verifySig(sig.slice(0, 40)), "signature-format");
    // Cut cleanly at a line boundary, so the base64 is whole but a line is missing.
    rejects(verifySig(editSignature(sig, (lines) => lines.slice(0, 3))), "signature-format", /3 lines/);
    rejects(verifySig(editSignature(sig, (lines) => lines.slice(0, 1))), "signature-format", /1 lines/);
  });

  test("text that is not a signature", () => {
    rejects(verifySig("this is not a signature!"), "signature-format", /base64/);
    rejects(verifySig(Buffer.from("hello\nworld\n").toString("base64")), "signature-format", /2 lines/);
  });

  test("the wrong comment prefixes", () => {
    rejects(verifySig(editSignature(sig, (l) => ["comment: x", l[1], l[2], l[3]])), "signature-format", /first line/);
    rejects(verifySig(editSignature(sig, (l) => [l[0], l[1], "trusted comment:no space", l[3]])), "signature-format", /third line/);
  });

  test("a signature body of the wrong length", () => {
    const short = editSignature(sig, (l) => [l[0], Buffer.from(l[1], "base64").subarray(0, 60).toString("base64"), l[2], l[3]]);
    rejects(verifySig(short), "signature-format", /60 bytes, expected 74/);
    const noGlobal = editSignature(sig, (l) => [l[0], l[1], l[2], Buffer.alloc(10).toString("base64")]);
    rejects(verifySig(noGlobal), "signature-format", /10 bytes, expected 64/);
  });

  test("an algorithm that is not supported", () => {
    const other = editSignature(sig, (l) => {
      const body = Buffer.from(l[1], "base64");
      body.write("EX", 0, "latin1");
      return [l[0], body.toString("base64"), l[2], l[3]];
    });
    rejects(verifySig(other), "unsupported-algorithm", /"EX"/);
  });

  test("base64 whose padding bits are not zero is refused, as the updater's own decoder refuses it", () => {
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    // The last character before the padding carries two or four bits no byte uses; flipping the lowest of them
    // leaves the decoded bytes as they were and the text no longer the one a decoder would write.
    const nonCanonical = (line) => {
      const pad = line.indexOf("=");
      assert.ok(pad > 0, `${line} has no padding`);
      return `${line.slice(0, pad - 1)}${ALPHABET[ALPHABET.indexOf(line[pad - 1]) ^ 1]}${line.slice(pad)}`;
    };
    const lines = Buffer.from(sig, "base64").toString("utf8").split("\n");
    for (const index of [1, 3]) {
      const changed = nonCanonical(lines[index]);
      assert.notEqual(changed, lines[index]);
      assert.deepEqual(Buffer.from(changed, "base64"), Buffer.from(lines[index], "base64"), "the same bytes, which is why a lenient decoder accepts it");
      const text = editSignature(sig, (l) => l.map((line, i) => (i === index ? changed : line)));
      rejects(verifySig(text), "signature-format", /not canonical base64/);
    }
    // The untouched signature is still fine.
    verifySig(sig)();
  });

  test("a public key that is empty, cut short, or of another kind", () => {
    const withKey = (text) => () => verifyArtifact({ artifact: bytes, signatureText: sig, publicKeyText: text });
    rejects(withKey(""), "pubkey-format", /empty/);
    rejects(withKey(pub.slice(0, pub.length - 9)), "pubkey-format");
    rejects(withKey(Buffer.from("untrusted comment: x\n").toString("base64")), "pubkey-format", /2 lines/);
    rejects(withKey(publicKeyText(key, { algorithm: "ED" })), "pubkey-format", /expected "Ed"/);
    const short = Buffer.from(`untrusted comment: minisign public key: ${key.keyId}\n${Buffer.alloc(20).toString("base64")}\n`).toString("base64");
    rejects(withKey(short), "pubkey-format", /20 bytes, expected 42/);
  });

  test("parsing reports what the file holds", () => {
    const parsed = parseSignature(sig);
    assert.equal(parsed.algorithm, "ED");
    assert.equal(parsed.prehashed, true);
    assert.equal(parsed.keyId, key.keyId);
    assert.equal(parsePublicKey(pub).keyId, key.keyId);
    assert.match(parsePublicKey(pub).comment, /minisign public key/);
  });
});

describe("text as the updater client reads it", () => {
  // tauri-plugin-updater base64-decodes latest.json's signature and the configured pubkey exactly as they are: no
  // trim, no whitespace skipped, and the decoded text is not accepted in place of the base64. `canonical` is that
  // reading; the default one is for files on disk, which editors and shells leave newlines in.
  const key = generateKey();
  const pub = publicKeyText(key);
  const sig = signatureText(key, bytes);
  const withBreaks = (text) => `${text.slice(0, 60)}\n${text.slice(60)}`;

  test("a signature that is exactly its base64 passes", () => {
    assert.equal(parseSignature(sig, { canonical: true }).keyId, key.keyId);
  });

  for (const [what, change] of [
    ["a trailing newline", (text) => `${text}\n`],
    ["a trailing space", (text) => `${text} `],
    ["a leading newline", (text) => `\n${text}`],
    ["wrapped lines", withBreaks],
    ["CRLF wrapping", (text) => `${text.slice(0, 60)}\r\n${text.slice(60)}`],
    ["a tab inside", (text) => `${text.slice(0, 8)}\t${text.slice(8)}`],
  ]) {
    test(`a signature with ${what} is refused as the updater would refuse it, though the lenient reading takes it`, () => {
      const text = change(sig);
      assert.equal(parseSignature(text).keyId, key.keyId, "the lenient reading, for a .sig file on disk");
      rejects(() => parseSignature(text, { canonical: true }), "signature-format", /whitespace/);
    });
  }

  test("a signature given as its decoded text is not what latest.json can hold", () => {
    const decoded = signatureText(key, bytes, { encoded: false });
    assert.equal(parseSignature(decoded).keyId, key.keyId);
    rejects(() => parseSignature(decoded, { canonical: true }), "signature-format", /whitespace|base64/);
  });

  test("an empty or missing signature stays an empty one", () => {
    rejects(() => parseSignature("", { canonical: true }), "signature-format", /empty/);
    rejects(() => parseSignature(undefined, { canonical: true }), "signature-format", /empty/);
  });

  test("a public key that is exactly its base64 passes", () => {
    assert.equal(parsePublicKey(pub, { canonical: true }).keyId, key.keyId);
  });

  for (const [what, change] of [
    ["a trailing newline", (text) => `${text}\n`],
    ["a leading space", (text) => ` ${text}`],
    ["wrapped lines", withBreaks],
  ]) {
    test(`a public key with ${what} is refused as the updater would refuse it, though the lenient reading takes it`, () => {
      const text = change(pub);
      assert.equal(parsePublicKey(text).keyId, key.keyId);
      rejects(() => parsePublicKey(text, { canonical: true }), "pubkey-format", /whitespace/);
    });
  }

  test("a public key given as its decoded text is refused", () => {
    const decoded = publicKeyText(key, { encoded: false });
    assert.equal(parsePublicKey(decoded).keyId, key.keyId);
    rejects(() => parsePublicKey(decoded, { canonical: true }), "pubkey-format", /whitespace|base64/);
  });

  test("the real release's key and signatures are canonical", () => {
    const { sigs } = JSON.parse(readFileSync(new URL("./fixtures/release-v0.20.3.json", import.meta.url), "utf8"));
    assert.equal(parsePublicKey(RELEASE_PUBLIC_KEY, { canonical: true }).keyId, "744BA70798B54C7B");
    for (const text of Object.values(sigs)) parseSignature(text, { canonical: true });
  });
});

describe("verifying a file on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "ancilla-minisign-"));
  const key = generateKey();
  const pub = publicKeyText(key);

  test("streams a prehashed signature and reads a legacy one whole", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    const file = join(dir, "big.bin");
    writeFileSync(file, big);
    for (const algorithm of ["ED", "Ed"]) {
      const result = await verifyArtifactFile({ artifactPath: file, signatureText: signatureText(key, big, { algorithm }), publicKeyText: pub });
      assert.equal(result.algorithm, algorithm);
    }
    writeFileSync(file, Buffer.concat([big, Buffer.from([1])]));
    await assert.rejects(verifyArtifactFile({ artifactPath: file, signatureText: signatureText(key, big), publicKeyText: pub }), { code: "bad-signature" });
  });

  test("a missing file is an io error, not a pass", async () => {
    await assert.rejects(verifyArtifactFile({ artifactPath: join(dir, "missing.bin"), signatureText: signatureText(key, bytes), publicKeyText: pub }), (error) => {
      assert.equal(error.code, "io");
      assert.match(error.message, /missing\.bin/);
      return true;
    });
    await assert.rejects(verifyArtifactFile({ artifactPath: join(dir, "missing.bin"), signatureText: signatureText(key, bytes, { algorithm: "Ed" }), publicKeyText: pub }), { code: "io" });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));
});

describe("a signature written by the real Tauri CLI", () => {
  test("verifies against its key, as prehashed 'ED'", () => {
    const result = verifyArtifact({ artifact: PAYLOAD, signatureText: SIGNATURE, publicKeyText: PUBLIC_KEY });
    assert.equal(result.algorithm, "ED");
    assert.match(result.trustedComment, /^timestamp:\d+\tfile:payload\.txt$/);
  });

  test("fails for a changed file, an edited comment and another key", () => {
    rejects(() => verifyArtifact({ artifact: Buffer.concat([PAYLOAD, Buffer.from("\n")]), signatureText: SIGNATURE, publicKeyText: PUBLIC_KEY }), "bad-signature");
    const edited = editSignature(SIGNATURE, (l) => [l[0], l[1], l[2].replace("payload.txt", "other.txt"), l[3]]);
    rejects(() => verifyArtifact({ artifact: PAYLOAD, signatureText: edited, publicKeyText: PUBLIC_KEY }), "bad-trusted-comment");
    rejects(() => verifyArtifact({ artifact: PAYLOAD, signatureText: SIGNATURE, publicKeyText: RELEASE_PUBLIC_KEY }), "key-mismatch");
  });
});

describe("the signatures of the real 0.20.3 release", () => {
  const { latest, sigs } = JSON.parse(readFileSync(new URL("./fixtures/release-v0.20.3.json", import.meta.url), "utf8"));
  const publicKey = parsePublicKey(RELEASE_PUBLIC_KEY);

  test("every .sig parses, names the release key and says 'ED'", () => {
    const names = Object.keys(sigs);
    assert.equal(names.length, 5);
    for (const name of names) {
      const parsed = parseSignature(sigs[name]);
      assert.equal(parsed.algorithm, "ED", name);
      assert.equal(parsed.keyId, publicKey.keyId, name);
      assert.match(parsed.trustedComment, /^timestamp:\d+\tfile:/, name);
    }
  });

  test("every trusted comment verifies against the release key without the artifact", () => {
    for (const [name, text] of Object.entries(sigs)) {
      verifyTrustedComment(publicKey, parseSignature(text));
      assert.ok(name.endsWith(".sig"));
    }
  });

  test("an edited trusted comment on a real signature is caught", () => {
    const text = sigs["Ancilla_0.20.3_amd64.AppImage.sig"];
    const edited = editSignature(text, (l) => [l[0], l[1], l[2].replace("0.20.3", "0.20.4"), l[3]]);
    rejects(() => verifyTrustedComment(publicKey, parseSignature(edited)), "bad-trusted-comment");
  });

  test("latest.json carries exactly the text of the .sig files", () => {
    assert.equal(latest.platforms["linux-x86_64-appimage"].signature, sigs["Ancilla_0.20.3_amd64.AppImage.sig"]);
    assert.equal(latest.platforms["windows-x86_64"].signature, sigs["Ancilla_0.20.3_x64-setup.exe.sig"]);
  });
});

describe("the key in tauri.conf.json", () => {
  test("is a minisign public key whose id matches its own comment", () => {
    const conf = readFileSync(repoFile("apps/desktop/src-tauri/tauri.conf.json"), "utf8");
    const key = parsePublicKey(publicKeyFromConfig(conf));
    assert.match(key.comment, new RegExp(`${key.keyId}$`));
  });

  test("a config without a key is an error that names the file", () => {
    rejects(() => publicKeyFromConfig("{}", "old.json"), "pubkey-format", /old\.json has no plugins\.updater\.pubkey/);
    rejects(() => publicKeyFromConfig("{ not json", "old.json"), "pubkey-format", /not valid JSON/);
    rejects(() => publicKeyFromConfig(JSON.stringify({ plugins: { updater: { pubkey: "  " } } })), "pubkey-format");
  });
});
