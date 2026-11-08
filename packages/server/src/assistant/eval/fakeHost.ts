import type { ExecutiveHost, TurnState } from "../executive.js";
import type { FileRead } from "../tasks.js";

/**
 * A scripted Muse for the executive: it records what it was asked, answers from what the test set up, and lets the
 * test play the turn's own events. Used by the executive's tests and by the fault-injection runs.
 */
export class FakeHost implements ExecutiveHost {
  sessions: { cwd: string; title: string }[] = [];
  turns: { sessionId: string; turnId: string; text: string; displayText: string; commandId: string }[] = [];
  interrupts: { sessionId: string; turnId: string }[] = [];
  ledger = new Map<string, TurnState>();
  files = new Map<string, string>();
  reachable: { ok: boolean; reason?: string } = { ok: true };
  startError: Error | null = null;
  interruptError: Error | null = null;
  needs = new Set<string>();
  handlers = new Map<string, (method: string, params: Record<string, unknown>) => void>();
  logs: string[] = [];
  /** Runs inside startTurn, before it answers: a completion that beats the answer. */
  duringStart: ((turnId: string, sessionId: string) => void) | null = null;
  private counter = 0;

  /** `idPrefix` keeps the turn ids of a second host apart from the first's, as real turn ids are. */
  constructor(
    readonly clock: { t: number },
    private readonly idPrefix = "",
  ) {}

  now(): number {
    return this.clock.t;
  }
  projectKey(cwd: string): string {
    return cwd;
  }
  async hostAvailable(): Promise<{ ok: boolean; reason?: string }> {
    return this.reachable;
  }
  async startSession(input: { cwd: string; title: string }): Promise<{ sessionId: string }> {
    this.sessions.push({ cwd: input.cwd, title: input.title });
    return { sessionId: `${this.idPrefix}sess-${this.sessions.length}` };
  }
  async startTurn(input: { sessionId: string; text: string; displayText: string; commandId: string }): Promise<{ turnId: string }> {
    if (this.startError) throw this.startError;
    this.counter += 1;
    const turnId = `${this.idPrefix}turn-${this.counter}`;
    this.turns.push({ ...input, turnId });
    this.ledger.set(`${input.sessionId}:${turnId}`, "running");
    this.duringStart?.(turnId, input.sessionId);
    return { turnId };
  }
  async interruptTurn(sessionId: string, turnId: string): Promise<void> {
    if (this.interruptError) throw this.interruptError;
    this.interrupts.push({ sessionId, turnId });
  }
  async turnState(sessionId: string, turnId: string): Promise<TurnState> {
    return this.ledger.get(`${sessionId}:${turnId}`) ?? "absent";
  }
  async readProjectFile(_cwd: string, relPath: string): Promise<FileRead> {
    const text = this.files.get(relPath);
    return text === undefined ? { exists: false, text: null, size: 0 } : { exists: true, text, size: text.length };
  }
  needsUser(sessionId: string): boolean {
    return this.needs.has(sessionId);
  }
  watch(sessionId: string, handler: (method: string, params: Record<string, unknown>) => void): () => void {
    this.handlers.set(sessionId, handler);
    return () => this.handlers.delete(sessionId);
  }
  log(line: string): void {
    this.logs.push(line);
  }
  fire(sessionId: string, method: string, params: Record<string, unknown>): void {
    this.handlers.get(sessionId)?.(method, params);
  }
  finish(turnId: string, terminal = "completed", error?: string): void {
    const turn = this.turns.find((t) => t.turnId === turnId);
    if (!turn) throw new Error(`no turn ${turnId}`);
    this.ledger.set(`${turn.sessionId}:${turnId}`, terminal as TurnState);
    this.fire(turn.sessionId, "turn/completed", { turnId, terminal, ...(error ? { error: { message: error } } : {}) });
  }
  last(): { sessionId: string; turnId: string; text: string; displayText: string; commandId: string } {
    const turn = this.turns.at(-1);
    if (!turn) throw new Error("no turn was started");
    return turn;
  }
}

/** Gives pending promises and their continuations a few turns of the event loop. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
}
