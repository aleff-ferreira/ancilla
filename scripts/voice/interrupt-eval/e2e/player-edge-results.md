# WebPlayer in Edge: results

Run 2026-11-20T22:10:46.764Z. Edg/157.0.4341.60 (Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0). Node v22.23.2. Windows 10.0.26200.

Audio context: 48000 Hz, baseLatency 10.00 ms, outputLatency 24.0 to 40.0 ms over the trials (median 32.0 ms; 0 means the browser reports none, as it may when muted; the player then subtracts baseLatency). Flags: --mute-audio, --autoplay-policy=no-user-gesture-required. 3 browser(s) in parallel, 30 trial(s) per type, seed 20261120.

Times are on the audio clock: a latency is the tap's time minus `ctx.currentTime` read synchronously just before the call. The tap is the node just before `ctx.destination` (what the page hands to the audio device); the device's own latency is not in these numbers.

## Latencies (ms)

| Trial | Measure | n | min | median | p95 | max |
|---|---|---:|---:|---:|---:|---:|
| T1 | stop() to silence for good (spec: 5 ms windows below -60 dBFS) | 30 | -1.21 | -0.01 | 2.65 | 5.96 |
| T1 | stop() to the last non-zero sample | 30 | 0.00 | 0.00 | 2.67 | 8.00 |
| T2 | pause(1500) to silence | 30 | 5.83 | 24.49 | 27.40 | 27.48 |
| T2 | pause() to the last non-zero sample | 30 | 30.00 | 30.00 | 30.00 | 30.00 |
| T2 | pause() to audible again (lease) | 30 | 1538.67 | 1549.33 | 1552.04 | 1552.29 |
| T2 | pause() to the first non-zero sample after the lease | 30 | 1538.67 | 1549.33 | 1552.00 | 1552.00 |
| T3 | pause(60000) to silence | 30 | 5.54 | 24.61 | 27.48 | 27.48 |
| T3 | pause() to the last non-zero sample | 30 | 30.00 | 30.00 | 30.00 | 30.00 |
| T3 | resume() to audible again | 30 | 40.00 | 40.00 | 44.15 | 45.00 |
| T3 | resume() to the first non-zero sample | 30 | 40.00 | 40.00 | 40.00 | 40.00 |
| T4 | pause(60000) to silence | 30 | 6.56 | 24.21 | 27.48 | 27.83 |
| T4 | pause() to the last non-zero sample | 30 | 30.00 | 30.00 | 30.00 | 30.00 |
| T4 | resume() to audible again | 30 | 40.00 | 40.00 | 40.92 | 41.65 |
| T4 | resume() to the first non-zero sample | 30 | 40.00 | 40.00 | 40.00 | 40.00 |
| T5 | first pause(1500) to silence | 30 | 13.46 | 25.06 | 27.54 | 27.54 |
| T5 | first pause() to the last non-zero sample | 30 | 30.00 | 30.00 | 30.00 | 30.00 |
| T5 | last pause() to audible again | 30 | 1538.67 | 1545.52 | 1552.00 | 1552.02 |
| T5 | last pause() to the first non-zero sample | 30 | 1538.67 | 1545.33 | 1552.00 | 1552.00 |
| T5 | first pause() to the first non-zero sample | 30 | 2738.67 | 2752.00 | 2768.00 | 2778.67 |
| T6 | pause(1500) to silence | 30 | 6.35 | 24.09 | 27.48 | 27.77 |
| T6 | pause() to the last non-zero sample | 30 | 30.00 | 30.00 | 30.00 | 32.67 |
| T6 | enqueue(2) to audible | 30 | 49.04 | 49.04 | 49.04 | 49.04 |
| T6 | enqueue(2) to the first non-zero sample | 30 | 40.00 | 40.00 | 40.00 | 40.00 |
| T7 | pause(1500) to silence (the drop comes 600 ms later) | 12 | -1.13 | 25.54 | 27.10 | 27.10 |
| T7 | pause() to the last non-zero sample | 12 | 30.00 | 30.00 | 30.00 | 30.00 |
| T7 | silence recorded after the drop (ms) | 12 | 2949.33 | 2957.33 | 2962.67 | 2962.67 |
| T7 | paused audio thrown away by the drop (ms) | 12 | 2348.68 | 2454.00 | 2479.34 | 2479.34 |

Pause to silence, T2 to T7 pooled (every trial starts with the same `pause()`):

| Measure | n | min | median | p95 | max |
|---|---:|---:|---:|---:|---:|
| pause() to silence (spec) | 162 | -1.13 | 24.58 | 27.48 | 27.83 |
| pause() to the last non-zero sample | 162 | 30.00 | 30.00 | 30.00 | 32.67 |

## Checks

| Trial | Check | Pass | Result |
|---|---|---:|---|
| T1 | nothing stale: silent (< -60 dBFS) from the cut to the end of the hold, within 100 ms of the call | 30/30 | PASS |
| T1 | played count equals the samples that reached the tap (|diff| <= 1 ms) | 0/30 | FAIL |
| T1 | played count never claims more than reached the tap (diff <= 1 ms) | 30/30 | PASS |
| T1 | stop(): played count equals the tap count minus the output latency (what had been heard by now), |diff| <= 1 ms | 28/30 | FAIL |
| T1 | valid trials | 30/31 | see invalid list |
| T2 | nothing stale: silent (< -60 dBFS) from the cut to the end of the hold, within 100 ms of the call | 30/30 | PASS |
| T2 | played count equals the samples that reached the tap (|diff| <= 1 ms) | 30/30 | PASS |
| T2 | played count never claims more than reached the tap (diff <= 1 ms) | 30/30 | PASS |
| T2 | the voice returns 1500 ms after the last pause, plus the 40 ms lead (-20 ms to +150 ms) | 30/30 | PASS |
| T2 | resume continues at the sample where it stopped (|gap| <= 1 ms) and everything after it plays in place | 30/30 | PASS |
| T2 | played(1) after the resume agrees with the tap (max |error| <= 5 ms) | 30/30 | PASS |
| T2 | valid trials | 30/32 | see invalid list |
| T3 | nothing stale: silent (< -60 dBFS) from the cut to the end of the hold, within 100 ms of the call | 30/30 | PASS |
| T3 | played count equals the samples that reached the tap (|diff| <= 1 ms) | 30/30 | PASS |
| T3 | played count never claims more than reached the tap (diff <= 1 ms) | 30/30 | PASS |
| T3 | played(1) stays at the paused value while paused | 30/30 | PASS |
| T3 | played(1) right after pause() equals what pause() returned | 30/30 | PASS |
| T3 | resume continues at the sample where it stopped (|gap| <= 1 ms) and everything after it plays in place | 30/30 | PASS |
| T3 | played(1) after the resume agrees with the tap (max |error| <= 5 ms) | 30/30 | PASS |
| T3 | valid trials | 30/30 |  |
| T4 | nothing stale: silent (< -60 dBFS) from the cut to the end of the hold, within 100 ms of the call | 30/30 | PASS |
| T4 | played count equals the samples that reached the tap (|diff| <= 1 ms) | 30/30 | PASS |
| T4 | played count never claims more than reached the tap (diff <= 1 ms) | 30/30 | PASS |
| T4 | played(1) stays at the paused value while paused | 30/30 | PASS |
| T4 | played(1) right after pause() equals what pause() returned | 30/30 | PASS |
| T4 | resume continues at the sample where it stopped (|gap| <= 1 ms) and everything after it plays in place | 30/30 | PASS |
| T4 | played(1) after the resume agrees with the tap (max |error| <= 5 ms) | 30/30 | PASS |
| T4 | the three pieces held while paused play after the paused remainder, in order | 30/30 | PASS |
| T4 | valid trials | 30/30 |  |
| T5 | nothing stale: silent (< -60 dBFS) from the cut to the end of the hold, within 100 ms of the call | 30/30 | PASS |
| T5 | played count equals the samples that reached the tap (|diff| <= 1 ms) | 30/30 | PASS |
| T5 | played count never claims more than reached the tap (diff <= 1 ms) | 30/30 | PASS |
| T5 | the voice returns 1500 ms after the last pause, plus the 40 ms lead (-20 ms to +150 ms) | 30/30 | PASS |
| T5 | a pause while paused returns null (renews the lease only) | 30/30 | PASS |
| T5 | resume continues at the sample where it stopped (|gap| <= 1 ms) and everything after it plays in place | 30/30 | PASS |
| T5 | played(1) after the resume agrees with the tap (max |error| <= 5 ms) | 30/30 | PASS |
| T5 | valid trials | 30/31 | see invalid list |
| T6 | nothing stale: silent (< -60 dBFS) from the cut to the end of the hold, within 100 ms of the call | 30/30 | PASS |
| T6 | played count equals the samples that reached the tap (|diff| <= 1 ms) | 30/30 | PASS |
| T6 | played count never claims more than reached the tap (diff <= 1 ms) | 30/30 | PASS |
| T6 | stop() while paused returns the paused position | 30/30 | PASS |
| T6 | current() is 2 after enqueue(2) | 30/30 | PASS |
| T6 | utterance 2 plays at full volume at once (first 100 ms within 1 dB of the source, correlation >= 0.9) | 30/30 | PASS |
| T6 | valid trials | 30/32 | see invalid list |
| T7 | nothing stale: silent (< -60 dBFS) from the cut to the end of the hold, within 100 ms of the call | 12/12 | PASS |
| T7 | T7, after the drop (stop() while paused, audio held): every sample to the end of the record is exactly zero (2.7 s later, past the end of the lease) | 12/12 | PASS |
| T7 | T7: the drop's stop() returns the paused position | 12/12 | PASS |
| T7 | played count equals the samples that reached the tap (|diff| <= 1 ms) | 12/12 | PASS |
| T7 | played count never claims more than reached the tap (diff <= 1 ms) | 12/12 | PASS |
| T7 | valid trials | 12/12 |  |

## Other numbers

| Trial | Measure | n | min | median | p95 | max |
|---|---|---:|---:|---:|---:|---:|
| T1 | played count of stop()/pause() minus source samples that reached the tap (samples) | 30 | -2117.200 | -1764.000 | -1411.200 | -1058.400 |
| T1 | same, in ms (negative: the player under-counts) | 30 | -48.009 | -40.000 | -32.000 | -24.000 |
| T1 | played(1) every 100 ms during steady play, max |error| against the tap (ms) | 30 | 0.005 | 0.018 | 0.023 | 0.023 |
| T1 | level of the last non-zero sample before silence (the size of the step to zero), dBFS | 30 | -65.337 | -37.320 | -18.843 | -13.823 |
| T1 | stop(): played minus tap count plus the output latency the player subtracts (ms) | 30 | -8.009 | -0.014 | 0.000 | 0.000 |
| T1 | audio-worklet frame labels that repeated inside a burst of blocks (a recorder bookkeeping count, not audio) | 30 | 0.000 | 3.500 | 14.000 | 14.000 |
| T1 | largest sample in the silence (dBFS; -240 is digital zero) | 30 | -240.000 | -240.000 | -240.000 | -240.000 |
| T1 | main-thread time of the first call (ms) | 30 | 0.000 | 0.100 | 0.200 | 0.300 |
| T1 | ctx.outputLatency at the end of the trial (ms) | 30 | 24.000 | 40.000 | 40.000 | 40.000 |
| T1 | longest gap between the page's 100 ms feeder ticks (ms) | 30 | 109.333 | 112.000 | 120.000 | 130.667 |
| T2 | played count of stop()/pause() minus source samples that reached the tap (samples) | 30 | -1.000 | -0.600 | -0.000 | -0.000 |
| T2 | same, in ms (negative: the player under-counts) | 30 | -0.023 | -0.014 | -0.000 | -0.000 |
| T2 | played(1) every 100 ms during steady play, max |error| against the tap (ms) | 30 | 0.005 | 0.018 | 0.023 | 0.023 |
| T2 | same after the voice came back, max |error| (ms) | 30 | 0.005 | 0.018 | 0.023 | 2.658 |
| T2 | continuity: source skipped (+) or repeated (-) across the silence (ms) | 30 | -0.000 | -0.000 | 0.000 | 0.000 |
| T2 | lowest correlation of any 40 ms window after the voice came back | 30 | 1.000 | 1.000 | 1.000 | 1.000 |
| T2 | level of the last non-zero sample before silence (the size of the step to zero), dBFS | 30 | -109.656 | -68.340 | -56.278 | -54.687 |
| T2 | level of the first sample after the voice came back (the size of the step from zero), dBFS | 30 | -61.842 | -23.776 | -12.426 | -11.468 |
| T2 | same, against the RMS of the next 20 ms (dB; around 0 or above: a click as large as the speech) | 30 | -22.054 | -1.511 | 4.893 | 6.941 |
| T2 | audio-worklet frame labels that repeated inside a burst of blocks (a recorder bookkeeping count, not audio) | 30 | 0.000 | 5.500 | 15.000 | 16.000 |
| T2 | largest sample in the silence (dBFS; -240 is digital zero) | 30 | -240.000 | -240.000 | -240.000 | -240.000 |
| T2 | main-thread time of the first call (ms) | 30 | 0.000 | 0.100 | 0.400 | 0.400 |
| T2 | ctx.outputLatency at the end of the trial (ms) | 30 | 24.000 | 32.000 | 40.000 | 40.000 |
| T2 | longest gap between the page's 100 ms feeder ticks (ms) | 30 | 109.333 | 112.000 | 112.000 | 120.000 |
| T3 | played count of stop()/pause() minus source samples that reached the tap (samples) | 30 | -1.000 | -0.600 | -0.000 | 0.000 |
| T3 | same, in ms (negative: the player under-counts) | 30 | -0.023 | -0.014 | -0.000 | 0.000 |
| T3 | played(1) every 100 ms during steady play, max |error| against the tap (ms) | 30 | 0.005 | 0.018 | 0.023 | 0.023 |
| T3 | same after the voice came back, max |error| (ms) | 30 | 0.014 | 0.018 | 0.023 | 2.658 |
| T3 | continuity: source skipped (+) or repeated (-) across the silence (ms) | 30 | -0.000 | -0.000 | 0.000 | 0.000 |
| T3 | lowest correlation of any 40 ms window after the voice came back | 30 | 1.000 | 1.000 | 1.000 | 1.000 |
| T3 | level of the last non-zero sample before silence (the size of the step to zero), dBFS | 30 | -104.460 | -68.422 | -59.349 | -56.903 |
| T3 | level of the first sample after the voice came back (the size of the step from zero), dBFS | 30 | -61.222 | -25.351 | -16.086 | -13.619 |
| T3 | same, against the RMS of the next 20 ms (dB; around 0 or above: a click as large as the speech) | 30 | -31.689 | -1.891 | 4.788 | 4.856 |
| T3 | audio-worklet frame labels that repeated inside a burst of blocks (a recorder bookkeeping count, not audio) | 30 | 0.000 | 7.000 | 14.000 | 15.000 |
| T3 | largest sample in the silence (dBFS; -240 is digital zero) | 30 | -240.000 | -240.000 | -240.000 | -240.000 |
| T3 | main-thread time of the first call (ms) | 30 | 0.000 | 0.100 | 0.200 | 0.300 |
| T3 | ctx.outputLatency at the end of the trial (ms) | 30 | 24.000 | 32.000 | 40.000 | 40.000 |
| T3 | longest gap between the page's 100 ms feeder ticks (ms) | 30 | 109.333 | 110.667 | 112.000 | 112.000 |
| T4 | played count of stop()/pause() minus source samples that reached the tap (samples) | 30 | -0.800 | -0.500 | 0.000 | 0.000 |
| T4 | same, in ms (negative: the player under-counts) | 30 | -0.018 | -0.011 | 0.000 | 0.000 |
| T4 | played(1) every 100 ms during steady play, max |error| against the tap (ms) | 30 | 0.005 | 0.018 | 0.023 | 0.023 |
| T4 | same after the voice came back, max |error| (ms) | 30 | 0.014 | 0.018 | 2.662 | 2.662 |
| T4 | continuity: source skipped (+) or repeated (-) across the silence (ms) | 30 | -0.000 | -0.000 | 0.000 | 0.000 |
| T4 | lowest correlation of any 40 ms window after the voice came back | 30 | 1.000 | 1.000 | 1.000 | 1.000 |
| T4 | T4: lowest correlation over the three held pieces | 30 | 1.000 | 1.000 | 1.000 | 1.000 |
| T4 | level of the last non-zero sample before silence (the size of the step to zero), dBFS | 30 | -112.331 | -69.451 | -59.610 | -56.278 |
| T4 | level of the first sample after the voice came back (the size of the step from zero), dBFS | 30 | -69.642 | -24.913 | -15.942 | -12.426 |
| T4 | same, against the RMS of the next 20 ms (dB; around 0 or above: a click as large as the speech) | 30 | -40.963 | -3.200 | 6.021 | 7.229 |
| T4 | audio-worklet frame labels that repeated inside a burst of blocks (a recorder bookkeeping count, not audio) | 30 | 0.000 | 8.000 | 23.000 | 25.000 |
| T4 | largest sample in the silence (dBFS; -240 is digital zero) | 30 | -240.000 | -240.000 | -240.000 | -240.000 |
| T4 | main-thread time of the first call (ms) | 30 | 0.000 | 0.100 | 0.300 | 0.300 |
| T4 | ctx.outputLatency at the end of the trial (ms) | 30 | 24.000 | 40.000 | 40.000 | 40.000 |
| T4 | longest gap between the page's 100 ms feeder ticks (ms) | 30 | 109.333 | 112.000 | 112.000 | 112.000 |
| T5 | played count of stop()/pause() minus source samples that reached the tap (samples) | 30 | -0.800 | -0.400 | -0.000 | -0.000 |
| T5 | same, in ms (negative: the player under-counts) | 30 | -0.018 | -0.009 | -0.000 | -0.000 |
| T5 | played(1) every 100 ms during steady play, max |error| against the tap (ms) | 30 | 0.009 | 0.018 | 0.023 | 0.023 |
| T5 | same after the voice came back, max |error| (ms) | 30 | 0.009 | 0.018 | 2.658 | 2.667 |
| T5 | continuity: source skipped (+) or repeated (-) across the silence (ms) | 30 | -0.000 | -0.000 | 0.000 | 0.000 |
| T5 | lowest correlation of any 40 ms window after the voice came back | 30 | 1.000 | 1.000 | 1.000 | 1.000 |
| T5 | level of the last non-zero sample before silence (the size of the step to zero), dBFS | 30 | -99.101 | -64.614 | -56.278 | -56.185 |
| T5 | level of the first sample after the voice came back (the size of the step from zero), dBFS | 30 | -84.449 | -21.521 | -12.426 | -12.426 |
| T5 | same, against the RMS of the next 20 ms (dB; around 0 or above: a click as large as the speech) | 30 | -44.750 | -1.776 | 5.527 | 5.870 |
| T5 | audio-worklet frame labels that repeated inside a burst of blocks (a recorder bookkeeping count, not audio) | 30 | 0.000 | 6.500 | 11.000 | 25.000 |
| T5 | largest sample in the silence (dBFS; -240 is digital zero) | 30 | -240.000 | -240.000 | -240.000 | -240.000 |
| T5 | main-thread time of the first call (ms) | 30 | 0.000 | 0.100 | 0.200 | 0.200 |
| T5 | ctx.outputLatency at the end of the trial (ms) | 30 | 24.000 | 32.000 | 40.000 | 40.000 |
| T5 | longest gap between the page's 100 ms feeder ticks (ms) | 30 | 109.333 | 112.000 | 120.000 | 120.000 |
| T6 | played count of stop()/pause() minus source samples that reached the tap (samples) | 30 | -1.000 | -0.600 | -0.000 | 0.000 |
| T6 | same, in ms (negative: the player under-counts) | 30 | -0.023 | -0.014 | -0.000 | 0.000 |
| T6 | played(1) every 100 ms during steady play, max |error| against the tap (ms) | 30 | 0.005 | 0.018 | 0.023 | 0.023 |
| T6 | T6: level of the first 100 ms of utterance 2 against the source (dB) | 30 | 0.000 | 0.000 | 0.000 | 0.000 |
| T6 | level of the last non-zero sample before silence (the size of the step to zero), dBFS | 30 | -117.585 | -67.180 | -60.363 | -59.654 |
| T6 | audio-worklet frame labels that repeated inside a burst of blocks (a recorder bookkeeping count, not audio) | 30 | 0.000 | 5.000 | 13.000 | 13.000 |
| T6 | largest sample in the silence (dBFS; -240 is digital zero) | 30 | -240.000 | -240.000 | -240.000 | -240.000 |
| T6 | main-thread time of the first call (ms) | 30 | 0.000 | 0.100 | 0.300 | 0.400 |
| T6 | ctx.outputLatency at the end of the trial (ms) | 30 | 24.000 | 36.000 | 40.000 | 40.000 |
| T6 | longest gap between the page's 100 ms feeder ticks (ms) | 30 | 109.333 | 112.000 | 120.000 | 120.000 |
| T7 | played count of stop()/pause() minus source samples that reached the tap (samples) | 12 | -0.800 | -0.500 | 0.000 | 0.000 |
| T7 | same, in ms (negative: the player under-counts) | 12 | -0.018 | -0.011 | 0.000 | 0.000 |
| T7 | played(1) every 100 ms during steady play, max |error| against the tap (ms) | 12 | 0.005 | 0.016 | 2.649 | 2.649 |
| T7 | level of the last non-zero sample before silence (the size of the step to zero), dBFS | 12 | -98.008 | -64.506 | -56.278 | -56.278 |
| T7 | audio-worklet frame labels that repeated inside a burst of blocks (a recorder bookkeeping count, not audio) | 12 | 1.000 | 6.000 | 18.000 | 18.000 |
| T7 | largest sample in the silence (dBFS; -240 is digital zero) | 12 | -240.000 | -240.000 | -240.000 | -240.000 |
| T7 | main-thread time of the first call (ms) | 12 | 0.000 | 0.200 | 0.400 | 0.400 |
| T7 | ctx.outputLatency at the end of the trial (ms) | 12 | 32.000 | 40.000 | 40.000 | 40.000 |
| T7 | longest gap between the page's 100 ms feeder ticks (ms) | 12 | 109.333 | 112.000 | 112.000 | 112.000 |

## Failing trials

- T1-01 (moment 24.415 s): accounting. m: {"silenceMs":0,"acctDiffMs":-32.014}
- T1-02 (moment 20.018 s): accounting. m: {"silenceMs":-0.5,"acctDiffMs":-40.005}
- T1-03 (moment 14.654 s): accounting. m: {"silenceMs":0,"acctDiffMs":-32.018}
- T1-04 (moment 12.302 s): accounting. m: {"silenceMs":0,"acctDiffMs":-40.014}
- T1-05 (moment 7.338 s): accounting. m: {"silenceMs":-0.812,"acctDiffMs":-40.018}
- T1-06 (moment 2.683 s): accounting, accountingHeard. m: {"silenceMs":5.958,"acctDiffMs":-48.009}
- T1-07 (moment 18.893 s): accounting. m: {"silenceMs":-0.021,"acctDiffMs":-32.005}
- T1-08 (moment 17.214 s): accounting. m: {"silenceMs":0,"acctDiffMs":-40.014}
- T1-09 (moment 11.088 s): accounting. m: {"silenceMs":-0.021,"acctDiffMs":-40.009}
- T1-11 (moment 24.079 s): accounting. m: {"silenceMs":0,"acctDiffMs":-40.023}
- T1-12 (moment 8.978 s): accounting. m: {"silenceMs":-0.083,"acctDiffMs":-40.005}
- T1-13 (moment 10.16 s): accounting. m: {"silenceMs":0,"acctDiffMs":-40.009}
- T1-14 (moment 4.823 s): accounting. m: {"silenceMs":-0.042,"acctDiffMs":-32.018}
- T1-15 (moment 6.293 s): accounting. m: {"silenceMs":0,"acctDiffMs":-32}
- T1-16 (moment 21.51 s): accounting. m: {"silenceMs":0,"acctDiffMs":-40}
- T1-17 (moment 18.197 s): accounting. m: {"silenceMs":-0.021,"acctDiffMs":-40.009}
- T1-18 (moment 13.703 s): accounting, accountingHeard. m: {"silenceMs":2.646,"acctDiffMs":-42.68}
- T1-19 (moment 16.116 s): accounting. m: {"silenceMs":-0.021,"acctDiffMs":-40}
- T1-20 (moment 5.224 s): accounting. m: {"silenceMs":-0.042,"acctDiffMs":-40}
- T1-21 (moment 23.011 s): accounting. m: {"silenceMs":0,"acctDiffMs":-40.018}
- T1-22 (moment 21.137 s): accounting. m: {"silenceMs":-1.208,"acctDiffMs":-40.018}
- T1-23 (moment 8.75 s): accounting. m: {"silenceMs":-0.021,"acctDiffMs":-32.018}
- T1-24 (moment 3.206 s): accounting. m: {"silenceMs":-0.083,"acctDiffMs":-24}
- T1-25 (moment 11.302 s): accounting. m: {"silenceMs":-1.187,"acctDiffMs":-32.009}
- T1-26 (moment 15.284 s): accounting. m: {"silenceMs":0,"acctDiffMs":-32.018}
- T1-27 (moment 22.496 s): accounting. m: {"silenceMs":0,"acctDiffMs":-32.014}
- T1-28 (moment 13.491 s): accounting. m: {"silenceMs":0,"acctDiffMs":-32.014}
- T1-29 (moment 7.809 s): accounting. m: {"silenceMs":0,"acctDiffMs":-32.005}
- T1-30 (moment 4.016 s): accounting. m: {"silenceMs":-0.042,"acctDiffMs":-32.014}
- T1-x1 (moment 24.873 s): accounting. m: {"silenceMs":-0.271,"acctDiffMs":-32}

## Invalid trials (left out of the numbers)

- T1-10: the call could not wait for a moment with energy; the call landed on a pause (last 100 ms at -86.6 dBFS)
- T2-10: the call could not wait for a moment with energy; the call landed on a pause (last 100 ms at -72.9 dBFS)
- T2-29: the call could not wait for a moment with energy; the call landed on a pause (last 100 ms at -58.5 dBFS)
- T5-15: the call could not wait for a moment with energy; the call landed on a pause (last 100 ms at -62.9 dBFS)
- T6-14: the call could not wait for a moment with energy; the call landed on a pause (last 100 ms at -77.7 dBFS)
- T6-21: the call could not wait for a moment with energy; the call landed on a pause (last 100 ms at -47.1 dBFS)
