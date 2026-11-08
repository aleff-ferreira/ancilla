import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AssistantService } from "../assistant/service.js";
import { makeBrain, type BrainContext, type BrainFactoryDeps } from "./brains.js";
import type { BrainProvider } from "./brain.js";
import type { MuseBrainHost } from "./muse-brain.js";
import { AssistantVoiceHost, TaskHub } from "./assistant-host.js";
import { ConversationStore } from "./conversations.js";
import type { Voice } from "./engines.js";
import { createSherpaEngines, inspectPack, type PackReport, type SherpaEngineOptions, type SherpaEngineSet, type VoicePackLayout } from "./engines/index.js";
import { InstallError, PackInstaller, type InstallerDeps, type PackJob } from "./installer.js";
import { supertonicVoices } from "./engines/tts.js";
import { summarize, type Summary } from "./metrics.js";
import type { ClientMessage, ServerMessage, TurnMetrics } from "./protocol.js";
import { serialize } from "./protocol.js";
import { systemScheduler, type Scheduler } from "./scheduler.js";
import { VoiceSession } from "./session.js";
import { VoiceSettingsStore, type VoiceSettingsView } from "./settings.js";

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
  scheduler?: Scheduler;
  /** For tests: the engines, instead of the downloaded ones. */
  engineFactory?: (layout: VoicePackLayout, options: SherpaEngineOptions) => SherpaEngineSet;
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
  private engines: SherpaEngineSet | null = null;
  private loading: Promise<SherpaEngineSet> | null = null;
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

  status(): VoiceStatus {
    const layout = this.layout();
    const pack = inspectPack(layout);
    const settings = this.settings.view();
    const chosen = makeBrain(settings, { project: settings.defaultProject ?? this.deps.lastProject?.() ?? null, name: "Assistant", museSession: null, rememberMuseSession: () => undefined }, this.brainDeps());
    const asr = this.engines?.engines.asr;
    const tts = this.engines?.engines.tts;
    return {
      available: pack.ready,
      pack,
      layout,
      engines: { loaded: this.engines !== null, asr: asr?.id ?? null, tts: tts?.id ?? null, sampleRate: tts?.sampleRate ?? null, loadMs: null },
      call: { active: this.active !== null, id: this.active?.id ?? null, conversation: this.active?.conversation ?? null, since: this.active?.since ?? null },
      settings,
      brain: { label: chosen.brain.label, local: chosen.brain.capabilities.local, problem: chosen.problem },
      voices: pack.tts ? supertonicVoices() : [],
      latency: {
        turns: this.recent.length,
        firstAudio: summarize(this.recent.map((m) => m.firstAudioMs).filter((x): x is number => x !== null)),
        endpoint: summarize(this.recent.map((m) => m.endpointMs).filter((x): x is number => x !== null)),
      },
    };
  }

  private brainDeps(): BrainFactoryDeps {
    return { museHost: this.deps.museHost ?? null, muse: this.deps.museBrain ?? null, keyFor: (b) => this.settings.keyFor(b) };
  }

  /** What the model of a call is told about it. Used by the settings page's test as well. */
  brainFor(project: string | null) {
    return makeBrain(this.settings.get(), { project, name: "Assistant", museSession: null, rememberMuseSession: () => undefined }, this.brainDeps());
  }

  /** Applies a change from the page. Engines that were built with the old settings are rebuilt for the next call. */
  updateSettings(patch: unknown): VoiceSettingsView {
    const before = this.settings.get();
    const view = this.settings.update(patch);
    const after = this.settings.get();
    if (before.refine !== after.refine || before.ttsSteps !== after.ttsSteps || before.runtimeDir !== after.runtimeDir || before.modelsDir !== after.modelsDir) {
      this.stale = true;
      if (this.active === null) void this.unload();
    }
    return view;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The models

  private async build(): Promise<SherpaEngineSet> {
    const s = this.settings.get();
    const options: SherpaEngineOptions = { refine: s.refine, ttsSteps: s.ttsSteps, log: (line) => this.deps.log(`voice: ${line}`) };
    const layout = this.layout();
    const set = (this.deps.engineFactory ?? createSherpaEngines)(layout, options);
    await Promise.all([set.engines.asr.warm?.(), set.engines.tts.warm?.()]);
    return set;
  }

  /** The loaded engines, loading them first if need be. A pack that is not all there is a plain explanation, not a crash. */
  async ensureEngines(): Promise<SherpaEngineSet> {
    if (this.closed) throw new VoiceUnavailableError("Ancilla is shutting down.", 503);
    this.cancelIdle();
    if (this.engines && !this.stale) return this.engines;
    if (this.engines && this.stale && this.active === null) await this.unload();
    if (!this.engines && !this.loading) {
      // An injected factory (a test) brings its own engines; the downloaded ones must all be there.
      const report = this.deps.engineFactory ? null : inspectPack(this.layout());
      if (report && !report.ready) throw new VoiceUnavailableError(`The voice is not installed yet: ${report.missing.join(", ")} missing. Install it in Settings, Voice.`);
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
    return (this.engines ?? this.loading) as Promise<SherpaEngineSet>;
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
    const project = hello.project ?? settings.defaultProject ?? this.deps.lastProject?.() ?? null;
    const latest = store.latest();
    const conversation =
      hello.thread && store.exists(hello.thread) ? hello.thread : latest && Date.now() - latest.updatedAt < RESUME_WITHIN_MS ? latest.id : store.create(project);
    const host = new AssistantVoiceHost({
      assistant,
      conversations: store,
      conversationId: conversation,
      settings: () => this.settings.get(),
      hub: this.hub,
      project: () => project,
      log: (line) => this.deps.log(line),
    });
    const chosen = makeBrain(
      settings,
      { project, name: assistant.store.getProfile().name, museSession: store.museSession(conversation), rememberMuseSession: (sessionId) => store.setMuseSession(conversation, sessionId) },
      this.brainDeps(),
    );
    const id = `call-${randomUUID().slice(0, 8)}`;
    // The person can hang up from the screen ("end"), which closes the session from inside: the socket and the service follow.
    let opened: ActiveCall | null = null;
    const session = new VoiceSession({
      engines: set.engines,
      brain: chosen.brain,
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
    if (chosen.problem) socket.sendText(serialize({ type: "notice", level: "warn", text: chosen.problem }));
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
