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
import { NOW, appState, session } from "./crew-fixtures.js";

function buildMockProject(customFolders?: Array<{ cwd: string; displayName: string }>): ProjectView {
  const directoryEntries = customFolders ?? [
    { cwd: "/work/lantern", displayName: "lantern" },
    { cwd: "/work/lantern-docs", displayName: "lantern-docs" },
  ];
  return {
    displayName: "lantern",
    cwd: "/work/lantern",
    defaultAccountId: null,
    pinned: false,
    activityAt: "2026-09-26T14:03:00.000Z",
    folders: directoryEntries,
  };
}

function renderProjectSectionInApp(
  projectDef: ProjectView,
  sidebarList: SidebarEntry[],
  collapsedState: boolean,
): string {
  const groupedProjects = groupByProject([projectDef], sidebarList);
  const targetGroup = groupedProjects[0]!;
  const mockedState = appState({ projects: [projectDef] });

  const dummyStore = new Store<AppState>(mockedState);
  const dummyController = { store: dummyStore } as unknown as AncillaController;
  const noopCallback = () => {};

  const sectionProps = {
    group: targetGroup,
    collapsed: collapsedState,
    activeId: null,
    now: NOW,
    dragging: null,
    over: null,
    onDragStart: noopCallback,
    onDragOver: noopCallback,
    onDrop: noopCallback,
    onDragEnd: noopCallback,
  };

  const innerComponent = createElement(ProjectSection, sectionProps);
  const wrappedWithTooltip = createElement(TooltipProvider, { children: innerComponent });
  return renderToStaticMarkup(
    createElement(ControllerProvider, { controller: dummyController, children: wrappedWithTooltip }),
  );
}

describe("Sidebar ProjectSection Multi-Folder Tooltip", () => {
  it("formats every registered directory path on consecutive lines within header title tooltip", () => {
    const projectModel = buildMockProject();
    const mockSessions: SidebarEntry[] = [
      { session: session("a", "In the main folder"), status: "idle" },
      { session: session("b", "In the docs folder", { cwd: "/work/lantern-docs" }), status: "idle" },
    ];

    const renderedHtml = renderProjectSectionInApp(projectModel, mockSessions, true);

    assert.match(renderedHtml, /title="\/work\/lantern\n\/work\/lantern-docs"/);
    assert.match(renderedHtml, /aria-label="lantern"/);
  });
});

describe("Sidebar ProjectSection Thread Grouping & Secondary Folder Badging", () => {
  it("displays threads across folders while labelling only sessions outside root directory", () => {
    const projectModel = buildMockProject();
    const mockSessions: SidebarEntry[] = [
      { session: session("a", "In the main folder"), status: "idle" },
      { session: session("b", "In the docs folder", { cwd: "/work/lantern-docs" }), status: "idle" },
    ];

    const renderedHtml = renderProjectSectionInApp(projectModel, mockSessions, false);

    assert.match(renderedHtml, /In the main folder/);
    assert.match(renderedHtml, /In the docs folder/);

    const listElements = renderedHtml.split("<li").slice(1);
    const mainThreadElement = listElements.find((fragment) => fragment.includes("In the main folder")) ?? "";
    const docsThreadElement = listElements.find((fragment) => fragment.includes("In the docs folder")) ?? "";

    assert.doesNotMatch(
      mainThreadElement,
      />lantern-docs</,
      "Root folder session should not render secondary directory chip",
    );
    assert.match(
      docsThreadElement,
      />lantern-docs</,
      "Secondary folder session must display designated directory badge",
    );
  });
});
