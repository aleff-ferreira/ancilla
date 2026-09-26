import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NOTES_BLOCK_CHAR_BUDGET,
  NOTES_SEPARATOR,
  NOTE_CHAR_CAP,
  NOTE_COMPACTED_MARK,
  NOTE_COMPACT_KEEP_CHARS,
  NOTE_TRUNCATED_MARK,
  buildSupervisorPrompt,
  buildWriterPrompt,
  capNote,
  compactNotes,
  notesBlock,
  writerMaterial,
  type FinalRegistryEntry,
  type SupervisorPromptInput,
} from "../src/research/index.js";
import { T0 } from "./research-fakes.js";

/** A note of exactly `length` characters that starts like a worker note. */
function noteOf(i: number, length: number): string {
  const header = `## Worker A${i} (round ${i}, research): Topic ${i}\n\n`;
  return (header + "f".repeat(length)).slice(0, length);
}

function entry(i: number, excerpt: string | null): FinalRegistryEntry {
  return { code: `A${i}-S1`, url: `https://example.org/${i}`, title: `Source ${i}`, agentId: i, round: 1, verified: true, reason: `reason ${i}`, excerpt };
}

function supervisorInput(overrides: Partial<SupervisorPromptInput> = {}): SupervisorPromptInput {
  return {
    question: "What is the state of small modular reactors in 2026?",
    brief: "b".repeat(1_500),
    draft: null,
    targetLanguage: "English",
    notes: [],
    rounds: [],
    round: 1,
    maxRounds: 12,
    maxParallel: 3,
    windowMinMinutes: 3,
    windowMaxMinutes: 10,
    elapsedMinutes: 0,
    nowMs: T0,
    notice: null,
    ...overrides,
  };
}

describe("note caps", () => {
  it("cuts the findings body first and keeps the header and the sources block", () => {
    const header = "## Worker A1 (round 1, research): Topic";
    const sources = "\n\nSources saved by this worker:\n[A1-S1] Title (https://example.org/a) - verified";
    const capped = capNote(header, "x".repeat(10_000), sources);
    assert.equal(capped.length, NOTE_CHAR_CAP);
    assert.ok(capped.startsWith(`${header}\n\nxxx`));
    assert.ok(capped.endsWith(`${NOTE_TRUNCATED_MARK}${sources}`));
    const short = capNote(header, "short findings", sources);
    assert.equal(short, `${header}\n\nshort findings${sources}`, "a note that fits is untouched");
    // When the header and sources alone pass the cap the whole note is cut instead.
    const huge = capNote(header, "body", `\n\n${"s".repeat(10_000)}`);
    assert.equal(huge.length, NOTE_CHAR_CAP);
    assert.ok(huge.endsWith(NOTE_TRUNCATED_MARK));
  });
});

describe("note compaction", () => {
  it("leaves a block under budget alone", () => {
    const notes = [noteOf(1, 3_000), noteOf(2, 3_000)];
    const out = compactNotes(notes);
    assert.deepEqual(out, notes);
    assert.equal(notesBlock(notes), notes.join(NOTES_SEPARATOR));
  });

  it("compacts 40 notes of NOTE_CHAR_CAP chars, oldest first, under NOTES_BLOCK_CHAR_BUDGET", () => {
    const notes = Array.from({ length: 40 }, (_, i) => noteOf(i + 1, NOTE_CHAR_CAP));
    const snapshot = [...notes];
    const block = notesBlock(notes);
    assert.ok(block.length < NOTES_BLOCK_CHAR_BUDGET, `block is ${block.length} chars`);
    assert.ok(block.length > NOTES_BLOCK_CHAR_BUDGET - NOTE_CHAR_CAP, "compaction stops as soon as the block fits");
    const out = compactNotes(notes);
    assert.equal(out[0], `${snapshot[0]?.slice(0, NOTE_COMPACT_KEEP_CHARS)}${NOTE_COMPACTED_MARK}`, "the oldest note is compacted to its head");
    assert.equal(out[39], snapshot[39], "the newest note is whole");
    // Each compaction saves the note's length less its kept head; only as many as needed happen, oldest first.
    const whole = 40 * NOTE_CHAR_CAP + 39 * NOTES_SEPARATOR.length;
    const saving = NOTE_CHAR_CAP - NOTE_COMPACT_KEEP_CHARS - NOTE_COMPACTED_MARK.length;
    const needed = Math.ceil((whole - NOTES_BLOCK_CHAR_BUDGET) / saving);
    assert.deepEqual(
      out.map((n) => n.endsWith(NOTE_COMPACTED_MARK)),
      out.map((_, i) => i < needed),
      `${needed} oldest notes compacted, the rest whole`,
    );
    assert.deepEqual(notes, snapshot, "the state's notes are never mutated");
  });
});

describe("prompt budgets", () => {
  it("keeps a round-1 supervisor prompt with a 1500-char brief under 100 000 chars", () => {
    const prompt = buildSupervisorPrompt(supervisorInput());
    assert.ok(prompt.length < 100_000, `prompt is ${prompt.length} chars`);
    assert.match(prompt, /\(no research findings yet; this is the first round\)/);
  });

  it("bounds a supervisor prompt whatever the notes hold", () => {
    const notes = Array.from({ length: 40 }, (_, i) => noteOf(i + 1, NOTE_CHAR_CAP));
    const bare = buildSupervisorPrompt(supervisorInput()).length;
    const prompt = buildSupervisorPrompt(supervisorInput({ notes }));
    assert.ok(prompt.length < bare + NOTES_BLOCK_CHAR_BUDGET, `prompt is ${prompt.length} chars`);
    assert.match(prompt, /…\[compacted\]/);
    assert.ok(prompt.includes(notes[39] as string), "the newest note is carried whole");
  });

  it("drops curated excerpts from the writer prompt when the material is over budget, keeping url, title and reason", () => {
    const registry = [entry(1, "e".repeat(10_000)), entry(2, "quoted passage"), entry(3, null)];
    const small = writerMaterial([noteOf(1, 3_000)], registry);
    assert.equal(small.excerptsDropped, false);
    assert.match(small.curated, /\[A1-S1\] Source 1 \(https:\/\/example.org\/1\)\neeee/);
    const notes = Array.from({ length: 19 }, (_, i) => noteOf(i + 1, NOTE_CHAR_CAP));
    const large = writerMaterial(notes, registry);
    assert.equal(large.excerptsDropped, true);
    assert.doesNotMatch(large.curated, /eeee/);
    assert.match(large.curated, /Source excerpts were left out/);
    assert.match(large.curated, /\[A1-S1\] Source 1 \(https:\/\/example.org\/1\) - reason 1\n\[A2-S1\] Source 2 \(https:\/\/example.org\/2\) - reason 2$/);
    assert.ok(large.notes.length + large.curated.length < NOTES_BLOCK_CHAR_BUDGET + 1_000);
    const prompt = buildWriterPrompt({ question: "Q", brief: "B", draft: null, notes, lastReflection: null, registry, targetLanguage: "English", nowMs: T0, salvage: false });
    assert.match(prompt, /<CURATED SOURCE FULL TEXT>\n\(Source excerpts were left out/);
    assert.match(prompt, /<SOURCE REGISTRY>\n\[A1-S1\] Source 1 \(https:\/\/example.org\/1\)\n {4}Relevance: reason 1/);
  });
});
