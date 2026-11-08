import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { Engines } from "../engines.js";
import { platformPackage } from "../manifest.js";
import { SherpaAsr } from "./asr.js";
import { loadSherpa } from "./sherpa.js";
import { SherpaTts } from "./tts.js";
import { SherpaVad } from "./vad.js";

/**
 * The real engines, put together from a folder of downloaded models. Nothing here is loaded until a call starts: finding
 * out what is installed only looks at files.
 */

/** Where the models are, by the folder each was unpacked to. */
export const MODEL_FOLDERS = {
  vad: "silero_vad.onnx",
  streaming: "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11",
  refine: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
  tts: "sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
} as const;

export interface VoicePackLayout {
  /** A folder with a node_modules that holds sherpa-onnx-node, or null to find it the usual way. */
  runtimeDir: string | null;
  /** The folder the models were unpacked into. */
  modelsDir: string;
}

export interface PackReport {
  runtime: boolean;
  vad: boolean;
  streaming: boolean;
  refine: boolean;
  tts: boolean;
  /** What a call cannot go without is all there. */
  ready: boolean;
  /** Names of what is missing from that. */
  missing: string[];
}

function runtimeInstalled(runtimeDir: string | null): boolean {
  if (runtimeDir) {
    // The engine and the native code for this platform, which is a package of its own.
    const native = platformPackage(process.platform, process.arch);
    return native !== null && existsSync(join(runtimeDir, "node_modules", "sherpa-onnx-node", "package.json")) && existsSync(join(runtimeDir, "node_modules", native, "package.json"));
  }
  try {
    loadSherpa(null);
    return true;
  } catch {
    return false;
  }
}

export function inspectPack(layout: VoicePackLayout): PackReport {
  const has = (...parts: string[]): boolean => existsSync(join(layout.modelsDir, ...parts));
  const runtime = runtimeInstalled(layout.runtimeDir);
  const vad = has(MODEL_FOLDERS.vad);
  const streaming = has(MODEL_FOLDERS.streaming, "encoder.int8.onnx") && has(MODEL_FOLDERS.streaming, "tokens.txt");
  const refine = has(MODEL_FOLDERS.refine, "encoder.int8.onnx") && has(MODEL_FOLDERS.refine, "tokens.txt");
  const tts = has(MODEL_FOLDERS.tts, "vocoder.int8.onnx") && has(MODEL_FOLDERS.tts, "voice.bin");
  const missing: string[] = [];
  if (!runtime) missing.push("engine runtime");
  if (!vad) missing.push("speech detector");
  if (!streaming) missing.push("speech recogniser");
  if (!tts) missing.push("voice");
  return { runtime, vad, streaming, refine, tts, ready: missing.length === 0, missing };
}

export interface SherpaEngineOptions {
  /** Use the offline model for the final reading of each turn when it is installed. Default: yes. */
  refine?: boolean;
  /** Denoising steps of the voice. Default 4. */
  ttsSteps?: number;
  threads?: number;
  log?: (line: string) => void;
}

export interface SherpaEngineSet {
  engines: Engines;
  asr: SherpaAsr;
  tts: SherpaTts;
  report: PackReport;
  /** Stops the recogniser's thread and lets go of the models. */
  dispose(): Promise<void>;
}

/** Chooses how many threads each model gets from the machine it runs on. */
export function defaultThreads(): { asr: number; refine: number; tts: number } {
  const cores = Math.max(1, availableParallelism());
  return { asr: Math.max(2, Math.min(4, Math.floor(cores / 4))), refine: Math.max(2, Math.min(4, Math.floor(cores / 4))), tts: Math.max(1, Math.min(3, Math.floor(cores / 6))) };
}

export function createSherpaEngines(layout: VoicePackLayout, options: SherpaEngineOptions = {}): SherpaEngineSet {
  const report = inspectPack(layout);
  if (!report.ready) throw new Error(`The voice pack is incomplete: ${report.missing.join(", ")} missing.`);
  const sherpa = loadSherpa(layout.runtimeDir);
  const threads = defaultThreads();
  const asr = new SherpaAsr({
    runtimeDir: layout.runtimeDir,
    streamingDir: join(layout.modelsDir, MODEL_FOLDERS.streaming),
    finalDir: report.refine && options.refine !== false ? join(layout.modelsDir, MODEL_FOLDERS.refine) : null,
    threads: options.threads ?? threads.asr,
    finalThreads: options.threads ?? threads.refine,
    log: options.log,
  });
  const tts = new SherpaTts({ runtimeDir: layout.runtimeDir, modelDir: join(layout.modelsDir, MODEL_FOLDERS.tts), threads: threads.tts, steps: options.ttsSteps ?? 4, log: options.log });
  const vad = new SherpaVad(sherpa, join(layout.modelsDir, MODEL_FOLDERS.vad));
  return { engines: { vad, asr, tts }, asr, tts, report, dispose: () => asr.dispose() };
}

export { SherpaAsr, SherpaTts, SherpaVad };
export { loadSherpa, VoiceRuntimeError } from "./sherpa.js";
