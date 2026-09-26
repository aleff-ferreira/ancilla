# DeepResearch for Ancilla: implementation plan

Status: implemented through stage 2 (see "Implementation notes" at the end for where the build departed from this plan). Written 2026-09-26 against Ancilla `main` at 5342262 (0.18.0) and Deep Dog 2 at `fc7981a` (2.0.1, 2026-09-15). Every statement below is either **verified** in source (file and line given) or marked **ASSUMPTION**. Assumptions that block implementation are collected in section 10.

## 0. Summary of the decision

Deep Dog 2 is not imported. Its control plane and citation pipeline are **selectively ported to TypeScript** as a runtime-agnostic engine package, and **Muse is the engine's model and tool runtime**: every model call and every web search or page read the engine needs is made by Muse, through interfaces Ancilla already uses. The engine never holds a provider key.

Why, in one paragraph. Deep Dog 2 is Python only, in-process only, with no server or stdio protocol (`integration.py` L271, no HTTP or stdin anywhere), its model factory routes a fixed list of model names to hard-coded provider URLs and raises on anything else (`config.py` L1003-1249), and it needs its own LLM and search keys (DeepSeek or Meta, plus Exa or Tavily; `utils.py` L111 builds a Tavily client at import). Ancilla ships no Python, has no provider keys of its own, no keychain, and makes every model call through Muse: session turns over MSP, or the `muse exec` CLI for one-shot calls (`packages/server/src/server.ts` L3196-3217). Muse has web tools built in (the title call passes `--disable-web-tools` to switch them off, same lines). So the lowest-coupling arrangement that keeps Muse primary is: port the parts of Deep Dog 2 that are pure logic (supervisor loop, sub-agent curation discipline, budgets, prompts, deterministic citation pipeline, event vocabulary), and hand every model and tool call to Muse. The parts of Deep Dog 2 that would fight Ancilla (LangGraph wiring, provider zoo with private LangChain monkeypatches, file and console output, moderation, the broken subtopic feature) are not ported.

## 1. What was verified

### 1.1 Deep Dog 2 (`/home/user/deep_dog_2`)

- Entry: `async run_research(prompt, config, runtime, credentials) -> ResearchResult` (`integration.py` L271-464). In-process Python, async only. Status is `completed | failed | cancelled | partial` (`timed_out` declared, never set).
- Pipeline (`research_agent_full.py` L288-318): `clarify_with_user` (disabled, always passes through; `research_agent_scope.py` L45-76) → `write_research_brief` (JSON-mode structured output, L78-131) → `write_draft_report` (L133-185, 420 s cap) → supervisor subgraph → `final_report_generation`.
- Supervisor (`multi_agent_supervisor.py`): reflect via `think_tool` whose text carries `VERDICT: CONTINUE_RESEARCH` (L156-174); delegate by calling `Research*` tool schemas which become sub-agent invocations run with `asyncio.gather` and a per-agent `wait_for(subagent_timeout+30)` (L681); exit on iteration cap, no tool calls, elapsed ≥ max+1 min, or `ResearchComplete` not overridden by a CONTINUE verdict (L522-529). Circuit breaker on all-agents-failed with 429/quota (L746-765); retry-once, then salvage (write with what exists if ≥60% of the window elapsed) or abort (L778-821). Final writer: supervisor model, no tools, two attempts, rejects empty/identical-to-draft/refusal output, then `finalize_citations(renumber=True)` (L869-1023). No timeout on the writer.
- Sub-agent (`agents/base.py`): tool loop with per-turn tool subsetting, budgets for searches, reads per round, total reads, saves, iterations, and concurrency (L639-1343); `[S#]`/`S#n` handles per search hit (L385-424); deterministic compression with no LLM in `sources` modes (L1412-1549).
- Citations (`citation_utils.py`): registry codes per agent, remapped `A{n}-S#` at the supervisor (`multi_agent_supervisor.py` L694-715), `build_final_registry` dedups by URL (L286-343), `finalize_citations` keeps only cited codes that exist, renumbers to `[1..N]`, appends a code-built `## Sources` section; unknown codes stay as raw text (L179-283). Validation is structural only.
- Events (`events.py`): `run_started`, `config_validated`, `scope_started/completed`, `draft_started/completed`, `supervisor_iteration`, `delegation_started`, `subagent_started/completed/failed`, `source_found/read/saved`, `report_started`, `citations_validated`, `run_completed/failed/cancelled`. Per node and per tool batch; no token streaming. Trace channel separate (`trace.py`).
- Cancellation cooperative only, checked between nodes (`integration.py` L367 and listed nodes); a raised `CancelledError` yields no result.
- Budgets: hard per sub-agent tool caps; supervisor iteration cap; wall time checked between supervisor turns; no token or cost accounting; sub-agent parallelism unbounded in code (prompt text only).
- Checkpointing: `InMemorySaver` by default, `RuntimeOptions.checkpointer` accepted, but resume is not implemented (`RuntimeContext.from_snapshot` has no caller).
- Known defects: `recursion_limit` passed inside `configurable` (`integration.py` L334-336, probable default-25 limit); subtopic generation references misnamed event constants (`research_agent_full.py` L165/L270 vs `events.py` L40-41); unconditional `print()` in the supervisor and tool node; `tool_timeout` unused; OpenAI and Gemini ignore per-run credentials; Reddit token cache is process-global; `praw` declared but unused.
- License: MIT, Benjamin Andrew Eadie, itself building on ThinkDepth Deep Research by Paichun Lin (README "Attribution").

### 1.2 Ancilla and Muse (`/home/user/ancilla`)

- MSP (`node_modules/@muse-code/sdk/dist/src/msp.d.ts`): methods `session/{start,resume,fork,list,read,compact,setModel,userShell,setApprovalMode}`, `turn/{start,steer,interrupt,cancel,unqueue}`, `model/list`, `view/{page,unsubscribe}`, `approval/*`, `userInput/*`, `subagent/*` (L1895). `turn/start` input parts are `text | image` only, no mode, skill, workflow or tool selector (L1466, L1538). `SessionConfig` has no members (L945). Nothing in the SDK or Ancilla registers tools or MCP servers. No client verb launches a workflow; workflows are launched by the model through a `toolCall` with `tool: "workflow"` (`packages/ui/src/model/swarm.ts` L602-660).
- Additional verbs Ancilla uses beyond the union (`packages/daemon/src/sessions.ts` L427-541): `session/rename`, `usage/read`, `goal/*`, `task/{background,stop,stopAll}`, `skill/list`, `workflow/cancel`, `workflow/childControl`, `item/readOutput`.
- One-shot model calls: `muse exec --json --no-session-log --disable-web-tools --reasoning-effort minimal --max-model-steps 1 [--model id] <prompt>` (`server.ts` L3196-3217), prompt passed as a CLI argument, run by `defaultExec` with a hard-coded 30 s timeout and only `env` as an option (`packages/daemon/src/wsl.ts` L47-71, L17). Output parsed from JSONL `run.output.delta` / `run.terminal.completed` (`threadTitles.ts` L83-118). Runs under the default login; `runPlanned` adds no account env (L2098-2101).
- Sessions and hosts: one `muse serve` per (account, folder) (`hostKey`, L2147); `startSession(cwd, approvalMode, modelId, accountId)` (L2440-2472); notifications forwarded to clients over SSE as `{type:"msp", sessionId, method, params}` (L3582-3606); live per-session state in `liveFor`; usage rows recorded from `session/tokenUsage` for any session the host reports (`recordUsage`).
- Approval modes are closed: `allowAll | promptUnmatched | onRequest | denyUnmatched` (msp.d.ts L86). Approval subject kinds documented: `shell | fileAccess | network | process | tool` (L179-193).
- Store (`packages/daemon/src/store.ts`): `node:sqlite`, tables `projects, sessions, turns, attachments, shell_runs, usage, settings`; new tables go in `SCHEMA` (`CREATE TABLE IF NOT EXISTS`), new columns in `MIGRATIONS`; `listSessionsByProject` excludes archived rows (L673-682); `recordSession` on an existing row never touches `archived` or `origin` (L637-657).
- Server-owned transcript entries precedent: shell runs. `POST /api/sessions/:id/shell-proxy` → `store.addShellRun` → SSE `shell-run` → `loadTranscript` returns `shellRuns` → `Transcript.tsx` merges them by time (L98-107, L625).
- Server background work precedent: `titleQueue` + single promise worker, awaited in `close()` (L703-708, L3114-3159, L840).
- UI: composer toolbar triggers (`Composer.tsx` L416-420), slash builtins (`model/slash.ts` L4, L42-56; `controller.runSlash` L2940-3003), transcript `Entry` switch on item kind with `GenericRow` fallback (`Transcript.tsx` L338-365), Markdown via react-markdown + remark-gfm (`Markdown.tsx` L241); in-page `#footnote` anchors open a new window on desktop and are blocked by `main.rs` L528-533 (footnote jumps do not work; external links do).
- Settings pattern: `settings` table key + `get/set*Settings` + `GET/PATCH /api/<x>-settings` + a Settings `Section`. No keychain. `runtime.json` holds `runtime, distro, musePath, syncSessionNames, wslEnv` only.
- Tests: server `FakeConnection` with `replies` map and `notify()` (`server.test.ts` L41-75), injectable `exec`; UI SSR with `ControllerProvider`; demo `seed.ts` scenarios folded in `demo-seed.test.ts`.
- Desktop: one bundled Node (`externalBin: ["binaries/node"]`), server esbuilt to a single CJS file; a second sidecar is mechanically possible (ASSUMPTION on size: 30-60 MB per triple for CPython) but nothing today spawns one.
- Credentials: Ancilla detects whether `META_API_KEY` is inherited (`/api/accounts/health`, L1597-1601) but never calls Meta's API itself. `muse login` owns `auth.json`.

## 2. Integration strategy: selective port, Muse as runtime

### 2.1 Options weighed against the code

| Option | Verdict | Reason from the code |
|---|---|---|
| Direct dependency (bundle CPython + `pip install deep-dog-2`) | Rejected | Needs DeepSeek/Meta and Exa/Tavily keys the app does not have and cannot store safely (no keychain); bypasses Muse for every model call; import-time Tavily client and env-read constants make per-run isolation incomplete; private LangChain monkeypatches make upgrades fragile; 100-200 MB more per platform (ASSUMPTION). |
| Isolated Python service (subprocess with a JSON protocol Ancilla would have to write) | Rejected for the same key and runtime reasons | Also: unconditional `print()` calls pollute stdout, so the protocol channel would need its own fd. Would remain a reasonable path only if a future requirement is bit-for-bit parity with upstream. |
| Muse-native workflow (write a `.muse/workflows/scripts/*.js` script implementing the supervisor loop, let Muse run it) | Deferred to stage 4, not the base | No client verb launches a workflow; launch is model-chosen (`triggerSource: guidanceAuto`). The workflow host API (`host.parallel`, `hostApiVersion`) is only seen in demo output (`seed.ts` L634-646), not documented in the SDK. Cannot be the foundation of a deterministic feature, but it is the cheapest way to get Swarm-card UI for free once verified. |
| **Selective port to TypeScript, Muse as model and tool runtime** | **Chosen** | Every needed capability exists on verified paths: one-shot tool-less model calls via `muse exec`; tool-using agent runs via Muse sessions with built-in web tools and `toolCall` items visible to Ancilla; cancellation via `turn/interrupt`; token usage via `session/tokenUsage`; persistence, SSE, transcript merging, and settings via existing patterns. No new runtime, no secrets, no new frameworks. |

### 2.2 Role mapping between Deep Dog 2 and Muse

| Deep Dog 2 piece | In Ancilla | How |
|---|---|---|
| Brief writer, draft writer, supervisor reflect/decide, final writer (tool-less model calls) | `MuseExecModelClient` | `muse exec --json --no-session-log --disable-web-tools --max-model-steps 1`, one call per step, generalised from the title upgrade. Structured output requested as a fenced JSON block and parsed leniently (Muse exec exposes no JSON mode; ASSUMPTION that a strong model complies; retry once on parse failure). |
| Sub-agent (LLM + search/read/save tools with budgets) | `MuseSessionWorkerRunner` | One Muse **worker session** per delegated task, started on the thread's host with the thread's account and folder; one `turn/start` carrying the ported sub-agent prompt plus the task; Muse's built-in web tools do search and fetch; Ancilla watches `item/*` events for `toolCall` items to build the source registry from real tool activity, and parses the worker's final `<findings>` block. Budgets are enforced by Ancilla: tool-call count cap, wall-time cap, `turn/interrupt` on breach. |
| `asyncio.gather` of sub-agents | Worker pool | Bounded semaphore (default 3 per run, global cap across runs), which upstream lacks. |
| Source registry, code remap, `build_final_registry`, `finalize_citations` | `@ancilla/research/citations.ts` | Line-by-line port (pure string logic). Strengthened: a URL the worker claims but never fetched or saw in a search result is marked unverified and excluded from Sources. |
| Prompts (`prompts_open.py`, `platform_prompts.py`, brief and writer prompts) | `@ancilla/research/prompts/*.ts` | Ported verbatim where they are model-agnostic; tool names replaced by Muse's; "Chinese moderation" branch dropped. |
| Events vocabulary | `ResearchEvent` union | Same names as upstream for comparability. |
| Trace channel | `research_events` with `kind: "trace"` behind a per-run flag | Off by default; content redaction ported. |
| Cancellation token | `AbortSignal` | Standard Node primitive. |
| `RunConfig` hard caps | `ResearchConfig` with the same ceilings | Ported constants. |
| Platform specialists (Reddit, Substack, SEC, PubMed, arXiv) | Not ported in MVP | Their tools are REST wrappers needing their own credentials. arXiv and PubMed are keyless and reachable by Muse's fetch tool through URL-driven "specialist profiles" (stage 3). Reddit, Substack (Perplexity) and SEC need keys or contact headers; excluded until a secrets story exists. |
| LangGraph, checkpointer, console logger, file outputs, subtopic generation, moderation, `run_platform.py` | Not ported | Scaffolding or broken. |

## 3. Target architecture

```
packages/ui                          packages/server                       Muse
─────────────────────                ─────────────────────────────         ────────────────────
Composer: DeepResearch toggle  ──►   POST /api/research                    
/research slash command              ResearchJobManager                    
                                      ├─ ResearchJob (one per run)          
ResearchRunRow in Transcript ◄──SSE── │   engine = @ancilla/research         
SwarmDockCard (stage 2 mirror)        │     runResearch(question, cfg, deps) 
                                      │       deps.model  ──► MuseExecModelClient ──► muse exec (CLI, one shot)
Stop / Resume actions  ──►            │       deps.worker ──► MuseSessionWorkerRunner ──► session/start + turn/start
                                      │                          ▲ item/*, session/tokenUsage, approval/*
                                      │       deps.events ──► research_events table + SSE research-run
                                      │       deps.signal  ◄── AbortController (Stop, timeouts, shutdown)
                                      └─ persistence: research_runs, research_events, research_workers (SQLite)
                                      report file: <workspace>/.ancilla/research/<runId>/report.md + sources.json
```

Package boundaries:

- `packages/research` (`@ancilla/research`, new, pure TypeScript, no runtime dependencies): the ported engine. Depends on nothing in Ancilla. Exposes `runResearch(input, config, deps)` and the types below. Fully testable with fakes, mirroring upstream's `FakeModelFactory` approach.
- `packages/server/src/research/`: the Muse adapters, the job manager, persistence glue, routes, file output.
- `packages/daemon/src/store.ts`: three new tables and typed CRUD.
- `packages/ui`: types, client methods, controller actions, composer trigger, slash command, transcript row, later Swarm mirroring.
- `apps/web`: `webClient` and demo client implementations, demo scenario.

## 4. Contracts

### 4.1 Engine dependencies (the Muse boundary)

```ts
// packages/research/src/types.ts
export interface ModelClient {
  /** One tool-less completion. Rejects on timeout or abort. */
  complete(req: {
    role: "brief" | "draft" | "supervisor" | "writer";
    prompt: string;             // system + user text, already assembled
    maxOutputTokens: number;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ text: string; usage: TokenUsage | null; modelId: string | null }>;
}

export interface WorkerRunner {
  /** Runs one delegated research task to completion under the given budgets. */
  run(task: WorkerTask, budgets: WorkerBudgets, signal: AbortSignal, sink: WorkerSink): Promise<WorkerResult>;
}

export interface WorkerTask { runId: string; round: number; agentId: number; topic: string; discovery: boolean; instructions: string; }
export interface WorkerBudgets { maxToolCalls: number; maxSearches: number; maxReads: number; maxSaves: number; wallTimeMs: number; }
export interface WorkerSink { onToolCall(call: ObservedToolCall): void; onProgress(p: WorkerProgress): void; }
export interface ObservedToolCall { tool: string; kind: "search" | "fetch" | "other"; query?: string; urls: string[]; results?: { url: string; title: string | null }[]; at: string; }
export interface WorkerResult {
  status: "completed" | "failed" | "timed_out" | "cancelled";
  findings: string;                       // the worker's compressed findings (Markdown)
  saved: { url: string; title: string | null; reason: string; excerpt: string | null }[];
  observed: ObservedToolCall[];           // ground truth for provenance
  usage: TokenUsage | null;
  error: string | null;
}

export interface EventSink { emit(event: ResearchEvent): void; }
export interface ResearchDeps { model: ModelClient; worker: WorkerRunner; events: EventSink; now(): number; }
```

### 4.2 Typed research state (persisted after every phase and every supervisor round)

```ts
export interface ResearchRunState {
  version: 1;
  runId: string; question: string; config: ResearchConfig;
  phase: "scoping" | "drafting" | "researching" | "writing" | "done";
  brief: string | null; draft: string | null;
  rounds: SupervisorRound[];              // each: reflection, verdict, delegations, worker results, elapsed
  registry: SourceEntry[];                // code, url, title, agentId, round, verified: boolean
  curated: CuratedSource[];               // url, title, reason, excerpt, agentId
  notes: string[];                        // worker findings, in order
  consecutiveFailures: number; aborted: boolean; abortReason: string | null;
  usage: TokenUsage;                      // summed across model calls and workers
  startedAt: string; researchDeadlineAt: string;
}
```

Every field is JSON. The state is the checkpoint: a run can be resumed at the start of any supervisor round (stage 3).

### 4.3 Run lifecycle and identifiers

- `runId`: UUIDv7 minted by the server. One active run per thread (409 otherwise). `POST /api/research` takes a client `commandId` (UUIDv7); a repeated `commandId` returns the existing run (idempotent, same pattern as MSP commands).
- Status: `queued | running | completed | partial | failed | cancelled | interrupted`. `interrupted` is set on server start for runs found `running` in the store (stage 1) and is what stage 3's Resume acts on.
- Worker sessions: real Muse sessions recorded with `origin: "research-worker"`, `archived: true`, and a row in `research_workers`. Archived rows are excluded from listings (verified) and discovery never un-archives (verified), so they stay out of the sidebar. They inherit the thread's account, so usage lands on the right plan and rolls up per project on the Usage page.

### 4.4 Events

`ResearchEvent = { type, runId, seq, at, phase?, agentId?, round?, payload }` with the upstream type names (section 1.1) plus `worker_tool_call` (content-free: tool kind, count) and `run_interrupted`. Persisted in `research_events` and broadcast as `AncillaEvent {type:"research-run", run: ResearchRunView}` after each event (debounced 120 ms like `sessionsChanged`). `ResearchRunView` is the summary the UI renders: status, phase, round/maxRounds, elapsed and remaining window, workers `[{agentId, topic, state, toolCalls, sources}]`, source counts, usage and estimated cost, failure, and `reportAvailable`.

### 4.5 Routes

| Route | Purpose |
|---|---|
| `POST /api/research` `{commandId, sessionId, question, config?}` | Start. Returns `{run}`. 409 if the thread has an active run. |
| `GET /api/research?sessionId=` | Runs for a thread (summaries). |
| `GET /api/research/:runId` | Full view including report, registry, curated sources. |
| `GET /api/research/:runId/events?after=seq` | Event log page (inspector, stage 2). |
| `POST /api/research/:runId/stop` | Cancel. Idempotent. |
| `POST /api/research/:runId/resume` | Stage 3. |
| `GET/PATCH /api/research-settings` | Defaults (section 4.7). |

`loadTranscript` returns `researchRuns: ResearchRunView[]` next to `shellRuns`.

### 4.6 Budgets, timeouts, retries (defaults; every value clamped to upstream's ceilings)

| Knob | Default | Enforced by |
|---|---|---|
| Research window min / max | 3 / 10 min | Engine: no `ResearchComplete` before min unless nothing left to delegate; route to writing at max + 1 min, as upstream. |
| Supervisor rounds | 12 | Engine. |
| Parallel workers per run / global | 3 / 4 | Job manager semaphore. |
| Worker tool calls / searches / reads / saves | 25 / 3 / 10 / 10 | Runner counts `toolCall` items; prompt states the budget; `turn/interrupt` at the hard cap. |
| Worker wall time | 10 min | Runner timer → `turn/interrupt`, then `turn/cancel` after 30 s. |
| Model call timeouts: brief 2 min, draft 5 min, supervisor 4 min, writer 10 min | `ExecOptions.timeoutMs` (new). |
| Model call attempts | 2 (supervisor, writer), 1 (brief, draft) | Engine, as upstream; auth/quota errors are fatal and end the run. |
| Worker failure | 1 retry if retryable; all-failed with quota/429 trips the breaker; two consecutive failed rounds → salvage or abort, as upstream | Engine. |
| Tokens | Summed from `session/tokenUsage` (workers) and exec usage when present; soft cap ends research early | Engine; new capability over upstream. |

### 4.7 Configuration and secrets

No secrets. `settings` key `research`: `{ enabled, supervisorModelId, workerModelId, writerModelId, windowMinMinutes, windowMaxMinutes, maxRounds, maxParallel, traceEnabled }`, edited in a Settings section following the title-settings pattern. Per-run overrides come from the composer popover and are stored in `research_runs.config`.

### 4.8 Persistence

```sql
CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), command_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, question TEXT NOT NULL, config TEXT NOT NULL, state TEXT NOT NULL,
  report TEXT, failure TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);
CREATE TABLE IF NOT EXISTS research_events (
  run_id TEXT NOT NULL REFERENCES research_runs(id), seq INTEGER NOT NULL, type TEXT NOT NULL,
  at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (run_id, seq));
CREATE TABLE IF NOT EXISTS research_workers (
  run_id TEXT NOT NULL REFERENCES research_runs(id), worker_session_id TEXT NOT NULL,
  round INTEGER NOT NULL, agent_id INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY (run_id, worker_session_id));
```

Report and `sources.json` are also written to `<workspace>/.ancilla/research/<runId>/` (same convention as attachments, `server.ts` L2479-2482), so the Files panel can open them and a later turn can reference the file.

## 5. End-to-end flow

1. **Select.** The composer's DeepResearch trigger (a `ToolbarTrigger` beside the model picker) opens a popover with the window and parallelism defaults; `/research <question>` is the keyboard path. Sending posts `POST /api/research`.
2. **Admit.** The server validates (thread exists, no active run, Muse host reachable), inserts `research_runs` as `queued`, emits `run_started`, and hands the run to `ResearchJobManager`, which starts `runResearch` under an `AbortController`.
3. **Scope.** `brief` call through `MuseExecModelClient`: ported brief prompt, output a fenced JSON `{research_brief, input_language, target_language}`; lenient parse, one retry. Events `scope_started/completed`. State persisted.
4. **Draft** (stage 2; MVP skips): draft-first scaffold, never treated as evidence.
5. **Supervisor round** (loop):
   a. `supervisor` call with the ported lead-researcher prompt, the brief, the draft, and the notes so far; the model answers with a fenced JSON decision `{reflection, verdict: "CONTINUE_RESEARCH"|"RESEARCH_COMPLETE", delegations: [{topic, discovery, max_reads?}]}` (replaces `think_tool` + `Research*` tool calls, keeping the same verdict-gating rule). Event `supervisor_iteration`.
   b. Exit rules exactly as upstream (section 1.1), evaluated in the engine.
   c. For each delegation, up to the parallel cap, `WorkerRunner.run`: the runner starts a worker session on the thread's host (`session/start` with the thread's `workspaceRoot`, account and model), sends one `turn/start` with the ported sub-agent prompt (search → select → read → save discipline, budgets stated, required output: findings plus a fenced `<findings>` JSON with saved sources by URL), and consumes `item/*` events: every `toolCall` whose tool name matches Muse's web search or fetch tools yields an `ObservedToolCall` (with `item/readOutput` for result titles and URLs when the output is not inline). Events `delegation_started`, `subagent_started`, `source_found`, `source_read`, `worker_tool_call`. On the turn's completion the runner parses the findings block; on budget breach it interrupts and takes whatever text exists; on failure returns `failed`.
   d. The engine merges each worker's saved URLs into the registry with codes `A{agent}-S{n}`, marking `verified` only if the URL appears in that worker's observed search results or fetches; unverified URLs are kept in the notes but excluded from citation. Event `subagent_completed/failed`, `source_saved`. State persisted after the round.
6. **Write.** `writer` call: ported final-writer prompt with the registry block `[code] title (url)` and curated excerpts; two attempts with upstream's rejection rules; then the ported `finalizeCitations` renumbers to `[1..N]`, drops unknown codes into plain text, and appends the code-built `## Sources`. Events `report_started`, `citations_validated`.
7. **Deliver.** Report and `sources.json` written to the workspace folder; `research_runs` updated to `completed` (or `partial` when a salvage produced a report from an aborted loop); `run_completed` emitted; SSE `research-run` carries `reportAvailable: true`. The transcript's `ResearchRunRow` (merged by time like shell runs) flips from progress to the rendered report with a copy/open-file action. Worker sessions are closed (`turn/cancel` if any is somehow live).
8. **Stop.** `POST /api/research/:id/stop` aborts the controller: in-flight `muse exec` children are killed, every live worker gets `turn/interrupt` then `turn/cancel`; the engine returns `cancelled` (or `partial` with a salvage report when findings exist and the user chose "stop and write"), events `run_cancelled`.

## 6. What is reused unchanged, wrapped, adapted, or left out

**Reused unchanged (Ancilla):** `hostFor`/`startSession`/`forward`, SSE `emit("ancilla")` and `AncillaEvent` dispatch, `liveFor`, usage recording, `AncillaStore` schema/migrations and `settings` table, the shell-runs transcript merge, `Markdown`, aonia accounts, `FakeConnection`, demo seeding.

**Wrapped (Ancilla):** `runThreadTitleUpgrade`'s exec invocation becomes `museExec({args, prompt, timeoutMs, accountId})` used by both titles and research; `defaultExec` gains `timeoutMs` and stdin support if verified (section 11).

**Ported from Deep Dog 2 (with attribution):** supervisor decision rules and prompts, sub-agent discipline and prompts, brief and writer prompts, `finalize_citations`/`build_final_registry`/code remap, `RunConfig` ceilings, the event vocabulary, the salvage/abort logic.

**Not imported:** LangGraph and LangChain, `config.py` provider routing and monkeypatches, Tavily/Exa/Reddit/Substack/SEC/PubMed/arXiv HTTP clients, console logger, file/db output modes, subtopic generation, moderation patterns, `run_platform.py`, `run_research.py`.

## 7. Phased task sequence

Each stage lists files, responsibilities, tests and acceptance criteria. Stages are ordered by dependency; nothing in a later stage is needed by an earlier one.

### Stage 0: verification spikes (half a day, no product code)

Answer the blocking questions in section 11 by running real Muse from a scratch script in `packages/server/scripts/` (not shipped):
- `muse exec --help`; long prompt via stdin or `--prompt-file`; output length for a 6 000-word answer; `--json` event shapes for `--max-model-steps 1`.
- Start a session over MSP on a folder, send a turn that asks the model to search the web and read two pages, and capture the `item/*` stream: tool names, args, whether outputs are inline or need `item/readOutput`, and whether any `approval/requested` fires under each approval mode.
- Confirm a session started with `approvalMode: "denyUnmatched"` (or the mode that fits) still allows web tools.
Deliverable: `docs/deep-research/muse-spike.md` recording the observed shapes; the adapters in stage 2 are written against them.

### Stage 1: engine package (`packages/research`), no Muse

Add:
- `packages/research/package.json`, `tsconfig.json` (copy `packages/daemon`'s), `src/index.ts`.
- `src/types.ts`: contracts from section 4.
- `src/config.ts`: `ResearchConfig`, defaults, `clamp()` with upstream ceilings (`run_config.py` L32-39).
- `src/prompts/{brief,draft,supervisor,worker,writer}.ts`: ported text with a header comment naming the upstream file and commit.
- `src/citations.ts`: `assignCodes`, `remapCodes`, `buildFinalRegistry`, `finalizeCitations` (port of `citation_utils.py` L179-343).
- `src/parse.ts`: lenient fenced-JSON extraction for brief, supervisor decision, worker findings.
- `src/supervisor.ts`: the round loop, exit rules, verdict gating, breaker, salvage/abort (port of `multi_agent_supervisor.py` L451-864 control flow, without LangGraph).
- `src/engine.ts`: `runResearch(input, config, deps): Promise<ResearchOutcome>` driving scope → rounds → write, persisting state through `deps.events` and a `deps.checkpoint(state)` callback.
- `src/events.ts`: `ResearchEvent` union and a `seq` allocator.
- `NOTICE` section in `NOTICE.md` and `packages/research/UPSTREAM.md` mapping each ported file to its upstream source and commit `fc7981a`, with both MIT notices (Eadie; Lin).

Tests (`packages/research/test/*.test.ts`, node:test, all offline):
- `citations.test.ts`: renumbering, dedup by URL, unknown codes left as text, no Sources section when nothing is cited, Sources format `[n] Title (url)`; fixtures taken from upstream `tests/test_final_writer_validation.py` behaviour.
- `supervisor.test.ts`: fake `ModelClient` returning scripted decisions; assert exit on iteration cap, on max+1 min (fake clock), on `RESEARCH_COMPLETE` without CONTINUE override, and on CONTINUE override; assert breaker on all-failed 429; assert salvage at ≥60% window with findings and abort without; assert parallel cap (fake `WorkerRunner` records concurrency).
- `engine.test.ts`: full run with fakes yields `completed` with a report whose citations resolve; worker returning an unverified URL is excluded from Sources; `AbortSignal` mid-round yields `cancelled` and no further worker starts; a writer that returns the draft verbatim triggers one retry then failure with `partial`.
- `parse.test.ts`: fenced JSON with prose around it, trailing commas rejected, retry path.

Acceptance: package builds; ≥ 40 tests; no dependency on `@ancilla/server`.
Risk: prompt drift when replacing tool schemas with JSON decisions; mitigated by keeping upstream prompt text and only changing the "how to answer" tail.

### Stage 2: Muse adapters, job manager, persistence, routes (MVP vertical slice)

Modify:
- `packages/daemon/src/wsl.ts`: `ExecOptions.timeoutMs`, `ExecOptions.input` (stdin) if the spike confirms exec reads stdin; `defaultExec` honours both.
- `packages/daemon/src/store.ts`: three tables (section 4.8); `SessionRecord.origin` value `"research-worker"`; methods `createResearchRun`, `updateResearchRun`, `getResearchRun`, `listResearchRuns(sessionId)`, `appendResearchEvent`, `listResearchEvents(runId, afterSeq)`, `addResearchWorker`, `listRunningResearchRuns`.
- `packages/server/src/server.ts`: extract `museExec(...)` from the title path; routes from section 4.5; `loadTranscript` adds `researchRuns`; `close()` awaits the job manager; on boot mark `running` runs `interrupted`; `AncillaEvent` gains `research-run`.

Add `packages/server/src/research/`:
- `execModelClient.ts`: `MuseExecModelClient` (`--disable-web-tools --max-model-steps 1`, per-role model id, account env via `aonia.envFor`, timeout per role, kills the child on abort, parses JSONL like `threadTitles.ts`).
- `sessionWorkerRunner.ts`: `MuseSessionWorkerRunner` (start worker session on `hostFor(cwd, accountId)`, record it archived, subscribe to the host's forwarded notifications filtered by session id, count and classify `toolCall` items, `item/readOutput` when needed, interrupt on budget or timeout, parse findings, close the session's turn on completion, return `WorkerResult`).
- `jobManager.ts`: one job per run, global worker semaphore, persistence of state and events, SSE broadcast (debounced), file output, status transitions.
- `views.ts`: `ResearchRunView` builder.

UI (`packages/ui`):
- `src/types.ts`: `ResearchRunView`, `ResearchConfigInput`; `AncillaEvent` variant.
- `src/client.ts`, `apps/web/src/webClient.ts`, `apps/web/src/demo/client.ts`, test fake client: `startResearch`, `stopResearch`, `listResearch`, `getResearch`.
- `src/model/store.ts`: `threads[id].researchRuns`; `src/model/controller.ts`: `startResearch(question, config)`, `stopResearch(runId)`, SSE handler, `runSlash` case `research`; `src/model/slash.ts`: `builtin("research", ...)`.
- `src/components/composer/Composer.tsx`: `ResearchTrigger` popover (window, parallelism, "stop and write" behaviour).
- `src/components/thread/ResearchRunRow.tsx` merged by time in `Transcript.tsx` beside shell runs: phase line, round `n of N`, worker chips with tool-call counts, elapsed/remaining, Stop; on completion the report through `Markdown` with "Open report.md" and "Copy".
- Settings section "Deep research" bound to `/api/research-settings`.

Demo: scenario `?research=running|done` in `seed.ts`; demo client simulates a run with timers.

Tests:
- Server (`server.test.ts`): start run with `FakeConnection` replies for `session/start`, scripted `item/*` notifications for two workers, scripted `exec` for brief/supervisor/writer; assert `research_runs` reaches `completed`, report contains renumbered citations, worker sessions are archived and absent from `/api/sessions`, SSE `research-run` events are ordered, `loadTranscript` returns the run, `POST stop` mid-round yields `cancelled` and `turn/interrupt` was sent to every live worker, a 409 on a second start, idempotent `commandId`, `interrupted` on restart (construct a second server on the same in-memory store is not possible; use a file-backed temp DB).
- Worker runner unit tests: tool-call classification, budget breach → interrupt, findings parse fallback when the block is missing, `item/readOutput` path.
- UI: SSR of `ResearchRunRow` in each status; controller tests for start/stop/SSE merge with the fake client; slash command routing.
- Demo seed test folds the new scenario.

Acceptance (MVP definition of done): from a thread, `/research <question>` produces, within the configured window, a Markdown report with numbered citations whose every entry maps to a URL the workers actually searched or fetched; progress is visible in the transcript; Stop works within 30 s; the run survives page reloads; usage appears on the Usage page; nothing runs when Muse is unavailable and the error is shown; all suites green.
Risks: worker prompt compliance on the findings block (fallback: treat the whole final message as findings and derive saved sources from fetched URLs); Muse tool names differ across versions (classify by pattern, `format.ts` L269 precedent, and log unknowns); host load with 3 extra sessions (cap is configurable).

### Stage 3: production hardening

- Draft-first scaffold (upstream step 2) and the elapsed-time note in the supervisor prompt.
- Resume: `POST /api/research/:id/resume` reloads `state`, discards the unfinished round, continues; UI Resume action on `interrupted` runs.
- Token soft cap and cost estimate in the run view (`pricing.ts` already prices models).
- Event inspector (`GET /api/research/:id/events`) and optional trace with redaction.
- Specialist profiles for arXiv and PubMed as worker prompt variants restricted to their public APIs (no keys); a `platforms` field in the popover.
- Export: "Save report as…" through the existing opener, and "Ask about this report" which starts a normal turn mentioning the report path.
- Windows/WSL: worker sessions on WSL hosts use `hostPathFor`, already handled by `startSession`; verify path spelling in `sources.json`.
- Tests: resume from a persisted mid-run state; cost arithmetic; inspector paging; failure injection (host exit mid-round → `interrupted`, worker turn error → retry once, quota error → breaker); a soak test running three concurrent runs against the fake host asserting the global cap.

### Stage 4: Swarm-card integration (optional, after spike)

Mirror each run into the fold as a synthetic `workflow` item (`itemId: research:<runId>`, `scriptId: ancilla:deep-research`, children per worker with `phase` from the round, terminal `message` carrying `<workflow-launch-reconciled>` JSON built from the run view) so the Swarm card, panel, Activity drawer and completion report render it with no UI change; the server intercepts `workflow/cancel` and `workflow/childControl` for research run ids before forwarding to Muse (`server.ts` L1409-1456). Requires verifying that `applyEvents` accepts events without a Muse `viewCursor` and that `loadTranscript` can splice the synthetic snapshot into `events` without confusing `foldFromLoad`. Alternatively, once the Muse workflow host API is documented, a native workflow script generated from the same engine could run inside Muse; the engine's `WorkerRunner`/`ModelClient` boundary is what keeps that door open.

## 8. Cross-cutting requirements

- **Asynchronous, long-running:** jobs live in the server process, independent of any client; clients reconnect through SSE and `loadTranscript`. Server shutdown aborts jobs and marks them `interrupted`.
- **Bounded resources:** per-run and global worker caps, tool-call caps, wall-time caps, model-call timeouts, token soft cap, output truncation on worker outputs (64 KiB, matching `runInWorkspace`).
- **Idempotency:** `commandId` on start; stop is idempotent; state persisted per round so a resume never repeats a finished round.
- **Observability:** every event persisted with `seq`; server log lines prefixed `research <runId>`; the run view is the single UI truth.
- **Licensing:** MIT both ways. `NOTICE.md` gains a "Deep Dog 2" section with Eadie's and Lin's notices; `packages/research/UPSTREAM.md` pins the commit and maps ported files, which is also the upgrade procedure: diff upstream between pinned commits, apply to the mapped files.
- **Dependency isolation:** no new runtime dependencies; the engine package has none.
- **Failure recovery:** every error path ends in a persisted status with a `failure` string; partial reports are produced when findings exist, as upstream.

## 9. Key technical decisions

1. Port, do not embed: Python and provider keys are the two things Ancilla cannot ship; Muse already provides the model and web tools under the user's login.
2. Two Muse paths by role: `muse exec` for tool-less steps (deterministic, no session pollution, verified today), worker sessions for tool-using steps (verified event contracts, cancellation, usage accounting).
3. Provenance from observed tool calls, not model claims: a citation is valid only if the worker actually saw the URL. This is stricter than upstream and is what makes "citation validation" mean something.
4. Structured decisions as fenced JSON instead of tool schemas: the only structured-output facility reachable through Muse. The prompts keep upstream's verdict wording so behaviour stays comparable.
5. Transcript row first, Swarm card later: the shell-run precedent is verified end to end; synthetic workflow items are not.
6. Worker sessions are archived real sessions: reuses discovery, usage and host management with two flags rather than a parallel session concept.
7. Budgets enforced by Ancilla, not by the model: upstream's prompt-only concurrency limit becomes a semaphore; tool budgets become counters with interrupts.

## 10. Unresolved questions that block implementation

1. **`muse exec` prompt transport and output size.** The title path passes the prompt as an argument (`server.ts` L3215). Windows limits a command line to about 32 K characters, and the writer prompt with curated excerpts will exceed it. Does `muse exec` accept the prompt on stdin or via a file flag, and does it cap output length? Blocks the `MuseExecModelClient`.
2. **Muse web tools in serve sessions.** Their tool names, whether search results and fetched text are inline in the `toolCall` item or only through `item/readOutput`, and whether they raise `approval/requested` (subject `network`?) under each approval mode. Blocks the worker runner and the choice of `approvalMode` for worker sessions.
3. **Worker session hygiene.** Whether Muse's `session/list` marks these sessions distinctly (`workspaceRoot` will match the project) and whether closing them cleanly needs a verb Ancilla does not call today (`session/close` is not in the union). Blocks the "no sidebar leakage" acceptance test.
4. **Account env for `muse exec`.** `runPlanned` adds no profile env; verify that adding `aonia.envFor(profile)` makes exec use that login (needed so research on an account thread bills that account).
5. **Structured output compliance** of the configured Muse models with fenced JSON at the sizes involved (supervisor decision with up to 3 delegations; brief). If compliance is poor, the fallback is a stricter two-step prompt, which costs a call per decision.

Non-blocking but to settle during stage 0: exact `--json` event names for `muse exec` beyond the two the title parser reads; whether `session/tokenUsage` is emitted for a session that ran one turn (affects cost accuracy, not correctness).

## 11. Definition of done for DeepResearch

- A user picks DeepResearch in the composer or types `/research <question>`; within the configured window the thread shows a report with numbered citations, every citation resolving to a URL a worker actually searched or fetched during the run, and a `## Sources` list built by code.
- Progress (phase, round, workers, sources found, elapsed and remaining time) updates live, survives reload and server restart (as `interrupted`, resumable in stage 3), and Stop ends the run within 30 s with a partial report when findings exist.
- Runs respect every budget in section 4.6; three concurrent runs never exceed the global worker cap.
- Worker sessions never appear in the sidebar or the palette; their token usage appears on the Usage page under the project.
- No provider keys, no Python, no new runtime dependency; `NOTICE.md` and `UPSTREAM.md` attribute Deep Dog 2 and ThinkDepth.
- Test suites: engine ≥ 40 tests offline; server integration covering start, progress, stop, restart, idempotency, and provenance exclusion; UI rendering and controller tests; demo scenario folded; CI green on Windows, macOS and Linux.

## 12. Implementation notes (what the build changed)

- **Engine location.** The engine lives in `packages/daemon/src/research/` and is exported from `@ancilla/daemon`, not in a new `packages/research` workspace: same isolation (the folder imports nothing outside itself and no `node:` module), without a new entry in the version-bump script, six CI build lines and the lockfile. `UPSTREAM.md` in that folder pins the Deep Dog 2 commit and maps each ported file.
- **Two transports for tool-less model calls.** The supervisor prompt alone is about 28 000 characters, which is already over what a Windows command line carries, so `muse exec` cannot be the only path. The model client sends a prompt through `muse exec` when it fits the platform's argument limit and otherwise as one turn in a dedicated, archived "research control" session on the thread's host, with the model told to answer without tools. The engine also budgets prompt material (per-note cap, oldest-first compaction, excerpts dropped when over budget) so prompts stay bounded whatever the transport.
- **Stop and write.** An explicit stop with a report request writes whenever anything was found; the time fraction only gates the automatic salvage of an aborted loop. The engine exposes `ResearchInput.stopWritesReport` and `ResearchDeps.hardStop` so the host can end a salvage write on a second stop or at shutdown.
- **Approvals in worker sessions** are decided by the runner with Muse's real choice vocabulary (`approved*` / `denied*`, once before session scope, feedback only where accepted); a request it cannot decide interrupts the worker rather than pending for the user. `userInput/requested` in a worker is cancelled and the worker interrupted.
- **Budgets.** Only the tool-call cap and the wall time interrupt a worker; searches, reads and saves over their soft caps are counted and reported. Sub-agent prompts still state every cap.
- **Resume** is stored (typed state with the loop exit) but the route answers 501 until stage 3.
