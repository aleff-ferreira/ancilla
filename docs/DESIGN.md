# Design

The visual system behind Ancilla's web and desktop UI. Its workbench structure comes from Helicon; its forest palette, emerald brand accent and editorial display face place it in the AMAZONIA WORKS family. Strategy and audience live in [PRODUCT.md](PRODUCT.md); this file is the how.

## Visual theme

A calm agent workbench: a recessed sidebar, a centered transcript column, and a composer docked at the bottom. Forest-tinted neutral surfaces carry almost everything. Emerald identifies the brand, navigation selection and send action; blue continues to carry live execution and operational controls. Light and dark are both first class and follow the system by default.

Physical scene: a developer at a desk in the evening, editor and terminal open beside Ancilla, glancing at the sidebar to see which agent threads need them before diving into one.

## Color

OKLCH throughout, with low-chroma forest neutrals around hue 165–175. Normal text targets at least 4.5:1 contrast, including muted text on selected and hovered surfaces. Foreground/background contrast must be measured after compositing translucent fills. Meaningful state and focus indicators need at least 3:1 against adjacent colors; decorative separators can remain faint.

| Role | Token | Light | Dark |
| --- | --- | --- | --- |
| Canvas (transcript) | `--bg` | `oklch(0.992 0.002 170)` | `oklch(0.178 0.009 175)` |
| Sidebar (recessed) | `--bg-sidebar` | `oklch(0.967 0.004 170)` | `oklch(0.152 0.008 175)` |
| Raised (composer, cards, menus) | `--bg-raised` | `oklch(1 0 0)` | `oklch(0.22 0.012 175)` |
| Sunken (code, output) | `--bg-sunken` | `oklch(0.962 0.004 170)` | `oklch(0.148 0.008 175)` |
| Text | `--fg` | `oklch(0.2 0.01 170)` | `oklch(0.955 0.008 160)` |
| Secondary text | `--fg-muted` | `oklch(0.43 0.012 170)` | `oklch(0.76 0.01 165)` |
| Tertiary text | `--fg-subtle` | `oklch(0.49 0.012 170)` | `oklch(0.67 0.012 165)` |
| Brand action | `--brand` / `--brand-fg` | forest `#0b7862` / white | emerald `#34d399` / forest `#0b1f18` |
| Brand text | `--brand-text` | forest `#096651` | mint `#6ee7b7` |
| Runtime accent | `--accent` | `oklch(0.55 0.19 257)` | `oklch(0.58 0.18 257)` |
| Runtime text | `--accent-text` | `oklch(0.5 0.18 257)` | `oklch(0.76 0.12 252)` |
| Needs you | `--warn` / `--warn-text` | amber 70 | amber 75 |
| Failed | `--danger` / `--danger-text` | red 27 | red 25 |
| Done | `--ok` / `--ok-text` | green 150 | green 155 |

Hover and generic active fills remain translucent neutral overlays (`--bg-hover`, `--bg-active`). Navigation and command selection use `--selection-bg` plus a short solid `--selection-line`; they do not recolor status glyphs. `--focus-ring` owns keyboard focus independently of status and selection. White ink must not be used on the dark theme's bright emerald button.

Borders are fine rings (`box-shadow: 0 0 0 1px`). Settings, Usage and Crew cards use `shadow-panel`, a flat structural edge; menus and request surfaces retain their existing elevation. Brand refinements do not change syntax, diff colors, chart series, warning thresholds, or operational toggle states. The legacy `--accent*` names remain blue for those existing consumers.

Status is never color alone: every status glyph has a text label next to it or in its accessible name.

## Typography

| Role | Family | Use |
| --- | --- | --- |
| Interface | Inter Variable | Everything functional: sidebar, transcript, controls |
| Code | JetBrains Mono Variable | Commands, paths, diffs, output |
| Display | Fraunces Variable | Home, first-run and empty-state headings, plus the Crew completion headline; regular roman at the existing 26/34 px scale |

Fixed rem scale, ratio about 1.1 to 1.2: 11, 12, 13, 14, 15, 17, 20, 26, 34 px. Agent prose is 15 px at 1.65 line height inside a 728 px column. Changing numbers use `tabular-nums`. Fonts are bundled, so the desktop app renders identically offline.

## Layout

- Sidebar 284 px by default, resizable 220 to 480 px, collapsible with Ctrl/Cmd+B.
- Interface zoom 70% to 200% in fixed steps with Ctrl/Cmd plus, minus and 0, persisted across launches.
- Main views share a 48 px top bar so switching between them never shifts content.
- Transcript and dock share one 776 px track (728 px of content) so the composer lines up with the conversation.
- Radii: 5 to 6 px for chips and navigation/command rows, 8 px for ordinary controls, 12 px for cards and code, 14 px for the composer; request panels retain their existing 16 px corners.

## Components

- **Sidebar rows**: status glyph column, title, and a right-side meta slot that shows relative time, or the live state as a word (Approve, Answer, Working, Failed). Selection is a quiet emerald tint and inset marker; keyboard focus has a separate outline. Hover reveals actions in place of the meta. Threads can be grouped by project (live threads float to the top of their project) or by status (Needs you, Working, Ready for review, Everything else).
- **Transcript turns**: a right-aligned prompt bubble; while running, every step inline with a live status line; once finished, the steps collapse into a "Worked for 54s" line with a summary, and the files the turn changed stay visible as diff chips.
- **Work-log rows**: icon, verb, and a chip holding the command or path; hovering swaps the icon for a chevron and the row expands to output, diffs or arguments.
- **Request panels**: approvals and questions sit directly above the composer with a warm ring, keyboard shortcuts (1 to 9), and plain-language titles ("Muse wants to run a shell command").
- **Composer**: a 14 px enclosure with a fine edge and a visible brand focus ring. Model, reasoning effort and permission pickers, a context-window ring, and a single emerald send button that morphs into an inverse stop control while a turn runs. Enter queues a follow-up while Muse works; Ctrl/Cmd+Enter steers the running turn.
- **Crew card and panel**: a thread with a live workflow, subagent or background task gets one card in the dock, and none otherwise. Collapsed, it is a 44 px line per run or task: status glyph, the run's name, a strip of one cell per agent grouped by phase, `Judge · 6 of 10`, chips only when something needs you, failed or has gone quiet, and the elapsed time. Expanded: a head, a phase rail (an accordion with one phase open), the attention list (waiting on you, then failed, then no update) with Review, Retry, Skip and Stop on the rows, the open phase's compact rows and the task rows. Every agent carries a sigil, a deterministic 5×5 mirrored pixel mark derived from its name, on a tile that takes the status colour; hue stays reserved for status. When the run ends the card becomes the completion report: a Fraunces headline ("All ten landed."), a fact line, stats, at most four highlights, a "Where the time went" fingerprint and the report's first lines, with one 900 ms sheen along the strip only when every agent landed. The Crew panel takes the files panel's slot (520 px, resizable 400 to 800; docked while the thread keeps 560 px, else an overlay over a scrim): a summary sentence, a six-cell KPI strip with a pulse sparkline, the Timeline (one lane per agent under phase bands, retries on the same lane, hatched no-update tails, a now line), filter chips, a roster grouped by phase and an inspector inside the panel (a column beside the roster past 760 px). The Activity drawer slides over the sidebar. A stale feed freezes every clock, removes the accent from cells, stops spinners and prefixes "Last known". Cells fill in place (200 ms), counts roll (320 ms), working sigils breathe (2.4 s, at most twelve on screen, none under reduced motion); nothing else pulses except the needs-you glyph.
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
