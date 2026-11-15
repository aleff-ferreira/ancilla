# Design System

This specification defines the visual tokens, typography, layout structure, and motion behavior for Ancilla across desktop and web targets ([PRODUCT.md](PRODUCT.md)).

## Visual Palette

Ancilla uses low-chroma forest neutral surfaces paired with emerald brand tokens (`--brand*`) and blue execution indicators (`--accent*`). Light and dark appearances follow system preferences by default and maintain >=4.5:1 text contrast after overlay compositing.

| Token Role | CSS Custom Property | Light Value | Dark Value |
| --- | --- | --- | --- |
| Primary Canvas | `--bg` | `oklch(0.992 0.002 170)` | `oklch(0.178 0.009 175)` |
| Recessed Sidebar | `--bg-sidebar` | `oklch(0.967 0.004 170)` | `oklch(0.152 0.008 175)` |
| Elevated Surface | `--bg-raised` | `oklch(1 0 0)` | `oklch(0.22 0.012 175)` |
| Sunken Code / Well | `--bg-sunken` | `oklch(0.962 0.004 170)` | `oklch(0.148 0.008 175)` |
| Primary Foreground | `--fg` | `oklch(0.2 0.01 170)` | `oklch(0.955 0.008 160)` |
| Muted Text | `--fg-muted` | `oklch(0.43 0.012 170)` | `oklch(0.76 0.01 165)` |
| Subtle Text | `--fg-subtle` | `oklch(0.49 0.012 170)` | `oklch(0.67 0.012 165)` |
| Brand Action | `--brand` / `--brand-fg` | `#0b7862` / `#ffffff` | `#34d399` / `#0b1f18` |
| Brand Link Text | `--brand-text` | `#096651` | `#6ee7b7` |
| Live Runtime | `--accent` / `--accent-text` | `oklch(0.55 0.19 257)` / `oklch(0.5 0.18 257)` | `oklch(0.58 0.18 257)` / `oklch(0.76 0.12 252)` |
| Attention / Fail / Pass | `--warn*` / `--danger*` / `--ok*` | Amber 70 / Red 27 / Green 150 | Amber 75 / Red 25 / Green 155 |

Selection highlights (`--selection-bg`, `--selection-line`) and focus outlines (`--focus-ring`) remain independent from semantic status tints. Elevated cards (`Settings`, `Usage`, `Crew`) apply `shadow-panel` hairline rings rather than heavy drop shadows.

## Typography & Scale

- **UI Interface:** `Inter Variable` (11–20 px modular scale; 15 px at `1.65` line height for transcript prose inside a `728 px` track, with `tabular-nums` for changing figures).
- **Code & Diffs:** `JetBrains Mono Variable`.
- **Display Headings:** `Fraunces Variable` at `26 px` / `34 px` for onboarding, empty states, and Crew summary headlines.

Fonts are packaged locally so desktop and offline renders stay uniform across platforms.

## Spatial Layout & Surfaces

- **Sidebar & Top Bar:** `284 px` resizable sidebar (`220–480 px`, `Ctrl/Cmd+B`) paired with a consistent `48 px` header bar across primary views and configurable zoom (`70%–200%`).
- **Transcript Column & Dock:** Aligned `776 px` outer track (`728 px` content width) keeping messages, approval cards (`16 px` radius), and the composer (`14 px` radius) flush.
- **Crew Card & Panel:** Thread-scoped live progress cards in the dock (`44 px` collapsed summary bar with segmented step/phase spine) and a `520 px` (`400–800 px`) docked/overlay Crew panel tracking multi-agent timelines, KPI metrics, deterministic 5x5 agent sigils, and saved-progress notices.

## Motion Choreography

Transitions communicate state transitions cleanly within `<300 ms` (`cubic-bezier(0.23, 1, 0.32, 1)`), reserving `440 ms` for plan step completions and `260 ms` CSS grid-row disclosures (`0fr` to `1fr`). Numeric digit rolls debounce updates inside a `700 ms` window, `prefers-reduced-motion` suppresses translational animation, and spinners halt automatically when streams go stale.

## UI Dependencies

| Capability | Package |
| --- | --- |
| Popovers, dialogs, menus, tooltips | `radix-ui` |
| Command palette | `cmdk` |
| UI iconography | `@phosphor-icons/react` (re-exported via `packages/ui/src/components/ui/icons.ts`) |
| Icon transitions & overlay springs | `motion` |
| Transcript auto-scroll anchoring | `use-stick-to-bottom` |
