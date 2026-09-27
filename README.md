# Ancilla

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/aleff-ferreira/ancilla.svg?label=latest)](https://github.com/aleff-ferreira/ancilla/releases/latest)
[![Platform](https://img.shields.io/badge/installer-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg)](https://github.com/aleff-ferreira/ancilla/releases/latest)
[![Tauri](https://img.shields.io/badge/desktop-Tauri%202-FFC131.svg)](https://tauri.app)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme-hero-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme-hero-light.png" />
  <img alt="Ancilla: open-source desktop and web client for the Muse Code CLI" src="docs/assets/readme-hero-light.png" />
</picture>

> **Ancilla** is a desktop and web app for Meta's **Muse Code CLI** (`muse`): a place to run, watch and steer your
> agent threads, with the work Muse does on your machine and your own login.

Ancilla keeps every Muse Code thread you run in one window, grouped by project, so you can read, resume and approve
them without the terminal, follow what a run of agents is doing while it happens, and ask for research that comes back
as a cited report. It works on Windows, macOS and Linux, and on Windows with Muse installed natively or inside WSL.

> **Unofficial community project.** Ancilla is not made, endorsed, or supported by Meta, and is not affiliated with Meta.
> It is a client for the **Muse Code CLI** and is unrelated to the Muse assistant app for Mac. "Muse" and "Muse Code"
> are trademarks of Meta, used here only to describe what this client connects to.

![A thread: the agent's steps, diffs and approvals inline, with the composer docked below](docs/assets/thread.png)

## What it does

- **Projects and threads.** Every thread, including ones started from the `muse` terminal, under the folder it
  worked in; a project can group several folders.
- **Approvals and control.** Approve, steer, stop, queue and resend prompts from the thread, with the approval modes
  Muse offers shown as they are.
- **Agents in view.** When a thread runs subagents, workflows or background tasks, one card says what is going on,
  what needs you and how far along it is; a panel and an activity drawer go deeper.
- **Deep research.** Turn on Research, ask a question, and get a Markdown report in the thread whose sources are
  pages the workers actually read, all on your Muse plan.
- **The rest of the day.** A file viewer beside the thread, a usage page, thread titles, more than one Muse login,
  and a desktop app that updates itself.

More is on the way; the [changelog](docs/CHANGELOG.md) says what each release added.

<details>
<summary>More screenshots</summary>

![Agents at work in a thread](docs/assets/agents.png)

![Starting a thread](docs/assets/home.png)

![Usage](docs/assets/usage.png)

</details>

## Install

Download the installer for your platform from the
[latest release](https://github.com/aleff-ferreira/ancilla/releases/latest). Ancilla bundles its own Node.js, so the
only requirement is the `muse` CLI with `muse login` done once, however you installed it. Ancilla uses the login you
already have and never stores credentials of its own.

**Windows:** run `Ancilla_<version>_x64-setup.exe`. The installer is not Authenticode-signed yet, so SmartScreen may
warn that it is from an unknown publisher; choose **More info**, then **Run anyway**. Updates after that are
signature-checked by Ancilla's built-in updater before they install.

Install Muse Code for Windows with `irm https://dev.meta.ai/install.ps1 | iex` in PowerShell. Already run Muse inside
WSL2? Ancilla uses it when native Muse is not installed; set `ANCILLA_MUSE_RUNTIME=wsl`, or `"runtime": "wsl"` in
[`runtime.json`](docs/muse-recovery.md#runtime-configuration), to keep WSL when both are.

**macOS:** open `Ancilla_<version>_universal.dmg`; one build runs on Apple Silicon and Intel. The app is not
Apple-notarized yet, so the first launch needs a right-click on the app, then **Open** (on recent macOS, **System
Settings > Privacy & Security > Open Anyway**).

**Linux:** download `Ancilla_<version>_amd64.AppImage` (x86_64). It runs on most distributions; some need FUSE
(`libfuse2`). Make it executable and run it (`chmod +x Ancilla_*.AppImage`, then `./Ancilla_*.AppImage`), or allow
executing it as a program in your file manager.

The desktop app updates itself from this repository's releases, and Settings can pause that. To hear about new
versions, use **Watch > Custom > Releases** at the top of this page.

### Migrating from Helicon

Ancilla has its own app identifier, data directory and settings, so it installs beside Helicon and does not read or
change Helicon's data. [docs/migrating-from-helicon.md](docs/migrating-from-helicon.md) covers carrying your projects,
titles and settings across.

## Build from source

Prerequisites: Node 22+, the `muse` CLI with `muse login` done once (natively, or in WSL2 on Windows), and this
repository checked out.

```bash
npm ci
npm run build --workspace @ancilla/daemon --workspace @ancilla/ui --workspace @ancilla/server
npm run build --workspace @ancilla/web
npm test

# Web app (serves the built UI plus the API on :3127)
npm run serve --workspace @ancilla/web
# open http://127.0.0.1:3127, add a folder, start a thread
```

Projects, pins, thread titles and archive state persist in `~/.ancilla/ancilla.db` (pass `--data-dir` to the server to
move it, or `:memory:` for a throwaway run). The desktop app keeps the same files in its own app data directory. Threads
you started from the `muse` terminal are discovered automatically and appear under their project.

UI development with hot reload:

```bash
# terminal 1: the API against your real muse
node packages/server/dist/src/cli.js --port 3127
# terminal 2: Vite compiles packages/ui straight from source
npm run dev --workspace @ancilla/web
# open http://127.0.0.1:5173
```

The interface lives in `packages/ui` (state model in `src/model`, components in `src/components`); design tokens and the
visual system are documented in [docs/DESIGN.md](docs/DESIGN.md).

```bash
# Desktop app (dev shell; needs Rust and the Tauri prerequisites for your OS)
npm run dev --workspace ancilla-desktop
```

A local `tauri build` signs update artifacts, so it needs `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` set; pass `--config '{"bundle":{"createUpdaterArtifacts":false}}'` to skip that
for a build you only run yourself.

Releases ride on tags: pushing `vX.Y.Z` runs the Release workflow, which builds the Windows installer, then the universal
macOS build, then the Linux AppImage, and attaches them to a GitHub Release with the updater's `latest.json`. Releases
must not be marked prerelease, or the updater will not see them.

## Remote daemon

The web app can run against a server on another machine. Start it there with a token and the origin that will load the
page:

```bash
node packages/server/dist/src/cli.js --host 0.0.0.0 --port 3127 \
  --token "$(openssl rand -hex 24)" --allow-origin https://ancilla.example
```

Then load the page, go to `#/connect`, and give it the address and the token. Both are kept in local storage rather
than in the URL: the token is exchanged once for an `HttpOnly` cookie, which is what the event stream authenticates
with, since `EventSource` cannot carry a header.

Two things fail closed deliberately:

- An origin that was never passed to `--allow-origin` gets no CORS headers and no answer at all.
- A token in the query string counts only for requests carrying no other site's origin, so a copied link hands over
  nothing.

Browsers only accept cross-site cookies over HTTPS, so a server reached from another origin needs TLS or a tunnel in
front of it. On the same machine none of this applies: `#/connect` with an empty address uses the server that served
the page, and no token is needed unless one was set.

## Architecture

A local server talks to the `muse` CLI on your machine through its own session protocol, using your own `muse login`,
and keeps Ancilla's state in a local SQLite file. The desktop app runs that server bundled with a Node.js runtime; the
web app is the same interface in a browser against a local or remote server. Credentials never pass through Ancilla.

## What leaves your machine

Your code, prompts, threads and files stay where they are. Ancilla talks to the `muse` CLI on your own computer, with
your own login, and keeps its state in SQLite beside it. There is no account, no telemetry and no analytics in the app.

The only request Ancilla makes on its own schedule is the desktop app's **update check**: soon after launch and every
six hours it fetches `latest.json` from this repository's
[GitHub Releases](https://github.com/aleff-ferreira/ancilla/releases). A newer version's installer is downloaded from
the same release, and its signature is verified before it installs. **Pause updates** in Settings stops the automatic
checks. The web app has no updater.

Other traffic happens because of Muse or because of what you open:

- **Muse Code itself** talks to Meta's services under your login; that is what running an agent means. Features that
  call `muse` for you, like generated thread titles (one `muse exec` call on your plan, and a switch in Settings) and
  in-app `muse login`, go the same way.
- **Images in Markdown** that point at a web address, in Muse's replies or in a Markdown file you preview, load from
  that address, the same way a browser shows them. The interface does not block or proxy them.
- **Adding a project from a Git URL** runs `git clone` on your machine.
- **The web app** connects to the server address you give it on `#/connect`.
- **Links in replies** open in your default browser.
- **Building from source** downloads npm packages, and the desktop build downloads Node.js from `nodejs.org`.

## Legal

- Wrapper clients are the intended path: Meta ships an MIT-licensed SDK for building MSP clients, and Ancilla is built
  on it.
- **Name:** `Ancilla` avoids the `Muse` mark. Do not introduce `Muse` into the binary name, bundle ID, domain or title.
- Ancilla never claims to be official, never bundles credentials, and never bypasses billing or approvals.
- Contributor-tier models: prompts and completions sent to them may be used to improve Meta's products. The model
  picker marks those models and says so.
- See also: [Meta Brand Resources](https://www.meta.com/brand/resources/meta/our-trademarks),
  [Muse Code product page](https://developer.meta.com/ai/products/muse-code),
  [Model API docs](https://dev.meta.ai/docs/coding-agents).

This section is not legal advice.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md); pull requests are welcome. Report vulnerabilities as described in
[SECURITY.md](SECURITY.md), not in a public issue.

## License

[GNU AGPL v3](LICENSE). Copyright (c) 2026 Aleff Ferreira Francisco. Anyone who changes Ancilla and runs it for others,
or ships it, must offer their version's source under the same license.

Portions of Ancilla derive from Helicon, Copyright (c) 2026 Harjot Singh Rana and contributors, under the MIT License; its notice is kept in [LICENSE-HELICON](LICENSE-HELICON).
Bundled third-party software is listed with its licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
