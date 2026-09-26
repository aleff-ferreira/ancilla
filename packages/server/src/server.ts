import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize, posix, resolve, sep, win32 } from "node:path";
import type { Readable } from "node:stream";
import {
  AncillaMspHost,
  AncillaStore,
  SessionManager,
  isApprovalMode,
  isGoalAction,
  isIfBusy,
  isReasoningEffort,
  isSubagentAction,
  isWorkflowChildAction,
  parseSubscriptionUsage,
  nativeReleaseInfo,
  parseRuntimePreference,
  planHostCommand,
  refreshNativeMuse,
  type MuseRuntime,
  type NativeMuse,
  type RuntimePreference,
  planMuseCli,
  planServe,
  probeEnvironment,
  resolveMuseInDistro,
  defaultExec,
  FALLBACK_DISTRO,
  toWslPath,
  toWindowsPath,
  ProjectFolderError,
  type ApprovalMode,
  type AttachmentRecord,
  type CommandConnection,
  type ExecFn,
  type Project,
  type ServeTarget,
  type ReasoningEffort,
  type SessionRecord,
  type SessionSkill,
  type SubscriptionUsage,
  type TurnImage,
} from "@ancilla/daemon";
import { FileError, listFolder, readProjectFile, resolveInRoot, searchProjectFiles, serveProjectFile, writeProjectFile } from "./files.js";
import { DB_FILE, envSetting, importLegacyDatabase } from "./legacy.js";
import { PathError, createDirectory, listDirectory, resolveUserPath, type PathContext } from "./paths.js";
import { wslSpawnEnv } from "./runtimeConfig.js";
import { buildThreadTitlePrompt, deriveTitle, parseExecTitle, sanitizeThreadTitle } from "./threadTitles.js";
import { AoniaError, createAonia, parseLoginOutput, type Aonia, type Profile } from "@harjjotsinghh/aonia";

export const ANCILLA_VERSION = "0.18.0";

export interface HostExit {
  code: number | null;
  signal: string | null;
}

/** What a session's live notification feed has done, for answering "did it go quiet, or was it idle?". */
export interface SessionNotifyStats {
  /** Epoch milliseconds of the last notification routed to this session. */
  lastAt: number;
  count: number;
  byMethod: Record<string, number>;
}

/** How many sessions keep notification stats. Oldest are dropped first; this is a debugging aid. */
const NOTIFY_STATS_LIMIT = 200;

export interface HostHandle {
  start(version: string): Promise<unknown>;
  connection: CommandConnection;
  close(): Promise<unknown>;
  onExit?(handler: (exit: HostExit) => void): void;
  readonly recentStderr?: string;
}

export type HostFactory = (target: ServeTarget) => HostHandle;

export type OpenTarget = "files" | "editor";
export type Opener = (path: string, target: OpenTarget) => Promise<void>;

const realHostFactory: HostFactory = (target) => new AncillaMspHost(target);

/** The shape of a spawned `muse login` child the route needs: readable output and a way to kill it. */
export interface LoginChild {
  stdout: Readable;
  stderr: Readable;
  on(event: "close" | "error", listener: (arg: unknown) => void): void;
  kill(): void;
}

/** Spawns `muse login` for a profile. `env` is the profile's overlay; the real impl spreads it over `process.env`. */
export type LoginSpawn = (command: string, args: string[], opts: { env: Record<string, string> }) => LoginChild;

const defaultLoginSpawn: LoginSpawn = (command, args, opts) =>
  spawn(command, args, {
    cwd: homedir(),
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as unknown as LoginChild;

/** Runs a `!` command where the workspace is, and hands back what it printed. */
export type ShellRunner = (
  command: string,
  args: string[],
) => Promise<{ output: string; exitCode: number | null; truncated: boolean }>;

export interface ServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  staticDir?: string | null;
  token?: string | null;
  /** Browser origins allowed to reach this daemon from another site. Empty means same-origin only. */
  allowOrigins?: string[];
  platform?: string;
  distro?: string;
  musePath?: string | null;
  /** Named Muse profiles. Defaults to a real aonia over ~/.aonia; injected in tests. */
  aonia?: Aonia;
  /** On Windows: `native` runs Windows Muse, `wsl` runs Muse in WSL, `auto` (the default) prefers native once installed. */
  runtime?: RuntimePreference;
  /**
   * Share thread titles with Muse through `session/rename`, and take the names Muse picks. Off unless set to true:
   * Muse 1.4.0 can record a rename so that the session's later workflows fail to load (`missing field kind`).
   */
  syncSessionNames?: boolean;
  /** Windows only: environment variables for Muse inside WSL. Only processes started through `wsl.exe` get them. */
  wslEnv?: Record<string, string>;
  /** Finds native Windows Muse; the real install folders by default. */
  findNativeMuse?: () => NativeMuse | null;
  hostFactory?: HostFactory;
  opener?: Opener;
  /** Where `~` points in typed paths; the OS home by default. */
  home?: string;
  /** Days without activity before a thread settles on its own; null turns auto-settle off. */
  autoSettleDays?: number | null;
  /** Runs `muse` CLI calls, like listing skills; the real process runner by default. */
  exec?: ExecFn;
  /** Runs the user's own `!` commands; spawns a real process by default. */
  shellRunner?: ShellRunner;
  /** Spawns `muse login` for the device-code route; a thin wrapper over `node:child_process` spawn by default. */
  loginSpawn?: LoginSpawn;
}

interface ManagedHost {
  key: string;
  accountId: string | null;
  target: ServeTarget;
  handle: HostHandle;
  manager: SessionManager;
  serverVersion: string | null;
  startedAt: string;
}

/** What the server knows about a session's live run, derived from the MSP view stream. */
/** A session's goal block, kept so the sidebar can show goals in threads the UI has not opened. */
export interface GoalBlock {
  objective: string;
  status: string;
  percentComplete: number;
  currentWork?: string;
  nextWork?: string;
}

interface LiveState {
  activeTurnId: string | null;
  turnStartedAt: string | null;
  /**
   * The host whose own feed, reply or read showed the active turn running there. Null when only a session listing
   * said so, which cannot tell this server's hosts from another Muse client.
   */
  turnHost: string | null;
  pendingApprovals: Set<string>;
  pendingInputs: Set<string>;
  lastTerminal: string | null;
  lastError: string | null;
  goal: GoalBlock | null;
  /** Bumped on every live goal change, so a slow transcript load never writes an older goal over a newer one. */
  goalSeq: number;
  /** The view cursor of the goal held, so a stale history prefix cannot put an older goal back. */
  goalCursor: string | null;
  /**
   * Bumped by anything newer than a read in flight: live lifecycle and request changes, current-turn progress, view
   * health, a host going away, the session closing, a listing that shows it running. A load that sees it move applies
   * nothing it read.
   */
  activityRevision: number;
  viewHealth: { status: string; reason: string | null } | null;
  /** Why another Muse client was last found holding the session; null once it loaded, or read as loaded, here. */
  readOnlyReason: string | null;
  /**
   * Terminal records history held for a turn while a fresh read said that turn was still running: the stand-ins
   * Muse's projection writes for an open run. A stale prefix that still carries one says nothing about the outcome.
   */
  provisional: Set<string>;
}

/** An account's Muse folders, crossed into WSL as Linux paths (`p`) and for WSL processes only (`u`). */
const PROFILE_WSLENV = ["XDG_CONFIG_HOME/pu", "XDG_DATA_HOME/pu"];

/** Stand-in terminal records kept per session; enough for the runs a stalled projection can be behind by. */
const PROVISIONAL_LIMIT = 64;

/** Whether view cursor `a` comes after `b`. Only the v:<session>:<sequence> form has an order. */
function cursorAfter(a: string | null, b: string | null): boolean {
  const after = a?.match(/^(v:.+):(\d+)$/);
  const before = b?.match(/^(v:.+):(\d+)$/);
  return Boolean(after && before && after[1] === before[1] && BigInt(after[2]!) > BigInt(before[2]!));
}

/**
 * How Muse 1.4.0 fails once a `session/rename` record has broken a session's workflow event log: the rename itself,
 * or a later workflow's admission, reports that the log's records no longer decode.
 */
const RENAME_DECODE_FAILURE = /payload decode failed: missing field kind/i;

export interface LiveView {
  activeTurnId: string | null;
  turnStartedAt: string | null;
  pendingApprovals: number;
  pendingInputs: number;
  lastTerminal: string | null;
  lastError: string | null;
  goal: GoalBlock | null;
  viewHealth?: { status: string; reason: string | null } | null;
}

/** A `session/goalChanged` goal: null clears it; undefined means the block is not a goal (no objective). */
function goalOf(value: unknown): GoalBlock | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  const objective = record ? str(record["objective"]) : null;
  if (!record || !objective) {
    return undefined;
  }
  const currentWork = str(record["currentWork"]);
  const nextWork = str(record["nextWork"]);
  return {
    objective,
    status: str(record["status"]) ?? "active",
    percentComplete: num(record["percentComplete"]) ?? 0,
    ...(currentWork ? { currentWork } : {}),
    ...(nextWork ? { nextWork } : {}),
  };
}

type SseSink = (event: string, data: unknown) => void;

const MAX_HISTORY_PAGES = 4;
const HISTORY_PAGE_SIZE = 1000;
const DISCOVER_LIMIT = 200;
/** Echo-titled threads one discovery may hand to the titler. Each is a model call on the user's plan, so it is a
 * handful of recent threads rather than a whole history. */
const TITLE_BACKFILL_LIMIT = 30;
const ENV_CACHE_MS = 30_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const AUTO_SETTLE_SWEEP_MS = 60_000;
const LOGIN_TIMEOUT_MS = 30_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const found = str(record[key]);
    if (found) {
      return found;
    }
  }
  return null;
}

function isWindowsAbs(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function isWslAbs(path: string): boolean {
  return path.startsWith("/");
}

function nowIso(): string {
  return new Date().toISOString();
}

function lastLines(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ");
}

/** Runs a command to completion; rejects with the tail of its stderr. */
/** Output kept from a `!` command Ancilla runs itself, and how long it may run. */
const MAX_SHELL_OUTPUT = 64 * 1024;
const SHELL_TIMEOUT_MS = 2 * 60_000;

/** Runs a program and keeps what it printed, both streams together, as a terminal would show it. */
function runCapture(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
): Promise<{ output: string; exitCode: number | null; truncated: boolean }> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let truncated = false;
    const take = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_SHELL_OUTPUT) {
        output = output.slice(-MAX_SHELL_OUTPUT);
        truncated = true;
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => {
      truncated = true;
      output += "\n[stopped: the command ran longer than two minutes]";
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ output: `${output}\n${error.message}`.trim(), exitCode: null, truncated });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ output, exitCode: code, truncated });
    });
  });
}

function runProcess(command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      // Fail fast on a private repository instead of waiting for a password nobody can type.
      env: env ?? {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        WSLENV: [process.env["WSLENV"], "GIT_TERMINAL_PROMPT/u"].filter(Boolean).join(":"),
      },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill();
      fail(new HttpError(504, "The clone took too long and was stopped."));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(new HttpError(500, `Could not run ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        done();
      } else {
        fail(new HttpError(500, lastLines(stderr) || `${command} exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

/** MSP timestamps carry microseconds; store them in JS ISO form so they sort as strings. */
export function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function normalizeCwd(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z]:[\\/]?$/.test(trimmed) || trimmed === "/") {
    return trimmed;
  }
  return trimmed.replace(/[\\/]+$/, "");
}

/** A name safe to write into a workspace: the base name only, and nothing that needs quoting. */
export function safeFileName(raw: string | null): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 80);
  return clean.length > 0 ? clean : "file";
}

export { deriveTitle };

function errorInfo(error: unknown): { status: number; message: string; kind: string | null } {
  if (error instanceof HttpError) {
    return { status: error.status, message: error.message, kind: null };
  }
  const kind = typeof (error as { kind?: unknown })?.kind === "string" ? ((error as { kind: string }).kind) : null;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PathError || error instanceof ProjectFolderError) {
    return { status: 400, message, kind: null };
  }
  if (error instanceof FileError) {
    return { status: error.status, message, kind: error.kind };
  }
  if (error instanceof SyntaxError) {
    return { status: 400, message: "Request body is not valid JSON.", kind: null };
  }
  if (kind === "sessionNotFound" || kind === "notFound" || kind === "approvalNotFound" || kind === "userInputNotFound") {
    return { status: 404, message, kind };
  }
  if (kind) {
    return { status: 409, message, kind };
  }
  return { status: 500, message, kind: null };
}

function stripSource(params: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...params };
  delete rest["sourceRange"];
  return rest;
}

function stripEvent(event: unknown): { method: string; params: Record<string, unknown> } | null {
  const record = asRecord(event);
  const method = record ? str(record["method"]) : null;
  const params = record ? asRecord(record["params"]) : null;
  if (!method || !params) {
    return null;
  }
  return { method, params: stripSource(params) };
}

function asHistoryItem(value: unknown): Record<string, unknown> | null {
  const item = asRecord(value);
  return item && typeof item["itemId"] === "string" ? item : null;
}

/** Folded items from `session/read`, which works even when another host holds the session. */
export function eventsFromHistory(payload: unknown): { method: string; params: Record<string, unknown> }[] {
  const record = asRecord(payload);
  if (!record) {
    return [];
  }
  const history = asRecord(record["history"]) ?? record;
  const fromInline = Array.isArray(history["items"]) ? history["items"] : [];
  const snapshot = asRecord(history["snapshot"]);
  const state = asRecord(snapshot?.["state"]);
  const fromSnapshot = Array.isArray(state?.["items"]) ? state["items"] : [];
  const bag = asRecord(state?.["items"]);
  const order = Array.isArray(state?.["order"]) ? state["order"] : bag ? Object.keys(bag) : [];
  const fromBag = bag ? order.map((id) => bag[String(id)]) : [];
  const items = [...fromInline, ...fromSnapshot, ...fromBag].map(asHistoryItem).filter((item): item is Record<string, unknown> => item !== null);
  const seen = new Set<string>();
  const events: { method: string; params: Record<string, unknown> }[] = [];
  for (const item of items) {
    const id = String(item["itemId"]);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    events.push({ method: "item/completed", params: { item: stripSource(item) } });
  }
  return events;
}

/** A live MSP notification reshaped for the browser: session-scoped, provenance stripped. */
export function toWireEvent(
  method: string,
  params: Record<string, unknown>,
  at?: number,
): { type: "msp"; sessionId: string; method: string; params: Record<string, unknown>; at: number } | null {
  const session = asRecord(params["session"]);
  const sessionId = str(params["sessionId"]) ?? (session ? str(session["sessionId"]) : null);
  if (!sessionId) {
    return null;
  }
  return { type: "msp", sessionId, method, params: stripSource(params), at: at ?? Date.now() };
}

const CMD_UNSAFE = /[&|<>^%!"\r\n]/;

export function defaultOpener(platform: string): Opener {
  return (path, target) =>
    new Promise<void>((resolveOpen, rejectOpen) => {
      let command: string;
      let args: string[];
      if (platform === "win32") {
        if (CMD_UNSAFE.test(path)) {
          rejectOpen(new HttpError(400, "That folder path contains characters Ancilla will not pass to the shell."));
          return;
        }
        [command, args] = target === "editor" ? ["cmd.exe", ["/d", "/c", "code", path]] : ["explorer.exe", [path]];
      } else if (platform === "darwin") {
        [command, args] = target === "editor" ? ["code", [path]] : ["open", [path]];
      } else {
        [command, args] = target === "editor" ? ["code", [path]] : ["xdg-open", [path]];
      }
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", (error) =>
        rejectOpen(
          new HttpError(
            500,
            target === "editor"
              ? `Could not launch VS Code (${error.message}). Make sure the \`code\` command is on your PATH.`
              : `Could not open the folder (${error.message}).`,
          ),
        ),
      );
      child.once("spawn", () => {
        child.unref();
        resolveOpen();
      });
    });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

interface EnvView {
  platform: string;
  runtime: MuseRuntime;
  wslAvailable: boolean;
  defaultDistro: string | null;
  museFound: boolean;
  musePath: string | null;
  version: string;
  persistent: boolean;
}

export interface SkillView {
  id: string;
  name: string;
  displayName: string;
  description: string;
  shortDescription: string | null;
  scope: string;
  activation: string;
  /** What the skill expects after its name, when it says. */
  argumentHint?: string | null;
}

/**
 * The skills Muse reports for a loaded session, joined to the CLI listing. The session's list is the truth about
 * what can be invoked there; the CLI listing is still where each skill's file lives, so the join keeps its id.
 * Bundled skills list as `bundled:<name>` in the CLI and plugin skills as `plugin:<selector>`.
 */
export function mergeSessionSkills(rows: readonly SessionSkill[], cli: readonly SkillView[]): SkillView[] {
  const byKey = new Map<string, SkillView>();
  for (const skill of cli) {
    byKey.set(skill.id, skill);
    if (!byKey.has(skill.name)) {
      byKey.set(skill.name, skill);
    }
  }
  return rows.map((row) => {
    const match = byKey.get(row.selector) ?? byKey.get(`plugin:${row.selector}`) ?? null;
    return {
      id: match?.id ?? row.selector,
      name: row.selector,
      displayName: row.displayName,
      description: row.description || match?.description || "",
      shortDescription: match?.shortDescription ?? null,
      scope: match?.scope ?? row.source,
      activation: match?.activation ?? "on",
      argumentHint: row.argumentHint,
    };
  });
}

/** One workspace's skills. Where each SKILL.md lives stays on the server; the browser only names skills by id. */
interface SkillListing {
  at: number;
  skills: SkillView[];
  paths: Map<string, string>;
  error: string | null;
}

/** Parses `muse skills list --json`, leaving out skills switched off. Null when the output is not that JSON. */
export function parseSkillList(stdout: string): { skills: SkillView[]; paths: Map<string, string> } | null {
  let root: Record<string, unknown> | null;
  try {
    root = asRecord(JSON.parse(stdout));
  } catch {
    return null;
  }
  if (!root || !Array.isArray(root["skills"])) {
    return null;
  }
  const skills: SkillView[] = [];
  const paths = new Map<string, string>();
  for (const entry of root["skills"]) {
    const r = asRecord(entry);
    const id = r ? str(r["id"]) : null;
    if (!r || !id || str(r["activation"]) === "off") {
      continue;
    }
    const name = str(r["name"]) ?? id;
    skills.push({
      id,
      name,
      displayName: str(r["display_name"]) ?? name,
      description: str(r["description"]) ?? "",
      shortDescription: str(r["short_description"]),
      scope: str(r["scope"]) ?? "unknown",
      activation: str(r["activation"]) ?? "on",
    });
    const path = str(r["path"]);
    if (path) {
      paths.set(id, path);
    }
  }
  return { skills, paths };
}

/** A SKILL.md body without its YAML frontmatter. */
export function stripFrontmatter(text: string): string {
  return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "").trim();
}

const SKILL_CACHE_MS = 60_000;

/** One page of a tool's stored output; Muse serves at most 6 MiB a request, and a browser needs far less at once. */
const OUTPUT_PAGE_BYTES = 1024 * 1024;

/** Attachment limits: enough for a screenshot or a PDF, not enough to wedge the host. */
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_BODY_BYTES = 96 * 1024 * 1024;
/**
 * Where a non-image attachment lands inside the workspace, so Muse's own tools can open it. Prompts sent from Helicon
 * mention `.helicon/attachments` instead; nothing here parses either path, and those files are left where they are.
 */
const ATTACHMENT_DIR = [".ancilla", "attachments"];

interface PreparedAttachment {
  name: string;
  mediaType: string;
  kind: "image" | "file";
  width: number | null;
  height: number | null;
  bytes: Buffer;
}

export class AncillaServer {
  private readonly server: Server;
  private readonly store: AncillaStore;
  private readonly aonia: Aonia;
  private readonly hosts = new Map<string, ManagedHost>();
  private readonly starting = new Map<string, Promise<ManagedHost>>();
  /** Restarts queued by a settings flip, oldest first. Hosts are only acquired past the tail. */
  private restartChain: Promise<void> = Promise.resolve();
  private readonly fingerprints = new Map<string, unknown>();
  private readonly sinks = new Set<SseSink>();
  private readonly live = new Map<string, LiveState>();
  private readonly sessionHosts = new Map<string, string>();
  private readonly opener: Opener;
  private readonly titleQueue: string[] = [];
  private titleWorker: Promise<void> | null = null;
  /** Echo-titled sessions still owed one LLM title attempt; user-named and Muse-named threads never land here. */
  private readonly titleUpgradePending = new Set<string>();
  /** Upgrades with a model call in flight, so discovery cannot queue a second one for the same thread. */
  private readonly titleUpgradeActive = new Set<string>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setInterval> | null = null;
  private envCache: { at: number; value: EnvView } | null = null;
  private readonly skillCache = new Map<string, SkillListing>();
  /** The newest subscription window any host reported; `usage/changed` carries no session, so it lives here. */
  private planUsage: SubscriptionUsage | null = null;
  /** The newest window per account, keyed by aonia profile id. The default login is not keyed here. */
  private readonly planUsageByAccount = new Map<string, SubscriptionUsage>();
  /** The reasoning effort each session is known to be running at, so a turn only re-sets it when it changes. */
  private readonly effortApplied = new Map<string, ReasoningEffort>();
  private lastHostError: string | null = null;
  /**
   * Per-session notification health. #42 reported live notifications stopping mid-session while the
   * durable log completed and sibling sessions kept flowing; nothing here could tell that apart from
   * a backend that simply had nothing to say. Bounded to the most recently seen sessions.
   */
  private readonly notifyStats = new Map<string, SessionNotifyStats>();
  private protocolErrors = 0;
  private lastProtocolError: string | null = null;
  private forwardFailures = 0;
  private lastForwardFailure: string | null = null;
  /** Notifications that carried no sessionId, so nothing could be routed from them. */
  private unroutedByMethod = new Map<string, number>();
  /** Where Muse runs, once known; see `museRuntime`. */
  private runtimeKnown: MuseRuntime | null = null;
  /** The WSL distro the environment probe found Muse in, when none was configured; see `wslDistro`. */
  private distroKnown: string | null = null;
  /** Hosts whose Muse reported the rename-broken event log; no title is sent to them again. */
  private readonly renameRefused = new Set<string>();
  private closed = false;
  private readonly options: Required<
    Omit<
      ServerOptions,
      | "staticDir"
      | "token"
      | "platform"
      | "distro"
      | "musePath"
      | "hostFactory"
      | "opener"
      | "exec"
      | "findNativeMuse"
      | "aonia"
      | "loginSpawn"
    >
  > &
    Pick<ServerOptions, "staticDir" | "token" | "findNativeMuse"> & {
      platform: string;
      distro?: string;
      musePath?: string | null;
      hostFactory: HostFactory;
      exec: ExecFn;
      loginSpawn: LoginSpawn;
    };
  /** `muse login` children in flight, keyed by account id; a reopened modal kills and replaces the old one. */
  private readonly loginChildren = new Map<string, LoginChild>();

  constructor(options: ServerOptions = {}) {
    this.options = {
      port: options.port ?? 3127,
      host: options.host ?? "127.0.0.1",
      dataDir: options.dataDir ?? ":memory:",
      staticDir: options.staticDir ? resolve(options.staticDir) : null,
      token: options.token ?? null,
      allowOrigins: options.allowOrigins ?? [],
      platform: options.platform ?? process.platform,
      distro: options.distro,
      musePath: options.musePath,
      runtime: options.runtime ?? parseRuntimePreference(envSetting("MUSE_RUNTIME")),
      // Titles stay local unless sharing them was asked for in so many words; see `ServerOptions`.
      syncSessionNames: options.syncSessionNames === true,
      wslEnv: { ...(options.wslEnv ?? {}) },
      findNativeMuse: options.findNativeMuse,
      hostFactory: options.hostFactory ?? realHostFactory,
      home: options.home ?? homedir(),
      autoSettleDays: options.autoSettleDays === undefined ? 3 : options.autoSettleDays,
      exec: options.exec ?? defaultExec,
      shellRunner: options.shellRunner ?? ((command, args) => runCapture(command, args, undefined, SHELL_TIMEOUT_MS)),
      loginSpawn: options.loginSpawn ?? defaultLoginSpawn,
    };
    this.opener = options.opener ?? defaultOpener(this.options.platform);
    // A data dir with no database yet starts from Helicon's, when there is one; this never fails the start.
    importLegacyDatabase(this.options.dataDir, this.options.home, (message) => this.log(message));
    this.store = new AncillaStore(
      this.options.dataDir === ":memory:" ? ":memory:" : join(this.options.dataDir, DB_FILE),
    );
    this.aonia = options.aonia ?? createAonia(this.options.musePath ? { musePath: this.options.musePath } : {});
    this.server = createServer((req, res) => {
      void this.route(req, res).catch((error) => this.fail(res, 500, String(error)));
    });
  }

  async listen(): Promise<{ port: number; host: string }> {
    await new Promise<void>((resolve) => this.server.listen(this.options.port, this.options.host, resolve));
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    // No sweep at startup: which threads are busy in other Muse clients is only known after discovery.
    this.settleTimer = setInterval(() => this.autoSettle(), AUTO_SETTLE_SWEEP_MS);
    this.settleTimer.unref?.();
    return { port, host: this.options.host };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    if (this.settleTimer) {
      clearInterval(this.settleTimer);
      this.settleTimer = null;
    }
    this.titleQueue.length = 0;
    for (const sink of [...this.sinks]) {
      this.sinks.delete(sink);
    }
    for (const pending of this.starting.values()) {
      await pending.catch(() => undefined);
    }
    for (const managed of this.hosts.values()) {
      try {
        await managed.handle.close();
      } catch {
        /* best effort */
      }
    }
    this.hosts.clear();
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
    await this.titleWorker?.catch(() => undefined);
    this.store.close();
  }

  private emit(type: string, data: unknown): void {
    for (const sink of this.sinks) {
      try {
        sink(type, data);
      } catch {
        /* drop broken sinks on next write */
      }
    }
  }

  /** Coalesce bursts (discovery, title backfill) into one sidebar refresh. */
  private sessionsChanged(): void {
    if (this.changeTimer || this.closed) {
      return;
    }
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit("ancilla", { type: "sessions-changed" });
    }, 120);
  }

  /** What the event stream authenticates with, since EventSource cannot be given a header. */
  private static readonly AUTH_COOKIE = "ancilla_token";
  /** Helicon's name for it: a browser still holding one for the same token needs no new handshake. Never set. */
  private static readonly LEGACY_AUTH_COOKIE = "helicon_token";

  /**
   * The origin of a request that came from a different site. A browser sends `Origin` on its own
   * writes too, so comparing against `Host` is what separates "another site" from "this one".
   */
  private foreignOrigin(req: IncomingMessage): string | null {
    const origin = req.headers["origin"];
    if (typeof origin !== "string" || !origin) {
      return null;
    }
    const host = typeof req.headers["host"] === "string" ? req.headers["host"] : "";
    if (host && (origin === `http://${host}` || origin === `https://${host}`)) {
      return null;
    }
    return origin;
  }

  private cookie(req: IncomingMessage, name: string): string | null {
    const raw = req.headers["cookie"];
    if (typeof raw !== "string") {
      return null;
    }
    for (const part of raw.split(";")) {
      const [key, ...rest] = part.trim().split("=");
      if (key === name) {
        return decodeURIComponent(rest.join("="));
      }
    }
    return null;
  }

  /**
   * Cross-origin access is opt-in and fails closed: an origin nobody listed gets no CORS headers and
   * no answer at all. Same-origin requests carry no foreign origin and are left exactly as they were.
   */
  private cors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = this.foreignOrigin(req);
    if (!origin) {
      return true;
    }
    if (!this.options.allowOrigins.includes(origin)) {
      return false;
    }
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-headers", "authorization, content-type, range");
    res.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    return true;
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.options.token) {
      return true;
    }
    if (
      this.cookie(req, AncillaServer.AUTH_COOKIE) === this.options.token ||
      this.cookie(req, AncillaServer.LEGACY_AUTH_COOKIE) === this.options.token
    ) {
      return true;
    }
    if (req.headers["authorization"] === `Bearer ${this.options.token}`) {
      return true;
    }
    // A token in the URL leaks through history, server logs and any shared link, so it counts only
    // for requests carrying no foreign origin: curl, the desktop shell, the page served from here.
    if (this.foreignOrigin(req)) {
      return false;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("token") === this.options.token;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  }

  private fail(res: ServerResponse, status: number, message: string, kind: string | null = null): void {
    if (!res.headersSent) {
      this.json(res, status, { error: message, kind });
    } else {
      res.end();
    }
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        throw new HttpError(413, "That request is too large.");
      }
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) {
      return {};
    }
    return asRecord(JSON.parse(text) as unknown) ?? {};
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    if (!this.cors(req, res)) {
      this.fail(res, 403, "This daemon does not answer that origin.");
      return;
    }
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    // The handshake is how a browser earns its cookie, so it cannot itself demand one.
    if (!(method === "POST" && path === "/api/auth") && !this.authorized(req)) {
      this.fail(res, 401, "Missing or invalid token.");
      return;
    }
    if (path.startsWith("/api/")) {
      try {
        const handled = await this.api(method, path, url, req, res);
        if (!handled) {
          this.fail(res, 404, "Not found.");
        }
      } catch (error) {
        const info = errorInfo(error);
        this.fail(res, info.status, info.message, info.kind);
      }
      return;
    }
    if (this.options.staticDir && method === "GET") {
      const served = await this.serveStatic(path, res);
      if (served) {
        return;
      }
    }
    this.fail(res, 404, "Not found.");
  }

  private async api(
    method: string,
    path: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (method === "POST" && path === "/api/auth") {
      const body = await this.readBody(req);
      if (!this.options.token) {
        // Nothing to prove: a daemon started without a token answers whoever can reach it.
        this.json(res, 200, { ok: true, required: false });
        return true;
      }
      if (str(body["token"]) !== this.options.token) {
        throw new HttpError(401, "That token does not match this daemon.");
      }
      // The stream cannot carry a header, so the cookie is what it authenticates with. Cross-site
      // cookies are only accepted over HTTPS, which is why a remote daemon needs TLS or a tunnel.
      const cross = this.foreignOrigin(req) !== null;
      const cookie = [
        `${AncillaServer.AUTH_COOKIE}=${encodeURIComponent(this.options.token)}`,
        "Path=/",
        "HttpOnly",
        "Max-Age=604800",
        cross ? "SameSite=None" : "SameSite=Lax",
      ];
      if (cross) {
        cookie.push("Secure");
      }
      res.setHeader("set-cookie", cookie.join("; "));
      this.json(res, 200, { ok: true, required: true });
      return true;
    }
    if (method === "GET" && path === "/api/health") {
      this.json(res, 200, {
        ok: true,
        version: ANCILLA_VERSION,
        hosts: [...this.hosts.values()].map((h) => ({
          key: h.key,
          serverVersion: h.serverVersion,
          startedAt: h.startedAt,
        })),
        lastHostError: this.lastHostError,
        fingerprintWarnings: Object.fromEntries(this.fingerprints),
        // Enough to answer "has this session's feed gone quiet, and did anything get dropped?".
        diagnostics: {
          now: new Date().toISOString(),
          protocolErrors: this.protocolErrors,
          lastProtocolError: this.lastProtocolError,
          forwardFailures: this.forwardFailures,
          lastForwardFailure: this.lastForwardFailure,
          unroutedByMethod: Object.fromEntries(this.unroutedByMethod),
          sessions: Object.fromEntries(
            [...this.notifyStats].map(([id, stats]) => [
              id,
              {
                lastNotificationAt: new Date(stats.lastAt).toISOString(),
                quietForMs: Date.now() - stats.lastAt,
                count: stats.count,
                byMethod: stats.byMethod,
              },
            ]),
          ),
        },
      });
      return true;
    }
    if (method === "GET" && path === "/api/env") {
      this.json(res, 200, await this.environment(url.searchParams.get("refresh") === "1"));
      return true;
    }
    if (method === "GET" && path === "/api/events") {
      this.serveEvents(res);
      return true;
    }
    if (method === "GET" && path === "/api/projects") {
      this.json(res, 200, { projects: this.store.listProjects().map((p) => this.projectView(p)) });
      return true;
    }
    if (method === "POST" && path === "/api/projects") {
      const body = await this.readBody(req);
      const raw = str(body["cwd"]);
      if (!raw || !raw.trim()) {
        throw new HttpError(400, "cwd is required.");
      }
      const cwd = await this.canonicalCwd(raw, body["create"] === true);
      this.json(res, 200, await this.addProjectFolder(cwd));
      return true;
    }
    if (method === "POST" && path === "/api/projects/folders") {
      const body = await this.readBody(req);
      const cwd = str(body["cwd"]);
      const raw = str(body["path"]);
      if (!cwd || !raw || !raw.trim()) {
        throw new HttpError(400, "cwd and path are required.");
      }
      const projectCwd = normalizeCwd(cwd);
      if (!this.store.getProject(projectCwd)) {
        throw new HttpError(404, "Unknown project folder.");
      }
      const folder = await this.canonicalCwd(raw, false);
      const project = this.store.addProjectFolder(projectCwd, folder);
      // Threads Muse already ran in that folder show up under the project right away, or the warning says why not.
      let warning: string | null = null;
      try {
        await this.discover(folder);
      } catch (error) {
        warning = errorInfo(error).message;
      }
      this.sessionsChanged();
      this.json(res, 200, { project: this.projectView(this.store.getProject(projectCwd) ?? project), warning });
      return true;
    }
    if (method === "DELETE" && path === "/api/projects/folders") {
      const cwd = url.searchParams.get("cwd");
      const folder = url.searchParams.get("path");
      if (!cwd || !folder) {
        throw new HttpError(400, "cwd and path are required.");
      }
      const project = this.store.removeProjectFolder(normalizeCwd(cwd), normalizeCwd(folder));
      this.sessionsChanged();
      this.json(res, 200, { project: this.projectView(project) });
      return true;
    }
    if (method === "POST" && path === "/api/projects/clone") {
      const body = await this.readBody(req);
      const remote = str(body["url"])?.trim() ?? "";
      const target = str(body["path"])?.trim() ?? "";
      if (!remote || !target) {
        throw new HttpError(400, "url and path are required.");
      }
      if (!/^(https?:\/\/|ssh:\/\/|git:\/\/)\S+$/.test(remote) && !/^git@[^\s:]+:\S+$/.test(remote)) {
        throw new HttpError(400, "That does not look like a Git URL.");
      }
      const cwd = normalizeCwd(await this.cloneRepository(remote, target));
      this.json(res, 200, await this.addProjectFolder(cwd));
      return true;
    }
    if (method === "GET" && path === "/api/fs/list") {
      const target = url.searchParams.get("path") ?? "";
      this.json(res, 200, await listDirectory(target, await this.pathContext(target)));
      return true;
    }
    if (path.startsWith("/api/files/")) {
      return this.files(method, path, url, req, res);
    }
    if (method === "POST" && path === "/api/fs/reveal") {
      const body = await this.readBody(req);
      const target = str(body["path"]);
      if (!target) {
        throw new HttpError(400, "path is required.");
      }
      const resolved = resolveUserPath(target, await this.pathContext(target));
      const info = await stat(resolved.local).catch(() => null);
      if (!info?.isDirectory()) {
        throw new HttpError(404, "That folder does not exist.");
      }
      await this.opener(resolved.local, "files");
      this.json(res, 200, { ok: true });
      return true;
    }
    if (method === "DELETE" && path === "/api/projects") {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) {
        throw new HttpError(400, "cwd is required.");
      }
      this.store.setHidden(cwd, true);
      this.sessionsChanged();
      this.json(res, 200, { ok: true });
      return true;
    }
    if (method === "PATCH" && path === "/api/projects/order") {
      const body = await this.readBody(req);
      const raw = body["cwds"];
      if (!Array.isArray(raw)) {
        throw new HttpError(400, "cwds is required.");
      }
      this.store.setProjectOrder(raw.filter((cwd): cwd is string => typeof cwd === "string" && cwd.trim().length > 0).map(normalizeCwd));
      this.sessionsChanged();
      this.json(res, 200, { ok: true });
      return true;
    }
    if (method === "PATCH" && path === "/api/projects/pin") {
      const body = await this.readBody(req);
      const cwd = str(body["cwd"]);
      if (!cwd) {
        throw new HttpError(400, "cwd is required.");
      }
      this.store.upsertProject(cwd);
      this.store.setPinned(cwd, body["pinned"] === true);
      this.sessionsChanged();
      this.json(res, 200, { ok: true });
      return true;
    }
    if (method === "GET" && path === "/api/slash") {
      const listing = await this.listSkills(normalizeCwd(url.searchParams.get("cwd") ?? ""), url.searchParams.get("sessionId"));
      this.json(res, 200, { skills: listing.skills, error: listing.error });
      return true;
    }
    if (method === "GET" && path === "/api/slash/skill") {
      const id = url.searchParams.get("id");
      if (!id) {
        throw new HttpError(400, "id is required.");
      }
      const body = await this.skillBody(normalizeCwd(url.searchParams.get("cwd") ?? ""), id);
      this.json(res, 200, { id, body });
      return true;
    }
    if (method === "GET" && path === "/api/sessions") {
      const cwd = url.searchParams.get("cwd");
      const includeArchived = url.searchParams.get("archived") === "1";
      // Every folder, not only every project: a thread in a project's second folder belongs to that folder's row.
      const projects = cwd
        ? [this.store.getProject(cwd)].filter((p): p is NonNullable<typeof p> => p !== null)
        : this.store.listFolders();
      const sessions = projects.flatMap((project) =>
        this.store
          .listSessionsByProject(project.id, { includeArchived })
          .map((record) => this.summary(record, project.cwd)),
      );
      this.json(res, 200, { sessions });
      return true;
    }
    if (method === "POST" && path === "/api/discover") {
      const body = await this.readBody(req);
      const cwd = str(body["cwd"]) ?? undefined;
      this.json(res, 200, { sessions: await this.discover(cwd) });
      return true;
    }
    if (method === "POST" && path === "/api/sessions") {
      const body = await this.readBody(req);
      const raw = str(body["cwd"]);
      if (!raw) {
        throw new HttpError(400, "cwd is required.");
      }
      const mode = body["approvalMode"];
      if (mode !== undefined && mode !== null && !isApprovalMode(mode)) {
        throw new HttpError(400, "Unknown approvalMode.");
      }
      const accountRaw = body["accountId"];
      if (accountRaw !== undefined && accountRaw !== null && typeof accountRaw !== "string") {
        throw new HttpError(400, "accountId must be a string.");
      }
      const session = await this.startSession(
        normalizeCwd(raw),
        mode === undefined || mode === null ? undefined : (mode as ApprovalMode),
        str(body["modelId"]) ?? undefined,
        typeof accountRaw === "string" && accountRaw.length > 0 ? accountRaw : null,
      );
      this.json(res, 200, { session });
      return true;
    }

    const proxyMatch = path.match(/^\/api\/sessions\/([^/]+)\/shell-proxy$/);
    if (method === "POST" && proxyMatch) {
      const sessionId = decodeURIComponent(proxyMatch[1] as string);
      const body = await this.readBody(req);
      const command = str(body["command"])?.trim();
      if (!command) {
        throw new HttpError(400, "command is required.");
      }
      const found = this.store.findSession(sessionId);
      if (!found) {
        throw new HttpError(404, "Unknown session.");
      }
      const result = await this.runInWorkspace(found.cwd, command);
      const run = this.store.addShellRun({
        id: randomUUID(),
        sessionId,
        command,
        exitCode: result.exitCode,
        output: result.output,
        truncated: result.truncated,
        durationMs: result.durationMs,
        at: nowIso(),
      });
      this.store.updateSession(sessionId, { activityAt: nowIso() });
      this.emit("ancilla", { type: "shell-run", sessionId, run });
      this.json(res, 200, { run });
      return true;
    }

    const outputMatch = path.match(/^\/api\/sessions\/([^/]+)\/output$/);
    if (method === "GET" && outputMatch) {
      const sessionId = decodeURIComponent(outputMatch[1] as string);
      const itemId = url.searchParams.get("itemId");
      const outputRef = url.searchParams.get("outputRef");
      if (!itemId || !outputRef) {
        throw new HttpError(400, "itemId and outputRef are required.");
      }
      const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
      const length = Number.parseInt(url.searchParams.get("length") ?? String(OUTPUT_PAGE_BYTES), 10);
      const manager = await this.managerForSession(sessionId);
      const range = await manager.readItemOutput(sessionId, itemId, outputRef, {
        offsetBytes: Number.isFinite(offset) && offset > 0 ? offset : 0,
        lengthBytes: Number.isFinite(length) && length > 0 ? Math.min(length, OUTPUT_PAGE_BYTES) : OUTPUT_PAGE_BYTES,
      });
      this.json(res, 200, { output: range });
      return true;
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(?:\/(resume|model|approval-mode|compact|shell|fork|effort|goal|subagent|tasks|workflow))?$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1] as string);
      const action = sessionMatch[2];
      if (method === "PATCH" && !action) {
        const body = await this.readBody(req);
        const found = this.store.findSession(sessionId);
        if (!found) {
          throw new HttpError(404, "Unknown session.");
        }
        const title = typeof body["title"] === "string" ? body["title"].trim().slice(0, 200) : undefined;
        const settled = typeof body["settled"] === "boolean" ? body["settled"] : undefined;
        if (settled === true && this.isBusy(sessionId)) {
          throw new HttpError(409, "Stop the running turn and answer its requests before settling this thread.");
        }
        if (title && title !== found.session.title) {
          await this.renameInMuse(sessionId, title);
        }
        const record = this.store.updateSession(sessionId, {
          ...(title ? { title, titleSource: "user" as const } : {}),
          ...(typeof body["archived"] === "boolean" ? { archived: body["archived"] } : {}),
          // Un-settling by hand keeps the thread out of auto-settle until its next activity.
          ...(settled === true ? { settledOverride: "settled" as const, settledAt: nowIso(), unsettledAt: null } : {}),
          ...(settled === false ? { settledOverride: "active" as const, settledAt: null, unsettledAt: nowIso() } : {}),
        });
        this.sessionsChanged();
        this.json(res, 200, { session: record ? this.summary(record, found.cwd) : null });
        return true;
      }
      if (method === "POST" && action) {
        const body = await this.readBody(req);
        if (action === "resume") {
          this.json(res, 200, await this.loadTranscript(sessionId, body["refresh"] === true));
          return true;
        }
        const manager = await this.managerForSession(sessionId);
        if (action === "model") {
          if (!("model" in body)) {
            throw new HttpError(400, "model is required.");
          }
          await manager.setSessionModel(sessionId, await this.modelSelection(manager, sessionId, body["model"]));
          const modelId = str(asRecord(body["model"])?.["modelId"]);
          if (modelId) {
            // The user's pick, kept apart from what Muse reports: a resume that comes back on another model restores it.
            this.store.updateSession(sessionId, { modelId, chosenModelId: modelId });
          }
          this.json(res, 200, { ok: true });
          return true;
        }
        if (action === "compact") {
          this.json(res, 200, { result: await manager.compactSession(sessionId) });
          return true;
        }
        if (action === "shell") {
          const command = str(body["command"])?.trim();
          if (!command) {
            throw new HttpError(400, "command is required.");
          }
          this.wake(sessionId);
          await manager.userShell(sessionId, command);
          this.store.updateSession(sessionId, { activityAt: nowIso() });
          this.json(res, 200, { ok: true });
          return true;
        }
        if (action === "fork") {
          this.json(res, 200, { session: await this.forkSession(sessionId, manager) });
          return true;
        }
        if (action === "effort") {
          const effort = body["reasoningEffort"];
          if (!isReasoningEffort(effort)) {
            throw new HttpError(400, "Unknown reasoningEffort.");
          }
          // Set outright, not through the cache: this is the user asking, and a TUI change may not have reached us.
          await manager.setReasoningEffort(sessionId, effort);
          this.effortApplied.set(sessionId, effort);
          this.json(res, 200, { ok: true });
          return true;
        }
        if (action === "goal") {
          const goalAction = body["action"];
          if (!isGoalAction(goalAction)) {
            throw new HttpError(400, "Unknown goal action.");
          }
          const objective = str(body["objective"])?.trim();
          if ((goalAction === "set" || goalAction === "edit") && !objective) {
            throw new HttpError(400, "An objective is required.");
          }
          // Setting or resuming a goal on an idle session wakes a turn, which is activity like any prompt.
          this.wake(sessionId);
          const ack = await manager.goal(sessionId, goalAction, objective);
          this.store.updateSession(sessionId, { activityAt: nowIso() });
          this.json(res, 200, { turnId: ack.turnId });
          return true;
        }
        if (action === "subagent") {
          const subagentAction = body["action"];
          const subagentId = str(body["subagentId"]);
          if (!isSubagentAction(subagentAction) || !subagentId) {
            throw new HttpError(400, "A known subagent action and a subagentId are required.");
          }
          const text = str(body["body"])?.trim();
          if ((subagentAction === "sendMessage" || subagentAction === "followupTask") && !text) {
            throw new HttpError(400, "A message is required.");
          }
          await manager.subagent(sessionId, subagentAction, subagentId, { reason: str(body["reason"]) ?? undefined, body: text });
          this.json(res, 200, { ok: true });
          return true;
        }
        if (action === "tasks") {
          const taskAction = body["action"];
          const taskId = str(body["taskId"]);
          if (taskAction === "stopAll") {
            await manager.stopAllTasks(sessionId);
          } else if ((taskAction === "background" || taskAction === "stop") && taskId) {
            await (taskAction === "background" ? manager.backgroundTask(sessionId, taskId) : manager.stopTask(sessionId, taskId));
          } else {
            throw new HttpError(400, "Use background or stop with a taskId, or stopAll.");
          }
          this.json(res, 200, { ok: true });
          return true;
        }
        if (action === "workflow") {
          const workflowAction = body["action"];
          const workflowRunId = str(body["workflowRunId"]);
          if (!workflowRunId) {
            throw new HttpError(400, "workflowRunId is required.");
          }
          if (workflowAction === "cancel") {
            await manager.cancelWorkflow(sessionId, workflowRunId);
          } else if (isWorkflowChildAction(workflowAction)) {
            const childId = str(body["childId"]);
            const attempt = body["attempt"];
            if (!childId || typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
              throw new HttpError(400, "childId and the child's current attempt are required.");
            }
            await manager.controlWorkflowChild(sessionId, workflowRunId, childId, attempt, workflowAction);
          } else {
            throw new HttpError(400, "Use cancel, skip or retry.");
          }
          this.json(res, 200, { ok: true });
          return true;
        }
        const mode = body["mode"];
        if (!isApprovalMode(mode)) {
          throw new HttpError(400, "Unknown mode.");
        }
        await manager.setSessionApprovalMode(sessionId, mode);
        this.json(res, 200, { ok: true });
        return true;
      }
    }

    if (method === "GET" && path === "/api/plan-usage") {
      this.json(res, 200, await this.readPlanUsage());
      return true;
    }
    if (method === "GET" && path === "/api/title-settings") {
      this.json(res, 200, this.store.getTitleSettings());
      return true;
    }
    if (method === "PATCH" && path === "/api/title-settings") {
      const body = await this.readBody(req);
      const patch: { enabled?: boolean; modelId?: string | null } = {};
      if ("enabled" in body) {
        if (typeof body["enabled"] !== "boolean") {
          throw new HttpError(400, "enabled must be a boolean.");
        }
        patch.enabled = body["enabled"];
      }
      if ("modelId" in body) {
        const modelId = body["modelId"];
        if (modelId !== null && (typeof modelId !== "string" || modelId.trim().length === 0 || modelId.length > 200)) {
          throw new HttpError(400, "modelId must be null or a non-empty string.");
        }
        patch.modelId = modelId === null ? null : (modelId as string).trim();
      }
      const wasEnabled = this.store.getTitleSettings().enabled;
      const next = this.store.setTitleSettings(patch);
      if (!wasEnabled && next.enabled) {
        for (const sessionId of this.titleUpgradePending) {
          this.queueTitle(sessionId);
        }
      }
      this.json(res, 200, next);
      return true;
    }
    if (method === "GET" && path === "/api/sandbox-settings") {
      this.json(res, 200, this.store.getSandboxSettings());
      return true;
    }
    if (method === "PATCH" && path === "/api/sandbox-settings") {
      const body = await this.readBody(req);
      const patch: { disabled?: boolean } = {};
      if ("disabled" in body) {
        if (typeof body["disabled"] !== "boolean") {
          throw new HttpError(400, "disabled must be a boolean.");
        }
        patch.disabled = body["disabled"];
      }
      const wasDisabled = this.store.getSandboxSettings().disabled;
      const next = this.store.setSandboxSettings(patch);
      if (wasDisabled !== next.disabled) {
        // Posture is fixed at spawn, so live hosts restart; closing can outlast this request.
        // Restarts queue behind each other so a session created mid-flip never lands on a retired host.
        const run = this.restartChain.then(() => this.restartHosts());
        this.restartChain = run.catch(() => undefined);
      }
      this.json(res, 200, next);
      return true;
    }
    if (method === "GET" && path === "/api/yolo-settings") {
      this.json(res, 200, this.store.getYoloSettings());
      return true;
    }
    if (method === "PATCH" && path === "/api/yolo-settings") {
      const body = await this.readBody(req);
      const patch: { enabled?: boolean } = {};
      if ("enabled" in body) {
        if (typeof body["enabled"] !== "boolean") {
          throw new HttpError(400, "enabled must be a boolean.");
        }
        patch.enabled = body["enabled"];
      }
      const wasEnabled = this.store.getYoloSettings().enabled;
      const next = this.store.setYoloSettings(patch);
      if (wasEnabled !== next.enabled) {
        // Posture is fixed at spawn, so live hosts restart; closing can outlast this request.
        // Restarts queue behind each other so a session created mid-flip never lands on a retired host.
        const run = this.restartChain.then(() => this.restartHosts());
        this.restartChain = run.catch(() => undefined);
      }
      this.json(res, 200, next);
      return true;
    }
    if (method === "GET" && path === "/api/accounts") {
      this.json(res, 200, { accounts: await this.accountList() });
      return true;
    }
    if (method === "POST" && path === "/api/accounts") {
      const body = await this.readBody(req);
      const id = str(body["id"]);
      if (!id) {
        throw new HttpError(400, "id is required.");
      }
      const name = str(body["name"]);
      const seed = body["seedFromDefault"] === true;
      try {
        const profile = await this.aonia.createProfile(id, {
          ...(name ? { name } : {}),
          seedFromDefault: seed,
        });
        this.json(res, 200, { account: { id: profile.id, name: profile.name } });
      } catch (error) {
        throw this.accountError(error);
      }
      return true;
    }
    if (method === "PATCH" && path.startsWith("/api/accounts/")) {
      const id = decodeURIComponent(path.slice("/api/accounts/".length));
      const body = await this.readBody(req);
      const name = str(body["name"]);
      if (!name) {
        throw new HttpError(400, "name is required.");
      }
      try {
        await this.aonia.renameProfile(id, name);
      } catch (error) {
        throw this.accountError(error);
      }
      this.json(res, 200, { ok: true });
      return true;
    }
    if (method === "DELETE" && path.startsWith("/api/accounts/")) {
      const id = decodeURIComponent(path.slice("/api/accounts/".length));
      try {
        await this.aonia.removeProfile(id);
      } catch (error) {
        throw this.accountError(error);
      }
      this.json(res, 200, { ok: true });
      return true;
    }
    if (method === "GET" && path === "/api/accounts/health") {
      const findings = await this.aonia.doctor();
      const inherited = findings.some((f) => f.code === "meta_api_key_inherited");
      this.json(res, 200, { metaApiKeyInherited: inherited });
      return true;
    }
    if (method === "POST" && path.startsWith("/api/accounts/") && path.endsWith("/login")) {
      const id = decodeURIComponent(path.slice("/api/accounts/".length, path.length - "/login".length));
      if ((await this.museRuntime()) === "wsl") {
        this.json(res, 200, {
          fallback: `In-app login is not available when Muse runs in WSL. Log in from a terminal with: aonia login ${id}.`,
        });
        return true;
      }
      let profile: Profile;
      try {
        profile = await this.aonia.getProfile(id);
      } catch (error) {
        throw this.accountError(error);
      }
      const result = await this.runLogin(id, profile);
      this.json(res, 200, result);
      return true;
    }
    if (method === "PATCH" && path === "/api/projects/default-account") {
      const body = await this.readBody(req);
      const cwd = str(body["cwd"]);
      if (!cwd) {
        throw new HttpError(400, "cwd is required.");
      }
      const accountRaw = body["accountId"];
      if (accountRaw !== undefined && accountRaw !== null && typeof accountRaw !== "string") {
        throw new HttpError(400, "accountId must be a string or null.");
      }
      const accountId = typeof accountRaw === "string" && accountRaw.length > 0 ? accountRaw : null;
      this.store.upsertProject(normalizeCwd(cwd));
      this.store.setDefaultAccount(normalizeCwd(cwd), accountId);
      this.json(res, 200, { defaultAccountId: accountId });
      return true;
    }
    if (method === "GET" && path === "/api/usage") {
      const requested = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
      const days = Number.isFinite(requested) ? Math.min(365, Math.max(1, requested)) : 30;
      this.json(res, 200, this.usageReport(days));
      return true;
    }
    const attachmentMatch = path.match(/^\/api\/attachments\/([A-Za-z0-9-]{1,64})$/);
    if (method === "GET" && attachmentMatch) {
      const found = this.store.readAttachment(attachmentMatch[1] as string);
      if (!found) {
        throw new HttpError(404, "No such attachment.");
      }
      res.writeHead(200, {
        "content-type": found.record.mediaType,
        "content-length": String(found.bytes.length),
        "cache-control": "private, max-age=86400",
      });
      res.end(Buffer.from(found.bytes));
      return true;
    }
    if (method === "POST" && path === "/api/turns") {
      const body = await this.readBody(req);
      const sessionId = str(body["sessionId"]);
      const text = str(body["text"]) ?? "";
      const files = Array.isArray(body["attachments"]) ? body["attachments"] : [];
      if (!sessionId || (!text && files.length === 0)) {
        throw new HttpError(400, "sessionId and either text or an attachment are required.");
      }
      const ifBusy = body["ifBusy"];
      if (ifBusy !== undefined && ifBusy !== null && !isIfBusy(ifBusy)) {
        throw new HttpError(400, "Unknown ifBusy.");
      }
      const effort = body["reasoningEffort"];
      if (effort !== undefined && effort !== null && !isReasoningEffort(effort)) {
        throw new HttpError(400, "Unknown reasoningEffort.");
      }
      const managed = await this.hostForSession(sessionId);
      const manager = managed.manager;
      if (typeof effort === "string") {
        await this.applyEffort(manager, sessionId, effort);
      }
      const prepared = await this.prepareAttachments(this.store.findSession(sessionId)?.cwd ?? "", files);
      this.wake(sessionId);
      const live = this.liveFor(sessionId);
      const sentAtRevision = ++live.activityRevision;
      const ack = await manager.sendTurn(sessionId, prepared.prompt(text), {
        displayText: str(body["displayText"]) ?? undefined,
        ifBusy: typeof ifBusy === "string" ? ifBusy : undefined,
        reasoningEffort: typeof effort === "string" ? effort : undefined,
        images: prepared.images,
      });
      // A host that took the turn has the session loaded.
      if (this.hosts.get(managed.key) === managed) {
        this.sessionHosts.set(sessionId, managed.key);
      }
      if (live.activityRevision === sentAtRevision && ack.disposition === "started" && ack.turnId) {
        live.activityRevision += 1;
        live.activeTurnId = ack.turnId;
        live.turnStartedAt = nowIso();
        live.turnHost = managed.key;
        live.lastTerminal = null;
        live.lastError = null;
        this.emitStatus(sessionId);
      }
      // The saved attachments go back with the ack: the open thread shows them without waiting for a reload.
      const saved = prepared.files.map((file, index) =>
        this.attachmentView(
          this.store.addAttachment({
            id: randomUUID(),
            sessionId,
            turnId: ack.turnId,
            ord: index,
            name: file.name,
            mediaType: file.mediaType,
            kind: file.kind,
            width: file.width,
            height: file.height,
            bytes: file.bytes,
          }),
        ),
      );
      this.store.updateSession(sessionId, { activityAt: nowIso() });
      this.json(res, 200, { turnId: ack.turnId, status: ack.status, disposition: ack.disposition, attachments: saved });
      return true;
    }

    const turnMatch = path.match(/^\/api\/turns\/(steer|interrupt|cancel|unqueue)$/);
    if (method === "POST" && turnMatch) {
      const action = turnMatch[1] as string;
      const body = await this.readBody(req);
      const sessionId = str(body["sessionId"]);
      const turnId = str(body["turnId"]);
      if (!sessionId) {
        throw new HttpError(400, "sessionId is required.");
      }
      const manager = await this.managerForSession(sessionId);
      if (action === "steer") {
        const text = str(body["text"]);
        if (!turnId || !text) {
          throw new HttpError(400, "turnId and text are required to steer.");
        }
        await manager.steerTurn(sessionId, turnId, text);
      } else if (action === "interrupt") {
        await manager.interruptTurn(sessionId, turnId ?? undefined, body["retract"] === true);
      } else if (action === "cancel") {
        if (!turnId) {
          throw new HttpError(400, "turnId is required.");
        }
        await manager.cancelTurn(sessionId, turnId);
      } else {
        if (!turnId) {
          throw new HttpError(400, "turnId is required.");
        }
        await manager.unqueueTurn(sessionId, turnId);
      }
      this.json(res, 200, { ok: true });
      return true;
    }

    if (method === "POST" && path === "/api/approvals/decide") {
      const body = await this.readBody(req);
      const sessionId = str(body["sessionId"]);
      const approvalId = str(body["approvalId"]);
      const choiceId = str(body["choiceId"]);
      if (!sessionId || !approvalId || !choiceId || !("requirementId" in body)) {
        throw new HttpError(400, "sessionId, approvalId, requirementId and choiceId are required.");
      }
      const manager = await this.managerForSession(sessionId);
      await manager.decideApproval({
        sessionId,
        approvalId,
        requirementId: body["requirementId"],
        choiceId,
        feedback: str(body["feedback"]),
      });
      this.json(res, 200, { ok: true });
      return true;
    }

    if (method === "GET" && path === "/api/models") {
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const manager = sessionId ? await this.managerForSession(sessionId) : (await this.hostFor("")).manager;
      this.json(res, 200, { models: await manager.listModels(sessionId) });
      return true;
    }

    const inputMatch = path.match(/^\/api\/user-input\/(answer|cancel|clarify)$/);
    if (method === "POST" && inputMatch) {
      const action = inputMatch[1] as string;
      const body = await this.readBody(req);
      const sessionId = str(body["sessionId"]);
      const userInputId = str(body["userInputId"]);
      if (!sessionId || !userInputId) {
        throw new HttpError(400, "sessionId and userInputId are required.");
      }
      const manager = await this.managerForSession(sessionId);
      if (action === "answer") {
        const answers = body["answers"];
        if (!Array.isArray(answers)) {
          throw new HttpError(400, "answers are required.");
        }
        await manager.answerUserInput(sessionId, userInputId, answers as never);
      } else if (action === "cancel") {
        await manager.cancelUserInput(sessionId, userInputId, str(body["reason"]) ?? undefined);
      } else {
        const content = str(body["content"]);
        if (!content) {
          throw new HttpError(400, "content is required.");
        }
        await manager.clarifyUserInput(sessionId, userInputId, content);
      }
      this.json(res, 200, { ok: true });
      return true;
    }

    if (method === "POST" && path === "/api/open") {
      const body = await this.readBody(req);
      const cwd = str(body["cwd"]);
      if (!cwd || !this.store.getProject(cwd)) {
        throw new HttpError(404, "Unknown project folder.");
      }
      const target: OpenTarget = body["target"] === "editor" ? "editor" : "files";
      await this.opener(this.localPathFor(cwd), target);
      this.json(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  private async environment(refresh: boolean): Promise<EnvView> {
    if (!refresh && this.envCache && Date.now() - this.envCache.at < ENV_CACHE_MS) {
      return this.envCache.value;
    }
    const hint = this.runtimeHint();
    const configured = this.options.musePath ?? null;
    // The probe looks where Muse will be started: the configured distro and path, with runtime.json's environment.
    const wslEnv = this.wslEnvFor();
    const probe = await probeEnvironment(this.options.exec, this.options.platform, {
      preference: hint === "native" || hint === "wsl" ? hint : this.options.runtime,
      ...(this.options.findNativeMuse ? { findNative: this.options.findNativeMuse } : {}),
      ...(this.options.distro ? { distro: this.options.distro } : {}),
      musePath: configured,
      ...(wslEnv ? { env: wslEnv } : {}),
    });
    if (!hint) {
      this.runtimeKnown = probe.runtime;
    }
    if (probe.museDistro) {
      this.distroKnown = probe.museDistro;
    }
    if (probe.runtime === "native" && probe.native && !this.options.findNativeMuse) {
      refreshNativeMuse(probe.native);
    }
    let musePath = probe.musePath;
    // A configured binary on this machine is the one hosts start, so it is the one that has to be there.
    if (configured && (probe.runtime === "native" ? isWindowsAbs(configured) : probe.runtime === "posix" && configured.includes("/"))) {
      musePath = existsSync(configured) ? configured : null;
    }
    const value: EnvView = {
      platform: probe.platform,
      runtime: probe.runtime,
      wslAvailable: probe.wslAvailable,
      // The distro Muse runs in, which is what the app shows as WSL's; the Windows default only when that is unknown.
      defaultDistro: probe.runtime === "wsl" ? (probe.museDistro ?? probe.defaultDistro) : probe.defaultDistro,
      museFound: musePath !== null,
      musePath,
      version: ANCILLA_VERSION,
      persistent: this.options.dataDir !== ":memory:",
    };
    this.envCache = { at: Date.now(), value };
    return value;
  }

  private serveEvents(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const sink: SseSink = (event, data) => {
      if (res.writableEnded) {
        this.sinks.delete(sink);
        return;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    this.sinks.add(sink);
    sink("ancilla", { type: "hello", version: ANCILLA_VERSION });
    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        this.sinks.delete(sink);
        return;
      }
      // A named event rather than a comment: EventSource never surfaces comments to a listener, so a client
      // holding a stream whose upstream died behind a proxy cannot tell it from a quiet one. This is what
      // the client's watchdog listens for.
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
    }, 25000);
    res.on("close", () => {
      clearInterval(heartbeat);
      this.sinks.delete(sink);
    });
  }

  private async serveStatic(path: string, res: ServerResponse): Promise<boolean> {
    if (!this.options.staticDir) {
      return false;
    }
    const root = this.options.staticDir;
    const rel = path === "/" ? "/index.html" : path;
    const full = normalize(join(root, rel));
    if (!full.startsWith(root + sep) && full !== root) {
      return false;
    }
    try {
      const info = await stat(full);
      const file = info.isDirectory() ? join(full, "index.html") : full;
      const body = await readFile(file);
      const immutable = file.includes(`${sep}assets${sep}`);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }

  private liveFor(sessionId: string): LiveState {
    let state = this.live.get(sessionId);
    if (!state) {
      state = {
        activeTurnId: null,
        turnStartedAt: null,
        turnHost: null,
        pendingApprovals: new Set(),
        pendingInputs: new Set(),
        lastTerminal: null,
        lastError: null,
        goal: null,
        goalSeq: 0,
        goalCursor: null,
        activityRevision: 0,
        viewHealth: null,
        readOnlyReason: null,
        provisional: new Set(),
      };
      this.live.set(sessionId, state);
    }
    return state;
  }

  private liveView(sessionId: string): LiveView | null {
    const state = this.live.get(sessionId);
    if (!state) {
      return null;
    }
    return {
      activeTurnId: state.activeTurnId,
      turnStartedAt: state.turnStartedAt,
      pendingApprovals: state.pendingApprovals.size,
      pendingInputs: state.pendingInputs.size,
      lastTerminal: state.lastTerminal,
      lastError: state.lastError,
      goal: state.goal,
      viewHealth: state.viewHealth,
    };
  }

  private emitStatus(sessionId: string): void {
    this.emit("ancilla", { type: "session-status", sessionId, live: this.liveView(sessionId) });
  }

  private summary(record: SessionRecord, cwd: string): Record<string, unknown> {
    return {
      sessionId: record.id,
      cwd,
      title: record.title,
      titleSource: record.titleSource,
      turnCount: record.turnCount,
      modelId: record.modelId,
      origin: record.origin,
      archived: record.archived,
      createdAt: record.createdAt,
      activityAt: record.activityAt,
      settled: record.settledOverride === "settled",
      settledAt: record.settledAt,
      unsettledAt: record.unsettledAt,
      sandboxDisabled: record.sandboxDisabled,
      accountId: record.accountId,
      live: this.liveView(record.id),
    };
  }

  private isBusy(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    return Boolean(live && (live.activeTurnId || live.pendingApprovals.size > 0 || live.pendingInputs.size > 0));
  }

  /** New activity wakes a settled thread, and lifts a manual "keep active" so auto-settle can apply again. */
  private wake(sessionId: string): void {
    const record = this.store.getSession(sessionId);
    if (!record || record.settledOverride === null) {
      return;
    }
    this.store.updateSession(sessionId, {
      settledOverride: null,
      settledAt: null,
      unsettledAt: record.settledOverride === "settled" ? nowIso() : record.unsettledAt,
    });
    this.sessionsChanged();
  }

  /** Settles threads nobody has touched for `autoSettleDays`, as T3 Code does; a busy thread is left alone. */
  private autoSettle(): void {
    const days = this.options.autoSettleDays;
    if (days === null || this.closed) {
      return;
    }
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    let changed = false;
    for (const record of this.store.listSettleCandidates(cutoff)) {
      if (this.isBusy(record.id)) {
        continue;
      }
      this.store.updateSession(record.id, { settledOverride: "settled", settledAt: record.activityAt, unsettledAt: null });
      changed = true;
    }
    if (changed) {
      this.sessionsChanged();
    }
  }

  /** A runtime the options settle without probing: the OS, an explicit `--runtime`, or the style of a `--muse` path. */
  private runtimeHint(): MuseRuntime | null {
    if (this.options.platform !== "win32") {
      return "posix";
    }
    if (this.options.runtime === "native" || this.options.runtime === "wsl") {
      return this.options.runtime;
    }
    const configured = this.options.musePath;
    if (configured && isWindowsAbs(configured)) {
      return "native";
    }
    if (configured?.startsWith("/")) {
      return "wsl";
    }
    return null;
  }

  /**
   * Where Muse runs. On Windows, native Muse wins over WSL once it is installed, unless WSL was asked for. For WSL
   * this also settles the distro, so every caller past it checks paths against the distro hosts are started in.
   */
  private async museRuntime(): Promise<MuseRuntime> {
    let runtime = this.runtimeHint();
    if (!runtime) {
      if (!this.runtimeKnown) {
        await this.environment(false);
      }
      runtime = this.runtimeKnown ?? "wsl";
    }
    if (runtime === "wsl" && !this.options.distro && !this.distroKnown) {
      await this.environment(false);
    }
    return runtime;
  }

  /**
   * The WSL distro Muse runs in: the configured one, else the one the environment probe found Muse in (`Ubuntu`, or
   * the default distro when Muse is only there). Hosts, CLI calls and the check on `\\wsl.localhost\` folders all
   * take it from here, so they cannot disagree.
   */
  private wslDistro(): string {
    return this.options.distro ?? this.distroKnown ?? FALLBACK_DISTRO;
  }

  /**
   * The environment for a process started through `wsl.exe`: runtime.json's `wslEnv` over this process's own, with
   * `overlay` (an account's folders) winning over both and `forward` added to WSLENV. Undefined, so the child simply
   * inherits, when there is nothing to add. Processes on the Windows side never see these.
   */
  private wslEnvFor(overlay: Record<string, string> | null = null, forward: string[] = []): Record<string, string> | undefined {
    const own = this.wslEnvWithout(overlay);
    if (Object.keys(own).length === 0 && !overlay && forward.length === 0) {
      return undefined;
    }
    return wslSpawnEnv({ ...process.env, ...(overlay ?? {}) }, own, forward);
  }

  /** runtime.json's `wslEnv`, less the names `overlay` sets: an account's own folders win over it. */
  private wslEnvWithout(overlay: Record<string, string | undefined> | null | undefined): Record<string, string> {
    const taken = new Set(Object.keys(overlay ?? {}).map((name) => name.toUpperCase()));
    return Object.fromEntries(Object.entries(this.options.wslEnv).filter(([key]) => !taken.has(key.toUpperCase())));
  }

  /** Runs a planned CLI call. One that goes through `wsl.exe` carries runtime.json's `wslEnv`. */
  private runPlanned(plan: { command: string; args: string[] }, runtime: MuseRuntime) {
    const env = this.options.platform === "win32" && runtime === "wsl" ? this.wslEnvFor() : undefined;
    return env ? this.options.exec(plan.command, plan.args, { env }) : this.options.exec(plan.command, plan.args);
  }

  private spawnCwdFor(cwd: string): string {
    if (!cwd) {
      return process.cwd();
    }
    if (this.options.platform !== "win32") {
      return cwd;
    }
    if (isWslAbs(cwd)) {
      try {
        return toWindowsPath(cwd);
      } catch {
        return process.cwd();
      }
    }
    return cwd;
  }

  /** The workspace path as Muse sees it: `/mnt/d/...` for Muse in WSL, `D:\\...` for native Windows Muse. */
  private hostPathFor(cwd: string): string {
    if (!cwd || this.options.platform !== "win32") {
      return cwd;
    }
    if ((this.runtimeHint() ?? this.runtimeKnown) === "native") {
      return this.spawnCwdFor(cwd);
    }
    const unc = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i.exec(cwd);
    if (unc) {
      // The distro hosts start in, not WSL's default: the two differ when Muse lives in another distro.
      const distro = this.wslDistro();
      if (unc[1]!.toLowerCase() !== distro.toLowerCase()) {
        throw new HttpError(400, `This folder belongs to WSL ${unc[1]}, but Muse is running in ${distro}.`);
      }
      return "/" + (unc[2] ?? "").replace(/\\/g, "/");
    }
    if (isWindowsAbs(cwd)) {
      try {
        return toWslPath(cwd);
      } catch {
        return cwd;
      }
    }
    return cwd;
  }

  /** One host per (account, workspace). "default" stands in for the default login so today's keys are unchanged in spirit. */
  private hostKey(cwd: string, accountId: string | null): string {
    return `${accountId ?? "default"}::${this.hostPathFor(cwd) || "__default__"}`;
  }

  private storePathFor(remoteRoot: string): string {
    if (this.options.platform === "win32" && isWslAbs(remoteRoot)) {
      const existing = this.store.listFolders().find((project) => {
        try { return this.hostPathFor(project.cwd) === remoteRoot; } catch { return false; }
      });
      if (existing) return existing.cwd;
    }
    if (this.options.platform === "win32" && isWindowsAbs(remoteRoot)) {
      // Native Muse may spell a folder `d:/work`; the store keeps one spelling, `D:\\work`.
      const normal = win32.normalize(remoteRoot);
      return normal.charAt(0).toUpperCase() + normal.slice(1);
    }
    if (this.options.platform !== "win32" || !isWslAbs(remoteRoot)) {
      return remoteRoot;
    }
    try {
      return toWindowsPath(remoteRoot);
    } catch {
      return remoteRoot;
    }
  }

  /** A path the local OS can open: WSL `/mnt/x` roots become `X:\` on Windows. */
  private localPathFor(cwd: string): string {
    if (this.options.platform === "win32" && isWslAbs(cwd)) {
      try {
        return toWindowsPath(cwd);
      } catch {
        return cwd;
      }
    }
    return cwd;
  }

  /** How typed paths map onto this machine. The WSL distro is only probed for Linux paths on Windows. */
  private async pathContext(forPath: string): Promise<PathContext> {
    const platform = this.options.platform ?? process.platform;
    const value = forPath.trim();
    let distro: string | null = this.options.distro ?? null;
    if (!distro && platform === "win32" && value.startsWith("/") && !/^\/mnt\/[A-Za-z](\/|$)/.test(value)) {
      distro = (await this.environment(false)).defaultDistro;
    }
    return { platform, home: this.options.home ?? homedir(), distro };
  }

  /** The stored form of a project folder: absolute, `~` expanded, one separator style. */
  private async canonicalCwd(raw: string, create: boolean): Promise<string> {
    const ctx = await this.pathContext(raw);
    try {
      const resolved = create ? await createDirectory(raw, ctx) : resolveUserPath(raw, ctx);
      return normalizeCwd(resolved.display);
    } catch (error) {
      if (create || !(error instanceof PathError)) {
        throw error;
      }
      return normalizeCwd(raw);
    }
  }

  /** What `/api/projects` says about a project: its folders included, its own first. */
  private projectView(project: Project): Record<string, unknown> {
    return {
      cwd: project.cwd,
      displayName: project.displayName,
      pinned: project.pinned,
      activityAt: project.activityAt,
      defaultAccountId: project.defaultAccountId,
      folders: project.folders,
    };
  }

  /**
   * Adds a folder as a project, or brings a hidden one back. A folder that already sits inside a project is not
   * made a project of its own again: its project comes back instead, with every folder, and is what is returned.
   */
  private async addProjectFolder(cwd: string): Promise<Record<string, unknown>> {
    this.store.upsertProject(cwd);
    const owner = this.store.projectForFolder(cwd)?.cwd ?? cwd;
    this.store.setHidden(owner, false);
    let warning: string | null = null;
    let sessions: Record<string, unknown>[] = [];
    try {
      sessions = await this.discover(cwd);
    } catch (error) {
      warning = errorInfo(error).message;
    }
    this.sessionsChanged();
    const project = this.store.getProject(owner);
    return { project: project ? this.projectView(project) : { cwd, displayName: cwd, folders: [] }, sessions, warning };
  }

  private async cloneRepository(remote: string, target: string): Promise<string> {
    const ctx = await this.pathContext(target);
    const resolved = resolveUserPath(target, ctx);
    const existing = await readdir(resolved.local).catch(() => null);
    if (existing && existing.length > 0) {
      throw new HttpError(409, "That folder already exists and is not empty. Pick another name.");
    }
    await mkdir((ctx.platform === "win32" ? win32 : posix).dirname(resolved.local), { recursive: true });
    // A Linux folder under WSL is cloned by WSL's own git, so it gets Linux line endings and permissions.
    if (ctx.platform === "win32" && resolved.flavor === "posix" && !resolved.display.startsWith("/mnt/")) {
      const env = wslSpawnEnv({ ...process.env, GIT_TERMINAL_PROMPT: "0" }, this.options.wslEnv, ["GIT_TERMINAL_PROMPT/u"]);
      await runProcess("wsl.exe", ["-d", ctx.distro ?? "", "--", "git", "clone", "--", remote, resolved.display], CLONE_TIMEOUT_MS, env);
    } else {
      await runProcess("git", ["clone", "--", remote, resolved.local], CLONE_TIMEOUT_MS);
    }
    return resolved.display;
  }

  /** The muse binary for one-off CLI calls; on Windows the environment probe finds it natively or inside WSL. */
  private async cliMusePath(): Promise<string | null> {
    await this.museRuntime();
    const configured = this.options.musePath ?? null;
    if (this.options.platform !== "win32" || (configured && (configured.includes("/") || configured.includes("\\")))) {
      return configured;
    }
    return (await this.environment(false)).musePath;
  }

  /** A workspace's skills as `muse skills list` reports them, kept for a minute. A failure comes back as `error`, never a throw. */
  /**
   * A workspace's skills. With a session that is loaded on a host, Muse's own `skill/list` decides which skills are
   * there, so it stays right as skills are added or switched off; without one, `muse skills list` stands in.
   */
  private async listSkills(cwd: string, sessionId?: string | null): Promise<SkillListing> {
    const cli = await this.listCliSkills(cwd);
    const hostKey = sessionId ? this.sessionHosts.get(sessionId) : undefined;
    const managed = hostKey ? this.hosts.get(hostKey) : undefined;
    if (!sessionId || !managed) {
      return cli;
    }
    try {
      const rows = await managed.manager.listSessionSkills(sessionId);
      return { ...cli, skills: mergeSessionSkills(rows, cli.skills), error: null };
    } catch {
      // An older host without skill/list, or a session that just unloaded: the CLI listing still answers.
      return cli;
    }
  }

  private async listCliSkills(cwd: string): Promise<SkillListing> {
    const key = cwd || "__default__";
    const cached = this.skillCache.get(key);
    if (cached && !cached.error && Date.now() - cached.at < SKILL_CACHE_MS) {
      return cached;
    }
    const args = ["skills", "list", "--json"];
    const musePath = await this.cliMusePath();
    const root = this.hostPathFor(cwd);
    if (root) {
      args.push("--workspace", root);
    }
    const runtime = await this.museRuntime();
    const plan = planMuseCli({ platform: this.options.platform, distro: this.wslDistro(), musePath, args, runtime });
    const result = await this.runPlanned(plan, runtime);
    const parsed = parseSkillList(result.stdout);
    const listing: SkillListing = parsed
      ? { at: Date.now(), ...parsed, error: null }
      : {
          at: Date.now(),
          skills: [],
          paths: new Map(),
          error:
            result.exitCode === 0
              ? "Muse listed its skills in a form Ancilla does not understand."
              : "Could not list Muse skills. Check that muse runs in a terminal.",
        };
    this.skillCache.set(key, listing);
    return listing;
  }

  /** A listed skill's instructions, read where Muse keeps them. The path comes from Muse, never from the request. */
  private async skillBody(cwd: string, id: string): Promise<string> {
    const path = (await this.listCliSkills(cwd)).paths.get(id);
    if (!path) {
      throw new HttpError(404, "Muse does not list that skill for this workspace.");
    }
    const bundled = /^bundled:\/\/(.+)$/.exec(path)?.[1];
    if (bundled?.split("/").includes("..")) {
      throw new HttpError(400, "That skill's path is not readable.");
    }
    const runtime = await this.museRuntime();
    if (runtime === "native") {
      // Native Muse keeps its data where the launcher keeps its config: XDG folders under the user profile.
      const dataHome = process.env["XDG_DATA_HOME"] || join(this.options.home, ".local", "share");
      const file = bundled ? win32.join(dataHome, "muse", "skills", "bundled", ...bundled.split("/")) : path;
      const body = stripFrontmatter(await readFile(file, "utf8").catch(() => ""));
      if (!body) {
        throw new HttpError(502, "Could not read that skill's instructions.");
      }
      return body;
    }
    // Bundled skills live in Muse's data folder; the others list a real file path.
    const script = bundled ? 'exec cat -- "${XDG_DATA_HOME:-$HOME/.local/share}/muse/skills/bundled/$1"' : 'exec cat -- "$1"';
    const plan = planHostCommand({
      platform: this.options.platform,
      distro: this.wslDistro(),
      program: "sh",
      args: ["-c", script, "sh", bundled ?? path],
    });
    const result = await this.runPlanned(plan, runtime);
    const body = result.exitCode === 0 ? stripFrontmatter(result.stdout) : "";
    if (!body) {
      throw new HttpError(502, "Could not read that skill's instructions.");
    }
    return body;
  }

  private async forkSession(sessionId: string, manager: SessionManager): Promise<Record<string, unknown>> {
    const found = this.store.findSession(sessionId);
    if (!found) {
      throw new HttpError(404, "Unknown session.");
    }
    const forked = await manager.forkSession(sessionId);
    const raw = asRecord(asRecord(forked.raw)?.["session"]);
    const record = this.store.recordSession({
      id: forked.sessionId,
      projectId: found.session.projectId,
      origin: "ancilla",
      // The fork carries its source's name until the user renames it.
      title: `${found.session.title} (fork)`,
      titleSource: "auto",
      modelId: raw ? str(raw["modelId"]) : found.session.modelId,
      turnCount: num(raw?.["turnCount"]),
      createdAt: normalizeIso(raw?.["createdAt"]),
      // A fork branches its source session, so it inherits the source's posture.
      sandboxDisabled: found.session.sandboxDisabled,
    });
    const hostKey = this.sessionHosts.get(sessionId);
    if (hostKey) {
      this.sessionHosts.set(forked.sessionId, hostKey);
    }
    this.liveFor(forked.sessionId);
    this.sessionsChanged();
    return this.summary(record, found.cwd);
  }

  /**
   * The selection `session/setModel` gets for a model id: the catalog's own entry for it, provider and profile
   * included, the way a picker in Muse's client would send it. A bare id is what the UI knows; whether Muse keeps a
   * selection that names no provider across a restart is not something to rely on. The catalog is a request away,
   * so the id alone still goes out when the catalog cannot be read or does not list it.
   */
  private async modelSelection(manager: SessionManager, sessionId: string, model: unknown): Promise<unknown> {
    const given = asRecord(model);
    const modelId = str(given?.["modelId"]);
    if (!given || !modelId || (given["providerId"] !== undefined && given["profileId"] !== undefined)) {
      return model;
    }
    try {
      const list = asRecord(await manager.listModels(sessionId))?.["models"];
      const entry = Array.isArray(list) ? list.map(asRecord).find((m) => m && str(m["modelId"]) === modelId) : null;
      if (!entry) {
        return model;
      }
      const selection: Record<string, unknown> = { ...given };
      for (const key of ["providerId", "profileId", "displayLabel"]) {
        if (selection[key] === undefined && (typeof entry[key] === "string" || entry[key] === null)) {
          selection[key] = entry[key];
        }
      }
      return selection;
    } catch {
      return model;
    }
  }

  /**
   * A resumed session that reports a model other than the one the user picked gets the pick set again, and is
   * reported as being on it. A host that comes back after a restart can answer with the model the session started
   * on, and nothing in the durable history the client folds need say otherwise. Only a pick is restored: a thread
   * whose model was never chosen follows the host.
   */
  private async restoreChosenModel(
    manager: SessionManager,
    sessionId: string,
    chosen: string | null,
    msp: Record<string, unknown> | null,
  ): Promise<Record<string, unknown> | null> {
    if (!msp || !chosen || str(msp["modelId"]) === chosen) {
      return msp;
    }
    try {
      await manager.setSessionModel(sessionId, await this.modelSelection(manager, sessionId, { modelId: chosen }));
      return { ...msp, modelId: chosen };
    } catch (error) {
      this.log(`could not put ${sessionId} back on ${chosen}: ${errorInfo(error).message}`);
      return msp;
    }
  }

  private async startSession(
    cwd: string,
    approvalMode?: ApprovalMode,
    modelId?: string,
    accountId: string | null = null,
  ): Promise<Record<string, unknown>> {
    const project = this.store.upsertProject(cwd);
    // The thread must be visible where it lands: the owning project when the folder is one of a project's folders.
    this.store.setHidden(this.store.projectForFolder(cwd)?.cwd ?? cwd, false);
    const host = await this.hostFor(cwd, accountId);
    const started = await host.manager.startSession({
      workspaceRoot: this.hostPathFor(cwd),
      approvalMode,
      modelId,
    });
    const raw = asRecord(asRecord(started.raw)?.["session"]);
    const record = this.store.recordSession({
      id: started.sessionId,
      projectId: project.id,
      origin: "ancilla",
      modelId: raw ? str(raw["modelId"]) : null,
      chosenModelId: modelId ?? null,
      createdAt: normalizeIso(raw?.["createdAt"]),
      // The creating host's own flags, not the live switch: a flip's restart may still be closing the old host.
      sandboxDisabled: host.target.args.includes("--disable-sandbox"),
      accountId,
    });
    this.sessionHosts.set(started.sessionId, host.key);
    if (accountId) {
      await this.aonia.touch(accountId).catch(() => undefined);
    }
    this.liveFor(started.sessionId);
    this.sessionsChanged();
    return this.summary(record, cwd);
  }

  /**
   * Files posted with a prompt. Images are the one non-text part MSP takes, so they go straight to the model;
   * anything else is written into the workspace under `.ancilla/attachments` and mentioned in the prompt,
   * which is how Muse reaches a file. Every one is kept here too, so a reopened thread can show it.
   */
  private async prepareAttachments(
    cwd: string,
    raw: unknown[],
  ): Promise<{ images: TurnImage[]; files: PreparedAttachment[]; prompt: (text: string) => string }> {
    const mentions: string[] = [];
    const images: TurnImage[] = [];
    const files: PreparedAttachment[] = [];
    if (raw.length > MAX_ATTACHMENTS) {
      throw new HttpError(400, `A message takes at most ${MAX_ATTACHMENTS} files.`);
    }
    for (const entry of raw) {
      const record = asRecord(entry);
      const base64 = record ? str(record["base64"]) : null;
      const mediaType = record ? str(record["mediaType"]) : null;
      if (!record || !base64 || !mediaType) {
        throw new HttpError(400, "Each attachment needs a name, a mediaType and base64 bytes.");
      }
      const name = safeFileName(str(record["name"]));
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length === 0) {
        throw new HttpError(400, `${name} has no content.`);
      }
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new HttpError(413, `${name} is over ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`);
      }
      const width = num(record["width"]) ?? null;
      const height = num(record["height"]) ?? null;
      if (mediaType.startsWith("image/")) {
        images.push({
          base64Data: base64,
          mediaType,
          ...(width !== null && height !== null ? { width, height } : {}),
        });
        files.push({ name, mediaType, kind: "image", width, height, bytes });
        continue;
      }
      if (!cwd) {
        throw new HttpError(400, `${name} needs a workspace to land in.`);
      }
      const written = await this.writeIntoWorkspace(cwd, name, bytes);
      mentions.push(`@${[...ATTACHMENT_DIR, written].join("/")}`);
      files.push({ name: written, mediaType, kind: "file", width, height, bytes });
    }
    return {
      images,
      files,
      prompt: (text: string) => [text, ...mentions].filter((part) => part.length > 0).join("\n\n"),
    };
  }

  /** Writes an attached file into the workspace, keeping its name unless one is already taken. */
  private async writeIntoWorkspace(cwd: string, name: string, bytes: Buffer): Promise<string> {
    const directory = join(cwd, ...ATTACHMENT_DIR);
    await mkdir(directory, { recursive: true });
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const suffix = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const taken = await stat(join(directory, candidate)).then(
        () => true,
        () => false,
      );
      if (!taken) {
        break;
      }
      candidate = `${stem}-${attempt + 2}${suffix}`;
    }
    await writeFile(join(directory, candidate), bytes);
    return candidate;
  }

  /**
   * One model call's tokens, kept so the usage page can look across every thread rather than only the ones
   * open in the UI. The view cursor is the key, so replaying a thread's history never counts a call twice.
   */
  private recordUsage(sessionId: string, params: Record<string, unknown>): void {
    const usage = asRecord(params["usage"]) ?? {};
    const promptTokens = num(params["promptTokens"]) ?? num(usage["inputTokens"]) ?? 0;
    const outputTokens = num(usage["outputTokens"]) ?? Math.max(0, (num(params["totalTokens"]) ?? 0) - promptTokens);
    if (promptTokens === 0 && outputTokens === 0) {
      return;
    }
    this.store.recordUsage({
      key: str(params["viewCursor"]) ?? `${sessionId}:${str(params["turnId"]) ?? "turn"}:${randomUUID()}`,
      sessionId,
      turnId: str(params["turnId"]),
      modelId: str(params["modelId"]),
      promptTokens,
      outputTokens,
      inputTokens: num(usage["inputTokens"]) ?? 0,
      cachedTokens: num(usage["cachedTokens"]) ?? 0,
      cacheReadTokens: num(usage["cacheReadTokens"]) ?? 0,
      cacheWriteTokens: num(usage["cacheWriteTokens"]) ?? 0,
      reasoningTokens: num(usage["reasoningTokens"]) ?? 0,
      durationMs: num(params["durationMs"]) ?? null,
      at: normalizeIso(params["at"]) ?? nowIso(),
    });
  }

  /** Tokens per day and model, plus a row per thread, for the usage page to price. */
  private usageReport(days: number): Record<string, unknown> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.store.listUsage(since);
    const buckets = new Map<string, Record<string, unknown>>();
    const threads = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const day = row.at.slice(0, 10);
      const modelId = row.modelId ?? "unknown";
      const cached = Math.min(row.promptTokens, row.cacheReadTokens || row.cachedTokens);
      const bucketKey = `${day}|${modelId}`;
      const bucket = buckets.get(bucketKey) ?? {
        day,
        modelId,
        calls: 0,
        promptTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        durationMs: 0,
      };
      bucket["calls"] = (bucket["calls"] as number) + 1;
      bucket["promptTokens"] = (bucket["promptTokens"] as number) + row.promptTokens;
      bucket["outputTokens"] = (bucket["outputTokens"] as number) + row.outputTokens;
      bucket["cachedTokens"] = (bucket["cachedTokens"] as number) + cached;
      bucket["cacheReadTokens"] = (bucket["cacheReadTokens"] as number) + row.cacheReadTokens;
      bucket["cacheWriteTokens"] = (bucket["cacheWriteTokens"] as number) + row.cacheWriteTokens;
      bucket["reasoningTokens"] = (bucket["reasoningTokens"] as number) + row.reasoningTokens;
      bucket["durationMs"] = (bucket["durationMs"] as number) + (row.durationMs ?? 0);
      buckets.set(bucketKey, bucket);

      const thread = threads.get(row.sessionId) ?? {
        sessionId: row.sessionId,
        title: row.sessionTitle,
        cwd: row.projectCwd,
        calls: 0,
        promptTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        modelIds: [] as string[],
        // A thread that switched models has to be priced per model, not at whichever one it started on.
        models: [] as Record<string, unknown>[],
        lastAt: row.at,
      };
      thread["calls"] = (thread["calls"] as number) + 1;
      thread["promptTokens"] = (thread["promptTokens"] as number) + row.promptTokens;
      thread["outputTokens"] = (thread["outputTokens"] as number) + row.outputTokens;
      thread["cachedTokens"] = (thread["cachedTokens"] as number) + cached;
      const ids = thread["modelIds"] as string[];
      if (!ids.includes(modelId)) {
        ids.push(modelId);
      }
      const perModel = thread["models"] as Record<string, unknown>[];
      const share = perModel.find((entry) => entry["modelId"] === modelId);
      if (share) {
        share["calls"] = (share["calls"] as number) + 1;
        share["promptTokens"] = (share["promptTokens"] as number) + row.promptTokens;
        share["outputTokens"] = (share["outputTokens"] as number) + row.outputTokens;
        share["cachedTokens"] = (share["cachedTokens"] as number) + cached;
      } else {
        perModel.push({
          modelId,
          calls: 1,
          promptTokens: row.promptTokens,
          outputTokens: row.outputTokens,
          cachedTokens: cached,
        });
      }
      thread["lastAt"] = row.at;
      threads.set(row.sessionId, thread);
    }
    return {
      since,
      days,
      buckets: [...buckets.values()],
      threads: [...threads.values()].sort((a, b) => ((a["lastAt"] as string) < (b["lastAt"] as string) ? 1 : -1)),
    };
  }

  /**
   * Runs a `!` command where the workspace lives: through WSL on Windows, in the folder itself elsewhere.
   * This is the user's own shell, not Muse's sandbox, which is the point: Muse cannot run these at all.
   */
  private async runInWorkspace(
    cwd: string,
    command: string,
  ): Promise<{ output: string; exitCode: number | null; truncated: boolean; durationMs: number }> {
    const started = Date.now();
    if ((await this.museRuntime()) === "native") {
      // Native Windows Muse works in PowerShell, so `!` commands run there too, in the workspace folder.
      // PowerShell reads curly single quotes as quotes too, so each kind is doubled to stay literal.
      const folder = this.spawnCwdFor(cwd).replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&");
      const powershell = win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = `Set-Location -LiteralPath '${folder}' -ErrorAction Stop\n${command}`;
      const result = await this.options.shellRunner(powershell, ["-NoProfile", "-NonInteractive", "-Command", script]);
      return { ...result, output: result.output.replace(/\r\n/g, "\n"), durationMs: Date.now() - started };
    }
    const plan = planHostCommand({
      platform: this.options.platform,
      distro: this.wslDistro(),
      program: "sh",
      // $1 is the workspace, then the command; a login shell so the user's PATH is the one they expect.
      args: ["-c", 'cd "$1" || exit 1; shift; exec "${SHELL:-/bin/sh}" -lc "$1"', "sh", this.hostPathFor(cwd), command],
    });
    const result = await this.options.shellRunner(plan.command, plan.args);
    return { ...result, durationMs: Date.now() - started };
  }

  private attachmentView(record: AttachmentRecord): Record<string, unknown> {
    return {
      id: record.id,
      turnId: record.turnId,
      name: record.name,
      mediaType: record.mediaType,
      kind: record.kind,
      width: record.width,
      height: record.height,
      url: `/api/attachments/${record.id}`,
    };
  }

  private async pageTranscript(
    manager: SessionManager,
    sessionId: string,
  ): Promise<{ events: { method: string; params: Record<string, unknown> }[]; truncated: boolean }> {
    const pages: unknown[][] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const result = await manager.pageView(sessionId, { cursor, direction: "backward", limit: HISTORY_PAGE_SIZE });
      pages.unshift(result.events);
      if (!result.nextCursor || result.events.length === 0) {
        break;
      }
      cursor = result.nextCursor;
      truncated = page === MAX_HISTORY_PAGES - 1;
    }
    return {
      events: pages.flat().map(stripEvent).filter((e): e is NonNullable<typeof e> => e !== null),
      truncated,
    };
  }

  /**
   * A thread's transcript, status and pending requests. Opening a thread loads (resumes) the session on its host.
   * A refresh only reads, since a quiet turn can still be executing or waiting on a question and reading must never
   * reattach it; but a refresh that finds the session unloaded, with nothing this server could reattach, loads it
   * as opening does. Read-only is only ever another Muse client's lease, reported with that client's reason.
   */
  private async loadTranscript(sessionId: string, refresh = false): Promise<Record<string, unknown>> {
    // A goal change can land while this load is in flight; history must not then write the older goal back.
    const goalSeqAtStart = this.liveFor(sessionId).goalSeq;
    const found = this.store.findSession(sessionId);
    const host = await this.hostFor(found?.cwd ?? "", found?.session.accountId ?? null);
    const manager = host.manager;
    const activityAtStart = this.liveFor(sessionId).activityRevision;
    // The run believed to be going as the load began: the only one whose outcome the load may report.
    const activeBefore = this.liveFor(sessionId).activeTurnId;
    let msp: Record<string, unknown> | null = null;
    let read: Record<string, unknown> | null = null;
    // Turns a read reported running. A terminal record the page holds for one may be the projection's stand-in.
    const readActive = new Set<string>();
    const noteActive = (session: Record<string, unknown> | null) => {
      const active = session && session["status"] !== "notLoaded" ? str(session["activeTurnId"]) : null;
      if (active) readActive.add(active);
    };
    let resume = !refresh;
    if (refresh) {
      read = asRecord(await manager.readSession(sessionId, false));
      msp = asRecord(read?.["session"]);
      noteActive(msp);
      // Requests the durable log still holds wait on the user; only opening the thread brings them back.
      const awaiting = Array.isArray(read?.["pendingRequests"]) && (read["pendingRequests"] as unknown[]).length > 0;
      resume = msp?.["status"] === "notLoaded" && !awaiting && this.mayLoadUnloaded(sessionId, host);
    }
    let resumed = false;
    if (resume) {
      try {
        const reply = asRecord(await manager.resumeSession(sessionId, true));
        msp = asRecord(reply?.["session"]) ?? msp;
        if (!refresh) {
          read = reply;
        }
        resumed = true;
        if (this.hosts.get(host.key) === host) {
          this.sessionHosts.set(sessionId, host.key);
        }
        this.liveFor(sessionId).readOnlyReason = null;
        msp = await this.restoreChosenModel(manager, sessionId, found?.session.chosenModelId ?? null, msp);
      } catch (error) {
        const info = errorInfo(error);
        if (info.kind === "sessionInUse") {
          // Only another client holding the session makes it read-only here, and always with a reason to show.
          this.liveFor(sessionId).readOnlyReason = info.message.trim() || "Another Muse session has this thread open.";
          if (this.sessionHosts.get(sessionId) === host.key) {
            this.sessionHosts.delete(sessionId);
          }
        } else if (!refresh) {
          // Opening a thread that cannot load is a real failure and surfaces.
          throw error;
        } else {
          // A refresh already has what it read; the next open or send loads the session, or reports why not.
          this.log(`refresh of ${sessionId} could not load it on ${host.key}: ${info.message}`);
        }
      }
    }

    let events: { method: string; params: Record<string, unknown> }[] = [];
    let truncated = false;
    try {
      const paged = await this.pageTranscript(manager, sessionId);
      events = paged.events;
      truncated = paged.truncated;
    } catch (error) {
      const kind = errorInfo(error).kind;
      // view/page needs a loaded session; another host's lease leaves this host with nothing to page.
      if (kind !== "sessionInUse" && kind !== "sessionNotLoaded") {
        throw error;
      }
    }

    // The read can have newer item revisions than a partially available page. Append its item
    // records so the UI's revision fold selects the newest; usage remains owned by paged events.
    let historyFailed = false;
    if (events.length === 0 && !refresh) {
      // A thread whose load went through (or that another client holds) still opens when this read fails: the
      // response then says its history is incomplete rather than failing the whole thread.
      const fallback = await manager.readSession(sessionId, false).then(asRecord, () => undefined);
      if (fallback === undefined) {
        historyFailed = true;
      } else {
        read = fallback;
      }
    }
    if (!msp) msp = asRecord(read?.["session"]);
    events.push(...eventsFromHistory(read));

    const pending = await manager.listPending(sessionId).catch(() => null);
    const approvals = (pending?.approvals ?? []).map((a) => stripSource(asRecord(a) ?? {}));
    const userInputs = (pending?.userInputs ?? []).map((u) => stripSource(asRecord(u) ?? {}));

    if (refresh && !resumed) {
      // Read the status once more, now the pages are in: a turn that started or ended while they came is then
      // known, and its record in the page is not taken for more than it is. A failed re-read keeps the first.
      const later = asRecord(asRecord(await manager.readSession(sessionId, true).catch(() => null))?.["session"]);
      if (later) {
        msp = { ...(msp ?? {}), ...later, status: later["status"], activeTurnId: later["activeTurnId"] ?? null };
      }
    }

    const live = this.liveFor(sessionId);
    const superseded = live.activityRevision !== activityAtStart;
    // A different/new host reports notLoaded even while the owning host is still working.
    const statusKnown = msp !== null && msp["status"] !== "notLoaded";
    noteActive(msp);
    if (refresh && !resumed && statusKnown) {
      // Read as loaded, the session is this host's own to write to. Read as unloaded, whatever was last found about
      // another client's lease stands; a missing binding alone never makes a thread read-only.
      if (this.hosts.get(host.key) === host) {
        this.sessionHosts.set(sessionId, host.key);
      }
      live.readOnlyReason = null;
    }
    const readOnlyReason = live.readOnlyReason;
    const history = asRecord(read?.["history"]);
    const noneReason = str(history?.["noneReason"]);
    // An unavailable projection serves an older prefix, which can end before what has since happened.
    const partial = noneReason === "projectionUnavailable";
    const snapshotItems = asRecord(asRecord(history?.["snapshot"])?.["state"])?.["items"];
    const historyServed =
      (history?.["mode"] === "inline" && Array.isArray(history["items"])) ||
      (["snapshot", "anchoredSnapshot"].includes(String(history?.["mode"])) &&
        (Array.isArray(snapshotItems) || asRecord(snapshotItems) !== null));
    if (!superseded) {
      if (partial) {
        live.viewHealth = { status: "unavailable", reason: noneReason };
      } else if (historyServed) {
        // Served history means the projection works, whether or not this host has the session loaded.
        live.viewHealth = null;
      }
    }

    const terminalFor = (event: { method: string; params: Record<string, unknown> }) =>
      event.method === "turn/completed" ? str(event.params["turnId"]) : null;
    const failed = (event: { method: string; params: Record<string, unknown> }) => str(event.params["terminal"]) === "failed";
    const fresh = statusKnown && !superseded;
    if (fresh) {
      const active = str(msp!["activeTurnId"]);
      if (active !== live.activeTurnId) {
        live.activeTurnId = active;
        live.turnStartedAt = active ? nowIso() : null;
      }
      live.turnHost = active ? host.key : null;
    } else if (!statusKnown && !superseded && live.activeTurnId) {
      // Unloaded here, the session can still be running in another client. Only its own recorded end, which no
      // projection stands in for, says that run is over.
      const running = live.activeTurnId;
      if (events.some((event) => terminalFor(event) === running && !failed(event))) {
        live.activeTurnId = null;
        live.turnStartedAt = null;
        live.turnHost = null;
      }
    }
    if (pending && statusKnown && !superseded) {
      live.pendingApprovals = new Set(approvals.map((a) => str(a["approvalId"])).filter((id): id is string => id !== null));
      live.pendingInputs = new Set(userInputs.map((u) => str(u["userInputId"])).filter((id): id is string => id !== null));
    }
    // Muse's history projection writes a failed terminal record for a run that is still open. A turn a fresh read
    // says is running cannot have ended, so no terminal record for it is shown; a failed one is the stand-in, kept
    // so that it is dropped again from any stale prefix that still carries it. A failed record for a turn only
    // believed to be running, or that a read showed running while the page was taken, is held back as unconfirmed.
    // Real failures of any other turn, and of that turn once it has stopped, stay visible.
    const runningNow = fresh ? live.activeTurnId : null;
    const unconfirmed = new Set(readActive);
    if (!fresh && live.activeTurnId) unconfirmed.add(live.activeTurnId);
    // A turn the page shows starting after one of those began after that read was taken, so it may be open as well.
    const lastStart = events.findLastIndex((event) => event.method === "turn/started" && unconfirmed.has(str(event.params["turnId"]) ?? ""));
    for (const event of lastStart === -1 ? [] : events.slice(lastStart + 1)) {
      const turnId = event.method === "turn/started" ? str(event.params["turnId"]) : null;
      if (turnId) unconfirmed.add(turnId);
    }
    events = events.filter((event) => {
      const turnId = terminalFor(event);
      if (!turnId) {
        return true;
      }
      const signature = JSON.stringify(event.params);
      if (turnId === runningNow) {
        if (failed(event)) {
          live.provisional.delete(signature);
          live.provisional.add(signature);
          if (live.provisional.size > PROVISIONAL_LIMIT) {
            live.provisional.delete(live.provisional.values().next().value as string);
          }
        }
        return false;
      }
      if (unconfirmed.has(turnId) && failed(event)) {
        return false;
      }
      return !(partial && live.provisional.has(signature));
    });
    if (!superseded && activeBefore && live.activeTurnId !== activeBefore) {
      // The run that was going has stopped. Its outcome is its own terminal record; without one, or with a failure
      // from a stale prefix (which can be a stand-in for a run that went on), the outcome is unknown and nothing
      // announces a result. A new run under way has no outcome yet either.
      const own = [...events].reverse().find((event) => terminalFor(event) === activeBefore);
      const terminal = own && live.activeTurnId === null ? (str(own.params["terminal"]) ?? "completed") : null;
      const known = terminal !== null && !(terminal === "failed" && partial);
      live.lastTerminal = known ? terminal : null;
      live.lastError = known && terminal === "failed" ? (str(asRecord(own!.params["error"])?.["message"]) ?? "The turn failed.") : null;
    } else if (!activeBefore && fresh && !partial && live.activeTurnId === null && live.lastTerminal === null) {
      // Nothing seen here says how the last run ended (a thread opened after a restart, say). A complete history
      // read from a session that is loaded and idle does, when its last record closes the last run it started.
      const lastStart = events.findLastIndex((event) => event.method === "turn/started");
      const last = events.findLastIndex((event) => event.method === "turn/completed");
      const closing = last > lastStart ? events[last]! : null;
      const startedId = lastStart === -1 ? null : str(events[lastStart]!.params["turnId"]);
      if (closing && (startedId === null || terminalFor(closing) === startedId)) {
        live.lastTerminal = str(closing.params["terminal"]) ?? "completed";
        live.lastError = live.lastTerminal === "failed" ? (str(asRecord(closing.params["error"])?.["message"]) ?? "The turn failed.") : null;
      }
    }
    // Opening a thread backfills the usage page with the calls it made before this server ever ran.
    for (const event of events) {
      if (event.method === "session/tokenUsage") {
        this.recordUsage(sessionId, event.params);
      }
    }
    // The history's last goal change is the goal as of now, unless a live one arrived while this load ran, or the
    // history is a stale prefix whose goal is not newer than the one held.
    for (let index = events.length - 1; live.goalSeq === goalSeqAtStart && index >= 0; index -= 1) {
      const event = events[index];
      const goal = event?.method === "session/goalChanged" ? goalOf(event.params["goal"]) : undefined;
      if (goal !== undefined) {
        const cursor = str(event!.params["viewCursor"]);
        if (!partial || live.goal === null || cursorAfter(cursor, live.goalCursor)) {
          live.goal = goal;
          live.goalCursor = cursor;
        }
        break;
      }
    }
    this.emitStatus(sessionId);

    if (found && !superseded) {
      this.store.recordSession({
        id: sessionId,
        projectId: found.session.projectId,
        turnCount: num(msp?.["turnCount"]),
        modelId: msp ? str(msp["modelId"]) : null,
        activityAt: normalizeIso(msp?.["updatedAt"]),
      });
      if (found.session.titleSource === "placeholder") {
        const title = titleFromEvents(events);
        if (title) {
          this.store.updateSession(sessionId, { title, titleSource: "auto" });
          this.titleUpgradePending.add(sessionId);
          // The history is in hand, so no queue and no re-page; the upgrade never throws.
          void this.maybeUpgradeThreadTitle(sessionId, firstUserText(events) ?? "");
          this.sessionsChanged();
        }
      }
    }
    const record = this.store.getSession(sessionId);
    return {
      session: record && found ? this.summary(record, found.cwd) : null,
      msp: msp
        ? {
            status: str(msp["status"]),
            activeTurnId: superseded || !statusKnown ? live.activeTurnId : str(msp["activeTurnId"]),
            modelId: str(msp["modelId"]),
            approvalMode: asRecord(msp["approvalMode"])?.["mode"] ?? null,
            workspaceRoot: str(msp["workspaceRoot"]),
            turnCount: num(msp["turnCount"]) ?? 0,
            // History pages carry no context readings, so pass along the session's own when it has them.
            contextUsage: asRecord(msp["contextUsage"]) ?? null,
            tokenUsage: asRecord(msp["tokenUsage"]) ?? null,
          }
        : null,
      events,
      truncated,
      attachments: this.store.listAttachments(sessionId).map((record) => this.attachmentView(record)),
      shellRuns: this.store.listShellRuns(sessionId),
      pending: { approvals, userInputs },
      pendingComplete: pending !== null && statusKnown && !superseded,
      // A readable old prefix does not make an unavailable projection a complete replacement.
      historyUnavailable: partial || (noneReason !== null && events.length === 0) || historyFailed,
      viewHealth: live.viewHealth,
      // Read-only always comes with the reason another client gave; never from a binding this server lost.
      readOnly: readOnlyReason !== null,
      readOnlyReason,
    };
  }

  private async discover(cwd?: string): Promise<Record<string, unknown>[]> {
    const host = await this.hostFor(cwd ?? "");
    const remote: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page = await host.manager.listSessionsPage({
        workspaceRoot: cwd ? this.hostPathFor(cwd) : undefined,
        limit: 100,
        cursor,
      });
      remote.push(...page.sessions);
      cursor = page.nextCursor;
    } while (cursor && remote.length < DISCOVER_LIMIT);

    const views: Record<string, unknown>[] = [];
    let backfill = 0;
    for (const item of remote) {
      const record = asRecord(item);
      const session = (record && asRecord(record["session"])) ?? record;
      const sessionId = session ? str(session["sessionId"]) : null;
      if (!session || !sessionId) {
        continue;
      }
      const root = this.storePathFor(firstString(session, ["workspaceRoot"]) ?? cwd ?? "");
      if (!root) {
        continue;
      }
      const project = this.store.upsertProject(root);
      const existing = this.store.getSession(sessionId);
      // Muse names its own sessions, and that name is what the user sees in the CLI, so it wins here too.
      // Only a title the user typed in Ancilla outranks it. MSP `title` is just the first-prompt echo,
      // so it is only a fallback, sanitized like any other derived title.
      const keepOurs = existing?.titleSource === "user" ||
        (!this.options.syncSessionNames && existing !== null && existing.titleSource !== "placeholder");
      const mspName = keepOurs ? null : firstString(session, ["name"]);
      const mspTitle = keepOurs ? null : firstString(session, ["title"]);
      const echoTitle = mspName ? null : mspTitle ? deriveTitle(mspTitle) : null;
      // The echo is a fallback for threads seen here first, never an update: it must not clobber
      // a title a past upgrade wrote, or every discovery would revert it and spend another call.
      const takeEcho = echoTitle !== null && (!existing || existing.titleSource === "placeholder" || existing.title === echoTitle);
      const title = mspName ?? (takeEcho ? echoTitle : null);
      const stored = this.store.recordSession({
        id: sessionId,
        projectId: project.id,
        origin: existing?.origin ?? "tui",
        title: title ?? undefined,
        titleSource: title ? "auto" : undefined,
        turnCount: num(session["turnCount"]),
        modelId: str(session["modelId"]),
        createdAt: normalizeIso(session["createdAt"]),
        activityAt: normalizeIso(session["updatedAt"]),
      });
      const running = str(session["status"]) === "running" && Boolean(str(session["activeTurnId"]));
      if (running) {
        const live = this.liveFor(sessionId);
        const listed = str(session["activeTurnId"]);
        if (live.activeTurnId !== listed) {
          // Newer than any read in flight, which must not then write an older state back over it.
          live.activityRevision += 1;
          live.activeTurnId = listed;
          live.turnStartedAt = null;
        }
        // A host lists a session as running only while it has that session loaded; others list it notLoaded.
        live.turnHost = host.key;
        live.turnStartedAt = live.turnStartedAt ?? nowIso();
        this.sessionHosts.set(sessionId, host.key);
      }
      // A settled thread that moved on in another Muse client (running now, or updated since) comes back.
      let current = stored;
      if (stored.settledOverride === "settled" && (running || (stored.settledAt !== null && stored.activityAt > stored.settledAt))) {
        this.wake(sessionId);
        current = this.store.getSession(sessionId) ?? stored;
      }
      if (mspName) {
        // A Muse-selected name is never upgraded, even if an echo here owed an attempt.
        this.titleUpgradePending.delete(sessionId);
      }
      // A stored echo still owes one LLM attempt; anything Muse named, the user typed, with a call
      // already in flight, or a past upgrade already replaced no longer qualifies, even across restarts.
      const needsUpgrade =
        !this.titleUpgradeActive.has(sessionId) &&
        (stored.titleSource === "placeholder" ||
          (stored.titleSource === "auto" && echoTitle !== null && stored.title === echoTitle));
      if (needsUpgrade && backfill < TITLE_BACKFILL_LIMIT) {
        backfill += 1;
        this.titleUpgradePending.add(sessionId);
        this.queueTitle(sessionId);
      }
      views.push(this.summary(current, project.cwd));
    }
    this.sessionsChanged();
    return views;
  }

  private queueTitle(sessionId: string): void {
    if (this.closed || this.titleQueue.includes(sessionId)) {
      return;
    }
    this.titleQueue.push(sessionId);
    if (!this.titleWorker) {
      this.titleWorker = this.drainTitles().finally(() => {
        this.titleWorker = null;
      });
    }
  }

  private async drainTitles(): Promise<void> {
    while (this.titleQueue.length > 0 && !this.closed) {
      const sessionId = this.titleQueue.shift() as string;
      try {
        const current = this.store.getSession(sessionId);
        if (!current || current.titleSource === "user") {
          this.titleUpgradePending.delete(sessionId);
          continue;
        }
        if (current.titleSource !== "placeholder" && !this.titleUpgradePending.has(sessionId)) {
          continue;
        }
        const host = await this.hostFor("");
        const page = await host.manager.pageView(sessionId, { direction: "forward", limit: 30 });
        if (this.closed) {
          return;
        }
        const events = page.events.map(stripEvent).filter((e): e is NonNullable<typeof e> => e !== null);
        if (current.titleSource === "placeholder") {
          const title = titleFromEvents(events);
          if (!title) {
            this.titleUpgradePending.delete(sessionId);
            continue;
          }
          this.store.updateSession(sessionId, { title, titleSource: "auto" });
          this.titleUpgradePending.add(sessionId);
          this.sessionsChanged();
        }
        await this.maybeUpgradeThreadTitle(sessionId, firstUserText(events) ?? "");
      } catch {
        /* a title is a nicety; the placeholder stays */
      }
    }
  }

  /**
   * One LLM title attempt for an echo-titled thread. Nothing happens on failure; the echo stays.
   * The claim happens before the first await, so a live upgrade and a queued one cannot both run.
   * Never throws, so live paths can fire it without awaiting it.
   */
  private async maybeUpgradeThreadTitle(sessionId: string, firstText: string): Promise<void> {
    if (!this.titleUpgradePending.has(sessionId) || this.titleUpgradeActive.has(sessionId)) {
      return;
    }
    try {
      const settings = this.store.getTitleSettings();
      if (!settings.enabled) {
        return;
      }
      const before = this.store.getSession(sessionId);
      if (!before || before.titleSource !== "auto" || !firstText.trim()) {
        this.titleUpgradePending.delete(sessionId);
        return;
      }
      this.titleUpgradePending.delete(sessionId);
      this.titleUpgradeActive.add(sessionId);
      try {
        await this.runThreadTitleUpgrade(sessionId, firstText, before.title, settings.modelId);
      } finally {
        this.titleUpgradeActive.delete(sessionId);
      }
    } catch {
      /* a title is a nicety; the echo stays */
    }
  }

  private async runThreadTitleUpgrade(
    sessionId: string,
    firstText: string,
    expectedTitle: string,
    modelId: string | null,
  ): Promise<void> {
    const musePath = await this.cliMusePath();
    const runtime = await this.museRuntime();
    const plan = planMuseCli({
      platform: this.options.platform,
      distro: this.wslDistro(),
      musePath,
      args: [
        "exec",
        "--json",
        "--no-session-log",
        "--disable-web-tools",
        "--reasoning-effort",
        "minimal",
        "--max-model-steps",
        "1",
        ...(modelId ? ["--model", modelId] : []),
        buildThreadTitlePrompt(firstText),
      ],
      runtime,
    });
    const result = await this.runPlanned(plan, runtime);
    if (this.closed || result.exitCode !== 0) {
      return;
    }
    const title = sanitizeThreadTitle(parseExecTitle(result.stdout) ?? "", firstText);
    if (!title || title === expectedTitle) {
      return;
    }
    const current = this.store.getSession(sessionId);
    if (!current || current.titleSource !== "auto" || current.title !== expectedTitle) {
      return;
    }
    this.store.updateSession(sessionId, { title, titleSource: "auto" });
    await this.renameInMuse(sessionId, title);
    this.sessionsChanged();
  }

  private async managerForSession(sessionId: string): Promise<SessionManager> {
    return (await this.hostForSession(sessionId)).manager;
  }

  /** The host that has the session loaded, else the one its workspace and account start. */
  private async hostForSession(sessionId: string): Promise<ManagedHost> {
    const key = this.sessionHosts.get(sessionId);
    const loaded = key ? this.hosts.get(key) : undefined;
    if (loaded) {
      return loaded;
    }
    const found = this.store.findSession(sessionId);
    return this.hostFor(found?.cwd ?? "", found?.session.accountId ?? null);
  }

  /**
   * Whether a refresh that found the session unloaded on its host may load it there, as opening the thread does.
   * Only when this server knows of nothing it could reattach: no other live host of its own has the session, and no
   * turn, approval or question is open. Another Muse client's lease still refuses the load, and that refusal (with
   * its reason) is the one thing that makes a thread read-only.
   */
  private mayLoadUnloaded(sessionId: string, host: ManagedHost): boolean {
    const mapped = this.sessionHosts.get(sessionId);
    if (mapped !== undefined && mapped !== host.key && this.hosts.has(mapped)) {
      return false;
    }
    return !this.isBusy(sessionId);
  }

  private async hostFor(cwd: string, accountId: string | null = null): Promise<ManagedHost> {
    await this.museRuntime();
    // A flip's restart runs past its PATCH response. Wait it out so a new session never
    // starts on a host with the previous posture. Starts never wait for the chain, so this
    // cannot deadlock against the restart awaiting them.
    await this.restartChain;
    const key = this.hostKey(cwd, accountId);
    const existing = this.hosts.get(key);
    if (existing) {
      return existing;
    }
    const pending = this.starting.get(key);
    if (pending) {
      return pending;
    }
    if (this.closed) {
      throw new HttpError(503, "Ancilla is shutting down.");
    }
    const startup = this.spawnHost(key, cwd, accountId);
    this.starting.set(key, startup);
    try {
      return await startup;
    } finally {
      this.starting.delete(key);
    }
  }

  private async spawnHost(key: string, cwd: string, accountId: string | null): Promise<ManagedHost> {
    const target = await this.serveTargetFor(cwd, accountId);
    const handle = this.options.hostFactory(target);
    let started: { fingerprintWarning?: unknown; initializeResult?: unknown } | null;
    try {
      started = (await handle.start(ANCILLA_VERSION)) as typeof started;
    } catch (error) {
      this.lastHostError = error instanceof Error ? error.message : String(error);
      this.emit("ancilla", { type: "host", key, state: "failed", message: this.lastHostError });
      throw new HttpError(502, `Could not start Muse: ${this.lastHostError}`);
    }
    this.lastHostError = null;
    this.fingerprints.set(key, started?.fingerprintWarning ?? null);
    const manager = new SessionManager(handle.connection);
    manager.onNotification((notification) => this.forward(key, notification));
    // A frame the SDK refuses never becomes a notification, so without this it is indistinguishable
    // from the backend having nothing to send (#42, H3).
    const reportsProtocolErrors = manager.onProtocolError((error) => {
      this.protocolErrors += 1;
      this.lastProtocolError = error instanceof Error ? error.message : String(error);
      this.log(`protocol error on host ${key}: ${this.lastProtocolError}`);
    });
    if (!reportsProtocolErrors) {
      this.log(`host ${key} cannot report protocol errors; dropped frames stay invisible`);
    }
    const serverInfo = asRecord(asRecord(started?.initializeResult)?.["serverInfo"]);
    const managed: ManagedHost = {
      key,
      accountId,
      target,
      handle,
      manager,
      serverVersion: serverInfo ? str(serverInfo["version"]) : null,
      startedAt: nowIso(),
    };
    handle.onExit?.((exit) => this.hostExited(managed, exit));
    this.hosts.set(key, managed);
    return managed;
  }

  private hostExited(managed: ManagedHost, exit: HostExit): void {
    if (this.hosts.get(managed.key) !== managed) {
      return;
    }
    const detail = managed.handle.recentStderr?.trim();
    const message = `The Muse host exited (${exit.code ?? exit.signal ?? "unknown"}).${detail ? ` ${detail}` : ""}`;
    this.lastHostError = message;
    this.emit("ancilla", { type: "host", key: managed.key, state: "exited", message });
    this.forgetHost(managed, message);
  }

  /**
   * Drops a host gone for any reason. Its sessions resume lazily on their next touch, but anything
   * in flight is over, so live turns fail with the given message instead of hanging as running.
   */
  private forgetHost(managed: ManagedHost, lastError: string): void {
    this.hosts.delete(managed.key);
    const affected = new Set<string>();
    for (const [sessionId, key] of this.sessionHosts) {
      if (key !== managed.key) {
        continue;
      }
      this.sessionHosts.delete(sessionId);
      this.effortApplied.delete(sessionId);
      affected.add(sessionId);
    }
    // A turn this host was seen running is over too, even when the session's binding had already moved or lapsed.
    for (const [sessionId, live] of this.live) {
      if (live.turnHost === managed.key) {
        affected.add(sessionId);
      }
    }
    for (const sessionId of affected) {
      const live = this.live.get(sessionId);
      if (!live) {
        continue;
      }
      // A load that read the session from this host before it went must not write that state back afterwards.
      live.activityRevision += 1;
      if (live.turnHost === managed.key) {
        live.turnHost = null;
      }
      if (live.activeTurnId || live.pendingApprovals.size || live.pendingInputs.size) {
        live.activeTurnId = null;
        live.turnStartedAt = null;
        live.turnHost = null;
        live.pendingApprovals.clear();
        live.pendingInputs.clear();
        live.lastTerminal = "failed";
        live.lastError = lastError;
        this.emitStatus(sessionId);
      }
    }
  }

  /**
   * Closes every live host so the next use respawns it with the current sandbox and YOLO
   * posture. Never throws: closing is best effort, and a host that refuses to die is dropped
   * the same way. The respawn only fixes new sessions: Muse commits each session's
   * filesystem/network posture at creation (a `yolo` cause carries fs=unrestricted,
   * net=enabled), so only new threads pick a flipped posture up. The approval side of YOLO
   * mode flips over MSP instead.
   */
  private async restartHosts(): Promise<void> {
    for (const pending of this.starting.values()) {
      await pending.catch(() => undefined);
    }
    for (const managed of [...this.hosts.values()]) {
      try {
        await managed.handle.close();
      } catch {
        /* best effort */
      }
      const message = "The Muse host restarted to apply a settings change.";
      this.forgetHost(managed, message);
      this.emit("ancilla", { type: "host", key: managed.key, state: "restarted", message });
    }
  }

  private async accountList(): Promise<Record<string, unknown>[]> {
    const profiles = await this.aonia.listProfiles();
    return Promise.all(
      profiles.map(async (profile) => {
        const identity = await this.aonia.identityOf(profile);
        return {
          id: profile.id,
          name: profile.name,
          hasLogin: identity.hasLogin,
          email: identity.email,
          lastUsedAt: profile.lastUsedAt,
        };
      }),
    );
  }

  /** Turns an aonia error into the right HTTP status: a duplicate is 409, a bad id or missing profile is 400. */
  private accountError(error: unknown): HttpError {
    if (error instanceof AoniaError) {
      if (error.code === "profile_exists") {
        return new HttpError(409, error.message);
      }
      return new HttpError(400, error.message);
    }
    return new HttpError(500, error instanceof Error ? error.message : String(error));
  }

  /**
   * Spawns `muse login` for a profile and resolves as soon as the device URL appears in its output.
   * The child keeps running after that (the user finishes the sign-in in a browser); it exits on its
   * own. A second call for the same account id kills and replaces whatever is already running for it.
   */
  private async runLogin(id: string, profile: Profile): Promise<{ url: string; code: string | null }> {
    const command = this.aonia.loginCommand(profile);
    const runtime = await this.museRuntime();
    const resolved = command.command === "muse"
      ? this.options.musePath ?? (await this.environment(false)).musePath ?? command.command
      : command.command;
    const login = planMuseCli({ platform: this.options.platform, runtime, distro: this.wslDistro(),
      musePath: resolved, args: command.args });
    const loginEnv: Record<string, string> = this.options.platform === "win32" && runtime === "wsl"
      ? wslSpawnEnv({ ...process.env, ...command.env }, this.wslEnvWithout(command.env), PROFILE_WSLENV)
      : Object.fromEntries(
          Object.entries({ ...process.env, ...command.env }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
    const previous = this.loginChildren.get(id);
    if (previous) {
      previous.kill();
      this.loginChildren.delete(id);
    }
    const child = this.options.loginSpawn(login.command, login.args, { env: loginEnv });
    this.loginChildren.set(id, child);
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      let accumulated = "";
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill();
        this.loginChildren.delete(id);
        reject(new HttpError(504, "Muse did not return a sign-in link."));
      }, LOGIN_TIMEOUT_MS);
      const onData = (chunk: unknown) => {
        if (settled) {
          return;
        }
        accumulated += String(chunk);
        const parsed = parseLoginOutput(accumulated);
        if (parsed.url) {
          settled = true;
          clearTimeout(timer);
          resolvePromise({ url: parsed.url, code: parsed.code });
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("close", () => {
        if (this.loginChildren.get(id) === child) {
          this.loginChildren.delete(id);
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new HttpError(504, "Muse did not return a sign-in link."));
        }
      });
      child.on("error", (error) => {
        if (this.loginChildren.get(id) === child) {
          this.loginChildren.delete(id);
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  private async serveTargetFor(cwd: string, accountId: string | null = null): Promise<ServeTarget> {
    let profileEnv: Record<string, string> | null = null;
    if (accountId) {
      let profile;
      try {
        profile = await this.aonia.getProfile(accountId);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : `Unknown account "${accountId}".`);
      }
      profileEnv = this.aonia.envFor(profile);
    }
    // Sandbox posture is fixed at spawn: every host carries the settings as they stand now.
    const sandboxDisabled = this.store.getSandboxSettings().disabled;
    const yoloEnabled = this.store.getYoloSettings().enabled;
    const serveArgs = [
      "serve",
      ...(sandboxDisabled || yoloEnabled ? ["--disable-sandbox"] : []),
      ...(yoloEnabled ? ["--trust-workspace"] : []),
    ];
    if (this.options.platform !== "win32") {
      return {
        command: this.options.musePath ?? "muse",
        args: serveArgs,
        cwd: cwd || process.cwd(),
        ...(profileEnv ? { env: { ...process.env, ...profileEnv } } : {}),
      };
    }
    const runtime = await this.museRuntime();
    let musePath = this.options.musePath ?? null;
    if (!musePath || (!musePath.includes("/") && !musePath.includes("\\"))) {
      const probe = await this.environment(false);
      musePath = probe.musePath;
    }
    if (runtime === "native") {
      if (!musePath) {
        throw new HttpError(503, "Muse for Windows is not installed. Install it from PowerShell: irm https://dev.meta.ai/install.ps1 | iex");
      }
      const releaseInfo = this.releaseInfoFor(musePath);
      return {
        command: musePath,
        args: serveArgs,
        cwd: this.spawnCwdFor(cwd) || process.cwd(),
        ...(releaseInfo || profileEnv
          ? { env: { ...process.env, ...(releaseInfo ? { MUSE_RELEASE_INFO: releaseInfo } : {}), ...(profileEnv ?? {}) } }
          : {}),
      };
    }
    const plan = planServe({
      platform: "win32",
      distro: this.wslDistro(),
      musePath,
      cwd: this.spawnCwdFor(cwd),
      sandboxDisabled,
      yoloEnabled,
    });
    // An account's folders and runtime.json's variables cross into WSL for this host only.
    const env = profileEnv ? this.wslEnvFor(profileEnv, PROFILE_WSLENV) : this.wslEnvFor();
    return { command: plan.command, args: plan.args, cwd: plan.cwd, ...(env ? { env } : {}) };
  }

  /** The launcher's release details for a binary in its install folder, as the launcher itself would pass them. */
  private releaseInfoFor(binary: string): string | null {
    const version = /muse-bin-(.+)\.exe$/i.exec(win32.basename(binary))?.[1] ?? null;
    return version ? nativeReleaseInfo({ binary, dir: win32.dirname(binary), version, launcher: null }) : null;
  }

  /**
   * One notification from a host. Everything here is wrapped: this runs inside the SDK's read loop,
   * so a throw used to take the whole host connection down with it and end every session on it, not
   * just the one that produced the bad frame (#42).
   */
  private forward(hostKey: string, notification: { method: string; params?: unknown; emittedAtMs?: number }): void {
    try {
      const params = asRecord(notification.params) ?? {};
      if (notification.method === "usage/changed") {
        const usage = parseSubscriptionUsage(params);
        const accountId = this.hosts.get(hostKey)?.accountId ?? null;
        this.observeUsage(usage, accountId);
        return;
      }
      const event = toWireEvent(notification.method, params, notification.emittedAtMs);
      if (!event) {
        // No sessionId, so there is nothing to route it to. Counted rather than dropped in silence.
        this.unroutedByMethod.set(notification.method, (this.unroutedByMethod.get(notification.method) ?? 0) + 1);
        return;
      }
      this.sessionHosts.set(event.sessionId, hostKey);
      this.noteNotification(event.sessionId, notification.method);
      this.track(event.sessionId, notification.method, params, hostKey);
      this.emit("ancilla", event);
    } catch (error) {
      this.forwardFailures += 1;
      this.lastForwardFailure = `${notification.method}: ${error instanceof Error ? error.message : String(error)}`;
      this.log(`forward(${notification.method}) threw: ${this.lastForwardFailure}`);
    }
  }

  /** Records that a session's feed is alive, so a silence can later be told apart from an idle session. */
  private noteNotification(sessionId: string, method: string): void {
    let stats = this.notifyStats.get(sessionId);
    if (!stats) {
      if (this.notifyStats.size >= NOTIFY_STATS_LIMIT) {
        const oldest = this.notifyStats.keys().next();
        if (!oldest.done) {
          this.notifyStats.delete(oldest.value);
        }
      }
      stats = { lastAt: 0, count: 0, byMethod: {} };
      this.notifyStats.set(sessionId, stats);
    }
    stats.lastAt = Date.now();
    stats.count += 1;
    stats.byMethod[method] = (stats.byMethod[method] ?? 0) + 1;
  }

  /** Everything worth reading later goes to stderr, which is where the daemon's log ends up. */
  private log(message: string): void {
    process.stderr.write(`[ancilla] ${new Date().toISOString()} ${message}\n`);
  }

  private track(sessionId: string, method: string, params: Record<string, unknown>, hostKey: string | null = null): void {
    const live = this.liveFor(sessionId);
    if (["approval/requested", "approval/resolved", "userInput/requested", "userInput/settled", "session/statusChanged"].includes(method)) {
      live.activityRevision += 1;
    }
    let changed = false;
    const item = asRecord(params["item"]);
    const progressTurnId = str(item?.["turnId"]) ?? str(params["turnId"]);
    const currentProgress = progressTurnId !== null &&
      (progressTurnId === live.activeTurnId || (method === "turn/started" && live.activeTurnId === null));
    const durable = str(params["viewCursor"]) !== null && asRecord(params["sourceRange"]) !== null;
    const durableProgress = currentProgress && durable &&
      (["turn/started", "turn/completed"].includes(method) ||
        (["item/started", "item/updated", "item/completed"].includes(method) && str(item?.["itemId"]) !== null));
    if (durableProgress) {
      // Even when its lifecycle did not change, new current-turn content supersedes an older read.
      live.activityRevision += 1;
      if (live.viewHealth !== null) {
        live.viewHealth = null;
        changed = true;
      }
    } else if (durable && live.activeTurnId === null && live.viewHealth !== null && method !== "session/viewHealthChanged") {
      // With no turn running there is no current-turn progress to wait for: any durable record means the view is
      // being written again. The bump keeps a read that started before it from marking the view unavailable again.
      live.activityRevision += 1;
      live.viewHealth = null;
      changed = true;
    }
    if (method === "turn/completed" || method === "item/completed" || method === "item/updated") {
      this.noteRenameBreakage(hostKey, params);
    }
    switch (method) {
      case "turn/started": {
        live.activityRevision += 1;
        live.activeTurnId = str(params["turnId"]);
        live.turnStartedAt = nowIso();
        live.turnHost = hostKey;
        live.lastError = null;
        live.lastTerminal = null;
        changed = true;
        this.wake(sessionId);
        break;
      }
      case "turn/completed": {
        live.activityRevision += 1;
        const turnId = str(params["turnId"]);
        if (!live.activeTurnId || live.activeTurnId === turnId) {
          live.activeTurnId = null;
          live.turnStartedAt = null;
          live.turnHost = null;
        }
        const terminal = str(params["terminal"]) ?? "completed";
        live.lastTerminal = terminal;
        live.lastError = terminal === "failed" ? (str(asRecord(params["error"])?.["message"]) ?? "The turn failed.") : null;
        if (turnId) {
          try {
            this.store.recordTurn(turnId, sessionId);
            this.store.updateTurnStatus(turnId, terminal);
          } catch {
            /* session not tracked locally */
          }
        }
        changed = true;
        this.sessionsChanged();
        break;
      }
      case "session/viewHealthChanged": {
        if (params["health"] === "unavailable") {
          // Newer than any read in flight, which must not undo it.
          live.activityRevision += 1;
          live.viewHealth = { status: "unavailable", reason: str(params["noneReason"]) };
          changed = true;
        } else if (live.viewHealth !== null) {
          // Any other health means the view is back, idle session or not, and every open window hears it. The bump
          // keeps a read that found the view unavailable from marking it so again.
          live.activityRevision += 1;
          live.viewHealth = null;
          changed = true;
        }
        break;
      }
      case "approval/requested": {
        const id = str(params["approvalId"]);
        if (id && !live.pendingApprovals.has(id)) {
          live.pendingApprovals.add(id);
          changed = true;
          this.wake(sessionId);
        }
        break;
      }
      case "approval/resolved": {
        const id = str(params["approvalId"]);
        changed = id ? live.pendingApprovals.delete(id) : false;
        break;
      }
      case "userInput/requested": {
        const id = str(params["userInputId"]);
        if (id && !live.pendingInputs.has(id)) {
          live.pendingInputs.add(id);
          changed = true;
          this.wake(sessionId);
        }
        break;
      }
      case "userInput/settled": {
        const id = str(params["userInputId"]);
        changed = id ? live.pendingInputs.delete(id) : false;
        break;
      }
      case "session/closed": {
        // A read taken before the close must not reopen the turn or requests the close ended.
        live.activityRevision += 1;
        changed = live.activeTurnId !== null || live.pendingApprovals.size > 0 || live.pendingInputs.size > 0;
        live.activeTurnId = null;
        live.turnStartedAt = null;
        live.turnHost = null;
        live.pendingApprovals.clear();
        live.pendingInputs.clear();
        this.sessionHosts.delete(sessionId);
        break;
      }
      case "session/modelChanged": {
        const modelId = str(params["modelId"]);
        if (modelId) {
          // A change the user made, here or in another Muse client, is their pick; a default or a policy is not.
          this.store.updateSession(sessionId, params["source"] === "user" ? { modelId, chosenModelId: modelId } : { modelId });
        }
        break;
      }
      case "session/tokenUsage": {
        this.recordUsage(sessionId, params);
        break;
      }
      case "session/goalChanged": {
        const goal = goalOf(params["goal"]);
        // A block with no objective is not a goal; the last one stands.
        if (goal !== undefined) {
          live.goal = goal;
          live.goalSeq += 1;
          live.goalCursor = str(params["viewCursor"]);
          changed = true;
        }
        break;
      }
      case "item/completed": {
        const item = asRecord(params["item"]);
        if (item && item["kind"] === "userMessage") {
          this.maybeTitle(sessionId, item);
        }
        break;
      }
      case "session/nameChanged": {
        this.adoptMuseName(sessionId, str(params["name"]));
        break;
      }
      case "session/reasoningEffortChanged": {
        const effort = params["reasoningEffort"];
        if (isReasoningEffort(effort)) {
          this.effortApplied.set(sessionId, effort);
        }
        break;
      }
      case "skill/changed": {
        // The next skill list for this session's workspace goes back to Muse instead of the cache.
        const found = this.store.findSession(sessionId);
        this.skillCache.delete(found?.cwd || "__default__");
        break;
      }
      default:
        break;
    }
    if (changed) {
      this.emitStatus(sessionId);
    }
  }

  /**
   * Gives Muse the name typed or generated here, so the CLI, `/name` addressing and other clients see it too, when
   * sharing titles was switched on. Only a host that already has the session loaded is asked, and never one whose
   * Muse showed the rename-broken event log; the local title stands either way, since a thread that never loads
   * still deserves the name the user gave it.
   */
  private async renameInMuse(sessionId: string, name: string): Promise<void> {
    if (!this.options.syncSessionNames) return;
    const hostKey = this.sessionHosts.get(sessionId);
    const managed = hostKey ? this.hosts.get(hostKey) : undefined;
    if (!managed || this.renameRefused.has(managed.key)) {
      return;
    }
    try {
      await managed.manager.renameSession(sessionId, name);
    } catch (error) {
      // An ephemeral session, or a host without session/rename, is fine; a log the rename cannot be written to is not.
      this.refuseRenames(managed.key, errorInfo(error).message);
    }
  }

  /** Watches failures for the rename-broken event log, from the turn itself or from a workflow item within it. */
  private noteRenameBreakage(hostKey: string | null, params: Record<string, unknown>): void {
    if (!hostKey || !this.options.syncSessionNames || this.renameRefused.has(hostKey)) {
      return;
    }
    const error = params["error"];
    if (error !== undefined && error !== null) {
      this.refuseRenames(hostKey, typeof error === "string" ? error : JSON.stringify(error));
    }
    const item = asRecord(params["item"]);
    // Only a failed item is read through; a swarm's many healthy updates cost nothing here.
    if (item && (/fail|error/i.test(str(item["status"]) ?? "") || (item["error"] !== undefined && item["error"] !== null))) {
      this.refuseRenames(hostKey, JSON.stringify(item));
    }
  }

  /** Stops sending titles to a host once its Muse reports the rename-broken event log, and says so once. */
  private refuseRenames(hostKey: string, message: string): void {
    if (this.renameRefused.has(hostKey) || !RENAME_DECODE_FAILURE.test(message)) {
      return;
    }
    this.renameRefused.add(hostKey);
    this.log(
      `Muse on host ${hostKey} reported "missing field kind" while reading a session's event log, which a session/rename ` +
        "can cause; thread titles are no longer sent to it and stay in Ancilla only",
    );
  }

  /**
   * The file viewer. Every call names a project folder the user added, never an arbitrary path: the folder is where
   * reading and writing are confined, and a path that leaves it is refused.
   */
  private async files(method: string, path: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = method === "PUT" || method === "POST" ? await this.readBody(req) : {};
    const cwd = str(body["cwd"]) ?? url.searchParams.get("cwd");
    if (!cwd || !this.store.getProject(cwd)) {
      throw new HttpError(404, "Unknown project folder.");
    }
    let root: string;
    try {
      root = resolveUserPath(cwd, await this.pathContext(cwd)).local;
    } catch {
      root = this.localPathFor(cwd);
    }
    const target = str(body["path"]) ?? url.searchParams.get("path") ?? "";
    if (method === "GET" && path === "/api/files/list") {
      this.json(res, 200, await listFolder(root, cwd, target));
      return true;
    }
    if (method === "GET" && path === "/api/files/read") {
      this.json(res, 200, await readProjectFile(root, cwd, target));
      return true;
    }
    if ((method === "GET" || method === "HEAD") && path === "/api/files/raw") {
      await serveProjectFile(req, res, root, cwd, target);
      return true;
    }
    if (method === "GET" && path === "/api/files/search") {
      this.json(res, 200, { files: await searchProjectFiles(root, url.searchParams.get("q") ?? "") });
      return true;
    }
    if (method === "PUT" && path === "/api/files/write") {
      const content = body["content"];
      if (typeof content !== "string") {
        throw new HttpError(400, "content is required.");
      }
      const base = body["baseMtimeMs"];
      this.json(res, 200, await writeProjectFile(root, cwd, target, content, typeof base === "number" ? base : null));
      return true;
    }
    if (method === "POST" && path === "/api/files/open") {
      const { abs } = await resolveInRoot(root, target, cwd);
      await this.opener(abs, "files");
      this.json(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  /** A newer subscription window from any host replaces the one held, and every open window hears about it. */
  private observeUsage(usage: SubscriptionUsage | null, accountId: string | null = null): void {
    if (!usage) {
      return;
    }
    let changed = false;
    if (accountId) {
      const prior = this.planUsageByAccount.get(accountId);
      if (!prior || prior.observedAtMs < usage.observedAtMs) {
        this.planUsageByAccount.set(accountId, usage);
        changed = true;
      }
    }
    if (!this.planUsage || this.planUsage.observedAtMs < usage.observedAtMs) {
      this.planUsage = usage;
      changed = true;
    }
    if (changed) {
      this.emit("ancilla", { type: "plan-usage", usage, accountId });
    }
  }

  /** Asks every running host what it last saw; none is started just for this, since it would have seen nothing. */
  private async readPlanUsage(): Promise<{ usage: SubscriptionUsage | null; byAccount: Record<string, SubscriptionUsage> }> {
    await Promise.all(
      [...this.hosts.values()].map(async (managed) => {
        try {
          this.observeUsage(await managed.manager.readSubscriptionUsage(), managed.accountId);
        } catch {
          /* an older host without usage/read */
        }
      }),
    );
    return { usage: this.planUsage, byAccount: Object.fromEntries(this.planUsageByAccount) };
  }

  /** Muse named or renamed the session, here or in another client; the newest name wins, and a typed title stays typed. */
  private adoptMuseName(sessionId: string, name: string | null): void {
    const title = name?.trim().slice(0, 200);
    const record = title ? this.store.getSession(sessionId) : null;
    if (!title || !record || record.title === title) {
      return;
    }
    if (!this.options.syncSessionNames && record.titleSource !== "placeholder") return;
    // A Muse-selected name is never upgraded, even if an echo here owed an attempt.
    this.titleUpgradePending.delete(sessionId);
    this.store.updateSession(sessionId, { title, titleSource: record.titleSource === "user" ? "user" : "auto" });
    this.sessionsChanged();
  }

  /**
   * Puts a session on the effort a turn asks for. `muse serve` 1.3.0 drops the effort sent with `turn/start`
   * (muse-code-sdk#6) but honours the session default, so that is what carries it. A host without the method
   * leaves the turn's own effort to do what it can; a session that is not loaded fails the turn the same way.
   */
  private async applyEffort(manager: SessionManager, sessionId: string, effort: ReasoningEffort): Promise<void> {
    if (this.effortApplied.get(sessionId) === effort) {
      return;
    }
    try {
      await manager.setReasoningEffort(sessionId, effort);
      this.effortApplied.set(sessionId, effort);
    } catch (error) {
      const kind = errorInfo(error).kind;
      if (kind === "sessionNotLoaded" || kind === "sessionStreamMismatch" || kind === "sessionNotFound") {
        throw error;
      }
    }
  }

  private maybeTitle(sessionId: string, item: Record<string, unknown>): void {
    const record = this.store.getSession(sessionId);
    if (!record || record.titleSource !== "placeholder") {
      return;
    }
    const raw = str(item["displayText"]) ?? str(item["text"]) ?? "";
    const title = deriveTitle(raw);
    if (title) {
      this.store.updateSession(sessionId, { title, titleSource: "auto" });
      this.titleUpgradePending.add(sessionId);
      // The text is in hand, so no queue and no re-page; the upgrade never throws.
      void this.maybeUpgradeThreadTitle(sessionId, raw);
      this.sessionsChanged();
    }
  }
}

function titleFromEvents(events: { method: string; params: Record<string, unknown> }[]): string | null {
  for (const event of events) {
    const item = asRecord(event.params["item"]);
    if (item && item["kind"] === "userMessage") {
      const title = deriveTitle(str(item["displayText"]) ?? str(item["text"]) ?? "");
      if (title) {
        return title;
      }
    }
  }
  return null;
}

/** The raw opening prompt behind an echo title, for asking Muse for a better one. */
function firstUserText(events: { method: string; params: Record<string, unknown> }[]): string | null {
  for (const event of events) {
    const item = asRecord(event.params["item"]);
    if (item && item["kind"] === "userMessage") {
      const text = str(item["displayText"]) ?? str(item["text"]) ?? "";
      if (text.trim()) {
        return text;
      }
    }
  }
  return null;
}

export async function resolveMusePath(
  platform: string,
  distro: string,
): Promise<string | null> {
  if (platform === "win32") {
    const probe = await probeEnvironment(defaultExec, platform);
    void distro;
    return probe.musePath;
  }
  const found = await defaultExec("sh", ["-lc", "command -v muse"]);
  if (found.exitCode !== 0) {
    return null;
  }
  return found.stdout.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;
}

export { resolveMuseInDistro };
