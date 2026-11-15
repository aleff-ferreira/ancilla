import type { JSX, ReactNode } from "react";
import { useApp, useController } from "../app/context.js";
import { CaptionSpacer, useOverlayDragProps, useTitlebarOverlay } from "../app/frame.js";
import { SidebarSimpleIcon } from "./ui/icons.js";
import { Tip } from "./ui/overlays.js";
import { IconButton, MOD, cn } from "./ui/primitives.js";

export interface TopBarProps {
  children?: ReactNode;
  className?: string;
}

const SIDEBAR_SHORTCUT: string[] = [MOD, "B"];

/**
 * Toggles visibility of the sidebar navigation pane when currently collapsed.
 */
export function SidebarToggle(): JSX.Element | null {
  const { toggleSidebar } = useController();
  const isCollapsed = useApp((app) => app.prefs.sidebarCollapsed);

  if (!isCollapsed) return null;

  return (
    <Tip label="Show sidebar" shortcut={SIDEBAR_SHORTCUT}>
      <IconButton
        label="Show sidebar"
        onClick={() => toggleSidebar()}
        children={<SidebarSimpleIcon size={16} />}
      />
    </Tip>
  );
}

/**
 * macOS traffic light window button spacer when running in custom frameless overlay mode.
 * Allocates 68px width so main view controls clear traffic light controls when sidebar is closed.
 */
export function TrafficLightSpacer(): JSX.Element | null {
  const isFramelessMac = useTitlebarOverlay();
  const isCollapsed = useApp((state) => state.prefs.sidebarCollapsed);

  if (!isFramelessMac || !isCollapsed) return null;

  return <span aria-hidden="true" className={cn("w-[68px]", "shrink-0")} />;
}

/**
 * Common 48px top navigation bar shared across all primary views.
 * Supports window dragging, traffic light spacing, sidebar toggling, and caption controls.
 */
export function TopBar({ children, className }: TopBarProps): JSX.Element {
  const dragAttributes = useOverlayDragProps();
  const barClass = cn("flex h-12 shrink-0 items-center gap-2 px-3", className);

  return (
    <header data-drag-region {...dragAttributes} className={barClass}>
      <TrafficLightSpacer key="traffic-light-spacer" />
      <SidebarToggle key="sidebar-toggle" />
      {children}
      <CaptionSpacer key="caption-spacer" />
    </header>
  );
}
