import type { AgentVM } from "../../model/crew.js";
import { cn } from "../ui/primitives.js";

/** An agent's name with its phase prefix set apart: `judge:` in the subtle colour, `perf` in the row's. */
export function AgentName(props: { agent: Pick<AgentVM, "name" | "display">; className?: string }) {
  const { prefix, short } = props.agent.display;
  return (
    <span className={cn("crew-nm", props.className)} title={props.agent.name}>
      {prefix ? <span className="pre">{prefix}</span> : null}
      {short}
    </span>
  );
}
