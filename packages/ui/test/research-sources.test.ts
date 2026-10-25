import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ControllerProvider } from "../src/app/context.js";
import { ResearchRunRow } from "../src/components/thread/ResearchRunRow.js";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import type { AncillaController } from "../src/model/controller.js";
import { completionView, crewView } from "../src/model/crew.js";
import { emptyFold } from "../src/model/fold.js";
import { interruptedLine, SOURCES_LINE_TITLE, sourcesLine } from "../src/model/research.js";
import { defaultPrefs, initialState, Store, type AppState } from "../src/model/store.js";
import type { ResearchRunView } from "../src/types.js";
import { session } from "./crew-fixtures.js";
import { RESEARCH_NOW, fakeResearchRun, fakeSourceCounts, iso, rs, runningResearch } from "./fixtures/research.js";

function render(run: ResearchRunView): string {
  const store = new Store<AppState>({ ...initialState(defaultPrefs("2026-09-26T00:00:00.000Z")), connection: "open" });
  const controller = { store } as unknown as AncillaController;
  const row = createElement(ResearchRunRow, { run, sessionId: "s1", latest: true });
  return renderToStaticMarkup(createElement(ControllerProvider, { controller, children: createElement(TooltipProvider, { children: row }) }));
}

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** The counts a server that knows provenance sends: the original three plus how each source was reached. */
const counts = (over: Record<string, number>): ResearchRunView["sources"] => ({ registry: 0, verified: 0, curated: 0, ...over });

describe("sourcesLine with provenance", () => {
  it("says nothing before the first source", () => {
    assert.equal(sourcesLine(counts({})), null);
    assert.equal(sourcesLine(counts({ opened: 0, searchOnly: 0, attempted: 0, listedEarlier: 0 })), null);
  });

  it("shows how many sources were opened, found only in search results, or had a fetch that failed or was cut off, and how many can be cited", () => {
    assert.equal(sourcesLine(counts({ registry: 12, verified: 9, curated: 4, opened: 6, searchOnly: 3, attempted: 2, listedEarlier: 0 })), "12 sources · 6 opened · 3 search only · 2 fetch failed or cut off · 9 citable · 4 curated");
    assert.equal(sourcesLine(counts({ registry: 1, verified: 1, opened: 1, searchOnly: 0, attempted: 0, listedEarlier: 0 })), "1 source · 1 opened · 1 citable");
  });

  it("states that nothing was opened or citable rather than leaving the count out", () => {
    assert.equal(sourcesLine(counts({ registry: 3, verified: 3, opened: 0, searchOnly: 3, attempted: 0, listedEarlier: 0 })), "3 sources · 0 opened · 3 search only · 3 citable");
    assert.equal(sourcesLine(counts({ registry: 2, verified: 0, opened: 0, searchOnly: 0, attempted: 2, listedEarlier: 0 })), "2 sources · 0 opened · 2 fetch failed or cut off · 0 citable");
  });

  it("calls the sources a fetch was tried for and did not open what all of them are: failed or cut off, never just failed", () => {
    const line = sourcesLine(counts({ registry: 4, verified: 2, opened: 1, searchOnly: 1, attempted: 2, listedEarlier: 0 })) ?? "";
    assert.match(line, /2 fetch failed or cut off/);
    assert.doesNotMatch(line, /fetch failed(?! or cut off)/);
  });

  it("tells a fetch that failed or was cut off but stayed citable (it was in a search result) from one that did not, by the citable count", () => {
    const stayed = sourcesLine(counts({ registry: 2, verified: 2, opened: 0, searchOnly: 0, attempted: 2, listedEarlier: 0 }));
    const dropped = sourcesLine(counts({ registry: 2, verified: 0, opened: 0, searchOnly: 0, attempted: 2, listedEarlier: 0 }));
    assert.notEqual(stayed, dropped);
    assert.match(stayed ?? "", /2 fetch failed or cut off · 2 citable$/);
    assert.match(dropped ?? "", /2 fetch failed or cut off · 0 citable$/);
  });

  it("marks sources an earlier version listed, without calling them opened", () => {
    assert.equal(sourcesLine(counts({ registry: 9, verified: 7, curated: 2, opened: 0, searchOnly: 0, attempted: 0, listedEarlier: 7 })), "9 sources · 7 listed by an earlier version · 7 citable · 2 curated");
    assert.equal(sourcesLine(counts({ registry: 9, verified: 7, opened: 2, searchOnly: 0, attempted: 0, listedEarlier: 5 })), "9 sources · 2 opened · 5 listed by an earlier version · 7 citable");
  });

  it("falls back to the verified count when the server sends no provenance counts", () => {
    assert.equal(sourcesLine(counts({ registry: 12, verified: 9, curated: 4 })), "12 sources · 9 verified · 4 curated");
  });
});

describe("the run row's sources line", () => {
  /** The sources line, the text it is described by, and the attributes of the span that carries that text. */
  const explained = (markup: string): { described: string | null; noteAttrs: string | null; line: string | null } => {
    const line = /<span([^>]*)>(\d+ sources? · [^<]*)<\/span>/.exec(markup);
    const by = /aria-describedby="([^"]+)"/.exec(line?.[1] ?? "")?.[1] ?? null;
    const note = by === null ? null : new RegExp(`<span([^>]*)id="${by.replace(/[^\w-]/g, "\\$&")}"([^>]*)>([^<]*)</span>`).exec(markup);
    return { described: note?.[3] ?? null, noteAttrs: note ? `${note[1]}${note[2]}` : null, line: line?.[2] ?? null };
  };

  it("explains the buckets to a keyboard or screen reader user, not on a title alone", () => {
    const markup = render(fakeResearchRun({ sources: { registry: 6, verified: 5, curated: 0, opened: 3, searchOnly: 2, attempted: 1, listedEarlier: 0 } }));
    const line = /<span([^>]*)>6 sources · 3 opened · 2 search only · 1 fetch failed or cut off · 5 citable<\/span>/.exec(markup);
    assert.ok(line, "the line is a span of its own");
    assert.match(line[1] ?? "", /tabindex="0"/, "the line takes focus, so the tooltip opens from the keyboard");
    assert.match(line[1] ?? "", /data-state="closed"/, "the line is the tooltip's trigger, so a sighted keyboard user sees the explanation on focus");
    assert.doesNotMatch(markup, /title="[^"]*(?:opened|search only)/, "no title attribute carries the explanation");
    const shown = explained(markup);
    assert.equal(shown.described, SOURCES_LINE_TITLE, "a hidden copy is what the line is described by");
    assert.match(shown.noteAttrs ?? "", /\bhidden\b/, "the copy is hidden: it is for screen readers, not printed in the counts line");
  });

  it("puts no explanation and no focus stop on the line that says there are no sources yet", () => {
    const markup = render(fakeResearchRun({}));
    assert.match(markup, /<span[^>]*>No sources yet<\/span>/);
    assert.doesNotMatch(markup, /<span[^>]*tabindex[^>]*>No sources yet/);
    assert.doesNotMatch(markup, /at most one of opened/);
  });

  it("does not claim a partition when a source no worker call saw is in the count and in none of the buckets", () => {
    // Two opened, one search only, one fetch that did not complete, and two the workers saved but no call saw.
    const registry = [
      { verified: true, provenance: "retrieved" as const },
      { verified: true, provenance: "retrieved" as const },
      { verified: true, provenance: "search_only" as const },
      { verified: false, provenance: "attempted" as const },
      { verified: false, provenance: "unobserved" as const },
      { verified: false, provenance: "unobserved" as const },
    ];
    const sources = fakeSourceCounts(registry, 0);
    const line = sourcesLine(sources);
    assert.equal(line, "6 sources · 2 opened · 1 search only · 1 fetch failed or cut off · 3 citable");
    assert.equal((sources.opened ?? 0) + (sources.searchOnly ?? 0) + (sources.attempted ?? 0), 4, "four of the six are in a bucket");
    assert.ok(sources.registry > 4, "so the buckets do not add up to the count, and the hover text must not say they do");
    assert.doesNotMatch(SOURCES_LINE_TITLE, /counts once|each source/i);
    assert.match(SOURCES_LINE_TITLE, /at most one of opened, search only, or fetch failed or cut off/);
    assert.match(SOURCES_LINE_TITLE, /A source no worker call saw is in none of them and cannot be cited/);
    const shown = explained(render(fakeResearchRun({ sources })));
    assert.equal(shown.line, line, "the row prints that line");
    assert.equal(shown.described, SOURCES_LINE_TITLE, "and describes it with that text");
    assert.match(shown.noteAttrs ?? "", /\bhidden\b/, "which stays hidden");
  });
});

describe("the run row for an interrupted run", () => {
  const plain = (markup: string) => text(markup).replace(/&#x27;/g, "'");
  const interrupted = (failure: string | null) => render(fakeResearchRun({ status: "interrupted", phase: "researching", failure }));

  it("says why in a sentence, without the stored prefix: the server shut down", () => {
    const shown = plain(interrupted("interrupted: the server shut down while the run was in flight."));
    assert.match(shown, /The server shut down while the run was in flight\./);
    assert.doesNotMatch(shown, /interrupted:/);
  });

  it("says why in a sentence when the store could not keep the run's progress, with what the store said", () => {
    const shown = plain(interrupted("interrupted: the run's progress could not be saved: database is locked."));
    assert.match(shown, /The run's progress could not be saved: database is locked\./);
    const closed = plain(interrupted("interrupted: how the run ended could not be saved (database is locked)"));
    assert.match(closed, /How the run ended could not be saved \(database is locked\)\./);
    assert.doesNotMatch(closed, /interrupted:/);
  });

  it("keeps the disabled Resume button, and its own sentence for a run that names no reason", () => {
    const markup = interrupted("interrupted: the server shut down while the run was in flight.");
    assert.match(markup, /<button[^>]*disabled=""[^>]*>Resume<\/button>/);
    assert.match(plain(interrupted(null)), /Ancilla restarted while the run was going, so it stopped where it was\./);
  });

  it("leaves what a failed run says as the server wrote it", () => {
    const markup = render(fakeResearchRun({ status: "failed", phase: "researching", failure: "the model refused the request" }));
    assert.match(plain(markup), /the model refused the request/);
  });
});

describe("interruptedLine", () => {
  it("drops the prefix, capitalises, and ends the sentence", () => {
    assert.equal(interruptedLine("interrupted: the server shut down while the run was in flight."), "The server shut down while the run was in flight.");
    assert.equal(interruptedLine("interrupted: the server stopped"), "The server stopped.");
    assert.equal(interruptedLine("Interrupted:   already capitalised!"), "Already capitalised!");
  });

  it("does not add a full stop after an ending it already has, whether half-width, full-width, an ellipsis or the CJK full stop", () => {
    assert.equal(interruptedLine("interrupted: wait..."), "Wait...");
    assert.equal(interruptedLine("interrupted: wait…"), "Wait…");
    assert.equal(interruptedLine("interrupted: what?"), "What?");
    assert.equal(interruptedLine("interrupted: stopped。"), "Stopped。");
    assert.equal(interruptedLine("interrupted: 。"), "。");
    assert.equal(interruptedLine("interrupted: stopped！"), "Stopped！");
    assert.equal(interruptedLine("interrupted: stopped？"), "Stopped？");
  });

  it("leaves a reason that ends in a colon as it is, rather than closing it with a full stop", () => {
    assert.equal(interruptedLine("interrupted: the store said:"), "The store said:");
    assert.equal(interruptedLine("interrupted: the store said："), "The store said：");
  });

  it("sees the end mark through a closing quote or bracket, and still closes a bracket that has none inside", () => {
    assert.equal(interruptedLine('interrupted: said "locked."'), 'Said "locked."');
    assert.equal(interruptedLine("interrupted: said 'locked.'"), "Said 'locked.'");
    assert.equal(interruptedLine("interrupted: said “locked.”"), "Said “locked.”");
    assert.equal(interruptedLine("interrupted: (locked.)"), "(locked.)");
    assert.equal(interruptedLine("interrupted: [locked]"), "[locked].");
  });

  it("falls back to the restart sentence when nothing is left to say", () => {
    assert.equal(interruptedLine(null), "Ancilla restarted while the run was going, so it stopped where it was.");
    assert.equal(interruptedLine("interrupted: "), "Ancilla restarted while the run was going, so it stopped where it was.");
  });
});

describe("the run row for a run that cited nothing", () => {
  const finished = (over: Partial<ResearchRunView>) =>
    fakeResearchRun({ status: "partial", phase: "done", endedAt: "2026-09-26T00:08:01.000Z", reportAvailable: true, report: "# Report\n\nNo source was available.", ...over });

  it("shows a chip saying no source could be cited", () => {
    const markup = render(finished({ noCitableSources: true }));
    assert.match(markup, /data-research-no-sources/);
    assert.match(text(markup), /No source could be cited for this report/);
    assert.doesNotMatch(text(markup), /Written from what the workers had found/, "the chip is the whole note when no failure is recorded");
  });

  it("keeps the salvage note beside it when the run was also stopped early", () => {
    const markup = render(finished({ noCitableSources: true, failure: "cancelled; report written from the findings collected so far" }));
    assert.match(text(markup), /No source could be cited for this report/);
    assert.match(text(markup), /Written from what the workers had found: cancelled; report written/);
  });

  it("shows no chip for a run that cited sources", () => {
    assert.doesNotMatch(render(finished({})), /data-research-no-sources|No source could be cited/);
    assert.doesNotMatch(render(finished({ noCitableSources: false })), /data-research-no-sources/);
  });
});

describe("the Crew report for a run that cited nothing", () => {
  const SESSION = session("s1", "Zero citable", { modelId: "muse-spark-1.3" });
  const ended = (over: Partial<ResearchRunView>) =>
    runningResearch({ status: "partial", phase: "done", endedAt: iso(rs(5, 0)), reportAvailable: true, failure: null, workers: runningResearch().workers.slice(0, 2), sources: { registry: 2, verified: 0, curated: 0, opened: 0, searchOnly: 0, attempted: 2, listedEarlier: 0 }, ...over });
  const completionOf = (run: ResearchRunView) => {
    const view = crewView(emptyFold(), SESSION, RESEARCH_NOW, { researchRuns: [run] });
    const completion = completionView(view.runs[0]!);
    assert.ok(completion);
    return completion;
  };

  it("gives the reason in the fact line, where a partial run with no failure text used to say it ended before every round", () => {
    const completion = completionOf(ended({ noCitableSources: true }));
    assert.match(completion.factLine, /^No source could be cited for this report/);
    assert.doesNotMatch(completion.factLine, /ended before every round/);
  });

  it("says nothing of the kind for a partial run that cited sources, and keeps the daemon's own failure text first", () => {
    assert.match(completionOf(ended({})).factLine, /^The run ended before every round was done/);
    assert.match(completionOf(ended({ noCitableSources: true, failure: "The window closed before round 3" })).factLine, /^The window closed before round 3/);
  });
});
