import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { Onboarding } from "../src/components/assistant/Onboarding.js";
import { CompanionChip, chipSub } from "../src/components/assistant/companion/CompanionChip.js";
import { CompanionHero, glanceOf, leanings, openingLine } from "../src/components/assistant/companion/Companion.js";
import { mergeChange, mergeCharacter, tidyQuirks } from "../src/components/assistant/companion/draft.js";
import { Preview } from "../src/components/assistant/companion/edit.js";
import { REACTION_MS, moodNow, stateOf } from "../src/components/assistant/companion/mood.js";
import { ThreadPresence, lastOutcome } from "../src/components/assistant/companion/ThreadPresence.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import type { ThreadFold } from "../src/model/fold.js";
import { Store, type AppState, type AssistantGlance } from "../src/model/store.js";
import type { AssistantCharacterView, AssistantStatusView } from "../src/types.js";
import { appState } from "./crew-fixtures.js";

const DAY = 86_400_000;
const NOON = Date.UTC(2026, 10, 8, 12, 0, 0);

const CHARACTER: AssistantCharacterView = {
  avatar: { form: "halo", hue: 232, glow: 60, detail: 1, seed: 7 },
  voice: { archetype: "steady", warmth: 2, humor: 1, directness: 3, curiosity: 1, formality: 1 },
  callsUser: "",
  quirks: [],
  presence: "tone",
  showBond: true,
  setupAt: 1,
};
const UNSET: AssistantCharacterView = { ...CHARACTER, setupAt: null };
const DRY: AssistantCharacterView = { ...CHARACTER, voice: { archetype: "dry", warmth: 1, humor: 4, directness: 3, curiosity: 1, formality: 2 } };

const glance = (extra: Partial<AssistantGlance> = {}): AssistantGlance => ({ enabled: true, name: "Ancilla", character: CHARACTER, open: 0, needsYou: 0, running: 0, ...extra });

function status(character: AssistantCharacterView = CHARACTER, extra: Partial<AssistantStatusView> = {}, enabled = true): AssistantStatusView {
  return {
    available: true,
    profile: {
      id: "assistant",
      enabled,
      name: "Ancilla",
      persona: "",
      character,
      communication: { verbosity: "concise", tone: "plain", language: "", notes: "" },
      autonomy: "suggest",
      policy: { allowReadOnly: true, allowProjectWrites: false, maxConcurrent: 1, maxTurnsPerTask: 12, maxMinutesPerTask: 30, maxTasksPerDay: 10 },
      capturePaused: false,
      contextBudgetTokens: 900,
      updatedAt: 1,
    },
    goals: [],
    stats: { items: { active: 0, superseded: 0, contested: 0, pending: 0, deleted: 0 }, kinds: {}, sources: 0, revisions: 0, tombstones: 0, bytes: 0, ftsEnabled: true },
    bond: { since: NOON - 12 * DAY, daysTogether: 12, remembered: 8, replaced: 1, finished: 2, unchecked: 0, milestones: [] },
    epoch: 1,
    tasks: { open: 3, needsYou: 0, running: 0 },
    ...extra,
  };
}

function inApp(state: AppState, element: ReturnType<typeof createElement>): string {
  const store = new Store<AppState>(state);
  const controller = { store } as unknown as AncillaController;
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: element }) }));
}

const withAssistant = (g: AssistantGlance | null, prefs: Partial<AppState["prefs"]> = {}): AppState => {
  const base = appState();
  return { ...base, assistantGlance: g, prefs: { ...base.prefs, ...prefs } };
};

const text = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("where the assistant stands", () => {
  it("asks to be set up before anything else, and sleeps only once it has been set up and switched off", () => {
    assert.equal(stateOf(glance({ character: UNSET })), "invite");
    assert.equal(stateOf(glance({ character: UNSET, enabled: false, needsYou: 3 })), "invite", "an assistant nobody has set up asks first, whatever else is true");
    assert.equal(stateOf(glance({ enabled: false })), "off");
    assert.equal(stateOf(glance({ needsYou: 2, running: 1 })), "needs", "what waits on you outranks what it is doing");
    assert.equal(stateOf(glance({ running: 1 })), "working");
    assert.equal(stateOf(glance()), "idle");
    assert.equal(moodNow(glance({ character: UNSET, enabled: false }), null, NOON).mood, "idle", "before it is set up it is awake and waiting for its owner");
    assert.equal(moodNow(glance({ enabled: false }), null, NOON).mood, "asleep");
    assert.equal(moodNow(glance({ needsYou: 1 }), null, NOON).mood, "attention");
    assert.equal(moodNow(glance({ running: 1 }), null, NOON).mood, "working");
    assert.equal(moodNow(glance(), null, NOON).mood, "idle");
  });

  it("lets a reaction show for a moment with its own burst, then goes back to what it was doing", () => {
    const reaction = { mood: "delight" as const, at: NOON };
    assert.deepEqual(moodNow(glance({ running: 1 }), reaction, NOON + 100), { mood: "delight", burst: NOON });
    assert.equal(moodNow(glance({ running: 1 }), reaction, NOON + REACTION_MS - 1).mood, "delight");
    assert.equal(moodNow(glance({ running: 1 }), reaction, NOON + REACTION_MS).mood, "working", "gone when its time is up");
    assert.equal(moodNow(glance({ enabled: false }), reaction, NOON + 100).mood, "asleep", "a switched off assistant does not react");
  });

  it("says in plain words what the card in the sidebar is for", () => {
    assert.equal(chipSub("invite", 0), "Give it a face and a voice");
    assert.equal(chipSub("off", 0), "Switched off");
    assert.equal(chipSub("needs", 1), "1 needs you");
    assert.equal(chipSub("needs", 3), "3 need you");
    assert.equal(chipSub("working", 0), "Working");
    assert.equal(chipSub("idle", 0), "Ready");
  });

  it("builds what the sidebar reads from the page's own answer", () => {
    assert.deepEqual(glanceOf(status(CHARACTER, { tasks: { open: 4, needsYou: 2, running: 1 } })), { enabled: true, name: "Ancilla", character: CHARACTER, open: 4, needsYou: 2, running: 1 });
    assert.deepEqual(glanceOf(status(CHARACTER, { tasks: undefined }, false)), { enabled: false, name: "Ancilla", character: CHARACTER, open: 0, needsYou: 0, running: 0 });
  });

  it("opens with a line from what is true now, and is plain before it is set up", () => {
    const quiet = openingLine(glance(), NOON);
    const waiting = openingLine(glance({ needsYou: 2 }), NOON);
    const busy = openingLine(glance({ running: 1 }), NOON);
    assert.notEqual(quiet, waiting);
    assert.notEqual(quiet, busy);
    for (const line of [quiet, waiting, busy, openingLine(glance({ character: UNSET }), NOON), openingLine(glance({ enabled: false }), NOON)]) {
      assert.ok(line.length > 0 && !/[{}]/.test(line) && /^[\x20-\x7e]+$/.test(line), `a clean line of plain text: ${line}`);
    }
    assert.match(waiting, /2/, "it says how many wait on you");
  });

  it("names the two dials that set a voice apart", () => {
    assert.equal(leanings(status(DRY)), "always joking, reserved");
    assert.ok(leanings(status(CHARACTER)).split(", ").length <= 2);
  });
});

describe("how a thread ended, for the face beside the composer", () => {
  const foldOf = (turns: Record<string, { startedAt?: number; completedAt?: number; terminal?: string }>): ThreadFold => ({ turns }) as unknown as ThreadFold;

  it("reads the last turn that ended, and calls a stop no occasion", () => {
    assert.equal(lastOutcome(null), null);
    assert.equal(lastOutcome(foldOf({})), null);
    assert.equal(lastOutcome(foldOf({ a: { startedAt: 1 } })), null, "a turn still running has not ended");
    assert.equal(lastOutcome(foldOf({ a: { startedAt: 1, completedAt: 5, terminal: "completed" } })), "completed");
    assert.equal(lastOutcome(foldOf({ a: { startedAt: 1, completedAt: 5, terminal: "failed" } })), "failed");
    assert.equal(lastOutcome(foldOf({ a: { startedAt: 1, completedAt: 5, terminal: "error" } })), "failed");
    assert.equal(lastOutcome(foldOf({ a: { startedAt: 1, completedAt: 5, terminal: "cancelled" } })), "stopped");
  });

  it("takes the latest turn when there are several, by when it ended", () => {
    const turns = { old: { startedAt: 1, completedAt: 10, terminal: "failed" }, newer: { startedAt: 20, completedAt: 30, terminal: "completed" } };
    assert.equal(lastOutcome(foldOf(turns)), "completed");
    assert.equal(lastOutcome(foldOf({ ...turns, later: { startedAt: 40, completedAt: 50, terminal: "failed" } })), "failed");
    assert.equal(lastOutcome(foldOf({ ...turns, running: { startedAt: 60 } })), "completed", "a turn that has not ended does not hide the one that has");
  });
});

describe("the card in the sidebar", () => {
  const chip = (g: AssistantGlance | null, invite: "pulse" | "calm" | "hidden" = "pulse"): string => inApp(withAssistant(g, { assistantInvite: invite }), createElement(CompanionChip));

  it("asks to be set up, with a light round it, and says so in words as well", () => {
    const markup = chip(glance({ character: UNSET }));
    assert.match(markup, /data-state="invite"/);
    assert.match(markup, /data-invite="pulse"/);
    assert.match(text(markup), /Meet your assistant Give it a face and a voice Set up/);
    assert.match(markup, /aria-label="Meet your assistant: give it a face and a voice"/);
    assert.match(markup, /aria-label="Not now: stop the light, keep the card"/);
  });

  it("keeps the card but stops the light once told not now, and hides it when asked to", () => {
    const calm = chip(glance({ character: UNSET }), "calm");
    assert.match(calm, /data-state="invite"/);
    assert.match(calm, /data-invite="calm"/, "the stylesheet draws the light only for pulse");
    assert.doesNotMatch(calm, /data-invite="pulse"/);
    assert.doesNotMatch(calm, /Not now/);
    assert.match(text(calm), /Meet your assistant/);
    assert.equal(chip(glance({ character: UNSET }), "hidden"), "");
    assert.equal(chip(glance(), "hidden"), "");
    assert.equal(chip(null), "", "nothing until the sidebar has heard from the server");
  });

  it("is the face, the name and one plain line once it is set up, with a badge only when something waits on you", () => {
    const idle = chip(glance());
    assert.match(text(idle), /Ancilla Ready/);
    assert.doesNotMatch(idle, /cc-badge|Set up/);
    const needs = chip(glance({ needsYou: 2 }));
    assert.match(text(needs), /Ancilla 2 need you 2/);
    assert.match(needs, /class="cc-badge"/);
    assert.match(needs, /data-state="needs"/);
    assert.match(text(chip(glance({ enabled: false }))), /Ancilla Switched off/);
    assert.match(text(chip(glance({ running: 1 }))), /Ancilla Working/);
  });

  it("names the card for a screen reader by its state", () => {
    assert.match(chip(glance({ needsYou: 1 })), /aria-label="Ancilla: 1 needs you"/);
    assert.match(chip(glance()), /aria-label="Ancilla: Ready"/);
  });
});

describe("the face beside the composer", () => {
  const presence = (g: AssistantGlance | null, props: { running?: boolean; waiting?: number } = {}, wanted = true): string =>
    inApp(withAssistant(g, { assistantPresence: wanted }), createElement(ThreadPresence, { fold: null, running: props.running ?? false, waiting: props.waiting ?? 0 }));

  it("is there only when it was asked for, set up and switched on", () => {
    assert.match(presence(glance()), /data-presence="idle"/);
    assert.equal(presence(glance(), {}, false), "", "the user can switch it off");
    assert.equal(presence(glance({ enabled: false })), "");
    assert.equal(presence(glance({ character: UNSET })), "");
    assert.equal(presence(null), "");
  });

  it("shows what the thread is doing, and says something only when it has something to say", () => {
    assert.doesNotMatch(presence(glance()), /presence-bubble/);
    assert.match(presence(glance(), { running: true }), /data-presence="working"/);
    const waiting = presence(glance(), { waiting: 1 });
    assert.match(waiting, /data-presence="attention"/);
    assert.match(waiting, /role="status" class="presence-bubble"/);
    assert.match(presence(glance(), { running: true, waiting: 2 }), /data-presence="attention"/, "a request waiting on you outranks the work");
  });
});

describe("the assistant on its home page", () => {
  const hero = (s: AssistantStatusView): string =>
    inApp({ ...appState(), assistantReaction: null }, createElement(CompanionHero, { status: s, onMake: () => undefined, onWake: () => undefined, onPersona: () => undefined }));

  it("says what it looks like with the right article, whatever the colour", () => {
    assert.match(text(hero(status())), /An ice halo\./);
    assert.match(text(hero(status({ ...CHARACTER, avatar: { ...CHARACTER.avatar, hue: 195 } }))), /A teal halo\./);
    assert.match(text(hero(status({ ...CHARACTER, avatar: { ...CHARACTER.avatar, hue: 85, form: "optic" } }))), /An amber optic\./);
    assert.doesNotMatch(text(hero(status())), /\bA ice\b/);
  });

  it("shows what you have shared as facts, and none of them when you hid them", () => {
    const shown = text(hero(status()));
    assert.match(shown, /12 days together/);
    assert.match(shown, /8 remembered/);
    assert.match(shown, /2 finished together/);
    assert.match(shown, /1 change of mind kept/);
    assert.doesNotMatch(text(hero(status({ ...CHARACTER, showBond: false }))), /days together|remembered|finished together/);
    assert.match(text(hero(status(CHARACTER, { bond: { since: NOON, daysTogether: 0, remembered: 0, replaced: 0, finished: 0, unchecked: 0, milestones: [] } }))), /Together since today/);
    assert.match(text(hero(status(CHARACTER, { bond: { since: NOON - DAY, daysTogether: 1, remembered: 0, replaced: 0, finished: 0, unchecked: 0, milestones: [] } }))), /1 day together/);
  });

  it("asks to be made yours before it is set up, and to be switched on when it is off", () => {
    const unset = text(hero(status(UNSET)));
    assert.match(unset, /Meet your assistant/);
    assert.match(unset, /Make it yours/);
    assert.doesNotMatch(unset, /Change its look and voice/);
    const off = text(hero(status(CHARACTER, {}, false)));
    assert.match(off, /Switch it on/);
    assert.match(off, /Change its look and voice/);
    const on = text(hero(status()));
    assert.match(on, /Your assistant/);
    assert.match(on, /Change its look and voice/);
    assert.doesNotMatch(on, /Make it yours|Switch it on/);
  });
});

describe("the first meeting and the preview", () => {
  const meeting = (props: { name?: string; cancel?: boolean } = {}): string =>
    inApp(appState(), createElement(Onboarding, { profile: { ...status(UNSET).profile, name: props.name ?? "" }, onDone: () => undefined, ...(props.cancel === false ? {} : { onCancel: () => undefined }) }));

  it("starts at hello with a name to give, four steps to go and a way out", () => {
    const markup = meeting();
    const words = text(markup);
    assert.match(words, /1\. Hello/);
    assert.match(words, /2\. Look/);
    assert.match(words, /3\. Voice/);
    assert.match(words, /4\. Wake it/);
    assert.equal((markup.match(/aria-current="step"/g) ?? []).length, 1);
    assert.match(markup, /data-step="0"/);
    assert.match(words, /What should it be called\?/);
    assert.match(markup, /id="companion-name"[^>]*value="Ancilla"/, "an unnamed assistant starts as Ancilla");
    assert.match(words, /nothing is kept or switched on until the last step/);
    assert.match(markup, /Let(&#x27;|')s begin/);
    assert.match(words, /Not now/);
    assert.doesNotMatch(text(meeting({ cancel: false })), /Not now/, "the page it replaces has nowhere to go back to");
    assert.match(text(meeting({ name: "Vesper" })), /Meet your assistant/);
    assert.match(meeting({ name: "Vesper" }), /value="Vesper"/);
  });

  it("stacks the face over its words in a narrow column and lays them side by side where there is room", () => {
    const markup = inApp(appState(), createElement(Preview, { draft: CHARACTER, name: "Ancilla", line: "Good morning." }));
    assert.match(markup, /class="companion-preview @container"/, "the card measures itself, not the page");
    assert.match(markup, /class="flex flex-col @min-\[440px\]:flex-row"/);
    assert.match(markup, /class="ch-stage compact @min-\[440px\]:w-48 @min-\[440px\]:shrink-0"/);
    assert.match(text(markup), /Ancilla Steady voice, ice halo .?Good morning\.?.? Resting Working Needs you Pleased Concerned Asleep/);
    assert.equal((markup.match(/whitespace-nowrap/g) ?? []).length, 6, "no mood wraps into two lines");
    assert.equal((markup.match(/aria-pressed="true"/g) ?? []).length, 1);
    assert.match(markup, /aria-pressed="true"[^>]*>Resting</);
    assert.doesNotMatch(text(markup), /\ba ice\b/i);
  });
});

describe("what a control may change about the character", () => {
  it("lays a change over a character field by field, and leaves the original alone", () => {
    const merged = mergeCharacter(CHARACTER, { avatar: { hue: 10 }, voice: { humor: 4 }, quirks: ["Signs off with Standing by."], presence: "full", callsUser: "Alex" });
    assert.deepEqual(merged.avatar, { ...CHARACTER.avatar, hue: 10 });
    assert.deepEqual(merged.voice, { ...CHARACTER.voice, humor: 4 });
    assert.deepEqual([merged.quirks, merged.presence, merged.callsUser], [["Signs off with Standing by."], "full", "Alex"]);
    assert.equal(CHARACTER.avatar.hue, 232);
    assert.equal(CHARACTER.voice.humor, 1);
    assert.deepEqual(CHARACTER.quirks, []);
    assert.deepEqual(mergeCharacter(CHARACTER, {}), CHARACTER);
  });

  it("makes two changes in a row one, the later winning field by field", () => {
    assert.deepEqual(
      mergeChange({ avatar: { hue: 10, glow: 20 }, presence: "off", callsUser: "A" }, { avatar: { hue: 99 }, voice: { warmth: 4 }, presence: "full" }),
      { avatar: { hue: 99, glow: 20 }, voice: { warmth: 4 }, presence: "full", callsUser: "A" },
    );
    assert.deepEqual(mergeChange({}, {}), {});
    assert.deepEqual(mergeChange({ quirks: ["a"] }, { quirks: ["b"] }), { quirks: ["b"] }, "a list is replaced whole, as the server takes it");
  });

  it("does not count a habit left empty, and keeps no more than four", () => {
    assert.deepEqual(tidyQuirks(["  a ", "", "   ", "b", "c", "d", "e"]), ["a", "b", "c", "d"]);
    assert.deepEqual(tidyQuirks([]), []);
  });
});
