# Spoken stop and correction: evaluation of a default-off pilot

Version 0.30.0 sometimes loses a short "Stop" said over the assistant's voice, while longer interjections work. This
document records why (measured), what the pilot does about it, how it was evaluated against 0.30.0, what each gate came to
(passed, failed or unverified), the sources behind the design, and how to switch it off. The pilot is the setting
`interruptPilot` in `voice.json` (Assistant, Voice, *Speak over it to stop it (pilot)*), off by default; with it off a call
is exactly what 0.30.0 made of it (a test holds this to the message, the sample and the virtual millisecond).

Everything below was measured on one machine (Intel Core Ultra 9 275HX, 24 cores, RTX 5070 Laptop 8 GB not used by the voice
engines, Windows 11 and WSL2 Ubuntu, Node 22.23.2, sherpa-onnx-node 2.0.1) with the engines the app ships. Published claims are
labelled as such and are never mixed with numbers from this machine.

## 1. Result in one table

Pilot against v0.30.0, 120 paired episodes with held-out voices, English and Brazilian Portuguese, second run (section 5).
Intervals are in section 5.

| Gate of the brief | Measured | Verdict |
| --- | --- | --- |
| At least 72/80 stops and corrections succeed without restatement, and 15 points above baseline | pilot 66/80, baseline 74/80 (10 points **below**). English 40/40, Portuguese 26/40 | **Failed** |
| At least 38/40 stops silence the old audio within 350 ms of the speech onset | 30/40 on the simulated speaker; median 140 ms, p95 178 ms (baseline 1/40, median 747 ms). English 20/20, Portuguese 10/20 | **Failed**; **unverified at the physical speaker** |
| At most 1/40 false cancellations | 6/40 (baseline 25/40, the same pipeline tuned by settings alone 33/40) | **Failed** |
| Zero duplicate tasks or unauthorized actions | 0 of each. The first run found a stale task in 6 of 8 late-brain corrections; fixed and run again | **Passed** |
| At most 100 ms added p95 latency to the first useful audio of an ordinary turn | the end-to-end measurement cannot resolve 100 ms (turn-to-turn variation of 0.5 s or more with other programs on the machine); the work the pilot adds is 0.40 ms per 32 ms frame | **Unverified end to end** |
| The strongest feasible model-based approach compared with a tuned version of the shipped pipeline | the shipped pipeline tuned by settings alone was measured; the open model was not (it needs a 4 MB download that was not approved) | **Unverified** |
| Off, the call is exactly v0.30.0 | whole-call golden traces recorded from a build of v0.30.0 are compared in a test, three ways of being off | **Passed** |
| Rollback | turn `interruptPilot` off (Assistant, Voice); nothing is migrated | n/a |

In English the pilot does what it was built for: 20 of 20 stops silence the old voice within 350 ms (median 141 ms against
747 ms), 20 of 20 corrections are answered once, and 1 of 20 control sounds cancels a reply (13 of 20 for v0.30.0). In
Portuguese it is limited by the recogniser: short Portuguese stop words are read correctly only 44 times in 64 when said
alone (69%, English 93 in 96), so 10 of 20 stops were not read and the voice went on. The pilot is off by default and lands
that way.

## 2. What was wrong: the missed "Stop", explained by measurement

The call listens while it speaks and decides from three things: how sure the speech detector is, how long the sound lasts,
and the words the streaming recogniser has written so far. Seven explanations were considered; the experiments that told
them apart are in `scripts/voice/interrupt-eval/` and the session notes, and the numbers are from the shipped engines.

| # | Explanation | Test | Verdict |
| --- | --- | --- | --- |
| 1 | The speech detector says "speech" late and not at all for a short soft word | the shipped Silero wrapper on 10 synthetic stop words, three thresholds; `min_speech_duration` 0 against 0.032 s | **Confirmed, and it is a setting**: with 0 for the minimum speech and silence (as in `engines/vad.ts`) sherpa-onnx-node 2.0.1 behaves as its defaults (0.25 s, 0.5 s): "speech" turned on 224 to 416 ms after the first energy (and never for two soft words at the 0.52 detector) and went on 0.54 to 1.44 s after the last. With 0.032 s and 0.064 s: on at 0 to 64 ms, off 64 to 320 ms |
| 2 | The streaming recogniser writes a short word too late to act on | first text of "Stop." in real time on the 160 ms streaming model | **Confirmed**: "Sto" at +700 ms and "Stop" at +1.0 s after the first energy, clean; the word is over by +400 ms. A decision on the words alone cannot come inside 350 ms, whatever else is done |
| 3 | The overlap is judged before the words exist, and the stream is thrown away when the sound ends | read of `session.ts` / `turn.ts`, then 24 runs on the shipped code | **Confirmed**: the stream is disposed at `overlap_end` (about 0.4 s), the recogniser's words come after it; the blind rule (`bargeInNoTextMs`, 0.42 s of sound with no words) cuts a reply on a "Yeah." and cannot see a word shorter than itself |
| 4 | Echo residue is taken for the person, or the person for echo | a modelled residue of the reply's own voice at -50, -40, -35 and louder, real engines | **Confirmed at -35 dB and louder**: the shipped call cut itself off before the person spoke, or took its own words for a turn; at -50 dB and below it was clean. How much a real browser canceller leaves on this machine's speakers was **not measured**: the speakers were muted at the Windows endpoint during the probe, so its recording describes silence (section 7) |
| 5 | Words the person says are dismissed as echo because they repeat the assistant's | `looksLikeEcho` on corrections that name what the assistant just said ("no, call Marta, not Ana") | **Confirmed in a correction episode**: any two words in a row that the assistant said in the last 2.5 s mark the sound as echo (the check is kept; the pilot does not apply it to a sound that is clearly louder than the echo) |
| 6 | The page flushes the playback late, or stale audio plays after the cut | the app's own player code (`WebPlayer`) in Edge 157.0.4341.60, 2.4 s queued ahead, 192 trials, timed at the node before the audio device with the output muted (`scripts/voice/interrupt-eval/e2e/RESULTS.md`) | **Not the cause**: `stop()` silences in the call's own audio block (median 0.00 ms, p95 2.67 ms, max 8.00 ms in 30 trials) and every later sample was exactly zero (30 of 30), also with audio held while paused (12 of 12). It is not the physical speaker, so the device's own delay (Edge reported 24 to 40 ms) is not in it. The same test found that `resume()` started the voice without a fade-in; that is fixed (commit 1d5de9d) and covered by a unit test, but not re-run in the browser |
| 7 | The 220 ms grace after the assistant stops, or the hold-until-quiet after a dismissal | code read; in none of the traces was a stop lost there | **Not the cause** here (it matters after the voice has stopped, not during) |

So the miss is not one defect. A short stop is (a) late to be called speech, (b) written down after it is over, and (c)
judged in a window that closes before the words arrive; and the blind rule that closes the gap does so by cutting off on
backchannels and on echo. On the episodes of this evaluation the baseline's stops reached silence a median of 747 ms after the
word began (95th percentile 840 ms; 1 of 40 within 350 ms), and cut the reply off for 25 of 40 sounds that were not stops.

## 3. The design, and the alternatives that were weighed

**Pause on onset, decide by the words, resume if it was not for the assistant.** In order:

1. Sound that the assistant's own voice does not explain pauses the voice within two frames (64 ms of sound, then the page
   fades it out in about 30 ms). Two things find the sound: a second, quicker reading of the same speech detector, and the
   microphone being louder than the echo ratio learned while the assistant speaks alone (the server knows exactly what it
   sent: `PlayoutLevels`). The pause keeps the place; the page holds what arrives meanwhile and has a lease, so a lost
   message or a dropped connection cannot leave the voice silent.
2. The recogniser is asked for its last words as soon as the sound ends, and says when it has read them out.
3. A stop word cuts the reply off and nothing is answered (a stop is silence; a task keeps running and cancelling one still
   needs the existing question and a yes). Other words (three or more as soon as they are read, two or more at the last
   reading, or a plain "yes" when something has just been asked) are the person taking the turn: the reply is cut off at what was
   heard, with what was heard exact, and what they said is answered once. A single word that is not a stop, a sound of listening,
   a hesitation, thanks, a cough that the recogniser writes as a word, its own words, a voice much quieter than the person's
   (far away), or nothing readable: the voice goes on from the same sample.
4. **Nothing is cancelled by sound alone**, and nothing a person says over the voice approves anything.
5. While the voice is held, or the person is speaking, a task that the reply asks for is not started: if they take the floor it
   is never started, and if not it starts a moment late (at most 4 s). If the reply ends while its voice is held, what is held is
   thrown away and not played late.

The decision logic is `packages/server/src/voice/interrupt.ts`: pure TypeScript with no clock, no audio and no Node
module in it (time and levels are passed in), next to `turn.ts`, behind two small seams: what the host hands it
(`InterruptObservation`: time, speech probability, the microphone's loudness, the assistant's loudness) and what it asks
the host to do (`InterruptCommand`: open, pause, resume, interrupt, settle, close). Whether any Android client will use it
is not decided here: the repository has no Android code and no plan for one (the only mentions are transitive Rust crates in
the notices), so nothing Android-specific was built.

| Approach | What it gives | Why it was not the pilot |
| --- | --- | --- |
| **Tune the shipped rules** (quick detector, lower thresholds, shorter windows, no new states) | cuts earlier | it must decide before the words exist; measured as the `tuned` arm (section 5): it silences at a median of 235 ms, but cuts the reply off for 33 of 40 control sounds and fails 10 of 40 corrections |
| **A trained acoustic interruption classifier** (the closest open one is pipecat `backchannel-detector`: BSD-2-Clause, 734k parameters per its card (961k in its safetensors), English only, sha `4896f4774cdf1a9c5b581b0cd4a0c4000e8bb854`) | no words needed; published median 280 to 300 ms to catch an interruption | published 82.9% and 81.2% caught within 700 ms (two English test sets, simulated echo), so it cannot reach 95% inside 350 ms alone, and it has no Portuguese; **not measured here**: running it needs a download (4 MB) that was not asked for |
| **Pause, then decide by the words** (this pilot) | silence at the speaker as early as the sound is found, cancellation only on words | costs a gap after a sound of listening (about 0.5 to 1 s); the words must be recognised |
| Speaker verification for other talkers | would also reject a person nearby | needs enrolment, and none of the open ones were fast enough (see the literature) |

The first stage is the design the literature has used since 2000 for the same problem: Ström and Seneff's "reduce and
listen" and "rewind and resume" (ICSLP 2000), Selfridge et al. (SIGDIAL 2013), LiveKit's pause and resume after a false
interruption, and a stop-phrase list that interrupts at once in Vapi's configuration.

## 4. How it was evaluated

The harness is `scripts/voice/interrupt-eval/`. Its README lists the options, and `reproduce.sh` runs everything below with
one command (about 35 minutes on this machine).

**What runs.** A real `VoiceSession` built from a checkout, with the engines the app ships (the Silero speech detector, the
160 ms streaming recogniser, the offline re-reading recogniser, Supertonic 3 for the assistant's voice), driven in real time
by a simulated page. The page plays what the server sends on a speaker timeline with 25 ms of output latency, flushes on
`interrupted`, pauses and resumes on `pause` and `resume` (with a lease, as `WebPlayer` does), reports what it has played, and
feeds the microphone with the person's audio plus a modelled residue of the speaker output at a set level. Time is the
episode's own: every event is stamped on one monotonic axis, and nothing reads the wall clock (the WSL clock of the
development machine runs about 9% fast and is stepped back about 2.6 s every 30 s).

**Arms**, run on the same audio back to back, in alternating order:

- `baseline`: a checkout of the tag v0.30.0 (`1dcaa1f9a39ce9a26aefdb459cbc9a110b1aae8c`), built and unmodified.
- `pilot`: this change, with `interruptPilot` on and a page that can pause.
- `tuned`: v0.30.0's own session code with settings alone changed (the quick reading of the speech detector, two frames to
  begin a turn, 96 ms of sound and probability 0.4 to cut in, 160 ms without words before cutting in, ducking after 32 ms).
  It is the best version of the shipped design that needs no new state, and it answers whether the pilot is needed.

All three run on one set of voice engines (the pilot build's). `engines-equal.mjs` feeds the same audio to the engines of both
builds and requires identical speech-detector probabilities and recogniser words: 585 frames compared, none differ (largest
difference 0), and 6 of 6 readings are the same (`results/*/engines-equal.txt`).

**Episodes.** 120 paired episodes, half English and half Brazilian Portuguese, and 40 ordinary turns:

| Class | n | What the person does over a long spoken reply | Right outcome |
| --- | --- | --- | --- |
| stop | 40 | a short stop word ("Stop.", "Wait.", "Pare.", "Chega."...) | the old audio is silenced, once, without a restatement; nothing else is answered |
| correction | 40 | "No, I meant Tuesday." (a quarter with a pause inside it; a fifth while the first answer is still being fetched by a model that cannot be interrupted) | the old audio is silenced; the correction is heard; exactly one corrected answer; no task started twice, none from the cut-off answer |
| control | 40 | a sound of listening (15), a cough (5), a throat cleared (5), the assistant's own echo (5), keyboard clicks (5), distant speech 24 dB below the person (5) | the reply is not cut off and no turn is made |
| ordinary | 40 | a question, nobody interrupting | first sound of the answer, for the latency gate |

Every episode begins as a call does: the person speaks (in the voice and at the level of the rest of the episode), the
assistant answers at length, and the sound under test starts 2.2 to 6.5 s after the first sound of the answer, while the voice
is audible and has more queued. The residual echo is spread over none, -50 dB and -40 dB below the voice (the echo controls
use -45, -40 and -35 dB).

**Voices.** The development voices (Supertonic F2, M2, F3, M3, in both languages) were used while building and were looked at.
The held-out voices were not looked at: Supertonic F4, F5, M4, M5 in both languages and, for English, Kokoro US and GB voices (a
different model; Portuguese has none in the pack). Synthesis is not seeded: running again renders the same texts as different
audio, and the arms are paired inside one run.

**The words to be read.** Two flaws of the first set of episodes were found by saying every correction phrase alone, with
every voice, to the real recogniser (`slotcheck`, 144 readings) before any held-out result existed: the English Kokoro voices
silently drop names their lexicon lacks (Ana, Carla, Bruno, Marta, Pedro), and the recogniser misreads some names (Carla as
"cala", Marta as "Mar"). The corrections now use weekdays in English (all 12 clean readings right) and weekdays and the names
Marta and Bruno in Portuguese (7 to 8 of 8 right). That check involved neither the pilot nor the baseline. A slot word that the
recogniser still misreads costs every arm the same; those failures are listed separately in section 6.

**What counts.**

- *Onset* is the first 10 ms window of the person's clean track above -42 dBFS. *Silence* is the end of the last sample of the
  old utterance above -54 dBFS on the simulated speaker timeline; an episode in which the old voice was not audible within
  [-30, +100] ms of the onset (a gap between two sentences) is reported as such.
- *Stop, success without restatement*: the reply was cut off by that sound (not before it) and the old audio was silent within
  2 s. *Within 350 ms* is the latency gate.
- *Correction, success*: the same, and the corrected word was heard, and exactly one answer with the corrected word was said,
  and no task was run after the interruption, and none was run twice.
- *Control, false cancellation*: the reply was cut off, or a turn was made out of the sound. The *dip* (how long the voice was
  ducked or paused) is reported beside it, because a pause that is later undone is not a cancellation but is heard.
- Intervals are Wilson 95%. The raw lines of every run are in `scripts/voice/interrupt-eval/results/`.

**Two runs.** The held-out episodes were run twice. The first run (commit 572b0f0) found a defect in the pilot (a stale task,
section 5.4) and a gap in the scorer, which counted tasks only after an interruption message. The pilot's task hold was fixed,
the scorer now counts every task started after the person began to correct, a message that throws away a held voice counts as a
cut, and the episodes were run again with two shards instead of three (commit 1d5de9d). The gates are judged on the second
run, the code that lands. The held-out voices had been looked at by then, and nothing else in the pilot changed between the
runs (the page's fade-in on resume, which the episodes do not exercise, was fixed in the same commit).

## 5. Results per gate

### 5.1 The gates, second run (the code that lands)

Commit 1d5de9d, two parallel shards (`results/20261120-rerun/`, load average 16 on average on 24 cores, other programs
included: `load.txt`). The thresholds are the brief's; the verdict of the fifth is explained under the table.

| # | gate | measured | verdict |
| --- | --- | --- | --- |
| 1 | stops and corrections that succeed without restatement: at least 72/80 and 15 points above baseline | 66/80 (73%-89%); baseline 74/80 (85%-97%); -10.0 points | **FAIL** |
| 2 | stops that silence the old audio within 350 ms of speech onset: at least 38/40, on the simulated speaker | 30/40 (60%-86%); baseline 1/40 (0%-13%) | **FAIL**; physical speaker unverified |
| 3 | false cancellations in the controls: at most 1/40 | 6/40 (7%-29%); baseline 25/40 (47%-76%) | **FAIL** |
| 4 | duplicate tasks and unauthorized actions: zero | duplicate tasks 0; tasks started after the person began to correct 0; tasks in episodes that asked for none 0; baseline 0 | **PASS** |
| 5 | added p95 latency to the first sound of an ordinary answer: at most 100 ms | see below | **unverified** |

Gate 5. The first sound of an ordinary answer came 2.4 s after the end of the question for both arms at the median (2375 ms
baseline, 2395 ms pilot), and the 95th percentile differs by +3267 ms in this run, whichever way the machine's other programs
pushed that turn. A repeat of the ordinary turns alone, one process, gave p95 3496 ms for the baseline and 3007 ms for the pilot
(-489 ms added; +496 ms for the paired differences; `results/20261120/ordinary-quiet.jsonl`). The same threshold gives +3267 ms
in one run and -489 ms in the other, so the measurement cannot resolve 100 ms on this machine and the report script's own
"FAIL" for it is not a finding. What was measured instead is the work the pilot adds to each 32 ms frame of the microphone,
which is all it adds to an ordinary turn (it only listens for an interruption while the assistant speaks): the quick reading of
the speech detector takes 0.40 ms against 0.50 ms for the shipped one, and the judge's step 3 microseconds
(`framecost.mjs`: 1.3% of one core at real time). An added delay of 100 ms from that is not plausible, and the end-to-end
figure is **unverified**.

### 5.2 Each class, second run

#### stop

| arm | success without restatement | silenced within 350 ms | silence latency, median / p95 (ms) |
| --- | --- | --- | --- |
| baseline | 36/40 (77%-96%) | 1/40 (0%-13%) | 747 / 840 |
| pilot | 30/40 (60%-86%) | 30/40 (60%-86%) | 140 / 178 |
| tuned | 29/40 (57%-84%) | 29/40 (57%-84%) | 235 / 269 |

#### correction

| arm | success without restatement | silenced within 350 ms | silence latency, median / p95 (ms) | corrected word heard | exactly one corrected answer | tasks run after the cut / twice |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 38/40 (83%-99%) | 2/40 (1%-17%) | 740 / 877 | 39/40 (87%-100%) | 38/40 (83%-99%) | 0 / 0 |
| pilot | 36/40 (77%-96%) | 34/40 (71%-93%) | 139 / 1642 | 36/40 (77%-96%) | 36/40 (77%-96%) | 0 / 0 |
| tuned | 30/40 (60%-86%) | 33/40 (68%-91%) | 233 / 239 | 36/40 (77%-96%) | 34/40 (71%-93%) | 0 / 0 |

#### control

| arm | false cancellations | voice dipped or paused for more than 150 ms | dip, median / p95 (ms) |
| --- | --- | --- | --- |
| baseline | 25/40 (47%-76%) | 25/40 | 351 / 357 |
| pilot | 6/40 (7%-29%) | 29/40 | 547 / 1546 |
| tuned | 33/40 (68%-91%) | 8/40 | 97 / 417 |

#### ordinary

| arm | turns | first sound after the end of speech, median / p95 / max (ms) |
| --- | --- | --- |
| baseline | 40/40 | 2375 / 7947 / 11210 |
| pilot | 40/40 | 2395 / 11214 / 12920 |
| tuned | 40/40 | 2046 / 7404 / 7604 |

#### By language

#### stop

| arm | success without restatement | silenced within 350 ms | silence latency, median / p95 (ms) |
| --- | --- | --- | --- |
| baseline, lang en | 19/20 (76%-99%) | 0/20 (0%-16%) | 747 / 879 |
| pilot, lang en | 20/20 (84%-100%) | 20/20 (84%-100%) | 141 / 235 |
| tuned, lang en | 15/20 (53%-89%) | 15/20 (53%-89%) | 235 / 277 |
| baseline, lang pt | 17/20 (64%-95%) | 1/20 (1%-24%) | 747 / 792 |
| pilot, lang pt | 10/20 (30%-70%) | 10/20 (30%-70%) | 139 / 176 |
| tuned, lang pt | 14/20 (48%-85%) | 14/20 (48%-85%) | 236 / 265 |

#### correction

| arm | success without restatement | silenced within 350 ms | silence latency, median / p95 (ms) | corrected word heard | exactly one corrected answer | tasks run after the cut / twice |
| --- | --- | --- | --- | --- | --- | --- |
| baseline, lang en | 19/20 (76%-99%) | 2/20 (3%-30%) | 710 / 780 | 20/20 (84%-100%) | 19/20 (76%-99%) | 0 / 0 |
| pilot, lang en | 20/20 (84%-100%) | 20/20 (84%-100%) | 139 / 171 | 20/20 (84%-100%) | 20/20 (84%-100%) | 0 / 0 |
| tuned, lang en | 15/20 (53%-89%) | 15/20 (53%-89%) | 234 / 239 | 20/20 (84%-100%) | 18/20 (70%-97%) | 0 / 0 |
| baseline, lang pt | 19/20 (76%-99%) | 0/20 (0%-16%) | 745 / 903 | 19/20 (76%-99%) | 19/20 (76%-99%) | 0 / 0 |
| pilot, lang pt | 16/20 (58%-92%) | 14/20 (48%-85%) | 139 / 1647 | 16/20 (58%-92%) | 16/20 (58%-92%) | 0 / 0 |
| tuned, lang pt | 15/20 (53%-89%) | 18/20 (70%-97%) | 232 / 333 | 16/20 (58%-92%) | 16/20 (58%-92%) | 0 / 0 |

#### control

| arm | false cancellations | voice dipped or paused for more than 150 ms | dip, median / p95 (ms) |
| --- | --- | --- | --- |
| baseline, lang en | 13/20 (43%-82%) | 13/20 | 351 / 357 |
| pilot, lang en | 1/20 (1%-24%) | 14/20 | 545 / 792 |
| tuned, lang en | 16/20 (58%-92%) | 6/20 | 97 / 511 |
| baseline, lang pt | 12/20 (39%-78%) | 12/20 | 352 / 550 |
| pilot, lang pt | 5/20 (11%-47%) | 15/20 | 554 / 2944 |
| tuned, lang pt | 17/20 (64%-95%) | 2/20 | 96 / 194 |

#### The control sounds, by kind

| arm | false cancellations | voice dipped or paused for more than 150 ms | dip, median / p95 (ms) |
| --- | --- | --- | --- |
| baseline, sub backchannel | 15/15 (80%-100%) | 15/15 | 352 / 357 |
| pilot, sub backchannel | 1/15 (1%-30%) | 15/15 | 678 / 2944 |
| tuned, sub backchannel | 15/15 (80%-100%) | 3/15 | 97 / 194 |
| baseline, sub background | 5/5 (57%-100%) | 5/5 | 353 / 550 |
| pilot, sub background | 4/5 (38%-96%) | 5/5 | 924 / 1546 |
| tuned, sub background | 5/5 (57%-100%) | 1/5 | 97 / 189 |
| baseline, sub clicks | 0/5 (0%-43%) | 0/5 | 0 / 0 |
| pilot, sub clicks | 0/5 (0%-43%) | 0/5 | 0 / 0 |
| tuned, sub clicks | 2/5 (12%-77%) | 0/5 | 0 / 98 |
| baseline, sub cough | 1/5 (4%-62%) | 1/5 | 0 / 355 |
| pilot, sub cough | 0/5 (0%-43%) | 4/5 | 288 / 431 |
| tuned, sub cough | 2/5 (12%-77%) | 3/5 | 190 / 417 |
| baseline, sub echo | 2/5 (12%-77%) | 2/5 | 0 / 350 |
| pilot, sub echo | 0/5 (0%-43%) | 0/5 | 0 / 0 |
| tuned, sub echo | 4/5 (38%-96%) | 1/5 | 96 / 511 |
| baseline, sub throatclear | 2/5 (12%-77%) | 2/5 | 0 / 357 |
| pilot, sub throatclear | 1/5 (4%-62%) | 5/5 | 547 / 707 |
| tuned, sub throatclear | 5/5 (57%-100%) | 0/5 | 96 / 96 |

### 5.3 What was chosen, and why

The three arms answer the question of the brief. v0.30.0 succeeds on most stops and corrections (74 of 80) but late (747 ms
to silence) and by cutting on any sound (25 of 40 controls). Tuning its settings alone gets the silence to 235 ms and makes it
worse where it was already bad: 33 of 40 controls cut the reply, and 10 of 40 corrections fail. The pilot is the only arm with
the combination the brief asks for, in English: 20 of 20 stops within 350 ms, 20 of 20 corrections, 1 of 20 control sounds
cancelling a reply. The price is an audible pause after a sound of listening, and a dependence on the recogniser's reading
that caps Portuguese at 10 of 20 stops.

- **Benefit:** silence at 140 ms instead of 747 ms, and four times fewer false cancellations (6 against 25 of 40).
- **Effort:** one pure module (`interrupt.ts`), small seams in `turn.ts`, `session.ts` and the recogniser's protocol, and a page
  that can pause.
- **Regression risk:** contained by one default-off setting and by traces of v0.30.0 compared in a test. With the setting on,
  the pause is an audible change, and a Portuguese stop can be lost where the shipped call would have cut the reply late.

So the pilot lands off, behind its flag, and is not on for anyone by default. What would make it worth turning on for
Portuguese is a detector of short stops that does not wait for the recogniser's words (section 6).

### 5.4 The first run, before the fix

Commit 572b0f0, three parallel shards (`results/20261120/`). Other programs shared the machine: the load average was 31 on
average and 50 at most on 24 cores (`load.txt`), so the engines, which run in real time, were starved. Two things came out of
it, and the pilot was fixed for both before the second run:

- **A stale task.** In 6 of the 8 corrections that arrive while a task is being fetched by a model that cannot be interrupted,
  the pilot started the task of the answer being corrected, which the baseline and the settings-only arm did in none. The first
  scorer did not count it, because it counted tasks only after an interruption message and the pilot had sent none (it threw
  away the voice it held instead). The scorer now counts every task started after the person began to correct. The cause: the
  hold that keeps a task from starting while the person may be taking the floor let it go in the seconds between the end of
  the person's turn and the start of the answer to it, which is how long the recogniser took to read the last words.
- **Late readings.** Words that the recogniser read 4 to 11 s after they were said (5 corrections), and a reading that never
  came within the pilot's 4 s (2 corrections, where the voice went on, as it is designed to), are the cost of a decision that
  waits for words on a starved processor. The shipped call's blind rule does not wait for words.

| Class | baseline | pilot | settings-only |
| --- | --- | --- | --- |
| stops, success without restatement | 37/40 | 31/40 | 30/40 |
| stops silenced within 350 ms | 2/40 | 31/40 | 30/40 |
| corrections, success | 33/40 | 27/40 | 26/40 |
| controls, false cancellations | 25/40 | 6/40 | 33/40 |
| late-brain corrections that started the old task | 0/8 | **6/8** | 0/8 |

The first run's numbers for the ordinary turns (median first sound 9.0 s for the baseline, 9.3 s for the pilot) say only that
the machine was overloaded.

## 6. Remaining failures and limits

**What the second run still gets wrong** (the pilot's failed episodes, by cause; the ids are in `results/20261120-rerun/`):

| Cause | Episodes | Language | Which |
| --- | --- | --- | --- |
| A stop the recogniser read as nothing, so the voice went on | 10 stops | Portuguese 10 | stop-003, 007, 009, 011, 017, 023, 027, 029, 035, 039 |
| The corrected word was not read (a misreading, as "pedre" for "Pedro") | 4 corrections | Portuguese 4 | correction-059, 063, 073, 079 |
| Distant speech taken for the person (the call had no level of theirs to compare with) | 4 controls | Portuguese 4 | control-087, 095, 111, 119 |
| A "uh-huh" the recogniser wrote as words ("for two") | 1 control | English | control-118 |
| A throat cleared that cut the reply | 1 control | Portuguese | control-115 |

Nothing else failed: in English every stop (20 of 20) and every correction (20 of 20) succeeded. In the same run the
baseline lost 4 stops that nothing cut off, and cut the reply off for 25 of the 40 control sounds. The settings-only arm lost
11 stops and 10 corrections and cut the reply off for 33 of 40 control sounds (`results/20261120-rerun/failure-causes.txt`).

**What the pilot costs**

- **An audible pause after a sound that was not for the assistant.** The voice stops within about 0.1 s of the sound and goes on
  once the recogniser has read what it was, so the gap is the recogniser's time: in the 40 control sounds the voice was paused for a median of 547 ms
  and 1546 ms at the 95th percentile (678 ms and 2944 ms for the 15 sounds of listening). The shipped call only ducked the
  voice for about 0.35 s, and cut the reply off (25 of 40 control sounds, in both runs) instead. That gap is the price of never
  cancelling on sound alone; the only way to shorten it is to decide without the words.
- **A lone word that is not a stop does not take the floor.** "Tuesday." or "Marta." said over the voice is read as nothing to
  answer and the voice goes on; the person has to say more. This was chosen after a throat cleared was read as "Fine." and cut a
  reply, and it is the rule that keeps the false cancellations down.
- **A stop the recogniser cannot read is lost.** Said alone, with no call and no echo, the recogniser reads 93 of 96 English stop phrases
  as stops and 44 of 64 Portuguese ones (69%), and the misreadings are often English words ("Party", "Bye", "Despair",
  `results/20261120-rerun/stopcheck.txt`); 10 of the 20 Portuguese stops of the run were lost that way. The shipped call's blind rule (any sound of 0.42 s with no
  words) cut those, together with every cough and "mm-hm" (the false cancellations of the baseline arm). A model that tells a
  stop from a listening sound without words is what would close this; none was measured here (section 3).
- **A busy processor delays the reading the pilot waits for.** The decision waits for the recogniser's last words (it says when
  it has read them). If they have not come in 4 s the voice goes on by itself, which is safe and loses the stop. The first run
  was made on an overloaded machine and shows it (section 5.4); the second ran with less of its own load, and other programs
  still shared the machine (a load average of 16 on average and 61 at the highest, on 24 cores).
- **Distant speech is told from the person only when the call knows how loud the person is.** That is learned from the
  person's first confident turn, so a call whose first turn the recogniser read with low confidence has no reference, and
  speech 24 dB below the person's level can be taken for them.

**What this evaluation does not cover**

- **The physical speaker.** The latency gate is measured on the simulated speaker timeline, with 25 ms of output latency
  modelled. The page's player was timed in Edge at the node before the audio device with the output muted, and the acoustic
  probe of the room found the speakers muted at the Windows endpoint and the default output on earbuds; I changed no system
  setting. **Unverified at the physical speaker.** `scripts/voice/echo-probe/` is the tool for it once the speakers are
  audible (it refuses to run on muted speakers or headphones).
- **The browser's echo canceller on this machine.** Not measured (muted speakers), so the modelled residue levels (none, -50,
  -40 dB; the echo controls -45, -40, -35) are assumptions, and whether the runtime inside the desktop app uses the
  browser-wide echo reference is unverified (section 7).
- **Real people and rooms.** The people are synthetic voices (Supertonic and Kokoro), and the coughs and keyboard clicks are
  synthetic as well. Portuguese is Brazilian Portuguese through Supertonic only.
- **The model-based approach.** Not measured: it needs a download (section 3). The comparison in this document is between the
  shipped pipeline, the same pipeline tuned by settings alone, and the pilot.
- **End-to-end latency of ordinary turns.** Measured, and too noisy to resolve 100 ms (section 5.1); the added work per frame
  was measured instead.
- **Android.** The repository has no Android code and no plan for one, so nothing was built for it; `interrupt.ts` is the
  part another client could reuse.
- **The app's own browser runtime.** The player test used Edge; the desktop app's WebView2 was not tested.

**Worth doing next (not done here)**

1. A detector of short stop words that does not need the recogniser's words, measured in both languages. The open Pipecat
   backchannel detector (section 7) is English only; a Portuguese one would have to be trained and evaluated. Running the open
   one needs a 4 MB download, which has to be approved.
2. The speech detector's wrapper treats a minimum silence of 0 as 0.5 s, which also delays the end of speech of an ordinary
   turn. Changing it would alter every call, so it was left alone (the flag-off call must stay exactly 0.30.0); it deserves its
   own evaluation.
3. Reading the words earlier on a sound of listening ("mm-hm" is a word the recogniser writes at about 0.7 s), to shorten the
   pause.

## 7. Sources

Read on 2026-11-20. **V** means the primary source was read in full for the point cited (paper text, documentation page, model
card or licence file); **Vp** means only part of it was read (abstract or one section). Every number in the tables below is a
claim of its author. None of them was reproduced here; the numbers measured in this work are only in sections 2 and 5.

### Design precedents

| Source | What it contributes | Read |
| --- | --- | --- |
| Ström and Seneff, "Intelligent barge-in in conversational systems", ICSLP 2000, [doi:10.21437/ICSLP.2000-353](https://doi.org/10.21437/ICSLP.2000-353) | Detect, verify at the end of the utterance, recover. Two recoveries: lower the volume and stop only when verified ("reduce and listen"), or stop at once and resume from the last phrase boundary if verification fails ("rewind and resume"). A design paper: no numbers | V |
| Selfridge, Arizmendi, Heeman and Williams, SIGDIAL 2013, [W13-4063](https://aclanthology.org/W13-4063.pdf) | Pause the prompt when the interruption is predicted to be understood, resume it when it is not; deployed in a public bus-information system against a standard barge-in baseline | Vp |
| LiveKit Agents, [turn handling](https://docs.livekit.io/agents/logic/turns/tuning/) | Pauses the agent when speech is detected; with no words after 2.0 s it resumes from the same place; on a real interruption the history is cut to what was heard. Minimum duration 0.5 s | V |
| Vapi, [speech configuration](https://docs.vapi.ai/customization/speech-configuration.md) | A list of phrases ("stop", "wait", "enough", "no", "actually"...) that always interrupt at once, and a list of acknowledgements ("okay", "yeah", "uh-huh") that never do | V |
| Deepgram, [barge-in guidance](https://developers.deepgram.com/guides/deep-dives/audio-preprocessing-barge-in.md) | Use the platform echo canceller, which can make barge-in harder when aggressive; drop recogniser output that matches the text the agent has just spoken | V |
| OpenAI, [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations.md) | The client stops playback and truncates the item at the audio actually played (`audio_end_ms`), so the model's record is what was heard | V |

### What the published benchmarks timed, and where

| Benchmark | What it times | Audio and language | Read |
| --- | --- | --- | --- |
| Full-Duplex-Bench 1.5, [arXiv:2507.23159](https://arxiv.org/abs/2507.23159) | Stop latency: user speech onset to the moment the model stops, read off the model's output with a VAD on the recording | Synthetic voices, English, no echo of the agent into the microphone | V |
| SID-Bench, [arXiv:2603.24144](https://arxiv.org/abs/2603.24144) | Time from the first phoneme of a substantive word to the detector's decision; for VAD baselines the VAD onset, so their latency is 0 by construction | Real human dialogues, English and Chinese, no echo | V |
| TurnBench, [arXiv:2608.25218](https://arxiv.org/abs/2608.25218) | Detector commit time against the interrupter's onset, with recall at a false-positive budget | Studio dyads, English, clean | V |
| M3-DuplexBench, [arXiv:2607.29125](https://arxiv.org/abs/2607.29125) | Onset of the user event to the offset of the model's speech segment on its output channel | Synthetic, English and Japanese | V |
| FireRedChat, [arXiv:2509.06502](https://arxiv.org/abs/2509.06502) | T90 (the delay at which barge-in accuracy reaches 90%) and the false barge-in rate under noise and a second speaker | Synthetic mixing, Chinese and English | V |
| Agora article on a hosted voice assistant's stop latency, [prod.agora.io](https://prod.agora.io/en/blog/openai-didnt-publish-gpt-lives-latency-so-we-measured-it) (a vendor, 2026-07-10) | First frame of the barge-in to the last audible frame from the assistant, from two-track recordings of a real phone: the only one found that reads audible output on a device (n = 30, one phone) | Artificial mouth, English | V |
| HyWA, [arXiv:2510.12947](https://arxiv.org/abs/2510.12947) | False interruptions from residual assistant playback after echo cancellation: 88.9% for a generic VAD, 9.9% with a personalized one, on a hard-negative set that earlier stages had already got wrong | Device pipeline, not a general rate | V |

What these have in common, and why this evaluation does not reuse their numbers: none measures silence at the speaker of a
cascaded pipeline that listens while it speaks with a browser canceller; none includes real echo residue; none counts duplicate
tasks after a correction or checks the reply against the audio the person heard; and none has Brazilian Portuguese (all 16
benchmark papers read were searched for "Portuguese" and "Brazil": no match). M3-DuplexBench's own table scores the same
outputs 42.3% and 95.0% under two metric definitions, so figures cannot be moved between benchmarks.

### Models considered

| Model | Revision | Licence | Fit | Used here |
| --- | --- | --- | --- | --- |
| [pipecat-ai/backchannel-detector](https://huggingface.co/pipecat-ai/backchannel-detector) | `4896f4774cdf1a9c5b581b0cd4a0c4000e8bb854` | BSD-2-Clause | Streaming (40 ms chunks), 734k parameters, about 0.3 ms of CPU per chunk, English only; 82.9% and 81.2% of interruptions caught within 700 ms, median 280 to 300 ms (the card's own two English test sets, simulated echo) | No: a download was not requested |
| [AustinXiao/voxturn](https://huggingface.co/AustinXiao/voxturn) | `fe3d4a319c4e74279544188bd0e8292325852dbc` | CC BY-NC 4.0 | 14 languages including Portuguese; 0.8B parameters; a GPU; non-commercial | No: licence |
| [HashNuke/barge-in-detector](https://huggingface.co/HashNuke/barge-in-detector) | `28177ae331b8ee751ab2a1bb62da5c5632b8473f` | MIT | Text only (needs the recogniser's words, which is the late part); no Portuguese | No |

### Components the measurements ran on (pinned by the app's own manifest, `packages/server/src/voice/manifest.ts`)

| Component | Pin | Licence |
| --- | --- | --- |
| sherpa-onnx-node 2.0.1 | npm `sherpa-onnx-node@2.0.1` | Apache-2.0 |
| Silero VAD | `silero_vad.onnx`, sha256 `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6` | MIT |
| Streaming recogniser | Nemotron 3.5 ASR Streaming 0.6B, 160 ms, int8 (2026-06-11), archive sha256 `a81909a1780d84cff16d73c15e13e67d9d81d8839faf14870d507d8499f7a61a` | NVIDIA Open Model License |
| Re-reading recogniser | Parakeet TDT 0.6B v3, int8, archive sha256 `1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9` | CC-BY-4.0 |
| Assistant voice and the development and held-out Portuguese and English voices | Supertonic 3, int8 (2026-05-11), archive sha256 `82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427` | OpenRAIL-M |
| Held-out English voices (a different model; not shipped by Ancilla) | Kokoro int8 multi-language v1.0: `model.int8.onnx` sha256 `75635ea3b85a32d00094dcdd61a258aba87c160f7c264c304a7b3ae9d734195e`, `voices.bin` `1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29` | Apache-2.0 |

Not verified in this work: whether the browser runtime that ships with the desktop app uses the browser-wide echo canceller
reference, the loopback reference with a 170 ms capture delay (both found only in Chromium source and a third-party thread), or
the neural residual echo estimator, and how many dB of residue it leaves with Web Audio output on a laptop speaker. The
speakers of the development machine were muted at the Windows endpoint during the acoustic probe, so that probe describes
silence, not the canceller (`scripts/voice/echo-probe/README.md`).

## 8. Rolling back, and running it again

- **Rollback is turning the setting off** (Assistant, Voice, *Speak over it to stop it*, or `"interruptPilot": false` in
  `voice.json`). Nothing is migrated. Off, the server and the page are what 0.30.0 made them; the test
  `voice-interrupt-off.test.ts` compares whole calls with the traces of a build of v0.30.0.
- Run the evaluation again with `scripts/voice/interrupt-eval/reproduce.sh` (see its README); the raw results of this one are in
  `scripts/voice/interrupt-eval/results/`.
