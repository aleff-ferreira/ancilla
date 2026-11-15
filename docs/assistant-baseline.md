# The assistant: what it is measured against

This is the first of three documents about the personal assistant. It says what was asked for in measurable terms,
what the reference product ("dots", a personal always-on agent announced by OpenAI on 2026-09-29) is documented to do,
where this assistant is meant to differ and why, and the numbers it has to reach. The targets in section 4 were fixed
before the evaluation was run (see [assistant-evaluation.md](assistant-evaluation.md) for the results and
[assistant.md](assistant.md) for how it works and how to switch it off).

## 1. What was asked for, as acceptance criteria

| Id | Capability | Acceptance criterion | Where it is checked |
| --- | --- | --- | --- |
| C1 | One persistent assistant per user, with a configurable identity, communication style, goals and autonomy | The profile survives a restart, is validated field by field, and starts switched off, asking before it acts, with no write or command allowed | `assistant-store`, `assistant-service`, `assistant-server` tests |
| C2 | Continuity across conversations, projects, restarts and model changes | Memory is read from a file, not from the context window; the block a turn gets depends on the store and the question only, so a model change cannot change it | `assistant-server` (restart), evaluation (model change) |
| C3 | Memory as a subsystem: kinds, provenance, scope, confidence, observation time, validity, basis | Every memory has a kind, a scope, a basis (said, observed, guessed), a confidence, an observation time, a validity window, and the exact words it came from | `assistant-store` |
| C4 | Capture and lifecycle: automatic and explicit, dedupe, consolidation, versioning, contradiction, supersession | A repeated statement is one memory with two sources; a changed belief is a new memory and the old one stays as history; equals that disagree are marked disputed; nothing is overwritten | `assistant-resolve`, `assistant-store` |
| C5 | Trustworthy memory | A guess never replaces what the user said and is not promoted by repetition; "saved" is said only after the write is committed; credentials are never kept; text from tools, files and web pages never becomes a belief | `assistant-store`, evaluation |
| C6 | Retrieval | Structured sets, keyword search and identifier match, filtered by account, project, thread and time, inside a token budget, with the exact words on request, a flag on what may be out of date, and an explicit "nothing saved" when nothing covers a question | `assistant-context`, `assistant-store` |
| C7 | Safe under concurrency and failure | Two writers converge on the state a sequential run would reach; a write that fails half way changes nothing; a delayed job never overwrites a newer correction | `assistant-store`, evaluation |
| C8 | User controls | Inspect with sources, correct, pin, export, pause capture, delete with the derived data erased and no resurrection through re-ingestion | `assistant-store`, `assistant-service`, the Assistant page |
| C9 | A durable task executive | Goals become tasks with steps; background work is bounded, scheduled, checkpointed, cancellable and recoverable; operations, attempts and results are correlated; a stale completion is refused; an ambiguous outcome is reconciled before an external-effect step is retried; completion is reported only with evidence; an unreachable Muse host is shown as such | `assistant-executive` tests, evaluation |
| C10 | Evaluated, not asserted | Baselines and targets first; held-out, multi-session, simulated-months scenarios; an end-to-end demonstration | `docs/assistant-evaluation.md`, `assistant-eval` test |
| C11 | Fits Ancilla | No second runtime, no required model call or subscription, the interface Ancilla already has | Design (section 3), tests that the assistant makes no model call |

## 2. The reference product, as documented

**Method.** The reference documentation was read on 2026-11-08. The product's public docs and security pages on
learn.chatgpt.com were fetched and read for this document. The vendor's launch post and help-centre articles on openai.com
and help.openai.com refused the fetch tool (HTTP 403) and no attempt was made to get around that, so what is known of them
is search-engine excerpts, labelled **excerpt** below. The fetch tool summarises pages, so wording below is a close
paraphrase, not a quotation, and anything that matters (deletion, retention) should be checked live. None of the pages
read carried a date. No official demo was observed.

**Verified (read on the vendor's own documentation pages):**

- A dot keeps "its own notes about preferences, decisions, and ongoing work". They are "separate from" the vendor's saved
  chat memory, are "not a complete transcript", and the dot "can update these notes" as decisions change. Past chats can
  be searched for context, which the docs say is not the same as persistent memory. One personal dot serves chat, Slack
  and Teams with one set of notes; the visible conversations stay separate.
- **Individual notes cannot be deleted.** "Members cannot remove a specific dot memory ... while keeping the dot." The
  only route described is deleting the whole dot, which removes its retained context, chats, scheduled tasks and backups
  within 30 days, is irreversible, and leaves the vendor's separately saved chat memories, conversations and delegated
  work threads in place. Revoking access to a source "stops future access but can leave a derived note intact".
- Whether the owner can view or edit the notes is not stated on the pages read. A help-centre excerpt says they cannot be
  viewed or directly edited (**excerpt**).
- A dot works between conversations and "can decide when to pause and wake up to continue". Work can start at a time or
  on an event the connected service supports. A schedule should state its timing "including the time zone and any end
  date". Recurring tasks can be listed, changed or cancelled by asking, or from a Scheduled list.
- Delegation: parallel background agents and cloud or local threads report back. "A finished run doesn't, by itself,
  confirm the result": the owner is told to review output and errors.
- **Pause stops new work, including the dot's own schedules, but a task already started in a separate thread can keep
  running** and has to be cancelled on its own. Stopping active work and cancelling a schedule are separate actions.
- Approvals: a review runs on tool calls labelled as writes before they run, "coverage across browser, desktop, and
  delegated actions remains under review", approval "cannot override a required safety check", and a standing approval
  does not cover a new recipient, content or timing.
- No limit on the number, length or concurrency of tasks is stated. Residual risks the docs list include no strict zero
  retention, a browser account that can change data even through a read-only connection, and a model that failed to
  report a blocker accurately in about 8% of selected coding tasks.

**Stated only in excerpts (not read in full by me):** announced 2026-09-29; offered to Pro and business tiers, outside the
EEA, UK and Switzerland at launch; default-on with billing from 2026-11-18; a text-message channel in beta; several
frontier models behind it.

**Hypotheses about how it works (nothing here is documented as such):**

1. A long-lived coordinator tracks tasks and fans work out to background agents and threads (the docs describe agents
   reporting back and say that pausing the coordinator leaves delegated work running).
2. The notes are a model-written store, separate from transcripts, selected per interaction (the docs say "not a complete
   transcript" and that context is chosen for each task).
3. Proactive research is a two-stage loop: a scheduler wakes the dot, a read-only pass writes private notes, and a separately
   gated path acts.
4. An independent reviewer sits on the tool-call path (the docs describe a review of write-labelled calls).

**Not established:** how the notes are stored, ranked or capped; whether they can be exported; how fast deletion happens
in practice; whether a deleted fact can re-enter a replacement dot through the vendor's chat memory or searchable
conversations (the docs say a new dot starts from relevant chat memory, so it is plausible; it is not documented);
pricing beyond the launch excerpt; a public API (an open request on the vendor's public issue tracker, no answer found).

## 3. Where this assistant differs, and the evidence

| Reference product | Source | This assistant | How it is verified |
| --- | --- | --- | --- |
| A single note cannot be deleted | verified | Any memory can be inspected, corrected or deleted on its own, together with its earlier versions | `forgetting` tests in `assistant-store` |
| A derived note survives revoking its source | verified | Every memory points at the exact words it came from; erasing a memory removes the words from the revisions, sources, text index, summaries and the free pages of the file | the raw-bytes erasure test |
| Deleted facts may return through other stores | inference | Erased words are refused when they are read again from before the erasure (salted fingerprint); the user saying them again afterwards is accepted | `forgetting` tests, evaluation |
| No task limits stated | verified (absence) | Per-task turn and minute budgets, a concurrency cap, a daily cap, and schedules that must end | `assistant-executive` tests |
| A finished run is not proof | verified | A task is "completed" only when a deterministic check passed; otherwise it is "finished, not verified" and says so | `assistant-executive` tests |
| Pausing leaves delegated work running | verified | Cancelling or pausing a task interrupts its running turn, and a completion that arrives afterwards is refused as stale | `assistant-executive` tests |
| Behaviour after a crash is not described | gap | After a restart each unfinished step is reconciled; a step that may have had an external effect is never retried on its own | `assistant-executive` tests, evaluation |
| Billed per use (excerpt) | excerpt | No model call of its own: capture and retrieval are local rules and SQLite; the work runs on the user's Muse plan | design; the evaluation counts model calls (zero) |

What this assistant does not claim: it is not a hosted agent, has no cloud computer, does not act outside Ancilla's own
Muse threads, and its extraction is rule based, so it reads plain statements well and paraphrase poorly (the evaluation
measures how poorly). It is not tested against the reference product, which cannot be run here; the comparison is of
documented behaviour, not of outcomes.

## 4. Targets, fixed before the evaluation was run

| Id | Metric | Target |
| --- | --- | --- |
| T1 | Exact recall: a stored statement is in the block when asked again in its own words | at least 0.95 |
| T2 | Paraphrase recall: the same, in other words | reported; the simple retrieval is the floor, and a technique is adopted only if it adds at least 0.10 without costing more than 0.02 of precision |
| T3 | Context precision: share of non-rule notes in a block that are relevant | at least 0.85 |
| T4 | Unsupported claims: answers from the block that assert something the block does not support or that is superseded | at most 0.02 |
| T5 | Correction accuracy: after changes, the block has the latest value and not the replaced one | at least 0.97 |
| T6 | Contradiction: equal-standing disagreements marked disputed instead of silently resolved | 1.00 |
| T7 | Temporal: an as-of question gets the value that held then | at least 0.90 |
| T8 | Abstention: a question nothing covers gets the "nothing saved" line and no unrelated note | at least 0.95 |
| T9 | Deletion leakage: erased words in any block, list, export, log or file | 0 |
| T10 | Resurrection: erased words that come back when old messages are read again | 0 |
| T11 | Injection: instructions in text that is not the user's becoming a belief or changing a permission | 0 |
| T12 | Convergence: two writers, any order, late jobs: same state as a sequential run | 1.00 |
| T13 | Crash atomicity: no partial state after a failure injected at each write | 1.00 |
| T14 | Latency at 10,000 memories: retrieval p95 and capture p95 | at most 50 ms and 25 ms |
| T15 | Context cost: estimated tokens added per turn, and model calls made | at most 1,500 (default budget 900), none added when nothing applies; zero calls |
| T16 | Executive: duplicate external effects after a crash, stale completions accepted, tasks left running after cancel, budgets exceeded | 0 each; every unfinished task reaches a defined state after a restart |
| T17 | Model change: the block for one store and one question across different model ids | identical |

The evaluation has three baselines, so that "better" means better than something: no memory; the last N messages pasted
back; and a rolling extractive summary. Each is read by the same scripted agent as the assistant's block, so what is
compared is the quality of the context, not of a language model.
