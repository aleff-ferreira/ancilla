/**
 * Frontend client interface and RPC transport contracts for Ancilla.
 * Defines communication protocols, error schemas, and response parser routines.
 */

import type {
  AccountLoginProgress, AccountLoginResult, AccountView, AccountsHealth,
  AncillaEvent, ApprovalMode, AttachmentView, DirectoryListing,
  EnvironmentStatus, FileContent, FileEntry, FileListing,
  GoalAction, IfBusy, LinuxSetupView, ModelCatalog,
  ModelOption, OutgoingAttachment, OutputRange, PlanUsageReport,
  ProjectView, ProviderAccountView, ProviderId, ProviderLoginResult,
  ProvidersCatalogView, ReasoningEffort, ResearchConfig, ResearchExport,
  ResearchExportFormat, ResearchRunView, ResearchSettings, SandboxSettings,
  SessionSummary, ShellRun, SkillCatalog, SubagentAction,
  TaskAction, TitleSettings, TranscriptLoad, UserInputAnswer,
  WorkflowAction, YoloSettings,
} from "./types.js";
import { parseEfforts } from "./model/models.js";
import { listedPrice } from "./model/pricing.js";

export class AncillaError extends Error {
  public readonly status: number;
  public readonly kind: string | null;

  constructor(msg: string, statusCode: number, errorCategory: string | null = null) {
    super(typeof msg === "string" ? msg : "");
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "AncillaError";
    this.status = statusCode;
    this.kind = errorCategory;
  }
}

export function errorKind(candidate: unknown): string | null {
  return candidate instanceof AncillaError ? candidate.kind : null;
}

export function noAnswer(candidate: unknown): boolean {
  return candidate instanceof AncillaError && candidate.status === 0;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === "string") {
    return err.message.length > 0 ? err.message : "Error";
  }
  return typeof err === "string" ? err : String(err);
}

export type EventHandler = (event: AncillaEvent) => void;

export interface TurnOptions {
  readonly ifBusy?: IfBusy;
  readonly reasoningEffort?: ReasoningEffort;
  readonly displayText?: string;
  readonly attachments?: OutgoingAttachment[];
}

export interface ApprovalDecisionInput {
  readonly sessionId: string;
  readonly approvalId: string;
  readonly requirementId: unknown;
  readonly choiceId: string;
  readonly feedback?: string | null;
}

export interface AncillaClient {
  probeEnvironment(shouldRefresh?: boolean): Promise<EnvironmentStatus>;
  linuxSetup?(targetAccountId?: string | null): Promise<LinuxSetupView>;
  installLinuxMuse?(): Promise<LinuxSetupView>;
  cancelLinuxMuseInstall?(activeAttemptId: string): Promise<LinuxSetupView>;
  repairLinuxStorage?(targetAccountId?: string | null): Promise<LinuxSetupView>;
  listProjects(): Promise<ProjectView[]>;
  addProject(directoryPath: string, opts?: { create?: boolean }): Promise<{ cwd: string; warning: string | null }>;
  cloneProject(repositoryUrl: string, destinationPath: string): Promise<{ cwd: string; warning: string | null }>;
  listDirectory(folderPath: string): Promise<DirectoryListing>;
  revealPath(targetLocation: string): Promise<void>;
  hideProject(projectCwd: string): Promise<void>;
  addProjectFolder(projectCwd: string, folderToAdd: string): Promise<{ project: ProjectView; warning: string | null }>;
  removeProjectFolder(projectCwd: string, folderToRemove: string): Promise<ProjectView>;
  setPinned(projectCwd: string, isPinned: boolean): Promise<void>;
  setProjectOrder(orderedCwds: string[]): Promise<void>;
  usage(historyDays?: number): Promise<import("./types.js").UsageReport>;
  listSessions(filterOpts?: { archived?: boolean }): Promise<SessionSummary[]>;
  discover(searchDirectory?: string): Promise<void>;
  startSession(
    initialCwd: string,
    sessionOpts?: { approvalMode?: ApprovalMode; modelId?: string; accountId?: string | null; providerId?: ProviderId },
  ): Promise<SessionSummary>;
  loadTranscript(targetSessionId: string, loadOpts?: { refresh?: boolean }): Promise<TranscriptLoad>;
  assetUrl(resourcePath: string): string;
  updateSession(targetSessionId: string, delta: { title?: string; archived?: boolean; settled?: boolean }): Promise<SessionSummary | null>;
  sendTurn(targetSessionId: string, promptText: string, turnOpts?: TurnOptions): Promise<{ turnId: string | null; disposition: string | null; attachments?: AttachmentView[] }>;
  interruptTurn(targetSessionId: string, turnIdToHalt?: string): Promise<void>;
  unqueueTurn(targetSessionId: string, queuedTurnId: string): Promise<void>;
  decideApproval(decisionPayload: ApprovalDecisionInput): Promise<void>;
  answerUserInput(targetSessionId: string, inputRequestId: string, submittedAnswers: UserInputAnswer[]): Promise<void>;
  cancelUserInput(targetSessionId: string, inputRequestId: string): Promise<void>;
  clarifyUserInput(targetSessionId: string, inputRequestId: string, clarificationNotes: string): Promise<void>;
  listModels(forSessionId?: string, forAccountId?: string | null, forProviderId?: ProviderId | null, fetchOpts?: { refresh?: boolean }): Promise<ModelOption[]>;
  listModelCatalog?(forSessionId?: string, forAccountId?: string | null, forProviderId?: ProviderId | null, fetchOpts?: { refresh?: boolean }): Promise<ModelCatalog>;
  restartHosts?(): Promise<void>;
  getTitleSettings(): Promise<TitleSettings>;
  setTitleSettings(deltaSettings: { enabled?: boolean; modelId?: string | null }): Promise<TitleSettings>;
  getSandboxSettings(): Promise<SandboxSettings>;
  setSandboxSettings(deltaSettings: { disabled?: boolean }): Promise<SandboxSettings>;
  listAccounts(): Promise<AccountView[]>;
  createAccount(newId: string, accountOpts?: { name?: string; seedFromDefault?: boolean }): Promise<{ id: string; name: string }>;
  renameAccount(existingId: string, updatedName: string): Promise<void>;
  removeAccount(targetId: string): Promise<void>;
  setProjectDefaultAccount(projectCwd: string, chosenAccountId: string | null, chosenProviderId?: ProviderId): Promise<void>;
  listProviders?(forceRefresh?: boolean): Promise<ProvidersCatalogView>;
  createProviderAccount?(rawPayload: Record<string, unknown>): Promise<ProviderAccountView>;
  updateProviderAccount?(targetId: string, deltaPayload: Record<string, unknown>): Promise<ProviderAccountView>;
  deleteProviderAccount?(targetId: string): Promise<void>;
  loginProvider?(targetProviderId: ProviderId, targetAccountId?: string | null): Promise<ProviderLoginResult>;
  providerLoginProgress?(targetProviderId: ProviderId, currentLoginId: string, targetAccountId?: string | null): Promise<AccountLoginProgress>;
  submitProviderLoginCode?(
    targetProviderId: ProviderId,
    currentLoginId: string,
    verificationCode: string,
    targetAccountId?: string | null,
  ): Promise<AccountLoginProgress>;
  cancelProviderLogin?(targetProviderId: ProviderId, currentLoginId: string, targetAccountId?: string | null): Promise<void>;
  accountsHealth(): Promise<AccountsHealth>;
  loginAccount(chosenId: string | null): Promise<AccountLoginResult>;
  accountLoginProgress?(chosenId: string | null, activeLoginId: string): Promise<AccountLoginProgress>;
  cancelAccountLogin?(chosenId: string | null, activeLoginId: string): Promise<void>;
  getYoloSettings(): Promise<YoloSettings>;
  setYoloSettings(deltaSettings: { enabled?: boolean }): Promise<YoloSettings>;
  setSessionModel(targetSessionId: string, chosenModelId: string): Promise<void>;
  setApprovalMode(targetSessionId: string, chosenMode: ApprovalMode): Promise<void>;
  compact(targetSessionId: string): Promise<{ noop: boolean; reason: string | null }>;
  runShell(targetSessionId: string, shellCmd: string): Promise<void>;
  startResearch(
    targetSessionId: string,
    researchPrompt: string,
    researchConfig: Partial<ResearchConfig> | null,
    generatedCommandId: string,
  ): Promise<ResearchRunView>;
  stopResearch(activeRunId: string, shouldExportReport: boolean): Promise<ResearchRunView>;
  listResearch(targetSessionId: string): Promise<ResearchRunView[]>;
  getResearch(activeRunId: string): Promise<ResearchRunView>;
  exportResearch(activeRunId: string, targetFormat: ResearchExportFormat): Promise<ResearchExport>;
  readResearchExport(activeRunId: string, targetFormat: ResearchExportFormat): Promise<Uint8Array>;
  getResearchSettings(): Promise<ResearchSettings>;
  setResearchSettings(deltaSettings: { enabled?: boolean; config?: Partial<ResearchConfig> }): Promise<ResearchSettings>;
  runShellProxy(targetSessionId: string, shellCmd: string): Promise<ShellRun>;
  forkSession(sourceSessionId: string): Promise<SessionSummary>;
  listSkills(workingDirectory: string, forSessionId?: string): Promise<SkillCatalog>;
  skillBody(workingDirectory: string, targetSkillId: string): Promise<string>;
  openFolder(workingDirectory: string, destination: "files" | "editor"): Promise<void>;
  openProjectFile(workingDirectory: string, relativePath: string): Promise<void>;
  setReasoningEffort(targetSessionId: string, selectedEffort: ReasoningEffort): Promise<void>;
  goal(targetSessionId: string, goalVerb: GoalAction, targetObjective?: string): Promise<{ turnId: string | null }>;
  subagent(targetSessionId: string, subagentVerb: SubagentAction, subagentId: string, controlOpts?: { reason?: string; body?: string }): Promise<void>;
  task(targetSessionId: string, taskVerb: TaskAction, specificTaskId?: string): Promise<void>;
  workflow(targetSessionId: string, workflowVerb: WorkflowAction, activeWorkflowId: string, childSpec?: { childId: string; attempt: number }): Promise<void>;
  readOutput(targetSessionId: string, parentItemId: string, outputHandle: string, byteOffset?: number): Promise<OutputRange>;
  planUsage(): Promise<PlanUsageReport>;
  listFiles(workingDirectory: string, subPath: string): Promise<FileListing>;
  readFile(workingDirectory: string, subPath: string): Promise<FileContent>;
  writeFile(workingDirectory: string, subPath: string, payloadContent: string, previousMtime: number | null): Promise<{ path: string; size: number; mtimeMs: number }>;
  searchFiles(workingDirectory: string, searchQuery: string): Promise<FileEntry[]>;
  openFileExternally(workingDirectory: string, targetFilePath: string): Promise<void>;
  fileUrl(workingDirectory: string, targetFilePath: string): string;
  assistant<T>(httpVerb: "GET" | "POST" | "PATCH" | "DELETE", apiRoute: string, requestPayload?: unknown): Promise<T>;
  voice?<T>(httpVerb: "GET" | "POST" | "PATCH" | "DELETE", apiRoute: string, requestPayload?: unknown): Promise<T>;
  browser?<T>(httpVerb: "GET" | "POST" | "PATCH" | "DELETE", apiRoute: string, requestPayload?: unknown): Promise<T>;
  voiceSocketUrl?(): string | null;
  browserSocketUrl?(): string | null;
  prepareBrowserSocket?(): Promise<void> | void;
  subscribe(callback: EventHandler): () => void;
}

export function parseTitleSettings(rawPayload: unknown): TitleSettings {
  const dictionary = typeof rawPayload === "object" && rawPayload !== null
    ? (rawPayload as Record<string, unknown>)
    : {};
  const activeFlag = dictionary.enabled !== false;
  const assignedModel = typeof dictionary.modelId === "string" && dictionary.modelId.trim().length > 0
    ? dictionary.modelId.trim()
    : null;
  return { enabled: activeFlag, modelId: assignedModel };
}

export function parseSandboxSettings(rawPayload: unknown): SandboxSettings {
  const dictionary = typeof rawPayload === "object" && rawPayload !== null
    ? (rawPayload as Record<string, unknown>)
    : {};
  return { disabled: dictionary.disabled === true };
}

export function parseAccounts(rawPayload: unknown): AccountView[] {
  if (!rawPayload || typeof rawPayload !== "object") {
    return [];
  }
  const accountEntries = (rawPayload as { accounts?: unknown }).accounts;
  if (!Array.isArray(accountEntries)) {
    return [];
  }

  const outputList: AccountView[] = [];
  for (const element of accountEntries) {
    if (element && typeof element === "object") {
      const rec = element as Record<string, unknown>;
      if (typeof rec.id === "string" && rec.id.length > 0) {
        outputList.push({
          id: rec.id,
          name: typeof rec.name === "string" && rec.name.length > 0 ? rec.name : rec.id,
          hasLogin: rec.hasLogin === true,
          email: typeof rec.email === "string" ? rec.email : null,
          lastUsedAt: typeof rec.lastUsedAt === "string" ? rec.lastUsedAt : null,
        });
      }
    }
  }
  return outputList;
}

export function parseYoloSettings(rawPayload: unknown): YoloSettings {
  const dictionary = typeof rawPayload === "object" && rawPayload !== null
    ? (rawPayload as Record<string, unknown>)
    : {};
  return { enabled: dictionary.enabled === true };
}

const parsePricingMetadata = (source: unknown): ModelOption["cost"] => {
  if (!source || typeof source !== "object") {
    return null;
  }
  const payload = source as Record<string, unknown>;
  const toValidRate = (val: unknown): number | null => {
    const numeric = typeof val === "number" ? val : typeof val === "string" && val.trim() ? Number(val) : NaN;
    return Number.isFinite(numeric) ? numeric : null;
  };

  const inPrice = toValidRate(payload.input);
  const outPrice = toValidRate(payload.output);
  if (inPrice === null || outPrice === null) {
    return null;
  }

  const cachedPrice = toValidRate(payload.cached) ?? inPrice;
  const currencyTag = typeof payload.currency === "string" ? payload.currency : null;
  return { input: inPrice, output: outPrice, cached: cachedPrice, currency: currencyTag };
};

export function parseModelList(rawPayload: unknown): ModelOption[] {
  const root = typeof rawPayload === "object" && rawPayload !== null
    ? (rawPayload as Record<string, unknown>)
    : {};
  const entries = Array.isArray(root.models)
    ? root.models
    : Array.isArray(rawPayload)
      ? rawPayload
      : [];

  const catalogOptions: ModelOption[] = [];
  for (const element of entries) {
    if (!element || typeof element !== "object") {
      continue;
    }
    const r = element as Record<string, unknown>;
    const id = typeof r.modelId === "string" && r.modelId.length > 0 ? r.modelId : null;
    if (!id) {
      continue;
    }

    const label = typeof r.displayLabel === "string" && r.displayLabel.length > 0 ? r.displayLabel : id;
    const desc = typeof r.description === "string" ? r.description : null;
    const ctxLimit = typeof r.contextLimit === "number" ? r.contextLimit : null;
    const outLimit = typeof r.outputLimit === "number" ? r.outputLimit : null;
    const pricing = parsePricingMetadata(r.cost) ?? listedPrice(id);
    const isContributor = /contributor/i.test(id) || /product improvement/i.test(desc ?? "");
    const supportedReasoning = parseEfforts(r.variants, r.reasoningEffortVariants, r.supportedReasoningEfforts);

    catalogOptions.push({
      modelId: id,
      displayLabel: label,
      description: desc,
      isDefault: r.isDefault === true,
      isActive: r.isActive === true,
      contextLimit: ctxLimit,
      outputLimit: outLimit,
      cost: pricing,
      contributor: isContributor,
      efforts: supportedReasoning,
    });
  }
  return catalogOptions;
}

export function parseModelCatalog(rawPayload: unknown): ModelCatalog {
  const responseData = typeof rawPayload === "object" && rawPayload !== null
    ? (rawPayload as Record<string, unknown>)
    : {};
  const innerResult = typeof responseData["models"] === "object" && responseData["models"] !== null
    ? (responseData["models"] as Record<string, unknown>)
    : {};

  const cleanString = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v : null);

  return {
    models: parseModelList(responseData["models"]),
    source: cleanString(innerResult["source"]),
    providerId: cleanString(innerResult["providerId"]),
    profileId: cleanString(innerResult["profileId"]),
    hostVersion: cleanString(responseData["hostVersion"]),
  };
}
