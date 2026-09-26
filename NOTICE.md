# Notice

Ancilla is a fork of [Helicon](https://github.com/HarjjotSinghh/helicon), the open-source desktop and web client for
Meta's Muse Code CLI created by Harjot Singh Rana and the Helicon contributors. Helicon is released under the MIT
License, and so is Ancilla.

## Origin

- Forked on 2026-09-26 from Helicon's `prod` branch at commit
  [`8e5b141`](https://github.com/HarjjotSinghh/helicon/commit/8e5b141), which is Helicon v0.17.1.
- The full upstream git history is preserved in this repository. Every Helicon commit keeps its original author and
  date; Ancilla's own work is the commits after `8e5b141`.
- Helicon's copyright notice and the MIT permission notice are kept in [LICENSE](LICENSE), next to Ancilla's own
  copyright line, as the license requires.

## What Ancilla changed

- **A new name and identity.** The product, packages, binaries, bundle identifier (`app.ancilla.desktop`), environment
  variables (`ANCILLA_*`), data locations (`~/.ancilla`, `ancilla.db`) and browser storage keys were renamed, so
  Ancilla installs beside Helicon without sharing its state.
- **Muse session recovery.** When Muse's live feed stalls, Ancilla keeps reading the thread's saved progress instead of
  showing a frozen turn, and never resends a prompt or resumes a running turn to do it. A synthetic `incomplete` failure
  that Muse reports for a turn that is still running is no longer shown as a failure. See
  [docs/muse-recovery.md](docs/muse-recovery.md).
- **An Agents panel in every thread** for native Muse subagents and workflow children. See
  [docs/agent-activity.md](docs/agent-activity.md).
- **No duplicate prompt bubbles** when a prompt with attachments is saved by Muse while its local preview is still
  showing. See [docs/prompt-echo-reconciliation.md](docs/prompt-echo-reconciliation.md).
- **Local thread titles** (`syncSessionNames: false`), which keep titles out of Muse to avoid a workflow event-log decode
  failure in Muse 1.4.0.
- **Windows and WSL fixes:** `\\wsl.localhost\<distro>\...` project folders, in-app login when Muse runs in WSL, and a
  per-machine `runtime.json` that can forward environment variables into WSL.
- **Distribution.** Updates come from this repository's GitHub Releases. Helicon's website, its update endpoint, landing
  page, social and promotional media, and winget packaging are not part of Ancilla.

[docs/CHANGELOG.md](docs/CHANGELOG.md) and the git history have the details.

## Names and trademarks

- "Helicon" and the Helicon logo belong to their authors. Ancilla does not use them as its name or branding; the Helicon
  name appears only where Ancilla credits its origin or describes a migration from Helicon.
- Ancilla is not affiliated with, endorsed by, or supported by the Helicon project or its authors. Please report
  problems with Ancilla in [this repository](https://github.com/aleff-ferreira/ancilla/issues), not upstream.
- "Muse" and "Muse Code" are trademarks of Meta, used here only to describe what Ancilla connects to. Ancilla is not
  made, endorsed, or supported by Meta.

## Third-party software

The desktop installers bundle Node.js and the npm and Rust packages Ancilla is built from. Their licenses and notices
are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
