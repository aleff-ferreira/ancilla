/**
 * The research run: scope, optionally draft, research in supervisor rounds, write, done.
 *
 * Port of the phase sequence of Deep Dog 2 `deep_research/integration.py` L331-402 (`run_research`),
 * `research_agent_scope.py` L78-185 (brief and draft) and `multi_agent_supervisor.py` L869-1023
 * (`write_final_report`) at commit `fc7981a`. Every model call goes through `deps.model`, every delegated task
 * through `deps.worker`, every instant through `deps.now()`. The engine emits `run_started` through
 * `run_resumed`; `run_interrupted` belongs to the host, which is the only party that can see a process die.
 */

import type { ResearchConfig } from "./config.js";
import { buildFinalRegistry, finalizeCitations } from "./citations.js";
import { RunCancelled, RunContext, hasFindings } from "./context.js";
import { parseBrief } from "./parse.js";
import { BRIEF_RETRY_NUDGE, buildBriefPrompt } from "./prompts/brief.js";
import { DEFAULT_TARGET_LANGUAGE } from "./prompts/common.js";
import { buildDraftPrompt } from "./prompts/draft.js";
import { WRITER_RETRY_NUDGE, buildWriterPrompt } from "./prompts/writer.js";
import { runSupervisorLoop, type LoopExit } from "./supervisor.js";
import {
  ResearchFailure,
  ZERO_USAGE,
  type ResearchDeps,
  type ResearchInput,
  type ResearchOutcome,
  type ResearchPhase,
  type ResearchRunState,
} from "./types.js";

/** Refusal signatures for the short-output writer check (upstream `config.looks_like_refusal`, English markers). */
const REFUSAL_MARKERS = [
  "rejected because",
  "considered high risk",
  "content filter",
  "content policy",
  "cannot",
  "i can't",
  "unable to",
  "refuse",
];

/** Lenient check: very short output that reads like a content-filter refusal. */
export function looksLikeRefusal(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 200) return false;
  const lowered = trimmed.toLowerCase().replace(/’/g, "'");
  return REFUSAL_MARKERS.some((marker) => lowered.includes(marker));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A fresh state for a new run; every field is JSON so it can be checkpointed as is. */
export function createRunState(input: ResearchInput, config: ResearchConfig, nowMs: number): ResearchRunState {
  return {
    version: 1,
    runId: input.runId,
    question: input.question,
    config,
    phase: "scoping",
    brief: null,
    inputLanguage: null,
    targetLanguage: null,
    draft: null,
    rounds: [],
    registry: [],
    curated: [],
    notes: [],
    consecutiveFailures: 0,
    aborted: false,
    abortReason: null,
    usage: { ...ZERO_USAGE },
    startedAt: iso(nowMs),
    researchDeadlineAt: iso(nowMs + config.windowMaxMinutes * 60_000),
    nextAgentId: 1,
    eventSeq: 0,
  };
}

/** A resumable copy of a checkpointed state: unfinished last round dropped, missing fields defaulted. */
function restoreState(saved: ResearchRunState): ResearchRunState {
  const state: ResearchRunState = JSON.parse(JSON.stringify(saved));
  state.eventSeq = typeof state.eventSeq === "number" ? state.eventSeq : 0;
  state.usage = state.usage ?? { ...ZERO_USAGE };
  state.notes = state.notes ?? [];
  state.registry = state.registry ?? [];
  state.curated = state.curated ?? [];
  state.rounds = state.rounds ?? [];
  const last = state.rounds[state.rounds.length - 1];
  if (last && last.endedAt === null) state.rounds.pop();
  if (state.phase === "done") state.phase = "writing";
  return state;
}

async function setPhase(ctx: RunContext, phase: ResearchPhase): Promise<void> {
  ctx.state.phase = phase;
  await ctx.checkpoint();
}

async function scope(ctx: RunContext): Promise<void> {
  const { state } = ctx;
  ctx.emit("scope_started", {});
  const prompt = buildBriefPrompt({ question: state.question, nowMs: ctx.now() });
  let brief: { researchBrief: string; inputLanguage: string | null; targetLanguage: string | null } | null = null;
  try {
    const first = parseBrief(await ctx.complete("brief", prompt));
    if (first.ok) {
      brief = first.value;
    } else {
      ctx.log(`brief rejected (${first.reason}); retrying with a nudge`);
      const second = parseBrief(await ctx.complete("brief", `${prompt}\n\n${BRIEF_RETRY_NUDGE}`));
      if (second.ok) brief = second.value;
      else ctx.log(`brief rejected again (${second.reason}); using the question as the brief`);
    }
  } catch (error) {
    // One attempt for transport trouble: anything short of fatal falls back to the question itself.
    if (error instanceof RunCancelled || (error instanceof ResearchFailure && error.fatal)) throw error;
    ctx.log(`brief call failed (${error instanceof Error ? error.message : String(error)}); using the question as the brief`);
  }
  state.brief = brief?.researchBrief ?? state.question;
  state.inputLanguage = brief?.inputLanguage ?? null;
  state.targetLanguage = brief?.targetLanguage ?? brief?.inputLanguage ?? DEFAULT_TARGET_LANGUAGE;
  ctx.emit("scope_completed", {
    briefChars: state.brief.length,
    inputLanguage: state.inputLanguage,
    targetLanguage: state.targetLanguage,
    fallback: brief === null,
  });
}

async function draft(ctx: RunContext): Promise<void> {
  const { state } = ctx;
  ctx.emit("draft_started", {});
  try {
    const prompt = buildDraftPrompt({
      brief: state.brief ?? state.question,
      targetLanguage: state.targetLanguage ?? DEFAULT_TARGET_LANGUAGE,
      nowMs: ctx.now(),
    });
    const text = await ctx.complete("draft", prompt);
    state.draft = text.trim() || null;
  } catch (error) {
    // The draft is a scaffold, never evidence; research goes on without it unless the failure is fatal.
    if (error instanceof RunCancelled || (error instanceof ResearchFailure && error.fatal)) throw error;
    ctx.log(`draft call failed (${error instanceof Error ? error.message : String(error)}); continuing without a draft`);
    state.draft = null;
  }
  ctx.emit("draft_completed", { chars: state.draft?.length ?? 0, fallback: state.draft === null });
}

type WriteResult = { ok: true; report: string } | { ok: false; error: string };

/**
 * Two attempts with upstream's rejection rules, then the deterministic citation pass. A rejected answer gets the
 * second attempt with a nudge and so does a transport failure worth retrying; a failure that would not change on
 * a second call (an `invalid_output`, say) ends the attempts at once.
 */
async function write(ctx: RunContext, salvage: boolean): Promise<WriteResult> {
  const { state } = ctx;
  const registry = buildFinalRegistry(state.registry, state.curated);
  ctx.emit("report_started", { sources: registry.length, salvage });
  const lastReflection = [...state.rounds].reverse().find((round) => round.reflection.trim())?.reflection ?? null;
  const prompt = buildWriterPrompt({
    question: state.question,
    brief: state.brief ?? state.question,
    draft: state.draft,
    notes: state.notes,
    lastReflection,
    registry,
    targetLanguage: state.targetLanguage ?? DEFAULT_TARGET_LANGUAGE,
    nowMs: ctx.now(),
    salvage,
  });
  const draftText = (state.draft ?? "").trim();
  const invalidReason = (text: string): string | null => {
    if (!text.trim()) return "empty report";
    if (draftText && text.trim() === draftText) return "report is identical to the initial draft";
    if (looksLikeRefusal(text)) return "content-filter refusal";
    return null;
  };
  let lastReason = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let text: string;
    try {
      text = await ctx.complete("writer", attempt === 1 ? prompt : `${prompt}\n\n${WRITER_RETRY_NUDGE}`);
    } catch (error) {
      if (error instanceof ResearchFailure && error.retryable) {
        lastReason = `${error.kind}: ${error.message}`;
        ctx.log(`writer attempt ${attempt} failed (${lastReason})`);
        continue;
      }
      if (error instanceof ResearchFailure) return { ok: false, error: `Final report generation failed: ${error.kind}: ${error.message}` };
      throw error;
    }
    let reason = invalidReason(text);
    if (reason === null) {
      const finalized = finalizeCitations(text, registry);
      reason = invalidReason(finalized.report);
      if (reason === null) {
        ctx.emit("citations_validated", {
          cited: finalized.cited.length,
          unknown: finalized.unknownCodes.length,
          sources: registry.length,
          reportChars: finalized.report.length,
          attempt,
        });
        return { ok: true, report: finalized.report };
      }
      reason = `after citation cleanup: ${reason}`;
    }
    lastReason = reason;
    ctx.log(`writer attempt ${attempt} rejected (${reason})`);
  }
  return { ok: false, error: `Final report generation failed after two attempts: ${lastReason}` };
}

function whatExists(state: ResearchRunState): string {
  const notes = state.rounds.reduce((n, round) => n + round.results.filter((r) => r.status === "completed").length, 0);
  const verified = state.registry.filter((entry) => entry.verified).length;
  return `Collected: ${state.draft ? "a draft" : "no draft"}, ${notes} worker note(s), ${verified} verified source(s).`;
}

async function finish(ctx: RunContext, outcome: ResearchOutcome): Promise<ResearchOutcome> {
  ctx.state.phase = "done";
  await ctx.checkpoint();
  const elapsedMinutes = Math.round(ctx.elapsedMinutes() * 100) / 100;
  const rounds = ctx.state.rounds.length;
  if (outcome.status === "completed" || outcome.status === "partial") {
    const reportChars = outcome.report?.length ?? 0;
    ctx.emit("run_completed", { status: outcome.status, reportChars, failure: outcome.failure, elapsedMinutes, rounds });
  } else if (outcome.status === "failed") {
    ctx.emit("run_failed", { reason: outcome.failure, elapsedMinutes, rounds });
  }
  return outcome;
}

/** Writes after the loop ended and turns the result into an outcome. */
async function writeAndFinish(ctx: RunContext, salvage: boolean, why: string | null): Promise<ResearchOutcome> {
  const { state } = ctx;
  const written = await write(ctx, salvage);
  if (written.ok) {
    return finish(ctx, { status: salvage ? "partial" : "completed", report: written.report, state, failure: salvage ? why : null });
  }
  if (state.draft || hasFindings(state)) {
    return finish(ctx, { status: "partial", report: null, state, failure: `${written.error} ${whatExists(state)}` });
  }
  return finish(ctx, { status: "failed", report: null, state, failure: written.error });
}

async function cancel(ctx: RunContext): Promise<ResearchOutcome> {
  const { state, input } = ctx;
  const elapsedMinutes = Math.round(ctx.elapsedMinutes() * 100) / 100;
  // A user who stops and asks for a report gets one whenever anything was found: the time fraction that gates
  // an automatic salvage (upstream's rule for an aborted loop) does not apply to an explicit request.
  const salvage = input.stopWritesReport === true && hasFindings(state);
  const reason = salvage ? "cancelled; writing a salvage report" : "cancelled";
  ctx.emit("run_cancelled", { reason, elapsedMinutes, rounds: state.rounds.length });
  if (!salvage) {
    state.phase = "done";
    await ctx.checkpoint();
    return { status: "cancelled", report: null, state, failure: "cancelled" };
  }
  // The run's signal has fired, so the salvage write gets its own; the writer timeout bounds it, and the host's
  // `hardStop` (a second stop, or a shutdown) ends it early when one is given.
  const salvageSignal = new AbortController().signal;
  ctx.writeSignal = ctx.deps.hardStop ? AbortSignal.any([ctx.deps.hardStop, salvageSignal]) : salvageSignal;
  state.phase = "writing";
  await ctx.checkpoint();
  try {
    return await writeAndFinish(ctx, true, "cancelled; report written from the findings collected so far");
  } catch (error) {
    if (error instanceof RunCancelled) {
      // A dependency refused the salvage write as cancelled; there is nothing left to try.
      return finish(ctx, { status: "cancelled", report: null, state, failure: "cancelled" });
    }
    if (error instanceof ResearchFailure) {
      const failure = `cancelled; salvage report failed: ${error.message}. ${whatExists(state)}`;
      return finish(ctx, { status: "partial", report: null, state, failure });
    }
    throw error;
  }
}

/**
 * Runs one research job from question to cited report. Resolves with an outcome in every case but a thrown
 * programming error: cancellation, budget exhaustion and model trouble all come back as a status.
 * `resumeFrom` continues a checkpointed run at the start of its next supervisor round; its own config and question
 * are used, and `config` is ignored. A checkpoint whose last round has `endedAt: null` loses that round.
 */
export async function runResearch(
  input: ResearchInput,
  config: ResearchConfig,
  deps: ResearchDeps,
  signal: AbortSignal,
  resumeFrom?: ResearchRunState,
): Promise<ResearchOutcome> {
  const state = resumeFrom ? restoreState(resumeFrom) : createRunState(input, config, deps.now());
  const ctx = new RunContext(state, deps, input, signal);
  try {
    if (resumeFrom) {
      const droppedRound = resumeFrom.rounds.length !== state.rounds.length;
      ctx.emit("run_resumed", { phase: state.phase, rounds: state.rounds.length, droppedRound });
    } else {
      ctx.emit("run_started", {
        questionChars: state.question.length,
        windowMinMinutes: config.windowMinMinutes,
        windowMaxMinutes: config.windowMaxMinutes,
        maxRounds: config.maxRounds,
        maxParallel: config.maxParallel,
        draftFirst: config.draftFirst,
      });
      await ctx.checkpoint();
    }

    if (state.phase === "scoping") {
      ctx.checkCancelled();
      await scope(ctx);
      await setPhase(ctx, state.config.draftFirst ? "drafting" : "researching");
    }
    if (state.phase === "drafting") {
      ctx.checkCancelled();
      if (state.config.draftFirst) await draft(ctx);
      await setPhase(ctx, "researching");
    }

    let loopExit: LoopExit | null = null;
    if (state.phase === "researching") {
      ctx.checkCancelled();
      loopExit = await runSupervisorLoop(ctx);
      if (loopExit.kind === "aborted") {
        return await finish(ctx, { status: "failed", report: null, state, failure: loopExit.reason });
      }
      // Recorded before the phase checkpoint, so a run resumed at the writing phase still ends `partial` when
      // the loop ended in a salvage rather than a finished round.
      state.loopExit = { salvage: loopExit.salvage, reason: loopExit.reason };
      await setPhase(ctx, "writing");
    }

    ctx.checkCancelled();
    // A resumed run has no loop exit of its own and takes the one its checkpoint recorded.
    const exit = loopExit ?? state.loopExit ?? null;
    return await writeAndFinish(ctx, exit?.salvage ?? false, exit?.reason ?? null);
  } catch (error) {
    if (error instanceof RunCancelled) return cancel(ctx);
    if (error instanceof ResearchFailure) {
      return finish(ctx, { status: "failed", report: null, state, failure: `${error.kind}: ${error.message}` });
    }
    throw error;
  }
}
