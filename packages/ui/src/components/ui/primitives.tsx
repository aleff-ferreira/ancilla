import { clsx, type ClassValue } from "clsx";
import { Switch } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export function cn(...inputs: ClassValue[]): string {
  return clsx(...inputs);
}

export const isMac: boolean = typeof navigator !== "undefined" && Boolean(navigator.platform?.includes("Mac") || /Mac|iPhone|iPad/i.test(navigator.userAgent));

/** The platform's command modifier, spelled out in ASCII. */
export const MOD = isMac ? "Cmd" : "Ctrl";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  const base = "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-line bg-raised px-1 font-sans text-2xs font-medium text-muted";
  return <kbd className={cn(base, className)}>{children}</kbd>;
}

export function Shortcut({ keys, className }: { keys: readonly string[] | string[]; className?: string }) {
  return <span className={cn("inline-flex items-center gap-0.5", className)} aria-hidden="true">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>;
}

export function Spinner({ size = 14, className, label }: { size?: number; className?: string; label?: string }) {
  const isAria = Boolean(label);
  return <span role={isAria ? "status" : undefined} aria-label={label} aria-hidden={isAria ? undefined : true} className={cn("spin-ring shrink-0", className)} style={{ width: size, height: size }} />;
}

export function Shimmer({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("shimmer", className)}>{children}</span>;
}

export function Toggle({ checked, onChange, label, disabled, id, className }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; id?: string; className?: string }) {
  return (
    <Switch.Root id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} className={cn("relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full bg-line-strong outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent", className)}>
      <Switch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/0.3)] transition-transform duration-150 ease-out data-[state=checked]:translate-x-4" />
    </Switch.Root>
  );
}

export type ButtonVariant = "primary" | "accent" | "secondary" | "ghost" | "danger";
export type ButtonSize = "xs" | "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant; size?: ButtonSize; loading?: boolean;
}

function resolveButtonClasses(v: ButtonVariant, s: ButtonSize): string {
  let style = "";
  switch (v) {
    case "primary": style = "bg-inverse text-inverse-fg hover:opacity-90"; break;
    case "accent": style = "bg-accent text-accent-fg hover:bg-accent-hover"; break;
    case "secondary": style = "bg-raised text-fg shadow-btn hover:bg-hover"; break;
    case "ghost": style = "text-muted hover:bg-hover hover:text-fg"; break;
    case "danger": style = "text-danger-text shadow-[0_0_0_1px_var(--border-strong)] hover:bg-danger-soft"; break;
  }
  switch (s) {
    case "xs": style += " h-6 gap-1.5 rounded-md px-2 text-xs"; break;
    case "sm": style += " h-7 gap-1.5 rounded-md px-2.5 text-sm"; break;
    case "md": style += " h-8 gap-2 rounded-lg px-3 text-sm"; break;
  }
  return style;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = "secondary", size = "md", loading = false, className, children, disabled, type = "button", ...rest
}, ref) {
  const base = "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-[background-color,color,opacity,transform] duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45";
  return <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading ? true : undefined} className={cn(base, resolveButtonClasses(variant, size), className)} {...rest}>
      {loading && <Spinner size={12} />}
      {children}
    </button>;
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string; size?: "xs" | "sm" | "md"; active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  label, size = "sm", active = false, className, children, type = "button", ...rest
}, ref) {
  const sizeMap: Record<"xs" | "sm" | "md", string> = { xs: "size-6 rounded-md", sm: "size-7 rounded-md", md: "size-8 rounded-lg" };
  const base = "inline-flex shrink-0 items-center justify-center text-muted transition-[background-color,color,transform] duration-150 ease-out hover:bg-hover hover:text-fg active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40";
  return <button ref={ref} type={type} aria-label={label} className={cn(base, active && "bg-active text-fg", sizeMap[size], className)} {...rest}>
      {children}
    </button>;
});

export function Logo({ size = 22, className }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="7.5" fill="#0B1F18" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="none" stroke="oklch(1 0 0 / 0.1)" />
      <path d="M8.25 22.5 L16 8.5 L23.75 22.5" fill="none" stroke="#EEF5EE" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="18.75" r="2" fill="#34D399" />
    </svg>;
}
