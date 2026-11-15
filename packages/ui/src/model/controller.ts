import { errorKind, errorMessage, noAnswer, type AncillaClient } from "../client.js";
import type {
  ApprovalMode, ApprovalRequest, AssistantEventView, AssistantStatusView, AssistantWaitingView,
  AttachmentView, GoalAction, LinuxDesktopStatus, LinuxSetupView, AncillaEvent, ModelCatalog,
  ModelOption, ModelsStatus, MspItem, OutgoingAttachment, OutputRange, ProjectView,
  ProviderAccountView, ProviderId, ReasoningEffort, ResearchConfig, ResearchExportFormat,
  ResearchRunView, SessionSummary, SkillEntry, SubagentAction, TaskAction, UserInputAnswer,
  UserInputRequest, ViewEvent, WorkflowAction,
} from "../types.js";
import { describeTool, modelDisplayName } from "./format.js";
import { canStopAgent, pendingKey, researchRunIdOf, turnIdOf, runLive, crewBusy, crewView, type AgentVM } from "./crew.js";
import { fileKey, fileTarget, type LineRange } from "./files.js";
import { goalPrompt } from "./goal.js";
import { EMPTY_RESEARCH_CONFIG, mintCommandId, reconcileResearchRuns, researchLive, settleStopping, type ResearchStopAction, type ResearchTyped, researchThreadTitle } from "./research.js";
import { unionById } from "./union.js";
import { projectForCwd } from "./status.js";
import { contextualPlanAccountId, legacyPlanAccounts, mergePlanAccounts, samePlanUsage } from "./plan.js";
import {
  CONTRIBUTOR_NOTE, MODEL_COPY, anyWorkRunning, effectiveEffort, effortLabel, familyOf,
  findModel, isLimitedCatalog, isModelId, isPlanCatalog, isStale, knownModels, literalModelId,
  modelIdError, modelMatches, modelStub, modelsFor, modelsKey, modelsNeedSignIn, modelsShown,
  modelsStanding, providerBadgeName, publishedStubs, trustedModel, type ModelsScope,
} from "./models.js";
import { INIT_PROMPT, parseEffort, parseMode, parseSlash, resolveSlash, skillTurn, slashCommands, type ParsedSlash } from "./slash.js";
import { addEcho, applyEvents, emptyFold, foldFromLoad, promptIds, promptLanded, removeEcho, updateEcho, type EchoAttachment, type LocalEcho, type ThreadFold } from "./fold.js";
import {
  FILES_WIDTH_MAX, FILES_WIDTH_MIN, CREW_WIDTH_MAX, CREW_WIDTH_MIN, Store, ZOOM_MAX, ZOOM_MIN,
  ZOOM_STEPS, defaultModelForScope, defaultPrefs, emptyCrewPanel, initialState, patchDefaultModelForScope,
  revivePrefs, type AppState, type CodeTheme, type ComposerPicker, type FilePanel, type GroupBy,
  type Prefs, type Route, type SidePanel, type SkillsState, type CrewFilter, type CrewPanelState,
  type ThemePref, type ThreadState, type Toast,
} from "./store.js";
import { NotificationManager, type NotifyEvent, type Notifier } from "./notify.js";
import { wantAssistantTab } from "./wantedTab.js";
import { UpdateManager, type AppUpdater } from "./updates.js";
import { saveBrowserFile, type FileSaver } from "./fileSave.js";

export interface Platform {
  loadPrefs: () => unknown;
  savePrefs: (prefs: Prefs) => void;
  readHash: () => string;
  writeHash: (hash: string) => void;
  onHashChange: (handler: () => void) => () => void;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  focused: () => boolean;
  saveFile?: FileSaver;
  setWindowTitle?: (title: string) => void;
  linuxDesktop?: {
    status: () => Promise<LinuxDesktopStatus>;
    install: (options: { desktopShortcut: boolean }) => Promise<LinuxDesktopStatus>;
    relaunch: () => Promise<void>;
  };
}

export const RESEARCH_EXPORT_WORD: Record<ResearchExportFormat, string> = { pdf: "PDF", docx: "Word", html: "HTML" };

const STORAGE_PREFS_KEY = "ancilla.prefs.v1";
const DRAFT_STORAGE_PREFIX = "ancilla.draft.";

export function loadDraft(key: string): string {
  try {
    const val = window.localStorage.getItem(`${DRAFT_STORAGE_PREFIX}${key}`);
    return typeof val === "string" ? val : "";
  } catch {
    return "";
  }
}

export function saveDraft(key: string, value: string): void {
  try {
    const targetKey = `${DRAFT_STORAGE_PREFIX}${key}`;
    if (!value) {
      window.localStorage.removeItem(targetKey);
    } else {
      window.localStorage.setItem(targetKey, value);
    }
  } catch {
    // Best effort draft preservation
  }
}

export function browserPlatform(): Platform {
  return {
    loadPrefs: (): unknown => {
      try {
        const stored = window.localStorage.getItem(STORAGE_PREFS_KEY);
        return stored ? JSON.parse(stored) : null;
      } catch {
        return null;
      }
    },
    savePrefs: (prefs: Prefs): void => {
      try {
        window.localStorage.setItem(STORAGE_PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // Storage failure fallback
      }
    },
    readHash: (): string => window.location.hash,
    writeHash: (newHash: string): void => {
      if (newHash) {
        window.location.hash = newHash;
      } else if (window.location.hash) {
        window.history.pushState(null, "", window.location.pathname + window.location.search);
      }
    },
    onHashChange: (handler: () => void): (() => void) => {
      const evts = ["hashchange", "popstate"] as const;
      evts.forEach((e) => window.addEventListener(e, handler));
      return () => evts.forEach((e) => window.removeEventListener(e, handler));
    },
    now: (): number => Date.now(),
    schedule: (fn: () => void, ms: number): unknown => window.setTimeout(fn, ms),
    cancel: (handle: unknown): void => window.clearTimeout(handle as number),
    focused: (): boolean => typeof document !== "undefined" && document.hasFocus(),
    saveFile: saveBrowserFile,
    setWindowTitle: (title: string): void => {
      if (typeof document !== "undefined" && document.title !== title) {
        document.title = title;
      }
    },
  };
}

export function routeToHash(route: Route): string {
  if (route.kind === "home") return "";
  if (route.kind === "new") return route.cwd ? `#/new/${encodeURIComponent(route.cwd)}` : "#/new";
  if (route.kind === "thread") return `#/t/${encodeURIComponent(route.sessionId)}`;
  if (route.kind === "usage") return "#/usage";
  if (route.kind === "settings") return "#/settings";
  return "#/assistant";
}

export function hashToRoute(hash: string): Route {
  const path = hash.replace(/^#/, "");
  if (path === "/usage") return { kind: "usage" };
  if (path === "/settings") return { kind: "settings" };
  if (path === "/assistant") return { kind: "assistant" };
  const threadMatch = path.match(/^\/t\/(.+)$/);
  if (threadMatch) return { kind: "thread", sessionId: decodeURIComponent(threadMatch[1] as string) };
  const newMatch = path.match(/^\/new(?:\/(.+))?$/);
  if (newMatch) return { kind: "new", cwd: newMatch[1] ? decodeURIComponent(newMatch[1]) : null };
  return { kind: "home" };
}

export const blankThread = (): ThreadState => ({
  load: "idle", error: null, readOnly: false, readOnlyReason: null, truncated: false, fold: emptyFold(),
  attachments: [], shellRuns: [], researchRuns: [], stalled: false,
});

let localSeq = 0;
export const nextLocalId = (): string => `local-${Date.now().toString(36)}-${++localSeq}`;

export type TurnDelivery = {
  steer?: boolean; queue?: boolean; displayText?: string;
  attachments?: OutgoingAttachment[]; previews?: EchoAttachment[]; sessionId?: string;
};

export interface SendOptions extends TurnDelivery {
  raw?: boolean; command?: ParsedSlash; onLanded?: (turnId: string) => void;
}

export const FLUSH_MS = 24;
export const TOAST_MS = { info: 5000, success: 4000, error: 9000 } as const;
export const SKILLS_FRESH_MS = 60_000;
export const SKILLS_RETRY_MS = 10_000;
export const STALE_CHECK_MS = 15_000;
export const HISTORY_SYNC_MS = 15_000;
export const RECOVERY_RETRY_MS = 30_000;
export const LOGIN_POLL_MS = 2_000;
export const LOGIN_POLL_MAX_ATTEMPTS = 300;
export const DIVERGED_GRACE_MS = 30_000;
export const QUIET_TURN_MS = 90_000;
export const STALE_RELOAD_LIMIT = 2;
export const STALE_BACKOFF_MS = 120_000;
export const RESYNC_GAP_MS = 15_000;
export const WATCHDOG_RELOADS_PER_TICK = 2;
export const LISTENER_ERROR_TOAST_MS = 60_000;
export const CATCH_UP_NAMED_LIMIT = 1;
export const RETRY_PAUSE_MAX_MS = 15 * 60_000;
export const UNCONFIRMED_CHECKS_MS = [1_500, 3_500, 8_000, 15_000] as const;
export const MODELS_BOOT_RETRY_MS = 3_000;
export const MODELS_RELIST_MS = [2_000, 10_000, 30_000] as const;
export const MODELS_THREAD_SCOPES = 8;

export interface ModelsRefresh extends ModelsScope {
  force?: boolean; watch?: boolean; navigation?: boolean;
}

export const NO_MODELS_STATUS: ModelsStatus = { status: "idle", error: null, loadedAt: null, catalog: null };

export interface ModelsWatch {
  token: number; attempt: number;
}

export type StaleThreadReason = "diverged" | "quiet";

export function staleThreadReason(
  foldActiveTurnId: string | null, liveActiveTurnId: string | null | undefined,
  lastAppliedAt: number | null, now: number
): StaleThreadReason | null {
  if (!foldActiveTurnId || lastAppliedAt === null) return null;
  const elapsed = now - lastAppliedAt;
  if (!liveActiveTurnId) return elapsed > DIVERGED_GRACE_MS ? "diverged" : null;
  return elapsed > QUIET_TURN_MS ? "quiet" : null;
}

export function freshViewProgress(previous: ThreadFold, next: ThreadFold, events: readonly ViewEvent[]): boolean {
  const turns = new Set([previous.activeTurnId, next.activeTurnId].filter((id): id is string => id !== null));
  for (const event of events) {
    const turnId = typeof event.params["turnId"] === "string" ? event.params["turnId"] : null;
    if (event.method === "turn/completed" && turnId && turns.has(turnId) && next.turns[turnId]?.terminal && !previous.turns[turnId]?.terminal) return true;
    if (event.method === "turn/started" && turnId && turns.has(turnId) && !previous.turns[turnId]?.terminal && (!previous.turns[turnId] || previous.turns[turnId]?.startedAt === undefined && next.turns[turnId]?.startedAt !== undefined)) return true;
    if (!event.method.startsWith("item/")) continue;
    const raw = event.params["item"];
    const itemId = typeof event.params["itemId"] === "string" ? event.params["itemId"] : raw && typeof raw === "object" && "itemId" in raw && typeof raw.itemId === "string" ? raw.itemId : null;
    if (!itemId) continue;
    const item = next.items[itemId];
    const before = previous.items[itemId];
    if (!item || !turns.has(item.turnId ?? turnId ?? "") || item === before) continue;
    if (!before || item.revision > before.revision || item.status !== before.status || (item.text?.length ?? 0) > (before.text?.length ?? 0) || (item.visibleOutput?.length ?? 0) > (before.visibleOutput?.length ?? 0) || (item.summary?.join("").length ?? 0) > (before.summary?.join("").length ?? 0)) return true;
  }
  return false;
}

export const provesLiveness = (event: ViewEvent): boolean => event.method !== "session/viewHealthChanged";

export function expectedPause(fold: ThreadFold, events: readonly ViewEvent[]): number {
  let pauseMs = 0;
  for (const ev of events) {
    const delayVal = ev.params["retryDelayMs"];
    if (ev.method === "turn/retryScheduled" && ev.params["turnId"] === fold.activeTurnId && typeof delayVal === "number" && Number.isFinite(delayVal) && delayVal > pauseMs) {
      pauseMs = delayVal;
    }
  }
  return Math.min(pauseMs, RETRY_PAUSE_MAX_MS);
}

export function childSessions(event: ViewEvent): string[] {
  if (!event.method.startsWith("item/")) return [];
  const raw = event.params["item"];
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const list: string[] = [];
  if (typeof record["childSessionId"] === "string") list.push(record["childSessionId"]);
  if (Array.isArray(record["children"])) {
    for (const child of record["children"]) {
      if (child && typeof child === "object" && typeof (child as Record<string, unknown>)["childSessionId"] === "string") {
        list.push((child as Record<string, unknown>)["childSessionId"] as string);
      }
    }
  }
  return list;
}

export function longerText(streamed: string | undefined, read: string | undefined, baseline: string | undefined): string | undefined {
  const live = streamed ?? "";
  const saved = read ?? "";
  if (!live) return baseline;
  if (saved.startsWith(live)) return read;
  return live.startsWith(saved) ? streamed : baseline;
}

export function withBufferedDeltas(previous: ThreadFold, saved: ThreadFold, buffered: readonly ViewEvent[]): ThreadFold {
  const baseFold = applyEvents(saved, buffered);
  const startedItemIds = new Set<string>();
  const deltaItemIds = new Set<string>();

  for (const ev of buffered) {
    const itemData = ev.params["item"];
    const itemObj = (itemData && typeof itemData === "object") ? (itemData as Record<string, unknown>) : null;
    if (ev.method === "item/started" && typeof itemObj?.["itemId"] === "string") {
      startedItemIds.add(itemObj["itemId"]);
    } else if (ev.method === "item/delta" && typeof ev.params["itemId"] === "string") {
      deltaItemIds.add(ev.params["itemId"]);
    }
  }

  if (deltaItemIds.size === 0) return baseFold;

  const streamedFold = applyEvents(previous, buffered);
  let updatedItemsMap: Record<string, MspItem> | null = null;

  for (const targetId of deltaItemIds) {
    const targetApplied = baseFold.items[targetId];
    const targetStreamed = streamedFold.items[targetId];
    const targetRead = saved.items[targetId];

    if (!targetApplied || !targetStreamed || !targetRead) continue;
    if (targetApplied.status !== "inProgress") continue;
    if (targetApplied.kind === "workflow" || targetApplied.kind === "subagent") continue;
    if (!previous.items[targetId] && !startedItemIds.has(targetId)) continue;

    const modifiedItem: MspItem = { ...targetApplied };
    const preferredText = longerText(targetStreamed.text, targetRead.text, targetApplied.text);
    const preferredOutput = longerText(targetStreamed.visibleOutput, targetRead.visibleOutput, targetApplied.visibleOutput);

    if (preferredText !== undefined) modifiedItem.text = preferredText;
    if (preferredOutput !== undefined) modifiedItem.visibleOutput = preferredOutput;

    if (targetApplied.summary && (targetStreamed.summary || targetRead.summary)) {
      modifiedItem.summary = targetApplied.summary.map((segment, idx) =>
        longerText(targetStreamed.summary?.[idx], targetRead.summary?.[idx], segment) ?? segment
      );
    }

    const hasDifferences = modifiedItem.text !== targetApplied.text ||
      modifiedItem.visibleOutput !== targetApplied.visibleOutput ||
      (modifiedItem.summary ?? []).some((seg, idx) => seg !== targetApplied.summary?.[idx]);

    if (hasDifferences) {
      updatedItemsMap ??= { ...baseFold.items };
      updatedItemsMap[targetId] = modifiedItem;
    }
  }

  return updatedItemsMap ? { ...baseFold, items: updatedItemsMap } : baseFold;
}

export function keepEndedTurns(previous: ThreadFold, fold: ThreadFold): ThreadFold {
  const currentActive = fold.activeTurnId;
  const previouslyEnded = (currentActive !== null && previous.activeTurnId !== currentActive)
    ? previous.turns[currentActive]
    : undefined;

  if (currentActive === null || !previouslyEnded?.terminal) return fold;

  const existingTurn = fold.turns[currentActive];
  const mergedTurns = existingTurn?.terminal ? fold.turns : { ...fold.turns, [currentActive]: { ...existingTurn, ...previouslyEnded } };
  return { ...fold, activeTurnId: null, turns: mergedTurns };
}

export function keepRetry(previous: ThreadFold, fold: ThreadFold): ThreadFold {
  const activeId = fold.activeTurnId;
  const priorRetry = activeId !== null ? previous.turns[activeId]?.retry : undefined;
  const targetTurn = activeId !== null ? (fold.turns[activeId] ?? { turnId: activeId }) : undefined;

  if (activeId === null || !priorRetry || !targetTurn || targetTurn.retry || targetTurn.terminal) return fold;
  return { ...fold, turns: { ...fold.turns, [activeId]: { ...targetTurn, retry: priorRetry } } };
}

export const GOAL_FAILURES: Record<GoalAction, string> = {
  set: "Could not set the goal", edit: "Could not change the goal", pause: "Could not pause the goal",
  resume: "Could not resume the goal", clear: "Could not clear the goal",
};

export const TASK_FAILURES: Record<TaskAction, string> = {
  background: "Could not move that to the background", stop: "Could not stop that task", stopAll: "Could not stop the background tasks",
};
export class AncillaController {
  public readonly store: Store<AppState>;
  private readonly pending = new Map<string, ViewEvent[]>();
  private readonly loading = new Map<string, ViewEvent[]>();
  private readonly inflightLoads = new Map<string, { run: Promise<void>; resume: boolean }>();
  private readonly inflightSends = new Set<string>();
  private readonly sendChecks = new Set<unknown>();
  private readonly disposers: Array<() => void> = [];
  private flushHandle: unknown | null = null;
  private refreshHandle: unknown | null = null;
  private saveHandle: unknown | null = null;
  private staleHandle: unknown | null = null;
  private disposed: boolean = false;
  private bootRev: number = 0;
  private readonly appliedAt = new Map<string, number>();
  private readonly staleReloads = new Map<string, { turnId: string; count: number }>();
  private readonly recoveryAt = new Map<string, number>();
  private readonly readableHistory = new Set<string>();
  private readonly quietStalls = new Set<string>();
  private readonly childParents = new Map<string, string>();
  private readonly childActivity = new Set<string>();
  private refreshing: Promise<void> | null = null;
  private planUsageLoad: Promise<void> | null = null;
  private planUsageEventRevision: number = 0;
  private refreshQueued: boolean = false;
  private lastResyncAt = Number.NEGATIVE_INFINITY;
  private resyncHandle: unknown | null = null;
  private catchUpBase: Map<string, { title: string; live: SessionSummary["live"] }> | null = null;
  private catchUpReading: Map<string, { title: string; live: SessionSummary["live"] }> | null = null;
  private statusHeard = new Map<string, number>();
  private lastListenerErrorAt = Number.NEGATIVE_INFINITY;
  private toastSeq: number = 0;
  private titleSettingsRev: number = 0;
  private sandboxSettingsRev: number = 0;
  private researchSettingsRev: number = 0;
  private assistantGlanceRev: number = 0;
  private waitingSeen: Map<string, string> | null = null;
  private sandboxSettingsChain: Promise<void> = Promise.resolve();
  private yoloSettingsRev: number = 0;
  private yoloSettingsChain: Promise<void> = Promise.resolve();
  private accountsRev: number = 0;
  private accountsHealthRev: number = 0;
  private accountsChain: Promise<void> = Promise.resolve();
  private projectDefaultRev: number = 0;
  private loginRev: number = 0;
  private loginPollHandle: unknown | null = null;
  private loginPollAttempts: number = 0;
  private providersRev: number = 0;
  private providerLoginRev: number = 0;
  private providerLoginPollHandle: unknown | null = null;
  private providerLoginPollAttempts: number = 0;
  private linuxSetupRev: number = 0;
  private linuxSetupPollHandle: unknown | null = null;
  private linuxDesktopRev: number = 0;
  private preYolo: { defaultMode: ApprovalMode; threads: Record<string, ApprovalMode | null> } | null = null;
  private returnRoute: Route | null = null;
  private readonly modelRevs = new Map<string, number>();
  private readonly modelLoads = new Map<string, Promise<void>>();
  private readonly modelWatches = new Map<string, number>();
  private readonly modelHostReads = new Set<string>();
  private readonly modelTimers = new Set<unknown>();
  private readonly modelThreadKeys: string[] = [];
  private readonly modelFailedAt = new Map<string, number>();
  private readonly modelNotes = new Set<string>();
  private modelSwitchRev: number = 0;
  private readonly modelSwitchRevs = new Map<string, number>();
  private accountsSettled: boolean = false;
  private readonly unservedNotes = new Set<string>();

  private updates: UpdateManager | null = null;
  private notifications: NotificationManager | null = null;
  private notifier: Notifier | null = null;

  constructor(public readonly client: AncillaClient, private readonly platform: Platform = browserPlatform()) {
    const timestampIso = new Date(platform.now()).toISOString();
    const prefsFallback = defaultPrefs(timestampIso);
    const revivedInitialPrefs = revivePrefs(platform.loadPrefs(), prefsFallback);
    this.store = new Store(initialState(revivedInitialPrefs));
    this.preYolo = this.state.prefs.preYolo;
  }

  private get state(): AppState { return this.store.get(); }
  private update(fn: (state: AppState) => AppState): void { this.store.set(fn); }

  start(): () => void {
    this.disposed = false;
    this.disposers.push(this.client.subscribe((ev) => this.hear(ev)));
    this.disposers.push(
      this.platform.onHashChange(() => {
        const currentHash = this.platform.readHash();
        const activeRouteHash = routeToHash(this.state.route);
        if (currentHash !== activeRouteHash) {
          this.applyRoute(hashToRoute(currentHash), false);
        }
      }),
    );
    if (this.updates) {
      this.updates.start();
      this.disposers.push(() => {
        this.updates?.stop();
      });
    }
    this.scheduleStaleCheck();
    void this.boot(false);
    return () => {
      this.dispose();
    };
  }

  attachNotifier(notifier: Notifier): void {
    this.notifier = notifier;
    this.notifications = new NotificationManager(
      notifier,
      () => ({
        enabled: Boolean(this.state.prefs.notifications),
        focused: Boolean(this.platform.focused()),
      }),
      () => this.platform.now(),
    );
  }

  async askToNotify(): Promise<void> {
    const outcome = (await this.notifier?.request()) ?? "denied";
    if (outcome !== "granted") {
      this.toast("info", "Notifications are off", "Your browser or system refused them, so nothing will be raised."); return;
    }
    this.setPrefs({ notifications: true });
  }

  attachUpdater(updater: AppUpdater): void {
    this.updates = new UpdateManager(
      updater,
      () => ({
        autoUpdate: Boolean(this.state.prefs.autoUpdate),
        paused: Boolean(this.state.prefs.updatesPaused),
      }),
      (incomingUpdateState) => {
        const priorStatus = this.state.updates?.status;
        this.update((st) => ({ ...st, updates: incomingUpdateState }));
        if (incomingUpdateState.status === "ready" && priorStatus !== "ready") {
          const verString = incomingUpdateState.update?.version ? ` ${incomingUpdateState.update.version}` : "";
          const isBackgroundInstall = this.state.prefs.autoUpdate && !this.state.prefs.updatesPaused;
          const detailMsg = isBackgroundInstall ? "It installs when you close Ancilla." : "Restart Ancilla to install it.";
          this.toast(
            "info",
            `Ancilla${verString} is ready`,
            detailMsg,
            { label: "Restart now", run: () => this.restartToUpdate() },
          );
        }
      },
      () => this.platform.now(),
    );
    this.update((st) => ({ ...st, updates: this.updates?.current ?? null }));
  }

  checkForUpdates(): void { void this.updates?.check(true); }

  downloadUpdate(): void { void this.updates?.download(); }

  restartToUpdate(): void { void this.updates?.restart(); }

  setAutoUpdate(autoUpdate: boolean): void {
    this.setPrefs({ autoUpdate });
    if (autoUpdate && !this.state.prefs.updatesPaused) {
      void this.updates?.download();
    }
  }

  setUpdatesPaused(updatesPaused: boolean): void {
    this.setPrefs({ updatesPaused });
    if (!updatesPaused) {
      void this.updates?.check();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.bootRev += 1;
    this.linuxSetupRev += 1;
    this.linuxDesktopRev += 1;

    const cleanupFns = this.disposers.splice(0);
    for (const disposeFn of cleanupFns) {
      disposeFn();
    }

    const scheduledTimers = [
      this.flushHandle,
      this.refreshHandle,
      this.saveHandle,
      this.staleHandle,
      this.resyncHandle,
      this.loginPollHandle,
      this.providerLoginPollHandle,
      this.linuxSetupPollHandle,
    ];
    for (const h of scheduledTimers) {
      if (h !== null) {
        this.platform.cancel(h);
      }
    }

    this.staleHandle = null;
    this.resyncHandle = null;
    this.loginPollHandle = null;
    this.providerLoginPollHandle = null;
    this.linuxSetupPollHandle = null;

    for (const h of this.modelTimers) {
      this.platform.cancel(h);
    }
    this.modelTimers.clear();

    for (const h of this.sendChecks) {
      this.platform.cancel(h);
    }
    this.sendChecks.clear();

    this.platform.savePrefs(this.state.prefs);
  }

  private async boot(refreshEnv: boolean): Promise<void> {
    const currentRev = ++this.bootRev;
    this.update((st) => ({ ...st, boot: "loading", bootError: null }));

    try { const detectedEnv = await this.client.probeEnvironment(refreshEnv);
      
if (this.disposed || currentRev !== this.bootRev) return;

      this.update((st) => ({ ...st, env: detectedEnv }));

      if (detectedEnv.platform === "linux") {
        void this.refreshLinuxSetup();
        void this.refreshLinuxDesktop();
      }

      if (!detectedEnv.museFound) {
        if (!this.client.listProviders) {
          this.update((st) => ({ ...st, boot: "ready" }));
          return;
        }

        await this.loadProviders(refreshEnv);
        if (this.disposed || currentRev !== this.bootRev) return;

        const hasConfiguredAltProvider =
          Boolean(this.state.skipMuseOnboarding) ||
          (this.state.providers ?? []).some((p) => {
            if (p.id === "muse") return false;
            return p.id === "api" ? p.accounts.length > 0 : (p.binary.available || p.accounts.length > 0);
          });

        if (!hasConfiguredAltProvider) {
          this.update((st) => ({ ...st, boot: "ready" }));
          return;
        }
      }

      await this.refresh();
      if (this.disposed || currentRev !== this.bootRev) return;

      this.update((st) => ({ ...st, boot: "ready" }));

      if (detectedEnv.museFound) {
        void this.bootModels();
      } else {
        this.refreshModelsInUse(false);
      }

      const initialRoute = hashToRoute(this.platform.readHash());
      this.applyRoute(initialRoute, false);

      if (detectedEnv.museFound) {
        void this.discoverAll(true);
      }

      void this.loadTitleSettings(); void this.loadSandboxSettings(); void this.loadYoloSettings();
      void this.loadResearchSettings();
      void this.loadPlanUsage();
      void this.loadAccounts();
      void this.loadProviders();
      void this.loadAssistantGlance();
    } catch (err) {
      if (this.disposed || currentRev !== this.bootRev) return;
      this.update((st) => ({ ...st, boot: "error", bootError: errorMessage(err) }));
    }
  }

  retryBoot(): void { void this.boot(true); }
  async openProvidersWithoutMuse(): Promise<void> {
    this.update((s) => ({ ...s, skipMuseOnboarding: true }));
    await this.refresh().catch(() => undefined);
    if (this.disposed) return;
    this.update((s) => ({ ...s, boot: "ready" }));
    void this.loadProviders();
    void this.loadTitleSettings();
    void this.loadSandboxSettings();
    void this.loadYoloSettings();
    void this.loadResearchSettings();
    void this.loadPlanUsage();
    void this.loadAccounts();
    void this.loadAssistantGlance();
    this.navigate({ kind: "settings" });
  }

  // ---------------------------------------------------------------- Linux setup

  private clearLinuxSetupPoll(): void {
    if (this.linuxSetupPollHandle !== null) this.platform.cancel(this.linuxSetupPollHandle);
    this.linuxSetupPollHandle = null;
  }

  private scheduleLinuxSetupPoll(): void {
    this.clearLinuxSetupPoll();
    if (this.disposed || this.state.linuxSetup?.installation.status !== "installing") return;
    this.linuxSetupPollHandle = this.platform.schedule(() => {
      this.linuxSetupPollHandle = null;
      void this.refreshLinuxSetup();
    }, 1_500);
  }

  private acceptLinuxSetup(linuxSetup: LinuxSetupView, accountId: string | null): void {
    const found = linuxSetup.museFound && linuxSetup.installation.status === "installed" && this.state.env?.museFound === false;
    this.update((s) => ({ ...s, linuxSetup, linuxSetupAccountId: accountId, linuxSetupError: null }));
    this.scheduleLinuxSetupPoll();
    // Re-probe the executable and load projects/accounts as soon as installation finishes.
    // No app restart or stale desktop PATH is needed to leave the setup screen.
    if (found) void this.boot(true);
  }

  async refreshLinuxSetup(accountId: string | null = this.state.linuxSetupAccountId): Promise<void> {
    if (this.state.env?.platform !== "linux" || !this.client.linuxSetup) return;
    if (["install", "cancel", "repair"].some((action) => this.state.busy[`linux-setup:${action}`])) return;
    const rev = ++this.linuxSetupRev;
    this.clearLinuxSetupPoll();
    this.setBusy("linux-setup:check", true);
    try {
      const view = await this.client.linuxSetup(accountId);
      if (this.disposed || rev !== this.linuxSetupRev) return;
      this.acceptLinuxSetup(view, accountId);
    } catch (error) {
      if (this.disposed || rev !== this.linuxSetupRev) return;
      this.update((s) => ({ ...s, linuxSetupError: error instanceof Error && "status" in error && error.status === 404
        ? "This Ancilla server needs an update before it can offer guided Linux setup. Update Ancilla, then check again."
        : `Could not check Linux setup. ${errorMessage(error)}` }));
      this.scheduleLinuxSetupPoll();
    } finally {
      if (rev === this.linuxSetupRev && !this.disposed) this.setBusy("linux-setup:check", false);
    }
  }

  private async changeLinuxSetup(action: "install" | "cancel" | "repair", run: () => Promise<LinuxSetupView>, accountId: string | null): Promise<void> {
    if (this.state.env?.platform !== "linux" || ["install", "cancel", "repair"].some((key) => this.state.busy[`linux-setup:${key}`])) return;
    const rev = ++this.linuxSetupRev;
    this.clearLinuxSetupPoll();
    this.setBusy("linux-setup:check", false);
    this.setBusy(`linux-setup:${action}`, true);
    this.update((s) => ({ ...s, linuxSetupError: null }));
    try {
      const view = await run();
      if (this.disposed || rev !== this.linuxSetupRev) return;
      this.acceptLinuxSetup(view, accountId);
    } catch (error) {
      if (this.disposed || rev !== this.linuxSetupRev) return;
      this.update((s) => ({ ...s, linuxSetupError: errorMessage(error) }));
      this.scheduleLinuxSetupPoll();
    } finally {
      if (rev === this.linuxSetupRev && !this.disposed) this.setBusy(`linux-setup:${action}`, false);
    }
  }

  async installLinuxMuse(): Promise<void> {
    if (!this.client.installLinuxMuse || this.state.linuxSetup?.installation.status === "installing") return;
    await this.changeLinuxSetup("install", () => this.client.installLinuxMuse!(), null);
  }

  async cancelLinuxMuseInstall(): Promise<void> {
    const attempt = this.state.linuxSetup?.installation.attemptId;
    if (!attempt || !this.client.cancelLinuxMuseInstall) return;
    await this.changeLinuxSetup("cancel", () => this.client.cancelLinuxMuseInstall!(attempt), null);
  }

  async repairLinuxStorage(): Promise<void> {
    if (!this.client.repairLinuxStorage) return;
    const accountId = this.state.linuxSetupAccountId;
    await this.changeLinuxSetup("repair", () => this.client.repairLinuxStorage!(accountId), accountId);
  }

  async refreshLinuxDesktop(): Promise<void> {
    if (this.state.env?.platform !== "linux" || !this.platform.linuxDesktop || this.state.busy["linux-desktop:install"]) return;
    const rev = ++this.linuxDesktopRev;
    try {
      const linuxDesktop = await this.platform.linuxDesktop.status();
      if (!this.disposed && rev === this.linuxDesktopRev) this.update((s) => ({ ...s, linuxDesktop, linuxDesktopError: null }));
    } catch (error) {
      if (!this.disposed && rev === this.linuxDesktopRev) this.update((s) => ({ ...s, linuxDesktopError: errorMessage(error) }));
    }
  }

  async installLinuxDesktop(desktopShortcut: boolean): Promise<void> {
    if (!this.platform.linuxDesktop || this.state.busy["linux-desktop:install"]) return;
    const rev = ++this.linuxDesktopRev;
    this.setBusy("linux-desktop:install", true);
    this.update((s) => ({ ...s, linuxDesktopError: null }));
    try {
      const linuxDesktop = await this.platform.linuxDesktop.install({ desktopShortcut });
      if (!this.disposed && rev === this.linuxDesktopRev) this.update((s) => ({ ...s, linuxDesktop, linuxDesktopError: null }));
    } catch (error) {
      if (!this.disposed && rev === this.linuxDesktopRev) this.update((s) => ({ ...s, linuxDesktopError: errorMessage(error) }));
    } finally {
      if (!this.disposed && rev === this.linuxDesktopRev) this.setBusy("linux-desktop:install", false);
    }
  }

  async relaunchLinuxDesktop(): Promise<void> {
    if (!this.platform.linuxDesktop || this.state.busy["linux-desktop:relaunch"]) return;
    if (this.state.linuxSetup?.installation.status === "installing" || Object.values(this.state.threads).some((thread) => crewBusy(thread.fold, thread.researchRuns)) || Object.values(this.state.sessions).some((session) => Boolean(session.live?.activeTurnId))) {
      this.update((s) => ({ ...s, linuxDesktopError: "Let installation, running threads and background tasks finish before relaunching Ancilla." }));
      return;
    }
    this.setBusy("linux-desktop:relaunch", true);
    try {
      await this.platform.linuxDesktop.relaunch();
    } catch (error) {
      if (!this.disposed) this.update((s) => ({ ...s, linuxDesktopError: errorMessage(error) }));
    } finally {
      if (!this.disposed) this.setBusy("linux-desktop:relaunch", false);
    }
  }

  // ---------------------------------------------------------------- data

  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.refreshing;
    }
    this.refreshing = this.loadLists()
      .catch((error) => {
        if (this.state.boot !== "ready") {
          throw error;
        }
      })
      .finally(() => {
        this.refreshing = null;
        if (this.refreshQueued) {
          this.refreshQueued = false;
          void this.refresh();
        }
      });
    return this.refreshing;
  }

  private async loadLists(): Promise<void> {
    const catchUp = this.catchUpBase;
    this.catchUpBase = null;
    this.catchUpReading = catchUp;
    const askedStatusCounts = new Map(this.statusHeard);

    let retrievedProjects: ProjectView[];
    let retrievedSessions: SessionSummary[];
    try {
      [retrievedProjects, retrievedSessions] = await Promise.all([
        this.client.listProjects(),
        this.client.listSessions(),
      ]);
    } catch (err) {
      this.catchUpBase ??= catchUp;
      throw err;
    } finally { this.catchUpReading = null; }

    const sessionDictionary: Record<string, SessionSummary> = {};
    for (const item of retrievedSessions) {
      sessionDictionary[item.sessionId] = item;
    }

    this.update((st) => {
      for (const [sid, summary] of Object.entries(sessionDictionary)) {
        const priorCount = askedStatusCounts.get(sid) ?? 0;
        sessionDictionary[sid] = this.heardStatus(summary, st.sessions[sid], priorCount);
      }
      return {
        ...st,
        projects: retrievedProjects,
        sessions: sessionDictionary,
        sessionsLoaded: true,
      };
    });

    for (const recordedId of Array.from(this.statusHeard.keys())) {
      if (!sessionDictionary[recordedId]) {
        this.statusHeard.delete(recordedId);
      }
    }

    if (catchUp) {
      this.catchUp(catchUp);
      if (this.catchUpBase !== null) {
        this.catchUpBase = this.catchUpSnapshot();
      }
    }

    for (const openThreadId of Object.keys(this.state.threads)) {
      if (!this.listed(openThreadId)) {
        this.forget(openThreadId);
      }
    }
  }

  private heardStatus(incoming: SessionSummary, cached: SessionSummary | undefined, mark: number): SessionSummary {
    if (!cached || (this.statusHeard.get(incoming.sessionId) ?? 0) === mark) {
      return incoming;
    }
    const incomingTurn = incoming.live?.activeTurnId ?? null;
    const cachedTurn = cached.live?.activeTurnId ?? null;
    return incomingTurn === cachedTurn ? incoming : { ...incoming, live: cached.live };
  }

  private scheduleRefresh(): void {
    if (this.refreshHandle !== null) return;
    this.refreshHandle = this.platform.schedule(() => {
      this.refreshHandle = null;
      void this.refresh();
    }, 150);
  }

  async discoverAll(silent = false): Promise<void> {
    if (this.state.discovering) return;
    this.update((st) => ({ ...st, discovering: true }));
    try { await this.client.discover();
      
await Promise.all([this.refresh(), this.loadPlanUsage()]);
      if (!silent) {
        this.toast("success", "Threads refreshed");
        this.refreshModelsInUse(false);
      }
    } catch (err) {
      if (!silent) {
        this.toast("error", "Could not refresh threads from Muse", errorMessage(err));
      }
    } finally { this.update((st) => ({ ...st, discovering: false })); }
  }
  modelsScope(): ModelsScope {
    const route = this.state.route;
    if (route.kind === "thread") {
      const sessionProvider = this.state.sessions[route.sessionId]?.providerId;
      return sessionProvider && sessionProvider !== "muse"
        ? { sessionId: route.sessionId, providerId: sessionProvider }
        : { sessionId: route.sessionId };
    }
    if (route.kind === "new" || route.kind === "home") {
      const proj = projectForCwd(this.state.projects, this.composerCwd());
      const providerId = proj?.defaultProviderId;
      return providerId && providerId !== "muse"
        ? { providerId, accountId: proj?.defaultAccountId ?? null }
        : { accountId: proj?.defaultAccountId ?? null };
    }
    return {};
  }

  /** The account whose login a scope's host runs as: a thread's record names it, an account scope is it. */
  private modelsAccount(scope: ModelsScope): string | null {
    return scope.sessionId ? (this.state.sessions[scope.sessionId]?.accountId ?? null) : (scope.accountId ?? null);
  }

  /**
   * Asks Muse for a scope's models and files the answer under the scope's key. A list that is fresh, or already being
   * asked for, is left be unless `force`; a failed ask keeps the last good list and says why; an older answer never
   * lands over a newer one. A named account with no login yet is never asked: its menu offers to sign in instead.
   */
  refreshModels(options: ModelsRefresh = {}): Promise<void> {
    const scope: ModelsScope = {
      ...(options.providerId ? { providerId: options.providerId } : {}),
      accountId: options.accountId ?? null,
      sessionId: options.sessionId ?? null,
    };
    const watching = options.watch === true;
    const explicitForce = options.force === true;
    return this.loadModelsFor(
      scope,
      explicitForce || watching,
      watching ? this.startModelsWatch(scope) : null,
      options.navigation === true,
      explicitForce,
    );
  }

  private loadModelsFor(
    scope: ModelsScope,
    force: boolean,
    watch: ModelsWatch | null,
    navigation = false,
    explicitForce = false,
  ): Promise<void> {
    const key = modelsKey(scope);
    const isMuse = !scope.providerId || scope.providerId === "muse";
    const account = this.modelsAccount(scope);
    if (isMuse && modelsNeedSignIn(this.state.accounts, account)) {
      return Promise.resolve();
    }
    // Until the accounts have been read, whether a named account has a login is not known, and asking one that has
    // none would start a Muse host for nothing: reading the accounts asks for the lists in use when it ends.
    if (isMuse && account !== null && this.state.accounts === null && !this.accountsSettled) {
      return Promise.resolve();
    }
    if (!force) {
      const running = this.modelLoads.get(key);
      if (running) {
        return running;
      }
      const stale = isStale(this.state.modelsStatus[key], this.platform.now(), this.state.accountModels[key], {
        navigation,
        failedAt: this.modelFailedAt.get(key),
      });
      if (!stale) {
        return Promise.resolve();
      }
    }
    const run: Promise<void> = this.readModels(scope, key, watch, explicitForce).finally(() => {
      if (this.modelLoads.get(key) === run) {
        this.modelLoads.delete(key);
      }
    });
    this.modelLoads.set(key, run);
    return run;
  }

  private async readModels(
    scope: ModelsScope,
    key: string,
    watch: ModelsWatch | null,
    explicitForce = false,
  ): Promise<void> {
    const rev = (this.modelRevs.get(key) ?? 0) + 1;
    this.modelRevs.set(key, rev);
    this.holdModelsScope(key);
    this.putModels(key, undefined, { status: "loading", error: null });
    try {      const { models, ...info } = await this.fetchModelCatalog(scope, explicitForce).catch((error: unknown) => {
        // A thread its host has not loaded cannot flag an active row, but its account's catalog still lists the models.
        const kind = errorKind(error);
        if (scope.sessionId && (kind === "sessionNotLoaded" || kind === "sessionNotFound" || kind === "sessionStreamMismatch")) {
          const sessionProvider = scope.providerId ?? this.state.sessions[scope.sessionId]?.providerId;
          return this.fetchModelCatalog({
            ...(sessionProvider && sessionProvider !== "muse" ? { providerId: sessionProvider } : {}),
            accountId: this.modelsAccount(scope),
          }, explicitForce);
        }
        throw error;
      });
      if (this.disposed || this.modelRevs.get(key) !== rev) {
        return;
      }
      this.modelFailedAt.delete(key);
      this.putModels(key, models, { status: "ready", error: null, loadedAt: this.platform.now(), catalog: info });
      if (watch && isLimitedCatalog(info)) {
        this.relistModels(scope, key, watch);
      }
    } catch (error) {
      if (this.disposed || this.modelRevs.get(key) !== rev) {
        return;
      }
      this.modelFailedAt.set(key, this.platform.now());
      this.putModels(key, undefined, { status: "error", error: errorMessage(error) });
    }
  }

  private fetchModelCatalog(scope: ModelsScope, explicitForce = false): Promise<ModelCatalog> {
    const sessionId = scope.sessionId ?? undefined;
    const accountId = scope.accountId ?? undefined;
    const providerId = scope.providerId && scope.providerId !== "muse" ? scope.providerId : undefined;
    const options = explicitForce ? { refresh: true } : undefined;
    if (this.client.listModelCatalog) {
      return providerId !== undefined
        ? this.client.listModelCatalog(sessionId, accountId, providerId, options)
        : options
          ? this.client.listModelCatalog(sessionId, accountId, undefined, options)
          : this.client.listModelCatalog(sessionId, accountId);
    }
    // A transport that cannot say where its list came from gives the rows alone.
    return (
      providerId !== undefined
        ? this.client.listModels(sessionId, accountId, providerId, options)
        : options
          ? this.client.listModels(sessionId, accountId, undefined, options)
          : this.client.listModels(sessionId, accountId)
    ).then((models) => ({ models, source: null, providerId: providerId ?? null, profileId: null, hostVersion: null }));
  }

  /** Files a scope's list and/or load status. The union every lookup reads is rebuilt when a list lands. */
  private putModels(key: string, models: ModelOption[] | undefined, status: Partial<ModelsStatus>): void {
    this.update((s) => {
      const accountModels = { ...s.accountModels, [key]: models ?? s.accountModels[key] ?? [] };
      const modelsStatus = { ...s.modelsStatus, [key]: { ...(s.modelsStatus[key] ?? NO_MODELS_STATUS), ...status } };
      return { ...s, accountModels, modelsStatus, models: models ? knownModels(accountModels, modelsStatus) : s.models };
    });
  }

  /** Keeps at most a few threads' lists: the scope asked for longest ago is let go when another comes. */
  private holdModelsScope(key: string): void {
    if (!key.startsWith("thread:")) {
      return;
    }
    const at = this.modelThreadKeys.indexOf(key);
    if (at >= 0) {
      this.modelThreadKeys.splice(at, 1);
    }
    this.modelThreadKeys.push(key);
    const dropped = this.modelThreadKeys.splice(0, Math.max(0, this.modelThreadKeys.length - MODELS_THREAD_SCOPES));
    if (dropped.length > 0) {
      this.forgetModelsScopes(dropped);
    }
  }

  /**
   * Lets go of scopes' lists and everything that waits on them: loads and re-list chains in flight end (an older
   * answer or a pending timer no longer matches), and the union every lookup reads is rebuilt without them. Revisions
   * and watch tokens are moved on, not deleted, so a scope asked for again later never meets an old chain's number.
   */
  private forgetModelsScopes(keys: readonly string[]): void {
    for (const key of keys) {
      this.modelRevs.set(key, (this.modelRevs.get(key) ?? 0) + 1);
      this.modelWatches.set(key, (this.modelWatches.get(key) ?? 0) + 1);
      this.modelLoads.delete(key);
      this.modelHostReads.delete(key);
      this.modelFailedAt.delete(key);
      const held = this.modelThreadKeys.indexOf(key);
      if (held >= 0) {
        this.modelThreadKeys.splice(held, 1);
      }
    }
    this.update((s) => {
      const accountModels = { ...s.accountModels };
      const modelsStatus = { ...s.modelsStatus };
      for (const key of keys) {
        delete accountModels[key];
        delete modelsStatus[key];
      }
      return { ...s, accountModels, modelsStatus, models: knownModels(accountModels, modelsStatus) };
    });
  }

  /** A removed account's lists: its own, and every open thread's that ran on it. Nothing of it is asked for again. */
  private forgetAccountModels(accountId: string): void {
    const threads = Object.keys(this.state.accountModels).filter(
      (key) => key.startsWith("thread:") && this.state.sessions[key.slice("thread:".length)]?.accountId === accountId,
    );
    this.forgetModelsScopes([`acct:${accountId}`, ...threads]);
    for (const note of [...this.modelNotes]) {
      if (note.startsWith(`pin:acct:${accountId}:`)) {
        this.modelNotes.delete(note);
      }
    }
  }

  private startModelsWatch(scope: ModelsScope): ModelsWatch {
    const key = modelsKey(scope);
    const token = (this.modelWatches.get(key) ?? 0) + 1;
    this.modelWatches.set(key, token);
    return { token, attempt: 0 };
  }

  /** Asks again for a scope that still has only Muse's built-in list, on the schedule, until the plan's own arrives. */
  private relistModels(scope: ModelsScope, key: string, watch: ModelsWatch): void {
    const wait = MODELS_RELIST_MS[watch.attempt];
    if (wait === undefined) {
      return;
    }
    this.later(() => {
      if (this.modelWatches.get(key) === watch.token && isLimitedCatalog(this.state.modelsStatus[key]?.catalog)) {
        void this.loadModelsFor(scope, true, { token: watch.token, attempt: watch.attempt + 1 });
      }
    }, wait);
  }

  /** Runs `fn` after `ms` unless the controller has been disposed by then. */
  private later(fn: () => void, ms: number): void {
    const handle = this.platform.schedule(() => {
      this.modelTimers.delete(handle);
      if (!this.disposed) {
        fn();
      }
    }, ms);
    this.modelTimers.add(handle);
  }

  /** The first load of the default login's models; one that fails is tried once more shortly. */
  private async bootModels(): Promise<void> {
    await this.refreshModels({ watch: true });
    if (this.state.modelsStatus["default"]?.status === "error") {
      this.later(() => void this.refreshModels({ watch: true }), MODELS_BOOT_RETRY_MS);
    }
  }

  /**
   * Asks for the lists the composer on screen needs, each only if it is stale: the default login's and its own. A
   * `navigation` (a route change, the accounts arriving) leaves a built-in list or a recent failure be; a refresh by
   * hand looks again at everything that is stale.
   */
  private refreshModelsInUse(navigation = true): void {
    const scope = this.modelsScope();
    if (this.state.env?.museFound !== false) {
      void this.refreshModels({ navigation });
    }
    if (modelsKey(scope) === "default") {
      return;
    }
    // An open thread's own list is read when its load ends, and not at all when it is read-only (it cannot switch models).
    const thread = scope.sessionId ? this.state.threads[scope.sessionId] : null;
    if (scope.sessionId && (!thread || thread.load !== "ready" || thread.readOnly)) {
      return;
    }
    void this.refreshModels({ ...scope, navigation });
  }

  /**
   * Muse's hosts were restarted, and the new ones read the catalog afresh. The lists in use are read from them; any
   * other is marked old, to be read when it is next wanted. A restart reports once per host, and asking again for each
   * report would only repeat the read: one already under way for a list is the one that sees the new hosts, since the
   * server holds a read back until the restart is over.
   */
  private modelsHostChanged(): void {
    const scope = this.modelsScope();
    const here = modelsKey(scope);
    this.update((s) => {
      const modelsStatus = { ...s.modelsStatus };
      let changed = false;
      for (const [key, status] of Object.entries(modelsStatus)) {
        if (key !== "default" && key !== here && status.status === "ready") {
          modelsStatus[key] = { ...status, status: "idle" };
          changed = true;
        }
      }
      return changed ? { ...s, modelsStatus } : s;
    });
    this.readAfterHostChange({});
    if (here !== "default") {
      this.readAfterHostChange(scope);
    }
  }

  private readAfterHostChange(scope: ModelsScope): void {
    const key = modelsKey(scope);
    if (this.modelHostReads.has(key)) {
      return;
    }
    this.modelHostReads.add(key);
    void this.refreshModels({ ...scope, watch: true }).finally(() => this.modelHostReads.delete(key));
  }

  /**
   * A Muse host died. Nothing is asked of Muse here: a host that dies as it starts would be started again by each
   * read, over and over. Every list that has rows is marked old instead, so the next time one is wanted (the picker
   * or Settings opens, a thread loads) it is read from whatever host runs by then, and the lists keep showing what
   * they had meanwhile. A built-in list's background re-listing ends with the host it was waiting on.
   */
  private modelsHostExited(): void {
    for (const [key, token] of this.modelWatches) {
      this.modelWatches.set(key, token + 1);
    }
    this.update((s) => {
      const modelsStatus = { ...s.modelsStatus };
      let changed = false;
      for (const [key, status] of Object.entries(modelsStatus)) {
        if (status.status === "ready" && (s.accountModels[key]?.length ?? 0) > 0) {
          modelsStatus[key] = { ...status, status: "idle" };
          changed = true;
        }
      }
      return changed ? { ...s, modelsStatus } : s;
    });
  }

  /**
   * Closes Muse's hosts so the next ask starts fresh ones that read the model list again, then reads it. Nothing is
   * closed under work this client can see (a turn, a workflow run, a subagent, a background task, a research run);
   * the server refuses while a turn, approval or research run is open, and that refusal is the toast.
   */
  async restartMuse(): Promise<boolean> {
    if (!this.client.restartHosts || this.state.busy["models:restart"]) {
      return false;
    }
    if (anyWorkRunning(this.state)) {
      this.toast("info", MODEL_COPY.restartRunning, "Restart Muse once it has finished.");
      return false;
    }
    this.setBusy("models:restart", true);
    try {
      await this.client.restartHosts();
      this.modelsHostChanged();
      return true;
    } catch (error) {
      this.toast("error", "Could not restart Muse", errorMessage(error));
      return false;
    } finally {
      this.setBusy("models:restart", false);
    }
  }

  /**
   * Muse says a thread's standing model cannot be served any more, after a sign-in changed the provider. Nothing was
   * switched: the repair is picking a model the plan offers, so say so and, on that thread, open the picker.
   */

  private modelRouteUnserved(sessionId: string, params: Record<string, unknown>): void {
    const rawCommand = params["commandId"];
    const commandIdentifier = typeof rawCommand === "string" ? rawCommand : "";
    const noteKey = `${sessionId}:${commandIdentifier}`;
    if (this.unservedNotes.has(noteKey)) {
      return;
    }
    this.unservedNotes.add(noteKey);

    const rawModel = params["modelId"];
    const targetModelId = typeof rawModel === "string" ? rawModel : null;
    const detailText = targetModelId ? `${modelDisplayName(targetModelId)} can no longer be served for this thread.` : undefined;
    this.toast("info", "Pick a model your plan offers", detailText);

    void this.refreshModels({ sessionId, force: true });
    const activeRoute = this.state.route;
    if (activeRoute.kind === "thread" && activeRoute.sessionId === sessionId) {
      this.setPicker("model");
    }
  }

  private async loadTitleSettings(): Promise<void> {
    const currentRev = ++this.titleSettingsRev;
    try { const retrieved = await this.client.getTitleSettings();
      
if (currentRev === this.titleSettingsRev) {
        this.update((st) => ({ ...st, titleSettings: retrieved }));
      }
    } catch {
      // Best-effort load; reopened Settings will trigger retry
    }
  }
  async loadAssistantGlance(): Promise<void> {
    const rev = ++this.assistantGlanceRev;
    try {
      const status = await this.client.assistant<AssistantStatusView>("GET", "");
      const profile = status?.profile;
      if (rev !== this.assistantGlanceRev || !profile?.character) return;
      this.update((s) => ({
        ...s,
        assistantGlance: { enabled: profile.enabled, name: profile.name, character: profile.character, open: status.tasks?.open ?? 0, needsYou: status.tasks?.needsYou ?? 0, running: status.tasks?.running ?? 0 },
      }));
      this.noteWaiting(status.tasks?.waiting);
    } catch {
      /* an older server answers 404: there is no assistant to show */
    }
  }

  /**
   * What began to wait on the person since the last reading is said once, out loud, for someone who is not looking: an
   * approval, a web task's question, a task that asks what to do. What was already waiting when the app began is not news, a
   * reading that says the same again says nothing, and a task that stops waiting and starts again is said again.
   */
  private noteWaiting(waiting: AssistantWaitingView[] | undefined): void {
    const list = waiting ?? [];
    const now = new Map(list.map((item) => [item.id, `${item.cause}|${item.reason}`] as const));
    const before = this.waitingSeen;
    this.waitingSeen = now;
    const manager = this.notifications;
    if (!before || !manager) {
      return;
    }
    for (const id of before.keys()) {
      if (!now.has(id)) {
        manager.forget(id);
      }
    }
    for (const item of list) {
      if (before.get(item.id) !== now.get(item.id)) {
        void manager.announce({ kind: "task", taskId: item.id, cause: item.cause, title: item.title }, () => this.openWaiting());
      }
    }
  }

  /** Where pressing a notice about a waiting task leads: the assistant's Tasks tab, where its question is. */
  private openWaiting(): void {
    wantAssistantTab("tasks");
    this.navigate({ kind: "assistant" });
  }

  private async loadResearchSettings(): Promise<void> {
    const rev = ++this.researchSettingsRev;
    try {
      const researchSettings = await this.client.getResearchSettings();
      if (rev === this.researchSettingsRev) {
        this.update((s) => ({ ...s, researchSettings }));
      }
    } catch {
      /* a server without the feature answers 404: the trigger then stays as it is, and Settings retries */
    }
  }


  private async loadSandboxSettings(): Promise<void> {
    const rev = ++this.sandboxSettingsRev;
    try { const retrievedSettings = await this.client.getSandboxSettings();
      
if (rev === this.sandboxSettingsRev) {
        this.update((st) => ({ ...st, sandboxSettings: retrievedSettings }));
      }
    } catch {
      // Background query failure; will be refreshed when user visits Settings
    }
  }

  private async loadYoloSettings(): Promise<void> {
    const rev = ++this.yoloSettingsRev;
    const previouslyActive = this.state.yoloSettings?.enabled === true;
    try { const currentYolo = await this.client.getYoloSettings();
      
if (rev === this.yoloSettingsRev) {
        this.update((st) => ({ ...st, yoloSettings: currentYolo }));
        if (currentYolo.enabled) {
          for (const sId of Object.keys(this.state.threads)) {
            this.convergeThread(sId);
          }
        } else if (previouslyActive) {
          this.applyYoloApprovals(false);
        }
      }
    } catch {
      // Handled gracefully on next Settings panel opening
    }
  }

  private convergeThread(sessionId: string): void {
    if (this.state.yoloSettings?.enabled !== true) return;
    const currentThread = this.state.threads[sessionId];
    const existingMode = currentThread?.fold.meta.approvalMode ?? null;
    if (currentThread && !currentThread.readOnly && existingMode !== "allowAll") {
      this.patchMeta(sessionId, { approvalMode: "allowAll" });
      void this.pushThreadModes({ [sessionId]: "allowAll" }, { [sessionId]: existingMode }, "asking");
    }
  }

  navigate(route: Route): void { this.applyRoute(route, true); }

  goBack(): void {
    const fallbackDestination: Route = { kind: "home" };
    this.navigate(this.returnRoute ?? fallbackDestination);
  }

  openThread(sessionId: string): void { this.navigate({ kind: "thread", sessionId }); }

  newThread(cwd?: string | null): void {
    const configuredTarget = cwd ?? this.state.prefs.lastProject ?? this.state.projects[0]?.cwd ?? null;
    const resolvedCwd = projectForCwd(this.state.projects, configuredTarget)
      ? configuredTarget
      : (this.state.projects[0]?.cwd ?? null);
    this.navigate({ kind: "new", cwd: resolvedCwd });
  }

  private applyRoute(requested: Route, push: boolean): void {
    let targetRoute = requested;
    const currentRoute = this.state.route;

    if (currentRoute.kind === "thread") {
      this.markSeen(currentRoute.sessionId, true);
      if (requested.kind !== "thread" || requested.sessionId !== currentRoute.sessionId) {
        this.markLeft(currentRoute.sessionId);
      }
    }

    if (targetRoute.kind === "thread" && this.state.sessionsLoaded && !this.state.sessions[targetRoute.sessionId]) {
      targetRoute = { kind: "home" };
    }

    const isCurrentOverlay = targetRoute.kind === "usage" || targetRoute.kind === "settings" || targetRoute.kind === "assistant";
    const wasPriorOverlay = currentRoute.kind === "usage" || currentRoute.kind === "settings" || currentRoute.kind === "assistant";

    if (isCurrentOverlay) {
      if (!wasPriorOverlay) {
        this.returnRoute = currentRoute;
      }
    } else {
      this.returnRoute = null;
    }

    const hasNavigatedAway = routeToHash(targetRoute) !== routeToHash(currentRoute);

    this.update((st) => ({
      ...st,
      route: targetRoute,
      planUsageSelectedAccountId: targetRoute.kind === "usage" && !wasPriorOverlay
        ? contextualPlanAccountId(st)
        : st.planUsageSelectedAccountId,
      picker: (hasNavigatedAway && st.picker === "research") ? null : st.picker,
      researchMode: hasNavigatedAway ? false : st.researchMode,
    }));

    if (push) {
      const generatedHash = routeToHash(targetRoute);
      if (this.platform.readHash() !== generatedHash) {
        this.platform.writeHash(generatedHash);
      }
    }

    if (targetRoute.kind === "thread") {
      this.markSeen(targetRoute.sessionId, true);
      const existingThread = this.state.threads[targetRoute.sessionId];
      const needsReload = !existingThread ||
        existingThread.load === "idle" ||
        existingThread.load === "error" ||
        existingThread.fold.closed ||
        existingThread.stale;

      if (needsReload) {
        void this.loadThread(targetRoute.sessionId);
      }
    } else if (targetRoute.kind === "new" || targetRoute.kind === "home") {
      if (targetRoute.kind === "new" && targetRoute.cwd) {
        this.setPrefs({ lastProject: targetRoute.cwd });
      }
      this.refreshModelsInUse();
    } else if (targetRoute.kind === "settings") {
      void this.refreshModels({ navigation: true });
      void this.refreshLinuxSetup();
      void this.refreshLinuxDesktop();
      if (this.state.titleSettings === null) void this.loadTitleSettings();
      if (this.state.sandboxSettings === null) void this.loadSandboxSettings();
      if (this.state.yoloSettings === null) void this.loadYoloSettings();
      if (this.state.researchSettings === null) void this.loadResearchSettings();
      if (this.state.accounts === null) void this.loadAccounts();
      if (this.state.providers === null) void this.loadProviders();
    }
  }

  retryStalledThread(sessionId: string): Promise<void> {
    this.staleReloads.delete(sessionId);
    this.recoveryAt.set(sessionId, this.platform.now());
    return this.loadThread(sessionId);
  }

  loadThread(sessionId: string, options: { resume?: boolean; read?: boolean } = {}): Promise<void> {
    const existingInflight = this.inflightLoads.get(sessionId);
    const shouldResume = options.resume === true;
    const shouldRead = options.read === true && !shouldResume;

    if (existingInflight && (existingInflight.resume || !shouldResume)) {
      return existingInflight.run;
    }

    const initiationPromise = existingInflight
      ? existingInflight.run.catch(() => void 0).then(() => this.reloadThread(sessionId, shouldResume, shouldRead))
      : this.reloadThread(sessionId, shouldResume, shouldRead);

    const trackedRun = initiationPromise.finally(() => {
      if (this.inflightLoads.get(sessionId)?.run === trackedRun) {
        this.inflightLoads.delete(sessionId);
      }
    });

    this.inflightLoads.set(sessionId, { run: trackedRun, resume: shouldResume });
    return trackedRun;
  }

  private mayBeBusy(sessionId: string, thread: ThreadState | undefined): boolean {
    const liveInfo = this.state.sessions[sessionId]?.live;
    if (liveInfo?.activeTurnId || (liveInfo?.pendingApprovals ?? 0) > 0 || (liveInfo?.pendingInputs ?? 0) > 0) {
      return true;
    }

    const currentFold = thread?.fold;
    if (!currentFold || currentFold.closed) return false;

    if (
      currentFold.activeTurnId !== null ||
      Object.keys(currentFold.approvals).length > 0 ||
      Object.keys(currentFold.userInputs).length > 0
    ) {
      return true;
    }

    return crewBusy(currentFold);
  }

  private async reloadThread(sessionId: string, resume = false, read = false): Promise<void> {
    const timestampStart = this.platform.now();
    const heardCountSnapshot = this.statusHeard.get(sessionId) ?? 0;
    const existingThread = this.state.threads[sessionId];
    const shouldRefreshOnly = !resume && (read || this.mayBeBusy(sessionId, existingThread));

    this.loading.set(sessionId, []);
    this.setThread(sessionId, {
      ...(existingThread ?? blankThread()),
      load: "loading",
      error: null,
    });

    try {
      const transcriptData = await this.client.loadTranscript(
        sessionId,
        shouldRefreshOnly ? { refresh: true } : undefined,
      );

      const bufferedQueue = this.loading.get(sessionId) ?? [];
      this.loading.delete(sessionId);

      const currentThreadRef = this.state.threads[sessionId] ?? existingThread;
      const priorFold = currentThreadRef?.fold ?? emptyFold();
      const loadedFold = foldFromLoad(transcriptData, priorFold);
      const synthesizedFold = keepRetry(
        priorFold,
        keepEndedTurns(priorFold, withBufferedDeltas(priorFold, loadedFold, bufferedQueue)),
      );

      const isTurnActive = synthesizedFold.activeTurnId !== null;
      const momentNow = this.platform.now();
      const hasSavedProgress = freshViewProgress(priorFold, loadedFold, transcriptData.events);
      const hasLiveProgress = bufferedQueue.length > 0 &&
        freshViewProgress(priorFold, applyEvents(priorFold, bufferedQueue), bufferedQueue);
      const hasAnyProgress = hasSavedProgress || hasLiveProgress;

      if (hasAnyProgress || !isTurnActive) {
        this.staleReloads.delete(sessionId);
      }

      this.appliedAt.set(sessionId, momentNow);
      this.noteChildren(sessionId, transcriptData.events);
      this.noteChildren(sessionId, bufferedQueue);

      const isUnavailable = transcriptData.historyUnavailable === true || transcriptData.viewHealth?.status === "unavailable";
      const isCleanlyHealthy = !isUnavailable && transcriptData.viewHealth === null;

      const historySyncConfig = isTurnActive && !hasLiveProgress && (isUnavailable || (currentThreadRef?.historySync && !isCleanlyHealthy))
        ? {
            checkedAt: momentNow,
            progressAt: hasSavedProgress ? momentNow : (currentThreadRef?.historySync?.progressAt ?? null),
          }
        : undefined;

      const isStalledVerdict = isTurnActive && !hasAnyProgress &&
        (isUnavailable || (currentThreadRef?.stalled === true && this.quietStalls.has(sessionId)));

      if (!isStalledVerdict) {
        this.quietStalls.delete(sessionId);
      }

      const isUnexplainedReadOnly = shouldRefreshOnly && transcriptData.readOnly && !transcriptData.readOnlyReason;
      const isReadableTurn = transcriptData.events.some((ev) => {
        if (!ev.method.startsWith("item/")) return false;
        const itemObj = ev.params["item"];
        const extractedItemId = typeof ev.params["itemId"] === "string"
          ? ev.params["itemId"]
          : (itemObj && typeof itemObj === "object" && "itemId" in itemObj && typeof itemObj.itemId === "string")
            ? itemObj.itemId
            : null;
        return extractedItemId !== null && loadedFold.items[extractedItemId]?.turnId === synthesizedFold.activeTurnId;
      });

      if (historySyncConfig && isReadableTurn) {
        this.readableHistory.add(sessionId);
      } else {
        this.readableHistory.delete(sessionId);
      }

      if (historySyncConfig) {
        this.recoveryAt.set(sessionId, timestampStart);
      } else if (!isTurnActive) {
        this.recoveryAt.delete(sessionId);
      }

      const activeHeldThread = this.state.threads[sessionId];
      const mergedResearchRuns = reconcileResearchRuns(
        activeHeldThread?.researchRuns ?? [],
        transcriptData.researchRuns ?? [],
      );

      this.update((st) => ({
        ...st,
        threads: {
          ...st.threads,
          [sessionId]: {
            load: "ready",
            error: null,
            readOnly: isUnexplainedReadOnly ? (currentThreadRef?.readOnly ?? false) : transcriptData.readOnly,
            readOnlyReason: isUnexplainedReadOnly ? (currentThreadRef?.readOnlyReason ?? null) : transcriptData.readOnlyReason,
            truncated: transcriptData.truncated,
            fold: synthesizedFold,
            attachments: unionById(
              activeHeldThread?.attachments ?? [],
              (transcriptData.attachments ?? []).map((file) => this.stamp(file)),
            ),
            shellRuns: unionById(activeHeldThread?.shellRuns ?? [], transcriptData.shellRuns ?? []),
            researchRuns: mergedResearchRuns,
            stalled: isStalledVerdict,
            ...(historySyncConfig ? { historySync: historySyncConfig } : {}),
          },
        },
        sessions: (transcriptData.session && !transcriptData.session.archived && (!st.sessionsLoaded || st.sessions[sessionId]))
          ? {
              ...st.sessions,
              [sessionId]: this.heardStatus(transcriptData.session, st.sessions[sessionId], heardCountSnapshot),
            }
          : st.sessions,
        researchStopping: settleStopping(st.researchStopping, mergedResearchRuns),
      }));

      this.autoAllow([sessionId]);
      this.convergeThread(sessionId);
      this.settlePending(sessionId, synthesizedFold);

      const currentActiveRoute = this.state.route;
      if (currentActiveRoute.kind === "thread" && currentActiveRoute.sessionId === sessionId && !transcriptData.readOnly) {
        void this.refreshModels({ sessionId, navigation: true });
      }
    } catch (reloadErr) {
      const leftoverBuffered = this.loading.get(sessionId) ?? [];
      this.loading.delete(sessionId);

      const baselineThread = this.state.threads[sessionId] ?? existingThread ?? blankThread();
      const partiallyAppliedFold = applyEvents(baselineThread.fold, leftoverBuffered);
      const progressedLocally = freshViewProgress(baselineThread.fold, partiallyAppliedFold, leftoverBuffered);
      const isFoldUsable = partiallyAppliedFold.order.length > 0 || partiallyAppliedFold.activeTurnId !== null;

      this.readableHistory.delete(sessionId);
      this.recoveryAt.set(sessionId, this.platform.now());
      this.noteChildren(sessionId, leftoverBuffered);

      if (progressedLocally || leftoverBuffered.some(provesLiveness)) {
        this.appliedAt.set(sessionId, this.platform.now());
      }
      if (progressedLocally) {
        this.staleReloads.delete(sessionId); this.quietStalls.delete(sessionId);
      }

      this.setThread(sessionId, {
        ...baselineThread,
        fold: partiallyAppliedFold,
        load: isFoldUsable ? "ready" : "error",
        error: errorMessage(reloadErr),
        stalled: baselineThread.stalled && partiallyAppliedFold.activeTurnId !== null && !progressedLocally,
        ...(progressedLocally ? { historySync: undefined } : {}),
      });
    }
  }
  private hear(event: AncillaEvent): void {
    try {
      this.onEvent(event);
    } catch (error) {
      console.error(`Ancilla: handling a ${event.type} event failed`, error);
      const now = this.platform.now();
      if (now - this.lastListenerErrorAt >= LISTENER_ERROR_TOAST_MS) {
        this.lastListenerErrorAt = now;
        this.toast("error", "Something went wrong updating the view", `${errorMessage(error)} Reopen the thread if it looks out of date.`);
      }
    }
  }

  /**
   * The stream is back after a drop. Nothing replays what it carried while it was down, so the lists and the open
   * thread are read again, and every other thread shows what it has as last known until it is opened. Reading is
   * all this does: a prompt is never sent from here. The reread is not repeated inside `RESYNC_GAP_MS` however often
   * the stream drops and returns; a reconnect inside the gap schedules the one reread that was held back.
   */
  private resyncAfterLost(): void {
    // Goals could have moved while the stream was down, and only the open thread is reloaded. Let every other
    // thread take the server's goal again rather than the last one it saw streamed.
    for (const id of Object.keys(this.state.threads)) {
      this.patchFold(id, (f) => (f.meta.goalSeen ? { ...f, meta: { ...f.meta, goalSeen: false } } : f));
    }
    this.markOthersStale();
    this.catchUpBase ??= this.catchUpSnapshot();
    const now = this.platform.now();
    // A clock set back puts the last reread in the future: that is a gap long past, not one still to wait out, and
    // without this the wait would be as long as the step.
    if (this.lastResyncAt > now) {
      this.lastResyncAt = Number.NEGATIVE_INFINITY;
    }
    const wait = this.lastResyncAt + RESYNC_GAP_MS - now;
    if (wait > 0) {
      if (this.resyncHandle === null) {
        this.resyncHandle = this.platform.schedule(() => {
          this.resyncHandle = null;
          if (!this.disposed) {
            this.markOthersStale();
            this.rereadAfterLost();
          }
        }, wait);
      }
      return;
    }
    this.rereadAfterLost();
  }

  /** What the app knows of each session's status right now: the base a later reread is compared with. */
  private catchUpSnapshot(): Map<string, { title: string; live: SessionSummary["live"] }> {
    return new Map(Object.values(this.state.sessions).map((s) => [s.sessionId, { title: s.title, live: s.live }] as const));
  }

  private rereadAfterLost(): void {
    this.lastResyncAt = this.platform.now();
    void this.refresh();
    const route = this.state.route;
    const open = route.kind === "thread" ? route.sessionId : null;
    // A load already in flight is joined, not restarted: that read was asked for before the loss and may predate it.
    const joined = open !== null && this.inflightLoads.has(open);
    if (open !== null) {
      void this.loadThread(open);
    }
    this.healResearchAfterLost(joined ? null : open);
  }

  /**
   * A run's ending, or a resume done in another window, can have happened while the stream was down, and nothing
   * replays it. The open thread is read again with its transcript (`skip` names it, unless that read was only
   * joined to one already out); every other thread that shows a run still going, or one that was interrupted, gets
   * one read of its research list, reconciled like any snapshot. A thread with nothing live, or one that left the
   * sidebar, is not asked about, and a read that fails is not an event: the thread keeps what it has. Only the
   * list is read: no thread is loaded, no prompt sent, no run resumed from here.
   */
  private healResearchAfterLost(skip: string | null): void {
    for (const [sessionId, thread] of Object.entries(this.state.threads)) {
      if (sessionId === skip || !this.listed(sessionId) || !thread.researchRuns.some((run) => researchLive(run) || run.status === "interrupted")) {
        continue;
      }
      void Promise.resolve()
        .then(() => this.client.listResearch(sessionId))
        .then(
          (runs) => {
            if (!this.disposed) {
              this.applyResearchRuns(sessionId, Array.isArray(runs) ? runs : []);
            }
          },
          () => undefined,
        );
    }
  }

  /** Every loaded thread but the open one shows what it has as last known; it is read again when opened. */
  private markOthersStale(): void {
    const route = this.state.route;
    const routed = route.kind === "thread" ? route.sessionId : null;
    this.update((s) => {
      const threads = { ...s.threads };
      for (const [id, thread] of Object.entries(threads)) {
        if (id !== routed && !thread.stale) {
          threads[id] = { ...thread, stale: true };
        }
      }
      return { ...s, threads };
    });
  }

  /**
   * Says what happened while the stream was down: an approval or a question that came up, a goal that stopped, a turn
   * that ended. The status events that would have said so were never heard. Several turns that ended are one notice.
   */
  private catchUp(before: Map<string, { title: string; live: SessionSummary["live"] }>): void {
    const manager = this.notifications;
    if (!manager) {
      return;
    }
    const finished: Extract<NotifyEvent, { kind: "finished" }>[] = [];
    for (const session of Object.values(this.state.sessions)) {
      const prior = before.get(session.sessionId);
      if (!prior) {
        continue;
      }
      for (const note of this.liveEdges(session.sessionId, session.title, prior.live, session.live)) {
        if (note.kind === "finished") {
          finished.push(note);
        } else {
          void manager.announce(note);
        }
      }
    }
    if (finished.length > CATCH_UP_NAMED_LIMIT) {
      void manager.announce({ kind: "finishedMany", count: finished.length, failed: finished.filter((note) => note.failed).length });
    } else {
      for (const note of finished) {
        void manager.announce(note);
      }
    }
  }


  private onEvent(event: AncillaEvent): void {
    switch (event.type) {
      case "hello": {
        const connectionPreviouslyDropped = this.state.connection === "lost";
        this.update((st) => ({ ...st, connection: "open" }));
        if (connectionPreviouslyDropped && this.state.boot === "ready") {
          this.resyncAfterLost();
          void this.loadAssistantGlance();
        }
        break;
      }
      case "connection": {
        const nextConnStatus = event.state === "open" ? "open" : "lost";
        this.update((st) => ({ ...st, connection: nextConnStatus }));
        break;
      }
      case "msp": {
        if (event.method === "skill/changed") {
          this.refreshSkillsFor(event.sessionId);
        }
        if (event.method === "session/modelRouteUnserved") {
          this.modelRouteUnserved(event.sessionId, event.params);
        }
        if (event.method === "session/viewHealthChanged" && event.params["health"] === "unavailable") {
          const targetThread = this.state.threads[event.sessionId];
          const hasActiveExecution = targetThread && (
            targetThread.fold.activeTurnId !== null ||
            Boolean(this.state.sessions[event.sessionId]?.live?.activeTurnId)
          );
          if (targetThread && hasActiveExecution && this.listed(event.sessionId)) {
            this.setThread(event.sessionId, {
              ...targetThread,
              stalled: targetThread.fold.activeTurnId !== null,
            });
            const timestampNow = this.platform.now();
            const isCurrentlySelected = this.state.route.kind === "thread" && this.state.route.sessionId === event.sessionId;
            const threshold = isCurrentlySelected ? RECOVERY_RETRY_MS : STALE_BACKOFF_MS;
            const lastAttempt = this.recoveryAt.get(event.sessionId) ?? Number.NEGATIVE_INFINITY;

            if (timestampNow - lastAttempt >= threshold) {
              this.recoveryAt.set(event.sessionId, timestampNow);
              void this.loadThread(event.sessionId);
            }
          }
        }
        this.queueEvent(event.sessionId, { method: event.method, params: event.params, at: event.at });
        break;
      }
      case "plan-usage": {
        this.takePlanUsage(event.usage, event.accountId, true);
        break;
      }
      case "provider-usage": {
        this.update((st) => {
          const quotaIndex = st.providerQuotas.findIndex(
            (item) => item.providerId === event.providerId && item.accountId === event.accountId,
          );
          if (quotaIndex < 0) return st;
          const clonedQuotas = [...st.providerQuotas];
          const found = clonedQuotas[quotaIndex]!;
          clonedQuotas[quotaIndex] = { ...found, usage: event.usage };
          return { ...st, providerQuotas: clonedQuotas };
        });
        break;
      }
      case "login-completed": {
        const activeScope = this.modelsScope();
        if (event.providerId === "muse") {
          void this.loadAccounts().then(() => {
            void this.refreshModels({ accountId: event.accountId, force: true, watch: true });
            if (
              activeScope.sessionId &&
              (!activeScope.providerId || activeScope.providerId === "muse") &&
              this.modelsAccount(activeScope) === event.accountId
            ) {
              void this.refreshModels({ ...activeScope, force: true, watch: true });
            }
          });
          void this.loadPlanUsage({ background: true });
        } else {
          void this.loadProviders(true).then(() => {
            void this.refreshModels({ providerId: event.providerId, accountId: event.accountId, force: true, watch: true });
            if (
              activeScope.sessionId &&
              activeScope.providerId === event.providerId &&
              this.modelsAccount(activeScope) === event.accountId
            ) {
              void this.refreshModels({ ...activeScope, force: true, watch: true });
            }
          });
          void this.loadPlanUsage({ background: true });
        }
        break;
      }
      case "session-status": {
        const existingSession = this.state.sessions[event.sessionId];
        if (!existingSession) {
          this.scheduleRefresh();
          break;
        }

        const priorHeard = this.statusHeard.get(event.sessionId) ?? 0;
        this.statusHeard.set(event.sessionId, priorHeard + 1);

        const previousLive = existingSession.live;
        this.update((st) => {
          const target = st.sessions[event.sessionId];
          if (!target) return st;
          return {
            ...st,
            sessions: { ...st.sessions, [event.sessionId]: { ...target, live: event.live } },
          };
        });

        this.announce(event.sessionId, existingSession.title, previousLive, event.live);

        for (const mapBase of [this.catchUpBase, this.catchUpReading]) {
          if (mapBase?.has(event.sessionId)) {
            mapBase.set(event.sessionId, { title: existingSession.title, live: event.live });
          }
        }

        if (previousLive?.viewHealth?.status === "unavailable" && event.live?.viewHealth?.status !== "unavailable") {
          this.viewRecovered(event.sessionId);
        }

        if (this.bypassArmed(event.sessionId) && (event.live?.pendingApprovals ?? 0) > 0) {
          this.loadForBypass(event.sessionId);
        }
        break;
      }
      case "shell-run": {
        this.addShellRun(event.sessionId, event.run);
        break;
      }
      case "research-run": {
        this.applyResearchRuns(event.sessionId, [event.run]);
        break;
      }
      case "assistant": {
        this.assistantChanged(event);
        break;
      }
      case "sessions-changed": {
        this.scheduleRefresh();
        break;
      }
      case "host": {
        if (event.state === "failed" || event.state === "exited") {
          this.update((st) => ({ ...st, hostError: event.message }));
          const headline = event.state === "failed" ? "Muse could not start" : "Muse stopped unexpectedly";
          this.toast("error", headline, event.message);
          if (event.state === "exited") {
            this.modelsHostExited();
          }
        } else if (event.state === "restarted") {
          this.update((st) => ({ ...st, hostError: null }));
          this.toast("info", "Muse hosts restarted", event.message);
          void this.loadYoloSettings();
          void this.loadSandboxSettings();
          this.modelsHostChanged();
        }
        break;
      }
    }
  }
  private assistantChanged(event: AssistantEventView): void {
    // Its face reacts to what just happened: pleased to keep a note, waiting when it needs an answer, concerned at a refusal.
    const mood = (event.saved ?? []).some((n) => n.status === "pending") || event.question ? "attention" : (event.saved ?? []).length > 0 ? "delight" : (event.declined ?? []).length > 0 ? "concern" : null;
    this.update((s) => ({ ...s, assistantRev: s.assistantRev + 1, assistantReaction: mood ? { mood, at: Date.now() } : s.assistantReaction }));
    void this.loadAssistantGlance();
    if (event.reason !== "memory") return;
    for (const note of event.saved ?? []) {
      const text = note.text.length > 120 ? `${note.text.slice(0, 117)}...` : note.text;
      if (note.status === "pending") this.toast("info", "Waiting for your approval", text);
      else this.toast("success", note.replaced > 0 ? "Remembered, replacing an earlier note" : "Remembered", text);
    }
    if (event.forgotten) this.toast("info", event.forgotten === 1 ? "Forgotten" : `Forgot ${event.forgotten} notes`, "The words are erased everywhere the assistant kept them.");
    if (event.question) this.toast("info", "Which one did you mean?", `${event.question.options.length} notes match. Open the Assistant page to choose.`);
    for (const refusal of event.declined ?? []) {
      if (refusal.reason.startsWith("secret")) this.toast("info", "Not saved", "That looks like a credential or an ID number, and the assistant does not keep those.");
      else if (refusal.reason === "paused") this.toast("info", "Not saved", "Capture is paused.");
    }
  }

  /** One call of the assistant's HTTP surface, for its page. */
  assistant<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    return this.client.assistant<T>(method, path, body);
  }

  /**
   * Open pages of the assistant read their data again, as they do when the server announces a change. For a change that
   * this client's own call made to the profile as a side effect (an avatar it wears was deleted or rewritten): the page
   * then holds the server's answer at once, whether or not the event stream has said so yet.
   */
  assistantMoved(): void {
    this.update((s) => ({ ...s, assistantRev: s.assistantRev + 1 }));
  }

  /** One call of the voice's HTTP surface: its status, settings and conversations. */
  voice<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (!this.client.voice) return Promise.reject(new Error("This version of Ancilla has no voice."));
    return this.client.voice<T>(method, path, body);
  }

  /** One call of the browser's HTTP surface: download preferences and native folder selection. */
  browser<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (!this.client.browser) return Promise.reject(new Error("This version of Ancilla has no browser."));
    return this.client.browser<T>(method, path, body);
  }

  /** Whether this client exposes the browser's HTTP surface. */
  get hasBrowserHttp(): boolean {
    return Boolean(this.client.browser);
  }

  /** Where a call's socket is, or null when this client has no voice. */
  /** Where the Browser panel's socket is; null where this client has no browser. */
  browserSocketUrl(): string | null {
    return this.client.browserSocketUrl ? this.client.browserSocketUrl() : null;
  }

  /** Completes any auth-cookie handshake needed before opening a browser WebSocket. */
  prepareBrowserSocket(): Promise<void> | void {
    return this.client.prepareBrowserSocket?.();
  }

  voiceSocketUrl(): string | null {
    return this.client.voiceSocketUrl ? this.client.voiceSocketUrl() : null;
  }

  /** Whether this client can make a call at all. */
  get hasVoice(): boolean {
    return Boolean(this.client.voice && this.client.voiceSocketUrl);
  }


  private queueEvent(sessionId: string, event: ViewEvent): void {
    const loadingList = this.loading.get(sessionId);
    if (loadingList) {
      loadingList.push(event);
      return;
    }

    if (!this.state.threads[sessionId]) {
      const parentSessionId = this.childParents.get(sessionId);
      if (parentSessionId && this.state.threads[parentSessionId] && provesLiveness(event)) {
        this.noteChildren(parentSessionId, [event]);
        this.childActivity.add(parentSessionId);
        this.scheduleFlush();
      }
      return;
    }

    const currentPending = this.pending.get(sessionId);
    if (currentPending) {
      currentPending.push(event);
    } else {
      this.pending.set(sessionId, [event]);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushHandle === null) { this.flushHandle = this.platform.schedule(() => this.flush(), FLUSH_MS); }
  }

  private noteChildren(parent: string, events: readonly ViewEvent[]): void {
    for (const ev of events) {
      for (const childId of childSessions(ev)) {
        if (childId !== parent) {
          this.childParents.set(childId, parent);
        }
      }
    }
  }

  flush(): void {
    this.flushHandle = null;
    if (this.pending.size === 0 && this.childActivity.size === 0) return;

    const queuedBatches = Array.from(this.pending.entries());
    this.pending.clear();
    const activeChildIds = Array.from(this.childActivity.values());
    this.childActivity.clear();

    const timestampNow = this.platform.now();

    this.update((st) => {
      const nextThreadsMap = { ...st.threads };

      for (const [sId, events] of queuedBatches) {
        const threadObj = nextThreadsMap[sId];
        if (threadObj) {
          this.noteChildren(sId, events);
          const reducedFold = applyEvents(threadObj.fold, events);
          const hasFreshProgress = freshViewProgress(threadObj.fold, reducedFold, events);
          const isAliveStream = events.some(provesLiveness);
          const isAskingUser = events.some(
            (e) => e.method === "approval/requested" || e.method === "userInput/requested",
          );
          const effectiveAliveTime = timestampNow + expectedPause(reducedFold, events);

          nextThreadsMap[sId] = {
            ...threadObj,
            fold: reducedFold,
            ...this.noteActivity(
              sId,
              threadObj,
              st,
              { progressed: hasFreshProgress, alive: isAliveStream, asking: isAskingUser },
              effectiveAliveTime,
            ),
          };
        }
      }

      for (const childParentId of activeChildIds) {
        const targetThread = nextThreadsMap[childParentId];
        if (targetThread) {
          nextThreadsMap[childParentId] = {
            ...targetThread,
            ...this.noteActivity(
              childParentId,
              targetThread,
              st,
              { progressed: false, alive: true, asking: false },
              timestampNow,
            ),
          };
        }
      }

      return { ...st, threads: nextThreadsMap };
    });

    this.autoAllow(queuedBatches.map(([id]) => id));
    this.noteEditedFiles(queuedBatches);

    for (const [id] of queuedBatches) {
      const activeThread = this.state.threads[id];
      if (activeThread) {
        this.settlePending(id, activeThread.fold);
      }
    }

    const currentRoute = this.state.route;
    if (currentRoute.kind === "thread" && queuedBatches.some(([id]) => id === currentRoute.sessionId)) {
      this.markSeen(currentRoute.sessionId);
    }
  }

  private noteActivity(id: string, thread: ThreadState, state: AppState, activity: { progressed: boolean; alive: boolean; asking: boolean }, aliveAt: number,): Partial<ThreadState> {
    if (activity.progressed) {
      this.appliedAt.set(id, aliveAt);
      this.staleReloads.delete(id); this.recoveryAt.delete(id); this.readableHistory.delete(id); this.quietStalls.delete(id);
      return { stalled: false,
        historySync: undefined,
        error: null,
      };
    }

    const isUnavailable = thread.historySync !== undefined || state.sessions[id]?.live?.viewHealth?.status === "unavailable";
    const canUnstall = activity.asking || (activity.alive && !isUnavailable);

    if (activity.alive) {
      this.appliedAt.set(id, aliveAt);
    }
    if (!canUnstall) {
      return {};
    }

    this.staleReloads.delete(id); this.quietStalls.delete(id);
    return thread.stalled ? { stalled: false } : {};
  }

  private scheduleStaleCheck(): void {
    if (this.staleHandle !== null || this.disposed) return;
    this.staleHandle = this.platform.schedule(() => {
      this.staleHandle = null;
      this.checkStaleThreads();
    }, STALE_CHECK_MS);
  }

  private checkStaleThreads(): void {
    if (!this.disposed) {
      this.scheduleStaleCheck();
    }

    const now = this.platform.now();
    const currentRoute = this.state.route;
    const activeOpenId = currentRoute.kind === "thread" ? currentRoute.sessionId : null;

    const orderedThreadEntries = Object.entries(this.state.threads).sort(
      ([idA], [idB]) => Number(idB === activeOpenId) - Number(idA === activeOpenId),
    );

    let reloadsTriggered = 0;

    for (const [id, threadState] of orderedThreadEntries) {
      if (!this.listed(id)) {
        this.forget(id);
        continue;
      }

      if (threadState.load !== "ready" || this.loading.has(id)) {
        continue;
      }

      const activeTurn = threadState.fold.activeTurnId;
      if (!activeTurn) {
        this.staleReloads.delete(id); this.quietStalls.delete(id);
        continue;
      }

      const lastApplied = this.appliedAt.get(id) ?? null;
      if (lastApplied === null) {
        continue;
      }

      const sessionLive = this.state.sessions[id]?.live;
      const isUnavailable = sessionLive?.viewHealth?.status === "unavailable" || threadState.historySync !== undefined;
      const isCurrentlyWaiting =
        Object.keys(threadState.fold.userInputs).length > 0 ||
        Object.keys(threadState.fold.approvals).length > 0 ||
        (sessionLive?.pendingInputs ?? 0) > 0 ||
        (sessionLive?.pendingApprovals ?? 0) > 0;

      if (isCurrentlyWaiting && !isUnavailable && !threadState.error) {
        this.appliedAt.set(id, now);
        this.staleReloads.delete(id); this.quietStalls.delete(id);
        if (threadState.stalled) {
          this.setThread(id, { ...threadState, stalled: false });
        }
        continue;
      }

      const isFocused = id === activeOpenId;
      const syncCadence = isFocused ? HISTORY_SYNC_MS : STALE_BACKOFF_MS;

      if (threadState.historySync && this.readableHistory.has(id) && !threadState.error) {
        const lastRecoveryAttempt = this.recoveryAt.get(id) ?? threadState.historySync.checkedAt;
        if (now - lastRecoveryAttempt < syncCadence) continue;
        if (!isFocused && reloadsTriggered >= WATCHDOG_RELOADS_PER_TICK) continue;

        reloadsTriggered += 1;
        const priorSpent = this.staleReloads.get(id);
        const nextAttemptCount = priorSpent?.turnId === activeTurn ? priorSpent.count + 1 : 1;
        this.staleReloads.set(id, { turnId: activeTurn, count: nextAttemptCount });
        this.recoveryAt.set(id, now);
        void this.loadThread(id);
        continue;
      }

      if (!isUnavailable && !threadState.error && staleThreadReason(activeTurn, sessionLive?.activeTurnId ?? null, lastApplied, now) === null) {
        continue;
      }

      const existingRecord = this.staleReloads.get(id);
      const attemptCount = (existingRecord && existingRecord.turnId === activeTurn) ? existingRecord.count : 0;

      if (attemptCount >= STALE_RELOAD_LIMIT) {
        if (!isUnavailable && !threadState.error) {
          this.quietStalls.add(id);
        }
        if (!threadState.stalled) {
          this.setThread(id, { ...threadState, stalled: true });
        }
      }

      const requiredCooldown = (attemptCount >= STALE_RELOAD_LIMIT || (threadState.historySync && !isFocused))
        ? STALE_BACKOFF_MS
        : RECOVERY_RETRY_MS;

      const lastChecked = this.recoveryAt.get(id) ?? lastApplied;
      if ((attemptCount >= STALE_RELOAD_LIMIT || isUnavailable || threadState.error) && now - lastChecked < requiredCooldown) {
        continue;
      }

      if (!isFocused && reloadsTriggered >= WATCHDOG_RELOADS_PER_TICK) {
        continue;
      }

      reloadsTriggered += 1;
      this.recoveryAt.set(id, now);
      this.staleReloads.set(id, { turnId: activeTurn, count: attemptCount + 1 });
      void this.loadThread(id);
    }
  }

  private listed(sessionId: string): boolean {
    const currentState = this.state;
    if (!currentState.sessionsLoaded || (currentState.route.kind === "thread" && currentState.route.sessionId === sessionId)) {
      return true;
    }
    const foundSession = currentState.sessions[sessionId];
    return foundSession !== undefined && !foundSession.archived && projectForCwd(currentState.projects, foundSession.cwd) !== null;
  }

  private forget(sessionId: string): void {
    this.staleReloads.delete(sessionId); this.recoveryAt.delete(sessionId); this.readableHistory.delete(sessionId); this.quietStalls.delete(sessionId);
    const existing = this.state.threads[sessionId];
    if (existing && !existing.stale) {
      this.setThread(sessionId, { ...existing, stale: true });
    }
  }

  private viewRecovered(sessionId: string): void {
    const target = this.state.threads[sessionId];
    if (!target) return;

    this.readableHistory.delete(sessionId); this.recoveryAt.delete(sessionId);
    this.staleReloads.delete(sessionId); this.quietStalls.delete(sessionId);
    this.appliedAt.set(sessionId, this.platform.now());

    if (target.historySync !== undefined || target.stalled) {
      const { historySync: _unused, ...remainingProps } = target;
      this.setThread(sessionId, { ...remainingProps, stalled: false });
    }
  }

  private noteEditedFiles(batches: [string, ViewEvent[]][]): void {
    const modifiedFileKeys: string[] = [];

    for (const [sessionId, eventList] of batches) {
      const sessionCwd = this.state.sessions[sessionId]?.cwd;
      if (!sessionCwd) continue;

      for (const ev of eventList) {
        const itemPayload = ev.method === "item/completed"
          ? (ev.params["item"] as import("../types.js").MspItem | undefined)
          : undefined;

        if (!itemPayload || itemPayload.kind !== "toolCall" || itemPayload.status !== "completed") {
          continue;
        }

        const toolDesc = describeTool(itemPayload);
        const resolvedTarget = (toolDesc.kind === "edit" || toolDesc.kind === "write") && toolDesc.subject
          ? fileTarget(toolDesc.subject, sessionCwd)
          : null;

        if (resolvedTarget) {
          modifiedFileKeys.push(fileKey(sessionCwd, resolvedTarget.path));
        }
      }
    }

    if (modifiedFileKeys.length > 0) {
      this.update((st) => {
        const nextVersions = { ...st.fileVersions };
        for (const k of modifiedFileKeys) {
          nextVersions[k] = (nextVersions[k] ?? 0) + 1;
        }
        return { ...st, fileVersions: nextVersions };
      });
    }
  }

  async send(text: string, options: SendOptions = {}): Promise<boolean> {
    const normalizedText = text.trim();
    const attachedFiles = options.attachments ?? [];

    if (!normalizedText && attachedFiles.length === 0) return false;

    if (!options.raw && normalizedText) {
      const shellCmdMatch = /^!\s*([\s\S]+)$/.exec(normalizedText);
      if (shellCmdMatch && shellCmdMatch[1]) {
        return this.runShell(shellCmdMatch[1].trim());
      }

      const parsedSlashCmd = parseSlash(normalizedText);
      if (parsedSlashCmd) {
        return this.runSlash(normalizedText, parsedSlashCmd, {
          steer: options.steer,
          queue: options.queue,
          attachments: attachedFiles,
          previews: options.previews,
        });
      }
    }

    return this.deliver(normalizedText, {
      steer: options.steer,
      queue: options.queue,
      attachments: attachedFiles,
      previews: options.previews,
    });
  }

  private newThreadTarget(): string | null {
    const currentRoute = this.state.route;
    const designatedTarget = (currentRoute.kind === "new" ? currentRoute.cwd : null) ??
      this.state.prefs.lastProject ??
      this.state.projects[0]?.cwd ??
      null;

    if (!designatedTarget) {
      this.toast("info", "Add a project first", "Pick the folder Muse should work in.");
      this.setAddProjectOpen(true);
    }
    return designatedTarget;
  }

  private deliver(text: string, options: TurnDelivery): Promise<boolean> {
    const currentRoute = this.state.route;
    const targetSessionId = options.sessionId ?? (currentRoute.kind === "thread" ? currentRoute.sessionId : null);

    if (targetSessionId) {
      return this.sendToThread(targetSessionId, text, options, false);
    }

    const projectRootCwd = this.newThreadTarget();
    if (!projectRootCwd) {
      return Promise.resolve(false);
    }

    return this.startThread(
      projectRootCwd,
      options.displayText ?? text,
      (newSessionId) => this.sendToThread(newSessionId, text, options, false),
      { attachments: options.attachments, previews: options.previews },
    );
  }

  takeDraftHandoff(key: string): { text: string; attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] } | null {
    const activeHandoff = this.state.draftHandoff;
    if (!activeHandoff || activeHandoff.key !== key) return null;
    this.update((st) => ({ ...st, draftHandoff: null }));
    const { key: _k, ...restPayload } = activeHandoff;
    return restPayload;
  }

  prefillComposer(sessionId: string, text: string, files: { attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] } = {},): void {
    this.update((st) => ({
      ...st,
      draftHandoff: { key: sessionId, text, ...files },
    }));
  }
  editResearchQuestion(sessionId: string, question: string): void {
    this.prefillComposer(sessionId, question);
    this.setResearchMode(true);
  }  /** Starts a thread in `cwd` and runs its first action there; what the user typed goes to its composer if that fails. */

  private async startThread(
    cwd: string,
    typed: string,
    first: (sessionId: string) => Promise<boolean>,
    files: { attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] } = {},
  ): Promise<boolean> {
    if (this.state.busy["start"]) return false;
    this.setBusy("start", true);

    try { const { defaultMode } = this.state.prefs;
      
const effectiveApprovalMode: ApprovalMode = this.state.yoloSettings?.enabled === true ? "allowAll" : defaultMode;

      const matchedProject = projectForCwd(this.state.projects, cwd);
      const targetProviderId = matchedProject?.defaultProviderId ?? "muse";
      const targetAccountId = matchedProject?.defaultAccountId ?? null;
      const isMuseProvider = targetProviderId === "muse";

      const catalogScope: ModelsScope = isMuseProvider ? { accountId: targetAccountId } : { providerId: targetProviderId, accountId: targetAccountId };
      const nonMuseCandidates = isMuseProvider ? [] : (this.state.accountModels[modelsKey(catalogScope)] ?? []);
      const scopePreference = defaultModelForScope(this.state.prefs, catalogScope);
      const isNonMuseVerified = !isMuseProvider && scopePreference.tried && scopePreference.modelId !== null && !/^muse-/i.test(scopePreference.modelId);

      const targetModelId = isMuseProvider
        ? this.startModel(scopePreference.modelId, targetAccountId)
        : (scopePreference.modelId && (nonMuseCandidates.some((m) => m.modelId === scopePreference.modelId) || isNonMuseVerified) ? scopePreference.modelId : null);

      const sessionObj = await this.client.startSession(cwd, {
        approvalMode: effectiveApprovalMode,
        modelId: targetModelId ?? undefined,
        accountId: targetAccountId,
        ...(isMuseProvider ? {} : { providerId: targetProviderId }),
      });

      if (isMuseProvider && targetModelId === null) {
        this.noteStartedContributor(sessionObj.modelId, targetAccountId);
      }

      const freshBaseFold = emptyFold();
      const initialFold: ThreadFold = {
        ...freshBaseFold,
        meta: {
          ...freshBaseFold.meta,
          modelId: sessionObj.modelId ?? targetModelId,
          approvalMode: effectiveApprovalMode,
        },
      };

      this.update((st) => ({
        ...st,
        sessions: { ...st.sessions, [sessionObj.sessionId]: sessionObj },
        threads: {
          ...st.threads,
          [sessionObj.sessionId]: {
            load: "ready",
            error: null,
            readOnly: false,
            readOnlyReason: null,
            truncated: false,
            fold: initialFold,
            attachments: [],
            shellRuns: [],
            researchRuns: [],
            stalled: false,
          },
        },
      }));

      this.setPrefs({ lastProject: cwd });
      this.navigate({ kind: "thread", sessionId: sessionObj.sessionId });

      const deliverySucceeded = await first(sessionObj.sessionId);
      if (!deliverySucceeded) {
        const carriedOverPayload = {
          ...(files.attachments?.length ? { attachments: files.attachments } : {}),
          ...(files.previews?.length ? { previews: files.previews } : {}),
        };
        this.update((st) => ({
          ...st,
          draftHandoff: { key: sessionObj.sessionId, text: typed, ...carriedOverPayload },
        }));
      }

      return true;
    } catch (startErr) {
      const errMessage = errorMessage(startErr);
      const isLinuxStorageFault = this.state.env?.platform === "linux" && (
        errorKind(startErr) === "muse_storage_unavailable" ||
        /(?:deletion (?:registry )?authority|surviving deletion).*unsafe path/i.test(errMessage)
      );

      if (isLinuxStorageFault) {
        const projAccount = projectForCwd(this.state.projects, cwd)?.defaultAccountId ?? null;
        void this.refreshLinuxSetup(projAccount);
        const explanation = errorKind(startErr) === "muse_storage_unavailable"
          ? errMessage
          : "Muse could not access its storage safely. Open Linux setup to check the folder and fix its permissions.";

        this.toast(
          "error",
          "Muse storage needs attention",
          `${explanation} Your draft is still here.`,
          {
            label: "Open Linux setup",
            run: () => {
              this.navigate({ kind: "settings" });
              void this.refreshLinuxSetup(projAccount);
            },
          },
        );
      } else {
        this.toast("error", "Could not start a thread", errMessage);
      }
      return false;
    } finally { this.setBusy("start", false); }
  }

  private async sendToThread(sessionId: string, text: string, options: TurnDelivery, retried: boolean,): Promise<boolean> {
    const threadState = this.state.threads[sessionId];
    if (!threadState) return false;

    if (threadState.readOnly) {
      this.toast("info", "This thread is read-only here", threadState.readOnlyReason ?? "Another Muse session has it open."); return false;
    }

    const deduplicationKey = this.sendKey(sessionId, text, options);
    if (this.inflightSends.has(deduplicationKey)) {
      return true;
    }
    this.inflightSends.add(deduplicationKey);

    const existingPromptIds = promptIds(threadState.fold);
    let isVerifyingUnconfirmed = false;
    let isDelegatedRetry = false;

    const isRunningTurn = threadState.fold.activeTurnId !== null || options.queue === true;
    const initialEcho: LocalEcho = {
      localId: nextLocalId(),
      text: options.displayText ?? text,
      turnId: null,
      disposition: isRunningTurn ? (options.steer ? "steered" : "queued") : "sending",
      createdAt: this.platform.now(),
      ...(options.previews?.length ? { attachments: options.previews } : {}),
    };

    this.patchFold(sessionId, (f) => addEcho(f, initialEcho));

    try {
      const turnAck = await this.client.sendTurn(sessionId, text, {
        ifBusy: isRunningTurn ? (options.steer ? "steer" : "queue") : undefined,
        reasoningEffort: this.turnEffort(sessionId) ?? undefined,
        displayText: options.displayText ?? (options.attachments?.length ? text : undefined),
        attachments: options.attachments,
      });

      const assignedDisposition: LocalEcho["disposition"] =
        turnAck.disposition === "queued" ? "queued" : turnAck.disposition === "steered" ? "steered" : "started";

      this.patchFold(sessionId, (f) =>
        updateEcho(f, initialEcho.localId, { turnId: turnAck.turnId, disposition: assignedDisposition }),
      );
      this.keepAttachments(sessionId, turnAck.attachments ?? []);

      const confirmedTurnId = turnAck.turnId;
      if (assignedDisposition === "started" && confirmedTurnId) {
        this.patchFold(sessionId, (f) => {
          if (f.activeTurnId || f.turns[confirmedTurnId]?.terminal) {
            return f;
          }
          return {
            ...f,
            activeTurnId: confirmedTurnId,
            turns: {
              ...f.turns,
              [confirmedTurnId]: {
                startedAt: this.platform.now(),
                ...f.turns[confirmedTurnId],
                turnId: confirmedTurnId,
              },
            },
          };
        });
      }
      return true;
    } catch (sendErr) {
      if (noAnswer(sendErr)) {
        this.patchFold(sessionId, (f) =>
          updateEcho(f, initialEcho.localId, { disposition: "unconfirmed" }),
        );
        isVerifyingUnconfirmed = true;
        this.checkUnconfirmedSend({
          sessionId,
          key: deduplicationKey,
          localId: initialEcho.localId,
          shown: initialEcho.text,
          known: existingPromptIds,
          held: isRunningTurn,
          cause: errorMessage(sendErr),
          draft: {
            text: options.displayText ?? text,
            ...(options.attachments?.length ? { attachments: options.attachments } : {}),
            ...(options.previews?.length ? { previews: options.previews } : {}),
          },
        });
        return true;
      }

      this.patchFold(sessionId, (f) => removeEcho(f, initialEcho.localId));
      const failureKind = errorKind(sendErr);

      if (!retried && (failureKind === "sessionNotLoaded" || failureKind === "sessionStreamMismatch")) {
        await this.loadThread(sessionId, { resume: true });
        this.inflightSends.delete(deduplicationKey);
        isDelegatedRetry = true;
        return await this.sendToThread(sessionId, text, options, true);
      }

      this.toast("error", "Message not sent", errorMessage(sendErr)); return false;
    } finally {
      if (!isVerifyingUnconfirmed && !isDelegatedRetry) {
        this.inflightSends.delete(deduplicationKey);
      }
    }
  }
  private checkUnconfirmedSend(send: {
    sessionId: string;
    key: string;
    localId: string;
    shown: string;
    known: readonly string[];
    /** The send was made while a turn ran (queued or steered): a prompt Muse holds is not in the saved thread yet. */
    held: boolean;
    /** What the send itself failed with, for a check that cannot say more. */
    cause: string;
    draft: { text: string; attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] };
  }): void {
    const { sessionId, localId } = send;
    let step = 0;
    const pending = () => this.state.threads[sessionId]?.fold.echoes.some((echo) => echo.localId === localId) === true;
    const release = (): void => {
      this.inflightSends.delete(send.key);
    };
    const settle = (verdict: "sent" | "notSent" | "unknown", why?: string) => {
      release();
      this.patchFold(sessionId, (f) => removeEcho(f, localId));
      if (verdict !== "sent") {
        this.returnUnsent(sessionId, send.draft, verdict, send.held ? "held" : (why ?? send.cause));
      }
    };
    const look = async () => {
      if (this.disposed) {
        return release();
      }
      // The live stream may have delivered the prompt since the last look, which is the answer.
      if (!pending()) {
        return release();
      }
      await this.loadThread(sessionId, { read: true });
      if (this.disposed || !pending()) {
        return release();
      }
      const thread = this.state.threads[sessionId];
      const readable = thread !== undefined && thread.load === "ready" && thread.error === null;
      if (thread && readable && promptLanded(thread.fold, send.known, send.shown)) {
        return settle("sent");
      }
      step += 1;
      if (step < UNCONFIRMED_CHECKS_MS.length) {
        return wait();
      }
      // A prompt that was queued or steered may simply not have started yet, so its absence proves nothing.
      settle(readable && !send.held ? "notSent" : "unknown", thread?.error ?? undefined);
    };
    const wait = () => {
      let handle: unknown = null;
      handle = this.platform.schedule(() => {
        this.sendChecks.delete(handle);
        void look().catch(() => settle("unknown"));
      }, UNCONFIRMED_CHECKS_MS[step] as number);
      this.sendChecks.add(handle);
    };
    wait();
  }

  /**
   * Gives a send's text back after it turned out not to have gone, or could not be checked. The composer takes it at
   * once when it is empty; one the person has already typed into is left alone, with a button to bring the text back.
   */
  private returnUnsent(
    sessionId: string,
    draft: { text: string; attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] },
    verdict: "notSent" | "unknown",
    /** For an unknown verdict: "held" when the send was queued or steered, otherwise what went wrong with the check. */
    detail: string,
  ): void {
    const files = {
      ...(draft.attachments ? { attachments: draft.attachments } : {}),
      ...(draft.previews ? { previews: draft.previews } : {}),
    };
    const title = verdict === "notSent" ? "Message not sent" : "Could not confirm the message";
    const why =
      verdict === "notSent"
        ? "It never showed up in the thread, so nothing ran."
        : detail === "held"
          ? "It was sent while a turn was running, so Muse may still be holding it in its queue, where Ancilla cannot see it. Check the thread and its queue before sending it again."
          : `Ancilla could not read the thread to check it (${detail}). Look there before sending it again.`;
    const tone = verdict === "notSent" ? "error" : "info";
    if (loadDraft(sessionId).trim() === "") {
      this.prefillComposer(sessionId, draft.text, files);
      this.toast(tone, title, `${why} Your text is back in the composer.`);
      return;
    }    this.toast(tone, title, why, { label: "Put it back", run: () => this.prefillComposer(sessionId, draft.text, files) });
  }  /** What makes two prompt deliveries the same send: the thread, the text, and the files riding along. */
  private sendKey(sessionId: string, text: string, options: TurnDelivery): string {    const files = (options.attachments ?? [])      .map((file) => `${file.name}:${file.mediaType}:${file.base64.length}:${file.base64.slice(0, 24)}`)      .join(",");    const mode = options.steer ? "steer" : options.queue ? "queue" : "send";    return [sessionId, mode, options.displayText ?? "", text, files].join("\n");  }

  public async stop(sessionId: string): Promise<void> {
    const actionKey = `stop:${sessionId}`;
    if (this.state.busy[actionKey]) return;
    this.setBusy(actionKey, true);
    try { const currentActiveTurn = this.state.threads[sessionId]?.fold.activeTurnId ?? undefined;
      
await this.client.interruptTurn(sessionId, currentActiveTurn);
    } catch (err) {
      this.toast("error", "Could not stop the turn", errorMessage(err));
    } finally { this.setBusy(actionKey, false); }
  }

  public async unqueue(sessionId: string, echo: LocalEcho): Promise<void> {
    if (!echo.turnId) {
      this.patchFold(sessionId, (f) => removeEcho(f, echo.localId));
      return;
    }
    try { await this.client.unqueueTurn(sessionId, echo.turnId);
      
this.patchFold(sessionId, (f) => removeEcho(f, echo.localId));
    } catch (err) {
      this.toast("info", "That message already started", errorMessage(err));
    }
  }

  public dismissTurnError(sessionId: string, turnId: string | null): void {
    if (!turnId) return;
    const dismissKey = `${sessionId}:${turnId}`;
    const previousDismissed = this.state.prefs.dismissedTurnErrors;
    if (!previousDismissed.includes(dismissKey)) {
      this.setPrefs({ dismissedTurnErrors: [...previousDismissed, dismissKey].slice(-300) });
    }
    this.patchFold(sessionId, (f) => {
      const turnRecord = f.turns[turnId];
      if (!turnRecord?.error) {
        return f;
      }
      const { error: _err, ...cleanProps } = turnRecord;
      return {
        ...f,
        turns: {
          ...f.turns,
          [turnId]: { ...cleanProps, dismissed: true },
        },
      };
    });
  }

  async retryTurn(sessionId: string, prompt: string, options: { queue?: boolean; attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] } = {},): Promise<boolean> {
    const deliveryPayload: TurnDelivery = {
      queue: options.queue,
      attachments: options.attachments,
      previews: options.previews,
      sessionId,
    };

    const parsedCmd = parseSlash(prompt);
    const sessionCwd = this.state.sessions[sessionId]?.cwd ?? null;

    if (parsedCmd && sessionCwd) {
      await this.loadSkills(sessionCwd);
      const availableSkills = this.state.skills[sessionCwd]?.skills ?? [];
      const resolution = resolveSlash(parsedCmd, slashCommands(availableSkills, { inThread: true }), availableSkills);
      if (resolution.kind !== "unknown") {
        return this.runSlash(prompt, parsedCmd, deliveryPayload);
      }
    }
    return this.sendToThread(sessionId, prompt, deliveryPayload, false);
  }

  public bypassArmed(sessionId: string): boolean {
    const isYoloActive = this.state.yoloSettings?.enabled === true;
    return this.state.bypassAll || isYoloActive || this.state.bypassThreads.includes(sessionId);
  }

  public setBypassAll(on: boolean): void {
    this.update((st) => ({ ...st, bypassAll: on }));
    if (on) { const threadKeys = Object.keys(this.state.threads); this.autoAllow(threadKeys);
      for (const sessionSummary of Object.values(this.state.sessions)) {
        if ((sessionSummary.live?.pendingApprovals ?? 0) > 0) {
          this.loadForBypass(sessionSummary.sessionId);
        }
      }
    }
  }

  private announce(sessionId: string, threadTitle: string, before: SessionSummary["live"] | undefined, after: SessionSummary["live"] | undefined,): void {
    const activeManager = this.notifications;
    if (!activeManager) return;

    for (const noteEvent of this.liveEdges(sessionId, threadTitle, before, after)) {
      void activeManager.announce(noteEvent, () => this.openThread(sessionId));
    }
  }

  private liveEdges(sessionId: string, thread: string, before: SessionSummary["live"] | undefined, after: SessionSummary["live"] | undefined,): NotifyEvent[] {
    if (!after) return [];
    const notes: NotifyEvent[] = [];

    const hasNewPendingApprovals = (after.pendingApprovals ?? 0) > 0 && (before?.pendingApprovals ?? 0) === 0;
    const shouldAnnounceApproval = !this.bypassArmed(sessionId) || this.hasUnanswerableApproval(sessionId);

    if (hasNewPendingApprovals && shouldAnnounceApproval) {
      notes.push({ kind: "approval", sessionId, thread });
    }

    if ((after.pendingInputs ?? 0) > 0 && (before?.pendingInputs ?? 0) === 0) {
      notes.push({ kind: "question", sessionId, thread });
    }

    if (after.activeTurnId === null && before?.activeTurnId != null && after.lastTerminal) {
      const isFailedOutcome = Boolean(after.lastError) || after.lastTerminal === "failed";
      notes.push({ kind: "finished", sessionId, thread, failed: isFailedOutcome });
    }

    const currentGoalStatus = after.goal?.status ?? null;
    const priorGoalStatus = before?.goal?.status ?? null;
    if (currentGoalStatus && currentGoalStatus !== "active" && currentGoalStatus !== priorGoalStatus) {
      notes.push({ kind: "goal", sessionId, thread, status: currentGoalStatus });
    }

    return notes;
  }

  private loadForBypass(sessionId: string): void {
    const currentThread = this.state.threads[sessionId];
    if (!currentThread) {
      void this.loadThread(sessionId);
    } else if (currentThread.load === "ready") {
      this.autoAllow([sessionId]);
    }
  }

  public setThreadBypass(sessionId: string, on: boolean): void {
    this.update((st) => ({
      ...st,
      bypassThreads: on
        ? Array.from(new Set([...st.bypassThreads, sessionId]))
        : st.bypassThreads.filter((id) => id !== sessionId),
    }));
    if (on) { const tgt = [sessionId]; this.autoAllow(tgt);
    }
  }

  public clearThreadBypass(): void {
    if (this.state.bypassThreads.length > 0) {
      this.update((st) => ({ ...st, bypassThreads: [] }));
    }
  }

  private allowOnce(request: ApprovalRequest): string | null {
    const available = request.availableChoices ?? [];
    const plainApproveChoice = available.find((c) => c.decision === "approved" && !c.rulePreview);
    return plainApproveChoice?.choiceId ?? null;
  }

  private hasUnanswerableApproval(sessionId: string): boolean {
    const targetThread = this.state.threads[sessionId];
    if (!targetThread) return false;
    return Object.values(targetThread.fold.approvals).some((req) => this.allowOnce(req) === null);
  }

  private autoAllow(sessionIds: Iterable<string>): void {
    const uniqueSessionIds = new Set(sessionIds);
    for (const sid of uniqueSessionIds) {
      const targetThread = this.state.threads[sid];
      if (!this.bypassArmed(sid) || !targetThread || targetThread.readOnly) {
        continue;
      }
      for (const pendingRequest of Object.values(targetThread.fold.approvals)) {
        const approveChoiceId = this.allowOnce(pendingRequest);
        if (approveChoiceId && !this.state.busy[`approval:${pendingRequest.approvalId}`]) {
          void this.decide(pendingRequest, approveChoiceId, null, "bypass");
        }
      }
    }
  }

  async decide(request: ApprovalRequest, choiceId: string, feedback: string | null, by: "user" | "bypass" = "user",): Promise<void> {
    const opKey = `approval:${request.approvalId}`;
    if (this.state.busy[opKey]) return;
    this.setBusy(opKey, true);

    const matchedChoice = (request.availableChoices ?? []).find((c) => c.choiceId === choiceId);
    const chosenDecision = matchedChoice?.decision ?? "approved";
    const clickTime = this.platform.now();

    this.patchFold(request.sessionId, (f) => {
      const updatedApprovals = { ...f.approvals };
      delete updatedApprovals[request.approvalId];

      const crewReq = f.crew.requests[request.approvalId];
      const nextCrew = crewReq && crewReq.decidedAt === null
        ? { ...f.crew, requests: { ...f.crew.requests, [request.approvalId]: { ...crewReq, decidedAt: clickTime } } }
        : f.crew;

      return {
        ...f,
        approvals: updatedApprovals,
        resolved: { ...f.resolved, [request.approvalId]: { decision: chosenDecision, resolvedBy: by } },
        crew: nextCrew,
      };
    });

    try {
      await this.client.decideApproval({ sessionId: request.sessionId, approvalId: request.approvalId, requirementId: request.currentRequirementId, choiceId, feedback });
    } catch (decisionErr) {
      const failureKind = errorKind(decisionErr);
      if (failureKind === "approvalAlreadyResolved" || failureKind === "approvalNotFound") {
        // Settled externally, card removal stands
      } else if (failureKind === "approvalRequirementStale") {
        this.restoreApproval(request);
        this.toast("info", "The request changed", "Review the updated request and decide again.");
      } else {
        this.restoreApproval(request);
        this.toast("error", "Decision not sent", errorMessage(decisionErr));
      }
    } finally { this.setBusy(opKey, false); }
  }

  private restoreApproval(request: ApprovalRequest): void {
    this.patchFold(request.sessionId, (f) => {
      const currentResolved = { ...f.resolved };
      delete currentResolved[request.approvalId];
      return {
        ...f,
        approvals: { ...f.approvals, [request.approvalId]: request },
        resolved: currentResolved,
      };
    });
  }

  private dropInput(request: UserInputRequest): void {
    this.patchFold(request.sessionId, (f) => {
      const currentInputs = { ...f.userInputs };
      delete currentInputs[request.userInputId];
      return { ...f, userInputs: currentInputs };
    });
  }

  private async settleInput(request: UserInputRequest, action: () => Promise<void>, failureTitle: string): Promise<void> {
    const busyKey = `input:${request.userInputId}`;
    if (this.state.busy[busyKey]) return;
    this.setBusy(busyKey, true);

    try { await action();
    
} catch (settleErr) {
      const errType = errorKind(settleErr);
      if (errType === "userInputAlreadySettled" || errType === "userInputNotFound") {
        this.dropInput(request);
      } else {
        this.toast("error", failureTitle, errorMessage(settleErr));
      }
    } finally { this.setBusy(busyKey, false); }
  }

  public answer(request: UserInputRequest, answers: UserInputAnswer[]): Promise<void> { return this.settleInput(request, () => this.client.answerUserInput(request.sessionId, request.userInputId, answers), "Answer not sent"); }

  public skipQuestion(request: UserInputRequest): Promise<void> { return this.settleInput(request, () => this.client.cancelUserInput(request.sessionId, request.userInputId), "Could not skip the question"); }

  public clarify(request: UserInputRequest, content: string): Promise<void> { return this.settleInput(request, () => this.client.clarifyUserInput(request.sessionId, request.userInputId, content), "Reply not sent"); }

  setDefaultModelForScope(scope: ModelsScope | string, modelId: string | null, options: { typed?: boolean } = {},): void {
    if (modelId === null || modelId === "") {
      this.setPrefs(patchDefaultModelForScope(this.state.prefs, scope, null, false));
      return;
    }
    const cleanId = modelId.trim();
    if (!cleanId) {
      this.setPrefs(patchDefaultModelForScope(this.state.prefs, scope, null, false));
      return;
    }
    const availableModels = modelsFor(this.state, scope);
    const catalogMatch = availableModels.find((m) => m.modelId === cleanId);
    const isUnlistedAttempt = !catalogMatch && (options.typed ?? true);

    if (!catalogMatch && !isModelId(cleanId)) {
      this.toast("info", "That is not a model id", modelIdError(cleanId) ?? undefined); return;
    }
    this.noteContributorPick(cleanId, catalogMatch);
    this.setPrefs(patchDefaultModelForScope(this.state.prefs, scope, cleanId, isUnlistedAttempt));
  }

  async setModel(modelId: string, options: { typed?: boolean; scope?: ModelsScope } = {}): Promise<boolean> {
    const cleanId = modelId.trim();
    const effectiveScope = options.scope ?? this.modelsScope();
    const { models: candidates, fallback: isFallbackList } = modelsShown(this.state, effectiveScope);
    const catalogHit = candidates.find((m) => m.modelId === cleanId);

    const standInOwner = isFallbackList ? this.modelsOwner(effectiveScope) : null;
    const isUnverifiedChoice = standInOwner !== null || (!catalogHit && (candidates.length > 0 || options.typed === true));

    if (!catalogHit && !isModelId(cleanId)) {
      this.toast("info", "That is not a model id", modelIdError(cleanId) ?? undefined); return false;
    }

    const activeRoute = this.state.route;
    if (activeRoute.kind !== "thread") {
      this.setPrefs(patchDefaultModelForScope(this.state.prefs, effectiveScope, cleanId, isUnverifiedChoice));
      this.noteContributorPick(cleanId, catalogHit);
      this.settleModel(cleanId, isUnverifiedChoice, standInOwner, effectiveScope);
      return true;
    }

    const currentSessionId = activeRoute.sessionId;
    const priorModelId = this.state.threads[currentSessionId]?.fold.meta.modelId ?? null;
    const globalSwitchSeq = ++this.modelSwitchRev;
    const localThreadSwitchSeq = (this.modelSwitchRevs.get(currentSessionId) ?? 0) + 1;
    this.modelSwitchRevs.set(currentSessionId, localThreadSwitchSeq);

    this.patchMeta(currentSessionId, { modelId: cleanId });

    try { await this.client.setSessionModel(currentSessionId, cleanId);
    
} catch (switchErr) {
      if (this.modelSwitchRevs.get(currentSessionId) === localThreadSwitchSeq) {
        this.patchMeta(currentSessionId, { modelId: priorModelId });
      }
      this.toast("error", "Could not switch models", errorMessage(switchErr)); return false;
    }

    if (!isUnverifiedChoice && globalSwitchSeq === this.modelSwitchRev) {
      this.setPrefs(patchDefaultModelForScope(this.state.prefs, effectiveScope, cleanId, false));
    }
    this.noteContributorPick(cleanId, catalogHit);
    this.settleModel(cleanId, isUnverifiedChoice, standInOwner, effectiveScope);
    return true;
  }
  private modelsOwner(scope: ModelsScope): string | null {
    const accountId = this.modelsAccount(scope);
    if (accountId === null) {
      return null;
    }
    if (scope.providerId && scope.providerId !== "muse") {
      return this.state.providerAccounts.find((account) => account.id === accountId)?.name ?? accountId;
    }
    return this.state.accounts?.find((account) => account.id === accountId)?.name ?? accountId;
  }

  /** The notice every Contributor model carries, once a switch to one has taken: a refused switch leaves it unsaid and unspent. */
  private noteContributorPick(id: string, listed: ModelOption | undefined): void {
    if ((listed?.contributor ?? /-contributor$/i.test(id)) && !this.state.prefs.contributorAck) {
      this.setPrefs({ contributorAck: true });      this.toast(        "info",        "Contributor model selected",        listed?.description ?? "Prompts and outputs on contributor models may be used for product improvement.",
      );    }  }

  /**
   * What a taken model choice owes the user: that an id Muse did not list is only tried, that an account whose own list
   * did not load (`standIn`) has not confirmed it, and what the new model does with the effort.
   */
  private settleModel(id: string, unlisted: boolean, standIn: string | null, scopeOverride?: ModelsScope): void {
    const scope = scopeOverride ?? this.modelsScope();
    const providerLabel = scope.providerId && scope.providerId !== "muse" ? providerBadgeName(scope.providerId) : "Muse";
    if (standIn !== null) {
      this.toast("info", MODEL_COPY.unconfirmed(id, standIn), MODEL_COPY.unconfirmedDetail);
    } else if (unlisted) {
      this.toast(
        "info",
        providerLabel === "Muse" ? `Using ${id}, which your Muse did not list` : `Using ${id}, which ${providerLabel} did not list`,
        `${providerLabel} checks access when you send a prompt.`,
      );
    }
    // A new model starts the effort notes over: the level wished for may be one it does not have.
    for (const note of this.modelNotes) {
      if (note.startsWith("effort:")) {
        this.modelNotes.delete(note);
      }
    }
    this.effortOn(id, this.modelRow(id, modelsKey(scope)), this.state.prefs.effort);
  }

  /**
   * "Muse default": new threads start on whatever Muse picks. Nothing is switched on the open thread. When Muse's
   * own pick is a Contributor model nobody chose by name, the notice every such model carries is shown once. Choosing
   * it again when new threads already follow Muse changes nothing, so it says nothing either.
   */
  clearModelPref(scopeOverride?: ModelsScope): void {
    const scope = scopeOverride ?? this.modelsScope();
    const pref = defaultModelForScope(this.state.prefs, scope);
    if (pref.modelId === null) {
      return;
    }
    this.setPrefs(patchDefaultModelForScope(this.state.prefs, scope, null, false));
    const { models } = modelsShown(this.state, scope);
    const followed = models.find((m) => m.isDefault);
    const noticed = this.noteDefaultContributor(followed);
    const route = this.state.route;    if (route.kind === "thread" && !noticed) {
      const current = this.state.threads[route.sessionId]?.fold.meta.modelId;
      const providerLabel = scope.providerId && scope.providerId !== "muse" ? providerBadgeName(scope.providerId) : "Muse";
      this.toast("info", `New threads will use ${providerLabel}'s default`, current ? `This thread stays on ${modelDisplayName(current)}.` : undefined);
    }
  }

  /** Shown once, as for any Contributor model, when Muse's own default is one and nobody picked it by name. */
  private noteDefaultContributor(row: ModelOption | undefined): boolean {
    if (!row?.contributor || this.state.prefs.contributorAck) {
      return false;
    }
    this.setPrefs({ contributorAck: true });
    this.toast("info", `Muse's default is ${modelDisplayName(row.modelId)}, a Contributor model`, row.description ?? CONTRIBUTOR_NOTE);
    return true;
  }

  /**
   * A thread Muse started on a model nobody asked for by name: if that is a Contributor model, the notice every such
   * model carries is shown once, whether or not the list names a default row (a built-in list does not).
   */
  private noteStartedContributor(modelId: string | null | undefined, accountId: string | null): void {
    if (!modelId || this.state.prefs.contributorAck) {
      return;    }    const row = this.state.accountModels[modelsKey({ accountId })]?.find((m) => m.modelId === modelId);
    if (row?.contributor ?? /-contributor$/i.test(modelId)) {
      this.noteDefaultContributor(row ?? modelStub(modelId, { contributor: true }));
    }
  }

  /**
   * The model a new thread asks Muse for. The saved default, unless the account's own list says the plan does not
   * offer it: then Muse's default, said once, with the saved choice kept (the list comes from one account, and the
   * choice may be right for another). A built-in list proves nothing, so it never overrides a choice; nor does an id
   * the user tried by hand, which stays tried across a restart (`prefs.defaultModelTried`). Muse's default being a
   * Contributor model nobody picked by name is noted once.
   */
  private startModel(saved: string | null, accountId: string | null): string | null {
    const key = modelsKey({ accountId });
    const list = this.state.accountModels[key] ?? [];
    const tried = saved !== null && this.state.prefs.defaultModelTried && saved === this.state.prefs.defaultModelId;
    const dropped =
      saved !== null &&
      list.length > 0 &&
      isPlanCatalog(this.state.modelsStatus[key]?.catalog) &&
      !list.some((m) => m.modelId === saved) &&
      !tried;
    if (dropped) {
      const note = `pin:${key}:${saved}`;
      if (!this.modelNotes.has(note)) {
        this.modelNotes.add(note);
        this.toast("info", `${modelDisplayName(saved)} is not offered on this account; using Muse's default`);
      }
    }
    if (saved === null || dropped) {
      this.noteDefaultContributor(list.find((m) => m.isDefault));
      return null;
    }
    return saved;
  }

  /**
   * A model's catalog row for the reasoning levels it takes: from the scope it is asked about, else from any other
   * list, but never from one Muse only built in, which can list fewer levels than the plan's own does.
   */
  private modelRow(modelId: string | null | undefined, key: string): ModelOption | undefined {
    return trustedModel(this.state, key, modelId);
  }

  /** The model the composer on screen is on: the open thread's, else the saved default, else what Muse lists as its own. */
  private composerModel(): { id: string | null; row: ModelOption | undefined } {
    const route = this.state.route;
    if (route.kind === "thread") {
      const id = this.state.threads[route.sessionId]?.fold.meta.modelId ?? this.state.sessions[route.sessionId]?.modelId ?? null;
      return { id, row: this.modelRow(id, modelsKey({ sessionId: route.sessionId })) };
    }
    const scope = this.modelsScope();
    const { models } = modelsShown(this.state, scope);
    const pref = defaultModelForScope(this.state.prefs, scope);
    const id = pref.modelId ?? models.find((m) => m.isDefault)?.modelId ?? null;
    return { id, row: this.modelRow(id, modelsKey(scope)) };
  }

  /**
   * The level a turn on a model runs at for the level wished for: the wish itself when the model has it, else the
   * nearest it does. The wish is never rewritten, so another model gets it back; when the two differ the user hears
   * so once for each model and wish.
   */
  private effortOn(modelId: string | null, row: ModelOption | undefined, wish: ReasoningEffort | null): ReasoningEffort | null {
    const level = effectiveEffort(wish, row);
    if (wish !== null && level !== null && level !== wish && modelId) {
      const note = `effort:${modelId}:${wish}`;
      if (!this.modelNotes.has(note)) {
        this.modelNotes.add(note);
        this.toast("info", `${effortLabel(wish)} is not available on ${modelDisplayName(modelId)}`, `Using ${effortLabel(level)}. Your choice is kept for other models.`);
      }
    }
    return level;
  }

  /** The level the next turn on a thread is sent with. */
  private turnEffort(sessionId: string): ReasoningEffort | null {
    const modelId = this.state.threads[sessionId]?.fold.meta.modelId ?? this.state.sessions[sessionId]?.modelId ?? null;
    return this.effortOn(modelId, this.modelRow(modelId, modelsKey({ sessionId })), this.state.prefs.effort);
  }

  /**
   * `/model <name>`: the model the name picks out in the composer's list. A name that fits nothing reads the list
   * again once and tries again; while Muse sent only its built-in list, the models Meta publishes answer to the name
   * too, so `wonder` finds Wonder. A name that fits models of different families opens the picker rather than guess.
   * Text is tried as a model id only when it plainly is one (an id that is listed or published, or any id-shaped text
   * with a separator or a digit, like `muse-wonder-2.0`); a bare word that fits nothing is a name nobody has, so the
   * picker opens instead and nothing is saved.
   */
  private async chooseModel(name: string): Promise<boolean> {
    const scope = this.modelsScope();
    const shown = (): readonly ModelOption[] => modelsShown(this.state, scope).models;
    let found = findModel(shown(), name, modelDisplayName);
    let matches = modelMatches(shown(), name, modelDisplayName);
    if (!found && matches.length === 0) {
      await this.refreshModels({ ...scope, force: true });
      found = findModel(shown(), name, modelDisplayName);
      matches = modelMatches(shown(), name, modelDisplayName);
    }
    let fromPublished = false;
    if (!found && matches.length === 0 && (!scope.providerId || scope.providerId === "muse") && modelsStanding(this.state, scope).limited) {
      // The built-in list names few models; what Meta publishes stands in for the rest, ranked the same way.
      const pool = [...shown(), ...publishedStubs(shown())];
      found = findModel(pool, name, modelDisplayName);
      matches = modelMatches(pool, name, modelDisplayName);
      fromPublished = true;
    }
    if (found) {
      return this.setModel(found.modelId, { typed: true });
    }
    if (fromPublished) {
      const q = name.toLowerCase().trim();
      const exact = matches.filter((m) => {
        const fam = familyOf(m.modelId);
        return fam === q || fam.endsWith("-" + q);
      });
      if (exact.length === 1 && exact[0]) {
        return this.setModel(exact[0].modelId, { typed: true });
      }
    }
    if (matches.length > 1) {
      this.toast("info", `More than one model fits ${name}`, "Pick one from the list.");
      this.setPicker("model");
      return true;
    }
    const literal = literalModelId(name, shown());
    if (literal) {
      return this.setModel(literal, { typed: true });
    }    this.toast("info", MODEL_COPY.noModel(name), "Pick one from the list.");
    this.setPicker("model");
    return false;
  }

  public async setMode(mode: ApprovalMode): Promise<void> {
    if (this.state.yoloSettings?.enabled === true) {
      this.toast("info", "YOLO is on", "Switch YOLO off to change permissions."); return;
    }
    this.setPrefs({ defaultMode: mode });
    const currentRoute = this.state.route;
    if (currentRoute.kind !== "thread") return;
    const priorMode = this.state.threads[currentRoute.sessionId]?.fold.meta.approvalMode ?? null;
    this.patchMeta(currentRoute.sessionId, { approvalMode: mode });
    try { await this.client.setApprovalMode(currentRoute.sessionId, mode);
    
} catch (modeErr) {
      this.patchMeta(currentRoute.sessionId, { approvalMode: priorMode });
      this.toast("error", "Could not change permissions", errorMessage(modeErr));
    }
  }

  public async setYoloEnabled(enabled: boolean): Promise<void> {
    if (this.state.yoloSettings?.enabled === enabled) return;
    const priorSettings = this.state.yoloSettings;
    const currentRev = ++this.yoloSettingsRev;
    let didCaptureSnapshot = false;

    if (enabled && !this.preYolo) {
      this.capturePreYolo();
      didCaptureSnapshot = true;
    }

    this.update((st) => ({ ...st, yoloSettings: { enabled } }));

    const patchTask = this.yoloSettingsChain.then(() => this.client.setYoloSettings({ enabled }));
    this.yoloSettingsChain = patchTask.then(
      () => void 0,
      () => void 0,
    );

    try { const nextYolo = await patchTask;
      
if (currentRev === this.yoloSettingsRev) {
        this.update((st) => ({ ...st, yoloSettings: nextYolo }));
        this.applyYoloApprovals(enabled);
      }
    } catch (yoloErr) {
      if (currentRev === this.yoloSettingsRev) {
        this.update((st) => ({ ...st, yoloSettings: priorSettings }));
        this.toast("error", "Could not change the YOLO setting", errorMessage(yoloErr));
        if (didCaptureSnapshot) {
          this.preYolo = null;
          this.setPrefs({ preYolo: null });
        }
      }
    }
  }

  private capturePreYolo(): void {
    const threadModesEntries = Object.entries(this.state.threads).map(
      ([sid, t]) => [sid, t.fold.meta.approvalMode ?? null] as const,
    );
    this.preYolo = {
      defaultMode: this.state.prefs.defaultMode,
      threads: Object.fromEntries(threadModesEntries),
    };
    this.setPrefs({ preYolo: this.preYolo });
  }

  private yoloThreadIds(): string[] {
    return Object.entries(this.state.threads)
      .filter(([, t]) => !t.readOnly)
      .map(([id]) => id);
  }

  private applyYoloApprovals(enabled: boolean): void {
    const candidateIds = this.yoloThreadIds();

    if (enabled) {
      this.setPrefs({ defaultMode: "allowAll" });
      const targetModes: Record<string, ApprovalMode> = {};
      const rollbackModes: Record<string, ApprovalMode | null> = {};

      for (const sid of candidateIds) {
        targetModes[sid] = "allowAll";
        rollbackModes[sid] = this.state.threads[sid]?.fold.meta.approvalMode ?? null;
      }

      this.update((st) => {
        const nextThreads = { ...st.threads };
        for (const sid of candidateIds) {
          const tObj = nextThreads[sid];
          if (tObj) {
            nextThreads[sid] = {
              ...tObj,
              fold: { ...tObj.fold, meta: { ...tObj.fold.meta, approvalMode: "allowAll" } },
            };
          }
        }
        return { ...st, threads: nextThreads };
      });

      void this.pushThreadModes(targetModes, rollbackModes, "asking");
      this.autoAllow(Object.keys(this.state.threads));
      return;
    }

    const priorSnapshot = this.preYolo;
    this.preYolo = null; this.setPrefs({ preYolo: null });

    const fallbackRestoredDefault: ApprovalMode = priorSnapshot?.defaultMode ?? "onRequest";
    if (priorSnapshot) {
      this.setPrefs({ defaultMode: priorSnapshot.defaultMode });
    } else if (this.state.prefs.defaultMode === "allowAll") {
      this.setPrefs({ defaultMode: "onRequest" });
    }

    const restoredModes: Record<string, ApprovalMode> = {};
    const optimisticRollback: Record<string, ApprovalMode | null> = {};

    for (const sid of candidateIds) {
      const modeToRestore = priorSnapshot?.threads[sid] ?? fallbackRestoredDefault;
      restoredModes[sid] = modeToRestore;
      optimisticRollback[sid] = "allowAll";
    }

    this.update((st) => {
      const nextThreads = { ...st.threads };
      for (const sid of candidateIds) {
        const tObj = nextThreads[sid];
        if (tObj) {
          const desired = restoredModes[sid] ?? fallbackRestoredDefault;
          nextThreads[sid] = {
            ...tObj,
            fold: { ...tObj.fold, meta: { ...tObj.fold.meta, approvalMode: desired } },
          };
        }
      }
      return { ...st, threads: nextThreads };
    });

    void this.pushThreadModes(restoredModes, optimisticRollback, "full access");
  }

  private async pushThreadModes(
    targetModes: Record<string, ApprovalMode>,
    rollbackModes: Record<string, ApprovalMode | null>,
    kept = "full access",
  ): Promise<void> {
    const ids = Object.keys(targetModes);
    if (ids.length === 0) return;

    const results = await Promise.allSettled(
      ids.map((sid) => this.client.setApprovalMode(sid, targetModes[sid] as ApprovalMode)),
    );
    let failures = 0;
    results.forEach((res, i) => {
      if (res.status === "rejected") {
        failures++;
        const sid = ids[i] as string;
        this.patchMeta(sid, { approvalMode: rollbackModes[sid] ?? null });
      }
    });
    if (failures > 0) {
      this.toast(
        "error",
        "Could not change permissions for every thread",
        `${failures} thread${failures === 1 ? "" : "s"} kept ${kept}.`,
      );
    }
  }

  public async setTitleEnabled(enabled: boolean): Promise<void> {
    const priorTitleSettings = this.state.titleSettings;
    const currentRev = ++this.titleSettingsRev;
    this.update((st) => ({
      ...st,
      titleSettings: { enabled, modelId: priorTitleSettings?.modelId ?? null },
    }));

    try { const nextSettings = await this.client.setTitleSettings({ enabled });
      
if (currentRev === this.titleSettingsRev) {
        this.update((st) => ({ ...st, titleSettings: nextSettings }));
      }
    } catch (err) {
      if (currentRev === this.titleSettingsRev) {
        this.update((st) => ({ ...st, titleSettings: priorTitleSettings }));
        this.toast("error", "Could not change thread titles", errorMessage(err));
      }
    }
  }

  public async setTitleModel(modelId: string | null): Promise<void> {
    const priorTitleSettings = this.state.titleSettings;
    const currentRev = ++this.titleSettingsRev;
    this.update((st) => ({
      ...st,
      titleSettings: { enabled: priorTitleSettings?.enabled ?? true, modelId },
    }));

    try { const nextSettings = await this.client.setTitleSettings({ modelId });
      
if (currentRev === this.titleSettingsRev) {
        this.update((st) => ({ ...st, titleSettings: nextSettings }));
      }
    } catch (err) {
      if (currentRev === this.titleSettingsRev) {
        this.update((st) => ({ ...st, titleSettings: priorTitleSettings }));
        this.toast("error", "Could not change the title model", errorMessage(err));
      }
    }
  }

  public async setSandboxDisabled(disabled: boolean): Promise<void> {
    if (this.state.yoloSettings?.enabled === true) {
      this.toast("info", "YOLO mode is on", "The sandbox is already off. Switch YOLO off to control it separately."); return;
    }

    const priorSandbox = this.state.sandboxSettings;
    const currentRev = ++this.sandboxSettingsRev;
    this.update((st) => ({ ...st, sandboxSettings: { disabled } }));

    const patchOperation = this.sandboxSettingsChain.then(() => this.client.setSandboxSettings({ disabled }));
    this.sandboxSettingsChain = patchOperation.then(
      () => void 0,
      () => void 0,
    );

    try { const nextSettings = await patchOperation;
      
if (currentRev === this.sandboxSettingsRev) {
        this.update((st) => ({ ...st, sandboxSettings: nextSettings }));
      }
    } catch (err) {
      if (currentRev === this.sandboxSettingsRev) {
        this.update((st) => ({ ...st, sandboxSettings: priorSandbox }));
        this.toast("error", "Could not change the sandbox setting", errorMessage(err));
      }
    }
  }

  public setEffort(effort: ReasoningEffort | null): void {
    this.setPrefs({ effort: effort });
    const currentRoute = this.state.route;
    const activeThread = currentRoute.kind === "thread" ? this.state.threads[currentRoute.sessionId] : undefined;
    const { id: modelIdentifier, row: modelDescriptor } = this.composerModel();
    const resolvedLevel = this.effortOn(modelIdentifier, modelDescriptor, effort);

    if (resolvedLevel === null || currentRoute.kind !== "thread" || !activeThread || activeThread.readOnly) return;

    void this.client.setReasoningEffort(currentRoute.sessionId, resolvedLevel).catch((err: unknown) => {
      const fKind = errorKind(err);
      if (fKind !== "sessionNotLoaded" && fKind !== "sessionStreamMismatch") {
        this.toast("error", "Could not change the effort for this thread", errorMessage(err));
      }
    });
  }
  selectPlanUsageAccount(accountId: string | null): void {
    this.update((s) => ({ ...s, planUsageSelectedAccountId: accountId }));
  }

  /**
   * Refresh account quotas without starting a thread; runtime observations also arrive as events. A background read
   * (a timer, the window coming back into sight) never raises the loading flag, so Refresh does not spin and the
   * "Checking subscription…" text does not flash on its own. A person's click while one is in flight still shows it,
   * and it clears when that shared read ends.
   */
  loadPlanUsage(options: { background?: boolean } = {}): Promise<void> {
    if (options.background !== true && !this.state.planUsageLoading) {
      this.update((s) => ({ ...s, planUsageLoading: true }));
    }
    if (this.planUsageLoad) return this.planUsageLoad;
    this.planUsageLoad = this.readPlanUsage().finally(() => {
      this.planUsageLoad = null;
      if (this.state.planUsageLoading) this.update((s) => ({ ...s, planUsageLoading: false }));
    });
    return this.planUsageLoad;
  }

  private async readPlanUsage(): Promise<void> {
    const eventRevision = this.planUsageEventRevision;
    const before = this.state.planUsage;
    const accountsBefore = this.state.planUsageByAccount;
    const recordsBefore = this.state.planUsageAccounts;
    try {      const report = await this.client.planUsage();
      const { usage, byAccount, accountId: sourceAccount, saved, savedAccountIds, status } = report;
      if (status !== undefined) {
        // A full report can invalidate a saved login's reading. Events received while this read was in
        // flight still win, so a delayed response cannot erase newly reported quota data.
        this.update((s) => ({
          ...s,
          planUsage: s.planUsage === before ? usage : s.planUsage,
          planUsageAccountId: s.planUsage === before ? sourceAccount ?? null : s.planUsageAccountId,
          planUsageByAccount: {
            ...byAccount,
            ...Object.fromEntries(Object.entries(s.planUsageByAccount).filter(([id, reading]) => reading !== accountsBefore[id])),
          },
        }));
      }      for (const [accountId, accountUsage] of Object.entries(byAccount)) {        this.takePlanUsage(accountUsage, accountId);      }      if (usage) {
        // New servers identify the newest account explicitly; older servers keep their inferred source.
        const accountId = sourceAccount === undefined
          ? Object.entries(byAccount).find(([, reading]) => reading.observedAtMs === usage.observedAtMs)?.[0] ?? null
          : sourceAccount;
        this.takePlanUsage(usage, accountId);
      }
      this.update((s) => ({
        ...s,
        planUsageStatus: eventRevision !== this.planUsageEventRevision ? s.planUsageStatus : status ?? (s.planUsage ? "ready" : "unobserved"),
        planUsageSaved: !s.planUsage ? false : s.planUsage === usage ? saved === true : s.planUsageSaved,
        planUsageSavedAccounts: Object.keys(s.planUsageByAccount).filter((id) =>
          s.planUsageByAccount[id] === byAccount[id] ? savedAccountIds?.includes(id) : s.planUsageSavedAccounts.includes(id)),
        planUsageAccounts: mergePlanAccounts(s.planUsageAccounts, recordsBefore, report.accounts ?? legacyPlanAccounts({
          ...report, usage: s.planUsage, accountId: s.planUsageAccountId, byAccount: s.planUsageByAccount,
        }, recordsBefore)),
        providerQuotas: report.providerQuotas ?? s.providerQuotas,
      }));
    } catch {      this.update((s) => ({ ...s,
        planUsageStatus: eventRevision === this.planUsageEventRevision ? "unavailable" : s.planUsageStatus,
        planUsageAccounts: s.planUsageAccounts.map((account) => account === recordsBefore.find((entry) => entry.accountId === account.accountId)
          ? { ...account, status: "unavailable" } : account),
      }));
    }  }  private takePlanUsage(usage: import("../types.js").PlanUsage, accountId: string | null = null, fromEvent = false): void {
    const current = this.state.planUsage;    const currentForAccount = accountId ? this.state.planUsageByAccount[accountId] : undefined;    const accountRecord = this.state.planUsageAccounts.find((entry) => entry.accountId === accountId);
    const alreadyVerified = accountRecord?.source === "meta" && samePlanUsage(accountRecord.usage, usage);
    const takeRecord = fromEvent && !alreadyVerified && (!accountRecord || usage.observedAtMs >= Math.max(accountRecord.usage?.observedAtMs ?? -Infinity, accountRecord.checkedAtMs ?? -Infinity));
    const takeGlobal = !current || current.observedAtMs < usage.observedAtMs || (fromEvent && current.observedAtMs === usage.observedAtMs);
    const takeForAccount = accountId !== null && (!currentForAccount || currentForAccount.observedAtMs < usage.observedAtMs ||
      (fromEvent && currentForAccount.observedAtMs === usage.observedAtMs));
    if (!takeGlobal && !takeForAccount && !takeRecord) {
      return;    }    if (fromEvent) this.planUsageEventRevision += 1;
    this.update((s) => ({      ...s,      planUsage: takeGlobal ? usage : s.planUsage,      planUsageAccountId: takeGlobal ? accountId : s.planUsageAccountId,
      planUsageSaved: takeGlobal ? false : s.planUsageSaved,
      planUsageSavedAccounts: fromEvent && takeForAccount ? s.planUsageSavedAccounts.filter((id) => id !== accountId) : s.planUsageSavedAccounts,
      planUsageStatus: "ready",
      planUsageByAccount: takeForAccount ? { ...s.planUsageByAccount, [accountId as string]: usage } : s.planUsageByAccount,      planUsageAccounts: takeRecord ? [...s.planUsageAccounts.filter((entry) => entry.accountId !== accountId), {
        accountId, usage, planName: accountRecord?.planName ?? null, source: "runtime", status: "runtime-only", checkedAtMs: accountRecord?.checkedAtMs ?? null,
      }] : s.planUsageAccounts,
    }));  }  // ---------------------------------------------------------------- accounts

  public async loadAccounts(): Promise<void> {
    const rev = ++this.accountsRev;
    try { const retrievedAccounts = await this.client.listAccounts();
      
if (rev === this.accountsRev) {
        this.update((st) => ({ ...st, accounts: retrievedAccounts }));
      }
    } catch {
      // Ignored; Settings retry will re-fetch
    }
    this.accountsSettled = true;
    if (!this.disposed) {
      this.refreshModelsInUse();
    }
    void this.loadAccountsHealth();
  }

  public async loadAccountsHealth(): Promise<void> {
    const rev = ++this.accountsHealthRev;
    try { const healthRes = await this.client.accountsHealth();
      
if (rev === this.accountsHealthRev) {
        this.update((st) => ({
          ...st,
          metaApiKeyInherited: healthRes.metaApiKeyInherited,
          defaultLogin: healthRes.defaultLogin ?? null,
        }));
      }
    } catch {
      // Endpoint might not exist on older daemon
    }
  }

  public async createAccount(id: string, name?: string, seedFromDefault?: boolean): Promise<boolean> {
    const creationTask = this.accountsChain.then(() =>
      this.client.createAccount(id, {
        ...(name ? { name } : {}),
        seedFromDefault: seedFromDefault ?? false,
      }),
    );
    this.accountsChain = creationTask.then(
      () => void 0,
      () => void 0,
    );

    try { await creationTask;
      
await this.loadAccounts();
      return true;
    } catch (err) {
      this.toast("error", "Could not create the account", errorMessage(err)); return false;
    }
  }

  public async renameAccount(id: string, name: string): Promise<boolean> {
    const renameTask = this.accountsChain.then(() => this.client.renameAccount(id, name));
    this.accountsChain = renameTask.then(
      () => void 0,
      () => void 0,
    );

    try { await renameTask;
      
await this.loadAccounts();
      return true;
    } catch (err) {
      this.toast("error", "Could not rename the account", errorMessage(err)); return false;
    }
  }

  public async removeAccount(id: string): Promise<boolean> {
    const removalTask = this.accountsChain.then(() => this.client.removeAccount(id));
    this.accountsChain = removalTask.then(
      () => void 0,
      () => void 0,
    );

    try { await removalTask;
    
} catch (err) {
      this.toast("error", "Could not remove the account", errorMessage(err)); return false;
    }

    this.forgetPlanAccount(id);
    this.forgetAccountModels(id);
    await this.loadAccounts();
    void (this.planUsageLoad ?? Promise.resolve()).then(() => this.loadPlanUsage({ background: true }));
    return true;
  }

  private forgetPlanAccount(id: string): void {
    this.update((st) => ({
      ...st,
      planUsage: st.planUsageAccountId === id ? null : st.planUsage,
      planUsageAccountId: st.planUsageAccountId === id ? null : st.planUsageAccountId,
      planUsageSaved: st.planUsageAccountId === id ? false : st.planUsageSaved,
      planUsageAccounts: st.planUsageAccounts.filter((acc) => acc.accountId !== id),
      planUsageByAccount: Object.fromEntries(Object.entries(st.planUsageByAccount).filter(([k]) => k !== id)),
      planUsageSavedAccounts: st.planUsageSavedAccounts.filter((k) => k !== id),
      planUsageSelectedAccountId: st.planUsageSelectedAccountId === id ? null : st.planUsageSelectedAccountId,
      projects: st.projects.map((proj) => (proj.defaultAccountId === id ? { ...proj, defaultAccountId: null } : proj)),
    }));
  }

  async setProjectDefaultAccount(cwd: string, accountId: string | null, providerId?: ProviderId): Promise<void> {
    const priorProjects = this.state.projects;
    const rev = ++this.projectDefaultRev;

    this.update((st) => ({
      ...st,
      projects: st.projects.map((p) =>
        p.cwd === cwd
          ? { ...p, defaultAccountId: accountId, ...(providerId !== undefined ? { defaultProviderId: providerId } : {}) }
          : p,
      ),
    }));

    const updateTask = this.accountsChain.then(() =>
      providerId !== undefined
        ? this.client.setProjectDefaultAccount(cwd, accountId, providerId)
        : this.client.setProjectDefaultAccount(cwd, accountId),
    );

    this.accountsChain = updateTask.then(
      () => void 0,
      () => void 0,
    );

    try { await updateTask;
      
if (rev === this.projectDefaultRev) {
        const activeProv = providerId ?? projectForCwd(this.state.projects, cwd)?.defaultProviderId;
        void this.refreshModels({
          accountId,
          ...(activeProv && activeProv !== "muse" ? { providerId: activeProv } : {}),
        });
      }
    } catch (err) {
      if (rev === this.projectDefaultRev) {
        this.update((st) => ({ ...st, projects: priorProjects }));
        this.toast("error", "Could not set the default account", errorMessage(err));
      }
    }
  }

  async beginLogin(id: string | null): Promise<void> {
    this.cancelLogin();
    const rev = ++this.loginRev;
    this.update((st) => ({ ...st, accountLogin: { accountId: id, url: "", code: null, status: "starting" } }));

    try { const outcome = await this.client.loginAccount(id);
      
if (rev !== this.loginRev) {
        if ("loginId" in outcome && outcome.loginId) {
          void this.client.cancelAccountLogin?.(id, outcome.loginId).catch(() => void 0);
        }
        return;
      }

      if ("fallback" in outcome) {
        this.update((st) => ({ ...st, accountLogin: { accountId: id, fallback: outcome.fallback } }));
        return;
      }

      this.update((st) => ({
        ...st,
        accountLogin: {
          accountId: id,
          url: outcome.url,
          code: outcome.code,
          status: "waiting",
          ...(outcome.loginId ? { loginId: outcome.loginId } : {}),
        },
      }));
      this.loginPollAttempts = 0;
      this.scheduleLoginPoll(id, rev);
    } catch (err) {
      if (rev !== this.loginRev) return;
      this.update((st) => ({
        ...st,
        accountLogin: {
          accountId: id,
          url: "",
          code: null,
          status: "error",
          message: errorMessage(err),
        },
      }));
    }
  }

  public cancelLogin(): void {
    const currentActiveLogin = this.state.accountLogin;
    this.loginRev += 1; this.stopLoginPoll();
    this.update((st) => ({ ...st, accountLogin: null }));

    if (currentActiveLogin && "loginId" in currentActiveLogin && currentActiveLogin.loginId && currentActiveLogin.status !== "done") {
      void this.client.cancelAccountLogin?.(currentActiveLogin.accountId, currentActiveLogin.loginId).catch(() => void 0);
    }
  }
  async checkLogin(): Promise<void> {
    const login = this.state.accountLogin;
    if (!login || !("status" in login) || login.status === "starting" || login.status === "done") return;
    this.stopLoginPoll();
    const rev = ++this.loginRev;
    this.update((s) => ({ ...s, accountLogin: { ...login, status: "waiting", message: undefined } }));
    await this.pollLogin(login.accountId, rev);
  }


  private scheduleLoginPoll(id: string | null, rev: number): void {
    if (this.disposed || rev !== this.loginRev) return;
    this.loginPollHandle = this.platform.schedule(() => {
      this.loginPollHandle = null;
      void this.pollLogin(id, rev);
    }, LOGIN_POLL_MS);
  }

  private async pollLogin(id: string | null, rev: number): Promise<void> {
    if (rev !== this.loginRev || !this.isWaitingLogin(id)) {
      return;
    }
    this.loginPollAttempts += 1;
    const currentLoginState = this.state.accountLogin;
    let isFinished = false;

    if (currentLoginState && "loginId" in currentLoginState && currentLoginState.loginId && this.client.accountLoginProgress) {
      try { const progressCheck = await this.client.accountLoginProgress(id, currentLoginState.loginId);
        
if (rev !== this.loginRev || !this.isWaitingLogin(id)) return;

        if (progressCheck.status === "error" || progressCheck.status === "idle") {
          this.update((st) => ({
            ...st,
            accountLogin: {
              ...currentLoginState,
              status: "error",
              message: progressCheck.message ?? "This sign-in is no longer active. Start again for a new code.",
            },
          }));
          return;
        }
        isFinished = progressCheck.status === "done";
      } catch {
        if (rev !== this.loginRev || !this.isWaitingLogin(id)) return;
        this.update((st) => ({
          ...st,
          accountLogin: {
            ...currentLoginState,
            status: "timeout",
            message: "Ancilla could not check sign-in. Check your connection, then choose Check sign-in.",
          },
        }));
        return;
      }
    } else {
      await this.loadAccounts();
      isFinished = id !== null && this.state.accounts?.some((acc) => acc.id === id && acc.hasLogin) === true;
    }

    if (rev !== this.loginRev || !this.isWaitingLogin(id)) {
      return;
    }

    if (isFinished) {
      this.update((st) => {
        const existing = st.accountLogin;
        if (!existing || existing.accountId !== id || !("status" in existing)) {
          return st;
        }
        return { ...st, accountLogin: { ...existing, status: "done" } };
      });

      void this.loadAccounts().then(() => {
        void this.refreshModels({ accountId: id, force: true, watch: true });
        const currentScope = this.modelsScope();
        if (
          currentScope.sessionId &&
          (!currentScope.providerId || currentScope.providerId === "muse") &&
          this.modelsAccount(currentScope) === id
        ) {
          void this.refreshModels({ ...currentScope, force: true, watch: true });
        }
      });
      void this.loadPlanUsage();
      return;
    }

    if (this.loginPollAttempts >= LOGIN_POLL_MAX_ATTEMPTS) {
      this.update((st) => {
        const existing = st.accountLogin;
        return existing && "status" in existing
          ? {
              ...st,
              accountLogin: {
                ...existing,
                status: "timeout",
                message: "Sign-in has not been confirmed. If you finished in the browser, check again. Otherwise, start again for a new code.",
              },
            }
          : st;
      });
      return;
    }

    this.scheduleLoginPoll(id, rev);
  }

  private isWaitingLogin(id: string | null): boolean {
    const cur = this.state.accountLogin;
    return Boolean(cur && cur.accountId === id && "status" in cur && cur.status === "waiting");
  }

  private stopLoginPoll(): void {
    if (this.loginPollHandle !== null) {
      this.platform.cancel(this.loginPollHandle);
      this.loginPollHandle = null;
    }
    this.loginPollAttempts = 0;
  }
  async loadProviders(refresh = false): Promise<void> {
    if (!this.client.listProviders) {
      return;
    }
    const rev = ++this.providersRev;
    try {
      const catalog = await this.client.listProviders(refresh);
      if (this.disposed || rev !== this.providersRev) {
        return;
      }
      this.update((s) => ({
        ...s,
        providers: catalog.providers,
        providerAccounts: catalog.accounts,
        ambientKeyOverrides: catalog.ambientKeyOverrides ?? {},
        remoteDeployment: catalog.remoteDeployment === true,
        sourceOfferUrl: catalog.sourceOfferUrl ?? null,
      }));
      this.refreshModelsInUse();
    } catch {
      /* older servers without /api/providers leave providers null */
    }
  }

  async saveProviderAccount(id: string | null, input: Record<string, unknown>): Promise<ProviderAccountView | null> {
    const fn = id === null ? this.client.createProviderAccount : this.client.updateProviderAccount;
    if (!fn) {
      return null;
    }
    const key = `provider-account:${id ?? "new"}`;
    if (this.state.busy[key]) {
      return null;
    }
    this.setBusy(key, true);
    try {
      const saved = id === null
        ? await this.client.createProviderAccount!(input)
        : await this.client.updateProviderAccount!(id, input);
      await Promise.all([this.loadProviders(true), this.loadPlanUsage({ background: true })]);
      void this.refreshModels({ providerId: saved.providerId, accountId: saved.id, force: true });
      this.toast("success", id === null ? `Added ${saved.name}` : `Saved ${saved.name}`);
      return saved;
    } catch (error) {
      this.toast("error", id === null ? "Could not add provider profile" : "Could not update provider profile", errorMessage(error));
      return null;
    } finally {
      this.setBusy(key, false);
    }
  }

  async removeProviderAccount(id: string): Promise<boolean> {
    if (!this.client.deleteProviderAccount) {
      return false;
    }
    const key = `provider-account:delete:${id}`;
    if (this.state.busy[key]) {
      return false;
    }
    const existing = this.state.providerAccounts.find((a) => a.id === id);
    this.setBusy(key, true);
    try {
      await this.client.deleteProviderAccount(id);
      if (existing) {
        this.forgetModelsScopes([modelsKey({ providerId: existing.providerId, accountId: id })]);
      }
      await Promise.all([this.loadProviders(true), this.refresh(), this.loadPlanUsage({ background: true })]);
      this.toast("info", existing ? `Removed ${existing.name}` : "Removed provider profile");
      return true;
    } catch (error) {
      this.toast("error", "Could not remove provider profile", errorMessage(error));
      return false;
    } finally {
      this.setBusy(key, false);
    }
  }

  async beginProviderLogin(providerId: ProviderId, accountId: string | null = null): Promise<void> {
    if (!this.client.loginProvider) {
      return;
    }
    this.cancelProviderLogin();
    const rev = ++this.providerLoginRev;
    this.update((s) => ({
      ...s,
      providerLogin: { providerId, accountId, status: "starting", url: null, code: null },
    }));
    try {
      const res = await this.client.loginProvider(providerId, accountId);
      if (rev !== this.providerLoginRev) {
        if (res.loginId) {
          void this.client.cancelProviderLogin?.(providerId, res.loginId, accountId).catch(() => undefined);
        }
        return;
      }
      this.update((s) => ({
        ...s,
        providerLogin: {
          providerId,
          accountId,
          status: res.status,
          url: res.url,
          code: res.code,
          ...(res.needsCodeInput !== undefined ? { needsCodeInput: res.needsCodeInput } : {}),
          ...(res.loginId ? { loginId: res.loginId } : {}),
          ...(res.terminalCommand ? { terminalCommand: res.terminalCommand } : {}),
          ...(res.message ? { message: res.message } : {}),
        },
      }));
      if (res.status === "done") {
        await Promise.all([this.loadProviders(true), this.loadPlanUsage({ background: true })]);
        void this.refreshModels({ providerId, accountId, force: true, watch: true });
        return;
      }
      if (res.status === "waiting" && res.loginId) {
        this.providerLoginPollAttempts = 0;
        this.scheduleProviderLoginPoll(res.loginId, rev);
      }
    } catch (error) {
      if (rev !== this.providerLoginRev) {
        return;
      }
      this.update((s) => ({
        ...s,
        providerLogin: {
          providerId,
          accountId,
          status: "error",
          url: null,
          code: null,
          message: errorMessage(error),
        },
      }));
    }
  }

  async submitProviderLoginCode(code: string): Promise<boolean> {
    const login = this.state.providerLogin;
    const clean = code.trim();
    if (!login || !login.loginId || !clean || login.submittingCode || !this.client.submitProviderLoginCode) {
      return false;
    }
    const rev = this.providerLoginRev;
    this.update((s) =>
      s.providerLogin && s.providerLogin.loginId === login.loginId
        ? { ...s, providerLogin: { ...s.providerLogin, submittingCode: true, message: undefined } }
        : s,
    );
    try {
      const res = await this.client.submitProviderLoginCode(
        login.providerId,
        login.loginId,
        clean,
        login.accountId,
      );
      if (rev !== this.providerLoginRev || !this.state.providerLogin || this.state.providerLogin.loginId !== login.loginId) {
        return false;
      }
      if (res.status === "done") {
        this.stopProviderLoginPoll();
        this.update((s) =>
          s.providerLogin
            ? { ...s, providerLogin: { ...s.providerLogin, status: "done", submittingCode: false, message: undefined } }
            : s,
        );
        await Promise.all([this.loadProviders(true), this.loadPlanUsage({ background: true })]);
        void this.refreshModels({ providerId: login.providerId, accountId: login.accountId, force: true, watch: true });
        return true;
      }
      if (res.status === "error" || res.status === "idle") {
        this.stopProviderLoginPoll();
        this.update((s) =>
          s.providerLogin
            ? {
                ...s,
                providerLogin: {
                  ...s.providerLogin,
                  status: "error",
                  submittingCode: false,
                  message: res.message ?? "Authorization code was rejected. Start sign-in again for a fresh link.",
                },
              }
            : s,
        );
        return false;
      }
      this.update((s) =>
        s.providerLogin
          ? {
              ...s,
              providerLogin: {
                ...s.providerLogin,
                submittingCode: false,
                ...(res.message ? { message: res.message } : {}),
              },
            }
          : s,
      );
      return false;
    } catch (error) {
      if (rev !== this.providerLoginRev || !this.state.providerLogin || this.state.providerLogin.loginId !== login.loginId) {
        return false;
      }
      this.update((s) =>
        s.providerLogin
          ? {
              ...s,
              providerLogin: {
                ...s.providerLogin,
                submittingCode: false,
                message: errorMessage(error),
              },
            }
          : s,
      );
      return false;
    }
  }

  cancelProviderLogin(): void {
    const current = this.state.providerLogin;
    this.providerLoginRev += 1;
    this.stopProviderLoginPoll();
    this.update((s) => ({ ...s, providerLogin: null }));
    if (current?.loginId && current.status === "waiting") {
      void this.client.cancelProviderLogin?.(current.providerId, current.loginId, current.accountId).catch(() => undefined);
    }
  }

  async checkProviderLogin(): Promise<void> {
    const login = this.state.providerLogin;
    if (!login) {
      return;
    }
    if (login.loginId && this.client.providerLoginProgress) {
      this.stopProviderLoginPoll();
      const rev = ++this.providerLoginRev;
      await this.pollProviderLogin(login.loginId, rev);
      return;
    }
    await this.loadProviders(true);
    const provider = this.state.providers?.find((p) => p.id === login.providerId);
    const authed = login.accountId
      ? provider?.accounts.some((a) => "providerId" in a && a.id === login.accountId && a.auth?.state === "authenticated")
      : provider?.defaultAuth?.state === "authenticated";
    if (authed) {
      this.update((s) => (s.providerLogin ? { ...s, providerLogin: { ...s.providerLogin, status: "done" } } : s));
      void this.loadPlanUsage({ background: true });
      void this.refreshModels({ providerId: login.providerId, accountId: login.accountId, force: true, watch: true });
    }
  }

  private scheduleProviderLoginPoll(loginId: string, rev: number): void {
    if (this.disposed || rev !== this.providerLoginRev) {
      return;
    }
    this.providerLoginPollHandle = this.platform.schedule(() => {
      this.providerLoginPollHandle = null;
      void this.pollProviderLogin(loginId, rev);
    }, LOGIN_POLL_MS);
  }

  private async pollProviderLogin(loginId: string, rev: number): Promise<void> {
    const current = this.state.providerLogin;
    if (rev !== this.providerLoginRev || !current || current.loginId !== loginId || current.status !== "waiting") {
      return;
    }
    this.providerLoginPollAttempts += 1;
    if (!this.client.providerLoginProgress) {
      return;
    }
    try {
      const res = await this.client.providerLoginProgress(current.providerId, loginId, current.accountId);
      if (rev !== this.providerLoginRev || !this.state.providerLogin || this.state.providerLogin.loginId !== loginId) {
        return;
      }
      if (res.status === "done") {
        this.update((s) =>
          s.providerLogin ? { ...s, providerLogin: { ...s.providerLogin, status: "done" } } : s,
        );
        await Promise.all([this.loadProviders(true), this.loadPlanUsage({ background: true })]);
        void this.refreshModels({ providerId: current.providerId, accountId: current.accountId, force: true, watch: true });
        return;
      }
      if (res.status === "error" || res.status === "idle") {
        this.update((s) =>
          s.providerLogin
            ? {
                ...s,
                providerLogin: {
                  ...s.providerLogin,
                  status: "error",
                  message: res.message ?? "Sign-in is no longer active.",
                },
              }
            : s,
        );
        return;
      }
      this.update((s) =>
        s.providerLogin
          ? {
              ...s,
              providerLogin: {
                ...s.providerLogin,
                url: res.url ?? s.providerLogin.url,
                code: res.code ?? s.providerLogin.code,
                needsCodeInput: res.needsCodeInput ?? s.providerLogin.needsCodeInput,
              },
            }
          : s,
      );
      if (this.providerLoginPollAttempts < LOGIN_POLL_MAX_ATTEMPTS) {
        this.scheduleProviderLoginPoll(loginId, rev);
      }
    } catch {
      if (this.providerLoginPollAttempts < LOGIN_POLL_MAX_ATTEMPTS) {
        this.scheduleProviderLoginPoll(loginId, rev);
      }
    }
  }

  private stopProviderLoginPoll(): void {
    if (this.providerLoginPollHandle !== null) {
      this.platform.cancel(this.providerLoginPollHandle);
      this.providerLoginPollHandle = null;
    }
    this.providerLoginPollAttempts = 0;
  }

  // ---------------------------------------------------------------- threads and projects

  async rename(sessionId: string, title: string): Promise<void> {
    const sanitizedTitle = title.trim();
    const currentSession = this.state.sessions[sessionId];
    if (!sanitizedTitle || !currentSession || sanitizedTitle === currentSession.title) return;
    this.upsertSession({ ...currentSession, title: sanitizedTitle, titleSource: "user" });

    try { const persisted = await this.client.updateSession(sessionId, { title: sanitizedTitle });
      
if (persisted) {
        this.upsertSession(persisted);
      }
    } catch (err) {
      this.upsertSession(currentSession);
      this.toast("error", "Could not rename the thread", errorMessage(err));
    }
  }

  async archive(sessionId: string): Promise<void> {
    const existing = this.state.sessions[sessionId];
    if (!existing) return;

    if (this.state.threads[sessionId]?.researchRuns.some(researchLive)) {
      this.toast("error", "Could not archive the thread", "A research run is in progress on this thread. Stop it, or wait for it to finish, then archive the thread."); return;
    }

    this.update((st) => {
      const nextSessions = { ...st.sessions };
      delete nextSessions[sessionId];
      return { ...st, sessions: nextSessions };
    });

    const activeRoute = this.state.route;
    if (activeRoute.kind === "thread" && activeRoute.sessionId === sessionId) {
      this.navigate({ kind: "new", cwd: existing.cwd });
    }

    this.forget(sessionId);

    try { await this.client.updateSession(sessionId, { archived: true });
      
this.toast("info", "Thread archived", existing.title, {
        label: "Undo",
        run: () => void this.unarchive(existing),
      });
    } catch (archiveErr) {
      this.upsertSession(existing);
      this.toast("error", "Could not archive the thread", errorMessage(archiveErr));
    }
  }

  async setSettled(sessionId: string, settled: boolean): Promise<void> {
    const currentRecord = this.state.sessions[sessionId];
    if (!currentRecord || currentRecord.settled === settled) return;

    if (settled && this.state.threads[sessionId]?.researchRuns.some(researchLive)) {
      this.toast("error", "Could not settle the thread", "A research run is in progress on this thread. Stop it, or wait for it to finish, then settle the thread."); return;
    }

    const isoTimestamp = new Date(this.platform.now()).toISOString();
    this.upsertSession(
      settled
        ? { ...currentRecord, settled: true, settledAt: isoTimestamp, unsettledAt: null }
        : { ...currentRecord, settled: false, settledAt: null, unsettledAt: isoTimestamp },
    );

    try { const updated = await this.client.updateSession(sessionId, { settled });
      
if (updated) {
        this.upsertSession(updated);
      }
    } catch (err) {
      this.upsertSession(currentRecord);
      this.toast("error", settled ? "Could not settle the thread" : "Could not bring the thread back", errorMessage(err));
    }
  }

  toggleShelf(key: string): void {
    const openList = this.state.prefs.openShelves;
    const isAlreadyOpen = openList.includes(key);
    this.setPrefs({
      openShelves: isAlreadyOpen ? openList.filter((k) => k !== key) : [...openList, key],
    });
  }

  private async unarchive(session: SessionSummary): Promise<void> {
    try { const restored = await this.client.updateSession(session.sessionId, { archived: false });
      
this.upsertSession(restored ?? { ...session, archived: false });
    } catch (err) {
      this.toast("error", "Could not restore the thread", errorMessage(err));
    }
  }

  listDirectory(path: string): Promise<import("../types.js").DirectoryListing> { return this.client.listDirectory(path); }

  async revealPath(path: string): Promise<void> { try { await this.client.revealPath(path);
     } catch (err) {
      this.toast("error", "Could not open the folder", errorMessage(err));
    }
  }

  async cloneProject(url: string, path: string): Promise<boolean> {
    if (this.state.busy["cloneProject"]) return false;
    this.setBusy("cloneProject", true);

    try { const cloneResult = await this.client.cloneProject(url, path);
      
await this.refresh();
      this.setAddProjectOpen(false);

      const msgDetail = cloneResult.warning ? `Muse could not list its threads yet: ${cloneResult.warning}` : cloneResult.cwd;
      this.toast("info", "Repository cloned", msgDetail);
      this.newThread(cloneResult.cwd);
      return true;
    } catch (cloneErr) {
      this.toast("error", "Could not clone the repository", errorMessage(cloneErr)); return false;
    } finally { this.setBusy("cloneProject", false); }
  }

  async addProject(cwd: string, options: { create?: boolean } = {}): Promise<boolean> {
    const cleanPath = cwd.trim();
    if (!cleanPath || this.state.busy["addProject"]) return false;
    this.setBusy("addProject", true);

    try { const addedProject = await this.client.addProject(cleanPath, options);
      
await this.refresh();
      this.setAddProjectOpen(false);

      if (addedProject.warning) {
        this.toast("info", "Project added", `Muse could not list its threads yet: ${addedProject.warning}`);
      }
      this.newThread(addedProject.cwd);
      return true;
    } catch (addErr) {
      this.toast("error", "Could not add that folder", errorMessage(addErr)); return false;
    } finally { this.setBusy("addProject", false); }
  }

  usageReport(days: number): Promise<import("../types.js").UsageReport> { return this.client.usage(days); }

  async reorderProjects(cwd: string, beforeCwd: string | null): Promise<void> {
    const existingList = this.state.projects;
    const movingProject = existingList.find((p) => p.cwd === cwd);
    if (!movingProject || cwd === beforeCwd) return;

    const remaining = existingList.filter((p) => p.cwd !== cwd);
    const targetIdx = beforeCwd === null ? remaining.length : remaining.findIndex((p) => p.cwd === beforeCwd);
    const resolvedPos = targetIdx < 0 ? remaining.length : targetIdx;

    const reordered = [
      ...remaining.slice(0, resolvedPos),
      movingProject,
      ...remaining.slice(resolvedPos),
    ];
    this.update((st) => ({ ...st, projects: reordered }));

    try { await this.client.setProjectOrder(reordered.map((p) => p.cwd));
    
} catch (err) {
      this.update((st) => ({ ...st, projects: existingList }));
      this.toast("error", "Could not reorder the projects", errorMessage(err));
    }
  }

  async hideProject(cwd: string): Promise<void> {
    const targetProject = this.state.projects.find((p) => p.cwd === cwd);
    if (!targetProject) return;

    this.update((st) => ({ ...st, projects: st.projects.filter((p) => p.cwd !== cwd) }));

    const associatedFolders = new Set(targetProject.folders.map((f) => f.cwd));
    associatedFolders.add(cwd);

    const activeRoute = this.state.route;
    const openSession = activeRoute.kind === "thread" ? this.state.sessions[activeRoute.sessionId] : null;

    const isCurrentInScope =
      (activeRoute.kind === "new" && activeRoute.cwd !== null && associatedFolders.has(activeRoute.cwd)) ||
      Boolean(openSession && associatedFolders.has(openSession.cwd));

    if (isCurrentInScope) {
      this.navigate({ kind: "home" });
    }

    for (const threadId of Object.keys(this.state.threads)) {
      const sess = this.state.sessions[threadId];
      if (sess && associatedFolders.has(sess.cwd)) {
        this.forget(threadId);
      }
    }

    try { await this.client.hideProject(cwd);
      
this.toast("info", `Removed ${targetProject.displayName} from the sidebar`, "Its Muse threads are untouched.", {
        label: "Undo",
        run: () => void this.addProject(cwd),
      });
    } catch (err) {
      void this.refresh();
      this.toast("error", "Could not remove the project", errorMessage(err));
    }
  }

  async refreshProject(cwd: string): Promise<void> {
    const foundProject = this.state.projects.find((p) => p.cwd === cwd);
    const candidateFolders = foundProject ? foundProject.folders.map((f) => f.cwd) : [cwd];

    const outcomes = await Promise.allSettled(candidateFolders.map((f) => this.client.discover(f)));

    try { await this.refresh();
    
} catch (err) {
      this.toast("error", "Could not refresh that project", errorMessage(err)); return;
    }

    const firstFailure = outcomes.find((res): res is PromiseRejectedResult => res.status === "rejected");
    if (firstFailure) {
      this.toast("error", "Could not refresh that project", errorMessage(firstFailure.reason));
    }
  }

  async addProjectFolder(cwd: string, path: string): Promise<boolean> {
    const folderPath = path.trim();
    if (!folderPath || this.state.busy["addProject"]) return false;
    this.setBusy("addProject", true);

    try { const addedData = await this.client.addProjectFolder(cwd, folderPath);
      
this.update((st) => ({
        ...st,
        projects: st.projects.map((p) => (p.cwd === cwd ? addedData.project : p)),
      }));
      this.setAddProjectOpen(false);
      await this.refresh();

      if (addedData.warning) {
        this.toast("info", "Folder added", `Muse could not list its threads yet: ${addedData.warning}`);
      }
      return true;
    } catch (err) {
      this.toast("error", "Could not add that folder", errorMessage(err)); return false;
    } finally { this.setBusy("addProject", false); }
  }

  async removeProjectFolder(cwd: string, path: string): Promise<void> {
    try { const updatedProject = await this.client.removeProjectFolder(cwd, path);
      
this.update((st) => ({
        ...st,
        projects: st.projects.map((p) => (p.cwd === cwd ? updatedProject : p)),
      }));
      await this.refresh();
    } catch (err) {
      this.toast("error", "Could not remove that folder", errorMessage(err));
    }
  }

  async togglePin(cwd: string): Promise<void> {
    const matchingProj = this.state.projects.find((p) => p.cwd === cwd);
    if (!matchingProj) return;
    try { await this.client.setPinned(cwd, !matchingProj.pinned);
      
await this.refresh();
    } catch (err) {
      this.toast("error", "Could not update the project", errorMessage(err));
    }
  }

  composerCwd(): string | null {
    const curRoute = this.state.route;
    if (curRoute.kind === "thread") {
      return this.state.sessions[curRoute.sessionId]?.cwd ?? null;
    }
    return (curRoute.kind === "new" ? curRoute.cwd : null) ??
      this.state.prefs.lastProject ??
      this.state.projects[0]?.cwd ??
      null;
  }

  private readonly skillLoads = new Map<string, Promise<void>>();

  loadSkills(cwd: string): Promise<void> {
    const existingPromise = this.skillLoads.get(cwd);
    if (existingPromise) {
      return existingPromise;
    }

    const stateEntry = this.state.skills[cwd];
    const timestampNow = this.platform.now();

    if (stateEntry && (timestampNow - stateEntry.loadedAt < (stateEntry.error ? SKILLS_RETRY_MS : SKILLS_FRESH_MS))) {
      return Promise.resolve();
    }

    const loadTask = this.fetchSkills(cwd).finally(() => {
      this.skillLoads.delete(cwd);
    });
    this.skillLoads.set(cwd, loadTask);
    return loadTask;
  }

  refreshSkillsFor(sessionIdOrCwd: string): void {
    const matchingSession = this.state.sessions[sessionIdOrCwd];
    const workspaceRoot = matchingSession ? matchingSession.cwd : sessionIdOrCwd;

    if (workspaceRoot) {
      void this.fetchSkills(workspaceRoot);
    }
  }

  private skillSession(cwd: string): string | null {
    const activeRoute = this.state.route;
    if (activeRoute.kind !== "thread") return null;
    const sessionObj = this.state.sessions[activeRoute.sessionId];
    return sessionObj?.cwd === cwd ? sessionObj.sessionId : null;
  }

  private async fetchSkills(cwd: string): Promise<void> {
    const current = this.state.skills[cwd];
    this.setSkills(cwd, {
      status: "loading",
      skills: current?.skills ?? [],
      error: null,
      loadedAt: current?.loadedAt ?? 0,
    });

    try { const catalog = await this.client.listSkills(cwd, this.skillSession(cwd) ?? undefined);
      
this.setSkills(cwd, {
        status: catalog.error ? "error" : "ready",
        skills: catalog.skills,
        error: catalog.error,
        loadedAt: this.platform.now(),
      });
    } catch (err) {
      this.setSkills(cwd, {
        status: "error",
        skills: current?.skills ?? [],
        error: errorMessage(err),
        loadedAt: this.platform.now(),
      });
    }
  }

  private setSkills(cwd: string, next: SkillsState): void {
    this.update((st) => ({ ...st, skills: { ...st.skills, [cwd]: next } }));
  }

  setPicker(picker: ComposerPicker | null): void {
    this.update((st) => (st.picker === picker ? st : { ...st, picker }));
    if (picker === "model") {
      void this.refreshModels(this.modelsScope());
    }
  }

  closePicker(picker: ComposerPicker): void { this.update((st) => (st.picker === picker ? { ...st, picker: null } : st)); }

  private async runShell(command: string): Promise<boolean> {
    const executeShellInSession = async (sessionId: string): Promise<boolean> => {
      const threadState = this.state.threads[sessionId];
      if (threadState?.readOnly) {
        this.toast("info", "This thread is read-only here", threadState.readOnlyReason ?? "Another Muse session has it open."); return false;
      }

      const operationKey = `shell:${sessionId}`;
      if (this.state.busy[operationKey]) return false;
      this.setBusy(operationKey, true);

      try { const shellResult = await this.client.runShellProxy(sessionId, command);
        
this.addShellRun(sessionId, shellResult);
        return true;
      } catch (err) {
        this.toast("error", "Command not run", errorMessage(err)); return false;
      } finally { this.setBusy(operationKey, false); }
    };

    const currentRoute = this.state.route;
    if (currentRoute.kind === "thread") {
      return executeShellInSession(currentRoute.sessionId);
    }

    const startTarget = this.newThreadTarget();
    return startTarget ? this.startThread(startTarget, `!${command}`, executeShellInSession) : false;
  }

  private stamp(file: AttachmentView): AttachmentView {
    return { ...file, url: this.client.assetUrl(file.url) };
  }

  private keepAttachments(sessionId: string, saved: AttachmentView[]): void {
    if (saved.length === 0) return;
    this.update((st) => {
      const targetThread = st.threads[sessionId];
      if (!targetThread) {
        return st;
      }
      const existingFileIds = new Set(targetThread.attachments.map((f) => f.id));
      const newlySavedFiles = saved
        .filter((file) => !existingFileIds.has(file.id))
        .map((file) => this.stamp(file));

      if (newlySavedFiles.length === 0) {
        return st;
      }
      return {
        ...st,
        threads: {
          ...st.threads,
          [sessionId]: { ...targetThread, attachments: [...targetThread.attachments, ...newlySavedFiles] },
        },
      };
    });
  }

  private addShellRun(sessionId: string, run: import("../types.js").ShellRun): void {
    this.update((st) => {
      const targetThread = st.threads[sessionId];
      if (!targetThread || targetThread.shellRuns.some((existing) => existing.id === run.id)) {
        return st;
      }
      return {
        ...st,
        threads: {
          ...st.threads,
          [sessionId]: { ...targetThread, shellRuns: [...targetThread.shellRuns, run] },
        },
      };
    });
  }
  research(question: string, config: Partial<ResearchConfig> | null = null, bound: string | null = null): Promise<boolean> {
    const route = this.state.route;    const sessionId = bound ?? (route.kind === "thread" ? route.sessionId : null);
    if (sessionId) {
      return this.startResearch(sessionId, question, config);
    }    const target = this.newThreadTarget();
    if (!target) {
      return Promise.resolve(false);
    }    // The thread has no prompt of its own, so the question names it until the user renames it.
    return this.startThread(target, `/research ${question}`, async (fresh) => {
      const started = await this.startResearch(fresh, question, config);
      if (started) {
        void this.rename(fresh, researchThreadTitle(question));
      }      return started;
    });
  }  /**
   * Posts a run for `sessionId` and shows it as queued at once, under a placeholder id, so the row is there before
   * the server answers. The `commandId` is minted here so a retried POST returns the same run instead of a second one.
   */
  async startResearch(sessionId: string, question: string, config: Partial<ResearchConfig> | null = null): Promise<boolean> {
    const trimmed = question.trim();
    if (!trimmed) {
      this.toast("info", "Type the question to research");
      return false;    }    const thread = this.state.threads[sessionId];
    if (thread?.readOnly) {
      this.toast("info", "This thread is read-only here", thread.readOnlyReason ?? "Another Muse session has it open.");
      return false;    }    if (this.state.researchSettings?.enabled === false) {
      this.toast("info", "Deep research is off", "Switch it on in Settings to start a run.");
      return false;    }    if (thread?.researchRuns.some(researchLive)) {
      this.toast("info", "A research run is already going in this thread", "Stop it, or wait for its report, before starting another.");
      return false;    }    const key = `research:${sessionId}`;
    if (this.state.busy[key]) {
      return false;    }    const commandId = mintCommandId(this.platform.now());
    const placeholder = `pending:${commandId}`;
    const defaults = this.state.researchSettings?.config ?? EMPTY_RESEARCH_CONFIG;
    const optimistic: ResearchRunView = {
      runId: placeholder,
      sessionId,
      status: "queued",
      phase: "scoping",
      question: trimmed,
      brief: null,
      round: 0,
      maxRounds: config?.maxRounds ?? defaults.maxRounds,
      createdAt: new Date(this.platform.now()).toISOString(),
      startedAt: null,
      endedAt: null,
      researchDeadlineAt: null,
      workers: [],
      sources: { registry: 0, verified: 0, curated: 0 },
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
      failure: null,
      reportAvailable: false,
      report: null,
      reportPath: null,
      config: { ...defaults, ...(config ?? {}), models: { ...defaults.models, ...(config?.models ?? {}) } },
    };
    this.setBusy(key, true);
    this.applyResearchRuns(sessionId, [optimistic]);
    try {      const run = await this.client.startResearch(sessionId, trimmed, config, commandId);
      this.applyResearchRuns(sessionId, [run], placeholder);
      // The question went out; the next thing typed is a message again.
      if (this.state.researchMode) {
        this.update((s) => ({ ...s, researchMode: false }));
      }      return true;    } catch (error) {      this.applyResearchRuns(sessionId, [], placeholder);
      this.toast("error", "Could not start the research run", errorMessage(error));
      return false;    } finally {      this.setBusy(key, false);
    }  }  /**
   * Stops a run; with `writeReport` the server still writes a report from what the workers found. The row says the
   * run is stopping from here until the stream reports how it ended: the route answers with the run as it was when
   * the stop was taken, before the workers had wound down, so that answer only lands when it is fresher than what
   * the row already shows.
   */
  async stopResearch(runId: string, writeReport: boolean): Promise<boolean> {
    const key = `research-stop:${runId}`;
    if (this.state.busy[key]) {
      return false;    }    this.setBusy(key, true);
    this.setResearchStopping(runId, writeReport ? "write" : "now");
    try {      const run = await this.client.stopResearch(runId, writeReport);
      this.applyResearchRuns(run.sessionId, [run]);
      return true;    } catch (error) {      this.setResearchStopping(runId, null);
      this.toast("error", "Could not stop the research run", errorMessage(error));
      return false;    } finally {      this.setBusy(key, false);
    }  }  private setResearchStopping(runId: string, action: ResearchStopAction | null): void {
    this.update((s) => {
      if ((s.researchStopping[runId] ?? null) === action) {
        return s;
      }      const researchStopping = { ...s.researchStopping };
      if (action) {
        researchStopping[runId] = action;
      } else {
        delete researchStopping[runId];
      }
      return { ...s, researchStopping };
    });
  }  /** Reads a run with its report, which the stream and the transcript load leave out, and keeps it on the run. */
  async openResearchReport(runId: string): Promise<boolean> {
    const key = `research-report:${runId}`;
    if (this.state.busy[key]) {
      return false;    }    this.setBusy(key, true);
    try {      const run = await this.client.getResearch(runId);
      this.applyResearchRuns(run.sessionId, [run]);
      return true;    } catch (error) {      this.toast("error", "Could not read the report", errorMessage(error));
      return false;    } finally {      this.setBusy(key, false);
    }  }  /** Opens Save As before rendering the report, so the user chooses the exported copy's destination. */
  async exportResearchReport(_sessionId: string, runId: string, format: ResearchExportFormat): Promise<void> {
    const key = `research-export:${runId}`;
    if (this.state.busy[key]) {
      return;    }    this.setBusy(key, true);
    try {      if (!this.platform.saveFile) {
        throw new Error("This window cannot save files. Open Ancilla in the desktop app or a supported browser.");
      }
      const mimeType = format === "pdf" ? "application/pdf" : format === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/html";
      const saved = await this.platform.saveFile(
        { name: `report.${format}`, extension: format, mimeType, description: `${RESEARCH_EXPORT_WORD[format]} document` },
        async () => {
          await this.client.exportResearch(runId, format);
          return this.client.readResearchExport(runId, format);
        },
      );
      if (!saved) {
        return;
      }      this.toast(
        "success",
        saved.kind === "saved" ? `Saved ${saved.name}` : `Downloading ${saved.name}`,
        saved.path ?? (saved.kind === "download" ? "Your browser controls the save location. Enable its “Ask where to save” setting to choose a folder." : undefined),
      );
    } catch (error) {      this.toast("error", `Could not export the report as ${RESEARCH_EXPORT_WORD[format]}`, errorMessage(error));
    } finally {
      this.setBusy(key, false);
    }  }  /** Opens one file of the project with whatever the OS opens that kind of file with. */
  async openProjectFile(cwd: string, path: string): Promise<void> {
    try {      await this.client.openProjectFile(cwd, path);
    } catch (error) {      this.toast("error", "Could not open the file", errorMessage(error));
    }  }  /** What Stop does on a research run from now on: the switch in the composer popover. */
  setResearchStopWrites(writes: boolean): void {
    this.update((s) => (s.researchStopWrites === writes ? s : { ...s, researchStopWrites: writes }));
  }

  /**
   * Ctrl/Cmd+Shift+R: opens the research popover of the composer on screen, or closes it. It stays shut when no
   * composer is mounted (the settings and usage pages, or no project yet) and when the composer's trigger is off
   * (a live run in the thread, the feature off, a read-only thread, a thread still starting): the picker is only
   * a flag the composer reads, and one raised while the trigger is off would pop the popover open the moment the
   * trigger came back.
   */
  toggleResearchMode(): void {
    this.setResearchMode(!this.state.researchMode);
  }

  /** Arms or disarms research mode; arming needs a composer whose Research button is on, exactly like a click. */
  setResearchMode(on: boolean): void {
    if (on && !this.researchTriggerEnabled()) {
      return;
    }
    if (this.state.researchMode !== on) {
      this.update((s) => ({ ...s, researchMode: on, picker: on ? s.picker : s.picker === "research" ? null : s.picker }));
    }
  }

  setResearchTyped(patch: Partial<ResearchTyped>): void {
    this.update((s) => ({ ...s, researchTyped: { ...s.researchTyped, ...patch } }));
  }

  /** Whether the composer on screen has a research trigger, and it would open: the composer's own conditions, read off the state. */
  researchTriggerEnabled(): boolean {
    const s = this.state;
    if (!s.sessionsLoaded || s.researchSettings?.enabled === false || s.busy["start"]) {
      return false;
    }
    const route = s.route;
    if (route.kind === "thread") {
      const thread = s.threads[route.sessionId];
      return Boolean(s.sessions[route.sessionId]) && !thread?.readOnly && !thread?.researchRuns.some(researchLive);
    }
    // The new-thread screen mounts its composer only once there is a project to start the thread in.
    return (route.kind === "home" || route.kind === "new") && s.projects.length > 0;
  }

  /** Patches the server's research defaults, showing the change at once and taking it back if the server refuses. */
  async setResearchSettings(patch: { enabled?: boolean; config?: Partial<ResearchConfig> }): Promise<void> {
    const previous = this.state.researchSettings;
    const rev = ++this.researchSettingsRev;
    if (previous) {
      const config: ResearchConfig = {
        ...previous.config,
        ...(patch.config ?? {}),
        models: { ...previous.config.models, ...(patch.config?.models ?? {}) },
      };
      this.update((s) => ({ ...s, researchSettings: { enabled: patch.enabled ?? previous.enabled, config } }));
    }
    try {
      const researchSettings = await this.client.setResearchSettings(patch);
      if (rev === this.researchSettingsRev) {
        this.update((s) => ({ ...s, researchSettings }));
      }
    } catch (error) {
      if (rev === this.researchSettingsRev) {
        this.update((s) => ({ ...s, researchSettings: previous }));
        this.toast("error", "Could not change the research settings", errorMessage(error));
      }
    }
  }

  /**
   * Reconciles snapshots of a thread's runs with what it holds, by `runId`: the one way a run reaches a thread
   * (the stream, the answer to a start, a stop or a read, a research list read after a reconnect; a transcript
   * reload does the same through `reloadThread`). Newest is not last to arrive, so `reconcileResearchRuns` says
   * which picture of a run stands and never drops a run a snapshot does not mention. `replacing` names the
   * placeholder row of a start, swapped out in the same update. A run for a thread this app has not opened is
   * dropped: the thread reads its runs with its transcript when it is opened. Once a run has ended, a stop
   * waiting on it is answered.
   */
  private applyResearchRuns(sessionId: string, incoming: readonly ResearchRunView[], replacing?: string): void {
    this.update((s) => {
      const thread = s.threads[sessionId];
      if (!thread) {
        return s;
      }
      const researchRuns = reconcileResearchRuns(thread.researchRuns, incoming, replacing);
      const researchStopping = settleStopping(s.researchStopping, researchRuns);
      if (researchRuns === thread.researchRuns && researchStopping === s.researchStopping) {
        return s;
      }
      return { ...s, threads: { ...s.threads, [sessionId]: { ...thread, researchRuns } }, researchStopping };
    });
  }  /** Hands a command's output to Muse as the next prompt, since Muse never saw it run. */

  sendShellOutput(sessionId: string, run: import("../types.js").ShellRun): Promise<boolean> {
    const rawMatches = run.output.match(/`+/g) ?? [];
    const maxBackticks = Math.max(3, ...rawMatches.map((mark) => mark.length + 1));
    const codeFence = "`".repeat(maxBackticks);
    const exitStatusText = run.exitCode === 0 ? "" : ` (exit ${run.exitCode ?? "unknown"})`;
    const formattedOutput = run.output.trim() || "(no output)";
    const payloadText = `I ran this in the workspace${exitStatusText}:

${codeFence}sh
${run.command}
${codeFence}

Its output:

${codeFence}
${formattedOutput}
${codeFence}`;

    return this.sendToThread(
      sessionId,
      payloadText,
      { displayText: `Shared the output of \`${run.command}\`` },
      false,
    );
  }

  private async runSlash(typed: string, parsed: ParsedSlash, options: TurnDelivery): Promise<boolean> {
    const currentRoute = this.state.route;
    const explicitBoundSession = options.sessionId ?? null;
    const resolvedCwd = explicitBoundSession
      ? (this.state.sessions[explicitBoundSession]?.cwd ?? null)
      : this.composerCwd();

    const builtinCommandsList = slashCommands([], { inThread: true });
    const isMatchedBuiltin = builtinCommandsList.find(
      (cmd) => cmd.name === parsed.name || cmd.aliases.includes(parsed.name),
    );

    if (resolvedCwd && (!isMatchedBuiltin || isMatchedBuiltin.action === "skill")) {
      await this.loadSkills(resolvedCwd);
    }

    const availableSkillsList = resolvedCwd ? (this.state.skills[resolvedCwd]?.skills ?? []) : [];
    const cmdResolution = resolveSlash(parsed, slashCommands(availableSkillsList, { inThread: true }), availableSkillsList);

    if (cmdResolution.kind === "unknown") {
      this.toast(
        "info",
        `No command named /${cmdResolution.name}`,
        "Pick one from the list, or send the text as a prompt from the menu.",
      ); return false;
    }

    if (cmdResolution.kind === "skill") {
      return this.runSkill(cmdResolution.skill, cmdResolution.args, typed, resolvedCwd, options);
    }

    const { command: targetCommand, args: rawArgs } = cmdResolution;
    const effectiveSessionId = explicitBoundSession ?? (currentRoute.kind === "thread" ? currentRoute.sessionId : null);

    if (targetCommand.needsThread && !effectiveSessionId) {
      this.toast("info", `Open a thread to use /${targetCommand.name}`); return false;
    }

    switch (targetCommand.action) {
      case "compact": {
        await this.compact(effectiveSessionId as string);
        return true;
      }
      case "fork": {
        return this.fork(effectiveSessionId as string);
      }
      case "new": {
        this.newThread(resolvedCwd);
        return true;
      }
      case "resume": this.setPaletteOpen(true); return true;
      case "init": {
        return this.deliver(INIT_PROMPT, { displayText: typed, ...options });
      }
      case "goal": {
        if (!rawArgs) {
          this.toast("info", "Add the goal after /goal", "For example: /goal get the test suite passing"); return false;
        }
        const actionVerbMatch = /^(pause|resume|clear)$/i.exec(rawArgs.trim());
        const actionVerb = actionVerbMatch?.[1]?.toLowerCase() as GoalAction | undefined;

        if (actionVerb) {
          if (!effectiveSessionId) {
            this.toast("info", `Open a thread to ${actionVerb} its goal`); return false;
          }
          return this.goalAction(effectiveSessionId, actionVerb);
        }

        if (effectiveSessionId) {
          return this.setGoal(effectiveSessionId, rawArgs, typed, options);
        }

        const projectTarget = this.newThreadTarget();
        if (!projectTarget) return false;
        return this.startThread(projectTarget, typed, (newSid) => this.setGoal(newSid, rawArgs, typed, options));
      }
      case "research": {
        if (!rawArgs) {
          this.toast("info", "Add the question after /research", "For example: /research how do design systems pick muted text colors in dark mode"); return false;
        }
        return this.research(rawArgs, null, effectiveSessionId);
      }
      case "model": {
        if (!rawArgs) {
          this.setPicker("model");
          return true;
        }
        return this.chooseModel(rawArgs);
      }
      case "effort": {
        if (!rawArgs) {
          this.setPicker("effort");
          return true;
        }
        const parsedLevel = parseEffort(rawArgs);
        if (parsedLevel === undefined) {
          this.toast("info", `Unknown effort level: ${rawArgs}`, "Use off, minimal, low, medium, high, xhigh, max or auto."); return false;
        }
        this.setEffort(parsedLevel);
        return true;
      }
      case "permissions": {
        if (!rawArgs) {
          this.setPicker("permissions");
          return true;
        }
        const parsedApprovalMode = parseMode(rawArgs);
        if (!parsedApprovalMode) {
          this.toast("info", `Unknown permission mode: ${rawArgs}`, "Use ask, unlisted, deny or full."); return false;
        }
        if (parsedApprovalMode === "allowAll") {
          if (this.state.yoloSettings?.enabled === true) {
            this.toast("info", "YOLO is on", "Switch YOLO off to change permissions."); return true;
          }
          this.setPicker("confirmFullAccess");
          return true;
        }
        await this.setMode(parsedApprovalMode);
        return true;
      }
      default:
        return false;
    }
  }

  private async runSkill(skill: SkillEntry, args: string, typed: string, cwd: string | null, options: TurnDelivery,): Promise<boolean> {
    let loadedBody: string | null = null;
    if (skill.activation === "user-invocable-only") {
      try { loadedBody = await this.client.skillBody(cwd ?? "", skill.id);
      
} catch (skillErr) {
        this.toast("error", `Could not load /${skill.name}`, errorMessage(skillErr)); return false;
      }
    }
    const constructedTurn = skillTurn(skill, args, typed, loadedBody);
    return this.deliver(constructedTurn.text, { ...options, displayText: constructedTurn.displayText });
  }

  async continueGoal(sessionId: string, objective: string, status?: string): Promise<boolean> {
    if (status === "paused" && (await this.goalAction(sessionId, "resume", undefined, { quiet: true }))) {
      return true;
    }
    return this.sendToThread(
      sessionId,
      `Keep working toward the goal: ${objective}`,
      { displayText: "Keep working on the goal" },
      false,
    );
  }

  private async setGoal(sessionId: string, objective: string, typed: string, options: TurnDelivery): Promise<boolean> {
    const threadState = this.state.threads[sessionId];
    if (threadState?.readOnly) {
      this.toast("info", "This thread is read-only here", threadState.readOnlyReason ?? "Another Muse session has it open."); return false;
    }

    try { await this.client.goal(sessionId, "set", objective);
      
return true;
    } catch (goalErr) {
      if (errorKind(goalErr) === "methodNotFound") {
        return this.sendToThread(sessionId, goalPrompt(objective), { ...options, displayText: typed }, false);
      }
      this.toast("error", "Could not set the goal", errorMessage(goalErr)); return false;
    }
  }

  async goalAction(sessionId: string, action: GoalAction, objective?: string, options: { quiet?: boolean } = {},): Promise<boolean> {
    const actionKey = `goal:${sessionId}`;
    if (this.state.busy[actionKey]) return false;
    this.setBusy(actionKey, true);

    try { await this.client.goal(sessionId, action, objective);
      
return true;
    } catch (actionErr) {
      if (!options.quiet) {
        const isStaleConflict = /invalid_goal_state|missing_goal/.test(errorMessage(actionErr));
        const alertTone = isStaleConflict ? "info" : "error";
        const explanation = isStaleConflict
          ? "The goal changed since this panel last updated. Try again once it catches up."
          : errorMessage(actionErr);

        this.toast(alertTone, GOAL_FAILURES[action], explanation);
      }
      return false;
    } finally { this.setBusy(actionKey, false); }
  }

  async taskAction(sessionId: string, action: TaskAction, taskId?: string): Promise<boolean> {
    const operationKey = `task:${sessionId}:${taskId ?? "all"}`;
    if (this.state.busy[operationKey]) return false;
    this.setBusy(operationKey, true);

    try { await this.client.task(sessionId, action, taskId);
      
return true;
    } catch (taskErr) {
      this.toast("error", TASK_FAILURES[action], errorMessage(taskErr)); return false;
    } finally { this.setBusy(operationKey, false); }
  }

  async subagentAction(sessionId: string, action: SubagentAction, subagentId: string, body?: string): Promise<boolean> {
    const subagentKey = `subagent:${sessionId}:${subagentId}`;
    if (this.state.busy[subagentKey]) return false;
    this.setBusy(subagentKey, true);

    try { await this.client.subagent(sessionId, action, subagentId, body ? { body } : {});
      
return true;
    } catch (subagentErr) {
      this.toast("error", "The subagent did not take that", errorMessage(subagentErr)); return false;
    } finally { this.setBusy(subagentKey, false); }
  }

  async workflowAction(sessionId: string, action: WorkflowAction, workflowRunId: string, child?: { childId: string; attempt: number },): Promise<boolean> {
    const workflowKey = `workflow:${sessionId}:${workflowRunId}:${child?.childId ?? "run"}`;
    if (this.state.busy[workflowKey]) return false;
    this.setBusy(workflowKey, true);

    try { await this.client.workflow(sessionId, action, workflowRunId, child);
      
return true;
    } catch (wfErr) {
      const isStaleAttemptError = errorKind(wfErr) === "stale_attempt";
      const title = isStaleAttemptError ? "That agent already moved on" : "The workflow did not take that";
      const detail = isStaleAttemptError ? "Try again once the card updates." : errorMessage(wfErr);
      this.toast(isStaleAttemptError ? "info" : "error", title, detail); return false;
    } finally { this.setBusy(workflowKey, false); }
  }

  readOutput(sessionId: string, itemId: string, outputRef: string, offset = 0): Promise<OutputRange> { return this.client.readOutput(sessionId, itemId, outputRef, offset); }

  askToRun(sessionId: string, command: string): Promise<boolean> {
    const runs = command.match(/`+/g) ?? [];
    const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
    const textPrompt =
      `Run this with your shell tool and show me the output:\n\n${fence}sh\n${command}\n${fence}\n\n` +
      "That failure came from Ancilla's `!` path, not from your tools: your own shell works here.";
    return this.sendToThread(sessionId, textPrompt, {}, false);
  }

  async fork(sessionId: string): Promise<boolean> {
    const forkKey = `fork:${sessionId}`;
    if (this.state.busy[forkKey]) return false;
    this.setBusy(forkKey, true);

    try { const forkedSession = await this.client.forkSession(sessionId);
      
this.upsertSession(forkedSession);
      this.navigate({ kind: "thread", sessionId: forkedSession.sessionId });
      this.toast("success", "Forked into a new thread", "The original thread stays as it was."); return true;
    } catch (forkErr) {
      this.toast(
        "error",
        "Could not fork the thread",
        errorKind(forkErr) === "forkBoundaryInvalid"
          ? "Muse could not find a point in this thread to fork it at."
          : errorMessage(forkErr),
      ); return false;
    } finally { this.setBusy(forkKey, false); }
  }

  async compact(sessionId: string): Promise<boolean> {
    try { const result = await this.client.compact(sessionId);
      
if (result.noop) {
        const reason = result.reason === "no_compactable_history"
          ? "There is no earlier history to summarize."
          : result.reason;
        this.toast(
          "info",
          "Nothing to compact yet",
          reason ? `${reason.charAt(0).toUpperCase()}${reason.slice(1).replace(/_/g, " ")}` : undefined,
        ); return false;
      }
      this.toast("info", "Compacting context", "Muse will summarize earlier turns to free up the context window."); return true;
    } catch (compactErr) {
      this.toast("error", "Could not compact the context", errorMessage(compactErr)); return false;
    }
  }

  async freshThread(sessionId: string, prompt: string | null, files: { attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] } = {},): Promise<boolean> {
    const sessionCwd = this.state.sessions[sessionId]?.cwd ?? null;
    if (!sessionCwd) {
      this.toast("error", "Could not start a new thread", "That thread's project is not known here."); return false;
    }

    const attachedFileCount = files.attachments?.length ?? 0;
    if (!prompt && attachedFileCount === 0) {
      this.newThread(sessionCwd);
      return true;
    }

    const safePromptText = prompt ?? "";
    return this.startThread(
      sessionCwd,
      safePromptText,
      (freshId) => this.retryTurn(freshId, safePromptText, files),
      files,
    );
  }

  async compactAndRetry(sessionId: string, prompt: string | null, files: { attachments?: OutgoingAttachment[]; previews?: EchoAttachment[] } = {},): Promise<void> {
    const didCompactSuccessfully = await this.compact(sessionId);
    if (!didCompactSuccessfully || !prompt) return;
    await this.retryTurn(sessionId, prompt, { ...files, queue: true });
  }

  async openFolder(cwd: string, target: "files" | "editor"): Promise<void> { try { await this.client.openFolder(cwd, target);
     } catch (folderErr) {
      const failureNotice = target === "editor" ? "Could not open VS Code" : "Could not open the folder";
      this.toast("error", failureNotice, errorMessage(folderErr));
    }
  }

  setPrefs(patch: Partial<Prefs>): void {
    const sanitizedPatch = "defaultModelId" in patch && !("defaultModelTried" in patch)
      ? { ...patch, defaultModelTried: false }
      : patch;

    this.update((st) => ({ ...st, prefs: { ...st.prefs, ...sanitizedPatch } }));

    if (this.saveHandle === null) {
      this.saveHandle = this.platform.schedule(() => {
        this.saveHandle = null;
        this.platform.savePrefs(this.state.prefs);
      }, 400);
    }
  }

  markSeen(sessionId: string, force = false): void {
    const timestampNow = new Date(this.platform.now()).toISOString();
    const recordedTimestamp = this.state.prefs.lastSeen[sessionId];

    if (!force && recordedTimestamp && Date.parse(timestampNow) - Date.parse(recordedTimestamp) < 2000) {
      return;
    }
    this.setPrefs({
      lastSeen: { ...this.state.prefs.lastSeen, [sessionId]: timestampNow },
    });
  }

  setCardOpen(key: string, open: boolean): void {
    const currentCollapsed = this.state.prefs.collapsedCards;
    if (open === !currentCollapsed.includes(key)) {
      return;
    }
    this.setPrefs({
      collapsedCards: open ? currentCollapsed.filter((k) => k !== key) : [...currentCollapsed, key],
    });
  }
  setCardExpanded(key: string, open: boolean): void {
    const current = this.state.prefs.openCards;
    if (open === current.includes(key)) {
      return;
    }    this.setPrefs({ openCards: open ? [...current, key].slice(-300) : current.filter((k) => k !== key) });
  }  /** Closes a dock card for good, or brings it back. The oldest are forgotten past a few hundred threads. */

  setCardHidden(key: string, hidden: boolean): void {
    const hiddenList = this.state.prefs.hiddenCards;
    if (hidden === hiddenList.includes(key)) {
      return;
    }
    const nextHidden = hidden ? [...hiddenList, key].slice(-300) : hiddenList.filter((k) => k !== key);
    this.setPrefs({ hiddenCards: nextHidden });
  }

  showThreadCards(sessionId: string): void {
    const threadSuffix = `:${sessionId}`;
    const allHidden = this.state.prefs.hiddenCards;
    const remainingCards = allHidden.filter((k) => !k.endsWith(threadSuffix));
    if (remainingCards.length !== allHidden.length) {
      this.setPrefs({ hiddenCards: remainingCards });
    }
  }

  setGroupBy(groupBy: GroupBy): void { this.setPrefs({ groupBy }); }

  setTheme(theme: ThemePref): void { this.setPrefs({ theme }); }

  setCodeTheme(codeTheme: CodeTheme): void { this.setPrefs({ codeTheme }); }

  setZoom(zoom: number): void {
    const clampedLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));
    this.setPrefs({ zoom: clampedLevel });
  }

  zoomIn(): void {
    const currentZoom = this.state.prefs.zoom;
    const nextStep = ZOOM_STEPS.find((step) => step > currentZoom + 1e-9) ?? ZOOM_MAX;
    this.setZoom(nextStep);
  }

  zoomOut(): void {
    const currentZoom = this.state.prefs.zoom;
    const priorStep = Array.from(ZOOM_STEPS).reverse().find((step) => step < currentZoom - 1e-9) ?? ZOOM_MIN;
    this.setZoom(priorStep);
  }

  resetZoom(): void { this.setZoom(1); }

  toggleSidebar(): void { this.setPrefs({ sidebarCollapsed: !this.state.prefs.sidebarCollapsed }); }

  setSidePanel(panel: SidePanel): void {
    const isSamePanel = this.state.prefs.sidePanel === panel;
    const isSameFilesState = this.state.prefs.filesOpen === (panel === "files");
    if (isSamePanel && isSameFilesState) return;
    this.setPrefs({ sidePanel: panel, filesOpen: panel === "files" });
  }

  toggleFiles(open?: boolean): void {
    const shouldDisplay = open ?? this.state.prefs.sidePanel !== "files";
    this.setSidePanel(shouldDisplay ? "files" : "none");
  }
  toggleCrewPanel(open?: boolean): void {
    const show = open ?? this.state.prefs.sidePanel !== "crew";
    this.setSidePanel(show ? "crew" : "none");
  }  /** Shows or hides the Browser panel; it takes the same slot, so opening it closes the file viewer or the Crew panel. */
  toggleBrowserPanel(open?: boolean): void {
    const show = open ?? this.state.prefs.sidePanel !== "browser";
    this.setSidePanel(show ? "browser" : "none");
  }  setCrewWidth(width: number): void {
    this.setPrefs({ crewWidth: Math.round(Math.min(CREW_WIDTH_MAX, Math.max(CREW_WIDTH_MIN, width))) });
  }  private patchCrewPanel(sessionId: string, fn: (panel: CrewPanelState) => CrewPanelState): void {
    this.update((s) => {      const current = s.crew.panels[sessionId] ?? emptyCrewPanel();
      const next = fn(current);      return next === current ? s : { ...s, crew: { ...s.crew, panels: { ...s.crew.panels, [sessionId]: next } } };
    });  }  /** Opens one agent in the panel's inspector, opening the panel itself when it is closed; null goes back to the roster. */
  inspectAgent(sessionId: string, agentId: string | null): void {    this.patchCrewPanel(sessionId, (panel) => ({ ...panel, mode: agentId === null ? "roster" : "inspector", inspectId: agentId }));
    if (agentId !== null) {      this.toggleCrewPanel(true);
    }  }  setCrewFilter(sessionId: string, filter: CrewFilter, query?: string): void {
    this.patchCrewPanel(sessionId, (panel) => {
      const next = { ...panel, filter, query: query ?? panel.query };      return next.filter === panel.filter && next.query === panel.query ? panel : next;    });  }

  toggleTimeline(sessionId: string): void {
    this.patchCrewPanel(sessionId, (panel) => ({
      ...panel,
      timelineOpen: !panel.timelineOpen,
    }));
  }

  togglePhase(sessionId: string, name: string): void {
    this.patchCrewPanel(sessionId, (panel) => {
      const isPhaseOpen = panel.openPhases.includes(name);
      return {
        ...panel,
        openPhases: isPhaseOpen
          ? panel.openPhases.filter((p) => p !== name)
          : [...panel.openPhases, name],
      };
    });
  }

  setActivityOpen(open: boolean): void { this.update((st) => (st.crew.activityOpen === open ? st : { ...st, crew: { ...st.crew, activityOpen: open } })); }

  setWindowTitle(title: string): void {
    if (this.platform.setWindowTitle) {
      this.platform.setWindowTitle(title);
    } else if (typeof document !== "undefined" && document.title !== title) {
      document.title = title;
    }
  }

  private setPending(key: string, action: "retry" | "stop" | null): void {
    this.update((st) => {
      if ((st.crew.pending[key] ?? null) === action) {
        return st;
      }
      const updatedPending = { ...st.crew.pending };
      if (action) {
        updatedPending[key] = action;
      } else {
        delete updatedPending[key];
      }
      return { ...st, crew: { ...st.crew, pending: updatedPending } };
    });
  }

  private settlePending(sessionId: string, fold: ThreadFold): void {
    const matchingPendingKeys = Object.keys(this.state.crew.pending).filter((k) => k.startsWith(`${sessionId}:`));
    if (matchingPendingKeys.length === 0) return;

    const recordedAttempts = new Map<string, { latest: number; ended: Set<number> }>();
    let cachedNativeStates: Map<string, AgentVM["state"]> | null = null;

    const sourceItems = Object.values(fold.agentItems ?? fold.items);
    for (const itemRecord of sourceItems) {
      if (itemRecord.kind !== "workflow" || !Array.isArray(itemRecord.children)) continue;
      for (const childObj of itemRecord.children) {
        const attemptEntry = recordedAttempts.get(childObj.childId) ?? { latest: 0, ended: new Set<number>() };
        attemptEntry.latest = Math.max(attemptEntry.latest, childObj.attempt);
        if (childObj.terminal || itemRecord.status !== "inProgress") {
          attemptEntry.ended.add(childObj.attempt);
        }
        recordedAttempts.set(childObj.childId, attemptEntry);
      }
    }

    for (const key of matchingPendingKeys) {
      const pendingAction = this.state.crew.pending[key];
      const remainder = key.slice(sessionId.length + 1);
      const splitIdx = remainder.lastIndexOf(":");
      const targetAgentId = remainder.slice(0, splitIdx);
      const attemptNum = Number(remainder.slice(splitIdx + 1));

      const workflowAttemptInfo = recordedAttempts.get(targetAgentId);
      const itemDirect = fold.items[targetAgentId];
      const parsedTurnId = turnIdOf(targetAgentId);

      if (parsedTurnId === null && !workflowAttemptInfo && !itemDirect && cachedNativeStates === null) {
        const projection = crewView(fold, this.state.sessions[sessionId] ?? null, this.platform.now());
        cachedNativeStates = new Map(projection.subagents.map((agent) => [agent.id, agent.state]));
      }

      const nativeStateValue = cachedNativeStates?.get(targetAgentId);

      let isConfirmedComplete = false;
      if (parsedTurnId !== null) {
        isConfirmedComplete = Boolean(fold.turns[parsedTurnId]?.terminal);
      } else if (workflowAttemptInfo) {
        isConfirmedComplete = pendingAction === "retry"
          ? workflowAttemptInfo.latest > attemptNum
          : (workflowAttemptInfo.ended.has(attemptNum) || workflowAttemptInfo.latest > attemptNum);
      } else if (itemDirect !== undefined) {
        isConfirmedComplete = itemDirect.status !== "inProgress";
      } else if (nativeStateValue !== undefined) {
        isConfirmedComplete = ["done", "failed", "skipped", "unknown"].includes(nativeStateValue);
      }

      if (isConfirmedComplete) {
        this.setPending(key, null);
      }
    }
  }
  async crewAction(sessionId: string, agent: AgentVM, action: "retry" | "skip" | "stop"): Promise<boolean> {
    const key = pendingKey(sessionId, agent.id, agent.attempt);    if (agent.kind === "lead") return action === "stop" ? this.stopRun(sessionId, agent.id) : false;
    if (agent.kind === "research") {
      // The daemon's supervisor runs research workers; only the run as a whole can be stopped.
      return false;    }    if (agent.kind === "workflow") {      if (!agent.workflowRunId) {        this.toast("error", "The workflow did not take that", "This run's id is not known here.");        return false;      }      if (agent.state === "planned") {        return false;      }      const flag = action === "retry" ? "retry" : "stop";      this.setPending(key, flag);      if (action !== "retry") {        this.update((s) => (s.crew.skipped.includes(key) ? s : { ...s, crew: { ...s.crew, skipped: [...s.crew.skipped, key].slice(-300) } }));
      }      const ok = await this.workflowAction(sessionId, action === "retry" ? "retry" : "skip", agent.workflowRunId, { childId: agent.id, attempt: agent.attempt });      if (!ok) {        this.setPending(key, null);      }      return ok;    }    if (agent.kind === "task") {      if (action !== "stop" || !canStopAgent(agent)) {
        return false;      }      this.setPending(key, "stop");      const ok = await this.taskAction(sessionId, "stop", agent.id);      if (!ok) {        this.setPending(key, null);      }      return ok;    }    if (action !== "stop") {      return false;    }    this.setPending(key, "stop");    const ok = await this.subagentAction(sessionId, "stop", agent.id);    if (!ok) {      this.setPending(key, null);    }    return ok;  }  /**    * Stops one run by its item; the confirm copy comes from the run's own view-model. A research run's item id
   * carries its prefix, and stops the way the composer's switch says: with a report from what it has, or without.
 */
  async stopRun(sessionId: string, itemId: string): Promise<boolean> {
    const turnId = turnIdOf(itemId);
    if (turnId !== null) {
      if (this.state.threads[sessionId]?.fold.activeTurnId !== turnId) return false;
      const pKey = pendingKey(sessionId, itemId, 1);
      this.setPending(pKey, "stop");
      try { await this.client.interruptTurn(sessionId, turnId);
        
return true;
      } catch (err) {
        this.setPending(pKey, null);
        this.toast("error", "Could not stop the turn", errorMessage(err)); return false;
      }
    }

    const rId = researchRunIdOf(itemId);
    if (rId !== null) {
      return this.stopResearch(rId, this.state.researchStopWrites);
    }

    const targetItem = this.state.threads[sessionId]?.fold.items[itemId];
    const wRunId = typeof targetItem?.workflowRunId === "string" ? targetItem.workflowRunId : null;
    if (!wRunId) {
      this.toast("error", "The workflow did not take that", "This run's id is not known here."); return false;
    }
    return this.workflowAction(sessionId, "cancel", wRunId);
  }

  async stopEverything(sessionId: string): Promise<{ runs: string[]; tasks: string[]; agents?: string[] }> {
    const thread = this.state.threads[sessionId];
    const session = this.state.sessions[sessionId] ?? null;
    if (!thread) {
      return { runs: [], tasks: [] };
    }
    const currentCrew = crewView(thread.fold, session, this.platform.now(), {
      pending: this.state.crew.pending,
      skipped: this.state.crew.skipped,
      models: this.state.models,
      researchRuns: thread.researchRuns,
    });
    const liveRuns = currentCrew.runs.filter((r) => runLive(r) && r.runId !== null);
    const liveTasks = currentCrew.tasks.filter((t) => t.state === "working" || t.state === "no-update" || t.state === "waiting-on-you");
    const liveAgents = currentCrew.subagents.filter((a) =>
      ["scheduled", "working", "finishing", "no-update", "waiting-on-you"].includes(a.state),
    );

    const haltTasks = async (): Promise<boolean> => {
      if (liveTasks.length === 0) return false;
      for (const t of liveTasks) {
        this.setPending(pendingKey(sessionId, t.id, t.attempt), "stop");
      }
      const ok = await this.taskAction(sessionId, "stopAll");
      if (!ok) {
        for (const t of liveTasks) {
          this.setPending(pendingKey(sessionId, t.id, t.attempt), null);
        }
      }
      return ok;
    };

    const [runResults, agentResults, tasksResult] = await Promise.all([
      Promise.all(liveRuns.map((r) => this.stopRun(sessionId, r.itemId))),
      Promise.all(liveAgents.map((a) => this.crewAction(sessionId, a, "stop"))),
      haltTasks(),
    ]);

    const stoppedAgents = liveAgents.filter((_, idx) => agentResults[idx]).map((a) => a.name);
    return { runs: liveRuns.filter((_, idx) => runResults[idx]).map((r) => r.name),
      tasks: tasksResult ? liveTasks.map((t) => t.name) : [],
      ...(stoppedAgents.length > 0 ? { agents: stoppedAgents } : {}),
    };
  }

  dismissReport(sessionId: string, itemId: string): void {
    const targetKey = `${sessionId}:${itemId}`;
    this.update((st) => {
      const existing = st.crew.dismissedReports;
      if (existing.includes(targetKey)) return st;
      return { ...st, crew: { ...st.crew, dismissedReports: [...existing, targetKey].slice(-300) } };
    });
  }

  dismissRecap(sessionId: string): void {
    this.update((st) => {
      const recaps = st.crew.dismissedRecaps;
      if (recaps.includes(sessionId)) return st;
      return { ...st, crew: { ...st.crew, dismissedRecaps: [...recaps, sessionId].slice(-300) } };
    });
    this.markLeft(sessionId, null);
  }

  markLeft(sessionId: string, at: number | null = this.platform.now()): void {
    this.update((st) => {
      if ((st.crew.leftAt[sessionId] ?? null) === at) {
        return st;
      }
      const leftMap = { ...st.crew.leftAt };
      if (at === null) {
        delete leftMap[sessionId];
      } else {
        leftMap[sessionId] = at;
      }
      const updatedRecaps = at === null
        ? st.crew.dismissedRecaps
        : st.crew.dismissedRecaps.filter((id) => id !== sessionId);
      return { ...st, crew: { ...st.crew, leftAt: leftMap, dismissedRecaps: updatedRecaps } };
    });
  }

  setFilesWidth(width: number): void {
    const clamped = Math.round(Math.min(FILES_WIDTH_MAX, Math.max(FILES_WIDTH_MIN, width)));
    this.setPrefs({ filesWidth: clamped });
  }

  private patchPanel(sessionId: string, fn: (panel: FilePanel) => FilePanel): void {
    this.update((st) => {
      const activePanel = st.filePanels[sessionId] ?? { tabs: [], active: null, tree: true, line: null };
      return { ...st, filePanels: { ...st.filePanels, [sessionId]: fn(activePanel) } };
    });
  }

  openFile(sessionId: string, raw: string, line: LineRange | null = null): boolean {
    const cwd = this.state.sessions[sessionId]?.cwd;
    if (!cwd) return false;
    const dest = fileTarget(raw, cwd);
    if (!dest || !dest.path) return false;

    this.patchPanel(sessionId, (curr) => ({
      tabs: curr.tabs.includes(dest.path) ? curr.tabs : [...curr.tabs, dest.path],
      active: dest.path,
      tree: false,
      line: line ?? dest.line,
    }));
    this.setSidePanel("files");
    return true;
  }

  showFileTree(sessionId: string, tree: boolean): void { this.patchPanel(sessionId, (p) => ({ ...p, tree: tree || p.active === null })); }

  activateFile(sessionId: string, path: string): void { this.patchPanel(sessionId, (p) => (p.tabs.includes(path) ? { ...p, active: path, tree: false, line: null } : p)); }

  closeFile(sessionId: string, path: string): void {
    const cwd = this.state.sessions[sessionId]?.cwd;
    if (cwd) {
      this.setFileDraft(cwd, path, null);
    }
    this.patchPanel(sessionId, (panel) => {
      const idx = panel.tabs.indexOf(path);
      const remainingTabs = panel.tabs.filter((t) => t !== path);
      const nextActive = panel.active !== path ? panel.active : (remainingTabs[Math.max(0, idx - 1)] ?? null);
      return { tabs: remainingTabs,
        active: nextActive,
        tree: nextActive === null ? true : panel.tree,
        line: panel.active === path ? null : panel.line,
      };
    });
  }

  setFileDraft(cwd: string, path: string, content: string | null, baseMtimeMs: number | null = null): void {
    const key = fileKey(cwd, path);
    this.update((st) => {
      const drafts = { ...st.fileDrafts };
      if (content === null) {
        delete drafts[key];
      } else {
        drafts[key] = { content, baseMtimeMs: drafts[key]?.baseMtimeMs ?? baseMtimeMs };
      }
      return { ...st, fileDrafts: drafts };
    });
  }

  async saveFile(cwd: string, path: string, overwrite = false): Promise<number | null> {
    const key = fileKey(cwd, path);
    const draft = this.state.fileDrafts[key];
    if (!draft || this.state.busy[`save:${key}`]) return null;
    this.setBusy(`save:${key}`, true);
    try { const written = await this.client.writeFile(cwd, path, draft.content, overwrite ? null : draft.baseMtimeMs);
      
this.update((st) => {
        const drafts = { ...st.fileDrafts };
        if (drafts[key]?.content === draft.content) {
          delete drafts[key];
        } else if (drafts[key]) {
          drafts[key] = { ...drafts[key], baseMtimeMs: written.mtimeMs };
        }
        return {
          ...st,
          fileDrafts: drafts,
          fileVersions: { ...st.fileVersions, [key]: (st.fileVersions[key] ?? 0) + 1 },
        };
      });
      return written.mtimeMs;
    } catch (err) {
      if (errorKind(err) === "fileChanged") {
        this.toast(
          "error",
          "This file changed on disk",
          "Something else saved it since you opened it. Reload to see that change, or overwrite it with yours.",
          {
            label: "Overwrite",
            run: () => void this.saveFile(cwd, path, true),
          },
        );
      } else {
        this.toast("error", "Could not save the file", errorMessage(err));
      }
      return null;
    } finally { this.setBusy(`save:${key}`, false); }
  }

  toggleTreeFolder(cwd: string, path: string): void {
    this.update((st) => {
      const openDirs = st.fileTreeOpen[cwd] ?? [];
      const updatedDirs = openDirs.includes(path)
        ? openDirs.filter((item) => item !== path)
        : [...openDirs, path];
      return { ...st, fileTreeOpen: { ...st.fileTreeOpen, [cwd]: updatedDirs } };
    });
  }

  listFiles(cwd: string, path: string) {
    return this.client.listFiles(cwd, path);
  }

  readFile(cwd: string, path: string) {
    return this.client.readFile(cwd, path);
  }

  searchFiles(cwd: string, query: string) {
    return this.client.searchFiles(cwd, query);
  }

  fileUrl(cwd: string, path: string): string { return this.client.fileUrl(cwd, path); }

  async openFileExternally(cwd: string, path: string): Promise<void> { try { await this.client.openFileExternally(cwd, path);
     } catch (err) {
      this.toast("error", "Could not open the file", errorMessage(err));
    }
  }

  setSidebarWidth(width: number): void {
    const clamped = Math.round(Math.min(480, Math.max(220, width)));
    this.setPrefs({ sidebarWidth: clamped });
  }

  toggleProjectCollapsed(cwd: string): void {
    const curr = this.state.prefs.collapsedProjects;
    const toggled = curr.includes(cwd) ? curr.filter((c) => c !== cwd) : [...curr, cwd];
    this.setPrefs({ collapsedProjects: toggled });
  }

  setPaletteOpen(open: boolean): void { this.update((st) => (st.paletteOpen === open ? st : { ...st, paletteOpen: open })); }

  setAddProjectOpen(open: boolean | { folderFor: string }): void { this.update((st) => (st.addProjectOpen === open ? st : { ...st, addProjectOpen: open })); }

  setWhatsNewOpen(open: boolean): void { this.update((st) => (st.whatsNewOpen === open ? st : { ...st, whatsNewOpen: open })); }

  toast(tone: Toast["tone"], title: string, detail?: string, action?: Toast["action"]): void {
    this.toastSeq += 1;
    const toastId = this.toastSeq;
    this.update((st) => ({
      ...st,
      toasts: [...st.toasts.slice(-3), { id: toastId, tone, title, detail, action }],
    }));
    this.platform.schedule(() => this.dismissToast(toastId), TOAST_MS[tone]);
  }

  dismissToast(id: number): void { this.update((st) => (st.toasts.some((t) => t.id === id) ? { ...st, toasts: st.toasts.filter((t) => t.id !== id) } : st)); }

  private setBusy(key: string, on: boolean): void {
    this.update((st) => {
      if (Boolean(st.busy[key]) === on) {
        return st;
      }
      const busyState = { ...st.busy };
      if (on) {
        busyState[key] = true;
      } else {
        delete busyState[key];
      }
      return { ...st, busy: busyState };
    });
  }

  private setThread(sessionId: string, thread: ThreadState): void {
    this.update((st) => ({ ...st, threads: { ...st.threads, [sessionId]: thread } }));
  }

  private patchFold(sessionId: string, fn: (fold: ThreadFold) => ThreadFold): void {
    this.update((st) => {
      const currThread = st.threads[sessionId];
      if (!currThread) return st;
      const nextFold = fn(currThread.fold);
      return nextFold === currThread.fold ? st : { ...st, threads: { ...st.threads, [sessionId]: { ...currThread, fold: nextFold } } };
    });
  }

  private patchMeta(sessionId: string, patch: Partial<ThreadFold["meta"]>): void {
    this.patchFold(sessionId, (f) => ({ ...f, meta: { ...f.meta, ...patch } }));
  }

  private upsertSession(session: SessionSummary): void {
    this.update((st) => ({ ...st, sessions: { ...st.sessions, [session.sessionId]: session } }));
  }
}
