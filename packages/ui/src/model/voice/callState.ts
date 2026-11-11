import type { CallApproval, CallMode, CallPhase, ServerMessage, TurnMetrics } from "./protocol.js";

/**
 * What the call screen shows, as a pure function of what the server said: the words so far, who is speaking, the tasks
 * running behind the conversation. Nothing here touches the network or the speakers, so the whole of it is tested without
 * either.
 */

export interface CallLine {
  /** The turn this line belongs to; the person's words and the reply to them share it. */
  turn: number;
  role: "user" | "assistant";
  text: string;
  source: "voice" | "text";
  /** The reply was still coming when it was shown, or has been said in full. */
  done: boolean;
  /** The person cut the reply off; `heard` is how much of it they heard. */
  interrupted: boolean;
  heard: string | null;
}

export interface CallTask {
  id: string;
  title: string;
  status: string;
  note: string | null;
  at: number;
}

export interface CallView {
  status: "connecting" | "ready" | "ended" | "failed";
  phase: CallPhase;
  mode: CallMode;
  /** The microphone is muted by the person. */
  muted: boolean;
  /** The microphone is held open to a button (push to talk) right now. */
  talking: boolean;
  /** The server hears speech on the line this moment. */
  heard: boolean;
  /** The assistant's voice is being lowered because the person may be about to speak. */
  ducked: boolean;
  /** The words of the person's turn that is in progress, as far as they are known. */
  partial: string;
  lines: CallLine[];
  tasks: CallTask[];
  /** Pending consequential action awaiting the person's click or spoken confirmation. */
  approval: CallApproval | null;
  notice: { level: "info" | "warn"; text: string } | null;
  metrics: TurnMetrics[];
  engine: string;
  voice: string;
  sampleRate: number;
  resumed: boolean;
  /** Why the call is not working, in words for the person. */
  error: string | null;
  endedReason: string | null;
  /** Why the microphone is not being heard (it could not be opened, is muted, is silent or was lost), in words for the person; the call goes on by text. */
  micProblem: string | null;
}

export function initialCall(mode: CallMode = "hands-free"): CallView {
  return {
    status: "connecting",
    phase: "idle",
    mode,
    muted: false,
    talking: false,
    heard: false,
    ducked: false,
    partial: "",
    lines: [],
    tasks: [],
    approval: null,
    notice: null,
    metrics: [],
    engine: "",
    voice: "",
    sampleRate: 0,
    resumed: false,
    error: null,
    endedReason: null,
    micProblem: null,
  };
}

const MAX_LINES = 200;
const MAX_METRICS = 30;

function withLine(lines: CallLine[], update: (lines: CallLine[]) => CallLine[]): CallLine[] {
  const next = update(lines);
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}

/** The view after the server said `message`. */
export function reduceServer(view: CallView, message: ServerMessage, now: number): CallView {
  switch (message.type) {
    case "ready":
      return { ...view, status: "ready", engine: message.engine, voice: message.voice, sampleRate: message.sampleRate, resumed: message.resumed, error: null };
    case "state":
      return { ...view, phase: message.state, ducked: message.state === "speaking" ? view.ducked : false };
    case "level":
      return { ...view, heard: message.speaking };
    case "partial":
      return { ...view, partial: message.text };
    case "user": {
      const lines = withLine(view.lines, (all) => {
        const last = all[all.length - 1];
        // A turn carried on (the person went on after a pause) is the same line, said again in full.
        if (last && last.role === "user" && last.turn === message.turn) return [...all.slice(0, -1), { ...last, text: message.text, source: message.source }];
        return [...all, { turn: message.turn, role: "user" as const, text: message.text, source: message.source, done: true, interrupted: false, heard: null }];
      });
      return { ...view, lines, partial: "" };
    }
    case "assistant": {
      const lines = withLine(view.lines, (all) => {
        const at = all.findIndex((l) => l.role === "assistant" && l.turn === message.turn);
        if (at >= 0) return all.map((l, i) => (i === at ? { ...l, text: message.text, done: message.done } : l));
        return [...all, { turn: message.turn, role: "assistant" as const, text: message.text, source: "voice" as const, done: message.done, interrupted: false, heard: null }];
      });
      return { ...view, lines };
    }
    case "interrupted": {
      const lines = view.lines.map((l, i) => (i === findLast(view.lines, "assistant") ? { ...l, interrupted: true, heard: message.heard, done: true } : l));
      return { ...view, lines, ducked: false };
    }
    case "speaking":
    case "speak_end":
    case "pong":
      return view;
    case "duck":
      return { ...view, ducked: message.on };
    case "task": {
      const rest = view.tasks.filter((t) => t.id !== message.id);
      return { ...view, tasks: [{ id: message.id, title: message.title, status: message.status, note: message.note, at: now }, ...rest].slice(0, 8) };
    }
    case "approval":
      return { ...view, approval: message.request };
    case "notice":
      return { ...view, notice: { level: message.level, text: message.text } };
    case "metrics":
      return { ...view, metrics: [...view.metrics, message.metrics].slice(-MAX_METRICS) };
    case "error": {
      const fatal = message.code === "unavailable" || message.code === "version";
      return fatal ? { ...view, status: "failed", error: message.message } : { ...view, notice: { level: "warn", text: message.message } };
    }
    case "ended":
      return { ...view, status: view.status === "failed" ? "failed" : "ended", endedReason: message.reason, phase: "idle", partial: "", heard: false, approval: null };
  }
}

function findLast(lines: readonly CallLine[], role: CallLine["role"]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]?.role === role) return i;
  return -1;
}

/** A line the person typed is shown at once, before the server has confirmed it. */
export function withTyped(view: CallView, text: string): CallView {
  const turn = (view.lines[view.lines.length - 1]?.turn ?? 0) + 1;
  const line: CallLine = { turn, role: "user", text, source: "text", done: true, interrupted: false, heard: null };
  return { ...view, lines: [...view.lines, line].slice(-MAX_LINES) };
}

/** What the transcript says before anything was said: an invitation to speak, unless the microphone cannot be heard, when it is to type. */
export function emptyLine(view: CallView): string {
  if (view.status !== "ready") return "…";
  if (view.micProblem !== null) return view.resumed ? "Back where you left off. Type below, or fix the microphone and speak." : "Type below, or fix the microphone and speak.";
  return view.resumed ? "Back where you left off. Say something." : "Say something, or type below.";
}

/** The word on the call's face: what it is doing, for the person. */
export function phaseLabel(view: CallView): string {
  if (view.status === "connecting") return "Connecting";
  if (view.status === "failed") return "Could not start";
  if (view.status === "ended") return "Call ended";
  if (view.muted) return "Muted";
  // A call that listens to nothing must not say "Listening": what the assistant is doing still shows while it works or speaks.
  if (view.micProblem !== null && view.phase !== "speaking" && view.phase !== "thinking") return "Can't hear the microphone";
  switch (view.phase) {
    case "speaking":
      return view.ducked ? "Listening…" : "Speaking";
    case "thinking":
      return "Thinking";
    case "listening":
      return view.heard ? "Hearing you" : "Listening";
    default:
      return view.mode === "push-to-talk" ? "Hold space to talk" : "Listening";
  }
}
