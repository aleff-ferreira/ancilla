import { useState, type ReactNode, type RefObject } from "react";
import { CircleDashedIcon, MagnifyingGlassIcon, ShieldWarningIcon, WarningCircleIcon } from "../ui/icons.js";
import type { CrewFilter } from "../../model/store.js";
import { Kbd, cn } from "../ui/primitives.js";
import { filterCount, filterLabel, visibleFilters, type ChipCounts } from "./panel.js";

export interface FilterChipsProps {
  readonly counts: ChipCounts;
  readonly filter: CrewFilter;
  readonly query: string;
  readonly narrow: boolean;
  readonly searchRef: RefObject<HTMLInputElement>;
  onFilter(filter: CrewFilter): void;
  onQuery(query: string): void;
}

function renderFilterIcon(kind: CrewFilter): ReactNode {
  switch (kind) {
    case "needs": return <ShieldWarningIcon size={12} />;
    case "failed": return <WarningCircleIcon size={12} />;
    case "no-update": return <CircleDashedIcon size={12} />;
    default: return null;
  }
}

function resolveFilterColorStyle(kind: CrewFilter): string | undefined {
  if (kind === "needs") return "text-warn-text";
  if (kind === "failed") return "text-danger-text";
  return undefined;
}

function AgentSearchInput({
  query,
  searchRef,
  isNarrow,
  isSearchOpen,
  onQuery,
  onSearchFocus,
}: {
  readonly query: string;
  readonly searchRef: RefObject<HTMLInputElement>;
  readonly isNarrow: boolean;
  readonly isSearchOpen: boolean;
  onQuery(val: string): void;
  onSearchFocus(focused: boolean): void;
}) {
  const labelClasses = cn(
    "group inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-sunken pr-1.5 pl-2 text-xs text-subtle focus-within:shadow-[inset_0_0_0_1px_var(--focus-ring)]",
    isNarrow ? "" : "ml-auto"
  );

  return (
    <label className={labelClasses}>
      <MagnifyingGlassIcon className="shrink-0" size={12} />
      <input
        ref={searchRef}
        value={query}
        placeholder="Find agent"
        aria-label="Find agent"
        type="search"
        onFocus={() => onSearchFocus(true)}
        onBlur={() => onSearchFocus(false)}
        onChange={(evt) => onQuery(evt.target.value)}
        onKeyDown={(keyboardEvt) => {
          const pressedKey = keyboardEvt.key;
          if (pressedKey === "Escape") {
            keyboardEvt.preventDefault();
            keyboardEvt.stopPropagation();
            if (query) onQuery("");
            else keyboardEvt.currentTarget.blur();
          } else if (pressedKey === "Enter") {
            keyboardEvt.preventDefault();
            keyboardEvt.currentTarget.blur();
          }
        }}
        className={cn(
          "min-w-0 bg-transparent text-xs text-fg outline-none placeholder:text-subtle",
          isSearchOpen ? "w-[88px]" : "w-0"
        )}
      />
      <Kbd className="h-4 min-w-4 text-[10.5px] opacity-0 transition-opacity duration-100 group-focus-within:opacity-100 group-hover:opacity-100">
        /
      </Kbd>
    </label>
  );
}

export function FilterChips(props: FilterChipsProps) {
  const [searchFocused, setSearchFocused] = useState(false);
  const { counts, filter, query, narrow, onFilter, onQuery, searchRef } = props;
  const isSearchOpen = !narrow || searchFocused || query !== "";
  const containerAlignment = narrow ? "flex-wrap gap-y-1" : "flex-nowrap overflow-hidden";

  return (
    <div role="toolbar" aria-label="Filter agents" className={cn("flex items-center gap-1 px-4 py-1.5", containerAlignment)}>
      {visibleFilters(counts).map((category) => {
        const isCurrent = category === filter;
        const colorAccent = resolveFilterColorStyle(category);
        const inactiveVisuals = cn("text-muted hover:bg-hover", colorAccent);
        const buttonCls = cn(
          "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors duration-100",
          isCurrent ? "bg-active text-fg" : inactiveVisuals
        );
        const countVisuals = cn("tabular-nums", isCurrent ? "text-muted" : "text-subtle");
        const tallyNumber = filterCount(counts, category);

        return (
          <button
            key={category}
            type="button"
            aria-pressed={isCurrent}
            data-filter={category}
            onClick={() => onFilter(category)}
            className={buttonCls}
          >
            {renderFilterIcon(category)}
            {filterLabel(category)}
            <span className={countVisuals}>{tallyNumber}</span>
          </button>
        );
      })}
      <AgentSearchInput
        query={query}
        searchRef={searchRef}
        isNarrow={narrow}
        isSearchOpen={isSearchOpen}
        onQuery={onQuery}
        onSearchFocus={setSearchFocused}
      />
    </div>
  );
}
