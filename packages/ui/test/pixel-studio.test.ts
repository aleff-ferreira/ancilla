import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blankPixelData, emptyFrame, packFrame, stamp } from "../src/components/assistant/companion/pixel/pixel.js";
import { PixelStudio, type PixelStudioProps } from "../src/components/assistant/companion/pixel/PixelStudio.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { PixelData } from "../src/types.js";

const text = (markup: string): string => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const studio = (props: Partial<PixelStudioProps> = {}): string =>
  renderToStaticMarkup(createElement(TooltipProvider, { children: createElement(PixelStudio, { onSave: () => undefined, onCancel: () => undefined, ...props }) }));

const drawn = (): PixelData => {
  const frame = stamp(emptyFrame(16, 16), 16, 16, [[3, 3], [4, 3]], 1);
  const base = blankPixelData(16, "pico");
  return { ...base, moods: { idle: { ms: 400, frames: [packFrame(frame)] }, working: { ms: 120, frames: [packFrame(frame), packFrame(emptyFrame(16, 16))] } } };
};

describe("the pixel studio", () => {
  it("opens on a choice of size and palette when there is nothing to edit", () => {
    const markup = studio();
    const words = text(markup);
    assert.match(words, /Canvas size/);
    assert.match(words, /16 by 16 .* 64 by 64/);
    assert.match(words, /Starter palette/);
    assert.match(words, /Ancilla 16 colours/);
    assert.match(words, /Gameboy 4 colours/);
    assert.match(words, /Start drawing/);
    assert.match(markup, /aria-pressed="true"[^>]*>24 by 24</, "a middle size to begin with");
    assert.doesNotMatch(markup, /role="toolbar"/, "no tools before there is a canvas");
  });

  it("lays out tools, canvas and panels for a drawing, with every tool named and its state told", () => {
    const markup = studio({ initial: drawn(), name: "Blinky" });
    assert.match(markup, /class="pixel-studio @container"/, "it measures itself, not the page");
    assert.match(markup, /role="toolbar" aria-label="Tools"/);
    for (const [name, key] of [["Pencil", "B"], ["Eraser", "E"], ["Fill", "G"], ["Colour picker", "I"], ["Line", "L"], ["Rectangle", "R"], ["Ellipse", "O"], ["Move", "V"]]) {
      assert.match(markup, new RegExp(`aria-label="${name} \\(${key}\\)" aria-pressed="(true|false)"`), `${name} is a toggle button with its shortcut`);
    }
    assert.match(markup, /aria-label="Pencil \(B\)" aria-pressed="true"/, "the pencil is in hand to begin with");
    assert.equal((markup.match(/aria-label="[^"]+ \([A-Z]\)" aria-pressed="true"/g) ?? []).length, 1, "one tool at a time");
    assert.match(markup, /<canvas[^>]*role="img"[^>]*aria-label="Pixel canvas, 16 by 16 cells, Resting, frame 1 of 1\. Arrow keys move the cursor; Space or Enter uses the pencil\."/);
    assert.match(markup, /<canvas[^>]*tabindex="0"/, "the canvas takes focus for keyboard painting");
    assert.match(markup, /touch-action:\s*none/, "touch and pen draw instead of scrolling");
    assert.match(markup, /role="status" aria-live="polite"/);
    assert.match(markup, /aria-label="Mirror: No mirror \(M cycles\)" aria-pressed="false"/);
    assert.match(markup, /aria-label="Undo \(Ctrl\+Z\)"[^>]*disabled=""/, "nothing to undo yet");
  });

  it("shows the palette with clear first, the mood tabs with a mark on those that have frames, and the preview in every mood", () => {
    const markup = studio({ initial: drawn() });
    assert.match(markup, /aria-label="Clear" aria-pressed="false"/);
    assert.match(markup, /aria-label="Colour 1, #000000" aria-pressed="true"/, "the first colour is in hand");
    assert.equal((markup.match(/aria-label="Colour \d+, #[0-9a-f]{6}"/g) ?? []).length, 16);
    assert.match(markup, /role="tab" aria-selected="true" aria-label="Resting, has its own frames"/);
    assert.match(markup, /role="tab" aria-selected="false" aria-label="Working, has its own frames"/);
    assert.match(markup, /role="tab" aria-selected="false" aria-label="Asleep"/);
    assert.equal((markup.match(/role="tab"/g) ?? []).length, 6);
    assert.equal((markup.match(/aria-label="Frame \d of 1"/g) ?? []).length, 1);
    const words = text(markup);
    assert.match(words, /In every mood Resting Working Needs you Pleased Concerned Asleep/);
    assert.equal((markup.match(/class="av-sprite"/g) ?? []).length, 6);
    assert.equal((markup.match(/fill="oklch\(0\.2 0\.03 260\)"/g) ?? []).length, 6, "each on the stage disc");
    assert.match(words, /The resting mood keeps at least one frame/);
    assert.match(words, /Frame time 400 ms/);
  });

  it("uses the caller's preview when it offers one", () => {
    const markup = studio({ initial: drawn(), renderPreview: (_data, mood) => createElement("i", { "data-mood": mood }) });
    assert.equal((markup.match(/<i data-mood="/g) ?? []).length, 6);
    assert.doesNotMatch(markup, /class="av-sprite"/);
  });

  it("has a name to give, a reason while saving is not possible, and an alert for an error", () => {
    const blank = studio({ initial: blankPixelData(16) });
    assert.match(blank, /value="My pixel avatar"/);
    assert.match(text(blank), /Draw something first/);
    assert.match(blank, />Save<\/button>/);
    assert.match(blank, /disabled=""[^>]*aria-disabled="true"[^>]*title="Draw something first">Save</);
    const named = studio({ initial: drawn(), name: "Blinky", error: "The server said no." });
    assert.match(named, /value="Blinky"/);
    assert.match(named, /role="alert"[^>]*>The server said no\.</);
    assert.doesNotMatch(text(named), /Draw something first/);
    assert.match(studio({ initial: drawn(), saving: true }), /aria-busy="true"/);
  });

  it("tells a mood without frames what it wears and offers the resting frames", () => {
    const data = drawn();
    const markup = studio({ initial: data });
    assert.doesNotMatch(text(markup), /wears the resting frames/, "the resting mood is in view first");
    assert.match(text(markup), /Import a picture Choose a file/);
    assert.match(markup, /accept="image\/\*"/);
    assert.match(text(markup), /Export This frame as PNG Sprite sheet/);
    assert.match(text(markup), /Canvas 16 by 16/);
    assert.match(markup, /aria-label="New size"/);
  });
});
