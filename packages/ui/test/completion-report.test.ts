import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import { CompletionReport, emphasized, reportMeta, type CompletionReportProps } from "../src/components/crew/CompletionReport.js";
import { SinceYouLeft, recapText } from "../src/components/crew/SinceYouLeft.js";
import { CrewCard } from "../src/components/crew/CrewCard.js";
import { completionView, crewView, sinceYouLeft, type CompletionVM, type RunVM } from "../src/model/crew.js";
import { emptyFold } from "../src/model/fold.js";
import type { ResearchRunView } from "../src/types.js";
import { session } from "./crew-fixtures.js";
import { RESEARCH_NOW, iso, rs, runningResearch } from "./fixtures/research.js";
import { S, finishedFeed, finishedRun, flatten, mkAgent, mkRun, mkTask, referenceAgents, textOf as text, view } from "./fixtures/lantern.js";

const voidFn = () => {};

function buildReportMarkup(run: RunVM, config: Partial<CompletionReportProps> = {}): { html: string; completion: CompletionVM } {
  const model = completionView(run);
  assert.ok(model, "expected completion view model to be generated for finished run");
  const props: CompletionReportProps = {
    run,
    completion: model,
    expanded: true,
    onToggle: voidFn,
    onOpenPanel: voidFn,
    onDismiss: voidFn,
    onOpenTranscript: voidFn,
    ...config,
  };
  const element = createElement(TooltipProvider, { children: createElement(CompletionReport, props) });
  return { html: renderToStaticMarkup(element), completion: model };
}

function buildCardReceipt(run: RunVM, isExpanded = false): string {
  const model = completionView(run);
  assert.ok(model, "expected valid completion for receipt card");
  const cardElement = createElement(TooltipProvider, {
    children: createElement(CrewCard, {
      sessionId: "s1",
      run,
      tasks: [],
      completion: model,
      sinceYouLeft: null,
      expanded: isExpanded,
      openPhase: null,
      selectedId: null,
      readOnly: false,
      onToggle: voidFn,
      onOpenPhase: voidFn,
      onInspect: voidFn,
      onOpenPanel: voidFn,
      onAction: voidFn,
      onStopRun: voidFn,
      onDismissReport: voidFn,
      onDismissRecap: voidFn,
      onReview: voidFn,
    }),
  });
  return renderToStaticMarkup(cardElement);
}

function parsePillContent(markup: string): string {
  const pillRegex = /<span class="crew-el[^"]*">(?:<svg[\s\S]*?<\/svg>)?([^<]*)</;
  const match = pillRegex.exec(markup);
  return match?.[1] ?? "";
}

describe("CompletionReport turn summaries and compact receipts", () => {
  it("renders compact turn completion summaries without complex workflow reports", () => {
    const turnRun = mkRun(
      [mkAgent("Muse", "done", { kind: "lead" }), mkTask("npm run build", "done", {}, { background: false })],
      { kind: "turn", status: "finished", endedAt: S(1, 0) },
    );
    const receiptHtml = buildCardReceipt(turnRun);

    assert.match(receiptHtml, /data-completion="turn"/);
    assert.match(receiptHtml, /<span class="run-glyph ok"/);
    assert.match(text(receiptHtml), /Turn finished 1 tool completed/);
    assert.match(receiptHtml, /aria-label="Dismiss turn summary"/);
    assert.doesNotMatch(receiptHtml, /crew-landed|crew-stats|<h2>|Muse did not attach a report|Highlights|All 2 agents/);

    const expandedReceipt = buildCardReceipt(turnRun, true);
    assert.match(text(expandedReceipt), /Activity Timeline 1 action/);

    const pendingTurn = mkRun([mkAgent("Muse", "unknown", { kind: "lead" })], {
      kind: "turn",
      status: "finished",
      endedAt: S(1, 0),
    });
    const pendingHtml = buildCardReceipt(pendingTurn);
    assert.match(text(pendingHtml), /Turn ended.*1 outcome not reported/);
    assert.doesNotMatch(pendingHtml, /run-glyph ok/);
  });

  it("preserves successful turn status when individual tool operations encounter failures", () => {
    const compositeTurn = mkRun(
      [
        mkAgent("Muse", "done", { kind: "lead" }),
        mkTask("npm test", "failed", { failure: { text: "exited with code 1", at: S(0, 30) } }),
        mkTask("npm run build", "done"),
      ],
      { kind: "turn", status: "finished-with-failures", endedAt: S(1, 0) },
    );

    const htmlOutput = buildCardReceipt(compositeTurn);
    assert.match(htmlOutput, /<span class="run-glyph ok"/, "turn outcome badge indicates overall completion");
    assert.doesNotMatch(htmlOutput, /crew-chip/, "avoids duplicate red badge on prompt card");
    assert.match(text(htmlOutput), /Turn finished 1 tool completed · 1 failed/);
  });
});

describe("CompletionReport workflow reports and outcome visualizations", () => {
  it("renders presentation header including status seal, primary headline, and timing meta", () => {
    const { html } = buildReportMarkup(finishedRun());

    assert.match(html, /class="crew-tile ok"/);
    assert.match(html, /<h2>All ten landed\.<\/h2>/);
    assert.match(html, /class="crew-el ok"[^>]*>(?:<svg[\s\S]*?<\/svg>)?Done · 45m 06s</);
    assert.match(html, /aria-label="Collapse the report"/);
    assert.match(html, /class="sub">Every phase reached its end · 1 agent needed 3 attempts</);
    assert.match(html, /aria-label="Dismiss the report"/);
    assert.match(text(html), /Workflow · started [^·]+ · finished /);
  });

  it("omits celebratory seal and renders muted notice when workflow completes with failures", () => {
    const feedSnapshot = finishedFeed();
    const skippedView = view(feedSnapshot, S(50, 0), { skipped: [] }).vm.runs[0] as RunVM;
    assert.equal(skippedView.status, "finished");

    const partialFailureRun = mkRun(
      referenceAgents().map((ag) => ({
        ...ag,
        quiet: null,
        state: ag.state === "failed" ? ag.state : ("done" as const),
      })),
      {
        status: "finished-with-failures",
        endedAt: S(43, 2),
        elapsedMs: S(43, 2) - S(0, 0),
        report: { summary: null, failure: null, handoffs: [] },
      },
    );

    const { html, completion } = buildReportMarkup(partialFailureRun);
    assert.equal(completion.sheen, false);
    assert.match(html, /class="crew-tile mute"/);
    assert.match(html, /Finished · 43m 02s/);
    assert.match(html, /Muse did not attach a report\./);
    assert.match(html, /<h2>Nine of ten landed, one failed\.<\/h2>/);
    assert.match(text(html), /1 agent failed design:conflict-ledger after 2 attempts/);
  });

  it("supports celebratory sheen styling and handles collapsed presentation state", () => {
    const { html } = buildReportMarkup(finishedRun(), { sheen: true });
    const sheenMatches = html.match(/crew-strip rail finale crew-sheen/g) ?? [];
    assert.equal(sheenMatches.length, 4);

    const collapsedHtml = buildReportMarkup(finishedRun(), { expanded: false }).html;
    assert.doesNotMatch(collapsedHtml, /<h2>/);
    assert.match(collapsedHtml, /aria-expanded="false"/);
  });

  it("transforms finished run card display into completion report container", () => {
    const finishedItem = finishedRun();
    const renderedCard = renderToStaticMarkup(
      createElement(TooltipProvider, {
        children: createElement(CrewCard, {
          sessionId: "s1",
          run: finishedItem,
          tasks: [],
          completion: completionView(finishedItem),
          sinceYouLeft: null,
          expanded: true,
          openPhase: null,
          selectedId: null,
          readOnly: false,
          onToggle: voidFn,
          onOpenPhase: voidFn,
          onInspect: voidFn,
          onOpenPanel: voidFn,
          onAction: voidFn,
          onStopRun: voidFn,
          onDismissReport: voidFn,
          onDismissRecap: voidFn,
          onReview: voidFn,
        }),
      }),
    );

    assert.match(renderedCard, /<h2>All ten landed\.<\/h2>/);
    assert.doesNotMatch(renderedCard, /Needs attention|Stop run/);
  });
});

describe("CompletionReport execution fingerprint and milestone highlights", () => {
  it("renders finale telemetry rail with four KPI cells and milestone highlights", () => {
    const { html, completion } = buildReportMarkup(finishedRun());

    assert.doesNotMatch(html, /crew-sheen/);
    const finaleRails = html.match(/class="crew-strip rail finale"/g) ?? [];
    assert.equal(finaleRails.length, 4);

    const parsedStats = [...html.matchAll(/class="v">([^<]*)<\/div><div class="k">([^<]*)</g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(
      parsedStats.map((s) => s[1]),
      ["agents", "wall clock", "tokens, reported by Muse · latest attempt of each agent", "estimate at list price"],
    );
    assert.deepEqual(
      parsedStats.slice(0, 3).map((s) => s[0]),
      ["10", "45m 06s", "1.4M"],
    );
    assert.match(parsedStats[3]?.[0] as string, /^~\$/);

    const highlightEntries = [...flatten(html).matchAll(/<li>(?:<svg[\s\S]*?<\/svg>)?<span>([\s\S]*?)<\/span>(?:<span class="r">([^<]*)<\/span>)?<\/li>/g)].map(
      (m) => [text(m[1] as string), m[2] ?? null],
    );
    assert.equal(completion.highlights.length, 4);
    assert.deepEqual(highlightEntries[0], ["Longest agent judge:perf · 18m 36s", null]);
    assert.deepEqual(highlightEntries[1], ["Most tokens research:field-notes · 270k", "20% of the run"]);
    assert.deepEqual(highlightEntries[2], ["Retried design:conflict-ledger · landed on attempt 3", "after 2 failed attempts"]);
    assert.deepEqual(highlightEntries[3], ["Waited on you 1m 40s", null]);
    assert.match(html, /<span>Longest agent <b>judge:perf<\/b> · 18m 36s<\/span>/);
  });

  it("visualizes timeline fingerprint with agent lane distribution, attempt bars, and time axis", () => {
    const { html, completion } = buildReportMarkup(finishedRun());

    assert.match(html, /class="crew-fp" role="img" aria-label="Where the time went: 10 agents over 45m 06s"/);

    const barNodes = html.match(/class="bar( f)?"/g) ?? [];
    const expectedSpans = completion.fingerprint.lanes.reduce((acc, lane) => acc + lane.spans.length, 0);
    assert.equal(barNodes.length, expectedSpans);

    const failureBars = barNodes.filter((bar) => bar.includes(" f"));
    assert.equal(failureBars.length, 2, "highlights two failed agent attempts with failure styling");

    for (const phaseName of ["Research", "Design", "Judge", "Synthesize"]) {
      assert.match(html, new RegExp(`class="lab"[^>]*>${phaseName}<`));
    }

    assert.match(html, /class="axis"><span style="left:0;transform:none">0<\/span>/);
    assert.match(html, /10m<\/span>/);
    assert.match(html, />45m 06s<\/span><\/div>/);
    assert.doesNotMatch(html, /from loaded history/);
  });

  it("renders formatted report excerpt through markdown and links to transcript view", () => {
    const { html } = buildReportMarkup(finishedRun());

    assert.match(html, /final summary · first lines/);
    assert.match(html, /Recommend the <strong>CRDT ledger<\/strong>/);
    assert.match(html, /Open in transcript</);
    assert.match(text(html), /Handoffs design:crdt-ledger · ledger design doc/);
    assert.match(text(html), /All 10 agents Timeline 10 done · 1 retried$/);
    assert.equal(reportMeta(finishedRun()), "10 done · 1 retried");
  });
});

describe("SinceYouLeft recap presentation and emphasis helpers", () => {
  it("generates descriptive elapsed activity recap when returning to session", () => {
    const completedRun = finishedRun();
    const recapData = sinceYouLeft(completedRun, S(29, 0), S(50, 0));
    assert.ok(recapData, "expected valid recap object");

    assert.match(
      recapText(recapData, S(50, 0)),
      /^Since you left at [^·]+ · 4 agents finished, Synthesize ran, the run finished at /,
    );

    const recapMarkup = renderToStaticMarkup(
      createElement(SinceYouLeft, { recap: recapData, clockAt: S(50, 0), onDismiss: voidFn }),
    );
    assert.match(recapMarkup, /<b>4 agents finished<\/b>/);
    assert.match(recapMarkup, /the run <b>finished at /);

    const abortedRunRecap = { leftAt: S(13, 0), finished: 2, failed: 1, phasesStarted: ["Judge"], runFinishedAt: null };
    assert.match(recapText(abortedRunRecap, S(41, 16)), /2 agents finished, 1 agent failed, Judge ran$/);
  });

  it("wraps target substring in bold tags while preserving surrounding line text", () => {
    const withMatch = emphasized("Waited on you 1m 40s", "1m 40s");
    assert.equal(renderToStaticMarkup(createElement("span", null, withMatch)), "<span>Waited on you <b>1m 40s</b></span>");

    const withoutMatch = emphasized("Peak concurrency 4 agents", "nothing");
    assert.equal(renderToStaticMarkup(createElement("span", null, withoutMatch)), "<span>Peak concurrency 4 agents</span>");
  });
});

describe("CompletionReport research run lifecycle and interruption status", () => {
  const defaultResearchEnding = {
    phase: "done" as const,
    endedAt: iso(rs(5, 0)),
    reportAvailable: false,
    sources: { registry: 0, verified: 0, curated: 0 },
  };

  const createResearchRun = (overrides: Partial<ResearchRunView>): RunVM => {
    const sessionModel = session("s1", "Research", { modelId: "muse-spark-1.3" });
    const viewResult = crewView(emptyFold(), sessionModel, RESEARCH_NOW, {
      researchRuns: [runningResearch({ ...defaultResearchEnding, ...overrides })],
    });
    return viewResult.runs[0] as RunVM;
  };

  it("identifies server shutdown interruptions with distinctive pill and header notice", () => {
    const shutdownRun = createResearchRun({
      status: "interrupted",
      failure: "interrupted: the server shut down while the run was in flight.",
    });

    assert.equal(shutdownRun.status, "stopped");
    const { html } = buildReportMarkup(shutdownRun);

    assert.match(parsePillContent(html), /^Interrupted · 4m 59s$/);
    assert.match(html, /<h2>Interrupted after 5m; one of three had landed\.<\/h2>/);
    assert.match(html, /class="sub">The server shut down while the run was in flight\. · /);
  });

  it("distinguishes user cancellations and unexpected model failures", () => {
    const userStopped = createResearchRun({ status: "cancelled" });
    assert.match(parsePillContent(buildReportMarkup(userStopped).html), /^Stopped · 4m 59s$/);

    const modelFailure = createResearchRun({ status: "failed", failure: "the model refused" });
    assert.match(parsePillContent(buildReportMarkup(modelFailure).html), /^Failed · 4m 59s$/);
  });
});
