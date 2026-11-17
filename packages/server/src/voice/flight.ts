import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * A flight recorder for calls: one line of JSON each time the call decided that the person had finished, saying why it
 * decided so, what the recogniser heard, which rule (if any) made the turn something other than an answer, and where the
 * time went. It is for finding out why a call did what it did, on the person's own machine. It holds words only, never
 * audio, it sits next to the conversation it describes and goes with it when the conversation is deleted.
 */

export interface FlightLine {
  v: 1;
  /** When the line was written (milliseconds since 1970). */
  at: number;
  call: string;
  /** The number the words became as a turn of the conversation, or null when they never became one. */
  turn: number | null;
  /** Why the turn-taker thought the person had finished ("complete", "unknown", "incomplete", "command", ...). */
  endReason: string;
  silenceMs: number | null;
  speechMs: number | null;
  /** What the streaming recogniser heard, or null when it gave no separate reading. */
  streamer: string | null;
  /** What the accurate re-reading of the turn said. */
  reread: string;
  /** The words the call went on with, after grounding. */
  text: string;
  /** The recogniser's confidence in those words (0 to 1), or null. */
  confidence: number | null;
  /** What became of the turn: "answered", "failed", "merged", "cancelled", "barge-in", "call-ended", or the rule that dropped it. */
  fate: string;
  /** The rules that fired around the turn, in order ("didnt-catch-garbled", "quiet-drop", "echo-dismissed", "held", "merged", ...). */
  rules: string[];
  /** How many stretches of speech the turn was made of. */
  fragments: number;
  brain: {
    /** Times the model was asked, and times a request was dropped before it answered. */
    runs: number;
    cancelled: number;
    /** From the model being asked to its first word. */
    firstTokenMs: number | null;
  };
  /** From the person going quiet to the first sound of the answer. */
  firstAudioMs: number | null;
}

const MAX_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export class FlightLog {
  constructor(
    private readonly dir: string,
    private readonly log: (line: string) => void = () => undefined,
    private readonly maxBytes = MAX_BYTES,
  ) {}

  private file(conversation: string, rotated = false): string {
    return join(this.dir, `${conversation}${rotated ? ".1" : ""}.jsonl`);
  }

  /** Adds a line to the conversation's file. When the file has grown past its limit it becomes the old one, which replaces the older. */
  append(conversation: string, line: FlightLine): void {
    if (!SAFE_ID.test(conversation)) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.file(conversation);
      try {
        if (statSync(file).size >= this.maxBytes) renameSync(file, this.file(conversation, true));
      } catch {
        /* there is no file yet */
      }
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch (error) {
      this.log(`flight record: could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** What is recorded for a conversation, oldest first. */
  lines(conversation: string): FlightLine[] {
    if (!SAFE_ID.test(conversation)) return [];
    const out: FlightLine[] = [];
    for (const file of [this.file(conversation, true), this.file(conversation)]) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const row of text.split("\n")) {
        if (row.trim() === "") continue;
        try {
          out.push(JSON.parse(row) as FlightLine);
        } catch {
          /* a line cut short by a crash */
        }
      }
    }
    return out;
  }

  /** Deletes what was recorded for a conversation. */
  remove(conversation: string): void {
    if (!SAFE_ID.test(conversation)) return;
    for (const file of [this.file(conversation), this.file(conversation, true)]) {
      try {
        unlinkSync(file);
      } catch {
        /* it was not there */
      }
    }
  }

  /** Deletes the records of every conversation that is not in `keep`, or of all of them when `keep` is null. Returns how many files went. */
  prune(keep: ReadonlySet<string> | null): number {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    let gone = 0;
    for (const name of names) {
      const m = /^(.+?)(\.1)?\.jsonl$/.exec(name);
      if (!m || !SAFE_ID.test(m[1] as string)) continue;
      if (keep !== null && keep.has(m[1] as string)) continue;
      try {
        unlinkSync(join(this.dir, name));
        gone++;
      } catch {
        /* already gone */
      }
    }
    return gone;
  }
}
