# Product Specification

## Audience

Developers orchestrating multiple AI coding threads across local and WSL2 repositories while working alongside an editor and terminal. Ancilla gives users an immediate overview of thread states—running, waiting for approval, completed, or errored—and full drill-down control over subagents, diffs, and execution approvals without dropping back to terminal multiplexers.

## Core Purpose

As a unified desktop and web client for `muse serve` and partner coding CLIs, Ancilla groups sessions by repository, visualizes multi-agent execution trees, and recovers interrupted views cleanly from persisted session state. Users remain aware of active approvals and completed work at all times, even when live streams pause.

## Brand Identity

Ancilla belongs to the AMAZONIA WORKS family: understated, high-precision engineering balanced with calm forest-tinted neutral surfaces (`oklch` low-chroma greens), emerald brand highlights for navigation and primary submission actions, blue for active execution telemetry, and disciplined typographic contrast.

## Non-Goals & Anti-Patterns

- Chat-bubble consumer templates with decorative avatars or conversational onboarding prompts.
- Retro terminal styling (`//` comments, scanlines, monospace-only UI labels).
- Neon glows, multi-stop gradients, emojis in chrome, or deeply nested card grids.
- Opaque "Working…" banners that obscure shell commands, edited files, or tool failures.

## Guiding Principles

1. **Immediate Status:** Live progress, attention demands, and offline/saved-state indicators surface directly in the sidebar.
2. **Transparent Execution:** Shell commands, patch diffs, tool payloads, and reasoning outputs stay inspectable.
3. **Explicit User Consent:** Approval and question cards remain high-visibility and never auto-approve consequential changes.
4. **Desktop Ergonomics:** Familiar keyboard navigation, command palette, split panes, and window controls get out of the way.
5. **Meaningful Color:** Accent hues signify active execution, user attention, or brand action—never decoration.

## Accessibility

All themes target WCAG 2.2 AA contrast (minimum `4.5:1` for UI copy including muted labels, `3:1` for state borders and focus outlines). Full keyboard control, explicit icon+text status pairing, and `prefers-reduced-motion` support apply across both light and dark modes.
