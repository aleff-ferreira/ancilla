import { randomBytes } from "node:crypto";
import { nextRun, SCHEDULE_LIMITS, validZone, type ScheduleKind } from "./schedule.js";
import { looksSecret } from "./secrets.js";
import { ConflictError, NotFoundError, ValidationError, type MemoryStore, type Param, type Row } from "./store.js";
import type { AssistantProfile } from "./types.js";

/**
 * What the task executive keeps. A task is work the user approved: some steps, run as turns in a thread they can see,
 * under a budget, with the evidence for each result. Everything the executive decides is written here first and
 * acted on after, so a restart finds the task where it was and can say what it does not know.
 */

export type TaskStatus = "queued" | "running" | "waiting" | "paused" | "blocked" | "completed" | "unverified" | "failed" | "cancelled";
export const TERMINAL_TASK: ReadonlySet<TaskStatus> = new Set(["completed", "unverified", "failed", "cancelled"]);
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "cancelled" | "unknown";
/** `write` is any step that can change something (a file, anything outside the project): it is never run twice on a guess. */
export type Effect = "read" | "write";
export type AttemptOutcome = "running" | "succeeded" | "failed" | "cancelled" | "stale" | "unknown" | "timeout";
export type TaskOrigin = "user" | "suggestion" | "schedule";

export type Verifier =
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; text: string }
  | { type: "manual" };

export interface StepSpec {
  title: string;
  prompt?: string | null;
  effect?: Effect;
  verifier?: Verifier | null;
}

export interface TaskStep {
  id: string;
  taskId: string;
  ord: number;
  title: string;
  prompt: string | null;
  effect: Effect;
  verifier: Verifier | null;
  status: StepStatus;
  evidence: string;
  verified: boolean;
  attempts: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface TaskAttempt {
  id: string;
  taskId: string;
  stepId: string;
  number: number;
  fence: number;
  commandId: string;
  sessionId: string | null;
  turnId: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: AttemptOutcome;
  detail: string;
}

export interface Task {
  id: string;
  title: string;
  goal: string;
  goalId: string | null;
  status: TaskStatus;
  reason: string;
  origin: TaskOrigin;
  scheduleId: string | null;
  cwd: string;
  project: string;
  account: string | null;
  sessionId: string | null;
  allowWrites: boolean;
  maxTurns: number;
  maxMinutes: number;
  turnsUsed: number;
  fence: number;
  retryAt: number | null;
  failures: number;
  startedAt: number | null;
  finishedAt: number | null;
  result: string;
  createdAt: number;
  updatedAt: number;
  /** Steps that are done, of all of them. */
  progress: { done: number; total: number };
}

export interface TaskEvent {
  id: number;
  at: number;
  kind: string;
  attemptId: string | null;
  detail: string;
}

export interface TaskDetail {
  task: Task;
  steps: TaskStep[];
  attempts: TaskAttempt[];
  events: TaskEvent[];
}

export interface NewTask {
  title: string;
  goal: string;
  goalId: string | null;
  cwd: string;
  project: string;
  account: string | null;
  allowWrites: boolean;
  maxTurns: number;
  maxMinutes: number;
  origin: TaskOrigin;
  scheduleId: string | null;
  steps: { title: string; prompt: string | null; effect: Effect; verifier: Verifier | null }[];
}

export interface Schedule {
  id: string;
  title: string;
  goal: string;
  cwd: string;
  project: string;
  account: string | null;
  kind: ScheduleKind;
  everyMinutes: number | null;
  atMinute: number | null;
  tz: string;
  startAt: number | null;
  endAt: number | null;
  maxRuns: number | null;
  runs: number;
  catchUp: "once" | "skip";
  allowWrites: boolean;
  steps: StepSpec[];
  enabled: boolean;
  note: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastTaskId: string | null;
  createdAt: number;
  updatedAt: number;
}

const id = (prefix: string): string => `${prefix}_${randomBytes(8).toString("hex")}`;
const n = (v: unknown): number => Number(v);
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// ---------------------------------------------------------------------------------------------------- validation

type Obj = Record<string, unknown>;

function obj(value: unknown, field: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ValidationError(field, `${field} must be an object`);
  return value as Obj;
}

function words(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== "string") {
    if (!required && value === undefined) return "";
    throw new ValidationError(field, `${field} must be text`);
  }
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (required && clean === "") throw new ValidationError(field, `${field} cannot be empty`);
  if (clean.length > max) throw new ValidationError(field, `${field} is longer than ${max} characters`);
  const secret = looksSecret(clean);
  if (secret) throw new ValidationError(field, `${field} looks like it contains a ${secret}. Ancilla does not keep credentials.`);
  return clean;
}

function whole(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(field, `${field} must be a number`);
  const v = Math.round(value);
  if (v < min || v > max) throw new ValidationError(field, `${field} must be between ${min} and ${max}`);
  return v;
}

/** A path a check may read: inside the project, written with forward slashes, nothing that climbs out. */
export function projectPath(value: unknown, field: string): string {
  const raw = words(value, field, 300);
  if (/^([A-Za-z]:|\/|\\|~)/.test(raw) || raw.includes("\\") || raw.split("/").some((part) => part === ".." || part === "")) {
    throw new ValidationError(field, `${field} must be a path inside the project, like docs/NOTES.md`);
  }
  return raw;
}

export function parseVerifier(value: unknown, field: string): Verifier {
  const v = obj(value, field);
  if (v["type"] === "file_exists") return { type: "file_exists", path: projectPath(v["path"], `${field}.path`) };
  if (v["type"] === "file_contains") return { type: "file_contains", path: projectPath(v["path"], `${field}.path`), text: words(v["text"], `${field}.text`, 500) };
  if (v["type"] === "manual") return { type: "manual" };
  throw new ValidationError(field, `${field}.type must be file_exists, file_contains or manual`);
}

export function parseSteps(value: unknown, field: string, allowWrites: boolean): StepSpec[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) throw new ValidationError(field, `${field} must list between 1 and 12 steps`);
  return value.map((raw, i) => {
    const o = obj(raw, `${field}[${i}]`);
    const effect = o["effect"] === undefined ? (allowWrites ? "write" : "read") : o["effect"];
    if (effect !== "read" && effect !== "write") throw new ValidationError(`${field}[${i}].effect`, "effect must be read or write");
    if (effect === "write" && !allowWrites) throw new ValidationError(`${field}[${i}].effect`, "this task may not change anything: project writes are off for it");
    return {
      title: words(o["title"], `${field}[${i}].title`, 200),
      prompt: o["prompt"] === undefined || o["prompt"] === null ? null : words(o["prompt"], `${field}[${i}].prompt`, 4000),
      effect,
      verifier: o["verifier"] === undefined || o["verifier"] === null ? null : parseVerifier(o["verifier"], `${field}[${i}].verifier`),
    };
  });
}

export interface ParsedLimits {
  maxTurns: number;
  maxMinutes: number;
  allowWrites: boolean;
}

/** What a task may spend and do: its own ask, never more than the assistant's settings allow. */
export function taskLimits(raw: Obj, profile: AssistantProfile): ParsedLimits {
  const p = profile.policy;
  const maxTurns = raw["maxTurns"] === undefined ? p.maxTurnsPerTask : whole(raw["maxTurns"], "maxTurns", 1, 50);
  const maxMinutes = raw["maxMinutes"] === undefined ? p.maxMinutesPerTask : whole(raw["maxMinutes"], "maxMinutes", 1, 240);
  if (maxTurns > p.maxTurnsPerTask) throw new ValidationError("maxTurns", `the assistant's settings allow at most ${p.maxTurnsPerTask} turns for a task`);
  if (maxMinutes > p.maxMinutesPerTask) throw new ValidationError("maxMinutes", `the assistant's settings allow at most ${p.maxMinutesPerTask} minutes for a task`);
  const allowWrites = raw["allowWrites"] === undefined ? false : raw["allowWrites"] === true;
  if (raw["allowWrites"] !== undefined && typeof raw["allowWrites"] !== "boolean") throw new ValidationError("allowWrites", "allowWrites must be true or false");
  if (allowWrites && !p.allowProjectWrites) throw new ValidationError("allowWrites", "project writes are off in the assistant's settings");
  return { maxTurns, maxMinutes, allowWrites };
}

export function parseTaskSpec(rawInput: unknown, profile: AssistantProfile, project: (cwd: string) => string): NewTask {
  const raw = obj(rawInput, "task");
  const goal = words(raw["goal"], "goal", 2000);
  const cwd = words(raw["cwd"], "cwd", 1000);
  const limits = taskLimits(raw, profile);
  const steps = raw["steps"] === undefined ? [{ title: goal.length > 120 ? `${goal.slice(0, 117)}...` : goal, prompt: null, effect: limits.allowWrites ? "write" : "read", verifier: null } as StepSpec] : parseSteps(raw["steps"], "steps", limits.allowWrites);
  const account = raw["account"] === undefined || raw["account"] === null ? null : words(raw["account"], "account", 200);
  return {
    title: raw["title"] === undefined ? (goal.length > 80 ? `${goal.slice(0, 77)}...` : goal) : words(raw["title"], "title", 120),
    goal,
    goalId: typeof raw["goalId"] === "string" ? raw["goalId"].slice(0, 64) : null,
    cwd,
    project: project(cwd),
    account,
    ...limits,
    origin: "user",
    scheduleId: null,
    steps: steps.map((st) => ({ title: st.title, prompt: st.prompt ?? null, effect: st.effect ?? (limits.allowWrites ? "write" : "read"), verifier: st.verifier ?? null })),
  };
}

export interface NewSchedule {
  title: string;
  goal: string;
  cwd: string;
  project: string;
  account: string | null;
  kind: ScheduleKind;
  everyMinutes: number | null;
  atMinute: number | null;
  tz: string;
  startAt: number | null;
  endAt: number | null;
  maxRuns: number | null;
  catchUp: "once" | "skip";
  allowWrites: boolean;
  steps: StepSpec[];
}

/** A schedule must say when, in which time zone, and when it stops: work that repeats without an end is not bounded. */
export function parseScheduleSpec(rawInput: unknown, profile: AssistantProfile, project: (cwd: string) => string, now: number): NewSchedule {
  const raw = obj(rawInput, "schedule");
  const goal = words(raw["goal"], "goal", 2000);
  const kind = raw["kind"];
  if (kind !== "interval" && kind !== "daily" && kind !== "once") throw new ValidationError("kind", "kind must be interval, daily or once");
  const tz = typeof raw["tz"] === "string" ? raw["tz"] : "";
  if (!validZone(tz)) throw new ValidationError("tz", "a schedule needs its time zone, like America/Sao_Paulo or UTC");
  const startAt = raw["startAt"] === undefined || raw["startAt"] === null ? null : whole(raw["startAt"], "startAt", 1, 8.64e15);
  const endAt = raw["endAt"] === undefined || raw["endAt"] === null ? null : whole(raw["endAt"], "endAt", 1, 8.64e15);
  const maxRuns = raw["maxRuns"] === undefined || raw["maxRuns"] === null ? null : whole(raw["maxRuns"], "maxRuns", 1, SCHEDULE_LIMITS.maxRuns);
  if (kind !== "once" && endAt === null && maxRuns === null) throw new ValidationError("endAt", "a repeating schedule needs an end date (endAt) or a number of runs (maxRuns)");
  if (endAt !== null && endAt > now + SCHEDULE_LIMITS.maxHorizonDays * 86_400_000) throw new ValidationError("endAt", `a schedule may run for at most ${SCHEDULE_LIMITS.maxHorizonDays} days`);
  if (kind === "once" && startAt === null) throw new ValidationError("startAt", "a one-time schedule needs the moment it runs (startAt)");
  let everyMinutes: number | null = null;
  let atMinute: number | null = null;
  if (kind === "interval") everyMinutes = whole(raw["everyMinutes"], "everyMinutes", SCHEDULE_LIMITS.minIntervalMinutes, SCHEDULE_LIMITS.maxIntervalMinutes);
  if (kind === "daily") atMinute = whole(raw["atMinute"], "atMinute", 0, 1439);
  const limits = taskLimits(raw, profile);
  const catchUp = raw["catchUp"] === undefined ? "skip" : raw["catchUp"];
  if (catchUp !== "once" && catchUp !== "skip") throw new ValidationError("catchUp", "catchUp must be once or skip");
  const cwd = words(raw["cwd"], "cwd", 1000);
  const steps = raw["steps"] === undefined ? [] : parseSteps(raw["steps"], "steps", limits.allowWrites);
  return {
    title: raw["title"] === undefined ? (goal.length > 80 ? `${goal.slice(0, 77)}...` : goal) : words(raw["title"], "title", 120),
    goal, cwd, project: project(cwd),
    account: raw["account"] === undefined || raw["account"] === null ? null : words(raw["account"], "account", 200),
    kind, everyMinutes, atMinute, tz, startAt, endAt, maxRuns, catchUp, allowWrites: limits.allowWrites, steps,
  };
}

// ---------------------------------------------------------------------------------------------------- the store

function toStep(r: Row): TaskStep {
  return {
    id: String(r.id), taskId: String(r.task_id), ord: n(r.ord), title: String(r.title), prompt: s(r.prompt), effect: r.effect as Effect,
    verifier: r.verifier ? (JSON.parse(String(r.verifier)) as Verifier) : null, status: r.status as StepStatus, evidence: String(r.evidence), verified: n(r.verified) === 1,
    attempts: n(r.attempts), startedAt: nn(r.started_at), finishedAt: nn(r.finished_at),
  };
}

function toAttempt(r: Row): TaskAttempt {
  return {
    id: String(r.id), taskId: String(r.task_id), stepId: String(r.step_id), number: n(r.number), fence: n(r.fence), commandId: String(r.command_id), sessionId: s(r.session_id),
    turnId: s(r.turn_id), startedAt: n(r.started_at), endedAt: nn(r.ended_at), outcome: r.outcome as AttemptOutcome, detail: String(r.detail),
  };
}

function toSchedule(r: Row): Schedule {
  return {
    id: String(r.id), title: String(r.title), goal: String(r.goal), cwd: String(r.cwd), project: String(r.project), account: s(r.account), kind: r.kind as ScheduleKind,
    everyMinutes: nn(r.every_minutes), atMinute: nn(r.at_minute), tz: String(r.tz), startAt: nn(r.start_at), endAt: nn(r.end_at), maxRuns: nn(r.max_runs), runs: n(r.runs),
    catchUp: r.catch_up as "once" | "skip", allowWrites: n(r.allow_writes) === 1, steps: JSON.parse(String(r.steps)) as StepSpec[], enabled: n(r.enabled) === 1, note: String(r.note),
    nextRunAt: nn(r.next_run_at), lastRunAt: nn(r.last_run_at), lastTaskId: s(r.last_task_id), createdAt: n(r.created_at), updatedAt: n(r.updated_at),
  };
}

export class TaskStore {
  constructor(
    private readonly store: MemoryStore,
    private readonly now: () => number,
  ) {}

  private toTask(r: Row): Task {
    const counts = this.store.get("SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('done','skipped') THEN 1 ELSE 0 END) AS done FROM task_steps WHERE task_id = ?", [String(r.id)]);
    return {
      id: String(r.id), title: String(r.title), goal: String(r.goal), goalId: s(r.goal_id), status: r.status as TaskStatus, reason: String(r.reason), origin: r.origin as TaskOrigin,
      scheduleId: s(r.schedule_id), cwd: String(r.cwd), project: String(r.project), account: s(r.account), sessionId: s(r.session_id), allowWrites: n(r.allow_writes) === 1,
      maxTurns: n(r.max_turns), maxMinutes: n(r.max_minutes), turnsUsed: n(r.turns_used), fence: n(r.fence), retryAt: nn(r.retry_at), failures: n(r.failures),
      startedAt: nn(r.started_at), finishedAt: nn(r.finished_at), result: String(r.result), createdAt: n(r.created_at), updatedAt: n(r.updated_at),
      progress: { done: n(counts?.done ?? 0), total: n(counts?.total ?? 0) },
    };
  }

  create(spec: NewTask): Task {
    return this.store.write(() => {
      const now = this.now();
      const taskId = id("t");
      this.store.run(
        "INSERT INTO tasks (id, title, goal, goal_id, status, reason, origin, schedule_id, cwd, project, account, allow_writes, max_turns, max_minutes, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [taskId, spec.title, spec.goal, spec.goalId, "Waiting for its turn", spec.origin, spec.scheduleId, spec.cwd, spec.project, spec.account, spec.allowWrites ? 1 : 0, spec.maxTurns, spec.maxMinutes, now, now],
      );
      spec.steps.forEach((step, ord) => {
        this.store.run("INSERT INTO task_steps (id, task_id, ord, title, prompt, effect, verifier, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')", [id("st"), taskId, ord, step.title, step.prompt, step.effect, step.verifier ? JSON.stringify(step.verifier) : null]);
      });
      this.event(taskId, "created", null, `${spec.origin}: ${spec.steps.length} step${spec.steps.length === 1 ? "" : "s"}`);
      this.checkpoint(taskId);
      return this.get(taskId) as Task;
    });
  }

  get(taskId: string): Task | null {
    const row = this.store.get("SELECT * FROM tasks WHERE id = ?", [taskId]);
    return row ? this.toTask(row) : null;
  }

  require(taskId: string): Task {
    const task = this.get(taskId);
    if (!task) throw new NotFoundError("The task");
    return task;
  }

  list(filter: "active" | "done" | "all" = "all", limit = 100): Task[] {
    const where = filter === "active" ? "status NOT IN ('completed','unverified','failed','cancelled')" : filter === "done" ? "status IN ('completed','unverified','failed','cancelled')" : "1 = 1";
    // rowid breaks a tie in creation time: two tasks made in the same millisecond run in the order they were made.
    return this.store.all(`SELECT * FROM tasks WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ${Math.min(500, Math.max(1, Math.floor(limit)))}`).map((r) => this.toTask(r));
  }

  byStatus(statuses: readonly TaskStatus[]): Task[] {
    return this.store.all(`SELECT * FROM tasks WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at, rowid`, [...statuses]).map((r) => this.toTask(r));
  }

  count(statuses: readonly TaskStatus[]): number {
    return Number(this.store.get(`SELECT COUNT(*) AS c FROM tasks WHERE status IN (${statuses.map(() => "?").join(",")})`, [...statuses])?.c ?? 0);
  }

  countOrigin(origin: TaskOrigin, since: number): number {
    return Number(this.store.get("SELECT COUNT(*) AS c FROM tasks WHERE origin = ? AND created_at >= ?", [origin, since])?.c ?? 0);
  }

  startedSince(since: number): number {
    return Number(this.store.get("SELECT COUNT(*) AS c FROM tasks WHERE started_at IS NOT NULL AND started_at >= ?", [since])?.c ?? 0);
  }

  steps(taskId: string): TaskStep[] {
    return this.store.all("SELECT * FROM task_steps WHERE task_id = ? ORDER BY ord", [taskId]).map(toStep);
  }

  step(stepId: string): TaskStep | null {
    const row = this.store.get("SELECT * FROM task_steps WHERE id = ?", [stepId]);
    return row ? toStep(row) : null;
  }

  attempts(taskId: string): TaskAttempt[] {
    return this.store.all("SELECT * FROM task_attempts WHERE task_id = ? ORDER BY number", [taskId]).map(toAttempt);
  }

  attempt(attemptId: string): TaskAttempt | null {
    const row = this.store.get("SELECT * FROM task_attempts WHERE id = ?", [attemptId]);
    return row ? toAttempt(row) : null;
  }

  runningAttempt(taskId: string): TaskAttempt | null {
    const row = this.store.get("SELECT * FROM task_attempts WHERE task_id = ? AND outcome = 'running' ORDER BY number DESC LIMIT 1", [taskId]);
    return row ? toAttempt(row) : null;
  }

  /** The attempt a turn belongs to, whatever its state: a completion is matched to it by session and turn, never by guesswork. */
  attemptOfTurn(sessionId: string, turnId: string): TaskAttempt | null {
    const row = this.store.get("SELECT * FROM task_attempts WHERE session_id = ? AND turn_id = ? ORDER BY number DESC LIMIT 1", [sessionId, turnId]);
    return row ? toAttempt(row) : null;
  }

  /** Attempts that were started and have not reported a turn: the start may or may not have reached Muse. */
  unboundAttempts(): TaskAttempt[] {
    return this.store.all("SELECT * FROM task_attempts WHERE outcome = 'running' AND turn_id IS NULL ORDER BY number").map(toAttempt);
  }

  events(taskId: string, limit = 200): TaskEvent[] {
    return this.store.all("SELECT id, at, kind, attempt_id, detail FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?", [taskId, Math.min(1000, limit)]).map((r) => ({
      id: n(r.id), at: n(r.at), kind: String(r.kind), attemptId: s(r.attempt_id), detail: String(r.detail),
    })).reverse();
  }

  detail(taskId: string): TaskDetail {
    return { task: this.require(taskId), steps: this.steps(taskId), attempts: this.attempts(taskId), events: this.events(taskId) };
  }

  event(taskId: string, kind: string, attemptId: string | null, detail = ""): void {
    this.store.run("INSERT INTO task_events (task_id, at, kind, attempt_id, detail) VALUES (?, ?, ?, ?, ?)", [taskId, this.now(), kind, attemptId, detail.slice(0, 300)]);
  }

  /** The task as it stands, kept at every change of state: what a restart reads to know where it was. */
  checkpoint(taskId: string): void {
    const task = this.get(taskId);
    if (!task) return;
    const state = { status: task.status, reason: task.reason, fence: task.fence, turnsUsed: task.turnsUsed, steps: this.steps(taskId).map((st) => ({ id: st.id, status: st.status, attempts: st.attempts })), attempt: this.runningAttempt(taskId)?.id ?? null };
    this.store.run("INSERT INTO task_checkpoints (task_id, at, state) VALUES (?, ?, ?)", [taskId, this.now(), JSON.stringify(state)]);
    // Only the last few are of any use, and a task that retries for a day should not grow without bound.
    this.store.run("DELETE FROM task_checkpoints WHERE task_id = ? AND id NOT IN (SELECT id FROM task_checkpoints WHERE task_id = ? ORDER BY id DESC LIMIT 20)", [taskId, taskId]);
  }

  latestCheckpoint(taskId: string): { at: number; state: unknown } | null {
    const row = this.store.get("SELECT at, state FROM task_checkpoints WHERE task_id = ? ORDER BY id DESC LIMIT 1", [taskId]);
    return row ? { at: n(row.at), state: JSON.parse(String(row.state)) as unknown } : null;
  }

  setStatus(taskId: string, status: TaskStatus, reason: string, extra: { retryAt?: number | null; result?: string; failures?: number } = {}): Task {
    return this.store.write(() => {
      const task = this.require(taskId);
      const now = this.now();
      const finished = TERMINAL_TASK.has(status);
      this.store.run(
        "UPDATE tasks SET status = ?, reason = ?, retry_at = ?, result = ?, failures = ?, finished_at = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
        [status, reason.slice(0, 400), extra.retryAt ?? null, extra.result ?? task.result, extra.failures ?? task.failures, finished ? now : null, status === "running" ? now : null, now, taskId],
      );
      if (status !== task.status || reason !== task.reason) this.event(taskId, status, null, reason);
      this.checkpoint(taskId);
      return this.require(taskId);
    });
  }

  setSession(taskId: string, sessionId: string): void {
    this.store.write(() => this.store.run("UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?", [sessionId, this.now(), taskId]));
  }

  /** A turn that Muse never took was not spent. */
  refundTurn(taskId: string): void {
    this.store.write(() => this.store.run("UPDATE tasks SET turns_used = MAX(0, turns_used - 1), updated_at = ? WHERE id = ?", [this.now(), taskId]));
  }

  extendBudget(taskId: string, turns: number, minutes: number): void {
    this.store.write(() => {
      this.store.run("UPDATE tasks SET max_turns = max_turns + ?, max_minutes = max_minutes + ?, updated_at = ? WHERE id = ?", [turns, minutes, this.now(), taskId]);
      this.event(taskId, "extended", null, `${turns} turns, ${minutes} minutes`);
    });
  }

  updateStep(stepId: string, patch: { status?: StepStatus; evidence?: string; verified?: boolean }): void {
    this.store.write(() => {
      const step = this.step(stepId);
      if (!step) return;
      const now = this.now();
      const status = patch.status ?? step.status;
      this.store.run("UPDATE task_steps SET status = ?, evidence = ?, verified = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?", [
        status, (patch.evidence ?? step.evidence).slice(0, 400), (patch.verified ?? step.verified) ? 1 : 0, status === "running" ? now : null,
        ["done", "failed", "skipped", "cancelled", "unknown"].includes(status) ? now : null, stepId,
      ]);
    });
  }

  /** Starts an attempt in one transaction: the fence moves, the budget is charged, the step is marked, and the command id is fixed. */
  startAttempt(taskId: string, stepId: string): TaskAttempt {
    return this.store.write(() => {
      const task = this.require(taskId);
      const step = this.step(stepId);
      if (!step) throw new NotFoundError("The step");
      const fence = task.fence + 1;
      const attemptId = id("at");
      const now = this.now();
      this.store.run("UPDATE tasks SET fence = ?, turns_used = turns_used + 1, updated_at = ? WHERE id = ?", [fence, now, taskId]);
      this.store.run("UPDATE task_steps SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?), finished_at = NULL WHERE id = ?", [now, stepId]);
      this.store.run("INSERT INTO task_attempts (id, task_id, step_id, number, fence, command_id, session_id, started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')", [
        attemptId, taskId, stepId, fence, fence, `task:${taskId}:${fence}`, task.sessionId, now,
      ]);
      this.event(taskId, "attempt-started", attemptId, `step ${step.ord + 1}, attempt ${step.attempts + 1}`);
      return this.attempt(attemptId) as TaskAttempt;
    });
  }

  bindTurn(attemptId: string, sessionId: string, turnId: string): void {
    this.store.write(() => {
      this.store.run("UPDATE task_attempts SET session_id = ?, turn_id = ? WHERE id = ? AND outcome = 'running'", [sessionId, turnId, attemptId]);
      const a = this.attempt(attemptId);
      if (a) this.event(a.taskId, "turn-started", attemptId, turnId);
    });
  }

  finishAttempt(attemptId: string, outcome: Exclude<AttemptOutcome, "running">, detail: string): TaskAttempt | null {
    return this.store.write(() => {
      const before = this.attempt(attemptId);
      if (!before || before.outcome !== "running") return before;
      this.store.run("UPDATE task_attempts SET outcome = ?, detail = ?, ended_at = ? WHERE id = ?", [outcome, detail.slice(0, 300), this.now(), attemptId]);
      this.event(before.taskId, `attempt-${outcome}`, attemptId, detail);
      return this.attempt(attemptId);
    });
  }

  /** The time the task has actually run: its attempts' own durations, so a pause or a wait for the host is not charged. */
  elapsedMs(taskId: string): number {
    const now = this.now();
    let total = 0;
    for (const a of this.attempts(taskId)) total += (a.endedAt ?? now) - a.startedAt;
    return total;
  }

  // ------------------------------------------------------------------------------------------------ schedules

  createSchedule(spec: NewSchedule, now = this.now()): Schedule {
    return this.store.write(() => {
      const scheduleId = id("sc");
      const next = nextRun({ kind: spec.kind, everyMinutes: spec.everyMinutes, atMinute: spec.atMinute, tz: spec.tz, startAt: spec.startAt, endAt: spec.endAt, lastRunAt: null }, now);
      this.store.run(
        "INSERT INTO schedules (id, title, goal, cwd, project, account, kind, every_minutes, at_minute, tz, start_at, end_at, max_runs, catch_up, allow_writes, steps, enabled, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [scheduleId, spec.title, spec.goal, spec.cwd, spec.project, spec.account, spec.kind, spec.everyMinutes, spec.atMinute, spec.tz, spec.startAt, spec.endAt, spec.maxRuns, spec.catchUp, spec.allowWrites ? 1 : 0, JSON.stringify(spec.steps), next === null ? 0 : 1, next, now, now],
      );
      return this.schedule(scheduleId) as Schedule;
    });
  }

  schedule(scheduleId: string): Schedule | null {
    const row = this.store.get("SELECT * FROM schedules WHERE id = ?", [scheduleId]);
    return row ? toSchedule(row) : null;
  }

  schedules(): Schedule[] {
    return this.store.all("SELECT * FROM schedules ORDER BY enabled DESC, next_run_at, created_at").map(toSchedule);
  }

  dueSchedules(now: number): Schedule[] {
    return this.store.all("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at", [now]).map(toSchedule);
  }

  setScheduleEnabled(scheduleId: string, enabled: boolean, note = ""): Schedule {
    return this.store.write(() => {
      const sch = this.schedule(scheduleId);
      if (!sch) throw new NotFoundError("The schedule");
      const now = this.now();
      const next = enabled ? nextRun({ kind: sch.kind, everyMinutes: sch.everyMinutes, atMinute: sch.atMinute, tz: sch.tz, startAt: sch.startAt, endAt: sch.endAt, lastRunAt: sch.lastRunAt }, now) : sch.nextRunAt;
      if (enabled && next === null) throw new ConflictError("This schedule has no runs left.");
      this.store.run("UPDATE schedules SET enabled = ?, next_run_at = ?, note = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, next, note, now, scheduleId]);
      return this.schedule(scheduleId) as Schedule;
    });
  }

  removeSchedule(scheduleId: string): void {
    this.store.write(() => {
      if (!this.schedule(scheduleId)) throw new NotFoundError("The schedule");
      this.store.run("DELETE FROM schedules WHERE id = ?", [scheduleId]);
    });
  }

  /** A run happened (or was skipped): count it, move to the next moment, and end the schedule when it has no more. */
  advanceSchedule(sch: Schedule, now: number, ran: { taskId: string | null; at: number }): Schedule {
    return this.store.write(() => {
      const runs = sch.runs + (ran.taskId ? 1 : 0);
      const lastRunAt = ran.taskId ? ran.at : sch.lastRunAt;
      const exhausted = sch.maxRuns !== null && runs >= sch.maxRuns;
      const next = exhausted ? null : nextRun({ kind: sch.kind, everyMinutes: sch.everyMinutes, atMinute: sch.atMinute, tz: sch.tz, startAt: sch.startAt, endAt: sch.endAt, lastRunAt: ran.taskId ? ran.at : (sch.lastRunAt ?? sch.startAt) }, Math.max(now, ran.at));
      this.store.run("UPDATE schedules SET runs = ?, last_run_at = ?, last_task_id = ?, next_run_at = ?, enabled = ?, note = ?, updated_at = ? WHERE id = ?", [
        runs, lastRunAt, ran.taskId ?? sch.lastTaskId, next, next === null ? 0 : 1, next === null ? (exhausted ? "Finished: it ran as many times as it was allowed to." : "Finished: its end date has passed.") : sch.note, now, sch.id,
      ]);
      return this.schedule(sch.id) as Schedule;
    });
  }
}

// ---------------------------------------------------------------------------------------------------- the prompt

/** What a step says to Muse: the task, where it is, what it may do, and what to report. The memory block goes in front of it. */
export function stepPrompt(task: Pick<Task, "title" | "goal" | "allowWrites">, step: Pick<TaskStep, "title" | "prompt">, index: number, total: number): string {
  const lines = [
    "This is one step of a task the user approved in Ancilla's assistant. Work inside the project folder.",
    `Task: ${task.title}`,
    `Goal: ${task.goal}`,
    `Step ${index + 1} of ${total}: ${step.title}`,
  ];
  if (step.prompt) lines.push("", step.prompt);
  lines.push(
    "",
    task.allowWrites
      ? "You may change files in the project if the step needs it. Say which files you changed or created."
      : "Do not change anything: do not edit files and do not run commands that change state. Read, analyse and report.",
    "Finish with a short account of what you did and what you found, and name any file you created, so it can be checked.",
  );
  return lines.join("\n");
}

export interface FileRead {
  exists: boolean;
  text: string | null;
  size: number;
}

/** A deterministic check of one result, read from the project's own files. Never a model's opinion. */
export async function runVerifier(verifier: Verifier, read: (path: string) => Promise<FileRead>): Promise<{ ok: boolean; manual: boolean; evidence: string }> {
  if (verifier.type === "manual") return { ok: false, manual: true, evidence: "Waiting for you to confirm the result." };
  let file: FileRead;
  try {
    file = await read(verifier.path);
  } catch (error) {
    return { ok: false, manual: false, evidence: `${verifier.path} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (verifier.type === "file_exists") {
    return file.exists ? { ok: true, manual: false, evidence: `${verifier.path} exists (${file.size} bytes).` } : { ok: false, manual: false, evidence: `${verifier.path} was not found.` };
  }
  if (!file.exists) return { ok: false, manual: false, evidence: `${verifier.path} was not found.` };
  const quoted = verifier.text.length > 60 ? `${verifier.text.slice(0, 57)}...` : verifier.text;
  return file.text !== null && file.text.includes(verifier.text) ? { ok: true, manual: false, evidence: `${verifier.path} contains "${quoted}".` } : { ok: false, manual: false, evidence: `${verifier.path} does not contain "${quoted}".` };
}

export type { Param };
