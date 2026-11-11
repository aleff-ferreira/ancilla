import { summarize } from "./metrics.js";

/**
 * Quantitative evaluation summary for multi-turn spoken + typed assistant conversations.
 * Measures first-pass comprehension, intent preservation (conversation vs. read task vs. screen-gated write proposal),
 * response latency, interruption recovery, clarification discipline, and background task completion reliability.
 */

export interface ScenarioCheck {
  id: string;
  comprehended: boolean;
  intentPreserved: boolean;
  interruptionRecovered?: boolean;
  clarificationExpected?: boolean;
  clarificationAsked?: boolean;
  taskCompleted?: boolean;
}

export interface ConversationalEvalReport {
  scenarios: number;
  comprehensionAccuracy: number;
  intentPreservationRate: number;
  interruptionRecoveryRate: number;
  unnecessaryClarificationRate: number;
  appropriateClarificationRate: number;
  taskCompletionReliability: number;
  latency: {
    turns: number;
    endpointP50Ms: number | null;
    endpointP95Ms: number | null;
    firstAudioP50Ms: number | null;
    firstAudioP95Ms: number | null;
  };
}

function ratio(num: number, den: number): number {
  return den === 0 ? 1 : Number((num / den).toFixed(4));
}

export function evaluateConversationChecks(
  checks: readonly ScenarioCheck[],
  turnMetrics: ReadonlyArray<{ endpointMs: number | null; firstAudioMs: number | null }>,
): ConversationalEvalReport {
  const comprehended = checks.filter((c) => c.comprehended).length;
  const intentPreserved = checks.filter((c) => c.intentPreserved).length;

  const interruptions = checks.filter((c) => c.interruptionRecovered !== undefined);
  const interruptionRecovered = interruptions.filter((c) => c.interruptionRecovered === true).length;

  const unambiguous = checks.filter((c) => c.clarificationExpected === false);
  const unnecessaryClarifications = unambiguous.filter((c) => c.clarificationAsked === true).length;

  const genuinelyAmbiguous = checks.filter((c) => c.clarificationExpected === true);
  const appropriateClarifications = genuinelyAmbiguous.filter((c) => c.clarificationAsked === true).length;

  const tasks = checks.filter((c) => c.taskCompleted !== undefined);
  const completedTasks = tasks.filter((c) => c.taskCompleted === true).length;

  const endpoints = summarize(turnMetrics.map((m) => m.endpointMs).filter((x): x is number => x !== null));
  const firstAudio = summarize(turnMetrics.map((m) => m.firstAudioMs).filter((x): x is number => x !== null));

  return {
    scenarios: checks.length,
    comprehensionAccuracy: ratio(comprehended, checks.length),
    intentPreservationRate: ratio(intentPreserved, checks.length),
    interruptionRecoveryRate: ratio(interruptionRecovered, interruptions.length),
    unnecessaryClarificationRate: ratio(unnecessaryClarifications, unambiguous.length),
    appropriateClarificationRate: ratio(appropriateClarifications, genuinelyAmbiguous.length),
    taskCompletionReliability: ratio(completedTasks, tasks.length),
    latency: {
      turns: turnMetrics.length,
      endpointP50Ms: endpoints.p50,
      endpointP95Ms: endpoints.p95,
      firstAudioP50Ms: firstAudio.p50,
      firstAudioP95Ms: firstAudio.p95,
    },
  };
}
