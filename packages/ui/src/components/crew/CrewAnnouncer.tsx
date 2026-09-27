import { useEffect, useRef, useState } from "react";
import { announcements, type CrewVM } from "../../model/crew.js";

/** One announcement per this long, at most (SPEC §12). */
export const ANNOUNCE_WINDOW_MS = 10_000;

export interface AnnouncerTimers {
  now: () => number;
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const REAL_TIMERS: AnnouncerTimers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The debounce behind the one live region: the first message in a quiet spell goes out at once; anything that
 * follows within the window is gathered and read together when the window ends, so a crew never drowns the thread.
 */
export class AnnouncementQueue {
  private lastAt = Number.NEGATIVE_INFINITY;
  private pending: string[] = [];
  private timer: unknown = null;

  constructor(
    private readonly emit: (text: string) => void,
    private readonly windowMs = ANNOUNCE_WINDOW_MS,
    private readonly timers: AnnouncerTimers = REAL_TIMERS,
  ) {}

  push(messages: readonly string[]): void {
    if (messages.length === 0) return;
    const now = this.timers.now();
    if (this.timer === null && now - this.lastAt >= this.windowMs) {
      this.lastAt = now;
      this.emit(messages.join(" "));
      return;
    }
    this.pending.push(...messages);
    if (this.timer === null) {
      this.timer = this.timers.set(() => this.flush(), Math.max(0, this.lastAt + this.windowMs - now));
    }
  }

  private flush(): void {
    this.timer = null;
    if (this.pending.length === 0) return;
    this.lastAt = this.timers.now();
    const text = this.pending.join(" ");
    this.pending = [];
    this.emit(text);
  }

  dispose(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.pending = [];
  }
}

/**
 * What the live region should say as the view changes: only the events SPEC §12 lists, from `announcements()`,
 * one message per ten seconds. Nothing is said about what was already there when the thread opened, and nothing
 * while the view is quiet (loading, or last known).
 */
export function useCrewAnnouncer(view: CrewVM | null, quiet: boolean): { id: number; text: string } | null {
  const [message, setMessage] = useState<{ id: number; text: string } | null>(null);
  const queue = useRef<AnnouncementQueue | null>(null);
  const previous = useRef<CrewVM | null>(null);
  useEffect(() => {
    queue.current ??= new AnnouncementQueue((text) => setMessage((current) => ({ id: (current?.id ?? 0) + 1, text })));
    if (quiet || view === null) {
      previous.current = view;
      return;
    }
    const messages = previous.current ? announcements(previous.current, view) : [];
    previous.current = view;
    queue.current.push(messages);
  }, [view, quiet]);
  useEffect(() => () => queue.current?.dispose(), []);
  return message;
}

/** The one `role="status"` region in the document, owned by the open thread's Crew card. */
export function CrewAnnouncer(props: { view: CrewVM | null; quiet: boolean }) {
  const message = useCrewAnnouncer(props.view, props.quiet);
  return (
    <div role="status" aria-live="polite" className="sr-only" data-crew-announcer="">
      {message ? <span key={message.id}>{message.text}</span> : null}
    </div>
  );
}
