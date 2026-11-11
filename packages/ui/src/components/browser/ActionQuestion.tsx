import { Button } from "../ui/primitives.js";
import { DownloadForm } from "./DownloadForm.js";
import type { ActionQuestionView } from "./protocol.js";

/**
 * An action the assistant's browser wants to take that changes something in the world: what it is, where, and what will be sent.
 * Nothing happens until Do it is clicked, and the answer is for this one action only: it asks again the next time.
 */

export type ActionAnswer = "do" | "dont";

/** The reason a web task shows while it waits for this: the Tasks row knows an action is waiting before the details have loaded. */
export const ACTION_REASON = /^Waiting for your approval: /;

export function ActionQuestionCard(props: {
  question: ActionQuestionView;
  busy?: boolean;
  onAnswer(answer: ActionAnswer, folder?: string): void;
  onPickNative?(currentFolder: string): Promise<{ supported: boolean; folder: string | null }>;
}) {
  const { question } = props;
  if (question.download) {
    const d = question.download;
    return (
      <div aria-label="A download the assistant started" className="w-full space-y-1.5 rounded border border-line bg-bg p-2">
        <DownloadForm
          name={d.name}
          size={d.size}
          origin={question.origin}
          page={question.page}
          folder={d.folder}
          warning={d.warning}
          fromAssistant
          busy={props.busy}
          onPickNative={props.onPickNative}
          onSave={(folder) => props.onAnswer("do", folder)}
          onDont={() => props.onAnswer("dont")}
        />
      </div>
    );
  }
  return (
    <div role="group" aria-label="An action the assistant wants to take" className="w-full space-y-1.5 rounded border border-line bg-bg p-2">
      <p className="text-xs text-muted">The assistant wants to</p>
      <p className="text-xs font-medium text-fg [overflow-wrap:anywhere]">{question.what}</p>
      <p className="text-xs text-muted [overflow-wrap:anywhere]">
        On {question.page ? `“${question.page}” at ` : ""}
        {question.origin}
        {question.kind === "local" ? " (a page on this computer or your network)" : ""}
      </p>
      {question.fields.length > 0 ? (
        <dl aria-label="What will be sent" className="max-h-40 space-y-0.5 overflow-y-auto rounded bg-sunken px-2 py-1 text-xs">
          {question.fields.map((field, i) => (
            <div key={`${i}-${field.name}`} className="flex gap-2">
              <dt className="shrink-0 font-medium text-muted">{field.name}</dt>
              <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{field.value === "" ? <span className="text-subtle">(empty)</span> : field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {question.note ? <p className="text-xs font-medium text-fg [overflow-wrap:anywhere]">{question.note}</p> : null}
      <p className="text-xs text-subtle">Nothing is done until you say so, and it asks again next time.</p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" variant="accent" disabled={props.busy} onClick={() => props.onAnswer("do")}>
          Do it
        </Button>
        <Button size="xs" variant="secondary" disabled={props.busy} onClick={() => props.onAnswer("dont")}>
          Don&apos;t
        </Button>
      </div>
    </div>
  );
}
