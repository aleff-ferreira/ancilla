import { useEffect, useMemo, useState } from "react";
import { useApp, useController } from "../../app/context.js";
import { errorMessage } from "../../client.js";
import { providerBadgeName, type ModelsScope } from "../../model/models.js";
import type { AssistantAutonomy, AssistantGoalView, AssistantProfileView, ProviderId } from "../../types.js";
import { Button, Toggle } from "../ui/primitives.js";
import { ModelPick, Num, Pick, Row, Section, buildProviderAccountOptions } from "../settings/SettingsPage.js";
import { useAssistantCall, useAssistantData } from "./api.js";
import { Chip, Notice } from "./parts.js";

const AUTONOMY: { value: AssistantAutonomy; label: string; hint: string }[] = [
  { value: "ask", label: "Ask first", hint: "Starts nothing. Only says what is waiting on you." },
  { value: "suggest", label: "Suggest", hint: "Lists the work it could do, with why. You start it." },
  { value: "act", label: "Act within limits", hint: "Starts work that only reads and rests on something you said in a project, a couple a day at most." },
];

/** What the assistant is working toward, what it may do on its own, and how much it may spend. Who it is lives in the Persona tab. */
export function ProfilePanel(props: { profile: AssistantProfileView; changed: () => void; bump: number }) {
  const controller = useController();
  const accounts = useApp((s) => s.accounts);
  const providers = useApp((s) => s.providers);

  useEffect(() => {
    if (typeof controller.loadAccounts === "function") {
      void controller.loadAccounts();
    }
    if (typeof controller.loadProviders === "function") {
      void controller.loadProviders();
    }
  }, [controller]);

  const call = useAssistantCall();
  const [error, setError] = useState<string | null>(null);
  const p = props.profile;

  const currentTaskKey = useMemo(() => {
    const m = p.model;
    if (!m || m.providerId === null) return "project";
    return `${m.providerId}::${m.accountId ?? ""}`;
  }, [p.model]);

  const [localTaskKey, setLocalTaskKey] = useState<string | null>(null);
  const taskKey = localTaskKey ?? currentTaskKey;

  useEffect(() => {
    setLocalTaskKey(null);
  }, [p.model]);

  const taskScope = useMemo<ModelsScope>(() => {
    if (taskKey === "project") return {};
    const sep = taskKey.indexOf("::");
    const providerId = (sep >= 0 ? taskKey.slice(0, sep) : "muse") as ProviderId;
    const accountId = sep >= 0 ? taskKey.slice(sep + 2) || null : null;
    return { providerId, accountId };
  }, [taskKey]);

  const taskProviderOptions = useMemo(() => {
    const list = buildProviderAccountOptions(accounts, providers, {
      includeFollowProject: true,
      defaultMuseLabel: "Meta Muse",
    });
    if (taskKey !== "project" && !list.some((o) => o.value === taskKey)) {
      const sep = taskKey.indexOf("::");
      const providerId = sep >= 0 ? taskKey.slice(0, sep) : taskKey;
      const accountId = sep >= 0 ? taskKey.slice(sep + 2) : "";
      const label = accountId
        ? `${providerBadgeName(providerId as ProviderId)} · ${accountId}`
        : providerBadgeName(providerId as ProviderId);
      list.push({ value: taskKey, label, hint: "Configured model provider" });
    }
    return list;
  }, [accounts, providers, taskKey]);

  const save = async (patch: Record<string, unknown>) => {
    setError(null);
    try {
      await call("PATCH", "/profile", { ...patch, expectedUpdatedAt: p.updatedAt });
      props.changed();
    } catch (e) {
      setError(errorMessage(e));
      props.changed();
    }
  };

  const handleTaskProviderChange = async (key: string) => {
    setLocalTaskKey(key);
    try {
      if (key === "project") {
        await save({
          model: {
            providerId: null,
            accountId: null,
            modelId: null,
          },
        });
      } else {
        const sep = key.indexOf("::");
        const providerId = (sep >= 0 ? key.slice(0, sep) : "muse") as ProviderId;
        const accountId = sep >= 0 ? key.slice(sep + 2) || null : null;
        await save({
          model: {
            providerId,
            accountId,
            modelId: null,
          },
        });
      }
    } finally {
      setLocalTaskKey(null);
    }
  };

  return (
    <div>
      {error ? <div className="mt-6"><Notice tone="error">{error}</Notice></div> : null}

      <Section title="Model for assistant tasks">
        <Row
          label="Task provider & account"
          description="Which subscription, provider, or API endpoint the assistant uses to run background tasks and research. Follow project uses whichever model the open thread or project uses."
        >
          <Pick
            wrap
            value={taskKey}
            options={taskProviderOptions}
            onChange={handleTaskProviderChange}
          />
        </Row>
        {taskKey !== "project" ? (
          <Row
            label="Task model"
            description="Which model the assistant uses to run autonomous tasks and research."
          >
            <ModelPick
              full
              scope={taskScope}
              value={p.model?.modelId ?? null}
              museDefault={false}
              onChange={(modelId) => {
                const providerId = taskScope.providerId ?? "muse";
                const accountId = taskScope.accountId ?? null;
                void save({ model: { providerId, accountId, modelId } });
              }}
              onTyped={async (modelId) => {
                const providerId = taskScope.providerId ?? "muse";
                const accountId = taskScope.accountId ?? null;
                await save({ model: { providerId, accountId, modelId } });
                return true;
              }}
            />
          </Row>
        ) : null}
      </Section>

      <Goals bump={props.bump} changed={props.changed} />

      <Section title="What it may do on its own">
        <Row label="Initiative" description="Memory never grants permission: this setting does.">
          <Pick<AssistantAutonomy> value={p.autonomy} options={AUTONOMY} onChange={(autonomy) => void save({ autonomy })} />
        </Row>
        <Row label="Start read-only work on its own" description="Used by Act within limits: it may then start tasks that only read and report. Off, it lists them and you start them.">
          <Toggle checked={p.policy.allowReadOnly} label="Start read-only work on its own" onChange={(on) => void save({ policy: { allowReadOnly: on } })} />
        </Row>
        <Row label="Allow a task to change files" description="Off, no task can be given write access, whatever it asks. On, you still choose per task, and the thread&apos;s own approvals still reach you.">
          <Toggle checked={p.policy.allowProjectWrites} label="Allow a task to change files" onChange={(on) => void save({ policy: { allowProjectWrites: on } })} />
        </Row>
      </Section>

      <Section title="How much it may spend">
        <Row label="Tasks at once">
          <Num value={p.policy.maxConcurrent} min={1} max={8} label="Tasks at once" onChange={(maxConcurrent) => void save({ policy: { maxConcurrent } })} />
        </Row>
        <Row label="Tasks a day">
          <Num value={p.policy.maxTasksPerDay} min={1} max={100} label="Tasks a day" onChange={(maxTasksPerDay) => void save({ policy: { maxTasksPerDay } })} />
        </Row>
        <Row label="Turns for one task" description="Each step of a task is a turn on your Muse plan.">
          <Num value={p.policy.maxTurnsPerTask} min={1} max={50} label="Turns for one task" onChange={(maxTurnsPerTask) => void save({ policy: { maxTurnsPerTask } })} />
        </Row>
        <Row label="Time for one task" description="Time spent waiting for your approval is not counted.">
          <Num value={p.policy.maxMinutesPerTask} min={1} max={240} unit="minutes" label="Minutes for one task" onChange={(maxMinutesPerTask) => void save({ policy: { maxMinutesPerTask } })} />
        </Row>
        <Row label="Notes added to a message" description="The most it adds to a prompt, in estimated tokens. It adds nothing when no note applies and no identity or goal is set.">
          <Num value={p.contextBudgetTokens} min={300} max={4000} step={100} unit="tokens" label="Notes added to a message" onChange={(contextBudgetTokens) => void save({ contextBudgetTokens })} />
        </Row>
      </Section>
    </div>
  );
}

function Goals(props: { bump: number; changed: () => void }) {
  const call = useAssistantCall();
  const goals = useAssistantData<{ goals: AssistantGoalView[] }>("/goals", props.bump);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      props.changed();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Section title="What it is working toward">
      {goals.data?.goals.map((g) => (
        <div key={g.id} className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 first:border-t-0">
          <span className="min-w-0 flex-1 text-sm text-fg [overflow-wrap:anywhere]">{g.text}</span>
          <Chip tone={g.status === "active" ? "accent" : "plain"}>{g.status === "active" ? "Active" : g.status === "paused" ? "Paused" : "Done"}</Chip>
          <Button size="xs" variant="secondary" onClick={() => void run(() => call("PATCH", `/goals/${encodeURIComponent(g.id)}`, { status: g.status === "active" ? "paused" : "active" }))}>
            {g.status === "active" ? "Pause" : "Make active"}
          </Button>
          {g.status !== "done" ? (
            <Button size="xs" variant="ghost" onClick={() => void run(() => call("PATCH", `/goals/${encodeURIComponent(g.id)}`, { status: "done" }))}>
              Done
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={() => void run(() => call("DELETE", `/goals/${encodeURIComponent(g.id)}`))}>
            Remove
          </Button>
        </div>
      ))}
      {goals.data && goals.data.goals.length === 0 ? <p className="px-4 py-4 text-sm text-muted">No goals yet. Active goals are told to the model with each message, and the assistant says when none has a task working on it.</p> : null}
      <div className="flex gap-2 border-t border-line px-4 py-3">
        <input
          type="text"
          aria-label="A goal"
          value={text}
          maxLength={400}
          placeholder="Ship the personal assistant this month"
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) {
              void run(() => call("POST", "/goals", { text: text.trim() })).then(() => setText(""));
            }
          }}
          className="h-8 min-w-0 flex-1 rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus"
        />
        <Button size="md" variant="secondary" disabled={!text.trim()} onClick={() => void run(() => call("POST", "/goals", { text: text.trim() })).then(() => setText(""))}>
          Add goal
        </Button>
      </div>
      {error ? <div className="px-4 pb-3"><Notice tone="error">{error}</Notice></div> : null}
    </Section>
  );
}
