/**
 * Subscription plan quotas, rate limit meters, and multi-account usage polling.
 * Computes window exhaustion thresholds and formats countdown resets.
 */

import type { PlanAccountUsage, PlanUsage, PlanUsageReport, PlanWindow } from "../types.js";
import { humanize, formatDuration } from "./format.js";
import type { ThreadFold } from "./fold.js";
import type { AppState } from "./store.js";
import { projectForCwd } from "./status.js";

export type PlanTone = "ok" | "warn" | "danger";

export interface PlanRow {
  readonly key: "window" | "weekly";
  readonly label: string;
  readonly percent: number;
  readonly barPercent: number;
  readonly remainingPercent: number;
  readonly tone: PlanTone;
  readonly resetsAtMs: number;
  readonly expired: boolean;
  readonly current: boolean;
  readonly standing: "current" | "last" | "ended";
  readonly resets: string;
}

export interface PlanView {
  readonly tier: string | null;
  readonly rows: PlanRow[];
  readonly observedAtMs: number;
  readonly stale: boolean;
  readonly age: string;
  readonly refreshable: boolean;
}

const STALENESS_LIMIT_MS = 1_800_000; // 30 minutes
const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;
const TWO_DAYS_MS = 172_800_000; // 48 hours

export const PLAN_SYNC_MS = 300_000; // 5 minutes

export function planAge(observedAtMs: number, now: number): string {
  const elapsed = Math.max(0, now - observedAtMs);
  if (elapsed < ONE_MINUTE_MS) {
    return "just now";
  }

  const elapsedMinutes = Math.floor(elapsed / ONE_MINUTE_MS);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) {
    return `${elapsedHours}h`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d`;
}

function resolveUsageTone(percentage: number): PlanTone {
  if (percentage >= 90) {
    return "danger";
  }
  return percentage >= 70 ? "warn" : "ok";
}

function computeWindowLabel(win: PlanWindow): string {
  const duration = win.windowDurationMins;
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    return "Current window";
  }
  return duration % 60 === 0
    ? `${duration / 60}-hour window`
    : `${duration}-minute window`;
}

export function formatReset(ms: number): string {
  if (ms < ONE_HOUR_MS) {
    if (ms < ONE_MINUTE_MS) {
      return "<1m";
    }
    const mins = Math.ceil(ms / ONE_MINUTE_MS);
    return mins >= 60 ? "1h" : `${mins}m`;
  }

  if (ms < TWO_DAYS_MS) {
    return formatDuration(ms);
  }

  const totalHrs = Math.floor(ms / ONE_HOUR_MS);
  const daysCount = Math.floor(totalHrs / 24);
  const remainingHrs = totalHrs % 24;

  return remainingHrs === 0
    ? `${daysCount}d`
    : `${daysCount}d ${remainingHrs}h`;
}

function formatAgo(elapsedMs: number): string {
  return elapsedMs < ONE_MINUTE_MS
    ? "just now"
    : `${formatReset(elapsedMs)} ago`;
}

function buildPlanRow(
  rowKey: PlanRow["key"],
  displayLabel: string,
  win: PlanWindow,
  currentTime: number,
  isFresh: boolean,
): PlanRow {
  const rawPct = Math.round(win.usedPercent);
  const msUntilReset = win.resetsAtMs - currentTime;
  const isPastReset = msUntilReset <= 0;
  const isCurrentActive = isFresh && !isPastReset;

  let standingState: "current" | "last" | "ended";
  if (isCurrentActive) {
    standingState = "current";
  } else if (isPastReset) {
    standingState = "ended";
  } else {
    standingState = "last";
  }

  const countdownText = isPastReset
    ? `${rowKey === "window" ? "Ended" : "Reset"} ${formatAgo(-msUntilReset)}`
    : `Resets in ${formatReset(msUntilReset)}`;

  return {
    key: rowKey,
    label: displayLabel,
    percent: rawPct,
    barPercent: Math.min(100, rawPct),
    remainingPercent: Math.max(0, 100 - rawPct),
    tone: resolveUsageTone(rawPct),
    resetsAtMs: win.resetsAtMs,
    expired: isPastReset,
    current: isCurrentActive,
    standing: standingState,
    resets: countdownText,
  };
}

function isAccountRefreshable(account?: PlanAccountUsage): boolean {
  return !account || account.checkedAtMs !== null || account.status === "unavailable";
}

export function planView(
  usage: PlanUsage | null,
  now: number,
  account?: PlanAccountUsage,
): PlanView | null {
  const MAX_EPOCH = 8_640_000_000_000_000;
  if (!usage || !Number.isFinite(usage.observedAtMs) || Math.abs(usage.observedAtMs) > MAX_EPOCH) {
    return null;
  }

  const windows = [usage.window, usage.weekly];
  const areWindowsValid = windows.every(
    (w) => w && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 &&
      Number.isFinite(w.resetsAtMs) && Math.abs(w.resetsAtMs) <= MAX_EPOCH,
  );
  if (!areWindowsValid) {
    return null;
  }

  const isOldObservation = (now - usage.observedAtMs) > STALENESS_LIMIT_MS;
  const isAccountActive = !account || (
    (account.status === "ready" || account.status === "runtime-only") &&
    account.source !== "saved"
  );
  const canPerformRefresh = isAccountRefreshable(account);

  const isFreshReading = !isOldObservation && isAccountActive;
  const parsedTier = /^[a-z][a-z0-9_ -]{0,31}$/i.test(usage.tier)
    ? humanize(usage.tier)
    : null;

  const windowRow = buildPlanRow("window", computeWindowLabel(usage.window), usage.window, now, isFreshReading);
  const weeklyRow = buildPlanRow("weekly", "Weekly limit", usage.weekly, now, isFreshReading);

  const isStaleFlag = isOldObservation || usage.window.resetsAtMs <= now || usage.weekly.resetsAtMs <= now;

  return {
    tier: parsedTier,
    rows: [windowRow, weeklyRow],
    observedAtMs: usage.observedAtMs,
    stale: isStaleFlag,
    age: planAge(usage.observedAtMs, now),
    refreshable: canPerformRefresh,
  };
}

export function bindingRow(view: PlanView): PlanRow | null {
  let highestCandidate: PlanRow | null = null;
  for (const r of view.rows) {
    if (r.current && (!highestCandidate || r.percent > highestCandidate.percent)) {
      highestCandidate = r;
    }
  }
  return highestCandidate;
}

export function lastKnownRow(view: PlanView): PlanRow | null {
  const pickTopPercent = (items: PlanRow[]): PlanRow | null =>
    items.reduce<PlanRow | null>((top, current) => (!top || current.percent > top.percent ? current : top), null);

  const lastItems = view.rows.filter((r) => r.standing === "last");
  const topLast = pickTopPercent(lastItems);
  if (topLast) {
    return topLast;
  }

  const endedItems = view.rows.filter((r) => r.standing === "ended");
  return pickTopPercent(endedItems);
}

export function planSyncDue(
  visibility: string,
  lastLoadedAt: number,
  now: number,
  retrying = false,
): boolean {
  const targetThreshold = retrying ? ONE_MINUTE_MS : PLAN_SYNC_MS;
  return visibility === "visible" && (now - lastLoadedAt >= targetThreshold || now < lastLoadedAt);
}

export function planReadFailed(state: Pick<AppState, "planUsageStatus" | "planUsageAccounts">): boolean {
  return state.planUsageStatus === "unavailable" ||
    state.planUsageAccounts.some((acc) => acc.status === "unavailable");
}

export interface PlanUpkeepController {
  readonly store: { get(): AppState };
  loadPlanUsage(options?: { background?: boolean }): Promise<void>;
}

export interface PlanUpkeepPage {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface PlanUpkeepClock {
  now(): number;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultSystemClock: PlanUpkeepClock = {
  now: () => Date.now(),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function startPlanSync(
  controller: PlanUpkeepController,
  page: PlanUpkeepPage,
  clock: PlanUpkeepClock = defaultSystemClock,
): () => void {
  let recordedSyncTime = clock.now();

  const handleSyncAttempt = () => {
    const currentTick = clock.now();
    const currentState = controller.store.get();
    const canSync = currentState.boot === "ready" &&
      Boolean(currentState.env?.museFound) &&
      planSyncDue(page.visibilityState, recordedSyncTime, currentTick, planReadFailed(currentState));

    if (!canSync) {
      return;
    }

    recordedSyncTime = currentTick;
    void controller.loadPlanUsage({ background: true });
  };

  const timerRef = clock.setInterval(handleSyncAttempt, ONE_MINUTE_MS);
  page.addEventListener("visibilitychange", handleSyncAttempt);

  return () => {
    clock.clearInterval(timerRef);
    page.removeEventListener("visibilitychange", handleSyncAttempt);
  };
}

export function startPlanPolling(
  controller: PlanUpkeepController,
  page: PlanUpkeepPage,
  clock: PlanUpkeepClock = defaultSystemClock,
): () => void {
  void controller.loadPlanUsage();

  const handlePeriodicPoll = () => {
    if (page.visibilityState === "visible") {
      void controller.loadPlanUsage({ background: true });
    }
  };

  const intervalTimer = clock.setInterval(handlePeriodicPoll, ONE_MINUTE_MS);
  page.addEventListener("visibilitychange", handlePeriodicPoll);

  return () => {
    clock.clearInterval(intervalTimer);
    page.removeEventListener("visibilitychange", handlePeriodicPoll);
  };
}

export function contextualPlanAccountId(state: AppState): string | null {
  if (state.route.kind === "thread") {
    return state.sessions[state.route.sessionId]?.accountId ?? null;
  }
  if (state.route.kind === "usage" || state.route.kind === "settings") {
    return state.planUsageSelectedAccountId;
  }
  const activeDirectory = state.route.kind === "new" ? state.route.cwd : state.prefs.lastProject;
  const matchedProject = projectForCwd(state.projects, activeDirectory) ?? state.projects[0];
  return matchedProject?.defaultAccountId ?? null;
}

export function legacyPlanAccounts(
  report: PlanUsageReport,
  previous: readonly PlanAccountUsage[],
): PlanAccountUsage[] {
  let primaryId: string | null = null;
  if (report.accountId !== undefined) {
    primaryId = report.accountId;
  } else if (report.usage) {
    const match = Object.entries(report.byAccount).find(
      ([, usageItem]) => usageItem.observedAtMs === report.usage?.observedAtMs,
    );
    primaryId = match ? match[0] : null;
  }

  const defaultUsageData = primaryId === null
    ? report.usage
    : previous.find((p) => p.accountId === null)?.usage ?? null;

  const dataset = [
    { accountId: null, usage: defaultUsageData },
    ...Object.entries(report.byAccount).map(([accountId, usage]) => ({ accountId, usage })),
  ];

  return dataset.map(({ accountId, usage }) => {
    const isSaved = accountId === primaryId
      ? report.saved === true
      : accountId !== null && Boolean(report.savedAccountIds?.includes(accountId));

    return {
      accountId,
      usage,
      planName: null,
      checkedAtMs: null,
      source: usage ? (isSaved ? "saved" : "runtime") : null,
      status: report.status === "unavailable"
        ? "unavailable"
        : usage
          ? "runtime-only"
          : "not-reported",
    };
  });
}

export function planAccount(state: AppState, accountId: string | null): PlanAccountUsage {
  const existing = state.planUsageAccounts.find((entry) => entry.accountId === accountId);
  if (existing) {
    return existing;
  }

  let accountUsage: PlanUsage | null = null;
  if (accountId === null) {
    accountUsage = state.planUsageAccountId === null ? state.planUsage : null;
  } else {
    accountUsage = state.planUsageByAccount[accountId] ?? null;
  }

  const isSavedState = accountId === null
    ? state.planUsageSaved
    : state.planUsageSavedAccounts.includes(accountId);

  let requiresAuthentication = false;
  if (accountId === null) {
    requiresAuthentication = state.defaultLogin?.hasLogin === false && !state.metaApiKeyInherited;
  } else {
    requiresAuthentication = state.accounts?.find((acc) => acc.id === accountId)?.hasLogin === false;
  }

  let finalStatus: PlanAccountUsage["status"] = "not-reported";
  if (state.planUsageStatus === "unavailable") {
    finalStatus = "unavailable";
  } else if (accountUsage) {
    finalStatus = "runtime-only";
  } else if (requiresAuthentication) {
    finalStatus = "login-required";
  }

  return {
    accountId,
    usage: accountUsage,
    planName: null,
    checkedAtMs: null,
    source: accountUsage ? (isSavedState ? "saved" : "runtime") : null,
    status: finalStatus,
  };
}

export function planAccountChoices(state: AppState): { id: string | null; name: string }[] {
  const accountLabels = new Map<string, string>();
  for (const acc of state.accounts ?? []) {
    accountLabels.set(acc.id, acc.name);
  }

  for (const usageItem of state.planUsageAccounts) {
    if (usageItem.accountId !== null && !accountLabels.has(usageItem.accountId)) {
      accountLabels.set(usageItem.accountId, usageItem.accountId);
    }
  }

  const formattedChoices: { id: string | null; name: string }[] = [{ id: null, name: "Default login" }];
  for (const [accId, label] of accountLabels.entries()) {
    formattedChoices.push({ id: accId, name: label });
  }

  return formattedChoices;
}

export function samePlanUsage(a: PlanUsage | null, b: PlanUsage): boolean {
  if (!a || a.observedAtMs !== b.observedAtMs || a.tier !== b.tier) {
    return false;
  }
  const scopeKeys: readonly ("window" | "weekly")[] = ["window", "weekly"];
  return scopeKeys.every(
    (k) => a[k].usedPercent === b[k].usedPercent &&
      a[k].resetsAtMs === b[k].resetsAtMs &&
      a[k].windowDurationMins === b[k].windowDurationMins,
  );
}

export function mergePlanAccounts(
  current: readonly PlanAccountUsage[],
  before: readonly PlanAccountUsage[],
  reported: readonly PlanAccountUsage[],
): PlanAccountUsage[] {
  const computeTimestamp = (acc: PlanAccountUsage) =>
    Math.max(acc.checkedAtMs ?? -Infinity, acc.usage?.observedAtMs ?? -Infinity);

  const mergedList = reported.map((incoming) => {
    const existing = current.find((entry) => entry.accountId === incoming.accountId);
    const matchesMeta = existing && incoming.source === "meta" && incoming.usage &&
      samePlanUsage(existing.usage, incoming.usage);
    const hasPrecedence = existing && (
      computeTimestamp(existing) > computeTimestamp(incoming) ||
      (computeTimestamp(existing) === computeTimestamp(incoming) && !matchesMeta)
    );
    const wasChanged = existing && existing !== before.find((entry) => entry.accountId === incoming.accountId);

    return wasChanged && hasPrecedence ? existing : incoming;
  });

  for (const currItem of current) {
    const isPresent = mergedList.some((entry) => entry.accountId === currItem.accountId);
    const wasLocallyModified = currItem !== before.find((entry) => entry.accountId === currItem.accountId);
    if (!isPresent && wasLocallyModified) {
      mergedList.push(currItem);
    }
  }

  return mergedList;
}

export function backgroundTasks(fold: ThreadFold): string[] {
  const activeIds: string[] = [];
  for (const trackingId of fold.order) {
    const itemData = fold.items[trackingId];
    if (itemData?.kind === "toolCall" && itemData.background === true && itemData.status === "inProgress") {
      activeIds.push(trackingId);
    }
  }
  return activeIds;
}
