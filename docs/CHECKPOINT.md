# Ancilla Engineering Checkpoint

This checkpoint records completed capabilities, architectural decisions, measured benchmarks, platform verification boundaries, and remaining priorities for Ancilla.

---

## 1. Completed Milestones

### Provider-Independent Model Access
- **Unified `BrainProvider` streaming abstraction (`packages/server/src/voice/brain.ts`, `voice/anthropic.ts`, `voice/openai.ts`, `voice/muse.ts`, `voice/local-models.ts`):**
  - Supports **Muse CLI**, **Anthropic Messages API** (`/v1/messages`), **OpenAI-compatible cloud providers** (OpenAI, Gemini, OpenRouter, Groq), and **local CPU/GPU servers** (Ollama, LM Studio, llama.cpp, vLLM) with automatic local port discovery (`11434`, `1234`, `8080`, `8000`).
  - Handles reasoning-model `<think>...</think>` blocks via `ReasoningStripper`, gracefully retries servers that reject `stream_options`, and automatically falls back to `withTextTools` (`[[tool_name {...}]]`) for local models without native tool-calling schemas.
- **Muse-independent workspace read, write, and check execution (`packages/server/src/assistant/brain-step.ts`, `assistant/executive.ts`):**
  - `runBrainReadStep` and `runBrainWriteStep` execute read-only research and user-approved project modifications directly on the configured `BrainProvider` whenever Muse CLI is unavailable.
  - Enforces strict workspace confinement (`realpath` boundary checks, symlink rejection, `.git`/`.githooks`/`.env*` protection), optimistic `mtimeMs` locking, literal `$` token preservation during edits, and non-shell allowlisted verification commands (`node`, `npm`, `npx`, `pnpm`, `yarn`, `bun`, `tsc`, `pytest`, `python`, `python3`, `cargo`, `go`, `dotnet`, and read-only `git` inspection subcommands).

### Integrated Browser Environment
- **Self-owned Chromium over private CDP pipe (`packages/server/src/browser/` & `packages/ui/src/components/browser/`):**
  - Separate `you` (persistent profile & sign-ins across restarts) and `assistant` (isolated context reset per web task) sessions, with zero external browser-automation service dependency.
  - **Opt-in sign-in hydration (`signInGate` / `always-signed-in` / `once-signed-in`):** copies cookies one-way for explicitly approved origins from `you` into `assistant` while keeping non-GET requests gated by `commitGate` (`ActionAsk`).
  - **Desktop-grade downloads (`browser/downloads.ts`):** native OS destination folder picker (`pickNativeFolder` across Windows PowerShell/WinForms, macOS `osascript`, and Linux `zenity`/`kdialog`), optional remembered download destination, collision-free `freeName`, executable warnings, and path-traversal sanitization.
  - **Controlled file uploads (`Page.fileChooserOpened` -> `DOM.setFileInputFiles`):** native OS multi-file picker (`pickNativeFiles`) + directory listing fallback, `lstatSync` regular-file validation (refusing symlinks, folders, devices, and files over 256 MB), and human-only path selection across both `you` tabs (`UploadBox`) and `assistant` web tasks (`ActionQuestionCard`), keeping `BROWSE_TOOLS` 100% path-free.
  - **Agent interaction controls (`browser/agent.ts`):** `open`, `read`, `click`, `type`, `select`, `hover`, `press`, `scroll`, `wait`, `back`, and `done`.

### Modular Connector System
- **Official API & MCP architecture (`packages/server/src/connectors/` & `packages/ui/src/components/assistant/ConnectorsPanel.tsx`):**
  - Built-in official REST and MCP connectors for **GitHub**, **Gmail**, **Google Drive**, **Supabase**, **Brevo**, and **Hostinger**, extensible via manifest-driven registration.
  - **OAuth 2.0 + PKCE (`S256`) loopback authentication (`connectors/oauth.ts`), refresh-token rotation, and revocation:** ephemeral `127.0.0.1` callback listener, `0o600` credential storage (`FileSecretStore`), automatic token refresh within 60 seconds of expiry across restarts, and provider revocation on disconnect.
  - **Taint tracking & argument-bound write gates (`connectors/gate.ts`, `connectors/audit.ts`):** tracks untrusted external reads (`ReadLog`), binds consequential write approvals to SHA-256 hashes of normalized tool arguments (`WriteGate`), redacts credentials from outputs, and records JSONL audit trails.

### Full-Duplex Voice Assistant
- **Portable local & HTTP speech engines (`packages/server/src/voice/`):**
  - Supports offline `sherpa-onnx` packs AND zero-download HTTP `/audio/transcriptions` + `/audio/speech` servers (`HttpWhisperAsr`, `HttpSpeechTts`) paired with pure-JS CPU `AdaptiveEnergyVad`.
- **Natural turn-taking, barge-in, echo immunity, and task continuity (`voice/turn.ts`, `voice/session.ts`, `voice/tools.ts`, `voice/text.ts`):**
  - Mid-utterance self-correction endpoint holds (`wait no`, `I mean`, `quer dizer`, `ou melhor`), speculative `end_candidate` memory/harness context pre-warming during endpoint silence, bilingual English / Brazilian Portuguese code-switching, and context-sensitive TTS pacing (`paceForText`).
  - Instant keyword/sustained-speech barge-in (`SpokenLedger` trims history to only what was actually played through speakers), 1-2 word and multi-word speaker-echo suppression with ring-buffer pre-roll advancement past dismissed echo, interrupted tool-execution ledger, and idempotent task/proposal deduplication across retries and merged turns.

---

## 2. Measured Validation Results

| Benchmark / Suite | Result | Notes |
| --- | --- | --- |
| Voice comprehension accuracy (`voice-conversation-eval.test.ts`) | **100% (1.00)** | Covers mid-sentence repair, persistent memory disambiguation, casual remarks, and EN/PT code-switching |
| Intent preservation & write-gate safety | **100% (1.00)** | Zero unapproved writes; casual remarks trigger zero tools; retries/interruptions create zero duplicate tasks |
| Unnecessary clarification rate | **0% (0.00)** | Resolves context from persistent `MemoryStore` when unambiguous; asks concise single clarification when genuinely ambiguous |
| Endpoint & first-audio latency (simulated call clock) | **Endpoint p50 <= 560 ms; First-audio p50 <= 950 ms** | Speculative `end_candidate` pre-warming hides 180 ms async memory lookup inside endpoint silence |
| Barge-in stop latency & echo rejection | **<= 420 ms stop; 0 false interruptions** | Suppresses both multi-word and 1-2 word speaker bleed while honoring 1-word EN/PT stop commands (`Stop`, `Espera`) |
| Cross-subsystem restart interoperability (`assistant-interoperability.test.ts`) | **Pass** | Memory -> bilingual voice -> approved `withTextTools` write & `node --check` -> restart -> OAuth PKCE refresh -> browser sign-in hydration, upload, and download |
| Full monorepo test suite (`npm test`) | **4,101 passed / 0 failed / 25 skipped** | `daemon`: 298, `server`: 1,721 (+25 live-Chromium skips in headless WSL), `ui`: 1,626, `web`: 61, `scripts`: 395 |
| Licence & attribution gates | **Pass** | `THIRD_PARTY_NOTICES.md` up to date (181 packages, zero added dependencies); zero tool attribution across history |

---

## 3. Platform & Verification Matrix

| Capability | Linux / WSL (Verified Live in Test Runner) | Windows & macOS | Boundary Notes |
| --- | --- | --- | --- |
| Core server, SQLite memory, executive, `BrainProvider` adapters, `runBrainReadStep` / `runBrainWriteStep` | Verified live on Node >= 22 | Portable pure Node.js (`path` / POSIX-normalized workspace guards) | Windows drive-letter & backslash escape vectors unit-tested directly |
| Browser CDP session isolation, sign-in hydration, download staging, upload validation, UI panels | Verified via deterministic CDP pipe harness + UI tests | Chromium discovery paths cover Windows Registry/Program Files, macOS `/Applications`, and Linux `PATH` | Live Chromium UI tests auto-skip inside headless WSL when no Linux browser binary is installed |
| Native folder & file pickers (`pickNativeFolder`, `pickNativeFiles`) | Command construction, env-var passing, and headless fallback verified via mocked `exec` | PowerShell `FolderBrowserDialog`/`OpenFileDialog` (Win) & `osascript` (macOS) verified via mocked `exec` | Interactive OS GUI dialog windows require a desktop display session |
| OAuth 2.0 + PKCE & official REST/MCP connectors | Ephemeral `127.0.0.1` HTTP callback server, S256 challenge, `0o600` persistence, refresh, and drivers verified against local HTTP/MCP fixtures | Portable Node HTTP/crypto | Live third-party OAuth sign-in requires user-supplied provider OAuth client IDs / API credentials |
| Voice full-duplex session, `AdaptiveEnergyVad`, `HttpWhisperAsr`, `HttpSpeechTts` | Live WebSocket binary audio call + deterministic multi-turn harness verified on CPU | Pure TypeScript/Node + WebAudio UI | Optional offline `sherpa-onnx` binary pack requires one-time user-initiated download (~0.6 GB) |

---

## 4. Remaining Future Priorities

1. **Native Speech-to-Speech Realtime Socket Transport (Optional Cloud Fast-Path):** Add an optional WebSocket audio-to-audio provider adapter alongside the hybrid VAD + streaming ASR + Brain + TTS pipeline while preserving `SpokenLedger` and screen-only approval invariants.
2. **Additional Connector Catalog Drivers:** Expand first-party connector templates (e.g., Linear, Slack, Notion, Calendar) on top of `OAuthFlowManager` and `ConnectorRegistry`.
3. **Desktop E2E Smoke Workflow with Headless Chromium Installed in CI:** Install `chromium` in Linux CI jobs so the 25 real-browser CDP integration tests run alongside the deterministic CDP pipe suite on every push.

---

## 5. Build, Test, and Compliance Commands

```bash
# Build individual workspaces (do not run root `npm run build`, which invokes `tauri build`)
npm run build --workspace @ancilla/daemon --workspace @ancilla/ui --workspace @ancilla/server
npm run build --workspace @ancilla/web

# Full monorepo test suite (daemon, ui, server, web, and repository scripts)
npm test

# Attribution and third-party licence compliance checks
npm run attribution:check
npm run notices:check
```
