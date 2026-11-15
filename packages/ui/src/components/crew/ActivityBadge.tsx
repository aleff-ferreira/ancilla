import { shallowEqual, useApp, useController } from "../../app/context.js";
import { activityView, windowTitleCount } from "../../model/crew.js";
import type { AppState } from "../../model/store.js";
import { PulseIcon } from "../ui/icons.js";
import { Tip } from "../ui/overlays.js";
import { IconButton, MOD, cn } from "../ui/primitives.js";

export interface ActivityBadgeVM {
  readonly count: number;
  readonly needs: number;
}

export function activityBadge(state: AppState, now: number): ActivityBadgeVM {
  const attentionCount = windowTitleCount(state);
  const runningList = activityView(state, now).working;
  const totalWaiting = attentionCount + runningList.length;
  return {
    count: totalWaiting,
    needs: attentionCount,
  };
}

export function activityLabel(badge: ActivityBadgeVM): string {
  const total = badge.count;
  if (!total) {
    return "Activity";
  }
  const statusPhrases: string[] = [];
  const requiredCount = badge.needs;
  if (requiredCount > 0) {
    const grammaticalSuffix = requiredCount === 1 ? "needs you" : "need you";
    statusPhrases.push(`${requiredCount} ${grammaticalSuffix}`);
  }
  const activeWorkingCount = total - requiredCount;
  if (activeWorkingCount > 0) {
    statusPhrases.push(`${activeWorkingCount} working`);
  }
  return `Activity, ${statusPhrases.join(", ")}`;
}

const BADGE_BASE_CLASSES = "absolute -top-px -right-[5px] flex h-3.5 min-w-3.5 items-center justify-center rounded-[7px] px-[3px] text-[9.5px] leading-[14px] font-semibold tabular-nums shadow-[0_0_0_2px_var(--bg-sidebar)]";

function ShoulderNotificationIndicator({ count, urgent }: { count: number; urgent: boolean }) {
  if (count <= 0) return null;
  const labelText = count > 99 ? "99+" : String(count);
  const colorScheme = urgent ? "bg-warn text-[oklch(0.2_0.02_60)]" : "bg-accent text-accent-fg";
  return (
    <span className={cn(BADGE_BASE_CLASSES, colorScheme)} aria-hidden="true">
      {labelText}
    </span>
  );
}

export function ActivityButton() {
  const appController = useController();
  const drawerActive = useApp((st) => st.crew.activityOpen);
  const badgeStats = useApp((st) => activityBadge(st, Date.now()), shallowEqual);

  const onButtonPress = () => {
    appController.setActivityOpen(!drawerActive);
  };

  const buttonTitle = activityLabel(badgeStats);
  const keyChord = [MOD, "Shift", "A"] as const;

  const buttonElement = (
    <IconButton
      className="relative"
      label={buttonTitle}
      active={drawerActive}
      aria-expanded={drawerActive}
      onClick={onButtonPress}
    >
      <PulseIcon size={15} />
      <ShoulderNotificationIndicator count={badgeStats.count} urgent={badgeStats.needs > 0} />
    </IconButton>
  );

  return (
    <Tip side="top" label="Activity" shortcut={keyChord}>
      {buttonElement}
    </Tip>
  );
}
