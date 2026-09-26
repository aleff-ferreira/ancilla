import { ArrowsClockwiseIcon, CaretDownIcon, CheckIcon, FolderIcon, FolderPlusIcon } from "../ui/icons.js";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import { relativeTime, shortenPath } from "../../model/format.js";
import { planView } from "../../model/plan.js";
import { projectForCwd } from "../../model/status.js";
import type { AccountView, PlanUsage, PlanUsageByAccount, ProjectView } from "../../types.js";
import { TopBar } from "../chrome.js";
import { Composer, ComposerFooter } from "../composer/Composer.js";
import { CopyButton } from "../ui/Markdown.js";
import { Menu, MenuContent, MenuItem, MenuOption, MenuRadioGroup, MenuSeparator, MenuTrigger } from "../ui/overlays.js";
import { Button, Logo, Spinner, cn } from "../ui/primitives.js";
import { FolderArt } from "./FolderArt.js";

const DISPLAY = "font-display text-[2.125rem] leading-[1.15] font-normal tracking-[-0.015em] text-fg text-balance";

export function NewThread(props: { cwd: string | null }) {
  const controller = useController();
  const projects = useApp((s) => s.projects);
  const sessions = useApp((s) => s.sessions);
  const accounts = useApp((s) => s.accounts);
  const planUsage = useApp((s) => s.planUsage);
  const planUsageByAccount = useApp((s) => s.planUsageByAccount);
  const now = useNow(60_000);
  const project = projectForCwd(projects, props.cwd) ?? projects[0] ?? null;
  // The thread starts in the folder the route names when it is one of the project's; otherwise in the project's own.
  const folder = project && props.cwd && project.folders.some((f) => f.cwd === props.cwd) ? props.cwd : (project?.cwd ?? null);
  const recent = useMemo(
    () =>
      project
        ? Object.values(sessions)
            .filter((s) => project.folders.some((f) => f.cwd === s.cwd))
            .sort((a, b) => (a.activityAt < b.activityAt ? 1 : -1))
            .slice(0, 5)
        : [],
    [sessions, project],
  );
  const nearCap = useMemo(
    () => (project ? nearCapHint(project, accounts, planUsage, planUsageByAccount, now) : null),
    [project, accounts, planUsage, planUsageByAccount, now],
  );
  if (!project) {
    return <Welcome />;
  }
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <TopBar />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center px-6 pt-6 pb-[12vh]">
          <h1 className={DISPLAY}>
            Start a thread in <ProjectSwitcher project={project} projects={projects} />
          </h1>
          {project.folders.length > 1 ? <FolderSwitcher project={project} folder={folder ?? project.cwd} /> : null}
          <div className="mt-7">
            <Composer sessionId={null} cwd={folder ?? project.cwd} running={false} readOnly={false} variant="home" autoFocus />
          </div>
          <ComposerFooter cwd={folder ?? project.cwd} branch={null} running={false} />
          {nearCap ? <p className="mt-2 text-xs text-muted">{nearCap}</p> : null}
          {recent.length > 0 ? (
            <section className="mt-12" aria-label={`Recent threads in ${project.displayName}`}>
              <h2 className="px-2 text-xs font-medium text-subtle">Recent in {project.displayName}</h2>
              <ul className="mt-1.5 flex flex-col">
                {recent.map((session) => (
                  <li key={session.sessionId}>
                    <button
                      type="button"
                      onClick={() => controller.openThread(session.sessionId)}
                      className="flex h-9 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors hover:bg-hover"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-muted">{session.title}</span>
                      <span className="shrink-0 text-xs text-subtle tabular-nums">{relativeTime(session.activityAt, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The manual version of "switch accounts before this one caps out": one line that says which account is close to
 * its rolling-window cap and which has more room, so the choice stays with the person, never automatic. Needs at
 * least two accounts with usage (the default login counts as one), the project's default account (or the default login, when unset) at 80% or more,
 * and another account at least 25 points behind it.
 */
function nearCapHint(
  project: ProjectView,
  accounts: AccountView[] | null,
  planUsage: PlanUsage | null,
  planUsageByAccount: PlanUsageByAccount,
  now: number,
): string | null {
  if (!accounts || accounts.length < 1) {
    return null;
  }
  const candidates: { id: string | null; name: string; percent: number }[] = [];
  const loginPercent = planView(planUsage, now)?.rows[0]?.percent;
  if (loginPercent !== undefined) {
    candidates.push({ id: null, name: "Default login", percent: loginPercent });
  }
  for (const account of accounts) {
    const percent = planView(planUsageByAccount[account.id], now)?.rows[0]?.percent;
    if (percent !== undefined) {
      candidates.push({ id: account.id, name: account.name, percent });
    }
  }
  // The default login counts as a switchable account, so one named profile plus a busy default login is enough.
  if (candidates.length < 2) {
    return null;
  }
  const high = candidates.find((c) => c.id === project.defaultAccountId);
  if (!high || high.percent < 80) {
    return null;
  }
  const rest = candidates.filter((c) => c.id !== high.id);
  if (rest.length === 0) {
    return null;
  }
  const low = rest.reduce((min, c) => (c.percent < min.percent ? c : min), rest[0]);
  if (high.percent - low.percent < 25) {
    return null;
  }
  return `${high.name} is at ${high.percent}%. ${low.name} has more room, at ${low.percent}%.`;
}

/**
 * Which of the project's folders the thread starts in. Muse gives a session one workspace root, so a thread runs in
 * one folder; picking one changes the route's cwd, and the composer and its footer follow.
 */
function FolderSwitcher(props: { project: ProjectView; folder: string }) {
  const controller = useController();
  const current = props.project.folders.find((f) => f.cwd === props.folder) ?? props.project.folders[0];
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`Folder: ${current?.displayName ?? props.folder}`}
          className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg"
        >
          <FolderIcon size={14} className="shrink-0" aria-hidden="true" />
          <span>
            in <span className="font-medium text-fg">{current?.displayName ?? props.folder}</span>
          </span>
          <CaretDownIcon size={12} aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-[320px]">
        <MenuRadioGroup value={props.folder} onValueChange={(cwd) => controller.newThread(cwd)}>
          {props.project.folders.map((f) => (
            <MenuOption
              key={f.cwd}
              value={f.cwd}
              label={f.displayName}
              description={
                <span className="block truncate" title={f.cwd}>
                  {shortenPath(f.cwd, 44)}
                </span>
              }
            />
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

function ProjectSwitcher(props: { project: ProjectView; projects: ProjectView[] }) {
  const controller = useController();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-baseline gap-1 rounded-md text-accent-text underline decoration-dotted decoration-[1.5px] underline-offset-[7px] outline-offset-4 transition-colors hover:decoration-solid data-[state=open]:decoration-solid"
        >
          {props.project.displayName}
          <CaretDownIcon weight="regular" size={22} className="translate-y-[3px] self-center" aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-[320px]">
        <MenuRadioGroup value={props.project.cwd} onValueChange={(cwd) => controller.newThread(cwd)}>
          {props.projects.map((p) => (
            <MenuOption
              key={p.cwd}
              value={p.cwd}
              label={p.displayName}
              description={
                <span className="block truncate" title={p.cwd}>
                  {shortenPath(p.cwd, 44)}
                </span>
              }
            />
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem icon={<FolderPlusIcon size={14} />} onSelect={() => controller.setAddProjectOpen(true)}>
          Add project
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function Welcome() {
  const controller = useController();
  const discovering = useApp((s) => s.discovering);
  const busy = useApp((s) => Boolean(s.busy["addProject"]));
  const windows = useApp((s) => s.env?.platform === "win32");
  const [path, setPath] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void controller.addProject(path);
  };
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pb-[10vh]">
        <div className="w-full max-w-[540px]">
          <FolderArt label="Add your first project" onActivate={() => input.current?.focus()} />
          <h1 className={cn(DISPLAY, "mt-8")}>Welcome to Ancilla</h1>
          <p className="mt-3 text-md leading-relaxed text-pretty text-muted">
            Point Muse at a project and start a thread. Threads live in the sidebar, grouped by project, and tell you when
            they need you.
          </p>
          <form className="mt-8 flex gap-2" onSubmit={submit}>
            <input
              ref={input}
              aria-label="Project folder path"
              value={path}
              spellCheck={false}
              autoComplete="off"
              autoFocus
              placeholder={windows ? "D:\\Projects\\my-app" : "/home/you/code/my-app"}
              onChange={(event) => setPath(event.currentTarget.value)}
              className="h-10 min-w-0 flex-1 rounded-lg bg-raised px-3 font-mono text-base text-fg shadow-[0_0_0_1px_var(--border-strong)] outline-none focus-visible:shadow-[0_0_0_2px_var(--accent)] focus-visible:outline-none sm:text-sm"
            />
            <Button variant="primary" type="submit" className="h-10 px-4" loading={busy} disabled={!path.trim()}>
              Add project
            </Button>
          </form>
          <p className="mt-3 flex items-center gap-2 text-xs text-subtle">
            {discovering ? (
              <>
                <Spinner size={10} /> Checking Muse for threads you started in the terminal
              </>
            ) : (
              "Threads you start from the Muse terminal show up here on their own."
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

interface Step {
  ok: boolean | null;
  title: string;
  detail: string;
  command?: string;
}

export function Onboarding() {
  const controller = useController();
  const env = useApp((s) => s.env);
  const checking = useApp((s) => s.boot === "loading");
  if (!env) {
    return null;
  }
  const windows = env.platform === "win32";
  const install = "irm https://dev.meta.ai/install.ps1 | iex";
  const steps: Step[] = [];
  if (windows && (env.runtime === "native" || !env.wslAvailable)) {
    // Muse runs natively on Windows now, so a new setup needs no WSL at all.
    steps.push({
      ok: env.museFound,
      title: "Muse for Windows",
      detail: env.museFound
        ? `Found at ${env.musePath}.`
        : "Install Muse from PowerShell. No WSL needed. Already use Muse inside WSL? Set WSL up and Ancilla uses it there.",
      command: env.museFound ? undefined : install,
    });
  } else if (windows) {
    steps.push({ ok: true, title: "WSL2 with a Linux distro", detail: `Using ${env.defaultDistro ?? "your default distro"}.` });
    steps.push({
      ok: env.museFound,
      title: "The Muse CLI",
      detail: env.museFound
        ? `Found at ${env.musePath}.`
        : `Install Muse for Windows from PowerShell (no WSL needed), or install it inside ${env.defaultDistro ?? "your WSL distro"}.`,
      command: env.museFound ? undefined : install,
    });
  } else {
    steps.push({
      ok: env.museFound,
      title: "The Muse CLI",
      detail: env.museFound ? `Found at ${env.musePath}.` : "Install Muse so the muse command is on your PATH.",
    });
  }
  steps.push({
    ok: null,
    title: "Signed in to Muse",
    detail: "Run this once in a terminal. Ancilla uses your own login and never sees your credentials.",
    command: "muse login",
  });
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg px-6 py-10">
      <div className="w-full max-w-[560px]">
        <Logo size={40} />
        <h1 className={cn(DISPLAY, "mt-7")}>Set up Muse</h1>
        <p className="mt-3 text-md leading-relaxed text-muted">
          Ancilla drives the Muse Code CLI on this computer. Finish these steps, then check again.
        </p>
        <ol className="mt-8 flex flex-col gap-2.5">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-3.5 rounded-xl bg-raised p-4 shadow-[0_0_0_1px_var(--border)]">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  step.ok === true ? "bg-ok text-[oklch(0.99_0_0)]" : step.ok === false ? "bg-warn-soft text-warn-text" : "bg-active text-muted",
                )}
                aria-label={step.ok === true ? "Done" : step.ok === false ? "Needs attention" : "Check yourself"}
              >
                {step.ok === true ? <CheckIcon size={13} /> : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{step.title}</p>
                <p className="mt-1 text-sm break-words text-muted">{step.detail}</p>
                {step.command ? (
                  <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-sunken py-1 pr-1 pl-3 font-mono text-xs text-fg shadow-[0_0_0_1px_var(--border)]">
                    <span className="min-w-0 flex-1 truncate">{step.command}</span>
                    <CopyButton text={step.command} label="Copy command" />
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-6">
          <Button variant="primary" onClick={() => controller.retryBoot()} loading={checking}>
            <ArrowsClockwiseIcon size={14} /> Check again
          </Button>
        </div>
      </div>
    </div>
  );
}

export function BootScreen() {
  return (
    <div className="flex h-full items-center justify-center bg-bg">
      <div className="flex flex-col items-center gap-5">
        <Logo size={36} />
        <span className="flex items-center gap-2 text-sm text-subtle">
          <Spinner size={12} /> Starting Ancilla
        </span>
      </div>
    </div>
  );
}

export function BootError() {
  const controller = useController();
  const message = useApp((s) => s.bootError);
  return (
    <div className="flex h-full items-center justify-center bg-bg px-6">
      <div className="w-full max-w-[480px]">
        <Logo size={36} />
        <h1 className={cn(DISPLAY, "mt-6 text-3xl")}>Ancilla could not reach its server</h1>
        <p className="mt-3 text-sm break-words text-muted">{message ?? "The local Ancilla server did not answer."}</p>
        <div className="mt-6">
          <Button variant="primary" onClick={() => controller.retryBoot()}>
            <ArrowsClockwiseIcon size={14} /> Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
