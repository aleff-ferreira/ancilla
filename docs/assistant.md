# The assistant

Ancilla's assistant is a memory and a task executive that sit beside Muse. The memory keeps what you told it, with the
exact words, so a thread no longer starts from nothing. The executive takes work you approve and sees it through, one
step at a time, in a thread you can open. It adds no model of its own and no second runtime: Muse still does all the
thinking, on your plan. It is also someone: you give it a name, a face and a voice in a short first meeting, and it is
the same character in the sidebar, on its own page and beside the composer (see [the assistant as a
character](#the-assistant-as-a-character)).

It is **off until you switch it on**, and until you do there is no file on disk and no code of it running.

Related: [what it is measured against](assistant-baseline.md), [how well it does](assistant-evaluation.md).

![The assistant's home: its face on a lit stage, what it would do next, the rules it follows and what you have shared](assets/assistant-home.png)

## Switching it on

Open the Assistant page from the sidebar footer and turn it on. That creates `assistant.db` in Ancilla's data folder
(next to `ancilla.db`) and nothing else. From then on:

- what you type in a thread is read for things worth keeping (rules, preferences, decisions, deadlines, facts about you);
- the notes that bear on each message are put in front of the prompt as a short block of reference data, and the thread
  keeps showing the words you typed;
- you can open any note, see the exact words it came from, correct it, pin it, or erase it.

**What it costs.** Capture and retrieval are local rules and SQLite: no model call, no network. A turn carries at most
the assistant's context budget (900 estimated tokens by default, 300 to 4,000), and nothing at all when no note applies
and you have not set an identity or goals. The Assistant page can show the exact block for any question before you send it.

**What it will not keep.** Passwords, API keys, tokens, card numbers, bank accounts and national ID numbers are refused,
and the refusal says why without repeating them.

## The Assistant page

Open it from the card under Search in the sidebar, from the brain icon in the footer, or at `#/assistant`. The switch at
the top turns the assistant on and off. Before it has been set up, the page opens on its first meeting (see below). Off,
the page says what it is and what it keeps, and a notice says how many saved notes are waiting unused. On, it has five
tabs.

- **Home.** The assistant itself: its face on a lit stage, its name, what kind of voice it has, and the line it opens with,
  worked out from what is true now (what waits on you, what it is doing, or that all is quiet). Under it, what the two of
  you have shared, what it would do next, the standing rules it follows (the rules in its memory, in your words) and your
  history together.
- **Memory.**
  - *What it keeps*: pause or resume remembering, add a note yourself, export everything as a file, tidy up (merge
    duplicates, let passing notes expire, write the monthly roll-ups), or erase everything.
  - *Notes*: Current (what it believes now), Needs you (disputes and notes waiting for your approval) and History
    (beliefs that were replaced, shown with what replaced them), with a kind filter and a search. Each row says who said
    it, how long ago, and flags such as Disputed, Unconfirmed guess, May be out of date and In every prompt. Opening a
    row shows the exact words, the sources, the earlier versions and what it replaced, and lets you correct it, pin it,
    confirm it ("Still true"), settle a dispute ("This one is right"), approve a waiting note, or forget it.
  - *What the model is told*: type a question and see the block that would go in front of it and why each note is in
    it, without sending anything.
  - *What changed*: the audit log of every change and who made it.
- **Tasks.** Give it a task (a goal, a project, whether it may change files, and steps that each end in a check), see
  what it would do next (or what is waiting on you, when initiative is Ask first), and watch open tasks with Pause,
  Resume, Cancel, Try again, Give it more room and "It is right". Finished tasks say whether the result was checked.
  Repeating work lives here too, each with its time zone and an end.
- **Persona.** Who it is, saved as you go: name, a few words of your own about it, its look (form, variant, colour, glow),
  its voice (a temperament and five dials, with sample lines that answer the dials at once), what it calls you, up to four
  habits, how it replies in threads (tone, length, language, notes) and where it shows up. A preview of its face and
  opening line follows you down the page when the window is tall enough, and each of its moods can be tried on it.
- **Settings.** Goals, initiative (Ask first, Suggest, Act within limits), whether it may start read-only work on its
  own, whether a task may be given write access, the limits on how much it may spend, and how large the notes block may be.

![Memory: each note with who said it and when, and whether it is disputed or a guess](assets/assistant-memory.png)

![The Persona tab, saved as you go: name, look, voice and habits](assets/assistant-persona.png)

The page reads again on its own when the server announces a change. In any page, a save, a replacement, a refusal (a
credential, or remembering paused) and a question about which of two notes you meant show as a short message.

## The assistant as a character

The assistant has a name, a face and a voice that you choose, so the thing that remembers for you is also someone you
recognise. It is the same character in the sidebar, on its page and beside the composer. None of it changes what the
assistant may do or what is true.

### The first meeting

Until an assistant has been set up, the sidebar shows a card under Search that says "Meet your assistant", with a light
moving round its border (the small cross on the card says "not now": it stops the light and the card keeps asking in
words). The Assistant page opens on four steps:

1. **Hello**: what it is, what it may keep, and what to call it.
2. **Look**: a form, its variant, a colour and how much it glows, with the face in front of you changing as you choose.
3. **Voice**: a temperament and five dials, with sample lines that change as you move them.
4. **Wake it**: what is stored and where, and how much it may do on its own.

**Nothing is saved, and nothing is switched on, until the last step**, so leaving half way leaves everything as it was.
An assistant that was switched on before it had a face gets the same meeting.

![The first meeting's Look step: a form, a colour and a glow, with the face changing as you choose](assets/assistant-meeting.png)

The [90-second tour](assets/ancilla-tour.mp4) starts with this meeting.

### The face

A face is a small description (a form, a variant, a hue, a glow and a seed) that the interface draws as a living thing.
There are five forms, each with four variants: **Halo** (a core of light held by turning rings), **Optic** (a lens that
blinks and follows the pointer), **Hologram** (a figure drawn in light), **Critter** (a small creature that speaks with
its eyes) and **Cipher** (a sigil that wakes when it has something to tell you). Any hue and any glow can be chosen, and
a few touches, such as when it blinks, come from the seed, so two faces side by side do not move as one.

It has six moods and they are the plain facts of the moment: resting, working (a turn or a task is running), wanting you
(an approval, a question or a task waits on you), pleased (a note was kept, a turn finished), concerned (a turn failed, a
note was refused) and asleep (the assistant is switched off). It sleeps only after it has been set up and switched off:
before that it is awake and waiting for you. A pleased or concerned face shows for a few seconds and then returns to
what it was doing.

It is drawn as SVG and CSS, so there are no images to download and nothing leaves the machine. It is named for a screen
reader ("Ancilla, an ice halo with a bright glow, resting"), and with reduced motion it keeps its colours and its mood
and stops moving.

### The voice

A voice is a **temperament** (steady, warm, dry, sharp, playful, formal, curious, or your own words) and five **dials**,
each from 0 to 4: warmth, humor, directness, curiosity and formality. Choosing a temperament sets the dials to its own,
and each dial can then be moved. You can also set what it calls you and up to four **habits** in your own words (for
example, "Signs off with 'Standing by.'"), each at most 80 characters.

What the assistant says in the interface (an opening line, a line when a turn finishes, the card in the sidebar) is
**written in advance**: for each moment and each temperament there is a plain line and a warmer or wittier one, and the
dials choose between them. No model is asked, so these lines cost nothing, say the same thing every time for the same
state, and cannot invent anything. They are plain ASCII, and none of them claims a feeling as a fact.

### Where it shows up

- **The sidebar**: the card under Search, with its face and one plain line ("Ready", "Working", "2 need you"), and a badge
  when something waits on you. It can be hidden (then a small icon in the footer opens the page).
- **Home**: its face on a stage, its name, its voice in a few words and the line it opens with.
- **Beside the composer**: a small face that works while a turn runs, wants you when something waits, is pleased when a
  turn finishes and concerned when it fails, with a short line in its voice for a few seconds. It says nothing the run
  card does not, and it can be switched off on the Persona tab.

### What Muse is told

The Persona tab sets how much of the character reaches the model: **Off** (the voice stays in Ancilla's own words),
**A line of tone** (the default: one line, such as "Voice: dry and understated. Accuracy comes first.") or **The whole
character** (its name, the voice, the dials, what it calls you and the habits). An assistant that has not been set up
adds nothing to a prompt. The whole character also tells Muse that the assistant is an AI, that it must not claim to be
human, to have a body or to feel things as fact (warmth and humor in tone are fine), and that code, commands and technical
output stay plain. The character is how it sounds: it never grants permission, never changes what Muse may do, and
never changes what is true.

### What you have shared

Home can show, as facts read from what is stored: the days since the assistant was first switched on, how many notes it
holds, how many beliefs you changed (each kept as history), how many tasks finished with a check that passed, and a
short history of round numbers (the first note, the tenth, fiftieth and hundredth, the first change of mind, the first
and tenth task finished together, a week, a month and a quarter). It holds no word of any note, so it is safe to show.
There are no streaks and no scores, nothing counts the days you were away, and the assistant never says it missed you.
It can be hidden on the Persona tab.

## How the memory works

### What a memory is

| Field | Meaning |
| --- | --- |
| kind | fact, preference, constraint (a standing rule), event, decision, procedure, commitment (something owed, with a due time), or working (this conversation only, expires) |
| scope | global, account, project or thread. A project's notes are never candidates for another project |
| basis | `explicit` (you said it), `observed` (a check confirmed it), `inferred` (a guess). A guess never replaces what you said and repeating it does not promote it |
| trust | where the words came from: you, a verified check, an unverified source, an untrusted source (a web page, a tool, a file). Untrusted words wait for your approval and never change what is believed |
| time | when it was said (never when it was processed), when it was last confirmed, a validity window, a due time |
| source | the exact words, the thread and message they came from |
| revisions | every change to the words, with who made it and why |

### Belief change

A new statement about the same thing is a new memory, and the old one becomes history, linked to what replaced it. That
is true whether the new statement is a slot's new value ("my timezone is..."), a restatement, or an explicit correction
("actually, ... instead of ..."). Rules:

- A statement already on file is corroborated (a second source is added), never duplicated.
- A correction replaces the memory it is about, found by its words and identifiers. If it could be about several, the
  correction is kept waiting and you choose; the choice survives a restart.
- A late job never overwrites a newer statement. An older statement that arrives after a newer one is kept as history.
- Equal statements that disagree (same moment, same standing) are both marked disputed until you settle it.
- A forgotten memory is erased with its earlier versions: the words are removed from the revisions, the sources, the
  text index, any summary derived from it, and the free pages of the file (`secure_delete`, an index rewrite and a log
  checkpoint). What is kept is a salted fingerprint. The same words read again from before the erasure (a replayed
  message, an import) are refused; you saying them again afterwards is accepted, because that is your choice.
- Pausing capture stops new memories only. Words said while capture was paused are not read when it comes back.

### Retrieval

For each message: filter by account, project, thread and time first (scope is a filter, not a score); take the standing
rules, what you pinned, what is due and this thread's working notes; add notes found by full-text search (SQLite FTS5,
BM25, stemming) and by exact identifier; score by match, kind, scope, age, confidence and standing; drop what repeats;
fit what is left in the budget, rules first. The block marks guesses and disputes, flags anything about something that
changes and has not been confirmed lately, shows the exact words when asked "why do you think...", and says "nothing is
saved" when a question about what is remembered finds nothing, instead of leaving a gap to fill. Words from a note are
neutralised so a note cannot close its own block.

Retrieval is lexical on purpose. The evaluation measures how much that costs on paraphrase and what each added
technique buys; see [assistant-evaluation.md](assistant-evaluation.md).

### What memory is not allowed to do

Memory never grants authority. The assistant's permissions come from its settings (autonomy, read-only, project writes,
commands, budgets) and from Muse's approvals, neither of which reads memory. A note that says "always approve writes" is
data.

## How tasks work

A task is a goal, one or more steps, a project, and limits. Each step runs as a turn in a thread of its own that you can
open; its approvals reach you like any other thread's. The task adds the notes that bear on the goal in front of each
step, built when the step starts, so a correction you make between steps is in the next one.

| State | Meaning |
| --- | --- |
| queued | waiting for a free slot or the daily limit; the reason is shown |
| running | a turn is in progress |
| waiting | Muse could not be reached, or a step could not be started; retried with a growing delay, and the reason is shown |
| paused | you paused it, you spoke in its thread, or the turn was interrupted from outside. Nothing new starts |
| blocked | it needs you: a check failed, a budget ran out, or a step may or may not have run |
| completed | every check the task has passed, and the evidence is shown |
| unverified | it finished without an error and nothing could check the result. You can confirm it |
| failed, cancelled | as they say |

**Evidence.** A step may carry a check: a file exists, a file contains some text, or you confirm. The executive reads the
project's own files to run it. A task is "completed" only when it has checks and they all passed; otherwise it ends as
"unverified" and says so.

**Limits.** Per task: turns and minutes (never more than the settings allow, extendable up to twice). Overall: how many
tasks run at once and start per day. Time spent waiting for your approval is not charged. A limit that is reached stops
the task with the reason and the way to raise it.

**Correlation.** Every attempt has a fence number and a command id. A turn's end is matched to its attempt by thread and
turn; one that is not the current attempt's (a cancelled task's turn, an old attempt's) is refused and recorded.

**Restarts.** The executive runs while Ancilla is open. When it starts again it settles what was in the air: a turn the
ledger knows finished is recorded and checked; one the ledger does not know is not run again on a guess if the step can
change anything: the task stops and asks. A step that only reads is run again with a new fence.

**Cancelling and pausing.** Cancelling interrupts the running turn (and says if it could not confirm that), and anything
the turn reports afterwards is refused. Pausing lets the running turn finish, records its result, and starts nothing new.

**Initiative.** The assistant can propose what to do next: a commitment that is due, a note about something that changes
and needs confirming, a goal nothing is working toward, a task that is waiting on you. What it does about them is the
autonomy setting: under "ask" it only says what is waiting on you, under "suggest" it lists the work, under "act" it
starts the work that only reads and rests on something you said in a project, at most two a day, once each. Anything that
would change a file is offered, never started.

**Schedules.** A recurring task needs its time zone, and an end date or a number of runs (at most a year, at most every
15 minutes). A missed run is skipped by default; a run is skipped when the last one is still going.

## How it fits into Ancilla

```mermaid
flowchart LR
  UI[Threads and the Assistant page] -->|POST /api/turns| Turn[Turn route]
  Turn -->|1 capture what you said, 2 retrieve the notes that apply| Memory[(assistant.db)]
  Turn -->|3 your prompt with the notes block in front| Muse[Muse session]
  UI -->|/api/assistant| Routes[Assistant routes]
  Routes --> Memory
  Routes --> Executive[Task executive]
  Executive --> Memory
  Executive -->|start a session, send a turn, watch it| Host[Server host adapter]
  Host --> Muse
  Memory -->|assistant event, after the commit| UI
```

- **`packages/daemon` is untouched.** It still speaks to Muse and owns `ancilla.db`.
- **`packages/server` owns the assistant.** It is the only code that opens `assistant.db`. It reaches the rest of the
  server at three points: the turn route (capture, then retrieve, then prepend; a failure there never stops the turn, and
  slash commands are left alone), the session machinery a task uses (the same `startSession` and `sendTurn` a person
  uses, so a task is an ordinary thread with the same approvals) and the event stream. The data folder's lock, the host
  and origin checks and the token cover its routes like the rest.
- **`packages/ui` holds no assistant logic.** One generic client call, a page of views and a toast for the stream's
  events, plus how the character looks and sounds: the faces and the lines written in advance. The browser demo answers
  the same routes from fixtures.
- **Muse is the only model.** The assistant makes no call of its own, so there is no second runtime to install and no
  second subscription.

## Where things live

- `assistant.db` (and `-wal`, `-shm`) in the data folder. Own migrations (`PRAGMA user_version`, each step with an `up`
  and a `down`), write-ahead log, full synchronous commit, `secure_delete` on. The profile, with the character (face,
  voice, what it calls you, habits, when it was set up), is one JSON value, so a character needs no migration and a
  field an older file lacks takes its default. Tables: profile and goals; memory items,
  revisions, sources, evidence links, links between items, tombstones, a capture log, summaries and an audit log of what
  changed and who changed it (ids and rule names, never the words); tasks, steps, attempts, events, checkpoints and
  schedules; and an FTS5 index that is rebuilt from the items whenever it disagrees with them.
- Code: `packages/server/src/assistant/`. The pure parts (extraction, resolution, ranking, context) have no database,
  clock or Muse in them.

## HTTP

All under `/api/assistant`, behind the same host check, origin check and token as the rest of the API.

| Route | Does |
| --- | --- |
| `GET /` | status: profile (with its character), goals, counts, open tasks, and `bond` (days together, counts and milestones) |
| `PATCH /profile` | change identity, character (`avatar`, `voice`, `callsUser`, `quirks`, `presence`, `showBond`, `configured`), style, autonomy, limits, pause capture; refuses a stale view and any field it does not know |
| `GET /memories`, `POST /memories` | list (status, kind, scope, search) and add |
| `GET /memories/:id`, `PATCH`, `DELETE` | read with sources, revisions and lineage; edit (refused if stale); erase |
| `POST /memories/:id/{pin,unpin,confirm,settle,approve,commitment}` | the rest of what you can do to one |
| `POST /wipe` | erase everything, only with `{"confirm":"wipe everything"}` |
| `GET /export` | everything you may keep, as a file |
| `POST /preview`, `GET /threads/:id/context` | what the model would be told, and what the last turn used |
| `GET /activity` | what changed and who changed it |
| `GET/POST /goals`, `PATCH/DELETE /goals/:id` | goals |
| `GET/POST /tasks`, `GET /tasks/:id`, `POST /tasks/:id/{pause,resume,cancel,retry,confirm,extend,resolve}` | tasks |
| `GET /suggestions`, `POST /suggestions/{accept,dismiss}` | what to do next |
| `GET/POST /schedules`, `POST /schedules/:id/{enable,disable}`, `DELETE` | schedules |

Events arrive on the existing stream as `{ "type": "assistant", "reason": "memory" | "profile" | "goal" | "task", ... }`,
and a save is announced only after it is committed.

## Rolling back

Nothing outside `assistant.db` depends on the assistant, so every step below is local.

1. **Switch it off** (Assistant page, or `PATCH /api/assistant/profile {"enabled": false}`): capture and injection stop,
   running tasks are paused, nothing is deleted.
2. **Keep a copy first**: the Export button, or `GET /api/assistant/export`. An export holds items with revisions and
   sources, goals and the profile. It does not hold erased memories or their fingerprints.
3. **Remove it**: quit Ancilla and delete `assistant.db`, `assistant.db-wal` and `assistant.db-shm`. Ancilla starts as if
   it had never been switched on.
4. **Downgrade Ancilla**: an older Ancilla does not open `assistant.db`, so it ignores it. A newer file than the program
   understands is refused, never altered, with a message saying which version to restore.
5. **Step the schema back** without removing the file: `scripts/assistant-rollback.mjs <data folder> <version>` writes an
   export first, then runs the steps' `down` scripts (version 1 is memory and profile; version 2 adds tasks).

## What it does not do

- Extraction is rule based. It reads plain statements well ("remember that...", "I prefer...", "actually, ..."), and a
  statement phrased in an unusual way is not captured. Nothing is captured from the assistant's or a tool's words.
- A sentence you paste into a message is read as yours unless it is fenced, quoted or tagged as a document. The page
  shows every capture with its source, so nothing is hidden, and memory cannot grant permissions, but this is a real
  limit.
- Retrieval finds notes by words and identifiers. A question that shares no word with the note it needs will not find it.
- Tasks run only while Ancilla is open (the desktop shell closes the server with its window), and they need Muse. Checks
  read files in the project; they do not run commands.
- `assistant.db` is not encrypted at rest, like `ancilla.db`, and the desktop server runs without a token on loopback, so
  a local process that can reach the port can read it as it can read threads.
- One assistant per data folder. Notes can be scoped to an account, but there is no separate assistant per account.
- The character is a look and a tone, not a mind. The lines it says in the interface are written in advance, so it does
  not learn your phrasing or comment on what you are doing, and it has no voice or sound. Faces are chosen from five
  forms and drawn from a description; there is no image upload. The honest limit of the history is that it counts what
  is stored: a note you erased no longer counts.
