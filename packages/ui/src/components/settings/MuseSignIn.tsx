import { useApp, useController } from "../../app/context.js";
import { ArrowSquareOutIcon, ArrowsClockwiseIcon, CheckCircleIcon, SignInIcon, WarningIcon } from "../ui/icons.js";
import { CopyButton } from "../ui/Markdown.js";
import { Modal } from "../ui/overlays.js";
import { Button, Spinner } from "../ui/primitives.js";

export function MuseApiKeyNotice() {
  const inherited = useApp((s) => s.metaApiKeyInherited);
  if (!inherited) return null;
  return (
    <div className="rounded-lg border border-line bg-warn-soft p-3 text-sm text-warn-text">
      <p className="flex items-center gap-2 font-medium"><WarningIcon size={15} /> An API key is overriding browser sign-in</p>
      <p className="mt-1 leading-relaxed">
        Muse uses <code className="font-mono text-xs">META_API_KEY</code> before a browser login, including for named accounts.
        To use your subscription, remove this variable from the environment that starts Muse, then restart Ancilla.
        Separately created API keys use pay-as-you-go billing.
      </p>
    </div>
  );
}

/** The same default subscription entry point on Home and in Settings; named profiles remain optional. */
export function MuseSubscriptionCard() {
  const controller = useController();
  const identity = useApp((s) => s.defaultLogin);
  const hasLogin = identity?.hasLogin === true;
  const apiKey = useApp((s) => s.metaApiKeyInherited);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-fg">Your Muse Code subscription</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {hasLogin
              ? `${identity.email ? `Signed in as ${identity.email}.` : "Muse has a saved login."} Ancilla uses this login for threads on Default login.`
              : "Connect the Meta account that owns your Muse Code plan. No API key or extra Ancilla subscription is needed."}
          </p>
          {!hasLogin && identity?.hasLogin !== false ? (
            <p className="mt-1 text-xs leading-relaxed text-subtle">Already signed in through Muse? Ancilla reuses that login; some credential stores cannot report it here.</p>
          ) : null}
        </div>
        <Button size="sm" variant={hasLogin ? "secondary" : "primary"} onClick={() => void controller.beginLogin(null)}>
          <SignInIcon size={14} /> {hasLogin ? "Sign in again" : "Sign in with Meta"}
        </Button>
      </div>
      {apiKey ? <MuseApiKeyNotice /> : null}
      {!hasLogin ? (
        <p className="text-xs leading-relaxed text-subtle">A browser page opens when you choose Open Meta sign-in. Approve access there, then return to Ancilla for confirmation.</p>
      ) : null}
    </div>
  );
}

/** Mounted once above the app shell so sign-in works during setup and from any account entry point. */
export function DeviceLoginModal() {
  const controller = useController();
  const login = useApp((s) => s.accountLogin);
  const accounts = useApp((s) => s.accounts);
  const name = login?.accountId ? accounts?.find((a) => a.id === login.accountId)?.name ?? login.accountId : "Default login";
  const device = login && "status" in login ? login : null;
  const done = device?.status === "done";
  const starting = device?.status === "starting";
  const needsRetry = device?.status === "error" || device?.status === "timeout";
  return (
    <Modal
      open={login !== null}
      onOpenChange={(open) => !open && controller.cancelLogin()}
      title={done ? "Muse sign-in confirmed" : "Connect your Muse Code plan"}
      description={`Account: ${name}`}
      className="top-[6vh] max-h-[88dvh] w-[min(560px,calc(100%-32px))] overflow-y-auto"
    >
      {login && "fallback" in login ? (
        <div className="mt-4 space-y-4">
          <p className="text-sm leading-relaxed text-muted">{login.fallback}</p>
          <p className="text-xs leading-relaxed text-subtle">Use the Meta account that owns your Muse Code subscription. Muse manages the saved credential.</p>
          <div className="flex justify-end"><Button variant="secondary" onClick={() => controller.cancelLogin()}>Close</Button></div>
        </div>
      ) : null}
      {device ? (
        <div className="mt-4 flex flex-col gap-4">
          <MuseApiKeyNotice />
          {done ? (
            <>
              <p role="status" className="flex items-start gap-2 text-sm text-fg"><CheckCircleIcon size={18} className="mt-0.5 shrink-0 text-ok-text" /> Muse confirmed your browser sign-in.</p>
              <p className="text-sm leading-relaxed text-muted">
                {device.accountId ? `Choose ${name} beside the model picker when starting a new thread. Existing threads keep their account.` : "Open a project and start a thread. Ancilla will use your default Muse login."}
                {" "}Reported subscription limits appear in Usage after Muse receives a quota reading.
              </p>
              <div className="flex justify-end"><Button variant="primary" onClick={() => controller.cancelLogin()}>Continue</Button></div>
            </>
          ) : starting ? (
            <>
              <p role="status" className="flex items-center gap-2 text-sm text-muted"><Spinner size={14} /> Asking Muse for a sign-in code…</p>
              <p className="text-xs leading-relaxed text-subtle">This can take up to 30 seconds. Keep Ancilla open; the browser link will appear here.</p>
              <div className="flex justify-end"><Button variant="ghost" onClick={() => controller.cancelLogin()}>Cancel</Button></div>
            </>
          ) : (
            <>
              {needsRetry ? (
                <div role="alert" className="rounded-lg border border-line bg-warn-soft p-3 text-sm leading-relaxed text-warn-text">{device.message ?? "Sign-in was not confirmed. Start again for a new code."}</div>
              ) : null}
              {device.url ? (
                <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm leading-relaxed text-muted">
                  <li><span className="text-fg">Open Meta sign-in.</span> Use the same Meta account that owns your Muse Code subscription.</li>
                  <li>
                    <span className="text-fg">{device.code ? "Check or enter this code, then approve access." : "Approve Muse Code access in the browser."}</span>
                    {device.code ? (
                      <div className="mt-2 flex w-fit max-w-full items-center gap-3 rounded-lg border border-line bg-sunken py-2 pr-2 pl-3">
                        <code className="break-all font-mono text-lg tracking-wide text-fg" aria-label={`Sign-in code: ${device.code}`}>{device.code}</code>
                        <CopyButton text={device.code} label="Copy sign-in code" />
                      </div>
                    ) : null}
                    <p className="mt-1 text-xs text-subtle">Finish any account setup requested by Meta. For your existing plan, use browser sign-in instead of creating another API key.</p>
                  </li>
                  <li><span className="text-fg">Return to Ancilla.</span> This window confirms when Muse finishes signing in.</li>
                </ol>
              ) : (
                <p className="text-sm leading-relaxed text-muted">Retry to get a browser link. Check that Muse is installed and this computer can reach Meta.</p>
              )}
              {device.status === "waiting" ? <p role="status" className="flex items-center gap-2 text-xs text-subtle"><Spinner size={12} /> Waiting for browser approval…</p> : null}
              <p className="text-xs leading-relaxed text-subtle">Enter your password only on Meta&apos;s page. Muse stores the resulting credential; Ancilla does not ask you to paste it.</p>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" onClick={() => controller.cancelLogin()}>Cancel</Button>
                {needsRetry ? <Button variant="secondary" onClick={() => void controller.beginLogin(device.accountId)}>Start again</Button> : null}
                {device.url && device.status !== "error" ? <Button variant="secondary" onClick={() => void controller.checkLogin()}><ArrowsClockwiseIcon size={14} /> Check sign-in</Button> : null}
                {device.url && !needsRetry ? (
                  <a href={device.url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center justify-center gap-2 rounded-lg bg-inverse px-3 text-sm font-medium text-inverse-fg outline-offset-4 hover:opacity-90"><ArrowSquareOutIcon size={14} /> Open Meta sign-in</a>
                ) : null}
              </div>
              {device.url && !needsRetry ? (
                <details className="text-xs text-subtle">
                  <summary className="cursor-pointer">Browser did not open?</summary>
                  <div className="mt-2 flex items-center gap-2"><span className="min-w-0 flex-1 break-all">{device.url}</span><CopyButton text={device.url} label="Copy sign-in link" /></div>
                  <p className="mt-2">Paste this link in your browser, complete sign-in, then choose Check sign-in above.</p>
                </details>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
