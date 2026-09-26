# Product

## Register

product

## Users

Developers who run Meta's Muse Code CLI and want a Codex, Claude desktop or T3 Code style surface for it. They usually have several agent threads going at once across a handful of repositories, often on Windows, natively or through WSL2, and they keep an editor and a terminal open alongside. They glance at Ancilla to see which threads need them, then go deep into one thread to read what the agent did, approve a command, answer a question, or steer the next step.

## Product Purpose

Ancilla is a desktop and web client for `muse serve`, forked from Helicon. It groups every thread by the project it ran in, shows which threads are working, waiting on the user, finished or failed, shows the subagents each thread has delegated to, and lets the user resume any session, including ones started from the terminal TUI. Success means the user never has to open the TUI to find, read, approve, or continue agent work, never loses track of a thread that is waiting on them, and never loses sight of a run because Muse's live feed went quiet.

## Brand Personality

Quiet, exact, trustworthy. The interface should feel like a well-made tool that stays out of the way: calm neutral surfaces, one blue accent reserved for action and live state, confident typography, and honest status. Emotional goal: the user feels in control of several agents at once, never surprised by what an agent did or is about to do.

## Anti-references

- Generic AI chat templates: centered chat bubble column with gradient avatars, sparkle icons, "How can I help you today?" hero.
- Terminal cosplay: `//` prefixes, snake_case labels, green-on-black, fake scanlines.
- Emojis in the UI, decorative gradients, glassmorphism, neon glows.
- Dashboard-card sprawl: nested rounded cards and identical tiles as the only hierarchy.
- Anything that hides what the agent actually ran or edited behind vague "Thinking" copy.

## Design Principles

1. **Status first.** Whether a thread is working, waiting on you, done, or failed is visible from the sidebar without opening it. When status comes from saved progress rather than the live feed, the thread says so.
2. **Show the work.** Commands, file edits, reasoning and results are legible and inspectable, never summarized away.
3. **Consent is explicit.** Approvals and questions from the agent are impossible to miss and quick to answer; nothing is auto-approved.
4. **Earned familiarity.** Follow the conventions of Codex, Claude desktop and T3 Code so the app feels known on first use; spend novelty only where it helps.
5. **One accent, used for meaning.** Color marks action and live state. Everything else is typographic hierarchy on neutral surfaces.

## Accessibility & Inclusion

WCAG 2.2 AA. Body and UI text at least 4.5:1 against its surface in both themes, visible focus rings on every control, full keyboard operation (thread navigation, composer, approvals, command palette), status never conveyed by color alone (icon plus label), and `prefers-reduced-motion` honored everywhere. Light and dark themes are both first class, following the system setting by default.
