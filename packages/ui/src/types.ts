// Domain types and schema contracts shared across Ancilla UI and transports
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
  runtime?: "posix" | "native" | "wsl";
  wslAvailable: boolean;
  defaultDistro: string | null;
  museFound: boolean;
  musePath: string | null;
  version: string;
  persistent: boolean;
}
// --- Linux desktop and setup configuration ---
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

export interface ProjectFolder {
  cwd: string;
  displayName: string;
}

export interface ProjectView {
  cwd: string;
  displayName: string;
  pinned: boolean;
  activityAt: string;
  defaultProviderId?: ProviderId;
  defaultAccountId: string | null;
  folders: ProjectFolder[];
}

export interface LiveView {
  activeTurnId: string | null;
  turnStartedAt: string | null;
  pendingApprovals: number;
  pendingInputs: number;
  lastTerminal: string | null;
  lastError: string | null;
  viewHealth?: { status: string; reason: string | null } | null;
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
  settled: boolean;
  settledAt: string | null;
  unsettledAt: string | null;
  sandboxDisabled: boolean | null;
  providerId?: ProviderId;
  capabilities?: ProviderCapabilities;
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
  durationMs?: number;
  resultRef?: string;
  usage?: TokenUsage;
}

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
  subagentId?: string;
  taskId?: string;
  workflowRunId?: string;
  entryId?: string;
  scriptId?: string;
  triggerSource?: string;
  childSessionId?: string;
  outputRef?: OutputRef;
  [key: string]: unknown;
}

export interface OutputRef {
  id: string;
  kind?: string;
  mediaType?: string;
  byteLen?: number;
  availability?: string;
}

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
  selection: {
    mode: "single" | "multiple" | string;
    minSelections?: number;
    maxSelections?: number;
  };
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
  cost: {
    input: number;
    output: number;
    cached: number;
    currency: string | null;
  } | null;
  contributor: boolean;
  efforts?: ReasoningEffort[] | null;
}

export interface ModelCatalogInfo {
  source: string | null;
  providerId: string | null;
  profileId: string | null;
  hostVersion: string | null;
}

export interface ModelCatalog extends ModelCatalogInfo {
  models: ModelOption[];
}

export interface ModelsStatus {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  loadedAt: number | null;
  catalog: ModelCatalogInfo | null;
}

export interface TitleSettings {
  enabled: boolean;
  modelId: string | null;
}

export interface SandboxSettings {
  disabled: boolean;
}

export interface YoloSettings {
  enabled: boolean;
}

export interface SkillEntry {
  id: string;
  name: string;
  displayName: string;
  description: string;
  shortDescription: string | null;
  scope: string;
  activation: string;
  argumentHint?: string | null;
}

export interface SkillCatalog {
  skills: SkillEntry[];
  error: string | null;
}

export interface DirectoryListing {
  directory: string;
  parent: string | null;
  separator: "/" | "\\";
  exists: boolean;
  entries: { name: string }[];
}

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

export interface UsageBucket {
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
  models?: Array<{
    modelId: string;
    calls: number;
    promptTokens: number;
    outputTokens: number;
    cachedTokens: number;
  }>;
  lastAt: string;
  kind?: "research";
  accountId?: string | null;
}

export interface UsageCoverage {
  countedThreads: number;
  partialThreads: number;
  uncountedThreads: number;
}

export interface UsageReport {
  since: string;
  days: number;
  tz?: string;
  buckets: UsageBucket[];
  threads: UsageThread[];
  coverage?: UsageCoverage;
}

export interface ViewEvent {
  method: string;
  params: Record<string, unknown>;
  at?: number;
}

export interface AttachmentView {
  id: string;
  turnId: string | null;
  name: string;
  mediaType: string;
  kind: "image" | "file";
  width: number | null;
  height: number | null;
  url: string;
}

export interface OutgoingAttachment {
  name: string;
  mediaType: string;
  base64: string;
  width?: number;
  height?: number;
}

export interface PlanWindow {
  usedPercent: number;
  resetsAtMs: number;
  windowDurationMins: number | null;
}

export interface PlanUsage {
  tier: string;
  observedAtMs: number;
  window: PlanWindow;
  weekly: PlanWindow;
}

export type PlanUsageByAccount = Record<string, PlanUsage>;
// Quota reading provenance status
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
// --- Account credential identification ---
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

export type FileKind = "text" | "markdown" | "image" | "video" | "audio" | "pdf" | "binary";

export interface FileEntry {
  name: string;
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
  mtimeMs: number;
  kind: FileKind;
  mediaType: string;
  content?: string;
  truncated: boolean;
}

export type GoalAction = "set" | "edit" | "pause" | "resume" | "clear";
export type SubagentAction = "interrupt" | "stop" | "close" | "resume" | "reopen" | "sendMessage" | "followupTask" | "readResult";
export type TaskAction = "background" | "stop" | "stopAll";
export type WorkflowAction = "cancel" | "skip" | "retry";

export interface TranscriptRuntimeState {
  status: string | null;
  activeTurnId: string | null;
  modelId: string | null;
  approvalMode: string | null;
  workspaceRoot: string | null;
  turnCount: number;
  contextUsage?: ContextUsage | null;
  tokenUsage?: TokenTotals | null;
}

export interface TranscriptLoad {
  session: SessionSummary | null;
  msp: TranscriptRuntimeState | null;
  events: ViewEvent[];
  truncated: boolean;
  attachments?: AttachmentView[];
  shellRuns?: ShellRun[];
  researchRuns?: ResearchRunView[];
  pending: { approvals: ApprovalRequest[]; userInputs: UserInputRequest[] };
  readOnly: boolean;
  readOnlyReason: string | null;
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

export interface ServerHelloEvent {
  type: "hello";
  version: string;
}

export interface ServerMspEvent {
  type: "msp";
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
  at: number;
}

export interface ServerSessionStatusEvent {
  type: "session-status";
  sessionId: string;
  live: LiveView | null;
}

export interface ServerSessionsChangedEvent {
  type: "sessions-changed";
}

export interface ServerShellRunEvent {
  type: "shell-run";
  sessionId: string;
  run: ShellRun;
}

export interface ServerResearchRunEvent {
  type: "research-run";
  sessionId: string;
  run: ResearchRunView;
}

export interface ServerPlanUsageEvent {
  type: "plan-usage";
  usage: PlanUsage;
  accountId: string | null;
}

export interface ServerProviderUsageEvent {
  type: "provider-usage";
  providerId: ProviderId;
  accountId: string | null;
  usage: PlanUsage;
}

export interface ServerLoginCompletedEvent {
  type: "login-completed";
  providerId: ProviderId;
  accountId: string | null;
}

export interface ServerHostEvent {
  type: "host";
  key: string;
  state: string;
  message: string;
}

export interface ServerConnectionEvent {
  type: "connection";
  state: "open" | "lost";
}

export type AncillaEvent =
  | AssistantEventView
  | ServerHelloEvent
  | ServerMspEvent
  | ServerSessionStatusEvent
  | ServerSessionsChangedEvent
  | ServerShellRunEvent
  | ServerResearchRunEvent
  | ServerPlanUsageEvent
  | ServerProviderUsageEvent
  | ServerLoginCompletedEvent
  | ServerHostEvent
  | ServerConnectionEvent;
