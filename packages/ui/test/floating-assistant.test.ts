import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import { CallDock } from "../src/components/voice/CallDock.js";
import type { AncillaController } from "../src/model/controller.js";
import { Store, defaultPrefs, initialState, revivePrefs, type AppState, type AssistantGlance } from "../src/model/store.js";
import {
  ASSISTANT_AVATAR_DEFAULT,
  ASSISTANT_AVATAR_MAX,
  ASSISTANT_AVATAR_MIN,
  AVATAR_SIZE_PRESETS,
  anchorFromRect,
  bubblePlacement,
  cardAvatarSize,
  clampAvatarSize,
  isValidAnchor,
  resolveFloatingPosition,
  stepAvatarSize,
} from "../src/model/voice/floatingWindow.js";

const GLANCE: AssistantGlance = {
  enabled: true,
  name: "GlaDOS",
  open: 0,
  needsYou: 0,
  running: 0,
  character: {
    avatar: { form: "halo", hue: 24, glow: 68, detail: 1, seed: 7, look: { kind: "companion", id: "vesper" } },
    voice: { archetype: "steady", warmth: 2, humor: 2, directness: 3, curiosity: 2, formality: 1 },
    callsUser: "Aleff",
    quirks: [],
    presence: "tone",
    showBond: true,
    setupAt: 1700000000000,
  },
};

describe("movable assistant window and avatar sizing", () => {
  it("clamps and steps avatar sizes cleanly across presets and bounds", () => {
    assert.equal(clampAvatarSize(undefined), ASSISTANT_AVATAR_DEFAULT);
    assert.equal(clampAvatarSize(Number.NaN), ASSISTANT_AVATAR_DEFAULT);
    assert.equal(clampAvatarSize(12), ASSISTANT_AVATAR_MIN);
    assert.equal(clampAvatarSize(999), ASSISTANT_AVATAR_MAX);
    assert.equal(clampAvatarSize(148.4), 148);
    assert.equal(stepAvatarSize(108, 2), 132);
    assert.equal(stepAvatarSize(ASSISTANT_AVATAR_MAX, 3), ASSISTANT_AVATAR_MAX);
    assert.equal(stepAvatarSize(ASSISTANT_AVATAR_MIN, -3), ASSISTANT_AVATAR_MIN);
    for (const preset of AVATAR_SIZE_PRESETS) {
      assert.ok(preset.size >= ASSISTANT_AVATAR_MIN && preset.size <= ASSISTANT_AVATAR_MAX);
      assert.ok(cardAvatarSize(preset.size) >= 52 && cardAvatarSize(preset.size) <= 132);
    }
  });

  it("places default spot clear of bottom bars and clamps custom anchors across resizes and mode switches", () => {
    const home = resolveFloatingPosition({
      anchor: null,
      viewportWidth: 1280,
      viewportHeight: 800,
      boxWidth: 144,
      boxHeight: 170,
    });
    assert.equal(home.left, 1280 - 144 - 20);
    assert.equal(home.top, 800 - 170 - 72, "leaves clearance for bottom composer and browser bars");

    const topLeftAnchor = anchorFromRect({ left: 24, top: 30, width: 140, height: 160 }, 1440, 900);
    assert.equal(isValidAnchor(topLeftAnchor), true);

    const restored = resolveFloatingPosition({
      anchor: topLeftAnchor,
      viewportWidth: 1440,
      viewportHeight: 900,
      boxWidth: 140,
      boxHeight: 160,
    });
    assert.ok(Math.abs(restored.left - 24) <= 2);
    assert.ok(Math.abs(restored.top - 30) <= 2);

    // Switching from compact float to a 368x420 card near the bottom-right corner never clips off-screen.
    const cornerAnchor = { xRatio: 0.96, yRatio: 0.94 };
    const expandedCard = resolveFloatingPosition({
      anchor: cornerAnchor,
      viewportWidth: 1024,
      viewportHeight: 720,
      boxWidth: 368,
      boxHeight: 420,
      margin: 14,
    });
    assert.ok(expandedCard.left + 368 <= 1024 - 14);
    assert.ok(expandedCard.top + 420 <= 720 - 14);
  });

  it("opens speech and approval bubbles toward whichever side of the screen has room", () => {
    const onRight = bubblePlacement({ left: 1040, top: 520, width: 148, height: 180 }, 1280, 800);
    assert.equal(onRight.side, "left");
    assert.equal(onRight.align, "bottom");

    const onLeft = bubblePlacement({ left: 32, top: 48, width: 148, height: 180 }, 1280, 800);
    assert.equal(onLeft.side, "right");
    assert.equal(onLeft.align, "top");
  });

  it("persists and validates floating assistant preferences in revivePrefs", () => {
    const fallback = defaultPrefs("2026-11-11T00:00:00.000Z");
    assert.equal(fallback.assistantFloat, false);
    assert.equal(fallback.assistantWindowMode, "float");
    assert.equal(fallback.assistantAvatarSize, ASSISTANT_AVATAR_DEFAULT);
    assert.equal(fallback.assistantPosition, null);

    const valid = revivePrefs(
      {
        assistantFloat: true,
        assistantWindowMode: "card",
        assistantAvatarSize: 180,
        assistantPosition: { xRatio: 0.25, yRatio: 0.4 },
      },
      fallback,
    );
    assert.equal(valid.assistantFloat, true);
    assert.equal(valid.assistantWindowMode, "card");
    assert.equal(valid.assistantAvatarSize, 180);
    assert.deepEqual(valid.assistantPosition, { xRatio: 0.25, yRatio: 0.4 });

    const clamped = revivePrefs(
      {
        assistantFloat: "yes",
        assistantWindowMode: "bogus",
        assistantAvatarSize: 500,
        assistantPosition: { xRatio: 2.5, yRatio: -1 },
      },
      fallback,
    );
    assert.equal(clamped.assistantFloat, false);
    assert.equal(clamped.assistantWindowMode, "float");
    assert.equal(clamped.assistantAvatarSize, ASSISTANT_AVATAR_MAX);
    assert.equal(clamped.assistantPosition, null);
  });

  it("renders a frameless floating companion at the chosen avatar size when pinned on screen", () => {
    const renderDock = (patch: Partial<AppState>): string => {
      const base = initialState(defaultPrefs("2026-11-11T00:00:00.000Z"));
      const store = new Store<AppState>({ ...base, connection: "open", ...patch });
      const controller = {
        store,
        hasVoice: true,
        setPrefs: () => {},
        navigate: () => {},
        voice: async () => null,
      } as unknown as AncillaController;
      return renderToStaticMarkup(
        createElement(ControllerProvider, {
          controller,
          children: createElement(TooltipProvider, { children: createElement(CallDock) }),
        }),
      );
    };

    assert.equal(renderDock({ assistantGlance: GLANCE }), "", "hidden outside a call when not pinned");

    const html = renderDock({
      assistantGlance: GLANCE,
      prefs: {
        ...defaultPrefs("2026-11-11T00:00:00.000Z"),
        assistantFloat: true,
        assistantAvatarSize: 172,
      },
    });
    assert.match(html, /aria-label="GlaDOS floating companion"/);
    assert.match(html, /width:172px;height:172px/, "applies the user's avatar size in pixels");
    assert.match(html, /assistant-float-avatar/);
    assert.doesNotMatch(html, /class="av-stage"/, "avatar floats framelessly without an opaque stage disc");
    assert.match(html, /aria-label="Avatar size and placement"/);
    assert.match(html, /aria-label="Talk to GlaDOS"/);
  });
});
