import { FormEvent, useMemo, useRef, useState } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import { relativeTime, shortenPath } from "../../model/format.js";
import { bindingRow, planView } from "../../model/plan.js";
import { projectForCwd } from "../../model/status.js";
import type { AccountView, PlanAccountUsage, ProjectView, SessionSummary } from "../../types.js";
import { TopBar } from "../chrome.js";
import { Composer, ComposerFooter } from "../composer/Composer.js";
import { CopyButton } from "../ui/Markdown.js";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuOption,
  MenuRadioGroup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/overlays.js";
import { Button, Logo, Spinner, cn } from "../ui/primitives.js";
import {
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CheckIcon,
  FolderIcon,
  FolderPlusIcon,
} from "../ui/icons.js";
import { FolderArt } from "./FolderArt.js";
import { MuseSubscriptionCard } from "../settings/MuseSignIn.js";
import { LinuxSetupCard } from "../settings/LinuxSetup.js";

const HERO_TITLE_STYLE = "font-display text-[2.125rem] leading-[1.15] font-normal tracking-[-0.015em] text-fg text-balance";

export function nearCapHint(
  project: ProjectView,
  accounts: AccountView[] | null,
  usageAccounts: PlanAccountUsage[],
  now: number,
): string | null {
  if (!accounts?.length) return null;

  const candidatePool = [{ id: null, name: "Default login" }, ...accounts];
  const evaluated = candidatePool.flatMap((acc) => {
    const report = usageAccounts.find((r) => r.accountId === acc.id);
    const view = report ? planView(report.usage, now, report) : null;
    const bound = view ? bindingRow(view) : null;
    return bound ? [{ id: acc.id, name: acc.name, percent: bound.percent, weekly: bound.key === "weekly" }] : [];
  });

  if (evaluated.length < 2) return null;

  const focused = evaluated.find((entry) => entry.id === project.defaultAccountId);
  if (!focused || focused.percent < 80) return null;

  const others = evaluated.filter((entry) => entry.id !== focused.id);
  if (!others.length) return null;

  const lowest = others.reduce((acc, curr) => (curr.percent < acc.percent ? curr : acc), others[0]);
  if (focused.percent - lowest.percent < 25) return null;

  const describeRate = (item: { percent: number; weekly: boolean }) =>
    `${item.percent}%${item.weekly ? " weekly" : ""}`;

  return `Last reported: ${focused.name} at ${describeRate(focused)}, ${lowest.name} at ${describeRate(lowest)}.`;
}

function FolderSelectorMenu({
  project,
  activeFolder,
}: {
  project: ProjectView;
  activeFolder: string;
}) {
  const ctrl = useController();
  const activeItem = project.folders.find((f) => f.cwd === activeFolder) ?? project.folders[0];

  return (
    <nav className="inline-block">
      <Menu>
        <MenuTrigger asChild>
          <button
            className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg"
            type="button"
            aria-label={`Folder: ${activeItem?.displayName ?? activeFolder}`}
          >
            <FolderIcon size={14} className="shrink-0" aria-hidden="true" />
            <span>
              in <span className="font-medium text-fg">{activeItem?.displayName ?? activeFolder}</span>
            </span>
            <CaretDownIcon size={12} aria-hidden="true" className="ml-0.5" />
          </button>
        </MenuTrigger>
        <MenuContent className="w-[320px] p-1">
          <MenuRadioGroup value={activeFolder} onValueChange={(dir) => ctrl.newThread(dir)}>
            {project.folders.map((folderNode) => {
              const pathPreview = <span className="block truncate" title={folderNode.cwd}>{shortenPath(folderNode.cwd, 44)}</span>;
              return <MenuOption key={folderNode.cwd} value={folderNode.cwd} label={folderNode.displayName} description={pathPreview} />;
            })}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
    </nav>
  );
}

function ProjectSelectorMenu({
  project,
  projects,
}: {
  project: ProjectView;
  projects: ProjectView[];
}) {
  const ctrl = useController();

  return (
    <span className="inline-block">
      <Menu>
        <MenuTrigger asChild>
          <button
            className="inline-flex items-baseline gap-1 rounded-md text-brand-text underline decoration-dotted decoration-[1.5px] underline-offset-[7px] outline-offset-4 transition-colors hover:decoration-solid data-[state=open]:decoration-solid"
            type="button"
          >
            <span>{project.displayName}</span>
            <CaretDownIcon size={22} weight="regular" aria-hidden="true" className="translate-y-[3px] self-center" />
          </button>
        </MenuTrigger>
        <MenuContent className="w-[320px] p-1">
          <MenuRadioGroup value={project.cwd} onValueChange={(dir) => ctrl.newThread(dir)}>
            {projects.map((projNode) => {
              const locSnippet = <span className="block truncate" title={projNode.cwd}>{shortenPath(projNode.cwd, 44)}</span>;
              return <MenuOption key={projNode.cwd} value={projNode.cwd} label={projNode.displayName} description={locSnippet} />;
            })}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem icon={<FolderPlusIcon size={14} />} onSelect={() => ctrl.setAddProjectOpen(true)}>
            <span>Add project</span>
          </MenuItem>
        </MenuContent>
      </Menu>
    </span>
  );
}

function RecentThreadCard({
  project,
  recentSessions,
  clockNow,
  onLaunch,
}: {
  project: ProjectView;
  recentSessions: SessionSummary[];
  clockNow: number;
  onLaunch: (id: string) => void;
}) {
  if (!recentSessions.length) return null;

  return (
    <nav className="mt-12" aria-label={`Recent threads in ${project.displayName}`}>
      <h2 className="px-2 text-xs font-medium text-subtle">Recent in {project.displayName}</h2>
      <ul className="mt-1.5 flex flex-col list-none p-0">
        {recentSessions.map((item) => (
          <li key={item.sessionId}>
            <button
              type="button"
              onClick={() => onLaunch(item.sessionId)}
              className="flex h-9 w-full items-center gap-3 rounded-md px-2 text-left transition-colors hover:bg-hover"
            >
              <span className="flex-1 min-w-0 truncate text-sm text-muted">{item.title}</span>
              <span className="shrink-0 text-xs text-subtle tabular-nums">{relativeTime(item.activityAt, clockNow)}</span>
            </button></li>
        ))}
      </ul>
    </nav>
  );
}

export function NewThread(props: { cwd: string | null }) {
  const ctrl = useController();
  const workspaceProjects = useApp((s) => s.projects);
  const activeSessions = useApp((s) => s.sessions);
  const userAccounts = useApp((s) => s.accounts);
  const quotaAccounts = useApp((s) => s.planUsageAccounts);
  const isAuthMissing = useApp((s) => s.defaultLogin?.hasLogin === false && !s.metaApiKeyInherited);
  const clockTick = useNow(60_000);

  const matchedProject = projectForCwd(workspaceProjects, props.cwd) ?? workspaceProjects[0] ?? null;

  const targetFolder =
    matchedProject && props.cwd && matchedProject.folders.some((f) => f.cwd === props.cwd)
      ? props.cwd
      : (matchedProject?.cwd ?? null);

  const recentList = useMemo(() => {
    if (!matchedProject) return [];
    return Object.values(activeSessions)
      .filter((sess) => matchedProject.folders.some((f) => f.cwd === sess.cwd))
      .sort((a, b) => (a.activityAt < b.activityAt ? 1 : -1))
      .slice(0, 5);
  }, [activeSessions, matchedProject]);

  const quotaHint = useMemo(() => {
    return matchedProject ? nearCapHint(matchedProject, userAccounts, quotaAccounts, clockTick) : null;
  }, [matchedProject, userAccounts, quotaAccounts, clockTick]);

  if (!matchedProject) {
    return <Welcome />;
  }

  const effectiveCwd = targetFolder ?? matchedProject.cwd;
  const isMuseProvider = !matchedProject.defaultProviderId || matchedProject.defaultProviderId === "muse";
  const shouldShowSignIn = isAuthMissing && isMuseProvider && matchedProject.defaultAccountId === null;

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <TopBar />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <main className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center px-6 pt-6 pb-[12vh]">
          <h1 className={HERO_TITLE_STYLE}>
            Start a thread in <ProjectSelectorMenu project={matchedProject} projects={workspaceProjects} />
          </h1>

          {matchedProject.folders.length > 1 && (
            <FolderSelectorMenu project={matchedProject} activeFolder={effectiveCwd} />
          )}

          <section className="mt-6 empty:hidden">
            <LinuxSetupCard compact />
          </section>

          {shouldShowSignIn && (
            <div className="mt-6 rounded-xl border border-line bg-raised p-4">
              <MuseSubscriptionCard />
            </div>
          )}

          <div className="mt-7">
            <Composer
              sessionId={null}
              cwd={effectiveCwd}
              running={false}
              readOnly={false}
              variant="home"
              autoFocus
            />
          </div>

          <ComposerFooter cwd={effectiveCwd} branch={null} running={false} />

          {quotaHint && <p className="mt-2 text-xs text-muted">{quotaHint}</p>}

          <RecentThreadCard
            project={matchedProject}
            recentSessions={recentList}
            clockNow={clockTick}
            onLaunch={(sessId) => ctrl.openThread(sessId)}
          />
        </main>
      </div>
    </div>
  );
}

export function Welcome() {
  const ctrl = useController();
  const isDiscovering = useApp((s) => s.discovering);
  const isOperationBusy = useApp((s) => Boolean(s.busy["addProject"]));
  const isPlatformWindows = useApp((s) => s.env?.platform === "win32");
  const isPlatformLinux = useApp((s) => s.env?.platform === "linux");
  const [folderInputVal, setFolderInputVal] = useState("");
  const inputElemRef = useRef<HTMLInputElement>(null);

  const handleFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    void ctrl.addProject(folderInputVal);
  };

  return (
    <div className="flex flex-col h-full min-w-0 flex-1">
      <TopBar />
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 pb-[10vh]">
        <article className="my-auto w-full max-w-[540px] py-6">
          <FolderArt label="Add your first project" onActivate={() => inputElemRef.current?.focus()} />
          <h1 className={cn(HERO_TITLE_STYLE, "mt-8")}>Welcome to Ancilla</h1>
          <p className="mt-3 text-md leading-relaxed text-pretty text-muted">
            Point Muse at a project and start a thread. Threads live in the sidebar, grouped by project, and tell you when they need you.
          </p>

          {isPlatformLinux ? (
            <section className="mt-6">
              <LinuxSetupCard firstRun showSubscription />
            </section>
          ) : (
            <section className="mt-6 rounded-xl border border-line bg-raised p-4">
              <MuseSubscriptionCard />
            </section>
          )}

          {isPlatformLinux && (
            <div className="mt-6">
              <Button variant="primary" onClick={() => ctrl.setAddProjectOpen(true)}>
                <FolderPlusIcon size={16} /> Choose a project folder
              </Button>
              <p className="mt-2 text-xs leading-relaxed text-subtle">
                Choose Local folder to browse this computer, or clone a repository. Then describe your task in a new thread.
              </p>
            </div>
          )}

          <form className="mt-8 flex gap-2" onSubmit={handleFormSubmit}>
            <input
              ref={inputElemRef}
              aria-label="Project folder path"
              value={folderInputVal}
              spellCheck={false}
              autoComplete="off"
              autoFocus={!isPlatformLinux}
              placeholder={isPlatformWindows ? "D:\\Projects\\my-app" : "/home/you/code/my-app"}
              onChange={(e) => setFolderInputVal(e.currentTarget.value)}
              className="h-10 min-w-0 flex-1 rounded-lg bg-raised px-3 font-mono text-base text-fg shadow-[0_0_0_1px_var(--border-strong)] outline-none focus-visible:shadow-[0_0_0_2px_var(--focus-ring)] focus-visible:outline-none sm:text-sm"
            />
            <Button
              type="submit"
              variant="primary"
              className="h-10 px-4"
              loading={isOperationBusy}
              disabled={!folderInputVal.trim()}
            ><span>Add project</span></Button>
          </form>

          <footer className="mt-3 flex items-center gap-2 text-xs text-subtle">
            {isDiscovering ? (
              <span className="inline-flex items-center gap-1.5"><Spinner size={10} /> Checking Muse for threads you started in the terminal</span>
            ) : (
              <span>Threads you start from the Muse terminal show up here on their own.</span>
            )}
          </footer>
        </article>
      </div>
    </div>
  );
}

interface SetupStep {
  status: boolean | null;
  heading: string;
  notes: string;
  execScript?: string;
}

export function Onboarding() {
  const ctrl = useController();
  const hostEnv = useApp((s) => s.env);
  const isBootChecking = useApp((s) => s.boot === "loading");

  if (!hostEnv) return null;

  if (hostEnv.platform === "linux") {
    return (
      <div className="flex h-full items-start justify-center overflow-y-auto bg-bg px-6 py-10">
        <main className="my-auto w-full max-w-[560px]">
          <Logo size={40} />
          <h1 className={cn(HERO_TITLE_STYLE, "mt-7")}>Set up Ancilla</h1>
          <p className="mt-3 text-md leading-relaxed text-muted">
            Install Muse, connect your Meta subscription, then choose a project. Ancilla guides you through each step here.
          </p>
          <div className="mt-7">
            <LinuxSetupCard firstRun showSubscription />
          </div>
          <div className="mt-5">
            <Button variant="ghost" onClick={() => void ctrl.openProvidersWithoutMuse()}>
              Use another AI subscription or API key
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const isWin = hostEnv.platform === "win32";
  const psOneLiner = "irm https://dev.meta.ai/install.ps1 | iex";
  const unixOneLiner = "curl -fsSL https://dev.meta.ai/install.sh | bash";
  const stepItems: SetupStep[] = [];
  const needsWsl = isWin && (hostEnv.runtime === "wsl" || (hostEnv.runtime === undefined && hostEnv.wslAvailable));

  if (isWin && !needsWsl) {
    stepItems.push({
      status: hostEnv.museFound,
      heading: "Muse for Windows",
      notes: hostEnv.museFound
        ? `Found at ${hostEnv.musePath}.`
        : "Open PowerShell from the Start menu, paste this command, and wait for installation to finish.",
      execScript: hostEnv.museFound ? undefined : psOneLiner,
    });
  } else if (isWin) {
    stepItems.push({
      status: hostEnv.wslAvailable,
      heading: "WSL2 with a Linux distro",
      notes: hostEnv.wslAvailable
        ? `Using ${hostEnv.defaultDistro ?? "your default distro"}.`
        : "Ancilla is configured to run Muse in WSL. Open PowerShell as administrator, run this command, then restart Windows if prompted.",
      execScript: hostEnv.wslAvailable ? undefined : "wsl --install",
    });
    stepItems.push({
      status: hostEnv.museFound,
      heading: "Install Muse Code in WSL",
      notes: hostEnv.museFound
        ? `Found at ${hostEnv.musePath}.`
        : `Open ${hostEnv.defaultDistro ?? "your WSL distro"} from the Start menu and paste this command in its Linux terminal. Ancilla is using Muse in this distro.`,
      execScript: hostEnv.museFound ? undefined : unixOneLiner,
    });
  } else {
    stepItems.push({
      status: hostEnv.museFound,
      heading: "Install Muse Code",
      notes: hostEnv.museFound
        ? `Found at ${hostEnv.musePath}.`
        : "Open Terminal, paste this command, and wait for installation to finish.",
      execScript: hostEnv.museFound ? undefined : unixOneLiner,
    });
  }

  stepItems.push({
    status: null,
    heading: "Connect your Meta subscription",
    notes:
      "Choose Check installation below. On the next screen, choose Sign in with Meta, approve access using the account that owns your Muse Code plan, then return to Ancilla. An existing Muse login is reused. No API key is needed.",
  });

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto bg-bg px-6 py-10">
      <main className="my-auto w-full max-w-[560px]">
        <Logo size={40} />
        <h1 className={cn(HERO_TITLE_STYLE, "mt-7")}>Connect Ancilla to Muse Code</h1>
        <p className="mt-3 text-md leading-relaxed text-muted">
          Install Muse once on this computer, then connect your Meta account. Ancilla uses your Muse Code subscription.
        </p>

        <ol className="mt-8 flex flex-col gap-2.5 list-none p-0">
          {stepItems.map((step, idx) => (
            <li
              key={step.heading}
              className="flex gap-3.5 rounded-xl bg-raised p-4 shadow-[0_0_0_1px_var(--border)]"
            >
              <span
                aria-label={step.status === true ? "Done" : step.status === false ? "Needs attention" : "Check yourself"}
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  step.status === true ? "bg-ok text-[oklch(0.99_0_0)]" : step.status === false ? "bg-warn-soft text-warn-text" : "bg-active text-muted"
                )}
              >{step.status === true ? <CheckIcon size={13} /> : idx + 1}</span>
              <section className="flex-1 min-w-0">
                <p className="text-sm font-medium text-fg">{step.heading}</p>
                <p className="mt-1 text-sm break-words text-muted">{step.notes}</p>
                {step.execScript && (
                  <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-sunken py-1 pr-1 pl-3 font-mono text-xs text-fg shadow-[0_0_0_1px_var(--border)]">
                    <span className="flex-1 min-w-0 break-all">{step.execScript}</span>
                    <CopyButton text={step.execScript} label="Copy command" />
                  </div>
                )}
              </section></li>
          ))}
        </ol>

        <div className="mt-6 flex flex-wrap items-center gap-2.5">
          <Button variant="primary" onClick={() => ctrl.retryBoot()} loading={isBootChecking}>
            <ArrowsClockwiseIcon size={14} /> Check installation
          </Button>
          <Button variant="ghost" onClick={() => void ctrl.openProvidersWithoutMuse()}>
            Use another AI subscription or API key
          </Button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          If Muse is still not found after installation, close and reopen Ancilla so it can pick up the updated command path.
        </p>
      </main>
    </div>
  );
}

export function BootScreen() {
  return (
    <main className="grid h-screen place-items-center bg-bg">
      <div className="flex flex-col items-center gap-4">
        <Logo size={38} />
        <p className="inline-flex items-center gap-2 text-sm text-subtle">
          <Spinner size={13} /> <span>Starting Ancilla</span>
        </p>
      </div>
    </main>
  );
}

export function BootError() {
  const ctrl = useController();
  const errorMsg = useApp((s) => s.bootError);

  return (
    <main className="grid min-h-screen place-items-center bg-bg px-6">
      <section className="w-full max-w-[480px]">
        <Logo size={38} />
        <h1 className={cn(HERO_TITLE_STYLE, "mt-6 text-3xl")}>Ancilla could not reach its server</h1>
        <p className="mt-3 text-sm break-words text-muted">{errorMsg ?? "The local Ancilla server did not answer."}</p>
        <footer className="mt-6">
          <Button variant="primary" onClick={() => ctrl.retryBoot()}>
            <ArrowsClockwiseIcon size={14} /> <span>Try again</span>
          </Button>
        </footer>
      </section>
    </main>
  );
}
