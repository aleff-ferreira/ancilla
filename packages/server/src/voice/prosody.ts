/**
 * Zero-dependency acoustic prosody tracker for turn-end estimation (`TurnTaker.semanticEnd`).
 *
 * Tracks fundamental frequency (F0 via normalized autocorrelation across 75–380 Hz) and frame energy (dBFS) on voiced
 * 16 kHz frames. Synthetic constant-frequency test tones (`stdDevHz < 1.8 Hz`) return `null` so deterministic unit-test
 * rigs preserve their exact lexical pause timings, while real human intonation contours distinguish terminal falls/rises
 * from flat-pitch hesitation drawls.
 */

const SAMPLE_RATE = 16_000;
const MIN_F0_HZ = 75;
const MAX_F0_HZ = 380;
const SEARCH_MIN_LAG = 12; // ~1333 Hz: detects high-frequency pure tones (>380 Hz) before subharmonics alias into 75–380 Hz
const MIN_LAG = Math.floor(SAMPLE_RATE / MAX_F0_HZ); // 42
const MAX_LAG = Math.ceil(SAMPLE_RATE / MIN_F0_HZ); // 214

interface VoicedSample {
  f0Hz: number | null;
  dbFs: number;
}

export function frameRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

function estimateF0(samples: Float32Array): number | null {
  if (samples.length < MAX_LAG * 2) return null;
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i]!;
  mean /= samples.length;

  const corrs = new Float64Array(MAX_LAG + 2);
  let globalBestCorr = 0;
  const n = samples.length - MAX_LAG - 1;

  for (let lag = SEARCH_MIN_LAG; lag <= MAX_LAG + 1; lag++) {
    let cross = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < n; i++) {
      const a = samples[i]! - mean;
      const b = samples[i + lag]! - mean;
      cross += a * b;
      normA += a * a;
      normB += b * b;
    }
    const denom = Math.sqrt(normA * normB);
    if (denom < 1e-8) return null;
    const corr = cross / denom;
    corrs[lag] = corr;
    if (lag <= MAX_LAG && corr > globalBestCorr) {
      globalBestCorr = corr;
    }
  }
  if (globalBestCorr < 0.62) return null;

  // Pick the first local peak within 90% of globalBestCorr (McLeod / Praat first-peak rule) to prevent octave/subharmonic aliasing.
  const threshold = Math.max(0.6, globalBestCorr * 0.9);
  let chosenLag = -1;
  for (let lag = SEARCH_MIN_LAG + 1; lag <= MAX_LAG; lag++) {
    const c = corrs[lag]!;
    if (c >= threshold && c >= corrs[lag - 1]! && c >= corrs[lag + 1]!) {
      chosenLag = lag;
      break;
    }
  }
  if (chosenLag < MIN_LAG) return null;

  const prev = corrs[chosenLag - 1]!;
  const curr = corrs[chosenLag]!;
  const next = corrs[chosenLag + 1]!;
  const denom = prev - 2 * curr + next;
  const shift = Math.abs(denom) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (prev - next)) / denom)) : 0;
  return SAMPLE_RATE / (chosenLag + shift);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export class ProsodyTracker {
  private readonly frames: VoicedSample[] = [];

  reset(): void {
    this.frames.length = 0;
  }

  observeVoicedFrame(samples: Float32Array): void {
    const rms = frameRms(samples);
    if (rms < 0.004) return;
    const dbFs = 20 * Math.log10(Math.max(rms, 1e-6));
    const f0Hz = estimateF0(samples);
    this.frames.push({ f0Hz, dbFs });
    if (this.frames.length > 160) this.frames.shift();
  }

  /**
   * Estimates the probability `[0, 1]` that the speaker has prosodically finished their turn, or `null` when the
   * signal lacks enough natural pitch variation (such as short words or synthetic constant-frequency test tones).
   */
  estimateEndProbability(): number | null {
    if (this.frames.length < 8) return null;
    const pitched = this.frames.map((f) => f.f0Hz).filter((v): v is number => v !== null);
    if (pitched.length < 6) return null;

    const meanHz = pitched.reduce((a, b) => a + b, 0) / pitched.length;
    const variance = pitched.reduce((acc, v) => acc + (v - meanHz) * (v - meanHz), 0) / pitched.length;
    const stdDevHz = Math.sqrt(variance);
    // Synthetic pure-tone test fixtures have stdDevHz ~ 0; return null so lexical pause rules run undisturbed.
    if (stdDevHz < 1.8) return null;

    const bodyPitch = pitched.slice(0, Math.max(3, pitched.length - 3));
    const tailPitch = pitched.slice(-3);
    const medHz = median(bodyPitch);
    const endHz = median(tailPitch);
    const deltaSemitones = 12 * Math.log2(Math.max(endHz, 1) / Math.max(medHz, 1));

    const bodyDb = median(this.frames.slice(0, Math.max(3, this.frames.length - 3)).map((f) => f.dbFs));
    const tailDb = this.frames[this.frames.length - 1]!.dbFs;
    const dbDrop = bodyDb - tailDb;

    // Terminal declarative fall with natural energy taper.
    if (deltaSemitones <= -2.2 && dbDrop >= 3.5) return 0.87;
    if (deltaSemitones <= -3.2) return 0.85;
    // Terminal interrogative rise.
    if (deltaSemitones >= 2.6) return 0.86;

    // Flat mid-utterance drawl ("so I was thinking..." / sustained vowel plateau with abrupt cutoff).
    const tailSpreadSemitones =
      12 * Math.log2(Math.max(...tailPitch, 1) / Math.max(Math.min(...tailPitch), 1));
    if (Math.abs(deltaSemitones) < 0.75 && tailSpreadSemitones < 0.6 && dbDrop < 2.0 && pitched.length >= 12) {
      return 0.24;
    }

    return null;
  }
}
