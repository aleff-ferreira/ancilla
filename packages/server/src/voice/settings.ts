import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ValidationError } from "../assistant/profile.js";

/**
 * How the voice is set up: which model answers, which voice speaks, how the call listens. Kept in one small file in the
 * data folder. A key for a hosted model is kept apart, in a file only the user can read, and is never sent back to the
 * page: the settings it gets say whether a key is set, not what it is.
 */

export type CallModeSetting = "hands-free" | "push-to-talk";

export type BrainSetting =
  /**
   * Muse, through a thread: works with a Muse subscription and no key, at the speed of a Muse turn. `model` is the Muse model
   * a new thread starts on and a thread of the conversation is put on; null leaves it to Muse's own choice.
   */
  | { kind: "muse"; model: string | null }
  /** Any server that speaks the OpenAI chat protocol: a hosted model with a key, or one running on this machine. */
  | { kind: "openai"; baseUrl: string; model: string; local: boolean; label: string | null; apiKeyEnv: string | null }
  /** Any server that speaks the Messages API (`/v1/messages`): Anthropic, or a compatible server. */
  | { kind: "anthropic"; baseUrl: string; model: string; local: boolean; label: string | null; apiKeyEnv: string | null }
  /** Google Gemini / Generative Language API (`/v1beta/models/...:streamGenerateContent`). */
  | { kind: "google"; baseUrl: string; model: string; local: boolean; label: string | null; apiKeyEnv: string | null }
  /** No model: the call can be opened to be set up, and says so. */
  | { kind: "none" };

export type SpeechSetting =
  /** Native sherpa-onnx pack on this machine (Silero VAD + Nemotron/Parakeet ASR + Supertonic TTS). */
  | { kind: "local" }
  /** Zero-download HTTP speech endpoints (`/audio/transcriptions` + `/audio/speech`, local or hosted). */
  | { kind: "http"; baseUrl: string; sttModel: string; ttsModel: string; local: boolean; apiKeyEnv: string | null };

export interface VoiceSettings {
  mode: CallModeSetting;
  /** An engine voice (such as "en:F2" or "en:nova"), or null to pick one that speaks the language being spoken. */
  voice: string | null;
  speed: number;
  /** Read each turn again with the accurate model when it is installed. */
  refine: boolean;
  /** Denoising steps of the voice: fewer is quicker and rougher (measured: 3 hears back at 7% error, 4 at 2%, 5 at 1.7%). */
  ttsSteps: number;
  brain: BrainSetting;
  speech: SpeechSetting;
  /** The assistant may say something unprompted, in a lull, when a task needs the person or finishes. */
  proactive: boolean;
  /** How many days a conversation is kept; null keeps them until they are deleted. */
  keepDays: number | null;
  /** Where the downloaded engines and models are, when not in the data folder. */
  runtimeDir: string | null;
  modelsDir: string | null;
  /** The folder a spoken task is started in, when the call was not opened from a project. */
  defaultProject: string | null;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  mode: "hands-free",
  voice: null,
  speed: 1,
  refine: true,
  ttsSteps: 4,
  brain: { kind: "muse", model: null },
  speech: { kind: "local" },
  proactive: true,
  keepDays: null,
  runtimeDir: null,
  modelsDir: null,
  defaultProject: null,
};

export const VOICE_SETTINGS_FILE = "voice.json";
export const VOICE_SECRETS_FILE = "voice-secrets.json";

/** A file as text, without the byte-order mark that some Windows editors and tools put in front of it, which JSON does not allow. */
function readText(path: string): string {
  return readFileSync(path, "utf8").replace(/^﻿/, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new ValidationError(field, `${field} must be a number from ${min} to ${max}`);
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new ValidationError(field, `${field} must be text of at most ${max} characters`);
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(value, field, max);
}

/** What a Muse model id looks like: the same shape the page accepts when a model is typed by hand. */
const MUSE_MODEL_ID = /^[A-Za-z0-9][\w.:-]*$/;

function museModel(value: unknown): string | null {
  const id = optionalText(value, "brain.model", 100)?.trim() ?? "";
  if (id === "") return null;
  if (!MUSE_MODEL_ID.test(id)) throw new ValidationError("brain.model", "brain.model must be a model id: letters, digits and . _ : - only");
  return id;
}

/** `current` is the brain that is set now, for a change that says nothing about a model and must not undo the one chosen. */
function parseBrain(value: unknown, current: BrainSetting | null = null): BrainSetting {
  if (!isObject(value)) throw new ValidationError("brain", "brain must be an object");
  if (value["kind"] === "muse") return { kind: "muse", model: "model" in value ? museModel(value["model"]) : current?.kind === "muse" ? current.model : null };
  if (value["kind"] === "none") return { kind: "none" };
  if (value["kind"] === "openai" || value["kind"] === "anthropic" || value["kind"] === "google") {
    const kind = value["kind"];
    const rawBase =
      value["baseUrl"] === undefined && kind === "anthropic"
        ? "https://api.anthropic.com/v1"
        : value["baseUrl"] === undefined && kind === "google"
          ? "https://generativelanguage.googleapis.com/v1beta"
          : value["baseUrl"];
    const baseUrl = text(rawBase, "brain.baseUrl", 300).trim();
    if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) throw new ValidationError("brain.baseUrl", "brain.baseUrl must be an http or https address");
    const model = text(value["model"], "brain.model", 200).trim();
    if (model === "") throw new ValidationError("brain.model", "brain.model must name a model");
    const apiKeyEnv = optionalText(value["apiKeyEnv"], "brain.apiKeyEnv", 100);
    if (apiKeyEnv !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new ValidationError("brain.apiKeyEnv", "brain.apiKeyEnv must be the name of an environment variable");
    return { kind, baseUrl, model, local: value["local"] === true, label: optionalText(value["label"], "brain.label", 80), apiKeyEnv };
  }
  throw new ValidationError("brain.kind", "brain.kind must be muse, openai, anthropic, google or none");
}

function parseSpeech(value: unknown): SpeechSetting {
  if (!isObject(value)) throw new ValidationError("speech", "speech must be an object");
  if (value["kind"] === "local") return { kind: "local" };
  if (value["kind"] === "http") {
    const baseUrl = text(value["baseUrl"], "speech.baseUrl", 300).trim();
    if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) throw new ValidationError("speech.baseUrl", "speech.baseUrl must be an http or https address");
    const sttModel = text(value["sttModel"], "speech.sttModel", 200).trim();
    if (sttModel === "") throw new ValidationError("speech.sttModel", "speech.sttModel must name a speech-to-text model");
    const ttsModel = text(value["ttsModel"], "speech.ttsModel", 200).trim();
    if (ttsModel === "") throw new ValidationError("speech.ttsModel", "speech.ttsModel must name a text-to-speech model");
    const apiKeyEnv = optionalText(value["apiKeyEnv"], "speech.apiKeyEnv", 100);
    if (apiKeyEnv !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new ValidationError("speech.apiKeyEnv", "speech.apiKeyEnv must be the name of an environment variable");
    }
    return { kind: "http", baseUrl, sttModel, ttsModel, local: value["local"] === true, apiKeyEnv };
  }
  throw new ValidationError("speech.kind", "speech.kind must be local or http");
}

/** Reads settings from untrusted text (a file, or a patch from the page): a field that is not valid is an error, one that is missing keeps its value. */
export function applySettingsPatch(current: VoiceSettings, raw: unknown): VoiceSettings {
  if (!isObject(raw)) throw new ValidationError("settings", "settings must be an object");
  const known = ["mode", "voice", "speed", "refine", "ttsSteps", "brain", "speech", "proactive", "keepDays", "runtimeDir", "modelsDir", "defaultProject", "apiKey", "speechKey"];
  for (const key of Object.keys(raw)) if (!known.includes(key)) throw new ValidationError(key, `unknown setting ${key}`);
  const next: VoiceSettings = { ...current };
  if ("mode" in raw) {
    if (raw["mode"] !== "hands-free" && raw["mode"] !== "push-to-talk") throw new ValidationError("mode", "mode must be hands-free or push-to-talk");
    next.mode = raw["mode"];
  }
  if ("voice" in raw) {
    const voice = optionalText(raw["voice"], "voice", 40);
    if (voice !== null && !/^[a-z]{2}:[A-Za-z0-9_-]{1,24}$/.test(voice)) throw new ValidationError("voice", "voice must look like en:F2 or en:nova");
    next.voice = voice;
  }
  if ("speed" in raw) next.speed = number(raw["speed"], "speed", 0.6, 1.6, current.speed);
  if ("refine" in raw) next.refine = raw["refine"] === true;
  // Two steps is fast and unintelligible (half the words are lost when the speech is read back), so three is the least.
  if ("ttsSteps" in raw) next.ttsSteps = Math.round(number(raw["ttsSteps"], "ttsSteps", 3, 8, current.ttsSteps));
  if ("brain" in raw) next.brain = parseBrain(raw["brain"], current.brain);
  if ("speech" in raw) next.speech = parseSpeech(raw["speech"]);
  if ("proactive" in raw) next.proactive = raw["proactive"] === true;
  if ("keepDays" in raw) next.keepDays = raw["keepDays"] === null ? null : Math.round(number(raw["keepDays"], "keepDays", 1, 3650, 30));
  if ("runtimeDir" in raw) next.runtimeDir = optionalText(raw["runtimeDir"], "runtimeDir", 500);
  if ("modelsDir" in raw) next.modelsDir = optionalText(raw["modelsDir"], "modelsDir", 500);
  if ("defaultProject" in raw) next.defaultProject = optionalText(raw["defaultProject"], "defaultProject", 500);
  return next;
}

/** The settings as the page may see them. */
export interface VoiceSettingsView extends VoiceSettings {
  /** A key is set for the model in `brain`. */
  hasKey: boolean;
  /** A key is set (or shared with `brain`) for the HTTP speech server in `speech`. */
  hasSpeechKey: boolean;
}

export class VoiceSettingsStore {
  private settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS };
  private secrets: Record<string, string> = {};

  constructor(
    private readonly dir: string | null,
    private readonly log: (line: string) => void = () => undefined,
  ) {
    this.load();
  }

  private pathOf(file: string): string | null {
    return this.dir === null || this.dir === ":memory:" ? null : join(this.dir, file);
  }

  private load(): void {
    const settingsPath = this.pathOf(VOICE_SETTINGS_FILE);
    if (settingsPath && existsSync(settingsPath)) {
      try {
        const raw = JSON.parse(readText(settingsPath)) as unknown;
        if (isObject(raw)) this.settings = applySettingsPatch({ ...DEFAULT_VOICE_SETTINGS }, { ...raw, apiKey: undefined, speechKey: undefined });
      } catch (error) {
        this.log(`voice: the settings file could not be read, so the defaults are used: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const secretsPath = this.pathOf(VOICE_SECRETS_FILE);
    if (secretsPath && existsSync(secretsPath)) {
      try {
        const raw = JSON.parse(readText(secretsPath)) as unknown;
        if (isObject(raw)) for (const [key, value] of Object.entries(raw)) if (typeof value === "string") this.secrets[key] = value;
      } catch {
        this.log("voice: the keys file could not be read, so no key is set");
      }
    }
  }

  get(): VoiceSettings {
    return this.settings;
  }

  /** What identifies a model for its key: the same address and model name share one. */
  private keyOf(brain: BrainSetting): string | null {
    if (brain.kind === "openai") return `${brain.baseUrl.replace(/\/+$/, "")}|${brain.model}`;
    if (brain.kind === "anthropic") return `anthropic:${brain.baseUrl.replace(/\/+$/, "")}|${brain.model}`;
    if (brain.kind === "google") return `google:${brain.baseUrl.replace(/\/+$/, "")}|${brain.model}`;
    return null;
  }

  private speechKeyOf(speech: SpeechSetting): string | null {
    return speech.kind === "http" ? `speech:${speech.baseUrl.replace(/\/+$/, "")}` : null;
  }

  /** The key for the model in use: the one saved, or the one in the environment variable the settings name. */
  keyFor(brain: BrainSetting): string | null {
    if (brain.kind !== "openai" && brain.kind !== "anthropic" && brain.kind !== "google") return null;
    const saved = this.secrets[this.keyOf(brain) as string];
    if (saved) return saved;
    if (brain.apiKeyEnv) {
      const fromEnv = process.env[brain.apiKeyEnv];
      if (fromEnv) return fromEnv;
    }
    return null;
  }

  /** The key for an HTTP speech server: its own saved key, its environment variable, or the brain's key when at the same address. */
  speechKeyFor(speech: SpeechSetting = this.settings.speech, brain: BrainSetting = this.settings.brain): string | null {
    if (speech.kind !== "http") return null;
    const saved = this.secrets[this.speechKeyOf(speech) as string];
    if (saved) return saved;
    if (speech.apiKeyEnv) {
      const fromEnv = process.env[speech.apiKeyEnv];
      if (fromEnv) return fromEnv;
    }
    if (brain.kind === "openai" && brain.baseUrl.replace(/\/+$/, "") === speech.baseUrl.replace(/\/+$/, "")) {
      return this.keyFor(brain);
    }
    return null;
  }

  view(): VoiceSettingsView {
    return {
      ...this.settings,
      hasKey: this.keyFor(this.settings.brain) !== null,
      hasSpeechKey: this.speechKeyFor(this.settings.speech, this.settings.brain) !== null,
    };
  }

  /**
   * Applies a change from the page. A key in it is saved apart and not kept in the settings. The folders the engines are
   * loaded from are not the page's to set: the server loads native code from them, so they are changed in the file.
   */
  update(patch: unknown): VoiceSettingsView {
    if (isObject(patch) && ("runtimeDir" in patch || "modelsDir" in patch)) {
      throw new ValidationError("runtimeDir", "the folders of the voice engines are set in voice.json, not from the page");
    }
    const next = applySettingsPatch(this.settings, patch);
    const key = isObject(patch) ? patch["apiKey"] : undefined;
    if (key !== undefined && key !== null && typeof key !== "string") throw new ValidationError("apiKey", "apiKey must be text");
    const speechKey = isObject(patch) ? patch["speechKey"] : undefined;
    if (speechKey !== undefined && speechKey !== null && typeof speechKey !== "string") throw new ValidationError("speechKey", "speechKey must be text");
    this.settings = next;
    let dirtySecrets = false;
    if (typeof key === "string") {
      const id = this.keyOf(next.brain);
      if (id === null) throw new ValidationError("apiKey", "this model takes no key");
      if (key === "") delete this.secrets[id];
      else this.secrets[id] = key.slice(0, 500);
      dirtySecrets = true;
    }
    if (typeof speechKey === "string") {
      const id = this.speechKeyOf(next.speech);
      if (id === null) throw new ValidationError("speechKey", "this speech engine takes no key");
      if (speechKey === "") delete this.secrets[id];
      else this.secrets[id] = speechKey.slice(0, 500);
      dirtySecrets = true;
    }
    if (dirtySecrets) this.writeSecrets();
    this.writeSettings();
    return this.view();
  }

  private writeSettings(): void {
    const path = this.pathOf(VOICE_SETTINGS_FILE);
    if (path) this.atomicWrite(path, JSON.stringify(this.settings, null, 2), 0o644);
  }

  private writeSecrets(): void {
    const path = this.pathOf(VOICE_SECRETS_FILE);
    if (path) this.atomicWrite(path, JSON.stringify(this.secrets, null, 2), 0o600);
  }

  private atomicWrite(path: string, body: string, mode: number): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, body, { mode });
      try {
        chmodSync(temp, mode);
      } catch {
        /* a file system without modes (Windows) keeps what it has */
      }
      renameSync(temp, path);
    } catch (error) {
      this.log(`voice: ${path} could not be written: ${error instanceof Error ? error.message : String(error)}`);
      throw new Error("The voice settings could not be saved.");
    }
  }
}
