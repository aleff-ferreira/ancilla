/** Domain types shared by the UI, the client contract and the pure fold logic. */

export type ApprovalMode = "allowAll" | "denyUnmatched" | "onRequest" | "promptUnmatched";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type IfBusy = "queue" | "steer";

export type BuiltinProviderId =
  | "muse"
  | "codex"
  | "claude"
  | "gemini"
  | "copilot"
  | "kimi"
  | "qwen"
  | "opencode"
  | "acp-custom"
  | "api";

export type ProviderId = BuiltinProviderId | `acp:${string}`;
export type ApiProviderKind = "openai" | "anthropic" | "google";
export type ProviderTransport = "msp" | "acp" | "codex-app-server" | "claude-stream-json" | "http-api";
export type ProviderAuthKind = "cli-oauth" | "device-code" | "api-key" | "none";
export type ProviderQuotaSupport = "windows" | "tier-only" | "ledger-only" | "none";

export interface ProviderCapabilities {
  transport: ProviderTransport;
  authKind: ProviderAuthKind;
  supportsResume: boolean;
  supportsFork: boolean;
  supportsCompact: boolean;
  supportsSteer: boolean;
  supportsReasoningEffort: boolean;
  supportsApprovalModes: readonly ApprovalMode[];
  supportsInteractiveQuestions: boolean;
  supportsSkills: boolean;
  supportsGoals: boolean;
  supportsSubagents: boolean;
  supportsOutputPaging: boolean;
  supportsImageAttachments: boolean;
  supportsNativeWebSearch: boolean;
  quotaSupport: ProviderQuotaSupport;
}

export interface ProviderAuthStatus {
  state: "authenticated" | "unauthenticated" | "ready" | "missing-key" | "unknown";
  summary: string | null;
  email: string | null;
  planTier: string | null;
  authMethod: string | null;
}

export interface ProviderBinaryInfo {
  providerId: ProviderId;
  available: boolean;
  runtime: "posix" | "native" | "wsl" | "builtin";
  binaryPath: string | null;
  distro: string | null;
  version: string | null;
}

export interface ProviderAccountView {
  id: string;
  providerId: ProviderId;
  name: string;
  runtimeOverride: string | null;
  binaryPath: string | null;
  customArgs: string[];
  apiKind: ApiProviderKind | null;
  apiBaseUrl: string | null;
  hasApiKey: boolean;
  stripAmbientKeys: boolean;
  defaultModelId: string | null;
  customModels: string[];
  createdAt: string;
  lastUsedAt: string | null;
  auth?: ProviderAuthStatus;
}

export interface ProviderView {
  id: ProviderId;
  displayName: string;
  vendorName: string;
  subscriptionSummary: string;
  binaryName: string | null;
  serveArgs: readonly string[];
  loginArgs: readonly string[] | null;
  installDocsUrl: string | null;
  usageDashboardUrl: string | null;
  capabilities: ProviderCapabilities;
  binary: ProviderBinaryInfo;
  ambientKeyOverrides: string[];
  defaultAuth: ProviderAuthStatus;
  accounts: Array<ProviderAccountView | AccountView>;
}

export interface ProvidersCatalogView {
  providers: ProviderView[];
  accounts: ProviderAccountView[];
  ambientKeyOverrides: Record<string, string[]>;
  remoteDeployment: boolean;
  license: string;
  sourceOfferUrl: string;
}

export interface ProviderQuotaView {
  providerId: ProviderId;
  displayName: string;
  accountId: string | null;
  accountName: string | null;
  quotaSupport: ProviderQuotaSupport;
  usageDashboardUrl: string | null;
  usage: PlanUsage | null;
}

export interface ProviderLoginResult {
  status: "waiting" | "done" | "interactive" | "error";
  url: string | null;
  code: string | null;
  needsCodeInput?: boolean;
  loginId: string;
  terminalCommand: string;
  message?: string;
}

export interface EnvironmentStatus {
  platform: string;
  /** Where Muse runs: on the OS itself, as native Windows Muse, or in WSL. Older servers leave it out. */
  runtime?: "posix" | "native" | "wsl";
  wslAvailable: boolean;
  defaultDistro: string | null;
  museFound: boolean;
  musePath: string | null;
  version: string;
  persistent: boolean;
}

/** Linux setup is performed by the authenticated server, under the current user's account. */
export interface LinuxSetupView {
  supported: boolean;
  museFound: boolean;
  installation: {
    status: "idle" | "installing" | "installed" | "error" | "cancelled";
    phase: string;
    message: string;
    attemptId: string | null;
    loginUrl: string | null;
    loginCode: string | null;
  };
  storage: {
    status: "ready" | "repairable" | "blocked" | "missing";
    path: string;
    message: string;
  };
}

/** Native Linux shell integration; absent when Ancilla runs in a browser. */
export interface LinuxDesktopStatus {
  kind: "appimage" | "package" | "development";
  menuInstalled: boolean;
  desktopShortcutInstalled: boolean;
  desktopShortcutSupported: boolean;
  canInstall: boolean;
  restartRequired: boolean;
  installedPath: string | null;
}

export interface ProjectView {
  cwd: string;
  displayName: string;
  pinned: boolean;
  activityAt: string;
  /** The provider new threads here default to; defaults to `muse` when absent. */
  defaultProviderId?: ProviderId;
  /** The account new threads here default to; null for the default login. */
  defaultAccountId: string | null;
  /** Every folder the project groups, its own first. A thread runs in exactly one of them. */
  folders: ProjectFolder[];
}

export interface ProjectFolder {
  cwd: string;
  displayName: string;
}

/** Server-tracked live state for a session; null until the server has seen it run. */
export interface LiveView {
  activeTurnId: string | null;
  turnStartedAt: string | null;
  pendingApprovals: number;
  pendingInputs: number;
  lastTerminal: string | null;
  lastError: string | null;
  viewHealth?: { status: string; reason: string | null } | null;
  /** The session's goal as the server last saw it, for threads the UI has not opened. */
  goal?: Goal | null;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  title: string;
  titleSource: "placeholder" | "auto" | "user";
  turnCount: number;
  modelId: string | null;
  origin: string;
  archived: boolean;
  createdAt: string;
  activityAt: string;
  /** Shelved out of the active list, by hand or after days without activity. */
  settled: boolean;
  settledAt: string | null;
  /** When it was last brought back from the shelf; keeps its place in the active list. */
  unsettledAt: string | null;
  /** Sandbox posture at creation; null for threads recorded before tracking. */
  sandboxDisabled: boolean | null;
  /** Provider running this thread; defaults to `muse` when absent. */
  providerId?: ProviderId;
  /** Capabilities advertised by this thread's provider. */
  capabilities?: ProviderCapabilities;
  /** The profile or provider account this thread runs under; null for the default login. */
  accountId: string | null;
  live: LiveView | null;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface WorkflowChild {
  childId: string;
  attempt: number;
  label?: string;
  phase?: string;
  status: string;
  terminal?: string;
  /** How long the agent ran. Present once it has stopped. */
  durationMs?: number;
  resultRef?: string;
  /**
   * The agent's tokens. Muse sends them on the one revision whose status is `usage`, just before the agent
   * completes, and leaves them off every later revision; the fold latches them.
   */
  usage?: TokenUsage;
}

/** One MSP transcript item at some revision. Unknown fields are kept and ignored. */
export interface MspItem {
  itemId: string;
  kind: string;
  status: string;
  revision: number;
  turnId?: string | null;
  recordedAt?: string;
  fallbackText?: string;
  text?: string;
  displayText?: string;
  steered?: boolean;
  retracted?: boolean;
  commandId?: string;
  tool?: string;
  args?: string;
  callId?: string;
  approvalId?: string;
  visibleOutput?: string;
  truncated?: boolean;
  failureKind?: string;
  failureReason?: string;
  background?: boolean;
  /** `toolCall` in the background: who put it there, the user or Muse after a timeout. */
  backgroundInitiator?: "user" | "timeout";
  summary?: string[];
  commandText?: string;
  exitCode?: number;
  exitSignal?: number;
  durationMs?: number;
  objective?: string;
  role?: string;
  controlStatus?: string;
  result?: { summary?: string; text?: string; errorKind?: string };
  usage?: TokenUsage;
  children?: WorkflowChild[];
  message?: string;
  outcome?: string;
  reason?: string;
  trigger?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  /** `subagent`: the durable child id the `subagent/*` controls address. Muse 1.3.0 does not fill it in yet. */
  subagentId?: string;
  /** `reminderChild`: the background task this reminder is about. */
  taskId?: string;
  /** `workflow`, and a `subagent` a workflow owns: the run the workflow controls address. */
  workflowRunId?: string;
  /** `workflow`: the run's human name, the `name` the launch was given. */
  entryId?: string;
  /** `workflow`: the generated script's id, like `generated.workflow.<slug>`. */
  scriptId?: string;
  /** `workflow`: what started it, `guidanceAuto` when the model chose to. */
  triggerSource?: string;
  /** `subagent` and `reminderChild`: the child's own session. */
  childSessionId?: string;
  /** `toolCall` and `userShell`: where the full output is kept when the view truncated it. */
  outputRef?: OutputRef;
  [key: string]: unknown;
}

/** A tool's stored output. Read it through `item/readOutput` by `id`; the uri is only for display. */
export interface OutputRef {
  id: string;
  kind?: string;
  mediaType?: string;
  byteLen?: number;
  availability?: string;
}

/** One page of stored output. `offsetBytes + byteLen` is where the next page starts. */
export interface OutputRange {
  content: string;
  encoding: string;
  mediaType: string;
  offsetBytes: number;
  byteLen: number;
  eof: boolean;
}

export interface ApprovalChoice {
  choiceId: string;
  label: string;
  decision: string;
  scope: string;
  acceptsFeedback?: boolean;
  rulePreview?: string;
}

export interface ApprovalStage {
  argv: string[];
  position: number;
  totalStages: number;
}

export interface ApprovalSubject {
  kind: string;
  command?: string;
  path?: string;
  access?: string;
  host?: string;
  port?: number;
  protocol?: string;
  toolName?: string;
  target?: string;
  workspaceRoot?: string;
  stages?: ApprovalStage[];
}

export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  availableChoices: ApprovalChoice[];
  currentRequirementId: unknown;
  subject: ApprovalSubject;
  itemId?: string;
  toolName?: string;
  toolCallId?: string;
  turnId?: string;
  rawArgs?: string;
  protectedWrite?: boolean;
  judgeEscalated?: boolean;
}

export interface UserInputOption {
  label: string;
  description?: string;
  preview?: { content: string; format: string };
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: UserInputOption[];
  selection: { mode: "single" | "multiple" | string; minSelections?: number; maxSelections?: number };
}

export interface UserInputRequest {
  userInputId: string;
  sessionId: string;
  questions: UserInputQuestion[];
  itemId?: string;
  toolName?: string;
  turnId?: string;
  autoResolutionMs?: number;
}

export interface UserInputAnswer {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
  note?: string;
}

export interface TodoItem {
  text: string;
  status: string;
  activeForm?: string;
}

export interface ContextUsage {
  usedTokens: number;
  windowTokens?: number;
  pressure: string;
}

export interface TokenTotals {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface Goal {
  objective: string;
  status: string;
  percentComplete: number;
  currentWork?: string;
  nextWork?: string;
}

export interface ModelOption {
  modelId: string;
  displayLabel: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  contextLimit: number | null;
  outputLimit: number | null;
  /** Catalog price per million tokens; null when the catalog lists none. */
  cost: { input: number; output: number; cached: number; currency: string | null } | null;
  /** Contributor-tier models may use prompts and outputs for product improvement. */
  contributor: boolean;
  /**
   * The reasoning levels Muse lists for this model, in the UI's order. Null or absent when the host lists none
   * (an older host, or `unknown`), which means every level, as before.
   */
  efforts?: ReasoningEffort[] | null;
}

/** What a `model/list` answer says about itself, apart from its rows. */
export interface ModelCatalogInfo {
  /** Where Muse got the list: `providerCatalog` is the live one; a bundled or config catalog is Muse's own built-in copy. */
  source: string | null;
  providerId: string | null;
  profileId: string | null;
  /** The Muse version of the host that answered; null when it did not say. */
  hostVersion: string | null;
}

/** A model list with what Muse says about it. */
export interface ModelCatalog extends ModelCatalogInfo {
  models: ModelOption[];
}

/** Where one catalog scope's load stands. The scope keys are `modelsKey`'s. */
export interface ModelsStatus {
  status: "idle" | "loading" | "ready" | "error";
  /** Why the last load failed; null otherwise. */
  error: string | null;
  /** When the last load answered, in platform time; null until one has. */
  loadedAt: number | null;
  /** What the last good answer said about its list; kept through a failed refresh. */
  catalog: ModelCatalogInfo | null;
}

/** Server-owned thread-title generation: the switch, and the model when one is chosen. */
export interface TitleSettings {
  enabled: boolean;
  modelId: string | null;
}

/** Server-owned Muse sandbox posture: whether hosts spawn with `--disable-sandbox`. */
export interface SandboxSettings {
  disabled: boolean;
}

/** Server-owned YOLO mode: hosts spawn with `--disable-sandbox --trust-workspace`, approvals bypassed. */
export interface YoloSettings {
  enabled: boolean;
}

/** A skill Muse can load in a workspace, from `muse skills list`. Skills switched off are left out. */
export interface SkillEntry {
  id: string;
  name: string;
  displayName: string;
  /** Written for the model, so often long; menus show `shortDescription` or its first sentence. */
  description: string;
  shortDescription: string | null;
  scope: string;
  /** `on`, or `user-invocable-only` for skills the model never loads by itself. */
  activation: string;
  /** What the skill expects after its name, when it says. */
  argumentHint?: string | null;
}

/** The skills for one workspace; `error` says why the list is empty when loading failed. */
export interface SkillCatalog {
  skills: SkillEntry[];
  error: string | null;
}

/** The subfolders of one folder, for the add-project picker. */
export interface DirectoryListing {
  /** The folder listed, as an absolute path in the user's style (`~` expanded). */
  directory: string;
  parent: string | null;
  separator: "/" | "\\";
  exists: boolean;
  entries: { name: string }[];
}

/** A `!` command Ancilla ran itself in the workspace, with what it printed. */
export interface ShellRun {
  id: string;
  sessionId: string;
  command: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  durationMs: number | null;
  at: string;
}

// ---------------------------------------------------------------- deep research
// Wire mirrors of `@ancilla/daemon`'s research view types (packages/daemon/src/research). The UI does not import
// the daemon package, so these are kept by hand, like SessionSummary.

export interface ResearchModelIds {
  supervisor: string | null;
  worker: string | null;
  writer: string | null;
}

export interface ResearchConfig {
  windowMinMinutes: number;
  windowMaxMinutes: number;
  maxRounds: number;
  maxParallel: number;
  workerMaxToolCalls: number;
  workerMaxSearches: number;
  workerMaxReads: number;
  workerMaxSaves: number;
  workerWallTimeMinutes: number;
  draftFirst: boolean;
  salvageFraction: number;
  tokenSoftCap: number | null;
  trace: boolean;
  models: ResearchModelIds;
}

export interface ResearchSettings {
  enabled: boolean;
  config: ResearchConfig;
}

export type ResearchStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled" | "interrupted";

/** The documents a report can be turned into. */
export type ResearchExportFormat = "pdf" | "docx" | "html";

/** A report turned into a document: written next to report.md, and served at `url` for a browser to download. */
export interface ResearchExport {
  /** Relative to the project folder, like `.ancilla/research/<runId>/report.pdf`. */
  path: string;
  name: string;
  size: number;
  url: string;
}
export type ResearchPhase = "scoping" | "drafting" | "researching" | "writing" | "done";
export type ResearchWorkerState = "queued" | "working" | "completed" | "failed" | "timed_out" | "cancelled";

export interface ResearchUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

export interface ResearchWorkerView {
  agentId: number;
  round: number;
  topic: string;
  discovery: boolean;
  state: ResearchWorkerState;
  toolCalls: number;
  searches: number;
  reads: number;
  saved: number;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * The source counts of a run: `verified` is how many can be cited. The four after `curated` say how the sources
 * were reached (opened, seen in search results only, a fetch that failed or was cut off, or listed by an earlier version that did not
 * record how) and are absent from a server that does not know provenance. `searchOnly`, `attempted` and
 * `listedEarlier` can fall while a run goes (a source seen in a search result and opened later changes count);
 * `evidence` is the one number that only grows while a run goes, the sum of how strong each source's evidence is,
 * and is absent from a server that predates it.
 */
export interface ResearchSourceCounts {
  registry: number;
  verified: number;
  curated: number;
  opened?: number;
  searchOnly?: number;
  attempted?: number;
  listedEarlier?: number;
  evidence?: number;
}

/** A DeepResearch run as the server reports it; `report` is only filled by `getResearch`. */
export interface ResearchRunView {
  runId: string;
  sessionId: string;
  status: ResearchStatus;
  phase: ResearchPhase;
  question: string;
  brief: string | null;
  round: number;
  maxRounds: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  researchDeadlineAt: string | null;
  workers: ResearchWorkerView[];
  sources: ResearchSourceCounts;
  usage: ResearchUsage;
  failure: string | null;
  /** How many times the run was resumed after an interruption; missing (an older server) reads as 0. */
  resumes?: number;
  reportAvailable: boolean;
  report: string | null;
  reportPath: string | null;
  /** Why the report has no file, when the project would not take it; the report itself is still in Ancilla. */
  reportWriteError?: string | null;
  /** True when the report was written with no citable source at all. */
  noCitableSources?: boolean;
  config: ResearchConfig;
}

/** One day's tokens for one model, as the server aggregates them for the usage page. */
export interface UsageBucket {
  /** `YYYY-MM-DD`: a calendar day in the report's `tz` (UTC when it names none). */
  day: string;
  providerId?: ProviderId;
  modelId: string;
  calls: number;
  promptTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  durationMs: number;
}

export interface UsageThread {
  sessionId: string;
  title: string | null;
  cwd: string | null;
  providerId?: ProviderId;
  calls: number;
  promptTokens: number;
  outputTokens: number;
  cachedTokens: number;
  modelIds: string[];
  /** Tokens split by model, so a thread that switched models is priced at each model's own rate. */
  models?: { modelId: string; calls: number; promptTokens: number; outputTokens: number; cachedTokens: number }[];
  lastAt: string;
  /** `research` for the one row that folds a project's DeepResearch workers; it is no thread and has no page to open. */
  kind?: "research";
  /** The login the thread runs under; null is the default one. Older servers leave it out. */
  accountId?: string | null;
}

/** What the usage totals leave out, so the page can say so. */
export interface UsageCoverage {
  /** Threads (DeepResearch workers aside) with at least one call in the window. */
  countedThreads: number;
  /** Of those, the threads whose history could not be read back in full. */
  partialThreads: number;
  /** Threads active in the window with no call recorded at all: nothing here has read them yet. */
  uncountedThreads: number;
}

/** Every model call Ancilla has seen, bucketed; the UI puts prices on it. */
export interface UsageReport {
  /** The start of the first local day in the window (an ISO instant). */
  since: string;
  days: number;
  /** The IANA zone the days are in (`UTC` when none was asked for); older servers leave it out and days are UTC. */
  tz?: string;
  buckets: UsageBucket[];
  threads: UsageThread[];
  coverage?: UsageCoverage;
}

/** A view notification, live or paged from history. `at` is the emission time when known. */
export interface ViewEvent {
  method: string;
  params: Record<string, unknown>;
  at?: number;
}

/** A file the user attached to a prompt, as the server kept it: Muse's own view carries metadata only. */
export interface AttachmentView {
  id: string;
  turnId: string | null;
  name: string;
  mediaType: string;
  kind: "image" | "file";
  width: number | null;
  height: number | null;
  /** Where the bytes are served from, relative to the server. */
  url: string;
}

/** A file on its way out with a prompt. */
export interface OutgoingAttachment {
  name: string;
  mediaType: string;
  /** The file's bytes, base64 without a `data:` prefix. */
  base64: string;
  width?: number;
  height?: number;
}

/** A usage window as a percentage of the plan's allowance, with when it resets. */
export interface PlanWindow {
  usedPercent: number;
  resetsAtMs: number;
  /** The short rolling window's length; null for the weekly block. */
  windowDurationMins: number | null;
}

/** The subscription meter Muse last saw: the rolling window, the weekly cap, and the plan tier. */
export interface PlanUsage {
  tier: string;
  observedAtMs: number;
  window: PlanWindow;
  weekly: PlanWindow;
}

export type PlanUsageByAccount = Record<string, PlanUsage>;

export type PlanUsageStatus = "ready" | "no-host" | "unobserved" | "unavailable";

/** Account identity, observation provenance and refresh health travel with each quota reading. */
export interface PlanAccountUsage {
  accountId: string | null;
  usage: PlanUsage | null;
  planName: string | null;
  source: "meta" | "runtime" | "saved" | null;
  status: "ready" | "not-reported" | "no-subscription" | "login-required" | "unavailable" | "runtime-only";
  /** The last direct account check; a runtime event must not advance this timestamp. */
  checkedAtMs: number | null;
}

export interface PlanUsageReport {
  usage: PlanUsage | null;
  byAccount: PlanUsageByAccount;
  /** The source of `usage`, which is the latest reading across accounts. */
  accountId?: string | null;
  /** A saved reading has not been observed by a host in this server run. */
  saved?: boolean;
  savedAccountIds?: string[];
  status?: PlanUsageStatus;
  /** Includes the default login as well as named profiles, even when no quota is available. */
  accounts?: PlanAccountUsage[];
  /** Subscription & rate-limit quota windows for non-Muse providers (`codex`, `claude`, `gemini`, `copilot`, `api`). */
  providerQuotas?: ProviderQuotaView[];
}

export interface AccountView {
  id: string;
  name: string;
  hasLogin: boolean;
  email: string | null;
  lastUsedAt: string | null;
}

/** The default CLI login can live in the OS credential store or another runtime; null means unverified. */
export interface DefaultLoginIdentity {
  hasLogin: boolean | null;
  email: string | null;
}

export interface AccountsHealth {
  metaApiKeyInherited: boolean;
  defaultLogin?: DefaultLoginIdentity;
}

export type AccountLoginResult =
  | { url: string; code: string | null; loginId?: string }
  | { fallback: string };

export interface AccountLoginProgress {
  status: "waiting" | "done" | "error" | "idle";
  url?: string | null;
  code?: string | null;
  needsCodeInput?: boolean;
  message?: string;
}

/** What the file viewer does with a file: text and markdown come inline, media is loaded from its own URL. */
export type FileKind = "text" | "markdown" | "image" | "video" | "audio" | "pdf" | "binary";

export interface FileEntry {
  name: string;
  /** Relative to the project folder, with forward slashes. */
  path: string;
  kind: "dir" | "file";
  size: number;
  mtimeMs: number;
}

export interface FileListing {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  name: string;
  size: number;
  /** When it was last written; a save sends it back, so an edit made meanwhile is not overwritten. */
  mtimeMs: number;
  kind: FileKind;
  mediaType: string;
  /** Text and markdown only. */
  content?: string;
  /** Text too large to send whole; `content` is its start. */
  truncated: boolean;
}

export type GoalAction = "set" | "edit" | "pause" | "resume" | "clear";
export type SubagentAction = "interrupt" | "stop" | "close" | "resume" | "reopen" | "sendMessage" | "followupTask" | "readResult";
export type TaskAction = "background" | "stop" | "stopAll";
export type WorkflowAction = "cancel" | "skip" | "retry";

export interface TranscriptLoad {
  session: SessionSummary | null;
  msp: {
    status: string | null;
    activeTurnId: string | null;
    modelId: string | null;
    approvalMode: string | null;
    workspaceRoot: string | null;
    turnCount: number;
    contextUsage?: ContextUsage | null;
    tokenUsage?: TokenTotals | null;
  } | null;
  events: ViewEvent[];
  truncated: boolean;
  /** Every file attached to this thread's prompts, in send order. */
  attachments?: AttachmentView[];
  /** Every `!` command Ancilla ran itself for this thread. */
  shellRuns?: ShellRun[];
  /** Every DeepResearch run started from this thread; optional so a server without the feature still loads. */
  researchRuns?: ResearchRunView[];
  pending: { approvals: ApprovalRequest[]; userInputs: UserInputRequest[] };
  readOnly: boolean;
  readOnlyReason: string | null;
  /** A failed history read must not replace the transcript already on screen with an empty one. */
  historyUnavailable?: boolean;
  pendingComplete?: boolean;
  viewHealth?: { status: string; reason: string | null } | null;
}

// ------------------------------------------------------------------------------------------------ the assistant

export type MemoryKind = "fact" | "preference" | "constraint" | "event" | "decision" | "procedure" | "commitment" | "working";
export type MemoryStatus = "active" | "superseded" | "contested" | "pending" | "deleted";
export type MemoryBasis = "explicit" | "observed" | "inferred";
export type AssistantAutonomy = "ask" | "suggest" | "act";

export interface MemoryScopeView {
  kind: "global" | "account" | "project" | "thread";
  key: string;
}

export interface MemoryItemView {
  id: string;
  kind: MemoryKind;
  scope: MemoryScopeView;
  status: MemoryStatus;
  slot: string | null;
  pinned: boolean;
  text: string;
  basis: MemoryBasis;
  confidence: number;
  observedAt: number;
  validFrom: number | null;
  validTo: number | null;
  dueAt: number | null;
  commitment: "open" | "done" | "dropped" | null;
  revalidateAfterMs: number | null;
  lastConfirmedAt: number;
  supersededBy: string | null;
  rev: number;
  identifiers: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemorySourceView {
  id: string;
  kind: string;
  excerpt: string;
  observedAt: number;
  trust: "user" | "verified" | "unverified" | "untrusted";
  sessionId?: string;
}

export interface MemoryRevisionView {
  rev: number;
  text: string;
  basis: MemoryBasis;
  actor: "capture" | "user" | "consolidation" | "task";
  reason: string;
  createdAt: number;
}

export interface MemoryDetailView {
  item: MemoryItemView;
  revisions: MemoryRevisionView[];
  sources: MemorySourceView[];
  lineage: { id: string; text: string; status: MemoryStatus; observedAt: number }[];
  /** For a waiting correction: the memories it could replace. */
  mayCorrect: { id: string; text: string }[];
}

export interface MemoryListView {
  items: MemoryItemView[];
  total: number;
  epoch: number;
}

export type AvatarForm = "halo" | "optic" | "hologram" | "critter" | "cipher";
export type VoiceArchetype = "steady" | "warm" | "dry" | "sharp" | "playful" | "formal" | "curious" | "custom";
export type CharacterPresence = "off" | "tone" | "full";

/** What a face is doing. The first is the resting one; delight and concern are brief and go back to it. */
export type AvatarMoodId = "idle" | "working" | "attention" | "delight" | "concern" | "asleep";

/**
 * A figure built from parts. Each part is named by a short id from the catalogue in `companion/figure/parts.ts`, and an id the
 * catalogue does not know draws the plain part, so a pack made by a newer Ancilla still shows in an older one. The colours
 * come from the avatar's own hue and glow, so one slider recolours any figure.
 */
export interface FigureSpec {
  body: string;
  top: string;
  eyes: string;
  mouth: string;
  mark: string;
  gear: string;
  aura: string;
  finish: string;
  /** The accent colour's hue, 0 to 359, or null for the one that suits the main hue. */
  accent: number | null;
  /** From light (0) to deep (4). */
  shade: number;
}

/**
 * What the assistant wears. A sigil is one of the forms of light above (the form, hue, glow and detail say which);
 * a companion is one of the built-in studio companions (`companion/companions/catalog.ts`); a figure is a legacy part-built
 * character; a pack is something the user drew or brought (pixel art, a picture, a sprite sheet), kept on the server.
 */
export type AvatarLookView = { kind: "sigil" } | { kind: "companion"; id: string } | { kind: "figure"; figure: FigureSpec } | { kind: "pack"; id: string; rev: number };

/** Pixel art: a square or a rectangle of coloured cells with frames for the moods. */
export interface PixelData {
  /** Cells across and down, 8 to 64. */
  w: number;
  h: number;
  /** "#rrggbb" colours, at most 32. A cell holds 0 (clear) or n, which is `palette[n - 1]`. */
  palette: string[];
  /** Each mood's frames: every frame is `w * h` cells, one byte each, in base64; `ms` is how long a frame shows. Idle is required; a mood without frames wears idle's and moves in its own way. */
  moods: Partial<Record<AvatarMoodId, { ms: number; frames: string[] }>>;
}

/** A picture, or a sprite sheet: a grid of frames in one picture, with the row that plays for each mood. */
export interface ImagePackData {
  /** The picture as a `data:image/png|webp|jpeg;base64,` URL. */
  src: string;
  /** Pixels across and down of the whole picture. */
  w: number;
  h: number;
  /** Present for a sprite sheet: its grid, and which row and how many frames of it play for each mood. */
  sheet?: { cols: number; rows: number; moods: Partial<Record<AvatarMoodId, { row: number; frames: number; ms: number }>> };
  /** Scale it without smoothing, for pixel art. */
  crisp: boolean;
}

/** A figure kept on its own, with the colour it was made in. */
export interface FigurePackData {
  figure: FigureSpec;
  hue: number;
  glow: number;
}

export type AvatarPackKind = "figure" | "pixel" | "image";

/** An avatar the user made or brought, as kept: the library on the Persona page lists these. */
export type AvatarPackView = {
  id: string;
  /** What the user calls it, up to 40 characters. */
  name: string;
  /** Size of its data, in bytes. */
  bytes: number;
  createdAt: number;
  updatedAt: number;
} & ({ kind: "figure"; data: FigurePackData } | { kind: "pixel"; data: PixelData } | { kind: "image"; data: ImagePackData });

/** An avatar without its data: what the library lists, so that opening the page does not carry every picture. */
export type AvatarPackMeta = Omit<AvatarPackView, "data">;

/** The assistant as a character: a face, a voice and a few habits. It changes how it looks and sounds, never what it may do. */
export interface AssistantCharacterView {
  /** `look` is absent on a server that predates it, and means a sigil. */
  avatar: { form: AvatarForm; hue: number; glow: number; detail: number; seed: number; look?: AvatarLookView };
  voice: { archetype: VoiceArchetype; warmth: number; humor: number; directness: number; curiosity: number; formality: number };
  callsUser: string;
  quirks: string[];
  presence: CharacterPresence;
  showBond: boolean;
  /** When the user made it theirs; null while it has the default look and voice, which is when it asks to be set up. */
  setupAt: number | null;
}

/** What the user and the assistant have shared, read off what is stored. It carries no word of any note. */
export interface AssistantBondView {
  since: number | null;
  daysTogether: number;
  remembered: number;
  replaced: number;
  finished: number;
  unchecked: number;
  milestones: { id: string; at: number }[];
}

export interface AssistantModelPreferenceView {
  providerId: ProviderId | null;
  accountId: string | null;
  modelId: string | null;
}

export interface AssistantProfileView {
  id: string;
  enabled: boolean;
  name: string;
  persona: string;
  character: AssistantCharacterView;
  communication: { verbosity: "concise" | "balanced" | "detailed"; tone: "plain" | "warm" | "formal"; language: string; notes: string };
  autonomy: AssistantAutonomy;
  policy: { allowReadOnly: boolean; allowProjectWrites: boolean; maxConcurrent: number; maxTurnsPerTask: number; maxMinutesPerTask: number; maxTasksPerDay: number };
  model?: AssistantModelPreferenceView;
  capturePaused: boolean;
  contextBudgetTokens: number;
  updatedAt: number;
}

export interface AssistantGoalView {
  id: string;
  text: string;
  priority: number;
  status: "active" | "paused" | "done";
  createdAt: number;
  updatedAt: number;
}

export interface AssistantStatusView {
  available: true;
  /** Nothing has been written yet: no file exists. */
  fresh?: boolean;
  profile: AssistantProfileView;
  goals: AssistantGoalView[];
  stats: { items: Record<MemoryStatus, number>; kinds: Record<string, number>; sources: number; revisions: number; tombstones: number; bytes: number; ftsEnabled: boolean };
  bond: AssistantBondView;
  epoch: number;
  executive?: boolean;
  tasks?: { open: number; needsYou: number; running: number; waiting?: AssistantWaitingView[] };
}

/** A task that has stopped for the person, and why (an older server does not say). */
export interface AssistantWaitingView {
  id: string;
  title: string;
  /** `approval` a proposal, `site` / `action` / `download` a web task's question, `question` one that is not known, `change` a task on a connected account that asks before it changes something, `blocked` a task that asks what to do. */
  cause: "approval" | "site" | "action" | "download" | "question" | "change" | "blocked";
  /** Why, in the task's own words: it changes when the task asks something else. Never shown in a notice. */
  reason: string;
}

/** What a tool does to an account: `read` looks; the others change something and are asked about, one call at a time. */
export type AssistantToolClass = "read" | "reversible" | "communicates" | "destructive";
export type AssistantWriteClass = Exclude<AssistantToolClass, "read">;

/** The person's setting for each kind of change. `always` is only ever for `reversible`, and only after a first yes. */
export type AssistantWritePolicy = Record<AssistantWriteClass, "off" | "ask" | "always">;

/** What the last test of a connected account found. */
export interface AssistantConnectorTest {
  at: number;
  ok: boolean;
  message: string;
  /** The tools the assistant is given, with our words for each. */
  offered: Array<{ name: string; text: string; class: AssistantToolClass }>;
  /** How many other tools the server has that are not offered. */
  hidden: number;
  /** Tools on our list that the server did not list. */
  missing: string[];
}

export interface AssistantConnectorOAuthView {
  scopes: readonly string[];
  helpUrl: string;
  recipe: string;
  clientConfigured: boolean;
  clientFromEnv: boolean;
  pending: boolean;
  canRevoke: boolean;
}

/** A connected account (or one that can be): never the token, nor anything made from it. */
export interface AssistantConnectorView {
  id: string;
  name: string;
  summary: string;
  connected: boolean;
  /** `read`: the assistant may look things up in it. `off`: it may not, and stays connected. */
  mode: "off" | "read";
  connectedAt: number | null;
  authMethod?: "token" | "oauth" | null;
  oauth?: AssistantConnectorOAuthView | null;
  token: { label: string; helpUrl: string; recipe: string };
  /** Removing a connection does not revoke the token at the provider: this says where that is done. */
  revoke: { url: string; text: string };
  /** Said before connecting when the provider cannot limit the token. */
  caution: string | null;
  /** The person's setting for each kind of change: all off until they switch one on. */
  policy: AssistantWritePolicy;
  /** The tools that change something, with our words for each: what the settings switch on. */
  writeTools: Array<{ name: string; class: AssistantWriteClass; text: string }>;
  test: AssistantConnectorTest | null;
}

export interface AssistantConnectorsView {
  connectors: AssistantConnectorView[];
  /** Where the tokens are kept, in words. */
  storage: string;
}

/** A change that waits for the person: made from the call itself, never from what the model said about it. */
export interface AssistantWriteCard {
  id: string;
  taskId: string | null;
  connector: string;
  connectorName: string;
  tool: string;
  class: AssistantWriteClass;
  /** What the tool does, in Ancilla's words. */
  what: string;
  /** What it is about ("owner/repo #12"), when the tool says. */
  target: string | null;
  /** Every argument, whole. */
  fields: Array<{ name: string; value: string }>;
  /** What code noticed that the person should look at before saying yes. */
  flags: Array<{ code: string; text: string }>;
  /** The hash of the arguments that an approval is bound to. */
  hash: string;
  at: number;
  expiresAt: number;
  /** Whether "always" may be answered. */
  offerAlways: boolean;
  /** Nobody was there when it was asked for: it waits for the person, with no task holding it. */
  proposal: boolean;
}

/** One line of what the connectors did. */
export interface AssistantConnectorActivity {
  at: number;
  kind: "call" | "connect" | "test" | "mode" | "policy" | "disconnect" | "write";
  connector: string;
  task?: string | null;
  tool?: string;
  args?: string;
  /** A change (`write`): which step, and the hash of its arguments. */
  phase?: "held" | "approved" | "refused" | "expired" | "proposed" | "executed";
  hash?: string;
  ok: boolean;
  size?: number;
  ms?: number;
  note?: string;
}

/** How the voice is set up; a key is never part of it. */
export type VoiceBrainSetting =
  /** Follows the provider, account, and model configured on the Assistant profile. */
  | { kind: "assistant" }
  /** Through Muse; `model` is the Muse model that answers, or null for Muse's own choice. */
  | { kind: "muse"; model: string | null; accountId?: string | null }
  /** Through any configured CLI provider or saved API endpoint from `Settings -> Providers`. */
  | { kind: "provider"; providerId: ProviderId; accountId: string | null; model: string | null }
  | { kind: "openai"; baseUrl: string; model: string; local: boolean; label: string | null; apiKeyEnv: string | null }
  | { kind: "anthropic"; baseUrl: string; model: string; local: boolean; label: string | null; apiKeyEnv: string | null }
  | { kind: "google"; baseUrl: string; model: string; local: boolean; label: string | null; apiKeyEnv: string | null }
  | { kind: "none" };

export type VoiceSpeechSetting =
  | { kind: "local" }
  | { kind: "http"; baseUrl: string; sttModel: string; ttsModel: string; local: boolean; apiKeyEnv: string | null };

export interface VoiceSettingsView {
  mode: "hands-free" | "push-to-talk";
  voice: string | null;
  speed: number;
  refine: boolean;
  ttsSteps: number;
  brain: VoiceBrainSetting;
  speech: VoiceSpeechSetting;
  proactive: boolean;
  keepDays: number | null;
  runtimeDir: string | null;
  modelsDir: string | null;
  defaultProject: string | null;
  /** A key is set for the model in `brain`. */
  hasKey: boolean;
  /** A key is set (or shared with `brain`) for the HTTP speech server in `speech`. */
  hasSpeechKey: boolean;
}

export interface VoiceStatusView {
  /** Everything a call cannot go without is installed. */
  available: boolean;
  pack: { runtime: boolean; vad: boolean; streaming: boolean; refine: boolean; tts: boolean; ready: boolean; missing: string[] };
  layout: { runtimeDir: string | null; modelsDir: string };
  engines: { loaded: boolean; asr: string | null; tts: string | null; sampleRate: number | null };
  call: { active: boolean; id: string | null; conversation: string | null; since: number | null };
  settings: VoiceSettingsView;
  brain: { label: string; local: boolean; problem: string | null };
  voices: { id: string; name: string; lang: string }[];
  latency: { turns: number; firstAudio: { n: number; p50: number | null; p95: number | null }; endpoint: { n: number; p50: number | null; p95: number | null } };
}

export interface VoiceConversationView {
  id: string;
  title: string;
  project: string | null;
  startedAt: number;
  updatedAt: number;
  turns: number;
}

export type AssistantTaskStatus = "queued" | "running" | "waiting" | "paused" | "blocked" | "completed" | "unverified" | "failed" | "cancelled";
export type AssistantStepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "cancelled" | "unknown";
export type AssistantVerifier = { type: "file_exists"; path: string } | { type: "file_contains"; path: string; text: string } | { type: "manual" };

export interface AssistantStepView {
  id: string;
  ord: number;
  title: string;
  prompt: string | null;
  effect: "read" | "write";
  verifier: AssistantVerifier | null;
  status: AssistantStepStatus;
  evidence: string;
  verified: boolean;
  attempts: number;
}

export interface AssistantAttemptView {
  id: string;
  stepId: string;
  number: number;
  fence: number;
  turnId: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: "running" | "succeeded" | "failed" | "cancelled" | "stale" | "unknown" | "timeout";
  detail: string;
}

export interface AssistantTaskView {
  id: string;
  title: string;
  goal: string;
  status: AssistantTaskStatus;
  reason: string;
  origin: "user" | "suggestion" | "schedule" | "voice" | "browse" | "connector";
  cwd: string;
  sessionId: string | null;
  allowWrites: boolean;
  maxTurns: number;
  maxMinutes: number;
  turnsUsed: number;
  retryAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  result: string;
  createdAt: number;
  updatedAt: number;
  progress: { done: number; total: number };
}

export interface AssistantTaskDetailView {
  task: AssistantTaskView;
  steps: AssistantStepView[];
  attempts: AssistantAttemptView[];
  events: { id: number; at: number; kind: string; detail: string }[];
}

export interface AssistantScheduleView {
  id: string;
  title: string;
  goal: string;
  cwd: string;
  kind: "interval" | "daily" | "once";
  everyMinutes: number | null;
  atMinute: number | null;
  tz: string;
  endAt: number | null;
  maxRuns: number | null;
  runs: number;
  enabled: boolean;
  note: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
}

export interface AssistantSuggestionView {
  id: string;
  kind: "due-commitment" | "stale-memory" | "goal-idle" | "task-needs-you";
  title: string;
  why: string;
  action: { type: "task"; goal: string; project: string | null } | { type: "confirm-memory"; memoryId: string } | { type: "open-task"; taskId: string };
  autonomous: boolean;
}

export interface AssistantPreviewView {
  text: string;
  tokens: number;
  wouldAdd: boolean;
  noEvidence: boolean;
  omitted: string[];
  memories: { id: string; text: string; kind: MemoryKind; score: number; why: string[]; stale: boolean }[];
}

/** Meaning search: finding notes by what they mean, with an embedding model the user names. A key is never sent here, only whether it is set. */
export interface AssistantEmbeddingsView {
  configured: boolean;
  baseUrl: string;
  model: string;
  queryPrefix: string;
  apiKeyEnv: string | null;
  keyPresent: boolean;
  minCosine: number;
  standoutCosine: number | null;
  standoutLead: number;
  most: number;
  indexed: number;
  pending: number;
  skipped: number;
  paused: boolean;
  error: string | null;
}

export type AssistantEmbeddingTestView = { ok: true; dimensions: number; ms: number } | { ok: false; error: string };

export interface AssistantActivityView {
  id: number;
  at: number;
  itemId: string | null;
  action: string;
  actor: string;
  detail: string;
}

/** What the server says after memory or a task changed: a save is announced only after it was written. */
export interface AssistantEventView {
  type: "assistant";
  reason: "memory" | "profile" | "goal" | "task";
  epoch: number;
  saved?: { id: string; kind: MemoryKind; text: string; status: MemoryStatus; replaced: number }[];
  forgotten?: number;
  question?: { about: string; options: { id: string; text: string }[]; pendingId?: string };
  declined?: { reason: string }[];
  taskId?: string;
}

export type AncillaEvent =
  | AssistantEventView
  | { type: "hello"; version: string }
  | { type: "msp"; sessionId: string; method: string; params: Record<string, unknown>; at: number }
  | { type: "session-status"; sessionId: string; live: LiveView | null }
  | { type: "sessions-changed" }
  | { type: "shell-run"; sessionId: string; run: ShellRun }
  | { type: "research-run"; sessionId: string; run: ResearchRunView }
  | { type: "plan-usage"; usage: PlanUsage; accountId: string | null }
  | { type: "provider-usage"; providerId: ProviderId; accountId: string | null; usage: PlanUsage }
  | { type: "login-completed"; providerId: ProviderId; accountId: string | null }
  | { type: "host"; key: string; state: string; message: string }
  | { type: "connection"; state: "open" | "lost" };
