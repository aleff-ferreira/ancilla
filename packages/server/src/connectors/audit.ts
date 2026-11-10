import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./manifest.js";

/**
 * What the connectors did, one line each, kept in a file of its own in the data folder: when, for which task, which connector
 * and tool, with what (a credential shape hidden, long values cut), whether it worked and how much came back. It is read on the
 * Connectors page. No model tool can reach it, so what a task did cannot be rewritten by the task.
 */

export type AuditKind = "call" | "connect" | "test" | "mode" | "disconnect";

export interface AuditEntry {
  at: number;
  kind: AuditKind;
  connector: string;
  task?: string | null;
  tool?: string;
  /** The arguments of a call, as text. */
  args?: string;
  ok: boolean;
  /** How much came back, in characters. */
  size?: number;
  ms?: number;
  note?: string;
}

const FILE_MAX = 2_000_000;
const MEMORY_MAX = 500;

/** The arguments of a call as one short line: every long value cut, every credential shape (and `known`) hidden. */
export function maskArgs(args: Record<string, unknown>, known: readonly string[] = []): string {
  const text = JSON.stringify(args, (_key, value: unknown) => (typeof value === "string" ? value.slice(0, 200) : value)) ?? "{}";
  return redact(text, known).slice(0, 400);
}

export class AuditLog {
  private memory: AuditEntry[] = [];

  /** A null path keeps the lines in memory (tests, and a data folder that is not on disk). */
  constructor(
    private readonly path: string | null,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  add(entry: AuditEntry): void {
    const clean: AuditEntry = { ...entry, ...(entry.note !== undefined ? { note: redact(entry.note).slice(0, 240) } : {}) };
    try {
      if (!this.path) {
        this.memory.push(clean);
        if (this.memory.length > MEMORY_MAX) this.memory.shift();
        return;
      }
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      if (existsSync(this.path) && statSync(this.path).size > FILE_MAX) renameSync(this.path, `${this.path}.1`);
      appendFileSync(this.path, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
    } catch (error) {
      this.log(`connectors: the activity could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The latest lines, newest first. */
  recent(limit = 100): AuditEntry[] {
    const all: AuditEntry[] = [];
    if (!this.path) all.push(...this.memory);
    else if (existsSync(this.path)) {
      try {
        for (const line of readFileSync(this.path, "utf8").split("\n")) {
          if (line === "") continue;
          try {
            all.push(JSON.parse(line) as AuditEntry);
          } catch {
            // a half-written line is not worth losing the rest for
          }
        }
      } catch {
        return [];
      }
    }
    return all.slice(-Math.max(1, limit)).reverse();
  }
}
