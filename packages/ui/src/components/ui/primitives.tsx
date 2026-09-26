import { clsx, type ClassValue } from "clsx";
import { Switch } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The platform's command modifier, spelled out in ASCII. */
export const MOD = isMac ? "Cmd" : "Ctrl";

export function Kbd(props: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-line bg-raised px-1 font-sans text-2xs font-medium text-muted",
        props.className,
      )}
    >
      {props.children}
    </kbd>
  );
}

export function Shortcut(props: { keys: string[]; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", props.className)} aria-hidden="true">
      {props.keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  );
}

export function Spinner(props: { size?: number; className?: string; label?: string }) {
  const size = props.size ?? 14;
  return (
    <span
      role={props.label ? "status" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
      className={cn("spin-ring shrink-0", props.className)}
      style={{ width: size, height: size }}
    />
  );
}

export function Shimmer(props: { children: ReactNode; className?: string }) {
  return <span className={cn("shimmer", props.className)}>{props.children}</span>;
}

/**
 * A switch. `label` names it for assistive tech, since the text beside it is often a description rather than a
 * label; `id` lets a visible label point at it as well.
 */
export function Toggle(props: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; id?: string; className?: string }) {
  return (
    <Switch.Root
      id={props.id}
      checked={props.checked}
      onCheckedChange={props.onChange}
      disabled={props.disabled}
      aria-label={props.label}
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-line-strong outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent",
        props.className,
      )}
    >
      <Switch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/0.3)] transition-transform duration-150 ease-out data-[state=checked]:translate-x-4" />
    </Switch.Root>
  );
}

type ButtonVariant = "primary" | "accent" | "secondary" | "ghost" | "danger";
type ButtonSize = "xs" | "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-inverse text-inverse-fg hover:opacity-90",
  accent: "bg-accent text-accent-fg hover:bg-accent-hover",
  secondary: "bg-raised text-fg shadow-btn hover:bg-hover",
  ghost: "text-muted hover:bg-hover hover:text-fg",
  danger: "text-danger-text shadow-[0_0_0_1px_var(--border-strong)] hover:bg-danger-soft",
};

const SIZES: Record<ButtonSize, string> = {
  /** Row controls in the dock cards: the smallest target that still reads as a button. */
  xs: "h-6 gap-1.5 rounded-md px-2 text-xs",
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-sm",
  md: "h-8 gap-2 rounded-lg px-3 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-[background-color,color,opacity,transform] duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={12} /> : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "xs" | "sm" | "md";
  active?: boolean;
}

const ICON_SIZES = { xs: "size-6 rounded-md", sm: "size-7 rounded-md", md: "size-8 rounded-lg" } as const;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "sm", active = false, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center text-muted transition-[background-color,color,transform] duration-150 ease-out hover:bg-hover hover:text-fg active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40",
        active && "bg-active text-fg",
        ICON_SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/**
 * The Ancilla mark on its navy tile, matching the app icon and favicon: an "A" of two round strokes
 * whose crossbar is a node. The geometry is copied from assets/brand/ancilla-mark.svg (logo.test.ts
 * keeps the two in step). Decorative: every use sits beside the product name or a heading.
 */
export function Logo(props: { size?: number; className?: string }) {
  const size = props.size ?? 22;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={props.className} aria-hidden="true">
      <rect width="32" height="32" rx="7.5" fill="oklch(0.25 0.045 280)" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="none" stroke="oklch(1 0 0 / 0.1)" />
      <path
        d="M8.25 22.5 L16 8.5 L23.75 22.5"
        fill="none"
        stroke="oklch(0.96 0.01 280)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="18.75" r="2" fill="oklch(0.72 0.15 255)" />
    </svg>
  );
}
