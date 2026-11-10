import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isIP } from "node:net";

/**
 * Which sites the assistant's browser may open. A site is an origin (scheme, host and port). The first time a task wants
 * one that has no rule, the task waits and the person is asked on the screen; nothing is opened before they answer.
 * `local` origins are the ones that lead into this computer or its network (a dev server, a router, a printer): they are
 * said so in the question and are never allowed by anything but an explicit answer for that exact origin.
 */

export type SiteKind = "public" | "local";
export type SiteDecision = "allow" | "block";
/** The four things a person can answer: allow it for this task, allow it always, not now (this task only), or block it for good. */
export type SiteAnswer = "task" | "always" | "not-now" | "block";
export const SITE_ANSWERS: readonly SiteAnswer[] = ["task", "always", "not-now", "block"];

export interface SiteRule {
  origin: string;
  decision: SiteDecision;
  at: number;
}

export interface SiteQuestion {
  id: string;
  taskId: string;
  origin: string;
  kind: SiteKind;
  at: number;
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
          this.rules.set(rule.origin, { origin: rule.origin, decision: rule.decision, at: typeof rule.at === "number" ? rule.at : 0 });
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

  set(origin: string, decision: SiteDecision): void {
    if (originOf(origin) !== origin) return;
    if (!this.rules.has(origin) && this.rules.size >= MAX_RULES) {
      const oldest = [...this.rules.values()].sort((a, b) => a.at - b.at)[0];
      if (oldest) this.rules.delete(oldest.origin);
    }
    this.rules.set(origin, { origin, decision, at: this.now() });
    this.save();
  }

  remove(origin: string): boolean {
    const had = this.rules.delete(origin);
    if (had) this.save();
    return had;
  }
}

export type SiteCheck = "allow" | "block" | "ask";

interface Waiting {
  question: SiteQuestion;
  waiters: Array<(allowed: boolean) => void>;
}

/**
 * The questions and the grants of the task that is browsing. One question is shown at a time; the others wait behind it and
 * are settled by its answer when they can be. Everything a task was allowed or refused is forgotten when it ends, except the
 * saved rules.
 */
export class SiteGate {
  private readonly grants = new Map<string, Set<string>>();
  private readonly refusals = new Map<string, Set<string>>();
  private queue: Waiting[] = [];
  private idle: Array<{ taskId: string; wake: () => void }> = [];

  constructor(
    readonly rules: SiteRules,
    private readonly options: { onChange?: () => void; now?: () => number } = {},
  ) {}

  /** What the rules and this task's answers say about an origin, without asking anyone. */
  check(taskId: string, origin: string): SiteCheck {
    const rule = this.rules.get(origin);
    if (rule?.decision === "block") return "block";
    if (this.refusals.get(taskId)?.has(origin)) return "block";
    if (rule?.decision === "allow") return "allow";
    if (this.grants.get(taskId)?.has(origin)) return "allow";
    return "ask";
  }

  /** The question the person is looking at, or null. */
  pending(): SiteQuestion | null {
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
      const same = this.queue.find((w) => w.question.taskId === taskId && w.question.origin === origin);
      if (same) {
        same.waiters.push(done);
        return;
      }
      const question: SiteQuestion = { id: `sq_${randomBytes(6).toString("hex")}`, taskId, origin, kind: kindOfOrigin(origin), at: (this.options.now ?? Date.now)() };
      this.queue.push({ question, waiters: [done] });
      this.changed();
    });
  }

  /** The person's answer to the question on the screen. Throws when there is none, or it is not the one shown. */
  answer(questionId: string, answer: SiteAnswer): void {
    const head = this.queue[0];
    if (!head || head.question.id !== questionId) throw new Error("That question is not waiting any more.");
    const { taskId, origin } = head.question;
    let allowed = false;
    if (answer === "task") {
      this.set(this.grants, taskId, origin);
      allowed = true;
    } else if (answer === "always") {
      this.rules.set(origin, "allow");
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
      this.set(this.refusals, taskId, entry.question.origin);
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
    this.refusals.delete(taskId);
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

  constructor(
    file: string | null,
    private readonly source: () => BrowseTaskSource,
  ) {
    this.rules = new SiteRules(file);
    this.gate = new SiteGate(this.rules, { onChange: () => this.source().gateChanged() });
  }

  async decide(request: { url: string; origin: string; tabId: string; mainFrame: boolean }): Promise<boolean> {
    const taskId = this.source().taskId();
    if (!request.mainFrame) {
      const rule = this.rules.get(request.origin)?.decision;
      if (rule === "block") return false;
      if (kindOfOrigin(request.origin) === "public") return true;
      return rule === "allow" || (taskId !== null && this.gate.check(taskId, request.origin) === "allow");
    }
    if (taskId === null) return false;
    return this.gate.request(taskId, request.url);
  }
}
