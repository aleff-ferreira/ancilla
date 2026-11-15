/**
 * Central reactive application state store for Ancilla.
 * Implements useSyncExternalStore compatible subscription store and persistent preferences.
 */

import type {
  ApprovalMode, AssistantCharacterView, AttachmentView, EnvironmentStatus,
  ModelOption, ModelsStatus, OutgoingAttachment, PlanUsage,
  ProjectView, ReasoningEffort, SandboxSettings, SessionSummary,
  ResearchRunView, ResearchSettings, ShellRun, SkillEntry,
  TitleSettings, YoloSettings,
} from "../types.js";
import type { EchoAttachment, ThreadFold } from "./fold.js";
import type { ResearchStopAction, ResearchTyped } from "./research.js";
import type { UpdateState } from "./updates.js";
import {
  ASSISTANT_AVATAR_DEFAULT,
  ASSISTANT_AVATAR_MAX,
  ASSISTANT_AVATAR_MIN,
  clampAvatarSize,
  isValidAnchor,
  type AssistantAnchor,
  type AssistantWindowMode,
} from "./voice/floatingWindow.js";
import type { ModelsScope } from "./models.js";

export class Store<T> {
  private state: T;
  private readonly subscribers = new Set<() => void>();

  constructor(initialState: T) {
    this.state = initialState;
  }

  get = (): T => this.state;

  set = (producer: (current: T) => T): void => {
    const nextState = producer(this.state);
    if (nextState !== this.state) {
      this.state = nextState;
      for (const notifyListener of Array.from(this.subscribers)) {
        notifyListener();
      }
    }
  };

  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  };
}

export type GroupBy = "project" | "status";
export type ThemePref = "system" | "light" | "dark";

export const CODE_THEMES = ["ancilla", "ayu", "github", "vercel", "cursor", "catppuccin"] as const;
export type CodeTheme = (typeof CODE_THEMES)[number];

export const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2] as const;
export const ZOOM_MIN = ZOOM_STEPS[0];
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

export interface AssistantGlance {
  readonly enabled: boolean;
  readonly name: string;
  readonly character: AssistantCharacterView;
  readonly open: number;
  readonly needsYou: number;
  readonly running: number;
}

export interface Prefs {
  readonly groupBy: GroupBy;
  readonly theme: ThemePref;
  readonly codeTheme: CodeTheme;
  readonly sidebarWidth: number;
  readonly sidebarCollapsed: boolean;
  readonly collapsedProjects: string[];
  readonly openShelves: string[];
  readonly collapsedCards: string[];
  readonly openCards: string[];
  readonly hiddenCards: string[];
  readonly dismissedTurnErrors: string[];
  readonly notifications: boolean;
  readonly lastSeen: Record<string, string>;
  readonly baseline: string;
  readonly defaultMode: ApprovalMode;
  readonly defaultModelId: string | null;
  readonly defaultModelTried: boolean;
  readonly providerDefaultModels: Record<string, { modelId: string | null; tried: boolean }>;
  readonly effort: ReasoningEffort | null;
  readonly lastProject: string | null;
  readonly contributorAck: boolean;
  readonly autoUpdate: boolean;
  readonly updatesPaused: boolean;
  readonly zoom: number;
  readonly filesOpen: boolean;
  readonly filesWidth: number;
  readonly sidePanel: SidePanel;
  readonly crewWidth: number;
  readonly lastSeenVersion: string | null;
  readonly showTelemetry: boolean;
  readonly assistantInvite: "pulse" | "calm" | "hidden";
  readonly assistantPresence: boolean;
  readonly assistantFloat: boolean;
  readonly assistantWindowMode: AssistantWindowMode;
  readonly assistantAvatarSize: number;
  readonly assistantPosition: AssistantAnchor | null;
  readonly preYolo: { defaultMode: ApprovalMode; threads: Record<string, ApprovalMode | null> } | null;
}

export const DEFAULT_FILES_WIDTH = 480;
export const FILES_WIDTH_MIN = 320;
export const FILES_WIDTH_MAX = 1200;

export type SidePanel = "none" | "files" | "crew" | "browser";
export const DEFAULT_CREW_WIDTH = 520;
export const CREW_WIDTH_MIN = 400;
export const CREW_WIDTH_MAX = 800;

export type CrewFilter = "all" | "needs" | "failed" | "no-update" | "working" | "done";

export interface CrewPanelState {
  readonly mode: "roster" | "inspector";
  readonly inspectId: string | null;
  readonly filter: CrewFilter;
  readonly query: string;
  readonly timelineOpen: boolean;
  readonly openPhases: string[];
}

export interface CrewState {
  readonly panels: Record<string, CrewPanelState>;
  readonly activityOpen: boolean;
  readonly pending: Record<string, "retry" | "stop">;
  readonly skipped: string[];
  readonly leftAt: Record<string, number>;
  readonly dismissedReports: string[];
  readonly dismissedRecaps: string[];
}

export function emptyCrewPanel(): CrewPanelState {
  return {
    mode: "roster",
    inspectId: null,
    filter: "all",
    query: "",
    timelineOpen: true,
    openPhases: [],
  };
}

export function emptyCrewState(): CrewState {
  return {
    panels: {},
    activityOpen: false,
    pending: {},
    skipped: [],
    leftAt: {},
    dismissedReports: [],
    dismissedRecaps: [],
  };
}

export interface FilePanel {
  readonly tabs: string[];
  readonly active: string | null;
  readonly tree: boolean;
  readonly line: import("./files.js").LineRange | null;
}

export interface FileDraft {
  readonly content: string;
  readonly baseMtimeMs: number | null;
}

export const DEFAULT_SIDEBAR_WIDTH = 284;

export function defaultPrefs(now: string = new Date().toISOString()): Prefs {
  return Object.freeze<Prefs>({
    groupBy: "project" as const,
    theme: "system" as const,
    codeTheme: "ancilla" as const,
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    sidebarCollapsed: Boolean(false),
    collapsedProjects: [],
    openShelves: [],
    collapsedCards: [],
    openCards: [],
    hiddenCards: [],
    dismissedTurnErrors: [],
    notifications: Boolean(false),
    lastSeen: {},
    baseline: now,
    defaultMode: "onRequest" as const,
    defaultModelId: null,
    defaultModelTried: false,
    providerDefaultModels: {},
    effort: null,
    lastProject: null,
    contributorAck: Boolean(false),
    autoUpdate: Boolean(true),
    updatesPaused: Boolean(false),
    zoom: 1.0,
    filesOpen: Boolean(false),
    filesWidth: DEFAULT_FILES_WIDTH,
    sidePanel: "none" as const,
    crewWidth: DEFAULT_CREW_WIDTH,
    lastSeenVersion: null,
    showTelemetry: Boolean(false),
    assistantInvite: "pulse",
    assistantPresence: true,
    assistantFloat: false,
    assistantWindowMode: "float",
    assistantAvatarSize: ASSISTANT_AVATAR_DEFAULT,
    assistantPosition: null,
    preYolo: null,
  });
}

export type Route =
  | { readonly kind: "home" }
  | { readonly kind: "new"; readonly cwd: string | null }
  | { readonly kind: "thread"; readonly sessionId: string }
  | { readonly kind: "usage" }
  | { readonly kind: "settings" }
  | { readonly kind: "assistant" };

export interface ThreadState {
  readonly load: "idle" | "loading" | "ready" | "error";
  readonly error: string | null;
  readonly readOnly: boolean;
  readonly readOnlyReason: string | null;
  readonly truncated: boolean;
  readonly fold: ThreadFold;
  readonly attachments: AttachmentView[];
  readonly shellRuns: ShellRun[];
  readonly researchRuns: ResearchRunView[];
  readonly stalled: boolean;
  readonly historySync?: { checkedAt: number; progressAt: number | null };
  readonly stale?: boolean;
}

export interface Toast {
  readonly id: number;
  readonly tone: "error" | "info" | "success";
  readonly title: string;
  readonly detail?: string;
  readonly action?: { label: string; run: () => void };
}

export interface AppState {
  readonly boot: "loading" | "ready" | "error";
  readonly bootError: string | null;
  readonly env: EnvironmentStatus | null;
  readonly linuxSetup: import("../types.js").LinuxSetupView | null;
  readonly linuxSetupError: string | null;
  readonly linuxSetupAccountId: string | null;
  readonly linuxDesktop: import("../types.js").LinuxDesktopStatus | null;
  readonly linuxDesktopError: string | null;
  readonly connection: "connecting" | "open" | "lost";
  readonly projects: ProjectView[];
  readonly sessions: Record<string, SessionSummary>;
  readonly sessionsLoaded: boolean;
  readonly discovering: boolean;
  readonly route: Route;
  readonly threads: Record<string, ThreadState>;
  readonly models: ModelOption[];
  readonly accountModels: Record<string, ModelOption[]>;
  readonly modelsStatus: Record<string, ModelsStatus>;
  readonly titleSettings: TitleSettings | null;
  readonly sandboxSettings: SandboxSettings | null;
  readonly yoloSettings: YoloSettings | null;
  readonly researchSettings: ResearchSettings | null;
  readonly assistantRev: number;
  readonly assistantGlance: AssistantGlance | null;
  readonly assistantReaction: { mood: "delight" | "concern" | "attention"; at: number } | null;
  readonly researchStopWrites: boolean;
  readonly researchStopping: Record<string, ResearchStopAction>;
  readonly researchMode: boolean;
  readonly researchTyped: ResearchTyped;
  readonly prefs: Prefs;
  readonly toasts: Toast[];
  readonly paletteOpen: boolean;
  readonly addProjectOpen: boolean | { folderFor: string };
  readonly whatsNewOpen: boolean;
  readonly busy: Record<string, true>;
  readonly bypassAll: boolean;
  readonly bypassThreads: string[];
  readonly hostError: string | null;
  readonly draftHandoff: { key: string; text: string; attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] } | null;
  readonly updates: UpdateState | null;
  readonly skills: Record<string, SkillsState>;
  readonly picker: ComposerPicker | null;
  readonly planUsage: PlanUsage | null;
  readonly planUsageAccountId: string | null;
  readonly planUsageSaved: boolean;
  readonly planUsageSavedAccounts: string[];
  readonly planUsageStatus: import("../types.js").PlanUsageStatus;
  readonly planUsageLoading: boolean;
  readonly planUsageAccounts: import("../types.js").PlanAccountUsage[];
  readonly planUsageSelectedAccountId: string | null;
  readonly accounts: import("../types.js").AccountView[] | null;
  readonly metaApiKeyInherited: boolean;
  readonly defaultLogin: import("../types.js").DefaultLoginIdentity | null;
  readonly accountLogin: AccountLoginState | null;
  readonly planUsageByAccount: import("../types.js").PlanUsageByAccount;
  readonly providers: import("../types.js").ProviderView[] | null;
  readonly providerAccounts: import("../types.js").ProviderAccountView[];
  readonly ambientKeyOverrides: Record<string, string[]>;
  readonly remoteDeployment: boolean;
  readonly sourceOfferUrl: string | null;
  readonly providerQuotas: import("../types.js").ProviderQuotaView[];
  readonly providerLogin: ProviderAccountLoginState | null;
  readonly skipMuseOnboarding: boolean;
  readonly filePanels: Record<string, FilePanel>;
  readonly fileDrafts: Record<string, FileDraft>;
  readonly fileVersions: Record<string, number>;
  readonly fileTreeOpen: Record<string, string[]>;
  readonly crew: CrewState;
}

export type ComposerPicker =
  | "model"
  | "effort"
  | "permissions"
  | "confirmFullAccess"
  | "confirmBypass"
  | "confirmYolo"
  | "account"
  | "research";

export type AccountLoginState =
  | { accountId: string | null; url: string; code: string | null; status: "starting" | "waiting" | "done" | "timeout" | "error"; loginId?: string; message?: string }
  | { accountId: string | null; fallback: string };

export interface ProviderAccountLoginState {
  readonly providerId: import("../types.js").ProviderId;
  readonly accountId: string | null;
  readonly status: "starting" | "waiting" | "done" | "interactive" | "error";
  readonly url: string | null;
  readonly code: string | null;
  readonly needsCodeInput?: boolean;
  readonly submittingCode?: boolean;
  readonly loginId?: string;
  readonly terminalCommand?: string;
  readonly message?: string;
}

export interface SkillsState {
  readonly status: "loading" | "ready" | "error";
  readonly skills: SkillEntry[];
  readonly error: string | null;
  readonly loadedAt: number;
}

export function initialState(prefs: Prefs): AppState {
  const initialAppState: AppState = {
    boot: "loading" as const,
    bootError: null,
    env: null,
    linuxSetup: null,
    linuxSetupError: null,
    linuxSetupAccountId: null,
    linuxDesktop: null,
    linuxDesktopError: null,
    connection: "connecting" as const,
    projects: [],
    sessions: {},
    sessionsLoaded: Boolean(false),
    discovering: Boolean(false),
    route: { kind: "home" as const },
    threads: {},
    models: [],
    accountModels: {},
    modelsStatus: {},
    titleSettings: null,
    sandboxSettings: null,
    yoloSettings: null,
    researchSettings: null,
    assistantRev: 0,
    assistantGlance: null,
    assistantReaction: null,
    researchStopWrites: true,
    researchStopping: {},
    researchMode: false,
    researchTyped: { windowMin: null, windowMax: null, parallel: null },
    prefs,
    toasts: [],
    paletteOpen: Boolean(false),
    addProjectOpen: Boolean(false),
    whatsNewOpen: Boolean(false),
    busy: {},
    bypassAll: Boolean(false),
    bypassThreads: [],
    hostError: null,
    planUsage: null,
    planUsageAccountId: null,
    planUsageSaved: false,
    planUsageSavedAccounts: [],
    planUsageStatus: "unobserved",
    planUsageLoading: false,
    planUsageAccounts: [],
    planUsageSelectedAccountId: null,
    accounts: null,
    metaApiKeyInherited: Boolean(false),
    accountLogin: null,
    defaultLogin: null,
    planUsageByAccount: {},
    providers: null,
    providerAccounts: [],
    ambientKeyOverrides: {},
    remoteDeployment: false,
    sourceOfferUrl: null,
    providerQuotas: [],
    providerLogin: null,
    skipMuseOnboarding: false,
    filePanels: {},
    fileDrafts: {},
    fileVersions: {},
    fileTreeOpen: {},
    crew: emptyCrewState(),
    draftHandoff: null,
    updates: null,
    skills: {},
    picker: null,
  };
  return initialAppState;
}

function reviveProviderDefaultModels(
  raw: unknown,
  fallback: Record<string, { modelId: string | null; tried: boolean }>,
): Record<string, { modelId: string | null; tried: boolean }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fallback ?? {};
  }
  const result: Record<string, { modelId: string | null; tried: boolean }> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || !key) continue;
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const item = val as Record<string, unknown>;
      const modelId = typeof item["modelId"] === "string" ? item["modelId"] : null;
      const tried = modelId !== null && typeof item["tried"] === "boolean" ? item["tried"] : false;
      result[key] = { modelId, tried };
    }
  }
  return result;
}

export function revivePrefs(raw: unknown, fallback: Prefs): Prefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fallback;
  }
  const source = { ...(raw as Record<string, unknown>) };

  if (source.effort === "ultra") {
    source.effort = "max";
  }
  if (source.sidePanel === undefined && source.filesOpen === true) {
    source.sidePanel = "files";
  }
  if (source.sidePanel === "swarm") {
    source.sidePanel = "crew";
  }
  if (source.crewWidth === undefined && typeof source.swarmWidth === "number") {
    source.crewWidth = source.swarmWidth;
  }

  const selectProp = <K extends keyof Prefs>(propKey: K, isAcceptable: (val: unknown) => boolean): Prefs[K] => {
    const val = source[propKey];
    return isAcceptable(val) ? (val as Prefs[K]) : fallback[propKey];
  };

  const parsedSidePanel = selectProp("sidePanel", (s) => s === "none" || s === "files" || s === "crew" || s === "browser");
  const checkMode = (m: unknown): boolean =>
    m === "onRequest" || m === "promptUnmatched" || m === "denyUnmatched" || m === "allowAll";

  const checkPreYoloStructure = (v: unknown): boolean => {
    if (v === null) return true;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const snap = v as { defaultMode?: unknown; threads?: unknown };
    if (!checkMode(snap.defaultMode)) return false;
    if (typeof snap.threads !== "object" || snap.threads === null || Array.isArray(snap.threads)) return false;
    return Object.values(snap.threads).every((th) => th === null || checkMode(th));
  };

  const resolvedDefaultModel = selectProp("defaultModelId", (id) => id === null || typeof id === "string");

  return {
    groupBy: selectProp("groupBy", (g) => g === "project" || g === "status"),
    theme: selectProp("theme", (t) => t === "system" || t === "light" || t === "dark"),
    codeTheme: selectProp("codeTheme", (c) => CODE_THEMES.includes(c as CodeTheme)),
    sidebarWidth: selectProp("sidebarWidth", (w) => typeof w === "number" && w >= 220 && w <= 480),
    sidebarCollapsed: selectProp("sidebarCollapsed", (b) => typeof b === "boolean"),
    collapsedProjects: selectProp("collapsedProjects", (arr) => Array.isArray(arr) && arr.every((x) => typeof x === "string")),
    openShelves: selectProp("openShelves", (arr) => Array.isArray(arr) && arr.every((x) => typeof x === "string")),
    collapsedCards: selectProp("collapsedCards", (arr) => Array.isArray(arr) && arr.every((x) => typeof x === "string")),
    openCards: selectProp("openCards", (arr) => Array.isArray(arr) && arr.every((x) => typeof x === "string")),
    hiddenCards: selectProp("hiddenCards", (arr) => Array.isArray(arr) && arr.every((x) => typeof x === "string")),
    dismissedTurnErrors: selectProp("dismissedTurnErrors", (arr) => Array.isArray(arr) && arr.every((x) => typeof x === "string")),
    notifications: selectProp("notifications", (n) => typeof n === "boolean"),
    lastSeen: selectProp("lastSeen", (m) => typeof m === "object" && m !== null && !Array.isArray(m)),
    baseline: selectProp("baseline", (ts) => typeof ts === "string" && !Number.isNaN(Date.parse(ts))),
    defaultMode: selectProp("defaultMode", checkMode),
    defaultModelId: resolvedDefaultModel,
    defaultModelTried: resolvedDefaultModel !== null && selectProp("defaultModelTried", (b) => typeof b === "boolean"),
    providerDefaultModels: reviveProviderDefaultModels(source.providerDefaultModels, fallback.providerDefaultModels),
    effort: selectProp("effort", (e) => e === null || ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(e as string)),
    lastProject: selectProp("lastProject", (p) => p === null || typeof p === "string"),
    contributorAck: selectProp("contributorAck", (b) => typeof b === "boolean"),
    autoUpdate: selectProp("autoUpdate", (b) => typeof b === "boolean"),
    updatesPaused: selectProp("updatesPaused", (b) => typeof b === "boolean"),
    zoom: selectProp("zoom", (z) => typeof z === "number" && Number.isFinite(z) && z >= ZOOM_MIN && z <= ZOOM_MAX),
    filesOpen: parsedSidePanel === "files",
    filesWidth: selectProp("filesWidth", (w) => typeof w === "number" && w >= FILES_WIDTH_MIN && w <= FILES_WIDTH_MAX),
    sidePanel: parsedSidePanel,
    crewWidth: selectProp("crewWidth", (w) => typeof w === "number" && w >= CREW_WIDTH_MIN && w <= CREW_WIDTH_MAX),
    lastSeenVersion: selectProp("lastSeenVersion", (v) => v === null || typeof v === "string"),
    showTelemetry: selectProp("showTelemetry", (b) => typeof b === "boolean"),
    assistantInvite: selectProp("assistantInvite", (inv) => inv === "pulse" || inv === "calm" || inv === "hidden"),
    assistantPresence: selectProp("assistantPresence", (b) => typeof b === "boolean"),
    assistantFloat: selectProp("assistantFloat", (b) => typeof b === "boolean"),
    assistantWindowMode: selectProp("assistantWindowMode", (m) => m === "float" || m === "card"),
    assistantAvatarSize:
      typeof source.assistantAvatarSize === "number" && Number.isFinite(source.assistantAvatarSize)
        ? clampAvatarSize(source.assistantAvatarSize, fallback.assistantAvatarSize)
        : source.assistantAvatarSize === undefined
          ? fallback.assistantAvatarSize
          : selectProp("assistantAvatarSize", (s) => typeof s === "number" && Number.isFinite(s) && s >= ASSISTANT_AVATAR_MIN && s <= ASSISTANT_AVATAR_MAX),
    assistantPosition: selectProp("assistantPosition", (pos) => pos === null || isValidAnchor(pos)),
    preYolo: selectProp("preYolo", checkPreYoloStructure),
  };
}

export function providerKeyForScope(scope?: ModelsScope | string | null): string | null {
  if (!scope) {
    return null;
  }
  if (typeof scope === "string") {
    if (scope === "default" || scope === "muse" || scope.startsWith("acct:") || scope.startsWith("thread:")) {
      return null;
    }
    if (scope.startsWith("prov:")) {
      const parts = scope.split(":");
      const providerId = parts[1];
      const accountId = parts.slice(2).join(":");
      if (!providerId || providerId === "muse") {
        return null;
      }
      if (providerId === "api") {
        return `api:${accountId || "default"}`;
      }
      return accountId && accountId !== "default" ? `${providerId}:${accountId}` : providerId;
    }
    if (scope === "api") {
      return "api:default";
    }
    if (scope.startsWith("api:")) {
      return scope;
    }
    if (scope.includes(":")) {
      const [providerId, ...rest] = scope.split(":");
      if (providerId === "muse") {
        return null;
      }
      const accountId = rest.join(":");
      if (providerId === "api") {
        return `api:${accountId || "default"}`;
      }
      return accountId && accountId !== "default" ? `${providerId}:${accountId}` : providerId;
    }
    return scope;
  }
  const providerId = scope.providerId ?? null;
  if (!providerId || providerId === "muse") {
    return null;
  }
  if (providerId === "api") {
    return `api:${scope.accountId ?? "default"}`;
  }
  return scope.accountId && scope.accountId !== "default" ? `${providerId}:${scope.accountId}` : providerId;
}

export function defaultModelForScope(
  prefs: Prefs,
  scope?: ModelsScope | string | null,
): { modelId: string | null; tried: boolean } {
  const key = providerKeyForScope(scope);
  if (key === null) {
    return {
      modelId: prefs.defaultModelId,
      tried: prefs.defaultModelTried,
    };
  }
  const entry = prefs.providerDefaultModels?.[key];
  return {
    modelId: entry?.modelId ?? null,
    tried: entry?.tried ?? false,
  };
}

export function patchDefaultModelForScope(
  prefs: Prefs,
  scope: ModelsScope | string | null | undefined,
  modelId: string | null,
  tried: boolean,
): Partial<Prefs> {
  const key = providerKeyForScope(scope);
  if (key === null) {
    return {
      defaultModelId: modelId,
      defaultModelTried: modelId !== null && tried,
    };
  }
  return {
    providerDefaultModels: {
      ...(prefs.providerDefaultModels ?? {}),
      [key]: {
        modelId,
        tried: modelId !== null && tried,
      },
    },
  };
}
