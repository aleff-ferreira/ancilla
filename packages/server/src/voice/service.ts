import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuthorizationHub } from "../assistant/launcher.js";
import type { AssistantService } from "../assistant/service.js";
import { makeBrain, makeBrowseBrain, type BrainContext, type BrainFactoryDeps, type ChosenBrain, type MuseExecRunner, type ResolvedApiAccount } from "./brains.js";
import type { BrainProvider, BrainRequest } from "./brain.js";
import type { MuseBrainHost } from "./muse-brain.js";
import { AssistantVoiceHost, TaskHub } from "./assistant-host.js";
import type { VoiceConnectors } from "./tools.js";
import type { HarnessReader } from "./harness.js";
import type { WorkspaceVoiceDeps } from "./workspace-tools.js";
import { ConversationStore } from "./conversations.js";
import type { Voice } from "./engines.js";
import { createRemoteEngines, createSherpaEngines, httpSpeechVoices, inspectPack, type PackReport, type SherpaEngineOptions, type SherpaEngineSet, type VoiceEngineSet, type VoicePackLayout } from "./engines/index.js";
import { InstallError, PackInstaller, type InstallerDeps, type PackJob } from "./installer.js";
import { supertonicVoices } from "./engines/tts.js";
import { summarize, type Summary } from "./metrics.js";
import type { ClientMessage, ServerMessage, TurnMetrics } from "./protocol.js";
import { serialize } from "./protocol.js";
import { systemScheduler, type Scheduler } from "./scheduler.js";
import { VoiceSession } from "./session.js";
import { VoiceSettingsStore, type BrainSetting, type VoiceSettings, type VoiceSettingsView } from "./settings.js";

function cliScopeOf(brain: BrainSetting): { providerId: string; accountId: string | null; model: string | null } | null {
  if (brain.kind === "muse") {
    return { providerId: "muse", accountId: brain.accountId ?? null, model: brain.model ?? null };
  }
  if (brain.kind === "provider" && brain.providerId !== "api") {
    return { providerId: brain.providerId, accountId: brain.accountId ?? null, model: brain.model ?? null };
  }
  return null;
}

/**
 * The voice as the server runs it: the models, which stay loaded between calls and are let go when nobody has called for
 * a while; the one call that may be open; the conversation it goes on from; the settings. The server hands it a socket
 * and the first message, and everything else, from the notes to the tasks, is wired here.
 */

export interface CallSocket {
  sendText(text: string): void;
  sendBinary(data: Buffer): void;
  close(code: number, reason: string): void;
}

export type HelloMessage = Extract<ClientMessage, { type: "hello" }>;

/** A call that is open, as the socket sees it. */
export interface CallHandle {
  onAudio(pcm: Int16Array): void;
  onMessage(message: ClientMessage): void;
  /** The socket is gone or the person hung up. */
  close(reason: string): Promise<void>;
  readonly id: string;
}

export class VoiceUnavailableError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "VoiceUnavailableError";
  }
}

export interface VoiceServiceDeps {
  /** The data folder, or ":memory:". */
  dataDir: string;
  assistant: (create: boolean) => AssistantService | null;
  log: (line: string) => void;
  /** What a Muse thread needs of the server, when this server has a Muse host to think in. */
  museHost?: MuseBrainHost | null;
  /** For tests: a model that stands in for Muse. */
  museBrain?: (context: BrainContext) => BrainProvider;
  /** The folder the person last worked in, for a task they start by voice when the call was not opened from a project. */
  lastProject?: () => string | null;
  /** The read-only view of the harness the call may look at. */
  harness?: HarnessReader | null;
  /** One `muse exec` through the server's routing, for the model that browses when it is Muse. */
  museExec?: MuseExecRunner | null;
  /** Resolves a saved `Settings -> Providers` API account for direct HTTP voice/browse brains. */
  resolveApiAccount?: (accountId: string | null) => ResolvedApiAccount | null;
  /** Display name for a provider and optional account. */
  providerName?: (providerId: string, accountId: string | null) => string;
  /** Default provider/account configured on a project folder when the assistant is set to Follow project. */
  projectDefault?: (cwd: string | null) => { providerId: string; accountId: string | null; modelId: string | null } | null;
  /** The assistant's own browser, which the `browse` tool starts web tasks on; without it the tool is not offered. */
  browse?: { available(): Promise<{ ok: boolean; reason?: string }> } | null;
  /** The connected accounts, which the `use_connector` tool starts tasks on; without any the tool is not offered. */
  connectors?: VoiceConnectors | null;
  /** Workspace inspection, authorized process/URL launching, and live page/animation diagnostics. */
  workspace?: WorkspaceVoiceDeps | null;
  /** Shared user authorization hub for inline call-card prompts. */
  authorizations?: AuthorizationHub | null;
  scheduler?: Scheduler;
  /** For tests: the engines, instead of the downloaded ones. */
  engineFactory?: (layout: VoicePackLayout, options: SherpaEngineOptions) => SherpaEngineSet;
  /** For tests: custom HTTP fetch for speech servers. */
  fetchImpl?: typeof fetch;
  /** How long the models stay loaded after the last call. */
  idleUnloadMs?: number;
  /** For tests: what the installer is given instead of its defaults. */
  installer?: Partial<InstallerDeps>;
}

export interface VoiceStatus {
  /** Everything a call cannot go without is installed. */
  available: boolean;
  pack: PackReport;
  layout: VoicePackLayout;
  engines: { loaded: boolean; asr: string | null; tts: string | null; sampleRate: number | null; loadMs: number | null };
  call: { active: boolean; id: string | null; conversation: string | null; since: number | null };
  settings: VoiceSettingsView;
  brain: { label: string; local: boolean; problem: string | null };
  voices: Voice[];
  latency: { turns: number; firstAudio: Summary; endpoint: Summary };
}

interface ActiveCall {
  id: string;
  conversation: string;
  since: number;
  session: VoiceSession;
  socket: CallSocket;
  ended: boolean;
}

const DEFAULT_IDLE_UNLOAD_MS = 10 * 60_000;
/** A conversation not touched for this long is not picked up again by a new call: it starts a new one (the notes carry on). */
const RESUME_WITHIN_MS = 8 * 3_600_000;
const KEEP_METRICS = 60;

export class VoiceService {
  readonly settings: VoiceSettingsStore;
  readonly hub = new TaskHub();
  private engines: VoiceEngineSet | null = null;
  private loading: Promise<VoiceEngineSet> | null = null;
  private stale = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private active: ActiveCall | null = null;
  private closed = false;
  private readonly recent: TurnMetrics[] = [];
  private readonly scheduler: Scheduler;
  readonly installer: PackInstaller;

  constructor(private readonly deps: VoiceServiceDeps) {
    this.settings = new VoiceSettingsStore(deps.dataDir === ":memory:" ? null : deps.dataDir, (line) => deps.log(line));
    this.scheduler = deps.scheduler ?? systemScheduler;
    this.installer = new PackInstaller({ dir: this.voiceDir(), log: (line) => deps.log(line), ...(deps.installer ?? {}) });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Installing the voice

  /** Starts downloading the voice. Refused where there is no data folder to put it in, or a call is open. */
  startInstall(options: { refine: boolean }): PackJob {
    if (this.deps.dataDir === ":memory:" && !this.deps.installer?.dir) throw new VoiceUnavailableError("There is no data folder here, so the voice cannot be installed.");
    try {
      this.installer.start(options);
    } catch (error) {
      if (error instanceof InstallError) throw new VoiceUnavailableError(error.message);
      throw error;
    }
    // When it is done the models that were loaded (if any) are stale: the next call loads what was just installed.
    void this.installer.settled().then((job) => {
      if (job.state === "done") {
        this.stale = true;
        if (this.active === null) void this.unload();
      }
    });
    return this.installer.job();
  }

  async removePack(): Promise<void> {
    if (this.active) throw new VoiceUnavailableError("End the call first.");
    await this.unload();
    try {
      await this.installer.remove();
    } catch (error) {
      if (error instanceof InstallError) throw new VoiceUnavailableError(error.message);
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // What is installed

  private voiceDir(): string {
    return join(this.deps.dataDir === ":memory:" ? "." : this.deps.dataDir, "voice");
  }

  layout(): VoicePackLayout {
    const s = this.settings.get();
    const bundled = join(this.voiceDir(), "runtime");
    const runtimeDir = s.runtimeDir ?? (existsSync(join(bundled, "node_modules", "sherpa-onnx-node", "package.json")) ? bundled : null);
    return { runtimeDir, modelsDir: s.modelsDir ?? join(this.voiceDir(), "models") };
  }

  /**
   * Resolves the active voice settings against the Assistant profile's unified model preference whenever the voice brain is
   * set to follow the assistant (`kind === "assistant"`) or left at its untouched default (`{ kind: "muse", model: null }`).
   */
  effectiveSettings(projectHint?: string | null): VoiceSettings {
    const raw = this.settings.get();
    if (
      raw.brain.kind === "assistant" ||
      (raw.brain.kind === "muse" && raw.brain.model === null && !raw.brain.accountId)
    ) {
      const pref = this.deps.assistant(false)?.store.getProfile().model ?? null;
      const targetProject =
        projectHint ?? raw.defaultProject ?? this.deps.lastProject?.() ?? this.deps.workspace?.projects()[0]?.cwd ?? null;
      const resolved =
        pref && pref.providerId !== null
          ? pref
          : (this.deps.projectDefault?.(targetProject) ?? null);
      if (resolved && resolved.providerId !== null) {
        if (resolved.providerId === "muse") {
          return {
            ...raw,
            brain: resolved.accountId
              ? { kind: "muse", model: resolved.modelId, accountId: resolved.accountId }
              : { kind: "muse", model: resolved.modelId },
          };
        }
        return {
          ...raw,
          brain: {
            kind: "provider",
            providerId: resolved.providerId,
            accountId: resolved.accountId,
            model: resolved.modelId,
          },
        };
      }
      if (raw.brain.kind === "assistant") {
        return { ...raw, brain: { kind: "muse", model: null } };
      }
    }
    return raw;
  }

  status(): VoiceStatus {
    const layout = this.layout();
    const pack = inspectPack(layout);
    const settings = this.settings.view();
    const project = settings.defaultProject ?? this.deps.lastProject?.() ?? this.deps.workspace?.projects()[0]?.cwd ?? null;
    const effective = this.effectiveSettings(project);
    const chosen = makeBrain(
      effective,
      {
        project,
        name: "Assistant",
        museSession: null,
        rememberMuseSession: () => undefined,
      },
      this.brainDeps(),
    );
    const asr = this.engines?.engines.asr;
    const tts = this.engines?.engines.tts;
    const remoteReady = settings.speech.kind === "http" && (settings.speech.local || settings.hasSpeechKey);
    return {
      available: settings.speech.kind === "http" ? remoteReady : pack.ready,
      pack,
      layout,
      engines: { loaded: this.engines !== null, asr: asr?.id ?? null, tts: tts?.id ?? null, sampleRate: tts?.sampleRate ?? null, loadMs: null },
      call: { active: this.active !== null, id: this.active?.id ?? null, conversation: this.active?.conversation ?? null, since: this.active?.since ?? null },
      settings,
      brain: { label: chosen.brain.label, local: chosen.brain.capabilities.local, problem: chosen.problem },
      voices: settings.speech.kind === "http" ? httpSpeechVoices() : pack.tts ? supertonicVoices() : [],
      latency: {
        turns: this.recent.length,
        firstAudio: summarize(this.recent.map((m) => m.firstAudioMs).filter((x): x is number => x !== null)),
        endpoint: summarize(this.recent.map((m) => m.endpointMs).filter((x): x is number => x !== null)),
      },
    };
  }

  private brainDeps(): BrainFactoryDeps {
    return {
      museHost: this.deps.museHost ?? null,
      muse: this.deps.museBrain ?? null,
      keyFor: (b) => this.settings.keyFor(b),
      resolveApiAccount: this.deps.resolveApiAccount,
      providerName: this.deps.providerName,
    };
  }

  /** The model that browses for the assistant: the voice's own, used with the browser's tools only (see browser/agent.ts). */
  browseBrain(): ChosenBrain {
    return makeBrowseBrain(this.effectiveSettings(), {
      keyFor: (b) => this.settings.keyFor(b),
      museExec: this.deps.museExec ?? null,
      resolveApiAccount: this.deps.resolveApiAccount,
      providerName: this.deps.providerName,
      log: this.deps.log,
    });
  }

  /** What the model of a call is told about it. Used by the settings page's test as well. */
  brainFor(project: string | null) {
    return makeBrain(this.effectiveSettings(project), { project, name: "Assistant", museSession: null, rememberMuseSession: () => undefined }, this.brainDeps());
  }

  /** Applies a change from the page. Engines that were built with the old settings are rebuilt for the next call. */
  updateSettings(patch: unknown): VoiceSettingsView {
    const before = this.settings.get();
    const view = this.settings.update(patch);
    const after = this.settings.get();
    if (
      before.refine !== after.refine ||
      before.ttsSteps !== after.ttsSteps ||
      before.runtimeDir !== after.runtimeDir ||
      before.modelsDir !== after.modelsDir ||
      JSON.stringify(before.speech) !== JSON.stringify(after.speech)
    ) {
      this.stale = true;
      if (this.active === null) void this.unload();
    }
    return view;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The models

  private async build(): Promise<VoiceEngineSet> {
    const s = this.settings.get();
    if (s.speech.kind === "http") {
      const set = createRemoteEngines({
        baseUrl: s.speech.baseUrl,
        sttModel: s.speech.sttModel,
        ttsModel: s.speech.ttsModel,
        apiKey: () => this.settings.speechKeyFor(),
        fetchImpl: this.deps.fetchImpl,
        log: (line) => this.deps.log(`voice: ${line}`),
      });
      await Promise.all([set.engines.asr.warm?.(), set.engines.tts.warm?.()]);
      return set;
    }
    const options: SherpaEngineOptions = { refine: s.refine, ttsSteps: s.ttsSteps, log: (line) => this.deps.log(`voice: ${line}`) };
    const layout = this.layout();
    const set = (this.deps.engineFactory ?? createSherpaEngines)(layout, options);
    await Promise.all([set.engines.asr.warm?.(), set.engines.tts.warm?.()]);
    return set;
  }

  /** The loaded engines, loading them first if need be. A pack that is not all there is a plain explanation, not a crash. */
  async ensureEngines(): Promise<VoiceEngineSet> {
    if (this.closed) throw new VoiceUnavailableError("Ancilla is shutting down.", 503);
    this.cancelIdle();
    if (this.engines && !this.stale) return this.engines;
    if (this.engines && this.stale && this.active === null) await this.unload();
    if (!this.engines && !this.loading) {
      const s = this.settings.get();
      if (s.speech.kind === "http") {
        if (!s.speech.local && this.settings.speechKeyFor() === null) {
          throw new VoiceUnavailableError("The speech server needs an API key. Add one in Settings, Voice.");
        }
      } else {
        // An injected factory (a test) brings its own engines; the downloaded ones must all be there.
        const report = this.deps.engineFactory ? null : inspectPack(this.layout());
        if (report && !report.ready) throw new VoiceUnavailableError(`The voice is not installed yet: ${report.missing.join(", ")} missing. Install it in Settings, Voice.`);
      }
      this.loading = this.build()
        .then((set) => {
          this.engines = set;
          this.stale = false;
          return set;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return (this.engines ?? this.loading) as Promise<VoiceEngineSet>;
  }

  /** Loads the models ahead of a call, so that the first words are not the slowest. Never throws. */
  async prewarm(): Promise<void> {
    try {
      await this.ensureEngines();
      // A call may never follow: the models are let go after the idle time, as they are after a call.
      if (this.active === null && !this.closed) this.scheduleUnload();
    } catch (error) {
      this.deps.log(`voice: warming the models failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleUnload(): void {
    this.cancelIdle();
    const wait = this.deps.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS;
    this.idleTimer = setTimeout(() => void this.unload(), wait);
    this.idleTimer.unref?.();
  }

  private async unload(): Promise<void> {
    this.cancelIdle();
    if (this.active !== null) return;
    const set = this.engines;
    this.engines = null;
    if (set) {
      try {
        await set.dispose();
      } catch (error) {
        this.deps.log(`voice: the models would not unload: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Conversations

  conversations(create = false): ConversationStore | null {
    const assistant = this.deps.assistant(create);
    return assistant ? new ConversationStore(assistant.store) : null;
  }

  /** Deletes conversations older than the retention the person chose. Called when a call opens; cheap. */
  private expire(store: ConversationStore): void {
    const days = this.settings.get().keepDays;
    if (days === null) return;
    try {
      const gone = store.purge(Date.now() - days * 86_400_000);
      if (gone > 0) this.deps.log(`voice: ${gone} conversation${gone === 1 ? "" : "s"} older than ${days} days were deleted`);
    } catch (error) {
      this.deps.log(`voice: old conversations could not be deleted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // A call

  /** Opens a call on `socket`. Another call that is open is ended: a person has one voice, and a reloaded page is the same person. */
  async attach(socket: CallSocket, hello: HelloMessage): Promise<CallHandle> {
    if (this.closed) throw new VoiceUnavailableError("Ancilla is shutting down.", 503);
    const assistant = this.deps.assistant(true);
    if (!assistant) throw new VoiceUnavailableError("The assistant's memory could not be opened, so the voice cannot start.", 503);
    if (this.active) await this.endCall(this.active, "another window took the call over");
    const set = await this.ensureEngines();
    const store = new ConversationStore(assistant.store);
    this.expire(store);
    const settings = this.settings.get();
    const project = hello.project ?? settings.defaultProject ?? this.deps.lastProject?.() ?? this.deps.workspace?.projects()[0]?.cwd ?? null;
    const latest = store.latest();
    const conversation =
      hello.thread && store.exists(hello.thread) ? hello.thread : latest && Date.now() - latest.updatedAt < RESUME_WITHIN_MS ? latest.id : store.create(project);
    const host = new AssistantVoiceHost({
      assistant,
      conversations: store,
      conversationId: conversation,
      settings: () => this.effectiveSettings(project),
      hub: this.hub,
      project: () => project,
      harness: this.deps.harness ?? null,
      ...(this.deps.browse ? { browse: this.deps.browse } : {}),
      ...(this.deps.connectors ? { connectors: this.deps.connectors } : {}),
      ...(this.deps.workspace ? { workspace: this.deps.workspace } : {}),
      ...(this.deps.authorizations ? { authorizations: this.deps.authorizations } : {}),
      log: (line) => this.deps.log(line),
    });
    let activeSettings = this.effectiveSettings(project);
    let activeSig = JSON.stringify(activeSettings.brain);
    let activeChosen = makeBrain(
      activeSettings,
      { project, name: assistant.store.getProfile().name, museSession: store.museSession(conversation), rememberMuseSession: (sessionId) => store.setMuseSession(conversation, sessionId) },
      this.brainDeps(),
    );
    let pendingHttpSwitchLabel: string | null = null;
    const self = this;
    const liveBrain: BrainProvider = {
      get id() {
        return activeChosen.brain.id;
      },
      get label() {
        return activeChosen.brain.label;
      },
      get capabilities() {
        return activeChosen.brain.capabilities;
      },
      stream: async function* (request: BrainRequest) {
        const lastMsg = request.messages[request.messages.length - 1];
        const isNewTurn = !lastMsg || lastMsg.role !== "tool";
        if (isNewTurn) {
          const latestSettings = self.effectiveSettings(project);
          const latestSig = JSON.stringify(latestSettings.brain);
          if (latestSig !== activeSig) {
            const prevCli = cliScopeOf(activeSettings.brain);
            const nextCli = cliScopeOf(latestSettings.brain);
            if (
              prevCli &&
              nextCli &&
              prevCli.providerId === nextCli.providerId &&
              prevCli.accountId === nextCli.accountId &&
              activeChosen.thread
            ) {
              activeChosen.thread.switchModel(nextCli.model);
              activeSettings = latestSettings;
              activeSig = latestSig;
              self.deps.log(`voice: switched live call model on ${nextCli.providerId} to ${nextCli.model ?? "default"}`);
            } else {
              const nextChosen = makeBrain(
                latestSettings,
                {
                  project,
                  name: assistant.store.getProfile().name,
                  museSession: null,
                  rememberMuseSession: (sessionId) => store.setMuseSession(conversation, sessionId),
                },
                self.brainDeps(),
              );
              activeChosen = nextChosen;
              activeSettings = latestSettings;
              activeSig = latestSig;
              if (nextChosen.thread) {
                nextChosen.thread.announceInitialSwitch(nextChosen.brain.label);
              } else {
                pendingHttpSwitchLabel = nextChosen.brain.label;
              }
              if (nextChosen.problem) {
                socket.sendText(serialize({ type: "notice", level: "warn", text: nextChosen.problem }));
              }
              self.deps.log(`voice: switched live call brain to ${nextChosen.brain.label}`);
            }
          }
        }
        let effectiveRequest = request;
        if (pendingHttpSwitchLabel !== null && isNewTurn) {
          const switchedTo = pendingHttpSwitchLabel;
          pendingHttpSwitchLabel = null;
          const note = `(System note: The user just switched your active model for this conversation to ${switchedTo}. Answer from your current model identity and do not repeat any previous model name mentioned in earlier turns.)`;
          effectiveRequest = {
            ...request,
            messages: request.messages.map((m, idx) =>
              idx === 0 && m.role === "system" ? { ...m, content: `${m.content}\n\n${note}` } : m,
            ),
          };
        }
        yield* activeChosen.brain.stream(effectiveRequest);
      },
    };
    const id = `call-${randomUUID().slice(0, 8)}`;
    // The person can hang up from the screen ("end"), which closes the session from inside: the socket and the service follow.
    let opened: ActiveCall | null = null;
    const session = new VoiceSession({
      engines: set.engines,
      brain: liveBrain,
      host,
      scheduler: this.scheduler,
      send: (message: ServerMessage) => {
        if (message.type === "metrics") this.noteMetrics(message.metrics);
        socket.sendText(serialize(message));
      },
      sendAudio: (frame) => socket.sendBinary(frame),
      log: (line) => this.deps.log(`voice: ${line}`),
      config: { speed: settings.speed, debug: process.env["ANCILLA_VOICE_DEBUG"] === "1" },
      id,
      onClosed: (reason) => {
        if (opened) void this.endCall(opened, reason);
      },
    });
    const call: ActiveCall = { id, conversation, since: Date.now(), session, socket, ended: false };
    opened = call;
    this.active = call;
    try {
      await session.start({ ...hello, mode: hello.mode, thread: conversation });
    } catch (error) {
      await this.endCall(call, "the call could not start");
      throw error;
    }
    if (activeChosen.problem) socket.sendText(serialize({ type: "notice", level: "warn", text: activeChosen.problem }));
    return {
      id,
      onAudio: (pcm) => session.onAudio(pcm),
      onMessage: (message) => session.onMessage(message),
      close: (reason) => this.endCall(call, reason),
    };
  }

  private async endCall(call: ActiveCall, reason: string): Promise<void> {
    if (call.ended) return;
    call.ended = true;
    try {
      await call.session.close(reason);
    } catch (error) {
      this.deps.log(`voice: closing the call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      call.socket.close(1000, reason.slice(0, 120));
    } catch {
      /* the socket may be gone already */
    }
    if (this.active === call) {
      this.active = null;
      if (!this.closed) this.scheduleUnload();
    }
  }

  private noteMetrics(metrics: TurnMetrics): void {
    this.recent.push(metrics);
    if (this.recent.length > KEEP_METRICS) this.recent.shift();
  }

  recentMetrics(): TurnMetrics[] {
    return [...this.recent];
  }

  /** Ends the open call and lets go of the models. */
  async close(): Promise<void> {
    this.closed = true;
    this.cancelIdle();
    if (this.active) await this.endCall(this.active, "Ancilla is shutting down");
    const set = this.engines;
    this.engines = null;
    if (set) await set.dispose().catch(() => undefined);
  }
}
