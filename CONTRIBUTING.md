# Contributing to Ancilla

Ancilla is an open-source desktop and web workspace built for Meta's Muse Code CLI alongside supported developer CLIs and model APIs.

## Development Principles

- **Branding & attribution:** Keep third-party affiliation disclaimers in [README.md](README.md) and statutory notices in [NOTICE.md](NOTICE.md). Preserve all neutral UI surfaces without adding external vendor marks to binary names, bundle IDs, domains, or icons.
- **Credentials & privacy:** Never commit secrets (`.env`, `auth.json`, API keys, or release signing keys), user-specific filesystem paths, or private transcripts. Use placeholder paths such as `/home/USER/...` or `C:\Users\USER\...` in documentation and tests.
- **Explicit approvals & honest state:** Always surface real approval prompts and permission modes accurately. Never bypass approvals or fabricate progress; stalled live feeds are handled strictly via read-only recovery ([docs/muse-recovery.md](docs/muse-recovery.md)).
- **Shared UI layer:** Place reusable interface components inside `packages/ui` rather than duplicating logic inside `apps/*`.
- **Stdout contract:** The Tauri desktop shell relies on the server's initial `stdout` line for startup readiness. Keep all diagnostic logging on `stderr`.

## Repository Layout

- `packages/daemon`: MSP protocol integration (`@muse-code/sdk`), `muse serve` stdio supervision, and SQLite persistence.
- `packages/server`: HTTP and Server-Sent Events (SSE) API bridge, CLI profile management, assistant runtime, and research orchestration.
- `packages/ui`: Shared React interface and state models consumed by both desktop and web targets.
- `apps/desktop`: Tauri v2 native desktop shell (`src-tauri`) bundling the server sidecar across Windows (native and WSL2), macOS, and Linux.
- `apps/web`: Browser entry point and standalone simulated demo environment.

## Building and Testing

```bash
npm ci
npm run build --workspace @ancilla/daemon --workspace @ancilla/ui --workspace @ancilla/server
npm run build --workspace @ancilla/web
npm test
npm run test:scripts
```

Desktop native builds require Rust and system [Tauri prerequisites](https://tauri.app/start/prerequisites/). Run `npm run dev --workspace ancilla-desktop` for local desktop development.

## Versioning & Pull Requests

- Follow Semantic Versioning (`vX.Y.Z`) paired with [docs/CHANGELOG.md](docs/CHANGELOG.md) updates for user-visible changes.
- Keep pull requests focused and backed by automated tests before submission; open an issue to align on larger architectural changes.

## Licensing

All contributions are licensed under the [GNU AGPL v3](LICENSE).
