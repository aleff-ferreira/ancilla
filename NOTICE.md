# Notice

Ancilla is released under the GNU Affero General Public License, version 3 ([LICENSE](LICENSE)).
Copyright (c) 2026 Aleff Ferreira Francisco.

Portions of Ancilla derive from Helicon, Copyright (c) 2026 Harjot Singh Rana and contributors, under the MIT License; its notice is kept in [LICENSE-HELICON](LICENSE-HELICON).

Ancilla is not made, endorsed, or supported by Meta, and is not affiliated with Meta. "Muse" and "Muse Code" are
trademarks of Meta, used only to describe what this client connects to.

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
- Please report problems
  with the DeepResearch feature in [this repository](https://github.com/aleff-ferreira/ancilla/issues), not upstream.

## Third-party software

The desktop installers bundle Node.js and the npm and Rust packages Ancilla is built from. Their licenses and notices
are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
