import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowLineDownIcon,
  ArrowsClockwiseIcon,
  MinusIcon,
  PencilSimpleIcon,
  PlusIcon,
  ScrollIcon,
  SignInIcon,
  TrashIcon,
} from "../ui/icons.js";
import { forgetVoiceStatus } from "../voice/talk.js";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useApp, useController, useNow } from "../../app/context.js";
import { useOverlayDragProps } from "../../app/frame.js";
import { modelDisplayName } from "../../model/format.js";
import type { AncillaController } from "../../model/controller.js";
import {
  MODEL_COPY,
  NO_CHOICE,
  activeModel,
  choiceDetail,
  choiceName,
  effortNote,
  effortView,
  modelMenu,
  modelPickLine,
  modelsKey,
  providerBadgeName,
  tryTypedModel,
  type ModelsScope,
} from "../../model/models.js";
import { RESEARCH_LIMITS, WINDOW_STEP, clampResearchNumber } from "../../model/research.js";
import type { UpdateState } from "../../model/updates.js";
import {
  CODE_THEMES,
  ZOOM_MAX,
  ZOOM_MIN,
  defaultModelForScope,
  type CodeTheme,
  type GroupBy,
  type ThemePref,
} from "../../model/store.js";
import type {
  AccountView,
  ApprovalMode,
  AssistantProfileView,
  AssistantStatusView,
  EnvironmentStatus,
  ModelOption,
  ModelsStatus,
  ProviderId,
  ProviderView,
  ReasoningEffort,
  ResearchConfig,
  ResearchModelIds,
  VoiceBrainSetting,
  VoiceSettingsView,
  VoiceStatusView,
} from "../../types.js";
import { LEVELS, MODES, ModelIdForm } from "../composer/Composer.js";
import { CODE_THEME_LABELS, updateSummary } from "../sidebar/Sidebar.js";
import { Modal } from "../ui/overlays.js";
import { TopBar } from "../chrome.js";
import { Button, IconButton, MOD, Toggle, cn } from "../ui/primitives.js";
import { About } from "./About.js";
import { MuseSubscriptionCard } from "./MuseSignIn.js";
import { LinuxSetupCard } from "./LinuxSetup.js";
import { ProvidersSettings } from "./ProvidersSettings.js";

const THEME_OPTIONS: readonly { value: ThemePref; label: string }[] = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const GROUP_OPTIONS: readonly { value: GroupBy; label: string }[] = [
  { label: "Project", value: "project" },
  { label: "Status", value: "status" },
];

const DIALOG_INPUT_CLASS =
  "h-9 w-full rounded-lg border border-line bg-sunken px-3 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** Segmented options picker with responsive wrapping or smooth horizontal overflow. */
export function Pick<T extends string | number | null>({
  value,
  options,
  onChange,
  disabled = false,
  wrap = false,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (selected: T) => void;
  disabled?: boolean;
  wrap?: boolean;
  className?: string;
}) {
  const isMultiRow = wrap === true || options.length > 5;
  const flowStyle = isMultiRow
    ? "flex-wrap"
    : "overflow-x-auto overscroll-x-contain [scrollbar-width:thin]";

  return (
    <div className={cn("flex max-w-full min-w-0 items-center gap-1 rounded-lg bg-sunken p-0.5", flowStyle, className)}>
      {options.map((item) => {
        const isChosen = item.value === value;
        const buttonTheme = isChosen
          ? "selected-control bg-raised text-fg"
          : "text-muted hover:text-fg";
        return (
          <button
            key={String(item.value)}
            disabled={disabled}
            aria-pressed={isChosen}
            onClick={() => onChange(item.value)}
            title={item.hint}
            type="button"
            className={cn(
              "h-7 shrink-0 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40",
              buttonTheme,
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** Multi-provider model selector with catalog fallbacks, search filtering, and effort controls. */
export function ModelPick({
  value,
  onChange,
  full = false,
  tried,
  onTyped,
  scope,
  filter,
  museDefault,
}: {
  value: string | null;
  onChange: (modelId: string | null) => void;
  full?: boolean;
  tried?: boolean;
  onTyped?: (modelId: string) => Promise<boolean>;
  scope?: ModelsScope;
  filter?: string;
  museDefault?: boolean;
}) {
  const controller = useController();
  const models = useApp((s) => s.models);
  const accountModels = useApp((s) => s.accountModels);
  const modelsStatus = useApp((s) => s.modelsStatus);
  const accounts = useApp((s) => s.accounts);
  const providers = useApp((s) => s.providers);

  const activeScope = scope ?? {};
  const currentAccountId = activeScope.accountId ?? null;
  const isMuseProvider = !activeScope.providerId || activeScope.providerId === "muse";
  const scopedPreference = useApp((s) => defaultModelForScope(s.prefs, activeScope));
  const fallbackTried = useApp((s) => s.prefs.defaultModelTried);
  const hasTried = tried ?? (full && (activeScope.providerId && activeScope.providerId !== "muse" ? scopedPreference.tried : fallbackTried));

  const resolvedAccountModels = useMemo(() => {
    if (!accountModels) return accountModels;
    const merged: Record<string, readonly ModelOption[]> = { ...accountModels };
    for (const [k, v] of Object.entries(accountModels)) {
      if (k.startsWith("prov:")) {
        const altKey = k.slice(5);
        if (!(altKey in merged)) merged[altKey] = v;
      } else {
        const provPrefix = `prov:${k}`;
        if (!(provPrefix in merged)) merged[provPrefix] = v;
      }
    }
    return merged;
  }, [accountModels]);

  const resolvedModelsStatus = useMemo(() => {
    if (!modelsStatus) return modelsStatus;
    const merged: Record<string, ModelsStatus> = { ...modelsStatus };
    for (const [k, v] of Object.entries(modelsStatus)) {
      if (k.startsWith("prov:")) {
        const altKey = k.slice(5);
        if (!(altKey in merged)) merged[altKey] = v;
      } else {
        const provPrefix = `prov:${k}`;
        if (!(provPrefix in merged)) merged[provPrefix] = v;
      }
    }
    return merged;
  }, [modelsStatus]);

  const menu = modelMenu(
    { models, accountModels: resolvedAccountModels, modelsStatus: resolvedModelsStatus, accounts, providers },
    { scope: activeScope, accountId: currentAccountId, current: null, pref: value, plan: null, tried: hasTried, elsewhere: true },
  );

  const shouldShowMuseDefault = museDefault ?? (full && isMuseProvider && !activeScope.providerId);
  const statusLine = modelPickLine(menu, { museDefault: shouldShowMuseDefault });

  const candidateOptions = [
    ...menu.rows.map((row) => {
      const displayTitle = row.displayLabel ? (row.note ? `${row.displayLabel} (${row.note})` : row.displayLabel) : choiceName(row);
      const rowLabel = row.kind !== "default" && row.contributor ? `${displayTitle} · Contributor` : displayTitle;
      const rowHint = [row.isDefault ? (isMuseProvider ? "Muse's default" : "Default") : null, choiceDetail(row)].filter(Boolean).join(". ") || undefined;
      return { value: row.id, label: rowLabel, hint: rowHint };
    }),
    ...(full && isMuseProvider ? menu.published.map((m) => ({ value: m.id as string | null, label: m.label, hint: MODEL_COPY.notListed })) : []),
  ];

  const highlightedRow = menu.rows.find((row) => row.selected);
  const selectedModelId = highlightedRow
    ? highlightedRow.id
    : (candidateOptions.some((opt) => opt.value === value) ? value : NO_CHOICE);

  const [localQuery, setLocalQuery] = useState(filter ?? "");
  const searchFilter = filter !== undefined ? filter : localQuery;
  const scopeToken = modelsKey(activeScope);

  useEffect(() => {
    if (filter === undefined) {
      setLocalQuery("");
    }
  }, [scopeToken, filter]);

  const queryTerm = searchFilter.trim().toLowerCase();
  const visibleOptions = candidateOptions.length > 10 && queryTerm
    ? candidateOptions.filter((opt) => {
        if (opt.value === selectedModelId) return true;
        const matchesLabel = opt.label.toLowerCase().includes(queryTerm);
        const matchesValue = opt.value ? opt.value.toLowerCase().includes(queryTerm) : false;
        return matchesLabel || matchesValue;
      })
    : candidateOptions;

  const showRefreshAction = menu.mode === "error" || menu.mode === "empty" || full;
  const descriptionFooter = [menu.footer.line, menu.footer.builtIn ?? menu.footer.hint].filter(Boolean).join(". ");

  return (
    <div className="flex min-w-0 w-full flex-col items-end gap-1.5 @min-[520px]:w-auto">
      {menu.message ? (
        <p role={menu.mode === "error" ? "alert" : undefined} className="text-xs text-subtle [overflow-wrap:anywhere]">
          {menu.message}
        </p>
      ) : null}
      {menu.signIn ? (
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            const loginTarget = menu.signIn;
            if (!loginTarget) return;
            if (loginTarget.providerId && loginTarget.providerId !== "muse") {
              if (typeof controller.beginProviderLogin === "function") {
                void controller.beginProviderLogin(loginTarget.providerId, loginTarget.id);
              }
            } else if (typeof controller.beginLogin === "function") {
              void controller.beginLogin(loginTarget.id);
            }
          }}
        >
          <SignInIcon size={13} />
          {menu.signIn.actionLabel ?? MODEL_COPY.signInAction}
        </Button>
      ) : null}
      {candidateOptions.length > 10 ? (
        <input
          type="search"
          value={searchFilter}
          onChange={(ev) => setLocalQuery(ev.target.value)}
          placeholder="Filter models…"
          aria-label="Filter models"
          className="h-7 w-48 rounded-md bg-sunken px-2 text-xs text-fg placeholder:text-subtle outline-none focus-visible:ring-2 focus-visible:ring-focus"
        />
      ) : null}
      {menu.showRows ? (
        <Pick<string | null>
          wrap={candidateOptions.length > 5}
          value={selectedModelId}
          options={visibleOptions}
          onChange={(pickedId) => {
            if (pickedId !== selectedModelId && pickedId !== NO_CHOICE) {
              onChange(pickedId);
            }
          }}
        />
      ) : null}
      {statusLine ? <p className="text-xs text-muted [overflow-wrap:anywhere]">{statusLine}</p> : null}
      {full
        ? menu.notes.map((entry) => (
            <p key={entry} className="text-xs text-subtle [overflow-wrap:anywhere]">
              {entry}
            </p>
          ))
        : null}
      {showRefreshAction ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={menu.refreshing}
          onClick={() => {
            if (typeof controller.refreshModels === "function") {
              void controller.refreshModels({ ...activeScope, force: true });
            }
          }}
        >
          <ArrowsClockwiseIcon size={13} className={cn(menu.refreshing && "animate-spin")} />
          {menu.mode === "error" ? MODEL_COPY.retry : MODEL_COPY.refresh}
        </Button>
      ) : null}
      {full ? (
        <>
          {descriptionFooter ? <p className="text-xs text-subtle [overflow-wrap:anywhere]">{descriptionFooter}</p> : null}
          <div className="w-full @min-[520px]:w-72">
            <ModelIdForm
              label="Other model id"
              onUse={(customId) => {
                if (onTyped) return onTyped(customId);
                if (activeScope && (activeScope.providerId || activeScope.accountId)) {
                  if (typeof controller.setDefaultModelForScope === "function") {
                    controller.setDefaultModelForScope(activeScope, customId, { typed: true });
                  }
                  return Promise.resolve(true);
                }
                return tryTypedModel(controller, customId);
              }}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

export function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-center gap-2 text-xs leading-4 font-medium tracking-[0.04em] text-muted uppercase">
        {title}
      </h2>
      <div className="overflow-hidden rounded-xl bg-raised shadow-panel">{children}</div>
    </section>
  );
}

export function Row({
  label,
  description,
  descriptionClassName,
  children,
}: {
  label: ReactNode;
  description?: string;
  descriptionClassName?: string;
  children?: ReactNode;
}) {
  const textTone = descriptionClassName ?? "text-muted";
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t border-line px-4 py-3 first:border-t-0">
      <div className="min-w-[13rem] flex-1 basis-64">
        <p className="text-sm text-fg">{label}</p>
        {description ? <p className={cn("mt-0.5 text-xs text-pretty", textTone)}>{description}</p> : null}
      </div>
      {children ? <div className="min-w-0 w-full @min-[520px]:w-auto">{children}</div> : null}
    </div>
  );
}

export function Num({
  value,
  min,
  max,
  step = 1,
  unit,
  label,
  onChange,
  disabled = false,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  label: string;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const [editingValue, setEditingValue] = useState<string | null>(null);

  const commitChanges = () => {
    if (editingValue === null) return;
    const clamped = clampResearchNumber(editingValue, { min, max }, step);
    setEditingValue(null);
    if (clamped !== null && clamped !== value) {
      onChange(clamped);
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={editingValue ?? String(value)}
        disabled={disabled}
        aria-label={label}
        onChange={(ev) => setEditingValue(ev.currentTarget.value)}
        onBlur={commitChanges}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            commitChanges();
          }
        }}
        className="h-7 w-16 rounded-md bg-sunken px-2 text-right text-xs text-fg tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40"
      />
      {unit ? <span>{unit}</span> : null}
    </span>
  );
}

function ResearchRows({ config, controller }: { config: ResearchConfig; controller: AncillaController }) {
  const applyConfigPatch = (patch: Partial<ResearchConfig>) => {
    void controller.setResearchSettings({ config: patch });
  };
  const bounds = RESEARCH_LIMITS;

  const buildModelRow = (role: keyof ResearchModelIds, title: string, explanation: string) => (
    <Row label={title} description={explanation}>
      <ModelPick
        value={config.models[role]}
        onChange={(chosenId) => applyConfigPatch({ models: { ...config.models, [role]: chosenId } })}
      />
    </Row>
  );

  return (
    <>
      <Row
        label="Research window"
        description="How long the workers have before the writer takes over: no report before the minimum unless nothing is left to look up, and to the writer at the maximum."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Num
            value={config.windowMinMinutes}
            min={bounds.windowMinutes.min}
            max={bounds.windowMinutes.max}
            step={WINDOW_STEP}
            unit="to"
            label="Window minimum, minutes"
            onChange={(val) =>
              applyConfigPatch(val > config.windowMaxMinutes ? { windowMinMinutes: val, windowMaxMinutes: val } : { windowMinMinutes: val })
            }
          />
          <Num
            value={config.windowMaxMinutes}
            min={bounds.windowMinutes.min}
            max={bounds.windowMinutes.max}
            step={WINDOW_STEP}
            unit="minutes"
            label="Window maximum, minutes"
            onChange={(val) =>
              applyConfigPatch(val < config.windowMinMinutes ? { windowMaxMinutes: val, windowMinMinutes: val } : { windowMaxMinutes: val })
            }
          />
        </div>
      </Row>
      <Row
        label="Parallel workers"
        description={`How many Muse sessions research at once, up to ${bounds.parallel.max}. Each is a session on your plan.`}
      >
        <Num
          value={config.maxParallel}
          min={bounds.parallel.min}
          max={bounds.parallel.max}
          unit="workers"
          label="Parallel workers"
          onChange={(count) => applyConfigPatch({ maxParallel: count })}
        />
      </Row>
      <Row
        label="Supervisor rounds"
        description={`How many times the supervisor may send workers out before it has to write, up to ${bounds.rounds.max}.`}
      >
        <Num
          value={config.maxRounds}
          min={bounds.rounds.min}
          max={bounds.rounds.max}
          unit="rounds"
          label="Supervisor rounds"
          onChange={(total) => applyConfigPatch({ maxRounds: total })}
        />
      </Row>
      <Row
        label="Per worker"
        description="What one worker may do in one round: searches, pages read, and sources it may keep for the report."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Num
            value={config.workerMaxSearches}
            min={bounds.workerSearches.min}
            max={bounds.workerSearches.max}
            unit="searches"
            label="Searches per worker"
            onChange={(count) => applyConfigPatch({ workerMaxSearches: count })}
          />
          <Num
            value={config.workerMaxReads}
            min={bounds.workerReads.min}
            max={bounds.workerReads.max}
            unit="reads"
            label="Reads per worker"
            onChange={(count) => applyConfigPatch({ workerMaxReads: count })}
          />
          <Num
            value={config.workerMaxSaves}
            min={bounds.workerSaves.min}
            max={bounds.workerSaves.max}
            unit="saves"
            label="Saves per worker"
            onChange={(count) => applyConfigPatch({ workerMaxSaves: count })}
          />
        </div>
      </Row>
      {buildModelRow("supervisor", "Supervisor model", "Scopes the question and decides what to send the workers after. Muse default lets the CLI choose.")}
      {buildModelRow("worker", "Worker model", "Runs the searches and reads the pages.")}
      {buildModelRow("writer", "Writer model", "Turns the workers' notes into the report.")}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 first:border-t-0">
      <span className="text-sm text-muted">{label}</span>
      <span className="min-w-0 font-mono text-xs break-all text-fg">{value}</span>
    </div>
  );
}

function AddAccountModal({
  open,
  onOpenChange,
  controller,
}: {
  open: boolean;
  onOpenChange: (show: boolean) => void;
  controller: AncillaController;
}) {
  const [profileInput, setProfileInput] = useState("");
  const [accountTitle, setAccountTitle] = useState("");
  const [copyFromDefault, setCopyFromDefault] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const existingProfiles = useApp((s) => s.accounts);

  const autoGeneratedSlug = useMemo(() => {
    return accountTitle.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  }, [accountTitle]);

  const activeProfileId = profileInput.trim() || autoGeneratedSlug;
  const isFormatAcceptable = /^[a-z0-9][a-z0-9-]{0,31}$/.test(activeProfileId);
  const isDuplicateId = Boolean(existingProfiles?.some((acc) => acc.id === activeProfileId));
  const isSubmissionAllowed = isFormatAcceptable && !isDuplicateId && !isSubmitting;

  const handleCreate = async () => {
    if (!isSubmissionAllowed) return;
    setIsSubmitting(true);
    const succeeded = await controller.createAccount(activeProfileId, accountTitle.trim() || undefined, copyFromDefault);
    setIsSubmitting(false);
    if (succeeded) {
      setProfileInput("");
      setAccountTitle("");
      setCopyFromDefault(false);
      onOpenChange(false);
      void controller.beginLogin(activeProfileId);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(nextState) => { if (!isSubmitting) onOpenChange(nextState); }}
      title="Add account"
      description="Give this login a label, then sign in with Meta. Each account keeps its own Muse profile."
    >
      <div className="mt-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="account-add-name">
            Account label
          </label>
          <input
            type="text"
            id="account-add-name"
            className={DIALOG_INPUT_CLASS}
            value={accountTitle}
            onChange={(ev) => setAccountTitle(ev.target.value)}
            placeholder="Personal, Work, or a client name"
          />
        </div>
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Profile id: {activeProfileId || "generated from your label"}</summary>
          <label className="mt-2 block" htmlFor="account-add-id">
            Lowercase letters, numbers and hyphens; up to 32 characters.
          </label>
          <input
            type="text"
            id="account-add-id"
            className={cn(DIALOG_INPUT_CLASS, "mt-1.5")}
            value={profileInput}
            onChange={(ev) => setProfileInput(ev.target.value)}
            placeholder={autoGeneratedSlug || "personal"}
          />
        </details>
        {isDuplicateId ? (
          <p role="alert" className="text-xs text-warn-text">
            This label already has a profile. Choose another label or change the profile id.
          </p>
        ) : null}
        {(activeProfileId || accountTitle.trim()) && !isFormatAcceptable ? (
          <p role="alert" className="text-xs text-warn-text">
            Choose a profile id using lowercase letters, numbers and hyphens.
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-fg">Copy settings from the default login</p>
            <p className="mt-1 text-xs text-subtle">Copies preferences and trusted folders, never credentials.</p>
          </div>
          <Toggle checked={copyFromDefault} onChange={setCopyFromDefault} label="Copy settings from the default login" />
        </div>
      </div>
      <div className="mt-6 flex items-center justify-end gap-2">
        <Button variant="ghost" disabled={isSubmitting} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!isSubmissionAllowed} loading={isSubmitting} onClick={() => void handleCreate()}>
          Continue to Meta sign-in
        </Button>
      </div>
    </Modal>
  );
}

function RenameAccountModal({
  account,
  onOpenChange,
  controller,
}: {
  account: AccountView | null;
  onOpenChange: (open: boolean) => void;
  controller: AncillaController;
}) {
  const [accountName, setAccountName] = useState("");

  useEffect(() => {
    setAccountName(account?.name ?? "");
  }, [account]);

  const handleRename = async () => {
    if (!account || !accountName.trim()) return;
    const ok = await controller.renameAccount(account.id, accountName.trim());
    if (ok) onOpenChange(false);
  };

  return (
    <Modal open={account !== null} onOpenChange={onOpenChange} title="Rename account">
      <div className="space-y-1.5 pt-4">
        <label className="text-xs font-medium text-muted" htmlFor="account-rename-name">Name</label>
        <input
          type="text"
          id="account-rename-name"
          className={DIALOG_INPUT_CLASS}
          value={accountName}
          onChange={(ev) => setAccountName(ev.target.value)}
        />
      </div>
      <div className="mt-6 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!accountName.trim()} onClick={() => void handleRename()}>Rename</Button>
      </div>
    </Modal>
  );
}

function RemoveAccountModal({
  account,
  onOpenChange,
  controller,
}: {
  account: AccountView | null;
  onOpenChange: (open: boolean) => void;
  controller: AncillaController;
}) {
  const handleRemove = async () => {
    if (!account) return;
    const ok = await controller.removeAccount(account.id);
    if (ok) onOpenChange(false);
  };

  return (
    <Modal
      open={account !== null}
      onOpenChange={onOpenChange}
      title="Remove this account?"
      description="The profile's local settings are deleted. Any threads that used it keep running under it until they end."
    >
      <div className="mt-6 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="danger" onClick={() => void handleRemove()}>Remove account</Button>
      </div>
    </Modal>
  );
}

function ConfirmBypassModal({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const proceed = () => {
    onOpenChange(false);
    onConfirm();
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Answer approvals for you?"
      description="Every approval Muse raises, in any thread, is allowed once without showing you the command first. Muse asks about the commands it could not resolve, so these are the ones nothing else has checked. This lasts until you close Ancilla."
    >
      <div className="mt-6 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Keep asking</Button>
        <Button variant="danger" onClick={proceed}>Answer them for me</Button>
      </div>
    </Modal>
  );
}

function ConfirmYoloModal({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const proceed = () => {
    onOpenChange(false);
    onConfirm();
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Turn on YOLO mode?"
      description="Like muse --yolo: nothing asks for approval in any thread, new threads run without sandbox confinement, and workspaces are trusted. The running Muse hosts restart, interrupting their turns, and threads already open keep the sandbox posture they started with. This stays on until you switch it off."
    >
      <div className="mt-6 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Keep asking</Button>
        <Button variant="danger" onClick={proceed}>Turn on YOLO</Button>
      </div>
    </Modal>
  );
}

function ConfirmSandboxModal({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const proceed = () => {
    onOpenChange(false);
    onConfirm();
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Disable Muse's sandbox?"
      description="New threads' shells will run without filesystem or network confinement, and the running Muse hosts restart, interrupting their turns. Threads already open keep their current confinement. Only do this in a disposable environment."
    >
      <div className="mt-6 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Keep the sandbox</Button>
        <Button variant="danger" onClick={proceed}>Disable sandboxing</Button>
      </div>
    </Modal>
  );
}

function ZoomControls({
  zoom,
  controller,
}: {
  zoom: number;
  controller: AncillaController;
}) {
  return (
    <div className="flex items-center gap-1">
      <IconButton label="Zoom out" size="xs" onClick={() => controller.zoomOut()} disabled={zoom <= ZOOM_MIN}><MinusIcon size={14} /></IconButton>
      <button type="button" onClick={() => controller.resetZoom()} title="Reset zoom to 100%" className="h-6 min-w-11 rounded-md px-1.5 text-xs text-muted tabular-nums transition-colors duration-100 hover:bg-hover hover:text-fg">{Math.round(zoom * 100)}%</button>
      <IconButton label="Zoom in" size="xs" onClick={() => controller.zoomIn()} disabled={zoom >= ZOOM_MAX}><PlusIcon size={14} /></IconButton>
    </div>
  );
}

export interface ProviderAccountOption {
  value: string;
  label: string;
  hint?: string;
}

export function buildProviderAccountOptions(
  accounts: readonly AccountView[] | null,
  providers: readonly ProviderView[] | null,
  cfg: {
    includeFollowAssistant?: boolean;
    includeFollowProject?: boolean;
    includeCustom?: boolean;
    includeNone?: boolean;
    defaultMuseLabel?: string;
    customLabel?: string;
  } = {},
): ProviderAccountOption[] {
  const optionsList: ProviderAccountOption[] = [];

  if (cfg.includeFollowAssistant) {
    optionsList.push({
      value: "assistant",
      label: "Follow assistant",
      hint: "Uses the same provider and model configured for the assistant",
    });
  }

  if (cfg.includeFollowProject) {
    optionsList.push({
      value: "project",
      label: "Follow project",
      hint: "Uses whichever provider and model the active project or thread uses",
    });
  }

  const alternativeProviders = (providers ?? []).filter((item) => {
    if (item.id === "muse") return false;
    return item.id === "api" ? item.accounts.length > 0 : item.binary.available || item.accounts.length > 0;
  });

  const museFallbackLabel = cfg.defaultMuseLabel ?? (alternativeProviders.length > 0 ? "Meta Muse · Default login" : "Meta Muse");
  optionsList.push({
    value: "muse::",
    label: museFallbackLabel,
    hint: "Your Muse subscription",
  });

  for (const acct of accounts ?? []) {
    optionsList.push({
      value: `muse::${acct.id}`,
      label: `Meta Muse · ${acct.name}`,
      hint: acct.hasLogin ? (acct.email ?? "Signed in") : "Not signed in",
    });
  }

  for (const prov of alternativeProviders) {
    if (prov.id === "api") continue;

    if (!prov.id.startsWith("acp:") && prov.binary.available) {
      const authHint = prov.defaultAuth?.summary ?? (prov.defaultAuth?.state === "authenticated" ? "Signed in" : "Sign in in Settings");
      optionsList.push({
        value: `${prov.id}::`,
        label: prov.displayName,
        hint: authHint,
      });
    }

    for (const subAcct of prov.accounts) {
      if ("providerId" in subAcct) {
        const subHint = subAcct.auth?.summary ?? (subAcct.auth?.state === "authenticated" ? "Signed in" : undefined);
        optionsList.push({
          value: `${prov.id}::${subAcct.id}`,
          label: `${providerBadgeName(prov.id)} · ${subAcct.name}`,
          hint: subHint,
        });
      }
    }
  }

  const apiEntry = (providers ?? []).find((p) => p.id === "api");
  if (apiEntry) {
    for (const acct of apiEntry.accounts) {
      if ("providerId" in acct) {
        optionsList.push({
          value: `api::${acct.id}`,
          label: `API · ${acct.name}`,
          hint: acct.apiBaseUrl ?? undefined,
        });
      }
    }
  }

  if (cfg.includeCustom) {
    optionsList.push({
      value: "custom",
      label: cfg.customLabel ?? "Custom endpoint",
      hint: "Hosted providers (Anthropic, OpenAI, Gemini) or a local server",
    });
  }

  if (cfg.includeNone) {
    optionsList.push({
      value: "none",
      label: "None",
      hint: "Turn voice answering off",
    });
  }

  return optionsList;
}

function AppearanceSection({
  prefs,
  controller,
}: {
  prefs: { theme: ThemePref; codeTheme: CodeTheme; zoom: number; showTelemetry: boolean };
  controller: AncillaController;
}) {
  const TELEMETRY_DESC = "Telemetry pills above the composer: turns, speed and token usage for the open thread. Off by default.";
  return (
    <Section title="Appearance">
      <Row label="Theme" description="Light, dark, or whatever this device is set to.">
        <Pick value={prefs.theme} options={THEME_OPTIONS} onChange={(val) => controller.setTheme(val)} />
      </Row>
      <Row label="Code" description="Colours for code and diffs, independent of the app's own theme.">
        <Pick
          value={prefs.codeTheme}
          options={CODE_THEMES.map((themeName) => ({ label: CODE_THEME_LABELS[themeName], value: themeName as CodeTheme }))}
          onChange={(theme) => controller.setCodeTheme(theme)}
        />
      </Row>
      <Row
        label="Zoom"
        description={`How big the whole interface is. ${MOD} plus, ${MOD} minus and ${MOD} 0 adjust it anywhere; the percentage resets it.`}
      >
        <ZoomControls zoom={prefs.zoom} controller={controller} />
      </Row>
      <Row label="Session statistics" description={TELEMETRY_DESC}>
        <Toggle
          label="Session statistics"
          checked={prefs.showTelemetry}
          onChange={(enabled) => controller.setPrefs({ showTelemetry: enabled })}
        />
      </Row>
    </Section>
  );
}

function NewThreadsSection({
  hasMultipleChatProviders,
  chatProviderOptions,
  newThreadsScope,
  setNewThreadsScope,
  selectedChatScope,
  prefs,
  controller,
  yoloSettings,
  effort,
  effortHint,
}: {
  hasMultipleChatProviders: boolean;
  chatProviderOptions: readonly ProviderAccountOption[];
  newThreadsScope: string;
  setNewThreadsScope: (val: string) => void;
  selectedChatScope: ModelsScope;
  prefs: { defaultMode: ApprovalMode; defaultModelTried?: boolean };
  controller: AncillaController;
  yoloSettings: { enabled: boolean } | null;
  effort: { shown: ReasoningEffort | null; levels: readonly { value: ReasoningEffort; label: string; description: string }[] };
  effortHint: string | null;
}) {
  const PERMISSIONS_NOTE = "What Muse may do before it asks you.";
  const REASONING_NOTE = "How long the model thinks before answering. Auto lets Muse choose per turn.";

  return (
    <Section title="New threads">
      {hasMultipleChatProviders ? (
        <Row
          label="Provider & account"
          description="Which subscription or API account new threads start with. Changing this chooses which provider's default chat model you are editing below."
        >
          <Pick
            wrap
            value={newThreadsScope}
            options={chatProviderOptions}
            onChange={(chosenScope) => setNewThreadsScope(chosenScope)}
          />
        </Row>
      ) : null}
      <Row label="Model" description="What a new thread starts on. Muse default follows whatever Muse picks. Changing it here leaves running threads alone.">
        <ModelPick
          full
          scope={selectedChatScope}
          value={defaultModelForScope(prefs as any, selectedChatScope).modelId}
          onChange={(chosenModel) => {
            if (typeof controller.setDefaultModelForScope === "function") {
              controller.setDefaultModelForScope(selectedChatScope, chosenModel);
            }
          }}
          onTyped={async (customModel) => {
            if (typeof controller.setDefaultModelForScope === "function") {
              controller.setDefaultModelForScope(selectedChatScope, customModel, { typed: true });
            }
            return true;
          }}
        />
      </Row>
      <Row label="Permissions" description={PERMISSIONS_NOTE}>
        <div className="flex min-w-0 w-full flex-col items-end gap-1 @min-[520px]:w-auto">
          <Pick
            disabled={yoloSettings?.enabled === true}
            value={prefs.defaultMode}
            options={MODES.map((mode) => ({ hint: mode.description, label: mode.label, value: mode.value as ApprovalMode }))}
            onChange={(modeChoice) => void controller.setMode(modeChoice as ApprovalMode)}
          />
          {yoloSettings?.enabled ? (
            <p className={cn("text-xs text-subtle")}>YOLO owns every thread&apos;s mode while it is on. Switch it off to choose.</p>
          ) : null}
        </div>
      </Row>
      <Row label="Reasoning effort" description={REASONING_NOTE}>
        <div className="flex min-w-0 w-full flex-col items-end gap-1 @min-[520px]:w-auto">
          <Pick<ReasoningEffort | null>
            value={effort.shown}
            options={[
              { label: "Auto", value: null, hint: "Muse picks the effort for each turn" },
              ...effort.levels.map((lvl) => ({ hint: lvl.description, label: lvl.label, value: lvl.value })),
            ]}
            onChange={(effortChoice) => controller.setEffort(effortChoice)}
          />
          {effortHint ? <p className="text-xs text-subtle">{effortHint}</p> : null}
        </div>
      </Row>
    </Section>
  );
}

function AssistantSection({
  taskKey,
  taskProviderOptions,
  onTaskProviderChange,
  taskScope,
  assistantProfile,
  onSaveAssistantModel,
  hasVoice,
  voiceKey,
  voiceProviderOptions,
  onVoiceProviderChange,
  voiceScope,
  voiceBrainModel,
  onSaveVoiceModel,
}: {
  taskKey: string;
  taskProviderOptions: readonly ProviderAccountOption[];
  onTaskProviderChange: (key: string) => Promise<void>;
  taskScope: ModelsScope;
  assistantProfile: AssistantProfileView | null;
  onSaveAssistantModel: (model: { providerId: ProviderId | null; accountId: string | null; modelId: string | null }) => Promise<void>;
  hasVoice: boolean;
  voiceKey: string;
  voiceProviderOptions: readonly ProviderAccountOption[];
  onVoiceProviderChange: (key: string) => Promise<void>;
  voiceScope: ModelsScope;
  voiceBrainModel: string | null;
  onSaveVoiceModel: (modelId: string | null) => Promise<void>;
}) {
  return (
    <Section title="Assistant">
      <Row
        label="Task provider & account"
        description="Which subscription, provider, or API endpoint powers the assistant across voice calls, background tasks, and research. Follow project uses whichever model the open thread or project uses."
      >
        <Pick
          wrap
          value={taskKey}
          options={taskProviderOptions}
          onChange={(chosenKey) => void onTaskProviderChange(chosenKey)}
        />
      </Row>
      {taskKey !== "project" ? (
        <Row
          label="Task model"
          description="Which model powers the assistant across voice calls, autonomous tasks, and research. Changes take effect on the next turn, even during an open call."
        >
          <ModelPick
            full
            museDefault={false}
            scope={taskScope}
            value={assistantProfile?.model?.modelId ?? null}
            onChange={(chosenModelId) => {
              const sep = taskKey.indexOf("::");
              const prov = (sep >= 0 ? taskKey.slice(0, sep) : "muse") as ProviderId;
              const acct = sep >= 0 ? taskKey.slice(sep + 2) || null : null;
              void onSaveAssistantModel({ providerId: prov, accountId: acct, modelId: chosenModelId });
            }}
            onTyped={async (customModelId) => {
              const sep = taskKey.indexOf("::");
              const prov = (sep >= 0 ? taskKey.slice(0, sep) : "muse") as ProviderId;
              const acct = sep >= 0 ? taskKey.slice(sep + 2) || null : null;
              await onSaveAssistantModel({ providerId: prov, accountId: acct, modelId: customModelId });
              return true;
            }}
          />
        </Row>
      ) : null}
      {hasVoice ? (
        <>
          <Row
            label="Voice & web provider"
            description="Follow assistant uses the same model selected above for spoken calls and web tasks, or pick a separate fast voice-only override."
          >
            <Pick
              wrap
              value={voiceKey}
              options={voiceProviderOptions}
              onChange={(chosenKey) => void onVoiceProviderChange(chosenKey)}
            />
          </Row>
          {voiceKey !== "none" && voiceKey !== "custom" && voiceKey !== "assistant" ? (
            <Row
              label="Voice & web model"
              description="Which model thinks of what to say when overriding the assistant model. Applies on the next turn, even during an open call."
            >
              <ModelPick
                full
                museDefault={false}
                scope={voiceScope}
                value={voiceBrainModel}
                onChange={(chosenModelId) => void onSaveVoiceModel(chosenModelId)}
                onTyped={async (customModelId) => {
                  await onSaveVoiceModel(customModelId);
                  return true;
                }}
              />
            </Row>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function AccountItemRow({
  account,
  controller,
  onRename,
  onRemove,
}: {
  account: AccountView;
  controller: AncillaController;
  onRename: (acct: AccountView) => void;
  onRemove: (acct: AccountView) => void;
}) {
  const accountDescription = account.hasLogin ? (account.email ?? "Signed in") : "Not signed in";
  return (
    <Row label={account.name} description={accountDescription}>
      <div className="flex flex-wrap items-center gap-2">
        {!account.hasLogin ? (
          <Button size="sm" variant="secondary" onClick={() => void controller.beginLogin(account.id)}><SignInIcon size={13} /> Sign in with Meta</Button>
        ) : null}
        <Button size="sm" variant="secondary" onClick={() => onRename(account)}><PencilSimpleIcon size={13} /> Rename</Button>
        <Button size="sm" variant="ghost" onClick={() => onRemove(account)}><TrashIcon size={13} /> Remove account</Button>
      </div>
    </Row>
  );
}

function AccountsSection({
  accounts,
  onAddAccount,
  onRenameAccount,
  onRemoveAccount,
  controller,
}: {
  accounts: readonly AccountView[] | null;
  onAddAccount: () => void;
  onRenameAccount: (account: AccountView) => void;
  onRemoveAccount: (account: AccountView) => void;
  controller: AncillaController;
}) {
  return (
    <Section title="Accounts">
      <div className="p-4"><MuseSubscriptionCard /></div>
      <Row label="Additional accounts" description="Optional: keep work, personal or client logins separate. Choose an account beside the model picker for new threads.">
        {accounts === null ? (
          <span className="text-xs text-subtle">Loading…</span>
        ) : (
          <Button size="sm" variant="secondary" onClick={onAddAccount}><PlusIcon size={13} /> Add account</Button>
        )}
      </Row>
      {accounts?.map((account) => (
        <AccountItemRow
          key={account.id}
          account={account}
          controller={controller}
          onRename={onRenameAccount}
          onRemove={onRemoveAccount}
        />
      ))}
    </Section>
  );
}

function ThreadTitlesSection({
  titleSettings,
  controller,
}: {
  titleSettings: { enabled: boolean; modelId: string | null } | null;
  controller: AncillaController;
}) {
  const TITLE_GEN_NOTE = "Name new threads with one cheap model call instead of echoing the first prompt, and rename up to 30 recent threads that still echo. The calls run on your Muse Code plan. Off keeps the echo and makes no calls at all.";
  const TITLE_MODEL_NOTE = "Which model writes the titles. Muse default lets the CLI choose.";

  return (
    <Section title="Thread titles">
      <Row label="Generate titles" description={TITLE_GEN_NOTE}>
        {titleSettings ? (
          <Toggle
            label="Generate titles"
            checked={titleSettings.enabled}
            onChange={(active) => void controller.setTitleEnabled(active)}
          />
        ) : (
          <span className="text-xs text-subtle">Loading…</span>
        )}
      </Row>
      {titleSettings?.enabled ? (
        <Row label="Title model" description={TITLE_MODEL_NOTE}>
          <ModelPick value={titleSettings.modelId} onChange={(m) => void controller.setTitleModel(m)} />
        </Row>
      ) : null}
    </Section>
  );
}

function ApprovalsSection({
  bypassAll,
  armedThreads,
  onRequestBypass,
  onDisableBypass,
  onClearThreadBypass,
}: {
  bypassAll: boolean;
  armedThreads: number;
  onRequestBypass: () => void;
  onDisableBypass: () => void;
  onClearThreadBypass: () => void;
}) {
  const approvalHint = bypassAll
    ? "Every request is allowed once, in every thread, without showing you the command. Off when Ancilla closes."
    : "Muse asks whenever it cannot resolve a command, whatever its permission mode. This answers those for you, until Ancilla closes.";
  const ARMED_TITLE = `${armedThreads} thread${armedThreads === 1 ? "" : "s"} answering on their own`;
  const ARMED_NOTE = "Armed from an approval card.";

  return (
    <Section title="Approvals">
      <Row label="Answer approvals for me" description={approvalHint}>
        <Toggle
          label="Answer approvals for me"
          checked={bypassAll}
          onChange={(flag) => (flag ? onRequestBypass() : onDisableBypass())}
        />
      </Row>
      {armedThreads > 0 ? (
        <Row label={ARMED_TITLE} description={ARMED_NOTE}>
          <Button size="sm" variant="secondary" onClick={onClearThreadBypass}>Ask again in all threads</Button>
        </Row>
      ) : null}
    </Section>
  );
}

function YoloSection({
  yoloSettings,
  onRequestYolo,
  onDisableYolo,
}: {
  yoloSettings: { enabled: boolean } | null;
  onRequestYolo: () => void;
  onDisableYolo: () => void;
}) {
  const YOLO_NOTE = "Like muse --yolo: nothing asks for approval in any thread, new threads run without sandbox confinement, and workspaces are trusted. Existing threads keep the sandbox posture they started with. Flipping it restarts the running Muse hosts, interrupting their turns.";
  return (
    <Section title="YOLO mode">
      <Row label="YOLO mode" description={YOLO_NOTE}>
        {yoloSettings ? (
          <Toggle
            label="YOLO mode"
            checked={yoloSettings.enabled}
            onChange={(flag) => (flag ? onRequestYolo() : onDisableYolo())}
          />
        ) : (
          <span className="text-xs text-subtle">Loading…</span>
        )}
      </Row>
    </Section>
  );
}

function SandboxSection({
  sandboxSettings,
  isYoloEnabled,
  onRequestDisableSandbox,
  onEnableSandbox,
}: {
  sandboxSettings: { disabled: boolean } | null;
  isYoloEnabled: boolean;
  onRequestDisableSandbox: () => void;
  onEnableSandbox: () => void;
}) {
  const sandboxExplanation = isYoloEnabled
    ? "Off because YOLO mode is on: YOLO already runs new threads without sandbox confinement. Switch YOLO off to control this separately."
    : "Muse's shells run sandboxed: filesystem and network access is confined. Switching this off lifts that confinement for new threads; existing threads keep the posture they started with. Flipping it restarts the running Muse hosts, interrupting their turns.";

  return (
    <Section title="Sandbox">
      <Row label="Disable sandboxing" description={sandboxExplanation}>
        {sandboxSettings ? (
          <Toggle
            label="Disable sandboxing"
            disabled={isYoloEnabled}
            checked={sandboxSettings.disabled}
            onChange={(flag) => (flag ? onRequestDisableSandbox() : onEnableSandbox())}
          />
        ) : (
          <span className="text-xs text-subtle">Loading…</span>
        )}
      </Row>
    </Section>
  );
}

function UpdatesSection({
  updates,
  autoUpdate,
  updatesPaused,
  controller,
  now,
  isUpdatingBusy,
}: {
  updates: UpdateState;
  autoUpdate: boolean;
  updatesPaused: boolean;
  controller: AncillaController;
  now: number;
  isUpdatingBusy: boolean;
}) {
  return (
    <Section title="Updates">
      <Row label={`Ancilla ${updates.currentVersion ?? ""}`} description={updateSummary(updates as any, autoUpdate, updatesPaused, now)}>
        <div className="flex flex-wrap items-center gap-2">
          {updates.status === "ready" ? (
            <Button size="sm" variant="primary" onClick={() => controller.restartToUpdate()}><ArrowClockwiseIcon size={13} /> Restart to update</Button>
          ) : null}
          {updates.status === "available" ? (
            <Button size="sm" variant="secondary" onClick={() => controller.downloadUpdate()}><ArrowLineDownIcon size={13} /> Download</Button>
          ) : null}
          <Button size="sm" variant="secondary" disabled={isUpdatingBusy} onClick={() => controller.checkForUpdates()}><ArrowsClockwiseIcon size={13} className={cn(updates.status === "checking" && "animate-spin")} /> Check now</Button>
        </div>
      </Row>
      {updates.error ? <Row label="Last error" description={updates.error} /> : null}
      <Row label="Automatic updates" description="Download new versions in the background and install them when Ancilla closes.">
        <Toggle label="Automatic updates" checked={autoUpdate} onChange={(active) => controller.setAutoUpdate(active)} />
      </Row>
      <Row label="Pause updates" description="No checking, downloading or installing until you resume.">
        <Toggle label="Pause updates" checked={updatesPaused} onChange={(paused) => controller.setUpdatesPaused(paused)} />
      </Row>
    </Section>
  );
}

function EnvironmentSection({
  env,
  onOpenWhatsNew,
}: {
  env: EnvironmentStatus | null;
  onOpenWhatsNew: () => void;
}) {
  const wslDistroDetails = env?.wslAvailable && env.defaultDistro ? ` (${env.defaultDistro})` : "";
  const runtimeExplanation = env?.runtime === "native" ? "Natively on Windows" : `In WSL${wslDistroDetails}`;

  return (
    <Section title="Environment">
      <Row label="What's new" description="The release notes for this version, as they appear after Ancilla updates itself.">
        <Button size="sm" variant="secondary" onClick={onOpenWhatsNew}><ScrollIcon size={13} /> Read</Button>
      </Row>
      <Fact label="Platform" value={env?.platform ?? "Unknown"} />
      <Fact label="Ancilla" value={env?.version ?? "Unknown"} />
      {env?.platform === "win32" ? <Fact label="Muse runs" value={runtimeExplanation} /> : null}
      <Fact label="Sessions" value={env?.persistent ? "Kept on disk" : "In memory only"} />
      <Fact label="Muse" value={env?.musePath ?? (env?.museFound ? "Found" : "Not found")} />
    </Section>
  );
}

function NotificationsSection({
  notifications,
  controller,
}: {
  notifications: boolean;
  controller: AncillaController;
}) {
  const NOTIF_EXPLANATION = "A system notification when a thread asks for approval, asks a question, finishes, fails, or its goal stops moving. Only while this window is in the background.";
  return (
    <Section title="Notifications">
      <Row label="Tell me when a thread needs me" description={NOTIF_EXPLANATION}>
        <Toggle
          label="Notifications"
          checked={notifications}
          onChange={(enable) => (enable ? void controller.askToNotify() : controller.setPrefs({ notifications: false }))}
        />
      </Row>
    </Section>
  );
}

function SettingsHeader({
  dragProps,
  onGoBack,
}: {
  dragProps: Record<string, unknown>;
  onGoBack: () => void;
}) {
  return (
    <div data-drag-region {...dragProps} className="shrink-0">
      <header className="mx-auto flex w-full max-w-[720px] items-center gap-3 px-4 pt-8 pb-1 @min-[520px]:px-6">
        <Button size="sm" variant="ghost" onClick={onGoBack}><ArrowLeftIcon size={14} /> Back</Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-fg">Settings</h1>
          <p className="text-xs text-muted">Kept on this device. Most settings leave running threads alone; the sandbox and YOLO switches restart Muse hosts at once.</p>
        </div>
      </header>
    </div>
  );
}

/** Comprehensive configuration dashboard managing visual themes, AI routing, profiles, and runtime environments. */
export function SettingsPage() {
  const controller = useController();
  const prefs = useApp((s) => s.prefs);
  const models = useApp((s) => s.models);
  const accountModels = useApp((s) => s.accountModels);
  const modelsStatus = useApp((s) => s.modelsStatus);
  const accounts = useApp((s) => s.accounts);
  const providers = useApp((s) => s.providers);

  const [assistantProfile, setAssistantProfile] = useState<AssistantProfileView | null>(null);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettingsView | null>(null);

  useEffect(() => {
    if (typeof controller.loadAccounts === "function") {
      void controller.loadAccounts();
    }
    if (typeof controller.loadProviders === "function") {
      void controller.loadProviders();
    }
    let isMounted = true;
    if (typeof controller.assistant === "function") {
      controller.assistant<AssistantStatusView>("GET", "").then(
        (status) => {
          if (isMounted && status?.profile) {
            setAssistantProfile(status.profile);
          }
        },
        () => {},
      );
    }
    if (controller.hasVoice && typeof controller.voice === "function") {
      controller.voice<VoiceStatusView>("GET", "").then(
        (status) => {
          if (isMounted && status?.settings) {
            setVoiceSettings(status.settings);
          }
        },
        () => {},
      );
    }
    return () => {
      isMounted = false;
    };
  }, [controller]);

  const altProvidersList = useMemo(
    () =>
      (providers ?? []).filter(
        (p) =>
          p.id !== "muse" &&
          (p.id === "api" ? p.accounts.length > 0 : p.binary.available || p.accounts.length > 0),
      ),
    [providers],
  );

  const hasMultipleChatProviders = Boolean((accounts && accounts.length > 0) || altProvidersList.length > 0);
  const chatProviderOptions = useMemo(
    () => buildProviderAccountOptions(accounts, providers),
    [accounts, providers],
  );

  const [newThreadsScope, setNewThreadsScope] = useState<string>("muse::");
  const selectedChatScope = useMemo<ModelsScope>(() => {
    const sepIndex = newThreadsScope.indexOf("::");
    const provId = (sepIndex >= 0 ? newThreadsScope.slice(0, sepIndex) : "muse") as ProviderId;
    const acctId = sepIndex >= 0 ? newThreadsScope.slice(sepIndex + 2) || null : null;
    if (provId === "muse" && !acctId) return {};
    return { providerId: provId, accountId: acctId };
  }, [newThreadsScope]);

  const taskProviderOptions = useMemo(
    () => buildProviderAccountOptions(accounts, providers, { includeFollowProject: true }),
    [accounts, providers],
  );

  const currentTaskKey = useMemo(() => {
    const profileModel = assistantProfile?.model;
    if (!profileModel || profileModel.providerId === null) return "project";
    return `${profileModel.providerId}::${profileModel.accountId ?? ""}`;
  }, [assistantProfile?.model]);

  const [localTaskKey, setLocalTaskKey] = useState<string | null>(null);
  const taskKey = localTaskKey ?? currentTaskKey;

  const taskScope = useMemo<ModelsScope>(() => {
    if (taskKey === "project") return {};
    const sepIndex = taskKey.indexOf("::");
    const provId = (sepIndex >= 0 ? taskKey.slice(0, sepIndex) : "muse") as ProviderId;
    const acctId = sepIndex >= 0 ? taskKey.slice(sepIndex + 2) || null : null;
    return { providerId: provId, accountId: acctId };
  }, [taskKey]);

  const saveAssistantModel = async (model: {
    providerId: ProviderId | null;
    accountId: string | null;
    modelId: string | null;
  }) => {
    if (typeof controller.assistant !== "function") return;
    try {
      await controller.assistant("PATCH", "/profile", {
        model,
        expectedUpdatedAt: assistantProfile?.updatedAt,
      });
      setAssistantProfile((prev) => (prev ? { ...prev, model } : null));
      setLocalVoiceKey(null);
      forgetVoiceStatus();
      setVoiceSettings((prev) =>
        prev && (prev.brain.kind === "muse" || prev.brain.kind === "provider")
          ? { ...prev, brain: { kind: "assistant" } }
          : prev,
      );
      if (typeof controller.loadAssistantGlance === "function") {
        void controller.loadAssistantGlance();
      }
      if (typeof controller.assistantMoved === "function") {
        controller.assistantMoved();
      }
    } catch {
      // error handled
    }
  };

  const handleTaskProviderChange = async (key: string) => {
    setLocalTaskKey(key);
    if (key === "project") {
      await saveAssistantModel({ providerId: null, accountId: null, modelId: null });
    } else {
      const sep = key.indexOf("::");
      const providerId = (sep >= 0 ? key.slice(0, sep) : "muse") as ProviderId;
      const accountId = sep >= 0 ? key.slice(sep + 2) || null : null;
      await saveAssistantModel({ providerId, accountId, modelId: null });
    }
  };

  const voiceProviderOptions = useMemo(
    () =>
      buildProviderAccountOptions(accounts, providers, {
        includeFollowAssistant: true,
        includeCustom: true,
        includeNone: true,
      }),
    [accounts, providers],
  );

  const currentVoiceKey = useMemo(() => {
    const b = voiceSettings?.brain;
    if (!b) return "assistant";
    if (b.kind === "assistant") return "assistant";
    if (b.kind === "none") return "none";
    if (b.kind === "openai" || b.kind === "anthropic" || b.kind === "google") return "custom";
    if (b.kind === "muse") {
      if (b.model === null && !b.accountId && assistantProfile?.model?.providerId != null) {
        return "assistant";
      }
      return `muse::${b.accountId ?? ""}`;
    }
    if (b.kind === "provider") return `${b.providerId}::${b.accountId ?? ""}`;
    return "assistant";
  }, [voiceSettings?.brain, assistantProfile?.model?.providerId]);

  const [localVoiceKey, setLocalVoiceKey] = useState<string | null>(null);
  const voiceKey = localVoiceKey ?? currentVoiceKey;

  const voiceScope = useMemo<ModelsScope>(() => {
    if (voiceKey === "none" || voiceKey === "custom" || voiceKey === "assistant") return {};
    const sep = voiceKey.indexOf("::");
    const providerId = (sep >= 0 ? voiceKey.slice(0, sep) : "muse") as ProviderId;
    const accountId = sep >= 0 ? voiceKey.slice(sep + 2) || null : null;
    return { providerId, accountId };
  }, [voiceKey]);

  const voiceBrainModel = useMemo(() => {
    const b = voiceSettings?.brain;
    if (!b) return null;
    if (b.kind === "muse" || b.kind === "provider") return b.model;
    return null;
  }, [voiceSettings?.brain]);

  const saveVoiceModel = async (modelId: string | null) => {
    if (!controller.hasVoice || typeof controller.voice !== "function") return;
    const sep = voiceKey.indexOf("::");
    const providerId = (sep >= 0 ? voiceKey.slice(0, sep) : "muse") as ProviderId;
    const accountId = sep >= 0 ? voiceKey.slice(sep + 2) || null : null;
    let brain: VoiceBrainSetting;
    if (providerId === "muse") {
      brain = { kind: "muse", model: modelId, accountId };
    } else {
      brain = { kind: "provider", providerId, accountId, model: modelId };
    }
    try {
      await controller.voice("PATCH", "/settings", { brain });
      forgetVoiceStatus();
      setVoiceSettings((prev) => (prev ? { ...prev, brain } : null));
    } catch {
      // error handled
    }
  };

  const handleVoiceProviderChange = async (key: string) => {
    setLocalVoiceKey(key);
    if (!controller.hasVoice || typeof controller.voice !== "function") return;
    let nextBrain: VoiceBrainSetting;
    if (key === "assistant") {
      nextBrain = { kind: "assistant" };
    } else if (key === "none") {
      nextBrain = { kind: "none" };
    } else if (key === "custom") {
      nextBrain = {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        local: false,
        label: null,
        apiKeyEnv: null,
      };
    } else {
      const sep = key.indexOf("::");
      const providerId = (sep >= 0 ? key.slice(0, sep) : "muse") as ProviderId;
      const accountId = sep >= 0 ? key.slice(sep + 2) || null : null;
      if (providerId === "muse") {
        nextBrain = { kind: "muse", model: null, accountId };
      } else {
        nextBrain = { kind: "provider", providerId, accountId, model: null };
      }
    }
    try {
      await controller.voice("PATCH", "/settings", { brain: nextBrain });
      forgetVoiceStatus();
      setVoiceSettings((prev) => (prev ? { ...prev, brain: nextBrain } : null));
    } catch {
      // error handled
    }
  };

  const titleSettings = useApp((s) => s.titleSettings);
  const researchSettings = useApp((s) => s.researchSettings);
  const sandboxSettings = useApp((s) => s.sandboxSettings);
  const env = useApp((s) => s.env);
  const remoteDeployment = useApp((s) => s.remoteDeployment);
  const sourceOfferUrl = useApp((s) => s.sourceOfferUrl);
  const updates = useApp((s) => s.updates);
  const bypassAll = useApp((s) => s.bypassAll);
  const armedThreads = useApp((s) => s.bypassThreads.length);
  const yoloSettings = useApp((s) => s.yoloSettings);

  const now = useNow(60_000);
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<AccountView | null>(null);
  const [renaming, setRenaming] = useState<AccountView | null>(null);
  const [confirmYolo, setConfirmYolo] = useState(false);
  const [confirmSandbox, setConfirmSandbox] = useState(false);
  const [confirmBypass, setConfirmBypass] = useState(false);

  const startModel = activeModel({ models, accountModels, modelsStatus }, {}, null, prefs.defaultModelId);
  const effort = effortView(startModel, prefs.effort, LEVELS);
  const effortHint = effortNote(prefs.effort, effort.shown, startModel ? modelDisplayName(startModel.modelId) : undefined);
  const isUpdatingBusy = updates?.status === "checking" || updates?.status === "downloading" || updates?.status === "installing";
  const dragProps = useOverlayDragProps();
  const collapsed = useApp((s) => s.prefs.sidebarCollapsed);

  return (
    <div className="@container flex h-full min-w-0 flex-col">
      {collapsed ? <TopBar /> : null}
      <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
        <SettingsHeader dragProps={dragProps} onGoBack={() => controller.goBack()} />

        <div className="mx-auto w-full min-w-0 max-w-[720px] px-4 pb-16 @min-[520px]:px-6">
          {env?.platform === "linux" ? (
            <div className="mt-6">
              <LinuxSetupCard />
            </div>
          ) : null}

          <AppearanceSection prefs={prefs} controller={controller} />

          <NewThreadsSection
            hasMultipleChatProviders={hasMultipleChatProviders}
            chatProviderOptions={chatProviderOptions}
            newThreadsScope={newThreadsScope}
            setNewThreadsScope={setNewThreadsScope}
            selectedChatScope={selectedChatScope}
            prefs={prefs}
            controller={controller}
            yoloSettings={yoloSettings}
            effort={effort}
            effortHint={effortHint}
          />

          <AssistantSection
            taskKey={taskKey}
            taskProviderOptions={taskProviderOptions}
            onTaskProviderChange={handleTaskProviderChange}
            taskScope={taskScope}
            assistantProfile={assistantProfile}
            onSaveAssistantModel={saveAssistantModel}
            hasVoice={controller.hasVoice}
            voiceKey={voiceKey}
            voiceProviderOptions={voiceProviderOptions}
            onVoiceProviderChange={handleVoiceProviderChange}
            voiceScope={voiceScope}
            voiceBrainModel={voiceBrainModel}
            onSaveVoiceModel={saveVoiceModel}
          />

          <AccountsSection
            accounts={accounts}
            onAddAccount={() => setAddOpen(true)}
            onRenameAccount={(acct) => setRenaming(acct)}
            onRemoveAccount={(acct) => setRemoving(acct)}
            controller={controller}
          />

          <ProvidersSettings />

          <Section title="Threads list">
            <Row label="Group by" description="How the sidebar arranges threads.">
              <Pick value={prefs.groupBy} options={GROUP_OPTIONS} onChange={(val) => controller.setGroupBy(val)} />
            </Row>
          </Section>

          <ThreadTitlesSection titleSettings={titleSettings} controller={controller} />

          <Section title="Deep research">
            <Row
              label="Deep research"
              description="A research trigger in the composer and /research: parallel Muse workers search the web and read what they find, and a writer turns their notes into a report whose citations name pages a worker opened or found in its search results. Ancilla checks where a source came from, not that it supports a claim. Every model call and search runs through Muse on your plan."
            >
              {researchSettings ? (
                <Toggle
                  label="Deep research"
                  checked={researchSettings.enabled}
                  onChange={(active) => void controller.setResearchSettings({ enabled: active })}
                />
              ) : (
                <span className="text-xs text-subtle">Loading…</span>
              )}
            </Row>
            {researchSettings?.enabled ? <ResearchRows config={researchSettings.config} controller={controller} /> : null}
          </Section>

          <ApprovalsSection
            bypassAll={bypassAll}
            armedThreads={armedThreads}
            onRequestBypass={() => setConfirmBypass(true)}
            onDisableBypass={() => controller.setBypassAll(false)}
            onClearThreadBypass={() => controller.clearThreadBypass()}
          />

          <YoloSection
            yoloSettings={yoloSettings}
            onRequestYolo={() => setConfirmYolo(true)}
            onDisableYolo={() => void controller.setYoloEnabled(false)}
          />

          <SandboxSection
            sandboxSettings={sandboxSettings}
            isYoloEnabled={yoloSettings?.enabled === true}
            onRequestDisableSandbox={() => setConfirmSandbox(true)}
            onEnableSandbox={() => void controller.setSandboxDisabled(false)}
          />

          <NotificationsSection notifications={prefs.notifications} controller={controller} />

          {updates ? (
            <UpdatesSection
              updates={updates}
              autoUpdate={prefs.autoUpdate}
              updatesPaused={prefs.updatesPaused}
              controller={controller}
              now={now}
              isUpdatingBusy={isUpdatingBusy}
            />
          ) : null}

          <EnvironmentSection env={env} onOpenWhatsNew={() => controller.setWhatsNewOpen(true)} />

          <Section title="About">
            <About version={env?.version ?? null} remoteDeployment={remoteDeployment} sourceOfferUrl={sourceOfferUrl} />
          </Section>
        </div>
      </div>

      <ConfirmBypassModal
        open={confirmBypass}
        onOpenChange={setConfirmBypass}
        onConfirm={() => controller.setBypassAll(true)}
      />

      <ConfirmYoloModal
        open={confirmYolo}
        onOpenChange={setConfirmYolo}
        onConfirm={() => void controller.setYoloEnabled(true)}
      />

      <ConfirmSandboxModal
        open={confirmSandbox}
        onOpenChange={setConfirmSandbox}
        onConfirm={() => void controller.setSandboxDisabled(true)}
      />

      <AddAccountModal open={addOpen} onOpenChange={setAddOpen} controller={controller} />
      <RenameAccountModal account={renaming} onOpenChange={(open) => !open && setRenaming(null)} controller={controller} />
      <RemoveAccountModal account={removing} onOpenChange={(open) => !open && setRemoving(null)} controller={controller} />
    </div>
  );
}
