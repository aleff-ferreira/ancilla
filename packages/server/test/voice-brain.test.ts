import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { forgetToolModes, OpenAiCompatibleProvider, probeToolMode, withToolFallback, type BrainEvent, type BrainProvider, type BrainRequest } from "../src/voice/brain.js";

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
