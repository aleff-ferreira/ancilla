/**
 * When a model call ran, for the calls Ancilla reads back from a thread's history. Muse's `session/tokenUsage`
 * carries no time and a history page carries no emission time, so a replayed call is dated from its turn: an item
 * of that turn that says when it was recorded, else the time inside the turn's UUIDv7 id. Both are the start of
 * the turn, a lower bound for a long one; a turn that crosses UTC midnight can put its later calls on the earlier
 * day. That is the honest price of dating a call the log never timed, and far closer than the moment the thread
 * was opened, which is what such a call used to be dated with.
 */

/** Nothing Muse made predates this, so an earlier time is a bad decode or a garbage field, not a call. */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2024, 0, 1);

/** How far ahead of this clock a time may sit before it is not believed (a host with a fast clock). */
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

const UUID_V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function plausible(ms: number, now: number): boolean {
  return Number.isFinite(ms) && ms >= EARLIEST_PLAUSIBLE_MS && ms <= now + CLOCK_SKEW_MS;
}

function parseMs(value: string | number | null | undefined): number | null {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The Unix milliseconds in the first 48 bits of a UUIDv7. Null for anything else: another UUID version, text
 * that is not a UUID (a test's `t1`), or a time that cannot be right.
 */
export function uuidv7Ms(id: unknown, now: number = Date.now()): number | null {
  if (typeof id !== "string") {
    return null;
  }
  const match = UUID_V7.exec(id);
  if (!match) {
    return null;
  }
  const ms = Number.parseInt(`${match[1]}${match[2]}`, 16);
  return plausible(ms, now) ? ms : null;
}

/**
 * The earliest `recordedAt` of any item each turn has in these events: the turn's own start as the log timed it.
 * A page that cuts a turn short gives the first item it holds, which is still no later than any call it holds.
 */
export function turnStartTimes(events: readonly { method: string; params: Record<string, unknown> }[], now: number = Date.now()): Map<string, number> {
  const starts = new Map<string, number>();
  for (const event of events) {
    const item = event.method.startsWith("item/") ? event.params["item"] : null;
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const turnId = (item as Record<string, unknown>)["turnId"];
    const ms = parseMs((item as Record<string, unknown>)["recordedAt"] as string | undefined);
    if (typeof turnId !== "string" || ms === null || !plausible(ms, now)) {
      continue;
    }
    const known = starts.get(turnId);
    if (known === undefined || ms < known) {
      starts.set(turnId, ms);
    }
  }
  return starts;
}

export interface ReplayDateInput {
  /** The turn the call belongs to. */
  turnId?: string | null;
  /** The earliest recorded time of that turn's items, from `turnStartTimes`; an RFC3339 string or Unix ms. */
  itemAt?: string | number | null;
  /** The thread's stored last activity and creation, for a call that names no usable turn. */
  activityAt?: string | null;
  createdAt?: string | null;
}

export interface ReplayDate {
  /** ISO UTC, never later than now. */
  at: string;
  source: "item" | "turn" | "session" | "now";
  /**
   * True when the date is the turn's own (an item's time or the turn id's) and was not clamped. Only such a date
   * may move a stored one; a thread's activity time says when the thread was last touched, not when this call ran.
   */
  verified: boolean;
}

/**
 * Dates a replayed call: an item of its turn, else its turn id's time, else the thread's last activity, else its
 * creation, else now. Never later than now, and only a date taken from the turn itself counts as verified.
 */
export function replayUsageAt(input: ReplayDateInput, now: number = Date.now()): ReplayDate {
  const candidates: { source: ReplayDate["source"]; ms: number | null; verified: boolean }[] = [
    { source: "item", ms: parseMs(input.itemAt), verified: true },
    { source: "turn", ms: uuidv7Ms(input.turnId, now), verified: true },
    { source: "session", ms: parseMs(input.activityAt), verified: false },
    { source: "session", ms: parseMs(input.createdAt), verified: false },
  ];
  for (const { source, ms, verified } of candidates) {
    if (ms !== null && plausible(ms, now)) {
      return { at: new Date(Math.min(ms, now)).toISOString(), source, verified: verified && ms <= now };
    }
  }
  return { at: new Date(now).toISOString(), source: "now", verified: false };
}
