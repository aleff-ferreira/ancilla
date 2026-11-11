import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isIP } from "node:net";
import { describeRequest, type ActionAsk, type ShownField } from "./commit.js";

/**
 * Which sites the assistant's browser may open. A site is an origin (scheme, host and port). The first time a task wants
 * one that has no rule, the task waits and the person is asked on the screen; nothing is opened before they answer.
 * `local` origins are the ones that lead into this computer or its network (a dev server, a router, a printer): they are
 * said so in the question and are never allowed by anything but an explicit answer for that exact origin.
 */

export type SiteKind = "public" | "local";
export type SiteDecision = "allow" | "block";
/** The answers a person can give: allow for this task (with or without sign-in), allow always (with or without sign-in), not now, or block. */
export type SiteAnswer = "task" | "task-signed-in" | "always" | "always-signed-in" | "not-now" | "block";
export const SITE_ANSWERS: readonly SiteAnswer[] = ["task", "task-signed-in", "always", "always-signed-in", "not-now", "block"];

export interface SiteRule {
  origin: string;
  decision: SiteDecision;
  at: number;
  /** When true on an allowed origin, cookies for this origin from the persistent Browser profile are shared with the assistant's tab. */
  useSignIn?: boolean;
}

export interface SiteQuestion {
  type: "site";
  id: string;
  taskId: string;
  origin: string;
  kind: SiteKind;
  at: number;
}

/** An action the person is asked to allow: what is about to happen, on which page, and what will be sent. */
export interface ActionQuestion extends ActionAsk {
  type: "action";
  id: string;
  taskId: string;
  kind: SiteKind;
  at: number;
}

export type GateQuestion = SiteQuestion | ActionQuestion;

/** The two answers to an action: do it, or not. Nothing is remembered. */
export type ActionAnswer = "do" | "dont";
export const ACTION_ANSWERS: readonly ActionAnswer[] = ["do", "dont"];

/** A question as a screen is shown it: no ids, only what the person needs to decide. */
export type QuestionView =
  | { type: "site"; origin: string; kind: SiteKind }
  | {
      type: "action";
      origin: string;
      kind: SiteKind;
      page: string;
      what: string;
      fields: ShownField[];
      note?: string;
      download?: NonNullable<ActionAsk["download"]>;
      upload?: { id: string; multiple: boolean; folder: string };
    };

export function questionView(question: GateQuestion): QuestionView {
  return question.type === "action"
    ? {
        type: "action",
        origin: question.origin,
        kind: question.kind,
        page: question.page,
        what: question.what,
        fields: question.fields,
        ...(question.note ? { note: question.note } : {}),
        ...(question.download ? { download: { ...question.download } } : {}),
        ...(question.upload ? { upload: { id: question.upload.id, multiple: question.upload.multiple, folder: question.upload.folder } } : {}),
      }
    : { type: "site", origin: question.origin, kind: question.kind };
}

/** `https://example.com` or `http://localhost:5173`; null for anything that is not an http(s) address. */
export function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

const LOCAL_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa"];

/** Whether a host name or address leads into this computer or its network. A name that only resolves there (DNS) cannot be told here. */
export function hostKind(hostname: string): SiteKind {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "local";
  const family = isIP(host);
  if (family === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    const local = a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    return local ? "local" : "public";
  }
  if (family === 6) return host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:") ? "local" : "public";
  // A name with no dot ("router", "nas") is looked up on the local network.
  return host.includes(".") ? "public" : "local";
}

export function kindOfOrigin(origin: string): SiteKind {
  try {
    return hostKind(new URL(origin).hostname);
  } catch {
    return "public";
  }
}

/**
 * Consumer and social Meta domains fenced off from automated `assistant` browsing and `you` -> `assistant` cookie sharing.
 * The user's own `you` Browser panel never consults this gate and remains unrestricted.
 */
export const RESTRICTED_ASSISTANT_DOMAINS: readonly string[] = [
  "facebook.com",
  "fb.com",
  "fbsbx.com",
  "messenger.com",
  "instagram.com",
  "cdninstagram.com",
  "whatsapp.com",
  "whatsapp.net",
  "threads.net",
  "threads.com",
  "meta.ai",
];

export function isRestrictedAssistantHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "") return false;
  return RESTRICTED_ASSISTANT_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function isRestrictedAssistantOrigin(origin: string): boolean {
  const normalized = originOf(origin);
  if (!normalized) return false;
  try {
    return isRestrictedAssistantHost(new URL(normalized).hostname);
  } catch {
    return false;
  }
}

export function isRestrictedAssistantUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const origin = originOf(candidate);
  return origin !== null && isRestrictedAssistantOrigin(origin);
}

const MAX_RULES = 500;

/** The saved rules: Always allow and Block. One small file; a file that is missing or unreadable means no rules. */
export class SiteRules {
  private readonly rules = new Map<string, SiteRule>();

  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { rules?: unknown };
      for (const item of Array.isArray(parsed.rules) ? parsed.rules : []) {
        const rule = item as Partial<SiteRule>;
        if (typeof rule.origin === "string" && originOf(rule.origin) === rule.origin && (rule.decision === "allow" || rule.decision === "block")) {
          if (rule.decision === "allow" && isRestrictedAssistantOrigin(rule.origin)) continue;
          this.rules.set(rule.origin, {
            origin: rule.origin,
            decision: rule.decision,
            at: typeof rule.at === "number" ? rule.at : 0,
            ...(rule.decision === "allow" && rule.useSignIn === true ? { useSignIn: true } : {}),
          });
        }
      }
    } catch {
      // no file yet, or one that cannot be read: no rules
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, rules: this.list() }, null, 2), "utf8");
      renameSync(temp, this.file);
    } catch {
      // the rule still holds for this run
    }
  }

  list(): SiteRule[] {
    return [...this.rules.values()].sort((a, b) => a.origin.localeCompare(b.origin));
  }

  get(origin: string): SiteRule | null {
    return this.rules.get(origin) ?? null;
  }

  set(origin: string, decision: SiteDecision, useSignIn = false): void {
    if (originOf(origin) !== origin) return;
    if (decision === "allow" && isRestrictedAssistantOrigin(origin)) return;
    if (!this.rules.has(origin) && this.rules.size >= MAX_RULES) {
      const oldest = [...this.rules.values()].sort((a, b) => a.at - b.at)[0];
      if (oldest) this.rules.delete(oldest.origin);
    }
    this.rules.set(origin, {
      origin,
      decision,
      at: this.now(),
      ...(decision === "allow" && useSignIn ? { useSignIn: true } : {}),
    });
    this.save();
  }

  /** Switches persistent signed-in cookie sharing on or off for an already-allowed origin. */
  setSignIn(origin: string, useSignIn: boolean): boolean {
    if (isRestrictedAssistantOrigin(origin)) return false;
    const existing = this.rules.get(origin);
    if (!existing || existing.decision !== "allow") return false;
    this.rules.set(origin, {
      origin: existing.origin,
      decision: "allow",
      at: this.now(),
      ...(useSignIn ? { useSignIn: true } : {}),
    });
    this.save();
    return true;
  }

  remove(origin: string): boolean {
    const had = this.rules.delete(origin);
    if (had) this.save();
    return had;
  }
}

export type SiteCheck = "allow" | "block" | "ask";

interface Waiting {
  question: GateQuestion;
  waiters: Array<(allowed: boolean) => void>;
}

/** An approved click stays good for the form it sends, and for no longer than this. */
const APPROVAL_MS = 20_000;

/**
 * The questions and the grants of the task that is browsing. One question is shown at a time; the others wait behind it and
 * are settled by its answer when they can be. Everything a task was allowed or refused is forgotten when it ends, except the
 * saved rules.
 */
export class SiteGate {
  private readonly grants = new Map<string, Set<string>>();
  private readonly signedInGrants = new Map<string, Set<string>>();
  private readonly refusals = new Map<string, Set<string>>();
  private queue: Waiting[] = [];
  /** The task whose last approved click may send its own form without a second question, and until when. */
  private approval: { taskId: string; until: number } | null = null;
  private idle: Array<{ taskId: string; wake: () => void }> = [];

  constructor(
    readonly rules: SiteRules,
    private readonly options: { onChange?: () => void; now?: () => number } = {},
  ) {}

  /** What the rules and this task's answers say about an origin, without asking anyone. */
  check(taskId: string, origin: string): SiteCheck {
    if (isRestrictedAssistantOrigin(origin)) return "block";
    const rule = this.rules.get(origin);
    if (rule?.decision === "block") return "block";
    if (this.refusals.get(taskId)?.has(origin)) return "block";
    if (rule?.decision === "allow") return "allow";
    if (this.grants.get(taskId)?.has(origin)) return "allow";
    return "ask";
  }

  /** Whether `origin` is both allowed for `taskId` and explicitly approved to use cookies from the user's persistent Browser sign-in. */
  usesSignIn(taskId: string, origin: string): boolean {
    if (isRestrictedAssistantOrigin(origin) || this.check(taskId, origin) !== "allow") return false;
    if (this.rules.get(origin)?.useSignIn === true) return true;
    return this.signedInGrants.get(taskId)?.has(origin) === true;
  }

  /** The question the person is looking at, or null. */
  pending(): GateQuestion | null {
    return this.queue[0]?.question ?? null;
  }

  /** Whether `taskId` has a question waiting (shown or queued). */
  waiting(taskId: string): boolean {
    return this.queue.some((w) => w.question.taskId === taskId);
  }

  /** Resolves when no question about `taskId` is waiting: at once when none is, else when the last one is answered or the task ends. */
  settled(taskId: string, signal?: AbortSignal): Promise<void> {
    if (!this.waiting(taskId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const entry = {
        taskId,
        wake: (): void => {
          signal?.removeEventListener("abort", entry.wake);
          this.idle = this.idle.filter((e) => e !== entry);
          resolve();
        },
      };
      signal?.addEventListener("abort", entry.wake, { once: true });
      this.idle.push(entry);
    });
  }

  /** Resolves true when the site may be opened for this task: at once when a rule or an earlier answer says so, else when the person answers. */
  request(taskId: string, url: string, signal?: AbortSignal): Promise<boolean> {
    const origin = originOf(url);
    if (!origin) return Promise.resolve(false);
    const verdict = this.check(taskId, origin);
    if (verdict !== "ask") return Promise.resolve(verdict === "allow");
    return this.enqueue(taskId, signal, (at) => ({ type: "site", id: this.newId(), taskId, origin, kind: kindOfOrigin(origin), at }), (w) => w.question.type === "site" && w.question.origin === origin);
  }

  /**
   * Asks the person to allow one action. Every action asks, each time: nothing is remembered and no rule can settle it. Resolves
   * true only when they answer "do"; no answer in time, a stop, or the task ending is no.
   */
  ask(taskId: string, ask: ActionAsk, signal?: AbortSignal): Promise<boolean> {
    return this.enqueue(taskId, signal, (at) => ({ ...ask, type: "action", id: this.newId(), taskId, kind: kindOfOrigin(ask.origin), at }), null);
  }

  /** Records that the click just approved may send the form it is in, once. */
  approved(taskId: string): void {
    this.approval = { taskId, until: (this.options.now ?? Date.now)() + APPROVAL_MS };
  }

  /** Whether the last approved click of `taskId` covers the form being sent now. Used once. */
  takeApproval(taskId: string): boolean {
    const approval = this.approval;
    this.approval = null;
    return approval !== null && approval.taskId === taskId && approval.until > (this.options.now ?? Date.now)();
  }

  /** The approved click has done what it was approved for: it no longer covers anything. */
  endApproval(): void {
    this.approval = null;
  }

  private newId(): string {
    return `sq_${randomBytes(6).toString("hex")}`;
  }

  private enqueue(taskId: string, signal: AbortSignal | undefined, make: (at: number) => GateQuestion, same: ((w: Waiting) => boolean) | null): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (allowed: boolean): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(allowed);
      };
      const onAbort = (): void => {
        const at = this.queue.findIndex((w) => w.waiters.includes(done));
        const entry = at >= 0 ? this.queue[at] : undefined;
        if (entry) {
          entry.waiters = entry.waiters.filter((w) => w !== done);
          if (entry.waiters.length === 0) this.queue.splice(at, 1);
          this.changed();
        }
        done(false);
      };
      if (signal?.aborted) return done(false);
      signal?.addEventListener("abort", onAbort, { once: true });
      const existing = same ? this.queue.find((w) => w.question.taskId === taskId && same(w)) : undefined;
      if (existing) {
        existing.waiters.push(done);
        return;
      }
      this.queue.push({ question: make((this.options.now ?? Date.now)()), waiters: [done] });
      this.changed();
    });
  }

  /** The person's answer to the question on the screen. Throws when there is none, or it is not the one shown, or the answer is for the other kind. */
  answer(questionId: string, answer: SiteAnswer | ActionAnswer): void {
    const head = this.queue[0];
    if (!head || head.question.id !== questionId) throw new Error("That question is not waiting any more.");
    const { taskId, origin } = head.question;
    let allowed = false;
    if (head.question.type === "action") {
      if (answer !== "do" && answer !== "dont") throw new Error("That question is about an action: answer do or dont.");
      allowed = answer === "do";
    } else if (answer === "do" || answer === "dont") {
      throw new Error("That question is about a site, not an action.");
    } else if (answer === "task") {
      this.set(this.grants, taskId, origin);
      allowed = true;
    } else if (answer === "task-signed-in") {
      this.set(this.grants, taskId, origin);
      this.set(this.signedInGrants, taskId, origin);
      allowed = true;
    } else if (answer === "always") {
      this.rules.set(origin, "allow", false);
      allowed = true;
    } else if (answer === "always-signed-in") {
      this.rules.set(origin, "allow", true);
      allowed = true;
    } else if (answer === "not-now") {
      this.set(this.refusals, taskId, origin);
    } else {
      this.rules.set(origin, "block");
    }
    this.queue.shift();
    for (const wake of head.waiters) wake(allowed);
    this.settleQueued();
    this.changed();
  }

  /** Nobody answered in time: the task's questions are refused for this task, and what it was allowed stays. */
  expire(taskId: string): void {
    const gone = this.queue.filter((w) => w.question.taskId === taskId);
    if (gone.length === 0) return;
    this.queue = this.queue.filter((w) => w.question.taskId !== taskId);
    for (const entry of gone) {
      if (entry.question.type === "site") this.set(this.refusals, taskId, entry.question.origin);
      for (const wake of entry.waiters) wake(false);
    }
    this.settleQueued();
    this.changed();
  }

  /** The task is over: its questions are refused and its grants forgotten. */
  end(taskId: string): void {
    const gone = this.queue.filter((w) => w.question.taskId === taskId);
    this.queue = this.queue.filter((w) => w.question.taskId !== taskId);
    for (const entry of gone) for (const wake of entry.waiters) wake(false);
    this.grants.delete(taskId);
    this.signedInGrants.delete(taskId);
    this.refusals.delete(taskId);
    if (this.approval?.taskId === taskId) this.approval = null;
    if (gone.length > 0) this.changed();
  }

  private set(map: Map<string, Set<string>>, taskId: string, origin: string): void {
    const set = map.get(taskId) ?? new Set<string>();
    set.add(origin);
    map.set(taskId, set);
  }

  /** Questions behind the one just answered that the answer (or a rule) now decides are settled without bothering anyone. */
  private settleQueued(): void {
    for (let i = 0; i < this.queue.length; ) {
      const entry = this.queue[i] as Waiting;
      if (entry.question.type === "action") {
        i += 1;
        continue;
      }
      const verdict = this.check(entry.question.taskId, entry.question.origin);
      if (verdict === "ask") {
        i += 1;
        continue;
      }
      this.queue.splice(i, 1);
      for (const wake of entry.waiters) wake(verdict === "allow");
    }
  }

  private changed(): void {
    for (const entry of [...this.idle]) if (!this.waiting(entry.taskId)) entry.wake();
    try {
      this.options.onChange?.();
    } catch {
      // a listener that throws must not stop the gate
    }
  }
}

/** What the browser's gate needs to know of the task that is browsing. */
export interface BrowseTaskSource {
  /** The task being worked on, or null when none is. */
  taskId(): string | null;
  /** The questions changed. */
  gateChanged(): void;
}

/**
 * The saved rules and the questions, with the one function the browser asks about every page the assistant's tabs would load.
 * A page the task goes to waits for the person; a frame inside a page loads unless it leads into this computer or its network,
 * which only a rule or an answer for that exact origin allows. With no task browsing, nothing loads.
 */
export class BrowseSites {
  readonly rules: SiteRules;
  readonly gate: SiteGate;
  private readonly sessionGrants = new Set<string>();

  constructor(
    file: string | null,
    private readonly source: () => BrowseTaskSource,
  ) {
    this.rules = new SiteRules(file);
    this.gate = new SiteGate(this.rules, { onChange: () => this.source().gateChanged() });
  }

  /** Grants `origin` for this server run after explicit user authorization (or standing YOLO authorization). */
  grantSessionOrigin(origin: string): void {
    const normalized = originOf(origin);
    if (!normalized || isRestrictedAssistantOrigin(normalized)) return;
    this.sessionGrants.add(normalized);
  }

  isAllowedNow(origin: string): boolean {
    if (isRestrictedAssistantOrigin(origin)) return false;
    return this.sessionGrants.has(origin) || this.rules.get(origin)?.decision === "allow";
  }

  async decide(request: { url: string; origin: string; tabId: string; mainFrame: boolean }): Promise<boolean> {
    if (isRestrictedAssistantOrigin(request.origin) || isRestrictedAssistantUrl(request.url)) return false;
    if (this.sessionGrants.has(request.origin)) return true;
    const taskId = this.source().taskId();
    if (!request.mainFrame) {
      const rule = this.rules.get(request.origin)?.decision;
      if (rule === "block") return false;
      if (kindOfOrigin(request.origin) === "public") return true;
      return rule === "allow" || (taskId !== null && this.gate.check(taskId, request.origin) === "allow");
    }
    if (taskId === null) return this.rules.get(request.origin)?.decision === "allow";
    return this.gate.request(taskId, request.url);
  }

  /** Whether `request.origin` was explicitly granted signed-in cookie sharing for the active web task. */
  shouldShareSignIn(request: { url: string; origin: string; tabId: string; mainFrame: boolean }): boolean {
    if (isRestrictedAssistantOrigin(request.origin) || isRestrictedAssistantUrl(request.url)) return false;
    const taskId = this.source().taskId();
    if (taskId === null) return false;
    return this.gate.usesSignIn(taskId, request.origin);
  }

  /**
   * A download the assistant's page started has finished and is staged. The person is asked, and the answer carries the folder
   * THEY chose (the assistant never names one). Resolves the folder, or null for "don't save" or no task browsing.
   */
  async decideDownload(request: { name: string; size: number | null; origin: string; page: string; folder: string; warning: string | null }): Promise<string | null> {
    const taskId = this.source().taskId();
    if (taskId === null) return null;
    const download = { id: `dl_${randomBytes(4).toString("hex")}`, name: request.name, size: request.size, folder: request.folder, warning: request.warning };
    const ok = await this.gate.ask(taskId, { origin: request.origin, page: request.page, what: `Save the file “${request.name}”`, fields: [], download });
    return ok ? download.folder : null;
  }

  /**
   * A page in the assistant's browser opened a file chooser (`<input type="file">`). The assistant never names local paths;
   * the person chooses the file(s) on the screen (or declines). Resolves the chosen paths, or null when cancelled or no task runs.
   */
  async decideUpload(request: { multiple: boolean; origin: string; page: string; folder: string }): Promise<string[] | null> {
    const taskId = this.source().taskId();
    if (taskId === null) return null;
    const upload: NonNullable<ActionAsk["upload"]> = {
      id: `up_${randomBytes(4).toString("hex")}`,
      multiple: request.multiple,
      folder: request.folder,
    };
    const what = request.multiple ? "Choose files to upload to this page" : "Choose a file to upload to this page";
    const ok = await this.gate.ask(taskId, { origin: request.origin, page: request.page, what, fields: [], upload });
    return ok && Array.isArray(upload.files) && upload.files.length > 0 ? upload.files : null;
  }

  /**
   * A page is about to send a form (a request that is not a plain GET). It leaves only when the person says so, every time: no
   * rule settles it. The one exception is the form of a click they have just approved, which they were shown. With no task
   * browsing, nothing is sent.
   */
  async decideCommit(request: { url: string; method: string; title: string; contentType: string; body: string | undefined; secrets: readonly string[] | null }): Promise<boolean> {
    const taskId = this.source().taskId();
    if (taskId === null) return false;
    if (this.gate.takeApproval(taskId)) return true;
    return this.gate.ask(taskId, describeRequest(request));
  }
}
