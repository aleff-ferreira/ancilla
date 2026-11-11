import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { SubscriptionUsage, UsageWindow } from "@ancilla/daemon";

/** Only quota fields cross the local API; raw CLI output and auth metadata stay inside this module. */
export interface SubscriptionReading {
  usage: SubscriptionUsage | null;
  planName: string | null;
  status: "ready" | "not-reported" | "no-subscription" | "login-required" | "unavailable";
  checkedAtMs: number;
}

export interface PlanAccountUsage {
  accountId: string | null;
  usage: SubscriptionUsage | null;
  planName: string | null;
  source: "meta" | "runtime" | "saved" | null;
  status: SubscriptionReading["status"] | "runtime-only";
  checkedAtMs: number | null;
}

export interface MuseUsageCliRequest {
  authPath: string;
  accountId: string | null;
  signal: AbortSignal;
}

export interface MuseUsageCliResult {
  exitCode: number | null;
  stdout: string;
  stderr?: string;
  timedOut?: boolean;
}

export type MuseUsageRunner = (request: MuseUsageCliRequest) => Promise<MuseUsageCliResult>;

const MAX_BYTES = 512 * 1024;
const MAX_DATE_MS = 8_640_000_000_000_000;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
const filled = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

interface AuthSummary {
  mechanism: string | null;
  userEmail: string | null;
  hasInlineOauth: boolean;
  fingerprint: string;
}

const opening = new Map<string, Promise<AuthSummary | null>>();

/**
 * One open per file at a time. A login on a share that does not answer (a WSL distro that is stopped or restarting)
 * holds a thread of libuv's four-thread pool for as long as it takes, and every further look that opened it again
 * would hold another, until nothing else in the process could read a file.
 */
function authMetadata(path: string): Promise<AuthSummary | null> {
  let pending = opening.get(path);
  if (!pending) {
    pending = readAuthMetadata(path).finally(() => {
      opening.delete(path);
    });
    opening.set(path, pending);
  }
  return pending;
}

async function readAuthMetadata(path: string): Promise<AuthSummary | null> {
  try {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_BYTES) return null;
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      // A bounded read also covers a file growing between stat and read.
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > MAX_BYTES) return null;
      const meta = record(record(record(JSON.parse(buffer.toString("utf8", 0, size)))?.["providers"])?.["meta"]);
      if (!meta) return null;
      const mechanism = filled(meta["mechanism"]);
      const userEmail = filled(meta["user_email"]);
      const rawToken = text(meta["access_token"]);
      // Never retain or return raw tokens; hash locally only to detect account switches and avoid Keychain-only prompts.
      const hasInlineOauth = mechanism === "oauth" && rawToken !== null && rawToken.startsWith("dca:") && !/[\r\n]/.test(rawToken);
      const tokenDigest = hasInlineOauth ? createHash("sha256").update(rawToken).digest("hex") : null;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([mechanism, text(userEmail), tokenDigest]))
        .digest("hex");
      return { mechanism, userEmail, hasInlineOauth, fingerprint };
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/** Match the actual auth path, including MUSE_AUTH_PATH, without putting a token in a durable cache key. */
export async function subscriptionIdentity(path: string): Promise<string | null> {
  const summary = await authMetadata(path);
  return summary?.mechanism === "oauth" ? text(summary.userEmail) : null;
}

/** An e-mail fit to show on a card: trimmed, at most 320 characters, no control, format or line-break characters. */
function showable(value: unknown): string | null {
  const email = filled(value)?.trim();
  return email && email.length <= 320 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(email) ? email : null;
}

/**
 * Who a saved login belongs to, as the same file reads for a login on this machine: it exists when the meta provider
 * has a mechanism, and the e-mail is its `user_email`, left out when it is not fit to show. Null whenever the file does
 * not show a login (missing, unreadable, not JSON, no mechanism), which says nothing about whether another store holds
 * one. Only these two fields leave: never the token, the name or anything else the file holds.
 */
export async function loginIdentity(path: string): Promise<{ hasLogin: true; email: string | null } | null> {
  const summary = await authMetadata(path);
  return !summary || summary.mechanism === null ? null : { hasLogin: true, email: showable(summary.userEmail) };
}

interface QueryableLogin {
  email: string | null;
  fingerprint: string;
}

async function queryableLogin(path: string): Promise<QueryableLogin | null> {
  const summary = await authMetadata(path);
  if (!summary?.hasInlineOauth) return null;
  return { email: text(summary.userEmail), fingerprint: summary.fingerprint };
}

function usageWindowOf(value: unknown, short: boolean): UsageWindow | null {
  const window = record(value);
  if (!window) return null;
  const percent = window["usedPercent"] ?? window["used_percent"];
  const duration = window["windowDurationMins"] ?? window["window_duration_mins"];
  let resetsAtMs: number | null = null;
  if (window["resetsAtMs"] !== undefined) {
    const ms = window["resetsAtMs"];
    if (typeof ms === "number" && Number.isFinite(ms) && ms > 0 && ms <= MAX_DATE_MS) {
      resetsAtMs = ms;
    }
  } else if (window["resets_at"] !== undefined) {
    const seconds = window["resets_at"];
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_DATE_MS / 1000) {
      resetsAtMs = seconds * 1000;
    }
  }
  if (
    typeof percent !== "number" ||
    !Number.isSafeInteger(percent) ||
    percent < 0 ||
    resetsAtMs === null ||
    (short && (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration <= 0))
  ) {
    return null;
  }
  return {
    usedPercent: percent,
    resetsAtMs,
    windowDurationMins: short ? (duration as number) : null,
  };
}

/** Parses `muse usage --json` JSON payloads (`{ schemaVersion, allowance, reason, hint }`). */
export function parseMuseUsage(value: unknown, observedAtMs: number): SubscriptionReading | null {
  const unavailable: SubscriptionReading = { usage: null, planName: null, status: "unavailable", checkedAtMs: observedAtMs };
  const root = record(value);
  if (!root || !Number.isFinite(observedAtMs) || observedAtMs <= 0 || observedAtMs > MAX_DATE_MS) return unavailable;

  const reason = text(root["reason"]);
  if (reason === "api_key") return null;

  const rawLabel = text(root["tierName"] ?? root["planName"] ?? root["subs_tier_name"]);
  const planName = rawLabel && rawLabel.length <= 120 ? rawLabel : null;
  const base = { usage: null, planName, checkedAtMs: observedAtMs };

  if (root["allowance"] === null || (root["allowance"] === undefined && reason !== null)) {
    if (reason === "server_sent_no_usage") return { ...base, status: "not-reported" };
    if (reason === "no_subscription" || reason === "payment_subscription_required" || reason === "subscription_inactive") {
      return { usage: null, planName: null, status: "no-subscription", checkedAtMs: observedAtMs };
    }
    if (reason === "credential_rejected" || reason === "not_logged_in") {
      return { ...base, status: "login-required" };
    }
    return { ...base, status: "unavailable" };
  }

  const allowance = record(root["allowance"]);
  if (!allowance) return unavailable;
  const window = usageWindowOf(allowance["window"], true);
  const weekly = usageWindowOf(allowance["weekly"], false);
  const tier = text(allowance["tier"]);
  let stamp = observedAtMs;
  if (allowance["observedAtMs"] !== undefined) {
    const rawStamp = allowance["observedAtMs"];
    if (typeof rawStamp !== "number" || !Number.isFinite(rawStamp) || rawStamp <= 0 || rawStamp > MAX_DATE_MS) {
      return { ...base, status: "unavailable" };
    }
    stamp = Math.min(rawStamp, observedAtMs);
  }
  if (!window || !weekly || !tier) return { ...base, status: "unavailable" };
  return { ...base, status: "ready", usage: { tier, window, weekly, observedAtMs: stamp } };
}

function classifyCliFailure(stderr: string, checkedAtMs: number): { reading: SubscriptionReading; rateLimited: boolean } {
  const lower = stderr.toLowerCase();
  if (/rate[_ -]?limit|too many requests|\b429\b/.test(lower)) {
    return { reading: { usage: null, planName: null, status: "unavailable", checkedAtMs }, rateLimited: true };
  }
  if (/credential_rejected|not logged in|run `muse login`|unauthenticated|unauthorized/.test(lower)) {
    return { reading: { usage: null, planName: null, status: "login-required", checkedAtMs }, rateLimited: false };
  }
  if (/payment_subscription_required|no_subscription|no active subscription/.test(lower)) {
    return { reading: { usage: null, planName: null, status: "no-subscription", checkedAtMs }, rateLimited: false };
  }
  return { reading: { usage: null, planName: null, status: "unavailable", checkedAtMs }, rateLimited: false };
}

function defaultRunUsage(request: MuseUsageCliRequest): Promise<MuseUsageCliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MUSE_AUTH_PATH: request.authPath };
    delete env["META_API_KEY"];
    execFile(
      "muse",
      ["usage", "--json"],
      { env, maxBuffer: MAX_BYTES + 1024, signal: request.signal, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const code = typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1;
        const aborted = request.signal.aborted || (error as { name?: string }).name === "AbortError";
        resolve({
          exitCode: code,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          ...(aborted ? { timedOut: true } : {}),
        });
      },
    );
  });
}

interface CachedReading {
  fingerprint: string;
  expiresAt: number;
  reading: SubscriptionReading | null;
}
interface PendingReading {
  fingerprint: string;
  promise: Promise<SubscriptionReading | null>;
}

/**
 * Queries subscription allowance through the official `muse usage --json` CLI command (no model turn, no persistent
 * `muse serve` host, and no direct HTTP token exchange). Keychain-only logins, API-key overrides, and named accounts
 * under WSL fall back to the running Muse host instead of prompting for secrets.
 */
export class MuseSubscriptionReader {
  private readonly cached = new Map<string, CachedReading>();
  private readonly pending = new Map<string, PendingReading>();
  private readonly abort = new AbortController();

  constructor(
    private readonly options: {
      runUsage?: MuseUsageRunner;
      now?: () => number;
      cacheMs?: number;
      timeoutMs?: number;
      rateLimitCooldownMs?: number;
    } = {},
  ) {}

  close(): void {
    this.abort.abort();
    this.cached.clear();
  }

  async read(path: string, accountId: string | null = null): Promise<SubscriptionReading | null> {
    if (this.abort.signal.aborted) return null;
    const login = await queryableLogin(path);
    if (!login) {
      this.cached.delete(path);
      return null;
    }
    const now = this.options.now ?? Date.now;
    const cached = this.cached.get(path);
    if (cached?.fingerprint === login.fingerprint && cached.expiresAt > now()) return cached.reading;
    const pending = this.pending.get(path);
    if (pending?.fingerprint === login.fingerprint) return pending.promise;
    const entry: PendingReading = { fingerprint: login.fingerprint, promise: Promise.resolve(null) };
    entry.promise = (async () => {
      const { reading, retryMs } = await this.request(path, accountId, login);
      // A sign-out or account replacement during the CLI call invalidates its result.
      const current = await queryableLogin(path);
      if (this.abort.signal.aborted || current?.fingerprint !== login.fingerprint) return null;
      this.cached.set(path, { fingerprint: login.fingerprint, expiresAt: now() + retryMs, reading });
      return reading;
    })().finally(() => {
      if (this.pending.get(path) === entry) this.pending.delete(path);
    });
    this.pending.set(path, entry);
    return entry.promise;
  }

  private async request(
    authPath: string,
    accountId: string | null,
    login: QueryableLogin,
  ): Promise<{ reading: SubscriptionReading | null; retryMs: number }> {
    const now = this.options.now ?? Date.now;
    // An observation is bounded by request start so a slow CLI call cannot outrank a newer runtime frame.
    const checkedAtMs = now();
    const fallback: SubscriptionReading = { usage: null, planName: null, status: "unavailable", checkedAtMs };
    let retryMs = this.options.cacheMs ?? 15_000;
    try {
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.options.timeoutMs ?? 12_000)]);
      const result = await (this.options.runUsage ?? defaultRunUsage)({ authPath, accountId, signal });
      if (result.timedOut || signal.aborted) return { reading: fallback, retryMs };
      if (Buffer.byteLength(result.stdout ?? "", "utf8") > MAX_BYTES) return { reading: fallback, retryMs };
      if (result.exitCode !== 0) {
        const failure = classifyCliFailure(result.stderr ?? "", checkedAtMs);
        if (failure.rateLimited) {
          retryMs = Math.max(retryMs, Math.min(300_000, this.options.rateLimitCooldownMs ?? 60_000));
        }
        return { reading: failure.reading, retryMs };
      }
      const decoded = JSON.parse(result.stdout);
      const root = record(decoded);
      const email = text(root?.["user_email"] ?? root?.["userEmail"]);
      if (email && login.email && email.toLowerCase() !== login.email.toLowerCase()) {
        return { reading: fallback, retryMs };
      }
      if (text(root?.["reason"]) === "rate_limited") {
        retryMs = Math.max(retryMs, Math.min(300_000, this.options.rateLimitCooldownMs ?? 60_000));
        return { reading: fallback, retryMs };
      }
      return { reading: parseMuseUsage(decoded, checkedAtMs), retryMs };
    } catch {
      return { reading: fallback, retryMs };
    }
  }
}
