import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { FrameProvider, WindowControls, type WindowFrame } from "../src/app/frame.js";
import { SettingsPage } from "../src/components/settings/SettingsPage.js";
import { Sidebar } from "../src/components/sidebar/Sidebar.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import { UsagePage } from "../src/components/usage/UsagePage.js";
import type { AncillaController } from "../src/model/controller.js";
import { defaultPrefs, initialState, Store, type AppState } from "../src/model/store.js";

function renderPageUnderStore(PageComponent: ComponentType, isSidebarCollapsed: boolean): string {
  const applicationStore = new Store<AppState>({
    ...initialState({
      ...defaultPrefs("2026-10-01T00:00:00.000Z"),
      sidebarCollapsed: isSidebarCollapsed,
    }),
    connection: "open",
  });

  const mockController = {
    store: applicationStore,
    loadAccounts: async () => {},
  } as unknown as AncillaController;

  return renderToStaticMarkup(
    createElement(ControllerProvider, {
      controller: mockController,
      children: createElement(TooltipProvider, {
        children: createElement(PageComponent),
      }),
    }),
  );
}

describe("Window drag region presence on full-page views", () => {
  const viewComponents = [
    ["Settings", SettingsPage],
    ["Usage", UsagePage],
  ] as const;

  for (const [viewTitle, Component] of viewComponents) {
    for (const isCollapsed of [false, true]) {
      it(`${viewTitle} outputs data-drag-region prior to main heading when sidebar is ${isCollapsed ? "collapsed" : "expanded"}`, () => {
        const staticHtml = renderPageUnderStore(Component, isCollapsed);
        const headingIndex = staticHtml.indexOf("<h1");

        assert.ok(headingIndex > 0, `${viewTitle} view must contain a primary <h1 heading`);
        assert.match(
          staticHtml.slice(0, headingIndex),
          /data-drag-region/,
          `${viewTitle} header must include data-drag-region attribute`,
        );
      });
    }
  }
});

describe("WindowControls caption glyphs and Sidebar dropdown triggers", () => {
  it("renders single-codepoint Fluent caption glyphs for Minimize, Maximize, and Close", () => {
    const fakeFrame: WindowFrame = {
      minimize: () => {},
      toggleMaximize: () => {},
      close: () => {},
      startDragging: () => {},
      isMaximized: async () => false,
      onResized: () => () => {},
    };

    const html = renderToStaticMarkup(
      createElement(FrameProvider, {
        frame: fakeFrame,
        children: createElement(WindowControls),
      }),
    );

    assert.doesNotMatch(html, /\\u/i, "Caption buttons must not render unescaped literal \\u sequences");
    assert.match(html, /aria-label="Minimize"[^>]*><span aria-hidden="true">\uE921<\/span><\/button>/);
    assert.match(html, /aria-label="Maximize"[^>]*><span aria-hidden="true">\uE922<\/span><\/button>/);
    assert.match(html, /aria-label="Close"[^>]*><span aria-hidden="true">\uE8BB<\/span><\/button>/);
  });

  it("wires Radix menu trigger props onto Group threads, Updates, and Theme sidebar buttons", () => {
    const applicationStore = new Store<AppState>({
      ...initialState(defaultPrefs("2026-10-01T00:00:00.000Z")),
      connection: "open",
      updates: {
        status: "upToDate",
        currentVersion: "0.29.2",
        update: null,
        progress: null,
        error: null,
        checkedAt: 1_700_000_000_000,
      },
    });
    const mockController = { store: applicationStore } as unknown as AncillaController;

    const html = renderToStaticMarkup(
      createElement(ControllerProvider, {
        controller: mockController,
        children: createElement(TooltipProvider, {
          children: createElement(Sidebar),
        }),
      }),
    );

    assert.match(html, /<button[^>]*aria-label="Group threads"[^>]*aria-haspopup="menu"/);
    assert.match(html, /<button[^>]*aria-label="Updates"[^>]*aria-haspopup="menu"/);
    assert.match(html, /<button[^>]*aria-label="Theme"[^>]*aria-haspopup="menu"/);
  });
});
