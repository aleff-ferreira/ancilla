import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AvatarPackView, FigureSpec, ImagePackData } from "../src/types.js";
import { Avatar } from "../src/components/assistant/companion/Avatar.js";
import { COMPANIONS, COMPANION_GROUPS, companionById } from "../src/components/assistant/companion/companions/catalog.js";
import { MOODS, rng, type AvatarSpec } from "../src/components/assistant/companion/faces.js";
import { BODIES, CATALOGUE, DEFAULT_FIGURE, SLOTS, describeFigure, knownPart, normalizeFigure, partName, randomFigure, sameFigure, sameParts, touches } from "../src/components/assistant/companion/figure/parts.js";
import { PRESETS, PRESET_GROUPS, presetById } from "../src/components/assistant/companion/figure/presets.js";
import { describeLook, lookOfPack, packRef, presetOf, resolveLook, wornSentence, wornWords } from "../src/components/assistant/companion/look.js";
import { PackProvider, PackStore } from "../src/components/assistant/companion/packs.js";
import { blankPixelData, withFrames } from "../src/components/assistant/companion/pixel/pixel.js";

const SPEC: AvatarSpec = { form: "halo", hue: 195, glow: 60, detail: 1, seed: 4242 };
const figureSpec = (figure: FigureSpec, hue = 195): AvatarSpec => ({ ...SPEC, hue, look: { kind: "figure", figure } });
const draw = (spec: AvatarSpec, mood: (typeof MOODS)[number] = "idle", extra: Partial<Parameters<typeof Avatar>[0]> = {}): string => renderToStaticMarkup(createElement(Avatar, { spec, mood, burst: 1, ...extra }));

/** A coordinate that came out as NaN or a part that came out undefined shows up in the markup as those words. */
const clean = (markup: string, what: string): void => assert.ok(!/NaN|undefined|\[object/.test(markup), `${what} drew a broken value: ${markup.match(/.{40}(NaN|undefined|\[object).{20}/)?.[0] ?? ""}`);

function pixelPack(id = "av_1", updatedAt = 5): AvatarPackView {
  let data = blankPixelData(16);
  const frame = new Uint8Array(16 * 16);
  frame.fill(2, 0, 16);
  data = withFrames(data, "idle", 400, [frame]);
  return { id, name: "Pip", kind: "pixel", bytes: 100, createdAt: 1, updatedAt, data };
}

function imagePack(sheet: boolean): AvatarPackView {
  const data: ImagePackData = {
    src: "data:image/png;base64,iVBORw0KGgo=",
    w: 384,
    h: 416,
    crisp: false,
    ...(sheet ? { sheet: { cols: 2, rows: 2, moods: { idle: { row: 0, frames: 2, ms: 200 }, working: { row: 1, frames: 2, ms: 100 } } } } : {}),
  };
  return { id: "av_2", name: "Sheet", kind: "image", bytes: 100, createdAt: 1, updatedAt: 3, data };
}

describe("the catalogue of a figure's parts", () => {
  it("names every part once, and names it in a way the server accepts", () => {
    for (const slot of SLOTS) {
      const parts = CATALOGUE[slot];
      assert.ok(parts.length >= 6, `${slot} has a real choice`);
      assert.equal(new Set(parts.map((p) => p.id)).size, parts.length, `${slot} has no repeated id`);
      assert.equal(new Set(parts.map((p) => p.name)).size, parts.length, `${slot} has no repeated name`);
      for (const p of parts) {
        assert.match(p.id, /^[a-z0-9][a-z0-9-]{0,23}$/, `${slot}.${p.id} is a safe id`);
        assert.ok(p.name.trim().length > 0, `${slot}.${p.id} has a name`);
      }
    }
    assert.ok(BODIES.length >= 12);
  });

  it("starts from parts that exist", () => {
    for (const slot of SLOTS) assert.ok(knownPart(slot, DEFAULT_FIGURE[slot]), `${slot} default exists`);
    assert.equal(partName("body", "blob"), "Round");
    assert.equal(partName("eyes", "no-such-eyes"), "Dots", "an unknown id reads as the plain part");
  });

  it("brings anything into a figure that can be drawn", () => {
    assert.deepEqual(normalizeFigure(null), DEFAULT_FIGURE);
    assert.deepEqual(normalizeFigure(undefined), DEFAULT_FIGURE);
    const odd = normalizeFigure({ body: "hovercraft", top: "cat", eyes: 7 as unknown as string, mouth: "smile", accent: "red" as unknown as number, shade: 12 });
    assert.equal(odd.body, DEFAULT_FIGURE.body, "a part this app has not heard of becomes the plain one");
    assert.equal(odd.top, "cat", "a part it knows stays");
    assert.equal(odd.eyes, DEFAULT_FIGURE.eyes, "a number is not an id");
    assert.equal(odd.accent, null, "anything that is not a hue is the automatic accent, not red");
    assert.equal(odd.shade, 4, "the shade is held inside its range");
    assert.equal(normalizeFigure({ accent: 999 }).accent, 359);
    assert.equal(normalizeFigure({ accent: -20 }).accent, 0);
    assert.equal(normalizeFigure({ accent: 120.4 }).accent, 120);
    assert.equal(normalizeFigure({ shade: -3 }).shade, 0);
  });

  it("compares figures by their parts and colours", () => {
    assert.ok(sameFigure(DEFAULT_FIGURE, { ...DEFAULT_FIGURE }));
    assert.ok(!sameFigure(DEFAULT_FIGURE, { ...DEFAULT_FIGURE, accent: 10 }));
    assert.ok(!sameFigure(DEFAULT_FIGURE, { ...DEFAULT_FIGURE, top: "cat" }));
  });

  it("says in words what a figure is", () => {
    assert.equal(describeFigure(DEFAULT_FIGURE, 195), "a teal round figure with oval eyes");
    assert.equal(describeFigure({ ...DEFAULT_FIGURE, top: "cat", eyes: "round" }, 340), "an orchid round figure with cat ears and bright eyes");
    assert.equal(describeFigure({ ...DEFAULT_FIGURE, eyes: "visor" }, 232), "an ice round figure with a visor");
  });

  it("makes random figures out of known parts, and keeps what it was told to keep", () => {
    const random = rng(99);
    for (let i = 0; i < 60; i += 1) {
      const f = randomFigure(random);
      assert.deepEqual(normalizeFigure(f), f, "every part of a random figure is in the catalogue");
      assert.ok(f.shade >= 1 && f.shade <= 3);
    }
    const base: FigureSpec = { ...DEFAULT_FIGURE, body: "ghost", eyes: "visor", accent: 40, shade: 4 };
    const kept = randomFigure(rng(5), base, { body: true, eyes: true, colour: true });
    assert.equal(kept.body, "ghost");
    assert.equal(kept.eyes, "visor");
    assert.equal(kept.accent, 40);
    assert.equal(kept.shade, 4);
    assert.deepEqual(randomFigure(rng(5), base), randomFigure(rng(5), base), "the same chance gives the same figure");
  });

  it("scatters small touches the same way for the same seed", () => {
    assert.deepEqual(touches(7, 5), touches(7, 5));
    assert.notDeepEqual(touches(7, 5), touches(8, 5));
    for (const t of touches(3, 20)) for (const n of [t.a, t.b, t.c, t.d]) assert.ok(n >= 0 && n < 1);
  });
});

describe("the ready-made characters", () => {
  it("are plenty, each its own, and made of parts that exist", () => {
    assert.ok(PRESETS.length >= 24, "a real choice");
    assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
    assert.equal(new Set(PRESETS.map((p) => p.name)).size, PRESETS.length);
    assert.equal(new Set(PRESETS.map((p) => JSON.stringify([p.figure, p.hue]))).size, PRESETS.length, "no two are the same drawing");
    for (const p of PRESETS) {
      assert.ok(PRESET_GROUPS.includes(p.group), `${p.id} is in a group the page shows`);
      assert.ok(p.blurb.length > 8);
      assert.ok(Number.isInteger(p.hue) && p.hue >= 0 && p.hue <= 359);
      assert.ok(Number.isInteger(p.glow) && p.glow >= 0 && p.glow <= 100);
      assert.deepEqual(normalizeFigure(p.figure), p.figure, `${p.id} uses only parts in the catalogue`);
    }
    for (const g of PRESET_GROUPS) assert.ok(PRESETS.some((p) => p.group === g), `${g} is not empty`);
  });

  it("find themselves again, in whatever colour", () => {
    const fox = presetById("fox");
    assert.ok(fox);
    assert.equal(presetOf(fox.figure)?.id, "fox");
    assert.equal(presetOf({ ...fox.figure, accent: 200, shade: 4 })?.id, "fox", "a fox with another accent is still that fox");
    assert.equal(presetOf({ ...fox.figure, top: "halo" }), undefined);
    assert.ok(sameParts(fox.figure, { ...fox.figure, accent: null, shade: 0 }));
    assert.ok(!sameParts(fox.figure, { ...fox.figure, eyes: "visor" }));
  });
});

describe("drawing a figure", () => {
  it("draws every part of every slot, in every mood, without a broken number", () => {
    for (const slot of SLOTS) {
      for (const part of CATALOGUE[slot]) {
        const spec = figureSpec({ ...DEFAULT_FIGURE, [slot]: part.id });
        for (const mood of MOODS) {
          const markup = draw(spec, mood);
          assert.ok(markup.startsWith("<svg"), `${slot}.${part.id} in ${mood} is an svg`);
          assert.ok(markup.includes('class="av fg"'), "it is a figure");
          assert.ok(markup.includes(`data-mood="${mood}"`));
          clean(markup, `${slot}.${part.id} in ${mood}`);
        }
      }
    }
  });

  it("draws every body with every top, and with every piece of gear", () => {
    for (const body of BODIES) {
      for (const top of CATALOGUE.top) clean(draw(figureSpec({ ...DEFAULT_FIGURE, body: body.id, top: top.id, finish: "metal" })), `${body.id} with ${top.id}`);
      for (const gear of CATALOGUE.gear) clean(draw(figureSpec({ ...DEFAULT_FIGURE, body: body.id, gear: gear.id, mark: "stripes", eyes: "visor" })), `${body.id} wearing ${gear.id}`);
      for (const eyes of CATALOGUE.eyes) clean(draw(figureSpec({ ...DEFAULT_FIGURE, body: body.id, eyes: eyes.id, mark: "mask" }), "delight"), `${body.id} with ${eyes.id}`);
    }
  });

  it("draws every ready-made character in every mood", () => {
    for (const p of PRESETS) {
      for (const mood of MOODS) {
        const markup = draw(figureSpec(p.figure, p.hue), mood, { size: 64, stage: true, look: true });
        clean(markup, `${p.id} in ${mood}`);
        assert.ok(markup.includes('role="img"'));
        assert.ok(markup.includes(`aria-label="`), "it has words for a screen reader");
      }
    }
  });

  it("carries the colour in the style and the finish and shade on the root", () => {
    const markup = draw(figureSpec({ ...DEFAULT_FIGURE, finish: "neon", shade: 4, accent: 40 }, 300));
    assert.ok(markup.includes("--h:300"), "the hue");
    assert.ok(markup.includes("--fa:40"), "an accent that was chosen");
    assert.ok(markup.includes('data-finish="neon"'));
    assert.ok(markup.includes('data-shade="4"'));
    assert.ok(draw(figureSpec(DEFAULT_FIGURE, 100)).includes("--fa:250"), "the automatic accent sits 150 degrees round");
  });

  it("gives each figure on a page gradients and clips of its own", () => {
    const markup = renderToStaticMarkup(createElement(Fragment, null, createElement(Avatar, { spec: figureSpec(DEFAULT_FIGURE) }), createElement(Avatar, { spec: figureSpec(DEFAULT_FIGURE) })));
    const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length > 20);
    assert.equal(new Set(ids).size, ids.length, "no two elements share an id");
  });

  it("describes itself to a screen reader by what it is and what it is doing", () => {
    const markup = draw(figureSpec({ ...DEFAULT_FIGURE, top: "cat" }), "attention", { name: "Vesper" });
    assert.ok(markup.includes('aria-label="Vesper, a teal round figure with cat ears and oval eyes, wants your attention"'));
  });

  it("draws the same figure the same way each time", () => {
    const spec = figureSpec({ ...DEFAULT_FIGURE, mark: "spots", aura: "sparkle" });
    const strip = (m: string) => m.replace(/ id="[^"]+"/g, "").replace(/url\(#[^)]+\)/g, "url(#)");
    assert.equal(strip(draw(spec)), strip(draw(spec)));
    assert.notEqual(strip(draw(spec)), strip(draw({ ...spec, seed: 9 })), "another seed scatters the spots and sparkles elsewhere");
  });

  it("still draws a figure with a part this app has never heard of", () => {
    const markup = draw(figureSpec({ ...DEFAULT_FIGURE, body: "dragon-from-the-future", top: "tophat" }));
    clean(markup, "an unknown part");
    assert.ok(markup.includes('data-look="figure"'));
  });
});

describe("what the assistant wears", () => {
  it("is a sigil unless it says otherwise", () => {
    assert.deepEqual(resolveLook(SPEC, undefined), { kind: "sigil" });
    assert.deepEqual(resolveLook({ ...SPEC, look: { kind: "sigil" } }, undefined), { kind: "sigil" });
    assert.equal(packRef(SPEC), null);
  });

  it("is the figure it carries, made safe to draw", () => {
    const look = resolveLook({ ...SPEC, look: { kind: "figure", figure: { ...DEFAULT_FIGURE, body: "nope" } } }, undefined);
    assert.equal(look.kind, "figure");
    if (look.kind === "figure") assert.equal(look.figure.body, DEFAULT_FIGURE.body);
  });

  it("is a pack once the pack is known, and the plain sigil until then", () => {
    const spec: AvatarSpec = { ...SPEC, look: { kind: "pack", id: "av_1", rev: 5 } };
    assert.deepEqual(packRef(spec), { id: "av_1", rev: 5 });
    assert.deepEqual(resolveLook(spec, undefined), { kind: "sigil" }, "while it loads");
    const pixel = resolveLook(spec, pixelPack());
    assert.equal(pixel.kind, "pixel");
    assert.equal(resolveLook(spec, imagePack(false)).kind, "image");
    const kept: AvatarPackView = { id: "av_3", name: "Foxy", kind: "figure", bytes: 1, createdAt: 1, updatedAt: 1, data: { figure: DEFAULT_FIGURE, hue: 40, glow: 70 } };
    assert.equal(lookOfPack(kept).kind, "figure", "a figure kept in the library is drawn as one");
  });

  it("is told in a few words", () => {
    assert.equal(wornWords(SPEC), "teal halo");
    const fox = presetById("fox");
    assert.ok(fox);
    assert.equal(wornWords(figureSpec(fox.figure, 40)), "ember fox");
    assert.equal(wornWords(figureSpec({ ...fox.figure, accent: 200, shade: 4 }, 300)), "violet fox", "recoloured, it is still a fox");
    assert.equal(wornWords(figureSpec({ ...DEFAULT_FIGURE, body: "ghost" }, 232)), "ice ghost figure");
    const packed: AvatarSpec = { ...SPEC, look: { kind: "pack", id: "av_1", rev: 5 } };
    assert.equal(wornWords(packed, pixelPack()), "pixel art called Pip");
    assert.equal(wornWords(packed, imagePack(true)), "a picture called Sheet");
    assert.equal(wornWords(packed), "a drawing of its own");
  });

  it("is told as a sentence on its home page", () => {
    const fox = presetById("fox");
    assert.ok(fox);
    assert.equal(wornSentence(SPEC), "A teal halo.");
    assert.equal(wornSentence({ ...SPEC, hue: 232 }), "An ice halo.");
    assert.equal(wornSentence(figureSpec(fox.figure, 40)), "An ember fox.");
    const packed: AvatarSpec = { ...SPEC, look: { kind: "pack", id: "av_1", rev: 5 } };
    assert.equal(wornSentence(packed, pixelPack()), "Pixel art called Pip.");
    assert.equal(wornSentence(packed, imagePack(true)), "A picture called Sheet.");
    assert.equal(wornSentence(packed), "A drawing of its own.");
  });

  it("is described to a screen reader whatever it is", () => {
    assert.equal(describeLook(SPEC, "Ancilla", "idle", { kind: "sigil" }), "Ancilla, a teal halo with a bright glow, resting");
    const pixel = resolveLook({ ...SPEC, look: { kind: "pack", id: "av_1", rev: 5 } }, pixelPack());
    assert.equal(describeLook(SPEC, "Ancilla", "working", pixel), "Ancilla, a pixel art avatar called Pip, working");
    const vesper = resolveLook({ ...SPEC, look: { kind: "companion", id: "vesper" } }, undefined);
    assert.equal(vesper.kind, "companion");
    assert.match(describeLook(SPEC, "Ancilla", "idle", vesper), /^Ancilla, Vesper, .*resting$/);
  });

  it("includes studio companions with valid WebP cutouts and renders every companion in every mood", () => {
    assert.equal(COMPANIONS.length, 12);
    assert.equal(new Set(COMPANIONS.map((c) => c.id)).size, COMPANIONS.length);
    assert.equal(new Set(COMPANIONS.map((c) => c.name)).size, COMPANIONS.length);
    for (const group of COMPANION_GROUPS) {
      assert.ok(COMPANIONS.some((c) => c.group === group), `${group} has companions`);
    }
    for (const c of COMPANIONS) {
      assert.match(c.id, /^[a-z0-9][a-z0-9-]{0,31}$/);
      assert.ok(c.src.startsWith("data:image/webp;base64,"), `${c.id} embeds WebP`);
      const bytes = Buffer.from(c.src.slice("data:image/webp;base64,".length), "base64");
      assert.equal(bytes.toString("latin1", 0, 4), "RIFF", `${c.id} RIFF header`);
      assert.equal(bytes.toString("latin1", 8, 12), "WEBP", `${c.id} WEBP header`);
      assert.ok(bytes.length > 2_000 && bytes.length < 40_000, `${c.id} compact cutout (${bytes.length} bytes)`);
      const cSpec: AvatarSpec = { ...SPEC, hue: c.hue, glow: c.glow, look: { kind: "companion", id: c.id } };
      assert.equal(wornWords(cSpec), c.name);
      assert.equal(wornSentence(cSpec), `${c.name}.`);
      for (const mood of MOODS) {
        const markup = draw(cSpec, mood, { name: "Ancilla", stage: true, look: true });
        clean(markup, `${c.id} in ${mood}`);
        assert.ok(markup.includes('class="av cp"'));
        assert.ok(markup.includes(`data-form="${c.id}"`));
        assert.ok(markup.includes('data-look="companion"'));
      }
    }
    assert.equal(companionById("no-such-companion"), undefined);
    assert.deepEqual(resolveLook({ ...SPEC, look: { kind: "companion", id: "no-such-companion" } }, undefined), { kind: "sigil" });
  });
});

describe("an avatar the user drew or brought", () => {
  const packSpec: AvatarSpec = { ...SPEC, look: { kind: "pack", id: "av_1", rev: 5 } };
  const within = (store: PackStore, spec: AvatarSpec, mood: (typeof MOODS)[number] = "idle") => renderToStaticMarkup(createElement(PackProvider, { store, children: createElement(Avatar, { spec, mood }) }));

  it("is drawn from what the cache holds, with the ground under it and the motion of its mood", () => {
    const store = new PackStore();
    store.put(pixelPack());
    const markup = within(store, packSpec, "working");
    assert.ok(markup.includes('data-look="pixel"'));
    assert.ok(markup.includes('class="av pk"'));
    assert.ok(markup.includes('class="av-motion"'));
    assert.ok(markup.includes('data-own="false"'), "resting frames are all it has, so the mood moves it");
    assert.ok(within(store, packSpec, "idle").includes('data-own="true"'), "resting is its own");
    assert.ok(markup.includes('shape-rendering="crispEdges"'));
    clean(markup, "pixel art");
  });

  it("falls back to a light form while the pack loads, or when it is gone", () => {
    const markup = within(new PackStore(), packSpec);
    assert.ok(markup.includes('data-look="sigil"'));
    assert.ok(markup.includes('data-form="halo"'));
  });

  it("draws a picture whole, or one cell of a sheet", () => {
    const store = new PackStore();
    store.put(imagePack(false));
    const whole = within(store, { ...packSpec, look: { kind: "pack", id: "av_2", rev: 3 } });
    assert.ok(whole.includes('data-look="image"'));
    assert.ok(whole.includes('viewBox="0 0 384 416"'));
    assert.ok(whole.includes('href="data:image/png;base64,iVBORw0KGgo="'));
    store.put(imagePack(true));
    const resting = within(store, { ...packSpec, look: { kind: "pack", id: "av_2", rev: 3 } }, "idle");
    assert.ok(resting.includes('viewBox="0 0 192 208"'), "the resting row, first frame");
    const working = within(store, { ...packSpec, look: { kind: "pack", id: "av_2", rev: 3 } }, "working");
    assert.ok(working.includes('viewBox="0 208 192 208"'), "the working row, first frame");
    assert.ok(working.includes('data-own="true"'), "a mood with a row of its own is not also bounced about");
    const asleep = within(store, { ...packSpec, look: { kind: "pack", id: "av_2", rev: 3 } }, "asleep");
    assert.ok(asleep.includes('viewBox="0 0 192 208"') && asleep.includes('data-own="false"'), "a mood with no row wears the resting one and moves in its own way");
  });

  it("is drawn from what a caller hands it, without going through the cache", () => {
    const markup = draw(SPEC, "idle", { render: lookOfPack(pixelPack()) });
    assert.ok(markup.includes('data-look="pixel"'));
  });
});

describe("the cache of avatars", () => {
  const later = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("fetches a pack once, tells the faces when it lands, and fetches again only for a newer revision", async () => {
    const asked: string[] = [];
    const store = new PackStore({
      get: async (id) => {
        asked.push(id);
        return pixelPack(id, 5);
      },
    });
    let told = 0;
    store.subscribe(() => (told += 1));
    assert.equal(store.peek("av_1", 5), undefined);
    store.ensure("av_1", 5);
    store.ensure("av_1", 5);
    await later();
    assert.deepEqual(asked, ["av_1"], "asked once while it was on its way");
    assert.equal(store.peek("av_1", 5)?.name, "Pip");
    assert.ok(told >= 1);
    store.ensure("av_1", 5);
    await later();
    assert.equal(asked.length, 1, "held, so not asked again");
    store.ensure("av_1", 9);
    await later();
    assert.equal(asked.length, 2, "a newer revision is worth asking for");
    assert.equal(store.stale("av_1")?.id, "av_1", "the old picture stays until the new one comes");
  });

  it("keeps showing what it has when the server cannot be reached, and tries again later", async () => {
    let calls = 0;
    let fail = false;
    const store = new PackStore({
      get: async (id) => {
        calls += 1;
        if (fail) throw new Error("offline");
        return pixelPack(id, 5);
      },
    });
    store.ensure("av_1", 5);
    await later();
    fail = true;
    store.ensure("av_1", 8);
    await later();
    assert.equal(store.stale("av_1")?.name, "Pip");
    assert.equal(store.peek("av_1", 8), undefined);
    fail = false;
    store.ensure("av_1", 8);
    await later();
    assert.equal(calls, 3, "it tried again");
  });

  it("holds what it is handed, and lets go of what is deleted", () => {
    const store = new PackStore();
    let told = 0;
    store.subscribe(() => (told += 1));
    store.put(pixelPack("av_9", 2));
    assert.equal(store.peek("av_9", 2)?.id, "av_9");
    assert.equal(store.peek("av_9", 3), undefined, "not new enough");
    store.drop("av_9");
    assert.equal(store.stale("av_9"), undefined);
    assert.equal(told, 2);
    store.drop("av_9");
    assert.equal(told, 2, "nothing changed, so nobody is told");
  });
});
