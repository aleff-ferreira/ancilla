import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AncillaError, type EventHandler, type AncillaClient } from "../src/client.js";
import { AncillaController, hashToRoute, routeToHash, staleThreadReason, type Platform } from "../src/model/controller.js";
import { buildTurns } from "../src/model/fold.js";
import { DEFAULT_CREW_WIDTH, ZOOM_MAX, ZOOM_MIN, defaultPrefs, revivePrefs } from "../src/model/store.js";
import { crewBusy, crewView, type AgentVM } from "../src/model/crew.js";
import { takeWantedTab } from "../src/model/wantedTab.js";
import { modelIdError, modelMenu, modelsShown, offeredByAnother, tryTypedModel } from "../src/model/models.js";
import type { AncillaEvent, ModelCatalog, ModelOption, ProjectView, ProviderId, SessionSummary, SkillEntry, TranscriptLoad, UserInputRequest, ViewEvent, ResearchConfig, ResearchExport, ResearchExportFormat, ResearchRunView, ResearchSettings } from "../src/types.js";
import { historyEvents } from "./fixtures/probe.js";
import { fakeResearchRun, runningResearch } from "./fixtures/research.js";
import { LIVE_1_4_0, LIVE_1_4_7, answer } from "./fixtures/picker-catalogs.js";
import type { LinuxSetupView, LinuxDesktopStatus } from "../src/types.js";

function createSessionFixture(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s1", cwd: "/work/app", title: "Probe", titleSource: "auto",
    turnCount: 3, modelId: "muse-spark-1.3", origin: "ancilla", archived: false,
    createdAt: "2026-09-11T00:00:00.000Z", activityAt: "2026-09-11T00:00:00.000Z",
    settled: false, settledAt: null, unsettledAt: null, sandboxDisabled: false,
    accountId: null, live: null, ...overrides,
  };
}
const SESSION = createSessionFixture();

function load(overrides: Partial<TranscriptLoad> = {}): TranscriptLoad {
  const defaults: TranscriptLoad = {
    session: SESSION,
    events: historyEvents,
    truncated: false,
    readOnly: false,
    readOnlyReason: null,
    pending: { approvals: [], userInputs: [] },
    msp: {
      status: "idle",
      activeTurnId: null,
      modelId: "muse-spark-1.3",
      approvalMode: "onRequest",
      workspaceRoot: "/work/app",
      turnCount: 3,
    },
  };
  return { ...defaults, ...overrides };
}

type ModelAnswer = ModelOption[] | Error | { models: ModelOption[]; source: string | null };

export interface SentTurnPayload {
  readonly text: string;
  readonly sessionId: string;
  readonly attachments?: Array<{ name: string; mediaType: string; base64: string }>;
  readonly ifBusy?: string;
  readonly displayText?: string;
}

export class MockAncillaRpcClient implements AncillaClient {
  public handler: EventHandler | null = null;
  public sent: SentTurnPayload[] = [];
  public actions: string[] = [];
  public orders: string[][] = [];
  public skills: SkillEntry[] = [];
  public projects: ProjectView[] = [
    { cwd: "/work/app", displayName: "app", pinned: false, activityAt: "2026-09-11T00:00:00.000Z", defaultAccountId: null, folders: [{ cwd: "/work/app", displayName: "app" }] },
  ];
  public folderCalls: string[] = [];
  public discovered: (string | undefined)[] = [];
  public startCalls: Array<{ cwd: string; approvalMode?: string; modelId?: string; accountId: string | null }> = [];
  public transcriptOptions: Array<{ refresh?: boolean } | undefined> = [];
  public turnEfforts: Array<string | undefined> = [];
  public decided: Array<{ approvalId: string; choiceId: string }> = [];
  public models: ModelOption[] = [];
  public modelSource: string | null = "providerCatalog";
  public modelQueue: Array<ModelAnswer | (() => Promise<ModelAnswer>)> = [];
  public modelCalls: Array<{ sessionId?: string; accountId?: string | null }> = [];
  public catalogCalls: Array<{ sessionId?: string; accountId?: string | null; providerId?: ProviderId | null; options?: { refresh?: boolean } }> = [];
  public restarts = 0;
  public restartError: Error | null = null;
  public titleSettings = { enabled: true, modelId: null as string | null };
  public titleError: Error | null = null;
  public titleGate: Promise<void> | null = null;
  public sandboxSettings = { disabled: false };
  public sandboxError: Error | null = null;
  public sandboxGate: Promise<void> | null = null;
  public sandboxCalls: Array<boolean | undefined> = [];
  public yoloSettings = { enabled: false };
  public yoloError: Error | null = null;
  public yoloGate: Promise<void> | null = null;
  public yoloCalls: Array<boolean | undefined> = [];
  public modelSwitches: Array<{ sessionId: string; modelId: string }> = [];
  public setModelError: Error | null = null;
  public modelGates: Array<Promise<void>> = [];
  public approvalModes: Array<{ sessionId: string; mode: string }> = [];
  public approvalModeFailFor = new Set<string>();
  public compactNoop = false;
  public researchRuns: ResearchRunView[] = [];
  public researchStarts: Array<{ sessionId: string; question: string; config: Partial<ResearchConfig> | null; commandId: string }> = [];
  public researchStops: Array<{ runId: string; writeReport: boolean }> = [];
  public researchSettings: ResearchSettings = { enabled: true, config: fakeResearchRun({}).config };
  public researchPatches: Array<{ enabled?: boolean; config?: Partial<ResearchConfig> }> = [];
  public startResearchError: Error | null = null;
  public assistantCalls: Array<{ method: string; path: string; body?: unknown }> = [];
  public assistantReply: unknown = {};
  public openedFiles: Array<{ cwd: string; path: string }> = [];
  public exports: Array<{ runId: string; format: ResearchExportFormat }> = [];
  public exportFails: string | null = null;
  public exportReads: Array<{ runId: string; format: ResearchExportFormat }> = [];
  public skillSessions: Array<string | undefined> = [];
  public efforts: string[] = [];
  public goalError: Error | null = null;
  public workflowError: Error | null = null;
  public plan: import("../src/types.js").PlanUsage | null = null;
  public planByAccount: Record<string, import("../src/types.js").PlanUsage> = {};
  public planMetadata: Pick<import("../src/types.js").PlanUsageReport, "accountId" | "saved" | "savedAccountIds" | "status" | "accounts"> = {};
  public planError: Error | null = null;
  public accounts: import("../src/types.js").AccountView[] = [];
  public accountCalls: Array<{ kind: "create" | "rename" | "remove" | "default"; id?: string; cwd?: string; accountId?: string | null; name?: string }> = [];
  public setProjectDefaultAccountError: Error | null = null;
  public metaApiKeyInherited = false;
  public defaultLogin: import("../src/types.js").DefaultLoginIdentity | undefined = undefined;
  public healthCalls = 0;
  public loginAccountResult: import("../src/types.js").AccountLoginResult = {
    url: "https://auth.meta.com/oauth/device/?code=TEST-CODE",
    code: "TEST-CODE",
  };
  public loginAccountCalls: Array<string | null> = [];
  public accountLoginProgress?: AncillaClient["accountLoginProgress"];
  public cancelledLoginCalls: Array<{ id: string | null; loginId: string }> = [];
  public writes: Array<{ path: string; content: string; baseMtimeMs: number | null }> = [];
  public writeError: Error | null = null;

  public transcript: () => Promise<TranscriptLoad> = async () => load();
  public sendResult: () => Promise<{ turnId: string | null; disposition: string | null }> = async () => ({ turnId: "t9", disposition: "started" });

  async probeEnvironment(_shouldRefresh?: boolean) {
    return { platform: "linux" as const, wslAvailable: false, defaultDistro: null, museFound: true, musePath: "/usr/bin/muse", version: "0.2.0", persistent: true };
  }
  async listProjects(): Promise<ProjectView[]> { return [...this.projects]; }
  async addProject(cwd: string): Promise<{ cwd: string; warning: string | null }> { return { cwd, warning: null }; }
  async addProjectFolder(cwd: string, path: string): Promise<{ project: ProjectView; warning: string | null }> {
    this.folderCalls.push(`add ${cwd} ${path}`);
    const proj = this.projects.find((p) => p.cwd === cwd);
    if (!proj) throw new Error("Unknown project.");
    const updated = { ...proj, folders: [...proj.folders, { cwd: path, displayName: path.slice(path.lastIndexOf("/") + 1) }] };
    this.projects = this.projects.filter((p) => p.cwd !== path).map((p) => (p.cwd === cwd ? updated : p));
    return { project: updated, warning: null };
  }
  async removeProjectFolder(cwd: string, path: string): Promise<ProjectView> {
    this.folderCalls.push(`remove ${cwd} ${path}`);
    const proj = this.projects.find((p) => p.cwd === cwd);
    if (!proj) throw new Error("Unknown project.");
    const updated = { ...proj, folders: proj.folders.filter((f) => f.cwd !== path) };
    this.projects = [...this.projects.map((p) => (p.cwd === cwd ? updated : p)), { ...updated, cwd: path, displayName: "docs", folders: [{ cwd: path, displayName: "docs" }] }];
    return updated;
  }
  async cloneProject(_url: string, path: string): Promise<{ cwd: string; warning: string | null }> { return { cwd: path, warning: null }; }
  async listDirectory(path: string): Promise<{ directory: string; parent: string | null; separator: '/' | '\\'; exists: boolean; entries: any[] }> { return { directory: path, parent: null, separator: "/" as const, exists: true, entries: [] }; }
  assetUrl(path: string): string { return path; }
  async revealPath(_path?: string): Promise<void> {}
  async hideProject(_cwd?: string): Promise<void> {}
  async setPinned(_cwd?: string, _pinned?: boolean): Promise<void> {}
  async listSessions(): Promise<SessionSummary[]> { return [SESSION]; }
  async discover(cwd?: string): Promise<void> { this.discovered.push(cwd); }
  async startSession(cwd: string, options?: { approvalMode?: string; modelId?: string; accountId?: string | null }) {
    this.startCalls.push({ cwd, approvalMode: options?.approvalMode, modelId: options?.modelId, accountId: options?.accountId ?? null });
    return { ...SESSION, accountId: options?.accountId ?? null };
  }
  loadTranscript(_sessionId: string, options?: { refresh?: boolean }) {
    this.transcriptOptions.push(options);
    return this.transcript();
  }
  async updateSession(_targetSessionId?: string, _delta?: any): Promise<any> { return SESSION; }
  async sendTurn(sessionId: string, text: string, options?: { ifBusy?: string; displayText?: string; reasoningEffort?: string; attachments?: { name: string; mediaType: string; base64: string }[] }) {
    this.turnEfforts.push(options?.reasoningEffort);
    this.sent.push({ sessionId, text, ifBusy: options?.ifBusy, displayText: options?.displayText, attachments: options?.attachments });
    return this.sendResult();
  }
  async interruptTurn(_sessionId?: string): Promise<void> {}
  async unqueueTurn(_sessionId?: string): Promise<void> {}
  async decideApproval({ approvalId, choiceId }: { approvalId: string; choiceId: string }) {
    this.decided.push({ approvalId, choiceId });
  }
  async answerUserInput(_input?: unknown): Promise<void> {}
  async cancelUserInput(_input?: unknown): Promise<void> {}
  async clarifyUserInput(_input?: unknown): Promise<void> {}
  private async nextModels(sessionId?: string, accountId?: string | null): Promise<{ models: ModelOption[]; source: string | null }> {
    this.modelCalls.push({ sessionId, accountId });
    const nxt = this.modelQueue.shift();
    const ans = typeof nxt === "function" ? await nxt() : nxt;
    if (ans instanceof Error) throw ans;
    if (Array.isArray(ans)) return { models: ans, source: this.modelSource };
    return ans ?? { models: this.models, source: this.modelSource };
  }
  async listModels(sessionId?: string, accountId?: string | null, providerId?: ProviderId | null, options?: { refresh?: boolean }) {
    this.catalogCalls.push({ sessionId, accountId, providerId, options });
    return (await this.nextModels(sessionId, accountId)).models;
  }
  async listModelCatalog(sessionId?: string, accountId?: string | null, providerId?: ProviderId | null, options?: { refresh?: boolean }): Promise<ModelCatalog> {
    this.catalogCalls.push({ sessionId, accountId, providerId, options });
    const { models, source } = await this.nextModels(sessionId, accountId);
    return { models, source, providerId: providerId ?? "meta", profileId: "default", hostVersion: "1.4.7" };
  }
  async restartHosts(): Promise<void> {
    this.restarts += 1;
    if (this.restartError) throw this.restartError;
  }
  async getTitleSettings(): Promise<{ enabled: boolean; modelId: string | null }> { return { ...this.titleSettings }; }
  async setTitleSettings(patch: { enabled?: boolean; modelId?: string | null }): Promise<any> {
    if (this.titleGate) await this.titleGate;
    if (this.titleError) {
      const err = this.titleError;
      this.titleError = null;
      throw err;
    }
    this.titleSettings = { enabled: patch.enabled ?? this.titleSettings.enabled, modelId: patch.modelId !== undefined ? patch.modelId : this.titleSettings.modelId };
    return { ...this.titleSettings };
  }
  async getSandboxSettings() { return { ...this.sandboxSettings }; }
  async setSandboxSettings(patch: { disabled?: boolean }): Promise<any> {
    this.sandboxCalls.push(patch.disabled);
    if (this.sandboxGate) await this.sandboxGate;
    if (this.sandboxError) {
      const err = this.sandboxError;
      this.sandboxError = null;
      throw err;
    }
    this.sandboxSettings = { disabled: patch.disabled ?? this.sandboxSettings.disabled };
    return { ...this.sandboxSettings };
  }
  async getYoloSettings() { return { ...this.yoloSettings }; }
  async setYoloSettings(patch: { enabled?: boolean }): Promise<any> {
    this.yoloCalls.push(patch.enabled);
    if (this.yoloGate) await this.yoloGate;
    if (this.yoloError) {
      const err = this.yoloError;
      this.yoloError = null;
      throw err;
    }
    this.yoloSettings = { enabled: patch.enabled ?? this.yoloSettings.enabled };
    return { ...this.yoloSettings };
  }
  async setSessionModel(sessionId: string, modelId: string) {
    this.modelSwitches.push({ sessionId, modelId });
    const gate = this.modelGates.shift();
    if (gate) await gate;
    if (this.setModelError) {
      const err = this.setModelError;
      this.setModelError = null;
      throw err;
    }
  }
  async setApprovalMode(sessionId: string, mode: string): Promise<void> {
    this.approvalModes.push({ sessionId, mode });
    if (this.approvalModeFailFor.has(sessionId)) throw new Error(`could not set the approval mode for ${sessionId}`);
  }
  async setProjectOrder(cwds: string[]) { this.orders.push(cwds); }
  async usage() { return { since: "2026-09-01T00:00:00.000Z", days: 30, buckets: [], threads: [] }; }
  async runShellProxy(sessionId: string, command: string): Promise<any> {
    this.actions.push(`shell-proxy:${command}`);
    return { id: `run-${this.actions.length}`, sessionId, command, exitCode: 0, output: `ran ${command}`, truncated: false, durationMs: 12, at: "2026-09-11T22:00:00.000Z" };
  }
  async compact(_sessionId?: string): Promise<any> {
    this.actions.push("compact");
    return { noop: this.compactNoop, reason: this.compactNoop ? "no_compactable_history" : null };
  }
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
  async assistant<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    this.assistantCalls.push({ method, path, ...(body === undefined ? {} : { body }) });
    return this.assistantReply as T;
  }
  async getResearchSettings(): Promise<ResearchSettings> { return this.researchSettings; }
  async setResearchSettings(patch: { enabled?: boolean; config?: Partial<ResearchConfig> }): Promise<ResearchSettings> {
    this.researchPatches.push(patch);
    this.researchSettings = {
      enabled: patch.enabled ?? this.researchSettings.enabled,
      config: { ...this.researchSettings.config, ...(patch.config ?? {}), models: { ...this.researchSettings.config.models, ...(patch.config?.models ?? {}) } },
    };
    return this.researchSettings;
  }
  async runShell(sessionId: string, command: string) { this.actions.push(`shell:${sessionId}:${command}`); }
  async forkSession(): Promise<SessionSummary> {
    this.actions.push("fork");
    const forkedSession: SessionSummary = { ...SESSION, sessionId: "s2", title: "Probe (fork)" };
    return forkedSession;
  }
  async listSkills(_cwd: string, sessionId?: string): Promise<{ skills: SkillEntry[]; error: string | null }> {
    this.skillSessions.push(sessionId);
    return { skills: [...this.skills], error: null };
  }
  async skillBody(_cwd: string, skillId: string) { return `Instructions for ${skillId}.`; }
  async openFolder() {}
  async openProjectFile(cwd: string, path: string) { this.openedFiles.push({ cwd, path }); }
  async exportResearch(runId: string, format: ResearchExportFormat): Promise<ResearchExport> {
    this.exports.push({ runId, format });
    if (this.exportFails) throw new Error(this.exportFails);
    return { path: `.ancilla/research/${runId}/report.${format}`, name: `report.${format}`, size: 1234, url: `/api/research/${runId}/export/report.${format}` };
  }
  async readResearchExport(runId: string, format: ResearchExportFormat): Promise<Uint8Array> {
    this.exportReads.push({ runId, format });
    return new TextEncoder().encode(`report.${format}`);
  }
  async setReasoningEffort(sessionId: string, effort: string) { this.efforts.push(`${sessionId}:${effort}`); }
  async goal(sessionId: string, action: string, objective?: string): Promise<{ turnId: string | null }> {
    if (this.goalError) throw this.goalError;
    const goalTag = ["goal", sessionId, action, ...(objective ? [objective] : [])].join(":");
    this.actions.push(goalTag);
    const hasGoalTurn = action === "set" || action === "resume";
    return { turnId: hasGoalTurn ? "t-goal" : null };
  }
  async subagent(sessionId: string, action: string, subagentId: string, options?: { body?: string }): Promise<void> {
    const parts = ["subagent", sessionId, action, subagentId, ...(options?.body ? [options.body] : [])];
    this.actions.push(parts.join(":"));
  }
  async task(sessionId: string, action: string, taskId?: string): Promise<void> {
    this.actions.push(`task:${sessionId}:${action}${taskId ? `:${taskId}` : ""}`);
  }
  async workflow(sessionId: string, action: string, workflowRunId: string, child?: { childId: string; attempt: number }): Promise<void> {
    if (this.workflowError) throw this.workflowError;
    this.actions.push(`workflow:${sessionId}:${action}:${workflowRunId}${child ? `:${child.childId}@${child.attempt}` : ""}`);
  }
  async readOutput(_sessionId: string, _itemId: string, _outputRef: string, offset = 0): Promise<any> {
    return { content: offset === 0 ? "first " : "second", encoding: "utf8", mediaType: "text/plain", offsetBytes: offset, byteLen: 6, eof: offset > 0 };
  }
  async planUsage(): Promise<import("../src/types.js").PlanUsageReport> {
    if (this.planError) throw this.planError;
    return { usage: this.plan, byAccount: this.planByAccount, ...this.planMetadata };
  }
  async listAccounts() { return [...this.accounts]; }
  async createAccount(id: string, options?: { name?: string; seedFromDefault?: boolean }): Promise<import("../src/types.js").AccountView> {
    const label = options?.name ?? id;
    this.accountCalls.push({ kind: "create", id, name: options?.name });
    const created: import("../src/types.js").AccountView = { id, name: label, hasLogin: false, email: null, lastUsedAt: null };
    this.accounts.push(created);
    return created;
  }
  async renameAccount(id: string, name: string): Promise<void> {
    this.accountCalls.push({ kind: "rename", id, name });
    const acc = this.accounts.find((a) => a.id === id);
    if (acc) acc.name = name;
  }
  async removeAccount(id: string): Promise<void> {
    this.accountCalls.push({ kind: "remove", id });
    this.accounts = this.accounts.filter((a) => a.id !== id);
  }
  async setProjectDefaultAccount(cwd: string, accountId: string | null): Promise<void> {
    this.accountCalls.push({ kind: "default", cwd, accountId });
    if (this.setProjectDefaultAccountError) {
      const err = this.setProjectDefaultAccountError;
      this.setProjectDefaultAccountError = null;
      throw err;
    }
  }
  async accountsHealth(): Promise<import('../src/types.js').AccountsHealth> {
    this.healthCalls++;
    return { metaApiKeyInherited: this.metaApiKeyInherited, ...(this.defaultLogin ? { defaultLogin: this.defaultLogin } : {}) };
  }
  async cancelAccountLogin(id: string | null, loginId: string): Promise<void> {
    this.cancelledLoginCalls.push({ id, loginId });
  }
  async loginAccount(id: string | null): Promise<import('../src/types.js').AccountLoginResult> {
    this.loginAccountCalls.push(id);
    return this.loginAccountResult;
  }
  async listFiles(_cwd: string, path: string): Promise<{ path: string; entries: any[]; truncated: boolean }> { return { path, entries: [], truncated: false }; }
  async readFile(_cwd: string, filePath: string) {
    const mdKind = "markdown" as const;
    return { path: filePath, name: filePath, size: 3, mtimeMs: 100, kind: mdKind, mediaType: "text/markdown", content: "# a", truncated: false };
  }
  async writeFile(_cwd: string, path: string, content: string, baseMtimeMs: number | null) {
    if (this.writeError) {
      const err = this.writeError;
      this.writeError = null;
      throw err;
    }
    this.writes.push({ path, content, baseMtimeMs });
    return { path, size: content.length, mtimeMs: 200 };
  }
  async searchFiles(_query?: unknown): Promise<any[]> { return []; }
  async openFileExternally(_cwd?: string, _path?: string): Promise<void> {}
  fileUrl(cwd: string, path: string): string { return `/raw?${cwd}&${path}`; }
  subscribe(handler: EventHandler) {
    this.handler = handler;
    return () => { this.handler = null; };
  }
}

export const FakeClient = MockAncillaRpcClient;
export type FakeClient = MockAncillaRpcClient;

interface TestPlatformHarness extends Platform {
  hash: string;
}

function makeTestPlatform(initialHash = ""): TestPlatformHarness {
  const harness: TestPlatformHarness = {
    hash: initialHash,
    loadPrefs: () => null,
    savePrefs: () => {},
    readHash: () => harness.hash,
    writeHash: (target: string) => {
      harness.hash = target;
    },
    onHashChange: () => () => {},
    now: () => Date.now(),
    schedule: (cb: () => void) => setTimeout(cb, 0),
    cancel: (timerId: unknown) => clearTimeout(timerId as ReturnType<typeof setTimeout>),
    focused: () => false,
  };
  return harness;
}

const platform = makeTestPlatform;

const settleController = () => new Promise<void>((resolve) => setTimeout(resolve, 15));
const settle = settleController;

async function flushMicrotasks(iterations = 20): Promise<void> {
  for (let tick = 0; tick < iterations; tick++) {
    await Promise.resolve();
  }
}

async function started(client: MockAncillaRpcClient, hash = "#/t/s1") {
  const testEnv = platform(hash);
  const controller = new AncillaController(client, testEnv);
  const stopController = controller.start();
  await settleController();
  await settleController();
  return { controller, stop: stopController };
}

function attachTestNotifier(controller: AncillaController, notifications: string[]): void {
  controller.attachNotifier({
    request: async () => "granted",
    permission: async () => "granted",
    show: async (note) => {
      notifications.push(note.tag);
    },
  });
}

function makeSharedPrefsPlatform(initialHash = "#/t/s1") {
  let savedPrefs: unknown = null;
  const env = {
    hash: initialHash,
    loadPrefs: () => savedPrefs,
    savePrefs: (prefs: unknown) => {
      savedPrefs = prefs;
    },
    readHash: () => env.hash,
    writeHash: (next: string) => {
      env.hash = next;
    },
    onHashChange: () => () => {},
    now: () => Date.now(),
    schedule: (cb: () => void) => setTimeout(cb, 0),
    cancel: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    focused: () => false,
    getSaved: () => savedPrefs,
  };
  return env;
}

function createDeferredGate(): { gate: Promise<void>; release: () => void } {
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  return { gate, release: unlock };
}

function emitSessionStatus(client: MockAncillaRpcClient, sessionId: string, livePatch: any): void {
  const fullLive: any = {
    turnStartedAt: null,
    pendingApprovals: 0,
    activeTurnId: null,
    lastError: null,
    lastTerminal: null,
    pendingInputs: 0,
    ...livePatch,
  };
  client.handler?.({
    type: "session-status",
    sessionId,
    live: fullLive as never,
  });
}





describe("AncillaController", () => {
  it("boots, lists threads and opens the one in the URL", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    const state = controller.store.get();
    assert.strictEqual(state.boot, "ready");
    assert.deepStrictEqual(state.route, { kind: "thread", sessionId: "s1" });
    assert.strictEqual(state.threads["s1"]?.load, "ready");
    assert.strictEqual(buildTurns(state.threads["s1"]!.fold).length, 3);
    assert.deepStrictEqual(client.transcriptOptions, [undefined], "an idle session still uses the normal initial load");
    stopController();
  });

  it("reads a running session on a fresh page without resuming its active turn", async () => {
    const client = new MockAncillaRpcClient();
    const pendingInputSession: SessionSummary = createSessionFixture({
      live: { activeTurnId: "live-1", pendingApprovals: 0, pendingInputs: 1, turnStartedAt: null, lastTerminal: null, lastError: null },
    });
    client.listSessions = async () => [pendingInputSession];
    client.transcript = async () => load({
      session: pendingInputSession,
      pending: { approvals: [], userInputs: [{ userInputId: "q1", sessionId: "s1", turnId: "live-1", questions: [] }] },
      msp: { status: "running", activeTurnId: "live-1", modelId: "muse-spark-1.3", approvalMode: "onRequest", workspaceRoot: "/work/active-app", turnCount: 4 },
      events: [...historyEvents, { method: "turn/started", params: { turnId: "live-1" }, at: 1 }],
    });
    const { controller, stop: stopController } = await started(client);
    try {
      assert.deepStrictEqual(client.transcriptOptions, [{ refresh: true }], "the first load must not reattach an already running session");
      const thread = controller.store.get().threads["s1"];
      assert.strictEqual(thread?.load, "ready");
      assert.strictEqual(thread?.fold.activeTurnId, "live-1");
      assert.ok(thread?.fold.userInputs["q1"], "the active turn's pending question remains available");
      assert.strictEqual(client.sent.length, 0);
    } finally {
      stopController();
    }
  });

  it("loads the thread-title switch at boot and flips it with rollback", async () => {
    const client = new MockAncillaRpcClient();
    client.titleSettings = { enabled: false, modelId: "m1" };
    const { controller, stop: stopController } = await started(client);
    assert.deepStrictEqual(controller.store.get().titleSettings, { enabled: false, modelId: "m1" });

    await controller.setTitleEnabled(true);
    assert.deepStrictEqual(controller.store.get().titleSettings, { enabled: true, modelId: "m1" });

    await controller.setTitleModel(null);
    assert.deepStrictEqual(controller.store.get().titleSettings, { enabled: true, modelId: null });

    client.titleError = new Error("daemon away");
    await controller.setTitleEnabled(false);
    assert.deepStrictEqual(controller.store.get().titleSettings, { enabled: true, modelId: null }, "a failed flip rolls back");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not change thread titles/);
    stopController();
  });

  it("loads the sandbox switch at boot and flips it with rollback", async () => {
    const client = new MockAncillaRpcClient();
    client.sandboxSettings = { disabled: true };
    const { controller, stop: stopController } = await started(client);
    assert.deepStrictEqual(controller.store.get().sandboxSettings, { disabled: true });

    await controller.setSandboxDisabled(false);
    assert.deepStrictEqual(controller.store.get().sandboxSettings, { disabled: false });

    client.sandboxError = new Error("daemon away");
    await controller.setSandboxDisabled(true);
    assert.deepStrictEqual(controller.store.get().sandboxSettings, { disabled: false }, "a failed flip rolls back");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not change the sandbox setting/);
    stopController();
  });

  it("sends rapid sandbox flips to the server in order", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    try {
      const { gate: sGate, release } = createDeferredGate();
    client.sandboxGate = sGate;
      const pendingSandboxOff = controller.setSandboxDisabled(true);
      const pendingSandboxOn = controller.setSandboxDisabled(false);
      try {
        await new Promise((r) => setTimeout(r, 0));
        assert.deepStrictEqual(client.sandboxCalls, [true], "the second PATCH waits for the first");
      } finally {
        release();
      }
      await Promise.all([pendingSandboxOff, pendingSandboxOn]);
      assert.deepStrictEqual(client.sandboxCalls, [true, false]);
      assert.deepStrictEqual(client.sandboxSettings, { disabled: false }, "the server ends at the latest flip");
      assert.deepStrictEqual(controller.store.get().sandboxSettings, { disabled: false });
    } finally {
      stopController();
    }
  });

  it("clears the host error and toasts when hosts restart for the sandbox switch", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    client.handler?.({ type: "host", key: "k", state: "failed", message: "boom" });
    assert.strictEqual(controller.store.get().hostError, "boom");
    client.handler?.({ type: "host", key: "k", state: "restarted", message: "The Muse host restarted." });
    assert.strictEqual(controller.store.get().hostError, null);
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Muse hosts restarted/);
    stopController();
  });

  it("discards a stale title switch that resolves after a newer one", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    const { gate: tGate, release } = createDeferredGate();
    client.titleGate = tGate;
    const pendingTitleOff = controller.setTitleEnabled(false);
    client.titleGate = null;
    await controller.setTitleEnabled(true);
    release();
    await pendingTitleOff;
    assert.deepStrictEqual(controller.store.get().titleSettings, { enabled: true, modelId: null });
    stopController();
  });

  it("loads the YOLO switch at boot and flips it with rollback", async () => {
    const client = new MockAncillaRpcClient();
    client.yoloSettings = { enabled: true };
    const { controller, stop: stopController } = await started(client);
    assert.deepStrictEqual(controller.store.get().yoloSettings, { enabled: true });
    assert.strictEqual(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "allowAll", "boot under YOLO joins the open thread");
    assert.strictEqual(
      client.approvalModes.some((p) => p.sessionId === "s1" && p.mode === "allowAll"),
      true,
      "the join is pushed to Muse",
    );

    await controller.setYoloEnabled(false);
    assert.deepStrictEqual(controller.store.get().yoloSettings, { enabled: false });

    client.yoloError = new Error("daemon away");
    await controller.setYoloEnabled(true);
    assert.deepStrictEqual(controller.store.get().yoloSettings, { enabled: false }, "a failed flip rolls back");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not change the YOLO setting/);
    stopController();
  });

  it("sends rapid YOLO flips to the server in order", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    try {
      const { gate: yGate, release } = createDeferredGate();
    client.yoloGate = yGate;
      const pendingYoloOn = controller.setYoloEnabled(true);
      const pendingYoloOff = controller.setYoloEnabled(false);
      try {
        await new Promise((r) => setTimeout(r, 0));
        assert.deepStrictEqual(client.yoloCalls, [true], "the second PATCH waits for the first");
      } finally {
        release();
      }
      await Promise.all([pendingYoloOn, pendingYoloOff]);
      assert.deepStrictEqual(client.yoloCalls, [true, false]);
      assert.deepStrictEqual(client.yoloSettings, { enabled: false }, "the server ends at the latest flip");
      assert.deepStrictEqual(controller.store.get().yoloSettings, { enabled: false });
    } finally {
      stopController();
    }
  });

  it("moves open threads to full access on YOLO and restores them after", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    await controller.setMode("denyUnmatched");
    controller.setPrefs({ defaultMode: "promptUnmatched" });
    assert.strictEqual(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "denyUnmatched");

    await controller.setYoloEnabled(true);
    const on = controller.store.get();
    assert.strictEqual(on.prefs.defaultMode, "allowAll");
    assert.strictEqual(on.threads["s1"]?.fold.meta.approvalMode, "allowAll");
    assert.deepStrictEqual(client.approvalModes.at(-1), { sessionId: "s1", mode: "allowAll" });
    assert.strictEqual(controller.bypassArmed("s1"), true);

    await controller.setYoloEnabled(false);
    const off = controller.store.get();
    assert.strictEqual(off.prefs.defaultMode, "promptUnmatched", "the default from before arming comes back");
    assert.strictEqual(off.threads["s1"]?.fold.meta.approvalMode, "denyUnmatched", "and so does the thread's own mode");
    assert.deepStrictEqual(client.approvalModes.at(-1), { sessionId: "s1", mode: "denyUnmatched" });
    assert.strictEqual(controller.bypassArmed("s1"), false);
    stopController();
  });

  it("ignores a YOLO flip to the value it already has", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    await controller.setMode("denyUnmatched");

    await controller.setYoloEnabled(false);
    assert.deepStrictEqual(client.yoloCalls, [], "no PATCH leaves for a no-op flip");
    assert.strictEqual(controller.store.get().prefs.defaultMode, "denyUnmatched");
    assert.strictEqual(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "denyUnmatched");

    await controller.setYoloEnabled(true);
    await controller.setYoloEnabled(true);
    assert.deepStrictEqual(client.yoloCalls, [true], "the double-click enable PATCHes once");
    stopController();
  });

  it("refuses permission changes while YOLO is on", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    await controller.setYoloEnabled(true);
    const pushes = client.approvalModes.length;

    await controller.setMode("onRequest");
    assert.strictEqual(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "allowAll");
    assert.strictEqual(client.approvalModes.length, pushes, "no mode push leaves while YOLO owns the modes");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /YOLO is on/);
    stopController();
  });

  it("refuses to change the sandbox switch while YOLO is on, with a toast", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    await controller.setYoloEnabled(true);

    await controller.setSandboxDisabled(false);
    assert.deepStrictEqual(client.sandboxCalls, [], "no PATCH leaves while YOLO owns the sandbox posture");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /YOLO mode is on/);
    stopController();
  });

  it("joins a thread opened under YOLO to full access", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client, "#/");
    await controller.setYoloEnabled(true);
    await controller.loadThread("s1");
    assert.strictEqual(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "allowAll");
    assert.deepStrictEqual(client.approvalModes.at(-1), { sessionId: "s1", mode: "allowAll" });
    stopController();
  });

  it("stays silent about approvals a bypass answers on its own", async () => {
    const client = new MockAncillaRpcClient();
    const shown: string[] = [];
    const { controller, stop: stopController } = await started(client);
    attachTestNotifier(controller, shown);
    controller.setPrefs({ notifications: true });
    await controller.setYoloEnabled(true);
    emitSessionStatus(client, "s1", { pendingApprovals: 1 });
    await settleController();
    assert.deepStrictEqual(shown, [], "an armed thread answers, so nobody is needed");
    stopController();
  });

  it("clears the host error and toasts when hosts restart for the YOLO switch", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    client.handler?.({ type: "host", key: "k", state: "failed", message: "boom" });
    assert.strictEqual(controller.store.get().hostError, "boom");
    client.handler?.({ type: "host", key: "k", state: "restarted", message: "The Muse host restarted." });
    assert.strictEqual(controller.store.get().hostError, null);
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Muse hosts restarted/);
    stopController();
  });

  it("waits for the YOLO patch to land before pushing any thread's approval mode", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    const { gate: yGate, release } = createDeferredGate();
    client.yoloGate = yGate;
    const flip = controller.setYoloEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(client.approvalModes.length, 0, "no mode push leaves before the PATCH resolves");
    assert.strictEqual(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "onRequest", "the thread's own mode is untouched until then");
    release();
    await flip;
    assert.deepStrictEqual(client.approvalModes.at(-1), { sessionId: "s1", mode: "allowAll" });
    stopController();
  });

  it("pushes no approval mode when the YOLO patch itself fails", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    await controller.setMode("denyUnmatched");
    const baselineApprovalPushes = client.approvalModes.length;
    client.yoloError = new Error("daemon away");
    await controller.setYoloEnabled(true);
    assert.deepStrictEqual(controller.store.get().yoloSettings, { enabled: false });
    assert.strictEqual(controller.store.get().threads["s1"]?.fold.meta.approvalMode, "denyUnmatched", "the thread's mode never moved");
    assert.strictEqual(client.approvalModes.length, baselineApprovalPushes, "no mode push leaves for a flip that never landed");
    stopController();
  });

  it("clears the pre-YOLO snapshot when the PATCH fails, so a later enable captures a fresh one", async () => {
    const client = new MockAncillaRpcClient();
    const shared = makeSharedPrefsPlatform();
    const initialCtrl = new AncillaController(client, shared);
    const stopInitial = initialCtrl.start();
    await settleController();
    await settleController();
    await initialCtrl.setMode("denyUnmatched");
    await initialCtrl.setYoloEnabled(true);
    await settleController();
    stopInitial();

    const resumedCtrl = new AncillaController(client, shared);
    const stopResumed = resumedCtrl.start();
    await settleController();
    await settleController();
    await resumedCtrl.setYoloEnabled(false);
    assert.strictEqual(resumedCtrl.store.get().prefs.defaultMode, "denyUnmatched", "the real default survives the reload");
    assert.strictEqual(resumedCtrl.store.get().threads["s1"]?.fold.meta.approvalMode, "denyUnmatched", "and so does the thread's own mode");
    stopResumed();
  });

  it("keeps the failed-thread toast singular for exactly one thread", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    await controller.setYoloEnabled(true);
    client.approvalModeFailFor = new Set<string>(["s1"]);
    await controller.setYoloEnabled(false);
    // The mode push is fire-and-forget from setYoloEnabled's own promise, so the toast it ends in
    // lands a tick later than the flip itself.
    await flushMicrotasks();
    assert.match(controller.store.get().toasts.at(-1)?.detail ?? "", /^1 thread kept full access\.$/);
    stopController();
  });

  it("pluralizes the failed-thread toast for more than one thread", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    await controller.loadThread("s2");
    await controller.setYoloEnabled(true);
    client.approvalModeFailFor = new Set<string>(["s1", "s2"]);
    await controller.setYoloEnabled(false);
    await flushMicrotasks();
    assert.match(controller.store.get().toasts.at(-1)?.detail ?? "", /^2 threads kept full access\.$/);
    stopController();
  });

  it("refuses /permissions full while YOLO is on, without opening the confirm dialog", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    await controller.setYoloEnabled(true);
    await controller.send("/permissions full");
    assert.strictEqual(controller.store.get().picker, null, "the confirm dialog never opens");
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /YOLO is on/);
    stopController();
  });

  it("still announces a rule-only approval even while a bypass is armed", async () => {
    const client = new MockAncillaRpcClient();
    const shown: string[] = [];
    const { controller, stop: stopController } = await started(client);
    attachTestNotifier(controller, shown);
    controller.setPrefs({ notifications: true });
    await controller.setYoloEnabled(true);
    // A rule-only choice gives autoAllow nothing to click, so it stays pending for the user.
    client.handler?.({
      at: 1,
      type: "msp" as const,
      sessionId: "s1",
      method: "approval/requested" as const,
      params: {
        sessionId: "s1",
        approvalId: "a1",
        subject: { kind: "shell" },
        availableChoices: [{ choiceId: "c1", label: "Always allow", decision: "approved", scope: "rule", rulePreview: "echo *" }],
      },
    });
    await settleController();
    emitSessionStatus(client, "s1", { pendingApprovals: 1 });
    await settleController();
    assert.deepStrictEqual(shown, ["approval:s1"], "a rule-only approval still needs the user, even armed");
    stopController();
  });

  it("keeps stream events that arrive while a thread is still loading", async () => {
    const client = new MockAncillaRpcClient();
    let resolve: (value: TranscriptLoad) => void = () => {};
    client.transcript = () => new Promise((r) => (resolve = r));
    const { controller, stop: stopController } = await started(client);
    client.handler?.({ type: "msp", sessionId: "s1", method: "turn/started", params: { sessionId: "s1", turnId: "live-1" }, at: 1 });
    resolve(load());
    await settleController();
    assert.strictEqual(controller.store.get().threads["s1"]?.fold.activeTurnId, "live-1");
    stopController();
  });

  it("coalesces overlapping thread loads instead of losing buffered events", async () => {
    // A second load while one is in flight used to orphan the first load's buffer: every event
    // that streamed into it was dropped, and the thread never showed them (#32).
    const client = new MockAncillaRpcClient();
    let threadLoads = 0;
    let resolvePendingLoad!: (value: TranscriptLoad) => void;
    client.transcript = () => {
      threadLoads++;
      return new Promise<TranscriptLoad>((r) => { resolvePendingLoad = r; });
    };
    const { controller, stop: stopController } = await started(client);
    client.handler?.({ at: 1, type: "msp", sessionId: "s1", method: "turn/started", params: { sessionId: "s1", turnId: "live-1" } });
    const secondaryLoad = controller.loadThread("s1");
    client.handler?.({
      at: 2,
      type: "msp",
      sessionId: "s1",
      method: "item/started",
      params: { sessionId: "s1", item: { revision: 1, itemId: "i1", kind: "agentMessage", status: "inProgress" } },
    });
    resolvePendingLoad(load());
    await settleController();
    await settleController();
    await secondaryLoad;
    assert.strictEqual(threadLoads, 1, "overlapping loads share one transcript read");
    const fold = controller.store.get().threads["s1"]?.fold;
    assert.strictEqual(fold?.activeTurnId, "live-1", "events buffered before the overlap still land");
    assert.ok(fold?.items["i1"], "events buffered during the overlap still land");
    stopController();
  });

  it("rereads a background thread that missed a dropped stream when it is opened, so a finished agent stops working", async () => {
    const client = new MockAncillaRpcClient();
    const altSession: SessionSummary = { ...SESSION, sessionId: "s2", title: "Other" };
    client.listSessions = async () => [SESSION, altSession];
    const makeWfEvent = (rev: number, st: string, childPatch: Record<string, unknown>): ViewEvent => ({
      method: "item/updated",
      params: {
        item: {
          itemId: "wf-1",
          kind: "workflow",
          revision: rev,
          status: st,
          turnId: "t1",
          workflowRunId: "run-1",
          children: [{ childId: "c1", attempt: 1, label: "bg-reader", ...childPatch }],
        },
      },
    });
    const workflow = makeWfEvent;
    // The lead turn ended; its workflow child carries on in the background.
    let recordedEvents: ViewEvent[] = [
      { method: "turn/started", params: { turnId: "t1" } },
      workflow(1, "inProgress", { status: "started" }),
      { method: "turn/completed", params: { turnId: "t1", terminal: "completed" } },
    ];
    const recordedCalls: Array<[string, { refresh?: boolean } | undefined]> = [];
    client.loadTranscript = async (sessionId: string, options?: { refresh?: boolean }) => {
      recordedCalls.push([sessionId, options]);
      return load({ session: sessionId === "s1" ? SESSION : altSession, events: sessionId === "s1" ? recordedEvents : [] });
    };
    const { controller, stop: stopController } = await started(client);
    const working = () => crewView(controller.store.get().threads.s1!.fold, SESSION, Date.now()).runs[0]?.counts.working;
    try {
      assert.strictEqual(working(), 1);
      controller.openThread("s2");
      await settleController();
      // The child finishes while the stream is down, and nothing replays that.
      recordedEvents = [...recordedEvents, workflow(2, "completed", { status: "terminal", terminal: "completed" })];
      recordedCalls.length = 0;
      client.handler?.({ type: "connection", state: "lost" });
      client.handler?.({ type: "hello", version: "x" });
      await settleController();
      assert.deepStrictEqual(recordedCalls, [["s2", undefined]], "the open thread reloads at once");
      assert.strictEqual(controller.store.get().threads.s1?.stale, true, "the other shows what it has as last known");
      assert.notEqual(controller.store.get().threads.s2?.stale, true);
      controller.openThread("s1");
      await settleController();
      await flushMicrotasks();
      assert.deepStrictEqual(recordedCalls.at(-1), ["s1", { refresh: true }], "the other on opening, read in place while its agent may run");
      assert.strictEqual(working(), 0);
      assert.notEqual(controller.store.get().threads.s1?.stale, true, "and is live again once read");
      controller.openThread("s2");
      controller.openThread("s1");
      await flushMicrotasks();
      assert.strictEqual(recordedCalls.length, 2, "once reread, it is not read again on every visit");
    } finally {
      stopController();
    }
  });

  it("echoes a sent prompt, marks the turn running, then drops the echo", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(await controller.send("Add a README section"), true);
    let fold = controller.store.get().threads["s1"]!.fold;
    assert.strictEqual(fold.activeTurnId, "t9");
    assert.strictEqual(fold.echoes[0]?.turnId, "t9");
    client.handler?.({
      at: 2,
      type: "msp",
      sessionId: "s1",
      method: "item/completed",
      params: { sessionId: "s1", item: { revision: 1, itemId: "u9", kind: "userMessage", status: "completed", text: "Add a README section", turnId: "t9" } },
    });
    await settleController();
    fold = controller.store.get().threads["s1"]!.fold;
    assert.strictEqual(fold.echoes.length, 0);
    stopController();
  });

  it("queues follow-ups while a turn runs and steers on request", async () => {
    const client = new MockAncillaRpcClient();
    client.transcript = async () => load({ msp: { status: "running", activeTurnId: "t1", modelId: null, approvalMode: null, workspaceRoot: null, turnCount: 3 } });
    client.sendResult = async () => ({ turnId: "t2", disposition: "queued" });
    const { controller, stop: stopController } = await started(client);
    await controller.send("next thing");
    assert.strictEqual(client.sent.at(-1)?.ifBusy, "queue");
    assert.strictEqual(controller.store.get().threads["s1"]!.fold.echoes[0]?.disposition, "queued");
    client.sendResult = async () => ({ turnId: "t1", disposition: "steered" });
    await controller.send("actually use tabs", { steer: true });
    assert.strictEqual(client.sent.at(-1)?.ifBusy, "steer");
    stopController();
  });

  it("turns a double-pressed Enter into one send, and the duplicate still reports sent", async () => {
    const client = new MockAncillaRpcClient();
    const releases: ((ack: { turnId: string | null; disposition: string | null }) => void)[] = [];
    client.sendResult = () => new Promise((resolve) => {
      releases.push(resolve);
    });
    const { controller, stop: stopController } = await started(client);
    // Both arrive before either is acknowledged, the way two Enters land before the composer clears.
    const first = controller.send("check the vault");
    const second = controller.send("check the vault");
    releases.forEach((release, index) => release({ turnId: `t${9 + index}`, disposition: "started" }));
    assert.deepStrictEqual(await Promise.all([first, second]), [true, true]);
    assert.strictEqual(client.sent.length, 1);
    assert.strictEqual(controller.store.get().threads["s1"]!.fold.echoes.length, 1);
    stopController();
  });

  it("lets the same prompt go again once the first send settles", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(await controller.send("check the vault"), true);
    assert.strictEqual(await controller.send("check the vault"), true);
    assert.strictEqual(client.sent.length, 2);
    stopController();
  });

  it("lets a different prompt go while one is still in flight", async () => {
    const client = new MockAncillaRpcClient();
    const releases: ((ack: { turnId: string | null; disposition: string | null }) => void)[] = [];
    client.sendResult = () => new Promise((resolve) => {
      releases.push(resolve);
    });
    const { controller, stop: stopController } = await started(client);
    const first = controller.send("check the vault");
    const second = controller.send("and the firewall rules");
    releases.forEach((release, index) => release({ turnId: `t${9 + index}`, disposition: "started" }));
    assert.deepStrictEqual(await Promise.all([first, second]), [true, true]);
    assert.strictEqual(client.sent.length, 2);
    stopController();
  });

  it("releases the guard when the first send fails, so a retry goes", async () => {
    const client = new MockAncillaRpcClient();
    client.sendResult = async () => {
      throw new AncillaError("turn rejected", 409, "turnRejected");
    };
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(await controller.send("check the vault"), false);
    client.sendResult = async () => ({ turnId: "t9", disposition: "started" });
    assert.strictEqual(await controller.send("check the vault"), true);
    assert.strictEqual(client.sent.length, 2);
    stopController();
  });

  it("sends identical text with identical files once, but new files go", async () => {
    const client = new MockAncillaRpcClient();
    const releases: ((ack: { turnId: string | null; disposition: string | null }) => void)[] = [];
    client.sendResult = () => new Promise((resolve) => {
      releases.push(resolve);
    });
    const { controller, stop: stopController } = await started(client);
    const shot = { name: "shot.png", mediaType: "image/png", base64: "AAAA" };
    const other = { name: "other.png", mediaType: "image/png", base64: "BBBB" };
    const pSend1 = controller.send("look at this", { attachments: [shot] });
    const pSendDup = controller.send("look at this", { attachments: [{ ...shot }] });
    const pSendOther = controller.send("look at this", { attachments: [other] });
    releases.forEach((release, index) => release({ turnId: `t${9 + index}`, disposition: "started" }));
    assert.deepStrictEqual(await Promise.all([pSend1, pSendDup, pSendOther]), [true, true, true]);
    assert.strictEqual(client.sent.length, 2);
    stopController();
  });

  it("reports a failed send and hands the text back", async () => {
    const client = new MockAncillaRpcClient();
    client.sendResult = async () => {
      throw new AncillaError("input too large", 409, "inputTooLarge");
    };
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(await controller.send("x".repeat(10)), false);
    const state = controller.store.get();
    assert.strictEqual(state.threads["s1"]!.fold.echoes.length, 0);
    assert.strictEqual(state.toasts.at(-1)?.title, "Message not sent");
    stopController();
  });

  it("gives a failed first prompt to the new thread's composer", async () => {
    const client = new MockAncillaRpcClient();
    client.sendResult = async () => {
      throw new AncillaError("turn rejected", 409, "turnRejected");
    };
    const { controller, stop: stopController } = await started(client, "");
    // The new-thread composer unmounts on navigation, so it must not take the text back itself.
    assert.strictEqual(await controller.send("Write the tests"), true);
    const state = controller.store.get();
    assert.deepStrictEqual(state.route, { kind: "thread", sessionId: "s1" });
    assert.strictEqual(state.toasts.at(-1)?.title, "Message not sent");
    assert.strictEqual(controller.takeDraftHandoff("other"), null);
    assert.deepStrictEqual(controller.takeDraftHandoff("s1"), { text: "Write the tests" });
    assert.strictEqual(controller.store.get().draftHandoff, null);
    stopController();
  });

  it("hands the files back with the prompt when a first send fails", async () => {
    const client = new MockAncillaRpcClient();
    client.sendResult = async () => {
      throw new AncillaError("turn rejected", 409, "turnRejected");
    };
    const { controller, stop: stopController } = await started(client, "");
    const attachments = [{ name: "shot.png", mediaType: "image/png", base64: "AAAA" }];
    const previews = [{ name: "shot.png", mediaType: "image/png", kind: "image" as const, url: "blob:shot" }];
    assert.strictEqual(await controller.send("Look at this", { attachments, previews }), true);
    // Text alone would hand back a draft asking about an image that is no longer attached to it.
    assert.deepStrictEqual(controller.takeDraftHandoff("s1"), { text: "Look at this", attachments, previews });
    stopController();
  });

  it("answers approvals itself once a thread is armed, taking allow-once over a rule", async () => {
    const client = new MockAncillaRpcClient();
    const request = {
      sessionId: "s1",
      approvalId: "ap1",
      currentRequirementId: null,
      subject: { kind: "command", command: "git rebase --continue" },
      availableChoices: [
        { choiceId: "remember", decision: "approved", label: "Allow and remember", rulePreview: "git rebase *", scope: "session" },
        { choiceId: "once", decision: "approved", label: "Allow once", scope: "once" },
        { choiceId: "no", decision: "denied", label: "Reject", scope: "once" },
      ],
    };
    client.transcript = async () => load({ pending: { approvals: [request], userInputs: [] } });
    const { controller, stop: stopController } = await started(client);
    // Nothing is armed yet, so the request waits for the user.
    assert.strictEqual(Object.keys(controller.store.get().threads["s1"]!.fold.approvals).length, 1);
    assert.strictEqual(client.decided.length, 0);

    controller.setThreadBypass("s1", true);
    await settleController();
    // The remembered choice would write a standing rule into Muse's own config, so it takes the plain one.
    assert.deepStrictEqual(client.decided, [{ approvalId: "ap1", choiceId: "once" }]);
    const fold = controller.store.get().threads["s1"]!.fold;
    assert.strictEqual(fold.approvals["ap1"], undefined);
    assert.strictEqual(fold.resolved["ap1"]?.resolvedBy, "bypass");
    stopController();
  });

  it("leaves an approval alone when the only way to allow it writes a rule", async () => {
    const client = new MockAncillaRpcClient();
    const request = {
      sessionId: "s1",
      approvalId: "ap2",
      currentRequirementId: null,
      subject: { kind: "command", command: "rm -rf /tmp/scratch" },
      availableChoices: [
        { choiceId: "remember", decision: "approved", label: "Allow and remember", rulePreview: "rm *", scope: "session" },
        { choiceId: "no", decision: "denied", label: "Reject", scope: "once" },
      ],
    };
    client.transcript = async () => load({ pending: { approvals: [request], userInputs: [] } });
    const { controller, stop: stopController } = await started(client);
    controller.setThreadBypass("s1", true);
    await settleController();
    // That rule would outlive the bypass that wrote it, which is the one thing it promises not to do.
    assert.deepStrictEqual(client.decided, []);
    assert.strictEqual(Object.keys(controller.store.get().threads["s1"]!.fold.approvals).length, 1);
    stopController();
  });

  it("keeps closed dock cards out until the thread brings them back", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    const hidden = () => controller.store.get().prefs.hiddenCards;
    assert.deepStrictEqual(hidden(), []);
    controller.setCardHidden("plan:s1", true);
    controller.setCardHidden("goal:s1", true);
    controller.setCardHidden("plan:s2", true);
    controller.setCardHidden("plan:s1", Boolean(true));
    assert.deepStrictEqual(hidden(), ["plan:s1", "goal:s1", "plan:s2"]);
    // Bringing one thread's cards back leaves another thread's alone.
    controller.showThreadCards("s1");
    assert.deepStrictEqual(hidden(), ["plan:s2"]);
    controller.setCardHidden("plan:s2", false);
    assert.deepStrictEqual(hidden(), []);
    stopController();
  });

  it("remembers which dock cards a thread had folded away", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    const collapsed = () => controller.store.get().prefs.collapsedCards;
    // Open by default, so a thread nobody has touched costs nothing to remember.
    assert.deepStrictEqual(collapsed(), []);

    controller.setCardOpen("goal:s1", false);
    assert.deepStrictEqual(collapsed(), ["goal:s1"]);

    // Another thread's card is its own business.
    controller.setCardOpen("goal:s2", false);
    assert.deepStrictEqual(collapsed(), ["goal:s1", "goal:s2"]);

    // Opening one again drops it rather than recording a second state for it.
    controller.setCardOpen("goal:s1", true);
    assert.deepStrictEqual(collapsed(), ["goal:s2"]);

    // Closing one that is already closed leaves the list alone.
    controller.setCardOpen("goal:s2", false);
    assert.deepStrictEqual(collapsed(), ["goal:s2"]);
    stopController();
  });

  it("remembers which run and plan cards a thread had opened, since they rest as a glance", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    const opened = () => controller.store.get().prefs.openCards;
    // Shut by default, so a thread nobody has touched costs nothing to remember.
    assert.deepStrictEqual(opened(), []);

    controller.setCardExpanded("crew:s1", true);
    controller.setCardExpanded("plan:s1", true);
    assert.deepStrictEqual(opened(), ["crew:s1", "plan:s1"]);

    // Opening one that is open leaves the list alone; shutting one drops it rather than recording a second state.
    controller.setCardExpanded("crew:s1", true);
    assert.deepStrictEqual(opened(), ["crew:s1", "plan:s1"]);
    controller.setCardExpanded("crew:s1", false);
    assert.deepStrictEqual(opened(), ["plan:s1"]);
    controller.setCardExpanded("crew:s1", false);
    assert.deepStrictEqual(opened(), ["plan:s1"]);

    // The oldest are forgotten past a few hundred threads.
    for (let i = 0; i < 305; i += 1) controller.setCardExpanded(`crew:t${i}`, true);
    assert.strictEqual(opened().length, 300);
    assert.strictEqual(opened().at(-1), "crew:t304");
    stopController();
  });

  it("announces the edges of what a thread is doing, not the state it is sitting in", async () => {
    const client = new MockAncillaRpcClient();
    const shown: string[] = [];
    const { controller, stop: stopController } = await started(client);
    attachTestNotifier(controller, shown);
    controller.setPrefs({ notifications: true });
    const makeLiveState = (delta: Record<string, unknown>) => ({
      pendingApprovals: 0,
      pendingInputs: 0,
      activeTurnId: null,
      turnStartedAt: null,
      lastTerminal: null,
      lastError: null,
      ...delta,
    });
    const emitStatusDelta = async (delta: Record<string, unknown>) => {
      client.handler?.({ type: "session-status", sessionId: "s1", live: makeLiveState(delta) as never });
      await settleController();
    };

    // A request that has just appeared is worth saying.
    await emitStatusDelta({ pendingApprovals: 1 });
    assert.deepStrictEqual(shown, ["approval:s1"]);

    // The same request still sitting there is not: it was already announced once.
    await emitStatusDelta({ pendingApprovals: 1 });
    assert.deepStrictEqual(shown, ["approval:s1"]);

    // A turn that has just ended is an edge too, and carries whether it failed.
    await emitStatusDelta({ activeTurnId: "t1" });
    await emitStatusDelta({ lastTerminal: "failed", lastError: "boom" });
    assert.deepStrictEqual(shown, ["approval:s1", "finished:s1"]);

    // A goal going quiet says so; a goal still active says nothing.
    await emitStatusDelta({ goal: { objective: "ship", status: "active", percentComplete: 10 } });
    assert.deepStrictEqual(shown, ["approval:s1", "finished:s1"]);
    await emitStatusDelta({ goal: { objective: "ship", status: "complete", percentComplete: 100 } });
    assert.deepStrictEqual(shown, ["approval:s1", "finished:s1", "goal:s1"]);
    stopController();
  });

  it("marks a read-only thread and refuses to send into it", async () => {
    const client = new MockAncillaRpcClient();
    client.transcript = async () => load({ readOnly: true, readOnlyReason: "session is loaded by another host" });
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(controller.store.get().threads["s1"]?.readOnly, true);
    assert.strictEqual(await controller.send("hello"), false);
    assert.strictEqual(client.sent.length, 0);
    stopController();
  });

  /**
   * The server's side of loading: a resume attaches the session to one of its hosts, a read in place never does, and
   * a read of a session none of its hosts holds comes back read-only with no reason given.
   */
  function hostLike(client: MockAncillaRpcClient): { hosted: boolean } {
    const host = { hosted: false };
    client.loadTranscript = async (_targetSessionId: string, opts?: { refresh?: boolean }) => {
      client.transcriptOptions.push(opts);
      if (opts?.refresh) {
        return load({ readOnly: Boolean(!host.hosted), readOnlyReason: null });
      }
      host.hosted = Boolean(true);
      return load({});
    };
    client.sendResult = async () => {
      if (!host.hosted) {
        throw new AncillaError("Session is not loaded", 409, "sessionNotLoaded");
      }
      return { turnId: "t9", disposition: "started" as const };
    };
    return host;
  }

  it("resumes a session its host unloaded when a send is refused, rather than reading it back read-only", async () => {
    const client = new MockAncillaRpcClient();
    const host = hostLike(client);
    const { controller, stop: stopController } = await started(client);
    try {
      assert.strictEqual(host.hosted, true, "opening an idle thread resumes it");
      // Muse idles the session out, so the server forgets which host had it.
      host.hosted = false;
      client.handler?.({ type: "msp", sessionId: "s1", method: "session/closed", params: {}, at: 1 });
      controller.flush();
      assert.strictEqual(controller.store.get().threads["s1"]?.fold.closed, true);
      assert.strictEqual(await controller.send("hello again"), true);
      assert.deepStrictEqual(client.transcriptOptions, [undefined, undefined], "the refused send resumes instead of reading");
      assert.strictEqual(client.sent.length, 2, "the prompt the host refused goes once more, and only once");
      assert.strictEqual(controller.store.get().threads["s1"]?.readOnly, false);
      // The hosts restart for a settings change, which drops the binding again.
      host.hosted = false;
      client.handler?.({ type: "host", key: "k", state: "restarted", message: "restarted" });
      await settleController();
      assert.strictEqual(await controller.send("and again"), true);
      assert.strictEqual(client.sent.length, 4);
      assert.strictEqual(controller.store.get().threads["s1"]?.readOnly, false);
    } finally {
      stopController();
    }
  });

  it("resumes an idle session on reload even after a recovery was recorded for it, so Take over works", async () => {
    const client = new MockAncillaRpcClient();
    const host = hostLike(client);
    const { controller, stop: stopController } = await started(client);
    try {
      await controller.retryStalledThread("s1");
      host.hosted = false;
      client.handler?.({ type: "msp" as const, sessionId: "s1", method: "session/closed" as const, params: {}, at: 1 });
      controller.flush();
      await controller.loadThread("s1");
      assert.deepStrictEqual(client.transcriptOptions, [undefined, undefined, undefined], "an idle thread is never read in place");
      assert.strictEqual(controller.store.get().threads["s1"]?.readOnly, false);
      assert.strictEqual(host.hosted, true);
    } finally {
      stopController();
    }
  });

  it("keeps the composer open when a read in place reports read-only without saying why", async () => {
    const client = new MockAncillaRpcClient();
    const readOnlySession: SessionSummary = {
      ...SESSION,
      live: { activeTurnId: "live-1", pendingApprovals: 0, pendingInputs: 0, turnStartedAt: null, lastTerminal: null, lastError: null },
    };
    client.listSessions = async () => [readOnlySession];
    const makeRunningLoad = (isReadOnly: boolean, reasonStr: string | null): TranscriptLoad => load({
      session: readOnlySession,
      msp: { status: "running", activeTurnId: "live-1", modelId: "muse-spark-1.3", approvalMode: "onRequest", workspaceRoot: "/work/active-app", turnCount: 4 },
      events: [...historyEvents, { method: "turn/started", params: { turnId: "live-1" }, at: 1 }],
      readOnly: isReadOnly,
      readOnlyReason: reasonStr,
    });
    const running = makeRunningLoad;
    // A fresh page reads the running session in place; a server with no host of its own for it says so, bare.
    client.transcript = async () => running(true, null);
    const { controller, stop: stopController } = await started(client);
    try {
      assert.deepStrictEqual(client.transcriptOptions, [{ refresh: true }]);
      assert.strictEqual(controller.store.get().threads["s1"]?.readOnly, false, "a bare flag from a read is the server not knowing");
      await controller.loadThread("s1");
      assert.strictEqual(controller.store.get().threads["s1"]?.readOnly, false);
      // Another client holding the session is a reason, and that still locks the composer.
      client.transcript = async () => running(true, "Another Muse session has it open.");
      await controller.loadThread("s1");
      assert.strictEqual(controller.store.get().threads["s1"]?.readOnly, true);
      assert.strictEqual(controller.store.get().threads["s1"]?.readOnlyReason, "Another Muse session has it open.");
      assert.strictEqual(await controller.send("hello"), false);
      assert.strictEqual(client.sent.length, 0);
    } finally {
      stopController();
    }
  });

  it("runs slash commands, skills and shell lines instead of sending their text", async () => {
    const client = new MockAncillaRpcClient();
    client.skills = [
      { id: "bundled:plan", name: "plan", displayName: "plan", description: "Plan it.", shortDescription: null, scope: "bundled", activation: "on" },
      { id: "user:secret", name: "secret", displayName: "secret", description: "By hand.", shortDescription: null, scope: "user", activation: "user-invocable-only" },
    ];
    const { controller, stop: stopController } = await started(client);
    await controller.loadSkills("/work/app");
    assert.strictEqual(controller.store.get().skills["/work/app"]?.status, "ready");

    assert.strictEqual(await controller.send("/plan tidy the API"), true);
    assert.strictEqual(client.sent.at(-1)?.displayText, "/plan tidy the API", "the transcript shows what was typed");
    assert.match(client.sent.at(-1)?.text ?? "", /read_skill with name "bundled:plan" first, then apply it to: tidy the API$/);
    assert.strictEqual(await controller.send("/secret go"), true);
    assert.match(client.sent.at(-1)?.text ?? "", /<skill-body id="user:secret">\nInstructions for user:secret\.\n<\/skill-body>\n\ngo$/);

    assert.strictEqual(await controller.send("/compact"), true);
    assert.strictEqual(await controller.send("! git status"), true);
    assert.deepStrictEqual(client.actions, ["compact", "shell-proxy:git status"], "Ancilla runs `!` itself now");
    client.compactNoop = true;
    assert.strictEqual(await controller.send("/compact"), true);
    assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Nothing to compact yet");
    assert.strictEqual(controller.store.get().toasts.at(-1)?.detail, "There is no earlier history to summarize.");

    assert.strictEqual(await controller.send("/effort high"), true);
    assert.strictEqual(controller.store.get().prefs.effort, "high");
    assert.strictEqual(await controller.send("/model"), true);
    assert.strictEqual(controller.store.get().picker, "model");
    assert.strictEqual(await controller.send("/permissions full"), true);
    assert.strictEqual(controller.store.get().picker, "confirmFullAccess", "full access still asks first");
    controller.closePicker("permissions");
    assert.strictEqual(controller.store.get().picker, "confirmFullAccess", "a menu closing after the hand-off leaves the dialog open");

    const before = client.sent.length;
    assert.strictEqual(await controller.send("/deploy now"), false);
    assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "No command named /deploy");
    assert.strictEqual(client.sent.length, before);
    assert.strictEqual(await controller.send("/deploy now", { raw: true }), true);
    assert.strictEqual(client.sent.at(-1)?.text, "/deploy now");
    assert.strictEqual(await controller.send("/usr/bin/node crashes on start"), true, "a path is a prompt, not a command");
    assert.strictEqual(client.sent.at(-1)?.text, "/usr/bin/node crashes on start");
    stopController();
  });

  it("waits for a workspace's skills when a skill is sent before they load", async () => {
    const client = new MockAncillaRpcClient();
    client.skills = [
      { id: "bundled:git", name: "git", displayName: "git", description: "Git safety.", shortDescription: null, scope: "bundled", activation: "on" },
    ];
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(controller.store.get().skills["/work/app"], undefined);
    assert.strictEqual(await controller.send("/git reply ok"), true);
    assert.strictEqual(client.sent.at(-1)?.displayText, "/git reply ok");
    assert.strictEqual(controller.store.get().skills["/work/app"]?.status, "ready");
    stopController();
  });

  it("sets, pauses, resumes and clears goals through Muse's goal commands", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(await controller.send("/goal Ship the release"), true);
    assert.deepStrictEqual(client.actions.at(-1), "goal:s1:set:Ship the release");
    assert.strictEqual(client.sent.length, 0, "no prompt goes to the model: the goal command starts the work");
    assert.strictEqual(await controller.send("/goal pause"), true);
    assert.strictEqual(client.actions.at(-1), "goal:s1:pause");
    assert.strictEqual(await controller.send("/goal Clear"), true, "the verbs are not case-sensitive");
    assert.strictEqual(client.actions.at(-1), "goal:s1:clear");

    assert.strictEqual(await controller.send("/goal"), false);
    assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Add the goal after /goal");

    // A paused goal resumes through goal/resume; a blocked one still gets a prompt to keep going.
    assert.strictEqual(await controller.continueGoal("s1", "Ship the release", "paused"), true);
    assert.strictEqual(client.actions.at(-1), "goal:s1:resume");
    assert.strictEqual(await controller.continueGoal("s1", "Ship the release", "blocked"), true);
    assert.strictEqual(client.sent.at(-1)?.displayText, "Keep working on the goal");

    assert.strictEqual(await controller.goalAction("s1", "edit", "Ship 0.11"), true);
    assert.strictEqual(client.actions.at(-1), "goal:s1:edit:Ship 0.11");
    stopController();
  });

  it("falls back to asking the model for a goal on a host without goal commands", async () => {
    const client = new MockAncillaRpcClient();
    client.goalError = new AncillaError("no such method", 409, "methodNotFound");
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(await controller.send("/goal Ship the release"), true);
    assert.strictEqual(client.sent.at(-1)?.displayText, "/goal Ship the release");
    assert.match(client.sent.at(-1)?.text ?? "", /create_goal tool\. Objective: Ship the release/);

    client.goalError = new AncillaError("goal is finished", 409, "goalNotPaused");
    assert.strictEqual(await controller.goalAction("s1", "pause"), false);
    assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Could not pause the goal");
    stopController();
  });

  it("puts the open thread on the chosen effort, and leaves it be on auto", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(await controller.send("/effort low"), true);
    await settleController();
    assert.deepStrictEqual(client.efforts, ["s1:low"]);
    controller.setEffort(null);
    await settleController();
    assert.deepStrictEqual(client.efforts, ["s1:low"], "auto keeps the thread's own level");
    assert.strictEqual(controller.store.get().prefs.effort, null);
    stopController();
  });

  it("controls background tasks, subagents and workflow children", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(await controller.taskAction("s1", "background", "item-2"), true);
    assert.strictEqual(await controller.taskAction("s1", "stop", "item-2"), true);
    assert.strictEqual(await controller.taskAction("s1", "stopAll"), true);
    assert.strictEqual(await controller.subagentAction("s1", "sendMessage", "sa1", "use pnpm"), true);
    assert.strictEqual(await controller.workflowAction("s1", "retry", "run-1", { childId: "c1", attempt: 2 }), true);
    assert.deepStrictEqual(client.actions, [
      "task:s1:background:item-2",
      "task:s1:stop:item-2",
      "task:s1:stopAll",
      ("subagent:s1:sendMessage:sa1:use pnpm" as const),
      "workflow:s1:retry:run-1:c1@2",
    ]);

    client.workflowError = new AncillaError("stale attempt", 409, "stale_attempt");
    assert.strictEqual(await controller.workflowAction("s1", "skip", "run-1", { childId: "c1", attempt: 1 }), false);
    assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "That agent already moved on");
    stopController();
  });

  it("keeps the newest plan usage from boot and from the event stream", async () => {
    const client = new MockAncillaRpcClient();
    const reading = (percent: number, at: number) => ({
      tier: "high",
      observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: at + 1, windowDurationMins: 5 * 60 },
      weekly: { usedPercent: 3, resetsAtMs: at + 2, windowDurationMins: null },
    });
    client.plan = reading(20, 100);
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(controller.store.get().planUsage?.window.usedPercent, 20);
    client.handler?.({ type: "plan-usage", usage: reading(35, 200), accountId: null });
    assert.strictEqual(controller.store.get().planUsage?.window.usedPercent, 35);
    client.handler?.({ type: "plan-usage", usage: reading(1, 150), accountId: null });
    assert.strictEqual(controller.store.get().planUsage?.window.usedPercent, 35, "an older reading does not replace a newer one");
    stopController();
  });

  it("keeps subscription source and saved state, and removes invalidated account readings", async () => {
    const client = new MockAncillaRpcClient();
    client.plan = { tier: "high", observedAtMs: 200,
      window: { usedPercent: 125, resetsAtMs: 500, windowDurationMins: 300 },
      weekly: { usedPercent: 4, resetsAtMs: 900, windowDurationMins: null } };
    client.planByAccount = { work: client.plan };
    client.planMetadata = { accountId: "work", saved: true, status: "no-host" };
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(controller.store.get().planUsageAccountId, "work");
    assert.strictEqual(controller.store.get().planUsageSaved, true);
    assert.strictEqual(controller.store.get().planUsageStatus, "no-host");
    assert.strictEqual(controller.store.get().planUsageLoading, false);
    client.planError = new Error("offline");
    await controller.loadPlanUsage();
    assert.strictEqual(controller.store.get().planUsageStatus, "unavailable");
    assert.strictEqual(controller.store.get().planUsage?.window.usedPercent, 125, "a failed refresh retains the last observation");
    client.planError = null;
    client.plan = null;
    client.planByAccount = {};
    client.planMetadata = { accountId: null, saved: false, status: "no-host" };
    await controller.loadPlanUsage();
    assert.strictEqual(controller.store.get().planUsage, null, "a login change can invalidate a saved observation");
    assert.deepStrictEqual(controller.store.get().planUsageByAccount, {});
    assert.strictEqual(controller.store.get().planUsageSaved, false);
    stopController();
  });

  it("does not let a delayed subscription refresh relabel a newer live reading as saved or unavailable", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
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
    assert.strictEqual(controller.store.get().planUsage?.window.usedPercent, 45);
    assert.strictEqual(controller.store.get().planUsageAccountId, "personal");
    assert.strictEqual(controller.store.get().planUsageSaved, false);
    assert.strictEqual(controller.store.get().planUsageStatus, "ready");
    assert.deepStrictEqual(controller.store.get().planUsageSavedAccounts, ["work"], "the older account reading still carries its saved provenance");
    assert.strictEqual(controller.store.get().planUsageLoading, false);
    stopController();
  });

  it("keeps per-account plan usage from the event stream, and still keeps the global reading", async () => {
    const client = new MockAncillaRpcClient();
    const reading = (percent: number, at: number) => ({
      tier: "high",
      observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: at + 1, windowDurationMins: 5 * 60 },
      weekly: { usedPercent: 3, resetsAtMs: at + 2, windowDurationMins: null },
    });
    const { controller, stop: stopController } = await started(client);
    client.handler?.({ type: "plan-usage", usage: reading(40, 300), accountId: "work" });
    assert.strictEqual(controller.store.get().planUsageByAccount["work"]?.window.usedPercent, 40);
    assert.strictEqual(controller.store.get().planUsage?.window.usedPercent, 40, "a per-account reading still updates the global");
    client.handler?.({ type: "plan-usage", usage: reading(10, 250), accountId: "work" });
    assert.strictEqual(
      controller.store.get().planUsageByAccount["work"]?.window.usedPercent,
      40,
      "an older per-account reading does not replace a newer one",
    );
    stopController();
  });

  it("merges per-account plan usage from the boot load", async () => {
    const client = new MockAncillaRpcClient();
    client.planByAccount = {
      work: {
        tier: "high" as const,
        observedAtMs: 500,
        window: { usedPercent: 60, resetsAtMs: 501, windowDurationMins: 300 },
        weekly: { usedPercent: 5, resetsAtMs: 502, windowDurationMins: null },
      },
    };
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(controller.store.get().planUsageByAccount["work"]?.window.usedPercent, 60);
    stopController();
  });

  it("does not let a stale boot-load snapshot clobber a fresher per-account reading", async () => {
    const client = new MockAncillaRpcClient();
    const reading = (percent: number, at: number) => ({
      tier: "high",
      observedAtMs: at,
      window: { usedPercent: percent, resetsAtMs: at + 1, windowDurationMins: 5 * 60 },
      weekly: { usedPercent: 3, resetsAtMs: at + 2, windowDurationMins: null },
    });
    const { controller, stop: stopController } = await started(client);
    client.handler?.({ type: "plan-usage", usage: reading(77, 200), accountId: "work" });
    assert.strictEqual(controller.store.get().planUsageByAccount["work"]?.window.usedPercent, 77);
    client.planByAccount = { work: reading(10, 100) };
    await controller.loadPlanUsage();
    assert.strictEqual(
      controller.store.get().planUsageByAccount["work"]?.window.usedPercent,
      77,
      "a stale byAccount snapshot from a boot GET does not replace a newer event-derived reading",
    );
    assert.strictEqual(controller.store.get().planUsageAccounts.find((entry) => entry.accountId === "work")?.usage?.window.usedPercent, 77);
    stopController();
  });

  it("keeps the default subscription separate from a newer named account and retains explicit selection", async () => {
    const client = new MockAncillaRpcClient();
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
    const { controller, stop: stopController } = await started(client);
    controller.selectPlanUsageAccount(null);
    client.handler?.({ type: "plan-usage", usage: reading(18, 150), accountId: null });
    client.handler?.({ type: "plan-usage", usage: reading(88, 250), accountId: "work" });
    assert.strictEqual(controller.store.get().planUsageSelectedAccountId, null);
    const records = controller.store.get().planUsageAccounts;
    assert.strictEqual(records.find((entry) => entry.accountId === null)?.usage?.window.usedPercent, 18);
    assert.strictEqual(records.find((entry) => entry.accountId === "work")?.usage?.window.usedPercent, 88);
    assert.strictEqual(records.find((entry) => entry.accountId === null)?.checkedAtMs, 100, "runtime events do not advance the direct account check");
    stopController();
  });

  it("adopts Meta provenance after an equal-time observation arrives before the quota response", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
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
    assert.strictEqual(controller.store.get().planUsageAccounts[0]?.source, "meta");
    assert.strictEqual(controller.store.get().planUsageAccounts[0]?.planName, "Muse Plus");
    client.handler?.({ type: "plan-usage", usage: { ...usage }, accountId: null });
    assert.strictEqual(controller.store.get().planUsageAccounts[0]?.source, "meta", "a delayed copy of the same observation does not erase verified provenance");
    stopController();
  });

  it("keeps a newer runtime observation when an older account response or network failure arrives", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
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
    assert.strictEqual(controller.store.get().planUsageAccounts[0]?.usage?.window.usedPercent, 45);
    assert.strictEqual(controller.store.get().planUsageAccounts[0]?.source, "runtime");
    let reject!: (reason: Error) => void;
    client.planUsage = () => new Promise((_, fail) => { reject = fail; });
    refresh = controller.loadPlanUsage();
    client.handler?.({ type: "plan-usage", usage: reading(50, 500), accountId: null });
    reject(new Error("Offline"));
    await refresh;
    assert.strictEqual(controller.store.get().planUsageAccounts[0]?.status, "runtime-only");
    assert.strictEqual(controller.store.get().planUsageAccounts[0]?.usage?.window.usedPercent, 50);
    stopController();
  });

  it("does not let an old runtime event revive a reading invalidated by a newer account check", async () => {
    const client = new MockAncillaRpcClient();
    const usage = { tier: "high", observedAtMs: 100,
      window: { usedPercent: 23, resetsAtMs: 9000, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: 9000, windowDurationMins: null } };
    client.planMetadata = { status: "unobserved", accounts: [
      { accountId: null, usage, source: "saved", status: "not-reported", checkedAtMs: 300, planName: "Muse Plus" },
    ] };
    const { controller, stop: stopController } = await started(client);
    client.handler?.({ type: "plan-usage", usage: { ...usage, observedAtMs: 200 }, accountId: null });
    assert.strictEqual(controller.store.get().planUsageAccounts[0]?.status, "not-reported");
    assert.strictEqual(controller.store.get().planUsageAccounts[0]?.usage?.observedAtMs, 100);
    stopController();
  });

  it("opens Usage on the thread account without switching after another account reports", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    controller.store.set((state) => ({ ...state, route: { kind: "thread", sessionId: "s1" }, sessions: { ...state.sessions, s1: { ...SESSION, accountId: "work" } } }));
    controller.navigate({ kind: "usage" });
    assert.strictEqual(controller.store.get().planUsageSelectedAccountId, "work");
    controller.selectPlanUsageAccount(null);
    const usage = { tier: "high", observedAtMs: 100,
      window: { usedPercent: 23, resetsAtMs: 9000, windowDurationMins: 300 },
      weekly: { usedPercent: 3, resetsAtMs: 9000, windowDurationMins: null } };
    client.handler?.({ type: "plan-usage", usage, accountId: "work" });
    assert.strictEqual(controller.store.get().planUsageSelectedAccountId, null);
    stopController();
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
      const client = new MockAncillaRpcClient();
      const { controller, stop: stopController } = await started(client);
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
        assert.strictEqual(controller.store.get().planUsageLoading, false, "Refresh does not spin by itself");
        finish(quiet);
        await background;
        assert.deepStrictEqual(flag, [false], "the flag was never raised");

        const running = controller.loadPlanUsage({ background: true });
        const click = controller.loadPlanUsage();
        assert.strictEqual(click, running, "a click joins the read in flight");
        assert.strictEqual(controller.store.get().planUsageLoading, true, "and shows it");
        void controller.loadPlanUsage({ background: true });
        assert.strictEqual(controller.store.get().planUsageLoading, true, "a later background caller does not hide it");
        assert.strictEqual(reads, 2);
        finish(quiet);
        await click;
        assert.strictEqual(controller.store.get().planUsageLoading, false);
        assert.deepStrictEqual(flag, [false, true, false], "raised once and cleared once when the shared read ended");

        const plain = controller.loadPlanUsage();
        assert.strictEqual(controller.store.get().planUsageLoading, true, "a plain call still sets it");
        finish(quiet);
        await plain;
        assert.strictEqual(controller.store.get().planUsageLoading, false);

        client.planUsage = () => Promise.reject(new Error("offline"));
        await controller.loadPlanUsage();
        assert.strictEqual(controller.store.get().planUsageLoading, false, "a failed read clears it too");
      } finally {
        unsubscribe();
        stopController();
      }
    });

    it("forgets a removed account's readings, selection and project default, then reads the meter again", async () => {
      const client = new MockAncillaRpcClient();
      client.accounts = [workAccount];
      client.projects = client.projects.map((project) => ({ ...project, defaultAccountId: "work" }));
      const work = reading(60, 300);
      client.plan = work;
      client.planByAccount = { work };
      client.planMetadata = { accountId: "work", saved: true, savedAccountIds: ["work"], status: "ready", accounts: [defaultRecord, workRecord(work)] };
      const { controller, stop: stopController } = await started(client);
      try {
        controller.selectPlanUsageAccount("work");
        const before = controller.store.get();
        assert.strictEqual(before.planUsageAccountId, "work");
        assert.ok(before.planUsageAccounts.some((account) => account.accountId === "work"));
        assert.ok(before.planUsageByAccount["work"]);
        assert.deepStrictEqual(before.planUsageSavedAccounts, ["work"]);
        assert.strictEqual(before.projects[0]?.defaultAccountId, "work");

        let reads = 0;
        let finish!: (report: Report) => void;
        client.planUsage = () => { reads += 1; return new Promise((resolve) => { finish = resolve; }); };
        assert.strictEqual(await controller.removeAccount("work"), true);
        await settleController();
        // The new read is still open, so everything below is the pruning, not a fresh answer.
        const state = controller.store.get();
        assert.strictEqual(reads, 1, "the meter is read again");
        assert.deepStrictEqual(state.planUsageAccounts.map((account) => account.accountId), [null]);
        assert.deepStrictEqual(state.planUsageByAccount, {});
        assert.deepStrictEqual(state.planUsageSavedAccounts, []);
        assert.strictEqual(state.planUsageSelectedAccountId, null);
        assert.strictEqual(state.planUsageAccountId, null);
        assert.strictEqual(state.planUsage, null);
        assert.ok(state.projects.length > 0 && state.projects.every((project) => project.defaultAccountId === null));
        const { planAccount, planAccountChoices } = await import("../src/model/plan.js");
        assert.deepStrictEqual(planAccountChoices(state), [{ id: null, name: "Default login" }]);
        assert.strictEqual(planAccount(state, "work").usage, null);

        finish({ usage: null, byAccount: {}, status: "unobserved", accounts: [defaultRecord] });
        await settleController();
        assert.deepStrictEqual(controller.store.get().planUsageAccounts.map((account) => account.accountId), [null]);
        assert.strictEqual(reads, 1);
      } finally {
        stopController();
      }
    });

    it("keeps a removed account out of the meter when a read already in flight still listed it", async () => {
      const client = new MockAncillaRpcClient();
      client.accounts = [workAccount];
      const work = reading(60, 300);
      const { controller, stop: stopController } = await started(client);
      try {
        let reads = 0;
        let finish!: (report: Report) => void;
        client.planUsage = () => { reads += 1; return new Promise((resolve) => { finish = resolve; }); };
        const inFlight = controller.loadPlanUsage({ background: true });
        assert.strictEqual(await controller.removeAccount("work"), true);
        assert.strictEqual(reads, 1, "nothing new can start while the old read is open");
        // The server answered that read before the account went.
        finish({ usage: work, byAccount: { work }, accountId: "work", status: "ready", accounts: [defaultRecord, workRecord(work)] });
        await inFlight;
        await settleController();
        assert.strictEqual(reads, 2, "so the meter is read once more when it ends");
        finish({ usage: null, byAccount: {}, status: "unobserved", accounts: [defaultRecord] });
        await settleController();
        const state = controller.store.get();
        assert.deepStrictEqual(state.planUsageAccounts.map((account) => account.accountId), [null]);
        assert.deepStrictEqual(state.planUsageByAccount, {});
        assert.strictEqual(state.planUsage, null);
      } finally {
        stopController();
      }
    });
  });

  it("loads the account list and creates an account", async () => {
    const client = new MockAncillaRpcClient();
    const controller = new AncillaController(client, platform());
    await controller.loadAccounts();
    assert.deepStrictEqual(controller.store.get().accounts?.map((a) => a.id), []);
    assert.strictEqual(await controller.createAccount("work", "Work"), true);
    assert.ok(client.accountCalls.some((c) => c.kind === "create" && c.id === "work"));
    assert.deepStrictEqual(controller.store.get().accounts?.map((a) => a.id), ["work"]);
  });

  it("flips metaApiKeyInherited when the client reports it", async () => {
    const client = new MockAncillaRpcClient();
    const controller = new AncillaController(client, platform());
    assert.strictEqual(controller.store.get().metaApiKeyInherited, false);
    client.metaApiKeyInherited = true;
    await controller.loadAccountsHealth();
    assert.strictEqual(controller.store.get().metaApiKeyInherited, true);
  });

  it("refreshes metaApiKeyInherited as part of loadAccounts", async () => {
    const client = new MockAncillaRpcClient();
    client.metaApiKeyInherited = true;
    const controller = new AncillaController(client, platform());
    await controller.loadAccounts();
    await flushMicrotasks();
    assert.strictEqual(controller.store.get().metaApiKeyInherited, true);
  });

  it("begins a device-code login, waits, then flips to done once hasLogin turns true", async () => {
    const client = new MockAncillaRpcClient();
    client.accounts = [{ id: "work", name: "Work", hasLogin: false, email: null, lastUsedAt: null as string | null }];
    const controller = new AncillaController(client, platform());

    const login = controller.beginLogin("work");
    // The modal opens right away with an empty marker, before the server has answered.
    const pending = controller.store.get().accountLogin;
    assert.strictEqual(pending?.accountId, "work");

    await login;
    const waiting = controller.store.get().accountLogin;
    assert.ok(waiting && "status" in waiting && waiting.status === "waiting", "resolves to the waiting device shape");
    assert.strictEqual((waiting as { url: string }).url, "https://auth.meta.com/oauth/device/?code=TEST-CODE");
    assert.strictEqual((waiting as { code: string | null }).code, "TEST-CODE");
    assert.strictEqual(client.loginAccountCalls.length, 1);

    const workUserAccount = client.accounts.find((a) => a.id === "work");
    assert.ok(workUserAccount);
    workUserAccount.hasLogin = true;

    await settleController();
    const completedLogin = controller.store.get().accountLogin;
    assert.ok(completedLogin && "status" in completedLogin && completedLogin.status === "done", "the poll flips status to done once hasLogin is true");
  });

  it("stores the fallback shape when the login route reports one", async () => {
    const client = new MockAncillaRpcClient();
    client.accounts = [{ id: "work", name: "Work", hasLogin: false, email: null, lastUsedAt: null as string | null }];
    client.loginAccountResult = { fallback: "In-app login is not available when Muse runs in WSL." };
    const controller = new AncillaController(client, platform());

    await controller.beginLogin("work");
    const fallbackLogin = controller.store.get().accountLogin;
    assert.ok(fallbackLogin && !("status" in fallbackLogin));
    assert.strictEqual((fallbackLogin as { fallback: string }).fallback, "In-app login is not available when Muse runs in WSL.");
  });

  it("cancelLogin clears the state and stops the poll", async () => {
    const client = new MockAncillaRpcClient();
    client.accounts = [{ id: "work", name: "Work", hasLogin: false, email: null, lastUsedAt: null as string | null }];
    const controller = new AncillaController(client, platform());

    await controller.beginLogin("work");
    assert.strictEqual(Boolean(controller.store.get().accountLogin), true);

    controller.cancelLogin();
    assert.strictEqual(controller.store.get().accountLogin, null);

    // The poll must not resurrect state after cancel, and must not call loginAccount again.
    const cancelledAcct = client.accounts.find((a) => a.id === "work");
    assert.ok(cancelledAcct);
    cancelledAcct.hasLogin = true;
    await settleController();
    assert.strictEqual(controller.store.get().accountLogin, null);
    assert.strictEqual(client.loginAccountCalls.length, 1);
  });

  it("confirms default subscription sign-in from its own process without a named profile", async () => {
    const client = new MockAncillaRpcClient();
    client.loginAccountResult = { url: "https://auth.meta.com/oauth/device/?code=TEST-CODE", code: "TEST-CODE", loginId: "default-attempt" };
    let status: "waiting" | "done" = "waiting";
    client.accountLoginProgress = async (id, loginId) => {
      assert.strictEqual(id, null);
      assert.strictEqual(loginId, "default-attempt");
      return { status };
    };
    let meterReads = 0;
    const readMeter = client.planUsage.bind(client);
    client.planUsage = async () => { meterReads++; return readMeter(); };
    const controller = new AncillaController(client, { ...platform(), schedule: () => 0 });
    await controller.beginLogin(null);
    await controller.checkLogin();
    assert.strictEqual((controller.store.get().accountLogin as { status: string }).status, "waiting");
    const readsBeforeConfirmation = meterReads;
    status = "done";
    await controller.checkLogin();
    assert.strictEqual((controller.store.get().accountLogin as { status: string }).status, "done");
    await settleController();
    assert.ok(meterReads > readsBeforeConfirmation, "the meter is read again as soon as the sign-in is confirmed, so a refused login stops being shown at once");
    assert.deepStrictEqual(client.accounts, []);
    controller.cancelLogin();
    assert.deepStrictEqual(client.cancelledLoginCalls, [], "closing confirmed sign-in does not cancel it");
  });

  it("asks the server who is signed in again once a sign-in is confirmed, so Settings shows the account", async () => {
    const client = new MockAncillaRpcClient();
    client.defaultLogin = { hasLogin: null, email: null };
    client.loginAccountResult = { url: "https://auth.meta.com/oauth/device/?code=TEST-CODE", code: "TEST-CODE", loginId: "default-attempt" };
    let status: "waiting" | "done" = "waiting";
    client.accountLoginProgress = async () => ({ status });
    const controller = new AncillaController(client, { ...platform(), schedule: () => 0 });
    await controller.loadAccounts();
    await settleController();
    assert.deepStrictEqual(controller.store.get().defaultLogin, { hasLogin: null, email: null }, "before the sign-in the server cannot say");
    await controller.beginLogin(null);
    await controller.checkLogin();
    const before = client.healthCalls;
    client.defaultLogin = { hasLogin: true, email: "person@example.test" };
    status = "done";
    await controller.checkLogin();
    await settleController();
    assert.strictEqual((controller.store.get().accountLogin as { status: string }).status, "done");
    assert.ok(client.healthCalls > before, "the identity was asked for again after the confirmation");
    assert.deepStrictEqual(controller.store.get().defaultLogin, { hasLogin: true, email: "person@example.test" });
    controller.cancelLogin();
  });

  it("does not confuse an existing credential with completion of a new browser sign-in", async () => {
    const client = new MockAncillaRpcClient();
    client.accounts = [{ id: "work", name: "Work", hasLogin: true, email: "old@example.test", lastUsedAt: null }];
    client.loginAccountResult = { url: "https://auth.meta.com/?code=NEW-CODE", code: "NEW-CODE", loginId: "new-attempt" };
    client.accountLoginProgress = async () => ({ status: "waiting" });
    const controller = new AncillaController(client, { ...platform(), schedule: () => 0 });
    await controller.loadAccounts();
    await controller.beginLogin("work");
    await controller.checkLogin();
    assert.strictEqual((controller.store.get().accountLogin as { status: string }).status, "waiting");
    controller.cancelLogin();
    assert.deepStrictEqual(client.cancelledLoginCalls, [{ id: "work", loginId: "new-attempt" }]);
  });

  it("keeps a failed sign-in visible with a retry action instead of dismissing the dialog", async () => {
    const client = new MockAncillaRpcClient();
    client.loginAccount = async () => { throw new Error("Muse could not start sign-in."); };
    const controller = new AncillaController(client, { ...platform(), schedule: () => 0 });
    await controller.beginLogin(null);
    const login = controller.store.get().accountLogin;
    assert.ok(login && "status" in login);
    assert.strictEqual(login.status, "error");
    assert.match(login.message ?? "", /could not start/);
    assert.strictEqual(controller.store.get().toasts.length, 0);
  });

  it("recovers a temporarily unreachable login check without starting another browser flow", async () => {
    const client = new MockAncillaRpcClient();
    client.loginAccountResult = { url: "https://auth.meta.com/?code=TEST-CODE", code: "TEST-CODE", loginId: "attempt" };
    client.accountLoginProgress = async () => { throw new Error("offline"); };
    const controller = new AncillaController(client, { ...platform(), schedule: () => 0 });
    await controller.beginLogin(null);
    await controller.checkLogin();
    assert.strictEqual((controller.store.get().accountLogin as { status: string }).status, "timeout");
    client.accountLoginProgress = async () => ({ status: "done" });
    await controller.checkLogin();
    assert.strictEqual((controller.store.get().accountLogin as { status: string }).status, "done");
    assert.strictEqual(client.loginAccountCalls.length, 1);
    controller.cancelLogin();
  });

  it("makes the end of automatic sign-in checking explicit and lets the user check again", async () => {
    const client = new MockAncillaRpcClient();
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
    assert.strictEqual(timedOut.status, "timeout");
    assert.match(timedOut.message ?? "", /check again/);
    assert.strictEqual(next, null);
    client.accountLoginProgress = async () => ({ status: "done" });
    await controller.checkLogin();
    assert.strictEqual((controller.store.get().accountLogin as { status: string }).status, "done");
    controller.cancelLogin();
  });

  it("cancels a login link that arrives after its dialog was closed", async () => {
    const client = new MockAncillaRpcClient();
    let resolveLogin!: (result: import("../src/types.js").AccountLoginResult) => void;
    client.loginAccount = () => new Promise((resolve) => { resolveLogin = resolve; });
    const controller = new AncillaController(client, { ...platform(), schedule: () => 0 });
    const pending = controller.beginLogin(null);
    controller.cancelLogin();
    resolveLogin({ url: "https://auth.meta.com/?code=OLD-CODE", code: "OLD-CODE", loginId: "closed-attempt" });
    await pending;
    assert.strictEqual(controller.store.get().accountLogin, null);
    assert.deepStrictEqual(client.cancelledLoginCalls, [{ id: null, loginId: "closed-attempt" }]);
  });

  it("renames and removes accounts, reloading the list each time", async () => {
    const client = new MockAncillaRpcClient();
    client.accounts = [{ id: "default", name: "Default", hasLogin: true, email: "a@b.com", lastUsedAt: null }];
    const { controller, stop: stopController } = await started(client);
    assert.deepStrictEqual(controller.store.get().accounts?.map((a) => a.id), ["default"]);

    assert.strictEqual(await controller.createAccount("work", "Work"), true);
    assert.deepStrictEqual(controller.store.get().accounts?.map((a) => a.id), ["default", "work"]);

    assert.strictEqual(await controller.renameAccount("work", "Work Account"), true);
    assert.strictEqual(controller.store.get().accounts?.find((a) => a.id === "work")?.name, "Work Account");

    assert.strictEqual(await controller.removeAccount("work"), true);
    assert.deepStrictEqual(controller.store.get().accounts?.map((a) => a.id), ["default"]);
    stopController();
  });

  it("sets a project's default account optimistically, and rolls back on failure", async () => {
    const client = new MockAncillaRpcClient();
    client.projects = [{ cwd: "/work/app", displayName: "app", pinned: false, activityAt: SESSION.activityAt, defaultAccountId: null, folders: [{ cwd: "/work/app", displayName: "app" }] }];
    const { controller, stop: stopController } = await started(client);

    await controller.setProjectDefaultAccount("/work/app", "work");
    assert.strictEqual(controller.store.get().projects.find((p) => p.cwd === "/work/app")?.defaultAccountId, "work");
    assert.ok(client.accountCalls.some((c) => c.kind === "default" && c.cwd === "/work/app" && c.accountId === "work"));

    client.setProjectDefaultAccount = async () => {
      throw new Error("nope default account refused");
    };
    await controller.setProjectDefaultAccount("/work/app", null);
    assert.strictEqual(
      controller.store.get().projects.find((p) => p.cwd === "/work/app")?.defaultAccountId,
      "work" as string,
      "a refused default rolls back",
    );
    assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not set the default account/);
    stopController();
  });

  it("does not let a stale rollback clobber a newer overlapping default-account write", async () => {
    const client = new MockAncillaRpcClient();
    client.projects = [{ cwd: "/work/app", displayName: "app", pinned: false, activityAt: SESSION.activityAt, defaultAccountId: null, folders: [{ cwd: "/work/app", displayName: "app" }] }];
    const { controller, stop: stopController } = await started(client);

    client.setProjectDefaultAccountError = new Error("nope overlapping default error");
    // Fired without awaiting: the first PATCH is queued to fail, the second to succeed. The chain
    // means the server sees them in order, so the first's rejection lands after the second's optimism.
    const first = controller.setProjectDefaultAccount("/work/app", "alpha");
    const second = controller.setProjectDefaultAccount("/work/app", "beta");
    await Promise.all([first, second]);

    assert.strictEqual(
      controller.store.get().projects.find((p) => p.cwd === "/work/app")?.defaultAccountId,
      "beta",
      "the second call's value stands; the stale rollback from the first call's failure is dropped",
    );
    assert.strictEqual(
      controller.store.get().toasts.some((t) => /Could not set the default account/.test(t.title)),
      false,
      "a stale rollback does not toast either",
    );
    stopController();
  });

  it("starts a new thread on the project's default account", async () => {
    const client = new MockAncillaRpcClient();
    client.projects = [{ cwd: "/work/app", displayName: "app", pinned: false, activityAt: SESSION.activityAt, defaultAccountId: "work", folders: [{ cwd: "/work/app", displayName: "app" }] }];
    const { controller, stop: stopController } = await started(client, "");
    controller.newThread("/work/app");
    assert.strictEqual(await controller.send("hello"), true);
    assert.strictEqual(client.startCalls.at(-1)?.accountId, "work");
    const route = controller.store.get().route;
    assert.strictEqual(route.kind, "thread");
    const sessionId = route.kind === "thread" ? route.sessionId : "";
    assert.strictEqual(controller.store.get().sessions[sessionId]?.accountId, "work", "the seeded session carries the account the server confirmed");
    stopController();
  });

  it("starts a thread in a project's second folder on that project's default account", async () => {
    const client = new MockAncillaRpcClient();
    client.projects = [
      {
        cwd: "/work/app",
        displayName: "app",
        defaultAccountId: "work",
        pinned: false,
        activityAt: SESSION.activityAt,
        folders: [{ cwd: "/work/app", displayName: "app" }, { cwd: "/work/docs", displayName: "docs" }],
      },
    ];
    const { controller, stop: stopController } = await started(client, "");
    controller.newThread("/work/docs");
    assert.deepStrictEqual(controller.store.get().route, { kind: "new", cwd: "/work/docs" }, "a project's folder is a place to start");
    assert.strictEqual(await controller.send("hello"), true);
    assert.strictEqual(client.startCalls.at(-1)?.cwd, "/work/docs", "the thread runs in the folder picked");
    assert.strictEqual(client.startCalls.at(-1)?.accountId, "work", "on the owning project's account");
    controller.newThread("/work/elsewhere");
    assert.deepStrictEqual(controller.store.get().route, { kind: "new", cwd: "/work/app" }, "a folder no project has falls back to the first project");
    stopController();
  });

  it("adds and removes a project's folders, and refreshes every folder of a project", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client, "");
    assert.strictEqual(await controller.addProjectFolder("/work/app", "/work/docs"), true);
    assert.deepStrictEqual(client.folderCalls, ["add /work/app /work/docs"]);
    const project = () => controller.store.get().projects.find((p) => p.cwd === "/work/app");
    assert.deepStrictEqual(project()?.folders.map((f) => f.cwd), ["/work/app", "/work/docs"]);
    assert.strictEqual(controller.store.get().addProjectOpen, false, "the picker closes once the folder is in");

    client.discovered = [];
    await controller.refreshProject("/work/app");
    assert.deepStrictEqual(client.discovered, ["/work/app", "/work/docs"], "each folder is its own Muse workspace");

    await controller.removeProjectFolder("/work/app", "/work/docs");
    assert.deepStrictEqual(client.folderCalls.at(-1), "remove /work/app /work/docs");
    assert.deepStrictEqual(project()?.folders.map((f) => f.cwd), ["/work/app"]);
    assert.deepStrictEqual(
      controller.store.get().projects.map((p) => p.cwd).slice(),
      ["/work/app", "/work/docs"],
      "the folder comes back as a project of its own",
    );

    client.addProjectFolder = async () => {
      throw new Error("nope folder");
    };
    assert.strictEqual(await controller.addProjectFolder("/work/app", "/work/other"), false);
    assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Could not add that folder");
    stopController();
  });

  it("takes a project's folders out of view with it", async () => {
    const client = new MockAncillaRpcClient();
    client.projects = [
      {
        cwd: "/work/other",
        displayName: "other",
        defaultAccountId: null,
        pinned: false,
        activityAt: SESSION.activityAt,
        folders: [{ cwd: "/work/other", displayName: "other" }, { cwd: "/work/app", displayName: "app" }],
      },
    ];
    const { controller, stop: stopController } = await started(client);
    assert.deepStrictEqual(controller.store.get().route, { kind: "thread", sessionId: "s1" }, "a thread in the second folder is listed and open");
    await controller.hideProject("/work/other");
    assert.deepStrictEqual(controller.store.get().route, { kind: "home" }, "hiding the project closes a thread in any of its folders");
    stopController();
  });

  it("asks for the open thread's own skills and reloads them when Muse says they changed", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    await controller.loadSkills("/work/app");
    assert.deepStrictEqual(client.skillSessions, ["s1"]);
    await controller.loadSkills("/work/app");
    assert.strictEqual(client.skillSessions.length, 1, "a fresh list is reused");
    client.handler?.({ type: "msp", sessionId: "s1", method: "skill/changed", params: { sessionId: "s1" }, at: 1 });
    await settleController();
    assert.strictEqual(client.skillSessions.length, 2);
    stopController();
  });

  it("opens files from paths in replies as tabs, and closes back to the tree", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    const panel = () => controller.store.get().filePanels["s1"];
    assert.strictEqual(controller.store.get().prefs.filesOpen, false);

    assert.strictEqual(controller.openFile("s1", "/work/app/src/app.js:4-5"), true);
    assert.strictEqual(controller.store.get().prefs.filesOpen, true, "opening a file shows the viewer");
    assert.deepStrictEqual(panel(), { tabs: ["src/app.js"], active: "src/app.js", tree: false, line: { start: 4, end: 5 } });
    controller.openFile("s1", "README.md");
    controller.openFile("s1", "src/app.js");
    assert.deepStrictEqual(panel()?.tabs, ["src/app.js", "README.md"], "an open file is not opened twice");
    assert.strictEqual(panel()?.active, "src/app.js");

    controller.closeFile("s1", "src/app.js");
    assert.deepStrictEqual(panel(), { tabs: ["README.md"], active: "README.md", tree: false, line: null });
    controller.closeFile("s1", "README.md");
    assert.deepStrictEqual(panel(), { tabs: [], active: null, tree: true, line: null });
    assert.strictEqual(controller.openFile("s1", "https://example.com"), false, "a web link is not a file");
    controller.toggleFiles();
    assert.strictEqual(controller.store.get().prefs.filesOpen, false);
    stopController();
  });

  it("saves a draft against the version it was opened at, and offers to overwrite a file that changed", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    const key = "/work/app\nREADME.md";
    controller.setFileDraft("/work/app", "README.md", "# edited", 100);
    controller.setFileDraft("/work/app", "README.md", "# edited more", 999);
    assert.deepStrictEqual(controller.store.get().fileDrafts[key], { content: "# edited more", baseMtimeMs: 100 }, "the base is where editing began");

    assert.strictEqual(await controller.saveFile("/work/app", "README.md"), 200);
    assert.deepStrictEqual(client.writes.at(-1), { path: "README.md", content: "# edited more", baseMtimeMs: 100 });
    assert.strictEqual(controller.store.get().fileDrafts[key], undefined);
    assert.strictEqual(controller.store.get().fileVersions[key], 1, "a view of the file reloads after a save");

    controller.setFileDraft("/work/app", "README.md", "# mine", 200);
    client.writeError = new AncillaError("changed", 409, "fileChanged");
    assert.strictEqual(await controller.saveFile("/work/app", "README.md"), null);
    const toast = controller.store.get().toasts.at(-1);
    assert.strictEqual(toast?.title, "This file changed on disk");
    assert.ok(controller.store.get().fileDrafts[key], "the edit is kept when the save is refused");
    toast?.action?.run();
    await settleController();
    assert.deepStrictEqual(client.writes.at(-1), { path: "README.md", content: "# mine", baseMtimeMs: null }, "overwrite skips the version check");
    stopController();
  });

  it("reloads an open file when Muse edits it", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    client.handler?.({
      at: 1,
      type: "msp" as const,
      sessionId: "s1",
      method: "item/completed" as const,
      params: {
        sessionId: "s1",
        item: {
          revision: 2,
          itemId: "e1",
          kind: "toolCall",
          status: "completed",
          tool: "edit",
          args: JSON.stringify({ path: "/work/app/src/app.js", old_string: "a", new_string: "b" }),
        },
      },
    });
    await settleController();
    controller.flush();
    assert.strictEqual(controller.store.get().fileVersions["/work/app\nsrc/app.js"], 1);
    stopController();
  });

  it("reads a tool's stored output page by page", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    const first = await controller.readOutput("s1", "i1", "ref");
    assert.strictEqual(first.eof, false);
    const next = await controller.readOutput("s1", "i1", "ref", first.offsetBytes + first.byteLen);
    assert.strictEqual(next.eof, true);
    stopController();
  });

  it("runs a `!` command itself and hands its output to Muse on request", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(await controller.send("!ls -la"), true);
    const run = controller.store.get().threads["s1"]?.shellRuns[0];
    assert.strictEqual(run?.command, "ls -la");
    assert.ok(client.actions.includes("shell-proxy:ls -la"));

    assert.strictEqual(await controller.sendShellOutput("s1", run!), true);
    const sent = client.sent.at(-1);
    assert.match(sent?.text ?? "", /I ran this in the workspace/);
    assert.match(sent?.text ?? "", /ran ls -la/);
    assert.strictEqual(sent?.displayText, "Shared the output of `ls -la`");
    stopController();
  });

  describe("deep research", () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    it("loads a thread's runs with its transcript, and leaves the list empty for a server without them", async () => {
      const client = new MockAncillaRpcClient();
      client.transcript = async () => load({ researchRuns: [fakeResearchRun({ status: "completed", phase: "done", reportAvailable: true })] });
      const { controller, stop: stopController } = await started(client);
      assert.strictEqual(controller.store.get().threads["s1"]?.researchRuns.length, 1);
      assert.strictEqual(controller.store.get().threads["s1"]?.researchRuns[0]?.status, "completed");
      stopController();
      const plain = new MockAncillaRpcClient();
      const second = await started(plain);
      assert.deepStrictEqual(second.controller.store.get().threads["s1"]?.researchRuns, []);
      second.stop();
    });

    it("starts a run with a minted UUID commandId, showing it queued before the server answers", async () => {
      const client = new MockAncillaRpcClient();
      let release: (() => void) | null = null;
      const original = client.startResearch.bind(client);
      client.startResearch = async (...args) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return original(...args);
      };
      const { controller, stop: stopController } = await started(client);
      const promise = controller.startResearch("s1", "  How is geothermal energy developing in Europe?  ", { maxParallel: 2 });
      await flushMicrotasks();
      const optimistic = controller.store.get().threads["s1"]?.researchRuns[0];
      assert.strictEqual(optimistic?.status, "queued");
      assert.strictEqual(optimistic?.question, "How is geothermal energy developing in Europe?");
      assert.match(optimistic?.runId ?? "", /^pending:/);
      assert.strictEqual(optimistic?.config.maxParallel, 2, "the popover's overrides show on the optimistic row");
      assert.strictEqual(optimistic?.config.maxRounds, 12, "the rest comes from the loaded defaults");
      (release as unknown as () => void)();
      assert.strictEqual(await promise, true);
      const runs = controller.store.get().threads["s1"]?.researchRuns ?? [];
      assert.strictEqual(runs.length, 1, "the optimistic row is replaced, not kept beside the real one");
      assert.match(runs[0]?.runId ?? "", /^run-1-/);
      const call = client.researchStarts[0];
      assert.strictEqual(call?.sessionId, "s1");
      assert.strictEqual(call?.question, "How is geothermal energy developing in Europe?");
      assert.deepStrictEqual(call?.config, { maxParallel: 2 });
      assert.match(call?.commandId ?? "", UUID);
      stopController();
    });

    it("drops the optimistic row and says so when the server refuses the run", async () => {
      const client = new MockAncillaRpcClient();
      client.startResearchError = new AncillaError("This thread already has a research run going.", 409);
      const { controller, stop: stopController } = await started(client);
      assert.strictEqual(await controller.startResearch("s1", "anything"), false);
      assert.deepStrictEqual(controller.store.get().threads["s1"]?.researchRuns, []);
      assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Could not start the research run");
      stopController();
    });

    it("refuses a second run while one is live, and any run while the setting is off", async () => {
      const client = new MockAncillaRpcClient();
      const { controller, stop: stopController } = await started(client);
      assert.strictEqual(await controller.startResearch("s1", "first"), true);
      assert.strictEqual(await controller.startResearch("s1", "second"), false);
      assert.strictEqual(client.researchStarts.length, 1);
      assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /already going/);
      controller.store.set((s) => ({ ...s, researchSettings: { enabled: false, config: fakeResearchRun({}).config } }));
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "run-1-" + client.researchStarts[0]!.commandId.slice(0, 4), status: "cancelled", phase: "done" }) });
      assert.strictEqual(await controller.startResearch("s1", "third"), false);
      assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Deep research is off");
      stopController();
    });

    it("merges research-run events by runId, newest winning, and keeps a report already read", async () => {
      const client = new MockAncillaRpcClient();
      const { controller, stop: stopController } = await started(client);
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 1 }) });
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r2", round: 1, createdAt: "2026-09-26T00:05:00.000Z" }) });
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 3, phase: "writing" }) });
      const runs = controller.store.get().threads["s1"]?.researchRuns ?? [];
      assert.deepStrictEqual(runs.map((r) => [r.runId, r.round, r.phase]), [["r1", 3, "writing"], ["r2", 1, "researching"]]);
      // A thread this app has not opened keeps nothing: it reads its runs when opened.
      client.handler?.({ type: "research-run", sessionId: "elsewhere", run: fakeResearchRun({ runId: "r9", sessionId: "elsewhere" }) });
      assert.strictEqual(controller.store.get().threads["elsewhere"], undefined);
      // The report, once read, survives the summaries the stream keeps sending.
      client.researchRuns.push(fakeResearchRun({ runId: "r1", status: "completed", phase: "done", reportAvailable: true }));
      assert.strictEqual(await controller.openResearchReport("r1"), true);
      assert.match(controller.store.get().threads["s1"]?.researchRuns[0]?.report ?? "", /^# Report/);
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", status: "completed", phase: "done", reportAvailable: true, report: null }) });
      assert.match(controller.store.get().threads["s1"]?.researchRuns[0]?.report ?? "", /^# Report/);
      stopController();
    });

    it("chooses a destination before rendering each report format, including with a desktop updater", async () => {
      const client = new MockAncillaRpcClient();
      const saves: { name: string; extension: string; mimeType: string; bytes: string }[] = [];
      const shell = platform("#/t/s1");
      shell.saveFile = async (options, contents) => {
        assert.strictEqual(client.exports.length, saves.length, "the dialog opens before the server renders a file");
        assert.strictEqual(controller.store.get().busy["research-export:r1"], true);
        await controller.exportResearchReport("s1", "r1", "html");
        assert.strictEqual(client.exports.length, saves.length, "a second click cannot open a second dialog");
        const bytes = new TextDecoder().decode(await contents());
        saves.push({ name: options.name, extension: options.extension, mimeType: options.mimeType, bytes });
        return { kind: "saved", name: `chosen.${options.extension}`, path: `/chosen/chosen.${options.extension}` };
      };
      const controller = new AncillaController(client, shell);
      const stop = controller.start();
      await settleController();
      await flushMicrotasks();
      await controller.exportResearchReport("s1", "r1", "pdf");
      assert.deepStrictEqual(client.exports, [{ runId: "r1", format: "pdf" }]);
      assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Saved chosen.pdf");
      assert.strictEqual(controller.store.get().toasts.at(-1)?.detail, "/chosen/chosen.pdf");
      assert.strictEqual(controller.store.get().busy["research-export:r1"], undefined, "the export is no longer busy");

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
      assert.deepStrictEqual(saves, [
        { name: "report.pdf", extension: "pdf", mimeType: "application/pdf", bytes: "report.pdf" },
        { name: "report.docx", extension: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: "report.docx" },
        { name: "report.html", extension: "html", mimeType: "text/html", bytes: "report.html" },
      ]);
      assert.deepStrictEqual(client.exportReads, client.exports);
      assert.deepStrictEqual(client.openedFiles, []);

      client.exportFails = "The run has no report to export.";
      await controller.exportResearchReport("s1", "r1", "html");
      assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Could not export the report as HTML/);
      assert.strictEqual(controller.store.get().toasts.at(-1)?.detail, "The run has no report to export.");
      assert.strictEqual(client.exportReads.length, 3, "a failed export never attempts to download old bytes");
      stop();
    });

    it("cancels an export without rendering, writing or reporting success, and reports save failures", async () => {
      const client = new MockAncillaRpcClient();
      const shell = platform("#/t/s1");
      const controller = new AncillaController(client, shell);
      shell.saveFile = async () => null;
      await controller.exportResearchReport("s1", "r1", "pdf");
      assert.deepStrictEqual(client.exports, []);
      assert.deepStrictEqual(client.exportReads, []);
      assert.strictEqual(controller.store.get().toasts.length, 0);
      assert.strictEqual(controller.store.get().busy["research-export:r1"], undefined);

      shell.saveFile = async (_options, contents) => {
        await contents();
        throw new Error("The destination is not writable.");
      };
      await controller.exportResearchReport("s1", "r1", "docx");
      assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Could not export the report as Word");
      assert.strictEqual(controller.store.get().toasts.at(-1)?.detail, "The destination is not writable.");
      assert.strictEqual(controller.store.get().busy["research-export:r1"], undefined);
    });

    it("explains a browser-controlled fallback download instead of claiming a file was saved", async () => {
      const client = new MockAncillaRpcClient();
      const shell = platform();
      shell.saveFile = async (options, contents) => {
        await contents();
        return { kind: "download", name: options.name };
      };
      const controller = new AncillaController(client, shell);
      await controller.exportResearchReport("s1", "r1", "html");
      assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Downloading report.html");
      assert.match(controller.store.get().toasts.at(-1)?.detail ?? "", /browser controls the save location/);
    });

    it("stops a run, with or without a report, and shows the server's answer", async () => {
      const client = new MockAncillaRpcClient();
      const { controller, stop: stopController } = await started(client);
      assert.strictEqual(await controller.startResearch("s1", "first"), true);
      const runId = controller.store.get().threads["s1"]!.researchRuns[0]!.runId;
      assert.strictEqual(await controller.stopResearch(runId, true), true);
      assert.deepStrictEqual(client.researchStops, [{ runId, writeReport: true }]);
      assert.strictEqual(controller.store.get().threads["s1"]?.researchRuns[0]?.status, "partial");
      assert.strictEqual(await controller.stopResearch("missing", false), false);
      assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Could not stop the research run");
      stopController();
    });

    it("says a run is stopping until the stream reports how it ended, and lets no stale answer undo that", async () => {
      const client = new MockAncillaRpcClient();
      const { controller, stop: stopController } = await started(client);
      const runs = () => controller.store.get().threads["s1"]?.researchRuns ?? [];
      const stopping = () => controller.store.get().researchStopping;
      assert.strictEqual(await controller.startResearch("s1", "first"), true);
      const first = client.researchRuns[0]!;
      // The stop route answers with the run as it was when the stop was taken: still running.
      client.stopResearch = async (runId, writeReport) => {
        client.researchStops.push({ runId, writeReport });
        return { ...first, status: "running" };
      };
      const pending = controller.stopResearch(first.runId, false);
      await flushMicrotasks();
      assert.strictEqual(stopping()[first.runId], "now", "the row says it is stopping as soon as the stop is asked for");
      assert.strictEqual(await pending, true);
      assert.strictEqual(runs()[0]?.status, "running");
      assert.strictEqual(stopping()[first.runId], "now", "a snapshot from before the run acted does not answer the stop");
      client.handler?.({ type: "research-run", sessionId: "s1", run: { ...first, status: "cancelled", phase: "done" } });
      assert.strictEqual(runs()[0]?.status, "cancelled");
      assert.strictEqual(stopping()[first.runId], undefined, "the outcome on the stream answers it");
      // The route's answer can also land after the stream has said how the run ended.
      assert.strictEqual(await controller.startResearch("s1", "second"), true);
      const second = client.researchRuns[1]!;
      client.stopResearch = async (runId, writeReport) => {
        client.researchStops.push({ runId, writeReport });
        client.handler?.({ type: "research-run", sessionId: "s1", run: { ...second, status: "cancelled", phase: "done" } });
        return { ...second, status: "running" };
      };
      assert.strictEqual(await controller.stopResearch(second.runId, true), true);
      assert.strictEqual(runs()[1]?.status, "cancelled", "the stream's cancelled outlives the route's stale running");
      assert.strictEqual(stopping()[second.runId], undefined);
      // A stop the server refused leaves the run as it was, with its Stop back.
      client.handler?.({ type: "research-run", sessionId: "s1", run: { ...second, runId: "r-third" } });
      client.stopResearch = async () => {
        throw new AncillaError("No such research run.", 404);
      };
      assert.strictEqual(await controller.stopResearch("r-third", false), false);
      assert.strictEqual(stopping()["r-third"], undefined);
      assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Could not stop the research run");
      // A stop the stream never answered, because the connection dropped, is answered when the thread reloads.
      controller.store.set((s) => ({ ...s, researchStopping: { "r-third": "now" } }));
      client.transcript = async () => load({ researchRuns: [fakeResearchRun({ runId: "r-third", status: "cancelled", phase: "done" })] });
      await controller.loadThread("s1");
      assert.strictEqual(stopping()["r-third"], undefined);
      assert.strictEqual(runs().find((run) => run.runId === "r-third")?.status, "cancelled");
      stopController();
    });

    it("keeps the more advanced picture of a live run whichever arrives last, and an ending over any live one", async () => {
      const client = new MockAncillaRpcClient();
      const { controller, stop: stopController } = await started(client);
      const run = () => controller.store.get().threads["s1"]?.researchRuns[0];
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 3 }) });
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 2 }) });
      assert.strictEqual(run()?.round, 3, "a stale event does not take the row back a round");
      client.researchRuns.push(fakeResearchRun({ runId: "r1", round: 2, brief: "stale" }));
      assert.strictEqual(await controller.openResearchReport("r1"), true);
      assert.strictEqual(run()?.round, 3, "nor does a stale read");
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 3, brief: "fresher" }) });
      assert.strictEqual(run()?.brief, "fresher", "level on progress, the later arrival wins");
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 3, status: "cancelled", phase: "done" }) });
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 3, phase: "writing" }) });
      assert.strictEqual(run()?.status, "cancelled", "nothing said afterwards reopens a run that has ended");
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", round: 3, status: "partial", phase: "done", reportAvailable: true }) });
      assert.strictEqual(run()?.status, "partial", "one ending can still correct another");
      stopController();
    });

    it("arms research mode from the chord only where a composer would show it, and drops it on leaving", async () => {
      const client = new MockAncillaRpcClient();
      const { controller, stop: stopController } = await started(client);
      const armed = () => controller.store.get().researchMode;
      controller.toggleResearchMode();
      assert.strictEqual(armed(), true);
      controller.toggleResearchMode();
      assert.strictEqual(armed(), false, "the chord disarms what it armed");
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1" }) });
      controller.toggleResearchMode();
      assert.strictEqual(armed(), false, "not while a run is going in the thread");
      client.handler?.({ type: "research-run", sessionId: "s1", run: fakeResearchRun({ runId: "r1", status: "completed", phase: "done" }) });
      controller.store.set((s) => ({ ...s, researchSettings: { enabled: false, config: fakeResearchRun({}).config } }));
      controller.toggleResearchMode();
      assert.strictEqual(armed(), false, "not with the feature off");
      controller.store.set((s) => ({ ...s, researchSettings: { enabled: true, config: fakeResearchRun({}).config } }));
      controller.store.set((s) => ({ ...s, threads: { ...s.threads, s1: { ...s.threads["s1"]!, readOnly: true, readOnlyReason: "Another Muse session has it open." } } }));
      controller.toggleResearchMode();
      assert.strictEqual(armed(), false, "not in a read-only thread");
      controller.store.set((s) => ({ ...s, threads: { ...s.threads, s1: { ...s.threads["s1"]!, readOnly: false, readOnlyReason: null } } }));
      controller.toggleResearchMode();
      assert.strictEqual(armed(), true);
      controller.navigate({ kind: "settings" });
      assert.strictEqual(armed(), false, "leaving the composer disarms it");
      controller.toggleResearchMode();
      assert.strictEqual(armed(), false, "the settings page has no composer");
      controller.newThread("/work/app");
      controller.toggleResearchMode();
      assert.strictEqual(armed(), true, "the new-thread composer has the button too");
      controller.setResearchMode(false);
      controller.store.set((s) => ({ ...s, projects: [] }));
      controller.toggleResearchMode();
      assert.strictEqual(armed(), false, "without a project there is no composer yet");
      stopController();
    });

    it("disarms research mode once the question has gone out, and keeps the typed options", async () => {
      const client = new MockAncillaRpcClient();
      const { controller, stop: stopController } = await started(client);
      controller.setResearchMode(true);
      controller.setResearchTyped({ parallel: "4" });
      assert.strictEqual(await controller.research("what changed in WCAG 2.2?", { maxParallel: 4 }, "s1"), true);
      assert.strictEqual(controller.store.get().researchMode, false, "the next thing typed is a message again");
      assert.strictEqual(controller.store.get().researchTyped.parallel, "4", "options outlive the run they were set for");
      assert.strictEqual(client.researchStarts.at(-1)?.config?.maxParallel, 4);
      // From the new-thread screen the question names the thread it starts, cut to one line.
      let renamed: string | null = null;
      (client as unknown as { updateSession: (id: string, patch: { title?: string }) => Promise<typeof SESSION> }).updateSession = async (_id, patch) => {
        renamed = patch.title ?? null;
        return { ...SESSION, ...patch };
      };
      controller.newThread("/work/app");
      assert.strictEqual(await controller.research("what changed in WCAG 2.2 and why does it matter for muted text in dark themes now", null, null), true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.strictEqual(renamed, "what changed in WCAG 2.2 and why does it matter for muted text in dark…");
      stopController();
    });

    it("routes /research to a run in the open thread, and starts a thread for it from the new-thread screen", async () => {
      const client = new MockAncillaRpcClient();
      const { controller, stop: stopController } = await started(client);
      assert.strictEqual(await controller.send("/research how is geothermal developing in Europe?"), true);
      assert.strictEqual(client.researchStarts.at(-1)?.sessionId, "s1");
      assert.strictEqual(client.researchStarts.at(-1)?.question, "how is geothermal developing in Europe?");
      assert.strictEqual(client.sent.length, 0, "nothing goes to Muse as a prompt");
      assert.strictEqual(await controller.send("/research"), false);
      assert.match(controller.store.get().toasts.at(-1)?.title ?? "", /Add the question/);
      controller.newThread("/work/app");
      const startsBefore = client.startCalls.length;
      assert.strictEqual(await controller.send("/research what changed in WCAG 2.2?"), true);
      assert.strictEqual(client.startCalls.length, startsBefore + 1, "a thread was started for the run");
      assert.strictEqual(client.startCalls.at(-1)?.cwd, "/work/app");
      // The fake starts every thread as s1, so the run lands there; the route follows the new thread.
      assert.strictEqual(controller.store.get().route.kind, "thread");
      assert.strictEqual(client.researchStarts.at(-1)?.sessionId, "s1");
      assert.strictEqual(client.researchStarts.at(-1)?.question, "what changed in WCAG 2.2?");
      assert.strictEqual(client.sent.length, 0);
      stopController();
    });

    it("loads the research settings at boot and patches them with the change shown at once", async () => {
      const client = new MockAncillaRpcClient();
      const { controller, stop: stopController } = await started(client);
      assert.strictEqual(controller.store.get().researchSettings?.enabled, true);
      assert.strictEqual(controller.store.get().researchSettings?.config.maxParallel, 3);
      await controller.setResearchSettings({ config: { maxParallel: 4, models: { supervisor: null, worker: "muse-spark-1.3", writer: null } } });
      assert.deepStrictEqual(client.researchPatches, [{ config: { maxParallel: 4, models: { supervisor: null, worker: "muse-spark-1.3", writer: null } } }]);
      assert.strictEqual(controller.store.get().researchSettings?.config.maxParallel, 4);
      assert.strictEqual(controller.store.get().researchSettings?.config.models.worker, "muse-spark-1.3");
      assert.strictEqual(controller.store.get().researchSettings?.config.models.writer, null, "the other models keep their value");
      client.setResearchSettings = async () => {
        throw new Error("nope");
      };
      await controller.setResearchSettings({ enabled: false });
      assert.strictEqual(controller.store.get().researchSettings?.enabled, true, "a refused patch is taken back");
      assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Could not change the research settings");
      controller.setResearchStopWrites(false);
      assert.strictEqual(controller.store.get().researchStopWrites, false);
      stopController();
    });
  });

  it("starts a thread beside one whose reasoning cannot be replayed", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(await controller.freshThread("s1", "pick this up again"), true);
    assert.strictEqual(client.sent.at(-1)?.text, "pick this up again");
    assert.strictEqual(controller.store.get().route.kind, "thread");

    // A prompt the transcript showed as `/goal …` runs as the goal command again, not as the literal text.
    const sent = client.sent.length;
    assert.strictEqual(await controller.freshThread("s1", "/goal ship the release"), true);
    assert.strictEqual(client.actions.at(-1), "goal:s1:set:ship the release");
    assert.strictEqual(client.sent.length, sent);
    stopController();
  });

  it("compacts a thread the provider will not take, then sends the prompt again", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    await controller.compactAndRetry("s1", "repeat query after compaction");
    assert.ok(client.actions.includes("compact"), "the history is summarized first");
    assert.strictEqual(client.sent.at(-1)?.text, "repeat query after compaction");
    assert.strictEqual(client.sent.at(-1)?.ifBusy, "queue", "the retry waits behind the compaction turn");

    let before = client.sent.length;
    await controller.compactAndRetry("s1", null);
    assert.strictEqual(client.sent.length, before, "with no prompt to resend, it only compacts");

    // A compaction Muse refused leaves the history exactly as it was, so resending would fail the same way.
    before = client.sent.length;
    client.compactNoop = true;
    await controller.compactAndRetry("s1", "repeat query after compaction");
    assert.strictEqual(client.sent.length, before, "nothing is resent after a noop compaction");
    client.compactNoop = false;
    client.compact = async () => {
      throw new Error("compact failed");
    };
    await controller.compactAndRetry("s1", "repeat query after compaction");
    assert.strictEqual(client.sent.length, before, "nor after one that failed");
    stopController();
  });

  it("clears a failed turn's notice when the user retries it", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    try {
      client.handler?.({
        type: "msp",
        sessionId: "s1",
        method: "turn/completed" as const,
        params: { sessionId: "s1", turnId: "t7", terminal: "failed", error: { kind: "rateLimit", message: "rate quota", retryable: true } },
        at: 5,
      });
      await settleController();
      assert.strictEqual(controller.store.get().threads["s1"]?.fold.turns["t7"]?.error?.message, "rate quota");

      controller.dismissTurnError("s1", "t7");
      const info = controller.store.get().threads["s1"]?.fold.turns["t7"];
      assert.strictEqual(info?.error, undefined);
      assert.strictEqual(info?.dismissed, true);
      // Remembered outside the fold too, which a reload rebuilds from history with the error back in it.
      assert.deepStrictEqual(controller.store.get().prefs.dismissedTurnErrors, ["s1:t7"]);
      controller.dismissTurnError("s1", "t7");
      assert.deepStrictEqual(controller.store.get().prefs.dismissedTurnErrors, ["s1:t7"]);
    } finally {
      stopController();
    }
  });

  it("reorders projects by drag, and puts them back when the server refuses", async () => {
    const client = new MockAncillaRpcClient();
    const project = (cwd: string) => ({ cwd, displayName: cwd.slice(6), pinned: false, activityAt: SESSION.activityAt, defaultAccountId: null, folders: [{ cwd, displayName: cwd.slice(6) }] });
    client.listProjects = async () => [project("/work/a"), project("/work/b"), project("/work/c")];
    const { controller, stop: stopController } = await started(client);
    const order = () => controller.store.get().projects.map((p) => p.cwd);

    await controller.reorderProjects("/work/c", "/work/a");
    assert.deepStrictEqual(order(), ["/work/c", "/work/a", "/work/b"]);
    assert.deepStrictEqual(client.orders.at(-1), ["/work/c", "/work/a", "/work/b"]);

    await controller.reorderProjects("/work/c", null);
    assert.deepStrictEqual(order(), ["/work/a", "/work/b", "/work/c"], "dropping past the last row sends it to the end");

    client.setProjectOrder = async () => {
      throw new Error("nope");
    };
    await controller.reorderProjects("/work/c", "/work/a");
    assert.deepStrictEqual(order(), ["/work/a", "/work/b", "/work/c"], "a refused move snaps back");
    stopController();
  });

  it("sends attached files with a prompt, and shows them while it is in flight", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    const sent = await controller.send("look at this", {
      attachments: [{ name: "shot.png", mediaType: "image/png", base64: "AAAB" }],
      previews: [{ name: "shot.png", mediaType: "image/png", kind: "image", url: "blob:preview" }],
    });
    assert.strictEqual(sent, true);
    assert.deepStrictEqual(client.sent.at(-1)?.attachments, [{ name: "shot.png", mediaType: "image/png", base64: "AAAB" }]);
    assert.strictEqual(controller.store.get().threads["s1"]?.fold.echoes.at(-1)?.attachments?.[0]?.url, "blob:preview");

    assert.strictEqual(
      await controller.send("", { attachments: [{ name: "notes.pdf", mediaType: "application/pdf", base64: "AAAC" }] }),
      true,
      "a file with no text still sends",
    );
    assert.strictEqual(await controller.send(""), false, "nothing to send is still nothing");
    stopController();
  });

  for (const [transcriptFirst, folder] of [[true, ".ancilla"], [false, ".ancilla"], [true, ".ancilla-alt"], [false, ".ancilla-alt"]] as const) {
    it(`reconciles one PDF and image send when its transcript (${folder}) arrives ${transcriptFirst ? "before" : "after"} the ack`, async () => {
      const client = new MockAncillaRpcClient();
      let acknowledge!: (ack: { turnId: string | null; disposition: string | null }) => void;
      client.sendResult = () => new Promise((resolve) => { acknowledge = resolve; });
      const { controller, stop: stopController } = await started(client);
      const promptPayload = "Review the attached report and image";
      const fileAttachments = [
        { name: "report.pdf", mediaType: "application/pdf", base64: "JVBERi0x" },
        { name: "shot.png", mediaType: "image/png", base64: "iVBORw0K" },
      ];
      const emitMaterializeEvent = () => {
        client.handler?.({
          type: "msp", sessionId: "s1", method: "item/completed", at: 2,
          params: { sessionId: "s1", item: {
            itemId: "u9", kind: "userMessage", status: "completed" as const, revision: 1,
            turnId: "t9", commandId: "t9", text: `${promptPayload}\n\n@${folder}/attachments/report.pdf[Image #1]`,
          } },
        });
        controller.flush();
      };
      try {
        const sending = controller.send(promptPayload, { attachments: fileAttachments });
        assert.strictEqual(await controller.send(promptPayload, { attachments: fileAttachments }), true, "an overlapping submission shares the first send");
        if (transcriptFirst) emitMaterializeEvent();
        acknowledge({ turnId: "t9", disposition: "started" });
        assert.strictEqual(await sending, true);
        if (!transcriptFirst) emitMaterializeEvent();
        assert.strictEqual(client.sent.length, 1);
        assert.strictEqual(client.sent[0]?.text, promptPayload);
        assert.strictEqual(client.sent[0]?.displayText, promptPayload, "the original prompt is preserved for presentation");
        assert.deepStrictEqual(client.sent[0]?.attachments, fileAttachments);
        const fold = controller.store.get().threads["s1"]!.fold;
        assert.strictEqual(fold.echoes.length, 0, "the rewritten materialized prompt replaces its local echo");
        assert.strictEqual(fold.order.filter((id) => id === "u9").length, 1);
      } finally {
        stopController();
      }
    });
  }

  it("preserves a slash command's display text when it carries an attachment", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    try {
      assert.strictEqual(await controller.send("/init", {
        attachments: [{ name: "report.pdf", mediaType: "application/pdf", base64: "JVBERi0x" }],
      }), true);
      assert.strictEqual(client.sent.length, 1);
      assert.strictEqual(client.sent[0]?.displayText, "/init");
      assert.notEqual(client.sent[0]?.text, "/init", "the expanded instructions still reach the model");
    } finally {
      stopController();
    }
  });

  it("hands a `!` command the host could not run to the agent", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(await controller.askToRun("s1", "ls -la"), true);
    assert.match(client.sent.at(-1)?.text ?? "", /```sh\nls -la\n```/);
    assert.match(client.sent.at(-1)?.text ?? "", /your own shell works/, "the agent is told its own shell is fine");
    assert.strictEqual(await controller.askToRun("s1", "echo '```'"), true);
    assert.match(client.sent.at(-1)?.text ?? "", /````sh\necho '```'\n````/, "a fence in the command gets a longer fence around it");
    assert.strictEqual(await controller.askToRun("s1", "printf '~~~\\n'"), true);
    assert.match(client.sent.at(-1)?.text ?? "", /```sh\nprintf '~~~\\n'\n```/, "a tilde run in the command changes nothing");
    stopController();
  });

  it("forks a thread and opens the fork", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    // Opening the fork loads its transcript, which carries the fork's own summary.
    client.transcript = async () => load({ session: { ...SESSION, sessionId: "s2", title: "Probe (fork)" } });
    assert.strictEqual(await controller.send("/fork"), true);
    const state = controller.store.get();
    assert.deepStrictEqual(state.route, { kind: "thread", sessionId: "s2" });
    assert.strictEqual(state.sessions["s2"]?.title, "Probe (fork)");
    assert.strictEqual(state.toasts.at(-1)?.title, "Forked into a new thread");
    stopController();
  });

  it("walks interface zoom through its fixed steps and back to 100%", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    const zoom = () => controller.store.get().prefs.zoom;
    assert.strictEqual(zoom(), 1);
    controller.zoomIn();
    assert.strictEqual(zoom(), 1.1);
    controller.zoomIn();
    assert.strictEqual(zoom(), 1.2);
    controller.zoomOut();
    controller.zoomOut();
    assert.strictEqual(zoom(), 1);
    controller.zoomOut();
    assert.strictEqual(zoom(), 0.9);
    controller.resetZoom();
    assert.strictEqual(zoom(), 1);
    stopController();
  });

  it("clamps interface zoom to its ends and drops malformed saved values", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    controller.setZoom(5);
    assert.strictEqual(controller.store.get().prefs.zoom, ZOOM_MAX);
    controller.zoomIn();
    assert.strictEqual(controller.store.get().prefs.zoom, ZOOM_MAX);
    controller.setZoom(0.05);
    assert.strictEqual(controller.store.get().prefs.zoom, ZOOM_MIN);
    controller.zoomOut();
    assert.strictEqual(controller.store.get().prefs.zoom, ZOOM_MIN);
    controller.setZoom(1.234);
    assert.strictEqual(controller.store.get().prefs.zoom, 1.23);
    stopController();
    const revived = new AncillaController(client, { ...platform(), loadPrefs: () => ({ zoom: 99 }) });
    assert.strictEqual(revived.store.get().prefs.zoom, 1);
  });

  it("returns from settings and usage to the thread they were opened from", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    controller.navigate({ kind: "settings" });
    assert.deepStrictEqual(controller.store.get().route, { kind: "settings" });
    controller.goBack();
    assert.deepStrictEqual(controller.store.get().route, { kind: "thread", sessionId: "s1" });
    controller.navigate({ kind: "usage" });
    // Moving between the two pages keeps the thread as the way back, not the other page.
    controller.navigate({ kind: "settings" });
    controller.goBack();
    assert.deepStrictEqual(controller.store.get().route, { kind: "thread", sessionId: "s1" });
    stopController();
  });

  it("returns from settings to a fresh-thread route", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client, "");
    controller.newThread();
    assert.deepStrictEqual(controller.store.get().route, { kind: "new", cwd: "/work/app" });
    controller.navigate({ kind: "settings" });
    controller.goBack();
    assert.deepStrictEqual(controller.store.get().route, { kind: "new", cwd: "/work/app" });
    stopController();
  });

  it("falls back to home when there is nowhere to go back to", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client, "#/settings");
    assert.deepStrictEqual(controller.store.get().route, { kind: "settings" });
    controller.goBack();
    assert.deepStrictEqual(controller.store.get().route, { kind: "home" });
    stopController();
  });

  it("falls back to home when the return thread is gone", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    controller.navigate({ kind: "settings" });
    await controller.archive("s1");
    controller.goBack();
    assert.deepStrictEqual(controller.store.get().route, { kind: "home" });
    stopController();
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
async function startedWith(client: MockAncillaRpcClient, hash = "") {
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
  await settleController();
  await settleController();
  return { controller, stop, tearDown: stop, held, toasts };
}

const NEW_THREAD = "#/new/%2Fwork%2Fapp";

describe("model lists", () => {
  it("loads the default login's list at boot and files it with what Muse says about it", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK, WONDER];
    const { controller, tearDown } = await startedWith(client);
    const state = controller.store.get();
    assert.deepStrictEqual(state.accountModels["default"], [SPARK, WONDER]);
    assert.deepStrictEqual(state.models, [SPARK, WONDER]);
    assert.strictEqual(state.modelsStatus["default"]?.status, "ready");
    assert.strictEqual(state.modelsStatus["default"]?.error, null);
    assert.strictEqual(state.modelsStatus["default"]?.catalog?.source, "providerCatalog");
    assert.strictEqual(state.modelsStatus["default"]?.catalog?.hostVersion, "1.4.7");
    assert.strictEqual(typeof state.modelsStatus["default"]?.loadedAt, "number");
    assert.deepStrictEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }]);
    tearDown();
  });

  it("takes the rows alone from a transport that cannot say where its list came from", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    (client as { listModelCatalog?: unknown }).listModelCatalog = undefined;
    const { controller, tearDown } = await startedWith(client);
    const state = controller.store.get();
    assert.deepStrictEqual(state.models, [SPARK]);
    assert.strictEqual(state.modelsStatus["default"]?.status, "ready");
    assert.strictEqual(state.modelsStatus["default"]?.catalog?.source, null);
    tearDown();
  });

  it("says why a failed first load failed and tries once more shortly", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [new Error("Could not start Muse")];
    client.models = [WONDER];
    const { controller, tearDown, held } = await startedWith(client);
    let state = controller.store.get();
    assert.strictEqual(state.modelsStatus["default"]?.status, "error");
    assert.strictEqual(state.modelsStatus["default"]?.error, "Could not start Muse");
    assert.deepStrictEqual(state.models, []);
    assert.deepStrictEqual(held.waiting(), [3_000], "one retry is waiting");
    held.fire(3_000);
    await settleController();
    state = controller.store.get();
    assert.strictEqual(state.modelsStatus["default"]?.status, "ready");
    assert.strictEqual(state.modelsStatus["default"]?.error, null);
    assert.deepStrictEqual(state.models, [WONDER]);
    assert.strictEqual(client.modelCalls.length, 2);
    tearDown();
  });

  it("gives up after the one retry and leaves the picker to ask again", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [new Error("first"), new Error("second")];
    client.models = [WONDER];
    const { controller, tearDown, held } = await startedWith(client);
    held.fire(3_000);
    await settleController();
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.error, "second");
    assert.deepStrictEqual(held.waiting(), [], "no third try on its own");
    assert.strictEqual(client.modelCalls.length, 2);
    controller.setPicker("model");
    await settleController();
    assert.strictEqual(client.modelCalls.length, 3, "opening the picker is the way to ask again");
    assert.deepStrictEqual(controller.store.get().models, [WONDER]);
    tearDown();
  });

  it("reads a stale list again when the picker opens, once, and leaves a fresh one be", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [new Error("offline")];
    client.models = [SPARK];
    const { controller, tearDown, held } = await startedWith(client);
    controller.setPicker("model");
    await settleController();
    assert.strictEqual(client.modelCalls.length, 2, "exactly one extra ask");
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.status, "ready");
    assert.strictEqual(controller.store.get().models.length, 1);
    controller.setPicker(null);
    controller.setPicker("model");
    await settleController();
    assert.strictEqual(client.modelCalls.length, 2, "a list younger than ten minutes is left be");
    held.clock.now += 11 * 60_000;
    controller.setPicker(null);
    controller.setPicker("model");
    await settleController();
    assert.strictEqual(client.modelCalls.length, 3, "an older one is read again");
    tearDown();
  });

  it("keeps the last good list when a refresh fails, and says why", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown } = await startedWith(client);
    const before = controller.store.get().modelsStatus["default"];
    client.modelQueue = [new Error("Muse is not answering")];
    await controller.refreshModels({ force: true });
    const state = controller.store.get();
    assert.strictEqual(state.modelsStatus["default"]?.status, "error");
    assert.strictEqual(state.modelsStatus["default"]?.error, "Muse is not answering");
    assert.deepStrictEqual(state.accountModels["default"], [SPARK]);
    assert.deepStrictEqual(state.models, [SPARK]);
    assert.strictEqual(state.modelsStatus["default"]?.loadedAt, before?.loadedAt, "the time of the last good answer is kept");
    assert.deepStrictEqual(state.modelsStatus["default"]?.catalog, before?.catalog);
    tearDown();
  });

  it("keeps the newer answer when two asks overlap", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown } = await startedWith(client);
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
    assert.deepStrictEqual(controller.store.get().models, [WONDER]);
    release();
    await older;
    assert.deepStrictEqual(controller.store.get().models, [WONDER], "the older answer is dropped");
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.status, "ready");
    tearDown();
  });

  it("does not ask again for a list it is already asking for", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown, held } = await startedWith(client);
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
    assert.strictEqual(client.modelCalls.length, 2, "one ask in flight, not two");
    release();
    await Promise.all([first, second]);
    assert.deepStrictEqual(controller.store.get().models, [WONDER]);
    tearDown();
  });

  it("reads a thread's account catalog when its host has not loaded the thread", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown } = await startedWith(client);
    client.modelQueue = [new AncillaError("Session is not loaded.", 409, "sessionNotLoaded"), [SPARK, WONDER]];
    await controller.refreshModels({ sessionId: "s1" });
    assert.deepStrictEqual(client.modelCalls.slice(1), [
      { sessionId: "s1", accountId: undefined },
      { sessionId: undefined, accountId: undefined },
    ]);
    assert.deepStrictEqual(controller.store.get().accountModels["thread:s1"], [SPARK, WONDER]);
    assert.strictEqual(controller.store.get().modelsStatus["thread:s1"]?.status, "ready");
    tearDown();
  });

  it("keeps each catalog under its own key and merges them for lookups", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown } = await startedWith(client);
    client.modelQueue = [[WONDER, SPARK]];
    await controller.refreshModels({ accountId: "work" });
    client.modelQueue = [[WONDER_FULL]];
    await controller.refreshModels({ sessionId: "s1" });
    const state = controller.store.get();
    assert.deepStrictEqual(state.accountModels["default"], [SPARK]);
    assert.deepStrictEqual(state.accountModels["acct:work"], [WONDER, SPARK]);
    assert.deepStrictEqual(state.accountModels["thread:s1"], [WONDER_FULL]);
    assert.deepStrictEqual(state.models.map((m) => m.modelId), ["muse-spark-1.3", "muse-wonder-1.0", "muse-wonder-full-1.0"], "the default login's first, each model once");
    assert.deepStrictEqual(client.modelCalls, [
      { sessionId: undefined, accountId: undefined },
      { sessionId: undefined, accountId: "work" },
      { sessionId: "s1", accountId: undefined },
    ]);
    tearDown();
  });

  it("holds at most eight threads' lists, letting the one asked for longest ago go", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, tearDown } = await startedWith(client);
    for (let i = 0; i < 10; i += 1) {
      client.modelQueue = [[model(`only-in-${i}`)]];
      await controller.refreshModels({ sessionId: `t${i}` });
    }
    const state = controller.store.get();
    const threadKeys = Object.keys(state.accountModels).filter((key) => key.startsWith("thread:"));
    assert.strictEqual(threadKeys.length, 8);
    assert.ok(!threadKeys.includes("thread:t0") && !threadKeys.includes("thread:t1"));
    assert.ok(threadKeys.includes("thread:t9"));
    assert.strictEqual(state.modelsStatus["thread:t0"], undefined);
    assert.ok(!state.models.some((m) => m.modelId === "only-in-0"), "what only a dropped list offered is gone from the lookup too");
    assert.ok(state.models.some((m) => m.modelId === "only-in-9"));
    tearDown();
  });

  it("reads the open thread's own list when its load finishes, and the project's account list on the new-thread screen", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown } = await startedWith(client, "#/t/s1");
    assert.deepStrictEqual(client.modelCalls, [
      { sessionId: undefined, accountId: undefined },
      { sessionId: "s1", accountId: undefined },
    ]);
    assert.strictEqual(controller.store.get().modelsStatus["thread:s1"]?.status, "ready");
    assert.deepStrictEqual(controller.modelsScope(), { sessionId: "s1" });
    controller.setProjectDefaultAccount("/work/app", "work").catch(() => undefined);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    assert.deepStrictEqual(controller.modelsScope(), { accountId: "work" });
    await settleController();
    assert.deepStrictEqual(client.modelCalls.at(-1), { sessionId: undefined, accountId: "work" });
    assert.strictEqual(controller.store.get().modelsStatus["acct:work"]?.status, "ready");
    tearDown();
  });

  it("reads the account's own list when a project's default account changes", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown } = await startedWith(client, NEW_THREAD);
    assert.strictEqual(client.modelCalls.length, 1, "the project is on the default login, whose list boot read");
    client.modelQueue = [[SPARK, WONDER]];
    await controller.setProjectDefaultAccount("/work/app", "work");
    await settleController();
    assert.deepStrictEqual(client.modelCalls.at(-1), { sessionId: undefined, accountId: "work" });
    assert.deepStrictEqual(controller.store.get().accountModels["acct:work"], [SPARK, WONDER]);
    assert.deepStrictEqual(controller.modelsScope(), { accountId: "work" });
    tearDown();
  });

  it("shows the default list for an account whose load failed, but only for display", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown } = await startedWith(client);
    client.modelQueue = [new Error("Sign in to read this account's models")];
    await controller.refreshModels({ accountId: "work" });
    const state = controller.store.get();
    assert.strictEqual(state.modelsStatus["acct:work"]?.status, "error");
    assert.deepStrictEqual(state.accountModels["acct:work"], []);
    assert.deepStrictEqual(state.accountModels["default"], [SPARK], "the default login's own list is untouched");
    const shown = modelsShown(state, { accountId: "work" });
    assert.deepStrictEqual(shown.models, [SPARK]);
    assert.strictEqual(shown.fallback, true);
    tearDown();
  });

  it("never asks an account that has no login, until it has one", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    client.accounts = [{ id: "work", name: "Work", hasLogin: false, email: null, lastUsedAt: null as string | null }];
    const { controller, tearDown } = await startedWith(client);
    await controller.loadAccounts();
    await controller.refreshModels({ accountId: "work" });
    await controller.refreshModels({ accountId: "work", force: true });
    assert.ok(!client.modelCalls.some((call) => call.accountId === "work"), "no ask for an account that cannot answer");
    assert.strictEqual(controller.store.get().modelsStatus["acct:work"], undefined);
    client.loginAccountResult = { url: "https://auth.meta.com/?code=C", code: "C", loginId: "attempt" };
    client.accountLoginProgress = async () => ({ status: "done" });
    const account = client.accounts[0];
    assert.ok(account);
    account.hasLogin = true;
    await controller.beginLogin("work");
    await controller.checkLogin();
    await settleController();
    assert.deepStrictEqual(client.modelCalls.at(-1), { sessionId: undefined, accountId: "work" }, "a finished sign-in reads the account's list");
    assert.strictEqual(controller.store.get().modelsStatus["acct:work"]?.status, "ready");
    controller.cancelLogin();
    tearDown();
  });

  it("reads the project's account list on the home screen too, since its composer is the new-thread one", async () => {
    const client = new MockAncillaRpcClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.modelQueue = [[SPARK], [SPARK, WONDER]];
    const { controller, tearDown, toasts } = await startedWith(client);
    assert.deepStrictEqual(controller.store.get().route, { kind: "home" });
    assert.deepStrictEqual(controller.modelsScope(), { accountId: "work" });
    assert.deepStrictEqual(client.modelCalls, [
      { sessionId: undefined, accountId: undefined },
      { sessionId: undefined, accountId: "work" },
    ]);
    assert.deepStrictEqual(controller.store.get().accountModels["acct:work"], [SPARK, WONDER]);
    // A model only the account lists is a pick from its list, not a model Muse did not list.
    assert.strictEqual(await controller.setModel("muse-wonder-1.0"), true);
    assert.ok(!toasts.some((t) => /did not list/.test(t.title)));
    // Part of its name finds it there, instead of being saved as it was typed.
    controller.clearModelPref();
    assert.strictEqual(await controller.send("/model wonder"), true);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.strictEqual(client.modelCalls.length, 2, "no read for a list that already had it");
    // A last project that is no project's falls to the default login, as a thread started there would.
    controller.setPrefs({ lastProject: "/gone" });
    assert.deepStrictEqual(controller.modelsScope(), { accountId: null });
    tearDown();
  });

  it("reads a stale list when the new-thread screen or Settings opens, and when threads are refreshed by hand", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [new Error("offline")];
    client.models = [SPARK];
    const { controller, tearDown, held } = await startedWith(client, "#/t/s1");
    assert.strictEqual(client.modelCalls.length, 2, "the failed boot read, and the open thread's");
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.status, "error");
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await settleController();
    assert.strictEqual(client.modelCalls.length, 2, "a list that failed a moment ago is not asked for again by moving around");
    held.clock.now += 61_000;
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await settleController();
    assert.strictEqual(client.modelCalls.length, 3, "the new-thread screen reads the list that failed, once a minute has passed");
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.status, "ready");
    held.clock.now += 11 * 60_000;
    controller.navigate({ kind: "settings" });
    await settleController();
    assert.strictEqual(client.modelCalls.length, 4, "Settings reads a list that went stale");
    held.clock.now += 11 * 60_000;
    await controller.discoverAll(true);
    await settleController();
    assert.strictEqual(client.modelCalls.length, 4, "the quiet refresh at boot leaves the lists be");
    await controller.discoverAll();
    await settleController();
    assert.strictEqual(client.modelCalls.length, 5, "refreshing threads by hand looks at the models again");
    tearDown();
  });

  it("does not ask for a read-only thread's own list, which cannot switch models", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    client.transcript = async () => load({ readOnly: true, readOnlyReason: "Another Muse session has it open." });
    const { controller, tearDown } = await startedWith(client, "#/t/s1");
    assert.strictEqual(controller.store.get().threads["s1"]?.readOnly, true);
    assert.deepStrictEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }]);
    assert.strictEqual(controller.store.get().modelsStatus["thread:s1"], undefined);
    tearDown();
  });

  it("reads the lists in use again when a host restarts, and marks the others old", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown } = await startedWith(client, "#/t/s1");
    await controller.refreshModels({ accountId: "work" });
    assert.strictEqual(client.modelCalls.length, 3);
    client.handler?.({ type: "host", key: "k", state: "restarted", message: "The Muse host restarted." });
    await settleController();
    assert.strictEqual(client.modelCalls.length, 5, "the default login's list and the open thread's");
    assert.deepStrictEqual(client.modelCalls.slice(3).map((call) => call.sessionId), [undefined, "s1"]);
    const work = controller.store.get().modelsStatus["acct:work"];
    assert.strictEqual(work?.status, "idle", "another account's list waits until it is wanted");
    assert.deepStrictEqual(controller.store.get().accountModels["acct:work"], [SPARK], "and is kept meanwhile");
    client.handler?.({ type: "host", key: "k", state: "failed", message: "boom" });
    await settleController();
    assert.strictEqual(client.modelCalls.length, 5, "a host that could not start has no list to read");
    tearDown();
  });

  it("reads once for a restart that reports once per host, and again for the next restart", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown } = await startedWith(client);
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
    assert.strictEqual(await controller.restartMuse(), true);
    release();
    await settleController();
    assert.strictEqual(client.modelCalls.length, before + 1, "the read under way is the one that sees the new hosts");
    assert.deepStrictEqual(controller.store.get().models, [SPARK, WONDER]);
    client.handler?.({ type: "host", key: "default", state: "restarted", message: "The Muse host restarted." });
    await settleController();
    assert.strictEqual(client.modelCalls.length, before + 2, "a finished read does not stand in for the next restart's");
    tearDown();
  });

  it("asks nothing of a host that exited, and reads again only when a list is wanted", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown } = await startedWith(client, "#/t/s1");
    assert.strictEqual(client.modelCalls.length, 2);
    // A host that dies as it starts would be started again by each read: an exit must not cause one.
    for (let i = 0; i < 3; i += 1) {
      client.handler?.({ type: "host", key: "k", state: "exited", message: "The Muse host exited." });
      await settleController();
    }
    assert.strictEqual(client.modelCalls.length, 2, "no read, however often the host exits");
    for (const key of ["default", "thread:s1"]) {
      assert.strictEqual(controller.store.get().modelsStatus[key]?.status, "idle", `${key} is marked old`);
      assert.deepStrictEqual(controller.store.get().accountModels[key], [SPARK], `${key} keeps showing what it had`);
    }
    controller.setPicker("model");
    await settleController();
    assert.strictEqual(client.modelCalls.length, 3, "opening the picker reads the open thread's list");
    assert.strictEqual(client.modelCalls.at(-1)?.sessionId, "s1");
    assert.strictEqual(controller.store.get().modelsStatus["thread:s1"]?.status, "ready");
    tearDown();
  });

  it("restarts Muse and reads the list again, but not while a turn runs", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown, toasts } = await startedWith(client);
    assert.strictEqual(await controller.restartMuse(), true);
    await settleController();
    assert.strictEqual(client.restarts, 1);
    assert.strictEqual(client.modelCalls.length, 2, "the list is read from the host that starts next");
    client.restartError = new AncillaError("A turn is still open.", 409);
    assert.strictEqual(await controller.restartMuse(), false);
    assert.strictEqual(toasts.at(-1)?.title, "Could not restart Muse");
    assert.strictEqual(toasts.at(-1)?.detail, "A turn is still open.");
    assert.strictEqual(controller.store.get().busy["models:restart"], undefined);
    tearDown();
  });

  it("does not ask the server to restart Muse while it can see a turn running", async () => {
    const client = new MockAncillaRpcClient();
    const running: SessionSummary = {
      ...SESSION,
      live: { activeTurnId: "t1", turnStartedAt: null, pendingApprovals: 0, pendingInputs: 0, lastTerminal: null, lastError: null },
    };
    client.listSessions = async () => [running];
    const { controller, tearDown, toasts } = await startedWith(client);
    assert.strictEqual(await controller.restartMuse(), false);
    assert.strictEqual(client.restarts, 0);
    assert.strictEqual(toasts.at(-1)?.title, "Work is still running");
    tearDown();
  });
});

describe("a model list that is only Muse's built-in one", () => {
  it("is asked for again on the schedule, until the plan's own list arrives", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [
      { models: [SPARK], source: "bundledCatalog" },
      { models: [SPARK], source: "bundledCatalog" },
      { models: [SPARK, WONDER], source: "providerCatalog" },
    ];
    const { controller, tearDown, held } = await startedWith(client);
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.catalog?.source, "bundledCatalog");
    assert.deepStrictEqual(held.waiting(), [2_000]);
    held.fire(2_000);
    await settleController();
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.catalog?.source, "bundledCatalog");
    assert.deepStrictEqual(held.waiting(), [10_000]);
    held.fire(10_000);
    await settleController();
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.catalog?.source, "providerCatalog");
    assert.deepStrictEqual(controller.store.get().models, [SPARK, WONDER]);
    assert.deepStrictEqual(held.waiting(), [], "the plan's list ends the asking");
    assert.strictEqual(client.modelCalls.length, 3);
    tearDown();
  });

  it("is asked for three more times at most", async () => {
    const client = new MockAncillaRpcClient();
    client.modelSource = "bundledCatalog";
    client.models = [SPARK];
    const { controller, tearDown, held } = await startedWith(client);
    for (const wait of [2_000, 10_000, 30_000]) {
      assert.deepStrictEqual(held.waiting(), [wait]);
      held.fire(wait);
      await settleController();
    }
    assert.deepStrictEqual(held.waiting(), []);
    assert.strictEqual(client.modelCalls.length, 4);
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.status, "ready");
    tearDown();
  });

  it("is never fresh enough to leave be when the picker opens", async () => {
    const client = new MockAncillaRpcClient();
    client.modelSource = "bundledCatalog";
    client.models = [SPARK];
    const { controller, tearDown } = await startedWith(client);
    assert.strictEqual(client.modelCalls.length, 1);
    controller.setPicker("model");
    await settleController();
    assert.strictEqual(client.modelCalls.length, 2);
    tearDown();
  });

  it("starts the asking over when a host restarts, and lets the older chain end", async () => {
    const client = new MockAncillaRpcClient();
    client.modelSource = "bundledCatalog";
    client.models = [SPARK];
    const { controller, tearDown, held } = await startedWith(client);
    client.handler?.({ type: "host", key: "k", state: "restarted", message: "The Muse host restarted." });
    await settleController();
    assert.strictEqual(client.modelCalls.length, 2);
    assert.deepStrictEqual(held.waiting(), [2_000, 2_000], "the old chain's timer and the new one's");
    held.fire(2_000);
    await settleController();
    assert.strictEqual(client.modelCalls.length, 3, "only the newer chain asks");
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.status, "ready");
    tearDown();
  });

  it("stops asking when the host it was waiting on exits", async () => {
    const client = new MockAncillaRpcClient();
    client.modelSource = "bundledCatalog";
    client.models = [SPARK];
    const { controller, tearDown, held } = await startedWith(client);
    assert.deepStrictEqual(held.waiting(), [2_000]);
    client.handler?.({ type: "host", key: "k", state: "exited", message: "The Muse host exited." });
    await settleController();
    held.fire(2_000);
    await settleController();
    assert.strictEqual(client.modelCalls.length, 1, "a host that went away is not started again to be asked");
    assert.deepStrictEqual(held.waiting(), []);
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.status, "idle");
    tearDown();
  });

  it("keeps asking after a sign-in until the account's own list arrives", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    client.accounts = [{ id: "work", name: "Work", hasLogin: false, email: null, lastUsedAt: null as string | null }];
    const { controller, tearDown, held } = await startedWith(client);
    await controller.loadAccounts();
    client.loginAccountResult = { url: "https://auth.meta.com/?code=C", code: "C", loginId: "attempt" };
    client.accountLoginProgress = async () => ({ status: "done" });
    const account = client.accounts[0];
    assert.ok(account);
    account.hasLogin = true;
    client.modelQueue = [{ models: [SPARK], source: "bundledCatalog" }];
    await controller.beginLogin("work");
    await controller.checkLogin();
    await settleController();
    assert.deepStrictEqual(client.modelCalls.at(-1), { sessionId: undefined, accountId: "work" });
    assert.strictEqual(controller.store.get().modelsStatus["acct:work"]?.catalog?.source, "bundledCatalog");
    assert.deepStrictEqual(held.waiting(), [2_000], "Muse answers with its built-in list for a moment after a sign-in");
    client.modelQueue = [{ models: [SPARK, WONDER], source: "providerCatalog" }];
    held.fire(2_000);
    await settleController();
    assert.deepStrictEqual(controller.store.get().accountModels["acct:work"], [SPARK, WONDER]);
    assert.deepStrictEqual(held.waiting(), []);
    controller.cancelLogin();
    tearDown();
  });
});

describe("choosing a model", () => {
  it("leaves the default alone when Muse refuses the switch, and writes it once Muse takes it", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK, WONDER];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    controller.setPrefs({ defaultModelId: "muse-spark-1.3" });
    const before = controller.store.get().threads["s1"]?.fold.meta.modelId;
    assert.ok(before);
    client.setModelError = new Error("Your plan does not include this model");
    assert.strictEqual(await controller.setModel("muse-wonder-1.0"), false);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-spark-1.3", "the refused model is not what new threads start on");
    assert.strictEqual(controller.store.get().threads["s1"]?.fold.meta.modelId, before, "the thread is put back");
    assert.deepStrictEqual(toasts.filter((t) => t.title === "Could not switch models"), [{ title: "Could not switch models", detail: "Your plan does not include this model" }]);
    assert.strictEqual(await controller.setModel("muse-wonder-1.0"), true);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.strictEqual(controller.store.get().threads["s1"]?.fold.meta.modelId, "muse-wonder-1.0");
    assert.deepStrictEqual(client.modelSwitches.map((s) => s.modelId), ["muse-wonder-1.0", "muse-wonder-1.0"]);
    tearDown();
  });

  it("shows the Contributor notice once, after the switch has taken, and leaves it unspent when the switch is refused", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK, SPARK_CONTRIBUTOR];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    const notices = () => toasts.filter((t) => t.title === "Contributor model selected").length;
    client.setModelError = new Error("no");
    assert.strictEqual(await controller.setModel("muse-spark-1.3-contributor"), false);
    assert.strictEqual(notices(), 0, "a refused switch said nothing about a model the thread never moved to");
    assert.strictEqual(controller.store.get().prefs.contributorAck, false, "and spent nothing");
    assert.strictEqual(await controller.setModel("muse-spark-1.3-contributor"), true);
    assert.strictEqual(notices(), 1);
    assert.strictEqual(controller.store.get().prefs.contributorAck, true);
    await controller.setModel("muse-spark-1.3-contributor");
    assert.strictEqual(notices(), 1);
    tearDown();
  });

  it("sets Muse default without switching the thread, and says once when that is a Contributor model", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK_CONTRIBUTOR, SPARK];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    controller.setPrefs({ defaultModelId: "muse-spark-1.3" });
    controller.clearModelPref();
    assert.strictEqual(controller.store.get().prefs.defaultModelId, null);
    assert.deepStrictEqual(client.modelSwitches, [], "no model is switched");
    const notice = toasts.find((t) => t.title.startsWith("Muse's default is"));
    assert.strictEqual(notice?.title, "Muse's default is muse-spark-1.3, a Contributor model");
    assert.match(notice?.detail ?? "", /product improvement/);
    assert.strictEqual(controller.store.get().prefs.contributorAck, true);
    controller.clearModelPref();
    assert.strictEqual(toasts.filter((t) => t.title.startsWith("Muse's default is")).length, 1, "said once");
    assert.ok(!toasts.some((t) => t.title === "New threads will use Muse's default"), "new threads already follow Muse: nothing changed, nothing said");
    // Once a model is saved again, choosing Muse default on the thread says that only new threads follow it.
    controller.setPrefs({ defaultModelId: "muse-spark-1.3" });
    controller.clearModelPref();
    assert.deepStrictEqual(toasts.filter((t) => t.title === "New threads will use Muse's default"), [
      { title: "New threads will use Muse's default", detail: "This thread stays on muse-spark-1.3." },
    ]);
    assert.strictEqual(toasts.filter((t) => t.title.startsWith("Muse's default is")).length, 1, "the Contributor notice stays once");
    tearDown();
  });

  it("lets only the latest of two overlapping switches put the thread back or write the default", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK, SPARK_12, WONDER];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    const modelOf = () => controller.store.get().threads["s1"]?.fold.meta.modelId;
    // The first switch is held while a second is made and taken; then Muse refuses the first.
    let refuse!: (error: Error) => void;
    client.modelGates = [
      new Promise<void>((_, reject) => {
        refuse = reject;
      }),
    ];
    const first = controller.setModel("muse-wonder-1.0");
    assert.strictEqual(await controller.setModel("muse-spark-1.2"), true);
    refuse(new Error("Your plan does not include this model"));
    assert.strictEqual(await first, false);
    assert.strictEqual(modelOf(), "muse-spark-1.2", "the older refusal does not put the thread back on the model before it");
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-spark-1.2");
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
    assert.strictEqual(await controller.setModel("muse-spark-1.3"), false);
    accept();
    assert.strictEqual(await older, true);
    assert.strictEqual(modelOf(), "muse-wonder-1.0", "the thread is on the model Muse took last");
    assert.strictEqual(controller.store.get().prefs.defaultModelId, null, "an older switch does not write the default over a newer one");
    tearDown();
  });

  it("takes a model id on trust while Muse's list is empty, since an empty list says nothing about it", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    assert.strictEqual(await controller.setModel("muse-wonder-1.0"), true);
    assert.deepStrictEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-wonder-1.0" }]);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0", "it is a pick, not a try");
    assert.ok(!toasts.some((t) => /did not list/.test(t.title)));
    tearDown();
  });

  it("judges a saved model by the list of the account the thread will run on, not the default login's", async () => {
    const client = new MockAncillaRpcClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.modelQueue = [[SPARK, WONDER], [SPARK]];
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "muse-wonder-1.0" });
    assert.strictEqual(await controller.send("hello"), true);
    assert.strictEqual(client.startCalls.at(-1)?.accountId, "work");
    assert.strictEqual(client.startCalls.at(-1)?.modelId, undefined, "the default login offers it, the account does not");
    assert.deepStrictEqual(
      toasts.filter((t) => /not offered on this account/.test(t.title)).map((t) => t.title),
      ["muse-wonder-1.0 is not offered on this account; using Muse's default"],
    );
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    tearDown();
  });

  it("starts a new thread on Muse's default, saying so once, when the account's list lacks the saved model", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK, WONDER];
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "retired-x" });
    assert.strictEqual(await controller.send("hello"), true);
    assert.strictEqual(client.startCalls.at(-1)?.modelId, undefined);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "retired-x", "the saved choice is kept: it may be right for another account");
    const notes = () => toasts.filter((t) => /not offered on this account/.test(t.title));
    assert.deepStrictEqual(notes().map((t) => t.title), ["retired-x is not offered on this account; using Muse's default"]);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    assert.strictEqual(await controller.send("again"), true);
    assert.strictEqual(client.startCalls.at(-1)?.modelId, undefined);
    assert.strictEqual(notes().length, 1, "the note is not repeated for every thread");
    tearDown();
  });

  it("starts on the saved model when the list offers it", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK, WONDER];
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "muse-wonder-1.0" });
    await controller.send("hello");
    assert.strictEqual(client.startCalls.at(-1)?.modelId, "muse-wonder-1.0");
    assert.ok(!toasts.some((t) => /not offered/.test(t.title)));
    tearDown();
  });

  it("leaves a saved model alone when the list is only Muse's built-in one, or still unread", async () => {
    const client = new MockAncillaRpcClient();
    client.modelSource = "bundledCatalog";
    client.models = [SPARK];
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "muse-wonder-1.0" });
    await controller.send("hello");
    assert.strictEqual(client.startCalls.at(-1)?.modelId, "muse-wonder-1.0", "a built-in list proves nothing about the plan");
    assert.ok(!toasts.some((t) => /not offered/.test(t.title)));
    tearDown();
    const unread = new MockAncillaRpcClient();
    unread.modelQueue = [new Error("offline")];
    const second = await startedWith(unread, NEW_THREAD);
    second.controller.setPrefs({ defaultModelId: "muse-wonder-1.0" });
    await second.controller.send("hello");
    assert.strictEqual(unread.startCalls.at(-1)?.modelId, "muse-wonder-1.0", "no list, no verdict");
    second.stop();
  });

  it("lets an id tried by hand through a plan list that does not offer it", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    assert.strictEqual(await controller.setModel("muse-wonder-1.0"), true);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.deepStrictEqual(client.modelSwitches, [], "there is no thread to switch");
    assert.deepStrictEqual(toasts.filter((t) => /did not list/.test(t.title)), [
      { title: "Using muse-wonder-1.0, which your Muse did not list", detail: "Muse checks access when you send a prompt." },
    ]);
    await controller.send("hello");
    assert.strictEqual(client.startCalls.at(-1)?.modelId, "muse-wonder-1.0", "the pin check leaves a model the user asked for by id");
    tearDown();
  });

  it("refuses text that is not shaped like a model id", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    assert.strictEqual(await controller.setModel("not a model!"), false);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, null);
    assert.strictEqual(toasts.at(-1)?.title, "That is not a model id");
    assert.strictEqual(toasts.at(-1)?.detail, modelIdError("not a model!"), "the toast and the field say the same thing");
    assert.match(toasts.at(-1)?.detail ?? "", /starts with a letter or digit/);
    tearDown();
  });

  it("notes once that Muse's default is a Contributor model when nothing is saved", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK_CONTRIBUTOR, SPARK];
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    await controller.send("hello");
    assert.strictEqual(client.startCalls.at(-1)?.modelId, undefined);
    assert.strictEqual(toasts.filter((t) => t.title.startsWith("Muse's default is")).length, 1);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await controller.send("again");
    assert.strictEqual(toasts.filter((t) => t.title.startsWith("Muse's default is")).length, 1);
    tearDown();
  });
});

describe("/model", () => {
  it("picks the regular model over its Contributor twin, and finds a model by part of its name", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK_CONTRIBUTOR, SPARK, WONDER];
    const { controller, tearDown } = await startedWith(client, "#/t/s1");
    assert.strictEqual(await controller.send("/model muse-spark-1.3"), true);
    assert.strictEqual(client.modelSwitches.at(-1)?.modelId, "muse-spark-1.3");
    assert.strictEqual(await controller.send("/model muse-spark-1.3-contributor"), true);
    assert.strictEqual(client.modelSwitches.at(-1)?.modelId, "muse-spark-1.3-contributor");
    assert.strictEqual(await controller.send("/model wonder"), true);
    assert.strictEqual(client.modelSwitches.at(-1)?.modelId, "muse-wonder-1.0");
    assert.strictEqual(await controller.send("/model muse wonder 1.0"), true);
    assert.strictEqual(client.modelSwitches.at(-1)?.modelId, "muse-wonder-1.0");
    tearDown();
  });

  it("reads the list again once on a miss and then finds the model", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    const asked = client.modelCalls.length;
    client.modelQueue = [[SPARK, WONDER]];
    assert.strictEqual(await controller.send("/model muse-wonder-1.0"), true);
    assert.strictEqual(client.modelCalls.length, asked + 1, "one more ask, for the open thread");
    assert.strictEqual(client.modelCalls.at(-1)?.sessionId, "s1");
    assert.deepStrictEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-wonder-1.0" }]);
    assert.ok(!toasts.some((t) => /No model named/.test(t.title)));
    assert.ok(!toasts.some((t) => /did not list/.test(t.title)), "it is a listed model by then");
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    tearDown();
  });

  it("tries a model still missing from the list on the open thread alone", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    assert.strictEqual(await controller.send("/model muse-wonder-2.0"), true);
    assert.deepStrictEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-wonder-2.0" }], "the bare id goes to Muse");
    assert.strictEqual(controller.store.get().prefs.defaultModelId, null, "new threads do not follow it");
    assert.strictEqual(controller.store.get().threads["s1"]?.fold.meta.modelId, "muse-wonder-2.0");
    assert.ok(toasts.some((t) => t.title === "Using muse-wonder-2.0, which your Muse did not list"));
    tearDown();
  });

  it("rolls a refused try back and keeps it out of the defaults", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    const before = controller.store.get().threads["s1"]?.fold.meta.modelId;
    client.setModelError = new Error("Muse does not serve that model");
    assert.strictEqual(await controller.send("/model muse-wonder-2.0"), false);
    assert.strictEqual(controller.store.get().threads["s1"]?.fold.meta.modelId, before);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, null);
    assert.deepStrictEqual(toasts.at(-1), { title: "Could not switch models", detail: "Muse does not serve that model" });
    tearDown();
  });

  it("sets the default on the new-thread screen for a model still missing, without switching anything", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    assert.strictEqual(await controller.send("/model muse-wonder-2.0"), true);
    assert.deepStrictEqual(client.modelSwitches, []);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-2.0");
    assert.ok(toasts.some((t) => /did not list/.test(t.title)));
    tearDown();
  });

  it("says no model is named that when the text cannot be an id", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    assert.strictEqual(await controller.send("/model not a model"), false);
    assert.deepStrictEqual(client.modelSwitches, []);
    assert.strictEqual(toasts.at(-1)?.title, "No model named not a model");
    tearDown();
  });

  it("opens the picker when the name fits models of different families", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [WONDER, WONDER_FULL];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    assert.strictEqual(await controller.send("/model wonder"), true);
    assert.strictEqual(controller.store.get().picker, "model");
    assert.deepStrictEqual(client.modelSwitches, [], "nothing is guessed");
    assert.ok(toasts.some((t) => t.title === "More than one model fits wonder"));
    tearDown();
  });
});

describe("reasoning effort and the model", () => {
  it("keeps the level asked for and runs turns at what the model offers", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK, SPARK_12, model("muse-plain")];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    const effortToasts = () => toasts.filter((t) => / is not available on /.test(t.title));
    controller.setEffort("max");
    assert.strictEqual(effortToasts().length, 0, "the open thread's model has Max");
    assert.deepStrictEqual(client.efforts, ["s1:max"]);
    await controller.setModel("muse-spark-1.2");
    assert.strictEqual(controller.store.get().prefs.effort, "max", "the saved level is never rewritten");
    assert.deepStrictEqual(effortToasts(), [
      { title: "Max is not available on muse-spark-1.2", detail: "Using Extra high. Your choice is kept for other models." },
    ]);
    await controller.send("go");
    assert.strictEqual(client.turnEfforts.at(-1), "xhigh");
    await controller.setModel("muse-spark-1.3");
    await controller.send("again");
    assert.strictEqual(client.turnEfforts.at(-1), "max", "another model gives the wish back");
    await controller.setModel("muse-plain");
    await controller.send("and again");
    assert.strictEqual(client.turnEfforts.at(-1), "max", "a model that lists no levels takes any");
    assert.strictEqual(effortToasts().length, 1);
    tearDown();
  });

  it("says a level does not fit once for each time the model is chosen, not for every turn", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK, SPARK_12];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    controller.setEffort("max");
    const notes = () => toasts.filter((t) => t.title === "Max is not available on muse-spark-1.2");
    await controller.setModel("muse-spark-1.2");
    assert.strictEqual(notes().length, 1);
    await controller.send("go");
    assert.strictEqual(notes().length, 1, "a turn on the model says nothing more");
    await controller.setModel("muse-spark-1.3");
    assert.strictEqual(notes().length, 1);
    await controller.setModel("muse-spark-1.2");
    assert.strictEqual(notes().length, 2, "back on it, the level it lacks is worth saying again");
    tearDown();
  });

  it("does not hold turns to the levels of Muse's built-in list, which can list fewer than the plan's", async () => {
    const client = new MockAncillaRpcClient();
    client.modelSource = "bundledCatalog";
    // Muse 1.4.7's built-in row for this model: no Max, though the plan's own list has it.
    client.models = [model("muse-spark-1.3", { efforts: ["minimal", "low", "medium", "high", "xhigh"] })];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    controller.setEffort("max");
    assert.deepStrictEqual(client.efforts, ["s1:max"], "the thread is told the level that was asked for");
    await controller.send("go");
    assert.strictEqual(client.turnEfforts.at(-1), "max");
    controller.setEffort("none");
    assert.strictEqual(client.efforts.at(-1), "s1:none");
    await controller.setModel("muse-spark-1.3");
    await controller.send("again");
    assert.strictEqual(client.turnEfforts.at(-1), "none");
    assert.ok(!toasts.some((t) => / is not available on /.test(t.title)));
    assert.strictEqual(controller.store.get().prefs.effort, "none");
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
    assert.strictEqual(client.efforts.at(-1), "s1:xhigh");
    assert.ok(toasts.some((t) => t.title === "Max is not available on muse-spark-1.3"));
    tearDown();
  });

  it("clamps /effort to the model, once, and keeps what was typed", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK, SPARK_12];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    await controller.setModel("muse-spark-1.2");
    assert.strictEqual(await controller.send("/effort max"), true);
    assert.strictEqual(controller.store.get().prefs.effort, "max");
    assert.strictEqual(client.efforts.at(-1), "s1:xhigh", "the thread is told what its model can run");
    assert.strictEqual(toasts.filter((t) => t.title === "Max is not available on muse-spark-1.2").length, 1);
    assert.strictEqual(await controller.send("/effort max"), true);
    assert.strictEqual(toasts.filter((t) => t.title === "Max is not available on muse-spark-1.2").length, 1, "said once");
    assert.strictEqual(await controller.send("/effort off"), true);
    assert.strictEqual(controller.store.get().prefs.effort, "none");
    assert.strictEqual(client.efforts.at(-1), "s1:minimal", "a model without Off starts at its lowest");
    assert.ok(toasts.some((t) => t.title === "Off is not available on muse-spark-1.2" && t.detail === "Using Minimal. Your choice is kept for other models."));
    tearDown();
  });

  it("leaves the level alone on a model that lists none, and with Auto", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [model("muse-plain")];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    await controller.setModel("muse-plain");
    controller.setEffort("max");
    await controller.send("go");
    assert.strictEqual(client.turnEfforts.at(-1), "max");
    controller.setEffort(null);
    await controller.send("again");
    assert.strictEqual(client.turnEfforts.at(-1), undefined, "Auto sends no level");
    assert.ok(!toasts.some((t) => / is not available on /.test(t.title)));
    tearDown();
  });

  it("clamps on the new-thread screen against the model new threads start on", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK_12];
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "muse-spark-1.2" });
    controller.setEffort("max");
    assert.strictEqual(controller.store.get().prefs.effort, "max");
    assert.deepStrictEqual(client.efforts, [], "there is no thread to tell");
    assert.ok(toasts.some((t) => t.title === "Max is not available on muse-spark-1.2"));
    tearDown();
  });
});

describe("a thread whose model Muse cannot serve", () => {
  it("tells the user to pick one the plan offers, and opens the picker on that thread", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    const asked = client.modelCalls.length;
    const params = { commandId: "c1", installedProviderId: "other", modelId: "muse-wonder-1.0", sessionId: "s1" };
    const event: AncillaEvent = { type: "msp", sessionId: "s1", method: "session/modelRouteUnserved", params, at: 1 };
    client.handler?.(event);
    await settleController();
    const notes = () => toasts.filter((t) => t.title === "Pick a model your plan offers");
    assert.strictEqual(notes().length, 1);
    assert.match(notes()[0]?.detail ?? "", /muse-wonder-1\.0/);
    assert.strictEqual(controller.store.get().picker, "model");
    assert.deepStrictEqual(client.modelCalls.at(-1), { sessionId: "s1", accountId: undefined });
    assert.strictEqual(client.modelCalls.length, asked + 1, "the thread's list is read again, once");
    client.handler?.(event);
    await settleController();
    assert.strictEqual(notes().length, 1, "the same command is not announced twice");
    controller.setPicker(null);
    client.handler?.({ ...event, sessionId: "elsewhere", params: { ...params, commandId: "c2", sessionId: "elsewhere" } });
    await settleController();
    assert.strictEqual(notes().length, 2);
    assert.strictEqual(controller.store.get().picker, null, "another thread's picker is not the one on screen");
    tearDown();
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
async function startedOn(client: MockAncillaRpcClient, held: ReturnType<typeof heldPlatform>) {
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
  await settleController();
  await settleController();
  return { controller, stop, tearDown: stop, held, toasts };
}

describe("/model with a name that is not an id", () => {
  async function onBuiltIn(hash: string) {
    const client = new MockAncillaRpcClient();
    client.models = LIVE_1_4_7.models;
    client.modelSource = "bundledCatalog";
    return { client, ...(await startedWith(client, hash)) };
  }

  it("finds Wonder among the models Meta publishes while the list is Muse's built-in one, and tries that, never the word", async () => {
    const { client, controller, tearDown, toasts } = await onBuiltIn(NEW_THREAD);
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.catalog?.source, "bundledCatalog");
    assert.strictEqual(await controller.send("/model wonder"), true);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.strictEqual(controller.store.get().prefs.defaultModelTried, true, "a published id the list lacks is only tried");
    assert.deepStrictEqual(toasts.filter((t) => /did not list/.test(t.title)).map((t) => t.title), ["Using muse-wonder-1.0, which your Muse did not list"]);
    await controller.send("hello");
    assert.strictEqual(client.startCalls.at(-1)?.modelId, "muse-wonder-1.0");
    tearDown();
  });

  it("tries it on the open thread alone, whatever case it is typed in, and finds another published model by its version", async () => {
    const { client, controller, tearDown } = await onBuiltIn("#/t/s1");
    assert.strictEqual(await controller.send("/model WONDER"), true);
    assert.deepStrictEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-wonder-1.0" }]);
    assert.strictEqual(await controller.send("/model MUSE-WONDER-1.0"), true);
    assert.deepStrictEqual(client.modelSwitches.at(-1), { sessionId: "s1", modelId: "muse-wonder-1.0" }, "an id typed in capitals is sent in its own spelling");
    assert.strictEqual(await controller.send("/model 1.2"), true);
    assert.deepStrictEqual(client.modelSwitches.at(-1), { sessionId: "s1", modelId: "muse-spark-1.2" });
    assert.strictEqual(controller.store.get().prefs.defaultModelId, null, "new threads do not follow a try");
    assert.ok(!client.modelSwitches.some((s) => s.modelId === "wonder"));
    tearDown();
  });

  it("prefers the list's own row to a published one for the same family", async () => {
    const { client, controller, tearDown } = await onBuiltIn("#/t/s1");
    assert.strictEqual(await controller.send("/model spark"), true);
    assert.deepStrictEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-spark-1.3" }]);
    tearDown();
  });

  it("opens the picker when published models of different families answer, and changes nothing", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [model("vendor-x-1")];
    client.modelSource = "bundledCatalog";
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    assert.strictEqual(await controller.send("/model muse"), true);
    assert.strictEqual(controller.store.get().picker, "model");
    assert.deepStrictEqual(client.modelSwitches, []);
    assert.ok(toasts.some((t) => t.title === "More than one model fits muse"));
    tearDown();
  });

  it("says no model has that name and opens the picker, when a bare word fits nothing on the plan's own list", async () => {
    const client = new MockAncillaRpcClient();
    client.models = LIVE_1_4_0.models;
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    for (const word of ["wonder", "wond", "Wonder"]) {
      controller.setPicker(null);
      assert.strictEqual(await controller.send(`/model ${word}`), false, word);
      assert.strictEqual(controller.store.get().picker, "model", word);
      assert.strictEqual(controller.store.get().prefs.defaultModelId, null, `${word} is not saved as a model`);
      assert.strictEqual(toasts.at(-1)?.title, `No model named ${word}`);
    }
    assert.deepStrictEqual(client.modelSwitches, []);
    tearDown();
  });

  it("does the same on an open thread: no switch is made to a word", async () => {
    const client = new MockAncillaRpcClient();
    client.models = LIVE_1_4_0.models;
    const { controller, tearDown } = await startedWith(client, "#/t/s1");
    assert.strictEqual(await controller.send("/model wonder"), false);
    assert.deepStrictEqual(client.modelSwitches, []);
    assert.strictEqual(controller.store.get().picker, "model");
    tearDown();
  });

  it("still tries what plainly is an id, in its own spelling, though the plan's list does not offer it", async () => {
    const client = new MockAncillaRpcClient();
    client.models = LIVE_1_4_0.models;
    const { controller, tearDown } = await startedWith(client, NEW_THREAD);
    assert.strictEqual(await controller.send("/model MUSE-WONDER-1.0"), true);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.strictEqual(controller.store.get().prefs.defaultModelTried, true);
    assert.strictEqual(await controller.send("/model muse-wonder-2.0"), true);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-2.0");
    tearDown();
  });

  it("writes no default from text while the list is empty or failed, unless the text is plainly an id, and then says so", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [new Error("a"), new Error("b"), new Error("c"), new Error("d"), new Error("e"), new Error("f")];
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.status, "error");
    for (const word of ["spark", "sparkk"]) {
      assert.strictEqual(await controller.send(`/model ${word}`), false, word);
      assert.strictEqual(controller.store.get().prefs.defaultModelId, null, `${word} is not saved`);
      assert.strictEqual(toasts.at(-1)?.title, `No model named ${word}`);
    }
    assert.strictEqual(await controller.send("/model muse-wonder-2.0"), true);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-2.0");
    assert.strictEqual(controller.store.get().prefs.defaultModelTried, true);
    assert.ok(toasts.some((t) => t.title === "Using muse-wonder-2.0, which your Muse did not list"));
    tearDown();
  });

  it("tries a plain id on the open thread alone while the list is empty, and writes no default", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [new Error("a"), new Error("b"), new Error("c"), new Error("d"), new Error("e"), new Error("f")];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    assert.strictEqual(await controller.send("/model sparkk"), false);
    assert.deepStrictEqual(client.modelSwitches, []);
    assert.strictEqual(await controller.send("/model muse-wonder-2.0"), true);
    assert.deepStrictEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-wonder-2.0" }]);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, null, "a try on a thread is that thread's alone");
    assert.ok(toasts.some((t) => /did not list/.test(t.title)));
    tearDown();
  });
});

describe("a model tried by its id survives a restart", () => {
  it("is passed on at thread start by a controller that starts from the saved prefs", async () => {
    const store = { saved: null as unknown };
    const first = new MockAncillaRpcClient();
    first.models = LIVE_1_4_0.models;
    const a = await startedOn(first, persistedPlatform(store, NEW_THREAD));
    assert.strictEqual(await a.controller.setModel("muse-wonder-1.0"), true);
    assert.strictEqual(a.controller.store.get().prefs.defaultModelTried, true);
    await settleController();
    a.stop();
    assert.strictEqual((store.saved as { defaultModelTried?: boolean }).defaultModelTried, true, "the mark is saved with the pin");
    const second = new MockAncillaRpcClient();
    second.models = LIVE_1_4_0.models;
    const b = await startedOn(second, persistedPlatform(store, NEW_THREAD));
    const state = b.controller.store.get();
    assert.strictEqual(state.prefs.defaultModelId, "muse-wonder-1.0");
    assert.strictEqual(state.prefs.defaultModelTried, true);
    const menu = modelMenu(
      { models: state.models, accountModels: state.accountModels, modelsStatus: state.modelsStatus, accounts: state.accounts },
      { scope: {}, accountId: null, current: null, pref: state.prefs.defaultModelId, plan: null, tried: state.prefs.defaultModelTried },
    );
    assert.strictEqual(menu.trigger.text, "muse-wonder-1.0", "the button does not call it unavailable");
    assert.strictEqual(menu.rows.find((row) => row.kind === "pin")?.unlisted, "tried");
    assert.strictEqual(await b.controller.send("hello"), true);
    assert.strictEqual(second.startCalls.at(-1)?.modelId, "muse-wonder-1.0", "the plan's list lacks it, and the thread still starts on it");
    assert.ok(!b.toasts.some((t) => /not offered/.test(t.title)));
    b.stop();
  });

  it("still drops a saved model that was once listed, and is not a try, when the plan's list no longer has it", async () => {
    const store = { saved: { defaultModelId: "muse-spark-1.1", defaultModelTried: false } as unknown };
    const client = new MockAncillaRpcClient();
    client.models = LIVE_1_4_0.models;
    const { controller, tearDown, toasts } = await startedOn(client, persistedPlatform(store, NEW_THREAD));
    await controller.send("hello");
    assert.strictEqual(client.startCalls.at(-1)?.modelId, undefined);
    assert.ok(toasts.some((t) => /muse-spark-1.1 is not offered on this account/.test(t.title)));
    tearDown();
  });

  it("ends when a listed model is picked, when Muse default is chosen, and when the pin changes by any other way", async () => {
    const client = new MockAncillaRpcClient();
    client.models = LIVE_1_4_0.models;
    const { controller, tearDown } = await startedWith(client, NEW_THREAD);
    const tried = () => controller.store.get().prefs.defaultModelTried;
    await controller.setModel("muse-wonder-1.0");
    assert.strictEqual(tried(), true);
    await controller.setModel("muse-spark-1.2");
    assert.strictEqual(tried(), false, "a listed pick");
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-spark-1.2");
    await controller.setModel("muse-wonder-1.0");
    assert.strictEqual(tried(), true);
    controller.clearModelPref();
    assert.strictEqual(tried(), false, "Muse default");
    assert.strictEqual(controller.store.get().prefs.defaultModelId, null);
    await controller.setModel("muse-wonder-1.0");
    controller.setPrefs({ defaultModelId: "muse-spark-1.3" });
    assert.strictEqual(tried(), false, "a pin that changes without saying it was tried is not one");
    tearDown();
  });

  it("is left alone by a try on a thread, and ended by a listed pick there", async () => {
    const client = new MockAncillaRpcClient();
    client.models = LIVE_1_4_0.models;
    const { controller, tearDown } = await startedWith(client, NEW_THREAD);
    await controller.setModel("muse-wonder-2.0");
    controller.navigate({ kind: "thread", sessionId: "s1" });
    await settleController();
    assert.strictEqual(await controller.setModel("muse-wonder-3.0"), true);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-2.0");
    assert.strictEqual(controller.store.get().prefs.defaultModelTried, true);
    assert.strictEqual(await controller.setModel("muse-spark-1.2"), true);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-spark-1.2");
    assert.strictEqual(controller.store.get().prefs.defaultModelTried, false);
    tearDown();
  });

  it("is remembered as tried for an id typed into the Other model id field while no list has loaded", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [new Error("Muse could not start")];
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    assert.deepStrictEqual(controller.store.get().accountModels["default"], [], "the boot read failed: there is no list to vouch for anything");
    assert.strictEqual(await tryTypedModel(controller, "muse-wonder-2.0"), true);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-2.0");
    assert.strictEqual(controller.store.get().prefs.defaultModelTried, true, "typed by hand, so not taken for a listed model");
    assert.deepStrictEqual(
      toasts.filter((t) => /did not list/.test(t.title)).map((t) => t.title),
      ["Using muse-wonder-2.0, which your Muse did not list"],
    );
    // The plan's list comes later and lacks it: the id is still what new threads start on, as the user typed it.
    client.modelQueue = [answer(LIVE_1_4_0)];
    await controller.refreshModels({ force: true });
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.catalog?.source, "providerCatalog");
    assert.strictEqual(await controller.send("hello"), true);
    assert.strictEqual(client.startCalls.at(-1)?.modelId, "muse-wonder-2.0");
    assert.ok(!toasts.some((t) => /not offered/.test(t.title)), "it is not silently swapped for Muse's default");
    tearDown();
  });

  it("takes the same menu pick on trust while no list has loaded, which is a pick and not a try", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [new Error("Muse could not start")];
    const { controller, tearDown } = await startedWith(client, NEW_THREAD);
    assert.strictEqual(await controller.setModel("muse-wonder-1.0"), true);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.strictEqual(controller.store.get().prefs.defaultModelTried, false);
    tearDown();
  });

  it("keeps an id typed on an open thread to that thread when no list has loaded, never making it the default", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [new Error("Muse could not start"), new Error("Muse could not start")];
    const { controller, tearDown } = await startedWith(client, "#/t/s1");
    assert.deepStrictEqual(controller.store.get().accountModels["thread:s1"], []);
    assert.strictEqual(await tryTypedModel(controller, "muse-wonder-typo"), true);
    assert.deepStrictEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-wonder-typo" }]);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, null, "a typo is not what new threads start on");
    assert.strictEqual(controller.store.get().prefs.defaultModelTried, false);
    tearDown();
  });
});

describe("the model union and the accounts behind it", () => {
  it("keeps the plan's window and levels for a model a built-in list also names, and leads with the plan's list", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [answer(LIVE_1_4_7)];
    const { controller, tearDown } = await startedWith(client);
    assert.strictEqual(controller.store.get().models.find((m) => m.modelId === "muse-spark-1.3")?.contextLimit, null);
    client.modelQueue = [answer(LIVE_1_4_0)];
    await controller.refreshModels({ accountId: "work" });
    const { models, accountModels } = controller.store.get();
    const spark = models.find((m) => m.modelId === "muse-spark-1.3");
    assert.strictEqual(spark?.contextLimit, 1007997, "the built-in row has no window; the plan's does");
    assert.ok(spark?.efforts?.includes("max"));
    assert.deepStrictEqual(models.map((m) => m.modelId), accountModels["acct:work"]?.map((m) => m.modelId), "the plan's list leads");
    tearDown();
  });

  it("lets the plan's row stand for a model both lists name, not the built-in one the default login read first", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [{ models: [model("same", { description: "built-in row" })], source: "bundledCatalog" }];
    const { controller, tearDown } = await startedWith(client);
    client.modelQueue = [[model("same", { description: "plan row", contextLimit: 5 })]];
    await controller.refreshModels({ accountId: "work" });
    const row = controller.store.get().models.find((m) => m.modelId === "same");
    assert.strictEqual(row?.description, "plan row");
    assert.strictEqual(row?.contextLimit, 5);
    tearDown();
  });

  it("lets Settings tell a saved model another account offers from one nobody lists", async () => {
    const client = new MockAncillaRpcClient();
    client.models = LIVE_1_4_0.models;
    const { controller, tearDown } = await startedWith(client);
    client.modelQueue = [[SPARK, WONDER]];
    await controller.refreshModels({ accountId: "work" });
    const state = controller.store.get();
    const defaults = modelsShown(state, {}).models;
    assert.strictEqual(offeredByAnother(state, defaults, "muse-wonder-1.0"), true);
    assert.strictEqual(offeredByAnother(state, defaults, "retired-x"), false);
    assert.strictEqual(offeredByAnother(state, defaults, "muse-spark-1.3"), false);
    tearDown();
  });

  it("forgets a removed account's lists, status and pending re-list, and the lists of its threads", async () => {
    const client = new MockAncillaRpcClient();
    client.accounts = [WORK];
    client.listSessions = async () => [{ ...SESSION, accountId: "work" }];
    client.models = [SPARK];
    const { controller, tearDown, held } = await startedWith(client);
    await controller.loadAccounts();
    client.modelQueue = [{ models: [WONDER], source: "bundledCatalog" }];
    await controller.refreshModels({ accountId: "work", watch: true });
    client.modelQueue = [[WONDER_FULL]];
    await controller.refreshModels({ sessionId: "s1" });
    let state = controller.store.get();
    assert.deepStrictEqual(state.models.map((m) => m.modelId).sort(), ["muse-spark-1.3", "muse-wonder-1.0", "muse-wonder-full-1.0"]);
    assert.deepStrictEqual(held.waiting(), [2_000], "the built-in list is waiting to be asked for again");
    assert.strictEqual(await controller.removeAccount("work"), true);
    state = controller.store.get();
    for (const key of ["acct:work", "thread:s1"]) {
      assert.strictEqual(state.accountModels[key], undefined, key);
      assert.strictEqual(state.modelsStatus[key], undefined, key);
    }
    assert.deepStrictEqual(state.models.map((m) => m.modelId), ["muse-spark-1.3"], "what only that account offered is gone from every lookup");
    // An account of the same id comes back and is read, with Muse's built-in list again, before the old chain's timer fires.
    client.accounts.push(WORK);
    await controller.loadAccounts();
    client.modelQueue = [{ models: [WONDER], source: "bundledCatalog" }];
    await controller.refreshModels({ accountId: "work" });
    assert.strictEqual(controller.store.get().modelsStatus["acct:work"]?.catalog?.source, "bundledCatalog");
    const asked = client.modelCalls.length;
    held.fire(2_000);
    await settleController();
    assert.strictEqual(client.modelCalls.length, asked, "the pending re-list of the account that was removed asks nothing, though a list of that name is back");
    tearDown();
  });

  it("does not show a removed account's list as fresh when an account of the same id comes back", async () => {
    const client = new MockAncillaRpcClient();
    client.accounts = [WORK];
    client.models = [SPARK];
    const { controller, tearDown } = await startedWith(client);
    await controller.loadAccounts();
    client.modelQueue = [[SPARK, WONDER]];
    await controller.refreshModels({ accountId: "work" });
    assert.strictEqual(controller.store.get().modelsStatus["acct:work"]?.status, "ready");
    await controller.removeAccount("work");
    client.accounts.push(WORK);
    await controller.loadAccounts();
    client.modelQueue = [[SPARK_12]];
    await controller.refreshModels({ accountId: "work" });
    assert.deepStrictEqual(controller.store.get().accountModels["acct:work"]?.map((m) => m.modelId), ["muse-spark-1.2"], "asked afresh, not read from the old one");
    tearDown();
  });

  it("says a saved model is not offered again to an account that was removed and has come back", async () => {
    const client = new MockAncillaRpcClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.accounts = [WORK];
    client.modelQueue = [[SPARK, WONDER], [SPARK]];
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "muse-wonder-1.0" });
    const notes = () => toasts.filter((t) => /not offered on this account/.test(t.title)).length;
    assert.strictEqual(await controller.send("hello"), true);
    assert.strictEqual(client.startCalls.at(-1)?.accountId, "work");
    assert.strictEqual(notes(), 1, "the new account's list lacks the saved model, and says so");
    controller.navigate({ kind: "new", cwd: "/work/app" });
    assert.strictEqual(await controller.send("again"), true);
    assert.strictEqual(notes(), 1, "once for the account, not for every thread");
    // Another account of the same id: a new login, a new list, and the note is owed to it as to any account.
    assert.strictEqual(await controller.removeAccount("work"), true);
    client.accounts.push(WORK);
    await controller.loadAccounts();
    client.modelQueue = [[SPARK]];
    await controller.setProjectDefaultAccount("/work/app", "work");
    await settleController();
    assert.deepStrictEqual(controller.store.get().accountModels["acct:work"], [SPARK]);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    assert.strictEqual(await controller.send("once more"), true);
    assert.strictEqual(client.startCalls.at(-1)?.accountId, "work");
    assert.strictEqual(client.startCalls.at(-1)?.modelId, undefined);
    assert.strictEqual(notes(), 2, "removing the account let go of what was said about it");
    tearDown();
  });
});

describe("the boot order of the account lists", () => {
  function gated(client: MockAncillaRpcClient) {
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
    const client = new MockAncillaRpcClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.accounts = [{ ...WORK, hasLogin: false }];
    client.models = [SPARK];
    const open = gated(client);
    const { controller, tearDown } = await startedWith(client, NEW_THREAD);
    assert.strictEqual(controller.store.get().accounts, null, "the accounts are still being read");
    assert.deepStrictEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }], "only the default login was asked");
    open();
    await settleController();
    assert.strictEqual(controller.store.get().accounts?.length, 1);
    assert.deepStrictEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }], "and the account that cannot answer still is not");
    assert.strictEqual(controller.store.get().modelsStatus["acct:work"], undefined);
    tearDown();
  });

  it("asks an account that has a login as soon as the accounts have loaded", async () => {
    const client = new MockAncillaRpcClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.accounts = [WORK];
    client.modelQueue = [[SPARK], [SPARK, WONDER]];
    const open = gated(client);
    const { controller, tearDown } = await startedWith(client, NEW_THREAD);
    assert.strictEqual(client.modelCalls.length, 1);
    open();
    await settleController();
    assert.deepStrictEqual(client.modelCalls.at(-1), { sessionId: undefined, accountId: "work" });
    assert.deepStrictEqual(controller.store.get().accountModels["acct:work"], [SPARK, WONDER]);
    tearDown();
  });

  it("asks anyway when the accounts could not be read, so the picker is not left waiting", async () => {
    const client = new MockAncillaRpcClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.models = [SPARK];
    client.listAccounts = async () => {
      throw new Error("no accounts route");
    };
    const { controller, tearDown } = await startedWith(client, NEW_THREAD);
    assert.strictEqual(controller.store.get().accounts, null);
    assert.ok(client.modelCalls.some((call) => call.accountId === "work"), "an account scope is read once the accounts have been tried");
    tearDown();
  });

  it("waits for the accounts before asking for the list of a thread of a named account, too", async () => {
    const onWork: SessionSummary = { ...SESSION, accountId: "work" };
    const client = new MockAncillaRpcClient();
    client.listSessions = async () => [onWork];
    client.transcript = async () => load({ session: onWork });
    client.accounts = [WORK];
    client.models = [SPARK];
    const open = gated(client);
    const { controller, tearDown } = await startedWith(client, "#/t/s1");
    assert.strictEqual(controller.store.get().threads["s1"]?.load, "ready", "the thread is open");
    assert.strictEqual(controller.store.get().accounts, null, "and the accounts are still being read");
    assert.deepStrictEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }], "only the default login was asked: whether the thread's account has a login is not known yet");
    open();
    await settleController();
    assert.deepStrictEqual(client.modelCalls.at(-1), { sessionId: "s1", accountId: undefined }, "the thread's own host is asked once the accounts are in");
    assert.strictEqual(controller.store.get().modelsStatus["thread:s1"]?.status, "ready");
    tearDown();
  });

  it("never asks for the list of a thread of an account that has no login, before the accounts have loaded or after", async () => {
    const onWork: SessionSummary = { ...SESSION, accountId: "work" };
    const client = new MockAncillaRpcClient();
    client.listSessions = async () => [onWork];
    client.transcript = async () => load({ session: onWork });
    client.accounts = [{ ...WORK, hasLogin: false }];
    client.models = [SPARK];
    const open = gated(client);
    const { controller, tearDown } = await startedWith(client, "#/t/s1");
    assert.deepStrictEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }]);
    open();
    await settleController();
    assert.strictEqual(controller.store.get().accounts?.length, 1);
    assert.deepStrictEqual(client.modelCalls, [{ sessionId: undefined, accountId: undefined }], "and the host that cannot answer still is not");
    assert.strictEqual(controller.store.get().modelsStatus["thread:s1"], undefined);
    tearDown();
  });
});

describe("small fixes to choosing a model", () => {
  it("says a Contributor model Muse started a thread on when nobody picked it and the list names no default", async () => {
    const client = new MockAncillaRpcClient();
    client.models = LIVE_1_4_7.models;
    client.modelSource = "bundledCatalog";
    client.startSession = async (cwd, options) => {
      client.startCalls.push({ cwd, modelId: options?.modelId, accountId: options?.accountId ?? null });
      return { ...SESSION, modelId: "muse-spark-1.3-contributor" };
    };
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    const notices = () => toasts.filter((t) => t.title.startsWith("Muse's default is"));
    assert.strictEqual(await controller.send("hello"), true);
    assert.deepStrictEqual(notices().map((t) => t.title), ["Muse's default is muse-spark-1.3, a Contributor model"]);
    assert.strictEqual(controller.store.get().prefs.contributorAck, true);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await controller.send("again");
    assert.strictEqual(notices().length, 1, "said once");
    tearDown();
  });

  it("says it when a saved model was dropped and Muse's own pick is a Contributor model, and not when a model was asked for by name", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK, WONDER];
    client.startSession = async (cwd, options) => {
      client.startCalls.push({ cwd, modelId: options?.modelId, accountId: options?.accountId ?? null });
      return { ...SESSION, modelId: "muse-spark-1.3-contributor" };
    };
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    controller.setPrefs({ defaultModelId: "muse-wonder-1.0" });
    // Asked for by name: whatever Muse then answers, nobody left the choice to Muse.
    assert.strictEqual(await controller.send("by name"), true);
    assert.strictEqual(client.startCalls.at(-1)?.modelId, "muse-wonder-1.0");
    assert.strictEqual(toasts.filter((t) => t.title.startsWith("Muse's default is")).length, 0);
    controller.setPrefs({ defaultModelId: "retired-x" });
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await controller.send("dropped");
    assert.strictEqual(client.startCalls.at(-1)?.modelId, undefined);
    assert.strictEqual(toasts.filter((t) => t.title.startsWith("Muse's default is")).length, 1);
    tearDown();
  });

  it("puts a refused switch back on its own thread though another thread was switched meanwhile", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK, SPARK_12, WONDER];
    const other: SessionSummary = { ...SESSION, sessionId: "s2", title: "Other" };
    client.listSessions = async () => [SESSION, other];
    client.loadTranscript = async (sessionId: string) => load({ session: sessionId === "s1" ? SESSION : other });
    const { controller, tearDown } = await startedWith(client, "#/t/s1");
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
    assert.strictEqual(modelOf("s1"), "muse-wonder-1.0", "the switch shows at once");
    controller.openThread("s2");
    await settleController();
    assert.strictEqual(await controller.setModel("muse-spark-1.2"), true);
    refuse(new Error("Your plan does not include this model"));
    assert.strictEqual(await first, false);
    assert.strictEqual(modelOf("s1"), before, "the refused switch is put back on its thread");
    assert.strictEqual(modelOf("s2"), "muse-spark-1.2", "the other thread's switch stays");
    tearDown();
  });

  it("lets the newest pick, on whichever thread, write the default new threads start on", async () => {
    const client = new MockAncillaRpcClient();
    client.models = [SPARK, SPARK_12, WONDER];
    const other: SessionSummary = { ...SESSION, sessionId: "s2", title: "Other" };
    client.listSessions = async () => [SESSION, other];
    client.loadTranscript = async (sessionId: string) => load({ session: sessionId === "s1" ? SESSION : other });
    const { controller, tearDown } = await startedWith(client, "#/t/s1");
    let accept!: () => void;
    client.modelGates = [
      new Promise<void>((resolve) => {
        accept = resolve;
      }),
    ];
    const older = controller.setModel("muse-wonder-1.0");
    controller.openThread("s2");
    await settleController();
    assert.strictEqual(await controller.setModel("muse-spark-1.2"), true);
    accept();
    assert.strictEqual(await older, true);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-spark-1.2", "an older switch finishing later does not take the default back");
    tearDown();
  });

  it("treats a pick from a stand-in list as a try that the account has not confirmed", async () => {
    const client = new MockAncillaRpcClient();
    client.projects = [{ ...(client.projects[0] as ProjectView), defaultAccountId: "work" }];
    client.accounts = [WORK];
    client.modelQueue = [[SPARK, SPARK_12], new Error("Muse could not start")];
    const { controller, tearDown, toasts } = await startedWith(client, NEW_THREAD);
    assert.strictEqual(controller.store.get().modelsStatus["acct:work"]?.status, "error");
    assert.strictEqual(modelsShown(controller.store.get(), { accountId: "work" }).fallback, true);
    assert.strictEqual(await controller.setModel("muse-spark-1.2"), true);
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-spark-1.2");
    assert.strictEqual(controller.store.get().prefs.defaultModelTried, true, "it is not pretended to be listed");
    assert.deepStrictEqual(toasts.filter((t) => /has not confirmed it/.test(t.title)), [
      { title: "Using muse-spark-1.2; Work has not confirmed it", detail: "Its model list did not load. Muse checks access when you send a prompt." },
    ]);
    assert.ok(!toasts.some((t) => /did not list/.test(t.title)));
    assert.strictEqual(await controller.send("/model spark 1.3"), true);
    assert.strictEqual(controller.store.get().prefs.defaultModelTried, true);
    assert.strictEqual(toasts.filter((t) => /has not confirmed it/.test(t.title)).length, 2, "a name from the stand-in list is a try too");
    await controller.send("hello");
    assert.strictEqual(client.startCalls.at(-1)?.modelId, "muse-spark-1.3");
    assert.strictEqual(client.startCalls.at(-1)?.accountId, "work");
    tearDown();
  });

  it("takes a pick from the default login's list as listed on a thread of that login whose own list did not load", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [[SPARK, SPARK_12], new Error("Muse could not start")];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    const state = () => controller.store.get();
    assert.strictEqual(state().modelsStatus["thread:s1"]?.status, "error");
    assert.strictEqual(modelsShown(state(), { sessionId: "s1" }).fallback, true, "the default login's list stands in for the thread's");
    assert.strictEqual(await controller.setModel("muse-spark-1.2"), true);
    assert.deepStrictEqual(client.modelSwitches, [{ sessionId: "s1", modelId: "muse-spark-1.2" }]);
    assert.strictEqual(state().prefs.defaultModelId, "muse-spark-1.2", "the login's own list vouches for it, so it is what new threads start on");
    assert.strictEqual(state().prefs.defaultModelTried, false);
    assert.deepStrictEqual(toasts.filter((t) => /has not confirmed it|did not list/.test(t.title)), [], "nobody is named as not having confirmed what it listed");
    // What that list lacks is a try as ever, and this thread's alone.
    assert.strictEqual(await controller.setModel("muse-wonder-2.0"), true);
    assert.strictEqual(state().prefs.defaultModelId, "muse-spark-1.2");
    assert.deepStrictEqual(
      toasts.filter((t) => /did not list/.test(t.title)).map((t) => t.title),
      ["Using muse-wonder-2.0, which your Muse did not list"],
    );
    tearDown();
  });

  it("says the account has not confirmed a pick from the stand-in list on a thread of a named account", async () => {
    const onWork: SessionSummary = { ...SESSION, accountId: "work" };
    const client = new MockAncillaRpcClient();
    client.accounts = [WORK];
    client.listSessions = async () => [onWork];
    client.transcript = async () => load({ session: onWork });
    client.modelQueue = [[SPARK, SPARK_12], new Error("Muse could not start")];
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    const state = () => controller.store.get();
    assert.strictEqual(state().modelsStatus["thread:s1"]?.status, "error");
    assert.strictEqual(await controller.setModel("muse-spark-1.2"), true);
    assert.deepStrictEqual(toasts.filter((t) => /has not confirmed it/.test(t.title)).map((t) => t.title), ["Using muse-spark-1.2; Work has not confirmed it"]);
    assert.strictEqual(state().prefs.defaultModelId, null, "a try on a thread is that thread's alone");
    tearDown();
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
    const client = new MockAncillaRpcClient();
    client.transcript = async () => load({ events: afterTheTurn("inProgress") });
    const { controller, tearDown, toasts } = await startedWith(client, "#/t/s1");
    const thread = controller.store.get().threads["s1"];
    assert.ok(thread);
    assert.strictEqual(thread.fold.activeTurnId, null, "no turn is running");
    assert.strictEqual(crewBusy(thread.fold, thread.researchRuns), true, "but the run is");
    assert.strictEqual(Object.values(controller.store.get().sessions).some((s) => s.live?.activeTurnId), false);
    assert.strictEqual(await controller.restartMuse(), false);
    assert.strictEqual(client.restarts, 0);
    assert.strictEqual(toasts.at(-1)?.title, "Work is still running");
    tearDown();
  });

  it("restarts once the run has ended", async () => {
    const client = new MockAncillaRpcClient();
    client.transcript = async () => load({ events: afterTheTurn("completed") });
    const { controller, tearDown } = await startedWith(client, "#/t/s1");
    assert.strictEqual(await controller.restartMuse(), true);
    assert.strictEqual(client.restarts, 1);
    tearDown();
  });
});

describe("moving around does not hammer Muse for the model lists", () => {
  it("leaves a built-in list be for ten minutes of navigation, where the picker and a refresh by hand ask again", async () => {
    const client = new MockAncillaRpcClient();
    client.modelSource = "bundledCatalog";
    client.models = LIVE_1_4_7.models;
    const { controller, tearDown, held } = await startedWith(client);
    assert.strictEqual(client.modelCalls.length, 1);
    for (const route of [{ kind: "new", cwd: "/work/app" }, { kind: "home" }, { kind: "settings" }, { kind: "new", cwd: "/work/app" }] as const) {
      controller.navigate(route);
      await settleController();
    }
    assert.strictEqual(client.modelCalls.length, 1, "four route changes ask for nothing");
    controller.setPicker("model");
    await settleController();
    assert.strictEqual(client.modelCalls.length, 2, "the picker always asks again of a built-in list");
    controller.setPicker(null);
    await controller.discoverAll();
    await settleController();
    assert.strictEqual(client.modelCalls.length, 3, "so does refreshing threads by hand");
    held.clock.now += 11 * 60_000;
    controller.navigate({ kind: "home" });
    await settleController();
    assert.strictEqual(client.modelCalls.length, 4, "and a navigation does once the list is ten minutes old");
    tearDown();
  });

  it("leaves a failed list be for a minute of navigation, but not Retry, the picker or a later minute", async () => {
    const client = new MockAncillaRpcClient();
    client.modelQueue = [new Error("a"), new Error("b"), new Error("c"), new Error("d")];
    client.models = [SPARK];
    const { controller, tearDown, held } = await startedWith(client);
    assert.strictEqual(client.modelCalls.length, 1);
    for (const route of [{ kind: "new", cwd: "/work/app" }, { kind: "home" }, { kind: "settings" }] as const) {
      controller.navigate(route);
      await settleController();
    }
    assert.strictEqual(client.modelCalls.length, 1, "no retry on every navigation");
    assert.strictEqual(controller.store.get().modelsStatus["default"]?.status, "error");
    controller.setPicker("model");
    await settleController();
    assert.strictEqual(client.modelCalls.length, 2, "the picker asks");
    controller.setPicker(null);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await settleController();
    assert.strictEqual(client.modelCalls.length, 2, "and the failure it saw is a new one");
    held.clock.now += 61_000;
    controller.navigate({ kind: "new", cwd: "/work/app" });
    await settleController();
    assert.strictEqual(client.modelCalls.length, 3, "a minute later a navigation asks again");
    await controller.refreshModels({ force: true });
    assert.strictEqual(client.modelCalls.length, 4, "Retry always goes through");
    tearDown();
  });
});

describe("staleThreadReason", () => {
  const WATCH_BASE_TIME_MS = 1_000_000;
  const NOW = WATCH_BASE_TIME_MS;

  it("leaves idle threads alone", () => {
    assert.strictEqual(staleThreadReason(null, null, NOW - 60_000, NOW), null);
    assert.strictEqual(staleThreadReason(null, "t1", NOW - 600_000, NOW), null);
  });

  it("leaves threads without an applied stamp alone", () => {
    assert.strictEqual(staleThreadReason("t1", null, null, NOW), null);
  });

  it("reloads a fold still showing a turn the server finished", () => {
    assert.strictEqual(staleThreadReason("t1", null, NOW - 30_000, NOW), null);
    assert.strictEqual(staleThreadReason("t1", null, NOW - 30_001, NOW), "diverged");
    assert.strictEqual(staleThreadReason("t1", undefined, NOW - 31_000, NOW), "diverged");
  });

  it("reloads a turn both sides agree is running but silent", () => {
    assert.strictEqual(staleThreadReason("t1", "t1", NOW - 90_000, NOW), null);
    assert.strictEqual(staleThreadReason("t1", "t1", NOW - 90_001, NOW), "quiet");
  });
});

describe("stale thread watchdog", () => {
  async function setupLiveWatchingHarness(client: MockAncillaRpcClient) {
    let readCount = 0;
    client.listSessions = async () => [LIVE_SESSION];
    client.transcript = async () => {
      readCount++;
      return { ...runningLoad(), session: LIVE_SESSION };
    };
    const harness = await startedWatching(client);
    return { ...harness, getReads: () => readCount };
  }

  function watchPlatform() {
    const baseEnv = platform("#/t/s1");
    let simulatedNow = 1_000_000;
    const scheduledTimers: Array<{ cb: () => void; intervalMs: number } | null> = [];
    const fakePlatform: Platform = {
      ...baseEnv,
      now: () => simulatedNow,
      schedule: (cb: () => void, intervalMs: number) => {
        scheduledTimers.push({ cb, intervalMs });
        return scheduledTimers.length - 1;
      },
      cancel: (handle: unknown) => {
        if (typeof handle === "number") {
          scheduledTimers[handle] = null;
        }
      },
    };
    return {
      fake: fakePlatform,
      setNow: (ms: number) => {
        simulatedNow = ms;
      },
      runStaleChecks: () => {
        for (const [idx, item] of [...scheduledTimers].entries()) {
          if (item && item.intervalMs === 15_000) {
            scheduledTimers[idx] = null;
            item.cb();
          }
        }
      },
    };
  }

  const runningLoad = (): TranscriptLoad =>
    load({
      msp: { status: "running", activeTurnId: "live-1", modelId: "muse-spark-1.3", approvalMode: "onRequest", workspaceRoot: "/work/active-app", turnCount: 4 },
      events: [...historyEvents, { method: "turn/started", params: { turnId: "live-1" }, at: 1 }],
    });

  async function startedWatching(client: MockAncillaRpcClient) {
    const watchEnv = watchPlatform();
    const controllerInstance = new AncillaController(client, watchEnv.fake);
    const stopWatchController = controllerInstance.start();
    await settleController();
    await settleController();
    return { controller: controllerInstance, stop: stopWatchController, tearDown: stopWatchController, ...watchEnv };
  }

  const makeWorkEvent = (rev: number, textMsg = `Progress ${rev}`): ViewEvent => ({
    method: "item/updated",
    params: {
      item: {
        itemId: "current-work",
        kind: "agentMessage",
        status: "inProgress",
        revision: rev,
        turnId: "live-1",
        text: textMsg,
      },
    },
  });
  const work = makeWorkEvent;
  const makeFallbackLoad = (revisionNum: number): TranscriptLoad => {
    const active = runningLoad();
    return {
      ...active,
      viewHealth: { status: "unavailable", reason: "projectionUnavailable" },
      historyUnavailable: true,
      events: [...active.events, work(revisionNum)],
    };
  };
  const fallbackLoad = makeFallbackLoad;

  const LIVE_SESSION: SessionSummary = createSessionFixture({
    live: { activeTurnId: "live-1", pendingApprovals: 0, pendingInputs: 0, turnStartedAt: null, lastTerminal: null, lastError: null },
  });
  /** One event over the live stream, applied at once. */
  const stream = (client: MockAncillaRpcClient, controller: AncillaController, sessionId: string, event: ViewEvent, at: number) => {
    client.handler?.({ type: "msp", sessionId, ...event, at });
    controller.flush();
  };

  it("checks progressing partial history every 15 seconds without claiming the live stream recovered", async () => {
    const client = new MockAncillaRpcClient();
    let revision = 0;
    client.transcript = async () => fallbackLoad(++revision);
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    assert.deepStrictEqual(controller.store.get().threads.s1?.historySync, { checkedAt: 1_000_000, progressAt: 1_000_000 });
    setNow(1_015_000);
    runStaleChecks();
    await settleController();
    const thread = controller.store.get().threads.s1!;
    assert.strictEqual(revision, 2);
    assert.strictEqual(thread.fold.items["current-work"].revision, 2);
    assert.deepStrictEqual(thread.historySync, { checkedAt: 1_015_000, progressAt: 1_015_000 });
    assert.strictEqual(thread.stalled, false);
    assert.strictEqual(thread.fold.activeTurnId, "live-1");
    assert.strictEqual(thread.fold.turns["live-1"].terminal, undefined);
    assert.deepStrictEqual(client.transcriptOptions.at(-1), { refresh: true });
    assert.strictEqual(client.sent.length, 0);
    tearDown();
  });

  it("keeps the fallback request cadence when a saved-history read takes time", async () => {
    const client = new MockAncillaRpcClient();
    client.transcript = async () => fallbackLoad(1);
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    let completeDelayedRead!: (value: TranscriptLoad) => void;
    client.transcript = () => new Promise((resolve) => { completeDelayedRead = resolve; });
    setNow(1_015_000); runStaleChecks(); await flushMicrotasks();
    assert.strictEqual(client.transcriptOptions.length, 2);
    setNow(1_017_000); completeDelayedRead(fallbackLoad(2)); await settleController(); await settleController();
    assert.strictEqual(controller.store.get().threads.s1?.historySync?.checkedAt, 1_017_000);
    client.transcript = async () => fallbackLoad(3);
    setNow(1_030_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(client.transcriptOptions.length, 3, "a slow response must not skip the next 15-second read");
    assert.strictEqual(controller.store.get().threads.s1?.fold.items["current-work"].revision, 3);
    assert.strictEqual(client.sent.length, 0);
    tearDown();
  });

  it("keeps fallback progress time unchanged when saved history repeats the same revision", async () => {
    const client = new MockAncillaRpcClient();
    client.transcript = async () => fallbackLoad(1);
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    setNow(1_015_000);
    runStaleChecks();
    await settleController();
    assert.deepStrictEqual(controller.store.get().threads.s1?.historySync, { checkedAt: 1_015_000, progressAt: 1_000_000 });
    assert.strictEqual(controller.store.get().threads.s1?.fold.activeTurnId, "live-1");
    tearDown();
  });

  it("uses the longer fallback interval for loaded threads outside the selected chat", async () => {
    const client = new MockAncillaRpcClient();
    let navReads = 0;
    client.transcript = async () => { navReads++; return fallbackLoad(navReads); };
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    controller.navigate({ kind: "settings" });
    setNow(1_015_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(navReads, 1);
    setNow(1_120_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(navReads, 2);
    assert.deepStrictEqual(client.transcriptOptions.at(-1), { refresh: true });
    tearDown();
  });

  it("keeps a usable fold and retries a transient fallback error without resuming or resending", async () => {
    const client = new MockAncillaRpcClient();
    let transientOutageReads = 0;
    client.transcript = async () => {
      transientOutageReads++;
      if (transientOutageReads === 2) throw new Error("temporary read outage");
      return fallbackLoad(transientOutageReads);
    };
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    setNow(1_015_000);
    runStaleChecks();
    await settleController();
    const failed = controller.store.get().threads.s1!;
    assert.strictEqual(failed.load, "ready");
    assert.strictEqual(failed.fold.items["current-work"].revision, 1);
    assert.strictEqual(failed.fold.activeTurnId, "live-1");
    assert.strictEqual(failed.error, "temporary read outage");
    setNow(1_030_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(transientOutageReads, 2, "a failed read does not retry every 15 seconds");
    setNow(1_045_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(transientOutageReads, 3);
    assert.strictEqual(controller.store.get().threads.s1?.error, null);
    assert.strictEqual(controller.store.get().threads.s1?.fold.items["current-work"].revision, 3);
    assert.ok(client.transcriptOptions.slice(1).every((options) => options?.refresh === true));
    assert.strictEqual(client.sent.length, 0);
    tearDown();
  });

  it("uses read-only refresh when the loaded fold is active even if server live state is absent", async () => {
    const client = new MockAncillaRpcClient();
    client.transcript = async () => ({ ...runningLoad(), readOnly: true });
    const { controller, tearDown } = await startedWatching(client);
    assert.strictEqual(controller.store.get().sessions.s1?.live, null);
    assert.strictEqual(controller.store.get().threads.s1?.fold.activeTurnId, "live-1");
    await controller.loadThread("s1");
    assert.deepStrictEqual(client.transcriptOptions.at(-1), { refresh: true });
    assert.strictEqual(client.sent.length, 0);
    tearDown();
  });

  it("continues unavailable-history recovery when an old pending input is still cached", async () => {
    const client = new MockAncillaRpcClient();
    let cachedInputReads = 0;
    client.transcript = async () => {
      cachedInputReads++;
      return { ...fallbackLoad(cachedInputReads), pending: { approvals: [], userInputs: cachedInputReads === 1
        ? [{ userInputId: "old-question", turnId: "live-1", questions: [] } as unknown as UserInputRequest] : [] } };
    };
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    assert.ok(controller.store.get().threads.s1?.fold.userInputs["old-question"]);
    setNow(1_015_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(cachedInputReads, 2);
    assert.strictEqual(Object.keys(controller.store.get().threads.s1!.fold.userInputs).length, 0);
    assert.strictEqual(controller.store.get().threads.s1?.fold.activeTurnId, "live-1");
    tearDown();
  });

  it("clears fallback and stale state on fresh live progress, but not metadata or replayed revisions", async () => {
    const client = new MockAncillaRpcClient();
    client.transcript = async () => fallbackLoad(2);
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    setNow(1_015_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(controller.store.get().threads.s1?.stalled, true);
    const dispatchViewEvent = (event: ViewEvent) => {
      client.handler?.({ type: "msp", sessionId: "s1", ...event, at: 1_015_001 });
      controller.flush();
    };
    dispatchViewEvent({ method: "session/tokenUsage", params: { inputTokens: 20, outputTokens: 10 } });
    dispatchViewEvent(work(1));
    assert.strictEqual(controller.store.get().threads.s1?.stalled, true);
    assert.ok(controller.store.get().threads.s1?.historySync);
    dispatchViewEvent(work(3));
    assert.strictEqual(controller.store.get().threads.s1?.stalled, false);
    assert.strictEqual(controller.store.get().threads.s1?.historySync, undefined);
    assert.strictEqual(controller.store.get().threads.s1?.fold.activeTurnId, "live-1");
    tearDown();
  });

  it("clears ended-turn fallback state even when the saved response retains unavailable health", async () => {
    const client = new MockAncillaRpcClient();
    let endedTurnReads = 0;
    client.transcript = async () => ++endedTurnReads === 1 ? fallbackLoad(1) : load({
      events: [...historyEvents, { method: "turn/completed", params: { turnId: "live-1", terminal: "completed" } }],
      historyUnavailable: true,
      viewHealth: { status: "unavailable" as const, reason: "projectionUnavailable" as const },
    });
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    setNow(1_015_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(controller.store.get().threads.s1?.fold.activeTurnId, null);
    assert.strictEqual(controller.store.get().threads.s1?.stalled, false);
    assert.strictEqual(controller.store.get().threads.s1?.historySync, undefined);
    tearDown();
  });

  it("reads saved results immediately when Muse reports unavailable updates, without resending", async () => {
    const client = new MockAncillaRpcClient();
    client.transcript = async () => runningLoad();
    const { controller, tearDown } = await startedWatching(client);
    client.transcript = async () => load({
      viewHealth: { status: "unavailable", reason: "projectionUnavailable" },
      events: [...historyEvents, { at: 2, method: "turn/completed", params: { turnId: "live-1", terminal: "completed" } }],
    });
    client.handler?.({ at: 1, type: "msp" as const, sessionId: "s1", method: "session/viewHealthChanged" as const,
      params: { health: "unavailable", noneReason: "projectionUnavailable" } });
    await settleController();
    await flushMicrotasks();
    assert.deepStrictEqual(client.transcriptOptions.at(-1), { refresh: true });
    assert.strictEqual(controller.store.get().threads.s1?.fold.activeTurnId, null);
    assert.strictEqual(controller.store.get().threads.s1?.fold.turns["live-1"]?.terminal, "completed");
    assert.strictEqual(controller.store.get().threads.s1?.stalled, false, "saved completion clears the stale-update notice");
    assert.strictEqual(client.sent.length, 0);
    tearDown();
  });

  it("continues read-only recovery after backoff instead of leaving a permanent spinner", async () => {
    const client = new MockAncillaRpcClient();
    let backoffLoads = 0;
    client.transcript = async () => { backoffLoads += 1; return runningLoad(); };
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    for (const elapsed of [31_000, 62_000, 93_000]) {
      setNow(1_000_000 + elapsed);
    runStaleChecks();
    await settleController();
    }
    assert.strictEqual(backoffLoads, 3);
    client.transcript = async () => { backoffLoads += 1; return load(); };
    setNow(1_000_000 + 183_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(backoffLoads, 4);
    assert.strictEqual(controller.store.get().threads.s1?.fold.activeTurnId, null);
    assert.deepStrictEqual(client.transcriptOptions.at(-1), { refresh: true });
    assert.strictEqual(client.sent.length, 0);
    tearDown();
  });

  it("reloads a thread whose ending never landed", async () => {
    const client = new MockAncillaRpcClient();
    let missingEndingLoads = 0;
    client.transcript = async () => {
      missingEndingLoads += 1;
      return runningLoad();
    };
    const { tearDown, setNow, runStaleChecks } = await startedWatching(client);
    assert.strictEqual(missingEndingLoads, 1);
    runStaleChecks();
    assert.strictEqual(missingEndingLoads, 1, "a thread that just applied anything is left alone");
    setNow(1_000_000 + 31_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(missingEndingLoads, 2, "a fold still showing a finished turn reloads from history");
    runStaleChecks();
    assert.strictEqual(missingEndingLoads, 2, "a fresh reload is not reloaded again at once");
    setNow(1_000_000 + 62_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(missingEndingLoads, 3, "a thread that stays silent is retried once per grace period");
    setNow(1_000_000 + 93_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(missingEndingLoads, 3, "a turn history never finishes stops being refetched");
    tearDown();
  });

  it("leaves a turn alone while it waits on the user, however long that takes (#54)", async () => {
    const client = new MockAncillaRpcClient();
    let waitingQuestionLoads = 0;
    client.transcript = async () => {
      waitingQuestionLoads += 1;
      return load({
        msp: { status: "running", activeTurnId: "live-1", modelId: "muse-spark-1.3", approvalMode: "onRequest", workspaceRoot: "/work/active-app", turnCount: 4 },
        events: [...historyEvents, { method: "turn/started", params: { turnId: "live-1" }, at: 1 }],
        // On load the server's pending set is what the fold trusts, not the event log.
        pending: {
          approvals: [],
          userInputs: [{ userInputId: "q1", turnId: "live-1", questions: [{ question: "Which one?", options: [] as any[] }] } as unknown as UserInputRequest],
        },
      });
    };
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    assert.strictEqual(waitingQuestionLoads, 1);
    for (const minutes of ([2, 5, 10, 30] as const)) {
      setNow(1_000_000 + minutes * 60_000);
    runStaleChecks();
    await settleController();
    }
    assert.strictEqual(waitingQuestionLoads, 1, "a question left unanswered for half an hour is never reloaded");
    assert.strictEqual(controller.store.get().threads["s1"]?.stalled, false, "and never reported as stalled");
    tearDown();
  });

  it("says a thread stalled once the reloads are spent, and retries when asked", async () => {
    const client = new MockAncillaRpcClient();
    let stalledThreadLoads = 0;
    client.transcript = async () => {
      stalledThreadLoads += 1;
      return runningLoad();
    };
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    assert.strictEqual(controller.store.get().threads["s1"]?.stalled, false, "nothing is stalled to begin with");

    setNow(1_000_000 + 31_000);
    runStaleChecks();
    await settleController();
    setNow(1_000_000 + 62_000);
    runStaleChecks();
    await flushMicrotasks();
    assert.strictEqual(controller.store.get().threads["s1"]?.stalled, false, "still trying, so nothing is said yet");

    setNow(1_000_000 + 93_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(controller.store.get().threads["s1"]?.stalled, true, "out of reloads: the view says so");
    assert.strictEqual(stalledThreadLoads, 3, "and stops reloading");

    await controller.retryStalledThread("s1");
    await settleController();
    assert.strictEqual(stalledThreadLoads, 4, "asking by hand tries again");
    tearDown();
  });

  it("reloads a turn both sides agree is running but silent", async () => {
    const client = new MockAncillaRpcClient();
    let silentTurnLoads = 0;
    client.transcript = async () => {
      silentTurnLoads += 1;
      return runningLoad();
    };
    const { tearDown, setNow, runStaleChecks } = await startedWatching(client);
    emitSessionStatus(client, "s1", { activeTurnId: "live-1" });
    setNow(1_000_000 + 60_000);
    runStaleChecks();
    assert.strictEqual(silentTurnLoads, 1, "a quiet-but-running turn gets a longer grace period");
    setNow(1_000_000 + 91_000);
    runStaleChecks();
    await settleController();
    assert.strictEqual(silentTurnLoads, 2);
    tearDown();
  });

  it("leaves idle threads and threads already loading alone", async () => {
    const client = new MockAncillaRpcClient();
    let idleAndLoadingLoads = 0;
    client.transcript = async () => {
      idleAndLoadingLoads += 1;
      return load();
    };
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    assert.strictEqual(idleAndLoadingLoads, 1);
    setNow(1_000_000 + 900_000);
    runStaleChecks();
    assert.strictEqual(idleAndLoadingLoads, 1, "an idle thread never reloads itself");

    let resolvePendingIdle!: (value: TranscriptLoad) => void;
    client.transcript = () => {
      idleAndLoadingLoads += 1;
      return new Promise<TranscriptLoad>((r) => (resolvePendingIdle = r));
    };
    const loading = controller.loadThread("s1");
    await settleController();
    assert.strictEqual(controller.store.get().threads["s1"]?.load, "loading");
    runStaleChecks();
    resolvePendingIdle(load({ events: [] }));
    await loading;
    await settleController();
    assert.strictEqual(idleAndLoadingLoads, 2, "a reload never piles onto a load already in flight");
    tearDown();
  });

  it("queues a resume behind a read in flight and lets later loads share it, so one request runs at a time", async () => {
    const client = new MockAncillaRpcClient();
    client.listSessions = async () => [LIVE_SESSION];
    const queuedOptions: ({ refresh?: boolean } | undefined)[] = [];
    let finishQueuedResume!: (value: TranscriptLoad) => void;
    client.loadTranscript = (_sessionId: string, requested?: { refresh?: boolean }) => {
      queuedOptions.push(requested);
      return new Promise<TranscriptLoad>((resolve) => {
        finishQueuedResume = resolve;
      });
    };
    const watchFakeEnv = watchPlatform().fake;
    const controller = new AncillaController(client, watchFakeEnv);
    const tearDown = controller.start();
    await settleController();
    try {
      assert.deepStrictEqual(queuedOptions, [{ refresh: true }], "the running session is read in place");
      const resume = controller.loadThread("s1", { resume: true });
      assert.strictEqual(controller.loadThread("s1", { resume: true }), resume, "a second resume shares the queued one");
      assert.strictEqual(controller.loadThread("s1"), resume, "and so does a plain load asked meanwhile");
      assert.strictEqual(queuedOptions.length, 1, "the read in flight is not interrupted");
      finishQueuedResume({ ...runningLoad(), session: LIVE_SESSION });
      await settleController();
      assert.deepStrictEqual(queuedOptions, [{ refresh: true }, undefined], "the resume follows the read");
      finishQueuedResume(load({ session: LIVE_SESSION }));
      await resume;
      assert.strictEqual(controller.store.get().threads.s1?.load, "ready");
      assert.strictEqual(controller.store.get().threads.s1?.fold.activeTurnId, null);
    } finally {
      tearDown();
    }
  });

  it("takes retry notices on the stream as life, so a turn waiting out a rate limit is neither reread nor stalled", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, tearDown, setNow, runStaleChecks, getReads } = await setupLiveWatchingHarness(client);
    try {
      let attemptIndex = 1;
      for (let tDelta = 15_000; tDelta <= 480_000; tDelta += 15_000) {
        const atTime = 1_000_000 + tDelta;
        if (tDelta % 75_000 === 0) {
          attemptIndex += 1;
          stream(client, controller, "s1", { method: "turn/retryScheduled", params: {
            turnId: "live-1", attempt: attemptIndex, maxAttempts: 10, nextAttempt: attemptIndex + 1, reason: "rateLimited", retryDelayMs: 75_000,
          } }, atTime);
        }
        setNow(atTime);
        runStaleChecks();
        await flushMicrotasks(2);
      }
      assert.strictEqual(getReads(), 1, "a stream that keeps reporting is never reread");
      const thread = controller.store.get().threads.s1!;
      assert.strictEqual(thread.stalled, false);
      assert.strictEqual(thread.fold.activeTurnId, "live-1");
      assert.strictEqual(thread.fold.turns["live-1"]?.retry?.attempt, attemptIndex, "the retry notice is kept");
    } finally {
      tearDown();
    }
  });

  it("takes usage and reminder traffic on the stream as life too", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, tearDown, setNow, runStaleChecks, getReads } = await setupLiveWatchingHarness(client);
    try {
      for (let timeStep = 15_000; timeStep <= 480_000; timeStep += 15_000) {
        const timestamp = 1_000_000 + timeStep;
        stream(client, controller, "s1", { method: "session/tokenUsage", params: {
          turnId: "live-1", cumulative: { promptTokens: timeStep, outputTokens: 1, totalTokens: timeStep + 1 }, viewCursor: `v:s1:${timeStep}`,
        } }, timestamp);
        stream(client, controller, "s1", { method: "item/completed", params: { item: {
          itemId: `reminder-${timeStep}`, kind: "reminderChild", status: "completed", revision: 1, turnId: "live-1", childSessionId: `helper-${timeStep}`,
        } } }, timestamp);
        setNow(timestamp);
        runStaleChecks();
        await flushMicrotasks(2);
      }
      assert.strictEqual(getReads(), 1);
      assert.strictEqual(controller.store.get().threads.s1?.stalled, false);
    } finally {
      tearDown();
    }
  });

  it("expects silence while a scheduled retry waits, then still catches a stream that stays quiet past it", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, tearDown, setNow, runStaleChecks, getReads } = await setupLiveWatchingHarness(client);
    try {
      setNow(1_015_000);
      stream(client, controller, "s1", { method: "turn/retryScheduled", params: {
        turnId: "live-1", attempt: 1, maxAttempts: 5, nextAttempt: 2, reason: "rateLimited", retryDelayMs: 150 * 1000,
      } }, 1_015_000);
      for (const elapsed of ([105_000, 165_000, 240_000] as const)) {
        setNow(1_000_000 + elapsed);
    runStaleChecks();
    await settleController();
      }
      assert.strictEqual(getReads(), 1, "the wait for the retry is expected, and the quiet clock starts when it is due");
      setNow(1_000_000 + 270_000);
    runStaleChecks();
    await settleController();
      assert.strictEqual(getReads(), 2, "silence past the retry is a quiet turn again");
    } finally {
      tearDown();
    }
  });

  it("keeps the retry Muse scheduled across a full read whose history does not record it", async () => {
    const client = new MockAncillaRpcClient();
    client.transcript = async (): Promise<any> => runningLoad();
    const { controller, tearDown } = await startedWatching(client);
    try {
      stream(client, controller, "s1", { method: "turn/retryScheduled", params: {
        turnId: "live-1", attempt: 1, maxAttempts: 5, nextAttempt: 2, reason: "rateLimited", retryDelayMs: 60 * 1000,
      } }, 1_000_002);
      await controller.loadThread("s1");
      assert.strictEqual(controller.store.get().threads.s1?.fold.turns["live-1"]?.retry?.nextAttempt, 2);
      stream(client, controller, "s1", { method: "turn/completed", params: { turnId: "live-1", terminal: "completed" } }, 1_000_003);
      await controller.loadThread("s1");
      assert.strictEqual(controller.store.get().threads.s1?.fold.turns["live-1"]?.retry, undefined, "an ended turn's retry stays cleared");
    } finally {
      tearDown();
    }
  });

  it("counts a child session's own events as life for the lead turn that spawned it", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, tearDown, setNow, runStaleChecks, getReads } = await setupLiveWatchingHarness(client);
    try {
      // The lead delegates, then says nothing itself while its subagent works in a session of its own.
      stream(client, controller, "s1", { method: "item/started", params: { item: {
        itemId: "sub-1" as const, kind: "subagent" as const, status: "inProgress", revision: 1, turnId: "live-1", childSessionId: "child-1",
      } } }, 1_010_000);
      for (let elapsed = 30_000; elapsed <= 480_000; elapsed += 30_000) {
        const childDeltaTime = 1_000_000 + elapsed;
        stream(client, controller, "child-1", { method: "item/delta", params: { itemId: `c${elapsed}`, field: "text", delta: "…", turnId: "child-turn" } }, childDeltaTime);
        setNow(childDeltaTime);
        runStaleChecks();
        await flushMicrotasks(2);
      }
      assert.strictEqual(getReads(), 1, "a lead whose child is working is not reread");
      assert.strictEqual(controller.store.get().threads.s1?.stalled, false);
      assert.strictEqual(controller.store.get().threads["child-1"], undefined, "the child's events open no thread of their own");
      // Everything goes silent, the child included: that is a quiet turn again.
      setNow(1_000_000 + 480_000 + 91_000);
    runStaleChecks();
    await settleController();
      assert.strictEqual(getReads(), 2);
    } finally {
      tearDown();
    }
  });

  it("ends a stall the moment the turn asks the user something, and starts the next quiet stretch afresh", async () => {
    const client = new MockAncillaRpcClient();
    let liveGracePeriodReads = 0;
    client.transcript = async () => { liveGracePeriodReads++; return runningLoad(); };
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    try {
      for (const elapsed of ([31_000, 62_000, 93_000] as const)) {
        setNow(1_000_000 + elapsed);
    runStaleChecks();
    await settleController();
      }
      assert.strictEqual(controller.store.get().threads.s1?.stalled, true);
      assert.strictEqual(liveGracePeriodReads, 3);
      stream(client, controller, "s1", { method: "userInput/requested", params: { userInputId: "q1", sessionId: "s1", turnId: "live-1", questions: [] } }, 1_093_500);
      const asked = controller.store.get().threads.s1!;
      assert.strictEqual(asked.stalled, false, "a question over the live stream is not a stopped stream");
      assert.ok(asked.fold.userInputs["q1"]);
      setNow(1_600_000); runStaleChecks(); await settleController();
      assert.strictEqual(liveGracePeriodReads, 3, "and the wait for the answer is never reread");
      assert.strictEqual(controller.store.get().threads.s1?.stalled, false);
      stream(client, controller, "s1", { method: "userInput/settled", params: { userInputId: "q1", outcome: "answered", answers: [] } }, 1_600_000);
      setNow(1_631_000);
    runStaleChecks();
    await settleController();
      assert.strictEqual(liveGracePeriodReads, 4, "the quiet stretch after the answer gets its quick reads again");
      assert.strictEqual(controller.store.get().threads.s1?.stalled, false, "rather than going straight back to stalled");
    } finally {
      tearDown();
    }
  });

  it("never calls a thread stalled for a read that failed, and a healthy read after it leaves nothing behind", async () => {
    const client = new MockAncillaRpcClient();
    client.transcript = async () => runningLoad();
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    try {
      client.transcript = async () => { throw new Error("socket connection hang up"); };
      await controller.loadThread("s1");
      const failed = controller.store.get().threads.s1!;
      assert.strictEqual(failed.load, "ready");
      assert.strictEqual(failed.error, "socket connection hang up");
      assert.strictEqual(failed.stalled, false, "one failed read says nothing about the stream");
      client.transcript = async () => runningLoad();
      setNow(1_031_000);
    runStaleChecks();
    await settleController();
      const healthy = controller.store.get().threads.s1!;
      assert.strictEqual(healthy.error, null);
      assert.strictEqual(healthy.stalled, false);
      assert.strictEqual(healthy.historySync, undefined);
    } finally {
      tearDown();
    }
  });

  it("stops reading a thread that was archived, and never puts it back into the sidebar", async () => {
    const client = new MockAncillaRpcClient();
    let readCounter = 0;
    let threadArchived = false;
    client.transcript = async () => { readCounter++; return { ...fallbackLoad(readCounter), session: { ...SESSION, archived: threadArchived } }; };
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    try {
      threadArchived = true;
      client.listSessions = async () => [];
      await controller.archive("s1");
      await controller.refresh();
      assert.strictEqual(controller.store.get().sessions.s1, undefined);
      const before = readCounter;
      for (let tick = 1; tick <= 6; tick++) {
        setNow(1_000_000 + tick * 121_000);
    runStaleChecks();
    await settleController();
      }
      assert.strictEqual(readCounter, before, "nobody can see it, so nothing reads it");
      assert.strictEqual(controller.store.get().sessions.s1, undefined);
      assert.strictEqual(controller.store.get().threads.s1?.stale, true, "opening it again reads it afresh");
    } finally {
      tearDown();
    }
  });

  it("does not put an archived thread back when a read of it was still in flight", async () => {
    const client = new MockAncillaRpcClient();
    client.transcript = async () => fallbackLoad(1);
    const { controller, tearDown } = await startedWatching(client);
    try {
      let resolveTranscript!: (value: TranscriptLoad) => void;
      client.transcript = () => new Promise<TranscriptLoad>((r) => { resolveTranscript = r; });
      const readThreadOp = controller.loadThread("s1");
      await settleController();
      client.listSessions = async () => [];
      await controller.archive("s1");
      resolveTranscript({ ...fallbackLoad(2), session: { ...SESSION, archived: true } });
      await readThreadOp;
      assert.strictEqual(controller.store.get().sessions.s1, undefined);
    } finally {
      tearDown();
    }
  });

  it("stops reading the threads of a project taken out of the sidebar", async () => {
    const client = new MockAncillaRpcClient();
    let hideProjectReads = 0;
    client.transcript = async () => { hideProjectReads++; return fallbackLoad(hideProjectReads); };
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    try {
      await controller.hideProject("/work/app");
      assert.deepStrictEqual(controller.store.get().route, { kind: "home" });
      const before = hideProjectReads;
      for (let tick = 1; tick <= 3; tick++) {
        setNow(1_000_000 + tick * 121_000);
    runStaleChecks();
    await settleController();
      }
      assert.strictEqual(hideProjectReads, before);
    } finally {
      tearDown();
    }
  });

  it("keeps a turn the stream saw end from coming back through a read that still names it", async () => {
    const client = new MockAncillaRpcClient();
    client.transcript = async () => runningLoad();
    const { controller, tearDown } = await startedWatching(client);
    try {
      stream(client, controller, "s1", { method: "turn/completed" as const, params: { turnId: "live-1", terminal: "completed" as const } }, 1_000_005);
      assert.strictEqual(controller.store.get().threads.s1?.fold.activeTurnId, null);
      // Muse then reports its view unavailable; a finished turn has nothing there to recover.
      client.handler?.({ type: "msp" as const, sessionId: "s1", method: "session/viewHealthChanged" as const,
        params: { health: "unavailable" as const, noneReason: "projectionUnavailable" as const }, at: 1_000_006 });
      await settleController();
      await flushMicrotasks();
      assert.strictEqual(client.transcriptOptions.length, 1, "an idle thread is not reread for an unavailable view");
      // A read that raced the ending still names the turn, in a partial page and in a full one alike.
      for (const partial of ([true, false] as const)) {
        client.transcript = async (): Promise<any> => ({
          ...runningLoad(),
          ...(partial ? { historyUnavailable: true, viewHealth: { status: "unavailable" as const, reason: "projectionUnavailable" as const } } : {}),
        });
        await controller.loadThread("s1", {});
        const loadedS1Thread = controller.store.get().threads.s1!;
        assert.strictEqual(loadedS1Thread.fold.activeTurnId, null, `${partial ? "partial" : "full"}: an ending the fold accepted is newer than the read`);
        assert.strictEqual(loadedS1Thread.fold.turns["live-1"]?.terminal, "completed");
        assert.strictEqual(loadedS1Thread.stalled, false);
        assert.strictEqual(loadedS1Thread.historySync, undefined);
      }
    } finally {
      tearDown();
    }
  });

  for (const partial of ([true, false] as const)) {
    for (const held of ([false, true] as const)) {
      it(`applies a live delta buffered during a ${partial ? "partial" : "full"} read once when the read ${held ? "already holds" : "lacks"} it`, async () => {
        const client = new MockAncillaRpcClient();
        const createAgentMsgEvent = (bodyMsg: string): ViewEvent => ({
          method: "item/updated",
          params: { item: { itemId: "m", kind: "agentMessage", turnId: "live-1", revision: 1, status: "inProgress", text: bodyMsg } },
        });
        const createTextDeltaEvent = (deltaChunk: string): ViewEvent => ({
          method: "item/delta",
          params: { itemId: "m", field: "text", delta: deltaChunk, turnId: "live-1" },
        });
        const readTranscriptState = (bodyMsg: string): TranscriptLoad => ({
          ...runningLoad(),
          events: [...runningLoad().events, createAgentMsgEvent(bodyMsg)],
          ...(partial ? { historyUnavailable: true, viewHealth: { status: "unavailable", reason: "projectionUnavailable" } } : {}),
        });
        const message = createAgentMsgEvent;
        const delta = createTextDeltaEvent;
        const read = readTranscriptState;
        const getShownFoldText = () => controller.store.get().threads.s1?.fold.items["m"]?.text;
        const shown = getShownFoldText;
        client.transcript = async (): Promise<any> => read("Hello");
        const { controller, tearDown } = await startedWatching(client);
        try {
          stream(client, controller, "s1", delta("!"), 1_000_002);
          assert.strictEqual(shown(), "Hello!");
          let fulfillTranscript!: (value: TranscriptLoad) => void;
          client.transcript = () => new Promise((resolve) => { fulfillTranscript = resolve; });
          const threadLoadingPromise = controller.loadThread("s1");
          await settleController();
          // The feed delivers " world" while the read is in flight; the read may have caught it or not.
          client.handler?.({ type: "msp", sessionId: "s1", ...delta(" world"), at: 1_000_003 });
          fulfillTranscript(read(held ? "Hello! world" : "Hello!"));
          await threadLoadingPromise;
          assert.strictEqual(shown(), "Hello! world");
        } finally {
          tearDown();
        }
      });
    }
  }

  it("ends a saved-progress sync when the server reports the view healthy again, and keeps watching for silence", async () => {
    const client = new MockAncillaRpcClient();
    let healthySyncReads = 0;
    client.transcript = async () => { healthySyncReads++; return fallbackLoad(healthySyncReads); };
    const { controller, tearDown, setNow, runStaleChecks } = await startedWatching(client);
    try {
      assert.ok(controller.store.get().threads.s1?.historySync);
      setNow(1_015_000);
    runStaleChecks();
    await settleController();
      assert.strictEqual(healthySyncReads, 2, "saved progress is checked every 15 seconds while the view is unavailable");
      const makeLiveFixture = (viewHealth: { status: string; reason: string | null } | null) =>
        ({ ...LIVE_SESSION.live!, viewHealth });
      client.handler?.({ type: "session-status", sessionId: "s1", live: makeLiveFixture({ status: "unavailable", reason: "projectionUnavailable" }) });
      client.handler?.({ type: "session-status", sessionId: "s1", live: makeLiveFixture(null) });
      const recovered = controller.store.get().threads.s1!;
      assert.strictEqual(recovered.historySync, undefined);
      assert.strictEqual(recovered.stalled, false);
      setNow(1_030_000);
    runStaleChecks();
    await settleController();
      setNow(1_045_000);
    runStaleChecks();
    await settleController();
      assert.strictEqual(healthySyncReads, 2, "the fast cadence stops with the sync");
      setNow(1_015_000 + 91_000);
    runStaleChecks();
    await settleController();
      assert.strictEqual(healthySyncReads, 3, "a stream that then stays silent is still caught");
    } finally {
      tearDown();
    }
  });
});

describe("crew controls", () => {
  const BASE_CREW_TIME = Date.UTC(2026, 8, 26, 14, 2, 0);
  const T = BASE_CREW_TIME;
  const makeWorkflowEvent = (revision: number, children: Record<string, unknown>[], status = "inProgress"): AncillaEvent => ({
    type: "msp" as const,
    sessionId: "s1",
    method: revision === 1 ? ("item/started" as const) : ("item/updated" as const),
    at: T + revision * 1000,
    params: { item: { itemId: "wf", kind: "workflow", status, revision, turnId: "t9", workflowRunId: "run-1", entryId: "audit", children } },
  });
  const workflow = makeWorkflowEvent;
  const makeTaskEvent = (revision: number, status: string): AncillaEvent => ({
    type: "msp" as const,
    sessionId: "s1",
    method: status === "inProgress" ? ("item/updated" as const) : ("item/completed" as const),
    at: T + revision * 1000,
    params: { item: { itemId: "task-1", kind: "toolCall", status, revision, tool: "bash", args: JSON.stringify({ command: "npm run docs:build" }), background: true } },
  });
  const task = makeTaskEvent;
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
  const agentOf = (controller: AncillaController, id: string): AgentVM => {
    const thread = controller.store.get().threads["s1"]!;
    const vm = crewView(thread.fold, SESSION, Date.now(), { pending: controller.store.get().crew.pending });
    const run = vm.runs[0];
    const agent = run?.agents.find((a) => a.id === id) ?? vm.tasks.find((t) => t.id === id) ?? vm.subagents.find((a) => a.id === id);
    assert.strictEqual(Boolean(agent), true, `no agent ${id}`);
    return agent as AgentVM;
  };

  it("migrates the file viewer's switch to the side-panel setting and keeps the two in step", () => {
    const fallbackDefaultPrefs = defaultPrefs();
    assert.strictEqual(revivePrefs({ filesOpen: true }, fallbackDefaultPrefs).sidePanel, "files");
    assert.strictEqual(revivePrefs({ filesOpen: true }, fallbackDefaultPrefs).filesOpen, true);
    assert.strictEqual(revivePrefs({ sidePanel: "crew", filesOpen: true }, fallbackDefaultPrefs).sidePanel, "crew", "the new setting wins over the old switch");
    assert.strictEqual(revivePrefs({ sidePanel: "crew", filesOpen: true }, fallbackDefaultPrefs).filesOpen, false);
    assert.strictEqual(revivePrefs({ filesOpen: false }, fallbackDefaultPrefs).sidePanel, "none");
    assert.strictEqual(revivePrefs({ crewWidth: 9_999 }, fallbackDefaultPrefs).crewWidth, DEFAULT_CREW_WIDTH);
    assert.strictEqual(revivePrefs({ crewWidth: 640 }, fallbackDefaultPrefs).crewWidth, 640);
  });

  it("carries a saved Swarm panel and its width over to the Crew names", () => {
    const fallbackDefaultPrefs = defaultPrefs();
    assert.strictEqual(revivePrefs({ sidePanel: "swarm" }, fallbackDefaultPrefs).sidePanel, "crew");
    assert.strictEqual(revivePrefs({ swarmWidth: 640 }, fallbackDefaultPrefs).crewWidth, 640);
    assert.strictEqual(revivePrefs({ swarmWidth: 640, crewWidth: 700 }, fallbackDefaultPrefs).crewWidth, 700, "the new key wins");
    assert.strictEqual(revivePrefs({ swarmWidth: 9_999 }, fallbackDefaultPrefs).crewWidth, DEFAULT_CREW_WIDTH);
  });

  it("swaps the slot between the file viewer and the Crew panel, one at a time", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    try {
      const prefs = () => controller.store.get().prefs;
      controller.toggleCrewPanel();
      assert.strictEqual(prefs().sidePanel, "crew");
      assert.strictEqual(prefs().filesOpen, false);
      controller.toggleFiles();
      assert.strictEqual(prefs().sidePanel, "files", "opening files closes the Crew panel");
      assert.strictEqual(prefs().filesOpen, true);
      controller.toggleCrewPanel(true);
      assert.strictEqual(prefs().sidePanel, "crew");
      assert.strictEqual(prefs().filesOpen, false);
      controller.toggleCrewPanel();
      assert.strictEqual(prefs().sidePanel, "none");
      controller.openFile("s1", "README.md");
      assert.strictEqual(prefs().sidePanel, "files", "opening a file shows the viewer");
      controller.setCrewWidth(10_000);
      assert.strictEqual(prefs().crewWidth, 800);
      controller.setCrewWidth(10);
      assert.strictEqual(prefs().crewWidth, 400);
    } finally {
      stopController();
    }
  });

  it("keeps a retry pending until the next attempt shows, and a skip until the outcome does", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    try {
      client.handler?.(workflow(1, [{ childId: "c1", attempt: 1, status: "scheduled" as const, label: "audit:routes" as string }, { childId: "c2", attempt: 1, status: "scheduled", label: "audit:schema" }]));
      client.handler?.(workflow(2, [{ childId: "c1", attempt: 1, status: "terminal", terminal: "failed" }, { childId: "c2", attempt: 1, status: "started" }]));
      await settleController();
      const failed = agentOf(controller, "c1");
      assert.strictEqual(failed.state, "failed");
      assert.strictEqual(await controller.crewAction("s1", failed, "retry"), true);
      assert.deepStrictEqual(client.actions.at(-1), "workflow:s1:retry:run-1:c1@1");
      assert.deepStrictEqual(controller.store.get().crew.pending, { "s1:c1:1": "retry" });
      assert.strictEqual(agentOf(controller, "c2").pending, null);
      client.handler?.(workflow(3, [{ childId: "c1", attempt: 2, status: "scheduled", label: "audit:routes" }, { childId: "c2", attempt: 1, status: "started" }]));
      await settleController();
      assert.deepStrictEqual(controller.store.get().crew.pending, {}, "attempt 2 on the wire confirms the retry");
      assert.strictEqual(agentOf(controller, "c1").attempt, 2);

      const working = agentOf(controller, "c2");
      assert.strictEqual(await controller.crewAction("s1", working, "skip"), true);
      assert.deepStrictEqual(client.actions.at(-1), "workflow:s1:skip:run-1:c2@1");
      assert.deepStrictEqual(controller.store.get().crew.pending, { "s1:c2:1": "stop" });
      assert.deepStrictEqual(controller.store.get().crew.skipped, ["s1:c2:1"]);
      assert.strictEqual(agentOf(controller, "c2").pending, "stop");
      client.handler?.(workflow(4, [{ childId: "c1", attempt: 2, status: "started" }, { childId: "c2", attempt: 1, status: "terminal", terminal: "cancelled" }]));
      await settleController();
      assert.deepStrictEqual(controller.store.get().crew.pending, {});
      const skipped = crewView(controller.store.get().threads["s1"]!.fold, SESSION, Date.now(), { skipped: controller.store.get().crew.skipped }).runs[0]!.agents.find((a) => a.id === "c2");
      assert.strictEqual(skipped?.skippedBy, "you");
    } finally {
      stopController();
    }
  });

  it("clears a pending action the workflow refuses", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    try {
      client.handler?.(workflow(1, [{ childId: "c1", attempt: 1, status: "started", label: "audit:routes" }]));
      await settleController();
      client.workflowError = new AncillaError("stale attempt revision", 409, "stale_attempt");
      assert.strictEqual(await controller.crewAction("s1", agentOf(controller, "c1"), "stop"), false);
      assert.deepStrictEqual(controller.store.get().crew.pending, {});
      assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "That agent already moved on");
      assert.strictEqual(await controller.crewAction("s1", { ...agentOf(controller, "c1"), workflowRunId: null }, "retry"), false, "no run id, nothing to send");
    } finally {
      stopController();
    }
  });

  it("stops a background task through the task command and clears the flag when it ends", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    try {
      client.handler?.(task(1, "inProgress"));
      await settleController();
      const runningTaskAgent = agentOf(controller, "task-1");
      assert.strictEqual(runningTaskAgent.kind, "task");
      assert.strictEqual(await controller.crewAction("s1", runningTaskAgent, "retry"), false, "a task cannot be retried from here");
      assert.strictEqual(await controller.crewAction("s1", runningTaskAgent, "stop"), true);
      assert.strictEqual(client.actions.at(-1), "task:s1:stop:task-1");
      assert.strictEqual(agentOf(controller, "task-1").pending, "stop");
      client.handler?.(task(2, "completed"));
      await settleController();
      assert.deepStrictEqual(controller.store.get().crew.pending, {});
      assert.strictEqual(agentOf(controller, "task-1").state, "done");
    } finally {
      stopController();
    }
  });

  it("stops everything in one thread and says what it asked to stop", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    try {
      client.handler?.(workflow(1, [{ childId: "c1", attempt: 1, status: "started", label: "audit:routes" }]));
      client.handler?.(task(1, "inProgress" as const));
      await settleController();
      assert.deepStrictEqual(await controller.stopEverything("s1"), { runs: ["audit"], tasks: ["npm run docs:build"] });
      assert.deepStrictEqual(client.actions.slice(-2), ["workflow:s1:cancel:run-1", "task:s1:stopAll"]);
      assert.deepStrictEqual(controller.store.get().crew.pending, { "s1:task-1:1": "stop" });
      assert.deepStrictEqual(await controller.stopEverything("s2"), { runs: [], tasks: [] }, "a thread this client does not hold has nothing to stop");
      assert.strictEqual(await controller.stopRun("s1", "wf"), true);
      assert.strictEqual(client.actions.at(-1), "workflow:s1:cancel:run-1");
      assert.strictEqual(await controller.stopRun("s1", "nope"), false);
    } finally {
      stopController();
    }
  });

  it("stops live native agents with everything else and waits for acceptance without inventing completion", async () => {
    const client = new MockAncillaRpcClient();
    let accept!: () => void;
    const admitted = new Promise<void>((resolve) => { accept = resolve; });
    client.subagent = async (sessionId, action, id) => {
      client.actions.push(`subagent:${sessionId}:${action}:${id}`);
      await admitted;
    };
    const { controller, stop: stopController } = await started(client);
    try {
      client.handler?.(workflow(1, [{ childId: "c1", attempt: 1, status: "started", label: "audit:routes" }]));
      client.handler?.(task(1, "inProgress"));
      client.handler?.(nativeSpawn("working"));
      client.handler?.(nativeSpawn("finished"));
      client.handler?.(nativeDone("finished"));
      await settleController();

      let answered = false;
      const stopping = controller.stopEverything("s1").then((result) => { answered = true; return result; });
      await flushMicrotasks();
      assert.strictEqual(answered, false, "a pending command is not reported as an accepted stop");
      assert.strictEqual(agentOf(controller, "working").state, "working");
      assert.strictEqual(agentOf(controller, "working").pending, "stop");
      assert.ok(client.actions.includes("workflow:s1:cancel:run-1"));
      assert.ok(client.actions.includes("task:s1:stopAll"), "native admission does not hold up background stops");
      assert.deepStrictEqual(client.actions.filter((action) => action.startsWith("subagent:")), ["subagent:s1:stop:working"]);

      accept();
      assert.deepStrictEqual(await stopping, { runs: ["audit"], tasks: ["npm run docs:build"], agents: ["native-working"] });
      assert.strictEqual(agentOf(controller, "working").state, "working", "admission does not mean the child has stopped");
      assert.strictEqual(agentOf(controller, "working").pending, "stop");
      client.handler?.(nativeDone("working"));
      await settleController();
      assert.strictEqual(agentOf(controller, "working").state, "done");
      assert.strictEqual(agentOf(controller, "working").pending, null);
    } finally {
      accept();
      stopController();
    }
  });

  it("returns only accepted bulk stops and clears pending native and task flags on refusal", async () => {
    const client = new MockAncillaRpcClient();
    client.workflowError = new Error("The run refused the stop.");
    client.task = async () => { throw new Error("The tasks refused the stop."); };
    client.subagent = async (_sessionId, _action, id) => {
      if (id === "refused") throw new Error("The agent refused the stop.");
    };
    const { controller, stop: stopController } = await started(client);
    try {
      client.handler?.(workflow(1, [{ childId: "c1", attempt: 1, status: "started", label: "audit:routes" }]));
      client.handler?.(task(1, "inProgress"));
      client.handler?.(nativeSpawn("accepted"));
      client.handler?.(nativeSpawn("refused"));
      await settleController();
      assert.deepStrictEqual(await controller.stopEverything("s1"), { runs: [], tasks: [], agents: ["native-accepted"] });
      assert.deepStrictEqual(controller.store.get().crew.pending, { "s1:accepted:1": "stop" });
      assert.strictEqual(agentOf(controller, "refused").pending, null);
      assert.strictEqual(agentOf(controller, "refused").state, "working");
      assert.strictEqual(agentOf(controller, "task-1").pending, null);
    } finally {
      stopController();
    }
  });

  it("routes a Crew stop on a research run to stopResearch, refuses worker controls, and stops research with everything else", async () => {
    const client = new MockAncillaRpcClient();
    const research = runningResearch();
    client.researchRuns.push(research);
    client.transcript = async () => load({ researchRuns: [research] });
    const { controller, stop: stopController } = await started(client);
    try {
      client.handler?.(workflow(1, [{ childId: "c1", attempt: 1, status: "started", label: "audit:routes" }]));
      await settleController();
      const threadOf = () => controller.store.get().threads["s1"]!;
      const vm = crewView(threadOf().fold, SESSION, Date.now(), { researchRuns: threadOf().researchRuns });
      const worker = vm.runs.flatMap((run) => run.agents).find((candidate) => candidate.id === "research:run-1:A3");
      assert.ok(worker);
      assert.strictEqual(await controller.crewAction("s1", worker, "stop"), false, "a worker takes no stop of its own");
      assert.strictEqual(await controller.crewAction("s1", worker, "retry"), false);
      assert.deepStrictEqual(controller.store.get().crew.pending, {}, "nothing is marked pending for it");
      assert.deepStrictEqual(client.researchStops, []);

      const stopped = await controller.stopEverything("s1");
      assert.deepStrictEqual([...stopped.runs].sort(), ["audit", vm.runs.find((run) => run.kind === "research")?.name].sort());
      assert.deepStrictEqual(stopped.tasks, []);
      assert.strictEqual(client.actions.at(-1), "workflow:s1:cancel:run-1");
      assert.deepStrictEqual(client.researchStops, [{ runId: "run-1", writeReport: true }], "the composer's switch says a stop writes a report");
      assert.strictEqual(threadOf().researchRuns[0]?.status, "partial", "the answer to the stop lands on the run");
      assert.strictEqual(controller.store.get().researchStopping["run-1"], undefined);

      const again = runningResearch({ runId: "run-2" });
      client.researchRuns.push(again);
      client.handler?.({ type: "research-run", sessionId: "s1", run: again });
      await settleController();
      controller.setResearchStopWrites(false);
      assert.strictEqual(await controller.stopRun("s1", "research:run-2"), true);
      assert.deepStrictEqual(client.researchStops.at(-1), { runId: "run-2", writeReport: false });
      assert.strictEqual(threadOf().researchRuns.find((run) => run.runId === "run-2")?.status, "cancelled");
      assert.strictEqual(await controller.stopRun("s1", "research:missing"), false, "an unknown run is refused with a toast");
      assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Could not stop the research run");
    } finally {
      stopController();
    }
  });

  it("notes when a thread was left, and forgets it once the recap is dismissed", async () => {
    const client = new MockAncillaRpcClient();
    const other: SessionSummary = { ...SESSION, sessionId: "s2", title: "Other" };
    client.listSessions = async () => [SESSION, other];
    const { controller, stop: stopController } = await started(client);
    try {
      assert.deepStrictEqual(controller.store.get().crew.leftAt, {});
      controller.openThread("s2");
      await settleController();
      const left = controller.store.get().crew.leftAt["s1"];
      assert.ok(typeof left === "number" && left > 0, "leaving the thread notes when");
      controller.markLeft("s2", 123);
      assert.strictEqual(controller.store.get().crew.leftAt["s2"], 123);
      controller.dismissRecap("s1");
      assert.strictEqual(controller.store.get().crew.leftAt["s1"], undefined);
      assert.deepStrictEqual(controller.store.get().crew.dismissedRecaps, ["s1"]);
      controller.markLeft("s1", 456);
      assert.deepStrictEqual(controller.store.get().crew.dismissedRecaps, [], "a new absence gets a new recap");
      controller.dismissReport("s1", "wf");
      controller.dismissReport("s1", "wf");
      assert.deepStrictEqual(controller.store.get().crew.dismissedReports, ["s1:wf"]);
    } finally {
      stopController();
    }
  });

  it("drives the panel state and names the window through the shell", async () => {
    const client = new MockAncillaRpcClient();
    const panelWindowTitles: string[] = [];
    const shell = { ...platform("#/t/s1"), setWindowTitle: (title: string) => { panelWindowTitles.push(title); } };
    const controller = new AncillaController(client, shell);
    const tearDown = controller.start();
    await settleController();
    await flushMicrotasks();
    try {
      const panel = () => controller.store.get().crew.panels["s1"];
      assert.strictEqual(panel(), undefined);
      controller.inspectAgent("s1", "c1");
      assert.deepStrictEqual(panel(), { mode: "inspector", inspectId: "c1", filter: "all", query: "", timelineOpen: true, openPhases: [] });
      assert.strictEqual(controller.store.get().prefs.sidePanel, "crew", "inspecting opens the panel");
      controller.inspectAgent("s1", null);
      assert.strictEqual(panel()?.mode, "roster");
      controller.setCrewFilter("s1", "failed", "judge:");
      assert.strictEqual(panel()?.filter, "failed");
      assert.strictEqual(panel()?.query, "judge:");
      controller.setCrewFilter("s1", "all");
      assert.strictEqual(panel()?.query, "judge:", "the query stays unless given");
      controller.toggleTimeline("s1");
      assert.strictEqual(panel()?.timelineOpen, false);
      controller.togglePhase("s1", "Judge");
      controller.togglePhase("s1", "Design");
      controller.togglePhase("s1", "Judge");
      assert.deepStrictEqual(panel()?.openPhases, ["Design"]);
      controller.setActivityOpen(true);
      assert.strictEqual(controller.store.get().crew.activityOpen, true);
      controller.setWindowTitle("(1) Probe — Ancilla");
      assert.deepStrictEqual(panelWindowTitles, ["(1) Probe — Ancilla"]);
    } finally {
      tearDown();
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

class LinuxSetupClient extends MockAncillaRpcClient {
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

function linuxController(client: MockAncillaRpcClient, desktop?: Platform["linuxDesktop"]) {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timer = 0;
  const shell: Platform = { ...platform(""), linuxDesktop: desktop,
    schedule: (fn, ms) => { timers.set(++timer, { fn, ms }); return timer; },
    cancel: (id) => { timers.delete(id as number); },
  };
  const controller = new AncillaController(client, shell);
  const stop = controller.start();
  return { controller, timers, stop, tearDown: stop, tick(ms: number) {
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
    const { controller, stop, tearDown } = linuxController(client);
    tearDown();
    const stopAgain = controller.start();
    try {
      await flushMicrotasks();
      assert.strictEqual(controller.store.get().linuxSetup?.installation.status, "idle");
      assert.strictEqual(controller.store.get().boot, "ready");
      finishOld({ ...current, museFound: true });
      await flushMicrotasks();
      assert.strictEqual(controller.store.get().env?.museFound, false);
      await controller.installLinuxMuse();
      assert.strictEqual(controller.store.get().linuxSetup?.installation.status, "installing");
    } finally { stopAgain(); }
  });

  it("polls a Muse installation and opens the product only after the installer completes", async () => {
    const client = new LinuxSetupClient();
    const { controller, stop, tearDown, tick, timers } = linuxController(client);
    await flushMicrotasks();
    assert.strictEqual(controller.store.get().env?.museFound, false);
    assert.strictEqual(controller.store.get().sessionsLoaded, false);
    await controller.installLinuxMuse();
    assert.strictEqual(controller.store.get().linuxSetup?.installation.status, "installing");
    client.setup = { ...client.setup, museFound: true, installation: { ...client.setup.installation, phase: "signin", loginUrl: "https://www.meta.ai/device", loginCode: "ABCD" } };
    tick(1_500);
    await flushMicrotasks();
    assert.strictEqual(controller.store.get().linuxSetup?.installation.loginCode, "ABCD");
    assert.strictEqual(controller.store.get().env?.museFound, false, "a partially installed launcher must not finish setup");
    assert.strictEqual(client.probes, 1);
    client.setup = linuxSetupView("installed");
    tick(1_500);
    await flushMicrotasks(50);
    assert.strictEqual(controller.store.get().env?.museFound, true);
    assert.strictEqual(controller.store.get().sessionsLoaded, true);
    assert.strictEqual(controller.store.get().boot, "ready");
    assert.strictEqual([...timers.values()].some((value) => value.ms === 1_500), false);
    tearDown();
  });

  it("cancels the displayed attempt and ignores a late in-flight poll", async () => {
    const client = new LinuxSetupClient();
    const { controller, stop, tearDown } = linuxController(client);
    await flushMicrotasks();
    await controller.installLinuxMuse();
    let resolve!: (view: LinuxSetupView) => void;
    client.linuxSetup = async () => new Promise<LinuxSetupView>((done) => { resolve = done; });
    const pending = controller.refreshLinuxSetup();
    await controller.cancelLinuxMuseInstall();
    assert.deepStrictEqual(client.cancelled, ["install-1"]);
    resolve(linuxSetupView("installing"));
    await pending;
    assert.strictEqual(controller.store.get().linuxSetup?.installation.status, "cancelled");
    assert.strictEqual(controller.store.get().busy["linux-setup:check"], undefined);
    assert.strictEqual(controller.store.get().busy["linux-setup:cancel"], undefined);
    tearDown();
  });

  it("retains a failed installation for retry even if its launcher is already on disk", async () => {
    const client = new LinuxSetupClient();
    const { controller, stop, tearDown } = linuxController(client);
    await flushMicrotasks();
    client.installLinuxMuse = async () => ({ ...linuxSetupView("error"), museFound: true });
    await controller.installLinuxMuse();
    assert.strictEqual(controller.store.get().env?.museFound, false);
    assert.strictEqual(controller.store.get().linuxSetup?.installation.status, "error");
    assert.strictEqual(client.probes, 1);
    tearDown();
  });

  it("keeps the composer on its route and offers named-account storage recovery after a failed start", async () => {
    const client = new LinuxSetupClient();
    client.setup = linuxSetupView("installed");
    client.projects[0] = { ...client.projects[0]!, defaultAccountId: "work" };
    client.startSession = async () => { throw new AncillaError("Muse cannot use /home/person/.ancilla/accounts/work: the folder belongs to another account.", 409, "muse_storage_unavailable"); };
    const { controller, stop, tearDown } = linuxController(client);
    await flushMicrotasks(50);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    const route = controller.store.get().route;
    assert.strictEqual(await controller.send("Keep this draft"), false);
    await flushMicrotasks();
    assert.deepStrictEqual(controller.store.get().route, route);
    assert.strictEqual(controller.store.get().linuxSetupAccountId, "work");
    assert.strictEqual(client.setupAccounts.at(-1), "work");
    const toast = controller.store.get().toasts.at(-1);
    assert.strictEqual(toast?.title, "Muse storage needs attention");
    assert.match(toast?.detail ?? "", /Your draft is still here/);
    assert.strictEqual(toast?.action?.label, "Open Linux setup");
    toast?.action?.run();
    assert.strictEqual(controller.store.get().route.kind, "settings");
    await controller.repairLinuxStorage();
    assert.deepStrictEqual(client.repaired, ["work"]);
    tearDown();
  });

  it("translates legacy Unsafe path errors into a recovery action", async () => {
    const client = new LinuxSetupClient();
    client.setup = linuxSetupView("installed");
    client.startSession = async () => { throw new Error("session/start: read surviving deletion authority: deletion registry authority is unavailable: Unsafe path"); };
    const { controller, stop, tearDown } = linuxController(client);
    await flushMicrotasks(50);
    await controller.send("Keep this draft too");
    const toast = controller.store.get().toasts.at(-1);
    assert.strictEqual(toast?.title, "Muse storage needs attention");
    assert.match(toast?.detail ?? "", /fix its permissions/);
    assert.doesNotMatch(toast?.detail ?? "", /Unsafe path|session\/start/);
    tearDown();
  });

  it("reports setup endpoint failures without turning a reachable app into a boot error", async () => {
    const client = new LinuxSetupClient();
    client.setup = linuxSetupView("installed");
    client.linuxSetup = async () => { throw new AncillaError("Not found", 404); };
    const { controller, stop, tearDown } = linuxController(client);
    await flushMicrotasks(50);
    assert.strictEqual(controller.store.get().boot, "ready");
    assert.match(controller.store.get().linuxSetupError ?? "", /server needs an update/);
    tearDown();
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
    const { controller, stop, tearDown } = linuxController(client, desktop);
    await flushMicrotasks(50);
    await controller.installLinuxDesktop(false);
    resolve(old);
    await flushMicrotasks();
    assert.deepStrictEqual(options, [false]);
    assert.strictEqual(controller.store.get().linuxDesktop?.menuInstalled, true);
    assert.strictEqual(controller.store.get().linuxDesktop?.desktopShortcutInstalled, false);
    assert.strictEqual(controller.store.get().linuxDesktop?.restartRequired, true);
    await controller.relaunchLinuxDesktop();
    assert.match(controller.store.get().linuxDesktopError ?? "", /Could not launch/);
    tearDown();
  });

  it("stops installation polling when the UI is disposed", async () => {
    const client = new LinuxSetupClient();
    const { controller, stop, tearDown, timers } = linuxController(client);
    await flushMicrotasks();
    await controller.installLinuxMuse();
    assert.strictEqual([...timers.values()].some((value) => value.ms === 1_500), true);
    tearDown();
    assert.strictEqual([...timers.values()].some((value) => value.ms === 1_500), false);
  });

  it("keeps non-Linux setup on the existing installation path", async () => {
    const client = new LinuxSetupClient();
    client.probeEnvironment = async () => ({ platform: "darwin" as any, wslAvailable: false, defaultDistro: null, museFound: true, musePath: "/usr/bin/muse", version: "0.20.3", persistent: true });
    client.startSession = async () => { throw new Error("session/start: read surviving deletion authority: Unsafe path"); };
    const { controller, stop, tearDown } = linuxController(client);
    await flushMicrotasks(50);
    controller.navigate({ kind: "settings" });
    await controller.installLinuxMuse();
    assert.deepStrictEqual(client.setupAccounts, []);
    assert.strictEqual(controller.store.get().linuxSetup, null);
    controller.navigate({ kind: "new", cwd: "/work/app" });
    assert.strictEqual(await controller.send("Keep this draft"), false);
    assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Could not start a thread");
    assert.strictEqual(controller.store.get().toasts.at(-1)?.action, undefined, "other platforms cannot open Linux setup");
    tearDown();
  });
});

describe("the assistant page", () => {
  it("has a route of its own, an address for it, and keeps the page it came from for Back", async () => {
    assert.strictEqual(routeToHash({ kind: "assistant" }), "#/assistant");
    assert.deepStrictEqual(hashToRoute("#/assistant"), { kind: "assistant" });
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    controller.navigate({ kind: "assistant" });
    assert.deepStrictEqual(controller.store.get().route, { kind: "assistant" });
    controller.goBack();
    assert.deepStrictEqual(controller.store.get().route, { kind: "thread", sessionId: "s1" });
    stopController();
  });

  it("passes a call of the assistant's surface to the server unchanged", async () => {
    const client = new MockAncillaRpcClient();
    client.assistantReply = { available: true };
    const { controller, stop: stopController } = await started(client);
    assert.deepStrictEqual(await controller.assistant("PATCH", "/profile", { enabled: true }), { available: true });
    assert.deepStrictEqual(client.assistantCalls.filter((c) => c.method !== "GET"), [{ method: "PATCH", path: "/profile", body: { enabled: true } }]);
    stopController();
  });

  const CHARACTER = {
    avatar: { form: "optic", hue: 195, glow: 70, detail: 1, seed: 7 },
    voice: { archetype: "dry", warmth: 1, humor: 4, directness: 3, curiosity: 1, formality: 2 },
    callsUser: "Alex", quirks: [], presence: "tone", showBond: true, setupAt: 1,
  };
  const status = (profile: Record<string, unknown>, tasks = { open: 3, needsYou: 2, running: 1 }) => ({ available: true, profile: { enabled: true, name: "Vesper", character: CHARACTER, ...profile }, tasks });

  it("reads a glance of the assistant at boot, and again when the server says something changed", async () => {
    const client = new MockAncillaRpcClient();
    client.assistantReply = status({});
    const { controller, stop: stopController } = await started(client);
    await settleController();
    assert.deepStrictEqual(controller.store.get().assistantGlance, { enabled: true, name: "Vesper", character: CHARACTER, open: 3, needsYou: 2, running: 1 });
    client.assistantReply = status({ enabled: false, name: "Vesper" }, { open: 0, needsYou: 0, running: 0 });
    client.handler?.({ type: "assistant", reason: "profile", epoch: 2 });
    await settleController();
    assert.strictEqual(controller.store.get().assistantGlance?.enabled, false);
    assert.strictEqual(controller.store.get().assistantGlance?.needsYou, 0);
    stopController();
  });

  describe("a task that waits on the person", () => {
    const waiting = (cause: string, reason: string, id = "t1") => [{ id, title: "Look at A", cause, reason }];
    const reading = (list: unknown[] | undefined) => ({ ...status({}), tasks: { open: 1, needsYou: list?.length ?? 0, running: 0, ...(list ? { waiting: list } : {}) } });
    const armed = async (client: MockAncillaRpcClient) => {
      const shown: Array<{ tag: string; body: string; onClick?: () => void }> = [];
      // Notifications are on and the notifier is there before the first reading, as for a person who turned them on.
      const controller = new AncillaController(client, { ...platform("#/t/s1"), loadPrefs: () => ({ notifications: true }) });
      controller.attachNotifier({ permission: async () => "granted", request: async () => "granted", show: async (note) => { shown.push(note); } });
      const stop = controller.start();
      await settleController();
      await settleController();
      const read = async () => {
        await controller.loadAssistantGlance();
        await settleController();
      };
      return { controller, stop, shown, read };
    };

    it("is said once, when it begins to wait: not what was waiting at the start, nor the same reading again", async () => {
      const client = new MockAncillaRpcClient();
      client.assistantReply = reading(waiting("approval", "Waiting for your approval to change files in atlas."));
      const { controller, stop, shown, read } = await armed(client);
      await read();
      assert.strictEqual(shown.length, 0, "what was already waiting when the app began is not news");

      client.assistantReply = reading([...waiting("approval", "Waiting for your approval to change files in atlas."), ...waiting("site", "Waiting for your approval to open https://a.example.", "t2")]);
      await read();
      assert.deepStrictEqual(shown.map((note) => [note.tag, note.body]), [["task:t2", '"Look at A" asks before opening a site.']]);

      await read();
      assert.strictEqual(shown.length, 1, "the same reading says nothing again");
      stop();
    });

    it("is said again when it stops waiting and begins again, and not when it only asks the next question at once", async () => {
      const client = new MockAncillaRpcClient();
      client.assistantReply = reading([]);
      const { controller, stop, shown, read } = await armed(client);
      await read();

      client.assistantReply = reading(waiting("site", "first"));
      await read();
      assert.strictEqual(shown.length, 1);

      // The person answered and the task asked the next question in the same breath: they are at the screen.
      client.assistantReply = reading(waiting("action", "second"));
      await read();
      assert.strictEqual(shown.length, 1, "within the repeat window a second question does not buzz");

      client.assistantReply = reading([]);
      await read();
      client.assistantReply = reading(waiting("action", "third"));
      await read();
      assert.deepStrictEqual(shown.map((note) => note.tag), ["task:t1", "task:t1"], "once it was dealt with, it may speak again");
      stop();
    });

    it("says nothing for a server that does not list them, and what began to wait while the stream was down is read when it comes back", async () => {
      const client = new MockAncillaRpcClient();
      client.assistantReply = reading(undefined);
      const { controller, stop, shown, read } = await armed(client);
      await read();
      assert.strictEqual(shown.length, 0);

      client.handler?.({ type: "connection", state: "lost" });
      client.assistantReply = reading(waiting("blocked", "A step may have changed something."));
      client.handler?.({ type: "hello", version: "x" });
      await settleController();
      assert.deepStrictEqual(shown.map((note) => [note.tag, note.body]), [["task:t1", '"Look at A" stopped and is waiting for you.']]);
      stop();
    });

    it("takes a press on the notice to the assistant's Tasks tab", async () => {
      const client = new MockAncillaRpcClient();
      client.assistantReply = reading([]);
      const { controller, stop, shown, read } = await armed(client);
      await read();
      client.assistantReply = reading(waiting("site", "ask"));
      await read();
      assert.strictEqual(typeof shown[0]?.onClick, "function");

      takeWantedTab();
      shown[0]?.onClick?.();
      assert.strictEqual(controller.store.get().route.kind, "assistant");
      assert.strictEqual(takeWantedTab(), "tasks", "the page opens on the tab with the question");
      stop();
    });
  });

  it("leaves the glance unknown when the server has no assistant, so nothing is shown for it", async () => {
    const client = new MockAncillaRpcClient();
    client.assistantReply = { error: "not found" };
    const { controller, stop: stopController } = await started(client);
    await settleController();
    assert.strictEqual(controller.store.get().assistantGlance, null);
    stopController();
  });

  it("gives its face something to react to: pleased at a note kept, waiting at a question or a note to approve, concerned at a refusal", async () => {
    const client = new MockAncillaRpcClient();
    client.assistantReply = status({});
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(controller.store.get().assistantReaction, null);
    client.handler?.({ type: "assistant", reason: "memory", epoch: 2, saved: [{ id: "m1", kind: "fact", text: "x is y", status: "active", replaced: 0 }] });
    assert.strictEqual(controller.store.get().assistantReaction?.mood, "delight");
    client.handler?.({ type: "assistant", reason: "memory", epoch: 3, saved: [{ id: "m2", kind: "fact", text: "from a web page", status: "pending", replaced: 0 }] });
    assert.strictEqual(controller.store.get().assistantReaction?.mood, "attention");
    client.handler?.({ type: "assistant", reason: "memory", epoch: 4, declined: [{ reason: "secret: password" }] });
    assert.strictEqual(controller.store.get().assistantReaction?.mood, "concern");
    client.handler?.({ type: "assistant", reason: "memory", epoch: 5, question: { about: "staging", options: [{ id: "a", text: "x" }, { id: "b", text: "y" }] } });
    assert.strictEqual(controller.store.get().assistantReaction?.mood, "attention");
    const last = controller.store.get().assistantReaction;
    client.handler?.({ type: "assistant", reason: "task", epoch: 6, taskId: "t1" });
    assert.deepStrictEqual(controller.store.get().assistantReaction, last, "a task changing is not an occasion for the face: its card shows the count");
    stopController();
  });

  it("keeps the new preferences, and refuses a value it does not know", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    assert.strictEqual(controller.store.get().prefs.assistantInvite, "pulse");
    assert.strictEqual(controller.store.get().prefs.assistantPresence, true);
    controller.setPrefs({ assistantInvite: "calm", assistantPresence: false });
    assert.strictEqual(controller.store.get().prefs.assistantInvite, "calm");
    assert.strictEqual(controller.store.get().prefs.assistantPresence, false);
    stopController();
  });

  it("makes an open page read again when the server says something changed, and says in words what was written", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    const before = controller.store.get().assistantRev;
    client.handler?.({ type: "assistant", reason: "memory", epoch: 4, saved: [{ id: "m1", kind: "constraint", text: "never use emojis in commit messages", status: "active", replaced: 0 }] });
    assert.strictEqual(controller.store.get().assistantRev, before + 1);
    assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Remembered");
    assert.strictEqual(controller.store.get().toasts.at(-1)?.detail, "never use emojis in commit messages");
    client.handler?.({ type: "assistant", reason: "memory", epoch: 5, saved: [{ id: "m2", kind: "fact", text: "the staging server is at app-2.example.com", status: "active", replaced: 1 }] });
    assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Remembered, replacing an earlier note");
    client.handler?.({ type: "assistant", reason: "memory", epoch: 6, forgotten: 1 });
    assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Forgotten");
    client.handler?.({ type: "assistant", reason: "memory", epoch: 7, declined: [{ reason: "secret: password" }] });
    assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Not saved");
    assert.match(controller.store.get().toasts.at(-1)?.detail ?? "", /credential/);
    client.handler?.({ type: "assistant", reason: "memory", epoch: 8, question: { about: "staging", options: [{ id: "a", text: "x" }, { id: "b", text: "y" }] } });
    assert.strictEqual(controller.store.get().toasts.at(-1)?.title, "Which one did you mean?");
    const toasts = controller.store.get().toasts.length;
    client.handler?.({ type: "assistant", reason: "task", epoch: 9, taskId: "t1" });
    assert.strictEqual(controller.store.get().toasts.length, toasts, "a task changing is for the page, not a toast");
    assert.strictEqual(controller.store.get().assistantRev, before + 6);
    stopController();
  });

  it("makes an open page read again after a change its own call made to the profile, without a word or a reaction of the face", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop: stopController } = await started(client);
    const before = controller.store.get();
    controller.assistantMoved();
    const after = controller.store.get();
    assert.strictEqual(after.assistantRev, before.assistantRev + 1);
    assert.strictEqual(after.toasts.length, before.toasts.length);
    assert.deepStrictEqual(after.assistantReaction, before.assistantReaction);
    stopController();
  });
});

describe("per-provider default chat models and scoped preferences", () => {
  it("isolates default models between Muse, CLI providers, and API profiles", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop } = await startedWith(client);

    // Set Muse default model
    controller.setDefaultModelForScope({ providerId: "muse" }, "muse-wonder-1.0");
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.deepStrictEqual(controller.store.get().prefs.providerDefaultModels, {});

    // Set Codex default model
    controller.setDefaultModelForScope({ providerId: "codex" }, "o3-mini");
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0", "Muse default model unchanged");
    assert.deepStrictEqual(controller.store.get().prefs.providerDefaultModels["codex"], {
      modelId: "o3-mini",
      tried: true, // not in empty accountModels without load
    });

    // Set API profile default model
    controller.setDefaultModelForScope({ providerId: "api", accountId: "openrouter" }, "deepseek-r1");
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0");
    assert.deepStrictEqual(controller.store.get().prefs.providerDefaultModels["api:openrouter"], {
      modelId: "deepseek-r1",
      tried: true,
    });

    // Clear Codex default model
    controller.setDefaultModelForScope({ providerId: "codex" }, null);
    assert.deepStrictEqual(controller.store.get().prefs.providerDefaultModels["codex"], {
      modelId: null,
      tried: false,
    });
    assert.strictEqual(controller.store.get().prefs.defaultModelId, "muse-wonder-1.0", "Muse default still intact");

    stop();
  });

  it("threads explicit force to listModelCatalog only when options.force is true", async () => {
    const client = new MockAncillaRpcClient();
    const { controller, stop } = await startedWith(client);

    // Initial refresh with watch: true
    await controller.refreshModels({ watch: true });
    assert.strictEqual(client.catalogCalls.at(-1)?.options, undefined, "watch does not send refresh: true");

    // Standard unforced refresh
    await controller.refreshModels({ sessionId: "s1" });
    assert.strictEqual(client.catalogCalls.at(-1)?.options, undefined, "unforced does not send refresh: true");

    // Explicit force refresh
    await controller.refreshModels({ force: true });
    assert.deepStrictEqual(client.catalogCalls.at(-1)?.options, { refresh: true }, "explicit force forwards refresh: true");

    stop();
  });
});