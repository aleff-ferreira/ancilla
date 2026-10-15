/**
 * Rigs for the research lifecycle suites: a seeded store, a real engine over a scripted model and worker, and the
 * errors a locked database gives. No test here starts a real Muse.
 */
import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AncillaStore,
  DEFAULT_RESEARCH_CONFIG,
  ResearchFailure,
  runResearch,
  type ModelClient,
  type ModelRequest,
  type ResearchRunState,
  type WorkerRunner,
} from "@ancilla/daemon";
import { ResearchJobManager, uuidv7, type ResearchJobManagerOptions, type WorkerUpdate } from "../src/research/index.js";

export const thread = (sessionId = "s1") => ({ sessionId, cwd: "/work/p", accountId: null, modelId: null });

const dirsToRemove = new Set<string>();

/**
 * A temp folder, removed as the test process exits. Not in an `after` hook: those run in the order they were registered,
 * and the hook that closes the database or server in the folder is registered after the folder's, so on Windows (where
 * an open SQLite file cannot be deleted) the removal would run first and fail the suite. By the time the process
 * exits every hook has run and everything is closed; a folder that still cannot be removed is left, as the other
 * tests leave theirs.
 */
export function tmpDir(prefix = "ancilla-lifecycle-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (dirsToRemove.size === 0) {
    process.once("exit", () => {
      for (const path of dirsToRemove) {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    });
  }
  dirsToRemove.add(dir);
  return dir;
}

/** A store with one project and one thread (`s1`), closed when the suite ends. */
export function seededStore(path = ":memory:"): AncillaStore {
  const store = new AncillaStore(path);
  after(() => {
    try {
      store.close();
    } catch {
      /* already closed by the test */
    }
  });
  const project = store.upsertProject("/work/p");
  store.recordSession({ id: "s1", projectId: project.id });
  return store;
}

export function newRun(store: AncillaStore, commandId: string, status: "queued" | "running" = "queued") {
  const run = store.createResearchRun({ id: uuidv7(), sessionId: "s1", commandId, question: "What is SQLite?", config: DEFAULT_RESEARCH_CONFIG });
  return status === "queued" ? run : (store.updateResearchRun(run.id, { status, startedAt: new Date().toISOString() }) as typeof run);
}

/** The error SQLite gives when the database is locked by someone else. */
export function busyError(): Error {
  return Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5, errstr: "database is locked" });
}

export function fenced(value: unknown): string {
  return "```json\n" + JSON.stringify(value) + "\n```";
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Resolves when the signal fires, at once if it already has. */
export function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** The first state a run checkpoints, for the engines that stand in for the real one. */
export function aState(runId: string, patch: Partial<ResearchRunState> = {}): ResearchRunState {
  return {
    version: 1,
    runId,
    question: "What is SQLite?",
    config: DEFAULT_RESEARCH_CONFIG,
    phase: "scoping",
    brief: null,
    inputLanguage: null,
    targetLanguage: null,
    draft: null,
    rounds: [],
    registry: [],
    curated: [],
    notes: [],
    consecutiveFailures: 0,
    aborted: false,
    abortReason: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
    startedAt: "2026-10-13T10:00:00.000Z",
    researchDeadlineAt: "2026-10-13T10:10:00.000Z",
    nextAgentId: 1,
    eventSeq: 0,
    ...patch,
  };
}

export interface ScriptedOptions {
  /**
   * `complete`: a worker answers at once. `wait`: it waits for its abort, as a worker on a host that never answers
   * does. `complete-first`: round 1's worker answers and round 2's waits, so a stop finds something to write from.
   */
  worker?: "complete" | "wait" | "complete-first";
  /** `answer`: the writer returns a report. `wait`: it waits on its signal, as a salvage write that is cut short does. */
  writer?: "answer" | "wait";
  persistRetry?: ResearchJobManagerOptions["persistRetry"];
  log?: (message: string) => void;
}

export interface ScriptedRig {
  manager: ResearchJobManager;
  workerCalls: () => number;
  workerWaiting: () => boolean;
  writerRunning: Promise<void>;
  writerSignal: () => AbortSignal | null;
  updates: WorkerUpdate[];
}

/**
 * The real engine over a scripted model and worker. The supervisor delegates one topic, then says it is done; the
 * worker answers or waits for its stop; the writer answers or waits on its signal.
 */
export function scriptedRig(store: AncillaStore, options: ScriptedOptions = {}): ScriptedRig {
  let supervisorCalls = 0;
  let workerCalls = 0;
  let waiting = false;
  let writerSignal: AbortSignal | null = null;
  const writerStarted = deferred();
  const updates: WorkerUpdate[] = [];
  const model: ModelClient = {
    complete: async (request: ModelRequest) => {
      if (request.role === "brief") {
        return { text: fenced({ research_brief: "Brief.", input_language: "English", target_language: "English" }), usage: null, modelId: null };
      }
      if (request.role === "supervisor") {
        supervisorCalls += 1;
        const body = supervisorCalls <= (options.worker === "complete-first" ? 2 : 1)
          ? { reflection: "r", verdict: "CONTINUE_RESEARCH", delegations: [{ topic: `T${supervisorCalls}`, discovery: false }] }
          : { reflection: "done", verdict: "RESEARCH_COMPLETE", delegations: [] };
        return { text: fenced(body), usage: null, modelId: null };
      }
      writerSignal = request.signal;
      writerStarted.resolve();
      if ((options.writer ?? "answer") === "answer") {
        return { text: "# Report\n\nAn answer.", usage: null, modelId: null };
      }
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new ResearchFailure("cancelled", "the writer was stopped")), { once: true });
      });
    },
  };
  const manager = new ResearchJobManager({
    store,
    engine: runResearch,
    createModelClient: () => model,
    createWorkerRunner: (run, _thread, onWorkerUpdate) => {
      const runner: WorkerRunner = {
        async run(task, _budgets, signal) {
          workerCalls += 1;
          const update = (state: WorkerUpdate["state"]): void => {
            const entry: WorkerUpdate = {
              runId: run.id, round: task.round, agentId: task.agentId, topic: task.topic, discovery: task.discovery,
              workerSessionId: `w${task.agentId}`, state, toolCalls: 0, searches: 0, reads: 0, saved: 0,
              startedAt: new Date().toISOString(), endedAt: state === "working" ? null : new Date().toISOString(),
            };
            updates.push(entry);
            onWorkerUpdate(entry);
          };
          update("working");
          const mode = options.worker ?? "complete";
          if (mode === "complete" || (mode === "complete-first" && task.agentId === 1)) {
            update("completed");
            const url = "https://example.org/a1";
            return { status: "completed", findings: `Found (${url}).`, saved: [{ url, title: "A1", reason: "primary", excerpt: null }], observed: [{ tool: "web_fetch", kind: "fetch", query: null, urls: [url], results: [], at: new Date().toISOString() }], usage: null, error: null };
          }
          waiting = true;
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          update("cancelled");
          return { status: "cancelled", findings: "", saved: [], observed: [], usage: null, error: "cancelled: stopped" };
        },
      };
      return runner;
    },
    broadcast: () => undefined,
    writeReport: async () => null,
    ...(options.persistRetry ? { persistRetry: options.persistRetry } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  return { manager, workerCalls: () => workerCalls, workerWaiting: () => waiting, writerRunning: writerStarted.promise, writerSignal: () => writerSignal, updates };
}
