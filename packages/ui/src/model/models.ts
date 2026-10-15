import type { AccountView, ModelCatalogInfo, ModelOption, ModelsStatus, ReasoningEffort, ResearchRunView } from "../types.js";
import { crewBusy } from "./crew.js";
import type { ThreadFold } from "./fold.js";
import { formatTokens, modelDisplayName } from "./format.js";
import { publishedModelIds } from "./pricing.js";

/**
 * The model picker's vocabulary: which catalog a list came from, how a menu reads its load, the rows it shows, how
 * a typed name finds a model and which reasoning levels a model offers. Pure, so the rules are tested without React;
 * the components only render what these return.
 */

// ---------------------------------------------------------------- catalog scopes

/** The catalog a list belongs to: the default login's, a named account's, or an open thread's own host's. */
export interface ModelsScope {
  accountId?: string | null;
  sessionId?: string | null;
}

/** `default`, `acct:<accountId>` or `thread:<sessionId>`. A thread's host decides, so its id wins over the account. */
export function modelsKey(scope: ModelsScope = {}): string {
  if (scope.sessionId) {
    return `thread:${scope.sessionId}`;
  }
  return scope.accountId ? `acct:${scope.accountId}` : "default";
}

/** The slice of the app state the catalog functions read; `AppState` satisfies it. */
export interface ModelsState {
  /** The union of every loaded list, for lookups that only need to know a model (price, context window). */
  models: readonly ModelOption[];
  accountModels: Readonly<Record<string, readonly ModelOption[]>>;
  modelsStatus: Readonly<Record<string, ModelsStatus>>;
}

/**
 * A scope's own list, empty until it has loaded. The default scope falls back to `models` while nothing is filed
 * under it, so a state built with only `models` still has its list.
 */
export function modelsFor(state: Pick<ModelsState, "models" | "accountModels">, scope: string | ModelsScope): readonly ModelOption[] {
  const key = typeof scope === "string" ? scope : modelsKey(scope);
  return state.accountModels[key] ?? (key === "default" ? state.models : []);
}

/**
 * What a menu lists for a scope. A scope whose load failed has no list of its own, so the default login's stands
 * in for display only; `fallback` says so, and the menu says it too, never silently.
 */
export function modelsShown(
  state: Pick<ModelsState, "models" | "accountModels" | "modelsStatus">,
  scope: string | ModelsScope,
): { models: readonly ModelOption[]; fallback: boolean } {
  const key = typeof scope === "string" ? scope : modelsKey(scope);
  const own = modelsFor(state, key);
  if (own.length > 0 || key === "default" || state.modelsStatus[key]?.status !== "error") {
    return { models: own, fallback: false };
  }
  const base = modelsFor(state, "default");
  return { models: base, fallback: base.length > 0 };
}

/** What a menu knows about the list it shows: the rows, whether they are a stand-in, and what Muse says the list is. */
export interface ModelsStanding {
  /** The rows on show: the scope's own, or the default login's standing in for a failed one. */
  models: readonly ModelOption[];
  fallback: boolean;
  /** The list on show is Muse's built-in one, which proves nothing about the plan. */
  limited: boolean;
  /** The list on show is the plan's own, so a model it lacks may be called unavailable. Never true for a stand-in. */
  judged: boolean;
}

/** `modelsShown` with the catalog's verdict on the rows it shows: a stand-in list is judged by the default login's catalog. */
export function modelsStanding(
  state: Pick<ModelsState, "models" | "accountModels" | "modelsStatus">,
  scope: string | ModelsScope,
): ModelsStanding {
  const key = typeof scope === "string" ? scope : modelsKey(scope);
  const { models, fallback } = modelsShown(state, key);
  const info = (fallback ? state.modelsStatus["default"] : state.modelsStatus[key])?.catalog;
  return { models, fallback, limited: isLimitedCatalog(info), judged: !fallback && isPlanCatalog(info) };
}

/** The reasoning levels both rows list, or whichever row lists some; null when neither does. */
function widerEfforts(first: ModelOption["efforts"], second: ModelOption["efforts"]): ModelOption["efforts"] {
  if (!second || second.length === 0) {
    return first;
  }
  if (!first || first.length === 0) {
    return second;
  }
  const union = EFFORT_TIERS.filter((level) => first.includes(level) || second.includes(level));
  return union.length > first.length ? union : first;
}

/**
 * The row that stands for a model once two lists name it: the first one's, with what it leaves empty (the context
 * window, the output limit, the price, reasoning levels it does not list) taken from the other. The very same row
 * comes back when the other adds nothing.
 */
function fillRow(winner: ModelOption, other: ModelOption): ModelOption {
  const efforts = widerEfforts(winner.efforts, other.efforts);
  const contextLimit = winner.contextLimit ?? other.contextLimit;
  const outputLimit = winner.outputLimit ?? other.outputLimit;
  const cost = winner.cost ?? other.cost;
  if (efforts === winner.efforts && contextLimit === winner.contextLimit && outputLimit === winner.outputLimit && cost === winner.cost) {
    return winner;
  }
  return { ...winner, contextLimit, outputLimit, cost, ...(efforts === undefined ? {} : { efforts }) };
}

/**
 * Every list's models once each, the first list winning, so a lookup (price, context window, a thread's own model)
 * resolves a model only a named account offers. The winning row keeps what it says and borrows what it leaves empty
 * from the later lists, so a built-in row without a window never hides the plan's row for the same model.
 */
export function mergeKnownModels(lists: readonly (readonly ModelOption[] | null | undefined)[]): ModelOption[] {
  const merged: ModelOption[] = [];
  const at = new Map<string, number>();
  for (const list of lists) {
    for (const model of list ?? []) {
      const index = at.get(model.modelId);
      if (index === undefined) {
        at.set(model.modelId, merged.length);
        merged.push(model);
      } else {
        merged[index] = fillRow(merged[index] as ModelOption, model);
      }
    }
  }
  return merged;
}

/**
 * The union every lookup reads: the plan's own lists (`providerCatalog`) ahead of the limited ones, the default
 * login's first among equals, then the other scopes in the order they were asked for.
 */
export function knownModels(
  lists: Readonly<Record<string, readonly ModelOption[]>>,
  statuses: Readonly<Record<string, ModelsStatus>> = {},
): ModelOption[] {
  const keys = Object.keys(lists);
  const rank = (key: string) => (isPlanCatalog(statuses[key]?.catalog) ? 0 : 1);
  const ordered = keys
    .map((key, order) => ({ key, order: key === "default" ? -1 : order }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.order - b.order);
  return mergeKnownModels(ordered.map(({ key }) => lists[key]));
}

/**
 * Whether a model the shown list lacks is offered by another loaded list: any scope's, which the union `models` holds.
 * Settings shows one list for a default every account shares, so this is how it tells a model its list does not name
 * from one that is only another account's.
 */
export function offeredByAnother(state: Pick<ModelsState, "models">, shown: readonly ModelOption[], modelId: string | null | undefined): boolean {
  return !!modelId && !shown.some((m) => m.modelId === modelId) && state.models.some((m) => m.modelId === modelId);
}

// ---------------------------------------------------------------- loading state

/** How long a loaded list is trusted before opening the picker asks again. */
export const MODELS_TTL_MS = 10 * 60 * 1000;

/** Muse's own list for the login: the only source that says which models the plan offers. */
export function isPlanCatalog(info: ModelCatalogInfo | null | undefined): boolean {
  return info?.source === "providerCatalog";
}

/**
 * A list Muse built in or read from a config file, not the plan's: it proves nothing about any model, so a model it
 * lacks is never called unavailable. A list that says nothing about its source (an older server) is not judged.
 */
export function isLimitedCatalog(info: ModelCatalogInfo | null | undefined): boolean {
  return !!info && info.source !== null && info.source !== "providerCatalog";
}

/** A named account with no login yet is never asked for models; the menu offers to sign in instead. */
export function modelsNeedSignIn(
  accounts: readonly Pick<AccountView, "id" | "hasLogin">[] | null | undefined,
  accountId: string | null | undefined,
): boolean {
  return !!accountId && !!accounts?.some((account) => account.id === accountId && !account.hasLogin);
}

/** What a typed model id looks like: letters, digits and `. _ : -`, no longer than a hundred characters. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][\w.:-]*$/;

/** Whether text is shaped like a model id, so it can be tried as one. */
export function isModelId(text: string): boolean {
  return text.length <= 100 && MODEL_ID_PATTERN.test(text);
}

/** A catalog row with nothing but an id, for a model no list describes: one Meta publishes, or one a thread runs on. */
export function modelStub(modelId: string, extra: Partial<ModelOption> = {}): ModelOption {
  return {
    modelId,
    displayLabel: modelId,
    description: null,
    isDefault: false,
    isActive: false,
    contextLimit: null,
    outputLimit: null,
    cost: null,
    contributor: isContributorId(modelId),
    efforts: null,
    ...extra,
  };
}

/** The models Meta publishes that a list does not name, as rows, so a typed name is ranked against them like any other. */
export function publishedStubs(models: readonly ModelOption[]): ModelOption[] {
  return publishedModelIds()
    .filter((id) => !models.some((m) => m.modelId === id))
    .map((id) => modelStub(id));
}

/**
 * What typed text means as a model id, or null when it is a name instead. An id is text that equals a listed or
 * published id (any case; the id's own spelling comes back) or that has a separator or a digit (`muse-wonder-2.0`),
 * so a model nobody listed can still be tried by hand. A bare word (`wonder`, `spark`) is a name: it is never made
 * into an id, since Muse accepts any id and would only fail at the first prompt.
 */
export function literalModelId(text: string, models: readonly ModelOption[]): string | null {
  const id = text.trim();
  if (!isModelId(id)) {
    return null;
  }
  const lower = id.toLowerCase();
  const known = models.find((m) => m.modelId.toLowerCase() === lower)?.modelId ?? publishedModelIds().find((p) => p.toLowerCase() === lower);
  if (known) {
    return known;
  }
  return /[-.:_0-9]/.test(id) ? id : null;
}

/** How long a failed or empty answer is left alone by a navigation: moving around the app does not retry it at once. */
export const MODELS_RETRY_MS = 60 * 1000;

/** Who is asking whether a list is stale. */
export interface StaleOptions {
  /**
   * A route change or Settings opening asked, not the person at the picker. A navigation leaves a built-in list be
   * until it is ten minutes old, and an error or an empty answer until a minute has passed.
   */
  navigation?: boolean;
  /** When the last load failed, in the clock `now` reads; the status itself keeps the time of the last good answer. */
  failedAt?: number | null;
}

/**
 * Whether a scope's list should be asked for again: never loaded, last load failed, no models came back, it is
 * only Muse's built-in list (the real one usually arrives moments later), or it is older than ten minutes. `models`
 * is optional because a status alone cannot tell a ready list from an empty one. Opening the picker, Retry and a
 * watch after a host change ask on all of those; a navigation (`options.navigation`) is gentler, so going from
 * screen to screen does not hammer Muse with a list that cannot be better a second later.
 */
export function isStale(status: ModelsStatus | undefined, now: number, models?: readonly ModelOption[], options: StaleOptions = {}): boolean {
  if (!status || status.status === "idle") {
    return true;
  }
  const quiet = (since: number | null | undefined) => options.navigation === true && typeof since === "number" && now - since < MODELS_RETRY_MS;
  if (status.status === "error") {
    return !quiet(options.failedAt);
  }
  if (status.loadedAt === null) {
    return true;
  }
  if (isLimitedCatalog(status.catalog) && options.navigation !== true) {
    return true;
  }
  if (models && models.length === 0) {
    return !quiet(status.loadedAt);
  }
  return now - status.loadedAt > MODELS_TTL_MS;
}

export type ModelsMenuState = "loading" | "error" | "empty" | "ready";

/**
 * What the menu shows for a scope: an error row when the last load failed (with the rows too when an older load
 * left some), the rows themselves, "no models" once a load answered with none, else a loading row. Pass the scope's
 * own list, not the display fallback, so a failed account still reads as failed.
 */
export function modelsMenuState(status: ModelsStatus | undefined, models: readonly ModelOption[]): ModelsMenuState {
  if (status?.status === "error") {
    return "error";
  }
  if (models.length > 0) {
    return "ready";
  }
  return status?.status === "ready" ? "empty" : "loading";
}

// ---------------------------------------------------------------- rows

/** Muse's catalog note for a Contributor model, shown once under the badge and never as a row's own description. */
export const CONTRIBUTOR_NOTE = "Prompts and outputs may be used to improve Meta's products.";

/** Why a model is shown but cannot be chosen again: the account does not list it. */
export type ModelNote = "unavailable" | "not offered";

/**
 * Why a pinned model is not among the rows: the plan's own list lacks it (`plan`), the list is only Muse's built-in
 * one and says nothing (`limited`), the user tried it by its id (`tried`), or another account's list offers it
 * (`elsewhere`).
 */
export type PinReason = "plan" | "limited" | "tried" | "elsewhere";

/** What a menu knows about the model it pins, beyond the list it judges it by. */
export interface PinContext {
  /** The saved default is an id the user tried by hand: it is kept and never called unavailable. */
  tried?: boolean;
  /** Another account's list offers the pinned model, so this list's silence about it is not a verdict. */
  elsewhere?: boolean;
}

export interface ModelChoice {
  /** `default` is the "Muse default" row, `pin` a model the list does not offer, `model` a catalog row. */
  kind: "default" | "model" | "pin";
  /** The model id; null on the "Muse default" row. */
  id: string | null;
  /** The one label every surface uses: the id without its `-contributor` tier, which has its own badge. */
  label: string;
  /** The catalog's own name, only when it says something the id does not. */
  displayLabel: string | null;
  /** The catalog's description, unless it is the Contributor note the badge already carries. */
  description: string | null;
  contextLimit: number | null;
  /** The catalog's default row, which "Muse default" follows. */
  isDefault: boolean;
  contributor: boolean;
  selected: boolean;
  note: ModelNote | null;
  /** On a `pin` row, why the list does not offer it; null on every other row. */
  unlisted: PinReason | null;
}

function contributorNote(description: string | null): boolean {
  return /product improvement/i.test(description ?? "");
}

function modelChoice(model: ModelOption, selected: boolean): ModelChoice {
  const displayLabel = model.displayLabel && model.displayLabel !== model.modelId ? model.displayLabel : null;
  return {
    kind: "model",
    id: model.modelId,
    label: modelDisplayName(model.modelId),
    displayLabel,
    description: model.description && !contributorNote(model.description) ? model.description : null,
    contextLimit: model.contextLimit,
    isDefault: model.isDefault,
    contributor: model.contributor,
    selected,
    note: null,
    unlisted: null,
  };
}

/** What a pinned model's absence from the list means: another account's list offers it, the user tried it, or the list says so or says nothing. */
function pinReason(judged: boolean, context: PinContext, onThread: boolean): PinReason {
  if (context.elsewhere && !onThread) {
    return "elsewhere";
  }
  if (context.tried && !onThread) {
    return "tried";
  }
  return judged ? "plan" : "limited";
}

/**
 * The rows a model menu renders, in the host's order (Muse sends the newest first, so nothing is re-sorted):
 * "Muse default" first, then a pinned model the list does not offer, then the catalog. `current` is the model the
 * open thread runs on, or null on the new-thread screen and in Settings, where `pref` (the saved default, null for
 * "Muse default") is what is selected. Exactly one row is ever selected. `judged` says the list is the plan's own
 * (`isPlanCatalog`): only then is a pinned model it lacks called unavailable or not offered; a built-in list proves
 * nothing, so the pin is shown without a note. A saved default the user tried by its id, or one another account's list
 * offers (`context`), is not called unavailable either: it is kept, and its row says why it is not among the rest.
 */
export function modelChoices(
  models: readonly ModelOption[],
  current: string | null,
  pref: string | null,
  judged = true,
  context: PinContext = {},
): ModelChoice[] {
  const onThread = Boolean(current);
  const picked = onThread ? current : pref;
  const fallback = models.find((m) => m.isDefault) ?? null;
  const rows: ModelChoice[] = [];
  const followed = fallback ? modelDisplayName(fallback.modelId) : null;
  // On a thread the row switches nothing: it only sets what new threads start on, and says so.
  const lead = onThread ? "New threads follow Muse's default, currently" : "Currently";
  rows.push({
    kind: "default",
    id: null,
    label: "Muse default",
    displayLabel: null,
    description: !followed
      ? onThread
        ? "New threads follow Muse's default"
        : "Muse chooses the model"
      : fallback?.contributor
        ? `${lead} ${followed}, a Contributor model. ${CONTRIBUTOR_NOTE}`
        : `${lead} ${followed}`,
    contextLimit: null,
    isDefault: false,
    contributor: fallback?.contributor ?? false,
    selected: !onThread && pref === null,
    note: null,
    unlisted: null,
  });
  // An empty list says nothing about a model: it may only not have loaded yet.
  if (picked && models.length > 0 && !models.some((m) => m.modelId === picked)) {
    const unlisted = pinReason(judged, context, onThread);
    rows.push({
      kind: "pin",
      id: picked,
      label: modelDisplayName(picked),
      displayLabel: null,
      description: null,
      contextLimit: null,
      isDefault: false,
      contributor: /contributor/i.test(picked),
      selected: true,
      note: unlisted === "plan" ? (onThread ? "not offered" : "unavailable") : null,
      unlisted,
    });
  }
  let chosen = false;
  for (const model of models) {
    const selected: boolean = !chosen && picked !== null && model.modelId === picked;
    chosen = selected || chosen;
    rows.push(modelChoice(model, selected));
  }
  return rows;
}

export interface ModelTrigger {
  /** The model's id; null when the list does not say which one is the default. */
  id: string | null;
  /** The name, with its note when there is one, as the trigger and its accessible label read it. */
  text: string;
  name: string;
  contributor: boolean;
  note: ModelNote | null;
}

/**
 * The model button's text. On a thread it is the thread's model, `(not offered)` when its own non-empty list lacks
 * it; on the new-thread screen it is the saved default, `(unavailable)` when the list lacks that, else Muse's default.
 * `judged` and `context` are as for `modelChoices`: a built-in list, a model tried by its id and one another account
 * offers never put a note on the name.
 */
export function modelTrigger(
  models: readonly ModelOption[],
  current: string | null,
  pref: string | null,
  judged = true,
  context: PinContext = {},
): ModelTrigger {
  const onThread = Boolean(current);
  const id = onThread ? current : (pref ?? models.find((m) => m.isDefault)?.modelId ?? null);
  const row = models.find((m) => m.modelId === id);
  const note: ModelNote | null =
    id && models.length > 0 && !row && (onThread || pref !== null) && pinReason(judged, context, onThread) === "plan"
      ? onThread
        ? "not offered"
        : "unavailable"
      : null;
  const name = modelDisplayName(id);
  return {
    id,
    name,
    text: note ? `${name} (${note})` : name,
    contributor: row?.contributor ?? /contributor/i.test(id ?? ""),
    note,
  };
}

// ---------------------------------------------------------------- the menu

/** The words every model menu uses, so the composer's and Settings' say the same thing. */
export const MODEL_COPY = {
  loading: "Loading models",
  empty: "Muse listed no models. Refresh to ask again.",
  retry: "Retry",
  refresh: "Refresh models",
  refreshing: "Loading",
  other: "Other model…",
  fallback: "Showing the default login's models",
  kept: "Showing the last list Muse sent",
  limited: "Muse sent its built-in model list, not your plan's. Other models may still work: pick one below or type a model id.",
  builtIn: "Built-in model list. Refresh, or update and restart Muse, to load your plan's.",
  missing: "Missing a model? Update Muse, restart it and refresh.",
  published: "Published by Meta",
  /** Under a model the list does not offer: a model, saved or typed, that Muse never listed. */
  notListed: "Not in Muse's list. Muse checks access when you send a prompt.",
  /** Under the model a thread runs on when the list is only Muse's built-in one: it names few models, so its silence is no verdict. */
  notNamed: "Muse's built-in list does not name it",
  /** Under a saved model this account's list lacks while another account's offers it. */
  elsewhere: "Offered by another account",
  /** A pick from the default login's list standing in for an account whose own list did not load. */
  unconfirmed: (id: string, who: string) => `Using ${id}; ${who} has not confirmed it`,
  unconfirmedDetail: "Its model list did not load. Muse checks access when you send a prompt.",
  noModel: (name: string) => `No model named ${name}`,
  restart: "Restart Muse",
  restartRunning: "Work is still running",
  restartBusy: "Restarting",
  signInAction: "Sign in with Meta",
  failed: (message: string | null) => (message ? `Could not load models: ${message}` : "Could not load models"),
  signIn: (account: string) => `Sign in to ${account} to see its models`,
} as const;

/** What a model menu's status area says: a load in progress, a failure, nothing listed, an account to sign in to, or rows. */
export type ModelMenuMode = ModelsMenuState | "signin";

/** The slice of the app state a model menu reads; `AppState` satisfies it. */
export interface ModelMenuSource extends ModelsState {
  accounts: readonly Pick<AccountView, "id" | "name" | "hasLogin">[] | null;
}

export interface ModelMenuOptions {
  /** The catalog the menu lists: an open thread's own host, a project's account, or the default login. */
  scope: ModelsScope;
  /** The account whose login that catalog's host runs as; null for the default login. */
  accountId: string | null;
  /** The open thread's model id; null on the new-thread screen and in Settings. */
  current: string | null;
  /** The saved default model, null for "Muse default". */
  pref: string | null;
  /** The account's plan name when it is known: shown beside the host's version, never as a claim about the list. */
  plan: string | null;
  /** The saved default is a model the user tried by its id (`prefs.defaultModelTried`): it is kept, not called unavailable. */
  tried?: boolean;
  /**
   * The saved default is global, so a menu that shows one list (Settings) must not call it unavailable while another
   * account's loaded list offers it: it says so instead.
   */
  elsewhere?: boolean;
}

/** A model Meta publishes that a limited list lacks, offered as a one-click try. */
export interface PublishedChoice {
  id: string;
  label: string;
}

export interface ModelMenu {
  key: string;
  mode: ModelMenuMode;
  /** The account to offer a sign-in for, in `signin` mode. */
  signIn: { id: string; name: string } | null;
  /** The status line: why there are no rows, or why the load failed. Null when there is nothing to say. */
  message: string | null;
  /** Muted lines under the status: a stand-in list, a kept list, a built-in list. */
  notes: string[];
  /** The rows the radio group renders. Hidden (`showRows` false) only while the first load is still running. */
  rows: ModelChoice[];
  showRows: boolean;
  published: PublishedChoice[];
  trigger: ModelTrigger;
  /** A load for this scope is running; the Refresh action says so and waits. */
  refreshing: boolean;
  /** The list on show: the scope's own, or the default login's standing in for a failed one. */
  models: readonly ModelOption[];
  /** The list on show is the default login's, because this scope's load failed. */
  fallback: boolean;
  /** The list is Muse's built-in one, which proves nothing about the plan. */
  limited: boolean;
  /** The saved model is not on this list but another account's offers it (only asked for with `elsewhere`). */
  offeredElsewhere: boolean;
  footer: { line: string | null; builtIn: string | null; hint: string | null };
}

/**
 * Everything a model menu renders besides its chrome, so the composer's picker and Settings show the same thing and
 * the rules are tested without React. A load that failed is an error row (the older rows stay under it when there are
 * any); a scope whose load failed shows the default login's list, said so, for display only; a list Muse built in is
 * noted and never judged; the footer names the host's version and the plan, and points at the likeliest reason a
 * model is missing, a Muse that is out of date.
 */
export function modelMenu(source: ModelMenuSource, options: ModelMenuOptions): ModelMenu {
  const key = modelsKey(options.scope);
  const status = source.modelsStatus[key];
  const own = modelsFor(source, key);
  // A stand-in list is the default login's, so what it says about itself is that list's, not this scope's.
  const { models, fallback, limited, judged } = modelsStanding(source, key);
  const account = options.accountId ? source.accounts?.find((a) => a.id === options.accountId) : undefined;
  const signIn = modelsNeedSignIn(source.accounts, options.accountId) && account ? { id: account.id, name: account.name } : null;
  const mode: ModelMenuMode = signIn ? "signin" : modelsMenuState(status, own);
  const pinned = options.current ?? options.pref;
  const offeredElsewhere = options.elsewhere === true && offeredByAnother(source, models, pinned);
  const rows = modelChoices(models, options.current, options.pref, judged, { tried: options.tried === true, elsewhere: offeredElsewhere });
  const picked = rows.find((row) => row.kind === "pin")?.id ?? null;
  const notes: string[] = [];
  if (fallback) {
    notes.push(MODEL_COPY.fallback);
  } else if (mode === "error" && own.length > 0) {
    notes.push(MODEL_COPY.kept);
  }
  if (limited) {
    notes.push(MODEL_COPY.limited);
  }
  const version = fallback ? null : status?.catalog?.hostVersion;
  return {
    key,
    mode,
    signIn,
    message:
      mode === "signin" && signIn ? MODEL_COPY.signIn(signIn.name)
      : mode === "loading" ? MODEL_COPY.loading
      : mode === "empty" ? MODEL_COPY.empty
      : mode === "error" ? MODEL_COPY.failed(status?.error ?? null)
      : null,
    notes,
    rows,
    showRows: mode !== "loading",
    published: limited
      ? publishedModelIds()
          .filter((id) => id !== picked && !models.some((m) => m.modelId === id))
          .map((id) => ({ id, label: modelDisplayName(id) }))
      : [],
    trigger: modelTrigger(models, options.current, options.pref, judged, { tried: options.tried === true, elsewhere: offeredElsewhere }),
    refreshing: status?.status === "loading",
    models,
    fallback,
    limited,
    offeredElsewhere,
    footer: {
      line: [version ? `Muse ${version}` : null, options.plan].filter(Boolean).join(" · ") || null,
      builtIn: limited ? MODEL_COPY.builtIn : null,
      hint: limited ? null : MODEL_COPY.missing,
    },
  };
}

/** The radio value of the "Muse default" row, which has no model id. */
export const MUSE_DEFAULT_VALUE = "";

/** A radio value no row has, for a menu where nothing is selected (a saved model an empty list cannot vouch for). */
export const NO_CHOICE = "\u0000";

/** A row's radio value: its model id, or the empty string for "Muse default". */
export function choiceValue(choice: Pick<ModelChoice, "id">): string {
  return choice.id ?? MUSE_DEFAULT_VALUE;
}

/** The radio value to mark checked: the one selected row's, or a value no row has. */
export function selectedValue(rows: readonly ModelChoice[]): string {
  const row = rows.find((r) => r.selected);
  return row ? choiceValue(row) : NO_CHOICE;
}

/** The second line under a row: what the row follows, the catalog's description and window, or why it is shown. */
export function choiceDetail(choice: ModelChoice): string | null {
  if (choice.kind === "default") {
    return choice.description;
  }
  if (choice.kind === "pin") {
    // A built-in list names few models: that it lacks the one a thread runs on is not news. Another account's list may offer it.
    return choice.unlisted === "limited" ? MODEL_COPY.notNamed : choice.unlisted === "elsewhere" ? MODEL_COPY.elsewhere : MODEL_COPY.notListed;
  }
  if (choice.contributor) {
    return CONTRIBUTOR_NOTE;
  }
  const parts = [choice.description, choice.contextLimit ? `${formatTokens(choice.contextLimit)} token context` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** What a row is called where there is room for one line: its label, with the reason it cannot be chosen again, if any. */
export function choiceName(choice: ModelChoice): string {
  return choice.note ? `${choice.label} (${choice.note})` : choice.label;
}

/**
 * The line a model control says in words under its rows, so a fact does not hang on a hover: what the saved model is
 * when it is not among the rows (tried by hand, a built-in list's silence, another account's list), and, with
 * `museDefault`, what "Muse default" follows, since that can be a Contributor model nobody picked by name. Null when
 * the selected row says it all.
 */
export function modelPickLine(menu: Pick<ModelMenu, "rows" | "models">, options: { museDefault?: boolean } = {}): string | null {
  const selected = menu.rows.find((row) => row.selected);
  if (!selected) {
    return null;
  }
  if (selected.kind === "pin") {
    return choiceDetail(selected);
  }
  const followed = selected.kind === "default" && options.museDefault === true ? menu.models.find((m) => m.isDefault) : undefined;
  if (!followed) {
    return null;
  }
  const name = modelDisplayName(followed.modelId);
  return followed.contributor ? `Muse default is ${name}, a Contributor model. ${CONTRIBUTOR_NOTE}` : `Muse default is ${name}`;
}

/** What a screen reader hears for the model button: the name and its note, and the tier, which the badge beside them cannot carry. */
export function modelButtonLabel(trigger: Pick<ModelTrigger, "text" | "contributor">): string {
  return `Model: ${trigger.text}${trigger.contributor ? ", Contributor model" : ""}`;
}

/** Why the Restart action is off, if it is: work that would be cut short, or a restart already under way. */
export function restartAction(workRunning: boolean, restarting: boolean): { disabled: boolean; hint: string | null } {
  if (restarting) {
    return { disabled: true, hint: MODEL_COPY.restartBusy };
  }
  return workRunning ? { disabled: true, hint: MODEL_COPY.restartRunning } : { disabled: false, hint: null };
}

/**
 * Whether any thread has work going that closing Muse's hosts would cut short: a turn, or what outlives one (a
 * workflow run, a subagent, a background task, a research run). The same test as relaunching the app under them.
 */
export function anyWorkRunning(state: {
  sessions: Readonly<Record<string, { live?: { activeTurnId: string | null } | null }>>;
  threads: Readonly<Record<string, { fold: ThreadFold; researchRuns?: readonly ResearchRunView[] }>>;
}): boolean {
  return (
    Object.values(state.sessions).some((session) => Boolean(session.live?.activeTurnId)) ||
    Object.values(state.threads).some((thread) => thread.fold.activeTurnId !== null || crewBusy(thread.fold, thread.researchRuns))
  );
}

/**
 * The first name of `anyWorkRunning`, from when only a turn in flight held a restart back. It reads the whole of a
 * thread's fold now (`crewBusy` does), so a caller passes the `ThreadFold` the app holds, not a bare `{ activeTurnId }`.
 */
export const anyTurnRunning = anyWorkRunning;

/** Why a typed model id cannot be tried, or null when it can. */
export function modelIdError(text: string): string | null {
  const id = text.trim();
  if (!id) {
    return "Type a model id.";
  }
  if (id.length > 100) {
    return "A model id is at most 100 characters.";
  }
  return MODEL_ID_PATTERN.test(id) ? null : "A model id starts with a letter or digit and has letters, digits and . _ : - only.";
}

/**
 * A model's catalog row for what only the plan's own list can vouch for: the reasoning levels it takes. It is looked
 * for in the scope's list first, then in every other. A list Muse built in is passed over: it often lists fewer
 * levels than the plan's does (its one Spark row has no Max), and holding a turn to it would lower a level the model
 * takes. A model only such a list names has no row, so every level is offered, as for a model no list names.
 */
export function trustedModel(
  state: Pick<ModelsState, "models" | "accountModels" | "modelsStatus">,
  scope: string | ModelsScope,
  modelId: string | null | undefined,
): ModelOption | undefined {
  if (!modelId) {
    return undefined;
  }
  const key = typeof scope === "string" ? scope : modelsKey(scope);
  for (const held of [key, ...Object.keys(state.accountModels).filter((other) => other !== key)]) {
    if (isLimitedCatalog(state.modelsStatus[held]?.catalog)) {
      continue;
    }
    const row = modelsFor(state, held).find((m) => m.modelId === modelId);
    if (row) {
      return row;
    }
  }
  return undefined;
}

/**
 * The catalog row of the model a composer is on, for what depends on it (the reasoning levels): the open thread's
 * model, else the saved default, else the list's own default. The model is named from the list on show; its row is
 * the one `trustedModel` finds, so a built-in list never shortens the levels.
 */
export function activeModel(
  state: Pick<ModelsState, "models" | "accountModels" | "modelsStatus">,
  scope: ModelsScope,
  current: string | null,
  pref: string | null,
): ModelOption | undefined {
  const { models } = modelsShown(state, scope);
  const id = current ?? pref ?? models.find((m) => m.isDefault)?.modelId ?? null;
  return trustedModel(state, scope, id);
}

/** The two controller calls a model choice can make, so the composer's picker and Settings choose through one rule. */
export interface ModelChoiceTarget {
  clearModelPref(): void;
  setModel(modelId: string): unknown;
}

/**
 * Applies a picked row: "Muse default" (the empty radio value, or null where a control has no row id for it) clears
 * the saved model, any other value picks that model. Asking for a model with an empty id would only say it is not one.
 */
export function applyModelChoice(target: ModelChoiceTarget, value: string | null): void {
  if (value === null || value === MUSE_DEFAULT_VALUE) {
    target.clearModelPref();
  } else {
    void target.setModel(value);
  }
}

/** The one controller call a typed model id makes. */
export interface TypedModelTarget {
  setModel(modelId: string, options: { typed: true }): Promise<boolean>;
}

/**
 * Tries a model id typed by hand, in the picker's "Use another model" form or Settings' "Other model id" field. It goes
 * in as typed text, which a list that is empty or has not loaded yet cannot vouch for: the id is a try (this thread's
 * alone on an open thread, remembered as tried when it becomes the default), never taken for a listed one. Says
 * whether it took.
 */
export function tryTypedModel(target: TypedModelTarget, modelId: string): Promise<boolean> {
  return target.setModel(modelId, { typed: true });
}

// ---------------------------------------------------------------- finding a model by name

function normalized(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

function isContributorId(modelId: string): boolean {
  return /-contributor$/i.test(modelId);
}

/** `muse-spark-1.3-contributor` and `muse-spark-1.2` are both the `muse-spark` family; `muse-wonder-full-1.0` is another. */
function familyOf(modelId: string): string {
  return modelId.toLowerCase().replace(/-contributor$/, "").replace(/[-\s]*v?\d+(\.\d+)*$/, "");
}

/**
 * Models that answer to what was typed, best first, in the host's order within each rank: the exact id, then the
 * exact name (the label, the catalog's name, any spelling with spaces for hyphens), then a prefix, then a substring.
 * A Contributor row only matches when the query says contributor, or when it has no regular sibling to match instead.
 */
export function rankedModels(
  models: readonly ModelOption[],
  query: string,
  label: (id: string) => string = modelDisplayName,
): { model: ModelOption; rank: number }[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) {
    return [];
  }
  const spelled = normalized(wanted);
  const ids = new Set(models.map((m) => m.modelId.toLowerCase()));
  const asksContributor = spelled.includes("contributor");
  const ranked: { model: ModelOption; rank: number; order: number }[] = [];
  models.forEach((model, order) => {
    const id = model.modelId.toLowerCase();
    if (!asksContributor && isContributorId(id) && ids.has(id.replace(/-contributor$/, ""))) {
      return;
    }
    const names = [model.modelId, label(model.modelId), model.displayLabel].filter((name) => name).map(normalized);
    const rank =
      id === wanted ? 1
      : names.includes(spelled) ? 2
      : names.some((name) => name.startsWith(spelled)) ? 3
      : names.some((name) => name.includes(spelled)) ? 4
      : 0;
    if (rank > 0) {
      ranked.push({ model, rank, order });
    }
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.order - b.order).map(({ model, rank }) => ({ model, rank }));
}

/** What the slash menu lists after `/model `: every model that answers to the text, best first. */
export function modelMatches(models: readonly ModelOption[], query: string, label?: (id: string) => string): ModelOption[] {
  return rankedModels(models, query, label).map((entry) => entry.model);
}

/**
 * The one model a typed name means, or undefined when none matches or the best matches are different families
 * (`wonder` against Wonder and Wonder Full): the caller opens the picker rather than guess. Versions of one family
 * (`spark`) resolve to the first the host lists, its newest.
 */
export function findModel(models: readonly ModelOption[], query: string, label?: (id: string) => string): ModelOption | undefined {
  const ranked = rankedModels(models, query, label);
  const best = ranked.filter((entry) => entry.rank === ranked[0]?.rank);
  const first = best[0]?.model;
  if (!first) {
    return undefined;
  }
  const family = familyOf(first.modelId);
  return best.every((entry) => familyOf(entry.model.modelId) === family) ? first : undefined;
}

/** A model the slash menu offers after `/model `. */
export interface ModelCompletion {
  id: string;
  label: string;
  /** The context window, the one fact the menu has room for; null when the catalog lists none. */
  detail: string | null;
  isDefault: boolean;
  contributor: boolean;
  /** A model Meta publishes that the list does not name: picking it only tries it. */
  published: boolean;
}

/**
 * The rows `/model <text>` completes to: every model that answers to the text, best first, or every model in the
 * host's order while nothing is typed yet. Picking one runs `/model <id>`. While the list is only Muse's built-in one
 * (`limited`), the models Meta publishes that it lacks answer too, after the list's own, as the picker's group does.
 */
export function modelCompletions(
  models: readonly ModelOption[],
  query: string,
  label?: (id: string) => string,
  limited = false,
): ModelCompletion[] {
  const pool = limited ? [...models, ...publishedStubs(models)] : models;
  const found = query.trim() ? modelMatches(pool, query, label) : pool;
  return found.map((model) => ({
    id: model.modelId,
    label: modelDisplayName(model.modelId),
    detail: model.contextLimit ? `${formatTokens(model.contextLimit)} token context` : null,
    isDefault: model.isDefault,
    contributor: model.contributor,
    published: !models.some((m) => m.modelId === model.modelId),
  }));
}

/** The line under a completion that is only a try: Meta publishes the model, but Muse's built-in list does not name it. */
export function modelCompletionNote(item: Pick<ModelCompletion, "published">): string | null {
  return item.published ? MODEL_COPY.notListed : null;
}

// ---------------------------------------------------------------- reasoning effort

/** The levels the UI offers, lowest first. Ultra is left out on purpose: Muse runs it as Max. */
export const EFFORT_TIERS: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Where a level sits on the scale, including Ultra above Max so an old saved value still clamps sensibly. */
const EFFORT_ORDER: readonly ReasoningEffort[] = [...EFFORT_TIERS, "ultra"];

/** How a level reads in copy: the slider's own names. */
export function effortLabel(level: ReasoningEffort): string {
  switch (level) {
    case "none":
      return "Off";
    case "xhigh":
      return "Extra high";
    case "ultra":
      return "Max";
    default:
      return level.charAt(0).toUpperCase() + level.slice(1);
  }
}

function effortList(value: unknown): ReasoningEffort[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const found = new Set<ReasoningEffort>();
  for (const entry of value) {
    const tier = typeof entry === "string" ? entry : (entry as { tier?: unknown } | null)?.tier;
    const level = EFFORT_TIERS.find((candidate) => candidate === tier);
    if (level) {
      found.add(level);
    }
  }
  return EFFORT_TIERS.filter((level) => found.has(level));
}

/**
 * The levels a catalog row lists. Muse 1.4.0 sends `variants` as plain strings; later hosts send
 * `reasoningEffortVariants` as `{ tier }` objects. The literal `"unknown"`, an empty list or no tier the UI offers
 * gives null, which means every level. A tier the UI does not offer (`ultra`) is dropped, and the wire order is
 * not trusted: the result follows the scale.
 */
export function parseEfforts(...candidates: unknown[]): ReasoningEffort[] | null {
  for (const candidate of candidates) {
    const levels = effortList(candidate);
    if (levels.length > 0) {
      return levels;
    }
  }
  return null;
}

/** The slider's stops for a model: the levels it lists, or all of them when it lists none. Never an empty list. */
export function effortLevelsFor<T extends { value: ReasoningEffort }>(
  model: Pick<ModelOption, "efforts"> | null | undefined,
  levels: readonly T[],
): T[] {
  const efforts = model?.efforts;
  if (!efforts || efforts.length === 0) {
    return [...levels];
  }
  const offered = levels.filter((level) => efforts.includes(level.value));
  return offered.length > 0 ? offered : [...levels];
}

/**
 * The level a turn on this model runs at for the level the user wants: the wish itself when the model lists it (or
 * lists none), else the highest level it lists at or below the wish, else its lowest. Auto (null) stays Auto. The
 * stored wish is never rewritten; this is what is shown and sent.
 */
export function effectiveEffort(wish: ReasoningEffort | null, model: Pick<ModelOption, "efforts"> | null | undefined): ReasoningEffort | null {
  const efforts = model?.efforts;
  if (wish === null || !efforts || efforts.length === 0 || efforts.includes(wish)) {
    return wish;
  }
  const rank = (level: ReasoningEffort) => EFFORT_ORDER.indexOf(level);
  const ordered = [...efforts].sort((a, b) => rank(a) - rank(b));
  const below = ordered.filter((level) => rank(level) <= rank(wish));
  return below.length > 0 ? (below[below.length - 1] as ReasoningEffort) : (ordered[0] as ReasoningEffort);
}

/** The slider as one model shows it: its stops, where the thumb rests, and whether the wish had to give way. */
export interface EffortView<T> {
  /** The stops the slider has: the model's levels, or all of them when it lists none. */
  levels: T[];
  /** Muse picks per turn: nothing is chosen. */
  auto: boolean;
  /** The level a turn runs at, which is the wish unless the model lacks it. */
  shown: ReasoningEffort | null;
  /** The thumb's stop; while Auto it rests on `resting`, or on the nearest stop the model has. */
  position: number;
  /** The wish is a level this model does not have, so `shown` is another. */
  clamped: boolean;
}

/**
 * What the effort slider shows for a model. The stored `wish` is never changed: another model that has the level
 * gets it back. An old saved Ultra reads as Max, which is how Muse runs it.
 */
export function effortView<T extends { value: ReasoningEffort }>(
  model: Pick<ModelOption, "efforts"> | null | undefined,
  wish: ReasoningEffort | null,
  all: readonly T[],
  resting: ReasoningEffort = "medium",
): EffortView<T> {
  const levels = effortLevelsFor(model, all);
  const wished = wish === "ultra" ? "max" : wish;
  const shown = effectiveEffort(wished, model);
  const target = shown ?? effectiveEffort(resting, model);
  return {
    levels,
    auto: shown === null,
    shown,
    position: Math.max(0, levels.findIndex((level) => level.value === target)),
    clamped: wished !== null && shown !== wished,
  };
}

/** The line under the slider when the wish had to give way, or null when it did not. `model` names where, when "this model" would not say. */
export function effortNote(wish: ReasoningEffort | null, shown: ReasoningEffort | null, model = "this model"): string | null {
  if (wish === null || shown === null || shown === wish || (wish === "ultra" && shown === "max")) {
    return null;
  }
  return `${effortLabel(wish)} is not available on ${model}. It runs at ${effortLabel(shown)}, and your choice is kept for other models.`;
}
