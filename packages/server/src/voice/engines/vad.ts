import type { VadEngine } from "../engines.js";
import type { SherpaModule, VadLike } from "./sherpa.js";

/**
 * Silero voice-activity detection through sherpa-onnx. The wrapper answers yes or no per frame at the threshold it was
 * given, with its own hysteresis, so two detectors at two thresholds give a graded answer: sure it is speech, probably,
 * or quiet. The turn-taker reads that as a probability; barge-in asks for the sure one, which is what keeps an echo or a
 * cough from cutting the assistant off.
 *
 * A zero for the minimum speech or silence is not a zero to the wrapper (measured on sherpa-onnx-node 2.0.1: it behaves as
 * its defaults of 0.25 s and 0.5 s): the detectors below say "speech" 0.22 to 0.38 s after a word begins and go on saying it
 * for 0.5 to 1.4 s after it ends. That suits finding the end of a turn and is far too slow to tell that someone has begun to
 * speak over the assistant; `processOnset` is the same model read with a minimum of two frames.
 */

export const VAD_FRAME_SAMPLES = 512;

/** What each outcome is reported as; they sit cleanly across the turn-taker's thresholds (on 0.5, off 0.35, barge-in 0.62). */
const SURE = 0.86;
const PROBABLE = 0.64;
const SOFT = 0.42;
const QUIET = 0.1;

/** The minimum speech and silence, in seconds, of the quick reading (two frames: the wrapper treats zero as its default). */
const ONSET_MIN_SPEECH = 0.032;
const ONSET_MIN_SILENCE = 0.064;

export class SherpaVad implements VadEngine {
  readonly id = "silero-vad";
  readonly frameSamples = VAD_FRAME_SAMPLES;
  private readonly soft: VadLike;
  private readonly probable: VadLike;
  private readonly sure: VadLike;
  private onset: { soft: VadLike; probable: VadLike; sure: VadLike } | null = null;

  constructor(
    private readonly sherpa: SherpaModule,
    private readonly modelPath: string,
  ) {
    this.soft = this.detector(0.35, 0, 0);
    this.probable = this.detector(0.52, 0, 0);
    this.sure = this.detector(0.72, 0, 0);
  }

  private detector(threshold: number, minSpeechDuration: number, minSilenceDuration: number): VadLike {
    return new this.sherpa.Vad(
      {
        // The wrapper keeps the speech it cuts out, which nothing here reads; a long stretch is cut every 12 s so that the
        // buffer (30 s) never fills. The cut shows as one quiet frame, which the turn-taker does not notice.
        sileroVad: { model: this.modelPath, threshold, minSilenceDuration, minSpeechDuration, windowSize: VAD_FRAME_SAMPLES, maxSpeechDuration: 12 },
        sampleRate: 16000,
        numThreads: 1,
        provider: "cpu",
        debug: false,
      },
      30,
    );
  }

  private grade(soft: VadLike, probable: VadLike, sure: VadLike, frame: Float32Array): number {
    soft.acceptWaveform(frame);
    probable.acceptWaveform(frame);
    sure.acceptWaveform(frame);
    // The wrapper keeps the speech it has cut out; nothing here reads it, so it is dropped as it comes.
    for (const vad of [soft, probable, sure]) while (!vad.isEmpty()) vad.pop();
    if (sure.isDetected()) return SURE;
    if (probable.isDetected()) return PROBABLE;
    return soft.isDetected() ? SOFT : QUIET;
  }

  process(frame: Float32Array): number {
    return this.grade(this.soft, this.probable, this.sure, frame);
  }

  /** The same frames, read to say as early as a frame or two that speech has begun and as soon that it has ended. */
  processOnset(frame: Float32Array): number {
    this.onset ??= {
      soft: this.detector(0.35, ONSET_MIN_SPEECH, ONSET_MIN_SILENCE),
      probable: this.detector(0.52, ONSET_MIN_SPEECH, ONSET_MIN_SILENCE),
      sure: this.detector(0.72, ONSET_MIN_SPEECH, ONSET_MIN_SILENCE),
    };
    return this.grade(this.onset.soft, this.onset.probable, this.onset.sure, frame);
  }

  reset(): void {
    this.soft.reset();
    this.probable.reset();
    this.sure.reset();
    this.onset?.soft.reset();
    this.onset?.probable.reset();
    this.onset?.sure.reset();
  }
}
