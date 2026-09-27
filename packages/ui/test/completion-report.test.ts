import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../src/components/ui/overlays.js";
import { CompletionReport, emphasized, reportMeta, type CompletionReportProps } from "../src/components/crew/CompletionReport.js";
import { SinceYouLeft, recapText } from "../src/components/crew/SinceYouLeft.js";
import { CrewCard } from "../src/components/crew/CrewCard.js";
import { completionView, sinceYouLeft, type CompletionVM, type RunVM } from "../src/model/crew.js";
import { S, finishedFeed, finishedRun, flatten, mkRun, referenceAgents, textOf as text, view } from "./fixtures/lantern.js";

const noop = () => {};

function render(run: RunVM, overrides: Partial<CompletionReportProps> = {}): { markup: string; completion: CompletionVM } {
  const completion = completionView(run);
  assert.ok(completion, "a finished run has a report");
  const props: CompletionReportProps = { run, completion, expanded: true, onToggle: noop, onOpenPanel: noop, onDismiss: noop, onOpenTranscript: noop, ...overrides };
  return { markup: renderToStaticMarkup(createElement(TooltipProvider, { children: createElement(CompletionReport, props) })), completion };
}

describe("CompletionReport", () => {
  it("opens with the seal, the serif headline and the fact line", () => {
    const { markup } = render(finishedRun());
    assert.match(markup, /class="crew-tile ok"/);
    assert.match(markup, /class="crew-el ok"[^>]*>(?:<svg[\s\S]*?<\/svg>)?Done · 45m 06s</);
    assert.match(markup, /<h2>All ten landed\.<\/h2>/);
    assert.match(markup, /class="sub">Every phase reached its end · 1 agent needed 3 attempts</);
    assert.match(text(markup), /Workflow · started [^·]+ · finished /);
    assert.match(markup, /aria-label="Dismiss the report"/);
    assert.match(markup, /aria-label="Collapse the report"/);
  });

  it("draws the finale rail, the four stats and the highlights the model chose, with their asides", () => {
    const { markup, completion } = render(finishedRun());
    assert.equal((markup.match(/class="crew-strip rail finale"/g) ?? []).length, 4);
    assert.doesNotMatch(markup, /crew-sheen/, "no sheen unless asked for");
    const stats = [...markup.matchAll(/class="v">([^<]*)<\/div><div class="k">([^<]*)</g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(stats.map((s) => s[1]), ["agents", "wall clock", "tokens, reported by Muse", "estimate at list price"]);
    assert.deepEqual(stats.slice(0, 3).map((s) => s[0]), ["10", "45m 06s", "1.5M"]);
    assert.match(stats[3]?.[0] as string, /^~\$/);
    const rows = [...flatten(markup).matchAll(/<li>(?:<svg[\s\S]*?<\/svg>)?<span>([\s\S]*?)<\/span>(?:<span class="r">([^<]*)<\/span>)?<\/li>/g)].map((m) => [text(m[1] as string), m[2] ?? null]);
    assert.deepEqual(rows.slice(0, 4), [
      ["Longest agent judge:perf · 18m 36s", null],
      ["Most tokens research:field-notes · 288k", "20% of the run"],
      ["Retried design:conflict-ledger · landed on attempt 3", "after 2 failed attempts"],
      ["Waited on you 1m 40s", null],
    ]);
    assert.equal(completion.highlights.length, 4);
    assert.match(markup, /<span>Longest agent <b>judge:perf<\/b> · 18m 36s<\/span>/, "the strong part is set in bold");
  });

  it("shows where the time went: one lane per agent, a span per attempt, the phases' bands and the axis", () => {
    const { markup, completion } = render(finishedRun());
    assert.match(markup, /class="crew-fp" role="img" aria-label="Where the time went: 10 agents over 45m 06s"/);
    const bars = markup.match(/class="bar( f)?"/g) ?? [];
    assert.equal(bars.length, completion.fingerprint.lanes.reduce((n, lane) => n + lane.spans.length, 0));
    assert.equal(bars.filter((bar) => bar.includes(" f")).length, 2, "two failed attempts in the danger colour");
    for (const phase of ["Research", "Design", "Judge", "Synthesize"]) assert.match(markup, new RegExp(`class="lab"[^>]*>${phase}<`));
    assert.match(markup, /class="axis"><span style="left:0;transform:none">0<\/span>/);
    assert.match(markup, /10m<\/span>/);
    assert.match(markup, />45m 06s<\/span><\/div>/);
    assert.doesNotMatch(markup, /from loaded history/);
  });

  it("quotes the report's first lines through Markdown and points at the transcript", () => {
    const { markup } = render(finishedRun());
    assert.match(markup, /final summary · first lines/);
    assert.match(markup, /Recommend the <strong>CRDT ledger<\/strong>/);
    assert.match(markup, /Open in transcript</);
    assert.match(text(markup), /Handoffs design:crdt-ledger · ledger design doc/);
    assert.match(text(markup), /All 10 agents Timeline 10 done · 1 retried$/);
    assert.equal(reportMeta(finishedRun()), "10 done · 1 retried");
  });

  it("says Muse did not attach a report when there is none, and drops the seal when not everyone landed", () => {
    const feed = finishedFeed();
    const skipped = view(feed, S(50, 0), { skipped: [] }).vm.runs[0] as RunVM;
    assert.equal(skipped.status, "finished");
    const failed = mkRun(referenceAgents().map((agent) => ({ ...agent, quiet: null, state: agent.state === "failed" ? agent.state : "done" as const })), { status: "finished-with-failures", endedAt: S(43, 2), elapsedMs: S(43, 2) - S(0, 0), report: { summary: null, failure: null, handoffs: [] } });
    const { markup, completion } = render(failed);
    assert.equal(completion.sheen, false);
    assert.match(markup, /class="crew-tile mute"/);
    assert.match(markup, /Finished · 43m 02s/);
    assert.match(markup, /<h2>Nine of ten landed, one failed\.<\/h2>/);
    assert.match(markup, /Muse did not attach a report\./);
    assert.match(text(markup), /1 agent failed design:conflict-ledger after 2 attempts/);
  });

  it("plays the sheen only when asked, on a run where everyone landed", () => {
    const { markup } = render(finishedRun(), { sheen: true });
    assert.equal((markup.match(/crew-strip rail finale crew-sheen/g) ?? []).length, 4);
    const collapsed = render(finishedRun(), { expanded: false }).markup;
    assert.doesNotMatch(collapsed, /<h2>/);
    assert.match(collapsed, /aria-expanded="false"/);
  });

  it("is what the card becomes once the run ended, with the tasks below it", () => {
    const run = finishedRun();
    const markup = renderToStaticMarkup(createElement(TooltipProvider, { children: createElement(CrewCard, {
      sessionId: "s1", run, tasks: [], completion: completionView(run), sinceYouLeft: null, expanded: true, openPhase: null, selectedId: null, readOnly: false,
      onToggle: noop, onOpenPhase: noop, onInspect: noop, onOpenPanel: noop, onAction: noop, onStopRun: noop, onDismissReport: noop, onDismissRecap: noop, onReview: noop,
    }) }));
    assert.match(markup, /<h2>All ten landed\.<\/h2>/);
    assert.doesNotMatch(markup, /Needs attention|Stop run/);
  });
});

describe("SinceYouLeft", () => {
  it("says what moved while the user was away", () => {
    const run = finishedRun();
    const recap = sinceYouLeft(run, S(29, 0), S(50, 0));
    assert.ok(recap);
    assert.match(recapText(recap, S(50, 0)), /^Since you left at [^·]+ · 4 agents finished, Synthesize ran, the run finished at /);
    const markup = renderToStaticMarkup(createElement(SinceYouLeft, { recap, clockAt: S(50, 0), onDismiss: noop }));
    assert.match(markup, /<b>4 agents finished<\/b>/);
    assert.match(markup, /the run <b>finished at /);
    const failed = { leftAt: S(13, 0), finished: 2, failed: 1, phasesStarted: ["Judge"], runFinishedAt: null };
    assert.match(recapText(failed, S(41, 16)), /2 agents finished, 1 agent failed, Judge ran$/);
  });
});

describe("emphasized", () => {
  it("wraps the strong part once and leaves a line without it alone", () => {
    assert.equal(renderToStaticMarkup(createElement("span", null, emphasized("Waited on you 1m 40s", "1m 40s"))), "<span>Waited on you <b>1m 40s</b></span>");
    assert.equal(renderToStaticMarkup(createElement("span", null, emphasized("Peak concurrency 4 agents", "nothing"))), "<span>Peak concurrency 4 agents</span>");
  });
});
