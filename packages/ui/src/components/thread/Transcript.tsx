import { ArrowCounterClockwiseIcon, ArrowDownIcon, CaretRightIcon, ClockCounterClockwiseIcon, NotePencilIcon, SquareIcon, TerminalWindowIcon, WarningCircleIcon, XIcon } from "../ui/icons.js";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { useApp, useController, useNow } from "../../app/context.js";
import { useSampled } from "../../app/sampled.js";
import type { AncillaController } from "../../model/controller.js";
import { buildTurns, type EchoAttachment, type LocalEcho, type ThreadFold, type TurnView } from "../../model/fold.js";
import { describeTool, formatClock, formatDuration, formatFullDate, formatSpeed, formatTokens, parseArgs, toolKind } from "../../model/format.js";
import { streamingSpeed, turnCosts, turnSpeeds, type TurnCost, type TurnSpeed } from "../../model/usage.js";
import { turnCostLabel, turnCostTip } from "../../model/usage-labels.js";
import { stuckThread } from "../../model/errors.js";
import type { ThreadState } from "../../model/store.js";
import type { AttachmentView, MspItem, OutgoingAttachment, ShellRun, UserInputAnswer } from "../../types.js";
import { CodeBlock, FileLinksContext, type FileLinks } from "../ui/Markdown.js";
import { fileTarget } from "../../model/files.js";
import { newestReportedRun } from "../../model/research.js";
import { SentAttachments, refetchAttachments, toOutgoing, toPreview } from "../composer/attachments.js";
import { CopyButton } from "../ui/Markdown.js";
import { Tip } from "../ui/overlays.js";
import { Button, IconButton, Shimmer, Spinner, cn } from "../ui/primitives.js";
import { Collapse, PixelLoader } from "../ui/sourced.js";
import { AgentText, CompactionRow, DiffChips, GenericRow, ReasoningRow, ShellRow, SteerBubble, SubagentRow, ToolRow, type Gate } from "./items.js";
import { CrewAnchorRow } from "../crew/CrewAnchorRow.js";
import { ResearchRunRow } from "./ResearchRunRow.js";

type GateMapping = Record<string, Gate>;
type AnswerMapping = Record<string, UserInputAnswer[]>;

function buildGateMapping(f: ThreadFold): GateMapping {
  const res: GateMapping = {};
  for (const app of Object.values(f.approvals)) { if (app.itemId) res[app.itemId] = "approval"; }
  for (const inp of Object.values(f.userInputs)) { if (inp.itemId) res[inp.itemId] = "input"; }
  return res;
}

function buildAnswerMapping(f: ThreadFold): AnswerMapping {
  const res: AnswerMapping = {};
  for (const [key, val] of Object.entries(f.settled)) { res[key] = val.answers; }
  return res;
}

function parseTimestamp(val?: string): number | null {
  if (!val) return null;
  const parsed = Date.parse(val);
  return Number.isNaN(parsed) ? null : parsed;
}

function extractSentTimestamp(t: TurnView): number | null {
  return parseTimestamp(t.prompt?.recordedAt) ?? t.info?.startedAt ?? null;
}

function extractCompletedTimestamp(t: TurnView): number | null {
  return t.info?.completedAt ?? parseTimestamp(t.final?.recordedAt) ?? parseTimestamp(t.entries[t.entries.length - 1]?.recordedAt);
}

function calculateTurnDuration(t: TurnView): number | null {
  const i = t.info;
  if (!i) return null;
  if (i.durationMs !== undefined) return i.durationMs;
  if (i.startedAt !== undefined && i.completedAt !== undefined) return i.completedAt - i.startedAt;
  return null;
}

function areItemListsIdentical(a: MspItem[], b: MspItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let idx = 0; idx < a.length; idx += 1) { if (a[idx] !== b[idx]) return false; }
  return true;
}

function resolveEchoDispositionLabel(disposition: LocalEcho["disposition"]): string {
  switch (disposition) {
    case "sending": return "Sending";
    case "started": return "Sent";
    case "queued": return "Queued";
    case "steered": return "Adding to the current turn";
    default: return "No answer yet. Checking whether it was sent";
  }
}

type FilePayloadPack = { attachments: OutgoingAttachment[]; previews: EchoAttachment[] };

async function readAttachedFilesAgain(ctrl: AncillaController, files: AttachmentView[], cb: (pack: FilePayloadPack) => Promise<unknown> | void): Promise<void> {
  let pack: FilePayloadPack = { attachments: [], previews: [] };
  if (files.length > 0) {
    try {
      const read = await refetchAttachments(files);
      pack = { attachments: read.map(toOutgoing), previews: read.map(toPreview) };
    } catch (fault) {
      ctrl.toast("error", "Could not read the attached files again", fault instanceof Error ? fault.message : String(fault));
      return;
    }
  }
  await cb(pack);
}

function PromptActionButtons({ sessionId, text, files, running, inline }: { sessionId: string; text: string; files: AttachmentView[]; running: boolean; inline?: boolean }) {
  const ctrl = useController();
  const btnClass = inline
    ? "rounded-md px-1.5 py-0.5 text-xs font-medium text-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
    : "rounded-md px-1.5 py-0.5 text-xs text-subtle hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <>
      <Tip label="Put this prompt back in the composer to change it"><button type="button" className={btnClass} onClick={() => void readAttachedFilesAgain(ctrl, files, (p) => ctrl.prefillComposer(sessionId, text, p))}>Edit</button></Tip>
      <Tip label={running ? "Wait for this turn to end, or stop it, to send the prompt again" : "Send this prompt again as it is"}><span tabIndex={running ? 0 : -1} className="inline-flex rounded-md"><button type="button" className={btnClass} disabled={running} onClick={() => void readAttachedFilesAgain(ctrl, files, (p) => ctrl.retryTurn(sessionId, text, p))}>Resend</button></span></Tip>
    </>
  );
}

function formatPluralTally(qty: number, singular: string, pluralForm: string): string {
  return `${qty} ${qty === 1 ? singular : pluralForm}`;
}

function generateTurnWorkSummary(items: MspItem[]): string {
  let shellCount = 0;
  let fileModCount = 0;
  let inspectionCount = 0;
  let queryCount = 0;
  let targetUpdateCount = 0;
  let miscellaneousCount = 0;

  for (const it of items) {
    if (it.kind === "userShell") {
      shellCount += 1;
    } else if (it.kind === "toolCall") {
      const toolType = toolKind(it.tool, parseArgs(it.args));
      if (toolType === "shell") shellCount += 1;
      else if (toolType === "edit" || toolType === "write") fileModCount += 1;
      else if (toolType === "read" || toolType === "list") inspectionCount += 1;
      else if (toolType === "search" || toolType === "web") queryCount += 1;
      else if (toolType === "goal") targetUpdateCount += 1;
      else miscellaneousCount += 1;
    }
  }

  const chunks: string[] = [];
  if (fileModCount) chunks.push(formatPluralTally(fileModCount, "edit", "edits"));
  if (shellCount) chunks.push(formatPluralTally(shellCount, "command", "commands"));
  if (inspectionCount) chunks.push(formatPluralTally(inspectionCount, "file read", "files read"));
  if (queryCount) chunks.push(formatPluralTally(queryCount, "search", "searches"));
  if (targetUpdateCount) chunks.push(formatPluralTally(targetUpdateCount, "goal update", "goal updates"));
  if (miscellaneousCount) chunks.push(formatPluralTally(miscellaneousCount, "tool call", "tool calls"));
  return chunks.join(", ");
}

function RenderTimelineItem({ item, gate, answers, sessionId, live }: { item: MspItem; gate?: Gate; answers: UserInputAnswer[] | null; sessionId?: string; live?: boolean }) {
  switch (item.kind) {
    case "agentMessage": return (item.text ?? "").trim() ? <div className="py-1"><AgentText item={item} streaming={item.status === "inProgress"} /></div> : null;
    case "reasoning": return <ReasoningRow item={item} />;
    case "toolCall": return <ToolRow item={item} gate={gate} answers={answers} sessionId={sessionId} />;
    case "userShell": return <ShellRow item={item} sessionId={sessionId} />;
    case "subagent": return <SubagentRow item={item} sessionId={sessionId} />;
    case "workflow": return <CrewAnchorRow item={item} sessionId={sessionId} />;
    case "compaction": return <CompactionRow item={item} />;
    case "userMessage": return <SteerBubble item={item} />;
    default: return <GenericRow item={item} />;
  }
}

function TurnCollapsedWorkView({ turn, gates, answers, sessionId, speed }: { turn: TurnView; gates: GateMapping; answers: AnswerMapping; sessionId: string; speed?: TurnSpeed | null }) {
  const isFailed = turn.info?.terminal === "failed";
  const [isLogOpen, setIsLogOpen] = useState(isFailed);
  const totalDuration = calculateTurnDuration(turn);
  const narrativeSummary = generateTurnWorkSummary(turn.entries);
  const workflowRuns = turn.entries.filter((it) => it.kind === "workflow");
  const filteredEntries = workflowRuns.length > 0 ? turn.entries.filter((it) => it.kind !== "workflow") : turn.entries;

  return <div><button type="button" aria-expanded={isLogOpen} onClick={() => setIsLogOpen((open) => !open)} className="group/log -mx-1.5 flex h-8 max-w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg px-1.5 text-sm text-subtle transition-colors duration-100 hover:bg-hover hover:text-muted"><CaretRightIcon size={13} className={cn("shrink-0 transition-transform duration-200 ease-out", isLogOpen && "rotate-90")} /><span className="shrink-0">{totalDuration !== null ? `Worked for ${formatDuration(totalDuration)}` : "Work log"}</span>{narrativeSummary && (<><span className="h-3 w-px shrink-0 bg-line-strong" aria-hidden="true" /><span className="truncate">{narrativeSummary}</span></>)}{speed && (<><span className="h-3 w-px shrink-0 bg-line-strong" aria-hidden="true" /><span className="shrink-0 tabular-nums">{formatSpeed(speed.tokensPerSecond)}</span></>)}</button><Collapse open={isLogOpen}><div className="mt-1 ml-[7px] flex flex-col gap-1 border-l border-line pl-4">{filteredEntries.map((it) => (<RenderTimelineItem key={it.itemId} item={it} gate={gates[it.itemId]} answers={answers[it.itemId] ?? null} sessionId={sessionId} />))}</div></Collapse>{workflowRuns.map((w) => <CrewAnchorRow key={w.itemId} item={w} sessionId={sessionId} />)}<DiffChips entries={turn.entries} className="mt-2" sessionId={sessionId} /></div>;
}

function LiveTurnProgressIndicator({ turn, gates }: { turn: TurnView; gates: GateMapping }) {
  const currentMoment = useNow(1000);
  const infoSnapshot = useRef(turn.info);
  infoSnapshot.current = turn.info;
  const currentVelocity = useSampled(() => streamingSpeed(infoSnapshot.current), true);
  const launchTimestamp = turn.info?.startedAt;
  const timeElapsed = launchTimestamp ? formatDuration(currentMoment - launchTimestamp) : null;
  const awaitingInput = turn.entries.some((entry) => gates[entry.itemId]);
  const mostRecentEntry = turn.entries[turn.entries.length - 1];
  const retryContext = turn.info?.retry;

  let activityStatusText = "Working";
  if (retryContext) {
    activityStatusText = `Retrying (attempt ${retryContext.nextAttempt} of ${retryContext.maxAttempts})`;
  } else if (mostRecentEntry?.status === "inProgress" && mostRecentEntry.kind === "toolCall") {
    const desc = describeTool(mostRecentEntry);
    activityStatusText = desc.subject && desc.mono ? `${desc.verb} ${desc.subject.split("\n")[0]}` : desc.verb;
  } else if (mostRecentEntry?.status === "inProgress" && mostRecentEntry.kind === "reasoning") {
    activityStatusText = "Thinking";
  } else if (mostRecentEntry?.kind === "agentMessage" && mostRecentEntry.status === "inProgress") {
    activityStatusText = "Writing";
  }

  return (
    <div className="flex h-8 items-center gap-2.5 text-sm" role="status">
      {awaitingInput ? (
        <><span className="attention-pulse size-2 rounded-full bg-warn" /><span className="font-medium text-warn-text">Waiting for you below</span></>
      ) : (
        <><PixelLoader className="text-accent-text" /><Shimmer className="max-w-[60ch] truncate font-medium">{activityStatusText}</Shimmer></>
      )}
      {timeElapsed && <span className="font-mono text-xs text-subtle tabular-nums">{timeElapsed}</span>}
      {currentVelocity !== null && !awaitingInput && (
        <Tip label="Estimated from the text streaming now"><span tabIndex={0} className="font-mono text-xs text-subtle tabular-nums">~{formatSpeed(currentVelocity)}</span></Tip>
      )}
      {retryContext?.reason && <span className="truncate text-xs text-subtle">{retryContext.reason}</span>}
    </div>
  );
}

function TurnCompletionBar({ turn, speed, cost }: { turn: TurnView; speed: TurnSpeed | null; cost: TurnCost | null }) {
  const executionTime = calculateTurnDuration(turn);
  const hasSubItems = turn.entries.length > 0;
  const finishMoment = turn.info?.terminal === "unknown" ? null : extractCompletedTimestamp(turn);
  const separatorElement = <span aria-hidden="true" className="text-line-strong">·</span>;

  return (
    <div className="flex h-6 items-center gap-1.5 text-xs text-subtle">
      {finishMoment !== null && <Tip label={`Completed ${formatFullDate(finishMoment)}`}><span tabIndex={0} className="tabular-nums">Completed {formatClock(finishMoment)}</span></Tip>}
      {executionTime !== null && !hasSubItems && <>{finishMoment !== null && separatorElement}<span className="tabular-nums">{formatDuration(executionTime)}</span></>}
      {speed && (
        <>
          {(finishMoment !== null || (executionTime !== null && !hasSubItems)) && separatorElement}
          <Tip label={`${formatTokens(speed.outputTokens)} output tokens over ${formatDuration(speed.generationMs)} of model calls`}><span tabIndex={0} className="tabular-nums">{formatSpeed(speed.tokensPerSecond)}</span></Tip>
        </>
      )}
      {cost && cost.cost > 0 && (
        <>
          {(finishMoment !== null || speed || (executionTime !== null && !hasSubItems)) && separatorElement}
          <Tip label={turnCostTip(cost)}><span tabIndex={0} className="tabular-nums">{turnCostLabel(cost)}</span></Tip>
        </>
      )}
      <span className="ml-0.5 opacity-0 transition-opacity duration-150 group-hover/final:opacity-100 focus-within:opacity-100"><CopyButton text={turn.final?.text ?? ""} label="Copy reply" /></span>
    </div>
  );
}

function UserPromptBubble({ item, sentAt, files = [], sessionId, running, readOnly }: { item: MspItem; sentAt: number | null; files?: AttachmentView[]; sessionId: string; running: boolean; readOnly: boolean }) {
  const promptBody = item.displayText ?? item.text ?? "";
  const isLengthy = promptBody.split("\n").length > 12 || promptBody.length > 900;
  const [isFullOpen, setIsFullOpen] = useState(false);

  return (
    <div className="flex justify-end">
      <div className="group/prompt flex max-w-[85%] flex-col items-end gap-1">
        {files.length > 0 && <SentAttachments files={files} className="pb-0.5" />}
        <div className={cn("relative rounded-2xl rounded-tr-md bg-active px-4 py-2.5 text-md leading-relaxed whitespace-pre-wrap text-fg [overflow-wrap:anywhere]", isLengthy && !isFullOpen && "max-h-[16.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]")}>{promptBody}</div>
        <div className="flex h-6 items-center gap-1">
          <div className="flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/prompt:opacity-100 focus-within:opacity-100">
            {isLengthy && <button type="button" onClick={() => setIsFullOpen((v) => !v)} className="rounded-md px-1.5 py-0.5 text-xs text-subtle hover:bg-hover hover:text-fg">{isFullOpen ? "Show less" : "Show all"}</button>}
            <CopyButton text={promptBody} label="Copy prompt" />
            {!readOnly && promptBody && <PromptActionButtons sessionId={sessionId} text={promptBody} files={files} running={running} />}
          </div>
          {sentAt !== null && <Tip label={`Sent ${formatFullDate(sentAt)}`}><span tabIndex={0} className="px-1 text-xs text-subtle tabular-nums">{formatClock(sentAt)}</span></Tip>}
        </div>
      </div>
    </div>
  );
}

function LocalShellExecutionRow({ run, sessionId }: { run: ShellRun; sessionId: string }) {
  const ctrl = useController();
  const hasFailed = run.exitCode !== 0;
  const stdoutOutput = run.output.trim();

  return <section className="enter-up flex flex-col gap-1.5" aria-label={`Command ${run.command}`}><div className="flex items-center gap-2"><TerminalWindowIcon size={14} className="shrink-0 text-subtle" /><span className="shrink-0 text-xs text-muted">You ran</span><code className="min-w-0 flex-1 truncate rounded-md bg-sunken px-1.5 py-0.5 font-mono text-xs text-fg">{run.command}</code>{hasFailed && <span className="shrink-0 text-xs text-danger-text">Exit {run.exitCode ?? "?"}</span>}{run.durationMs !== null && <span className="shrink-0 text-2xs text-subtle tabular-nums">{formatDuration(run.durationMs)}</span>}<Tip label="Muse did not see this run; this sends it the command and its output"><Button size="sm" variant="ghost" onClick={() => void ctrl.sendShellOutput(sessionId, run)}>Send to Muse</Button></Tip></div>{stdoutOutput && <CodeBlock code={run.truncated ? `[earlier output dropped]\n${stdoutOutput}` : stdoutOutput} language="text" className="my-0" />}</section>;
}

function InTransitPromptIndicator({ echo }: { echo: LocalEcho }) {
  const attachedFiles = echo.attachments ?? [];
  return <div className="enter-up flex flex-col items-end gap-1.5">{attachedFiles.length > 0 && <SentAttachments files={attachedFiles} className="max-w-[85%] opacity-75" />}{echo.text && <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-active px-4 py-2.5 text-md leading-relaxed whitespace-pre-wrap text-fg opacity-75">{echo.text}</div>}<span className="flex items-center gap-1.5 text-2xs text-subtle"><Spinner size={9} />{resolveEchoDispositionLabel(echo.disposition)}</span></div>;
}

function UnconfirmedOutcomeBanner({ sessionId, latest }: { sessionId: string; latest: boolean }) {
  const ctrl = useController();
  const isRefreshing = useApp((s) => s.threads[sessionId]?.load === "loading");

  if (!latest) return <p className="flex min-w-0 items-center gap-1.5 text-xs text-subtle"><ClockCounterClockwiseIcon size={12} className="shrink-0" /><span className="shrink-0">Outcome not saved yet</span></p>;

  return <div className="flex items-start gap-3 rounded-xl bg-sunken px-3.5 py-3 shadow-[0_0_0_1px_var(--border)]"><ClockCounterClockwiseIcon size={15} className="mt-0.5 shrink-0 text-subtle" /><div className="min-w-0 flex-1"><p role="status" className="text-sm font-medium text-fg">Outcome not saved yet</p><p className="mt-0.5 text-xs text-muted">Muse reports this turn is over, but the saved history Ancilla could read stops before it ends. Nothing was sent again.</p></div><Button size="sm" loading={isRefreshing} onClick={() => void ctrl.retryStalledThread(sessionId)}>Reload results</Button></div>;
}

interface TurnFailureBannerProps { message: string; retryable: boolean; prompt: string | null; sessionId: string; turnId: string | null; readOnly: boolean; followed: boolean; files: AttachmentView[]; }

function TurnExecutionFailureBanner({ message, retryable, prompt, sessionId, turnId, readOnly, followed, files }: TurnFailureBannerProps) {
  const ctrl = useController();
  const containsImages = files.some((f) => f.kind === "image");
  const threadStallInfo = stuckThread(message, { ownImages: containsImages });

  const executeRetryWithFiles = (action: (pack: FilePayloadPack) => Promise<unknown>) => {
    void readAttachedFilesAgain(ctrl, files, async (pack) => {
      ctrl.dismissTurnError(sessionId, turnId);
      await action(pack);
    });
  };

  return <div className="flex items-start gap-3 rounded-xl bg-danger-soft px-3.5 py-3" role="alert"><WarningCircleIcon size={16} className="mt-0.5 shrink-0 text-danger" /><div className="min-w-0 flex-1"><p className="text-sm font-medium text-fg">{threadStallInfo ? "This thread cannot go on as it is" : followed ? "An earlier turn failed" : "This turn failed"}</p><p className="mt-0.5 text-sm break-words text-muted">{threadStallInfo ? threadStallInfo.message : message}</p>{threadStallInfo && <p className="mt-1 text-2xs break-words text-subtle">{message}</p>}</div>{threadStallInfo && threadStallInfo.remedy !== "none" && !readOnly ? (<Tip label={threadStallInfo.remedy === "compact" ? "Summarize the history, leave behind what cannot be sent, and carry on" : "Start a thread beside this one, without the history that cannot be sent"}><Button size="sm" onClick={() => { const textPrompt = prompt; executeRetryWithFiles((pack) => threadStallInfo.remedy === "compact" ? ctrl.compactAndRetry(sessionId, textPrompt, pack) : ctrl.freshThread(sessionId, textPrompt, pack)); }}>{threadStallInfo.remedy === "compact" ? (<><ArrowCounterClockwiseIcon size={13} /> {prompt ? "Compact and retry" : "Compact this thread"}</>) : (<><NotePencilIcon size={13} /> Start a fresh thread</>)}</Button></Tip>) : threadStallInfo && threadStallInfo.remedy === "none" && !readOnly ? (<Tip label="If the image you sent opens fine elsewhere, an older one in this thread is the unreadable one"><Button size="sm" variant="secondary" onClick={() => { ctrl.dismissTurnError(sessionId, turnId); void ctrl.compactAndRetry(sessionId, null); }}><ArrowCounterClockwiseIcon size={13} /> Compact the thread</Button></Tip>) : prompt && retryable ? (<Tip label="Send the same prompt again"><Button size="sm" variant="secondary" onClick={() => executeRetryWithFiles((pack) => ctrl.retryTurn(sessionId, prompt, pack))}><ArrowCounterClockwiseIcon size={13} /> Retry</Button></Tip>) : null}<Tip label="Dismiss"><IconButton size="sm" label="Dismiss this error" className="-mt-0.5 -mr-1 shrink-0" onClick={() => ctrl.dismissTurnError(sessionId, turnId)}><XIcon size={13} /></IconButton></Tip></div>;
}

function SessionLoadFailureView({ sessionId, message }: { sessionId: string; message: string | null }) {
  const ctrl = useController();
  return <div className="flex items-start gap-3 rounded-xl bg-danger-soft px-3.5 py-3" role="alert"><WarningCircleIcon size={16} className="mt-0.5 shrink-0 text-danger" /><div className="min-w-0 flex-1"><p className="text-sm font-medium text-fg">Could not open this thread</p><p className="mt-0.5 text-sm break-words text-muted">{message ?? "Muse did not answer."}</p></div><Button size="sm" onClick={() => void ctrl.loadThread(sessionId)}>Try again</Button></div>;
}

function FreshThreadCleanSlate() {
  return <div className="flex flex-col items-center pt-[14vh] text-center"><p className="font-display text-2xl text-fg">A clean slate</p><p className="mt-2 max-w-[44ch] text-sm text-muted">Describe the change you want. Muse reads the project, runs what it needs, and asks before anything risky.</p></div>;
}

function TranscriptSkeletonCards() {
  return <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading thread">{[0, 1].map((i) => (<div key={i} className="flex flex-col gap-3"><div className="ml-auto h-10 w-[46%] rounded-2xl bg-hover" /><div className="h-3 w-[30%] rounded bg-hover" /><div className="h-3 w-[88%] rounded bg-hover" /><div className="h-3 w-[72%] rounded bg-hover" /></div>))}</div>;
}

interface TurnBlockPresentationProps { turn: TurnView; gates: GateMapping; answers: AnswerMapping; attachments: Record<string, AttachmentView[]>; sessionId: string; isLast: boolean; followed: boolean; readOnly: boolean; speed: TurnSpeed | null; cost: TurnCost | null; }

const MemoizedTurnBlock = memo(
  function MemoizedTurnBlock(props: TurnBlockPresentationProps) {
    const { turn, gates, answers, attachments, sessionId, isLast, followed, readOnly, speed, cost } = props;
    const metaInfo = turn.info;
    const isErrorMuted = useApp((s) => (turn.turnId ? s.prefs.dismissedTurnErrors.includes(`${sessionId}:${turn.turnId}`) : false));
    const isFailed = metaInfo?.terminal === "failed" && !metaInfo.dismissed && !isErrorMuted;
    const isAborted = metaInfo?.terminal === "cancelled";
    const isOutcomeUnsettled = metaInfo?.terminal === "unknown" && !turn.running;
    const containsEntries = turn.entries.length > 0;
    const isUnmanagedCommand = !turn.turnId && !turn.prompt;

    return (
      <article className="flex flex-col gap-3" aria-label="Turn">
        {turn.prompt && (
          <UserPromptBubble item={turn.prompt} sentAt={extractSentTimestamp(turn)} files={attachments[turn.turnId ?? ""] ?? []} sessionId={sessionId} running={turn.running} readOnly={readOnly} />
        )}
        {turn.running || isUnmanagedCommand ? (
          <div className="flex flex-col gap-1.5">
            {turn.entries.map((it) => (<RenderTimelineItem key={it.itemId} item={it} gate={gates[it.itemId]} answers={answers[it.itemId] ?? null} sessionId={sessionId} live />))}
            {turn.running && <LiveTurnProgressIndicator turn={turn} gates={gates} />}
          </div>
        ) : containsEntries ? (
          <TurnCollapsedWorkView turn={turn} gates={gates} answers={answers} sessionId={sessionId} speed={turn.final ? null : speed} />
        ) : null}
        {turn.final && (<div className="group/final flex flex-col gap-2"><AgentText item={turn.final} /><TurnCompletionBar turn={turn} speed={speed} cost={cost} /></div>)}
        {isFailed && !isLast ? (
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-subtle"><WarningCircleIcon size={12} className="shrink-0 text-danger" /><span className="shrink-0">Failed</span><span aria-hidden="true">·</span><span className="min-w-0 truncate" title={metaInfo?.error?.message ?? undefined}>{metaInfo?.error?.message ?? "The turn failed."}</span></p>
        ) : isFailed ? (
          <TurnExecutionFailureBanner message={metaInfo?.error?.message ?? "The turn failed."} retryable={metaInfo?.error?.retryable ?? true} prompt={isLast && !readOnly ? (turn.prompt?.displayText ?? turn.prompt?.text ?? null) : null} sessionId={sessionId} turnId={turn.turnId} readOnly={readOnly} followed={followed} files={attachments[turn.turnId ?? ""] ?? []} />
        ) : null}
        {isOutcomeUnsettled && <UnconfirmedOutcomeBanner sessionId={sessionId} latest={isLast} />}
        {isAborted && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
            <SquareIcon weight="fill" size={11} /> Stopped{metaInfo?.durationMs && <span className="tabular-nums">after {formatDuration(metaInfo.durationMs)}</span>}
            {!readOnly && turn.prompt && (<span className="ml-1 inline-flex items-center gap-0.5"><PromptActionButtons sessionId={sessionId} text={turn.prompt.displayText ?? turn.prompt.text ?? ""} files={attachments[turn.turnId ?? ""] ?? []} running={false} inline /></span>)}
          </p>
        )}
      </article>
    );
  },
  (prev, next) =>
    prev.turn.prompt === next.turn.prompt &&
    prev.turn.final === next.turn.final &&
    prev.turn.info === next.turn.info &&
    prev.turn.running === next.turn.running &&
    areItemListsIdentical(prev.turn.entries, next.turn.entries) &&
    prev.gates === next.gates &&
    prev.answers === next.answers &&
    prev.isLast === next.isLast &&
    prev.followed === next.followed &&
    prev.readOnly === next.readOnly &&
    prev.attachments === next.attachments &&
    prev.cost?.cost === next.cost?.cost &&
    prev.speed?.tokensPerSecond === next.speed?.tokensPerSecond
);

export function Transcript(props: { sessionId: string; thread: ThreadState }) {
  const { sessionId, thread } = props;
  const threadFold = thread.fold;
  const turnViews = useMemo(() => buildTurns(threadFold), [threadFold]);
  const gateDict = useMemo(() => buildGateMapping(threadFold), [threadFold.approvals, threadFold.userInputs]);
  const answerDict = useMemo(() => buildAnswerMapping(threadFold), [threadFold.settled]);
  const speedRecords = useMemo(() => turnSpeeds(threadFold), [threadFold.meta.calls, threadFold.turns, threadFold.activeTurnId]);
  const activeModels = useApp((s) => s.models);
  const ctrl = useController();
  const sessionDirectory = useApp((s) => s.sessions[sessionId]?.cwd ?? null);

  const markdownFileHandlers = useMemo<FileLinks | null>(
    () =>
      sessionDirectory
        ? {
            resolve: (href) => fileTarget(href, sessionDirectory),
            open: (loc) => ctrl.openFile(sessionId, loc.path, loc.line),
            imageUrl: (uri) => {
              const target = fileTarget(uri, sessionDirectory);
              return target ? ctrl.fileUrl(sessionDirectory, target.path) : null;
            },
          }
        : null,
    [ctrl, sessionDirectory, sessionId]
  );

  const costRecords = useMemo(() => turnCosts(threadFold, activeModels), [threadFold.meta.calls, activeModels]);
  const visibleEchoPrompts = threadFold.echoes.filter((e) => e.disposition !== "queued");

  const chronologicalEntries = useMemo(() => {
    let lastClock = 0;
    const turnElements = turnViews.map((item) => {
      const mark = extractSentTimestamp(item) ?? extractCompletedTimestamp(item) ?? (lastClock + 1);
      lastClock = mark;
      return { kind: "turn" as const, at: mark, turn: item };
    });
    const shellElements = (thread.shellRuns ?? []).map((s) => ({ kind: "run" as const, at: Date.parse(s.at) || 0, run: s }));
    const researchElements = (thread.researchRuns ?? []).map((r) => ({ kind: "research" as const, at: Date.parse(r.createdAt) || 0, run: r }));
    return [...turnElements, ...shellElements, ...researchElements].sort((x, y) => x.at - y.at);
  }, [turnViews, thread.shellRuns, thread.researchRuns]);

  const latestResearchReportId = useMemo(() => newestReportedRun(thread.researchRuns ?? []), [thread.researchRuns]);

  const terminalTurnKey = useMemo(() => {
    for (let pos = chronologicalEntries.length - 1; pos >= 0; pos -= 1) {
      const it = chronologicalEntries[pos];
      if (it?.kind === "turn") return it.turn.key;
    }
    return null;
  }, [chronologicalEntries]);

  const hasOutgoingFollowUp = visibleEchoPrompts.some((ec) => ec.disposition === "sending" || ec.disposition === "started" || ec.disposition === "unconfirmed");

  const attachmentsIndexedByTurn = useMemo(() => {
    const registry: Record<string, AttachmentView[]> = {};
    for (const a of thread.attachments ?? []) {
      const tid = a.turnId ?? "";
      (registry[tid] ??= []).push(a);
    }
    return registry;
  }, [thread.attachments]);

  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({ initial: "instant", resize: "smooth" });

  const activeInteractionRequests = Object.keys(threadFold.approvals).length + Object.keys(threadFold.userInputs).length;
  useEffect(() => {
    if (activeInteractionRequests > 0) void scrollToBottom();
  }, [activeInteractionRequests, scrollToBottom]);

  const stickBottomRef = useRef(isAtBottom);
  stickBottomRef.current = isAtBottom;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let priorHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const cur = el.clientHeight;
      if (cur < priorHeight && stickBottomRef.current) void scrollToBottom();
      priorHeight = cur;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef, scrollToBottom]);

  const isTranscriptBlank = chronologicalEntries.length === 0 && visibleEchoPrompts.length === 0;

  return (
    <FileLinksContext.Provider value={markdownFileHandlers}>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]">
          <div ref={contentRef} className="mx-auto flex w-full max-w-[776px] flex-col gap-8 px-4 pt-8 pb-10 @min-[520px]:px-6">
            {thread.truncated && <p className="text-center text-xs text-subtle">Earlier turns are not shown. Open the session in Muse to see the full history.</p>}
            {thread.load === "loading" && isTranscriptBlank && <TranscriptSkeletonCards />}
            {chronologicalEntries.map((entry) =>
              entry.kind === "turn" ? (
                <MemoizedTurnBlock
                  key={entry.turn.key}
                  turn={entry.turn}
                  gates={gateDict}
                  answers={answerDict}
                  attachments={attachmentsIndexedByTurn}
                  sessionId={sessionId}
                  isLast={entry.turn.key === terminalTurnKey}
                  followed={entry.turn.key === terminalTurnKey && hasOutgoingFollowUp}
                  readOnly={thread.readOnly}
                  speed={entry.turn.turnId ? (speedRecords[entry.turn.turnId] ?? null) : null}
                  cost={entry.turn.turnId ? (costRecords[entry.turn.turnId] ?? null) : null}
                />
              ) : entry.kind === "run" ? (
                <LocalShellExecutionRow key={entry.run.id} run={entry.run} sessionId={sessionId} />
              ) : (
                <ResearchRunRow key={entry.run.runId} run={entry.run} sessionId={sessionId} latest={entry.run.runId === latestResearchReportId} />
              )
            )}
            {visibleEchoPrompts.map((echo) => <InTransitPromptIndicator key={echo.localId} echo={echo} />)}
            {thread.load === "error" && <SessionLoadFailureView sessionId={sessionId} message={thread.error} />}
            {isTranscriptBlank && thread.load === "ready" && <FreshThreadCleanSlate />}
          </div>
        </div>
        {!isAtBottom && !isTranscriptBlank && (<div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center"><button type="button" onClick={() => void scrollToBottom()} className="enter-up pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full bg-raised px-3 text-xs font-medium text-muted shadow-pop hover:text-fg"><ArrowDownIcon size={13} /> Latest</button></div>)}
      </div>
    </FileLinksContext.Provider>
  );
}
