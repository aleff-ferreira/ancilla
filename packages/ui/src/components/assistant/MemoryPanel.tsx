import { useEffect, useState } from "react";
import { useNow } from "../../app/context.js";
import { errorMessage } from "../../client.js";
import type { AssistantActivityView, AssistantPreviewView, AssistantProfileView, MemoryDetailView, MemoryItemView, MemoryKind, MemoryListView } from "../../types.js";
import { PushPinIcon, PushPinSlashIcon } from "../ui/icons.js";
import { Modal } from "../ui/overlays.js";
import { Button, Toggle, cn } from "../ui/primitives.js";
import { Row, Section } from "../settings/SettingsPage.js";
import { Pick } from "../settings/SettingsPage.js";
import { KINDS, KIND_LABEL, ago, day, scopeLabel, useAssistantCall, useAssistantData } from "./api.js";
import { MeaningSearch } from "./MeaningSearch.js";
import { Chip, Notice } from "./parts.js";

type View = "active" | "attention" | "history";
const VIEWS: { value: View; label: string; hint: string }[] = [
  { value: "active", label: "Current", hint: "What the assistant believes now" },
  { value: "attention", label: "Needs you", hint: "Disputes and notes waiting for your approval" },
  { value: "history", label: "History", hint: "Beliefs that were replaced, kept with what replaced them" },
];

const BASIS: Record<MemoryItemView["basis"], string> = { explicit: "You said", observed: "Checked", inferred: "A guess" };

/** The memory: what the assistant keeps, where each note came from, and what you can do with it. */
export function MemoryPanel(props: { profile: AssistantProfileView; changed: () => void; bump: number }) {
  const call = useAssistantCall();
  const now = useNow(60_000);
  const [view, setView] = useState<View>("active");
  const [kind, setKind] = useState<MemoryKind | "">("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(30);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const params = new URLSearchParams({ status: view, limit: String(limit) });
  if (kind) params.set("kind", kind);
  if (search) params.set("q", search);
  const list = useAssistantData<MemoryListView>(`/memories?${params.toString()}`, props.bump);
  const attention = useAssistantData<MemoryListView>("/memories?status=attention&limit=1", props.bump);

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      props.changed();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const exportAll = () =>
    run(async () => {
      const data = await call<unknown>("GET", "/export");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `ancilla-assistant-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });

  const needs = attention.data?.total ?? 0;
  return (
    <div>
      <Section title="What it keeps">
        <Row
          label="Remember what I say"
          description="Reads your own words in threads for rules, preferences, decisions, deadlines and facts about you. Nothing from tools, files, web pages or the assistant's own words is read. Pausing stops new notes; what is saved keeps being used."
        >
          <Toggle
            checked={!props.profile.capturePaused}
            label="Remember what I say"
            onChange={(on) => void run(() => call("PATCH", "/profile", { capturePaused: !on, expectedUpdatedAt: props.profile.updatedAt }))}
          />
        </Row>
        <Row label="Add a note" description="Write one yourself. It is kept in your own words, with you as the source.">
          <Button size="sm" variant="secondary" onClick={() => setAdding((a) => !a)}>
            {adding ? "Close" : "Add a note"}
          </Button>
        </Row>
        {adding ? <AddNote onDone={() => { setAdding(false); props.changed(); }} /> : null}
        <Row label="Your copy" description="Everything it holds about you, with each note's earlier versions and sources, as a file. Erased notes are not in it.">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void exportAll()} disabled={busy}>
              Export
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void run(() => call("POST", "/consolidate", {}))} disabled={busy}>
              Tidy up
            </Button>
            <Button size="sm" variant="danger" onClick={() => setWiping(true)} disabled={busy}>
              Erase everything
            </Button>
          </div>
        </Row>
      </Section>
      {error ? <div className="mt-3"><Notice tone="error">{error}</Notice></div> : null}

      <Section title="Notes">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <Pick<View>
            value={view}
            options={VIEWS.map((v) => ({ ...v, label: v.value === "attention" && needs > 0 ? `${v.label} (${needs})` : v.label }))}
            onChange={(v) => {
              setView(v);
              setLimit(30);
              setOpen(null);
            }}
          />
          <select
            aria-label="Kind"
            value={kind}
            onChange={(e) => setKind(e.currentTarget.value as MemoryKind | "")}
            className="h-7 rounded-md bg-sunken px-2 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <option value="">All kinds</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <input
            type="search"
            aria-label="Search notes"
            placeholder="Search notes"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            className="h-7 min-w-32 flex-1 rounded-md bg-sunken px-2.5 text-xs text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus"
          />
        </div>
        {list.error ? <div className="p-4"><Notice tone="error">{list.error}</Notice></div> : null}
        {list.data && list.data.items.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">
            {view === "attention" ? "Nothing is waiting on you." : view === "history" ? "No belief has been replaced yet." : search || kind ? "No note matches." : "Nothing is saved yet. Say \"remember that...\" in a thread, or add a note above."}
          </p>
        ) : null}
        {list.data?.items.map((item) => (
          <NoteRow key={item.id} item={item} now={now} open={open === item.id} onToggle={() => setOpen(open === item.id ? null : item.id)} changed={props.changed} bump={props.bump} />
        ))}
        {list.data && list.data.total > list.data.items.length ? (
          <div className="border-t border-line px-4 py-3">
            <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + 30)}>
              Show more ({list.data.total - list.data.items.length} more)
            </Button>
          </div>
        ) : null}
      </Section>

      <MeaningSearch bump={props.bump} changed={props.changed} />
      <Preview />
      <Activity bump={props.bump} now={now} />

      <Modal open={wiping} onOpenChange={setWiping} title="Erase everything the assistant remembers?" description="Every note, every earlier version and every source is erased from the file, and anything read again from before now is refused. Your settings and goals stay. This cannot be undone; export first if you want a copy.">
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setWiping(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setWiping(false);
              void run(() => call("POST", "/wipe", { confirm: "wipe everything" }));
            }}
          >
            Erase everything
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function AddNote(props: { onDone: () => void }) {
  const call = useAssistantCall();
  const [text, setText] = useState("");
  const [pinned, setPinned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      await call("POST", "/memories", { text, pinned });
      props.onDone();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="space-y-2 border-t border-line px-4 py-3">
      <textarea
        aria-label="The note"
        rows={2}
        value={text}
        maxLength={2000}
        placeholder="never push to main without a review"
        onChange={(e) => setText(e.currentTarget.value)}
        className="w-full rounded-lg bg-sunken px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus"
      />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-muted">
          <Toggle checked={pinned} label="Keep it in every prompt" onChange={setPinned} />
          Keep it in every prompt
        </label>
        <Button size="sm" variant="accent" disabled={text.trim().length < 3} onClick={() => void save()}>
          Save the note
        </Button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

function NoteRow(props: { item: MemoryItemView; now: number; open: boolean; onToggle: () => void; changed: () => void; bump: number }) {
  const { item } = props;
  const stale = item.revalidateAfterMs !== null && props.now - item.lastConfirmedAt > item.revalidateAfterMs;
  return (
    <div className="border-t border-line first:border-t-0">
      <button type="button" aria-expanded={props.open} onClick={props.onToggle} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-hover">
        <Chip tone={item.kind === "constraint" ? "accent" : "plain"} className="@min-[520px]:w-20 @min-[520px]:justify-center">
          {KIND_LABEL[item.kind]}
        </Chip>
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-fg [overflow-wrap:anywhere]">{item.text}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span>{BASIS[item.basis]}</span>
            <span aria-hidden="true">·</span>
            <span title={new Date(item.observedAt).toLocaleString()}>{ago(item.observedAt, props.now)}</span>
            {item.scope.kind !== "global" ? <Chip title={item.scope.key}>{scopeLabel(item.scope)}</Chip> : null}
            {item.pinned ? <Chip tone="accent">In every prompt</Chip> : null}
            {item.status === "contested" ? <Chip tone="warn">Disputed</Chip> : null}
            {item.status === "pending" ? <Chip tone="warn">Waiting for you</Chip> : null}
            {item.status === "superseded" ? <Chip>Replaced</Chip> : null}
            {item.basis === "inferred" ? <Chip tone="warn">Unconfirmed guess</Chip> : null}
            {stale ? <Chip tone="warn" title="It is about something that changes, and it has not been confirmed lately">May be out of date</Chip> : null}
            {item.kind === "commitment" && item.dueAt !== null ? <Chip tone={item.dueAt < props.now ? "danger" : "plain"}>{item.commitment === "done" ? "Done" : `Due ${ago(item.dueAt, props.now)}`}</Chip> : null}
          </span>
        </span>
      </button>
      {props.open ? <NoteDetail id={item.id} now={props.now} changed={props.changed} bump={props.bump} /> : null}
    </div>
  );
}

function NoteDetail(props: { id: string; now: number; changed: () => void; bump: number }) {
  const call = useAssistantCall();
  const detail = useAssistantData<MemoryDetailView>(`/memories/${encodeURIComponent(props.id)}`, props.bump);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const d = detail.data;
  useEffect(() => setDraft(null), [d?.item.rev]);
  if (detail.error && !d) return <div className="px-4 pb-4"><Notice tone="error">{detail.error}</Notice></div>;
  if (!d) return <p className="px-4 pb-4 text-xs text-subtle">Loading...</p>;
  const { item } = d;
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      props.changed();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const base = `/memories/${encodeURIComponent(item.id)}`;
  const text = draft ?? item.text;
  const editable = item.status !== "superseded";
  return (
    <div className="space-y-4 px-4 pb-4">
      {editable ? (
        <div className="space-y-2">
          <textarea
            aria-label="The note, in your words"
            rows={Math.min(6, Math.max(2, Math.ceil(text.length / 70)))}
            value={text}
            maxLength={2000}
            onChange={(e) => setDraft(e.currentTarget.value)}
            className="w-full rounded-lg bg-sunken px-2.5 py-1.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="accent" disabled={draft === null || draft.trim() === item.text || draft.trim().length < 3} onClick={() => void act(() => call("PATCH", base, { text: (draft ?? "").trim(), rev: item.rev }))}>
              Save the change
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void act(() => call("POST", `${base}/${item.pinned ? "unpin" : "pin"}`, {}))}>
              {item.pinned ? <PushPinSlashIcon size={13} /> : <PushPinIcon size={13} />}
              {item.pinned ? "Stop keeping it in every prompt" : "Keep it in every prompt"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void act(() => call("POST", `${base}/confirm`, {}))}>
              Still true
            </Button>
            {item.kind === "commitment" ? (
              <Button size="sm" variant="secondary" onClick={() => void act(() => call("POST", `${base}/commitment`, { state: item.commitment === "done" ? "open" : "done" }))}>
                {item.commitment === "done" ? "Not done" : "Mark done"}
              </Button>
            ) : null}
            {item.status === "contested" ? (
              <Button size="sm" variant="accent" onClick={() => void act(() => call("POST", `${base}/settle`, {}))}>
                This one is right
              </Button>
            ) : null}
            {item.status === "pending" && d.mayCorrect.length === 0 ? (
              <Button size="sm" variant="accent" onClick={() => void act(() => call("POST", `${base}/approve`, {}))}>
                Keep this note
              </Button>
            ) : null}
            <Button size="sm" variant="danger" onClick={() => setForgetting(true)}>
              Forget
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted">This is an earlier version. It is kept as history; edit the current one.</p>
      )}
      {item.status === "pending" && d.mayCorrect.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted">This could replace one of these. Which one?</p>
          {d.mayCorrect.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-sunken px-3 py-2">
              <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{c.text}</span>
              <Button size="xs" variant="accent" onClick={() => void act(() => call("POST", `${base}/approve`, { replaces: c.id }))}>
                Replace this one
              </Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => void act(() => call("POST", `${base}/approve`, {}))}>
            Keep both
          </Button>
        </div>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Facts item={item} now={props.now} />
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted">Where it came from</h3>
        <ul className="space-y-1.5">
          {d.sources.map((s) => (
            <li key={s.id} className="rounded-lg bg-sunken px-3 py-2 text-xs">
              <span className="text-muted">
                {s.kind.replace("_", " ")}, {day(s.observedAt)}, {s.trust === "user" ? "you" : s.trust}
              </span>
              <span className="mt-0.5 block font-mono text-fg [overflow-wrap:anywhere]">{s.excerpt}</span>
            </li>
          ))}
          {d.sources.length === 0 ? <li className="text-xs text-subtle">No source is kept for this note.</li> : null}
        </ul>
      </div>
      {d.revisions.length > 1 ? (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted">Versions of the words</h3>
          <ul className="space-y-1">
            {d.revisions.map((r) => (
              <li key={r.rev} className="text-xs text-muted">
                <span className="tabular-nums">v{r.rev}</span> {day(r.createdAt)} by {r.actor === "user" ? "you" : r.actor}: <span className="text-fg [overflow-wrap:anywhere]">{r.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {d.lineage.length > 0 ? (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted">Replaced, or replaced by</h3>
          <ul className="space-y-1">
            {d.lineage.map((l) => (
              <li key={l.id} className="text-xs text-muted">
                {day(l.observedAt)} ({l.status}): <span className="text-fg [overflow-wrap:anywhere]">{l.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Modal open={forgetting} onOpenChange={setForgetting} title="Forget this note?" description="The words are erased everywhere the assistant kept them, with this note's earlier versions. It will not learn them again from old messages. You can tell it again later and it will remember that.">
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setForgetting(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setForgetting(false);
              void act(() => call("DELETE", base));
            }}
          >
            Forget it
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function Facts(props: { item: MemoryItemView; now: number }) {
  const { item } = props;
  const rows: [string, string][] = [
    ["Standing", `${BASIS[item.basis]}, confidence ${Math.round(item.confidence * 100)}%`],
    ["Said", `${new Date(item.observedAt).toLocaleString()} (${ago(item.observedAt, props.now)})`],
    ["Last confirmed", ago(item.lastConfirmedAt, props.now)],
    ["Applies", item.scope.kind === "global" ? "everywhere" : `${item.scope.kind}: ${item.scope.key}`],
  ];
  if (item.validTo !== null) rows.push(["Held until", new Date(item.validTo).toLocaleString()]);
  if (item.slot) rows.push(["Replaces earlier values of", item.slot.replace(/^user\./, "").replace(/\./g, " ")]);
  if (item.identifiers.length > 0) rows.push(["Exact details kept", item.identifiers.join(", ")]);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="text-fg [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What the model would be told for a question, before it is sent: the block, and why each note is in it. */
function Preview() {
  const call = useAssistantCall();
  const [text, setText] = useState("");
  const [out, setOut] = useState<AssistantPreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const show = async () => {
    setError(null);
    try {
      setOut(await call<AssistantPreviewView>("POST", "/preview", { text }));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Section title="What the model is told">
      <div className="space-y-3 px-4 py-3">
        <p className="text-xs text-muted">Type a question as you would send it. This shows the notes that would be put in front of it, and why. Nothing is sent.</p>
        <div className="flex gap-2">
          <input
            type="text"
            aria-label="A question to preview"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && text.trim()) void show();
            }}
            placeholder="where do the release notes go?"
            className="h-8 min-w-0 flex-1 rounded-lg bg-sunken px-2.5 text-sm text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus"
          />
          <Button size="md" variant="secondary" disabled={!text.trim()} onClick={() => void show()}>
            Show
          </Button>
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {out ? (
          <div className="space-y-2">
            <p className="text-xs text-muted">
              {out.wouldAdd ? `About ${out.tokens} tokens would be added.` : "Nothing would be added: no note applies and no identity or goal is set."}
              {out.noEvidence ? " It would be told that nothing saved answers this." : ""}
            </p>
            {out.memories.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                <Chip>{KIND_LABEL[m.kind]}</Chip>
                <span className="text-fg [overflow-wrap:anywhere]">{m.text}</span>
                {m.why.map((w) => (
                  <Chip key={w} tone={w === "tentative" || w === "may be out of date" ? "warn" : "plain"}>
                    {w}
                  </Chip>
                ))}
              </div>
            ))}
            {out.wouldAdd ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted">The exact block</summary>
                <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-sunken p-3 font-mono text-2xs whitespace-pre-wrap text-fg">{out.text}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function Activity(props: { bump: number; now: number }) {
  const [open, setOpen] = useState(false);
  const log = useAssistantData<{ activity: AssistantActivityView[] }>(open ? "/activity?limit=40" : null, props.bump);
  return (
    <Section title="What changed">
      <details className="px-4 py-3" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer text-sm text-muted">Every change to the memory, and who made it. It holds ids and rule names, never the words of a note.</summary>
        <ul className="mt-3 space-y-1">
          {log.data?.activity.map((a) => (
            <li key={a.id} className={cn("flex gap-3 text-xs text-muted")}>
              <span className="w-24 shrink-0 tabular-nums">{ago(a.at, props.now)}</span>
              <span className="text-fg">{a.action}</span>
              <span>by {a.actor}</span>
              {a.detail ? <span className="min-w-0 [overflow-wrap:anywhere]">{a.detail}</span> : null}
            </li>
          ))}
          {log.data && log.data.activity.length === 0 ? <li className="text-xs text-subtle">Nothing yet.</li> : null}
        </ul>
      </details>
    </Section>
  );
}
