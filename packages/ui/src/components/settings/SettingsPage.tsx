import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowLineDownIcon, ArrowsClockwiseIcon, MinusIcon, PencilSimpleIcon, PlusIcon, ScrollIcon, SignInIcon, TrashIcon, WarningIcon } from "../ui/icons.js";
import { useEffect, useState, type ReactNode } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import { useOverlayDragProps } from "../../app/frame.js";
import { modelDisplayName } from "../../model/format.js";
import type { AncillaController } from "../../model/controller.js";
import { RESEARCH_LIMITS, WINDOW_STEP, clampResearchNumber } from "../../model/research.js";
import { CODE_THEMES, ZOOM_MAX, ZOOM_MIN, type CodeTheme, type GroupBy, type ThemePref } from "../../model/store.js";
import type { AccountView, ApprovalMode, ReasoningEffort, ResearchConfig, ResearchModelIds } from "../../types.js";
import { LEVELS, MODES } from "../composer/Composer.js";
import { CODE_THEME_LABELS, updateSummary } from "../sidebar/Sidebar.js";
import { Modal } from "../ui/overlays.js";
import { TopBar } from "../chrome.js";
import { Button, IconButton, MOD, Toggle, cn } from "../ui/primitives.js";
import { About } from "./About.js";
import { MuseSubscriptionCard } from "./MuseSignIn.js";

/** A row's control: one choice out of a few. Scrolls sideways when the row is too narrow to wrap. */
function Pick<T extends string | number | null>(props: {
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex max-w-full min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain rounded-lg bg-sunken p-0.5 [scrollbar-width:thin]">
      {props.options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          title={option.hint}
          aria-pressed={props.value === option.value}
          disabled={props.disabled}
          onClick={() => props.onChange(option.value)}
          className={cn(
            "h-7 shrink-0 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40",
            props.value === option.value ? "selected-control bg-raised text-fg" : "text-muted hover:text-fg",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs leading-4 font-medium tracking-[0.04em] text-muted uppercase">{props.title}</h2>
      <div className="overflow-hidden rounded-xl bg-raised shadow-panel">{props.children}</div>
    </section>
  );
}

function Row(props: { label: ReactNode; description?: string; descriptionClassName?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t border-line px-4 py-3 first:border-t-0">
      {/* A floor on the label, or a wide row of choices squeezes it to one word per line instead of wrapping. */}
      <div className="min-w-[13rem] flex-1 basis-64">
        <p className="text-sm text-fg">{props.label}</p>
        {props.description ? (
          <p className={cn("mt-0.5 text-xs text-pretty", props.descriptionClassName ?? "text-muted")}>{props.description}</p>
        ) : null}
      </div>
      {props.children ? <div className="min-w-0 w-full @min-[520px]:w-auto">{props.children}</div> : null}
    </div>
  );
}

/**
 * A row's control: a number in a small field, whole unless `step` says finer. The value lands on blur or Enter,
 * not on every keystroke, so a half-typed number never reaches the server; one past the range lands on its edge,
 * which is where the server would put it, and an empty field goes back to what it was.
 */
function Num(props: { value: number; min: number; max: number; step?: number; unit?: string; label: string; onChange: (value: number) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = clampResearchNumber(draft, { min: props.min, max: props.max }, props.step ?? 1);
    setDraft(null);
    if (next !== null && next !== props.value) {
      props.onChange(next);
    }
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={draft ?? String(props.value)}
        disabled={props.disabled}
        aria-label={props.label}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        className="h-7 w-16 rounded-md bg-sunken px-2 text-right text-xs text-fg tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40"
      />
      {props.unit ? <span>{props.unit}</span> : null}
    </span>
  );
}

/**
 * The research defaults a run starts from; the composer popover can change the window and the workers per run.
 * Every field takes the daemon's own limits, so whatever the server holds renders and whatever is typed stays.
 */
function ResearchRows(props: { config: ResearchConfig; models: { modelId: string; contributor?: boolean }[]; controller: AncillaController }) {
  const { config, controller } = props;
  const patch = (part: Partial<ResearchConfig>) => void controller.setResearchSettings({ config: part });
  const limits = RESEARCH_LIMITS;
  const modelRow = (role: keyof ResearchModelIds, label: string, description: string) => (
    <Row label={label} description={description}>
      {props.models.length === 0 ? (
        <p className="text-xs text-subtle">No models loaded</p>
      ) : (
        <Pick<string | null>
          value={config.models[role]}
          options={[
            { value: null, label: "Muse default" },
            ...props.models.map((model) => ({
              value: model.modelId as string | null,
              label: model.contributor ? `${modelDisplayName(model.modelId)} · Contributor` : modelDisplayName(model.modelId),
              hint: model.contributor ? "Contributor tier: prompts and outputs may be used for product improvement." : undefined,
            })),
          ]}
          onChange={(value) => patch({ models: { ...config.models, [role]: value } })}
        />
      )}
    </Row>
  );
  return (
    <>
      <Row label="Research window" description="How long the workers have before the writer takes over: no report before the minimum unless nothing is left to look up, and to the writer at the maximum.">
        {/* A minimum raised past the maximum takes the maximum with it, as the server would do on its own; a maximum lowered under the minimum brings the minimum down, which the server would not, lifting the maximum back instead. */}
        <div className="flex flex-wrap items-center gap-2">
          <Num
            value={config.windowMinMinutes}
            min={limits.windowMinutes.min}
            max={limits.windowMinutes.max}
            step={WINDOW_STEP}
            unit="to"
            label="Window minimum, minutes"
            onChange={(value) => patch(value > config.windowMaxMinutes ? { windowMinMinutes: value, windowMaxMinutes: value } : { windowMinMinutes: value })}
          />
          <Num
            value={config.windowMaxMinutes}
            min={limits.windowMinutes.min}
            max={limits.windowMinutes.max}
            step={WINDOW_STEP}
            unit="minutes"
            label="Window maximum, minutes"
            onChange={(value) => patch(value < config.windowMinMinutes ? { windowMaxMinutes: value, windowMinMinutes: value } : { windowMaxMinutes: value })}
          />
        </div>
      </Row>
      <Row label="Parallel workers" description={`How many Muse sessions research at once, up to ${limits.parallel.max}. Each is a session on your plan.`}>
        <Num value={config.maxParallel} min={limits.parallel.min} max={limits.parallel.max} unit="workers" label="Parallel workers" onChange={(value) => patch({ maxParallel: value })} />
      </Row>
      <Row label="Supervisor rounds" description={`How many times the supervisor may send workers out before it has to write, up to ${limits.rounds.max}.`}>
        <Num value={config.maxRounds} min={limits.rounds.min} max={limits.rounds.max} unit="rounds" label="Supervisor rounds" onChange={(value) => patch({ maxRounds: value })} />
      </Row>
      <Row label="Per worker" description="What one worker may do in one round: searches, pages read, and sources it may keep for the report.">
        <div className="flex flex-wrap items-center gap-3">
          <Num value={config.workerMaxSearches} min={limits.workerSearches.min} max={limits.workerSearches.max} unit="searches" label="Searches per worker" onChange={(value) => patch({ workerMaxSearches: value })} />
          <Num value={config.workerMaxReads} min={limits.workerReads.min} max={limits.workerReads.max} unit="reads" label="Reads per worker" onChange={(value) => patch({ workerMaxReads: value })} />
          <Num value={config.workerMaxSaves} min={limits.workerSaves.min} max={limits.workerSaves.max} unit="saves" label="Saves per worker" onChange={(value) => patch({ workerMaxSaves: value })} />
        </div>
      </Row>
      {modelRow("supervisor", "Supervisor model", "Scopes the question and decides what to send the workers after. Muse default lets the CLI choose.")}
      {modelRow("worker", "Worker model", "Runs the searches and reads the pages.")}
      {modelRow("writer", "Writer model", "Turns the workers' notes into the report.")}
    </>
  );
}

/** A fact about the install rather than a setting: shown so the answer is here and not in a tooltip. */
function Fact(props: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 first:border-t-0">
      <p className="text-sm text-muted">{props.label}</p>
      <p className="min-w-0 font-mono text-xs break-all text-fg">{props.value}</p>
    </div>
  );
}

const THEMES: readonly { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const GROUPS: readonly { value: GroupBy; label: string }[] = [
  { value: "project", label: "Project" },
  { value: "status", label: "Status" },
];

const INPUT_CLASS =
  "h-9 w-full rounded-lg border border-line bg-sunken px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus";

function AddAccountModal(props: { open: boolean; onOpenChange: (open: boolean) => void; controller: AncillaController }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [seedFromDefault, setSeedFromDefault] = useState(false);
  const [creating, setCreating] = useState(false);
  const accounts = useApp((s) => s.accounts);
  const suggestedId = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  const profileId = id.trim() || suggestedId;
  const validId = /^[a-z0-9][a-z0-9-]{0,31}$/.test(profileId);
  const duplicate = accounts?.some((account) => account.id === profileId) === true;

  async function submit() {
    if (!validId || duplicate || creating) return;
    setCreating(true);
    const ok = await props.controller.createAccount(profileId, name.trim() || undefined, seedFromDefault);
    setCreating(false);
    if (ok) {
      setId("");
      setName("");
      setSeedFromDefault(false);
      props.onOpenChange(false);
      void props.controller.beginLogin(profileId);
    }
  }

  return (
    <Modal
      open={props.open}
      onOpenChange={(open) => { if (!creating) props.onOpenChange(open); }}
      title="Add account"
      description="Give this login a label, then sign in with Meta. Each account keeps its own Muse profile."
    >
      <div className="mt-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="account-add-name">
            Account label
          </label>
          <input
            id="account-add-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Personal, Work, or a client name"
            className={INPUT_CLASS}
          />
        </div>
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Profile id: {profileId || "generated from your label"}</summary>
          <label className="mt-2 block" htmlFor="account-add-id">Lowercase letters, numbers and hyphens; up to 32 characters.</label>
          <input id="account-add-id" type="text" value={id} onChange={(event) => setId(event.target.value)} placeholder={suggestedId || "personal"} className={`${INPUT_CLASS} mt-1.5`} />
        </details>
        {duplicate ? <p role="alert" className="text-xs text-warn-text">This label already has a profile. Choose another label or change the profile id.</p> : null}
        {(profileId || name.trim()) && !validId ? <p role="alert" className="text-xs text-warn-text">Choose a profile id using lowercase letters, numbers and hyphens.</p> : null}
        <div className="flex items-center justify-between gap-4">
          <div><p className="text-sm text-fg">Copy settings from the default login</p><p className="mt-1 text-xs text-subtle">Copies preferences and trusted folders, never credentials.</p></div>
          <Toggle checked={seedFromDefault} onChange={setSeedFromDefault} label="Copy settings from the default login" />
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" disabled={creating} onClick={() => props.onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!validId || duplicate || creating} loading={creating} onClick={() => void submit()}>
          Continue to Meta sign-in
        </Button>
      </div>
    </Modal>
  );
}

function RenameAccountModal(props: { account: AccountView | null; onOpenChange: (open: boolean) => void; controller: AncillaController }) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (props.account) setName(props.account.name);
  }, [props.account]);

  async function submit() {
    const account = props.account;
    if (!account) return;
    const ok = await props.controller.renameAccount(account.id, name);
    if (ok) props.onOpenChange(false);
  }

  return (
    <Modal open={props.account !== null} onOpenChange={props.onOpenChange} title="Rename account">
      <div className="mt-4 flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted" htmlFor="account-rename-name">
          Name
        </label>
        <input
          id="account-rename-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!name.trim()} onClick={() => void submit()}>
          Rename
        </Button>
      </div>
    </Modal>
  );
}

function RemoveAccountModal(props: { account: AccountView | null; onOpenChange: (open: boolean) => void; controller: AncillaController }) {
  async function submit() {
    const account = props.account;
    if (!account) return;
    const ok = await props.controller.removeAccount(account.id);
    if (ok) props.onOpenChange(false);
  }

  return (
    <Modal
      open={props.account !== null}
      onOpenChange={props.onOpenChange}
      title="Remove this account?"
      description="The profile's local settings are deleted. Any threads that used it keep running under it until they end."
    >
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="danger" onClick={() => void submit()}>
          Remove account
        </Button>
      </div>
    </Modal>
  );
}

/** Everything Ancilla lets you set, in one place: the menus around the app are shortcuts into this. */
export function SettingsPage() {
  const controller = useController();
  const prefs = useApp((s) => s.prefs);
  const models = useApp((s) => s.models);
  const accounts = useApp((s) => s.accounts);
  const titleSettings = useApp((s) => s.titleSettings);
  const researchSettings = useApp((s) => s.researchSettings);
  const sandboxSettings = useApp((s) => s.sandboxSettings);
  const env = useApp((s) => s.env);
  const updates = useApp((s) => s.updates);
  const bypassAll = useApp((s) => s.bypassAll);
  const armedThreads = useApp((s) => s.bypassThreads.length);
  const [confirmBypass, setConfirmBypass] = useState(false);
  const yoloSettings = useApp((s) => s.yoloSettings);
  const [confirmSandbox, setConfirmSandbox] = useState(false);
  const [confirmYolo, setConfirmYolo] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [renaming, setRenaming] = useState<AccountView | null>(null);
  const [removing, setRemoving] = useState<AccountView | null>(null);
  const now = useNow(60_000);
  const busy = updates?.status === "checking" || updates?.status === "downloading" || updates?.status === "installing";
  const drag = useOverlayDragProps();
  const collapsed = useApp((s) => s.prefs.sidebarCollapsed);

  useEffect(() => {
    void controller.loadAccounts();
  }, [controller]);

  return (
    <div className="@container flex h-full min-w-0 flex-col">
      {collapsed ? <TopBar /> : null}
      <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
      {/* The whole strip moves the window, like the top bar the other views start with: on Windows only a
          `data-drag-region` surface does, and with the sidebar open this page has no top bar. */}
      <div data-drag-region {...drag} className="shrink-0">
      <header className="mx-auto flex w-full max-w-[720px] items-center gap-3 px-4 pt-8 pb-1 @min-[520px]:px-6">
        <Button size="sm" variant="ghost" onClick={() => controller.goBack()}>
          <ArrowLeftIcon size={14} /> Back
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-fg">Settings</h1>
          <p className="text-xs text-muted">Kept on this device. Most settings leave running threads alone; the sandbox and YOLO switches restart Muse hosts at once.</p>
        </div>
      </header>
      </div>

      <div className="mx-auto w-full min-w-0 max-w-[720px] px-4 pb-16 @min-[520px]:px-6">
        <Section title="Appearance">
          <Row label="Theme" description="Light, dark, or whatever this device is set to.">
            <Pick value={prefs.theme} options={THEMES} onChange={(value) => controller.setTheme(value)} />
          </Row>
          <Row label="Code" description="Colours for code and diffs, independent of the app's own theme.">
            <Pick
              value={prefs.codeTheme}
              options={CODE_THEMES.map((name) => ({ value: name as CodeTheme, label: CODE_THEME_LABELS[name] }))}
              onChange={(value) => controller.setCodeTheme(value)}
            />
          </Row>
          <Row
            label="Zoom"
            description={`How big the whole interface is. ${MOD} plus, ${MOD} minus and ${MOD} 0 adjust it anywhere; the percentage resets it.`}
          >
            <div className="flex items-center gap-1">
              <IconButton label="Zoom out" size="xs" onClick={() => controller.zoomOut()} disabled={prefs.zoom <= ZOOM_MIN}>
                <MinusIcon size={14} />
              </IconButton>
              <button
                type="button"
                title="Reset zoom to 100%"
                onClick={() => controller.resetZoom()}
                className="h-6 min-w-11 rounded-md px-1.5 text-xs text-muted tabular-nums transition-colors duration-100 hover:bg-hover hover:text-fg"
              >
                {Math.round(prefs.zoom * 100)}%
              </button>
              <IconButton label="Zoom in" size="xs" onClick={() => controller.zoomIn()} disabled={prefs.zoom >= ZOOM_MAX}>
                <PlusIcon size={14} />
              </IconButton>
            </div>
          </Row>
          <Row
            label="Session statistics"
            description="Telemetry pills above the composer: turns, speed and token usage for the open thread. Off by default."
          >
            <Toggle
              checked={prefs.showTelemetry}
              label="Session statistics"
              onChange={(on) => controller.setPrefs({ showTelemetry: on })}
            />
          </Row>
        </Section>

        <Section title="New threads">
          <Row label="Model" description="What a new thread starts on. Changing it here leaves running threads alone.">
            {models.length === 0 ? (
              <p className="text-xs text-subtle">No models loaded</p>
            ) : (
              <Pick
                value={prefs.defaultModelId}
                options={models.map((model) => ({
                  value: model.modelId,
                  // The contributor variants share a display name, so without this the list offers the same
                  // word twice and there is no way to tell which button is which.
                  label: model.contributor ? `${modelDisplayName(model.modelId)} · Contributor` : modelDisplayName(model.modelId),
                  hint: model.contributor ? "Contributor tier: prompts and outputs may be used for product improvement." : undefined,
                }))}
                onChange={(value) => void controller.setModel(value as string)}
              />
            )}
          </Row>
          <Row label="Permissions" description="What Muse may do before it asks you.">
            <div className="flex min-w-0 w-full flex-col items-end gap-1 @min-[520px]:w-auto">
              <Pick
                value={prefs.defaultMode}
                options={MODES.map((mode) => ({ value: mode.value as ApprovalMode, label: mode.label, hint: mode.description }))}
                onChange={(value) => void controller.setMode(value as ApprovalMode)}
                disabled={yoloSettings?.enabled === true}
              />
              {yoloSettings?.enabled ? (
                <p className="text-xs text-subtle">YOLO owns every thread&apos;s mode while it is on. Switch it off to choose.</p>
              ) : null}
            </div>
          </Row>
          <Row label="Reasoning effort" description="How long the model thinks before answering. Auto lets Muse choose per turn.">
            <Pick<ReasoningEffort | null>
              value={prefs.effort}
              options={[
                { value: null, label: "Auto", hint: "Muse picks the effort for each turn" },
                ...LEVELS.map((level) => ({ value: level.value, label: level.label, hint: level.description })),
              ]}
              onChange={(value) => controller.setEffort(value)}
            />
          </Row>
        </Section>

        <Section title="Accounts">
          <div className="p-4"><MuseSubscriptionCard /></div>
          <Row label="Additional accounts" description="Optional: keep work, personal or client logins separate. Choose an account beside the model picker for new threads.">
            {accounts === null ? (
              <p className="text-xs text-subtle">Loading…</p>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
                <PlusIcon size={13} /> Add account
              </Button>
            )}
          </Row>
          {accounts?.map((account) => (
            <Row key={account.id} label={account.name} description={account.hasLogin ? (account.email ?? "Signed in") : "Not signed in"}>
              <div className="flex flex-wrap items-center gap-2">
                {!account.hasLogin ? (
                  <Button size="sm" variant="secondary" onClick={() => void controller.beginLogin(account.id)}>
                    <SignInIcon size={13} /> Sign in with Meta
                  </Button>
                ) : null}
                <Button size="sm" variant="secondary" onClick={() => setRenaming(account)}>
                  <PencilSimpleIcon size={13} /> Rename
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(account)}>
                  <TrashIcon size={13} /> Remove account
                </Button>
              </div>
            </Row>
          ))}
        </Section>

        <Section title="Threads list">
          <Row label="Group by" description="How the sidebar arranges threads.">
            <Pick value={prefs.groupBy} options={GROUPS} onChange={(value) => controller.setGroupBy(value)} />
          </Row>
        </Section>

        <Section title="Thread titles">
          <Row
            label="Generate titles"
            description="Name new threads with one cheap model call instead of echoing the first prompt, and rename up to 30 recent threads that still echo. The calls run on your Muse Code plan. Off keeps the echo and makes no calls at all."
          >
            {titleSettings ? (
              <Toggle
                checked={titleSettings.enabled}
                label="Generate titles"
                onChange={(on) => void controller.setTitleEnabled(on)}
              />
            ) : (
              <p className="text-xs text-subtle">Loading…</p>
            )}
          </Row>
          {titleSettings?.enabled ? (
            <Row label="Title model" description="Which model writes the titles. Muse default lets the CLI choose.">
              {models.length === 0 ? (
                <p className="text-xs text-subtle">No models loaded</p>
              ) : (
                <Pick<string | null>
                  value={titleSettings.modelId}
                  options={[
                    { value: null, label: "Muse default" },
                    ...models.map((model) => ({
                      value: model.modelId as string | null,
                      label: model.contributor ? `${modelDisplayName(model.modelId)} · Contributor` : modelDisplayName(model.modelId),
                      hint: model.contributor ? "Contributor tier: prompts and outputs may be used for product improvement." : undefined,
                    })),
                  ]}
                  onChange={(value) => void controller.setTitleModel(value)}
                />
              )}
            </Row>
          ) : null}
        </Section>

        <Section title="Deep research">
          <Row
            label="Deep research"
            description="A research trigger in the composer and /research: parallel Muse workers search the web and read what they find, and a writer turns their notes into a report whose citations only name pages a worker opened. Every model call and search runs through Muse on your plan."
          >
            {researchSettings ? (
              <Toggle checked={researchSettings.enabled} label="Deep research" onChange={(on) => void controller.setResearchSettings({ enabled: on })} />
            ) : (
              <p className="text-xs text-subtle">Loading…</p>
            )}
          </Row>
          {researchSettings?.enabled ? <ResearchRows config={researchSettings.config} models={models} controller={controller} /> : null}
        </Section>

        <Section title="Approvals">
          <Row
            label="Answer approvals for me"
            description={
              bypassAll
                ? "Every request is allowed once, in every thread, without showing you the command. Off when Ancilla closes."
                : "Muse asks whenever it cannot resolve a command, whatever its permission mode. This answers those for you, until Ancilla closes."
            }
          >
            <Toggle
              checked={bypassAll}
              label="Answer approvals for me"
              onChange={(on) => (on ? setConfirmBypass(true) : controller.setBypassAll(false))}
            />
          </Row>
          {armedThreads > 0 ? (
            <Row label={`${armedThreads} thread${armedThreads === 1 ? "" : "s"} answering on their own`} description="Armed from an approval card.">
              <Button size="sm" variant="secondary" onClick={() => controller.clearThreadBypass()}>
                Ask again in all threads
              </Button>
            </Row>
          ) : null}
        </Section>

        <Section title="YOLO mode">
          <Row
            label="YOLO mode"
            description="Like muse --yolo: nothing asks for approval in any thread, new threads run without sandbox confinement, and workspaces are trusted. Existing threads keep the sandbox posture they started with. Flipping it restarts the running Muse hosts, interrupting their turns."
          >
            {yoloSettings ? (
              <Toggle
                checked={yoloSettings.enabled}
                label="YOLO mode"
                onChange={(on) => (on ? setConfirmYolo(true) : void controller.setYoloEnabled(false))}
              />
            ) : (
              <p className="text-xs text-subtle">Loading…</p>
            )}
          </Row>
        </Section>

        <Section title="Sandbox">
          <Row
            label="Disable sandboxing"
            description={
              yoloSettings?.enabled
                ? "Off because YOLO mode is on: YOLO already runs new threads without sandbox confinement. Switch YOLO off to control this separately."
                : "Muse's shells run sandboxed: filesystem and network access is confined. Switching this off lifts that confinement for new threads; existing threads keep the posture they started with. Flipping it restarts the running Muse hosts, interrupting their turns."
            }
          >
            {sandboxSettings ? (
              <Toggle
                checked={sandboxSettings.disabled}
                label="Disable sandboxing"
                disabled={yoloSettings?.enabled === true}
                onChange={(on) => (on ? setConfirmSandbox(true) : void controller.setSandboxDisabled(false))}
              />
            ) : (
              <p className="text-xs text-subtle">Loading…</p>
            )}
          </Row>
        </Section>

        <Section title="Notifications">
          <Row
            label="Tell me when a thread needs me"
            description="A system notification when a thread asks for approval, asks a question, finishes, fails, or its goal stops moving. Only while this window is in the background."
          >
            <Toggle
              checked={prefs.notifications}
              label="Notifications"
              // Switching on has to ask, and a browser only grants permission from a real press.
              onChange={(on) => (on ? void controller.askToNotify() : controller.setPrefs({ notifications: false }))}
            />
          </Row>
        </Section>

        {updates ? (
          <Section title="Updates">
            <Row label={`Ancilla ${updates.currentVersion ?? ""}`} description={updateSummary(updates, prefs.autoUpdate, prefs.updatesPaused, now)}>
              <div className="flex flex-wrap items-center gap-2">
                {updates.status === "ready" ? (
                  <Button size="sm" variant="primary" onClick={() => controller.restartToUpdate()}>
                    <ArrowClockwiseIcon size={13} /> Restart to update
                  </Button>
                ) : null}
                {updates.status === "available" ? (
                  <Button size="sm" variant="secondary" onClick={() => controller.downloadUpdate()}>
                    <ArrowLineDownIcon size={13} /> Download
                  </Button>
                ) : null}
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => controller.checkForUpdates()}>
                  <ArrowsClockwiseIcon size={13} className={cn(updates.status === "checking" && "animate-spin")} /> Check now
                </Button>
              </div>
            </Row>
            {updates.error ? <Row label="Last error" description={updates.error} /> : null}
            <Row label="Automatic updates" description="Download new versions in the background and install them when Ancilla closes.">
              <Toggle checked={prefs.autoUpdate} label="Automatic updates" onChange={(on) => controller.setAutoUpdate(on)} />
            </Row>
            <Row label="Pause updates" description="No checking, downloading or installing until you resume.">
              <Toggle checked={prefs.updatesPaused} label="Pause updates" onChange={(on) => controller.setUpdatesPaused(on)} />
            </Row>
          </Section>
        ) : null}

        <Section title="Environment">
          <Row label="What's new" description="The release notes for this version, as they appear after Ancilla updates itself.">
            <Button size="sm" variant="secondary" onClick={() => controller.setWhatsNewOpen(true)}>
              <ScrollIcon size={13} /> Read
            </Button>
          </Row>
          <Fact label="Ancilla" value={env?.version ?? "Unknown"} />
          <Fact label="Platform" value={env?.platform ?? "Unknown"} />
          {env?.platform === "win32" ? (
            <Fact
              label="Muse runs"
              value={env.runtime === "native" ? "Natively on Windows" : `In WSL${env.wslAvailable && env.defaultDistro ? ` (${env.defaultDistro})` : ""}`}
            />
          ) : null}
          <Fact label="Muse" value={env?.musePath ?? (env?.museFound ? "Found" : "Not found")} />
          <Fact label="Sessions" value={env?.persistent ? "Kept on disk" : "In memory only"} />
        </Section>

        <Section title="About">
          <About version={env?.version ?? null} />
        </Section>
      </div>
      </div>

      <Modal
        open={confirmBypass}
        onOpenChange={setConfirmBypass}
        title="Answer approvals for you?"
        description="Every approval Muse raises, in any thread, is allowed once without showing you the command first. Muse asks about the commands it could not resolve, so these are the ones nothing else has checked. This lasts until you close Ancilla."
      >
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmBypass(false)}>
            Keep asking
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmBypass(false);
              controller.setBypassAll(true);
            }}
          >
            Answer them for me
          </Button>
        </div>
      </Modal>

      <Modal
        open={confirmYolo}
        onOpenChange={setConfirmYolo}
        title="Turn on YOLO mode?"
        description="Like muse --yolo: nothing asks for approval in any thread, new threads run without sandbox confinement, and workspaces are trusted. The running Muse hosts restart, interrupting their turns, and threads already open keep the sandbox posture they started with. This stays on until you switch it off."
      >
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmYolo(false)}>
            Keep asking
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmYolo(false);
              void controller.setYoloEnabled(true);
            }}
          >
            Turn on YOLO
          </Button>
        </div>
      </Modal>

      <Modal
        open={confirmSandbox}
        onOpenChange={setConfirmSandbox}
        title="Disable Muse's sandbox?"
        description="New threads' shells will run without filesystem or network confinement, and the running Muse hosts restart, interrupting their turns. Threads already open keep their current confinement. Only do this in a disposable environment."
      >
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmSandbox(false)}>
            Keep the sandbox
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmSandbox(false);
              void controller.setSandboxDisabled(true);
            }}
          >
            Disable sandboxing
          </Button>
        </div>
      </Modal>

      <AddAccountModal open={addOpen} onOpenChange={setAddOpen} controller={controller} />
      <RenameAccountModal account={renaming} onOpenChange={(open) => !open && setRenaming(null)} controller={controller} />
      <RemoveAccountModal account={removing} onOpenChange={(open) => !open && setRemoving(null)} controller={controller} />
    </div>
  );
}
