import { ArrowClockwiseIcon, ArrowUpIcon, ArrowsClockwiseIcon, ArrowsInIcon, BinocularsIcon, BrainIcon, CaretDownIcon, CpuIcon, FolderIcon, GitBranchIcon, LightningIcon, LockIcon, PencilSimpleLineIcon, QuestionIcon, ShieldChevronIcon, ShieldIcon, ShieldWarningIcon, SignInIcon, SquareIcon, TerminalWindowIcon, UserIcon } from "../ui/icons.js";
import { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { AttachButton, AttachmentTray, readFiles, restoreFiles, toOutgoing, toPreview, type PendingFile } from "./attachments.js";
import { CostMeter } from "./CostPanel.js";
import { Popover, Slider, Switch } from "radix-ui";
import { shallowEqual, useApp, useController } from "../../app/context.js";
import { useSampled } from "../../app/sampled.js";
import { loadDraft, saveDraft } from "../../model/controller.js";
import { basename, formatDuration, formatSpeed, formatTokens } from "../../model/format.js";
import { MODEL_COPY, activeModel, anyWorkRunning, applyModelChoice, choiceDetail, choiceValue, effortLabel, effortNote, effortView, modelButtonLabel, modelCompletions, modelIdError, modelMenu, modelsKey, modelsStanding, providerBadgeName, restartAction, selectedValue, tryTypedModel, type ModelChoice, type ModelCompletion, type ModelMenu, type ModelsScope, type ModelsState } from "../../model/models.js";
import { planAccount } from "../../model/plan.js";
import { publishedModelIds } from "../../model/pricing.js";
import { matchSlash, parseSlash, resolveSlash, slashCommands, type SlashCommand } from "../../model/slash.js";
import { RESEARCH_LIMITS, WINDOW_STEP, clampResearchNumber, popoverOverrides, researchLive, type ResearchRange, type ResearchTyped } from "../../model/research.js";
import { projectForCwd } from "../../model/status.js";
import { defaultModelForScope, type SkillsState } from "../../model/store.js";
import { lastTurnSpeed, streamingSpeed } from "../../model/usage.js";
import type { ApprovalMode, ModelOption, ProviderAccountView, ProviderCapabilities, ProviderId, ReasoningEffort } from "../../types.js";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuOption, MenuRadioGroup, MenuSeparator, MenuTrigger, Modal, Tip, FLOATING } from "../ui/overlays.js";
import { Button, IconButton, MOD, Spinner, Toggle, cn } from "../ui/primitives.js";
import { PixelFlow } from "../ui/PixelFlow.js";
import { ContextMeter } from "./ContextPanel.js";
import { SlashMenu, slashOptionId, type SlashMenuState } from "./SlashMenu.js";
import { SwapIcon } from "../ui/sourced.js";

/** Persistent composer draft that syncs with disk storage across view switches. */
function useDraft(storageKey: string): [string, (nextVal: string) => void] {
  const [draftValue, setDraftValue] = useState<string>(() => loadDraft(storageKey));
  const activeKeyRef = useRef(storageKey);

  if (activeKeyRef.current !== storageKey) {
    activeKeyRef.current = storageKey;
    const restoredText = loadDraft(storageKey);
    setDraftValue(restoredText);
  }

  const updateDraft = useCallback((nextText: string) => {
    setDraftValue(nextText);
    saveDraft(storageKey, nextText);
  }, [storageKey]);

  return [draftValue, updateDraft];
}

/** Slash menu state payload paired with its input prefix string. */
type SlashMenuView = SlashMenuState & { prefix: string };

/**
 * Computes the slash menu representation given current prompt text, cursor location, and available catalogs.
 */
export function slashMenuFor(
  text: string,
  caret: number,
  commands: SlashCommand[],
  skills: SkillsState | undefined,
  models: readonly ModelOption[] = [],
  limited = false,
): SlashMenuView | null {
  const matchFirst = /^\/(\S*)/.exec(text);
  if (!matchFirst) return null;

  const isCatalogPending = !skills || skills.status === "loading";
  const catalogErr = skills?.status === "error" ? skills.error : null;
  const leadToken = matchFirst[0];

  if (caret >= 1 && caret <= leadToken.length) {
    const rawFilter = (matchFirst[1] ?? "").trim();
    const candidateCommands = matchSlash(commands, rawFilter);
    if (!rawFilter || candidateCommands.length > 0) {
      return { kind: "list", items: candidateCommands, loading: isCatalogPending, error: catalogErr, prefix: "/" };
    }
    return isCatalogPending
      ? { kind: "loading", prefix: "/" }
      : { kind: "unknown", name: rawFilter.toLowerCase(), prefix: "/" };
  }

  const skillInvoke = /^\/skill\s+(\S*)$/i.exec(text);
  if (skillInvoke && caret === text.length) {
    const query = skillInvoke[1] ?? "";
    const skillSubset = commands.filter((cmd) => cmd.kind === "skill");
    const matched = matchSlash(skillSubset, query);
    if (matched.length > 0) {
      return { kind: "list", items: matched, loading: isCatalogPending, error: catalogErr, prefix: "/skill " };
    }
  }

  const modelInvoke = /^\/models?\s+([^\n]*)$/i.exec(text);
  if (modelInvoke && caret === text.length) {
    const rawQuery = (modelInvoke[1] ?? "").trim();
    const completions = modelCompletions(models, rawQuery, undefined, limited);
    if (completions.length > 0) {
      return { kind: "models", items: completions, query: rawQuery, prefix: "/model " };
    }
  }

  const parsed = parseSlash(text);
  if (!parsed) return null;

  const resolved = resolveSlash(parsed, commands, skills?.skills ?? []);
  if (resolved.kind !== "unknown") return null;

  return isCatalogPending
    ? { kind: "loading", prefix: "/" }
    : { kind: "unknown", name: parsed.name, prefix: "/" };
}

/**
 * Evaluates the slash menu view taking into account provider model standing and scope.
 */
export function slashMenuOver(
  text: string,
  caret: number,
  commands: SlashCommand[],
  skills: SkillsState | undefined,
  source: Pick<ModelsState, "models" | "accountModels" | "modelsStatus">,
  scope: ModelsScope,
): SlashMenuView | null {
  const currentStanding = modelsStanding(source, scope);
  const isMuseProvider = !scope.providerId || scope.providerId === "muse";
  return slashMenuFor(text, caret, commands, skills, currentStanding.models, isMuseProvider && currentStanding.limited);
}

/** Maximum file attachments per turn. */
const MAX_FILES = 10;

/** Resolves active model scope and account identifiers for a session or workspace directory. */
function useModelsScope(sessionId: string | null, cwd: string | null): {
  scope: ModelsScope;
  accountId: string | null;
  providerId: ProviderId;
} {
  const accountId = useApp((st) => {
    if (sessionId) return st.sessions[sessionId]?.accountId ?? null;
    return projectForCwd(st.projects, cwd)?.defaultAccountId ?? null;
  });

  const providerId = useApp((st) => {
    const rawId = sessionId ? st.sessions[sessionId]?.providerId : projectForCwd(st.projects, cwd)?.defaultProviderId;
    return rawId ?? "muse";
  });

  const scope = useMemo<ModelsScope>(() => {
    if (sessionId) {
      return providerId !== "muse" ? { sessionId, providerId } : { sessionId };
    }
    return providerId !== "muse" ? { providerId, accountId } : { accountId };
  }, [sessionId, accountId, providerId]);

  return { scope, accountId, providerId };
}

/** Retrieves provider capabilities for the current active context. */
function useActiveCapabilities(sessionId: string | null, cwd: string | null): ProviderCapabilities | null {
  return useApp((st) => {
    if (sessionId) {
      const sess = st.sessions[sessionId];
      if (sess?.capabilities) return sess.capabilities;
      const pid = sess?.providerId;
      if (pid && pid !== "muse") {
        return st.providers?.find((p) => p.id === pid)?.capabilities ?? null;
      }
      return null;
    }
    const pid = projectForCwd(st.projects, cwd)?.defaultProviderId;
    if (pid && pid !== "muse") {
      return st.providers?.find((p) => p.id === pid)?.capabilities ?? null;
    }
    return null;
  });
}

/** Model catalog source aggregate cached across renders. */
function useModelSource() {
  const models = useApp((st) => st.models);
  const accountModels = useApp((st) => st.accountModels);
  const modelsStatus = useApp((st) => st.modelsStatus);
  const accounts = useApp((st) => st.accounts);
  const defaultLogin = useApp((st) => st.defaultLogin);
  const planUsageAccounts = useApp((st) => st.planUsageAccounts);
  const providers = useApp((st) => st.providers);

  return useMemo(
    () => ({ models, accountModels, modelsStatus, accounts, defaultLogin, planUsageAccounts, providers }),
    [models, accountModels, modelsStatus, accounts, defaultLogin, planUsageAccounts, providers],
  );
}

/** Determines active model ID for an open thread. */
function useThreadModel(sessionId: string | null): string | null {
  return useApp((st) => {
    if (!sessionId) return null;
    return st.threads[sessionId]?.fold.meta.modelId ?? st.sessions[sessionId]?.modelId ?? null;
  });
}

export interface ComposerProps { sessionId: string | null; cwd: string | null; running: boolean; readOnly: boolean; variant: "thread" | "home"; autoFocus?: boolean; }

/** Helper for rendering shell indicator notice. */
function ShellExecutionNotice({ targetCwd }: { targetCwd: string | null }) {
  const folderLabel = targetCwd ? ` in ${basename(targetCwd)}` : "";
  return ( <div className="flex items-center gap-1.5 px-4 pt-2.5 text-xs text-muted">
      <TerminalWindowIcon size={13} className="shrink-0" />
      <span className="truncate">
        Ancilla runs this{folderLabel}; the output stays here until you send it to Muse
      </span>
    </div>
  );
}

function HaltTurnButton({ isHalting, onHalt }: { isHalting: boolean; onHalt: () => void }) {
  return ( <Tip label="Stop the turn" shortcut={["Esc"]}>
      <IconButton size="md" label="Stop the turn" disabled={isHalting} onClick={onHalt}>
        <SquareIcon weight="fill" size={11} />
      </IconButton>
    </Tip>
  );
}

function ComposerToolbarMeters({
  sessionId,
  isRunning,
  hasInput,
  isHalting,
  onHalt,
}: {
  sessionId: string | null;
  isRunning: boolean;
  hasInput: boolean;
  isHalting: boolean;
  onHalt: () => void;
}) {
  const showHaltButton = isRunning && Boolean(sessionId) && hasInput;
  return ( <>
      <span className="min-w-2 flex-1" />
      {sessionId ? <SpeedReadout sessionId={sessionId} /> : null}
      {sessionId ? <CostMeter sessionId={sessionId} /> : null}
      {sessionId ? <ContextMeter sessionId={sessionId} /> : null}
      {showHaltButton ? <HaltTurnButton isHalting={isHalting} onHalt={onHalt} /> : null}</>
  );
}

/** Helper rendering the primary composer action button with dynamic icons. */
function ComposerActionTrigger({
  isExecuting,
  isStopping,
  canStopTurn,
  isResearchActive,
  isShellCommand,
  hasPendingInput,
  isDisabled,
  onStop,
  onSubmit,
}: {
  isExecuting: boolean;
  isStopping: boolean;
  canStopTurn: boolean;
  isResearchActive: boolean;
  isShellCommand: boolean;
  hasPendingInput: boolean;
  isDisabled: boolean;
  onStop: () => void;
  onSubmit: () => void;
}) {
  const actionLabel = canStopTurn
    ? "Stop the turn"
    : isResearchActive
      ? "Start the research"
      : isShellCommand
        ? "Run command"
        : hasPendingInput
          ? "Queue message"
          : "Send message";

  const tipShortcut = canStopTurn ? "Esc" : "Enter";
  const iconState = isExecuting || isStopping ? "busy" : canStopTurn ? "stop" : isResearchActive ? "research" : "send";

  return ( <Tip label={canStopTurn ? "Stop the turn" : isResearchActive ? "Start the research" : isShellCommand ? "Run command" : hasPendingInput ? "Queue message" : "Send"} shortcut={[tipShortcut]}>
      <button
        type="button"
        aria-label={actionLabel}
        disabled={isDisabled}
        onClick={() => {
          if (canStopTurn) onStop();
          else onSubmit();
        }}
        className={cn(
          "ml-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-[transform,background-color,color] duration-150 active:scale-95",
          canStopTurn ? "bg-inverse text-inverse-fg" : "bg-brand text-brand-fg hover:bg-brand-hover disabled:bg-active disabled:text-subtle",
        )}>
        <SwapIcon value={iconState}>
          {isExecuting || isStopping ? <Spinner size={13} /> : canStopTurn ? <SquareIcon weight="fill" size={11} /> : isResearchActive ? <BinocularsIcon size={15} /> : <ArrowUpIcon size={16} />}
        </SwapIcon></button>
    </Tip>
  );
}

export function Composer(props: ComposerProps) {
  const controller = useController();
  const sessionDraftKey = props.sessionId ?? `new:${props.cwd ?? ""}`;
  const [composerText, setComposerText] = useDraft(sessionDraftKey);

  const pendingHandoff = useApp((st) => (st.draftHandoff?.key === sessionDraftKey ? st.draftHandoff : null));
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const dedupeTracker = useRef<{ payloadText: string; payloadFiles: PendingFile[] | null } | null>(null);

  const [stagedFiles, setStagedFiles] = useState<PendingFile[]>([]);
  const [cursorOffset, setCursorOffset] = useState<number>(0);
  const [highlightedRow, setHighlightedRow] = useState<number>(0);
  const [dismissedWord, setDismissedWord] = useState<string | null>(null);

  const elementId = useId();
  const dropdownMenuId = useId();

  const isStarting = useApp((st) => Boolean(st.busy["start"]));
  const isStoppingCurrent = useApp((st) => (props.sessionId ? Boolean(st.busy[`stop:${props.sessionId}`]) : false));

  const textNonEmpty = composerText.trim().length > 0;
  const showHaltButton = props.running && Boolean(props.sessionId) && !textNonEmpty;
  const isCommandPrefix = !props.readOnly && /^!\s*\S/.test(composerText);
  const isResearchEnabled = useApp((st) => st.researchMode);
  const isResearchTurn = isResearchEnabled && !props.readOnly && !isCommandPrefix && !composerText.startsWith("/");

  useEffect(() => {
    if (pendingHandoff) {
      const recovered = controller.takeDraftHandoff(sessionDraftKey);
      if (recovered) {
        setComposerText(recovered.text);
        if (recovered.attachments?.length) {
          setStagedFiles(restoreFiles(recovered.attachments, recovered.previews ?? []));
        }
      }
    }
  }, [pendingHandoff, sessionDraftKey, controller, setComposerText]);

  const verifyFreshSubmission = (payloadText: string, payloadFiles: PendingFile[] | null): boolean => {
    const prior = dedupeTracker.current;
    if (prior && prior.payloadText === payloadText && prior.payloadFiles === payloadFiles) {
      return false;
    }
    dedupeTracker.current = { payloadText, payloadFiles };
    return true;
  };

  const handleIncomingFiles = (incoming: Iterable<File>) => {
    if (props.readOnly) return;
    void readFiles(incoming).then((processed) => {
      setStagedFiles((prev) => [...prev, ...processed].slice(0, MAX_FILES));
    });
  };

  const handleFileRemoval = (targetId: string) => {
    setStagedFiles((prev) => {
      const target = prev.find((f) => f.id === targetId);
      if (target?.url) URL.revokeObjectURL(target.url);
      return prev.filter((f) => f.id !== targetId);
    });
  };

  const projectSkills = useApp((st) => (props.cwd ? st.skills[props.cwd] : undefined));
  const isSlashActive = !props.readOnly && composerText.startsWith("/");

  useEffect(() => {
    if (isSlashActive && props.cwd) {
      void controller.loadSkills(props.cwd);
    }
  }, [isSlashActive, props.cwd, controller]);

  const slashCatalog = useMemo(
    () => slashCommands(projectSkills?.skills ?? [], { inThread: Boolean(props.sessionId) }),
    [projectSkills?.skills, props.sessionId],
  );

  const { scope: activeScope } = useModelsScope(props.sessionId, props.cwd);
  const catalogSource = useModelSource();
  const isModelSlash = isSlashActive && /^\/models?\s/i.test(composerText);

  useEffect(() => {
    if (isModelSlash) {
      void controller.refreshModels(activeScope);
    }
  }, [isModelSlash, activeScope, controller]);

  const matchedCommandWord = /^\/\S*/.exec(composerText)?.[0] ?? null;

  const computeActiveMenu = (pos: number): SlashMenuView | null => {
    const computed = isSlashActive ? slashMenuOver(composerText, pos, slashCatalog, projectSkills, catalogSource, activeScope) : null;
    return computed && dismissedWord !== matchedCommandWord ? computed : null;
  };

  const activeMenu = computeActiveMenu(cursorOffset);
  const menuRowTotal = activeMenu?.kind === "list" || activeMenu?.kind === "models" ? activeMenu.items.length : activeMenu ? 1 : 0;
  const boundedActiveRow = Math.max(0, Math.min(highlightedRow, menuRowTotal - 1));
  const activeModelFilter = activeMenu?.kind === "models" ? activeMenu.query : null;

  useEffect(() => {
    setHighlightedRow(0);
  }, [matchedCommandWord, activeMenu?.kind, activeMenu?.prefix, activeModelFilter]);

  useLayoutEffect(() => {
    const targetElement = textAreaRef.current;
    if (!targetElement) return;
    targetElement.style.height = "auto";
    const maxHeight = Math.round(window.innerHeight * 0.4);
    targetElement.style.height = `${Math.min(targetElement.scrollHeight, maxHeight)}px`;
    setCursorOffset(targetElement.selectionStart);
  }, [composerText]);

  useEffect(() => {
    const el = textAreaRef.current;
    if (props.autoFocus && !props.readOnly && el) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
      setCursorOffset(el.value.length);
    }
  }, [props.autoFocus, props.readOnly, props.sessionId, props.cwd]);

  const handleSendDispatch = async (isSteering: boolean) => {
    if ((!textNonEmpty && stagedFiles.length === 0) || props.readOnly || isStarting) return;
    const outgoingText = composerText;
    const outgoingAttachments = stagedFiles;

    if (!verifyFreshSubmission(outgoingText, outgoingAttachments)) return;

    if (isResearchTurn) {
      setComposerText("");
      const storeSnap = controller.store.get();
      const overrides = popoverOverrides(storeSnap.researchTyped, storeSnap.researchSettings?.config ?? null);
      const initiated = await controller.research(outgoingText, overrides, props.sessionId);
      if (!initiated) {
        dedupeTracker.current = null;
        setComposerText(outgoingText);
      }
      return;
    }

    setComposerText("");
    setStagedFiles([]);
    const dispatched = await controller.send(outgoingText, {
      steer: isSteering,
      attachments: outgoingAttachments.map(toOutgoing),
      previews: outgoingAttachments.map(toPreview),
    });

    if (!dispatched) {
      dedupeTracker.current = null;
      setComposerText(outgoingText);
      setStagedFiles(outgoingAttachments);
    }
  };

  const executeImmediateCommand = async (commandString: string, isRawMode: boolean) => {
    if (props.readOnly || isStarting) return;
    if (!verifyFreshSubmission(commandString, null)) return;
    setComposerText("");
    const result = await controller.send(commandString, { raw: isRawMode });
    if (!result) {
      dedupeTracker.current = null;
      setComposerText(commandString);
    }
  };

  const populateInput = (nextContent: string) => {
    setComposerText(nextContent);
    setCursorOffset(nextContent.length);
    requestAnimationFrame(() => {
      const el = textAreaRef.current;
      el?.focus();
      el?.setSelectionRange(nextContent.length, nextContent.length);
    });
  };

  const appendSlashPrefix = (prefixStr: string, cmd: SlashCommand) => {
    populateInput(`${prefixStr}${cmd.name} `);
  };

  const handleSlashSelection = (menuView: SlashMenuView, cmd: SlashCommand) => {
    if (menuView.prefix === "/" && cmd.kind === "action" && cmd.runsBare) {
      void executeImmediateCommand(`/${cmd.name}`, false);
    } else {
      appendSlashPrefix(menuView.prefix, cmd);
    }
  };

  const handleModelSelection = (chosen: ModelCompletion) => {
    void executeImmediateCommand(`/model ${chosen.id}`, false);
  };

  const handleKeyEvents = (evt: KeyboardEvent<HTMLTextAreaElement>) => {
    if (evt.nativeEvent.isComposing) return;
    const currentMenu = computeActiveMenu(evt.currentTarget.selectionStart);

    if (currentMenu) {
      const rows = currentMenu.kind === "list" || currentMenu.kind === "models" ? currentMenu.items : [];
      const safeIndex = Math.max(0, Math.min(highlightedRow, rows.length - 1));

      if ((evt.key === "ArrowDown" || evt.key === "ArrowUp") && rows.length > 0) {
        evt.preventDefault();
        const delta = evt.key === "ArrowDown" ? 1 : -1;
        setHighlightedRow((safeIndex + delta + rows.length) % rows.length);
        return;
      }

      if (evt.key === "Escape") {
        evt.preventDefault();
        setDismissedWord(matchedCommandWord);
        return;
      }

      if (evt.key === "Tab" && !evt.shiftKey && rows[safeIndex]) {
        evt.preventDefault();
        if (currentMenu.kind === "models") {
          populateInput(`${currentMenu.prefix}${(currentMenu.items[safeIndex] as ModelCompletion).id}`);
        } else {
          appendSlashPrefix(currentMenu.prefix, rows[safeIndex] as SlashCommand);
        }
        return;
      }

      if (evt.key === "Enter" && !evt.shiftKey) {
        evt.preventDefault();
        if (evt.repeat) return;
        if (currentMenu.kind === "models" && rows[safeIndex]) {
          handleModelSelection(rows[safeIndex] as ModelCompletion);
        } else if (currentMenu.kind === "list" && rows[safeIndex]) {
          handleSlashSelection(currentMenu, rows[safeIndex] as SlashCommand);
        } else if (currentMenu.kind === "unknown") {
          void executeImmediateCommand(composerText, true);
        } else {
          void handleSendDispatch(props.running && (evt.metaKey || evt.ctrlKey));
        }
        return;
      }
    }

    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      if (evt.repeat) return;
      void handleSendDispatch(props.running && (evt.metaKey || evt.ctrlKey));
    } else if (evt.key === "Escape" && props.running && !textNonEmpty && props.sessionId) {
      evt.preventDefault();
      void controller.stop(props.sessionId);
    }
  };

  const computedPlaceholder = (() => {
    if (props.readOnly) return "Read-only while another Muse session has this thread open";
    if (isResearchEnabled) return "What should the workers find out? Enter starts the research";
    if (props.running) return `Queue a follow-up, or press ${MOD}+Enter to add it to this turn`;
    if (props.variant === "home") return "Describe a change, a fix, or a question about the code. Use @path to point at files.";
    return "Reply, or ask for the next change";
  })();

  const actionButtonDisabled = showHaltButton
    ? isStoppingCurrent
    : (!textNonEmpty && stagedFiles.length === 0) || props.readOnly || isStarting;

  return ( <div
      className={cn(
        "composer-surface relative min-w-0 max-w-full bg-raised transition-shadow duration-150 ease-out",
        props.readOnly && "opacity-75",
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          textAreaRef.current?.focus();
        }
      }}
      onPaste={(e) => {
        if (e.clipboardData?.files?.length) {
          e.preventDefault();
          handleIncomingFiles(Array.from(e.clipboardData.files));
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer?.files?.length) {
          e.preventDefault();
          handleIncomingFiles(Array.from(e.dataTransfer.files));
        }
      }}>
      {activeMenu ? (
        <SlashMenu
          id={dropdownMenuId}
          state={activeMenu}
          placement={props.variant === "home" ? "below" : "above"}
          active={boundedActiveRow}
          onActive={setHighlightedRow}
          onPick={(cmd) => handleSlashSelection(activeMenu, cmd)}
          onPickModel={handleModelSelection}
          onSendRaw={() => void executeImmediateCommand(composerText, true)} />
      ) : null}

      <label htmlFor={elementId} className="sr-only">
        Message Muse
      </label>

      {isCommandPrefix ? <ShellExecutionNotice targetCwd={props.cwd} /> : null}

      <AttachmentTray files={stagedFiles} onRemove={handleFileRemoval} />

      <textarea
        id={elementId}
        ref={textAreaRef}
        value={composerText}
        rows={props.variant === "home" ? 3 : 1}
        disabled={props.readOnly}
        placeholder={computedPlaceholder}
        spellCheck
        role={activeMenu ? "combobox" : undefined}
        aria-expanded={activeMenu ? true : undefined}
        aria-controls={activeMenu ? dropdownMenuId : undefined}
        aria-autocomplete={activeMenu ? "list" : undefined}
        aria-activedescendant={activeMenu ? slashOptionId(dropdownMenuId, boundedActiveRow) : undefined}
        onChange={(e) => {
          setComposerText(e.currentTarget.value);
          setCursorOffset(e.currentTarget.selectionStart);
          if (!e.currentTarget.value.startsWith("/")) {
            setDismissedWord(null);
          }
        }}
        onSelect={(e) => setCursorOffset(e.currentTarget.selectionStart)}
        onKeyDown={handleKeyEvents}
        className={cn(
          "max-h-[40vh] min-h-[44px] w-full resize-none bg-transparent px-4 py-3 text-sm text-fg outline-none placeholder:text-subtle",
          props.variant === "home" && "min-h-[76px]",
        )} />

      <div className="flex items-center gap-1.5 px-3 pb-2.5">
        <AttachButton disabled={props.readOnly || stagedFiles.length >= MAX_FILES} onFiles={handleIncomingFiles} />
        <ResearchTrigger sessionId={props.sessionId} side={props.variant === "home" ? "bottom" : "top"} disabled={props.readOnly} />
        <ModelPicker sessionId={props.sessionId} cwd={props.cwd} side={props.variant === "home" ? "bottom" : "top"} />
        <EffortPicker sessionId={props.sessionId} cwd={props.cwd} side={props.variant === "home" ? "bottom" : "top"} />
        <AccessPicker sessionId={props.sessionId} cwd={props.cwd} side={props.variant === "home" ? "bottom" : "top"} />
        <AccountPicker sessionId={props.sessionId} cwd={props.cwd} variant={props.variant} />
        <ComposerToolbarMeters
          sessionId={props.sessionId}
          isRunning={props.running}
          hasInput={textNonEmpty}
          isHalting={isStoppingCurrent}
          onHalt={() => void controller.stop(props.sessionId as string)} />

        <ComposerActionTrigger
          isExecuting={isStarting}
          isStopping={isStoppingCurrent}
          canStopTurn={showHaltButton}
          isResearchActive={isResearchTurn}
          isShellCommand={isCommandPrefix}
          hasPendingInput={props.running}
          isDisabled={actionButtonDisabled}
          onStop={() => void controller.stop(props.sessionId as string)}
          onSubmit={() => void handleSendDispatch(false)} />
      </div></div>
  );
}

type ToolbarTriggerProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon: ReactNode; label: ReactNode; tone?: "warn" };

export const ToolbarTrigger = forwardRef<HTMLButtonElement, ToolbarTriggerProps>(function ToolbarTrigger({ icon, label, tone, className, ...rest }, ref) {
  const triggerToneClass = tone === "warn" ? "text-warn-text hover:text-warn-text" : undefined;
  return ( <button ref={ref} type="button" {...rest} className={cn("inline-flex h-7 max-w-[240px] min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted transition-colors duration-100 hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg", triggerToneClass, className)}>
      <span className="shrink-0">{icon}</span>
      <span className="flex min-w-0 items-center truncate">{label}</span>
      <CaretDownIcon size={12} className="shrink-0 opacity-60" />
    </button>);
});

/** Contributor model badge indicating public training data contribution. */
function ContributorBadge(props: { tip?: boolean }) {
  const badgeElement = <span className="shrink-0 rounded-[5px] bg-warn-soft px-1 py-px text-2xs font-medium text-warn-text">Contributor</span>;
  return props.tip ? <Tip label="Your chats may be used to improve Meta's products">{badgeElement}</Tip> : badgeElement;
}

/** Side placement for floating popovers. */
type PickerSide = "top" | "bottom";

/** Badge marking default selection. */
function DefaultBadge() {
  return <span className="shrink-0 rounded-[5px] bg-active px-1 py-px text-2xs font-medium text-muted">Default</span>;
}

/** Single row item inside model selection dropdown. */
function ModelRow(props: { choice: ModelChoice }) {
  const { choice } = props;
  const statusNote = choice.note ? (
    <span className="shrink-0 rounded-[5px] bg-warn-soft px-1 py-px text-2xs font-medium text-warn-text">
      {choice.note === "unavailable" ? "Unavailable" : "Not offered"}
    </span>
  ) : null;

  return ( <MenuOption
      value={choiceValue(choice)}
      label={<>
          {choice.label}
          {choice.displayLabel ? <span className="ml-2 font-normal text-muted">{choice.displayLabel}</span> : null}</>
      }
      badge={<>
          {choice.isDefault ? <DefaultBadge /> : null}
          {choice.kind !== "default" && choice.contributor ? <ContributorBadge /> : null}
          {statusNote}</>
      }
      description={choiceDetail(choice) ?? undefined} />
  );
}

/** Modal form for providing arbitrary model identifiers. */
export function ModelIdForm(props: {
  onUse: (modelId: string) => Promise<boolean>;
  onDone?: () => void;
  onCancel?: () => void;
  label?: string;
}) {
  const [candidateText, setCandidateText] = useState("");
  const [submissionActive, setSubmissionActive] = useState(false);
  const inputElemId = useId();
  const sanitized = candidateText.trim();
  const formatError = sanitized ? modelIdError(sanitized) : null;

  const performSubmit = async () => {
    if (submissionActive || !sanitized || formatError) return;
    setSubmissionActive(true);
    try {
      const accepted = await props.onUse(sanitized);
      if (accepted) {
        setCandidateText("");
        props.onDone?.();
      }
    } finally {
      setSubmissionActive(false);
    }
  };

  return ( <form
      className="flex min-w-0 flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void performSubmit();
      }}>
      <label htmlFor={inputElemId} className="text-xs font-medium text-muted">
        {props.label ?? "Model id"}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={inputElemId}
          type="text"
          value={candidateText}
          onChange={(e) => setCandidateText(e.currentTarget.value)}
          placeholder={publishedModelIds()[0] ?? "model-id"}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={formatError !== null}
          className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-sunken px-3 font-mono text-xs text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus" />
        {props.onCancel ? (
          <Button size="sm" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button size="sm" variant="primary" type="submit" disabled={!sanitized || formatError !== null} loading={submissionActive}>
          Use model
        </Button>
      </div>
      {formatError ? (
        <p role="alert" className="text-xs text-warn-text">
          {formatError}
        </p>
      ) : null}
    </form>
  );
}

/** Interior contents of the model selection popup. */
function ModelMenuBody(props: { menu: ModelMenu; scope: ModelsScope; onOther: () => void }) {
  const controller = useController();
  const { menu } = props;
  const isHostActive = useApp(anyWorkRunning);
  const isRestartPending = useApp((st) => Boolean(st.busy["models:restart"]));
  const restart = restartAction(isHostActive, isRestartPending);
  const activeSelection = selectedValue(menu.rows);

  const handleSelection = (chosenValue: string) => {
    if (chosenValue !== activeSelection) {
      applyModelChoice(controller, chosenValue, props.scope);
    }
  };

  const handleRefresh = () => void controller.refreshModels({ ...props.scope, force: true });

  const renderStatusSection = () => {
    if (!menu.message) return null;
    if (menu.mode === "loading") {
      return ( <div role="status" className="flex items-center gap-2 px-2 pt-1 pb-2 text-xs text-muted">
          <Spinner size={12} />
          {menu.message}
        </div>
      );
    }
    return ( <p role={menu.mode === "error" ? "alert" : undefined} className="px-2 pb-1.5 text-xs text-muted [overflow-wrap:anywhere]">
        {menu.message}
      </p>
    );
  };

  return ( <>
      <MenuLabel>Model</MenuLabel>
      {renderStatusSection()}
      {menu.mode === "error" ? (
        <MenuItem icon={<ArrowsClockwiseIcon size={14} />} keepOpen onSelect={handleRefresh}>
          {MODEL_COPY.retry}
        </MenuItem>
      ) : null}
      {menu.signIn ? (
        <MenuItem
          icon={<SignInIcon size={14} />}
          onSelect={() => {
            const loginTarget = menu.signIn;
            if (!loginTarget) return;
            if (loginTarget.providerId && loginTarget.providerId !== "muse") {
              void controller.beginProviderLogin(loginTarget.providerId, loginTarget.id);
            } else {
              void controller.beginLogin(loginTarget.id);
            }
          }}>
          {menu.signIn.actionLabel ?? MODEL_COPY.signInAction}
        </MenuItem>
      ) : null}
      {menu.notes.map((noteText) => (
        <p key={noteText} className="px-2 pb-1.5 text-xs text-subtle [overflow-wrap:anywhere]">
          {noteText}
        </p>
      ))}
      {menu.showRows ? (
        <MenuRadioGroup value={activeSelection} onValueChange={handleSelection}>
          {menu.rows.map((rowItem) => (
            <ModelRow key={`${rowItem.kind}:${rowItem.id ?? ""}`} choice={rowItem} />
          ))}
          {menu.published.length > 0 ? <MenuLabel>{MODEL_COPY.published}</MenuLabel> : null}
          {menu.published.map((pub) => (
            <MenuOption key={pub.id} value={pub.id} label={pub.label} description={MODEL_COPY.notListed} />
          ))}
        </MenuRadioGroup>
      ) : null}
      <MenuSeparator />
      <MenuItem icon={<PencilSimpleLineIcon size={14} />} onSelect={props.onOther}>
        {MODEL_COPY.other}
      </MenuItem>
      {menu.mode !== "error" && menu.mode !== "signin" ? (
        <MenuItem
          icon={<ArrowsClockwiseIcon size={14} />}
          keepOpen
          disabled={menu.refreshing}
          hint={menu.refreshing ? MODEL_COPY.refreshing : undefined}
          onSelect={handleRefresh}>
          {MODEL_COPY.refresh}
        </MenuItem>
      ) : null}
      {(!props.scope.providerId || props.scope.providerId === "muse") && controller.client.restartHosts ? (
        <MenuItem icon={<ArrowClockwiseIcon size={14} />} keepOpen disabled={restart.disabled} hint={restart.hint ?? undefined} onSelect={() => void controller.restartMuse()}>
          {MODEL_COPY.restart}
        </MenuItem>
      ) : null}
      {menu.footer.line || menu.footer.builtIn || menu.footer.hint ? (
        <div className="mt-1 flex flex-col gap-1 border-t border-line px-2 pt-2 pb-1.5 text-xs text-subtle">
          {menu.footer.line ? <p>{menu.footer.line}</p> : null}
          {menu.footer.builtIn ? <p>{menu.footer.builtIn}</p> : null}
          {menu.footer.hint ? <p>{menu.footer.hint}</p> : null}
        </div>
      ) : null}</>
  );
}

/** Primary model selector widget on the composer toolbar. */
export function ModelPicker(props: { sessionId: string | null; cwd: string | null; side: PickerSide }) {
  const controller = useController();
  const isMenuOpen = useApp((st) => st.picker === "model");
  const [modalActive, setModalActive] = useState(false);

  const { scope, accountId, providerId } = useModelsScope(props.sessionId, props.cwd);
  const currentThreadModel = useThreadModel(props.sessionId);
  const catalogStore = useModelSource();

  const { modelId: preferred, tried } = useApp((st) => defaultModelForScope(st.prefs, scope), shallowEqual);
  const isMuse = providerId === "muse";

  const plan = useApp((s) => {
    if (providerId === "muse") {
      return planAccount(s, accountId).planName;
    }
    const prov = s.providers?.find((p) => p.id === providerId);
    const auth = accountId
      ? prov?.accounts.find((a): a is ProviderAccountView => "providerId" in a && a.id === accountId)?.auth
      : prov?.defaultAuth;
    return auth?.state === "authenticated" ? (auth.planTier ?? auth.summary ?? null) : null;
  });

  const scopedPref = isMuse
    ? preferred
    : preferred && ((catalogStore.accountModels[modelsKey(scope)] ?? []).some((m) => m.modelId === preferred) || tried)
      ? preferred
      : null;

  const computedMenu = useMemo(
    () => modelMenu(catalogStore, { scope, accountId, current: currentThreadModel, pref: props.sessionId && !currentThreadModel ? null : scopedPref, plan, tried }),
    [catalogStore, scope, accountId, currentThreadModel, scopedPref, plan, tried],
  );

  const { trigger } = computedMenu;
  const triggerName = trigger.name;
  const isUnavailable = Boolean(trigger.note);
  const buttonAccessibleLabel = isMuse ? modelButtonLabel(trigger) : `Model: ${triggerName}`;

  const handleCustomModelSubmission = async (typedId: string) => {
    const success = await tryTypedModel(controller, typedId, scope);
    if (success) {
      void controller.setDefaultModelForScope(scope, typedId);
    }
    return success;
  };

  const handleOpenToggle = (nextOpen: boolean) => {
    if (nextOpen) controller.setPicker("model");
    else controller.closePicker("model");
  };

  return ( <>
      <Menu open={isMenuOpen} onOpenChange={handleOpenToggle}>
        <MenuTrigger asChild>
          <ToolbarTrigger
            aria-label={buttonAccessibleLabel}
            tone={isUnavailable ? "warn" : undefined}
            icon={<CpuIcon size={13} />}
            label={<span className="flex min-w-0 items-center truncate"><span className="truncate">{triggerName}</span>{trigger.note ? <span className="ml-1 shrink-0">({trigger.note})</span> : null}{trigger.contributor ? <span className="ml-1.5"><ContributorBadge tip /></span> : null}</span>} />
        </MenuTrigger>
        <MenuContent side={props.side} className="w-[300px]">
          <ModelMenuBody
            menu={computedMenu}
            scope={scope}
            onOther={() => {
              controller.closePicker("model");
              setModalActive(true);
            }} />
        </MenuContent>
      </Menu>
      <Modal
        open={modalActive}
        onOpenChange={setModalActive}
        title="Use another model"
        description="Type any model id. Ancilla will verify that the provider accepts it.">
        <ModelIdForm
          label="Model id"
          onUse={handleCustomModelSubmission}
          onDone={() => setModalActive(false)}
          onCancel={() => setModalActive(false)} />
      </Modal></>
  );
}

/** Account and provider selection popover for home/new thread scopes. */
function AccountPicker(props: { sessionId: string | null; cwd: string | null; variant: "thread" | "home" }) {
  const controller = useController();
  const isPickerOpen = useApp((st) => st.picker === "account");
  const projectInfo = useApp((st) => projectForCwd(st.projects, props.cwd));
  const activeAccounts = useApp((st) => st.accounts);
  const activeProviders = useApp((st) => st.providers);
  const museInstalled = useApp((st) => st.env?.museFound !== false);

  const selectedProviderId = (projectInfo?.defaultProviderId ?? "muse") as ProviderId;
  const selectedAccountId = projectInfo?.defaultAccountId ?? null;

  const validAltProviders = useMemo(
    () =>
      (activeProviders ?? []).filter(
        (prov) =>
          prov.id !== "muse" &&
          (prov.id === "api" ? prov.accounts.length > 0 : prov.binary.available || prov.accounts.length > 0 || prov.id === selectedProviderId),
      ),
    [activeProviders, selectedProviderId],
  );

  const hasMuseAccounts = Boolean(activeAccounts && activeAccounts.length > 0);
  if (props.sessionId !== null || !projectInfo || (!hasMuseAccounts && activeProviders === null && selectedProviderId === "muse")) {
    return null;
  }

  const formatSelectionKey = (pId: ProviderId, aId: string | null) => `${pId}::${aId ?? ""}`;
  const compositeKey = formatSelectionKey(selectedProviderId, selectedAccountId);

  let displayLabel: string;
  if (selectedProviderId === "muse") {
    const foundName = activeAccounts?.find((acct) => acct.id === selectedAccountId)?.name;
    displayLabel = validAltProviders.length > 0 ? (foundName ? `Muse · ${foundName}` : "Meta Muse") : (foundName ?? "Default login");
  } else {
    const prov = activeProviders?.find((p) => p.id === selectedProviderId);
    const acct = prov?.accounts.find((a) => a.id === selectedAccountId);
    const shortBadge = providerBadgeName(selectedProviderId);
    displayLabel = acct ? `${shortBadge} · ${acct.name}` : (prov?.displayName ?? shortBadge);
  }

  const handleAccountChange = (chosenComposite: string) => {
    const separatorIdx = chosenComposite.indexOf("::");
    const nextProv = (separatorIdx >= 0 ? chosenComposite.slice(0, separatorIdx) : "muse") as ProviderId;
    const nextAcct = separatorIdx >= 0 ? chosenComposite.slice(separatorIdx + 2) || null : null;

    if (nextProv === "muse") {
      void controller.setProjectDefaultAccount(projectInfo.cwd, nextAcct, selectedProviderId !== "muse" ? "muse" : undefined);
    } else {
      void controller.setProjectDefaultAccount(projectInfo.cwd, nextAcct, nextProv);
    }
  };

  return ( <Menu open={isPickerOpen} onOpenChange={(nxt) => (nxt ? controller.setPicker("account") : controller.closePicker("account"))}>
      <MenuTrigger asChild>
        <ToolbarTrigger aria-label={`Account: ${displayLabel}`} icon={<UserIcon size={13} />} label={<span className="truncate">{displayLabel}</span>} />
      </MenuTrigger>
      <MenuContent side={props.variant === "home" ? "bottom" : "top"} className="w-[320px]">
        <MenuLabel>{validAltProviders.length > 0 || activeProviders !== null ? "Provider & Account" : "Account"}</MenuLabel>
        <MenuRadioGroup value={compositeKey} onValueChange={handleAccountChange}>
          {museInstalled || selectedProviderId === "muse" || hasMuseAccounts ? (<>
              <MenuOption
                value={formatSelectionKey("muse", null)}
                label={validAltProviders.length > 0 ? "Meta Muse · Default login" : "Default login"}
                description={museInstalled ? undefined : "Muse CLI not installed"} />
              {(activeAccounts ?? []).map((acct) => (
                <MenuOption
                  key={`muse:${acct.id}`}
                  value={formatSelectionKey("muse", acct.id)}
                  label={validAltProviders.length > 0 ? `Meta Muse · ${acct.name}` : acct.name}
                  description={acct.hasLogin ? (acct.email ?? "Signed in") : "Not signed in"} />
              ))}</>
          ) : null}
          {validAltProviders.map((prov) => {
            const hasDefault = prov.id !== "api" && !prov.id.startsWith("acp:") && prov.binary.available;
            const typedAccounts = prov.accounts.filter((a): a is ProviderAccountView => "providerId" in a);
            return ( <div key={prov.id}>
                {hasDefault ? (
                  <MenuOption
                    value={formatSelectionKey(prov.id, null)}
                    label={prov.displayName}
                    description={
                      prov.defaultAuth?.summary ??
                      (prov.defaultAuth?.state === "authenticated" ? "Signed in" : "Sign in in Settings")
                    } />
                ) : null}
                {typedAccounts.map((acct) => (
                  <MenuOption
                    key={`${prov.id}:${acct.id}`}
                    value={formatSelectionKey(prov.id, acct.id)}
                    label={prov.id === "api" ? `API · ${acct.name}` : `${providerBadgeName(prov.id)} · ${acct.name}`}
                    description={
                      prov.id === "api"
                        ? (acct.apiBaseUrl ?? acct.apiKind ?? "Direct API")
                        : (acct.auth?.summary ?? (acct.auth?.state === "authenticated" ? "Signed in" : "Sign in in Settings"))
                    } />
                ))}
              </div>
            );
          })}
        </MenuRadioGroup>
        {activeProviders !== null ? (<>
            <MenuSeparator />
            <MenuItem onSelect={() => controller.navigate({ kind: "settings" })}>
              Configure providers &amp; API keys…
            </MenuItem></>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

const RESEARCH_FIELD = "h-7 w-14 rounded-md bg-sunken px-2 text-right text-xs text-fg tabular-nums outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus";

/** Trigger and configuration popover for deep research execution. */
function ResearchTrigger(props: { sessionId: string | null; side: PickerSide; disabled: boolean }) {
  const controller = useController();
  const isPopOpen = useApp((st) => st.picker === "research");
  const isModeArmed = useApp((st) => st.researchMode);
  const researchConf = useApp((st) => st.researchSettings);
  const stopWritesPref = useApp((st) => st.researchStopWrites);
  const currentTyped = useApp((st) => st.researchTyped);
  const isThreadResearchRunning = useApp((st) => (props.sessionId ? (st.threads[props.sessionId]?.researchRuns.some(researchLive) ?? false) : false));

  const minElemId = useId();
  const maxElemId = useId();
  const parallelElemId = useId();
  const toggleElemId = useId();
  const initialFieldRef = useRef<HTMLInputElement>(null);

  const activeDefaults = researchConf?.config ?? null;
  const isGloballyDisabled = researchConf?.enabled === false;
  const disabledReason = isGloballyDisabled
    ? "Deep research is off in Settings"
    : isThreadResearchRunning
      ? "A research run is already going in this thread"
      : null;

  const controlDisabled = props.disabled || disabledReason !== null;

  const resolveFieldValue = (fieldKey: keyof ResearchTyped, fallbackVal: number | undefined) => {
    return currentTyped[fieldKey] ?? (fallbackVal === undefined ? "" : String(fallbackVal));
  };

  const updateTypedValue = (fieldKey: keyof ResearchTyped, nextStr: string) => {
    controller.setResearchTyped({ [fieldKey]: nextStr });
  };

  const clampAndPersist = (fieldKey: keyof ResearchTyped, bounds: ResearchRange, increment = 1) => {
    if (currentTyped[fieldKey] === null) return;
    const clamped = clampResearchNumber(currentTyped[fieldKey], bounds, increment);
    controller.setResearchTyped({ [fieldKey]: clamped === null ? null : String(clamped) });
  };

  const modeButtonLabel = disabledReason
    ? `Deep research: ${disabledReason}`
    : isModeArmed
      ? "Research mode on: Send starts a run"
      : "Research mode";

  const triggerSplitGroup = (
    <span className="inline-flex items-stretch rounded-lg">
      <button
        type="button"
        aria-pressed={isModeArmed}
        aria-label={modeButtonLabel}
        disabled={controlDisabled}
        onClick={() => controller.setResearchMode(!isModeArmed)}
        className={cn(
          "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-l-lg px-2 text-xs font-medium transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50",
          isModeArmed ? "bg-accent-soft text-accent-text hover:bg-accent-soft" : "text-muted hover:bg-hover hover:text-fg",
        )}>
        <BinocularsIcon size={13} className="shrink-0" />
        <span className="truncate">Research</span>
      </button>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Research options"
          disabled={controlDisabled}
          className={cn(
            "inline-flex h-7 items-center rounded-r-lg pr-1.5 pl-0.5 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-hover data-[state=open]:text-fg",
            isModeArmed ? "bg-accent-soft text-accent-text" : "text-muted hover:bg-hover hover:text-fg",
          )}>
          <CaretDownIcon size={12} className="shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
    </span>
  );

  return ( <Popover.Root
      open={isPopOpen && !controlDisabled}
      onOpenChange={(next) => (next ? controller.setPicker("research") : controller.closePicker("research"))}>
      {disabledReason ? (
        <Tip label={disabledReason}>
          <span tabIndex={0} className="inline-flex rounded-lg">
            {triggerSplitGroup}
          </span>
        </Tip>
      ) : (
        <Tip
          label={
            isModeArmed
              ? "Research mode is on: type the question and press Enter"
              : "Research mode: type a question, and Send has Muse workers research it into a cited report"
          }
          shortcut={[MOD, "Shift", "R"]}>
          {triggerSplitGroup}
        </Tip>
      )}

      <Popover.Portal><Popover.Content side={props.side} align="start" sideOffset={6} onOpenAutoFocus={(e) => { e.preventDefault(); initialFieldRef.current?.focus(); }} className="z-50 w-72 rounded-xl border border-line bg-raised p-3 text-xs shadow-xl outline-none">
          <div className="flex items-center justify-between pb-2">
            <span className="font-semibold text-fg">Research run options</span>
            <span className="text-2xs text-subtle">Saved per run</span>
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <label htmlFor={minElemId} className="text-muted">
                Target minutes
              </label>
              <input
                id={minElemId}
                ref={initialFieldRef}
                type="text"
                inputMode="numeric"
                value={resolveFieldValue("windowMin", activeDefaults?.windowMinMinutes)}
                onChange={(e) => updateTypedValue("windowMin", e.currentTarget.value)}
                onBlur={() => clampAndPersist("windowMin", RESEARCH_LIMITS.windowMinutes, WINDOW_STEP)}
                placeholder={String(activeDefaults?.windowMinMinutes ?? "")}
                className={RESEARCH_FIELD} />
            </div>

            <div className="flex items-center justify-between">
              <label htmlFor={maxElemId} className="text-muted">
                Max minutes
              </label>
              <input
                id={maxElemId}
                type="text"
                inputMode="numeric"
                value={resolveFieldValue("windowMax", activeDefaults?.windowMaxMinutes)}
                onChange={(e) => updateTypedValue("windowMax", e.currentTarget.value)}
                onBlur={() => clampAndPersist("windowMax", RESEARCH_LIMITS.windowMinutes, WINDOW_STEP)}
                placeholder={String(activeDefaults?.windowMaxMinutes ?? "")}
                className={RESEARCH_FIELD} />
            </div>

            <div className="flex items-center justify-between">
              <label htmlFor={parallelElemId} className="text-muted">
                Parallel workers
              </label>
              <input
                id={parallelElemId}
                type="text"
                inputMode="numeric"
                value={resolveFieldValue("parallel", activeDefaults?.maxParallel)}
                onChange={(e) => updateTypedValue("parallel", e.currentTarget.value)}
                onBlur={() => clampAndPersist("parallel", RESEARCH_LIMITS.parallel, 1)}
                placeholder={String(activeDefaults?.maxParallel ?? "")}
                className={RESEARCH_FIELD} />
            </div>

            <div className="flex items-center justify-between pt-1">
              <label htmlFor={toggleElemId} className="text-muted">Stop worker writes</label>
              <Toggle id={toggleElemId} checked={stopWritesPref} label="Stop writes a report from what it has" onChange={(on) => controller.setResearchStopWrites(on)} />
            </div></div></Popover.Content></Popover.Portal></Popover.Root>
  );
}

const buildReasoningLevel = (value: ReasoningEffort, label: string, description: string) => ({ value, label, description });

export const LEVELS: { value: ReasoningEffort; label: string; description: string }[] = [
  buildReasoningLevel("none", "Off", "Answers right away, without reasoning"),
  buildReasoningLevel("minimal", "Minimal", "A quick think before answering"),
  buildReasoningLevel("low", "Low", "Light reasoning for simple changes"),
  buildReasoningLevel("medium", "Medium", "Balanced speed and depth"),
  buildReasoningLevel("high", "High", "Thinks harder problems through"),
  buildReasoningLevel("xhigh", "Extra high", "Deep reasoning for tricky work"),
  buildReasoningLevel("max", "Max", "The slowest and most thorough"),
];

const RESTING_EFFORT_DEFAULT: ReasoningEffort = "medium";

/** Reasoning effort selector component. */
export function EffortPicker(props: { sessionId: string | null; cwd: string | null; side: PickerSide }) {
  const controller = useController();
  const isPopOpen = useApp((st) => st.picker === "effort");
  const switchElemId = useId();

  const { scope, accountId, providerId } = useModelsScope(props.sessionId, props.cwd);
  const threadModelId = useThreadModel(props.sessionId);
  const catalogStore = useModelSource();

  const { modelId: preferred, tried } = useApp((st) => defaultModelForScope(st.prefs, scope), shallowEqual);
  const isMuse = providerId === "muse";
  const providerName = providerBadgeName(providerId);

  const scopedPref = isMuse
    ? preferred
    : preferred && ((catalogStore.accountModels[modelsKey(scope)] ?? []).some((m) => m.modelId === preferred) || tried)
      ? preferred
      : null;

  const activeModelOption = activeModel(catalogStore, scope, threadModelId, props.sessionId && !threadModelId ? null : scopedPref);
  const activeCapabilities = useActiveCapabilities(props.sessionId, props.cwd);

  const [restingLevel, setRestingLevel] = useState<ReasoningEffort>(RESTING_EFFORT_DEFAULT);
  const currentEffort = useApp((st) => st.prefs.effort);

  if (activeCapabilities && !activeCapabilities.supportsReasoningEffort) return null;

  const { levels, auto, shown, position } = effortView(activeModelOption, currentEffort, LEVELS, restingLevel);
  const topLimit = Math.max(levels.length - 1, 1);
  const effortTextLabel = shown ? effortLabel(shown) : "Auto";
  const isMaxTier = shown === "max";
  const explanationNote = effortNote(currentEffort, shown);

  const handleLevelSelect = (targetIdx: number) => {
    const candidate = levels[targetIdx];
    if (candidate) {
      setRestingLevel(candidate.value);
      controller.setEffort(candidate.value);
    }
  };

  return ( <Popover.Root
      open={isPopOpen}
      onOpenChange={(next) => (next ? controller.setPicker("effort") : controller.closePicker("effort"))}>
      <Popover.Trigger asChild>
        <ToolbarTrigger
          aria-label={`Reasoning effort: ${effortTextLabel}`}
          icon={<BrainIcon size={13} />}
          label={effortTextLabel} />
      </Popover.Trigger>
      <Popover.Portal><Popover.Content side={props.side} align="start" sideOffset={6} className="z-50 w-72 rounded-xl border border-line bg-raised p-3 text-xs shadow-xl outline-none">
          <div className="flex items-center justify-between pb-2">
            <span className="font-semibold text-fg">Reasoning effort</span>
            <Tip label="Higher effort thinks longer for more thorough answers, but each turn takes more time.">
              <button type="button" aria-label="What effort does" className="text-subtle hover:text-muted">
                <QuestionIcon size={13} />
              </button>
            </Tip>
          </div>

          <div className="py-2">
            <Slider.Root
              min={0}
              max={topLimit}
              step={1}
              value={[position]}
              disabled={levels.length < 2}
              aria-label="Reasoning effort"
              onValueChange={([idx]) => {
                if (idx !== undefined) handleLevelSelect(idx);
              }}
              className="relative flex h-5 w-full touch-none select-none items-center">
              <Slider.Track className="relative h-1.5 w-full grow rounded-full bg-sunken">
                <Slider.Range className="absolute h-full rounded-full bg-accent" />
              </Slider.Track>
              <Slider.Thumb
                aria-label="Reasoning effort"
                className="block size-4 rounded-full border border-line bg-fg shadow-sm outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-focus" />
            </Slider.Root>

            <div className="flex justify-between pt-1.5 text-2xs text-subtle">
              <span>{levels[0]?.label}</span>
              <span>{levels[levels.length - 1]?.label}</span>
            </div>
          </div>

          <div className="rounded-lg bg-sunken p-2">
            <div className="font-medium text-fg">{levels[position]?.label}</div>
            <div className="text-2xs text-muted">{levels[position]?.description}</div>
          </div>

          {explanationNote ? <p className="mt-1 text-xs text-subtle">{explanationNote}</p> : null}

          <div className="mt-3 flex items-center justify-between border-t border-line pt-2.5">
            <label htmlFor={switchElemId} className="text-xs text-muted">
              Let {providerName} decide
            </label>
            <Switch.Root id={switchElemId} checked={auto} onCheckedChange={(on) => controller.setEffort(on ? null : (levels[position]?.value ?? "medium"))} className="relative h-5 w-9 cursor-pointer rounded-full bg-sunken transition-colors data-[state=checked]:bg-accent">
              <Switch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-150 data-[state=checked]:translate-x-4" />
            </Switch.Root></div></Popover.Content></Popover.Portal>
    </Popover.Root>
  );
}

const buildApprovalMode = (value: ApprovalMode, label: string, description: string, icon: ReactNode) => ({ value, label, description, icon });

export const MODES: { value: ApprovalMode; label: string; description: string; icon: ReactNode }[] = [
  buildApprovalMode("onRequest", "Ask first", "Muse asks before anything that needs approval.", <ShieldIcon size={14} />),
  buildApprovalMode("promptUnmatched", "Ask for unlisted", "Commands your rules allow just run; anything else asks.", <ShieldChevronIcon size={14} />),
  buildApprovalMode("denyUnmatched", "Deny unlisted", "Commands your rules allow just run; anything else is refused.", <LockIcon size={14} />),
  buildApprovalMode("allowAll", "Full access", "Every tool runs without asking. Only for sandboxes.", <ShieldWarningIcon size={14} />),
];

/** Modal for confirming transition to Full Access approval posture. */
function FullAccessModal({
  isOpen,
  onOpenChange,
  onConfirm,
  onOpenSettings,
}: {
  isOpen: boolean;
  onOpenChange: (next: boolean) => void;
  onConfirm: () => void;
  onOpenSettings: () => void;
}) {
  return ( <Modal
      open={isOpen}
      onOpenChange={onOpenChange}
      title="Turn on full access?"
      description="Commands run without showing them to you first, but still inside the sandbox. You can switch back anytime.">
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onOpenSettings}>
          Settings
        </Button>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Keep asking
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          Allow full access
        </Button>
      </div>
    </Modal>
  );
}

/** Modal for confirming answering approvals automatically. */
function BypassApprovalsModal({
  isOpen,
  onOpenChange,
  onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (next: boolean) => void;
  onConfirm: () => void;
}) {
  return ( <Modal
      open={isOpen}
      onOpenChange={onOpenChange}
      title="Answer approvals for you?"
      description="Every approval Muse raises, in any thread, is allowed once without showing you the command first. Muse asks about the commands it could not resolve, so these are the ones nothing else has checked. This lasts until you close Ancilla.">
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Keep asking
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          Answer them for me
        </Button>
      </div>
    </Modal>
  );
}

/** Modal for confirming YOLO execution mode. */
function YoloConfirmationModal({
  isOpen,
  onOpenChange,
  onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (next: boolean) => void;
  onConfirm: () => void;
}) {
  return ( <Modal
      open={isOpen}
      onOpenChange={onOpenChange}
      title="Turn on YOLO mode?"
      description="Like muse --yolo: nothing asks for approval in any thread, new threads run without sandbox confinement, and workspaces are trusted. The running Muse hosts restart, interrupting their turns, and threads already open keep the sandbox posture they started with. This stays on until you switch it off.">
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Keep asking
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          Turn on YOLO
        </Button>
      </div>
    </Modal>
  );
}

/** Access permissions and approval mode picker widget. */
function AccessPicker(props: { sessionId: string | null; cwd?: string | null; side: PickerSide }) {
  const controller = useController();
  const isMenuOpen = useApp((st) => st.picker === "permissions");
  const isFullAccessConfirming = useApp((st) => st.picker === "confirmFullAccess");
  const isBypassConfirming = useApp((st) => st.picker === "confirmBypass");
  const isYoloConfirming = useApp((st) => st.picker === "confirmYolo");

  const preferredMode = useApp((st) => st.prefs.defaultMode);
  const threadMode = useApp((st) => (props.sessionId ? (st.threads[props.sessionId]?.fold.meta.approvalMode ?? null) : null));
  const currentApprovalMode = (props.sessionId ? threadMode : null) ?? preferredMode;

  const isBypassActive = useApp((st) => st.bypassAll);
  const isYoloActive = useApp((st) => st.yoloSettings?.enabled === true);
  const capabilities = useActiveCapabilities(props.sessionId, props.cwd ?? null);

  const availableModes = useMemo(() => {
    if (!capabilities?.supportsApprovalModes?.length) return MODES;
    const subset = MODES.filter((m) => capabilities.supportsApprovalModes.includes(m.value));
    return subset.length > 0 ? subset : MODES;
  }, [capabilities]);

  const activeModeItem = availableModes.find((m) => m.value === currentApprovalMode) ?? MODES.find((m) => m.value === currentApprovalMode) ?? MODES[0]!;

  const bypassSwitchId = useId();
  const yoloSwitchId = useId();

  const handleModeChange = (targetMode: string) => {
    if (targetMode === "allowAll") {
      controller.setPicker("confirmFullAccess");
    } else {
      void controller.setMode(targetMode as ApprovalMode);
    }
  };

  const handleBypassToggle = (wantsBypass: boolean) => {
    if (wantsBypass) {
      controller.setPicker("confirmBypass");
    } else {
      controller.setBypassAll(false);
    }
  };

  const handleYoloToggle = (wantsYolo: boolean) => {
    if (wantsYolo) {
      controller.setPicker("confirmYolo");
    } else {
      void controller.setYoloEnabled(false);
    }
  };

  const triggerLabel = isYoloActive ? "YOLO" : activeModeItem.label;
  const triggerTone = isYoloActive || currentApprovalMode === "allowAll" || isBypassActive ? "warn" : undefined;
  const triggerIcon = isYoloActive ? <LightningIcon size={14} /> : activeModeItem.icon;

  return ( <>
      <Menu
        open={isMenuOpen}
        onOpenChange={(next) => (next ? controller.setPicker("permissions") : controller.closePicker("permissions"))}>
        <MenuTrigger asChild><ToolbarTrigger aria-label={isYoloActive ? "Permissions: YOLO mode" : `Permissions: ${activeModeItem.label}`} tone={triggerTone} icon={triggerIcon} label={<span className="truncate">{triggerLabel}</span>} /></MenuTrigger>
        <MenuContent side={props.side} className="w-[300px]"><MenuLabel>Permissions</MenuLabel>
          <div className="flex items-center justify-between px-2 py-1.5">
            <label htmlFor={yoloSwitchId} className="text-xs text-muted">YOLO mode</label>
            <Switch.Root id={yoloSwitchId} checked={isYoloActive} onCheckedChange={handleYoloToggle} className="relative h-5 w-9 cursor-pointer rounded-full bg-sunken transition-colors data-[state=checked]:bg-warn">
              <Switch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-150 data-[state=checked]:translate-x-4" />
            </Switch.Root></div>

          <MenuRadioGroup value={currentApprovalMode} onValueChange={handleModeChange}>
            {availableModes.map((modeDef) => (
              <MenuOption
                key={modeDef.value}
                value={modeDef.value}
                icon={modeDef.icon}
                label={modeDef.label}
                description={modeDef.description}
                disabled={isYoloActive} />
            ))}
          </MenuRadioGroup>

          {isYoloActive ? (
            <p className="px-2 pt-1 text-xs text-subtle">
              YOLO owns every thread&apos;s mode while it is on. Switch it off to choose.
            </p>
          ) : null}

          <MenuSeparator />
          <div className="flex items-center justify-between px-2 py-1.5">
            <label htmlFor={bypassSwitchId} className="text-xs text-muted">
              Auto-approve for this session
            </label>
            <Switch.Root id={bypassSwitchId} checked={isBypassActive} onCheckedChange={handleBypassToggle} className="relative h-5 w-9 cursor-pointer rounded-full bg-sunken transition-colors data-[state=checked]:bg-accent">
              <Switch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-150 data-[state=checked]:translate-x-4" />
            </Switch.Root></div></MenuContent></Menu>

      <FullAccessModal
        isOpen={isFullAccessConfirming}
        onOpenChange={(next) => (next ? controller.setPicker("confirmFullAccess") : controller.closePicker("confirmFullAccess"))}
        onConfirm={() => {
          controller.closePicker("confirmFullAccess");
          void controller.setMode("allowAll");
        }}
        onOpenSettings={() => {
          controller.closePicker("confirmFullAccess");
          controller.navigate({ kind: "settings" });
        }} />

      <BypassApprovalsModal
        isOpen={isBypassConfirming}
        onOpenChange={(next) => (next ? controller.setPicker("confirmBypass") : controller.closePicker("confirmBypass"))}
        onConfirm={() => {
          controller.closePicker("confirmBypass");
          controller.setBypassAll(true);
        }} />

      <YoloConfirmationModal
        isOpen={isYoloConfirming}
        onOpenChange={(next) => (next ? controller.setPicker("confirmYolo") : controller.closePicker("confirmYolo"))}
        onConfirm={() => {
          controller.closePicker("confirmYolo");
          void controller.setYoloEnabled(true);
        }} /></>
  );
}

/** Displays token generation rate either live or from the previous turn. */
function SpeedReadout(props: { sessionId: string }) {
  const controller = useController();
  const isTurnLive = useApp((st) => Boolean(st.threads[props.sessionId]?.fold.activeTurnId));

  const turnMetrics = useApp((st) => {
    const threadFold = st.threads[props.sessionId]?.fold;
    const speed = threadFold ? lastTurnSpeed(threadFold) : null;
    return speed ? { tps: speed.tokensPerSecond, tokens: speed.outputTokens, ms: speed.generationMs } : null;
  }, shallowEqual);

  const streamingTps = useSampled(() => {
    const threadFold = controller.store.get().threads[props.sessionId]?.fold;
    return threadFold?.activeTurnId ? streamingSpeed(threadFold.turns[threadFold.activeTurnId]) : null;
  }, isTurnLive);

  if (isTurnLive && streamingTps !== null) {
    return ( <Tip label="Estimated from the text streaming now">
        <span tabIndex={0} className="shrink-0 px-1 text-2xs text-subtle tabular-nums">
          ~{formatSpeed(streamingTps)}
        </span>
      </Tip>
    );
  }

  if (!turnMetrics) return null;

  const tipText = `Last turn: ${formatTokens(turnMetrics.tokens)} output tokens over ${formatDuration(turnMetrics.ms)} of model calls`;

  return ( <Tip label={tipText}>
      <span tabIndex={0} className="shrink-0 px-1 text-2xs text-subtle tabular-nums">
        {formatSpeed(turnMetrics.tps)}
      </span>
    </Tip>
  );
}

function FooterCwdPill({ path }: { path: string }) {
  const folderTitle = basename(path);
  return ( <Tip label={path} side="top" align="start">
      <span className="flex min-w-0 items-center gap-1.5" tabIndex={0}>
        <FolderIcon size={12} className="shrink-0" />
        <span className="truncate">{folderTitle}</span>
      </span>
    </Tip>
  );
}

function FooterBranchPill({ branchName }: { branchName: string }) {
  return ( <span className="flex min-w-0 items-center gap-1.5">
      <GitBranchIcon size={12} className="shrink-0" />
      <span className="truncate font-mono text-2xs">{branchName}</span>
    </span>
  );
}

export function ComposerFooter(props: { cwd: string | null; branch: string | null; running: boolean; lead?: ReactNode }) {
  const footerHint = props.running
    ? `Enter queues, ${MOD}+Enter adds to this turn, Esc stops`
    : "Enter to send, Shift+Enter for a new line, / for commands, ! for shell";

  return ( <div className="flex h-8 items-center gap-3 px-2 text-xs text-subtle">
      {props.lead}
      {props.cwd ? <FooterCwdPill path={props.cwd} /> : null}
      {props.branch ? <FooterBranchPill branchName={props.branch} /> : null}
      <span className="flex-1" />
      <span className="hidden truncate md:inline">{footerHint}</span>
    </div>
  );
}