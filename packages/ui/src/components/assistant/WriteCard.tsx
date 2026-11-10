import type { AssistantWriteCard, AssistantWriteClass } from "../../types.js";
import { Button } from "../ui/primitives.js";
import { Chip } from "./parts.js";

/**
 * A change the assistant wants to make in a connected account: what it is, where, every argument whole, and what code noticed
 * about it. It is made from the call itself, never from what the model said about it, so what is shown is what is sent. Nothing
 * is done until Do it is clicked, the answer is for this one change only, and anything that changes asks again.
 */

export type WriteAnswer = "do" | "dont" | "always";

const KIND: Record<AssistantWriteClass, { label: string; tone: "plain" | "warn" | "danger" }> = {
  reversible: { label: "Can be undone", tone: "plain" },
  communicates: { label: "Other people will see it", tone: "warn" },
  destructive: { label: "Cannot be taken back", tone: "danger" },
};

export function WriteCardView(props: { card: AssistantWriteCard; busy?: boolean; onAnswer(answer: WriteAnswer): void }) {
  const { card } = props;
  const kind = KIND[card.class];
  return (
    <div role="group" aria-label={`A change the assistant wants to make in ${card.connectorName}`} className="w-full space-y-1.5 rounded border border-line bg-bg p-2">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>The assistant wants to</span>
        <Chip tone={kind.tone}>{kind.label}</Chip>
      </p>
      <p className="text-xs font-medium text-fg [overflow-wrap:anywhere]">{card.what}</p>
      <p className="text-xs text-muted [overflow-wrap:anywhere]">
        In {card.connectorName}
        {card.target ? `: ${card.target}` : ""}, with <span className="font-mono">{card.tool}</span>
      </p>
      {card.proposal ? <p className="text-xs text-warn-text">Nobody was there when this was asked for, so it was kept for you. It does nothing until you say so.</p> : null}
      {card.flags.length > 0 ? (
        <ul aria-label="Look at these before you answer" className="space-y-1 rounded bg-warn-soft px-2 py-1 text-xs text-warn-text">
          {card.flags.map((flag) => (
            <li key={flag.code} className="[overflow-wrap:anywhere]">
              {flag.text}
            </li>
          ))}
        </ul>
      ) : null}
      <dl aria-label="What will be sent" className="max-h-56 space-y-0.5 overflow-y-auto rounded bg-sunken px-2 py-1 text-xs">
        {card.fields.map((field, i) => (
          <div key={`${i}-${field.name}`} className="flex gap-2">
            <dt className="shrink-0 font-medium text-muted">{field.name}</dt>
            <dd className="min-w-0 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{field.value === "" ? <span className="text-subtle">(empty)</span> : field.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-subtle">
        Exactly this is sent, and nothing else; if anything changes, you are asked again. {card.proposal ? "" : "It lapses after 10 minutes. "}Fingerprint {card.hash.slice(0, 12)}.
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" variant="accent" disabled={props.busy} onClick={() => props.onAnswer("do")}>
          {card.proposal ? "Do it now" : "Do it"}
        </Button>
        <Button size="xs" variant="secondary" disabled={props.busy} onClick={() => props.onAnswer("dont")}>
          Don&apos;t
        </Button>
        {card.offerAlways ? (
          <Button size="xs" variant="ghost" disabled={props.busy} onClick={() => props.onAnswer("always")}>
            Do it, and always do small changes like this
          </Button>
        ) : null}
      </div>
    </div>
  );
}
