import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { SubscriptionUsage, UsageWindow } from "@ancilla/daemon";

/** Only quota fields cross the local API. The mint response also contains a key and payment data. */
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

const ENDPOINT = "https://api.meta.ai/muse-code/key";
const MAX_BYTES = 512 * 1024;
const MAX_DATE_MS = 8_640_000_000_000_000;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

async function authMetadata(path: string): Promise<Record<string, unknown> | null> {
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
      return record(record(record(JSON.parse(buffer.toString("utf8", 0, size)))?.["providers"])?.["meta"]);
    } finally { await file.close(); }
  } catch { return null; }
}

/** Match the actual auth path, including MUSE_AUTH_PATH, without putting a token in a durable cache key. */
export async function subscriptionIdentity(path: string): Promise<string | null> {
  const meta = await authMetadata(path);
  return meta?.["mechanism"] === "oauth" ? text(meta["user_email"]) : null;
}

interface Credential { token: string; email: string | null; fingerprint: string }
async function credential(path: string): Promise<Credential | null> {
  const meta = await authMetadata(path);
  const token = text(meta?.["access_token"]);
  // Dashboard and inference keys are a different credential lane and must never be sent to this endpoint.
  if (meta?.["mechanism"] !== "oauth" || !token?.startsWith("dca:") || /[\r\n]/.test(token)) return null;
  const email = text(meta["user_email"]);
  return { token, email, fingerprint: createHash("sha256").update(JSON.stringify([token, email])).digest("hex") };
}

function windowOf(value: unknown, short: boolean): UsageWindow | null {
  const window = record(value);
  const percent = window?.["used_percent"];
  const seconds = window?.["resets_at"];
  const duration = window?.["window_duration_mins"];
  if (typeof percent !== "number" || !Number.isSafeInteger(percent) || percent < 0 ||
    typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_DATE_MS / 1000 ||
    (short && (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration <= 0))) return null;
  return { usedPercent: percent, resetsAtMs: seconds * 1000, windowDurationMins: short ? duration as number : null };
}

/** Meta's mint timestamps are seconds; MSP's otherwise equivalent timestamps are milliseconds. */
export function parseMetaSubscription(value: unknown, observedAtMs: number): SubscriptionReading {
  const unavailable: SubscriptionReading = { usage: null, planName: null, status: "unavailable", checkedAtMs: observedAtMs };
  const root = record(value);
  if (!root || !Number.isFinite(observedAtMs) || observedAtMs <= 0 || observedAtMs > MAX_DATE_MS) return unavailable;
  if (["is_subs_active", "require_payment"].some((key) => root[key] != null && typeof root[key] !== "boolean")) return unavailable;
  const label = text(root["subs_tier_name"]);
  const planName = label && label.length <= 120 ? label : null;
  const base = { usage: null, planName, checkedAtMs: observedAtMs };
  if (root["is_subs_active"] === false || root["require_payment"] === true) return { ...base, status: "no-subscription" };
  if (root["is_subs_active"] !== true) return unavailable;
  if (root["subs_usage"] == null) return { ...base, status: "not-reported" };
  const usage = record(root["subs_usage"]);
  const window = windowOf(usage?.["window"], true);
  const weekly = windowOf(usage?.["weekly"], false);
  const tier = text(usage?.["tier"]);
  if (!window || !weekly || !tier) return { ...base, status: "unavailable" };
  return { ...base, status: "ready", usage: { tier, window, weekly, observedAtMs } };
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing quota response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) throw new Error("Quota response too large");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

interface CachedReading { fingerprint: string; expiresAt: number; reading: SubscriptionReading }
interface PendingReading { fingerprint: string; promise: Promise<SubscriptionReading | null> }

/**
 * Uses the same device-login exchange as Muse, without an inference call or a session. Inline CLI
 * credentials stay in this process; returned inference keys are discarded, never saved or exposed.
 * Keychain-only and WSL logins fall back to the running Muse host instead of prompting for secrets.
 */
export class MuseSubscriptionReader {
  private readonly cached = new Map<string, CachedReading>();
  private readonly pending = new Map<string, PendingReading>();
  private readonly abort = new AbortController();
  constructor(private readonly options: { fetch?: typeof fetch; now?: () => number; cacheMs?: number; timeoutMs?: number } = {}) {}

  close(): void { this.abort.abort(); this.cached.clear(); }

  async read(path: string): Promise<SubscriptionReading | null> {
    if (this.abort.signal.aborted) return null;
    const login = await credential(path);
    if (!login) { this.cached.delete(path); return null; }
    const now = this.options.now ?? Date.now;
    const cached = this.cached.get(path);
    if (cached?.fingerprint === login.fingerprint && cached.expiresAt > now()) return cached.reading;
    const pending = this.pending.get(path);
    if (pending?.fingerprint === login.fingerprint) return pending.promise;
    const entry: PendingReading = { fingerprint: login.fingerprint, promise: Promise.resolve(null) };
    entry.promise = (async () => {
      const { reading, retryMs } = await this.request(login);
      // A sign-out or account replacement during the HTTP request invalidates its result.
      const current = await credential(path);
      if (this.abort.signal.aborted || current?.fingerprint !== login.fingerprint) return null;
      this.cached.set(path, { fingerprint: login.fingerprint, expiresAt: now() + retryMs, reading });
      return reading;
    })().finally(() => { if (this.pending.get(path) === entry) this.pending.delete(path); });
    this.pending.set(path, entry);
    return entry.promise;
  }

  private async request(login: Credential): Promise<{ reading: SubscriptionReading; retryMs: number }> {
    const now = this.options.now ?? Date.now;
    // An observation is as of request send, not its eventual arrival after a newer runtime update.
    const checkedAtMs = now();
    const fallback: SubscriptionReading = { usage: null, planName: null, status: "unavailable", checkedAtMs };
    let retryMs = this.options.cacheMs ?? 15_000;
    try {
      const response = await (this.options.fetch ?? fetch)(ENDPOINT, {
        method: "POST", redirect: "error", body: "{}",
        headers: { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json", "x-api-version": "1.0.0", "User-Agent": "Ancilla" },
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.options.timeoutMs ?? 12_000)]),
      });
      if (response.status !== 200) {
        if (response.status === 429) {
          const delay = response.headers.get("retry-after");
          const seconds = delay === null ? NaN : Number(delay);
          const until = Number.isFinite(seconds) ? seconds * 1000 : delay ? Date.parse(delay) - now() : 60_000;
          retryMs = Math.max(retryMs, Math.min(300_000, Number.isFinite(until) ? Math.max(60_000, until) : 60_000));
        }
        await response.body?.cancel();
        return { reading: { ...fallback, status: response.status === 401 || response.status === 403 ? "login-required" : "unavailable" }, retryMs };
      }
      const decoded = await boundedJson(response);
      const email = text(record(decoded)?.["user_email"]);
      if (email && login.email && email.toLowerCase() !== login.email.toLowerCase()) return { reading: fallback, retryMs };
      return { reading: parseMetaSubscription(decoded, checkedAtMs), retryMs };
    } catch {
      // Network failures can carry request details. None of those strings belong in logs or the API.
      return { reading: fallback, retryMs };
    }
  }
}
