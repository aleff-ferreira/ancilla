# Talking to the assistant

You can call the assistant. It listens while you talk, answers aloud a sentence at a time, can be cut off in the middle
of a word and go on from what you said, remembers the conversation the next time you call, and starts work in the
background while you keep talking. The speech recognition and the voice run on your computer. The model that thinks of
what to say is your choice: your Muse plan, a model on your machine, or any hosted model that speaks the common chat
protocol.

It is **off until you install it**, and installing it is a download you start yourself: nothing is fetched, loaded or
listening before that, and a call never starts by itself.

Related: [the assistant](assistant.md), [how it is evaluated](assistant-evaluation.md).

## Setting it up

1. Open the Assistant page, then the **Voice** tab.
2. **Voice engines.** Press *Install the voice* after reading the licences. It downloads the speech engine for your
   platform, a speech detector, a speech recogniser and the voice, and checks each file against a fixed checksum before
   it is used. About 0.6 GB; an optional *accuracy booster* adds half a gigabyte and is described below.
3. **The model that answers.** Choose one:
   - *Muse*: your Muse plan, one thread per conversation (it shows in the sidebar like any thread). No key. Each answer
     takes as long as a Muse turn, so a short phrase covers the wait.
   - *Another model*: any server that speaks the OpenAI chat protocol. The tab has starting points for OpenAI,
     OpenRouter, Groq, Ollama, LM Studio and llama.cpp. A key, if there is one, is kept in a file only you can read and is
     never shown again. A model that runs on your computer sends nothing over the network.
4. Press the microphone beside the assistant's name (in the sidebar, or the *Talk* button on its page).

## Talking

- **Hands-free** listens all the time and works out when you have finished. A finished sentence is answered after about
  half a second; a sentence that trails off ("and then...", "um") is given time; a one-word command is answered at once.
- **Push to talk** listens only while you hold the button or the space bar.
- **Interrupting.** Start to speak over it and its voice dips at once; if it is really you (not a cough, a laugh or its own
  voice coming back through your speakers) it stops within about a quarter of a second, and what it remembers of its last
  reply is only what you heard of it. Say "stop", "wait" or "para" and it stops without waiting for more.
- **Typing.** The keyboard button opens a line to type in during the call. The conversation is the same one: what you type
  is in the transcript, and typing over its voice cuts it off like speaking would.
- **Tasks in the background.** Ask it to look into something ("research the open issues and summarise them") and it
  starts a task and carries on talking. You can ask how it is going, pause it, resume it or cancel it. When a task
  finishes, fails or needs you, it says so in a pause. It never interrupts you to say it.
- **What changed while you were away.** A call opens with the work that finished, failed or waits on you since you last
  talked ("While you were away: the release notes need your approval. The issue summary is done."): what waits on you
  first, two named and the rest counted. It is said once, after about two and a half seconds of quiet, and not at all if
  you speak first, so it never lands on a topic you chose. It goes on in the language of the conversation, and the same
  setting as the rest turns it off (Assistant, Voice, Speaks up by itself).
- **Languages.** English and Brazilian Portuguese, switching when you do.

## What it will and will not do by voice

A spoken sentence may have been misheard, or may not have been yours. So voice can **read, research and propose, and
nothing else**:

- A task started by voice can read and research. It **cannot change files**, whatever was said.
- No approval is ever given by voice. An approval, or a change to a file, is a click on the screen.
- A Muse turn that asks to use a tool is stopped, and the call says it is waiting on the screen.
- What it hears is kept as what you said, with the words as the recogniser wrote them; the memory treats a spoken
  statement like a typed one but records that it was spoken.

## What is kept, and where

| What | Where | For how long |
| --- | --- | --- |
| The words of each conversation (yours and its, with how much of a cut-off reply you heard) | `assistant.db`, next to the memory | Until you delete them, or for the number of days you choose |
| Notes it learned from what you said | `assistant.db` (see [the memory](assistant.md#how-the-memory-works)) | As the memory says |
| The meaning of each note, as numbers, if you switched on [meaning search](assistant.md#meaning-search) | `assistant.db`, beside the note | As long as the note; erased with it, and all of it when meaning search is turned off |
| The sound of your voice | **nowhere**: it is turned into words and dropped | Not kept |
| A key for a hosted model | `voice-secrets.json`, readable by you only | Until you remove it |
| The downloaded models | `voice/` in the data folder | Until you press *Remove* |

The Voice tab lists the conversations and deletes one or all of them. A conversation is words only. With a hosted model,
what you say is sent to that model as text; with Muse it is a turn in your Muse thread; with a model on your computer it
goes nowhere.

## How it works

```
microphone -> echo cancellation (the browser) -> 16 kHz frames over one WebSocket
  -> speech detector (Silero) -> turn-taker -> streaming recogniser (Nemotron 3.5) -> words so far
                                        \-> accurate re-reading at each pause (Parakeet TDT v3) -> transcript
  -> memory notes + character -> the model (Muse / any chat model) -> sentences
  -> voice (Supertonic 3) -> audio over the same socket -> speakers, counted as they play
```

The decisions that matter, and why:

- **A call is a pipeline of small parts, not one big model.** It lets every part be replaced (the model most of all),
  be tested alone, and run on a computer with no graphics card. A speech-to-speech model would answer faster but would
  tie the assistant to one vendor, and none that runs on an ordinary computer handles tools, two languages and a memory.
- **One decision-maker for turns** (`turn.ts`): a state machine fed a speech probability for every 32 ms and the words so
  far. It never reads a clock, so a recorded conversation replays the same way every time, and the tests run whole calls in
  milliseconds. How long it waits after you go quiet depends on what you said (finished, trailing off, a command).
- **Two recognisers.** The streaming one gives words as they are said (for the screen and for judging whether a sentence is
  finished). At every pause the speech since the last pause is read again by a larger model and that reading is the
  transcript: it is about three times more accurate and it writes punctuation, which in turn tells the turn-taker that a
  sentence is finished. Because it runs during the pause, it is ready when the turn ends and adds no delay.
- **A reply is said a sentence at a time and kept honest.** Audio is made only a couple of seconds ahead of what has played,
  the page reports how much it has played, and so cutting the assistant off costs little and the model is told only what you
  heard. A first sentence is cut early and short so that sound starts quickly.
- **Interruption is two steps.** The voice is lowered when sound starts over it and stopped only when it is confirmed (a
  stop word, or speech that goes on), so a cough costs a dip and not a sentence. The words it hears over its own voice
  are compared with what it said, so an echo is not taken for you.
- **The model is behind one small interface** (`brain.ts`): conversation and tools in, text and tool calls out. Muse, any
  OpenAI-compatible server and a stand-in for tests all fit it. A model with no tool calling is given tools through a
  convention in its text.
- **The notes it is told are found the way the text box's are,** by words and, if you switched it on, by meaning. The
  embedding model is asked for at most a quarter of a second, because a call is about the next half second; a server
  that is down or slow costs the turn that wait at most, and is then left alone for a while.
- **The engines are an optional download**, not part of the installer: they carry native code for each platform and half a
  gigabyte of models, and most people who never call should not pay for them. Every file has a pinned address, size and
  checksum.

## Measured

Everything below was measured on one machine (Core Ultra 9 275HX, 24 cores, no graphics card used, Linux under WSL2) with
the engines described above. It is what this build does here, not a claim about yours. `scripts/voice/bench.mjs`
reproduces the call numbers.

| Part | Result |
| --- | --- |
| Streaming recogniser, 40 read sentences per language | English 14.2% word error, Portuguese 9.0% (many of the English "errors" are "twenty five" against "25") |
| Accurate re-reading, same sentences | English 5.4%, Portuguese 5.9%; about 0.2 s for a 4 s sentence |
| Voice, spoken back through the recogniser | 5.1% word error, all of it "22" against "twenty two": the speech is intelligible in both languages |
| Voice speed | 0.75 s to say a 4.9 s sentence at the default quality (0.37 s at the fastest setting) |
| End of your speech to the first sound, with a model that takes 0.35 s to start | 1.2 to 1.4 s, in the browser and over the socket; the pause that ends your turn (0.5 s) and the model's first word are the two largest parts |
| The same, with everything on this computer: a 4-billion-parameter model (Qwen3-4B-Instruct, 4-bit) on the laptop's graphics card through llama.cpp, the speech on the processor | about 1.0 to 1.2 s at the median; the model loads in 3.5 to 6.6 s the first time |
| Finding a note by meaning, with a local embedding model, during that wait | 6 ms for the question's vector; a call never waits more than 0.25 s for it, and the words answer alone when it is late |
| A whole call on this computer, spoken by a synthetic voice over the socket: five questions, four of them about notes the assistant holds ("which car do I have?" against "drives a Subaru Outback") and one of general knowledge | All five heard word for word; the four were answered from the notes and the fifth from the model; 1.0 to 1.3 s from the end of speech to the first sound, 1.07 s at the median. A first run found a flaw this way: a short question was looked up together with the one before it, which pulled its meaning toward the earlier topic and, for the words, made its own word too small a part of the search to match its note (the text box had the same fault), so it is now looked up on its own, and with the question before it only when that finds nothing |
| Interrupting | the voice dips 0.06 s after you start, stops about 0.25 s after |
| First call after starting Ancilla | 4 to 6 s to load the models; they stay loaded for ten minutes after a call |

What is **not** measured: a call through the desktop app's own web view (echo cancellation there depends on the platform;
it works in a browser and is the first thing to try if the assistant hears itself), a Windows or macOS machine, a
Muse thread as the model (its speed is Muse's), and a quiet or noisy room other than the test recordings.

## For developers

- Server: `packages/server/src/voice/` (the call), `engines/` (the native parts, run on a worker thread), `service.ts`
  (the models, the one open call and the settings), `ws.ts` (the socket), `installer.ts` and `manifest.ts` (the download).
  The socket is `/api/voice/ws` and is checked like the rest of the API (host, origin, token) before the handshake.
- Page: `packages/ui/src/model/voice/` (the call as a pure function of what the server said, the microphone worklet, the
  player) and `components/voice/`.
- Tests: `npm test --workspace @ancilla/server` runs whole calls against doubles in virtual time, a call over a real socket,
  the installer against a stand-in network, and the Muse thread against a stand-in Muse. The page's half is in
  `packages/ui/test/voice-call.test.ts`.
- Real engines: `node scripts/voice/bench.mjs --runtime <dir> --models <dir> --clips <dir>` runs calls on a real clock and
  prints the timings (`--llm-url` and `--llm-model` use a real model server, such as a local llama.cpp, instead of the
  stand-in); `scripts/voice/mock-llm.mjs` is a stand-in model that speaks the chat protocol, for running a call with no
  key; `scripts/voice/call.mjs` makes a whole call to a running server with questions spoken by the engines' own voice
  and prints what was heard, what was answered and how long the first sound took, with no microphone;
  `scripts/voice/replay.mjs` replays a recorded call (start the server with `ANCILLA_VOICE_DEBUG=1` and the audio it
  receives is written to the temp folder; it is your voice, so delete it when you are done).
- Adding a model: implement `BrainProvider` (`stream` returns text, tool calls and how it ended) and add it to `brains.ts`.
  Adding an engine: implement `VadEngine`, `AsrEngine` or `TtsEngine` from `engines.ts`.

## Rolling back

*Remove* in the Voice tab deletes the downloaded models. Deleting `voice.json` and `voice-secrets.json` resets the
settings. The conversations are in `assistant.db` and go with it; `scripts/assistant-rollback.mjs` can step the database
back to before they existed (export first).

## What it does not do yet

- It does not hear you while it speaks beyond noticing that you want to cut in: it answers one turn at a time.
- It does not tell speakers apart: anyone who speaks near the microphone is you.
- It does not start a call by itself, and it never speaks to you except in a lull of a call you started.
- A hosted model's key is kept in a file, not in the system's keychain.
- Moving a call between devices is not built: the conversation is, so the next call, from anywhere, goes on from it.
