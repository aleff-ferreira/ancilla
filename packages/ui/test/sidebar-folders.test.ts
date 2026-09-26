import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { ProjectSection } from "../src/components/sidebar/Sidebar.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { groupByProject, type SidebarEntry } from "../src/model/status.js";
import { Store, type AppState } from "../src/model/store.js";
import type { ProjectView } from "../src/types.js";
import { NOW, appState, session } from "./swarm-fixtures.js";

const PROJECT: ProjectView = {
  cwd: "/work/lantern",
  displayName: "lantern",
  pinned: false,
  activityAt: "2026-09-26T14:03:00.000Z",
  defaultAccountId: null,
  folders: [
    { cwd: "/work/lantern", displayName: "lantern" },
    { cwd: "/work/lantern-docs", displayName: "lantern-docs" },
  ],
};

/** A server-rendered component under the app's providers, on the state given. */
function inApp(state: AppState, element: ReturnType<typeof createElement>): string {
  const store = new Store<AppState>(state);
  const controller = { store } as unknown as AncillaController;
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: element }) }));
}

function render(entries: SidebarEntry[], collapsed: boolean): string {
  const group = groupByProject([PROJECT], entries)[0]!;
  const state = appState({ projects: [PROJECT] });
  const noop = () => {};
  return inApp(
    state,
    createElement(ProjectSection, { group, collapsed, activeId: null, now: NOW, dragging: null, over: null, onDragStart: noop, onDragOver: noop, onDrop: noop, onDragEnd: noop }),
  );
}

describe("a project with several folders in the sidebar", () => {
  const entries: SidebarEntry[] = [
    { session: session("a", "In the main folder"), status: "idle" },
    { session: session("b", "In the docs folder", { cwd: "/work/lantern-docs" }), status: "idle" },
  ];

  it("names every folder in the header's tooltip, one per line", () => {
    const markup = render(entries, true);
    assert.match(markup, /title="\/work\/lantern\n\/work\/lantern-docs"/);
    assert.match(markup, /aria-label="lantern"/);
  });

  it("lists threads from every folder, and says which folder a thread outside the main one is in", () => {
    const markup = render(entries, false);
    assert.match(markup, /In the main folder/);
    assert.match(markup, /In the docs folder/);
    const rows = markup.split("<li").slice(1);
    const main = rows.find((row) => row.includes("In the main folder")) ?? "";
    const docs = rows.find((row) => row.includes("In the docs folder")) ?? "";
    assert.doesNotMatch(main, />lantern-docs</, "the main folder's thread needs no folder name");
    assert.match(docs, />lantern-docs</, "the other folder's thread carries the folder's name");
  });
});
