import { useEffect, useRef, useState } from "react";
import { useNow } from "../../app/context.js";
import { durationText, runLive, type RunVM, type SwarmVM } from "../../model/swarm.js";
import { ClockCounterClockwiseIcon, GitForkIcon, SealCheckIcon, ShieldWarningIcon } from "../ui/icons.js";
import { Tip } from "../ui/overlays.js";
import { IconButton, MOD, Spinner } from "../ui/primitives.js";
import { RollingDigits } from "../ui/sourced.js";

/** How long the header says `Swarm landed` after a run ends, before it settles on `Done`. */
export const LANDED_MS = 5000;

/** The request panels in the dock, first one first. */
const PANELS = 'section[aria-label="Approval needed"], section[aria-label="Muse has a question"]';

/**
 * Scrolls a request panel into view, focuses its primary button and flashes its ring once (SPEC §11): the one
 * carrying `requestId` (Requests.tsx marks each panel with its id), else the first request panel in the dock.
 * Returns false when no panel is in the document.
 */
export function focusRequestPanel(requestId: string | null = null): boolean {
  if (typeof document === "undefined") return false;
  const own = requestId ? document.querySelector<HTMLElement>(`[data-request-id="${CSS.escape(requestId)}"]`) : null;
  const panel = own ?? document.querySelector<HTMLElement>(PANELS);
  if (!panel) return false;
  panel.scrollIntoView({ block: "nearest" });
  panel.querySelector<HTMLElement>("button, textarea, input")?.focus();
  panel.classList.remove("swarm-flash");
  // Removing and adding in one frame would not replay the animation.
  void panel.offsetWidth;
  panel.classList.add("swarm-flash");
  window.setTimeout(() => panel.classList.remove("swarm-flash"), 400);
  return true;
}

/** `Needs you · N` in the header: the requests waiting in this thread, a click away. */
export function NeedsYouChip(props: { count: number; onClick: () => void }) {
  if (props.count <= 0) return null;
  return (
    <button type="button" className="swarm-need-chip" aria-label={`Needs you: ${props.count} ${props.count === 1 ? "request" : "requests"}`} onClick={props.onClick}>
      <ShieldWarningIcon size={13} aria-hidden="true" />
      <span aria-hidden="true">
        Needs you · <RollingDigits value={String(props.count)} />
      </span>
    </button>
  );
}

export type SwarmStatusKind = "waiting" | "working" | "landed" | "stale" | "done";

export interface SwarmStatusProps {
  kind: SwarmStatusKind;
  /** The clock beside the word: the turn's start for working, the run's end for landed and stale. */
  ms?: number | null;
  /** Ticks the clock while working. */
  live?: boolean;
  at?: number;
}

/** The header's status word: `Waiting for you`, `Working 41m 16s`, `Swarm landed 45m 10s`, `Last known 12m`, `Done`. */
export function SwarmStatus(props: SwarmStatusProps) {
  const now = useNow(1000, props.live === true);
  if (props.kind === "waiting") {
    return (
      <span className="swarm-status warn">
        <span className="wdot attention-pulse" aria-hidden="true" />
        <span className="@max-[420px]:hidden">Waiting for you</span>
      </span>
    );
  }
  if (props.kind === "working") {
    const ms = props.ms !== null && props.ms !== undefined ? props.ms + (props.live && props.at !== undefined ? Math.max(0, now - props.at) : 0) : null;
    return (
      <span className="swarm-status">
        <Spinner size={12} className="text-accent-text" />
        <span className="@max-[420px]:hidden">Working</span>
        {ms !== null ? <span className="t">{durationText(ms)}</span> : null}
      </span>
    );
  }
  if (props.kind === "landed") {
    return (
      <span className="swarm-status ok">
        <SealCheckIcon size={14} aria-hidden="true" />
        <span className="@max-[420px]:hidden">Swarm landed</span>
        {props.ms !== null && props.ms !== undefined ? <span className="t">{durationText(props.ms)}</span> : null}
      </span>
    );
  }
  if (props.kind === "stale") {
    return (
      <span className="swarm-status">
        <ClockCounterClockwiseIcon size={14} aria-hidden="true" className="text-subtle" />
        <span className="@max-[420px]:hidden">Last known</span>
        {props.ms !== null && props.ms !== undefined ? <span className="t">{durationText(props.ms)}</span> : null}
      </span>
    );
  }
  return (
    <span className="swarm-status">
      <SealCheckIcon size={14} aria-hidden="true" className="text-subtle" />
      <span className="@max-[420px]:hidden">Done</span>
    </span>
  );
}

/** The Swarm panel's toggle beside the files toggle, with the live run's agent count (SPEC §4 SwarmToggleProps). */
export function SwarmToggle(props: { active: boolean; count: number | null; onClick: () => void }) {
  const label = props.active ? "Hide the Swarm panel" : "Show the Swarm panel";
  return (
    <Tip label="Swarm panel" shortcut={[MOD, "Shift", "M"]}>
      <IconButton label={label} active={props.active} className="swarm-tog" onClick={props.onClick}>
        <GitForkIcon size={15} />
        {props.count !== null && props.count > 0 ? (
          <span className="n @max-[700px]:hidden" aria-hidden="true">
            {props.count}
          </span>
        ) : null}
      </IconButton>
    </Tip>
  );
}

/** The run the header speaks for: the last live one, else the last one that ended. */
export function headerRun(view: SwarmVM | null): RunVM | null {
  if (!view) return null;
  const live = view.runs.filter(runLive);
  return live[live.length - 1] ?? view.runs[view.runs.length - 1] ?? null;
}

/**
 * Whether the header should say `Swarm landed`: for five seconds after a run is seen to end. A run that had
 * already ended when the thread opened is not news, unless it ended within the last five seconds.
 */
export function useLanded(run: RunVM | null): boolean {
  const [until, setUntil] = useState<number>(() => (run && !runLive(run) && run.endedAt !== null && run.clockAt - run.endedAt < LANDED_MS ? run.endedAt + LANDED_MS : 0));
  const wasLive = useRef(run ? runLive(run) : false);
  const key = run ? `${run.itemId}:${runLive(run) ? "live" : "ended"}` : "";
  useEffect(() => {
    const live = run ? runLive(run) : false;
    if (wasLive.current && !live && run) {
      setUntil(Date.now() + LANDED_MS);
    }
    wasLive.current = live;
  }, [key, run]);
  const now = useNow(1000, until > Date.now());
  return until > now;
}

/** The stale clock the header shows: `Last known 12m`, from the moment the feed went quiet. */
export function staleAge(run: RunVM, now: number): number | null {
  return run.staleAt !== null ? Math.max(0, now - run.staleAt) : null;
}
