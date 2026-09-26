import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { ResearchRunRow } from "../src/components/thread/ResearchRunRow.js";
import { Transcript } from "../src/components/thread/Transcript.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { emptyFold } from "../src/model/fold.js";
import { phaseLine, researchClock, sourcesLine, workerChip } from "../src/model/research.js";
import { defaultPrefs, initialState, Store, type AppState, type ThreadState } from "../src/model/store.js";
import type { ResearchRunView, ResearchWorkerView } from "../src/types.js";
import { fakeResearchRun } from "./fixtures/research.js";

function worker(over: Partial<ResearchWorkerView>): ResearchWorkerView {
  return { agentId: 1, round: 1, topic: "pricing models", discovery: false, state: "working", toolCalls: 5, searches: 3, reads: 2, saved: 0, startedAt: "2026-09-26T00:00:30.000Z", endedAt: null, ...over };
}

/** A server-rendered row, with the store the row's hooks read. */
function render(run: ResearchRunView, state: Partial<AppState> = {}): string {
  const store = new Store<AppState>({ ...initialState(defaultPrefs("2026-09-26T00:00:00.000Z")), connection: "open", ...state });
  const controller = { store } as unknown as AncillaController;
  const row = createElement(ResearchRunRow, { run, sessionId: "s1" });
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: row }) }));
}

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("ResearchRunRow", () => {
  it("says the run is waiting while it is queued, with no Stop yet for an optimistic row", () => {
    const markup = render(fakeResearchRun({ runId: "pending:abc", status: "queued", phase: "scoping", startedAt: null, researchDeadlineAt: null }));
    assert.match(text(markup), /Deep research/);
    assert.match(text(markup), /Queued/);
    assert.match(markup, /data-research-phase[^>]*>Waiting for a slot</);
    assert.doesNotMatch(markup, /aria-label="Stop the research run"/, "a run the server has not confirmed cannot be stopped yet");
  });

  it("shows the phase for each running phase", () => {
    assert.equal(phaseLine({ status: "running", phase: "scoping", round: 0, maxRounds: 12 }), "Scoping the question");
    assert.equal(phaseLine({ status: "running", phase: "drafting", round: 0, maxRounds: 12 }), "Drafting");
    assert.equal(phaseLine({ status: "running", phase: "researching", round: 2, maxRounds: 12 }), "Researching, round 2 of 12");
    assert.equal(phaseLine({ status: "running", phase: "writing", round: 3, maxRounds: 12 }), "Writing the report");
    const markup = render(fakeResearchRun({ phase: "researching", round: 2 }));
    assert.match(markup, /data-research-phase[^>]*>Researching, round 2 of 12</);
    assert.match(markup, /aria-label="Stop the research run"/);
  });

  it("renders a chip per worker with its counts and state, and the source and token counts", () => {
    const run = fakeResearchRun({
      workers: [worker({}), worker({ agentId: 2, topic: "regulation", state: "completed", searches: 2, reads: 4, saved: 1, endedAt: "2026-09-26T00:02:00.000Z" }), worker({ agentId: 3, topic: "outlook", state: "failed", searches: 1, reads: 0 })],
      sources: { registry: 12, verified: 9, curated: 4 },
      usage: { inputTokens: 90_000, outputTokens: 4_000, cachedInputTokens: 0, totalTokens: 94_000 },
    });
    const markup = render(run);
    assert.equal(workerChip(worker({})), "A1 · pricing models · 3 searches · 2 reads");
    assert.match(text(markup), /A1 · pricing models · 3 searches · 2 reads/);
    assert.match(text(markup), /A2 · regulation · 2 searches · 4 reads · 1 saved/);
    assert.match(text(markup), /A3 · outlook · 1 search/);
    assert.equal((markup.match(/data-worker-state="working"/g) ?? []).length, 1);
    assert.equal((markup.match(/data-worker-state="failed"/g) ?? []).length, 1);
    assert.match(text(markup), /Failed/, "the failed worker's state is in words, not colour alone");
    assert.equal(sourcesLine(run.sources), "12 sources · 9 verified · 4 curated");
    assert.match(text(markup), /12 sources · 9 verified · 4 curated/);
    assert.match(text(markup), /94(\.0)?K tokens|94,000 tokens|94k tokens/i);
  });

  it("reads elapsed and remaining time off the run's clocks", () => {
    const now = Date.parse("2026-09-26T00:04:01.000Z");
    const live = researchClock(fakeResearchRun({}), now);
    assert.equal(live.elapsedMs, 4 * 60_000);
    assert.equal(live.remainingMs, 6 * 60_000);
    const ended = researchClock(fakeResearchRun({ status: "completed", endedAt: "2026-09-26T00:08:01.000Z" }), now);
    assert.equal(ended.elapsedMs, 8 * 60_000);
    assert.equal(ended.remainingMs, null, "a finished run has nothing left in its window");
    assert.deepEqual(researchClock(fakeResearchRun({ status: "queued", startedAt: null }), now), { elapsedMs: null, remainingMs: null });
  });

  it("renders the report through Markdown once complete, folded past a screen's worth, with Copy and Open", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1} cites a source [${(i % 3) + 1}].`);
    const report = `# Geothermal in Europe\n\n${lines.join("\n\n")}\n\n## Sources\n\n[1] A page (https://example.com/a)\n`;
    const markup = render(fakeResearchRun({ status: "completed", phase: "done", endedAt: "2026-09-26T00:08:01.000Z", reportAvailable: true, report, reportPath: "/work/app/.ancilla/research/run-1/report.md" }));
    assert.match(markup, /<h1>Geothermal in Europe<\/h1>/);
    assert.match(text(markup), /Report/);
    assert.match(text(markup), /Show all/);
    assert.match(markup, /max-h-\[300px\]/, "a long report starts folded");
    assert.match(markup, /aria-label="Copy the report"/);
    assert.match(text(markup), /Open report\.md/);
    assert.doesNotMatch(markup, /aria-label="Stop the research run"/);
    assert.doesNotMatch(markup, /data-research-phase/);
  });

  it("shows a short report in full and says it is reading one it does not have yet", () => {
    const short = render(fakeResearchRun({ status: "completed", phase: "done", reportAvailable: true, report: "# Short\n\nOne line [1].\n\n## Sources\n\n[1] A (https://example.com)" }));
    assert.doesNotMatch(text(short), /Show all/);
    assert.doesNotMatch(short, /max-h-\[300px\]/);
    const pending = render(fakeResearchRun({ status: "completed", phase: "done", reportAvailable: true, report: null }));
    assert.match(text(pending), /Reading the report/);
  });

  it("marks a partial report with the failure that cut the run short", () => {
    const markup = render(fakeResearchRun({ status: "partial", phase: "done", reportAvailable: true, report: "# Partial\n\nWhat we had.", failure: "the window ended with two workers still out" }));
    assert.match(text(markup), /Partial report/);
    assert.match(text(markup), /Written from what the workers had found: the window ended with two workers still out/);
    assert.match(markup, /<h1>Partial<\/h1>/);
  });

  it("says why a failed, stopped or interrupted run has no report, and offers a Resume that is not here yet", () => {
    const failed = render(fakeResearchRun({ status: "failed", phase: "done", failure: "Muse refused the model call: quota exhausted" }));
    assert.match(text(failed), /Failed/);
    assert.match(text(failed), /quota exhausted/);
    assert.doesNotMatch(failed, /Resume/);
    const cancelled = render(fakeResearchRun({ status: "cancelled", phase: "done", failure: null }));
    assert.match(text(cancelled), /Stopped before it wrote a report/);
    const interrupted = render(fakeResearchRun({ status: "interrupted", phase: "researching", failure: null }));
    assert.match(text(interrupted), /Interrupted/);
    assert.match(text(interrupted), /Ancilla restarted while the run was going/);
    assert.match(interrupted, /<button[^>]*disabled=""[^>]*>Resume<\/button>/);
  });

  it("sits in the transcript by the time it was created, beside the turns", () => {
    const thread: ThreadState = {
      load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, fold: emptyFold(), attachments: [], shellRuns: [],
      researchRuns: [fakeResearchRun({ runId: "r-old", status: "completed", phase: "done", createdAt: "2026-09-25T00:00:00.000Z", reportAvailable: true, report: "# Old" }), fakeResearchRun({ runId: "r-new" })],
      stalled: false,
    };
    const store = new Store<AppState>({ ...initialState(defaultPrefs("2026-09-26T00:00:00.000Z")), connection: "open", threads: { s1: thread } });
    const controller = { store } as unknown as AncillaController;
    const markup = renderToStaticMarkup(
      createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: createElement(Transcript, { sessionId: "s1", thread }) }) }),
    );
    const rows = [...markup.matchAll(/data-research-status="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(rows, ["completed", "running"], "the older run comes first");
  });
});
