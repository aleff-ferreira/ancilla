import { cn } from "../ui/primitives.js";

/** Ten minutes of events per minute as a 16 px sparkline; the current minute is the accent bar. Decorative: the KPI cell's text says the rate. */
export function Pulse(props: { bins: readonly number[]; className?: string }) {
  const max = Math.max(1, ...props.bins);
  return (
    <span aria-hidden="true" className={cn("inline-flex h-4 shrink-0 items-end gap-[2px]", props.className)}>
      {props.bins.map((value, index) => (
        <span
          key={index}
          className={cn("block w-1 rounded-[1px]", index === props.bins.length - 1 ? "bg-accent" : "bg-subtle opacity-40")}
          style={{ height: `${Math.max(2, Math.round((value / max) * 16))}px` }}
        />
      ))}
    </span>
  );
}
