// Ancilla In-Memory Demonstration Client
// Fully in-memory implementation of the AncillaClient interface for
// running simulated scenarios, interactive mock workflows, and virtual projects
// without live server processes or external network dependencies.

import { AncillaError, parseModelCatalog, researchLive } from "@ancilla/ui";
import type {
  AccountView, AncillaClient, AncillaEvent, ApprovalDecisionInput, ApprovalMode,
  ApprovalRequest, AttachmentView, DirectoryListing, EnvironmentStatus, EventHandler,
  FileContent, FileEntry, FileListing, GoalAction, LiveView, ModelCatalog, ModelOption,
  MspItem, OutputRange, PlanUsage, PlanUsageByAccount, ProjectView, ResearchConfig,
  ResearchRunView, ResearchSettings, ResearchWorkerView, SandboxSettings, SessionSummary,
  ShellRun, SkillCatalog, TaskAction, TitleSettings, TranscriptLoad, TurnOptions,
  UsageBucket, UsageReport, UsageThread, ViewEvent, WorkflowAction, YoloSettings,
} from "@ancilla/ui";
import { DemoAssistant } from "./assistant.js";
import { BUILD_END_AT, BUILD_PROMPT, BUILD_REPLY, BUILD_STEPS, BUILD_STEP_AT, BUILD_TOOLS } from "./build.js";
import { DemoFiles } from "./files.js";
import { DAY, HOUR, MIN, MODEL, Script, iso, sampleId } from "./script.js";
import {
  HOME, PROJECTS, RESEARCH_CONFIG, SIDE_ACCOUNT, THREADS, auditItem, childIdFor,
  childrenAt, seed, tokensOf, type AuditAttempt, type AuditChild, type AuditRun,
  type ChildCache, type Scenario, type TaskStream,
} from "./seed.js";

const DEMO_HOST_VERSION = "0.18.0";
const WORKFLOW_HEARTBEAT_INTERVAL_MS = 6_000;
const BACKGROUND_TASK_EMIT_BEATS = 3;

const COMPLETION_AGENT_TOKENS: Record<string, number> = {
  "judge:compat": 96_000,
  "report:release-notes": 41_000,
};

const DEMO_STANDARD_REPLY = [
  "This is Ancilla's demo mode: the real interface running on sample data, so nothing ran and no model was called.",
  "In your own project this thread would stream from `muse serve`, with every tool call, diff and approval shown right here.",
].join(" ");

type ScheduledTimerHandle = ReturnType<typeof setTimeout>;

const SYNTHETIC_RESEARCH_ROUNDS: readonly (readonly string[])[] = [
  ["what the primary sources say", "how it is done in practice", "criticism and open questions"],
  ["figures and measurements", "recent changes"],
];
const RESEARCH_PHASE_TIMINGS = {
  queue: 400,
  scope: 2_000,
  spawn: 1_200,
  tick: 1_100,
  write: 3_000,
} as const;

interface SessionContext {
  summary: SessionSummary;
  events: ViewEvent[];
  seq: number;
  approvals: ApprovalRequest[];
  timers: Set<ScheduledTimerHandle>;
  truncated: boolean;
}

function constructIdleState(previousTerminalStatus: string | null = "completed"): LiveView {
  return {
    activeTurnId: null,
    turnStartedAt: null,
    pendingApprovals: 0,
    pendingInputs: 0,
    lastTerminal: previousTerminalStatus,
    lastError: null,
  };
}
function extractBaseName(folderOrFilePath: string): string {
  const trimmed = folderOrFilePath.replace(/\/+$/, "");
  const segments = trimmed.split("/");
  return segments.pop() || folderOrFilePath;
}
function getLatestAttempt(childAgent: AuditChild): AuditAttempt | undefined {
  return childAgent.attempts[childAgent.attempts.length - 1];
}
export class DemoAncillaClient implements AncillaClient {
  private readonly baselineTimestamp = Date.now();
  private readonly eventSubscribers = new Set<EventHandler>();
  private readonly activeThreads = new Map<string, SessionContext>();
  private readonly virtualFileSystem = new DemoFiles(this.baselineTimestamp);
  private readonly activeAuditRun: AuditRun | null;
  private readonly auditNodeCache: ChildCache = new Map();
  private lastHeartbeatEvent: ViewEvent | null = null;
  private taskStreams: TaskStream[];
  private heartbeatTickCount = 0;
  private simulationOutageActive = false;
  private registeredProjects: ProjectView[];
  private registeredAccounts: AccountView[];
  private activeTitleSettings: TitleSettings = { enabled: true, modelId: null };
  private activeSandboxSettings: SandboxSettings = { disabled: false };
  private activeYoloSettings: YoloSettings = { enabled: false };
  private globalHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private generatedEntityIndex = 0;
  private completedBuildCount = 0;
  private readonly listedListeners: (() => void)[] = [];
  private hasCompletedInitialListing = false;
  private activeResearchSettings: ResearchSettings = { enabled: true, config: RESEARCH_CONFIG };
  private readonly activeResearchRuns = new Map<string, ResearchRunView>();
  private readonly scheduledResearchTimers = new Map<string, ScheduledTimerHandle>();
  private readonly assistantController = new DemoAssistant();
  constructor(readonly scenario: Scenario = "running") {
    const initializedSeed = seed(this.baselineTimestamp, scenario);

    for (const threadRecord of initializedSeed.threads) {
      this.activeThreads.set(threadRecord.summary.sessionId, {
        ...threadRecord,
        timers: new Set(),
        truncated: threadRecord.truncated === true,
      });
    }
    this.activeAuditRun = initializedSeed.audit;
    if (this.activeAuditRun) {
      childrenAt(this.activeAuditRun, this.activeAuditRun.revisedAt, Number.NEGATIVE_INFINITY, this.auditNodeCache);
    }
    this.taskStreams = initializedSeed.streams;
    for (const rRun of initializedSeed.research) {
      this.activeResearchRuns.set(rRun.runId, rRun);
    }
    this.registeredProjects = [
      {
        cwd: PROJECTS.atlas,
        displayName: "atlas-api",
        pinned: true,
        activityAt: iso(this.baselineTimestamp),
        defaultAccountId: null,
        folders: [{ cwd: PROJECTS.atlas, displayName: "atlas-api" }],
      },
      {
        cwd: PROJECTS.lumen,
        displayName: "lumen-web",
        pinned: false,
        activityAt: iso(this.baselineTimestamp),
        defaultAccountId: null,
        folders: [
          { cwd: PROJECTS.lumen, displayName: "lumen-web" },
          { cwd: PROJECTS.lumenSite, displayName: "lumen-site" },
        ],
      },
      {
        cwd: PROJECTS.orbit,
        displayName: "orbit-cli",
        pinned: false,
        activityAt: iso(this.baselineTimestamp),
        defaultAccountId: SIDE_ACCOUNT,
        folders: [{ cwd: PROJECTS.orbit, displayName: "orbit-cli" }],
      },
    ];
    this.registeredAccounts = [
      {
        id: SIDE_ACCOUNT,
        name: "Side projects",
        hasLogin: true,
        email: "demo@example.com",
        lastUsedAt: iso(this.baselineTimestamp - 3 * HOUR),
      },
      {
        id: "client",
        name: "Client work",
        hasLogin: false,
        email: null,
        lastUsedAt: null,
      },
    ];
    if (scenario === "reconnect") {
      void this.whenListed().then(() => this.triggerSyntheticOutage());
    }
    if (scenario === "turn") {
      void this.whenListed().then(() => this.executeBuildWorkflow(THREADS.audit));
    }
    void this.whenListed().then(() => {
      for (const runEntry of this.activeResearchRuns.values()) {
        if (researchLive(runEntry)) {
          this.scheduleNextResearchStep(runEntry.runId, RESEARCH_PHASE_TIMINGS.tick);
        }
      }
    });
  }
  whenListed(): Promise<void> {
    if (this.hasCompletedInitialListing) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.listedListeners.push(resolve);
    });
  }
  // ---------------------------------------------------------------- Plumbing & Events
  private dispatchToSubscribers(event: AncillaEvent): void {
    for (const sub of [...this.eventSubscribers]) {
      sub(event);
    }
  }
  private constructViewEvent(session: SessionContext, method: string, payload: Record<string, unknown>): ViewEvent {
    session.seq += 1;
    const sId = session.summary.sessionId;
    return {
      method,
      params: {
        sessionId: sId,
        viewCursor: `v:${sId}:${session.seq}`,
        ...payload,
      },
      at: Date.now(),
    };
  }
  private transmitSessionEvent(session: SessionContext, evt: ViewEvent): void {
    this.dispatchToSubscribers({
      type: "msp",
      sessionId: session.summary.sessionId,
      method: evt.method,
      params: evt.params,
      at: evt.at ?? Date.now(),
    });
  }
  private appendAndStreamEvent(sessionId: string, method: string, payload: Record<string, unknown>): void {
    const session = this.activeThreads.get(sessionId);
    if (!session) {
      return;
    }
    const viewEvt = this.constructViewEvent(session, method, payload);
    session.events.push(viewEvt);
    if (!this.simulationOutageActive) {
      this.transmitSessionEvent(session, viewEvt);
    }
  }
  private updateSessionLiveState(sessionId: string, liveState: LiveView): void {
    const session = this.activeThreads.get(sessionId);
    if (!session) {
      return;
    }
    session.summary = {
      ...session.summary,
      live: liveState,
      activityAt: iso(Date.now()),
    };
    this.dispatchToSubscribers({
      type: "session-status",
      sessionId,
      live: liveState,
    });
  }
  private deferExecution(sessionId: string, taskFn: () => void, delayMs: number): void {
    const session = this.activeThreads.get(sessionId);
    if (!session) {
      return;
    }
    const timerHandle = setTimeout(() => {
      session.timers.delete(timerHandle);
      taskFn();
    }, delayMs);
    session.timers.add(timerHandle);
  }
  private abortSessionTimers(sessionId: string): void {
    const session = this.activeThreads.get(sessionId);
    for (const timer of session?.timers ?? []) {
      clearTimeout(timer);
    }
    session?.timers.clear();
  }
  private locateLatestItem(session: SessionContext, itemId: string): MspItem | null {
    for (let idx = session.events.length - 1; idx >= 0; idx--) {
      const candidate = session.events[idx]?.params["item"] as MspItem | undefined;
      if (candidate?.itemId === itemId) {
        return candidate;
      }
    }
    return null;
  }
  private assembleItemOutput(session: SessionContext, itemId: string): string {
    let accumulatedOutput = "";
    for (const evt of session.events) {
      const itemRecord = evt.params["item"] as MspItem | undefined;
      if (itemRecord?.itemId === itemId) {
        accumulatedOutput = itemRecord.visibleOutput ?? accumulatedOutput;
      } else if (
        evt.method === "item/delta" &&
        evt.params["itemId"] === itemId &&
        evt.params["field"] === "output"
      ) {
        const chunk = evt.params["delta"];
        if (typeof chunk === "string") {
          accumulatedOutput += chunk;
        }
      }
    }
    return accumulatedOutput;
  }
  private queryActiveBackgroundTasks(session: SessionContext): MspItem[] {
    const latestItemMap = new Map<string, MspItem>();
    for (const evt of session.events) {
      const itemRecord = evt.params["item"] as MspItem | undefined;
      if (itemRecord) {
        latestItemMap.set(itemRecord.itemId, itemRecord);
      }
    }
    return [...latestItemMap.values()].filter(
      (item) => item.kind === "toolCall" && item.background === true && item.status === "inProgress",
    );
  }
  private broadcastAuditRevision(isPeriodicHeartbeat = false): void {
    const run = this.activeAuditRun;
    const session = run ? this.activeThreads.get(run.sessionId) : undefined;
    if (!run || !session) {
      return;
    }

    const currentEpoch = Date.now();
    run.revision += 1;
    const updatedItem = auditItem(run, currentEpoch, run.revisedAt, run.revision, this.auditNodeCache);
    const eventRecord = this.constructViewEvent(session, "item/updated", { item: updatedItem });
    run.revisedAt = currentEpoch;

    if (this.lastHeartbeatEvent) {
      const priorIndex = session.events.indexOf(this.lastHeartbeatEvent);
      if (priorIndex >= 0) {
        session.events.splice(priorIndex, 1);
      }
    }

    this.lastHeartbeatEvent = isPeriodicHeartbeat ? eventRecord : null;
    session.events.push(eventRecord);

    if (!this.simulationOutageActive) {
      this.transmitSessionEvent(session, eventRecord);
    }
  }
  private handleHeartbeatPulse(): void {
    if (this.simulationOutageActive) {
      return;
    }
    this.heartbeatTickCount += 1;
    if (this.activeAuditRun?.status === "inProgress") {
      this.broadcastAuditRevision(true);
    }
    if (this.heartbeatTickCount % BACKGROUND_TASK_EMIT_BEATS === 0) {
      this.streamActiveTaskOutputs();
    }
  }
  private streamActiveTaskOutputs(): void {
    for (const streamEntry of [...this.taskStreams]) {
      const session = this.activeThreads.get(streamEntry.sessionId);
      const taskItem = session ? this.locateLatestItem(session, streamEntry.itemId) : null;
      if (!session || !taskItem || taskItem.status !== "inProgress") {
        this.taskStreams = this.taskStreams.filter((candidate) => candidate !== streamEntry);
        continue;
      }
      if (session.approvals.some((req) => req.itemId === streamEntry.itemId)) {
        continue;
      }

      const nextLine = streamEntry.lines.shift();
      if (nextLine === undefined) {
        this.finalizeTaskExecution(session, taskItem, { status: "completed" });
        continue;
      }

      this.appendAndStreamEvent(streamEntry.sessionId, "item/delta", {
        itemId: streamEntry.itemId,
        field: "output",
        delta: nextLine,
        turnId: taskItem.turnId,
      });
    }
  }
  private finalizeTaskExecution(session: SessionContext, item: MspItem, modifications: Partial<MspItem>): void {
    this.taskStreams = this.taskStreams.filter((s) => s.itemId !== item.itemId);
    this.appendAndStreamEvent(session.summary.sessionId, "item/completed", {
      item: {
        ...item,
        revision: item.revision + 1,
        visibleOutput: this.assembleItemOutput(session, item.itemId),
        recordedAt: iso(Date.now()),
        ...modifications,
      },
    });
  }
  private triggerSyntheticOutage(): void {
    const run = this.activeAuditRun;
    if (!run) {
      return;
    }
    const targetSessionId = run.sessionId;

    this.deferExecution(targetSessionId, () => {
      this.simulationOutageActive = true;
      this.notifyViewHealthChange(targetSessionId, { status: "unavailable", reason: "projectionUnavailable" });
    }, 4_000);

    this.deferExecution(targetSessionId, () => {
      const severityAgent = run.children.find((c) => c.label === "judge:severity");
      const currentAttempt = severityAgent ? getLatestAttempt(severityAgent) : undefined;
      if (currentAttempt && currentAttempt.endedAt === undefined) {
        const timeNow = Date.now();
        currentAttempt.startedAt ??= timeNow;
        if (currentAttempt.usageAt === undefined) {
          currentAttempt.usageAt = timeNow;
          currentAttempt.usage = tokensOf(148_000);
        }
        currentAttempt.endedAt = timeNow;
        currentAttempt.terminal = "completed";
        currentAttempt.durationMs = timeNow - currentAttempt.startedAt;
        this.broadcastAuditRevision();
      }
    }, 8_000);

    this.deferExecution(targetSessionId, () => {
      this.simulationOutageActive = false;
      this.notifyViewHealthChange(targetSessionId, null);
    }, 16_000);
  }
  private notifyViewHealthChange(
    sessionId: string,
    healthStatus: { status: "unavailable"; reason: string } | null,
  ): void {
    const session = this.activeThreads.get(sessionId);
    if (!session) {
      return;
    }
    const healthPayload: Record<string, unknown> = healthStatus
      ? { sessionId, health: "unavailable", noneReason: healthStatus.reason }
      : { sessionId, health: "healthy" };

    this.dispatchToSubscribers({
      type: "msp",
      sessionId,
      method: "session/viewHealthChanged",
      params: healthPayload,
      at: Date.now(),
    });
    this.updateSessionLiveState(sessionId, {
      ...(session.summary.live ?? constructIdleState(null)),
      viewHealth: healthStatus,
    });
  }
  dispose(): void {
    if (this.globalHeartbeatInterval !== null) {
      clearInterval(this.globalHeartbeatInterval);
      this.globalHeartbeatInterval = null;
    }
    for (const sId of this.activeThreads.keys()) {
      this.abortSessionTimers(sId);
    }
    for (const rId of [...this.scheduledResearchTimers.keys()]) {
      this.cancelResearchTimer(rId);
    }
  }
  // ---------------------------------------------------------------- Environment & Subscription
  async probeEnvironment(): Promise<EnvironmentStatus> {
    return {
      platform: "linux",
      runtime: "posix",
      wslAvailable: false,
      defaultDistro: null,
      museFound: true,
      musePath: "/usr/local/bin/muse",
      version: DEMO_HOST_VERSION,
      persistent: true,
    };
  }
  subscribe(handler: EventHandler): () => void {
    this.eventSubscribers.add(handler);
    handler({ type: "hello", version: DEMO_HOST_VERSION });
    if (this.globalHeartbeatInterval === null) {
      this.globalHeartbeatInterval = setInterval(
        () => this.handleHeartbeatPulse(),
        WORKFLOW_HEARTBEAT_INTERVAL_MS,
      );
    }
    return () => {
      this.eventSubscribers.delete(handler);
    };
  }
  // ---------------------------------------------------------------- Projects Management
  async listProjects(): Promise<ProjectView[]> {
    return this.registeredProjects.map((proj) => {
      const mostRecentActivity = [...this.activeThreads.values()]
        .filter((thread) => proj.folders.some((f) => f.cwd === thread.summary.cwd) && !thread.summary.archived)
        .map((thread) => thread.summary.activityAt)
        .sort()
        .pop();
      return {
        ...proj,
        activityAt: mostRecentActivity ?? proj.activityAt,
      };
    });
  }
  private normalizeFolderPath(inputPath: string): string {
    return inputPath.replace(/^~(?=\/|$)/, HOME).replace(/\/+$/, "") || "/";
  }
  async addProject(cwd: string): Promise<{ cwd: string; warning: string | null }> {
    const cleanCwd = this.normalizeFolderPath(cwd);
    const existing = this.registeredProjects.find((p) => p.folders.some((f) => f.cwd === cleanCwd));
    if (existing) {
      return { cwd: existing.cwd, warning: null };
    }

    this.registeredProjects.push({
      cwd: cleanCwd,
      displayName: extractBaseName(cleanCwd),
      pinned: false,
      activityAt: iso(Date.now()),
      defaultAccountId: null,
      folders: [{ cwd: cleanCwd, displayName: extractBaseName(cleanCwd) }],
    });
    this.dispatchToSubscribers({ type: "sessions-changed" });
    return { cwd: cleanCwd, warning: null };
  }
  async addProjectFolder(cwd: string, path: string): Promise<{ project: ProjectView; warning: string | null }> {
    const cleanFolder = this.normalizeFolderPath(path);
    const parentProject = this.registeredProjects.find((p) => p.cwd === cwd);
    if (!parentProject) {
      throw new Error("Unknown project.");
    }
    if (cleanFolder === cwd) {
      throw new Error("A project cannot be a folder of itself.");
    }

    const independentProject = this.registeredProjects.find((p) => p.cwd === cleanFolder);
    if (independentProject && independentProject.folders.length > 1) {
      throw new Error(`${independentProject.displayName} is a project with folders of its own. Remove its folders first.`);
    }

    const collision = this.registeredProjects.find(
      (p) => p.cwd !== cwd && p.folders.some((f) => f.cwd === cleanFolder),
    );
    if (collision) {
      throw new Error(`${extractBaseName(cleanFolder)} is already a folder of ${collision.displayName}. Remove it there first.`);
    }

    this.registeredProjects = this.registeredProjects.filter((p) => p.cwd !== cleanFolder);
    if (!parentProject.folders.some((f) => f.cwd === cleanFolder)) {
      parentProject.folders = [...parentProject.folders, { cwd: cleanFolder, displayName: extractBaseName(cleanFolder) }];
    }

    this.dispatchToSubscribers({ type: "sessions-changed" });
    return { project: { ...parentProject }, warning: null };
  }
  async removeProjectFolder(cwd: string, path: string): Promise<ProjectView> {
    const parentProject = this.registeredProjects.find((p) => p.cwd === cwd);
    if (!parentProject || !parentProject.folders.some((f, idx) => idx > 0 && f.cwd === path)) {
      throw new Error("That folder is not part of this project.");
    }

    parentProject.folders = parentProject.folders.filter((f) => f.cwd !== path);
    this.registeredProjects.push({
      cwd: path,
      displayName: extractBaseName(path),
      pinned: false,
      activityAt: iso(Date.now()),
      defaultAccountId: null,
      folders: [{ cwd: path, displayName: extractBaseName(path) }],
    });
    this.dispatchToSubscribers({ type: "sessions-changed" });
    return { ...parentProject };
  }
  async cloneProject(_url: string, path: string): Promise<{ cwd: string; warning: string | null }> {
    const created = await this.addProject(path);
    return { ...created, warning: "Nothing was cloned: this is the demo, so the project starts empty." };
  }
  async listDirectory(path: string): Promise<DirectoryListing> {
    const sampleTree: Record<string, string[]> = {
      "/": ["home"],
      "/home": ["demo"],
      [HOME]: ["code", "notes"],
      [`${HOME}/code`]: ["atlas-api", "lumen-site", "lumen-web", "orbit-cli", "playground"],
    };

    const targetDir = (path.trim() || HOME).replace(/^~(?=\/|$)/, HOME).replace(/(.)\/+$/, "$1");
    const parentDir = targetDir === "/" ? null : targetDir.slice(0, targetDir.lastIndexOf("/")) || "/";
    const dirExists =
      targetDir in sampleTree ||
      this.registeredProjects.some((p) => p.folders.some((f) => f.cwd === targetDir));
    return {
      directory: targetDir,
      parent: parentDir,
      separator: "/",
      exists: dirExists,
      entries: (sampleTree[targetDir] ?? []).map((name) => ({ name })),
    };
  }
  async revealPath(): Promise<void> {}
  async hideProject(cwd: string): Promise<void> {
    this.registeredProjects = this.registeredProjects.filter((p) => p.cwd !== cwd);
  }
  async setPinned(cwd: string, pinned: boolean): Promise<void> {
    this.registeredProjects = this.registeredProjects.map((p) => (p.cwd === cwd ? { ...p, pinned } : p));
  }
  async setProjectOrder(cwds: string[]): Promise<void> {
    const computeWeight = (folderPath: string) => {
      const idx = cwds.indexOf(folderPath);
      return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
    };
    this.registeredProjects = [...this.registeredProjects].sort(
      (alpha, beta) => computeWeight(alpha.cwd) - computeWeight(beta.cwd),
    );
  }
  async openFolder(): Promise<void> {}
  async openProjectFile(): Promise<void> {}
  // ---------------------------------------------------------------- Sessions & Threads
  browserSocketUrl(): string | null {
    if (typeof window === "undefined") {
      return null;
    }
    return new URLSearchParams(window.location.search).get("browser");
  }

  async listSessions(options?: { archived?: boolean }): Promise<SessionSummary[]> {
    const filteredSummaries = [...this.activeThreads.values()]
      .map((t) => t.summary)
      .filter((s) => s.archived === (options?.archived ?? false));

    if (!this.hasCompletedInitialListing) {
      this.hasCompletedInitialListing = true;
      for (const listener of this.listedListeners.splice(0)) {
        listener();
      }
    }
    return filteredSummaries;
  }
  async discover(): Promise<void> {}
  async startSession(
    cwd: string,
    options?: { approvalMode?: ApprovalMode; modelId?: string; accountId?: string | null },
  ): Promise<SessionSummary> {
    this.generatedEntityIndex += 1;
    const newSessionId = sampleId(`new:${this.baselineTimestamp}:${this.generatedEntityIndex}:${Date.now()}`);
    const initialScript = new Script(newSessionId, cwd, Date.now() - 500, {
      approvalMode: options?.approvalMode,
      modelId: options?.modelId,
      branch: "main",
    });
    const newSummary: SessionSummary = {
      sessionId: newSessionId,
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
      sandboxDisabled: this.activeSandboxSettings.disabled || this.activeYoloSettings.enabled,
      accountId: options?.accountId ?? null,
      live: constructIdleState(null),
    };

    this.activeThreads.set(newSessionId, {
      summary: newSummary,
      events: initialScript.events,
      seq: initialScript.seq,
      approvals: [],
      timers: new Set(),
      truncated: false,
    });
    this.dispatchToSubscribers({ type: "sessions-changed" });
    return newSummary;
  }
  async loadTranscript(sessionId: string): Promise<TranscriptLoad> {
    const thread = this.activeThreads.get(sessionId);
    if (!thread) {
      throw Object.assign(new Error("That thread is not in the demo."), { status: 404 });
    }

    const liveRecord = thread.summary.live;
    const isOutageAffected = this.simulationOutageActive && sessionId === this.activeAuditRun?.sessionId;

    return {
      session: thread.summary,
      msp: {
        status: liveRecord?.activeTurnId ? "running" : "idle",
        activeTurnId: liveRecord?.activeTurnId ?? null,
        modelId: thread.summary.modelId,
        approvalMode: "onRequest",
        workspaceRoot: thread.summary.cwd,
        turnCount: thread.summary.turnCount,
      },
      events: [...thread.events],
      truncated: thread.truncated,
      attachments: [],
      shellRuns: [],
      researchRuns: this.queryResearchForSession(sessionId),
      pending: {
        approvals: [...thread.approvals],
        userInputs: [],
      },
      pendingComplete: true,
      readOnly: false,
      readOnlyReason: null,
      viewHealth: isOutageAffected ? { status: "unavailable", reason: "projectionUnavailable" } : null,
    };
  }
  assetUrl(path: string): string {
    return path;
  }
  async updateSession(
    sessionId: string,
    patch: { title?: string; archived?: boolean; settled?: boolean },
  ): Promise<SessionSummary | null> {
    const thread = this.activeThreads.get(sessionId);
    if (!thread) {
      return null;
    }
    const currentIso = iso(Date.now());
    let updated: SessionSummary = { ...thread.summary };

    if (patch.title !== undefined) {
      updated = { ...updated, title: patch.title, titleSource: "user" };
    }
    if (patch.archived !== undefined) {
      updated = { ...updated, archived: patch.archived };
    }
    if (patch.settled !== undefined) {
      updated = patch.settled
        ? { ...updated, settled: true, settledAt: currentIso, unsettledAt: null }
        : { ...updated, settled: false, settledAt: null, unsettledAt: currentIso };
    }

    thread.summary = updated;
    return updated;
  }
  async forkSession(sessionId: string): Promise<SessionSummary> {
    const parentSession = this.activeThreads.get(sessionId);
    if (!parentSession) {
      throw new Error("That thread is not in the demo.");
    }

    this.generatedEntityIndex += 1;
    const forkedSessionId = sampleId(`fork:${sessionId}:${this.generatedEntityIndex}:${Date.now()}`);
    const activeTurn = parentSession.summary.live?.activeTurnId ?? null;

    const carriedEvents = parentSession.events
      .filter((evt) => {
        if (!activeTurn) {
          return true;
        }
        const itemTurnId = (evt.params["item"] as MspItem | undefined)?.turnId;
        return evt.params["turnId"] !== activeTurn && itemTurnId !== activeTurn;
      })
      .map((evt) => ({
        ...evt,
        params: { ...evt.params, sessionId: forkedSessionId },
      }));

    const forkedSummary: SessionSummary = {
      ...parentSession.summary,
      sessionId: forkedSessionId,
      title: `${parentSession.summary.title} (fork)`,
      titleSource: "user",
      createdAt: iso(Date.now()),
      activityAt: iso(Date.now()),
      settled: false,
      settledAt: null,
      unsettledAt: null,
      live: constructIdleState(),
    };

    this.activeThreads.set(forkedSessionId, {
      summary: forkedSummary,
      events: carriedEvents,
      seq: parentSession.seq,
      approvals: [],
      timers: new Set(),
      truncated: false,
    });
    this.dispatchToSubscribers({ type: "sessions-changed" });
    return forkedSummary;
  }
  // ---------------------------------------------------------------- Turns & Playback
  private resolveBranchName(session: SessionContext): string {
    for (let i = session.events.length - 1; i >= 0; i--) {
      const evt = session.events[i];
      if (evt?.method === "session/branchChanged") {
        const branchVal = evt.params["branch"];
        if (typeof branchVal === "string") {
          return branchVal;
        }
      }
    }
    return "main";
  }
  async sendTurn(
    sessionId: string,
    text: string,
    options?: TurnOptions,
  ): Promise<{ turnId: string | null; disposition: string | null; attachments?: AttachmentView[] }> {
    const thread = this.activeThreads.get(sessionId);
    if (!thread) {
      throw new Error("That thread is not in the demo.");
    }

    const visibleText = options?.displayText ?? text;
    const activeTurn = thread.summary.live?.activeTurnId ?? null;
    this.generatedEntityIndex += 1;

    if (activeTurn) {
      if (options?.ifBusy === "steer") {
        this.appendAndStreamEvent(sessionId, "item/completed", {
          item: {
            itemId: sampleId(`steer:${sessionId}:${this.generatedEntityIndex}`),
            kind: "userMessage",
            status: "completed",
            revision: 1,
            text: visibleText,
            steered: true,
            turnId: activeTurn,
            recordedAt: iso(Date.now()),
          },
        });
        return { turnId: activeTurn, disposition: "steered" };
      }
      return {
        turnId: sampleId(`queued:${sessionId}:${this.generatedEntityIndex}`),
        disposition: "queued",
      };
    }
    if (this.scenario === "turn" && sessionId === THREADS.audit) {
      return this.executeBuildWorkflow(sessionId, visibleText);
    }
    const turnId = sampleId(`turn:${sessionId}:${this.generatedEntityIndex}:${Date.now()}`);
    const startEpoch = Date.now();
    let threadSummary: SessionSummary = {
      ...thread.summary,
      turnCount: thread.summary.turnCount + 1,
    };
    if (threadSummary.titleSource === "placeholder") {
      const collapsedTitle = visibleText.replace(/\s+/g, " ").trim();
      const trimmedTitle = collapsedTitle.length > 60 ? `${collapsedTitle.slice(0, 57).trimEnd()}...` : collapsedTitle;
      threadSummary = { ...threadSummary, title: trimmedTitle, titleSource: "auto" };
    }
    thread.summary = threadSummary;
    this.updateSessionLiveState(sessionId, {
      ...constructIdleState(null),
      activeTurnId: turnId,
      turnStartedAt: iso(startEpoch),
    });
    this.dispatchToSubscribers({ type: "sessions-changed" });
    this.deferExecution(sessionId, () => {
      this.appendAndStreamEvent(sessionId, "turn/started", { turnId, commandId: turnId });
      this.appendAndStreamEvent(sessionId, "item/completed", {
        item: {
          itemId: sampleId(`prompt:${turnId}`),
          kind: "userMessage",
          status: "completed",
          revision: 1,
          text: visibleText,
          turnId,
          commandId: turnId,
          recordedAt: iso(Date.now()),
        },
      });
    }, 250);
    const bashToolId = sampleId(`tool:${turnId}`);
    const bashPayload = JSON.stringify({
      command: "git status --short --branch",
      description: "Check the working tree",
    });
    this.deferExecution(sessionId, () => {
      this.appendAndStreamEvent(sessionId, "item/started", {
        item: {
          itemId: bashToolId,
          kind: "toolCall",
          tool: "bash",
          status: "inProgress",
          revision: 1,
          turnId,
          args: bashPayload,
        },
      });
    }, 900);
    this.deferExecution(sessionId, () => {
      this.appendAndStreamEvent(sessionId, "item/completed", {
        item: {
          itemId: bashToolId,
          kind: "toolCall",
          tool: "bash",
          status: "completed",
          revision: 2,
          turnId,
          args: bashPayload,
          visibleOutput: `## ${this.resolveBranchName(thread)}\n`,
          recordedAt: iso(Date.now()),
        },
      });
    }, 1_900);
    const messageReplyId = sampleId(`reply:${turnId}`);
    this.deferExecution(sessionId, () => {
      this.appendAndStreamEvent(sessionId, "item/started", {
        item: {
          itemId: messageReplyId,
          kind: "agentMessage",
          status: "inProgress",
          revision: 1,
          text: "",
          turnId,
        },
      });
    }, 2_400);

    const textTokens = DEMO_STANDARD_REPLY.split(/(?<= )/);
    let chunkTimestamp = 2_500;
    for (let wordIndex = 0; wordIndex < textTokens.length; wordIndex += 3) {
      const fragment = textTokens.slice(wordIndex, wordIndex + 3).join("");
      this.deferExecution(sessionId, () => {
        this.appendAndStreamEvent(sessionId, "item/delta", {
          itemId: messageReplyId,
          field: "text",
          delta: fragment,
          turnId,
        });
      }, chunkTimestamp);
      chunkTimestamp += 70;
    }
    this.deferExecution(sessionId, () => {
      this.appendAndStreamEvent(sessionId, "item/completed", {
        item: {
          itemId: messageReplyId,
          kind: "agentMessage",
          status: "completed",
          revision: 2,
          text: DEMO_STANDARD_REPLY,
          turnId,
          recordedAt: iso(Date.now()),
        },
      });
      this.appendAndStreamEvent(sessionId, "session/tokenUsage", {
        turnId,
        modelId: thread.summary.modelId ?? MODEL,
        durationMs: Date.now() - startEpoch,
        promptTokens: 18_200,
        totalTokens: 18_430,
        usage: {
          inputTokens: 18_200,
          outputTokens: 230,
          cachedTokens: 12_000,
          cacheReadTokens: 12_000,
          cacheWriteTokens: 0,
          reasoningTokens: 20,
        },
        cumulative: { promptTokens: 18_200, outputTokens: 230, totalTokens: 18_430 },
      });
      this.appendAndStreamEvent(sessionId, "session/contextUsage", {
        usedTokens: 18_430,
        windowTokens: 1_000_000,
        pressure: "normal",
      });
      this.appendAndStreamEvent(sessionId, "turn/completed", {
        turnId,
        terminal: "completed",
        durationMs: Date.now() - startEpoch,
        timeToFirstTokenMs: 2_400,
      });
      this.updateSessionLiveState(sessionId, constructIdleState());
    }, chunkTimestamp + 200);
    return { turnId, disposition: "started" };
  }
  private executeBuildWorkflow(
    sessionId: string,
    promptContent: string = BUILD_PROMPT,
  ): { turnId: string | null; disposition: string | null } {
    const thread = this.activeThreads.get(sessionId);
    if (!thread) {
      return { turnId: null, disposition: null };
    }
    const playbackSpeed = Math.max(0.25, Number(new URLSearchParams(window.location.search).get("speed")) || 1);
    const scaleTime = (ms: number) => Math.round(ms / playbackSpeed);
    const startEpoch = Date.now();
    this.generatedEntityIndex += 1;
    const turnId = sampleId(`build:${sessionId}:${this.generatedEntityIndex}:${startEpoch}`);

    const planOption = new URLSearchParams(window.location.search).get("plan");
    const includePlan = planOption === "0" ? false : planOption === "first" ? this.completedBuildCount === 0 : true;
    this.completedBuildCount += 1;
    thread.summary = { ...thread.summary, turnCount: thread.summary.turnCount + 1 };
    this.updateSessionLiveState(sessionId, {
      ...constructIdleState(null),
      activeTurnId: turnId,
      turnStartedAt: iso(startEpoch),
    });
    this.dispatchToSubscribers({ type: "sessions-changed" });
    this.deferExecution(sessionId, () => {
      this.appendAndStreamEvent(sessionId, "turn/started", { turnId, commandId: turnId });
      this.appendAndStreamEvent(sessionId, "item/completed", {
        item: {
          itemId: sampleId(`prompt:${turnId}`),
          kind: "userMessage",
          status: "completed",
          revision: 1,
          text: promptContent,
          turnId,
          commandId: turnId,
          recordedAt: iso(Date.now()),
        },
      });
    }, 120);
    if (includePlan) {
      const renderPlanState = (activeIdx: number) =>
        BUILD_STEPS.map((step, idx) => ({
          text: step.text,
          activeForm: step.active,
          status: idx < activeIdx ? "completed" : idx === activeIdx ? "inProgress" : "pending",
        }));

      BUILD_STEP_AT.forEach((delayMs, stepIdx) => {
        this.deferExecution(sessionId, () => {
          this.appendAndStreamEvent(sessionId, "session/todoListChanged", {
            items: renderPlanState(stepIdx),
            turnId,
          });
        }, scaleTime(delayMs));
      });

      this.deferExecution(sessionId, () => {
        this.appendAndStreamEvent(sessionId, "session/todoListChanged", {
          items: renderPlanState(BUILD_STEPS.length),
          turnId,
        });
      }, scaleTime(BUILD_END_AT - 4_000));
    }

    BUILD_TOOLS.forEach((toolDef, toolIndex) => {
      const toolItemId = sampleId(`build:tool:${turnId}:${toolIndex}`);
      const toolArgsPayload = JSON.stringify(
        toolDef.tool === "bash"
          ? { command: toolDef.subject, ...(toolDef.note ? { description: toolDef.note } : {}) }
          : toolDef.tool === "grep"
            ? { pattern: toolDef.subject, path: "src" }
            : { path: toolDef.subject },
      );
      this.deferExecution(sessionId, () => {
        this.appendAndStreamEvent(sessionId, "item/started", {
          item: {
            itemId: toolItemId,
            kind: "toolCall",
            tool: toolDef.tool,
            status: "inProgress",
            revision: 1,
            turnId,
            args: toolArgsPayload,
          },
        });
      }, scaleTime(toolDef.at));
      this.deferExecution(sessionId, () => {
        const failureMetadata = toolDef.fail ? { failureKind: "tool_error", failureReason: toolDef.fail } : {};
        this.appendAndStreamEvent(sessionId, "item/completed", {
          item: {
            itemId: toolItemId,
            kind: "toolCall",
            tool: toolDef.tool,
            status: toolDef.fail ? "failed" : "completed",
            revision: 2,
            turnId,
            args: toolArgsPayload,
            visibleOutput: toolDef.fail ?? toolDef.output ?? "",
            ...(toolDef.tool === "bash" ? { exitCode: toolDef.fail ? 1 : 0 } : {}),
            ...failureMetadata,
            recordedAt: iso(Date.now()),
          },
        });
      }, scaleTime(toolDef.at + toolDef.ms));
    });
    let cumulativePromptTokens = 0;
    let cumulativeOutputTokens = 0;
    for (let callNum = 1; callNum * 10_000 < BUILD_END_AT - 5_000; callNum += 1) {
      this.deferExecution(sessionId, () => {
        const promptTokens = 80_000 + callNum * 6_500;
        const outputTokens = 620 + callNum * 40;
        cumulativePromptTokens += promptTokens;
        cumulativeOutputTokens += outputTokens;
        this.appendAndStreamEvent(sessionId, "session/tokenUsage", {
          turnId,
          modelId: thread.summary.modelId ?? MODEL,
          durationMs: 2_400 + callNum * 90,
          promptTokens,
          totalTokens: promptTokens + outputTokens,
          usage: {
            inputTokens: promptTokens,
            outputTokens,
            cachedTokens: Math.round(promptTokens * 0.8),
            cacheReadTokens: Math.round(promptTokens * 0.8),
            cacheWriteTokens: 0,
            reasoningTokens: Math.round(outputTokens * 0.2),
          },
          cumulative: {
            promptTokens: cumulativePromptTokens,
            outputTokens: cumulativeOutputTokens,
            totalTokens: cumulativePromptTokens + cumulativeOutputTokens,
          },
        });
      }, scaleTime(callNum * 10_000));
    }
    const replyMsgId = sampleId(`reply:${turnId}`);
    const replyStartTime = BUILD_END_AT - 3_000;
    this.deferExecution(sessionId, () => {
      this.appendAndStreamEvent(sessionId, "item/started", {
        item: {
          itemId: replyMsgId,
          kind: "agentMessage",
          status: "inProgress",
          revision: 1,
          text: "",
          turnId,
        },
      });
    }, scaleTime(replyStartTime));

    const replyTokens = BUILD_REPLY.split(/(?<= )/);
    for (let wordIdx = 0; wordIdx < replyTokens.length; wordIdx += 3) {
      const textChunk = replyTokens.slice(wordIdx, wordIdx + 3).join("");
      this.deferExecution(sessionId, () => {
        this.appendAndStreamEvent(sessionId, "item/delta", {
          itemId: replyMsgId,
          field: "text",
          delta: textChunk,
          turnId,
        });
      }, scaleTime(replyStartTime + 100 + (wordIdx / 3) * 90));
    }

    this.deferExecution(sessionId, () => {
      this.appendAndStreamEvent(sessionId, "item/completed", {
        item: {
          itemId: replyMsgId,
          kind: "agentMessage",
          status: "completed",
          revision: 2,
          text: BUILD_REPLY,
          turnId,
          recordedAt: iso(Date.now()),
        },
      });
      this.appendAndStreamEvent(sessionId, "turn/completed", {
        turnId,
        terminal: "completed",
        durationMs: Date.now() - startEpoch,
        timeToFirstTokenMs: 1_900,
      });
      this.updateSessionLiveState(sessionId, constructIdleState());
    }, scaleTime(BUILD_END_AT));
    return { turnId, disposition: "started" };
  }
  async interruptTurn(sessionId: string, turnId?: string): Promise<void> {
    const thread = this.activeThreads.get(sessionId);
    const targetTurn = turnId ?? thread?.summary.live?.activeTurnId ?? null;
    if (!thread || !targetTurn) {
      return;
    }
    this.abortSessionTimers(sessionId);
    if (this.activeAuditRun && sessionId === this.activeAuditRun.sessionId && this.activeAuditRun.status === "inProgress") {
      this.cancelAuditWorkflow();
    }
    for (const pendingApproval of thread.approvals.splice(0)) {
      this.appendAndStreamEvent(sessionId, "approval/resolved", {
        approvalId: pendingApproval.approvalId,
        decision: "cancelled",
        resolvedBy: "system",
      });
      const associatedItem = pendingApproval.itemId ? this.locateLatestItem(thread, pendingApproval.itemId) : null;
      if (associatedItem && associatedItem.background !== true) {
        this.appendAndStreamEvent(sessionId, "item/completed", {
          item: {
            ...associatedItem,
            status: "cancelled",
            revision: associatedItem.revision + 1,
            recordedAt: iso(Date.now()),
          },
        });
      }
    }

    const elapsedMs = Date.now() - Date.parse(thread.summary.live?.turnStartedAt ?? iso(Date.now()));
    this.appendAndStreamEvent(sessionId, "turn/completed", {
      turnId: targetTurn,
      terminal: "interrupted",
      durationMs: elapsedMs,
    });
    this.updateSessionLiveState(sessionId, constructIdleState("interrupted"));
  }
  async unqueueTurn(sessionId: string, turnId: string): Promise<void> {
    this.appendAndStreamEvent(sessionId, "turn/unqueued", { turnId });
  }
  async decideApproval(input: ApprovalDecisionInput): Promise<void> {
    const thread = this.activeThreads.get(input.sessionId);
    const targetReq = thread?.approvals.find((a) => a.approvalId === input.approvalId);
    if (!thread || !targetReq) {
      return;
    }

    thread.approvals = thread.approvals.filter((a) => a !== targetReq);
    const selectedOption = targetReq.availableChoices.find((c) => c.choiceId === input.choiceId);
    const wasApproved = selectedOption?.decision === "approved";
    const associatedTurnId = targetReq.turnId ?? thread.summary.live?.activeTurnId ?? null;

    this.appendAndStreamEvent(input.sessionId, "approval/resolved", {
      approvalId: targetReq.approvalId,
      decision: wasApproved ? "approved" : "denied",
      resolvedBy: "user",
    });
    this.updateSessionLiveState(input.sessionId, {
      ...(thread.summary.live ?? constructIdleState(null)),
      activeTurnId: associatedTurnId,
      turnStartedAt: thread.summary.live?.turnStartedAt ?? iso(Date.now()),
      pendingApprovals: thread.approvals.length,
    });

    this.settleDecidedApproval(thread, targetReq, wasApproved, associatedTurnId);
  }
  private settleDecidedApproval(
    thread: SessionContext,
    req: ApprovalRequest,
    isApproved: boolean,
    turnId: string | null,
  ): void {
    const sId = thread.summary.sessionId;
    const taskItem = req.itemId ? this.locateLatestItem(thread, req.itemId) : null;
    if (!taskItem) {
      return;
    }

    if (taskItem.background === true) {
      if (!isApproved) {
        this.deferExecution(sId, () => {
          this.finalizeTaskExecution(thread, taskItem, {
            status: "failed",
            failureKind: "permission_denied",
            failureReason: `Network access to ${req.subject.host ?? "the host"} was refused.`,
          });
        }, 600);
      }
      return;
    }

    if (sId !== THREADS.contrast) {
      this.deferExecution(sId, () => {
        this.appendAndStreamEvent(sId, "item/completed", {
          item: {
            ...taskItem,
            status: isApproved ? "completed" : "rejected",
            revision: taskItem.revision + 1,
            recordedAt: iso(Date.now()),
            ...(isApproved
              ? {
                  visibleOutput:
                    "\n> atlas-api@2.0.0-rc.1 test\n> vitest run test/sdk-compat.test.ts\n\n ✓ test/sdk-compat.test.ts (6 tests) 412ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)\n",
                }
              : {}),
          },
        });
      }, isApproved ? 2_600 : 600);
      return;
    }

    this.deferExecution(sId, () => {
      this.appendAndStreamEvent(sId, "item/completed", {
        item: {
          ...taskItem,
          status: isApproved ? "completed" : "rejected",
          revision: taskItem.revision + 1,
          recordedAt: iso(Date.now()),
          ...(isApproved
            ? {
                visibleOutput:
                  "\nRunning 4 tests using 2 workers\n\n  ✓  1 settings-dialog.spec.ts:8:3 › light theme (1.2s)\n  ✓  2 settings-dialog.spec.ts:14:3 › dark theme (1.4s)\n  ✓  3 settings-dialog.spec.ts:20:3 › light theme at 200% zoom (1.6s)\n  ✓  4 settings-dialog.spec.ts:27:3 › dark theme at 200% zoom (1.5s)\n\n  4 passed (4.8s)\n",
              }
            : {}),
        },
      });
    }, isApproved ? 2_600 : 600);

    const replyString = isApproved
      ? "Muted text in dark mode is now `#a1a8b3`, 7.7:1 on the dialog's surface (it was 3.8:1), set in [src/styles/tokens.css](src/styles/tokens.css). The two dark-theme snapshots were rewritten and the two light ones came out identical, so the light theme is untouched. The same token also lifts the sidebar's muted labels, which had the same problem."
      : "I left the snapshots alone. The token change is in [src/styles/tokens.css](src/styles/tokens.css); run `npx playwright test settings-dialog --update-snapshots` when you want the dark-theme screenshots refreshed.";

    this.deferExecution(sId, () => {
      this.appendAndStreamEvent(sId, "item/completed", {
        item: {
          itemId: sampleId(`reply:${req.approvalId}`),
          kind: "agentMessage",
          status: "completed",
          revision: 1,
          text: replyString,
          turnId,
          recordedAt: iso(Date.now()),
        },
      });
      if (turnId) {
        const turnStart = Date.parse(thread.summary.live?.turnStartedAt ?? iso(Date.now()));
        this.appendAndStreamEvent(sId, "turn/completed", {
          turnId,
          terminal: "completed",
          durationMs: Date.now() - turnStart,
          timeToFirstTokenMs: 1_500,
        });
      }
      this.updateSessionLiveState(sId, constructIdleState());
    }, isApproved ? 4_200 : 1_800);
  }
  async answerUserInput(): Promise<void> {}
  async cancelUserInput(): Promise<void> {}
  async clarifyUserInput(): Promise<void> {}
  // ---------------------------------------------------------------- Workflows & Multi-Agent
  private cancelAuditWorkflow(): void {
    const run = this.activeAuditRun;
    if (!run || run.status !== "inProgress") {
      return;
    }
    const epochNow = Date.now();
    for (const childNode of run.children) {
      const activeAttempt = getLatestAttempt(childNode);
      if (activeAttempt && activeAttempt.endedAt === undefined) {
        activeAttempt.endedAt = epochNow;
        activeAttempt.terminal = "cancelled";
      }
    }
    run.status = "cancelled";
    run.endedAt = epochNow;
    this.broadcastAuditRevision();
  }
  async workflow(
    sessionId: string,
    action: WorkflowAction,
    workflowRunId: string,
    child?: { childId: string; attempt: number },
  ): Promise<void> {
    const run = this.activeAuditRun;
    if (!run || sessionId !== run.sessionId || workflowRunId !== run.runId || run.status !== "inProgress") {
      throw new Error("That workflow is not running.");
    }

    if (action === "cancel") {
      this.cancelAuditWorkflow();
      const runTurnId = run.turnId;
      this.deferExecution(sessionId, () => {
        this.appendAndStreamEvent(sessionId, "item/completed", {
          item: {
            itemId: sampleId(`reply:cancel:${run.runId}`),
            kind: "agentMessage",
            status: "completed",
            revision: 1,
            text: run.stoppedReply,
            turnId: runTurnId,
            recordedAt: iso(Date.now()),
          },
        });
        const turnStartEpoch = Date.parse(
          this.activeThreads.get(sessionId)?.summary.live?.turnStartedAt ?? iso(Date.now()),
        );
        this.appendAndStreamEvent(sessionId, "turn/completed", {
          turnId: runTurnId,
          terminal: "completed",
          durationMs: Date.now() - turnStartEpoch,
          timeToFirstTokenMs: 1_600,
        });
        this.updateSessionLiveState(sessionId, constructIdleState());
      }, 1_600);
      return;
    }

    const matchedChild = run.children.find((entry) => entry.childId === child?.childId);
    const latestAttempt = matchedChild ? getLatestAttempt(matchedChild) : undefined;
    if (!matchedChild || !latestAttempt || !child) {
      throw new Error("That agent is not part of this run.");
    }

    if (latestAttempt.attempt !== child.attempt) {
      throw new AncillaError("That attempt already moved on.", 409, "stale_attempt");
    }

    const actionEpoch = Date.now();
    if (action === "skip") {
      if (latestAttempt.endedAt !== undefined) {
        throw new AncillaError("That attempt already ended.", 409, "stale_attempt");
      }
      latestAttempt.endedAt = actionEpoch;
      latestAttempt.terminal = "cancelled";
      this.broadcastAuditRevision();
      return;
    }

    if (latestAttempt.endedAt === undefined) {
      throw new Error("That agent is still running.");
    }

    const retriedAttempt: AuditAttempt = {
      attempt: latestAttempt.attempt + 1,
      scheduledAt: actionEpoch,
    };
    matchedChild.attempts.push(retriedAttempt);
    this.broadcastAuditRevision();

    this.deferExecution(sessionId, () => {
      retriedAttempt.startedAt = Date.now();
      this.broadcastAuditRevision();
    }, 1_800);

    this.deferExecution(sessionId, () => {
      retriedAttempt.usageAt = Date.now();
      retriedAttempt.usage = tokensOf(118_000);
      this.broadcastAuditRevision();
    }, 46_000);

    this.deferExecution(sessionId, () => {
      const completionEpoch = Date.now();
      retriedAttempt.endedAt = completionEpoch;
      retriedAttempt.terminal = "completed";
      retriedAttempt.durationMs = completionEpoch - (retriedAttempt.startedAt ?? completionEpoch);
      this.broadcastAuditRevision();
    }, 48_000);
  }
  async subagent(): Promise<void> {}
  async task(sessionId: string, action: TaskAction, taskId?: string): Promise<void> {
    const thread = this.activeThreads.get(sessionId);
    if (!thread) {
      throw new Error("That thread is not in the demo.");
    }

    if (action === "stopAll") {
      for (const runningItem of this.queryActiveBackgroundTasks(thread)) {
        this.finalizeTaskExecution(thread, runningItem, { status: "cancelled" });
      }
      return;
    }

    const taskItem = taskId ? this.locateLatestItem(thread, taskId) : null;
    if (!taskItem || taskItem.status !== "inProgress") {
      throw new Error("That task is not running.");
    }

    if (action === "stop") {
      this.finalizeTaskExecution(thread, taskItem, { status: "cancelled" });
      return;
    }

    if (taskItem.background !== true) {
      this.appendAndStreamEvent(sessionId, "item/updated", {
        item: {
          ...taskItem,
          revision: taskItem.revision + 1,
          background: true,
          backgroundInitiator: "user",
          visibleOutput: this.assembleItemOutput(thread, taskItem.itemId),
          recordedAt: iso(Date.now()),
        },
      });
    }
  }
  finishAudit(): void {
    const run = this.activeAuditRun;
    if (!run || run.status !== "inProgress") {
      return;
    }
    const sessionId = run.sessionId;

    const retrieveLivingAttempts = () =>
      run.children
        .map(getLatestAttempt)
        .filter((a): a is AuditAttempt => a !== undefined && a.endedAt === undefined);

    const landAttempts = (targets: AuditAttempt[], epoch: number) => {
      for (const a of targets) {
        a.endedAt = epoch;
        a.terminal = "completed";
        a.durationMs = epoch - (a.startedAt ?? epoch);
      }
    };

    let cumulativeDelay = 0;
    const scheduleStep = (delayOffset: number, actionFn: () => void) => {
      cumulativeDelay += delayOffset;
      this.deferExecution(sessionId, actionFn, cumulativeDelay);
    };

    scheduleStep(0, () => {
      const nowEpoch = Date.now();
      for (const c of run.children) {
        const attempt = getLatestAttempt(c);
        if (!attempt || attempt.endedAt !== undefined) {
          continue;
        }
        attempt.startedAt ??= nowEpoch;
        if (attempt.usageAt === undefined) {
          attempt.usageAt = nowEpoch;
          attempt.usage = tokensOf(COMPLETION_AGENT_TOKENS[c.label] ?? 24_000);
        }
      }
      this.broadcastAuditRevision();
    });

    scheduleStep(900, () => {
      landAttempts(retrieveLivingAttempts(), Date.now());
      this.broadcastAuditRevision();
    });

    const unstartedAgents = run.plan.filter((planned) => !run.children.some((c) => c.label === planned.label));
    if (unstartedAgents.length > 0) {
      const addedChildren: AuditChild[] = [];

      scheduleStep(900, () => {
        const spawnEpoch = Date.now();
        for (const p of unstartedAgents) {
          const freshChild: AuditChild = {
            childId: childIdFor(sessionId, p.label, spawnEpoch),
            label: p.label,
            toolCalls: 9,
            attempts: [{ attempt: 1, scheduledAt: spawnEpoch }],
          };
          addedChildren.push(freshChild);
          run.children.push(freshChild);
        }
        this.broadcastAuditRevision();
      });

      scheduleStep(800, () => {
        for (const child of addedChildren) {
          (getLatestAttempt(child) as AuditAttempt).startedAt = Date.now();
        }
        this.broadcastAuditRevision();
      });

      scheduleStep(1_200, () => {
        for (const child of addedChildren) {
          const att = getLatestAttempt(child) as AuditAttempt;
          att.usageAt = Date.now();
          att.usage = tokensOf(COMPLETION_AGENT_TOKENS[child.label] ?? 24_000);
        }
        this.broadcastAuditRevision();
      });

      scheduleStep(800, () => {
        landAttempts(
          addedChildren.map((c) => getLatestAttempt(c) as AuditAttempt),
          Date.now(),
        );
        this.broadcastAuditRevision();
      });
    }

    scheduleStep(600, () => {
      const endEpoch = Date.now();
      run.status = "completed";
      run.endedAt = endEpoch;
      run.summary = run.report;
      this.broadcastAuditRevision();

      const thread = this.activeThreads.get(sessionId);
      if (thread?.events.some((e) => e.method === "session/todoListChanged")) {
        this.appendAndStreamEvent(sessionId, "session/todoListChanged", {
          items: [
            { text: "Scope the diff since v1.9.0", status: "completed" },
            { text: "Audit routes, schema, SDK and migrations in parallel", status: "completed" },
            { text: "Merge the findings into release-note wording", status: "completed" },
          ],
        });
      }

      this.appendAndStreamEvent(sessionId, "item/completed", {
        item: {
          itemId: sampleId(`reply:${run.runId}`),
          kind: "agentMessage",
          status: "completed",
          revision: 1,
          text: run.report,
          turnId: run.turnId,
          recordedAt: iso(endEpoch),
        },
      });
      for (const orphanReq of thread?.approvals.splice(0) ?? []) {
        this.appendAndStreamEvent(sessionId, "approval/resolved", {
          approvalId: orphanReq.approvalId,
          decision: "cancelled",
          resolvedBy: "system",
        });
        const orphanItem = thread && orphanReq.itemId ? this.locateLatestItem(thread, orphanReq.itemId) : null;
        if (orphanItem && orphanItem.background !== true) {
          this.appendAndStreamEvent(sessionId, "item/completed", {
            item: {
              ...orphanItem,
              status: "cancelled",
              revision: orphanItem.revision + 1,
              recordedAt: iso(endEpoch),
            },
          });
        }
      }

      const turnStartEpoch = Date.parse(thread?.summary.live?.turnStartedAt ?? iso(endEpoch));
      this.appendAndStreamEvent(sessionId, "turn/completed", {
        turnId: run.turnId,
        terminal: "completed",
        durationMs: endEpoch - turnStartEpoch,
        timeToFirstTokenMs: 1_600,
      });
      this.updateSessionLiveState(sessionId, constructIdleState());
    });
  }
  // ---------------------------------------------------------------- Models & Catalog
  async listModels(): Promise<ModelOption[]> {
    const catalog = await this.listModelCatalog();
    return catalog.models;
  }
  async listModelCatalog(): Promise<ModelCatalog> {
    return parseModelCatalog({
      models: {
        source: "providerCatalog",
        providerId: "meta",
        profileId: "tbh",
        models: [
          {
            modelId: "muse-wonder-1.0",
            displayLabel: "Muse Wonder",
            description: "Muse's largest model, for hard problems.",
            isDefault: false,
            isActive: false,
            contextLimit: 1_048_576,
            outputLimit: 128_000,
            cost: null,
            variants: ["minimal", "low", "medium", "high", "xhigh", "max"],
          },
          {
            modelId: MODEL,
            displayLabel: "Muse Spark 1.3",
            description: "Muse's current coding model.",
            isDefault: true,
            isActive: true,
            contextLimit: 1_000_000,
            outputLimit: 64_000,
            variants: ["minimal", "low", "medium", "high", "xhigh", "max"],
          },
          {
            modelId: `${MODEL}-contributor`,
            displayLabel: "Muse Spark 1.3",
            description: "The same model at a lower rate; prompts and outputs may be used for product improvement.",
            isDefault: false,
            isActive: false,
            contextLimit: 1_000_000,
            outputLimit: 64_000,
            variants: ["minimal", "low", "medium", "high", "xhigh", "max"],
          },
          {
            modelId: "muse-spark-1.2",
            displayLabel: "Muse Spark 1.2",
            description: "The previous release.",
            isDefault: false,
            isActive: false,
            contextLimit: 1_000_000,
            outputLimit: 64_000,
            variants: ["minimal", "low", "medium", "high", "xhigh"],
          },
        ],
      },
      hostVersion: "1.4.6",
    });
  }
  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const thread = this.activeThreads.get(sessionId);
    if (thread) {
      thread.summary = { ...thread.summary, modelId };
    }
    this.appendAndStreamEvent(sessionId, "session/modelChanged", { modelId });
  }
  async setApprovalMode(sessionId: string, mode: ApprovalMode): Promise<void> {
    this.appendAndStreamEvent(sessionId, "session/approvalModeChanged", {
      mode,
      source: "approvalReconfigure",
    });
  }
  async setReasoningEffort(): Promise<void> {}
  async compact(sessionId: string): Promise<{ noop: boolean; reason: string | null }> {
    const thread = this.activeThreads.get(sessionId);
    const lastContextUsage = [...(thread?.events ?? [])]
      .reverse()
      .find((e) => e.method === "session/contextUsage")?.params["usedTokens"];
    const tokenCountBefore = typeof lastContextUsage === "number" ? lastContextUsage : 0;

    if (!thread || tokenCountBefore < 20_000) {
      return { noop: true, reason: "no_compactable_history" };
    }

    const tokenCountAfter = Math.round(tokenCountBefore * 0.18);
    this.appendAndStreamEvent(sessionId, "item/completed", {
      item: {
        itemId: sampleId(`compact:${sessionId}:${thread.seq}`),
        kind: "compaction",
        status: "completed",
        revision: 1,
        trigger: "manual",
        outcome: "compacted",
        tokensBefore: tokenCountBefore,
        tokensAfter: tokenCountAfter,
        recordedAt: iso(Date.now()),
      },
    });
    this.appendAndStreamEvent(sessionId, "session/contextUsage", {
      usedTokens: tokenCountAfter,
      windowTokens: 1_000_000,
      pressure: "normal",
    });

    return { noop: false, reason: null };
  }
  // ---------------------------------------------------------------- Deep Research

  async startResearch(
    sessionId: string,
    question: string,
    config: Partial<ResearchConfig> | null,
    commandId: string,
  ): Promise<ResearchRunView> {
    if (!this.activeThreads.has(sessionId)) {
      throw Object.assign(new Error("That thread is not in the demo."), { status: 404 });
    }

    const runId = sampleId(`research:${commandId}`);
    const priorRun = this.activeResearchRuns.get(runId);
    if (priorRun) {
      return this.deriveResearchSummary(priorRun);
    }

    if (this.queryResearchForSession(sessionId).some(researchLive)) {
      throw new AncillaError("This thread already has a research run going.", 409);
    }

    const mergedConfiguration: ResearchConfig = {
      ...this.activeResearchSettings.config,
      ...(config ?? {}),
      models: {
        ...this.activeResearchSettings.config.models,
        ...(config?.models ?? {}),
      },
    };

    const newResearchRun: ResearchRunView = {
      runId,
      sessionId,
      status: "queued",
      phase: "scoping",
      question: question.trim(),
      brief: null,
      round: 0,
      maxRounds: mergedConfiguration.maxRounds,
      createdAt: iso(Date.now()),
      startedAt: null,
      endedAt: null,
      researchDeadlineAt: null,
      workers: [],
      sources: {
        registry: 0,
        verified: 0,
        curated: 0,
        opened: 0,
        searchOnly: 0,
        attempted: 0,
        listedEarlier: 0,
        evidence: 0,
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
      },
      failure: null,
      reportAvailable: false,
      report: null,
      reportPath: null,
      config: mergedConfiguration,
    };

    this.activeResearchRuns.set(runId, newResearchRun);
    this.scheduleNextResearchStep(runId, RESEARCH_PHASE_TIMINGS.queue);
    return this.deriveResearchSummary(newResearchRun);
  }

  async exportResearch(): Promise<never> {
    throw new Error("Report exports are available when Ancilla is connected to a real project.");
  }

  async readResearchExport(): Promise<never> {
    throw new Error("Report exports are available when Ancilla is connected to a real project.");
  }

  async stopResearch(runId: string, writeReport: boolean): Promise<ResearchRunView> {
    const run = this.activeResearchRuns.get(runId);
    if (!run) {
      throw Object.assign(new Error("No such research run."), { status: 404 });
    }
    if (!researchLive(run)) {
      return this.deriveResearchSummary(run);
    }

    this.cancelResearchTimer(runId);
    const stopEpoch = Date.now();
    const finalizedWorkers = run.workers.map((w) =>
      w.state === "working" || w.state === "queued" ? { ...w, state: "cancelled" as const, endedAt: iso(stopEpoch) } : w,
    );
    const hasVerifiedSources = run.sources.verified > 0;

    const stoppedRun: ResearchRunView =
      writeReport && hasVerifiedSources
        ? {
            ...run,
            status: "partial",
            phase: "done",
            endedAt: iso(stopEpoch),
            workers: finalizedWorkers,
            failure: "stopped by you before the window ended",
            reportAvailable: true,
            report: this.generateSyntheticResearchReport(run, true),
            reportPath: `${this.activeThreads.get(run.sessionId)?.summary.cwd ?? HOME}/.ancilla/research/${runId}/report.md`,
          }
        : {
            ...run,
            status: "cancelled",
            phase: "done",
            endedAt: iso(stopEpoch),
            workers: finalizedWorkers,
            failure: writeReport ? "stopped before any worker had a source to cite" : null,
          };

    this.commitResearchRun(stoppedRun);
    return this.deriveResearchSummary(stoppedRun);
  }

  async listResearch(sessionId: string): Promise<ResearchRunView[]> {
    return this.queryResearchForSession(sessionId);
  }

  async getResearch(runId: string): Promise<ResearchRunView> {
    const run = this.activeResearchRuns.get(runId);
    if (!run) {
      throw Object.assign(new Error("No such research run."), { status: 404 });
    }
    return { ...run };
  }

  async assistant<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    return this.assistantController.handle<T>(method, path, body);
  }

  async getResearchSettings(): Promise<ResearchSettings> {
    return {
      enabled: this.activeResearchSettings.enabled,
      config: { ...this.activeResearchSettings.config },
    };
  }

  async setResearchSettings(patch: { enabled?: boolean; config?: Partial<ResearchConfig> }): Promise<ResearchSettings> {
    const prior = this.activeResearchSettings;
    this.activeResearchSettings = {
      enabled: patch.enabled ?? prior.enabled,
      config: {
        ...prior.config,
        ...(patch.config ?? {}),
        models: {
          ...prior.config.models,
          ...(patch.config?.models ?? {}),
        },
      },
    };
    return this.getResearchSettings();
  }

  private queryResearchForSession(sessionId: string): ResearchRunView[] {
    return [...this.activeResearchRuns.values()]
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((r) => this.deriveResearchSummary(r));
  }

  private deriveResearchSummary(run: ResearchRunView): ResearchRunView {
    return { ...run, report: null };
  }

  private commitResearchRun(run: ResearchRunView): void {
    this.activeResearchRuns.set(run.runId, run);
    this.dispatchToSubscribers({
      type: "research-run",
      sessionId: run.sessionId,
      run: this.deriveResearchSummary(run),
    });
  }

  private cancelResearchTimer(runId: string): void {
    const handle = this.scheduledResearchTimers.get(runId);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.scheduledResearchTimers.delete(runId);
    }
  }

  private scheduleNextResearchStep(runId: string, durationMs: number): void {
    this.cancelResearchTimer(runId);
    const handle = setTimeout(() => {
      this.scheduledResearchTimers.delete(runId);
      this.executeResearchStep(runId);
    }, durationMs);
    this.scheduledResearchTimers.set(runId, handle);
  }

  private executeResearchStep(runId: string): void {
    const run = this.activeResearchRuns.get(runId);
    if (!run || !researchLive(run)) {
      return;
    }
    const currentEpoch = Date.now();

    if (run.status === "queued") {
      this.commitResearchRun({
        ...run,
        status: "running",
        phase: "scoping",
        startedAt: iso(currentEpoch),
        researchDeadlineAt: iso(currentEpoch + run.config.windowMaxMinutes * MIN),
      });
      this.scheduleNextResearchStep(runId, RESEARCH_PHASE_TIMINGS.scope);
      return;
    }

    if (run.phase === "scoping" || run.phase === "drafting") {
      this.commitResearchRun({
        ...run,
        phase: "researching",
        brief: `Find out, from sources the workers open themselves, ${run.question.replace(/\?+$/, "").trim()}.`,
        round: 1,
        workers: this.instantiateResearchWorkers(run, 1, currentEpoch),
        usage: this.incrementResearchUsage(run, 6_400, 380),
      });
      this.scheduleNextResearchStep(runId, RESEARCH_PHASE_TIMINGS.tick);
      return;
    }

    if (run.phase === "researching") {
      const activeWorkers = run.workers.filter((w) => w.state === "working");
      if (activeWorkers.length > 0) {
        const leastActive = activeWorkers.reduce((least, w) => (w.toolCalls < least.toolCalls ? w : least));
        this.commitResearchRun(this.advanceWorkerExecution(run, leastActive, currentEpoch));
        this.scheduleNextResearchStep(runId, RESEARCH_PHASE_TIMINGS.tick);
        return;
      }

      const pendingQueued = run.workers.find((w) => w.state === "queued");
      if (pendingQueued) {
        this.commitResearchRun({
          ...run,
          workers: run.workers.map((w) => (w === pendingQueued ? { ...w, state: "working", startedAt: iso(currentEpoch) } : w)),
        });
        this.scheduleNextResearchStep(runId, RESEARCH_PHASE_TIMINGS.tick);
        return;
      }

      if (run.round < SYNTHETIC_RESEARCH_ROUNDS.length && run.round < run.maxRounds) {
        const nextRoundIndex = run.round + 1;
        this.commitResearchRun({
          ...run,
          round: nextRoundIndex,
          workers: [...run.workers, ...this.instantiateResearchWorkers(run, nextRoundIndex, currentEpoch)],
          usage: this.incrementResearchUsage(run, 12_800, 560),
        });
        this.scheduleNextResearchStep(runId, RESEARCH_PHASE_TIMINGS.spawn);
        return;
      }

      this.commitResearchRun({
        ...run,
        phase: "writing",
        usage: this.incrementResearchUsage(run, 14_200, 610),
      });
      this.scheduleNextResearchStep(runId, RESEARCH_PHASE_TIMINGS.write);
      return;
    }

    this.commitResearchRun({
      ...run,
      status: "completed",
      phase: "done",
      endedAt: iso(currentEpoch),
      sources: { ...run.sources, curated: Math.min(run.sources.verified, 4) },
      usage: this.incrementResearchUsage(run, 31_500, 2_900),
      reportAvailable: true,
      report: this.generateSyntheticResearchReport(run, false),
      reportPath: `${this.activeThreads.get(run.sessionId)?.summary.cwd ?? HOME}/.ancilla/research/${runId}/report.md`,
    });
  }

  private instantiateResearchWorkers(run: ResearchRunView, roundNum: number, epoch: number): ResearchWorkerView[] {
    const topicsList = SYNTHETIC_RESEARCH_ROUNDS[Math.min(roundNum, SYNTHETIC_RESEARCH_ROUNDS.length) - 1] ?? [];
    const startingIndex = run.workers.length + 1;
    const allowedParallel = Math.max(1, run.config.maxParallel);

    return topicsList.map((topicText, idx) => ({
      agentId: startingIndex + idx,
      round: roundNum,
      topic: topicText,
      discovery: false,
      state: idx < allowedParallel ? "working" : "queued",
      toolCalls: 0,
      searches: 0,
      reads: 0,
      saved: 0,
      startedAt: iso(epoch),
      endedAt: null,
    }));
  }

  private advanceWorkerExecution(
    run: ResearchRunView,
    worker: ResearchWorkerView,
    epoch: number,
  ): ResearchRunView {
    const searchTarget = Math.min(run.config.workerMaxSearches, 2 + (worker.agentId % 2));
    const readTarget = 2 + (worker.agentId % 3);
    const saveTarget = 1 + (worker.agentId % 2);

    let nextWorkerState: ResearchWorkerView;
    let accumulatedSources = run.sources;

    if (worker.searches < searchTarget) {
      nextWorkerState = { ...worker, searches: worker.searches + 1, toolCalls: worker.toolCalls + 1 };
      accumulatedSources = { ...accumulatedSources, registry: accumulatedSources.registry + 3 };
    } else if (worker.reads < readTarget) {
      nextWorkerState = { ...worker, reads: worker.reads + 1, toolCalls: worker.toolCalls + 1 };
      if (accumulatedSources.verified < accumulatedSources.registry) {
        accumulatedSources = {
          ...accumulatedSources,
          verified: accumulatedSources.verified + 1,
          opened: (accumulatedSources.opened ?? 0) + 1,
          evidence: (accumulatedSources.evidence ?? 0) + 13,
        };
      }
    } else if (worker.saved < saveTarget) {
      nextWorkerState = { ...worker, saved: worker.saved + 1, toolCalls: worker.toolCalls + 1 };
    } else {
      nextWorkerState = { ...worker, state: "completed", endedAt: iso(epoch) };
    }

    const updatedWorkerList = run.workers.map((w) => (w === worker ? nextWorkerState : w));
    const activeCount = updatedWorkerList.filter((w) => w.state === "working").length;
    const nextQueuedWorker =
      activeCount < run.config.maxParallel ? updatedWorkerList.find((w) => w.state === "queued") : undefined;

    const finalWorkers = nextQueuedWorker
      ? updatedWorkerList.map((w) => (w === nextQueuedWorker ? { ...w, state: "working" as const, startedAt: iso(epoch) } : w))
      : updatedWorkerList;

    return {
      ...run,
      workers: finalWorkers,
      sources: accumulatedSources,
      usage: this.incrementResearchUsage(run, 4_700, 210),
    };
  }

  private incrementResearchUsage(
    run: ResearchRunView,
    inputDelta: number,
    outputDelta: number,
  ): ResearchRunView["usage"] {
    const cachedTokens = Math.round(inputDelta * 0.45);
    return {
      inputTokens: run.usage.inputTokens + inputDelta,
      outputTokens: run.usage.outputTokens + outputDelta,
      cachedInputTokens: run.usage.cachedInputTokens + cachedTokens,
      totalTokens: run.usage.totalTokens + inputDelta + outputDelta,
    };
  }

  private generateSyntheticResearchReport(run: ResearchRunView, isPartial: boolean): string {
    const completedWorkersCount = run.workers.filter((w) => w.state === "completed").length;
    const openingParagraph = isPartial
      ? `The run was stopped after ${completedWorkersCount} of ${run.workers.length} workers had reported, so this is written from what they had.`
      : `This is Ancilla's demo mode, so no worker searched anything and no model was called. In your own project this is where the report goes: the writer's answer, with a numbered citation on every claim.`;

    return [
      isPartial ? "# What the workers had found" : "# What the workers found",
      "",
      openingParagraph,
      "",
      "## What a real report looks like",
      "",
      `Each claim carries a marker like this one [^1], and the marker points at a page one of the workers opened or found in its search results, never at something the model remembered. Ancilla checks where a source came from, not that it supports the claim. The supervisor sent ${run.workers.length} workers over ${run.round} ${run.round === 1 ? "round" : "rounds"}; ${run.sources.verified} of the ${run.sources.registry} pages they turned up could be cited, and the writer cites only those [^2].`,
      "",
      "Muse ran every search and every read here on your plan, so the tokens above are the run's real cost and appear on the Usage page under this thread.",
      "",
      "## Sources",
      "",
      "[^1]: [Ancilla demo mode](https://example.com/ancilla-demo)",
      "[^2]: [How deep research cites its sources](https://example.com/ancilla-demo/citations)",
      "",
    ].join("\n");
  }

  // ---------------------------------------------------------------- Shell Execution

  async runShell(sessionId: string, command: string): Promise<void> {
    this.generatedEntityIndex += 1;
    this.appendAndStreamEvent(sessionId, "item/completed", {
      item: {
        kind: "userShell",
        itemId: sampleId(`shell:${sessionId}:${this.generatedEntityIndex}`),
        revision: 1,
        status: "completed",
        commandText: command,
        exitCode: 0,
        visibleOutput: "Shell execution is simulated in demo mode. Run against a local project server to execute live commands.\n",
        recordedAt: iso(Date.now()),
        durationMs: 12,
      },
    });
  }
  async runShellProxy(sessionId: string, command: string): Promise<ShellRun> {
    this.generatedEntityIndex += 1;
    return {
      id: sampleId(`run:${sessionId}:${this.generatedEntityIndex}`),
      sessionId,
      command,
      output: "Shell execution is simulated in demo mode. Run against a local project server to execute live commands.\n",
      exitCode: 0,
      durationMs: 12,
      truncated: false,
      at: iso(Date.now()),
    };
  }
  async goal(sessionId: string, action: GoalAction, objective?: string): Promise<{ turnId: string | null }> {
    const thread = this.activeThreads.get(sessionId);
    const existingGoal = [...(thread?.events ?? [])]
      .reverse()
      .find((e) => e.method === "session/goalChanged")?.params["goal"] as
      | { objective: string; status: string; percentComplete: number }
      | null
      | undefined;

    if (action === "clear") {
      this.appendAndStreamEvent(sessionId, "session/goalChanged", { goal: null });
      return { turnId: null };
    }

    const targetObjective = objective ?? existingGoal?.objective;
    if (!targetObjective) {
      throw new Error("There is no goal in this thread yet.");
    }

    this.appendAndStreamEvent(sessionId, "session/goalChanged", {
      goal: {
        objective: targetObjective,
        status: action === "pause" ? "paused" : "active",
        percentComplete: action === "set" ? 0 : (existingGoal?.percentComplete ?? 0),
      },
    });
    return { turnId: null };
  }
  async readOutput(): Promise<OutputRange> {
    return {
      content: "",
      encoding: "utf8",
      mediaType: "text/plain",
      offsetBytes: 0,
      byteLen: 0,
      eof: true,
    };
  }
  // ---------------------------------------------------------------- Skills
  async listSkills(): Promise<SkillCatalog> {
    return {
      error: null,
      skills: [
        {
          id: "review",
          name: "review",
          displayName: "Review",
          shortDescription: "Inspect working-tree changes",
          description: "Inspect uncommitted changes for regressions, edge cases, missing assertions, and naming clarity.",
          scope: "user",
          activation: "on",
        },
        {
          id: "release-notes",
          name: "release-notes",
          displayName: "Release notes",
          shortDescription: "Summarize changes since the last release tag",
          description: "Compile changelog highlights from commits since the prior version tag into categorized release sections.",
          argumentHint: "[tag]",
          scope: "project",
          activation: "user-invocable-only",
        },
        {
          id: "migration-check",
          name: "migration-check",
          displayName: "Migration check",
          shortDescription: "Audit SQL migrations before applying",
          description: "Scan schema migrations for table locks, destructive alterations, and non-reversible DDL steps.",
          scope: "project",
          activation: "on",
        },
      ],
    };
  }
  async skillBody(_cwd: string, skillId: string): Promise<string> {
    return `# ${skillId}\n\nSample instructions for the demo's \`${skillId}\` skill.\n`;
  }
  // ---------------------------------------------------------------- Settings
  async getTitleSettings(): Promise<TitleSettings> {
    return { ...this.activeTitleSettings };
  }
  async setTitleSettings(patch: { enabled?: boolean; modelId?: string | null }): Promise<TitleSettings> {
    this.activeTitleSettings = {
      enabled: patch.enabled ?? this.activeTitleSettings.enabled,
      modelId: patch.modelId !== undefined ? patch.modelId : this.activeTitleSettings.modelId,
    };
    return { ...this.activeTitleSettings };
  }
  async getSandboxSettings(): Promise<SandboxSettings> {
    return { ...this.activeSandboxSettings };
  }
  async setSandboxSettings(patch: { disabled?: boolean }): Promise<SandboxSettings> {
    this.activeSandboxSettings = { disabled: patch.disabled ?? this.activeSandboxSettings.disabled };
    return { ...this.activeSandboxSettings };
  }
  async getYoloSettings(): Promise<YoloSettings> {
    return { ...this.activeYoloSettings };
  }
  async setYoloSettings(patch: { enabled?: boolean }): Promise<YoloSettings> {
    this.activeYoloSettings = { enabled: patch.enabled ?? this.activeYoloSettings.enabled };
    return { ...this.activeYoloSettings };
  }
  // ---------------------------------------------------------------- Accounts
  async listAccounts(): Promise<AccountView[]> {
    return this.registeredAccounts.map((acc) => ({ ...acc }));
  }

  async createAccount(
    id: string,
    options?: { name?: string; seedFromDefault?: boolean },
  ): Promise<{ id: string; name: string }> {
    const sanitizedId = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    if (this.registeredAccounts.some((acc) => acc.id === sanitizedId)) {
      throw new Error(`There is already an account called ${sanitizedId}.`);
    }
    const accountName = options?.name?.trim() || sanitizedId;
    this.registeredAccounts.push({
      id: sanitizedId,
      name: accountName,
      hasLogin: false,
      email: null,
      lastUsedAt: null,
    });
    return { id: sanitizedId, name: accountName };
  }
  async renameAccount(id: string, name: string): Promise<void> {
    this.registeredAccounts = this.registeredAccounts.map((acc) => (acc.id === id ? { ...acc, name } : acc));
  }
  async removeAccount(id: string): Promise<void> {
    this.registeredAccounts = this.registeredAccounts.filter((acc) => acc.id !== id);
  }
  async setProjectDefaultAccount(cwd: string, accountId: string | null): Promise<void> {
    this.registeredProjects = this.registeredProjects.map((p) =>
      p.cwd === cwd ? { ...p, defaultAccountId: accountId } : p,
    );
  }
  async accountsHealth(): Promise<{ metaApiKeyInherited: boolean }> {
    return { metaApiKeyInherited: false };
  }
  async loginAccount(): Promise<{ url: string; code: string | null } | { fallback: string }> {
    return { fallback: "Signing in is off in the demo. In Ancilla this shows a device code to enter on the sign-in page." };
  }
  // ---------------------------------------------------------------- Usage & Metering
  async usage(days?: number): Promise<UsageReport> {
    const windowSpan = Math.min(365, Math.max(1, Math.round(days ?? 30)));
    const epochNow = this.baselineTimestamp;
    const usageBuckets: UsageBucket[] = [];

    for (let offset = windowSpan - 1; offset >= 0; offset--) {
      const bucketTime = epochNow - offset * DAY;
      const dayIdentifier = iso(bucketTime).slice(0, 10);
      const dayOfWeek = new Date(bucketTime).getUTCDay();
      const isWeekendDay = dayOfWeek === 0 || dayOfWeek === 6;
      const sinusoidalWave = 0.55 + 0.45 * Math.sin((offset / Math.max(1, windowSpan - 1)) * Math.PI * 3.2 + 1.1);
      const callCount = Math.round((isWeekendDay ? 12 : 46) * sinusoidalWave + 5);

      usageBuckets.push({
        day: dayIdentifier,
        modelId: MODEL,
        calls: callCount,
        promptTokens: callCount * 23_400,
        outputTokens: callCount * 710,
        cachedTokens: callCount * 16_800,
        cacheReadTokens: callCount * 16_800,
        cacheWriteTokens: callCount * 900,
        reasoningTokens: callCount * 140,
        durationMs: callCount * 5_600,
      });

      const titleCalls = Math.max(1, Math.round(callCount / 9));
      usageBuckets.push({
        day: dayIdentifier,
        modelId: `${MODEL}-contributor`,
        calls: titleCalls,
        promptTokens: titleCalls * 1_900,
        outputTokens: titleCalls * 24,
        cachedTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        durationMs: titleCalls * 700,
      });

      if (offset < 14) {
        const complexCalls = Math.max(1, Math.round(callCount / 7));
        usageBuckets.push({
          day: dayIdentifier,
          modelId: "muse-wonder-1.0",
          calls: complexCalls,
          promptTokens: complexCalls * 31_000,
          outputTokens: complexCalls * 1_650,
          cachedTokens: complexCalls * 22_000,
          cacheReadTokens: complexCalls * 22_000,
          cacheWriteTokens: complexCalls * 1_400,
          reasoningTokens: complexCalls * 600,
          durationMs: complexCalls * 11_000,
        });
      }
    }

    const windowStartEpoch = epochNow - (windowSpan - 1) * DAY;
    const threadDistributionWeights = [46, 18, 12, 31, 14, 9, 11, 6];
    const threadUsages: UsageThread[] = [...this.activeThreads.values()]
      .map((t) => t.summary)
      .filter((s) => Date.parse(s.activityAt) >= windowStartEpoch - DAY)
      .map((s, idx) => {
        const estimatedCalls = Math.max(1, Math.round((threadDistributionWeights[idx] ?? 5) * Math.min(1, windowSpan / 7 + 0.4)));
        const promptTokens = estimatedCalls * 24_800;
        const outputTokens = estimatedCalls * 760;
        const cachedTokens = estimatedCalls * 17_300;
        return {
          sessionId: s.sessionId,
          title: s.title,
          cwd: s.cwd,
          calls: estimatedCalls,
          promptTokens,
          outputTokens,
          cachedTokens,
          modelIds: [s.modelId ?? MODEL],
          models: [{ modelId: s.modelId ?? MODEL, calls: estimatedCalls, promptTokens, outputTokens, cachedTokens }],
          lastAt: s.activityAt,
        };
      });
    return {
      since: iso(windowStartEpoch),
      days: windowSpan,
      buckets: usageBuckets,
      threads: threadUsages,
    };
  }
  async planUsage(): Promise<{ usage: PlanUsage | null; byAccount: PlanUsageByAccount }> {
    const epochNow = this.baselineTimestamp;
    return {
      usage: {
        tier: "2",
        observedAtMs: epochNow - 2 * MIN,
        window: {
          usedPercent: 38,
          resetsAtMs: epochNow + 2 * HOUR + 17 * MIN,
          windowDurationMins: 300,
        },
        weekly: {
          usedPercent: 21,
          resetsAtMs: epochNow + 3 * DAY + 5 * HOUR,
          windowDurationMins: null,
        },
      },
      byAccount: {
        [SIDE_ACCOUNT]: {
          tier: "2",
          observedAtMs: epochNow - 3 * HOUR - 10 * MIN,
          window: {
            usedPercent: 12,
            resetsAtMs: epochNow + 1 * HOUR + 48 * MIN,
            windowDurationMins: 300,
          },
          weekly: {
            usedPercent: 9,
            resetsAtMs: epochNow + 5 * DAY + 2 * HOUR,
            windowDurationMins: null,
          },
        },
      },
    };
  }
  // ---------------------------------------------------------------- Virtual Files
  async listFiles(cwd: string, path: string): Promise<FileListing> {
    return this.virtualFileSystem.list(cwd, path);
  }
  async readFile(cwd: string, path: string): Promise<FileContent> {
    return this.virtualFileSystem.read(cwd, path);
  }
  async writeFile(cwd: string, path: string, content: string): Promise<{ path: string; size: number; mtimeMs: number }> {
    return this.virtualFileSystem.write(cwd, path, content);
  }
  async searchFiles(cwd: string, query: string): Promise<FileEntry[]> {
    return this.virtualFileSystem.search(cwd, query);
  }
  async openFileExternally(): Promise<void> {
    throw new Error("Opening files in other apps is off in the demo.");
  }
  fileUrl(): string {
    return "";
  }
}
