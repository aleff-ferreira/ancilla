import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { costCell, tokensCell } from "../src/components/crew/KpiStrip.js";
import { headSub } from "../src/components/crew/CrewCard.js";
import { RETRIED_TOKENS_NOTE, completionView, crewView, reportCoverage, type AgentVM, type CrewOptions, type RunVM } from "../src/model/crew.js";
import { emptyFold } from "../src/model/fold.js";
import { NO_PRICE_REASON } from "../src/model/pricing.js";
import type { ResearchRunView, ViewEvent } from "../src/types.js";
import { session } from "./crew-fixtures.js";
import { RESEARCH_NOW, runningResearch } from "./fixtures/research.js";
import { NOW, S, finishedRun, lantern, mkRun, referenceAgents, runningRun, view } from "./fixtures/lantern.js";

/**
 * A total and an estimate built from the agents that reported say how many that was, and an estimate that is
 * missing says why: no usage yet, roles on different models, a model Meta publishes no price for, or no model.
 */

const WONDER_FULL = "muse-wonder-full-1.0";

const modelChanged = (at: number, modelId: string): ViewEvent => ({ method: "session/modelChanged", at, params: { modelId } });

describe("coverage of a workflow run's totals", () => {
  it("says how many agents reported while the run goes: in the head, the tokens cell and the cost cell", () => {
    const run = runningRun();
    assert.deepEqual(run.tokens, { total: 1_200_500, reported: 8, of: 9 });
    assert.equal(reportCoverage(run), "8 of 9 reported");
    assert.equal(headSub(run).text.includes("1.2M tokens so far (8 of 9 reported)"), true, headSub(run).text);
    assert.equal(tokensCell(run, true).sub, "8 of 9 reported");
    const cost = costCell(run);
    assert.match(String(cost.value), /^~\$1\.94$/);
    assert.equal(cost.sub, "at list price · 8 of 9 reported");
  });

  it("drops the coverage once every agent has reported, and the so-far with the run's end", () => {
    const run = finishedRun();
    assert.equal(run.tokens?.reported, run.tokens?.of);
    assert.equal(reportCoverage(run), null);
    assert.equal(costCell(run).sub, "at list price");
    assert.match(headSub(run).text, / · 1\.4M tokens · ~\$[\d.]+ est\.$/);
    assert.equal(tokensCell(run, false).sub, "all 10 reported");
  });

  it("keeps the coverage on a finished run when some agents never reported", () => {
    const run = mkRun(referenceAgents(), { status: "finished", endedAt: S(45, 0), tokens: { total: 1_200_500, reported: 8, of: 9 }, cost: { usd: 1.94, model: "muse-spark-1.3" } });
    assert.match(headSub(run).text, / · 1\.2M tokens \(8 of 9 reported\) · ~\$1\.94 est\.$/);
    assert.equal(costCell(run).sub, "at list price · 8 of 9 reported");
  });

  it("has no coverage to give for a run that counts its own tokens, or for an ordinary turn", () => {
    assert.equal(reportCoverage(mkRun([], { kind: "research", tokens: { total: 91_420, reported: 0, of: 3 } })), null);
    assert.equal(reportCoverage(mkRun([], { kind: "turn", tokens: { total: 1100, reported: 1, of: 1 } })), null);
    assert.equal(reportCoverage(mkRun([], { tokens: null })), null);
  });

  it("names the retry rule on the report's token stat only when an agent was retried", () => {
    const retried = completionView(finishedRun());
    assert.equal(retried?.stats[2]?.label, `tokens, reported by Muse${RETRIED_TOKENS_NOTE}`);
    assert.match(retried?.stats[2]?.label ?? "", /latest attempt/);
    assert.equal(retried?.stats[2]?.value, "1.4M", "the retry rule does not change the total: the newest report stands for the agent");
    const calm = completionView(mkRun(referenceAgents(), { status: "finished", endedAt: S(45, 0), retried: 0, tokens: { total: 1_382_000, reported: 10, of: 10 } }));
    assert.equal(calm?.stats[2]?.label, "tokens, reported by Muse");
  });
});

describe("an estimate that is missing says why", () => {
  it("has no usage yet", () => {
    const cell = costCell(mkRun(referenceAgents(), { tokens: null }));
    assert.equal(cell.value, "—");
    assert.equal(cell.sub, "no usage reported yet");
  });

  it("names a model Meta publishes no price for, and says why in the tooltip", () => {
    const run = view(lantern(), NOW, {}, [modelChanged(S(41, 0), WONDER_FULL)]).vm.runs[0] as RunVM;
    assert.equal(run.cost, null);
    assert.equal(run.priceModel, WONDER_FULL);
    const cell = costCell(run);
    assert.equal(cell.sub, `no list price for ${WONDER_FULL}`);
    assert.equal(cell.title, `${WONDER_FULL}: ${NO_PRICE_REASON}`);
  });

  it("does not claim a model has no price when it does not know the model", () => {
    const f = view(lantern(), NOW).fold;
    const run = crewView(f, { ...session("s1", "x"), modelId: null }, NOW).runs[0] as RunVM;
    assert.equal(run.cost, null);
    assert.equal(run.priceModel, null);
    assert.equal(costCell(run).sub, "model not resolved");
  });

  it("says the roles of a run ran on different models", () => {
    assert.equal(costCell(mkRun(referenceAgents(), { tokens: { total: 91_420, reported: 0, of: 3 }, mixedModels: true, priceModel: null })).sub, "Mixed models");
  });
});

describe("a DeepResearch run's model", () => {
  const SESSION_MODEL = "muse-spark-1.3";
  const models = (over: Partial<ResearchRunView["config"]["models"]>): ResearchRunView => {
    const base = runningResearch();
    return runningResearch({ config: { ...base.config, models: { supervisor: null, worker: null, writer: null, ...over } } });
  };
  const runOf = (research: ResearchRunView, modelId: string | null = SESSION_MODEL, opts: CrewOptions = {}): RunVM =>
    crewView(emptyFold(), session("s1", "Research", { modelId }), RESEARCH_NOW, { researchRuns: [research], ...opts }).runs[0] as RunVM;
  const worker = (run: RunVM): AgentVM => run.agents[0] as AgentVM;

  it("runs on the thread's model when the config names no role, and is priced at it", () => {
    const run = runOf(models({}));
    assert.equal(run.cost?.model, SESSION_MODEL);
    // 88,300 in with 40,100 of it cached, and 3,120 out, at $1.25, $0.15 and $4.25 per million.
    assert.ok(Math.abs((run.cost?.usd ?? 0) - ((48_200 * 1.25 + 40_100 * 0.15 + 3_120 * 4.25) / 1_000_000)) < 1e-9);
    assert.equal(worker(run).research?.model, SESSION_MODEL);
    assert.equal(run.mixedModels, false);
  });

  it("does not name the supervisor's or the writer's model as the worker's", () => {
    assert.equal(worker(runOf(models({ supervisor: "muse-spark-1.1" }))).research?.model, SESSION_MODEL);
    assert.equal(worker(runOf(models({ writer: "muse-spark-1.1" }))).research?.model, SESSION_MODEL);
    assert.equal(worker(runOf(models({ worker: "muse-spark-1.1" }))).research?.model, "muse-spark-1.1");
  });

  it("has no single price when the roles resolve to different models", () => {
    for (const over of [{ supervisor: "muse-spark-1.1" }, { worker: "muse-spark-1.3", writer: "muse-spark-1.1" }]) {
      const run = runOf(models(over));
      assert.equal(run.cost, null, JSON.stringify(over));
      assert.equal(run.mixedModels, true);
      assert.equal(run.priceModel, null);
      assert.equal(costCell(run).sub, "Mixed models");
    }
  });

  it("is priced when every role names the same model, thread model or not", () => {
    const same = runOf(models({ supervisor: "muse-spark-1.1", worker: "muse-spark-1.1", writer: "muse-spark-1.1" }));
    assert.equal(same.cost?.model, "muse-spark-1.1");
    assert.equal(same.mixedModels, false);
  });

  it("says the model is not resolved, not that it has no price, when nothing names it", () => {
    const run = runOf(models({}), null);
    assert.equal(run.cost, null);
    assert.equal(run.priceModel, null);
    assert.equal(run.mixedModels, false);
    assert.equal(worker(run).research?.model, null);
    assert.equal(run.tokens?.total, 91_420);
    assert.equal(costCell(run).sub, "model not resolved");
    // One role named and the rest unresolvable: the others could be anything, so it is neither priced nor called mixed.
    const partial = runOf(models({ worker: "muse-spark-1.3" }), null);
    assert.equal(partial.cost, null);
    assert.equal(partial.mixedModels, false);
    assert.equal(costCell(partial).sub, "model not resolved");
  });

  it("names a model Meta publishes no price for when every role runs on it", () => {
    const run = runOf(models({}), WONDER_FULL);
    assert.equal(run.cost, null);
    assert.equal(run.priceModel, WONDER_FULL);
    assert.equal(costCell(run).sub, `no list price for ${WONDER_FULL}`);
  });
});
