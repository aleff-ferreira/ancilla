# WebPlayer in a real browser (Edge)

Measures, in Microsoft Edge (Chromium, the engine of the app's WebView2), what the assistant's voice player really does when it
is stopped, paused and resumed. The page loads the real `packages/ui/src/model/voice/player.ts` (bundled with esbuild, not
changed), plays a 36 s reply through it as the server does (40 ms pieces of 16-bit 44.1 kHz audio, kept about 2.4 s ahead of
`player.played(1)`, checked every 100 ms), and records what the player hands to the audio device. Earlier tests of the player
used fake audio contexts.

Nothing is audible: Edge runs with `--mute-audio` and a throwaway profile. The tool never changes a volume, a mute, a default
device or any other system setting, runs no git command and downloads nothing.

## Files

| File | Runs on | Purpose |
| --- | --- | --- |
| `player-edge.html` | Edge | the page (`window.edge`): the tap, the feeder, the six trials |
| `player-edge.mjs` | Windows, Node 22 | serves the page, launches `msedge.exe`, drives the page over the DevTools Protocol, analyses the recordings, writes the results |
| `player-edge-results.json` | | the raw results: every trial's numbers and checks, the per-trial notes, the summary |
| `player-edge-results.md` | | the generated summary tables |
| `RESULTS.md` | | what was run, what each number measures, what passed, failed and is unverified |

## Run

1. Bundle the real player (WSL, Node 22, from the worktree root; no network):

   ```bash
   source ~/.nvm/nvm.sh
   ./node_modules/.bin/esbuild packages/ui/src/model/voice/player.ts --bundle --format=iife --global-name=Player --outfile=<dir>/player.js
   ```

2. Run the driver on Windows with the Node that ships with the app (there is no other on the PATH). `--assets` holds
   `reply-en-native.wav` and `reply-pt-native.wav` (44.1 kHz, mono, 16-bit):

   ```powershell
   & "<path to the app's node.exe>" scripts\voice\interrupt-eval\e2e\player-edge.mjs --assets <dir> --player <dir>\player.js --out <dir>\out [--n 30] [--workers 3] [--types T1,T2,T3,T4,T5,T6,T7] [--smoke] [--unmuted] [--results <dir>] [--topup <earlier --out dir>]
   ```

   `--smoke` runs short trials (moments 2 s to 4 s). `--workers` runs that many Edge windows at the same time (each its own
   process, profile and audio context) to shorten the run; 30 trials of each of the six types take about 55 minutes with one
   and about 20 with three. `--topup <dir>` runs replacements (ids like `T2-x1`, a longer wait for speech) for the trials of an
   earlier run that were left out of its numbers. `--unmuted` drops `--mute-audio` (only if the tap stays silent when muted; it
   did not). The recordings are saved in `--out`; `--reanalyze <out>[,<out2>] --assets <dir>` recomputes the results from them
   without a browser. The numbers of the last run, and what they do and do not show, are in `RESULTS.md`.

## The tap

`AudioNode.prototype.connect` is patched before the player exists: whatever is connected to `ctx.destination` (here the
player's analyser) is also connected to a recorder, an `AudioWorkletNode`. The recorder therefore sees exactly the samples the
player hands to the audio device, at the context rate (48 kHz on this machine), and the player is not touched. Edge's audio
worklet repeats `currentFrame` for the blocks of one burst, so the recorder numbers its blocks itself (the previous frame plus
128, or `currentFrame` when that is further on) and notes a jump as a hole; a hole invalidates the trial. Time is the audio
clock only: every call is stamped with `ctx.currentTime` read synchronously just before it, and a latency is the tap's time
minus that stamp.

## Trials (30 of each of T1 to T6 and 12 of T7, moments stratified over 2 s to 25 s into the reply)

The call waits for a moment when the tap's last 100 ms were at least -40 dBFS RMS and its last 20 ms -45 dBFS (never a
natural pause; T4 also waits for speech in the three pieces it will hold).

| Trial | What is called |
| --- | --- |
| T1 | `stop()` (the shipped path). Feeder stopped. |
| T2 | `pause(1500)`, nothing more: the lease must end it. Feeder keeps topping up. |
| T3 | `pause(60000)`, then `resume()` 600 ms later. |
| T4 | `pause(60000)`, three more pieces `enqueue`d 150 ms later while paused, `resume()` 600 ms after the pause, the feeder carries on. |
| T5 | `pause(1500)` three times, 600 ms apart, then nothing: the voice must return 1.5 s after the last. |
| T6 | `pause(1500)`, `stop()` 300 ms later, then 1.6 s later `enqueue(2, ...)` with 1.5 s of the Portuguese reply, picked to start loud. |
| T7 | `pause(1500)`, three more pieces `enqueue`d 150 ms later, then `stop()` 600 ms after the pause: the page's answer to a server `resume` with `drop: true`. 2.7 s are recorded after the drop (past the end of the lease). Nothing may be heard. |

## What is computed

The source is resampled to the context rate by linear interpolation (what Chromium does for a 44.1 kHz buffer on a 48 kHz
context). Where the tap's audio sits in the source is found by normalised cross-correlation (FFT, parabolic peak): the offset
`a` such that `tap[n] = source[n - a]`. In the pre-call stream it correlates at 0.9999999.

- **Silence** (the spec): the start of the final run of 5 ms windows below -60 dBFS RMS that reaches the end of the hold (T1:
  the end of the record, at least 1.5 s; T2/T5: 1.3 s after the last pause; T3/T4: the resume call; T6: `enqueue(2)`).
  Also reported: the last non-zero sample (after it every source has stopped, so anything there is stale audio). Latency:
  that time minus the call's stamp.
- **Audible again**: the first 5 ms window at or above -60 dBFS RMS; also the first non-zero sample after the silence.
- **Continuity**: the source position of the last non-zero sample before the pause and of the first one after the resume are
  both taken from the alignment; their difference is the gap (+, skipped) or repeat (-). Then every 40 ms window of the rest of
  the record with at least -50 dBFS RMS must still correlate (>= 0.9) at the offset found, within 1 ms: a piece lost,
  repeated or out of order fails the windows after it. T4 also checks the 20 ms windows over the three held pieces.
- **Accounting**: the player's count (what `stop()` or `pause()` returned, and `played(1)` right after) against the source
  samples that reached the tap before the silence, in samples (44.1 kHz) and ms. After the voice comes back, `played(1)` as
  the feeder read it every 100 ms is compared with the tap position at that moment minus the latency the player subtracts.
- **T6 level**: gain of the first 100 ms of utterance 2 against the source (least squares at the aligned offset).

## Pass/fail rules

| Check | Passes when |
| --- | --- |
| `baseline` | the stream before the call plays the source in place (40 ms windows >= 0.9 at one offset) |
| `stale` | silent through the hold, silence starts within 100 ms of the call, and nothing above -60 dBFS after the last non-zero sample (T1: for at least 1.5 s; T6: no stray non-zero sample) |
| `accounting` | `abs(played - tap count) <= 1 ms` |
| `accountingNoOver` | the player never counts more than reached the tap (diff <= 1 ms) |
| `accountingHeard` (T1) | `played` equals the tap count minus `outputLatency` (what had been heard by now), within 1 ms |
| `continuity` | gap within 1 ms, alignment >= 0.9, every later window in place |
| `acctAfter` | `played(1)` after the voice came back agrees with the tap within 5 ms |
| `heldOrder` (T4) | the held pieces play after the paused remainder, in order |
| `leaseReturn` (T2/T5) | the first sample comes 1480 ms to 1690 ms after the last pause (1500 ms lease plus the 40 ms lead, with timer slack) |
| `renewalNull` (T5) | a pause while paused returns null |
| `stopPlayedEqualsPause`, `currentIs2` (T6) | `stop()` while paused returns the paused position; `current()` is 2 after `enqueue(2)` |
| `afterDropNoAudio`, `dropPlayedEqualsPause` (T7) | every sample after the drop is exactly zero for the rest of the record; the drop's `stop()` returns the paused position |
| `fullVolume` (T6) | the first 100 ms of utterance 2 are within 1 dB of the source, correlation >= 0.9 |

A trial is invalid (left out of the numbers, listed in the results) when the tap has a hole, the call landed on a pause, or
the pre-call alignment failed.

## Limits

- The tap is the node before `ctx.destination`. It is not the physical speaker and not a microphone. What the device and the
  speakers add after it is not measured. Edge reports `ctx.outputLatency` of 24 to 40 ms even when muted (a real output stream is
  open); that, and any Bluetooth buffering, comes on top of every time here. The time from a server message to the page's call
  (WebSocket, VAD, decision) is not measured either: a latency here starts at the call into the player.
- `--mute-audio` mutes at Edge's output. The tap works under it; nothing was checked at the device.
- Windows timers (the lease is a `setTimeout`) are good to about 10 ms.
- Several browsers at once share the CPU and the audio service. A control run with one browser (T1 to T3, 10 trials each)
  gave the same block-exact numbers (pause fade 30.0 ms, resume 40.0 ms) and lease returns within one timer slack (medians
  1541 ms against 1549 ms). Differences: with one browser `outputLatency` stayed at 32 ms (24 to 40 ms with three) and all 10
  `stop()` calls cut in the call's own block (with three, 2 of 30 cut 2.7 ms and 8 ms late). Ten trials cannot say whether the load
  causes that.
