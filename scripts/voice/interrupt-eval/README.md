# Spoken interruption: the paired evaluation

What it measures, and how to run it again. The results, the sources and the decisions are in
[docs/voice-interrupt-evaluation.md](../../../docs/voice-interrupt-evaluation.md).

## What runs

A real `VoiceSession` (the voice code of a built checkout) with the real engines (Silero VAD, the streaming and the
re-reading recogniser, the voice) is driven **in real time** by a simulated page: it plays what the server sends on a
speaker timeline with the device's output latency, flushes on `interrupted`, pauses and resumes on `pause` and `resume`
(with a lease, like `WebPlayer`), reports playback, and feeds the microphone with the person's audio plus a modelled
residue of the speaker output (the echo level is an episode parameter). Time is the episode's own: everything is stamped on
one monotonic axis; nothing reads the wall clock (the WSL clock of the development machine is stepped back every 30 s).

The same episodes are run on three **arms**, back to back, in alternating order, with the same audio:

- `baseline=<root>`: the voice code of that checkout as it is (point it at a checkout of the tag `v0.30.0`);
- `pilot=<root>:pilot`: a build with the spoken-interruption setting on and a page that can pause;
- `tuned=<root>:tuned`: the shipped pipeline tuned by settings alone, with no new states: the quick reading of the speech
  detector, two frames to begin a turn, 96 ms of sound and 0.4 probability to cut in, 160 ms without words, ducking after 32 ms.
  It is what a tuned version of what shipped can do, and the answer to "is a new state machine needed?".

All arms run on one set of voice engines (the pilot build's). `engines-equal.mjs` shows, on the same audio, that its speech
detector and recogniser give the baseline build's probabilities and words exactly, so sharing them favors no arm.

## The episodes (`episodes.mjs`)

120 paired episodes (English and Brazilian Portuguese, half each) plus 40 ordinary turns for the latency gate:

| Class | n | What the person does over a long spoken reply | Right outcome |
| --- | --- | --- | --- |
| stop | 40 | a short stop word ("Stop.", "Wait.", "Pare.", "Chega."...) | the old audio is silenced, once, without a restatement; nothing else is answered |
| correction | 40 | "No, I meant Tuesday." (a quarter with a pause inside it, a fifth while the first answer is still being fetched by a model that cannot be interrupted) | the old audio is silenced; the correction is heard; exactly one corrected answer; no task started twice, none from the cut-off answer |
| control | 40 | a sound of listening (15), a cough (5), a throat cleared (5), the assistant's own echo (5), keyboard clicks (5), distant speech 24 dB below the person (5) | the reply is not cut off and no turn is made |
| ordinary | 40 | a question, nobody interrupting | first sound of the answer, for the latency gate |

Every episode begins as a call does: the person speaks (in the voice and at the level of the rest of the episode), the
assistant answers at length, and the sound under test starts 2.2 to 6.5 s after the first sound of the answer, while the
voice is audible and has more queued. Voices: `dev` voices (Supertonic F2/M2/F3/M3 in both languages) are for tuning and
were looked at; `heldout` voices (Supertonic F4/F5/M4/M5 in both languages, and Kokoro US and GB English voices, a different
model) were not looked at while tuning. The residual echo is spread over {none, -50, -40} dB below the voice (the echo
controls use -45, -40 and -35 dB).

The words to be read were checked before any result existed: `slotcheck.mjs` says every correction phrase alone, with every
voice, to the real recogniser and lists the ones it misreads (the English Kokoro voices drop names their lexicon lacks; the
recogniser misreads some names), which is why the corrections use weekdays and a few well-read names.

## Run it

```
node scripts/voice/interrupt-eval/run.mjs --split heldout \
  --arm baseline=/path/to/checkout-of-v0.30.0 --arm pilot=$PWD:pilot --arm tuned=/path/to/checkout-of-v0.30.0:tuned \
  --runtime ~/voice-lab --models ~/voice-lab/models --out results.jsonl
node scripts/voice/interrupt-eval/report.mjs results.jsonl --failures pilot
```

`scripts/voice/interrupt-eval/reproduce.sh` does it all: it makes the checkout of v0.30.0, builds both, checks that their
engines agree, runs every class and the ordinary turns on the three arms in parallel shards and prints the report (the five
gates of the brief, the paired counts and the pilot's failures). It needs the voice pack (the same files the installer
downloads: `sherpa-onnx-node`, `silero_vad.onnx`, the two recognisers, Supertonic 3; and, for the English held-out voices, the
Kokoro multi-language model, which Ancilla does not ship) and about 35 minutes. Close other heavy programs first: the engines
run in real time, and a busy processor delays the recogniser, which the pilot waits for. Synthesis is not seeded, so a new run
renders the same texts as different audio; the arms are paired inside a run.

Options: `--kinds stop,correction,control,ordinary`, `--shard i/n` (run `n` processes in parallel with `i = 0..n-1`, one
file each, and give `report.mjs` all the files), `--limit N`, `--only id,id`, `--echo off,-50,-40`, `--seed N`.

## The other scripts

| Script | What it does |
| --- | --- |
| `slotcheck.mjs`, `stopcheck.mjs` | say every correction phrase, or every stop phrase, alone with every voice and report which ones the recogniser misreads |
| `engines-equal.mjs` | same audio through the engines of two builds: probabilities and words must be identical |
| `classify.mjs` | why an arm's episodes failed, by cause and language, and which late-brain corrections started a task |
| `framecost.mjs` | what the pilot adds to the work done for each 32 ms frame |
| `e2e/` | the page's own player (`WebPlayer`) in a real Edge: stop, pause, resume, drop, timed at the node before the audio device |
| `results/` | the raw lines of the two held-out runs, their reports, load samples and failure causes (see the `README.txt` in each) |

## What is scored (`run.mjs`, `report.mjs`)

- **Onset** is the first 10 ms window of the person's clean track above -42 dBFS (the track is trimmed to start 20 ms before it).
- **Silence** is the end of the last sample of the *old* utterance above -54 dBFS on the simulated speaker timeline.
  An episode whose old voice was not audible within [-30, +100] ms of the onset (a gap between two sentences) is not
  measured for latency and is counted separately.
- **Stop success without restatement**: the reply was cut off by that sound (not before it) and the old audio was silent
  within 2 s. **Within 350 ms** is the gate's latency.
- **Correction success**: that, and the corrected word reached the model in what the person said, and exactly one reply
  with the corrected word was said, and no tool call was run after the interruption, and none was repeated.
- **Control: false cancellation** is a reply cut off, or a turn made out of the sound. The **dip** (time the voice was
  ducked or paused) is reported beside it, because a pause that is later undone is not a cancellation but is heard.
- Intervals are Wilson 95%; `report.mjs` also prints the paired counts.

## Limits

The page, the speakers and the room are simulated, with the output latency of a real browser (25 ms) and a modelled
residue of echo; coughs and clicks are synthetic (a recording of a cough is not available here); the people are synthetic
voices. The real browser player is exercised separately (`e2e/`), the physical speaker and the browser's echo canceller
on this machine were not (the laptop's speakers were muted and the default output was a pair of earbuds while this was
made).
