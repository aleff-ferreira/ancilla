/**
 * The supervisor loop: decide, delegate, merge, repeat.
 *
 * Port of the control flow of Deep Dog 2 `deep_research/multi_agent_supervisor.py` L329-864 (the `supervisor`
 * and `supervisor_tools` nodes) at commit `fc7981a`, without LangGraph. Each round asks the supervisor model for
 * one decision, runs its delegations through the host's `WorkerRunner` under a parallel cap, and folds the
 * results into the run state. The exit rules, the verdict gating, the circuit breaker and the retry-then-salvage
 * policy follow upstream; the parallel cap, the token soft cap and provenance-checked citation codes are new.
 */

import { RESEARCH_LIMITS } from "./config.js";
import { assignCodes, normalizeUrl } from "./citations.js";
import { RunContext, RunCancelled, hasFindings, shouldSalvage } from "./context.js";
import { capNote, capText } from "./notes.js";
import { parseDecision, type ParsedDecision, type ParsedDelegation } from "./parse.js";
import { DEFAULT_TARGET_LANGUAGE } from "./prompts/common.js";
import { SUPERVISOR_RETRY_NUDGE, buildSupervisorPrompt } from "./prompts/supervisor.js";
import { buildWorkerInstructions } from "./prompts/worker.js";
import {
  ResearchFailure,
  addUsage,
  type Delegation,
  type ObservedToolCall,
  type SupervisorRound,
  type SupervisorVerdict,
  type WorkerBudgets,
  type WorkerOutcomeSummary,
  type WorkerResult,
  type WorkerSink,
  type WorkerTask,
} from "./types.js";

/** How the loop ended: research is written up (normally or as a salvage), or the run is aborted. */
export type LoopExit = { kind: "write"; reason: string; salvage: boolean } | { kind: "aborted"; reason: string };

/** Runs `fn` over `items` with at most `limit` in flight, preserving result order. */
export async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(lanes);
  return results;
}

function targetLanguage(ctx: RunContext): string {
  return ctx.state.targetLanguage ?? ctx.state.inputLanguage ?? DEFAULT_TARGET_LANGUAGE;
}

function lastRound(ctx: RunContext): SupervisorRound | null {
  const rounds = ctx.state.rounds;
  return rounds.length > 0 ? (rounds[rounds.length - 1] as SupervisorRound) : null;
}

/** The exits that are checked before a decision is asked for; they are attributed to the previous round. */
function preDecisionExit(ctx: RunContext): string | null {
  const { state, config } = ctx;
  if (state.rounds.length >= config.maxRounds) return `round cap reached (${config.maxRounds})`;
  const elapsed = ctx.elapsedMinutes();
  if (elapsed >= config.windowMaxMinutes + 1) return `research window elapsed (${elapsed.toFixed(1)} of ${config.windowMaxMinutes} min)`;
  if (config.tokenSoftCap !== null && state.usage.totalTokens >= config.tokenSoftCap) {
    return `token soft cap passed (${state.usage.totalTokens} of ${config.tokenSoftCap})`;
  }
  return null;
}

/**
 * One supervisor decision, two attempts as upstream. A fatal failure (auth, quota, cancellation) propagates and
 * ends the run. Anything else gets the second attempt: a transport failure because a control turn that answered
 * nothing once may answer next time, and an answer without a usable decision with a nudge that names what was
 * wrong. When both attempts fail, the outcome carries the last reason so the run's failure text says what the
 * supervisor actually did instead of a bare "decision failed"; the loop decides what to do about it.
 */
type DecisionOutcome = { ok: true; decision: ParsedDecision } | { ok: false; reason: string };

async function decide(ctx: RunContext, round: number, notice: string | null): Promise<DecisionOutcome> {
  const { state, config } = ctx;
  const prompt = buildSupervisorPrompt({
    question: state.question,
    brief: state.brief ?? state.question,
    draft: state.draft,
    targetLanguage: targetLanguage(ctx),
    notes: state.notes,
    rounds: state.rounds,
    round,
    maxRounds: config.maxRounds,
    maxParallel: config.maxParallel,
    windowMinMinutes: config.windowMinMinutes,
    windowMaxMinutes: config.windowMaxMinutes,
    elapsedMinutes: ctx.elapsedMinutes(),
    nowMs: ctx.now(),
    notice,
  });
  let lastReason = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let text: string;
    try {
      text = await ctx.complete("supervisor", attempt === 1 ? prompt : `${prompt}\n\n${SUPERVISOR_RETRY_NUDGE}\n(${lastReason})`);
    } catch (error) {
      // One more try for anything short of fatal: a transport that answered nothing once may answer next time.
      if (error instanceof ResearchFailure && !error.fatal) {
        lastReason = `${error.kind}: ${error.message}`;
        ctx.log(`supervisor decision attempt ${attempt} failed (${lastReason})`);
        continue;
      }
      throw error;
    }
    const parsed = parseDecision(text, config.maxParallel * 2);
    if (parsed.ok) return { ok: true, decision: parsed.value };
    lastReason = parsed.reason;
    ctx.log(`supervisor decision attempt ${attempt} rejected (${lastReason}); answer began: ${JSON.stringify(text.slice(0, 160))}`);
  }
  return { ok: false, reason: lastReason || "no answer" };
}

/**
 * What to research when the supervisor cannot say: three tasks cut from the brief, one broad and two focused, so a
 * run whose first decision came back as prose still gathers something for the supervisor to reason about next
 * round. Only used before any findings exist; later a failed decision ends research the way upstream's does.
 */
export function fallbackDelegations(brief: string, maxParallel: number): ParsedDelegation[] {
  const topic = brief.replace(/\s+/g, " ").trim().slice(0, 400);
  const tasks: ParsedDelegation[] = [
    { topic: `Map the landscape of: ${topic}`, discovery: true, maxReads: null },
    { topic: `Primary sources, key facts and figures on: ${topic}`, discovery: false, maxReads: null },
    { topic: `The most recent developments, debates and open questions on: ${topic}`, discovery: false, maxReads: null },
  ];
  return tasks.slice(0, Math.max(1, Math.min(tasks.length, maxParallel)));
}

function budgetsFor(ctx: RunContext, delegation: Delegation): WorkerBudgets {
  const config = ctx.config;
  const maxReads =
    delegation.maxReads !== null
      ? Math.min(RESEARCH_LIMITS.workerReads.max, Math.max(RESEARCH_LIMITS.workerReads.min, Math.round(delegation.maxReads)))
      : config.workerMaxReads;
  return {
    maxToolCalls: config.workerMaxToolCalls,
    maxSearches: config.workerMaxSearches,
    maxReads,
    maxSaves: config.workerMaxSaves,
    wallTimeMs: config.workerWallTimeMinutes * 60_000,
  };
}

function failureNote(delegation: Delegation, error: string): string {
  return `Worker A${delegation.agentId} on ${delegation.topic} failed: ${error}`;
}

/** Folds one finished worker into the run: notes, codes, registry, curated sources and usage. */
function mergeResult(ctx: RunContext, round: SupervisorRound, delegation: Delegation, result: WorkerResult): { verified: number } {
  const { state } = ctx;
  state.usage = addUsage(state.usage, result.usage);
  const entries = assignCodes(delegation.agentId, result.saved ?? [], result.observed ?? [], round.round);
  const known = new Map(state.registry.map((entry) => [normalizeUrl(entry.url), entry]));
  const lines: string[] = [];
  let verified = 0;
  for (const entry of entries) {
    const key = normalizeUrl(entry.url);
    // Two workers reading the same page share one code, as upstream's identifier map does.
    const existing = known.get(key);
    const effective = existing ?? entry;
    if (!existing) {
      state.registry.push(entry);
      known.set(key, entry);
    } else if (entry.verified && !existing.verified) {
      existing.verified = true;
    }
    const saved = (result.saved ?? []).find((s) => typeof s.url === "string" && normalizeUrl(s.url) === key);
    state.curated.push({
      url: entry.url,
      title: entry.title,
      reason: saved?.reason ?? "",
      excerpt: saved?.excerpt ?? null,
      agentId: delegation.agentId,
      round: round.round,
      verified: effective.verified,
    });
    if (effective.verified) verified += 1;
    const title = entry.title?.trim() || "Untitled";
    const mark = effective.verified ? "verified" : "UNVERIFIED (never fetched or found in a search; cannot be cited)";
    lines.push(`[${effective.code}] ${title} (${entry.url}) - ${mark}${saved?.reason ? ` - ${saved.reason}` : ""}`);
  }
  const findings = (result.findings ?? "").trim();
  const kind = delegation.discovery ? "discovery" : "research";
  const header = `## Worker A${delegation.agentId} (round ${round.round}, ${kind}): ${delegation.topic}`;
  const body = findings || "(the worker completed without written findings)";
  const sources = lines.length > 0 ? `\n\nSources saved by this worker:\n${lines.join("\n")}` : "";
  // Capped when written: every later supervisor and writer prompt carries every note (see `notes.ts`).
  state.notes.push(capNote(header, body, sources));
  return { verified };
}

async function runWorker(ctx: RunContext, round: SupervisorRound, delegation: Delegation): Promise<WorkerOutcomeSummary> {
  const { state, deps, signal } = ctx;
  const startedAt = ctx.nowIso();
  const options = { round: round.round, agentId: delegation.agentId };
  if (signal.aborted) {
    // The run was stopped while this worker waited for a lane; it never starts.
    return {
      agentId: delegation.agentId,
      status: "cancelled",
      findingsChars: 0,
      savedCount: 0,
      verifiedCount: 0,
      observedCount: 0,
      usage: null,
      error: "cancelled before start",
      startedAt,
      endedAt: startedAt,
    };
  }
  const budgets = budgetsFor(ctx, delegation);
  const task: WorkerTask = {
    runId: state.runId,
    round: round.round,
    agentId: delegation.agentId,
    topic: delegation.topic,
    discovery: delegation.discovery,
    maxReads: delegation.maxReads,
    instructions: "",
  };
  task.instructions = buildWorkerInstructions(task, budgets, { nowMs: ctx.now(), targetLanguage: targetLanguage(ctx) });
  const { agentId, topic, discovery } = delegation;
  ctx.emit("delegation_started", { agentId, topic, discovery, maxReads: budgets.maxReads }, options);
  ctx.emit("subagent_started", { agentId, topic, discovery }, options);

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const sink: WorkerSink = {
    onToolCall: (call: ObservedToolCall) => {
      ctx.emit("worker_tool_call", { tool: call.tool, kind: call.kind }, options);
      if (call.kind === "search") ctx.emit("source_found", { count: (call.results ?? []).length }, options);
      else if (call.kind === "fetch") ctx.emit("source_read", { count: (call.urls ?? []).length }, options);
    },
    onProgress: () => {},
  };
  let result: WorkerResult;
  try {
    result = await deps.worker.run(task, budgets, controller.signal, sink);
  } catch (error) {
    // The runner promises never to reject; if it does anyway the worker counts as failed, not the run.
    const message = error instanceof Error ? error.message : String(error);
    result = { status: "failed", findings: "", saved: [], observed: [], usage: null, error: message };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const endedAt = ctx.nowIso();
  const summary: WorkerOutcomeSummary = {
    agentId: delegation.agentId,
    status: result.status,
    findingsChars: (result.findings ?? "").length,
    savedCount: (result.saved ?? []).length,
    verifiedCount: 0,
    observedCount: (result.observed ?? []).length,
    usage: result.usage ?? null,
    error: result.error ?? null,
    startedAt,
    endedAt,
  };
  if (result.status === "completed") {
    summary.verifiedCount = mergeResult(ctx, round, delegation, result).verified;
    ctx.emit("source_saved", { count: summary.savedCount, verified: summary.verifiedCount }, options);
    ctx.emit(
      "subagent_completed",
      {
        agentId: delegation.agentId,
        findingsChars: summary.findingsChars,
        saved: summary.savedCount,
        verified: summary.verifiedCount,
        observed: summary.observedCount,
      },
      options,
    );
  } else {
    state.usage = addUsage(state.usage, result.usage);
    const error = result.error?.trim() || result.status;
    summary.error = error;
    state.notes.push(capText(failureNote(delegation, error)));
    ctx.emit("subagent_failed", { agentId: delegation.agentId, status: result.status, error }, options);
  }
  return summary;
}

function toDelegations(ctx: RunContext, parsed: ParsedDelegation[]): Delegation[] {
  return parsed.map((d) => ({ agentId: ctx.state.nextAgentId++, topic: d.topic, discovery: d.discovery, maxReads: d.maxReads }));
}

function endRound(ctx: RunContext, round: SupervisorRound, exit: string | null): void {
  round.endedAt = ctx.nowIso();
  round.exit = exit;
}

/** Runs supervisor rounds until an exit rule fires. Throws `RunCancelled` or a fatal `ResearchFailure`. */
export async function runSupervisorLoop(ctx: RunContext): Promise<LoopExit> {
  const { state, config } = ctx;
  let notice: string | null = null;

  while (true) {
    ctx.checkCancelled();
    const pre = preDecisionExit(ctx);
    if (pre) {
      const previous = lastRound(ctx);
      if (previous && previous.exit === null) previous.exit = pre;
      ctx.log(`research ends: ${pre}`);
      return { kind: "write", reason: pre, salvage: false };
    }

    const roundNumber = state.rounds.length + 1;
    const previous = lastRound(ctx);
    const retrying = state.consecutiveFailures === 1 && previous !== null && previous.delegations.length > 0;
    let reflection: string;
    let verdict: SupervisorVerdict;
    let delegations: Delegation[];
    // A note for the next decision that must outlive this round's own reset of `notice`.
    let carriedNotice: string | null = null;
    if (retrying && previous) {
      // Upstream re-does the iteration after its first all-failed round; the same topics run under new agent ids.
      reflection = `Retrying round ${previous.round}'s delegations after every worker failed.`;
      verdict = "CONTINUE_RESEARCH";
      delegations = toDelegations(ctx, previous.delegations.map((d) => ({ topic: d.topic, discovery: d.discovery, maxReads: d.maxReads })));
    } else {
      const decided = await decide(ctx, roundNumber, notice);
      if (!decided.ok) {
        // Upstream ends research gracefully when the supervisor fails twice; writing from nothing is not graceful.
        // Only real findings count: failure notes and unverified sources are notes too, but not evidence.
        const reason = `supervisor decision failed (${decided.reason})`;
        if (hasFindings(state)) {
          if (previous && previous.exit === null) previous.exit = reason;
          return { kind: "write", reason, salvage: true };
        }
        if (state.rounds.length === 0) {
          // Nothing gathered yet and no decision to gather with: research the brief along three default lines rather
          // than end with nothing, and tell the supervisor next round what happened.
          ctx.log(`${reason}; delegating along default lines instead`);
          reflection = `The supervisor gave no usable decision (${decided.reason}); researching the brief along default lines.`;
          verdict = "CONTINUE_RESEARCH";
          delegations = toDelegations(ctx, fallbackDelegations(state.brief ?? state.question, config.maxParallel));
          carriedNotice = "NOTE: your previous answer was not a valid decision, so the first round researched the brief along default lines. Answer with the fenced JSON decision this time.";
        } else {
          state.aborted = true;
          state.abortReason = `${reason} with no findings to write from`;
          return { kind: "aborted", reason: state.abortReason };
        }
      } else {
        reflection = decided.decision.reflection;
        verdict = decided.decision.verdict;
        delegations = toDelegations(ctx, decided.decision.delegations);
      }
    }

    const round: SupervisorRound = {
      round: roundNumber,
      startedAt: ctx.nowIso(),
      endedAt: null,
      reflection,
      verdict,
      delegations,
      results: [],
      exit: null,
    };
    state.rounds.push(round);
    const elapsed = ctx.elapsedMinutes();
    ctx.emit(
      "supervisor_iteration",
      {
        iteration: roundNumber,
        maxIterations: config.maxRounds,
        verdict,
        delegations: delegations.length,
        discoveryDelegations: delegations.filter((d) => d.discovery).length,
        retry: retrying,
        elapsedMinutes: Math.round(elapsed * 100) / 100,
        remainingMinutes: Math.round(Math.max(0, config.windowMaxMinutes - elapsed) * 100) / 100,
      },
      { round: roundNumber },
    );
    notice = carriedNotice;

    if (delegations.length === 0) {
      const previousEmpty = previous !== null && previous.delegations.length === 0;
      if (verdict === "RESEARCH_COMPLETE" && (elapsed >= config.windowMinMinutes || previousEmpty)) {
        endRound(ctx, round, "research complete");
        await ctx.checkpoint();
        return { kind: "write", reason: "research complete", salvage: false };
      }
      if (previousEmpty) {
        // Two idle rounds in a row: upstream exits on a decision without tool calls, and so do we.
        endRound(ctx, round, "no delegations in two consecutive rounds");
        await ctx.checkpoint();
        return { kind: "write", reason: "no delegations in two consecutive rounds", salvage: false };
      }
      notice =
        verdict === "RESEARCH_COMPLETE"
          ? `Your previous decision set RESEARCH_COMPLETE after ${elapsed.toFixed(1)} minutes, before the minimum of ` +
            `${config.windowMinMinutes} minutes. Delegate at least one more research topic; set RESEARCH_COMPLETE again ` +
            "with no delegations only if nothing is left to research."
          : "Your previous decision delegated nothing while saying CONTINUE_RESEARCH. Delegate at least one topic, " +
            "or set RESEARCH_COMPLETE.";
      endRound(ctx, round, null);
      await ctx.checkpoint();
      continue;
    }

    if (verdict === "RESEARCH_COMPLETE") {
      // Upstream's denoise: research calls in the same decision win over ResearchComplete.
      ctx.log(`round ${roundNumber}: RESEARCH_COMPLETE ignored because ${delegations.length} delegation(s) were listed`);
    }
    await ctx.checkpoint();

    round.results = await mapWithLimit(delegations, config.maxParallel, (delegation) => runWorker(ctx, round, delegation));
    if (ctx.signal.aborted) {
      endRound(ctx, round, "cancelled");
      await ctx.checkpoint();
      throw new RunCancelled();
    }

    const completed = round.results.filter((r) => r.status === "completed").length;
    if (completed === 0) {
      const errors = round.results.map((r) => r.error ?? "").filter(Boolean);
      const sample = errors[0] ?? "unknown error";
      if (errors.some((e) => /^(quota|rate_limited)/i.test(e))) {
        state.aborted = true;
        state.abortReason = `All ${round.results.length} workers failed with quota or rate-limit errors: ${sample}`;
        endRound(ctx, round, "circuit breaker");
        await ctx.checkpoint();
        return { kind: "aborted", reason: state.abortReason };
      }
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= 2) {
        if (shouldSalvage(ctx)) {
          const reason = `research stalled after ${state.consecutiveFailures} consecutive failed rounds; writing from what exists`;
          endRound(ctx, round, reason);
          await ctx.checkpoint();
          return { kind: "write", reason, salvage: true };
        }
        state.aborted = true;
        state.abortReason =
          `Research stalled after ${state.consecutiveFailures} consecutive failed rounds with insufficient findings: ${sample}`;
        endRound(ctx, round, "stalled");
        await ctx.checkpoint();
        return { kind: "aborted", reason: state.abortReason };
      }
      ctx.log(`round ${roundNumber}: every worker failed; retrying its delegations once`);
    } else {
      state.consecutiveFailures = 0;
    }
    endRound(ctx, round, null);
    await ctx.checkpoint();
  }
}
