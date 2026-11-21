# Echo probe

Measures, on one machine, how much of the assistant's own voice survives the browser's echo canceller and how the canceller
treats a short word spoken by a person while the assistant talks. The page copies the call's audio path
(`packages/ui/src/model/voice/browser.ts`, `player.ts`, `capture.ts`): one `AudioContext({latencyHint: "interactive"})`, the
shipped capture worklet, `AudioBufferSourceNode` -> `GainNode` -> destination.

Two microphone streams are open at the same time from the same device:

- **A**: `echoCancellation`, `noiseSuppression`, `autoGainControl` on (what the app asks for),
- **B**: all three off (the raw microphone; the device may give two channels, channel 0 is used).

A third worklet instance taps the gain node, so the exact PCM that was played reaches the same 16 kHz, 512-sample framing on
the same audio clock. Every frame carries the worklet's `currentFrame` and its arrival `performance.now()`.

The real microphone and speakers are used (no fake-device flags; only the permission prompt is auto-accepted). The tool reads
devices and never changes a volume, a mute, a default device or a privacy setting. The room is part of the measurement: run it
with nobody talking and nothing else playing, and read the ambient numbers in the summary before any other number.

## Files

| File | Runs on | Purpose |
| --- | --- | --- |
| `probe.html` | Edge | the page (`window.probe`), served by the driver |
| `driver.mjs` | Windows, Node 22 | serves the page and assets, starts a PowerShell `SoundPlayer` helper, launches `msedge.exe` with a throwaway profile, drives the page over DevTools, writes the recordings |
| `analyze.mjs`, `analyze.sh` | WSL, Node 22 | numbers from the recordings, with the shipped Silero VAD and recogniser (`packages/server/dist`, build it first) |
| `endpoints.ps1` | Windows PowerShell | read-only: master volume and mute flag of the default speakers and microphone (`IAudioEndpointVolume` getters), run by the driver before it plays anything |
| `inject-test.mjs` | WSL, Node 22 | validation: adds a modelled echo, clicks and words, at known levels and delays, to recordings made with silent speakers, so `analyze.mjs` can be checked against ground truth |

## Run

Windows (the Node that ships with the app; there is no other on the PATH):

```powershell
& "$env:LOCALAPPDATA\Ancilla\node.exe" scripts\voice\echo-probe\driver.mjs --assets <dir> --out <dir> [--plan full|smoke|ambient] [--gate=-50 --gate-wait=20]
```

Before anything is played the driver reads (never sets) the audio endpoints and stops when the measurement could not mean
anything: the microphone is muted or all zeros (exit 3), the default speakers are muted at the Windows endpoint (exit 4,
`--allow-muted` overrides), or the default output looks like headphones, earbuds or a headset (exit 5, `--allow-headphones`
overrides). A person has to fix those: the tool never changes a volume, a mute or a default device.

`--assets` holds `reply-en-native.wav`, `reply-pt-native.wav` (44.1 kHz) and the `stop-*-16k.wav` clips. `--plan reftest`
needs no audible speakers and checks that the reference tap stays on the microphone's clock after a long silence. `--gate` waits (up to
`--gate-wait` seconds) until the raw microphone has been quieter than the gate for one second before each run. The window stays
open for the whole plan (about 7 minutes); if someone closes it the driver starts it again and repeats the run.

Plan `full`: two 20 s ambient recordings (nothing playing), the English and Portuguese replies alone (25 s each), a 10-click
train, 12 words alone (no reply), and six runs of the English reply with 7 words each played from another process at 0, -6
and -12 dB (14 per level). Words are played by `System.Media.SoundPlayer` in a PowerShell process that is not the browser,
so the browser's canceller cannot know them. The driver stamps `Stopwatch.GetTimestamp()` right before `Play()`; that counter,
Node's `process.hrtime()` and the page's `performance.now()` are all QueryPerformanceCounter, and the driver measures their
offset with DevTools round trips and with HTTP pings from the page.

WSL:

```bash
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash -l /home/<you>/.../scripts/voice/echo-probe/analyze.sh /mnt/c/.../<out>
analyze.sh --selftest    # checks the estimators on synthetic signals
```

## Output

Per run `<id>`: `<id>-A.wav` (processed microphone), `<id>-B.wav` (raw microphone), `<id>-ref.wav` (what was played), all
16 kHz mono 16-bit on one sample grid (sample `i` of the three files is the same instant on the audio clock), and `<id>.json`
(frame stamps, plays, events, clock offsets). `analyze` writes `results.json` and `summary.md`.

## Method notes

- **Echo power** is estimated two ways: plain RMS over the 20 ms windows where the reference is active (shifted by the
  measured lag), and magnitude-squared coherence with the reference (the part of the microphone that is linearly related to
  what was played), which ignores uncorrelated room sound. The coherence estimator's own floor is measured with lags that
  cannot hold an echo; a value inside the floor is reported as "not detected", with the bound.
- **Lag** is the peak of the pre-emphasised cross-correlation of the reference with the raw stream. **Round trip** is measured
  with a train of 3 ms chirp-clicks played through the same context and matched-filtered in the raw stream.
- **Words** are found with a matched filter against the exact clip that was played, searched only in a window of plausible
  delays after the call. A word counts as found when its peak beats 98% of the same peak statistic over windows of the run
  that hold no word (a z-score is wrong in a room with speech in it: speech correlates with a speech clip).
- The 10 dB onset rule uses 512-sample frames: the first frame at or after the call whose level is 10 dB above the median of
  the 20 frames before it. It is reported only when it falls within 150 ms of the matched word.
- Time inside the analysis is sample counts on the audio clock; the WSL wall clock is never read.
- **The reference tap needs a keep-alive.** A worklet whose input has been silent for a while is handed no samples, so its
  frames skip the silent stretches and the reference recording drifts off the microphone's clock by seconds (found by the
  injection test: 3 of 10 clicks, 1.15 s early). The page now feeds the tap a constant of -100 dBFS (0 in the 16-bit files,
  never sent to the speakers), and every export records the reference-versus-microphone skew; the driver warns above 37 ms.
- **Validation.** `inject-test.mjs` adds a modelled echo (ERL 24 dB with a second reflection), 3 ms clicks and words to real
  recordings made with silent speakers. On those, `analyze.mjs` recovered the click delays to 0.002 ms, the word delays to
  0.00 ms and the word levels to within 0.4 dB, and found 90 to 96% of the words, including ones 12 dB below the room noise;
  the misses coincide with loud room bursts. Echo lag was exact; ERL and ERLE agreed with the injection within the effect of
  its reflection.

## Limits

- Anything the operating system does to the microphone before the browser sees it (a driver effect, Voice Clarity) is in both
  A and B and cannot be separated here.
- `SoundPlayer` start-up (tens of milliseconds, from `Play()` to sound) is inside every "call to word" delay; A minus B
  differences are unaffected.
- Chromium's echo canceller takes its reference from the browser's own output, so the clips (another process) are unknown to
  it, which is the point. A different canceller (an app's own, Windows' voice processing) is not measured.
