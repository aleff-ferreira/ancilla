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
import {
  NOTHING_TYPED,
  RESEARCH_LIMITS,
  clampResearchNumber,
  newestReportedRun,
  phaseLine,
  popoverOverrides,
  preferredStopAction,
  reportView,
  researchClock,
  researchSnapshotCurrent,
  settleStopping,
  sourcesLine,
  workerChip,
} from "../src/model/research.js";
import { defaultPrefs, initialState, Store, type AppState, type ThreadState } from "../src/model/store.js";
import type { ResearchRunView, ResearchWorkerView } from "../src/types.js";
import { fakeResearchRun } from "./fixtures/research.js";

function worker(over: Partial<ResearchWorkerView>): ResearchWorkerView {
  return { agentId: 1, round: 1, topic: "pricing models", discovery: false, state: "working", toolCalls: 5, searches: 3, reads: 2, saved: 0, startedAt: "2026-09-26T00:00:30.000Z", endedAt: null, ...over };
}

/** A server-rendered row, with the store the row's hooks read; the row is the thread's newest run unless told otherwise. */
function render(run: ResearchRunView, state: Partial<AppState> = {}, latest = true): string {
  const store = new Store<AppState>({ ...initialState(defaultPrefs("2026-09-26T00:00:00.000Z")), connection: "open", ...state });
  const controller = { store } as unknown as AncillaController;
  const row = createElement(ResearchRunRow, { run, sessionId: "s1", latest });
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: row }) }));
}

/** The transcript of a thread holding `runs` and no turns, server-rendered. */
function renderThread(runs: ResearchRunView[]): string {
  const thread: ThreadState = {
    load: "ready", error: null, readOnly: false, readOnlyReason: null, truncated: false, fold: emptyFold(), attachments: [], shellRuns: [],
    researchRuns: runs,
    stalled: false,
  };
  const store = new Store<AppState>({ ...initialState(defaultPrefs("2026-09-26T00:00:00.000Z")), connection: "open", threads: { s1: thread } });
  const controller = { store } as unknown as AncillaController;
  return renderToStaticMarkup(
    createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: createElement(Transcript, { sessionId: "s1", thread }) }) }),
  );
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

  it("makes a plain click on Stop do what the popover's switch prefers, with the other way behind the chevron", () => {
    assert.equal(preferredStopAction(true), "write");
    assert.equal(preferredStopAction(false), "now");
    const writes = render(fakeResearchRun({}));
    assert.match(writes, /aria-label="Stop the research run"[^>]*data-stop-action="write"/);
    assert.match(writes, /title="Stops the workers and writes a report from what they have found"/);
    assert.match(writes, /aria-label="Other ways to stop"/);
    const drops = render(fakeResearchRun({}), { researchStopWrites: false });
    assert.match(drops, /aria-label="Stop the research run"[^>]*data-stop-action="now"/);
    assert.match(drops, /title="Stops the workers and drops what they have found"/);
    assert.match(drops, /aria-label="Other ways to stop"/);
  });

  it("says the run is stopping, and takes Stop away, from the moment a stop is asked for", () => {
    const writing = render(fakeResearchRun({}), { researchStopping: { "run-1": "write" } });
    assert.match(writing, /data-research-phase[^>]*>Stopping, writing the report…</);
    assert.match(writing, /<button[^>]*disabled=""[^>]*aria-label="Stop the research run"/);
    assert.match(writing, /<button[^>]*disabled=""[^>]*aria-label="Other ways to stop"/);
    assert.doesNotMatch(text(writing), /left in the window/, "the window no longer matters");
    const dropping = render(fakeResearchRun({}), { researchStopping: { "run-1": "now" } });
    assert.match(dropping, /data-research-phase[^>]*>Stopping…</);
    const other = render(fakeResearchRun({}), { researchStopping: { "run-2": "now" } });
    assert.match(other, /data-research-phase[^>]*>Researching, round 1 of 12</, "another run's stop is not this row's");
    assert.doesNotMatch(other, /<button[^>]*disabled=""[^>]*aria-label="Stop the research run"/);
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

  it("reads only the newest finished run's report on sight; an older one, or a read that failed, gets a button", () => {
    const older = fakeResearchRun({ runId: "r-old", status: "completed", phase: "done", createdAt: "2026-09-25T00:00:00.000Z", reportAvailable: true });
    const newer = fakeResearchRun({ runId: "r-new", status: "completed", phase: "done", createdAt: "2026-09-26T00:00:00.000Z", reportAvailable: true });
    assert.equal(newestReportedRun([older, newer]), "r-new");
    assert.equal(newestReportedRun([newer, older]), "r-new", "the order in the thread does not matter");
    assert.equal(newestReportedRun([older, fakeResearchRun({ runId: "r-live" })]), "r-old", "a run still going has no report to read");
    assert.equal(newestReportedRun([fakeResearchRun({ runId: "r-failed", status: "failed", phase: "done" })]), null);
    const rows = renderThread([older, newer]).split('data-research-status="').slice(1);
    assert.equal(rows.length, 2);
    assert.match(text(rows[0] ?? ""), /Read the report/, "the older run offers its report");
    assert.doesNotMatch(text(rows[0] ?? ""), /Reading the report/);
    assert.match(text(rows[1] ?? ""), /Reading the report/, "the newest reads its report on sight");
    assert.doesNotMatch(text(rows[1] ?? ""), /Read the report/);
    // A failed read leaves the button, never a spinner that means nothing; a read in flight shows as one wherever it was asked for.
    const available = { report: null, reportAvailable: true };
    assert.equal(reportView(available, { latest: true, reading: false, failed: false }), "reading");
    assert.equal(reportView(available, { latest: true, reading: false, failed: true }), "read");
    assert.equal(reportView(available, { latest: false, reading: false, failed: false }), "read");
    assert.equal(reportView(available, { latest: false, reading: true, failed: false }), "reading");
    assert.equal(reportView({ report: "# R", reportAvailable: true }, { latest: false, reading: false, failed: false }), "report");
    assert.equal(reportView({ report: null, reportAvailable: false }, { latest: true, reading: false, failed: false }), "none");
    const button = render(fakeResearchRun({ status: "completed", phase: "done", reportAvailable: true }), {}, false);
    assert.match(button, /<button[^>]*>Read the report<\/button>/);
    assert.doesNotMatch(text(button), /Reading the report/);
    const reading = render(fakeResearchRun({ status: "completed", phase: "done", reportAvailable: true }), { busy: { "research-report:run-1": true } }, false);
    assert.match(text(reading), /Reading the report/);
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
    const markup = renderThread([
      fakeResearchRun({ runId: "r-old", status: "completed", phase: "done", createdAt: "2026-09-25T00:00:00.000Z", reportAvailable: true, report: "# Old" }),
      fakeResearchRun({ runId: "r-new" }),
    ]);
    const rows = [...markup.matchAll(/data-research-status="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(rows, ["completed", "running"], "the older run comes first");
  });

  it("does not call a thread whose only content is a research run a clean slate", () => {
    assert.match(text(renderThread([])), /A clean slate/);
    assert.doesNotMatch(text(renderThread([fakeResearchRun({})])), /A clean slate/);
  });

  it("posts only the popover fields that were typed, clamped to the daemon's limits, and never the numbers it shows", () => {
    const defaults = fakeResearchRun({}).config;
    assert.equal(popoverOverrides(NOTHING_TYPED, defaults), null);
    assert.equal(popoverOverrides(NOTHING_TYPED, null), null, "nothing goes for fields the settings had not filled in yet");
    assert.deepEqual(popoverOverrides({ ...NOTHING_TYPED, windowMin: "5" }, defaults), { windowMinMinutes: 5 });
    assert.equal(popoverOverrides({ ...NOTHING_TYPED, windowMin: "3" }, defaults), null, "typing the default back is no override");
    assert.deepEqual(popoverOverrides({ ...NOTHING_TYPED, parallel: "40" }, defaults), { maxParallel: RESEARCH_LIMITS.parallel.max });
    assert.deepEqual(popoverOverrides({ ...NOTHING_TYPED, parallel: "0" }, defaults), { maxParallel: RESEARCH_LIMITS.parallel.min });
    assert.deepEqual(popoverOverrides({ ...NOTHING_TYPED, windowMin: "0.7", windowMax: "300" }, defaults), { windowMinMinutes: 0.5, windowMaxMinutes: 240 });
    assert.deepEqual(popoverOverrides({ ...NOTHING_TYPED, windowMax: "2" }, defaults), { windowMaxMinutes: 2, windowMinMinutes: 2 }, "a maximum under the minimum lowers the minimum with it");
    assert.equal(popoverOverrides({ ...NOTHING_TYPED, windowMin: "abc", windowMax: "" }, defaults), null);
    assert.deepEqual(popoverOverrides({ ...NOTHING_TYPED, parallel: "2" }, null), { maxParallel: 2 }, "what was typed goes even before the settings load");
    assert.equal(clampResearchNumber("12.4", RESEARCH_LIMITS.rounds), 12);
    assert.equal(clampResearchNumber("900", RESEARCH_LIMITS.rounds), 500);
    assert.equal(clampResearchNumber("", RESEARCH_LIMITS.rounds), null);
    assert.deepEqual(
      RESEARCH_LIMITS,
      {
        windowMinutes: { min: 0.5, max: 240 },
        rounds: { min: 1, max: 500 },
        parallel: { min: 1, max: 12 },
        workerToolCalls: { min: 1, max: 100 },
        workerSearches: { min: 1, max: 100 },
        workerReads: { min: 1, max: 500 },
        workerSaves: { min: 1, max: 200 },
        workerWallTimeMinutes: { min: 1, max: 60 },
      },
      "the daemon's RESEARCH_LIMITS, kept by hand",
    );
  });

  it("tells the later of two pictures of a live run by what only grows, with a tie to the one that arrived last", () => {
    const round1 = fakeResearchRun({ round: 1, workers: [worker({})] });
    const round2 = fakeResearchRun({ round: 2, workers: [worker({}), worker({ agentId: 2, round: 2 })] });
    assert.equal(researchSnapshotCurrent(round1, round2), true);
    assert.equal(researchSnapshotCurrent(round2, round1), false, "a stale answer cannot take the row back a round");
    const moreWorkers = fakeResearchRun({ round: 1, workers: [worker({}), worker({ agentId: 2 })] });
    assert.equal(researchSnapshotCurrent(round1, moreWorkers), true);
    assert.equal(researchSnapshotCurrent(moreWorkers, round1), false);
    const moreCalls = fakeResearchRun({ round: 1, workers: [worker({ toolCalls: 9 })] });
    assert.equal(researchSnapshotCurrent(round1, moreCalls), true);
    assert.equal(researchSnapshotCurrent(moreCalls, round1), false);
    const level = fakeResearchRun({ round: 1, workers: [worker({})], sources: { registry: 3, verified: 1, curated: 0 } });
    assert.equal(researchSnapshotCurrent(round1, level), true, "level on all of them, the later arrival wins");
    assert.equal(researchSnapshotCurrent(fakeResearchRun({ phase: "writing", round: 2 }), fakeResearchRun({ phase: "researching", round: 2 })), false, "writing comes after researching");
    assert.equal(researchSnapshotCurrent(fakeResearchRun({ phase: "scoping", round: 0 }), fakeResearchRun({ status: "queued", phase: "scoping", round: 0 })), false, "a run does not go back to the queue");
  });

  it("answers a waiting stop once its run has ended, and leaves the record alone otherwise", () => {
    const stopping = { "run-1": "write" as const, "run-2": "now" as const };
    assert.equal(settleStopping(stopping, [fakeResearchRun({ runId: "run-1" })]), stopping, "a run still going keeps its stop waiting");
    assert.deepEqual(settleStopping(stopping, [fakeResearchRun({ runId: "run-1", status: "cancelled", phase: "done" })]), { "run-2": "now" });
    assert.equal(settleStopping(stopping, [fakeResearchRun({ runId: "run-9", status: "failed", phase: "done" })]), stopping);
  });
});
