import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { canonical } from "../connectors/gate.js";

/**
 * What the Sentinel concluded and did, one line each, chained by hash: every record holds the hash of the one before it, so a
 * record that is edited, removed or reordered breaks the chain at that point, and `verify` says where. The newest record's
 * hash is also kept outside the file (the `anchor`), so a file cut short is noticed too. This guards against corruption and
 * against a bug or a tool rewriting history; a process running as the person with both files in reach is not what it stops.
 * No model tool can reach it.
 */

export interface AuditRecord {
  seq: number;
  at: number;
  kind: string;
  data: Record<string, unknown>;
  prev: string;
  hash: string;
}

export interface Anchor {
  get(): { seq: number; hash: string } | null;
  set(head: { seq: number; hash: string }): void;
}

export interface ChainCheck {
  ok: boolean;
  entries: number;
  /** The `seq` of the first record that does not fit, or null. */
  brokenAt: number | null;
  reason: string | null;
}

export const GENESIS = "0".repeat(64);
const FILE_MAX = 5_000_000;
const DATA_MAX = 4000;
const MEMORY_MAX = 2000;

export function chainHash(prev: string, body: { seq: number; at: number; kind: string; data: Record<string, unknown> }): string {
  return createHash("sha256").update(prev).update("\n").update(canonical(body)).digest("hex");
}

/** Plain data of bounded size: what is written is a copy, so a later change to the caller's object cannot reach it. */
function detached(data: Record<string, unknown>): Record<string, unknown> {
  try {
    const text = JSON.stringify(data) ?? "{}";
    return text.length > DATA_MAX ? { truncated: true, size: text.length } : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    return { unreadable: true };
  }
}

function parse(line: string): AuditRecord | null {
  try {
    const record = JSON.parse(line) as Partial<AuditRecord>;
    if (typeof record.seq !== "number" || typeof record.at !== "number" || typeof record.kind !== "string" || typeof record.prev !== "string" || typeof record.hash !== "string") return null;
    if (typeof record.data !== "object" || record.data === null || Array.isArray(record.data)) return null;
    return record as AuditRecord;
  } catch {
    return null;
  }
}

export class SentinelAudit {
  private memory: AuditRecord[] = [];
  private head: { seq: number; hash: string } = { seq: 0, hash: GENESIS };

  /** A null path keeps the records in memory (tests, and a data folder that is not on disk). */
  constructor(
    private readonly path: string | null,
    private readonly now: () => number,
    private readonly anchor: Anchor | null = null,
    private readonly log: (line: string) => void = () => undefined,
  ) {
    const last = this.records().at(-1);
    if (last) this.head = { seq: last.seq, hash: last.hash };
  }

  append(kind: string, data: Record<string, unknown> = {}): AuditRecord {
    const body = { seq: this.head.seq + 1, at: this.now(), kind, data: detached(data) };
    const record: AuditRecord = { ...body, prev: this.head.hash, hash: chainHash(this.head.hash, body) };
    try {
      if (!this.path) {
        this.memory.push(record);
        if (this.memory.length > MEMORY_MAX) this.memory.shift();
      } else {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        // The next file continues the chain: its first record's `prev` is the last hash of the one before.
        if (existsSync(this.path) && statSync(this.path).size > FILE_MAX) renameSync(this.path, `${this.path}.1`);
        appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      }
    } catch (error) {
      this.log(`sentinel: the audit could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.head = { seq: record.seq, hash: record.hash };
    this.anchor?.set(this.head);
    return record;
  }

  /** The latest records, newest first. */
  recent(limit = 50): AuditRecord[] {
    return this.records().slice(-Math.max(1, limit)).reverse();
  }

  /** Walks the whole chain, the rotated file first, and compares the head with the anchor. */
  verify(): ChainCheck {
    const all = this.records(true);
    let prev: string | null = null;
    let previousSeq: number | null = null;
    for (const entry of all) {
      if (entry === null) return { ok: false, entries: all.length, brokenAt: previousSeq === null ? 1 : previousSeq + 1, reason: "a line cannot be read" };
      // The oldest record's `prev` is the anchor of the chain: what came before it was rotated away.
      if (prev !== null && entry.prev !== prev) return { ok: false, entries: all.length, brokenAt: entry.seq, reason: "a record does not follow the one before it" };
      if (previousSeq !== null && entry.seq !== previousSeq + 1) return { ok: false, entries: all.length, brokenAt: entry.seq, reason: "records are missing or out of order" };
      if (chainHash(entry.prev, { seq: entry.seq, at: entry.at, kind: entry.kind, data: entry.data }) !== entry.hash) return { ok: false, entries: all.length, brokenAt: entry.seq, reason: "a record was changed" };
      prev = entry.hash;
      previousSeq = entry.seq;
    }
    const kept = this.anchor?.get() ?? null;
    if (kept && (previousSeq === null || previousSeq < kept.seq || (previousSeq === kept.seq && prev !== kept.hash))) {
      return { ok: false, entries: all.length, brokenAt: (previousSeq ?? 0) + 1, reason: "the log is shorter than it was" };
    }
    return { ok: true, entries: all.length, brokenAt: null, reason: null };
  }

  /** The records in file order; with `strict`, a line that cannot be read is a null in the list instead of being skipped. */
  private records(): AuditRecord[];
  private records(strict: true): Array<AuditRecord | null>;
  private records(strict = false): Array<AuditRecord | null> {
    if (!this.path) return [...this.memory];
    const out: Array<AuditRecord | null> = [];
    for (const file of [`${this.path}.1`, this.path]) {
      if (!existsSync(file)) continue;
      try {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          if (line === "") continue;
          const record = parse(line);
          if (record || strict) out.push(record);
        }
      } catch {
        if (strict) out.push(null);
      }
    }
    return out;
  }
}
