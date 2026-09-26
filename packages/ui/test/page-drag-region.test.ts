import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { SettingsPage } from "../src/components/settings/SettingsPage.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import { UsagePage } from "../src/components/usage/UsagePage.js";
import type { AncillaController } from "../src/model/controller.js";
import { defaultPrefs, initialState, Store, type AppState } from "../src/model/store.js";

/** A server-rendered page, with the sidebar open or collapsed. */
function render(Page: ComponentType, sidebarCollapsed: boolean): string {
  const store = new Store<AppState>({ ...initialState({ ...defaultPrefs("2026-09-26T00:00:00.000Z"), sidebarCollapsed }), connection: "open" });
  const controller = { store, loadAccounts: async () => {} } as unknown as AncillaController;
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: createElement(Page) }) }));
}

// On Windows the shell moves the window only from a `data-drag-region` surface, so a page that starts without
// one, as Settings did with the sidebar open, cannot be dragged at all.
describe("pages the sidebar opens", () => {
  for (const [name, Page] of [
    ["Settings", SettingsPage],
    ["Usage", UsagePage],
  ] as const) {
    for (const collapsed of [false, true]) {
      it(`${name} starts with a drag region with the sidebar ${collapsed ? "collapsed" : "open"}`, () => {
        const markup = render(Page, collapsed);
        const head = markup.indexOf(`<h1`);
        assert.ok(head > 0, "the page has a heading");
        assert.match(markup.slice(0, head), /data-drag-region/);
      });
    }
  }
});
