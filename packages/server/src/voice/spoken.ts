/**
 * What the person has actually heard. When someone cuts the assistant off, the model must go on from what was said, not
 * from what was written: text it never got to say is text the person does not know. The ledger keeps every sentence that
 * was sent to the speakers with the number of samples it makes, and given how many the speakers had played, says how
 * much of the reply was heard.
 *
 * Inside a sentence the position is an estimate: words are given a share of the sentence in proportion to their length
 * (and a little extra pause after punctuation). The estimate leans to saying less, never more: a word counts as heard
 * only once all of it is likely to have been.
 */

export interface SpokenSegment {
  text: string;
  samples: number;
  /** Samples before this segment in the utterance. */
  start: number;
}

export interface Heard {
  /** The words heard, cut at a word. */
  text: string;
  /** All of the reply was played. */
  complete: boolean;
  /** Whole segments heard. */
  segments: number;
}

const PAUSE_WEIGHT: Record<string, number> = { ",": 3, ";": 4, ":": 4, ".": 6, "!": 6, "?": 6, "…": 6 };

export class SpokenLedger {
  private readonly parts: SpokenSegment[] = [];
  private total = 0;

  /** A sentence that was sent to the speakers, and the samples it makes. */
  add(text: string, samples: number): void {
    if (text.trim() === "" || samples <= 0) return;
    this.parts.push({ text, samples, start: this.total });
    this.total += samples;
  }

  get samples(): number {
    return this.total;
  }

  get segments(): readonly SpokenSegment[] {
    return this.parts;
  }

  /** Everything that was queued, heard or not. */
  get text(): string {
    return this.parts.map((p) => p.text).join(" ");
  }

  heard(playedSamples: number): Heard {
    const played = Math.max(0, playedSamples);
    if (this.parts.length === 0) return { text: "", complete: true, segments: 0 };
    if (played >= this.total) return { text: this.text, complete: true, segments: this.parts.length };
    const done: string[] = [];
    for (const part of this.parts) {
      if (played >= part.start + part.samples) {
        done.push(part.text);
        continue;
      }
      if (played > part.start) {
        const within = wordsHeard(part.text, (played - part.start) / part.samples);
        if (within !== "") done.push(within);
      }
      break;
    }
    const whole = this.parts.filter((p) => played >= p.start + p.samples).length;
    return { text: done.join(" "), complete: false, segments: whole };
  }
}

/** The words of a sentence that fit in the first `fraction` of its time, never counting a word that is only partly through. */
export function wordsHeard(sentence: string, fraction: number): string {
  const f = Math.min(1, Math.max(0, fraction));
  if (f >= 1) return sentence.trim();
  const tokens = sentence.trim().split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return "";
  const weights = tokens.map((t) => {
    const letters = t.replace(/[^\p{L}\p{N}]/gu, "").length;
    const last = t[t.length - 1] ?? "";
    return Math.max(1, letters) + (PAUSE_WEIGHT[last] ?? 0);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    acc += weights[i] as number;
    if (acc / sum <= f) kept.push(tokens[i] as string);
    else break;
  }
  return kept.join(" ");
}
