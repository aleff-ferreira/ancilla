import { useState, useEffect, useRef, useId, type FormEvent, type ReactNode } from "react";
import { useApp, useController } from "../../app/context.js";
import { describeApproval, formatFullDate } from "../../model/format.js";
import { stepSegs, type Glyph } from "../../model/runCard.js";
import type { TaskPlanView } from "../../model/taskPlan.js";
import type { LocalEcho } from "../../model/fold.js";
import type {
  ApprovalChoice,
  ApprovalRequest,
  UserInputAnswer,
  UserInputQuestion,
  UserInputRequest,
} from "../../types.js";
import { Button, IconButton, Shortcut, cn } from "../ui/primitives.js";
import { Tip } from "../ui/overlays.js";
import { Collapse, RollingDigits } from "../ui/sourced.js";
import {
  ChatCircleDotsIcon,
  CheckIcon,
  CheckCircleIcon,
  ClockIcon,
  LockIcon,
  PencilSimpleIcon,
  ShieldWarningIcon,
  XIcon,
  CaretUpIcon,
  CaretDownIcon,
  PlugsIcon,
  ClockCounterClockwiseIcon,
} from "../ui/icons.js";
import { PlanSteps, RunGlyph, Spine, Swap, useDwell } from "../crew/RunParts.js";

const REQUEST_CARD_SHADOW = "shadow-[0_0_0_1px_var(--warn-line),0_2px_14px_-2px_var(--warn-glow)]";
const REQUEST_CARD_BASE_CLASS = cn("enter-up overflow-hidden rounded-2xl bg-sunken", REQUEST_CARD_SHADOW);

export function isTyping(target: EventTarget | null): boolean {
  if (typeof HTMLElement !== "undefined" && !(target instanceof HTMLElement)) return false;
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!element || !element.tagName) return false;
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || Boolean(element.isContentEditable);
}

function lowerFirstChar(val: string): string {
  if (!val) return "";
  return val.charAt(0).toLowerCase() + val.slice(1);
}

function renderChoiceIcon(choice: ApprovalChoice): ReactNode {
  if (choice.decision === "approved") {
    return choice.rulePreview ? <CheckCircleIcon size={14} /> : <CheckIcon size={14} />;
  }
  return <XIcon size={14} />;
}

function findRefusalChoice(choices: readonly ApprovalChoice[]): ApprovalChoice | undefined {
  return choices.find((c) => c.decision === "rejected");
}

export function ApprovalPanel(props: { request: ApprovalRequest; primary: boolean }) {
  const ctrl = useController();
  const req = props.request;
  const isOperationBusy = useApp((st) => Boolean(st.busy[`approval:${req.approvalId}`]));
  const isThreadArmed = useApp((st) => st.bypassAll || st.bypassThreads.includes(req.sessionId));
  const desc = describeApproval(req);
  const choiceList = req.availableChoices ?? [];
  const primaryApprovedChoice = choiceList.find((c) => c.decision === "approved") ?? choiceList[0];

  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null);
  const [feedbackPromptChoice, setFeedbackPromptChoice] = useState<ApprovalChoice | null>(null);
  const [feedbackText, setFeedbackText] = useState("");

  const handlePickChoice = (choice: ApprovalChoice) => {
    if (choice.acceptsFeedback) {
      setFeedbackPromptChoice(choice);
      return;
    }
    setSelectedChoiceId(choice.choiceId);
    void ctrl.decide(req, choice.choiceId, null);
  };

  useEffect(() => {
    if (!props.primary || feedbackPromptChoice) return;

    const handleApprovalKeydown = (event: globalThis.KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const pressed = event.key.toLowerCase();
      if (pressed === "a" || pressed === "r") {
        const target = pressed === "a" ? primaryApprovedChoice : findRefusalChoice(choiceList);
        if (target) {
          event.preventDefault();
          handlePickChoice(target);
        }
        return;
      }

      const digitIndex = Number(event.key) - 1;
      const matched = Number.isInteger(digitIndex) ? choiceList[digitIndex] : undefined;
      if (matched) {
        event.preventDefault();
        handlePickChoice(matched);
      }
    };

    window.addEventListener("keydown", handleApprovalKeydown);
    return () => window.removeEventListener("keydown", handleApprovalKeydown);
  });

  const stagesTotal = req.subject?.stages?.length ?? 0;

  return (
    <section aria-label="Approval needed" data-request-id={req.approvalId} className={REQUEST_CARD_BASE_CLASS}>
      <header className="flex items-start gap-3 px-4 pt-3.5">
        <div className="mt-px flex size-7 shrink-0 items-center justify-center rounded-lg bg-warn-soft text-warn-text">
          <ShieldWarningIcon size={15} />
        </div>
        <article className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-fg">Muse wants to {lowerFirstChar(desc.title)}</h3>
          <p className="mt-0.5 text-xs text-muted">
            {req.protectedWrite ? "This touches a protected path. " : ""}
            {req.judgeEscalated ? "A safety check flagged it for you to review. " : ""}
            {stagesTotal > 1 ? `Part of a ${stagesTotal}-step command. ` : ""}
            <span>Nothing runs until you decide.</span>
          </p>
        </article>
      </header>

      {desc.detail && (
        <pre className="mx-4 mt-3 max-h-44 overflow-auto rounded-lg bg-sunken px-3 py-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg shadow-[0_0_0_1px_var(--border)] [overflow-wrap:anywhere]">
          {desc.detail}
        </pre>
      )}

      {feedbackPromptChoice ? (
        <form
          className="flex flex-col gap-2 px-4 pt-3 pb-3.5"
          onSubmit={(evt: FormEvent) => {
            evt.preventDefault();
            setSelectedChoiceId(feedbackPromptChoice.choiceId);
            void ctrl.decide(req, feedbackPromptChoice.choiceId, feedbackText.trim() || null);
          }}
        >
          <label htmlFor={`fb-${req.approvalId}`} className="block text-xs font-medium text-muted/90">
            Tell Muse what to do instead (optional)
          </label>
          <textarea
            id={`fb-${req.approvalId}`}
            rows={2}
            autoFocus
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.currentTarget.value)}
            className="w-full resize-none rounded-lg bg-sunken px-3 py-2 text-sm text-fg shadow-[0_0_0_1px_var(--border-strong)] outline-none focus-visible:shadow-[0_0_0_2px_var(--focus-ring)] focus-visible:outline-none"
          />
          <footer className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setFeedbackPromptChoice(null)}>Back</Button>
            <Button size="sm" variant="primary" type="submit" loading={isOperationBusy}>{feedbackPromptChoice.label}</Button>
          </footer>
        </form>
      ) : (
        <footer className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-3.5">
          {choiceList.map((choice) => {
            const isSelected = selectedChoiceId === choice.choiceId;
            const btn = (
              <Button
                key={choice.choiceId}
                variant={choice === primaryApprovedChoice ? "primary" : "secondary"}
                size="sm"
                loading={isOperationBusy && isSelected}
                disabled={isOperationBusy}
                onClick={() => handlePickChoice(choice)}
              >{renderChoiceIcon(choice)}<span>{choice.label}</span></Button>
            );
            return choice.rulePreview ? (
              <Tip key={choice.choiceId} label={`Adds the rule ${choice.rulePreview}`}>{btn}</Tip>
            ) : btn;
          })}

          {choiceList.length === 0 && (
            <p className="text-xs text-muted">No choices were offered. Decide in the Muse terminal.</p>
          )}

          {!isThreadArmed && primaryApprovedChoice && (
            <Tip label="Allow this and everything else this thread asks, until you close Ancilla">
              <button
                onClick={() => ctrl.setThreadBypass(req.sessionId, true)}
                type="button"
                className="rounded-lg px-2 py-1 text-2xs text-subtle transition-colors duration-100 hover:bg-hover hover:text-fg"
              ><span>Stop asking in this thread</span></button>
            </Tip>
          )}

          {props.primary && choiceList.length > 1 && (
            <span className="ml-auto hidden items-center gap-1.5 text-2xs text-subtle sm:inline-flex">
              <Shortcut keys={["A"]} />
              <span>allow</span>
              <Shortcut keys={["R"]} />
              <span>reject</span>
              {choiceList.length > 2 && (
                <span className="text-subtle">· 1 to {Math.min(choiceList.length, 9)}</span>
              )}
            </span>
          )}
        </footer>
      )}
    </section>
  );
}

type UserSelectionsMap = Record<string, string[]>;
type CustomInputMap = Record<string, string>;

function verifyQuestionAnswered(q: UserInputQuestion, sel: UserSelectionsMap, txt: CustomInputMap): boolean {
  if (txt[q.id]?.trim()) return true;
  const pickedCount = sel[q.id]?.length ?? 0;
  const threshold = Math.max(1, q.selection.minSelections ?? 1);
  return pickedCount >= threshold;
}

function buildAnswerRecord(q: UserInputQuestion, sel: UserSelectionsMap, txt: CustomInputMap): UserInputAnswer {
  const manualText = txt[q.id]?.trim();
  if (manualText || q.options.length === 0) {
    return { questionId: q.id, freeText: manualText ?? "" };
  }
  if (q.selection.mode === "multiple") {
    return { questionId: q.id, selectedLabels: sel[q.id] ?? [] };
  }
  return { questionId: q.id, selectedLabel: sel[q.id]?.[0] ?? "" };
}

function CustomAnswerField({
  value,
  hasOptions,
  disabled,
  onChange,
  onEnter,
}: {
  value: string;
  hasOptions: boolean;
  disabled: boolean;
  onChange: (val: string) => void;
  onEnter: () => void;
}) {
  return (
    <label className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors focus-within:bg-hover hover:bg-hover">
      <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center text-subtle">
        <PencilSimpleIcon size={12} />
      </span>
      <input
        value={value}
        maxLength={500}
        disabled={disabled}
        placeholder={hasOptions ? "Something else" : "Type your answer"}
        aria-label={hasOptions ? "Answer something else" : "Your answer"}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
        className="flex-1 min-w-0 bg-transparent text-sm text-fg outline-none placeholder:text-subtle focus-visible:outline-none"
      />
    </label>
  );
}

function QuestionOptionItem({
  label,
  description,
  isSelected,
  isMultiple,
  disabled,
  shortcutIndex,
  onPick,
}: {
  label: string;
  description?: string;
  isSelected: boolean;
  isMultiple: boolean;
  disabled: boolean;
  shortcutIndex?: number;
  onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      role={isMultiple ? "checkbox" : "radio"}
      type="button"
      aria-checked={isSelected}
      disabled={disabled}
      className={cn(
        "group/opt flex items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-100 hover:bg-hover disabled:opacity-60",
        isSelected ? "bg-hover" : ""
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center transition-colors duration-200",
          isMultiple ? "rounded-[5px]" : "rounded-full",
          isSelected
            ? "bg-inverse text-inverse-fg"
            : "text-transparent shadow-[inset_0_0_0_1.5px_var(--border-strong)]"
        )}
      >
        {isMultiple ? (
          <CheckIcon size={11} />
        ) : (
          <span
            className="size-1.5 rounded-full bg-current transition-transform duration-200"
            style={{ transform: isSelected ? "scale(1)" : "scale(0)" }}
          />
        )}
      </div>
      <article className="flex-1 min-w-0">
        <span
          className={cn(
            "block text-sm transition-colors duration-150",
            isSelected ? "font-medium text-fg" : "text-muted"
          )}
        >{label}</span>
        {description && (
          <span className="mt-0.5 block text-xs leading-snug text-subtle">{description}</span>
        )}
      </article>
      {shortcutIndex !== undefined && shortcutIndex < 9 && (
        <span
          aria-hidden="true"
          className="mt-0.5 font-mono text-2xs text-subtle opacity-0 transition-opacity group-hover/opt:opacity-100"
        >{shortcutIndex + 1}</span>
      )}
    </button>
  );
}

export function QuestionPanel(props: { request: UserInputRequest; keyboard: boolean }) {
  const ctrl = useController();
  const req = props.request;
  const isInputBusy = useApp((st) => Boolean(st.busy[`input:${req.userInputId}`]));
  const questionSeries = req.questions ?? [];
  const [activeQuestionIdx, setActiveQuestionIdx] = useState(0);
  const [chosenSelections, setChosenSelections] = useState<UserSelectionsMap>({});
  const [freeTextValues, setFreeTextValues] = useState<CustomInputMap>({});
  const autoAdvanceTimeout = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (autoAdvanceTimeout.current !== null) {
        window.clearTimeout(autoAdvanceTimeout.current);
      }
    };
  }, []);

  const curQuestion = questionSeries[activeQuestionIdx];
  const isFinalQuestion = activeQuestionIdx >= questionSeries.length - 1;

  const dispatchAnswers = (updatedSelections: UserSelectionsMap, updatedCustom: CustomInputMap) => {
    const unfulfilledIndex = questionSeries.findIndex((item) =>
      !verifyQuestionAnswered(item, updatedSelections, updatedCustom),
    );
    if (unfulfilledIndex >= 0) {
      setActiveQuestionIdx(unfulfilledIndex);
      return;
    }
    void ctrl.answer(
      req,
      questionSeries.map((q) => buildAnswerRecord(q, updatedSelections, updatedCustom)),
    );
  };

  const advanceNextQuestion = (nextSelections: UserSelectionsMap, nextCustom: CustomInputMap) => {
    if (isFinalQuestion) {
      dispatchAnswers(nextSelections, nextCustom);
    } else {
      setActiveQuestionIdx((curr) => Math.min(questionSeries.length - 1, curr + 1));
    }
  };

  const handleSelectOption = (optionLabel: string) => {
    if (!curQuestion || isInputBusy) return;

    const modifiedCustom = { ...freeTextValues, [curQuestion.id]: "" };
    setFreeTextValues(modifiedCustom);

    if (curQuestion.selection.mode === "multiple") {
      setChosenSelections((prev) => {
        const currentList = prev[curQuestion.id] ?? [];
        if (currentList.includes(optionLabel)) {
          return { ...prev, [curQuestion.id]: currentList.filter((item) => item !== optionLabel) };
        }
        const maxLimit = curQuestion.selection.maxSelections;
        if (maxLimit && currentList.length >= maxLimit) return prev;
        return { ...prev, [curQuestion.id]: [...currentList, optionLabel] };
      });
      return;
    }

    const modifiedSelections = { ...chosenSelections, [curQuestion.id]: [optionLabel] };
    setChosenSelections(modifiedSelections);

    if (autoAdvanceTimeout.current !== null) {
      window.clearTimeout(autoAdvanceTimeout.current);
    }
    autoAdvanceTimeout.current = window.setTimeout(
      () => advanceNextQuestion(modifiedSelections, modifiedCustom),
      420,
    );
  };

  useEffect(() => {
    if (!props.keyboard || !curQuestion) return;

    const handleQuestionKeydown = (evt: globalThis.KeyboardEvent) => {
      if (isTyping(evt.target) || evt.metaKey || evt.ctrlKey || evt.altKey) return;
      const targetOption = curQuestion.options[Number(evt.key) - 1];
      if (targetOption) {
        evt.preventDefault();
        handleSelectOption(targetOption.label);
      }
    };

    window.addEventListener("keydown", handleQuestionKeydown);
    return () => window.removeEventListener("keydown", handleQuestionKeydown);
  });

  if (!curQuestion) return null;

  const isMultiSelect = curQuestion.selection.mode === "multiple";
  const isCurAnswered = verifyQuestionAnswered(curQuestion, chosenSelections, freeTextValues);

  return (
    <section aria-label="Muse has a question" data-request-id={req.userInputId} className={REQUEST_CARD_BASE_CLASS}>
      <header className="flex items-start gap-3 px-4 pt-3.5">
        <div className="mt-px flex size-7 shrink-0 items-center justify-center rounded-lg bg-warn-soft text-warn-text">
          <ChatCircleDotsIcon size={15} />
        </div>
        <article key={curQuestion.id} className="enter-up flex-1 min-w-0">
          <p className="text-2xs font-medium text-subtle">
            {curQuestion.header || "Muse has a question"}
          </p>
          <h3
            id={`q-${req.userInputId}-${curQuestion.id}`}
            className="mt-0.5 text-md leading-snug font-medium text-pretty text-fg"
          >{curQuestion.question}</h3>
        </article>
      </header>

      <fieldset
        key={`options-${curQuestion.id}`}
        role={isMultiSelect ? "group" : "radiogroup"}
        aria-labelledby={`q-${req.userInputId}-${curQuestion.id}`}
        className="enter-up mt-2 flex flex-col gap-px px-2.5 border-none m-0 p-0"
      >
        {curQuestion.options.map((opt, optIdx) => (
          <QuestionOptionItem
            key={opt.label}
            label={opt.label}
            description={opt.description}
            isSelected={chosenSelections[curQuestion.id]?.includes(opt.label) ?? false}
            isMultiple={isMultiSelect}
            disabled={isInputBusy}
            shortcutIndex={props.keyboard ? optIdx : undefined}
            onPick={() => handleSelectOption(opt.label)}
          />
        ))}

        <CustomAnswerField
          value={freeTextValues[curQuestion.id] ?? ""}
          hasOptions={curQuestion.options.length > 0}
          disabled={isInputBusy}
          onChange={(val) => {
            setFreeTextValues((prev) => ({ ...prev, [curQuestion.id]: val }));
            if (!isMultiSelect) {
              setChosenSelections((prev) => ({ ...prev, [curQuestion.id]: [] }));
            }
          }}
          onEnter={() => {
            if (isCurAnswered) advanceNextQuestion(chosenSelections, freeTextValues);
          }}
        />

        {isMultiSelect && curQuestion.selection.maxSelections ? (
          <p className="px-2 pt-1 text-xs text-subtle">Choose up to {curQuestion.selection.maxSelections}</p>
        ) : null}
      </fieldset>

      <footer className="mt-2.5 flex items-center gap-2 border-t border-line px-3 py-2.5">
        {questionSeries.length > 1 && (
          <nav className="flex items-center gap-0.5 text-subtle">
            <IconButton
              size="xs"
              label="Previous question"
              disabled={activeQuestionIdx === 0}
              onClick={() => setActiveQuestionIdx((prev) => Math.max(0, prev - 1))}
              children={<CaretUpIcon size={14} />}
            />
            <RollingDigits
              className="text-xs font-medium"
              value={`${activeQuestionIdx + 1} / ${questionSeries.length}`}
            />
            <IconButton
              size="xs"
              label="Next question"
              disabled={isFinalQuestion}
              onClick={() => setActiveQuestionIdx((prev) => Math.min(questionSeries.length - 1, prev + 1))}
              children={<CaretDownIcon size={14} />}
            />
          </nav>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={isInputBusy}
          onClick={() => void ctrl.skipQuestion(req)}
        >Skip</Button>
        <Button
          size="sm"
          variant="primary"
          loading={isInputBusy}
          disabled={!isCurAnswered}
          onClick={() => advanceNextQuestion(chosenSelections, freeTextValues)}
        >{isFinalQuestion ? "Send answer" : "Continue"}</Button>
      </footer>
    </section>
  );
}

export function CloseCard(props: { label: string; onClose: () => void }) {
  const toolTipText = `${props.label}. Bring it back from the top bar.`;
  return (
    <Tip label={toolTipText}>
      <IconButton
        size="xs"
        label={props.label}
        onClick={props.onClose}
        className="shrink-0 text-subtle"
        children={<XIcon size={13} />}
      />
    </Tip>
  );
}

function resolvePlanCardGlyph(plan: TaskPlanView): Glyph | "plan" {
  switch (plan.state) {
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "stale":
      return "stale";
    case "complete":
      return "done";
    case "stopped":
      return "stopped";
    default:
      return "plan";
  }
}

export function PlanPanel(props: { sessionId: string; view: TaskPlanView }) {
  const ctrl = useController();
  const { view } = props;
  const storeCardKey = `plan:${props.sessionId}`;
  const isExpandedCard = useApp((st) => st.prefs.openCards.includes(storeCardKey));
  const isCardDismissed = useApp((st) => st.prefs.hiddenCards.includes(storeCardKey));
  const activePlanStep = view.activeIndex >= 0 ? view.items[view.activeIndex] : null;
  const planPanelBodyId = useId();

  const activeTaskName = view.animate && activePlanStep
    ? activePlanStep.activeForm ?? activePlanStep.text
    : "Plan";
  const displayedTaskName = useDwell(activeTaskName, 900);

  if (isCardDismissed) return null;

  const accessiblePlanLabel = `${displayedTaskName}, ${view.label}, ${view.done} of ${view.items.length} steps complete`;

  return (
    <section
      aria-label="Plan"
      data-open={isExpandedCard}
      data-live={view.animate || undefined}
      data-stale={view.state === "stale" || undefined}
      data-wait={view.state === "waiting" || undefined}
      className="run-card @container enter-up overflow-hidden rounded-xl bg-raised shadow-panel"
    >
      <header className="run-head">
        <button
          onClick={() => ctrl.setCardExpanded(storeCardKey, !isExpandedCard)}
          type="button"
          aria-expanded={isExpandedCard}
          aria-controls={planPanelBodyId}
          aria-label={accessiblePlanLabel}
          className="run-hit after:absolute after:inset-0 after:content-['']"
        >
          <RunGlyph glyph={resolvePlanCardGlyph(view)} />
          <article className="run-tx">
            <Swap id={displayedTaskName} className="run-title" title={displayedTaskName}>
              {displayedTaskName}
            </Swap>
            <div className="run-sub"><span className="min-w-0 truncate">{view.label}</span></div>
          </article>
        </button>

        <nav className="side">
          <CloseCard label="Hide the plan" onClose={() => ctrl.setCardHidden(storeCardKey, true)} />
          <span className="inline-flex size-5 items-center justify-center text-subtle" aria-hidden="true">
            <CaretDownIcon size={13} className="run-car" />
          </span>
        </nav>
      </header>

      <div className="run-rail">
        <Spine segs={stepSegs(view)} label="Plan steps completed" />
        <span className="cnt">{view.done}/{view.items.length}</span>
      </div>

      <Collapse open={isExpandedCard}>
        <div id={planPanelBodyId} className="crew-body run-body">
          <PlanSteps view={view} />
          <footer className="run-foot">
            <p role="status" className="min-w-0 truncate text-2xs text-subtle" title={view.detail}>
              {view.detail}
            </p>
            {view.updatedAt !== null && (
              <time
                className="stats"
                dateTime={new Date(view.updatedAt).toISOString()}
                title={formatFullDate(view.updatedAt)}
              >Updated {new Date(view.updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>
            )}
          </footer>
        </div>
      </Collapse>
    </section>
  );
}

export function QueuedList(props: { sessionId: string; items: LocalEcho[] }) {
  const ctrl = useController();
  return (
    <ul className="flex flex-col gap-1.5 list-none p-0 m-0">
      {props.items.map((entry) => (
        <li
          key={entry.localId}
          className="enter-up flex items-center gap-2.5 rounded-xl bg-sunken py-1.5 pr-1.5 pl-3 shadow-[0_0_0_1px_var(--border)]"
        >
          <ClockIcon size={14} className="shrink-0 text-subtle" />
          <span className="shrink-0 text-xs font-medium text-subtle">Queued</span>
          <span className="flex-1 min-w-0 truncate text-sm text-muted">{entry.text}</span>
          <Tip label="Remove from the queue">
            <IconButton
              size="xs"
              label="Remove from the queue"
              onClick={() => void ctrl.unqueue(props.sessionId, entry)}
              children={<XIcon size={13} />}
            />
          </Tip>
        </li>
      ))}
    </ul>
  );
}

export interface StalledNoticeProps {
  historySync?: { checkedAt: number; progressAt: number | null };
  busy: boolean;
  onRetry: () => void;
}

export function StalledNotice({ historySync, busy, onRetry }: StalledNoticeProps) {
  const hasHistorySync = historySync !== undefined;

  return (
    <aside className="grid grid-cols-[15px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-2xl bg-sunken px-4 py-3 shadow-[0_0_0_1px_var(--border)] @min-[520px]:grid-cols-[15px_minmax(0,1fr)_auto]">
      {hasHistorySync ? (
        <ClockCounterClockwiseIcon size={15} className="mt-0.5 text-subtle" aria-hidden="true" />
      ) : (
        <PlugsIcon size={15} className="mt-0.5 text-warn" aria-hidden="true" />
      )}
      <article className="flex-1 min-w-0">
        <p role="status" className="text-sm font-medium text-fg">
          {hasHistorySync ? "Syncing saved progress" : "This thread stopped receiving updates"}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {hasHistorySync ? (
            "Muse’s live feed is unavailable. Ancilla checks saved progress automatically without resending your task."
          ) : (
            <>
              Live updates are unavailable. Muse may still be working, or may already have finished.
              Ancilla checks saved results without sending your task again. You can refresh the results now.
            </>
          )}
        </p>
        {historySync && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-subtle">
            <span>Last checked <HistorySyncTime at={historySync.checkedAt} /></span>
            {historySync.progressAt !== null && (
              <span>Progress updated <HistorySyncTime at={historySync.progressAt} /></span>
            )}
          </div>
        )}
      </article>
      <Button
        size="sm"
        className="col-start-2 justify-self-start @min-[520px]:col-start-3 @min-[520px]:row-start-1"
        onClick={onRetry}
        loading={busy}
      >Reload results</Button>
    </aside>
  );
}

function HistorySyncTime({ at }: { at: number }) {
  const ts = new Date(at);
  const timeFormatted = ts.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <time dateTime={ts.toISOString()} title={formatFullDate(at)} className="tabular-nums">
      {timeFormatted}
    </time>
  );
}

export function ReadOnlyNotice(props: { reason: string | null; onRetry: () => void; busy: boolean }) {
  return (
    <aside className="flex items-start gap-3 rounded-2xl bg-sunken px-4 py-3 shadow-[0_0_0_1px_var(--border)]">
      <LockIcon size={15} className="mt-0.5 shrink-0 text-subtle" />
      <article className="flex-1 min-w-0">
        <p className="text-sm font-medium text-fg">Open in another Muse session</p>
        <div className="mt-0.5 text-xs text-muted">
          Another host, usually the Muse terminal, holds this thread. Close it there, then take over here.
        </div>
      </article>
      <Button size="sm" loading={props.busy} onClick={props.onRetry}>Take over</Button>
    </aside>
  );
}
