import { createElement } from "react";
import type { AgentVM } from "../../model/crew.js";
import { cn } from "../ui/primitives.js";

export function AgentName(props: { readonly agent: Pick<AgentVM, "name" | "display">; readonly className?: string }) {
  const { display, name } = props.agent;
  const prefixNode = display.prefix ? createElement("span", { className: "pre" }, display.prefix) : null;
  return createElement("span", { title: name, className: cn("crew-nm", props.className) }, prefixNode, display.short);
}
