// What the release workflow asks of a GitHub release before it is published, and the few operations on a draft it
// needs, all behind an injected client so every rule is tested without GitHub (scripts/check-release-draft.mjs is
// the command line; docs/RELEASING.md is the story).
//
// The shape of the client, which `ghClient` implements over the gh CLI and the tests implement in memory:
//   getRelease(id)  listReleases()  getReleaseByTag(tag) -> release | null  getLatestPublishedTag() -> tag | null
//   downloadAsset(id) -> Buffer  deleteRelease(id)  deleteAsset(id)  uploadAsset(releaseId, name, filePath)
//   patchRelease(id, fields) -> the release as GitHub answers the PATCH, or undefined when the answer holds none
// Everything addresses a release by its id: a draft cannot be looked up by its tag.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { SignatureError, messageFor, parsePublicKey, parseSignature, publicKeyFromConfig, verifyParsed } from "./minisign.mjs";

/** Updater platforms every release lists, and the two the Linux packages add that no installed copy reads. */
export const REQUIRED_PLATFORMS = Object.freeze([
  "windows-x86_64",
  "windows-x86_64-nsis",
  "darwin-aarch64",
  "darwin-x86_64",
  "darwin-aarch64-app",
  "darwin-x86_64-app",
  "linux-x86_64",
  "linux-x86_64-appimage",
]);
export const OPTIONAL_PLATFORMS = Object.freeze(["linux-x86_64-deb", "linux-x86_64-rpm"]);

/** Which installer each platform's update points at. */
const PLATFORM_KIND = {
  "windows-x86_64": "exe",
  "windows-x86_64-nsis": "exe",
  "darwin-aarch64": "app",
  "darwin-x86_64": "app",
  "darwin-aarch64-app": "app",
  "darwin-x86_64-app": "app",
  "linux-x86_64": "appimage",
  "linux-x86_64-appimage": "appimage",
  "linux-x86_64-deb": "deb",
  "linux-x86_64-rpm": "rpm",
};

const KINDS = {
  exe: ({ productName, version }) => `${productName}_${version}_x64-setup.exe`,
  dmg: ({ productName, version }) => `${productName}_${version}_universal.dmg`,
  app: ({ productName }) => `${productName}_universal.app.tar.gz`,
  appimage: ({ productName, version }) => `${productName}_${version}_amd64.AppImage`,
  deb: ({ productName, version }) => `${productName}_${version}_amd64.deb`,
  rpm: ({ productName, version }) => `${productName}-${version}-1.x86_64.rpm`,
};
const UNSIGNED = new Set(["dmg"]);

/** The asset a platform's update points at. */
export function assetForPlatform(platform, { productName, version }) {
  return KINDS[PLATFORM_KIND[platform]]({ productName, version });
}

/**
 * Every asset a release carries: each installer, a `.sig` for each that the updater (or the packages) verify, and
 * `latest.json`. Names are the ones the Tauri bundler and tauri-action give them.
 * @returns {{ name: string }[]}
 */
export function expectedAssets({ productName, version, linuxPackages = true }) {
  const kinds = ["exe", "dmg", "app", "appimage", ...(linuxPackages ? ["deb", "rpm"] : [])];
  const assets = [];
  for (const kind of kinds) {
    const name = KINDS[kind]({ productName, version });
    assets.push({ name });
    if (!UNSIGNED.has(kind)) assets.push({ name: `${name}.sig` });
  }
  assets.push({ name: "latest.json" });
  return assets;
}

/** The semantic version in `text` (semver.org 2.0.0, no leading `v`), or null when it is not one. */
export function parseSemver(text) {
  const match = typeof text === "string" ? SEMVER.exec(text) : null;
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] === undefined ? [] : match[4].split(".") };
}
const NUMERIC = "(?:0|[1-9]\\d*)";
const IDENTIFIER_PART = `(?:${NUMERIC}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(`^(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})(?:-(${IDENTIFIER_PART}(?:\\.${IDENTIFIER_PART})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

/** -1, 0 or 1 as `a` is lower than, equal to or higher than `b` by semver precedence: a prerelease is below its release, build metadata does not count. */
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (const [text, parsed] of [[a, left], [b, right]]) {
    if (!parsed) throw new Error(`${JSON.stringify(text)} is not a semantic version`);
  }
  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  const [x, y] = [left.prerelease, right.prerelease];
  if (x.length === 0 || y.length === 0) return x.length === y.length ? 0 : x.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const [numberX, numberY] = [/^\d+$/.test(x[i]), /^\d+$/.test(y[i])];
    if (numberX && numberY) return Number(x[i]) < Number(y[i]) ? -1 : 1;
    if (numberX !== numberY) return numberX ? -1 : 1;
    return x[i] < y[i] ? -1 : 1;
  }
  return Math.sign(x.length - y.length);
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const show = (value) => JSON.stringify(value) ?? "missing";

function readUpdaterKey(text) {
  if (typeof text !== "string") return { error: "is missing or is not a string" };
  try {
    return { key: parsePublicKey(text, { canonical: true }) };
  } catch (error) {
    if (!(error instanceof SignatureError)) throw error;
    return { error: `is unusable: ${error.message}` };
  }
}

/**
 * What every installed copy carries forward from the release it updated to, compared with the release about to be
 * published, as parsed tauri.conf.json files: the key it will trust, the addresses it will look for the next update
 * at, the identity it installs under, and a version that goes up. A mistake in any of these is not an update error
 * that heals with the next release: the copies that took it can never update again, and each user has to reinstall.
 *
 * A key may change only when `allowKeyRotation` is given, for a deliberate replacement (docs/RELEASING.md); the new
 * key must still be one. The rotation release is signed with the key installed copies already hold, so this says
 * nothing about signatures: those are checked against the previous release's key.
 * @returns {{ problems: string[], rotating: boolean }} `rotating` is true when the key differs and that was allowed
 */
export function checkContinuity({ conf, trustedConf, allowKeyRotation = false }) {
  const problems = [];
  if (!isObject(conf)) problems.push("the configuration being released (tauri.conf.json) is not a JSON object");
  if (!isObject(trustedConf)) problems.push("the previous release's configuration (tauri.conf.json) is not a JSON object");
  if (problems.length > 0) return { problems, rotating: false };

  let rotating = false;
  const now = readUpdaterKey(conf.plugins?.updater?.pubkey);
  const before = readUpdaterKey(trustedConf.plugins?.updater?.pubkey);
  if (before.error) problems.push(`the previous release's plugins.updater.pubkey ${before.error}, so there is no key to compare the new one with`);
  if (now.error) problems.push(`plugins.updater.pubkey ${now.error}`);
  if (now.key && before.key && !(now.key.keyIdBytes.equals(before.key.keyIdBytes) && now.key.publicKey.equals(before.key.publicKey))) {
    if (allowKeyRotation) {
      rotating = true;
    } else {
      problems.push(
        `plugins.updater.pubkey is key ${now.key.keyId}, but the previous release's is key ${before.key.keyId}. Every installed copy that updates to this release would carry the new key and refuse any update not signed with it. To replace the key on purpose, run the workflow by hand with rotate_key (docs/RELEASING.md, Replacing the signing key)`,
      );
    }
  }

  const endpoints = conf.plugins?.updater?.endpoints;
  const endpointsBefore = trustedConf.plugins?.updater?.endpoints;
  if (!Array.isArray(endpointsBefore)) {
    problems.push("the previous release's plugins.updater.endpoints is missing, so there is nothing to compare the new addresses with");
  } else if (!Array.isArray(endpoints) || endpoints.length !== endpointsBefore.length || endpoints.some((endpoint, index) => endpoint !== endpointsBefore[index])) {
    problems.push(`plugins.updater.endpoints is ${show(endpoints)}, not the previous release's ${show(endpointsBefore)}: installed copies that take this release would look for the next update there`);
  }

  const identifierBefore = trustedConf.identifier;
  if (typeof identifierBefore !== "string" || identifierBefore === "") {
    problems.push("the previous release's identifier is missing, so there is nothing to compare the new one with");
  } else if (conf.identifier !== identifierBefore) {
    problems.push(`identifier is ${show(conf.identifier)}, not the previous release's ${show(identifierBefore)}: it would install as another application and never replace the one that is installed`);
  }

  const version = parseSemver(conf.version);
  const versionBefore = parseSemver(trustedConf.version);
  if (!version) problems.push(`version ${show(conf.version)} is not a semantic version (major.minor.patch)`);
  if (!versionBefore) problems.push(`the previous release's version ${show(trustedConf.version)} is not a semantic version, so there is nothing to compare the new one with`);
  if (version && versionBefore && compareSemver(conf.version, trustedConf.version) <= 0) {
    problems.push(`version ${conf.version} is not greater than the previous release's ${trustedConf.version}: installed copies only update upwards, and the feed would point backwards`);
  }
  return { problems, rotating };
}

/** The problems of checkContinuity, for the callers that need nothing else. */
export const continuityProblems = (options) => checkContinuity(options).problems;

/** Everything wrong with a draft, listed together; thrown by the operations that must not go on. */
export class ReleaseCheckError extends Error {
  constructor(problems) {
    super(`${problems.length} problem${problems.length === 1 ? "" : "s"} with the release:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ReleaseCheckError";
    this.problems = problems;
  }
}

/** A command used wrongly, as opposed to a release that is wrong. */
export class UsageError extends Error {}

const downloadUrl = (repo, tag, name) => `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}`;
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The rules, as a list of problems; an empty list means the draft may be published. Nothing is read here: the
 * release object, the parsed `latest.json` and the text of every `.sig` asset are handed in.
 */
export function auditDraft({ release, manifest, signatures = {}, expect, trustedKeyText }) {
  const problems = [];
  const { repo, tag, version, productName = "Ancilla", dryRun = false, startedAt, skewMs = 120_000, linuxPackages = true } = expect;

  let trusted = null;
  if (trustedKeyText !== undefined) {
    try {
      trusted = parsePublicKey(trustedKeyText, { canonical: true });
    } catch (error) {
      if (!(error instanceof SignatureError)) throw error;
      problems.push(`the trusted public key is unusable: ${error.message}`);
    }
  }

  // The release itself.
  if (release.draft !== true) problems.push("the release is not a draft (it is already published)");
  if (release.tag_name !== tag) problems.push(`the release is tagged ${release.tag_name}, expected ${tag}`);
  if (dryRun) {
    if (!/^dry-run-\d+$/.test(tag)) problems.push(`the dry-run tag ${tag} is not dry-run-<run id>`);
    if (release.prerelease !== true) problems.push("a dry-run draft must be a prerelease, so that it could never become the latest release");
  } else {
    if (tag !== `v${version}`) problems.push(`the tag ${tag} is not v${version}`);
    if (release.prerelease !== false) problems.push("the release is marked prerelease, so the updater would never see it");
  }

  // Its assets.
  const wanted = expectedAssets({ productName, version, linuxPackages });
  const counts = new Map();
  for (const asset of release.assets ?? []) counts.set(asset.name, (counts.get(asset.name) ?? 0) + 1);
  for (const { name } of wanted) {
    if (!counts.has(name)) problems.push(`missing asset ${name}`);
  }
  const wantedNames = new Set(wanted.map(({ name }) => name));
  for (const [name, count] of counts) {
    if (!wantedNames.has(name)) problems.push(`unexpected asset ${name}`);
    if (count > 1) problems.push(`${name} is attached ${count} times`);
  }
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) problems.push(`the run start time ${JSON.stringify(startedAt)} is not a date`);
  for (const asset of release.assets ?? []) {
    if (asset.state !== "uploaded") problems.push(`${asset.name}: state is ${asset.state}, not uploaded`);
    if (!(asset.size > 0)) problems.push(`${asset.name}: is empty (${asset.size} bytes)`);
    if (!Number.isNaN(started)) {
      const uploaded = Date.parse(asset.created_at);
      if (Number.isNaN(uploaded)) problems.push(`${asset.name}: has no upload time`);
      else if (uploaded < started - skewMs) problems.push(`${asset.name}: uploaded ${asset.created_at}, before the run started (${startedAt}); a leftover of an earlier attempt`);
    }
  }

  // The signatures, as text, against the key installed copies trust.
  for (const [name, text] of Object.entries(signatures)) {
    try {
      const parsed = parseSignature(text);
      if (trusted && !parsed.keyIdBytes.equals(trusted.keyIdBytes)) {
        problems.push(`${name}: signed with key ${parsed.keyId}, but the trusted public key is ${trusted.keyId}`);
      }
    } catch (error) {
      if (!(error instanceof SignatureError)) throw error;
      problems.push(`${name}: ${error.message}`);
    }
  }

  // latest.json, the one file installed copies read.
  if (manifest === null || manifest === undefined) {
    problems.push("latest.json is missing or unreadable");
    return problems;
  }
  if (typeof manifest !== "object" || Array.isArray(manifest)) {
    problems.push("latest.json is not an object");
    return problems;
  }
  if (manifest.version !== version) problems.push(`latest.json says version ${manifest.version}, expected ${version}`);
  if (typeof manifest.notes !== "string" || manifest.notes.trim() === "") {
    problems.push("latest.json notes are missing");
  } else if (!manifest.notes.includes(`New in ${version}`)) {
    problems.push(`latest.json notes do not contain "New in ${version}": the release notes are for another version`);
  }
  const platforms = manifest.platforms;
  if (typeof platforms !== "object" || platforms === null || Object.keys(platforms).length === 0) {
    problems.push("latest.json has no platforms");
    return problems;
  }
  for (const key of REQUIRED_PLATFORMS) {
    if (!(key in platforms)) problems.push(`missing platform ${key}`);
  }
  for (const key of Object.keys(platforms)) {
    if (!(key in PLATFORM_KIND)) problems.push(`unexpected platform ${key}`);
  }
  for (const [key, entry] of Object.entries(platforms)) {
    if (!(key in PLATFORM_KIND)) continue;
    const assetName = assetForPlatform(key, { productName, version });
    const want = downloadUrl(repo, tag, assetName);
    const url = entry?.url;
    if (url !== want) {
      const untagged = typeof url === "string" && /\/download\/untagged-/.test(url);
      problems.push(`${key}: url is ${JSON.stringify(url)}${untagged ? ", an untagged URL that stops working once the release is published;" : ","} expected ${want}`);
    }
    const signature = entry?.signature;
    if (typeof signature !== "string" || signature.trim() === "") {
      problems.push(`${key}: no signature`);
      continue;
    }
    // The updater reads this string as it stands, so it is held to that; the .sig asset is a file, read as files are.
    try {
      parseSignature(signature, { canonical: true });
    } catch (error) {
      if (!(error instanceof SignatureError)) throw error;
      problems.push(`${key}: latest.json's signature is unusable as the updater reads it: ${error.message}`);
      continue;
    }
    if (!(`${assetName}.sig` in signatures)) {
      problems.push(`${key}: no ${assetName}.sig asset to compare the signature with`);
    } else if (signature !== signatures[`${assetName}.sig`].trim()) {
      problems.push(`${key}: signature differs from ${assetName}.sig`);
    }
  }
  return problems;
}

/** Reads a draft's `latest.json` and the text of its `.sig` assets. */
export async function loadDraft(client, releaseId) {
  const release = await client.getRelease(releaseId);
  const problems = [];
  let manifest = null;
  const latest = release.assets.find((asset) => asset.name === "latest.json");
  if (latest) {
    try {
      manifest = JSON.parse((await client.downloadAsset(latest.id)).toString("utf8").replace(/^\u{FEFF}/u, ""));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      problems.push(`latest.json is not valid JSON: ${error.message}`);
    }
  }
  const signatures = {};
  for (const asset of release.assets.filter((candidate) => candidate.name.endsWith(".sig"))) {
    signatures[asset.name] = (await client.downloadAsset(asset.id)).toString("utf8");
  }
  return { release, manifest, signatures, problems };
}

/**
 * Downloads every artifact that has a signature and verifies the signature against its bytes and the trusted key,
 * which is what an installed copy will do. A digest GitHub reports, and the digest of the AppImage the Linux job
 * built, must also be that of the bytes.
 */
export async function auditArtifactBytes({ client, release, signatures, trustedKeyText, expectedSha256 = {} }) {
  let trusted;
  try {
    trusted = parsePublicKey(trustedKeyText, { canonical: true });
  } catch (error) {
    if (!(error instanceof SignatureError)) throw error;
    return [`the trusted public key is unusable: ${error.message}`];
  }
  const problems = [];
  const compared = new Set();
  for (const asset of release.assets) {
    const sigText = signatures[`${asset.name}.sig`];
    if (sigText === undefined) continue;
    const bytes = await client.downloadAsset(asset.id);
    const digest = sha256Hex(bytes);
    if (asset.digest && asset.digest !== `sha256:${digest}`) {
      problems.push(`${asset.name}: GitHub reports digest ${asset.digest}, the bytes hash to sha256:${digest}`);
    }
    if (expectedSha256[asset.name] !== undefined) {
      compared.add(asset.name);
      if (expectedSha256[asset.name] !== digest) {
        problems.push(`${asset.name}: the build produced sha256:${expectedSha256[asset.name]}, the draft holds sha256:${digest}`);
      }
    }
    try {
      const parsed = parseSignature(sigText);
      if (!parsed.keyIdBytes.equals(trusted.keyIdBytes)) {
        problems.push(`${asset.name}: signed with key ${parsed.keyId}, but the trusted public key is ${trusted.keyId}`);
        continue;
      }
      verifyParsed(trusted, parsed, messageFor(parsed, bytes));
    } catch (error) {
      if (!(error instanceof SignatureError)) throw error;
      problems.push(`${asset.name}: ${error.message}`);
    }
  }
  // A digest that matched nothing is not a pass: it is the build-side check of the AppImage, and a version or name
  // skew between the Linux job's output and the tree would make it vanish while everything else still passed.
  for (const name of Object.keys(expectedSha256)) {
    if (!compared.has(name)) {
      problems.push(`${name}: a digest from the build was given for it, but it matches no signed asset in the draft, so nothing was compared (a version or name skew between the Linux job and the tree?)`);
    }
  }
  return problems;
}

/**
 * Loads a draft and runs every check on it: the configuration against the previous release's, the assets, latest.json,
 * and, unless `verifyBytes` is false, every signature against the bytes. `conf` and `trustedConf` are the parsed
 * tauri.conf.json of the tree being released and of the newest published release.
 */
export async function checkDraft({ client, releaseId, expect, trustedKeyText, conf, trustedConf, allowKeyRotation = false, verifyBytes = true, expectedSha256 = {} }) {
  if (!trustedKeyText) {
    throw new ReleaseCheckError(["no trusted public key was given, so no signature can be checked"]);
  }
  if (conf === undefined || conf === null || trustedConf === undefined || trustedConf === null) {
    throw new ReleaseCheckError(["no configuration to compare with the previous release's was given, so its key, endpoints, identifier and version cannot be checked"]);
  }
  const continuity = checkContinuity({ conf, trustedConf, allowKeyRotation });
  const loaded = await loadDraft(client, releaseId);
  const problems = [...continuity.problems, ...loaded.problems, ...auditDraft({ release: loaded.release, manifest: loaded.manifest, signatures: loaded.signatures, expect, trustedKeyText })];
  if (verifyBytes) {
    if (!expect.dryRun) {
      const appImage = assetForPlatform("linux-x86_64-appimage", { productName: expect.productName ?? "Ancilla", version: expect.version });
      if (expectedSha256[appImage] === undefined) {
        problems.push(`no sha256 was given for ${appImage}, the AppImage the Linux job signed: without it nothing vouches that the draft holds that file`);
      }
    }
    problems.push(...(await auditArtifactBytes({ client, release: loaded.release, signatures: loaded.signatures, trustedKeyText, expectedSha256 })));
  }
  return { release: loaded.release, problems, rotating: continuity.rotating };
}

/** The assets of a release by name, each as the fields that say whether it is still the file that was checked. */
function assetSnapshot(release) {
  return new Map((release.assets ?? []).map((asset) => [asset.name, { id: asset.id, size: asset.size, state: asset.state, updated_at: asset.updated_at ?? null, digest: asset.digest ?? null }]));
}

/** What differs between the release as it was checked and as it is now: the draft flag, the tag, and every asset. */
function changesSince(checked, fresh) {
  const changes = [];
  if (fresh.draft !== true) changes.push("it is no longer a draft");
  if (fresh.tag_name !== checked.tag_name) changes.push(`its tag is now ${fresh.tag_name}, it was ${checked.tag_name}`);
  const [was, now] = [assetSnapshot(checked), assetSnapshot(fresh)];
  for (const [name, before] of was) {
    const after = now.get(name);
    if (!after) {
      changes.push(`${name} was removed`);
    } else if (after.id !== before.id) {
      changes.push(`${name} was replaced by another upload (id ${before.id}, now ${after.id})`);
    } else {
      const fields = ["size", "state", "updated_at", "digest"].filter((field) => before[field] !== after[field]);
      if (fields.length > 0) changes.push(`${name} changed: ${fields.map((field) => `${field} was ${before[field]}, now ${after[field]}`).join(", ")}`);
    }
  }
  for (const name of now.keys()) {
    if (!was.has(name)) changes.push(`${name} was added`);
  }
  return changes;
}

/** A PATCH answer that is a release to read: GitHub returns the release as it now is, but an answer may be empty or not JSON. */
const holdsRelease = (answer) => isObject(answer) && typeof answer.draft === "boolean" && typeof answer.tag_name === "string";

/**
 * Publishes a draft: every check, then one PATCH of draft=false and nothing else. No problem found means no PATCH is
 * ever sent. The release is read again just before, and publishing stops if it is not the very release that was
 * checked, asset by asset. The PATCH's own answer says whether it took; a read afterwards (which a stale cache could
 * answer with the old state, after the release is public) is only for an answer that holds no release.
 */
export async function publishDraft(options) {
  const { client, releaseId } = options;
  const { release, problems } = await checkDraft(options);
  if (problems.length > 0) throw new ReleaseCheckError(problems);
  // The checks took minutes: make sure nobody published, renamed, replaced or touched anything meanwhile.
  const fresh = await client.getRelease(releaseId);
  const changes = changesSince(release, fresh);
  if (changes.length > 0) {
    throw new ReleaseCheckError([`the release changed while it was being checked: ${changes.join("; ")}`]);
  }
  const answer = await client.patchRelease(releaseId, { draft: false });
  const after = holdsRelease(answer) ? answer : await client.getRelease(releaseId);
  if (after.draft !== false) {
    throw new ReleaseCheckError(["the release is still a draft after the PATCH"]);
  }
  if (after.tag_name !== release.tag_name) {
    throw new ReleaseCheckError([`the release has tag ${after.tag_name} after the PATCH, expected ${release.tag_name}`]);
  }
  if (after.prerelease === true) {
    throw new ReleaseCheckError(["the release was published as a prerelease"]);
  }
  return after;
}

/** Deletes every draft for `tag`; a published release with that tag is an error and nothing is deleted. */
export async function discardDrafts({ client, tag, log = () => {} }) {
  const releases = await client.listReleases();
  const published = releases.find((release) => release.tag_name === tag && !release.draft);
  if (published) {
    throw new Error(`Tag ${tag} has a published release (id ${published.id}); not deleting anything`);
  }
  const deleted = [];
  for (const release of releases.filter((candidate) => candidate.tag_name === tag && candidate.draft)) {
    await client.deleteRelease(release.id);
    log(`Deleted the draft ${release.id} for ${tag}`);
    deleted.push(release.id);
  }
  return { deleted };
}

/**
 * Before a build: a tag that already has a published release is never built again (tauri-action would find it by
 * tag and replace its assets), and any draft left by an earlier attempt goes, since its assets and latest.json
 * entries would be merged into this release.
 */
export async function prepareTag({ client, tag, log = () => {} }) {
  const published = await client.getReleaseByTag(tag);
  if (published) {
    throw new Error(`Tag ${tag} already has a published release (id ${published.id}). A published tag is never built again: installed copies may have updated to it. Release the next version instead.`);
  }
  const releases = await client.listReleases();
  const listed = releases.find((release) => release.tag_name === tag && !release.draft);
  if (listed) {
    throw new Error(`Tag ${tag} already has a published release (id ${listed.id}). A published tag is never built again: installed copies may have updated to it. Release the next version instead.`);
  }
  return discardDrafts({ client, tag, log });
}

/**
 * latest.json with the Linux AppImage's new signature, and every download URL pointing at the tag rather than the
 * draft's temporary `untagged-...` address. The input is not modified.
 */
export function rewriteManifestForAppImage(manifest, { repo, tag, assetName, signature }) {
  const next = structuredClone(manifest);
  const keys = ["linux-x86_64", "linux-x86_64-appimage"];
  for (const key of keys) {
    if (!next.platforms?.[key]) throw new Error(`latest.json has no ${key} entry to put the AppImage's signature in`);
  }
  for (const key of keys) {
    const url = String(next.platforms[key].url ?? "");
    if (url.split("/").pop() !== assetName) throw new Error(`latest.json's ${key} does not point at ${assetName}: ${url}`);
    next.platforms[key].signature = signature;
  }
  let rewrittenUrls = 0;
  for (const entry of Object.values(next.platforms)) {
    if (typeof entry?.url !== "string") continue;
    const fixed = entry.url.replace(/\/download\/untagged-[^/]+\//, `/download/${encodeURIComponent(tag)}/`);
    if (fixed !== entry.url) rewrittenUrls++;
    entry.url = fixed;
  }
  // The AppImage entries are the ones this call is for; give them the canonical URL whatever they held.
  for (const key of keys) next.platforms[key].url = downloadUrl(repo, tag, assetName);
  return { manifest: next, rewrittenUrls };
}

function sha256OfFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

function readLocal(path, readFile) {
  try {
    return readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error.code ?? error.message}`);
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long the upload of one asset waits between its tries; there is one fewer wait than tries. */
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_WAITS_MS = [5_000, 15_000];

/**
 * Puts one file in the draft under `name`, in place of whatever the draft holds under that name, and checks what
 * GitHub then reports. GitHub sometimes refuses a large asset ("Error saving asset"), as tauri-action's retries are
 * there for, so a refusal, or an upload that did not come out whole, is tried again after the partial asset it left
 * is removed: an asset with a name cannot be uploaded over.
 */
async function putAsset({ client, releaseId, name, filePath, size, digest, sleep, log }) {
  const removeNamed = async () => {
    for (const stale of (await client.getRelease(releaseId)).assets.filter((asset) => asset.name === name)) await client.deleteAsset(stale.id);
  };
  let failure;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      await removeNamed();
      await client.uploadAsset(releaseId, name, filePath);
      const found = (await client.getRelease(releaseId)).assets.filter((asset) => asset.name === name);
      if (found.length !== 1) throw new Error(`${name} is attached ${found.length} times after the upload, expected once`);
      if (found[0].state !== "uploaded") throw new Error(`${name}: state is ${found[0].state} after the upload`);
      if (found[0].size !== size) throw new Error(`${name}: GitHub holds ${found[0].size} bytes, expected ${size} (size mismatch)`);
      if (digest && found[0].digest && found[0].digest !== `sha256:${digest}`) throw new Error(`${name}: GitHub reports digest ${found[0].digest}, expected sha256:${digest}`);
      return;
    } catch (error) {
      failure = error;
      log(`Upload of ${name} failed (try ${attempt} of ${UPLOAD_ATTEMPTS}): ${error.message}`);
      if (attempt < UPLOAD_ATTEMPTS) await sleep(UPLOAD_WAITS_MS[attempt - 1]);
    }
  }
  // Out of tries: leave no half-uploaded asset under the name, for the audit or a person to take for the real one.
  try {
    await removeNamed();
  } catch {
    // The failure to report is the upload's. A leftover is caught by the checks before anything is published.
  }
  throw failure;
}

/**
 * Puts the repacked, freshly signed AppImage in the private draft, replacing the one the bundler built, and points
 * latest.json at its signature. Everything is checked before the first write. The AppImage and its signature go in
 * first, each tried up to three times; latest.json is the last thing touched, so that a refused upload leaves the
 * draft with the latest.json it had, listing every platform, and the Linux job can simply be run again. Only
 * latest.json's own upload can leave it without one, which is why it is the last and the shortest.
 */
export async function replaceAppImage({ client, releaseId, repo, tag, appImagePath, readFile = readFileSync, sleep = realSleep, log = () => {} }) {
  const name = basename(appImagePath);
  const sigName = `${name}.sig`;
  const signature = readLocal(`${appImagePath}.sig`, readFile).trim();
  const size = statSync(appImagePath).size;
  const digest = await sha256OfFile(appImagePath);

  const release = await client.getRelease(releaseId);
  const byName = (wanted) => release.assets.filter((asset) => asset.name === wanted);
  if (byName(name).length === 0) throw new Error(`The draft has no ${name} to replace`);
  const latest = byName("latest.json")[0];
  if (!latest) throw new Error("The draft has no latest.json");
  const manifest = JSON.parse((await client.downloadAsset(latest.id)).toString("utf8").replace(/^\u{FEFF}/u, ""));
  const { manifest: next, rewrittenUrls } = rewriteManifestForAppImage(manifest, { repo, tag, assetName: name, signature });

  const scratch = mkdtempSync(join(tmpdir(), "ancilla-latest-"));
  try {
    const latestPath = join(scratch, "latest.json");
    writeFileSync(latestPath, JSON.stringify(next, null, 2));
    const writes = [
      { name, filePath: appImagePath, size, digest, then: `latest.json was not touched, and still lists every platform. Run the failed Linux job again: it puts the AppImage back.` },
      { name: sigName, filePath: `${appImagePath}.sig`, size: statSync(`${appImagePath}.sig`).size, then: `The new ${name} is in the draft, but latest.json was not touched and still holds the old signature. Run the failed Linux job again.` },
      { name: "latest.json", filePath: latestPath, size: statSync(latestPath).size, then: "The draft has no latest.json now, and a Linux job run alone would write one that lists Linux only. Run the whole workflow again: its first job deletes this draft and starts a new one." },
    ];
    for (const write of writes) {
      try {
        await putAsset({ client, releaseId, ...write, sleep, log });
      } catch (error) {
        throw new Error(`${error.message}. ${write.then}`, { cause: error });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { sha256: digest, size, rewrittenUrls };
}

/**
 * The configuration installed copies trust: tauri.conf.json as it was at the newest published release's tag. A key
 * rotation release carries the new key but is signed with the old one, so the key in the tree being built is the
 * wrong thing to check against. Fails closed: no tag, no file or no key is an error.
 */
export async function resolveTrustedConfig({ client, git, path }) {
  const tag = await client.getLatestPublishedTag();
  if (!tag) throw new Error("There is no published release to take the trusted updater key from");
  let text;
  try {
    text = await git.show(tag, path);
  } catch {
    try {
      await git.fetchTag(tag);
      text = await git.show(tag, path);
    } catch (error) {
      throw new Error(`Cannot read ${path} at ${tag}: ${error.message}`);
    }
  }
  const publicKey = publicKeyFromConfig(text, `${path} at ${tag}`);
  return { tag, text, publicKey };
}

/** Looks at the public latest.json after publishing. It only reports: a CDN that is slow must never undo a release. */
export async function pollLatest({ repo, tag, fetchImpl = globalThis.fetch, log = () => {}, attempts = 12, delayMs = 10_000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const url = `https://github.com/${repo}/releases/latest/download/latest.json`;
  const want = tag.replace(/^v/, "");
  let seen = "nothing";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, { redirect: "follow" });
      if (!response.ok) {
        seen = `HTTP ${response.status}`;
      } else {
        const body = await response.json();
        seen = `version ${body?.version}`;
        if (body?.version === want) {
          log(`The public latest.json names ${want}.`);
          return { ok: true, seen };
        }
      }
    } catch (error) {
      seen = String(error?.message ?? error);
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  log(`::warning title=Published release not visible yet::${url} did not name ${want} after ${attempts} tries (last saw ${seen}). The release is published; look at it by hand (docs/RELEASING.md).`);
  return { ok: false, seen };
}

/** Runs gh with the given arguments and returns its standard output; on failure the error carries `stderr`. */
export function ghExec(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 1 << 30, encoding: "buffer", windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

const isNotFound = (error) => /HTTP 404/.test(`${error?.stderr ?? ""}`);

// A failure that is the network's or GitHub's, and may be gone a moment later: a server error, a rate limit (GitHub
// answers a secondary one with 403, so the words count, not the status), a connection that dropped, was reset by an
// HTTP/2 stream error or GOAWAY, was cut off mid-body (a bare EOF ends the line), or never opened (gh prints "error
// connecting to" and a pointer to the status page for a DNS failure, not the failure itself). Anything else (a
// missing release, no permission, a bad request, no gh) is the answer, and asking again would only hide it.
const TRANSIENT = /HTTP (?:429|5\d\d)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|timed? ?out|connection (?:reset|refused|closed)|unexpected EOF|\bEOF\s*$|stream error|GOAWAY|rate limit|error connecting to|githubstatus|TLS handshake|no such host|temporary failure|server misbehaving/im;
// Each text on its own: a bare EOF ends a line only in the text it was printed in, and stderr may lack its newline.
export const isTransient = (error) => [error?.stderr, error?.message].some((text) => TRANSIENT.test(String(text ?? "")));

/** The waits between the tries of a read: three tries in all. */
const READ_WAITS_MS = [2_000, 6_000];

/** Runs a read again after a transient failure. Only for reads: repeating a write could do it twice. */
async function retried(operation, { sleep, log }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= READ_WAITS_MS.length || !isTransient(error)) throw error;
      log(`::warning title=GitHub API::A request failed (${String(error.stderr ?? error.message).trim().split("\n")[0]}); trying again in ${READ_WAITS_MS[attempt] / 1000} s.`);
      await sleep(READ_WAITS_MS[attempt]);
    }
  }
}

/**
 * The client interface over `gh api`, for one repository. `exec(args) -> Buffer` is gh itself, or a fake. Reads and
 * downloads are tried again after a transient failure; a write goes out once, since only its caller knows whether it
 * can be repeated.
 */
export function ghClient({ repo, exec, sleep = realSleep, log = () => {} }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" is not a repository in the form owner/name`);
  const read = (args) => retried(() => exec(args), { sleep, log });
  const json = async (args) => JSON.parse((await read(args)).toString("utf8"));
  return {
    getRelease: (id) => json(["api", `repos/${repo}/releases/${id}`]),
    async listReleases() {
      const all = [];
      for (let page = 1; ; page++) {
        const batch = await json(["api", `repos/${repo}/releases?per_page=100&page=${page}`]);
        all.push(...batch);
        if (batch.length < 100) return all;
      }
    },
    async getReleaseByTag(tag) {
      try {
        return await json(["api", `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`]);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async getLatestPublishedTag() {
      try {
        return (await json(["api", `repos/${repo}/releases/latest`])).tag_name ?? null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    downloadAsset: (id) => read(["api", "-H", "Accept: application/octet-stream", `repos/${repo}/releases/assets/${id}`]),
    async deleteRelease(id) {
      await exec(["api", "--method", "DELETE", `repos/${repo}/releases/${id}`]);
    },
    async deleteAsset(id) {
      await exec(["api", "--method", "DELETE", `repos/${repo}/releases/assets/${id}`]);
    },
    async uploadAsset(releaseId, name, filePath) {
      await exec(["api", "--method", "POST", "-H", "Content-Type: application/octet-stream", "--input", filePath, `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`]);
    },
    // GitHub answers a PATCH with the release as it now is; what comes back is that, or nothing when it is not a release.
    async patchRelease(id, fields) {
      const answer = await exec(["api", "--method", "PATCH", `repos/${repo}/releases/${id}`, ...Object.entries(fields).flatMap(([key, value]) => ["-F", `${key}=${value}`])]);
      try {
        const parsed = JSON.parse(Buffer.from(answer).toString("utf8"));
        return isObject(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { maxBuffer: 1 << 26, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

/** The real outside world: gh, git, the file system, the console and the network. */
export function realDeps() {
  return {
    makeClient: (repo) => ghClient({ repo, exec: ghExec, log: (line) => console.info(line) }),
    git: {
      show: (tag, path) => runGit(["show", `${tag}:${path}`]),
      fetchTag: (tag) => runGit(["fetch", "--no-tags", "--depth=1", "origin", `refs/tags/${tag}:refs/tags/${tag}`]),
    },
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, text) => writeFileSync(path, text),
    log: (line) => console.info(line),
    error: (line) => console.error(line),
    env: process.env,
    fetchImpl: globalThis.fetch,
  };
}

/** Splits `command --option value --flag` into the command and its options. */
export function parseArgs(argv, { flags = [], repeatable = [], known = null } = {}) {
  if (argv.length === 0) throw new UsageError("no command given");
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (known && !known.includes(name) && !flags.includes(name) && !repeatable.includes(name)) throw new UsageError(`unknown option --${name}`);
    if (flags.includes(name)) {
      options[name] = true;
      continue;
    }
    const value = rest[++i];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    if (repeatable.includes(name)) (options[name] ??= []).push(value);
    else options[name] = value;
  }
  return { command, options };
}

const USAGE = `Usage: node scripts/check-release-draft.mjs <command> [options]
  prepare           --repo OWNER/NAME --tag TAG
  check | publish   --repo OWNER/NAME --release-id ID --tag TAG --conf tauri.conf.json --trusted-conf FILE
                    --started-at ISO-TIME [--dry-run] [--allow-key-rotation] [--expect-sha256 ASSET=HEX]...
  discard           --repo OWNER/NAME --tag dry-run-ID
  trusted-conf      --repo OWNER/NAME --out FILE [--path PATH] [--conf tauri.conf.json [--allow-key-rotation]]
  replace-appimage  --repo OWNER/NAME --release-id ID --tag TAG --appimage FILE
  poll              --repo OWNER/NAME --tag TAG [--attempts N] [--delay-ms MS]`;

const COMMANDS = {
  prepare: { required: ["tag"], known: ["repo", "tag"] },
  discard: { required: ["tag"], known: ["repo", "tag"] },
  check: { required: ["release-id", "tag", "conf", "trusted-conf", "started-at"], known: ["repo", "release-id", "tag", "conf", "trusted-conf", "started-at"], flags: ["dry-run", "allow-key-rotation"], repeatable: ["expect-sha256"] },
  publish: { required: ["release-id", "tag", "conf", "trusted-conf", "started-at"], known: ["repo", "release-id", "tag", "conf", "trusted-conf", "started-at"], flags: ["dry-run", "allow-key-rotation"], repeatable: ["expect-sha256"] },
  "trusted-conf": { required: ["out"], known: ["repo", "out", "path", "conf"], flags: ["allow-key-rotation"] },
  "replace-appimage": { required: ["release-id", "tag", "appimage"], known: ["repo", "release-id", "tag", "appimage"] },
  poll: { required: ["tag"], known: ["repo", "tag", "attempts", "delay-ms"] },
};

function readText(deps, path) {
  try {
    return deps.readFile(path);
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error.code ?? error.message}`);
  }
}

function parseConfig(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

/** Says out loud that the opt-in was used: the key in the release differs from the one installed copies hold. */
const ROTATION_NOTICE = "::notice title=Key rotation::plugins.updater.pubkey differs from the previous release's, which --allow-key-rotation permits on this manual run. The signatures are still checked against the previous release's key, the one installed copies hold, and the next release must be signed with the new one (docs/RELEASING.md).";

/**
 * The command line, with its outside world in `deps` (see realDeps). Returns the exit status: 0 done, 1 the release
 * or the tooling failed, 2 the command was used wrongly.
 */
export async function runCommand(argv, deps) {
  const say = (line) => deps.log(line);
  const fail = (title, message) => deps.error(`::error title=${title}::${String(message).replace(/\r?\n/g, " ")}`);
  let parsed;
  try {
    const spec = COMMANDS[argv[0]];
    if (argv.length > 0 && !spec) throw new UsageError(`unknown command ${argv[0]}`);
    parsed = parseArgs(argv, spec ?? {});
    for (const name of spec.required) {
      if (parsed.options[name] === undefined) throw new UsageError(`${argv[0]} needs --${name}`);
    }
    parsed.options.repo ??= deps.env?.GITHUB_REPOSITORY;
    if (!parsed.options.repo) throw new UsageError("no repository: give --repo or set GITHUB_REPOSITORY");
    if (parsed.options["allow-key-rotation"]) {
      // Replacing the updater key strands every installed copy if the new key is wrong, so only a person at a manual run
      // may ask for it: a tag push, which nobody reviews at the time, cannot.
      if (deps.env?.GITHUB_EVENT_NAME === "push") {
        throw new UsageError("--allow-key-rotation is for a manual run (workflow_dispatch with rotate_key), not a push: a pushed tag cannot opt in to replacing the updater key (docs/RELEASING.md, Replacing the signing key)");
      }
      if (argv[0] === "trusted-conf" && parsed.options.conf === undefined) {
        throw new UsageError("--allow-key-rotation applies to the comparison that --conf asks for");
      }
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    deps.error(`check-release-draft: ${error.message}`);
    deps.error(USAGE);
    return 2;
  }
  const { command, options } = parsed;

  try {
    if (command === "poll") {
      await pollLatest({
        repo: options.repo,
        tag: options.tag,
        fetchImpl: deps.fetchImpl,
        log: say,
        attempts: options.attempts ? Number(options.attempts) : undefined,
        delayMs: options["delay-ms"] ? Number(options["delay-ms"]) : undefined,
        sleep: deps.sleep,
      });
      return 0;
    }
    const client = deps.makeClient(options.repo);
    if (command === "prepare") {
      const { deleted } = await prepareTag({ client, tag: options.tag, log: say });
      say(deleted.length === 0 ? `No stale draft for ${options.tag}.` : `Deleted ${deleted.length} stale draft${deleted.length === 1 ? "" : "s"} for ${options.tag}.`);
      return 0;
    }
    if (command === "discard") {
      if (!/^dry-run-\d+$/.test(options.tag)) throw new UsageError("only dry-run drafts can be discarded (the tag must be dry-run-<run id>)");
      const { deleted } = await discardDrafts({ client, tag: options.tag, log: say });
      say(`Discarded ${deleted.length} draft${deleted.length === 1 ? "" : "s"} for ${options.tag}.`);
      return 0;
    }
    if (command === "trusted-conf") {
      const { tag, text } = await resolveTrustedConfig({ client, git: deps.git, path: options.path ?? "apps/desktop/src-tauri/tauri.conf.json" });
      deps.writeFile(options.out, text);
      say(`::notice title=Trusted updater key::Verifying against plugins.updater.pubkey as it was at ${tag}, the newest published release.`);
      if (options.conf !== undefined) {
        // The early look: the comparison with the previous release that publish makes, here, in seconds, before any build.
        const conf = parseConfig(readText(deps, options.conf), options.conf);
        const trustedConf = parseConfig(text, `the configuration at ${tag}`);
        const { problems, rotating } = checkContinuity({ conf, trustedConf, allowKeyRotation: options["allow-key-rotation"] === true });
        if (problems.length > 0) throw new ReleaseCheckError(problems);
        say(rotating ? ROTATION_NOTICE : `::notice title=Continuity::${options.conf} keeps the same key, endpoints and identifier as ${tag}, at a higher version (${conf.version} after ${trustedConf.version}).`);
      }
      return 0;
    }
    if (command === "replace-appimage") {
      const result = await replaceAppImage({ client, releaseId: Number(options["release-id"]), repo: options.repo, tag: options.tag, appImagePath: options.appimage, sleep: deps.sleep, log: say });
      say(`Replaced the AppImage in release ${options["release-id"]}: sha256=${result.sha256} size=${result.size}; rewrote ${result.rewrittenUrls} download URL${result.rewrittenUrls === 1 ? "" : "s"}.`);
      return 0;
    }
    // check and publish
    const expectPairs = {};
    for (const pair of options["expect-sha256"] ?? []) {
      const match = /^([^=]+)=([0-9a-f]{64})$/.exec(pair);
      if (!match) throw new UsageError(`--expect-sha256 wants ASSET=<64 hex digits>, got ${pair}`);
      expectPairs[match[1]] = match[2];
    }
    if (command === "publish" && options["dry-run"]) throw new UsageError("a dry run is never published");
    const conf = parseConfig(readText(deps, options.conf), options.conf);
    const trustedText = readText(deps, options["trusted-conf"]);
    const run = {
      client,
      releaseId: Number(options["release-id"]),
      trustedKeyText: publicKeyFromConfig(trustedText, options["trusted-conf"]),
      conf,
      trustedConf: parseConfig(trustedText, options["trusted-conf"]),
      allowKeyRotation: options["allow-key-rotation"] === true,
      expect: { repo: options.repo, tag: options.tag, version: conf.version, productName: conf.productName, dryRun: options["dry-run"] === true, startedAt: options["started-at"] },
      expectedSha256: expectPairs,
    };
    if (run.allowKeyRotation && checkContinuity(run).rotating) say(ROTATION_NOTICE);
    if (command === "publish") {
      await publishDraft(run);
      say(`Published ${options.tag} (release ${options["release-id"]}).`);
      return 0;
    }
    const { problems } = await checkDraft(run);
    if (problems.length > 0) throw new ReleaseCheckError(problems);
    say(`The draft passes every check: ${options.tag}, version ${conf.version}.`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.error(`check-release-draft: ${error.message}`);
      deps.error(USAGE);
      return 2;
    }
    if (error instanceof ReleaseCheckError) {
      for (const problem of error.problems) fail("Release draft check", problem);
      return 1;
    }
    fail(command === "prepare" ? "Release tag" : "Release tooling", error.message);
    return 1;
  }
}
