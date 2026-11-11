import type {
  ApprovalMode,
  AssistantCharacterView,
  AttachmentView,
  EnvironmentStatus,
  ModelOption,
  ModelsStatus,
  OutgoingAttachment,
  PlanUsage,
  ProjectView,
  ReasoningEffort,
  SandboxSettings,
  SessionSummary,
  ResearchRunView,
  ResearchSettings,
  ShellRun,
  SkillEntry,
  TitleSettings,
  YoloSettings,
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

/** A tiny external store: immutable snapshots plus change listeners, read through useSyncExternalStore-style hooks. */
export class Store<T> {
  private state: T;
  private readonly listeners = new Set<() => void>();

  constructor(initial: T) {
    this.state = initial;
  }

  get = (): T => this.state;

  set = (update: (state: T) => T): void => {
    const next = update(this.state);
    if (next === this.state) {
      return;
    }
    this.state = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export type GroupBy = "project" | "status";
export type ThemePref = "system" | "light" | "dark";
/** Syntax colours for code blocks, independent of the app's own light or dark theme. */
export const CODE_THEMES = ["ancilla", "ayu", "github", "vercel", "cursor", "catppuccin"] as const;
export type CodeTheme = (typeof CODE_THEMES)[number];

/** Interface zoom as a factor of 1, in fixed steps from 70% to 200%. */
export const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2] as const;
export const ZOOM_MIN = ZOOM_STEPS[0];
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** The little the sidebar's card and the dock's face need to know about the assistant. */
export interface AssistantGlance {
  enabled: boolean;
  name: string;
  character: AssistantCharacterView;
  /** Open tasks, and how many of them wait on the user. */
  open: number;
  needsYou: number;
  running: number;
}

export interface Prefs {
  groupBy: GroupBy;
  theme: ThemePref;
  codeTheme: CodeTheme;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  collapsedProjects: string[];
  /** Settled shelves the user opened: `project:<cwd>`, or `status` for the by-status view. */
  openShelves: string[];
  /**
   * Dock cards the user collapsed, as `goal:<sessionId>` or `plan:<sessionId>`. Only the closed ones are
   * kept, so a card opens by default and a thread the user has never touched costs nothing to remember.
   */
  collapsedCards: string[];
  /**
   * Run and plan cards the user opened, as `crew:<sessionId>` or `plan:<sessionId>`. They rest as a glance, a first
   * line and a spine, so only the opened ones are kept and a thread nobody has touched costs nothing to remember.
   */
  openCards: string[];
  /**
   * Dock cards the user closed, with the same keys (plus `tasks:<sessionId>`). A closed card stays out of the dock
   * until the user brings it back from the thread's top bar.
   */
  hiddenCards: string[];
  /** Failed-turn notices the user closed, as `<sessionId>:<turnId>`, so a reloaded thread keeps them closed. */
  dismissedTurnErrors: string[];
  /** Raise a system notification when a thread needs attention while the window does not have it. */
  notifications: boolean;
  /** When the user last viewed each thread (ISO). */
  lastSeen: Record<string, string>;
  /** Activity before the first launch is treated as already seen. */
  baseline: string;
  defaultMode: ApprovalMode;
  defaultModelId: string | null;
  /**
   * `defaultModelId` is a model the user tried by its id, which the list Muse sent did not offer. Such a pin is kept
   * and passed on at thread start, and it survives a restart; any other choice of model clears it.
   */
  defaultModelTried: boolean;
  effort: ReasoningEffort | null;
  /** The last project a new thread was started in. */
  lastProject: string | null;
  /** Contributor-tier data use was acknowledged. */
  contributorAck: boolean;
  /** Desktop app: download new versions as they appear and install them on close. */
  autoUpdate: boolean;
  /** Desktop app: no checking, downloading or installing updates until resumed. */
  updatesPaused: boolean;
  /** Interface zoom as a factor of 1; the desktop shell has no browser chrome to do this. */
  zoom: number;
  /**
   * The file viewer beside a thread is open. Kept in step with `sidePanel === "files"` for the views that still
   * read it; `sidePanel` is the setting.
   */
  filesOpen: boolean;
  filesWidth: number;
  /** What the slot beside a thread shows: the file viewer, the Crew panel, or nothing. */
  sidePanel: SidePanel;
  /** The Crew panel's width, resizable like the file viewer. */
  crewWidth: number;
  /** The version whose release notes were last shown, so an update shows what changed once. */
  lastSeenVersion: string | null;
  /** Session statistics pills above the composer: turns, speed and token usage for the open thread. */
  showTelemetry: boolean;
  /**
   * How the assistant asks to be set up in the sidebar until it has been: with a light moving round its card (`pulse`),
   * as a still card the user said "not now" to (`calm`), or not at all (`hidden`, which puts its icon in the footer).
   * Once it is set up the card is its quiet self whatever this says, unless it is hidden.
   */
  assistantInvite: "pulse" | "calm" | "hidden";
  /** Show the assistant's face beside the composer, where it reacts to the thread: working, waiting on you, done. */
  assistantPresence: boolean;
  /** Keep the companion avatar floating over the workspace even when no voice call is active. */
  assistantFloat: boolean;
  /** Presentation of the movable assistant window: frameless floating avatar or full transcript card. */
  assistantWindowMode: AssistantWindowMode;
  /** Pixel size of the floating companion avatar (clamped between 56 and 224). */
  assistantAvatarSize: number;
  /** Saved normalized center anchor (`xRatio`, `yRatio` in 0..1) of the movable assistant window, or null for default corner. */
  assistantPosition: AssistantAnchor | null;
  /**
   * Approval modes from before YOLO was armed, survived across a reload so switching YOLO off still
   * restores them instead of falling back to onRequest. Null when YOLO has never been armed here.
   */
  preYolo: { defaultMode: ApprovalMode; threads: Record<string, ApprovalMode | null> } | null;
}

export const DEFAULT_FILES_WIDTH = 480;
export const FILES_WIDTH_MIN = 320;
export const FILES_WIDTH_MAX = 1200;

export type SidePanel = "none" | "files" | "crew" | "browser";
export const DEFAULT_CREW_WIDTH = 520;
export const CREW_WIDTH_MIN = 400;
export const CREW_WIDTH_MAX = 800;

export type CrewFilter = "all" | "needs" | "failed" | "no-update" | "working" | "done";

/** One thread's Crew panel: the roster or one agent's inspector, the filter, and what is folded. */
export interface CrewPanelState {
  mode: "roster" | "inspector";
  inspectId: string | null;
  filter: CrewFilter;
  query: string;
  timelineOpen: boolean;
  /** Phases the user opened in the roster; the current phase and failed ones open by default. */
  openPhases: string[];
}

export interface CrewState {
  panels: Record<string, CrewPanelState>;
  activityOpen: boolean;
  /** Actions sent and not yet confirmed by a revision, by `pendingKey(sessionId, agentId, attempt)`. */
  pending: Record<string, "retry" | "stop">;
  /** Skips this client sent, by the same key, so a cancelled attempt reads "Skipped by you". */
  skipped: string[];
  /** When each thread was last left or the window hidden, for the "Since you left" recap. */
  leftAt: Record<string, number>;
  /** Completion reports closed, as `<sessionId>:<itemId>`. */
  dismissedReports: string[];
  /** Recaps closed, by session. */
  dismissedRecaps: string[];
}

export function emptyCrewPanel(): CrewPanelState {
  return { mode: "roster", inspectId: null, filter: "all", query: "", timelineOpen: true, openPhases: [] };
}

export function emptyCrewState(): CrewState {
  return { panels: {}, activityOpen: false, pending: {}, skipped: [], leftAt: {}, dismissedReports: [], dismissedRecaps: [] };
}

/** One thread's file viewer: the files it has open as tabs, which one shows, and whether the tree is up instead. */
export interface FilePanel {
  tabs: string[];
  active: string | null;
  tree: boolean;
  /** Lines a link pointed at in the active file, to scroll to and mark. */
  line: import("./files.js").LineRange | null;
}

/** An edit not yet saved, with the version of the file it started from. */
export interface FileDraft {
  content: string;
  baseMtimeMs: number | null;
}

export const DEFAULT_SIDEBAR_WIDTH = 284;

export function defaultPrefs(now = new Date().toISOString()): Prefs {
  return {
    groupBy: "project",
    theme: "system",
    codeTheme: "ancilla",
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    sidebarCollapsed: false,
    collapsedProjects: [],
    openShelves: [],
    collapsedCards: [],
    openCards: [],
    hiddenCards: [],
    dismissedTurnErrors: [],
    // Off until asked for: nobody should be interrupted by something they never turned on.
    notifications: false,
    lastSeen: {},
    baseline: now,
    defaultMode: "onRequest",
    defaultModelId: null,
    defaultModelTried: false,
    effort: null,
    lastProject: null,
    contributorAck: false,
    autoUpdate: true,
    updatesPaused: false,
    zoom: 1,
    filesOpen: false,
    filesWidth: DEFAULT_FILES_WIDTH,
    sidePanel: "none",
    crewWidth: DEFAULT_CREW_WIDTH,
    lastSeenVersion: null,
    showTelemetry: false,
    assistantInvite: "pulse",
    assistantPresence: true,
    assistantFloat: false,
    assistantWindowMode: "float",
    assistantAvatarSize: ASSISTANT_AVATAR_DEFAULT,
    assistantPosition: null,
    preYolo: null,
  };
}

export type Route =
  | { kind: "home" }
  | { kind: "new"; cwd: string | null }
  | { kind: "thread"; sessionId: string }
  | { kind: "usage" }
  | { kind: "settings" }
  | { kind: "assistant" };

export interface ThreadState {
  load: "idle" | "loading" | "ready" | "error";
  error: string | null;
  readOnly: boolean;
  readOnlyReason: string | null;
  truncated: boolean;
  fold: ThreadFold;
  /** Files sent with this thread's prompts; Muse's own view keeps metadata only. */
  attachments: AttachmentView[];
  /** `!` commands Ancilla ran itself, which Muse's transcript never sees. */
  shellRuns: ShellRun[];
  /** DeepResearch runs started from this thread, newest state per run; the report rides only once asked for. */
  researchRuns: ResearchRunView[];
  /**
   * The thread shows a turn running, but its stream went quiet and reloading from history did not
   * move it on. Set once the watchdog has spent its reloads, so the view can say so instead of
   * leaving a spinner that means nothing (#42).
   */
  stalled: boolean;
  /** Saved history is being checked while live view updates are unavailable. This is not a restored live stream. */
  historySync?: { checkedAt: number; progressAt: number | null };
  /**
   * The fold may have missed stream events: the connection dropped while the thread was in the background, or the
   * thread left the sidebar and stopped being checked. It is read again when it is next opened; until then what it
   * shows of its agents is last known, not live.
   */
  stale?: boolean;
}

export interface Toast {
  id: number;
  tone: "error" | "info" | "success";
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

export interface AppState {
  boot: "loading" | "ready" | "error";
  bootError: string | null;
  env: EnvironmentStatus | null;
  linuxSetup: import("../types.js").LinuxSetupView | null;
  linuxSetupError: string | null;
  /** The named account whose storage is being checked; null is the default Muse login. */
  linuxSetupAccountId: string | null;
  linuxDesktop: import("../types.js").LinuxDesktopStatus | null;
  linuxDesktopError: string | null;
  connection: "connecting" | "open" | "lost";
  projects: ProjectView[];
  sessions: Record<string, SessionSummary>;
  sessionsLoaded: boolean;
  discovering: boolean;
  route: Route;
  threads: Record<string, ThreadState>;
  /** Every loaded catalog's models once each, the default login's first, so a price or context window resolves any of them. */
  models: ModelOption[];
  /** Each catalog scope's own list, by `modelsKey`: `default`, `acct:<accountId>` or `thread:<sessionId>`. Menus read these. */
  accountModels: Record<string, ModelOption[]>;
  /** How each scope's load stands, by the same keys; a scope never asked for has no entry. */
  modelsStatus: Record<string, ModelsStatus>;
  /** Server-owned thread-title switch and model; null until the first boot load answers. */
  titleSettings: TitleSettings | null;
  /** Server-owned sandbox posture; null until the first boot load answers. */
  sandboxSettings: SandboxSettings | null;
  /** Server-owned YOLO mode; null until the first boot load answers. */
  yoloSettings: YoloSettings | null;
  /** Server-owned DeepResearch defaults and switch; null until the first boot load answers. */
  researchSettings: ResearchSettings | null;
  /** Moves each time the server says the assistant's memory, goals or tasks changed, so an open page reads them again. */
  assistantRev: number;
  /** What the sidebar's card and the dock's face need of the assistant, read once and again when it changes; null until the first answer. */
  assistantGlance: AssistantGlance | null;
  /** The last event its face should react to (a note kept, a refusal, a question) and when it happened. */
  assistantReaction: { mood: "delight" | "concern" | "attention"; at: number } | null;
  /** What Stop does on a research run: write a report from what it has, or drop it. Set from the composer popover. */
  researchStopWrites: boolean;
  /**
   * Stops asked for and not yet answered by the run, by run id: the row says it is stopping and takes its Stop away
   * until a final status arrives on the stream. The stop route's own answer is a snapshot from before the run acted
   * on it, so it cannot clear this on its own.
   */
  researchStopping: Record<string, ResearchStopAction>;
  /**
   * Research mode: the composer's field is the question and Send starts a run instead of a turn. Switched on from
   * the Research button or its chord, off again once a run starts or the composer on screen changes.
   */
  researchMode: boolean;
  /** The run options typed into the Research popover; null fields fall back to the server's defaults. */
  researchTyped: ResearchTyped;
  prefs: Prefs;
  toasts: Toast[];
  paletteOpen: boolean;
  /** The add-project dialog: open, or open to add a folder to the project named. */
  addProjectOpen: boolean | { folderFor: string };
  /** The release notes were asked for, rather than shown because the version changed. */
  whatsNewOpen: boolean;
  /** Keys of in-flight user actions, for disabling buttons: `send:<id>`, `approval:<id>`... */
  busy: Record<string, true>;
  /**
   * Approvals Ancilla answers for you rather than showing. Muse asks whenever it cannot resolve a
   * command's argv, whatever its own mode says, so this is the only way to stop being asked. It is
   * deliberately not a preference: a bypass lasts as long as the app is open and no longer.
   */
  bypassAll: boolean;
  /** Threads armed one at a time, for letting a single unattended run through. */
  bypassThreads: string[];
  hostError: string | null;
  /** A prompt that could not be sent, waiting for the composer showing `key` to take it back, files and all. */
  draftHandoff: { key: string; text: string; attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] } | null;
  /** App updates; null when the shell cannot update itself, as in a browser. */
  updates: UpdateState | null;
  /** Each workspace's skills for the composer's slash menu, loaded when first needed. */
  skills: Record<string, SkillsState>;
  /** A composer picker a slash command opened, like `/model`. */
  picker: ComposerPicker | null;
  /** The subscription window Muse last reported; null until a host has seen one. */
  planUsage: PlanUsage | null;
  planUsageAccountId: string | null;
  planUsageSaved: boolean;
  planUsageSavedAccounts: string[];
  planUsageStatus: import("../types.js").PlanUsageStatus;
  planUsageLoading: boolean;
  planUsageAccounts: import("../types.js").PlanAccountUsage[];
  /** The explicit Usage selection; runtime activity must never change it. */
  planUsageSelectedAccountId: string | null;
  /** Every account Ancilla can run; null until the first load answers. */
  accounts: import("../types.js").AccountView[] | null;
  /** True when META_API_KEY in Ancilla's environment makes every account share one Meta login. */
  metaApiKeyInherited: boolean;
  defaultLogin: import("../types.js").DefaultLoginIdentity | null;
  /** The in-app device-code login in progress, if any; null once closed or never started. */
  accountLogin: AccountLoginState | null;
  /** The plan window per account, from `GET /api/plan-usage` and the `plan-usage` event. */
  planUsageByAccount: import("../types.js").PlanUsageByAccount;
  /** Multi-provider catalog (`GET /api/providers`); null until first read. */
  providers: import("../types.js").ProviderView[] | null;
  /** Configured non-Muse provider profiles and API endpoints. */
  providerAccounts: import("../types.js").ProviderAccountView[];
  /** Detected ambient pay-as-you-go API env vars per subscription CLI (`codex`, `claude`, `gemini`, `copilot`). */
  ambientKeyOverrides: Record<string, string[]>;
  /** True when the daemon is bound to a non-loopback interface (`--host 0.0.0.0`), requiring AGPLv3 §13 source offer. */
  remoteDeployment: boolean;
  /** Complete Corresponding Source Code URL advertised by the server. */
  sourceOfferUrl: string | null;
  /** Non-Muse provider quota summaries from `GET /api/plan-usage` and `provider-usage` events. */
  providerQuotas: import("../types.js").ProviderQuotaView[];
  /** Active CLI provider sign-in attempt (`codex login`, `claude auth login`, `gemini`, `copilot`, etc.). */
  providerLogin: ProviderAccountLoginState | null;
  /** Set when the user chooses to configure another AI subscription or API key without installing Muse first. */
  skipMuseOnboarding: boolean;
  /** Each thread's file viewer. */
  filePanels: Record<string, FilePanel>;
  /** Unsaved edits, by `fileKey(cwd, path)`. */
  fileDrafts: Record<string, FileDraft>;
  /** Bumped when Muse edits a file, so an open view of it reloads. By `fileKey(cwd, path)`. */
  fileVersions: Record<string, number>;
  /** Folders open in each project's file tree. */
  fileTreeOpen: Record<string, string[]>;
  /** The Crew panels, the Activity drawer and the agent actions in flight. */
  crew: CrewState;
}

/** `confirmFullAccess` is the full-access confirmation, which `/permissions full` must still pass through. */
export type ComposerPicker = "model" | "effort" | "permissions" | "confirmFullAccess" | "confirmBypass" | "confirmYolo" | "account" | "research";

/** Browser sign-in stays visible through preparation, completion, timeout and recoverable errors. */
export type AccountLoginState =
  | { accountId: string | null; url: string; code: string | null; status: "starting" | "waiting" | "done" | "timeout" | "error"; loginId?: string; message?: string }
  | { accountId: string | null; fallback: string };

/** Non-Muse CLI subscription sign-in state. */
export interface ProviderAccountLoginState {
  providerId: import("../types.js").ProviderId;
  accountId: string | null;
  status: "starting" | "waiting" | "done" | "interactive" | "error";
  url: string | null;
  code: string | null;
  loginId?: string;
  terminalCommand?: string;
  message?: string;
}

export interface SkillsState {
  status: "loading" | "ready" | "error";
  skills: SkillEntry[];
  error: string | null;
  /** When the last load finished, in platform time. */
  loadedAt: number;
}

export function initialState(prefs: Prefs): AppState {
  return {
    boot: "loading",
    bootError: null,
    env: null,
    linuxSetup: null,
    linuxSetupError: null,
    linuxSetupAccountId: null,
    linuxDesktop: null,
    linuxDesktopError: null,
    connection: "connecting",
    projects: [],
    sessions: {},
    sessionsLoaded: false,
    discovering: false,
    route: { kind: "home" },
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
    paletteOpen: false,
    addProjectOpen: false,
    whatsNewOpen: false,
    busy: {},
    bypassAll: false,
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
    metaApiKeyInherited: false,
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
}

/** Merge persisted prefs over defaults, dropping anything malformed. */
export function revivePrefs(raw: unknown, fallback: Prefs): Prefs {
  if (!raw || typeof raw !== "object") {
    return fallback;
  }
  const r = { ...(raw as Record<string, unknown>) };
  // Ultra left the picker (Muse runs it as Max), so a saved Ultra carries on as Max.
  if (r["effort"] === "ultra") {
    r["effort"] = "max";
  }
  // The file viewer's switch became the side-panel setting; a saved open viewer opens as the files panel.
  if (r["sidePanel"] === undefined && r["filesOpen"] === true) {
    r["sidePanel"] = "files";
  }
  // The Swarm panel became the Crew panel; a saved open panel and its width carry over under the new name.
  if (r["sidePanel"] === "swarm") {
    r["sidePanel"] = "crew";
  }
  if (r["crewWidth"] === undefined && typeof r["swarmWidth"] === "number") {
    r["crewWidth"] = r["swarmWidth"];
  }
  const pick = <K extends keyof Prefs>(key: K, valid: (v: unknown) => boolean): Prefs[K] =>
    valid(r[key]) ? (r[key] as Prefs[K]) : fallback[key];
  const sidePanel = pick("sidePanel", (v) => v === "none" || v === "files" || v === "crew" || v === "browser");
  const isApprovalMode = (v: unknown): boolean =>
    v === "onRequest" || v === "promptUnmatched" || v === "denyUnmatched" || v === "allowAll";
  const isPreYolo = (v: unknown): boolean => {
    if (v === null) {
      return true;
    }
    if (typeof v !== "object") {
      return false;
    }
    const snapshot = v as { defaultMode?: unknown; threads?: unknown };
    return (
      isApprovalMode(snapshot.defaultMode) &&
      typeof snapshot.threads === "object" &&
      snapshot.threads !== null &&
      !Array.isArray(snapshot.threads) &&
      Object.values(snapshot.threads).every((mode) => mode === null || isApprovalMode(mode))
    );
  };
  const defaultModelId = pick("defaultModelId", (v) => v === null || typeof v === "string");
  return {
    groupBy: pick("groupBy", (v) => v === "project" || v === "status"),
    theme: pick("theme", (v) => v === "system" || v === "light" || v === "dark"),
    sidebarWidth: pick("sidebarWidth", (v) => typeof v === "number" && v >= 220 && v <= 480),
    sidebarCollapsed: pick("sidebarCollapsed", (v) => typeof v === "boolean"),
    collapsedProjects: pick("collapsedProjects", (v) => Array.isArray(v) && v.every((x) => typeof x === "string")),
    openShelves: pick("openShelves", (v) => Array.isArray(v) && v.every((x) => typeof x === "string")),
    collapsedCards: pick("collapsedCards", (v) => Array.isArray(v) && v.every((x) => typeof x === "string")),
    openCards: pick("openCards", (v) => Array.isArray(v) && v.every((x) => typeof x === "string")),
    hiddenCards: pick("hiddenCards", (v) => Array.isArray(v) && v.every((x) => typeof x === "string")),
    dismissedTurnErrors: pick("dismissedTurnErrors", (v) => Array.isArray(v) && v.every((x) => typeof x === "string")),
    notifications: pick("notifications", (v) => typeof v === "boolean"),
    lastSeen: pick("lastSeen", (v) => typeof v === "object" && v !== null && !Array.isArray(v)),
    baseline: pick("baseline", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v))),
    codeTheme: pick("codeTheme", (v) => CODE_THEMES.includes(v as CodeTheme)),
    defaultMode: pick("defaultMode", (v) => v === "onRequest" || v === "promptUnmatched" || v === "denyUnmatched" || v === "allowAll"),
    defaultModelId,
    // A flag with no pin to belong to is stale, however it was saved.
    defaultModelTried: defaultModelId !== null && pick("defaultModelTried", (v) => typeof v === "boolean"),
    effort: pick("effort", (v) => v === null || ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(v as string)),
    lastProject: pick("lastProject", (v) => v === null || typeof v === "string"),
    contributorAck: pick("contributorAck", (v) => typeof v === "boolean"),
    autoUpdate: pick("autoUpdate", (v) => typeof v === "boolean"),
    updatesPaused: pick("updatesPaused", (v) => typeof v === "boolean"),
    zoom: pick("zoom", (v) => typeof v === "number" && Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX),
    filesOpen: sidePanel === "files",
    filesWidth: pick("filesWidth", (v) => typeof v === "number" && v >= FILES_WIDTH_MIN && v <= FILES_WIDTH_MAX),
    sidePanel,
    crewWidth: pick("crewWidth", (v) => typeof v === "number" && v >= CREW_WIDTH_MIN && v <= CREW_WIDTH_MAX),
    lastSeenVersion: pick("lastSeenVersion", (v) => v === null || typeof v === "string"),
    showTelemetry: pick("showTelemetry", (v) => typeof v === "boolean"),
    assistantInvite: pick("assistantInvite", (v) => v === "pulse" || v === "calm" || v === "hidden"),
    assistantPresence: pick("assistantPresence", (v) => typeof v === "boolean"),
    assistantFloat: pick("assistantFloat", (v) => typeof v === "boolean"),
    assistantWindowMode: pick("assistantWindowMode", (v) => v === "float" || v === "card"),
    assistantAvatarSize:
      typeof r["assistantAvatarSize"] === "number" && Number.isFinite(r["assistantAvatarSize"])
        ? clampAvatarSize(r["assistantAvatarSize"], fallback.assistantAvatarSize)
        : r["assistantAvatarSize"] === undefined
          ? fallback.assistantAvatarSize
          : pick("assistantAvatarSize", (v) => typeof v === "number" && Number.isFinite(v) && v >= ASSISTANT_AVATAR_MIN && v <= ASSISTANT_AVATAR_MAX),
    assistantPosition: pick("assistantPosition", (v) => v === null || isValidAnchor(v)),
    preYolo: pick("preYolo", isPreYolo),
  };
}
