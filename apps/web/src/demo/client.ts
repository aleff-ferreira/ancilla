/**
 * An in-memory AncillaClient for demo mode. It serves the fictional workspace in `seed.ts` and plays
 * back what `muse serve` would stream, so the real Ancilla UI renders and responds exactly as it does
 * against a live server. Nothing leaves the browser: no server, no Muse, no model calls.
 */
import { parseModelList } from "@ancilla/ui";
import type {
  AccountView,
  AncillaClient,
  AncillaEvent,
  ApprovalDecisionInput,
  ApprovalMode,
  ApprovalRequest,
  AttachmentView,
  DirectoryListing,
  EnvironmentStatus,
  EventHandler,
  FileContent,
  FileEntry,
  FileListing,
  GoalAction,
  LiveView,
  ModelOption,
  MspItem,
  OutputRange,
  PlanUsage,
  PlanUsageByAccount,
  ProjectView,
  SandboxSettings,
  SessionSummary,
  ShellRun,
  SkillCatalog,
  TitleSettings,
  TranscriptLoad,
  TurnOptions,
  UsageBucket,
  UsageReport,
  UsageThread,
  ViewEvent,
  WorkflowAction,
  YoloSettings,
} from "@ancilla/ui";
import { DemoFiles } from "./files.js";
import { DAY, HOUR, MIN, MODEL, Script, iso, sampleId } from "./script.js";
import { AUDIT_SUMMARY, HOME, PROJECTS, SIDE_ACCOUNT, auditItem, seed, type AuditRun } from "./seed.js";

/** What Settings shows as the Ancilla version; the demo has no server to ask. */
const DEMO_VERSION = "0.17.1";

/** How often the running workflow reports new activity, which also keeps the stall watchdog quiet. */
const HEARTBEAT_MS = 6_000;

const REPLY =
  "This is Ancilla's demo mode: the real interface running on sample data, so nothing ran and no model was called. " +
  "In your own project this thread would stream from `muse serve`, with every tool call, diff and approval shown right here.";

type Timer = ReturnType<typeof setTimeout>;

interface Thread {
  summary: SessionSummary;
  events: ViewEvent[];
  seq: number;
  approvals: ApprovalRequest[];
  timers: Set<Timer>;
}

function idle(lastTerminal: string | null = "completed"): LiveView {
  return { activeTurnId: null, turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal, lastError: null };
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

export class DemoAncillaClient implements AncillaClient {
  private readonly now = Date.now();
  private readonly handlers = new Set<EventHandler>();
  private readonly threads = new Map<string, Thread>();
  private readonly files = new DemoFiles(this.now);
  private readonly audit: AuditRun;
  private projects: ProjectView[];
  private accounts: AccountView[];
  private titleSettings: TitleSettings = { enabled: true, modelId: null };
  private sandboxSettings: SandboxSettings = { disabled: false };
  private yoloSettings: YoloSettings = { enabled: false };
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private created = 0;
  private listed: (() => void)[] = [];
  private hasListed = false;

  constructor() {
    const seeded = seed(this.now);
    for (const entry of seeded.threads) {
      this.threads.set(entry.summary.sessionId, { ...entry, timers: new Set() });
    }
    this.audit = seeded.audit;
    this.projects = [
      { cwd: PROJECTS.atlas, displayName: "atlas-api", pinned: true, activityAt: iso(this.now), defaultAccountId: null },
      { cwd: PROJECTS.lumen, displayName: "lumen-web", pinned: false, activityAt: iso(this.now), defaultAccountId: null },
      { cwd: PROJECTS.orbit, displayName: "orbit-cli", pinned: false, activityAt: iso(this.now), defaultAccountId: SIDE_ACCOUNT },
    ];
    this.accounts = [
      { id: SIDE_ACCOUNT, name: "Side projects", hasLogin: true, email: "demo@example.com", lastUsedAt: iso(this.now - 3 * HOUR) },
      { id: "client", name: "Client work", hasLogin: false, email: null, lastUsedAt: null },
    ];
  }

  /** Resolves once the app has listed its threads, which is when the demo can open overlays on top. */
  whenListed(): Promise<void> {
    return this.hasListed ? Promise.resolve() : new Promise((resolve) => this.listed.push(resolve));
  }

  // ------------------------------------------------------------------------------------ plumbing

  private broadcast(event: AncillaEvent): void {
    for (const handler of [...this.handlers]) {
      handler(event);
    }
  }

  private event(thread: Thread, method: string, params: Record<string, unknown>): ViewEvent {
    thread.seq += 1;
    const sessionId = thread.summary.sessionId;
    return { method, params: { sessionId, viewCursor: `v:${sessionId}:${thread.seq}`, ...params }, at: Date.now() };
  }

  private send(thread: Thread, event: ViewEvent): void {
    this.broadcast({ type: "msp", sessionId: thread.summary.sessionId, method: event.method, params: event.params, at: event.at ?? Date.now() });
  }

  /** Records a live event in the thread's history and streams it, as the server does. */
  private emit(sessionId: string, method: string, params: Record<string, unknown>): void {
    const thread = this.threads.get(sessionId);
    if (!thread) {
      return;
    }
    const event = this.event(thread, method, params);
    thread.events.push(event);
    this.send(thread, event);
  }

  private setLive(sessionId: string, live: LiveView): void {
    const thread = this.threads.get(sessionId);
    if (!thread) {
      return;
    }
    thread.summary = { ...thread.summary, live, activityAt: iso(Date.now()) };
    this.broadcast({ type: "session-status", sessionId, live });
  }

  private later(sessionId: string, fn: () => void, ms: number): void {
    const thread = this.threads.get(sessionId);
    if (!thread) {
      return;
    }
    const timer = setTimeout(() => {
      thread.timers.delete(timer);
      fn();
    }, ms);
    thread.timers.add(timer);
  }

  private cancelTimers(sessionId: string): void {
    const thread = this.threads.get(sessionId);
    for (const timer of thread?.timers ?? []) {
      clearTimeout(timer);
    }
    thread?.timers.clear();
  }

  private findItem(thread: Thread, itemId: string): MspItem | null {
    for (let i = thread.events.length - 1; i >= 0; i--) {
      const item = thread.events[i]?.params["item"] as MspItem | undefined;
      if (item?.itemId === itemId) {
        return item;
      }
    }
    return null;
  }

  /**
   * The workflow's new revision replaces its last one in history rather than piling up behind it, so
   * a page left open for an hour reloads the same size it started.
   */
  private reviseAudit(): void {
    const thread = this.threads.get(this.audit.sessionId);
    if (!thread) {
      return;
    }
    this.audit.revision += 1;
    const event = this.event(thread, "item/updated", { item: auditItem(this.audit, Date.now()) });
    let index = -1;
    for (let i = thread.events.length - 1; i >= 0; i--) {
      if ((thread.events[i]?.params["item"] as MspItem | undefined)?.itemId === this.audit.itemId) {
        index = i;
        break;
      }
    }
    if (index > 0 && thread.events[index]?.method === "item/updated") {
      thread.events[index] = event;
    } else {
      thread.events.push(event);
    }
    this.send(thread, event);
  }

  /** The working agents move on to their next step now and then; the counts stay where they are. */
  private beat(): void {
    if (this.audit.status !== "inProgress") {
      return;
    }
    this.audit.tick += 1;
    this.reviseAudit();
  }

  dispose(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const id of this.threads.keys()) {
      this.cancelTimers(id);
    }
  }

  // ------------------------------------------------------------------------------------ environment

  async probeEnvironment(): Promise<EnvironmentStatus> {
    return {
      platform: "linux",
      runtime: "posix",
      wslAvailable: false,
      defaultDistro: null,
      museFound: true,
      musePath: "/usr/local/bin/muse",
      version: DEMO_VERSION,
      persistent: true,
    };
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    handler({ type: "hello", version: DEMO_VERSION });
    if (this.heartbeat === null) {
      this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
    }
    return () => {
      this.handlers.delete(handler);
    };
  }

  // ------------------------------------------------------------------------------------ projects

  async listProjects(): Promise<ProjectView[]> {
    return this.projects.map((project) => {
      const latest = [...this.threads.values()]
        .filter((thread) => thread.summary.cwd === project.cwd && !thread.summary.archived)
        .map((thread) => thread.summary.activityAt)
        .sort()
        .pop();
      return { ...project, activityAt: latest ?? project.activityAt };
    });
  }

  async addProject(cwd: string): Promise<{ cwd: string; warning: string | null }> {
    const clean = cwd.replace(/^~(?=\/|$)/, HOME).replace(/\/+$/, "") || "/";
    if (!this.projects.some((project) => project.cwd === clean)) {
      this.projects.push({ cwd: clean, displayName: basename(clean), pinned: false, activityAt: iso(Date.now()), defaultAccountId: null });
      this.broadcast({ type: "sessions-changed" });
    }
    return { cwd: clean, warning: null };
  }

  async cloneProject(_url: string, path: string): Promise<{ cwd: string; warning: string | null }> {
    const added = await this.addProject(path);
    return { ...added, warning: "Nothing was cloned: this is the demo, so the project starts empty." };
  }

  async listDirectory(path: string): Promise<DirectoryListing> {
    const tree: Record<string, string[]> = {
      "/": ["home"],
      "/home": ["demo"],
      [HOME]: ["code", "notes"],
      [`${HOME}/code`]: ["atlas-api", "lumen-web", "orbit-cli", "playground"],
    };
    const directory = (path.trim() || HOME).replace(/^~(?=\/|$)/, HOME).replace(/(.)\/+$/, "$1");
    const parent = directory === "/" ? null : directory.slice(0, directory.lastIndexOf("/")) || "/";
    const known = directory in tree || this.projects.some((project) => project.cwd === directory);
    return { directory, parent, separator: "/", exists: known, entries: (tree[directory] ?? []).map((name) => ({ name })) };
  }

  async revealPath(): Promise<void> {}

  async hideProject(cwd: string): Promise<void> {
    this.projects = this.projects.filter((project) => project.cwd !== cwd);
  }

  async setPinned(cwd: string, pinned: boolean): Promise<void> {
    this.projects = this.projects.map((project) => (project.cwd === cwd ? { ...project, pinned } : project));
  }

  async setProjectOrder(cwds: string[]): Promise<void> {
    const rank = (cwd: string) => {
      const index = cwds.indexOf(cwd);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    this.projects = [...this.projects].sort((a, b) => rank(a.cwd) - rank(b.cwd));
  }

  async openFolder(): Promise<void> {}

  // ------------------------------------------------------------------------------------ threads

  async listSessions(options?: { archived?: boolean }): Promise<SessionSummary[]> {
    const list = [...this.threads.values()].map((thread) => thread.summary).filter((summary) => summary.archived === (options?.archived ?? false));
    if (!this.hasListed) {
      this.hasListed = true;
      for (const resolve of this.listed.splice(0)) {
        resolve();
      }
    }
    return list;
  }

  async discover(): Promise<void> {}

  async startSession(cwd: string, options?: { approvalMode?: ApprovalMode; modelId?: string; accountId?: string | null }): Promise<SessionSummary> {
    this.created += 1;
    const sessionId = sampleId(`new:${this.now}:${this.created}:${Date.now()}`);
    const script = new Script(sessionId, cwd, Date.now() - 500, { approvalMode: options?.approvalMode, modelId: options?.modelId, branch: "main" });
    const summary: SessionSummary = {
      sessionId,
      cwd,
      title: "New thread",
      titleSource: "placeholder",
      turnCount: 0,
      modelId: options?.modelId ?? MODEL,
      origin: "ancilla",
      archived: false,
      createdAt: iso(Date.now()),
      activityAt: iso(Date.now()),
      settled: false,
      settledAt: null,
      unsettledAt: null,
      sandboxDisabled: this.sandboxSettings.disabled || this.yoloSettings.enabled,
      accountId: options?.accountId ?? null,
      live: idle(null),
    };
    this.threads.set(sessionId, { summary, events: script.events, seq: script.seq, approvals: [], timers: new Set() });
    this.broadcast({ type: "sessions-changed" });
    return summary;
  }

  async loadTranscript(sessionId: string): Promise<TranscriptLoad> {
    const thread = this.threads.get(sessionId);
    if (!thread) {
      throw Object.assign(new Error("That thread is not in the demo."), { status: 404 });
    }
    const live = thread.summary.live;
    return {
      session: thread.summary,
      msp: {
        status: live?.activeTurnId ? "running" : "idle",
        activeTurnId: live?.activeTurnId ?? null,
        modelId: thread.summary.modelId,
        approvalMode: "onRequest",
        workspaceRoot: thread.summary.cwd,
        turnCount: thread.summary.turnCount,
      },
      events: [...thread.events],
      truncated: false,
      attachments: [],
      shellRuns: [],
      pending: { approvals: [...thread.approvals], userInputs: [] },
      pendingComplete: true,
      readOnly: false,
      readOnlyReason: null,
    };
  }

  assetUrl(path: string): string {
    return path;
  }

  async updateSession(sessionId: string, patch: { title?: string; archived?: boolean; settled?: boolean }): Promise<SessionSummary | null> {
    const thread = this.threads.get(sessionId);
    if (!thread) {
      return null;
    }
    const at = iso(Date.now());
    let next: SessionSummary = { ...thread.summary };
    if (patch.title !== undefined) {
      next = { ...next, title: patch.title, titleSource: "user" };
    }
    if (patch.archived !== undefined) {
      next = { ...next, archived: patch.archived };
    }
    if (patch.settled !== undefined) {
      next = patch.settled ? { ...next, settled: true, settledAt: at, unsettledAt: null } : { ...next, settled: false, settledAt: null, unsettledAt: at };
    }
    thread.summary = next;
    return next;
  }

  async forkSession(sessionId: string): Promise<SessionSummary> {
    const source = this.threads.get(sessionId);
    if (!source) {
      throw new Error("That thread is not in the demo.");
    }
    this.created += 1;
    const forkId = sampleId(`fork:${sessionId}:${this.created}:${Date.now()}`);
    const running = source.summary.live?.activeTurnId ?? null;
    // A fork carries every completed turn, so the one still running stays behind.
    const events = source.events
      .filter((event) => !running || (event.params["turnId"] !== running && (event.params["item"] as MspItem | undefined)?.turnId !== running))
      .map((event) => ({ ...event, params: { ...event.params, sessionId: forkId } }));
    const summary: SessionSummary = {
      ...source.summary,
      sessionId: forkId,
      title: `${source.summary.title} (fork)`,
      titleSource: "user",
      createdAt: iso(Date.now()),
      activityAt: iso(Date.now()),
      settled: false,
      settledAt: null,
      unsettledAt: null,
      live: idle(),
    };
    this.threads.set(forkId, { summary, events, seq: source.seq, approvals: [], timers: new Set() });
    this.broadcast({ type: "sessions-changed" });
    return summary;
  }

  // ------------------------------------------------------------------------------------ turns

  private branchOf(thread: Thread): string {
    for (let i = thread.events.length - 1; i >= 0; i--) {
      const event = thread.events[i];
      const branch = event?.method === "session/branchChanged" ? event.params["branch"] : undefined;
      if (typeof branch === "string") {
        return branch;
      }
    }
    return "main";
  }

  async sendTurn(
    sessionId: string,
    text: string,
    options?: TurnOptions,
  ): Promise<{ turnId: string | null; disposition: string | null; attachments?: AttachmentView[] }> {
    const thread = this.threads.get(sessionId);
    if (!thread) {
      throw new Error("That thread is not in the demo.");
    }
    const shown = options?.displayText ?? text;
    const active = thread.summary.live?.activeTurnId ?? null;
    this.created += 1;
    if (active) {
      if (options?.ifBusy === "steer") {
        this.emit(sessionId, "item/completed", {
          item: { itemId: sampleId(`steer:${sessionId}:${this.created}`), kind: "userMessage", status: "completed", revision: 1, text: shown, steered: true, turnId: active, recordedAt: iso(Date.now()) },
        });
        return { turnId: active, disposition: "steered" };
      }
      // Queued behind the running turn, which in the demo never ends by itself; unqueue takes it back.
      return { turnId: sampleId(`queued:${sessionId}:${this.created}`), disposition: "queued" };
    }

    const turnId = sampleId(`turn:${sessionId}:${this.created}:${Date.now()}`);
    const started = Date.now();
    let summary: SessionSummary = { ...thread.summary, turnCount: thread.summary.turnCount + 1 };
    if (summary.titleSource === "placeholder") {
      const title = shown.replace(/\s+/g, " ").trim();
      summary = { ...summary, title: title.length > 60 ? `${title.slice(0, 57).trimEnd()}...` : title, titleSource: "auto" };
    }
    thread.summary = summary;
    this.setLive(sessionId, { ...idle(null), activeTurnId: turnId, turnStartedAt: iso(started) });
    this.broadcast({ type: "sessions-changed" });

    this.later(sessionId, () => {
      this.emit(sessionId, "turn/started", { turnId, commandId: turnId });
      this.emit(sessionId, "item/completed", {
        item: { itemId: sampleId(`prompt:${turnId}`), kind: "userMessage", status: "completed", revision: 1, text: shown, turnId, commandId: turnId, recordedAt: iso(Date.now()) },
      });
    }, 250);
    const toolId = sampleId(`tool:${turnId}`);
    const args = JSON.stringify({ command: "git status --short --branch", description: "Check the working tree" });
    this.later(sessionId, () => this.emit(sessionId, "item/started", { item: { itemId: toolId, kind: "toolCall", tool: "bash", status: "inProgress", revision: 1, turnId, args } }), 900);
    this.later(sessionId, () => {
      this.emit(sessionId, "item/completed", {
        item: { itemId: toolId, kind: "toolCall", tool: "bash", status: "completed", revision: 2, turnId, args, visibleOutput: `## ${this.branchOf(thread)}\n`, recordedAt: iso(Date.now()) },
      });
    }, 1900);
    const replyId = sampleId(`reply:${turnId}`);
    this.later(sessionId, () => this.emit(sessionId, "item/started", { item: { itemId: replyId, kind: "agentMessage", status: "inProgress", revision: 1, text: "", turnId } }), 2400);
    const words = REPLY.split(/(?<= )/);
    let at = 2500;
    for (let i = 0; i < words.length; i += 3) {
      const delta = words.slice(i, i + 3).join("");
      this.later(sessionId, () => this.emit(sessionId, "item/delta", { itemId: replyId, field: "text", delta, turnId }), at);
      at += 70;
    }
    this.later(sessionId, () => {
      this.emit(sessionId, "item/completed", { item: { itemId: replyId, kind: "agentMessage", status: "completed", revision: 2, text: REPLY, turnId, recordedAt: iso(Date.now()) } });
      this.emit(sessionId, "session/tokenUsage", {
        turnId,
        modelId: thread.summary.modelId ?? MODEL,
        durationMs: Date.now() - started,
        promptTokens: 18_200,
        totalTokens: 18_430,
        usage: { inputTokens: 18_200, outputTokens: 230, cachedTokens: 12_000, cacheReadTokens: 12_000, cacheWriteTokens: 0, reasoningTokens: 20 },
        cumulative: { promptTokens: 18_200, outputTokens: 230, totalTokens: 18_430 },
      });
      this.emit(sessionId, "session/contextUsage", { usedTokens: 18_430, windowTokens: 1_000_000, pressure: "normal" });
      this.emit(sessionId, "turn/completed", { turnId, terminal: "completed", durationMs: Date.now() - started, timeToFirstTokenMs: 2400 });
      this.setLive(sessionId, idle());
    }, at + 200);
    return { turnId, disposition: "started" };
  }

  async interruptTurn(sessionId: string, turnId?: string): Promise<void> {
    const thread = this.threads.get(sessionId);
    const active = turnId ?? thread?.summary.live?.activeTurnId ?? null;
    if (!thread || !active) {
      return;
    }
    this.cancelTimers(sessionId);
    if (sessionId === this.audit.sessionId && this.audit.status === "inProgress") {
      this.stopAudit();
    }
    for (const request of thread.approvals.splice(0)) {
      this.emit(sessionId, "approval/resolved", { approvalId: request.approvalId, decision: "cancelled", resolvedBy: "system" });
      const item = request.itemId ? this.findItem(thread, request.itemId) : null;
      if (item) {
        this.emit(sessionId, "item/completed", { item: { ...item, status: "cancelled", revision: item.revision + 1, recordedAt: iso(Date.now()) } });
      }
    }
    this.emit(sessionId, "turn/completed", { turnId: active, terminal: "interrupted", durationMs: Date.now() - Date.parse(thread.summary.live?.turnStartedAt ?? iso(Date.now())) });
    this.setLive(sessionId, idle("interrupted"));
  }

  async unqueueTurn(sessionId: string, turnId: string): Promise<void> {
    this.emit(sessionId, "turn/unqueued", { turnId });
  }

  async decideApproval(input: ApprovalDecisionInput): Promise<void> {
    const thread = this.threads.get(input.sessionId);
    const request = thread?.approvals.find((approval) => approval.approvalId === input.approvalId);
    if (!thread || !request) {
      return;
    }
    thread.approvals = thread.approvals.filter((approval) => approval !== request);
    const choice = request.availableChoices.find((option) => option.choiceId === input.choiceId);
    const approved = choice?.decision === "approved";
    const turnId = request.turnId ?? thread.summary.live?.activeTurnId ?? null;
    this.emit(input.sessionId, "approval/resolved", { approvalId: request.approvalId, decision: approved ? "approved" : "denied", resolvedBy: "user" });
    this.setLive(input.sessionId, { ...idle(null), activeTurnId: turnId, turnStartedAt: thread.summary.live?.turnStartedAt ?? iso(Date.now()) });
    const item = request.itemId ? this.findItem(thread, request.itemId) : null;
    this.later(input.sessionId, () => {
      if (!item) {
        return;
      }
      this.emit(input.sessionId, "item/completed", {
        item: {
          ...item,
          status: approved ? "completed" : "rejected",
          revision: item.revision + 1,
          recordedAt: iso(Date.now()),
          ...(approved
            ? {
                visibleOutput:
                  "\nRunning 4 tests using 2 workers\n\n  ✓  1 settings-dialog.spec.ts:8:3 › light theme (1.2s)\n  ✓  2 settings-dialog.spec.ts:14:3 › dark theme (1.4s)\n  ✓  3 settings-dialog.spec.ts:20:3 › light theme at 200% zoom (1.6s)\n  ✓  4 settings-dialog.spec.ts:27:3 › dark theme at 200% zoom (1.5s)\n\n  4 passed (4.8s)\n",
              }
            : {}),
        },
      });
    }, approved ? 2600 : 600);
    const reply = approved
      ? "Muted text in dark mode is now `#a1a8b3`, 7.7:1 on the dialog's surface (it was 3.8:1), set in [src/styles/tokens.css](src/styles/tokens.css). The two dark-theme snapshots were rewritten and the two light ones came out identical, so the light theme is untouched. The same token also lifts the sidebar's muted labels, which had the same problem."
      : "I left the snapshots alone. The token change is in [src/styles/tokens.css](src/styles/tokens.css); run `npx playwright test settings-dialog --update-snapshots` when you want the dark-theme screenshots refreshed.";
    this.later(input.sessionId, () => {
      this.emit(input.sessionId, "item/completed", {
        item: { itemId: sampleId(`reply:${request.approvalId}`), kind: "agentMessage", status: "completed", revision: 1, text: reply, turnId, recordedAt: iso(Date.now()) },
      });
      if (turnId) {
        const startedAt = Date.parse(thread.summary.live?.turnStartedAt ?? iso(Date.now()));
        this.emit(input.sessionId, "turn/completed", { turnId, terminal: "completed", durationMs: Date.now() - startedAt, timeToFirstTokenMs: 1500 });
      }
      this.setLive(input.sessionId, idle());
    }, approved ? 4200 : 1800);
  }

  async answerUserInput(): Promise<void> {}
  async cancelUserInput(): Promise<void> {}
  async clarifyUserInput(): Promise<void> {}

  // ------------------------------------------------------------------------------------ workflow

  /** Cancels the run: agents that finished keep their results, the rest stop where they are. */
  private stopAudit(): void {
    this.audit.status = "cancelled";
    this.audit.children = this.audit.children.map((child) =>
      child.state === "working" || child.state === "waiting" ? { ...child, state: "cancelled" as const } : child,
    );
    this.reviseAudit();
  }

  async workflow(sessionId: string, action: WorkflowAction, workflowRunId: string, child?: { childId: string; attempt: number }): Promise<void> {
    if (sessionId !== this.audit.sessionId || workflowRunId !== this.audit.runId || this.audit.status !== "inProgress") {
      throw new Error("That workflow is not running.");
    }
    if (action === "cancel") {
      this.stopAudit();
      const turnId = this.audit.turnId;
      this.later(sessionId, () => {
        this.emit(sessionId, "item/completed", {
          item: {
            itemId: sampleId(`reply:cancel:${this.audit.runId}`),
            kind: "agentMessage",
            status: "completed",
            revision: 1,
            text: "Stopped the audit. The route scan and the migration review had finished: `DELETE /v1/tokens/legacy` is gone and `orders.total_cents` became `total_amount` plus `currency`. The schema and SDK checks did not complete, so the report is not final.",
            turnId,
            recordedAt: iso(Date.now()),
          },
        });
        const startedAt = Date.parse(this.threads.get(sessionId)?.summary.live?.turnStartedAt ?? iso(Date.now()));
        this.emit(sessionId, "turn/completed", { turnId, terminal: "completed", durationMs: Date.now() - startedAt, timeToFirstTokenMs: 1600 });
        this.setLive(sessionId, idle());
      }, 1600);
      return;
    }
    const target = this.audit.children.find((entry) => entry.childId === child?.childId);
    if (!target) {
      throw new Error("That agent is not part of this run.");
    }
    if (action === "skip" && (target.state === "working" || target.state === "waiting")) {
      target.state = "skipped";
      this.reviseAudit();
    }
  }

  async subagent(): Promise<void> {}
  async task(): Promise<void> {}

  /** Lets the audit finish, for a screenshot of the completed report. Not reachable from the UI. */
  finishAudit(): void {
    if (this.audit.status !== "inProgress") {
      return;
    }
    const sessionId = this.audit.sessionId;
    this.audit.children = this.audit.children.map((child, index) =>
      child.state === "completed" ? child : { ...child, state: "completed" as const, durationMs: 64_000 + index * 9_000, toolCalls: 7 + index },
    );
    this.audit.status = "completed";
    this.audit.summary = AUDIT_SUMMARY;
    this.reviseAudit();
    this.emit(sessionId, "session/todoListChanged", {
      items: [
        { text: "Scope the diff since v1.9.0", status: "completed" },
        { text: "Audit routes, schema, SDK and migrations in parallel", status: "completed" },
        { text: "Merge the findings into release-note wording", status: "completed" },
      ],
    });
    this.emit(sessionId, "item/completed", {
      item: { itemId: sampleId(`reply:${this.audit.runId}`), kind: "agentMessage", status: "completed", revision: 1, text: AUDIT_SUMMARY, turnId: this.audit.turnId, recordedAt: iso(Date.now()) },
    });
    const startedAt = Date.parse(this.threads.get(sessionId)?.summary.live?.turnStartedAt ?? iso(Date.now()));
    this.emit(sessionId, "turn/completed", { turnId: this.audit.turnId, terminal: "completed", durationMs: Date.now() - startedAt, timeToFirstTokenMs: 1600 });
    this.setLive(sessionId, idle());
  }

  // ------------------------------------------------------------------------------------ session controls

  async listModels(): Promise<ModelOption[]> {
    return parseModelList({
      models: [
        { modelId: MODEL, displayLabel: "Muse Spark 1.3", description: "Muse's current coding model.", isDefault: true, isActive: true, contextLimit: 1_000_000, outputLimit: 64_000 },
        {
          modelId: `${MODEL}-contributor`,
          displayLabel: "Muse Spark 1.3",
          description: "The same model at a lower rate; prompts and outputs may be used for product improvement.",
          isDefault: false,
          isActive: false,
          contextLimit: 1_000_000,
          outputLimit: 64_000,
        },
        { modelId: "muse-spark-1.2", displayLabel: "Muse Spark 1.2", description: "The previous release.", isDefault: false, isActive: false, contextLimit: 1_000_000, outputLimit: 64_000 },
      ],
    });
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const thread = this.threads.get(sessionId);
    if (thread) {
      thread.summary = { ...thread.summary, modelId };
    }
    this.emit(sessionId, "session/modelChanged", { modelId });
  }

  async setApprovalMode(sessionId: string, mode: ApprovalMode): Promise<void> {
    this.emit(sessionId, "session/approvalModeChanged", { mode, source: "approvalReconfigure" });
  }

  async setReasoningEffort(): Promise<void> {}

  async compact(sessionId: string): Promise<{ noop: boolean; reason: string | null }> {
    const thread = this.threads.get(sessionId);
    const used = [...(thread?.events ?? [])].reverse().find((event) => event.method === "session/contextUsage")?.params["usedTokens"];
    const before = typeof used === "number" ? used : 0;
    if (!thread || before < 20_000) {
      return { noop: true, reason: "no_compactable_history" };
    }
    const after = Math.round(before * 0.18);
    this.emit(sessionId, "item/completed", {
      item: { itemId: sampleId(`compact:${sessionId}:${thread.seq}`), kind: "compaction", status: "completed", revision: 1, trigger: "manual", outcome: "compacted", tokensBefore: before, tokensAfter: after, recordedAt: iso(Date.now()) },
    });
    this.emit(sessionId, "session/contextUsage", { usedTokens: after, windowTokens: 1_000_000, pressure: "normal" });
    return { noop: false, reason: null };
  }

  async runShell(sessionId: string, command: string): Promise<void> {
    this.created += 1;
    this.emit(sessionId, "item/completed", {
      item: {
        itemId: sampleId(`shell:${sessionId}:${this.created}`),
        kind: "userShell",
        status: "completed",
        revision: 1,
        commandText: command,
        visibleOutput: "Demo mode: nothing ran. In your own project the command's output shows up here.\n",
        exitCode: 0,
        durationMs: 12,
        recordedAt: iso(Date.now()),
      },
    });
  }

  async runShellProxy(sessionId: string, command: string): Promise<ShellRun> {
    this.created += 1;
    return {
      id: sampleId(`run:${sessionId}:${this.created}`),
      sessionId,
      command,
      exitCode: 0,
      output: "Demo mode: nothing ran. In your own project the command's output shows up here.\n",
      truncated: false,
      durationMs: 12,
      at: iso(Date.now()),
    };
  }

  /** Goals play back the way Muse reports them, so the goal card shows and reacts. */
  async goal(sessionId: string, action: GoalAction, objective?: string): Promise<{ turnId: string | null }> {
    const thread = this.threads.get(sessionId);
    const current = [...(thread?.events ?? [])].reverse().find((event) => event.method === "session/goalChanged")?.params["goal"] as
      | { objective: string; status: string; percentComplete: number }
      | null
      | undefined;
    if (action === "clear") {
      this.emit(sessionId, "session/goalChanged", { goal: null });
      return { turnId: null };
    }
    const text = objective ?? current?.objective;
    if (!text) {
      throw new Error("There is no goal in this thread yet.");
    }
    this.emit(sessionId, "session/goalChanged", {
      goal: { objective: text, status: action === "pause" ? "paused" : "active", percentComplete: action === "set" ? 0 : (current?.percentComplete ?? 0) },
    });
    return { turnId: null };
  }

  async readOutput(): Promise<OutputRange> {
    return { content: "", encoding: "utf8", mediaType: "text/plain", offsetBytes: 0, byteLen: 0, eof: true };
  }

  // ------------------------------------------------------------------------------------ skills

  async listSkills(): Promise<SkillCatalog> {
    return {
      skills: [
        {
          id: "review",
          name: "review",
          displayName: "Review",
          description: "Review the working tree's diff for bugs, missing tests and unclear names before a commit.",
          shortDescription: "Review the current diff",
          scope: "user",
          activation: "on",
        },
        {
          id: "release-notes",
          name: "release-notes",
          displayName: "Release notes",
          description: "Draft release notes from the commits since the last tag, grouped by breaking changes, features and fixes.",
          shortDescription: "Draft release notes since the last tag",
          scope: "project",
          activation: "user-invocable-only",
          argumentHint: "[tag]",
        },
        {
          id: "migration-check",
          name: "migration-check",
          displayName: "Migration check",
          description: "Check a SQL migration for locks, long rewrites and irreversible steps.",
          shortDescription: "Check a migration for risky steps",
          scope: "project",
          activation: "on",
        },
      ],
      error: null,
    };
  }

  async skillBody(_cwd: string, skillId: string): Promise<string> {
    return `# ${skillId}\n\nSample instructions for the demo's \`${skillId}\` skill.\n`;
  }

  // ------------------------------------------------------------------------------------ settings

  async getTitleSettings(): Promise<TitleSettings> {
    return { ...this.titleSettings };
  }

  async setTitleSettings(patch: { enabled?: boolean; modelId?: string | null }): Promise<TitleSettings> {
    this.titleSettings = {
      enabled: patch.enabled ?? this.titleSettings.enabled,
      modelId: patch.modelId !== undefined ? patch.modelId : this.titleSettings.modelId,
    };
    return { ...this.titleSettings };
  }

  async getSandboxSettings(): Promise<SandboxSettings> {
    return { ...this.sandboxSettings };
  }

  async setSandboxSettings(patch: { disabled?: boolean }): Promise<SandboxSettings> {
    this.sandboxSettings = { disabled: patch.disabled ?? this.sandboxSettings.disabled };
    return { ...this.sandboxSettings };
  }

  async getYoloSettings(): Promise<YoloSettings> {
    return { ...this.yoloSettings };
  }

  async setYoloSettings(patch: { enabled?: boolean }): Promise<YoloSettings> {
    this.yoloSettings = { enabled: patch.enabled ?? this.yoloSettings.enabled };
    return { ...this.yoloSettings };
  }

  // ------------------------------------------------------------------------------------ accounts

  async listAccounts(): Promise<AccountView[]> {
    return this.accounts.map((account) => ({ ...account }));
  }

  async createAccount(id: string, options?: { name?: string; seedFromDefault?: boolean }): Promise<{ id: string; name: string }> {
    const clean = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    if (this.accounts.some((account) => account.id === clean)) {
      throw new Error(`There is already an account called ${clean}.`);
    }
    const name = options?.name?.trim() || clean;
    this.accounts.push({ id: clean, name, hasLogin: false, email: null, lastUsedAt: null });
    return { id: clean, name };
  }

  async renameAccount(id: string, name: string): Promise<void> {
    this.accounts = this.accounts.map((account) => (account.id === id ? { ...account, name } : account));
  }

  async removeAccount(id: string): Promise<void> {
    this.accounts = this.accounts.filter((account) => account.id !== id);
  }

  async setProjectDefaultAccount(cwd: string, accountId: string | null): Promise<void> {
    this.projects = this.projects.map((project) => (project.cwd === cwd ? { ...project, defaultAccountId: accountId } : project));
  }

  async accountsHealth(): Promise<{ metaApiKeyInherited: boolean }> {
    return { metaApiKeyInherited: false };
  }

  async loginAccount(): Promise<{ url: string; code: string | null } | { fallback: string }> {
    return { fallback: "Signing in is off in the demo. In Ancilla this shows a device code to enter on the sign-in page." };
  }

  // ------------------------------------------------------------------------------------ usage

  async usage(days?: number): Promise<UsageReport> {
    const window = Math.min(365, Math.max(1, Math.round(days ?? 30)));
    const now = this.now;
    const buckets: UsageBucket[] = [];
    for (let d = window - 1; d >= 0; d--) {
      const at = now - d * DAY;
      const day = iso(at).slice(0, 10);
      const weekday = new Date(at).getUTCDay();
      const weekend = weekday === 0 || weekday === 6;
      const wave = 0.55 + 0.45 * Math.sin((d / Math.max(1, window - 1)) * Math.PI * 3.2 + 1.1);
      const calls = Math.round((weekend ? 12 : 46) * wave + 5);
      buckets.push({
        day,
        modelId: MODEL,
        calls,
        promptTokens: calls * 23_400,
        outputTokens: calls * 710,
        cachedTokens: calls * 16_800,
        cacheReadTokens: calls * 16_800,
        cacheWriteTokens: calls * 900,
        reasoningTokens: calls * 140,
        durationMs: calls * 5_600,
      });
      // Thread titles come from one small call each, on the cheaper contributor model.
      const titles = Math.max(1, Math.round(calls / 9));
      buckets.push({
        day,
        modelId: `${MODEL}-contributor`,
        calls: titles,
        promptTokens: titles * 1_900,
        outputTokens: titles * 24,
        cachedTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        durationMs: titles * 700,
      });
    }
    const since = now - (window - 1) * DAY;
    const weights = [46, 18, 12, 31, 14, 9, 11, 6];
    const threads: UsageThread[] = [...this.threads.values()]
      .map((thread) => thread.summary)
      .filter((summary) => Date.parse(summary.activityAt) >= since - DAY)
      .map((summary, index) => {
        const calls = Math.max(1, Math.round((weights[index] ?? 5) * Math.min(1, window / 7 + 0.4)));
        const promptTokens = calls * 24_800;
        const outputTokens = calls * 760;
        const cachedTokens = calls * 17_300;
        return {
          sessionId: summary.sessionId,
          title: summary.title,
          cwd: summary.cwd,
          calls,
          promptTokens,
          outputTokens,
          cachedTokens,
          modelIds: [summary.modelId ?? MODEL],
          models: [{ modelId: summary.modelId ?? MODEL, calls, promptTokens, outputTokens, cachedTokens }],
          lastAt: summary.activityAt,
        };
      });
    return { since: iso(since), days: window, buckets, threads };
  }

  /** A mid-afternoon plan meter for the default login, and an older reading for the side account. */
  async planUsage(): Promise<{ usage: PlanUsage | null; byAccount: PlanUsageByAccount }> {
    const now = this.now;
    return {
      usage: {
        // Muse 1.3 reports the tier as an opaque number, which Ancilla leaves off the meter.
        tier: "2",
        observedAtMs: now - 2 * MIN,
        window: { usedPercent: 38, resetsAtMs: now + 2 * HOUR + 17 * MIN, windowDurationMins: 300 },
        weekly: { usedPercent: 21, resetsAtMs: now + 3 * DAY + 5 * HOUR, windowDurationMins: null },
      },
      byAccount: {
        [SIDE_ACCOUNT]: {
          tier: "2",
          observedAtMs: now - 3 * HOUR - 10 * MIN,
          window: { usedPercent: 12, resetsAtMs: now + 1 * HOUR + 48 * MIN, windowDurationMins: 300 },
          weekly: { usedPercent: 9, resetsAtMs: now + 5 * DAY + 2 * HOUR, windowDurationMins: null },
        },
      },
    };
  }

  // ------------------------------------------------------------------------------------ files

  async listFiles(cwd: string, path: string): Promise<FileListing> {
    return this.files.list(cwd, path);
  }

  async readFile(cwd: string, path: string): Promise<FileContent> {
    return this.files.read(cwd, path);
  }

  async writeFile(cwd: string, path: string, content: string): Promise<{ path: string; size: number; mtimeMs: number }> {
    return this.files.write(cwd, path, content);
  }

  async searchFiles(cwd: string, query: string): Promise<FileEntry[]> {
    return this.files.search(cwd, query);
  }

  async openFileExternally(): Promise<void> {
    throw new Error("Opening files in other apps is off in the demo.");
  }

  fileUrl(): string {
    return "";
  }
}
