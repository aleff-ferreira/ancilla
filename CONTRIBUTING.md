# Contributing to Ancilla

Thanks for contributing! Ancilla is an open-source desktop and web app for Meta's Muse Code CLI.

## Ground rules

1. The README's "Unofficial community project" note and [NOTICE.md](NOTICE.md) are where Ancilla says it is not
   affiliated with Meta; don't repeat it in names, releases or the app. The app UI stays unbranded.
2. Don't use the `Muse` mark in new binary names, bundle IDs, domains, titles or artwork.
3. Never commit credentials (`auth.json`, `.env`, API keys, signing keys), personal paths or private logs. Use your own
   `muse login`, and write `/home/USER/...` or `C:\Users\USER\...` in examples.
4. Never bypass approvals or billing. Surface approval modes honestly.
5. Never resend a user's prompt or resume a running turn to recover from a stalled feed; recovery reads saved state
   only (see [docs/muse-recovery.md](docs/muse-recovery.md)).
6. One shared UI: put reusable components in `packages/ui`, not in `apps/*`.
7. Keep [LICENSE](LICENSE) and the notice in [LICENSE-HELICON](LICENSE-HELICON) intact.

## Workflow

- Open an issue first for anything beyond a typo or an obvious fix.
- Branch from `main`, keep PRs small and tested.
- Commit messages: a short imperative subject (50 characters or so), and a body only when the "why" is not obvious.
- The desktop launcher reads the first line the server prints to stdout as its readiness handshake. Never print
  anything else to stdout during server startup; diagnostics go to stderr.

## Development

```bash
npm ci
npm run build --workspace @ancilla/daemon --workspace @ancilla/ui --workspace @ancilla/server
npm run build --workspace @ancilla/web
npm test
```

- `packages/daemon`: MSP client via `@muse-code/sdk`, JSON-RPC over `muse serve` stdio, and the SQLite store.
- `packages/server`: the HTTP and event-stream bridge the UI talks to.
- `packages/ui`: the shared React UI.
- `apps/desktop`: the Tauri shell (Rust); Windows runs native Muse or routes through WSL2.
- `apps/web`: the same UI in a browser, against a local or remote server.

Desktop changes need Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS;
`npm run dev --workspace ancilla-desktop` starts the dev shell. CI builds and tests the Node workspaces and checks the
Rust crate on Windows, macOS and Linux.

## Versioning

- Semver. Every release gets a `vX.Y.Z` tag and a GitHub Release with the installers.
- Merged PRs with considerable work bump at least the patch version; routine work never bumps the major version.
- User-visible changes get an entry in [docs/CHANGELOG.md](docs/CHANGELOG.md).

## License

By contributing, you agree that your contributions are licensed under the [GNU AGPL v3](LICENSE) that covers the
project.
