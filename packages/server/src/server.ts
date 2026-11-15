import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { extname, join, normalize, posix, resolve, sep, win32 } from "node:path";
import type { Duplex, Readable, Writable } from "node:stream";

import {
  AncillaMspHost,
  AncillaStore,
  HostStartTimeoutError,
  SessionManager,
  isApprovalMode,
  isGoalAction,
  isIfBusy,
  isReasoningEffort,
  isStoreBusy,
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
  resolveResearchConfig,
  runResearch,
  type ApprovalMode,
  type AttachmentRecord,
  type CommandConnection,
  type ExecFn,
  type ExecResult,
  type ResearchConfig,
  type ResearchRunRecord,
  type ResearchRunState,
  type ResearchRunView,
  type Project,
  type ServeTarget,
  type HostPosture,
  type ReasoningEffort,
  type SessionRecord,
  type SessionSkill,
  type SubscriptionUsage,
  type TurnImage,
  BUILTIN_PROVIDER_IDS,
  PROVIDER_CATALOG,
  UnsupportedCapabilityError,
  capabilitiesForProvider,
  createCliAgentHost,
  descriptorForProvider,
  isProviderId,
  normalizeProviderId as normalizeProviderIdValue,
  planProviderCli,
  planProviderServe,
  probeAllBuiltinProviders,
  probeProviderBinary,
  type ApiProviderKind,
  type BuiltinProviderId,
  type ProviderAccountRecord,
  type ProviderBinaryProbe,
  type ProviderCapabilities,
  type ProviderId,
} from "@ancilla/daemon";

import { ApiAgentHost } from "./providers/apiAgentHost.js";
import { extractLoginFailureMessage, parseProviderLoginOutput } from "./providers/loginParser.js";
import {
  META_MUSE_CODE_MODEL_IDS,
  buildAuthenticatedMuseFallbackCatalog,
  isMuse1415OrNewer,
  readCachedMuseCatalog,
  readCachedMuseCatalogSync,
} from "./providers/museCatalog.js";
import { ProfileIsolator, detectAmbientKeyOverrides } from "./providers/profiles.js";
import { OpenAiCompatibleProvider, AnthropicProvider, GoogleGenAiProvider } from "./voice/brain.js";
import { crossSiteApiRequest, isLoopbackBind, normalizeHost, parseAllowHosts, safeDecode, safeEqual, trustedHost, trustedHostSet } from "./admission.js";
import { attachmentHeaders, normalizeMediaType } from "./attachments.js";
import { FileError, listFolder, readProjectFile, resolveInRoot, searchProjectFiles, serveProjectFile, writeProjectFile } from "./files.js";
import { DEFAULT_HOST_WAITS, HOST_START_TIMEOUT_ENV, closeInBackground, resolveHostStartTimeoutMs, settledWithin, type HostWaits } from "./hostBounds.js";
/** The database Ancilla keeps in its data dir. */
export const DB_FILE = "ancilla.db";
import { BOOT_BUDGET_MS, OWNER_POLL_MS, claimOwnerLock, defaultOwnerLockDeps, type OwnerLock, type OwnerLockDeps } from "./ownerLock.js";
import { PathError, createDirectory, listDirectory, resolveUserPath, type PathContext } from "./paths.js";
import { SHELL_TIMEOUT_MS, runCapture, stopPendingCaptures, type PendingCaptures } from "./runCapture.js";
import { wslSpawnEnv } from "./runtimeConfig.js";
import { SseBroadcaster } from "./sse.js";
import { buildThreadTitlePrompt, deriveTitle, parseExecTitle, sanitizeThreadTitle } from "./threadTitles.js";
import { replayUsageAt, turnStartTimes } from "./usageTime.js";
import { dayBucketer, usageWindow } from "./usageWindow.js";
import { WSL_HOME_RETRY_MS, WSL_HOME_TIMEOUT_MS, WSL_READ_TIMEOUT_MS, WslHomes, isDistroName, linuxAuthPath, localAuthPath, withinMs } from "./wslLogin.js";
import { ATTACHMENT_DIR, RESEARCH_DIR, assertWritableFile, entryState, ownedProjectDir, writeAttachment, type AttachmentWriter } from "./workspaceWrite.js";
import {
  BOOT_SWEEP_RETRY_MS,
  MAX_RESEARCH_QUESTION_CHARS,
  MIN_RESEARCH_STARTUP_ENV_MS,
  MuseExecModelClient,
  MuseModelClient,
  MuseSessionModelClient,
  MuseSessionWorkerRunner,
  ResearchJobManager,
  approvalSubjectOf,
  gaveUpOnTimeout,
  museExecArgs,
  planApproval,
  researchStartupAllowanceMs,
  startupEnvMs,
  uuidv7,
  type MuseExecPlan,
  type ResearchEngine,
  type ResearchThread,
  type SessionNotificationHandler,
  type TurnSession,
  type WorkerSessionHandle,
  type WorkerUpdate,
} from "./research/index.js";
import { exportFileName, exportFormatOfName, isExportFormat, questionSlug, renderReport, serveExportFile } from "./research/export/index.js";
import { handleAssistant, isAssistantPath, type AssistantReply } from "./assistant/routes.js";
import { AuthorizationHub, LaunchManager, type PlannedSpawn } from "./assistant/launcher.js";
import { handleVoice, isVoicePath } from "./voice/routes.js";
import type { HarnessMessage, HarnessReader, HarnessThread, HarnessUsage } from "./voice/harness.js";
import type { MuseBrainHost } from "./voice/muse-brain.js";
import { VoiceService } from "./voice/service.js";
import type { WorkspaceProjectRef, WorkspaceVoiceDeps } from "./voice/workspace-tools.js";
import { handleBrowser, isBrowserPath } from "./browser/routes.js";
import { BrowserError, BrowserService } from "./browser/service.js";
import { VoiceSocketServer, VOICE_SOCKET_PATH } from "./voice/ws.js";
import { BrowserSocketServer, BROWSER_SOCKET_PATH } from "./browser/ws.js";
import { BrowserWatchServer, BROWSER_WATCH_PATH } from "./browser/watch.js";
import { BrowseRunner } from "./browser/runner.js";
import { BrowseSites, hostKind, isRestrictedAssistantUrl } from "./browser/sites.js";
import { AuditLog } from "./connectors/audit.js";
import { makeOpener } from "./connectors/connection.js";
import { ConnectorRegistry } from "./connectors/registry.js";
import { handleConnectors, isConnectorPath } from "./connectors/routes.js";
import { ConnectorRunner } from "./connectors/runner.js";
import { FileSecretStore } from "./connectors/secrets.js";
import { runBrainReadStep, runBrainWriteStep } from "./assistant/brain-step.js";
import { AmbiguousStartError, type ExecutiveHost, type FallbackReadRunner, type FallbackWriteRunner } from "./assistant/executive.js";
import { ASSISTANT_DB_FILE, AssistantService } from "./assistant/service.js";
import {
  createProfileManager,
  createProfilesManager,
  parseLoginOutput,
  ProfileError,
  type Profile,
  type ProfileManager,
  type ProfileRecord,
} from "./profiles/index.js";
import { LinuxMuseInstaller } from "./linuxMuseInstaller.js";
import {
  loginIdentity,
  MuseSubscriptionReader,
  subscriptionIdentity,
  type MuseUsageCliRequest,
  type MuseUsageCliResult,
  type PlanAccountUsage,
  type SubscriptionReading,
} from "./subscriptionQuota.js";
import { ensureMuseStorage, inspectMuseStorage, repairMuseStorage, type MuseStorageDiagnosis, type MuseStorageOptions } from "./museStorage.js";

export const ANCILLA_VERSION = "0.29.0";

/** Information describing why and how a host process exited. */
export interface HostExit {
  code: number | null;
  signal: string | null;
  reason?: "connection-ended";
}

/** Operational stats recording incoming notification activity per session. */
export interface SessionNotifyStats {
  lastAt: number;
  count: number;
  byMethod: Record<string, number>;
}

const NOTIFY_STATS_LIMIT = 200 as const;

/** Subprocess handle interface for communicating with a running host. */
export interface HostHandle {
  start(targetVersion: string): Promise<unknown>;
  connection: CommandConnection;
  close(): Promise<unknown>;
  onExit?(listener: (exitInfo: HostExit) => void): void;
  readonly recentStderr?: string;
  readonly capabilities?: ProviderCapabilities;
}

export type HostFactory = (target: ServeTarget) => HostHandle;

export type ProviderHostFactory = (spec: {
  providerId: ProviderId;
  accountId: string | null;
  cwd: string;
  target: ServeTarget;
}) => HostHandle | null | undefined;

export type OpenTarget = "files" | "editor";
export type Opener = (targetPath: string, targetType: OpenTarget) => Promise<void>;

/** Process interface for interactive sign-in child processes. */
export interface LoginChild {
  stdin?: Writable | null;
  stdout: Readable;
  stderr: Readable;
  on(event: "close" | "error", listener: (arg: unknown) => void): void;
  kill(): void;
}

export type LoginSpawn = (cmd: string, args: string[], options: { env: Record<string, string> }) => LoginChild;

const defaultLoginSpawn: LoginSpawn = (cmd, args, opts) => {
  const mergedEnv = { ...process.env, ...opts.env };
  return spawn(cmd, args, {
    cwd: homedir(),
    env: mergedEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as unknown as LoginChild;
};

export type ShellRunner = (
  cmd: string,
  args: string[],
) => Promise<{ output: string; exitCode: number | null; truncated: boolean }>;

export interface ServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  staticDir?: string | null;
  token?: string | null;
  allowOrigins?: string[];
  allowHosts?: string[];
  platform?: string;
  distro?: string;
  musePath?: string | null;
  profiles?: ProfileManager;
  runtime?: RuntimePreference;
  syncSessionNames?: boolean;
  wslEnv?: Record<string, string>;
  findNativeMuse?: () => NativeMuse | null;
  hostFactory?: HostFactory;
  providerHostFactory?: ProviderHostFactory;
  opener?: Opener;
  home?: string;
  autoSettleDays?: number | null;
  exec?: ExecFn;
  shellRunner?: ShellRunner;
  loginSpawn?: LoginSpawn;
  linuxInstaller?: LinuxMuseInstaller;
  subscriptionReader?: MuseSubscriptionReader;
  wslQuota?: {
    localPath?: (distro: string, linuxPath: string) => string | null | Promise<string | null>;
    homeTimeoutMs?: number;
    readTimeoutMs?: number;
    retryMs?: number;
  };
  researchEngine?: ResearchEngine;
  researchMaxWorkers?: number;
  researchStartupMs?: number;
  attachmentWriter?: AttachmentWriter;
  sseMaxBacklogBytes?: number;
  sseStallMs?: number;
  hostStartTimeoutMs?: number;
  hostWaits?: HostWaits;
  bootSweepRetryMs?: readonly number[];
  dataDirLock?: boolean;
  ownerLock?: Partial<OwnerLockDeps>;
  bootBudgetMs?: number;
}

interface StartToken {
  handle: HostHandle | null;
  abandoned: boolean;
  closing: boolean;
}

interface ManagedHost {
  providerId: ProviderId;
  quotaCacheScope: string | null;
  quotaAccountGeneration: number;
  key: string;
  accountId: string | null;
  target: ServeTarget;
  handle: HostHandle;
  manager: SessionManager;
  serverVersion: string | null;
  museHome: string | null;
  startedAt: string;
}

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
  turnHost: string | null;
  pendingApprovals: Set<string>;
  pendingInputs: Set<string>;
  lastTerminal: string | null;
  lastError: string | null;
  goal: GoalBlock | null;
  goalSeq: number;
  goalCursor: string | null;
  activityRevision: number;
  viewHealth: { status: string; reason: string | null } | null;
  readOnlyReason: string | null;
  provisional: Set<string>;
}

const PROFILE_WSLENV: string[] = ["XDG_CONFIG_HOME/pu", "XDG_DATA_HOME/pu"];
const PROVISIONAL_LIMIT = 64 as const;

function cursorAfter(first: string | null, second: string | null): boolean {
  const matchFirst = first?.match(/^(v:.+):(\d+)$/);
  const matchSecond = second?.match(/^(v:.+):(\d+)$/);
  if (!matchFirst || !matchSecond || matchFirst[1] !== matchSecond[1]) {
    return false;
  }
  return BigInt(matchFirst[2]!) > BigInt(matchSecond[2]!);
}

const RENAME_DECODE_FAILURE = new RegExp("payload decode failed: missing field kind", "i");

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

function goalOf(val: unknown): GoalBlock | null | undefined {
  if (val === null || val === undefined) {
    return null as null;
  }
  const obj = asRecord(val);
  const taskObjective = obj ? str(obj["objective"]) : null;
  if (!obj || !taskObjective) {
    return undefined as undefined;
  }
  const ongoingWork = str(obj["currentWork"]);
  const upcomingWork = str(obj["nextWork"]);
  const goalResult: GoalBlock = {
    objective: taskObjective,
    status: str(obj["status"]) ?? "active",
    percentComplete: num(obj["percentComplete"]) ?? 0,
    ...(ongoingWork ? { currentWork: ongoingWork } : {}),
    ...(upcomingWork ? { nextWork: upcomingWork } : {}),
  };
  return goalResult;
}

const RESEARCH_ORIGIN_CACHE_LIMIT = 4096;
const RESEARCH_MISS_MS = 1_000;
const MAX_HISTORY_PAGES = 4 as const;
const HISTORY_PAGE_SIZE = 1000 as const;
const DISCOVER_LIMIT = 200 as const;
const DISCOVER_MAX_PAGES = 20 as const;
const MAX_ABANDONED_RESEARCH_STARTS = 2 as const;
const TITLE_BACKFILL_LIMIT = 30 as const;
const ENV_CACHE_MS = 30_000 as const;
const CLONE_TIMEOUT_MS = 600_000 as const;
const AUTO_SETTLE_SWEEP_MS = 60_000 as const;
const ASSISTANT_RETRY_MS = 30_000 as const;
const LOGIN_TIMEOUT_MS = 30_000 as const;
const LOGIN_COMPLETE_TIMEOUT_MS = 600_000 as const;

class HttpError extends Error {
  constructor(
    readonly status: number,
    errMessage: string,
  ) {
    super(errMessage);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Extracts a single request header value as string, ignoring array headers. */
function headerText(request: IncomingMessage, headerName: string): string | undefined {
  const headerVal = request.headers[headerName.toLowerCase()];
  return typeof headerVal === "string" ? headerVal : undefined;
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return typeof val === "object" && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function runningPromptTotal(src: Record<string, unknown> | null): number | null {
  const tokenUsage = asRecord(src?.["tokenUsage"]);
  const cumulative = asRecord(tokenUsage?.["cumulative"]);
  const count = cumulative?.["promptTokens"] ?? tokenUsage?.["promptTokens"];
  return num(count) ?? null;
}

function str(val: unknown): string | null {
  return typeof val === "string" && val.length > 0 ? val : null;
}

function sameSubscriptionUsage(
  first: SubscriptionUsage | null | undefined,
  second: SubscriptionUsage | null | undefined,
): boolean {
  if (!first || !second) {
    return false;
  }
  if (first.observedAtMs !== second.observedAtMs || first.tier !== second.tier) {
    return false;
  }
  const buckets = ["window", "weekly"] as const;
  for (const b of buckets) {
    const f = first[b];
    const s = second[b];
    if (
      f.usedPercent !== s.usedPercent ||
      f.resetsAtMs !== s.resetsAtMs ||
      f.windowDurationMins !== s.windowDurationMins
    ) {
      return false;
    }
  }
  return true;
}

const QUOTA_CLOCK_SKEW_MS = 5 * 60_000;
const QUOTA_RESTORED_AGE_MS = 30 * 60_000;

function num(val: unknown): number | undefined {
  return typeof val === "number" && Number.isFinite(val) ? val : undefined;
}

function firstString(obj: Record<string, unknown>, candidateKeys: string[]): string | null {
  for (const k of candidateKeys) {
    const candidate = str(obj[k]);
    if (candidate) {
      return candidate;
    }
  }
  return (null as null);
}

function isWindowsAbs(targetPath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(targetPath);
}

function isWslAbs(targetPath: string): boolean {
  return targetPath.startsWith("/");
}

function nowIso(): string {
  const currentIso = new Date().toISOString();
  return currentIso;
}

function lastLines(sourceText: string): string {
  const lines = sourceText.trim().split(/\r?\n/);
  const nonBlank = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  return nonBlank.slice(-3).join(" ");
}

/** Executes a subprocess command with timeout and returns rejection on failure. */
function runProcess(
  executable: string,
  cmdArgs: string[],
  timeoutDurationMs: number,
  processEnv?: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const mergedEnv = processEnv ?? {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      WSLENV: [process.env["WSLENV"], "GIT_TERMINAL_PROMPT/u"].filter(Boolean).join(":"),
    };
    const proc = spawn(executable, cmdArgs, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: mergedEnv,
    });
    let collectedStderr = "";
    proc.stderr?.on("data", (dataChunk: Buffer) => {
      collectedStderr = (collectedStderr + dataChunk.toString()).slice(-4000);
    });
    const killTimer = setTimeout(() => {
      proc.kill();
      rejectPromise(new HttpError(504, "The clone took too long to complete."));
    }, timeoutDurationMs);

    proc.on("error", (spawnErr) => {
      clearTimeout(killTimer);
      rejectPromise(spawnErr);
    });

    proc.on("close", (exitStatus) => {
      clearTimeout(killTimer);
      if (exitStatus === 0) {
        resolvePromise();
      } else {
        const details = lastLines(collectedStderr);
        rejectPromise(
          new HttpError(
            502,
            details.length > 0
              ? `Git clone failed: ${details}`
              : `Git clone exited with status ${exitStatus ?? "unknown"}.`,
          ),
        );
      }
    });
  });
}

/** Converts an MSP timestamp string to standardized JavaScript ISO-8601 string. */
export function normalizeIso(timestampInput: unknown): string | undefined {
  if (typeof timestampInput !== "string") {
    return (undefined as undefined);
  }
  const parsedEpoch = Date.parse(timestampInput);
  return Number.isNaN(parsedEpoch) ? undefined : new Date(parsedEpoch).toISOString();
}

function normalizeCwd(rawPath: string): string {
  const trimmedPath = rawPath.trim();
  if (/^[A-Za-z]:[\\/]?$/.test(trimmedPath) || trimmedPath === "/") {
    return trimmedPath;
  }
  return trimmedPath.replace(/[\\/]+$/, "");
}

/** Sanitizes an attachment filename to ensure safe workspace writing on Windows and Linux. */
export function safeFileName(rawCandidate: string | null): string {
  const parts = (rawCandidate ?? "").split(/[\\/]/);
  const baseName = parts.pop() ?? "";
  const cleanedLeading = baseName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "");
  const prefix = cleanedLeading.split(".", 1)[0] ?? "";
  const safeBase = WINDOWS_DEVICE_NAME.test(prefix) ? `_${cleanedLeading}` : cleanedLeading;
  const truncated = safeBase.slice(0, 80).replace(/[-.]+$/, "");
  return truncated.length > 0 ? truncated : "file";
}

const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export { deriveTitle };

function errorInfo(err: unknown): { status: number; message: string; kind: string | null } {
  if (err instanceof HttpError) {
    return { status: err.status, message: err.message, kind: null };
  }
  const errorObj = err as { kind?: unknown; message?: unknown };
  const errKind = typeof errorObj?.kind === "string" ? errorObj.kind : null;
  const errMsg = err instanceof Error ? err.message : String(err);

  if (
    process.platform === "linux" &&
    /read surviving deletion authority|deletion registry authority is unavailable/i.test(errMsg)
  ) {
    return {
      status: 409,
      kind: "muse_storage_unavailable",
      message:
        "Muse could not safely open its saved-session registry. Open Settings \u2192 Linux setup to check the affected account\u2019s storage. Ancilla keeps your login and history intact; it will not reset the registry.",
    };
  }
  if (err instanceof PathError || err instanceof ProjectFolderError) {
    return { status: 400, message: errMsg, kind: null };
  }
  if (err instanceof UnsupportedCapabilityError || errKind === "unsupportedCapability") {
    return { status: 400, message: errMsg, kind: "unsupportedCapability" };
  }
  if (err instanceof FileError) {
    return { status: err.status, message: errMsg, kind: err.kind };
  }
  if (err instanceof SyntaxError) {
    const jsonSyntaxError = { status: 400, message: "Request body is not valid JSON.", kind: null };
    return jsonSyntaxError;
  }
  const notFoundKinds = new Set(["sessionNotFound", "notFound", "approvalNotFound", "userInputNotFound"]);
  if (errKind && notFoundKinds.has(errKind)) {
    return { status: 404, message: errMsg, kind: errKind };
  }
  if (errKind) {
    return { status: 409, message: errMsg, kind: errKind };
  }
  return { status: 500, message: errMsg, kind: null };
}

function stripSource(notificationParams: Record<string, unknown>): Record<string, unknown> {
  const resultParams = { ...notificationParams };
  delete resultParams["sourceRange"];
  return resultParams;
}

function stripEvent(eventData: unknown): { method: string; params: Record<string, unknown> } | null {
  const eventRecord = asRecord(eventData);
  const methodName = eventRecord ? str(eventRecord["method"]) : null;
  const rawParams = eventRecord ? asRecord(eventRecord["params"]) : null;
  if (!methodName || !rawParams) {
    return (null as null);
  }
  return { method: methodName, params: stripSource(rawParams) };
}

function asHistoryItem(val: unknown): Record<string, unknown> | null {
  const candidate = asRecord(val);
  return candidate && typeof candidate["itemId"] === "string" ? candidate : null;
}

/** Extracts and deduplicates history items from a `session/read` response payload. */
export function eventsFromHistory(payload: unknown): { method: string; params: Record<string, unknown> }[] {
  const payloadRecord = asRecord(payload);
  if (!payloadRecord) {
    return ([] as { method: string; params: Record<string, unknown> }[]);
  }
  const historyBlock = asRecord(payloadRecord["history"]) ?? payloadRecord;
  const inlineList = Array.isArray(historyBlock["items"]) ? historyBlock["items"] : [];
  const snapshotBlock = asRecord(historyBlock["snapshot"]);
  const snapshotState = asRecord(snapshotBlock?.["state"]);
  const snapshotItemList = Array.isArray(snapshotState?.["items"]) ? snapshotState["items"] : [];
  const bagMap = asRecord(snapshotState?.["items"]);
  const itemOrder = Array.isArray(snapshotState?.["order"])
    ? snapshotState["order"]
    : bagMap
      ? Object.keys(bagMap)
      : [];
  const orderedBagItems = bagMap ? itemOrder.map((key) => bagMap[String(key)]) : [];

  const combinedItems = [...inlineList, ...snapshotItemList, ...orderedBagItems]
    .map(asHistoryItem)
    .filter((item): item is Record<string, unknown> => item !== null);

  const seenIds = new Set<string>();
  const emittedEvents: { method: string; params: Record<string, unknown> }[] = [];

  for (const itemRecord of combinedItems) {
    const itemId = String(itemRecord["itemId"]);
    if (seenIds.has(itemId)) {
      continue;
    }
    seenIds.add(itemId);
    emittedEvents.push({
      method: "item/completed",
      params: { item: stripSource(itemRecord) },
    });
  }
  return emittedEvents;
}

/** Transforms an internal notification event into a client-safe wire event format. */
export function toWireEvent(
  methodName: string,
  eventParams: Record<string, unknown>,
  timestampMs?: number,
): { type: "msp"; sessionId: string; method: string; params: Record<string, unknown>; at: number } | null {
  const sessionBlock = asRecord(eventParams["session"]);
  const resolvedSessionId =
    str(eventParams["sessionId"]) ?? (sessionBlock ? str(sessionBlock["sessionId"]) : null);
  if (!resolvedSessionId) {
    return (null as null);
  }
  return {
    type: "msp",
    sessionId: resolvedSessionId,
    method: methodName,
    params: stripSource(eventParams),
    at: timestampMs ?? Date.now(),
  };
}

const CMD_UNSAFE: RegExp = /[&|<>^%!"\r\n]/;

export function defaultOpener(currentPlatform: string): Opener {
  return (filePath, targetKind) =>
    new Promise<void>((resolveOpen, rejectOpen) => {
      let shellCmd: string;
      let shellArgs: string[];

      if (currentPlatform === "win32") {
        if (CMD_UNSAFE.test(filePath)) {
          rejectOpen(
            new HttpError(400, "That folder path contains characters Ancilla will not pass to the shell."),
          );
          return;
        }
        if (targetKind === "editor") {
          shellCmd = "cmd.exe";
          shellArgs = ["/d", "/c", "code", filePath];
        } else {
          shellCmd = "explorer.exe";
          shellArgs = [filePath];
        }
      } else if (currentPlatform === "darwin") {
        shellCmd = targetKind === "editor" ? "code" : "open";
        shellArgs = [filePath];
      } else {
        shellCmd = targetKind === "editor" ? "code" : "xdg-open";
        shellArgs = [filePath];
      }

      const childProc = spawn(shellCmd, shellArgs, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });

      childProc.once("error", (spawnError) => {
        rejectOpen(
          new HttpError(
            500,
            targetKind === "editor"
              ? `Could not launch VS Code (${spawnError.message}). Make sure the \`code\` command is on your PATH.`
              : `Could not open the folder (${spawnError.message}).`,
          ),
        );
      });

      childProc.once("spawn", () => {
        childProc.unref();
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
  argumentHint?: string | null;
}

/** Merges session-specific skill descriptors with workspace-level CLI skill listings. */
export function mergeSessionSkills(
  sessionSkills: readonly SessionSkill[],
  cliSkills: readonly SkillView[],
): SkillView[] {
  const index = new Map<string, SkillView>();
  for (const skill of cliSkills) {
    index.set(skill.id, skill);
    if (!index.has(skill.name)) {
      index.set(skill.name, skill);
    }
  }

  return sessionSkills.map((row) => {
    const matched = index.get(row.selector) ?? index.get(`plugin:${row.selector}`) ?? null;
    const skillView: SkillView = {
      id: matched?.id ?? row.selector,
      name: row.selector,
      displayName: row.displayName,
      description: row.description || matched?.description || "",
      shortDescription: matched?.shortDescription ?? null,
      scope: matched?.scope ?? row.source,
      activation: matched?.activation ?? "on",
      argumentHint: row.argumentHint,
    };
    return skillView;
  });
}

interface SkillListing {
  at: number;
  skills: SkillView[];
  paths: Map<string, string>;
  error: string | null;
}

/** Parses the JSON output produced by `muse skills list --json`. */
export function parseSkillList(
  jsonOutput: string,
): { skills: SkillView[]; paths: Map<string, string> } | null {
  let parsedJson: Record<string, unknown> | null;
  try {
    parsedJson = asRecord(JSON.parse(jsonOutput));
  } catch {
    return (null as null);
  }
  if (!parsedJson || !Array.isArray(parsedJson["skills"])) {
    return (null as null);
  }

  const resultSkills: SkillView[] = [];
  const filePaths = new Map<string, string>();

  for (const rawEntry of parsedJson["skills"]) {
    const entryObj = asRecord(rawEntry);
    const skillId = entryObj ? str(entryObj["id"]) : null;
    if (!entryObj || !skillId || str(entryObj["activation"]) === "off") {
      continue;
    }
    const skillName = str(entryObj["name"]) ?? skillId;
    resultSkills.push({
      id: skillId,
      name: skillName,
      displayName: str(entryObj["display_name"]) ?? skillName,
      description: str(entryObj["description"]) ?? "",
      shortDescription: str(entryObj["short_description"]),
      scope: str(entryObj["scope"]) ?? "unknown",
      activation: str(entryObj["activation"]) ?? "on",
    });

    const skillPath = str(entryObj["path"]);
    if (skillPath) {
      filePaths.set(skillId, skillPath);
    }
  }

  return { skills: resultSkills, paths: filePaths };
}

/** Strips YAML frontmatter blocks from a skill markdown document. */
export function stripFrontmatter(markdownText: string): string {
  return markdownText.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "").trim();
}

const SKILL_CACHE_MS = 60_000 as const;
const BYTES_PER_MEBIBYTE = 1024 * 1024;
const OUTPUT_PAGE_BYTES = 1 * BYTES_PER_MEBIBYTE;
const MAX_ATTACHMENTS = 10 as const;
const MAX_ATTACHMENT_BYTES = 12 * BYTES_PER_MEBIBYTE;
const MAX_BODY_BYTES = 96 * BYTES_PER_MEBIBYTE;
const MIN_AUTH_BODY_BYTES = 4 * 1024;
const MAX_REFUSED_HOSTS_LOGGED = 5;
const MAX_HOST_NAME_LENGTH = 253;
const FRAME_HEADERS = {
  "content-security-policy": "frame-ancestors 'self'",
  "x-frame-options": "SAMEORIGIN",
} as const;
const PREPARED_REUSE_MS = 10 * 60_000;
const PREPARED_REUSE_MAX = 64;

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
  private readonly trustedHosts: ReadonlySet<string>;
  private readonly enforceHost: boolean;
  private readonly refusedHostsLogged = new Set<string>();
  private hostRefusals = 0;
  private lastRefusedHost: string | null = null;
  private store!: AncillaStore;
  private readonly profiles: ProfileManager;
  private readonly linuxInstaller: LinuxMuseInstaller;
  private readonly hosts = new Map<string, ManagedHost>();
  private readonly starting = new Map<string, Promise<ManagedHost>>();
  private readonly startTokens = new Map<string, StartToken>();
  private readonly hostStartTimeoutMs: number;
  private readonly hostWaits: Required<HostWaits>;
  private restartChain: Promise<void> = Promise.resolve();
  private readonly fingerprints = new Map<string, unknown>();
  private readonly sse: SseBroadcaster;
  private readonly researchOrigins = new Map<string, boolean>();
  private readonly researchMisses = new Map<string, number>();
  private readonly live = new Map<string, LiveState>();
  private readonly sessionHosts = new Map<string, string>();
  private readonly modelTrials = new Map<string, string>();
  private hostWork = 0;
  private readonly opener: Opener;
  private readonly titleQueue: string[] = [];
  private titleWorker: Promise<void> | null = null;
  private readonly titleUpgradePending = new Set<string>();
  private readonly titleUpgradeActive = new Set<string>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setInterval> | null = null;
  private envCache: { at: number; value: EnvView } | null = null;
  private readonly skillCache = new Map<string, SkillListing>();
  private planUsage: SubscriptionUsage | null = null;
  private defaultPlanUsage: SubscriptionUsage | null = null;
  private planUsageAccountId: string | null = null;
  private readonly quotaScopes = new Map<string | null, string | null>();
  private readonly directQuota = new Map<string | null, SubscriptionReading>();
  private readonly subscriptionReader: MuseSubscriptionReader;
  private readonly wslHomes: WslHomes;
  private readonly wslQuota: NonNullable<ServerOptions["wslQuota"]>;
  private readonly wslStuck = new Set<string>();
  private readonly pendingHostQuotas = new WeakMap<ManagedHost, Promise<SubscriptionUsage | null>>();
  private readonly usageSources = new Map<string | null, "meta" | "runtime" | "saved">();
  private readonly lastPlanNames = new Map<string | null, string>();
  private readonly clampedStamps = new Map<string | null, { from: number; to: number }>();
  private readonly removedQuotaAccounts = new Set<string>();
  private readonly quotaAccountGenerations = new Map<string, number>();
  private planUsageReadRevision = 0;
  private readonly planUsageByAccount = new Map<string, SubscriptionUsage>();
  private readonly effortApplied = new Map<string, ReasoningEffort>();
  private readonly approvalModeApplied = new Map<string, ApprovalMode>();
  private lastHostError: string | null = null;
  private readonly notifyStats = new Map<string, SessionNotifyStats>();
  private protocolErrors = 0;
  private lastProtocolError: string | null = null;
  private forwardFailures = 0;
  private lastForwardFailure: string | null = null;
  private hostExits = 0;
  private lastHostExitAt: string | null = null;
  private researchInterruptedAtBoot = 0;
  private unroutedByMethod = new Map<string, number>();
  private runtimeKnown: MuseRuntime | null = null;
  private distroKnown: string | null = null;
  private readonly renameRefused = new Set<string>();
  private closed = false;
  private readonly shutdownSignal = new AbortController();
  private readonly ownerLock: OwnerLock;
  private readonly ownerDeps: OwnerLockDeps;
  private readonly bootStartedAt: number;
  private readonly bootBudgetMs: number;
  private readonly bootBudget = new AbortController();
  readonly instanceId = randomUUID();
  private storeClosed = false;
  private readonly pendingCaptures: PendingCaptures = new Set();
  private readonly options: Required<
    Omit<
      ServerOptions,
      | "staticDir"
      | "token"
      | "platform"
      | "distro"
      | "musePath"
      | "hostFactory"
      | "providerHostFactory"
      | "opener"
      | "exec"
      | "findNativeMuse"
      | "profiles"
      | "loginSpawn"
      | "linuxInstaller"
      | "subscriptionReader"
      | "wslQuota"
      | "researchEngine"
      | "researchMaxWorkers"
      | "researchStartupMs"
      | "attachmentWriter"
      | "sseMaxBacklogBytes"
      | "sseStallMs"
      | "hostStartTimeoutMs"
      | "hostWaits"
      | "dataDirLock"
      | "ownerLock"
      | "bootBudgetMs"
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
  private readonly loginChildren = new Map<string, LoginChild>();
  private readonly loginAttempts = new Map<
    string,
    {
      loginId: string;
      status: "waiting" | "done" | "error";
      message?: string;
      url?: string | null;
      code?: string | null;
      needsCodeInput?: boolean;
      waiters?: (() => void)[];
    }
  >();
  private readonly loginStartGenerations = new Map<string, number>();
  private researchJobs!: ResearchJobManager;
  private assistant: AssistantService | null = null;
  private assistantUnavailable: string | null = null;
  private assistantFailedAt = 0;
  private assistantReady = false;
  private voiceService: VoiceService | null = null;
  private voiceSockets: VoiceSocketServer | null = null;
  private browserSockets: BrowserSocketServer | null = null;
  private browserWatchers: BrowserWatchServer | null = null;
  private browserService: BrowserService | null = null;
  private browseSites: BrowseSites | null = null;
  private browseRunner: BrowseRunner | null = null;
  private connectorState: { registry: ConnectorRegistry; audit: AuditLog } | null = null;
  private connectorRunner: ConnectorRunner | null = null;
  private authorizationHub: AuthorizationHub | null = null;
  private launchManager: LaunchManager | null = null;
  private readonly researchEngine: ResearchEngine;
  private readonly researchMaxWorkers: number | undefined;
  private readonly researchStartupOverride: { option: number | undefined; env: string | undefined };
  private readonly abandonedStarts = new Map<string, number>();
  private readonly startWaiters = new Set<() => void>();
  private readonly attachmentWriter: AttachmentWriter;
  private readonly preparedFiles = new Map<string, { root: string; name: string; size: number; at: number }>();
  private readonly sessionListeners = new Map<string, Set<SessionNotificationHandler>>();
  private readonly providerHostFactory?: ProviderHostFactory;
  private providerSecrets: FileSecretStore | null = null;
  private profileIsolator: ProfileIsolator | null = null;
  private providerProbeCache: { at: number; probes: Record<string, ProviderBinaryProbe> } | null = null;
  private readonly providerUsageByKey = new Map<string, SubscriptionUsage>();
  private readonly staleAfterLoginHosts = new WeakSet<ManagedHost>();
  private readonly hasCustomHostFactory: boolean;
  private readonly museCliAuthCache = new Map<string, { at: number; ok: boolean }>();
  private voiceExtraFlagsUnsupported = false;

  constructor(serverOpts: ServerOptions = {}) {
    this.hasCustomHostFactory = serverOpts.hostFactory !== undefined;
    this.providerHostFactory = serverOpts.providerHostFactory;

    this.hostStartTimeoutMs = resolveHostStartTimeoutMs({
      option: serverOpts.hostStartTimeoutMs,
      env: process.env[HOST_START_TIMEOUT_ENV],
      warn: (msg) => this.log(msg),
    });

    this.hostWaits = { ...DEFAULT_HOST_WAITS, ...(serverOpts.hostWaits ?? {}) };

    this.options = {
      port: serverOpts.port ?? 3127,
      host: serverOpts.host ?? "127.0.0.1",
      dataDir: serverOpts.dataDir ?? ":memory:",
      staticDir: serverOpts.staticDir ? resolve(serverOpts.staticDir) : null,
      token: serverOpts.token ?? null,
      allowOrigins: serverOpts.allowOrigins ? [...serverOpts.allowOrigins] : [],
      allowHosts: serverOpts.allowHosts ? [...serverOpts.allowHosts] : [],
      platform: serverOpts.platform ?? process.platform,
      distro: serverOpts.distro,
      musePath: serverOpts.musePath,
      runtime: serverOpts.runtime ?? parseRuntimePreference(process.env["ANCILLA_MUSE_RUNTIME"]),
      syncSessionNames: serverOpts.syncSessionNames === true,
      wslEnv: { ...(serverOpts.wslEnv ?? {}) },
      findNativeMuse: serverOpts.findNativeMuse,
      hostFactory:
        serverOpts.hostFactory ??
        ((target) =>
          new AncillaMspHost(target, undefined, undefined, {
            startTimeoutMs: this.hostStartTimeoutMs,
            log: (entry) => this.log(entry),
          })),
      home: serverOpts.home ?? homedir(),
      autoSettleDays: serverOpts.autoSettleDays === undefined ? 3 : serverOpts.autoSettleDays,
      exec: serverOpts.exec ?? defaultExec,
      shellRunner:
        serverOpts.shellRunner ??
        ((command, args) =>
          runCapture(command, args, undefined, SHELL_TIMEOUT_MS, { pending: this.pendingCaptures })),
      bootSweepRetryMs: serverOpts.bootSweepRetryMs ?? BOOT_SWEEP_RETRY_MS,
      loginSpawn: serverOpts.loginSpawn ?? defaultLoginSpawn,
    };

    this.trustedHosts = trustedHostSet(this.options.allowHosts, this.options.allowOrigins, this.options.host);
    this.enforceHost = isLoopbackBind(this.options.host) || parseAllowHosts(this.options.allowHosts).hosts.length > 0;

    const startupEnvConfig = process.env["ANCILLA_RESEARCH_STARTUP_MS"];
    this.researchStartupOverride = { option: serverOpts.researchStartupMs, env: startupEnvConfig };
    if (startupEnvConfig !== undefined && startupEnvConfig.trim() !== "" && startupEnvMs(startupEnvConfig) === null) {
      this.log(
        `ignoring ANCILLA_RESEARCH_STARTUP_MS=${JSON.stringify(startupEnvConfig)}: it takes whole milliseconds, ${MIN_RESEARCH_STARTUP_ENV_MS} or more (for example 180000).`,
      );
    }

    this.opener = serverOpts.opener ?? defaultOpener(this.options.platform);
    this.sse = new SseBroadcaster({
      maxBacklogBytes: serverOpts.sseMaxBacklogBytes,
      stallMs: serverOpts.sseStallMs,
    });
    this.attachmentWriter = serverOpts.attachmentWriter ?? writeAttachment;

    this.profiles =
      serverOpts.profiles ??
      createProfileManager({
        home: this.options.home,
        platform:
          this.options.platform === "win32"
            ? "win32"
            : this.options.platform === "darwin"
              ? "darwin"
              : "linux",
        ...(this.options.musePath ? { musePath: this.options.musePath } : {}),
      });

    this.linuxInstaller =
      serverOpts.linuxInstaller ??
      new LinuxMuseInstaller({ platform: this.options.platform, home: this.options.home });

    this.subscriptionReader =
      serverOpts.subscriptionReader ??
      new MuseSubscriptionReader({
        runUsage: (cliReq) => this.runMuseUsage(cliReq),
      });

    this.wslQuota = serverOpts.wslQuota ?? {};
    this.wslHomes = new WslHomes({
      run: (linuxDistro) => this.askWslHome(linuxDistro),
      timeoutMs: this.wslQuota.homeTimeoutMs ?? WSL_HOME_TIMEOUT_MS,
      retryMs: this.wslQuota.retryMs ?? WSL_HOME_RETRY_MS,
    });

    this.researchEngine = serverOpts.researchEngine ?? runResearch;
    this.researchMaxWorkers = serverOpts.researchMaxWorkers;

    this.ownerDeps = {
      ...defaultOwnerLockDeps((line) => this.log(line)),
      ...(serverOpts.ownerLock ?? {}),
    };
    this.bootStartedAt = this.ownerDeps.now();
    this.bootBudgetMs = serverOpts.bootBudgetMs ?? BOOT_BUDGET_MS;

    this.ownerLock = claimOwnerLock(
      this.options.dataDir,
      {
        instanceId: this.instanceId,
        pid: process.pid,
        host: this.options.host,
        startedAt: new Date(this.bootStartedAt).toISOString(),
        ancillaVersion: ANCILLA_VERSION,
        platform: process.platform,
      },
      this.ownerDeps,
      { enabled: serverOpts.dataDirLock !== false },
    );

    if (this.ownerLock.state !== "contended") {
      this.openStore();
    }

    this.server = createServer((req, res) => {
      void this.route(req, res).catch((err) => this.fail(res, 500, String(err)));
    });

    this.server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
  }
  private browserFor(): BrowserService {
    this.browserService ??= new BrowserService({
      dataDir: this.options.dataDir,
      log: (line) => this.log(line),
      // The assistant's pages are asked about before they load; the person's own tabs never are.
      siteGate: (request) => this.browseGate().decide(request),
      // Only origins explicitly granted signed-in sharing receive cookies from the persistent Browser profile.
      signInGate: (request) => this.browseGate().shouldShareSignIn(request),
      // A form is sent only when the person says so on the screen, every time.
      commitGate: (request) => this.browseGate().decideCommit(request),
      // A download of the assistant's browser is saved only into a folder the person chooses on the screen.
      downloadGate: (request) => this.browseGate().decideDownload(request),
      // A file upload of the assistant's browser attaches only local files the person chooses on the screen.
      uploadGate: (request) => this.browseGate().decideUpload(request),
    });
    return this.browserService;
  }

  /** The sites the assistant's browser may open: the saved rules, and the question the person is looking at. */
  private browseGate(): BrowseSites {
    // With an in-memory data folder (tests) the rules last as long as the process.
    this.browseSites ??= new BrowseSites(this.options.dataDir === ":memory:" ? null : join(this.options.dataDir, "browser", "sites.json"), () => this.browseRunnerFor());
    return this.browseSites;
  }

  /** The assistant's browser at work: made on first use, it runs the web tasks the executive makes. */
  private browseRunnerFor(): BrowseRunner {
    this.browseRunner ??= new BrowseRunner({
      service: () => this.browserFor(),
      brain: () => this.voiceFor().browseBrain(),
      gate: this.browseGate().gate,
      log: (line) => this.log(line),
    });
    return this.browseRunner;
  }

  /** Which accounts are connected, and what was done with them: made on first use, kept in the data folder. */
  private connectorsFor(): { registry: ConnectorRegistry; audit: AuditLog } {
    if (!this.connectorState) {
      const inMemory = this.options.dataDir === ":memory:";
      const folder = inMemory ? null : join(this.options.dataDir, "connectors");
      const log = (line: string): void => this.log(line);
      const audit = new AuditLog(folder ? join(folder, "activity.jsonl") : null, log);
      const secrets = new FileSecretStore(folder ? join(folder, "secrets.json") : null, () => Date.now(), log);
      this.connectorState = { registry: new ConnectorRegistry({ file: folder ? join(folder, "connectors.json") : null, secrets, audit, open: makeOpener(ANCILLA_VERSION), log }), audit };
    }
    return this.connectorState;
  }

  /** The reading agent at work on a connected account: made on first use, it runs the connector tasks the executive makes. */
  private connectorRunnerFor(): ConnectorRunner {
    this.connectorRunner ??= new ConnectorRunner({
      registry: this.connectorsFor().registry,
      brain: () => this.voiceFor().browseBrain(),
      log: (line) => this.log(line),
    });
    return this.connectorRunner;
  }

  /** Runs read-only project steps on the configured non-Muse assistant model when Muse CLI is not reachable. */
  private fallbackReadFor(): FallbackReadRunner {
    return {
      available: () => {
        const voice = this.voiceFor();
        const b = voice.effectiveSettings().brain;
        const isApiBrain =
          b.kind === "openai" ||
          b.kind === "anthropic" ||
          b.kind === "google" ||
          (b.kind === "provider" && b.providerId === "api");
        if (!isApiBrain) return { ok: false };
        const chosen = voice.browseBrain();
        return chosen.problem ? { ok: false } : { ok: true, label: chosen.brain.label };
      },
      run: async ({ cwd, prompt, signal }) => {
        const chosen = this.voiceFor().browseBrain();
        if (chosen.problem) return { ok: false, error: chosen.problem };
        const norm = normalizeCwd(cwd);
        const root = await this.workspaceRootFor(norm);
        return runBrainReadStep({ brain: chosen.brain, root, displayRoot: norm, prompt, signal });
      },
    };
  }

  /** Runs authorized project write steps on the configured non-Muse assistant model when Muse CLI is not reachable. */
  private fallbackWriteFor(): FallbackWriteRunner {
    return {
      available: () => {
        const voice = this.voiceFor();
        const b = voice.effectiveSettings().brain;
        const isApiBrain =
          b.kind === "openai" ||
          b.kind === "anthropic" ||
          b.kind === "google" ||
          (b.kind === "provider" && b.providerId === "api");
        if (!isApiBrain) return { ok: false };
        const chosen = voice.browseBrain();
        return chosen.problem ? { ok: false } : { ok: true, label: chosen.brain.label };
      },
      run: async ({ cwd, prompt, signal }) => {
        const chosen = this.voiceFor().browseBrain();
        if (chosen.problem) return { ok: false, error: chosen.problem, changedFiles: [] };
        const norm = normalizeCwd(cwd);
        const root = await this.workspaceRootFor(norm);
        return runBrainWriteStep({ brain: chosen.brain, root, displayRoot: norm, prompt, signal });
      },
    };
  }

  /** Shared pending-authorization queue for live calls and interactive approvals. */
  private authorizationsFor(): AuthorizationHub {
    this.authorizationHub ??= new AuthorizationHub();
    return this.authorizationHub;
  }

  /** Opens or reuses a tab in Ancilla's integrated browser (`you` for localhost dev servers, `assistant` for external URLs). */
  private async openAncillaTabFor(url: string): Promise<{ id: string; url: string; title: string }> {
    const parsed = new URL(url);
    const local = hostKind(parsed.hostname) === "local";
    const preferred = local ? "you" : "assistant";
    if (preferred === "assistant" && isRestrictedAssistantUrl(url)) {
      throw new BrowserError("blocked", "Automated assistant browsing is disabled on Meta consumer sites; open it in your own Browser tab instead.");
    }
    const browser = this.browserFor();
    const sameAddress = (a: string, b: string): boolean => {
      try {
        const ua = new URL(a);
        const ub = new URL(b);
        return ua.origin === ub.origin && (ua.pathname || "/") === (ub.pathname || "/") && ua.search === ub.search && ua.hash === ub.hash;
      } catch {
        return a === b;
      }
    };
    const tabs = await browser.listTabs();
    const existing = tabs.find((t) => t.context === preferred && sameAddress(t.url, url)) ?? (local ? tabs.find((t) => sameAddress(t.url, url)) : undefined);
    if (existing) {
      await browser.activateTab(existing.id).catch(() => undefined);
      const refreshed = await browser.navigate(existing.id, url);
      return { id: refreshed.id, url: refreshed.url, title: refreshed.title };
    }
    const blank = preferred === "you" ? tabs.find((t) => t.context === "you" && (t.url === "about:blank" || t.url === "")) : undefined;
    if (blank) {
      await browser.activateTab(blank.id).catch(() => undefined);
      const nav = await browser.navigate(blank.id, url);
      return { id: nav.id, url: nav.url, title: nav.title };
    }
    if (tabs.length >= 8) {
      const reuse = tabs.find((t) => t.context === "assistant") ?? tabs[0];
      if (reuse) {
        const nav = await browser.navigate(reuse.id, url);
        return { id: nav.id, url: nav.url, title: nav.title };
      }
    }
    const opened = await browser.openTab(preferred, url);
    return { id: opened.id, url: opened.url, title: opened.title };
  }

  /** Authorized process, dev-server, URL, and editor launcher shared across models and call sessions. */
  private launcherFor(): LaunchManager {
    this.launchManager ??= new LaunchManager({
      planCommand: (cwd, command) => this.planWorkspaceCommand(cwd, command),
      openPath: (localPath, target) => this.opener(localPath, target),
      openAncillaBrowser: async (url) => {
        const tab = await this.openAncillaTabFor(url);
        return { url: tab.url, title: tab.title };
      },
      grantOrigin: (origin) => this.browseGate().grantSessionOrigin(origin),
      isPreAuthorized: () => {
        try {
          return this.store.getYoloSettings().enabled;
        } catch {
          return false;
        }
      },
      authorizations: this.authorizationsFor(),
      log: (line) => this.log(line),
    });
    return this.launchManager;
  }

  /** Resolves a stored project folder synchronously to a path readable on this machine's filesystem. */
  private syncLocalRootFor(cwd: string): string {
    try {
      return resolveUserPath(cwd, {
        platform: this.options.platform ?? process.platform,
        home: this.options.home ?? homedir(),
        distro: this.wslDistro(),
      }).local;
    } catch {
      return this.localPathFor(cwd);
    }
  }

  /** Provider-independent workspace inspection, launch, and live page/animation diagnostic dependencies for calls. */
  private workspaceVoiceDeps(): WorkspaceVoiceDeps {
    const nameOf = (cwd: string): string => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
    const toRef = (cwd: string): WorkspaceProjectRef => ({
      name: nameOf(cwd),
      cwd: this.syncLocalRootFor(cwd),
      displayCwd: cwd,
    });
    return {
      projects: () => {
        try {
          return this.store.listFolders().map((p) => toRef(p.cwd));
        } catch {
          return [];
        }
      },
      currentProject: () => {
        try {
          const first = this.store.listProjects()[0] ?? this.store.listFolders()[0];
          return first ? toRef(first.cwd) : null;
        } catch {
          return null;
        }
      },
      launcher: this.launcherFor(),
      authorizations: this.authorizationsFor(),
      isPreAuthorized: () => {
        try {
          return this.store.getYoloSettings().enabled;
        } catch {
          return false;
        }
      },
      inspector: {
        available: () => this.browseRunnerFor().available(),
        isSiteAllowed: (origin) => this.browseGate().isAllowedNow(origin),
        grantSite: (origin) => this.browseGate().grantSessionOrigin(origin),
        inspectUrl: async (url) => {
          const tab = await this.openAncillaTabFor(url);
          const browser = this.browserFor();
          await browser.waitLoaded(tab.id, 3000).catch(() => undefined);
          await new Promise<void>((r) => setTimeout(r, 200));
          const [diagnostics, snap] = await Promise.all([
            browser.diagnosePage(tab.id),
            browser.snapshot(tab.id, { maxChars: 2400 }).catch(() => ({ text: "", refs: 0, truncated: false })),
          ]);
          return {
            url: diagnostics.url || tab.url,
            title: diagnostics.title || tab.title,
            diagnostics,
            snapshotText: snap.text,
          };
        },
      },
    };
  }

  /**
   * Muse host adapter dedicated to live voice calls: honours standing YOLO posture (`allowAll`), defaults spoken turns
   * to `medium` reasoning effort so `muse-spark-1.3` answers promptly instead of burning 25s on Max thinking, and bridges
   * live `approval/requested` frames into `AuthorizationHub` so the user can approve from the call card or by voice.
   */
  private voiceMuseHost(): MuseBrainHost {
    const base = this.assistantHost();
    const yolo = (): boolean => {
      try {
        return this.store.getYoloSettings().enabled;
      } catch {
        return false;
      }
    };
    const describeSubject = (params: Record<string, unknown>): { title: string; detail: string; allowLabel: string } => {
      const info = approvalSubjectOf(params);
      const subject = asRecord(params["subject"]);
      const cmd = str(subject?.["command"]) ?? str(params["command"]);
      if (cmd) return { title: "Allow command in thread", detail: cmd.slice(0, 220), allowLabel: "Allow" };
      const path = str(subject?.["path"]) ?? str(subject?.["filePath"]) ?? str(params["path"]);
      if (path) return { title: `Allow ${info.kind === "fileWrite" ? "file write" : "file access"}`, detail: path.slice(0, 220), allowLabel: "Allow" };
      const host = str(subject?.["host"]) ?? str(subject?.["url"]) ?? str(params["url"]);
      if (host) return { title: "Allow network access", detail: host.slice(0, 220), allowLabel: "Allow" };
      return {
        title: info.toolName ? `Allow ${info.toolName}` : "Allow action in thread",
        detail: str(params["reason"]) ?? str(subject?.["description"]) ?? info.kind,
        allowLabel: "Allow",
      };
    };
    return {
      ...base,
      startSession: async ({ cwd, account, providerId, title, modelId }) => {
        const effectiveProvider = providerId ? this.normalizeProviderId(providerId) : "muse";
        const posture: HostPosture = effectiveProvider === "muse" ? "voice" : "coding";
        const created = await this.startSession(
          normalizeCwd(cwd),
          yolo() ? "allowAll" : undefined,
          modelId ?? undefined,
          account,
          effectiveProvider,
          posture,
        );
        const sessionId = String(created["sessionId"]);
        const reportedModelId = typeof created["modelId"] === "string" && created["modelId"] !== "" ? created["modelId"] : null;
        try {
          this.store.updateSession(sessionId, { title, titleSource: "user" });
        } catch (error) {
          this.log(`a call's thread could not be named: ${errorInfo(error).message}`);
        }
        return { sessionId, modelId: reportedModelId };
      },
      openSession: async (sessionId, expected) => {
        const found = this.store.findSession(sessionId);
        if (expected) {
          if (!found) return { ok: false, modelId: null };
          if (expected.providerId && this.normalizeProviderId(found.session.providerId) !== this.normalizeProviderId(expected.providerId)) {
            return { ok: false, modelId: null };
          }
          if (expected.account !== undefined && (found.session.accountId ?? null) !== (expected.account ?? null)) {
            return { ok: false, modelId: null };
          }
        }
        if (
          found &&
          this.normalizeProviderId(found.session.providerId) === "muse" &&
          found.session.hostPosture !== "voice" &&
          !this.sessionHosts.has(sessionId)
        ) {
          try {
            this.store.updateSession(sessionId, { hostPosture: "voice" });
          } catch {
            // Best-effort posture migration before loading onto the dedicated voice host.
          }
        }
        const ok = (await base.openSession?.(sessionId)) ?? true;
        if (ok && yolo()) {
          const managed = await this.hostForSession(sessionId).catch(() => null);
          if (managed) {
            await this.applyApprovalMode(managed.manager, sessionId, "allowAll").catch(() => undefined);
          }
        }
        const modelId = ok ? (this.store.findSession(sessionId)?.session.modelId ?? null) : null;
        return { ok, modelId };
      },
      warmHost: async (cwd, account, providerId) => {
        const effectiveProvider = providerId ? this.normalizeProviderId(providerId) : "muse";
        const posture: HostPosture = effectiveProvider === "muse" ? "voice" : "coding";
        await this.hostFor(normalizeCwd(cwd), account, effectiveProvider, posture);
      },
      startTurn: async ({ sessionId, text, displayText, reasoningEffort }) => {
        const managed = await this.hostForSession(sessionId);
        if (yolo()) {
          await this.applyApprovalMode(managed.manager, sessionId, "allowAll").catch(() => undefined);
        }
        if (reasoningEffort && isReasoningEffort(reasoningEffort)) {
          await this.applyEffort(managed.manager, sessionId, reasoningEffort).catch(() => undefined);
        }
        this.wake(sessionId);
        const live = this.liveFor(sessionId);
        const sentAtRevision = ++live.activityRevision;
        let ack;
        try {
          ack = await managed.manager.sendTurn(sessionId, text, {
            displayText,
            ...(reasoningEffort ? { reasoningEffort } : {}),
          });
        } catch (error) {
          const info = errorInfo(error);
          if (/timed? ?out|timeout|aborted|socket|ECONNRESET|EPIPE/i.test(info.message) && info.status >= 500) {
            throw new AmbiguousStartError(info.message);
          }
          throw Object.assign(new Error(info.message), { kind: info.kind });
        }
        if (!ack.turnId) {
          throw new AmbiguousStartError("Muse accepted the prompt but named no turn");
        }
        this.afterTurnAccepted(sessionId, managed, ack, live, sentAtRevision);
        return { turnId: ack.turnId };
      },
      onApprovalRequested: ({ sessionId, turnId, params }) => {
        const approvalId = str(params["approvalId"]);
        if (!approvalId) return;
        if (yolo()) {
          const planned = planApproval(params, true, "");
          void this.managerForSession(sessionId)
            .then((manager) =>
              manager.decideApproval({
                sessionId,
                approvalId,
                requirementId: planned ? planned.requirementId : (params["currentRequirementId"] ?? params["requirementId"] ?? null),
                choiceId: planned ? planned.choiceId : "allow_once",
                feedback: null,
              }),
            )
            .catch(() => undefined);
          return;
        }
        const desc = describeSubject(params);
        this.authorizationsFor().request({
          id: `muse_${approvalId}`,
          kind: "muse-approval",
          title: desc.title,
          detail: desc.detail,
          allowLabel: desc.allowLabel,
          denyLabel: "Deny",
          createdTurn: 0,
          inFlightMuse: true,
          onDecide: async (allow) => {
            const manager = await this.managerForSession(sessionId);
            const planned = planApproval(params, allow, allow ? "" : "Denied by user during voice call.");
            try {
              await manager.decideApproval({
                sessionId,
                approvalId,
                requirementId: planned ? planned.requirementId : (params["currentRequirementId"] ?? params["requirementId"] ?? null),
                choiceId: planned ? planned.choiceId : allow ? "allow_once" : "deny_once",
                feedback: planned ? planned.feedback : null,
              });
              return { ok: true, message: allow ? "Approved in thread." : "Denied." };
            } catch (error) {
              if (!allow) {
                await manager.interruptTurn(sessionId, turnId || undefined, false).catch(() => undefined);
                return { ok: true, message: "Denied." };
              }
              return { ok: false, message: errorInfo(error).message };
            }
          },
        });
      },
      onApprovalResolved: (approvalId) => {
        this.authorizationsFor().cancel(`muse_${approvalId}`);
      },
      watch: (sessionId, handler) => this.onSessionNotification(sessionId, (method, params) => handler(method, params)),
    };
  }

  /** The voice, made on first use. */
  private voiceFor(): VoiceService {
    if (!this.voiceService) {
      this.voiceService = new VoiceService({
        dataDir: this.options.dataDir,
        assistant: (create) => this.assistantFor(create),
        log: (line) => this.log(line),
        // The same four things a task uses to run in a Muse thread: a call thinks in one, and shows in the sidebar like any other.
        museHost: this.voiceMuseHost(),
        harness: this.harnessReader(),
        // The model that browses is the voice's own; Muse is run with no tools of its own (see browser/muse-brain.ts).
        museExec: async (args, limits, accountId) => {
          const plan = await this.planMuseExec(args, accountId ?? null);
          return this.options.exec(plan.command, plan.args, { ...(plan.env ? { env: plan.env } : {}), timeoutMs: limits.timeoutMs, signal: limits.signal });
        },
        resolveApiAccount: (accountId) => {
          const account = accountId ? this.store.getProviderAccount(accountId) : (this.store.listProviderAccounts("api")[0] ?? null);
          if (!account || account.providerId !== "api") return null;
          const baseUrl = account.apiBaseUrl ?? "https://api.openai.com/v1";
          return {
            apiKind: account.apiKind ?? "openai",
            baseUrl,
            apiKey: this.profilesFor().resolveApiKey(account),
            defaultModelId: account.defaultModelId,
            label: account.name || "API",
            local: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(baseUrl),
          };
        },
        providerName: (rawProviderId, accountId) => {
          const pid = this.normalizeProviderId(rawProviderId);
          const base = descriptorForProvider(pid).displayName;
          if (pid === "muse") return accountId ? `${base} (${accountId})` : base;
          if (accountId) {
            const acct = this.store.getProviderAccount(accountId);
            if (acct?.name) return pid === "api" ? acct.name : `${base} (${acct.name})`;
            return `${base} (${accountId})`;
          }
          if (pid === "api") {
            const acct = this.store.listProviderAccounts("api")[0] ?? null;
            return acct?.name ?? base;
          }
          return base;
        },
        projectDefault: (cwd) => {
          if (!cwd) return null;
          try {
            const proj = this.store.projectForFolder(normalizeCwd(cwd));
            if (!proj) return null;
            const providerId = this.normalizeProviderId(proj.defaultProviderId);
            return {
              providerId,
              accountId: providerId === "muse" ? null : (proj.defaultAccountId ?? null),
              modelId: null,
            };
          } catch {
            return null;
          }
        },
        browse: this.browseRunnerFor(),
        // The accounts the call may read: only those connected and switched on are named to it.
        connectors: {
          usable: () => {
            const { registry } = this.connectorsFor();
            return registry.usable().map((id) => ({ id, name: registry.view(id).name }));
          },
          available: (id) => this.connectorRunnerFor().available(id),
        },
        workspace: this.workspaceVoiceDeps(),
        authorizations: this.authorizationsFor(),
        lastProject: () => {
          try {
            return (this.store.listProjects()[0] ?? this.store.listFolders()[0])?.cwd ?? null;
          } catch {
            return null;
          }
        },
        museCatalogModels: (accountId, options) => {
          const out: string[] = [];
          const seen = new Set<string>();
          const pushAll = (items: readonly string[]): void => {
            for (const id of items) {
              if (!seen.has(id)) {
                seen.add(id);
                out.push(id);
              }
            }
          };
          let hasMuse1415Host = false;
          const dirs: string[] = [];
          const pushDir = (dir: string): void => {
            if (!dirs.includes(dir)) dirs.push(dir);
          };
          const platform = this.options.platform ?? process.platform;
          const home = this.options.home ?? homedir();
          for (const h of this.hosts.values()) {
            if (h.providerId === "muse" && (accountId === undefined || h.accountId === (accountId ?? null))) {
              if (isMuse1415OrNewer(h.serverVersion)) hasMuse1415Host = true;
              if (h.museHome) {
                let modelCatalogDir = join(h.museHome, "model-catalog");
                try {
                  const remoteDir = `${h.museHome.replace(/[\\/]+$/, "")}/model-catalog`;
                  modelCatalogDir = resolveUserPath(remoteDir, {
                    platform,
                    home,
                    distro: this.wslDistro(),
                  }).local;
                } catch {
                  // Fall back to direct path join when museHome cannot be resolved via resolveUserPath.
                }
                pushDir(modelCatalogDir);
              }
            }
          }
          if (!this.hasCustomHostFactory && !accountId) {
            if (platform === "win32") {
              const wslHome = this.wslHomes.peek(this.wslDistro());
              if (wslHome) {
                for (const rel of [".local/share/muse/model-catalog", ".config/muse/model-catalog"]) {
                  try {
                    pushDir(
                      resolveUserPath(`${wslHome.replace(/\/+$/, "")}/${rel}`, {
                        platform,
                        home,
                        distro: this.wslDistro(),
                      }).local,
                    );
                  } catch {
                    // Ignore unmappable WSL home paths.
                  }
                }
              }
            }
            pushDir(join(this.options.home, ".local", "share", "muse", "model-catalog"));
            pushDir(join(this.options.home, ".config", "muse", "model-catalog"));
          }
          for (const dir of dirs) {
            const models = readCachedMuseCatalogSync(dir);
            if (models && models.length > 0) {
              pushAll(models);
              break;
            }
          }
          if (!options?.diskOnly && (hasMuse1415Host || !this.hasCustomHostFactory)) {
            pushAll(META_MUSE_CODE_MODEL_IDS);
          }
          return out;
        },
      });
    }
    return this.voiceService;
  }

  /**
   * A request to open the call's socket. A browser applies no cross-origin rule to a WebSocket, so what `route` does for
   * a request (the host it names, the origin it comes from, the credential it carries) is done here by hand, before the
   * handshake is completed. A page of another site that has the user's cookie still cannot open a call.
   */
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, text: string): void => {
      const body = `${text}\n`;
      socket.write(`HTTP/1.1 ${status} ${text.split(".")[0]}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      socket.destroy();
    };
    try {
      let path: string;
      try {
        path = new URL(req.url ?? "/", "http://localhost").pathname;
      } catch {
        refuse(400, "That address is not valid.");
        return;
      }
      if (path !== VOICE_SOCKET_PATH && path !== BROWSER_SOCKET_PATH && path !== BROWSER_WATCH_PATH) {
        refuse(404, "Not found.");
        return;
      }
      if (this.closed) {
        refuse(503, "Ancilla is shutting down.");
        return;
      }
      if (this.enforceHost && !trustedHost(req.headers["host"], this.trustedHosts) && !this.bearerValid(req)) {
        this.hostRefusals += 1;
        refuse(403, "This daemon does not answer requests for that host.");
        return;
      }
      const foreign = this.foreignOrigin(req);
      if (foreign !== null && !this.options.allowOrigins.includes(foreign)) {
        refuse(403, "This daemon does not answer that origin.");
        return;
      }
      if (!this.authorized(req)) {
        refuse(401, "Missing or invalid token.");
        return;
      }
      if (path === BROWSER_SOCKET_PATH) {
        this.browserSockets ??= new BrowserSocketServer(() => this.browserFor(), (line) => this.log(line));
        this.browserSockets.handleUpgrade(req, socket, head);
        return;
      }
      if (path === BROWSER_WATCH_PATH) {
        // The same checks, above, as for the pane: host, origin and token. A watcher only looks.
        this.browserWatchers ??= new BrowserWatchServer(() => this.browserFor(), () => this.browseRunnerFor(), (line) => this.log(line));
        this.browserWatchers.handleUpgrade(req, socket, head);
        return;
      }
      if (!this.voiceSockets) {
        this.voiceSockets = new VoiceSocketServer(() => this.voiceFor(), (line) => this.log(line));
      }
      this.voiceSockets.handleUpgrade(req, socket, head);
    } catch (error) {
      this.log(`a voice socket could not be opened: ${errorInfo(error).message}`);
      refuse(500, "The call could not be opened.");
    }
  }

  /**
   * Opens the database and the research job manager over it. Only once the
   * data folder is this server's: held, shared with another server of this process, taken over, or not lockable.
   */
  private openStore(): void {
    this.store = new AncillaStore(
      this.options.dataDir === ":memory:" ? ":memory:" : join(this.options.dataDir, DB_FILE),
    );
    this.researchJobs = new ResearchJobManager({
      store: this.store,
      engine: this.researchEngine,
      globalWorkerCap: this.researchMaxWorkers,
      // `muse exec` while the prompt fits the command line for Muse threads, or a turn in the run's control session for non-Muse providers and oversized prompts.
      createModelClient: (run, thread) => {
        const sessionClient = new MuseSessionModelClient({
          host: {
            startControlSession: (modelId, giveUp) => this.startResearchSession(thread, "Research control", modelId, giveUp),
            subscribe: (sessionId, handler) => this.onSessionNotification(sessionId, handler),
            log: (message) => this.log(message),
          },
          models: run.config.models,
          fallbackModelId: thread.modelId,
          startupMs: () => this.researchStartupMs(),
        });
        if (thread.providerId && thread.providerId !== "muse") {
          return sessionClient;
        }
        return new MuseModelClient({
          exec: new MuseExecModelClient({
            exec: this.options.exec,
            plan: (args) => this.planMuseExec(args, thread.accountId),
            models: run.config.models,
            fallbackModelId: thread.modelId,
            platform: this.options.platform,
            log: (message) => this.log(message),
          }),
          session: sessionClient,
          platform: this.options.platform,
          log: (message) => this.log(message),
        });
      },
      createWorkerRunner: (run, thread, onWorkerUpdate) =>
        new MuseSessionWorkerRunner({
          host: {
            startWorkerSession: (task, modelId, giveUp) => this.startResearchSession(thread, `Research worker A${task.agentId}`, modelId, giveUp),
            subscribe: (sessionId, handler) => this.onSessionNotification(sessionId, handler),
            onWorkerUpdate,
            log: (message) => this.log(message),
          },
          models: run.config.models,
          fallbackModelId: thread.modelId,
          startupMs: () => this.researchStartupMs(),
        }),
      broadcast: (run) => this.emit("ancilla", { type: "research-run", sessionId: run.sessionId, run }),
      writeReport: (thread, run, report, state) => this.writeResearchReport(thread, run, report, state),
      log: (message) => this.log(message),
    });
  }

  /**
   * The assistant's memory lives in `assistant.db` beside the conversation database, so it can be exported, rolled back
   * or removed on its own. The file is made the first time something is written to it: until then there is nothing on
   * disk and nothing running, and looking at the page creates nothing. It is optional: one that cannot be opened is
   * reported where the user looks (its page) and logged, and every turn goes on without notes. A failed open is not
   * tried again for a while, so a locked or damaged file is not hit on every message.
   */
  private assistantFor(create: boolean): AssistantService | null {
    if (this.assistant) {
      return this.assistant;
    }
    if (this.closed || this.storeClosed || !this.assistantReady) {
      return null;
    }
    const now = Date.now();
    if (this.assistantUnavailable !== null && now - this.assistantFailedAt < ASSISTANT_RETRY_MS) {
      return null;
    }
    if (!create && this.options.dataDir !== ":memory:" && !existsSync(join(this.options.dataDir, ASSISTANT_DB_FILE))) {
      return null;
    }
    try {
      this.assistant = AssistantService.open(this.options.dataDir, {
        log: (line) => this.log(line),
        emit: (event) => {
          this.emit("ancilla", event);
          // A call that is open hears of a task that changed, to say so when there is a lull.
          if (event.reason === "task" && event.taskId) this.voiceService?.hub.emit({ taskId: event.taskId });
        },
        offsetMinutes: () => -new Date().getTimezoneOffset(),
        host: this.assistantHost(),
        browse: this.browseRunnerFor(),
        connector: this.connectorRunnerFor(),
        fallbackRead: this.fallbackReadFor(),
        fallbackWrite: this.fallbackWriteFor(),
        isPreAuthorized: () => {
          try {
            return this.store.getYoloSettings().enabled;
          } catch {
            return false;
          }
        },
      });
      this.assistantUnavailable = null;
      // Settles what a restart left in the air and starts looking for work; it never fails the request that opened it.
      void this.assistant.start().then((summary) => {
        if (summary && (summary.reconciled > 0 || summary.resumed > 0 || summary.blocked > 0)) {
          this.log(`assistant tasks after a restart: ${summary.reconciled} reconciled, ${summary.resumed} picked up again, ${summary.blocked} waiting on the user`);
        }
      });
    } catch (error) {
      this.assistant = null;
      this.assistantUnavailable = error instanceof Error ? error.message : String(error);
      this.assistantFailedAt = now;
      this.log(`the assistant could not be opened, so turns go without notes: ${this.assistantUnavailable}`);
    }
    return this.assistant;
  }

  /**
   * Muse has the prompt. From here nothing may fail the caller: an error now would tell it that a prompt Muse accepted
   * was not sent, and sending it again would put it in the thread twice. What Ancilla keeps beside the turn is best
   * effort, and a failure is logged. Shared by a person's send and by a task's.
   */
  private afterTurnAccepted(
    sessionId: string,
    managed: ManagedHost,
    ack: Awaited<ReturnType<SessionManager["sendTurn"]>>,
    live: LiveState,
    sentAtRevision: number,
  ): void {
    try {
      // A host that took the turn has the session loaded.
      if (this.hosts.get(managed.key) === managed) {
        this.sessionHosts.set(sessionId, managed.key);
      }
      // Only a turn that has started is registered: a queued or a steered prompt has no turn of its own to run yet.
      if (ack.disposition === "started" && ack.turnId) {
        this.recordTurnStart(sessionId, ack.turnId);
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
    } catch (error) {
      this.log(`turn ${ack.turnId ?? "?"} of ${sessionId} was accepted, but its live state could not be updated: ${errorInfo(error).message}`);
    }
  }

  /** What the call may look at of the harness: read only, folders shown as project names. */
  private harnessReader(): HarnessReader {
    const nameOf = (cwd: string): string => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
    const usageOf = (usage: SubscriptionUsage | null): HarnessUsage | null =>
      usage ? { tier: usage.tier, windowPercent: usage.window.usedPercent, weeklyPercent: usage.weekly.usedPercent, weeklyResetsAt: usage.weekly.resetsAtMs } : null;
    return {
      threads: (): HarnessThread[] =>
        this.store
          .listFolders()
          .flatMap((project) => this.store.listSessionsByProject(project.id).map((record) => ({ record, project: nameOf(project.cwd) })))
          .filter(({ record }) => record.origin !== "research-worker")
          .map(({ record, project }): HarnessThread => {
            const live = this.live.get(record.id);
            const waiting = Boolean(live && (live.pendingApprovals.size > 0 || live.pendingInputs.size > 0));
            return { id: record.id, title: record.title, project, state: waiting ? "waiting" : live?.activeTurnId ? "running" : "idle", activityAt: Date.parse(record.activityAt) || 0 };
          })
          .sort((a, b) => b.activityAt - a.activityAt)
          .slice(0, 200),
      messages: async (threadId, count): Promise<HarnessMessage[]> => {
        const found = this.store.findSession(threadId);
        if (!found) return [];
        const host = await this.hostFor(
          found.cwd,
          found.session.accountId ?? null,
          this.normalizeProviderId(found.session.providerId),
        );
        const out: HarnessMessage[] = [];
        for (const event of eventsFromHistory(await host.manager.readSession(threadId, false))) {
          const item = asRecord(event.params["item"]);
          const kind = item?.["kind"];
          const text = str(item?.["displayText"]) ?? str(item?.["text"]);
          if (text && (kind === "userMessage" || kind === "agentMessage")) out.push({ role: kind === "userMessage" ? "user" : "assistant", text });
        }
        return out.slice(-count);
      },
      cachedUsage: () => usageOf(this.defaultPlanUsage),
      usage: async () => usageOf((await this.readPlanUsage()).usage),
      projects: () => this.store.listFolders().map((p) => ({ name: nameOf(p.cwd), threads: this.store.listSessionsByProject(p.id).length })),
      currentProject: () => {
        const cwd = this.store.listProjects()[0]?.cwd;
        return cwd ? nameOf(cwd) : null;
      },
    };
  }

  /**
   * What the task executive uses of this server: it opens threads and sends prompts through the same paths a person's
   * clicks do, so a task is an ordinary visible thread whose approvals reach the user like any other.
   */
  private assistantHost(): ExecutiveHost {
    const yolo = (): boolean => {
      try {
        return this.store.getYoloSettings().enabled;
      } catch {
        return false;
      }
    };
    const describeTaskApproval = (sessionId: string, params: Record<string, unknown>): { title: string; detail: string; allowLabel: string } => {
      const threadTitle = this.store.findSession(sessionId)?.session.title?.trim() ?? "";
      const prefix = threadTitle ? `${threadTitle}: ` : "";
      const info = approvalSubjectOf(params);
      const subject = asRecord(params["subject"]);
      const cmd = str(subject?.["command"]) ?? str(params["command"]);
      if (cmd) return { title: `${prefix}Allow command`, detail: cmd.slice(0, 220), allowLabel: "Allow" };
      const path = str(subject?.["path"]) ?? str(subject?.["filePath"]) ?? str(params["path"]);
      if (path) return { title: `${prefix}Allow ${info.kind === "fileWrite" ? "file write" : "file access"}`, detail: path.slice(0, 220), allowLabel: "Allow" };
      const host = str(subject?.["host"]) ?? str(subject?.["url"]) ?? str(params["url"]);
      if (host) return { title: `${prefix}Allow network access`, detail: host.slice(0, 220), allowLabel: "Allow" };
      return {
        title: `${prefix}${info.toolName ? `Allow ${info.toolName}` : "Allow action"}`,
        detail: str(params["reason"]) ?? str(subject?.["description"]) ?? info.kind,
        allowLabel: "Allow",
      };
    };
    return {
      now: () => Date.now(),
      projectKey: (cwd) => normalizeCwd(cwd),
      hostAvailable: async (cwd, account) => {
        try {
          const norm = normalizeCwd(cwd);
          const proj = norm ? this.store.projectForFolder(norm) : null;
          const pref = this.assistantFor(false)?.store.getProfile().model ?? { providerId: null, accountId: null, modelId: null };
          const providerId = pref.providerId ? this.normalizeProviderId(pref.providerId) : this.normalizeProviderId(proj?.defaultProviderId);
          const effectiveAccount = account ?? (pref.providerId !== null ? pref.accountId : providerId !== "muse" ? (proj?.defaultAccountId ?? null) : null);
          await this.hostFor(norm, effectiveAccount, providerId);
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: errorInfo(error).message };
        }
      },
      startSession: async ({ cwd, account, title, modelId }) => {
        const norm = normalizeCwd(cwd);
        const proj = norm ? this.store.projectForFolder(norm) : null;
        const pref = this.assistantFor(false)?.store.getProfile().model ?? { providerId: null, accountId: null, modelId: null };
        const providerId = pref.providerId ? this.normalizeProviderId(pref.providerId) : this.normalizeProviderId(proj?.defaultProviderId);
        const effectiveAccount = account ?? (pref.providerId !== null ? pref.accountId : providerId !== "muse" ? (proj?.defaultAccountId ?? null) : null);
        const effectiveModel = modelId ?? pref.modelId ?? undefined;
        const created = await this.startSession(norm, yolo() ? "allowAll" : undefined, effectiveModel, effectiveAccount, providerId);
        const sessionId = String(created["sessionId"]);
        try {
          this.store.updateSession(sessionId, { title, titleSource: "user" });
        } catch (error) {
          this.log(`a task's thread could not be named: ${errorInfo(error).message}`);
        }
        return { sessionId };
      },
      openSession: async (sessionId) => {
        const found = this.store.findSession(sessionId);
        if (!found) return false;
        const managed = await this.hostForSession(sessionId);
        // A host of this server that has held the thread since it was made or opened has it loaded.
        if (this.sessionHosts.get(sessionId) === managed.key && this.hosts.get(managed.key) === managed) {
          if (yolo()) await this.applyApprovalMode(managed.manager, sessionId, "allowAll").catch(() => undefined);
          return true;
        }
        if (!this.mayLoadUnloaded(sessionId, managed)) return false;
        try {
          // What opening the thread on the screen does to load it, without reading its transcript.
          const reply = asRecord(await managed.manager.resumeSession(sessionId, true));
          if (this.hosts.get(managed.key) === managed) this.sessionHosts.set(sessionId, managed.key);
          this.liveFor(sessionId).readOnlyReason = null;
          const restored = await this.restoreChosenModel(
            managed.manager,
            sessionId,
            found.session.chosenModelId ?? null,
            asRecord(reply?.["session"]),
          );
          const resumedModel = restored ? str(restored["modelId"]) : null;
          if (resumedModel && !found.session.modelId) {
            try {
              this.store.updateSession(sessionId, { modelId: resumedModel });
            } catch {
              // Best-effort sync of host-reported model onto session record.
            }
          }
          if (yolo()) await this.applyApprovalMode(managed.manager, sessionId, "allowAll").catch(() => undefined);
          return true;
        } catch (error) {
          // Only a thread that is gone, or that another Muse client holds, cannot be used; a host that cannot be reached is an error.
          const info = errorInfo(error);
          if (info.kind === "sessionInUse" || info.kind === "sessionNotFound") {
            this.log(`the thread ${sessionId} of a call could not be loaded on ${managed.key}: ${info.message}`);
            return false;
          }
          throw error;
        }
      },
      setModel: async (sessionId, modelId) => {
        // A thread that is on the model already is left as it is: a switch is a request to Muse and a note in the thread.
        if (this.store.findSession(sessionId)?.session.modelId === modelId) return;
        await this.setThreadModel(sessionId, { modelId });
      },
      startTurn: async ({ sessionId, text, displayText }) => {
        const managed = await this.hostForSession(sessionId);
        if (yolo()) {
          await this.applyApprovalMode(managed.manager, sessionId, "allowAll").catch(() => undefined);
        }
        this.wake(sessionId);
        const live = this.liveFor(sessionId);
        const sentAtRevision = ++live.activityRevision;
        let ack;
        try {
          ack = await managed.manager.sendTurn(sessionId, text, { displayText });
        } catch (error) {
          // A refusal is a plain failure. Anything that may have reached Muse before it failed is ambiguous.
          const info = errorInfo(error);
          if (/timed? ?out|timeout|aborted|socket|ECONNRESET|EPIPE/i.test(info.message) && info.status >= 500) {
            throw new AmbiguousStartError(info.message);
          }
          // The kind goes with it, so that a call can tell a thread its host does not hold from any other refusal.
          throw Object.assign(new Error(info.message), { kind: info.kind });
        }
        if (!ack.turnId) {
          throw new AmbiguousStartError("Muse accepted the prompt but named no turn");
        }
        this.afterTurnAccepted(sessionId, managed, ack, live, sentAtRevision);
        return { turnId: ack.turnId };
      },
      interruptTurn: async (sessionId, turnId) => {
        const manager = await this.managerForSession(sessionId);
        await manager.interruptTurn(sessionId, turnId, false);
      },
      turnState: async (sessionId, turnId) => {
        const status = this.store.turnStatus(turnId, sessionId);
        if (status === null) return "absent";
        if (status === "running") return "running";
        if (status === "completed") return "completed";
        if (status === "failed") return "failed";
        if (status === "cancelled" || status === "interrupted") return "interrupted";
        return "unknown";
      },
      readProjectFile: async (cwd, relPath) => {
        const root = await this.workspaceRootFor(normalizeCwd(cwd));
        try {
          const file = await readProjectFile(root, root, relPath);
          if (file.truncated) {
            throw new Error(`${relPath} is too large to check`);
          }
          return { exists: true, text: file.content ?? null, size: file.size };
        } catch (error) {
          if (error instanceof FileError && error.status === 404) {
            return { exists: false, text: null, size: 0 };
          }
          throw error;
        }
      },
      needsUser: (sessionId) => {
        const live = this.live.get(sessionId);
        return Boolean(live && (live.pendingApprovals.size > 0 || live.pendingInputs.size > 0));
      },
      watch: (sessionId, handler) =>
        this.onSessionNotification(sessionId, (method, params) => {
          if (method === "approval/requested") {
            const approvalId = str(params["approvalId"]);
            const turnId = str(params["turnId"]) ?? "";
            if (approvalId) {
              if (yolo()) {
                const planned = planApproval(params, true, "");
                void this.managerForSession(sessionId)
                  .then((manager) =>
                    manager.decideApproval({
                      sessionId,
                      approvalId,
                      requirementId: planned ? planned.requirementId : (params["currentRequirementId"] ?? params["requirementId"] ?? null),
                      choiceId: planned ? planned.choiceId : "allow_once",
                      feedback: null,
                    }),
                  )
                  .catch(() => undefined);
              } else {
                const desc = describeTaskApproval(sessionId, params);
                this.authorizationsFor().request({
                  id: `muse_${approvalId}`,
                  kind: "muse-approval",
                  title: desc.title,
                  detail: desc.detail,
                  allowLabel: desc.allowLabel,
                  denyLabel: "Deny",
                  createdTurn: 0,
                  inFlightMuse: true,
                  onDecide: async (allow) => {
                    const manager = await this.managerForSession(sessionId);
                    const planned = planApproval(params, allow, allow ? "" : "Denied by user during voice call.");
                    try {
                      await manager.decideApproval({
                        sessionId,
                        approvalId,
                        requirementId: planned ? planned.requirementId : (params["currentRequirementId"] ?? params["requirementId"] ?? null),
                        choiceId: planned ? planned.choiceId : allow ? "allow_once" : "deny_once",
                        feedback: planned ? planned.feedback : null,
                      });
                      return { ok: true, message: allow ? "Approved in task thread." : "Denied." };
                    } catch (error) {
                      if (!allow) {
                        await manager.interruptTurn(sessionId, turnId || undefined, false).catch(() => undefined);
                        return { ok: true, message: "Denied." };
                      }
                      return { ok: false, message: errorInfo(error).message };
                    }
                  },
                });
              }
            }
          } else if (method === "approval/resolved") {
            const approvalId = str(params["approvalId"]);
            if (approvalId) this.authorizationsFor().cancel(`muse_${approvalId}`);
          }
          handler(method, params);
        }),
      log: (line) => this.log(line),
    };
  }

  private readonly assistantAccess = {
    get: (create: boolean): AssistantService | null => this.assistantFor(create),
    unavailable: (): string | null => this.assistantUnavailable,
  };

  private sendAssistant(res: ServerResponse, reply: AssistantReply): void {
    if (reply.download) {
      const text = JSON.stringify(reply.body, null, 2);
      res.writeHead(reply.status, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${reply.download.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "cache-control": "no-store",
        ...FRAME_HEADERS,
      });
      res.end(text);
      return;
    }
    this.json(res, reply.status, reply.body);
  }

  /** What the assistant needs to know about the thread a message belongs to: its project and the account it runs under. */
  private assistantScope(sessionId: string): { project: string | null; account: string | null } {
    const found = this.store.findSession(sessionId);
    return { project: found?.cwd ? normalizeCwd(found.cwd) : null, account: found?.session.accountId ?? null };
  }

  async listen(): Promise<{ port: number; host: string }> {
    // This server can run commands in the user's projects. Reaching it from the network takes a credential, and
    // nothing here would notice a missing one later, so the refusal comes before anything is bound, and before any
    // wait on the folder's lock.
    if (!this.options.token && !isLoopbackBind(this.options.host)) {
      throw new Error(
        `Refusing to listen on ${this.options.host || "every interface"}: that address can be reached from other machines, and this server can run commands in your projects. Pass --token <value> (a long random string), or leave --host out to listen on 127.0.0.1 only.`,
      );
    }
    if (this.ownerLock.state === "contended") {
      // Another server's record was there at the claim. A live owner ends this start here (`DataDirOwnedError`); one
      // that is closing or booting is waited for, within the boot budget; a dead one is taken over. Only then is the
      // store opened: nothing of the folder was touched so far.
      await this.ownerLock.resolve({ signal: this.shutdownSignal.signal, budgetMs: Math.min(this.ownerDeps.waitMs, this.bootRemaining()) });
      if (this.closed) {
        throw new Error("the server was closed before it listened");
      }
      this.openStore();
    }
    await this.bind();
    const listenAddr = this.server.address();
    const boundPort = typeof listenAddr === "object" && listenAddr ? listenAddr.port : this.options.port;
    this.ownerLock.setPort(boundPort);
    // Only now, holding the port, is this the server whose data this is: what the last process left in flight is
    // marked interrupted here (a Resume will act on them), and the turns it left running are of unknown fate.
    // Each sweep on its own, and each waits out a database another process has locked: one that cannot be done does not
    // take the other with it. The ready line waits for both, so with the database locked throughout that is about
    // twice the sum of the waits whatever the number of rows (each sweep stops at the first row the lock refuses),
    // cut short when the boot budget is spent: what is left is marked at the next start.
    const signal = AbortSignal.any([this.shutdownSignal.signal, this.bootBudget.signal]);
    try {
      this.researchInterruptedAtBoot = (
        await this.researchJobs.sweepInterruptedOnBoot(this.options.bootSweepRetryMs, signal, (ms, cut) => this.bootWait(ms, cut))
      ).length;
    } catch (error) {
      this.log(`the research sweep at boot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.sweepTurnsAtBoot(signal);
    // Only now may the assistant open: the sweep above marked the turns the last process left running as unknown, which
    // is what its tasks are reconciled against. One that was never switched on has no file, and nothing opens.
    this.assistantReady = true;
    if (!this.closed) {
      this.assistantFor(false);
    }
    // A server that was closed while it swept has nothing to schedule.
    if (!this.closed) {
      // No sweep at startup: which threads are busy in other Muse clients is only known after discovery.
      this.settleTimer = setInterval(() => this.autoSettle(), AUTO_SETTLE_SWEEP_MS);
      this.settleTimer.unref?.();
    }
    return { port: boundPort, host: this.options.host };
  }

  /** What is left of the boot budget, on the lock's clock. */
  private bootRemaining(): number {
    return Math.max(0, this.bootStartedAt + this.bootBudgetMs - this.ownerDeps.now());
  }

  /**
   * A wait of the sweeps at boot: at most what is left of the budget, and once that is spent the budget's signal
   * fires, so the sweep that asked stops at once and the other one never starts waiting.
   */
  private async bootWait(ms: number, signal?: AbortSignal): Promise<boolean> {
    const slept = await this.ownerDeps.wait(Math.min(ms, this.bootRemaining()), signal);
    if (this.bootRemaining() <= 0) {
      this.bootBudget.abort();
    }
    return slept && !this.bootBudget.signal.aborted;
  }

  /**
   * Binds the port. An address in use is an error to report, as today, except when the folder's lock was contended at
   * the claim: the previous owner may hold the port for the tail of its close (the desktop shell passes the same port
   * it saved), so the bind is tried again every `OWNER_POLL_MS` until the boot budget is spent.
   */
  private async bind(): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await new Promise<void>((resolve, reject) => {
          // A port that is taken is an error to report, not an uncaught event that ends the process after the fact.
          const refused = (error: Error) => reject(error);
          this.server.once("error", refused);
          this.server.listen(this.options.port, this.options.host, () => {
            this.server.off("error", refused);
            resolve();
          });
        });
        return;
      } catch (error) {
        const remaining = this.bootRemaining();
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || !this.ownerLock.wasContended || this.closed || remaining <= 0) {
          throw error;
        }
        if (attempt === 0) {
          this.ownerDeps.log(`port ${this.options.port} is still in use, most likely by the Ancilla that owned ${this.options.dataDir} until now: trying again until it is free.`);
        }
        if (!(await this.ownerDeps.wait(Math.min(OWNER_POLL_MS, remaining), this.shutdownSignal.signal))) {
          throw error;
        }
      }
    }
  }

  /**
   * The turns the last process left running become of unknown fate; a database another process has locked is waited
   * for. A close ends it at once, in the middle of a wait too: nothing here touches the store after that. The boot
   * budget ends it the same way.
   */
  private async sweepTurnsAtBoot(signal: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.closed || signal.aborted) {
        return;
      }
      try {
        const unknown = this.store.markRunningTurnsUnknown();
        if (unknown > 0) {
          this.log(`${unknown} turn(s) the last process left running are now of unknown outcome.`);
        }
        return;
      } catch (error) {
        const delay = this.options.bootSweepRetryMs[attempt];
        if (!isStoreBusy(error) || delay === undefined || this.closed) {
          this.log(`the turn sweep at boot failed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (!(await this.bootWait(delay, signal))) {
          return;
        }
      }
    }
  }

  /** Stops accepting requests and ends the connections open; a server that never listened has nothing to close. */
  private async closeListener(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve())),
    );
  }

  /**
   * Closes everything, in the order the data needs: the research runs first, then the hosts and the rest at once,
   * the listener, the store, and the folder's lock last. With `freePortFirst` the listener goes right away instead,
   * before the hosts are waited for: the desktop shell's next launch then finds the port free while this one winds
   * down (it waits on the lock, whose record says the close has begun). Requests get no 503 in that mode, which is why
   * the command line's signals keep the default.
   */
  async close(options: { freePortFirst?: boolean } = {}): Promise<void> {
    this.closed = true;
    // First of all: a launcher waiting on this folder reads the record, and keeps waiting instead of refusing.
    this.ownerLock.markClosing();
    this.shutdownSignal.abort();
    if (options.freePortFirst) {
      await this.closeListener();
    }
    this.wakeStartWaiters();
    this.subscriptionReader.close();
    await this.linuxInstaller.close();
    for (const child of this.loginChildren.values()) child.kill();
    this.loginChildren.clear();
    if (this.changeTimer !== null) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    if (this.settleTimer !== null) {
      clearInterval(this.settleTimer);
      this.settleTimer = null;
    }
    this.titleQueue.length = 0;
    // Research jobs go first: their workers still need the hosts to take the interrupts. A server refused by the
    // folder's lock never opened them, nor the store.
    await this.researchJobs?.close();
    this.sse.close();
    // What is left waits on something that may never answer, so all of it waits at once and the longest wait bounds the
    // close (`worstCaseCloseMs` adds it up): the starts still open, each registered host, the title worker, and the `!`
    // commands still running. The listener stays up meanwhile, so a request is answered 503 instead of being refused.
    const registered = [...this.hosts.values()];
    await Promise.all([
      this.settleStarts(),
      ...registered.map((managed) => this.closeHost(managed)),
      this.titleWorker ? settledWithin(this.titleWorker, this.hostWaits.startsMs) : undefined,
      stopPendingCaptures(this.pendingCaptures, { graceMs: this.hostWaits.shellsMs }),
      this.launchManager ? this.launchManager.stopAll({ graceMs: this.hostWaits.shellsMs }) : undefined,
    ]);
    this.launchManager = null;
    this.authorizationHub?.clear();
    this.authorizationHub = null;
    this.hosts.clear();
    if (!options.freePortFirst) {
      await this.closeListener();
    }
    // Last, and flagged first: a frame from a host that outlived its close finds the store closed and is dropped.
    this.storeClosed = true;
    this.browserSockets?.close();
    this.browserSockets = null;
    this.browserWatchers?.close();
    this.browserWatchers = null;
    this.browseRunner?.stop();
    this.browseRunner = null;
    this.browseSites = null;
    this.connectorRunner?.stop();
    this.connectorRunner = null;
    this.connectorState?.registry.close();
    this.connectorState = null;
    await this.browserService?.dispose().catch(() => undefined);
    this.browserService = null;
    // The voice first: a call reads and writes the assistant's database, and it hangs up before that closes.
    this.voiceSockets?.close();
    await this.voiceService?.close().catch(() => undefined);
    this.voiceService = null;
    this.voiceSockets = null;
    this.assistant?.close();
    this.assistant = null;
    this.store?.close();
    // After the store: the folder is another server's only once nothing here can write to it.
    this.ownerLock.release();
  }

  /**
   * Waits up to `hostWaits.startsMs` for every host start in flight, then gives up on those still open: each is marked
   * abandoned, forgotten, and its host closed (which ends a start that is still waiting for an answer). An abandoned
   * start that answers later is closed and never registered, so it cannot outlive the restart or shutdown that gave
   * up on it. During a shutdown a start that answers inside the wait finds the server closed, so it too is closed in
   * the background and never awaited: `close()` does not wait for those closes (a host that ignores both the end of
   * its input and SIGTERM can outlive a server that exits; see docs/muse-recovery.md).
   */
  private async settleStarts(): Promise<void> {
    const open = [...this.starting.values()];
    if (open.length > 0) {
      await settledWithin(Promise.allSettled(open), this.hostWaits.startsMs);
    }
    for (const [key, token] of this.startTokens) {
      token.abandoned = true;
      if (token.handle && !token.closing) {
        token.closing = true;
        closeInBackground(token.handle);
      }
      this.starting.delete(key);
    }
    this.startTokens.clear();
  }

  /** Closes one registered host, for at most `hostWaits.closeMs`; a host that will not close is dropped all the same. */
  private async closeHost(managed: ManagedHost): Promise<void> {
    const closing = (async () => managed.handle.close())();
    closing.catch(() => undefined);
    await settledWithin(closing, this.hostWaits.closeMs);
  }

  /**
   * One event to every client of the stream, serialised once and shared. Nothing here merges or drops an event for a
   * client that keeps up, `session-status` and the lifecycle edges above all; what the stream sheds is a client that
   * does not (see `SseBroadcaster`), and a research run's own sessions, which no client has any use for.
   */
  private emit(eventType: string, eventPayload: unknown): void {
    if (this.sse.size === 0) {
      return;
    }
    if (this.isResearchFrame(eventType, eventPayload)) {
      this.sse.countSkipped();
      return;
    }
    let serializedMessage: string;
    try {
      const jsonBody = JSON.stringify(eventPayload);
      if (typeof jsonBody !== "string") {
        throw new TypeError("the event has no JSON form");
      }
      serializedMessage = `event: ${eventType}\ndata: ${jsonBody}\n\n`;
    } catch (serializationErr) {
      this.sse.countSerializationFailure();
      const errDetail = serializationErr instanceof Error ? serializationErr.message : String(serializationErr);
      this.log(`event stream: could not serialise a ${eventType} event: ${errDetail}`);
      return;
    }
    this.sse.publish(serializedMessage);
  }

  private isResearchFrame(eventType: string, eventPayload: unknown): boolean {
    if (eventType !== "ancilla" || typeof eventPayload !== "object" || eventPayload === null) {
      return false;
    }
    const candidate = eventPayload as { type?: unknown; sessionId?: unknown };
    if ((candidate.type !== "msp" && candidate.type !== "session-status") || typeof candidate.sessionId !== "string") {
      return false;
    }
    return this.knownResearchSession(candidate.sessionId);
  }

  private knownResearchSession(targetSessionId: string): boolean {
    const cachedOrigin = this.researchOrigins.get(targetSessionId);
    if (cachedOrigin !== undefined) {
      return cachedOrigin;
    }
    const nextLookupTime = this.researchMisses.get(targetSessionId);
    if (nextLookupTime !== undefined) {
      if (performance.now() < nextLookupTime) {
        return false;
      }
      this.researchMisses.delete(targetSessionId);
    }
    let isResearchWorker = false;
    try {
      const sessionRow = this.store.getSession(targetSessionId);
      if (sessionRow === null) {
        this.rememberResearchMiss(targetSessionId);
        return false;
      }
      isResearchWorker = sessionRow.origin === "research-worker";
    } catch {
      return false;
    }
    this.rememberResearchOrigin(targetSessionId, isResearchWorker);
    return isResearchWorker;
  }

  private rememberResearchMiss(missingSessionId: string): void {
    this.researchMisses.delete(missingSessionId);
    if (this.researchMisses.size >= RESEARCH_ORIGIN_CACHE_LIMIT) {
      const oldestEntry = this.researchMisses.keys().next();
      if (!oldestEntry.done) {
        this.researchMisses.delete(oldestEntry.value);
      }
    }
    this.researchMisses.set(missingSessionId, performance.now() + RESEARCH_MISS_MS);
  }

  private rememberResearchOrigin(targetSessionId: string, isResearch: boolean): void {
    if (this.researchOrigins.size >= RESEARCH_ORIGIN_CACHE_LIMIT) {
      const firstEntry = this.researchOrigins.keys().next();
      if (!firstEntry.done) {
        this.researchOrigins.delete(firstEntry.value);
      }
    }
    this.researchOrigins.set(targetSessionId, isResearch);
  }

  private notifySessionsChange(): void {
    if (Boolean(this.changeTimer) || this.closed) {
      return;
    }
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit("ancilla", { type: "sessions-changed" as const });
    }, 120);
  }

  private sessionsChanged(): void {
    this.notifySessionsChange();
  }

  private static readonly AUTH_COOKIE = "ancilla_token";

  private foreignOrigin(incomingReq: IncomingMessage): string | null {
    const rawOrigin = incomingReq.headers["origin"];
    if (typeof rawOrigin !== "string" || rawOrigin.length === 0) {
      return (null);
    }
    const hostHeader = typeof incomingReq.headers["host"] === "string" ? incomingReq.headers["host"] : "";
    if (hostHeader.length > 0 && (rawOrigin === `http://${hostHeader}` || rawOrigin === `https://${hostHeader}`)) {
      return (null);
    }
    return rawOrigin;
  }

  private cookie(incomingReq: IncomingMessage, cookieName: string): string | null {
    const headerValue = incomingReq.headers["cookie"];
    if (typeof headerValue !== "string") {
      return (null);
    }
    const cookieTokens = headerValue.split(";");
    for (const segment of cookieTokens) {
      const parts = segment.trim().split("=");
      const key = parts[0];
      const val = parts.slice(1).join("=");
      if (key === cookieName) {
        return safeDecode(val);
      }
    }
    return (null);
  }

  private cors(incomingReq: IncomingMessage, outgoingRes: ServerResponse): boolean {
    const requestOrigin = this.foreignOrigin(incomingReq);
    if (!requestOrigin) {
      return (true);
    }
    if (!this.options.allowOrigins.includes(requestOrigin)) {
      return (false);
    }
    outgoingRes.setHeader("access-control-allow-origin", requestOrigin);
    outgoingRes.setHeader("vary", "Origin");
    outgoingRes.setHeader("access-control-allow-credentials", "true");
    outgoingRes.setHeader("access-control-allow-headers", "authorization, content-type, range");
    outgoingRes.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    return (true);
  }

  private bearerValid(incomingReq: IncomingMessage): boolean {
    const expectedToken = this.options.token;
    const authHeader = incomingReq.headers["authorization"];
    const prefix = "Bearer ";
    return (
      typeof expectedToken === "string" &&
      typeof authHeader === "string" &&
      authHeader.startsWith(prefix) &&
      safeEqual(authHeader.slice(prefix.length), expectedToken)
    );
  }

  private authorized(incomingReq: IncomingMessage): boolean {
    const activeToken = this.options.token;
    if (!activeToken) {
      return (true);
    }
    const storedCookie = this.cookie(incomingReq, AncillaServer.AUTH_COOKIE);
    if (storedCookie !== null && safeEqual(storedCookie, activeToken)) {
      return (true);
    }
    if (this.bearerValid(incomingReq)) {
      return (true);
    }
    if (this.foreignOrigin(incomingReq) !== null) {
      return (false);
    }
    const requestUrl = new URL(incomingReq.url ?? "/", "http://localhost");
    const tokenParam = requestUrl.searchParams.get("token");
    return tokenParam !== null && safeEqual(tokenParam, activeToken);
  }

  private json(outgoingRes: ServerResponse, statusCode: number, responseBody: unknown): void {
    const serializedJson = JSON.stringify(responseBody);
    outgoingRes.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...FRAME_HEADERS,
    });
    outgoingRes.end(serializedJson);
  }

  private segment(rawSegment: string): string {
    const decodedValue = safeDecode(rawSegment);
    if (decodedValue === null) {
      throw new HttpError(400, "That address is not valid.");
    }
    return decodedValue;
  }

  private refuseHost(incomingReq: IncomingMessage, outgoingRes: ServerResponse): void {
    const rawHostHeader = incomingReq.headers["host"];
    const displayHost =
      typeof rawHostHeader === "string" && rawHostHeader.trim()
        ? rawHostHeader.trim().slice(0, 100).replace(/[^\x21-\x7e]/g, "?")
        : "";
    const parsedNormalized = typeof rawHostHeader === "string" ? normalizeHost(rawHostHeader) : null;
    const validHostName =
      parsedNormalized !== null && parsedNormalized.length <= MAX_HOST_NAME_LENGTH ? parsedNormalized : null;
    const configurationHint = validHostName === null ? null : `--allow-host ${validHostName}`;

    this.hostRefusals += 1;
    if (validHostName !== null) {
      this.lastRefusedHost = validHostName;
    }

    const hostLogKey = validHostName ?? (displayHost || "(none)");
    if (!this.refusedHostsLogged.has(hostLogKey) && this.refusedHostsLogged.size < MAX_REFUSED_HOSTS_LOGGED) {
      this.refusedHostsLogged.add(hostLogKey);
      const limitNotice =
        this.refusedHostsLogged.size === MAX_REFUSED_HOSTS_LOGGED ? " No more refused hosts will be logged." : "";
      let logMessage: string;
      if (configurationHint !== null) {
        logMessage = `refused a request for host ${JSON.stringify(displayHost)}; if this is your own proxy or tunnel, add ${configurationHint} (or "allowHosts" in runtime.json).`;
      } else if (displayHost) {
        logMessage = `refused a request for an unusable host name (${JSON.stringify(displayHost)}); it is not a name or address that could be allowed.`;
      } else {
        logMessage = "refused a request that names no host.";
      }
      this.log(logMessage + limitNotice);
    }

    let failureMessage: string;
    if (configurationHint !== null) {
      failureMessage = `This daemon does not answer requests for the host "${displayHost}". If it is behind a proxy or a tunnel, start the server with ${configurationHint}, or list that name under "allowHosts" in runtime.json.`;
    } else if (displayHost) {
      failureMessage = `This daemon does not answer requests for an unusable host name (${JSON.stringify(displayHost)}). A host name is letters, digits, dots and hyphens, or an IP address.`;
    } else {
      failureMessage = `This request names no host, which this daemon does not answer. Send a Host header, or start the server with --allow-host <name> (or "allowHosts" in runtime.json).`;
    }
    this.fail(outgoingRes, 403, failureMessage, "host");
  }

  private fail(
    outgoingRes: ServerResponse,
    statusCode: number,
    errMessage: string,
    errKind: string | null = null,
  ): void {
    if (!outgoingRes.headersSent) {
      this.json(outgoingRes, statusCode, { error: errMessage, kind: errKind });
    } else {
      outgoingRes.end();
    }
  }

  private async readBody(
    incomingReq: IncomingMessage,
    bodyByteLimit = MAX_BODY_BYTES,
  ): Promise<Record<string, unknown>> {
    const declaredSize = Number(incomingReq.headers["content-length"]);
    if (Number.isFinite(declaredSize) && declaredSize > bodyByteLimit) {
      throw new HttpError(413, "That request is too large.");
    }
    const rawBuffers: Buffer[] = [];
    let byteCounter = 0;
    for await (const chunk of incomingReq) {
      const buf = chunk as Buffer;
      byteCounter += buf.length;
      if (byteCounter > bodyByteLimit) {
        const errorMsg = "That request is too large.";
        throw new HttpError(413, errorMsg);
      }
      rawBuffers.push(buf);
    }
    const parsedText = Buffer.concat(rawBuffers).toString("utf8").trim();
    if (parsedText.length === 0) {
      return {} as Record<string, unknown>;
    }
    return asRecord(JSON.parse(parsedText) as unknown) ?? {};
  }
  private async route(incomingReq: IncomingMessage, outgoingRes: ServerResponse): Promise<void> {
    if (this.enforceHost && !trustedHost(incomingReq.headers["host"], this.trustedHosts) && !this.bearerValid(incomingReq)) {
      this.refuseHost(incomingReq, outgoingRes);
      return;
    }
    let targetUrl: URL;
    try {
      targetUrl = new URL(incomingReq.url ?? "/", "http://localhost");
    } catch {
      this.fail(outgoingRes, 400, "That address is not valid.");
      return;
    }
    const routePath = targetUrl.pathname;
    const httpMethod = (incomingReq.method ?? "GET").toUpperCase();

    if (
      this.options.allowOrigins.length === 0 &&
      crossSiteApiRequest(headerText(incomingReq, "sec-fetch-site"), headerText(incomingReq, "sec-fetch-mode"), routePath)
    ) {
      this.fail(outgoingRes, 403, "This daemon does not answer requests started by another site.", "fetchMetadata");
      return;
    }
    if (!this.cors(incomingReq, outgoingRes)) {
      this.fail(outgoingRes, 403, "This daemon does not answer that origin.");
      return;
    }
    if (httpMethod === "OPTIONS") {
      outgoingRes.writeHead(204);
      outgoingRes.end();
      return;
    }
    if (!(httpMethod === "POST" && routePath === "/api/auth") && !this.authorized(incomingReq)) {
      this.fail(outgoingRes, 401, "Missing or invalid token.");
      return;
    }
    if (this.closed && !(httpMethod === "GET" && routePath === "/api/health")) {
      this.fail(outgoingRes, 503, "Ancilla is shutting down.");
      return;
    }
    if (routePath.startsWith("/api/")) {
      try {
        const isHandled = await this.api(httpMethod, routePath, targetUrl, incomingReq, outgoingRes);
        if (!isHandled) {
          this.fail(outgoingRes, 404, "Not found.");
        }
      } catch (err) {
        const failureDetails = errorInfo(err);
        this.fail(outgoingRes, failureDetails.status, failureDetails.message, failureDetails.kind);
      }
      return;
    }
    if (this.options.staticDir && httpMethod === "GET") {
      const wasServed = await this.serveStatic(routePath, outgoingRes);
      if (wasServed) {
        return;
      }
    }
    this.fail(outgoingRes, 404, "Not found.");
  }

  private async api(
    method: string,
    path: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if (path === "/api/auth" && method === "POST") {
      const maxPayloadBytes = Math.max(MIN_AUTH_BODY_BYTES, (this.options.token ?? "").length * 6 + 256);
      const authPayload = await this.readBody(req, maxPayloadBytes);
      if (this.options.token === null || this.options.token === undefined) {
        this.json(res, 200, { ok: true, required: false as const });
        return (true);
      }
      const suppliedToken = str(authPayload["token"]);
      if (suppliedToken === null || !safeEqual(suppliedToken, this.options.token)) {
        const mismatchError = "That token does not match this daemon.";
        throw new HttpError(401, mismatchError);
      }
      const isCrossOrigin = this.foreignOrigin(req) !== null;
      const cookieDirectives = [
        `${AncillaServer.AUTH_COOKIE}=${encodeURIComponent(this.options.token)}`,
        "Path=/",
        "HttpOnly",
        "Max-Age=604800",
        isCrossOrigin ? "SameSite=None" : "SameSite=Lax",
      ];
      if (isCrossOrigin) {
        cookieDirectives.push("Secure");
      }
      res.setHeader("set-cookie", cookieDirectives.join("; "));
      this.json(res, 200, { ok: true, required: true as const });
      return (true);
    }

    if (path === "/api/health" && method === "GET") {
      const healthStatus = {
        ok: true,
        closing: this.closed,
        version: ANCILLA_VERSION,
        instanceId: this.instanceId,
        owner: {
          lock: this.ownerLock.healthLock(),
          pid: process.pid,
          startedAt: this.ownerLock.record.startedAt,
          file: this.ownerLock.file,
        },
        hosts: [...this.hosts.values()].map((h) => ({
          key: h.key,
          serverVersion: h.serverVersion,
          startedAt: h.startedAt,
        })),
        lastHostError: this.lastHostError,
        research: { ...this.researchJobs.counts(), interruptedAtBoot: this.researchInterruptedAtBoot },
        fingerprintWarnings: Object.fromEntries(this.fingerprints),
        diagnostics: {
          now: new Date().toISOString(),
          protocolErrors: this.protocolErrors,
          lastProtocolError: this.lastProtocolError,
          forwardFailures: this.forwardFailures,
          lastForwardFailure: this.lastForwardFailure,
          hostExits: { count: this.hostExits, lastExitAt: this.lastHostExitAt },
          sse: this.sse.stats(),
          hostRefusals: this.hostRefusals,
          lastRefusedHost: this.lastRefusedHost,
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
      };
      this.json(res, 200, healthStatus);
      return (true);
    }

    if (path === "/api/env" && method === "GET") {
      const forceRefresh = url.searchParams.get("refresh") === "1";
      const environmentInfo = await this.environment(forceRefresh);
      this.json(res, 200, environmentInfo);
      return (true);
    }

    if (method === "GET" && path === "/api/setup/linux") {
      this.json(res, 200, await this.linuxSetup(url.searchParams.get("accountId") || null));
      return true;
    }
    if (method === "POST" && path === "/api/setup/linux/install") {
      if (this.options.platform !== "linux") throw new HttpError(400, "In-app Muse installation is available on Linux.");
      if (process.platform === "linux" && process.getuid?.() === 0) {
        throw new HttpError(409, "Open Ancilla as your normal desktop account to install Muse for that account.");
      }
      const configured = this.options.musePath;
      const managed = join(this.options.home, ".local", "bin", "muse");
      if (configured && configured.includes("/") && configured !== managed) {
        throw new HttpError(409, `Ancilla is configured to use Muse at “${configured}”. Restore that installation or remove musePath from Ancilla’s runtime.json to use guided installation.`);
      }
      await this.ensureLinuxMuseStorage(null);
      await this.linuxInstaller.start();
      this.envCache = null;
      this.json(res, 202, await this.linuxSetup(null));
      return true;
    }
    if (method === "DELETE" && path === "/api/setup/linux/install") {
      const attemptId = url.searchParams.get("attemptId");
      if (!attemptId) throw new HttpError(400, "attemptId is required to cancel this installation.");
      await this.linuxInstaller.cancel(attemptId);
      this.envCache = null;
      this.json(res, 200, await this.linuxSetup(null));
      return true;
    }
    if (method === "POST" && path === "/api/setup/linux/repair") {
      if (this.options.platform !== "linux") throw new HttpError(400, "This storage check is available on Linux.");
      const body = await this.readBody(req);
      const accountId = body["accountId"];
      if (accountId !== undefined && accountId !== null && typeof accountId !== "string") throw new HttpError(400, "accountId must be a string or null.");
      const diagnosis = await repairMuseStorage(await this.museStorageOptions(typeof accountId === "string" ? accountId : null));
      this.json(res, 200, await this.linuxSetup(typeof accountId === "string" ? accountId : null, diagnosis));
      return true;
    }

    if (path === "/api/events" && method === "GET") {
      const responseStream = res;
      this.serveEvents(responseStream);
      return (true);
    }

    if (path === "/api/projects" && method === "GET") {
      const activeProjects = this.store.listProjects().map((p) => this.projectView(p));
      this.json(res, 200, { projects: activeProjects });
      return (true);
    }

    if (path === "/api/projects" && method === "POST") {
      const reqPayload = await this.readBody(req);
      const rawCwd = str(reqPayload["cwd"]);
      if (!rawCwd || !rawCwd.trim()) {
        const errorMsg = "cwd is required.";
        throw new HttpError(400, errorMsg);
      }
      const canonicalProjectCwd = await this.canonicalCwd(rawCwd, reqPayload["create"] === true);
      const addedResult = await this.addProjectFolder(canonicalProjectCwd);
      this.json(res, 200, addedResult);
      return (true);
    }

    if (path === "/api/projects/folders" && method === "POST") {
      const bodyData = await this.readBody(req);
      const rawProjectCwd = str(bodyData["cwd"]);
      const rawFolderPath = str(bodyData["path"]);
      if (!rawProjectCwd || !rawFolderPath || !rawFolderPath.trim()) {
        const missingFields = "cwd and path are required.";
        throw new HttpError(400, missingFields);
      }
      const normalizedProjectCwd = normalizeCwd(rawProjectCwd);
      if (!this.store.getProject(normalizedProjectCwd)) {
        const notFoundFolder = "Unknown project folder.";
        throw new HttpError(404, notFoundFolder);
      }
      const canonicalSubfolder = await this.canonicalCwd(rawFolderPath, false);
      const updatedProject = this.store.addProjectFolder(normalizedProjectCwd, canonicalSubfolder);
      let discoveryWarning: string | null = null;
      try {
        await this.discover(canonicalSubfolder);
      } catch (discErr) {
        discoveryWarning = errorInfo(discErr).message;
      }
      this.notifySessionsChange();
      this.json(res, 200, {
        project: this.projectView(this.store.getProject(normalizedProjectCwd) ?? updatedProject),
        warning: discoveryWarning,
      });
      return (true);
    }

    if (path === "/api/projects/folders" && method === "DELETE") {
      const parentCwd = url.searchParams.get("cwd");
      const folderPath = url.searchParams.get("path");
      if (!parentCwd || !folderPath) {
        const missingParam = "cwd and path are required.";
        throw new HttpError(400, missingParam);
      }
      const projectRecord = this.store.removeProjectFolder(normalizeCwd(parentCwd), normalizeCwd(folderPath));
      this.notifySessionsChange();
      this.json(res, 200, { project: this.projectView(projectRecord) });
      return (true);
    }

    if (path === "/api/projects/clone" && method === "POST") {
      const cloneBody = await this.readBody(req);
      const remoteRepoUrl = str(cloneBody["url"])?.trim() ?? "";
      const targetDirectory = str(cloneBody["path"])?.trim() ?? "";
      if (!remoteRepoUrl || !targetDirectory) {
        const missingArgs = "url and path are required.";
        throw new HttpError(400, missingArgs);
      }
      if (
        !/^(https?:\/\/|ssh:\/\/|git:\/\/)\S+$/.test(remoteRepoUrl) &&
        !/^git@[^\s:]+:\S+$/.test(remoteRepoUrl)
      ) {
        const invalidGitUrl = "That does not look like a Git URL.";
        throw new HttpError(400, invalidGitUrl);
      }
      const clonedLocalCwd = normalizeCwd(await this.cloneRepository(remoteRepoUrl, targetDirectory));
      const addProjectResult = await this.addProjectFolder(clonedLocalCwd);
      this.json(res, 200, addProjectResult);
      return (true);
    }

    if (path === "/api/fs/list" && method === "GET") {
      const targetDir = url.searchParams.get("path") ?? "";
      const pathCtx = await this.pathContext(targetDir);
      const dirContents = await listDirectory(targetDir, pathCtx);
      this.json(res, 200, dirContents);
      return (true);
    }

    if (path.indexOf("/api/files/") === 0) {
      return (this.files(method, path, url, req, res));
    }

    if (path === "/api/fs/reveal" && method === "POST") {
      const revealBody = await this.readBody(req);
      const userTargetPath = str(revealBody["path"]);
      if (!userTargetPath) {
        const requiredPath = "path is required.";
        throw new HttpError(400, requiredPath);
      }
      const resolvedPath = resolveUserPath(userTargetPath, await this.pathContext(userTargetPath));
      const directoryStat = await stat(resolvedPath.local).catch(() => null);
      if (!directoryStat?.isDirectory()) {
        const folderNotFound = "That folder does not exist.";
        throw new HttpError(404, folderNotFound);
      }
      await this.opener(resolvedPath.local, "files");
      this.json(res, 200, { ok: true as const });
      return (true);
    }

    if (path === "/api/projects" && method === "DELETE") {
      const cwdParam = url.searchParams.get("cwd");
      if (!cwdParam) {
        const requiredCwd = "cwd is required.";
        throw new HttpError(400, requiredCwd);
      }
      this.store.setHidden(cwdParam, true);
      this.notifySessionsChange();
      this.json(res, 200, { ok: true as const });
      return (true);
    }

    if (path === "/api/projects/order" && method === "PATCH") {
      const orderBody = await this.readBody(req);
      const cwdList = orderBody["cwds"];
      if (!Array.isArray(cwdList)) {
        const requiredCwds = "cwds is required.";
        throw new HttpError(400, requiredCwds);
      }
      const validCwds = cwdList
        .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
        .map(normalizeCwd);
      this.store.setProjectOrder(validCwds);
      this.notifySessionsChange();
      this.json(res, 200, { ok: true as const });
      return (true);
    }

    if (path === "/api/projects/pin" && method === "PATCH") {
      const pinBody = await this.readBody(req);
      const targetCwd = str(pinBody["cwd"]);
      if (!targetCwd) {
        const requiredCwd = "cwd is required.";
        throw new HttpError(400, requiredCwd);
      }
      this.store.upsertProject(targetCwd);
      this.store.setPinned(targetCwd, pinBody["pinned"] === true);
      this.notifySessionsChange();
      this.json(res, 200, { ok: true as const });
      return (true);
    }

    if (path === "/api/slash" && method === "GET") {
      const workspaceCwd = normalizeCwd(url.searchParams.get("cwd") ?? "");
      const sessionParam = url.searchParams.get("sessionId");
      const skillListing = await this.listSkills(workspaceCwd, sessionParam);
      this.json(res, 200, { skills: skillListing.skills, error: skillListing.error });
      return (true);
    }

    if (path === "/api/slash/skill" && method === "GET") {
      const skillIdentifier = url.searchParams.get("id");
      if (!skillIdentifier) {
        const missingId = "id is required.";
        throw new HttpError(400, missingId);
      }
      const workspaceCwd = normalizeCwd(url.searchParams.get("cwd") ?? "");
      const fetchedContent = await this.skillBody(workspaceCwd, skillIdentifier);
      this.json(res, 200, { id: skillIdentifier, body: fetchedContent });
      return (true);
    }

    if (path === "/api/sessions" && method === "GET") {
      const filterCwd = url.searchParams.get("cwd");
      const shouldIncludeArchived = url.searchParams.get("archived") === "1";
      const targetProjects = filterCwd
        ? [this.store.getProject(filterCwd)].filter((p): p is NonNullable<typeof p> => p !== null)
        : this.store.listFolders();
      const sessionSummaries = targetProjects.flatMap((proj) =>
        this.store
          .listSessionsByProject(proj.id, { includeArchived: shouldIncludeArchived })
          .map((sessionRecord) => this.summary(sessionRecord, proj.cwd)),
      );
      this.json(res, 200, { sessions: sessionSummaries });
      return (true);
    }

    if (path === "/api/discover" && method === "POST") {
      const discoverPayload = await this.readBody(req);
      const targetCwd = str(discoverPayload["cwd"]) ?? undefined;
      const discoveredSessions = await this.discover(targetCwd);
      this.json(res, 200, { sessions: discoveredSessions });
      return (true);
    }

    if (path === "/api/sessions" && method === "POST") {
      const createSessionPayload = await this.readBody(req);
      const rawCwd = str(createSessionPayload["cwd"]);
      if (!rawCwd) {
        const missingCwd = "cwd is required.";
        throw new HttpError(400, missingCwd);
      }
      const approvalModeCandidate = createSessionPayload["approvalMode"];
      if (
        approvalModeCandidate !== undefined &&
        approvalModeCandidate !== null &&
        !isApprovalMode(approvalModeCandidate)
      ) {
        const invalidMode = "Unknown approvalMode.";
        throw new HttpError(400, invalidMode);
      }
      const accountCandidate = createSessionPayload["accountId"];
      if (
        accountCandidate !== undefined &&
        accountCandidate !== null &&
        typeof accountCandidate !== "string"
      ) {
        const invalidAccount = "accountId must be a string.";
        throw new HttpError(400, invalidAccount);
      }
      const providerCandidate = createSessionPayload["providerId"];
      if (
        providerCandidate !== undefined &&
        providerCandidate !== null &&
        !isProviderId(providerCandidate)
      ) {
        const invalidProvider = "Unknown providerId.";
        throw new HttpError(400, invalidProvider);
      }
      const normalizedWorkspaceCwd = normalizeCwd(rawCwd);
      const existingProjectRecord = this.store.projectForFolder(normalizedWorkspaceCwd);
      const selectedProvider =
        providerCandidate !== undefined && providerCandidate !== null
          ? providerCandidate
          : this.normalizeProviderId(existingProjectRecord?.defaultProviderId);
      const selectedAccount =
        accountCandidate !== undefined
          ? (typeof accountCandidate === "string" && accountCandidate.length > 0 ? accountCandidate : null)
          : (selectedProvider !== "muse" ? (existingProjectRecord?.defaultAccountId ?? null) : null);

      const createdSession = await this.startSession(
        normalizedWorkspaceCwd,
        approvalModeCandidate === undefined || approvalModeCandidate === null
          ? undefined
          : (approvalModeCandidate as ApprovalMode),
        str(createSessionPayload["modelId"]) ?? undefined,
        selectedAccount,
        selectedProvider,
      );
      this.json(res, 200, { session: createdSession });
      return (true);
    }

    const proxyRouteMatch = path.match(/^\/api\/sessions\/([^/]+)\/shell-proxy$/);
    if (proxyRouteMatch && method === "POST") {
      const targetSessionId = this.segment(proxyRouteMatch[1] as string);
      const shellPayload = await this.readBody(req);
      const shellCmd = str(shellPayload["command"])?.trim();
      if (!shellCmd) {
        const missingCmd = "command is required.";
        throw new HttpError(400, missingCmd);
      }
      const sessionRecord = this.store.findSession(targetSessionId);
      if (!sessionRecord) {
        const notFoundSession = "Unknown session.";
        throw new HttpError(404, notFoundSession);
      }
      const execResult = await this.runInWorkspace(sessionRecord.cwd, shellCmd);
      if (this.storeClosed) {
        const closingMsg = "Ancilla is shutting down.";
        throw new HttpError(503, closingMsg);
      }
      const recordedRun = this.store.addShellRun({
        id: randomUUID(),
        sessionId: targetSessionId,
        command: shellCmd,
        exitCode: execResult.exitCode,
        output: execResult.output,
        truncated: execResult.truncated,
        durationMs: execResult.durationMs,
        at: nowIso(),
      });
      this.store.updateSession(targetSessionId, { activityAt: nowIso() });
      this.emit("ancilla", { type: "shell-run", sessionId: targetSessionId, run: recordedRun });
      this.json(res, 200, { run: recordedRun });
      return (true);
    }

    const outputRouteMatch = path.match(/^\/api\/sessions\/([^/]+)\/output$/);
    if (outputRouteMatch && method === "GET") {
      const targetSessionId = this.segment(outputRouteMatch[1] as string);
      const queryItemId = url.searchParams.get("itemId");
      const queryOutputRef = url.searchParams.get("outputRef");
      if (!queryItemId || !queryOutputRef) {
        const missingOutputParams = "itemId and outputRef are required.";
        throw new HttpError(400, missingOutputParams);
      }
      const rawOffset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
      const rawLength = Number.parseInt(url.searchParams.get("length") ?? String(OUTPUT_PAGE_BYTES), 10);
      const sessionManager = await this.managerForSession(targetSessionId);
      const outputRange = await sessionManager.readItemOutput(targetSessionId, queryItemId, queryOutputRef, {
        offsetBytes: Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0,
        lengthBytes:
          Number.isFinite(rawLength) && rawLength > 0 ? Math.min(rawLength, OUTPUT_PAGE_BYTES) : OUTPUT_PAGE_BYTES,
      });
      this.json(res, 200, { output: outputRange });
      return (true);
    }

    const sessionActionMatch = path.match(
      /^\/api\/sessions\/([^/]+)(?:\/(resume|model|approval-mode|compact|shell|fork|effort|goal|subagent|tasks|workflow))?$/,
    );
    if (sessionActionMatch) {
      const targetSessionId = this.segment(sessionActionMatch[1] as string);
      const routeAction = sessionActionMatch[2];

      if (!routeAction && method === "PATCH") {
        const patchPayload = await this.readBody(req);
        const sessionRecord = this.store.findSession(targetSessionId);
        if (!sessionRecord) {
          const sessionErr = "Unknown session.";
          throw new HttpError(404, sessionErr);
        }
        const newTitle =
          typeof patchPayload["title"] === "string" ? patchPayload["title"].trim().slice(0, 200) : undefined;
        const newSettled =
          typeof patchPayload["settled"] === "boolean" ? patchPayload["settled"] : undefined;

        if (newSettled === true && this.isBusy(targetSessionId)) {
          const busyErr = "Stop the running turn and answer its requests before settling this thread.";
          throw new HttpError(409, busyErr);
        }

        const shelvingKind =
          patchPayload["archived"] === true ? "archiving" : newSettled === true ? "settling" : null;
        const checkLiveResearch = (): void => {
          if (shelvingKind && this.hasLiveResearch(targetSessionId)) {
            const researchErr = `This thread has a research run in progress. Stop it, or wait for it to finish, before ${shelvingKind} the thread.`;
            throw new HttpError(409, researchErr);
          }
        };
        checkLiveResearch();
        if (newTitle && newTitle !== sessionRecord.session.title) {
          await this.renameInMuse(targetSessionId, newTitle);
        }
        checkLiveResearch();

        const updatedRecord = this.store.updateSession(targetSessionId, {
          ...(newTitle ? { title: newTitle, titleSource: "user" as const } : {}),
          ...(typeof patchPayload["archived"] === "boolean" ? { archived: patchPayload["archived"] } : {}),
          ...(newSettled === true
            ? { settledOverride: "settled" as const, settledAt: nowIso(), unsettledAt: null }
            : {}),
          ...(newSettled === false
            ? { settledOverride: "active" as const, settledAt: null, unsettledAt: nowIso() }
            : {}),
        });
        this.notifySessionsChange();
        this.json(res, 200, {
          session: updatedRecord ? this.summary(updatedRecord, sessionRecord.cwd) : null,
        });
        return (true);
      }

      if (Boolean(routeAction) && method === "POST") {
        const actionPayload = await this.readBody(req);
        if (routeAction === "resume") {
          const forceRefresh = actionPayload["refresh"] === true;
          const transcriptData = await this.loadTranscript(targetSessionId, forceRefresh);
          this.json(res, 200, transcriptData);
          return (true);
        }

        const activeManager = await this.managerForSession(targetSessionId);

        if (routeAction === "model") {
          if (!("model" in actionPayload)) {
            const missingModel = "model is required.";
            throw new HttpError(400, missingModel);
          }
          await this.setThreadModel(targetSessionId, actionPayload["model"], activeManager);
          this.json(res, 200, { ok: true as const });
          return (true);
        }

        if (routeAction === "compact") {
          const compactionResult = await this.holdingHost(() => activeManager.compactSession(targetSessionId));
          this.json(res, 200, { result: compactionResult });
          return (true);
        }

        if (routeAction === "shell") {
          const shellCommandText = str(actionPayload["command"])?.trim();
          if (!shellCommandText) {
            const missingCmd = "command is required.";
            throw new HttpError(400, missingCmd);
          }
          this.wake(targetSessionId);
          await activeManager.userShell(targetSessionId, shellCommandText);
          this.store.updateSession(targetSessionId, { activityAt: nowIso() });
          this.json(res, 200, { ok: true as const });
          return (true);
        }

        if (routeAction === "fork") {
          const forkedSession = await this.holdingHost(() => this.forkSession(targetSessionId, activeManager));
          this.json(res, 200, { session: forkedSession });
          return (true);
        }

        if (routeAction === "effort") {
          const chosenEffort = actionPayload["reasoningEffort"];
          if (!isReasoningEffort(chosenEffort)) {
            const effortErr = "Unknown reasoningEffort.";
            throw new HttpError(400, effortErr);
          }
          await activeManager.setReasoningEffort(targetSessionId, chosenEffort);
          this.effortApplied.set(targetSessionId, chosenEffort);
          this.json(res, 200, { ok: true as const });
          return (true);
        }

        if (routeAction === "goal") {
          const targetGoalAction = actionPayload["action"];
          if (!isGoalAction(targetGoalAction)) {
            const goalErr = "Unknown goal action.";
            throw new HttpError(400, goalErr);
          }
          const goalObjective = str(actionPayload["objective"])?.trim();
          if ((targetGoalAction === "set" || targetGoalAction === "edit") && !goalObjective) {
            const objErr = "An objective is required.";
            throw new HttpError(400, objErr);
          }
          this.wake(targetSessionId);
          const goalAck = await activeManager.goal(targetSessionId, targetGoalAction, goalObjective);
          this.store.updateSession(targetSessionId, { activityAt: nowIso() });
          this.json(res, 200, { turnId: goalAck.turnId });
          return (true);
        }

        if (routeAction === "subagent") {
          const targetSubagentAction = actionPayload["action"];
          const targetSubagentId = str(actionPayload["subagentId"]);
          if (!isSubagentAction(targetSubagentAction) || !targetSubagentId) {
            const subagentErr = "A known subagent action and a subagentId are required.";
            throw new HttpError(400, subagentErr);
          }
          const messageText = str(actionPayload["body"])?.trim();
          if (
            (targetSubagentAction === "sendMessage" || targetSubagentAction === "followupTask") &&
            !messageText
          ) {
            const msgErr = "A message is required.";
            throw new HttpError(400, msgErr);
          }
          await activeManager.subagent(targetSessionId, targetSubagentAction, targetSubagentId, {
            reason: str(actionPayload["reason"]) ?? undefined,
            body: messageText,
          });
          this.json(res, 200, { ok: true as const });
          return (true);
        }

        if (routeAction === "tasks") {
          const taskOp = actionPayload["action"];
          const targetTaskId = str(actionPayload["taskId"]);
          if (taskOp === "stopAll") {
            await activeManager.stopAllTasks(targetSessionId);
          } else if ((taskOp === "background" || taskOp === "stop") && targetTaskId) {
            await (taskOp === "background"
              ? activeManager.backgroundTask(targetSessionId, targetTaskId)
              : activeManager.stopTask(targetSessionId, targetTaskId));
          } else {
            const taskErr = "Use background or stop with a taskId, or stopAll.";
            throw new HttpError(400, taskErr);
          }
          this.json(res, 200, { ok: true as const });
          return (true);
        }

        if (routeAction === "workflow") {
          const workflowOp = actionPayload["action"];
          const targetWorkflowRunId = str(actionPayload["workflowRunId"]);
          if (!targetWorkflowRunId) {
            const missingRunId = "workflowRunId is required.";
            throw new HttpError(400, missingRunId);
          }
          if (workflowOp === "cancel") {
            await activeManager.cancelWorkflow(targetSessionId, targetWorkflowRunId);
          } else if (isWorkflowChildAction(workflowOp)) {
            const targetChildId = str(actionPayload["childId"]);
            const currentAttempt = actionPayload["attempt"];
            if (
              !targetChildId ||
              typeof currentAttempt !== "number" ||
              !Number.isInteger(currentAttempt) ||
              currentAttempt < 1
            ) {
              const childErr = "childId and the child's current attempt are required.";
              throw new HttpError(400, childErr);
            }
            await activeManager.controlWorkflowChild(
              targetSessionId,
              targetWorkflowRunId,
              targetChildId,
              currentAttempt,
              workflowOp,
            );
          } else {
            const invalidOp = "Use cancel, skip or retry.";
            throw new HttpError(400, invalidOp);
          }
          this.json(res, 200, { ok: true as const });
          return (true);
        }

        const requestedApprovalMode = actionPayload["mode"];
        if (!isApprovalMode(requestedApprovalMode)) {
          const invalidModeErr = "Unknown mode.";
          throw new HttpError(400, invalidModeErr);
        }
        await activeManager.setSessionApprovalMode(targetSessionId, requestedApprovalMode);
        this.json(res, 200, { ok: true as const });
        return (true);
      }
    }

    if (path === "/api/plan-usage" && method === "GET") {
      const planUsageData = await this.readPlanUsage();
      this.json(res, 200, planUsageData);
      return (true);
    }

    if (path === "/api/title-settings" && method === "GET") {
      const activeTitleSettings = this.store.getTitleSettings();
      this.json(res, 200, activeTitleSettings);
      return (true);
    }

    if (isConnectorPath(path)) {
      const { registry, audit } = this.connectorsFor();
      this.sendAssistant(res, await handleConnectors({ registry, audit, assistant: () => this.assistantFor(true), project: () => this.store.listProjects()[0]?.cwd ?? null }, { method, path, query: url.searchParams, body: () => this.readBody(req) }));
      return true;
    }
    if (isAssistantPath(path)) {
      let parsedBody: Record<string, unknown> | null = null;
      const reply = await handleAssistant(this.assistantAccess, {
        method,
        path,
        query: url.searchParams,
        body: async () => {
          parsedBody = await this.readBody(req);
          return parsedBody;
        },
      });
      if (reply) {
        if (
          method === "PATCH" &&
          path === "/api/assistant/profile" &&
          reply.status >= 200 &&
          reply.status < 300 &&
          parsedBody !== null &&
          "model" in parsedBody
        ) {
          this.syncVoiceToAssistantModel();
        }
        this.sendAssistant(res, reply);
        return true;
      }
    }
    if (isBrowserPath(path)) {
      this.sendAssistant(res, await handleBrowser(this.browserFor(), { method, path, query: url.searchParams, body: () => this.readBody(req) }));
      return true;
    }
    if (isVoicePath(path)) {
      this.sendAssistant(res, await handleVoice(this.voiceFor(), { method, path, query: url.searchParams, body: () => this.readBody(req) }));
      return true;
    }
    if (path === "/api/research" || path.startsWith("/api/research/") || path === "/api/research-settings") {
      if (await this.routeResearch(method, path, url, req, res)) {
        return true;
      }
    }

    if (path === "/api/title-settings" && method === "PATCH") {
      const patchData = await this.readBody(req);
      const titlePatch: { enabled?: boolean; modelId?: string | null } = {};
      if ("enabled" in patchData) {
        if (typeof patchData["enabled"] !== "boolean") {
          const boolErr = "enabled must be a boolean.";
          throw new HttpError(400, boolErr);
        }
        titlePatch.enabled = patchData["enabled"];
      }
      if ("modelId" in patchData) {
        const targetModelId = patchData["modelId"];
        if (
          targetModelId !== null &&
          (typeof targetModelId !== "string" || targetModelId.trim().length === 0 || targetModelId.length > 200)
        ) {
          const modelIdErr = "modelId must be null or a non-empty string.";
          throw new HttpError(400, modelIdErr);
        }
        titlePatch.modelId = targetModelId === null ? null : (targetModelId as string).trim();
      }
      const previouslyEnabled = this.store.getTitleSettings().enabled;
      const updatedSettings = this.store.setTitleSettings(titlePatch);
      if (!previouslyEnabled && updatedSettings.enabled) {
        for (const queuedSessionId of this.titleUpgradePending) {
          this.queueTitle(queuedSessionId);
        }
      }
      this.json(res, 200, updatedSettings);
      return (true);
    }

    if (path === "/api/sandbox-settings" && method === "GET") {
      const sandboxConfig = this.store.getSandboxSettings();
      this.json(res, 200, sandboxConfig);
      return (true);
    }

    if (path === "/api/sandbox-settings" && method === "PATCH") {
      const sandboxPatch = await this.readBody(req);
      const updateData: { disabled?: boolean } = {};
      if ("disabled" in sandboxPatch) {
        if (typeof sandboxPatch["disabled"] !== "boolean") {
          const disabledErr = "disabled must be a boolean.";
          throw new HttpError(400, disabledErr);
        }
        updateData.disabled = sandboxPatch["disabled"];
      }
      const previouslyDisabled = this.store.getSandboxSettings().disabled;
      const updatedSettings = this.store.setSandboxSettings(updateData);
      if (previouslyDisabled !== updatedSettings.disabled) {
        const restartOp = this.restartChain.then(() => this.restartHosts());
        this.restartChain = restartOp.catch(() => undefined);
      }
      this.json(res, 200, updatedSettings);
      return (true);
    }

    if (path === "/api/yolo-settings" && method === "GET") {
      const yoloConfig = this.store.getYoloSettings();
      this.json(res, 200, yoloConfig);
      return (true);
    }

    if (path === "/api/yolo-settings" && method === "PATCH") {
      const yoloPatch = await this.readBody(req);
      const updateData: { enabled?: boolean } = {};
      if ("enabled" in yoloPatch) {
        if (typeof yoloPatch["enabled"] !== "boolean") {
          const enabledErr = "enabled must be a boolean.";
          throw new HttpError(400, enabledErr);
        }
        updateData.enabled = yoloPatch["enabled"];
      }
      const previouslyEnabled = this.store.getYoloSettings().enabled;
      const updatedSettings = this.store.setYoloSettings(updateData);
      if (previouslyEnabled !== updatedSettings.enabled) {
        const restartOp = this.restartChain.then(() => this.restartHosts());
        this.restartChain = restartOp.catch(() => undefined);
      }
      this.json(res, 200, updatedSettings);
      return (true);
    }

    if (method === "POST" && path === "/api/hosts/restart") {
      const busyWarningMessage =
        "A turn, approval, research run, compaction, fork or Muse host start is still open. Let it finish or stop it, then restart Muse.";
      if (this.anythingRunning()) {
        throw new HttpError(409, busyWarningMessage);
      }
      let wasRefused = false;
      const restartOp = this.restartChain.then(async () => {
        if (this.anythingRunning()) {
          wasRefused = true;
          return;
        }
        await this.restartHosts("The Muse host restarted to read a fresh model list.");
      });
      this.restartChain = restartOp.catch(() => undefined);
      await restartOp;
      if (wasRefused) {
        throw new HttpError(409, busyWarningMessage);
      }
      this.json(res, 200, { ok: true });
      return true;
    }

    if (method === "GET" && path === "/api/providers") {
      const refresh = url.searchParams.get("refresh") === "true";
      this.json(res, 200, await this.listProvidersView(refresh));
      return true;
    }
    if (method === "POST" && path === "/api/providers/accounts") {
      const body = await this.readBody(req);
      const account = await this.createOrUpdateProviderAccount(null, body);
      this.json(res, 200, { account });
      return true;
    }
    const providerAccountMatch = /^\/api\/providers\/accounts\/([^/]+)$/.exec(path);
    if (providerAccountMatch) {
      const accountId = this.segment(providerAccountMatch[1] as string);
      if (method === "PATCH") {
        const body = await this.readBody(req);
        const account = await this.createOrUpdateProviderAccount(accountId, body);
        this.json(res, 200, { account });
        return true;
      }
      if (method === "DELETE") {
        await this.removeProviderAccount(accountId);
        this.json(res, 200, { ok: true });
        return true;
      }
    }
    const providerLoginCodeMatch = /^\/api\/providers\/([^/]+)\/login\/code$/.exec(path);
    if (providerLoginCodeMatch && method === "POST") {
      const rawProvider = this.segment(providerLoginCodeMatch[1] as string);
      if (!isProviderId(rawProvider) || rawProvider === "muse" || rawProvider === "api") {
        throw new HttpError(400, "Unsupported providerId for authorization code submission.");
      }
      const body = await this.readBody(req);
      const loginId = str(body["loginId"]);
      const rawCode = str(body["code"]);
      const accountId = str(body["accountId"]) ?? (url.searchParams.get("accountId") || null);
      if (!loginId || !rawCode) {
        throw new HttpError(400, "loginId and code are required.");
      }
      const cleanCode = rawCode.trim().replace(/[\r\n]+/g, "");
      if (!cleanCode || cleanCode.length > 2048) {
        throw new HttpError(400, "Invalid authorization code.");
      }
      const key = `provider:${rawProvider}:${accountId ?? ""}`;
      const attempt = this.loginAttempts.get(key);
      if (!attempt || attempt.loginId !== loginId || attempt.status !== "waiting") {
        throw new HttpError(409, "Sign-in session is no longer active. Start sign-in again for a fresh link.");
      }
      const child = this.loginChildren.get(key);
      if (!child?.stdin || child.stdin.destroyed) {
        throw new HttpError(409, "CLI sign-in process is not accepting input. Start sign-in again.");
      }
      attempt.message = undefined;
      const outcomePromise = new Promise<void>((resolveWait) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(waitTimer);
          resolveWait();
        };
        const waitTimer = setTimeout(finish, 8_000);
        waitTimer.unref?.();
        attempt.waiters = [...(attempt.waiters ?? []), finish];
      });
      await new Promise<void>((resolveWrite, rejectWrite) => {
        child.stdin!.write(`${cleanCode}\n`, "utf8", (err) => (err ? rejectWrite(err) : resolveWrite()));
      }).catch(() => {
        throw new HttpError(409, "Could not send authorization code to CLI sign-in process.");
      });
      await outcomePromise;
      this.json(res, 200, {
        status: attempt.status,
        ...(attempt.url !== undefined ? { url: attempt.url } : {}),
        ...(attempt.code !== undefined ? { code: attempt.code } : {}),
        ...(attempt.needsCodeInput !== undefined ? { needsCodeInput: attempt.needsCodeInput } : {}),
        ...(attempt.message ? { message: attempt.message } : {}),
      });
      return true;
    }
    const providerLoginMatch = /^\/api\/providers\/([^/]+)\/login$/.exec(path);
    if (providerLoginMatch) {
      const rawProvider = this.segment(providerLoginMatch[1] as string);
      if (!isProviderId(rawProvider)) {
        throw new HttpError(400, "Unknown providerId.");
      }
      if (rawProvider === "muse") {
        const body = method === "POST" ? await this.readBody(req) : {};
        const id = str(body["accountId"]) ?? url.searchParams.get("accountId") ?? null;
        const key = id ?? "";
        if (method === "GET" || method === "DELETE") {
          const attempt = this.loginAttempts.get(key);
          const matches = attempt && attempt.loginId === url.searchParams.get("loginId");
          if (method === "DELETE") {
            if (matches && attempt.status === "waiting") {
              attempt.status = "error";
              attempt.message = "Sign-in was cancelled. Start again for a new code.";
              this.loginChildren.get(key)?.kill();
            }
            this.json(res, 200, { ok: true });
          } else {
            this.json(res, 200, matches ? { status: attempt.status, ...(attempt.message ? { message: attempt.message } : {}) } : { status: "idle" });
          }
          return true;
        }
        if (method === "POST") {
          const generation = (this.loginStartGenerations.get(key) ?? 0) + 1;
          this.loginStartGenerations.set(key, generation);
          let profile: Profile | null = null;
          if (id !== null) {
            try { profile = await this.profiles.getProfile(id); }
            catch (error) { throw this.accountError(error); }
          }
          this.json(res, 200, await this.runLogin(key, profile, generation));
          return true;
        }
      } else {
        const accountIdParam = url.searchParams.get("accountId") || null;
        if (method === "GET" || method === "DELETE") {
          const key = `provider:${rawProvider}:${accountIdParam ?? ""}`;
          const attempt = this.loginAttempts.get(key);
          const matches = attempt && attempt.loginId === url.searchParams.get("loginId");
          if (method === "DELETE") {
            if (matches && attempt.status === "waiting") {
              attempt.status = "error";
              attempt.message = "Sign-in was cancelled.";
              this.loginChildren.get(key)?.kill();
            }
            this.json(res, 200, { ok: true });
          } else {
            this.json(
              res,
              200,
              matches
                ? {
                    status: attempt.status,
                    ...(attempt.url !== undefined ? { url: attempt.url } : {}),
                    ...(attempt.code !== undefined ? { code: attempt.code } : {}),
                    ...(attempt.needsCodeInput !== undefined ? { needsCodeInput: attempt.needsCodeInput } : {}),
                    ...(attempt.message ? { message: attempt.message } : {}),
                  }
                : { status: "idle" },
            );
          }
          return true;
        }
        if (method === "POST") {
          const body = await this.readBody(req);
          const accountId = str(body["accountId"]) ?? accountIdParam;
          const key = `provider:${rawProvider}:${accountId ?? ""}`;
          const generation = (this.loginStartGenerations.get(key) ?? 0) + 1;
          this.loginStartGenerations.set(key, generation);
          this.json(res, 200, await this.runProviderLogin(rawProvider, accountId, generation));
          return true;
        }
      }
    }

    if (path === "/api/accounts" && method === "GET") {
      const activeAccountList = await this.accountList();
      this.json(res, 200, { accounts: activeAccountList });
      return (true);
    }

    if (path === "/api/accounts" && method === "POST") {
      const accountBody = await this.readBody(req);
      const targetAccountId = str(accountBody["id"]);
      if (!targetAccountId) {
        const idErr = "id is required.";
        throw new HttpError(400, idErr);
      }
      const optionalAccountName = str(accountBody["name"]);
      const shouldSeed = accountBody["seedFromDefault"] === true;
      try {
        const createdProfile = await this.profiles.createProfile(targetAccountId, {
          ...(optionalAccountName ? { name: optionalAccountName } : {}),
          seedFromDefault: shouldSeed,
        });
        this.json(res, 200, { account: { id: createdProfile.id, name: createdProfile.name } });
      } catch (profileErr) {
        throw this.accountError(profileErr);
      }
      return (true);
    }

    const accountLoginMatch = /^\/api\/accounts\/([^/]+)\/login$/.exec(path);
    if (path === "/api/login" || accountLoginMatch) {
      const id = accountLoginMatch ? this.segment(accountLoginMatch[1] as string) : null;
      const key = id ?? "";
      if (method === "GET" || method === "DELETE") {
        const attempt = this.loginAttempts.get(key);
        const matches = attempt && attempt.loginId === url.searchParams.get("loginId");
        if (method === "DELETE") {
          // Closing an older window must not cancel a newer sign-in for the same account.
          if (matches && attempt.status === "waiting") {
            attempt.status = "error";
            attempt.message = "Sign-in was cancelled. Start again for a new code.";
            this.loginChildren.get(key)?.kill();
          }
          this.json(res, 200, { ok: true });
        } else {
          this.json(res, 200, matches ? { status: attempt.status, ...(attempt.message ? { message: attempt.message } : {}) } : { status: "idle" });
        }
        return true;
      }
      if (method === "POST") {
        const generation = (this.loginStartGenerations.get(key) ?? 0) + 1;
        this.loginStartGenerations.set(key, generation);
        let profile: Profile | null = null;
        if (id !== null) {
          try { profile = await this.profiles.getProfile(id); }
          catch (error) { throw this.accountError(error); }
        }
        this.json(res, 200, await this.runLogin(key, profile, generation));
        return true;
      }
    }

    if (path.startsWith("/api/accounts/") && method === "PATCH") {
      const targetAccountId = this.segment(path.slice("/api/accounts/".length));
      const renameBody = await this.readBody(req);
      const updatedName = str(renameBody["name"]);
      if (!updatedName) {
        const nameErr = "name is required.";
        throw new HttpError(400, nameErr);
      }
      try {
        await this.profiles.renameProfile(targetAccountId, updatedName);
      } catch (renameErr) {
        throw this.accountError(renameErr);
      }
      this.json(res, 200, { ok: true as const });
      return (true);
    }

    if (path.startsWith("/api/accounts/") && method === "DELETE") {
      const targetAccountId = this.segment(path.slice("/api/accounts/".length));
      try {
        await this.profiles.removeProfile(targetAccountId);
        this.store.clearDefaultAccount(targetAccountId);
        this.removedQuotaAccounts.add(targetAccountId);
        this.quotaAccountGenerations.set(
          targetAccountId,
          (this.quotaAccountGenerations.get(targetAccountId) ?? 0) + 1,
        );
        this.planUsageReadRevision += 1;
        this.forgetQuota(targetAccountId);
      } catch (removeErr) {
        throw this.accountError(removeErr);
      }
      this.json(res, 200, { ok: true as const });
      return (true);
    }

    if (path === "/api/accounts/health" && method === "GET") {
      const diagnosticFindings = await this.profiles.doctor();
      const hasInheritedMetaKey =
        diagnosticFindings.some((finding) => finding.code === "meta_api_key_inherited") ||
        ((await this.museRuntime()) === "wsl" && Boolean(this.options.wslEnv?.["META_API_KEY"]));
      const defaultLogin = await this.defaultLoginIdentity();
      this.json(res, 200, {
        metaApiKeyInherited: hasInheritedMetaKey,
        defaultLogin,
      });
      return (true);
    }

    if (path === "/api/projects/default-account" && method === "PATCH") {
      const defaultAccountBody = await this.readBody(req);
      const projectCwd = str(defaultAccountBody["cwd"]);
      if (!projectCwd) {
        const cwdErr = "cwd is required.";
        throw new HttpError(400, cwdErr);
      }
      const rawAccount = defaultAccountBody["accountId"];
      if (rawAccount !== undefined && rawAccount !== null && typeof rawAccount !== "string") {
        const accErr = "accountId must be a string or null.";
        throw new HttpError(400, accErr);
      }
      const rawProvider = defaultAccountBody["providerId"];
      if (rawProvider !== undefined && rawProvider !== null && !isProviderId(rawProvider)) {
        const provErr = "Unknown providerId.";
        throw new HttpError(400, provErr);
      }
      const normalizedPath = normalizeCwd(projectCwd);
      const parsedAccountId = typeof rawAccount === "string" && rawAccount.length > 0 ? rawAccount : null;
      this.store.upsertProject(normalizedPath);
      if (rawProvider !== undefined && rawProvider !== null) {
        if (rawProvider !== "muse" && parsedAccountId !== null && !this.store.getProviderAccount(parsedAccountId)) {
          throw new HttpError(400, `Unknown provider account "${parsedAccountId}".`);
        }
        this.store.setDefaultProvider(
          normalizedPath,
          rawProvider,
          rawAccount === undefined ? undefined : parsedAccountId,
        );
      } else {
        this.store.setDefaultAccount(normalizedPath, parsedAccountId);
      }
      const refreshedProject = this.store.getProject(normalizedPath);
      this.json(res, 200, {
        defaultProviderId: refreshedProject?.defaultProviderId ?? "muse",
        defaultAccountId: refreshedProject?.defaultAccountId ?? parsedAccountId,
      });
      return (true);
    }

    if (path === "/api/usage" && method === "GET") {
      const parsedDays = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
      const validDays = Number.isFinite(parsedDays) ? Math.min(365, Math.max(1, parsedDays)) : 30;
      const reportData = this.usageReport(validDays, url.searchParams.get("tz"));
      this.json(res, 200, reportData);
      return (true);
    }

    const attachmentUrlMatch = path.match(/^\/api\/attachments\/([A-Za-z0-9-]{1,64})$/);
    if (attachmentUrlMatch && method === "GET") {
      const attachmentIdentifier = attachmentUrlMatch[1] as string;
      const storedAttachment = this.store.readAttachment(attachmentIdentifier);
      if (!storedAttachment) {
        const noAttachmentErr = "No such attachment.";
        throw new HttpError(404, noAttachmentErr);
      }
      res.writeHead(200, attachmentHeaders(storedAttachment.record, storedAttachment.bytes.length));
      res.end(Buffer.from(storedAttachment.bytes));
      return (true);
    }

    if (path === "/api/turns" && method === "POST") {
      const turnRequestBody = await this.readBody(req);
      const targetSessionId = str(turnRequestBody["sessionId"]);
      const messageText = str(turnRequestBody["text"]) ?? "";
      const rawAttachmentList = Array.isArray(turnRequestBody["attachments"])
        ? turnRequestBody["attachments"]
        : [];

      if (!targetSessionId || (!messageText && rawAttachmentList.length === 0)) {
        const requiredParamsErr = "sessionId and either text or an attachment are required.";
        throw new HttpError(400, requiredParamsErr);
      }

      const busyPolicy = turnRequestBody["ifBusy"];
      if (busyPolicy !== undefined && busyPolicy !== null && !isIfBusy(busyPolicy)) {
        const unknownBusyErr = "Unknown ifBusy.";
        throw new HttpError(400, unknownBusyErr);
      }

      const effortSetting = turnRequestBody["reasoningEffort"];
      if (effortSetting !== undefined && effortSetting !== null && !isReasoningEffort(effortSetting)) {
        const unknownEffortErr = "Unknown reasoningEffort.";
        throw new HttpError(400, unknownEffortErr);
      }

      const hostSessionHandle = await this.hostForSession(targetSessionId);
      const sessionManagerInstance = hostSessionHandle.manager;

      if (typeof effortSetting === "string") {
        await this.applyEffort(sessionManagerInstance, targetSessionId, effortSetting);
      }

      const sessionWorkspaceCwd = this.store.findSession(targetSessionId)?.cwd ?? "";
      const attachmentPayload = await this.prepareAttachments(
        targetSessionId,
        sessionWorkspaceCwd,
        rawAttachmentList,
      );

      const typedDisplayText = str(turnRequestBody["displayText"]) ?? messageText;
      const assistantService = typedDisplayText ? this.assistantFor(false) : null;
      const turnMemoryData = assistantService
        ? await assistantService.prepareTurnAsync({
            sessionId: targetSessionId,
            text: typedDisplayText,
            ...this.assistantScope(targetSessionId),
          })
        : null;

      const finalPromptText = turnMemoryData?.prefix
        ? `${turnMemoryData.prefix}\n\n${attachmentPayload.prompt(messageText)}`
        : attachmentPayload.prompt(messageText);

      this.wake(targetSessionId);
      const liveSessionState = this.liveFor(targetSessionId);
      const dispatchActivityRevision = ++liveSessionState.activityRevision;

      const turnAck = await sessionManagerInstance.sendTurn(targetSessionId, finalPromptText, {
        displayText: str(turnRequestBody["displayText"]) ?? (turnMemoryData?.prefix ? messageText : undefined),
        ifBusy: typeof busyPolicy === "string" ? busyPolicy : undefined,
        reasoningEffort: typeof effortSetting === "string" ? effortSetting : undefined,
        images: attachmentPayload.images,
      });

      attachmentPayload.accepted();
      const savedAttachmentViews: Record<string, unknown>[] = [];
      this.afterTurnAccepted(targetSessionId, hostSessionHandle, turnAck, liveSessionState, dispatchActivityRevision);

      attachmentPayload.files.forEach((attachmentFile, indexOrder) => {
        try {
          const savedRow = this.store.addAttachment({
            id: randomUUID(),
            sessionId: targetSessionId,
            turnId: turnAck.turnId,
            ord: indexOrder,
            name: attachmentFile.name,
            mediaType: attachmentFile.mediaType,
            kind: attachmentFile.kind,
            width: attachmentFile.width,
            height: attachmentFile.height,
            bytes: attachmentFile.bytes,
          });
          savedAttachmentViews.push(this.attachmentView(savedRow));
        } catch (attachErr) {
          this.log(
            `turn ${turnAck.turnId ?? "?"} of ${targetSessionId} was accepted, but ${attachmentFile.name} could not be kept with it: ${errorInfo(attachErr).message}`,
          );
        }
      });

      try {
        this.store.updateSession(targetSessionId, { activityAt: nowIso() });
      } catch (updateErr) {
        this.log(
          `turn ${turnAck.turnId ?? "?"} of ${targetSessionId} was accepted, but the thread's activity could not be saved: ${errorInfo(updateErr).message}`,
        );
      }

      this.json(res, 200, {
        turnId: turnAck.turnId,
        status: turnAck.status,
        disposition: turnAck.disposition,
        attachments: savedAttachmentViews,
      });
      return (true);
    }

    const turnActionMatch = path.match(/^\/api\/turns\/(steer|interrupt|cancel|unqueue)$/);
    if (turnActionMatch && method === "POST") {
      const requestedAction = turnActionMatch[1] as string;
      const turnActionBody = await this.readBody(req);
      const targetSessionId = str(turnActionBody["sessionId"]);
      const targetTurnId = str(turnActionBody["turnId"]);
      if (!targetSessionId) {
        const missingSessionErr = "sessionId is required.";
        throw new HttpError(400, missingSessionErr);
      }
      const sessionManagerInstance = await this.managerForSession(targetSessionId);

      if (requestedAction === "steer") {
        const steerPromptText = str(turnActionBody["text"]);
        if (!targetTurnId || !steerPromptText) {
          const steerErr = "turnId and text are required to steer.";
          throw new HttpError(400, steerErr);
        }
        await sessionManagerInstance.steerTurn(targetSessionId, targetTurnId, steerPromptText);
        this.assistantFor(false)?.noteMessage({
          sessionId: targetSessionId,
          text: steerPromptText,
          ...this.assistantScope(targetSessionId),
        });
      } else if (requestedAction === "interrupt") {
        await sessionManagerInstance.interruptTurn(
          targetSessionId,
          targetTurnId ?? undefined,
          turnActionBody["retract"] === true,
        );
      } else if (requestedAction === "cancel") {
        if (!targetTurnId) {
          const cancelTurnErr = "turnId is required.";
          throw new HttpError(400, cancelTurnErr);
        }
        await sessionManagerInstance.cancelTurn(targetSessionId, targetTurnId);
      } else {
        if (!targetTurnId) {
          const unqueueTurnErr = "turnId is required.";
          throw new HttpError(400, unqueueTurnErr);
        }
        await sessionManagerInstance.unqueueTurn(targetSessionId, targetTurnId);
      }
      this.json(res, 200, { ok: true as const });
      return (true);
    }

    if (path === "/api/approvals/decide" && method === "POST") {
      const approvalDecisionBody = await this.readBody(req);
      const targetSessionId = str(approvalDecisionBody["sessionId"]);
      const targetApprovalId = str(approvalDecisionBody["approvalId"]);
      const targetChoiceId = str(approvalDecisionBody["choiceId"]);
      if (!targetSessionId || !targetApprovalId || !targetChoiceId || !("requirementId" in approvalDecisionBody)) {
        const missingApprovalFields = "sessionId, approvalId, requirementId and choiceId are required.";
        throw new HttpError(400, missingApprovalFields);
      }
      const sessionManagerInstance = await this.managerForSession(targetSessionId);
      await sessionManagerInstance.decideApproval({
        sessionId: targetSessionId,
        approvalId: targetApprovalId,
        requirementId: approvalDecisionBody["requirementId"],
        choiceId: targetChoiceId,
        feedback: str(approvalDecisionBody["feedback"]),
      });
      this.json(res, 200, { ok: true as const });
      return (true);
    }

    if (path === "/api/models" && method === "GET") {
      const targetSessionParam = url.searchParams.get("sessionId") ?? undefined;
      const accountId = url.searchParams.get("accountId") || null;
      const providerParam = url.searchParams.get("providerId");
      const refresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
      if (providerParam !== null && providerParam !== "" && !isProviderId(providerParam)) {
        const unknownProvErr = "Unknown providerId.";
        throw new HttpError(400, unknownProvErr);
      }
      const providerId: ProviderId = providerParam ? providerParam : "muse";
      if (targetSessionParam) {
        const host = await this.hostForSession(targetSessionParam);
        const listed = await this.listHostModels(host, targetSessionParam);
        if (refresh && asRecord(listed)?.["source"] === "bundledCatalog") {
          const sess = this.store.findSession(targetSessionParam)?.session;
          const sessProvider = this.normalizeProviderId(sess?.providerId);
          const sessAccount = sess?.accountId ?? null;
          try {
            const fresh = await this.oneShotListModels(sessProvider, sessAccount);
            const freshRec = asRecord(fresh.models);
            const freshList = Array.isArray(freshRec?.["models"]) ? freshRec["models"] : null;
            if (freshRec?.["source"] !== "bundledCatalog" || (freshList && freshList.length > 0)) {
              this.json(res, 200, fresh);
              return (true);
            }
          } catch {
            // Keep the session host's response if spawning a fresh probe host fails.
          }
        }
        this.json(res, 200, { models: listed, hostVersion: host.serverVersion });
        return (true);
      }
      const catalogReply = await this.resolveLiveModelCatalog(providerId, accountId, refresh);
      this.json(res, 200, catalogReply);
      return (true);
    }

    const inputControlMatch = path.match(/^\/api\/user-input\/(answer|cancel|clarify)$/);
    if (inputControlMatch && method === "POST") {
      const requestedAction = inputControlMatch[1] as string;
      const inputRequestBody = await this.readBody(req);
      const targetSessionId = str(inputRequestBody["sessionId"]);
      const targetUserInputId = str(inputRequestBody["userInputId"]);
      if (!targetSessionId || !targetUserInputId) {
        const missingInputIds = "sessionId and userInputId are required.";
        throw new HttpError(400, missingInputIds);
      }
      const sessionManagerInstance = await this.managerForSession(targetSessionId);

      if (requestedAction === "answer") {
        const userProvidedAnswers = inputRequestBody["answers"];
        if (!Array.isArray(userProvidedAnswers)) {
          const answersRequired = "answers are required.";
          throw new HttpError(400, answersRequired);
        }
        await sessionManagerInstance.answerUserInput(targetSessionId, targetUserInputId, userProvidedAnswers as never);
      } else if (requestedAction === "cancel") {
        await sessionManagerInstance.cancelUserInput(
          targetSessionId,
          targetUserInputId,
          str(inputRequestBody["reason"]) ?? undefined,
        );
      } else {
        const clarificationContent = str(inputRequestBody["content"]);
        if (!clarificationContent) {
          const contentRequired = "content is required.";
          throw new HttpError(400, contentRequired);
        }
        await sessionManagerInstance.clarifyUserInput(targetSessionId, targetUserInputId, clarificationContent);
      }
      this.json(res, 200, { ok: true as const });
      return (true);
    }

    if (path === "/api/open" && method === "POST") {
      const openRequestBody = await this.readBody(req);
      const projectCwd = str(openRequestBody["cwd"]);
      if (!projectCwd || !this.store.getProject(projectCwd)) {
        const unknownProjectErr = "Unknown project folder.";
        throw new HttpError(404, unknownProjectErr);
      }
      const openTargetKind: OpenTarget = openRequestBody["target"] === "editor" ? "editor" : "files";
      const localProjectRoot = await this.localRootFor(projectCwd);
      const relativeFilePath = str(openRequestBody["path"]);
      if (relativeFilePath) {
        const { abs: resolvedAbsoluteFilePath } = await resolveInRoot(localProjectRoot, relativeFilePath, projectCwd);
        await this.opener(resolvedAbsoluteFilePath, "files");
      } else {
        await this.opener(localProjectRoot, openTargetKind);
      }
      this.json(res, 200, { ok: true as const });
      return (true);
    }
    return (false);
  }
  private async museStorageOptions(accountId: string | null): Promise<MuseStorageOptions> {
    let profileEnv: Record<string, string> = {};
    if (accountId) {
      try { profileEnv = this.profiles.envFor(await this.profiles.getProfile(accountId)); }
      catch (error) { throw this.accountError(error); }
    }
    return {
      // Simulated platforms in consumers/tests cannot perform Linux inode checks on another OS.
      platform: process.platform === "linux" ? this.options.platform : process.platform,
      home: this.options.home,
      env: { ...process.env, HOME: this.options.home, ...profileEnv },
    };
  }

  private async ensureLinuxMuseStorage(accountId: string | null): Promise<void> {
    if (this.options.platform !== "linux" || process.platform !== "linux") return;
    const diagnosis = await ensureMuseStorage(await this.museStorageOptions(accountId));
    if (diagnosis.repaired) this.log(`Prepared Muse storage permissions for ${accountId ? `account ${accountId}` : "the default login"}.`);
  }

  private async linuxSetup(accountId: string | null, repaired?: MuseStorageDiagnosis): Promise<Record<string, unknown>> {
    const supported = this.options.platform === "linux";
    const diagnosis = repaired ?? await inspectMuseStorage(await this.museStorageOptions(accountId));
    const snapshot = this.linuxInstaller.snapshot();
    const environment = await this.environment(snapshot.status === "installed" && !this.envCache?.value.museFound);
    const installation = snapshot.status === "idle" && environment.museFound
      ? { ...snapshot, status: "installed", phase: "complete", message: "Muse Code is already installed. Ancilla uses your existing installation." }
      : snapshot;
    return {
      supported,
      installation,
      museFound: environment.museFound,
      storage: {
        status: diagnosis.status === "not-applicable" ? "ready"
          : diagnosis.issues.some((issue) => issue.code === "missing-root") ? "missing" : diagnosis.status,
        path: diagnosis.root ?? "",
        message: diagnosis.issues.length > 0 ? diagnosis.issues.map((issue) => issue.message).join(" ")
          : diagnosis.repaired ? "Muse storage is ready. Your login and thread history were preserved."
          : "Muse storage is ready for your threads.",
      },
    };
  }

  private async environment(forceRefresh: boolean): Promise<EnvView> {
    if (!forceRefresh && this.envCache !== null && Date.now() - this.envCache.at < ENV_CACHE_MS) {
      return (this.envCache.value);
    }
    const envRuntimeHint = this.runtimeHint();
    const configuredPath = this.options.musePath ?? null;
    const wslProcessEnv = this.wslEnvFor();
    const probeOutcome = await probeEnvironment(this.options.exec, this.options.platform, {
      preference: envRuntimeHint === "native" || envRuntimeHint === "wsl" ? envRuntimeHint : this.options.runtime,
      ...(this.options.findNativeMuse ? { findNative: this.options.findNativeMuse } : {}),
      ...(this.options.distro ? { distro: this.options.distro } : {}),
      musePath: configuredPath,
      ...(wslProcessEnv ? { env: wslProcessEnv } : {}),
    });

    if (!envRuntimeHint) {
      this.runtimeKnown = probeOutcome.runtime;
    }
    if (probeOutcome.museDistro) {
      this.distroKnown = probeOutcome.museDistro;
    }
    if (probeOutcome.runtime === "native" && probeOutcome.native && !this.options.findNativeMuse) {
      refreshNativeMuse(probeOutcome.native);
    }

    let detectedMusePath = probeOutcome.musePath;
    if (
      configuredPath &&
      (probeOutcome.runtime === "native" ? isWindowsAbs(configuredPath) : probeOutcome.runtime === "posix" && configuredPath.includes("/"))
    ) {
      detectedMusePath = existsSync(configuredPath) ? configuredPath : null;
    }

    // A GUI launch does not source shell profiles, and an in-app install must work without restarting it.
    if (!detectedMusePath && this.options.platform === "linux" && (!configuredPath || configuredPath === "muse")) {
      const managedBinPath = join(this.options.home, ".local", "bin", "muse");
      try {
        await access(managedBinPath, constants.X_OK);
        if ((await stat(managedBinPath)).isFile()) {
          detectedMusePath = managedBinPath;
        }
      } catch {}
    }
    if (detectedMusePath && this.options.platform === "linux") {
      const testExecResult = await this.options.exec(detectedMusePath, ["--version"], {
        timeoutMs: 5000,
        env: { ...process.env, HOME: this.options.home, MUSE_NO_AUTO_UPDATE: "1", MUSE_LOGIN: "0" },
      });
      if (testExecResult.exitCode !== 0 || testExecResult.timedOut || !testExecResult.stdout.trim()) {
        detectedMusePath = null;
      }
    }

    const computedEnvView: EnvView = {
      platform: probeOutcome.platform,
      runtime: probeOutcome.runtime,
      wslAvailable: probeOutcome.wslAvailable,
      defaultDistro:
        probeOutcome.runtime === "wsl"
          ? (probeOutcome.museDistro ?? probeOutcome.defaultDistro)
          : probeOutcome.defaultDistro,
      museFound: detectedMusePath !== null,
      musePath: detectedMusePath,
      version: ANCILLA_VERSION,
      persistent: this.options.dataDir !== ":memory:",
    };
    this.envCache = { at: Date.now(), value: computedEnvView };
    return computedEnvView;
  }

  private serveEvents(outgoingRes: ServerResponse): void {
    outgoingRes.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    this.sse.add(outgoingRes, `event: ancilla\ndata: ${JSON.stringify({ type: "hello", version: ANCILLA_VERSION })}\n\n`);
  }

  private async serveStatic(requestedUrlPath: string, outgoingRes: ServerResponse): Promise<boolean> {
    const baseStaticDir = this.options.staticDir;
    if (!baseStaticDir) {
      return (false);
    }
    const subpath = requestedUrlPath === "/" ? "/index.html" : requestedUrlPath;
    const normalizedFullPath = normalize(join(baseStaticDir, subpath));
    if (!normalizedFullPath.startsWith(baseStaticDir + sep) && normalizedFullPath !== baseStaticDir) {
      return (false);
    }
    try {
      const targetStat = await stat(normalizedFullPath);
      const actualFilePath = targetStat.isDirectory() ? join(normalizedFullPath, "index.html") : normalizedFullPath;
      const fileBytes = await readFile(actualFilePath);
      const isImmutableAsset = actualFilePath.includes(`${sep}assets${sep}`);
      outgoingRes.writeHead(200, {
        "content-type": MIME[extname(actualFilePath)] ?? "application/octet-stream",
        "cache-control": isImmutableAsset ? "public, max-age=31536000, immutable" : "no-cache",
        ...FRAME_HEADERS,
      });
      outgoingRes.end(fileBytes);
      return (true);
    } catch {
      return (false);
    }
  }

  private liveFor(sessionIdentifier: string): LiveState {
    let liveSessionState = this.live.get(sessionIdentifier);
    if (!liveSessionState) {
      liveSessionState = {
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
      this.live.set(sessionIdentifier, liveSessionState);
    }
    return liveSessionState;
  }

  private liveView(sessionIdentifier: string): LiveView | null {
    const liveSessionState = this.live.get(sessionIdentifier);
    if (!liveSessionState) {
      return (null);
    }
    const view: LiveView = {
      activeTurnId: liveSessionState.activeTurnId,
      turnStartedAt: liveSessionState.turnStartedAt,
      pendingApprovals: liveSessionState.pendingApprovals.size,
      pendingInputs: liveSessionState.pendingInputs.size,
      lastTerminal: liveSessionState.lastTerminal,
      lastError: liveSessionState.lastError,
      goal: liveSessionState.goal,
      viewHealth: liveSessionState.viewHealth,
    };
    return (view);
  }

  private emitStatus(sessionIdentifier: string): void {
    this.emit("ancilla", {
      type: "session-status",
      sessionId: sessionIdentifier,
      live: this.liveView(sessionIdentifier),
    });
  }

  private summary(sessionRow: SessionRecord, workspaceCwd: string): Record<string, unknown> {
    const normalizedProvider = this.normalizeProviderId(sessionRow.providerId);
    const summaryData: Record<string, unknown> = {
      sessionId: sessionRow.id,
      cwd: workspaceCwd,
      title: sessionRow.title,
      titleSource: sessionRow.titleSource,
      turnCount: sessionRow.turnCount,
      modelId: sessionRow.modelId,
      origin: sessionRow.origin,
      archived: sessionRow.archived,
      createdAt: sessionRow.createdAt,
      activityAt: sessionRow.activityAt,
      settled: sessionRow.settledOverride === "settled",
      settledAt: sessionRow.settledAt,
      unsettledAt: sessionRow.unsettledAt,
      sandboxDisabled: sessionRow.sandboxDisabled,
      providerId: normalizedProvider,
      capabilities: capabilitiesForProvider(normalizedProvider),
      accountId: sessionRow.accountId,
      live: this.liveView(sessionRow.id),
    };
    return (summaryData);
  }

  private isBusy(sessionIdentifier: string): boolean {
    const liveSession = this.live.get(sessionIdentifier);
    return Boolean(
      liveSession &&
        (liveSession.activeTurnId ||
          liveSession.pendingApprovals.size > 0 ||
          liveSession.pendingInputs.size > 0),
    );
  }

  /**
   * Whether a research run of this thread is in flight in this process, by the job map. Not `isBusy`, which is about
   * the thread's own turn and also decides whether a refresh may load an unloaded thread, and not a row that says
   * `running`, which a stale one does for good.
   */
  private hasLiveResearch(sessionId: string): boolean {
    return this.researchJobs.hasLiveRun(sessionId);
  }

  /**
   * Whether closing the hosts now would cut something off: a thread with a turn, approval or question open, a
   * research run in flight, a host still starting (for a thread about to be created on it, or only to read a model
   * list) or a compaction or fork that holds one.
   */
  private anythingRunning(): boolean {
    return (
      [...this.live.keys()].some((sessionId) => this.isBusy(sessionId)) ||
      this.store.listRunningResearchRuns().some((run) => this.researchJobs.isActive(run.id)) ||
      this.starting.size > 0 ||
      this.hostWork > 0
    );
  }

  /** Runs `work` while counting it in `anythingRunning`: a compaction or fork shows no turn, yet closing its host ends it. */
  private async holdingHost<T>(work: () => Promise<T>): Promise<T> {
    this.hostWork += 1;
    try {
      return await work();
    } finally {
      this.hostWork -= 1;
    }
  }


  private wake(sessionIdentifier: string): void {
    const sessionRecord = this.store.getSession(sessionIdentifier);
    if (!sessionRecord || sessionRecord.settledOverride === null) {
      return;
    }
    this.store.updateSession(sessionIdentifier, {
      settledOverride: null,
      settledAt: null,
      unsettledAt: sessionRecord.settledOverride === "settled" ? nowIso() : sessionRecord.unsettledAt,
    });
    this.notifySessionsChange();
  }

  private autoSettle(): void {
    const thresholdDays = this.options.autoSettleDays;
    if (thresholdDays === null || this.closed) {
      return;
    }
    const settleCutoffIso = new Date(Date.now() - thresholdDays * 86_400_000).toISOString();
    let didChange = false;
    for (const candidateRecord of this.store.listSettleCandidates(settleCutoffIso)) {
      if (this.isBusy(candidateRecord.id) || this.hasLiveResearch(candidateRecord.id)) {
        continue;
      }
      this.store.updateSession(candidateRecord.id, {
        settledOverride: "settled",
        settledAt: candidateRecord.activityAt,
        unsettledAt: null,
      });
      didChange = true;
    }
    if (didChange) {
      this.notifySessionsChange();
    }
  }

  private runtimeHint(): MuseRuntime | null {
    const currentPlatform = this.options.platform;
    if (currentPlatform !== "win32") {
      return ("posix");
    }
    const configuredRuntime = this.options.runtime;
    if (configuredRuntime === "native" || configuredRuntime === "wsl") {
      return (configuredRuntime);
    }
    const configuredPath = this.options.musePath;
    if (configuredPath && isWindowsAbs(configuredPath)) {
      return ("native");
    }
    if (configuredPath?.startsWith("/")) {
      return ("wsl");
    }
    return (null);
  }

  private async museRuntime(): Promise<MuseRuntime> {
    let determinedRuntime = this.runtimeHint();
    if (!determinedRuntime) {
      if (this.runtimeKnown === null || this.runtimeKnown === undefined) {
        await this.environment(Boolean(false));
      }
      determinedRuntime = this.runtimeKnown ?? "wsl";
    }
    if (determinedRuntime === "wsl" && !this.options.distro && !this.distroKnown) {
      await this.environment(Boolean(false));
    }
    return (determinedRuntime);
  }

  private wslDistro(): string {
    const configuredDistro = this.options.distro ?? this.distroKnown ?? FALLBACK_DISTRO;
    return (configuredDistro);
  }

  private wslEnvFor(
    envOverlay: Record<string, string> | null = null,
    forwardEnvVars: string[] = [],
  ): Record<string, string> | undefined {
    const filteredBaseEnv = this.wslEnvWithout(envOverlay);
    if (Object.keys(filteredBaseEnv).length === 0 && !envOverlay && forwardEnvVars.length === 0) {
      return (undefined);
    }
    return wslSpawnEnv({ ...process.env, ...(envOverlay ?? {}) }, filteredBaseEnv, forwardEnvVars);
  }

  private wslEnvWithout(
    envOverlay: Record<string, string | undefined> | null | undefined,
  ): Record<string, string> {
    const uppercaseOverlayKeys = new Set(Object.keys(envOverlay ?? {}).map((key) => key.toUpperCase()));
    return Object.fromEntries(
      Object.entries(this.options.wslEnv).filter(([envKey]) => !uppercaseOverlayKeys.has(envKey.toUpperCase())),
    );
  }

  private runPlanned(plannedCommand: { command: string; args: string[] }, targetRuntime: MuseRuntime) {
    const executionEnv =
      this.options.platform === "win32" && targetRuntime === "wsl" ? this.wslEnvFor() : undefined;
    return executionEnv
      ? this.options.exec(plannedCommand.command, plannedCommand.args, { env: executionEnv })
      : this.options.exec(plannedCommand.command, plannedCommand.args);
  }

  private spawnCwdFor(workspaceCwd: string): string {
    if (!workspaceCwd) {
      const activeProcessCwd = process.cwd();
      return (activeProcessCwd);
    }
    const currentPlatform = this.options.platform;
    if (currentPlatform !== "win32") {
      return (workspaceCwd);
    }
    if (isWslAbs(workspaceCwd)) {
      try {
        return toWindowsPath(workspaceCwd);
      } catch {
        const fallbackCwd = process.cwd();
        return (fallbackCwd);
      }
    }
    return (workspaceCwd);
  }

  private hostPathFor(workspaceCwd: string): string {
    if (!workspaceCwd || this.options.platform !== "win32") {
      return (workspaceCwd);
    }
    const currentRuntime = this.runtimeHint() ?? this.runtimeKnown;
    if (currentRuntime === "native") {
      return this.spawnCwdFor(workspaceCwd);
    }
    const wslUncMatch = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i.exec(workspaceCwd);
    if (wslUncMatch) {
      const targetDistro = this.wslDistro();
      if (wslUncMatch[1]!.toLowerCase() !== targetDistro.toLowerCase()) {
        throw new HttpError(400, `This folder belongs to WSL ${wslUncMatch[1]}, but Muse is running in ${targetDistro}.`);
      }
      return "/" + (wslUncMatch[2] ?? "").replace(/\\/g, "/");
    }
    if (isWindowsAbs(workspaceCwd)) {
      try {
        return toWslPath(workspaceCwd);
      } catch {
        return workspaceCwd;
      }
    }
    return workspaceCwd;
  }

  /** One host per (provider, account, workspace, posture). Muse coding hosts keep today's exact key format so health & test fixtures stay identical. */
  private hostKey(cwd: string, accountId: string | null, providerId: ProviderId = "muse", posture: HostPosture = "coding"): string {
    if (providerId === "muse") {
      const base = `${accountId ?? "default"}::${this.hostPathFor(cwd) || "__default__"}`;
      return posture === "voice" ? `voice::${base}` : base;
    }
    const workspaceKey = providerId === "api" ? (cwd ? normalizeCwd(cwd) : "") : this.cliHostPathFor(cwd, providerId);
    return `${providerId}::${accountId ?? "default"}::${workspaceKey || "__default__"}`;
  }


  private storePathFor(remoteRootPath: string): string {
    if (this.options.platform === "win32" && isWslAbs(remoteRootPath)) {
      const matchedFolder = this.store.listFolders().find((proj) => {
        try {
          return this.hostPathFor(proj.cwd) === remoteRootPath;
        } catch {
          return false;
        }
      });
      if (matchedFolder) {
        return matchedFolder.cwd;
      }
    }
    if (this.options.platform === "win32" && isWindowsAbs(remoteRootPath)) {
      const winNormalized = win32.normalize(remoteRootPath);
      return winNormalized.charAt(0).toUpperCase() + winNormalized.slice(1);
    }
    if (this.options.platform !== "win32" || !isWslAbs(remoteRootPath)) {
      return remoteRootPath;
    }
    try {
      return toWindowsPath(remoteRootPath);
    } catch {
      return remoteRootPath;
    }
  }

  /**
   * Where a project folder is on this machine's file system: what the file viewer reads from, where research
   * reports are written, and what the OS opener is handed. A Linux path on Windows resolves through WSL to its
   * `\\wsl.localhost\` share; `localPathFor` alone only knows the `/mnt/x` drives, which is not enough for a
   * project inside a distro.
   */
  private async localRootFor(cwd: string): Promise<string> {
    try {
      return resolveUserPath(cwd, await this.pathContext(cwd)).local;
    } catch {
      return this.localPathFor(cwd);
    }
  }

  /**
   * `localRootFor` for what Ancilla writes into a project. On Windows a rooted Linux path is a path on the current
   * drive, which is never the project: when the folder could not be placed (no distro to reach it through), writing
   * would drop files on the wrong disk, so it is refused instead. A root that is not an absolute path at all would
   * land relative to the daemon's own folder, so it is refused too.
   */
  private async workspaceRootFor(cwd: string): Promise<string> {
    const root = await this.localRootFor(cwd);
    if (this.options.platform === "win32" && root.startsWith("/")) {
      throw new FileError(
        409,
        `Ancilla could not work out where ${cwd} is on this computer (it is a Linux folder and no WSL distribution is available to reach it), so it will not save into it. Start WSL and try again.`,
        "workspaceWrite",
      );
    }
    if (this.options.platform === "win32" && !win32.isAbsolute(root)) {
      throw new FileError(
        409,
        `Ancilla could not work out where ${cwd} is on this computer (it is not a full path), so it will not save into it. Open the project from its full folder path and try again.`,
        "workspaceWrite",
      );
    }
    return root;
  }


  private localPathFor(workspaceCwd: string): string {
    if (this.options.platform === "win32" && isWslAbs(workspaceCwd)) {
      try {
        return toWindowsPath(workspaceCwd);
      } catch {
        return workspaceCwd;
      }
    }
    return workspaceCwd;
  }

  private async pathContext(targetPath: string): Promise<PathContext> {
    const currentPlatform = this.options.platform ?? process.platform;
    const cleanPathValue = targetPath.trim();
    let targetDistro: string | null = this.options.distro ?? null;
    if (
      !targetDistro &&
      currentPlatform === "win32" &&
      cleanPathValue.startsWith("/") &&
      !/^\/mnt\/[A-Za-z](\/|$)/.test(cleanPathValue)
    ) {
      targetDistro = (await this.environment(false)).defaultDistro;
    }
    return { platform: currentPlatform, home: this.options.home ?? homedir(), distro: targetDistro };
  }

  private async canonicalCwd(rawInputPath: string, shouldCreate: boolean): Promise<string> {
    const context = await this.pathContext(rawInputPath);
    try {
      const resolved = shouldCreate ? await createDirectory(rawInputPath, context) : resolveUserPath(rawInputPath, context);
      const normalizedDisplay = normalizeCwd(resolved.display);
      return (normalizedDisplay);
    } catch (dirErr) {
      if (shouldCreate || !(dirErr instanceof PathError)) {
        throw dirErr;
      }
      const fallbackDisplay = normalizeCwd(rawInputPath);
      return (fallbackDisplay);
    }
  }

  private projectView(projectRecord: Project): Record<string, unknown> {
    const viewRecord: Record<string, unknown> = {
      cwd: projectRecord.cwd,
      displayName: projectRecord.displayName,
      pinned: projectRecord.pinned,
      activityAt: projectRecord.activityAt,
      defaultProviderId: projectRecord.defaultProviderId,
      defaultAccountId: projectRecord.defaultAccountId,
      folders: projectRecord.folders,
    };
    return (viewRecord);
  }

  private async addProjectFolder(workspaceCwd: string): Promise<Record<string, unknown>> {
    this.store.upsertProject(workspaceCwd);
    this.store.revealProject(workspaceCwd);
    let potentialWarning: string | null = null;
    let discoveredSessionList: Record<string, unknown>[] = [];
    try {
      discoveredSessionList = await this.discover(workspaceCwd);
    } catch (discErr) {
      potentialWarning = errorInfo(discErr).message;
    }
    this.notifySessionsChange();
    const resolvedProject = this.store.projectForFolder(workspaceCwd);
    return {
      project: resolvedProject ? this.projectView(resolvedProject) : { cwd: workspaceCwd, displayName: workspaceCwd, folders: [] },
      sessions: discoveredSessionList,
      warning: potentialWarning,
    };
  }

  private async cloneRepository(remoteRepoUrl: string, destinationPath: string): Promise<string> {
    const context = await this.pathContext(destinationPath);
    const resolvedTargetPath = resolveUserPath(destinationPath, context);
    const existingEntries = await readdir(resolvedTargetPath.local).catch(() => null);
    if (existingEntries && existingEntries.length > 0) {
      const folderInUseErr = "That folder already exists and is not empty. Pick another name.";
      throw new HttpError(409, folderInUseErr);
    }
    await mkdir((context.platform === "win32" ? win32 : posix).dirname(resolvedTargetPath.local), { recursive: true });
    if (context.platform === "win32" && resolvedTargetPath.flavor === "posix" && !resolvedTargetPath.display.startsWith("/mnt/")) {
      const spawnEnv = wslSpawnEnv({ ...process.env, GIT_TERMINAL_PROMPT: "0" }, this.options.wslEnv, ["GIT_TERMINAL_PROMPT/u"]);
      await runProcess("wsl.exe", ["-d", context.distro ?? "", "--", "git", "clone", "--", remoteRepoUrl, resolvedTargetPath.display], CLONE_TIMEOUT_MS, spawnEnv);
    } else {
      await runProcess("git", ["clone", "--", remoteRepoUrl, resolvedTargetPath.local], CLONE_TIMEOUT_MS);
    }
    return resolvedTargetPath.display;
  }

  private async cliMusePath(): Promise<string | null> {
    const targetRuntime = await this.museRuntime();
    const explicitMusePath = this.options.musePath ?? null;
    if (this.options.platform !== "win32") {
      if (explicitMusePath) {
        if (explicitMusePath === "muse" && this.options.platform === "linux") {
          const managedInstalledPath = join(this.options.home, ".local", "bin", "muse");
          try {
            await access(managedInstalledPath, constants.X_OK);
            if ((await stat(managedInstalledPath)).isFile()) return managedInstalledPath;
          } catch {}
        }
        return (explicitMusePath);
      }
      const envPosix = await this.environment(false);
      return (envPosix.musePath);
    }
    if (explicitMusePath && (explicitMusePath.includes("/") || explicitMusePath.includes("\\"))) {
      return (explicitMusePath);
    }
    const envWin = await this.environment(false);
    return (envWin.musePath);
  }

  private async listSkills(workspaceCwd: string, sessionIdentifier?: string | null): Promise<SkillListing> {
    const cliListing = await this.listCliSkills(workspaceCwd);
    const hostKey = sessionIdentifier ? this.sessionHosts.get(sessionIdentifier) : undefined;
    const managedHost = hostKey ? this.hosts.get(hostKey) : undefined;
    if (!sessionIdentifier || !managedHost) {
      return cliListing;
    }
    try {
      const liveSessionSkills = await managedHost.manager.listSessionSkills(sessionIdentifier);
      return { ...cliListing, skills: mergeSessionSkills(liveSessionSkills, cliListing.skills), error: null };
    } catch {
      return cliListing;
    }
  }

  private async listCliSkills(workspaceCwd: string): Promise<SkillListing> {
    const cacheKey = workspaceCwd || "__default__";
    const cachedSkills = this.skillCache.get(cacheKey);
    if (cachedSkills && !cachedSkills.error && Date.now() - cachedSkills.at < SKILL_CACHE_MS) {
      return cachedSkills;
    }
    const cliArgs = ["skills", "list", "--json"];
    const museExecutablePath = await this.cliMusePath();
    const hostWorkspaceRoot = this.hostPathFor(workspaceCwd);
    if (hostWorkspaceRoot) {
      cliArgs.push("--workspace", hostWorkspaceRoot);
    }
    const targetRuntime = await this.museRuntime();
    const plannedInvocation = planMuseCli({
      platform: this.options.platform,
      distro: this.wslDistro(),
      musePath: museExecutablePath,
      args: cliArgs,
      runtime: targetRuntime,
    });
    const cliResult = await this.runPlanned(plannedInvocation, targetRuntime);
    const parsedSkills = parseSkillList(cliResult.stdout);
    const resolvedListing: SkillListing = parsedSkills
      ? { at: Date.now(), ...parsedSkills, error: null }
      : {
          at: Date.now(),
          skills: [],
          paths: new Map(),
          error:
            cliResult.exitCode === 0
              ? "Muse listed its skills in a form Ancilla does not understand."
              : "Could not list Muse skills. Check that muse runs in a terminal.",
        };
    this.skillCache.set(cacheKey, resolvedListing);
    return resolvedListing;
  }

  private async skillBody(workspaceCwd: string, skillId: string): Promise<string> {
    const skillPath = (await this.listCliSkills(workspaceCwd)).paths.get(skillId);
    if (!skillPath) {
      const skillNotFoundErr = "Muse does not list that skill for this workspace.";
      throw new HttpError(404, skillNotFoundErr);
    }
    const bundledSubpath = /^bundled:\/\/(.+)$/.exec(skillPath)?.[1];
    if (bundledSubpath?.split("/").includes("..")) {
      const invalidSkillPathErr = "That skill's path is not readable.";
      throw new HttpError(400, invalidSkillPathErr);
    }
    const targetRuntime = await this.museRuntime();
    if (targetRuntime === "native") {
      const xdgDataDir = process.env["XDG_DATA_HOME"] || join(this.options.home, ".local", "share");
      const fullSkillFilePath = bundledSubpath
        ? win32.join(xdgDataDir, "muse", "skills", "bundled", ...bundledSubpath.split("/"))
        : skillPath;
      const parsedBody = stripFrontmatter(await readFile(fullSkillFilePath, "utf8").catch(() => ""));
      if (!parsedBody) {
        const readSkillErr = "Could not read that skill's instructions.";
        throw new HttpError(502, readSkillErr);
      }
      return (parsedBody);
    }
    const shellScript = bundledSubpath
      ? 'exec cat -- "${XDG_DATA_HOME:-$HOME/.local/share}/muse/skills/bundled/$1"'
      : 'exec cat -- "$1"';
    const activeDistro = this.wslDistro();
    const plannedCliCmd = planHostCommand({
      platform: this.options.platform,
      distro: activeDistro,
      program: "sh",
      args: ["-c", shellScript, "sh", bundledSubpath ?? skillPath],
    });
    const runResult = await this.runPlanned(plannedCliCmd, targetRuntime);
    const skillBodyText = runResult.exitCode === 0 ? stripFrontmatter(runResult.stdout) : "";
    if (!skillBodyText) {
      const failedReadErr = "Could not read that skill's instructions.";
      throw new HttpError(502, failedReadErr);
    }
    return (skillBodyText);
  }

  private async forkSession(sessionIdentifier: string, sessionManager: SessionManager): Promise<Record<string, unknown>> {
    const sourceSession = this.store.findSession(sessionIdentifier);
    if (!sourceSession) {
      const missingSession = "Unknown session.";
      throw new HttpError(404, missingSession);
    }
    const forkedResult = await sessionManager.forkSession(sessionIdentifier);
    const rawSessionObj = asRecord(asRecord(forkedResult.raw)?.["session"]);
    const savedRecord = this.store.recordSession({
      id: forkedResult.sessionId,
      projectId: sourceSession.session.projectId,
      origin: "ancilla",
      title: `${sourceSession.session.title} (fork)`,
      titleSource: "auto",
      modelId: rawSessionObj ? str(rawSessionObj["modelId"]) : sourceSession.session.modelId,
      turnCount: num(rawSessionObj?.["turnCount"]),
      createdAt: normalizeIso(rawSessionObj?.["createdAt"]),
      sandboxDisabled: sourceSession.session.sandboxDisabled,
      providerId: sourceSession.session.providerId,
      accountId: sourceSession.session.accountId,
    });
    const sourceHostKey = this.sessionHosts.get(sessionIdentifier);
    if (sourceHostKey) {
      this.sessionHosts.set(forkedResult.sessionId, sourceHostKey);
    }
    this.liveFor(forkedResult.sessionId);
    this.notifySessionsChange();
    return this.summary(savedRecord, sourceSession.cwd);
  }

  /**
   * The selection `session/setModel` gets for a model id: the catalog's own entry for it, provider and profile
   * included, the way a picker in Muse's client would send it. A bare id is what the UI knows; whether Muse keeps a
   * selection that names no provider across a restart is not something to rely on. The catalog is a request away,
   * so the id alone still goes out when the catalog cannot be read.
   */
  private async modelSelection(manager: SessionManager, sessionId: string, model: unknown): Promise<unknown> {
    const outcome = await this.resolveModelSelection(manager, sessionId, model);
    return (outcome.selection);
  }

  /**
   * `modelSelection`, and whether the catalog lists the id: `false` for an id it lacks, `null` when it could not be
   * read or lists nothing at all, which says nothing about the id. An id the catalog lacks goes out with the
   * provider and profile of the catalog itself, else of the session's active row: Muse 1.4.5 switches to an unlisted
   * id on the same provider, and a selection that names none is not something to rely on. `source` is where the
   * catalog says it came from (`providerCatalog`, or a built-in list such as `bundledCatalog`), for the log: the
   * verdict is the same, because a built-in list cannot say a model is wrong and cannot say it is right.
   */
  private async resolveModelSelection(
    manager: SessionManager,
    sessionId: string,
    model: unknown,
  ): Promise<{ selection: unknown; listed: boolean | null; source: string | null }> {
    const rawModelObj = asRecord(model);
    const targetModelId = str(rawModelObj?.["modelId"]);
    if (!rawModelObj || !targetModelId || (rawModelObj["providerId"] !== undefined && rawModelObj["profileId"] !== undefined)) {
      return { selection: model, listed: null, source: null };
    }
    try {
      const managed = [...this.hosts.values()].find((h) => h.manager === manager) ?? null;
      const result = asRecord(
        managed ? await this.listHostModels(managed, sessionId) : await manager.listModels(sessionId),
      );
      const source = str(result?.["source"]);
      const rows = (Array.isArray(result?.["models"]) ? result["models"] : []).map(asRecord);
      if (rows.length === 0) {
        return { selection: model, listed: null, source };
      }
      const entry = rows.find((m) => str(m?.["modelId"]) === targetModelId) ?? null;
      const selection: Record<string, unknown> = { ...rawModelObj };
      const copy = (from: Record<string, unknown> | null, keys: string[]) => {
        for (const key of keys) {
          if (from && selection[key] === undefined && (typeof from[key] === "string" || from[key] === null)) {
            selection[key] = from[key];
          }
        }
      };
      if (entry) {
        copy(entry, ["providerId", "profileId", "displayLabel"]);
      } else {
        copy(result, ["providerId", "profileId"]);
        copy(rows.find((m) => m?.["isActive"] === true) ?? null, ["providerId", "profileId"]);
      }
      return { selection, listed: entry !== null, source };
    } catch {
      return { selection: model, listed: null, source: null };
    }
  }


  /**
   * Puts a thread on a model, the way the picker does and the way a call's thread is put on the one chosen for the voice.
   * An id the catalog does not list is tried on this thread only: Muse keeps it for the session, and a typo is not found
   * out until the next turn. A rejected switch is an error and changes nothing.
   */
  private async setThreadModel(sessionId: string, model: unknown, given?: SessionManager): Promise<void> {
    const manager = given ?? (await this.managerForSession(sessionId));
    const { selection, listed, source } = await this.resolveModelSelection(manager, sessionId, model);
    const modelId = str(asRecord(model)?.["modelId"]);
    // The mark is set first, because the `modelChanged` that answers the switch can arrive before this request does. A
    // list that is only Muse's built-in one (`source` is not `providerCatalog`) proves nothing about the plan, but it
    // cannot tell a typo from a model either, so an id missing from it is a trial just the same.
    const trial = modelId !== null && listed === false;
    const marked = this.modelTrials.get(sessionId);
    if (modelId && trial) {
      this.modelTrials.set(sessionId, modelId);
    } else {
      this.modelTrials.delete(sessionId);
    }
    try {
      await manager.setSessionModel(sessionId, selection);
    } catch (error) {
      // A rejected switch stores nothing and leaves the mark as it was.
      if (marked === undefined) {
        this.modelTrials.delete(sessionId);
      } else {
        this.modelTrials.set(sessionId, marked);
      }
      throw error;
    }
    if (modelId) {
      // The user's pick, kept apart from what Muse reports: a resume that comes back on another model restores it.
      // A trial is no pick, and it must not leave an older one standing either (a pin the thread started with,
      // say): that would be put back over it on the next resume. Cleared, the host's own model wins.
      this.store.updateSession(sessionId, trial ? { modelId, chosenModelId: null } : { modelId, chosenModelId: modelId });
      this.voiceService?.onMuseSessionModelChanged(sessionId, modelId);
      if (trial) {
        // The id comes off the wire: quoted, so a line break in it cannot split the record.
        this.log(`${sessionId} tries ${JSON.stringify(modelId)}, which ${source ? `Muse's ${source} list` : "Muse's list"} does not name; kept for this session only`);
      }
    }
  }


  private async restoreChosenModel(
    manager: SessionManager,
    sessionId: string,
    chosen: string | null,
    msp: Record<string, unknown> | null,
  ): Promise<Record<string, unknown> | null> {
    const currentModelId = msp ? str(msp["modelId"]) : null;
    if (!msp || !chosen || currentModelId === chosen) {
      return (msp);
    }
    try {
      const selection = await this.modelSelection(manager, sessionId, { modelId: chosen });
      await manager.setSessionModel(sessionId, selection);
      return ({ ...msp, modelId: chosen });
    } catch (err) {
      const logMsg = `could not put ${sessionId} back on ${chosen}: ${errorInfo(err).message}`;
      this.log(logMsg);
      return (msp);
    }
  }

  private async startSession(
    cwd: string,
    approvalMode?: ApprovalMode,
    modelId?: string,
    accountId: string | null = null,
    providerId: ProviderId = "muse",
    posture: HostPosture = "coding",
  ): Promise<Record<string, unknown>> {
    const targetProject = this.store.upsertProject(cwd);
    // The thread must be visible where it lands: the owning project when the folder is one of a project's folders.
    this.store.revealProject(cwd);
    const effectivePosture: HostPosture = providerId === "muse" ? posture : "coding";
    const host = await this.hostFor(cwd, accountId, providerId, effectivePosture);
    const workspaceRoot =
      providerId === "muse"
        ? this.hostPathFor(cwd)
        : providerId === "api"
          ? await this.localRootFor(cwd)
          : this.cliHostPathFor(cwd, providerId);
    const sessionLaunch = await host.manager.startSession({
      workspaceRoot,
      approvalMode,
      modelId,
    });
    if (approvalMode) {
      this.approvalModeApplied.set(sessionLaunch.sessionId, approvalMode);
    }
    const rawSessionRecord = asRecord(asRecord(sessionLaunch.raw)?.["session"]);
    const savedRecord = this.store.recordSession({
      id: sessionLaunch.sessionId,
      projectId: targetProject.id,
      origin: "ancilla",
      modelId: rawSessionRecord ? str(rawSessionRecord["modelId"]) : null,
      chosenModelId: modelId ?? null,
      createdAt: normalizeIso(rawSessionRecord?.["createdAt"]),
      // The creating host's own flags, not the live switch: a flip's restart may still be closing the old host.
      sandboxDisabled: providerId === "muse" ? host.target.args.includes("--disable-sandbox") : null,
      providerId,
      accountId,
      ...(effectivePosture === "voice" ? { hostPosture: "voice" as const } : {}),
    });
    this.sessionHosts.set(sessionLaunch.sessionId, host.key);
    if (accountId !== null) {
      if (providerId === "muse") {
        await this.profiles.touch(accountId).catch(() => undefined);
      } else {
        this.store.touchProviderAccount(accountId);
      }
    }
    this.liveFor(sessionLaunch.sessionId);
    this.notifySessionsChange();
    return (this.summary(savedRecord, cwd));
  }

  private async prepareAttachments(
    sessionId: string,
    cwd: string,
    rawList: unknown[],
  ): Promise<{ images: TurnImage[]; files: PreparedAttachment[]; prompt: (text: string) => string; accepted: () => void }> {
    const mentions: string[] = [];
    const images: TurnImage[] = [];
    const files: PreparedAttachment[] = [];
    const written: string[] = [];
    if (rawList.length > MAX_ATTACHMENTS) {
      const maxLimitErr = `A message takes at most ${MAX_ATTACHMENTS} files.`;
      throw new HttpError(400, maxLimitErr);
    }
    for (const item of rawList) {
      const rawRec = asRecord(item);
      const b64Data = rawRec ? str(rawRec["base64"]) : null;
      if (!rawRec || !b64Data || !str(rawRec["mediaType"])) {
        const requiredAttachErr = "Each attachment needs a name, a mediaType and base64 bytes.";
        throw new HttpError(400, requiredAttachErr);
      }
      const mediaType = normalizeMediaType(rawRec["mediaType"]);
      const fileName = safeFileName(str(rawRec["name"]));
      const fileBytes = Buffer.from(b64Data, "base64");
      if (fileBytes.length === 0) {
        const emptyAttachErr = `${fileName} has no content.`;
        throw new HttpError(400, emptyAttachErr);
      }
      if (fileBytes.length > MAX_ATTACHMENT_BYTES) {
        const attachSizeErr = `${fileName} is over ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`;
        throw new HttpError(413, attachSizeErr);
      }
      const imgWidth = num(rawRec["width"]) ?? null;
      const imgHeight = num(rawRec["height"]) ?? null;
      const isImgAttachment = mediaType.startsWith("image/");
      if (isImgAttachment) {
        images.push({
          base64Data: b64Data,
          mediaType,
          ...(imgWidth !== null && imgHeight !== null ? { width: imgWidth, height: imgHeight } : {}),
        });
        files.push({ name: fileName, mediaType, kind: "image", width: imgWidth, height: imgHeight, bytes: fileBytes });
        continue;
      }
      if (!cwd || cwd.length === 0) {
        const workspaceRequiredErr = `${fileName} needs a workspace to land in.`;
        throw new HttpError(400, workspaceRequiredErr);
      }
      const savedAs = await this.writeIntoWorkspace(sessionId, cwd, fileName, fileBytes, written);
      written.push(savedAs.key);
      mentions.push(`@${[...ATTACHMENT_DIR, savedAs.name].join("/")}`);
      files.push({ name: savedAs.name, mediaType, kind: "file", width: imgWidth, height: imgHeight, bytes: fileBytes });
    }
    const attachmentBundle = {
      images,
      files,
      prompt: (text: string) => [text, ...mentions].filter((part) => part.length > 0).join("\n\n"),
      accepted: () => {
        for (const key of written) {
          this.preparedFiles.delete(key);
        }
      },
    };
    return attachmentBundle;
  }


  /**
   * Puts an attached file in the project, where this machine reaches it: the folder the file viewer and the research
   * reports use, which for a Linux project folder on Windows is its `\\wsl.localhost\` share and not a path on the
   * current drive. A file that an earlier try of this same send wrote, when Muse did not take that send, is the one
   * used again, so a retry does not leave a copy behind.
   */
  private async writeIntoWorkspace(
    sessionId: string,
    cwd: string,
    name: string,
    bytes: Buffer,
    alreadyKept: readonly string[],
  ): Promise<{ name: string; key: string }> {
    const root = await this.workspaceRootFor(cwd);
    const base = [sessionId, name, createHash("sha256").update(bytes).digest("hex")].join("\n");
    // The same file twice in one message is two files, each with its own place to come back to.
    let key = base;
    for (let copy = 1; alreadyKept.includes(key); copy += 1) {
      key = `${base}\n${copy}`;
    }
    const earlier = this.preparedFiles.get(key);
    if (earlier) {
      const stillThere = earlier.root === root && Date.now() - earlier.at < PREPARED_REUSE_MS && (await this.isPreparedFile(root, earlier.name, earlier.size));
      if (stillThere) {
        return { name: earlier.name, key };
      }
      this.preparedFiles.delete(key);
    }
    const saved = await this.attachmentWriter(root, name, bytes);
    this.preparedFiles.set(key, { root, name: saved, size: bytes.length, at: Date.now() });
    while (this.preparedFiles.size > PREPARED_REUSE_MAX) {
      const oldest = this.preparedFiles.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.preparedFiles.delete(oldest);
    }
    return { name: saved, key };
  }

  /** Whether the file a failed send wrote is still there, a plain file, and still the size it was written at. */
  private async isPreparedFile(root: string, name: string, size: number): Promise<boolean> {
    const fullPath = join(root, ...ATTACHMENT_DIR, name);
    const state = await entryState(fullPath).catch(() => "missing");
    if (state !== "file") {
      return (false);
    }
    const fileSize = await stat(fullPath).then((info) => info.size, () => -1);
    return (fileSize === size);
  }

  private recordUsage(
    sessionId: string,
    params: Record<string, unknown>,
    replayed?: { at: string; source: "replay" | "estimate" },
  ): void {
    const rawUsageRec = asRecord(params["usage"]) ?? {};
    const recordedPromptTokens = num(params["promptTokens"]) ?? num(rawUsageRec["inputTokens"]) ?? 0;
    const recordedOutputTokens = num(rawUsageRec["outputTokens"]) ?? Math.max(0, (num(params["totalTokens"]) ?? 0) - recordedPromptTokens);
    if (recordedPromptTokens === 0 && recordedOutputTokens === 0) {
      return;
    }
    const sessionRecord = this.store.getSession(sessionId);
    const usageKey = str(params["viewCursor"]) ?? `${sessionId}:${str(params["turnId"]) ?? "turn"}:${randomUUID()}`;
    this.store.recordUsage({
      key: usageKey,
      sessionId,
      turnId: str(params["turnId"]),
      modelId: str(params["modelId"]),
      providerId: sessionRecord?.providerId ?? "muse",
      promptTokens: recordedPromptTokens,
      outputTokens: recordedOutputTokens,
      inputTokens: num(rawUsageRec["inputTokens"]) ?? 0,
      cachedTokens: num(rawUsageRec["cachedTokens"]) ?? 0,
      cacheReadTokens: num(rawUsageRec["cacheReadTokens"]) ?? 0,
      cacheWriteTokens: num(rawUsageRec["cacheWriteTokens"]) ?? 0,
      reasoningTokens: num(rawUsageRec["reasoningTokens"]) ?? 0,
      durationMs: num(params["durationMs"]) ?? null,
      at: replayed?.at ?? normalizeIso(params["at"]) ?? nowIso(),
      atSource: replayed?.source ?? "live",
    });
  }

  private backfillUsage(
    sessionId: string,
    events: { method: string; params: Record<string, unknown> }[],
    stored: SessionRecord | null,
    read: { runningPrompt: number | null; truncated: boolean } | null,
  ): void {
    const turnStarts = turnStartTimes(events);
    let newestTotal: number | null = null;
    for (const event of events) {
      if (event.method !== "session/tokenUsage") {
        continue;
      }
      const turnId = str(event.params["turnId"]);
      const when = replayUsageAt({
        turnId,
        itemAt: turnId ? turnStarts.get(turnId) : null,
        activityAt: stored?.activityAt,
        createdAt: stored?.createdAt,
      });
      this.recordUsage(sessionId, event.params, { at: when.at, source: when.verified ? "replay" : "estimate" });
      const total = num(asRecord(event.params["cumulative"])?.["promptTokens"]);
      if (total !== undefined) {
        newestTotal = Math.max(newestTotal ?? 0, total);
      }
    }
    if (read) {
      const expected =
        read.runningPrompt === null && newestTotal === null
          ? null
          : Math.max(read.runningPrompt ?? 0, newestTotal ?? 0);
      this.store.setUsageCoverage(
        sessionId,
        expected === null ? !read.truncated : this.store.sumUsagePrompt(sessionId) >= expected,
      );
    }
  }

  private usageReport(days: number, tz: string | null = null): Record<string, unknown> {
    const reportWindow = usageWindow(days, tz);
    const dayOf = dayBucketer(reportWindow.tz);
    const rows = this.store.listUsage(reportWindow.since);
    const bucketsMap = new Map<string, Record<string, unknown>>();
    const threadsMap = new Map<string, Record<string, unknown>>();
    for (const usageRow of rows) {
      const day = dayOf(usageRow.at);
      const usageModelId = usageRow.modelId ?? "unknown";
      const usageProviderId = usageRow.providerId ?? "muse";
      const computedCachedTokens = Math.min(usageRow.promptTokens, usageRow.cacheReadTokens || usageRow.cachedTokens);
      const bucketKey = `${day}|${usageProviderId}|${usageModelId}`;
      const bucket = bucketsMap.get(bucketKey) ?? {
        day,
        providerId: usageProviderId,
        modelId: usageModelId,
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
      bucket["promptTokens"] = (bucket["promptTokens"] as number) + usageRow.promptTokens;
      bucket["outputTokens"] = (bucket["outputTokens"] as number) + usageRow.outputTokens;
      bucket["cachedTokens"] = (bucket["cachedTokens"] as number) + computedCachedTokens;
      bucket["cacheReadTokens"] = (bucket["cacheReadTokens"] as number) + usageRow.cacheReadTokens;
      bucket["cacheWriteTokens"] = (bucket["cacheWriteTokens"] as number) + usageRow.cacheWriteTokens;
      bucket["reasoningTokens"] = (bucket["reasoningTokens"] as number) + usageRow.reasoningTokens;
      bucket["durationMs"] = (bucket["durationMs"] as number) + (usageRow.durationMs ?? 0);
      bucketsMap.set(bucketKey, bucket);

      const research = usageRow.origin === "research-worker";
      const threadKey = research
        ? `research-workers:${usageRow.projectCwd ?? ""}${usageProviderId !== "muse" ? `:${usageProviderId}` : ""}${usageRow.accountId ? `:${usageRow.accountId}` : ""}`
        : usageRow.sessionId;
      const thread = threadsMap.get(threadKey) ?? {
        sessionId: threadKey,
        title: research ? "DeepResearch workers" : usageRow.sessionTitle,
        cwd: usageRow.projectCwd,
        ...(research ? { kind: "research" } : {}),
        providerId: usageProviderId,
        accountId: usageRow.accountId,
        calls: 0,
        promptTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        modelIds: [] as string[],
        models: [] as Record<string, unknown>[],
        lastAt: usageRow.at,
      };
      thread["calls"] = (thread["calls"] as number) + 1;
      thread["promptTokens"] = (thread["promptTokens"] as number) + usageRow.promptTokens;
      thread["outputTokens"] = (thread["outputTokens"] as number) + usageRow.outputTokens;
      thread["cachedTokens"] = (thread["cachedTokens"] as number) + computedCachedTokens;
      const modelIdList = thread["modelIds"] as string[];
      if (!modelIdList.includes(usageModelId)) {
        modelIdList.push(usageModelId);
      }
      const perModelList = thread["models"] as Record<string, unknown>[];
      const modelShare = perModelList.find((entry) => entry["modelId"] === usageModelId);
      if (modelShare) {
        modelShare["calls"] = (modelShare["calls"] as number) + 1;
        modelShare["promptTokens"] = (modelShare["promptTokens"] as number) + usageRow.promptTokens;
        modelShare["outputTokens"] = (modelShare["outputTokens"] as number) + usageRow.outputTokens;
        modelShare["cachedTokens"] = (modelShare["cachedTokens"] as number) + computedCachedTokens;
      } else {
        perModelList.push({
          modelId: usageModelId,
          calls: 1,
          promptTokens: usageRow.promptTokens,
          outputTokens: usageRow.outputTokens,
          cachedTokens: computedCachedTokens,
        });
      }
      thread["lastAt"] = usageRow.at;
      threadsMap.set(threadKey, thread);
    }
    const reportResult: Record<string, unknown> = {
      since: reportWindow.since,
      days,
      tz: reportWindow.tz,
      buckets: [...bucketsMap.values()],
      threads: [...threadsMap.values()].sort((a, b) => ((a["lastAt"] as string) < (b["lastAt"] as string) ? 1 : -1)),
      coverage: this.store.usageCoverage(reportWindow.since),
    };
    return (reportResult);
  }

  /**
   * Plans a shell command inside a project workspace across POSIX, WSL, and native Windows PowerShell (falling back to
   * PowerShell on Windows when WSL is unavailable so local/cloud providers work without WSL or Muse installed).
   */
  private async planWorkspaceCommand(cwd: string, command: string): Promise<PlannedSpawn> {
    if (this.closed) {
      throw new HttpError(503, "Ancilla is shutting down.");
    }
    if (this.options.platform !== "win32") {
      return {
        command: "sh",
        args: ["-c", 'cd "$1" || exit 1; shift; exec "${SHELL:-/bin/sh}" -lc "$1"', "sh", this.hostPathFor(cwd), command],
      };
    }
    const hint = this.runtimeHint();
    let useNative = hint === "native";
    if (!useNative && hint !== "wsl") {
      const env = await this.environment(false).catch(() => null);
      useNative = env?.runtime === "native" || (!env?.wslAvailable && isWindowsAbs(this.spawnCwdFor(cwd)));
    }
    if (useNative) {
      const folder = this.spawnCwdFor(cwd).replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&");
      const powershell = win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = `Set-Location -LiteralPath '${folder}' -ErrorAction Stop\n${command}`;
      return {
        command: powershell,
        args: ["-NoProfile", "-NonInteractive", "-Command", script],
        cwd: this.spawnCwdFor(cwd),
      };
    }
    const plan = planHostCommand({
      platform: this.options.platform,
      distro: this.wslDistro(),
      program: "sh",
      args: ["-c", 'cd "$1" || exit 1; shift; exec "${SHELL:-/bin/sh}" -lc "$1"', "sh", this.hostPathFor(cwd), command],
    });
    const wslEnv = this.wslEnvFor();
    return { command: plan.command, args: plan.args, ...(wslEnv ? { env: wslEnv } : {}) };
  }


  private async runInWorkspace(
    cwd: string,
    command: string,
  ): Promise<{ output: string; exitCode: number | null; truncated: boolean; durationMs: number }> {
    const startTimestamp = Date.now();
    if (this.closed) {
      throw new HttpError(503, "Ancilla is shutting down.");
    }

    const activeRuntime = await this.museRuntime();
    if (activeRuntime === "native") {
      const sanitizedFolder = this.spawnCwdFor(cwd).replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&");
      const winRootDir = process.env["SystemRoot"] ?? "C:\\Windows";
      const powershellExe = win32.join(winRootDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const executionScript = `Set-Location -LiteralPath '${sanitizedFolder}' -ErrorAction Stop\n${command}`;
      const executionResult = await this.options.shellRunner(powershellExe, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        executionScript,
      ]);
      return {
        ...executionResult,
        output: executionResult.output.replaceAll("\r\n", "\n"),
        durationMs: Date.now() - startTimestamp,
      };
    }

    const resolvedWslDistro = this.wslDistro();
    const commandScript = 'cd "$1" || exit 1; shift; exec "${SHELL:-/bin/sh}" -lc "$1"';
    const commandPlan = planHostCommand({
      platform: this.options.platform,
      distro: resolvedWslDistro,
      program: "sh",
      args: ["-c", commandScript, "sh", this.hostPathFor(cwd), command],
    });
    const executionResult = await this.options.shellRunner(commandPlan.command, commandPlan.args);
    return {
      ...executionResult,
      durationMs: Date.now() - startTimestamp,
    };
  }

  private attachmentView(record: AttachmentRecord): Record<string, unknown> {
    const viewRecord: Record<string, unknown> = {
      id: record.id,
      turnId: record.turnId,
      name: record.name,
      mediaType: record.mediaType,
      kind: record.kind,
      width: record.width,
      height: record.height,
      url: `/api/attachments/${record.id}`,
    };
    return viewRecord;
  }

  private async pageTranscript(
    sessionManager: SessionManager,
    sessionId: string,
  ): Promise<{ events: { method: string; params: Record<string, unknown> }[]; truncated: boolean }> {
    const pagedBatches: unknown[][] = [];
    let pageCursor: string | undefined;
    let isTruncatedHistory = false;
    for (let pageIdx = 0; pageIdx < MAX_HISTORY_PAGES; pageIdx += 1) {
      const pageResult = await sessionManager.pageView(sessionId, { cursor: pageCursor, direction: "backward", limit: HISTORY_PAGE_SIZE });
      pagedBatches.unshift(pageResult.events);
      if (!pageResult.nextCursor || pageResult.events.length === 0) {
        break;
      }
      pageCursor = pageResult.nextCursor;
      isTruncatedHistory = pageIdx === MAX_HISTORY_PAGES - 1;
    }
    const flattenedEvents = pagedBatches.flat().map(stripEvent).filter((e): e is NonNullable<typeof e> => e !== null);
    const historyPayload = {
      events: flattenedEvents,
      truncated: isTruncatedHistory,
    };
    return historyPayload;
  }

  private async loadTranscript(sessionId: string, isRefresh = false): Promise<Record<string, unknown>> {
    const liveState = this.liveFor(sessionId);
    const initialActivitySeq = liveState.activityRevision;
    const initialGoalSeq = liveState.goalSeq;
    const previousActiveTurn = liveState.activeTurnId;

    const storedEntry = this.store.findSession(sessionId);
    const targetProvider = this.normalizeProviderId(storedEntry?.session.providerId);
    const activeHost = await this.hostFor(storedEntry?.cwd ?? "", storedEntry?.session.accountId ?? null, targetProvider);
    const sessionManager = activeHost.manager;

    const detectedActiveTurns = new Set<string>();
    const noteActiveTurn = (sessionData: Record<string, unknown> | null): void => {
      if (sessionData && sessionData["status"] !== "notLoaded") {
        const turnId = str(sessionData["activeTurnId"]);
        if (turnId) detectedActiveTurns.add(turnId);
      }
    };

    let sessionSnapshot: Record<string, unknown> | null = null;
    let inspectionRecord: Record<string, unknown> | null = null;
    let shouldAttemptResume = !isRefresh;

    if (isRefresh) {
      inspectionRecord = asRecord(await sessionManager.readSession(sessionId, false));
      sessionSnapshot = asRecord(inspectionRecord?.["session"]);
      noteActiveTurn(sessionSnapshot);

      const hasPendingQueue = Array.isArray(inspectionRecord?.["pendingRequests"]) && inspectionRecord["pendingRequests"].length > 0;
      const isUnloaded = sessionSnapshot?.["status"] === "notLoaded";
      shouldAttemptResume = isUnloaded && !hasPendingQueue && this.mayLoadUnloaded(sessionId, activeHost);
    }

    let resumedOk = false;
    if (shouldAttemptResume) {
      try {
        const resumePayload = asRecord(await sessionManager.resumeSession(sessionId, true));
        sessionSnapshot = asRecord(resumePayload?.["session"]) ?? sessionSnapshot;
        if (!isRefresh) {
          inspectionRecord = resumePayload;
        }
        resumedOk = true;

        if (this.hosts.get(activeHost.key) === activeHost) {
          this.sessionHosts.set(sessionId, activeHost.key);
        }
        const currentLiveEntry = this.liveFor(sessionId);
        currentLiveEntry.readOnlyReason = null;
        sessionSnapshot = await this.restoreChosenModel(
          sessionManager,
          sessionId,
          storedEntry?.session.chosenModelId ?? null,
          sessionSnapshot,
        );
      } catch (resumeError) {
        const errDetails = errorInfo(resumeError);
        if (errDetails.kind === "sessionInUse") {
          const lockMessage = errDetails.message.trim() || "Another Muse session has this thread open.";
          this.liveFor(sessionId).readOnlyReason = lockMessage;
          if (this.sessionHosts.get(sessionId) === activeHost.key) {
            this.sessionHosts.delete(sessionId);
          }
        } else if (!isRefresh) {
          throw resumeError;
        } else {
          this.log(`refresh of ${sessionId} could not load it on ${activeHost.key}: ${errDetails.message}`);
        }
      }
    }

    const calculatedPromptTokens = [
      runningPromptTotal(sessionSnapshot),
      runningPromptTotal(asRecord(asRecord(asRecord(inspectionRecord?.["history"])?.["snapshot"])?.["state"])),
    ].reduce<number | null>((highest, curr) => (curr === null ? highest : Math.max(highest ?? 0, curr)), null);

    let eventLog: { method: string; params: Record<string, unknown> }[] = [];
    let isHistoryTruncated = false;
    let isPagedHistory = false;

    try {
      const pagedData = await this.pageTranscript(sessionManager, sessionId);
      eventLog = pagedData.events;
      isHistoryTruncated = pagedData.truncated;
      isPagedHistory = true;
    } catch (pageError) {
      const errKind = errorInfo(pageError).kind;
      if (errKind !== "sessionInUse" && errKind !== "sessionNotLoaded") {
        throw pageError;
      }
    }

    let isHistoryUnavailable = false;
    if (eventLog.length === 0 && !isRefresh) {
      const fallbackSnapshot = await sessionManager.readSession(sessionId, false).then(asRecord, () => undefined);
      if (fallbackSnapshot === undefined) {
        isHistoryUnavailable = true;
      } else {
        inspectionRecord = fallbackSnapshot;
      }
    }

    if (!sessionSnapshot) {
      sessionSnapshot = asRecord(inspectionRecord?.["session"]);
    }
    eventLog.push(...eventsFromHistory(inspectionRecord));

    const pendingRequests = await sessionManager.listPending(sessionId).catch(() => null);
    const activeApprovals = (pendingRequests?.approvals ?? []).map((appr) => stripSource(asRecord(appr) ?? {}));
    const activeUserInputs = (pendingRequests?.userInputs ?? []).map((input) => stripSource(asRecord(input) ?? {}));

    if (isRefresh && !resumedOk) {
      const freshSessionWrap = asRecord(await sessionManager.readSession(sessionId, true).catch(() => null));
      const laterSession = asRecord(freshSessionWrap?.["session"]);
      if (laterSession) {
        sessionSnapshot = {
          ...(sessionSnapshot ?? {}),
          ...laterSession,
          status: laterSession["status"],
          activeTurnId: laterSession["activeTurnId"] ?? null,
        };
      }
    }

    const currentLive = this.liveFor(sessionId);
    const hasBeenSuperseded = currentLive.activityRevision !== initialActivitySeq;
    const isStatusIdentified = sessionSnapshot !== null && sessionSnapshot["status"] !== "notLoaded";
    noteActiveTurn(sessionSnapshot);

    if (isRefresh && !resumedOk && isStatusIdentified) {
      if (this.hosts.get(activeHost.key) === activeHost) {
        this.sessionHosts.set(sessionId, activeHost.key);
      }
      currentLive.readOnlyReason = null;
    }

    const currentReadOnlyReason = currentLive.readOnlyReason;
    const historyBlock = asRecord(inspectionRecord?.["history"]);
    const noneReasonString = str(historyBlock?.["noneReason"]);
    const isProjectionMissing = noneReasonString === "projectionUnavailable";
    const historyStateItems = asRecord(asRecord(historyBlock?.["snapshot"])?.["state"])?.["items"];

    const isHistoryRendered =
      (historyBlock?.["mode"] === "inline" && Array.isArray(historyBlock["items"])) ||
      (["snapshot", "anchoredSnapshot"].includes(String(historyBlock?.["mode"])) &&
        (Array.isArray(historyStateItems) || asRecord(historyStateItems) !== null));

    if (!hasBeenSuperseded) {
      if (isProjectionMissing) {
        currentLive.viewHealth = { status: "unavailable", reason: noneReasonString };
      } else if (isHistoryRendered) {
        currentLive.viewHealth = null;
      }
    }

    const extractTerminalTurn = (evt: { method: string; params: Record<string, unknown> }): string | null =>
      evt.method === "turn/completed" ? str(evt.params["turnId"]) : null;

    const isTerminalFailed = (evt: { method: string; params: Record<string, unknown> }): boolean =>
      str(evt.params["terminal"]) === "failed";

    const isFreshState = isStatusIdentified && !hasBeenSuperseded;

    if (isFreshState) {
      const activeTurn = str(sessionSnapshot!["activeTurnId"]);
      if (activeTurn !== currentLive.activeTurnId) {
        currentLive.activeTurnId = activeTurn;
        currentLive.turnStartedAt = activeTurn ? nowIso() : null;
      }
      currentLive.turnHost = activeTurn ? activeHost.key : null;
    } else if (!isStatusIdentified && !hasBeenSuperseded && currentLive.activeTurnId) {
      const ongoingTurnId = currentLive.activeTurnId;
      const turnConcluded = eventLog.some((evt) => extractTerminalTurn(evt) === ongoingTurnId && !isTerminalFailed(evt));
      if (turnConcluded) {
        currentLive.activeTurnId = null;
        currentLive.turnStartedAt = null;
        currentLive.turnHost = null;
      }
    }

    if (pendingRequests && isStatusIdentified && !hasBeenSuperseded) {
      currentLive.pendingApprovals = new Set(
        activeApprovals.map((appr) => str(appr["approvalId"])).filter((id): id is string => id !== null),
      );
      currentLive.pendingInputs = new Set(
        activeUserInputs.map((inp) => str(inp["userInputId"])).filter((id): id is string => id !== null),
      );
    }

    const currentRunningTurn = isFreshState ? currentLive.activeTurnId : null;
    const unconfirmedTurnIds = new Set(detectedActiveTurns);
    if (!isFreshState && currentLive.activeTurnId) {
      unconfirmedTurnIds.add(currentLive.activeTurnId);
    }

    const mostRecentStartIndex = eventLog.findLastIndex(
      (evt) => evt.method === "turn/started" && unconfirmedTurnIds.has(str(evt.params["turnId"]) ?? ""),
    );

    const followingEvents = mostRecentStartIndex === -1 ? [] : eventLog.slice(mostRecentStartIndex + 1);
    for (const evt of followingEvents) {
      if (evt.method === "turn/started") {
        const startedId = str(evt.params["turnId"]);
        if (startedId) unconfirmedTurnIds.add(startedId);
      }
    }

    eventLog = eventLog.filter((evt) => {
      const terminalTurnId = extractTerminalTurn(evt);
      if (!terminalTurnId) {
        const keepTurnEvent = true;
        return keepTurnEvent;
      }
      const eventSig = JSON.stringify(evt.params);

      if (terminalTurnId === currentRunningTurn) {
        if (isTerminalFailed(evt)) {
          currentLive.provisional.delete(eventSig);
          currentLive.provisional.add(eventSig);
          if (currentLive.provisional.size > PROVISIONAL_LIMIT) {
            const oldestSig = currentLive.provisional.values().next().value as string;
            currentLive.provisional.delete(oldestSig);
          }
        }
        const discardRunningTurnEvent = false;
        return discardRunningTurnEvent;
      }

      if (unconfirmedTurnIds.has(terminalTurnId) && isTerminalFailed(evt)) {
        const discardFailedTurnEvent = false;
        return discardFailedTurnEvent;
      }

      const isProvisionalSuppressed = isProjectionMissing && currentLive.provisional.has(eventSig);
      return !isProvisionalSuppressed;
    });

    if (!hasBeenSuperseded && previousActiveTurn && currentLive.activeTurnId !== previousActiveTurn) {
      const terminalEvt = [...eventLog].reverse().find((evt) => extractTerminalTurn(evt) === previousActiveTurn);
      const terminalStatus = terminalEvt && currentLive.activeTurnId === null ? (str(terminalEvt.params["terminal"]) ?? "completed") : null;
      const isStatusKnown = terminalStatus !== null && !(terminalStatus === "failed" && isProjectionMissing);
      currentLive.lastTerminal = isStatusKnown ? terminalStatus : null;
      currentLive.lastError =
        isStatusKnown && terminalStatus === "failed"
          ? (str(asRecord(terminalEvt!.params["error"])?.["message"]) ?? "The turn failed.")
          : null;
    } else if (!previousActiveTurn && isFreshState && !isProjectionMissing && currentLive.activeTurnId === null && currentLive.lastTerminal === null) {
      const latestStartIdx = eventLog.findLastIndex((evt) => evt.method === "turn/started");
      const latestCompleteIdx = eventLog.findLastIndex((evt) => evt.method === "turn/completed");
      const closingEvt = latestCompleteIdx > latestStartIdx ? eventLog[latestCompleteIdx]! : null;
      const associatedTurnId = latestStartIdx === -1 ? null : str(eventLog[latestStartIdx]!.params["turnId"]);

      if (closingEvt && (associatedTurnId === null || extractTerminalTurn(closingEvt) === associatedTurnId)) {
        currentLive.lastTerminal = str(closingEvt.params["terminal"]) ?? "completed";
        currentLive.lastError =
          currentLive.lastTerminal === "failed"
            ? (str(asRecord(closingEvt.params["error"])?.["message"]) ?? "The turn failed.")
            : null;
      }
    }

    this.backfillUsage(sessionId, eventLog, storedEntry?.session ?? null, isPagedHistory ? { runningPrompt: calculatedPromptTokens, truncated: isHistoryTruncated } : null);

    for (let idx = eventLog.length - 1; currentLive.goalSeq === initialGoalSeq && idx >= 0; idx -= 1) {
      const evt = eventLog[idx];
      const goalCandidate = evt?.method === "session/goalChanged" ? goalOf(evt.params["goal"]) : undefined;
      if (goalCandidate !== undefined) {
        const viewCursor = str(evt!.params["viewCursor"]);
        if (!isProjectionMissing || currentLive.goal === null || cursorAfter(viewCursor, currentLive.goalCursor)) {
          currentLive.goal = goalCandidate;
          currentLive.goalCursor = viewCursor;
        }
        break;
      }
    }

    const currentSessionTarget = sessionId;
    this.emitStatus(currentSessionTarget);

    if (storedEntry && !hasBeenSuperseded) {
      this.store.recordSession({
        id: sessionId,
        projectId: storedEntry.session.projectId,
        turnCount: num(sessionSnapshot?.["turnCount"]),
        modelId: sessionSnapshot ? str(sessionSnapshot["modelId"]) : null,
        activityAt: normalizeIso(sessionSnapshot?.["updatedAt"]),
      });

      if (storedEntry.session.titleSource === "placeholder") {
        const heuristicTitle = titleFromEvents(eventLog);
        if (heuristicTitle) {
          this.store.updateSession(sessionId, { title: heuristicTitle, titleSource: "auto" });
          this.titleUpgradePending.add(sessionId);
          void this.maybeUpgradeThreadTitle(sessionId, firstUserText(eventLog) ?? "");
          this.notifySessionsChange();
        }
      }
    }

    const sessionRecord = this.store.getSession(sessionId);

    const transcriptResult: Record<string, unknown> = {
      session: sessionRecord && storedEntry ? this.summary(sessionRecord, storedEntry.cwd) : null,
      msp: sessionSnapshot
        ? {
            status: str(sessionSnapshot["status"]),
            activeTurnId: hasBeenSuperseded || !isStatusIdentified ? currentLive.activeTurnId : str(sessionSnapshot["activeTurnId"]),
            modelId: str(sessionSnapshot["modelId"]),
            approvalMode: asRecord(sessionSnapshot["approvalMode"])?.["mode"] ?? null,
            workspaceRoot: str(sessionSnapshot["workspaceRoot"]),
            turnCount: num(sessionSnapshot["turnCount"]) ?? 0,
            contextUsage: asRecord(sessionSnapshot["contextUsage"]) ?? null,
            tokenUsage: asRecord(sessionSnapshot["tokenUsage"]) ?? null,
          }
        : null,
      events: eventLog,
      truncated: isHistoryTruncated,
      attachments: this.store.listAttachments(sessionId).map((item) => this.attachmentView(item)),
      shellRuns: this.store.listShellRuns(sessionId),
      researchRuns: this.researchViews(sessionId),
      pending: { approvals: activeApprovals, userInputs: activeUserInputs },
      pendingComplete: pendingRequests !== null && isStatusIdentified && !hasBeenSuperseded,
      historyUnavailable: isProjectionMissing || (noneReasonString !== null && eventLog.length === 0) || isHistoryUnavailable,
      viewHealth: currentLive.viewHealth,
      readOnly: currentReadOnlyReason !== null,
      readOnlyReason: currentReadOnlyReason,
    };
    return transcriptResult;
  }
  private isHiddenResearchItem(rawItem: unknown): boolean {
    const itemRec = asRecord(rawItem);
    const sessionObj = (itemRec && asRecord(itemRec["session"])) ?? itemRec;
    const resolvedId = sessionObj ? str(sessionObj["sessionId"]) : null;
    return resolvedId !== null && this.isResearchSession(resolvedId);
  }

  private async discover(searchDir?: string): Promise<Record<string, unknown>[]> {
    const targetHost = await this.hostFor(searchDir ?? "");
    const gatheredSessions: unknown[] = [];
    let pageCursor: string | null = null;
    const visitedCursors = new Set<string>();

    for (let pageIdx = 0; pageIdx < DISCOVER_MAX_PAGES; pageIdx += 1) {
      const pageResult = await targetHost.manager.listSessionsPage({
        workspaceRoot: searchDir ? this.hostPathFor(searchDir) : undefined,
        limit: 100,
        cursor: pageCursor,
      });

      for (const item of pageResult.sessions) {
        if (!this.isHiddenResearchItem(item)) {
          gatheredSessions.push(item);
        }
      }

      pageCursor = pageResult.nextCursor;
      if (
        !pageCursor ||
        pageResult.sessions.length === 0 ||
        visitedCursors.has(pageCursor) ||
        gatheredSessions.length >= DISCOVER_LIMIT
      ) {
        break;
      }
      visitedCursors.add(pageCursor);
    }

    const outputViews: Record<string, unknown>[] = [];
    let backfillCount = 0;

    for (const rawSession of gatheredSessions) {
      const sessionRecord = asRecord(rawSession);
      const sessionData = (sessionRecord && asRecord(sessionRecord["session"])) ?? sessionRecord;
      const targetSessionId = sessionData ? str(sessionData["sessionId"]) : null;
      if (!sessionData || !targetSessionId) {
        continue;
      }

      const rootPath = this.storePathFor(firstString(sessionData, ["workspaceRoot"]) ?? searchDir ?? "");
      if (!rootPath) {
        continue;
      }

      const projRecord = this.store.upsertProject(rootPath);
      const existingSession = this.store.getSession(targetSessionId);

      const keepExistingTitle =
        existingSession?.titleSource === "user" ||
        (!this.options.syncSessionNames && existingSession !== null && existingSession.titleSource !== "placeholder");

      const nameFromMsp = keepExistingTitle ? null : firstString(sessionData, ["name"]);
      const titleFromMsp = keepExistingTitle ? null : firstString(sessionData, ["title"]);
      const derivedEcho = nameFromMsp ? null : titleFromMsp ? deriveTitle(titleFromMsp) : null;

      const shouldApplyEcho =
        derivedEcho !== null &&
        (!existingSession || existingSession.titleSource === "placeholder" || existingSession.title === derivedEcho);

      const assignedTitle = nameFromMsp ?? (shouldApplyEcho ? derivedEcho : null);

      const storedRow = this.store.recordSession({
        id: targetSessionId,
        projectId: projRecord.id,
        origin: existingSession?.origin ?? "tui",
        title: assignedTitle ?? undefined,
        titleSource: assignedTitle ? "auto" : undefined,
        turnCount: num(sessionData["turnCount"]),
        modelId: str(sessionData["modelId"]),
        createdAt: normalizeIso(sessionData["createdAt"]),
        activityAt: normalizeIso(sessionData["updatedAt"]),
      });

      const isTurnRunning = str(sessionData["status"]) === "running" && Boolean(str(sessionData["activeTurnId"]));
      if (isTurnRunning) {
        const liveView = this.liveFor(targetSessionId);
        const activeTurn = str(sessionData["activeTurnId"]);
        if (liveView.activeTurnId !== activeTurn) {
          liveView.activityRevision += 1;
          liveView.activeTurnId = activeTurn;
          liveView.turnStartedAt = null;
        }
        liveView.turnHost = targetHost.key;
        liveView.turnStartedAt = liveView.turnStartedAt ?? nowIso();
        this.sessionHosts.set(targetSessionId, targetHost.key);
      }

      let currentRecord = storedRow;
      if (
        storedRow.settledOverride === "settled" &&
        (isTurnRunning || (storedRow.settledAt !== null && storedRow.activityAt > storedRow.settledAt))
      ) {
        this.wake(targetSessionId);
        currentRecord = this.store.getSession(targetSessionId) ?? storedRow;
      }

      if (nameFromMsp) {
        this.titleUpgradePending.delete(targetSessionId);
      }

      const shouldUpgradeTitle =
        !this.titleUpgradeActive.has(targetSessionId) &&
        (storedRow.titleSource === "placeholder" ||
          (storedRow.titleSource === "auto" && derivedEcho !== null && storedRow.title === derivedEcho));

      if (shouldUpgradeTitle && backfillCount < TITLE_BACKFILL_LIMIT) {
        backfillCount += 1;
        this.titleUpgradePending.add(targetSessionId);
        this.queueTitle(targetSessionId);
      }

      outputViews.push(this.summary(currentRecord, projRecord.cwd));
    }

    this.notifySessionsChange();
    return outputViews;
  }

  private queueTitle(targetSessionId: string): void {
    if (this.closed || this.titleQueue.includes(targetSessionId)) {
      return;
    }
    this.titleQueue.push(targetSessionId);
    if (this.titleWorker === null || !this.titleWorker) {
      this.titleWorker = (async () => {
        try {
          await this.drainTitles();
        } finally {
          this.titleWorker = null;
        }
      })();
    }
  }

  private async drainTitles(): Promise<void> {
    while (!this.closed && this.titleQueue.length > 0) {
      const pendingSessionId = this.titleQueue.shift();
      if (!pendingSessionId) break;

      try {
        const sessionRecord = this.store.getSession(pendingSessionId);
        if (!sessionRecord || sessionRecord.titleSource === "user") {
          this.titleUpgradePending.delete(pendingSessionId);
          continue;
        }
        if (sessionRecord.titleSource !== "placeholder" && !this.titleUpgradePending.has(pendingSessionId)) {
          continue;
        }

        const normalizedProvider = this.normalizeProviderId(sessionRecord.providerId);
        const resolvedWorkingDir = normalizedProvider === "muse" ? "" : (this.store.findSession(pendingSessionId)?.cwd ?? "");
        const hostInstance = await this.hostFor(resolvedWorkingDir, sessionRecord.accountId ?? null, normalizedProvider);

        const pageOverview = await hostInstance.manager.pageView(pendingSessionId, { direction: "forward", limit: 30 });
        if (this.closed) return;

        const cleanEvents = pageOverview.events.map(stripEvent).filter((ev): ev is NonNullable<typeof ev> => ev !== null);

        if (sessionRecord.titleSource === "placeholder") {
          const derived = titleFromEvents(cleanEvents);
          if (!derived) {
            this.titleUpgradePending.delete(pendingSessionId);
            continue;
          }
          this.store.updateSession(pendingSessionId, { title: derived, titleSource: "auto" });
          this.titleUpgradePending.add(pendingSessionId);
          this.notifySessionsChange();
        }

        await this.maybeUpgradeThreadTitle(pendingSessionId, firstUserText(cleanEvents) ?? "");
      } catch {
        /* Title upgrades are best-effort */
      }
    }
  }

  private async maybeUpgradeThreadTitle(targetSessionId: string, openingText: string): Promise<void> {
    if (!this.titleUpgradePending.has(targetSessionId) || this.titleUpgradeActive.has(targetSessionId)) {
      return;
    }
    try {
      const titleSettings = this.store.getTitleSettings();
      if (!titleSettings.enabled) {
        return;
      }
      const priorState = this.store.getSession(targetSessionId);
      if (!priorState || priorState.titleSource !== "auto" || !openingText.trim()) {
        this.titleUpgradePending.delete(targetSessionId);
        return;
      }

      this.titleUpgradePending.delete(targetSessionId);
      this.titleUpgradeActive.add(targetSessionId);
      try {
        await this.runThreadTitleUpgrade(targetSessionId, openingText, priorState.title, titleSettings.modelId);
      } finally {
        this.titleUpgradeActive.delete(targetSessionId);
      }
    } catch {
      /* Title upgrade error silently caught; existing title preserved */
    }
  }

  private async runThreadTitleUpgrade(
    targetSessionId: string,
    initialText: string,
    baselineTitle: string,
    configuredModelId: string | null,
  ): Promise<void> {
    const sessionRow = this.store.getSession(targetSessionId);
    if (!sessionRow) {
      return;
    }
    const resolvedProvider = this.normalizeProviderId(sessionRow.providerId);
    let generatedTitleString: string | null = null;

    if (resolvedProvider === "muse") {
      const execOutput = await this.museExec({
        prompt: buildThreadTitlePrompt(initialText),
        modelId: configuredModelId,
        accountId: sessionRow.accountId,
      });
      if (this.closed || execOutput.exitCode !== 0) {
        return;
      }
      generatedTitleString = parseExecTitle(execOutput.stdout);
    } else if (resolvedProvider === "api") {
      generatedTitleString = await this.generateApiThreadTitle(sessionRow, initialText, configuredModelId);
    } else {
      return;
    }

    const cleanTitle = sanitizeThreadTitle(generatedTitleString ?? "", initialText);
    if (!cleanTitle || cleanTitle === baselineTitle) {
      return;
    }

    const latestState = this.store.getSession(targetSessionId);
    if (!latestState || latestState.titleSource !== "auto" || latestState.title !== baselineTitle) {
      return;
    }

    this.store.updateSession(targetSessionId, { title: cleanTitle, titleSource: "auto" });
    if (resolvedProvider === "muse") {
      await this.renameInMuse(targetSessionId, cleanTitle);
    }
    this.notifySessionsChange();
  }

  private async planMuseExec(cliArgs: string[], profileAccountId: string | null): Promise<MuseExecPlan> {
    await this.ensureLinuxMuseStorage(profileAccountId);
    const resolvedPath = await this.cliMusePath();
    const activeRuntime = await this.museRuntime();
    const plannedCmd = planMuseCli({
      platform: this.options.platform,
      distro: this.wslDistro(),
      musePath: resolvedPath,
      args: cliArgs,
      runtime: activeRuntime,
    });

    let profileEnvironment: Record<string, string> | null = null;
    if (profileAccountId) {
      const prof = await this.profiles.getProfile(profileAccountId);
      profileEnvironment = this.profiles.envFor(prof);
    }

    let processEnvironment: NodeJS.ProcessEnv | undefined;
    if (this.options.platform === "win32" && activeRuntime === "wsl") {
      processEnvironment = profileEnvironment
        ? this.wslEnvFor(profileEnvironment, PROFILE_WSLENV)
        : this.wslEnvFor();
    } else if (profileEnvironment || this.options.platform === "linux") {
      processEnvironment = {
        ...process.env,
        HOME: this.options.home,
        ...(profileEnvironment ?? {}),
      };
    }

    return {
      command: plannedCmd.command,
      args: plannedCmd.args,
      ...(processEnvironment ? { env: processEnvironment } : {}),
    };
  }

  private async museExec(execOptions: {
    prompt: string;
    modelId: string | null;
    accountId?: string | null;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ExecResult> {
    const cmdPlan = await this.planMuseExec(
      museExecArgs(execOptions.prompt, execOptions.modelId),
      execOptions.accountId ?? null,
    );
    return this.options.exec(cmdPlan.command, cmdPlan.args, {
      ...(cmdPlan.env ? { env: cmdPlan.env } : {}),
      ...(execOptions.timeoutMs !== undefined ? { timeoutMs: execOptions.timeoutMs } : {}),
      ...(execOptions.signal ? { signal: execOptions.signal } : {}),
    });
  }

  private async runMuseUsage(usageRequest: MuseUsageCliRequest): Promise<MuseUsageCliResult> {
    const cmdPlan = await this.planMuseExec(["usage", "--json"], usageRequest.accountId);
    let execEnv = cmdPlan.env;
    if (usageRequest.accountId === null && (await this.museRuntime()) !== "wsl") {
      execEnv = {
        ...(execEnv ?? { ...process.env, HOME: this.options.home }),
        MUSE_AUTH_PATH: usageRequest.authPath,
      };
    }
    return this.options.exec(cmdPlan.command, cmdPlan.args, {
      ...(execEnv ? { env: execEnv } : {}),
      signal: usageRequest.signal,
    });
  }

  /** Delivers one session's host notifications to a listener until the returned function is called. */
  private onSessionNotification(sessionId: string, handler: SessionNotificationHandler): () => void {
    let listeners = this.sessionListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.sessionListeners.set(sessionId, listeners);
    }
    listeners.add(handler);
    return () => {
      const current = this.sessionListeners.get(sessionId);
      current?.delete(handler);
      if (current && current.size === 0) {
        this.sessionListeners.delete(sessionId);
      }
    };
  }

  /**
   * How long a research session start may take now: the option, else `ANCILLA_RESEARCH_STARTUP_MS`, else two
   * minutes, or three on Windows with Muse in WSL. Read at each start, because where Muse runs can be settled only
   * after the first host came up.
   */
  private researchStartupMs(): number {
    return researchStartupAllowanceMs({
      platform: this.options.platform,
      runtime: this.runtimeHint() ?? this.runtimeKnown,
      option: this.researchStartupOverride.option,
      env: this.researchStartupOverride.env,
    });
  }

  /**
   * A session a research run uses, on the thread's own host so it shares the thread's folder and account: a
   * worker session for one delegated task, or the run's control session for the tool-less model calls that do
   * not fit a command line. Recorded archived under `research-worker`, so it never reaches the sidebar; its usage
   * still lands under the project. The approval mode is the host's default: the runner decides every request
   * itself, and `isResearchSession` keeps such requests out of the live state clients see.
   */
  private async startResearchSession(thread: ResearchThread, title: string, modelId: string | null, giveUp?: AbortSignal): Promise<WorkerSessionHandle & TurnSession> {
    if (this.closed) {
      throw new Error("Ancilla is shutting down.");
    }
    const providerId = this.normalizeProviderId(thread.providerId);
    const key = this.hostKey(thread.cwd, thread.accountId, providerId);
    // A host that has not answered the starts earlier runs gave up on is sent no more until it does; the wait is
    // bounded by the same allowance as the start itself, which the caller's give-up signal ends.
    await this.waitForStartSlot(key, giveUp);
    if (this.closed) {
      throw new Error("Ancilla is shutting down.");
    }
    if (giveUp?.aborted) {
      // The caller stopped waiting while this start was released; nobody would read its answer, so it is not sent.
      throw new Error("The research run stopped waiting for this session start.");
    }
    // A run that stops waiting for this start because the allowance passed counts it against the host until the
    // host answers it, one way or the other. A stop does not: a host that is merely slow would otherwise refuse the
    // next run for the time it takes to answer the starts the stopped one left behind.
    let abandoned = false;
    const onGiveUp = (): void => {
      if (!abandoned && giveUp && gaveUpOnTimeout(giveUp)) {
        abandoned = true;
        this.abandonedStarts.set(key, (this.abandonedStarts.get(key) ?? 0) + 1);
      }
    };
    giveUp?.addEventListener("abort", onGiveUp, { once: true });
    try {
      return await this.openResearchSession(thread, title, modelId, giveUp);
    } finally {
      giveUp?.removeEventListener("abort", onGiveUp);
      if (abandoned) {
        const left = (this.abandonedStarts.get(key) ?? 1) - 1;
        if (left > 0) {
          this.abandonedStarts.set(key, left);
        } else {
          this.abandonedStarts.delete(key);
        }
        this.wakeStartWaiters();
      }
    }
  }

  /**
   * Returns once the host key has room for another session start: fewer than `MAX_ABANDONED_RESEARCH_STARTS` starts
   * that a run gave up on and the host has not answered. A start that finds the host full waits, and is released
   * when the host answers one of them or when its caller gives up (`giveUp`), whichever comes first; it is not sent
   * meanwhile. Callers always pass the signal, so a call without one is refused instead of waiting without end.
   */
  private async waitForStartSlot(key: string, giveUp: AbortSignal | undefined): Promise<void> {
    while ((this.abandonedStarts.get(key) ?? 0) >= MAX_ABANDONED_RESEARCH_STARTS) {
      const outstanding = this.abandonedStarts.get(key) ?? 0;
      if (this.closed) {
        throw new Error("Ancilla is shutting down.");
      }
      if (!giveUp || giveUp.aborted) {
        throw new Error(`Muse is still waiting on ${outstanding} earlier session starts on this host and has not answered them; not sending another.`);
      }
      await new Promise<void>((resolve, reject) => {
        const release = (): void => {
          this.startWaiters.delete(release);
          giveUp.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          this.startWaiters.delete(release);
          reject(new Error(`Muse is still waiting on ${outstanding} earlier session starts on this host and has not answered them; not sending another.`));
        };
        this.startWaiters.add(release);
        giveUp.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  /** Lets every start waiting for a slot look again: the count dropped, or the server is closing. */
  private wakeStartWaiters(): void {
    for (const release of [...this.startWaiters]) {
      release();
    }
  }

  private async openResearchSession(thread: ResearchThread, title: string, modelId: string | null, giveUp?: AbortSignal): Promise<WorkerSessionHandle & TurnSession> {
    const providerId = this.normalizeProviderId(thread.providerId);
    const host = await this.hostFor(thread.cwd, thread.accountId, providerId);
    // A start the host answers after the server began closing must not touch a store that is about to be closed.
    if (this.closed) {
      throw new Error("Ancilla is shutting down.");
    }
    if (giveUp?.aborted) {
      // The caller stopped waiting while the host was still coming up (a cold distro); nobody would read the answer.
      throw new Error("The research run stopped waiting for this session start.");
    }
    const workspaceRoot =
      providerId === "muse"
        ? this.hostPathFor(thread.cwd)
        : providerId === "api"
          ? await this.localRootFor(thread.cwd)
          : this.cliHostPathFor(thread.cwd, providerId);
    const started = await host.manager.startSession({
      workspaceRoot,
      ...(modelId ? { modelId } : {}),
    });
    if (this.closed) {
      throw new Error("Ancilla is shutting down.");
    }
    const project = this.store.upsertProject(thread.cwd);
    const raw = asRecord(asRecord(started.raw)?.["session"]);
    this.store.recordSession({
      id: started.sessionId,
      projectId: project.id,
      title,
      titleSource: "auto",
      origin: "research-worker",
      modelId: raw ? str(raw["modelId"]) : null,
      chosenModelId: modelId,
      createdAt: normalizeIso(raw?.["createdAt"]),
      sandboxDisabled: providerId === "muse" ? host.target.args.includes("--disable-sandbox") : null,
      providerId,
      accountId: thread.accountId,
    });
    this.store.updateSession(started.sessionId, { archived: true });
    this.rememberResearchOrigin(started.sessionId, true);
    this.sessionHosts.set(started.sessionId, host.key);
    this.liveFor(started.sessionId);
    return { sessionId: started.sessionId, manager: host.manager };
  }

  /** report.md and sources.json under `.ancilla/research/<runId>/`; the path comes back relative to the folder. */
  private async writeResearchReport(thread: ResearchThread, run: ResearchRunRecord, report: string, state: ResearchRunState): Promise<string | null> {
    if (!thread.cwd) {
      return null;
    }
    // The run's folder is new, so a plain write is enough; a rename over a file a viewer has open fails on Windows.
    const directory = await ownedProjectDir(await this.workspaceRootFor(thread.cwd), [...RESEARCH_DIR, run.id]);
    // Both names are looked at before either is written: a link planted at one must not leave the other behind.
    await assertWritableFile(directory, "report.md");
    await assertWritableFile(directory, "sources.json");
    await writeFile(join(directory, "report.md"), report, "utf8");
    await writeFile(
      join(directory, "sources.json"),
      JSON.stringify({ runId: run.id, question: run.question, registry: state.registry, curated: state.curated }, null, 2),
      "utf8",
    );
    return [...RESEARCH_DIR, run.id, "report.md"].join("/");
  }

  /**
   * Whether a session belongs to a research run (a worker or the control session). Read from the store rather
   * than from memory, so a session started before a restart is still known as one: its approvals and prompts
   * are decided by the runner and never wait on the user, and its messages never earn a title.
   */
  private isResearchSession(sessionId: string): boolean {
    return this.store.getSession(sessionId)?.origin === "research-worker";
  }

  /** The thread a run belongs to, as the adapters need it. */
  private researchThreadFor(sessionId: string): ResearchThread | null {
    const found = this.store.findSession(sessionId);
    if (!found) {
      return null;
    }
    return {
      sessionId,
      cwd: found.cwd,
      providerId: this.normalizeProviderId(found.session.providerId),
      accountId: found.session.accountId,
      modelId: found.session.chosenModelId ?? found.session.modelId,
    };
  }

  private researchViews(sessionId: string): ResearchRunView[] {
    return this.store.listResearchRuns(sessionId).map((run) => this.researchJobs.view(run, false));
  }

  /** The DeepResearch routes of section 4.5 of the plan. */
  private async routeResearch(method: string, path: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (method === "GET" && path === "/api/research-settings") {
      this.json(res, 200, this.store.getResearchSettings());
      return true;
    }
    if (method === "PATCH" && path === "/api/research-settings") {
      const body = await this.readBody(req);
      const patch: { enabled?: boolean; config?: Partial<ResearchConfig> } = {};
      if ("enabled" in body) {
        if (typeof body["enabled"] !== "boolean") {
          throw new HttpError(400, "enabled must be a boolean.");
        }
        patch.enabled = body["enabled"];
      }
      if ("config" in body) {
        const config = asRecord(body["config"]);
        if (!config) {
          throw new HttpError(400, "config must be an object.");
        }
        patch.config = config as Partial<ResearchConfig>;
      }
      this.json(res, 200, this.store.setResearchSettings(patch));
      return true;
    }
    if (method === "POST" && path === "/api/research") {
      const body = await this.readBody(req);
      const commandId = str(body["commandId"])?.trim();
      const sessionId = str(body["sessionId"]);
      const question = str(body["question"])?.trim();
      if (!commandId) {
        throw new HttpError(400, "commandId is required.");
      }
      if (!sessionId) {
        throw new HttpError(400, "sessionId is required.");
      }
      const existing = this.store.getResearchRunByCommand(commandId);
      if (existing) {
        // A repeated start is idempotent for its own thread only; the same handle on another thread is a clash.
        if (existing.sessionId !== sessionId) {
          throw new HttpError(409, `commandId ${commandId} already belongs to a research run on another session.`);
        }
        this.json(res, 200, { run: this.researchJobs.view(existing, false) });
        return true;
      }
      if (!question) {
        throw new HttpError(400, "question is required.");
      }
      if (question.length > MAX_RESEARCH_QUESTION_CHARS) {
        throw new HttpError(
          400,
          `The question is too long: ${question.length} characters, and the limit is ${MAX_RESEARCH_QUESTION_CHARS}. Shorten it, or put the material in a file in the project and point the question at it.`,
        );
      }
      const overrides = body["config"] === undefined || body["config"] === null ? null : asRecord(body["config"]);
      if (body["config"] !== undefined && body["config"] !== null && !overrides) {
        throw new HttpError(400, "config must be an object.");
      }
      const settings = this.store.getResearchSettings();
      if (!settings.enabled) {
        throw new HttpError(400, "Deep research is switched off in Settings.");
      }
      const thread = this.researchThreadFor(sessionId);
      if (!thread) {
        throw new HttpError(404, "Unknown session.");
      }
      for (const run of this.store.listResearchRuns(sessionId)) {
        if (run.status !== "queued" && run.status !== "running") {
          continue;
        }
        if (this.researchJobs.isActive(run.id)) {
          throw new HttpError(409, "This thread already has a research run in progress.");
        }
        // A row still in flight for a run nobody is running is stale: it is closed out here rather than blocking
        // the thread until the next restart would have done the same.
        this.researchJobs.markInterrupted(run, "The run was found in flight without a job running it.");
        this.log(`research: run ${run.id} was recorded in flight but not running; marked interrupted.`);
      }
      const config = resolveResearchConfig(overrides as Partial<ResearchConfig> | null, settings.config);
      const record = this.store.createResearchRun({ id: uuidv7(), sessionId, commandId, question, config, createdAt: nowIso() });
      this.store.updateSession(sessionId, { activityAt: nowIso() });
      const run = this.researchJobs.start(record, thread);
      this.json(res, 200, { run });
      return true;
    }
    if (method === "GET" && path === "/api/research") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        throw new HttpError(400, "sessionId is required.");
      }
      this.json(res, 200, { runs: this.researchViews(sessionId) });
      return true;
    }
    const exportMatch = path.match(/^\/api\/research\/([^/]+)\/export(?:\/([^/]+))?$/);
    if (exportMatch) {
      return this.routeResearchExport(method, this.segment(exportMatch[1] as string), exportMatch[2] ?? null, req, res);
    }
    const runMatch = path.match(/^\/api\/research\/([^/]+)(?:\/(events|stop|resume))?$/);
    if (!runMatch) {
      return false;
    }
    const runId = this.segment(runMatch[1] as string);
    const action = runMatch[2];
    const record = this.store.getResearchRun(runId);
    if (!record) {
      throw new HttpError(404, "Unknown research run.");
    }
    if (method === "GET" && !action) {
      this.json(res, 200, { run: this.researchJobs.view(record, true) });
      return true;
    }
    if (method === "GET" && action === "events") {
      const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "500", 10);
      const events = this.store.listResearchEvents(runId, Number.isFinite(after) && after > 0 ? after : 0, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : 500);
      this.json(res, 200, { events, nextAfter: events.length > 0 ? events[events.length - 1]!.seq : after });
      return true;
    }
    if (method === "POST" && action === "stop") {
      const body = await this.readBody(req);
      if (!this.researchJobs.stop(runId, body["writeReport"] === true) && !this.researchJobs.isActive(runId)) {
        // Nobody is running it. If the row still says it is in flight it is stale, and Stop closes it out instead of
        // answering with a row that goes on saying `running`; one that has ended is left exactly as it is. Read
        // again, after the last await: the record read before it may be a different run's by now.
        const stale = this.store.getResearchRun(runId);
        if (stale && (stale.status === "queued" || stale.status === "running")) {
          this.researchJobs.markInterrupted(stale, "The run was found in flight without a job running it.");
          this.log(`research: run ${stale.id} was stopped while recorded in flight but not running; marked interrupted.`);
        }
      }
      const current = this.store.getResearchRun(runId) ?? record;
      this.json(res, 200, { run: this.researchJobs.view(current, false) });
      return true;
    }
    if (method === "POST" && action === "resume") {
      throw new HttpError(501, "Resuming an interrupted research run is not available yet; start a new one.");
    }
    return false;
  }

  /**
   * A report's downloads. POST `/api/research/:runId/export` with `{ format }` renders report.pdf, report.docx or
   * report.html beside report.md and answers with where it went; GET `/api/research/:runId/export/report.<ext>` serves
   * that file as an attachment named after the question.
   */
  private async routeResearchExport(method: string, runId: string, name: string | null, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const run = this.store.getResearchRun(runId);
    if (!run) {
      throw new HttpError(404, "Unknown research run.");
    }
    const thread = this.researchThreadFor(run.sessionId);
    if (method === "POST" && name === null) {
      const body = await this.readBody(req);
      const format = body["format"];
      if (!isExportFormat(format)) {
        throw new HttpError(400, "format must be pdf, docx or html.");
      }
      if (!run.report || !run.report.trim()) {
        throw new HttpError(409, "The run has no report to export.");
      }
      const file = await renderReport(format, run.report, { question: run.question, endedAt: run.endedAt });
      if (!thread?.cwd) {
        throw new HttpError(409, "This thread has no project folder to save into.");
      }
      const fileName = exportFileName(format);
      const directory = await ownedProjectDir(await this.workspaceRootFor(thread.cwd), [...RESEARCH_DIR, run.id]);
      await assertWritableFile(directory, fileName);
      await writeFile(join(directory, fileName), file);
      const relative = [...RESEARCH_DIR, run.id, fileName].join("/");
      this.json(res, 200, { path: relative, name: fileName, size: file.length, url: `/api/research/${encodeURIComponent(run.id)}/export/${fileName}` });
      return true;
    }
    if ((method === "GET" || method === "HEAD") && name !== null) {
      const format = exportFormatOfName(name);
      if (!format) {
        throw new HttpError(404, "Unknown export file.");
      }
      if (!thread?.cwd) {
        throw new HttpError(404, "That export has not been generated yet.");
      }
      // resolveInRoot answers 404 for a file not generated yet, and refuses anything that leaves the folder.
      const { abs } = await resolveInRoot(await this.localRootFor(thread.cwd), [...RESEARCH_DIR, run.id, name].join("/"), thread.cwd);
      await serveExportFile(req, res, abs, format, `${questionSlug(run.question)}.${format}`);
      return true;
    }
    return false;
  }

  private async managerForSession(targetSessionId: string): Promise<SessionManager> {
    const managedHostInstance = await this.hostForSession(targetSessionId);
    return managedHostInstance.manager;
  }

  private async runningHostOf(accountId: string, providerId: ProviderId = "muse"): Promise<ManagedHost | null> {
    await this.restartChain;
    const activeHosts = () =>
      [...this.hosts.values()].filter((h) => h.providerId === providerId && h.accountId === accountId);
    if (activeHosts().length === 0) {
      return null;
    }
    if (providerId === "muse") {
      try {
        await this.profiles.getProfile(accountId);
      } catch (profileErr) {
        throw this.accountError(profileErr);
      }
    } else if (!this.store.getProviderAccount(accountId)) {
      throw new HttpError(400, `Unknown provider account "${accountId}".`);
    }

    const currentActive = activeHosts();
    const defaultHostKey = this.hostKey("", accountId, providerId);
    return currentActive.find((h) => h.key === defaultHostKey) ?? currentActive[0] ?? null;
  }

  private async hostForSession(targetSessionId: string): Promise<ManagedHost> {
    const existingKey = this.sessionHosts.get(targetSessionId);
    const loadedHost = existingKey ? this.hosts.get(existingKey) : undefined;
    if (loadedHost) {
      return loadedHost;
    }
    const sessionMatch = this.store.findSession(targetSessionId);
    const resolvedProvider = this.normalizeProviderId(sessionMatch?.session.providerId);
    const hostPosture: HostPosture =
      resolvedProvider === "muse" && sessionMatch?.session.hostPosture === "voice" ? "voice" : "coding";
    return this.hostFor(
      sessionMatch?.cwd ?? "",
      sessionMatch?.session.accountId ?? null,
      resolvedProvider,
      hostPosture,
    );
  }

  private mayLoadUnloaded(targetSessionId: string, candidateHost: ManagedHost): boolean {
    const mappedHostKey = this.sessionHosts.get(targetSessionId);
    if (mappedHostKey !== undefined && mappedHostKey !== candidateHost.key && this.hosts.has(mappedHostKey)) {
      const hostMismatched = false;
      return hostMismatched;
    }
    return !this.isBusy(targetSessionId);
  }

  private async hostFor(
    workspaceCwd: string,
    targetAccountId: string | null = null,
    targetProviderId: ProviderId = "muse",
    targetPosture: HostPosture = "coding",
  ): Promise<ManagedHost> {
    const effectivePosture: HostPosture = targetProviderId === "muse" ? targetPosture : "coding";
    if (targetProviderId === "muse") {
      await this.ensureLinuxMuseStorage(targetAccountId);
      await this.museRuntime();
    }

    if (this.restartChain) {
      await this.restartChain;
    }

    if (this.closed) {
      throw new HttpError(503, "Ancilla is shutting down.");
    }

    const hostRegistrationKey = this.hostKey(workspaceCwd, targetAccountId, targetProviderId, effectivePosture);
    const currentHost = this.hosts.get(hostRegistrationKey);
    if (currentHost) {
      return currentHost;
    }

    const existingStartup = this.starting.get(hostRegistrationKey);
    if (existingStartup) {
      return existingStartup;
    }

    const lifecycleToken: StartToken = { handle: null, abandoned: false, closing: false };
    const startupPromise =
      targetProviderId === "muse"
        ? this.spawnHost(hostRegistrationKey, workspaceCwd, targetAccountId, lifecycleToken, effectivePosture)
        : this.spawnProviderHost(hostRegistrationKey, workspaceCwd, targetAccountId, targetProviderId, lifecycleToken);

    this.starting.set(hostRegistrationKey, startupPromise);
    this.startTokens.set(hostRegistrationKey, lifecycleToken);
    try {
      return await startupPromise;
    } finally {
      if (this.starting.get(hostRegistrationKey) === startupPromise) {
        this.starting.delete(hostRegistrationKey);
      }
      if (this.startTokens.get(hostRegistrationKey) === lifecycleToken) {
        this.startTokens.delete(hostRegistrationKey);
      }
    }
  }

  private async spawnHost(
    hostKeyStr: string,
    workspaceCwd: string,
    profileAccountId: string | null,
    startTokenObj: StartToken,
    hostPosture: HostPosture = "coding",
  ): Promise<ManagedHost> {
    const quotaGen = profileAccountId ? this.quotaAccountGenerations.get(profileAccountId) ?? 0 : 0;
    const voiceFlagsActive = hostPosture === "voice" && !this.voiceExtraFlagsUnsupported;
    let serveTargetConfig = await this.serveTargetFor(workspaceCwd, profileAccountId, hostPosture, !voiceFlagsActive);
    if (profileAccountId) {
      this.removedQuotaAccounts.delete(profileAccountId);
    }

    let quotaScopeVal = await this.quotaCacheScope(profileAccountId);
    if (!quotaScopeVal && (await this.readsWslLogin(profileAccountId))) {
      this.wslHomes.forgetFailure(this.wslDistro());
      quotaScopeVal = await this.quotaCacheScope(profileAccountId);
    }

    this.assertStartWanted(startTokenObj);
    let hostProcessHandle = this.options.hostFactory(serveTargetConfig);
    startTokenObj.handle = hostProcessHandle;

    let initResultData: { fingerprintWarning?: unknown; initializeResult?: unknown } | null;
    try {
      initResultData = (await hostProcessHandle.start(ANCILLA_VERSION)) as typeof initResultData;
    } catch (startErr) {
      if (
        hostPosture === "voice" &&
        voiceFlagsActive &&
        !(startErr instanceof HostStartTimeoutError) &&
        !startTokenObj.abandoned &&
        !this.closed
      ) {
        startTokenObj.handle = null;
        closeInBackground(hostProcessHandle);
        const errMsg = startErr instanceof Error ? startErr.message : String(startErr);
        this.log(`voice host rejected extended CLI flags (${errMsg}); retrying with degraded voice flags`);

        serveTargetConfig = await this.serveTargetFor(workspaceCwd, profileAccountId, hostPosture, true);
        this.assertStartWanted(startTokenObj);
        hostProcessHandle = this.options.hostFactory(serveTargetConfig);
        startTokenObj.handle = hostProcessHandle;
        try {
          initResultData = (await hostProcessHandle.start(ANCILLA_VERSION)) as typeof initResultData;
          this.voiceExtraFlagsUnsupported = true;
        } catch (degradedErr) {
          if (!startTokenObj.closing) {
            startTokenObj.closing = true;
            closeInBackground(hostProcessHandle);
          }
          this.assertStartWanted(startTokenObj);
          this.lastHostError = degradedErr instanceof Error ? degradedErr.message : String(degradedErr);
          this.emit("ancilla", { type: "host", key: hostKeyStr, state: "failed", message: this.lastHostError });
          if (degradedErr instanceof HostStartTimeoutError) {
            throw new HttpError(
              504,
              `Could not start Muse: ${this.lastHostError} The limit is ${HOST_START_TIMEOUT_ENV} (or "hostStartTimeoutMs" in runtime.json), in milliseconds; 0 turns it off.`,
            );
          }
          throw new HttpError(502, `Could not start Muse: ${this.lastHostError}`);
        }
      } else {
        this.assertStartWanted(startTokenObj);
        this.lastHostError = startErr instanceof Error ? startErr.message : String(startErr);
        this.emit("ancilla", { type: "host", key: hostKeyStr, state: "failed", message: this.lastHostError });
        if (startErr instanceof HostStartTimeoutError) {
          throw new HttpError(
            504,
            `Could not start Muse: ${this.lastHostError} The limit is ${HOST_START_TIMEOUT_ENV} (or "hostStartTimeoutMs" in runtime.json), in milliseconds; 0 turns it off.`,
          );
        }
        throw new HttpError(502, `Could not start Muse: ${this.lastHostError}`);
      }
    }

    if (startTokenObj.abandoned || this.closed) {
      if (!startTokenObj.closing) {
        startTokenObj.closing = true;
        closeInBackground(hostProcessHandle);
      }
      this.assertStartWanted(startTokenObj);
    }

    this.lastHostError = null;
    this.fingerprints.set(hostKeyStr, initResultData?.fingerprintWarning ?? null);

    const sessionManagerInstance = new SessionManager(hostProcessHandle.connection, {
      providerId: "muse",
      capabilities: hostProcessHandle.capabilities ?? capabilitiesForProvider("muse"),
    });

    sessionManagerInstance.onNotification((notif) => {
      if (notif.method === "usage/changed" && this.hosts.get(hostKeyStr)?.handle !== hostProcessHandle) {
        return;
      }
      this.forward(hostKeyStr, notif, hostProcessHandle);
    });

    const hasProtocolReporter = sessionManagerInstance.onProtocolError((protoErr) => {
      this.protocolErrors += 1;
      this.lastProtocolError = protoErr instanceof Error ? protoErr.message : String(protoErr);
      this.log(`protocol error on host ${hostKeyStr}: ${this.lastProtocolError}`);
    });
    if (!hasProtocolReporter) {
      this.log(`host ${hostKeyStr} cannot report protocol errors; dropped frames stay invisible`);
    }

    const initRecordObj = asRecord(initResultData?.initializeResult);
    const serverDetails = asRecord(initRecordObj?.["serverInfo"]);
    const managedHostRecord: ManagedHost = {
      quotaCacheScope: quotaScopeVal,
      quotaAccountGeneration: quotaGen,
      key: hostKeyStr,
      providerId: "muse",
      accountId: profileAccountId,
      target: serveTargetConfig,
      handle: hostProcessHandle,
      manager: sessionManagerInstance,
      serverVersion: serverDetails ? str(serverDetails["version"]) : null,
      museHome: str(initRecordObj?.["museHome"]),
      startedAt: nowIso(),
    };

    hostProcessHandle.onExit?.((exitData) => this.hostExited(managedHostRecord, exitData));
    this.hosts.set(hostKeyStr, managedHostRecord);
    return managedHostRecord;
  }

  private assertStartWanted(tokenCandidate: StartToken): void {
    if (this.closed) {
      throw new HttpError(503, "Ancilla is shutting down.");
    }
    if (tokenCandidate.abandoned) {
      throw new HttpError(503, "The Muse host was restarted while it was starting. Try again.");
    }
  }

  private hostExited(managedHostInst: ManagedHost, exitInfo: HostExit): void {
    if (this.hosts.get(managedHostInst.key) !== managedHostInst) {
      return;
    }
    const providerName =
      managedHostInst.providerId === "muse" ? "Muse" : descriptorForProvider(managedHostInst.providerId).displayName;
    const stderrTail = managedHostInst.handle.recentStderr?.trim();
    const exitMsg =
      exitInfo.reason === "connection-ended"
        ? `The connection to the ${providerName} host ended while the host was still running, so it was closed.${stderrTail ? ` ${stderrTail}` : ""}`
        : `The ${providerName} host exited (${exitInfo.code ?? exitInfo.signal ?? "unknown"}).${stderrTail ? ` ${stderrTail}` : ""}`;

    this.hostExits += 1;
    this.lastHostExitAt = nowIso();
    this.lastHostError = exitMsg;
    this.emit("ancilla", { type: "host", key: managedHostInst.key, state: "exited", message: exitMsg });
    this.forgetHost(managedHostInst, exitMsg);
  }

  private forgetHost(managedHostInst: ManagedHost, terminationReason: string): void {
    this.hosts.delete(managedHostInst.key);
    const affectedSessionIds = new Set<string>();

    for (const [sId, hKey] of this.sessionHosts) {
      if (hKey !== managedHostInst.key) {
        continue;
      }
      this.sessionHosts.delete(sId);
      this.effortApplied.delete(sId);
      this.approvalModeApplied.delete(sId);
      this.modelTrials.delete(sId);
      affectedSessionIds.add(sId);
    }

    for (const [sId, liveStateObj] of this.live) {
      if (liveStateObj.turnHost === managedHostInst.key) {
        affectedSessionIds.add(sId);
      }
    }

    for (const sId of affectedSessionIds) {
      const activeLive = this.live.get(sId);
      if (!activeLive) {
        continue;
      }
      activeLive.activityRevision += 1;
      if (activeLive.turnHost === managedHostInst.key) {
        activeLive.turnHost = null;
      }
      if (activeLive.activeTurnId || activeLive.pendingApprovals.size || activeLive.pendingInputs.size) {
        const terminatedTurnId = activeLive.activeTurnId;
        activeLive.activeTurnId = null;
        activeLive.turnStartedAt = null;
        activeLive.turnHost = null;
        activeLive.pendingApprovals.clear();
        activeLive.pendingInputs.clear();
        activeLive.lastTerminal = "failed";
        activeLive.lastError = terminationReason;
        if (terminatedTurnId) {
          this.recordTurnEnd(sId, terminatedTurnId, "failed");
        }
        this.emitStatus(sId);
      }
    }

    for (const sId of affectedSessionIds) {
      this.notifySessionClosed(sId, terminationReason);
    }
  }

  private notifySessionClosed(targetSessionId: string, closureReason: string): void {
    const activeListeners = this.sessionListeners.get(targetSessionId);
    if (!activeListeners) {
      return;
    }
    for (const listenerFn of [...activeListeners]) {
      try {
        listenerFn("session/closed", { sessionId: targetSessionId, reason: "hostGone", message: closureReason });
      } catch (listenerErr) {
        const errDetail = listenerErr instanceof Error ? listenerErr.message : String(listenerErr);
        this.log(`session listener (session/closed) threw: ${errDetail}`);
      }
    }
  }

  private async restartHosts(notificationMessage = "The Muse host restarted to apply a settings change."): Promise<void> {
    await this.settleStarts();
    await Promise.all(
      [...this.hosts.values()].map(async (managed) => {
        await this.closeHost(managed);
        this.forgetHost(managed, notificationMessage);
        this.emit("ancilla", { type: "host", key: managed.key, state: "restarted", message: notificationMessage });
      }),
    );
  }

  private async accountList(): Promise<Record<string, unknown>[]> {
    const profileRecords = await this.profiles.listProfiles();
    const accountListPromises = profileRecords.map(async (prof) => {
      const accountIdentity = await this.profiles.identityOf(prof);
      const accountInfo = {
        id: prof.id,
        name: prof.name,
        hasLogin: accountIdentity.hasLogin,
        email: accountIdentity.email,
        lastUsedAt: prof.lastUsedAt,
      };
      return accountInfo;
    });
    return await Promise.all(accountListPromises);
  }

  private async defaultLoginIdentity(): Promise<{ hasLogin: boolean | null; email: string | null }> {
    if (process.env["MUSE_AUTH_PATH"]) {
      return { hasLogin: null, email: null };
    }
    if ((await this.museRuntime()) === "wsl") {
      return this.wslLoginIdentity();
    }
    try {
      const defaultProf = {
        id: "default",
        name: "Default login",
        createdAt: "",
        lastUsedAt: null,
        roots: {
          config: process.env["XDG_CONFIG_HOME"] || join(this.options.home, ".config"),
          data: "",
        },
      };
      const ident = await this.profiles.identityOf(defaultProf);
      return {
        hasLogin: ident.hasLogin ? true : this.options.platform === "darwin" ? null : false,
        email: ident.email,
      };
    } catch {
      return { hasLogin: null, email: null };
    }
  }

  private async wslLoginIdentity(): Promise<{ hasLogin: boolean | null; email: string | null }> {
    const unknownIdentity = { hasLogin: null, email: null };
    if (!(await this.readsWslLogin(null))) {
      return unknownIdentity;
    }
    return this.wslUnit(
      "identity",
      async () => {
        try {
          const authFilePath = await this.wslQuotaAuthPath(null);
          return authFilePath ? (await loginIdentity(authFilePath)) ?? unknownIdentity : unknownIdentity;
        } catch {
          return unknownIdentity;
        }
      },
      () => unknownIdentity,
    );
  }

  private accountError(err: unknown): HttpError {
    if (err instanceof ProfileError) {
      if (err.code === "profile_exists") {
        return new HttpError(409, err.message);
      }
      return new HttpError(400, err.message);
    }
    return new HttpError(500, err instanceof Error ? err.message : String(err));
  }

  private async runLogin(
    profileIdStr: string,
    targetProfile: Profile | null,
    startGeneration: number,
  ): Promise<{ url: string; code: string | null; loginId: string }> {
    await this.ensureLinuxMuseStorage(targetProfile?.id ?? null);
    const plannedLoginCmd = targetProfile
      ? this.profiles.loginCommand(targetProfile)
      : { command: "muse", args: ["login"], env: {} };
    const runtimePref = await this.museRuntime();
    const resolvedMuseBinary =
      plannedLoginCmd.command === "muse"
        ? (await this.cliMusePath()) ?? plannedLoginCmd.command
        : plannedLoginCmd.command;

    const plannedCli = planMuseCli({
      platform: this.options.platform,
      runtime: runtimePref,
      distro: this.wslDistro(),
      musePath: resolvedMuseBinary,
      args: plannedLoginCmd.args,
    });

    const loginEnvVars: Record<string, string> =
      this.options.platform === "win32" && runtimePref === "wsl"
        ? wslSpawnEnv(
            { ...process.env, ...plannedLoginCmd.env },
            this.wslEnvWithout(plannedLoginCmd.env),
            targetProfile ? PROFILE_WSLENV : [],
          )
        : Object.fromEntries(
            Object.entries({ ...process.env, ...plannedLoginCmd.env }).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          );

    if (this.options.platform === "linux") {
      loginEnvVars["HOME"] = this.options.home;
    }

    if (this.closed || this.loginStartGenerations.get(profileIdStr) !== startGeneration) {
      throw new HttpError(409, "A newer sign-in request replaced this one. Use the latest sign-in code.");
    }

    const runningChild = this.loginChildren.get(profileIdStr);
    if (runningChild) {
      runningChild.kill();
      this.loginChildren.delete(profileIdStr);
    }

    if (runtimePref === "native") {
      const relInfo = this.releaseInfoFor(resolvedMuseBinary);
      if (relInfo) {
        loginEnvVars["MUSE_RELEASE_INFO"] = relInfo;
      }
    }

    const attemptState = {
      loginId: randomUUID(),
      status: "waiting" as "waiting" | "done" | "error",
      message: undefined as string | undefined,
    };
    this.loginAttempts.set(profileIdStr, attemptState);

    let spawnedChild: LoginChild;
    try {
      spawnedChild = this.options.loginSpawn(plannedCli.command, plannedCli.args, { env: loginEnvVars });
    } catch {
      attemptState.status = "error";
      attemptState.message =
        "Muse could not start sign-in. Check that Muse is installed in the selected runtime, then try again.";
      throw new HttpError(503, attemptState.message);
    }

    this.loginChildren.set(profileIdStr, spawnedChild);

    return new Promise((resolvePromise, rejectPromise) => {
      let isSettled = false;
      let outputBuffer = "";
      let postCompletionTimer: ReturnType<typeof setTimeout> | null = null;

      const markFailure = (failureDetail: string) => {
        if (attemptState.status === "waiting") {
          attemptState.status = "error";
          attemptState.message = failureDetail;
        }
      };

      const loginTimeoutTimer = setTimeout(() => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        markFailure("Muse did not provide a sign-in link within 30 seconds. Check your connection, then try again.");
        spawnedChild.kill();
        if (this.loginChildren.get(profileIdStr) === spawnedChild) {
          this.loginChildren.delete(profileIdStr);
        }
        rejectPromise(new HttpError(504, attemptState.message as string));
      }, LOGIN_TIMEOUT_MS);

      const handleDataChunk = (chunkData: unknown) => {
        if (isSettled) {
          return;
        }
        outputBuffer = (outputBuffer + String(chunkData)).slice(-32_768);
        const parsedResult = parseLoginOutput(outputBuffer);
        if (parsedResult.url) {
          isSettled = true;
          clearTimeout(loginTimeoutTimer);
          postCompletionTimer = setTimeout(() => {
            if (this.loginChildren.get(profileIdStr) === spawnedChild) {
              spawnedChild.kill();
              this.loginChildren.delete(profileIdStr);
            }
          }, LOGIN_COMPLETE_TIMEOUT_MS);
          postCompletionTimer.unref();
          resolvePromise({
            url: parsedResult.url,
            code: parsedResult.code,
            loginId: attemptState.loginId,
          });
        }
      };

      spawnedChild.stdout.on("data", handleDataChunk);
      spawnedChild.stderr.on("data", handleDataChunk);

      spawnedChild.on("close", (exitCodeNum) => {
        if (postCompletionTimer) {
          clearTimeout(postCompletionTimer);
        }
        clearTimeout(loginTimeoutTimer);
        if (this.loginChildren.get(profileIdStr) === spawnedChild) {
          this.loginChildren.delete(profileIdStr);
        }
        if (isSettled && exitCodeNum === 0 && attemptState.status === "waiting") {
          attemptState.status = "done";
          void this.onLoginCompleted("muse", targetProfile?.id ?? null);
        } else {
          markFailure(
            "Muse ended sign-in before it was confirmed. Start again and approve the new code in your browser.",
          );
        }
        if (!isSettled) {
          isSettled = true;
          rejectPromise(new HttpError(504, attemptState.message ?? "Muse did not return a sign-in link."));
        }
      });

      spawnedChild.on("error", () => {
        if (postCompletionTimer) {
          clearTimeout(postCompletionTimer);
        }
        clearTimeout(loginTimeoutTimer);
        if (this.loginChildren.get(profileIdStr) === spawnedChild) {
          this.loginChildren.delete(profileIdStr);
        }
        markFailure("Muse process could not be run. Check that Muse is installed, then try again.");
        if (!isSettled) {
          isSettled = true;
          rejectPromise(new HttpError(503, attemptState.message as string));
        }
      });
    });
  }

  private async serveTargetFor(
    workspaceDir: string,
    profileAccountId: string | null = null,
    hostPosture: HostPosture = "coding",
    degradeVoiceFlags = false,
  ): Promise<ServeTarget> {
    let profileEnvMap: Record<string, string> | null = null;
    if (profileAccountId) {
      let prof;
      try {
        prof = await this.profiles.getProfile(profileAccountId);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : `Unknown account "${profileAccountId}".`);
      }
      profileEnvMap = this.profiles.envFor(prof);
    }

    const sandboxIsDisabled = Boolean(this.store.getSandboxSettings().disabled);
    const yoloEnabled = hostPosture === "voice" ? false : this.store.getYoloSettings().enabled;
    const extraArgsList: readonly string[] =
      hostPosture === "voice" && !degradeVoiceFlags && !this.voiceExtraFlagsUnsupported
        ? [
            "--preset",
            "empty",
            "--disable-write",
            "--disable-shell",
            "--disable-request-user-input",
            "-c",
            'runtime_capabilities={"plugin:tbh-reminders:reminder:memory-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:skill-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:goal-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:todo-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:scope-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:verify-reminder":{"enabled":false}}',
          ]
        : [];

    const constructedServeArgs = [
      "serve",
      ...(sandboxIsDisabled || yoloEnabled ? ["--disable-sandbox"] : []),
      ...(yoloEnabled ? ["--trust-workspace"] : []),
      ...extraArgsList,
    ];

    const isNonWinPlatform = this.options.platform !== "win32";
    if (isNonWinPlatform) {
      const nonWinConfig = {
        command: (await this.cliMusePath()) ?? "muse",
        args: constructedServeArgs,
        cwd: workspaceDir || process.cwd(),
        ...(profileEnvMap || this.options.platform === "linux"
          ? { env: { ...process.env, HOME: this.options.home, ...(profileEnvMap ?? {}) } }
          : {}),
      };
      return nonWinConfig;
    }

    const activeRuntime = await this.museRuntime();
    let museBinaryPath = this.options.musePath ?? null;
    if (!museBinaryPath || (!museBinaryPath.includes("/") && !museBinaryPath.includes("\\"))) {
      const probeResult = await this.environment(false);
      museBinaryPath = probeResult.musePath;
    }

    if (activeRuntime === "native") {
      if (!museBinaryPath) {
        throw new HttpError(
          503,
          "Muse for Windows is not installed. Install it from PowerShell: irm https://dev.meta.ai/install.ps1 | iex",
        );
      }
      const releaseInfoString = this.releaseInfoFor(museBinaryPath);
      const winNativeConfig = {
        command: museBinaryPath,
        args: constructedServeArgs,
        cwd: this.spawnCwdFor(workspaceDir) || process.cwd(),
        ...(releaseInfoString || profileEnvMap
          ? {
              env: {
                ...process.env,
                ...(releaseInfoString ? { MUSE_RELEASE_INFO: releaseInfoString } : {}),
                ...(profileEnvMap ?? {}),
              },
            }
          : {}),
      };
      return winNativeConfig;
    }

    const targetWslDistroName = this.wslDistro();
    const plannedServeObj = planServe({
      platform: "win32",
      distro: targetWslDistroName,
      musePath: museBinaryPath,
      cwd: this.spawnCwdFor(workspaceDir),
      sandboxDisabled: sandboxIsDisabled,
      yoloEnabled,
      ...(extraArgsList.length > 0 ? { extraServeArgs: extraArgsList } : {}),
    });

    const wslEnvVars = profileEnvMap ? this.wslEnvFor(profileEnvMap, PROFILE_WSLENV) : this.wslEnvFor();
    return {
      command: plannedServeObj.command,
      args: plannedServeObj.args,
      cwd: plannedServeObj.cwd,
      ...(wslEnvVars ? { env: wslEnvVars } : {}),
    };
  }

  private releaseInfoFor(binaryPath: string): string | null {
    const matchedVersion = /muse-bin-(.+)\.exe$/i.exec(win32.basename(binaryPath))?.[1] ?? null;
    return matchedVersion
      ? nativeReleaseInfo({ binary: binaryPath, dir: win32.dirname(binaryPath), version: matchedVersion, launcher: null })
      : null;
  }
  private forward(
    hostIdentifier: string,
    rawNotice: { method: string; params?: unknown; emittedAtMs?: number },
    originHandle?: HostHandle,
  ): void {
    if (this.storeClosed) {
      return;
    }
    try {
      const isRetiredHost = originHandle !== undefined && this.hosts.get(hostIdentifier)?.handle !== originHandle;
      const payloadMap = asRecord(rawNotice.params) ?? {};

      if (rawNotice.method === "usage/changed") {
        const parsedUsage = parseSubscriptionUsage(payloadMap);
        const hostEntry = this.hosts.get(hostIdentifier);
        if (!hostEntry) {
          return;
        }

        if (hostEntry.providerId !== "muse") {
          if (parsedUsage) {
            const providerCompositeKey = `${hostEntry.providerId}::${hostEntry.accountId ?? "default"}`;
            this.providerUsageByKey.set(providerCompositeKey, parsedUsage);
            if (hostEntry.quotaCacheScope) {
              this.store.setSubscriptionUsage(hostEntry.quotaCacheScope, parsedUsage);
            }
            this.emit("ancilla", {
              type: "provider-usage",
              providerId: hostEntry.providerId,
              accountId: hostEntry.accountId,
              usage: parsedUsage,
            });
          }
          return;
        }

        if (!this.isCurrentQuotaHost(hostEntry)) {
          return;
        }

        const quotaAccount = hostEntry.accountId;
        if (!this.quotaScopes.has(quotaAccount) || this.quotaScopes.get(quotaAccount) === hostEntry.quotaCacheScope) {
          this.observeUsage(parsedUsage, quotaAccount, "runtime", hostEntry.quotaCacheScope);
        }
        return;
      }

      const wireEvent = toWireEvent(rawNotice.method, payloadMap, rawNotice.emittedAtMs);
      if (!wireEvent) {
        const previousDropCount = this.unroutedByMethod.get(rawNotice.method) ?? 0;
        this.unroutedByMethod.set(rawNotice.method, previousDropCount + 1);
        return;
      }

      if (!isRetiredHost) {
        this.sessionHosts.set(wireEvent.sessionId, hostIdentifier);
      }

      this.noteNotification(wireEvent.sessionId, rawNotice.method);

      const activeSessionListeners = this.sessionListeners.get(wireEvent.sessionId);
      if (activeSessionListeners) {
        for (const sessionCallback of [...activeSessionListeners]) {
          try {
            sessionCallback(rawNotice.method, payloadMap);
          } catch (callbackErr) {
            const failureDetail = callbackErr instanceof Error ? callbackErr.message : String(callbackErr);
            this.log(`session listener (${rawNotice.method}) threw: ${failureDetail}`);
          }
        }
      }

      this.track(wireEvent.sessionId, rawNotice.method, payloadMap, hostIdentifier, isRetiredHost);
      this.emit("ancilla", wireEvent);
    } catch (forwardErr) {
      this.forwardFailures += 1;
      const errDescription = forwardErr instanceof Error ? forwardErr.message : String(forwardErr);
      this.lastForwardFailure = `${rawNotice.method}: ${errDescription}`;
      this.log(`forward(${rawNotice.method}) threw: ${this.lastForwardFailure}`);
    }
  }

  /**
   * Tracks inbound telemetry heartbeat timestamps and frequency per method per session.
   */
  private noteNotification(sessionIdentifier: string, methodName: string): void {
    let telemetryRecord = this.notifyStats.get(sessionIdentifier);
    if (!telemetryRecord) {
      const statsLimitReached = this.notifyStats.size >= NOTIFY_STATS_LIMIT;
      if (statsLimitReached) {
        const oldestEntry = this.notifyStats.keys().next();
        if (!oldestEntry.done) {
          this.notifyStats.delete(oldestEntry.value);
        }
      }
      telemetryRecord = { lastAt: 0, count: 0, byMethod: {} };
      this.notifyStats.set(sessionIdentifier, telemetryRecord);
    }
    telemetryRecord.lastAt = Date.now();
    telemetryRecord.count += 1;
    telemetryRecord.byMethod[methodName] = (telemetryRecord.byMethod[methodName] ?? 0) + 1;
  }

  /**
   * Diagnostic log to process.stderr with UTC timestamp and prefix.
   */
  private log(logMessage: string): void {
    process.stderr.write(`[ancilla] ${new Date().toISOString()} ${logMessage}\n`);
  }

  /**
   * Central telemetry tracker updating live in-memory session states from Muse notification events.
   */
  private track(
    sessionIdentifier: string,
    eventName: string,
    payload: Record<string, unknown>,
    hostIdentifier: string | null = null,
    isRetiredHost = false,
  ): void {
    const liveSession = this.liveFor(sessionIdentifier);

    if (eventName === "turn/started") {
      const prospectiveTurnId = str(payload["turnId"]);
      if (isRetiredHost || (prospectiveTurnId !== null && this.turnFinished(sessionIdentifier, prospectiveTurnId))) {
        return;
      }
    }

    if (
      eventName === "approval/requested" ||
      eventName === "approval/resolved" ||
      eventName === "userInput/requested" ||
      eventName === "userInput/settled" ||
      eventName === "session/statusChanged"
    ) {
      liveSession.activityRevision += 1;
    }

    let hasStateChanged = false;
    const itemRecord = asRecord(payload["item"]);
    const candidateTurnId = str(itemRecord?.["turnId"]) ?? str(payload["turnId"]);
    const isProgressForActiveTurn =
      candidateTurnId !== null &&
      (candidateTurnId === liveSession.activeTurnId ||
        (eventName === "turn/started" && liveSession.activeTurnId === null));

    const hasDurableCoordinates = str(payload["viewCursor"]) !== null && asRecord(payload["sourceRange"]) !== null;
    const isDurableTurnOrItemProgress =
      isProgressForActiveTurn &&
      hasDurableCoordinates &&
      (eventName === "turn/started" ||
        eventName === "turn/completed" ||
        ((eventName === "item/started" || eventName === "item/updated" || eventName === "item/completed") &&
          str(itemRecord?.["itemId"]) !== null));

    if (isDurableTurnOrItemProgress) {
      liveSession.activityRevision += 1;
      if (liveSession.viewHealth !== null) {
        liveSession.viewHealth = null;
        hasStateChanged = true;
      }
    } else if (
      hasDurableCoordinates &&
      liveSession.activeTurnId === null &&
      liveSession.viewHealth !== null &&
      eventName !== "session/viewHealthChanged"
    ) {
      liveSession.activityRevision += 1;
      liveSession.viewHealth = null;
      hasStateChanged = true;
    }

    if (eventName === "turn/completed" || eventName === "item/completed" || eventName === "item/updated") {
      this.noteRenameBreakage(hostIdentifier, payload);
    }

    switch (eventName) {
      case "turn/started": {
        liveSession.activityRevision += 1;
        liveSession.activeTurnId = str(payload["turnId"]);
        liveSession.turnStartedAt = nowIso();
        liveSession.turnHost = hostIdentifier;
        liveSession.lastError = null;
        liveSession.lastTerminal = null;
        hasStateChanged = true;

        const currentTurnIdentifier = str(payload["turnId"]);
        if (currentTurnIdentifier) {
          this.recordTurnStart(sessionIdentifier, currentTurnIdentifier);
        }
        this.wake(sessionIdentifier);
        break;
      }

      case "turn/completed": {
        liveSession.activityRevision += 1;
        const finishedTurnId = str(payload["turnId"]);
        const terminalStatus = str(payload["terminal"]) ?? "completed";
        const isForeignTurnCompletion =
          liveSession.activeTurnId !== null && liveSession.activeTurnId !== finishedTurnId;

        if (!isForeignTurnCompletion) {
          liveSession.activeTurnId = null;
          liveSession.turnStartedAt = null;
          liveSession.turnHost = null;
          liveSession.lastTerminal = terminalStatus;
          liveSession.lastError =
            terminalStatus === "failed"
              ? (str(asRecord(payload["error"])?.["message"]) ?? "The turn failed.")
              : null;
          hasStateChanged = true;
        }

        if (finishedTurnId) {
          this.recordTurnEnd(sessionIdentifier, finishedTurnId, terminalStatus);
        }

        if (!this.isResearchSession(sessionIdentifier)) {
          this.notifySessionsChange();
        }
        break;
      }

      case "session/viewHealthChanged": {
        if (payload["health"] === "unavailable") {
          liveSession.activityRevision += 1;
          liveSession.viewHealth = { status: "unavailable", reason: str(payload["noneReason"]) };
          hasStateChanged = true;
        } else if (liveSession.viewHealth !== null) {
          liveSession.activityRevision += 1;
          liveSession.viewHealth = null;
          hasStateChanged = true;
        }
        break;
      }

      case "approval/requested": {
        const pendingApprovalId = str(payload["approvalId"]);
        if (
          pendingApprovalId &&
          !liveSession.pendingApprovals.has(pendingApprovalId) &&
          !this.isResearchSession(sessionIdentifier)
        ) {
          liveSession.pendingApprovals.add(pendingApprovalId);
          hasStateChanged = true;
          this.wake(sessionIdentifier);
        }
        break;
      }

      case "approval/resolved": {
        const resolvedApprovalId = str(payload["approvalId"]);
        if (resolvedApprovalId) {
          this.authorizationHub?.cancel(`muse_${resolvedApprovalId}`);
        }
        hasStateChanged = resolvedApprovalId ? liveSession.pendingApprovals.delete(resolvedApprovalId) : false;
        break;
      }

      case "userInput/requested": {
        const requestedInputId = str(payload["userInputId"]);
        if (
          requestedInputId &&
          !liveSession.pendingInputs.has(requestedInputId) &&
          !this.isResearchSession(sessionIdentifier)
        ) {
          liveSession.pendingInputs.add(requestedInputId);
          hasStateChanged = true;
          this.wake(sessionIdentifier);
        }
        break;
      }

      case "userInput/settled": {
        const settledInputId = str(payload["userInputId"]);
        hasStateChanged = settledInputId ? liveSession.pendingInputs.delete(settledInputId) : false;
        break;
      }

      case "session/closed": {
        if (isRetiredHost) {
          break;
        }
        liveSession.activityRevision += 1;
        hasStateChanged =
          liveSession.activeTurnId !== null ||
          liveSession.pendingApprovals.size > 0 ||
          liveSession.pendingInputs.size > 0;

        liveSession.activeTurnId = null;
        liveSession.turnStartedAt = null;
        liveSession.turnHost = null;
        liveSession.pendingApprovals.clear();
        liveSession.pendingInputs.clear();
        this.sessionHosts.delete(sessionIdentifier);
        this.effortApplied.delete(sessionIdentifier);
        this.approvalModeApplied.delete(sessionIdentifier);
        this.modelTrials.delete(sessionIdentifier);
        break;
      }

      case "session/modelChanged": {
        const announcedModelId = str(payload["modelId"]);
        if (announcedModelId) {
          const isUserDriven = payload["source"] === "user";
          const isTrialModelMatch =
            isUserDriven && this.modelTrials.get(sessionIdentifier) === announcedModelId;

          this.store.updateSession(
            sessionIdentifier,
            isTrialModelMatch
              ? { modelId: announcedModelId, chosenModelId: null }
              : isUserDriven
                ? { modelId: announcedModelId, chosenModelId: announcedModelId }
                : { modelId: announcedModelId },
          );
          this.voiceService?.onMuseSessionModelChanged(sessionIdentifier, announcedModelId);
        }
        break;
      }

      case "session/tokenUsage": {
        this.recordUsage(sessionIdentifier, payload);
        break;
      }

      case "session/goalChanged": {
        const extractedGoal = goalOf(payload["goal"]);
        if (extractedGoal !== undefined) {
          liveSession.goal = extractedGoal;
          liveSession.goalSeq += 1;
          liveSession.goalCursor = str(payload["viewCursor"]);
          hasStateChanged = true;
        }
        break;
      }

      case "item/completed": {
        const completedItem = asRecord(payload["item"]);
        if (
          completedItem &&
          completedItem["kind"] === "userMessage" &&
          !this.isResearchSession(sessionIdentifier)
        ) {
          this.maybeTitle(sessionIdentifier, completedItem);
        }
        break;
      }

      case "session/nameChanged": {
        this.adoptMuseName(sessionIdentifier, str(payload["name"]));
        break;
      }

      case "session/reasoningEffortChanged": {
        const updatedEffort = payload["reasoningEffort"];
        if (isReasoningEffort(updatedEffort)) {
          this.effortApplied.set(sessionIdentifier, updatedEffort);
        }
        break;
      }

      case "skill/changed": {
        const sessionRow = this.store.findSession(sessionIdentifier);
        this.skillCache.delete(sessionRow?.cwd || "__default__");
        break;
      }

      default:
        break;
    }

    if (hasStateChanged) {
      this.emitStatus(sessionIdentifier);
    }
  }

  /**
   * Verifies whether a turn has definitively completed according to durable storage.
   */
  private turnFinished(sessionIdentifier: string, turnIdentifier: string): boolean {
    try {
      const turnState = this.store.turnStatus(turnIdentifier, sessionIdentifier);
      return turnState !== null && turnState !== "running" && turnState !== "unknown";
    } catch {
      return false;
    }
  }

  /**
   * Registers turn commencement in durable persistence.
   */
  private recordTurnStart(sessionIdentifier: string, turnIdentifier: string): void {
    try {
      if (this.store.getSession(sessionIdentifier)) {
        this.store.registerTurn(turnIdentifier, sessionIdentifier);
      }
    } catch (recordErr) {
      const errText = recordErr instanceof Error ? recordErr.message : String(recordErr);
      this.log(`turn ${turnIdentifier} of ${sessionIdentifier} could not be recorded as started: ${errText}`);
    }
  }

  /**
   * Registers turn completion status in durable persistence.
   */
  private recordTurnEnd(sessionIdentifier: string, turnIdentifier: string, terminalOutcome: string): void {
    try {
      if (this.store.getSession(sessionIdentifier)) {
        this.store.finishTurn(turnIdentifier, sessionIdentifier, terminalOutcome);
      }
    } catch (recordErr) {
      const errText = recordErr instanceof Error ? recordErr.message : String(recordErr);
      this.log(`turn ${turnIdentifier} of ${sessionIdentifier} could not be recorded as ${terminalOutcome}: ${errText}`);
    }
  }

  /**
   * Propagates session title/rename to the corresponding Muse host when synchronization is enabled.
   */
  private async renameInMuse(sessionIdentifier: string, proposedName: string): Promise<void> {
    if (!this.options.syncSessionNames) {
      return;
    }
    const currentHostKey = this.sessionHosts.get(sessionIdentifier);
    const managedHost = currentHostKey ? this.hosts.get(currentHostKey) : undefined;
    if (!managedHost || this.renameRefused.has(managedHost.key)) {
      return;
    }
    try {
      await managedHost.manager.renameSession(sessionIdentifier, proposedName);
    } catch (renameErr) {
      this.refuseRenames(managedHost.key, errorInfo(renameErr).message);
    }
  }

  /**
   * Detects whether an error or failed item payload contains broken rename signatures in Muse event logs.
   */
  private noteRenameBreakage(hostIdentifier: string | null, eventPayload: Record<string, unknown>): void {
    if (!hostIdentifier || !this.options.syncSessionNames || this.renameRefused.has(hostIdentifier)) {
      return;
    }
    const directError = eventPayload["error"];
    if (directError !== undefined && directError !== null) {
      this.refuseRenames(hostIdentifier, typeof directError === "string" ? directError : JSON.stringify(directError));
    }
    const itemData = asRecord(eventPayload["item"]);
    if (
      itemData &&
      (/fail|error/i.test(str(itemData["status"]) ?? "") || (itemData["error"] !== undefined && itemData["error"] !== null))
    ) {
      this.refuseRenames(hostIdentifier, JSON.stringify(itemData));
    }
  }

  /**
   * Marks a host as refusing title sync when a known event-log decoding error is encountered.
   */
  private refuseRenames(hostIdentifier: string, errorMessageText: string): void {
    if (this.renameRefused.has(hostIdentifier) || !RENAME_DECODE_FAILURE.test(errorMessageText)) {
      return;
    }
    this.renameRefused.add(hostIdentifier);
    const renameRefuseLog =
      `Muse on host ${hostIdentifier} reported "missing field kind" while reading a session's event log, which a session/rename ` +
      "can cause; thread titles are no longer sent to it and stay in Ancilla only";
    this.log(renameRefuseLog);
  }

  /**
   * Project file operations dispatcher for browsing, reading, writing, and opening files.
   */
  private async files(
    httpMethod: string,
    routePath: string,
    parsedUrl: URL,
    incomingReq: IncomingMessage,
    outgoingRes: ServerResponse,
  ): Promise<boolean> {
    const isMutationReq = httpMethod === "PUT" || httpMethod === "POST";
    const parsedBody = isMutationReq ? await this.readBody(incomingReq) : {};
    const workspaceCwd = str(parsedBody["cwd"]) ?? parsedUrl.searchParams.get("cwd");
    const matchingProject = workspaceCwd ? this.store.getProject(workspaceCwd) : null;
    if (!workspaceCwd || !matchingProject) {
      const unknownFolderErr = "Unknown project folder.";
      throw new HttpError(404, unknownFolderErr);
    }

    const localProjectRoot = await this.localRootFor(workspaceCwd);
    const targetRelativePath = str(parsedBody["path"]) ?? parsedUrl.searchParams.get("path") ?? "";

    if (httpMethod === "GET" && routePath === "/api/files/list") {
      const folderEntries = await listFolder(localProjectRoot, workspaceCwd, targetRelativePath);
      this.json(outgoingRes, 200, folderEntries);
      const isHandled = true;
      return isHandled;
    }

    if (httpMethod === "GET" && routePath === "/api/files/read") {
      const fileData = await readProjectFile(localProjectRoot, workspaceCwd, targetRelativePath);
      this.json(outgoingRes, 200, fileData);
      const isHandled = true;
      return isHandled;
    }

    if ((httpMethod === "GET" || httpMethod === "HEAD") && routePath === "/api/files/raw") {
      await serveProjectFile(incomingReq, outgoingRes, localProjectRoot, workspaceCwd, targetRelativePath);
      const isHandled = true;
      return isHandled;
    }

    if (httpMethod === "GET" && routePath === "/api/files/search") {
      const searchPattern = parsedUrl.searchParams.get("q") ?? "";
      const searchResults = await searchProjectFiles(localProjectRoot, searchPattern);
      this.json(outgoingRes, 200, { files: searchResults });
      const isHandled = true;
      return isHandled;
    }

    if (httpMethod === "PUT" && routePath === "/api/files/write") {
      const fileContent = parsedBody["content"];
      if (typeof fileContent !== "string") {
        const missingContentErr = "content is required.";
        throw new HttpError(400, missingContentErr);
      }
      const baselineMtime = parsedBody["baseMtimeMs"];
      const writeOutcome = await writeProjectFile(
        localProjectRoot,
        workspaceCwd,
        targetRelativePath,
        fileContent,
        typeof baselineMtime === "number" ? baselineMtime : null,
      );
      this.json(outgoingRes, 200, writeOutcome);
      const isHandled = true;
      return isHandled;
    }

    if (httpMethod === "POST" && routePath === "/api/files/open") {
      const { abs: absoluteFilePath } = await resolveInRoot(localProjectRoot, targetRelativePath, workspaceCwd);
      await this.opener(absoluteFilePath, "files");
      this.json(outgoingRes, 200, { ok: true });
      const isHandled = true;
      return isHandled;
    }

    const isHandled = false;
    return isHandled;
  }

  /**
   * Resolve only credentials belonging to this runtime. Keychain-only logins and a named account under WSL use MSP
   * observations; the default login under WSL is the file inside the distro.
   */
  private async quotaAuthPath(accountId: string | null): Promise<string | null> {
    if (await this.museRuntime() === "wsl") return this.wslQuotaAuthPath(accountId);
    if (process.env["META_API_KEY"]) return null;
    if (accountId) {
      // A global auth override defeats isolated account roots; do not assign it to every profile.
      if (process.env["MUSE_AUTH_PATH"]) return null;
      const profile = await this.profiles.getProfile(accountId);
      return join(profile.roots.config, "muse", "auth.json");
    }
    return process.env["MUSE_AUTH_PATH"] || join(process.env["XDG_CONFIG_HOME"] || join(this.options.home, ".config"), "muse", "auth.json");
  }

  /**
   * The default login of Muse in WSL, as the Windows side can open it. The login Muse uses is the file in the
   * distro, never the one on the Windows side (unless the distro's own variables name a folder under /mnt/<drive>,
   * where Muse reads it too), and this process's own environment is the Windows one: runtime.json's `wslEnv` says
   * what Muse there was told, and a variable the user's own WSLENV forwards is not seen. An API key, here or for the
   * distro, or an auth file named by this process's environment leaves no direct read, as it does natively.
   */
  private async wslQuotaAuthPath(accountId: string | null): Promise<string | null> {
    if (accountId !== null || this.options.platform !== "win32" || process.env["META_API_KEY"] || process.env["MUSE_AUTH_PATH"] ||
      this.options.wslEnv["META_API_KEY"]) return null;
    const distro = this.wslDistro();
    if (!isDistroName(distro)) return null;
    const linux = await linuxAuthPath(this.options.wslEnv, () => this.wslHomes.get(distro));
    if (!linux) return null;
    return this.wslQuota.localPath ? await this.wslQuota.localPath(distro, linux) : localAuthPath(distro, linux);
  }

  /** The distro user's home folder, as `wsl.exe` prints it; null when the call fails or runs out of time. */
  private async askWslHome(distro: string): Promise<string | null> {
    const plan = planHostCommand({ platform: this.options.platform, distro, runtime: "wsl", program: "sh", args: ["-c", 'printf %s "$HOME"'] });
    const timeoutMs = this.wslQuota.homeTimeoutMs ?? WSL_HOME_TIMEOUT_MS;
    const env = this.wslEnvFor();
    const result = await this.options.exec(plan.command, plan.args, { timeoutMs, ...(env ? { env } : {}) });
    return result.exitCode === 0 && !result.timedOut ? result.stdout : null;
  }

  /** Whether the quota of this login is read from inside a WSL distro, where a stopped one must not hold anything up. */
  private async readsWslLogin(accountId: string | null): Promise<boolean> {
    try {
      return accountId === null && this.options.platform === "win32" && await this.museRuntime() === "wsl";
    } catch { return false; }
  }

  /**
   * One kind of look at a WSL login (`scope`, `read` or `identity`), given up on after `readTimeoutMs`: `fallback()` is the answer
   * then, and whatever the look still does is checked by the revision. Opening a file in a stopped or slow distro can
   * hold a thread of the pool for as long as the distro takes, so once a look has outlived its bound the same kind is
   * not started again, and answers `fallback()` at once, until a look that outlived it has settled. The first to
   * settle lifts the hold; what keeps overlapping looks from each pinning a thread is the one open per login file in
   * subscriptionQuota.ts. The environment probe that finds the distro is not part of this bound.
   */
  private async wslUnit<T, F>(kind: string, start: () => Promise<T>, fallback: () => F): Promise<T | F> {
    if (this.wslStuck.has(kind)) return fallback();
    const run = start();
    let settled = false;
    const done = () => { settled = true; };
    run.then(done, done);
    const answer = await withinMs(run, this.wslQuota.readTimeoutMs ?? WSL_READ_TIMEOUT_MS);
    if (settled) return answer as T;
    this.wslStuck.add(kind);
    const free = () => { this.wslStuck.delete(kind); };
    run.then(free, free);
    return fallback();
  }

  /**
   * Only the non-secret identity scopes durable readings; no credentials enter the quota cache. A WSL look that gave
   * up says nothing about the login, so the identity last seen stands rather than reading as a login that changed.
   */
  private async quotaCacheScope(accountId: string | null): Promise<string | null> {
    if (!await this.readsWslLogin(accountId)) return this.quotaScopeOf(accountId);
    return this.wslUnit("scope", () => this.quotaScopeOf(accountId), () => this.quotaScopes.get(accountId) ?? null);
  }

  private async quotaScopeOf(accountId: string | null): Promise<string | null> {
    try {
      const path = await this.quotaAuthPath(accountId);
      if (!path) return null;
      const email = await subscriptionIdentity(path);
      if (!email) return null;
      return createHash("sha256").update(JSON.stringify([
        this.options.platform, await this.museRuntime(), this.options.musePath ?? "muse", accountId, path, email,
      ])).digest("hex");
    } catch { return null; }
  }

  /**
   * A stamp well ahead of this clock would outrank every honest reading until real time caught up, and its saved
   * row would outrank them after a restart. A frame counts as arriving when it first did, and the same observation
   * read again keeps that moment, so a runtime that stops reporting still goes stale. A saved row did not arrive
   * just now and nothing says when it was observed, so it is restored as an old reading: it neither claims to be
   * fresh nor outranks a reading Muse made since.
   */
  private settleStamp(usage: SubscriptionUsage, accountId: string | null, origin: "meta" | "runtime" | "saved"): SubscriptionUsage {
    const now = Date.now();
    if (usage.observedAtMs <= now + QUOTA_CLOCK_SKEW_MS) return usage;
    if (origin === "saved") return { ...usage, observedAtMs: now - QUOTA_RESTORED_AGE_MS };
    const seen = this.clampedStamps.get(accountId);
    const to = seen?.from === usage.observedAtMs ? seen.to : now;
    this.clampedStamps.set(accountId, { from: usage.observedAtMs, to });
    return { ...usage, observedAtMs: to };
  }

  /** A newer observation wins; cached readings keep their original timestamp and source account. */
  private observeUsage(reported: SubscriptionUsage | null, accountId: string | null = null,
    origin: "meta" | "runtime" | "saved" = "runtime", scope: string | null = null): void {
    if (!reported || (accountId && this.removedQuotaAccounts.has(accountId))) return;
    const usage = this.settleStamp(reported, accountId, origin);
    const direct = this.directQuota.get(accountId);
    if (direct?.status === "no-subscription" && direct.checkedAtMs >= usage.observedAtMs) return;
    const prior = accountId ? this.planUsageByAccount.get(accountId) : this.defaultPlanUsage;
    if (prior && prior.observedAtMs > usage.observedAtMs) return;
    if (origin === "saved" && prior?.observedAtMs === usage.observedAtMs) return;
    const changed = !sameSubscriptionUsage(prior, usage);
    if (accountId) this.planUsageByAccount.set(accountId, usage);
    else this.defaultPlanUsage = usage;
    // When Meta and the runtime report the very same observation, the account's own reading is the better label.
    if (changed || origin !== "runtime" || this.usageSources.get(accountId) !== "meta") this.usageSources.set(accountId, origin);
    this.quotaScopes.set(accountId, scope);
    if (!this.planUsage || this.planUsage.observedAtMs < usage.observedAtMs ||
      (this.planUsageAccountId === accountId && this.planUsage.observedAtMs === usage.observedAtMs)) {
      this.planUsage = usage;
      this.planUsageAccountId = accountId;
    }
    if (changed && origin !== "saved") {
      if (scope) this.store.setSubscriptionUsage(scope, usage);
      const planPayload = { type: "plan-usage" as const, usage, accountId };
      this.emit("ancilla", planPayload);
    } else if (origin === "saved" && usage !== reported && scope) {
      // Heal a saved row that was stamped in the future, so the next start reads it as an ordinary old reading.
      this.store.setSubscriptionUsage(scope, usage);
    }
  }

  private forgetQuota(accountId: string | null): void {
    if (accountId) this.planUsageByAccount.delete(accountId);
    else this.defaultPlanUsage = null;
    this.usageSources.delete(accountId);
    this.lastPlanNames.delete(accountId);
    this.clampedStamps.delete(accountId);
    this.quotaScopes.delete(accountId);
    this.directQuota.delete(accountId);
    const readings: [string | null, SubscriptionUsage][] = [...this.planUsageByAccount];
    if (this.defaultPlanUsage) readings.push([null, this.defaultPlanUsage]);
    readings.sort((a, b) => b[1].observedAtMs - a[1].observedAtMs);
    this.planUsage = readings[0]?.[1] ?? null;
    this.planUsageAccountId = readings[0]?.[0] ?? null;
  }

  private isCurrentQuotaHost(host: ManagedHost): boolean {
    return host.providerId === "muse" && this.hosts.get(host.key) === host && (!host.accountId ||
      (!this.removedQuotaAccounts.has(host.accountId) &&
        host.quotaAccountGeneration === (this.quotaAccountGenerations.get(host.accountId) ?? 0)));
  }

  /** A wedged runtime must not block fresh Meta readings or accumulate another RPC on every page refresh. */
  private async readHostQuota(host: ManagedHost): Promise<SubscriptionUsage | null> {
    let pending = this.pendingHostQuotas.get(host);
    if (!pending) {
      pending = host.manager.readSubscriptionUsage().finally(() => { this.pendingHostQuotas.delete(host); });
      this.pendingHostQuotas.set(host, pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Muse quota read timed out")), 2000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Reads Meta's subscription snapshot plus host observations; never launches a session or model call. */
  private async readPlanUsage(): Promise<{
    usage: SubscriptionUsage | null; byAccount: Record<string, SubscriptionUsage>; accountId: string | null;
    saved: boolean; savedAccountIds: string[]; status: "ready" | "no-host" | "unobserved" | "unavailable";
    accounts: PlanAccountUsage[];
    providerQuotas: Record<string, unknown>[];
  }> {
    const revision = ++this.planUsageReadRevision;
    const profiles = await this.profiles.listProfiles().catch(() => []);
    const sources = new Set<string | null>([null, ...profiles.map((profile: ProfileRecord) => profile.id), ...this.planUsageByAccount.keys()]);
    const scopes = new Map<string | null, string | null>();
    await Promise.all([...sources].map(async (accountId) => { scopes.set(accountId, await this.quotaCacheScope(accountId)); }));
    for (const [accountId, scope] of scopes) {
      if (revision !== this.planUsageReadRevision || (accountId && this.removedQuotaAccounts.has(accountId))) continue;
      if (this.quotaScopes.has(accountId) && this.quotaScopes.get(accountId) !== scope) this.forgetQuota(accountId);
      if (scope) this.observeUsage(this.store.getSubscriptionUsage(scope), accountId, "saved", scope);
      this.quotaScopes.set(accountId, scope);
    }
    const hosts = [...this.hosts.values()].filter((h) => h.providerId === "muse");
    const hostOutcomes = new Map<string | null, { attempted: number; succeeded: number; usageAtStart: SubscriptionUsage | null }>();
    let failed = 0;
    const hostReads = hosts.map(async (managed) => {
      let outcome: { attempted: number; succeeded: number; usageAtStart: SubscriptionUsage | null } | undefined;
      try {
        // A host started under a different login must not overwrite the newly selected login's reading.
        if (revision !== this.planUsageReadRevision || !this.isCurrentQuotaHost(managed) ||
          managed.quotaCacheScope !== (scopes.get(managed.accountId) ?? null)) return;
        outcome = hostOutcomes.get(managed.accountId) ?? { attempted: 0, succeeded: 0,
          usageAtStart: managed.accountId ? this.planUsageByAccount.get(managed.accountId) ?? null : this.defaultPlanUsage };
        outcome.attempted += 1;
        hostOutcomes.set(managed.accountId, outcome);
        const usage = await this.readHostQuota(managed);
        // Identity checks happen asynchronously. A newer read, account removal, or host replacement can
        // invalidate this request while Muse is answering; only the still-current source may publish it.
        if (revision !== this.planUsageReadRevision || !this.isCurrentQuotaHost(managed) ||
          this.quotaScopes.get(managed.accountId) !== managed.quotaCacheScope) return;
        outcome.succeeded += 1;
        this.observeUsage(usage, managed.accountId, "runtime", managed.quotaCacheScope);
      } catch { failed += 1; }
    });
    const directReads = [...sources].map(async (accountId) => {
      const direct = async () => {
        try {
          const path = await this.quotaAuthPath(accountId);
          const reading = path ? await this.subscriptionReader.read(path, accountId) : null;
          if (revision !== this.planUsageReadRevision || this.closed || (accountId && this.removedQuotaAccounts.has(accountId))) return;
          // Login can change while Meta answers, even if no other quota request has noticed it yet.
          const scope = await this.quotaCacheScope(accountId);
          if (revision !== this.planUsageReadRevision) return;
          if (scope !== scopes.get(accountId)) { this.forgetQuota(accountId); this.quotaScopes.set(accountId, scope); return; }
          if (!reading) { this.directQuota.delete(accountId); return; }
          if (reading.status === "no-subscription") {
            // A plan that ended is not the plan to show after the next failed check.
            this.lastPlanNames.delete(accountId);
            const prior = accountId ? this.planUsageByAccount.get(accountId) : this.defaultPlanUsage;
            if (!prior || prior.observedAtMs <= reading.checkedAtMs) this.forgetQuota(accountId);
          } else if (reading.planName) this.lastPlanNames.set(accountId, reading.planName);
          this.directQuota.set(accountId, reading);
          this.quotaScopes.set(accountId, scope);
          this.observeUsage(reading.usage, accountId, "meta", scope);
        } catch { /* A missing or inaccessible profile still has its runtime-only row below. */ }
      };
      // A WSL login is read through a distro that may be stopped or slow; the page does not wait long for it.
      await (await this.readsWslLogin(accountId) ? this.wslUnit("read", direct, () => undefined) : direct());
    });
    const otherHostReads = [...this.hosts.values()]
      .filter((h) => h.providerId !== "muse")
      .map(async (managed) => {
        try {
          const usage = await this.readHostQuota(managed);
          if (usage && this.hosts.get(managed.key) === managed) {
            this.providerUsageByKey.set(`${managed.providerId}::${managed.accountId ?? "default"}`, usage);
            if (managed.quotaCacheScope) {
              this.store.setSubscriptionUsage(managed.quotaCacheScope, usage);
            }
          }
        } catch {
          /* ignore unsupported or timed-out non-Muse quota checks */
        }
      });
    await Promise.all([...hostReads, ...directReads, ...otherHostReads]);
    const accounts: PlanAccountUsage[] = [null, ...profiles.map((profile: ProfileRecord) => profile.id)]
      .filter((id) => id === null || !this.removedQuotaAccounts.has(id))
      .map((accountId) => {
        const reading = this.directQuota.get(accountId);
        const usage = accountId ? this.planUsageByAccount.get(accountId) ?? null : this.defaultPlanUsage;
        const newerRuntime = usage !== null && reading !== undefined && usage.observedAtMs > reading.checkedAtMs;
        const outcome = hostOutcomes.get(accountId);
        const hostUnavailable = outcome && outcome.attempted > 0 && outcome.succeeded === 0 && usage === outcome.usageAtStart;
        const status = newerRuntime ? "runtime-only" : reading?.status ?? (hostUnavailable ? "unavailable" : "runtime-only");
        // Only Meta names the plan, and only when it answers. A failed check, a login it rejected and a login that no
        // longer holds a token (so no check ran) keep the name it gave before; a changed login, an ended plan and a
        // removed account have already cleared it.
        const unanswered = !reading || reading.status === "unavailable" || reading.status === "login-required";
        const kept = unanswered ? this.lastPlanNames.get(accountId) : undefined;
        return {
          accountId, usage: status === "no-subscription" ? null : usage,
          planName: reading?.planName ?? kept ?? null,
          source: usage ? this.usageSources.get(accountId) ?? "runtime" : null,
          status, checkedAtMs: reading?.checkedAtMs ?? null,
        };
      });
    const metaAvailable = accounts.some((account) => account.status === "ready");
    const providerQuotas = this.providerQuotasView();
    return {
      usage: this.planUsage,
      byAccount: Object.fromEntries(this.planUsageByAccount),
      accountId: this.planUsageAccountId,
      saved: this.planUsage !== null && this.usageSources.get(this.planUsageAccountId) === "saved",
      savedAccountIds: [...this.usageSources].flatMap(([id, source]) => id !== null && source === "saved" ? [id] : []),
      status: metaAvailable ? "ready" : hosts.length === 0 ? "no-host" : failed === hosts.length ? "unavailable" : this.planUsage ? "ready" : "unobserved",
      accounts,
      providerQuotas,
    };
  }

  /** Muse named or renamed the session, here or in another client; the newest name wins, and a typed title stays typed. */
  private adoptMuseName(targetSessionId: string, candidateName: string | null): void {
    const sanitizedTitle = candidateName?.trim().slice(0, 200);
    const existingRow = sanitizedTitle ? this.store.getSession(targetSessionId) : null;
    if (!sanitizedTitle || !existingRow || existingRow.title === sanitizedTitle) {
      return;
    }
    if (!this.options.syncSessionNames && existingRow.titleSource !== "placeholder") {
      return;
    }
    this.titleUpgradePending.delete(targetSessionId);
    this.store.updateSession(targetSessionId, {
      title: sanitizedTitle,
      titleSource: existingRow.titleSource === "user" ? "user" : "auto",
    });
    this.notifySessionsChange();
  }

  private async applyApprovalMode(
    sessionMgr: SessionManager,
    targetSessionId: string,
    requestedMode: ApprovalMode,
  ): Promise<void> {
    if (this.approvalModeApplied.get(targetSessionId) === requestedMode) {
      return;
    }
    try {
      await sessionMgr.setSessionApprovalMode(targetSessionId, requestedMode);
      this.approvalModeApplied.set(targetSessionId, requestedMode);
    } catch (setModeErr) {
      const errKind = errorInfo(setModeErr).kind;
      if (errKind === "sessionNotLoaded" || errKind === "sessionStreamMismatch" || errKind === "sessionNotFound") {
        throw setModeErr;
      }
    }
  }

  private async applyEffort(
    sessionMgr: SessionManager,
    targetSessionId: string,
    targetEffort: ReasoningEffort,
  ): Promise<void> {
    if (this.effortApplied.get(targetSessionId) === targetEffort) {
      return;
    }
    try {
      await sessionMgr.setReasoningEffort(targetSessionId, targetEffort);
      this.effortApplied.set(targetSessionId, targetEffort);
    } catch (setEffortErr) {
      const errKind = errorInfo(setEffortErr).kind;
      if (errKind === "sessionNotLoaded" || errKind === "sessionStreamMismatch" || errKind === "sessionNotFound") {
        throw setEffortErr;
      }
    }
  }

  private maybeTitle(targetSessionId: string, userItem: Record<string, unknown>): void {
    const sessionRow = this.store.getSession(targetSessionId);
    if (!sessionRow || sessionRow.titleSource !== "placeholder") {
      return;
    }
    const rawUserText = str(userItem["displayText"]) ?? str(userItem["text"]) ?? "";
    const generatedTitle = deriveTitle(rawUserText);
    if (generatedTitle) {
      this.store.updateSession(targetSessionId, { title: generatedTitle, titleSource: "auto" });
      this.titleUpgradePending.add(targetSessionId);
      void this.maybeUpgradeThreadTitle(targetSessionId, rawUserText);
      this.notifySessionsChange();
    }
  }
  private normalizeProviderId(value: unknown): ProviderId {
    return normalizeProviderIdValue(value);
  }

  private profilesFor(): ProfileIsolator {
    if (!this.profileIsolator) {
      const inMemory = this.options.dataDir === ":memory:";
      this.providerSecrets ??= new FileSecretStore(
        inMemory ? null : join(this.options.dataDir, "provider-secrets.json"),
        () => Date.now(),
        (line) => this.log(line),
      );
      this.profileIsolator = new ProfileIsolator(
        inMemory ? null : this.options.dataDir,
        this.providerSecrets,
      );
    }
    return this.profileIsolator;
  }

  private cliHostPathFor(cwd: string, providerId: ProviderId): string {
    if (!cwd || this.options.platform !== "win32") {
      return cwd;
    }
    const cachedRuntime = this.providerProbeCache?.probes[providerId]?.runtime;
    const runtime = cachedRuntime && cachedRuntime !== "builtin" ? cachedRuntime : (this.runtimeHint() ?? this.runtimeKnown);
    if (runtime === "native") {
      return this.spawnCwdFor(cwd);
    }
    const unc = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i.exec(cwd);
    if (unc) {
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

  private providerAccountView(record: ProviderAccountRecord): Record<string, unknown> {
    const isolator = this.profilesFor();
    return {
      id: record.id,
      providerId: record.providerId,
      name: record.name,
      runtimeOverride: record.runtimeOverride,
      binaryPath: record.binaryPath,
      customArgs: record.customArgs,
      apiKind: record.apiKind,
      apiBaseUrl: record.apiBaseUrl,
      hasApiKey: isolator.resolveApiKey(record) !== null,
      stripAmbientKeys: record.stripAmbientKeys,
      defaultModelId: record.defaultModelId,
      customModels: record.customModels,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
    };
  }

  private async closeProviderAccountHosts(providerId: ProviderId, accountId: string | null, reason: string): Promise<void> {
    const matching = [...this.hosts.values()].filter(
      (h) => h.providerId === providerId && h.accountId === accountId,
    );
    await Promise.all(
      matching.map(async (managed) => {
        await this.closeHost(managed);
        this.forgetHost(managed, reason);
      }),
    );
  }

  private async createOrUpdateProviderAccount(
    existingId: string | null,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const existing = existingId ? this.store.getProviderAccount(existingId) : null;
    if (existingId && !existing) {
      throw new HttpError(404, `Unknown provider account "${existingId}".`);
    }

    const rawProvider = body["providerId"] ?? existing?.providerId;
    if (!isProviderId(rawProvider)) {
      throw new HttpError(400, "A valid providerId is required.");
    }
    if (rawProvider === "muse") {
      throw new HttpError(400, "Muse profiles are managed through /api/accounts.");
    }
    const providerId: ProviderId = rawProvider;

    const rawName = str(body["name"])?.trim() ?? existing?.name;
    if (!rawName || rawName.length > 120) {
      throw new HttpError(400, "name must be 1 to 120 characters.");
    }

    let id = existingId ?? str(body["id"])?.trim() ?? null;
    if (!id) {
      const slug = rawName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "account";
      id = `${slug}-${randomUUID().slice(0, 6)}`;
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(id)) {
      throw new HttpError(400, "Account id must contain only letters, digits, dots, hyphens or underscores.");
    }
    if (!existingId && body["upsert"] !== true && this.store.getProviderAccount(id)) {
      throw new HttpError(409, `Provider account "${id}" already exists.`);
    }

    let apiKind: ApiProviderKind | null = existing?.apiKind ?? (providerId === "api" ? "openai" : null);
    if ("apiKind" in body) {
      const k = body["apiKind"];
      if (k === null) {
        apiKind = null;
      } else if (k === "openai" || k === "anthropic" || k === "google") {
        apiKind = k;
      } else {
        throw new HttpError(400, "apiKind must be openai, anthropic or google.");
      }
    }

    let apiBaseUrl: string | null =
      existing?.apiBaseUrl ??
      (providerId === "api"
        ? apiKind === "anthropic"
          ? "https://api.anthropic.com"
          : apiKind === "google"
            ? "https://generativelanguage.googleapis.com"
            : "https://api.openai.com/v1"
        : null);
    const baseInput = "apiBaseUrl" in body ? body["apiBaseUrl"] : ("baseUrl" in body ? body["baseUrl"] : undefined);
    if (baseInput !== undefined) {
      if (baseInput === null || baseInput === "") {
        apiBaseUrl = null;
      } else if (typeof baseInput === "string") {
        let parsed: URL;
        try {
          parsed = new URL(baseInput.trim());
        } catch {
          throw new HttpError(400, "apiBaseUrl must be a valid http:// or https:// URL.");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new HttpError(400, "apiBaseUrl must use http:// or https://.");
        }
        apiBaseUrl = baseInput.trim().replace(/\/+$/, "");
      } else {
        throw new HttpError(400, "apiBaseUrl must be a string or null.");
      }
    }

    const binaryInput = "binaryPath" in body ? body["binaryPath"] : ("command" in body ? body["command"] : undefined);
    let binaryPath: string | null | undefined = undefined;
    if (binaryInput !== undefined) {
      if (binaryInput === null || binaryInput === "") {
        binaryPath = null;
      } else if (typeof binaryInput === "string" && binaryInput.trim().length > 0) {
        binaryPath = binaryInput.trim();
      } else {
        throw new HttpError(400, "binaryPath must be a string or null.");
      }
    }

    const argsInput = "customArgs" in body ? body["customArgs"] : ("args" in body ? body["args"] : undefined);
    let customArgs: string[] | undefined = undefined;
    if (argsInput !== undefined) {
      if (!Array.isArray(argsInput) || !argsInput.every((item) => typeof item === "string")) {
        throw new HttpError(400, "customArgs must be an array of strings.");
      }
      customArgs = argsInput.map((s) => s.trim()).filter(Boolean);
    }

    let runtimeOverride: string | null | undefined = undefined;
    if ("runtimeOverride" in body) {
      const r = body["runtimeOverride"];
      if (r === null || r === "") {
        runtimeOverride = null;
      } else if (r === "native" || r === "wsl" || r === "posix") {
        runtimeOverride = r;
      } else {
        throw new HttpError(400, "runtimeOverride must be native, wsl, posix or null.");
      }
    }

    let stripAmbientKeys: boolean | undefined = undefined;
    if ("stripAmbientKeys" in body) {
      if (typeof body["stripAmbientKeys"] !== "boolean") {
        throw new HttpError(400, "stripAmbientKeys must be a boolean.");
      }
      stripAmbientKeys = body["stripAmbientKeys"];
    }

    let defaultModelId: string | null | undefined = undefined;
    if ("defaultModelId" in body) {
      const m = body["defaultModelId"];
      if (m === null || m === "") {
        defaultModelId = null;
      } else if (typeof m === "string") {
        defaultModelId = m.trim();
      } else {
        throw new HttpError(400, "defaultModelId must be a string or null.");
      }
    }

    let customModels: string[] | undefined = undefined;
    if ("customModels" in body) {
      if (!Array.isArray(body["customModels"]) || !body["customModels"].every((m) => typeof m === "string")) {
        throw new HttpError(400, "customModels must be an array of model ID strings.");
      }
      customModels = [...new Set((body["customModels"] as string[]).map((m) => m.trim()).filter(Boolean))];
    }

    const isolator = this.profilesFor();
    let secretKeyId: string | null | undefined = undefined;
    if ("apiKey" in body) {
      const keyVal = body["apiKey"];
      if (keyVal === null || keyVal === "") {
        if (existing) {
          isolator.deleteApiKey(existing);
        }
        secretKeyId = null;
      } else if (typeof keyVal === "string" && keyVal.trim().length > 0) {
        secretKeyId = isolator.setApiKey(id, keyVal.trim());
      } else {
        throw new HttpError(400, "apiKey must be a non-empty string or null.");
      }
    }

    if (providerId !== "api") {
      isolator.profileDir(providerId, id);
    }

    const saved = this.store.upsertProviderAccount({
      id,
      providerId,
      name: rawName,
      ...(runtimeOverride !== undefined ? { runtimeOverride } : {}),
      ...(binaryPath !== undefined ? { binaryPath } : {}),
      ...(customArgs !== undefined ? { customArgs } : {}),
      apiKind,
      apiBaseUrl,
      ...(secretKeyId !== undefined ? { secretKeyId } : {}),
      ...(stripAmbientKeys !== undefined ? { stripAmbientKeys } : {}),
      ...(defaultModelId !== undefined ? { defaultModelId } : {}),
      ...(customModels !== undefined ? { customModels } : {}),
    });

    if (existing) {
      await this.closeProviderAccountHosts(providerId, id, "Provider account configuration changed.");
    }

    return this.providerAccountView(saved);
  }

  private async removeProviderAccount(accountId: string): Promise<void> {
    const existing = this.store.getProviderAccount(accountId);
    if (!existing) {
      throw new HttpError(404, `Unknown provider account "${accountId}".`);
    }
    const isolator = this.profilesFor();
    isolator.deleteApiKey(existing);
    if (this.options.dataDir !== ":memory:" && existing.providerId !== "api") {
      const dir = isolator.profileDir(existing.providerId, accountId);
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    this.store.deleteProviderAccount(accountId);
    this.providerUsageByKey.delete(`${existing.providerId}::${accountId}`);
    await this.closeProviderAccountHosts(existing.providerId, accountId, "Provider account was removed.");
  }

  private async probeProvidersCached(refresh: boolean): Promise<Record<string, ProviderBinaryProbe>> {
    const now = Date.now();
    if (!refresh && this.providerProbeCache && now - this.providerProbeCache.at < 30_000) {
      return this.providerProbeCache.probes;
    }
    const builtins = await probeAllBuiltinProviders({
      exec: this.options.exec,
      platform: this.options.platform,
      preference: this.options.runtime,
      distro: this.options.distro,
    });
    const probes: Record<string, ProviderBinaryProbe> = { ...builtins };
    // Preserve Muse path discovery when configured explicitly via options.musePath
    if (this.options.musePath) {
      const museRuntime = await this.museRuntime().catch(() => "posix" as MuseRuntime);
      const musePath = await this.cliMusePath().catch(() => this.options.musePath ?? null);
      if (musePath) {
        probes["muse"] = {
          providerId: "muse",
          available: true,
          runtime: museRuntime,
          binaryPath: musePath,
          distro: museRuntime === "wsl" ? this.wslDistro() : null,
          version: probes["muse"]?.version ?? null,
        };
      }
    }
    this.providerProbeCache = { at: now, probes };
    return probes;
  }

  private async listProvidersView(refresh: boolean): Promise<Record<string, unknown>> {
    const probes = await this.probeProvidersCached(refresh);
    const isolator = this.profilesFor();
    const allStoredAccounts = this.store.listProviderAccounts();
    const museAccounts = await this.accountList().catch(() => []);
    const museDefault = await this.defaultLoginIdentity().catch(() => ({ hasLogin: null, email: null }));

    const customIds = [
      ...new Set(
        allStoredAccounts
          .map((a) => a.providerId)
          .filter((id) => !(BUILTIN_PROVIDER_IDS as readonly string[]).includes(id)),
      ),
    ];
    const providerIds: ProviderId[] = [...BUILTIN_PROVIDER_IDS, ...customIds];
    const ambientKeyOverrides: Record<string, string[]> = {};

    const providers = await Promise.all(
      providerIds.map(async (providerId) => {
        const descriptor = descriptorForProvider(providerId);
        const ambient = detectAmbientKeyOverrides(providerId);
        if (ambient.length > 0) {
          ambientKeyOverrides[providerId] = ambient;
        }
        const accountsForProvider = allStoredAccounts.filter((a) => a.providerId === providerId);
        let probe = probes[providerId];
        if (!probe) {
          const customAccount = accountsForProvider[0] ?? null;
          probe = await probeProviderBinary(providerId, {
            exec: this.options.exec,
            platform: this.options.platform,
            preference: this.options.runtime,
            distro: this.options.distro,
            configuredPath: customAccount?.binaryPath ?? undefined,
          });
        }

        if (providerId === "muse") {
          return {
            id: providerId,
            displayName: descriptor.displayName,
            vendorName: descriptor.vendorName,
            subscriptionSummary: descriptor.subscriptionSummary,
            binaryName: descriptor.binaryName,
            serveArgs: descriptor.serveArgs,
            loginArgs: descriptor.loginArgs,
            installDocsUrl: descriptor.installDocsUrl,
            usageDashboardUrl: descriptor.usageDashboardUrl,
            capabilities: descriptor.capabilities,
            binary: probe,
            ambientKeyOverrides: ambient,
            defaultAuth: {
              state: museDefault.hasLogin === true ? "authenticated" : museDefault.hasLogin === false ? "unauthenticated" : "unknown",
              summary: museDefault.email ? `Signed in as ${museDefault.email}` : (museDefault.hasLogin ? "Signed in" : null),
              email: museDefault.email,
              planTier: null,
              authMethod: "device-code",
            },
            accounts: museAccounts,
          };
        }

        const defaultAuth =
          providerId === "api"
            ? await isolator.probeAuthStatus({
                providerId: "api",
                accountId: accountsForProvider[0]?.id ?? null,
                account: accountsForProvider[0] ?? null,
                binaryAvailable: true,
              })
            : await isolator.probeAuthStatus({
                providerId,
                accountId: null,
                account: null,
                binaryAvailable: probe.available,
                binaryPath: probe.binaryPath,
                runtime: probe.runtime,
                distro: probe.distro,
                platform: this.options.platform,
                exec: this.options.exec,
              });

        const accountViews = await Promise.all(
          accountsForProvider.map(async (acc) => {
            const auth = await isolator.probeAuthStatus({
              providerId,
              accountId: acc.id,
              account: acc,
              binaryAvailable: Boolean(acc.binaryPath) || probe.available,
              binaryPath: acc.binaryPath ?? probe.binaryPath,
              runtime: (acc.runtimeOverride as MuseRuntime | null) ?? probe.runtime,
              distro: probe.distro,
              platform: this.options.platform,
              exec: this.options.exec,
            });
            return {
              ...this.providerAccountView(acc),
              auth,
            };
          }),
        );

        return {
          id: providerId,
          displayName:
            providerId.startsWith("acp:") && accountsForProvider[0]
              ? accountsForProvider[0].name
              : descriptor.displayName,
          vendorName: descriptor.vendorName,
          subscriptionSummary: descriptor.subscriptionSummary,
          binaryName: descriptor.binaryName,
          serveArgs: descriptor.serveArgs,
          loginArgs: descriptor.loginArgs,
          installDocsUrl: descriptor.installDocsUrl,
          usageDashboardUrl: descriptor.usageDashboardUrl,
          capabilities: descriptor.capabilities,
          binary: probe,
          ambientKeyOverrides: ambient,
          defaultAuth,
          accounts: accountViews,
        };
      }),
    );

    return {
      providers,
      accounts: allStoredAccounts.map((acc) => this.providerAccountView(acc)),
      ambientKeyOverrides,
      remoteDeployment: !isLoopbackBind(this.options.host),
      license: "AGPL-3.0-only",
      sourceOfferUrl: "https://github.com/aleff-ferreira/ancilla",
    };
  }

  private isHostIdle(managed: ManagedHost): boolean {
    for (const [sessionId, live] of this.live) {
      if (
        live.turnHost === managed.key &&
        (live.activeTurnId || live.pendingApprovals.size > 0 || live.pendingInputs.size > 0)
      ) {
        return false;
      }
      if (this.sessionHosts.get(sessionId) === managed.key && this.isBusy(sessionId)) {
        return false;
      }
    }
    return true;
  }

  private syncVoiceToAssistantModel(): void {
    try {
      const hasPersistedVoice =
        this.options.dataDir !== ":memory:" && existsSync(join(this.options.dataDir, "voice.json"));
      if (!this.voiceService && !hasPersistedVoice) return;
      const voice = this.voiceFor();
      const kind = voice.settings.get().brain.kind;
      if (kind === "muse" || kind === "provider") {
        voice.updateSettings({ brain: { kind: "assistant" } });
      }
    } catch {
      // Best-effort synchronization when updating the assistant model preference.
    }
  }

  private async isMuseAccountAuthenticated(managed: ManagedHost): Promise<boolean> {
    if (managed.quotaCacheScope !== null) return true;
    const cacheKey = managed.accountId ?? "__default__";
    const cached = this.museCliAuthCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.at < 60_000) return cached.ok;

    let ok = false;
    try {
      if (managed.accountId !== null) {
        const profile = await this.profiles.getProfile(managed.accountId).catch(() => null);
        if (profile) {
          const id = await this.profiles.identityOf(profile);
          ok = id.hasLogin === true;
        }
      } else {
        const id = await this.defaultLoginIdentity();
        if (id.hasLogin === true) {
          ok = true;
        } else if (id.hasLogin === null) {
          const plan = await this.planMuseExec(["usage", "--json"], null);
          const res = await this.options.exec(plan.command, plan.args, {
            ...(plan.env ? { env: plan.env } : {}),
            timeoutMs: 4_000,
          });
          ok = res.exitCode === 0 && !res.timedOut;
        }
      }
    } catch {
      ok = false;
    }
    this.museCliAuthCache.set(cacheKey, { at: now, ok });
    return ok;
  }

  private async listHostModels(managed: ManagedHost, sessionId?: string): Promise<unknown> {
    const raw = await managed.manager.listModels(sessionId);
    if (managed.providerId !== "muse") return raw;
    const rec = asRecord(raw);
    if (!rec || rec["source"] !== "bundledCatalog" || !Array.isArray(rec["models"]) || rec["models"].length > 0) {
      return raw;
    }
    const activeModelId = sessionId ? (this.store.findSession(sessionId)?.session.modelId ?? null) : null;
    const providerId = str(rec["providerId"]) ?? "meta";
    const profileId = str(rec["profileId"]);

    if (managed.museHome) {
      let modelCatalogDir = join(managed.museHome, "model-catalog");
      try {
        const remoteDir = `${managed.museHome.replace(/[\\/]+$/, "")}/model-catalog`;
        modelCatalogDir = resolveUserPath(remoteDir, await this.pathContext(managed.museHome)).local;
      } catch {
        // Fall back to direct path join when museHome is already a local path.
      }
      const enriched = await readCachedMuseCatalog({
        modelCatalogDir,
        providerId,
        profileId,
        activeModelId,
      });
      if (enriched) return enriched;
    }

    if (
      !this.hasCustomHostFactory &&
      isMuse1415OrNewer(managed.serverVersion) &&
      (await this.isMuseAccountAuthenticated(managed))
    ) {
      return buildAuthenticatedMuseFallbackCatalog({
        providerId,
        profileId,
        activeModelId,
      });
    }

    return raw;
  }

  private async onLoginCompleted(providerId: ProviderId, accountId: string | null): Promise<void> {
    if (this.closed) {
      return;
    }
    this.providerProbeCache = null;
    if (providerId === "muse") {
      this.quotaScopes.delete(accountId);
      this.museCliAuthCache.delete(accountId ?? "__default__");
    }
    const matching = [...this.hosts.values()].filter(
      (h) => h.providerId === providerId && h.accountId === accountId,
    );
    const idleHosts: ManagedHost[] = [];
    for (const host of matching) {
      this.staleAfterLoginHosts.add(host);
      if (this.isHostIdle(host)) {
        idleHosts.push(host);
      }
    }
    await Promise.all(
      idleHosts.map(async (managed) => {
        await this.closeHost(managed);
        this.forgetHost(managed, "Refreshing host after sign-in.");
      }),
    );
    this.emit("ancilla", { type: "login-completed", providerId, accountId });
  }

  private async oneShotListModels(
    providerId: ProviderId,
    accountId: string | null,
  ): Promise<{ models: unknown; hostVersion: string | null }> {
    const token: StartToken = { handle: null, abandoned: false, closing: false };
    const tempKey = `__probe__:${providerId}:${accountId ?? ""}:${randomUUID()}`;
    const managed =
      providerId === "muse"
        ? await this.spawnHost(tempKey, "", accountId, token)
        : await this.spawnProviderHost(tempKey, "", accountId, providerId, token);
    this.hosts.delete(tempKey);
    try {
      const models = await this.listHostModels(managed, undefined);
      return { models, hostVersion: managed.serverVersion };
    } finally {
      await this.closeHost(managed);
    }
  }

  private async resolveLiveModelCatalog(
    providerId: ProviderId,
    accountId: string | null,
    force = false,
  ): Promise<{ models: unknown; hostVersion: string | null }> {
    const recycleStaleListingHost = async (): Promise<"ready" | "busy"> => {
      const listingKey = this.hostKey("", accountId, providerId);
      const existing = this.hosts.get(listingKey);
      if (existing && (this.staleAfterLoginHosts.has(existing) || force)) {
        if (this.isHostIdle(existing)) {
          await this.closeHost(existing);
          this.forgetHost(existing, force ? "Refreshing model catalog." : "Refreshing host after sign-in.");
          return "ready";
        }
        return "busy";
      }
      return "ready";
    };

    if (providerId === "muse") {
      if (force) {
        this.museCliAuthCache.delete(accountId ?? "__default__");
      }
      if (!force) {
        const candidate = accountId ? await this.runningHostOf(accountId, "muse") : null;
        if (candidate && !this.staleAfterLoginHosts.has(candidate)) {
          return { models: await this.listHostModels(candidate, undefined), hostVersion: candidate.serverVersion };
        }
      }
      if ((await recycleStaleListingHost()) === "busy") {
        return this.oneShotListModels("muse", accountId);
      }
      const host = await this.hostFor("", accountId, "muse");
      return { models: await this.listHostModels(host, undefined), hostVersion: host.serverVersion };
    }

    if (providerId === "api") {
      if (!force) {
        const candidate = accountId ? await this.runningHostOf(accountId, "api") : null;
        if (candidate && !this.staleAfterLoginHosts.has(candidate)) {
          return { models: await candidate.manager.listModels(undefined), hostVersion: candidate.serverVersion };
        }
      }
      if ((await recycleStaleListingHost()) === "busy") {
        return this.oneShotListModels("api", accountId);
      }
      const host = await this.hostFor("", accountId, "api");
      return { models: await host.manager.listModels(undefined), hostVersion: host.serverVersion };
    }

    const descriptor = descriptorForProvider(providerId);
    let account: ProviderAccountRecord | null = null;
    if (accountId !== null) {
      account = this.store.getProviderAccount(accountId);
      if (!account || account.providerId !== providerId) {
        throw new HttpError(400, `Unknown ${descriptor.displayName} account "${accountId}".`);
      }
    }

    if (!force) {
      const running = accountId
        ? await this.runningHostOf(accountId, providerId)
        : ([...this.hosts.values()].find(
            (h) => h.providerId === providerId && h.accountId === null && !this.staleAfterLoginHosts.has(h),
          ) ?? null);
      const freshRunning = running && !this.staleAfterLoginHosts.has(running) ? running : null;

      if (freshRunning) {
        return { models: await freshRunning.manager.listModels(undefined), hostVersion: freshRunning.serverVersion };
      }
    }

    if ((await recycleStaleListingHost()) === "busy") {
      return this.oneShotListModels(providerId, accountId);
    }

    if (this.providerHostFactory) {
      const host = await this.hostFor("", accountId, providerId);
      return { models: await host.manager.listModels(undefined), hostVersion: host.serverVersion };
    }

    const cachedProbes = await this.probeProvidersCached(force);
    let probe = cachedProbes[providerId];
    if (!probe || account?.binaryPath || account?.runtimeOverride) {
      probe = await probeProviderBinary(providerId, {
        exec: this.options.exec,
        platform: this.options.platform,
        preference: (account?.runtimeOverride as RuntimePreference | null) ?? this.options.runtime,
        distro: this.options.distro,
        configuredPath: account?.binaryPath ?? undefined,
      });
    }
    if (!probe.available && !account?.binaryPath) {
      return { models: this.staticModelCatalog(providerId, accountId), hostVersion: null };
    }

    const auth = await this.profilesFor().probeAuthStatus({
      providerId,
      accountId,
      account,
      binaryAvailable: true,
      binaryPath: account?.binaryPath ?? probe.binaryPath,
      runtime: (account?.runtimeOverride as MuseRuntime | null) ?? probe.runtime,
      distro: probe.distro,
      platform: this.options.platform,
      exec: this.options.exec,
    });
    if (providerId !== "claude" && (auth.state === "unauthenticated" || auth.state === "missing-key")) {
      return { models: this.staticModelCatalog(providerId, accountId), hostVersion: probe.version };
    }

    try {
      const host = await this.hostFor("", accountId, providerId);
      return {
        models: await host.manager.listModels(undefined),
        hostVersion: host.serverVersion ?? probe.version,
      };
    } catch {
      return { models: this.staticModelCatalog(providerId, accountId), hostVersion: probe.version };
    }
  }

  private staticModelCatalog(providerId: ProviderId, accountId: string | null): Record<string, unknown> {
    const descriptor = descriptorForProvider(providerId);
    const account = accountId ? this.store.getProviderAccount(accountId) : null;
    const defaultId = account?.defaultModelId ?? descriptor.fallbackModels[0]?.modelId ?? null;
    const seen = new Set<string>();
    const models: Record<string, unknown>[] = [];
    for (const seed of descriptor.fallbackModels) {
      seen.add(seed.modelId);
      const active = seed.modelId === defaultId;
      models.push({
        modelId: seed.modelId,
        displayLabel: seed.displayLabel,
        description: seed.description ?? null,
        providerId,
        profileId: accountId,
        isActive: active,
        isDefault: active,
        contextLimit: seed.contextWindowTokens ?? null,
        contextWindowTokens: seed.contextWindowTokens ?? null,
        variants: seed.supportedReasoningEfforts ? [...seed.supportedReasoningEfforts] : null,
        reasoningEffortVariants: seed.supportedReasoningEfforts ? [...seed.supportedReasoningEfforts] : null,
        supportedReasoningEfforts: seed.supportedReasoningEfforts ? [...seed.supportedReasoningEfforts] : [],
        defaultReasoningEffort: seed.defaultReasoningEffort ?? null,
      });
    }
    if (account) {
      for (const customId of account.customModels) {
        if (seen.has(customId)) continue;
        seen.add(customId);
        const active = customId === defaultId;
        models.push({
          modelId: customId,
          displayLabel: customId,
          description: null,
          providerId,
          profileId: accountId,
          isActive: active,
          isDefault: active,
          contextLimit: null,
          contextWindowTokens: null,
          reasoningEffortVariants: null,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
        });
      }
    }
    if (models.length > 0 && !models.some((m) => m["isDefault"] === true)) {
      models[0]!["isDefault"] = true;
      models[0]!["isActive"] = true;
    }
    return {
      source: "bundledCatalog",
      providerId,
      profileId: accountId,
      models,
    };
  }

  private async spawnProviderHost(
    key: string,
    cwd: string,
    accountId: string | null,
    providerId: ProviderId,
    token: StartToken,
  ): Promise<ManagedHost> {
    const descriptor = descriptorForProvider(providerId);
    const label = descriptor.displayName;
    const isolator = this.profilesFor();

    let account: ProviderAccountRecord | null = null;
    if (accountId !== null) {
      account = this.store.getProviderAccount(accountId);
      if (!account || account.providerId !== providerId) {
        throw new HttpError(400, `Unknown ${label} account "${accountId}".`);
      }
    } else if (providerId === "api") {
      account = this.store.listProviderAccounts("api")[0] ?? null;
    }

    const quotaScope = `provider-quota:${providerId}:${account?.id ?? accountId ?? "default"}`;
    const savedQuota = this.store.getSubscriptionUsage(quotaScope);
    if (savedQuota && !this.providerUsageByKey.has(`${providerId}::${account?.id ?? accountId ?? "default"}`)) {
      this.providerUsageByKey.set(`${providerId}::${account?.id ?? accountId ?? "default"}`, savedQuota);
    }

    let target: ServeTarget;
    let handle: HostHandle | null | undefined = null;

    if (providerId === "api") {
      const effectiveUrl = account?.apiBaseUrl ?? "https://api.openai.com/v1";
      target = {
        command: "http-api",
        args: [account?.apiKind ?? "openai", effectiveUrl],
        cwd: cwd || process.cwd(),
      };
      this.assertStartWanted(token);
      if (this.providerHostFactory) {
        handle = this.providerHostFactory({ providerId, accountId: account?.id ?? accountId, cwd, target });
      }
      if (!handle) {
        if (!account) {
          throw new HttpError(400, "Add an API or local model endpoint in Settings -> Providers first.");
        }
        handle = new ApiAgentHost({
          accountName: account.name,
          apiKind: account.apiKind ?? "openai",
          baseUrl: effectiveUrl,
          resolveApiKey: () => isolator.resolveApiKey(account),
          defaultModelId: account.defaultModelId,
          customModels: account.customModels,
          journal: this.store.sessionJournal(),
        });
      }
    } else {
      let probe: ProviderBinaryProbe | null = null;
      if (!this.providerHostFactory) {
        probe = await probeProviderBinary(providerId, {
          exec: this.options.exec,
          platform: this.options.platform,
          preference: (account?.runtimeOverride as RuntimePreference | null) ?? this.options.runtime,
          distro: this.options.distro,
          configuredPath: account?.binaryPath ?? undefined,
        });
        if (!probe.available && !account?.binaryPath) {
          const docsHint = descriptor.installDocsUrl ? ` See ${descriptor.installDocsUrl}.` : "";
          throw new HttpError(
            503,
            `${label} CLI (${descriptor.binaryName ?? providerId}) is not installed or not on PATH.${docsHint}`,
          );
        }
      }
      const runtime =
        (account?.runtimeOverride as MuseRuntime | null) ??
        (probe && probe.runtime !== "builtin" ? probe.runtime : (this.options.platform === "win32" ? "native" : "posix"));
      const plan = planProviderServe({
        providerId,
        platform: this.options.platform,
        runtime,
        distro: probe?.distro ?? this.wslDistro(),
        binaryPath: account?.binaryPath ?? probe?.binaryPath ?? null,
        customArgs: account && account.customArgs.length > 0 ? account.customArgs : null,
        cwd: this.spawnCwdFor(cwd),
        sandboxDisabled: this.store.getSandboxSettings().disabled,
        yoloEnabled: this.store.getYoloSettings().enabled,
      });
      const env = isolator.buildCliEnv({
        providerId,
        accountId,
        account,
        viaWsl: plan.viaWsl,
      });
      target = {
        command: plan.command,
        args: plan.args,
        cwd: plan.cwd,
        env: Object.fromEntries(
          Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
      };
      this.assertStartWanted(token);
      if (this.providerHostFactory) {
        handle = this.providerHostFactory({ providerId, accountId, cwd, target });
      }
      if (!handle) {
        handle = createCliAgentHost(
          {
            providerId,
            target,
            journal: this.store.sessionJournal(),
            initialUsage: savedQuota,
          },
          {
            startTimeoutMs: this.hostStartTimeoutMs,
            log: (line) => this.log(line),
          },
        );
      }
    }

    token.handle = handle;
    let started: { fingerprintWarning?: unknown; initializeResult?: unknown } | null;
    try {
      started = (await handle.start(ANCILLA_VERSION)) as typeof started;
    } catch (error) {
      this.assertStartWanted(token);
      this.lastHostError = error instanceof Error ? error.message : String(error);
      this.emit("ancilla", { type: "host", key, state: "failed", message: this.lastHostError });
      if (error instanceof HostStartTimeoutError) {
        throw new HttpError(504, `Could not start ${label}: ${this.lastHostError}`);
      }
      throw new HttpError(502, `Could not start ${label}: ${this.lastHostError}`);
    }
    if (token.abandoned || this.closed) {
      if (!token.closing) {
        token.closing = true;
        closeInBackground(handle);
      }
      this.assertStartWanted(token);
    }
    this.lastHostError = null;
    this.fingerprints.set(key, started?.fingerprintWarning ?? null);
    const manager = new SessionManager(handle.connection, {
      providerId,
      capabilities: handle.capabilities ?? capabilitiesForProvider(providerId),
    });
    manager.onNotification((notification) => {
      if (notification.method === "usage/changed" && this.hosts.get(key)?.handle !== handle) return;
      this.forward(key, notification, handle);
    });
    manager.onProtocolError((error) => {
      this.protocolErrors += 1;
      this.lastProtocolError = error instanceof Error ? error.message : String(error);
      this.log(`protocol error on host ${key}: ${this.lastProtocolError}`);
    });
    const serverInfo = asRecord(asRecord(started?.initializeResult)?.["serverInfo"]);
    const managed: ManagedHost = {
      quotaCacheScope: quotaScope,
      quotaAccountGeneration: 0,
      key,
      providerId,
      accountId: account?.id ?? accountId,
      target,
      handle,
      manager,
      serverVersion: serverInfo ? str(serverInfo["version"]) : null,
      museHome: null,
      startedAt: nowIso(),
    };
    handle.onExit?.((exit) => this.hostExited(managed, exit));
    this.hosts.set(key, managed);
    return managed;
  }

  private async runProviderLogin(
    providerId: ProviderId,
    accountId: string | null,
    generation: number,
  ): Promise<Record<string, unknown>> {
    if (providerId === "api") {
      throw new HttpError(400, "API providers authenticate with an API key in Settings -> Providers.");
    }
    const descriptor = descriptorForProvider(providerId);
    const account = accountId ? this.store.getProviderAccount(accountId) : null;
    if (accountId && (!account || account.providerId !== providerId)) {
      throw new HttpError(400, `Unknown ${descriptor.displayName} account "${accountId}".`);
    }

    const isolator = this.profilesFor();
    const probe = await probeProviderBinary(providerId, {
      exec: this.options.exec,
      platform: this.options.platform,
      preference: (account?.runtimeOverride as RuntimePreference | null) ?? this.options.runtime,
      distro: this.options.distro,
      configuredPath: account?.binaryPath ?? undefined,
    });
    const runtime =
      (account?.runtimeOverride as MuseRuntime | null) ??
      (probe.runtime !== "builtin" ? probe.runtime : "posix");
    const viaWsl = this.options.platform === "win32" && runtime === "wsl";
    const env = isolator.buildCliEnv({ providerId, accountId, account, viaWsl });
    const loginEnv = Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    const remoteDeployment = !isLoopbackBind(this.options.host);
    const headlessPosix =
      this.options.platform !== "win32" &&
      this.options.platform !== "darwin" &&
      !process.env["DISPLAY"] &&
      !process.env["WAYLAND_DISPLAY"];
    if (viaWsl || headlessPosix || remoteDeployment) {
      loginEnv["BROWSER"] = "/bin/true";
      if (viaWsl) {
        const currentWslEnv = loginEnv["WSLENV"]?.trim();
        const entries = currentWslEnv ? currentWslEnv.split(":").filter(Boolean) : [];
        if (!entries.some((e) => e === "BROWSER" || e.startsWith("BROWSER/"))) {
          entries.push("BROWSER");
        }
        loginEnv["WSLENV"] = entries.join(":");
      }
    }

    const binaryDisplay = account?.binaryPath ?? probe.binaryPath ?? descriptor.binaryName ?? providerId;
    const profileDir = accountId ? isolator.profileDir(providerId, accountId) : null;
    const envPrefix =
      profileDir && providerId === "codex"
        ? `CODEX_HOME="${profileDir}" `
        : profileDir && providerId === "claude"
          ? `CLAUDE_CONFIG_DIR="${profileDir}" `
          : profileDir && providerId === "gemini"
            ? `GEMINI_CLI_HOME="${profileDir}" `
            : profileDir && providerId === "copilot"
              ? `COPILOT_HOME="${profileDir}" `
              : "";
    const baseLoginArgs = descriptor.loginArgs;
    const loginArgs =
      providerId === "codex" &&
      remoteDeployment &&
      baseLoginArgs &&
      baseLoginArgs.length === 1 &&
      baseLoginArgs[0] === "login"
        ? ["login", "--device-auth"]
        : baseLoginArgs;
    const terminalCommand = loginArgs && loginArgs.length > 0
      ? `${envPrefix}${binaryDisplay} ${loginArgs.join(" ")}`
      : `${envPrefix}${binaryDisplay}`;

    const key = `provider:${providerId}:${accountId ?? ""}`;
    if (this.closed || this.loginStartGenerations.get(key) !== generation) {
      throw new HttpError(409, "A newer sign-in request replaced this one.");
    }

    if (!loginArgs || loginArgs.length === 0) {
      const loginId = randomUUID();
      this.loginAttempts.set(key, {
        loginId,
        status: "done",
        message: `Run \`${terminalCommand}\` in a terminal once to complete interactive sign-in.`,
      });
      return {
        status: "interactive",
        url: null,
        code: null,
        needsCodeInput: false,
        loginId,
        terminalCommand,
        message: `Run \`${terminalCommand}\` in a terminal once to complete interactive sign-in.`,
      };
    }

    if (!probe.available && !account?.binaryPath) {
      throw new HttpError(
        503,
        `${descriptor.displayName} CLI (${descriptor.binaryName ?? providerId}) is not installed. Run \`${terminalCommand}\` once installed.`,
      );
    }

    const plan = planProviderCli({
      providerId,
      platform: this.options.platform,
      runtime,
      distro: probe.distro ?? this.wslDistro(),
      binaryPath: account?.binaryPath ?? probe.binaryPath ?? null,
      args: loginArgs,
    });

    const previous = this.loginChildren.get(key);
    if (previous) {
      previous.kill();
      this.loginChildren.delete(key);
    }

    const attempt = {
      loginId: randomUUID(),
      status: "waiting" as "waiting" | "done" | "error",
      message: undefined as string | undefined,
      url: null as string | null,
      code: null as string | null,
      needsCodeInput: false,
      waiters: [] as (() => void)[],
    };
    const notifyWaiters = () => {
      const list = attempt.waiters.splice(0, attempt.waiters.length);
      for (const fn of list) {
        fn();
      }
    };
    this.loginAttempts.set(key, attempt);
    let child: LoginChild;
    try {
      child = this.options.loginSpawn(plan.command, plan.args, { env: loginEnv });
    } catch {
      attempt.status = "error";
      attempt.message = `${descriptor.displayName} could not start sign-in. You can also run \`${terminalCommand}\` in a terminal.`;
      throw new HttpError(503, attempt.message);
    }
    this.loginChildren.set(key, child);
    this.providerProbeCache = null;

    return new Promise((resolvePromise, reject) => {
      let settled = false;
      let accumulated = "";
      let urlSettleTimer: ReturnType<typeof setTimeout> | null = null;
      let completionTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        if (attempt.status === "waiting") {
          attempt.status = "error";
          attempt.message = "Sign-in timed out.";
          notifyWaiters();
        }
        child.kill();
      }, LOGIN_COMPLETE_TIMEOUT_MS);
      completionTimer.unref?.();

      const resolveWaiting = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (urlSettleTimer) {
          clearTimeout(urlSettleTimer);
          urlSettleTimer = null;
        }
        resolvePromise({
          status: "waiting",
          url: attempt.url,
          code: attempt.code,
          needsCodeInput: attempt.needsCodeInput,
          loginId: attempt.loginId,
          terminalCommand,
          ...(attempt.message ? { message: attempt.message } : {}),
        });
      };

      const timer = setTimeout(() => {
        if (settled) return;
        attempt.message = `Finish sign-in in your browser or run \`${terminalCommand}\` in a terminal.`;
        resolveWaiting();
      }, 12_000);
      timer.unref?.();

      const onData = (chunk: unknown) => {
        accumulated = (accumulated + String(chunk)).slice(-32_768);
        const parsed = parseProviderLoginOutput(accumulated);
        if (parsed.url) {
          attempt.url = parsed.url;
        }
        if (parsed.code) {
          attempt.code = parsed.code;
        }
        if (parsed.needsCodeInput) {
          attempt.needsCodeInput = true;
        }
        if (!settled && attempt.url) {
          if (parsed.urlComplete && (attempt.code !== null || attempt.needsCodeInput)) {
            resolveWaiting();
          } else if (!urlSettleTimer) {
            urlSettleTimer = setTimeout(resolveWaiting, 80);
            urlSettleTimer.unref?.();
          }
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", (chunk: unknown) => {
        onData(chunk);
        if (settled && attempt.status === "waiting") {
          const errMsg = extractLoginFailureMessage(String(chunk));
          if (errMsg) {
            attempt.message = errMsg;
            notifyWaiters();
          }
        }
      });
      child.on("close", (exitCode) => {
        if (completionTimer) {
          clearTimeout(completionTimer);
          completionTimer = null;
        }
        if (urlSettleTimer) {
          clearTimeout(urlSettleTimer);
          urlSettleTimer = null;
        }
        if (this.loginChildren.get(key) === child) this.loginChildren.delete(key);
        this.providerProbeCache = null;
        if (exitCode === 0) {
          attempt.status = "done";
          attempt.message = undefined;
          notifyWaiters();
          void this.onLoginCompleted(providerId, accountId);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolvePromise({
              status: "done",
              url: attempt.url,
              code: attempt.code,
              needsCodeInput: attempt.needsCodeInput,
              loginId: attempt.loginId,
              terminalCommand,
            });
          }
          return;
        }
        if (attempt.status === "waiting") {
          attempt.status = "error";
          const detail = extractLoginFailureMessage(accumulated);
          attempt.message = detail
            ? `${detail} You can retry sign-in or run \`${terminalCommand}\` in a terminal.`
            : `Sign-in exited before completing. Run \`${terminalCommand}\` in a terminal if needed.`;
        }
        notifyWaiters();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolvePromise({
            status: "interactive",
            url: attempt.url,
            code: attempt.code,
            needsCodeInput: attempt.needsCodeInput,
            loginId: attempt.loginId,
            terminalCommand,
            message: attempt.message,
          });
        }
      });
      child.on("error", () => {
        if (completionTimer) {
          clearTimeout(completionTimer);
          completionTimer = null;
        }
        if (urlSettleTimer) {
          clearTimeout(urlSettleTimer);
          urlSettleTimer = null;
        }
        if (this.loginChildren.get(key) === child) this.loginChildren.delete(key);
        attempt.status = "error";
        attempt.message = `Could not launch ${descriptor.displayName} login.`;
        notifyWaiters();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new HttpError(503, attempt.message));
        }
      });
    });
  }

  private async generateApiThreadTitle(
    session: SessionRecord,
    firstText: string,
    modelOverride: string | null,
  ): Promise<string | null> {
    const account = session.accountId
      ? this.store.getProviderAccount(session.accountId)
      : (this.store.listProviderAccounts("api")[0] ?? null);
    if (!account) return null;
    const apiKey = this.profilesFor().resolveApiKey(account);
    const baseUrl = account.apiBaseUrl ?? "https://api.openai.com/v1";
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(baseUrl);
    if (!apiKey && !local) return null;
    const model = modelOverride ?? session.modelId ?? account.defaultModelId ?? "gpt-5.3-codex";
    const kind = account.apiKind ?? "openai";
    const brain =
      kind === "anthropic"
        ? new AnthropicProvider({ baseUrl, model, apiKey, local, defaultMaxTokens: 128 })
        : kind === "google"
          ? new GoogleGenAiProvider({ baseUrl, model, apiKey, local })
          : new OpenAiCompatibleProvider({ baseUrl, model, apiKey, local });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 12_000);
    timeout.unref?.();
    let out = "";
    try {
      for await (const delta of brain.stream({
        messages: [
          { role: "system", content: "Reply with a short, specific 3 to 6 word title for the user's request, with no quotes or punctuation." },
          { role: "user", content: buildThreadTitlePrompt(firstText) },
        ],
        tools: [],
        maxTokens: 128,
        signal: abort.signal,
      })) {
        if (delta.type === "text") out += delta.delta;
      }
      return out.trim() || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private providerQuotasView(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const addEntry = (providerId: ProviderId, accountId: string | null, accountName: string | null) => {
      if (providerId === "muse") return;
      const pKey = `${providerId}::${accountId ?? "default"}`;
      if (seen.has(pKey)) return;
      seen.add(pKey);
      const descriptor = descriptorForProvider(providerId);
      const scope = `provider-quota:${providerId}:${accountId ?? "default"}`;
      const usage = this.providerUsageByKey.get(pKey) ?? this.store.getSubscriptionUsage(scope);
      if (usage && !this.providerUsageByKey.has(pKey)) {
        this.providerUsageByKey.set(pKey, usage);
      }
      out.push({
        providerId,
        displayName: descriptor.displayName,
        accountId,
        accountName,
        quotaSupport: descriptor.capabilities.quotaSupport,
        usageDashboardUrl: descriptor.usageDashboardUrl,
        usage: usage ?? null,
      });
    };

    for (const host of this.hosts.values()) {
      if (host.providerId !== "muse") {
        const acc = host.accountId ? this.store.getProviderAccount(host.accountId) : null;
        addEntry(host.providerId, host.accountId, acc?.name ?? null);
      }
    }
    for (const acc of this.store.listProviderAccounts()) {
      addEntry(acc.providerId, acc.id, acc.name);
    }
    for (const [pKey] of this.providerUsageByKey) {
      const idx = pKey.indexOf("::");
      if (idx > 0) {
        const providerId = this.normalizeProviderId(pKey.slice(0, idx));
        const rawAcc = pKey.slice(idx + 2);
        const accountId = rawAcc === "default" ? null : rawAcc;
        const acc = accountId ? this.store.getProviderAccount(accountId) : null;
        addEntry(providerId, accountId, acc?.name ?? null);
      }
    }
    return out;
  }
}

function titleFromEvents(eventList: { method: string; params: Record<string, unknown> }[]): string | null {
  for (const ev of eventList) {
    const itemRec = asRecord(ev.params["item"]);
    if (itemRec && itemRec["kind"] === "userMessage") {
      const promptText = str(itemRec["displayText"]) ?? str(itemRec["text"]) ?? "";
      const derived = deriveTitle(promptText);
      if (derived) {
        return derived;
      }
    }
  }
  const noFirstPromptFound = null;
  return noFirstPromptFound;
}

/** Extracts the prompt text of the first user message event for thread titling. */
function firstUserText(eventList: { method: string; params: Record<string, unknown> }[]): string | null {
  for (const ev of eventList) {
    const itemRec = asRecord(ev.params["item"]);
    if (itemRec && itemRec["kind"] === "userMessage") {
      const userMsg = str(itemRec["displayText"]) ?? str(itemRec["text"]) ?? "";
      if (userMsg.trim().length > 0) {
        return userMsg;
      }
    }
  }
  const noFirstUserTextFound = null;
  return noFirstUserTextFound;
}

export async function resolveMusePath(
  currentPlatform: string,
  targetDistro: string,
): Promise<string | null> {
  if (currentPlatform === "win32") {
    const envProbe = await probeEnvironment(defaultExec, currentPlatform);
    void targetDistro;
    return envProbe.musePath;
  }
  const result = await defaultExec("sh", ["-lc", "command -v muse"]);
  if (result.exitCode !== 0) {
    const noMusePathFound = null;
    return noMusePathFound;
  }
  const lines = result.stdout.split("\n").map((line) => line.trim());
  return lines.find((line) => line.length > 0) ?? null;
}

export { resolveMuseInDistro };
