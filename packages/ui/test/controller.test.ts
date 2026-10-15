import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AncillaError, type EventHandler, type AncillaClient } from "../src/client.js";
import { AncillaController, staleThreadReason, type Platform } from "../src/model/controller.js";
import { buildTurns } from "../src/model/fold.js";
import { DEFAULT_CREW_WIDTH, ZOOM_MAX, ZOOM_MIN, defaultPrefs, revivePrefs } from "../src/model/store.js";
import { crewBusy, crewView } from "../src/model/crew.js";
import { modelIdError, modelMenu, modelsShown, offeredByAnother, tryTypedModel } from "../src/model/models.js";
import type { AncillaEvent, ModelCatalog, ModelOption, ProjectView, SessionSummary, SkillEntry, TranscriptLoad, UserInputRequest, ViewEvent, ResearchConfig, ResearchExport, ResearchExportFormat, ResearchRunView, ResearchSettings } from "../src/types.js";
import { historyEvents } from "./fixtures/probe.js";
import { fakeResearchRun, runningResearch } from "./fixtures/research.js";
import { LIVE_1_4_0, LIVE_1_4_7, answer } from "./fixtures/picker-catalogs.js";
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

type ModelAnswer = ModelOption[] | Error | { models: ModelOption[]; source: string | null };

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
  /** The reasoning effort each turn was sent with, in order; undefined when it carried none. */
  turnEfforts: (string | undefined)[] = [];
  async sendTurn(
    sessionId: string,
    text: string,
    options?: { ifBusy?: string; displayText?: string; reasoningEffort?: string; attachments?: { name: string; mediaType: string; base64: string }[] },
  ) {
    this.turnEfforts.push(options?.reasoningEffort);
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
  /** What `listModels` answers once `modelQueue` has run dry, with the source it says the rows came from. */
  models: ModelOption[] = [];
  modelSource: string | null = "providerCatalog";
  /** The next answers, in order: rows, an error to throw, rows with a source, or a function that holds the answer back. */
  modelQueue: (ModelAnswer | (() => Promise<ModelAnswer>))[] = [];
  /** Every ask for models, with the thread and account it was for. */
  modelCalls: { sessionId?: string; accountId?: string | null }[] = [];
  private async nextModels(sessionId?: string, accountId?: string | null): Promise<{ models: ModelOption[]; source: string | null }> {
    this.modelCalls.push({ sessionId, accountId });
    const next = this.modelQueue.shift();
    const answer = typeof next === "function" ? await next() : next;
    if (answer instanceof Error) {
      throw answer;
    }
    if (Array.isArray(answer)) {
      return { models: answer, source: this.modelSource };
    }
    return answer ?? { models: this.models, source: this.modelSource };
  }
  async listModels(sessionId?: string, accountId?: string | null) {
    return (await this.nextModels(sessionId, accountId)).models;
  }
  async listModelCatalog(sessionId?: string, accountId?: string | null): Promise<ModelCatalog> {
    const { models, source } = await this.nextModels(sessionId, accountId);
    return { models, source, providerId: "meta", profileId: "default", hostVersion: "1.4.7" };
  }
  restarts = 0;
  restartError: Error | null = null;
  async restartHosts() {
    this.restarts += 1;
    if (this.restartError) {
      throw this.restartError;
    }
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
  modelSwitches: { sessionId: string; modelId: string }[] = [];
  setModelError: Error | null = null;
  /** One entry per switch, in order: a promise the switch waits on before Muse answers it, failing if that rejects. */
  modelGates: Promise<void>[] = [];
  async setSessionModel(sessionId: string, modelId: string) {
    this.modelSwitches.push({ sessionId, modelId });
    const gate = this.modelGates.shift();
    if (gate) {
      await gate;
    }
    if (this.setModelError) {
      const error = this.setModelError;
      this.setModelError = null;
      throw error;
    }
  }
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
  planMetadata: Pick<import("../src/types.js").PlanUsageReport, "accountId" | "saved" | "savedAccountIds" | "status" | "accounts"> = {};
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
    assert.equal(controller.store.get().planUsageAccounts.find((entry) => entry.accountId === "work")?.usage?.window.usedPercent, 77);
    stop();
  });

  it("keeps the default subscription separate from a newer named account and retains explicit selection", async () => {
    const client = new FakeClient();
    const reading = (percent: number, at: number) => ({ tier: "high", observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: 9000, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: 9000, windowDurationMins: null } });
    const login = reading(12, 100);
    const work = reading(85, 200);
    client.plan = work;
    client.planByAccount = { work };
    client.planMetadata = { accountId: "work", status: "ready", accounts: [
      { accountId: null, usage: login, planName: "Muse Plus", source: "meta", status: "ready", checkedAtMs: 100 },
      { accountId: "work", usage: work, planName: "Muse Plus", source: "meta", status: "ready", checkedAtMs: 200 },
    ] };
    const { controller, stop } = await started(client);
    controller.selectPlanUsageAccount(null);
    client.handler?.({ type: "plan-usage", usage: reading(18, 150), accountId: null });
    client.handler?.({ type: "plan-usage", usage: reading(88, 250), accountId: "work" });
    assert.equal(controller.store.get().planUsageSelectedAccountId, null);
    const records = controller.store.get().planUsageAccounts;
    assert.equal(records.find((entry) => entry.accountId === null)?.usage?.window.usedPercent, 18);
    assert.equal(records.find((entry) => entry.accountId === "work")?.usage?.window.usedPercent, 88);
    assert.equal(records.find((entry) => entry.accountId === null)?.checkedAtMs, 100, "runtime events do not advance the direct account check");
    stop();
  });

  it("adopts Meta provenance after an equal-time observation arrives before the quota response", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const usage = { tier: "1234567", observedAtMs: 300,
      window: { usedPercent: 23, resetsAtMs: 9000, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: 9000, windowDurationMins: null } };
    let finish!: (report: import("../src/types.js").PlanUsageReport) => void;
    client.planUsage = () => new Promise((resolve) => { finish = resolve; });
    const refresh = controller.loadPlanUsage();
    client.handler?.({ type: "plan-usage", usage, accountId: null });
    finish({ usage, byAccount: {}, accountId: null, status: "ready", accounts: [
      { accountId: null, usage, source: "meta", status: "ready", checkedAtMs: 300, planName: "Muse Plus" },
    ] });
    await refresh;
    assert.equal(controller.store.get().planUsageAccounts[0]?.source, "meta");
    assert.equal(controller.store.get().planUsageAccounts[0]?.planName, "Muse Plus");
    client.handler?.({ type: "plan-usage", usage: { ...usage }, accountId: null });
    assert.equal(controller.store.get().planUsageAccounts[0]?.source, "meta", "a delayed copy of the same observation does not erase verified provenance");
    stop();
  });

  it("keeps a newer runtime observation when an older account response or network failure arrives", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    const reading = (percent: number, at: number) => ({ tier: "high", observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: 9000, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: 9000, windowDurationMins: null } });
    let finish!: (report: import("../src/types.js").PlanUsageReport) => void;
    client.planUsage = () => new Promise((resolve) => { finish = resolve; });
    let refresh = controller.loadPlanUsage();
    client.handler?.({ type: "plan-usage", usage: reading(45, 400), accountId: null });
    finish({ usage: reading(20, 300), byAccount: {}, status: "unavailable", accounts: [
      { accountId: null, usage: reading(20, 300), source: "saved", status: "unavailable", checkedAtMs: 300, planName: "Muse Plus" },
    ] });
    await refresh;
    assert.equal(controller.store.get().planUsageAccounts[0]?.usage?.window.usedPercent, 45);
    assert.equal(controller.store.get().planUsageAccounts[0]?.source, "runtime");
    let reject!: (reason: Error) => void;
    client.planUsage = () => new Promise((_, fail) => { reject = fail; });
    refresh = controller.loadPlanUsage();
    client.handler?.({ type: "plan-usage", usage: reading(50, 500), accountId: null });
    reject(new Error("Offline"));
    await refresh;
    assert.equal(controller.store.get().planUsageAccounts[0]?.status, "runtime-only");
    assert.equal(controller.store.get().planUsageAccounts[0]?.usage?.window.usedPercent, 50);
    stop();
  });

  it("does not let an old runtime event revive a reading invalidated by a newer account check", async () => {
    const client = new FakeClient();
    const usage = { tier: "high", observedAtMs: 100,
      window: { usedPercent: 23, resetsAtMs: 9000, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: 9000, windowDurationMins: null } };
    client.planMetadata = { status: "unobserved", accounts: [
      { accountId: null, usage, source: "saved", status: "not-reported", checkedAtMs: 300, planName: "Muse Plus" },
    ] };
    const { controller, stop } = await started(client);
    client.handler?.({ type: "plan-usage", usage: { ...usage, observedAtMs: 200 }, accountId: null });
    assert.equal(controller.store.get().planUsageAccounts[0]?.status, "not-reported");
    assert.equal(controller.store.get().planUsageAccounts[0]?.usage?.observedAtMs, 100);
    stop();
  });

  it("opens Usage on the thread account without switching after another account reports", async () => {
    const client = new FakeClient();
    const { controller, stop } = await started(client);
    controller.store.set((state) => ({ ...state, route: { kind: "thread", sessionId: "s1" }, sessions: { ...state.sessions, s1: { ...SESSION, accountId: "work" } } }));
    controller.navigate({ kind: "usage" });
    assert.equal(controller.store.get().planUsageSelectedAccountId, "work");
    controller.selectPlanUsageAccount(null);
    const usage = { tier: "high", observedAtMs: 100,
      window: { usedPercent: 23, resetsAtMs: 9000, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: 9000, windowDurationMins: null } };
    client.handler?.({ type: "plan-usage", usage, accountId: "work" });
    assert.equal(controller.store.get().planUsageSelectedAccountId, null);
    stop();
  });

  describe("plan usage upkeep", () => {
    type Report = import("../src/types.js").PlanUsageReport;
    const reading = (percent: number, at: number) => ({ tier: "high", observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: at + 5000, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: at + 9000, windowDurationMins: null } });
    const quiet: Report = { usage: null, byAccount: {}, status: "unobserved" };
    const workAccount = { id: "work", name: "Work", hasLogin: true, email: "work@example.test", lastUsedAt: null };
    const defaultRecord = { accountId: null, usage: null, planName: null, source: null, status: "not-reported", checkedAtMs: 100 } as const;
    const workRecord = (usage: ReturnType<typeof reading>) => ({ accountId: "work", usage, planName: "Muse Plus", source: "meta", status: "ready", checkedAtMs: 300 }) as const;

    it("never raises the loading flag for a background read, and a click shows it until the shared read ends", async () => {
      const client = new FakeClient();
      const { controller, stop } = await started(client);
      const flag = [controller.store.get().planUsageLoading];
      const unsubscribe = controller.store.subscribe(() => {
        const loading = controller.store.get().planUsageLoading;
        if (flag.at(-1) !== loading) flag.push(loading);
      });
      let reads = 0;
      let finish!: (report: Report) => void;
      client.planUsage = () => { reads += 1; return new Promise((resolve) => { finish = resolve; }); };

      try {
        const background = controller.loadPlanUsage({ background: true });
        assert.equal(controller.store.get().planUsageLoading, false, "Refresh does not spin by itself");
        finish(quiet);
        await background;
        assert.deepEqual(flag, [false], "the flag was never raised");

        const running = controller.loadPlanUsage({ background: true });
        const click = controller.loadPlanUsage();
        assert.equal(click, running, "a click joins the read in flight");
        assert.equal(controller.store.get().planUsageLoading, true, "and shows it");
        void controller.loadPlanUsage({ background: true });
        assert.equal(controller.store.get().planUsageLoading, true, "a later background caller does not hide it");
        assert.equal(reads, 2);
        finish(quiet);
        await click;
        assert.equal(controller.store.get().planUsageLoading, false);
        assert.deepEqual(flag, [false, true, false], "raised once and cleared once when the shared read ended");

        const plain = controller.loadPlanUsage();
        assert.equal(controller.store.get().planUsageLoading, true, "a plain call still sets it");
        finish(quiet);
        await plain;
        assert.equal(controller.store.get().planUsageLoading, false);

        client.planUsage = () => Promise.reject(new Error("offline"));
        await controller.loadPlanUsage();
        assert.equal(controller.store.get().planUsageLoading, false, "a failed read clears it too");
      } finally {
        unsubscribe();
        stop();
      }
    });

    it("forgets a removed account's readings, selection and project default, then reads the meter again", async () => {
      const client = new FakeClient();
      client.accounts = [workAccount];
      client.projects = client.projects.map((project) => ({ ...project, defaultAccountId: "work" }));
      const work = reading(60, 300);
      client.plan = work;
      client.planByAccount = { work };
      client.planMetadata = { accountId: "work", saved: true, savedAccountIds: ["work"], status: "ready", accounts: [defaultRecord, workRecord(work)] };
      const { controller, stop } = await started(client);
      try {
        controller.selectPlanUsageAccount("work");
        const before = controller.store.get();
        assert.equal(before.planUsageAccountId, "work");
        assert.ok(before.planUsageAccounts.some((account) => account.accountId === "work"));
        assert.ok(before.planUsageByAccount["work"]);
        assert.deepEqual(before.planUsageSavedAccounts, ["work"]);
        assert.equal(before.projects[0]?.defaultAccountId, "work");

        let reads = 0;
        let finish!: (report: Report) => void;
        client.planUsage = () => { reads += 1; return new Promise((resolve) => { finish = resolve; }); };
        assert.equal(await controller.removeAccount("work"), true);
        await settle();
        // The new read is still open, so everything below is the pruning, not a fresh answer.
        const state = controller.store.get();
        assert.equal(reads, 1, "the meter is read again");
        assert.deepEqual(state.planUsageAccounts.map((account) => account.accountId), [null]);
        assert.deepEqual(state.planUsageByAccount, {});
        assert.deepEqual(state.planUsageSavedAccounts, []);
        assert.equal(state.planUsageSelectedAccountId, null);
        assert.equal(state.planUsageAccountId, null);
        assert.equal(state.planUsage, null);
        assert.ok(state.projects.length > 0 && state.projects.every((project) => project.defaultAccountId === null));
        const { planAccount, planAccountChoices } = await import("../src/model/plan.js");
        assert.deepEqual(planAccountChoices(state), [{ id: null, name: "Default login" }]);
        assert.equal(planAccount(state, "work").usage, null);

        finish({ usage: null, byAccount: {}, status: "unobserved", accounts: [defaultRecord] });
        await settle();
        assert.deepEqual(controller.store.get().planUsageAccounts.map((account) => account.accountId), [null]);
        assert.equal(reads, 1);
      } finally {
        stop();
      }
    });

    it("keeps a removed account out of the meter when a read already in flight still listed it", async () => {
      const client = new FakeClient();
      client.accounts = [workAccount];
      const work = reading(60, 300);
      const { controller, stop } = await started(client);
      try {
        let reads = 0;
        let finish!: (report: Report) => void;
        client.planUsage = () => { reads += 1; return new Promise((resolve) => { finish = resolve; }); };
        const inFlight = controller.loadPlanUsage({ background: true });
        assert.equal(await controller.removeAccount("work"), true);
        assert.equal(reads, 1, "nothing new can start while the old read is open");
        // The server answered that read before the account went.
        finish({ usage: work, byAccount: { work }, accountId: "work", status: "ready", accounts: [defaultRecord, workRecord(work)] });
        await inFlight;
        await settle();
        assert.equal(reads, 2, "so the meter is read once more when it ends");
        finish({ usage: null, byAccount: {}, status: "unobserved", accounts: [defaultRecord] });
        await settle();
        const state = controller.store.get();
        assert.deepEqual(state.planUsageAccounts.map((account) => account.accountId), [null]);
        assert.deepEqual(state.planUsageByAccount, {});
        assert.equal(state.planUsage, null);
      } finally {
        stop();
      }
    });
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
      assert.equal(runs().find((run) => run.runId === "r-third")?.status, "cancelled");
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

// ---------------------------------------------------------------- the model catalog and the model choice

function model(modelId: string, extra: Partial<ModelOption> = {}): ModelOption {
  return {
    modelId,
    displayLabel: modelId,
    description: null,
    isDefault: false,
    isActive: false,
    contextLimit: null,
    outputLimit: null,
    cost: null,
    contributor: /contributor/i.test(modelId),
    efforts: null,
    ...extra,
  };
}

const SPARK = model("muse-spark-1.3", { efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] });
const SPARK_12 = model("muse-spark-1.2", { efforts: ["minimal", "low", "medium", "high", "xhigh"] });
const SPARK_CONTRIBUTOR = model("muse-spark-1.3-contributor", {
  isDefault: true,
  description: "Your content may be used for product improvement.",
  efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
});
const WONDER = model("muse-wonder-1.0", { efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] });
const WONDER_FULL = model("muse-wonder-full-1.0");

/**
 * A fake platform whose clock the test moves, and whose longest timers (the model list's retries) wait for `fire`
 * instead of running: every other delay still collapses to a tick, as in `platform()`.
 */
function heldPlatform(hash = "", hold: number[] = [2_000, 3_000, 10_000, 30_000]) {
  const base = platform(hash);
  const clock = { now: Date.now() };
  const held: { fn: () => void; ms: number; live: boolean }[] = [];
  base.now = () => clock.now;
  base.schedule = (fn, ms) => {
    if (!hold.includes(ms)) {
      return setTimeout(fn, 0);
    }
    const entry = { fn, ms, live: true };
    held.push(entry);
    return entry;
  };
  base.cancel = (handle) => {
    if (handle && typeof handle === "object" && "live" in handle) {
      (handle as { live: boolean }).live = false;
    } else {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  };
  return Object.assign(base, {
    clock,
    /** The delays of the timers still waiting. */
    waiting: () => held.filter((entry) => entry.live).map((entry) => entry.ms),
    /** Runs every waiting timer of that delay. */
    fire: (ms: number) => {
      for (const entry of held.filter((candidate) => candidate.live && candidate.ms === ms)) {
        entry.live = false;
        entry.fn();
      }
    },
  });
}

/** Boots a controller on a held platform, recording every toast it raises, whether or not it is still showing. */
async function startedWith(client: FakeClient, hash = "") {
  const held = heldPlatform(hash);
  const controller = new AncillaController(client, held);
  const toasts: { title: string; detail?: string }[] = [];
  const seen = new Set<number>();
  controller.store.subscribe(() => {
    for (const toast of controller.store.get().toasts) {
      if (!seen.has(toast.id)) {
        seen.add(toast.id);
        toasts.push({ title: toast.title, detail: toast.detail });
      }
    }
  });
  const stop = controller.start();
  await settle();
  await settle();
  return { controller, stop, held, toasts };
}

const NEW_THREAD = "#/new/%2Fwork%2Fapp";

describe("model lists", () => {
  it("loads the default login's list at boot and files it with what Muse says about it", async () => {
    const client = new FakeClient();
    client.models = [SPARK, WONDER];
    const { controller, stop } = await startedWith(client);
    const state = controller.store.get();
    assert.deepEqual(state.accountModels["default"], [SPARK, WONDER]);
    assert.deepEqual(state.models, [SPARK, WONDER]);
    assert.equal(state.modelsStatus["default"]?.status, "ready");
    assert.equal(state.modelsStatus["default"]?.error, null);
    assert.equal(state.modelsStatus["default"]?.catalog?.source, "providerCatalog");
    assert.equal(state.modelsStatus["default"]?.catalog?.hostVersion, "1.4.7");
    assert.equal(typeof state.modelsStatus["default"]?.loadedAt, "number");
    assert.deepEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }]);
    stop();
  });

  it("takes the rows alone from a transport that cannot say where its list came from", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    (client as { listModelCatalog?: unknown }).listModelCatalog = undefined;
    const { controller, stop } = await startedWith(client);
    const state = controller.store.get();
    assert.deepEqual(state.models, [SPARK]);
    assert.equal(state.modelsStatus["default"]?.status, "ready");
    assert.equal(state.modelsStatus["default"]?.catalog?.source, null);
    stop();
  });

  it("says why a failed first load failed and tries once more shortly", async () => {
    const client = new FakeClient();
    client.modelQueue = [new Error("Could not start Muse")];
    client.models = [WONDER];
    const { controller, stop, held } = await startedWith(client);
    let state = controller.store.get();
    assert.equal(state.modelsStatus["default"]?.status, "error");
    assert.equal(state.modelsStatus["default"]?.error, "Could not start Muse");
    assert.deepEqual(state.models, []);
    assert.deepEqual(held.waiting(), [3_000], "one retry is waiting");
    held.fire(3_000);
    await settle();
    state = controller.store.get();
    assert.equal(state.modelsStatus["default"]?.status, "ready");
    assert.equal(state.modelsStatus["default"]?.error, null);
    assert.deepEqual(state.models, [WONDER]);
    assert.equal(client.modelCalls.length, 2);
    stop();
  });

  it("gives up after the one retry and leaves the picker to ask again", async () => {
    const client = new FakeClient();
    client.modelQueue = [new Error("first"), new Error("second")];
    client.models = [WONDER];
    const { controller, stop, held } = await startedWith(client);
    held.fire(3_000);
    await settle();
    assert.equal(controller.store.get().modelsStatus["default"]?.error, "second");
    assert.deepEqual(held.waiting(), [], "no third try on its own");
    assert.equal(client.modelCalls.length, 2);
    controller.setPicker("model");
    await settle();
    assert.equal(client.modelCalls.length, 3, "opening the picker is the way to ask again");
    assert.deepEqual(controller.store.get().models, [WONDER]);
    stop();
  });

  it("reads a stale list again when the picker opens, once, and leaves a fresh one be", async () => {
    const client = new FakeClient();
    client.modelQueue = [new Error("offline")];
    client.models = [SPARK];
    const { controller, stop, held } = await startedWith(client);
    controller.setPicker("model");
    await settle();
    assert.equal(client.modelCalls.length, 2, "exactly one extra ask");
    assert.equal(controller.store.get().modelsStatus["default"]?.status, "ready");
    assert.equal(controller.store.get().models.length, 1);
    controller.setPicker(null);
    controller.setPicker("model");
    await settle();
    assert.equal(client.modelCalls.length, 2, "a list younger than ten minutes is left be");
    held.clock.now += 11 * 60_000;
    controller.setPicker(null);
    controller.setPicker("model");
    await settle();
    assert.equal(client.modelCalls.length, 3, "an older one is read again");
    stop();
  });

  it("keeps the last good list when a refresh fails, and says why", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop } = await startedWith(client);
    const before = controller.store.get().modelsStatus["default"];
    client.modelQueue = [new Error("Muse is not answering")];
    await controller.refreshModels({ force: true });
    const state = controller.store.get();
    assert.equal(state.modelsStatus["default"]?.status, "error");
    assert.equal(state.modelsStatus["default"]?.error, "Muse is not answering");
    assert.deepEqual(state.accountModels["default"], [SPARK]);
    assert.deepEqual(state.models, [SPARK]);
    assert.equal(state.modelsStatus["default"]?.loadedAt, before?.loadedAt, "the time of the last good answer is kept");
    assert.deepEqual(state.modelsStatus["default"]?.catalog, before?.catalog);
    stop();
  });

  it("keeps the newer answer when two asks overlap", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop } = await startedWith(client);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.modelQueue = [
      async () => {
        await gate;
        return [SPARK];
      },
      [WONDER],
    ];
    const older = controller.refreshModels({ force: true });
    const newer = controller.refreshModels({ force: true });
    await newer;
    assert.deepEqual(controller.store.get().models, [WONDER]);
    release();
    await older;
    assert.deepEqual(controller.store.get().models, [WONDER], "the older answer is dropped");
    assert.equal(controller.store.get().modelsStatus["default"]?.status, "ready");
    stop();
  });

  it("does not ask again for a list it is already asking for", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop, held } = await startedWith(client);
    held.clock.now += 11 * 60_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.modelQueue = [
      async () => {
        await gate;
        return [WONDER];
      },
    ];
    const first = controller.refreshModels({});
    const second = controller.refreshModels({});
    assert.equal(client.modelCalls.length, 2, "one ask in flight, not two");
    release();
    await Promise.all([first, second]);
    assert.deepEqual(controller.store.get().models, [WONDER]);
    stop();
  });

  it("reads a thread's account catalog when its host has not loaded the thread", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop } = await startedWith(client);
    client.modelQueue = [new AncillaError("Session is not loaded.", 409, "sessionNotLoaded"), [SPARK, WONDER]];
    await controller.refreshModels({ sessionId: "s1" });
    assert.deepEqual(client.modelCalls.slice(1), [
      { sessionId: "s1", accountId: undefined },
      { sessionId: undefined, accountId: undefined },
    ]);
    assert.deepEqual(controller.store.get().accountModels["thread:s1"], [SPARK, WONDER]);
    assert.equal(controller.store.get().modelsStatus["thread:s1"]?.status, "ready");
    stop();
  });

  it("keeps each catalog under its own key and merges them for lookups", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop } = await startedWith(client);
    client.modelQueue = [[WONDER, SPARK]];
    await controller.refreshModels({ accountId: "work" });
    client.modelQueue = [[WONDER_FULL]];
    await controller.refreshModels({ sessionId: "s1" });
    const state = controller.store.get();
    assert.deepEqual(state.accountModels["default"], [SPARK]);
    assert.deepEqual(state.accountModels["acct:work"], [WONDER, SPARK]);
    assert.deepEqual(state.accountModels["thread:s1"], [WONDER_FULL]);
    assert.deepEqual(state.models.map((m) => m.modelId), ["muse-spark-1.3", "muse-wonder-1.0", "muse-wonder-full-1.0"], "the default login's first, each model once");
    assert.deepEqual(client.modelCalls, [
      { sessionId: undefined, accountId: undefined },
      { sessionId: undefined, accountId: "work" },
      { sessionId: "s1", accountId: undefined },
    ]);
    stop();
  });

  it("holds at most eight threads' lists, letting the one asked for longest ago go", async () => {
    const client = new FakeClient();
    const { controller, stop } = await startedWith(client);
    for (let i = 0; i < 10; i += 1) {
      client.modelQueue = [[model(`only-in-${i}`)]];
      await controller.refreshModels({ sessionId: `t${i}` });
    }
    const state = controller.store.get();
    const threadKeys = Object.keys(state.accountModels).filter((key) => key.startsWith("thread:"));
    assert.equal(threadKeys.length, 8);
    assert.ok(!threadKeys.includes("thread:t0") && !threadKeys.includes("thread:t1"));
    assert.ok(threadKeys.includes("thread:t9"));
    assert.equal(state.modelsStatus["thread:t0"], undefined);
    assert.ok(!state.models.some((m) => m.modelId === "only-in-0"), "what only a dropped list offered is gone from the lookup too");
    assert.ok(state.models.some((m) => m.modelId === "only-in-9"));
    stop();
  });

  it("reads the open thread's own list when its load finishes, and the project's account list on the new-thread screen", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop } = await startedWith(client, "#/t/s1");
    assert.deepEqual(client.modelCalls, [
      { sessionId: undefined, accountId: undefined },
      { sessionId: "s1", accountId: undefined },
    ]);
    assert.equal(controller.store.get().modelsStatus["thread:s1"]?.status, "ready");
    assert.deepEqual(controller.modelsScope(), { sessionId: "s1" });
    controller.setProjectDefaultAccount("/work/app", "work").catch(() => undefined);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    assert.deepEqual(controller.modelsScope(), { accountId: "work" });
    await settle();
    assert.deepEqual(client.modelCalls.at(-1), { sessionId: undefined, accountId: "work" });
    assert.equal(controller.store.get().modelsStatus["acct:work"]?.status, "ready");
    stop();
  });

  it("reads the account's own list when a project's default account changes", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop } = await startedWith(client, NEW_THREAD);
    assert.equal(client.modelCalls.length, 1, "the project is on the default login, whose list boot read");
    client.modelQueue = [[SPARK, WONDER]];
    await controller.setProjectDefaultAccount("/work/app", "work");
    await settle();
    assert.deepEqual(client.modelCalls.at(-1), { sessionId: undefined, accountId: "work" });
    assert.deepEqual(controller.store.get().accountModels["acct:work"], [SPARK, WONDER]);
    assert.deepEqual(controller.modelsScope(), { accountId: "work" });
    stop();
  });

  it("shows the default list for an account whose load failed, but only for display", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop } = await startedWith(client);
    client.modelQueue = [new Error("Sign in to read this account's models")];
    await controller.refreshModels({ accountId: "work" });
    const state = controller.store.get();
    assert.equal(state.modelsStatus["acct:work"]?.status, "error");
    assert.deepEqual(state.accountModels["acct:work"], []);
    assert.deepEqual(state.accountModels["default"], [SPARK], "the default login's own list is untouched");
    const shown = modelsShown(state, { accountId: "work" });
    assert.deepEqual(shown.models, [SPARK]);
    assert.equal(shown.fallback, true);
    stop();
  });

  it("never asks an account that has no login, until it has one", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    client.accounts = [{ id: "work", name: "Work", hasLogin: false, email: null, lastUsedAt: null }];
    const { controller, stop } = await startedWith(client);
    await controller.loadAccounts();
    await controller.refreshModels({ accountId: "work" });
    await controller.refreshModels({ accountId: "work", force: true });
    assert.ok(!client.modelCalls.some((call) => call.accountId === "work"), "no ask for an account that cannot answer");
    assert.equal(controller.store.get().modelsStatus["acct:work"], undefined);
    client.loginAccountResult = { url: "https://auth.meta.com/?code=C", code: "C", loginId: "attempt" };
    client.accountLoginProgress = async () => ({ status: "done" });
    const account = client.accounts[0];
    assert.ok(account);
    account.hasLogin = true;
    await controller.beginLogin("work");
    await controller.checkLogin();
    await settle();
    assert.deepEqual(client.modelCalls.at(-1), { sessionId: undefined, accountId: "work" }, "a finished sign-in reads the account's list");
    assert.equal(controller.store.get().modelsStatus["acct:work"]?.status, "ready");
    controller.cancelLogin();
    stop();
  });

  it("reads the project's account list on the home screen too, since its composer is the new-thread one", async () => {
    const client = new FakeClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.modelQueue = [[SPARK], [SPARK, WONDER]];
    const { controller, stop, toasts } = await startedWith(client);
    assert.deepEqual(controller.store.get().route, { kind: "home" });
    assert.deepEqual(controller.modelsScope(), { accountId: "work" });
    assert.deepEqual(client.modelCalls, [
      { sessionId: undefined, accountId: undefined },
      { sessionId: undefined, accountId: "work" },
    ]);
    assert.deepEqual(controller.store.get().accountModels["acct:work"], [SPARK, WONDER]);
    // A model only the account lists is a pick from its list, not a model Muse did not list.
    assert.equal(await controller.setModel("muse-wonder-1.0"), true);
    assert.ok(!toasts.some((t) => /did not list/.test(t.title)));
    // Part of its name finds it there, instead of being saved as it was typed.
    controller.clearModelPref();
    assert.equal(await controller.send("/model wonder"), true);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.equal(client.modelCalls.length, 2, "no read for a list that already had it");
    // A last project that is no project's falls to the default login, as a thread started there would.
    controller.setPrefs({ lastProject: "/gone" });
    assert.deepEqual(controller.modelsScope(), { accountId: null });
    stop();
  });

  it("reads a stale list when the new-thread screen or Settings opens, and when threads are refreshed by hand", async () => {
    const client = new FakeClient();
    client.modelQueue = [new Error("offline")];
    client.models = [SPARK];
    const { controller, stop, held } = await startedWith(client, "#/t/s1");
    assert.equal(client.modelCalls.length, 2, "the failed boot read, and the open thread's");
    assert.equal(controller.store.get().modelsStatus["default"]?.status, "error");
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await settle();
    assert.equal(client.modelCalls.length, 2, "a list that failed a moment ago is not asked for again by moving around");
    held.clock.now += 61_000;
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await settle();
    assert.equal(client.modelCalls.length, 3, "the new-thread screen reads the list that failed, once a minute has passed");
    assert.equal(controller.store.get().modelsStatus["default"]?.status, "ready");
    held.clock.now += 11 * 60_000;
    controller.navigate({ kind: "settings" });
    await settle();
    assert.equal(client.modelCalls.length, 4, "Settings reads a list that went stale");
    held.clock.now += 11 * 60_000;
    await controller.discoverAll(true);
    await settle();
    assert.equal(client.modelCalls.length, 4, "the quiet refresh at boot leaves the lists be");
    await controller.discoverAll();
    await settle();
    assert.equal(client.modelCalls.length, 5, "refreshing threads by hand looks at the models again");
    stop();
  });

  it("does not ask for a read-only thread's own list, which cannot switch models", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    client.transcript = async () => load({ readOnly: true, readOnlyReason: "Another Muse session has it open." });
    const { controller, stop } = await startedWith(client, "#/t/s1");
    assert.equal(controller.store.get().threads["s1"]?.readOnly, true);
    assert.deepEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }]);
    assert.equal(controller.store.get().modelsStatus["thread:s1"], undefined);
    stop();
  });

  it("reads the lists in use again when a host restarts, and marks the others old", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop } = await startedWith(client, "#/t/s1");
    await controller.refreshModels({ accountId: "work" });
    assert.equal(client.modelCalls.length, 3);
    client.handler?.({ type: "host", key: "k", state: "restarted", message: "The Muse host restarted." });
    await settle();
    assert.equal(client.modelCalls.length, 5, "the default login's list and the open thread's");
    assert.deepEqual(client.modelCalls.slice(3).map((call) => call.sessionId), [undefined, "s1"]);
    const work = controller.store.get().modelsStatus["acct:work"];
    assert.equal(work?.status, "idle", "another account's list waits until it is wanted");
    assert.deepEqual(controller.store.get().accountModels["acct:work"], [SPARK], "and is kept meanwhile");
    client.handler?.({ type: "host", key: "k", state: "failed", message: "boom" });
    await settle();
    assert.equal(client.modelCalls.length, 5, "a host that could not start has no list to read");
    stop();
  });

  it("reads once for a restart that reports once per host, and again for the next restart", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop } = await startedWith(client);
    const before = client.modelCalls.length;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.modelQueue = [
      async () => {
        await gate;
        return [SPARK, WONDER];
      },
    ];
    client.handler?.({ type: "host", key: "default", state: "restarted", message: "The Muse host restarted." });
    client.handler?.({ type: "host", key: "work", state: "restarted", message: "The Muse host restarted." });
    assert.equal(await controller.restartMuse(), true);
    release();
    await settle();
    assert.equal(client.modelCalls.length, before + 1, "the read under way is the one that sees the new hosts");
    assert.deepEqual(controller.store.get().models, [SPARK, WONDER]);
    client.handler?.({ type: "host", key: "default", state: "restarted", message: "The Muse host restarted." });
    await settle();
    assert.equal(client.modelCalls.length, before + 2, "a finished read does not stand in for the next restart's");
    stop();
  });

  it("asks nothing of a host that exited, and reads again only when a list is wanted", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop } = await startedWith(client, "#/t/s1");
    assert.equal(client.modelCalls.length, 2);
    // A host that dies as it starts would be started again by each read: an exit must not cause one.
    for (let i = 0; i < 3; i += 1) {
      client.handler?.({ type: "host", key: "k", state: "exited", message: "The Muse host exited." });
      await settle();
    }
    assert.equal(client.modelCalls.length, 2, "no read, however often the host exits");
    for (const key of ["default", "thread:s1"]) {
      assert.equal(controller.store.get().modelsStatus[key]?.status, "idle", `${key} is marked old`);
      assert.deepEqual(controller.store.get().accountModels[key], [SPARK], `${key} keeps showing what it had`);
    }
    controller.setPicker("model");
    await settle();
    assert.equal(client.modelCalls.length, 3, "opening the picker reads the open thread's list");
    assert.equal(client.modelCalls.at(-1)?.sessionId, "s1");
    assert.equal(controller.store.get().modelsStatus["thread:s1"]?.status, "ready");
    stop();
  });

  it("restarts Muse and reads the list again, but not while a turn runs", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop, toasts } = await startedWith(client);
    assert.equal(await controller.restartMuse(), true);
    await settle();
    assert.equal(client.restarts, 1);
    assert.equal(client.modelCalls.length, 2, "the list is read from the host that starts next");
    client.restartError = new AncillaError("A turn is still open.", 409);
    assert.equal(await controller.restartMuse(), false);
    assert.equal(toasts.at(-1)?.title, "Could not restart Muse");
    assert.equal(toasts.at(-1)?.detail, "A turn is still open.");
    assert.equal(controller.store.get().busy["models:restart"], undefined);
    stop();
  });

  it("does not ask the server to restart Muse while it can see a turn running", async () => {
    const client = new FakeClient();
    const running: SessionSummary = {
      ...SESSION,
      live: { activeTurnId: "t1", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null },
    };
    client.listSessions = async () => [running];
    const { controller, stop, toasts } = await startedWith(client);
    assert.equal(await controller.restartMuse(), false);
    assert.equal(client.restarts, 0);
    assert.equal(toasts.at(-1)?.title, "Work is still running");
    stop();
  });
});

describe("a model list that is only Muse's built-in one", () => {
  it("is asked for again on the schedule, until the plan's own list arrives", async () => {
    const client = new FakeClient();
    client.modelQueue = [
      { models: [SPARK], source: "bundledCatalog" },
      { models: [SPARK], source: "bundledCatalog" },
      { models: [SPARK, WONDER], source: "providerCatalog" },
    ];
    const { controller, stop, held } = await startedWith(client);
    assert.equal(controller.store.get().modelsStatus["default"]?.catalog?.source, "bundledCatalog");
    assert.deepEqual(held.waiting(), [2_000]);
    held.fire(2_000);
    await settle();
    assert.equal(controller.store.get().modelsStatus["default"]?.catalog?.source, "bundledCatalog");
    assert.deepEqual(held.waiting(), [10_000]);
    held.fire(10_000);
    await settle();
    assert.equal(controller.store.get().modelsStatus["default"]?.catalog?.source, "providerCatalog");
    assert.deepEqual(controller.store.get().models, [SPARK, WONDER]);
    assert.deepEqual(held.waiting(), [], "the plan's list ends the asking");
    assert.equal(client.modelCalls.length, 3);
    stop();
  });

  it("is asked for three more times at most", async () => {
    const client = new FakeClient();
    client.modelSource = "bundledCatalog";
    client.models = [SPARK];
    const { controller, stop, held } = await startedWith(client);
    for (const wait of [2_000, 10_000, 30_000]) {
      assert.deepEqual(held.waiting(), [wait]);
      held.fire(wait);
      await settle();
    }
    assert.deepEqual(held.waiting(), []);
    assert.equal(client.modelCalls.length, 4);
    assert.equal(controller.store.get().modelsStatus["default"]?.status, "ready");
    stop();
  });

  it("is never fresh enough to leave be when the picker opens", async () => {
    const client = new FakeClient();
    client.modelSource = "bundledCatalog";
    client.models = [SPARK];
    const { controller, stop } = await startedWith(client);
    assert.equal(client.modelCalls.length, 1);
    controller.setPicker("model");
    await settle();
    assert.equal(client.modelCalls.length, 2);
    stop();
  });

  it("starts the asking over when a host restarts, and lets the older chain end", async () => {
    const client = new FakeClient();
    client.modelSource = "bundledCatalog";
    client.models = [SPARK];
    const { controller, stop, held } = await startedWith(client);
    client.handler?.({ type: "host", key: "k", state: "restarted", message: "The Muse host restarted." });
    await settle();
    assert.equal(client.modelCalls.length, 2);
    assert.deepEqual(held.waiting(), [2_000, 2_000], "the old chain's timer and the new one's");
    held.fire(2_000);
    await settle();
    assert.equal(client.modelCalls.length, 3, "only the newer chain asks");
    assert.equal(controller.store.get().modelsStatus["default"]?.status, "ready");
    stop();
  });

  it("stops asking when the host it was waiting on exits", async () => {
    const client = new FakeClient();
    client.modelSource = "bundledCatalog";
    client.models = [SPARK];
    const { controller, stop, held } = await startedWith(client);
    assert.deepEqual(held.waiting(), [2_000]);
    client.handler?.({ type: "host", key: "k", state: "exited", message: "The Muse host exited." });
    await settle();
    held.fire(2_000);
    await settle();
    assert.equal(client.modelCalls.length, 1, "a host that went away is not started again to be asked");
    assert.deepEqual(held.waiting(), []);
    assert.equal(controller.store.get().modelsStatus["default"]?.status, "idle");
    stop();
  });

  it("keeps asking after a sign-in until the account's own list arrives", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    client.accounts = [{ id: "work", name: "Work", hasLogin: false, email: null, lastUsedAt: null }];
    const { controller, stop, held } = await startedWith(client);
    await controller.loadAccounts();
    client.loginAccountResult = { url: "https://auth.meta.com/?code=C", code: "C", loginId: "attempt" };
    client.accountLoginProgress = async () => ({ status: "done" });
    const account = client.accounts[0];
    assert.ok(account);
    account.hasLogin = true;
    client.modelQueue = [{ models: [SPARK], source: "bundledCatalog" }];
    await controller.beginLogin("work");
    await controller.checkLogin();
    await settle();
    assert.deepEqual(client.modelCalls.at(-1), { sessionId: undefined, accountId: "work" });
    assert.equal(controller.store.get().modelsStatus["acct:work"]?.catalog?.source, "bundledCatalog");
    assert.deepEqual(held.waiting(), [2_000], "Muse answers with its built-in list for a moment after a sign-in");
    client.modelQueue = [{ models: [SPARK, WONDER], source: "providerCatalog" }];
    held.fire(2_000);
    await settle();
    assert.deepEqual(controller.store.get().accountModels["acct:work"], [SPARK, WONDER]);
    assert.deepEqual(held.waiting(), []);
    controller.cancelLogin();
    stop();
  });
});

describe("choosing a model", () => {
  it("leaves the default alone when Muse refuses the switch, and writes it once Muse takes it", async () => {
    const client = new FakeClient();
    client.models = [SPARK, WONDER];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    controller.setPrefs({ defaultModelId: "muse-spark-1.3" });
    const before = controller.store.get().threads["s1"]?.fold.meta.modelId;
    assert.ok(before);
    client.setModelError = new Error("Your plan does not include this model");
    assert.equal(await controller.setModel("muse-wonder-1.0"), false);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-spark-1.3", "the refused model is not what new threads start on");
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.modelId, before, "the thread is put back");
    assert.deepEqual(toasts.filter((t) => t.title === "Could not switch models"), [{ title: "Could not switch models", detail: "Your plan does not include this model" }]);
    assert.equal(await controller.setModel("muse-wonder-1.0"), true);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.modelId, "muse-wonder-1.0");
    assert.deepEqual(client.modelSwitches.map((s) => s.modelId), ["muse-wonder-1.0", "muse-wonder-1.0"]);
    stop();
  });

  it("shows the Contributor notice once, after the switch has taken, and leaves it unspent when the switch is refused", async () => {
    const client = new FakeClient();
    client.models = [SPARK, SPARK_CONTRIBUTOR];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    const notices = () => toasts.filter((t) => t.title === "Contributor model selected").length;
    client.setModelError = new Error("no");
    assert.equal(await controller.setModel("muse-spark-1.3-contributor"), false);
    assert.equal(notices(), 0, "a refused switch said nothing about a model the thread never moved to");
    assert.equal(controller.store.get().prefs.contributorAck, false, "and spent nothing");
    assert.equal(await controller.setModel("muse-spark-1.3-contributor"), true);
    assert.equal(notices(), 1);
    assert.equal(controller.store.get().prefs.contributorAck, true);
    await controller.setModel("muse-spark-1.3-contributor");
    assert.equal(notices(), 1);
    stop();
  });

  it("sets Muse default without switching the thread, and says once when that is a Contributor model", async () => {
    const client = new FakeClient();
    client.models = [SPARK_CONTRIBUTOR, SPARK];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    controller.setPrefs({ defaultModelId: "muse-spark-1.3" });
    controller.clearModelPref();
    assert.equal(controller.store.get().prefs.defaultModelId, null);
    assert.deepEqual(client.modelSwitches, [], "no model is switched");
    const notice = toasts.find((t) => t.title.startsWith("Muse's default is"));
    assert.equal(notice?.title, "Muse's default is muse-spark-1.3, a Contributor model");
    assert.match(notice?.detail ?? "", /product improvement/);
    assert.equal(controller.store.get().prefs.contributorAck, true);
    controller.clearModelPref();
    assert.equal(toasts.filter((t) => t.title.startsWith("Muse's default is")).length, 1, "said once");
    assert.ok(!toasts.some((t) => t.title === "New threads will use Muse's default"), "new threads already follow Muse: nothing changed, nothing said");
    // Once a model is saved again, choosing Muse default on the thread says that only new threads follow it.
    controller.setPrefs({ defaultModelId: "muse-spark-1.3" });
    controller.clearModelPref();
    assert.deepEqual(toasts.filter((t) => t.title === "New threads will use Muse's default"), [
      { title: "New threads will use Muse's default", detail: "This thread stays on muse-spark-1.3." },
    ]);
    assert.equal(toasts.filter((t) => t.title.startsWith("Muse's default is")).length, 1, "the Contributor notice stays once");
    stop();
  });

  it("lets only the latest of two overlapping switches put the thread back or write the default", async () => {
    const client = new FakeClient();
    client.models = [SPARK, SPARK_12, WONDER];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    const modelOf = () => controller.store.get().threads["s1"]?.fold.meta.modelId;
    // The first switch is held while a second is made and taken; then Muse refuses the first.
    let refuse!: (error: Error) => void;
    client.modelGates = [
      new Promise<void>((_, reject) => {
        refuse = reject;
      }),
    ];
    const first = controller.setModel("muse-wonder-1.0");
    assert.equal(await controller.setModel("muse-spark-1.2"), true);
    refuse(new Error("Your plan does not include this model"));
    assert.equal(await first, false);
    assert.equal(modelOf(), "muse-spark-1.2", "the older refusal does not put the thread back on the model before it");
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-spark-1.2");
    assert.ok(toasts.some((t) => t.title === "Could not switch models"), "the refusal is still told");
    // The other way round: the first goes through after Muse refused the second, and only the newest writes the default.
    controller.setPrefs({ defaultModelId: null });
    let accept!: () => void;
    client.modelGates = [
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
    ];
    const older = controller.setModel("muse-wonder-1.0");
    client.setModelError = new Error("no");
    assert.equal(await controller.setModel("muse-spark-1.3"), false);
    accept();
    assert.equal(await older, true);
    assert.equal(modelOf(), "muse-wonder-1.0", "the thread is on the model Muse took last");
    assert.equal(controller.store.get().prefs.defaultModelId, null, "an older switch does not write the default over a newer one");
    stop();
  });

  it("takes a model id on trust while Muse's list is empty, since an empty list says nothing about it", async () => {
    const client = new FakeClient();
    client.models = [];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    assert.equal(await controller.setModel("muse-wonder-1.0"), true);
    assert.deepEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-wonder-1.0" }]);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0", "it is a pick, not a try");
    assert.ok(!toasts.some((t) => /did not list/.test(t.title)));
    stop();
  });

  it("judges a saved model by the list of the account the thread will run on, not the default login's", async () => {
    const client = new FakeClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.modelQueue = [[SPARK, WONDER], [SPARK]];
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "muse-wonder-1.0" });
    assert.equal(await controller.send("hello"), true);
    assert.equal(client.startCalls.at(-1)?.accountId, "work");
    assert.equal(client.startCalls.at(-1)?.modelId, undefined, "the default login offers it, the account does not");
    assert.deepEqual(
      toasts.filter((t) => /not offered on this account/.test(t.title)).map((t) => t.title),
      ["muse-wonder-1.0 is not offered on this account; using Muse's default"],
    );
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    stop();
  });

  it("starts a new thread on Muse's default, saying so once, when the account's list lacks the saved model", async () => {
    const client = new FakeClient();
    client.models = [SPARK, WONDER];
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "retired-x" });
    assert.equal(await controller.send("hello"), true);
    assert.equal(client.startCalls.at(-1)?.modelId, undefined);
    assert.equal(controller.store.get().prefs.defaultModelId, "retired-x", "the saved choice is kept: it may be right for another account");
    const notes = () => toasts.filter((t) => /not offered on this account/.test(t.title));
    assert.deepEqual(notes().map((t) => t.title), ["retired-x is not offered on this account; using Muse's default"]);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    assert.equal(await controller.send("again"), true);
    assert.equal(client.startCalls.at(-1)?.modelId, undefined);
    assert.equal(notes().length, 1, "the note is not repeated for every thread");
    stop();
  });

  it("starts on the saved model when the list offers it", async () => {
    const client = new FakeClient();
    client.models = [SPARK, WONDER];
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "muse-wonder-1.0" });
    await controller.send("hello");
    assert.equal(client.startCalls.at(-1)?.modelId, "muse-wonder-1.0");
    assert.ok(!toasts.some((t) => /not offered/.test(t.title)));
    stop();
  });

  it("leaves a saved model alone when the list is only Muse's built-in one, or still unread", async () => {
    const client = new FakeClient();
    client.modelSource = "bundledCatalog";
    client.models = [SPARK];
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "muse-wonder-1.0" });
    await controller.send("hello");
    assert.equal(client.startCalls.at(-1)?.modelId, "muse-wonder-1.0", "a built-in list proves nothing about the plan");
    assert.ok(!toasts.some((t) => /not offered/.test(t.title)));
    stop();
    const unread = new FakeClient();
    unread.modelQueue = [new Error("offline")];
    const second = await startedWith(unread, NEW_THREAD);
    second.controller.setPrefs({ defaultModelId: "muse-wonder-1.0" });
    await second.controller.send("hello");
    assert.equal(unread.startCalls.at(-1)?.modelId, "muse-wonder-1.0", "no list, no verdict");
    second.stop();
  });

  it("lets an id tried by hand through a plan list that does not offer it", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    assert.equal(await controller.setModel("muse-wonder-1.0"), true);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.deepEqual(client.modelSwitches, [], "there is no thread to switch");
    assert.deepEqual(toasts.filter((t) => /did not list/.test(t.title)), [
      { title: "Using muse-wonder-1.0, which your Muse did not list", detail: "Muse checks access when you send a prompt." },
    ]);
    await controller.send("hello");
    assert.equal(client.startCalls.at(-1)?.modelId, "muse-wonder-1.0", "the pin check leaves a model the user asked for by id");
    stop();
  });

  it("refuses text that is not shaped like a model id", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    assert.equal(await controller.setModel("not a model!"), false);
    assert.equal(controller.store.get().prefs.defaultModelId, null);
    assert.equal(toasts.at(-1)?.title, "That is not a model id");
    assert.equal(toasts.at(-1)?.detail, modelIdError("not a model!"), "the toast and the field say the same thing");
    assert.match(toasts.at(-1)?.detail ?? "", /starts with a letter or digit/);
    stop();
  });

  it("notes once that Muse's default is a Contributor model when nothing is saved", async () => {
    const client = new FakeClient();
    client.models = [SPARK_CONTRIBUTOR, SPARK];
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    await controller.send("hello");
    assert.equal(client.startCalls.at(-1)?.modelId, undefined);
    assert.equal(toasts.filter((t) => t.title.startsWith("Muse's default is")).length, 1);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await controller.send("again");
    assert.equal(toasts.filter((t) => t.title.startsWith("Muse's default is")).length, 1);
    stop();
  });
});

describe("/model", () => {
  it("picks the regular model over its Contributor twin, and finds a model by part of its name", async () => {
    const client = new FakeClient();
    client.models = [SPARK_CONTRIBUTOR, SPARK, WONDER];
    const { controller, stop } = await startedWith(client, "#/t/s1");
    assert.equal(await controller.send("/model muse-spark-1.3"), true);
    assert.equal(client.modelSwitches.at(-1)?.modelId, "muse-spark-1.3");
    assert.equal(await controller.send("/model muse-spark-1.3-contributor"), true);
    assert.equal(client.modelSwitches.at(-1)?.modelId, "muse-spark-1.3-contributor");
    assert.equal(await controller.send("/model wonder"), true);
    assert.equal(client.modelSwitches.at(-1)?.modelId, "muse-wonder-1.0");
    assert.equal(await controller.send("/model muse wonder 1.0"), true);
    assert.equal(client.modelSwitches.at(-1)?.modelId, "muse-wonder-1.0");
    stop();
  });

  it("reads the list again once on a miss and then finds the model", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    const asked = client.modelCalls.length;
    client.modelQueue = [[SPARK, WONDER]];
    assert.equal(await controller.send("/model muse-wonder-1.0"), true);
    assert.equal(client.modelCalls.length, asked + 1, "one more ask, for the open thread");
    assert.equal(client.modelCalls.at(-1)?.sessionId, "s1");
    assert.deepEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-wonder-1.0" }]);
    assert.ok(!toasts.some((t) => /No model named/.test(t.title)));
    assert.ok(!toasts.some((t) => /did not list/.test(t.title)), "it is a listed model by then");
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    stop();
  });

  it("tries a model still missing from the list on the open thread alone", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    assert.equal(await controller.send("/model muse-wonder-2.0"), true);
    assert.deepEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-wonder-2.0" }], "the bare id goes to Muse");
    assert.equal(controller.store.get().prefs.defaultModelId, null, "new threads do not follow it");
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.modelId, "muse-wonder-2.0");
    assert.ok(toasts.some((t) => t.title === "Using muse-wonder-2.0, which your Muse did not list"));
    stop();
  });

  it("rolls a refused try back and keeps it out of the defaults", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    const before = controller.store.get().threads["s1"]?.fold.meta.modelId;
    client.setModelError = new Error("Muse does not serve that model");
    assert.equal(await controller.send("/model muse-wonder-2.0"), false);
    assert.equal(controller.store.get().threads["s1"]?.fold.meta.modelId, before);
    assert.equal(controller.store.get().prefs.defaultModelId, null);
    assert.deepEqual(toasts.at(-1), { title: "Could not switch models", detail: "Muse does not serve that model" });
    stop();
  });

  it("sets the default on the new-thread screen for a model still missing, without switching anything", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    assert.equal(await controller.send("/model muse-wonder-2.0"), true);
    assert.deepEqual(client.modelSwitches, []);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-2.0");
    assert.ok(toasts.some((t) => /did not list/.test(t.title)));
    stop();
  });

  it("says no model is named that when the text cannot be an id", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    assert.equal(await controller.send("/model not a model"), false);
    assert.deepEqual(client.modelSwitches, []);
    assert.equal(toasts.at(-1)?.title, "No model named not a model");
    stop();
  });

  it("opens the picker when the name fits models of different families", async () => {
    const client = new FakeClient();
    client.models = [WONDER, WONDER_FULL];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    assert.equal(await controller.send("/model wonder"), true);
    assert.equal(controller.store.get().picker, "model");
    assert.deepEqual(client.modelSwitches, [], "nothing is guessed");
    assert.ok(toasts.some((t) => t.title === "More than one model fits wonder"));
    stop();
  });
});

describe("reasoning effort and the model", () => {
  it("keeps the level asked for and runs turns at what the model offers", async () => {
    const client = new FakeClient();
    client.models = [SPARK, SPARK_12, model("muse-plain")];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    const effortToasts = () => toasts.filter((t) => / is not available on /.test(t.title));
    controller.setEffort("max");
    assert.equal(effortToasts().length, 0, "the open thread's model has Max");
    assert.deepEqual(client.efforts, ["s1:max"]);
    await controller.setModel("muse-spark-1.2");
    assert.equal(controller.store.get().prefs.effort, "max", "the saved level is never rewritten");
    assert.deepEqual(effortToasts(), [
      { title: "Max is not available on muse-spark-1.2", detail: "Using Extra high. Your choice is kept for other models." },
    ]);
    await controller.send("go");
    assert.equal(client.turnEfforts.at(-1), "xhigh");
    await controller.setModel("muse-spark-1.3");
    await controller.send("again");
    assert.equal(client.turnEfforts.at(-1), "max", "another model gives the wish back");
    await controller.setModel("muse-plain");
    await controller.send("and again");
    assert.equal(client.turnEfforts.at(-1), "max", "a model that lists no levels takes any");
    assert.equal(effortToasts().length, 1);
    stop();
  });

  it("says a level does not fit once for each time the model is chosen, not for every turn", async () => {
    const client = new FakeClient();
    client.models = [SPARK, SPARK_12];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    controller.setEffort("max");
    const notes = () => toasts.filter((t) => t.title === "Max is not available on muse-spark-1.2");
    await controller.setModel("muse-spark-1.2");
    assert.equal(notes().length, 1);
    await controller.send("go");
    assert.equal(notes().length, 1, "a turn on the model says nothing more");
    await controller.setModel("muse-spark-1.3");
    assert.equal(notes().length, 1);
    await controller.setModel("muse-spark-1.2");
    assert.equal(notes().length, 2, "back on it, the level it lacks is worth saying again");
    stop();
  });

  it("does not hold turns to the levels of Muse's built-in list, which can list fewer than the plan's", async () => {
    const client = new FakeClient();
    client.modelSource = "bundledCatalog";
    // Muse 1.4.7's built-in row for this model: no Max, though the plan's own list has it.
    client.models = [model("muse-spark-1.3", { efforts: ["minimal", "low", "medium", "high", "xhigh"] })];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    controller.setEffort("max");
    assert.deepEqual(client.efforts, ["s1:max"], "the thread is told the level that was asked for");
    await controller.send("go");
    assert.equal(client.turnEfforts.at(-1), "max");
    controller.setEffort("none");
    assert.equal(client.efforts.at(-1), "s1:none");
    await controller.setModel("muse-spark-1.3");
    await controller.send("again");
    assert.equal(client.turnEfforts.at(-1), "none");
    assert.ok(!toasts.some((t) => / is not available on /.test(t.title)));
    assert.equal(controller.store.get().prefs.effort, "none");
    // The new-thread screen reads the same way.
    controller.navigate({ kind: "new", cwd: "/work/app" });
    controller.setPrefs({ defaultModelId: "muse-spark-1.3" });
    controller.setEffort("max");
    assert.ok(!toasts.some((t) => / is not available on /.test(t.title)));
    // The same row from the plan's own list is believed.
    client.modelSource = "providerCatalog";
    controller.navigate({ kind: "thread", sessionId: "s1" });
    await controller.refreshModels({ sessionId: "s1", force: true });
    controller.setEffort("max");
    assert.equal(client.efforts.at(-1), "s1:xhigh");
    assert.ok(toasts.some((t) => t.title === "Max is not available on muse-spark-1.3"));
    stop();
  });

  it("clamps /effort to the model, once, and keeps what was typed", async () => {
    const client = new FakeClient();
    client.models = [SPARK, SPARK_12];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    await controller.setModel("muse-spark-1.2");
    assert.equal(await controller.send("/effort max"), true);
    assert.equal(controller.store.get().prefs.effort, "max");
    assert.equal(client.efforts.at(-1), "s1:xhigh", "the thread is told what its model can run");
    assert.equal(toasts.filter((t) => t.title === "Max is not available on muse-spark-1.2").length, 1);
    assert.equal(await controller.send("/effort max"), true);
    assert.equal(toasts.filter((t) => t.title === "Max is not available on muse-spark-1.2").length, 1, "said once");
    assert.equal(await controller.send("/effort off"), true);
    assert.equal(controller.store.get().prefs.effort, "none");
    assert.equal(client.efforts.at(-1), "s1:minimal", "a model without Off starts at its lowest");
    assert.ok(toasts.some((t) => t.title === "Off is not available on muse-spark-1.2" && t.detail === "Using Minimal. Your choice is kept for other models."));
    stop();
  });

  it("leaves the level alone on a model that lists none, and with Auto", async () => {
    const client = new FakeClient();
    client.models = [model("muse-plain")];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    await controller.setModel("muse-plain");
    controller.setEffort("max");
    await controller.send("go");
    assert.equal(client.turnEfforts.at(-1), "max");
    controller.setEffort(null);
    await controller.send("again");
    assert.equal(client.turnEfforts.at(-1), undefined, "Auto sends no level");
    assert.ok(!toasts.some((t) => / is not available on /.test(t.title)));
    stop();
  });

  it("clamps on the new-thread screen against the model new threads start on", async () => {
    const client = new FakeClient();
    client.models = [SPARK_12];
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "muse-spark-1.2" });
    controller.setEffort("max");
    assert.equal(controller.store.get().prefs.effort, "max");
    assert.deepEqual(client.efforts, [], "there is no thread to tell");
    assert.ok(toasts.some((t) => t.title === "Max is not available on muse-spark-1.2"));
    stop();
  });
});

describe("a thread whose model Muse cannot serve", () => {
  it("tells the user to pick one the plan offers, and opens the picker on that thread", async () => {
    const client = new FakeClient();
    client.models = [SPARK];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    const asked = client.modelCalls.length;
    const params = { commandId: "c1", installedProviderId: "other", modelId: "muse-wonder-1.0", sessionId: "s1" };
    const event: AncillaEvent = { type: "msp", sessionId: "s1", method: "session/modelRouteUnserved", params, at: 1 };
    client.handler?.(event);
    await settle();
    const notes = () => toasts.filter((t) => t.title === "Pick a model your plan offers");
    assert.equal(notes().length, 1);
    assert.match(notes()[0]?.detail ?? "", /muse-wonder-1\.0/);
    assert.equal(controller.store.get().picker, "model");
    assert.deepEqual(client.modelCalls.at(-1), { sessionId: "s1", accountId: undefined });
    assert.equal(client.modelCalls.length, asked + 1, "the thread's list is read again, once");
    client.handler?.(event);
    await settle();
    assert.equal(notes().length, 1, "the same command is not announced twice");
    controller.setPicker(null);
    client.handler?.({ ...event, sessionId: "elsewhere", params: { ...params, commandId: "c2", sessionId: "elsewhere" } });
    await settle();
    assert.equal(notes().length, 2);
    assert.equal(controller.store.get().picker, null, "another thread's picker is not the one on screen");
    stop();
  });
});

// ---------------------------------------------------------------- the picker's client logic, after the merged-tree review

const WORK: import("../src/types.js").AccountView = { id: "work", name: "Work", hasLogin: true, email: null, lastUsedAt: null };

/** A held platform whose saved prefs a second controller can start from, as the next launch of the app does. */
function persistedPlatform(store: { saved: unknown }, hash = "") {
  const held = heldPlatform(hash);
  held.loadPrefs = () => store.saved;
  held.savePrefs = (prefs) => {
    store.saved = JSON.parse(JSON.stringify(prefs));
  };
  return held;
}

/** `startedWith` on a platform the test made, recording every toast. */
async function startedOn(client: FakeClient, held: ReturnType<typeof heldPlatform>) {
  const controller = new AncillaController(client, held);
  const toasts: { title: string; detail?: string }[] = [];
  const seen = new Set<number>();
  controller.store.subscribe(() => {
    for (const toast of controller.store.get().toasts) {
      if (!seen.has(toast.id)) {
        seen.add(toast.id);
        toasts.push({ title: toast.title, detail: toast.detail });
      }
    }
  });
  const stop = controller.start();
  await settle();
  await settle();
  return { controller, stop, held, toasts };
}

describe("/model with a name that is not an id", () => {
  async function onBuiltIn(hash: string) {
    const client = new FakeClient();
    client.models = LIVE_1_4_7.models;
    client.modelSource = "bundledCatalog";
    return { client, ...(await startedWith(client, hash)) };
  }

  it("finds Wonder among the models Meta publishes while the list is Muse's built-in one, and tries that, never the word", async () => {
    const { client, controller, stop, toasts } = await onBuiltIn(NEW_THREAD);
    assert.equal(controller.store.get().modelsStatus["default"]?.catalog?.source, "bundledCatalog");
    assert.equal(await controller.send("/model wonder"), true);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.equal(controller.store.get().prefs.defaultModelTried, true, "a published id the list lacks is only tried");
    assert.deepEqual(toasts.filter((t) => /did not list/.test(t.title)).map((t) => t.title), ["Using muse-wonder-1.0, which your Muse did not list"]);
    await controller.send("hello");
    assert.equal(client.startCalls.at(-1)?.modelId, "muse-wonder-1.0");
    stop();
  });

  it("tries it on the open thread alone, whatever case it is typed in, and finds another published model by its version", async () => {
    const { client, controller, stop } = await onBuiltIn("#/t/s1");
    assert.equal(await controller.send("/model WONDER"), true);
    assert.deepEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-wonder-1.0" }]);
    assert.equal(await controller.send("/model MUSE-WONDER-1.0"), true);
    assert.deepEqual(client.modelSwitches.at(-1), { sessionId: "s1", modelId: "muse-wonder-1.0" }, "an id typed in capitals is sent in its own spelling");
    assert.equal(await controller.send("/model 1.2"), true);
    assert.deepEqual(client.modelSwitches.at(-1), { sessionId: "s1", modelId: "muse-spark-1.2" });
    assert.equal(controller.store.get().prefs.defaultModelId, null, "new threads do not follow a try");
    assert.ok(!client.modelSwitches.some((s) => s.modelId === "wonder"));
    stop();
  });

  it("prefers the list's own row to a published one for the same family", async () => {
    const { client, controller, stop } = await onBuiltIn("#/t/s1");
    assert.equal(await controller.send("/model spark"), true);
    assert.deepEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-spark-1.3" }]);
    stop();
  });

  it("opens the picker when published models of different families answer, and changes nothing", async () => {
    const client = new FakeClient();
    client.models = [model("vendor-x-1")];
    client.modelSource = "bundledCatalog";
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    assert.equal(await controller.send("/model muse"), true);
    assert.equal(controller.store.get().picker, "model");
    assert.deepEqual(client.modelSwitches, []);
    assert.ok(toasts.some((t) => t.title === "More than one model fits muse"));
    stop();
  });

  it("says no model has that name and opens the picker, when a bare word fits nothing on the plan's own list", async () => {
    const client = new FakeClient();
    client.models = LIVE_1_4_0.models;
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    for (const word of ["wonder", "wond", "Wonder"]) {
      controller.setPicker(null);
      assert.equal(await controller.send(`/model ${word}`), false, word);
      assert.equal(controller.store.get().picker, "model", word);
      assert.equal(controller.store.get().prefs.defaultModelId, null, `${word} is not saved as a model`);
      assert.equal(toasts.at(-1)?.title, `No model named ${word}`);
    }
    assert.deepEqual(client.modelSwitches, []);
    stop();
  });

  it("does the same on an open thread: no switch is made to a word", async () => {
    const client = new FakeClient();
    client.models = LIVE_1_4_0.models;
    const { controller, stop } = await startedWith(client, "#/t/s1");
    assert.equal(await controller.send("/model wonder"), false);
    assert.deepEqual(client.modelSwitches, []);
    assert.equal(controller.store.get().picker, "model");
    stop();
  });

  it("still tries what plainly is an id, in its own spelling, though the plan's list does not offer it", async () => {
    const client = new FakeClient();
    client.models = LIVE_1_4_0.models;
    const { controller, stop } = await startedWith(client, NEW_THREAD);
    assert.equal(await controller.send("/model MUSE-WONDER-1.0"), true);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.equal(controller.store.get().prefs.defaultModelTried, true);
    assert.equal(await controller.send("/model muse-wonder-2.0"), true);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-2.0");
    stop();
  });

  it("writes no default from text while the list is empty or failed, unless the text is plainly an id, and then says so", async () => {
    const client = new FakeClient();
    client.modelQueue = [new Error("a"), new Error("b"), new Error("c"), new Error("d"), new Error("e"), new Error("f")];
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    assert.equal(controller.store.get().modelsStatus["default"]?.status, "error");
    for (const word of ["spark", "sparkk"]) {
      assert.equal(await controller.send(`/model ${word}`), false, word);
      assert.equal(controller.store.get().prefs.defaultModelId, null, `${word} is not saved`);
      assert.equal(toasts.at(-1)?.title, `No model named ${word}`);
    }
    assert.equal(await controller.send("/model muse-wonder-2.0"), true);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-2.0");
    assert.equal(controller.store.get().prefs.defaultModelTried, true);
    assert.ok(toasts.some((t) => t.title === "Using muse-wonder-2.0, which your Muse did not list"));
    stop();
  });

  it("tries a plain id on the open thread alone while the list is empty, and writes no default", async () => {
    const client = new FakeClient();
    client.modelQueue = [new Error("a"), new Error("b"), new Error("c"), new Error("d"), new Error("e"), new Error("f")];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    assert.equal(await controller.send("/model sparkk"), false);
    assert.deepEqual(client.modelSwitches, []);
    assert.equal(await controller.send("/model muse-wonder-2.0"), true);
    assert.deepEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-wonder-2.0" }]);
    assert.equal(controller.store.get().prefs.defaultModelId, null, "a try on a thread is that thread's alone");
    assert.ok(toasts.some((t) => /did not list/.test(t.title)));
    stop();
  });
});

describe("a model tried by its id survives a restart", () => {
  it("is passed on at thread start by a controller that starts from the saved prefs", async () => {
    const store = { saved: null as unknown };
    const first = new FakeClient();
    first.models = LIVE_1_4_0.models;
    const a = await startedOn(first, persistedPlatform(store, NEW_THREAD));
    assert.equal(await a.controller.setModel("muse-wonder-1.0"), true);
    assert.equal(a.controller.store.get().prefs.defaultModelTried, true);
    await settle();
    a.stop();
    assert.equal((store.saved as { defaultModelTried?: boolean }).defaultModelTried, true, "the mark is saved with the pin");
    const second = new FakeClient();
    second.models = LIVE_1_4_0.models;
    const b = await startedOn(second, persistedPlatform(store, NEW_THREAD));
    const state = b.controller.store.get();
    assert.equal(state.prefs.defaultModelId, "muse-wonder-1.0");
    assert.equal(state.prefs.defaultModelTried, true);
    const menu = modelMenu(
      { models: state.models, accountModels: state.accountModels, modelsStatus: state.modelsStatus, accounts: state.accounts },
      { scope: {}, accountId: null, current: null, pref: state.prefs.defaultModelId, plan: null, tried: state.prefs.defaultModelTried },
    );
    assert.equal(menu.trigger.text, "muse-wonder-1.0", "the button does not call it unavailable");
    assert.equal(menu.rows.find((row) => row.kind === "pin")?.unlisted, "tried");
    assert.equal(await b.controller.send("hello"), true);
    assert.equal(second.startCalls.at(-1)?.modelId, "muse-wonder-1.0", "the plan's list lacks it, and the thread still starts on it");
    assert.ok(!b.toasts.some((t) => /not offered/.test(t.title)));
    b.stop();
  });

  it("still drops a saved model that was once listed, and is not a try, when the plan's list no longer has it", async () => {
    const store = { saved: { defaultModelId: "muse-spark-1.1", defaultModelTried: false } as unknown };
    const client = new FakeClient();
    client.models = LIVE_1_4_0.models;
    const { controller, stop, toasts } = await startedOn(client, persistedPlatform(store, NEW_THREAD));
    await controller.send("hello");
    assert.equal(client.startCalls.at(-1)?.modelId, undefined);
    assert.ok(toasts.some((t) => /muse-spark-1.1 is not offered on this account/.test(t.title)));
    stop();
  });

  it("ends when a listed model is picked, when Muse default is chosen, and when the pin changes by any other way", async () => {
    const client = new FakeClient();
    client.models = LIVE_1_4_0.models;
    const { controller, stop } = await startedWith(client, NEW_THREAD);
    const tried = () => controller.store.get().prefs.defaultModelTried;
    await controller.setModel("muse-wonder-1.0");
    assert.equal(tried(), true);
    await controller.setModel("muse-spark-1.2");
    assert.equal(tried(), false, "a listed pick");
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-spark-1.2");
    await controller.setModel("muse-wonder-1.0");
    assert.equal(tried(), true);
    controller.clearModelPref();
    assert.equal(tried(), false, "Muse default");
    assert.equal(controller.store.get().prefs.defaultModelId, null);
    await controller.setModel("muse-wonder-1.0");
    controller.setPrefs({ defaultModelId: "muse-spark-1.3" });
    assert.equal(tried(), false, "a pin that changes without saying it was tried is not one");
    stop();
  });

  it("is left alone by a try on a thread, and ended by a listed pick there", async () => {
    const client = new FakeClient();
    client.models = LIVE_1_4_0.models;
    const { controller, stop } = await startedWith(client, NEW_THREAD);
    await controller.setModel("muse-wonder-2.0");
    controller.navigate({ kind: "thread", sessionId: "s1" });
    await settle();
    assert.equal(await controller.setModel("muse-wonder-3.0"), true);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-2.0");
    assert.equal(controller.store.get().prefs.defaultModelTried, true);
    assert.equal(await controller.setModel("muse-spark-1.2"), true);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-spark-1.2");
    assert.equal(controller.store.get().prefs.defaultModelTried, false);
    stop();
  });

  it("is remembered as tried for an id typed into the Other model id field while no list has loaded", async () => {
    const client = new FakeClient();
    client.modelQueue = [new Error("Muse could not start")];
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    assert.deepEqual(controller.store.get().accountModels["default"], [], "the boot read failed: there is no list to vouch for anything");
    assert.equal(await tryTypedModel(controller, "muse-wonder-2.0"), true);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-2.0");
    assert.equal(controller.store.get().prefs.defaultModelTried, true, "typed by hand, so not taken for a listed model");
    assert.deepEqual(
      toasts.filter((t) => /did not list/.test(t.title)).map((t) => t.title),
      ["Using muse-wonder-2.0, which your Muse did not list"],
    );
    // The plan's list comes later and lacks it: the id is still what new threads start on, as the user typed it.
    client.modelQueue = [answer(LIVE_1_4_0)];
    await controller.refreshModels({ force: true });
    assert.equal(controller.store.get().modelsStatus["default"]?.catalog?.source, "providerCatalog");
    assert.equal(await controller.send("hello"), true);
    assert.equal(client.startCalls.at(-1)?.modelId, "muse-wonder-2.0");
    assert.ok(!toasts.some((t) => /not offered/.test(t.title)), "it is not silently swapped for Muse's default");
    stop();
  });

  it("takes the same menu pick on trust while no list has loaded, which is a pick and not a try", async () => {
    const client = new FakeClient();
    client.modelQueue = [new Error("Muse could not start")];
    const { controller, stop } = await startedWith(client, NEW_THREAD);
    assert.equal(await controller.setModel("muse-wonder-1.0"), true);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.equal(controller.store.get().prefs.defaultModelTried, false);
    stop();
  });

  it("keeps an id typed on an open thread to that thread when no list has loaded, never making it the default", async () => {
    const client = new FakeClient();
    client.modelQueue = [new Error("Muse could not start"), new Error("Muse could not start")];
    const { controller, stop } = await startedWith(client, "#/t/s1");
    assert.deepEqual(controller.store.get().accountModels["thread:s1"], []);
    assert.equal(await tryTypedModel(controller, "muse-wonder-typo"), true);
    assert.deepEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-wonder-typo" }]);
    assert.equal(controller.store.get().prefs.defaultModelId, null, "a typo is not what new threads start on");
    assert.equal(controller.store.get().prefs.defaultModelTried, false);
    stop();
  });
});

describe("the model union and the accounts behind it", () => {
  it("keeps the plan's window and levels for a model a built-in list also names, and leads with the plan's list", async () => {
    const client = new FakeClient();
    client.modelQueue = [answer(LIVE_1_4_7)];
    const { controller, stop } = await startedWith(client);
    assert.equal(controller.store.get().models.find((m) => m.modelId === "muse-spark-1.3")?.contextLimit, null);
    client.modelQueue = [answer(LIVE_1_4_0)];
    await controller.refreshModels({ accountId: "work" });
    const { models, accountModels } = controller.store.get();
    const spark = models.find((m) => m.modelId === "muse-spark-1.3");
    assert.equal(spark?.contextLimit, 1007997, "the built-in row has no window; the plan's does");
    assert.ok(spark?.efforts?.includes("max"));
    assert.deepEqual(models.map((m) => m.modelId), accountModels["acct:work"]?.map((m) => m.modelId), "the plan's list leads");
    stop();
  });

  it("lets the plan's row stand for a model both lists name, not the built-in one the default login read first", async () => {
    const client = new FakeClient();
    client.modelQueue = [{ models: [model("same", { description: "built-in row" })], source: "bundledCatalog" }];
    const { controller, stop } = await startedWith(client);
    client.modelQueue = [[model("same", { description: "plan row", contextLimit: 5 })]];
    await controller.refreshModels({ accountId: "work" });
    const row = controller.store.get().models.find((m) => m.modelId === "same");
    assert.equal(row?.description, "plan row");
    assert.equal(row?.contextLimit, 5);
    stop();
  });

  it("lets Settings tell a saved model another account offers from one nobody lists", async () => {
    const client = new FakeClient();
    client.models = LIVE_1_4_0.models;
    const { controller, stop } = await startedWith(client);
    client.modelQueue = [[SPARK, WONDER]];
    await controller.refreshModels({ accountId: "work" });
    const state = controller.store.get();
    const defaults = modelsShown(state, {}).models;
    assert.equal(offeredByAnother(state, defaults, "muse-wonder-1.0"), true);
    assert.equal(offeredByAnother(state, defaults, "retired-x"), false);
    assert.equal(offeredByAnother(state, defaults, "muse-spark-1.3"), false);
    stop();
  });

  it("forgets a removed account's lists, status and pending re-list, and the lists of its threads", async () => {
    const client = new FakeClient();
    client.accounts = [WORK];
    client.listSessions = async () => [{ ...SESSION, accountId: "work" }];
    client.models = [SPARK];
    const { controller, stop, held } = await startedWith(client);
    await controller.loadAccounts();
    client.modelQueue = [{ models: [WONDER], source: "bundledCatalog" }];
    await controller.refreshModels({ accountId: "work", watch: true });
    client.modelQueue = [[WONDER_FULL]];
    await controller.refreshModels({ sessionId: "s1" });
    let state = controller.store.get();
    assert.deepEqual(state.models.map((m) => m.modelId).sort(), ["muse-spark-1.3", "muse-wonder-1.0", "muse-wonder-full-1.0"]);
    assert.deepEqual(held.waiting(), [2_000], "the built-in list is waiting to be asked for again");
    assert.equal(await controller.removeAccount("work"), true);
    state = controller.store.get();
    for (const key of ["acct:work", "thread:s1"]) {
      assert.equal(state.accountModels[key], undefined, key);
      assert.equal(state.modelsStatus[key], undefined, key);
    }
    assert.deepEqual(state.models.map((m) => m.modelId), ["muse-spark-1.3"], "what only that account offered is gone from every lookup");
    // An account of the same id comes back and is read, with Muse's built-in list again, before the old chain's timer fires.
    client.accounts.push(WORK);
    await controller.loadAccounts();
    client.modelQueue = [{ models: [WONDER], source: "bundledCatalog" }];
    await controller.refreshModels({ accountId: "work" });
    assert.equal(controller.store.get().modelsStatus["acct:work"]?.catalog?.source, "bundledCatalog");
    const asked = client.modelCalls.length;
    held.fire(2_000);
    await settle();
    assert.equal(client.modelCalls.length, asked, "the pending re-list of the account that was removed asks nothing, though a list of that name is back");
    stop();
  });

  it("does not show a removed account's list as fresh when an account of the same id comes back", async () => {
    const client = new FakeClient();
    client.accounts = [WORK];
    client.models = [SPARK];
    const { controller, stop } = await startedWith(client);
    await controller.loadAccounts();
    client.modelQueue = [[SPARK, WONDER]];
    await controller.refreshModels({ accountId: "work" });
    assert.equal(controller.store.get().modelsStatus["acct:work"]?.status, "ready");
    await controller.removeAccount("work");
    client.accounts.push(WORK);
    await controller.loadAccounts();
    client.modelQueue = [[SPARK_12]];
    await controller.refreshModels({ accountId: "work" });
    assert.deepEqual(controller.store.get().accountModels["acct:work"]?.map((m) => m.modelId), ["muse-spark-1.2"], "asked afresh, not read from the old one");
    stop();
  });

  it("says a saved model is not offered again to an account that was removed and has come back", async () => {
    const client = new FakeClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.accounts = [WORK];
    client.modelQueue = [[SPARK, WONDER], [SPARK]];
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "muse-wonder-1.0" });
    const notes = () => toasts.filter((t) => /not offered on this account/.test(t.title)).length;
    assert.equal(await controller.send("hello"), true);
    assert.equal(client.startCalls.at(-1)?.accountId, "work");
    assert.equal(notes(), 1, "the new account's list lacks the saved model, and says so");
    controller.navigate({ kind: "new", cwd: "/work/app" });
    assert.equal(await controller.send("again"), true);
    assert.equal(notes(), 1, "once for the account, not for every thread");
    // Another account of the same id: a new login, a new list, and the note is owed to it as to any account.
    assert.equal(await controller.removeAccount("work"), true);
    client.accounts.push(WORK);
    await controller.loadAccounts();
    client.modelQueue = [[SPARK]];
    await controller.setProjectDefaultAccount("/work/app", "work");
    await settle();
    assert.deepEqual(controller.store.get().accountModels["acct:work"], [SPARK]);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    assert.equal(await controller.send("once more"), true);
    assert.equal(client.startCalls.at(-1)?.accountId, "work");
    assert.equal(client.startCalls.at(-1)?.modelId, undefined);
    assert.equal(notes(), 2, "removing the account let go of what was said about it");
    stop();
  });
});

describe("the boot order of the account lists", () => {
  function gated(client: FakeClient) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    client.listAccounts = async () => {
      await gate;
      return [...client.accounts];
    };
    return open;
  }

  it("does not ask an account that has no login for models, before the accounts have loaded or after", async () => {
    const client = new FakeClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.accounts = [{ ...WORK, hasLogin: false }];
    client.models = [SPARK];
    const open = gated(client);
    const { controller, stop } = await startedWith(client, NEW_THREAD);
    assert.equal(controller.store.get().accounts, null, "the accounts are still being read");
    assert.deepEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }], "only the default login was asked");
    open();
    await settle();
    assert.equal(controller.store.get().accounts?.length, 1);
    assert.deepEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }], "and the account that cannot answer still is not");
    assert.equal(controller.store.get().modelsStatus["acct:work"], undefined);
    stop();
  });

  it("asks an account that has a login as soon as the accounts have loaded", async () => {
    const client = new FakeClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.accounts = [WORK];
    client.modelQueue = [[SPARK], [SPARK, WONDER]];
    const open = gated(client);
    const { controller, stop } = await startedWith(client, NEW_THREAD);
    assert.equal(client.modelCalls.length, 1);
    open();
    await settle();
    assert.deepEqual(client.modelCalls.at(-1), { sessionId: undefined, accountId: "work" });
    assert.deepEqual(controller.store.get().accountModels["acct:work"], [SPARK, WONDER]);
    stop();
  });

  it("asks anyway when the accounts could not be read, so the picker is not left waiting", async () => {
    const client = new FakeClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.models = [SPARK];
    client.listAccounts = async () => {
      throw new Error("no accounts route");
    };
    const { controller, stop } = await startedWith(client, NEW_THREAD);
    assert.equal(controller.store.get().accounts, null);
    assert.ok(client.modelCalls.some((call) => call.accountId === "work"), "an account scope is read once the accounts have been tried");
    stop();
  });

  it("waits for the accounts before asking for the list of a thread of a named account, too", async () => {
    const onWork: SessionSummary = { ...SESSION, accountId: "work" };
    const client = new FakeClient();
    client.listSessions = async () => [onWork];
    client.transcript = async () => load({ session: onWork });
    client.accounts = [WORK];
    client.models = [SPARK];
    const open = gated(client);
    const { controller, stop } = await startedWith(client, "#/t/s1");
    assert.equal(controller.store.get().threads["s1"]?.load, "ready", "the thread is open");
    assert.equal(controller.store.get().accounts, null, "and the accounts are still being read");
    assert.deepEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }], "only the default login was asked: whether the thread's account has a login is not known yet");
    open();
    await settle();
    assert.deepEqual(client.modelCalls.at(-1), { sessionId: "s1", accountId: undefined }, "the thread's own host is asked once the accounts are in");
    assert.equal(controller.store.get().modelsStatus["thread:s1"]?.status, "ready");
    stop();
  });

  it("never asks for the list of a thread of an account that has no login, before the accounts have loaded or after", async () => {
    const onWork: SessionSummary = { ...SESSION, accountId: "work" };
    const client = new FakeClient();
    client.listSessions = async () => [onWork];
    client.transcript = async () => load({ session: onWork });
    client.accounts = [{ ...WORK, hasLogin: false }];
    client.models = [SPARK];
    const open = gated(client);
    const { controller, stop } = await startedWith(client, "#/t/s1");
    assert.deepEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }]);
    open();
    await settle();
    assert.equal(controller.store.get().accounts?.length, 1);
    assert.deepEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }], "and the host that cannot answer still is not");
    assert.equal(controller.store.get().modelsStatus["thread:s1"], undefined);
    stop();
  });
});

describe("small fixes to choosing a model", () => {
  it("says a Contributor model Muse started a thread on when nobody picked it and the list names no default", async () => {
    const client = new FakeClient();
    client.models = LIVE_1_4_7.models;
    client.modelSource = "bundledCatalog";
    client.startSession = async (cwd, options) => {
      client.startCalls.push({ cwd, modelId: options?.modelId, accountId: options?.accountId ?? null });
      return { ...SESSION, modelId: "muse-spark-1.3-contributor" };
    };
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    const notices = () => toasts.filter((t) => t.title.startsWith("Muse's default is"));
    assert.equal(await controller.send("hello"), true);
    assert.deepEqual(notices().map((t) => t.title), ["Muse's default is muse-spark-1.3, a Contributor model"]);
    assert.equal(controller.store.get().prefs.contributorAck, true);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await controller.send("again");
    assert.equal(notices().length, 1, "said once");
    stop();
  });

  it("says it when a saved model was dropped and Muse's own pick is a Contributor model, and not when a model was asked for by name", async () => {
    const client = new FakeClient();
    client.models = [SPARK, WONDER];
    client.startSession = async (cwd, options) => {
      client.startCalls.push({ cwd, modelId: options?.modelId, accountId: options?.accountId ?? null });
      return { ...SESSION, modelId: "muse-spark-1.3-contributor" };
    };
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "muse-wonder-1.0" });
    // Asked for by name: whatever Muse then answers, nobody left the choice to Muse.
    assert.equal(await controller.send("by name"), true);
    assert.equal(client.startCalls.at(-1)?.modelId, "muse-wonder-1.0");
    assert.equal(toasts.filter((t) => t.title.startsWith("Muse's default is")).length, 0);
    controller.setPrefs({ defaultModelId: "retired-x" });
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await controller.send("dropped");
    assert.equal(client.startCalls.at(-1)?.modelId, undefined);
    assert.equal(toasts.filter((t) => t.title.startsWith("Muse's default is")).length, 1);
    stop();
  });

  it("puts a refused switch back on its own thread though another thread was switched meanwhile", async () => {
    const client = new FakeClient();
    client.models = [SPARK, SPARK_12, WONDER];
    const other: SessionSummary = { ...SESSION, sessionId: "s2", title: "Other" };
    client.listSessions = async () => [SESSION, other];
    client.loadTranscript = async (sessionId: string) => load({ session: sessionId === "s1" ? SESSION : other });
    const { controller, stop } = await startedWith(client, "#/t/s1");
    const modelOf = (id: string) => controller.store.get().threads[id]?.fold.meta.modelId;
    const before = modelOf("s1");
    assert.ok(before);
    let refuse!: (error: Error) => void;
    client.modelGates = [
      new Promise<void>((_, reject) => {
        refuse = reject;
      }),
    ];
    const first = controller.setModel("muse-wonder-1.0");
    assert.equal(modelOf("s1"), "muse-wonder-1.0", "the switch shows at once");
    controller.openThread("s2");
    await settle();
    assert.equal(await controller.setModel("muse-spark-1.2"), true);
    refuse(new Error("Your plan does not include this model"));
    assert.equal(await first, false);
    assert.equal(modelOf("s1"), before, "the refused switch is put back on its thread");
    assert.equal(modelOf("s2"), "muse-spark-1.2", "the other thread's switch stays");
    stop();
  });

  it("lets the newest pick, on whichever thread, write the default new threads start on", async () => {
    const client = new FakeClient();
    client.models = [SPARK, SPARK_12, WONDER];
    const other: SessionSummary = { ...SESSION, sessionId: "s2", title: "Other" };
    client.listSessions = async () => [SESSION, other];
    client.loadTranscript = async (sessionId: string) => load({ session: sessionId === "s1" ? SESSION : other });
    const { controller, stop } = await startedWith(client, "#/t/s1");
    let accept!: () => void;
    client.modelGates = [
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
    ];
    const older = controller.setModel("muse-wonder-1.0");
    controller.openThread("s2");
    await settle();
    assert.equal(await controller.setModel("muse-spark-1.2"), true);
    accept();
    assert.equal(await older, true);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-spark-1.2", "an older switch finishing later does not take the default back");
    stop();
  });

  it("treats a pick from a stand-in list as a try that the account has not confirmed", async () => {
    const client = new FakeClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.accounts = [WORK];
    client.modelQueue = [[SPARK, SPARK_12], new Error("Muse could not start")];
    const { controller, stop, toasts } = await startedWith(client, NEW_THREAD);
    assert.equal(controller.store.get().modelsStatus["acct:work"]?.status, "error");
    assert.equal(modelsShown(controller.store.get(), { accountId: "work" }).fallback, true);
    assert.equal(await controller.setModel("muse-spark-1.2"), true);
    assert.equal(controller.store.get().prefs.defaultModelId, "muse-spark-1.2");
    assert.equal(controller.store.get().prefs.defaultModelTried, true, "it is not pretended to be listed");
    assert.deepEqual(toasts.filter((t) => /has not confirmed it/.test(t.title)), [
      { title: "Using muse-spark-1.2; Work has not confirmed it", detail: "Its model list did not load. Muse checks access when you send a prompt." },
    ]);
    assert.ok(!toasts.some((t) => /did not list/.test(t.title)));
    assert.equal(await controller.send("/model spark 1.3"), true);
    assert.equal(controller.store.get().prefs.defaultModelTried, true);
    assert.equal(toasts.filter((t) => /has not confirmed it/.test(t.title)).length, 2, "a name from the stand-in list is a try too");
    await controller.send("hello");
    assert.equal(client.startCalls.at(-1)?.modelId, "muse-spark-1.3");
    assert.equal(client.startCalls.at(-1)?.accountId, "work");
    stop();
  });

  it("takes a pick from the default login's list as listed on a thread of that login whose own list did not load", async () => {
    const client = new FakeClient();
    client.modelQueue = [[SPARK, SPARK_12], new Error("Muse could not start")];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    const state = () => controller.store.get();
    assert.equal(state().modelsStatus["thread:s1"]?.status, "error");
    assert.equal(modelsShown(state(), { sessionId: "s1" }).fallback, true, "the default login's list stands in for the thread's");
    assert.equal(await controller.setModel("muse-spark-1.2"), true);
    assert.deepEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-spark-1.2" }]);
    assert.equal(state().prefs.defaultModelId, "muse-spark-1.2", "the login's own list vouches for it, so it is what new threads start on");
    assert.equal(state().prefs.defaultModelTried, false);
    assert.deepEqual(toasts.filter((t) => /has not confirmed it|did not list/.test(t.title)), [], "nobody is named as not having confirmed what it listed");
    // What that list lacks is a try as ever, and this thread's alone.
    assert.equal(await controller.setModel("muse-wonder-2.0"), true);
    assert.equal(state().prefs.defaultModelId, "muse-spark-1.2");
    assert.deepEqual(
      toasts.filter((t) => /did not list/.test(t.title)).map((t) => t.title),
      ["Using muse-wonder-2.0, which your Muse did not list"],
    );
    stop();
  });

  it("says the account has not confirmed a pick from the stand-in list on a thread of a named account", async () => {
    const onWork: SessionSummary = { ...SESSION, accountId: "work" };
    const client = new FakeClient();
    client.accounts = [WORK];
    client.listSessions = async () => [onWork];
    client.transcript = async () => load({ session: onWork });
    client.modelQueue = [[SPARK, SPARK_12], new Error("Muse could not start")];
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    const state = () => controller.store.get();
    assert.equal(state().modelsStatus["thread:s1"]?.status, "error");
    assert.equal(await controller.setModel("muse-spark-1.2"), true);
    assert.deepEqual(toasts.filter((t) => /has not confirmed it/.test(t.title)).map((t) => t.title), ["Using muse-spark-1.2; Work has not confirmed it"]);
    assert.equal(state().prefs.defaultModelId, null, "a try on a thread is that thread's alone");
    stop();
  });
});

describe("restarting Muse waits for background work", () => {
  const workflow = (status: string): ViewEvent => ({
    method: "item/updated",
    params: { item: { itemId: "wf-1", kind: "workflow", revision: status === "inProgress" ? 1 : 2, status, turnId: "t1", workflowRunId: "run-1", children: [{ childId: "c1", attempt: 1, label: "bg", status: status === "inProgress" ? "started" : "terminal", terminal: status === "inProgress" ? undefined : "completed" }] } },
  });
  const afterTheTurn = (status: string): ViewEvent[] => [
    { method: "turn/started", params: { turnId: "t1" } },
    workflow(status),
    { method: "turn/completed", params: { turnId: "t1", terminal: "completed" } },
  ];

  it("refuses while a workflow run goes on after the lead turn ended, and says so", async () => {
    const client = new FakeClient();
    client.transcript = async () => load({ events: afterTheTurn("inProgress") });
    const { controller, stop, toasts } = await startedWith(client, "#/t/s1");
    const thread = controller.store.get().threads["s1"];
    assert.ok(thread);
    assert.equal(thread.fold.activeTurnId, null, "no turn is running");
    assert.equal(crewBusy(thread.fold, thread.researchRuns), true, "but the run is");
    assert.equal(Object.values(controller.store.get().sessions).some((s) => s.live?.activeTurnId), false);
    assert.equal(await controller.restartMuse(), false);
    assert.equal(client.restarts, 0);
    assert.equal(toasts.at(-1)?.title, "Work is still running");
    stop();
  });

  it("restarts once the run has ended", async () => {
    const client = new FakeClient();
    client.transcript = async () => load({ events: afterTheTurn("completed") });
    const { controller, stop } = await startedWith(client, "#/t/s1");
    assert.equal(await controller.restartMuse(), true);
    assert.equal(client.restarts, 1);
    stop();
  });
});

describe("moving around does not hammer Muse for the model lists", () => {
  it("leaves a built-in list be for ten minutes of navigation, where the picker and a refresh by hand ask again", async () => {
    const client = new FakeClient();
    client.modelSource = "bundledCatalog";
    client.models = LIVE_1_4_7.models;
    const { controller, stop, held } = await startedWith(client);
    assert.equal(client.modelCalls.length, 1);
    for (const route of [{ kind: "new", cwd: "/work/app" }, { kind: "home" }, { kind: "settings" }, { kind: "new", cwd: "/work/app" }] as const) {
      controller.navigate(route);
      await settle();
    }
    assert.equal(client.modelCalls.length, 1, "four route changes ask for nothing");
    controller.setPicker("model");
    await settle();
    assert.equal(client.modelCalls.length, 2, "the picker always asks again of a built-in list");
    controller.setPicker(null);
    await controller.discoverAll();
    await settle();
    assert.equal(client.modelCalls.length, 3, "so does refreshing threads by hand");
    held.clock.now += 11 * 60_000;
    controller.navigate({ kind: "home" });
    await settle();
    assert.equal(client.modelCalls.length, 4, "and a navigation does once the list is ten minutes old");
    stop();
  });

  it("leaves a failed list be for a minute of navigation, but not Retry, the picker or a later minute", async () => {
    const client = new FakeClient();
    client.modelQueue = [new Error("a"), new Error("b"), new Error("c"), new Error("d")];
    client.models = [SPARK];
    const { controller, stop, held } = await startedWith(client);
    assert.equal(client.modelCalls.length, 1);
    for (const route of [{ kind: "new", cwd: "/work/app" }, { kind: "home" }, { kind: "settings" }] as const) {
      controller.navigate(route);
      await settle();
    }
    assert.equal(client.modelCalls.length, 1, "no retry on every navigation");
    assert.equal(controller.store.get().modelsStatus["default"]?.status, "error");
    controller.setPicker("model");
    await settle();
    assert.equal(client.modelCalls.length, 2, "the picker asks");
    controller.setPicker(null);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await settle();
    assert.equal(client.modelCalls.length, 2, "and the failure it saw is a new one");
    held.clock.now += 61_000;
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await settle();
    assert.equal(client.modelCalls.length, 3, "a minute later a navigation asks again");
    await controller.refreshModels({ force: true });
    assert.equal(client.modelCalls.length, 4, "Retry always goes through");
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
    client.startSession = async () => { throw new Error("session/start: read surviving deletion authority: Unsafe path"); };
    const { controller, stop } = linuxController(client);
    await flushMicrotasks(50);
    controller.navigate({ kind: "settings" });
    await controller.installLinuxMuse();
    assert.deepEqual(client.setupAccounts, []);
    assert.equal(controller.store.get().linuxSetup, null);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    assert.equal(await controller.send("Keep this draft"), false);
    assert.equal(controller.store.get().toasts.at(-1)?.title, "Could not start a thread");
    assert.equal(controller.store.get().toasts.at(-1)?.action, undefined, "other platforms cannot open Linux setup");
    stop();
  });
});
