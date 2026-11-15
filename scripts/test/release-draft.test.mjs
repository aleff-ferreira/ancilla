import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  OPTIONAL_PLATFORMS,
  REQUIRED_PLATFORMS,
  ReleaseCheckError,
  auditArtifactBytes,
  auditDraft,
  checkContinuity,
  checkDraft,
  compareSemver,
  continuityProblems,
  discardDrafts,
  expectedAssets,
  parseSemver,
  prepareTag,
  publishDraft,
  replaceAppImage,
  resolveTrustedConfig,
  rewriteManifestForAppImage,
} from "../lib/release-draft.mjs";
import { ENDPOINTS, IDENTIFIER, REPO, buildDraft, draftInputs, fakeClient, platformAssets, setAssetBytes, sha256, updaterConf } from "./helpers/fake-release.mjs";
import { RELEASE_PUBLIC_KEY } from "./fixtures/tauri-signed.mjs";
import { generateKey, publicKeyText, signatureText } from "./helpers/minisign.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const audit = (draft, expect = {}, extra = {}) =>
  auditDraft({ release: draft.release, manifest: draft.manifest, signatures: draft.signatures, expect: { ...draft.expect, ...expect }, trustedKeyText: draft.trustedKeyText, ...extra });

/** A copy of the draft that a test may damage. */
const copy = (draft) => ({ ...draft, release: structuredClone(draft.release), manifest: structuredClone(draft.manifest), signatures: { ...draft.signatures }, files: new Map(draft.files) });
const asset = (draft, name) => draft.release.assets.find((candidate) => candidate.name === name);
const removeAsset = (draft, name) => {
  draft.release.assets = draft.release.assets.filter((candidate) => candidate.name !== name);
};

describe("the assets a release must have", () => {
  test("are named from the product and version, twelve in all with deb and rpm", () => {
    const assets = expectedAssets({ productName: "Ancilla", version: "0.20.3" });
    assert.deepEqual(
      assets.map((entry) => entry.name).sort(),
      [
        "Ancilla-0.20.3-1.x86_64.rpm",
        "Ancilla-0.20.3-1.x86_64.rpm.sig",
        "Ancilla_0.20.3_amd64.AppImage",
        "Ancilla_0.20.3_amd64.AppImage.sig",
        "Ancilla_0.20.3_amd64.deb",
        "Ancilla_0.20.3_amd64.deb.sig",
        "Ancilla_0.20.3_universal.dmg",
        "Ancilla_0.20.3_x64-setup.exe",
        "Ancilla_0.20.3_x64-setup.exe.sig",
        "Ancilla_universal.app.tar.gz",
        "Ancilla_universal.app.tar.gz.sig",
        "latest.json",
      ],
    );
    assert.equal(expectedAssets({ productName: "Ancilla", version: "0.20.3", linuxPackages: false }).length, 8);
  });

  test("carry only the name: nothing reads a flag that says which are signed", () => {
    for (const entry of expectedAssets({ productName: "Ancilla", version: "0.20.3" })) {
      assert.deepEqual(Object.keys(entry), ["name"], entry.name);
    }
  });

  test("agree with the bundle targets in the Tauri configs", () => {
    const read = (file) => JSON.parse(readFileSync(new URL(`../../apps/desktop/src-tauri/${file}`, import.meta.url), "utf8"));
    const base = read("tauri.conf.json");
    assert.deepEqual(base.bundle.targets, ["nsis"]);
    assert.equal(base.bundle.createUpdaterArtifacts, true);
    assert.deepEqual(read("tauri.macos.conf.json").bundle.targets.slice().sort(), ["app", "dmg"]);
    assert.deepEqual(read("tauri.linux.conf.json").bundle.targets.slice().sort(), ["appimage", "deb", "rpm"]);
    assert.equal(base.productName, "Ancilla");
  });

  test("the platforms are the ones the updater looks up", () => {
    assert.deepEqual([...REQUIRED_PLATFORMS].sort(), [
      "darwin-aarch64",
      "darwin-aarch64-app",
      "darwin-x86_64",
      "darwin-x86_64-app",
      "linux-x86_64",
      "linux-x86_64-appimage",
      "windows-x86_64",
      "windows-x86_64-nsis",
    ]);
    assert.deepEqual([...OPTIONAL_PLATFORMS].sort(), ["linux-x86_64-deb", "linux-x86_64-rpm"]);
  });
});

describe("auditing a draft", () => {
  const good = buildDraft();

  test("a complete, correctly signed draft has no problems", () => {
    assert.deepEqual(audit(good), []);
  });

  test("a dry-run draft is a prerelease with a dry-run tag, and that is all it can be", () => {
    const dry = buildDraft({ dryRun: true });
    assert.deepEqual(audit(dry), []);
    assert.match(audit(dry, { dryRun: false }).join("\n"), /prerelease/);
    const notPrerelease = copy(dry);
    notPrerelease.release.prerelease = false;
    assert.match(audit(notPrerelease).join("\n"), /dry-run draft must be a prerelease/);
    const badTag = buildDraft({ dryRun: true, tag: "dry-run-abc" });
    assert.match(audit(badTag).join("\n"), /dry-run tag/);
  });

  test("a real release must not be a prerelease, or the updater never sees it", () => {
    const draft = copy(good);
    draft.release.prerelease = true;
    assert.match(audit(draft).join("\n"), /marked prerelease/);
  });

  test("a release that is already published is not a draft", () => {
    const draft = copy(good);
    draft.release.draft = false;
    assert.match(audit(draft).join("\n"), /not a draft/);
  });

  test("the tag must be v<version> and the manifest's version the same", () => {
    const wrongTag = copy(good);
    wrongTag.release.tag_name = "v0.20.5";
    assert.match(audit(wrongTag, { tag: "v0.20.5" }).join("\n"), /tag v0\.20\.5 is not v0\.20\.4/);
    assert.match(audit(good, { tag: "v0.20.3" }).join("\n"), /tag/);
    const mismatch = copy(good);
    mismatch.release.tag_name = "v0.20.3";
    assert.match(audit(mismatch).join("\n"), /release is tagged v0\.20\.3, expected v0\.20\.4/);
    const manifestVersion = copy(good);
    manifestVersion.manifest.version = "0.20.3";
    assert.match(audit(manifestVersion).join("\n"), /latest\.json says version 0\.20\.3, expected 0\.20\.4/);
  });

  test("a missing platform is named", () => {
    const draft = copy(good);
    delete draft.manifest.platforms["darwin-aarch64"];
    delete draft.manifest.platforms["linux-x86_64"];
    const problems = audit(draft);
    assert.ok(problems.some((p) => /missing platform darwin-aarch64/.test(p)), problems.join("\n"));
    assert.ok(problems.some((p) => /missing platform linux-x86_64\b/.test(p)), problems.join("\n"));
  });

  test("the dead deb and rpm updater entries may be there or not, but an unknown platform may not", () => {
    const without = copy(good);
    delete without.manifest.platforms["linux-x86_64-deb"];
    delete without.manifest.platforms["linux-x86_64-rpm"];
    assert.deepEqual(audit(without), []);
    const extra = copy(good);
    extra.manifest.platforms["freebsd-x86_64"] = { signature: "x", url: "https://example.invalid/x" };
    assert.match(audit(extra).join("\n"), /unexpected platform freebsd-x86_64/);
  });

  test("an untagged download URL is refused", () => {
    const draft = copy(good);
    draft.manifest.platforms["windows-x86_64"].url = `https://github.com/${REPO}/releases/download/untagged-0a1b2c3d4e5f/Ancilla_0.20.4_x64-setup.exe`;
    const problems = audit(draft);
    assert.ok(problems.some((p) => /windows-x86_64: .*untagged/.test(p)), problems.join("\n"));
  });

  test("a URL for another tag, another repository or another file is refused", () => {
    for (const url of [
      `https://github.com/${REPO}/releases/download/v0.20.3/Ancilla_0.20.4_x64-setup.exe`,
      `https://github.com/someone/else/releases/download/v0.20.4/Ancilla_0.20.4_x64-setup.exe`,
      `https://github.com/${REPO}/releases/download/v0.20.4/Ancilla_0.20.4_amd64.deb`,
      `https://github.com/${REPO}/releases/latest/download/Ancilla_0.20.4_x64-setup.exe`,
      "",
    ]) {
      const draft = copy(good);
      draft.manifest.platforms["windows-x86_64"].url = url;
      assert.match(audit(draft).join("\n"), /windows-x86_64: url is/, url);
    }
  });

  test("a signature that is not the .sig asset's text is refused", () => {
    const draft = copy(good);
    const other = signatureText(generateKey(), Buffer.from("x"));
    draft.manifest.platforms["linux-x86_64-appimage"].signature = other;
    assert.match(audit(draft).join("\n"), /linux-x86_64-appimage: signature differs from Ancilla_0\.20\.4_amd64\.AppImage\.sig/);
    const missing = copy(good);
    delete missing.manifest.platforms["linux-x86_64"].signature;
    assert.match(audit(missing).join("\n"), /linux-x86_64: no signature/);
    const noSigAsset = copy(good);
    delete noSigAsset.signatures["Ancilla_0.20.4_amd64.AppImage.sig"];
    assert.match(audit(noSigAsset).join("\n"), /linux-x86_64: .*no .*AppImage\.sig/);
  });

  test("a signature made with another key is refused, because installed copies would refuse it", () => {
    const stranger = generateKey();
    const draft = copy(good);
    const name = "Ancilla_0.20.4_amd64.AppImage";
    const forged = signatureText(stranger, Buffer.from("x"), { trustedComment: `timestamp:1\tfile:${name}` });
    draft.signatures[`${name}.sig`] = forged;
    draft.manifest.platforms["linux-x86_64"].signature = forged;
    draft.manifest.platforms["linux-x86_64-appimage"].signature = forged;
    const problems = audit(draft);
    assert.ok(problems.some((p) => new RegExp(`${name}\\.sig: .*${stranger.keyId}`).test(p)), problems.join("\n"));
  });

  test("an unparseable signature is refused", () => {
    const draft = copy(good);
    draft.signatures["Ancilla_0.20.4_x64-setup.exe.sig"] = "not a signature";
    draft.manifest.platforms["windows-x86_64"].signature = "not a signature";
    draft.manifest.platforms["windows-x86_64-nsis"].signature = "not a signature";
    assert.match(audit(draft).join("\n"), /Ancilla_0\.20\.4_x64-setup\.exe\.sig: .*base64/);
  });

  test("a signature in latest.json is read as the updater reads it: no trimming, no whitespace skipped", () => {
    // The updater decodes the string as it stands, so a trailing newline or wrapped lines fail in every installed copy.
    const name = "Ancilla_0.20.4_amd64.AppImage";
    const exact = good.signatures[`${name}.sig`];
    assert.equal(exact, exact.trim(), "the fixture is canonical to begin with");
    for (const [what, text] of [
      ["a trailing newline", `${exact}\n`],
      ["a leading space", ` ${exact}`],
      ["wrapped lines", `${exact.slice(0, 76)}\n${exact.slice(76)}`],
      ["CRLF line breaks", `${exact.slice(0, 76)}\r\n${exact.slice(76)}`],
    ]) {
      const draft = copy(good);
      draft.manifest.platforms["linux-x86_64"].signature = text;
      draft.manifest.platforms["linux-x86_64-appimage"].signature = text;
      draft.signatures[`${name}.sig`] = text;
      const problems = audit(draft);
      assert.ok(problems.some((p) => /^linux-x86_64: .*whitespace/.test(p)), `${what}: ${problems.join("\n")}`);
      assert.ok(problems.some((p) => /^linux-x86_64-appimage: .*whitespace/.test(p)), what);
    }
  });

  test("a .sig asset is read as a file is, so a trailing newline in it is fine while latest.json holds the plain text", () => {
    const name = "Ancilla_0.20.4_amd64.AppImage";
    const draft = copy(good);
    draft.signatures[`${name}.sig`] = `${good.signatures[`${name}.sig`]}\r\n`;
    assert.deepEqual(audit(draft), []);
  });

  test("the trusted public key is read as the updater reads it too", () => {
    for (const [what, text] of [
      ["a trailing newline", `${good.trustedKeyText}\n`],
      ["a leading space", ` ${good.trustedKeyText}`],
      ["wrapped lines", `${good.trustedKeyText.slice(0, 40)}\n${good.trustedKeyText.slice(40)}`],
    ]) {
      const problems = audit(good, {}, { trustedKeyText: text });
      assert.ok(problems.some((p) => /trusted public key is unusable: .*whitespace/.test(p)), `${what}: ${problems.join("\n")}`);
    }
  });

  test("an asset uploaded before the run started is stale", () => {
    const draft = copy(good);
    asset(draft, "Ancilla_0.20.4_amd64.deb").created_at = "2026-10-19T10:00:00Z";
    const problems = audit(draft);
    assert.ok(problems.some((p) => /Ancilla_0\.20\.4_amd64\.deb: uploaded 2026-10-19T10:00:00Z, before the run started/.test(p)), problems.join("\n"));
  });

  test("a little clock difference between the runner and GitHub is tolerated, an hour is not", () => {
    const draft = copy(good);
    asset(draft, "latest.json").created_at = "2026-10-20T09:59:30Z";
    assert.deepEqual(audit(draft), []);
    asset(draft, "latest.json").created_at = "2026-10-20T09:00:00Z";
    assert.match(audit(draft).join("\n"), /latest\.json: uploaded .* before the run started/);
    assert.match(audit(draft, { startedAt: "not a time" }).join("\n"), /run start time/);
  });

  test("missing, extra and duplicated assets are named", () => {
    const missing = copy(good);
    removeAsset(missing, "Ancilla_0.20.4_universal.dmg");
    removeAsset(missing, "Ancilla_universal.app.tar.gz.sig");
    const missingProblems = audit(missing).join("\n");
    assert.match(missingProblems, /missing asset Ancilla_0\.20\.4_universal\.dmg/);
    assert.match(missingProblems, /missing asset Ancilla_universal\.app\.tar\.gz\.sig/);

    const extra = copy(good);
    extra.release.assets.push({ ...asset(extra, "latest.json"), id: 1, name: "Ancilla_0.20.3_amd64.AppImage" });
    assert.match(audit(extra).join("\n"), /unexpected asset Ancilla_0\.20\.3_amd64\.AppImage/);

    const twice = copy(good);
    twice.release.assets.push({ ...asset(twice, "latest.json"), id: 2 });
    assert.match(audit(twice).join("\n"), /latest\.json is attached 2 times/);
  });

  test("an asset that is not fully uploaded or is empty is refused", () => {
    const draft = copy(good);
    asset(draft, "Ancilla_0.20.4_amd64.AppImage").state = "starter";
    asset(draft, "Ancilla_0.20.4_x64-setup.exe").size = 0;
    const problems = audit(draft).join("\n");
    assert.match(problems, /Ancilla_0\.20\.4_amd64\.AppImage: state is starter, not uploaded/);
    assert.match(problems, /Ancilla_0\.20\.4_x64-setup\.exe: is empty/);
  });

  test("notes that do not say what is new in this version are refused", () => {
    const stale = copy(good);
    stale.manifest.notes = "Ancilla v0.20.4\n\n**New in 0.20.3**\n- Old news.\n";
    assert.match(audit(stale).join("\n"), /notes do not contain "New in 0\.20\.4"/);
    const none = copy(good);
    delete none.manifest.notes;
    assert.match(audit(none).join("\n"), /notes are missing/);
  });

  test("a manifest that is missing or not an object is refused", () => {
    assert.match(audit(good, {}, { manifest: null }).join("\n"), /latest\.json is missing or unreadable/);
    assert.match(audit(good, {}, { manifest: [] }).join("\n"), /latest\.json is not an object/);
    assert.match(audit(good, {}, { manifest: { version: "0.20.4", notes: "New in 0.20.4" } }).join("\n"), /no platforms/);
  });

  test("reports every problem, not only the first", () => {
    const draft = copy(good);
    draft.release.draft = false;
    draft.manifest.version = "9.9.9";
    delete draft.manifest.platforms["darwin-x86_64"];
    removeAsset(draft, "Ancilla_0.20.4_amd64.deb");
    assert.ok(audit(draft).length >= 4);
  });
});

describe("auditing the real releases", () => {
  test("the real v0.20.3 passes as a draft of itself", () => {
    const { release, latest, sigs } = fixture("release-v0.20.3.json");
    const problems = auditDraft({
      release: { ...release, draft: true },
      manifest: latest,
      signatures: sigs,
      expect: { repo: REPO, tag: "v0.20.3", version: "0.20.3", productName: "Ancilla", dryRun: false, startedAt: "2026-09-29T06:58:00Z" },
      trustedKeyText: RELEASE_PUBLIC_KEY,
    });
    assert.deepEqual(problems, []);
  });

  test("the real v0.20.3 fails against its own key replaced, with a stale start time and as a published release", () => {
    const { release, latest, sigs } = fixture("release-v0.20.3.json");
    const base = { manifest: latest, signatures: sigs, expect: { repo: REPO, tag: "v0.20.3", version: "0.20.3", productName: "Ancilla", dryRun: false, startedAt: "2026-09-29T06:58:00Z" } };
    assert.match(auditDraft({ ...base, release, trustedKeyText: RELEASE_PUBLIC_KEY }).join("\n"), /not a draft/);
    assert.match(auditDraft({ ...base, release: { ...release, draft: true }, trustedKeyText: publicKeyText(generateKey()) }).join("\n"), /signed with key 744BA70798B54C7B/);
    const later = { ...base, expect: { ...base.expect, startedAt: "2026-09-29T07:20:00Z" } };
    assert.match(auditDraft({ ...later, release: { ...release, draft: true }, trustedKeyText: RELEASE_PUBLIC_KEY }).join("\n"), /before the run started/);
  });

  test("the real v0.20.2 predates deb and rpm: fine without them, exactly those four missing with them", () => {
    const { release, latest, sigs } = fixture("release-v0.20.2.json");
    const input = {
      release: { ...release, draft: true },
      manifest: latest,
      signatures: sigs,
      expect: { repo: REPO, tag: "v0.20.2", version: "0.20.2", productName: "Ancilla", dryRun: false, startedAt: "2026-09-28T15:30:00Z", linuxPackages: false },
      trustedKeyText: RELEASE_PUBLIC_KEY,
    };
    assert.deepEqual(auditDraft(input), []);
    const problems = auditDraft({ ...input, expect: { ...input.expect, linuxPackages: true } });
    assert.deepEqual(
      problems.map((p) => /missing asset (\S+)/.exec(p)?.[1]).sort(),
      ["Ancilla-0.20.2-1.x86_64.rpm", "Ancilla-0.20.2-1.x86_64.rpm.sig", "Ancilla_0.20.2_amd64.deb", "Ancilla_0.20.2_amd64.deb.sig"],
    );
  });

  test("the real manifests point at tagged URLs, never untagged ones", () => {
    for (const name of ["release-v0.20.2.json", "release-v0.20.3.json"]) {
      const { latest } = fixture(name);
      for (const platform of Object.values(latest.platforms)) {
        assert.doesNotMatch(platform.url, /untagged-/);
      }
    }
  });
});

describe("the bytes of the artifacts", () => {
  const good = buildDraft();
  const bytesCheck = (draft, over = {}) =>
    auditArtifactBytes({ client: fakeClient({ releases: [draft.release], files: draft.files }), release: draft.release, signatures: draft.signatures, trustedKeyText: draft.trustedKeyText, expectedSha256: {}, ...over });

  test("every signed artifact verifies against its bytes", async () => {
    assert.deepEqual(await bytesCheck(good), []);
  });

  test("the trusted key is read as the updater reads it here as well: whitespace around it is a problem, and nothing is downloaded", async () => {
    const client = fakeClient({ releases: [good.release], files: good.files });
    for (const trustedKeyText of [`${good.trustedKeyText}\n`, ` ${good.trustedKeyText}`, "", "not a key"]) {
      const problems = await auditArtifactBytes({ client, release: good.release, signatures: good.signatures, trustedKeyText, expectedSha256: {} });
      assert.equal(problems.length, 1, trustedKeyText);
      assert.match(problems[0], /the trusted public key is unusable: /);
    }
    assert.match((await auditArtifactBytes({ client, release: good.release, signatures: good.signatures, trustedKeyText: `${good.trustedKeyText}\n`, expectedSha256: {} }))[0], /whitespace/);
    assert.equal(client.calls.length, 0);
  });

  test("only artifacts with a signature are downloaded", async () => {
    const client = fakeClient({ releases: [good.release], files: good.files });
    await auditArtifactBytes({ client, release: good.release, signatures: good.signatures, trustedKeyText: good.trustedKeyText, expectedSha256: {} });
    const downloaded = client.calls.filter((call) => call.op === "downloadAsset").map((call) => good.release.assets.find((a) => a.id === call.id).name);
    assert.deepEqual(downloaded.sort(), [
      "Ancilla-0.20.4-1.x86_64.rpm",
      "Ancilla_0.20.4_amd64.AppImage",
      "Ancilla_0.20.4_amd64.deb",
      "Ancilla_0.20.4_x64-setup.exe",
      "Ancilla_universal.app.tar.gz",
    ]);
  });

  test("an installer changed after it was signed fails, even though its upload looks fine", async () => {
    const draft = copy(good);
    setAssetBytes(draft, "Ancilla_0.20.4_amd64.AppImage", Buffer.from("a repacked AppImage nobody signed again"));
    const problems = await bytesCheck(draft);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /Ancilla_0\.20\.4_amd64\.AppImage: .*does not match the file/);
  });

  test("the unrepacked image under the new signature fails too", async () => {
    const key = generateKey();
    const draft = buildDraft({ key });
    const repacked = Buffer.from("the repacked image");
    const name = "Ancilla_0.20.4_amd64.AppImage";
    const sig = signatureText(key, repacked, { trustedComment: `timestamp:2\tfile:${name}` });
    draft.signatures[`${name}.sig`] = sig;
    const problems = await bytesCheck(draft);
    assert.match(problems.join("\n"), /does not match the file/);
  });

  test("a signature from another key fails", async () => {
    const draft = copy(good);
    const problems = await bytesCheck(draft, { trustedKeyText: publicKeyText(generateKey()) });
    assert.equal(problems.length, 5);
    assert.match(problems[0], /signed with key/);
  });

  test("the digest GitHub reports must be that of the bytes", async () => {
    const draft = copy(good);
    asset(draft, "Ancilla_universal.app.tar.gz").digest = `sha256:${"0".repeat(64)}`;
    assert.match((await bytesCheck(draft)).join("\n"), /Ancilla_universal\.app\.tar\.gz: GitHub reports digest sha256:0{64}, the bytes hash to sha256:[0-9a-f]{64}/);
  });

  test("the AppImage the Linux job built must be the one in the draft", async () => {
    const name = "Ancilla_0.20.4_amd64.AppImage";
    const built = sha256(good.files.get(asset(good, name).id));
    assert.deepEqual(await bytesCheck(good, { expectedSha256: { [name]: built } }), []);
    const problems = await bytesCheck(good, { expectedSha256: { [name]: "f".repeat(64) } });
    assert.match(problems.join("\n"), new RegExp(`${name}: the build produced sha256:f{64}, the draft holds sha256:${built}`));
  });

  test("a digest expected for a name that matches no signed asset is a problem, not silently dropped", async () => {
    // The Linux job's output is the only build-side check of the AppImage: a name or version skew must not make it vanish.
    const skewed = "Ancilla_9.9.9_amd64.AppImage";
    const problems = await bytesCheck(good, { expectedSha256: { [skewed]: "0".repeat(64) } });
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(`${skewed.replace(/\./g, "\\.")}.*matches no signed asset`));
    // An asset that exists but is never downloaded (no .sig) is not compared either.
    const dmg = "Ancilla_0.20.4_universal.dmg";
    assert.match((await bytesCheck(good, { expectedSha256: { [dmg]: "0".repeat(64) } })).join("\n"), /universal\.dmg.*matches no signed asset/);
    // Every name is reported, and a name that was compared is not.
    const name = "Ancilla_0.20.4_amd64.AppImage";
    const built = sha256(good.files.get(asset(good, name).id));
    const both = await bytesCheck(good, { expectedSha256: { [name]: built, [skewed]: "1".repeat(64), "other.AppImage": "2".repeat(64) } });
    assert.equal(both.length, 2, both.join("\n"));
  });

  test("a missing digest on the asset is not an error: the bytes are checked anyway", async () => {
    const draft = copy(good);
    for (const a of draft.release.assets) delete a.digest;
    assert.deepEqual(await bytesCheck(draft), []);
  });
});

describe("checking and publishing a draft through the client", () => {
  const clientFor = (draft) => fakeClient({ releases: [draft.release], files: draft.files });
  const patches = (client) => client.calls.filter((call) => call.op === "patchRelease");

  test("checkDraft reads the manifest and the signatures from the release itself", async () => {
    const draft = buildDraft();
    const result = await checkDraft({ client: clientFor(draft), ...draftInputs(draft) });
    assert.deepEqual(result.problems, []);
  });

  test("checkDraft finds a latest.json that does not parse, or that is gone", async () => {
    const broken = buildDraft();
    setAssetBytes(broken, "latest.json", Buffer.from("{ not json"));
    const result = await checkDraft({ client: clientFor(broken), ...draftInputs(broken) });
    assert.match(result.problems.join("\n"), /latest\.json is not valid JSON/);

    const gone = buildDraft();
    removeAsset(gone, "latest.json");
    const missing = await checkDraft({ client: clientFor(gone), ...draftInputs(gone) });
    assert.match(missing.problems.join("\n"), /missing asset latest\.json/);
    assert.match(missing.problems.join("\n"), /latest\.json is missing or unreadable/);
  });

  test("a latest.json that starts with a byte order mark is read like any other", async () => {
    const draft = buildDraft();
    setAssetBytes(draft, "latest.json", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(draft.manifest))]));
    const result = await checkDraft({ client: clientFor(draft), ...draftInputs(draft), verifyBytes: false });
    assert.deepEqual(result.problems, []);
  });

  test("checkDraft can skip the downloads of the big artifacts", async () => {
    const draft = buildDraft();
    const client = clientFor(draft);
    await checkDraft({ client, ...draftInputs(draft), verifyBytes: false });
    assert.equal(client.calls.filter((call) => call.op === "downloadAsset").length, 1 + Object.keys(draft.signatures).length);
  });

  test("publishing sends draft=false once, only after every check passed", async () => {
    const draft = buildDraft();
    const client = clientFor(draft);
    const after = await publishDraft({ client, ...draftInputs(draft) });
    assert.equal(after.draft, false);
    assert.deepEqual(patches(client), [{ op: "patchRelease", id: 777, fields: { draft: false } }]);
    const lastRead = client.calls.map((call) => call.op).lastIndexOf("downloadAsset");
    assert.ok(client.calls.findIndex((call) => call.op === "patchRelease") > lastRead, "the PATCH comes after the last download");
  });

  for (const [what, damage] of [
    ["a stale asset", (draft) => (asset(draft, "Ancilla_0.20.4_amd64.deb").created_at = "2026-01-01T00:00:00Z")],
    ["a missing platform", (draft) => delete draft.manifest.platforms["darwin-aarch64"]],
    ["an untagged URL", (draft) => (draft.manifest.platforms["linux-x86_64"].url = `https://github.com/${REPO}/releases/download/untagged-aaaa/Ancilla_0.20.4_amd64.AppImage`)],
    ["an installer changed after signing", (draft) => setAssetBytes(draft, "Ancilla_0.20.4_x64-setup.exe", Buffer.from("tampered"))],
    ["a version that is not the tag", (draft) => (draft.manifest.version = "0.20.9")],
  ]) {
    test(`publishing never sends a PATCH when there is ${what}`, async () => {
      const draft = buildDraft();
      damage(draft);
      if (draft.manifest) setAssetBytes(draft, "latest.json", Buffer.from(JSON.stringify(draft.manifest)));
      const client = clientFor(draft);
      await assert.rejects(publishDraft({ client, ...draftInputs(draft) }), (error) => {
        assert.ok(error instanceof ReleaseCheckError);
        assert.ok(error.problems.length >= 1);
        return true;
      });
      assert.equal(patches(client).length, 0);
      assert.equal(client.releases[0].draft, true);
    });
  }

  test("publishing a release that is already published is refused", async () => {
    const draft = buildDraft();
    draft.release.draft = false;
    const client = clientFor(draft);
    await assert.rejects(publishDraft({ client, ...draftInputs(draft) }), /not a draft/);
    assert.equal(patches(client).length, 0);
  });

  describe("what the PATCH answers", () => {
    test("is the state that counts: no read after the write is needed, so a stale one cannot fail a release that is public", async () => {
      const draft = buildDraft();
      const client = clientFor(draft);
      const read = client.getRelease;
      let afterPatch = false;
      const patch = client.patchRelease;
      client.patchRelease = async (...args) => {
        const answer = await patch(...args);
        afterPatch = true;
        return answer;
      };
      client.getRelease = async (id) => {
        if (afterPatch) throw new Error("a stale read right after the write");
        return read(id);
      };
      const result = await publishDraft({ client, ...draftInputs(draft) });
      assert.equal(result.draft, false);
      assert.equal(client.calls.at(-1).op, "patchRelease", "nothing was read after the PATCH");
    });

    test("a response that says the release is still a draft is an error, without another read", async () => {
      const draft = buildDraft();
      const client = clientFor(draft);
      client.patchRelease = async (id, fields) => {
        client.calls.push({ op: "patchRelease", id, fields });
        return { ...client.releases[0], draft: true };
      };
      await assert.rejects(publishDraft({ client, ...draftInputs(draft) }), /still a draft/);
      assert.equal(client.calls.at(-1).op, "patchRelease");
    });

    test("a response for a prerelease or another tag is an error", async () => {
      for (const [change, pattern] of [
        [{ prerelease: true }, /published as a prerelease/],
        [{ tag_name: "v9.9.9" }, /tag v9\.9\.9/],
      ]) {
        const draft = buildDraft();
        const client = clientFor(draft);
        client.patchRelease = async (id, fields) => {
          client.calls.push({ op: "patchRelease", id, fields });
          return { ...client.releases[0], draft: false, ...change };
        };
        await assert.rejects(publishDraft({ client, ...draftInputs(draft) }), pattern);
      }
    });

    test("an answer that holds no release is checked with a read instead: still a draft is an error, a published release is a pass", async () => {
      for (const answer of [undefined, null, {}, "ok"]) {
        const draft = buildDraft();
        const client = clientFor(draft);
        const patch = client.patchRelease;
        client.patchRelease = async (...args) => {
          await patch(...args);
          return answer;
        };
        const result = await publishDraft({ client, ...draftInputs(draft) });
        assert.equal(result.draft, false, JSON.stringify(answer));
        assert.equal(client.calls.at(-1).op, "getRelease");
      }
      const stuck = buildDraft();
      const client = clientFor(stuck);
      client.patchRelease = async (id, fields) => {
        client.calls.push({ op: "patchRelease", id, fields });
      };
      await assert.rejects(publishDraft({ client, ...draftInputs(stuck) }), /still a draft/);
    });
  });

  test("the key and both configurations are required: publishing without one stops before anything is read", async () => {
    const draft = buildDraft();
    const client = clientFor(draft);
    await assert.rejects(publishDraft({ client, ...draftInputs(draft, { trustedKeyText: undefined }) }), /no trusted public key was given/);
    await assert.rejects(checkDraft({ client, ...draftInputs(draft, { trustedKeyText: "" }) }), /no trusted public key was given/);
    await assert.rejects(publishDraft({ client, ...draftInputs(draft, { conf: undefined }) }), /no configuration to compare/);
    await assert.rejects(publishDraft({ client, ...draftInputs(draft, { trustedConf: undefined }) }), /no configuration to compare/);
    assert.deepEqual(client.calls, [], "no read, no download, no PATCH");
  });

  for (const [what, change] of [
    ["is published by someone else", (release) => (release.draft = false)],
    ["is renamed to another tag", (release) => (release.tag_name = "v9.9.9")],
  ]) {
    test(`a release that ${what} while the checks run is not published again`, async () => {
      const draft = buildDraft();
      const client = clientFor(draft);
      const read = client.getRelease;
      let reads = 0;
      // The first read is the checks' own; the second is the look just before the PATCH.
      client.getRelease = async (id) => {
        const release = await read(id);
        if (++reads === 2) change(release);
        return release;
      };
      await assert.rejects(publishDraft({ client, ...draftInputs(draft) }), /changed while it was being checked/);
      assert.equal(reads, 2);
      assert.equal(patches(client).length, 0);
      assert.equal(client.releases[0].draft, true);
    });
  }

  describe("an asset changed after it was checked", () => {
    const target = "Ancilla_0.20.4_amd64.AppImage";
    for (const [what, change, pattern] of [
      [
        "replaced by another upload under the same name",
        (release) => {
          const old = release.assets.find((a) => a.name === target);
          old.id += 1000;
          old.updated_at = "2026-10-20T10:40:00Z";
        },
        /replaced/,
      ],
      ["touched, with its size and digest as they were", (release) => (release.assets.find((a) => a.name === target).updated_at = "2026-10-20T10:41:00Z"), /updated_at/],
      ["given other bytes of another size", (release) => (release.assets.find((a) => a.name === target).size += 1), /size/],
      ["left in another state, with everything else as it was", (release) => (release.assets.find((a) => a.name === target).state = "open"), /changed: state was uploaded, now open/],
      ["given another digest",(release) => (release.assets.find((a) => a.name === target).digest = `sha256:${"0".repeat(64)}`), /digest/],
      ["removed", (release) => (release.assets = release.assets.filter((a) => a.name !== target)), /removed/],
      ["joined by one more", (release) => release.assets.push({ ...release.assets[0], id: 424242, name: "extra.bin" }), /added/],
    ]) {
      test(`${what} while the checks run is refused, and nothing is published`, async () => {
        const draft = buildDraft();
        const client = clientFor(draft);
        const read = client.getRelease;
        let reads = 0;
        client.getRelease = async (id) => {
          const release = await read(id);
          if (++reads === 2) change(release);
          return release;
        };
        await assert.rejects(publishDraft({ client, ...draftInputs(draft) }), (error) => {
          assert.ok(error instanceof ReleaseCheckError);
          assert.match(error.message, /changed while it was being checked/);
          assert.match(error.message, pattern);
          return true;
        });
        assert.equal(patches(client).length, 0);
        assert.equal(client.releases[0].draft, true);
      });
    }

    test("a release whose assets are the same, listed in another order, is published", async () => {
      const draft = buildDraft();
      const client = clientFor(draft);
      const read = client.getRelease;
      let reads = 0;
      client.getRelease = async (id) => {
        const release = await read(id);
        if (++reads === 2) release.assets.reverse();
        return release;
      };
      assert.equal((await publishDraft({ client, ...draftInputs(draft) })).draft, false);
    });
  });

  describe("the AppImage the Linux job built", () => {
    const name = "Ancilla_0.20.4_amd64.AppImage";

    test("is required for a real release: without its digest nothing vouches for the AppImage", async () => {
      const draft = buildDraft();
      const client = clientFor(draft);
      const problems = (await checkDraft({ client, ...draftInputs(draft, { expectedSha256: {} }) })).problems;
      assert.equal(problems.length, 1, problems.join("\n"));
      assert.match(problems[0], new RegExp(`no sha256 was given for ${name.replace(/\./g, "\\.")}`));
      await assert.rejects(publishDraft({ client, ...draftInputs(draft, { expectedSha256: {} }) }), /no sha256 was given/);
      assert.equal(patches(client).length, 0);
    });

    test("is not required of a rehearsal, which still compares one it is given", async () => {
      const dry = buildDraft({ dryRun: true });
      assert.deepEqual((await checkDraft({ client: clientFor(dry), ...draftInputs(dry, { expectedSha256: {} }) })).problems, []);
      assert.match((await checkDraft({ client: clientFor(dry), ...draftInputs(dry, { expectedSha256: { [name]: "f".repeat(64) } }) })).problems.join("\n"), /the build produced sha256:f{64}/);
    });

    test("a digest for a name that is not in the draft is a problem even beside the right one", async () => {
      const draft = buildDraft();
      const skewed = "Ancilla_0.20.5_amd64.AppImage";
      const problems = (await checkDraft({ client: clientFor(draft), ...draftInputs(draft, { expectedSha256: { ...draft.expectedSha256, [skewed]: "0".repeat(64) } }) })).problems;
      assert.equal(problems.length, 1, problems.join("\n"));
      assert.match(problems[0], /0\.20\.5_amd64\.AppImage.*matches no signed asset/);
    });

    test("with the downloads skipped there is nothing to compare, and nothing to require", async () => {
      const draft = buildDraft();
      assert.deepEqual((await checkDraft({ client: clientFor(draft), ...draftInputs(draft, { expectedSha256: {} }), verifyBytes: false })).problems, []);
    });
  });
});

describe("the release against the previous one", () => {
  const key = generateKey();
  const other = generateKey();
  const pub = publicKeyText(key);
  const trusted = updaterConf({ version: "0.20.3", pubkey: pub });
  const next = (over = {}) => ({ ...updaterConf({ version: "0.20.4", pubkey: pub }), ...over });
  const withUpdater = (conf, change) => {
    const copy = structuredClone(conf);
    change(copy.plugins.updater);
    return copy;
  };
  const problemsOf = (conf, options = {}) => continuityProblems({ conf, trustedConf: trusted, ...options });

  test("a release that changes only its version, upward, carries everything forward", () => {
    assert.deepEqual(problemsOf(next()), []);
  });

  test("the real tauri.conf.json is its own continuation once its version is raised", () => {
    const real = JSON.parse(readFileSync(new URL("../../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    const raised = { ...real, version: "99.0.0" };
    assert.deepEqual(continuityProblems({ conf: raised, trustedConf: real }), []);
    assert.equal(compareSemver(real.version, real.version), 0);
    assert.match(continuityProblems({ conf: real, trustedConf: real }).join("\n"), /not greater/);
  });

  describe("the key", () => {
    test("another key is refused, naming both, and the way to replace one on purpose", () => {
      const problems = problemsOf(next({ plugins: { updater: { ...trusted.plugins.updater, pubkey: publicKeyText(other) } } }));
      assert.equal(problems.length, 1);
      assert.match(problems[0], new RegExp(`${other.keyId}.*${key.keyId}`));
      assert.match(problems[0], /rotate_key/);
    });

    test("the same key under a different comment is the same key", () => {
      const keyLine = Buffer.from(pub, "base64").toString("utf8").split("\n")[1];
      const renamed = Buffer.from(`untrusted comment: another comment\n${keyLine}\n`).toString("base64");
      assert.deepEqual(problemsOf(next({ plugins: { updater: { ...trusted.plugins.updater, pubkey: renamed } } })), []);
    });

    test("a key is its id and its 32 bytes together: either half alone differing is another key", () => {
      const sameIdOtherBytes = { ...key, raw: other.raw };
      const otherIdSameBytes = { ...key, keyIdBytes: other.keyIdBytes, keyId: other.keyId };
      for (const [what, changed] of [
        ["the same id over other bytes", sameIdOtherBytes],
        ["another id over the same bytes", otherIdSameBytes],
      ]) {
        const conf = next({ plugins: { updater: { ...trusted.plugins.updater, pubkey: publicKeyText(changed) } } });
        const problems = problemsOf(conf);
        assert.equal(problems.length, 1, `${what}: ${problems.join("\n")}`);
        assert.match(problems[0], /rotate_key/, what);
        assert.deepEqual(checkContinuity({ conf, trustedConf: trusted, allowKeyRotation: true }), { problems: [], rotating: true }, what);
      }
    });

    test("a rotation is let through only when it is asked for", () => {
      const rotated = next({ plugins: { updater: { ...trusted.plugins.updater, pubkey: publicKeyText(other) } } });
      assert.equal(problemsOf(rotated).length, 1);
      assert.deepEqual(problemsOf(rotated, { allowKeyRotation: true }), []);
      assert.deepEqual(problemsOf(next(), { allowKeyRotation: true }), [], "asking for it when the key did not change is harmless");
    });

    for (const [what, pubkey] of [
      ["missing", undefined],
      ["empty", ""],
      ["not base64", "this is not a key!"],
      ["cut short", pub.slice(0, pub.length - 12)],
      ["a trailing newline", `${pub}\n`],
      ["a leading space", ` ${pub}`],
      ["wrapped", `${pub.slice(0, 50)}\n${pub.slice(50)}`],
      ["the decoded text, not its base64", publicKeyText(key, { encoded: false })],
      ["a key of another algorithm", publicKeyText(key, { algorithm: "ED" })],
      ["a number", 12],
    ]) {
      test(`a pubkey that is ${what} is refused, rotation or not`, () => {
        const conf = next({ plugins: { updater: { ...trusted.plugins.updater, pubkey } } });
        for (const allowKeyRotation of [false, true]) {
          const problems = problemsOf(conf, { allowKeyRotation });
          assert.equal(problems.length, 1, `${allowKeyRotation}: ${problems.join("\n")}`);
          assert.match(problems[0], /plugins\.updater\.pubkey/);
        }
      });
    }

    test("a previous release whose key cannot be read is an error too, since there is nothing to compare with", () => {
      const broken = updaterConf({ version: "0.20.3", pubkey: "nonsense" });
      assert.match(continuityProblems({ conf: next(), trustedConf: broken }).join("\n"), /previous release's plugins\.updater\.pubkey/);
      assert.match(continuityProblems({ conf: next(), trustedConf: broken, allowKeyRotation: true }).join("\n"), /previous release's plugins\.updater\.pubkey/);
    });
  });

  describe("the update endpoints", () => {
    for (const [what, endpoints] of [
      ["another address (a typo)", ["https://example.invalid/typo/latest.json"]],
      ["one more", [...ENDPOINTS, "https://example.invalid/more.json"]],
      ["none", []],
      ["missing", undefined],
      ["not a list", ENDPOINTS[0]],
    ]) {
      test(`${what} is refused, and a rotation does not excuse it`, () => {
        const conf = withUpdater(next(), (updater) => (updater.endpoints = endpoints));
        for (const allowKeyRotation of [false, true]) {
          const problems = problemsOf(conf, { allowKeyRotation });
          assert.equal(problems.length, 1, problems.join("\n"));
          assert.match(problems[0], /plugins\.updater\.endpoints/);
        }
      });
    }

    test("the same addresses in another order are another list: the updater tries them in order", () => {
      const two = ["https://example.invalid/a.json", "https://example.invalid/b.json"];
      const before = withUpdater(trusted, (updater) => (updater.endpoints = two));
      assert.deepEqual(continuityProblems({ conf: withUpdater(next(), (updater) => (updater.endpoints = [...two])), trustedConf: before }), []);
      assert.equal(continuityProblems({ conf: withUpdater(next(), (updater) => (updater.endpoints = [...two].reverse())), trustedConf: before }).length, 1);
    });

    test("a previous release with no endpoints to compare with is an error", () => {
      const bare = withUpdater(trusted, (updater) => delete updater.endpoints);
      assert.match(continuityProblems({ conf: withUpdater(next(), (updater) => delete updater.endpoints), trustedConf: bare }).join("\n"), /previous release's plugins\.updater\.endpoints/);
    });
  });

  describe("the identifier", () => {
    for (const [what, identifier] of [["another", "app.ancilla.OTHER"], ["a different case", IDENTIFIER.toUpperCase()], ["empty", ""], ["missing", undefined]]) {
      test(`${what} is refused, and a rotation does not excuse it`, () => {
        const conf = next({ identifier });
        const problems = problemsOf(conf, { allowKeyRotation: true });
        assert.equal(problems.length, 1, problems.join("\n"));
        assert.match(problems[0], /identifier/);
      });
    }

    test("a previous release with no identifier to compare with is an error", () => {
      const { identifier, ...bare } = trusted;
      assert.ok(identifier);
      assert.match(continuityProblems({ conf: next(), trustedConf: bare }).join("\n"), /previous release's identifier/);
    });
  });

  describe("the version", () => {
    const versionProblems = (version, previous = "0.20.3") => continuityProblems({ conf: updaterConf({ version, pubkey: pub }), trustedConf: updaterConf({ version: previous, pubkey: pub }), allowKeyRotation: true });

    test("must be higher than the previous release's: equal and lower are refused, higher is not", () => {
      assert.match(versionProblems("0.20.3").join("\n"), /version 0\.20\.3 is not greater than the previous release's 0\.20\.3/);
      assert.match(versionProblems("0.19.9").join("\n"), /version 0\.19\.9 is not greater than the previous release's 0\.20\.3/);
      assert.match(versionProblems("0.2.9").join("\n"), /not greater/, "compared as numbers, not as text");
      for (const higher of ["0.20.4", "0.21.0", "1.0.0", "0.100.0", "0.20.10"]) assert.deepEqual(versionProblems(higher), [], higher);
      assert.match(versionProblems("0.20.9", "0.20.10").join("\n"), /not greater/, "9 is lower than 10");
    });

    test("orders prereleases as semver does, and a prerelease is below its release", () => {
      assert.deepEqual(versionProblems("0.21.0-rc1"), [], "a release candidate of the next version is above the last release");
      assert.deepEqual(versionProblems("0.21.0", "0.21.0-rc1"), [], "the release is above its own candidate");
      assert.match(versionProblems("0.21.0-rc1", "0.21.0").join("\n"), /not greater/);
      assert.match(versionProblems("0.20.3-rc1").join("\n"), /not greater/, "a candidate of the version already released is lower than it");
      assert.deepEqual(versionProblems("0.21.0-rc2", "0.21.0-rc1"), []);
      assert.match(versionProblems("0.21.0-rc1", "0.21.0-rc2").join("\n"), /not greater/);
      assert.match(versionProblems("0.21.0-rc1", "0.21.0-rc1").join("\n"), /not greater/);
    });

    test("the precedence list of the semver specification holds, pair by pair", () => {
      const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];
      for (let i = 0; i < ordered.length; i++) {
        for (let j = 0; j < ordered.length; j++) {
          assert.equal(Math.sign(compareSemver(ordered[i], ordered[j])), Math.sign(i - j), `${ordered[i]} against ${ordered[j]}`);
        }
      }
    });

    test("build metadata does not count", () => {
      assert.equal(compareSemver("1.0.0+a", "1.0.0+b"), 0);
      assert.equal(compareSemver("1.0.0-rc.1+x", "1.0.0-rc.1"), 0);
      assert.match(versionProblems("0.20.3+build7").join("\n"), /not greater/);
    });

    test("a version that is not semver is an error, in either config", () => {
      for (const bad of ["0.20", "v0.20.4", "", "0.20.4.1", "01.2.3", "0.20.x", " 0.20.4", undefined, 20]) {
        assert.match(continuityProblems({ conf: { ...next(), version: bad }, trustedConf: trusted }).join("\n"), /version/, String(bad));
      }
      assert.match(continuityProblems({ conf: next(), trustedConf: { ...trusted, version: "garbage" } }).join("\n"), /previous release's version/);
      assert.equal(parseSemver("0.20.4").minor, 20);
      assert.equal(parseSemver("0.20"), null);
      assert.throws(() => compareSemver("0.20", "1.0.0"), /not a semantic version/);
    });
  });

  test("every difference is reported together", () => {
    const conf = next({ identifier: "x.y.z", version: "0.20.3", plugins: { updater: { pubkey: publicKeyText(other), endpoints: ["https://example.invalid/e.json"] } } });
    const problems = problemsOf(conf);
    assert.equal(problems.length, 4, problems.join("\n"));
    assert.equal(problemsOf(conf, { allowKeyRotation: true }).length, 3, "the key is the only thing a rotation excuses");
  });

  test("a configuration that is not an object is an error, not a crash", () => {
    for (const conf of [null, [], "text", 7]) assert.ok(continuityProblems({ conf, trustedConf: trusted }).length >= 1, JSON.stringify(conf));
    for (const trustedConf of [null, [], "text", 7]) assert.ok(continuityProblems({ conf: next(), trustedConf }).length >= 1, JSON.stringify(trustedConf));
  });

  describe("through check and publish, with the shapes the review found", () => {
    const clientFor = (draft) => fakeClient({ releases: [draft.release], files: draft.files });
    const patches = (client) => client.calls.filter((call) => call.op === "patchRelease").length;

    test("a tree whose pubkey, endpoints and identifier all differ from the previous release's is not published", async () => {
      const draft = buildDraft();
      const stranger = generateKey();
      const conf = updaterConf({ version: "0.20.4", pubkey: publicKeyText(stranger), identifier: "app.ancilla.OTHER", endpoints: ["https://example.invalid/typo/latest.json"] });
      const client = clientFor(draft);
      await assert.rejects(publishDraft({ client, ...draftInputs(draft, { conf }) }), (error) => {
        assert.ok(error instanceof ReleaseCheckError);
        assert.equal(error.problems.length, 3, error.problems.join("\n"));
        const text = error.problems.join("\n");
        assert.match(text, /plugins\.updater\.pubkey/);
        assert.match(text, /plugins\.updater\.endpoints/);
        assert.match(text, /identifier/);
        return true;
      });
      assert.equal(patches(client), 0);
      assert.equal(client.releases[0].draft, true);
    });

    test("a draft for v0.19.9 against a previous release at 0.20.3 is not published", async () => {
      const draft = buildDraft({ version: "0.19.9" });
      const client = clientFor(draft);
      await assert.rejects(publishDraft({ client, ...draftInputs(draft) }), /version 0\.19\.9 is not greater than the previous release's 0\.20\.3/);
      assert.equal(patches(client), 0);
    });

    test("the same version again is not published either", async () => {
      const draft = buildDraft();
      const client = clientFor(draft);
      await assert.rejects(publishDraft({ client, ...draftInputs(draft, { trustedConf: updaterConf({ version: "0.20.4", pubkey: draft.trustedKeyText }) }) }), /not greater/);
      assert.equal(patches(client), 0);
    });

    test("check, which a rehearsal runs, holds a draft to the same rules", async () => {
      const dry = buildDraft({ dryRun: true });
      const result = await checkDraft({ client: clientFor(dry), ...draftInputs(dry, { conf: { ...dry.conf, identifier: "app.ancilla.OTHER" } }) });
      assert.match(result.problems.join("\n"), /identifier/);
    });

    describe("replacing the signing key, as docs/RELEASING.md describes it", () => {
      // The rotation release carries the new public key and is signed with the OLD secret key: installed copies
      // check an update against the key they already hold. So the signatures are verified against the previous
      // release's key; the key in the tree being released only has to be a key.
      const newKey = generateKey();
      const rotatedConf = (draft) => ({ ...draft.conf, plugins: { updater: { ...draft.conf.plugins.updater, pubkey: publicKeyText(newKey) } } });

      test("is refused unless asked for", async () => {
        const draft = buildDraft();
        const client = clientFor(draft);
        await assert.rejects(publishDraft({ client, ...draftInputs(draft, { conf: rotatedConf(draft) }) }), /plugins\.updater\.pubkey/);
        assert.equal(patches(client), 0);
      });

      test("is published when asked for, the signatures made with the old key being checked against the old key", async () => {
        const draft = buildDraft();
        const client = clientFor(draft);
        const result = await publishDraft({ client, ...draftInputs(draft, { conf: rotatedConf(draft), allowKeyRotation: true }) });
        assert.equal(result.draft, false);
        assert.equal(patches(client), 1);
      });

      test("still needs a new key that is a key", async () => {
        const draft = buildDraft();
        const client = clientFor(draft);
        const conf = { ...draft.conf, plugins: { updater: { ...draft.conf.plugins.updater, pubkey: `${publicKeyText(newKey)}\n` } } };
        await assert.rejects(publishDraft({ client, ...draftInputs(draft, { conf, allowKeyRotation: true }) }), /plugins\.updater\.pubkey is unusable/);
        assert.equal(patches(client), 0);
      });

      test("does not make signatures by the new key acceptable before installed copies hold it", async () => {
        // Signed with the new key while the previous release still has the old one: no installed copy could verify it.
        const draft = buildDraft({ key: newKey });
        const oldKey = generateKey();
        const client = clientFor(draft);
        const inputs = draftInputs(draft, { trustedKeyText: publicKeyText(oldKey), trustedConf: updaterConf({ version: "0.20.3", pubkey: publicKeyText(oldKey) }), allowKeyRotation: true });
        await assert.rejects(publishDraft({ client, ...inputs }), (error) => {
          assert.match(error.message, new RegExp(`signed with key ${newKey.keyId}, but the trusted public key is ${oldKey.keyId}`));
          return true;
        });
        assert.equal(patches(client), 0);
      });

      test("does not excuse another endpoint, identifier or an older version", async () => {
        const draft = buildDraft();
        const client = clientFor(draft);
        const conf = { ...rotatedConf(draft), identifier: "app.ancilla.OTHER", version: "0.20.3" };
        await assert.rejects(publishDraft({ client, ...draftInputs(draft, { conf, allowKeyRotation: true }) }), (error) => {
          assert.match(error.message, /identifier/);
          assert.match(error.message, /not greater/);
          assert.doesNotMatch(error.message, /plugins\.updater\.pubkey/);
          return true;
        });
      });
    });
  });
});

describe("refusing a published tag and clearing stale drafts", () => {
  const release = (id, tag, draft, extra = {}) => ({ id, tag_name: tag, draft, prerelease: false, assets: [], ...extra });

  test("a tag with a published release is refused and nothing is deleted", async () => {
    const client = fakeClient({ releases: [release(1, "v1.0.0", false), release(2, "v1.0.0", true)] });
    await assert.rejects(prepareTag({ client, tag: "v1.0.0" }), /already has a published release/);
    assert.equal(client.calls.filter((call) => call.op === "deleteRelease").length, 0);
  });

  test("a published release found only in the list, not by tag, still refuses the tag", async () => {
    const client = fakeClient({ releases: [release(1, "v1.0.0", false)] });
    client.getReleaseByTag = async () => null;
    await assert.rejects(prepareTag({ client, tag: "v1.0.0" }), /already has a published release/);
  });

  test("a published release that a lookup by tag finds, but the list does not show, still refuses the tag", async () => {
    const client = fakeClient({ releases: [release(1, "v1.0.0", true)] });
    client.getReleaseByTag = async (tag) => ({ id: 9, tag_name: tag, draft: false, prerelease: false, assets: [] });
    await assert.rejects(prepareTag({ client, tag: "v1.0.0" }), /already has a published release \(id 9\)/);
    assert.equal(client.calls.filter((call) => call.op === "deleteRelease").length, 0, "the draft is left alone too");
  });

  test("every draft for the tag is deleted, and no draft for another tag", async () => {
    const client = fakeClient({ releases: [release(1, "v1.0.1", true), release(2, "v1.0.0", true), release(3, "v1.0.0", true), release(4, "v0.9.0", false), release(5, "v1.0.0-rc1", true)] });
    const result = await prepareTag({ client, tag: "v1.0.0" });
    assert.deepEqual(result.deleted.sort(), [2, 3]);
    assert.deepEqual(client.releases.map((r) => r.id).sort(), [1, 4, 5]);
  });

  test("nothing to clear is fine", async () => {
    const client = fakeClient({ releases: [release(4, "v0.9.0", false)] });
    assert.deepEqual((await prepareTag({ client, tag: "v1.0.0" })).deleted, []);
  });

  test("discarding drafts leaves a published release alone and says so", async () => {
    const client = fakeClient({ releases: [release(1, "dry-run-9", true), release(2, "dry-run-8", true)] });
    assert.deepEqual((await discardDrafts({ client, tag: "dry-run-9" })).deleted, [1]);
    const odd = fakeClient({ releases: [release(1, "dry-run-9", false)] });
    await assert.rejects(discardDrafts({ client: odd, tag: "dry-run-9" }), /published/);
    assert.equal(odd.calls.filter((call) => call.op === "deleteRelease").length, 0);
  });

  test("a client that cannot list releases stops the run rather than guessing", async () => {
    const client = fakeClient({ failOn: { listReleases: true } });
    await assert.rejects(prepareTag({ client, tag: "v1.0.0" }), /injected failure/);
  });
});

describe("replacing the AppImage in a draft", () => {
  const dirs = [];
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "ancilla-replace-"));
    dirs.push(dir);
    return dir;
  };
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function setup() {
    const draft = buildDraft();
    const name = "Ancilla_0.20.4_amd64.AppImage";
    const dir = tmp();
    const repacked = Buffer.from("the repacked AppImage, without the wayland libraries");
    writeFileSync(join(dir, name), repacked);
    writeFileSync(`${join(dir, name)}.sig`, signatureText(draft.key, repacked, { trustedComment: `timestamp:5\tfile:${name}` }));
    // The draft as tauri-action leaves it: untagged URLs everywhere in its latest.json.
    for (const platform of Object.values(draft.manifest.platforms)) {
      platform.url = platform.url.replace("/download/v0.20.4/", "/download/untagged-0a1b2c3d4e5f/");
    }
    setAssetBytes(draft, "latest.json", Buffer.from(JSON.stringify(draft.manifest, null, 2)));
    const client = fakeClient({ releases: [draft.release], files: draft.files });
    return { draft, name, dir, repacked, client, path: join(dir, name) };
  }

  test("the manifest keeps everything but the AppImage signature and any untagged URL", () => {
    const { draft, name } = setup();
    const before = structuredClone(draft.manifest);
    const signature = "the new signature";
    const { manifest, rewrittenUrls } = rewriteManifestForAppImage(before, { repo: REPO, tag: "v0.20.4", assetName: name, signature });
    assert.equal(manifest.platforms["linux-x86_64"].signature, signature);
    assert.equal(manifest.platforms["linux-x86_64-appimage"].signature, signature);
    assert.equal(manifest.platforms["windows-x86_64"].signature, before.platforms["windows-x86_64"].signature);
    assert.equal(manifest.platforms["linux-x86_64"].url, `https://github.com/${REPO}/releases/download/v0.20.4/${name}`);
    assert.equal(rewrittenUrls, 10);
    for (const platform of Object.values(manifest.platforms)) {
      assert.doesNotMatch(platform.url, /untagged-/);
    }
    assert.equal(manifest.version, before.version);
    assert.equal(manifest.notes, before.notes);
    assert.equal(before.platforms["linux-x86_64"].signature !== signature, true, "the input is not modified");
  });

  test("a manifest whose Linux entry is not this AppImage is refused", () => {
    const { draft, name } = setup();
    const manifest = structuredClone(draft.manifest);
    manifest.platforms["linux-x86_64"].url = `https://github.com/${REPO}/releases/download/untagged-0a1b2c3d4e5f/Ancilla_0.20.4_amd64.deb`;
    assert.throws(() => rewriteManifestForAppImage(manifest, { repo: REPO, tag: "v0.20.4", assetName: name, signature: "s" }), /linux-x86_64 does not point at Ancilla_0\.20\.4_amd64\.AppImage/);
    delete manifest.platforms["linux-x86_64-appimage"];
    assert.throws(() => rewriteManifestForAppImage(manifest, { repo: REPO, tag: "v0.20.4", assetName: name, signature: "s" }), /no linux-x86_64-appimage/);
  });

  const noWait = { sleep: async () => {} };
  /** Records the writes a client gets, by the name of the asset each touches. */
  function trace(client) {
    const ops = [];
    const remove = client.deleteAsset;
    client.deleteAsset = async (id) => {
      ops.push(`delete ${client.releases[0].assets.find((candidate) => candidate.id === id)?.name}`);
      return remove(id);
    };
    const upload = client.uploadAsset;
    client.uploadAsset = async (releaseId, assetName, filePath) => {
      ops.push(`upload ${assetName}`);
      return upload(releaseId, assetName, filePath);
    };
    return ops;
  }
  /** Makes uploads of `assetName` fail: the first `times` of them, each leaving a partial asset behind, or all. */
  function failUploads(client, assetName, times = Infinity) {
    const upload = client.uploadAsset;
    let failed = 0;
    client.uploadAsset = async (releaseId, uploadName, filePath) => {
      if (uploadName === assetName && failed < times) {
        failed++;
        client.releases[0].assets.push({ id: 99000 + failed, name: uploadName, size: 3, state: "starter", created_at: "2026-10-20T10:25:00Z", browser_download_url: "" });
        throw new Error("Error saving asset");
      }
      return upload(releaseId, uploadName, filePath);
    };
  }
  const assetNamed = (client, assetName) => client.releases[0].assets.filter((candidate) => candidate.name === assetName);
  const manifestIn = (client) => JSON.parse(client.files.get(assetNamed(client, "latest.json")[0].id).toString("utf8"));

  test("replaces the AppImage, its signature and latest.json by release id, one after the other, latest.json last", async () => {
    const { draft, name, client, path } = setup();
    const ops = trace(client);
    const result = await replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path, ...noWait });
    assert.deepEqual(ops, [`delete ${name}`, `upload ${name}`, `delete ${name}.sig`, `upload ${name}.sig`, "delete latest.json", "upload latest.json"]);
    assert.ok(client.calls.every((call) => call.op !== "getReleaseByTag"), "never looks a draft up by tag");
    const after = await client.getRelease(777);
    const names = after.assets.map((a) => a.name).sort();
    assert.equal(new Set(names).size, names.length, "no name twice");
    assert.equal(names.length, 12);
    assert.equal(result.sha256, sha256(Buffer.from("the repacked AppImage, without the wayland libraries")));
    // What is in the draft now passes the audit, with the new signature in latest.json.
    const loaded = JSON.parse(client.files.get(after.assets.find((a) => a.name === "latest.json").id).toString("utf8"));
    const sigText = client.files.get(after.assets.find((a) => a.name === `${name}.sig`).id).toString("utf8");
    assert.equal(loaded.platforms["linux-x86_64"].signature, sigText.trim());
    const signatures = { ...draft.signatures, [`${name}.sig`]: sigText };
    const problems = auditDraft({ release: { ...after, assets: after.assets.map((a) => ({ ...a, created_at: "2026-10-20T10:30:00Z" })) }, manifest: loaded, signatures, expect: draft.expect, trustedKeyText: draft.trustedKeyText });
    assert.deepEqual(problems, []);
  });

  test("writes nothing if the manifest is not what it expects", async () => {
    const { draft, client, path } = setup();
    delete draft.manifest.platforms["linux-x86_64-appimage"];
    setAssetBytes(draft, "latest.json", Buffer.from(JSON.stringify(draft.manifest)));
    await assert.rejects(replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path }), /no linux-x86_64-appimage/);
    assert.equal(client.calls.filter((call) => ["deleteAsset", "uploadAsset"].includes(call.op)).length, 0);
  });

  test("reads a latest.json that starts with a byte order mark", async () => {
    const { draft, client, path } = setup();
    setAssetBytes(draft, "latest.json", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(draft.manifest))]));
    await replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path, ...noWait });
    assert.equal(manifestIn(client).platforms["linux-x86_64"].url, `https://github.com/${REPO}/releases/download/v0.20.4/Ancilla_0.20.4_amd64.AppImage`);
  });

  test("writes nothing if the new signature file is missing", async () => {
    const { client, path } = setup();
    rmSync(`${path}.sig`);
    await assert.rejects(replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path }), /Cannot read .*\.sig/);
    assert.equal(client.calls.filter((call) => ["deleteAsset", "uploadAsset"].includes(call.op)).length, 0);
  });

  test("writes nothing if the draft has no AppImage to replace", async () => {
    const none = setup();
    none.draft.release.assets = none.draft.release.assets.filter((a) => !a.name.includes("AppImage"));
    await assert.rejects(replaceAppImage({ client: none.client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: none.path }), /no Ancilla_0\.20\.4_amd64\.AppImage to replace/);
    assert.equal(none.client.calls.filter((call) => ["deleteAsset", "uploadAsset"].includes(call.op)).length, 0);
  });

  test("an upload that fails for good leaves a draft that the audit refuses, never a half-published one", async () => {
    const { draft, client, path } = setup();
    client.uploadAsset = async () => {
      throw new Error("upload failed");
    };
    await assert.rejects(replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path, ...noWait }), /upload failed/);
    const problems = auditDraft({ release: client.releases[0], manifest: draft.manifest, signatures: draft.signatures, expect: draft.expect, trustedKeyText: draft.trustedKeyText });
    assert.match(problems.join("\n"), /missing asset Ancilla_0\.20\.4_amd64\.AppImage/);
    assert.equal(client.releases[0].draft, true);
  });

  test("an upload GitHub reports with the wrong size is an error, after the tries", async () => {
    const { client, path } = setup();
    const upload = client.uploadAsset;
    let uploads = 0;
    client.uploadAsset = async (...args) => {
      uploads++;
      await upload(...args);
      const last = client.releases[0].assets.at(-1);
      last.size -= 1;
    };
    await assert.rejects(replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path, ...noWait }), /size/);
    assert.equal(uploads, 3);
  });

  describe("when GitHub refuses an upload, as it sometimes does for a large asset", () => {
    test("an AppImage upload that fails once is tried again, after the partial asset it left is removed", async () => {
      const { draft, name, client, path } = setup();
      failUploads(client, name, 1);
      const ops = trace(client);
      const waits = [];
      const result = await replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path, sleep: async (ms) => waits.push(ms) });
      assert.deepEqual(ops, [`delete ${name}`, `upload ${name}`, `delete ${name}`, `upload ${name}`, `delete ${name}.sig`, `upload ${name}.sig`, "delete latest.json", "upload latest.json"]);
      assert.equal(waits.length, 1);
      assert.ok(waits[0] > 0);
      const assets = client.releases[0].assets;
      assert.equal(new Set(assets.map((asset) => asset.name)).size, assets.length, "no name twice");
      assert.ok(assets.every((asset) => asset.state === "uploaded"), "nothing partial is left");
      assert.equal(result.sha256, sha256(Buffer.from("the repacked AppImage, without the wayland libraries")));
      assert.equal(manifestIn(client).platforms["linux-x86_64"].signature, readFileSync(`${path}.sig`, "utf8").trim());
      const signatures = { ...draft.signatures, [`${name}.sig`]: readFileSync(`${path}.sig`, "utf8") };
      assert.deepEqual(auditDraft({ release: client.releases[0], manifest: manifestIn(client), signatures, expect: draft.expect, trustedKeyText: draft.trustedKeyText }), []);
    });

    test("an AppImage that cannot be uploaded in three tries leaves latest.json as it was, with every platform", async () => {
      const { draft, name, client, path } = setup();
      const before = manifestIn(client);
      failUploads(client, name);
      const ops = trace(client);
      const waits = [];
      await assert.rejects(replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path, sleep: async (ms) => waits.push(ms) }), (error) => {
        assert.match(error.message, /Error saving asset/);
        assert.match(error.message, /latest\.json was not touched/);
        return true;
      });
      assert.equal(ops.filter((op) => op === `upload ${name}`).length, 3);
      assert.equal(waits.length, 2, "it waited between the tries, not after the last");
      assert.ok(!ops.includes("delete latest.json") && !ops.includes("upload latest.json"), ops.join(", "));
      assert.equal(assetNamed(client, "latest.json").length, 1, "latest.json is still in the draft");
      assert.deepEqual(manifestIn(client), before);
      assert.deepEqual(Object.keys(manifestIn(client).platforms).sort(), Object.keys(draft.manifest.platforms).sort());
      assert.equal(assetNamed(client, name).length, 0, "no partial AppImage is left to be mistaken for one");
      assert.equal(client.releases[0].draft, true);
    });

    test("a signature that cannot be uploaded leaves the new AppImage in place and latest.json as it was", async () => {
      const { name, client, path } = setup();
      const before = manifestIn(client);
      failUploads(client, `${name}.sig`);
      const ops = trace(client);
      await assert.rejects(replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path, ...noWait }), /Error saving asset/);
      assert.ok(!ops.includes("delete latest.json"), ops.join(", "));
      assert.deepEqual(manifestIn(client), before);
      assert.equal(assetNamed(client, name).length, 1);
      assert.equal(client.files.get(assetNamed(client, name)[0].id).toString(), "the repacked AppImage, without the wayland libraries");
    });

    test("a latest.json upload that fails once is tried again", async () => {
      const { name, client, path } = setup();
      failUploads(client, "latest.json", 1);
      await replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path, ...noWait });
      assert.equal(assetNamed(client, "latest.json").length, 1);
      assert.equal(assetNamed(client, "latest.json")[0].state, "uploaded");
      assert.equal(manifestIn(client).platforms["linux-x86_64"].url, `https://github.com/${REPO}/releases/download/v0.20.4/${name}`);
    });

    test("a latest.json that cannot be uploaded says the whole workflow has to run again", async () => {
      const { client, path } = setup();
      failUploads(client, "latest.json");
      await assert.rejects(replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path, ...noWait }), (error) => {
        assert.match(error.message, /Error saving asset/);
        assert.match(error.message, /whole workflow/);
        return true;
      });
      assert.equal(assetNamed(client, "latest.json").length, 0);
    });

    test("an AppImage whose digest GitHub reports differently is not accepted, whatever its size", async () => {
      const { client, path } = setup();
      const upload = client.uploadAsset;
      client.uploadAsset = async (...args) => {
        await upload(...args);
        client.releases[0].assets.at(-1).digest = `sha256:${"0".repeat(64)}`;
      };
      await assert.rejects(replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path, ...noWait }), /GitHub reports digest sha256:0{64}, expected sha256:/);
    });

    test("an upload after which the name is attached twice is not accepted", async () => {
      const { name, client, path } = setup();
      const upload = client.uploadAsset;
      client.uploadAsset = async (...args) => {
        await upload(...args);
        client.releases[0].assets.push({ ...client.releases[0].assets.at(-1), id: 98765 });
      };
      await assert.rejects(replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path, ...noWait }), new RegExp(`${name.replace(/\./g, "\\.")} is attached 2 times after the upload`));
    });

    test("an upload that GitHub leaves in a state other than uploaded is not accepted", async () => {
      const { name, client, path } = setup();
      const upload = client.uploadAsset;
      client.uploadAsset = async (...args) => {
        await upload(...args);
        client.releases[0].assets.at(-1).state = "starter";
      };
      await assert.rejects(replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path, ...noWait }), new RegExp(`${name.replace(/\./g, "\\.")}: state is starter after the upload`));
    });

    test("a read that fails after an upload counts as a failed try, not as a pass", async () => {
      const { name, client, path } = setup();
      const read = client.getRelease;
      const upload = client.uploadAsset;
      let uploaded = false;
      let flaked = false;
      client.uploadAsset = async (...args) => {
        uploaded = true;
        return upload(...args);
      };
      client.getRelease = async (id) => {
        if (uploaded && !flaked) {
          flaked = true;
          throw new Error("HTTP 502");
        }
        return read(id);
      };
      await replaceAppImage({ client, releaseId: 777, repo: REPO, tag: "v0.20.4", appImagePath: path, ...noWait });
      assert.ok(flaked, "the read did fail once");
      assert.equal(assetNamed(client, name).length, 1);
      assert.equal(assetNamed(client, name)[0].state, "uploaded");
    });
  });
});

describe("the key installed copies trust", () => {
  const confText = (pubkey) => JSON.stringify({ plugins: { updater: { pubkey } } });

  function fakeGit({ shows = {}, fetchable = [] } = {}) {
    const calls = [];
    return {
      calls,
      async show(tag, path) {
        calls.push(`show ${tag}:${path}`);
        if (shows[tag] === undefined) throw new Error(`fatal: invalid object name '${tag}'`);
        return shows[tag];
      },
      async fetchTag(tag) {
        calls.push(`fetch ${tag}`);
        if (!fetchable.includes(tag)) throw new Error("fatal: couldn't find remote ref");
        shows[tag] = shows[`remote:${tag}`];
      },
    };
  }

  test("is the one in tauri.conf.json at the newest published release tag", async () => {
    const client = fakeClient({ releases: [{ id: 2, tag_name: "v0.20.3", draft: false, prerelease: false, assets: [] }, { id: 1, tag_name: "v0.20.2", draft: false, prerelease: false, assets: [] }] });
    const git = fakeGit({ shows: { "v0.20.3": confText("OLD KEY") } });
    const result = await resolveTrustedConfig({ client, git, path: "apps/desktop/src-tauri/tauri.conf.json" });
    assert.equal(result.tag, "v0.20.3");
    assert.equal(JSON.parse(result.text).plugins.updater.pubkey, "OLD KEY");
    assert.deepEqual(git.calls, ["show v0.20.3:apps/desktop/src-tauri/tauri.conf.json"]);
  });

  test("fetches the tag when the checkout does not have it", async () => {
    const client = fakeClient({ releases: [{ id: 2, tag_name: "v0.20.3", draft: false, prerelease: false, assets: [] }] });
    const git = fakeGit({ shows: { "remote:v0.20.3": confText("K") }, fetchable: ["v0.20.3"] });
    const result = await resolveTrustedConfig({ client, git, path: "tauri.conf.json" });
    assert.equal(result.tag, "v0.20.3");
    assert.deepEqual(git.calls, ["show v0.20.3:tauri.conf.json", "fetch v0.20.3", "show v0.20.3:tauri.conf.json"]);
  });

  test("fails closed when there is no published release, or the file cannot be read, or holds no key", async () => {
    await assert.rejects(resolveTrustedConfig({ client: fakeClient(), git: fakeGit(), path: "x" }), /no published release/);
    const client = fakeClient({ releases: [{ id: 2, tag_name: "v0.20.3", draft: false, prerelease: false, assets: [] }] });
    await assert.rejects(resolveTrustedConfig({ client, git: fakeGit(), path: "x" }), /Cannot read x at v0\.20\.3/);
    await assert.rejects(resolveTrustedConfig({ client, git: fakeGit({ shows: { "v0.20.3": "{}" } }), path: "x" }), /plugins\.updater\.pubkey/);
    await assert.rejects(resolveTrustedConfig({ client, git: fakeGit({ shows: { "v0.20.3": "not json" } }), path: "x" }), /not valid JSON/);
  });

  test("a draft or a prerelease is never the trusted release", async () => {
    const client = fakeClient({
      releases: [
        { id: 3, tag_name: "dry-run-1", draft: true, prerelease: true, assets: [] },
        { id: 2, tag_name: "v0.21.0-rc1", draft: false, prerelease: true, assets: [] },
        { id: 1, tag_name: "v0.20.3", draft: false, prerelease: false, assets: [] },
      ],
    });
    const git = fakeGit({ shows: { "v0.20.3": confText("K") } });
    assert.equal((await resolveTrustedConfig({ client, git, path: "x" })).tag, "v0.20.3");
  });
});
