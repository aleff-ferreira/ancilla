import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COLLECTOR_SCRIPT } from "./collector-script.js";
import { LINE_MAX, parseLine } from "./events.js";
import type { CollectorState, CollectorStatus, SentinelEvent } from "./types.js";

/**
 * Runs the collector script as a child process and turns its lines into events. The child is read-only and is restarted with a
 * growing pause when it dies; five quick deaths in a row stop the attempts, and the status says why. What the child prints is
 * untrusted: a line that is not understood is dropped.
 */

export interface CollectorHooks {
  event(event: SentinelEvent): void;
  status(status: CollectorStatus): void;
  /** The log's history has all been sent (it can be empty): what follows is live. */
  ready(): void;
}

export interface Collector {
  /** `since`: the newest OS log event already kept, in ms, so that the log is read back from there; null reads the last 45 days. */
  start(hooks: CollectorHooks, since: number | null): void;
  stop(): void;
  status(): CollectorStatus;
}

/** The part of a child process the collector uses, so that a test can stand one in. */
export interface ChildLike {
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(): boolean;
}

export type SpawnFn = (command: string, args: string[], options: { windowsHide: boolean; stdio: ["ignore", "pipe", "pipe"] }) => ChildLike;

export interface PowerShellOptions {
  /** Where the script is written. */
  dir: string;
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
  /** The process whose end ends the child. */
  parentPid?: number;
  sampleSeconds?: number;
  now?: () => number;
  /** The pause before restart number `attempt` (1 first). A test makes it short. */
  pauseMs?: (attempt: number) => number;
  log?: (line: string) => void;
}

const HELLO_WAIT_MS = 30_000;
const STABLE_MS = 60_000;
const QUICK_MS = 10_000;
const QUICK_LIMIT = 5;
const PAUSE_MAX_MS = 60_000;

export class PowerShellCollector implements Collector {
  private readonly platform: NodeJS.Platform;
  private readonly spawnChild: SpawnFn;
  private readonly now: () => number;
  private hooks: CollectorHooks | null = null;
  private since: number | null = null;
  private child: ChildLike | null = null;
  private wanted = false;
  private quick = 0;
  private startedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  private current: CollectorStatus = { state: "off", since: null, restarts: 0, lastError: null, sources: {} };

  constructor(private readonly options: PowerShellOptions) {
    this.platform = options.platform ?? process.platform;
    this.spawnChild = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
    this.now = options.now ?? Date.now;
  }

  status(): CollectorStatus {
    return { ...this.current, sources: { ...this.current.sources } };
  }

  start(hooks: CollectorHooks, since: number | null): void {
    if (this.wanted) return;
    this.hooks = hooks;
    this.since = since;
    this.quick = 0;
    this.current = { state: "off", since: null, restarts: 0, lastError: null, sources: {} };
    if (this.platform !== "win32") {
      this.set("unsupported", "The Sentinel's collector runs on Windows only.");
      return;
    }
    this.wanted = true;
    this.launch();
  }

  stop(): void {
    this.wanted = false;
    this.clearTimers();
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch {
        /* it has gone already */
      }
    }
    if (this.current.state !== "unsupported") this.set("off", null);
  }

  // ------------------------------------------------------------------------------------------------------------------- run

  private scriptPath(): string {
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    const path = join(this.options.dir, "collector.ps1");
    // Written again only when it differs, so that a script the person has been looking at does not change under them for nothing.
    let same = false;
    try {
      same = existsSync(path) && readFileSync(path, "utf8") === COLLECTOR_SCRIPT;
    } catch {
      same = false;
    }
    if (!same) writeFileSync(path, COLLECTOR_SCRIPT, { encoding: "utf8", mode: 0o600 });
    return path;
  }

  private powershell(): string {
    const root = process.env["SystemRoot"] ?? "C:\\Windows";
    const system = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return existsSync(system) ? system : "powershell.exe";
  }

  private launch(): void {
    if (!this.wanted) return;
    this.set("starting", null);
    this.startedAt = this.now();
    let child: ChildLike;
    try {
      const args = [
        "-NoProfile",
        "-NonInteractive",
        "-NoLogo",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.scriptPath(),
        "-ParentPid",
        String(this.options.parentPid ?? process.pid),
        "-SampleSeconds",
        String(this.options.sampleSeconds ?? 30),
        "-Since",
        new Date(this.since ?? this.now() - 45 * 86_400_000).toISOString(),
      ];
      child = this.spawnChild(this.powershell(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.died(error instanceof Error ? error.message : String(error));
      return;
    }
    this.child = child;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 600) stderr += String(chunk).slice(0, 600 - stderr.length);
    });
    this.readLines(child);
    child.on("error", (error) => {
      if (this.child === child) this.died(error.message);
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.died(stderr.trim() !== "" ? stderr.trim().replace(/\s+/g, " ") : `the collector ended (exit code ${code ?? "none"})`);
    });
    this.helloTimer = setTimeout(() => {
      if (this.child === child && this.current.state === "starting") {
        try {
          child.kill();
        } catch {
          /* it has gone already */
        }
      }
    }, HELLO_WAIT_MS);
    this.helloTimer.unref();
  }

  private readLines(child: ChildLike): void {
    let buffer = "";
    let skipping = false;
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (this.child !== child) return;
      buffer += String(chunk);
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (skipping) skipping = false;
        else this.line(line);
      }
      // A line with no end that is already too long is not a line of ours: drop it up to its newline.
      if (buffer.length > LINE_MAX) {
        buffer = "";
        skipping = true;
      }
    });
  }

  private line(text: string): void {
    const line = parseLine(text);
    if (!line) return;
    try {
      if (line.kind === "hello") {
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = null;
        this.set("running", null);
      } else if (line.kind === "source") {
        this.current.sources[line.name] = { ok: line.ok, detail: line.detail };
        this.hooks?.status(this.status());
      } else if (line.kind === "ready") {
        this.hooks?.ready();
      } else if (line.kind === "event") {
        this.hooks?.event(line.event);
      }
    } catch (error) {
      // This runs inside a stream's data handler: an exception here would end the whole process.
      this.options.log?.(`sentinel: a collector line could not be handled: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private died(reason: string): void {
    this.clearTimers();
    this.child = null;
    if (!this.wanted) return;
    const ran = this.now() - this.startedAt;
    this.quick = ran >= STABLE_MS ? 0 : ran < QUICK_MS ? this.quick + 1 : this.quick;
    this.current.restarts++;
    if (this.quick >= QUICK_LIMIT) {
      this.wanted = false;
      this.set("failed", reason);
      this.options.log?.(`sentinel: the collector keeps failing and was stopped: ${reason}`);
      return;
    }
    this.set("starting", reason);
    const attempt = Math.max(1, this.quick);
    const pause = this.options.pauseMs ? this.options.pauseMs(attempt) : Math.min(PAUSE_MAX_MS, 1000 * 2 ** (attempt - 1));
    this.timer = setTimeout(() => this.launch(), pause);
    this.timer.unref();
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.timer = null;
    this.helloTimer = null;
  }

  private set(state: CollectorState, lastError: string | null): void {
    this.current = { ...this.current, state, since: this.now(), lastError: lastError ?? (state === "running" ? null : this.current.lastError) };
    this.hooks?.status(this.status());
  }
}
