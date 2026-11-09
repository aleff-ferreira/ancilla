import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "../../ui/primitives.js";

/** Small pieces the character's editors share: a labelled field, a choice made of cards, and a row of tabs. */

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="py-3">
      <p className="text-sm font-medium text-fg">{props.label}</p>
      {props.hint ? <p className="mt-0.5 text-xs text-muted">{props.hint}</p> : null}
      <div className="mt-2">{props.children}</div>
    </div>
  );
}

/** A choice made of cards: one is chosen, and the chosen one shows it. */
export function Card(props: { chosen: boolean; onClick: () => void; label: string; children: ReactNode; className?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={props.chosen}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "group relative flex min-w-0 flex-col items-center gap-2 rounded-xl p-3 text-center transition-[background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
        props.chosen ? "bg-accent-soft shadow-[0_0_0_1.5px_var(--accent)]" : "bg-sunken shadow-[0_0_0_1px_var(--border)] hover:bg-hover",
        props.className,
      )}
    >
      {props.children}
    </button>
  );
}

/**
 * A row of tabs: what the page shows under it changes with the one chosen. It works from the keyboard the way tabs do:
 * Tab lands on the chosen one, the arrow keys move to the next or the last, Home and End go to the ends.
 */
export function Tabs<T extends string>(props: { value: T; onChange: (value: T) => void; options: readonly { value: T; label: string; hint?: string }[]; label: string; className?: string }) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = props.options.findIndex((o) => o.value === props.value);
    const last = props.options.length - 1;
    const to = event.key === "ArrowRight" ? (at + 1) % props.options.length : event.key === "ArrowLeft" ? (at - 1 + props.options.length) % props.options.length : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
    if (to < 0) return;
    event.preventDefault();
    const next = props.options[to];
    if (!next) return;
    props.onChange(next.value);
    // Focus follows the choice, once the new tab has been drawn as the chosen one.
    const tabs = event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]');
    tabs[to]?.focus();
  };
  return (
    <div role="tablist" aria-label={props.label} onKeyDown={move} className={cn("flex flex-wrap gap-1 rounded-xl bg-sunken p-1 shadow-[0_0_0_1px_var(--border)]", props.className)}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={props.value === o.value}
          tabIndex={props.value === o.value ? 0 : -1}
          title={o.hint}
          onClick={() => props.onChange(o.value)}
          className={cn(
            "h-8 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus",
            props.value === o.value ? "bg-raised text-fg shadow-btn" : "text-muted hover:bg-hover hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A smaller choice, as pills. */
export function Pills<T extends string | number>(props: { value: T; onChange: (value: T) => void; options: readonly { value: T; label: string }[]; label: string; className?: string }) {
  return (
    <div role="group" aria-label={props.label} className={cn("flex flex-wrap gap-1.5", props.className)}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={props.value === o.value}
          onClick={() => props.onChange(o.value)}
          className={cn(
            "h-8 rounded-lg px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus",
            props.value === o.value ? "bg-accent-soft text-accent-text shadow-[0_0_0_1.5px_var(--accent)]" : "bg-sunken text-muted shadow-[0_0_0_1px_var(--border)] hover:bg-hover hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
