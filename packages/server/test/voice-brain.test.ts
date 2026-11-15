import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { runBrainReadStep } from "../src/assistant/brain-step.js";
import { Executive, type ExecutiveHost } from "../src/assistant/executive.js";
import { MemoryStore } from "../src/assistant/store.js";
import { TaskStore } from "../src/assistant/tasks.js";
import { AnthropicProvider, forgetToolModes, OpenAiCompatibleProvider, probeToolMode, ThinkTagFilter, withToolFallback, type BrainEvent, type BrainProvider, type BrainRequest } from "../src/voice/brain.js";
import { makeBrain, makeBrowseBrain, NO_BRAIN_CONTEXT } from "../src/voice/brains.js";
import { applySettingsPatch, DEFAULT_VOICE_SETTINGS, VoiceSettingsStore } from "../src/voice/settings.js";

/** An OpenAI-protocol server that answers as the handler says, and records what each request had in it. */
function server(handler: (seen: { tools: boolean; system: string }) => Response) {
  const asked: { tools: boolean; system: string }[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { tools?: unknown[]; messages: { content: string }[] };
    const seen = { tools: Array.isArray(body.tools), system: body.messages[0]?.content ?? "" };
    asked.push(seen);
    return handler(seen);
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

const sse = (chunks: object[]): Response => new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200 });
const says = (text: string): Response => sse([{ choices: [{ delta: { content: text }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
const callsPing = (): Response => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "ping", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }]);
const refuses = (status: number, message: string): Response => new Response(JSON.stringify({ error: { message } }), { status });

const PING = { name: "ping", description: "d", parameters: { type: "object", properties: {} } };
const request = (withTools: boolean): BrainRequest => ({ messages: [{ role: "system", content: "You are a test." }, { role: "user", content: "hello" }], tools: withTools ? [PING] : [], signal: new AbortController().signal });

async function collect(brain: BrainProvider, req: BrainRequest): Promise<BrainEvent[]> {
  const events: BrainEvent[] = [];
  for await (const event of brain.stream(req)) events.push(event);
  return events;
}

const provider = (fetchImpl: typeof fetch, key: string) => withToolFallback(new OpenAiCompatibleProvider({ baseUrl: "http://models.test/v1", model: "m", fetchImpl }), { key });

describe("a model server that cannot take tools", () => {
  beforeEach(() => forgetToolModes());

  it("is given its tools through text, and is not asked the built-in way again", async () => {
    const { asked, fetchImpl } = server((seen) => (seen.tools ? refuses(400, "registry.ollama.ai/library/tiny does not support tools") : says("[[ping {}]]")));
    const brain = provider(fetchImpl, "a");
    const first = await collect(brain, request(true));
    assert.deepEqual(first.map((e) => e.type), ["tool", "done"]);
    const call = first[0];
    assert.equal(call?.type === "tool" ? call.call.name : null, "ping");
    assert.deepEqual(asked.map((a) => a.tools), [true, false]);
    assert.match(asked[1]?.system ?? "", /\[\[tool_name/, "the text convention is written into the system message");
    assert.equal(brain.toolMode(), "text");
    await collect(brain, request(true));
    assert.deepEqual(asked.map((a) => a.tools), [true, false, false], "what was learned is used: no second try of the built-in way");
  });

  it("is asked the built-in way again after a while, in case the server was set up since", async () => {
    let clock = 0;
    const { asked, fetchImpl } = server((seen) => (seen.tools ? refuses(400, "does not support tools") : says("[[ping {}]]")));
    const brain = withToolFallback(new OpenAiCompatibleProvider({ baseUrl: "http://models.test/v1", model: "m", fetchImpl }), { key: "ttl", now: () => clock });
    await collect(brain, request(true));
    clock += 11 * 60_000;
    assert.equal(brain.toolMode(), "native");
    await collect(brain, request(true));
    assert.deepEqual(asked.map((a) => a.tools), [true, false, true, false]);
  });

  it("is not mistaken for one when the error is about something else", async () => {
    const { asked, fetchImpl } = server(() => refuses(401, "invalid api key"));
    const brain = provider(fetchImpl, "b");
    const events = await collect(brain, request(true));
    assert.equal(events.length, 1);
    const error = events[0];
    assert.equal(error?.type, "error");
    assert.equal(error?.type === "error" ? error.code : "?", undefined);
    assert.equal(asked.length, 1, "no second request");
    assert.equal(brain.toolMode(), "native");
  });

  it("is never retried for a request that had no tools in it", async () => {
    const { asked, fetchImpl } = server(() => refuses(400, "does not support tools"));
    const events = await collect(provider(fetchImpl, "c"), request(false));
    assert.equal(events[0]?.type, "error");
    assert.equal(events[0]?.type === "error" ? events[0].code : "?", undefined);
    assert.equal(asked.length, 1);
  });

  it("is recognised by the ways servers say so, and only by those", async () => {
    const says4 = async (status: number, message: string): Promise<string | undefined> => {
      const { fetchImpl } = server(() => refuses(status, message));
      const events = await collect(new OpenAiCompatibleProvider({ baseUrl: "http://models.test/v1", model: "m", fetchImpl }), request(true));
      const error = events[0];
      return error?.type === "error" ? error.code : "not an error";
    };
    assert.equal(await says4(400, "registry.ollama.ai/library/x does not support tools"), "tools-unsupported");
    assert.equal(await says4(500, "tools param requires --jinja flag"), "tools-unsupported");
    assert.equal(await says4(400, '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set'), "tools-unsupported");
    assert.equal(await says4(404, "No endpoints found that support tool use"), "tools-unsupported");
    assert.equal(await says4(401, "does not support tools"), undefined, "a refused key is not a refusal of tools");
    assert.equal(await says4(429, "rate limit reached for tool calls"), undefined, "nor is a busy server");
    assert.equal(await says4(500, "out of memory"), undefined);
  });
});

describe("finding out how a model takes tools", () => {
  beforeEach(() => forgetToolModes());
  const signal = () => new AbortController().signal;

  it("says built in when the model calls the tool", async () => {
    const { fetchImpl } = server((seen) => (seen.tools ? callsPing() : says("no")));
    assert.equal(await probeToolMode(provider(fetchImpl, "p1"), signal()), "native");
  });

  it("tries text when the model ignores the built-in way, and keeps what works", async () => {
    const { fetchImpl } = server((seen) => (seen.tools ? says("I will not call it") : says("[[ping {}]]")));
    const brain = provider(fetchImpl, "p2");
    assert.equal(await probeToolMode(brain, signal()), "text");
    assert.equal(brain.toolMode(), "text", "the calls that follow use it");
  });

  it("says none when neither way works, and leaves things as they were", async () => {
    const { fetchImpl } = server(() => says("hello"));
    const brain = provider(fetchImpl, "p3");
    assert.equal(await probeToolMode(brain, signal()), "none");
    assert.equal(brain.toolMode(), "native");
  });
});

describe("stripping reasoning tags and strict OpenAI-compatible servers", () => {
  beforeEach(() => forgetToolModes());

  it("strips <think>...</think> blocks across chunk boundaries without delaying ordinary text", async () => {
    const filter = new ThinkTagFilter();
    assert.equal(filter.push("Hello "), "Hello ");
    assert.equal(filter.push("a < b and <thi"), "a < b and ");
    assert.equal(filter.push("nk>internal plan\nstep 1</th"), "");
    assert.equal(filter.push("ink>\n\nReal answer."), "Real answer.");
    assert.equal(filter.finish(), "");

    const chunks = [
      { choices: [{ delta: { content: "<thi" }, finish_reason: null }] },
      { choices: [{ delta: { content: "nk>chain of thought</thi" }, finish_reason: null }] },
      { choices: [{ delta: { content: "nk>\nSpoken reply." }, finish_reason: "stop" }] },
    ];
    const p = new OpenAiCompatibleProvider({ baseUrl: "http://local.test/v1", model: "qwen3:4b", local: true, fetchImpl: (async () => sse(chunks)) as unknown as typeof fetch });
    const events = await collect(p, request(false));
    const text = events.filter((e) => e.type === "text").map((e) => e.delta).join("");
    assert.equal(text, "Spoken reply.");
  });

  it("retries without stream_options when a strict OpenAI-compatible server rejects stream_options", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("stream_options" in body) return refuses(400, "Unknown field: stream_options");
      return says("Works now.");
    }) as unknown as typeof fetch;

    const p = new OpenAiCompatibleProvider({ baseUrl: "http://strict-server.test/v1", model: "llama", local: true, fetchImpl });
    const first = await collect(p, request(false));
    assert.equal(first.filter((e) => e.type === "text").map((e) => e.delta).join(""), "Works now.");
    assert.equal(bodies.length, 2);
    assert.equal("stream_options" in (bodies[0] ?? {}), true);
    assert.equal("stream_options" in (bodies[1] ?? {}), false);

    await collect(p, request(false));
    assert.equal(bodies.length, 3, "remembered that this server rejects stream_options");
  });
});

describe("the native Messages API provider", () => {
  beforeEach(() => forgetToolModes());

  it("sends system, alternating user/assistant messages, tool_use/tool_result blocks and streams replies and tool calls", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};
    const anthropicSse = [
      { type: "message_start", message: { usage: { input_tokens: 42, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "secret reasoning" } },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Checking now." } },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "ping" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"ok":' } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "true}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 19 } },
    ];
    const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string>; body?: unknown }) => {
      seenUrl = String(url);
      seenHeaders = init?.headers ?? {};
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(anthropicSse.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200 });
    }) as unknown as typeof fetch;

    const p = new AnthropicProvider({ baseUrl: "https://api.messages.test/v1/", model: "sonnet-test", apiKey: "sk-ant-123", fetchImpl });
    const events = await collect(p, {
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Check status." },
        { role: "assistant", content: "One moment.", toolCalls: [{ id: "t0", name: "ping", arguments: "{}" }] },
        { role: "tool", toolCallId: "t0", name: "ping", content: "pong" },
        { role: "user", content: "Now again." },
      ],
      tools: [PING],
      signal: new AbortController().signal,
    });

    assert.equal(seenUrl, "https://api.messages.test/v1/messages");
    assert.equal(seenHeaders["x-api-key"], "sk-ant-123");
    assert.equal(seenHeaders["anthropic-version"], "2023-06-01");
    assert.equal(seenBody["system"], "Be concise.");
    const msgs = seenBody["messages"] as Array<{ role: string; content: unknown[] }>;
    assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user"], "tool result and user follow-up coalesce into one user turn");
    assert.equal(events.filter((e) => e.type === "text").map((e) => e.delta).join(""), "Checking now.", "thinking blocks are never emitted as text");
    const toolEvt = events.find((e) => e.type === "tool");
    assert.deepEqual(toolEvt, { type: "tool", call: { id: "toolu_1", name: "ping", arguments: '{"ok":true}' } });
    const usageEvt = events.find((e) => e.type === "usage");
    assert.deepEqual(usageEvt, { type: "usage", inputTokens: 42, outputTokens: 19 });
    assert.deepEqual(events[events.length - 1], { type: "done", reason: "tool" });
  });

  it("stores keys and builds brains for the Messages API setting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-ant-settings-"));
    after(() => rm(dir, { recursive: true, force: true }));
    const store = new VoiceSettingsStore(dir);
    const patched = applySettingsPatch(DEFAULT_VOICE_SETTINGS, { brain: { kind: "anthropic", model: "sonnet-test", apiKeyEnv: "TEST_MSG_KEY" } });
    assert.equal(patched.brain.kind, "anthropic");
    store.update({ brain: { kind: "anthropic", baseUrl: "https://api.messages.test/v1", model: "sonnet-test", local: false }, apiKey: "msg-secret" });
    assert.equal(store.view().hasKey, true);
    assert.equal(store.keyFor(store.get().brain), "msg-secret");
    assert.equal(makeBrain(store.get(), NO_BRAIN_CONTEXT, { museHost: null, keyFor: (b) => store.keyFor(b) }).problem, null);
    assert.match(makeBrowseBrain(store.get(), { keyFor: () => null, museExec: null, log: () => undefined }).problem ?? "", /No key is set/);
  });
});

describe("provider-independent project read steps when Muse CLI is unreachable", () => {
  it("inspects project files with read-only tools and completes a task step without Muse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-brain-step-"));
    after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "README.md"), "# Atlas Service\nPort: 4321\n");

    let round = 0;
    const fakeBrain: BrainProvider = {
      id: "test:local",
      label: "Local Test",
      capabilities: { tools: true, speculative: true, local: true },
      async *stream() {
        round += 1;
        if (round === 1) {
          yield { type: "tool", call: { id: "c1", name: "read_file", arguments: JSON.stringify({ path: "README.md" }) } };
          yield { type: "done", reason: "tool" };
        } else {
          yield { type: "text", delta: "Atlas Service listens on port 4321." };
          yield { type: "done", reason: "stop" };
        }
      },
    };

    const direct = await runBrainReadStep({ brain: fakeBrain, root: dir, prompt: "What port does Atlas listen on?", signal: new AbortController().signal });
    assert.deepEqual(direct, { ok: true, answer: "Atlas Service listens on port 4321." });

    // Also verify Executive fallback when Muse is unavailable:
    const mem = MemoryStore.open(":memory:");
    after(() => mem.close());
    const tasks = new TaskStore(mem, () => 1000);
    const noMuseHost: ExecutiveHost = {
      now: () => 1000,
      projectKey: (cwd) => cwd,
      hostAvailable: async () => ({ ok: false, reason: "Muse is not installed" }),
      startSession: async () => {
        throw new Error("unreachable");
      },
      startTurn: async () => {
        throw new Error("unreachable");
      },
      interruptTurn: async () => undefined,
      turnState: async () => "absent",
      readProjectFile: async () => ({ exists: true, text: "# Atlas Service\nPort: 4321\n", size: 27 }),
      needsUser: () => false,
      watch: () => () => undefined,
      log: () => undefined,
    };
    round = 0;
    const exec = new Executive(tasks, noMuseHost, {
      profile: () => ({ ...mem.getProfile(), enabled: true }),
      memory: () => null,
      changed: () => undefined,
      fallbackRead: {
        available: () => ({ ok: true, label: "Local Test" }),
        run: ({ cwd, prompt, signal }) => runBrainReadStep({ brain: fakeBrain, root: cwd, prompt, signal }),
      },
    });
    const created = exec.create({
      title: "Check port",
      goal: "Find the Atlas port",
      goalId: null,
      cwd: dir,
      project: dir,
      account: null,
      allowWrites: false,
      maxTurns: 5,
      maxMinutes: 10,
      origin: "user",
      scheduleId: null,
      steps: [{ title: "Read README", prompt: "What port does Atlas listen on?", effect: "read", verifier: { type: "file_contains", path: "README.md", text: "4321" } }],
    });
    await exec.tick();
    await new Promise((r) => setTimeout(r, 60));
    const finished = tasks.require(created.id);
    assert.equal(finished.status, "completed");
    assert.match(finished.result, /4321/);
    exec.close();
  });
});
