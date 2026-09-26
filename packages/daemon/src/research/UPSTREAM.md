# Upstream: Deep Dog 2

The DeepResearch engine in this folder is a selective TypeScript port of the control plane of
[Deep Dog 2](https://github.com/beneadie/deep_dog_2) by Benjamin Andrew Eadie, which itself builds on
[ThinkDepth Deep Research](https://github.com/thinkdepthai/Deep_Research) by Paichun Lin. Both are MIT licensed; the
notices are reproduced at the end of this file, as the license requires.

Pinned upstream commit: **`fc7981a`** (`fc7981a3593e57a0cd2da10c0bcd048de5ccd4c6`, Deep Dog 2 version 2.0.1,
2026-09-15). Every line range below refers to that commit.

What is ported is pure logic: the supervisor loop and its exit rules, the sub-agent discipline and budgets, the prompt
text, the deterministic citation pipeline, the salvage and abort policy, and the event vocabulary. What is not
ported: LangGraph and LangChain wiring, the provider factory and its monkeypatches, the Tavily, Exa, Reddit, Substack,
SEC, PubMed and arXiv clients, console and file output, moderation branches, subtopic generation, and the CLI. In
Ancilla every model call and every web search or page read is made by Muse through `ModelClient` and `WorkerRunner`
(`types.ts`); the engine holds no key and opens no socket.

## File map

| Ported file | Upstream source (commit `fc7981a`) | What was taken |
|---|---|---|
| `prompts/brief.ts` | `deep_research/prompts_open.py` L69-127; assembly in `deep_research/research_agent_scope.py` L78-131 | `transform_messages_into_research_topic_human_msg_prompt`, verbatim; the Pydantic schema tail became a fenced JSON contract |
| `prompts/draft.ts` | `deep_research/prompts_open.py` L894-989; assembly in `research_agent_scope.py` L133-185 | `draft_report_generation_prompt`, verbatim |
| `prompts/supervisor.ts` | `deep_research/prompts_open.py` L223-439; assembly in `deep_research/multi_agent_supervisor.py` L295-327, elapsed-time note L829-838 | `lead_researcher_with_multiple_steps_diffusion_double_check_prompt`; `think_tool`, the `Research*` tools and `ResearchComplete` became the `reflection`, `delegations` and `verdict` fields of one fenced JSON decision; specialist-platform paragraphs dropped |
| `prompts/worker.ts` | `deep_research/platform_prompts.py` L14-137, L142-201, L300-306, L340-355; `deep_research/prompts_open.py` L129-221, L584-641 | Base and discovery agent prompts, curation gathering, strategies, web guidance; the instruction, date-consciousness and output-format blocks of the OPEN research and discovery prompts; `batch_save_selected` and `finish_research` became the closing findings block |
| `prompts/writer.ts` | `deep_research/prompts_open.py` L747-891; registry and curated blocks `multi_agent_supervisor.py` L889-921; retry nudge L1005-1010 | `final_report_write_prompt` with its citation rules; the brief, draft, findings and last reflection are spelled out because Muse exec is one shot |
| `citations.ts` | `deep_research/citation_utils.py` L130-343; remap `multi_agent_supervisor.py` L481-491, L694-715 | `extract_cited_codes`, `remap_codes`, `finalize_citations` (`renumber=True` path), `build_final_registry`, the per-agent `A{n}-` code stamp. Added: URL normalisation and the `verified` flag (a source is citable only if the worker's observed searches or fetches contain it) |
| `parse.ts` | `research_agent_scope.py` L78-131 (JSON-mode brief); `multi_agent_supervisor.py` L451-529 (decision reading) | Lenient fenced-JSON extraction replaces `json_mode` and tool-call parsing |
| `supervisor.ts` | `deep_research/multi_agent_supervisor.py` L134-229 (helpers), L329-449 (`supervisor`), L451-864 (`supervisor_tools`) | Two-attempt decision, exit rules (iteration cap, no calls, window max + 1, `ResearchComplete` gated by the verdict and overridden by research calls), sub-agent fan-out, code remap and registry merge, circuit breaker, retry-once then salvage-or-abort. Added: parallel cap, token soft cap, two-empty-rounds rule before the window minimum |
| `engine.ts` | `deep_research/integration.py` L331-402; `research_agent_scope.py` L78-185; `multi_agent_supervisor.py` L869-1023 | Phase sequence, `partial` status on salvage, final writer with two attempts and the empty / identical-to-draft / refusal rejections, `looks_like_refusal` (`deep_research/config.py` L658-670, English markers) |
| `context.ts` | `multi_agent_supervisor.py` L268-293 (`_supervisor_limits`), L212-229 (`_should_salvage`) | Timeouts and the salvage condition |
| `config.ts` | `deep_research/run_config.py` L32-39, `deep_research/config.py` L277 | Hard ceilings and the salvage fraction |
| `types.ts` (events) | `deep_research/events.py` | Event names, plus `worker_tool_call`, `run_interrupted` and `run_resumed` |

Each ported source file starts with a comment naming its upstream file, line range and the pinned commit.

## Upgrade procedure

1. In a checkout of Deep Dog 2, diff the pinned commit against the target commit for the files in the table:
   `git diff fc7981a..<new> -- deep_research/prompts_open.py deep_research/platform_prompts.py deep_research/citation_utils.py deep_research/multi_agent_supervisor.py deep_research/integration.py deep_research/research_agent_scope.py deep_research/run_config.py deep_research/config.py deep_research/events.py`.
2. Apply each hunk to the mapped file in this folder, keeping the JSON contracts, the Muse tool wording and the
   provenance rule intact; prompt text changes are copied verbatim, control-flow changes are re-expressed in the
   loop in `supervisor.ts` or `engine.ts`.
3. Update the pinned commit and the line ranges above and in the file header comments.
4. Run `npm run test --workspace @ancilla/daemon`; the research suites are offline and cover every exit rule.
5. If the upstream `LICENSE` changed, update the notices below and the "Deep Dog 2" section of `/NOTICE.md`.

## License notices

Deep Dog 2 (`LICENSE` at commit `fc7981a`):

```
MIT License

Copyright (c) 2026 Benjamin Andrew Eadie

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

ThinkDepth Deep Research, as Deep Dog 2's `LICENSE` states:

```
This project is built upon ThinkDepth Deep Research
(https://github.com/thinkdepthai/Deep_Research), licensed under the MIT License:

Copyright (c) 2025 Paichun Lin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
