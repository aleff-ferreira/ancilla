/**
 * Rigs for the research suites that live outside `research.test.ts`: a fake clock, a worker runner and a control
 * session client over a scripted connection. Nothing here starts a real Muse or arms a real timer.
 */
import { SessionManager, type ModelRequest, type ModelRole, type WorkerBudgets, type WorkerTask } from "@ancilla/daemon";
import { MuseSessionModelClient, MuseSessionWorkerRunner, type WorkerClock, type WorkerSessionHandle, type WorkerUpdate } from "../src/research/index.js";
import { FakeConnection } from "./harness.js";

/** A clock whose timers fire only when the test says so. */
export class FakeClock implements WorkerClock {
  time = 1_000_000;
  timers: { id: number; at: number; callback: () => void }[] = [];
  private nextId = 1;

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ id, at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** Advances the clock and fires every timer that came due, in order. */
  advance(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= this.time).sort((a, b) => a.at - b.at)[0];
      if (!due) {
        return;
      }
      this.timers = this.timers.filter((t) => t.id !== due.id);
      due.callback();
    }
  }
}

type Listener = (method: string, params: Record<string, unknown>) => void;

/** Routes the connection's notifications to the handlers subscribed for their session. */
function routing(connection: FakeConnection): (sessionId: string, handler: Listener) => () => void {
  const listeners = new Map<string, Set<Listener>>();
  connection.onNotification((n) => {
    const params = (n.params ?? {}) as Record<string, unknown>;
    const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : null;
    for (const listener of [...(sessionId ? listeners.get(sessionId) ?? [] : [])]) {
      listener(n.method, params);
    }
  });
  return (sessionId, handler) => {
    const set = listeners.get(sessionId) ?? new Set<Listener>();
    listeners.set(sessionId, set);
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  };
}

export const TASK: WorkerTask = { runId: "r1", round: 1, agentId: 1, topic: "SQLite history", discovery: false, instructions: "Research SQLite's history.", maxReads: null };
export const BUDGETS: WorkerBudgets = { maxToolCalls: 25, maxSearches: 3, maxReads: 10, maxSaves: 10, wallTimeMs: 600_000 };
export const noSink = { onToolCall: () => undefined, onProgress: () => undefined };

export const modelRequest = (role: ModelRole, prompt = "Decide.", signal: AbortSignal = new AbortController().signal, timeoutMs = 240_000): ModelRequest => ({
  role,
  prompt,
  maxOutputTokens: 100,
  timeoutMs,
  signal,
});

export interface WorkerRigOptions {
  cancelGraceMs?: number;
  /** The startup allowance the runner is given; omitted, the runner's own default applies. */
  startupMs?: number | (() => number);
  /** Replaces the host's session start, for a start that never settles or settles late. */
  start?: (task: WorkerTask, modelId: string | null, giveUp?: AbortSignal) => Promise<WorkerSessionHandle>;
}

export function workerRig(options: WorkerRigOptions = {}) {
  const connection = new FakeConnection();
  const manager = new SessionManager(connection as never);
  const subscribe = routing(connection);
  connection.replies.set("session/start", { session: { sessionId: "w1" } });
  const updates: WorkerUpdate[] = [];
  const clock = new FakeClock();
  const logs: string[] = [];
  const startsSeen: (AbortSignal | undefined)[] = [];
  const runner = new MuseSessionWorkerRunner({
    host: {
      startWorkerSession: async (task, modelId, giveUp?: AbortSignal) => {
        startsSeen.push(giveUp);
        if (options.start) {
          return options.start(task, modelId, giveUp);
        }
        const started = await manager.startSession({ workspaceRoot: "/work/p", ...(modelId ? { modelId } : {}) });
        return { sessionId: started.sessionId, manager };
      },
      subscribe,
      onWorkerUpdate: (update) => updates.push(update),
      log: (message) => logs.push(message),
    },
    models: { supervisor: null, worker: "worker-model", writer: null },
    fallbackModelId: "thread-model",
    clock,
    ...(options.cancelGraceMs !== undefined ? { cancelGraceMs: options.cancelGraceMs } : {}),
    ...(options.startupMs !== undefined ? { startupMs: options.startupMs } : {}),
  });
  return { connection, manager, runner, updates, clock, logs, startsSeen };
}

export interface ControlRigOptions {
  models?: { supervisor: string | null; worker: string | null; writer: string | null };
  startupMs?: number;
  start?: (modelId: string | null, giveUp?: AbortSignal) => Promise<{ sessionId: string; manager: SessionManager }>;
}

export function controlRig(options: ControlRigOptions = {}) {
  const connection = new FakeConnection();
  const manager = new SessionManager(connection as never);
  const subscribe = routing(connection);
  let started = 0;
  connection.replies.set("session/start", () => {
    started += 1;
    return { session: { sessionId: `ctl-${started}` } };
  });
  const clock = new FakeClock();
  const logs: string[] = [];
  const starts: (string | null)[] = [];
  const client = new MuseSessionModelClient({
    host: {
      startControlSession: async (modelId, giveUp?: AbortSignal) => {
        starts.push(modelId);
        if (options.start) {
          return options.start(modelId, giveUp);
        }
        const session = await manager.startSession({ workspaceRoot: "/work/p", ...(modelId ? { modelId } : {}) });
        return { sessionId: session.sessionId, manager };
      },
      subscribe,
      log: (message) => logs.push(message),
    },
    models: options.models ?? { supervisor: null, worker: null, writer: null },
    fallbackModelId: null,
    clock,
    cancelGraceMs: 30_000,
    ...(options.startupMs !== undefined ? { startupMs: options.startupMs } : {}),
  });
  return { connection, manager, client, clock, logs, starts };
}

/** An agent message and a completed terminal for `turnId` in `sessionId`, delivered as the host would. */
export function deliverAnswer(connection: FakeConnection, sessionId: string, turnId: string, text: string, terminal = "completed"): void {
  connection.notify("turn/started", { sessionId, turnId });
  connection.notify("item/completed", { sessionId, item: { itemId: `m-${turnId}`, kind: "agentMessage", status: "completed", turnId, revision: 1, text } });
  connection.notify("turn/completed", { sessionId, turnId, terminal });
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
