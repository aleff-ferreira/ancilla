import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AncillaError, type EventHandler, type AncillaClient } from "../src/client.js";
import { AncillaController, staleThreadReason, type Platform } from "../src/model/controller.js";
import { buildTurns } from "../src/model/fold.js";
import { DEFAULT_CREW_WIDTH, ZOOM_MAX, ZOOM_MIN, defaultPrefs, revivePrefs } from "../src/model/store.js";
import { crewView } from "../src/model/crew.js";
import type { AncillaEvent, SessionSummary, SkillEntry, TranscriptLoad, UserInputRequest, ViewEvent, ResearchConfig, ResearchExport, ResearchExportFormat, ResearchRunView, ResearchSettings } from "../src/types.js";
import { historyEvents } from "./fixtures/probe.js";
import { fakeResearchRun, runningResearch } from "./fixtures/research.js";
import type { LinuxSetupView, LinuxDesktopStatus } from "../src/types.js";

const SESSION: SessionSummary = {
  sessionId: "s1",
  cwd: "/work/app",
  title: "Probe",
  titleSource: "auto",
  turnCount: 3,
  modelId: "muse-spark-1.3",
  origin: "ancilla",
  archived: false,
  createdAt: "2026-09-11T00:00:00.000Z",
  activityAt: "2026-09-11T00:00:00.000Z",
  settled: false,
  settledAt: null,
  unsettledAt: null,
  sandboxDisabled: false,
  accountId: null,
  live: null,
};

function load(overrides: Partial<TranscriptLoad> = {}): TranscriptLoad {
  return {
    session: SESSION,
    msp: { status: "idle", activeTurnId: null, modelId: "muse-spark-1.3", approvalMode: "onRequest", workspaceRoot: "/work/app", turnCount: 3 },
    events: historyEvents,
    truncated: false,
    pending: { approvals: [], userInputs: [] },
    readOnly: false,
    readOnlyReason: null,
    ...overrides,
  };
}

class FakeClient implements AncillaClient {
  handler: EventHandler | null = null;
  sent: {
    sessionId: string;
    text: string;
    ifBusy?: string;
    displayText?: string;
    attachments?: { name: string; mediaType: string; base64: string }[];
  }[] = [];
  actions: string[] = [];
  orders: string[][] = [];
  skills: SkillEntry[] = [];
  transcript: () => Promise<TranscriptLoad> = async () => load();
  sendResult: () => Promise<{ turnId: string | null; disposition: string | null }> = async () => ({ turnId: "t9", disposition: "started" });

  async probeEnvironment() {
    return { platform: "linux", wslAvailable: false, defaultDistro: null, museFound: true, musePath: "/usr/bin/muse", version: "0.2.0", persistent: true };
  }
  projects: import("../src/types.js").ProjectView[] = [
    { cwd: "/work/app", displayName: "app", pinned: false, activityAt: SESSION.activityAt, defaultAccountId: null, folders: [{ cwd: "/work/app", displayName: "app" }] },
  ];
  async listProjects() {
    return [...this.projects];
  }
  async addProject(cwd: string) {
    return { cwd, warning: null };
  }
  folderCalls: string[] = [];
  /** Moves the folder in or out like the server would, so a refresh after the call lists the new shape. */
  async addProjectFolder(cwd: string, path: string) {
    this.folderCalls.push(`add ${cwd} ${path}`);
    const project = this.projects.find((p) => p.cwd === cwd);
    if (!project) {
      throw new Error("Unknown project.");
    }
    const next = { ...project, folders: [...project.folders, { cwd: path, displayName: path.slice(path.lastIndexOf("/") + 1) }] };
    this.projects = this.projects.filter((p) => p.cwd !== path).map((p) => (p.cwd === cwd ? next : p));
    return { project: next, warning: null };
  }
  async removeProjectFolder(cwd: string, path: string) {
    this.folderCalls.push(`remove ${cwd} ${path}`);
    const project = this.projects.find((p) => p.cwd === cwd);
    if (!project) {
      throw new Error("Unknown project.");
    }
    const next = { ...project, folders: project.folders.filter((f) => f.cwd !== path) };
    this.projects = [...this.projects.map((p) => (p.cwd === cwd ? next : p)), { ...next, cwd: path, displayName: "docs", folders: [{ cwd: path, displayName: "docs" }] }];
    return next;
  }
  async cloneProject(_url: string, path: string) {
    return { cwd: path, warning: null };
  }
  async listDirectory(path: string) {
    return { directory: path, parent: null, separator: "/" as const, exists: true, entries: [] };
  }
  assetUrl(path: string) {
    return path;
  }
  async revealPath() {}
  async hideProject() {}
  async setPinned() {}
  async listSessions() {
    return [SESSION];
  }
  discovered: (string | undefined)[] = [];
  async discover(cwd?: string) {
    this.discovered.push(cwd);
  }
  startCalls: { cwd: string; approvalMode?: string; modelId?: string; accountId: string | null }[] = [];
  async startSession(cwd: string, options?: { approvalMode?: string; modelId?: string; accountId?: string | null }) {
    this.startCalls.push({ cwd, approvalMode: options?.approvalMode, modelId: options?.modelId, accountId: options?.accountId ?? null });
    return { ...SESSION, accountId: options?.accountId ?? null };
  }
  transcriptOptions: ({ refresh?: boolean } | undefined)[] = [];
  loadTranscript(_sessionId: string, options?: { refresh?: boolean }) {
    this.transcriptOptions.push(options);
    return this.transcript();
  }
  async updateSession() {
    return SESSION;
  }
  async sendTurn(
    sessionId: string,
    text: string,
    options?: { ifBusy?: string; displayText?: string; attachments?: { name: string; mediaType: string; base64: string }[] },
  ) {
    this.sent.push({
      sessionId,
      text,
      ifBusy: options?.ifBusy,
      displayText: options?.displayText,
      attachments: options?.attachments,
    });
    return this.sendResult();
  }
  async interruptTurn() {}
  async unqueueTurn() {}
  decided: { approvalId: string; choiceId: string }[] = [];
  async decideApproval(input: { approvalId: string; choiceId: string }) {
    this.decided.push({ approvalId: input.approvalId, choiceId: input.choiceId });
  }
  async answerUserInput() {}
  async cancelUserInput() {}
  async clarifyUserInput() {}
  async listModels() {
    return [];
  }
  titleSettings = { enabled: true, modelId: null as string | null };
  titleError: Error | null = null;
  titleGate: Promise<void> | null = null;
  async getTitleSettings() {
    return { ...this.titleSettings };
  }
  async setTitleSettings(patch: { enabled?: boolean; modelId?: string | null }) {
    if (this.titleGate) {
      await this.titleGate;
    }
    if (this.titleError) {
      const error = this.titleError;
      this.titleError = null;
      throw error;
    }
    this.titleSettings = {
      enabled: patch.enabled ?? this.titleSettings.enabled,
      modelId: patch.modelId !== undefined ? patch.modelId : this.titleSettings.modelId,
    };
    return { ...this.titleSettings };
  }
  sandboxSettings = { disabled: false };
  sandboxError: Error | null = null;
  sandboxGate: Promise<void> | null = null;
  sandboxCalls: (boolean | undefined)[] = [];
  async getSandboxSettings() {
    return { ...this.sandboxSettings };
  }
  async setSandboxSettings(patch: { disabled?: boolean }) {
    this.sandboxCalls.push(patch.disabled);
    if (this.sandboxGate) {
      await this.sandboxGate;
    }
    if (this.sandboxError) {
      const error = this.sandboxError;
      this.sandboxError = null;
      throw error;
    }
    this.sandboxSettings = { disabled: patch.disabled ?? this.sandboxSettings.disabled };
    return { ...this.sandboxSettings };
  }
  yoloSettings = { enabled: false };
  yoloError: Error | null = null;
  yoloGate: Promise<void> | null = null;
  yoloCalls: (boolean | undefined)[] = [];
  async getYoloSettings() {
    return { ...this.yoloSettings };
  }
  async setYoloSettings(patch: { enabled?: boolean }) {
    this.yoloCalls.push(patch.enabled);
    if (this.yoloGate) {
      await this.yoloGate;
    }
    if (this.yoloError) {
      const error = this.yoloError;
      this.yoloError = null;
      throw error;
    }
    this.yoloSettings = { enabled: patch.enabled ?? this.yoloSettings.enabled };
    return { ...this.yoloSettings };
  }
  async setSessionModel() {}
  approvalModes: { sessionId: string; mode: string }[] = [];
  approvalModeFailFor: Set<string> = new Set();
  async setApprovalMode(sessionId: string, mode: string) {
    this.approvalModes.push({ sessionId, mode });
    if (this.approvalModeFailFor.has(sessionId)) {
      throw new Error(`could not set the approval mode for ${sessionId}`);
    }
  }
  async setProjectOrder(cwds: string[]) {
    this.orders.push(cwds);
  }
  async usage() {
    return { since: "2026-09-01T00:00:00.000Z", days: 30, buckets: [], threads: [] };
  }
  async runShellProxy(sessionId: string, command: string) {
    this.actions.push(`shell-proxy:${command}`);
    return {
      id: `run-${this.actions.length}`,
      sessionId,
      command,
      exitCode: 0,
      output: `ran ${command}`,
      truncated: false,
      durationMs: 12,
      at: "2026-09-11T22:00:00.000Z",
    };
  }
  compactNoop = false;
  async compact() {
    this.actions.push("compact");
    return { noop: this.compactNoop, reason: this.compactNoop ? "no_compactable_history" : null };
  }
  researchRuns: ResearchRunView[] = [];
  researchStarts: { sessionId: string; question: string; config: Partial<ResearchConfig> | null; commandId: string }[] = [];
  researchStops: { runId: string; writeReport: boolean }[] = [];
  researchSettings: ResearchSettings = { enabled: true, config: fakeResearchRun({}).config };
  researchPatches: { enabled?: boolean; config?: Partial<ResearchConfig> }[] = [];
  startResearchError: Error | null = null;
  async startResearch(sessionId: string, question: string, config: Partial<ResearchConfig> | null, commandId: string): Promise<ResearchRunView> {
    this.researchStarts.push({ sessionId, question, config, commandId });
    if (this.startResearchError) throw this.startResearchError;
    const run = fakeResearchRun({ runId: `run-${this.researchRuns.length + 1}-${commandId.slice(0, 4)}`, sessionId, question });
    this.researchRuns.push(run);
    return run;
  }
  async stopResearch(runId: string, writeReport: boolean): Promise<ResearchRunView> {
    this.researchStops.push({ runId, writeReport });
    const run = this.researchRuns.find((r) => r.runId === runId);
    if (!run) throw new Error("Unknown run.");
    return { ...run, status: writeReport ? "partial" : "cancelled", phase: "done", reportAvailable: writeReport };
  }
  async listResearch(sessionId: string): Promise<ResearchRunView[]> {
    return this.researchRuns.filter((r) => r.sessionId === sessionId);
  }
  async getResearch(runId: string): Promise<ResearchRunView> {
    const run = this.researchRuns.find((r) => r.runId === runId);
    if (!run) throw new Error("Unknown run.");
    return { ...run, report: run.report ?? "# Report\n\nA line [1].\n\n## Sources\n\n[1] A (https://example.com)" };
  }
  async getResearchSettings(): Promise<ResearchSettings> {
    return this.researchSettings;
  }
  async setResearchSettings(patch: { enabled?: boolean; config?: Partial<ResearchConfig> }): Promise<ResearchSettings> {
    this.researchPatches.push(patch);
    this.researchSettings = {
      enabled: patch.enabled ?? this.researchSettings.enabled,
      config: { ...this.researchSettings.config, ...(patch.config ?? {}), models: { ...this.researchSettings.config.models, ...(patch.config?.models ?? {}) } },
    };
    return this.researchSettings;
  }
  async runShell(sessionId: string, command: string) {
    this.actions.push(`shell:${sessionId}:${command}`);
  }
  async forkSession() {
    this.actions.push("fork");
    return { ...SESSION, sessionId: "s2", title: "Probe (fork)" };
  }
  async listSkills(_cwd: string, sessionId?: string) {
    this.skillSessions.push(sessionId);
    return { skills: this.skills, error: null };
  }
  async skillBody(_cwd: string, skillId: string) {
    return `Instructions for ${skillId}.`;
  }
  async openFolder() {}
  openedFiles: { cwd: string; path: string }[] = [];
  async openProjectFile(cwd: string, path: string) {
    this.openedFiles.push({ cwd, path });
  }
  exports: { runId: string; format: ResearchExportFormat }[] = [];
  exportFails: string | null = null;
  async exportResearch(runId: string, format: ResearchExportFormat): Promise<ResearchExport> {
    this.exports.push({ runId, format });
    if (this.exportFails) throw new Error(this.exportFails);
    return { path: `.ancilla/research/${runId}/report.${format}`, name: `report.${format}`, size: 1234, url: `/api/research/${runId}/export/report.${format}` };
  }
  exportReads: { runId: string; format: ResearchExportFormat }[] = [];
  async readResearchExport(runId: string, format: ResearchExportFormat): Promise<Uint8Array> {
    this.exportReads.push({ runId, format });
    return new TextEncoder().encode(`report.${format}`);
  }
  skillSessions: (string | undefined)[] = [];
  efforts: string[] = [];
  goalError: Error | null = null;
  async setReasoningEffort(sessionId: string, effort: string) {
    this.efforts.push(`${sessionId}:${effort}`);
  }
  async goal(sessionId: string, action: string, objective?: string) {
    if (this.goalError) {
      throw this.goalError;
    }
    this.actions.push(`goal:${sessionId}:${action}${objective ? `:${objective}` : ""}`);
    return { turnId: action === "set" || action === "resume" ? "t-goal" : null };
  }
  async subagent(sessionId: string, action: string, subagentId: string, options?: { body?: string }) {
    this.actions.push(`subagent:${sessionId}:${action}:${subagentId}${options?.body ? `:${options.body}` : ""}`);
  }
  async task(sessionId: string, action: string, taskId?: string) {
    this.actions.push(`task:${sessionId}:${action}${taskId ? `:${taskId}` : ""}`);
  }
  workflowError: Error | null = null;
  async workflow(sessionId: string, action: string, workflowRunId: string, child?: { childId: string; attempt: number }) {
    if (this.workflowError) {
      throw this.workflowError;
    }
    this.actions.push(`workflow:${sessionId}:${action}:${workflowRunId}${child ? `:${child.childId}@${child.attempt}` : ""}`);
  }
  async readOutput(_sessionId: string, _itemId: string, _outputRef: string, offset = 0) {
    return { content: offset === 0 ? "first " : "second", encoding: "utf8", mediaType: "text/plain", offsetBytes: offset, byteLen: 6, eof: offset > 0 };
  }
  plan: import("../src/types.js").PlanUsage | null = null;
  planByAccount: Record<string, import("../src/types.js").PlanUsage> = {};
  planMetadata: Pick<import("../src/types.js").PlanUsageReport, "accountId" | "saved" | "savedAccountIds" | "status"> = {};
  planError: Error | null = null;
  async planUsage(): Promise<import("../src/types.js").PlanUsageReport> {
    if (this.planError) throw this.planError;
    return { usage: this.plan, byAccount: this.planByAccount, ...this.planMetadata };
  }
  accounts: import("../src/types.js").AccountView[] = [];
  accountCalls: { kind: "create" | "rename" | "remove" | "default"; id?: string; cwd?: string; accountId?: string | null; name?: string }[] = [];
  async listAccounts() {
    return [...this.accounts];
  }
  async createAccount(id: string, options?: { name?: string; seedFromDefault?: boolean }) {
    this.accountCalls.push({ kind: "create", id, name: options?.name });
    this.accounts.push({ id, name: options?.name ?? id, hasLogin: false, email: null, lastUsedAt: null });
    return { id, name: options?.name ?? id };
  }
  async renameAccount(id: string, name: string) {
    this.accountCalls.push({ kind: "rename", id, name });
    const account = this.accounts.find((a) => a.id === id);
    if (account) {
      account.name = name;
    }
  }
  async removeAccount(id: string) {
    this.accountCalls.push({ kind: "remove", id });
    this.accounts = this.accounts.filter((a) => a.id !== id);
  }
  setProjectDefaultAccountError: Error | null = null;
  async setProjectDefaultAccount(cwd: string, accountId: string | null) {
    this.accountCalls.push({ kind: "default", cwd, accountId });
    if (this.setProjectDefaultAccountError) {
      const error = this.setProjectDefaultAccountError;
      this.setProjectDefaultAccountError = null;
      throw error;
    }
  }
  metaApiKeyInherited = false;
  async accountsHealth() {
    return { metaApiKeyInherited: this.metaApiKeyInherited };
  }
  loginAccountResult: import("../src/types.js").AccountLoginResult = {
    url: "https://auth.meta.com/oauth/device/?code=TEST-CODE",
    code: "TEST-CODE",
  };
  loginAccountCalls: (string | null)[] = [];
  accountLoginProgress?: AncillaClient["accountLoginProgress"];
  cancelledLoginCalls: { id: string | null; loginId: string }[] = [];
  async cancelAccountLogin(id: string | null, loginId: string) {
    this.cancelledLoginCalls.push({ id, loginId });
  }
  async loginAccount(id: string | null) {
    this.loginAccountCalls.push(id);
    return this.loginAccountResult;
  }
  writes: { path: string; content: string; baseMtimeMs: number | null }[] = [];
  writeError: Error | null = null;
  async listFiles(_cwd: string, path: string) {
    return { path, entries: [], truncated: false };
  }
  async readFile(_cwd: string, path: string) {
    return { path, name: path, size: 3, mtimeMs: 100, kind: "markdown" as const, mediaType: "text/markdown", content: "# a", truncated: false };
  }
  async writeFile(_cwd: string, path: string, content: string, baseMtimeMs: number | null) {
    if (this.writeError) {
      const error = this.writeError;
      this.writeError = null;
      throw error;
    }
    this.writes.push({ path, content, baseMtimeMs });
    return { path, size: content.length, mtimeMs: 200 };
  }
  async searchFiles() {
    return [];
  }
  async openFileExternally() {}
  fileUrl(cwd: string, path: string) {
    return `/raw?${cwd}&${path}`;
  }
  subscribe(handler: EventHandler) {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }
}

function platform(hash = ""): Platform & { hash: string } {
  const state = {
    hash,
    loadPrefs: () => null,
    savePrefs: () => {},
    readHash: () => state.hash,
    writeHash: (next: string) => {
      state.hash = next;
    },
    onHashChange: () => () => {},
    now: () => Date.now(),
    schedule: (fn: () => void) => setTimeout(fn, 0),
    cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    // Nothing is watching a test, which is also what lets one exercise what gets announced.
    focused: () => false,
  };
  return state;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

// Drains pending microtasks without ever crossing a real timer tick. The fake platform's `schedule`
// collapses every real delay to 0ms, toast auto-dismiss included, so `settle()` would let a toast this
// test wants to inspect land and expire before either check runs. This only waits long enough for a
// fire-and-forget chain (like `pushThreadModes`) to finish adding it.
async function flushMicrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

async function started(client: FakeClient, hash = "#/t/s1") {
  const controller = new AncillaController(client, platform(hash));
  const stop = controller.start();
  await settle();
  await settle();
  return { controller, stop };
}

describe("AncillaController", () => {
  it("boots, lists threads and opens the one in the URL", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const state = controller.store.get();
    assert.equal(state.boot, "ready");
    assert.deepEqual(state.route, { kind: "thread", sessionId: "s1" });
    assert.equal(state.threads["s1"]?.load, "ready");
    assert.equal(buildTurns(state.threads["s1"]!.fold).length, 3);
    assert.deepEqual(client.transcriptOptions, [undefined], "an idle session still uses the normal initial load");
    stop();
  });

  it("reads a running session on a fresh page without resuming its active turn", async () => {
    const client = new FakeClient();
    const session: SessionSummary = {
      ...SESSION,
      live: { activeTurnId: "live-1", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 1, lastTerminal: null, lastError: null },
    };
    client.listSessions = async () => [session];
    client.transcript = async () => load({
      session,
      msp: { status: "running", activeTurnId: "live-1", modelId: "muse-spark-1.3", approvalMode: "onRequest", workspaceRoot: "/work/app", turnCount: 4 },
      events: [...historyEvents, { method: "turn/started", params: { turnId: "live-1" }, at: 1 }],
      pending: { approvals: [], userInputs: [{ userInputId: "q1", sessionId: "s1", turnId: "live-1", questions: [] }] },
    });
    const { controller, stop } = await started(client);
    try {
      assert.deepEqual(client.transcriptOptions, [{ refresh: true }], "the first load must not reattach an already running session");
      const thread = controller.store.get().threads["s1"];
      assert.equal(thread?.load, "ready");
      assert.equal(thread?.fold.activeTurnId, "live-1");
      assert.ok(thread?.fold.userInputs["q1"], "the active turn's pending question remains available");
      assert.equal(client.sent.length, 0);
    } finally {
      stop();
    }
  });

  it("loads the thread-title switch at boot and flips it with rollback", async () => {
    const client = new FakeClient();
    client.titleSettings = { enabled: false, modelId: "m1" };
    const { controller, stop } = await started(client);
    assert.deepEqual(controller.store.get().titleSettings, { enabled: false, modelId: "m1" });

    await controller.setTitleEnabled(true);
    assert.deepEqual(controller.store.get().titleSettings, { enabled: true, modelId: "m1" });

    await controller.setTitleModel(null);
    assert.deepEqual(controller.store.get().titleSettings, { enabled: true, modelId: null });

    client.titleError = new Error("daemon away");
    await controller.setTitleEnabled(false);
    assert.deepEqual(controller.store.get().titleSettings, { enabled: true, modelId: null }, "a failed flip rolls back");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not change thread titles/);
    stop();
  });

  it("loads the sandbox switch at boot and flips it with rollback", async () => {
    const client = new FakeClient();
    client.sandboxSettings = { disabled: true };
    const { controller, stop } = await started(client);
    assert.deepEqual(controller.store.get().sandboxSettings, { disabled: true });

    await controller.setSandboxDisabled(false);
    assert.deepEqual(controller.store.get().sandboxSettings, { disabled: false });

    client.sandboxError = new Error("daemon away");
    await controller.setSandboxDisabled(true);
    assert.deepEqual(controller.store.get().sandboxSettings, { disabled: false }, "a failed flip rolls back");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not change the sandbox setting/);
    stop();
  });

  it("sends rapid sandbox flips to the server in order", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    try {
      let release!: () => void;
      client.sandboxGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = controller.setSandboxDisabled(true);
      const second = controller.setSandboxDisabled(false);
      try {
        await new Promise((r) => setTimeout(r, 0));
        assert.deepEqual(client.sandboxCalls, [true], "the second PATCH waits for the first");
      } finally {
        release();
      }
      await Promise.all([first, second]);
      assert.deepEqual(client.sandboxCalls, [true, false]);
      assert.deepEqual(client.sandboxSettings, { disabled: false }, "the server ends at the latest flip");
      assert.deepEqual(controller.store.get().sandboxSettings, { disabled: false });
    } finally {
      stop();
    }
  });

  it("clears the host error and toasts when hosts restart for the sandbox switch", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    client.handler?.({ type: "host", key: "k", state: "failed", message: "boom" });
    assert.equal(controller.store.get().hostError, "boom");
    client.handler?.({ type: "host", key: "k", state: "restarted", message: "The Muse host restarted." });
    assert.equal(controller.store.get().hostError, null);
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Muse hosts restarted/);
    stop();
  });

  it("discards a stale title switch that resolves after a newer one", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    let release!: () => void;
    client.titleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = controller.setTitleEnabled(false);
    client.titleGate = null;
    await controller.setTitleEnabled(true);
    release();
    await first;
    assert.deepEqual(controller.store.get().titleSettings, { enabled: true, modelId: null });
    stop();
  });

  it("loads the YOLO switch at boot and flips it with rollback", async () => {
    const client = new FakeClient();
    client.yoloSettings = { enabled: true };
    const { controller, stop } = await started(client);
    assert.deepEqual(controller.store.get().yoloSettings, { enabled: true });
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "allowAll", "boot under YOLO joins the open thread");
    assert.ok(
      client.approvalModes.some((p) => p.sessionId === "s1" && p.mode === "allowAll"),
      "the join is pushed to Muse",
    );

    await controller.setYoloEnabled(false);
    assert.deepEqual(controller.store.get().yoloSettings, { enabled: false });

    client.yoloError = new Error("daemon away");
    await controller.setYoloEnabled(true);
    assert.deepEqual(controller.store.get().yoloSettings, { enabled: false }, "a failed flip rolls back");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not change the YOLO setting/);
    stop();
  });

  it("sends rapid YOLO flips to the server in order", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    try {
      let release!: () => void;
      client.yoloGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = controller.setYoloEnabled(true);
      const second = controller.setYoloEnabled(false);
      try {
        await new Promise((r) => setTimeout(r, 0));
        assert.deepEqual(client.yoloCalls, [true], "the second PATCH waits for the first");
      } finally {
        release();
      }
      await Promise.all([first, second]);
      assert.deepEqual(client.yoloCalls, [true, false]);
      assert.deepEqual(client.yoloSettings, { enabled: false }, "the server ends at the latest flip");
      assert.deepEqual(controller.store.get().yoloSettings, { enabled: false });
    } finally {
      stop();
    }
  });

  it("moves open threads to full access on YOLO and restores them after", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setMode("denyUnmatched");
    controller.setPrefs({ defaultMode: "promptUnmatched" });
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "denyUnmatched");

    await controller.setYoloEnabled(true);
    const on = controller.store.get();
    assert.equal(on.prefs.defaultMode, "allowAll");
    assert.equal(on.threads["s1"]?.fold.meta.approvalMode, "allowAll");
    assert.deepEqual(client.approvalModes.at(-1), { sessionId: "s1", mode: "allowAll" });
    assert.equal(controller.bypassArmed("s1"), true);

    await controller.setYoloEnabled(false);
    const off = controller.store.get();
    assert.equal(off.prefs.defaultMode, "promptUnmatched", "the default from before arming comes back");
    assert.equal(off.threads["s1"]?.fold.meta.approvalMode, "denyUnmatched", "and so does the thread's own mode");
    assert.deepEqual(client.approvalModes.at(-1), { sessionId: "s1", mode: "denyUnmatched" });
    assert.equal(controller.bypassArmed("s1"), false);
    stop();
  });

  it("ignores a YOLO flip to the value it already has", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setMode("denyUnmatched");

    await controller.setYoloEnabled(false);
    assert.deepEqual(client.yoloCalls, [], "no PATCH leaves for a no-op flip");
    assert.equal(controller.store.get().prefs.defaultMode, "denyUnmatched");
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "denyUnmatched");

    await controller.setYoloEnabled(true);
    await controller.setYoloEnabled(true);
    assert.deepEqual(client.yoloCalls, [true], "the double-click enable PATCHes once");
    stop();
  });

  it("refuses permission changes while YOLO is on", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setYoloEnabled(true);
    const pushes = client.approvalModes.length;

    await controller.setMode("onRequest");
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "allowAll");
    assert.equal(client.approvalModes.length, pushes, "no mode push leaves while YOLO owns the modes");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /YOLO is on/);
    stop();
  });

  it("refuses to change the sandbox switch while YOLO is on, with a toast", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setYoloEnabled(true);

    await controller.setSandboxDisabled(false);
    assert.deepEqual(client.sandboxCalls, [], "no PATCH leaves while YOLO owns the sandbox posture");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /YOLO mode is on/);
    stop();
  });

  it("joins a thread opened under YOLO to full access", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client, "#/");
    await controller.setYoloEnabled(true);
    await controller.loadThread("s1");
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "allowAll");
    assert.deepEqual(client.approvalModes.at(-1), { sessionId: "s1", mode: "allowAll" });
    stop();
  });

  it("stays silent about approvals a bypass answers on its own", async () => {
    const client = new FakeClient();
    const shown: string[] = [];
    const { controller, stop } = await started(client);
    controller.attachNotifier({
      permission: async () => "granted",
      request: async () => "granted",
      show: async (note) => {
        shown.push(note.tag);
      },
    });
    controller.setPrefs({ notifications: true });
    await controller.setYoloEnabled(true);
    client.handler?.({
      type: "session-status",
      sessionId: "s1",
      live: {
        activeTurnId: null,
        turnStartedAt: null,
        pendingApprovals: 1,
        pendingInputs: 0,
        lastTerminal: null,
        lastError: null,
      } as never,
    });
    await settle();
    assert.deepEqual(shown, [], "an armed thread answers, so nobody is needed");
    stop();
  });

  it("clears the host error and toasts when hosts restart for the YOLO switch", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    client.handler?.({ type: "host", key: "k", state: "failed", message: "boom" });
    assert.equal(controller.store.get().hostError, "boom");
    client.handler?.({ type: "host", key: "k", state: "restarted", message: "The Muse host restarted." });
    assert.equal(controller.store.get().hostError, null);
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Muse hosts restarted/);
    stop();
  });

  it("waits for the YOLO patch to land before pushing any thread's approval mode", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    let release!: () => void;
    client.yoloGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flip = controller.setYoloEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(client.approvalModes.length, 0, "no mode push leaves before the PATCH resolves");
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "onRequest", "the thread's own mode is untouched until then");
    release();
    await flip;
    assert.deepEqual(client.approvalModes.at(-1), { sessionId: "s1", mode: "allowAll" });
    stop();
  });

  it("pushes no approval mode when the YOLO patch itself fails", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setMode("denyUnmatched");
    const pushes = client.approvalModes.length;
    client.yoloError = new Error("daemon away");
    await controller.setYoloEnabled(true);
    assert.deepEqual(controller.store.get().yoloSettings, { enabled: false });
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "denyUnmatched", "the thread's mode never moved");
    assert.equal(client.approvalModes.length, pushes, "no mode push leaves for a flip that never landed");
    stop();
  });

  it("clears the pre-YOLO snapshot when the PATCH fails, so a later enable captures a fresh one", async () => {
    const client = new FakeClient();
    let saved: unknown = null;
    const shared: Platform & { hash: string } = {
      hash: "#/t/s1",
      loadPrefs: () => null,
      savePrefs: (prefs) => {
        saved = prefs;
      },
      readHash: () => shared.hash,
      writeHash: (next) => {
        shared.hash = next;
      },
      onHashChange: () => () => {},
      now: () => Date.now(),
      schedule: (fn: () => void) => setTimeout(fn, 0),
      cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      focused: () => false,
    };

    const controller = new AncillaController(client, shared);
    const stop = controller.start();
    await settle();
    await settle();

    await controller.setMode("denyUnmatched");
    client.yoloError = new Error("daemon away");
    await controller.setYoloEnabled(true);
    await settle();
    assert.deepEqual(controller.store.get().yoloSettings, { enabled: false });
    assert.equal(
      (saved as { preYolo: unknown } | null)?.preYolo ?? null,
      null,
      "the failed enable's snapshot never sticks around in prefs",
    );

    // A different mode than the failed attempt saw, so a stale snapshot from that attempt would
    // be caught by this asserting the wrong value instead of passing by coincidence.
    await controller.setMode("promptUnmatched");
    await controller.setYoloEnabled(true);
    await settle();
    assert.deepEqual(controller.store.get().yoloSettings, { enabled: true });
    assert.equal(
      (saved as { preYolo: { defaultMode: string } | null } | null)?.preYolo?.defaultMode,
      "promptUnmatched",
      "a following successful enable captures a fresh snapshot",
    );

    stop();
  });

  it("starts new threads at full access under YOLO, even when the local default was never touched", async () => {
    const client = new FakeClient();
    // Boot converges the open thread through convergeThread, not applyYoloApprovals, so the default
    // mode itself is left exactly as it starts: the case a new thread must not trust.
    client.yoloSettings = { enabled: true };
    const { controller, stop } = await started(client, "");
    assert.equal(controller.store.get().prefs.defaultMode, "onRequest");
    controller.newThread();
    await controller.send("hello");
    assert.equal(client.startCalls.at(-1)?.approvalMode, "allowAll");
    assert.equal(controller.store.get().threads[SESSION.sessionId]?.fold.meta.approvalMode, "allowAll");
    stop();
  });

  it("reloads YOLO and sandbox settings after hosts restart, and restores this client when YOLO went off elsewhere", async () => {
    const client = new FakeClient();
    client.yoloSettings = { enabled: true };
    const { controller, stop } = await started(client);
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "allowAll", "boot under YOLO joins the open thread");

    // Another client turned YOLO off and the sandbox on; this one never called setYoloEnabled itself,
    // so a restart is the only way it learns either happened.
    client.yoloSettings = { enabled: false };
    client.sandboxSettings = { disabled: true };
    client.handler?.({ type: "host", key: "k", state: "restarted", message: "The Muse host restarted." });
    await settle();

    assert.deepEqual(controller.store.get().yoloSettings, { enabled: false });
    assert.deepEqual(controller.store.get().sandboxSettings, { disabled: true });
    assert.equal(
      controller.store.get().threads["s1"]?.fold.meta.approvalMode,
      "onRequest",
      "this client stops auto approving too, with no local snapshot to restore from",
    );
    stop();
  });

  it("keeps its pre-YOLO snapshot across a reload, so switching YOLO off afterwards still restores the real modes", async () => {
    const client = new FakeClient();
    let saved: unknown = null;
    const shared: Platform & { hash: string } = {
      hash: "#/t/s1",
      loadPrefs: () => saved,
      savePrefs: (prefs) => {
        saved = prefs;
      },
      readHash: () => shared.hash,
      writeHash: (next) => {
        shared.hash = next;
      },
      onHashChange: () => () => {},
      now: () => Date.now(),
      schedule: (fn: () => void) => setTimeout(fn, 0),
      cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      focused: () => false,
    };

    const first = new AncillaController(client, shared);
    const stopFirst = first.start();
    await settle();
    await settle();
    await first.setMode("denyUnmatched");
    await first.setYoloEnabled(true);
    await settle();
    stopFirst();

    const second = new AncillaController(client, shared);
    const stopSecond = second.start();
    await settle();
    await settle();
    await second.setYoloEnabled(false);
    assert.equal(second.store.get().prefs.defaultMode, "denyUnmatched", "the real default survives the reload");
    assert.equal(second.store.get().threads["s1"]?.fold.meta.approvalMode, "denyUnmatched", "and so does the thread's own mode");
    stopSecond();
  });

  it("keeps the failed-thread toast singular for exactly one thread", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setYoloEnabled(true);
    client.approvalModeFailFor = new Set(["s1"]);
    await controller.setYoloEnabled(false);
    // The mode push is fire-and-forget from setYoloEnabled's own promise, so the toast it ends in
    // lands a tick later than the flip itself.
    await flushMicrotasks();
    assert.match(controller.store.get().toasts.at(-1)?.detail ?? "", /^1 thread kept full access\.$/);
    stop();
  });

  it("pluralizes the failed-thread toast for more than one thread", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.loadThread("s2");
    await controller.setYoloEnabled(true);
    client.approvalModeFailFor = new Set(["s1", "s2"]);
    await controller.setYoloEnabled(false);
    await flushMicrotasks();
    assert.match(controller.store.get().toasts.at(-1)?.detail ?? "", /^2 threads kept full access\.$/);
    stop();
  });

  it("refuses /permissions full while YOLO is on, without opening the confirm dialog", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.setYoloEnabled(true);
    await controller.send("/permissions full");
    assert.equal(controller.store.get().picker, null, "the confirm dialog never opens");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /YOLO is on/);
    stop();
  });

  it("still announces a rule-only approval even while a bypass is armed", async () => {
    const client = new FakeClient();
    const shown: string[] = [];
    const { controller, stop } = await started(client);
    controller.attachNotifier({
      permission: async () => "granted",
      request: async () => "granted",
      show: async (note) => {
        shown.push(note.tag);
      },
    });
    controller.setPrefs({ notifications: true });
    await controller.setYoloEnabled(true);
    // A rule-only choice gives autoAllow nothing to click, so it stays pending for the user.
    client.handler?.({
      type: "msp",
      sessionId: "s1",
      method: "approval/requested",
      params: {
        approvalId: "a1",
        sessionId: "s1",
        availableChoices: [{ choiceId: "c1", label: "Always allow", decision: "approved", scope: "rule", rulePreview: "echo *" }],
        subject: { kind: "shell" },
      },
      at: 1,
    });
    await settle();
    client.handler?.({
      type: "session-status",
      sessionId: "s1",
      live: {
        activeTurnId: null,
        turnStartedAt: null,
        pendingApprovals: 1,
        pendingInputs: 0,
        lastTerminal: null,
        lastError: null,
      } as never,
    });
    await settle();
    assert.deepEqual(shown, ["approval:s1"], "a rule-only approval still needs the user, even armed");
    stop();
  });

  it("keeps stream events that arrive while a thread is still loading", async () => {
    const client = new FakeClient();
    let resolve: (value: TranscriptLoad) => void = () => {};
    client.transcript = () => new Promise((r) => (resolve = r));
    const { controller, stop } = await started(client);
    client.handler?.({ type: "msp", sessionId: "s1", method: "turn/started", params: { sessionId: "s1", turnId: "live-1" }, at: 1 });
    resolve(load());
    await settle();
    assert.equal(controller.store.get().threads["s1"]?.fold.activeTurnId, "live-1");
    stop();
  });

  it("coalesces overlapping thread loads instead of losing buffered events", async () => {
    // A second load while one is in flight used to orphan the first load's buffer: every event
    // that streamed into it was dropped, and the thread never showed them (#32).
    const client = new FakeClient();
    let loads = 0;
    let resolve!: (value: TranscriptLoad) => void;
    client.transcript = () => {
      loads += 1;
      return new Promise<TranscriptLoad>((r) => (resolve = r));
    };
    const { controller, stop } = await started(client);
    client.handler?.({ type: "msp", sessionId: "s1", method: "turn/started", params: { sessionId: "s1", turnId: "live-1" }, at: 1 });
    const second = controller.loadThread("s1");
    client.handler?.({
      type: "msp",
      sessionId: "s1",
      method: "item/started",
      params: { sessionId: "s1", item: { itemId: "i1", kind: "agentMessage", status: "inProgress", revision: 1 } },
      at: 2,
    });
    resolve(load());
    await settle();
    await settle();
    await second;
    assert.equal(loads, 1, "overlapping loads share one transcript read");
    const fold = controller.store.get().threads["s1"]?.fold;
    assert.equal(fold?.activeTurnId, "live-1", "events buffered before the overlap still land");
    assert.ok(fold?.items["i1"], "events buffered during the overlap still land");
    stop();
  });

  it("rereads a background thread that missed a dropped stream when it is opened, so a finished agent stops working", async () => {
    const client = new FakeClient();
    const other: SessionSummary = { ...SESSION, sessionId: "s2", title: "Other" };
    client.listSessions = async () => [SESSION, other];
    const workflow = (revision: number, status: string, child: Record<string, unknown>): ViewEvent => ({
      method: "item/updated",
      params: { item: { itemId: "wf-1", kind: "workflow", revision, status, turnId: "t1", workflowRunId: "run-1",
        children: [{ childId: "c1", attempt: 1, label: "bg-reader", ...child }] } },
    });
    // The lead turn ended; its workflow child carries on in the background.
    let events: ViewEvent[] = [
      { method: "turn/started", params: { turnId: "t1" } },
      workflow(1, "inProgress", { status: "started" }),
      { method: "turn/completed", params: { turnId: "t1", terminal: "completed" } },
    ];
    const calls: [string, { refresh?: boolean } | undefined][] = [];
    client.loadTranscript = async (sessionId: string, options?: { refresh?: boolean }) => {
      calls.push([sessionId, options]);
      return load({ session: sessionId === "s1" ? SESSION : other, events: sessionId === "s1" ? events : [] });
    };
    const { controller, stop } = await started(client);
    const working = () => crewView(controller.store.get().threads.s1!.fold, SESSION, Date.now()).runs[0]?.counts.working;
    try {
      assert.equal(working(), 1);
      controller.openThread("s2");
      await settle();
      // The child finishes while the stream is down, and nothing replays that.
      events = [...events, workflow(2, "completed", { status: "terminal", terminal: "completed" })];
      calls.length = 0;
      client.handler?.({ type: "connection", state: "lost" });
      client.handler?.({ type: "hello", version: "x" });
      await settle();
      assert.deepEqual(calls, [["s2", undefined]], "the open thread reloads at once");
      assert.equal(controller.store.get().threads.s1?.stale, true, "the other shows what it has as last known");
      assert.notEqual(controller.store.get().threads.s2?.stale, true);
      controller.openThread("s1");
      await settle();
      await settle();
      assert.deepEqual(calls.at(-1), ["s1", { refresh: true }], "the other on opening, read in place while its agent may run");
      assert.equal(working(), 0);
      assert.notEqual(controller.store.get().threads.s1?.stale, true, "and is live again once read");
      controller.openThread("s2");
      controller.openThread("s1");
      await settle();
      assert.equal(calls.length, 2, "once reread, it is not read again on every visit");
    } finally {
      stop();
    }
  });

  it("echoes a sent prompt, marks the turn running, then drops the echo", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("Add a README section"), true);
    let fold = controller.store.get().threads["s1"]!.fold;
    assert.equal(fold.activeTurnId, "t9");
    assert.equal(fold.echoes[0]?.turnId, "t9");
    client.handler?.({
      type: "msp",
      sessionId: "s1",
      method: "item/completed",
      params: { sessionId: "s1", item: { itemId: "u9", kind: "userMessage", status: "completed", revision: 1, turnId: "t9", text: "Add a README section" } },
      at: 2,
    });
    await settle();
    fold = controller.store.get().threads["s1"]!.fold;
    assert.equal(fold.echoes.length, 0);
    stop();
  });

  it("queues follow-ups while a turn runs and steers on request", async () => {
    const client = new FakeClient();
    client.transcript = async () => load({ msp: { status: "running", activeTurnId: "t1", modelId: null, approvalMode: null, workspaceRoot: null, turnCount: 3 } });
    client.sendResult = async () => ({ turnId: "t2", disposition: "queued" });
    const { controller, stop } = await started(client);
    await controller.send("next thing");
    assert.equal(client.sent.at(-1)?.ifBusy, "queue");
    assert.equal(controller.store.get().threads["s1"]!.fold.echoes[0]?.disposition, "queued");
    client.sendResult = async () => ({ turnId: "t1", disposition: "steered" });
    await controller.send("actually use tabs", { steer: true });
    assert.equal(client.sent.at(-1)?.ifBusy, "steer");
    stop();
  });

  it("turns a double-pressed Enter into one send, and the duplicate still reports sent", async () => {
    const client = new FakeClient();
    const releases: ((ack: { turnId: string | null; disposition: string | null }) => void)[] = [];
    client.sendResult = () => new Promise((resolve) => {
      releases.push(resolve);
    });
    const { controller, stop } = await started(client);
    // Both arrive before either is acknowledged, the way two Enters land before the composer clears.
    const first = controller.send("check the vault");
    const second = controller.send("check the vault");
    releases.forEach((release, index) => release({ turnId: `t${9 + index}`, disposition: "started" }));
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(client.sent.length, 1);
    assert.equal(controller.store.get().threads["s1"]!.fold.echoes.length, 1);
    stop();
  });

  it("lets the same prompt go again once the first send settles", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("check the vault"), true);
    assert.equal(await controller.send("check the vault"), true);
    assert.equal(client.sent.length, 2);
    stop();
  });

  it("lets a different prompt go while one is still in flight", async () => {
    const client = new FakeClient();
    const releases: ((ack: { turnId: string | null; disposition: string | null }) => void)[] = [];
    client.sendResult = () => new Promise((resolve) => {
      releases.push(resolve);
    });
    const { controller, stop } = await started(client);
    const first = controller.send("check the vault");
    const second = controller.send("and the firewall rules");
    releases.forEach((release, index) => release({ turnId: `t${9 + index}`, disposition: "started" }));
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(client.sent.length, 2);
    stop();
  });

  it("releases the guard when the first send fails, so a retry goes", async () => {
    const client = new FakeClient();
    client.sendResult = async () => {
      throw new AncillaError("turn rejected", 409, "turnRejected");
    };
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("check the vault"), false);
    client.sendResult = async () => ({ turnId: "t9", disposition: "started" });
    assert.equal(await controller.send("check the vault"), true);
    assert.equal(client.sent.length, 2);
    stop();
  });

  it("sends identical text with identical files once, but new files go", async () => {
    const client = new FakeClient();
    const releases: ((ack: { turnId: string | null; disposition: string | null }) => void)[] = [];
    client.sendResult = () => new Promise((resolve) => {
      releases.push(resolve);
    });
    const { controller, stop } = await started(client);
    const shot = { name: "shot.png", mediaType: "image/png", base64: "AAAA" };
    const other = { name: "other.png", mediaType: "image/png", base64: "BBBB" };
    const first = controller.send("look at this", { attachments: [shot] });
    const duplicate = controller.send("look at this", { attachments: [{ ...shot }] });
    const changed = controller.send("look at this", { attachments: [other] });
    releases.forEach((release, index) => release({ turnId: `t${9 + index}`, disposition: "started" }));
    assert.deepEqual(await Promise.all([first, duplicate, changed]), [true, true, true]);
    assert.equal(client.sent.length, 2);
    stop();
  });

  it("reports a failed send and hands the text back", async () => {
    const client = new FakeClient();
    client.sendResult = async () => {
      throw new AncillaError("input too large", 409, "inputTooLarge");
    };
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("x".repeat(10)), false);
    const state = controller.store.get();
    assert.equal(state.threads["s1"]!.fold.echoes.length, 0);
    assert.equal(state.toasts.at(-1)?.title, "Message not sent");
    stop();
  });

  it("gives a failed first prompt to the new thread's composer", async () => {
    const client = new FakeClient();
    client.sendResult = async () => {
      throw new AncillaError("turn rejected", 409, "turnRejected");
    };
    const { controller, stop } = await started(client, "");
    // The new-thread composer unmounts on navigation, so it must not take the text back itself.
    assert.equal(await controller.send("Write the tests"), true);
    const state = controller.store.get();
    assert.deepEqual(state.route, { kind: "thread", sessionId: "s1" });
    assert.equal(state.toasts.at(-1)?.title, "Message not sent");
    assert.equal(controller.takeDraftHandoff("other"), null);
    assert.deepEqual(controller.takeDraftHandoff("s1"), { text: "Write the tests" });
    assert.equal(controller.store.get().draftHandoff, null);
    stop();
  });

  it("hands the files back with the prompt when a first send fails", async () => {
    const client = new FakeClient();
    client.sendResult = async () => {
      throw new AncillaError("turn rejected", 409, "turnRejected");
    };
    const { controller, stop } = await started(client, "");
    const attachments = [{ name: "shot.png", mediaType: "image/png", base64: "AAAA" }];
    const previews = [{ name: "shot.png", mediaType: "image/png", kind: "image" as const, url: "blob:shot" }];
    assert.equal(await controller.send("Look at this", { attachments, previews }), true);
    // Text alone would hand back a draft asking about an image that is no longer attached to it.
    assert.deepEqual(controller.takeDraftHandoff("s1"), { text: "Look at this", attachments, previews });
    stop();
  });

  it("answers approvals itself once a thread is armed, taking allow-once over a rule", async () => {
    const client = new FakeClient();
    const request = {
      approvalId: "ap1",
      sessionId: "s1",
      currentRequirementId: null,
      subject: { kind: "command", command: "git rebase --continue" },
      availableChoices: [
        { choiceId: "remember", label: "Allow and remember", decision: "approved", scope: "session", rulePreview: "git rebase *" },
        { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
        { choiceId: "no", label: "Reject", decision: "denied", scope: "once" },
      ],
    };
    client.transcript = async () => load({ pending: { approvals: [request], userInputs: [] } });
    const { controller, stop } = await started(client);
    // Nothing is armed yet, so the request waits for the user.
    assert.equal(Object.keys(controller.store.get().threads["s1"]!.fold.approvals).length, 1);
    assert.equal(client.decided.length, 0);

    controller.setThreadBypass("s1", true);
    await settle();
    // The remembered choice would write a standing rule into Muse's own config, so it takes the plain one.
    assert.deepEqual(client.decided, [{ approvalId: "ap1", choiceId: "once" }]);
    const fold = controller.store.get().threads["s1"]!.fold;
    assert.equal(fold.approvals["ap1"], undefined);
    assert.equal(fold.resolved["ap1"]?.resolvedBy, "bypass");
    stop();
  });

  it("leaves an approval alone when the only way to allow it writes a rule", async () => {
    const client = new FakeClient();
    const request = {
      approvalId: "ap2",
      sessionId: "s1",
      currentRequirementId: null,
      subject: { kind: "command", command: "rm -rf /tmp/scratch" },
      availableChoices: [
        { choiceId: "remember", label: "Allow and remember", decision: "approved", scope: "session", rulePreview: "rm *" },
        { choiceId: "no", label: "Reject", decision: "denied", scope: "once" },
      ],
    };
    client.transcript = async () => load({ pending: { approvals: [request], userInputs: [] } });
    const { controller, stop } = await started(client);
    controller.setThreadBypass("s1", true);
    await settle();
    // That rule would outlive the bypass that wrote it, which is the one thing it promises not to do.
    assert.deepEqual(client.decided, []);
    assert.equal(Object.keys(controller.store.get().threads["s1"]!.fold.approvals).length, 1);
    stop();
  });

  it("keeps closed dock cards out until the thread brings them back", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const hidden = () => controller.store.get().prefs.hiddenCards;
    assert.deepEqual(hidden(), []);
    controller.setCardHidden("plan:s1", true);
    controller.setCardHidden("goal:s1", true);
    controller.setCardHidden("plan:s2", true);
    controller.setCardHidden("plan:s1", true);
    assert.deepEqual(hidden(), ["plan:s1", "goal:s1", "plan:s2"]);
    // Bringing one thread's cards back leaves another thread's alone.
    controller.showThreadCards("s1");
    assert.deepEqual(hidden(), ["plan:s2"]);
    controller.setCardHidden("plan:s2", false);
    assert.deepEqual(hidden(), []);
    stop();
  });

  it("remembers which dock cards a thread had folded away", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const collapsed = () => controller.store.get().prefs.collapsedCards;
    // Open by default, so a thread nobody has touched costs nothing to remember.
    assert.deepEqual(collapsed(), []);

    controller.setCardOpen("goal:s1", false);
    assert.deepEqual(collapsed(), ["goal:s1"]);

    // Another thread's card is its own business.
    controller.setCardOpen("goal:s2", false);
    assert.deepEqual(collapsed(), ["goal:s1", "goal:s2"]);

    // Opening one again drops it rather than recording a second state for it.
    controller.setCardOpen("goal:s1", true);
    assert.deepEqual(collapsed(), ["goal:s2"]);

    // Closing one that is already closed leaves the list alone.
    controller.setCardOpen("goal:s2", false);
    assert.deepEqual(collapsed(), ["goal:s2"]);
    stop();
  });

  it("announces the edges of what a thread is doing, not the state it is sitting in", async () => {
    const client = new FakeClient();
    const shown: string[] = [];
    const { controller, stop } = await started(client);
    controller.attachNotifier({
      permission: async () => "granted",
      request: async () => "granted",
      show: async (note) => {
        shown.push(note.tag);
      },
    });
    controller.setPrefs({ notifications: true });
    const live = (patch: Record<string, unknown>) => ({
      activeTurnId: null,
      turnStartedAt: null,
      pendingApprovals: 0,
      pendingInputs: 0,
      lastTerminal: null,
      lastError: null,
      ...patch,
    });
    const status = async (patch: Record<string, unknown>) => {
      client.handler?.({ type: "session-status", sessionId: "s1", live: live(patch) as never });
      await settle();
    };

    // A request that has just appeared is worth saying.
    await status({ pendingApprovals: 1 });
    assert.deepEqual(shown, ["approval:s1"]);

    // The same request still sitting there is not: it was already announced once.
    await status({ pendingApprovals: 1 });
    assert.deepEqual(shown, ["approval:s1"]);

    // A turn that has just ended is an edge too, and carries whether it failed.
    await status({ activeTurnId: "t1" });
    await status({ lastTerminal: "failed", lastError: "boom" });
    assert.deepEqual(shown, ["approval:s1", "finished:s1"]);

    // A goal going quiet says so; a goal still active says nothing.
    await status({ goal: { objective: "ship", status: "active", percentComplete: 10 } });
    assert.deepEqual(shown, ["approval:s1", "finished:s1"]);
    await status({ goal: { objective: "ship", status: "complete", percentComplete: 100 } });
    assert.deepEqual(shown, ["approval:s1", "finished:s1", "goal:s1"]);
    stop();
  });

  it("marks a read-only thread and refuses to send into it", async () => {
    const client = new FakeClient();
    client.transcript = async () => load({ readOnly: true, readOnlyReason: "session is loaded by another host" });
    const { controller, stop } = await started(client);
    assert.equal(controller.store.get().threads["s1"]?.readOnly, true);
    assert.equal(await controller.send("hello"), false);
    assert.equal(client.sent.length, 0);
    stop();
  });

  /**
   * The server's side of loading: a resume attaches the session to one of its hosts, a read in place never does, and
   * a read of a session none of its hosts holds comes back read-only with no reason given.
   */
  function hostLike(client: FakeClient): { hosted: boolean } {
    const host = { hosted: false };
    client.loadTranscript = async (_sessionId: string, options?: { refresh?: boolean }) => {
      client.transcriptOptions.push(options);
      if (options?.refresh) {
        return load({ readOnly: !host.hosted, readOnlyReason: null });
      }
      host.hosted = true;
      return load();
    };
    client.sendResult = async () => {
      if (!host.hosted) {
        throw new AncillaError("Session is not loaded", 409, "sessionNotLoaded");
      }
      return { turnId: "t9", disposition: "started" };
    };
    return host;
  }

  it("resumes a session its host unloaded when a send is refused, rather than reading it back read-only", async () => {
    const client = new FakeClient();
    const host = hostLike(client);
    const { controller, stop } = await started(client);
    try {
      assert.equal(host.hosted, true, "opening an idle thread resumes it");
      // Muse idles the session out, so the server forgets which host had it.
      host.hosted = false;
      client.handler?.({ type: "msp", sessionId: "s1", method: "session/closed", params: {}, at: 1 });
      controller.flush();
      assert.equal(controller.store.get().threads["s1"]?.fold.closed, true);
      assert.equal(await controller.send("hello again"), true);
      assert.deepEqual(client.transcriptOptions, [undefined, undefined], "the refused send resumes instead of reading");
      assert.equal(client.sent.length, 2, "the prompt the host refused goes once more, and only once");
      assert.equal(controller.store.get().threads["s1"]?.readOnly, false);
      // The hosts restart for a settings change, which drops the binding again.
      host.hosted = false;
      client.handler?.({ type: "host", key: "k", state: "restarted", message: "restarted" });
      await settle();
      assert.equal(await controller.send("and again"), true);
      assert.equal(client.sent.length, 4);
      assert.equal(controller.store.get().threads["s1"]?.readOnly, false);
    } finally {
      stop();
    }
  });

  it("resumes an idle session on reload even after a recovery was recorded for it, so Take over works", async () => {
    const client = new FakeClient();
    const host = hostLike(client);
    const { controller, stop } = await started(client);
    try {
      await controller.retryStalledThread("s1");
      host.hosted = false;
      client.handler?.({ type: "msp", sessionId: "s1", method: "session/closed", params: {}, at: 1 });
      controller.flush();
      await controller.loadThread("s1");
      assert.deepEqual(client.transcriptOptions, [undefined, undefined, undefined], "an idle thread is never read in place");
      assert.equal(controller.store.get().threads["s1"]?.readOnly, false);
      assert.equal(host.hosted, true);
    } finally {
      stop();
    }
  });

  it("keeps the composer open when a read in place reports read-only without saying why", async () => {
    const client = new FakeClient();
    const session: SessionSummary = {
      ...SESSION,
      live: { activeTurnId: "live-1", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null },
    };
    client.listSessions = async () => [session];
    const running = (readOnly: boolean, readOnlyReason: string | null): TranscriptLoad => load({
      session,
      msp: { status: "running", activeTurnId: "live-1", modelId: "muse-spark-1.3", approvalMode: "onRequest", workspaceRoot: "/work/app", turnCount: 4 },
      events: [...historyEvents, { method: "turn/started", params: { turnId: "live-1" }, at: 1 }],
      readOnly,
      readOnlyReason,
    });
    // A fresh page reads the running session in place; a server with no host of its own for it says so, bare.
    client.transcript = async () => running(true, null);
    const { controller, stop } = await started(client);
    try {
      assert.deepEqual(client.transcriptOptions, [{ refresh: true }]);
      assert.equal(controller.store.get().threads["s1"]?.readOnly, false, "a bare flag from a read is the server not knowing");
      await controller.loadThread("s1");
      assert.equal(controller.store.get().threads["s1"]?.readOnly, false);
      // Another client holding the session is a reason, and that still locks the composer.
      client.transcript = async () => running(true, "Another Muse session has it open.");
      await controller.loadThread("s1");
      assert.equal(controller.store.get().threads["s1"]?.readOnly, true);
      assert.equal(controller.store.get().threads["s1"]?.readOnlyReason, "Another Muse session has it open.");
      assert.equal(await controller.send("hello"), false);
      assert.equal(client.sent.length, 0);
    } finally {
      stop();
    }
  });

  it("runs slash commands, skills and shell lines instead of sending their text", async () => {
    const client = new FakeClient();
    client.skills = [
      { id: "bundled:plan", name: "plan", displayName: "plan", description: "Plan it.", shortDescription: null, scope: "bundled", activation: "on" },
      { id: "user:secret", name: "secret", displayName: "secret", description: "By hand.", shortDescription: null, scope: "user", activation: "user-invocable-only" },
    ];
    const { controller, stop } = await started(client);
    await controller.loadSkills("/work/app");
    assert.equal(controller.store.get().skills["/work/app"]?.status, "ready");

    assert.equal(await controller.send("/plan tidy the API"), true);
    assert.equal(client.sent.at(-1)?.displayText, "/plan tidy the API", "the transcript shows what was typed");
    assert.match(client.sent.at(-1)?.text ?? "", /read_skill with name "bundled:plan" first, then apply it to: tidy the API$/);
    assert.equal(await controller.send("/secret go"), true);
    assert.match(client.sent.at(-1)?.text ?? "", /<skill-body id="user:secret">\nInstructions for user:secret\.\n<\/skill-body>\n\ngo$/);

    assert.equal(await controller.send("/compact"), true);
    assert.equal(await controller.send("! git status"), true);
    assert.deepEqual(client.actions, ["compact", "shell-proxy:git status"], "Ancilla runs `!` itself now");
    client.compactNoop = true;
    assert.equal(await controller.send("/compact"), true);
    assert.equal(controller.store.get().toasts.at(-1)?.title, "Nothing to compact yet");
    assert.equal(controller.store.get().toasts.at(-1)?.detail, "There is no earlier history to summarize.");

    assert.equal(await controller.send("/effort high"), true);
    assert.equal(controller.store.get().prefs.effort, "high");
    assert.equal(await controller.send("/model"), true);
    assert.equal(controller.store.get().picker, "model");
    assert.equal(await controller.send("/permissions full"), true);
    assert.equal(controller.store.get().picker, "confirmFullAccess", "full access still asks first");
    controller.closePicker("permissions");
    assert.equal(controller.store.get().picker, "confirmFullAccess", "a menu closing after the hand-off leaves the dialog open");

    const before = client.sent.length;
    assert.equal(await controller.send("/deploy now"), false);
    assert.equal(controller.store.get().toasts.at(-1)?.title, "No command named /deploy");
    assert.equal(client.sent.length, before);
    assert.equal(await controller.send("/deploy now", { raw: true }), true);
    assert.equal(client.sent.at(-1)?.text, "/deploy now");
    assert.equal(await controller.send("/usr/bin/node crashes on start"), true, "a path is a prompt, not a command");
    assert.equal(client.sent.at(-1)?.text, "/usr/bin/node crashes on start");
    stop();
  });

  it("waits for a workspace's skills when a skill is sent before they load", async () => {
    const client = new FakeClient();
    client.skills = [
      { id: "bundled:git", name: "git", displayName: "git", description: "Git safety.", shortDescription: null, scope: "bundled", activation: "on" },
    ];
    const { controller, stop } = await started(client);
    assert.equal(controller.store.get().skills["/work/app"], undefined);
    assert.equal(await controller.send("/git reply ok"), true);
    assert.equal(client.sent.at(-1)?.displayText, "/git reply ok");
    assert.equal(controller.store.get().skills["/work/app"]?.status, "ready");
    stop();
  });

  it("sets, pauses, resumes and clears goals through Muse's goal commands", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("/goal Ship the release"), true);
    assert.deepEqual(client.actions.at(-1), "goal:s1:set:Ship the release");
    assert.equal(client.sent.length, 0, "no prompt goes to the model: the goal command starts the work");
    assert.equal(await controller.send("/goal pause"), true);
    assert.equal(client.actions.at(-1), "goal:s1:pause");
    assert.equal(await controller.send("/goal Clear"), true, "the verbs are not case-sensitive");
    assert.equal(client.actions.at(-1), "goal:s1:clear");

    assert.equal(await controller.send("/goal"), false);
    assert.equal(controller.store.get().toasts.at(-1)?.title, "Add the goal after /goal");

    // A paused goal resumes through goal/resume; a blocked one still gets a prompt to keep going.
    assert.equal(await controller.continueGoal("s1", "Ship the release", "paused"), true);
    assert.equal(client.actions.at(-1), "goal:s1:resume");
    assert.equal(await controller.continueGoal("s1", "Ship the release", "blocked"), true);
    assert.equal(client.sent.at(-1)?.displayText, "Keep working on the goal");

    assert.equal(await controller.goalAction("s1", "edit", "Ship 0.11"), true);
    assert.equal(client.actions.at(-1), "goal:s1:edit:Ship 0.11");
    stop();
  });

  it("falls back to asking the model for a goal on a host without goal commands", async () => {
    const client = new FakeClient();
    client.goalError = new AncillaError("no such method", 409, "methodNotFound");
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("/goal Ship the release"), true);
    assert.equal(client.sent.at(-1)?.displayText, "/goal Ship the release");
    assert.match(client.sent.at(-1)?.text ?? "", /create_goal tool\. Objective: Ship the release/);

    client.goalError = new AncillaError("goal is finished", 409, "goalNotPaused");
    assert.equal(await controller.goalAction("s1", "pause"), false);
    assert.equal(controller.store.get().toasts.at(-1)?.title, "Could not pause the goal");
    stop();
  });

  it("puts the open thread on the chosen effort, and leaves it be on auto", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("/effort low"), true);
    await settle();
    assert.deepEqual(client.efforts, ["s1:low"]);
    controller.setEffort(null);
    await settle();
    assert.deepEqual(client.efforts, ["s1:low"], "auto keeps the thread's own level");
    assert.equal(controller.store.get().prefs.effort, null);
    stop();
  });

  it("controls background tasks, subagents and workflow children", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.taskAction("s1", "background", "item-2"), true);
    assert.equal(await controller.taskAction("s1", "stop", "item-2"), true);
    assert.equal(await controller.taskAction("s1", "stopAll"), true);
    assert.equal(await controller.subagentAction("s1", "sendMessage", "sa1", "use pnpm"), true);
    assert.equal(await controller.workflowAction("s1", "retry", "run-1", { childId: "c1", attempt: 2 }), true);
    assert.deepEqual(client.actions, [
      "task:s1:background:item-2",
      "task:s1:stop:item-2",
      "task:s1:stopAll",
      "subagent:s1:sendMessage:sa1:use pnpm",
      "workflow:s1:retry:run-1:c1@2",
    ]);

    client.workflowError = new AncillaError("stale", 409, "stale_attempt");
    assert.equal(await controller.workflowAction("s1", "skip", "run-1", { childId: "c1", attempt: 1 }), false);
    assert.equal(controller.store.get().toasts.at(-1)?.title, "That agent already moved on");
    stop();
  });

  it("keeps the newest plan usage from boot and from the event stream", async () => {
    const client = new FakeClient();
    const reading = (percent: number, at: number) => ({
      tier: "high",
      observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: at + 1, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: at + 2, windowDurationMins: null },
    });
    client.plan = reading(20, 100);
    const { controller, stop } = await started(client);
    assert.equal(controller.store.get().planUsage?.window.usedPercent, 20);
    client.handler?.({ type: "plan-usage", usage: reading(35, 200), accountId: null });
    assert.equal(controller.store.get().planUsage?.window.usedPercent, 35);
    client.handler?.({ type: "plan-usage", usage: reading(1, 150), accountId: null });
    assert.equal(controller.store.get().planUsage?.window.usedPercent, 35, "an older reading does not replace a newer one");
    stop();
  });

  it("keeps subscription source and saved state, and removes invalidated account readings", async () => {
    const client = new FakeClient();
    client.plan = { tier: "high", observedAtMs: 200,
      window: { usedPercent: 125, resetsAtMs: 500, windowDurationMins: 300 },
      weekly: { usedPercent: 4, resetsAtMs: 900, windowDurationMins: null } };
    client.planByAccount = { work: client.plan };
    client.planMetadata = { accountId: "work", saved: true, status: "no-host" };
    const { controller, stop } = await started(client);
    assert.equal(controller.store.get().planUsageAccountId, "work");
    assert.equal(controller.store.get().planUsageSaved, true);
    assert.equal(controller.store.get().planUsageStatus, "no-host");
    assert.equal(controller.store.get().planUsageLoading, false);
    client.planError = new Error("offline");
    await controller.loadPlanUsage();
    assert.equal(controller.store.get().planUsageStatus, "unavailable");
    assert.equal(controller.store.get().planUsage?.window.usedPercent, 125, "a failed refresh retains the last observation");
    client.planError = null;
    client.plan = null;
    client.planByAccount = {};
    client.planMetadata = { accountId: null, saved: false, status: "no-host" };
    await controller.loadPlanUsage();
    assert.equal(controller.store.get().planUsage, null, "a login change can invalidate a saved observation");
    assert.deepEqual(controller.store.get().planUsageByAccount, {});
    assert.equal(controller.store.get().planUsageSaved, false);
    stop();
  });

  it("does not let a delayed subscription refresh relabel a newer live reading as saved or unavailable", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const reading = (percent: number, at: number) => ({ tier: "high", observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: at + 5000, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: at + 9000, windowDurationMins: null } });
    let finish!: (report: import("../src/types.js").PlanUsageReport) => void;
    client.planUsage = () => new Promise((resolve) => { finish = resolve; });
    const refresh = controller.loadPlanUsage();
    client.handler?.({ type: "plan-usage", usage: reading(45, 300), accountId: "personal" });
    finish({ usage: reading(20, 200), byAccount: { work: reading(20, 200) },
      accountId: "work", saved: true, savedAccountIds: ["work"], status: "unavailable" });
    await refresh;
    assert.equal(controller.store.get().planUsage?.window.usedPercent, 45);
    assert.equal(controller.store.get().planUsageAccountId, "personal");
    assert.equal(controller.store.get().planUsageSaved, false);
    assert.equal(controller.store.get().planUsageStatus, "ready");
    assert.deepEqual(controller.store.get().planUsageSavedAccounts, ["work"], "the older account reading still carries its saved provenance");
    assert.equal(controller.store.get().planUsageLoading, false);
    stop();
  });

  it("keeps per-account plan usage from the event stream, and still keeps the global reading", async () => {
    const client = new FakeClient();
    const reading = (percent: number, at: number) => ({
      tier: "high",
      observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: at + 1, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: at + 2, windowDurationMins: null },
    });
    const { controller, stop } = await started(client);
    client.handler?.({ type: "plan-usage", usage: reading(40, 300), accountId: "work" });
    assert.equal(controller.store.get().planUsageByAccount["work"]?.window.usedPercent, 40);
    assert.equal(controller.store.get().planUsage?.window.usedPercent, 40, "a per-account reading still updates the global");
    client.handler?.({ type: "plan-usage", usage: reading(10, 250), accountId: "work" });
    assert.equal(
      controller.store.get().planUsageByAccount["work"]?.window.usedPercent,
      40,
      "an older per-account reading does not replace a newer one",
    );
    stop();
  });

  it("merges per-account plan usage from the boot load", async () => {
    const client = new FakeClient();
    client.planByAccount = {
      work: {
        tier: "high",
        observedAtMs: 500,
        window: { usedPercent: 60, resetsAtMs: 501, windowDurationMins: 300 },
        weekly: { usedPercent: 5, resetsAtMs: 502, windowDurationMins: null },
      },
    };
    const { controller, stop } = await started(client);
    assert.equal(controller.store.get().planUsageByAccount["work"]?.window.usedPercent, 60);
    stop();
  });

  it("does not let a stale boot-load snapshot clobber a fresher per-account reading", async () => {
    const client = new FakeClient();
    const reading = (percent: number, at: number) => ({
      tier: "high",
      observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: at + 1, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: at + 2, windowDurationMins: null },
    });
    const { controller, stop } = await started(client);
    client.handler?.({ type: "plan-usage", usage: reading(77, 200), accountId: "work" });
    assert.equal(controller.store.get().planUsageByAccount["work"]?.window.usedPercent, 77);
    client.planByAccount = { work: reading(10, 100) };
    await controller.loadPlanUsage();
    assert.equal(
      controller.store.get().planUsageByAccount["work"]?.window.usedPercent,
      77,
      "a stale byAccount snapshot from a boot GET does not replace a newer event-derived reading",
    );
    stop();
  });

  it("loads the account list and creates an account", async () => {
    const client = new FakeClient();
    const controller = new AncillaController(client, platform());
    await controller.loadAccounts();
    assert.deepEqual(controller.store.get().accounts?.map((a) => a.id), []);
    assert.equal(await controller.createAccount("work", "Work"), true);
    assert.ok(client.accountCalls.some((c) => c.kind === "create" && c.id === "work"));
    assert.deepEqual(controller.store.get().accounts?.map((a) => a.id), ["work"]);
  });

  it("flips metaApiKeyInherited when the client reports it", async () => {
    const client = new FakeClient();
    const controller = new AncillaController(client, platform());
    assert.equal(controller.store.get().metaApiKeyInherited, false);
    client.metaApiKeyInherited = true;
    await controller.loadAccountsHealth();
    assert.equal(controller.store.get().metaApiKeyInherited, true);
  });

  it("refreshes metaApiKeyInherited as part of loadAccounts", async () => {
    const client = new FakeClient();
    client.metaApiKeyInherited = true;
    const controller = new AncillaController(client, platform());
    await controller.loadAccounts();
    await settle();
    assert.equal(controller.store.get().metaApiKeyInherited, true);
  });

  it("begins a device-code login, waits, then flips to done once hasLogin turns true", async () => {
    const client = new FakeClient();
    client.accounts = [{ id: "work", name: "Work", hasLogin: false, email: null, lastUsedAt: null }];
    const controller = new AncillaController(client, platform());

    const login = controller.beginLogin("work");
    // The modal opens right away with an empty marker, before the server has answered.
    const pending = controller.store.get().accountLogin;
    assert.equal(pending?.accountId, "work");

    await login;
    const waiting = controller.store.get().accountLogin;
    assert.ok(waiting && "status" in waiting && waiting.status === "waiting", "resolves to the waiting device shape");
    assert.equal((waiting as { url: string }).url, "https://auth.meta.com/oauth/device/?code=TEST-CODE");
    assert.equal((waiting as { code: string | null }).code, "TEST-CODE");
    assert.equal(client.loginAccountCalls.length, 1);

    const account = client.accounts.find((a) => a.id === "work");
    assert.ok(account);
    account.hasLogin = true;

    await settle();
    const done = controller.store.get().accountLogin;
    assert.ok(done && "status" in done && done.status === "done", "the poll flips status to done once hasLogin is true");
  });

  it("stores the fallback shape when the login route reports one", async () => {
    const client = new FakeClient();
    client.accounts = [{ id: "work", name: "Work", hasLogin: false, email: null, lastUsedAt: null }];
    client.loginAccountResult = { fallback: "In-app login is not available when Muse runs in WSL." };
    const controller = new AncillaController(client, platform());

    await controller.beginLogin("work");
    const login = controller.store.get().accountLogin;
    assert.ok(login && !("status" in login));
    assert.equal((login as { fallback: string }).fallback, "In-app login is not available when Muse runs in WSL.");
  });

  it("cancelLogin clears the state and stops the poll", async () => {
    const client = new FakeClient();
    client.accounts = [{ id: "work", name: "Work", hasLogin: false, email: null, lastUsedAt: null }];
    const controller = new AncillaController(client, platform());

    await controller.beginLogin("work");
    assert.ok(controller.store.get().accountLogin);

    controller.cancelLogin();
    assert.equal(controller.store.get().accountLogin, null);

    // The poll must not resurrect state after cancel, and must not call loginAccount again.
    const account = client.accounts.find((a) => a.id === "work");
    assert.ok(account);
    account.hasLogin = true;
    await settle();
    assert.equal(controller.store.get().accountLogin, null);
    assert.equal(client.loginAccountCalls.length, 1);
  });

  it("confirms default subscription sign-in from its own process without a named profile", async () => {
    const client = new FakeClient();
    client.loginAccountResult = { url: "https://auth.meta.com/oauth/device/?code=TEST-CODE", code: "TEST-CODE", loginId: "default-attempt" };
    let status: "waiting" | "done" = "waiting";
    client.accountLoginProgress = async (id, loginId) => {
      assert.equal(id, null);
      assert.equal(loginId, "default-attempt");
      return { status };
    };
    const controller = new AncillaController(client, { ...platform(), schedule: () => 0 });
    await controller.beginLogin(null);
    await controller.checkLogin();
    assert.equal((controller.store.get().accountLogin as { status: string }).status, "waiting");
    status = "done";
    await controller.checkLogin();
    assert.equal((controller.store.get().accountLogin as { status: string }).status, "done");
    assert.deepEqual(client.accounts, []);
    controller.cancelLogin();
    assert.deepEqual(client.cancelledLoginCalls, [], "closing confirmed sign-in does not cancel it");
  });

  it("does not confuse an existing credential with completion of a new browser sign-in", async () => {
    const client = new FakeClient();
    client.accounts = [{ id: "work", name: "Work", hasLogin: true, email: "old@example.test", lastUsedAt: null }];
    client.loginAccountResult = { url: "https://auth.meta.com/?code=NEW-CODE", code: "NEW-CODE", loginId: "new-attempt" };
    client.accountLoginProgress = async () => ({ status: "waiting" });
    const controller = new AncillaController(client, { ...platform(), schedule: () => 0 });
    await controller.loadAccounts();
    await controller.beginLogin("work");
    await controller.checkLogin();
    assert.equal((controller.store.get().accountLogin as { status: string }).status, "waiting");
    controller.cancelLogin();
    assert.deepEqual(client.cancelledLoginCalls, [{ id: "work", loginId: "new-attempt" }]);
  });

  it("keeps a failed sign-in visible with a retry action instead of dismissing the dialog", async () => {
    const client = new FakeClient();
    client.loginAccount = async () => { throw new Error("Muse could not start sign-in."); };
    const controller = new AncillaController(client, { ...platform(), schedule: () => 0 });
    await controller.beginLogin(null);
    const login = controller.store.get().accountLogin;
    assert.ok(login && "status" in login);
    assert.equal(login.status, "error");
    assert.match(login.message ?? "", /could not start/);
    assert.equal(controller.store.get().toasts.length, 0);
  });

  it("recovers a temporarily unreachable login check without starting another browser flow", async () => {
    const client = new FakeClient();
    client.loginAccountResult = { url: "https://auth.meta.com/?code=TEST-CODE", code: "TEST-CODE", loginId: "attempt" };
    client.accountLoginProgress = async () => { throw new Error("offline"); };
    const controller = new AncillaController(client, { ...platform(), schedule: () => 0 });
    await controller.beginLogin(null);
    await controller.checkLogin();
    assert.equal((controller.store.get().accountLogin as { status: string }).status, "timeout");
    client.accountLoginProgress = async () => ({ status: "done" });
    await controller.checkLogin();
    assert.equal((controller.store.get().accountLogin as { status: string }).status, "done");
    assert.equal(client.loginAccountCalls.length, 1);
    controller.cancelLogin();
  });

  it("makes the end of automatic sign-in checking explicit and lets the user check again", async () => {
    const client = new FakeClient();
    client.loginAccountResult = { url: "https://auth.meta.com/?code=TEST-CODE", code: "TEST-CODE", loginId: "attempt" };
    client.accountLoginProgress = async () => ({ status: "waiting" });
    let next: (() => void) | null = null;
    const controller = new AncillaController(client, {
      ...platform(),
      schedule: (fn) => { next = fn; return fn; },
      cancel: () => { next = null; },
    });
    await controller.beginLogin(null);
    for (let check = 0; check < 300; check += 1) {
      assert.ok(next, "a waiting login keeps scheduling checks");
      const tick: () => void = next;
      next = null;
      tick();
      await Promise.resolve();
      await Promise.resolve();
    }
    const timedOut = controller.store.get().accountLogin;
    assert.ok(timedOut && "status" in timedOut);
    assert.equal(timedOut.status, "timeout");
    assert.match(timedOut.message ?? "", /check again/);
    assert.equal(next, null);
    client.accountLoginProgress = async () => ({ status: "done" });
    await controller.checkLogin();
    assert.equal((controller.store.get().accountLogin as { status: string }).status, "done");
    controller.cancelLogin();
  });

  it("cancels a login link that arrives after its dialog was closed", async () => {
    const client = new FakeClient();
    let resolveLogin!: (result: import("../src/types.js").AccountLoginResult) => void;
    client.loginAccount = () => new Promise((resolve) => { resolveLogin = resolve; });
    const controller = new AncillaController(client, { ...platform(), schedule: () => 0 });
    const pending = controller.beginLogin(null);
    controller.cancelLogin();
    resolveLogin({ url: "https://auth.meta.com/?code=OLD-CODE", code: "OLD-CODE", loginId: "closed-attempt" });
    await pending;
    assert.equal(controller.store.get().accountLogin, null);
    assert.deepEqual(client.cancelledLoginCalls, [{ id: null, loginId: "closed-attempt" }]);
  });

  it("renames and removes accounts, reloading the list each time", async () => {
    const client = new FakeClient();
    client.accounts = [{ id: "default", name: "Default", hasLogin: true, email: "a@b.com", lastUsedAt: null }];
    const { controller, stop } = await started(client);
    assert.deepEqual(controller.store.get().accounts?.map((a) => a.id), ["default"]);

    assert.equal(await controller.createAccount("work", "Work"), true);
    assert.deepEqual(controller.store.get().accounts?.map((a) => a.id), ["default", "work"]);

    assert.equal(await controller.renameAccount("work", "Work Account"), true);
    assert.equal(controller.store.get().accounts?.find((a) => a.id === "work")?.name, "Work Account");

    assert.equal(await controller.removeAccount("work"), true);
    assert.deepEqual(controller.store.get().accounts?.map((a) => a.id), ["default"]);
    stop();
  });

  it("sets a project's default account optimistically, and rolls back on failure", async () => {
    const client = new FakeClient();
    client.projects = [{ cwd: "/work/app", displayName: "app", pinned: false, activityAt: SESSION.activityAt, defaultAccountId: null, folders: [{ cwd: "/work/app", displayName: "app" }] }];
    const { controller, stop } = await started(client);

    await controller.setProjectDefaultAccount("/work/app", "work");
    assert.equal(controller.store.get().projects.find((p) => p.cwd === "/work/app")?.defaultAccountId, "work");
    assert.ok(client.accountCalls.some((c) => c.kind === "default" && c.cwd === "/work/app" && c.accountId === "work"));

    client.setProjectDefaultAccount = async () => {
      throw new Error("nope");
    };
    await controller.setProjectDefaultAccount("/work/app", null);
    assert.equal(
      controller.store.get().projects.find((p) => p.cwd === "/work/app")?.defaultAccountId,
      "work",
      "a refused default rolls back",
    );
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not set the default account/);
    stop();
  });

  it("does not let a stale rollback clobber a newer overlapping default-account write", async () => {
    const client = new FakeClient();
    client.projects = [{ cwd: "/work/app", displayName: "app", pinned: false, activityAt: SESSION.activityAt, defaultAccountId: null, folders: [{ cwd: "/work/app", displayName: "app" }] }];
    const { controller, stop } = await started(client);

    client.setProjectDefaultAccountError = new Error("nope");
    // Fired without awaiting: the first PATCH is queued to fail, the second to succeed. The chain
    // means the server sees them in order, so the first's rejection lands after the second's optimism.
    const first = controller.setProjectDefaultAccount("/work/app", "alpha");
    const second = controller.setProjectDefaultAccount("/work/app", "beta");
    await Promise.all([first, second]);

    assert.equal(
      controller.store.get().projects.find((p) => p.cwd === "/work/app")?.defaultAccountId,
      "beta",
      "the second call's value stands; the stale rollback from the first call's failure is dropped",
    );
    assert.equal(
      controller.store.get().toasts.some((t) => /Could not set the default account/.test(t.title)),
      false,
      "a stale rollback does not toast either",
    );
    stop();
  });

  it("starts a new thread on the project's default account", async () => {
    const client = new FakeClient();
    client.projects = [{ cwd: "/work/app", displayName: "app", pinned: false, activityAt: SESSION.activityAt, defaultAccountId: "work", folders: [{ cwd: "/work/app", displayName: "app" }] }];
    const { controller, stop } = await started(client, "");
    controller.newThread("/work/app");
    assert.equal(await controller.send("hello"), true);
    assert.equal(client.startCalls.at(-1)?.accountId, "work");
    const route = controller.store.get().route;
    assert.equal(route.kind, "thread");
    const sessionId = route.kind === "thread" ? route.sessionId : "";
    assert.equal(controller.store.get().sessions[sessionId]?.accountId, "work", "the seeded session carries the account the server confirmed");
    stop();
  });

  it("starts a thread in a project's second folder on that project's default account", async () => {
    const client = new FakeClient();
    client.projects = [
      {
        cwd: "/work/app",
        displayName: "app",
        pinned: false,
        activityAt: SESSION.activityAt,
        defaultAccountId: "work",
        folders: [{ cwd: "/work/app", displayName: "app" }, { cwd: "/work/docs", displayName: "docs" }],
      },
    ];
    const { controller, stop } = await started(client, "");
    controller.newThread("/work/docs");
    assert.deepEqual(controller.store.get().route, { kind: "new", cwd: "/work/docs" }, "a project's folder is a place to start");
    assert.equal(await controller.send("hello"), true);
    assert.equal(client.startCalls.at(-1)?.cwd, "/work/docs", "the thread runs in the folder picked");
    assert.equal(client.startCalls.at(-1)?.accountId, "work", "on the owning project's account");
    controller.newThread("/work/elsewhere");
    assert.deepEqual(controller.store.get().route, { kind: "new", cwd: "/work/app" }, "a folder no project has falls back to the first project");
    stop();
  });

  it("adds and removes a project's folders, and refreshes every folder of a project", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client, "");
    assert.equal(await controller.addProjectFolder("/work/app", "/work/docs"), true);
    assert.deepEqual(client.folderCalls, ["add /work/app /work/docs"]);
    const project = () => controller.store.get().projects.find((p) => p.cwd === "/work/app");
    assert.deepEqual(project()?.folders.map((f) => f.cwd), ["/work/app", "/work/docs"]);
    assert.equal(controller.store.get().addProjectOpen, false, "the picker closes once the folder is in");

    client.discovered = [];
    await controller.refreshProject("/work/app");
    assert.deepEqual(client.discovered, ["/work/app", "/work/docs"], "each folder is its own Muse workspace");

    await controller.removeProjectFolder("/work/app", "/work/docs");
    assert.deepEqual(client.folderCalls.at(-1), "remove /work/app /work/docs");
    assert.deepEqual(project()?.folders.map((f) => f.cwd), ["/work/app"]);
    assert.deepEqual(
      controller.store.get().projects.map((p) => p.cwd),
      ["/work/app", "/work/docs"],
      "the folder comes back as a project of its own",
    );

    client.addProjectFolder = async () => {
      throw new Error("nope");
    };
    assert.equal(await controller.addProjectFolder("/work/app", "/work/other"), false);
    assert.equal(controller.store.get().toasts.at(-1)?.title, "Could not add that folder");
    stop();
  });

  it("takes a project's folders out of view with it", async () => {
    const client = new FakeClient();
    client.projects = [
      {
        cwd: "/work/other",
        displayName: "other",
        pinned: false,
        activityAt: SESSION.activityAt,
        defaultAccountId: null,
        folders: [{ cwd: "/work/other", displayName: "other" }, { cwd: "/work/app", displayName: "app" }],
      },
    ];
    const { controller, stop } = await started(client);
    assert.deepEqual(controller.store.get().route, { kind: "thread", sessionId: "s1" }, "a thread in the second folder is listed and open");
    await controller.hideProject("/work/other");
    assert.deepEqual(controller.store.get().route, { kind: "home" }, "hiding the project closes a thread in any of its folders");
    stop();
  });

  it("asks for the open thread's own skills and reloads them when Muse says they changed", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.loadSkills("/work/app");
    assert.deepEqual(client.skillSessions, ["s1"]);
    await controller.loadSkills("/work/app");
    assert.equal(client.skillSessions.length, 1, "a fresh list is reused");
    client.handler?.({ type: "msp", sessionId: "s1", method: "skill/changed", params: { sessionId: "s1" }, at: 1 });
    await settle();
    assert.equal(client.skillSessions.length, 2);
    stop();
  });

  it("opens files from paths in replies as tabs, and closes back to the tree", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const panel = () => controller.store.get().filePanels["s1"];
    assert.equal(controller.store.get().prefs.filesOpen, false);

    assert.equal(controller.openFile("s1", "/work/app/src/app.js:4-5"), true);
    assert.equal(controller.store.get().prefs.filesOpen, true, "opening a file shows the viewer");
    assert.deepEqual(panel(), { tabs: ["src/app.js"], active: "src/app.js", tree: false, line: { start: 4, end: 5 } });
    controller.openFile("s1", "README.md");
    controller.openFile("s1", "src/app.js");
    assert.deepEqual(panel()?.tabs, ["src/app.js", "README.md"], "an open file is not opened twice");
    assert.equal(panel()?.active, "src/app.js");

    controller.closeFile("s1", "src/app.js");
    assert.deepEqual(panel(), { tabs: ["README.md"], active: "README.md", tree: false, line: null });
    controller.closeFile("s1", "README.md");
    assert.deepEqual(panel(), { tabs: [], active: null, tree: true, line: null });
    assert.equal(controller.openFile("s1", "https://example.com"), false, "a web link is not a file");
    controller.toggleFiles();
    assert.equal(controller.store.get().prefs.filesOpen, false);
    stop();
  });

  it("saves a draft against the version it was opened at, and offers to overwrite a file that changed", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const key = "/work/app\nREADME.md";
    controller.setFileDraft("/work/app", "README.md", "# edited", 100);
    controller.setFileDraft("/work/app", "README.md", "# edited more", 999);
    assert.deepEqual(controller.store.get().fileDrafts[key], { content: "# edited more", baseMtimeMs: 100 }, "the base is where editing began");

    assert.equal(await controller.saveFile("/work/app", "README.md"), 200);
    assert.deepEqual(client.writes.at(-1), { path: "README.md", content: "# edited more", baseMtimeMs: 100 });
    assert.equal(controller.store.get().fileDrafts[key], undefined);
    assert.equal(controller.store.get().fileVersions[key], 1, "a view of the file reloads after a save");

    controller.setFileDraft("/work/app", "README.md", "# mine", 200);
    client.writeError = new AncillaError("changed", 409, "fileChanged");
    assert.equal(await controller.saveFile("/work/app", "README.md"), null);
    const toast = controller.store.get().toasts.at(-1);
    assert.equal(toast?.title, "This file changed on disk");
    assert.ok(controller.store.get().fileDrafts[key], "the edit is kept when the save is refused");
    toast?.action?.run();
    await settle();
    assert.deepEqual(client.writes.at(-1), { path: "README.md", content: "# mine", baseMtimeMs: null }, "overwrite skips the version check");
    stop();
  });

  it("reloads an open file when Muse edits it", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    client.handler?.({
      type: "msp",
      sessionId: "s1",
      method: "item/completed",
      params: {
        sessionId: "s1",
        item: {
          itemId: "e1",
          kind: "toolCall",
          status: "completed",
          revision: 2,
          tool: "edit",
          args: JSON.stringify({ path: "/work/app/src/app.js", old_string: "a", new_string: "b" }),
        },
      },
      at: 1,
    });
    await settle();
    controller.flush();
    assert.equal(controller.store.get().fileVersions["/work/app\nsrc/app.js"], 1);
    stop();
  });

  it("reads a tool's stored output page by page", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const first = await controller.readOutput("s1", "i1", "ref");
    assert.equal(first.eof, false);
    const next = await controller.readOutput("s1", "i1", "ref", first.offsetBytes + first.byteLen);
    assert.equal(next.eof, true);
    stop();
  });

  it("runs a `!` command itself and hands its output to Muse on request", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.send("!ls -la"), true);
    const run = controller.store.get().threads["s1"]?.shellRuns[0];
    assert.equal(run?.command, "ls -la");
    assert.ok(client.actions.includes("shell-proxy:ls -la"));

    assert.equal(await controller.sendShellOutput("s1", run!), true);
    const sent = client.sent.at(-1);
    assert.match(sent?.text ?? "", /I ran this in the workspace/);
    assert.match(sent?.text ?? "", /ran ls -la/);
    assert.equal(sent?.displayText, "Shared the output of `ls -la`");
    stop();
  });

  describe("deep research", () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    it("loads a thread's runs with its transcript, and leaves the list empty for a server without them", async () => {
      const client = new FakeClient();
      client.transcript = async () => load({ researchRuns: [fakeResearchRun({ status: "completed", phase: "done", reportAvailable: true })] });
      const { controller, stop } = await started(client);
      assert.equal(controller.store.get().threads["s1"]?.researchRuns.length, 1);
      assert.equal(controller.store.get().threads["s1"]?.researchRuns[0]?.status, "completed");
      stop();
      const plain = new FakeClient();
      const second = await started(plain);
      assert.deepEqual(second.controller.store.get().threads["s1"]?.researchRuns, []);
      second.stop();
    });

    it("starts a run with a minted UUID commandId, showing it queued before the server answers", async () => {
      const client = new FakeClient();
      let release: (() => void) | null = null;
      const original = client.startResearch.bind(client);
      client.startResearch = async (...args) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return original(...args);
      };
      const { controller, stop } = await started(client);
      const promise = controller.startResearch("s1", "  How is geothermal energy developing in Europe?  ", { maxParallel: 2 });
      await flushMicrotasks();
      const optimistic = controller.store.get().threads["s1"]?.researchRuns[0];
      assert.equal(optimistic?.status, "queued");
      assert.equal(optimistic?.question, "How is geothermal energy developing in Europe?");
      assert.match(optimistic?.runId ?? "", /^pending:/);
      assert.equal(optimistic?.config.maxParallel, 2, "the popover's overrides show on the optimistic row");
      assert.equal(optimistic?.config.maxRounds, 12, "the rest comes from the loaded defaults");
      (release as unknown as () => void)();
      assert.equal(await promise, true);
      const runs = controller.store.get().threads["s1"]?.researchRuns ?? [];
      assert.equal(runs.length, 1, "the optimistic row is replaced, not kept beside the real one");
      assert.match(runs[0]?.runId ?? "", /^run-1-/);
      const call = client.researchStarts[0];
      assert.equal(call?.sessionId, "s1");
      assert.equal(call?.question, "How is geothermal energy developing in Europe?");
      assert.deepEqual(call?.config, { maxParallel: 2 });
      assert.match(call?.commandId ?? "", UUID);
      stop();
    });

    it("drops the optimistic row and says so when the server refuses the run", async () => {
      const client = new FakeClient();
      client.startResearchError = new AncillaError("This thread already has a research run going.", 409);
      const { controller, stop } = await started(client);
      assert.equal(await controller.startResearch("s1", "anything"), false);
      assert.deepEqual(controller.store.get().threads["s1"]?.researchRuns, []);
      assert.equal(controller.store.get().toasts.at(-1)?.title, "Could not start the research run");
      stop();
    });

    it("refuses a second run while one is live, and any run while the setting is off", async () => {
      const client = new FakeClient();
      const { controller, stop } = await started(client);
      assert.equal(await controller.startResearch("s1", "first"), true);
      assert.equal(await controller.startResearch("s1", "second"), false);
      assert.equal(client.researchStarts.length, 1);
      assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /already going/);
      controller.store.set((s) => ({ ...s, researchSettings: { enabled: false, config: fakeResearchRun({}).config } }));
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "run-1-" + client.researchStarts[0]!.commandId.slice(0, 4), status: "cancelled", phase: "done" }) });
      assert.equal(await controller.startResearch("s1", "third"), false);
      assert.equal(controller.store.get().toasts.at(-1)?.title, "Deep research is off");
      stop();
    });

    it("merges research-run events by runId, newest winning, and keeps a report already read", async () => {
      const client = new FakeClient();
      const { controller, stop } = await started(client);
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 1 }) });
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r2", round: 1, createdAt: "2026-09-26T00:05:00.000Z" }) });
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 3, phase: "writing" }) });
      const runs = controller.store.get().threads["s1"]?.researchRuns ?? [];
      assert.deepEqual(runs.map((r) => [r.runId, r.round, r.phase]), [["r1", 3, "writing"], ["r2", 1, "researching"]]);
      // A thread this app has not opened keeps nothing: it reads its runs when opened.
      client.handler?.({ type: "research-run", sessionId: "elsewhere", run: fakeResearchRun({ runId: "r9", sessionId: "elsewhere" }) });
      assert.equal(controller.store.get().threads["elsewhere"], undefined);
      // The report, once read, survives the summaries the stream keeps sending.
      client.researchRuns.push(fakeResearchRun({ runId: "r1", status: "completed", phase: "done", reportAvailable: true }));
      assert.equal(await controller.openResearchReport("r1"), true);
      assert.match(controller.store.get().threads["s1"]?.researchRuns[0]?.report ?? "", /^# Report/);
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", status: "completed", phase: "done", reportAvailable: true, report: null }) });
      assert.match(controller.store.get().threads["s1"]?.researchRuns[0]?.report ?? "", /^# Report/);
      stop();
    });

    it("chooses a destination before rendering each report format, including with a desktop updater", async () => {
      const client = new FakeClient();
      const saves: { name: string; extension: string; mimeType: string; bytes: string }[] = [];
      const shell = platform("#/t/s1");
      shell.saveFile = async (options, contents) => {
        assert.equal(client.exports.length, saves.length, "the dialog opens before the server renders a file");
        assert.equal(controller.store.get().busy["research-export:r1"], true);
        await controller.exportResearchReport("s1", "r1", "html");
        assert.equal(client.exports.length, saves.length, "a second click cannot open a second dialog");
        const bytes = new TextDecoder().decode(await contents());
        saves.push({ name: options.name, extension: options.extension, mimeType: options.mimeType, bytes });
        return { kind: "saved", name: `chosen.${options.extension}`, path: `/chosen/chosen.${options.extension}` };
      };
      const controller = new AncillaController(client, shell);
      const stop = controller.start();
      await settle();
      await settle();
      await controller.exportResearchReport("s1", "r1", "pdf");
      assert.deepEqual(client.exports, [{ runId: "r1", format: "pdf" }]);
      assert.equal(controller.store.get().toasts.at(-1)?.title, "Saved chosen.pdf");
      assert.equal(controller.store.get().toasts.at(-1)?.detail, "/chosen/chosen.pdf");
      assert.equal(controller.store.get().busy["research-export:r1"], undefined, "the export is no longer busy");

      // Having an updater must not bypass destination selection on the desktop.
      controller.attachUpdater({
        currentVersion: async () => "0.19.1",
        check: async () => null,
        download: async () => {},
        install: async () => {},
        relaunch: async () => {},
        onClose: () => () => {},
      });
      await controller.exportResearchReport("s1", "r1", "docx");
      await controller.exportResearchReport("s1", "r1", "html");
      assert.deepEqual(saves, [
        { name: "report.pdf", extension: "pdf", mimeType: "application/pdf", bytes: "report.pdf" },
        { name: "report.docx", extension: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: "report.docx" },
        { name: "report.html", extension: "html", mimeType: "text/html", bytes: "report.html" },
      ]);
      assert.deepEqual(client.exportReads, client.exports);
      assert.deepEqual(client.openedFiles, []);

      client.exportFails = "The run has no report to export.";
      await controller.exportResearchReport("s1", "r1", "html");
      assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not export the report as HTML/);
      assert.equal(controller.store.get().toasts.at(-1)?.detail, "The run has no report to export.");
      assert.equal(client.exportReads.length, 3, "a failed export never attempts to download old bytes");
      stop();
    });

    it("cancels an export without rendering, writing or reporting success, and reports save failures", async () => {
      const client = new FakeClient();
      const shell = platform("#/t/s1");
      const controller = new AncillaController(client, shell);
      shell.saveFile = async () => null;
      await controller.exportResearchReport("s1", "r1", "pdf");
      assert.deepEqual(client.exports, []);
      assert.deepEqual(client.exportReads, []);
      assert.equal(controller.store.get().toasts.length, 0);
      assert.equal(controller.store.get().busy["research-export:r1"], undefined);

      shell.saveFile = async (_options, contents) => {
        await contents();
        throw new Error("The destination is not writable.");
      };
      await controller.exportResearchReport("s1", "r1", "docx");
      assert.equal(controller.store.get().toasts.at(-1)?.title, "Could not export the report as Word");
      assert.equal(controller.store.get().toasts.at(-1)?.detail, "The destination is not writable.");
      assert.equal(controller.store.get().busy["research-export:r1"], undefined);
    });

    it("explains a browser-controlled fallback download instead of claiming a file was saved", async () => {
      const client = new FakeClient();
      const shell = platform();
      shell.saveFile = async (options, contents) => {
        await contents();
        return { kind: "download", name: options.name };
      };
      const controller = new AncillaController(client, shell);
      await controller.exportResearchReport("s1", "r1", "html");
      assert.equal(controller.store.get().toasts.at(-1)?.title, "Downloading report.html");
      assert.match(controller.store.get().toasts.at(-1)?.detail ?? "", /browser controls the save location/);
    });

    it("stops a run, with or without a report, and shows the server's answer", async () => {
      const client = new FakeClient();
      const { controller, stop } = await started(client);
      assert.equal(await controller.startResearch("s1", "first"), true);
      const runId = controller.store.get().threads["s1"]!.researchRuns[0]!.runId;
      assert.equal(await controller.stopResearch(runId, true), true);
      assert.deepEqual(client.researchStops, [{ runId, writeReport: true }]);
      assert.equal(controller.store.get().threads["s1"]?.researchRuns[0]?.status, "partial");
      assert.equal(await controller.stopResearch("missing", false), false);
      assert.equal(controller.store.get().toasts.at(-1)?.title, "Could not stop the research run");
      stop();
    });

    it("says a run is stopping until the stream reports how it ended, and lets no stale answer undo that", async () => {
      const client = new FakeClient();
      const { controller, stop } = await started(client);
      const runs = () => controller.store.get().threads["s1"]?.researchRuns ?? [];
      const stopping = () => controller.store.get().researchStopping;
      assert.equal(await controller.startResearch("s1", "first"), true);
      const first = client.researchRuns[0]!;
      // The stop route answers with the run as it was when the stop was taken: still running.
      client.stopResearch = async (runId, writeReport) => {
        client.researchStops.push({ runId, writeReport });
        return { ...first, status: "running" };
      };
      const pending = controller.stopResearch(first.runId, false);
      await flushMicrotasks();
      assert.equal(stopping()[first.runId], "now", "the row says it is stopping as soon as the stop is asked for");
      assert.equal(await pending, true);
      assert.equal(runs()[0]?.status, "running");
      assert.equal(stopping()[first.runId], "now", "a snapshot from before the run acted does not answer the stop");
      client.handler?.({ type: "research-run", sessionId: "s1", run: { ...first, status: "cancelled", phase: "done" } });
      assert.equal(runs()[0]?.status, "cancelled");
      assert.equal(stopping()[first.runId], undefined, "the outcome on the stream answers it");
      // The route's answer can also land after the stream has said how the run ended.
      assert.equal(await controller.startResearch("s1", "second"), true);
      const second = client.researchRuns[1]!;
      client.stopResearch = async (runId, writeReport) => {
        client.researchStops.push({ runId, writeReport });
        client.handler?.({ type: "research-run", sessionId: "s1", run: { ...second, status: "cancelled", phase: "done" } });
        return { ...second, status: "running" };
      };
      assert.equal(await controller.stopResearch(second.runId, true), true);
      assert.equal(runs()[1]?.status, "cancelled", "the stream's cancelled outlives the route's stale running");
      assert.equal(stopping()[second.runId], undefined);
      // A stop the server refused leaves the run as it was, with its Stop back.
      client.handler?.({ type: "research-run", sessionId: "s1", run: { ...second, runId: "r-third" } });
      client.stopResearch = async () => {
        throw new AncillaError("No such research run.", 404);
      };
      assert.equal(await controller.stopResearch("r-third", false), false);
      assert.equal(stopping()["r-third"], undefined);
      assert.equal(controller.store.get().toasts.at(-1)?.title, "Could not stop the research run");
      // A stop the stream never answered, because the connection dropped, is answered when the thread reloads.
      controller.store.set((s) => ({ ...s, researchStopping: { "r-third": "now" } }));
      client.transcript = async () => load({ researchRuns: [fakeResearchRun({ runId: "r-third", status: "cancelled", phase: "done" })] });
      await controller.loadThread("s1");
      assert.equal(stopping()["r-third"], undefined);
      assert.equal(runs()[0]?.status, "cancelled");
      stop();
    });

    it("keeps the more advanced picture of a live run whichever arrives last, and an ending over any live one", async () => {
      const client = new FakeClient();
      const { controller, stop } = await started(client);
      const run = () => controller.store.get().threads["s1"]?.researchRuns[0];
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 3 }) });
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 2 }) });
      assert.equal(run()?.round, 3, "a stale event does not take the row back a round");
      client.researchRuns.push(fakeResearchRun({ runId: "r1", round: 2, brief: "stale" }));
      assert.equal(await controller.openResearchReport("r1"), true);
      assert.equal(run()?.round, 3, "nor does a stale read");
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 3, brief: "fresher" }) });
      assert.equal(run()?.brief, "fresher", "level on progress, the later arrival wins");
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 3, status: "cancelled", phase: "done" }) });
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 3, phase: "writing" }) });
      assert.equal(run()?.status, "cancelled", "nothing said afterwards reopens a run that has ended");
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 3, status: "partial", phase: "done", reportAvailable: true }) });
      assert.equal(run()?.status, "partial", "one ending can still correct another");
      stop();
    });

    it("arms research mode from the chord only where a composer would show it, and drops it on leaving", async () => {
      const client = new FakeClient();
      const { controller, stop } = await started(client);
      const armed = () => controller.store.get().researchMode;
      controller.toggleResearchMode();
      assert.equal(armed(), true);
      controller.toggleResearchMode();
      assert.equal(armed(), false, "the chord disarms what it armed");
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1" }) });
      controller.toggleResearchMode();
      assert.equal(armed(), false, "not while a run is going in the thread");
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", status: "completed", phase: "done" }) });
      controller.store.set((s) => ({ ...s, researchSettings: { enabled: false, config: fakeResearchRun({}).config } }));
      controller.toggleResearchMode();
      assert.equal(armed(), false, "not with the feature off");
      controller.store.set((s) => ({ ...s, researchSettings: { enabled: true, config: fakeResearchRun({}).config } }));
      controller.store.set((s) => ({ ...s, threads: { ...s.threads, s1: { ...s.threads["s1"]!, readOnly: true, readOnlyReason: "Another Muse session has it open." } } }));
      controller.toggleResearchMode();
      assert.equal(armed(), false, "not in a read-only thread");
      controller.store.set((s) => ({ ...s, threads: { ...s.threads, s1: { ...s.threads["s1"]!, readOnly: false, readOnlyReason: null } } }));
      controller.toggleResearchMode();
      assert.equal(armed(), true);
      controller.navigate({ kind: "settings" });
      assert.equal(armed(), false, "leaving the composer disarms it");
      controller.toggleResearchMode();
      assert.equal(armed(), false, "the settings page has no composer");
      controller.newThread("/work/app");
      controller.toggleResearchMode();
      assert.equal(armed(), true, "the new-thread composer has the button too");
      controller.setResearchMode(false);
      controller.store.set((s) => ({ ...s, projects: [] }));
      controller.toggleResearchMode();
      assert.equal(armed(), false, "without a project there is no composer yet");
      stop();
    });

    it("disarms research mode once the question has gone out, and keeps the typed options", async () => {
      const client = new FakeClient();
      const { controller, stop } = await started(client);
      controller.setResearchMode(true);
      controller.setResearchTyped({ parallel: "4" });
      assert.equal(await controller.research("what changed in WCAG 2.2?", { maxParallel: 4 }, "s1"), true);
      assert.equal(controller.store.get().researchMode, false, "the next thing typed is a message again");
      assert.equal(controller.store.get().researchTyped.parallel, "4", "options outlive the run they were set for");
      assert.equal(client.researchStarts.at(-1)?.config?.maxParallel, 4);
      // From the new-thread screen the question names the thread it starts, cut to one line.
      let renamed: string | null = null;
      (client as unknown as { updateSession: (id: string, patch: { title?: string }) => Promise<typeof SESSION> }).updateSession = async (_id, patch) => {
        renamed = patch.title ?? null;
        return { ...SESSION, ...patch };
      };
      controller.newThread("/work/app");
      assert.equal(await controller.research("what changed in WCAG 2.2 and why does it matter for muted text in dark themes now", null, null), true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(renamed, "what changed in WCAG 2.2 and why does it matter for muted text in dark…");
      stop();
    });

    it("routes /research to a run in the open thread, and starts a thread for it from the new-thread screen", async () => {
      const client = new FakeClient();
      const { controller, stop } = await started(client);
      assert.equal(await controller.send("/research how is geothermal developing in Europe?"), true);
      assert.equal(client.researchStarts.at(-1)?.sessionId, "s1");
      assert.equal(client.researchStarts.at(-1)?.question, "how is geothermal developing in Europe?");
      assert.equal(client.sent.length, 0, "nothing goes to Muse as a prompt");
      assert.equal(await controller.send("/research"), false);
      assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Add the question/);
      controller.newThread("/work/app");
      const startsBefore = client.startCalls.length;
      assert.equal(await controller.send("/research what changed in WCAG 2.2?"), true);
      assert.equal(client.startCalls.length, startsBefore + 1, "a thread was started for the run");
      assert.equal(client.startCalls.at(-1)?.cwd, "/work/app");
      // The fake starts every thread as s1, so the run lands there; the route follows the new thread.
      assert.equal(controller.store.get().route.kind, "thread");
      assert.equal(client.researchStarts.at(-1)?.sessionId, "s1");
      assert.equal(client.researchStarts.at(-1)?.question, "what changed in WCAG 2.2?");
      assert.equal(client.sent.length, 0);
      stop();
    });

    it("loads the research settings at boot and patches them with the change shown at once", async () => {
      const client = new FakeClient();
      const { controller, stop } = await started(client);
      assert.equal(controller.store.get().researchSettings?.enabled, true);
      assert.equal(controller.store.get().researchSettings?.config.maxParallel, 3);
      await controller.setResearchSettings({ config: { maxParallel: 4, models: { supervisor: null, worker: "muse-spark-1.3", writer: null } } });
      assert.deepEqual(client.researchPatches, [{ config: { maxParallel: 4, models: { supervisor: null, worker: "muse-spark-1.3", writer: null } } }]);
      assert.equal(controller.store.get().researchSettings?.config.maxParallel, 4);
      assert.equal(controller.store.get().researchSettings?.config.models.worker, "muse-spark-1.3");
      assert.equal(controller.store.get().researchSettings?.config.models.writer, null, "the other models keep their value");
      client.setResearchSettings = async () => {
        throw new Error("nope");
      };
      await controller.setResearchSettings({ enabled: false });
      assert.equal(controller.store.get().researchSettings?.enabled, true, "a refused patch is taken back");
      assert.equal(controller.store.get().toasts.at(-1)?.title, "Could not change the research settings");
      controller.setResearchStopWrites(false);
      assert.equal(controller.store.get().researchStopWrites, false);
      stop();
    });
  });

  it("starts a thread beside one whose reasoning cannot be replayed", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.freshThread("s1", "pick this up again"), true);
    assert.equal(client.sent.at(-1)?.text, "pick this up again");
    assert.equal(controller.store.get().route.kind, "thread");

    // A prompt the transcript showed as `/goal …` runs as the goal command again, not as the literal text.
    const sent = client.sent.length;
    assert.equal(await controller.freshThread("s1", "/goal ship the release"), true);
    assert.equal(client.actions.at(-1), "goal:s1:set:ship the release");
    assert.equal(client.sent.length, sent);
    stop();
  });

  it("compacts a thread the provider will not take, then sends the prompt again", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    await controller.compactAndRetry("s1", "try that again");
    assert.ok(client.actions.includes("compact"), "the history is summarized first");
    assert.equal(client.sent.at(-1)?.text, "try that again");
    assert.equal(client.sent.at(-1)?.ifBusy, "queue", "the retry waits behind the compaction turn");

    let before = client.sent.length;
    await controller.compactAndRetry("s1", null);
    assert.equal(client.sent.length, before, "with no prompt to resend, it only compacts");

    // A compaction Muse refused leaves the history exactly as it was, so resending would fail the same way.
    before = client.sent.length;
    client.compactNoop = true;
    await controller.compactAndRetry("s1", "try that again");
    assert.equal(client.sent.length, before, "nothing is resent after a noop compaction");
    client.compactNoop = false;
    client.compact = async () => {
      throw new Error("no");
    };
    await controller.compactAndRetry("s1", "try that again");
    assert.equal(client.sent.length, before, "nor after one that failed");
    stop();
  });

  it("clears a failed turn's notice when the user retries it", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    client.handler?.({
      type: "msp",
      sessionId: "s1",
      method: "turn/completed",
      params: { sessionId: "s1", turnId: "t7", terminal: "failed", error: { kind: "rateLimit", message: "quota", retryable: true } },
      at: 5,
    });
    await settle();
    assert.equal(controller.store.get().threads["s1"]?.fold.turns["t7"]?.error?.message, "quota");

    controller.dismissTurnError("s1", "t7");
    const info = controller.store.get().threads["s1"]?.fold.turns["t7"];
    assert.equal(info?.error, undefined);
    assert.equal(info?.dismissed, true);
    // Remembered outside the fold too, which a reload rebuilds from history with the error back in it.
    assert.deepEqual(controller.store.get().prefs.dismissedTurnErrors, ["s1:t7"]);
    controller.dismissTurnError("s1", "t7");
    assert.deepEqual(controller.store.get().prefs.dismissedTurnErrors, ["s1:t7"]);
    stop();
  });

  it("reorders projects by drag, and puts them back when the server refuses", async () => {
    const client = new FakeClient();
    const project = (cwd: string) => ({ cwd, displayName: cwd.slice(6), pinned: false, activityAt: SESSION.activityAt, defaultAccountId: null, folders: [{ cwd, displayName: cwd.slice(6) }] });
    client.listProjects = async () => [project("/work/a"), project("/work/b"), project("/work/c")];
    const { controller, stop } = await started(client);
    const order = () => controller.store.get().projects.map((p) => p.cwd);

    await controller.reorderProjects("/work/c", "/work/a");
    assert.deepEqual(order(), ["/work/c", "/work/a", "/work/b"]);
    assert.deepEqual(client.orders.at(-1), ["/work/c", "/work/a", "/work/b"]);

    await controller.reorderProjects("/work/c", null);
    assert.deepEqual(order(), ["/work/a", "/work/b", "/work/c"], "dropping past the last row sends it to the end");

    client.setProjectOrder = async () => {
      throw new Error("nope");
    };
    await controller.reorderProjects("/work/c", "/work/a");
    assert.deepEqual(order(), ["/work/a", "/work/b", "/work/c"], "a refused move snaps back");
    stop();
  });

  it("sends attached files with a prompt, and shows them while it is in flight", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const sent = await controller.send("look at this", {
      attachments: [{ name: "shot.png", mediaType: "image/png", base64: "AAAB" }],
      previews: [{ name: "shot.png", mediaType: "image/png", kind: "image", url: "blob:preview" }],
    });
    assert.equal(sent, true);
    assert.deepEqual(client.sent.at(-1)?.attachments, [{ name: "shot.png", mediaType: "image/png", base64: "AAAB" }]);
    assert.equal(controller.store.get().threads["s1"]?.fold.echoes.at(-1)?.attachments?.[0]?.url, "blob:preview");

    assert.equal(
      await controller.send("", { attachments: [{ name: "notes.pdf", mediaType: "application/pdf", base64: "AAAC" }] }),
      true,
      "a file with no text still sends",
    );
    assert.equal(await controller.send(""), false, "nothing to send is still nothing");
    stop();
  });

  // Helicon mentioned `.helicon/attachments`; a Helicon-era thread still reconciles the same way.
  for (const [transcriptFirst, folder] of [[true, ".ancilla"], [false, ".ancilla"], [true, ".helicon"], [false, ".helicon"]] as const) {
    it(`reconciles one PDF and image send when its transcript (${folder}) arrives ${transcriptFirst ? "before" : "after"} the ack`, async () => {
      const client = new FakeClient();
      let acknowledge!: (ack: { turnId: string | null; disposition: string | null }) => void;
      client.sendResult = () => new Promise((resolve) => { acknowledge = resolve; });
      const { controller, stop } = await started(client);
      const text = "Review the attached report and image";
      const attachments = [
        { name: "report.pdf", mediaType: "application/pdf", base64: "JVBERi0x" },
        { name: "shot.png", mediaType: "image/png", base64: "iVBORw0K" },
      ];
      const materialize = () => {
        client.handler?.({
          type: "msp", sessionId: "s1", method: "item/completed", at: 2,
          params: { sessionId: "s1", item: {
            itemId: "u9", kind: "userMessage", status: "completed", revision: 1,
            turnId: "t9", commandId: "t9", text: `${text}\n\n@${folder}/attachments/report.pdf[Image #1]`,
          } },
        });
        controller.flush();
      };
      try {
        const sending = controller.send(text, { attachments });
        assert.equal(await controller.send(text, { attachments }), true, "an overlapping submission shares the first send");
        if (transcriptFirst) materialize();
        acknowledge({ turnId: "t9", disposition: "started" });
        assert.equal(await sending, true);
        if (!transcriptFirst) materialize();
        assert.equal(client.sent.length, 1);
        assert.equal(client.sent[0]?.text, text);
        assert.equal(client.sent[0]?.displayText, text, "the original prompt is preserved for presentation");
        assert.deepEqual(client.sent[0]?.attachments, attachments);
        const fold = controller.store.get().threads["s1"]!.fold;
        assert.equal(fold.echoes.length, 0, "the rewritten materialized prompt replaces its local echo");
        assert.equal(fold.order.filter((id) => id === "u9").length, 1);
      } finally {
        stop();
      }
    });
  }

  it("preserves a slash command's display text when it carries an attachment", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    try {
      assert.equal(await controller.send("/init", {
        attachments: [{ name: "report.pdf", mediaType: "application/pdf", base64: "JVBERi0x" }],
      }), true);
      assert.equal(client.sent.length, 1);
      assert.equal(client.sent[0]?.displayText, "/init");
      assert.notEqual(client.sent[0]?.text, "/init", "the expanded instructions still reach the model");
    } finally {
      stop();
    }
  });

  it("hands a `!` command the host could not run to the agent", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    assert.equal(await controller.askToRun("s1", "ls -la"), true);
    assert.match(client.sent.at(-1)?.text ?? "", /```sh\nls -la\n```/);
    assert.match(client.sent.at(-1)?.text ?? "", /your own shell works/, "the agent is told its own shell is fine");
    assert.equal(await controller.askToRun("s1", "echo '```'"), true);
    assert.match(client.sent.at(-1)?.text ?? "", /````sh\necho '```'\n````/, "a fence in the command gets a longer fence around it");
    assert.equal(await controller.askToRun("s1", "printf '~~~\\n'"), true);
    assert.match(client.sent.at(-1)?.text ?? "", /```sh\nprintf '~~~\\n'\n```/, "a tilde run in the command changes nothing");
    stop();
  });

  it("forks a thread and opens the fork", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    // Opening the fork loads its transcript, which carries the fork's own summary.
    client.transcript = async () => load({ session: { ...SESSION, sessionId: "s2", title: "Probe (fork)" } });
    assert.equal(await controller.send("/fork"), true);
    const state = controller.store.get();
    assert.deepEqual(state.route, { kind: "thread", sessionId: "s2" });
    assert.equal(state.sessions["s2"]?.title, "Probe (fork)");
    assert.equal(state.toasts.at(-1)?.title, "Forked into a new thread");
    stop();
  });

  it("walks interface zoom through its fixed steps and back to 100%", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const zoom = () => controller.store.get().prefs.zoom;
    assert.equal(zoom(), 1);
    controller.zoomIn();
    assert.equal(zoom(), 1.1);
    controller.zoomIn();
    assert.equal(zoom(), 1.2);
    controller.zoomOut();
    controller.zoomOut();
    assert.equal(zoom(), 1);
    controller.zoomOut();
    assert.equal(zoom(), 0.9);
    controller.resetZoom();
    assert.equal(zoom(), 1);
    stop();
  });

  it("clamps interface zoom to its ends and drops malformed saved values", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    controller.setZoom(5);
    assert.equal(controller.store.get().prefs.zoom, ZOOM_MAX);
    controller.zoomIn();
    assert.equal(controller.store.get().prefs.zoom, ZOOM_MAX);
    controller.setZoom(0.05);
    assert.equal(controller.store.get().prefs.zoom, ZOOM_MIN);
    controller.zoomOut();
    assert.equal(controller.store.get().prefs.zoom, ZOOM_MIN);
    controller.setZoom(1.234);
    assert.equal(controller.store.get().prefs.zoom, 1.23);
    stop();
    const revived = new AncillaController(client, { ...platform(), loadPrefs: () => ({ zoom: 99 }) });
    assert.equal(revived.store.get().prefs.zoom, 1);
  });

  it("returns from settings and usage to the thread they were opened from", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    controller.navigate({ kind: "settings" });
    assert.deepEqual(controller.store.get().route, { kind: "settings" });
    controller.goBack();
    assert.deepEqual(controller.store.get().route, { kind: "thread", sessionId: "s1" });
    controller.navigate({ kind: "usage" });
    // Moving between the two pages keeps the thread as the way back, not the other page.
    controller.navigate({ kind: "settings" });
    controller.goBack();
    assert.deepEqual(controller.store.get().route, { kind: "thread", sessionId: "s1" });
    stop();
  });

  it("returns from settings to a fresh-thread route", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client, "");
    controller.newThread();
    assert.deepEqual(controller.store.get().route, { kind: "new", cwd: "/work/app" });
    controller.navigate({ kind: "settings" });
    controller.goBack();
    assert.deepEqual(controller.store.get().route, { kind: "new", cwd: "/work/app" });
    stop();
  });

  it("falls back to home when there is nowhere to go back to", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client, "#/settings");
    assert.deepEqual(controller.store.get().route, { kind: "settings" });
    controller.goBack();
    assert.deepEqual(controller.store.get().route, { kind: "home" });
    stop();
  });

  it("falls back to home when the return thread is gone", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    controller.navigate({ kind: "settings" });
    await controller.archive("s1");
    controller.goBack();
    assert.deepEqual(controller.store.get().route, { kind: "home" });
    stop();
  });
});

describe("staleThreadReason", () => {
  const NOW = 1_000_000;

  it("leaves idle threads alone", () => {
    assert.equal(staleThreadReason(null, null, NOW - 60_000, NOW), null);
    assert.equal(staleThreadReason(null, "t1", NOW - 600_000, NOW), null);
  });

  it("leaves threads without an applied stamp alone", () => {
    assert.equal(staleThreadReason("t1", null, null, NOW), null);
  });

  it("reloads a fold still showing a turn the server finished", () => {
    assert.equal(staleThreadReason("t1", null, NOW - 30_000, NOW), null);
    assert.equal(staleThreadReason("t1", null, NOW - 30_001, NOW), "diverged");
    assert.equal(staleThreadReason("t1", undefined, NOW - 31_000, NOW), "diverged");
  });

  it("reloads a turn both sides agree is running but silent", () => {
    assert.equal(staleThreadReason("t1", "t1", NOW - 90_000, NOW), null);
    assert.equal(staleThreadReason("t1", "t1", NOW - 90_001, NOW), "quiet");
  });
});

describe("stale thread watchdog", () => {
  function watchPlatform() {
    const base = platform("#/t/s1");
    let now = 1_000_000;
    const timers: ({ fn: () => void; ms: number } | null)[] = [];
    const fake: Platform = {
      ...base,
      now: () => now,
      schedule: (fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return timers.length - 1;
      },
      cancel: (handle: unknown) => {
        if (typeof handle === "number") {
          timers[handle] = null;
        }
      },
    };
    return {
      fake,
      setNow: (value: number) => {
        now = value;
      },
      runStaleChecks: () => {
        for (const [index, timer] of [...timers].entries()) {
          if (timer && timer.ms === 15_000) {
            timers[index] = null;
            timer.fn();
          }
        }
      },
    };
  }

  const runningLoad = (): TranscriptLoad =>
    load({
      msp: { status: "running", activeTurnId: "live-1", modelId: "muse-spark-1.3", approvalMode: "onRequest", workspaceRoot: "/work/app", turnCount: 4 },
      events: [...historyEvents, { method: "turn/started", params: { turnId: "live-1" }, at: 1 }],
    });

  async function startedWatching(client: FakeClient) {
    const watch = watchPlatform();
    const controller = new AncillaController(client, watch.fake);
    const stop = controller.start();
    await settle();
    await settle();
    return { controller, stop, ...watch };
  }

  const work = (revision: number, text = `Progress ${revision}`): ViewEvent => ({
    method: "item/updated", params: { item: {
      itemId: "current-work", kind: "agentMessage", status: "inProgress", revision, turnId: "live-1", text,
    } },
  });
  const fallbackLoad = (revision: number): TranscriptLoad => ({
    ...runningLoad(),
    events: [...runningLoad().events, work(revision)],
    historyUnavailable: true,
    viewHealth: { status: "unavailable", reason: "projectionUnavailable" },
  });
  /** The server's live state agreeing the turn runs, so a quiet stream gets the longer grace rather than the missed-ending one. */
  const LIVE_SESSION: SessionSummary = {
    ...SESSION,
    live: { activeTurnId: "live-1", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null },
  };
  /** One event over the live stream, applied at once. */
  const stream = (client: FakeClient, controller: AncillaController, sessionId: string, event: ViewEvent, at: number) => {
    client.handler?.({ type: "msp", sessionId, ...event, at });
    controller.flush();
  };

  it("checks progressing partial history every 15 seconds without claiming the live stream recovered", async () => {
    const client = new FakeClient();
    let revision = 0;
    client.transcript = async () => fallbackLoad(++revision);
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    assert.deepEqual(controller.store.get().threads.s1?.historySync, { checkedAt: 1_000_000, progressAt: 1_000_000 });
    setNow(1_015_000); runStaleChecks(); await settle(); await settle();
    const thread = controller.store.get().threads.s1!;
    assert.equal(revision, 2);
    assert.equal(thread.fold.items["current-work"].revision, 2);
    assert.deepEqual(thread.historySync, { checkedAt: 1_015_000, progressAt: 1_015_000 });
    assert.equal(thread.stalled, false);
    assert.equal(thread.fold.activeTurnId, "live-1");
    assert.equal(thread.fold.turns["live-1"].terminal, undefined);
    assert.deepEqual(client.transcriptOptions.at(-1), { refresh: true });
    assert.equal(client.sent.length, 0);
    stop();
  });

  it("keeps the fallback request cadence when a saved-history read takes time", async () => {
    const client = new FakeClient();
    client.transcript = async () => fallbackLoad(1);
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    let finish!: (value: TranscriptLoad) => void;
    client.transcript = () => new Promise((resolve) => { finish = resolve; });
    setNow(1_015_000); runStaleChecks(); await settle();
    assert.equal(client.transcriptOptions.length, 2);
    setNow(1_017_000); finish(fallbackLoad(2)); await settle(); await settle();
    assert.equal(controller.store.get().threads.s1?.historySync?.checkedAt, 1_017_000);
    client.transcript = async () => fallbackLoad(3);
    setNow(1_030_000); runStaleChecks(); await settle(); await settle();
    assert.equal(client.transcriptOptions.length, 3, "a slow response must not skip the next 15-second read");
    assert.equal(controller.store.get().threads.s1?.fold.items["current-work"].revision, 3);
    assert.equal(client.sent.length, 0);
    stop();
  });

  it("keeps fallback progress time unchanged when saved history repeats the same revision", async () => {
    const client = new FakeClient();
    client.transcript = async () => fallbackLoad(1);
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    setNow(1_015_000); runStaleChecks(); await settle(); await settle();
    assert.deepEqual(controller.store.get().threads.s1?.historySync, { checkedAt: 1_015_000, progressAt: 1_000_000 });
    assert.equal(controller.store.get().threads.s1?.fold.activeTurnId, "live-1");
    stop();
  });

  it("uses the longer fallback interval for loaded threads outside the selected chat", async () => {
    const client = new FakeClient();
    let reads = 0;
    client.transcript = async () => { reads++; return fallbackLoad(reads); };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    controller.navigate({ kind: "settings" });
    setNow(1_015_000); runStaleChecks(); await settle(); await settle();
    assert.equal(reads, 1);
    setNow(1_120_000); runStaleChecks(); await settle(); await settle();
    assert.equal(reads, 2);
    assert.deepEqual(client.transcriptOptions.at(-1), { refresh: true });
    stop();
  });

  it("keeps a usable fold and retries a transient fallback error without resuming or resending", async () => {
    const client = new FakeClient();
    let reads = 0;
    client.transcript = async () => {
      reads++;
      if (reads === 2) throw new Error("temporary read outage");
      return fallbackLoad(reads);
    };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    setNow(1_015_000); runStaleChecks(); await settle(); await settle();
    const failed = controller.store.get().threads.s1!;
    assert.equal(failed.load, "ready");
    assert.equal(failed.fold.items["current-work"].revision, 1);
    assert.equal(failed.fold.activeTurnId, "live-1");
    assert.equal(failed.error, "temporary read outage");
    setNow(1_030_000); runStaleChecks(); await settle(); await settle();
    assert.equal(reads, 2, "a failed read does not retry every 15 seconds");
    setNow(1_045_000); runStaleChecks(); await settle(); await settle();
    assert.equal(reads, 3);
    assert.equal(controller.store.get().threads.s1?.error, null);
    assert.equal(controller.store.get().threads.s1?.fold.items["current-work"].revision, 3);
    assert.ok(client.transcriptOptions.slice(1).every((options) => options?.refresh === true));
    assert.equal(client.sent.length, 0);
    stop();
  });

  it("uses read-only refresh when the loaded fold is active even if server live state is absent", async () => {
    const client = new FakeClient();
    client.transcript = async () => ({ ...runningLoad(), readOnly: true });
    const { controller, stop } = await startedWatching(client);
    assert.equal(controller.store.get().sessions.s1?.live, null);
    assert.equal(controller.store.get().threads.s1?.fold.activeTurnId, "live-1");
    await controller.loadThread("s1");
    assert.deepEqual(client.transcriptOptions.at(-1), { refresh: true });
    assert.equal(client.sent.length, 0);
    stop();
  });

  it("continues unavailable-history recovery when an old pending input is still cached", async () => {
    const client = new FakeClient();
    let reads = 0;
    client.transcript = async () => {
      reads++;
      return { ...fallbackLoad(reads), pending: { approvals: [], userInputs: reads === 1
        ? [{ userInputId: "old-question", turnId: "live-1", questions: [] } as unknown as UserInputRequest] : [] } };
    };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    assert.ok(controller.store.get().threads.s1?.fold.userInputs["old-question"]);
    setNow(1_015_000); runStaleChecks(); await settle(); await settle();
    assert.equal(reads, 2);
    assert.equal(Object.keys(controller.store.get().threads.s1!.fold.userInputs).length, 0);
    assert.equal(controller.store.get().threads.s1?.fold.activeTurnId, "live-1");
    stop();
  });

  it("clears fallback and stale state on fresh live progress, but not metadata or replayed revisions", async () => {
    const client = new FakeClient();
    client.transcript = async () => fallbackLoad(2);
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    setNow(1_015_000); runStaleChecks(); await settle(); await settle();
    assert.equal(controller.store.get().threads.s1?.stalled, true);
    const deliver = (event: ViewEvent) => {
      client.handler?.({ type: "msp", sessionId: "s1", ...event, at: 1_015_001 });
      controller.flush();
    };
    deliver({ method: "session/tokenUsage", params: { inputTokens: 20, outputTokens: 10 } });
    deliver(work(1));
    assert.equal(controller.store.get().threads.s1?.stalled, true);
    assert.ok(controller.store.get().threads.s1?.historySync);
    deliver(work(3));
    assert.equal(controller.store.get().threads.s1?.stalled, false);
    assert.equal(controller.store.get().threads.s1?.historySync, undefined);
    assert.equal(controller.store.get().threads.s1?.fold.activeTurnId, "live-1");
    stop();
  });

  it("clears ended-turn fallback state even when the saved response retains unavailable health", async () => {
    const client = new FakeClient();
    let reads = 0;
    client.transcript = async () => ++reads === 1 ? fallbackLoad(1) : load({
      events: [...historyEvents, { method: "turn/completed", params: { turnId: "live-1", terminal: "completed" } }],
      historyUnavailable: true,
      viewHealth: { status: "unavailable", reason: "projectionUnavailable" },
    });
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    setNow(1_015_000); runStaleChecks(); await settle(); await settle();
    assert.equal(controller.store.get().threads.s1?.fold.activeTurnId, null);
    assert.equal(controller.store.get().threads.s1?.stalled, false);
    assert.equal(controller.store.get().threads.s1?.historySync, undefined);
    stop();
  });

  it("reads saved results immediately when Muse reports unavailable updates, without resending", async () => {
    const client = new FakeClient();
    client.transcript = async () => runningLoad();
    const { controller, stop } = await startedWatching(client);
    client.transcript = async () => load({
      events: [...historyEvents, { method: "turn/completed", params: { turnId: "live-1", terminal: "completed" }, at: 2 }],
      viewHealth: { status: "unavailable", reason: "projectionUnavailable" },
    });
    client.handler?.({ type: "msp", sessionId: "s1", method: "session/viewHealthChanged",
      params: { health: "unavailable", noneReason: "projectionUnavailable" }, at: 1 });
    await settle();
    await settle();
    assert.deepEqual(client.transcriptOptions.at(-1), { refresh: true });
    assert.equal(controller.store.get().threads.s1?.fold.activeTurnId, null);
    assert.equal(controller.store.get().threads.s1?.fold.turns["live-1"]?.terminal, "completed");
    assert.equal(controller.store.get().threads.s1?.stalled, false, "saved completion clears the stale-update notice");
    assert.equal(client.sent.length, 0);
    stop();
  });

  it("continues read-only recovery after backoff instead of leaving a permanent spinner", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => { loads += 1; return runningLoad(); };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    for (const elapsed of [31_000, 62_000, 93_000]) {
      setNow(1_000_000 + elapsed); runStaleChecks(); await settle(); await settle();
    }
    assert.equal(loads, 3);
    client.transcript = async () => { loads += 1; return load(); };
    setNow(1_000_000 + 183_000); runStaleChecks(); await settle(); await settle();
    assert.equal(loads, 4);
    assert.equal(controller.store.get().threads.s1?.fold.activeTurnId, null);
    assert.deepEqual(client.transcriptOptions.at(-1), { refresh: true });
    assert.equal(client.sent.length, 0);
    stop();
  });

  it("reloads a thread whose ending never landed", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return runningLoad();
    };
    const { stop, setNow, runStaleChecks } = await startedWatching(client);
    assert.equal(loads, 1);
    runStaleChecks();
    assert.equal(loads, 1, "a thread that just applied anything is left alone");
    setNow(1_000_000 + 31_000);
    runStaleChecks();
    await settle();
    await settle();
    assert.equal(loads, 2, "a fold still showing a finished turn reloads from history");
    runStaleChecks();
    assert.equal(loads, 2, "a fresh reload is not reloaded again at once");
    setNow(1_000_000 + 62_000);
    runStaleChecks();
    await settle();
    await settle();
    assert.equal(loads, 3, "a thread that stays silent is retried once per grace period");
    setNow(1_000_000 + 93_000);
    runStaleChecks();
    await settle();
    await settle();
    assert.equal(loads, 3, "a turn history never finishes stops being refetched");
    stop();
  });

  it("leaves a turn alone while it waits on the user, however long that takes (#54)", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return load({
        msp: { status: "running", activeTurnId: "live-1", modelId: "muse-spark-1.3", approvalMode: "onRequest", workspaceRoot: "/work/app", turnCount: 4 },
        events: [...historyEvents, { method: "turn/started", params: { turnId: "live-1" }, at: 1 }],
        // On load the server's pending set is what the fold trusts, not the event log.
        pending: {
          approvals: [],
          userInputs: [{ userInputId: "q1", turnId: "live-1", questions: [{ question: "Which one?", options: [] }] } as unknown as UserInputRequest],
        },
      });
    };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    assert.equal(loads, 1);
    for (const minutes of [2, 5, 10, 30]) {
      setNow(1_000_000 + minutes * 60_000);
      runStaleChecks();
      await settle();
      await settle();
    }
    assert.equal(loads, 1, "a question left unanswered for half an hour is never reloaded");
    assert.equal(controller.store.get().threads["s1"]?.stalled, false, "and never reported as stalled");
    stop();
  });

  it("says a thread stalled once the reloads are spent, and retries when asked", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return runningLoad();
    };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    assert.equal(controller.store.get().threads["s1"]?.stalled, false, "nothing is stalled to begin with");

    setNow(1_000_000 + 31_000);
    runStaleChecks();
    await settle();
    await settle();
    setNow(1_000_000 + 62_000);
    runStaleChecks();
    await settle();
    await settle();
    assert.equal(controller.store.get().threads["s1"]?.stalled, false, "still trying, so nothing is said yet");

    setNow(1_000_000 + 93_000);
    runStaleChecks();
    await settle();
    assert.equal(controller.store.get().threads["s1"]?.stalled, true, "out of reloads: the view says so");
    assert.equal(loads, 3, "and stops reloading");

    await controller.retryStalledThread("s1");
    await settle();
    assert.equal(loads, 4, "asking by hand tries again");
    stop();
  });

  it("reloads a turn both sides agree is running but silent", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return runningLoad();
    };
    const { stop, setNow, runStaleChecks } = await startedWatching(client);
    client.handler?.({
      type: "session-status",
      sessionId: "s1",
      live: { activeTurnId: "live-1", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null },
    });
    setNow(1_000_000 + 60_000);
    runStaleChecks();
    assert.equal(loads, 1, "a quiet-but-running turn gets a longer grace period");
    setNow(1_000_000 + 91_000);
    runStaleChecks();
    await settle();
    await settle();
    assert.equal(loads, 2);
    stop();
  });

  it("leaves idle threads and threads already loading alone", async () => {
    const client = new FakeClient();
    let loads = 0;
    client.transcript = async () => {
      loads += 1;
      return load();
    };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    assert.equal(loads, 1);
    setNow(1_000_000 + 900_000);
    runStaleChecks();
    assert.equal(loads, 1, "an idle thread never reloads itself");

    let resolve!: (value: TranscriptLoad) => void;
    client.transcript = () => {
      loads += 1;
      return new Promise<TranscriptLoad>((r) => (resolve = r));
    };
    const loading = controller.loadThread("s1");
    await settle();
    assert.equal(controller.store.get().threads["s1"]?.load, "loading");
    runStaleChecks();
    resolve(load());
    await loading;
    await settle();
    assert.equal(loads, 2, "a reload never piles onto a load already in flight");
    stop();
  });

  it("queues a resume behind a read in flight and lets later loads share it, so one request runs at a time", async () => {
    const client = new FakeClient();
    client.listSessions = async () => [LIVE_SESSION];
    const options: ({ refresh?: boolean } | undefined)[] = [];
    let finish!: (value: TranscriptLoad) => void;
    client.loadTranscript = (_sessionId: string, requested?: { refresh?: boolean }) => {
      options.push(requested);
      return new Promise<TranscriptLoad>((resolve) => {
        finish = resolve;
      });
    };
    const controller = new AncillaController(client, watchPlatform().fake);
    const stop = controller.start();
    await settle();
    try {
      assert.deepEqual(options, [{ refresh: true }], "the running session is read in place");
      const resume = controller.loadThread("s1", { resume: true });
      assert.equal(controller.loadThread("s1", { resume: true }), resume, "a second resume shares the queued one");
      assert.equal(controller.loadThread("s1"), resume, "and so does a plain load asked meanwhile");
      assert.equal(options.length, 1, "the read in flight is not interrupted");
      finish({ ...runningLoad(), session: LIVE_SESSION });
      await settle();
      assert.deepEqual(options, [{ refresh: true }, undefined], "the resume follows the read");
      finish(load({ session: LIVE_SESSION }));
      await resume;
      assert.equal(controller.store.get().threads.s1?.load, "ready");
      assert.equal(controller.store.get().threads.s1?.fold.activeTurnId, null);
    } finally {
      stop();
    }
  });

  it("takes retry notices on the stream as life, so a turn waiting out a rate limit is neither reread nor stalled", async () => {
    const client = new FakeClient();
    client.listSessions = async () => [LIVE_SESSION];
    let reads = 0;
    client.transcript = async () => { reads++; return { ...runningLoad(), session: LIVE_SESSION }; };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    try {
      let attempt = 1;
      for (let elapsed = 15_000; elapsed <= 480_000; elapsed += 15_000) {
        const at = 1_000_000 + elapsed;
        if (elapsed % 75_000 === 0) {
          attempt += 1;
          stream(client, controller, "s1", { method: "turn/retryScheduled", params: {
            turnId: "live-1", attempt, maxAttempts: 10, nextAttempt: attempt + 1, reason: "rateLimited", retryDelayMs: 75_000,
          } }, at);
        }
        setNow(at); runStaleChecks(); await settle();
      }
      assert.equal(reads, 1, "a stream that keeps reporting is never reread");
      const thread = controller.store.get().threads.s1!;
      assert.equal(thread.stalled, false);
      assert.equal(thread.fold.activeTurnId, "live-1");
      assert.equal(thread.fold.turns["live-1"]?.retry?.attempt, attempt, "the retry notice is kept");
    } finally {
      stop();
    }
  });

  it("takes usage and reminder traffic on the stream as life too", async () => {
    const client = new FakeClient();
    client.listSessions = async () => [LIVE_SESSION];
    let reads = 0;
    client.transcript = async () => { reads++; return { ...runningLoad(), session: LIVE_SESSION }; };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    try {
      for (let elapsed = 15_000; elapsed <= 480_000; elapsed += 15_000) {
        const at = 1_000_000 + elapsed;
        stream(client, controller, "s1", { method: "session/tokenUsage", params: {
          turnId: "live-1", cumulative: { promptTokens: elapsed, outputTokens: 1, totalTokens: elapsed + 1 }, viewCursor: `v:s1:${elapsed}`,
        } }, at);
        stream(client, controller, "s1", { method: "item/completed", params: { item: {
          itemId: `reminder-${elapsed}`, kind: "reminderChild", status: "completed", revision: 1, turnId: "live-1", childSessionId: `helper-${elapsed}`,
        } } }, at);
        setNow(at); runStaleChecks(); await settle();
      }
      assert.equal(reads, 1);
      assert.equal(controller.store.get().threads.s1?.stalled, false);
    } finally {
      stop();
    }
  });

  it("expects silence while a scheduled retry waits, then still catches a stream that stays quiet past it", async () => {
    const client = new FakeClient();
    client.listSessions = async () => [LIVE_SESSION];
    let reads = 0;
    client.transcript = async () => { reads++; return { ...runningLoad(), session: LIVE_SESSION }; };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    try {
      setNow(1_015_000);
      stream(client, controller, "s1", { method: "turn/retryScheduled", params: {
        turnId: "live-1", attempt: 1, maxAttempts: 5, nextAttempt: 2, reason: "rateLimited", retryDelayMs: 150_000,
      } }, 1_015_000);
      for (const elapsed of [105_000, 165_000, 240_000]) {
        setNow(1_000_000 + elapsed); runStaleChecks(); await settle(); await settle();
      }
      assert.equal(reads, 1, "the wait for the retry is expected, and the quiet clock starts when it is due");
      setNow(1_000_000 + 270_000); runStaleChecks(); await settle(); await settle();
      assert.equal(reads, 2, "silence past the retry is a quiet turn again");
    } finally {
      stop();
    }
  });

  it("keeps the retry Muse scheduled across a full read whose history does not record it", async () => {
    const client = new FakeClient();
    client.transcript = async () => runningLoad();
    const { controller, stop } = await startedWatching(client);
    try {
      stream(client, controller, "s1", { method: "turn/retryScheduled", params: {
        turnId: "live-1", attempt: 1, maxAttempts: 5, nextAttempt: 2, reason: "rateLimited", retryDelayMs: 60_000,
      } }, 1_000_002);
      await controller.loadThread("s1");
      assert.equal(controller.store.get().threads.s1?.fold.turns["live-1"]?.retry?.nextAttempt, 2);
      stream(client, controller, "s1", { method: "turn/completed", params: { turnId: "live-1", terminal: "completed" } }, 1_000_003);
      await controller.loadThread("s1");
      assert.equal(controller.store.get().threads.s1?.fold.turns["live-1"]?.retry, undefined, "an ended turn's retry stays cleared");
    } finally {
      stop();
    }
  });

  it("counts a child session's own events as life for the lead turn that spawned it", async () => {
    const client = new FakeClient();
    client.listSessions = async () => [LIVE_SESSION];
    let reads = 0;
    client.transcript = async () => { reads++; return { ...runningLoad(), session: LIVE_SESSION }; };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    try {
      // The lead delegates, then says nothing itself while its subagent works in a session of its own.
      stream(client, controller, "s1", { method: "item/started", params: { item: {
        itemId: "sub-1", kind: "subagent", status: "inProgress", revision: 1, turnId: "live-1", childSessionId: "child-1",
      } } }, 1_010_000);
      for (let elapsed = 30_000; elapsed <= 480_000; elapsed += 30_000) {
        const at = 1_000_000 + elapsed;
        stream(client, controller, "child-1", { method: "item/delta", params: { itemId: `c${elapsed}`, field: "text", delta: "…", turnId: "child-turn" } }, at);
        setNow(at); runStaleChecks(); await settle();
      }
      assert.equal(reads, 1, "a lead whose child is working is not reread");
      assert.equal(controller.store.get().threads.s1?.stalled, false);
      assert.equal(controller.store.get().threads["child-1"], undefined, "the child's events open no thread of their own");
      // Everything goes silent, the child included: that is a quiet turn again.
      setNow(1_000_000 + 480_000 + 91_000); runStaleChecks(); await settle(); await settle();
      assert.equal(reads, 2);
    } finally {
      stop();
    }
  });

  it("ends a stall the moment the turn asks the user something, and starts the next quiet stretch afresh", async () => {
    const client = new FakeClient();
    let reads = 0;
    client.transcript = async () => { reads++; return runningLoad(); };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    try {
      for (const elapsed of [31_000, 62_000, 93_000]) {
        setNow(1_000_000 + elapsed); runStaleChecks(); await settle(); await settle();
      }
      assert.equal(controller.store.get().threads.s1?.stalled, true);
      assert.equal(reads, 3);
      stream(client, controller, "s1", { method: "userInput/requested", params: { userInputId: "q1", sessionId: "s1", turnId: "live-1", questions: [] } }, 1_093_500);
      const asked = controller.store.get().threads.s1!;
      assert.equal(asked.stalled, false, "a question over the live stream is not a stopped stream");
      assert.ok(asked.fold.userInputs["q1"]);
      setNow(1_600_000); runStaleChecks(); await settle();
      assert.equal(reads, 3, "and the wait for the answer is never reread");
      assert.equal(controller.store.get().threads.s1?.stalled, false);
      stream(client, controller, "s1", { method: "userInput/settled", params: { userInputId: "q1", outcome: "answered", answers: [] } }, 1_600_000);
      setNow(1_631_000); runStaleChecks(); await settle(); await settle();
      assert.equal(reads, 4, "the quiet stretch after the answer gets its quick reads again");
      assert.equal(controller.store.get().threads.s1?.stalled, false, "rather than going straight back to stalled");
    } finally {
      stop();
    }
  });

  it("never calls a thread stalled for a read that failed, and a healthy read after it leaves nothing behind", async () => {
    const client = new FakeClient();
    client.transcript = async () => runningLoad();
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    try {
      client.transcript = async () => { throw new Error("socket hang up"); };
      await controller.loadThread("s1");
      const failed = controller.store.get().threads.s1!;
      assert.equal(failed.load, "ready");
      assert.equal(failed.error, "socket hang up");
      assert.equal(failed.stalled, false, "one failed read says nothing about the stream");
      client.transcript = async () => runningLoad();
      setNow(1_031_000); runStaleChecks(); await settle(); await settle();
      const healthy = controller.store.get().threads.s1!;
      assert.equal(healthy.error, null);
      assert.equal(healthy.stalled, false);
      assert.equal(healthy.historySync, undefined);
    } finally {
      stop();
    }
  });

  it("stops reading a thread that was archived, and never puts it back into the sidebar", async () => {
    const client = new FakeClient();
    let reads = 0;
    let archived = false;
    client.transcript = async () => { reads++; return { ...fallbackLoad(reads), session: { ...SESSION, archived } }; };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    try {
      archived = true;
      client.listSessions = async () => [];
      await controller.archive("s1");
      await controller.refresh();
      assert.equal(controller.store.get().sessions.s1, undefined);
      const before = reads;
      for (let tick = 1; tick <= 6; tick++) {
        setNow(1_000_000 + tick * 121_000); runStaleChecks(); await settle(); await settle();
      }
      assert.equal(reads, before, "nobody can see it, so nothing reads it");
      assert.equal(controller.store.get().sessions.s1, undefined);
      assert.equal(controller.store.get().threads.s1?.stale, true, "opening it again reads it afresh");
    } finally {
      stop();
    }
  });

  it("does not put an archived thread back when a read of it was still in flight", async () => {
    const client = new FakeClient();
    client.transcript = async () => fallbackLoad(1);
    const { controller, stop } = await startedWatching(client);
    try {
      let finish!: (value: TranscriptLoad) => void;
      client.transcript = () => new Promise((resolve) => { finish = resolve; });
      const reading = controller.loadThread("s1");
      await settle();
      client.listSessions = async () => [];
      await controller.archive("s1");
      finish({ ...fallbackLoad(2), session: { ...SESSION, archived: true } });
      await reading;
      assert.equal(controller.store.get().sessions.s1, undefined);
    } finally {
      stop();
    }
  });

  it("stops reading the threads of a project taken out of the sidebar", async () => {
    const client = new FakeClient();
    let reads = 0;
    client.transcript = async () => { reads++; return fallbackLoad(reads); };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    try {
      await controller.hideProject("/work/app");
      assert.deepEqual(controller.store.get().route, { kind: "home" });
      const before = reads;
      for (let tick = 1; tick <= 3; tick++) {
        setNow(1_000_000 + tick * 121_000); runStaleChecks(); await settle(); await settle();
      }
      assert.equal(reads, before);
    } finally {
      stop();
    }
  });

  it("keeps a turn the stream saw end from coming back through a read that still names it", async () => {
    const client = new FakeClient();
    client.transcript = async () => runningLoad();
    const { controller, stop } = await startedWatching(client);
    try {
      stream(client, controller, "s1", { method: "turn/completed", params: { turnId: "live-1", terminal: "completed" } }, 1_000_005);
      assert.equal(controller.store.get().threads.s1?.fold.activeTurnId, null);
      // Muse then reports its view unavailable; a finished turn has nothing there to recover.
      client.handler?.({ type: "msp", sessionId: "s1", method: "session/viewHealthChanged",
        params: { health: "unavailable", noneReason: "projectionUnavailable" }, at: 1_000_006 });
      await settle();
      await settle();
      assert.equal(client.transcriptOptions.length, 1, "an idle thread is not reread for an unavailable view");
      // A read that raced the ending still names the turn, in a partial page and in a full one alike.
      for (const partial of [true, false]) {
        client.transcript = async () => ({
          ...runningLoad(),
          ...(partial ? { historyUnavailable: true, viewHealth: { status: "unavailable", reason: "projectionUnavailable" } } : {}),
        });
        await controller.loadThread("s1");
        const thread = controller.store.get().threads.s1!;
        assert.equal(thread.fold.activeTurnId, null, `${partial ? "partial" : "full"}: an ending the fold accepted is newer than the read`);
        assert.equal(thread.fold.turns["live-1"]?.terminal, "completed");
        assert.equal(thread.stalled, false);
        assert.equal(thread.historySync, undefined);
      }
    } finally {
      stop();
    }
  });

  for (const partial of [true, false]) {
    for (const held of [false, true]) {
      it(`applies a live delta buffered during a ${partial ? "partial" : "full"} read once when the read ${held ? "already holds" : "lacks"} it`, async () => {
        const client = new FakeClient();
        const message = (text: string): ViewEvent => ({
          method: "item/updated", params: { item: { itemId: "m", kind: "agentMessage", turnId: "live-1", revision: 1, status: "inProgress", text } },
        });
        const delta = (text: string): ViewEvent => ({ method: "item/delta", params: { itemId: "m", field: "text", delta: text, turnId: "live-1" } });
        const read = (text: string): TranscriptLoad => ({
          ...runningLoad(),
          events: [...runningLoad().events, message(text)],
          ...(partial ? { historyUnavailable: true, viewHealth: { status: "unavailable", reason: "projectionUnavailable" } } : {}),
        });
        const shown = () => controller.store.get().threads.s1?.fold.items["m"]?.text;
        client.transcript = async () => read("Hello");
        const { controller, stop } = await startedWatching(client);
        try {
          stream(client, controller, "s1", delta("!"), 1_000_002);
          assert.equal(shown(), "Hello!");
          let finish!: (value: TranscriptLoad) => void;
          client.transcript = () => new Promise((resolve) => { finish = resolve; });
          const reading = controller.loadThread("s1");
          await settle();
          // The feed delivers " world" while the read is in flight; the read may have caught it or not.
          client.handler?.({ type: "msp", sessionId: "s1", ...delta(" world"), at: 1_000_003 });
          finish(read(held ? "Hello! world" : "Hello!"));
          await reading;
          assert.equal(shown(), "Hello! world");
        } finally {
          stop();
        }
      });
    }
  }

  it("ends a saved-progress sync when the server reports the view healthy again, and keeps watching for silence", async () => {
    const client = new FakeClient();
    let reads = 0;
    client.transcript = async () => { reads++; return fallbackLoad(reads); };
    const { controller, stop, setNow, runStaleChecks } = await startedWatching(client);
    try {
      assert.ok(controller.store.get().threads.s1?.historySync);
      setNow(1_015_000); runStaleChecks(); await settle(); await settle();
      assert.equal(reads, 2, "saved progress is checked every 15 seconds while the view is unavailable");
      const live = (viewHealth: { status: string; reason: string | null } | null) =>
        ({ ...LIVE_SESSION.live!, viewHealth });
      client.handler?.({ type: "session-status", sessionId: "s1", live: live({ status: "unavailable", reason: "projectionUnavailable" }) });
      client.handler?.({ type: "session-status", sessionId: "s1", live: live(null) });
      const recovered = controller.store.get().threads.s1!;
      assert.equal(recovered.historySync, undefined);
      assert.equal(recovered.stalled, false);
      setNow(1_030_000); runStaleChecks(); await settle(); await settle();
      setNow(1_045_000); runStaleChecks(); await settle(); await settle();
      assert.equal(reads, 2, "the fast cadence stops with the sync");
      setNow(1_015_000 + 91_000); runStaleChecks(); await settle(); await settle();
      assert.equal(reads, 3, "a stream that then stays silent is still caught");
    } finally {
      stop();
    }
  });
});

describe("crew controls", () => {
  const T = Date.UTC(2026, 8, 26, 14, 2, 0);
  const workflow = (revision: number, children: Record<string, unknown>[], status = "inProgress"): AncillaEvent => ({
    type: "msp", sessionId: "s1", method: revision === 1 ? "item/started" : "item/updated", at: T + revision * 1000,
    params: { item: { itemId: "wf", kind: "workflow", status, revision, turnId: "t9", workflowRunId: "run-1", entryId: "audit", children } },
  });
  const task = (revision: number, status: string): AncillaEvent => ({
    type: "msp", sessionId: "s1", method: status === "inProgress" ? "item/updated" : "item/completed", at: T + revision * 1000,
    params: { item: { itemId: "task-1", kind: "toolCall", status, revision, tool: "bash", args: JSON.stringify({ command: "npm run docs:build" }), background: true } },
  });
  const nativeSpawn = (id: string): AncillaEvent => ({
    type: "msp", sessionId: "s1", method: "item/completed", at: T,
    params: { item: {
      itemId: `spawn-${id}`, kind: "toolCall", status: "completed", revision: 1, tool: "subagent_spawn", turnId: "t9",
      args: JSON.stringify({ task_name: `native-${id}`, objective: "Inspect the code." }),
      visibleOutput: JSON.stringify({ status: "accepted", subagent_id: id }),
    } },
  });
  const nativeDone = (id: string): AncillaEvent => ({
    type: "msp", sessionId: "s1", method: "item/completed", at: T + 1000,
    params: { item: {
      itemId: `wait-${id}`, kind: "toolCall", status: "completed", revision: 1, tool: "subagent_wait", turnId: "t9",
      args: JSON.stringify({ subagent_id: id }), visibleOutput: JSON.stringify({ status: "ready", subagent_id: id }),
    } },
  });
  const agentOf = (controller: AncillaController, id: string) => {
    const thread = controller.store.get().threads["s1"]!;
    const vm = crewView(thread.fold, SESSION, Date.now(), { pending: controller.store.get().crew.pending });
    const run = vm.runs[0];
    const agent = run?.agents.find((a) => a.id === id) ?? vm.tasks.find((t) => t.id === id) ?? vm.subagents.find((a) => a.id === id);
    assert.ok(agent, `no agent ${id}`);
    return agent;
  };

  it("migrates the file viewer's switch to the side-panel setting and keeps the two in step", () => {
    const fallback = defaultPrefs();
    assert.equal(revivePrefs({ filesOpen: true }, fallback).sidePanel, "files");
    assert.equal(revivePrefs({ filesOpen: true }, fallback).filesOpen, true);
    assert.equal(revivePrefs({ sidePanel: "crew", filesOpen: true }, fallback).sidePanel, "crew", "the new setting wins over the old switch");
    assert.equal(revivePrefs({ sidePanel: "crew", filesOpen: true }, fallback).filesOpen, false);
    assert.equal(revivePrefs({ filesOpen: false }, fallback).sidePanel, "none");
    assert.equal(revivePrefs({ crewWidth: 9_999 }, fallback).crewWidth, DEFAULT_CREW_WIDTH);
    assert.equal(revivePrefs({ crewWidth: 640 }, fallback).crewWidth, 640);
  });

  it("carries a saved Swarm panel and its width over to the Crew names", () => {
    const fallback = defaultPrefs();
    assert.equal(revivePrefs({ sidePanel: "swarm" }, fallback).sidePanel, "crew");
    assert.equal(revivePrefs({ swarmWidth: 640 }, fallback).crewWidth, 640);
    assert.equal(revivePrefs({ swarmWidth: 640, crewWidth: 700 }, fallback).crewWidth, 700, "the new key wins");
    assert.equal(revivePrefs({ swarmWidth: 9_999 }, fallback).crewWidth, DEFAULT_CREW_WIDTH);
  });

  it("swaps the slot between the file viewer and the Crew panel, one at a time", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    try {
      const prefs = () => controller.store.get().prefs;
      controller.toggleCrewPanel();
      assert.equal(prefs().sidePanel, "crew");
      assert.equal(prefs().filesOpen, false);
      controller.toggleFiles();
      assert.equal(prefs().sidePanel, "files", "opening files closes the Crew panel");
      assert.equal(prefs().filesOpen, true);
      controller.toggleCrewPanel(true);
      assert.equal(prefs().sidePanel, "crew");
      assert.equal(prefs().filesOpen, false);
      controller.toggleCrewPanel();
      assert.equal(prefs().sidePanel, "none");
      controller.openFile("s1", "README.md");
      assert.equal(prefs().sidePanel, "files", "opening a file shows the viewer");
      controller.setCrewWidth(10_000);
      assert.equal(prefs().crewWidth, 800);
      controller.setCrewWidth(10);
      assert.equal(prefs().crewWidth, 400);
    } finally {
      stop();
    }
  });

  it("keeps a retry pending until the next attempt shows, and a skip until the outcome does", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    try {
      client.handler?.(workflow(1, [{ childId: "c1", attempt: 1, status: "scheduled", label: "audit:routes" }, { childId: "c2", attempt: 1, status: "scheduled", label: "audit:schema" }]));
      client.handler?.(workflow(2, [{ childId: "c1", attempt: 1, status: "terminal", terminal: "failed" }, { childId: "c2", attempt: 1, status: "started" }]));
      await settle();
      const failed = agentOf(controller, "c1");
      assert.equal(failed.state, "failed");
      assert.equal(await controller.crewAction("s1", failed, "retry"), true);
      assert.deepEqual(client.actions.at(-1), "workflow:s1:retry:run-1:c1@1");
      assert.deepEqual(controller.store.get().crew.pending, { "s1:c1:1": "retry" });
      assert.equal(agentOf(controller, "c2").pending, null);
      client.handler?.(workflow(3, [{ childId: "c1", attempt: 2, status: "scheduled", label: "audit:routes" }, { childId: "c2", attempt: 1, status: "started" }]));
      await settle();
      assert.deepEqual(controller.store.get().crew.pending, {}, "attempt 2 on the wire confirms the retry");
      assert.equal(agentOf(controller, "c1").attempt, 2);

      const working = agentOf(controller, "c2");
      assert.equal(await controller.crewAction("s1", working, "skip"), true);
      assert.deepEqual(client.actions.at(-1), "workflow:s1:skip:run-1:c2@1");
      assert.deepEqual(controller.store.get().crew.pending, { "s1:c2:1": "stop" });
      assert.deepEqual(controller.store.get().crew.skipped, ["s1:c2:1"]);
      assert.equal(agentOf(controller, "c2").pending, "stop");
      client.handler?.(workflow(4, [{ childId: "c1", attempt: 2, status: "started" }, { childId: "c2", attempt: 1, status: "terminal", terminal: "cancelled" }]));
      await settle();
      assert.deepEqual(controller.store.get().crew.pending, {});
      const skipped = crewView(controller.store.get().threads["s1"]!.fold, SESSION, Date.now(), { skipped: controller.store.get().crew.skipped }).runs[0]!.agents.find((a) => a.id === "c2");
      assert.equal(skipped?.skippedBy, "you");
    } finally {
      stop();
    }
  });

  it("clears a pending action the workflow refuses", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    try {
      client.handler?.(workflow(1, [{ childId: "c1", attempt: 1, status: "started", label: "audit:routes" }]));
      await settle();
      client.workflowError = new AncillaError("stale", 409, "stale_attempt");
      assert.equal(await controller.crewAction("s1", agentOf(controller, "c1"), "stop"), false);
      assert.deepEqual(controller.store.get().crew.pending, {});
      assert.equal(controller.store.get().toasts.at(-1)?.title, "That agent already moved on");
      assert.equal(await controller.crewAction("s1", { ...agentOf(controller, "c1"), workflowRunId: null }, "retry"), false, "no run id, nothing to send");
    } finally {
      stop();
    }
  });

  it("stops a background task through the task command and clears the flag when it ends", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    try {
      client.handler?.(task(1, "inProgress"));
      await settle();
      const running = agentOf(controller, "task-1");
      assert.equal(running.kind, "task");
      assert.equal(await controller.crewAction("s1", running, "retry"), false, "a task cannot be retried from here");
      assert.equal(await controller.crewAction("s1", running, "stop"), true);
      assert.equal(client.actions.at(-1), "task:s1:stop:task-1");
      assert.equal(agentOf(controller, "task-1").pending, "stop");
      client.handler?.(task(2, "completed"));
      await settle();
      assert.deepEqual(controller.store.get().crew.pending, {});
      assert.equal(agentOf(controller, "task-1").state, "done");
    } finally {
      stop();
    }
  });

  it("stops everything in one thread and says what it asked to stop", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    try {
      client.handler?.(workflow(1, [{ childId: "c1", attempt: 1, status: "started", label: "audit:routes" }]));
      client.handler?.(task(1, "inProgress"));
      await settle();
      assert.deepEqual(await controller.stopEverything("s1"), { runs: ["audit"], tasks: ["npm run docs:build"] });
      assert.deepEqual(client.actions.slice(-2), ["workflow:s1:cancel:run-1", "task:s1:stopAll"]);
      assert.deepEqual(controller.store.get().crew.pending, { "s1:task-1:1": "stop" });
      assert.deepEqual(await controller.stopEverything("s2"), { runs: [], tasks: [] }, "a thread this client does not hold has nothing to stop");
      assert.equal(await controller.stopRun("s1", "wf"), true);
      assert.equal(client.actions.at(-1), "workflow:s1:cancel:run-1");
      assert.equal(await controller.stopRun("s1", "nope"), false);
    } finally {
      stop();
    }
  });

  it("stops live native agents with everything else and waits for acceptance without inventing completion", async () => {
    const client = new FakeClient();
    let accept!: () => void;
    const admitted = new Promise<void>((resolve) => { accept = resolve; });
    client.subagent = async (sessionId, action, id) => {
      client.actions.push(`subagent:${sessionId}:${action}:${id}`);
      await admitted;
    };
    const { controller, stop } = await started(client);
    try {
      client.handler?.(workflow(1, [{ childId: "c1", attempt: 1, status: "started", label: "audit:routes" }]));
      client.handler?.(task(1, "inProgress"));
      client.handler?.(nativeSpawn("working"));
      client.handler?.(nativeSpawn("finished"));
      client.handler?.(nativeDone("finished"));
      await settle();

      let answered = false;
      const stopping = controller.stopEverything("s1").then((result) => { answered = true; return result; });
      await flushMicrotasks();
      assert.equal(answered, false, "a pending command is not reported as an accepted stop");
      assert.equal(agentOf(controller, "working").state, "working");
      assert.equal(agentOf(controller, "working").pending, "stop");
      assert.ok(client.actions.includes("workflow:s1:cancel:run-1"));
      assert.ok(client.actions.includes("task:s1:stopAll"), "native admission does not hold up background stops");
      assert.deepEqual(client.actions.filter((action) => action.startsWith("subagent:")), ["subagent:s1:stop:working"]);

      accept();
      assert.deepEqual(await stopping, { runs: ["audit"], tasks: ["npm run docs:build"], agents: ["native-working"] });
      assert.equal(agentOf(controller, "working").state, "working", "admission does not mean the child has stopped");
      assert.equal(agentOf(controller, "working").pending, "stop");
      client.handler?.(nativeDone("working"));
      await settle();
      assert.equal(agentOf(controller, "working").state, "done");
      assert.equal(agentOf(controller, "working").pending, null);
    } finally {
      accept();
      stop();
    }
  });

  it("returns only accepted bulk stops and clears pending native and task flags on refusal", async () => {
    const client = new FakeClient();
    client.workflowError = new Error("The run refused the stop.");
    client.task = async () => { throw new Error("The tasks refused the stop."); };
    client.subagent = async (_sessionId, _action, id) => {
      if (id === "refused") throw new Error("The agent refused the stop.");
    };
    const { controller, stop } = await started(client);
    try {
      client.handler?.(workflow(1, [{ childId: "c1", attempt: 1, status: "started", label: "audit:routes" }]));
      client.handler?.(task(1, "inProgress"));
      client.handler?.(nativeSpawn("accepted"));
      client.handler?.(nativeSpawn("refused"));
      await settle();
      assert.deepEqual(await controller.stopEverything("s1"), { runs: [], tasks: [], agents: ["native-accepted"] });
      assert.deepEqual(controller.store.get().crew.pending, { "s1:accepted:1": "stop" });
      assert.equal(agentOf(controller, "refused").pending, null);
      assert.equal(agentOf(controller, "refused").state, "working");
      assert.equal(agentOf(controller, "task-1").pending, null);
    } finally {
      stop();
    }
  });

  it("routes a Crew stop on a research run to stopResearch, refuses worker controls, and stops research with everything else", async () => {
    const client = new FakeClient();
    const research = runningResearch();
    client.researchRuns.push(research);
    client.transcript = async () => load({ researchRuns: [research] });
    const { controller, stop } = await started(client);
    try {
      client.handler?.(workflow(1, [{ childId: "c1", attempt: 1, status: "started", label: "audit:routes" }]));
      await settle();
      const threadOf = () => controller.store.get().threads["s1"]!;
      const vm = crewView(threadOf().fold, SESSION, Date.now(), { researchRuns: threadOf().researchRuns });
      const worker = vm.runs.flatMap((run) => run.agents).find((candidate) => candidate.id === "research:run-1:A3");
      assert.ok(worker);
      assert.equal(await controller.crewAction("s1", worker, "stop"), false, "a worker takes no stop of its own");
      assert.equal(await controller.crewAction("s1", worker, "retry"), false);
      assert.deepEqual(controller.store.get().crew.pending, {}, "nothing is marked pending for it");
      assert.deepEqual(client.researchStops, []);

      const stopped = await controller.stopEverything("s1");
      assert.deepEqual([...stopped.runs].sort(), ["audit", vm.runs.find((run) => run.kind === "research")?.name].sort());
      assert.deepEqual(stopped.tasks, []);
      assert.equal(client.actions.at(-1), "workflow:s1:cancel:run-1");
      assert.deepEqual(client.researchStops, [{ runId: "run-1", writeReport: true }], "the composer's switch says a stop writes a report");
      assert.equal(threadOf().researchRuns[0]?.status, "partial", "the answer to the stop lands on the run");
      assert.equal(controller.store.get().researchStopping["run-1"], undefined);

      const again = runningResearch({ runId: "run-2" });
      client.researchRuns.push(again);
      client.handler?.({ type: "research-run", sessionId: "s1", run: again });
      await settle();
      controller.setResearchStopWrites(false);
      assert.equal(await controller.stopRun("s1", "research:run-2"), true);
      assert.deepEqual(client.researchStops.at(-1), { runId: "run-2", writeReport: false });
      assert.equal(threadOf().researchRuns.find((run) => run.runId === "run-2")?.status, "cancelled");
      assert.equal(await controller.stopRun("s1", "research:missing"), false, "an unknown run is refused with a toast");
      assert.equal(controller.store.get().toasts.at(-1)?.title, "Could not stop the research run");
    } finally {
      stop();
    }
  });

  it("notes when a thread was left, and forgets it once the recap is dismissed", async () => {
    const client = new FakeClient();
    const other: SessionSummary = { ...SESSION, sessionId: "s2", title: "Other" };
    client.listSessions = async () => [SESSION, other];
    const { controller, stop } = await started(client);
    try {
      assert.deepEqual(controller.store.get().crew.leftAt, {});
      controller.openThread("s2");
      await settle();
      const left = controller.store.get().crew.leftAt["s1"];
      assert.ok(typeof left === "number" && left > 0, "leaving the thread notes when");
      controller.markLeft("s2", 123);
      assert.equal(controller.store.get().crew.leftAt["s2"], 123);
      controller.dismissRecap("s1");
      assert.equal(controller.store.get().crew.leftAt["s1"], undefined);
      assert.deepEqual(controller.store.get().crew.dismissedRecaps, ["s1"]);
      controller.markLeft("s1", 456);
      assert.deepEqual(controller.store.get().crew.dismissedRecaps, [], "a new absence gets a new recap");
      controller.dismissReport("s1", "wf");
      controller.dismissReport("s1", "wf");
      assert.deepEqual(controller.store.get().crew.dismissedReports, ["s1:wf"]);
    } finally {
      stop();
    }
  });

  it("drives the panel state and names the window through the shell", async () => {
    const client = new FakeClient();
    const titles: string[] = [];
    const shell = { ...platform("#/t/s1"), setWindowTitle: (title: string) => { titles.push(title); } };
    const controller = new AncillaController(client, shell);
    const stop = controller.start();
    await settle();
    await settle();
    try {
      const panel = () => controller.store.get().crew.panels["s1"];
      assert.equal(panel(), undefined);
      controller.inspectAgent("s1", "c1");
      assert.deepEqual(panel(), { mode: "inspector", inspectId: "c1", filter: "all", query: "", timelineOpen: true, openPhases: [] });
      assert.equal(controller.store.get().prefs.sidePanel, "crew", "inspecting opens the panel");
      controller.inspectAgent("s1", null);
      assert.equal(panel()?.mode, "roster");
      controller.setCrewFilter("s1", "failed", "judge:");
      assert.equal(panel()?.filter, "failed");
      assert.equal(panel()?.query, "judge:");
      controller.setCrewFilter("s1", "all");
      assert.equal(panel()?.query, "judge:", "the query stays unless given");
      controller.toggleTimeline("s1");
      assert.equal(panel()?.timelineOpen, false);
      controller.togglePhase("s1", "Judge");
      controller.togglePhase("s1", "Design");
      controller.togglePhase("s1", "Judge");
      assert.deepEqual(panel()?.openPhases, ["Design"]);
      controller.setActivityOpen(true);
      assert.equal(controller.store.get().crew.activityOpen, true);
      controller.setWindowTitle("(1) Probe — Ancilla");
      assert.deepEqual(titles, ["(1) Probe — Ancilla"]);
    } finally {
      stop();
    }
  });
});

function linuxSetupView(status: LinuxSetupView["installation"]["status"] = "idle"): LinuxSetupView {
  return {
    supported: true,
    museFound: status === "installed",
    installation: { status, phase: status === "installed" ? "complete" : "idle", message: "Setup status", attemptId: status === "idle" ? null : "install-1", loginUrl: null, loginCode: null },
    storage: { status: "ready", path: "/home/person/.local/share/muse", message: "Storage is ready." },
  };
}

class LinuxSetupClient extends FakeClient {
  setup = linuxSetupView();
  setupAccounts: (string | null)[] = [];
  cancelled: string[] = [];
  repaired: (string | null)[] = [];
  probes = 0;
  override async probeEnvironment() {
    this.probes++;
    return { ...await super.probeEnvironment(), museFound: this.setup.museFound };
  }
  async linuxSetup(accountId: string | null = null) {
    this.setupAccounts.push(accountId);
    return this.setup;
  }
  async installLinuxMuse() {
    this.setup = linuxSetupView("installing");
    return this.setup;
  }
  async cancelLinuxMuseInstall(attemptId: string) {
    this.cancelled.push(attemptId);
    this.setup = linuxSetupView("cancelled");
    return this.setup;
  }
  async repairLinuxStorage(accountId: string | null = null) {
    this.repaired.push(accountId);
    this.setup = { ...this.setup, storage: { ...this.setup.storage, status: "ready" as const, message: "Folder permissions repaired." } };
    return this.setup;
  }
}

function linuxController(client: FakeClient, desktop?: Platform["linuxDesktop"]) {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timer = 0;
  const shell: Platform = { ...platform(""), linuxDesktop: desktop,
    schedule: (fn, ms) => { timers.set(++timer, { fn, ms }); return timer; },
    cancel: (id) => { timers.delete(id as number); },
  };
  const controller = new AncillaController(client, shell);
  const stop = controller.start();
  return { controller, timers, stop, tick(ms: number) {
    const pending = [...timers].find(([, value]) => value.ms === ms);
    assert.ok(pending, `expected a ${ms}ms timer`);
    timers.delete(pending[0]);
    pending[1].fn();
  } };
}

describe("guided Linux setup", () => {
  it("continues setup after a mount-cleanup-remount and ignores the older boot", async () => {
    const client = new LinuxSetupClient();
    const current = await client.probeEnvironment();
    let finishOld!: (value: typeof current) => void;
    let probes = 0;
    client.probeEnvironment = () => ++probes === 1
      ? new Promise((resolve) => { finishOld = resolve; })
      : Promise.resolve(current);
    const { controller, stop } = linuxController(client);
    stop();
    const stopAgain = controller.start();
    try {
      await flushMicrotasks();
      assert.equal(controller.store.get().linuxSetup?.installation.status, "idle");
      assert.equal(controller.store.get().boot, "ready");
      finishOld({ ...current, museFound: true });
      await flushMicrotasks();
      assert.equal(controller.store.get().env?.museFound, false);
      await controller.installLinuxMuse();
      assert.equal(controller.store.get().linuxSetup?.installation.status, "installing");
    } finally { stopAgain(); }
  });

  it("polls a Muse installation and opens the product only after the installer completes", async () => {
    const client = new LinuxSetupClient();
    const { controller, stop, tick, timers } = linuxController(client);
    await flushMicrotasks();
    assert.equal(controller.store.get().env?.museFound, false);
    assert.equal(controller.store.get().sessionsLoaded, false);
    await controller.installLinuxMuse();
    assert.equal(controller.store.get().linuxSetup?.installation.status, "installing");
    client.setup = { ...client.setup, museFound: true, installation: { ...client.setup.installation, phase: "signin", loginUrl: "https://www.meta.ai/device", loginCode: "ABCD" } };
    tick(1_500);
    await flushMicrotasks();
    assert.equal(controller.store.get().linuxSetup?.installation.loginCode, "ABCD");
    assert.equal(controller.store.get().env?.museFound, false, "a partially installed launcher must not finish setup");
    assert.equal(client.probes, 1);
    client.setup = linuxSetupView("installed");
    tick(1_500);
    await flushMicrotasks(50);
    assert.equal(controller.store.get().env?.museFound, true);
    assert.equal(controller.store.get().sessionsLoaded, true);
    assert.equal(controller.store.get().boot, "ready");
    assert.equal([...timers.values()].some((value) => value.ms === 1_500), false);
    stop();
  });

  it("cancels the displayed attempt and ignores a late in-flight poll", async () => {
    const client = new LinuxSetupClient();
    const { controller, stop } = linuxController(client);
    await flushMicrotasks();
    await controller.installLinuxMuse();
    let resolve!: (view: LinuxSetupView) => void;
    client.linuxSetup = async () => new Promise<LinuxSetupView>((done) => { resolve = done; });
    const pending = controller.refreshLinuxSetup();
    await controller.cancelLinuxMuseInstall();
    assert.deepEqual(client.cancelled, ["install-1"]);
    resolve(linuxSetupView("installing"));
    await pending;
    assert.equal(controller.store.get().linuxSetup?.installation.status, "cancelled");
    assert.equal(controller.store.get().busy["linux-setup:check"], undefined);
    assert.equal(controller.store.get().busy["linux-setup:cancel"], undefined);
    stop();
  });

  it("retains a failed installation for retry even if its launcher is already on disk", async () => {
    const client = new LinuxSetupClient();
    const { controller, stop } = linuxController(client);
    await flushMicrotasks();
    client.installLinuxMuse = async () => ({ ...linuxSetupView("error"), museFound: true });
    await controller.installLinuxMuse();
    assert.equal(controller.store.get().env?.museFound, false);
    assert.equal(controller.store.get().linuxSetup?.installation.status, "error");
    assert.equal(client.probes, 1);
    stop();
  });

  it("keeps the composer on its route and offers named-account storage recovery after a failed start", async () => {
    const client = new LinuxSetupClient();
    client.setup = linuxSetupView("installed");
    client.projects[0] = { ...client.projects[0]!, defaultAccountId: "work" };
    client.startSession = async () => { throw new AncillaError("Muse cannot use /home/person/.ancilla/accounts/work: the folder belongs to another account.", 409, "muse_storage_unavailable"); };
    const { controller, stop } = linuxController(client);
    await flushMicrotasks(50);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    const route = controller.store.get().route;
    assert.equal(await controller.send("Keep this draft"), false);
    await flushMicrotasks();
    assert.deepEqual(controller.store.get().route, route);
    assert.equal(controller.store.get().linuxSetupAccountId, "work");
    assert.equal(client.setupAccounts.at(-1), "work");
    const toast = controller.store.get().toasts.at(-1);
    assert.equal(toast?.title, "Muse storage needs attention");
    assert.match(toast?.detail ?? "", /Your draft is still here/);
    assert.equal(toast?.action?.label, "Open Linux setup");
    toast?.action?.run();
    assert.equal(controller.store.get().route.kind, "settings");
    await controller.repairLinuxStorage();
    assert.deepEqual(client.repaired, ["work"]);
    stop();
  });

  it("translates legacy Unsafe path errors into a recovery action", async () => {
    const client = new LinuxSetupClient();
    client.setup = linuxSetupView("installed");
    client.startSession = async () => { throw new Error("session/start: read surviving deletion authority: deletion registry authority is unavailable: Unsafe path"); };
    const { controller, stop } = linuxController(client);
    await flushMicrotasks(50);
    await controller.send("Keep this draft too");
    const toast = controller.store.get().toasts.at(-1);
    assert.equal(toast?.title, "Muse storage needs attention");
    assert.match(toast?.detail ?? "", /fix its permissions/);
    assert.doesNotMatch(toast?.detail ?? "", /Unsafe path|session\/start/);
    stop();
  });

  it("reports setup endpoint failures without turning a reachable app into a boot error", async () => {
    const client = new LinuxSetupClient();
    client.setup = linuxSetupView("installed");
    client.linuxSetup = async () => { throw new AncillaError("Not found", 404); };
    const { controller, stop } = linuxController(client);
    await flushMicrotasks(50);
    assert.equal(controller.store.get().boot, "ready");
    assert.match(controller.store.get().linuxSetupError ?? "", /server needs an update/);
    stop();
  });

  it("honors the desktop-shortcut choice and ignores old status during installation", async () => {
    const client = new LinuxSetupClient();
    client.setup = linuxSetupView("installed");
    const old: LinuxDesktopStatus = { kind: "appimage", menuInstalled: false, desktopShortcutInstalled: false, desktopShortcutSupported: true, canInstall: true, restartRequired: false, installedPath: null };
    let resolve!: (status: LinuxDesktopStatus) => void;
    const options: boolean[] = [];
    const desktop: NonNullable<Platform["linuxDesktop"]> = {
      status: async () => new Promise<LinuxDesktopStatus>((done) => { resolve = done; }),
      install: async ({ desktopShortcut }) => { options.push(desktopShortcut); return { ...old, menuInstalled: true, desktopShortcutInstalled: desktopShortcut, restartRequired: true, installedPath: "/home/person/Applications/Ancilla.AppImage" }; },
      relaunch: async () => { throw new Error("Could not launch the installed copy"); },
    };
    const { controller, stop } = linuxController(client, desktop);
    await flushMicrotasks(50);
    await controller.installLinuxDesktop(false);
    resolve(old);
    await flushMicrotasks();
    assert.deepEqual(options, [false]);
    assert.equal(controller.store.get().linuxDesktop?.menuInstalled, true);
    assert.equal(controller.store.get().linuxDesktop?.desktopShortcutInstalled, false);
    assert.equal(controller.store.get().linuxDesktop?.restartRequired, true);
    await controller.relaunchLinuxDesktop();
    assert.match(controller.store.get().linuxDesktopError ?? "", /Could not launch/);
    stop();
  });

  it("stops installation polling when the UI is disposed", async () => {
    const client = new LinuxSetupClient();
    const { controller, stop, timers } = linuxController(client);
    await flushMicrotasks();
    await controller.installLinuxMuse();
    assert.equal([...timers.values()].some((value) => value.ms === 1_500), true);
    stop();
    assert.equal([...timers.values()].some((value) => value.ms === 1_500), false);
  });

  it("keeps non-Linux setup on the existing installation path", async () => {
    const client = new LinuxSetupClient();
    client.probeEnvironment = async () => ({ platform: "darwin", wslAvailable: false, defaultDistro: null, museFound: true, musePath: "/usr/bin/muse", version: "0.20.3", persistent: true });
    const { controller, stop } = linuxController(client);
    await flushMicrotasks(50);
    controller.navigate({ kind: "settings" });
    await controller.installLinuxMuse();
    assert.deepEqual(client.setupAccounts, []);
    assert.equal(controller.store.get().linuxSetup, null);
    stop();
  });
});
