import { useEffect, useState } from "react";
import { useNow } from "../../app/context.js";
import { errorMessage } from "../../client.js";
import type { AssistantConnectorActivity, AssistantConnectorView, AssistantConnectorsView, AssistantWriteCard, AssistantWriteClass } from "../../types.js";
import { Row, Section } from "../settings/SettingsPage.js";
import { Button, Toggle, cn } from "../ui/primitives.js";
import { ago, useAssistantCall, useAssistantData } from "./api.js";
import { activityLine, mayChange, reachNote, statusOf, tokenLooksUsable, WRITE_CLASSES } from "./connectors.js";
import { Chip, Notice } from "./parts.js";
import { WriteCardView } from "./WriteCard.js";

const INPUT = "h-8 w-full min-w-0 rounded-lg border border-line bg-sunken px-2.5 text-sm text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus";
const SELECT = "h-7 rounded-lg border border-line bg-sunken px-2 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50";
const LINK = "text-accent-text underline-offset-2 hover:underline";

function ConnectorMark(props: { id: string; name: string }) {
  switch (props.id) {
    case "github":
      return (
        <span aria-hidden="true" className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-line-strong/70 bg-sunken text-fg">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0.5a7.5 7.5 0 0 0-2.37 14.62c.37.07.5-.16.5-.36v-1.3c-2.09.46-2.53-.9-2.53-.9-.34-.87-.84-1.1-.84-1.1-.68-.47.05-.46.05-.46.76.05 1.16.78 1.16.78.67 1.15 1.76.82 2.2.63.07-.49.26-.82.48-1.01-1.67-.19-3.42-.83-3.42-3.71 0-.82.29-1.49.77-2.02-.08-.19-.33-.96.07-2 0 0 .63-.2 2.06.77a7.15 7.15 0 0 1 3.76 0c1.43-.97 2.06-.77 2.06-.77.4 1.04.15 1.81.07 2 .48.53.77 1.2.77 2.02 0 2.89-1.76 3.52-3.43 3.7.27.24.51.7.51 1.42v2.1c0 .2.13.44.51.36A7.5 7.5 0 0 0 8 0.5Z" />
          </svg>
        </span>
      );
    case "gmail":
      return (
        <span aria-hidden="true" className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-line bg-sunken text-[oklch(0.68_0.18_25)]">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.75" y="3" width="12.5" height="10" rx="1.75" />
            <path d="m2.25 4.25 5.75 4.5 5.75-4.5" />
          </svg>
        </span>
      );
    case "google_drive":
      return (
        <span aria-hidden="true" className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-line bg-sunken text-[oklch(0.72_0.15_155)]">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5.6 2.2h4.8l4.1 7.1-2.4 4.3H3.9L1.5 9.3 5.6 2.2Z" />
            <path d="M5.6 2.2 10.4 9.3H1.5" />
            <path d="m10.4 9.3-2.5 4.3" />
          </svg>
        </span>
      );
    case "supabase":
      return (
        <span aria-hidden="true" className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-line bg-sunken text-[oklch(0.75_0.17_158)]">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9.1 1.4c.4-.5 1.2-.2 1.2.4v5.1h3.6c.6 0 .9.7.5 1.2l-5.5 6.5c-.4.5-1.2.2-1.2-.4V9.1H4.1c-.6 0-.9-.7-.5-1.2l5.5-6.5Z" />
          </svg>
        </span>
      );
    case "brevo":
      return (
        <span aria-hidden="true" className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-line bg-sunken text-[oklch(0.72_0.14_175)]">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 2.5h4.5a2.75 2.75 0 0 1 0 5.5H4V2.5Z" />
            <path d="M4 8h5.25a2.75 2.75 0 0 1 0 5.5H4V8Z" />
          </svg>
        </span>
      );
    case "hostinger":
      return (
        <span aria-hidden="true" className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-line bg-sunken text-[oklch(0.7_0.17_292)]">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.5 2.5v11M12.5 2.5v11M3.5 8h9" />
          </svg>
        </span>
      );
    default:
      return (
        <span aria-hidden="true" className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-line bg-sunken text-[10px] font-semibold text-fg")}>
          {props.name.slice(0, 1).toUpperCase()}
        </span>
      );
  }
}

type Busy = "connect" | "test" | "mode" | "policy" | "disconnect" | "ask" | "oauth-client" | "oauth-start" | "oauth-callback";

export interface CardState {
  token: string;
  goal: string;
  busy: Busy | null;
  error: string | null;
  note: string | null;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthCallback?: string;
  oauthPendingUrl?: string | null;
}

export interface CardHandlers {
  token(value: string): void;
  goal(value: string): void;
  connect(): void;
  test(): void;
  mode(on: boolean): void;
  policy(kind: AssistantWriteClass, value: "off" | "ask" | "always"): void;
  disconnect(): void;
  ask(): void;
  oauthClientId?(value: string): void;
  oauthClientSecret?(value: string): void;
  oauthCallback?(value: string): void;
  saveOAuthClient?(): void;
  clearOAuthClient?(): void;
  startOAuth?(): void;
  completeOAuth?(): void;
}

/**
 * Accounts the assistant can work in. A connector is connected with a token you make yourself, so that you can make it small.
 * It starts read only; each kind of change (a small one you can undo, one other people see, one that cannot be taken back) is
 * switched on by you, and the assistant then shows you every change, with every detail, and does nothing until you say so. The
 * token is typed here once and never shown again.
 */
export function ConnectorsPanel(props: { changed: () => void; bump: number }) {
  const data = useAssistantData<AssistantConnectorsView>("/connectors", props.bump);
  const activity = useAssistantData<{ entries: AssistantConnectorActivity[] }>("/connectors/activity?limit=30", props.bump);
  const proposals = useAssistantData<{ proposals: AssistantWriteCard[] }>("/connectors/proposals", props.bump);
  const now = useNow(30_000);
  const views = data.data?.connectors ?? [];
  const nameOf = (id: string): string => views.find((v) => v.id === id)?.name ?? id;
  return (
    <div>
      <div className="mt-6">
        <Notice>
          Connect an account with a token you make yourself, and the assistant can look things up in it by voice or in text. It starts read only. Under each account you can switch on the kinds of change it may ask for: it then shows you each change, with every detail, and nothing is done until you say so. What it reads goes to the model that answers, like anything you say to it, so with a model on the internet it leaves this computer. Tokens are kept in {data.data?.storage ?? "a file on this computer"}.
        </Notice>
      </div>
      {data.error && !data.data ? <div className="mt-6"><Notice tone="error">{data.error}</Notice></div> : null}
      <ProposalList cards={proposals.data?.proposals ?? []} changed={props.changed} />
      {views.map((view) => (
        <ConnectorCard key={view.id} view={view} changed={props.changed} />
      ))}
      <ActivityList entries={activity.data?.entries ?? []} now={now} nameOf={nameOf} />
    </div>
  );
}

/** Changes that no one was there to look at (a task nobody started in person): they wait here, and run only when this very card is approved. */
export function ProposalList(props: { cards: AssistantWriteCard[]; changed: () => void }) {
  const call = useAssistantCall();
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  if (props.cards.length === 0 && !outcome && !error) return null;
  const answer = async (card: AssistantWriteCard, choice: string): Promise<void> => {
    setError(null);
    try {
      const reply = await call<{ done: boolean; text: string }>("POST", `/connectors/proposals/${encodeURIComponent(card.id)}`, { answer: choice });
      setOutcome(reply.done ? `Done: ${reply.text}` : reply.text);
    } catch (e) {
      setError(errorMessage(e));
    }
    props.changed();
  };
  return (
    <Section title="Waiting for you">
      {props.cards.map((card) => (
        <div key={card.id} className="border-t border-line px-4 py-3 first:border-t-0">
          <WriteCardView card={card} onAnswer={(choice) => void answer(card, choice)} />
        </div>
      ))}
      {outcome ? <p className="border-t border-line px-4 py-3 text-xs text-muted [overflow-wrap:anywhere]">{outcome}</p> : null}
      {error ? (
        <div className="border-t border-line px-4 py-3">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : null}
    </Section>
  );
}

/** One account: its state held here, what it looks like in `ConnectorCardView`. */
function ConnectorCard(props: { view: AssistantConnectorView; changed: () => void }) {
  const call = useAssistantCall();
  const { view } = props;
  const [state, setState] = useState<CardState>({
    token: "",
    goal: "",
    busy: null,
    error: null,
    note: null,
    oauthClientId: "",
    oauthClientSecret: "",
    oauthCallback: "",
    oauthPendingUrl: null,
  });
  const patch = (next: Partial<CardState>): void => setState((s) => ({ ...s, ...next }));
  const oauthWaiting = !view.connected && Boolean(view.oauth?.pending || state.oauthPendingUrl);
  useEffect(() => {
    if (!oauthWaiting || typeof window === "undefined") return;
    const refresh = (): void => props.changed();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 2500);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [oauthWaiting, props]);

  const run = async (busy: Busy, work: () => Promise<Partial<CardState> | void>): Promise<void> => {
    patch({ busy, error: null, note: null });
    try {
      patch({ ...((await work()) ?? {}), busy: null });
    } catch (error) {
      patch({ busy: null, error: errorMessage(error) });
    }
    props.changed();
  };
  const on: CardHandlers = {
    token: (token) => patch({ token }),
    goal: (goal) => patch({ goal }),
    oauthClientId: (oauthClientId) => patch({ oauthClientId }),
    oauthClientSecret: (oauthClientSecret) => patch({ oauthClientSecret }),
    oauthCallback: (oauthCallback) => patch({ oauthCallback }),
    connect: () =>
      void run("connect", async () => {
        await call("POST", `/connectors/${view.id}/connect`, { token: state.token.trim() });
        return { token: "", oauthPendingUrl: null };
      }),
    saveOAuthClient: () =>
      void run("oauth-client", async () => {
        await call("POST", `/connectors/${view.id}/oauth/client`, {
          clientId: (state.oauthClientId ?? "").trim(),
          clientSecret: (state.oauthClientSecret ?? "").trim(),
        });
        return { oauthClientId: "", oauthClientSecret: "", note: "Saved OAuth client. You can now sign in in your browser." };
      }),
    clearOAuthClient: () =>
      void run("oauth-client", async () => {
        await call("POST", `/connectors/${view.id}/oauth/client`, { clear: true });
        return { oauthPendingUrl: null };
      }),
    startOAuth: () =>
      void run("oauth-start", async () => {
        const started = await call<{ authorizeUrl: string }>(`POST`, `/connectors/${view.id}/oauth/start`, {});
        if (typeof window !== "undefined") {
          window.open(started.authorizeUrl, "_blank", "noopener,noreferrer");
        }
        return {
          oauthPendingUrl: started.authorizeUrl,
          note: "Opened sign-in in your browser. Finish there and return to Ancilla, or paste the callback URL below if signing in on another device.",
        };
      }),
    completeOAuth: () =>
      void run("oauth-callback", async () => {
        const raw = (state.oauthCallback ?? "").trim();
        await call("POST", `/connectors/${view.id}/oauth/callback`, raw.includes("://") ? { callbackUrl: raw } : { code: raw });
        return { oauthCallback: "", oauthPendingUrl: null, note: null };
      }),
    test: () => void run("test", async () => void (await call("POST", `/connectors/${view.id}/test`))),
    mode: (enabled) => void run("mode", async () => void (await call("PATCH", `/connectors/${view.id}`, { mode: enabled ? "read" : "off" }))),
    policy: (kind, value) => void run("policy", async () => void (await call("PATCH", `/connectors/${view.id}`, { policy: { [kind]: value } }))),
    disconnect: () =>
      void run("disconnect", async () => {
        const reply = await call<{ revoked?: boolean }>("DELETE", `/connectors/${view.id}`);
        return {
          oauthPendingUrl: null,
          note: reply.revoked
            ? "Removed from Ancilla, and access was revoked with the provider."
            : `Removed from Ancilla. ${view.revoke.text}`,
        };
      }),
    ask: () =>
      void run("ask", async () => {
        await call("POST", "/connectors/ask", { connector: view.id, goal: state.goal.trim() });
        return { goal: "", note: "Started. It is under Tasks, and you are told when it is done." };
      }),
  };
  return <ConnectorCardView view={view} state={state} on={on} />;
}

export function ConnectorCardView(props: { view: AssistantConnectorView; state: CardState; on: CardHandlers }) {
  const { view, state, on } = props;
  const status = statusOf(view);
  const busy = state.busy !== null;
  const reach = reachNote(view);
  return (
    <Section
      title={
        <>
          <ConnectorMark id={view.id} name={view.name} />
          <span>{view.name}</span>
        </>
      }
    >
      <Row
        label={
          <span className="flex flex-wrap items-center gap-2">
            <Chip tone={status.tone}>{status.label}</Chip>
            <span>{view.summary}</span>
          </span>
        }
      >
        {view.connected ? (
          <div className="flex flex-wrap items-center gap-2">
            <Toggle checked={view.mode === "read"} label={`Let the assistant use ${view.name}`} disabled={busy} onChange={on.mode} />
            <Button size="sm" variant="secondary" loading={state.busy === "test"} disabled={busy} onClick={on.test}>
              Test
            </Button>
            <Button size="sm" variant="ghost" loading={state.busy === "disconnect"} disabled={busy} onClick={on.disconnect}>
              Disconnect
            </Button>
          </div>
        ) : null}
      </Row>

      {!view.connected && view.oauth ? (
        <Row label="Sign in with OAuth" description={view.oauth.recipe}>
          {!view.oauth.clientConfigured ? (
            <form
              className="flex w-full min-w-0 flex-col gap-2 @min-[520px]:w-80"
              onSubmit={(event) => {
                event.preventDefault();
                if ((state.oauthClientId ?? "").trim().length >= 4 && !busy) on.saveOAuthClient?.();
              }}
            >
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                aria-label={`${view.name}: OAuth Client ID`}
                placeholder="OAuth Client ID"
                value={state.oauthClientId ?? ""}
                onChange={(event) => on.oauthClientId?.(event.currentTarget.value)}
                className={INPUT}
              />
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={`${view.name}: OAuth Client Secret (optional for PKCE)`}
                placeholder="Client Secret (if issued)"
                value={state.oauthClientSecret ?? ""}
                onChange={(event) => on.oauthClientSecret?.(event.currentTarget.value)}
                className={INPUT}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  loading={state.busy === "oauth-client"}
                  disabled={busy || (state.oauthClientId ?? "").trim().length < 4}
                >
                  Save OAuth client
                </Button>
                <a className={`text-xs ${LINK}`} href={view.oauth.helpUrl} target="_blank" rel="noreferrer">
                  Create OAuth client
                </a>
              </div>
            </form>
          ) : (
            <div className="flex w-full min-w-0 flex-col gap-2 @min-[520px]:w-80">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="accent"
                  loading={state.busy === "oauth-start"}
                  disabled={busy}
                  onClick={() => on.startOAuth?.()}
                >
                  Sign in in browser
                </Button>
                {!view.oauth.clientFromEnv ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={state.busy === "oauth-client"}
                    disabled={busy}
                    onClick={() => on.clearOAuthClient?.()}
                  >
                    Change client
                  </Button>
                ) : null}
              </div>
              {view.oauth.pending || state.oauthPendingUrl ? (
                <form
                  className="flex flex-wrap items-center gap-2 pt-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if ((state.oauthCallback ?? "").trim() !== "" && !busy) on.completeOAuth?.();
                  }}
                >
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`${view.name}: Paste callback URL`}
                    placeholder="Paste redirect URL if on another device"
                    value={state.oauthCallback ?? ""}
                    onChange={(event) => on.oauthCallback?.(event.currentTarget.value)}
                    className={`${INPUT} flex-1`}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="secondary"
                    loading={state.busy === "oauth-callback"}
                    disabled={busy || (state.oauthCallback ?? "").trim() === ""}
                  >
                    Finish
                  </Button>
                </form>
              ) : null}
            </div>
          )}
        </Row>
      ) : null}

      {!view.connected ? (
        <Row label="Connect with a token" description={view.token.recipe}>
          <form
            className="flex w-full min-w-0 flex-col gap-2 @min-[520px]:w-80"
            onSubmit={(event) => {
              event.preventDefault();
              if (tokenLooksUsable(state.token) && !busy) on.connect();
            }}
          >
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${view.name}: ${view.token.label}`}
              placeholder={view.token.label}
              value={state.token}
              onChange={(event) => on.token(event.currentTarget.value)}
              className={INPUT}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="sm" variant="accent" loading={state.busy === "connect"} disabled={busy || !tokenLooksUsable(state.token)}>
                Connect
              </Button>
              <a className={`text-xs ${LINK}`} href={view.token.helpUrl} target="_blank" rel="noreferrer">
                Make a token
              </a>
            </div>
          </form>
        </Row>
      ) : null}
      {!view.connected && view.caution ? (
        <div className="border-t border-line px-4 py-3">
          <Notice>{view.caution}</Notice>
        </div>
      ) : null}

      {view.connected ? (
        <Row label="What it can read" description={reach ?? view.test?.message ?? "Press Test to see what the assistant is given."}>
          {view.test && view.test.offered.length > 0 ? (
            <details className="w-full min-w-0 text-xs text-muted @min-[520px]:w-80">
              <summary className="cursor-pointer font-medium text-fg">
                {view.test.offered.length} tools, {view.test.offered.some((t) => t.class !== "read") ? `${view.test.offered.filter((t) => t.class !== "read").length} of them ask first` : "read only"}
              </summary>
              <ul className="mt-2 space-y-1.5 border-l-2 border-line pl-3">
                {view.test.offered.map((tool) => (
                  <li key={tool.name}>
                    <span className="font-mono text-fg">{tool.name}</span>: {tool.text}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Row>
      ) : null}
      {view.connected && view.test && !view.test.ok ? (
        <div className="border-t border-line px-4 py-3">
          <Notice tone="error">{view.test.message}</Notice>
        </div>
      ) : null}

      {view.connected && view.writeTools.length > 0 ? (
        <Row label="Changes it may ask for" description="Each starts off. Switch a kind on and the assistant may ask for it: you are shown the change, with every detail, and nothing is done until you say so. It needs a token that is allowed to make it.">
          <div className="flex w-full min-w-0 flex-col gap-2 @min-[520px]:w-80">
            {WRITE_CLASSES.filter((kind) => view.writeTools.some((tool) => tool.class === kind.id)).map((kind) => (
              <label key={kind.id} className="flex items-center justify-between gap-2 text-xs text-fg">
                <span className="min-w-0">
                  {kind.label}
                  <span className="block text-subtle">{view.writeTools.filter((tool) => tool.class === kind.id).map((tool) => tool.name).join(", ")}</span>
                </span>
                <select aria-label={`${view.name}: ${kind.label}`} value={view.policy[kind.id]} disabled={busy} onChange={(event) => on.policy(kind.id, event.currentTarget.value as "off" | "ask" | "always")} className={SELECT}>
                  <option value="off">Off</option>
                  <option value="ask">Ask me each time</option>
                  {view.policy[kind.id] === "always" ? <option value="always">Always</option> : null}
                </select>
              </label>
            ))}
            <details className="text-xs text-muted">
              <summary className="cursor-pointer font-medium text-fg">What each can do</summary>
              <ul className="mt-2 space-y-1.5 border-l-2 border-line pl-3">
                {view.writeTools.map((tool) => (
                  <li key={tool.name}>
                    <span className="font-mono text-fg">{tool.name}</span>: {tool.text}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </Row>
      ) : null}

      {view.connected && view.mode === "read" ? (
        <Row label={`Ask ${view.name}`} description={mayChange(view.policy) ? "It works in a task under Tasks. If you ask for a change, you are shown it first." : "It looks, and answers in a task under Tasks. It cannot change anything."}>
          <form
            className="flex w-full min-w-0 flex-wrap items-center gap-2 @min-[520px]:w-80"
            onSubmit={(event) => {
              event.preventDefault();
              if (state.goal.trim().length >= 3 && !busy) on.ask();
            }}
          >
            <input type="text" aria-label={`Ask ${view.name}`} placeholder="What is open on my account?" maxLength={1500} value={state.goal} onChange={(event) => on.goal(event.currentTarget.value)} className={`${INPUT} flex-1`} />
            <Button type="submit" size="sm" variant="secondary" loading={state.busy === "ask"} disabled={busy || state.goal.trim().length < 3}>
              Ask
            </Button>
          </form>
        </Row>
      ) : null}

      {state.error ? (
        <div className="border-t border-line px-4 py-3">
          <Notice tone="error">{state.error}</Notice>
        </div>
      ) : null}
      {state.note ? (
        <div className="border-t border-line px-4 py-3">
          <Notice>
            {state.note}{" "}
            {!view.connected ? (
              <a className={LINK} href={view.revoke.url} target="_blank" rel="noreferrer">
                Open that page
              </a>
            ) : null}
          </Notice>
        </div>
      ) : null}
    </Section>
  );
}

/** What the connectors did lately, newest first: when, which account, and what, in words. */
export function ActivityList(props: { entries: AssistantConnectorActivity[]; now: number; nameOf: (id: string) => string }) {
  return (
    <Section title="Activity">
      {props.entries.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted">Nothing yet. Every connection, check and read is written here, with the account, the tool and the task.</p>
      ) : (
        <ul>
          {props.entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="flex items-baseline justify-between gap-3 border-t border-line px-4 py-2 text-xs first:border-t-0">
              <span className={entry.ok ? "text-fg" : "text-warn-text"}>{activityLine(entry, props.nameOf)}</span>
              <span className="shrink-0 text-subtle">{ago(entry.at, props.now)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
