/** A finished run whose report could not be saved as a file says so on its row, and keeps the report. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { ResearchRunRow } from "../src/components/thread/ResearchRunRow.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { defaultPrefs, initialState, Store, type AppState } from "../src/model/store.js";
import type { ResearchRunView } from "../src/types.js";
import { fakeResearchRun } from "./fixtures/research.js";

function render(run: ResearchRunView): string {
  const store = new Store<AppState>({ ...initialState(defaultPrefs("2026-09-26T00:00:00.000Z")), connection: "open" });
  const controller = { store } as unknown as AncillaController;
  const row = createElement(ResearchRunRow, { run, sessionId: "s1", latest: true });
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: row }) }));
}

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const FINISHED = {
  status: "completed",
  phase: "done",
  endedAt: "2026-09-26T00:08:01.000Z",
  reportAvailable: true,
  report: "# Short\n\nOne line.",
  reportPath: null,
} as const;

describe("a research report that could not be saved as a file", () => {
  it("says why on the run's row, beside the report that is still there", () => {
    const message = "Ancilla saves what it keeps for a project inside the project, and /work/app/.ancilla is a link (a symbolic link or a junction), so it will not write there.";
    const shown = text(render(fakeResearchRun({ ...FINISHED, reportWriteError: message })));
    assert.match(shown, /could not be saved as a file in the project/);
    assert.ok(shown.includes("/work/app/.ancilla is a link"), "the message the server gave is shown whole");
    assert.match(shown, /One line\./, "and the report itself is still shown");
  });

  it("is silent for a run whose report was saved, and for one that never had a problem", () => {
    const saved = text(render(fakeResearchRun({ ...FINISHED, reportPath: ".ancilla/research/run-1/report.md" })));
    assert.doesNotMatch(saved, /could not be saved/);
    assert.doesNotMatch(text(render(fakeResearchRun({ ...FINISHED, reportWriteError: null }))), /could not be saved/);
  });
});
