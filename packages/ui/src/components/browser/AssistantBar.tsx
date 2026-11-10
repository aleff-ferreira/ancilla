import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from "react";
import { useController } from "../../app/context.js";
import { errorMessage } from "../../client.js";
import { useAssistantCall } from "../assistant/api.js";
import { Chip, Notice } from "../assistant/parts.js";
import { Button } from "../ui/primitives.js";
import { ActionQuestionCard, type ActionAnswer } from "./ActionQuestion.js";
import { isActionQuestion, watchUrl, type Frame } from "./protocol.js";
import type { SocketLike } from "./session.js";
import { AssistantWatch, EMPTY_WATCH, type WatchView } from "./watch.js";

/**
 * The assistant's side of the Browser panel: while it browses, what it sees, what it did and the site it is waiting to open, with
 * the answers and a Stop; when it does not, a box to ask it to look something up and the sites you said yes or no to for good.
 * The panel's own tabs above are the person's and are never touched from here.
 */

export interface SiteRuleView {
  origin: string;
  decision: "allow" | "block";
  at: number;
}

export type SiteAnswer = "task" | "always" | "not-now" | "block";

export interface AssistantBarViewProps {
  watch: WatchView;
  canvasRef?: Ref<HTMLCanvasElement>;
  /** The saved rules, or null while they are not loaded. */
  sites: SiteRuleView[] | null;
  sitesOpen: boolean;
  draft: string;
  busy: boolean;
  error: string | null;
  onDraft(text: string): void;
  onAsk(): void;
  onStop(): void;
  onAnswer(answer: SiteAnswer): void;
  onAction(answer: ActionAnswer, folder?: string): void;
  onToggleSites(): void;
  onRemove(origin: string): void;
}

export function AssistantBarView(props: AssistantBarViewProps) {
  const { watch, sites } = props;
  const job = watch.job;
  return (
    <section aria-label="The assistant's browsing" className="shrink-0 border-t border-line bg-raised">
      {job ? (
        <div className="space-y-2 px-3 py-2">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-fg">The assistant is browsing</p>
              <p className="truncate text-xs text-muted" title={job.goal}>
                {job.goal}
              </p>
            </div>
            <Button size="xs" variant="danger" disabled={props.busy} onClick={props.onStop}>
              Stop
            </Button>
          </div>
          {watch.tab ? <canvas ref={props.canvasRef} role="img" aria-label="What the assistant sees" className="aspect-[16/10] max-h-52 w-full rounded border border-line bg-sunken object-contain" /> : null}
          {job.steps.length > 0 ? (
            <ol aria-label="What it did" className="space-y-0.5 text-xs text-muted">
              {job.steps.slice(-4).map((step, i) => (
                <li key={`${i}-${step}`} className="truncate">
                  {step}
                </li>
              ))}
            </ol>
          ) : null}
          {job.question && isActionQuestion(job.question) ? <ActionQuestionCard question={job.question} busy={props.busy} onAnswer={props.onAction} /> : null}
          {job.question && !isActionQuestion(job.question) ? (
            <div role="group" aria-label="A site the assistant wants to open" className="space-y-1.5 rounded border border-line bg-bg p-2">
              <p className="text-xs text-fg [overflow-wrap:anywhere]">
                It wants to open <span className="font-medium">{job.question.origin}</span>
                {job.question.kind === "local" ? " (a page on this computer or your network)" : ""}. Allow it?
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Button size="xs" variant="accent" disabled={props.busy} onClick={() => props.onAnswer("task")}>
                  Allow for this task
                </Button>
                <Button size="xs" variant="secondary" disabled={props.busy} onClick={() => props.onAnswer("always")}>
                  Always allow
                </Button>
                <Button size="xs" variant="secondary" disabled={props.busy} onClick={() => props.onAnswer("not-now")}>
                  Not now
                </Button>
                <Button size="xs" variant="danger" disabled={props.busy} onClick={() => props.onAnswer("block")}>
                  Block
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <form
          className="flex items-center gap-2 px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            props.onAsk();
          }}
        >
          <input
            aria-label="Ask the assistant to look something up on the web"
            placeholder="Ask the assistant to look something up…"
            value={props.draft}
            onChange={(event) => props.onDraft(event.target.value)}
            className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs text-fg outline-none placeholder:text-subtle focus:border-accent"
          />
          <Button size="xs" variant="accent" type="submit" disabled={props.busy || props.draft.trim().length < 3}>
            Ask
          </Button>
        </form>
      )}
      {props.error ? (
        <div className="px-3 pb-2">
          <Notice tone="error">{props.error}</Notice>
        </div>
      ) : null}
      {!job ? (
        <div className="border-t border-line px-3 py-1.5">
          <button type="button" aria-expanded={props.sitesOpen} onClick={props.onToggleSites} className="text-xs text-muted hover:text-fg">
            Sites it may open{sites ? ` (${sites.length})` : ""}
          </button>
          {props.sitesOpen ? (
            sites === null ? (
              <p className="mt-1 text-xs text-subtle">Loading…</p>
            ) : sites.length === 0 ? (
              <p className="mt-1 text-xs text-subtle">None saved. It asks before each new site.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {sites.map((rule) => (
                  <li key={rule.origin} className="flex items-center gap-2 text-xs">
                    <Chip tone={rule.decision === "block" ? "warn" : undefined}>{rule.decision === "allow" ? "Always allowed" : "Blocked"}</Chip>
                    <span className="min-w-0 flex-1 truncate text-fg" title={rule.origin}>
                      {rule.origin}
                    </span>
                    <Button size="xs" variant="ghost" disabled={props.busy} onClick={() => props.onRemove(rule.origin)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function AssistantBar() {
  const controller = useController();
  const call = useAssistantCall();
  const [watch, setWatch] = useState<WatchView>(EMPTY_WATCH);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sites, setSites] = useState<SiteRuleView[] | null>(null);
  const [sitesOpen, setSitesOpen] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const lastFrame = useRef<Frame | null>(null);
  const waiting = useRef<Frame | null>(null);
  const decoding = useRef(false);

  // The newest picture waiting is drawn; one still waiting when a newer comes is dropped, so a slow machine shows the latest.
  const draw = useCallback(() => {
    if (decoding.current) return;
    decoding.current = true;
    void (async () => {
      while (waiting.current) {
        const next = waiting.current;
        waiting.current = null;
        const target = canvas.current;
        if (!target) continue;
        try {
          const bitmap = await createImageBitmap(new Blob([next.jpeg as BlobPart], { type: "image/jpeg" }));
          if (target.width !== bitmap.width || target.height !== bitmap.height) {
            target.width = bitmap.width;
            target.height = bitmap.height;
          }
          target.getContext("2d")?.drawImage(bitmap, 0, 0);
          bitmap.close();
        } catch {
          /* a picture that cannot be decoded is skipped */
        }
      }
      decoding.current = false;
    })();
  }, []);

  const session = useMemo(
    () =>
      new AssistantWatch({
        url: () => watchUrl(controller.browserSocketUrl()),
        open: (url) => new WebSocket(url) as unknown as SocketLike,
        onChange: setWatch,
        onFrame: (frame, done) => {
          done();
          lastFrame.current = frame;
          waiting.current = frame;
          draw();
        },
        retryMs: 3000,
      }),
    [controller, draw],
  );

  useEffect(() => {
    session.connect();
    return () => session.disconnect();
  }, [session]);

  // The canvas only exists while there is a task and a tab: the last picture is drawn again when it appears, so a page that is
  // not changing is not left blank.
  const hasJob = watch.job !== null;
  useEffect(() => {
    if (watch.tab && lastFrame.current && lastFrame.current.tabId === watch.tab) {
      waiting.current = lastFrame.current;
      draw();
    }
  }, [watch.tab, hasJob, draw]);

  const run = async (work: () => Promise<void>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const job = watch.job;
  return (
    <AssistantBarView
      watch={watch}
      canvasRef={canvas}
      sites={sites}
      sitesOpen={sitesOpen}
      draft={draft}
      busy={busy}
      error={error}
      onDraft={setDraft}
      onAsk={() =>
        void run(async () => {
          await call("POST", "/browse", { goal: draft.trim() });
          setDraft("");
        })
      }
      onStop={() => void run(async () => void (job && (await call("POST", `/tasks/${encodeURIComponent(job.taskId)}/cancel`, {}))))}
      onAnswer={(answer) => void run(async () => void (job && (await call("POST", `/tasks/${encodeURIComponent(job.taskId)}/site`, { answer }))))}
      onAction={(answer, folder) => void run(async () => void (job && (await call("POST", `/tasks/${encodeURIComponent(job.taskId)}/action`, folder ? { answer, folder } : { answer }))))}
      onToggleSites={() => {
        const next = !sitesOpen;
        setSitesOpen(next);
        if (next) void run(async () => setSites((await call<{ rules: SiteRuleView[] }>("GET", "/browse/sites")).rules));
      }}
      onRemove={(origin) => void run(async () => setSites((await call<{ rules: SiteRuleView[] }>("DELETE", "/browse/sites", { origin })).rules))}
    />
  );
}
