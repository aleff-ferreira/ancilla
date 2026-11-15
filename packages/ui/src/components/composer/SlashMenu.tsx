import { ArrowElbowDownLeftIcon, ArrowsInIcon, BinocularsIcon, BookOpenIcon, BrainIcon, ClockCounterClockwiseIcon, CpuIcon, FileTextIcon, GitForkIcon, NotePencilIcon, ShieldIcon, TargetIcon } from "../ui/icons.js";
import { useEffect, type ReactNode } from "react";
import { modelCompletionNote, type ModelCompletion } from "../../model/models.js";
import type { SlashAction, SlashCommand } from "../../model/slash.js";
import { Spinner, cn } from "../ui/primitives.js";

export type SlashMenuState = { kind: "list"; items: SlashCommand[]; loading: boolean; error: string | null } | { kind: "models"; items: ModelCompletion[]; query: string } | { kind: "unknown"; name: string } | { kind: "loading" };

export type SlashMenuProps = { active: number; id: string; placement: "above" | "below"; state: SlashMenuState; onActive: (index: number) => void; onPick: (command: SlashCommand) => void; onPickModel: (model: ModelCompletion) => void; onSendRaw: () => void; };

export function slashOptionId(menuId: string, index: number): string {
  return `${menuId}-option-${index}`;
}

const OPTION_ROW_STYLE = "flex min-h-9 cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm select-none";

function resolveActionIcon(action?: SlashAction | null): ReactNode {
  switch (action) {
    case "compact": return <ArrowsInIcon size={14} />;
    case "model": return <CpuIcon size={14} />;
    case "effort": return <BrainIcon size={14} />;
    case "permissions": return <ShieldIcon size={14} />;
    case "fork": return <GitForkIcon size={14} />;
    case "new": return <NotePencilIcon size={14} />;
    case "resume": return <ClockCounterClockwiseIcon size={14} />;
    case "init": return <FileTextIcon size={14} />;
    case "goal": return <TargetIcon size={14} />;
    case "research": return <BinocularsIcon size={14} />;
    default: return <BookOpenIcon size={14} />;
  }
}

function resolveScopeTag(scope?: string): string | null {
  if (scope === "user") return "Personal";
  if (scope === "project") return "Project";
  if (scope === "plugin") return "Plugin";
  return null;
}

export function SlashMenu(props: SlashMenuProps) {
  const { state, active, id, placement, onActive, onPick, onPickModel, onSendRaw } = props;

  useEffect(() => {
    const el = document.getElementById(slashOptionId(id, active));
    el?.scrollIntoView({ block: "nearest" });
  }, [id, active, state]);

  const hasMixedSections = state.kind === "list" && state.items.some((i) => i.kind === "action") && state.items.some((i) => i.kind === "skill");
  const positionClass = placement === "above" ? "bottom-full mb-2" : "top-full mt-2";
  const ariaLabel = state.kind === "models" ? "Models" : "Commands and skills";

  return (
    <div
      id={id}
      role="listbox"
      aria-label={ariaLabel}
      onMouseDown={(e) => e.preventDefault()}
      className={cn("@container absolute inset-x-0 z-[var(--z-dropdown)] flex max-h-[min(380px,48vh)] flex-col overflow-hidden rounded-xl bg-raised text-fg shadow-pop", positionClass)}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {state.kind === "list" && (
          state.items.map((cmd, idx) => (
            <CommandOptionRow
              key={`${cmd.kind}:${cmd.name}`}
              menuId={id}
              index={idx}
              command={cmd}
              isSelected={idx === active}
              showSectionHeader={hasMixedSections && (idx === 0 || state.items[idx - 1]?.kind !== cmd.kind)}
              onHover={() => onActive(idx)}
              onSelect={() => onPick(cmd)}
            />
          ))
        )}

        {state.kind === "models" && (
          state.items.map((entry, idx) => (
            <ModelOptionRow
              key={entry.id}
              menuId={id}
              index={idx}
              model={entry}
              isSelected={idx === active}
              onHover={() => onActive(idx)}
              onSelect={() => onPickModel(entry)}
            />
          ))
        )}

        {state.kind === "list" && state.loading && (
          <div role="presentation" className="flex items-center gap-2 px-2 py-2 text-xs text-muted">
            <Spinner size={12} /> Loading skills
          </div>
        )}

        {state.kind === "list" && !state.loading && state.error && (
          <p role="presentation" className="px-2 py-1.5 text-xs text-muted [overflow-wrap:anywhere]">
            Skills did not load: {state.error}
          </p>
        )}

        {state.kind === "unknown" && (
          <UnknownFallbackRow menuId={id} name={state.name} onSend={onSendRaw} />
        )}

        {state.kind === "loading" && (
          <div id={slashOptionId(id, 0)} role="option" aria-selected aria-disabled className={cn(OPTION_ROW_STYLE, "text-muted")}>
            <Spinner size={12} /> Loading skills
          </div>
        )}
      </div>

      <MenuFooterShortcuts stateKind={state.kind} />
    </div>
  );
}

function CommandOptionRow({
  menuId,
  index,
  command,
  isSelected,
  showSectionHeader,
  onHover,
  onSelect,
}: {
  menuId: string;
  index: number;
  command: SlashCommand;
  isSelected: boolean;
  showSectionHeader: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const scopeTag = command.skill ? resolveScopeTag(command.skill.scope) : null;
  const sectionTitle = command.kind === "action" ? "Commands" : "Skills";

  return (
    <div role="presentation">
      {showSectionHeader && (
        <header role="presentation" className="px-2 pt-1.5 pb-1 text-xs font-medium text-subtle">
          {sectionTitle}
        </header>
      )}
      <div
        id={slashOptionId(menuId, index)}
        role="option"
        aria-selected={isSelected}
        title={command.skill ? command.skill.description : undefined}
        onMouseMove={onHover}
        onClick={onSelect}
        className={cn(OPTION_ROW_STYLE, isSelected && "bg-hover")}
      >
        <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted">
          {resolveActionIcon(command.action)}
        </span>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 font-medium">/{command.name}</span>
          {command.hint && <span className="shrink-0 text-xs text-subtle">{command.hint}</span>}
          <span className="min-w-0 truncate text-xs text-muted">{command.description}</span>
        </div>
        {scopeTag && <span className="shrink-0 text-2xs text-subtle">{scopeTag}</span>}
      </div>
    </div>
  );
}

function ModelOptionRow({
  menuId,
  index,
  model,
  isSelected,
  onHover,
  onSelect,
}: {
  menuId: string;
  index: number;
  model: ModelCompletion;
  isSelected: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const noteText = modelCompletionNote(model);

  return (
    <div
      id={slashOptionId(menuId, index)}
      role="option"
      aria-selected={isSelected}
      onMouseMove={onHover}
      onClick={onSelect}
      className={cn(OPTION_ROW_STYLE, isSelected && "bg-hover")}
    >
      <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted"><CpuIcon size={14} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate font-medium">{model.label}</span>
          {model.detail && <span className="shrink-0 text-xs text-muted @max-[440px]:hidden">{model.detail}</span>}
        </div>
        {noteText && <span className="block text-xs leading-snug text-pretty text-muted [overflow-wrap:anywhere]">{noteText}</span>}
      </div>
      {model.isDefault && <span className="shrink-0 rounded-[5px] bg-active px-1 py-px text-2xs font-medium text-muted">Default</span>}
      {model.contributor && <span className="shrink-0 rounded-[5px] bg-warn-soft px-1 py-px text-2xs font-medium text-warn-text">Contributor</span>}
    </div>
  );
}

function UnknownFallbackRow({ menuId, name, onSend }: { menuId: string; name: string; onSend: () => void }) {
  return (
    <div id={slashOptionId(menuId, 0)} role="option" aria-selected onClick={onSend} className={cn(OPTION_ROW_STYLE, "bg-hover")}>
      <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted"><ArrowElbowDownLeftIcon size={14} /></span>
      <span className="min-w-0 flex-1 truncate">
        No command named <span className="font-medium">/{name}</span>
      </span>
      <span className="shrink-0 text-xs text-subtle">Send as a prompt</span>
    </div>
  );
}

function MenuFooterShortcuts({ stateKind }: { stateKind: SlashMenuState["kind"] }) {
  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-1.5 text-2xs text-subtle">
      {stateKind === "list" && (
        <span className="inline-flex items-center gap-3">
          <span className="shrink-0">Enter to run</span>
          <span className="shrink-0">Tab to fill in</span>
        </span>
      )}
      {stateKind === "models" && (
        <span className="inline-flex items-center gap-3">
          <span className="shrink-0">Enter to switch</span>
          <span className="shrink-0">Tab to fill in</span>
        </span>
      )}
      {stateKind === "unknown" && <span className="shrink-0">Enter to send as a prompt</span>}
      <span className="shrink-0">Esc to close</span>
    </footer>
  );
}
