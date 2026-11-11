import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  defaultExec,
  descriptorForProvider,
  planProviderCli,
  toWslPath,
  type ExecFn,
  type MuseRuntime,
  type ProviderAccountRecord,
  type ProviderId,
} from "@ancilla/daemon";
import type { SecretStore } from "../connectors/secrets.js";

function windowsToWslPath(p: string): string | null {
  try {
    return toWslPath(p);
  } catch {
    return null;
  }
}

export interface ProviderAuthStatus {
  state: "authenticated" | "unauthenticated" | "ready" | "missing-key" | "unknown";
  summary: string | null;
  email: string | null;
  planTier: string | null;
  authMethod: string | null;
}

export function detectAmbientKeyOverrides(
  providerId: ProviderId,
  baseEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const descriptor = descriptorForProvider(providerId);
  return descriptor.ambientApiKeyEnvVars.filter((name) => {
    const val = baseEnv[name];
    return typeof val === "string" && val.trim().length > 0;
  });
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "default";
}

function appendWslEnvVar(existingWslEnv: string | undefined, varName: string): string {
  const entries = (existingWslEnv ?? "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!entries.some((e) => e === varName || e.startsWith(`${varName}/`))) {
    entries.push(varName);
  }
  return entries.join(":");
}

function removeFromWslEnv(existingWslEnv: string | undefined, blockedVars: ReadonlySet<string>): string | undefined {
  if (!existingWslEnv) return existingWslEnv;
  const kept = existingWslEnv
    .split(":")
    .map((s) => s.trim())
    .filter((entry) => {
      if (!entry) return false;
      const base = entry.split("/")[0] ?? "";
      return !blockedVars.has(base);
    });
  return kept.length > 0 ? kept.join(":") : undefined;
}

export class ProfileIsolator {
  constructor(
    private readonly dataDir: string | null,
    private readonly secrets: SecretStore | null = null,
  ) {}

  /** Directory owned by Ancilla for isolating a named CLI profile (`<dataDir>/profiles/<provider>/<account>`). */
  profileDir(providerId: ProviderId, accountId: string): string | null {
    if (!this.dataDir) return null;
    const dir = join(
      this.dataDir,
      "profiles",
      sanitizeSegment(providerId),
      sanitizeSegment(accountId),
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Secret key identifier in `FileSecretStore` for an `api` provider account. */
  secretKeyForAccount(accountId: string): string {
    return `provider:api:${accountId}`;
  }

  resolveApiKey(account: ProviderAccountRecord | null): string | null {
    if (!account || !this.secrets) return null;
    const keyId = account.secretKeyId ?? this.secretKeyForAccount(account.id);
    return this.secrets.get(keyId);
  }

  setApiKey(accountId: string, apiKey: string): string {
    if (!this.secrets) {
      throw new Error("Secret storage is unavailable.");
    }
    const keyId = this.secretKeyForAccount(accountId);
    this.secrets.set(keyId, apiKey.trim());
    return keyId;
  }

  deleteApiKey(account: ProviderAccountRecord | null): void {
    if (!account || !this.secrets) return;
    const keyId = account.secretKeyId ?? this.secretKeyForAccount(account.id);
    this.secrets.delete(keyId);
  }

  /** Lists ambient API-key env vars currently present in `baseEnv` for a subscription CLI provider. */
  detectAmbientKeyOverrides(
    providerId: ProviderId,
    baseEnv: NodeJS.ProcessEnv = process.env,
  ): string[] {
    const descriptor = descriptorForProvider(providerId);
    return descriptor.ambientApiKeyEnvVars.filter((name) => {
      const val = baseEnv[name];
      return typeof val === "string" && val.trim().length > 0;
    });
  }

  /**
   * Builds a clean child-process environment for spawning a CLI provider (`serve` or `login` or status probe).
   * - Isolates named accounts (`accountId !== null`) using official CLI home env vars (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, etc.).
   * - Strips ambient pay-per-token API keys when `stripAmbientKeys` is enabled so subscription turns never silently bill API keys.
   */
  buildCliEnv(options: {
    providerId: ProviderId;
    accountId: string | null;
    account?: ProviderAccountRecord | null;
    viaWsl?: boolean;
    baseEnv?: NodeJS.ProcessEnv;
  }): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(options.baseEnv ?? process.env) };
    const descriptor = descriptorForProvider(options.providerId);
    const stripAmbient = options.account ? options.account.stripAmbientKeys : true;

    if (stripAmbient && descriptor.ambientApiKeyEnvVars.length > 0) {
      const blocked = new Set(descriptor.ambientApiKeyEnvVars);
      for (const key of blocked) {
        delete env[key];
      }
      const cleanedWslEnv = removeFromWslEnv(env["WSLENV"], blocked);
      if (cleanedWslEnv === undefined) {
        delete env["WSLENV"];
      } else {
        env["WSLENV"] = cleanedWslEnv;
      }
    }

    if (!options.accountId || options.providerId === "muse" || options.providerId === "api") {
      return env;
    }

    const hostDir = this.profileDir(options.providerId, options.accountId);
    if (!hostDir) {
      return env;
    }

    const targetDir = options.viaWsl ? (windowsToWslPath(hostDir) ?? hostDir) : hostDir;
    const setIsolatedVar = (varName: string, value: string): void => {
      env[varName] = value;
      if (options.viaWsl) {
        env["WSLENV"] = appendWslEnvVar(env["WSLENV"], varName);
      }
    };

    switch (options.providerId) {
      case "codex":
        setIsolatedVar("CODEX_HOME", targetDir);
        break;
      case "claude":
        setIsolatedVar("CLAUDE_CONFIG_DIR", targetDir);
        break;
      case "gemini":
        setIsolatedVar("GEMINI_CLI_HOME", targetDir);
        break;
      case "copilot": {
        const cfg = join(hostDir, "config");
        const state = join(hostDir, "state");
        mkdirSync(cfg, { recursive: true, mode: 0o700 });
        mkdirSync(state, { recursive: true, mode: 0o700 });
        setIsolatedVar("COPILOT_HOME", targetDir);
        setIsolatedVar("XDG_CONFIG_HOME", options.viaWsl ? (windowsToWslPath(cfg) ?? cfg) : cfg);
        setIsolatedVar("XDG_STATE_HOME", options.viaWsl ? (windowsToWslPath(state) ?? state) : state);
        break;
      }
      default: {
        const cfg = join(hostDir, "config");
        const state = join(hostDir, "state");
        const data = join(hostDir, "data");
        mkdirSync(cfg, { recursive: true, mode: 0o700 });
        mkdirSync(state, { recursive: true, mode: 0o700 });
        mkdirSync(data, { recursive: true, mode: 0o700 });
        setIsolatedVar("XDG_CONFIG_HOME", options.viaWsl ? (windowsToWslPath(cfg) ?? cfg) : cfg);
        setIsolatedVar("XDG_STATE_HOME", options.viaWsl ? (windowsToWslPath(state) ?? state) : state);
        setIsolatedVar("XDG_DATA_HOME", options.viaWsl ? (windowsToWslPath(data) ?? data) : data);
        break;
      }
    }

    return env;
  }

  /**
   * Probes non-Muse provider sign-in state strictly through official CLI status subcommands or API key presence.
   * Never reads, opens, or parses third-party OAuth credential files (`auth.json`, `.credentials.json`, `oauth_creds.json`).
   */
  async probeAuthStatus(options: {
    providerId: ProviderId;
    accountId: string | null;
    account?: ProviderAccountRecord | null;
    binaryAvailable: boolean;
    binaryPath?: string | null;
    runtime?: MuseRuntime | "builtin";
    distro?: string | null;
    platform?: string;
    exec?: ExecFn;
  }): Promise<ProviderAuthStatus> {
    const { providerId, accountId, account } = options;

    if (providerId === "api") {
      if (!account) {
        return {
          state: "missing-key",
          summary: "Add an API or local endpoint in Settings -> Providers.",
          email: null,
          planTier: null,
          authMethod: "api-key",
        };
      }
      const baseUrl = account.apiBaseUrl ?? "";
      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(baseUrl);
      const hasKey = this.resolveApiKey(account) !== null;
      if (hasKey || isLocal) {
        return {
          state: "ready",
          summary: isLocal && !hasKey ? "Local endpoint (no key required)" : "API key stored locally",
          email: null,
          planTier: account.apiKind ?? "openai",
          authMethod: isLocal && !hasKey ? "local" : "api-key",
        };
      }
      return {
        state: "missing-key",
        summary: "API key not configured",
        email: null,
        planTier: account.apiKind ?? "openai",
        authMethod: "api-key",
      };
    }

    if (!options.binaryAvailable) {
      return {
        state: "unknown",
        summary: "CLI not installed",
        email: null,
        planTier: null,
        authMethod: null,
      };
    }

    const exec = options.exec ?? defaultExec;
    const viaWsl = (options.platform ?? process.platform) === "win32" && options.runtime === "wsl";
    const env = this.buildCliEnv({ providerId, accountId, account, viaWsl });
    const runtime = options.runtime === "builtin" ? undefined : options.runtime;

    if (providerId === "claude") {
      try {
        const plan = planProviderCli({
          providerId: "claude",
          platform: options.platform,
          runtime,
          distro: options.distro,
          binaryPath: account?.binaryPath ?? options.binaryPath,
          args: ["auth", "status", "--json"],
        });
        const res = await exec(plan.command, plan.args, { env, timeoutMs: 6_000 });
        if (res.stdout.trim().startsWith("{")) {
          const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
          const loggedIn = parsed["loggedIn"] === true;
          const email = typeof parsed["email"] === "string" && parsed["email"].trim() ? parsed["email"].trim() : null;
          const subType =
            typeof parsed["subscriptionType"] === "string" && parsed["subscriptionType"].trim()
              ? parsed["subscriptionType"].trim()
              : null;
          const authMethod =
            typeof parsed["authMethod"] === "string" && parsed["authMethod"].trim()
              ? parsed["authMethod"].trim()
              : null;
          return {
            state: loggedIn ? "authenticated" : "unauthenticated",
            summary: loggedIn ? `Signed in${subType ? ` (${subType})` : ""}` : "Run `claude auth login` to sign in",
            email,
            planTier: subType,
            authMethod,
          };
        }
      } catch {
        /* fall through to unknown */
      }
    }

    if (providerId === "codex") {
      try {
        const plan = planProviderCli({
          providerId: "codex",
          platform: options.platform,
          runtime,
          distro: options.distro,
          binaryPath: account?.binaryPath ?? options.binaryPath,
          args: ["login", "status"],
        });
        const res = await exec(plan.command, plan.args, { env, timeoutMs: 6_000 });
        const combined = `${res.stdout}\n${res.stderr}`.trim();
        if (res.exitCode === 0 && !/not logged in/i.test(combined)) {
          return {
            state: "authenticated",
            summary: combined.split("\n")[0]?.trim() || "Signed in to Codex",
            email: null,
            planTier: null,
            authMethod: /chatgpt/i.test(combined) ? "chatgpt" : "cli",
          };
        }
        if (/not logged in/i.test(combined) || res.exitCode !== 0) {
          return {
            state: "unauthenticated",
            summary: "Run `codex login` to sign in with ChatGPT",
            email: null,
            planTier: null,
            authMethod: null,
          };
        }
      } catch {
        /* fall through */
      }
    }

    // For ACP CLIs without a non-interactive JSON status flag, check only directory emptiness on named profiles
    // without ever opening or reading any credential files.
    if (accountId && this.dataDir) {
      const dir = this.profileDir(providerId, accountId);
      if (dir) {
        try {
          const entries = readdirSync(dir);
          if (entries.length === 0) {
            return {
              state: "unknown",
              summary: "Profile created; sign in via CLI if prompted",
              email: null,
              planTier: null,
              authMethod: null,
            };
          }
        } catch {
          /* ignore */
        }
      }
    }

    return {
      state: "ready",
      summary: "CLI detected (uses official CLI login)",
      email: null,
      planTier: null,
      authMethod: "cli",
    };
  }
}
