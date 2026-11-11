import type { CommandConnection, SubscriptionUsage } from "../sessions.js";
import type { ServeExit, ServeTarget } from "../mspHost.js";

export type BuiltinProviderId =
  | "muse"
  | "codex"
  | "claude"
  | "gemini"
  | "copilot"
  | "kimi"
  | "qwen"
  | "opencode"
  | "acp-custom"
  | "api";

export type ProviderId = BuiltinProviderId | `acp:${string}`;

export const BUILTIN_PROVIDER_IDS: readonly BuiltinProviderId[] = [
  "muse",
  "codex",
  "claude",
  "gemini",
  "copilot",
  "kimi",
  "qwen",
  "opencode",
  "acp-custom",
  "api",
];

export function isProviderId(value: unknown): value is ProviderId {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  if ((BUILTIN_PROVIDER_IDS as readonly string[]).includes(value)) {
    return true;
  }
  return /^acp:[a-z0-9][a-z0-9_-]{0,62}$/i.test(value);
}

export function normalizeProviderId(value: unknown): ProviderId {
  return isProviderId(value) ? value : "muse";
}

export type ProviderTransport =
  | "msp"
  | "codex-app-server"
  | "acp"
  | "claude-stream-json"
  | "http-api";

export interface ProviderCapabilities {
  readonly transport: ProviderTransport;
  readonly authKind: "cli-subscription" | "api-key" | "none";
  readonly supportsResume: boolean;
  readonly supportsFork: boolean;
  readonly supportsCompact: boolean;
  readonly supportsSteer: boolean;
  readonly supportsReasoningEffort: boolean;
  readonly supportsApprovalModes: readonly ("allowAll" | "denyUnmatched" | "onRequest" | "promptUnmatched")[];
  readonly supportsInteractiveQuestions: boolean;
  readonly supportsSkills: boolean;
  readonly supportsGoals: boolean;
  readonly supportsSubagents: boolean;
  readonly supportsOutputPaging: boolean;
  readonly supportsImageAttachments: boolean;
  readonly supportsNativeWebSearch: boolean;
  readonly quotaSupport: "cli-direct" | "runtime-push" | "tier-only" | "api-ledger" | "none";
}

export interface ProviderModelSeed {
  modelId: string;
  displayLabel: string;
  description?: string;
  supportedReasoningEfforts?: readonly string[];
  defaultReasoningEffort?: string;
  contextWindowTokens?: number;
}

export interface ProviderDescriptor {
  readonly id: BuiltinProviderId;
  readonly displayName: string;
  readonly vendorName: string;
  readonly subscriptionSummary: string;
  readonly binaryName: string | null;
  readonly serveArgs: readonly string[];
  readonly loginArgs: readonly string[] | null;
  readonly versionArgs: readonly string[];
  /** Ambient API-key env vars that silently override subscription billing if left set. */
  readonly ambientApiKeyEnvVars: readonly string[];
  readonly installDocsUrl: string | null;
  readonly usageDashboardUrl: string | null;
  readonly capabilities: ProviderCapabilities;
  readonly fallbackModels: readonly ProviderModelSeed[];
}

export const MUSE_CAPABILITIES: ProviderCapabilities = {
  transport: "msp",
  authKind: "cli-subscription",
  supportsResume: true,
  supportsFork: true,
  supportsCompact: true,
  supportsSteer: true,
  supportsReasoningEffort: true,
  supportsApprovalModes: ["allowAll", "denyUnmatched", "onRequest", "promptUnmatched"],
  supportsInteractiveQuestions: true,
  supportsSkills: true,
  supportsGoals: true,
  supportsSubagents: true,
  supportsOutputPaging: true,
  supportsImageAttachments: true,
  supportsNativeWebSearch: true,
  quotaSupport: "cli-direct",
};

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  transport: "codex-app-server",
  authKind: "cli-subscription",
  supportsResume: true,
  supportsFork: true,
  supportsCompact: true,
  supportsSteer: true,
  supportsReasoningEffort: true,
  supportsApprovalModes: ["allowAll", "denyUnmatched", "onRequest", "promptUnmatched"],
  supportsInteractiveQuestions: true,
  supportsSkills: false,
  supportsGoals: false,
  supportsSubagents: false,
  supportsOutputPaging: true,
  supportsImageAttachments: true,
  supportsNativeWebSearch: true,
  quotaSupport: "cli-direct",
};

export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  transport: "claude-stream-json",
  authKind: "cli-subscription",
  supportsResume: true,
  supportsFork: true,
  supportsCompact: true,
  supportsSteer: false,
  supportsReasoningEffort: true,
  supportsApprovalModes: ["allowAll", "denyUnmatched", "onRequest", "promptUnmatched"],
  supportsInteractiveQuestions: true,
  supportsSkills: false,
  supportsGoals: false,
  supportsSubagents: false,
  supportsOutputPaging: true,
  supportsImageAttachments: true,
  supportsNativeWebSearch: true,
  quotaSupport: "tier-only",
};

export const ACP_CAPABILITIES: ProviderCapabilities = {
  transport: "acp",
  authKind: "cli-subscription",
  supportsResume: true,
  supportsFork: true,
  supportsCompact: false,
  supportsSteer: false,
  supportsReasoningEffort: false,
  supportsApprovalModes: ["allowAll", "onRequest", "promptUnmatched"],
  supportsInteractiveQuestions: false,
  supportsSkills: false,
  supportsGoals: false,
  supportsSubagents: false,
  supportsOutputPaging: true,
  supportsImageAttachments: true,
  supportsNativeWebSearch: true,
  quotaSupport: "tier-only",
};

export const API_CAPABILITIES: ProviderCapabilities = {
  transport: "http-api",
  authKind: "api-key",
  supportsResume: true,
  supportsFork: true,
  supportsCompact: true,
  supportsSteer: false,
  supportsReasoningEffort: true,
  supportsApprovalModes: ["allowAll", "denyUnmatched", "onRequest", "promptUnmatched"],
  supportsInteractiveQuestions: false,
  supportsSkills: false,
  supportsGoals: false,
  supportsSubagents: false,
  supportsOutputPaging: true,
  supportsImageAttachments: true,
  supportsNativeWebSearch: false,
  quotaSupport: "api-ledger",
};

export const PROVIDER_CATALOG: Readonly<Record<BuiltinProviderId, ProviderDescriptor>> = {
  muse: {
    id: "muse",
    displayName: "Muse Code",
    vendorName: "Meta",
    subscriptionSummary: "Meta AI / Muse Code plans",
    binaryName: "muse",
    serveArgs: ["serve"],
    loginArgs: ["login"],
    versionArgs: ["--version"],
    ambientApiKeyEnvVars: ["META_API_KEY"],
    installDocsUrl: "https://dev.meta.ai/",
    usageDashboardUrl: "https://dev.meta.ai/",
    capabilities: MUSE_CAPABILITIES,
    fallbackModels: [],
  },
  codex: {
    id: "codex",
    displayName: "Codex CLI",
    vendorName: "OpenAI",
    subscriptionSummary: "ChatGPT Plus, Pro, Team, Edu & Enterprise",
    binaryName: "codex",
    serveArgs: ["app-server", "--listen", "stdio://"],
    loginArgs: ["login"],
    versionArgs: ["--version"],
    ambientApiKeyEnvVars: ["OPENAI_API_KEY"],
    installDocsUrl: "https://github.com/openai/codex",
    usageDashboardUrl: "https://chatgpt.com/codex/settings/usage",
    capabilities: CODEX_CAPABILITIES,
    fallbackModels: [
      {
        modelId: "gpt-5.3-codex",
        displayLabel: "GPT-5.3 Codex",
        description: "Flagship agentic coding model",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
        contextWindowTokens: 400_000,
      },
      {
        modelId: "gpt-5.4",
        displayLabel: "GPT-5.4",
        description: "General reasoning and coding model",
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
        contextWindowTokens: 400_000,
      },
      {
        modelId: "gpt-5.2-codex-mini",
        displayLabel: "GPT-5.2 Codex Mini",
        description: "Fast, lightweight coding model",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
        contextWindowTokens: 200_000,
      },
    ],
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    vendorName: "Anthropic",
    subscriptionSummary: "Claude Pro, Max, Team & Enterprise",
    binaryName: "claude",
    serveArgs: [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
    ],
    loginArgs: ["auth", "login"],
    versionArgs: ["--version"],
    ambientApiKeyEnvVars: ["ANTHROPIC_API_KEY"],
    installDocsUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
    usageDashboardUrl: "https://claude.ai/settings/usage",
    capabilities: CLAUDE_CAPABILITIES,
    fallbackModels: [
      {
        modelId: "claude-sonnet-4-6",
        displayLabel: "Claude Sonnet 4.6",
        description: "Balanced coding and reasoning model",
        supportedReasoningEfforts: ["low", "medium", "high", "max"],
        defaultReasoningEffort: "medium",
        contextWindowTokens: 200_000,
      },
      {
        modelId: "claude-opus-4-6",
        displayLabel: "Claude Opus 4.6",
        description: "Deepest reasoning and architecture model",
        supportedReasoningEfforts: ["low", "medium", "high", "max"],
        defaultReasoningEffort: "high",
        contextWindowTokens: 200_000,
      },
      {
        modelId: "claude-haiku-4-5",
        displayLabel: "Claude Haiku 4.5",
        description: "Fast responses for quick edits",
        supportedReasoningEfforts: ["none", "low", "medium"],
        defaultReasoningEffort: "low",
        contextWindowTokens: 200_000,
      },
    ],
  },
  gemini: {
    id: "gemini",
    displayName: "Gemini CLI",
    vendorName: "Google",
    subscriptionSummary: "Google AI Pro, AI Ultra & Gemini Code Assist",
    binaryName: "gemini",
    serveArgs: ["--acp"],
    loginArgs: null,
    versionArgs: ["--version"],
    ambientApiKeyEnvVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    installDocsUrl: "https://github.com/google-gemini/gemini-cli",
    usageDashboardUrl: "https://one.google.com/ai",
    capabilities: ACP_CAPABILITIES,
    fallbackModels: [
      {
        modelId: "gemini-2.5-pro",
        displayLabel: "Gemini 2.5 Pro",
        description: "Deep reasoning with 1M context window",
        contextWindowTokens: 1_000_000,
      },
      {
        modelId: "gemini-2.5-flash",
        displayLabel: "Gemini 2.5 Flash",
        description: "High-speed multimodal coding model",
        contextWindowTokens: 1_000_000,
      },
    ],
  },
  copilot: {
    id: "copilot",
    displayName: "GitHub Copilot CLI",
    vendorName: "GitHub",
    subscriptionSummary: "Copilot Free, Pro, Pro+, Business & Enterprise",
    binaryName: "copilot",
    serveArgs: ["--acp", "--stdio"],
    loginArgs: ["login"],
    versionArgs: ["--version"],
    ambientApiKeyEnvVars: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    installDocsUrl: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
    usageDashboardUrl: "https://github.com/settings/copilot",
    capabilities: ACP_CAPABILITIES,
    fallbackModels: [
      {
        modelId: "claude-sonnet-4.6",
        displayLabel: "Claude Sonnet 4.6 (Copilot)",
        contextWindowTokens: 200_000,
      },
      {
        modelId: "gpt-5.3-codex",
        displayLabel: "GPT-5.3 Codex (Copilot)",
        contextWindowTokens: 200_000,
      },
      {
        modelId: "gemini-2.5-pro",
        displayLabel: "Gemini 2.5 Pro (Copilot)",
        contextWindowTokens: 1_000_000,
      },
    ],
  },
  kimi: {
    id: "kimi",
    displayName: "Kimi Code CLI",
    vendorName: "Moonshot AI",
    subscriptionSummary: "Kimi Code & Allegretto/Moderato plans",
    binaryName: "kimi",
    serveArgs: ["acp"],
    loginArgs: ["login"],
    versionArgs: ["--version"],
    ambientApiKeyEnvVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    installDocsUrl: "https://www.kimi.com/coding",
    usageDashboardUrl: "https://www.kimi.com/coding",
    capabilities: ACP_CAPABILITIES,
    fallbackModels: [
      {
        modelId: "kimi-k2.5",
        displayLabel: "Kimi K2.5",
        contextWindowTokens: 256_000,
      },
    ],
  },
  qwen: {
    id: "qwen",
    displayName: "Qwen Code CLI",
    vendorName: "Alibaba Qwen",
    subscriptionSummary: "Qwen OAuth & Qwen Code plans",
    binaryName: "qwen",
    serveArgs: ["--acp"],
    loginArgs: null,
    versionArgs: ["--version"],
    ambientApiKeyEnvVars: ["OPENAI_API_KEY", "DASHSCOPE_API_KEY"],
    installDocsUrl: "https://github.com/QwenLM/qwen-code",
    usageDashboardUrl: null,
    capabilities: ACP_CAPABILITIES,
    fallbackModels: [
      {
        modelId: "qwen3-coder-plus",
        displayLabel: "Qwen3 Coder Plus",
        contextWindowTokens: 256_000,
      },
    ],
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode ACP",
    vendorName: "OpenCode",
    subscriptionSummary: "Any provider configured in local OpenCode CLI",
    binaryName: "opencode",
    serveArgs: ["acp"],
    loginArgs: ["auth", "login"],
    versionArgs: ["--version"],
    ambientApiKeyEnvVars: [],
    installDocsUrl: "https://opencode.ai/docs/acp/",
    usageDashboardUrl: null,
    capabilities: ACP_CAPABILITIES,
    fallbackModels: [],
  },
  "acp-custom": {
    id: "acp-custom",
    displayName: "Custom ACP Agent",
    vendorName: "Custom (ACP)",
    subscriptionSummary: "Any CLI speaking Agent Client Protocol over stdio",
    binaryName: null,
    serveArgs: [],
    loginArgs: null,
    versionArgs: ["--version"],
    ambientApiKeyEnvVars: [],
    installDocsUrl: "https://agentclientprotocol.com/",
    usageDashboardUrl: null,
    capabilities: ACP_CAPABILITIES,
    fallbackModels: [],
  },
  api: {
    id: "api",
    displayName: "Direct API & Local",
    vendorName: "BYOK / OpenRouter / Local",
    subscriptionSummary: "OpenRouter, Venice, OpenAI/Anthropic/Google API keys, Ollama, LM Studio",
    binaryName: null,
    serveArgs: [],
    loginArgs: null,
    versionArgs: [],
    ambientApiKeyEnvVars: [],
    installDocsUrl: null,
    usageDashboardUrl: null,
    capabilities: API_CAPABILITIES,
    fallbackModels: [
      {
        modelId: "openrouter/auto",
        displayLabel: "OpenRouter Auto",
        description: "Automatic routing on OpenRouter",
        contextWindowTokens: 200_000,
      },
    ],
  },
};

export function descriptorForProvider(providerId: ProviderId): ProviderDescriptor {
  if (providerId in PROVIDER_CATALOG) {
    return PROVIDER_CATALOG[providerId as BuiltinProviderId];
  }
  return PROVIDER_CATALOG["acp-custom"];
}

export function capabilitiesForProvider(providerId: ProviderId): ProviderCapabilities {
  return descriptorForProvider(providerId).capabilities;
}

export class UnsupportedCapabilityError extends Error {
  readonly kind = "unsupportedCapability";
  readonly status = 400;
  constructor(
    readonly providerId: ProviderId,
    readonly capability: string,
  ) {
    super(`${descriptorForProvider(providerId).displayName} does not support ${capability}.`);
    this.name = "UnsupportedCapabilityError";
  }
}

export interface StoredJournalEvent {
  seq: number;
  method: string;
  params: Record<string, unknown>;
  at: string;
}

/**
 * Optional durable event sink for non-Muse providers so reopening a thread after a server
 * restart replays the full transcript, diffs, tool calls and usage without needing a live daemon.
 */
export interface SessionJournal {
  append(sessionId: string, method: string, params: Record<string, unknown>, at?: string): number;
  list(sessionId: string): StoredJournalEvent[];
}

export interface AgentHostStartResult {
  initializeResult: unknown;
  fingerprintWarning: unknown;
}

export interface AgentHost {
  readonly providerId: ProviderId;
  readonly capabilities: ProviderCapabilities;
  readonly connection: CommandConnection;
  readonly recentStderr?: string;
  start(clientVersion: string): Promise<AgentHostStartResult>;
  close(): Promise<ServeExit>;
  onExit?(handler: (exit: ServeExit) => void): void;
}

export interface ProviderHostSpawnSpec {
  providerId: ProviderId;
  target: ServeTarget;
  journal?: SessionJournal;
  initialUsage?: SubscriptionUsage | null;
}
