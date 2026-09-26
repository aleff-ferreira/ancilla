# Design

The visual system behind Ancilla's web and desktop UI, inherited from Helicon. Strategy and audience live in [PRODUCT.md](PRODUCT.md); this file is the how.

## Visual theme

A calm agent workbench in the lineage of Codex, Claude desktop and T3 Code: a recessed sidebar, a centered transcript column, and a composer docked at the bottom. Neutral surfaces carry almost everything; one blue accent marks action, live state and focus. Light and dark are both first class and follow the system by default.

Physical scene: a developer at a desk in the evening, editor and terminal open beside Ancilla, glancing at the sidebar to see which agent threads need them before diving into one.

## Color

OKLCH throughout, cool neutrals tinted toward hue 255. Every text token clears WCAG AA (4.5:1) on every surface in both themes; this was checked with a contrast script, not eyeballed.

| Role | Token | Light | Dark |
| --- | --- | --- | --- |
| Canvas (transcript) | `--bg` | `oklch(0.992 0.002 255)` | `oklch(0.178 0.004 255)` |
| Sidebar (recessed) | `--bg-sidebar` | `oklch(0.967 0.004 255)` | `oklch(0.152 0.004 255)` |
| Raised (composer, cards, menus) | `--bg-raised` | `oklch(1 0 0)` | `oklch(0.215 0.005 255)` |
| Sunken (code, output) | `--bg-sunken` | `oklch(0.962 0.004 255)` | `oklch(0.148 0.004 255)` |
| Text | `--fg` | `oklch(0.2 0.01 255)` | `oklch(0.955 0.003 255)` |
| Secondary text | `--fg-muted` | `oklch(0.43 0.012 255)` | `oklch(0.76 0.008 255)` |
| Tertiary text | `--fg-subtle` | `oklch(0.5 0.012 255)` | `oklch(0.66 0.009 255)` |
| Accent (send, focus, running) | `--accent` | `oklch(0.55 0.19 257)` | `oklch(0.58 0.18 257)` |
| Accent text | `--accent-text` | `oklch(0.5 0.18 257)` | `oklch(0.76 0.12 252)` |
| Needs you | `--warn` / `--warn-text` | amber 70 | amber 75 |
| Failed | `--danger` / `--danger-text` | red 27 | red 25 |
| Done | `--ok` / `--ok-text` | green 150 | green 155 |

Hover and selection states are translucent overlays of the text color (`--bg-hover`, `--bg-active`), so they read correctly on any surface. Borders are hairline rings (`box-shadow: 0 0 0 1px`), and elevation is a ring plus a short layered shadow (`--elev-btn`, `--elev-card`); in dark mode the ring becomes a faint light edge.

Status is never color alone: every status glyph has a text label next to it or in its accessible name.

## Typography

| Role | Family | Use |
| --- | --- | --- |
| Interface | Inter Variable | Everything functional: sidebar, transcript, controls |
| Code | JetBrains Mono Variable | Commands, paths, diffs, output |
| Display | Newsreader Variable | Only first-run and empty-state headings (kept from Helicon, where it was a nod to the home of the Muses) |

Fixed rem scale, ratio about 1.1 to 1.2: 11, 12, 13, 14, 15, 17, 20, 26, 34 px. Agent prose is 15 px at 1.65 line height inside a 728 px column. Changing numbers use `tabular-nums`. Fonts are bundled, so the desktop app renders identically offline.

## Layout

- Sidebar 284 px by default, resizable 220 to 480 px, collapsible with Ctrl/Cmd+B.
- Interface zoom 70% to 200% in fixed steps with Ctrl/Cmd plus, minus and 0, persisted across launches.
- Main views share a 48 px top bar so switching between them never shifts content.
- Transcript and dock share one 776 px track (728 px of content) so the composer lines up with the conversation.
- Radii: 5 to 6 px for chips, 8 px for controls and rows, 12 px for cards and code, 16 to 18 px for the composer and request panels.

## Components

- **Sidebar rows**: status glyph column, title, and a right-side meta slot that shows relative time, or the live state as a word (Approve, Answer, Working, Failed). Hover reveals actions in place of the meta. Threads can be grouped by project (live threads float to the top of their project) or by status (Needs you, Working, Ready for review, Everything else).
- **Transcript turns**: a right-aligned prompt bubble; while running, every step inline with a live status line; once finished, the steps collapse into a "Worked for 54s" line with a summary, and the files the turn changed stay visible as diff chips.
- **Work-log rows**: icon, verb, and a chip holding the command or path; hovering swaps the icon for a chevron and the row expands to output, diffs or arguments.
- **Request panels**: approvals and questions sit directly above the composer with a warm ring, keyboard shortcuts (1 to 9), and plain-language titles ("Muse wants to run a shell command").
- **Composer**: model, reasoning effort and permission pickers, a context-window ring, and a single send button that morphs into stop while a turn runs. Enter queues a follow-up while Muse works; Ctrl/Cmd+Enter steers the running turn.
- **Agents panel**: a collapsible strip under the thread title with a count and a one-line summary (working, waiting, completed, failed, stopped, unknown). Expanded, it shows one card per subagent or workflow agent, working ones first, two columns once the thread is wide enough; finished agents fold behind a "Show N finished agents" control. When the view is stale, the strip reads "Last known activity", working cards read "Was working", and the spinner and accent stop.
- **Saved-progress notice**: when the live feed is unavailable, a sunken panel above the composer says "Syncing saved progress" with "Last checked" and "Progress updated" times and a Reload results button. It uses the neutral history icon, not the warning color, because nothing is wrong with the work itself.

## Motion

Motion only conveys state. Durations stay under 300 ms, with a strong ease-out (`cubic-bezier(0.23, 1, 0.32, 1)`). Keyboard-triggered actions and high-frequency hovers do not animate. Disclosures animate height with the `grid-template-rows: 0fr to 1fr` technique, icon swaps blur through each other, and toasts spring in and can be flicked away. `prefers-reduced-motion` removes movement and keeps color and opacity changes.

## Sourced components

Borrowed from open-source registries (all MIT) and adapted to these tokens; each file carries a credit comment.

| Piece | Source |
| --- | --- |
| Pixel-grid working indicator, expand grammar, rolling step counter, tool-chip rows, diff chips, question card, streaming caret | [Beautiful UI](https://beautifului.dev) |
| Icon blur swap (send and stop, copy and copied), animated toast stack | [beUI](https://beui.dev) |
| First-run folder illustration | [Rare UI](https://rareui.com) |
| Menus, dialogs, tooltips, popovers | [Radix UI](https://www.radix-ui.com) |
| Command palette | [cmdk](https://cmdk.paco.me) |
| Icons | [Phosphor](https://phosphoricons.com), bold weight, all imported through `packages/ui/src/components/ui/icons.ts` |
| Scroll anchoring | [use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom) |
