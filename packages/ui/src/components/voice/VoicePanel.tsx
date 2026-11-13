import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp, useController } from "../../app/context.js";
import { errorMessage } from "../../client.js";
import type { ProviderId, VoiceBrainSetting, VoiceConversationView, VoiceSettingsView, VoiceStatusView } from "../../types.js";
import { Chip, Notice } from "../assistant/parts.js";
import { ModelPick, Pick, Row, Section, buildProviderAccountOptions } from "../settings/SettingsPage.js";
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

const PRESETS: { id: string; label: string; kind: "openai" | "anthropic" | "google"; baseUrl: string; model: string; local: boolean; apiKeyEnv: string | null }[] = [
  { id: "anthropic", label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5", local: false, apiKeyEnv: "ANTHROPIC_API_KEY" },
  { id: "openai", label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", local: false, apiKeyEnv: "OPENAI_API_KEY" },
  { id: "gemini", label: "Gemini", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", local: false, apiKeyEnv: "GEMINI_API_KEY" },
  { id: "openrouter", label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini", local: false, apiKeyEnv: "OPENROUTER_API_KEY" },
  { id: "groq", label: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", local: false, apiKeyEnv: "GROQ_API_KEY" },
  { id: "ollama", label: "Ollama", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:4b", local: true, apiKeyEnv: null },
  { id: "lmstudio", label: "LM Studio", kind: "openai", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", local: true, apiKeyEnv: null },
  { id: "llamacpp", label: "llama.cpp", kind: "openai", baseUrl: "http://127.0.0.1:8080/v1", model: "local-model", local: true, apiKeyEnv: null },
  { id: "vllm", label: "vLLM", kind: "openai", baseUrl: "http://127.0.0.1:8000/v1", model: "local-model", local: true, apiKeyEnv: null },
];

const SPEECH_PRESETS: { id: string; label: string; baseUrl: string; sttModel: string; ttsModel: string; local: boolean; apiKeyEnv: string | null }[] = [
  { id: "openai-speech", label: "OpenAI", baseUrl: "https://api.openai.com/v1", sttModel: "gpt-4o-mini-transcribe", ttsModel: "gpt-4o-mini-tts", local: false, apiKeyEnv: "OPENAI_API_KEY" },
  { id: "speaches", label: "Speaches (local)", baseUrl: "http://127.0.0.1:8000/v1", sttModel: "Systran/faster-whisper-small", ttsModel: "speaches-ai/Kokoro-82M-v1.0-ONNX", local: true, apiKeyEnv: null },
  { id: "localai", label: "LocalAI / whisper.cpp", baseUrl: "http://127.0.0.1:8080/v1", sttModel: "whisper-1", ttsModel: "tts-1", local: true, apiKeyEnv: null },
];

const DEFAULT_VOICE_STATUS: VoiceStatusView = {
  available: true,
  pack: { runtime: true, vad: true, streaming: true, refine: true, tts: true, ready: true, missing: [] },
  layout: { runtimeDir: null, modelsDir: "" },
  engines: { loaded: true, asr: null, tts: null, sampleRate: null },
  call: { active: false, id: null, conversation: null, since: null },
  settings: {
    mode: "hands-free",
    voice: null,
    speed: 1,
    refine: true,
    ttsSteps: 4,
    brain: { kind: "muse", model: null, accountId: null },
    speech: { kind: "local" },
    proactive: false,
    keepDays: null,
    runtimeDir: null,
    modelsDir: null,
    defaultProject: null,
    hasKey: false,
    hasSpeechKey: false,
  },
  brain: { label: "Muse", local: false, problem: null },
  voices: [],
  latency: { turns: 0, firstAudio: { n: 0, p50: null, p95: null }, endpoint: { n: 0, p50: null, p95: null } },
};

export function VoicePanel(props: { changed?: () => void; status?: VoiceStatusView | null }) {
  const controller = useController();
  const [status, setStatus] = useState<VoiceStatusView | null>(
    () => props.status ?? (controller.hasVoice === false ? null : DEFAULT_VOICE_STATUS),
  );
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);

  const reload = useCallback(() => setRev((n) => n + 1), []);
  useEffect(() => {
    if (typeof controller.voice !== "function") return;
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
    if (typeof controller.voice !== "function") return;
    setError(null);
    try {
      await controller.voice("PATCH", "/settings", patch);
      forgetVoiceStatus();
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (controller.hasVoice === false) return <div className="mt-6"><Notice>This version of Ancilla has no voice.</Notice></div>;
  const currentStatus = status ?? DEFAULT_VOICE_STATUS;
  const s = currentStatus.settings;
  return (
    <div className="pb-4">
      {error ? <div className="mt-6"><Notice tone="error">{error}</Notice></div> : null}
      <Install status={currentStatus} save={save} reload={reload} />
      <Brain settings={s} status={currentStatus} save={save} />
      <Sound settings={s} status={currentStatus} save={save} />
      <Conversations settings={s} save={save} changed={props.changed ?? (() => {})} />
      <Section title="How it is going">
        <Row label="Time to the first word" description={currentStatus.latency.turns === 0 ? "Measured as you talk: from when you stop speaking to when the reply begins." : `Over your last ${currentStatus.latency.turns} turns. Half of them were quicker than the first number; nineteen in twenty were quicker than the second.`}>
          <span className="text-sm text-fg">{currentStatus.latency.firstAudio.p50 === null ? "no calls yet" : `${(currentStatus.latency.firstAudio.p50 / 1000).toFixed(1)} s · ${((currentStatus.latency.firstAudio.p95 ?? currentStatus.latency.firstAudio.p50) / 1000).toFixed(1)} s`}</span>
        </Row>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function Install(props: { status: VoiceStatusView; save: (patch: Record<string, unknown>) => Promise<void>; reload: () => void }) {
  const controller = useController();
  const { status } = props;
  const speech = status.settings.speech;
  const isHttp = speech.kind === "http";
  const [speechDraft, setSpeechDraft] = useState({
    baseUrl: speech.kind === "http" ? speech.baseUrl : "https://api.openai.com/v1",
    sttModel: speech.kind === "http" ? speech.sttModel : "gpt-4o-mini-transcribe",
    ttsModel: speech.kind === "http" ? speech.ttsModel : "gpt-4o-mini-tts",
    local: speech.kind === "http" ? speech.local : false,
    apiKeyEnv: speech.kind === "http" ? (speech.apiKeyEnv ?? "OPENAI_API_KEY") : "OPENAI_API_KEY",
    speechKey: "",
  });
  useEffect(() => {
    if (speech.kind === "http") {
      setSpeechDraft((d) => ({ ...d, baseUrl: speech.baseUrl, sttModel: speech.sttModel, ttsModel: speech.ttsModel, local: speech.local, apiKeyEnv: speech.apiKeyEnv ?? "" }));
    }
  }, [speech]);
  const [pack, setPack] = useState<PackView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [refine, setRefine] = useState(true);
  const running = pack?.job.state === "running";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (typeof controller.voice !== "function") return null;
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

  const chooseSpeech = (kind: "local" | "http") => {
    if (kind === "local") {
      void props.save({ speech: { kind: "local" } });
      return;
    }
    void props.save({
      speech: {
        kind: "http",
        baseUrl: speechDraft.baseUrl.trim() || "https://api.openai.com/v1",
        sttModel: speechDraft.sttModel.trim() || "gpt-4o-mini-transcribe",
        ttsModel: speechDraft.ttsModel.trim() || "gpt-4o-mini-tts",
        local: speechDraft.local,
        apiKeyEnv: speechDraft.apiKeyEnv.trim() || null,
      },
    });
  };

  const applySpeech = async (patch: Partial<typeof speechDraft>) => {
    const next = { ...speechDraft, ...patch };
    setSpeechDraft(next);
    if (!/^https?:\/\//.test(next.baseUrl) || next.sttModel.trim() === "" || next.ttsModel.trim() === "") return;
    await props.save({
      speech: {
        kind: "http",
        baseUrl: next.baseUrl.trim(),
        sttModel: next.sttModel.trim(),
        ttsModel: next.ttsModel.trim(),
        local: next.local,
        apiKeyEnv: next.apiKeyEnv.trim() || null,
      },
      ...(next.speechKey !== "" ? { speechKey: next.speechKey } : {}),
    });
    if (next.speechKey !== "") setSpeechDraft((d) => ({ ...d, speechKey: "" }));
  };

  return (
    <Section title="Voice engines">
      <Row label="Where speech runs" description="Run speech recognition and synthesis on this computer with the local pack, or connect a speech server with no model download.">
        <Pick<"local" | "http">
          value={speech.kind}
          options={[
            { value: "local", label: "On this computer", hint: "Downloaded once; audio stays here." },
            { value: "http", label: "Speech server", hint: "Zero download; local server or hosted speech API." },
          ]}
          onChange={chooseSpeech}
        />
      </Row>
      {isHttp ? (
        <>
          <Row label="Start from" description="Fills in the address and speech model names; change any of them.">
            <div className="flex flex-wrap gap-1.5">
              {SPEECH_PRESETS.map((p) => (
                <Button key={p.id} size="xs" variant={speechDraft.baseUrl === p.baseUrl ? "primary" : "secondary"} onClick={() => void applySpeech({ baseUrl: p.baseUrl, sttModel: p.sttModel, ttsModel: p.ttsModel, local: p.local, apiKeyEnv: p.apiKeyEnv ?? "" })}>
                  {p.label}
                </Button>
              ))}
            </div>
          </Row>
          <Row label="Speech address" description={status.available ? "Ready to listen and speak." : "Add a key below or switch on local mode if this server needs no key."}>
            <div className="flex flex-wrap items-center gap-2">
              <input value={speechDraft.baseUrl} onChange={(e) => setSpeechDraft({ ...speechDraft, baseUrl: e.target.value })} onBlur={() => void applySpeech({})} aria-label="Speech server address" placeholder="http://127.0.0.1:8000/v1" className="h-8 w-72 max-w-full rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
              {status.available ? <Chip tone="ok">Ready</Chip> : <Chip tone="warn">Needs key</Chip>}
            </div>
          </Row>
          <Row label="Speech-to-text model">
            <input value={speechDraft.sttModel} onChange={(e) => setSpeechDraft({ ...speechDraft, sttModel: e.target.value })} onBlur={() => void applySpeech({})} aria-label="Speech-to-text model" className="h-8 w-72 max-w-full rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
          </Row>
          <Row label="Text-to-speech model">
            <input value={speechDraft.ttsModel} onChange={(e) => setSpeechDraft({ ...speechDraft, ttsModel: e.target.value })} onBlur={() => void applySpeech({})} aria-label="Text-to-speech model" className="h-8 w-72 max-w-full rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
          </Row>
          <Row label="Speech key" description={status.settings.hasSpeechKey ? "A key is set (or shared with the chat model at the same address)." : "Not needed for a local speech server."}>
            <div className="flex flex-wrap items-center gap-2">
              <input type="password" autoComplete="off" value={speechDraft.speechKey} onChange={(e) => setSpeechDraft({ ...speechDraft, speechKey: e.target.value })} onBlur={() => void applySpeech({})} aria-label="Speech API key" placeholder={status.settings.hasSpeechKey ? "saved" : "sk-..."} className="h-8 w-56 max-w-full rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
              {status.settings.hasSpeechKey ? <Chip tone="ok">Set</Chip> : null}
            </div>
          </Row>
          <Row label="Speech key variable" description="Optional environment variable name (such as OPENAI_API_KEY).">
            <input value={speechDraft.apiKeyEnv} onChange={(e) => setSpeechDraft({ ...speechDraft, apiKeyEnv: e.target.value })} onBlur={() => void applySpeech({})} aria-label="Speech API key environment variable" placeholder="Optional" className="h-8 w-56 max-w-full rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
          </Row>
          <Row label="Speech runs on this computer" description="Switch on when the speech server runs on localhost and needs no key.">
            <Toggle checked={speechDraft.local} onChange={(local) => void applySpeech({ local })} label="The speech server runs on this computer" />
          </Row>
        </>
      ) : (
        <>
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
        </>
      )}
      {error ? <Row label="Something went wrong" description={error} /> : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

/** A model server found on this computer (see the server's local-models.ts). */
interface LocalServerView {
  id: string;
  label: string;
  baseUrl: string;
  models: { id: string; sizeBytes: number | null }[];
}

const TOOL_WORDS = {
  native: " Tools: built in.",
  text: " Tools: through text, because this server does not take them natively.",
  none: " It did not use a test tool, so the assistant may not be able to start tasks with it; a larger model usually can.",
} as const;

function Brain(props: { settings: VoiceSettingsView; status: VoiceStatusView; save: (patch: Record<string, unknown>) => Promise<void> }) {
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

  const { settings } = props;
  const brain = settings.brain;
  const isCustom = brain.kind === "openai" || brain.kind === "anthropic" || brain.kind === "google";

  const voiceProviderOptions = useMemo(
    () =>
      buildProviderAccountOptions(accounts, providers, {
        includeFollowAssistant: true,
        includeCustom: true,
        includeNone: true,
        customLabel: "Custom endpoint",
      }),
    [accounts, providers],
  );

  const voiceKey = useMemo(() => {
    if (brain.kind === "assistant") return "assistant";
    if (brain.kind === "none") return "none";
    if (brain.kind === "openai" || brain.kind === "anthropic" || brain.kind === "google") return "custom";
    if (brain.kind === "muse") return `muse::${brain.accountId ?? ""}`;
    if (brain.kind === "provider") return `${brain.providerId}::${brain.accountId ?? ""}`;
    return "muse::";
  }, [brain]);

  const [draft, setDraft] = useState<{ kind: "openai" | "anthropic" | "google"; baseUrl: string; model: string; apiKey: string; local: boolean; apiKeyEnv: string }>({
    kind: brain.kind === "anthropic" || brain.kind === "google" ? brain.kind : "openai",
    baseUrl: isCustom ? brain.baseUrl : "",
    model: isCustom ? brain.model : "",
    apiKey: "",
    local: isCustom ? brain.local : false,
    apiKeyEnv: isCustom ? (brain.apiKeyEnv ?? "") : "",
  });

  useEffect(() => {
    if (brain.kind === "openai" || brain.kind === "anthropic" || brain.kind === "google") {
      setDraft((d) => ({ ...d, kind: brain.kind, baseUrl: brain.baseUrl, model: brain.model, local: brain.local, apiKeyEnv: brain.apiKeyEnv ?? "" }));
    }
  }, [brain]);

  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  // Model servers on this computer, looked for when another model is on show, and again on request. Null while looking.
  const [found, setFound] = useState<LocalServerView[] | null>(null);
  const [rescan, setRescan] = useState(0);

  useEffect(() => {
    if (!isCustom || typeof controller.voice !== "function") return;
    let live = true;
    setFound(null);
    controller.voice<{ servers: LocalServerView[] }>("GET", "/local-models").then(
      (out) => live && setFound(out.servers),
      () => live && setFound([]),
    );
    return () => {
      live = false;
    };
  }, [controller, isCustom, rescan]);

  useEffect(() => {
    if (typeof controller.refreshModels !== "function") return;
    if (brain.kind === "muse") {
      void controller.refreshModels({ navigation: true });
    } else if (brain.kind === "provider") {
      void controller.refreshModels({
        navigation: true,
        providerId: brain.providerId,
        accountId: brain.accountId ?? null,
      });
    }
  }, [controller, brain]);

  const choose = (key: string) => {
    setTest(null);
    if (key === "assistant") {
      void props.save({ brain: { kind: "assistant" } });
    } else if (key === "none") {
      void props.save({ brain: { kind: "none" } });
    } else if (key === "custom") {
      const preset = PRESETS.find((p) => p.id === "openai") ?? (PRESETS[0] as (typeof PRESETS)[number]);
      const nextKind = draft.baseUrl ? draft.kind : preset.kind;
      const next = {
        kind: nextKind,
        baseUrl: draft.baseUrl || preset.baseUrl,
        model: draft.model || preset.model,
        local: draft.baseUrl ? draft.local : preset.local,
        apiKeyEnv: draft.baseUrl ? draft.apiKeyEnv : (preset.apiKeyEnv ?? ""),
      };
      setDraft((d) => ({ ...d, ...next }));
      void props.save({
        brain: {
          kind: next.kind,
          baseUrl: next.baseUrl,
          model: next.model,
          local: next.local,
          label: null,
          apiKeyEnv: next.apiKeyEnv || null,
        },
      });
    } else {
      const sep = key.indexOf("::");
      const providerId = (sep >= 0 ? key.slice(0, sep) : "muse") as ProviderId;
      const accountId = sep >= 0 ? key.slice(sep + 2) || null : null;
      if (providerId === "muse") {
        void props.save({ brain: { kind: "muse", model: null, accountId } });
      } else {
        void props.save({ brain: { kind: "provider", providerId, accountId, model: null } });
      }
    }
  };

  const apply = async (patch: Partial<typeof draft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (!/^https?:\/\//.test(next.baseUrl) || next.model.trim() === "") return;
    await props.save({
      brain: { kind: next.kind, baseUrl: next.baseUrl.trim(), model: next.model.trim(), local: next.local, label: null, apiKeyEnv: next.apiKeyEnv.trim() || null },
      ...(next.apiKey !== "" ? { apiKey: next.apiKey } : {}),
    });
    if (next.apiKey !== "") setDraft((d) => ({ ...d, apiKey: "" }));
  };

  const runTest = async () => {
    if (typeof controller.voice !== "function") return;
    setTesting(true);
    setTest(null);
    try {
      const out = await controller.voice<{ ok: boolean; ms?: number; firstTokenMs?: number | null; text?: string; error?: string; skipped?: boolean; tools?: keyof typeof TOOL_WORDS | null }>("POST", "/brain/test");
      setTest(out.ok ? { ok: true, text: out.skipped ? (out.text ?? "") : `Answered "${out.text}" in ${((out.firstTokenMs ?? out.ms ?? 0) / 1000).toFixed(1)} s to the first word.${out.tools ? TOOL_WORDS[out.tools] : ""}` } : { ok: false, text: out.error ?? "No answer." });
    } catch (e) {
      setTest({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Section title="The model that answers">
      <Row label="Model" description="Which model thinks of what to say. The voice talks in short turns, so a fast model feels best; a slow one is covered by a short “one moment”.">
        <Pick
          value={voiceKey}
          options={voiceProviderOptions}
          onChange={choose}
          wrap
        />
      </Row>
      {brain.kind === "assistant" ? (
        <Row
          label="Following assistant"
          description={`Answering with ${props.status.brain.label}. Changing the model on the Assistant tab applies on the next turn, even during an open call.`}
        />
      ) : null}
      {brain.kind === "muse" || brain.kind === "provider" ? (
        <>
          <Row
            label={brain.kind === "muse" ? "Through Muse" : "Through CLI or API"}
            description={
              brain.kind === "muse"
                ? "Uses your Muse plan, one thread per conversation, so each answer takes as long as a Muse turn. A smaller model answers sooner, and another provider's model sooner still."
                : "Uses your configured provider or saved API endpoint. Applies on the next turn, even during an open call."
            }
          />
          <Row
            label="Model"
            description={
              brain.kind === "muse"
                ? "Which of the models your Muse plan offers answers the call. Applies on the next turn, even during an open call. “Muse default” uses Muse's default model."
                : "Which model answers the call. Applies on the next turn, even during an open call."
            }
          >
            <ModelPick
              full
              scope={{
                providerId: brain.kind === "provider" ? brain.providerId : "muse",
                accountId: brain.accountId ?? null,
              }}
              value={brain.model}
              museDefault={false}
              onChange={(model) => void props.save({ brain: { ...brain, model } })}
              onTyped={async (model) => {
                await props.save({ brain: { ...brain, model } });
                return true;
              }}
            />
          </Row>
        </>
      ) : null}
      {isCustom ? (
        <>
          <Row label="Start from" description="Fills in the protocol, address and a model name; change any of them.">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <Button key={p.id} size="xs" variant={draft.kind === p.kind && draft.baseUrl === p.baseUrl ? "primary" : "secondary"} onClick={() => void apply({ kind: p.kind, baseUrl: p.baseUrl, model: p.model, local: p.local, apiKeyEnv: p.apiKeyEnv ?? "" })}>
                  {p.label}
                </Button>
              ))}
            </div>
          </Row>
          <Row
            label="On this computer"
            description={found === null ? "Looking for Ollama, LM Studio, llama.cpp, vLLM and Jan…" : found.length === 0 ? "No model server answered at its usual address. Start one and press Detect, or type its address below." : "Model servers running here. Pick one of their models."}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {(found ?? []).flatMap((s) =>
                s.models.length === 0
                  ? [<Chip key={s.id}>{s.label}: no model loaded</Chip>]
                  : s.models.slice(0, 8).map((m) => (
                      <Button key={`${s.id}:${m.id}`} size="xs" variant={draft.kind === "openai" && draft.baseUrl === s.baseUrl && draft.model === m.id ? "primary" : "secondary"} onClick={() => void apply({ kind: "openai", baseUrl: s.baseUrl, model: m.id, local: true, apiKeyEnv: "" })}>
                        {s.label} · {m.id}
                      </Button>
                    )),
              )}
              <Button size="xs" variant="ghost" loading={found === null} onClick={() => setRescan((n) => n + 1)}>
                Detect
              </Button>
            </div>
          </Row>
          <Row label="Protocol" description="Most hosted and local servers speak the OpenAI chat protocol; Anthropic uses its own Messages endpoint; Google speaks the Gemini Generative Language API.">
            <Pick<"openai" | "anthropic" | "google">
              value={draft.kind}
              options={[
                { value: "openai", label: "OpenAI chat" },
                { value: "anthropic", label: "Messages API" },
                { value: "google", label: "Google Gemini" },
              ]}
              onChange={(kind) => void apply({ kind })}
            />
          </Row>
          <Row label="Address">
            <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} onBlur={() => void apply({})} aria-label="Model address" placeholder={draft.kind === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.example.com/v1"} className="h-8 w-72 max-w-full rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
          </Row>
          <Row label="Model name">
            <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} onBlur={() => void apply({})} aria-label="Model name" placeholder={draft.kind === "anthropic" ? "claude-sonnet-4-5" : "gpt-4.1-mini"} className="h-8 w-72 max-w-full rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
          </Row>
          <Row label="Key" description={settings.hasKey ? "A key is available (saved in a file only you can read, or read from the environment variable below). Never shown again." : "Kept in a file only you can read, never shown again. Not needed for a model on this computer."}>
            <div className="flex flex-wrap items-center gap-2">
              <input type="password" autoComplete="off" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} onBlur={() => void apply({})} aria-label="API key" placeholder={settings.hasKey ? "saved" : "sk-..."} className="h-8 w-56 max-w-full rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
              {settings.hasKey ? <Chip tone="ok">Set</Chip> : null}
            </div>
          </Row>
          <Row label="Key variable" description="Optional name of an environment variable on this computer (such as OPENAI_API_KEY) used when no key is saved above.">
            <input value={draft.apiKeyEnv} onChange={(e) => setDraft({ ...draft, apiKeyEnv: e.target.value })} onBlur={() => void apply({})} aria-label="API key environment variable" placeholder="Optional" className="h-8 w-56 max-w-full rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus" />
          </Row>
          <Row label="Runs on this computer" description="Nothing you say is sent over the internet when this is on.">
            <Toggle checked={draft.local} onChange={(on) => void apply({ local: on })} label="The model runs on this computer" />
          </Row>
        </>
      ) : null}
      {brain.kind !== "none" ? (
        <Row
          label="Try it"
          description={
            props.status.brain.problem ??
            (test
              ? test.text
              : brain.kind === "muse" || (brain.kind === "provider" && brain.providerId !== "api")
                ? `${brain.kind === "muse" ? "Muse" : "CLI"} is tried by starting a call.`
                : "Sends one short message and times the answer.")
          }
        >
          {isCustom || (brain.kind === "provider" && brain.providerId === "api") ? (
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
          {(
            [
              ["en", "English"],
              ["pt", "Portuguese"],
              ["es", "Spanish"],
            ] as const
          ).map(([lang, label]) => {
            const matching = voices.filter((v) => v.lang === lang);
            if (matching.length === 0 && lang === "es") return null;
            return (
              <optgroup key={lang} label={label}>
                {matching.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </optgroup>
            );
          })}
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
  const projects = useApp((s) => s.projects);
  const [list, setList] = useState<VoiceConversationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    if (typeof controller.voice !== "function") return;
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
      {projects.length > 0 ? (
        <Row label="Default project" description="Used when you start a call from outside a project thread.">
          <select
            aria-label="Default project"
            value={props.settings.defaultProject ?? ""}
            onChange={(e) => void props.save({ defaultProject: e.target.value === "" ? null : e.target.value })}
            className="h-8 max-w-full rounded-lg bg-sunken px-2 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <option value="">Active or last project</option>
            {projects.map((p) => (
              <option key={p.cwd} value={p.cwd}>
                {p.displayName} ({p.cwd})
              </option>
            ))}
          </select>
        </Row>
      ) : null}
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
