import { useCallback, useEffect, useRef, useState } from "react";
import { useApp, useController } from "../../app/context.js";
import { errorMessage } from "../../client.js";
import type { MemoryKind, MemoryScopeView } from "../../types.js";

/** One call of the assistant's HTTP surface. */
export function useAssistantCall(): <T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => Promise<T> {
  const controller = useController();
  return useCallback(<T,>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => controller.assistant<T>(method, path, body), [controller]);
}

/** Says that this page's own call changed the profile as a side effect: open pages read it again (see `Controller.assistantMoved`). */
export function useAssistantMoved(): () => void {
  const controller = useController();
  return useCallback(() => controller.assistantMoved(), [controller]);
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Reads one path of the assistant's API, and again when the server says something changed (the event counter), when
 * the page says it changed something (`bump`), or when `path` does. An older answer never replaces a newer one.
 */
export function useAssistantData<T>(path: string | null, bump = 0): Loaded<T> {
  const call = useAssistantCall();
  const rev = useApp((s) => s.assistantRev);
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null, loading: path !== null });
  const seq = useRef(0);
  useEffect(() => {
    if (path === null) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    call<T>("GET", path).then(
      (data) => {
        if (mine === seq.current) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (mine === seq.current) setState((s) => ({ data: s.data, error: errorMessage(error), loading: false }));
      },
    );
  }, [call, path, rev, bump]);
  return state;
}

export const KIND_LABEL: Record<MemoryKind, string> = {
  fact: "Fact",
  preference: "Preference",
  constraint: "Rule",
  event: "Event",
  decision: "Decision",
  procedure: "Procedure",
  commitment: "To do",
  working: "This chat",
};

export const KINDS = Object.keys(KIND_LABEL) as MemoryKind[];

export function scopeLabel(scope: MemoryScopeView): string {
  if (scope.kind === "global") return "everywhere";
  if (scope.kind === "thread") return "one thread";
  if (scope.kind === "account") return "one account";
  const parts = scope.key.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? scope.key;
}

const UNITS: [number, string][] = [
  [86_400_000 * 365, "year"],
  [86_400_000 * 30, "month"],
  [86_400_000 * 7, "week"],
  [86_400_000, "day"],
  [3_600_000, "hour"],
  [60_000, "minute"],
];

/** "3 days ago", "in 2 hours", "just now". */
export function ago(at: number, now: number): string {
  const diff = at - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return "just now";
  for (const [size, name] of UNITS) {
    if (abs >= size) {
      const n = Math.round(abs / size);
      return diff < 0 ? `${n} ${name}${n === 1 ? "" : "s"} ago` : `in ${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return "just now";
}

export function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}
