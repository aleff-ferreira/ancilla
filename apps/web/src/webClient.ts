import {
  AncillaError,
  parseAccounts,
  parseModelCatalog,
  parseSandboxSettings,
  parseTitleSettings,
  parseYoloSettings,
} from "@ancilla/ui";
import type {
  AccountLoginProgress,
  AccountLoginResult,
  AccountsHealth,
  AccountView,
  AncillaClient,
  AncillaEvent,
  ApprovalDecisionInput,
  ApprovalMode,
  AttachmentView,
  DirectoryListing,
  EnvironmentStatus,
  EventHandler,
  FileContent,
  FileEntry,
  FileListing,
  GoalAction,
  LinuxSetupView,
  ModelCatalog,
  ModelOption,
  OutputRange,
  PlanUsageReport,
  ProjectView,
  ProviderAccountView,
  ProviderId,
  ProviderLoginResult,
  ProvidersCatalogView,
  ReasoningEffort,
  ResearchConfig,
  ResearchExport,
  ResearchExportFormat,
  ResearchRunView,
  ResearchSettings,
  SandboxSettings,
  SessionSummary,
  ShellRun,
  SkillCatalog,
  SubagentAction,
  TaskAction,
  TitleSettings,
  TranscriptLoad,
  TurnOptions,
  UsageReport,
  UserInputAnswer,
  WorkflowAction,
  YoloSettings,
} from "@ancilla/ui";

/** Daemon target endpoint and authentication configuration. */
export interface Daemon {
  base: string;
  token: string | null;
}

const STORAGE_DAEMON_KEY = "ancilla:daemon";

/** Reads the active daemon endpoint specification from local storage. */
function readPersistedDaemon(): Daemon | null {
  try {
    const rawRecord = window.localStorage.getItem(STORAGE_DAEMON_KEY);
    if (!rawRecord) return null;
    const parsedObj = JSON.parse(rawRecord) as Partial<Daemon>;
    if (parsedObj && typeof parsedObj === "object") {
      const endpointBase = typeof parsedObj.base === "string" ? parsedObj.base : "";
      const secretToken = typeof parsedObj.token === "string" ? parsedObj.token : null;
      return { base: endpointBase, token: secretToken };
    }
    return null;
  } catch {
    return null;
  }
}

/** Saves the active daemon endpoint specification to local storage. */
function writePersistedDaemon(settings: Daemon): void {
  try {
    window.localStorage.setItem(STORAGE_DAEMON_KEY, JSON.stringify(settings));
  } catch {
    // Proceed in-memory if local storage is disabled or quota is exceeded
  }
}

/** Resolves initial daemon settings from query token or persisted storage. */
function resolveInitialDaemon(): Daemon {
  const query = new URLSearchParams(window.location.search);
  const tokenFromUrl = query.get("token");
  if (tokenFromUrl) {
    const freshSettings: Daemon = { base: "", token: tokenFromUrl };
    writePersistedDaemon(freshSettings);
    query.delete("token");
    const serializedQuery = query.toString();
    const sanitizedUrl = `${window.location.pathname}${serializedQuery ? `?${serializedQuery}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", sanitizedUrl);
    return freshSettings;
  }
  return readPersistedDaemon() ?? { base: "", token: null };
}

let activeDaemon: Daemon = resolveInitialDaemon();

/** Retrieves the current daemon connection parameters. */
export function currentDaemon(): Daemon {
  return activeDaemon;
}

/** Updates the active daemon address and auth token. */
export function setDaemon(nextTarget: Daemon): void {
  const trimmedBase = nextTarget.base.replace(/\/+$/, "");
  activeDaemon = { base: trimmedBase, token: nextTarget.token };
  writePersistedDaemon(activeDaemon);
}

/** Generates a full URL for an API route using the active daemon base. */
function resolveTargetUrl(routePath: string): string {
  return activeDaemon.base ? `${activeDaemon.base}${routePath}` : routePath;
}

const REQUEST_TIMEOUT_MS = 60_000;
const SHELL_PROXY_TIMEOUT_MS = 150_000;
const SSE_WATCHDOG_IDLE_MS = 70_000;

/** Dispatches an HTTP request with JSON payload handling and error normalization. */
async function callDaemon<T>(
  httpVerb: string,
  apiPath: string,
  bodyData?: unknown,
  timeoutLimitMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutLimitMs);

  const headersMap: Record<string, string> = {};
  if (bodyData !== undefined) {
    headersMap["content-type"] = "application/json";
  }
  if (activeDaemon.token) {
    headersMap["authorization"] = `Bearer ${activeDaemon.token}`;
  }

  try {
    const httpRes = await fetch(resolveTargetUrl(apiPath), {
      method: httpVerb,
      headers: headersMap,
      body: bodyData !== undefined ? JSON.stringify(bodyData) : undefined,
      credentials: activeDaemon.base ? "include" : "same-origin",
      signal: abortController.signal,
    });

    const responseBody = await httpRes.text();
    let parsedData: unknown = null;
    try {
      parsedData = responseBody ? (JSON.parse(responseBody) as unknown) : null;
    } catch {
      parsedData = null;
    }

    if (!httpRes.ok) {
      const errInfo = (parsedData && typeof parsedData === "object") ? (parsedData as Record<string, unknown>) : {};
      const msg = typeof errInfo.error === "string"
        ? errInfo.error
        : `${httpVerb} ${apiPath} failed with ${httpRes.status}.`;
      const kindStr = typeof errInfo.kind === "string" ? errInfo.kind : null;
      throw new AncillaError(msg, httpRes.status, kindStr);
    }

    return parsedData as T;
  } catch (caughtErr) {
    if (caughtErr instanceof AncillaError) {
      throw caughtErr;
    }
    const description = abortController.signal.aborted
      ? "The local Ancilla server took too long to answer."
      : "The local Ancilla server is not reachable. Is it still running?";
    throw new AncillaError(description, 0);
  } finally {
    clearTimeout(timer);
  }
}

const uriEncode = encodeURIComponent;

/** Resolves client timezone query parameter string. */
function timezoneQueryParam(): string {
  try {
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tzName ? `tz=${uriEncode(tzName)}` : "";
  } catch {
    return "";
  }
}

/** Client managing REST communication and event subscription with Ancilla daemon. */
export class WebAncillaClient implements AncillaClient {
  private readonly subscribers = new Set<EventHandler>();
  private activeStream: EventSource | null = null;
  private watchdogHandle: ReturnType<typeof setTimeout> | null = null;
  private isConnecting = false;
  private pendingAuth: Promise<void> | null = null;
  private hasReportedLost = false;

  public probeEnvironment(shouldRefresh = false): Promise<EnvironmentStatus> {
    const query = shouldRefresh ? "?refresh=1" : "";
    return callDaemon<EnvironmentStatus>("GET", `/api/env${query}`);
  }

  public linuxSetup(accountIdParam: string | null = null): Promise<LinuxSetupView> {
    const query = accountIdParam ? `?accountId=${uriEncode(accountIdParam)}` : "";
    return callDaemon<LinuxSetupView>("GET", `/api/setup/linux${query}`);
  }

  public installLinuxMuse(): Promise<LinuxSetupView> {
    return callDaemon<LinuxSetupView>("POST", "/api/setup/linux/install", {});
  }

  public cancelLinuxMuseInstall(targetAttemptId: string): Promise<LinuxSetupView> {
    return callDaemon<LinuxSetupView>("DELETE", `/api/setup/linux/install?attemptId=${uriEncode(targetAttemptId)}`);
  }

  public repairLinuxStorage(accountIdParam: string | null = null): Promise<LinuxSetupView> {
    return callDaemon<LinuxSetupView>("POST", "/api/setup/linux/repair", { accountId: accountIdParam });
  }

  public async listProjects(): Promise<ProjectView[]> {
    const data = await callDaemon<{ projects: ProjectView[] }>("GET", "/api/projects");
    return data.projects;
  }

  public async addProject(folderPath: string, opts?: { create?: boolean }): Promise<{ cwd: string; warning: string | null }> {
    const payload = { cwd: folderPath, create: Boolean(opts?.create) };
    const outcome = await callDaemon<{ project: { cwd: string }; warning: string | null }>("POST", "/api/projects", payload);
    return { cwd: outcome.project.cwd, warning: outcome.warning };
  }

  public async cloneProject(repoUrl: string, destPath: string): Promise<{ cwd: string; warning: string | null }> {
    const outcome = await callDaemon<{ project: { cwd: string }; warning: string | null }>("POST", "/api/projects/clone", {
      url: repoUrl,
      path: destPath,
    });
    return { cwd: outcome.project.cwd, warning: outcome.warning };
  }

  public listDirectory(targetDir: string): Promise<DirectoryListing> {
    return callDaemon<DirectoryListing>("GET", `/api/fs/list?path=${uriEncode(targetDir)}`);
  }

  public async revealPath(destinationPath: string): Promise<void> {
    await callDaemon("POST", "/api/fs/reveal", { path: destinationPath });
  }

  public async hideProject(projectDir: string): Promise<void> {
    await callDaemon("DELETE", `/api/projects?cwd=${uriEncode(projectDir)}`);
  }

  public async addProjectFolder(projectDir: string, subfolderPath: string): Promise<{ project: ProjectView; warning: string | null }> {
    const added = await callDaemon<{ project: ProjectView; warning?: string | null }>("POST", "/api/projects/folders", {
      cwd: projectDir,
      path: subfolderPath,
    });
    return { project: added.project, warning: added.warning ?? null };
  }

  public async removeProjectFolder(projectDir: string, subfolderPath: string): Promise<ProjectView> {
    const res = await callDaemon<{ project: ProjectView }>(
      "DELETE",
      `/api/projects/folders?cwd=${uriEncode(projectDir)}&path=${uriEncode(subfolderPath)}`,
    );
    return res.project;
  }

  public async setPinned(projectDir: string, isPinned: boolean): Promise<void> {
    await callDaemon("PATCH", "/api/projects/pin", { cwd: projectDir, pinned: isPinned });
  }

  public async setProjectOrder(orderedDirs: string[]): Promise<void> {
    await callDaemon("PATCH", "/api/projects/order", { cwds: orderedDirs });
  }

  public usage(historyDays?: number): Promise<UsageReport> {
    const queryParts = [historyDays ? `days=${historyDays}` : "", timezoneQueryParam()].filter(Boolean).join("&");
    return callDaemon<UsageReport>("GET", `/api/usage${queryParts ? `?${queryParts}` : ""}`);
  }

  public async startResearch(
    sessionKey: string,
    promptQuestion: string,
    customConfig: Partial<ResearchConfig> | null,
    cmdIdentifier: string,
  ): Promise<ResearchRunView> {
    const resp = await callDaemon<{ run: ResearchRunView }>("POST", "/api/research", {
      commandId: cmdIdentifier,
      sessionId: sessionKey,
      question: promptQuestion,
      config: customConfig ?? undefined,
    });
    return resp.run;
  }

  public async stopResearch(researchRunId: string, shouldPersistReport: boolean): Promise<ResearchRunView> {
    const resp = await callDaemon<{ run: ResearchRunView }>("POST", `/api/research/${uriEncode(researchRunId)}/stop`, {
      writeReport: shouldPersistReport,
    });
    return resp.run;
  }

  public async listResearch(sessionKey: string): Promise<ResearchRunView[]> {
    const resp = await callDaemon<{ runs: ResearchRunView[] }>("GET", `/api/research?sessionId=${uriEncode(sessionKey)}`);
    return resp.runs;
  }

  public async getResearch(researchRunId: string): Promise<ResearchRunView> {
    const resp = await callDaemon<{ run: ResearchRunView }>("GET", `/api/research/${uriEncode(researchRunId)}`);
    return resp.run;
  }

  public async exportResearch(researchRunId: string, outFormat: ResearchExportFormat): Promise<ResearchExport> {
    return callDaemon<ResearchExport>("POST", `/api/research/${uriEncode(researchRunId)}/export`, { format: outFormat });
  }

  public async readResearchExport(researchRunId: string, outFormat: ResearchExportFormat): Promise<Uint8Array> {
    const downloadUri = `/api/research/${uriEncode(researchRunId)}/export/report.${outFormat}`;
    const abortCtrl = new AbortController();
    const timerHandle = setTimeout(() => abortCtrl.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(resolveTargetUrl(downloadUri), {
        headers: activeDaemon.token ? { authorization: `Bearer ${activeDaemon.token}` } : {},
        credentials: activeDaemon.base ? "include" : "same-origin",
        signal: abortCtrl.signal,
      });

      if (!response.ok) {
        const errorRecord = (await response.json().catch(() => null)) as { error?: unknown } | null;
        const msg = typeof errorRecord?.error === "string" ? errorRecord.error : `Could not download the report (${response.status}).`;
        throw new AncillaError(msg, response.status);
      }

      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (err) {
      if (err instanceof AncillaError) throw err;
      const failureReason = abortCtrl.signal.aborted
        ? "The report download took too long."
        : "The report could not be downloaded. Check the Ancilla server connection.";
      throw new AncillaError(failureReason, 0);
    } finally {
      clearTimeout(timerHandle);
    }
  }

  public async getResearchSettings(): Promise<ResearchSettings> {
    return callDaemon<ResearchSettings>("GET", "/api/research-settings");
  }

  public async setResearchSettings(settingsPatch: { enabled?: boolean; config?: Partial<ResearchConfig> }): Promise<ResearchSettings> {
    return callDaemon<ResearchSettings>("PATCH", "/api/research-settings", settingsPatch);
  }

  public async assistant<T>(verb: "GET" | "POST" | "PATCH" | "DELETE", subRoute: string, requestPayload?: unknown): Promise<T> {
    return callDaemon<T>(verb, `/api/assistant${subRoute}`, requestPayload);
  }

  public async voice<T>(verb: "GET" | "POST" | "PATCH" | "DELETE", subRoute: string, requestPayload?: unknown): Promise<T> {
    return callDaemon<T>(verb, `/api/voice${subRoute}`, requestPayload);
  }

  public async browser<T>(verb: "GET" | "POST" | "PATCH" | "DELETE", subRoute: string, requestPayload?: unknown): Promise<T> {
    return callDaemon<T>(verb, `/api/browser${subRoute}`, requestPayload);
  }

  public browserSocketUrl(): string | null {
    try {
      const wsUrl = new URL(resolveTargetUrl("/api/browser/ws"), window.location.href);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      return wsUrl.toString();
    } catch {
      return null;
    }
  }

  public prepareBrowserSocket(): Promise<void> | void {
    return this.ensureCookieHandshake();
  }

  public voiceSocketUrl(): string | null {
    try {
      const wsUrl = new URL(resolveTargetUrl("/api/voice/ws"), window.location.href);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      return wsUrl.toString();
    } catch {
      return null;
    }
  }

  public async runShellProxy(sessionKey: string, shellCommand: string): Promise<ShellRun> {
    const outcome = await callDaemon<{ run: ShellRun }>(
      "POST",
      `/api/sessions/${uriEncode(sessionKey)}/shell-proxy`,
      { command: shellCommand },
      SHELL_PROXY_TIMEOUT_MS,
    );
    return outcome.run;
  }

  public async listSessions(filterOpts?: { archived?: boolean }): Promise<SessionSummary[]> {
    const query = filterOpts?.archived ? "?archived=1" : "";
    const outcome = await callDaemon<{ sessions: SessionSummary[] }>("GET", `/api/sessions${query}`);
    return outcome.sessions;
  }

  public async discover(workingDirectory?: string): Promise<void> {
    const payload = workingDirectory ? { cwd: workingDirectory } : {};
    await callDaemon("POST", "/api/discover", payload);
  }

  public async startSession(
    workingDirectory: string,
    opts?: { approvalMode?: ApprovalMode; modelId?: string; accountId?: string | null; providerId?: ProviderId },
  ): Promise<SessionSummary> {
    const bodyObj = {
      cwd: workingDirectory,
      approvalMode: opts?.approvalMode,
      modelId: opts?.modelId,
      accountId: opts?.accountId ?? undefined,
      providerId: opts?.providerId ?? undefined,
    };
    const outcome = await callDaemon<{ session: SessionSummary }>("POST", "/api/sessions", bodyObj);
    return outcome.session;
  }

  public loadTranscript(sessionKey: string, loadOpts?: { refresh?: boolean }): Promise<TranscriptLoad> {
    return callDaemon<TranscriptLoad>("POST", `/api/sessions/${uriEncode(sessionKey)}/resume`, loadOpts ?? {});
  }

  public async updateSession(sessionKey: string, updatePatch: { title?: string; archived?: boolean }): Promise<SessionSummary | null> {
    const outcome = await callDaemon<{ session: SessionSummary | null }>("PATCH", `/api/sessions/${uriEncode(sessionKey)}`, updatePatch);
    return outcome.session;
  }

  public async sendTurn(
    sessionKey: string,
    promptBody: string,
    turnParams?: TurnOptions,
  ): Promise<{ turnId: string | null; disposition: string | null; attachments?: AttachmentView[] }> {
    const turnPayload = {
      sessionId: sessionKey,
      text: promptBody,
      ifBusy: turnParams?.ifBusy,
      reasoningEffort: turnParams?.reasoningEffort,
      displayText: turnParams?.displayText,
      attachments: turnParams?.attachments,
    };
    const outcome = await callDaemon<{ turnId: string | null; disposition: unknown; attachments?: AttachmentView[] }>(
      "POST",
      "/api/turns",
      turnPayload,
    );
    return {
      turnId: outcome.turnId !== undefined && outcome.turnId !== null ? outcome.turnId : null,
      disposition: typeof outcome.disposition === "string" ? outcome.disposition : null,
      ...(outcome.attachments && Array.isArray(outcome.attachments) ? { attachments: outcome.attachments } : {}),
    };
  }

  public async interruptTurn(sessionKey: string, turnIdentifier?: string): Promise<void> {
    await callDaemon("POST", "/api/turns/interrupt", { sessionId: sessionKey, turnId: turnIdentifier });
  }

  public async unqueueTurn(sessionKey: string, queuedId: string): Promise<void> {
    await callDaemon("POST", "/api/turns/unqueue", { sessionId: sessionKey, turnId: queuedId });
  }

  public async decideApproval(approvalData: ApprovalDecisionInput): Promise<void> {
    await callDaemon("POST", "/api/approvals/decide", approvalData);
  }

  public async answerUserInput(sessionKey: string, requestId: string, responseAnswers: UserInputAnswer[]): Promise<void> {
    await callDaemon("POST", "/api/user-input/answer", { sessionId: sessionKey, userInputId: requestId, answers: responseAnswers });
  }

  public async cancelUserInput(sessionKey: string, requestId: string): Promise<void> {
    await callDaemon("POST", "/api/user-input/cancel", { sessionId: sessionKey, userInputId: requestId });
  }

  public async clarifyUserInput(sessionKey: string, requestId: string, details: string): Promise<void> {
    await callDaemon("POST", "/api/user-input/clarify", { sessionId: sessionKey, userInputId: requestId, content: details });
  }

  public async listModels(
    sessionKey?: string,
    accountIdVal?: string | null,
    providerIdVal?: ProviderId | null,
    queryOpts?: { refresh?: boolean },
  ): Promise<ModelOption[]> {
    const catalog = await this.listModelCatalog(sessionKey, accountIdVal, providerIdVal, queryOpts);
    return catalog.models;
  }

  public async listModelCatalog(
    sessionKey?: string,
    accountIdVal?: string | null,
    providerIdVal?: ProviderId | null,
    queryOpts?: { refresh?: boolean },
  ): Promise<ModelCatalog> {
    const queryList = [
      sessionKey ? `sessionId=${uriEncode(sessionKey)}` : "",
      accountIdVal ? `accountId=${uriEncode(accountIdVal)}` : "",
      providerIdVal ? `providerId=${uriEncode(providerIdVal)}` : "",
      queryOpts?.refresh ? "refresh=1" : "",
    ].filter(Boolean).join("&");
    const catalogJson = await callDaemon<unknown>("GET", `/api/models${queryList ? `?${queryList}` : ""}`);
    return parseModelCatalog(catalogJson);
  }

  public async restartHosts(): Promise<void> {
    await callDaemon("POST", "/api/hosts/restart", {});
  }

  public async getTitleSettings(): Promise<TitleSettings> {
    const raw = await callDaemon<unknown>("GET", "/api/title-settings");
    return parseTitleSettings(raw);
  }

  public async setTitleSettings(patchObj: { enabled?: boolean; modelId?: string | null }): Promise<TitleSettings> {
    const raw = await callDaemon<unknown>("PATCH", "/api/title-settings", patchObj);
    return parseTitleSettings(raw);
  }

  public async getSandboxSettings(): Promise<SandboxSettings> {
    const raw = await callDaemon<unknown>("GET", "/api/sandbox-settings");
    return parseSandboxSettings(raw);
  }

  public async setSandboxSettings(patchObj: { disabled?: boolean }): Promise<SandboxSettings> {
    const raw = await callDaemon<unknown>("PATCH", "/api/sandbox-settings", patchObj);
    return parseSandboxSettings(raw);
  }

  public async listAccounts(): Promise<AccountView[]> {
    const raw = await callDaemon<unknown>("GET", "/api/accounts");
    return parseAccounts(raw);
  }

  public async createAccount(accountId: string, config?: { name?: string; seedFromDefault?: boolean }): Promise<{ id: string; name: string }> {
    const result = await callDaemon<{ account: { id: string; name: string } }>("POST", "/api/accounts", {
      id: accountId,
      name: config?.name,
      seedFromDefault: Boolean(config?.seedFromDefault),
    });
    return result.account;
  }

  public async renameAccount(accountId: string, updatedTitle: string): Promise<void> {
    await callDaemon("PATCH", `/api/accounts/${uriEncode(accountId)}`, { name: updatedTitle });
  }

  public async removeAccount(accountId: string): Promise<void> {
    await callDaemon("DELETE", `/api/accounts/${uriEncode(accountId)}`);
  }

  public async setProjectDefaultAccount(projectDir: string, assignedAccount: string | null, assignedProvider?: ProviderId): Promise<void> {
    await callDaemon("PATCH", "/api/projects/default-account", {
      cwd: projectDir,
      accountId: assignedAccount,
      ...(assignedProvider !== undefined ? { providerId: assignedProvider } : {}),
    });
  }

  public async listProviders(forceUpdate = false): Promise<ProvidersCatalogView> {
    return callDaemon<ProvidersCatalogView>("GET", `/api/providers${forceUpdate ? "?refresh=1" : ""}`);
  }

  public async createProviderAccount(paramsMap: Record<string, unknown>): Promise<ProviderAccountView> {
    const res = await callDaemon<{ account: ProviderAccountView }>("POST", "/api/providers/accounts", paramsMap);
    return res.account;
  }

  public async updateProviderAccount(targetId: string, changes: Record<string, unknown>): Promise<ProviderAccountView> {
    const res = await callDaemon<{ account: ProviderAccountView }>("PATCH", `/api/providers/accounts/${uriEncode(targetId)}`, changes);
    return res.account;
  }

  public async deleteProviderAccount(targetId: string): Promise<void> {
    await callDaemon("DELETE", `/api/providers/accounts/${uriEncode(targetId)}`);
  }

  public async loginProvider(targetProvider: ProviderId, targetAccount: string | null = null): Promise<ProviderLoginResult> {
    return callDaemon<ProviderLoginResult>("POST", `/api/providers/${uriEncode(targetProvider)}/login`, {
      ...(targetAccount ? { accountId: targetAccount } : {}),
    });
  }

  public async providerLoginProgress(targetProvider: ProviderId, loginSessionId: string, targetAccount: string | null = null): Promise<AccountLoginProgress> {
    const q = [`loginId=${uriEncode(loginSessionId)}`, targetAccount ? `accountId=${uriEncode(targetAccount)}` : ""].filter(Boolean).join("&");
    return callDaemon<AccountLoginProgress>("GET", `/api/providers/${uriEncode(targetProvider)}/login?${q}`);
  }

  public async submitProviderLoginCode(
    targetProvider: ProviderId,
    loginSessionId: string,
    secretCode: string,
    targetAccount: string | null = null,
  ): Promise<AccountLoginProgress> {
    return callDaemon<AccountLoginProgress>("POST", `/api/providers/${uriEncode(targetProvider)}/login/code`, {
      loginId: loginSessionId,
      code: secretCode,
      ...(targetAccount ? { accountId: targetAccount } : {}),
    });
  }

  public async cancelProviderLogin(targetProvider: ProviderId, loginSessionId: string, targetAccount: string | null = null): Promise<void> {
    const q = [`loginId=${uriEncode(loginSessionId)}`, targetAccount ? `accountId=${uriEncode(targetAccount)}` : ""].filter(Boolean).join("&");
    await callDaemon("DELETE", `/api/providers/${uriEncode(targetProvider)}/login?${q}`);
  }

  public async accountsHealth(): Promise<AccountsHealth> {
    return callDaemon<AccountsHealth>("GET", "/api/accounts/health");
  }

  public async loginAccount(accountIdVal: string | null): Promise<AccountLoginResult> {
    const endpoint = accountIdVal === null ? "/api/login" : `/api/accounts/${uriEncode(accountIdVal)}/login`;
    return callDaemon<AccountLoginResult>("POST", endpoint);
  }

  public async accountLoginProgress(accountIdVal: string | null, loginSessionId: string): Promise<AccountLoginProgress> {
    const endpoint = accountIdVal === null ? "/api/login" : `/api/accounts/${uriEncode(accountIdVal)}/login`;
    return callDaemon<AccountLoginProgress>("GET", `${endpoint}?loginId=${uriEncode(loginSessionId)}`);
  }

  public async cancelAccountLogin(accountIdVal: string | null, loginSessionId: string): Promise<void> {
    const endpoint = accountIdVal === null ? "/api/login" : `/api/accounts/${uriEncode(accountIdVal)}/login`;
    await callDaemon("DELETE", `${endpoint}?loginId=${uriEncode(loginSessionId)}`);
  }

  public async getYoloSettings(): Promise<YoloSettings> {
    const raw = await callDaemon<unknown>("GET", "/api/yolo-settings");
    return parseYoloSettings(raw);
  }

  public async setYoloSettings(patchObj: { enabled?: boolean }): Promise<YoloSettings> {
    const raw = await callDaemon<unknown>("PATCH", "/api/yolo-settings", patchObj);
    return parseYoloSettings(raw);
  }

  public async setSessionModel(sessionKey: string, chosenModelId: string): Promise<void> {
    await callDaemon("POST", `/api/sessions/${uriEncode(sessionKey)}/model`, { model: { modelId: chosenModelId } });
  }

  public async setApprovalMode(sessionKey: string, chosenMode: ApprovalMode): Promise<void> {
    await callDaemon("POST", `/api/sessions/${uriEncode(sessionKey)}/approval-mode`, { mode: chosenMode });
  }

  public async compact(sessionKey: string): Promise<{ noop: boolean; reason: string | null }> {
    const res = await callDaemon<{ result: { status?: unknown; reason?: unknown } | null }>(
      "POST",
      `/api/sessions/${uriEncode(sessionKey)}/compact`,
      {},
    );
    const noopVal = res.result?.status === "noop";
    const reasonVal = typeof res.result?.reason === "string" ? res.result.reason : null;
    return { noop: noopVal, reason: reasonVal };
  }

  public async runShell(sessionKey: string, commandString: string): Promise<void> {
    await callDaemon("POST", `/api/sessions/${uriEncode(sessionKey)}/shell`, { command: commandString });
  }

  public async forkSession(sessionKey: string): Promise<SessionSummary> {
    const res = await callDaemon<{ session: SessionSummary }>("POST", `/api/sessions/${uriEncode(sessionKey)}/fork`, {});
    return res.session;
  }

  public listSkills(workingDirectory: string, sessionKey?: string): Promise<SkillCatalog> {
    const sessionArg = sessionKey ? `&sessionId=${uriEncode(sessionKey)}` : "";
    return callDaemon<SkillCatalog>("GET", `/api/slash?cwd=${uriEncode(workingDirectory)}${sessionArg}`);
  }

  public async skillBody(workingDirectory: string, skillIdentifier: string): Promise<string> {
    const res = await callDaemon<{ body: string }>(
      "GET",
      `/api/slash/skill?cwd=${uriEncode(workingDirectory)}&id=${uriEncode(skillIdentifier)}`,
    );
    return res.body;
  }

  public async openFolder(workingDirectory: string, appTarget: "files" | "editor"): Promise<void> {
    await callDaemon("POST", "/api/open", { cwd: workingDirectory, target: appTarget });
  }

  public async openProjectFile(workingDirectory: string, fileRelativePath: string): Promise<void> {
    await callDaemon("POST", "/api/open", { cwd: workingDirectory, path: fileRelativePath });
  }

  public async setReasoningEffort(sessionKey: string, effortTier: ReasoningEffort): Promise<void> {
    await callDaemon("POST", `/api/sessions/${uriEncode(sessionKey)}/effort`, { reasoningEffort: effortTier });
  }

  public async goal(sessionKey: string, goalActionVerb: GoalAction, objectiveText?: string): Promise<{ turnId: string | null }> {
    const res = await callDaemon<{ turnId?: string | null }>("POST", `/api/sessions/${uriEncode(sessionKey)}/goal`, {
      action: goalActionVerb,
      objective: objectiveText,
    });
    return { turnId: res.turnId ?? null };
  }

  public async subagent(sessionKey: string, actionVerb: SubagentAction, agentId: string, subOpts?: { reason?: string; body?: string }): Promise<void> {
    await callDaemon("POST", `/api/sessions/${uriEncode(sessionKey)}/subagent`, {
      action: actionVerb,
      subagentId: agentId,
      reason: subOpts?.reason,
      body: subOpts?.body,
    });
  }

  public async task(sessionKey: string, actionVerb: TaskAction, backgroundTaskId?: string): Promise<void> {
    await callDaemon("POST", `/api/sessions/${uriEncode(sessionKey)}/tasks`, { action: actionVerb, taskId: backgroundTaskId });
  }

  public async workflow(
    sessionKey: string,
    actionVerb: WorkflowAction,
    runIdentifier: string,
    childData?: { childId: string; attempt: number },
  ): Promise<void> {
    await callDaemon("POST", `/api/sessions/${uriEncode(sessionKey)}/workflow`, {
      action: actionVerb,
      workflowRunId: runIdentifier,
      childId: childData?.childId,
      attempt: childData?.attempt,
    });
  }

  public async readOutput(sessionKey: string, parentItemId: string, outputRefId: string, byteOffset = 0): Promise<OutputRange> {
    const endpoint = `/api/sessions/${uriEncode(sessionKey)}/output?itemId=${uriEncode(parentItemId)}&outputRef=${uriEncode(outputRefId)}&offset=${byteOffset}`;
    const res = await callDaemon<{ output: OutputRange }>("GET", endpoint);
    return res.output;
  }

  public async planUsage(): Promise<PlanUsageReport> {
    const rawReport = await callDaemon<PlanUsageReport>("GET", "/api/plan-usage");
    return { ...rawReport, byAccount: rawReport.byAccount ?? {} };
  }

  public listFiles(workingDirectory: string, folderPath: string): Promise<FileListing> {
    return callDaemon<FileListing>("GET", `/api/files/list?cwd=${uriEncode(workingDirectory)}&path=${uriEncode(folderPath)}`);
  }

  public readFile(workingDirectory: string, filePath: string): Promise<FileContent> {
    return callDaemon<FileContent>("GET", `/api/files/read?cwd=${uriEncode(workingDirectory)}&path=${uriEncode(filePath)}`);
  }

  public writeFile(
    workingDirectory: string,
    filePath: string,
    payloadText: string,
    expectedMtime: number | null,
  ): Promise<{ path: string; size: number; mtimeMs: number }> {
    return callDaemon("PUT", "/api/files/write", {
      cwd: workingDirectory,
      path: filePath,
      content: payloadText,
      baseMtimeMs: expectedMtime,
    });
  }

  public async searchFiles(workingDirectory: string, searchPattern: string): Promise<FileEntry[]> {
    const res = await callDaemon<{ files: FileEntry[] }>(
      "GET",
      `/api/files/search?cwd=${uriEncode(workingDirectory)}&q=${uriEncode(searchPattern)}`,
    );
    return res.files;
  }

  public async openFileExternally(workingDirectory: string, filePath: string): Promise<void> {
    await callDaemon("POST", "/api/files/open", { cwd: workingDirectory, path: filePath });
  }

  public fileUrl(workingDirectory: string, filePath: string): string {
    return this.assetUrl(`/api/files/raw?cwd=${uriEncode(workingDirectory)}&path=${uriEncode(filePath)}`);
  }

  public assetUrl(resourcePath: string): string {
    return resolveTargetUrl(resourcePath);
  }

  public subscribe(handlerCallback: EventHandler): () => void {
    this.subscribers.add(handlerCallback);
    void this.establishEventStream();
    const unsubscribeFn = () => {
      this.subscribers.delete(handlerCallback);
      if (this.subscribers.size === 0) {
        this.clearWatchdogTimer();
        this.activeStream?.close();
        this.activeStream = null;
        this.hasReportedLost = false;
      }
    };
    return unsubscribeFn;
  }

  private ensureCookieHandshake(): Promise<void> | void {
    if (!activeDaemon.token) {
      return;
    }
    if (!this.pendingAuth) {
      this.pendingAuth = callDaemon("POST", "/api/auth", { token: activeDaemon.token })
        .then(() => undefined)
        .finally(() => {
          this.pendingAuth = null;
        });
    }
    return this.pendingAuth;
  }

  private async establishEventStream(): Promise<void> {
    if (this.activeStream || this.isConnecting) {
      return;
    }
    this.isConnecting = true;
    try {
      await this.ensureCookieHandshake();
    } catch {
      // Allow connection even if auth handshake fails
    } finally {
      this.isConnecting = false;
    }

    if (this.activeStream || this.subscribers.size === 0) {
      return;
    }

    const sseSource = new EventSource(resolveTargetUrl("/api/events"), {
      withCredentials: Boolean(activeDaemon.base),
    });

    sseSource.addEventListener("ancilla", (eventMessage) => {
      this.pingWatchdog();
      this.hasReportedLost = false;
      let eventPayload: AncillaEvent;
      try {
        eventPayload = JSON.parse((eventMessage as MessageEvent<string>).data) as AncillaEvent;
      } catch {
        return;
      }
      this.notifySubscribers(eventPayload);
    });

    sseSource.addEventListener("ping", () => {
      this.pingWatchdog();
    });

    sseSource.addEventListener("open", () => {
      this.pingWatchdog();
      this.hasReportedLost = false;
    });

    sseSource.addEventListener("error", () => {
      this.broadcastDisconnection();
    });

    this.activeStream = sseSource;
    this.pingWatchdog();
  }

  private pingWatchdog(): void {
    this.clearWatchdogTimer();
    this.watchdogHandle = setTimeout(() => this.reconnectStream(), SSE_WATCHDOG_IDLE_MS);
  }

  private clearWatchdogTimer(): void {
    if (this.watchdogHandle !== null) {
      clearTimeout(this.watchdogHandle);
      this.watchdogHandle = null;
    }
  }

  private reconnectStream(): void {
    this.clearWatchdogTimer();
    this.activeStream?.close();
    this.activeStream = null;
    this.broadcastDisconnection();
    if (this.subscribers.size > 0) {
      void this.establishEventStream();
    }
  }

  private broadcastDisconnection(): void {
    if (this.hasReportedLost) {
      return;
    }
    this.hasReportedLost = true;
    this.notifySubscribers({ type: "connection", state: "lost" });
  }

  private notifySubscribers(event: AncillaEvent): void {
    for (const sub of [...this.subscribers]) {
      try {
        sub(event);
      } catch (err) {
        console.error(`Ancilla: subscriber failed on event of type "${event.type}"`, err);
      }
    }
  }
}
