## Summary & Context

<!-- Provide a concise explanation of what this pull request changes and the motivation behind it. -->
<!-- Link any relevant issues: "Fixes #123" or "Addresses #456". -->

## Subsystems Impacted

- [ ] `packages/ui` (React components, turn folding, UI state models)
- [ ] `packages/server` (Node HTTP/SSE REST server, Assistant runtime, tool execution)
- [ ] `packages/daemon` (Process supervision, SQLite persistence, WSL translation, providers)
- [ ] `apps/web` (Vite single-page application)
- [ ] `apps/desktop` (Tauri 2 Rust desktop wrapper)
- [ ] `scripts` (Packaging, legal notices, release verification)
- [ ] `docs` (Architecture, specifications, guides)

## Verification & Testing Performed

<!-- Detail the automated test commands executed and manual validation steps taken. -->

- **Environment**: OS / Arch / Runtime
- **Automated Commands**:
  - `npm run build --workspace @ancilla/daemon --workspace @ancilla/ui --workspace @ancilla/server`
  - `npm run build --workspace @ancilla/web`
  - `npm test`
  - `npm run attribution:check`

## Quality & Compliance Checklist

- [ ] Adheres to single-author commit identity per `CLAUDE.md`.
- [ ] Contains no AI co-authorship tokens (`Co-Authored-By`, `Signed-off-by`, model names).
- [ ] Preserves existing functionality and stability baseline (>4,300 passing tests).
- [ ] Contains zero credentials, personal tokens, private paths, or unredacted secrets.
- [ ] Updates `docs/CHANGELOG.md` for notable functional changes.
