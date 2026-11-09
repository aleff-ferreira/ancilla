import { useState } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import { errorMessage } from "../../client.js";
import type { AssistantProfileView, AssistantScheduleView, AssistantStepView, AssistantSuggestionView, AssistantTaskDetailView, AssistantTaskStatus, AssistantTaskView, AssistantVerifier } from "../../types.js";
import { Button, cn } from "../ui/primitives.js";
import { Row, Section } from "../settings/SettingsPage.js";
import { Toggle } from "../ui/primitives.js";
import { ago, useAssistantCall, useAssistantData } from "./api.js";
import { Chip, Notice } from "./parts.js";

const STATUS: Record<AssistantTaskStatus, { label: string; tone: "plain" | "ok" | "warn" | "danger" | "accent" }> = {
  queued: { label: "Queued", tone: "plain" },
  running: { label: "Running", tone: "accent" },
  waiting: { label: "Waiting", tone: "warn" },
  paused: { label: "Paused", tone: "warn" },
  blocked: { label: "Needs you", tone: "warn" },
  completed: { label: "Done, checked", tone: "ok" },
  unverified: { label: "Finished, not checked", tone: "warn" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "plain" },
};

const STEP_MARK: Record<AssistantStepView["status"], string> = { pending: "to do", running: "running", done: "done", failed: "failed", skipped: "left out", cancelled: "cancelled", unknown: "not known" };

/** The work: what it has been asked to do, what it would do next, and what is scheduled. */
export function TasksPanel(props: { profile: AssistantProfileView; changed: () => void; bump: number }) {
  const now = useNow(30_000);
  const tasks = useAssistantData<{ tasks: AssistantTaskView[] }>("/tasks?filter=all&limit=60", props.bump);
  const suggestions = useAssistantData<{ suggestions: AssistantSuggestionView[] }>("/suggestions", props.bump);
  const schedules = useAssistantData<{ schedules: AssistantScheduleView[] }>("/schedules", props.bump);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const active = tasks.data?.tasks.filter((t) => !["completed", "unverified", "failed", "cancelled"].includes(t.status)) ?? [];
  const past = tasks.data?.tasks.filter((t) => ["completed", "unverified", "failed", "cancelled"].includes(t.status)) ?? [];
  const p = props.profile;
  return (
    <div>
      <Section title="Work">
        <Row
          label="Give it a task"
          description={`It runs in a thread of its own that you can open, one step at a time, with at most ${p.policy.maxTurnsPerTask} turns and ${p.policy.maxMinutesPerTask} minutes each. It finishes as "done" only when something it can read confirms the result.`}
        >
          <Button size="sm" variant="secondary" onClick={() => setCreating((c) => !c)}>
            {creating ? "Close" : "New task"}
          </Button>
        </Row>
        {creating ? <NewTask profile={p} onDone={() => { setCreating(false); props.changed(); }} /> : null}
      </Section>

      {suggestions.data && suggestions.data.suggestions.length > 0 ? (
        <Section title={p.autonomy === "ask" ? "Waiting on you" : "What it would do next"}>
          {suggestions.data.suggestions.map((s) => (
            <Suggestion key={s.id} suggestion={s} autonomy={p.autonomy} changed={props.changed} />
          ))}
        </Section>
      ) : null}

      <Section title={`Open${active.length > 0 ? ` (${active.length})` : ""}`}>
        {tasks.error ? <div className="p-4"><Notice tone="error">{tasks.error}</Notice></div> : null}
        {tasks.data && active.length === 0 ? <p className="px-4 py-6 text-sm text-muted">No task is open.</p> : null}
        {active.map((t) => (
          <TaskRow key={t.id} task={t} now={now} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} changed={props.changed} bump={props.bump} />
        ))}
      </Section>

      {past.length > 0 ? (
        <Section title="Finished">
          {past.map((t) => (
            <TaskRow key={t.id} task={t} now={now} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} changed={props.changed} bump={props.bump} />
          ))}
        </Section>
      ) : null}

      <Schedules schedules={schedules.data?.schedules ?? []} changed={props.changed} profile={p} now={now} />
    </div>
  );
}

export function Suggestion(props: { suggestion: AssistantSuggestionView; autonomy: AssistantProfileView["autonomy"]; changed: () => void }) {
  const call = useAssistantCall();
  const controller = useController();
  const [error, setError] = useState<string | null>(null);
  const s = props.suggestion;
  const go = async (what: "accept" | "dismiss") => {
    setError(null);
    try {
      const out = await call<{ task?: AssistantTaskView }>("POST", `/suggestions/${what}`, { id: s.id });
      if (what === "accept" && s.action.type === "open-task" && out.task?.sessionId) controller.navigate({ kind: "thread", sessionId: out.task.sessionId });
      props.changed();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const label = s.action.type === "task" ? "Start it" : s.action.type === "confirm-memory" ? "Still true" : "Open";
  return (
    <div className="border-t border-line px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-fg [overflow-wrap:anywhere]">{s.title}</p>
          <p className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">{s.why}</p>
          {s.action.type === "task" ? <p className="mt-0.5 text-xs text-subtle">It would only read{props.autonomy === "act" && s.autonomous ? ", and it may start on its own" : ""}.</p> : null}
        </div>
        <div className="flex gap-2">
          <Button size="xs" variant="accent" onClick={() => void go("accept")}>
            {label}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => void go("dismiss")}>
            Not now
          </Button>
        </div>
      </div>
      {error ? <div className="mt-2"><Notice tone="error">{error}</Notice></div> : null}
    </div>
  );
}

type StepDraft = { title: string; check: "none" | "exists" | "contains" | "manual"; path: string; text: string };

function NewTask(props: { profile: AssistantProfileView; onDone: () => void }) {
  const call = useAssistantCall();
  const projects = useApp((s) => s.projects);
  const lastProject = useApp((s) => s.prefs.lastProject);
  const [goal, setGoal] = useState("");
  const [cwd, setCwd] = useState(lastProject ?? projects[0]?.cwd ?? "");
  const [writes, setWrites] = useState(false);
  const [turns, setTurns] = useState(props.profile.policy.maxTurnsPerTask);
  const [minutes, setMinutes] = useState(props.profile.policy.maxMinutesPerTask);
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const policy = props.profile.policy;

  const verifier = (s: StepDraft): AssistantVerifier | undefined =>
    s.check === "exists" ? { type: "file_exists", path: s.path.trim() } : s.check === "contains" ? { type: "file_contains", path: s.path.trim(), text: s.text } : s.check === "manual" ? { type: "manual" } : undefined;

  const submit = async () => {
    setError(null);
    try {
      await call("POST", "/tasks", {
        goal: goal.trim(),
        cwd,
        allowWrites: writes,
        maxTurns: turns,
        maxMinutes: minutes,
        ...(steps.length > 0 ? { steps: steps.map((s) => ({ title: s.title.trim() || goal.trim().slice(0, 100), effect: writes ? "write" : "read", ...(verifier(s) ? { verifier: verifier(s) } : {}) })) } : {}),
      });
      props.onDone();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="space-y-3 border-t border-line px-4 py-3">
      <textarea
        aria-label="What the task is"
        rows={3}
        value={goal}
        maxLength={2000}
        onChange={(e) => setGoal(e.currentTarget.value)}
        placeholder="Read the open issues and write docs/TRIAGE.md with the ten most urgent, newest first"
        className="w-full rounded-lg bg-sunken px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus"
      />
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <label className="flex items-center gap-2">
          In
          <select aria-label="Project" value={cwd} onChange={(e) => setCwd(e.currentTarget.value)} className="h-7 rounded-md bg-sunken px-2 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {projects.map((p) => (
              <option key={p.cwd} value={p.cwd}>
                {p.cwd}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2" title={policy.allowProjectWrites ? "" : "Project writes are off in this assistant's settings"}>
          <Toggle checked={writes} disabled={!policy.allowProjectWrites} label="May change files" onChange={setWrites} />
          May change files
        </label>
        <label className="flex items-center gap-1.5">
          Turns
          <input type="number" min={1} max={policy.maxTurnsPerTask} value={turns} onChange={(e) => setTurns(Number(e.currentTarget.value))} className="h-7 w-14 rounded-md bg-sunken px-2 text-right text-xs text-fg tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus" />
        </label>
        <label className="flex items-center gap-1.5">
          Minutes
          <input type="number" min={1} max={policy.maxMinutesPerTask} value={minutes} onChange={(e) => setMinutes(Number(e.currentTarget.value))} className="h-7 w-16 rounded-md bg-sunken px-2 text-right text-xs text-fg tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus" />
        </label>
      </div>
      {steps.map((s, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-sunken p-2">
          <input aria-label={`Step ${i + 1}`} value={s.title} placeholder={`Step ${i + 1}`} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, title: e.currentTarget.value } : x)))} className="h-7 min-w-40 flex-1 rounded-md bg-raised px-2 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
          <select aria-label={`Check for step ${i + 1}`} value={s.check} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, check: e.currentTarget.value as StepDraft["check"] } : x)))} className="h-7 rounded-md bg-raised px-2 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <option value="none">No check</option>
            <option value="exists">A file exists</option>
            <option value="contains">A file contains</option>
            <option value="manual">I will confirm</option>
          </select>
          {s.check === "exists" || s.check === "contains" ? <input aria-label="File in the project" value={s.path} placeholder="docs/TRIAGE.md" onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, path: e.currentTarget.value } : x)))} className="h-7 w-40 rounded-md bg-raised px-2 font-mono text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" /> : null}
          {s.check === "contains" ? <input aria-label="Text it must contain" value={s.text} placeholder="## Urgent" onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, text: e.currentTarget.value } : x)))} className="h-7 w-36 rounded-md bg-raised px-2 font-mono text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" /> : null}
          <Button size="xs" variant="ghost" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {steps.length < 8 ? (
          <Button size="sm" variant="ghost" onClick={() => setSteps([...steps, { title: "", check: "none", path: "", text: "" }])}>
            Add a step with a check
          </Button>
        ) : null}
        <Button size="sm" variant="accent" disabled={goal.trim().length < 3 || !cwd} onClick={() => void submit()}>
          Start the task
        </Button>
        <span className="text-xs text-subtle">Without steps it is one turn, finished as &quot;not checked&quot; unless you add a check.</span>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

function TaskRow(props: { task: AssistantTaskView; now: number; open: boolean; onToggle: () => void; changed: () => void; bump: number }) {
  const { task } = props;
  const call = useAssistantCall();
  const controller = useController();
  const [error, setError] = useState<string | null>(null);
  // A change the voice proposed that nobody approved yet: paused and never started, it runs only when it is approved here.
  const proposal = task.origin === "voice" && task.status === "paused" && task.startedAt === null;
  const status = proposal ? { label: "Needs your approval", tone: "warn" as const } : STATUS[task.status];
  const act = async (name: string, body: Record<string, unknown> = {}) => {
    setError(null);
    try {
      await call("POST", `/tasks/${encodeURIComponent(task.id)}/${name}`, body);
      props.changed();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const budgetStop = task.status === "blocked" && /budget/i.test(task.reason);
  const open = task.status === "running" || task.status === "queued" || task.status === "waiting";
  return (
    <div className="border-t border-line first:border-t-0">
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <button type="button" aria-expanded={props.open} onClick={props.onToggle} className="min-w-0 flex-1 text-left">
          <span className="flex flex-wrap items-center gap-2">
            <Chip tone={status.tone}>{status.label}</Chip>
            <span className="text-sm text-fg [overflow-wrap:anywhere]">{task.title}</span>
            {task.origin !== "user" ? <Chip>{task.origin === "schedule" ? "Scheduled" : task.origin === "voice" ? "Proposed by voice" : "Suggested"}</Chip> : null}
          </span>
          {proposal && task.goal !== task.title ? <span className="mt-1 block text-xs text-fg [overflow-wrap:anywhere]">{task.goal}</span> : null}
          <span className="mt-1 block text-xs text-muted [overflow-wrap:anywhere]">{task.reason || task.result}</span>
          <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-subtle">
            <span>
              {task.progress.done} of {task.progress.total} step{task.progress.total === 1 ? "" : "s"}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {task.turnsUsed} of {task.maxTurns} turns
            </span>
            <span aria-hidden="true">·</span>
            <span>{task.allowWrites ? "may change files" : "reads only"}</span>
            {task.status === "waiting" && task.retryAt ? <span>· tries again {ago(task.retryAt, props.now)}</span> : null}
          </span>
        </button>
        <div className="flex flex-wrap gap-2">
          {task.sessionId ? (
            <Button size="xs" variant="ghost" onClick={() => controller.navigate({ kind: "thread", sessionId: task.sessionId as string })}>
              Open thread
            </Button>
          ) : null}
          {open ? <Button size="xs" variant="secondary" onClick={() => void act("pause")}>Pause</Button> : null}
          {proposal ? <Button size="xs" variant="accent" onClick={() => void act("approve")}>Approve</Button> : null}
          {!proposal && (task.status === "paused" || task.status === "waiting") ? <Button size="xs" variant="accent" onClick={() => void act("resume")}>Resume</Button> : null}
          {budgetStop ? <Button size="xs" variant="accent" onClick={() => void act("extend", { turns: 4, minutes: 10 })}>Give it more room</Button> : null}
          {task.status === "failed" || (task.status === "blocked" && !budgetStop) ? <Button size="xs" variant="secondary" onClick={() => void act("retry")}>Try again</Button> : null}
          {task.status === "unverified" || (task.status === "blocked" && /confirm/i.test(task.reason)) ? <Button size="xs" variant="accent" onClick={() => void act("confirm")}>It is right</Button> : null}
          {!["completed", "unverified", "failed", "cancelled"].includes(task.status) ? <Button size="xs" variant="danger" onClick={() => void act("cancel")}>{proposal ? "Decline" : "Cancel"}</Button> : null}
        </div>
      </div>
      {error ? <div className="px-4 pb-3"><Notice tone="error">{error}</Notice></div> : null}
      {props.open ? <TaskDetail id={task.id} now={props.now} changed={props.changed} bump={props.bump} /> : null}
    </div>
  );
}

function TaskDetail(props: { id: string; now: number; changed: () => void; bump: number }) {
  const call = useAssistantCall();
  const detail = useAssistantData<AssistantTaskDetailView>(`/tasks/${encodeURIComponent(props.id)}`, props.bump);
  const [error, setError] = useState<string | null>(null);
  const d = detail.data;
  if (!d) return <p className="px-4 pb-4 text-xs text-subtle">{detail.error ?? "Loading..."}</p>;
  const resolve = async (stepId: string, resolution: "done" | "retry" | "skip") => {
    setError(null);
    try {
      await call("POST", `/tasks/${encodeURIComponent(props.id)}/resolve`, { stepId, resolution });
      props.changed();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="space-y-3 px-4 pb-4">
      <ol className="space-y-2">
        {d.steps.map((s) => (
          <li key={s.id} className="rounded-lg bg-sunken px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums text-muted">{s.ord + 1}.</span>
              <span className="min-w-0 flex-1 text-sm text-fg [overflow-wrap:anywhere]">{s.title}</span>
              <Chip tone={s.status === "done" ? (s.verified ? "ok" : "plain") : s.status === "failed" || s.status === "unknown" ? "danger" : s.status === "running" ? "accent" : "plain"}>{s.status === "done" && s.verified ? "done, checked" : STEP_MARK[s.status]}</Chip>
              {s.effect === "write" ? <Chip title="Can change files, so it is never run twice on a guess">may change files</Chip> : null}
            </div>
            {s.verifier ? <p className="mt-1 text-muted">Check: {s.verifier.type === "file_exists" ? `${s.verifier.path} exists` : s.verifier.type === "file_contains" ? `${s.verifier.path} contains "${s.verifier.text}"` : "you confirm it"}</p> : null}
            {s.evidence ? <p className="mt-1 text-muted [overflow-wrap:anywhere]">{s.evidence}</p> : null}
            {s.status === "unknown" || s.status === "failed" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {s.status === "unknown" ? <Button size="xs" variant="secondary" onClick={() => void resolve(s.id, "done")}>It ran</Button> : null}
                <Button size="xs" variant="secondary" onClick={() => void resolve(s.id, "retry")}>Run it again</Button>
                <Button size="xs" variant="ghost" onClick={() => void resolve(s.id, "skip")}>Leave it out</Button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">What happened, in order</summary>
        <ul className="mt-2 space-y-1">
          {d.events.map((e) => (
            <li key={e.id} className={cn("flex gap-3 text-muted", e.kind.includes("refused") && "text-warn-text")}>
              <span className="w-24 shrink-0 tabular-nums">{ago(e.at, props.now)}</span>
              <span className="text-fg">{e.kind.replace(/-/g, " ")}</span>
              {e.detail ? <span className="min-w-0 [overflow-wrap:anywhere]">{e.detail}</span> : null}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function Schedules(props: { schedules: AssistantScheduleView[]; changed: () => void; profile: AssistantProfileView; now: number }) {
  const call = useAssistantCall();
  const projects = useApp((s) => s.projects);
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [cwd, setCwd] = useState(projects[0]?.cwd ?? "");
  const [kind, setKind] = useState<"daily" | "interval">("daily");
  const [time, setTime] = useState("09:00");
  const [every, setEvery] = useState(60);
  const [runs, setRuns] = useState(30);
  const [tz, setTz] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setError(null);
    const [h, m] = time.split(":").map(Number);
    try {
      await call("POST", "/schedules", { goal: goal.trim(), cwd, kind, tz, maxRuns: runs, ...(kind === "daily" ? { atMinute: (h ?? 0) * 60 + (m ?? 0) } : { everyMinutes: every }) });
      setOpen(false);
      setGoal("");
      props.changed();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const describe = (s: AssistantScheduleView): string => `${s.kind === "daily" ? `every day at ${String(Math.floor((s.atMinute ?? 0) / 60)).padStart(2, "0")}:${String((s.atMinute ?? 0) % 60).padStart(2, "0")} (${s.tz})` : s.kind === "interval" ? `every ${s.everyMinutes} minutes` : "once"}, ${s.maxRuns !== null ? `${s.runs} of ${s.maxRuns} runs` : s.endAt ? `until ${new Date(s.endAt).toISOString().slice(0, 10)}` : ""}`;
  return (
    <Section title="Repeating">
      {props.schedules.map((s) => (
        <div key={s.id} className="flex flex-wrap items-start gap-3 border-t border-line px-4 py-3 first:border-t-0">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg [overflow-wrap:anywhere]">{s.title}</p>
            <p className="mt-0.5 text-xs text-muted">{describe(s)}</p>
            <p className="mt-0.5 text-xs text-subtle">{s.enabled && s.nextRunAt ? `Next ${ago(s.nextRunAt, props.now)}` : s.note || "Not running"}</p>
          </div>
          <div className="flex gap-2">
            <Button size="xs" variant="secondary" onClick={() => void call("POST", `/schedules/${encodeURIComponent(s.id)}/${s.enabled ? "disable" : "enable"}`, {}).then(props.changed, () => undefined)}>
              {s.enabled ? "Pause" : "Resume"}
            </Button>
            <Button size="xs" variant="danger" onClick={() => void call("DELETE", `/schedules/${encodeURIComponent(s.id)}`).then(props.changed, () => undefined)}>
              Remove
            </Button>
          </div>
        </div>
      ))}
      <Row label="Run something on a schedule" description="It needs its time zone and a number of runs, so repeating work always ends. A run that was missed while Ancilla was closed is skipped, and a run is skipped while the last one is still going.">
        <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : "New schedule"}
        </Button>
      </Row>
      {open ? (
        <div className="space-y-3 border-t border-line px-4 py-3">
          <textarea aria-label="What to run" rows={2} value={goal} onChange={(e) => setGoal(e.currentTarget.value)} placeholder="Read last night's CI run and report what failed" className="w-full rounded-lg bg-sunken px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus" />
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            <select aria-label="Project" value={cwd} onChange={(e) => setCwd(e.currentTarget.value)} className="h-7 rounded-md bg-sunken px-2 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus">
              {projects.map((p) => (
                <option key={p.cwd} value={p.cwd}>
                  {p.cwd}
                </option>
              ))}
            </select>
            <select aria-label="How often" value={kind} onChange={(e) => setKind(e.currentTarget.value as "daily" | "interval")} className="h-7 rounded-md bg-sunken px-2 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus">
              <option value="daily">Every day</option>
              <option value="interval">Every so often</option>
            </select>
            {kind === "daily" ? <input aria-label="Time of day" type="time" value={time} onChange={(e) => setTime(e.currentTarget.value)} className="h-7 rounded-md bg-sunken px-2 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" /> : <label className="flex items-center gap-1.5">every <input type="number" min={15} value={every} onChange={(e) => setEvery(Number(e.currentTarget.value))} className="h-7 w-16 rounded-md bg-sunken px-2 text-right text-xs text-fg tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus" /> minutes</label>}
            <label className="flex items-center gap-1.5">
              time zone <input aria-label="Time zone" value={tz} onChange={(e) => setTz(e.currentTarget.value)} className="h-7 w-40 rounded-md bg-sunken px-2 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
            </label>
            <label className="flex items-center gap-1.5">
              ends after <input type="number" min={1} max={365} value={runs} onChange={(e) => setRuns(Number(e.currentTarget.value))} className="h-7 w-14 rounded-md bg-sunken px-2 text-right text-xs text-fg tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus" /> runs
            </label>
          </div>
          <Button size="sm" variant="accent" disabled={goal.trim().length < 3 || !cwd} onClick={() => void create()}>
            Create the schedule
          </Button>
          {error ? <Notice tone="error">{error}</Notice> : null}
        </div>
      ) : null}
    </Section>
  );
}
