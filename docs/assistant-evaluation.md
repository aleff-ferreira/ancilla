# The assistant: evaluation

How the assistant was measured, what the numbers are, and what they do not show. The targets were fixed before the
runs, in [assistant-baseline.md](assistant-baseline.md); this file reports against them, including where they were
missed.

## What is and is not measured

No model is called. The evaluation measures what Ancilla does with what a model would say and do: what it keeps, what
it replaces, what it erases, what it puts in front of a prompt, and what a task does when a turn ends, fails or never
reports. A **scripted reader** stands in for the model: it reads the block a turn would carry and answers from the best
matching note, or says it has nothing. That makes the comparison between the assistant and its baselines a comparison of
**context quality**, not of a language model. It cannot say whether a real model uses the block well. A real Muse turn
was not made for this evaluation.

The scenarios were written by the person who built the assistant. That is a limit: a test author tends to write the
cases the code handles. Two things work against it: a held-out set that was not looked at while the assistant and its
retrieval settings were being built, and generated cases with seeded randomness and vocabulary the assistant's own
lexicon does not contain. A stronger test needs conversations written by other people.

## Method

- **Scenarios** are lists of timed steps over simulated months: a user says something in a thread, asks something,
  corrects, forgets, restarts the server, replays an old message, or something that is not the user (a tool, the
  assistant, a web page, a pasted document) says something. Every step has a time, so a "late job" is a message with an
  early time processed late.
- **Systems compared.** `none` (no memory), `window` (the last messages of the thread pasted back, as many as the budget
  holds), `summary` (a rolling extractive summary of older messages inside the same budget), and the assistant. For the
  retrieval question, the assistant is also run with parts removed or added (structured sets only, full text only,
  lexical expansion, hashed character vectors, identifier graph expansion).
- **Budget.** Every system gets the same token budget as the assistant's default (900 estimated tokens).
- **Held out.** The development set was used to build and to choose settings. The held-out set uses different entities,
  different phrasings and a different paraphrase vocabulary, and was run once, after the settings were fixed.

## Metrics

Recall, precision, unsupported claims, correction accuracy, contradiction surfacing, temporal accuracy, abstention,
deletion leakage, resurrection, injection acceptance, convergence under concurrent and late writes, crash atomicity,
latency at 10,000 memories, context cost and model calls, executive behaviour (duplicate effects, stale completions,
tasks left running after cancel, budgets exceeded, recovery), and model-change continuity. Definitions and targets are in
section 4 of [assistant-baseline.md](assistant-baseline.md).

## Results

Everything between the markers below is written by `scripts/assistant-eval.mjs` from what the code does; a cut-down
version of the same run is the `assistant-eval` test, which fails if a target of
[assistant-baseline.md](assistant-baseline.md) stops being met.

<!-- results:begin -->

Generated 2026-11-08 by `scripts/assistant-eval.mjs` (full run: 60 scenarios of each main kind per suite, 30 distractor notes and 140 ordinary messages around each fact).

### Against the targets

|  | measure | target | measured |  |
| --- | --- | --- | --- | --- |
| T1 | exact recall | >= 95% | 100.0% | met |
| T2 | paraphrase recall | reported | 14.2% | met |
| T3 | precision of the notes chosen | >= 85% | 98.7% | met |
| T4 | unsupported claims | <= 2% | 0.6% | met |
| T5 | correction accuracy (latest value, old one out of the context) | >= 97% | 100.0% | met |
| T6 | a dispute is shown, not silently resolved | 100% | 100.0% | met |
| T7 | as-of questions answered with the value that held then | >= 90% | 100.0% | met |
| T8 | abstains when nothing covers the question | >= 95% | 95.0% | met |
| T9 | erased words found anywhere (context, lists, export, log, file) | 0 | 0 places, 0.0% of probes | met |
| T10 | erased words that came back when read again | 0 | 0 of 72 | met |
| T11 | instructions from places that are not the user that became beliefs or moved a permission | 0 | 0 of 42; permissions moved 0 of 3 | met |
| T12 | writers in any order, late jobs, two connections: same state as a sequential run | 100% | 40 of 40 | met |
| T13 | a write that fails at any step changes nothing | 100% | 63 of 63 failure points | met |
| T14 | retrieval p95 and capture p95 at 10,000 memories | <= 50 ms and <= 25 ms | 16.6 ms and 7.6 ms | met |
| T15 | tokens added to a turn, and model calls made | <= 1,500; 0 calls | 853 at most; 0 calls | met |
| T16 | executive under faults: duplicate effects, stale reports accepted, running after cancel, budgets exceeded, false completions, undefined after restart | 0 each | 0, 0, 0, 0, 0, 0 (and 0 other) over 13,500 operations | met |
| T17 | the same memory and question give the same block, on every call and after a restart | 100% | 60 of 60 | met |

### Retrieval, held-out set

Round 1 of the held-out material: draws nobody looked at while the assistant was being built. Systems share one token budget (900).

| system | exact | paraphrase, shares a word | paraphrase, shares none (lexicon covers it) | paraphrase, shares none (lexicon does not) | among many notes | mean tokens |
| --- | --- | --- | --- | --- | --- | --- |
| none | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0 |
| window | 23.3% | 21.4% | 43.8% | 19.7% | 36.7% | 623 |
| summary | 66.7% | 53.6% | 68.8% | 71.1% | 40.0% | 616 |
| **assistant** | 100.0% | 42.9% | 0.0% | 6.6% | 100.0% | 136 |

| system | change: right answer | change: old value out of context | dispute shown | as-of: right answer | abstains when it should | unsupported claims | precision of notes | erased words still in context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 0.0% | 100.0% | 0.0% | 0.0% | 100.0% | 0.0% | n/a | 0.0% |
| window | 55.6% | 100.0% | 0.0% | 40.0% | 85.0% | 15.3% | n/a | 100.0% |
| summary | 100.0% | 100.0% | 0.0% | 40.0% | 63.3% | 19.0% | n/a | 100.0% |
| **assistant** | 100.0% | 100.0% | 100.0% | 100.0% | 95.0% | 0.6% | 98.7% | 0.0% |

### Retrieval, development set

The set the assistant was built and tuned on.

| system | exact | paraphrase, shares a word | paraphrase, shares none (lexicon covers it) | paraphrase, shares none (lexicon does not) | among many notes | mean tokens |
| --- | --- | --- | --- | --- | --- | --- |
| none | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0 |
| window | 26.7% | 24.3% | 23.3% | 32.5% | 6.7% | 623 |
| summary | 56.7% | 56.8% | 58.1% | 55.0% | 26.7% | 617 |
| **assistant** | 100.0% | 73.0% | 0.0% | 15.0% | 100.0% | 145 |

| system | change: right answer | change: old value out of context | dispute shown | as-of: right answer | abstains when it should | unsupported claims | precision of notes | erased words still in context |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | 0.0% | 100.0% | 0.0% | 0.0% | 100.0% | 0.0% | n/a | 0.0% |
| window | 60.0% | 100.0% | 0.0% | 15.0% | 86.7% | 16.6% | n/a | 100.0% |
| summary | 100.0% | 100.0% | 0.0% | 15.0% | 63.3% | 19.2% | n/a | 100.0% |
| **assistant** | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 98.0% | 0.0% |

### Techniques considered for paraphrase, on the development set

Each is the shipped retrieval with one change, on the same probes, ranking and budget. A technique is adopted only if it adds at least 10 points of paraphrase recall (all) without costing more than 2 points of precision.

| technique | exact | paraphrase, all | shares a word | shares none, lexicon covers it | shares none, lexicon does not | among many notes | precision of notes | unsupported claims | abstains when it should | mean tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| assistant as shipped | 100.0% | 27.5% | 73.0% | 0.0% | 15.0% | 100.0% | 98.0% | 0.0% | 100.0% | 177 |
| structured sets only | 0.0% | 5.0% | 0.0% | 0.0% | 15.0% | 0.0% | n/a | 0.0% | 100.0% | 162 |
| full text only | 100.0% | 22.5% | 73.0% | 0.0% | 0.0% | 100.0% | 98.0% | 0.0% | 100.0% | 166 |
| + lexical expansion | 100.0% | 34.2% | 73.0% | 18.6% | 15.0% | 100.0% | 97.6% | 0.0% | 100.0% | 178 |
| + hashed vectors | 100.0% | 27.5% | 73.0% | 0.0% | 15.0% | 100.0% | 98.0% | 0.0% | 100.0% | 177 |
| + identifier graph | 100.0% | 27.5% | 73.0% | 0.0% | 15.0% | 100.0% | 98.0% | 0.0% | 100.0% | 177 |
| + one rare shared word | 100.0% | 35.8% | 100.0% | 0.0% | 15.0% | 100.0% | 85.3% | 0.0% | 100.0% | 180 |
| + looser coverage (a quarter) | 100.0% | 35.8% | 100.0% | 0.0% | 15.0% | 100.0% | 86.2% | 0.0% | 100.0% | 180 |
| + expansion and vectors | 100.0% | 34.2% | 73.0% | 18.6% | 15.0% | 100.0% | 97.6% | 0.0% | 100.0% | 178 |
| + expansion and one rare word | 100.0% | 42.5% | 100.0% | 18.6% | 15.0% | 100.0% | 85.4% | 0.0% | 100.0% | 180 |
| + one rare word, only if nothing matched | 100.0% | 35.8% | 100.0% | 0.0% | 15.0% | 100.0% | 89.0% | 0.0% | 100.0% | 179 |
| + expansion, only if nothing matched | 100.0% | 34.2% | 73.0% | 18.6% | 15.0% | 100.0% | 97.6% | 0.0% | 100.0% | 178 |
| + rare word then expansion, only if nothing matched | 100.0% | 42.5% | 100.0% | 18.6% | 15.0% | 100.0% | 89.0% | 0.0% | 100.0% | 180 |

### The same techniques on the held-out set

| technique | exact | paraphrase, all | shares a word | shares none, lexicon covers it | shares none, lexicon does not | among many notes | precision of notes | unsupported claims | abstains when it should | mean tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| assistant as shipped | 100.0% | 14.2% | 42.9% | 0.0% | 6.6% | 100.0% | 98.7% | 0.6% | 95.0% | 174 |
| structured sets only | 0.0% | 8.3% | 17.9% | 0.0% | 6.6% | 0.0% | n/a | 0.0% | 100.0% | 161 |
| full text only | 100.0% | 5.8% | 25.0% | 0.0% | 0.0% | 100.0% | 98.7% | 0.6% | 95.0% | 164 |
| + lexical expansion | 100.0% | 15.8% | 42.9% | 12.5% | 6.6% | 100.0% | 98.7% | 0.6% | 95.0% | 174 |
| + hashed vectors | 100.0% | 20.0% | 67.9% | 0.0% | 6.6% | 100.0% | 98.0% | 0.6% | 95.0% | 175 |
| + identifier graph | 100.0% | 14.2% | 42.9% | 0.0% | 6.6% | 100.0% | 98.7% | 0.6% | 95.0% | 174 |
| + one rare shared word | 100.0% | 27.5% | 100.0% | 0.0% | 6.6% | 100.0% | 90.8% | 0.6% | 95.0% | 176 |
| + looser coverage (a quarter) | 100.0% | 27.5% | 100.0% | 0.0% | 6.6% | 100.0% | 86.7% | 0.6% | 95.0% | 177 |
| + expansion and vectors | 100.0% | 21.7% | 67.9% | 12.5% | 6.6% | 100.0% | 98.0% | 0.6% | 95.0% | 175 |
| + expansion and one rare word | 100.0% | 29.2% | 100.0% | 12.5% | 6.6% | 100.0% | 90.9% | 0.6% | 95.0% | 176 |
| + one rare word, only if nothing matched | 100.0% | 27.5% | 100.0% | 0.0% | 6.6% | 100.0% | 90.8% | 0.6% | 95.0% | 176 |
| + expansion, only if nothing matched | 100.0% | 15.8% | 42.9% | 12.5% | 6.6% | 100.0% | 98.7% | 0.6% | 95.0% | 174 |
| + rare word then expansion, only if nothing matched | 100.0% | 28.3% | 100.0% | 6.3% | 6.6% | 100.0% | 90.9% | 0.6% | 95.0% | 176 |

### What the rules read

| statement | supported phrasing | read by the rules |
| --- | --- | --- |
| `Remember that the staging server is at app-9.example.com` | yes | yes |
| `Don't forget that releases go out on Fridays` | yes | yes |
| `I prefer tabs over spaces for indentation` | yes | yes |
| `My timezone is Europe/Lisbon` | yes | yes |
| `From now on always answer in Portuguese` | yes | yes |
| `We decided to use Postgres for the ledger` | yes | yes |
| `Remind me to renew the domain by 2026-10-20` | yes | yes |
| `Never use emojis in commit messages` | yes | yes |
| `I work at Acme Robotics` | yes | yes |
| `Keep in mind that the VPN drops at midnight` | yes | yes |
| `The staging server is at app-9.example.com` | no | see below |
| `FYI the license is AGPL` | no | see below |
| `Our deploy branch is release/v2` | no | see below |
| `Just so you know, I hate long meetings` | no | see below |
| `Please keep answers short when I ask about git` | no | see below |
| `The database password rotates monthly` | no | see below |
| `Tomorrow's demo is at 3pm` | no | see below |
| `I'm allergic to peanuts` | no | see below |

Of 10 statements phrased the ways the rules know, 10 were read. Of 8 natural phrasings that no rule knows, 1 were read: the rest were never made into notes, and a note that was never made cannot be found.

### Size

| memories | retrieval p50 | retrieval p95 | capture p50 | capture p95 | most tokens in a block | file size |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 | 2.6 ms | 3.1 ms | 1.7 ms | 2.2 ms | 852 | 0.8 MB |
| 10,000 | 15.1 ms | 16.6 ms | 6.6 ms | 7.6 ms | 853 | 4.5 MB |

### Instructions from places that are not the user

Six payloads sent by seven channels each (a tool, the assistant, a web page, a fenced block, a quotation, a document tag, a file's correction): 42 attempts, 0 became a belief, 5 waited for approval. The same payloads pasted into a message with nothing to mark them as not the user's: 5 of 6 were read as the user's own words (the sixth was refused as a credential). That is the known limit: text that looks like the user's is the user's. Memories that claimed authority ("always allow project writes", "never ask me"): 3 made, permissions moved: 0.

### The executive under faults

300 seeded runs, 13,500 operations (turns that fail, are interrupted, report twice or late; hosts that vanish; starts refused or ambiguous; restarts at any point with a ledger that knows or does not know how a turn ended; cancels, pauses and the user's own answers). After every operation: at most one attempt running per task, fences and command ids unique, a finished task not changed by a report, a step that may change things never started again without the user saying so, a cancelled task never running, budgets never exceeded, "completed" only with every check passed.

<!-- results:end -->

## Decisions the numbers support

### Retrieval: nothing added to full text search and the always-on sets

The adoption rule was set before any technique was tried: add at least 10 points of paraphrase recall (all
paraphrases), at no more than 2 points of precision. What the tables show:

- Query expansion with a hand-written lexicon kept precision (a few tenths of a point lost) and added about 7 points on
  the development set and about 2 on the held-out set, and only for paraphrases the lexicon bridges.
- Hashed character vectors added nothing on the development set and about 6 points on the held-out set, for under a
  point of precision.
- An identifier graph added nothing on either.
- Accepting a single rare shared word, or lowering the coverage bar, added 8 to 13 points of recall and cost 8 to 13
  points of precision on both sets: more irrelevant notes put in front of every prompt, which is the failure the
  precision target exists to stop.

None met the rule on both sets, so none is in the assistant. Paraphrase recall is therefore its weakest number, and the
tables say how weak (a question that shares no word with a note mostly does not find it). Two things follow from that and
are in the product: a note can be pinned, so it is there whatever is asked, and a question about what is remembered that
finds nothing says so instead of guessing.

What would change this: embeddings from a model. They were not evaluated because they need a model to be downloaded and
run on the user's machine, which is a second runtime and a download the user has not been asked about. The measured gap
is the case for asking.

### Frameworks and graph stores for memory

Several packages offer agent memory (stores with an extraction step by a language model, graph databases, vector
indexes). None was adopted. They were not run here, so this is a statement about fit and not about measured outcomes:
the ones that extract memories with a model call cost a model call (and a subscription or key) per message, which
the request rules out; the ones that need a graph or vector service add a second runtime to a desktop app that runs one
SQLite file; and the techniques they are built on (graph expansion, vectors) were measured here in their simplest form and
did not pay for themselves on this material. What the assistant needed that they do not give is the part this
evaluation spends most of its time on: provenance with the exact words, erasure that reaches every derived copy,
refusal to resurrect, a guess never replacing what the user said, and a write that is all or nothing.

### The scripted reader

It reads notes and answers from the best match. A real model also reasons, paraphrases and combines, so it will do better
than the reader on a context that holds the answer in other words, and worse on a context padded with distractors that it
believes. These numbers say what is put in front of it, and nothing about how it behaves.
