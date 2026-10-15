import { ArrowClockwiseIcon, ArrowUpIcon, ArrowsClockwiseIcon, ArrowsInIcon, BinocularsIcon, BrainIcon, CaretDownIcon, CpuIcon, FolderIcon, GitBranchIcon, LightningIcon, LockIcon, PencilSimpleLineIcon, QuestionIcon, ShieldChevronIcon, ShieldIcon, ShieldWarningIcon, SignInIcon, SquareIcon, TerminalWindowIcon, UserIcon } from "../ui/icons.js";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AttachButton, AttachmentTray, readFiles, restoreFiles, toOutgoing, toPreview, type PendingFile } from "./attachments.js";
import { CostMeter } from "./CostPanel.js";
import { Popover, Slider, Switch } from "radix-ui";
import { shallowEqual, useApp, useController } from "../../app/context.js";
import { useSampled } from "../../app/sampled.js";
import { loadDraft, saveDraft } from "../../model/controller.js";
import { basename, formatDuration, formatSpeed, formatTokens } from "../../model/format.js";
import {
  MODEL_COPY,
  activeModel,
  anyWorkRunning,
  applyModelChoice,
  choiceDetail,
  choiceValue,
  effortLabel,
  effortNote,
  effortView,
  modelButtonLabel,
  modelCompletions,
  modelIdError,
  modelMenu,
  modelsStanding,
  restartAction,
  selectedValue,
  tryTypedModel,
  type ModelChoice,
  type ModelCompletion,
  type ModelMenu,
  type ModelsScope,
  type ModelsState,
} from "../../model/models.js";
import { planAccount } from "../../model/plan.js";
import { publishedModelIds } from "../../model/pricing.js";
import { matchSlash, parseSlash, resolveSlash, slashCommands, type SlashCommand } from "../../model/slash.js";
import { RESEARCH_LIMITS, WINDOW_STEP, clampResearchNumber, popoverOverrides, researchLive, type ResearchRange, type ResearchTyped } from "../../model/research.js";
import { projectForCwd } from "../../model/status.js";
import type { SkillsState } from "../../model/store.js";
import { lastTurnSpeed, streamingSpeed } from "../../model/usage.js";
import type { ApprovalMode, ModelOption, ReasoningEffort } from "../../types.js";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuOption, MenuRadioGroup, MenuSeparator, MenuTrigger, Modal, Tip, FLOATING } from "../ui/overlays.js";
import { Button, IconButton, MOD, Spinner, Toggle, cn } from "../ui/primitives.js";
import { PixelFlow } from "../ui/PixelFlow.js";
import { ContextMeter } from "./ContextPanel.js";
import { SlashMenu, slashOptionId, type SlashMenuState } from "./SlashMenu.js";
import { SwapIcon } from "../ui/sourced.js";

/** A composer draft that survives switching threads and reloads. */
function useDraft(key: string): [string, (value: string) => void] {
  const [state, setState] = useState(() => ({ key, value: loadDraft(key) }));
  const value = state.key === key ? state.value : loadDraft(key);
  if (state.key !== key) {
    setState({ key, value });
  }
  const set = useCallback(
    (next: string) => {
      setState({ key, value: next });
      saveDraft(key, next);
    },
    [key],
  );
  return [value, set];
}

/** The slash menu for a draft, with what picking a row writes in front of the command's name. */
type SlashMenuView = SlashMenuState & { prefix: string };

/**
 * What the menu shows for the draft and caret. While the caret is in the first word it lists matching
 * commands; `/skill <name>` lists skills and `/model <text>` the models the text fits; after that it only appears to
 * flag a command Muse does not know. `limited` says the models are only Muse's built-in list, so the ones Meta
 * publishes complete after them.
 */
export function slashMenuFor(
  text: string,
  caret: number,
  commands: SlashCommand[],
  skills: SkillsState | undefined,
  models: readonly ModelOption[] = [],
  limited = false,
): SlashMenuView | null {
  const first = /^\/(\S*)/.exec(text);
  if (!first) {
    return null;
  }
  const loading = !skills || skills.status === "loading";
  const error = skills?.status === "error" ? skills.error : null;
  // Only while typing the command word: a caret before the slash is not typing a command.
  if (caret >= 1 && caret <= first[0].length) {
    const query = first[1] as string;
    const items = matchSlash(commands, query);
    if (items.length > 0 || !query) {
      return { kind: "list", items, loading, error, prefix: "/" };
    }
    return loading ? { kind: "loading", prefix: "/" } : { kind: "unknown", name: query.toLowerCase(), prefix: "/" };
  }
  const naming = /^\/skill\s+(\S*)$/i.exec(text);
  if (naming && caret === text.length) {
    const items = matchSlash(
      commands.filter((c) => c.kind === "skill"),
      naming[1] as string,
    );
    if (items.length > 0) {
      return { kind: "list", items, loading, error, prefix: "/skill " };
    }
  }
  // The text after `/model ` finds a model by any part of its name; with nothing typed yet it lists them all.
  const choosing = /^\/models?\s+([^\n]*)$/i.exec(text);
  if (choosing && caret === text.length) {
    const query = (choosing[1] as string).trim();
    const items = modelCompletions(models, query, undefined, limited);
    if (items.length > 0) {
      return { kind: "models", items, query, prefix: "/model " };
    }
  }
  const parsed = parseSlash(text);
  if (!parsed || resolveSlash(parsed, commands, skills?.skills ?? []).kind !== "unknown") {
    return null;
  }
  return loading ? { kind: "loading", prefix: "/" } : { kind: "unknown", name: parsed.name, prefix: "/" };
}

/**
 * The slash menu for a draft over the model catalog of the composer's scope: `/model <text>` completes against the rows
 * the model picker shows for it, and while those are only Muse's built-in list, against the models Meta publishes too.
 * The one place the rows and that verdict are read together.
 */
export function slashMenuOver(
  text: string,
  caret: number,
  commands: SlashCommand[],
  skills: SkillsState | undefined,
  source: Pick<ModelsState, "models" | "accountModels" | "modelsStatus">,
  scope: ModelsScope,
): SlashMenuView | null {
  const { models, limited } = modelsStanding(source, scope);
  return slashMenuFor(text, caret, commands, skills, models, limited);
}

/** As many files per message as the server takes. */
const MAX_FILES = 10;

/**
 * The catalog the composer on screen picks models from, as the controller reads it: an open thread's own host, else
 * the account the project's new threads run on. `accountId` is the login that host runs as, null for the default one.
 */
function useModelsScope(sessionId: string | null, cwd: string | null): { scope: ModelsScope; accountId: string | null } {
  const accountId = useApp((s) =>
    sessionId ? (s.sessions[sessionId]?.accountId ?? null) : (projectForCwd(s.projects, cwd)?.defaultAccountId ?? null),
  );
  const scope = useMemo<ModelsScope>(() => (sessionId ? { sessionId } : { accountId }), [sessionId, accountId]);
  return { scope, accountId };
}

/** The lists and loads the model menus read, held together so they re-render only when one changes. */
function useModelSource() {
  const models = useApp((s) => s.models);
  const accountModels = useApp((s) => s.accountModels);
  const modelsStatus = useApp((s) => s.modelsStatus);
  const accounts = useApp((s) => s.accounts);
  return useMemo(() => ({ models, accountModels, modelsStatus, accounts }), [models, accountModels, modelsStatus, accounts]);
}

/** The model an open thread runs on, from its own record first. */
function useThreadModel(sessionId: string | null): string | null {
  return useApp((s) => (sessionId ? (s.threads[sessionId]?.fold.meta.modelId ?? s.sessions[sessionId]?.modelId ?? null) : null));
}

export interface ComposerProps {
  sessionId: string | null;
  cwd: string | null;
  running: boolean;
  readOnly: boolean;
  variant: "thread" | "home";
  autoFocus?: boolean;
}

export function Composer(props: ComposerProps) {
  const controller = useController();
  const draftKey = props.sessionId ?? `new:${props.cwd ?? ""}`;
  const [text, setText] = useDraft(draftKey);
  // A prompt that failed to send from another composer (the new-thread screen) comes back here.
  const handoff = useApp((s) => (s.draftHandoff?.key === draftKey ? s.draftHandoff : null));
  useEffect(() => {
    if (handoff) {
      const handed = controller.takeDraftHandoff(draftKey);
      if (handed) {
        setText(handed.text);
        if (handed.attachments?.length) {
          setFiles(restoreFiles(handed.attachments, handed.previews ?? []));
        }
      }
    }
  }, [handoff, draftKey, controller, setText]);
  const ref = useRef<HTMLTextAreaElement>(null);
  // One keypress, one send: clearing is React state, so a second Enter in the same frame re-reads the
  // same draft. The marker is synchronous where state is not; only an unchanged draft matches it, so a
  // genuinely new message typed while a send is in flight still goes.
  const consumedRef = useRef<{ value: string; files: PendingFile[] | null } | null>(null);
  const tryConsume = (value: string, files: PendingFile[] | null): boolean => {
    const last = consumedRef.current;
    if (last && last.value === value && last.files === files) {
      return false;
    }
    consumedRef.current = { value, files };
    return true;
  };
  const id = useId();
  const menuId = useId();
  const starting = useApp((s) => Boolean(s.busy["start"]));
  const stopping = useApp((s) => (props.sessionId ? Boolean(s.busy[`stop:${props.sessionId}`]) : false));
  const hasText = text.trim().length > 0;
  const showStop = props.running && Boolean(props.sessionId) && !hasText;
  const shell = !props.readOnly && /^!\s*\S/.test(text);
  const researchMode = useApp((s) => s.researchMode);
  // Research mode takes plain text only; a command or a shell line keeps its own meaning.
  const researching = researchMode && !props.readOnly && !shell && !text.startsWith("/");

  // Files ride along with the next message: Muse sees images itself, anything else lands in the workspace.
  const [files, setFiles] = useState<PendingFile[]>([]);
  const addFiles = (incoming: Iterable<File>) => {
    if (props.readOnly) {
      return;
    }
    void readFiles(incoming).then((read) => setFiles((current) => [...current, ...read].slice(0, MAX_FILES)));
  };
  const removeFile = (id: string) => {
    setFiles((current) => {
      const gone = current.find((file) => file.id === id);
      if (gone?.url) {
        URL.revokeObjectURL(gone.url);
      }
      return current.filter((file) => file.id !== id);
    });
  };

  // The slash menu: which commands match, which row is active, and whether Esc closed it for this word.
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const skills = useApp((s) => (props.cwd ? s.skills[props.cwd] : undefined));
  const slashing = !props.readOnly && text.startsWith("/");
  useEffect(() => {
    if (slashing && props.cwd) {
      void controller.loadSkills(props.cwd);
    }
  }, [slashing, props.cwd, controller]);
  const commands = useMemo(
    () => slashCommands(skills?.skills ?? [], { inThread: Boolean(props.sessionId) }),
    [skills?.skills, props.sessionId],
  );
  // `/model <text>` completes against the same list the model picker shows, read again first if it is stale.
  const { scope: modelScope } = useModelsScope(props.sessionId, props.cwd);
  const modelSource = useModelSource();
  const choosingModel = slashing && /^\/models?\s/i.test(text);
  useEffect(() => {
    if (choosingModel) {
      void controller.refreshModels(modelScope);
    }
  }, [choosingModel, modelScope, controller]);
  const word = /^\/\S*/.exec(text)?.[0] ?? null;
  /** The menu for a caret position. Keys read the caret live: a restored draft moves it without a select event. */
  const menuAt = (at: number): SlashMenuView | null => {
    // A built-in list names few models: while it is the one on show, the models Meta publishes complete as well.
    const view = slashing ? slashMenuOver(text, at, commands, skills, modelSource, modelScope) : null;
    return view && dismissed !== word ? view : null;
  };
  const menu = menuAt(caret);
  const rows = menu?.kind === "list" || menu?.kind === "models" ? menu.items.length : menu ? 1 : 0;
  const activeRow = Math.max(0, Math.min(active, rows - 1));
  const typedModel = menu?.kind === "models" ? menu.query : null;
  useEffect(() => {
    setActive(0);
  }, [word, menu?.kind, menu?.prefix, typedModel]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
    // A draft restored, handed back or filled in puts the caret at the end without a select event.
    setCaret(el.selectionStart);
  }, [text]);

  useEffect(() => {
    const el = ref.current;
    if (props.autoFocus && !props.readOnly && el) {
      el.focus({ preventScroll: true });
      // Focusing puts the caret before a restored draft; carry on typing at its end instead.
      el.setSelectionRange(el.value.length, el.value.length);
      setCaret(el.value.length);
    }
  }, [props.autoFocus, props.readOnly, props.sessionId, props.cwd]);

  const submit = async (steer: boolean) => {
    if ((!hasText && files.length === 0) || props.readOnly || starting) {
      return;
    }
    const value = text;
    const outgoing = files;
    if (!tryConsume(value, outgoing)) {
      return;
    }
    if (researching) {
      // The field is the question: the run takes it and nothing goes to Muse as a turn. Files stay put for a message.
      setText("");
      const state = controller.store.get();
      const started = await controller.research(value, popoverOverrides(state.researchTyped, state.researchSettings?.config ?? null), props.sessionId);
      if (!started) {
        consumedRef.current = null;
        setText(value);
      }
      return;
    }
    setText("");
    setFiles([]);
    const sent = await controller.send(value, {
      steer,
      attachments: outgoing.map(toOutgoing),
      previews: outgoing.map(toPreview),
    });
    if (!sent) {
      consumedRef.current = null;
      setText(value);
      setFiles(outgoing);
    }
  };

  /** Runs a command picked from the menu, or sends the draft as a plain prompt when Muse has no such command. */
  const runNow = async (value: string, raw: boolean) => {
    if (props.readOnly || starting) {
      return;
    }
    if (!tryConsume(value, null)) {
      return;
    }
    setText("");
    const sent = await controller.send(value, { raw });
    if (!sent) {
      consumedRef.current = null;
      setText(value);
    }
  };

  const fillText = (next: string) => {
    setText(next);
    setCaret(next.length);
    requestAnimationFrame(() => {
      const el = ref.current;
      el?.focus();
      el?.setSelectionRange(next.length, next.length);
    });
  };

  const fill = (prefix: string, command: SlashCommand) => fillText(`${prefix}${command.name} `);

  const pick = (view: SlashMenuView, command: SlashCommand) => {
    if (view.prefix === "/" && command.kind === "action" && command.runsBare) {
      void runNow(`/${command.name}`, false);
    } else {
      fill(view.prefix, command);
    }
  };

  /** A model picked from the `/model` completions switches to it, as typing its id would. */
  const pickModel = (model: ModelCompletion) => void runNow(`/model ${model.id}`, false);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const live = menuAt(event.currentTarget.selectionStart);
    if (live) {
      const list = live.kind === "list" || live.kind === "models" ? live.items : [];
      const row = Math.max(0, Math.min(active, list.length - 1));
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && list.length > 0) {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((row + step + list.length) % list.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(word);
        return;
      }
      if (event.key === "Tab" && !event.shiftKey && list[row]) {
        event.preventDefault();
        if (live.kind === "models") {
          fillText(`${live.prefix}${(live.items[row] as ModelCompletion).id}`);
        } else {
          fill(live.prefix, list[row] as SlashCommand);
        }
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        // A held Enter repeats: the first press already picked, so later ones do nothing.
        if (event.repeat) {
          return;
        }
        if (live.kind === "models" && list[row]) {
          pickModel(live.items[row] as ModelCompletion);
        } else if (live.kind === "list" && list[row]) {
          pick(live, list[row] as SlashCommand);
        } else if (live.kind === "unknown") {
          void runNow(text, true);
        } else {
          // Skills are still loading: send anyway, and the controller resolves the command once they arrive.
          void submit(props.running && (event.metaKey || event.ctrlKey));
        }
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      // A held Enter repeats: the first press already sent, so later ones do nothing. Shift+Enter keeps
      // repeating, since holding it for several new lines is deliberate.
      if (event.repeat) {
        return;
      }
      void submit(props.running && (event.metaKey || event.ctrlKey));
    } else if (event.key === "Escape" && props.running && !hasText && props.sessionId) {
      event.preventDefault();
      void controller.stop(props.sessionId);
    }
  };

  const placeholder = props.readOnly
    ? "Read-only while another Muse session has this thread open"
    : researchMode
      ? "What should the workers find out? Enter starts the research"
      : props.running
      ? `Queue a follow-up, or press ${MOD}+Enter to add it to this turn`
      : props.variant === "home"
        ? "Describe a change, a fix, or a question about the code. Use @path to point at files."
        : "Reply, or ask for the next change";

  const sendLabel = showStop ? "Stop the turn" : researching ? "Start the research" : shell ? "Run command" : props.running ? "Queue message" : "Send";

  return (
    <div
      className={cn(
        "composer-surface relative min-w-0 max-w-full bg-raised transition-shadow duration-150 ease-out",
        props.readOnly && "opacity-75",
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          ref.current?.focus();
        }
      }}
      onPaste={(event) => {
        // Only take over the paste when the clipboard actually holds files; pasted text stays text.
        if (event.clipboardData?.files?.length) {
          event.preventDefault();
          addFiles(Array.from(event.clipboardData.files));
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer?.types?.includes("Files")) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        if (event.dataTransfer?.files?.length) {
          event.preventDefault();
          addFiles(Array.from(event.dataTransfer.files));
        }
      }}
    >
      {menu ? (
        <SlashMenu
          id={menuId}
          state={menu}
          placement={props.variant === "home" ? "below" : "above"}
          active={activeRow}
          onActive={setActive}
          onPick={(command) => pick(menu, command)}
          onPickModel={pickModel}
          onSendRaw={() => void runNow(text, true)}
        />
      ) : null}
      <label htmlFor={id} className="sr-only">
        Message Muse
      </label>
      {shell ? (
        <div className="flex items-center gap-1.5 px-4 pt-2.5 text-xs text-muted">
          <TerminalWindowIcon size={13} className="shrink-0" />
          <span className="truncate">
            Ancilla runs this{props.cwd ? ` in ${basename(props.cwd)}` : ""}; the output stays here until you send it to Muse
          </span>
        </div>
      ) : null}
      <AttachmentTray files={files} onRemove={removeFile} />
      <textarea
        id={id}
        ref={ref}
        value={text}
        rows={props.variant === "home" ? 3 : 1}
        disabled={props.readOnly}
        placeholder={placeholder}
        spellCheck
        role={menu ? "combobox" : undefined}
        aria-expanded={menu ? true : undefined}
        aria-controls={menu ? menuId : undefined}
        aria-autocomplete={menu ? "list" : undefined}
        aria-activedescendant={menu ? slashOptionId(menuId, activeRow) : undefined}
        onChange={(event) => {
          setText(event.currentTarget.value);
          setCaret(event.currentTarget.selectionStart);
          if (!event.currentTarget.value.startsWith("/")) {
            setDismissed(null);
          }
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => setDismissed(word)}
        onFocus={() => setDismissed(null)}
        className={cn(
          "block max-h-[40vh] min-h-[52px] w-full min-w-0 max-w-full resize-none overflow-x-hidden bg-transparent px-4 pb-1.5 text-md leading-relaxed text-fg outline-none [field-sizing:fixed] [overflow-wrap:anywhere] whitespace-pre-wrap placeholder:text-subtle focus-visible:outline-none disabled:cursor-not-allowed",
          shell ? "pt-1.5 font-mono text-sm" : "pt-3.5",
        )}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-0.5 px-2 pb-2">
        {/* The new-thread composer sits high, so its menus open downward; they still flip when there is no room. */}
        <AttachButton onFiles={(picked) => addFiles(Array.from(picked))} disabled={props.readOnly || files.length >= MAX_FILES} />
        <ModelPicker sessionId={props.sessionId} cwd={props.cwd} side={props.variant === "home" ? "bottom" : "top"} />
        <ResearchTrigger sessionId={props.sessionId} side={props.variant === "home" ? "bottom" : "top"} disabled={props.readOnly || starting} />
        <EffortPicker sessionId={props.sessionId} cwd={props.cwd} side={props.variant === "home" ? "bottom" : "top"} />
        <AccessPicker sessionId={props.sessionId} side={props.variant === "home" ? "bottom" : "top"} />
        <AccountPicker sessionId={props.sessionId} cwd={props.cwd} variant={props.variant} />
        <span className="min-w-2 flex-1" />
        {props.sessionId ? <SpeedReadout sessionId={props.sessionId} /> : null}
        {props.sessionId ? <CostMeter sessionId={props.sessionId} /> : null}
        {props.sessionId ? <ContextMeter sessionId={props.sessionId} /> : null}
        {props.running && props.sessionId && hasText ? (
          <Tip label="Stop the turn" shortcut={["Esc"]}>
            <IconButton size="md" label="Stop the turn" disabled={stopping} onClick={() => void controller.stop(props.sessionId as string)}>
              <SquareIcon weight="fill" size={11} />
            </IconButton>
          </Tip>
        ) : null}
        <Tip label={sendLabel} shortcut={[showStop ? "Esc" : "Enter"]}>
          <button
            type="button"
            aria-label={showStop ? "Stop the turn" : researching ? "Start the research" : shell ? "Run command" : props.running ? "Queue message" : "Send message"}
            disabled={showStop ? stopping : (!hasText && files.length === 0) || props.readOnly || starting}
            onClick={() => (showStop ? void controller.stop(props.sessionId as string) : void submit(false))}
            className={cn(
              "ml-1 inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-[transform,background-color,color] duration-150 active:scale-95",
              showStop ? "bg-inverse text-inverse-fg" : "bg-brand text-brand-fg hover:bg-brand-hover disabled:bg-active disabled:text-subtle",
            )}
          >
            <SwapIcon value={starting || stopping ? "busy" : showStop ? "stop" : researching ? "research" : "send"}>
              {starting || stopping ? (
                <Spinner size={13} />
              ) : showStop ? (
                <SquareIcon weight="fill" size={11} />
              ) : researching ? (
                <BinocularsIcon size={15} />
              ) : (
                <ArrowUpIcon size={16} />
              )}
            </SwapIcon>
          </button>
        </Tip>
      </div>
    </div>
  );
}

const ToolbarTrigger = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { icon: ReactNode; label: ReactNode; tone?: "warn" }
>(function ToolbarTrigger({ icon, label, tone, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cn(
        "inline-flex h-7 max-w-[240px] min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted transition-colors duration-100 hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg",
        tone === "warn" && "text-warn-text hover:text-warn-text",
        className,
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex min-w-0 items-center truncate">{label}</span>
      <CaretDownIcon size={12} className="shrink-0 opacity-60" />
    </button>
  );
});

/** Marks contributor-tier models. In menus the option's description explains it; elsewhere a tooltip does. */
function ContributorBadge(props: { tip?: boolean }) {
  const badge = <span className="shrink-0 rounded-[5px] bg-warn-soft px-1 py-px text-2xs font-medium text-warn-text">Contributor</span>;
  return props.tip ? <Tip label="Your chats may be used to improve Meta's products">{badge}</Tip> : badge;
}

/** Which way a composer menu opens: away from the screen edge the composer sits against. */
type PickerSide = "top" | "bottom";

/** Marks the catalog's default row, the one "Muse default" follows. */
function DefaultBadge() {
  return <span className="shrink-0 rounded-[5px] bg-active px-1 py-px text-2xs font-medium text-muted">Default</span>;
}

/** One row of the model menu: its name and tags, and a line under it about what the row is. */
function ModelRow(props: { choice: ModelChoice }) {
  const { choice } = props;
  return (
    <MenuOption
      value={choiceValue(choice)}
      label={
        <>
          {choice.label}
          {choice.displayLabel ? <span className="ml-2 font-normal text-muted">{choice.displayLabel}</span> : null}
        </>
      }
      badge={
        <>
          {choice.isDefault ? <DefaultBadge /> : null}
          {choice.kind !== "default" && choice.contributor ? <ContributorBadge /> : null}
          {choice.note ? (
            <span className="shrink-0 rounded-[5px] bg-warn-soft px-1 py-px text-2xs font-medium text-warn-text">
              {choice.note === "unavailable" ? "Unavailable" : "Not offered"}
            </span>
          ) : null}
        </>
      }
      description={choiceDetail(choice) ?? undefined}
    />
  );
}

/** A text field for a model id Muse did not list, shared by the picker's dialog and Settings. */
export function ModelIdForm(props: {
  onUse: (modelId: string) => Promise<boolean>;
  onDone?: () => void;
  onCancel?: () => void;
  label?: string;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const id = useId();
  const typed = text.trim();
  const problem = typed ? modelIdError(typed) : null;
  const submit = async () => {
    if (busy || !typed || problem) {
      return;
    }
    setBusy(true);
    try {
      if (await props.onUse(typed)) {
        setText("");
        props.onDone?.();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex min-w-0 flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {props.label ?? "Model id"}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          placeholder={publishedModelIds()[0] ?? "model-id"}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={problem !== null}
          className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-sunken px-3 font-mono text-xs text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus"
        />
        {props.onCancel ? (
          <Button size="sm" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button size="sm" variant="primary" type="submit" disabled={!typed || problem !== null} loading={busy}>
          Use model
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="text-xs text-warn-text">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

/** What the model menu says and offers besides its rows: the load, the notes, and the actions that read the list again. */
function ModelMenuBody(props: { menu: ModelMenu; scope: ModelsScope; onOther: () => void }) {
  const controller = useController();
  const { menu } = props;
  // Closing Muse's hosts also ends what outlives a turn (a workflow, a subagent, a background task, a research run).
  const running = useApp(anyWorkRunning);
  const restarting = useApp((s) => Boolean(s.busy["models:restart"]));
  const restart = restartAction(running, restarting);
  const value = selectedValue(menu.rows);
  const choose = (next: string) => {
    if (next !== value) {
      applyModelChoice(controller, next);
    }
  };
  const read = () => void controller.refreshModels({ ...props.scope, force: true });
  return (
    <>
      <MenuLabel>Model</MenuLabel>
      {menu.message ? (
        menu.mode === "loading" ? (
          <div role="status" className="flex items-center gap-2 px-2 pt-1 pb-2 text-xs text-muted">
            <Spinner size={12} />
            {menu.message}
          </div>
        ) : (
          <p role={menu.mode === "error" ? "alert" : undefined} className="px-2 pb-1.5 text-xs text-muted [overflow-wrap:anywhere]">
            {menu.message}
          </p>
        )
      ) : null}
      {menu.mode === "error" ? (
        <MenuItem icon={<ArrowsClockwiseIcon size={14} />} keepOpen onSelect={read}>
          {MODEL_COPY.retry}
        </MenuItem>
      ) : null}
      {menu.signIn ? (
        <MenuItem icon={<SignInIcon size={14} />} onSelect={() => void controller.beginLogin(menu.signIn?.id ?? null)}>
          {MODEL_COPY.signInAction}
        </MenuItem>
      ) : null}
      {menu.notes.map((note) => (
        <p key={note} className="px-2 pb-1.5 text-xs text-subtle [overflow-wrap:anywhere]">
          {note}
        </p>
      ))}
      {menu.showRows ? (
        <MenuRadioGroup value={value} onValueChange={choose}>
          {menu.rows.map((choice) => (
            <ModelRow key={`${choice.kind}:${choice.id ?? ""}`} choice={choice} />
          ))}
          {menu.published.length > 0 ? <MenuLabel>{MODEL_COPY.published}</MenuLabel> : null}
          {menu.published.map((published) => (
            <MenuOption key={published.id} value={published.id} label={published.label} description={MODEL_COPY.notListed} />
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
          onSelect={read}
        >
          {MODEL_COPY.refresh}
        </MenuItem>
      ) : null}
      {controller.client.restartHosts ? (
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
      ) : null}
    </>
  );
}

export function ModelPicker(props: { sessionId: string | null; cwd: string | null; side: PickerSide }) {
  const controller = useController();
  const open = useApp((s) => s.picker === "model");
  const { scope, accountId } = useModelsScope(props.sessionId, props.cwd);
  const source = useModelSource();
  const current = useThreadModel(props.sessionId);
  const preferred = useApp((s) => s.prefs.defaultModelId);
  const tried = useApp((s) => s.prefs.defaultModelTried);
  const plan = useApp((s) => planAccount(s, accountId).planName);
  const [typing, setTyping] = useState(false);
  // A thread whose model Muse has not said yet runs on Muse's default, whatever the saved default is. A saved default
  // the user tried by its id is kept: it is shown as not in Muse's list, never as unavailable.
  const menu = modelMenu(source, { scope, accountId, current, pref: props.sessionId && !current ? null : preferred, plan, tried });
  const { trigger } = menu;
  return (
    <>
      <Menu
        open={open}
        onOpenChange={(next) => {
          if (next) {
            controller.setPicker("model");
            // The picker's own list, whichever scope the controller thinks is on screen; a fresh one is left be.
            void controller.refreshModels(scope);
          } else {
            controller.closePicker("model");
          }
        }}
      >
        <MenuTrigger asChild>
          <ToolbarTrigger
            aria-label={modelButtonLabel(trigger)}
            icon={<CpuIcon size={13} />}
            tone={trigger.note ? "warn" : undefined}
            label={
              <>
                <span className="truncate">{trigger.name}</span>
                {/* A long name gives way before the reason the model cannot be chosen again does. */}
                {trigger.note ? <span className="ml-1 shrink-0">({trigger.note})</span> : null}
                {trigger.contributor ? (
                  <span className="ml-1.5">
                    <ContributorBadge tip />
                  </span>
                ) : null}
              </>
            }
          />
        </MenuTrigger>
        <MenuContent side={props.side} className="w-[330px]">
          <ModelMenuBody menu={menu} scope={scope} onOther={() => setTyping(true)} />
        </MenuContent>
      </Menu>
      <Modal
        open={typing}
        onOpenChange={setTyping}
        title="Use another model"
        description="Type the id of a model Muse did not list. Muse checks access when you send a prompt."
      >
        <div className="mt-4">
          <ModelIdForm onUse={(modelId) => tryTypedModel(controller, modelId)} onDone={() => setTyping(false)} onCancel={() => setTyping(false)} />
        </div>
      </Modal>
    </>
  );
}

/**
 * Sets the project's default account for new threads (`startThread` reads `project.defaultAccountId`); no
 * transient state of its own. Shows only on the new-thread composer, and only once accounts exist. On an
 * existing thread the account is fixed at spawn and shown by the sidebar badge instead.
 */
function AccountPicker(props: { sessionId: string | null; cwd: string | null; variant: "thread" | "home" }) {
  const controller = useController();
  const accounts = useApp((s) => s.accounts);
  const open = useApp((s) => s.picker === "account");
  // The thread may start in any folder of a project; the account is the project's.
  const project = useApp((s) => projectForCwd(s.projects, props.cwd));
  const current = project?.defaultAccountId ?? null;
  if (props.sessionId !== null || !project || !(accounts && accounts.length > 0)) {
    return null;
  }
  const label = accounts.find((a) => a.id === current)?.name ?? "Default login";
  return (
    <Menu open={open} onOpenChange={(next) => (next ? controller.setPicker("account") : controller.closePicker("account"))}>
      <MenuTrigger asChild>
        <ToolbarTrigger aria-label={`Account: ${label}`} icon={<UserIcon size={13} />} label={<span className="truncate">{label}</span>} />
      </MenuTrigger>
      <MenuContent side={props.variant === "home" ? "bottom" : "top"} className="w-[300px]">
        <MenuLabel>Account</MenuLabel>
        <MenuRadioGroup
          value={current ?? ""}
          onValueChange={(value) => void controller.setProjectDefaultAccount(project.cwd, value || null)}
        >
          <MenuOption value="" label="Default login" />
          {accounts.map((a) => (
            <MenuOption key={a.id} value={a.id} label={a.name} description={a.hasLogin ? (a.email ?? "Signed in") : "Not signed in"} />
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/** The popover's number fields: the same small box as the Settings rows, right-aligned so the digits line up. */
const RESEARCH_FIELD = "h-7 w-14 rounded-md bg-sunken px-2 text-right text-xs text-fg tabular-nums outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus";

/**
 * Starts a DeepResearch run on the composer's draft, or on a question typed in the popover when the draft is
 * empty. The run is the thread's, so one at a time: the trigger says why it is off instead of going quiet. The
 * knobs offered per run show the Settings defaults and post only what was typed over them, inside the daemon's
 * limits; everything else is the server's to fill in.
 */
/**
 * The Research control: a toggle that arms research mode, so the composer's field becomes the question and Send
 * starts a run, and a chevron that opens the run's options. Other harnesses toggle a mode and take the question from
 * the usual field; this does the same rather than asking twice.
 */
function ResearchTrigger(props: { sessionId: string | null; side: PickerSide; disabled: boolean }) {
  const controller = useController();
  const open = useApp((s) => s.picker === "research");
  const armed = useApp((s) => s.researchMode);
  const settings = useApp((s) => s.researchSettings);
  const stopWrites = useApp((s) => s.researchStopWrites);
  const typed = useApp((s) => s.researchTyped);
  const live = useApp((s) => (props.sessionId ? (s.threads[props.sessionId]?.researchRuns.some(researchLive) ?? false) : false));
  const minId = useId();
  const maxId = useId();
  const parallelId = useId();
  const switchId = useId();
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const defaults = settings?.config ?? null;
  const off = settings?.enabled === false;
  const reason = off ? "Deep research is off in Settings" : live ? "A research run is already going in this thread" : null;
  const disabled = props.disabled || reason !== null;
  // An untouched field shows the loaded default, and nothing until the settings have loaded: a number made up here
  // would go out as an override.
  const shown = (field: keyof ResearchTyped, fallback: number | undefined) => typed[field] ?? (fallback === undefined ? "" : String(fallback));
  const type = (field: keyof ResearchTyped, value: string) => controller.setResearchTyped({ [field]: value });
  // Leaving a field settles it inside the daemon's limits, where the server would put it anyway; emptied, it shows
  // the default again and sends nothing.
  const settle = (field: keyof ResearchTyped, range: ResearchRange, step = 1) => {
    if (typed[field] === null) return;
    const value = clampResearchNumber(typed[field], range, step);
    controller.setResearchTyped({ [field]: value === null ? null : String(value) });
  };
  const toggle = (
    <button
      type="button"
      aria-pressed={armed}
      aria-label={reason ? `Deep research: ${reason}` : armed ? "Research mode on: Send starts a run" : "Research mode"}
      disabled={disabled}
      onClick={() => controller.setResearchMode(!armed)}
      className={cn(
        "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-l-lg px-2 text-xs font-medium transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50",
        armed ? "bg-accent-soft text-accent-text hover:bg-accent-soft" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <BinocularsIcon size={13} className="shrink-0" />
      <span className="truncate">Research</span>
    </button>
  );
  const chevron = (
    <button
      type="button"
      aria-label="Research options"
      disabled={disabled}
      className={cn(
        "inline-flex h-7 items-center rounded-r-lg pr-1.5 pl-0.5 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-hover data-[state=open]:text-fg",
        armed ? "bg-accent-soft text-accent-text" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <CaretDownIcon size={12} className="shrink-0 opacity-60" />
    </button>
  );
  const group = (
    <span className="inline-flex items-stretch rounded-lg">
      {toggle}
      <Popover.Trigger asChild>{chevron}</Popover.Trigger>
    </span>
  );
  return (
    <Popover.Root open={open && !disabled} onOpenChange={(next) => (next ? controller.setPicker("research") : controller.closePicker("research"))}>
      {reason ? (
        <Tip label={reason}>
          <span tabIndex={0} className="inline-flex rounded-lg">
            {group}
          </span>
        </Tip>
      ) : (
        <Tip label={armed ? "Research mode is on: type the question and press Enter" : "Research mode: type a question, and Send has Muse workers research it into a cited report"} shortcut={[MOD, "Shift", "R"]}>
          {group}
        </Tip>
      )}
      <Popover.Portal>
        <Popover.Content
          side={props.side}
          align="start"
          sideOffset={6}
          {...FLOATING}
          onOpenAutoFocus={(event) => {
            // Straight to the first option; the help button would otherwise take focus and show its tip.
            event.preventDefault();
            firstFieldRef.current?.focus();
          }}
          className="pop z-[var(--z-dropdown)] w-[340px] max-w-[calc(100dvw-24px)] rounded-xl bg-raised p-3.5 text-fg shadow-pop outline-none"
        >
          <div className="flex items-center gap-2">
            <BinocularsIcon size={14} className="text-muted" />
            <span className="text-sm font-semibold text-fg">Deep research</span>
            <span className="flex-1" />
            <Tip label="Muse workers search the web in parallel, read what they find, and a writer turns their notes into a report whose citations only name pages a worker actually opened. Every model call and search runs through Muse on your plan.">
              <button type="button" aria-label="What deep research does" className="-m-1 rounded-full p-1 text-subtle transition-colors duration-100 hover:text-fg">
                <QuestionIcon size={15} />
              </button>
            </Tip>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Switch Research on, type the question in the message field, and Send starts the run. These are the run's options.
          </p>
          <div className="mt-3 grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-2 text-sm">
            <label htmlFor={minId} className="text-muted">
              Research window, minutes
            </label>
            <input
              id={minId}
              ref={firstFieldRef}
              type="number"
              min={RESEARCH_LIMITS.windowMinutes.min}
              max={RESEARCH_LIMITS.windowMinutes.max}
              step={WINDOW_STEP}
              value={shown("windowMin", defaults?.windowMinMinutes)}
              placeholder={defaults ? undefined : "…"}
              onChange={(event) => type("windowMin", event.currentTarget.value)}
              onBlur={() => settle("windowMin", RESEARCH_LIMITS.windowMinutes, WINDOW_STEP)}
              aria-label="Window minimum, minutes"
              className={RESEARCH_FIELD}
            />
            <input
              id={maxId}
              type="number"
              min={RESEARCH_LIMITS.windowMinutes.min}
              max={RESEARCH_LIMITS.windowMinutes.max}
              step={WINDOW_STEP}
              value={shown("windowMax", defaults?.windowMaxMinutes)}
              placeholder={defaults ? undefined : "…"}
              onChange={(event) => type("windowMax", event.currentTarget.value)}
              onBlur={() => settle("windowMax", RESEARCH_LIMITS.windowMinutes, WINDOW_STEP)}
              aria-label="Window maximum, minutes"
              className={RESEARCH_FIELD}
            />
            <label htmlFor={parallelId} className="text-muted">
              Parallel workers
            </label>
            <input
              id={parallelId}
              type="number"
              min={RESEARCH_LIMITS.parallel.min}
              max={RESEARCH_LIMITS.parallel.max}
              step={1}
              value={shown("parallel", defaults?.maxParallel)}
              placeholder={defaults ? undefined : "…"}
              onChange={(event) => type("parallel", event.currentTarget.value)}
              onBlur={() => settle("parallel", RESEARCH_LIMITS.parallel)}
              aria-label="Parallel workers"
              className={cn(RESEARCH_FIELD, "col-span-2 justify-self-end")}
            />
          </div>
          <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
            <label htmlFor={switchId} className="min-w-0 flex-1 cursor-default text-sm text-fg">
              Stop writes a report from what it has
            </label>
            <Toggle id={switchId} checked={stopWrites} label="Stop writes a report from what it has" onChange={(on) => controller.setResearchStopWrites(on)} />
          </div>
          <p className="mt-3 text-xs text-subtle">Runs on your Muse plan; {props.sessionId ? "the report lands in this thread" : "the run starts a thread for its report"}.</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Effort levels on the faster-to-smarter scale. Auto sits outside it: Muse picks per turn. */
export const LEVELS: { value: ReasoningEffort; label: string; description: string }[] = [
  { value: "none", label: "Off", description: "Answers right away, without reasoning" },
  { value: "minimal", label: "Minimal", description: "A quick think before answering" },
  { value: "low", label: "Low", description: "Light reasoning for simple changes" },
  { value: "medium", label: "Medium", description: "Balanced speed and depth" },
  { value: "high", label: "High", description: "Thinks harder problems through" },
  { value: "xhigh", label: "Extra high", description: "Deep reasoning for tricky work" },
  // No Ultra: Muse Code 1.3.0 sends "ultra" to the model as "max", and the CLI stopped offering it.
  { value: "max", label: "Max", description: "The slowest and most thorough" },
];
// Where the slider rests while Auto is on and nothing was picked yet: Medium.
const RESTING: ReasoningEffort = "medium";

/**
 * Reasoning effort as a stepped slider in a popover. The stops are the levels the plan's list gives the model, so
 * Off and Max appear only where Muse offers them (a built-in list never narrows them); a level the model lacks is
 * shown as the nearest one it has, and the choice itself is kept for the next model.
 */
export function EffortPicker(props: { sessionId: string | null; cwd: string | null; side: PickerSide }) {
  const controller = useController();
  const open = useApp((s) => s.picker === "effort");
  const effort = useApp((s) => s.prefs.effort);
  const { scope } = useModelsScope(props.sessionId, props.cwd);
  const source = useModelSource();
  const current = useThreadModel(props.sessionId);
  const preferred = useApp((s) => s.prefs.defaultModelId);
  const model = activeModel(source, scope, current, props.sessionId && !current ? null : preferred);
  const [resting, setResting] = useState<ReasoningEffort>(RESTING);
  const thumb = useRef<HTMLSpanElement>(null);
  const switchId = useId();
  const { levels, auto, shown, position } = effortView(model, effort, LEVELS, resting);
  const top = Math.max(levels.length - 1, 1);
  const label = shown ? effortLabel(shown) : "Auto";
  const ultra = shown === "max";
  const note = effortNote(effort, shown);
  const choose = (index: number) => {
    const level = levels[index];
    if (level) {
      setResting(level.value);
      controller.setEffort(level.value);
    }
  };
  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? controller.setPicker("effort") : controller.closePicker("effort"))}>
      <Popover.Trigger asChild>
        <ToolbarTrigger aria-label={`Reasoning effort: ${label}`} icon={<BrainIcon size={13} />} label={label} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={props.side}
          align="start"
          sideOffset={6}
          {...FLOATING}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            thumb.current?.focus();
          }}
          className="pop z-[var(--z-dropdown)] w-[300px] max-w-[calc(100dvw-24px)] rounded-xl bg-raised p-3.5 text-fg shadow-pop outline-none"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">Effort</span>
            <span className={cn("text-sm font-semibold", ultra ? "text-accent-text" : "text-fg")}>{label}</span>
            <span className="flex-1" />
            <Tip label="Higher effort thinks longer for more thorough answers, but each turn takes more time.">
              <button
                type="button"
                aria-label="What effort does"
                className="-m-1 rounded-full p-1 text-subtle transition-colors duration-100 hover:text-fg"
              >
                <QuestionIcon size={15} />
              </button>
            </Tip>
          </div>
          <div className="mt-4 flex justify-between text-xs text-subtle">
            <span>Faster</span>
            <span>Smarter</span>
          </div>
          <Slider.Root
            min={0}
            max={top}
            step={1}
            value={[position]}
            disabled={levels.length < 2}
            onValueChange={([index]) => {
              if (index !== undefined) {
                choose(index);
              }
            }}
            aria-label="Reasoning effort"
            className={cn("effort-slider relative mt-2 flex h-8 touch-none items-center select-none", auto && "opacity-60")}
          >
            <Slider.Track className="relative h-full grow overflow-hidden rounded-lg bg-active">
              <Slider.Range className={cn("effort-range absolute h-full overflow-hidden", ultra ? "bg-accent-soft" : "bg-fg/15")}>
                {ultra ? <PixelFlow className="text-accent-text" /> : null}
              </Slider.Range>
              {/* One dot per level, inset by half the thumb so each sits exactly where the thumb stops. */}
              {ultra ? null : (
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-[9px] left-[9px]">
                  {levels.map((level, index) => (
                    <span
                      key={level.value}
                      className="absolute top-1/2 size-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg/30"
                      style={{ left: `${(index / top) * 100}%` }}
                    />
                  ))}
                </span>
              )}
            </Slider.Track>
            <Slider.Thumb
              ref={thumb}
              aria-valuetext={levels[position]?.label}
              className="block h-6 w-[18px] rounded-md bg-white shadow-[0_0_0_1px_oklch(0_0_0/0.08),0_1px_3px_oklch(0_0_0/0.3)] outline-none transition-transform duration-100 ease-out focus-visible:ring-2 focus-visible:ring-focus active:scale-95"
            />
          </Slider.Root>
          <p className={cn("mt-2 text-xs", auto ? "text-subtle" : "text-muted")}>
            {auto ? "Muse picks the effort for each turn" : levels[position]?.description}
          </p>
          {note ? <p className="mt-1 text-xs text-subtle">{note}</p> : null}
          <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
            <label htmlFor={switchId} className="min-w-0 flex-1 cursor-default text-sm text-fg">
              Let Muse decide
            </label>
            <Switch.Root
              id={switchId}
              checked={auto}
              onCheckedChange={(on) => controller.setEffort(on ? null : (levels[position]?.value ?? "medium"))}
              className="relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-line-strong outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus data-[state=checked]:bg-accent"
            >
              <Switch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/0.3)] transition-transform duration-150 ease-out data-[state=checked]:translate-x-4" />
            </Switch.Root>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export const MODES: { value: ApprovalMode; label: string; description: string; icon: ReactNode }[] = [
  { value: "onRequest", label: "Ask first", description: "Muse asks before anything that needs approval.", icon: <ShieldIcon size={14} /> },
  {
    value: "promptUnmatched",
    label: "Ask for unlisted",
    description: "Commands your rules allow just run; anything else asks.",
    icon: <ShieldChevronIcon size={14} />,
  },
  {
    value: "denyUnmatched",
    label: "Deny unlisted",
    description: "Commands your rules allow just run; anything else is refused.",
    icon: <LockIcon size={14} />,
  },
  {
    value: "allowAll",
    label: "Full access",
    description: "Every tool runs without asking. Only for sandboxes.",
    icon: <ShieldWarningIcon size={14} />,
  },
];

function AccessPicker(props: { sessionId: string | null; side: PickerSide }) {
  const controller = useController();
  const open = useApp((s) => s.picker === "permissions");
  // `/permissions full` opens the confirmation directly, so it lives in app state rather than here.
  const confirming = useApp((s) => s.picker === "confirmFullAccess");
  const bypass = useApp((s) => s.bypassAll);
  const confirmingBypass = useApp((s) => s.picker === "confirmBypass");
  const bypassId = useId();
  const yolo = useApp((s) => s.yoloSettings?.enabled === true);
  const yoloLoaded = useApp((s) => s.yoloSettings !== null);
  const confirmingYolo = useApp((s) => s.picker === "confirmYolo");
  const yoloId = useId();
  const preferred = useApp((s) => s.prefs.defaultMode);
  const threadMode = useApp((s) => (props.sessionId ? (s.threads[props.sessionId]?.fold.meta.approvalMode ?? null) : null));
  const current = (props.sessionId ? threadMode : null) ?? preferred;
  const mode = MODES.find((m) => m.value === current) ?? MODES[0];
  const setConfirming = (next: boolean) => (next ? controller.setPicker("confirmFullAccess") : controller.closePicker("confirmFullAccess"));
  return (
    <>
      <Menu open={open} onOpenChange={(next) => (next ? controller.setPicker("permissions") : controller.closePicker("permissions"))}>
        <MenuTrigger asChild>
          <ToolbarTrigger
            aria-label={yolo ? "Permissions: YOLO mode" : `Permissions: ${mode?.label}`}
            icon={yolo ? <LightningIcon size={14} /> : mode?.icon}
            label={yolo ? "YOLO" : mode?.label}
            tone={yolo || current === "allowAll" || bypass ? "warn" : undefined}
          />
        </MenuTrigger>
        <MenuContent side={props.side} className="w-[300px]">
          <MenuLabel>Permissions</MenuLabel>
          {/* The `muse --yolo` posture: no approvals, no sandbox, trusted workspace. Above the modes because it owns them while on. */}
          <div className="flex items-start gap-3 px-2 pt-1 pb-2.5">
            <label htmlFor={yoloId} className="min-w-0 flex-1 cursor-default">
              <span className="flex items-center gap-1.5 text-sm text-fg">
                <LightningIcon size={14} className="text-warn-text" aria-hidden="true" />
                YOLO mode
              </span>
              <span className="block text-xs text-muted">Nothing asks, new threads run unsandboxed. Restarts Muse hosts.</span>
            </label>
            <Switch.Root
              id={yoloId}
              checked={yolo}
              disabled={!yoloLoaded}
              onCheckedChange={(on) => (on ? controller.setPicker("confirmYolo") : void controller.setYoloEnabled(false))}
              className="relative mt-0.5 inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-line-strong outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 data-[state=checked]:bg-accent"
            >
              <Switch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/0.3)] transition-transform duration-150 ease-out data-[state=checked]:translate-x-4" />
            </Switch.Root>
          </div>
          <MenuRadioGroup
            value={current}
            onValueChange={(value) => {
              if (value === "allowAll") {
                setConfirming(true);
              } else {
                void controller.setMode(value as ApprovalMode);
              }
            }}
          >
            {MODES.map((m) => (
              <MenuOption key={m.value} value={m.value} icon={m.icon} label={m.label} description={m.description} disabled={yolo} />
            ))}
          </MenuRadioGroup>
          {yolo ? <p className="px-2 pt-1 text-xs text-subtle">YOLO owns every thread&apos;s mode while it is on. Switch it off to choose.</p> : null}
          {/* Muse asks whenever it cannot resolve a command's argv, whatever mode it is in. This answers those. */}
          <div className="mt-1 flex items-start gap-3 border-t border-line px-2 pt-2.5 pb-1">
            <label htmlFor={bypassId} className="min-w-0 flex-1 cursor-default">
              <span className="block text-sm text-fg">Answer approvals for me</span>
              <span className="block text-xs text-muted">Allowed once each, in every thread, until you close Ancilla.</span>
            </label>
            <Switch.Root
              id={bypassId}
              checked={bypass}
              onCheckedChange={(on) => (on ? controller.setPicker("confirmBypass") : controller.setBypassAll(false))}
              className="relative mt-0.5 inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-line-strong outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus data-[state=checked]:bg-accent"
            >
              <Switch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/0.3)] transition-transform duration-150 ease-out data-[state=checked]:translate-x-4" />
            </Switch.Root>
          </div>
        </MenuContent>
      </Menu>
      <Modal
        open={confirming}
        onOpenChange={setConfirming}
        title="Give Muse full access?"
        description="Every tool call, including shell commands and file writes, will run without asking you first. The OS sandbox still confines shells unless this thread started while sandboxing was switched off, or with YOLO mode on, in Settings. Use this only in a disposable environment."
      >
        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setConfirming(false);
              controller.navigate({ kind: "settings" });
            }}
          >
            Settings
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Keep asking
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirming(false);
              void controller.setMode("allowAll");
            }}
          >
            Allow full access
          </Button>
        </div>
      </Modal>
      <Modal
        open={confirmingBypass}
        onOpenChange={(next) => (next ? controller.setPicker("confirmBypass") : controller.closePicker("confirmBypass"))}
        title="Answer approvals for you?"
        description="Every approval Muse raises, in any thread, is allowed once without showing you the command first. Muse asks about the commands it could not resolve, so these are the ones nothing else has checked. This lasts until you close Ancilla."
      >
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => controller.closePicker("confirmBypass")}>
            Keep asking
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              controller.closePicker("confirmBypass");
              controller.setBypassAll(true);
            }}
          >
            Answer them for me
          </Button>
        </div>
      </Modal>
      <Modal
        open={confirmingYolo}
        onOpenChange={(next) => (next ? controller.setPicker("confirmYolo") : controller.closePicker("confirmYolo"))}
        title="Turn on YOLO mode?"
        description="Like muse --yolo: nothing asks for approval in any thread, new threads run without sandbox confinement, and workspaces are trusted. The running Muse hosts restart, interrupting their turns, and threads already open keep the sandbox posture they started with. This stays on until you switch it off."
      >
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => controller.closePicker("confirmYolo")}>
            Keep asking
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              controller.closePicker("confirmYolo");
              void controller.setYoloEnabled(true);
            }}
          >
            Turn on YOLO
          </Button>
        </div>
      </Modal>
    </>
  );
}

/** Output speed beside the context ring: an estimate while text streams, else the last turn's measured speed. */
function SpeedReadout(props: { sessionId: string }) {
  const controller = useController();
  const running = useApp((s) => Boolean(s.threads[props.sessionId]?.fold.activeTurnId));
  const last = useApp((s) => {
    const fold = s.threads[props.sessionId]?.fold;
    const speed = fold ? lastTurnSpeed(fold) : null;
    return speed ? { tps: speed.tokensPerSecond, tokens: speed.outputTokens, ms: speed.generationMs } : null;
  }, shallowEqual);
  const live = useSampled(() => {
    const fold = controller.store.get().threads[props.sessionId]?.fold;
    return fold?.activeTurnId ? streamingSpeed(fold.turns[fold.activeTurnId]) : null;
  }, running);
  if (running && live !== null) {
    return (
      <Tip label="Estimated from the text streaming now">
        <span tabIndex={0} className="shrink-0 px-1 text-2xs text-subtle tabular-nums">
          ~{formatSpeed(live)}
        </span>
      </Tip>
    );
  }
  if (!last) {
    return null;
  }
  return (
    <Tip label={`Last turn: ${formatTokens(last.tokens)} output tokens over ${formatDuration(last.ms)} of model calls`}>
      <span tabIndex={0} className="shrink-0 px-1 text-2xs text-subtle tabular-nums">
        {formatSpeed(last.tps)}
      </span>
    </Tip>
  );
}

export function ComposerFooter(props: { cwd: string | null; branch: string | null; running: boolean }) {
  return (
    <div className="flex h-8 items-center gap-3 px-2 text-xs text-subtle">
      {props.cwd ? (
        <Tip label={props.cwd} side="top" align="start">
          <span className="flex min-w-0 items-center gap-1.5" tabIndex={0}>
            <FolderIcon size={12} className="shrink-0" />
            <span className="truncate">{basename(props.cwd)}</span>
          </span>
        </Tip>
      ) : null}
      {props.branch ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <GitBranchIcon size={12} className="shrink-0" />
          <span className="truncate font-mono text-2xs">{props.branch}</span>
        </span>
      ) : null}
      <span className="flex-1" />
      <span className="hidden truncate md:inline">
        {props.running
          ? `Enter queues, ${MOD}+Enter adds to this turn, Esc stops`
          : "Enter to send, Shift+Enter for a new line, / for commands, ! for shell"}
      </span>
    </div>
  );
}
