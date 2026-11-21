# Real-Edge player test: results

Run on 2026-11-20. Method, trials and pass/fail rules are in `README.md`; every number below is in
`player-edge-results.json` (raw, per trial) and the tables in `player-edge-results.md`. The one-browser control is in
`player-edge-control-results.json`.

## What was run

| Run | Trials | Edge windows | Purpose |
| --- | --- | --- | --- |
| main | 180 scheduled: 30 each of T1 to T6, moments stratified over 2 s to 25 s into the reply | 3 at once | the test (about 18 min) |
| replacement | 6 | 3 | replaces the 6 trials of the main run that were left out (the call found no speech to land on within 1 s: T1-10, T2-10, T2-29, T5-15, T6-14, T6-21) |
| drop (T7) | 12 | 3 | the new behavior: `stop()` while paused with audio held (the server's `resume` with `drop: true`) |
| control | 30: T1 to T3, 10 each, moments 2 s to 4 s | 1 | does running three browsers at once change the audio-clock numbers |
| smoke | a few trials per type | 1 | checking the harness while it was written; not in any number |

The results files hold 192 valid trials (30 of each of T1 to T6, 12 of T7) and the 6 left out. No browser run was started
after the request to stop them; none is running and no profile folder is left.

Microsoft Edge 157.0.4341.60 (Chromium 157, Windows 11 build 10.0.26200), headed windows with a throwaway profile,
`--mute-audio`, `--autoplay-policy=no-user-gesture-required`. Driven by the Node 22 that ships with the app. One
`AudioContext({latencyHint: "interactive"})` per window at 48000 Hz, `baseLatency` 10 ms, `outputLatency` reported by Edge as
24, 32 or 40 ms (it differed between windows and over the run; 32 ms in every trial of the one-browser control). The real
`player.ts` (bundled, unchanged) played the 36.6 s English reply as 40 ms pieces kept 2.4 s ahead of `played(1)`.

## What was timed

The timed signal is a tap: the audio the real player hands to `ctx.destination`, recorded by an `AudioWorkletNode` that
`AudioNode.prototype.connect` also connects to wherever the player connects to the destination. It is **not the physical
speaker, not a loopback through the audio device and not a microphone**. Output was muted. Whatever the device, the speakers or
Bluetooth add after the tap is not in any number; Edge's `ctx.outputLatency` (24 to 40 ms here) says how much the device
path adds, but that figure was not verified against sound.

The clock starts at the page's call into the player, not at the server's message: a latency is the tap's time minus
`ctx.currentTime` read synchronously just before the call. The server message reaching the page (WebSocket), the voice
activity decision and the page's dispatch are **not measured**, so "decision message to last audible sample" is not a single
measured number: it is that unmeasured part, plus the call-to-tap times below, plus the device path.

| Number | What it is |
| --- | --- |
| to the last non-zero sample | frames from the call's stamp to the first sample after the last non-zero sample the player produced (after it every source has stopped). Exact, in 128-frame blocks of 2.67 ms |
| to silence (spec) | the start of the final run of 5 ms windows below -60 dBFS RMS. Can precede the call by a millisecond when the speech at the cut is already quiet |
| audible again | the first 5 ms window at or above -60 dBFS RMS after a silence |
| gap (continuity) | source samples skipped (+) or repeated (-) between the last sample before a pause and the first after the resume, from cross-correlation against the source (it correlates at 0.9999999 in the stream before a call) |
| played vs tap | what `stop()`/`pause()` returned (and `played(1)` right after, and as read every 100 ms) against the source samples that reached the tap |

## Results

n is 30 unless stated. Times in ms.

| Call | Measure | median | p95 | max |
| --- | --- | ---: | ---: | ---: |
| `stop()` | to the last non-zero sample | 0.00 | 2.67 | 8.00 |
| `stop()` | to silence (spec) | -0.01 | 2.65 | 5.96 |
| `pause()` (T2 to T7, n=162) | to the last non-zero sample (the 30 ms fade) | 30.00 | 30.00 | 32.67 |
| `pause()` (T2 to T7, n=162) | to silence (spec) | 24.58 | 27.48 | 27.83 |
| `resume()` (T3, T4, n=60) | to the first sample | 40.00 | 40.00 | 40.00 |
| `resume()` (T3, T4, n=60) | to audible again | 40.00 | 44.15 (T3), 40.92 (T4) | 45.00 |
| lease, `pause(1500)` alone (T2) | to the first sample back | 1549.33 | 1552.00 | 1552.00 |
| lease renewed 3 times (T5) | last pause to the first sample back | 1545.33 | 1552.00 | 1552.00 |
| `enqueue(2)` after `stop()` while paused (T6) | to the first sample / audible | 40.00 / 49.04 | 40.00 / 49.04 | 40.00 / 49.04 |

- **`stop()` cuts at the call's own block** in 28 of 30 trials; once 2.67 ms (one block) and once 8.00 ms (three blocks) later,
  both with three browsers running. After the cut every sample to the end of the record (1.9 s or more) was exactly zero in
  30 of 30.
- **`pause()` fades out over 30.00 ms** (all but one of 162 trials; one at 32.67 ms). The output is under -60 dBFS after 5.5 to
  27.8 ms depending on the level of the speech at the cut. The fade ends without a step: the last non-zero sample is a median
  of -64.5 to -69.5 dBFS (T2 to T7), never louder than -54.7 dBFS.
- **Stale audio: none.** Silent, to the end of the hold, in 30/30 (T1), 30/30 (T2 to T6 each) and 12/12 (T7); nothing above
  -60 dBFS after the last non-zero sample, and in fact exactly zero (largest sample -240 dBFS) in every trial. T2 and T5 stayed
  silent until 1.3 s after the last pause, T6 until `enqueue(2)`, T7 to the end of the record.
- **Continuity: nothing lost or repeated.** Across pause and resume (T2 to T5, 120 trials) the gap was under 0.001 ms (less than a
  sample) every time, and every later 40 ms window of speech (at least -66 dBFS) stayed in place (lowest correlation 1.000). In T4
  the three pieces held while paused played after the paused remainder, in order, in 30/30, each with speech in them. Two trials
  had fewer than five checkable windows after the resume (T2-28: 2, T5-30: 4, quiet speech); they pass on the 400 ms anchor
  window and the gap.
- **Lease.** `pause(1500)` alone returns the voice 1538.7 to 1552.0 ms after the call (1500 ms lease, the player's 40 ms lead,
  timer slack of up to 12 ms); no early return. Renewals work: a pause while paused returned null in 30/30 (T5), and the voice came
  back 1538.7 to 1552.0 ms after the last of three pauses (about 2.75 s after the first).
- **Accounting, pause.** The count `pause()` returned equals the source samples that reached the tap to within one sample in
  162/162 (largest difference 0.023 ms); `played(1)` right after `pause()` equals it and stays there while paused (60/60); after
  the voice comes back `played(1)` read every 100 ms agrees with the tap within 2.67 ms (one block of read skew) in all 120
  trials, and within 0.023 ms during steady play.
- **Accounting, `stop()`.** `stop()` returned a count that is **below** what reached the tap by 24 to 48 ms (median 40 ms) in 30/30
  trials, never above. It is the tap count minus `ctx.outputLatency` (what had been heard by now), within 1 ms in 28/30; the two
  that differ are the late cuts above. `pause()` has no such subtraction, so the two calls count on different bases. After
  `stop()`, `player.played(1)` returns 0.
- **T6.** `stop()` while paused returned the paused position (30/30); nothing was heard from the pause to `enqueue(2)`, past the
  end of the lease (30/30); utterance 2 started 40.00 ms after `enqueue` and its first 100 ms were at 0.00 dB against the source
  (30/30).
- **T7, the drop (new).** `pause(1500)`, three pieces `enqueue`d while paused, `stop()` 600 ms later: every sample from the
  pause's tail to the end of the record, 2.95 to 2.96 s after the drop and past the end of the lease, was exactly zero in 12/12.
  The drop's `stop()` returned the paused position in 12/12. 2.35 to 2.48 s of paused audio (remainder plus held pieces) was thrown
  away and did not play late.
- **Edges.** `stop()` ends in a hard step to zero: the last sample before it is a median of -37.3 dBFS and as loud as -13.8 dBFS (a
  click the size of the speech). `resume()` has no effective fade-in: the first sample after it is a median of -21.5 to -25.4 dBFS,
  as loud as -11.5 dBFS, a median of 1.5 to 3.2 dB below and up to 7.2 dB above the RMS of the next 20 ms. The gain ramp (10 ms
  time constant) starts at the call, and the audio starts 40 ms later, when it is 98% done.

## One browser against three

The control (T1 to T3, 10 each, one window) gave the same block-exact numbers: fade 30.00 ms, resume 40.00 ms, all 10 `stop()`
cuts in the call's own block, `outputLatency` 32 ms throughout, lease returns of 1541.3 to 1552.0 ms (median 1541.3 against 1549.3
with three). So the late `stop()` cuts and the 24 and 40 ms output latencies were seen only with three windows, but ten trials
cannot say whether the load caused them.

## Failed

- `stop()`'s count does not equal the tap count (0/30 within 1 ms): it is lower by the output latency plus any late cut, 24 to
  48 ms. By design (it counts what was heard by now), and always under, never over. It differs from `pause()`, which counts to
  the sample.
- Two of 30 `stop()` calls cut late (2.67 ms, 8.00 ms), under three-window load.
- 6 of the 180 trials scheduled in the main run were left out and replaced (see above): the call could not find speech
  within 1 s of its moment.

Nothing else failed: stale audio, continuity, order of held pieces, lease and its renewal, `stop()` while paused, the level of a
new utterance, and the drop all passed in every valid trial.

## Unverified

- Anything at the physical speaker or earbuds: not measured, and `--mute-audio` meant nothing was played there. `outputLatency`
  is Edge's own report. Bluetooth buffering is unknown.
- The server's message to the page, the voice activity decision and the page's dispatch, so no end-to-end "decision to last
  audible sample" number exists.
- The app's own WebView2 runtime (this was the Edge 157 browser, same engine family; the runtime version was not checked).
- Any context rate other than 48 kHz, any other machine or load beyond three windows, replies other than the two used (English for
  every trial; the Portuguese reply only as utterance 2 in T6), the first 2 s of a reply, many pause and resume cycles inside one
  reply (T5 renews a lease; it does not cycle).
- Whether load changes the late-`stop()` rate (control of 10 trials per type only).
- The recordings are not kept in the repository; the JSON holds the numbers and per-trial notes.

The tool changed no volume, mute, default device or other system setting, ran no git command and downloaded nothing.
