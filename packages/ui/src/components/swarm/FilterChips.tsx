import { useState, type ReactNode, type RefObject } from "react";
import { CircleDashedIcon, MagnifyingGlassIcon, ShieldWarningIcon, WarningCircleIcon } from "../ui/icons.js";
import type { SwarmFilter } from "../../model/store.js";
import { Kbd, cn } from "../ui/primitives.js";
import { filterCount, filterLabel, visibleFilters, type ChipCounts } from "./panel.js";

export interface FilterChipsProps {
  counts: ChipCounts;
  filter: SwarmFilter;
  query: string;
  /** Under 560 px the chips wrap and the search folds to its icon until it is used. */
  narrow: boolean;
  onFilter(filter: SwarmFilter): void;
  onQuery(query: string): void;
  /** The search box, so `/` can focus it. */
  searchRef: RefObject<HTMLInputElement>;
}

const ICONS: Partial<Record<SwarmFilter, ReactNode>> = {
  needs: <ShieldWarningIcon size={12} />,
  failed: <WarningCircleIcon size={12} />,
  "no-update": <CircleDashedIcon size={12} />,
};

const TONES: Partial<Record<SwarmFilter, string>> = {
  needs: "text-warn-text",
  failed: "text-danger-text",
};

/** `All 10 · Needs you 1 · Failed 1 · No update 1 · Working 2 · Done 6` and the Find agent box. A chip with nothing behind it leaves. */
export function FilterChips(props: FilterChipsProps) {
  const [focused, setFocused] = useState(false);
  const open = !props.narrow || focused || props.query !== "";
  return (
    <div
      role="toolbar"
      aria-label="Filter agents"
      className={cn("flex items-center gap-1 px-4 py-1.5", props.narrow ? "flex-wrap gap-y-1" : "flex-nowrap overflow-hidden")}
    >
      {visibleFilters(props.counts).map((filter) => {
        const on = filter === props.filter;
        return (
          <button
            key={filter}
            type="button"
            aria-pressed={on}
            data-filter={filter}
            onClick={() => props.onFilter(filter)}
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors duration-100",
              on ? "bg-active text-fg" : cn("text-muted shadow-[inset_0_0_0_1px_var(--border)] hover:bg-hover", TONES[filter]),
            )}
          >
            {ICONS[filter]}
            {filterLabel(filter)}
            <span className={cn("tabular-nums", on ? "text-muted" : "text-subtle")}>{filterCount(props.counts, filter)}</span>
          </button>
        );
      })}
      <label
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md pr-1.5 pl-2 text-xs text-subtle shadow-[inset_0_0_0_1px_var(--border)] focus-within:shadow-[inset_0_0_0_1px_var(--accent)]",
          props.narrow ? "" : "ml-auto",
        )}
      >
        <MagnifyingGlassIcon size={12} className="shrink-0" />
        <input
          ref={props.searchRef}
          type="search"
          value={props.query}
          placeholder="Find agent"
          aria-label="Find agent"
          onChange={(event) => props.onQuery(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (props.query) props.onQuery("");
              else event.currentTarget.blur();
            } else if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          className={cn("min-w-0 bg-transparent text-xs text-fg outline-none placeholder:text-subtle", open ? "w-[88px]" : "w-0")}
        />
        <Kbd className="h-4 min-w-4 text-[10.5px]">/</Kbd>
      </label>
    </div>
  );
}
