import type { VadEngine } from "../engines.js";
import type { SherpaModule, VadLike } from "./sherpa.js";

/**
 * Silero voice-activity detection through sherpa-onnx. The wrapper answers yes or no per frame at the threshold it was
 * given, with its own hysteresis, so two detectors at two thresholds give a graded answer: sure it is speech, probably,
 * or quiet. The turn-taker reads that as a probability; barge-in asks for the sure one, which is what keeps an echo or a
 * cough from cutting the assistant off.
 */

export const VAD_FRAME_SAMPLES = 512;

/** What each outcome is reported as; they sit either side of the turn-taker's thresholds (on 0.5, off 0.35, barge-in 0.62). */
const SURE = 0.85;
const PROBABLE = 0.6;
const QUIET = 0.1;

export class SherpaVad implements VadEngine {
  readonly id = "silero-vad";
  readonly frameSamples = VAD_FRAME_SAMPLES;
  private readonly probable: VadLike;
  private readonly sure: VadLike;

  constructor(sherpa: SherpaModule, modelPath: string) {
    const make = (threshold: number): VadLike =>
      new sherpa.Vad(
        {
          // The wrapper keeps the speech it cuts out, which nothing here reads; a long stretch is cut every 12 s so that the
          // buffer (30 s) never fills. The cut shows as one quiet frame, which the turn-taker does not notice.
          sileroVad: { model: modelPath, threshold, minSilenceDuration: 0, minSpeechDuration: 0, windowSize: VAD_FRAME_SAMPLES, maxSpeechDuration: 12 },
          sampleRate: 16000,
          numThreads: 1,
          provider: "cpu",
          debug: false,
        },
        30,
      );
    this.probable = make(0.5);
    this.sure = make(0.75);
  }

  process(frame: Float32Array): number {
    this.probable.acceptWaveform(frame);
    this.sure.acceptWaveform(frame);
    // The wrapper keeps the speech it has cut out; nothing here reads it, so it is dropped as it comes.
    for (const vad of [this.probable, this.sure]) while (!vad.isEmpty()) vad.pop();
    if (this.sure.isDetected()) return SURE;
    return this.probable.isDetected() ? PROBABLE : QUIET;
  }

  reset(): void {
    this.probable.reset();
    this.sure.reset();
  }
}
