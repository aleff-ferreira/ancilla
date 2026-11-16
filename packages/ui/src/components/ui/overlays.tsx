import { Dialog as RDialog, DropdownMenu, Tooltip as RTooltip } from "radix-ui";
import { CaretRightIcon, CheckIcon, XIcon } from "./icons.js";
import { forwardRef, type ReactElement, type ReactNode } from "react";
import { Shortcut, cn } from "./primitives.js";

export const FLOATING = Object.freeze({ collisionPadding: 12, sticky: "always" as const });

export type TooltipProviderProps = { children: ReactNode };
export function TooltipProvider({ children }: TooltipProviderProps) {
  return <RTooltip.Provider delayDuration={450} skipDelayDuration={250}>{children}</RTooltip.Provider>;
}

export type TipProps = { label: ReactNode; shortcut?: readonly string[] | string[]; side?: "top" | "right" | "bottom" | "left"; align?: "start" | "center" | "end"; children: ReactElement };

export const Tip = forwardRef<HTMLElement, TipProps>(function Tip({ label, shortcut, side = "bottom", align = "center", children, ...rest }, ref) {
  const shortcutDisplay = shortcut ? <Shortcut keys={shortcut} className="opacity-80 [&_kbd]:border-transparent [&_kbd]:bg-white/15 [&_kbd]:text-inverse-fg" /> : null;
  const tipClasses = "pop z-[var(--z-tooltip)] flex max-w-[min(360px,calc(100dvw-24px))] items-center gap-2 rounded-md bg-inverse px-2 py-1 text-xs font-medium text-inverse-fg";

  return <RTooltip.Root>
      <RTooltip.Trigger ref={ref as never} asChild {...rest}>{children}</RTooltip.Trigger>
      <RTooltip.Portal><RTooltip.Content side={side} align={align} sideOffset={6} {...FLOATING} className={tipClasses}>{label}{shortcutDisplay}</RTooltip.Content></RTooltip.Portal>
    </RTooltip.Root>;
});

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuRadioGroup = DropdownMenu.RadioGroup;
export const MenuSub = DropdownMenu.Sub;

const MENU_BOX_STYLE = "pop z-[var(--z-dropdown)] max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[min(360px,calc(100dvw-24px))] min-w-[208px] overflow-y-auto rounded-xl bg-raised p-1 text-sm text-fg shadow-pop outline-none";
const MENU_ROW_STYLE = "relative flex min-h-8 cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none select-none data-[highlighted]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-40";

export type MenuContentProps = { children: ReactNode; align?: "start" | "center" | "end"; side?: "top" | "right" | "bottom" | "left"; className?: string; sideOffset?: number };

export function MenuContent({ children, align = "start", side = "bottom", className, sideOffset = 6 }: MenuContentProps) {
  return <DropdownMenu.Portal><DropdownMenu.Content align={align} side={side} sideOffset={sideOffset} {...FLOATING} className={cn(MENU_BOX_STYLE, className)}>{children}</DropdownMenu.Content></DropdownMenu.Portal>;
}

export type MenuItemProps = { icon?: ReactNode; children: ReactNode; hint?: ReactNode; tone?: "default" | "danger"; disabled?: boolean; keepOpen?: boolean; onSelect?: () => void };

export function MenuItem({ icon, children, hint, tone, disabled, keepOpen, onSelect }: MenuItemProps) {
  const isDestructive = tone === "danger";
  const iconSpan = icon ? <span className={cn("flex size-4 shrink-0 items-center justify-center", isDestructive ? "text-danger-text" : "text-muted")}>{icon}</span> : null;
  const hintSpan = hint ? <span className="shrink-0 text-xs text-subtle">{hint}</span> : null;

  return <DropdownMenu.Item
      disabled={disabled}
      onSelect={(evt) => {
        if (keepOpen) evt.preventDefault();
        onSelect?.();
      }}
      className={cn(MENU_ROW_STYLE, isDestructive && "text-danger-text")}
    >
      {iconSpan}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hintSpan}
    </DropdownMenu.Item>;
}

export type MenuOptionProps = { value: string; icon?: ReactNode; label: ReactNode; description?: ReactNode; badge?: ReactNode; disabled?: boolean };

export function MenuOption({ value, icon, label, description, badge, disabled }: MenuOptionProps) {
  const iconNode = icon ? <span className="mt-px flex size-4 shrink-0 items-center justify-center text-muted">{icon}</span> : null;
  const descNode = description ? <span className="mt-0.5 block text-xs leading-snug text-pretty text-muted [overflow-wrap:anywhere]">{description}</span> : null;

  return <DropdownMenu.RadioItem value={value} disabled={disabled} className={cn(MENU_ROW_STYLE, "items-start py-2")}>
      {iconNode}
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-2"><span className="truncate font-medium">{label}</span>{badge}</span>
        {descNode}
      </div>
      <DropdownMenu.ItemIndicator className="mt-0.5 shrink-0 text-accent-text"><CheckIcon size={14} /></DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>;
}

export type MenuCheckProps = { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; description?: ReactNode };

export function MenuCheck({ checked, onChange, children, description }: MenuCheckProps) {
  const descElement = description ? <span className="mt-0.5 block text-xs leading-snug text-muted">{description}</span> : null;

  return <DropdownMenu.CheckboxItem
      checked={checked}
      onCheckedChange={(val) => onChange(val === true)}
      onSelect={(evt) => evt.preventDefault()}
      className={cn(MENU_ROW_STYLE, "items-start py-2")}
    >
      <div className="min-w-0 flex-1"><span className="block">{children}</span>{descElement}</div>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <DropdownMenu.ItemIndicator className="text-accent-text"><CheckIcon size={14} /></DropdownMenu.ItemIndicator>
      </span>
    </DropdownMenu.CheckboxItem>;
}

export type MenuLabelProps = { children: ReactNode };
export function MenuLabel({ children }: MenuLabelProps) {
  return <DropdownMenu.Label className="px-2 pt-1.5 pb-1 text-xs font-medium text-subtle">{children}</DropdownMenu.Label>;
}

export type MenuSubTriggerProps = { icon?: ReactNode; children: ReactNode; hint?: ReactNode; disabled?: boolean };

export function MenuSubTrigger({ icon, children, hint, disabled }: MenuSubTriggerProps) {
  const iconBox = icon ? <span className="flex size-4 shrink-0 items-center justify-center text-muted">{icon}</span> : null;
  const hintBox = hint ? <span className="shrink-0 text-xs text-subtle">{hint}</span> : null;

  return <DropdownMenu.SubTrigger disabled={disabled} className={cn(MENU_ROW_STYLE, "data-[state=open]:bg-hover")}>
      {iconBox}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hintBox}
      <CaretRightIcon size={12} className="shrink-0 text-subtle" aria-hidden="true" />
    </DropdownMenu.SubTrigger>;
}

export type MenuSubContentProps = { children: ReactNode; className?: string };
export function MenuSubContent({ children, className }: MenuSubContentProps) {
  return <DropdownMenu.Portal><DropdownMenu.SubContent sideOffset={4} alignOffset={-4} {...FLOATING} className={cn(MENU_BOX_STYLE, className)}>{children}</DropdownMenu.SubContent></DropdownMenu.Portal>;
}

export function MenuSeparator({ className }: { className?: string } = {}) {
  return <DropdownMenu.Separator className={cn("mx-1 my-1 h-px bg-line", className)} />;
}

function ScrimOverlay() {
  return <RDialog.Overlay className="overlay-fade fixed inset-0 z-[var(--z-overlay)] bg-[oklch(0.1_0.01_255/0.45)]" />;
}

export type SheetProps = { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: ReactNode; children: ReactNode; className?: string };

export function Sheet({ open, onOpenChange, title, description, children, className }: SheetProps) {
  const sheetContainerClass = cn("sheet-in fixed inset-y-0 right-0 z-[var(--z-modal)] flex w-[min(560px,100vw)] flex-col bg-raised text-fg shadow-pop outline-none", className);
  const descMarkup = description ? (
    <RDialog.Description className="mt-0.5 text-xs text-pretty text-muted">{description}</RDialog.Description>
  ) : (
    <RDialog.Description className="sr-only">{title}</RDialog.Description>
  );

  return <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <ScrimOverlay />
        <RDialog.Content className={sheetContainerClass}>
          <header className={cn("flex shrink-0 items-start gap-3 border-b border-line px-5 py-4")}>
            <div className="min-w-0 flex-1">
              <RDialog.Title className="text-base font-semibold tracking-[-0.01em]">{title}</RDialog.Title>
              {descMarkup}
            </div>
            <RDialog.Close aria-label="Close" className="-m-1 shrink-0 rounded-lg p-1 text-subtle transition-colors duration-100 hover:bg-hover hover:text-fg"><XIcon size={16} /></RDialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>;
}

export type ModalProps = { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: ReactNode; children: ReactNode; className?: string; hideTitle?: boolean; bare?: boolean };

const MODAL_BASE_CLASS = "modal-pop fixed left-1/2 z-[var(--z-modal)] -translate-x-1/2 rounded-2xl bg-raised text-fg shadow-pop outline-none";

export function Modal({ open, onOpenChange, title, description, children, className, hideTitle, bare }: ModalProps) {
  function guardAutoFocus(evt: Event) {
    const targetEl = evt.target instanceof HTMLElement ? evt.target : null;
    const ancillaRoot = targetEl?.closest(".ancilla-app");
    if (ancillaRoot && !ancillaRoot.contains(document.activeElement)) {
      evt.preventDefault();
    }
  }

  function guardFocusOutside(evt: Event) {
    const currentEl = evt.currentTarget instanceof HTMLElement ? evt.currentTarget : null;
    const ancillaRoot = currentEl?.closest(".ancilla-app");
    if (!ancillaRoot) return;
    const dest = evt.target instanceof Node ? evt.target : null;
    if (dest && !ancillaRoot.contains(dest)) {
      evt.preventDefault();
    }
  }

  const modalClasses = cn(MODAL_BASE_CLASS, bare ? "p-0" : "p-5", className ?? "top-[14vh] w-[min(520px,calc(100%-32px))]");

  const descElement = description ? (
    <RDialog.Description className="mt-1 text-sm text-muted">{description}</RDialog.Description>
  ) : (
    <RDialog.Description className="sr-only">{title}</RDialog.Description>
  );

  return <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <ScrimOverlay />
        <RDialog.Content onOpenAutoFocus={guardAutoFocus} onFocusOutside={guardFocusOutside} className={modalClasses}>
          <RDialog.Title className={cn("text-lg font-semibold tracking-[-0.01em]", hideTitle && "sr-only")}>{title}</RDialog.Title>
          {descElement}
          {children}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>;
}
