import { formatClock, formatTokens } from "../../model/format.js";
import { durationText, usageTotal, type AgentVM, type RunVM } from "../../model/swarm.js";
import { Sigil } from "./Sigil.js";
import { StateGlyph } from "./StateGlyph.js";
import { stateSentence } from "./cardCopy.js";

export interface PeekProps {
  agent: AgentVM;
  run: RunVM | null;
  stale?: boolean;
}

/**
 * The peek: what the inspector would say about a row, beside it, opened with Space and closed with Space or Esc.
 * Non-modal, and it never takes focus; the row keeps it (SPEC §11).
 */
export function Peek({ agent, run, stale = false }: PeekProps) {
  const clock = run?.clockAt ?? Date.now();
  const facts: { k: string; v: string; nr?: boolean }[] = [];
  if (agent.startedAt !== null) {
    const into = run?.startedAt !== null && run?.startedAt !== undefined ? ` · ${durationText(agent.startedAt - run.startedAt)} in` : "";
    facts.push({ k: "Started", v: `${formatClock(agent.startedAt, clock)}${into}` });
  }
  if (agent.state === "done" || agent.state === "failed" || agent.state === "skipped") {
    facts.push({ k: "Ran", v: agent.durationMs !== null ? durationText(agent.durationMs) : "Not reported", nr: agent.durationMs === null });
  } else if (agent.runningMs !== null) {
    facts.push({ k: "Running", v: durationText(agent.runningMs) });
  }
  if (agent.attempt > 1) facts.push({ k: "Attempts", v: String(agent.attempt) });
  if (run?.longestFinishedMs !== null && run?.longestFinishedMs !== undefined && agent.kind === "workflow") {
    facts.push({ k: "Longest finished", v: durationText(run.longestFinishedMs) });
  }
  if (agent.kind === "workflow") {
    facts.push(agent.tokens ? { k: "Tokens", v: formatTokens(usageTotal(agent.tokens)) } : { k: "Tokens", v: agent.state === "done" ? "Not reported" : "reported near the end", nr: true });
    facts.push({ k: "Tool calls", v: agent.toolCalls !== null ? String(agent.toolCalls) : "At run end", nr: agent.toolCalls === null });
  }
  const sub = [agent.phase, agent.kind === "workflow" ? `attempt ${agent.attempt}` : null, stateSentence(agent, stale)].filter((part): part is string => part !== null).join(" · ");
  return (
    <div className="swarm-peek" role="dialog" aria-modal="false" aria-label={`${agent.name}: ${sub}`}>
      <div className="who">
        <Sigil name={agent.name} size={28} state={agent.state} stale={stale} still />
        <span className="nm">{agent.name}</span>
        <StateGlyph agent={agent} stale={stale} />
      </div>
      <div className="sub">{sub}</div>
      {agent.task ? <div className="task">{agent.task.text}</div> : <div className="task text-subtle">Muse did not share this agent's task.</div>}
      {facts.length > 0 ? (
        <dl>
          {facts.map((fact) => (
            <div key={fact.k} className="contents">
              <dt>{fact.k}</dt>
              <dd className={fact.nr ? "nr" : undefined}>{fact.v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="hint" aria-hidden="true">
        <span><kbd className="swarm-kbd">Enter</kbd> open</span>
        <span><kbd className="swarm-kbd">Esc</kbd> close</span>
      </div>
    </div>
  );
}
