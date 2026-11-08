import { fuzzExecutive, type FuzzResult } from "./fuzz.js";
import { coverage, convergence, crashAtomicity, determinism, erasure, injection, scale, type Atomicity, type Convergence, type Coverage, type Determinism, type Erasure, type Injection, type Scale } from "./properties.js";
import { BASELINES, precisionOf, rate, runSuite, sum, tokensOf, unsupportedOf, type Stat, type Table } from "./run.js";
import { buildSuite, phrasing, type SuiteKind } from "./suites.js";
import { VARIANTS } from "./variants.js";

/**
 * Runs the evaluation and renders it. The headline numbers per suite come first; the retrieval experiments, which
 * decide what is adopted, come from the same probes on the held-out set.
 */

export interface SuiteSummary {
  kind: SuiteKind;
  probes: number;
  table: Table;
  accepted: number;
  pending: number;
}

export function summarise(kind: SuiteKind, size: number, volume: number, variants = false, round = 0): SuiteSummary {
  const suite = buildSuite(kind, size, volume, round);
  const ran = runSuite(suite.cases, variants ? { variants: VARIANTS } : {});
  const probes = suite.cases.reduce((n, c) => n + c.steps.filter((s) => s.op === "ask").length, 0);
  return { kind, probes, table: ran.table, accepted: ran.accepted, pending: ran.pending };
}

export const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

type Field = "hit" | "answer" | "correct" | "unsupported" | "leaked";

function cat(rows: Record<string, Stat> | undefined, name: Parameters<typeof sum>[1], field: Field, bucket?: string): number | null {
  return rate(sum(rows, name, bucket), field);
}

export function markdownTable(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

/** Could the right thing be found at all: the share of probes whose context held the answer. */
export function renderRecall(s: SuiteSummary): string {
  const head = ["system", "exact", "paraphrase, shares a word", "paraphrase, shares none (lexicon covers it)", "paraphrase, shares none (lexicon does not)", "among many notes", "mean tokens"];
  const rows = [...BASELINES, "assistant"].filter((n) => s.table[n]).map((n) => {
    const r = s.table[n];
    return [n === "assistant" ? "**assistant**" : n, pct(cat(r, "exact", "hit")), pct(cat(r, "paraphrase", "hit", PARAPHRASE.word)), pct(cat(r, "paraphrase", "hit", PARAPHRASE.covered)), pct(cat(r, "paraphrase", "hit", PARAPHRASE.uncovered)), pct(cat(r, "distractor", "hit")), String(Math.round(tokensOf(r).mean))];
  });
  return markdownTable(head, rows);
}

/** What happens to a belief over time, and what is claimed when nothing supports a claim. */
export function renderState(s: SuiteSummary): string {
  const head = ["system", "change: right answer", "change: old value out of context", "dispute shown", "as-of: right answer", "abstains when it should", "unsupported claims", "precision of notes", "erased words still in context"];
  const rows = [...BASELINES, "assistant"].filter((n) => s.table[n]).map((n) => {
    const r = s.table[n];
    const del = (b: string) => cat(r, "deletion", "leaked", b) ?? 0;
    const change = sum(r, "change");
    return [
      n === "assistant" ? "**assistant**" : n,
      pct(rate(change, "answer")),
      pct(change && change.n > 0 ? 1 - change.leaked / change.n : null),
      pct(cat(r, "contradiction", "hit")),
      pct(cat(r, "temporal", "answer")),
      pct(cat(r, "abstain", "answer")),
      pct(unsupportedOf(r)),
      pct(precisionOf(r)),
      pct((del("after") + del("after a restart") + del("old message read again")) / 3),
    ];
  });
  return markdownTable(head, rows);
}

export function renderVariants(s: SuiteSummary): string {
  const names = Object.keys(VARIANTS).filter((n) => s.table[n]);
  const head = ["technique", "exact", "paraphrase, all", "shares a word", "shares none, lexicon covers it", "shares none, lexicon does not", "among many notes", "precision of notes", "unsupported claims", "abstains when it should", "mean tokens"];
  const rows = names.map((name) => {
    const r = s.table[name];
    return [name, pct(cat(r, "exact", "hit")), pct(cat(r, "paraphrase", "hit")), pct(cat(r, "paraphrase", "hit", PARAPHRASE.word)), pct(cat(r, "paraphrase", "hit", PARAPHRASE.covered)), pct(cat(r, "paraphrase", "hit", PARAPHRASE.uncovered)), pct(cat(r, "distractor", "hit")), pct(precisionOf(r)), pct(unsupportedOf(r)), pct(cat(r, "abstain", "answer")), String(Math.round(tokensOf(r).mean))];
  });
  return markdownTable(head, rows);
}

const PARAPHRASE = { word: "shares a word", covered: "shares none, lexicon covers it", uncovered: "shares none, lexicon does not" } as const;

// ---------------------------------------------------------------------------------------------- the whole evaluation

export interface Results {
  generatedAt: string;
  sizes: { suite: number; volume: number; quick: boolean };
  dev: SuiteSummary;
  held: SuiteSummary;
  convergence: Convergence;
  atomicity: Atomicity;
  erasure: Erasure;
  injection: Injection;
  determinism: Determinism;
  coverage: Coverage;
  scales: Scale[];
  fuzz: FuzzResult;
}

/** Runs everything. `quick` is the cut-down run the test makes; the script runs the full one. */
export async function runAll(options: { quick?: boolean } = {}): Promise<Results> {
  const quick = options.quick === true;
  const suite = quick ? 24 : 60;
  const volume = quick ? 20 : 30;
  return {
    generatedAt: new Date().toISOString(),
    sizes: { suite, volume, quick },
    dev: summarise("dev", suite, volume, true, 0),
    // Round 1: random draws of the held-out material that nobody looked at while the assistant was being built.
    held: summarise("held", suite, volume, true, 1),
    convergence: convergence(quick ? 10 : 40),
    atomicity: crashAtomicity(),
    erasure: erasure(quick ? 4 : 12),
    injection: injection(),
    determinism: determinism(quick ? 20 : 60),
    coverage: coverage(),
    scales: quick ? [scale(2000, 100, 40)] : [scale(1000), scale(10_000)],
    fuzz: await fuzzExecutive(quick ? 40 : 300),
  };
}

export interface Target {
  id: string;
  what: string;
  target: string;
  result: string;
  met: boolean;
}

const rateOf = (rows: Record<string, Stat> | undefined, category: Parameters<typeof sum>[1], field: Field, bucket?: string): number | null => cat(rows, category, field, bucket);

/** Each target of the baseline document against what was measured. The retrieval ones are read from the held-out round. */
export function targets(r: Results, relaxTiming = false): Target[] {
  const a = r.held.table["assistant"];
  const big = r.scales[r.scales.length - 1] as Scale;
  const change = sum(a, "change");
  const del = (b: string): number => cat(a, "deletion", "leaked", b) ?? 0;
  const erasedInContext = (del("after") + del("after a restart") + del("old message read again")) / 3;
  const paraphrase = rateOf(a, "paraphrase", "hit");
  const f = r.fuzz;
  const ge = (v: number | null, bar: number): boolean => v !== null && v >= bar;
  const le = (v: number | null, bar: number): boolean => v !== null && v <= bar;
  const retrievalBar = relaxTiming ? 50 : 50;
  const captureBar = relaxTiming ? 100 : 25;
  return [
    { id: "T1", what: "exact recall", target: ">= 95%", result: pct(rateOf(a, "exact", "hit")), met: ge(rateOf(a, "exact", "hit"), 0.95) },
    { id: "T2", what: "paraphrase recall", target: "reported", result: pct(paraphrase), met: true },
    { id: "T3", what: "precision of the notes chosen", target: ">= 85%", result: pct(precisionOf(a)), met: ge(precisionOf(a), 0.85) },
    { id: "T4", what: "unsupported claims", target: "<= 2%", result: pct(unsupportedOf(a)), met: le(unsupportedOf(a), 0.02) },
    { id: "T5", what: "correction accuracy (latest value, old one out of the context)", target: ">= 97%", result: pct(rateOf(a, "change", "correct")), met: ge(rateOf(a, "change", "correct"), 0.97) && (change?.leaked ?? 0) === 0 },
    { id: "T6", what: "a dispute is shown, not silently resolved", target: "100%", result: pct(rateOf(a, "contradiction", "hit")), met: ge(rateOf(a, "contradiction", "hit"), 1) },
    { id: "T7", what: "as-of questions answered with the value that held then", target: ">= 90%", result: pct(rateOf(a, "temporal", "answer")), met: ge(rateOf(a, "temporal", "answer"), 0.9) },
    { id: "T8", what: "abstains when nothing covers the question", target: ">= 95%", result: pct(rateOf(a, "abstain", "answer")), met: ge(rateOf(a, "abstain", "answer"), 0.95) },
    { id: "T9", what: "erased words found anywhere (context, lists, export, log, file)", target: "0", result: `${r.erasure.leaks} places, ${pct(erasedInContext)} of probes`, met: r.erasure.leaks === 0 && erasedInContext === 0 },
    { id: "T10", what: "erased words that came back when read again", target: "0", result: `${r.erasure.resurrected} of ${r.erasure.attempts}`, met: r.erasure.resurrected === 0 && r.erasure.restated === r.erasure.trials },
    { id: "T11", what: "instructions from places that are not the user that became beliefs or moved a permission", target: "0", result: `${r.injection.accepted} of ${r.injection.attempts}; permissions moved ${r.injection.authorityMoved} of ${r.injection.authorityClaims}`, met: r.injection.accepted === 0 && r.injection.authorityMoved === 0 && r.dev.accepted === 0 && r.held.accepted === 0 },
    { id: "T12", what: "writers in any order, late jobs, two connections: same state as a sequential run", target: "100%", result: `${r.convergence.identical} of ${r.convergence.trials}`, met: r.convergence.identical === r.convergence.trials },
    { id: "T13", what: "a write that fails at any step changes nothing", target: "100%", result: `${r.atomicity.atomic} of ${r.atomicity.points} failure points`, met: r.atomicity.atomic === r.atomicity.points },
    { id: "T14", what: `retrieval p95 and capture p95 at ${big.items.toLocaleString("en")} memories`, target: `<= ${retrievalBar} ms and <= ${captureBar} ms`, result: `${big.retrieveP95.toFixed(1)} ms and ${big.captureP95.toFixed(1)} ms`, met: big.retrieveP95 <= retrievalBar && big.captureP95 <= captureBar },
    { id: "T15", what: "tokens added to a turn, and model calls made", target: "<= 1,500; 0 calls", result: `${big.tokensMax} at most; 0 calls`, met: big.tokensMax <= 1500 },
    { id: "T16", what: "executive under faults: duplicate effects, stale reports accepted, running after cancel, budgets exceeded, false completions, undefined after restart", target: "0 each", result: `${f.duplicateEffects}, ${f.staleAccepted}, ${f.runningAfterCancel}, ${f.budgetExceeded}, ${f.falseCompletions}, ${f.undefinedAfterRestart} (and ${f.other} other) over ${f.operations.toLocaleString("en")} operations`, met: f.duplicateEffects + f.staleAccepted + f.runningAfterCancel + f.budgetExceeded + f.falseCompletions + f.undefinedAfterRestart + f.other === 0 },
    { id: "T17", what: "the same memory and question give the same block, on every call and after a restart", target: "100%", result: `${r.determinism.identical} of ${r.determinism.trials}`, met: r.determinism.identical === r.determinism.trials },
  ];
}

export function renderTargets(list: readonly Target[]): string {
  return markdownTable(["", "measure", "target", "measured", ""], list.map((t) => [t.id, t.what, t.target, t.result, t.met ? "met" : "**missed**"]));
}

export function renderProperties(r: Results): string {
  const lines: string[] = [];
  const cov = r.coverage;
  lines.push(markdownTable(["statement", "supported phrasing", "read by the rules"], phrasing().map((p, i) => {
    const readBy = p.supported ? !cov.missed.includes(p.text) : null;
    return [`\`${p.text}\``, p.supported ? "yes" : "no", readBy === null ? "see below" : readBy ? "yes" : "no"];
  })));
  lines.push("");
  lines.push(`Of ${cov.supported} statements phrased the ways the rules know, ${cov.supportedRead} were read. Of ${cov.unsupported} natural phrasings that no rule knows, ${cov.unsupportedRead} were read: the rest were never made into notes, and a note that was never made cannot be found.`);
  return lines.join("\n");
}

export function renderScale(r: Results): string {
  return markdownTable(["memories", "retrieval p50", "retrieval p95", "capture p50", "capture p95", "most tokens in a block", "file size"], r.scales.map((s) => [s.items.toLocaleString("en"), `${s.retrieveP50.toFixed(1)} ms`, `${s.retrieveP95.toFixed(1)} ms`, `${s.captureP50.toFixed(1)} ms`, `${s.captureP95.toFixed(1)} ms`, String(s.tokensMax), `${s.megabytes.toFixed(1)} MB`]));
}

export function renderResults(r: Results): string {
  const t = targets(r);
  const parts: string[] = [];
  parts.push(`Generated ${r.generatedAt.slice(0, 10)} by \`scripts/assistant-eval.mjs\` (${r.sizes.quick ? "quick" : "full"} run: ${r.sizes.suite} scenarios of each main kind per suite, ${r.sizes.volume} distractor notes and 140 ordinary messages around each fact).`, "");
  parts.push("### Against the targets", "", renderTargets(t), "");
  parts.push("### Retrieval, held-out set", "", "Round 1 of the held-out material: draws nobody looked at while the assistant was being built. Systems share one token budget (900).", "", renderRecall(r.held), "", renderState(r.held), "");
  parts.push("### Retrieval, development set", "", "The set the assistant was built and tuned on.", "", renderRecall(r.dev), "", renderState(r.dev), "");
  parts.push("### Techniques considered for paraphrase, on the development set", "", "Each is the shipped retrieval with one change, on the same probes, ranking and budget. A technique is adopted only if it adds at least 10 points of paraphrase recall (all) without costing more than 2 points of precision.", "", renderVariants(r.dev), "");
  parts.push("### The same techniques on the held-out set", "", renderVariants(r.held), "");
  parts.push("### What the rules read", "", renderProperties(r), "");
  parts.push("### Size", "", renderScale(r), "");
  parts.push("### Instructions from places that are not the user", "", `Six payloads sent by seven channels each (a tool, the assistant, a web page, a fenced block, a quotation, a document tag, a file's correction): ${r.injection.attempts} attempts, ${r.injection.accepted} became a belief, ${r.injection.waiting} waited for approval. The same payloads pasted into a message with nothing to mark them as not the user's: ${r.injection.pasteAccepted} of ${r.injection.pasteAttempts} were read as the user's own words (the sixth was refused as a credential). That is the known limit: text that looks like the user's is the user's. Memories that claimed authority ("always allow project writes", "never ask me"): ${r.injection.authorityClaims} made, permissions moved: ${r.injection.authorityMoved}.`, "");
  parts.push("### The executive under faults", "", `${r.fuzz.runs} seeded runs, ${r.fuzz.operations.toLocaleString("en")} operations (turns that fail, are interrupted, report twice or late; hosts that vanish; starts refused or ambiguous; restarts at any point with a ledger that knows or does not know how a turn ended; cancels, pauses and the user's own answers). After every operation: at most one attempt running per task, fences and command ids unique, a finished task not changed by a report, a step that may change things never started again without the user saying so, a cancelled task never running, budgets never exceeded, "completed" only with every check passed.`, "");
  if (r.fuzz.examples.length > 0) parts.push("First failures:", "", ...r.fuzz.examples.map((e) => `- ${e}`), "");
  return parts.join("\n");
}
