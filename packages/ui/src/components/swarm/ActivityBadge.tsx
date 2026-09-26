import { PulseIcon } from "../ui/icons.js";
import { shallowEqual, useApp, useController } from "../../app/context.js";
import type { AppState } from "../../model/store.js";
import { activityView, windowTitleCount } from "../../model/swarm.js";
import { Tip } from "../ui/overlays.js";
import { IconButton, MOD, cn } from "../ui/primitives.js";

export interface ActivityBadgeVM {
  /** Requests waiting anywhere, plus what runs in the threads this client folds. */
  count: number;
  /** The part of the count that waits for you; the badge turns amber for it. */
  needs: number;
}

/** What the footer's Activity button carries: the same numbers the drawer's Needs you and Working sections show. */
export function activityBadge(state: AppState, now: number): ActivityBadgeVM {
  const needs = windowTitleCount(state);
  return { count: needs + activityView(state, now).working.length, needs };
}

/** The button's accessible name: the count, said in words. */
export function activityLabel(badge: ActivityBadgeVM): string {
  if (badge.count === 0) {
    return "Activity";
  }
  const parts: string[] = [];
  if (badge.needs > 0) {
    parts.push(`${badge.needs} ${badge.needs === 1 ? "needs" : "need"} you`);
  }
  const working = badge.count - badge.needs;
  if (working > 0) {
    parts.push(`${working} working`);
  }
  return `Activity, ${parts.join(", ")}`;
}

/** The footer's way into the Activity drawer, with the count on its shoulder. */
export function ActivityButton() {
  const controller = useController();
  const open = useApp((s) => s.swarm.activityOpen);
  const badge = useApp((s) => activityBadge(s, Date.now()), shallowEqual);
  return (
    <Tip label="Activity" shortcut={[MOD, "Shift", "A"]} side="top">
      <IconButton
        label={activityLabel(badge)}
        active={open}
        aria-expanded={open}
        onClick={() => controller.setActivityOpen(!open)}
        className="relative"
      >
        <PulseIcon size={15} />
        {badge.count > 0 ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute -top-px -right-[5px] flex h-3.5 min-w-3.5 items-center justify-center rounded-[7px] px-[3px] text-[9.5px] leading-[14px] font-semibold tabular-nums shadow-[0_0_0_2px_var(--bg-sidebar)]",
              badge.needs > 0 ? "bg-warn text-[oklch(0.2_0.02_60)]" : "bg-accent text-accent-fg",
            )}
          >
            {badge.count > 99 ? "99+" : badge.count}
          </span>
        ) : null}
      </IconButton>
    </Tip>
  );
}
