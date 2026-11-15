# Product Requirements Document (PRD): Ancilla

> **Status**: Living Architectural Specification · **Target**: Cross-Platform Desktop (Tauri 2) & Modern Web Client · **Architecture**: Local-First Subprocess Supervision & Secure Native Daemon · **Integrity Baseline**: >4,300 Automated Test Assertions

---

## 1. Executive Summary & Vision

**Ancilla** is an open-source, local-first developer environment and graphical workspace designed for autonomous and interactive programming with CLI agent hosts. Developers interact with state-of-the-art AI coding agents—including Meta Muse Code, Anthropic Claude Code, OpenAI Codex, and ACP (Agent Client Protocol) servers—within an observable, multi-threaded interface featuring workspace grouping, resumable turn sessions, real-time streaming transcripts, inline visual diff review, and strict human-in-the-loop safety controls.

Ancilla operates under an unwavering principle of **data sovereignty and local custody**: credentials never leave the host machine, user approvals govern tool side effects, and agent operations run natively on the host or inside managed virtualization environments (such as WSL2) without centralized cloud intermediaries.

---

## 2. Core Architecture & Subsystem Layout

Ancilla is structured as a high-performance monorepo composed of decoupled packages and runtime shells:

```
ancilla/
├── apps/
│   ├── desktop/            # Native Tauri 2 wrapper (macOS, Windows, Linux)
│   └── web/                # Vite React single-page application & client
├── packages/
│   ├── daemon/             # Subprocess supervision, SQLite store, WSL translation, multi-provider runners
│   ├── server/             # Node.js HTTP/SSE REST server, Assistant engine, tool execution
│   └── ui/                 # React component library, turn folding engine, state controller
├── scripts/                # Packaging pipelines, legal attributions, release verification
└── docs/                   # Architectural specifications and technical design records
```

### 2.1 Foundational Subsystems
1. **Daemon Engine (`packages/daemon`)**:
   - Manages local SQLite persistence (`ancilla.db`) for workspaces, sessions, and turns.
   - Supervises agent host subprocesses (`sessions.ts`) over stdio JSON-RPC.
   - Provides seamless Windows-to-WSL2 path mapping, distribution probing, and environment bridging.
   - Houses the multi-provider driver matrix (Muse Session Protocol MSP, Claude Code, Codex, ACP).
2. **Server Runtime (`packages/server`)**:
   - Dispatches HTTP REST endpoints and Server-Sent Events (SSE) streaming updates to connected clients.
   - Executes autonomous Assistant operations, persona configurations, and long-term memory retrieval (`assistant.db`).
   - Hosts Deep Research parallel query planning and report generation.
3. **UI Engine (`packages/ui`)**:
   - Renders interactive turn folding (`fold.ts`), collapsible tool call traces, and token streams.
   - Visualizes live agent status glyphs, crew activity monitors, and inline unified diffs.
   - Encapsulates UI state management with zero external state framework bloat.
4. **Desktop Shell (`apps/desktop`)**:
   - Tauri 2 Rust process hosting the bundled Node.js server sidecar.
   - Coordinates frameless window controls, native menus, update channels, and system tray integration.
5. **Web Client (`apps/web`)**:
   - Single-page application serving local and self-hosted remote daemon instances over secure REST/SSE.

---

## 3. Detailed User Stories & Functional Requirements

### 3.1 Workspace & Project Management
1. **Directory Grouping**: Developers can inspect all projects grouped by working directory or git worktree root.
2. **Worktree Isolation**: Parallel agent branches display dedicated worktree badges to eliminate context collision.
3. **Favorites & Search**: Developers can pin critical workspaces and search projects instantly by name or filesystem path.
4. **Editor Integration**: One-click opening of projects in external editors (`code`, `cursor`, system file explorers).

### 3.2 Session Persistence & Interactive Threading
5. **Resumable Threads**: Every turn, tool invocation, and token stream is persistently journaled in SQLite and instantly resumable.
6. **Bidirectional Terminal Interoperability**: Sessions initiated from terminal CLI TUIs can be adopted and resumed in the GUI via protocol synchronization.
7. **Interactive Steering**: Developers can inject follow-up instructions into an active turn to redirect agent planning without process restarts.
8. **Graceful Interrupts**: Clean cancellation signals halt running tools immediately, conserving computation and token quota.
9. **Queue Management**: Developers can batch subsequent user prompts while an agent turn executes.
10. **Context Compaction Tracking**: Explicit visual indicators identify when an agent summarizes prior conversation history.

### 3.3 Visual Diff Review & File Operations
11. **Inline Unified Diffs**: File modifications display syntax-highlighted diffs with individual chunk accept/reject controls.
12. **Context Mentions**: Prompt composer supports `@`-mentions for workspace files respecting `.gitignore` rules.
13. **Active Editor Attachment**: Current file focus and cursor selections automatically attach to prompt context.
14. **Direct Shell Execution**: Developers can run immediate `!` shell commands from the prompt composer.

### 3.4 Governance, Safety & Approval Policies
15. **Granular Consent**: File modifications, terminal commands, and network accesses require interactive permission grants based on policy.
16. **Configurable Security Posture**: Teams can configure safety policies across `on-request`, `prompt-unmatched`, and `deny-unmatched`.
17. **Unrestricted Mode Safeguards**: Any bypass of approval prompts (`allow-all`) requires an explicit, multi-step confirmation dialog.
18. **Pre-Turn Autosave**: Active editor buffers automatically persist to disk prior to agent turn execution.

### 3.5 Multi-Provider Extensibility
19. **Dynamic Provider Selection**: Threads can switch execution between Meta Muse (MSP), Anthropic Claude Code, OpenAI Codex, and ACP hosts.
20. **Reasoning Effort Controls**: Developers can tune model reasoning effort, temperature, and context parameters per thread.

### 3.6 Cross-Platform Parity & Windows WSL2 Architecture
21. **WSL2 Automatic Configuration**: On Windows hosts, Ancilla automatically discovers WSL2 distributions, guides environment setup, and executes Linux CLI binaries transparently.
22. **Bidirectional Path Translation**: Paths translate seamlessly between Windows UNC formatting (`\\wsl.localhost\Ubuntu\...`) and Linux POSIX paths (`/home/...`).

---

## 4. Security, Credentials & Privacy Invariants

- **Zero Credential Custody**: Ancilla never stores API keys, OAuth tokens, or passwords in application databases or logs. Agent processes authenticate via local CLI credentials (`muse login`, environment variables, or platform keychains).
- **Network Boundaries**: Remote daemon connections fail closed if credentials appear in URLs. Connections require explicit loopback or authenticated endpoints.
- **Local-First Telemetry**: All diagnostics, performance metrics, and logs reside exclusively on the user's local filesystem.

---

## 5. Verification & Quality Assurance Baseline

- **Test Suite Integrity**: Ancilla maintains a comprehensive test suite of >4,300 unit and integration tests across all packages (`npm test`).
- **Deterministic Artifacts**: Release pipelines generate verified binaries (macOS universal DMG/app, Windows NSIS installer, Linux AppImage/DEB/RPM).
- **Attribution Enforcement**: Repository hooks strictly enforce independent authorship and license compliance (`npm run attribution:check`).
