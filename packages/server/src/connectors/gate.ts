import { createHash, randomBytes } from "node:crypto";
import { ConflictError, ValidationError } from "../assistant/store.js";
import { maskArgs, type AuditLog, type WritePhase } from "./audit.js";
import { redact, type Target, type WriteClass } from "./manifest.js";

/**
 * The gate a change to a connected account goes through. A tool that changes something is HELD: the person sees a card built
 * from the call itself (the account, the tool and every argument, whole), and the call reaches the account only with a recorded
 * approval for exactly those arguments. The approval is bound to a hash of them, is good once, and lapses after ten minutes, so
 * any change asks again. The model's own account of what it is doing is never shown: it can be wrong, or written by a stranger.
 *
 * Two more rules live here because they are the same wall. A task that has read text a stranger can write (an issue, a comment)
 * is tainted, and the card says so and carries flags that code worked out (a target the person never named, a link they did not
 * write, a key, text copied from another item). And a task nobody started in person (a schedule, something that arrived) may not
 * change anything: what it wants becomes a proposal that waits for the person, and runs only when they approve that very card.
 */

/** Who started a task: the person (by voice, or from the box on the Connectors page), or something else with no one there to look. */
export type Trigger = "person" | "schedule" | "incoming";

export const APPROVAL_MS = 10 * 60_000;
export const PROPOSAL_MS = 24 * 60 * 60_000;
export const MAX_PROPOSALS = 5;
/** The longest text the card shows whole. A change whose text is longer is not sent, because what is approved must be what the person could read. */
export const VALUE_MAX = 8000;
export const ARGS_MAX = 20_000;

// ------------------------------------------------------------------------------------------------------------------- the hash

/** The arguments as one text that is the same whatever order the keys came in. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** What an approval is bound to: the connector, the tool and every argument. */
export function hashOf(connector: string, tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(canonical({ connector, tool, args })).digest("hex");
}

/** A copy of the arguments that holds plain data only: this copy is what is shown, hashed and sent. */
export function detach(args: unknown): Record<string, unknown> {
  try {
    const copy = JSON.parse(JSON.stringify(args ?? {})) as unknown;
    return typeof copy === "object" && copy !== null && !Array.isArray(copy) ? (copy as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringsOf(value: unknown, depth = 0, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (depth < 6 && Array.isArray(value)) for (const item of value) stringsOf(item, depth + 1, out);
  else if (depth < 6 && typeof value === "object" && value !== null) for (const item of Object.values(value)) stringsOf(item, depth + 1, out);
  return out;
}

/** Why a call cannot be put to the person, or null: what is too long to be read whole is not sent. */
export function argsProblem(args: Record<string, unknown>): string | null {
  if ((JSON.stringify(args) ?? "").length > ARGS_MAX) return `the arguments are longer than ${ARGS_MAX} characters, more than the approval can show whole`;
  if (stringsOf(args).some((text) => text.length > VALUE_MAX)) return `a text is longer than ${VALUE_MAX} characters, more than the approval can show whole. Make it shorter`;
  return null;
}

// ------------------------------------------------------------------------------------------------------------------ the card

export interface CardField {
  name: string;
  value: string;
}

export type FlagCode = "stranger-text" | "not-named" | "link" | "secret" | "copied" | "hidden-characters";

/** Something the person should look at before saying yes, worked out by code and not by the model. */
export interface Flag {
  code: FlagCode;
  text: string;
}

/** What a screen is shown of a change that waits: never the arguments object itself, only their text. */
export interface WriteCard {
  id: string;
  taskId: string | null;
  connector: string;
  connectorName: string;
  tool: string;
  class: WriteClass;
  /** What the tool does, in our words. */
  what: string;
  /** What it is about, in words ("aleff-ferreira/ancilla #12"), when the tool says. */
  target: string | null;
  fields: CardField[];
  flags: Flag[];
  /** The hash the approval is bound to, whole. */
  hash: string;
  at: number;
  expiresAt: number;
  /** Whether "always" may be answered: a reversible change, after a first yes, in a task that has read nothing a stranger wrote. */
  offerAlways: boolean;
  /** Nobody was there when it was asked for: it waits for the person with no task to hold. */
  proposal: boolean;
}

// eslint-disable-next-line no-control-regex
const HIDDEN = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\ufeff]", "g");

/** The same characters, for a test with no state (a global expression remembers where it was). */
const HAS_HIDDEN = new RegExp(HIDDEN.source);

/** Every argument as the person reads it, whole; a character that cannot be seen is shown as a mark so that it is not hidden. */
export function cardFields(args: Record<string, unknown>): CardField[] {
  return Object.entries(args).map(([name, value]) => ({
    name: name.replace(HIDDEN, "�").slice(0, 80),
    value: (typeof value === "string" ? value : (JSON.stringify(value) ?? "")).replace(HIDDEN, "�"),
  }));
}

/** The reason a task shows while its change waits for the person. */
export function reasonOf(card: Pick<WriteCard, "what" | "target" | "connectorName">): string {
  return `Waiting for your approval: ${card.what.replace(/\.$/, "")}${card.target ? ` (${card.target})` : ""} on ${card.connectorName}.`;
}

// ------------------------------------------------------------------------------------------------------- what was read, and flags

function plain(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const COPY_MIN = 40;
const COPY_STEP = 20;
const CHUNKS_MAX = 24;
const CHUNK_MAX = 8000;

/**
 * What a task has read: whether it read anything a stranger could have written, and the text, by item, so that a change can be
 * checked against it. Kept for one task and forgotten with it.
 */
export class ReadLog {
  private stranger = false;
  private chunks: Array<{ item: string | null; text: string }> = [];

  /** Whether the task has read text that a stranger can write. */
  get tainted(): boolean {
    return this.stranger;
  }

  /** `own`: what the tool returns is what nobody else could have written. `item`: what it was about, when it was one item. */
  record(own: boolean, item: string | null, text: string): void {
    if (!own) this.stranger = true;
    this.chunks.push({ item, text: plain(text).slice(0, CHUNK_MAX) });
    if (this.chunks.length > CHUNKS_MAX) this.chunks.shift();
  }

  /** The item whose text `text` copies a stretch of (and that is not `item`, and is not the person's own words), or null. */
  copiedFrom(text: string, item: string, goal: string): string | null {
    const body = plain(text);
    if (body.length < COPY_MIN) return null;
    const mine = this.chunks.filter((chunk) => chunk.item === item).map((chunk) => chunk.text);
    for (let at = 0; at + COPY_MIN <= body.length; at += COPY_STEP) {
      const window = body.slice(at, at + COPY_MIN);
      if (goal.includes(window) || mine.some((m) => m.includes(window))) continue;
      const other = this.chunks.find((chunk) => chunk.item !== null && chunk.item !== item && chunk.text.includes(window));
      if (other) return other.item;
    }
    return null;
  }
}

const LINK = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gi;

function linksIn(text: string): string[] {
  return (text.match(LINK) ?? []).map((link) => link.toLowerCase().replace(/[.,;:!?)\]}]+$/, ""));
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether the person's own words hold this spelling of a name or a number, as a word of its own. */
function mentions(goal: string, spelling: string): boolean {
  const wanted = plain(spelling);
  if (wanted === "") return false;
  return new RegExp(`(?<![\\w/-])${escaped(wanted)}(?![\\w-])`).test(goal);
}

export interface FlagInput {
  args: Record<string, unknown>;
  target: Target | null;
  /** What the person asked for, in their words: the only text in the task that is theirs. */
  goal: string;
  reads: ReadLog;
  /** Secrets that are known and must not appear (the connector's own token). */
  known: readonly string[];
}

/** What to look at before saying yes. The order is the order of importance: where the text came from first. */
export function computeFlags(input: FlagInput): Flag[] {
  const flags: Flag[] = [];
  const goal = plain(input.goal);
  const texts = stringsOf(input.args);
  if (input.reads.tainted) {
    flags.push({ code: "stranger-text", text: "This task has read text that other people can write (issues, comments, pull requests). Check that this is what you asked for, and not what that text asked for." });
  }
  if (input.target) {
    const unnamed = input.target.parts.filter((part) => !part.accepts.some((spelling) => mentions(goal, spelling)));
    if (unnamed.length > 0) flags.push({ code: "not-named", text: `You did not name ${unnamed.map((part) => part.shown).join(" or ")} in what you asked.` });
  }
  const links = [...new Set(texts.flatMap(linksIn))].filter((link) => !goal.includes(link) && !goal.includes(link.replace(/^https?:\/\//, ""))).slice(0, 4);
  if (links.length > 0) flags.push({ code: "link", text: `The text has a link or an address that you did not write: ${links.join(", ")}.` });
  if (texts.some((text) => redact(text, input.known) !== text)) flags.push({ code: "secret", text: "The text holds something shaped like a key, a token or a password." });
  const item = input.target?.item ?? null;
  if (item !== null) {
    const other = input.reads.copiedFrom(texts.join("\n"), item, goal);
    if (other !== null) flags.push({ code: "copied", text: `The text copies words from ${other}, which is not the one it answers (${item}).` });
  }
  if (texts.some((text) => HAS_HIDDEN.test(text))) flags.push({ code: "hidden-characters", text: "The text holds characters that cannot be seen, shown here as a mark." });
  return flags;
}

// ---------------------------------------------------------------------------------------------------------- approvals and holds

/** The handle of an approval. What it is worth is in the gate's own record: a made-up one is worth nothing. */
export interface Approval {
  readonly id: string;
}

/** What a change is sent with: made only by the gate, for exactly one connector, tool and set of arguments. */
export class Permit {
  private constructor(
    readonly connector: string,
    readonly tool: string,
    readonly hash: string,
  ) {}

  /** Only the gate calls this, from `redeem`. */
  static issue(connector: string, tool: string, hash: string): Permit {
    return new Permit(connector, tool, hash);
  }

  matches(connector: string, tool: string, args: Record<string, unknown>): boolean {
    return this.connector === connector && this.tool === tool && this.hash === hashOf(connector, tool, args);
  }
}

export type Answer = "do" | "dont" | "always";

export type Verdict = { allowed: true; approval: Approval; always: boolean } | { allowed: false; why: "dont" | "expired" | "ended" };

export interface HoldInput {
  taskId: string | null;
  connector: string;
  connectorName: string;
  tool: string;
  cls: WriteClass;
  /** What the tool does, in our words. */
  what: string;
  /** The arguments, detached: exactly what will be sent. */
  args: Record<string, unknown>;
  target: Target | null;
  flags: Flag[];
  offerAlways: boolean;
}

export type Redeemed = { ok: true; permit: Permit } | { ok: false; why: string };

interface Held {
  card: WriteCard;
  args: Record<string, unknown>;
  resolve: (verdict: Verdict) => void;
  cleanup: () => void;
}

interface Approved {
  hash: string;
  connector: string;
  tool: string;
  expiresAt: number;
}

export class WriteGate {
  private readonly held = new Map<string, Held>();
  private readonly proposed = new Map<string, { card: WriteCard; args: Record<string, unknown> }>();
  /** What was approved and not yet used. Once an approval is used, or lapses, it is gone. */
  private readonly approvals = new Map<string, Approved>();

  constructor(private readonly deps: { audit: AuditLog; now?: () => number }) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private id(prefix: string): string {
    return `${prefix}_${randomBytes(6).toString("hex")}`;
  }

  private note(card: Pick<WriteCard, "connector" | "taskId" | "tool" | "hash">, args: Record<string, unknown>, phase: WritePhase, ok: boolean, note?: string): void {
    this.deps.audit.add({ at: this.now(), kind: "write", connector: card.connector, task: card.taskId, tool: card.tool, args: maskArgs(args), hash: card.hash, phase, ok, ...(note !== undefined ? { note } : {}) });
  }

  private card(input: HoldInput, proposal: boolean): WriteCard {
    const at = this.now();
    return {
      id: this.id(proposal ? "wp" : "wq"),
      taskId: input.taskId,
      connector: input.connector,
      connectorName: input.connectorName,
      tool: input.tool,
      class: input.cls,
      what: input.what,
      target: input.target?.label ?? null,
      fields: cardFields(input.args),
      flags: input.flags,
      hash: hashOf(input.connector, input.tool, input.args),
      at,
      expiresAt: at + (proposal ? PROPOSAL_MS : APPROVAL_MS),
      offerAlways: input.offerAlways && !proposal,
      proposal,
    };
  }

  // ------------------------------------------------------------------------------------------------ a change that waits in a task

  /** Puts the change to the person and waits. Resolves allowed only when they say yes; no answer in time, a no, or the task ending is a refusal. */
  hold(input: HoldInput, signal?: AbortSignal): Promise<Verdict> {
    return new Promise<Verdict>((resolve) => {
      const card = this.card(input, false);
      if (signal?.aborted) {
        this.note(card, input.args, "refused", false, "the task ended");
        resolve({ allowed: false, why: "ended" });
        return;
      }
      const timer = setTimeout(() => this.sweep(), APPROVAL_MS + 50);
      timer.unref();
      const onAbort = (): void => this.settle(card.id, { allowed: false, why: "ended" }, "refused", "the task ended");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.held.set(card.id, {
        card,
        args: input.args,
        resolve,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      });
      this.note(card, input.args, "held", true);
    });
  }

  private settle(cardId: string, verdict: Verdict, phase: WritePhase, note: string): void {
    const entry = this.held.get(cardId);
    if (!entry) return;
    this.held.delete(cardId);
    entry.cleanup();
    this.note(entry.card, entry.args, phase, phase === "approved", note);
    entry.resolve(verdict);
  }

  /** The change a task is waiting on now, or null. */
  question(taskId: string): WriteCard | null {
    for (const { card } of this.held.values()) if (card.taskId === taskId) return card;
    return null;
  }

  /** The person's answer to a card. Throws when it is not waiting (answered, expired, or its task ended). */
  answer(cardId: string, answer: unknown): void {
    const entry = this.held.get(cardId);
    if (!entry) throw new ConflictError("That change is not waiting any more.");
    if (answer !== "do" && answer !== "dont" && answer !== "always") throw new ValidationError("answer", "answer must be do, dont or always");
    if (entry.card.expiresAt <= this.now()) {
      this.settle(cardId, { allowed: false, why: "expired" }, "expired", "no answer in time");
      throw new ConflictError("That question expired, so nothing was done. The assistant has to ask again.");
    }
    if (answer === "always" && !entry.card.offerAlways) throw new ValidationError("answer", "That kind of change cannot be allowed for good here.");
    if (answer === "dont") {
      this.settle(cardId, { allowed: false, why: "dont" }, "refused", "the person said no");
      return;
    }
    const approval = this.approve(entry.card);
    this.settle(cardId, { allowed: true, approval, always: answer === "always" }, "approved", answer === "always" ? "approved, and always for this kind of change" : "approved");
  }

  /** The task is over: what it still had waiting is refused. */
  end(taskId: string): void {
    for (const { card } of [...this.held.values()]) if (card.taskId === taskId) this.settle(card.id, { allowed: false, why: "ended" }, "refused", "the task ended");
  }

  /** A reversible change the person allowed for good: no card, but still an approval bound to these arguments, and written down. */
  standing(input: HoldInput): Approval {
    const card = this.card(input, false);
    const approval = this.approve(card);
    this.note(card, input.args, "approved", true, "standing rule: reversible changes are allowed here");
    return approval;
  }

  private approve(card: Pick<WriteCard, "hash" | "connector" | "tool">): Approval {
    const id = this.id("ap");
    this.approvals.set(id, { hash: card.hash, connector: card.connector, tool: card.tool, expiresAt: this.now() + APPROVAL_MS });
    return { id };
  }

  // ---------------------------------------------------------------------------------------------------------------- the door

  /**
   * Spends an approval on the call about to be sent. It must be one this gate gave, not used and not lapsed, and the connector,
   * tool and arguments must hash to what the person was shown. Anything else is refused and written down, and a mismatch burns
   * the approval: the arguments are not allowed to change between the card and the call.
   */
  redeem(approval: Approval, call: { connector: string; tool: string; args: Record<string, unknown>; task: string | null }): Redeemed {
    const hash = hashOf(call.connector, call.tool, call.args);
    const refuse = (why: string): Redeemed => {
      this.note({ connector: call.connector, taskId: call.task, tool: call.tool, hash }, call.args, "refused", false, why);
      return { ok: false, why };
    };
    const record = this.approvals.get(approval.id);
    if (!record) return refuse("there is no such approval, or it was already used");
    this.approvals.delete(approval.id);
    if (record.expiresAt <= this.now()) return refuse("the approval had lapsed");
    if (record.hash !== hash || record.connector !== call.connector || record.tool !== call.tool) return refuse("the arguments are not the ones that were approved");
    return { ok: true, permit: Permit.issue(call.connector, call.tool, hash) };
  }

  /** What came of a change that was sent, written down with the hash it was approved under. */
  executed(call: { connector: string; tool: string; args: Record<string, unknown>; task: string | null }, result: { ok: boolean; size: number; ms: number; note?: string }): void {
    this.deps.audit.add({
      at: this.now(),
      kind: "write",
      connector: call.connector,
      task: call.task,
      tool: call.tool,
      args: maskArgs(call.args),
      hash: hashOf(call.connector, call.tool, call.args),
      phase: "executed",
      ok: result.ok,
      size: result.size,
      ms: result.ms,
      ...(result.note !== undefined ? { note: result.note } : {}),
    });
  }

  // ------------------------------------------------------------------------------------------------------------------ proposals

  /** A change nobody was there to look at: kept for the person, never run by the task that wanted it. Null when too many already wait. */
  propose(input: HoldInput): WriteCard | null {
    this.sweep();
    const card = this.card(input, true);
    if (this.proposed.size >= MAX_PROPOSALS) {
      this.note(card, input.args, "refused", false, "too many proposals already wait for the person");
      return null;
    }
    this.proposed.set(card.id, { card, args: input.args });
    this.note(card, input.args, "proposed", true);
    return card;
  }

  proposals(): WriteCard[] {
    this.sweep();
    return [...this.proposed.values()].map((p) => p.card);
  }

  /** The person's answer to a proposal. "do" returns the call with an approval for it, to be sent now; "dont" drops it and returns null. */
  takeProposal(cardId: string, answer: unknown): { card: WriteCard; args: Record<string, unknown>; approval: Approval } | null {
    const entry = this.proposed.get(cardId);
    if (!entry) throw new ConflictError("That proposal is not waiting any more.");
    if (answer !== "do" && answer !== "dont") throw new ValidationError("answer", "answer must be do or dont");
    this.proposed.delete(cardId);
    if (entry.card.expiresAt <= this.now()) {
      this.note(entry.card, entry.args, "expired", false, "no answer in time");
      throw new ConflictError("That proposal expired, so nothing was done.");
    }
    if (answer === "dont") {
      this.note(entry.card, entry.args, "refused", false, "the person said no");
      return null;
    }
    this.note(entry.card, entry.args, "approved", true, "approved from a proposal");
    return { card: entry.card, args: entry.args, approval: this.approve(entry.card) };
  }

  // --------------------------------------------------------------------------------------------------------------------- time

  /** Lets lapse what was not answered in time: a card is refused, a proposal dropped, an approval forgotten. */
  sweep(): void {
    const now = this.now();
    for (const { card } of [...this.held.values()]) if (card.expiresAt <= now) this.settle(card.id, { allowed: false, why: "expired" }, "expired", "no answer in time");
    for (const [id, { card, args }] of [...this.proposed]) {
      if (card.expiresAt > now) continue;
      this.proposed.delete(id);
      this.note(card, args, "expired", false, "no answer in time");
    }
    for (const [id, record] of [...this.approvals]) if (record.expiresAt <= now) this.approvals.delete(id);
  }
}
