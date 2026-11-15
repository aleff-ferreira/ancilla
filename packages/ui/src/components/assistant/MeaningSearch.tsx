import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../client.js";
import type { AssistantEmbeddingTestView, AssistantEmbeddingsView } from "../../types.js";
import { Row, Section, Pick } from "../settings/SettingsPage.js";
import { Button } from "../ui/primitives.js";
import { useAssistantCall, useAssistantData } from "./api.js";
import { Notice } from "./parts.js";

/** What the measured default model wants in front of a question and not in front of a note. */
const QWEN_PREFIX = "Instruct: Given a question from the user, retrieve the saved note that answers it\nQuery: ";

const PRESETS: { id: string; label: string; baseUrl: string; model: string; queryPrefix: string }[] = [
  { id: "qwen3", label: "Qwen3-Embedding (llama.cpp)", baseUrl: "http://127.0.0.1:8080/v1", model: "qwen3-embedding", queryPrefix: QWEN_PREFIX },
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "nomic-embed-text", queryPrefix: "" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", model: "text-embedding-nomic-embed-text-v1.5", queryPrefix: "" },
];

interface Tuning {
  minCosine: number;
  standoutCosine: number | null;
  standoutLead: number;
}

// Each of the three was measured with the model above (docs/assistant-evaluation.md). Another model scores nearness on
// another scale, so they are a place to start with one, and the file holds the numbers for anyone who has measured it.
const CLOSENESS: { id: string; label: string; hint: string; tuning: Tuning }[] = [
  { id: "strict", label: "Strict", hint: "Only notes very close in meaning. Finds some of what words miss, and puts no more wrong notes in front of a prompt than before", tuning: { minCosine: 0.65, standoutCosine: null, standoutLead: 0.15 } },
  { id: "balanced", label: "Balanced", hint: "Also the one note that stands out from the rest. Finds noticeably more than Strict, for about one more wrong note in a hundred", tuning: { minCosine: 0.65, standoutCosine: 0.5, standoutLead: 0.15 } },
  { id: "loose", label: "Loose", hint: "Finds more still, and about one note in twenty put in front of a prompt is not what you meant", tuning: { minCosine: 0.65, standoutCosine: 0.45, standoutLead: 0.1 } },
];
const BALANCED = (CLOSENESS[1] as (typeof CLOSENESS)[number]).tuning;

const sameTuning = (a: Tuning, b: Tuning): boolean => a.minCosine === b.minCosine && a.standoutCosine === b.standoutCosine && a.standoutLead === b.standoutLead;

interface Draft {
  baseUrl: string;
  model: string;
  queryPrefix: string;
  apiKeyEnv: string;
  tuning: Tuning;
}

const BLANK: Draft = { baseUrl: "", model: "", queryPrefix: "", apiKeyEnv: "", tuning: BALANCED };

const FIELD = "h-8 w-72 max-w-full rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus";

/**
 * Notes found by what they mean. It is off until a model is named, and it is the one thing that sends the text of notes
 * and of questions anywhere, so this says where, says it can be a model on this computer, and shows how far it has got.
 */
export function MeaningSearch(props: { bump: number; changed: () => void }) {
  const call = useAssistantCall();
  const [tick, setTick] = useState(0);
  const status = useAssistantData<AssistantEmbeddingsView>("/embeddings", props.bump + tick);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState<AssistantEmbeddingTestView | null>(null);
  const seeded = useRef(false);
  const data = status.data;

  // What was saved fills the form once, and never over what the person is typing.
  useEffect(() => {
    if (!data || seeded.current) return;
    seeded.current = true;
    if (data.configured) {
      setDraft({
        baseUrl: data.baseUrl,
        model: data.model,
        queryPrefix: data.queryPrefix,
        apiKeyEnv: data.apiKeyEnv ?? "",
        tuning: { minCosine: data.minCosine, standoutCosine: data.standoutCosine, standoutLead: data.standoutLead },
      });
    }
  }, [data]);

  // While notes are still being read, look again; an answer that has stopped changing stops the looking.
  useEffect(() => {
    if (!data?.configured || data.pending === 0 || data.paused) return;
    const id = setTimeout(() => setTick((t) => t + 1), 2000);
    return () => clearTimeout(id);
  }, [data, tick]);

  const valid = /^https?:\/\/\S+$/.test(draft.baseUrl.trim()) && draft.model.trim() !== "";
  const body = () => ({
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    queryPrefix: draft.queryPrefix,
    apiKeyEnv: draft.apiKeyEnv.trim(),
    ...draft.tuning,
  });
  // The preset the numbers are, or "custom" for numbers someone set by hand in the file.
  const preset = CLOSENESS.find((c) => sameTuning(c.tuning, draft.tuning))?.id ?? "custom";

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const tryIt = () =>
    run(async () => {
      setTried(await call<AssistantEmbeddingTestView>("POST", "/embeddings/test", body()));
    });
  const save = () =>
    run(async () => {
      await call("PATCH", "/embeddings", body());
      setTried(null);
      setTick((t) => t + 1);
      props.changed();
    });
  const turnOff = () =>
    run(async () => {
      await call("DELETE", "/embeddings");
      seeded.current = true;
      setDraft(BLANK);
      setTried(null);
      setOpen(false);
      setTick((t) => t + 1);
      props.changed();
    });

  const on = data?.configured === true;
  const total = (data?.indexed ?? 0) + (data?.pending ?? 0);
  const progress = !data
    ? ""
    : !on
      ? "Off. Notes are found by the words they share with what you ask."
      : data.pending > 0
        ? `${data.indexed} of ${total} notes can be found by meaning so far.`
        : `${data.indexed} ${data.indexed === 1 ? "note" : "notes"} can be found by meaning.`;

  return (
    <Section title="Find notes by meaning">
      <Row
        label="Meaning search"
        description="Without it, a note is found only when it shares a word with what you ask. With a text-embedding model, “what do I drive?” also finds “drives a Subaru”. The model is yours to name and can run on this computer; nothing is sent until you do."
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted" role="status">
            {progress}
          </span>
          <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)}>
            {open ? "Close" : on ? "Change" : "Set up"}
          </Button>
          {on ? (
            <Button size="sm" variant="danger" onClick={() => void turnOff()} disabled={busy}>
              Turn off
            </Button>
          ) : null}
        </div>
      </Row>
      {on && data?.paused ? (
        <div className="px-4 pb-3">
          <Notice>The model is not answering{data.error ? ` (${data.error})` : ""}. Turns go on with words alone, and it is tried again shortly.</Notice>
        </div>
      ) : null}
      {on && data && data.skipped > 0 ? (
        <div className="px-4 pb-3">
          <Notice>
            {data.skipped} {data.skipped === 1 ? "note was" : "notes were"} refused by the model and {data.skipped === 1 ? "is" : "are"} found by words only.
          </Notice>
        </div>
      ) : null}
      {open ? (
        <div className="space-y-3 border-t border-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Start from</span>
            {PRESETS.map((p) => (
              <Button key={p.id} size="xs" variant="secondary" onClick={() => setDraft({ ...draft, baseUrl: p.baseUrl, model: p.model, queryPrefix: p.queryPrefix })}>
                {p.label}
              </Button>
            ))}
          </div>
          <label className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="w-28 shrink-0">Server address</span>
            <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} aria-label="Embedding server address" placeholder="http://127.0.0.1:8080/v1" className={FIELD} />
          </label>
          <label className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="w-28 shrink-0">Model name</span>
            <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} aria-label="Embedding model name" placeholder="qwen3-embedding" className={FIELD} />
          </label>
          <label className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="w-28 shrink-0">Key variable</span>
            <input value={draft.apiKeyEnv} onChange={(e) => setDraft({ ...draft, apiKeyEnv: e.target.value })} aria-label="Name of the environment variable that holds the key" placeholder="only if the server wants a key" className={FIELD} />
            {draft.apiKeyEnv.trim() !== "" && data?.configured && data.apiKeyEnv === draft.apiKeyEnv.trim() ? <span>{data.keyPresent ? "is set" : "is not set where Ancilla runs"}</span> : null}
          </label>
          <label className="flex flex-wrap items-start gap-2 text-xs text-muted">
            <span className="w-28 shrink-0 pt-1.5">Before a question</span>
            <textarea
              value={draft.queryPrefix}
              rows={2}
              onChange={(e) => setDraft({ ...draft, queryPrefix: e.target.value })}
              aria-label="Text some models want in front of a question"
              placeholder="only for models that ask for it"
              className="w-72 max-w-full rounded-lg bg-sunken px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="w-28 shrink-0">How close</span>
            <Pick<string>
              value={preset}
              options={[...CLOSENESS.map((c) => ({ value: c.id, label: c.label, hint: c.hint })), ...(preset === "custom" ? [{ value: "custom", label: "Custom", hint: "Numbers set by hand in embeddings.json" }] : [])]}
              onChange={(id) => {
                const chosen = CLOSENESS.find((c) => c.id === id);
                if (chosen) setDraft({ ...draft, tuning: chosen.tuning });
              }}
            />
          </div>
          <p className="text-xs text-muted">
            The text of your notes and of what you ask goes to this address and nowhere else. Anything that looks like a password or a key is never sent. Vectors are kept beside your notes, are erased with them, and all of them are erased when this is turned off.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" disabled={!valid || busy} onClick={() => void tryIt()}>
              Try it
            </Button>
            <Button size="sm" variant="accent" disabled={!valid || busy} onClick={() => void save()}>
              {on ? "Save changes" : "Turn on"}
            </Button>
            {tried ? (
              <span className="text-xs text-muted" role="status">
                {tried.ok ? `It works: ${tried.dimensions} numbers per note, ${tried.ms} ms.` : `It did not work: ${tried.error}`}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="px-4 pb-3">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
    </Section>
  );
}
