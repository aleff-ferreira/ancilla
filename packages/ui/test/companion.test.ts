import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FORMS, HUES, MOODS, avatarVars, describeAvatar, hueName, looksLike, particles, pointsOf, polygon, randomSpec, rng, withArticle, type AvatarSpec } from "../src/components/assistant/companion/faces.js";
import { Avatar } from "../src/components/assistant/companion/Avatar.js";
import { ARCHETYPES, DIALS, LINE_KINDS, dayOfYear, dialWord, greeting, milestoneText, say } from "../src/components/assistant/companion/voice.js";
import type { AssistantCharacterView } from "../src/types.js";

const SPEC: AvatarSpec = { form: "halo", hue: 232, glow: 60, detail: 1, seed: 7 };
const character = (voice: Partial<AssistantCharacterView["voice"]> = {}, callsUser = ""): AssistantCharacterView => ({
  avatar: SPEC, voice: { archetype: "steady", warmth: 2, humor: 1, directness: 3, curiosity: 1, formality: 1, ...voice }, callsUser, quirks: [], presence: "tone", showBond: true, setupAt: 1,
});
const NOON = Date.UTC(2026, 10, 8, 12, 0, 0);

describe("the face as a spec", () => {
  it("names the nearest hue around the circle, and says what it looks like", () => {
    assert.equal(hueName(232), "Ice");
    assert.equal(hueName(0), "Rose", "around the top of the circle: 0 is nearer 10 than 340");
    assert.equal(hueName(358), "Rose");
    assert.equal(hueName(352), "Orchid", "352 is 12 degrees from Orchid and 18 from Rose");
    assert.equal(hueName(335), "Orchid");
    assert.equal(describeAvatar(SPEC, "Ancilla"), "Ancilla, an ice halo with a bright glow, resting");
    assert.match(describeAvatar(SPEC, "Ancilla", "attention"), /wants your attention/);
    assert.equal(describeAvatar({ ...SPEC, form: "critter", hue: 45 }, "Pip", "asleep"), "Pip, an ember critter with a bright glow, asleep");
    assert.equal(describeAvatar({ ...SPEC, form: "optic", hue: 295, glow: 10 }, "Ada"), "Ada, a violet optic with a faint glow, resting");
  });

  it("writes the article for a look by its first letter, so no card says \"a ice\"", () => {
    assert.equal(looksLike(SPEC), "ice halo");
    assert.equal(withArticle(looksLike(SPEC)), "an ice halo");
    assert.equal(withArticle(looksLike({ ...SPEC, hue: 85, form: "optic" })), "an amber optic");
    assert.equal(withArticle(looksLike({ ...SPEC, hue: 195, form: "hologram" })), "a teal hologram");
    for (const h of HUES) {
      for (const f of FORMS) {
        const phrase = withArticle(looksLike({ ...SPEC, hue: h.hue, form: f.form }));
        assert.ok(!/^a [aeiou]/.test(phrase) && !/^an [^aeiou]/.test(phrase), `the article fits the next word: ${phrase}`);
      }
    }
  });

  it("draws the same face from the same seed, and a different small touch from another", () => {
    const a = rng(42);
    const b = rng(42);
    assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
    assert.notDeepEqual([rng(1)(), rng(1)()], [rng(2)(), rng(2)()]);
    assert.deepEqual(avatarVars(SPEC), avatarVars({ ...SPEC }));
    assert.notDeepEqual(avatarVars(SPEC), avatarVars({ ...SPEC, seed: 8 }));
    const v = avatarVars(SPEC);
    assert.equal(v["--h"], 232);
    assert.equal(v["--g"], "0.60");
    assert.match(String(v["--blink"]), /^[4-8]\.\d\ds$/);
  });

  it("makes faces that are always valid", () => {
    const random = rng(99);
    for (let i = 0; i < 200; i++) {
      const s = randomSpec(random);
      assert.ok(FORMS.some((f) => f.form === s.form));
      assert.ok(HUES.some((h) => h.hue === s.hue));
      assert.ok(s.glow >= 45 && s.glow < 90 && s.detail >= 0 && s.detail <= 3 && s.seed >= 1);
    }
  });

  it("lays out a regular polygon with its first corner up, and a few particles inside the box", () => {
    const tri = polygon(3, 50);
    assert.equal(tri.length, 3);
    assert.ok(Math.abs((tri[0] as [number, number])[0] - 80) < 1e-9 && Math.abs((tri[0] as [number, number])[1] - 30) < 1e-9, "the first corner is straight up");
    assert.equal(pointsOf([[1, 2], [3.14159, 4]]), "1.0,2.0 3.1,4.0");
    const dots = particles(5, 7);
    assert.equal(dots.length, 7);
    assert.ok(dots.every((d) => d.x >= 50 && d.x <= 110 && d.delay >= 0 && d.duration >= 4));
    assert.deepEqual(particles(5, 7), dots);
  });
});

describe("the face as markup", () => {
  const render = (props: Parameters<typeof Avatar>[0]): string => renderToStaticMarkup(createElement(Avatar, props));

  it("draws every form in every mood, as an image that says what it is", () => {
    for (const f of FORMS) {
      for (const mood of MOODS) {
        const html = render({ spec: { ...SPEC, form: f.form }, name: "Ancilla", mood });
        assert.match(html, new RegExp(`data-form="${f.form}"`), f.form);
        assert.match(html, new RegExp(`data-mood="${mood}"`), `${f.form} ${mood}`);
        assert.match(html, /role="img" aria-label="Ancilla, an? ice /, f.form);
        assert.match(html, /--h:232/);
      }
    }
  });

  it("plays a burst only for the moods that are brief, and again when the burst key changes", () => {
    assert.doesNotMatch(render({ spec: SPEC, mood: "idle" }), /av-burst/);
    assert.doesNotMatch(render({ spec: SPEC, mood: "working" }), /av-burst/);
    assert.match(render({ spec: SPEC, mood: "delight", burst: 1 }), /av-burst delight/);
    assert.match(render({ spec: SPEC, mood: "concern", burst: 1 }), /av-burst concern/);
  });

  it("gives each face ids of its own, so two on one page do not borrow each other's gradients", () => {
    const html = renderToStaticMarkup(createElement("div", null, createElement(Avatar, { spec: SPEC }), createElement(Avatar, { spec: SPEC })));
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length >= 12);
    assert.equal(new Set(ids).size, ids.length, "no id is used twice");
  });

  it("puts a disc behind it only when asked, and sizes it in pixels", () => {
    assert.doesNotMatch(render({ spec: SPEC }), /av-stage/);
    const html = render({ spec: SPEC, stage: true, size: 40 });
    assert.match(html, /class="av-stage"/);
    assert.match(html, /width:40px;height:40px/);
  });
});

describe("what it says", () => {
  it("has something to say for every moment in every voice, and says it in two ways", () => {
    for (const info of ARCHETYPES) {
      for (const kind of LINE_KINDS) {
        const calm = say(kind, character({ archetype: info.archetype, warmth: 0, humor: 0 }), { name: "Ancilla", task: "the audit", n: 2 }, NOON);
        const lively = say(kind, character({ archetype: info.archetype, warmth: 4, humor: 4, directness: 0 }), { name: "Ancilla", task: "the audit", n: 2 }, NOON);
        assert.ok(calm.length > 0 && lively.length > 0, `${info.archetype} ${kind}`);
        if (info.archetype !== "custom") assert.ok(calm.length < 110 && lively.length < 110, `${info.archetype} ${kind} is short`);
      }
    }
  });

  it("is plain text, in ASCII, with no dash that stands in for a pause and no feeling claimed as a fact", () => {
    const feeling = /\b(i feel|i'm glad|i am glad|i'm happy|i am happy|i love|i hope|i miss|i'm sad|i'm sorry|i am sorry|i'm proud)\b/i;
    for (const info of ARCHETYPES) {
      for (const kind of LINE_KINDS) {
        for (const warm of [0, 4]) {
          const line = say(kind, character({ archetype: info.archetype, warmth: warm, humor: warm }), { name: "Ancilla", task: "the audit", n: 3 }, NOON);
          assert.match(line, /^[\x20-\x7e]+$/, `${info.archetype} ${kind}: ${line}`);
          assert.doesNotMatch(line, feeling, `${info.archetype} ${kind}: ${line}`);
          assert.doesNotMatch(line, /\{|\}|undefined|NaN/, line);
          assert.equal(line, line.trim());
          assert.doesNotMatch(line, / {2}| [.,?!]/);
        }
      }
    }
  });

  it("is the same line for the same state, and the dials move it", () => {
    const a = say("remembered", character({ archetype: "dry" }), {}, NOON);
    assert.equal(a, say("remembered", character({ archetype: "dry" }), {}, NOON));
    assert.equal(say("remembered", character({ archetype: "dry", warmth: 0, humor: 0 }), {}, NOON), "Noted.");
    assert.equal(say("remembered", character({ archetype: "dry", warmth: 4, humor: 4, directness: 0 }), {}, NOON), "Noted. Filed under things you can't take back.");
    assert.equal(say("taskDone", character({ archetype: "dry", warmth: 0, humor: 0 }), {}, NOON), "Done, and checked.");
  });

  it("says a line differently from one day to the next only when the dials do not decide", () => {
    const middling = character({ archetype: "warm", warmth: 2, humor: 1, directness: 1 });
    const days = new Set(Array.from({ length: 6 }, (_, i) => say("greetMorning", middling, {}, NOON + i * 86_400_000)));
    assert.equal(days.size, 2, "both lines come up over a week");
    const decided = character({ archetype: "warm", warmth: 4, humor: 4 });
    assert.equal(new Set(Array.from({ length: 6 }, (_, i) => say("greetMorning", decided, {}, NOON + i * 86_400_000))).size, 1);
    assert.ok(dayOfYear(NOON) > 300);
  });

  it("uses the name it was given for the user, and none when it has none, without a stray comma", () => {
    assert.equal(say("greetMorning", character({}, "Captain"), {}, NOON), "Good morning, Captain.");
    assert.equal(say("greetMorning", character({}, ""), {}, NOON), "Good morning.");
    assert.equal(say("greetDay", character({ archetype: "dry" }, "Captain"), {}, NOON), "Captain. You're back.");
    assert.equal(say("greetDay", character({ archetype: "dry" }, ""), {}, NOON), "You're back.");
    assert.equal(say("greetDay", character({ archetype: "playful", warmth: 0, humor: 0 }, ""), {}, NOON), "Hey, what's the plan?");
    assert.equal(say("greetDay", character({ archetype: "playful", warmth: 0, humor: 0 }, "Cap"), {}, NOON), "Hey Cap, what's the plan?");
    assert.equal(say("needs", character({ warmth: 0, humor: 0 }), { n: 3 }, NOON), "3 waiting on you.");
    assert.equal(say("working", character({ warmth: 0, humor: 0 }), { task: "the audit" }, NOON), "Working on the audit.");
    assert.equal(say("hello", character({ warmth: 0, humor: 0 }), { name: "Pip" }, NOON), "I'm Pip. I'll keep what you tell me and say so when I'm unsure.");
  });

  it("greets by the hour", () => {
    const c = character({ archetype: "steady", warmth: 0, humor: 0 });
    const local = (hour: number) => new Date(2026, 10, 8, hour, 0, 0).getTime();
    assert.equal(greeting(c, {}, local(9)), "Good morning.");
    assert.equal(greeting(c, {}, local(14)), "Good afternoon.");
    assert.equal(greeting(c, {}, local(20)), "Good evening.");
    assert.match(greeting(c, {}, local(2)), /Still up/);
  });

  it("says the same plain fact for a milestone in every voice, and has a word for each dial setting", () => {
    for (const id of ["first-note", "notes-10", "notes-50", "notes-100", "first-change", "first-task", "tasks-10", "week", "month", "quarter"]) {
      const text = milestoneText(id);
      assert.match(text, /^[\x20-\x7e]+$/);
      assert.notEqual(text, milestoneText("nothing"), id);
    }
    for (const dial of DIALS) {
      const words = [0, 1, 2, 3, 4].map((v) => dialWord(dial.key, v));
      assert.equal(new Set(words).size, 5, dial.key);
    }
    assert.equal(dialWord("warmth", 99), "very warm");
  });

  it("starts each voice with dials that fit it", () => {
    const by = Object.fromEntries(ARCHETYPES.map((a) => [a.archetype, a.dials]));
    assert.ok((by["warm"]?.warmth ?? 0) >= 4 && (by["dry"]?.humor ?? 0) >= 4 && (by["sharp"]?.directness ?? 0) >= 4 && (by["formal"]?.formality ?? 0) >= 4 && (by["curious"]?.curiosity ?? 0) >= 4);
    assert.equal(ARCHETYPES.length, 8);
  });
});
