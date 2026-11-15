import { ArrowLineDownIcon, ArrowsInIcon, CaretRightIcon, ChatCircleDotsIcon, FileMagnifyingGlassIcon, FilePlusIcon, FileTextIcon, GlobeIcon, ListChecksIcon, MagnifyingGlassIcon, PaperPlaneRightIcon, PencilSimpleLineIcon, RobotIcon, StopCircleIcon, TargetIcon, TerminalWindowIcon, TreeStructureIcon, WarningCircleIcon, WrenchIcon } from "../ui/icons.js";
import { Popover } from "radix-ui";
import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp, useController } from "../../app/context.js";
import { fileTarget } from "../../model/files.js";
import { basename, describeTool, diffLines, diffStats, extractDiff, formatDuration, formatTokens, humanize, lastLine, mergeDiffLines, parseArgs, withoutDiffEcho, type DiffLine, type DiffView, type ToolKind } from "../../model/format.js";
import type { MspItem, OutputRef, SubagentAction, UserInputAnswer } from "../../types.js";
import { CodeBlock, Markdown, highlightCode, languageFromPath } from "../ui/Markdown.js";
import { Button, IconButton, Shimmer, Spinner, cn } from "../ui/primitives.js";
import { Collapse } from "../ui/sourced.js";
import { FLOATING, Tip } from "../ui/overlays.js";

const ANSI_COLOR_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const FAILURE_STATUS_KEYS = new Set(["failed", "rejected", "cancelled", "timedOut"]);
const MAX_OUTPUT_PAGE_BYTES = 4 * 1024 * 1024;

export type Gate = "approval" | "input";

export interface StoredOutput { sessionId: string; itemId: string; ref: OutputRef; }

function getToolGlyph(kind: ToolKind, size = 14): ReactNode {
  switch (kind) {
    case "shell": return <TerminalWindowIcon size={size} />;
    case "read": return <FileTextIcon size={size} />;
    case "edit": return <PencilSimpleLineIcon size={size} />;
    case "write": return <FilePlusIcon size={size} />;
    case "search": return <MagnifyingGlassIcon size={size} />;
    case "list": return <TreeStructureIcon size={size} />;
    case "web": return <GlobeIcon size={size} />;
    case "question": return <ChatCircleDotsIcon size={size} />;
    case "plan": return <ListChecksIcon size={size} />;
    case "agent": return <RobotIcon size={size} />;
    case "goal": return <TargetIcon size={size} />;
    default: return <WrenchIcon size={size} />;
  }
}

interface ItemRowLayoutProps { icon: ReactNode; label: ReactNode; chip?: ReactNode; mono?: boolean; detail?: ReactNode; trailing?: ReactNode; body?: ReactNode; preview?: ReactNode; tone?: "default" | "warn" | "danger"; defaultOpen?: boolean; actions?: ReactNode; }

function ItemDisclosureRow({ icon, label, chip, mono, detail, trailing, body, preview, tone = "default", defaultOpen = false, actions }: ItemRowLayoutProps) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const canExpand = Boolean(body);

  const headerButton = (
    <button
      type="button"
      disabled={!canExpand}
      aria-expanded={canExpand ? expanded : undefined}
      onClick={() => setExpanded((curr) => !curr)}
      className={cn("group/row flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-lg px-1.5 text-left transition-colors duration-100 enabled:hover:bg-hover disabled:cursor-default", actions ? "flex-1" : "-mx-1.5 w-[calc(100%+0.75rem)]")}>
      <span className={cn("relative flex size-4 shrink-0 items-center justify-center", tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : "text-subtle")}>
        <span className={cn("flex transition-opacity duration-100", canExpand && (expanded ? "opacity-0" : "group-hover/row:opacity-0 group-focus-visible/row:opacity-0"))}>{icon}</span>
        {canExpand && <CaretRightIcon size={13} className={cn("absolute text-subtle opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/row:opacity-100 group-focus-visible/row:opacity-100", expanded && "rotate-90 opacity-100")} />}
      </span>
      <span className={cn("shrink-0 text-sm font-medium", tone === "danger" ? "text-danger-text" : "text-fg")}>{label}</span>
      {chip && <span className={cn("min-w-0 truncate rounded-md bg-sunken px-1.5 py-[3px] text-xs leading-4 text-muted shadow-[0_0_0_1px_var(--border)]", mono && "font-mono text-[11.5px]")}>{chip}</span>}
      {detail && <span className="min-w-0 truncate text-sm text-subtle">{detail}</span>}
      <span className="min-w-2 flex-1" />
      {trailing}
    </button>
  );

  return <div className="enter-up">{actions ? <div className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-1">{headerButton}<div className="flex shrink-0 items-center gap-0.5 pr-0.5">{actions}</div></div> : headerButton}{!expanded && preview && <div className="ml-6 pb-1">{preview}</div>}{canExpand && <Collapse open={expanded}><div className="mt-0.5 mb-2 ml-[7px] flex flex-col gap-2 border-l border-line py-0.5 pl-[17px]">{body}</div></Collapse>}</div>;
}

function prettyBytes(val: number): string {
  if (val < 1024) return `${val} B`;
  if (val < 1048576) return `${Math.round(val / 1024)} KB`;
  return `${(val / 1048576).toFixed(1)} MB`;
}

export function OutputBlock(props: { text: string; truncated?: boolean; label?: string; stored?: StoredOutput | null }) {
  const ctrl = useController();
  const [paginated, setPaginated] = useState<{ text: string; next: number; eof: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const activeContent = paginated ? paginated.text : props.text;
  const sanitized = useMemo(() => activeContent.replace(ANSI_COLOR_REGEX, "").replace(/\s+$/, ""), [activeContent]);

  if (!sanitized) return null;

  const validStored = props.truncated && props.stored?.ref.availability !== "unavailable" ? props.stored : null;

  const handleFetchMore = async () => {
    if (!validStored || loading) return;
    setLoading(true);
    setErr(null);
    try {
      let accumulated = paginated?.text ?? "";
      let curOffset = paginated?.next ?? 0;
      let finished = false;
      const stopTarget = MAX_OUTPUT_PAGE_BYTES + curOffset;

      while (!finished && curOffset < stopTarget) {
        const chunk = await ctrl.readOutput(validStored.sessionId, validStored.itemId, validStored.ref.id, curOffset);
        accumulated += chunk.encoding === "base64" ? "[binary output]" : chunk.content;
        curOffset = chunk.offsetBytes + chunk.byteLen;
        finished = chunk.eof || chunk.byteLen === 0;
      }
      setPaginated({ text: accumulated, next: curOffset, eof: finished });
    } catch (fault) {
      setErr(fault instanceof Error ? fault.message : String(fault));
    } finally {
      setLoading(false);
    }
  };

  const totalByteLength = validStored?.ref.byteLen;

  return <div className="overflow-hidden rounded-lg bg-sunken shadow-[0_0_0_1px_var(--border)]">{props.label && <div className="px-3 pt-2 font-sans text-2xs font-medium text-subtle">{props.label}</div>}<pre className="max-h-72 overflow-x-hidden overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{sanitized}</pre>{props.truncated && !paginated?.eof && (<div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-1.5"><p className="min-w-0 flex-1 text-2xs text-subtle">{err ? <span className="text-danger-text">{err}</span> : paginated ? `Showing the first ${prettyBytes(paginated.next)}${totalByteLength ? ` of ${prettyBytes(totalByteLength)}` : ""}.` : validStored ? `Output was trimmed here${totalByteLength ? `; the full log is ${prettyBytes(totalByteLength)}` : ""}.` : "Output was trimmed here; the full log is in the Muse session."}</p>{validStored && <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" loading={loading} onClick={() => void handleFetchMore()}>{paginated ? "Show more" : "Show full output"}</Button>}</div>)}</div>;
}

function resolveStoredOutput(item: MspItem, sid?: string): StoredOutput | null {
  const ref = item.outputRef;
  return sid && item.truncated && ref && typeof ref.id === "string" ? { sessionId: sid, itemId: item.itemId, ref } : null;
}

function OpenFileAction({ sessionId, path }: { sessionId: string; path: string }) {
  const ctrl = useController();
  const rootDir = useApp((s) => s.sessions[sessionId]?.cwd ?? null);
  const target = rootDir ? fileTarget(path, rootDir) : null;
  if (!target) return null;

  return <Tip label="Open in files"><IconButton size="sm" label={`Open ${target.path}`} onClick={() => ctrl.openFile(sessionId, target.path, target.line)}><FileMagnifyingGlassIcon size={13} /></IconButton></Tip>;
}

function ToolTaskActions({ item, sessionId }: { item: MspItem; sessionId: string }) {
  const ctrl = useController();
  const isReadOnly = useApp((s) => s.threads[sessionId]?.readOnly ?? true);
  const isProcessing = useApp((s) => Boolean(s.busy[`task:${sessionId}:${item.itemId}`]));

  if (isReadOnly || item.status !== "inProgress") return null;

  return item.background ? (
    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" loading={isProcessing} onClick={() => void ctrl.taskAction(sessionId, "stop", item.itemId)}>
      <StopCircleIcon size={12} /> Stop
    </Button>
  ) : (
    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" loading={isProcessing} title="Let this keep running while Muse moves on" onClick={() => void ctrl.taskAction(sessionId, "background", item.itemId)}>
      <ArrowLineDownIcon size={12} /> Background
    </Button>
  );
}

export function DiffCount({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-2xs tabular-nums">
      <span className="text-ok-text">+{added}</span> <span className="text-danger-text">-{removed}</span>
    </span>
  );
}

const HighlightedDiffLine = memo(function HighlightedDiffLine({ text, language }: { text: string; language: string | null }) {
  const renderedHtml = useMemo(() => highlightCode(text, language), [text, language]);
  if (renderedHtml === null) return <>{text || " "}</>;
  return <span dangerouslySetInnerHTML={{ __html: renderedHtml }} />;
});

function DiffDisplayContainer({ lines, language }: { lines: DiffLine[]; language: string | null }) {
  return <div className="overflow-hidden rounded-lg bg-sunken shadow-[0_0_0_1px_var(--border)]"><div className="max-h-80 overflow-x-hidden overflow-y-auto py-1 font-mono text-xs leading-[1.65]">{lines.map((line, idx) => (<div key={idx} className={cn("flex pr-3", line.kind === "add" && "bg-diff-add", line.kind === "del" && "bg-diff-del", line.kind === "meta" && "text-subtle")}><span className={cn("w-6 shrink-0 text-center select-none", line.kind === "add" ? "text-ok-text" : line.kind === "del" ? "text-danger-text" : "text-subtle")} aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span><span className={cn("min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]", line.kind === "ctx" || line.kind === "meta" ? "text-muted" : "text-fg")}>{line.kind === "meta" ? (line.text || " ") : <HighlightedDiffLine text={line.text} language={language} />}</span></div>))}</div></div>;
}

export function DiffBlock(props: { diff: DiffView }) {
  return <DiffDisplayContainer lines={diffLines(props.diff)} language={languageFromPath(props.diff.path)} />;
}

interface ConsolidatedFileDiff { path: string; added: number; removed: number; diffs: DiffView[]; }

export function DiffChips(props: { entries: MspItem[]; className?: string; sessionId?: string }) {
  const groupedFiles = useMemo(() => {
    const fileMap = new Map<string, ConsolidatedFileDiff>();
    for (const entry of props.entries) {
      if (entry.kind !== "toolCall") continue;
      const diffView = extractDiff(entry);
      if (!diffView) continue;
      const targetPath = diffView.path ?? entry.itemId;
      const metrics = diffStats(diffView);
      const record = fileMap.get(targetPath) ?? { path: diffView.path ?? "file", added: 0, removed: 0, diffs: [] };
      record.added += metrics.added;
      record.removed += metrics.removed;
      record.diffs.push(diffView);
      fileMap.set(targetPath, record);
    }
    return Array.from(fileMap.values());
  }, [props.entries]);

  if (groupedFiles.length === 0) return null;

  return <div className={cn("flex max-w-full flex-wrap gap-1.5", props.className)} aria-label="Files changed">{groupedFiles.map((f) => <InteractiveDiffChip key={f.path} file={f} sessionId={props.sessionId} />)}</div>;
}

function InteractiveDiffChip({ file, sessionId }: { file: ConsolidatedFileDiff; sessionId?: string }) {
  const ctrl = useController();
  const rootDir = useApp((s) => (sessionId ? (s.sessions[sessionId]?.cwd ?? null) : null));
  const fileRef = rootDir ? fileTarget(file.path, rootDir) : null;
  const [popoverActive, setPopoverActive] = useState(false);
  const hoverTimer = useRef<number | null>(null);

  const openPopover = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    setPopoverActive(true);
  };
  const closePopover = () => {
    hoverTimer.current = window.setTimeout(() => setPopoverActive(false), 140);
  };

  return <Popover.Root open={popoverActive} onOpenChange={setPopoverActive}><Popover.Trigger asChild><button type="button" onMouseEnter={openPopover} onMouseLeave={closePopover} title={file.path} className="inline-flex h-7 max-w-full items-center gap-2 rounded-lg bg-raised px-2 font-mono text-[11.5px] text-fg shadow-btn transition-colors duration-100 hover:bg-hover data-[state=open]:bg-hover"><PencilSimpleLineIcon size={12} className="shrink-0 text-subtle" /><span className="min-w-0 truncate">{basename(file.path)}</span><DiffCount added={file.added} removed={file.removed} /></button></Popover.Trigger><Popover.Portal><Popover.Content side="bottom" align="start" sideOffset={6} {...FLOATING} onMouseEnter={openPopover} onMouseLeave={closePopover} onOpenAutoFocus={(evt) => evt.preventDefault()} className="pop z-[var(--z-dropdown)] flex max-h-[60vh] w-[min(560px,calc(100dvw-32px))] flex-col gap-2 overflow-y-auto rounded-xl bg-raised p-2 shadow-pop outline-none">{fileRef && sessionId && (<div className="flex items-center justify-between gap-2 px-1"><span className="min-w-0 truncate font-mono text-2xs text-subtle">{fileRef.path}</span><Button size="sm" variant="ghost" className="h-6 shrink-0 px-2 text-xs" onClick={() => { setPopoverActive(false); ctrl.openFile(sessionId, fileRef.path); }}><FileMagnifyingGlassIcon size={12} /> Open file</Button></div>)}<DiffDisplayContainer lines={mergeDiffLines(file.diffs)} language={languageFromPath(file.diffs[0]?.path ?? null)} /></Popover.Content></Popover.Portal></Popover.Root>;
}

function QuestionPromptAnswers({ item, answers }: { item: MspItem; answers: UserInputAnswer[] | null }) {
  const parsedArgs = parseArgs(item.args);
  const qList = parsedArgs && Array.isArray(parsedArgs["questions"]) ? (parsedArgs["questions"] as Record<string, unknown>[]) : [];

  return <div className="flex flex-col gap-2 text-sm">{qList.map((entry, idx) => { const questionKey = typeof entry["id"] === "string" ? entry["id"] : String(idx); const matchAnswer = answers?.find((ans) => ans.questionId === questionKey); const resolvedText = matchAnswer?.selectedLabel ?? matchAnswer?.selectedLabels?.join(", ") ?? matchAnswer?.freeText ?? null; return (<div key={questionKey}><p className="text-muted">{typeof entry["question"] === "string" ? entry["question"] : "Question"}</p><p className="mt-0.5 font-medium text-fg">{resolvedText ?? (answers ? "Skipped" : "Waiting for your answer")}</p></div>); })}</div>;
}

export const ToolRow = memo(function ToolRow({ item, gate, answers, sessionId }: { item: MspItem; gate?: Gate; answers?: UserInputAnswer[] | null; sessionId?: string }) {
  const descriptor = useMemo(() => describeTool(item), [item]);
  const activeDiff = useMemo(() => (descriptor.kind === "edit" || descriptor.kind === "write" ? extractDiff(item) : null), [descriptor.kind, item]);
  const isInFlight = item.status === "inProgress";
  const isTerminatedWithFault = FAILURE_STATUS_KEYS.has(item.status);
  const diffMetrics = activeDiff ? diffStats(activeDiff) : null;
  const rawArgs = parseArgs(item.args);

  let statusOrnament: ReactNode = null;
  if (gate) {
    statusOrnament = <span className="shrink-0 text-xs font-medium text-warn-text">{gate === "approval" ? "Waiting for approval" : "Waiting for your answer"}</span>;
  } else if (isInFlight) {
    statusOrnament = item.background ? (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-subtle">
        <Spinner size={12} className="text-accent-text" label="Running in the background" /> In the background
      </span>
    ) : <Spinner size={12} className="text-accent-text" label="Running" />;
  } else if (isTerminatedWithFault) {
    statusOrnament = <span className="shrink-0 text-xs text-danger-text">{humanize(item.status)}</span>;
  } else if (diffMetrics) {
    statusOrnament = <DiffCount added={diffMetrics.added} removed={diffMetrics.removed} />;
  }

  const payloadElements: ReactNode[] = [];
  if (descriptor.note) {
    payloadElements.push(<p key="desc-note" className="text-xs text-muted">{descriptor.note}</p>);
  }

  if (descriptor.kind === "question") {
    payloadElements.push(<QuestionPromptAnswers key="prompt-q" item={item} answers={answers ?? null} />);
  } else {
    if (descriptor.kind === "shell" && descriptor.subject && descriptor.subject.includes("\n")) {
      payloadElements.push(<CodeBlock key="cmd-block" code={descriptor.subject} language="bash" className="my-0" />);
    }
    if (activeDiff) {
      payloadElements.push(<DiffBlock key="diff-view" diff={activeDiff} />);
    }
    if (item.visibleOutput) {
      const trimmedEcho = activeDiff && (descriptor.kind === "edit" || descriptor.kind === "write") && !item.truncated ? withoutDiffEcho(item.visibleOutput) : null;
      const textToRender = trimmedEcho ?? item.visibleOutput;
      if (textToRender.trim().length > 0) {
        payloadElements.push(
          <OutputBlock
            key="out-block"
            text={textToRender}
            truncated={item.truncated}
            label={descriptor.kind === "shell" ? "Output" : undefined}
            stored={resolveStoredOutput(item, sessionId)}
          />
        );
      }
    }
    if (descriptor.kind === "generic" && rawArgs) {
      payloadElements.push(<CodeBlock key="args-json" code={JSON.stringify(rawArgs, null, 2)} language="json" className="my-0" />);
    }
  }

  if (item.failureReason) {
    payloadElements.push(
      <p key="err-alert" className="flex items-start gap-1.5 text-xs text-danger-text">
        <WarningCircleIcon size={13} className="mt-px shrink-0" /> {item.failureReason}
      </p>
    );
  }

  const livePreview = isInFlight && descriptor.kind === "shell" ? lastLine(item.visibleOutput) : null;

  return (
    <ItemDisclosureRow
      icon={getToolGlyph(descriptor.kind, 14)}
      tone={gate ? "warn" : isTerminatedWithFault ? "danger" : "default"}
      label={descriptor.verb}
      chip={descriptor.subject ? descriptor.subject.split("\n")[0] : undefined}
      mono={descriptor.mono}
      trailing={statusOrnament}
      body={payloadElements.length > 0 ? payloadElements : undefined}
      preview={livePreview ? <p className="truncate font-mono text-2xs text-subtle">{livePreview}</p> : undefined}
      actions={
        sessionId && isInFlight && !gate ? (
          <ToolTaskActions item={item} sessionId={sessionId} />
        ) : sessionId && !isInFlight && (descriptor.kind === "read" || descriptor.kind === "edit" || descriptor.kind === "write") && descriptor.subject ? (
          <OpenFileAction sessionId={sessionId} path={descriptor.subject.split("\n")[0]!} />
        ) : undefined
      }
    />
  );
});

export const ReasoningRow = memo(function ReasoningRow({ item }: { item: MspItem }) {
  const thoughts = (item.summary ?? []).filter((frag) => frag.trim().length > 0);
  const narrative = thoughts.length > 0 ? thoughts.join("\n\n") : (item.text ?? "");
  const inProgress = item.status === "inProgress";
  const primaryTitle = (thoughts[thoughts.length - 1] ?? narrative).split("\n").find((str) => str.trim())?.replace(/\*\*/g, "") ?? "";

  return <ItemDisclosureRow icon={inProgress ? <Spinner size={11} /> : <span className="size-1.5 rounded-full bg-[var(--border-strong)]" />} label={inProgress ? <Shimmer>Thinking</Shimmer> : <span className="text-muted">Thought</span>} detail={primaryTitle || undefined} body={narrative ? <Markdown text={narrative} className="text-sm text-muted" /> : undefined} />;
});

function RequestAgentExecutionButton({ sessionId, command }: { sessionId: string; command: string }) {
  const ctrl = useController();
  const [submitting, setSubmitting] = useState(false);

  const handleClick = () => {
    if (submitting) return;
    setSubmitting(true);
    void ctrl.askToRun(sessionId, command).finally(() => setSubmitting(false));
  };

  return <Button size="sm" variant="secondary" loading={submitting} onClick={handleClick}>Ask Muse to run it</Button>;
}

export const ShellRow = memo(function ShellRow({ item, sessionId }: { item: MspItem; sessionId?: string }) {
  const inProgress = item.status === "inProgress";
  const returnCode = item.exitCode;
  const executionFailed = (returnCode !== undefined && returnCode !== 0) || FAILURE_STATUS_KEYS.has(item.status);
  const sandboxUnavailable = executionFailed && /shell sandbox is unavailable/i.test(item.visibleOutput ?? "");

  const trailingBadge = inProgress ? (
    <Spinner size={12} className="text-accent-text" label="Running" />
  ) : returnCode !== undefined && returnCode !== 0 ? (
    <span className="text-xs text-danger-text">Exit {returnCode}</span>
  ) : executionFailed ? (
    <span className="text-xs text-danger-text">Not run</span>
  ) : item.durationMs ? (
    <span className="text-2xs text-subtle tabular-nums">{formatDuration(item.durationMs)}</span>
  ) : null;

  const rowContent = item.visibleOutput ? (
    <>
      <OutputBlock text={item.visibleOutput} truncated={item.truncated} stored={resolveStoredOutput(item, sessionId)} />
      {sandboxUnavailable && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="text-xs text-pretty text-muted">Muse can't sandbox <code className="font-mono">!</code> commands when Ancilla hosts it, so this one never started. The agent's own shell works.</p>
          {sessionId && item.commandText && <RequestAgentExecutionButton sessionId={sessionId} command={item.commandText} />}
        </div>
      )}
    </>
  ) : undefined;

  return <ItemDisclosureRow icon={<TerminalWindowIcon size={14} />} label="You ran" chip={item.commandText ?? "a command"} mono defaultOpen tone={executionFailed ? "danger" : "default"} trailing={trailingBadge} body={rowContent} />;
});

function SubagentActionControls({ item, sessionId, subagentId }: { item: MspItem; sessionId: string; subagentId: string }) {
  const ctrl = useController();
  const isThreadReadOnly = useApp((s) => s.threads[sessionId]?.readOnly ?? true);
  const operationBusy = useApp((s) => Boolean(s.busy[`subagent:${sessionId}:${subagentId}`]));
  const [promptMessage, setPromptMessage] = useState("");

  if (isThreadReadOnly) return null;

  const childStatus = item.controlStatus ?? "";
  const isActive = item.status === "inProgress" || childStatus === "running" || childStatus === "starting";

  const dispatchSubagentCommand = (verb: SubagentAction, payload?: string) => {
    void ctrl.subagentAction(sessionId, verb, subagentId, payload).then((success) => {
      if (success && payload) setPromptMessage("");
    });
  };

  const handleFormSubmit = () => {
    const trimmed = promptMessage.trim();
    if (trimmed) dispatchSubagentCommand(isActive ? "sendMessage" : "followupTask", trimmed);
  };

  return (
    <div className="flex flex-col gap-2">
      <form className="flex items-center gap-1.5" onSubmit={(evt) => { evt.preventDefault(); handleFormSubmit(); }}><input value={promptMessage} onChange={(evt) => setPromptMessage(evt.target.value)} disabled={operationBusy} aria-label={isActive ? "Message this subagent" : "Give this subagent a follow-up task"} placeholder={isActive ? "Tell this subagent something" : "Give it a follow-up task"} className="h-7 min-w-0 flex-1 rounded-md bg-sunken px-2 text-sm text-fg shadow-[0_0_0_1px_var(--border)] outline-none placeholder:text-subtle focus-visible:shadow-[0_0_0_1px_var(--focus-ring)]" /><Button type="submit" size="sm" variant="secondary" disabled={!promptMessage.trim()} loading={operationBusy}><PaperPlaneRightIcon size={12} /> Send</Button></form><div className="flex flex-wrap items-center gap-1">{isActive && (<><Button size="sm" variant="ghost" disabled={operationBusy} onClick={() => dispatchSubagentCommand("interrupt")}>Pause at next step</Button><Button size="sm" variant="ghost" disabled={operationBusy} onClick={() => dispatchSubagentCommand("stop")}><StopCircleIcon size={13} /> Stop</Button></>)}{childStatus === "resultReady" && <Button size="sm" variant="ghost" disabled={operationBusy} onClick={() => dispatchSubagentCommand("readResult")}>Take the result</Button>}{childStatus === "recoveryPending" && <Button size="sm" variant="ghost" disabled={operationBusy} onClick={() => dispatchSubagentCommand("resume")}>Resume</Button>}{!isActive && (childStatus === "closed" || FAILURE_STATUS_KEYS.has(item.status)) && <Button size="sm" variant="ghost" disabled={operationBusy} onClick={() => dispatchSubagentCommand("reopen")}>Reopen</Button>}{!isActive && childStatus !== "closed" && childStatus !== "closing" && <Button size="sm" variant="ghost" disabled={operationBusy} onClick={() => dispatchSubagentCommand("close")}>Close</Button>}</div>
    </div>
  );
}

export const SubagentRow = memo(function SubagentRow({ item, sessionId }: { item: MspItem; sessionId?: string }) {
  const isWorking = item.status === "inProgress";
  const outcomeText = item.result?.summary ?? item.result?.text ?? null;
  const subagentPanel = sessionId && item.subagentId ? <SubagentActionControls item={item} sessionId={sessionId} subagentId={item.subagentId} /> : null;

  const usageBadge = isWorking ? (
    <Spinner size={12} className="text-accent-text" label="Running" />
  ) : item.usage?.outputTokens ? (
    <span className="text-2xs text-subtle tabular-nums">{formatTokens((item.usage.inputTokens ?? 0) + item.usage.outputTokens)} tokens</span>
  ) : null;

  return <ItemDisclosureRow icon={<RobotIcon size={14} />} label={isWorking ? "Subagent working on" : "Subagent"} detail={item.objective ?? item.role ?? "a task"} tone={FAILURE_STATUS_KEYS.has(item.status) ? "danger" : "default"} trailing={usageBadge} body={(outcomeText || item.failureReason || subagentPanel) ? (<>{outcomeText && <Markdown text={outcomeText} className="text-sm" />}{item.failureReason && <p className="text-xs text-danger-text">{item.failureReason}</p>}{subagentPanel}</>) : undefined} />;
});

export function CompactionRow({ item }: { item: MspItem }) {
  const isCompacting = item.status === "inProgress";
  const savedDifference = item.tokensBefore !== undefined && item.tokensAfter !== undefined ? `${formatTokens(item.tokensBefore)} to ${formatTokens(item.tokensAfter)} tokens` : null;
  const bannerHeadline = isCompacting ? "Compacting context" : item.outcome === "noop" ? "Nothing to compact" : item.outcome === "failed" ? "Context compaction failed" : "Context compacted";

  return <div className="my-1 flex items-center gap-3 text-xs text-subtle" role="note"><span className="h-px flex-1 bg-line" /><span className="flex items-center gap-1.5">{isCompacting ? <Spinner size={10} /> : <ArrowsInIcon size={12} />}{bannerHeadline}{savedDifference && <span className="tabular-nums">({savedDifference})</span>}</span><span className="h-px flex-1 bg-line" /></div>;
}

export function GenericRow({ item }: { item: MspItem }) {
  return <ItemDisclosureRow icon={<WrenchIcon size={14} />} label={humanize(item.kind)} detail={item.fallbackText} trailing={item.status === "inProgress" ? <Spinner size={12} /> : null} body={item.text ? <Markdown text={item.text} className="text-sm" /> : undefined} />;
}

export function SteerBubble({ item }: { item: MspItem }) {
  const steerContent = item.displayText ?? item.text;
  return <div className="enter-up flex flex-col items-end gap-1"><span className="text-2xs font-medium text-subtle">You added</span><div className="max-w-[85%] rounded-2xl rounded-tr-md bg-active px-3.5 py-2 text-sm whitespace-pre-wrap text-fg">{steerContent}</div></div>;
}

export function AgentText({ item, streaming }: { item: MspItem; streaming?: boolean }) {
  return <Markdown text={item.text ?? ""} stream={streaming} className={cn(streaming && "streaming")} />;
}
