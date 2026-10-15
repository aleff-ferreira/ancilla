// A GitHub release held in memory, behind the same client interface lib/release-draft.mjs talks to, plus a
// builder for a complete, correctly signed draft that tests then damage one way at a time.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { generateKey, publicKeyText, signatureText } from "./minisign.mjs";

export const REPO = "aleff-ferreira/ancilla";
export const PRODUCT = "Ancilla";
export const STARTED = "2026-10-20T10:00:00Z";
const UPLOADED = "2026-10-20T10:20:00Z";

/** Which asset each updater platform must point at, written out here independently of the library. */
export function platformAssets(version) {
  return {
    "windows-x86_64": `Ancilla_${version}_x64-setup.exe`,
    "windows-x86_64-nsis": `Ancilla_${version}_x64-setup.exe`,
    "darwin-aarch64": "Ancilla_universal.app.tar.gz",
    "darwin-x86_64": "Ancilla_universal.app.tar.gz",
    "darwin-aarch64-app": "Ancilla_universal.app.tar.gz",
    "darwin-x86_64-app": "Ancilla_universal.app.tar.gz",
    "linux-x86_64": `Ancilla_${version}_amd64.AppImage`,
    "linux-x86_64-appimage": `Ancilla_${version}_amd64.AppImage`,
    "linux-x86_64-deb": `Ancilla_${version}_amd64.deb`,
    "linux-x86_64-rpm": `Ancilla-${version}-1.x86_64.rpm`,
  };
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** What the previous release's updater configuration held; a draft's own configuration differs from it in the version only. */
export const PREVIOUS_VERSION = "0.20.3";
export const IDENTIFIER = "app.ancilla.desktop";
export const ENDPOINTS = Object.freeze([`https://github.com/${REPO}/releases/latest/download/latest.json`]);

/** A tauri.conf.json as parsed, with the fields the continuity rules compare. */
export function updaterConf({ version, pubkey, identifier = IDENTIFIER, endpoints = [...ENDPOINTS] }) {
  return { productName: PRODUCT, version, identifier, plugins: { updater: { pubkey, endpoints, windows: { installMode: "passive" } } } };
}

/**
 * A draft that passes every check. `files` maps asset id to bytes. Everything is plain data, so a test can
 * change one thing with `structuredClone` and an edit.
 */
export function buildDraft({ version = "0.20.4", dryRun = false, tag = dryRun ? "dry-run-123456" : `v${version}`, key = generateKey(), createdAt = UPLOADED } = {}) {
  const names = [
    `Ancilla_${version}_x64-setup.exe`,
    `Ancilla_${version}_universal.dmg`,
    "Ancilla_universal.app.tar.gz",
    `Ancilla_${version}_amd64.AppImage`,
    `Ancilla_${version}_amd64.deb`,
    `Ancilla-${version}-1.x86_64.rpm`,
  ];
  const signedNames = names.filter((name) => !name.endsWith(".dmg"));
  const files = new Map();
  const assets = [];
  const signatures = {};
  let nextId = 5000;
  const add = (name, bytes) => {
    const id = nextId++;
    files.set(id, bytes);
    assets.push({
      id,
      name,
      size: bytes.length,
      state: "uploaded",
      created_at: createdAt,
      updated_at: createdAt,
      digest: `sha256:${sha256(bytes)}`,
      browser_download_url: `https://github.com/${REPO}/releases/download/untagged-0a1b2c3d4e5f/${name}`,
    });
  };
  for (const name of names) {
    const bytes = Buffer.from(`the bytes of ${name}\n`.repeat(20), "utf8");
    add(name, bytes);
    if (signedNames.includes(name)) {
      const text = signatureText(key, bytes, { trustedComment: `timestamp:1790000000\tfile:${name}` });
      signatures[`${name}.sig`] = text;
      add(`${name}.sig`, Buffer.from(text, "utf8"));
    }
  }
  const platforms = {};
  for (const [platform, name] of Object.entries(platformAssets(version))) {
    platforms[platform] = { signature: signatures[`${name}.sig`], url: `https://github.com/${REPO}/releases/download/${tag}/${name}` };
  }
  const manifest = {
    version,
    notes: `Ancilla ${tag}\n\n**New in ${version}**\n- Something changed.\n`,
    pub_date: "2026-10-20T10:19:00.000Z",
    platforms,
  };
  add("latest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
  const release = { id: 777, tag_name: tag, name: `Ancilla ${tag}`, draft: true, prerelease: dryRun, created_at: STARTED, assets };
  const trustedKeyText = publicKeyText(key);
  const appImage = `Ancilla_${version}_amd64.AppImage`;
  return {
    release,
    manifest,
    signatures,
    files,
    key,
    trustedKeyText,
    expect: { repo: REPO, tag, version, productName: PRODUCT, dryRun, startedAt: STARTED },
    // The tree being released and the previous release's: the same key, endpoints and identifier, the next version.
    conf: updaterConf({ version, pubkey: trustedKeyText }),
    trustedConf: updaterConf({ version: PREVIOUS_VERSION, pubkey: trustedKeyText }),
    // What the Linux job reports for the AppImage it signed.
    expectedSha256: { [appImage]: sha256(files.get(assets.find((asset) => asset.name === appImage).id)) },
  };
}

/** Everything checkDraft and publishDraft take besides the client, for a draft that is meant to pass. */
export function draftInputs(draft, over = {}) {
  return { releaseId: draft.release.id, expect: { ...draft.expect }, trustedKeyText: draft.trustedKeyText, conf: draft.conf, trustedConf: draft.trustedConf, expectedSha256: draft.expectedSha256, ...over };
}

/** Puts new bytes behind the named asset, as `latest.json` or a rebuilt installer would, keeping size and digest true. */
export function setAssetBytes(draft, name, bytes) {
  const asset = draft.release.assets.find((candidate) => candidate.name === name);
  draft.files.set(asset.id, bytes);
  asset.size = bytes.length;
  asset.digest = `sha256:${sha256(bytes)}`;
}

/** A client over a list of releases and a map of asset bytes, recording every call it gets. */
export function fakeClient({ releases = [], files = new Map(), failOn = {}, now = () => UPLOADED } = {}) {
  const calls = [];
  let nextAssetId = 90000;
  const find = (id) => releases.find((release) => release.id === id);
  const record = (op, detail = {}) => {
    calls.push({ op, ...detail });
    if (failOn[op]) throw new Error(`injected failure in ${op}`);
  };
  return {
    calls,
    releases,
    files,
    async getRelease(id) {
      record("getRelease", { id });
      const release = find(id);
      if (!release) throw new Error(`no release ${id}`);
      return structuredClone(release);
    },
    async listReleases() {
      record("listReleases");
      return structuredClone(releases);
    },
    async getReleaseByTag(tag) {
      record("getReleaseByTag", { tag });
      const release = releases.find((candidate) => candidate.tag_name === tag && !candidate.draft);
      return release ? structuredClone(release) : null;
    },
    async getLatestPublishedTag() {
      record("getLatestPublishedTag");
      const published = releases.filter((release) => !release.draft && !release.prerelease);
      return published.length ? published[0].tag_name : null;
    },
    async downloadAsset(id) {
      record("downloadAsset", { id });
      if (!files.has(id)) throw new Error(`no bytes for asset ${id}`);
      return Buffer.from(files.get(id));
    },
    async deleteRelease(id) {
      record("deleteRelease", { id });
      releases.splice(releases.findIndex((release) => release.id === id), 1);
    },
    async deleteAsset(id) {
      record("deleteAsset", { id });
      for (const release of releases) {
        release.assets = release.assets.filter((asset) => asset.id !== id);
      }
      files.delete(id);
    },
    async uploadAsset(releaseId, name, filePath) {
      record("uploadAsset", { releaseId, name });
      const bytes = readFileSync(filePath);
      const id = nextAssetId++;
      files.set(id, bytes);
      find(releaseId).assets.push({
        id,
        name,
        size: bytes.length,
        state: "uploaded",
        created_at: now(),
        updated_at: now(),
        digest: `sha256:${sha256(bytes)}`,
        browser_download_url: `https://github.com/${REPO}/releases/download/untagged-0a1b2c3d4e5f/${name}`,
      });
    },
    async patchRelease(id, fields) {
      record("patchRelease", { id, fields });
      Object.assign(find(id), fields);
      // GitHub answers a PATCH with the release as it now is.
      return structuredClone(find(id));
    },
  };
}
