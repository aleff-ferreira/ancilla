import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { settledWithin } from "../hostBounds.js";
import { originOf } from "../browser/sites.js";

/**
 * Authorized launching of commands, local dev servers, URLs, folders and desktop editors, together with the pending
 * authorization queue shared by live voice calls and screens.
 *
 * Security invariants:
 * 1. Nothing consequential executes unless pre-authorized by the user's standing posture (such as YOLO mode) or
 *    explicitly approved by the user on the screen or in a subsequent user turn after the request was presented.
 * 2. No model tool can resolve an authorization; only UI actions or verified subsequent-turn user input can.
 * 3. Every spawned background process belongs to a tracked group and is terminated when stopped or when Ancilla closes.
 */

export type AuthorizationKind = "launch" | "muse-approval" | "task-proposal" | "browser-site" | "browser-action";

export interface PendingAuthorizationView {
  id: string;
  kind: AuthorizationKind;
  title: string;
  detail: string;
  allowLabel: string;
  denyLabel: string;
  createdAt: number;
  createdTurn: number;
  /** True while a live Muse turn is paused waiting on this approval, so a spoken yes/no answers it without aborting the turn. */
  inFlightMuse?: boolean;
}

interface PendingAuthorizationRecord extends PendingAuthorizationView {
  onDecide: (allow: boolean) => Promise<{ ok: boolean; message: string }>;
}

const MAX_PENDING_AUTHORIZATIONS = 12;

export class AuthorizationHub {
  private readonly pending = new Map<string, PendingAuthorizationRecord>();
  private readonly listeners = new Set<(current: PendingAuthorizationView | null) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  private viewOf(rec: PendingAuthorizationRecord): PendingAuthorizationView {
    return {
      id: rec.id,
      kind: rec.kind,
      title: rec.title,
      detail: rec.detail,
      allowLabel: rec.allowLabel,
      denyLabel: rec.denyLabel,
      createdAt: rec.createdAt,
      createdTurn: rec.createdTurn,
      ...(rec.inFlightMuse ? { inFlightMuse: true } : {}),
    };
  }

  private notify(): void {
    const top = this.current();
    for (const listener of [...this.listeners]) {
      try {
        listener(top);
      } catch {
        /* listener errors never break authorization state */
      }
    }
  }

  subscribe(listener: (current: PendingAuthorizationView | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Newest pending request, which the active call card displays. */
  current(): PendingAuthorizationView | null {
    const all = this.list();
    return all[0] ?? null;
  }

  list(): PendingAuthorizationView[] {
    return [...this.pending.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((rec) => this.viewOf(rec));
  }

  get(id: string): PendingAuthorizationView | null {
    const rec = this.pending.get(id);
    return rec ? this.viewOf(rec) : null;
  }

  request(input: {
    id?: string;
    kind: AuthorizationKind;
    title: string;
    detail: string;
    allowLabel?: string;
    denyLabel?: string;
    createdTurn?: number;
    inFlightMuse?: boolean;
    onDecide: (allow: boolean) => Promise<{ ok: boolean; message: string }>;
  }): PendingAuthorizationView {
    const id = input.id ?? `auth_${randomBytes(6).toString("hex")}`;
    if (!this.pending.has(id) && this.pending.size >= MAX_PENDING_AUTHORIZATIONS) {
      const oldest = [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this.pending.delete(oldest.id);
    }
    const record: PendingAuthorizationRecord = {
      id,
      kind: input.kind,
      title: input.title.trim().slice(0, 160),
      detail: input.detail.trim().slice(0, 400),
      allowLabel: input.allowLabel ?? "Allow",
      denyLabel: input.denyLabel ?? "Deny",
      createdAt: this.now(),
      createdTurn: input.createdTurn ?? 0,
      ...(input.inFlightMuse ? { inFlightMuse: true } : {}),
      onDecide: input.onDecide,
    };
    this.pending.set(id, record);
    this.notify();
    return this.viewOf(record);
  }

  cancel(id: string): boolean {
    const deleted = this.pending.delete(id);
    if (deleted) this.notify();
    return deleted;
  }

  clear(): void {
    if (this.pending.size === 0) return;
    this.pending.clear();
    this.notify();
  }

  async decide(id: string, allow: boolean): Promise<{ ok: boolean; message: string }> {
    const rec = this.pending.get(id);
    if (!rec) return { ok: false, message: "That authorization request is no longer waiting." };
    this.pending.delete(id);
    this.notify();
    try {
      return await rec.onDecide(allow);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}

const DENY_PATTERNS: readonly RegExp[] = [
  /^(?:no|nope|nah|cancel|cancel it|stop|don'?t|do not|never|deny|decline|reject|not now|wait|hold on)\b/i,
  /\b(?:don'?t|do not)\s+(?:launch|run|start|open|allow|approve|do)\b/i,
  /^(?:n[aã]o|cancela|cancelar|para|pare|espera|agora n[aã]o|nega|recusa)\b/i,
  /\bn[aã]o\s+(?:abre|abra|roda|rode|inicia|inicie|autorizo|aprovo|faz|fa[cç]a)\b/i,
];

const ALLOW_PATTERNS: readonly RegExp[] = [
  /^(?:yes|yeah|yep|yup|sure|allow|allow it|approve|approve it|authorize|authorize it|authorized)\b/i,
  /^(?:go ahead|do it|just do it|proceed|continue)\b/i,
  /^(?:just\s+)?(?:launch|run|start|open)\s+(?:it|that|this|the\s+(?:server|app|page|project|localhost|local\s+host|site))\b/i,
  /^(?:yes[, ]+)?(?:please\s+)?(?:go ahead(?:\s+and)?\s+)?(?:launch|run|start|open|allow|approve)\b/i,
  /^(?:sim|claro|pode|pode\s+(?:abrir|rodar|iniciar|executar|fazer|ir|prosseguir)|autorizo|autorizado|aprovo|aprovado|vai\s+em\s+frente|manda\s+ver|roda\s+isso|abre\s+isso)\b/i,
];

const BACKCHANNEL_ONLY = /^(?:mm+-?hm+|uh-?huh|um+|uh+|ah+|oh+|hm+|ok|okay)$/i;

/**
 * Classifies a short user utterance directed at an already-displayed authorization prompt.
 * Conservative by design: questions, backchannels, long paragraphs and mixed negations never approve.
 */
export function parseUserAuthorizationIntent(raw: string): "allow" | "deny" | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > 140 || trimmed.includes("?")) return null;
  const clean = trimmed
    .replace(/^[,.;:!¡¿"'“”‘’()\-–—\s]+|[,.;:!¡¿"'“”‘’()\-–—\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean === "" || BACKCHANNEL_ONLY.test(clean)) return null;
  for (const deny of DENY_PATTERNS) {
    if (deny.test(clean)) return "deny";
  }
  for (const allow of ALLOW_PATTERNS) {
    if (allow.test(clean)) return "allow";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// LaunchManager

export type LaunchStatus = "starting" | "running" | "exited" | "failed" | "stopped";

export interface LaunchView {
  id: string;
  kind: "command" | "url" | "open";
  title: string;
  projectName: string | null;
  cwd: string | null;
  command: string | null;
  status: LaunchStatus;
  pid: number | null;
  urls: string[];
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  output: string;
}

export type LaunchSpec =
  | {
      kind: "command";
      command: string;
      cwd: string;
      projectName: string;
      background?: boolean;
      openInBrowser?: boolean;
      startupWaitMs?: number;
    }
  | {
      kind: "url";
      url: string;
      inAncillaBrowser?: boolean;
    }
  | {
      kind: "open";
      path: string;
      label: string;
      target: "files" | "editor";
    };

export interface PlannedSpawn {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface LaunchManagerDeps {
  planCommand: (cwd: string, command: string) => Promise<PlannedSpawn>;
  openPath?: (localPath: string, target: "files" | "editor") => Promise<void>;
  openSystemUrl?: (url: string) => Promise<void>;
  openAncillaBrowser?: (url: string) => Promise<{ url: string; title: string }>;
  /** Pre-grants a user-authorized localhost or explicit URL origin in Ancilla's Browser SiteGate. */
  grantOrigin?: (origin: string) => void;
  /** True when the user's standing posture (such as YOLO mode) pre-authorizes launching without a per-action prompt. */
  isPreAuthorized: () => boolean;
  authorizations: AuthorizationHub;
  now?: () => number;
  log?: (line: string) => void;
}

const MAX_LAUNCH_OUTPUT = 64 * 1024;
const MAX_LAUNCHES = 24;
const DEFAULT_BG_WAIT_MS = 3500;
const DEFAULT_FG_WAIT_MS = 15_000;
const STOP_GRACE_MS = 1500;
const KILL_SETTLE_MS = 500;
const SCRUBBED_ENV_KEYS = ["ANCILLA_TOKEN", "ANCILLA_AUTH", "ANCILLA_SECRET"] as const;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Extracts HTTP(S) URLs printed by dev servers, normalizing wildcard/loopback binds to http://localhost:<port>. */
export function extractListeningUrls(raw: string): string[] {
  const clean = stripAnsi(raw);
  const found: string[] = [];
  const add = (candidate: string): void => {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      const host = parsed.hostname.toLowerCase();
      if (host === "0.0.0.0" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "::") {
        const normalized = `${parsed.protocol}//localhost${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}${parsed.search}`;
        if (!found.includes(normalized)) found.push(normalized);
        return;
      }
      const href = parsed.href;
      if (!found.includes(href)) found.push(href);
    } catch {
      /* ignore malformed matches */
    }
  };

  const urlRe = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-zA-Z0-9.-]+)(?::\d{2,5})(?:\/[^\s"'<>)\],]*)?/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(clean)) !== null) {
    add(match[0].replace(/[.,;:]+$/, ""));
  }

  const portRe = /\b(?:listening\s+(?:on|at)|server\s+(?:running|started)\s+(?:on|at)|port)\s*:?\s*(\d{2,5})\b/gi;
  while ((match = portRe.exec(clean)) !== null) {
    const port = Number(match[1]);
    if (port >= 80 && port <= 65535) add(`http://localhost:${port}/`);
  }
  return found;
}

function cleanChildEnv(overlay?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(overlay ?? {}) };
  for (const key of SCRUBBED_ENV_KEYS) delete env[key];
  return env;
}

function defaultOpenSystemUrl(url: string, platform = process.platform): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd =
      platform === "win32"
        ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }
        : platform === "darwin"
          ? { file: "open", args: [url] }
          : { file: "xdg-open", args: [url] };
    const child = spawn(cmd.file, cmd.args, { stdio: "ignore", windowsHide: true, detached: platform !== "win32" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

interface ManagedLaunch extends LaunchView {
  child: ChildProcess | null;
  ownGroup: boolean;
  settled: Promise<void>;
   urlWaiters: Set<() => void>;
}

const activeProcessKillers = new Set<() => void>();
let exitHookRegistered = false;

function ensureExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => {
    for (const killNow of [...activeProcessKillers]) {
      try {
        killNow();
      } catch {
        /* exiting */
      }
    }
  });
}

export type LaunchRequestOutcome =
  | { status: "launched"; launch: LaunchView; browserPage?: { url: string; title: string } | null }
  | { status: "needs_authorization"; authorization: PendingAuthorizationView };

export class LaunchManager {
  private readonly launches = new Map<string, ManagedLaunch>();
  private closed = false;

  constructor(private readonly deps: LaunchManagerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private toView(item: ManagedLaunch): LaunchView {
    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      projectName: item.projectName,
      cwd: item.cwd,
      command: item.command,
      status: item.status,
      pid: item.pid,
      urls: [...item.urls],
      exitCode: item.exitCode,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      output: item.output,
    };
  }

  list(): LaunchView[] {
    return [...this.launches.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((item) => this.toView(item));
  }

  get(id: string): LaunchView | null {
    if (id === "last" || id === "latest") return this.list()[0] ?? null;
    const direct = this.launches.get(id);
    if (direct) return this.toView(direct);
    const matches = [...this.launches.values()].filter((l) => l.id.startsWith(id));
    return matches.length === 1 ? this.toView(matches[0]!) : null;
  }

  private describeSpec(spec: LaunchSpec): { title: string; detail: string } {
    switch (spec.kind) {
      case "command":
        return {
          title: `Run in ${spec.projectName}: ${spec.command.slice(0, 90)}`,
          detail: `${spec.command}${spec.openInBrowser ? " (and open in browser)" : ""}`,
        };
      case "url":
        return {
          title: `Open ${spec.url.slice(0, 90)}`,
          detail: spec.inAncillaBrowser ? `Open ${spec.url} in Ancilla's browser` : `Open ${spec.url} on your computer`,
        };
      case "open":
        return {
          title: `Open ${spec.label} in ${spec.target === "editor" ? "editor" : "files"}`,
          detail: spec.label,
        };
    }
  }

  /**
   * Executes `spec` immediately when standing authorization (such as YOLO) covers it; otherwise queues a pending
   * user authorization on the screen / active voice call card and waits for the user's explicit Allow.
   */
  async requestLaunch(spec: LaunchSpec, options: { turn?: number; forceAuthorized?: boolean } = {}): Promise<LaunchRequestOutcome> {
    if (this.closed) throw new Error("Ancilla is shutting down.");
    if (options.forceAuthorized === true || this.deps.isPreAuthorized()) {
      return await this.execute(spec);
    }
    const { title, detail } = this.describeSpec(spec);
    const authorization = this.deps.authorizations.request({
      kind: "launch",
      title,
      detail,
      allowLabel: "Launch",
      denyLabel: "Cancel",
      createdTurn: options.turn ?? 0,
      onDecide: async (allow) => {
        if (!allow) return { ok: true, message: `Cancelled: ${title}.` };
        const ran = await this.execute(spec);
        if (ran.status !== "launched") return { ok: false, message: "Could not start launch." };
        const urlPart = ran.launch.urls[0] ? ` Listening at ${ran.launch.urls[0]}.` : "";
        return { ok: true, message: `Launched ${ran.launch.title} (${ran.launch.status}).${urlPart}` };
      },
    });
    return { status: "needs_authorization", authorization };
  }

  private trimLaunches(): void {
    if (this.launches.size < MAX_LAUNCHES) return;
    const finished = [...this.launches.values()]
      .filter((l) => l.status !== "running" && l.status !== "starting")
      .sort((a, b) => a.startedAt - b.startedAt);
    if (finished[0]) {
      this.launches.delete(finished[0].id);
      return;
    }
    const oldest = [...this.launches.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) this.launches.delete(oldest.id);
  }

  private async execute(spec: LaunchSpec): Promise<Extract<LaunchRequestOutcome, { status: "launched" }>> {
    this.trimLaunches();
    const id = `ln_${randomBytes(4).toString("hex")}`;
    const startedAt = this.now();

    if (spec.kind === "url") {
      const checked = new URL(spec.url);
      if (checked.protocol !== "http:" && checked.protocol !== "https:") {
        throw new Error("Only http:// and https:// addresses can be opened.");
      }
      const origin = originOf(checked.href);
      if (origin) this.deps.grantOrigin?.(origin);
      let browserPage: { url: string; title: string } | null = null;
      if (spec.inAncillaBrowser && this.deps.openAncillaBrowser) {
        browserPage = await this.deps.openAncillaBrowser(checked.href);
      } else {
        await (this.deps.openSystemUrl ?? defaultOpenSystemUrl)(checked.href);
      }
      const entry: ManagedLaunch = {
        id,
        kind: "url",
        title: `Open ${checked.host}${checked.pathname}`,
        projectName: null,
        cwd: null,
        command: null,
        status: "exited",
        pid: null,
        urls: [checked.href],
        exitCode: 0,
        startedAt,
        endedAt: this.now(),
        output: browserPage ? `Opened ${browserPage.url} (${browserPage.title || "untitled"}) in Ancilla browser.` : `Opened ${checked.href}.`,
        child: null,
        ownGroup: false,
        settled: Promise.resolve(),
        urlWaiters: new Set(),
      };
      this.launches.set(id, entry);
      return { status: "launched", launch: this.toView(entry), browserPage };
    }

    if (spec.kind === "open") {
      if (!this.deps.openPath) throw new Error("Opening local folders or editors is not available on this host.");
      await this.deps.openPath(spec.path, spec.target);
      const entry: ManagedLaunch = {
        id,
        kind: "open",
        title: `Opened ${spec.label}`,
        projectName: null,
        cwd: spec.path,
        command: null,
        status: "exited",
        pid: null,
        urls: [],
        exitCode: 0,
        startedAt,
        endedAt: this.now(),
        output: `Opened ${spec.label} (${spec.target}).`,
        child: null,
        ownGroup: false,
        settled: Promise.resolve(),
        urlWaiters: new Set(),
      };
      this.launches.set(id, entry);
      return { status: "launched", launch: this.toView(entry), browserPage: null };
    }

    // Reuse an already-running identical command in the same folder instead of colliding on the same port.
    const existing = [...this.launches.values()].find(
      (l) => l.kind === "command" && (l.status === "running" || l.status === "starting") && l.cwd === spec.cwd && l.command === spec.command,
    );
    if (existing) {
      let browserPage: { url: string; title: string } | null = null;
      if (spec.openInBrowser && existing.urls[0] && this.deps.openAncillaBrowser) {
        const origin = originOf(existing.urls[0]);
        if (origin) this.deps.grantOrigin?.(origin);
        browserPage = await this.deps.openAncillaBrowser(existing.urls[0]).catch(() => null);
      }
      return { status: "launched", launch: this.toView(existing), browserPage };
    }

    const planned = await this.deps.planCommand(spec.cwd, spec.command);
    if (this.closed) throw new Error("Ancilla is shutting down.");

    const ownGroup = process.platform !== "win32";
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });

    const child = spawn(planned.command, planned.args, {
      ...(planned.cwd ? { cwd: planned.cwd } : {}),
      env: cleanChildEnv(planned.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(ownGroup ? { detached: true } : {}),
    });

    const entry: ManagedLaunch = {
      id,
      kind: "command",
      title: `${spec.projectName}: ${spec.command.slice(0, 80)}`,
      projectName: spec.projectName,
      cwd: spec.cwd,
      command: spec.command,
      status: child.pid ? "running" : "starting",
      pid: child.pid ?? null,
      urls: [],
      exitCode: null,
      startedAt,
      endedAt: null,
      output: "",
      child,
      ownGroup,
      settled,
      urlWaiters: new Set(),
    };
    this.launches.set(id, entry);

    const forceKill = (): void => {
      if (!entry.child || entry.endedAt !== null) return;
      this.signalEntry(entry, "SIGKILL");
    };
    activeProcessKillers.add(forceKill);
    ensureExitHook();

    const appendOutput = (chunk: Buffer): void => {
      const text = stripAnsi(chunk.toString("utf8")).replace(/\r\n/g, "\n");
      entry.output += text;
      if (entry.output.length > MAX_LAUNCH_OUTPUT) {
        entry.output = entry.output.slice(-MAX_LAUNCH_OUTPUT);
      }
      for (const url of extractListeningUrls(entry.output)) {
        if (!entry.urls.includes(url)) {
          entry.urls.push(url);
          const origin = originOf(url);
          if (origin) this.deps.grantOrigin?.(origin);
          for (const wake of [...entry.urlWaiters]) wake();
        }
      }
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    const finalize = (code: number | null, errText?: string): void => {
      if (entry.endedAt !== null) return;
      activeProcessKillers.delete(forceKill);
      if (errText) {
        entry.output = `${entry.output}\n${errText}`.trim().slice(-MAX_LAUNCH_OUTPUT);
      }
      entry.exitCode = code;
      entry.endedAt = this.now();
      if (entry.status !== "stopped") {
        entry.status = code === 0 ? "exited" : "failed";
      }
      entry.child = null;
      for (const wake of [...entry.urlWaiters]) wake();
      entry.urlWaiters.clear();
      resolveSettled();
    };

    child.once("spawn", () => {
      if (entry.endedAt === null) {
        entry.status = "running";
        entry.pid = child.pid ?? null;
      }
    });
    child.once("error", (err) => finalize(null, err.message));
    child.once("close", (code) => finalize(code));

    const background = spec.background ?? isLikelyServerCommand(spec.command);
    const waitBudgetMs = Math.min(30_000, Math.max(250, spec.startupWaitMs ?? (background ? DEFAULT_BG_WAIT_MS : DEFAULT_FG_WAIT_MS)));

    await this.waitStartup(entry, waitBudgetMs, background);

    if (entry.urls[0]) {
      await probeHttpReady(entry.urls[0], 1500);
    }

    let browserPage: { url: string; title: string } | null = null;
    if (spec.openInBrowser && entry.urls[0] && this.deps.openAncillaBrowser) {
      const origin = originOf(entry.urls[0]);
      if (origin) this.deps.grantOrigin?.(origin);
      browserPage = await this.deps.openAncillaBrowser(entry.urls[0]).catch((error) => {
        this.deps.log?.(`launcher: opening ${entry.urls[0]} in browser failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    }

    return { status: "launched", launch: this.toView(entry), browserPage };
  }

  private async waitStartup(entry: ManagedLaunch, budgetMs: number, stopOnUrl: boolean): Promise<void> {
    if (entry.endedAt !== null || (stopOnUrl && entry.urls.length > 0)) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, budgetMs);
      timer.unref?.();
      function done(): void {
        clearTimeout(timer);
        entry.urlWaiters.delete(onProgress);
        resolve();
      }
      function onProgress(): void {
        if (entry.endedAt !== null || (stopOnUrl && entry.urls.length > 0)) done();
      }
      entry.urlWaiters.add(onProgress);
      void entry.settled.then(done);
    });
  }

  private signalEntry(entry: ManagedLaunch, signal: NodeJS.Signals): void {
    const child = entry.child;
    if (!child) return;
    if (process.platform === "win32" && child.pid !== undefined) {
      try {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => undefined);
        killer.unref();
        return;
      } catch {
        /* fall back to child.kill */
      }
    }
    if (entry.ownGroup && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        /* group may already be gone */
      }
    }
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }

  async stop(id: string): Promise<LaunchView | null> {
    const view = this.get(id);
    if (!view) return null;
    const entry = this.launches.get(view.id);
    if (!entry) return null;
    if (entry.endedAt !== null) return this.toView(entry);
    entry.status = "stopped";
    this.signalEntry(entry, "SIGTERM");
    if (!(await settledWithin(entry.settled, STOP_GRACE_MS))) {
      this.signalEntry(entry, "SIGKILL");
      await settledWithin(entry.settled, KILL_SETTLE_MS);
    }
    return this.toView(entry);
  }

  async stopAll(options: { graceMs?: number; settleMs?: number } = {}): Promise<void> {
    this.closed = true;
    const running = [...this.launches.values()].filter((l) => l.endedAt === null);
    if (running.length === 0) return;
    for (const entry of running) {
      entry.status = "stopped";
      this.signalEntry(entry, "SIGTERM");
    }
    const allSettled = Promise.all(running.map((entry) => entry.settled));
    if (await settledWithin(allSettled, options.graceMs ?? STOP_GRACE_MS)) return;
    for (const entry of running) {
      if (entry.endedAt === null) this.signalEntry(entry, "SIGKILL");
    }
    await settledWithin(allSettled, options.settleMs ?? KILL_SETTLE_MS);
  }
}

export function isLikelyServerCommand(command: string): boolean {
  return /\b(?:dev|serve|start|preview|watch|http\.server|vite|next\s+dev|astro\s+dev|nuxt\s+dev|wrangler\s+dev|uvicorn|flask\s+run|manage\.py\s+runserver|cargo\s+run|air)\b/i.test(
    command,
  );
}

async function probeHttpReady(url: string, budgetMs: number): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(350) });
      await res.body?.cancel().catch(() => undefined);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  return false;
}
