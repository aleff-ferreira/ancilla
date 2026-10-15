import type { PlanAccountUsage, PlanUsage, PlanUsageReport, PlanWindow } from "../types.js";
import { formatDuration, humanize } from "./format.js";
import type { ThreadFold } from "./fold.js";
import type { AppState } from "./store.js";
import { projectForCwd } from "./status.js";

export type PlanTone = "ok" | "warn" | "danger";

export interface PlanRow {
  key: "window" | "weekly";
  label: string;
  /** The reported percentage may exceed 100; only the visual bar is capped. */
  percent: number;
  barPercent: number;
  remainingPercent: number;
  tone: PlanTone;
  resetsAtMs: number;
  expired: boolean;
  /** Only a recent observation of the current window can use an active meter. */
  current: boolean;
  /** A passed reset does not establish the new allowance until Muse reports it. */
  resets: string;
}

export interface PlanView {
  /** The plan's name when Muse gives a readable one; Muse 1.3.0 sends an opaque numeric id, which is left out. */
  tier: string | null;
  rows: PlanRow[];
  /** When Meta or the Muse runtime observed these numbers, never a UI refresh timestamp. */
  observedAtMs: number;
  /** True once the reading is old enough that the real meter has likely moved on. */
  stale: boolean;
  /** How long ago Muse reported this, ready to read: "just now", "4m", "2h". */
  age: string;
  /** Whether Refresh can bring a newer reading, which is what the wording about an old one has to promise. */
  refreshable: boolean;
}

/** Past this the reading is called out as old, though its age is shown from the first minute either way. */
const STALE_MS = 30 * 60 * 1000;

const MINUTE_MS = 60 * 1000;

/** How often the sidebar meter is re-read while the window is in sight, so it never drifts to unknown on its own. */
export const PLAN_SYNC_MS = 5 * MINUTE_MS;

/** The reading's age, short enough to sit beside the number itself. */
export function planAge(observedAtMs: number, now: number): string {
  const ms = Math.max(0, now - observedAtMs);
  if (ms < MINUTE_MS) {
    return "just now";
  }
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function tone(percent: number): PlanTone {
  return percent >= 90 ? "danger" : percent >= 70 ? "warn" : "ok";
}

function windowLabel(window: PlanWindow): string {
  const minutes = window.windowDurationMins;
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) {
    return "Current window";
  }
  return minutes % 60 === 0 ? `${minutes / 60}-hour window` : `${minutes}-minute window`;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Hours and minutes for today's window, days and hours for the weekly one: "77h" says less than "3d 5h". Under an hour
 * it counts whole minutes, rounded up, and never seconds: the clock ticks once a minute, so seconds would sit on
 * screen for up to a minute after they stopped being true.
 */
export function formatReset(ms: number): string {
  if (ms < HOUR_MS) {
    if (ms < MINUTE_MS) {
      return "<1m";
    }
    const minutes = Math.ceil(ms / MINUTE_MS);
    return minutes >= 60 ? "1h" : `${minutes}m`;
  }
  if (ms < 48 * HOUR_MS) {
    return formatDuration(ms);
  }
  const hours = Math.floor(ms / HOUR_MS);
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

function row(key: PlanRow["key"], label: string, window: PlanWindow, now: number, recent: boolean, refreshable: boolean): PlanRow {
  const percent = Math.round(window.usedPercent);
  const left = window.resetsAtMs - now;
  return {
    key, label, percent,
    barPercent: Math.min(100, percent),
    remainingPercent: Math.max(0, 100 - percent),
    tone: tone(percent),
    resetsAtMs: window.resetsAtMs,
    expired: left <= 0,
    current: recent && left > 0,
    resets: left > 0 ? `Resets in ${formatReset(left)}` : refreshable ? "Reset time passed · refresh needed" : "Reset time passed · waiting for Muse's next report",
  };
}

/**
 * Refresh asks Meta again, so it can help wherever Ancilla has made a direct check for the account (the server stamps
 * it with a check time), and after a failed read, which is what a retry is for. A reading only the Muse runtime
 * reports (a WSL host, a Keychain-only login, a login that lost its token) changes when Muse next sends usage, however
 * often it is refreshed. A report from a server that predates direct checks has no check time either, and such a
 * server never asked Meta, so it reads the same way.
 */
function canRefresh(account?: PlanAccountUsage): boolean {
  return !account || account.checkedAtMs !== null || account.status === "unavailable";
}

/** The plan meter as the UI shows it: the short window and the weekly cap, each with how long until it resets. */
export function planView(usage: PlanUsage | null, now: number, account?: PlanAccountUsage): PlanView | null {
  if (!usage || !Number.isFinite(usage.observedAtMs) || Math.abs(usage.observedAtMs) > 8_640_000_000_000_000 ||
    ![usage.window, usage.weekly].every((window) => window && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 &&
      Number.isFinite(window.resetsAtMs) && Math.abs(window.resetsAtMs) <= 8_640_000_000_000_000)) {
    return null;
  }
  const old = now - usage.observedAtMs > STALE_MS;
  const available = !account || ((account.status === "ready" || account.status === "runtime-only") && account.source !== "saved");
  const refreshable = canRefresh(account);
  return {
    tier: /^[a-z][a-z0-9_ -]{0,31}$/i.test(usage.tier) ? humanize(usage.tier) : null,
    rows: [row("window", windowLabel(usage.window), usage.window, now, !old && available, refreshable),
      row("weekly", "Weekly limit", usage.weekly, now, !old && available, refreshable)],
    observedAtMs: usage.observedAtMs,
    stale: old || usage.window.resetsAtMs <= now || usage.weekly.resetsAtMs <= now,
    age: planAge(usage.observedAtMs, now),
    refreshable,
  };
}

/**
 * The limit that decides whether the account runs out: the highest percentage among the rows with a current reading,
 * the short window when they tie. Null when no row is current, so a stale meter never passes for a number.
 */
export function bindingRow(view: PlanView): PlanRow | null {
  let binding: PlanRow | null = null;
  for (const row of view.rows) {
    if (row.current && (!binding || row.percent > binding.percent)) {
      binding = row;
    }
  }
  return binding;
}

/**
 * Whether the background sync should read the plan meter now: only while the window is in sight, once per interval.
 * After a read that failed the interval is a minute, so a passing failure does not leave the pill on a dash for minutes.
 */
export function planSyncDue(visibility: string, lastLoadedAt: number, now: number, retrying = false): boolean {
  return visibility === "visible" && (now - lastLoadedAt >= (retrying ? MINUTE_MS : PLAN_SYNC_MS) || now < lastLoadedAt);
}

/** Whether the last read left an account without a reading it can stand behind: the read itself failed, or Meta could not be asked. */
export function planReadFailed(state: Pick<AppState, "planUsageStatus" | "planUsageAccounts">): boolean {
  return state.planUsageStatus === "unavailable" || state.planUsageAccounts.some((account) => account.status === "unavailable");
}

/** What the plan meter's upkeep needs from the controller. */
export interface PlanUpkeepController {
  readonly store: { get(): AppState };
  loadPlanUsage(options?: { background?: boolean }): Promise<void>;
}

/** What it needs from the page: whether the window is in sight, and to hear when that changes. */
export interface PlanUpkeepPage {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** What it needs from the clock, so the timing can be driven by hand in a test. */
export interface PlanUpkeepClock {
  now(): number;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemClock: PlanUpkeepClock = {
  now: () => Date.now(),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Keeps the sidebar's plan meter current wherever the person is: re-reads it quietly (no spinner) when the window comes
 * back into sight and once the interval has passed while it is in sight, and does nothing while it is hidden or before
 * Muse is set up. The timer only looks at the clock, so a late tick cannot skip a read. Returns what stops it.
 */
export function startPlanSync(controller: PlanUpkeepController, page: PlanUpkeepPage, clock: PlanUpkeepClock = systemClock): () => void {
  let lastLoadedAt = clock.now();
  const sync = () => {
    const now = clock.now();
    const state = controller.store.get();
    if (state.boot !== "ready" || !state.env?.museFound || !planSyncDue(page.visibilityState, lastLoadedAt, now, planReadFailed(state))) {
      return;
    }
    lastLoadedAt = now;
    void controller.loadPlanUsage({ background: true });
  };
  const timer = clock.setInterval(sync, MINUTE_MS);
  page.addEventListener("visibilitychange", sync);
  return () => {
    clock.clearInterval(timer);
    page.removeEventListener("visibilitychange", sync);
  };
}

/**
 * The Usage page's own upkeep: one read when it opens, which shows that it is checking, then quiet reads every minute
 * and whenever the window comes back into sight. Returns what stops it.
 */
export function startPlanPolling(controller: PlanUpkeepController, page: PlanUpkeepPage, clock: PlanUpkeepClock = systemClock): () => void {
  void controller.loadPlanUsage();
  const refresh = () => {
    if (page.visibilityState === "visible") {
      void controller.loadPlanUsage({ background: true });
    }
  };
  // This checks the account without creating a thread or making a model call.
  const timer = clock.setInterval(refresh, MINUTE_MS);
  page.addEventListener("visibilitychange", refresh);
  return () => {
    clock.clearInterval(timer);
    page.removeEventListener("visibilitychange", refresh);
  };
}

/** The sidebar follows the account that will run this thread, never whichever reported most recently. */
export function contextualPlanAccountId(state: AppState): string | null {
  if (state.route.kind === "thread") return state.sessions[state.route.sessionId]?.accountId ?? null;
  if (state.route.kind === "usage" || state.route.kind === "settings") return state.planUsageSelectedAccountId;
  const cwd = state.route.kind === "new" ? state.route.cwd : state.prefs.lastProject;
  return (projectForCwd(state.projects, cwd) ?? state.projects[0])?.defaultAccountId ?? null;
}

/** Compatibility for older servers and demos, without treating the newest named reading as the default login. */
export function legacyPlanAccounts(report: PlanUsageReport, previous: readonly PlanAccountUsage[]): PlanAccountUsage[] {
  const sourceId = report.accountId === undefined && report.usage
    ? Object.entries(report.byAccount).find(([, usage]) => usage.observedAtMs === report.usage?.observedAtMs)?.[0] ?? null
    : report.accountId ?? null;
  const defaultUsage = sourceId === null ? report.usage : previous.find((account) => account.accountId === null)?.usage ?? null;
  const readings = [{ accountId: null, usage: defaultUsage }, ...Object.entries(report.byAccount).map(([accountId, usage]) => ({ accountId, usage }))];
  return readings.map(({ accountId, usage }) => {
    const saved = accountId === sourceId ? report.saved === true : accountId !== null && report.savedAccountIds?.includes(accountId) === true;
    return { accountId, usage, planName: null, checkedAtMs: null, source: usage ? saved ? "saved" : "runtime" : null,
      status: report.status === "unavailable" ? "unavailable" : usage ? "runtime-only" : "not-reported" };
  });
}

export function planAccount(state: AppState, accountId: string | null): PlanAccountUsage {
  const account = state.planUsageAccounts.find((entry) => entry.accountId === accountId);
  if (account) return account;
  const usage = accountId === null ? state.planUsageAccountId === null ? state.planUsage : null : state.planUsageByAccount[accountId] ?? null;
  const saved = accountId === null ? state.planUsageSaved : state.planUsageSavedAccounts.includes(accountId);
  const needsLogin = accountId === null ? state.defaultLogin?.hasLogin === false && !state.metaApiKeyInherited : state.accounts?.find((entry) => entry.id === accountId)?.hasLogin === false;
  return { accountId, usage, planName: null, checkedAtMs: null, source: usage ? saved ? "saved" : "runtime" : null,
    status: state.planUsageStatus === "unavailable" ? "unavailable" : usage ? "runtime-only" : needsLogin ? "login-required" : "not-reported" };
}

export function planAccountChoices(state: AppState): { id: string | null; name: string }[] {
  const named = new Map((state.accounts ?? []).map((account) => [account.id, account.name]));
  for (const account of state.planUsageAccounts) {
    if (account.accountId !== null && !named.has(account.accountId)) named.set(account.accountId, account.accountId);
  }
  return [{ id: null, name: "Default login" }, ...[...named].map(([id, name]) => ({ id, name }))];
}

export function samePlanUsage(a: PlanUsage | null, b: PlanUsage): boolean {
  return a !== null && a.observedAtMs === b.observedAtMs && a.tier === b.tier &&
    (["window", "weekly"] as const).every((key) => a[key].usedPercent === b[key].usedPercent &&
      a[key].resetsAtMs === b[key].resetsAtMs && a[key].windowDurationMins === b[key].windowDurationMins);
}

/** A late response cannot erase a newer event, but a newer account check may invalidate a historical reading. */
export function mergePlanAccounts(current: readonly PlanAccountUsage[], before: readonly PlanAccountUsage[], reported: readonly PlanAccountUsage[]): PlanAccountUsage[] {
  const stamp = (account: PlanAccountUsage) => Math.max(account.checkedAtMs ?? -Infinity, account.usage?.observedAtMs ?? -Infinity);
  const result = reported.map((account) => {
    const latest = current.find((entry) => entry.accountId === account.accountId);
    const matchingMeta = latest && account.source === "meta" && account.usage && samePlanUsage(latest.usage, account.usage);
    const eventWins = latest && (stamp(latest) > stamp(account) || (stamp(latest) === stamp(account) && !matchingMeta));
    return latest && latest !== before.find((entry) => entry.accountId === account.accountId) && eventWins ? latest : account;
  });
  for (const account of current) {
    if (!result.some((entry) => entry.accountId === account.accountId) && account !== before.find((entry) => entry.accountId === account.accountId)) result.push(account);
  }
  return result;
}

/** Tool calls in a thread still running in the background, which `task/stopAll` would stop. */
export function backgroundTasks(fold: ThreadFold): string[] {
  const ids: string[] = [];
  for (const id of fold.order) {
    const item = fold.items[id];
    if (item?.kind === "toolCall" && item.background === true && item.status === "inProgress") {
      ids.push(id);
    }
  }
  return ids;
}
