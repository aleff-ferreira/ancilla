import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packItems, type PackItemSpec } from "./manifest.js";

/**
 * Downloads and unpacks the voice, when the person asks for it. It does one thing at a time and says what it is doing;
 * a download that stops can be started again and goes on from where it was; every file is checked against the checksum
 * written down in the manifest before it is unpacked, and nothing is moved into place until it has been unpacked whole.
 * A failure says what failed, and leaves nothing half-installed that a call would try to use.
 */

export type JobState = "idle" | "running" | "done" | "failed" | "cancelled";

export interface PackJob {
  state: JobState;
  step: string;
  doneBytes: number;
  totalBytes: number;
  error: string | null;
}

export interface PackPlan {
  items: PackItemSpec[];
  totalBytes: number;
  platform: string;
}

export interface InstallerDeps {
  /** The voice folder: `runtime/`, `models/` and `downloads/` live in it. */
  dir: string;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Unpacks an archive into a folder; the default runs the system `tar`. */
  extract?: (kind: "npm" | "tar.bz2", archive: string, destination: string) => Promise<void>;
  /** The free space where `dir` is, in bytes. */
  freeBytes?: (dir: string) => Promise<number>;
  /** For tests: the items instead of the pinned ones. */
  items?: PackItemSpec[] | null;
  platform?: NodeJS.Platform;
  arch?: string;
}

const MARKER = ".ancilla-ok";
/** A download may be this much larger than the manifest says (headers, a re-compressed archive) before it is refused. */
const SIZE_SLACK = 1.02;

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

function defaultExtract(kind: "npm" | "tar.bz2", archive: string, destination: string): Promise<void> {
  const args = kind === "npm" ? ["-xzf", archive, "-C", destination, "--strip-components=1"] : ["-xjf", archive, "-C", destination];
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-500)));
    child.on("error", (error) => reject(new InstallError(`The archive could not be unpacked: the tar program could not be run (${error.message}).`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new InstallError(`The archive could not be unpacked (tar exited ${code}${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}).`))));
  });
}

async function defaultFree(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

async function sizeOf(path: string): Promise<number> {
  try {
    const s = await stat(path);
    if (!s.isDirectory()) return s.size;
    let total = 0;
    for (const entry of await readdir(path)) total += await sizeOf(join(path, entry));
    return total;
  } catch {
    return 0;
  }
}

export class PackInstaller {
  private state: PackJob = { state: "idle", step: "", doneBytes: 0, totalBytes: 0, error: null };
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: InstallerDeps) {}

  get runtimeDir(): string {
    return join(this.deps.dir, "runtime");
  }

  get modelsDir(): string {
    return join(this.deps.dir, "models");
  }

  job(): PackJob {
    return { ...this.state };
  }

  /** What would be downloaded, or null when this platform has no native voice engine to offer. */
  plan(refine: boolean): PackPlan | null {
    const all = this.deps.items !== undefined ? this.deps.items : packItems(this.deps.platform, this.deps.arch);
    if (!all) return null;
    const items = all.filter((i) => !i.optional || refine);
    return { items, totalBytes: items.reduce((n, i) => n + i.bytes, 0), platform: `${this.deps.platform ?? process.platform}-${this.deps.arch ?? process.arch}` };
  }

  /** Every item that could be offered, with the optional ones, for the page to show. */
  catalog(): PackItemSpec[] {
    return (this.deps.items !== undefined ? this.deps.items : packItems(this.deps.platform, this.deps.arch)) ?? [];
  }

  async installedBytes(): Promise<number> {
    return (await sizeOf(this.runtimeDir)) + (await sizeOf(this.modelsDir));
  }

  /** Starts installing in the background. Returns at once; `job()` says how it is going. */
  start(options: { refine: boolean }): void {
    if (this.running) throw new InstallError("The voice is already being installed.");
    const plan = this.plan(options.refine);
    if (!plan) throw new InstallError(`There is no voice engine for ${this.deps.platform ?? process.platform} ${this.deps.arch ?? process.arch}.`);
    this.abort = new AbortController();
    this.state = { state: "running", step: "Starting", doneBytes: 0, totalBytes: plan.totalBytes, error: null };
    const signal = this.abort.signal;
    this.running = this.install(plan, signal)
      .then(() => {
        this.state = { ...this.state, state: "done", step: "Installed", doneBytes: this.state.totalBytes };
      })
      .catch((error: unknown) => {
        if (signal.aborted) {
          this.state = { ...this.state, state: "cancelled", step: "Cancelled", error: null };
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log(`voice: the install failed: ${message}`);
        this.state = { ...this.state, state: "failed", error: message };
      })
      .finally(() => {
        this.running = null;
        this.abort = null;
      });
  }

  /** Resolves when the job in progress, if any, has settled. */
  async settled(): Promise<PackJob> {
    await this.running;
    return this.job();
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** Deletes everything that was downloaded. */
  async remove(): Promise<void> {
    if (this.running) throw new InstallError("The voice is being installed; cancel that first.");
    await rm(this.runtimeDir, { recursive: true, force: true });
    await rm(this.modelsDir, { recursive: true, force: true });
    await rm(join(this.deps.dir, "downloads"), { recursive: true, force: true });
    await rm(join(this.deps.dir, "unpacking"), { recursive: true, force: true });
    this.state = { state: "idle", step: "", doneBytes: 0, totalBytes: 0, error: null };
  }

  // -------------------------------------------------------------------------------------------------------------------

  private finalPath(item: PackItemSpec): string {
    if (item.kind === "npm") return join(this.runtimeDir, "node_modules", item.name);
    return join(this.modelsDir, item.name);
  }

  private isInstalled(item: PackItemSpec): boolean {
    const path = this.finalPath(item);
    if (item.kind === "file") return existsSync(path);
    return existsSync(join(path, MARKER));
  }

  private async install(plan: PackPlan, signal: AbortSignal): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true });
    await mkdir(join(this.deps.dir, "downloads"), { recursive: true });
    const pending = plan.items.filter((i) => !this.isInstalled(i));
    const need = pending.reduce((n, i) => n + i.bytes, 0);
    // Room for the downloads and, once unpacked, the same again (the archives are removed as each is done).
    const free = await (this.deps.freeBytes ?? defaultFree)(this.deps.dir).catch(() => Number.POSITIVE_INFINITY);
    if (free < need * 2.2) throw new InstallError(`There is not enough disk space: about ${(need * 2.2 / 1024 ** 3).toFixed(1)} GB is needed and ${(free / 1024 ** 3).toFixed(1)} GB is free.`);
    // What is already installed counts as done, so the progress starts where the install left off.
    let done = plan.items.filter((i) => this.isInstalled(i)).reduce((n, i) => n + i.bytes, 0);
    this.state = { ...this.state, doneBytes: done };
    let index = 0;
    for (const item of plan.items) {
      index += 1;
      if (this.isInstalled(item)) continue;
      const label = `${item.label} (${index} of ${plan.items.length})`;
      this.state = { ...this.state, step: `Downloading ${label}` };
      const baseline = done;
      const archive = await this.download(item, signal, (bytes) => {
        this.state = { ...this.state, doneBytes: baseline + Math.min(bytes, item.bytes) };
      });
      this.state = { ...this.state, step: `Unpacking ${label}` };
      await this.unpack(item, archive, signal);
      done += item.bytes;
      this.state = { ...this.state, doneBytes: done };
    }
  }

  private async download(item: PackItemSpec, signal: AbortSignal, onBytes: (n: number) => void): Promise<string> {
    const target = join(this.deps.dir, "downloads", `${item.id}${item.kind === "file" ? ".onnx" : item.kind === "npm" ? ".tgz" : ".tar.bz2"}`);
    const part = `${target}.part`;
    if (!/^https:\/\//.test(item.url)) throw new InstallError(`${item.label}: the address is not a secure one.`);
    const algorithm = item.integrity ? "sha512" : "sha256";
    let hash = createHash(algorithm);
    let have = 0;
    // A download that was stopped goes on from where it was: what is on disk is read into the checksum first.
    if (existsSync(part)) {
      have = (await stat(part)).size;
      if (have > item.bytes * SIZE_SLACK) {
        await unlink(part);
        have = 0;
      } else {
        const earlier = hash;
        await new Promise<void>((resolve, reject) => {
          createReadStream(part)
            .on("data", (chunk) => earlier.update(chunk))
            .on("end", resolve)
            .on("error", reject);
        });
      }
    }
    if (have < item.bytes) {
      const doFetch = this.deps.fetchImpl ?? fetch;
      const response = await doFetch(item.url, { signal, headers: have > 0 ? { range: `bytes=${have}-` } : {} }).catch((error: unknown) => {
        if (signal.aborted) throw error;
        throw new InstallError(`${item.label} could not be downloaded: ${error instanceof Error ? error.message : String(error)}`);
      });
      // 416: asked for bytes past the end, because what is on disk is already all of it.
      if (response.status === 416) {
        await response.body?.cancel().catch(() => undefined);
      } else if (!response.ok || !response.body) {
        throw new InstallError(`${item.label} could not be downloaded: the server answered ${response.status}.`);
      }
      if (response.status !== 416) {
        if (response.status === 200 && have > 0) {
          // The server ignored the range and sent it all again: start over.
          await unlink(part);
          hash = createHash(algorithm);
          have = 0;
        }
        const out = createWriteStream(part, { flags: have > 0 ? "a" : "w" });
        let written = have;
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            if (signal.aborted) throw new InstallError("Cancelled.");
            written += chunk.length;
            if (written > item.bytes * SIZE_SLACK + 1_000_000) throw new InstallError(`${item.label} is larger than it should be, so it was not downloaded.`);
            hash.update(chunk);
            if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
            onBytes(written);
          }
        } finally {
          await new Promise<void>((resolve) => out.end(resolve));
        }
      }
    }
    if (signal.aborted) throw new InstallError("Cancelled.");
    const got = item.integrity ? `sha512-${hash.digest("base64")}` : hash.digest("hex");
    const want = item.integrity ?? item.sha256;
    if (got !== want) {
      await unlink(part).catch(() => undefined);
      throw new InstallError(`${item.label} did not match its checksum, so it was thrown away. Try again; if it keeps happening the download is being altered on the way.`);
    }
    await rename(part, target);
    return target;
  }

  private async unpack(item: PackItemSpec, archive: string, signal: AbortSignal): Promise<void> {
    const final = this.finalPath(item);
    if (item.kind === "file") {
      await mkdir(this.modelsDir, { recursive: true });
      await rename(archive, final);
      return;
    }
    const scratch = join(this.deps.dir, "unpacking", item.id);
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });
    try {
      await (this.deps.extract ?? defaultExtract)(item.kind, archive, scratch);
      if (signal.aborted) throw new InstallError("Cancelled.");
      // An archive unpacks to a folder named for it; an npm package, stripped of its own top folder, to the scratch folder itself.
      const unpacked = item.kind === "npm" ? scratch : join(scratch, item.name);
      if (!existsSync(unpacked)) throw new InstallError(`${item.label} did not unpack to what was expected.`);
      await mkdir(join(final, ".."), { recursive: true });
      await rm(final, { recursive: true, force: true });
      await rename(unpacked, final);
      await writeFile(join(final, MARKER), `${item.id}\n`);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      await unlink(archive).catch(() => undefined);
    }
  }
}
