import { useEffect, useState, type ReactNode } from "react";
import { cn } from "../ui/primitives.js";

/** A small label: a kind, a state, a place. */
export function Chip(props: { children: ReactNode; tone?: "plain" | "ok" | "warn" | "danger" | "accent"; title?: string; className?: string }) {
  const tone = props.tone ?? "plain";
  return (
    <span
      title={props.title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-2xs font-medium whitespace-nowrap",
        tone === "plain" && "bg-sunken text-muted",
        tone === "ok" && "bg-ok-soft text-ok-text",
        tone === "warn" && "bg-warn-soft text-warn-text",
        tone === "danger" && "bg-danger-soft text-danger-text",
        tone === "accent" && "bg-accent-soft text-accent-text",
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

/** A text field that keeps what is typed until the field is left or Enter is pressed, so half a word is never sent. */
export function TextField(props: {
  value: string;
  label: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== props.value) props.onCommit(next);
    else setDraft(props.value);
  };
  const shared = {
    value: draft,
    "aria-label": props.label,
    placeholder: props.placeholder,
    maxLength: props.maxLength,
    disabled: props.disabled,
    onBlur: commit,
    className: cn("w-full rounded-lg bg-sunken px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50", props.className),
  };
  return props.multiline ? (
    <textarea {...shared} rows={3} onChange={(e) => setDraft(e.currentTarget.value)} />
  ) : (
    <input
      {...shared}
      type="text"
      onChange={(e) => setDraft(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

export function Notice(props: { tone?: "info" | "error"; children: ReactNode }) {
  return (
    <p role={props.tone === "error" ? "alert" : undefined} className={cn("rounded-lg px-3 py-2 text-xs text-pretty", props.tone === "error" ? "bg-danger-soft text-danger-text" : "bg-sunken text-muted")}>
      {props.children}
    </p>
  );
}
