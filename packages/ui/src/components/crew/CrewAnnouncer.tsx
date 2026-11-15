import { useEffect, useRef, useState } from "react";
import { announcements, type CrewVM } from "../../model/crew.js";

export const ANNOUNCE_WINDOW_MS = 10_000;

export interface AnnouncerTimers {
  readonly now: () => number;
  readonly set: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const NATIVE_TIMERS: AnnouncerTimers = {
  now: () => Date.now(),
  set: (task, ms) => setTimeout(task, ms),
  clear: (ref) => clearTimeout(ref as ReturnType<typeof setTimeout>),
};

export class AnnouncementQueue {
  private _lastDispatchedTime = Number.NEGATIVE_INFINITY;
  private _backlog: string[] = [];
  private _scheduledHandle: unknown = null;

  constructor(
    private readonly emit: (text: string) => void,
    private readonly windowMs = ANNOUNCE_WINDOW_MS,
    private readonly timers: AnnouncerTimers = NATIVE_TIMERS,
  ) {}

  push(messages: readonly string[]) {
    if (!messages || messages.length === 0) return;
    const timestamp = this.timers.now();
    const durationSinceLast = timestamp - this._lastDispatchedTime;
    const canSpeakImmediately = this._scheduledHandle === null && durationSinceLast >= this.windowMs;

    if (canSpeakImmediately) {
      this._lastDispatchedTime = timestamp;
      this.emit(messages.join(" "));
      return;
    }

    for (let i = 0; i < messages.length; i++) {
      this._backlog.push(messages[i]);
    }

    if (this._scheduledHandle === null) {
      const waitRemaining = Math.max(0, this.windowMs - durationSinceLast);
      this._scheduledHandle = this.timers.set(() => this.flush(), waitRemaining);
    }
  }

  private flush() {
    this._scheduledHandle = null;
    if (this._backlog.length === 0) return;
    this._lastDispatchedTime = this.timers.now();
    const concatenatedText = this._backlog.join(" ");
    this._backlog = [];
    this.emit(concatenatedText);
  }

  dispose() {
    if (this._scheduledHandle !== null) {
      this.timers.clear(this._scheduledHandle);
      this._scheduledHandle = null;
    }
    this._backlog = [];
  }
}

export function useCrewAnnouncer(view: CrewVM | null, quiet: boolean): { id: number; text: string } | null {
  const [currentUtterance, setCurrentUtterance] = useState<{ id: number; text: string } | null>(null);
  const queueInstance = useRef<AnnouncementQueue | null>(null);
  const priorViewModel = useRef<CrewVM | null>(null);

  useEffect(() => {
    if (!queueInstance.current) {
      queueInstance.current = new AnnouncementQueue((deliveredText) => {
        setCurrentUtterance((prior) => ({
          id: (prior?.id ?? 0) + 1,
          text: deliveredText,
        }));
      });
    }

    if (quiet || !view) {
      priorViewModel.current = view;
      return;
    }

    const eventsToSpeak = priorViewModel.current ? announcements(priorViewModel.current, view) : [];
    priorViewModel.current = view;
    queueInstance.current.push(eventsToSpeak);
  }, [view, quiet]);

  useEffect(() => {
    return () => queueInstance.current?.dispose();
  }, []);

  return currentUtterance;
}

export function CrewAnnouncer(props: { view: CrewVM | null; quiet: boolean }) {
  const activeMessage = useCrewAnnouncer(props.view, props.quiet);
  const messageNode = activeMessage ? <span key={activeMessage.id}>{activeMessage.text}</span> : null;

  return (
    <div role="status" aria-live="polite" data-crew-announcer="" className="sr-only">
      {messageNode}
    </div>
  );
}
