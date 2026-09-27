# Notice

Ancilla is a fork of [Helicon](https://github.com/HarjjotSinghh/helicon), the open-source desktop and web client for
Meta's Muse Code CLI created by Harjot Singh Rana and the Helicon contributors. Helicon is released under the MIT
License, whose notice is kept in [LICENSE-HELICON](LICENSE-HELICON) as it requires. Ancilla is released under the GNU
Affero General Public License, version 3 ([LICENSE](LICENSE)). Copyright (c) 2026 Aleff Ferreira Francisco.

## Origin

- Forked on 2026-09-26 from Helicon's `prod` branch at commit
  [`8e5b141`](https://github.com/HarjjotSinghh/helicon/commit/8e5b141), which is Helicon v0.17.1.
- The full upstream git history is preserved in this repository. Every Helicon commit keeps its original author and
  date; Ancilla's own work is the commits after `8e5b141`.
- Helicon's copyright notice and the MIT permission notice are kept in [LICENSE-HELICON](LICENSE-HELICON), as the
  license requires.

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

## Deep Dog 2

Ancilla's DeepResearch engine (`packages/daemon/src/research/`) is a selective TypeScript port of the control plane of
[Deep Dog 2](https://github.com/beneadie/deep_dog_2) by Benjamin Andrew Eadie, which itself builds on
[ThinkDepth Deep Research](https://github.com/thinkdepthai/Deep_Research) by Paichun Lin. Both are released under the
MIT License.

- Ported at Deep Dog 2 commit `fc7981a` (version 2.0.1): the supervisor loop and its exit rules, the research and
  discovery sub-agent discipline, the prompts, the deterministic citation pipeline, and the event vocabulary. Nothing
  else is imported: Ancilla ships no Python, and every model call and web search the engine needs is made by Muse.
- [packages/daemon/src/research/UPSTREAM.md](packages/daemon/src/research/UPSTREAM.md) maps each ported file to its
  upstream source and line ranges, reproduces both MIT notices in full, and describes how to carry upstream changes
  over.
- Deep Dog 2 and ThinkDepth are not affiliated with, and do not endorse or support, Ancilla. Please report problems
  with the DeepResearch feature in [this repository](https://github.com/aleff-ferreira/ancilla/issues), not upstream.

## Third-party software

The desktop installers bundle Node.js and the npm and Rust packages Ancilla is built from. Their licenses and notices
are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
