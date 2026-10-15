import type { ContextUsage } from "../types.js";
import { formatTokens } from "./format.js";
import { formatCost, NO_PRICE_REASON, type TokenPrice } from "./pricing.js";
import { ESTIMATED_PRESSURE, isUnrecordedModel, type PriceCause, type SessionUsage, type TurnCost, type TurnsCost } from "./usage.js";

/**
 * The words and marks the cost, context and token panels show, as pure functions of what usage.ts computed, so
 * every rule about when a figure is a floor or an estimate is tested here and the components only lay it out.
 */

/** What the cost labels read; a SessionUsage satisfies it. */
type CostFacts = Pick<SessionUsage, "cost" | "currency" | "costComplete" | "partial" | "excludesSubagents" | "unpricedModel" | "unknownModel">;

/** The value of a figure that has no price at all: a dash, since a zero there would be made up. */
export const NO_VALUE = "—";

/** Leads a dollar figure that leaves out part of what was spent, so it reads as a floor and not a total. */
export const LOWER_BOUND = "≥";

/** A dollar figure as a floor, `≥ $1.20`: the one spelling every surface uses (the turn footer's `+` aside). */
export function atLeast(amount: string): string {
  return `${LOWER_BOUND} ${amount}`;
}

/** Why a call with no model id has no price: the id is missing, which is not the same as Meta not publishing a price. */
export const NO_MODEL_REASON = "Muse did not record the model for these calls";

/** Why one model has no price: a model Meta publishes none for, or the placeholder for calls that name no model. */
export function noPriceReason(modelId: string | null | undefined): string {
  return isUnrecordedModel(modelId) ? NO_MODEL_REASON : NO_PRICE_REASON;
}

/** The reasons behind unpriced calls, one for each cause that applies. */
export function unpricedWhy(cause: PriceCause): string {
  // With neither flag set, the usual cause is the one worth naming.
  const reasons = cause.unpricedModel || !cause.unknownModel ? [NO_PRICE_REASON] : [];
  if (cause.unknownModel) {
    reasons.push(NO_MODEL_REASON);
  }
  return reasons.join(". ");
}

/** The sentence a tooltip says about unpriced calls: what ran, then why it has no price. */
export function unpricedNote(cause: PriceCause): string {
  const named = cause.unpricedModel || !cause.unknownModel;
  const parts: string[] = [];
  if (named) {
    parts.push(`Some calls ran on an unpriced model. ${NO_PRICE_REASON}`);
  }
  if (cause.unknownModel) {
    parts.push(`${named ? "" : "Some calls are not priced. "}${NO_MODEL_REASON}`);
  }
  return parts.join(". ");
}

/** The line under a model's name in the cost popover: its published rates, or why it has none. */
export function modelRateCaption(modelId: string, price: TokenPrice | null): string {
  if (!price) {
    return noPriceReason(modelId);
  }
  const money = (value: number) => formatCost(value, price.currency);
  return `${money(price.input)}/M in · ${money(price.cached)}/M cached · ${money(price.output)}/M out`;
}

/**
 * A dollar figure with its bound: exact, or `≥ $1.50` when it is only a floor, because some call had no price or
 * it covers only part of what was spent. Either reason makes it a floor; the tooltip says which one it is.
 */
export function costLabel(cost: number, complete: boolean, partial: boolean, currency?: string | null): string {
  const amount = formatCost(cost, currency ?? undefined);
  return complete && !partial ? amount : atLeast(amount);
}

/** The thread cost with its bound; null when no call here has a price. Agents Muse leaves out make it a floor. */
export function usageCostLabel(usage: CostFacts): string | null {
  return usage.cost === null ? null : costLabel(usage.cost, usage.costComplete, usage.partial || usage.excludesSubagents, usage.currency);
}

/** Whether the cost is a floor for any reason, so a caption says ≥ where it would say ≈. */
export function costIsFloor(usage: CostFacts): boolean {
  return !usage.costComplete || usage.partial || usage.excludesSubagents;
}

/**
 * The Context panel's session cost: the chip's own figure, so the digits and the floor mark match it, with `≈` in
 * front when nothing is missing and the figure is an estimate from list prices. Null when no call was priced.
 */
export function contextCostValue(usage: CostFacts): string | null {
  const label = usageCostLabel(usage);
  if (label === null) {
    return null;
  }
  return costIsFloor(usage) ? label : `≈${label}`;
}

/**
 * A turn's cost under its reply. Unlike the floors above, which cover a whole thread, this one is short by exactly
 * the calls with no price, so its `+` reads "plus unpriced": `$0.02+` is $0.02 and something more.
 */
export function turnCostLabel(cost: Pick<TurnCost, "cost" | "currency" | "complete">): string {
  return `${formatCost(cost.cost, cost.currency ?? undefined)}${cost.complete ? "" : "+"}`;
}

/** The tooltip on the cost chip: what it is, then every reason it is only a floor. */
export function costTip(usage: CostFacts): string {
  const parts = ["What this thread would cost at API rates"];
  if (usage.partial) {
    parts.push("Loaded calls only");
  }
  if (!usage.costComplete) {
    parts.push(unpricedNote(usage));
  }
  if (usage.excludesSubagents) {
    parts.push("Workflow agents and subagents are not in it");
  }
  return parts.join(". ");
}

/** The sentences under the cost popover's headline, in order. The model rows below say why a call has no price. */
export function costNotes(usage: CostFacts): string[] {
  const notes = [
    usage.costComplete
      ? "What these tokens would have cost billed per token, not what you were charged."
      : "Part of this thread is not priced, so the total is a floor.",
  ];
  if (usage.partial) {
    notes.push("Covers the loaded calls only; earlier turns are not shown.");
  }
  if (usage.excludesSubagents) {
    notes.push("This thread's cost covers the lead agent only; workflow agents and subagents are in the run card.");
  }
  return notes;
}

/** The title on the Context panel's cost: an estimate, or a floor with the reason. */
export function costTitle(usage: CostFacts): string {
  if (!costIsFloor(usage)) {
    return "Estimated from list prices";
  }
  const parts = ["At least this much"];
  if (usage.partial) {
    parts.push("It covers the loaded calls only");
  }
  if (!usage.costComplete) {
    parts.push(unpricedNote(usage));
  }
  if (usage.excludesSubagents) {
    parts.push("Workflow agents and subagents are not in it");
  }
  return parts.join(". ");
}

/**
 * The popover line for agent spend the cost leaves out. It counts workflow agents as well as subagents, so it is
 * not the total of the Context panel's Subagents group, which lists subagent items only.
 */
export function subagentLine(tokens: number): string {
  return `Subagents and workflow agents, not priced: ${formatTokens(tokens)} tokens`;
}

/** The tooltip on a turn's cost in the transcript footer. */
export function turnCostTip(cost: TurnCost): string {
  const counts = `${formatTokens(cost.promptTokens)} in (${formatTokens(cost.cachedTokens)} cached), ${formatTokens(cost.outputTokens)} out`;
  return `At API rates: ${counts}${cost.complete ? "" : `; ${unpricedNote(cost)}`}`;
}

export interface TokenRow {
  id: string;
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
  strong?: boolean;
}

/**
 * The cost popover's token rows. Uncached input is the prompt not served from the cache and Cached input the cache
 * reads, both summed per call, so with Output they explain the dollars above. The Context panel's Input counts
 * the whole prompt, cache included, so this row says what it leaves out. Once earlier turns are missing every row
 * is the loaded calls' own, and says so, rather than mixing them with Muse's whole-session totals.
 */
export function costRows(usage: Pick<SessionUsage, "partial" | "freshTokens" | "cachedReadTokens" | "outputTokens" | "loadedOutputTokens" | "reasoningTokens" | "calls">): TokenRow[] {
  const loaded = usage.partial;
  const rows: TokenRow[] = [
    { id: "input", label: loaded ? "Loaded uncached input" : "Uncached input", value: formatTokens(usage.freshTokens) },
    { id: "cached", label: loaded ? "Loaded cached input" : "Cached input", value: formatTokens(usage.cachedReadTokens) },
    { id: "output", label: loaded ? "Loaded output" : "Output", value: formatTokens(loaded ? usage.loadedOutputTokens : usage.outputTokens) },
  ];
  if (usage.reasoningTokens > 0) {
    rows.push({ id: "reasoning", label: "of that, reasoning", value: formatTokens(usage.reasoningTokens), muted: true });
  }
  rows.push({ id: "calls", label: loaded ? "Loaded model calls" : "Model calls", value: String(usage.calls) });
  return rows;
}

/**
 * The Context panel's token rows, and the note under them once earlier turns are missing. Input and Output are
 * the loaded calls' when the history is partial, and Muse's counted-once totals otherwise; the Total is always
 * Muse's, and a floor when Muse sent none.
 */
export function contextTokenRows(
  usage: Pick<SessionUsage, "partial" | "promptTokens" | "outputTokens" | "loadedPromptTokens" | "loadedOutputTokens" | "reasoningTokens" | "cachedReadTokens" | "cacheWriteTokens" | "totalTokens" | "totalsComplete">,
): { rows: TokenRow[]; note: string | null } {
  const loaded = usage.partial;
  const rows: TokenRow[] = [
    {
      id: "input",
      label: loaded ? "Loaded input" : "Input",
      hint: loaded ? undefined : "Prompt tokens, each counted once",
      value: formatTokens(loaded ? usage.loadedPromptTokens : usage.promptTokens),
    },
    { id: "output", label: loaded ? "Loaded output" : "Output", value: formatTokens(loaded ? usage.loadedOutputTokens : usage.outputTokens) },
  ];
  if (usage.reasoningTokens > 0) {
    rows.push({ id: "reasoning", label: "Reasoning", hint: "Part of the output", value: formatTokens(usage.reasoningTokens) });
  }
  rows.push(
    { id: "cacheRead", label: loaded ? "Loaded cache read" : "Cache read", value: formatTokens(usage.cachedReadTokens) },
    { id: "cacheWrite", label: loaded ? "Loaded cache write" : "Cache write", value: formatTokens(usage.cacheWriteTokens) },
    {
      id: "total",
      label: "Total",
      hint: loaded ? (usage.totalsComplete ? "Whole session" : "Loaded calls") : undefined,
      value: `${usage.totalsComplete ? "" : "≥"}${formatTokens(usage.totalTokens)}`,
      strong: true,
    },
  );
  const note = loaded
    ? `Earlier turns are not loaded, so these rows cover the loaded calls only.${usage.totalsComplete ? " The total is Muse's count for the whole session." : ""}`
    : null;
  return { rows, note };
}

/** What marks the Activity heading once earlier turns are missing. */
export const LOADED_ONLY = "Loaded calls only";

/** The caption under the Subagents group: their tokens are Muse's raw counters, outside its total, and unpriced. */
export const SUBAGENT_CAPTION = "Outside Muse's total and not priced.";

/** The tooltip on the session speed: what the figure divides, so it is never mistaken for a wire speed. */
export const SPEED_TIP = "Output tokens including reasoning over model call time. Calls of ten tokens or fewer, and calls with no measured time, are left out.";

export type ContextTone = "normal" | "warn" | "danger";

/** The ring turns warn here, and danger here, on an estimated reading: a display rule of Ancilla's, not Muse's. */
const ESTIMATE_WARN = 0.85;
const ESTIMATE_DANGER = 0.98;

/**
 * The tone of the context ring. Muse's own pressure decides when it spoke. An estimate from the last call has no
 * pressure, so only its look is derived from how full the window is, never claimed as Muse's word.
 */
export function contextTone(usage: ContextUsage): ContextTone {
  if (usage.pressure === "blocked") {
    return "danger";
  }
  if (usage.pressure === "warning") {
    return "warn";
  }
  if (usage.pressure === ESTIMATED_PRESSURE && usage.windowTokens) {
    const fill = usage.usedTokens / usage.windowTokens;
    return fill >= ESTIMATE_DANGER ? "danger" : fill >= ESTIMATE_WARN ? "warn" : "normal";
  }
  return "normal";
}

export interface ContextMeterView {
  /** How full the ring is, 0 to 1; null when the window is not known, which draws an empty ring. */
  fill: number | null;
  /** The text beside the ring: a percentage, or the used tokens when there is no window to divide by. */
  text: string;
  tone: ContextTone;
  tip: string;
  aria: string;
}

/**
 * What the composer's context ring shows. A reading without a window size keeps the ring, with the tokens in
 * context and no percentage, so the panel and its Compact button stay reachable.
 */
export function contextMeterView(usage: ContextUsage): ContextMeterView {
  const used = formatTokens(usage.usedTokens);
  const tone = contextTone(usage);
  const estimated = usage.pressure === ESTIMATED_PRESSURE;
  if (!usage.windowTokens) {
    return {
      fill: null,
      text: used,
      tone,
      tip: `${used} tokens in context. The window size is not known${estimated ? ", and this is estimated from the last call" : ""}`,
      aria: `Context window, ${used} tokens in context`,
    };
  }
  const fill = Math.min(1, usage.usedTokens / usage.windowTokens);
  const percent = fill < 0.01 ? "<1%" : `${Math.round(fill * 100)}%`;
  return {
    fill,
    text: percent,
    tone,
    tip: `${used} of ${formatTokens(usage.windowTokens)} tokens in context${estimated ? ", estimated from the last call" : ""}`,
    aria: `Context window ${percent} used${estimated ? ", estimated" : ""}`,
  };
}

/** The line under the context bar: Muse's pressure in words, or a plain note that the reading is an estimate. */
export function pressureNote(pressure: string): { text: string; tone: "danger" | "warn" | "muted" } {
  if (pressure === "blocked") {
    return { text: "Full. Compact the session to continue.", tone: "danger" };
  }
  if (pressure === "warning") {
    return { text: "Filling up", tone: "warn" };
  }
  if (pressure === ESTIMATED_PRESSURE) {
    return { text: "Estimated from the last call", tone: "muted" };
  }
  return { text: "Plenty of room", tone: "muted" };
}

const GOAL_EARLIER_TURNS = "Earlier turns of this goal are not loaded, so the real figure is higher.";

/**
 * The goal's cost as the panel prints it: a floor reads `≥ $0.10` when a call was unpriced or a goal turn is not
 * loaded, and a dash when nothing was priced at all (`≥ $0` would be a made-up zero; the tooltip says why).
 */
export function goalCostValue(spend: TurnsCost | null): string {
  if (!spend) {
    return "Not known";
  }
  if (spend.cost === 0 && !spend.complete) {
    return NO_VALUE;
  }
  const amount = formatCost(spend.cost, spend.currency ?? undefined);
  return spend.complete && !spend.partial ? amount : atLeast(amount);
}

/** The goal cost's tooltip, with every reason the figure is a floor. */
export function goalCostTip(spend: TurnsCost | null): string {
  const parts = ["What this goal's work would have cost at published API rates."];
  if (spend && !spend.complete) {
    parts.push(`${unpricedNote(spend)}, so the real figure is higher.`);
  }
  if (spend?.partial) {
    parts.push(GOAL_EARLIER_TURNS);
  }
  return parts.join(" ");
}

/** The goal's token count as the panel prints it: `≥ 12k of 50k` when earlier turns of the goal are not loaded. */
export function goalTokensValue(tokens: number, budget: number | null, partial: boolean): string {
  const used = `${partial ? "≥ " : ""}${formatTokens(tokens)}`;
  return budget ? `${used} of ${formatTokens(budget)}` : used;
}

/** The tooltip on the goal's tokens: what is counted, whether earlier turns are missing, and Muse's own count. */
export function goalTokensTip(partial: boolean, museCount: number | null): string {
  const parts = ["Input and output tokens of this goal's model calls."];
  if (partial) {
    parts.push(GOAL_EARLIER_TURNS);
  }
  if (museCount !== null && museCount > 0) {
    parts.push(`Muse's own count at its last goal update: ${formatTokens(museCount)}.`);
  }
  return parts.join(" ");
}

/** The share of a window a part fills, to a tenth of a percent; empty when there is no window to divide by. */
export function share(part: number, whole: number | null): string {
  if (!whole) {
    return "";
  }
  const value = (part / whole) * 100;
  return value > 0 && value < 0.1 ? "<0.1%" : `${value.toFixed(1)}%`;
}

/** The segment bar's name for a screen reader: the share used, or the tokens in context when there is no window. */
export function segmentBarLabel(used: number, window: number | null): string {
  return window ? `${share(used, window)} of the context window used` : `${formatTokens(used)} tokens in context`;
}

/** The line under the Breakdown: who counted the total, then what the split is. An estimated total is Ancilla's. */
export function breakdownNote(pressure: string): string {
  const total = pressure === ESTIMATED_PRESSURE ? "The total is estimated from the last model call." : "Muse reports the total.";
  return `${total} The split marked ≈ is estimated from this thread's text.`;
}
