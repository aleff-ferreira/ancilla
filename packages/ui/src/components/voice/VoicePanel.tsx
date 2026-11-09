import { useCallback, useEffect, useRef, useState } from "react";
import { useController } from "../../app/context.js";
import { errorMessage } from "../../client.js";
import type { VoiceBrainSetting, VoiceConversationView, VoiceSettingsView, VoiceStatusView } from "../../types.js";
import { Chip, Notice } from "../assistant/parts.js";
import { ModelPick, Pick, Row, Section } from "../settings/SettingsPage.js";
import { Button, Toggle } from "../ui/primitives.js";
import { ago } from "../assistant/api.js";
import { forgetVoiceStatus } from "./talk.js";

/**
 * The assistant's Voice tab: whether the voice is installed, which model answers, how it sounds and listens, and the
 * conversations it keeps. Everything here is a plain setting with a plain sentence beside it; nothing is on by surprise.
 */

interface PackItem {
  id: string;
  label: string;
  bytes: number;
  license: string;
  licenseUrl: string;
  optional: boolean;
}

interface PackJob {
  state: "idle" | "running" | "done" | "failed" | "cancelled";
  step: string;
  doneBytes: number;
  totalBytes: number;
  error: string | null;
}

interface PackView {
  plan: { items: PackItem[]; totalBytes: number; platform: string };
  job: PackJob;
  installedBytes: number;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const size = (bytes: number): string => (bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`);

const PRESETS: { id: string; label: string; baseUrl: string; model: string; local: boolean; needsKey: boolean }[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", local: false, needsKey: true },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini", local: false, needsKey: true },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", local: false, needsKey: true },
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:4b", local: true, needsKey: false },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", local: true, needsKey: false },
  { id: "llamacpp", label: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1", model: "local-model", local: true, needsKey: false },
];

export function VoicePanel(props: { changed: () => void }) {
  const controller = useController();
  const [status, setStatus] = useState<VoiceStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);

  const reload = useCallback(() => setRev((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    controller.voice<VoiceStatusView>("GET", "").then(
      (data) => {
        if (!cancelled) {
          setStatus(data);
          setError(null);
        }
      },
      (e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [controller, rev]);

  const save = async (patch: Record<string, unknown>) => {
    setError(null);
    try {
      await controller.voice("PATCH", "/settings", patch);
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (!controller.hasVoice) return <div className="mt-6"><Notice>This version of Ancilla has no voice.</Notice></div>;
  if (!status) return <p className="mt-6 text-sm text-subtle">{error ?? "Reading the voice settings..."}</p>;
  const s = status.settings;
  return (
    <div className="pb-4">
      {error ? <div className="mt-6"><Notice tone="error">{error}</Notice></div> : null}
      <Install status={status} reload={reload} />
      <Brain settings={s} status={status} save={save} />
      <Sound settings={s} status={status} save={save} />
      <Conversations settings={s} save={save} changed={props.changed} />
      <Section title="How it is going">
        <Row label="Time to the first word" description={status.latency.turns === 0 ? "Measured as you talk: from when you stop speaking to when the reply begins." : `Over your last ${status.latency.turns} turns. Half of them were quicker than the first number; nineteen in twenty were quicker than the second.`}>
          <span className="text-sm text-fg">{status.latency.firstAudio.p50 === null ? "no calls yet" : `${(status.latency.firstAudio.p50 / 1000).toFixed(1)} s · ${((status.latency.firstAudio.p95 ?? status.latency.firstAudio.p50) / 1000).toFixed(1)} s`}</span>
        </Row>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function Install(props: { status: VoiceStatusView; reload: () => void }) {
  const controller = useController();
  const { status } = props;
  const [pack, setPack] = useState<PackView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [refine, setRefine] = useState(true);
  const running = pack?.job.state === "running";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const view = await controller.voice<PackView>("GET", "/pack");
      setPack(view);
      return view;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  }, [controller]);

  useEffect(() => {
    void load();
  }, [load, status.pack.ready]);

  // While it installs, the progress is read once a second; when it stops, the status is read again.
  useEffect(() => {
    if (!running) return undefined;
    const tick = async () => {
      const view = await load();
      if (view && view.job.state !== "running") {
        // What the Talk buttons were told about the install is old now.
        forgetVoiceStatus();
        props.reload();
      } else timer.current = setTimeout(tick, 1000);
    };
    timer.current = setTimeout(tick, 1000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [running, load, props]);

  const install = async () => {
    setError(null);
    try {
      await controller.voice("POST", "/pack", { refine });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const cancel = async () => {
    try {
      await controller.voice("DELETE", "/pack/job");
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const remove = async () => {
    setError(null);
    try {
      await controller.voice("DELETE", "/pack");
      forgetVoiceStatus();
      await load();
      props.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const items = pack?.plan.items ?? [];
  const wanted = items.filter((i) => !i.optional || refine);
  const total = wanted.reduce((n, i) => n + i.bytes, 0);
  const job = pack?.job;
  const percent = job && job.totalBytes > 0 ? Math.min(100, Math.round((job.doneBytes / job.totalBytes) * 100)) : 0;

  return (
    <Section title="Voice engines">
      <Row
        label={status.available ? "Installed" : "Not installed yet"}
        description={
          status.available
            ? `Speech recognition and the voice run on this computer: your words and your voice are not sent anywhere unless you choose a model that is hosted elsewhere.${status.pack.refine ? " The accuracy booster is installed." : ""}`
            : status.pack.ready
              ? ""
              : `Missing: ${status.pack.missing.join(", ")}. The voice runs on this computer, so it needs to be downloaded once.`
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {status.available ? <Chip tone="ok">Ready</Chip> : <Chip tone="warn">Needs install</Chip>}
          {status.engines.loaded ? <Chip>In memory</Chip> : null}
          {status.available && !running ? (
            <Button size="sm" variant="ghost" onClick={() => void remove()}>
              Remove
            </Button>
          ) : null}
        </div>
      </Row>
      {!status.available && pack ? (
        <>
          <Row label="What is downloaded" description="Models are downloaded from their publishers and checked against a fixed checksum before they are used. They are kept in Ancilla's data folder.">
            <ul className="space-y-1 text-xs text-muted">
              {items.map((item) => (
                <li key={item.id} className={item.optional && !refine ? "opacity-50" : undefined}>
                  <span className="text-fg">{item.label}</span> · {size(item.bytes)} ·{" "}
                  <a className="text-accent-text underline-offset-2 hover:underline" href={item.licenseUrl} target="_blank" rel="noreferrer">
                    {item.license}
                  </a>
                </li>
              ))}
            </ul>
          </Row>
          <Row label="Accuracy booster" description="Reads each thing you say a second time with a larger model. It writes names and numbers much more accurately, at a cost of about half a gigabyte more to download and of memory while you talk.">
            <Toggle checked={refine} onChange={setRefine} label="Download the accuracy booster" disabled={running} />
          </Row>
          <Row label={`Download ${size(total)}`} description="By installing you accept the licences above. Nothing is installed or run until you do.">
            <div className="flex flex-col items-end gap-2">
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={accepted} disabled={running} onChange={(e) => setAccepted(e.target.checked)} />I accept the licences
              </label>
              {running ? (
                <Button size="sm" variant="secondary" onClick={() => void cancel()}>
                  Cancel
                </Button>
              ) : (
                <Button size="sm" variant="accent" disabled={!accepted} onClick={() => void install()}>
                  Install the voice
                </Button>
              )}
            </div>
          </Row>
        </>
      ) : null}
      {running && job ? (
        <Row label={job.step || "Downloading"} description={`${size(job.doneBytes)} of ${size(job.totalBytes)}`}>
          <div className="h-1.5 w-48 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </div>
        </Row>
      ) : null}
      {job?.state === "failed" && job.error ? (
        <Row label="The install stopped" description={job.error}>
          <Button size="sm" variant="secondary" onClick={() => void install()}>
            Try again
          </Button>
        </Row>
      ) : null}
      {error ? <Row label="Something went wrong" description={error} /> : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function Brain(props: { settings: VoiceSettingsView; status: VoiceStatusView; save: (patch: Record<string, unknown>) => Promise<void> }) {
  const controller = useController();
  const { settings } = props;
  const brain = settings.brain;
  const [draft, setDraft] = useState<{ baseUrl: string; model: string; apiKey: string; local: boolean; apiKeyEnv: string }>({
    baseUrl: brain.kind === "openai" ? brain.baseUrl : "",
    model: brain.kind === "openai" ? brain.model : "",
    apiKey: "",
    local: brain.kind === "openai" ? brain.local : false,
    apiKeyEnv: brain.kind === "openai" ? (brain.apiKeyEnv ?? "") : "",
  });
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // The Muse model's choices are the list Muse sends, read when the setting is on show; a list already read is left be.
  const throughMuse = brain.kind === "muse";
  useEffect(() => {
    if (throughMuse) void controller.refreshModels({ navigation: true });
  }, [controller, throughMuse]);

  const choose = (kind: VoiceBrainSetting["kind"]) => {
    setTest(null);
    if (kind === "openai") {
      const preset = PRESETS[0] as (typeof PRESETS)[number];
      const next = { baseUrl: draft.baseUrl || preset.baseUrl, model: draft.model || preset.model, local: draft.baseUrl ? draft.local : preset.local };
      setDraft((d) => ({ ...d, ...next }));
      void props.save({ brain: { kind: "openai", baseUrl: next.baseUrl, model: next.model, local: next.local, label: null, apiKeyEnv: draft.apiKeyEnv || null } });
    } else void props.save({ brain: { kind } });
  };
  const apply = async (patch: Partial<typeof draft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (!/^https?:\/\//.test(next.baseUrl) || next.model.trim() === "") return;
    await props.save({ brain: { kind: "openai", baseUrl: next.baseUrl.trim(), model: next.model.trim(), local: next.local, label: null, apiKeyEnv: next.apiKeyEnv.trim() || null }, ...(next.apiKey !== "" ? { apiKey: next.apiKey } : {}) });
    if (next.apiKey !== "") setDraft((d) => ({ ...d, apiKey: "" }));
  };
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const out = await controller.voice<{ ok: boolean; ms?: number; firstTokenMs?: number | null; text?: string; error?: string; skipped?: boolean }>("POST", "/brain/test");
      setTest(out.ok ? { ok: true, text: out.skipped ? (out.text ?? "") : `Answered "${out.text}" in ${((out.firstTokenMs ?? out.ms ?? 0) / 1000).toFixed(1)} s to the first word.` } : { ok: false, text: out.error ?? "No answer." });
    } catch (e) {
      setTest({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Section title="The model that answers">
      <Row label="Model" description="Which model thinks of what to say. The voice talks in short turns, so a fast model feels best; a slow one is covered by a short “one moment”.">
        <Pick<VoiceBrainSetting["kind"]>
          value={brain.kind}
          options={[
            { value: "muse", label: "Muse", hint: "Your Muse subscription, through a thread. No key needed." },
            { value: "openai", label: "Another model", hint: "Any model that speaks the OpenAI chat protocol: hosted, or running on this computer." },
            { value: "none", label: "None" },
          ]}
          onChange={choose}
        />
      </Row>
      {brain.kind === "muse" ? (
        <>
          <Row label="Through Muse" description="Uses your Muse plan, one thread per conversation, so each answer takes as long as a Muse turn. A smaller model answers sooner, and another provider's model sooner still." />
          <Row label="Muse model" description="Which of the models your Muse plan offers answers the call. It applies from the next call. “Muse default” leaves a conversation's thread on whatever it is on.">
            <ModelPick
              full
              tried
              value={brain.model}
              onChange={(model) => void props.save({ brain: { kind: "muse", model } })}
              onTyped={async (model) => {
                await props.save({ brain: { kind: "muse", model } });
                return true;
              }}
            />
          </Row>
        </>
      ) : null}
      {brain.kind === "openai" ? (
        <>
          <Row label="Start from" description="Fills in the address and a model name; change either.">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <Button key={p.id} size="xs" variant="secondary" onClick={() => void apply({ baseUrl: p.baseUrl, model: p.model, local: p.local })}>
                  {p.label}
                </Button>
              ))}
            </div>
          </Row>
          <Row label="Address">
            <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} onBlur={() => void apply({})} aria-label="Model address" placeholder="https://api.example.com/v1" className="h-8 w-72 max-w-full rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
          </Row>
          <Row label="Model name">
            <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} onBlur={() => void apply({})} aria-label="Model name" placeholder="gpt-4.1-mini" className="h-8 w-72 max-w-full rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
          </Row>
          <Row label="Key" description={settings.hasKey ? "A key is saved, in a file only you can read. It is never shown again." : "Kept in a file only you can read, never shown again. Not needed for a model on this computer."}>
            <div className="flex items-center gap-2">
              <input type="password" autoComplete="off" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} onBlur={() => void apply({})} aria-label="API key" placeholder={settings.hasKey ? "saved" : "sk-..."} className="h-8 w-56 max-w-full rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
              {settings.hasKey ? <Chip tone="ok">Set</Chip> : null}
            </div>
          </Row>
          <Row label="Runs on this computer" description="Nothing you say is sent over the internet when this is on.">
            <Toggle checked={draft.local} onChange={(on) => void apply({ local: on })} label="The model runs on this computer" />
          </Row>
        </>
      ) : null}
      {brain.kind !== "none" ? (
        <Row label="Try it" description={props.status.brain.problem ?? (test ? test.text : brain.kind === "muse" ? "Muse is tried by starting a call." : "Sends one short message and times the answer.")}>
          {brain.kind === "openai" ? (
            <div className="flex items-center gap-2">
              {test ? <Chip tone={test.ok ? "ok" : "danger"}>{test.ok ? "Works" : "Failed"}</Chip> : null}
              <Button size="sm" variant="secondary" loading={testing} onClick={() => void runTest()}>
                Test
              </Button>
            </div>
          ) : null}
        </Row>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function Sound(props: { settings: VoiceSettingsView; status: VoiceStatusView; save: (patch: Record<string, unknown>) => Promise<void> }) {
  const { settings, status } = props;
  const [speed, setSpeed] = useState(settings.speed);
  useEffect(() => setSpeed(settings.speed), [settings.speed]);
  const voices = status.voices;
  return (
    <Section title="Sound and listening">
      <Row label="Voice" description="Pick one for each language, or let it choose a voice that speaks the language you are using.">
        <select
          aria-label="Voice"
          value={settings.voice ?? ""}
          onChange={(e) => void props.save({ voice: e.target.value === "" ? null : e.target.value })}
          className="h-8 rounded-lg bg-sunken px-2 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <option value="">Automatic</option>
          {["en", "pt"].map((lang) => (
            <optgroup key={lang} label={lang === "en" ? "English" : "Portuguese"}>
              {voices
                .filter((v) => v.lang === lang)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </Row>
      <Row label={`Speed: ${speed.toFixed(2)}×`}>
        <input type="range" min={0.7} max={1.4} step={0.05} value={speed} aria-label="Speaking speed" onChange={(e) => setSpeed(Number(e.target.value))} onPointerUp={() => void props.save({ speed })} onKeyUp={() => void props.save({ speed })} className="w-48" />
      </Row>
      <Row label="How you talk" description="Hands-free listens all the time and works out when you have finished. Push to talk listens only while you hold the button or the space bar.">
        <Pick<"hands-free" | "push-to-talk">
          value={settings.mode}
          options={[
            { value: "hands-free", label: "Hands-free" },
            { value: "push-to-talk", label: "Push to talk" },
          ]}
          onChange={(mode) => void props.save({ mode })}
        />
      </Row>
      <Row label="Speaks up by itself" description="When a task you gave it finishes or needs you, it says so in a pause in the conversation, and a call opens with what changed since you last talked. It never interrupts you, and says nothing if you speak first.">
        <Toggle checked={settings.proactive} onChange={(proactive) => void props.save({ proactive })} label="Let it speak up about tasks" />
      </Row>
      <Row label="Reads each turn twice" description={status.pack.refine ? "Uses the accuracy booster to write down what you said. Slower to load, much better with names and numbers." : "Needs the accuracy booster, which is not installed."}>
        <Toggle checked={settings.refine && status.pack.refine} disabled={!status.pack.refine} onChange={(refine) => void props.save({ refine })} label="Use the accuracy booster" />
      </Row>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function Conversations(props: { settings: VoiceSettingsView; save: (patch: Record<string, unknown>) => Promise<void>; changed: () => void }) {
  const controller = useController();
  const [list, setList] = useState<VoiceConversationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let cancelled = false;
    controller.voice<{ conversations: VoiceConversationView[] }>("GET", "/conversations").then(
      (out) => !cancelled && setList(out.conversations),
      (e: unknown) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [controller, rev]);
  const remove = async (id: string) => {
    try {
      await controller.voice("DELETE", `/conversations/${encodeURIComponent(id)}`);
      setRev((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const removeAll = async () => {
    try {
      await controller.voice("DELETE", "/conversations?all=1");
      setRev((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const now = Date.now();
  return (
    <Section title="Conversations it keeps">
      <Row label="Keep for" description="Only the words are kept, never the sound. Older conversations are deleted when you start a call. What it remembered from them (in Memory) is separate.">
        <Pick<number | null>
          value={props.settings.keepDays}
          options={[
            { value: null, label: "Until I delete them" },
            { value: 30, label: "30 days" },
            { value: 7, label: "7 days" },
            { value: 1, label: "1 day" },
          ]}
          onChange={(keepDays) => void props.save({ keepDays })}
        />
      </Row>
      {error ? <Row label="Something went wrong" description={error} /> : null}
      {list && list.length === 0 ? <Row label="Nothing yet" description="Conversations appear here after your first call." /> : null}
      {(list ?? []).slice(0, 8).map((c) => (
        <Row key={c.id} label={c.title || "Untitled"} description={`${c.turns} ${c.turns === 1 ? "turn" : "turns"} · ${ago(c.updatedAt, now)}`}>
          <Button size="sm" variant="ghost" onClick={() => void remove(c.id)}>
            Delete
          </Button>
        </Row>
      ))}
      {list && list.length > 0 ? (
        <Row label="Delete every conversation" description="This cannot be undone.">
          <Button size="sm" variant="danger" onClick={() => void removeAll()}>
            Delete all
          </Button>
        </Row>
      ) : null}
    </Section>
  );
}
