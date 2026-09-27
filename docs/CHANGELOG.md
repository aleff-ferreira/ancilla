# Changelog

## Unreleased

### Fixed

- **Research workers show up in the Swarm card, panel and Activity drawer.** A research run used to leave the Swarm panel saying "No agents in this thread" while its workers were out. Now the run is a run there like a workflow: each round is a phase ("Round 2 of 12"), each worker a row with its searches, reads and saves, the inspector explains why a worker has no Retry or Skip of its own, and Stop, whether on the run or through Stop everything, ends the research run the way the composer's switch says.
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
- **Agents and tasks, redesigned.** A thread that runs a Muse workflow, a native subagent or a background task shows one Swarm card in the dock, in place of the workflow card in the transcript and the strip of agent cards under the thread title; a thread running nothing shows no card at all. Collapsed, the card is one line per run or task: a cell per agent grouped by phase, `Judge · 6 of 10`, and chips only when something needs you, failed or has gone quiet. Expanded, it lists what needs attention first, with Retry, Skip, Review and Stop on the row, and opens one phase at a time; when the run ends it becomes a short report: "All ten landed.", the longest agent, the most tokens, where the time went, and the first lines of what Muse wrote. A Swarm panel (Ctrl/Cmd+Shift+M, in the files panel's slot) adds the numbers: tokens and a cost estimated at list price, slots in use, a timeline with one lane per agent and retries on the same lane, a roster you can filter and search, and an inspector per agent with its lifecycle, its task read from the workflow script, and what Muse did not report. An Activity drawer (Ctrl/Cmd+Shift+A) lists what needs you, what is working and what finished today, with Stop everything; the sidebar row, the thread header and the window title carry the same counts. Everything shown is something Muse sent: a quiet agent reads "No update for 4m 12s" only past the run's own threshold, never "stalled"; tool calls, results and reasons for a failure appear when Muse reports them, and until then the surface says so in words rather than leaving a blank. It reads the updates Muse already sends, so there are no extra model calls, no polling and no limit on how many agents run, and a thread whose feed goes quiet shows its last known state with every clock stopped.
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
