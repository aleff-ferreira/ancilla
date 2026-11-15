import { useState, type ReactNode } from "react";
import { useApp, useController } from "../../app/context.js";
import { crewBusy } from "../../model/crew.js";
import { ArrowSquareOutIcon, ArrowsClockwiseIcon, CheckCircleIcon, DownloadSimpleIcon, MonitorIcon, WarningIcon } from "../ui/icons.js";
import { CopyButton } from "../ui/Markdown.js";
import { Button, Spinner, cn } from "../ui/primitives.js";
import { MuseSubscriptionCard } from "./MuseSignIn.js";

const LINK = "inline-flex min-h-8 items-center justify-center gap-2 rounded-lg bg-inverse px-3 py-1.5 text-sm font-medium text-inverse-fg outline-offset-4 hover:opacity-90";

function SetupSection(props: { title: string; ready?: boolean; children: ReactNode }) {
  return (
    <div className="border-t border-line py-4 first:border-t-0 first:pt-0 last:pb-0">
      <h3 className="flex items-center gap-2 text-sm font-medium text-fg">
        {props.ready ? <CheckCircleIcon size={16} className="shrink-0 text-ok-text" /> : null}
        {props.title}
      </h3>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-muted">{props.children}</div>
    </div>
  );
}

/** Local desktop integration remains available after first run, including for existing AppImages. */
function LinuxDesktopSetup(props: { firstRun: boolean }) {
  const controller = useController();
  const desktop = useApp((s) => s.linuxDesktop);
  const error = useApp((s) => s.linuxDesktopError);
  const version = useApp((s) => s.env?.version);
  const installing = useApp((s) => Boolean(s.busy["linux-desktop:install"]));
  const restarting = useApp((s) => Boolean(s.busy["linux-desktop:relaunch"]));
  const running = useApp((s) => s.linuxSetup?.installation.status === "installing" || Object.values(s.threads).some((thread) => crewBusy(thread.fold, thread.researchRuns)) || Object.values(s.sessions).some((session) => Boolean(session.live?.activeTurnId)));
  const [shortcut, setShortcut] = useState(true);
  if (!desktop && !error || desktop?.kind === "development") return null;
  const installed = desktop?.menuInstalled === true;
  const packaged = desktop?.kind === "package";
  const supportsShortcut = desktop?.desktopShortcutSupported === true;
  const wantsInstall = desktop?.canInstall && (!installed || supportsShortcut && !desktop.desktopShortcutInstalled);
  return (
    <SetupSection title="Ancilla in your applications" ready={installed}>
      <p>{installed
        ? "Open Ancilla from your application menu. You can pin its icon to your dock or favorites."
        : "Keep Ancilla in a permanent location and add its icon to your application menu. No administrator password is needed."}</p>
      {desktop?.restartRequired ? (
        <div className="space-y-2">
          <p className="text-xs text-subtle">Installation is ready. Relaunch the installed copy to finish; use the application menu next time.</p>
          <Button size="sm" variant="primary" loading={restarting} disabled={running || installing} onClick={() => void controller.relaunchLinuxDesktop()}>
            Relaunch installed Ancilla
          </Button>
          {running ? <p className="text-xs text-subtle">Let installation, running threads and background tasks finish before relaunching.</p> : null}
        </div>
      ) : null}
      {wantsInstall ? (
        <div className="space-y-3">
          {!installed && supportsShortcut ? (
            <label className="flex w-fit items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={shortcut} onChange={(event) => setShortcut(event.currentTarget.checked)} disabled={installing} className="size-3.5 accent-accent" />
              Also add a desktop shortcut
            </label>
          ) : null}
          <Button size="sm" variant={installed ? "secondary" : "primary"} loading={installing} onClick={() => void controller.installLinuxDesktop(supportsShortcut && (installed || shortcut))}>
            <MonitorIcon size={14} /> {installed ? "Add desktop shortcut" : "Install Ancilla for my account"}
          </Button>
        </div>
      ) : null}
      {desktop?.desktopShortcutInstalled ? (
        <p className="text-xs text-subtle">Desktop shortcut added. If your desktop asks, right-click it and choose Allow Launching. Desktops with icons disabled still show Ancilla in the application menu.</p>
      ) : null}
      {installed && !supportsShortcut ? <p className="text-xs text-subtle">This desktop does not show desktop shortcuts. Ancilla is available in your application menu.</p> : null}
      {error ? <p role="alert" className="text-warn-text">{error} <button type="button" className="underline underline-offset-2" onClick={() => void controller.refreshLinuxDesktop()}>Check again</button></p> : null}
      {packaged && !props.firstRun ? (
        <p className="text-xs text-subtle">Ancilla {version} was installed as a Linux package. To update, <a className="text-fg underline underline-offset-2" href="https://github.com/aleff-ferreira/ancilla/releases/latest" target="_blank" rel="noreferrer">download the latest Linux installer</a> and open it with your software installer.</p>
      ) : null}
    </SetupSection>
  );
}

/** Home shows only unfinished setup; Settings always exposes the same recovery controls. */
export function LinuxSetupCard(props: { firstRun?: boolean; showSubscription?: boolean; compact?: boolean }) {
  const controller = useController();
  const env = useApp((s) => s.env);
  const setup = useApp((s) => s.linuxSetup);
  const error = useApp((s) => s.linuxSetupError);
  const desktop = useApp((s) => s.linuxDesktop);
  const desktopError = useApp((s) => s.linuxDesktopError);
  const accountId = useApp((s) => s.linuxSetupAccountId);
  const accounts = useApp((s) => s.accounts);
  const busy = useApp((s) => s.busy);
  if (env?.platform !== "linux") return null;
  const installing = setup?.installation.status === "installing";
  const failed = setup?.installation.status === "error" || setup?.installation.status === "cancelled";
  const found = (env.museFound || setup?.museFound) && !installing && !failed;
  const storage = setup?.storage;
  const storageIssue = storage && storage.status !== "ready";
  const integrationNeeded = desktop?.kind === "appimage" && (!desktop.menuInstalled || desktop.restartRequired);
  const needsAttention = installing || !found || storageIssue || error || desktopError || integrationNeeded;
  if (props.compact && !needsAttention) return null;
  const mutation = Boolean(busy["linux-setup:install"] || busy["linux-setup:cancel"] || busy["linux-setup:repair"]);
  const accountName = accountId ? accounts?.find((account) => account.id === accountId)?.name ?? accountId : "Default login";
  return (
    <section aria-label="Linux setup" className="rounded-xl border border-line bg-raised p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium tracking-wide text-subtle uppercase">{props.firstRun ? "Get ready on Linux" : "Linux setup"}</h2>
        <Button size="xs" variant="ghost" loading={Boolean(busy["linux-setup:check"])} disabled={mutation} onClick={() => {
          void controller.refreshLinuxSetup();
          void controller.refreshLinuxDesktop();
        }}><ArrowsClockwiseIcon size={13} /> Check again</Button>
      </div>
      <LinuxDesktopSetup firstRun={props.firstRun === true} />
      {!props.compact || !found || installing ? (
        <SetupSection title={found && !installing ? "Muse Code is installed" : "Install Muse Code"} ready={found && !installing}>
          {installing ? (
            <>
              <p role="status" className="flex items-start gap-2"><Spinner size={13} className="mt-1" /> <span>{setup.installation.message || "Installing Muse Code…"}</span></p>
              {setup.installation.loginUrl ? (
                <div className="space-y-3">
                  <p>Meta needs your approval to download Muse. Open the link, sign in with the account that owns your Muse Code plan, then return here. Installation continues automatically.</p>
                  {setup.installation.loginCode ? (
                    <div className="flex w-fit max-w-full items-center gap-3 rounded-lg border border-line bg-sunken py-2 pr-2 pl-3">
                      <code className="break-all font-mono text-lg tracking-wide text-fg" aria-label={`Installation sign-in code: ${setup.installation.loginCode}`}>{setup.installation.loginCode}</code>
                      <CopyButton text={setup.installation.loginCode} label="Copy installation sign-in code" />
                    </div>
                  ) : null}
                  <a className={LINK} href={setup.installation.loginUrl} target="_blank" rel="noreferrer"><ArrowSquareOutIcon size={14} /> Open Meta sign-in</a>
                  <details className="text-xs text-subtle">
                    <summary className="cursor-pointer">Browser did not open?</summary>
                    <div className="mt-2 flex items-center gap-2"><span className="min-w-0 flex-1 break-all">{setup.installation.loginUrl}</span><CopyButton text={setup.installation.loginUrl} label="Copy installation sign-in link" /></div>
                    <p className="mt-2">Paste the link in your browser and approve access. Keep Ancilla open while setup finishes.</p>
                  </details>
                </div>
              ) : <p className="text-xs text-subtle">Keep Ancilla open. Setup will ask here if Meta needs browser approval.</p>}
              <Button size="sm" variant="ghost" loading={Boolean(busy["linux-setup:cancel"])} disabled={!setup.installation.attemptId || mutation} onClick={() => void controller.cancelLinuxMuseInstall()}>Cancel installation</Button>
            </>
          ) : found ? (
            <p className="text-xs text-subtle">{env.musePath ? <>Ready at <span className="break-all font-mono">{env.musePath}</span>.</> : "Muse is ready on this computer."}</p>
          ) : (
            <>
              <p>Ancilla downloads Muse from Meta and installs it for your account. Node.js is already included.</p>
              {failed ? <p role="status" className={cn("text-xs", setup.installation.status === "error" ? "text-warn-text" : "text-subtle")}>{setup.installation.message}</p> : null}
              {setup?.supported ? (
                <Button size="sm" variant="primary" loading={Boolean(busy["linux-setup:install"])} disabled={mutation} onClick={() => void controller.installLinuxMuse()}><DownloadSimpleIcon size={14} /> {failed ? "Try installation again" : "Install Muse Code"}</Button>
              ) : !error ? <p role="status" className="flex items-center gap-2 text-xs text-subtle">{busy["linux-setup:check"] ? <Spinner size={12} /> : null}{setup ? "Guided installation is not available on this server. Update Ancilla to continue." : "Checking this computer for guided setup…"}</p> : null}
            </>
          )}
        </SetupSection>
      ) : null}
      {storage && (!props.compact || storageIssue) ? (
        <SetupSection title={storage.status === "ready" ? "Muse storage is ready" : "Prepare Muse storage"} ready={storage.status === "ready"}>
          {accounts?.length ? (
            <label className="flex flex-wrap items-center gap-2 text-xs text-subtle">Storage for
              <select className="max-w-full rounded-md border border-line bg-raised px-2 py-1 text-xs text-fg" value={accountId ?? ""} disabled={installing || mutation} onChange={(event) => void controller.refreshLinuxSetup(event.currentTarget.value || null)}>
                <option value="">Default login</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </label>
          ) : accountId ? <p className="text-xs text-subtle">Storage for {accountName}</p> : null}
          <p className={cn("text-xs", storage.status === "blocked" ? "text-warn-text" : "text-muted")}>{storage.message}</p>
          {storage.path ? <div className="flex items-center gap-2 text-xs text-subtle"><code className="min-w-0 flex-1 break-all">{storage.path}</code><CopyButton text={storage.path} label="Copy Muse storage path" /></div> : null}
          {storage.status === "repairable" || storage.status === "missing" ? (
            <Button size="sm" variant="secondary" loading={Boolean(busy["linux-setup:repair"])} disabled={installing || mutation} onClick={() => void controller.repairLinuxStorage()}>{storage.status === "missing" ? "Prepare storage" : "Fix folder permissions"}</Button>
          ) : null}
        </SetupSection>
      ) : null}
      {error ? <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-warn-text"><WarningIcon size={15} className="mt-0.5 shrink-0" /> {error}</p> : null}
      {props.showSubscription ? (
        <div className="mt-4 border-t border-line pt-4">
          {found ? <MuseSubscriptionCard /> : <><h3 className="text-sm font-medium text-fg">Next: Sign in with Meta</h3><p className="mt-1 text-sm leading-relaxed text-muted">Once Muse is installed, connect your Muse Code subscription here, then choose a project folder. No API key is needed.</p></>}
        </div>
      ) : null}
    </section>
  );
}
