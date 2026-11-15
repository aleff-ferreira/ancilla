/**
 * Budgets for the prompt material a run accumulates.
 *
 * Worker findings are appended to `state.notes` round after round and every supervisor and writer prompt carries
 * all of them, so an unbounded note list grows a prompt without limit whatever transport carries it (the plan's
 * open question 1 is about the transport; this file is about the material). Two rules keep the prompts bounded:
 * a note is capped when it is written, and the block of notes a prompt carries is compacted, oldest first, until
 * it fits a budget. The newest notes are the ones the supervisor is reacting to, so they are kept whole longest.
 */

/** The most characters one note keeps when it is written into the state. */
export const NOTE_CHAR_CAP = 6_000;

/** The most characters the notes block of a supervisor or writer prompt carries before older notes are compacted. */
export const NOTES_BLOCK_CHAR_BUDGET = 120_000;

/** What a compacted note keeps: its head, which holds the worker's header and the start of its findings. */
export const NOTE_COMPACT_KEEP_CHARS = 800;

export const NOTE_TRUNCATED_MARK = "…[truncated]";
export const NOTE_COMPACTED_MARK = "…[compacted]";

/** The separator the prompts put between notes; the budget counts it. */
export const NOTES_SEPARATOR = "\n\n---\n\n";

/** `text` cut to `cap` characters with the truncation mark at the end; unchanged when it already fits. */
export function capText(text: string, cap: number = NOTE_CHAR_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, Math.max(0, cap - NOTE_TRUNCATED_MARK.length))}${NOTE_TRUNCATED_MARK}`;
}

/**
 * One worker note within `NOTE_CHAR_CAP`. The findings body gives way first, because the header names the worker
 * and the sources block carries the codes the writer cites by; only when those alone do not fit is the whole note
 * cut at the cap.
 */
export function capNote(header: string, body: string, sources: string, cap: number = NOTE_CHAR_CAP): string {
  const whole = `${header}\n\n${body}${sources}`;
  if (whole.length <= cap) return whole;
  const fixed = header.length + 2 + sources.length + NOTE_TRUNCATED_MARK.length;
  const room = cap - fixed;
  if (room > 0) {
    return `${header}\n\n${body.slice(0, room)}${NOTE_TRUNCATED_MARK}${sources}`;
  }
  return capText(whole, cap);
}

function blockLength(notes: string[]): number {
  return notes.reduce((n, note) => n + note.length, 0) + Math.max(0, notes.length - 1) * NOTES_SEPARATOR.length;
}

/**
 * The notes as a prompt carries them: unchanged while the joined block fits `budget`, otherwise the oldest notes
 * are replaced by their first `keep` characters plus a mark, one at a time, until the block fits or every note is
 * compacted. Never mutates the state's notes.
 */
export function compactNotes(notes: string[], budget: number = NOTES_BLOCK_CHAR_BUDGET, keep: number = NOTE_COMPACT_KEEP_CHARS): string[] {
  const out = [...notes];
  let length = blockLength(out);
  for (let i = 0; i < out.length && length > budget; i++) {
    const note = out[i] as string;
    if (note.length <= keep + NOTE_COMPACTED_MARK.length) continue;
    const compacted = `${note.slice(0, keep)}${NOTE_COMPACTED_MARK}`;
    length -= note.length - compacted.length;
    out[i] = compacted;
  }
  return out;
}

/** The joined notes block of a prompt, compacted to the budget. */
export function notesBlock(notes: string[], budget: number = NOTES_BLOCK_CHAR_BUDGET): string {
  return compactNotes(notes, budget).join(NOTES_SEPARATOR);
}
