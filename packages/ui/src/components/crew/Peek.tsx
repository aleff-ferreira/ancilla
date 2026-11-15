import { formatClock, formatTokens } from "../../model/format.js";
import { durationText, researchCounters, usageTotal, type AgentVM, type RunVM } from "../../model/crew.js";
import { Sigil } from "./Sigil.js";
import { StateGlyph } from "./StateGlyph.js";
import { stateSentence } from "./cardCopy.js";

export interface PeekProps {
  readonly agent: AgentVM;
  readonly run: RunVM | null;
  readonly stale?: boolean;
}

interface FactDetail {
  k: string;
  v: string;
  nr?: boolean;
}

function compileAgentMetrics(agent: AgentVM, run: RunVM | null, clockTime: number): FactDetail[] {
  const details: FactDetail[] = [];
  if (agent.startedAt !== null) {
    const parentStartTime = run?.startedAt;
    const elapsedSinceRunStart = parentStartTime !== null && parentStartTime !== undefined
      ? ` · ${durationText(agent.startedAt - parentStartTime)} in`
      : "";
    details.push({ k: "Started", v: `${formatClock(agent.startedAt, clockTime)}${elapsedSinceRunStart}` });
  }

  const isFinished = agent.state === "done" || agent.state === "failed" || agent.state === "skipped";
  if (isFinished) {
    const spanText = agent.durationMs !== null ? durationText(agent.durationMs) : "Not reported";
    details.push({ k: "Ran", v: spanText, nr: agent.durationMs === null });
  } else if (agent.runningMs !== null) {
    details.push({ k: "Running", v: durationText(agent.runningMs) });
  }

  if (agent.attempt > 1) {
    details.push({ k: "Attempts", v: String(agent.attempt) });
  }

  const hasLongest = run?.longestFinishedMs !== null && run?.longestFinishedMs !== undefined;
  if (hasLongest && agent.kind === "workflow") {
    details.push({ k: "Longest finished", v: durationText(run!.longestFinishedMs!) });
  }

  if (agent.kind === "workflow") {
    const tokenRecord = agent.tokens
      ? { k: "Tokens", v: formatTokens(usageTotal(agent.tokens)) }
      : { k: "Tokens", v: agent.state === "done" ? "Not reported" : "reported near the end", nr: true };
    details.push(tokenRecord);

    const callCountText = agent.toolCalls !== null ? String(agent.toolCalls) : "At run end";
    details.push({ k: "Tool calls", v: callCountText, nr: agent.toolCalls === null });
  }

  if (agent.research) {
    details.push({ k: "Calls", v: researchCounters(agent.research) });
    details.push({ k: "Tool calls", v: String(agent.toolCalls ?? 0) });
  }

  return details;
}

export function Peek({ agent, run, stale = false }: PeekProps) {
  const currentClock = run?.clockAt ?? Date.now();
  const collectedFacts = compileAgentMetrics(agent, run, currentClock);

  const attemptPhrase = agent.kind === "workflow" ? `attempt ${agent.attempt}` : null;
  const sentenceSummary = stateSentence(agent, stale);
  const descriptorParts = [agent.phase, attemptPhrase, sentenceSummary].filter((item): item is string => Boolean(item));
  const fullSubTitle = descriptorParts.join(" · ");

  const promptBlock = agent.task ? (
    <div className="task">{agent.task.text}</div>
  ) : (
    <div className="task text-subtle">Muse did not share this agent's task.</div>
  );

  return (
    <div className="crew-peek" role="dialog" aria-modal="false" aria-label={`${agent.name}: ${fullSubTitle}`}>
      <div className="who">
        <Sigil size={28} still stale={stale} state={agent.state} name={agent.name} />
        <span className="nm">{agent.name}</span>
        <StateGlyph stale={stale} agent={agent} />
      </div>
      <div className="sub">{fullSubTitle}</div>
      {promptBlock}
      {collectedFacts.length > 0 ? (
        <dl>
          {collectedFacts.map((row) => {
            const isUnreported = row.nr ? "nr" : undefined;
            return (
              <div key={row.k} className="contents">
                <dt>{row.k}</dt>
                <dd className={isUnreported}>{row.v}</dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      <div className="hint" aria-hidden="true">
        <span><kbd className="crew-kbd">Enter</kbd> open</span>
        <span><kbd className="crew-kbd">Esc</kbd> close</span>
      </div>
    </div>
  );
}
