import { Button } from "../ui/primitives.js";
import { DownloadForm, UploadForm } from "./DownloadForm.js";
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
  onAnswer(answer: ActionAnswer, folder?: string, files?: string[]): void;
  onPickNative?(currentFolder: string): Promise<{ supported: boolean; folder: string | null }>;
  onPickNativeFiles?(currentFolder: string, multiple: boolean): Promise<{ supported: boolean; files: string[] | null }>;
}) {
  const { question } = props;
  if (question.download) {
    const d = question.download;
    return (
      <div aria-label="A download the assistant started" className="w-full space-y-2 rounded-xl border border-line-strong/80 bg-raised p-3.5 shadow-sm">
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
  if (question.upload) {
    const u = question.upload;
    return (
      <div aria-label="A file upload the assistant's page opened" className="w-full space-y-2 rounded-xl border border-line-strong/80 bg-raised p-3.5 shadow-sm">
        <UploadForm
          multiple={u.multiple}
          origin={question.origin}
          page={question.page}
          folder={u.folder}
          fromAssistant
          busy={props.busy}
          onPickNativeFiles={props.onPickNativeFiles}
          onUpload={(files) => props.onAnswer("do", undefined, files)}
          onCancel={() => props.onAnswer("dont")}
        />
      </div>
    );
  }
  return (
    <div role="group" aria-label="An action the assistant wants to take" className="w-full space-y-2.5 rounded-xl border border-line-strong/80 bg-raised p-3.5 shadow-sm">
      <div className="space-y-1">
        <p className="text-xs text-muted">The assistant wants to</p>
        <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{question.what}</p>
        <p className="text-xs text-muted [overflow-wrap:anywhere]">
          On {question.page ? `“${question.page}” at ` : ""}
          {question.origin}
          {question.kind === "local" ? " (a page on this computer or your network)" : ""}
        </p>
      </div>
      {question.fields.length > 0 ? (
        <dl aria-label="What will be sent" className="max-h-40 divide-y divide-line/60 overflow-y-auto rounded-lg border border-line bg-sunken/70 px-3 py-1 text-xs">
          {question.fields.map((field, i) => (
            <div key={`${i}-${field.name}`} className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 py-1.5">
              <dt className="shrink-0 font-medium text-muted">{field.name}</dt>
              <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{field.value === "" ? <span className="text-subtle">(empty)</span> : field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {question.note ? <p className="text-xs font-medium text-fg [overflow-wrap:anywhere]">{question.note}</p> : null}
      <p className="text-xs text-subtle">Nothing is done until you say so, and it asks again next time.</p>
      <div className="flex flex-wrap gap-2 pt-0.5">
        <Button size="sm" variant="accent" disabled={props.busy} onClick={() => props.onAnswer("do")}>
          Do it
        </Button>
        <Button size="sm" variant="secondary" disabled={props.busy} onClick={() => props.onAnswer("dont")}>
          Don&apos;t
        </Button>
      </div>
    </div>
  );
}
