import { AmbiguousStartError, Executive } from "../executive.js";
import { MemoryStore } from "../store.js";
import { parseTaskSpec, TaskStore, TERMINAL_TASK, type Task, type TaskStatus } from "../tasks.js";
import { FakeHost, flush } from "./fakeHost.js";
import { pick, rng } from "./scenario.js";

/**
 * Faults thrown at the executive at random, in seeded sequences: turns that fail, are interrupted, report twice or
 * late, hosts that vanish and come back, starts that are refused or that may or may not have reached Muse, restarts
 * at any point with a ledger that knows or does not know how the turn ended, cancels, pauses and the user's own
 * answers. After every operation the invariants that make the executive safe to leave running are checked.
 */

export interface FuzzResult {
  runs: number;
  operations: number;
  /** A step that may change things was started again without the user saying so. */
  duplicateEffects: number;
  /** A report that was not the current attempt's changed a task: a finished task or step moved. */
  staleAccepted: number;
  /** A task was left running after it was cancelled. */
  runningAfterCancel: number;
  /** A task spent more turns than it was allowed. */
  budgetExceeded: number;
  /** After a restart, a task in a state that does not say what it is waiting for. */
  undefinedAfterRestart: number;
  /** A task said it was completed without every check having passed. */
  falseCompletions: number;
  /** Anything else that broke (two attempts running at once, a repeated command id, a fence that went back). */
  other: number;
  examples: string[];
}

const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const MIN = 60_000;

export async function fuzzExecutive(seeds: number, operations = 45): Promise<FuzzResult> {
  const out: FuzzResult = { runs: 0, operations: 0, duplicateEffects: 0, staleAccepted: 0, runningAfterCancel: 0, budgetExceeded: 0, undefinedAfterRestart: 0, falseCompletions: 0, other: 0, examples: [] };
  for (let seed = 1; seed <= seeds; seed += 1) {
    await runOne(seed, operations, out);
    out.runs += 1;
  }
  return out;
}

async function runOne(seed: number, operations: number, out: FuzzResult): Promise<void> {
  const next = rng(seed * 7919);
  const clock = { t: T0 };
  const store = MemoryStore.open(":memory:", { now: () => clock.t });
  store.saveProfile({ enabled: true, policy: { allowProjectWrites: true, maxConcurrent: 2, maxTurnsPerTask: 6, maxMinutesPerTask: 20, maxTasksPerDay: 100 } });
  const tasks = new TaskStore(store, () => clock.t);
  let generation = 0;
  let host = new FakeHost(clock, "g0-");
  const make = (h: FakeHost): Executive => new Executive(tasks, h, { profile: () => store.getProfile(), memory: () => null, changed: () => undefined });
  let exec = make(host);
  const finishedTurns: { sessionId: string; turnId: string }[] = [];
  const statusSeen = new Map<string, TaskStatus>();
  const retriesSeen = new Map<string, number>();
  const stepSeen = new Map<string, string>();
  const cancelled = new Set<string>();
  let fileCounter = 0;

  const note = (kind: keyof FuzzResult, message: string): void => {
    (out[kind] as number) += 1;
    if (out.examples.length < 8) out.examples.push(`seed ${seed}: ${message}`);
  };

  const check = (afterRestart: boolean): void => {
    for (const t of tasks.list("all", 500)) {
      const attempts = tasks.attempts(t.id);
      if (attempts.filter((a) => a.outcome === "running").length > 1) note("other", `two running attempts on ${t.id}`);
      const fences = attempts.map((a) => a.fence);
      if (fences.some((f, i) => i > 0 && f <= (fences[i - 1] as number))) note("other", `a fence did not grow on ${t.id}`);
      if (new Set(attempts.map((a) => a.commandId)).size !== attempts.length) note("other", `a command id repeated on ${t.id}`);
      const before = statusSeen.get(t.id);
      const retries = tasks.events(t.id, 1000).filter((e) => e.kind === "retried").length;
      if (before && before !== t.status) {
        // Finished is final, except for what the user does: a failed task is tried again when they say so, and a task
        // that finished unchecked is confirmed. A report from a turn does neither.
        if (before === "completed" || before === "cancelled") note("staleAccepted", `a ${before} task became ${t.status}`);
        else if (before === "failed" && retries <= (retriesSeen.get(t.id) ?? 0)) note("staleAccepted", `a failed task became ${t.status} without being asked to`);
        else if (before === "unverified" && t.status !== "completed") note("staleAccepted", `an unverified task became ${t.status}`);
      }
      statusSeen.set(t.id, t.status);
      retriesSeen.set(t.id, retries);
      if (cancelled.has(t.id) && (t.status !== "cancelled" || attempts.some((a) => a.outcome === "running"))) note("runningAfterCancel", `${t.id} is ${t.status} after a cancel`);
      if (t.turnsUsed > t.maxTurns) note("budgetExceeded", `${t.id} used ${t.turnsUsed} of ${t.maxTurns} turns`);
      const steps = tasks.steps(t.id);
      for (const st of steps) {
        const was = stepSeen.get(st.id);
        if (was === "done" && st.status !== "done") note("staleAccepted", `a done step became ${st.status}`);
        stepSeen.set(st.id, st.status);
      }
      if (t.status === "completed") {
        const checks = steps.filter((s) => s.verifier);
        if (checks.length === 0 || checks.some((s) => !s.verified)) note("falseCompletions", `${t.id} completed with ${checks.filter((s) => s.verified).length} of ${checks.length} checks passed`);
      }
      if (afterRestart && (t.status === "running") && !attempts.some((a) => a.outcome === "running")) {
        // Running with nothing running is only a moment between steps; after a flush it must have moved on.
        note("undefinedAfterRestart", `${t.id} is running with no turn`);
      }
      if (afterRestart && t.status === "blocked" && t.reason.trim() === "") note("undefinedAfterRestart", `${t.id} is blocked and does not say why`);
      // A step that may change things is never started again on a guess: the user must have said so in between.
      const events = tasks.events(t.id, 1000);
      for (const st of steps) {
        if (st.effect !== "write") continue;
        const mine = attempts.filter((a) => a.stepId === st.id);
        for (let i = 1; i < mine.length; i += 1) {
          const a = mine[i - 1] as (typeof mine)[number];
          const b = mine[i] as (typeof mine)[number];
          const uncertain = a.outcome === "unknown" || a.outcome === "running" || a.outcome === "cancelled" || a.outcome === "timeout" || (a.outcome === "failed" && a.turnId !== null);
          if (!uncertain) continue;
          const startedB = events.find((e) => e.kind === "attempt-started" && e.attemptId === b.id);
          const startedA = events.find((e) => e.kind === "attempt-started" && e.attemptId === a.id);
          const said = events.some((e) => (e.kind === "resolved" || e.kind === "retried") && startedA && startedB && e.id > startedA.id && e.id < startedB.id);
          if (!said) note("duplicateEffects", `step ${st.ord + 1} of ${t.id} was started again after attempt ${a.number} ended ${a.outcome}`);
        }
      }
    }
  };

  const tick = async (): Promise<void> => {
    await exec.tick();
    await flush();
  };

  const openTasks = (): Task[] => tasks.list("active", 50);

  for (let step = 0; step < operations; step += 1) {
    out.operations += 1;
    let restarted = false;
    const roll = next();
    try {
      if (roll < 0.12 || openTasks().length === 0) {
        const n = 1 + Math.floor(next() * 3);
        const writes = next() < 0.6;
        const steps = Array.from({ length: n }, (_, i) => ({
          title: `step ${i + 1}`,
          effect: writes && next() < 0.7 ? ("write" as const) : ("read" as const),
          ...(next() < 0.5 ? { verifier: { type: "file_exists" as const, path: `out-${seed}-${++fileCounter}.txt` } } : {}),
        }));
        exec.create(parseTaskSpec({ goal: `task ${step} of run ${seed}`, cwd: "/work/atlas", allowWrites: writes, steps, maxTurns: 6, maxMinutes: 20 }, store.getProfile(), (c) => c));
        await flush();
      } else if (roll < 0.34) {
        // A running turn ends, one way or another.
        const live = host.turns.filter((t) => host.ledger.get(`${t.sessionId}:${t.turnId}`) === "running");
        const turn = live.length > 0 ? pick(next, live) : null;
        if (turn) {
          const r = next();
          host.finish(turn.turnId, r < 0.62 ? "completed" : r < 0.85 ? "failed" : "interrupted", r >= 0.62 && r < 0.85 ? "scripted failure" : undefined);
          finishedTurns.push({ sessionId: turn.sessionId, turnId: turn.turnId });
          // A file for a check, sometimes.
          for (const t of tasks.list("all", 100)) for (const st of tasks.steps(t.id)) if (st.verifier?.type === "file_exists" && next() < 0.6) host.files.set(st.verifier.path, "x");
          await flush();
        }
      } else if (roll < 0.42 && finishedTurns.length > 0) {
        // A report that comes again, or late, from a turn that is over.
        const old = pick(next, finishedTurns);
        host.fire(old.sessionId, "turn/completed", { turnId: old.turnId, terminal: next() < 0.5 ? "completed" : "failed" });
        await flush();
      } else if (roll < 0.5) {
        const t = openTasks();
        if (t.length > 0) {
          const target = pick(next, t);
          await exec.cancel(target.id);
          cancelled.add(target.id);
          await flush();
        }
      } else if (roll < 0.58) {
        const t = openTasks();
        if (t.length > 0) {
          const target = pick(next, t);
          if (next() < 0.5) {
            if (target.status !== "paused") exec.pause(target.id);
          } else if (target.status === "paused" || target.status === "waiting") exec.resume(target.id);
          await flush();
        }
      } else if (roll < 0.66) {
        // The user's answers: try again, say a step ran, leave it out, give it more room.
        const t = tasks.list("all", 200).filter((x) => x.status === "blocked" || x.status === "failed");
        if (t.length > 0) {
          const target = pick(next, t);
          const hurt = tasks.steps(target.id).find((s) => s.status === "unknown" || s.status === "failed");
          const r = next();
          if (hurt && r < 0.4) exec.resolve(target.id, hurt.id, pick(next, ["done", "retry", "skip"] as const));
          else if (r < 0.8) exec.retry(target.id);
          else if (!TERMINAL_TASK.has(target.status)) exec.extend(target.id, 2, 5);
          await flush();
        }
      } else if (roll < 0.74) {
        const r = next();
        host.reachable = r < 0.5 ? { ok: false, reason: "scripted outage" } : { ok: true };
        host.startError = r < 0.2 ? new Error("scripted refusal") : r < 0.3 ? new AmbiguousStartError("scripted ambiguity") : null;
        await tick();
      } else if (roll < 0.9) {
        clock.t += Math.floor(next() * 25) * MIN;
        await tick();
      } else {
        // A restart, at any point. The ledger of the turns in the air is what the boot sweep and the feed left it as.
        exec.close();
        const inFlight = host.turns.filter((t) => host.ledger.get(`${t.sessionId}:${t.turnId}`) === "running");
        generation += 1;
        const next2 = new FakeHost(clock, `g${generation}-`);
        for (const t of inFlight) {
          const r = next();
          next2.ledger.set(`${t.sessionId}:${t.turnId}`, r < 0.7 ? "unknown" : r < 0.85 ? "completed" : "failed");
        }
        for (const [k, v] of host.ledger) if (!next2.ledger.has(k)) next2.ledger.set(k, v);
        next2.files = host.files;
        host = next2;
        exec = make(host);
        await exec.recover();
        await flush();
        restarted = true;
      }
    } catch (error) {
      // The executive refusing a user's request (nothing to resume, a finished task) is its job; anything else is not.
      const message = error instanceof Error ? error.message : String(error);
      if (!/finished|Only a|nothing here|not waiting|no longer|already|open tasks|switched off|extend by|at most twice|could not be found|was not found/i.test(message)) note("other", `an operation threw: ${message}`);
    }
    check(restarted);
  }
  exec.close();
  store.close();
}
