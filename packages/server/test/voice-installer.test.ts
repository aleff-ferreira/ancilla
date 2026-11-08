/**
 * The download of the voice: that every file is checked before it is used, that a stopped download goes on from where it
 * was, that nothing half-installed is left for a call to trip over, and that the pinned manifest is sound. The network is
 * a stand-in that serves bytes from memory.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallError, PackInstaller } from "../src/voice/installer.js";
import { packItems, platformPackage, SHERPA_VERSION, type PackItemSpec } from "../src/voice/manifest.js";
import { inspectPack } from "../src/voice/engines/index.js";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "ancilla-pack-"));
  after(() => rm(d, { recursive: true, force: true }));
  return d;
}

function bytes(n: number, seed: number): Buffer {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

interface Served {
  body: Buffer;
  /** Ignore a Range request and send everything, as some servers do. */
  noRange?: boolean;
  /** Stop after this many bytes the first time, as a dropped connection does. */
  breakAt?: number;
}

/** A network that serves addresses from memory, and keeps count of what was asked. */
function network(files: Record<string, Served>) {
  const log: Array<{ url: string; range: string | null }> = [];
  const dropped = new Set<string>();
  const impl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const address = String(url);
    const file = files[address];
    const range = new Headers(init?.headers).get("range");
    log.push({ url: address, range });
    if (!file) return new Response("nope", { status: 404 });
    let from = 0;
    let status = 200;
    if (range && !file.noRange) {
      const m = /^bytes=(\d+)-$/.exec(range);
      from = m ? Number(m[1]) : 0;
      if (from >= file.body.length) return new Response(null, { status: 416 });
      status = 206;
    }
    let slice = file.body.subarray(from);
    const breaking = file.breakAt !== undefined && !dropped.has(address);
    if (breaking) {
      dropped.add(address);
      slice = slice.subarray(0, file.breakAt);
    }
    // Pulled a piece at a time, so that a dropped connection comes after the pieces that were already delivered.
    let at = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at < slice.length) {
          controller.enqueue(new Uint8Array(slice.subarray(at, Math.min(slice.length, at + 4096))));
          at += 4096;
        } else if (breaking) controller.error(new Error("connection reset"));
        else controller.close();
      },
    });
    return new Response(stream, { status });
  }) as typeof fetch;
  return { impl, log };
}

function fileItem(id: string, body: Buffer, extra: Partial<PackItemSpec> = {}): PackItemSpec {
  return { id, label: id, kind: "file", url: `https://example.test/${id}`, bytes: body.length, sha256: sha256(body), license: "MIT", licenseUrl: "https://example.test/license", optional: false, name: `${id}.onnx`, ...extra };
}

describe("installing the voice", () => {
  it("downloads, checks and puts each file in place, reporting progress, and says it is done", async () => {
    const d = await dir();
    const a = bytes(40_000, 1);
    const b = bytes(25_000, 2);
    const net = network({ "https://example.test/a": { body: a }, "https://example.test/b": { body: b } });
    const installer = new PackInstaller({ dir: d, log: () => undefined, fetchImpl: net.impl, items: [fileItem("a", a), fileItem("b", b)], freeBytes: async () => 1e12 });
    installer.start({ refine: true });
    assert.equal(installer.job().state, "running");
    assert.equal(installer.job().totalBytes, 65_000);
    const job = await installer.settled();
    assert.equal(job.state, "done");
    assert.equal(job.doneBytes, 65_000);
    assert.deepEqual(await readFile(join(d, "models", "a.onnx")), a);
    assert.deepEqual(await readFile(join(d, "models", "b.onnx")), b);
    assert.equal((await readdir(join(d, "downloads"))).length, 0, "no archive is left behind");
    // Asked again, it downloads nothing: everything is already there.
    net.log.length = 0;
    installer.start({ refine: true });
    assert.equal((await installer.settled()).state, "done");
    assert.equal(net.log.length, 0);
  });

  it("throws away a file that does not match its checksum, and installs nothing from it", async () => {
    const d = await dir();
    const good = bytes(10_000, 3);
    const tampered = Buffer.from(good);
    tampered[5000] ^= 0xff;
    const net = network({ "https://example.test/x": { body: tampered } });
    const lines: string[] = [];
    const installer = new PackInstaller({ dir: d, log: (l) => lines.push(l), fetchImpl: net.impl, items: [fileItem("x", good)], freeBytes: async () => 1e12 });
    installer.start({ refine: false });
    const job = await installer.settled();
    assert.equal(job.state, "failed");
    assert.match(job.error ?? "", /did not match its checksum/);
    assert.equal(existsSync(join(d, "models", "x.onnx")), false);
    assert.equal(existsSync(join(d, "downloads", "x.onnx.part")), false, "the bad bytes are not kept for a resume");
    assert.match(lines.join("\n"), /install failed/);
  });

  it("goes on from where a dropped connection stopped, and starts over when the server will not resume", async () => {
    const d = await dir();
    const body = bytes(60_000, 4);
    const net = network({ "https://example.test/r": { body, breakAt: 20_000 }, "https://example.test/s": { body, noRange: true, breakAt: 20_000 } });
    const item = (id: string) => fileItem(id, body);
    const first = new PackInstaller({ dir: d, log: () => undefined, fetchImpl: net.impl, items: [item("r")], freeBytes: async () => 1e12 });
    first.start({ refine: false });
    assert.equal((await first.settled()).state, "failed", "the connection dropped");
    const partial = (await stat(join(d, "downloads", "r.onnx.part"))).size;
    assert.ok(partial > 0 && partial < 60_000, `a part was kept: ${partial}`);
    first.start({ refine: false });
    assert.equal((await first.settled()).state, "done");
    assert.deepEqual(await readFile(join(d, "models", "r.onnx")), body, "joined correctly, and the checksum agrees");
    assert.ok(net.log.some((e) => e.url.endsWith("/r") && e.range?.startsWith("bytes=")), "the second try asked for the rest");
    const second = new PackInstaller({ dir: d, log: () => undefined, fetchImpl: net.impl, items: [item("s")], freeBytes: async () => 1e12 });
    second.start({ refine: false });
    await second.settled();
    second.start({ refine: false });
    assert.equal((await second.settled()).state, "done", "a server that sends it all again is handled");
    assert.deepEqual(await readFile(join(d, "models", "s.onnx")), body);
  });

  it("stops on cancel and keeps the part for later", async () => {
    const d = await dir();
    const body = bytes(2_000_000, 5);
    const net = network({ "https://example.test/c": { body } });
    const installer = new PackInstaller({ dir: d, log: () => undefined, fetchImpl: net.impl, items: [fileItem("c", body)], freeBytes: async () => 1e12 });
    installer.start({ refine: false });
    installer.cancel();
    const job = await installer.settled();
    assert.equal(job.state, "cancelled");
    assert.equal(existsSync(join(d, "models", "c.onnx")), false);
  });

  it("refuses a download that is far larger than it should be, and one that is not over https", async () => {
    const d = await dir();
    const body = bytes(5_000_000, 6);
    const net = network({ "https://example.test/big": { body } });
    const small = fileItem("big", body, { bytes: 1000 });
    const installer = new PackInstaller({ dir: d, log: () => undefined, fetchImpl: net.impl, items: [small], freeBytes: async () => 1e12 });
    installer.start({ refine: false });
    assert.match((await installer.settled()).error ?? "", /larger than it should be/);
    const plain = new PackInstaller({ dir: d, log: () => undefined, fetchImpl: net.impl, items: [fileItem("p", body, { url: "http://example.test/p" })], freeBytes: async () => 1e12 });
    plain.start({ refine: false });
    assert.match((await plain.settled()).error ?? "", /not a secure one/);
  });

  it("says plainly when the disk is too full, and when this platform has no engine", async () => {
    const d = await dir();
    const body = bytes(1000, 7);
    const installer = new PackInstaller({ dir: d, log: () => undefined, fetchImpl: network({}).impl, items: [fileItem("f", body, { bytes: 5_000_000_000 })], freeBytes: async () => 1_000_000 });
    installer.start({ refine: false });
    assert.match((await installer.settled()).error ?? "", /not enough disk space/);
    const none = new PackInstaller({ dir: d, log: () => undefined, platform: "freebsd" as NodeJS.Platform, arch: "x64" });
    assert.equal(none.plan(true), null);
    assert.throws(() => none.start({ refine: true }), InstallError);
  });

  it("leaves the optional model out when it is not wanted, and removes everything when asked", async () => {
    const d = await dir();
    const core = bytes(3000, 8);
    const extra = bytes(4000, 9);
    const net = network({ "https://example.test/core": { body: core }, "https://example.test/extra": { body: extra } });
    const items = [fileItem("core", core), fileItem("extra", extra, { optional: true })];
    const installer = new PackInstaller({ dir: d, log: () => undefined, fetchImpl: net.impl, items, freeBytes: async () => 1e12 });
    assert.equal(installer.plan(false)?.items.length, 1);
    assert.equal(installer.plan(true)?.items.length, 2);
    installer.start({ refine: false });
    await installer.settled();
    assert.equal(existsSync(join(d, "models", "core.onnx")), true);
    assert.equal(existsSync(join(d, "models", "extra.onnx")), false);
    assert.ok((await installer.installedBytes()) >= 3000);
    await installer.remove();
    assert.equal(existsSync(join(d, "models")), false);
    assert.equal(installer.job().state, "idle");
  });

  it("unpacks an npm package (with the system tar) to where node will look for it, and marks it whole", async () => {
    const d = await dir();
    // A package the way npm packs one: everything under a top folder called `package`.
    const src = await mkdtemp(join(tmpdir(), "ancilla-pack-src-"));
    after(() => rm(src, { recursive: true, force: true }));
    await mkdir(join(src, "package"), { recursive: true });
    await writeFile(join(src, "package", "package.json"), JSON.stringify({ name: "fake-engine", version: "1.0.0" }));
    await writeFile(join(src, "package", "index.js"), "module.exports = 42;\n");
    const tgz = join(src, "fake.tgz");
    try {
      execFileSync("tar", ["-czf", tgz, "-C", src, "package"]);
    } catch {
      return; // no tar on this machine: nothing to test here
    }
    const body = await readFile(tgz);
    const item: PackItemSpec = { id: "fake-engine", label: "Fake", kind: "npm", url: "https://example.test/fake.tgz", bytes: body.length, integrity: `sha512-${createHash("sha512").update(body).digest("base64")}`, license: "MIT", licenseUrl: "https://example.test", optional: false, name: "fake-engine" };
    const net = network({ "https://example.test/fake.tgz": { body } });
    const installer = new PackInstaller({ dir: d, log: () => undefined, fetchImpl: net.impl, items: [item], freeBytes: async () => 1e12 });
    installer.start({ refine: false });
    const job = await installer.settled();
    assert.equal(job.state, "done", job.error ?? "");
    const home = join(d, "runtime", "node_modules", "fake-engine");
    assert.equal(await readFile(join(home, "index.js"), "utf8"), "module.exports = 42;\n");
    assert.equal(existsSync(join(home, ".ancilla-ok")), true);
    assert.equal(existsSync(join(d, "unpacking", "fake-engine")), false, "the scratch folder is gone");
  });
});

describe("the pinned manifest", () => {
  it("names a native package for each supported platform, over https, with a checksum for every download", () => {
    for (const [platform, arch] of [["linux", "x64"], ["linux", "arm64"], ["darwin", "x64"], ["darwin", "arm64"], ["win32", "x64"]] as const) {
      const items = packItems(platform, arch);
      assert.ok(items, `${platform}-${arch}`);
      assert.equal(items.length, 6, "the engine, its native code, the detector, the recogniser, the voice and the booster");
      for (const item of items) {
        assert.match(item.url, /^https:\/\//, item.id);
        assert.ok(item.sha256 || item.integrity, `${item.id} has a checksum`);
        assert.ok(item.bytes > 0);
        assert.ok(item.license && item.licenseUrl.startsWith("https://"), `${item.id} says what licence it is under`);
      }
      assert.equal(items.filter((i) => i.optional).length, 1, "only the accuracy booster is optional");
      assert.ok(items.some((i) => i.name === platformPackage(platform, arch)));
      assert.ok(items.filter((i) => i.kind === "npm").every((i) => i.url.endsWith(`-${SHERPA_VERSION}.tgz`)));
    }
    assert.equal(packItems("freebsd" as NodeJS.Platform, "x64"), null);
    assert.equal(packItems("win32", "ia32"), null, "no pinned checksum, so none is offered");
  });

  it("puts each model where the engines look for it", () => {
    const items = packItems("linux", "x64") ?? [];
    const models = items.filter((i) => i.kind !== "npm");
    const layout = { runtimeDir: null as string | null, modelsDir: "/nowhere" };
    // The names the manifest unpacks to are the names the engines read; if either changes the other must.
    const names = new Set(models.map((m) => m.name));
    for (const expected of ["silero_vad.onnx", "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11", "sherpa-onnx-supertonic-3-tts-int8-2026-05-11", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"]) assert.ok(names.has(expected), expected);
    assert.equal(inspectPack(layout).ready, false);
  });
});
