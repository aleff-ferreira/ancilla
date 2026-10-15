# Changelog

## Unreleased

### New

- **Muse Wonder 1.0 has a price.** Its turns, threads, goals, crew estimates and the Usage page now show dollars at Meta's published rates: $4.00 in, $20.00 out and $0.20 cached per million tokens. Wonder Full has no published id or price, so it stays unpriced and says why instead of borrowing Wonder's rate. Only Muse Spark ids fall back to Spark rates; any other model Meta has not priced reads as unpriced, never as a guessed figure.
- **The model picker follows the account that runs the thread.** A thread asks its own Muse for its models, and a project on a named account asks that account (through a Muse already running for it when there is one), instead of always showing the default login's list. The list is read again when you open the picker, after Muse restarts, after you sign in and when you change a project's account, but not on every click around the app; a failed read says why, keeps the last good list and has a Retry. The footer shows the Muse version and your plan name, with Refresh models and Restart Muse beside the list. Restart Muse is off while a turn, approval, research run, workflow, subagent or background task is still running.
- **Any model id can be tried.** Other model takes an id Muse did not list. `/model` reads the list again before it says a name is unknown and finds partial names such as `wonder`, also among the models Meta publishes while Muse sends only its built-in list, and it shows the models that fit as you type, with the regular model ahead of its Contributor twin. A bare word that fits nothing is a name and is never saved as a model id; a full id such as `muse-wonder-2.0` is tried as typed. An id Muse did not list is tried on the open thread only, or saved as the default on the new-thread screen and remembered as one you tried, so it is still what new threads start on after Ancilla restarts. Muse checks access when you send a prompt.
- **Muse's built-in model list is no longer mistaken for your plan's.** Some Muse versions answer with a short built-in list, and keep answering with it. Ancilla says so, asks again a few times in the background, never calls a saved or current model unavailable because of that list, and offers the models Meta publishes in Muse Code, such as Muse Wonder 1.0, as one-click choices.
- **Muse default is a choice again.** It is the first row in the picker and in Settings and says which model it follows, including when that is a Contributor model, which Ancilla tells you once. A saved model your account does not list no longer fails every new thread: new threads start on Muse's default and say so once, and your saved choice is kept in case it is right for another account.
- **Reasoning levels follow the model without losing your choice.** The slider and the Settings default offer only the levels the model lists, and when your choice is a level the model does not have, turns run at the nearest one, you are told once, and your choice comes back on a model that has it. This applies only to a model list that is your plan's own, so Muse's built-in list never shortens it.
- **You are told when a thread's model can no longer be served.** When Muse reports that it cannot serve a thread's model, for example after a sign-in changes your provider, Ancilla asks you to pick a model your plan offers and opens the picker on that thread.
- **Usage says what it has not counted.** The page names threads that could only be read back in part and threads it has not read yet (open a thread to count it), notes that one-shot title and DeepResearch exec calls and the spend of subagents and workflow agents are never included, and notes when the totals span more than one account. When threads are missing, the note also sits right under the totals.
- **Subagent and workflow agent spend is called out.** The cost popover shows their unpriced tokens and the cost chip reads as at least that much, so a thread's dollars are no longer mistaken for the whole spend.

### Fixed

- **Old threads no longer pile their spend onto today.** Calls read back from a thread's history are dated from the turn that made them, not from the moment you opened the thread, and a call stored with a date days after its turn is corrected the next time you open that thread. From now on a call you saw live and then read back from history is counted once; calls an earlier version already stored twice keep both rows, but a thread's completeness check counts them once.
- **A thread you watched live is no longer reported as partly counted.** A long thread whose recorded prompt total reaches the session's own total counts as complete even when its history is longer than what Ancilla reads back.
- **Calls with no published price no longer pass for $0.** Totals read as a lower bound while any call is unpriced, an unpriced model shows a dash, the daily chart and model bars switch to tokens when nothing in the window has a price, and Caching saved says it is a lower bound too. Each place says why: Meta publishes no price for that model, or Muse did not record the model for those calls.
- **The Usage page keeps up and says what it leaves out.** It reads again every minute while you look at it and when you come back to the tab and shows how old its numbers are ("Updated 3 min ago"). When a background refresh fails it keeps the numbers, says "Could not refresh; showing numbers from 3 min ago" and offers Retry, and a failed load has a Retry button. The thread list shows the top 8 with how many threads there are and what the others cost, and a row whose thread is no longer in your list is no longer a dead click.
- **The plan meter is honest about refreshing.** When Muse is the only source, a stale reading says Muse reports it again later instead of promising Refresh will fix it. The sidebar badge follows the limit closest to its cap, so a weekly limit at 97% reads 97% wk even while the five-hour window is at 10%. Reset countdowns round up to whole minutes, and ages read the same everywhere.
- **The plan meter stays current.** It refreshes in the background every few minutes and when you return to the app, without spinning the Refresh button, and retries after a minute when a read fails. A removed account disappears from it at once and stops being any project's default.
- **A brief Meta error no longer costs you the plan name or the source label.** Ancilla keeps the plan name Meta last reported for each account through a timeout, a server error, a rate limit or a rejected sign-in, and clears it when you sign in as someone else, when Meta says the subscription ended or when you remove the account. A reading stamped in the future by a clock jump can no longer freeze the meter.
- **The cost popover's rows add up.** Input subtracted cached tokens twice and read zero on a heavily cached thread. Uncached input, Cached input and Output now come from the same per-call sums as the dollar figure, so the context panel and the token pills show the same cache numbers.
- **Partial history is marked.** When a long thread's older turns are not loaded, its cost reads as at least that much and its call rows say they cover loaded calls only. A goal's cost and tokens do the same, including when the goal began before the loaded history starts.
- **Thread costs use the published price table when the model list is missing a model,** including when the list failed to load or belongs to another account. A call Muse sent without a model id says so instead of being explained as a model Meta does not price.
- **The context ring is honest when it only has an estimate.** A thread reopened from history reads Estimated from the last call instead of plenty of room, uses the size left after a compaction, and keeps the ring and the Compact button when the window size is unknown.
- **One speed and one turn count everywhere.** The Time pill uses the same speed rule as the turn footer, a call timed at zero is not counted as timed, and queued prompts that never ran or were pulled back do not count as turns.
- **A model call is counted once after a reload.** Reloading a thread, or merging its saved history with the live stream, no longer doubles its steps, model time, reasoning tokens and cost.
- **Crew totals and estimates no longer count reasoning twice.** They add input and output only, so their token arithmetic matches the Usage page's. A finished workflow keeps its cost when you switch models. A DeepResearch run is priced at the model each of its roles is set to use, otherwise at the thread's current model (Mixed models when its roles differ), so a later `/model` still moves a finished run's estimate. Run cards say how many agents have reported.
- **A refused model switch no longer changes your default.** The model new threads start on is saved only after Muse accepts the switch, and a thread that was refused goes back to its old model. A model id outside Muse's list no longer sticks to the thread, so a typo is not restored on the next resume.
- **The home screen picks models from your project's account,** as the new-thread screen already did, so a model only that account offers is found and not saved as typed text.
- **Forked threads keep their account.** A fork of a thread on a named account was stored as a default-login thread, so it listed the wrong models and counted against the wrong plan.
- **Counts and costs near a unit boundary read correctly.** 999,999 tokens reads 1M instead of 1000k, $0.9996 reads $1.00, and calls Muse sent without a model id are labelled Unknown model.
- **A cost that is only a floor is written one way.** The cost chip, the Context panel, the goal card and the Usage page all read "≥ $1.20", and the Context panel rounds like the others (a cost of $0.0348 reads $0.035, not $0.03). A goal that ran only on a model Meta does not price shows a dash, not "≥ $0".
- **A model you try on a thread is no longer undone by an older pick after a restart.** Trying a model that Muse's list does not name, such as Wonder, on a thread that started with a saved model used to leave the saved model in place, so the thread came back on it after Muse restarted. The thread now keeps whatever Muse reports, and a refused switch still changes nothing.
- **The Usage page no longer counts old quiet threads as "not read yet".** Threads from before Ancilla tracked their last activity are dated from when they were made until a sync learns their real date, so a thread that has been quiet for months is not reported as missing spend in a recent range.
- **Restart Muse no longer cuts off work that starts while it waits.** It checks again when its turn comes behind another restart, and a compaction, a fork or a Muse host that is still starting now hold it off. The message says which kind of work is open.
- **Settings no longer calls a saved model unavailable when another account offers it.** Under New threads it says Offered by another account, a model you typed by its id says it is not in Muse's list, and with Muse default selected a line says which model that is, including when it is a Contributor model. The model button announces the tier to screen readers, and the `/model` completions keep the model id readable on a narrow screen.
- **Removing an account forgets its model lists,** so its models no longer linger in costs and context sizes until the app restarts, and a plan's own row is no longer hidden by a built-in row for the same model.
- **The Contributor notice comes when a model switch succeeds,** not when it is refused, and also when Muse starts a thread on a Contributor model by itself.
- **The Usage page's time zone handling can no longer grow memory without limit.** Zone names are read in their canonical spelling, so every case variant of a zone is one zone, and the zone caches are capped. A zone can now be reported under its canonical name, for example Asia/Calcutta for Asia/Kolkata.
- **Research answers are bound to the right request.** Every control call now runs in a session of its own, so a late answer to one call can no longer be taken for the answer to the next, and a turn whose start was acknowledged only after Ancilla had given up on it is cancelled by id.
- **Starting a research session is bounded.** The wait is two minutes, or three on Windows with Muse in WSL or not yet detected (`ANCILLA_RESEARCH_STARTUP_MS` overrides it, in whole milliseconds of 1000 or more), so Stop works and worker slots come back even when Muse never opens the session. A worker stopped before its turn started shows as cancelled, and a worker that gave up while the project's Muse was still starting is never sent a session afterwards. A host that has left two session starts unanswered is sent no more until it answers; a run stopped on a merely slow host does not count against it.
- **A late supervisor decision no longer launches workers or writes a report out of nothing.** A decision that arrives after the research window delegates nothing. With findings the run writes its report (partial when the decision itself failed); without any it ends failed and says so.
- **Research questions and the supervisor's list of earlier rounds are bounded.** A question is limited to 20000 characters, and the list of earlier rounds the supervisor reads is kept within 60000 characters.
- **An error that merely mentions "cancel" no longer ends a research run, and a 429 that also mentions a quota is retried.** It used to end the run as a quota failure; the circuit breaker still bounds the cost of retrying.
- **Thread discovery skips hidden research sessions and no longer loops on a host that repeats an empty page or a cursor.**
- **A report file the project never answers for no longer holds a finished run open.** After 30 seconds the run's row says the report file could not be written and why, the report stays readable in Ancilla, and the row updates if the file lands later.
- **Attachments can no longer be steered out of the project or overwrite each other.** Files you attach to a prompt are saved under `.ancilla/attachments` in the project. Ancilla now refuses to write through a link (a symbolic link or a junction) in `.ancilla` or `.ancilla/attachments`, and says which path is the link and how to fix it. A name that is already taken, including one held by a broken link, is skipped, so the 52nd upload of `notes.txt` and two uploads at once no longer replace an earlier file. A saved name has no trailing dots or spaces, and a name that Windows treats as a device (CON, NUL, COM1 and the like) gets a leading underscore. For a project inside WSL opened from Windows, attachments and research reports are now saved inside the project's own folder instead of a folder on the current drive, and when Ancilla cannot work out where a folder is on the computer (a Linux folder with no WSL distribution, or a path that is not a full path) it says so instead of writing to the wrong place. Ancilla also writes `.ancilla/.gitignore` containing `*` when it saves something there and the file is missing, so attachments and reports are not committed by accident. Edit that file if you want some of it tracked, for example by adding `!research/` and `!research/**` lines to track research reports; Ancilla never replaces a file that is there. Deleting it is not an opt out: Ancilla writes it again the next time it saves into `.ancilla/`.
- **Stored attachments are served as images or as downloads, never as pages.** The media type a client names is cleaned when it is stored and again when it is read, so an old attachment with a malformed type loads again. PNG, JPEG, GIF, WebP, AVIF, BMP, HEIC, HEIF, TIFF and JPEG XL images still show inline; SVG still draws in the thread but downloads when opened on its own; PDFs, text and every other type now download instead of previewing in the browser.
- **Research reports that cannot be saved say so.** When the project would not take `report.md` (for example `.ancilla` is a link or a file, or the run's folder holds a link or a folder where a report file belongs), the run's row now says why and the report stays readable in Ancilla; exports answer with a clear message instead of an error. The folders Ancilla writes into and the files it creates there (report, sources and exports) are checked: a link or a folder in the way is refused.
- **Dropped downloads no longer leak file handles, an unreadable download is an error and not a crash, and a download is never longer than it said.** A file or export download that the browser abandons now releases the file, an export file Ancilla cannot read answers an error for that request instead of stopping the process, and a file that grows while it is being downloaded is sent only up to the length the response declared.
- **A message Muse accepted is never reported as not sent.** Saving a turn's attachments or the thread's activity after Muse took the prompt can no longer turn the answer into an error. When a send gets no answer at all (a timeout or a broken connection), the message now shows as unconfirmed while Ancilla reads the thread a few times to see whether it arrived, then settles on sent or not sent; nothing is ever sent again for you, and the composer is free throughout. The check only reads: it may load an idle session its host dropped, as opening the thread does. A message sent while a turn was running may be waiting in Muse's queue, where Ancilla cannot see it, so it is never called not sent: you are told to check the thread and its queue, and your text comes back. A send that did not arrive, or that could not be checked, gives your text and files back. A retry after Ancilla reconnects a session reuses the files it already saved instead of leaving a second copy.

### Changed

- **Usage ranges are whole local days.** The first chip reads Today, and 7d, 30d and 90d are exactly that many calendar days ending today in your own time zone, so the chart draws exactly that many bars, says its days are local and marks the last bar as still counting. Servers that do not send a time zone keep their UTC days.
- **DeepResearch workers roll into one row per project and account** in the Usage thread list, titled DeepResearch workers, instead of appearing as separate threads you cannot open.
- **The Activity drawer footer reads tokens in current runs,** because it never covered the whole day. The Usage page has the per-day figure for the lead agent's model calls; subagent and workflow agent spend is not in it.
- **A Muse that stops by itself is no longer started again just to read its model list.** The lists are marked old and read the next time you open the picker or Settings.

## 0.20.3

### New

- **Linux installers add Ancilla to your application menu.** Debian/Ubuntu `.deb` and Fedora/RPM `.rpm` packages install the app, its icon and required system dependencies. Node.js stays private to Ancilla and does not replace a system installation. The portable AppImage remains available; its setup screen can copy it to a permanent location, add an application-menu entry and create an optional desktop shortcut.
- **Set up Muse on Linux inside Ancilla.** Home guides you through installing Muse Code from Meta, approving browser access, connecting your subscription and choosing a project folder. Installation has progress, cancellation and retry. Existing Muse installations and logins are reused, and Settings keeps the setup and recovery controls available afterwards.

### Fixed

- **Subscription Refresh fetches current limits from Meta.** Supported Muse browser logins now read the subscription snapshot directly without starting a thread or spending model tokens. The five-hour and weekly windows preserve Meta's exact percentages, including over-limit values, and convert reset timestamps correctly. Account selection stays fixed, the default login remains visible, and stale, expired or missing readings cannot appear as current allowance. Runtime and saved observations remain explicitly labelled when a fresh reading is unavailable.
- **Linux threads recover from Muse's `UnsafePath` permission error.** Before starting a Muse host, signing in or running research, Ancilla checks the selected account's storage and removes group/other write permission from the owned outer Muse data folder when that is the problem. It also creates a missing data folder with private permissions. Login files, thread history and deletion records are preserved. Unsafe links, foreign ownership and incomplete deletion registries produce a specific explanation and a Settings action instead of resetting data.
- **Muse installed from the desktop is found immediately.** Ancilla discovers `~/.local/bin/muse` even when the desktop's PATH omits it, checks that the CLI is usable without starting a hidden download or login, and advances setup without requiring an app restart. Cancelling installation stops its subprocesses before a retry begins.

### Changed

- **Linux update controls match the installation format.** AppImages retain signed automatic updates. Debian and RPM installations link to the latest installer in Settings; the AppImage updater cannot replace a package-managed executable. AppImage launcher setup preserves an existing extract-and-run fallback and keeps a backup when migrating a recognized older shortcut.

## 0.20.2

### New

- **Sign in to your Muse Code plan directly from Ancilla.** Home and Settings offer **Sign in with Meta**, with a guided browser flow, a copyable code, explicit confirmation, retry and cancellation. No named account or API key is required. Setup includes installation instructions for the selected operating system and runtime; existing Muse logins are reused.
- **Choose where to save research reports.** PDF, Word and HTML exports open a native Save As dialog on desktop and a file picker in supported browsers. Choose the destination before the report is generated; cancelling starts no export. Other browsers use their configured download location, with guidance for enabling a location prompt.

### Fixed

- **Crew monitors ordinary prompts as well as parallel work.** The lead turn and foreground tools now appear in the card, panel and timeline. Completed tools remain inspectable, background tasks and native agents stay live after the lead finishes, and missing outcomes remain explicitly unreported. Stop everything includes native agents and waits for Muse to confirm each stop.
- **Plans follow the work that is actually running.** Muse's active step states are recognized, approvals and disconnected feeds pause the activity indicator, and a later prompt does not revive an older checklist. Associated workers can keep a plan active after the lead finishes. Unconfirmed steps stay visible, and completed plans remain available as an expandable summary.
- **Sign-in confirmation belongs to the current attempt.** Saved credentials cannot falsely confirm a new login, cancellation cannot stop a newer attempt, and a slow earlier request cannot replace a retry. Windows and WSL use the selected Muse runtime; an inherited API key is explained when it overrides subscription sign-in.

### Changed

- **Everyday monitoring stays compact and responsive.** Ordinary turns use a small completion summary instead of a workflow report. Inspectors distinguish the lead, foreground tools and background tasks, including reported shell exits. Execution indexes avoid repeatedly scanning a long thread's tool history while text streams.
- **The project overview explains the complete research and monitoring workflow.** The README and activity guide cover cited reports, document exports, ordinary prompt activity, native agents, background work, task plans and guided setup.

## 0.20.1

### Changed

- **Usage puts Muse subscription limits first.** The reported rolling window and weekly limit show used and remaining percentages, reset countdowns and timestamps, and when Muse last reported them. Refresh reads the runtime's last observation without sending a prompt. Saved readings survive restarts when Ancilla can verify the same login and runtime; missing, expired and unavailable readings are labeled explicitly. Local token totals and API-rate estimates stay in their own section.
- **Deep Research and Crew lead the project overview.** The README shows research runs, cited reports and agent monitoring in the current interface, with clearer installation guidance and a map of the codebase.

### Fixed

- **Importing Helicon preferences no longer opens inherited release notes on Ancilla's first launch.** Other preferences still carry over, and later Ancilla updates retain their own release notes.
- **Crew follows agents and background tasks as their events arrive.** Native agent metadata received after an output placeholder, commands moved to the background, and streamed task output now refresh the card, sidebar and panel. Muse's native-agent `ready` result settles the agent, and an older wait arriving late cannot undo a newer completion. Wait matching stays linear as the number of native agents grows.

## 0.20.0

### Changed

- **Ancilla joins the AMAZONIA WORKS visual family.** Dark surfaces carry a subtle forest tint, the light theme uses softer mineral neutrals, and emerald marks the logo, send action and navigation selection. The app icon and installer artwork follow the same palette. Live activity keeps its blue, with separate colors and labels for completion, requests and failures.
- **Display headings use Fraunces.** Home, first-run screens, empty states and the Crew completion headline share the parent brand's editorial typeface. Functional text stays in Inter and code in JetBrains Mono; all three fonts ship with the app. About now identifies Ancilla as an AMAZONIA WORKS product.
- **Everyday surfaces have finer edges and clearer selections.** The composer has tighter corners and a restrained focus edge. Sidebar and command-palette selections use an inset emerald marker, while Settings, Usage and Crew cards share fine borders and a more consistent hierarchy. The sidebar, transcript width, composer position, navigation and keyboard controls retain their existing layout and behavior.

## 0.19.2

### New

- **A research report downloads as PDF, Word or HTML.** The Download menu on a finished report writes the document beside report.md in the project's `.ancilla/research/` folder. The desktop app offers to open it from there; in a browser the file downloads. Headings, lists, tables and code come through, every citation is a superscript that jumps to its entry, and each source is a working link with its address printed after it.

### Changed

- **Citations are footnotes you can follow.** A report's citation markers are now superscript links: one click goes to the source's entry in the Sources list, where the page's title links to the page, its host stands beside it, and an arrow leads back to the claim. The report file uses standard GitHub-flavoured footnotes, so it reads the same way on GitHub or in an editor. Reports written before this release show the same way, and a code fence the writer left open can no longer swallow the Sources into a code block.

### Fixed

- **"Open report.md" finds the report on Windows.** For a project inside a WSL distro, the report was written under the Linux path taken literally on the Windows drive, so the file viewer, which reads the project through its `\\wsl.localhost` share, said the file was not there. The report is now written where the viewer reads.

## 0.19.1

### Changed

- **The Swarm is now the Crew.** The card in the dock, the panel beside the thread and the sidebar row that show a thread's agents, tasks and research workers are called the Crew: a set of helpers working under direction, which is what they are. Nothing else about them changes, the shortcuts included, and a panel left open under the old name opens as the Crew panel.

### Fixed

- **Research workers show up in the Crew card, panel and Activity drawer.** A research run used to leave the Crew panel saying "No agents in this thread" while its workers were out. Now the run is a run there like a workflow: each round is a phase ("Round 2 of 12"), each worker a row with its searches, reads and saves, the inspector explains why a worker has no Retry or Skip of its own, and Stop, whether on the run or through Stop everything, ends the research run the way the composer's switch says.
- **A research run no longer dies on its first supervisor decision.** When the supervisor's answer is prose instead of the fenced JSON decision, as happens when the question itself reads like a set of instructions, the run used to end with "supervisor decision failed with no findings to write from" before a single worker had run. Now the first round researches the brief along three default lines (the landscape, the primary sources and figures, the latest developments), the supervisor is told what happened before its next decision, and a transport failure on a decision is retried once. When a later decision still fails with nothing found, the failure text says what was wrong with the answer.

## 0.19.0

### Changed

- **Ancilla is under the GNU AGPL v3.** Ancilla is licensed so that whoever changes Ancilla and ships it, or runs it for others, has to offer their version's source under the same terms. Helicon's own notice stays in `LICENSE-HELICON`, as its MIT license requires; everything Ancilla adds is under the AGPL.

### New

- **Deep research.** Switch on Research beside the model picker and the message field becomes the question, or type `/research <question>`; either starts a run from the thread: a supervisor scopes the question, sends parallel Muse workers out to search the web and read what they find, sends more after reading their notes, and a writer turns everything into a Markdown report that lands in the thread and in `.ancilla/research/` in the workspace. While it runs, the row in the transcript says which phase it is in and which round, shows a chip per worker with its searches and reads, the sources found and verified, the tokens spent and the time left in the research window; Stop either writes a report from what the workers have or drops the run. Every model call and every search runs through Muse on your plan, so there is nothing to sign up for and no key to add, and the run's tokens appear on the Usage page under the thread. A citation only ever names a page a worker actually opened: the writer cannot cite from memory, and a source it names that no worker read is turned back into plain text. Settings has the defaults: the window, how many workers run at once, how many rounds, each worker's budget of searches, reads and saves, and which model scopes, researches and writes. This is a first release with the limits that come with one: one run per thread at a time, a run cut off by a restart stays interrupted until a later release can resume it, the report is Markdown with numbered sources rather than footnotes you can click, and the worker sessions are hidden from the sidebar but not from `muse` itself.

## 0.18.0

Ancilla's first release.

### Changed

- **The Ancilla name.** The app, its installers and its data folder carry the Ancilla name, and the project lives at [aleff-ferreira/ancilla](https://github.com/aleff-ferreira/ancilla). Ancilla installs beside an existing Helicon install rather than over it.
- **Updates come from Ancilla's own releases, signed with Ancilla's own key.** The desktop app looks for updates in [Ancilla's GitHub releases](https://github.com/aleff-ferreira/ancilla/releases) and nowhere else, so the request to helicon.sh that counted installs is gone as well. An update not signed with Ancilla's key is refused.
- **Thread titles stay on this machine.** Pushing a title back to Muse Code, which 0.13.0 started doing, could leave a thread's workflow event log unreadable, and the next workflow in that thread then failed with `missing field kind`. Titles, typed or generated, are now kept in Ancilla's own database and not sent to Muse unless `runtime.json` in Ancilla's data folder says `"syncSessionNames": true`; and even then, a Muse that reports that error gets no further titles from Ancilla. Title generation carries on as before.

### New

- **Your Helicon setup comes with you.** The first time Ancilla starts, it copies Helicon's database and `runtime.json` from this machine: your projects and their order, pins, thread titles, archived threads, the title, sandbox and YOLO settings, and which runtime, WSL distro and Muse path to use. The threads themselves live with Muse Code, so they are all still there. Helicon's files are only read, never changed, so the two apps keep working side by side. In the desktop app, interface settings such as theme and zoom, and unsent drafts, start fresh.
- **Agents and tasks, redesigned.** A thread that runs a Muse workflow, a native subagent or a background task shows one Crew card in the dock, in place of the workflow card in the transcript and the strip of agent cards under the thread title; a thread running nothing shows no card at all. Collapsed, the card is one line per run or task: a cell per agent grouped by phase, `Judge · 6 of 10`, and chips only when something needs you, failed or has gone quiet. Expanded, it lists what needs attention first, with Retry, Skip, Review and Stop on the row, and opens one phase at a time; when the run ends it becomes a short report: "All ten landed.", the longest agent, the most tokens, where the time went, and the first lines of what Muse wrote. A Crew panel (Ctrl/Cmd+Shift+M, in the files panel's slot) adds the numbers: tokens and a cost estimated at list price, slots in use, a timeline with one lane per agent and retries on the same lane, a roster you can filter and search, and an inspector per agent with its lifecycle, its task read from the workflow script, and what Muse did not report. An Activity drawer (Ctrl/Cmd+Shift+A) lists what needs you, what is working and what finished today, with Stop everything; the sidebar row, the thread header and the window title carry the same counts. Everything shown is something Muse sent: a quiet agent reads "No update for 4m 12s" only past the run's own threshold, never "stalled"; tool calls, results and reasons for a failure appear when Muse reports them, and until then the surface says so in words rather than leaving a blank. It reads the updates Muse already sends, so there are no extra model calls, no polling and no limit on how many agents run, and a thread whose feed goes quiet shows its last known state with every clock stopped.
- **Third-party notices ship with the app.** Every desktop install carries Ancilla's license, the notices, and the licenses of everything the build bundles: Node.js, the JavaScript packages and the Rust crates. Settings links to all of them.
- **A project can hold more than one folder.** "Add folder…" in a project's sidebar menu puts another folder under that project; a folder that was a project of its own moves in whole, threads included, and "Remove from project" in the Folders submenu makes it a project of its own again, so no thread is ever lost. Each thread still runs in exactly one folder, since Muse Code gives a session one workspace root: a project simply groups its folders' threads, lists them together in the sidebar with the folder's name on threads outside the project's own folder, and the new-thread page offers a folder picker when there is more than one. Hiding a project hides its folders with it, usage rolls up per project, and threads Muse ran in a folder are discovered when the folder is added. Adding a folder that already belongs to a project opens that project rather than making a duplicate.

### Fixed

- **A turn whose live updates stall keeps moving from what Muse saved.** When Muse Code's live feed goes quiet but the thread's saved progress is still readable, Ancilla reads that instead: every 15 seconds in the thread you have open, every two minutes in the others, backing off when reads fail. The thread says it is syncing saved progress, and when it last checked. It only ever reads: nothing is resent, no prompt goes twice and a running turn is never resumed over. History and pending questions already on screen stay put when a read comes back without them, and the notice clears once the turn finishes.
- **A turn that is still running is no longer shown as failed.** Mid-turn, Muse could report a failure with the reason `incomplete` for a turn that went on to finish, so the thread showed it as failed while the work carried on. That report is now ignored for a turn known to be running; a turn that really fails still says so.
- **A message with attachments no longer shows up twice.** Muse saves such a message with its attachment references added to the text, so Ancilla's local copy never matched it and stayed on screen, marked Sent, beside the saved one. The two are now matched by the turn they belong to, whichever arrives first.
- **A thread keeps the model you picked.** Reopening Ancilla could put a thread back on the model it started with, so a thread moved to Contributor read plain again after every restart. Ancilla now remembers the model you choose for a thread, sends Muse the catalog's whole entry for it, and when a reopened thread comes back on another model, sets yours again. A model picked in another Muse client counts as yours too; one the host fell back to does not.
- **The Settings and Usage pages can move the window.** On Windows, with the sidebar open, neither page had anything to drag the window by. Their headings now do.
- **Windows sign-in and WSL projects.** Signing in to an account from Settings runs `muse login` the way threads run Muse, natively or inside WSL, with the account's profile carried into WSL. A `runtime.json` in the data folder can pin the runtime, distro and Muse path, and forward environment variables into WSL, such as the one that picks Muse's credential backend; it survives app updates. A project added by its `\\wsl.localhost\` path opens at the matching Linux path, and a folder in another distro than the one Muse runs in is refused with a message that names both.

## Before Ancilla

The entries below predate Ancilla; the issues and pull requests they link to are in the repository they came from.

## 0.17.1

### Fixed

- **A message you sent no longer shows up twice** ([#55](https://github.com/HarjjotSinghh/helicon/issues/55), reported by [@transformingegg](https://github.com/transformingegg)). When a thread reloaded while your message was on its way, the reload showed both the copy from Muse's history and Helicon's own local copy of it, so the same message appeared twice. The local copy is now dropped once the history has it. If you still see a message three times, or Muse answering the same message more than once, please add to the issue.

## 0.17.0

### Changed

- **New icons, one set everywhere** ([#16](https://github.com/HarjjotSinghh/helicon/issues/16)). Helicon now uses [Phosphor](https://phosphoricons.com) icons throughout, the same family as the website, so the app, the web build and the live demos on helicon.sh finally match. Every icon keeps its meaning and place; they are slightly rounder and a touch more solid. The stop button is a filled square, and the Windows, macOS, Linux and GitHub marks on the site come from the same set.

## 0.16.1

### Fixed

- **A turn waiting on your answer is no longer treated as stuck** ([#54](https://github.com/HarjjotSinghh/helicon/issues/54), reported by [@ntindle](https://github.com/ntindle)). When Muse asked a question and you took more than a minute or so to answer, Helicon read the quiet as a dead connection: it reloaded the thread twice, then said the thread had stopped receiving updates, and could show the turn as failed even though it carried on as soon as you answered. A thread waiting on a question or an approval is now left alone for as long as it waits.

## 0.16.0

### New

- **More than one Muse login** ([#45](https://github.com/HarjjotSinghh/helicon/issues/45)). Settings has an Accounts panel: add a named profile, rename it, remove it, and sign in to it without leaving the app. Helicon runs `muse login` under that profile and shows you the device link and code; when Muse runs in WSL it gives you the one command to run in a terminal instead. Each project remembers which account its new threads start on, set from a picker beside the model picker, and threads running under a named profile carry a small chip in the sidebar. The usage page shows a plan meter per account, and when the account you are about to use is near its cap and another has room, the new-thread screen says so; nothing switches on its own. Profiles are managed by [aonia](https://github.com/HarjjotSinghh/aonia), so the CLI still owns every login and Helicon stores no credentials. If `META_API_KEY` is set, every profile inherits it and shares one login, and Settings warns you. With no profiles configured, nothing changes.
- **YOLO mode** (built by [@margantcovka](https://github.com/margantcovka) in [#46](https://github.com/HarjjotSinghh/helicon/pull/46)). One switch for the full `muse --yolo` posture: no approvals, no sandbox, trusted workspace. It sits in the permissions menu and in Settings, behind a confirmation. Approvals turn off for every open thread at once; the sandbox part applies to new threads only, for the same reason as the sandbox switch in 0.15.0. Switching it off restores the modes you had before.

### Fixed

- **Refreshing threads also refreshes plan usage** ([#50](https://github.com/HarjjotSinghh/helicon/issues/50), fixed by [@aminamos](https://github.com/aminamos) in [#51](https://github.com/HarjjotSinghh/helicon/pull/51)). The refresh button re-read your sessions but not your usage, so work done in the terminal never moved the meter until something else did.

## 0.15.0

### New

- **Muse's sandbox can be switched off** ([#34](https://github.com/HarjjotSinghh/helicon/issues/34), built by [@orkuhh](https://github.com/orkuhh) in [#35](https://github.com/HarjjotSinghh/helicon/pull/35)). Muse runs shell commands inside an operating-system sandbox, which on Windows blocks a lot of ordinary work. Settings now has a switch to turn it off, behind a confirmation that says plainly what you are giving up. Turning it on or off restarts Muse in the background; anything mid-turn stops and says so, and threads pick up again on their next use.

  It applies to new threads only, and that is Muse's rule rather than a shortcut here: Muse fixes each thread's sandbox when the thread is created and nothing can change it afterwards. A thread created while the sandbox is off stays that way even after you turn it back on, so those threads carry a "Sandbox off" badge in the sidebar, the thread header and the command palette.

## 0.14.3

### Fixed

- **A thread that stops receiving updates says so** ([#42](https://github.com/HarjjotSinghh/helicon/issues/42), reported by [@margantcovka](https://github.com/margantcovka)). When a turn's live updates go quiet, Helicon reloads the thread's history twice to catch up. If that does not move the turn on, it used to leave a spinner turning for ever. It now says the thread stopped receiving updates, explains that Muse is probably still working, and offers a reload.

### Changed

- **Helicon can now say whether a thread went quiet or was simply idle.** A long report of turns finishing while their view stood still could not be diagnosed, because nothing here recorded anything about the feed of updates. Each session now tracks when it last received one and what it received, frames the protocol refuses are recorded instead of vanishing, and updates that arrive without a session to belong to are counted rather than dropped in silence. All of it reads from `/api/health`. Nothing new leaves your machine: this is written to the local daemon and stays there.
- **One bad update can no longer take down every thread at once.** Handling an update ran unguarded inside the connection's read loop, so a single failure would have ended the connection to Muse and every thread on it. A failure is now contained to the update that caused it.

## 0.14.2

### Fixed

- **A thread stops freezing part-way through a long run** ([#32](https://github.com/HarjjotSinghh/helicon/issues/32), found and fixed by [@margantcovka](https://github.com/margantcovka) in [#41](https://github.com/HarjjotSinghh/helicon/pull/41)). 0.13.1 fixed one cause of this and missed the rest: it still happened with no subagents at all, on a thread of roughly 487 tool calls. Three things were wrong. Reloading a thread while another load was still running threw away every event that arrived in the meantime, so a turn's ending could vanish and the view would show it running for ever. Streaming text, long tool output and very large edits were each re-processed in full on every frame, which stalled the window as a thread grew. And a thread whose stream goes quiet now reloads itself instead of sitting there, which is what restarting the app used to do for you.

## 0.14.1

Same app as 0.14.0 on Windows and macOS. The step that repacks the Linux AppImage without its stale Wayland libraries failed on its first real run, so 0.14.0's AppImage still carried them; it is repacked properly here. Windows and macOS users on 0.14.0 lose nothing by updating.

## 0.14.0

### New

- **Session statistics above the composer** ([#39](https://github.com/HarjjotSinghh/helicon/pull/39), built by [@jorgitin02](https://github.com/jorgitin02)). Two pills summarise the open thread: turns, steps and the request-average speed in one, exact token counts with the cache split and a per-model breakdown in the other. Everything is worked out from the thread's own history on your machine; nothing is sent anywhere. Off by default, switched on under Settings -> Appearance -> Session statistics. On a long thread where only part of the history is loaded, the numbers say so rather than quietly under-reporting: details are marked *Partial* and the token total carries a `+`.

### Fixed

- **The Linux AppImage opens on current distributions** ([#38](https://github.com/HarjjotSinghh/helicon/pull/38), thanks [@orkuhh](https://github.com/orkuhh)). The bundler shipped Ubuntu 22.04's Wayland libraries inside the AppImage, and a newer system's graphics stack could not initialise against them, so the window never appeared ([tauri-apps/tauri#15665](https://github.com/tauri-apps/tauri/issues/15665)). The release now repacks the AppImage without those libraries so it uses the ones already on your system.
- **Two clicks that went to the wrong place** ([#36](https://github.com/HarjjotSinghh/helicon/issues/36), [#37](https://github.com/HarjjotSinghh/helicon/issues/37)). Finishing a sidebar drag no longer opens the thread you dropped, and Alt with the arrow keys no longer jumps threads while you are typing in the composer.

### Changed

- **Short durations read in milliseconds.** A tool call that took under a second used to say "under 1s", which told you nothing; it now says `412ms`.

## 0.13.1

### Fixed

- **A thread that ran subagents no longer grinds to a halt** ([#32](https://github.com/HarjjotSinghh/helicon/issues/32), reported by [@margantcovka](https://github.com/margantcovka)). Applying an event copied the whole thread's state, so each event cost more as the thread grew, and a long one eventually stopped updating while the work carried on without it. Subagent children drove the count, which is why only those threads hung: 20,000 of them took 36 seconds to apply and now take 8 milliseconds. They are also left out of the thread entirely now, since nothing ever showed them.

## 0.13.0

### New

- **Threads get a short generated title** ([#29](https://github.com/HarjjotSinghh/helicon/issues/29), built by [@orkuhh](https://github.com/orkuhh) in [#28](https://github.com/HarjjotSinghh/helicon/pull/28)). The first prompt still names a thread instantly, then one cheap `muse exec` call replaces the echo with a concise title and pushes it back to Muse Code, so the CLI shows the same name. A typed title, or a name Muse Code chose itself, is never touched, and anything that fails leaves the echo in place. Settings has a switch, a model choice, and says plainly that the calls run on your plan; off means no calls at all.

### Changed

- **Back on Settings and Usage returns where you came from** ([#27](https://github.com/HarjjotSinghh/helicon/pull/27), thanks [@orkuhh](https://github.com/orkuhh)), instead of always going home.
- **The desktop app asks helicon.sh for updates**, falling back to GitHub as before. That request is how we count roughly how many installs are in use, since downloads and stars say nothing about that: the platform, the version, and a hash of the IP salted per week, so two weeks of logs cannot be joined. Nothing about your code, prompts or files leaves your machine, and the README and FAQ both say so.
- **"Muse Code" everywhere it means the CLI.** Meta now ships a consumer assistant called Muse for Mac; Helicon is a client for Muse Code and unrelated to it, so the site and README never say bare "Muse" and both disclaimers name the two apart.

## 0.12.6

### New

- **Linux builds.** Releases now carry an x86_64 AppImage, which runs on most distributions and updates itself from then on. Thanks to [@orkuhh](https://github.com/orkuhh) ([#23](https://github.com/HarjjotSinghh/helicon/pull/23)), who also added Ubuntu to CI. A `.deb` will follow: Tauri's Debian bundler would install the bundled Node.js as `/usr/bin/node`, which collides with Debian's own `nodejs` package.

### Fixed

- **A collapsed sidebar can be reopened from Usage and Settings** ([#24](https://github.com/HarjjotSinghh/helicon/pull/24), thanks [@orkuhh](https://github.com/orkuhh)). Those pages draw their own header and had no toggle, so the only ways back were the Back button and Cmd/Ctrl+B.

### Changed

- **Plan usage says how old its numbers are** ([#26](https://github.com/HarjjotSinghh/helicon/issues/26)). Muse reports your plan's allowance with a model call and at no other time, so each row now carries the reading's age, and the card says plainly that the numbers only move when you send a prompt from a thread here. Work done in the terminal counts against the plan without ever reaching this card.

## 0.12.5

Same app as 0.12.4. GitHub refused the macOS update package on every upload attempt for that release, so macOS could not update itself to it; the release job now retries uploads. Windows users on 0.12.4 lose nothing by updating.

## 0.12.4

### Fixed

- **A failed turn's red banner no longer sticks around** ([#22](https://github.com/HarjjotSinghh/helicon/issues/22)). The banner has a close button, and a closed or retried banner stays closed when the thread reloads; before, reopening the thread or restarting the app brought it back. Once the conversation moves past a failed turn, the failure shows as a small "Failed · reason" note in the history instead of a full banner with no way to act on it.

## 0.12.3

### Changed

- **Ultra is gone from the effort picker.** Checked against a real `muse serve` 1.3.0: picking Ultra sends `max` to the model, so it was Max under another name, and the Muse CLI no longer offers it either. Max is now the top of the scale. A thread or setting left on Ultra carries on as Max, and `/effort ultra` still works and means Max.

## 0.12.2

### Fixed

- **Links open in your browser.** Clicking a link in a reply, like a pull request Muse mentions, did nothing in the desktop app. Web and mail links now open in the default browser or mail app, and a link can no longer navigate the Helicon window away. File links still open in the file viewer.

## 0.12.1

### Fixed

- **macOS stops asking for folder access over and over.** The app bundle was not properly signed, so macOS could not remember an Allow and asked again for every project, once for each process Helicon runs. The whole app is now signed as one, so a protected location like Documents asks once. Builds are not yet signed with an Apple Developer ID, so expect one prompt per location again after each update.

### New

- **Close the plan, goal and background-task cards.** Each card above the composer has a close button. A closed card stays hidden in that thread; while one has something to show, a button in the thread's top bar brings it back.

## 0.12.0

### New

- **Muse for Windows, no WSL.** Muse Code now runs natively on Windows, and Helicon runs it that way. When Muse for Windows is installed (`irm https://dev.meta.ai/install.ps1 | iex` in PowerShell), Helicon runs it directly with your Windows paths, runs `!` commands in PowerShell, and never starts WSL. Muse inside WSL2 keeps working: Helicon uses it when native Muse is not installed, and `HELICON_MUSE_RUNTIME=wsl` (or `--runtime wsl` for the web server) keeps WSL when both are. Threads started in WSL live with WSL's Muse, so they stay there. Setup, the sidebar status and Settings show which one is in use.
- **A file viewer beside the thread.** The folder button in the thread's top bar, or Cmd/Ctrl+Shift+E, opens the project's files on the right: a tree you can search by name, tabs, and a resizable panel.
  - Source files show with syntax highlighting and line numbers, and a link to a line range scrolls to and marks it.
  - Markdown opens as a rendered preview, with a toggle to its source, which you can edit and save (Cmd/Ctrl+S). If the file changed on disk since you opened it, Helicon asks before overwriting.
  - Images, video, audio and PDFs preview in place; anything else opens in its default app.
  - File paths Muse mentions in a reply, the files on read, edit and write tool rows, and the changed-file chips under a turn all open in the viewer. A file Muse edits reloads while it is open.
  - The viewer reads and writes only inside the project folder, and serves files so that a page in the project cannot run inside Helicon.

## 0.11.1

### Fixed

- **Dragging a project to reorder the sidebar works again.** The drop marker showed where a project would land, but letting go left the order unchanged, in the desktop app and in the browser alike. The drop handler was reading which project was being dragged from state captured before the drag began, when nothing was.

## 0.11.0

Built on the Muse Session Protocol methods that shipped with Muse Code 1.3.0, each checked against a real `muse serve` host.

### New

- **Plan usage.** The 5-hour window and the weekly cap, as Muse reports them with each model call, with when each resets. A small meter sits in the sidebar footer and a full card leads the usage page. This is your actual allowance, not the API-rate estimate the rest of the usage page shows. (`usage/read`, `usage/changed`)
- **Goal controls.** `/goal <objective>` now sets the goal through Muse's own goal command, which starts work on it straight away. `/goal pause`, `/goal resume` and `/goal clear` work from the composer, and the goal panel has Pause, Resume and Clear. Hosts without the goal commands keep the old behaviour. (`goal/set`, `edit`, `pause`, `resume`, `clear`)
- **Background tasks.** A running tool call can be sent to the background and keeps running while Muse moves on; one running there can be stopped, and a bar above the composer stops every background task in the thread at once. (`task/background`, `task/stop`, `task/stopAll`)
- **Workflow controls.** Cancel a running workflow, and skip or retry one of its agents from the workflow details sheet. (`workflow/cancel`, `workflow/childControl`)
- **Subagent controls.** Message a running subagent, give a finished one a follow-up task, stop, pause, resume, reopen or close it. These appear on subagents that carry a subagent id; Muse Code 1.3.0 does not report one yet (meta-models/muse-code-sdk#13), so they light up once it does. (`subagent/*`)
- **Full tool output.** Output Muse trimmed in the view gets a "Show full output" button that reads the stored log a page at a time. (`item/readOutput`)

### Fixed

- **Reasoning effort now takes effect.** Muse Code 1.3.0 accepts the effort sent with each turn and then drops it before the model call (meta-models/muse-code-sdk#6). Helicon now also sets it as the session's standing default, which Muse does apply, and the effort picker updates the open thread immediately.

### Changed

- **Skills come from the session.** With a thread open, the slash menu lists the skills Muse itself resolves for that session, and refreshes when Muse says they changed; the `muse skills list` CLI call remains for new threads and for reading a skill's instructions. Skills that declare an argument hint show it. (`skill/list`, `skill/changed`)
- **Renames reach Muse.** Renaming a thread renames the Muse session too, so the CLI and `/name` addressing see the same name, and a rename made in another Muse client shows up here. (`session/rename`, `session/nameChanged`)
