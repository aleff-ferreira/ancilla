# Ancilla visual identity refinement

Status: core refinement implemented (phases 1–4). Optional linework in phase 5 is deferred.

Reviewed 27 September 2026 against Ancilla `e4b8e27` and Helicon `2fca6174fbd957e33984c88b3123d0e0907db61f`.

The diagnosis and candidate palette below record the pre-implementation analysis. The accepted
values and current component conventions are maintained in [DESIGN.md](DESIGN.md).

### Implementation notes

- Added separate brand, selection and focus tokens; retained the existing runtime, status, chart,
  syntax and diff color declarations. Explicit focus styles, including resize handles, Crew
  roster indicators and the connection form, use the focus role. No controller or navigation
  behavior changed.
- Adopted locally bundled Fraunces at the existing display sites, updated the mark across UI and
  generated assets, and refined Home, Composer, sidebar, palette, Settings, Usage and Crew surfaces.
- Kept the composer's focus edge at 1 px after visual review. Adjusted tertiary text to lightness
  0.49 in light mode and 0.67 in dark mode, and light-theme brand text to `#096651`, to retain
  contrast after active and selected fills are composited. The sampled neutral/brand text pairs
  clear 4.62:1 in dark mode and 4.70:1 in light mode across base, hover, active and selected fills.
- Captured the real demo in both themes, at 768/1100/1440 px widths and the 70%/200% zoom extremes,
  including Welcome, enabled send, Settings, Usage, Command Palette and Crew. Home's heading and
  composer bounds match the baseline at the three sampled widths. Palette remains 620 px wide
  with 36 px items and now has the intended 12 px corners.
- Refreshed the representative product screenshots and the brand/design documentation. The shared
  TypeScript packages and web production build compile. No test suites were run; this visual pass
  does not constitute a complete accessibility audit or native desktop verification.

Current previews: [Home](assets/home.png), [Home in light mode](assets/home-light.png),
[Welcome](assets/welcome.png), [Command Palette](assets/palette.png), and [Crew](assets/crew-panel.png).

## Recommendation

Keep Ancilla's workbench geometry and interaction model. Differentiate it through forest-tinted near-black surfaces, a restrained emerald brand accent, the existing original A-and-node mark, a limited Fraunces display treatment, and finer selection and panel edges. Use Crew's cells, phase rails, and explicit execution states as the product's own structural vocabulary.

The result should be recognizable in an ordinary thread screenshot, with Home providing a slightly more expressive introduction. A marketing-style hero is unnecessary.

## Evidence and baseline diagnosis

The initial comparison used the checked-in Home, Thread, Command Palette, Settings, and Usage screenshots in both repositories, Ancilla's Crew screenshots, source at the revisions above, and all six supplied AMAZONIA WORKS screenshots. Screenshot dimensions differ between repositories, so density and geometry conclusions use CSS rather than image scale. Some original screenshots preceded Crew integration and palette actions; source governed component placement and behavior. The implementation previews linked above were captured afterward and replace Ancilla's older checked-in screenshots.

| Area | Helicon and Ancilla evidence at the baseline | Conclusion |
| --- | --- | --- |
| Global color | Every shared token in the light root block (55) and dark override block (54) has the same value in [Ancilla's theme](../apps/web/src/theme.css) and [the reviewed Helicon theme](https://github.com/HarjjotSinghh/helicon/blob/2fca6174fbd957e33984c88b3123d0e0907db61f/apps/web/src/theme.css). Ancilla adds derived Crew tokens. | Renaming the application and changing its icon has not yet established an independent base palette. |
| Typography | Both import Inter, JetBrains Mono, and Newsreader. [Home](../packages/ui/src/components/home/Home.tsx) retains the same serif heading, blue project link, and centered composer composition. | Typography remains a strong visible family resemblance. Retain the useful serif/sans division while changing the display voice. |
| Navigation and commands | [Sidebar](../packages/ui/src/components/sidebar/Sidebar.tsx) uses rounded gray active rows. [Command Palette](../packages/ui/src/components/palette/CommandPalette.tsx) selects an item using the ordinary hover fill. | Selection styling is a small, frequent opportunity for differentiation. |
| Composer | [Composer](../packages/ui/src/components/composer/Composer.tsx) has an 18 px outer radius, neutral focus shadow, blue send action, and the inherited toolbar arrangement. | Change the enclosure and action color; the existing command workflow already works. |
| Secondary pages | [Settings](assets/settings.png) and [Usage](assets/usage.png) add Ancilla features but retain inherited raised cards, rounded segmented controls, and tonal hierarchy. | Later refinement should address surfaces and hierarchy without changing page structure. |
| Native identity | [Crew panel](assets/crew-panel.png) and [completion report](assets/crew-done.png) already use agent cells, phase rails, sigils, ruled metrics, timeline hatching, and a restrained serif completion headline. | These are the strongest existing Ancilla-specific visual cues and the bridge to the parent brand's systems language. |

### What the AMAZONIA WORKS references contribute

The supplied screenshots are local reference material in `amazonia_works_refs/`, which is not
published with the product. The identifiers below are the timestamps in their filenames.

| Reference | Transferable cue | Product interpretation |
| --- | --- | --- |
| 142634: introduction | Near-black forest ground, warm pale text, emerald emphasis, editorial serif against functional sans. | Slightly green neutrals, sparse emerald actions, selected display headings. |
| 142757: roots | Fine connected strands and branching structure. | At most one small static illustration in an existing empty-state art region. |
| 142806: manifesto and systems | River, root, mycelium, and neural diagrams; disciplined captions and rules. | Abstract connected nodes, small metadata labels, clear grouping; avoid literal forest imagery throughout the app. |
| 142813: services | Thin ruled grid, short emerald edge accents, compact square identifiers. | Strongest reference for product panels and selections. Keep the line discipline, with Ancilla's existing density. |
| 142822: projects | Technical plates, restrained card edges, cream/ink contrast. | A subtle mineral-paper light theme and precise panel borders. |
| 142833: process | Connected stages and small structural nodes. | Reinforces Crew's existing phase rail; retain actual execution phase names and counts. |

The local parent-site source confirms `#070d0b` background, `#0b1f18` canopy, `#34d399` emerald, `#6ee7b7` mint, `#eef5ee` ink, and fine green-tinted rules. It also identifies the display face as **Fraunces**, with **Inter** body text and **JetBrains Mono** metadata. Evidence: local sibling files `amazonia_WORKS_source/site-src/build/page.css` and `page.head.html`. These exact values come from source; the adapted product values below are proposals.

Transfer the palette logic, serif/sans contrast, and structural precision. Exclude the site's enormous typography, floating glass navigation, luminous 3D scene, particles, moving grain, cursor effects, scrolling wordmark, large whitespace, and animated gradients. Gold remains an attention color in Ancilla.

## Fixed constraints

- Sidebar remains 284 px by default, resizable from 220 to 480 px, with its current grouping, collapse behavior, project hierarchy, and footer.
- Transcript and dock retain their shared 776 px track and 728 px content width at the existing wider breakpoint. Preserve narrow-layout padding, transcript spacing, prompt bubbles, and 15 px prose.
- Home retains its 720 px container and composer placement. The 48 px top bar and existing navigation remain intact.
- Composer controls, order, wrapping, send/queue/stop behavior, attachment handling, and keyboard shortcuts stay intact.
- Command Palette retains its 620 px maximum width, 48 px input, 36 px items, groups, filtering, and keyboard model.
- Settings retains its 720 px container; Usage retains its 980 px container, ranges, cards, and chart arrangement.
- Preserve light, dark, system theme, zoom, independent code themes, and web/desktop parity.
- Work stays in shared styling, components, and brand assets. Controllers, protocol, state folding, and runtime behavior do not need changes.

## Color architecture

Do not turn the existing `--accent` token green globally. It currently carries live activity, Crew hatching, usage series, focus, links, toggles, and send actions. A blind substitution would change the meaning of multiple independent systems.

| Role | Proposed ownership |
| --- | --- |
| Brand, navigation selection, intentional user actions | New `--brand`, `--brand-hover`, `--brand-fg`, `--brand-text`, `--brand-soft`, and `--brand-line`; emerald/teal. |
| Keyboard focus | New `--focus-ring`, independently contrast-checked. Default to the accessible brand foreground; provide separation around filled brand controls. |
| Selected row | New `--selection-bg` and `--selection-line`, used only by explicitly selected navigation/command rows. |
| Live execution | Retain existing blue `--accent*` values and current Crew derivations. Document these as compatibility/runtime tokens during this rollout. |
| Completion, approval, failure, user input | Preserve `--ok*`, `--warn*`, `--danger*`, and `--status-input`. Keep glyphs and labels; brand emerald must never be the sole signal of success. |
| Charts, syntax, diffs | Keep existing data and syntax colors. In particular, Usage `SERIES` is based on `--accent` mixes; it is not simply the `--chart-*` palette. |

### Candidate palette for the first visual pass

Values are conservative starting points, not a claim of finished visual approval. Store them in the existing OKLCH system; hex previews are approximate.

| Token | Current dark | Proposed dark | Proposed light |
| --- | --- | --- | --- |
| `--bg` | `oklch(0.178 0.004 255)` | `oklch(0.178 0.009 175)` ≈ `#0d1211` | `oklch(0.992 0.002 170)` |
| `--bg-sidebar` | `oklch(0.152 0.004 255)` | `oklch(0.152 0.008 175)` ≈ `#080d0b` | `oklch(0.967 0.004 170)` |
| `--bg-raised` | `oklch(0.215 0.005 255)` | `oklch(0.220 0.012 175)` ≈ `#151c1a` | White, as today |
| `--bg-sunken` | `oklch(0.148 0.004 255)` | `oklch(0.148 0.008 175)` ≈ `#070c0a` | `oklch(0.962 0.004 170)` |
| `--fg` | `oklch(0.955 0.003 255)` | `oklch(0.955 0.008 160)` | `oklch(0.200 0.010 170)` |
| `--fg-muted` | `oklch(0.760 0.008 255)` | `oklch(0.760 0.010 165)` | `oklch(0.430 0.012 170)` |
| `--fg-subtle` | `oklch(0.660 0.009 255)` | `oklch(0.660 0.012 165)` | `oklch(0.500 0.012 170)` |
| Brand fill / ink | Existing blue action | `#34d399` / `#0b1f18` | `#0b7862` / white |
| Brand text | Existing blue link | `#6ee7b7` | `#0b7862` |

Retint `--bg-hover`, `--bg-active`, inverse surfaces, scrollbar, and border hues consistently, initially keeping their current alpha/lightness hierarchy. Use approximately 8–10% brand tint for selected fills, backed by a solid selection marker. Fine structural separators remain low emphasis; focus and meaningful state indicators need stronger contrast.

Analytical sRGB contrast calculations for the proposed solid colors give a minimum of **5.58:1 dark / 5.35:1 light** for tertiary text across the four base surfaces; primary and secondary text are higher. Dark ink on the emerald button gives **8.93:1**; white on the same emerald gives only **1.92:1**. The light-theme green with white gives **5.42:1**. These calculations do not cover translucent hover/selection composites, every status color, code themes, or actual font rendering.

## Implementation phases

Scope estimates count source areas, not generated assets. Small changes usually touch one or two component files plus theme rules; medium changes cross shared styles, assets, or dependencies. Risk reflects visual and interaction reach, even when the code diff is short. Ship each numbered change independently where practical.

### Phase 1 — Shared tokens and semantic separation

#### 1. Retint neutral surfaces

- **Current hooks:** [theme.css](../apps/web/src/theme.css), `:root` / dark blocks at lines 15 and 89, neutral/elevation tokens; [DESIGN.md](DESIGN.md), Color section.
- **Before → after:** Cool hue-255 charcoal and blue-gray whites become almost-black forest neutrals and faint mineral whites. Preserve the recessed sidebar, raised composer/menu/card hierarchy, and current foreground brightness. Use flat fills and fine rules.
- **Why:** Changes every everyday screenshot away from Helicon's exact palette while adopting the parent brand's dark-green atmosphere at much lower saturation than its hero artwork.
- **Scope / risk:** Small diff, medium visual risk: one shared stylesheet and documentation, affecting both web and desktop.
- **Guardrails:** Do not lower muted text opacity. Check all neutral overlays and code surfaces after compositing. Keep elevation changes scoped to the later named cards; a global shadow rewrite would also affect dialogs, requests, and toasts.

#### 2. Add brand and focus roles

- **Current hooks:** `theme.css` token blocks, `@theme inline`, `::selection`, and `:focus-visible`; explicit focus classes in `home/Home.tsx`, `sidebar/Sidebar.tsx`, `composer/Composer.tsx`, `settings/SettingsPage.tsx`, and `ui/primitives.tsx`.
- **Before → after:** One blue family serves brand, focus, and activity. Add the brand/selection/focus roles above and Tailwind mappings; migrate named static affordances in subsequent phases. Move keyboard focus and text selection to their own tokens, keeping the current outline thickness and offset.
- **Why:** Emerald makes the product recognizably part of AMAZONIA WORKS, while blue continues to communicate execution activity. Separate tokens make future adjustments local and predictable.
- **Scope / risk:** Medium: theme plus an explicit focus-consumer pass. Highest semantic risk in the plan.
- **Guardrails:** Inventory all literal `var(--accent)`, `outline-accent`, and `ring-accent` uses. Update focus-only uses without changing adjacent checked/runtime classes. Preserve warning rings, status glyphs, chart series, Crew cells, and generic neutral `Button` primary styling. Ensure focus remains visible around an already-emerald send button using outline offset or a separating surface ring.

### Phase 2 — Home, product mark, and display typography

#### 3. Refine Home and existing empty states

- **Current hooks:** [Home.tsx](../packages/ui/src/components/home/Home.tsx), `DISPLAY`, `NewThread`, `ProjectSwitcher`, `Welcome`, and `Onboarding`; [FolderArt.tsx](../packages/ui/src/components/home/FolderArt.tsx); theme `--folder-*` tokens.
- **Before → after:** Blue project-link emphasis becomes brand-text emerald; keep its underline and dropdown affordance. Recent rows move from 8 to 6 px corners and use the new restrained hover treatment. Recolor the folder art to forest/teal and pale paper, preserving its existing footprint. Introduce the existing A mark subtly on the folder's front face or first page, rather than adding another hero block.
- **Why:** Replaces recognizable Helicon color cues in the opening composition and connects the product's own mark to the parent's technical-organic palette.
- **Scope / risk:** Small to medium: Home, FolderArt, and existing art tokens. Low behavioral risk, medium balance/readability risk.
- **Guardrails:** Keep Home's width, title size, margins, recent-row height, and composer position. FolderArt is an interactive button that focuses the project-path field: preserve its label, focus, click action, and reduced-motion behavior. Keep error/boot instructions functional. Any tiny mark in the art is decorative and has no additional action.

#### 4. Adopt a restrained Fraunces display face

- **Current hooks:** `theme.css` font imports and `--font-display`; [apps/web/package.json](../apps/web/package.json) and the root lockfile; `Home.tsx` `DISPLAY`; [Transcript.tsx](../packages/ui/src/components/thread/Transcript.tsx) `EmptyThread`; [ThreadView.tsx](../packages/ui/src/components/thread/ThreadView.tsx) missing-thread state; [ActivityDrawer.tsx](../packages/ui/src/components/crew/ActivityDrawer.tsx) empty state; `.crew-landed > h2` in `theme.css` at line 1821.
- **Before → after:** Newsreader becomes locally bundled Fraunces, initially regular roman around weight 400, only at the existing display sites. Keep the current 34 px Home and 26 px empty/completion scales. Keep Inter for interface, transcript, data, and sidebar; keep JetBrains Mono for commands and identifiers.
- **Why:** Fraunces is verified parent-brand typography and differentiates Ancilla from Helicon's explicitly inherited Newsreader treatment. Its controlled use preserves the existing editorial contrast.
- **Scope / risk:** Medium: dependency/import/token change plus a small, fully enumerated consumer audit. Isolate this from the color delivery so it can be reverted independently.
- **Guardrails:** Font metrics can wrap long project names differently and shift the composer. Compare current and proposed line breaks at normal and narrow widths and zoom before accepting the change; adjust display tracking or optical sizing only. Bundle required weights locally, avoid loading duplicate display families in the final build, and update dependency notices. Do not add italic project names or serif labels to dense controls. If metrics cannot preserve the existing composition, retain Newsreader for that delivery and defer the font change.

#### 5. Strengthen the original Ancilla mark

- **Current hooks:** [primitives.tsx](../packages/ui/src/components/ui/primitives.tsx) `Logo`, line 159; [Sidebar.tsx](../packages/ui/src/components/sidebar/Sidebar.tsx) `SidebarTop`, line 77; [ancilla-mark.svg](../assets/brand/ancilla-mark.svg), [brand README](../assets/brand/README.md), [generate-icons.py](../scripts/generate-icons.py); [About.tsx](../packages/ui/src/components/settings/About.tsx).
- **Before → after:** Navy tile and blue node become a deep forest tile and emerald node, retaining the exact A geometry and pale strokes. Increase the sidebar mark from 20 to 22 px inside the same 32 px header row; retain the compact sans wordmark. Add one understated “An AMAZONIA WORKS product” line in About, and use the recolored mark at existing onboarding/logo locations.
- **Why:** Ancilla keeps its own recognizable symbol while color and endorsement establish the parent relationship. This is more durable differentiation than decorative background art.
- **Scope / risk:** Medium: coordinated source SVG, React mark, generator palette, documentation, and generated favicon/desktop/banner assets. Low UX risk; medium consistency risk.
- **Guardrails:** The generator hard-codes tile/node colors as well as reading geometry; editing only the SVG would leave stale blue assets. Retain the current simple path/circle geometry supported by the generator. Check small-icon node separation. Preserve license and Helicon attribution links in About. Avoid adding an endorsement row to the sidebar or enlarging its header.

### Phase 3 — Daily interaction surfaces

#### 6. Make the composer enclosure more precise

- **Current hooks:** [Composer.tsx](../packages/ui/src/components/composer/Composer.tsx), outer class at line 351, textarea at 427, toolbar at 431, and send/stop styling at 462.
- **Before → after:** Reduce only the outer radius from 18 to 14 px. Retain the raised surface, use a cleaner fine perimeter, and replace the neutral focus shadow with a clearly visible brand focus edge. Enabled send/queue/research actions use brand fill and matching brand ink. Stop remains inverse; disabled remains neutral. Keep the circular 32 px action control.
- **Why:** A slightly squarer enclosure and restrained emerald action make the dock feel like a precise instrument in the parent family and remove two prominent Helicon cues.
- **Scope / risk:** Small: one component plus scoped theme roles. Medium visual/interaction risk because Home and every thread share it.
- **Guardrails:** No padding, textarea minimum/maximum height, toolbar gaps, control order, attachment layout, or footer changes. Do not add a divider that reduces textarea room or adds height. Preserve send/queue/stop distinctions, disabled treatment, and visible focus on individual controls. Avoid glow and animated perimeter effects.

#### 7. Replace the sidebar's gray selection plate

- **Current hooks:** [Sidebar.tsx](../packages/ui/src/components/sidebar/Sidebar.tsx), `NavRow` at 105, project-row hover at 329, and `ThreadRow` at 600; its full-row focus pseudo-element is at 636.
- **Before → after:** Selected nav/thread rows use a faint brand-tinted fill, a short 2 px inset leading marker, and 6 px corners. Hover remains quieter and primarily neutral. Keep the selected title readable in foreground ink, with status color confined to its existing glyph/metadata.
- **Why:** Changes the familiar full gray rounded selection treatment to the thin edge accents visible in the parent's service grid. The compact row form also harmonizes with Crew.
- **Scope / risk:** Small: one component and shared selection roles. Medium interaction risk around focus, hover actions, and nested controls.
- **Guardrails:** Preserve row heights, indentation, glyph positions, truncation, drag/drop targets, and metadata. Keep the marker inside existing space and clear of the status glyph. Coordinate its radius and stacking with the full-row focus pseudo-element; keyboard focus must remain independently visible on a selected row. Do not color every project name green.

#### 8. Refine Command Palette hierarchy and selection

- **Current hooks:** [CommandPalette.tsx](../packages/ui/src/components/palette/CommandPalette.tsx), `GROUP`, `ITEM`, `Item`, modal class, input wrapper, and list; shared [overlays.tsx](../packages/ui/src/components/ui/overlays.tsx) `Modal` supplies the current 16 px radius.
- **Before → after:** Replace selected-equals-hover gray with the shared subtle selection fill and inset marker. Item corners become 6 px; apply a palette-specific 12 px modal radius. Keep headings at 12 px, align hint text consistently, and use fine group separators and the existing input separator with clearer tonal hierarchy. Absorb separator space into current group padding.
- **Why:** Carries the same precise, lightly ruled language into a frequent global surface without creating a new command interface.
- **Scope / risk:** Small: palette component plus scoped classes. Low layout risk, medium keyboard-state risk.
- **Guardrails:** Preserve input/list dimensions, item heights, command order, active-descendant semantics, filtering, scrolling, and shortcuts. Styling must follow `data-selected` for keyboard as well as pointer input. Avoid reducing shortcut contrast. Override radius on this instance instead of changing every Modal.

### Phase 4 — Settings, Usage, and Crew consistency

#### 9. Refine Settings card and label hierarchy

- **Current hooks:** [SettingsPage.tsx](../packages/ui/src/components/settings/SettingsPage.tsx), `Pick` at 18, `Section` at 46, `Row` at 55; `About` endorsement is covered in change 5.
- **Before → after:** Section cards move from 16 to 12 px corners with a thin structural border and less shadow. Keep the current row padding and separators. Raise 11 px tracked section captions to a restrained 12 px treatment without adding vertical space. Give selected `Pick` options a subtle brand-tinted edge while retaining their inset grouping and raised selected surface.
- **Why:** Fine ruled groups and clearer small labels echo the parent service grid while moving away from Helicon's soft card styling.
- **Scope / risk:** Small: page helpers and scoped styles. Low risk, with shared-helper reach across many preferences.
- **Guardrails:** Keep control sizes, horizontal overflow, row wrapping, descriptions, section order, warning copy, and destructive states. Do not globally recolor toggles or change preference behavior. No serif control labels and no global spacing compression.

#### 10. Refine Usage as a scientific readout

- **Current hooks:** [UsagePage.tsx](../packages/ui/src/components/usage/UsagePage.tsx), range selector, `Card` at 263, `Totals` at 273, `DailyChart` at 297, `Models` at 338, `Threads` at 377, `EmptyUsage` at 410; [PlanMeter.tsx](../packages/ui/src/components/usage/PlanMeter.tsx), empty and loaded meter cards.
- **Before → after:** Unify card edges at 12 px: existing metric/chart cards are already approximately there, while 16 px plan cards tighten to match. Use the same fine rules and reduced shadow as Settings, consistent heading/metadata alignment, and the shared restrained selected treatment for time ranges. Keep all numbers in sans with tabular alignment.
- **Why:** The page becomes more coherent with Crew's ruled metrics and the parent's technical plates, while its established dashboard remains recognizable.
- **Scope / risk:** Small to medium: two files and shared surface styling. Low layout risk; medium risk if data colors are accidentally swept into branding.
- **Guardrails:** Keep chart dimensions, model-series distinctions, legends, tooltip values, range choices, account meters, and stale-data labels. Preserve `SERIES`, `FILL`, warning thresholds, and estimates/disclaimers. Use no decorative grid behind data and no serif metric numerals. Do not recolor the chart green just to match the logo.

#### 11. Carry Crew's existing visual discipline across surfaces

- **Current hooks:** [CrewCard.tsx](../packages/ui/src/components/crew/CrewCard.tsx), [PhaseRail.tsx](../packages/ui/src/components/crew/PhaseRail.tsx), [Strip.tsx](../packages/ui/src/components/crew/Strip.tsx), [CrewLine.tsx](../packages/ui/src/components/crew/CrewLine.tsx), [RosterRow.tsx](../packages/ui/src/components/crew/RosterRow.tsx), and `.crew-*` styles in `theme.css`.
- **Before → after:** Keep existing phase cells, sigils, hatching, progress counts, and execution-state colors. Harmonize only the Crew card's 16 px outer radius to the 12 px secondary-card family and the nonsemantic borders to the new rules. Reuse its compact label/count alignment and ruled metric treatment in the named Settings/Usage changes. Its existing completion headline participates in the display-font audit.
- **Why:** Extends an identity already specific to Ancilla and gives the parent's connected-systems language a truthful operational expression.
- **Scope / risk:** Small cosmetic change; medium semantic sensitivity. No model/controller changes and no new data consumers.
- **Guardrails:** Do not spread live phase rails or micro-status cells into unrelated screens. Reuse real components only where the same state data already exists. Preserve working blue, approval/input/failure distinctions, stale-feed desaturation, “no update” hatching, stopped clocks, and existing reduced-motion behavior. Do not rename phases using botanical metaphors.

### Phase 5 — Optional symbolic detail

#### 12. Add one restrained linework motif only if needed

- **Current hooks:** [FolderArt.tsx](../packages/ui/src/components/home/FolderArt.tsx) internal `Page` SVG and `Welcome`; optional new small SVG asset under `assets/brand` plus a decorative line token.
- **Before → after:** The existing page-art region can carry a few static branch/node or river-contour lines in place of some decorative text bars. Keep the illustration's footprint and existing interactions. This is the only proposed new botanical/network artwork.
- **Why:** Gives a subtle parent-brand reference that is unique to Ancilla without competing with active work. The roots/process screenshots support this translation.
- **Scope / risk:** Small and independently removable; low performance risk for a tiny inline SVG, medium clutter/affordance risk.
- **Guardrails:** Treat linework as `aria-hidden` and noninteractive within the existing button; no additional focus target, listeners, filters, canvas, animation, or external image request. Never place it behind transcript text, command input, diffs, approval controls, or charts. Do not imitate live Crew cells or progress states. If phases 1–4 already establish sufficient identity, omit this phase.

## Review criteria

These criteria guided the implementation review. The implementation notes above record the completed captures and measurements; a full accessibility audit and native desktop review remain outside that pass.

1. Capture the existing demo at the same viewport, scale, theme, and data before and after each delivery. Include Home, Welcome/onboarding, normal thread, long title, full composer toolbar, Command Palette, Settings, Usage, and Crew running, waiting, failed, stale, and completed states. Reuse the current demo harness rather than a parallel UI mockup.
2. Compare layout bounds: sidebar, top bar, transcript track, composer width/placement, command item height, and existing responsive behavior. Include minimum and maximum sidebar sizes and the supported zoom extremes. A typeface substitution must not create avoidable extra headline lines or truncate controls.
3. Measure foreground/background contrast after alpha compositing. Keep normal text at least 4.5:1 and meaningful component/state indicators at least 3:1 against adjacent colors. Decorative rules can remain faint only when they do not carry essential identification. [W3C text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [W3C non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).
4. Check keyboard selection versus focus, selected-row hover actions, palette active items, composer disabled/send/queue/stop states, folder activation, and reduced motion. Preserve status labels so the emerald brand and green completion state cannot be confused through hue alone.
5. Review independent code themes, diff colors, and chart legends on the tinted backgrounds. Record any necessary contrast fix separately instead of silently broadening the redesign.
6. Confirm fonts and marks work offline in web and desktop, and that font changes do not increase cold-load cost unnecessarily. Keep the original SVG/React geometry contract and generated icon colors in sync.
7. Update `docs/DESIGN.md` and `assets/brand/README.md` alongside accepted changes, including the separate brand, focus and runtime roles. Refresh representative product screenshots only after the implementation stabilizes.

### Delivery order and stopping point

Start with tokens and semantic roles, then Home/branding, with the display-font change isolated. Deliver Composer, Sidebar, and Command Palette as separate small changes. Follow with Settings/Usage and Crew surface consistency. Review ordinary work screens before deciding whether any new linework is necessary.

Success means that palette, mark, typography, selection edges, and the command dock identify Ancilla as an AMAZONIA WORKS product while the user can navigate and work exactly as before. The primary identity work is complete without phase 5.
