import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectLocalServers } from "../src/voice/local-models.js";

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

/** A fetch that answers the addresses it has a route for, and refuses the connection to any other, as a closed port does. */
const fetchFor = (routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>): typeof fetch =>
  (async (url: unknown, init?: RequestInit) => {
    const route = routes[String(url)];
    if (!route) throw new Error("connect ECONNREFUSED");
    return route(init);
  }) as unknown as typeof fetch;

describe("finding the model servers on this computer", () => {
  it("lists the servers that answer, with the models they have for chatting", async () => {
    const fetchImpl = fetchFor({
      "http://127.0.0.1:11434/api/tags": () => json({ models: [{ name: "qwen3:4b", size: 2_500_000_000 }, { name: "nomic-embed-text", size: 270_000_000 }] }),
      "http://127.0.0.1:1234/v1/models": () => json({ data: [{ id: "google/gemma-3-4b" }] }),
    });
    const servers = await detectLocalServers({ fetchImpl });
    assert.deepEqual(servers, [
      { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "qwen3:4b", sizeBytes: 2_500_000_000 }] },
      { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "google/gemma-3-4b", sizeBytes: null }] },
    ]);
  });

  it("reads Ollama's common model list when its own is not there", async () => {
    const fetchImpl = fetchFor({ "http://127.0.0.1:11434/v1/models": () => json({ data: [{ id: "llama3.2" }] }) });
    const servers = await detectLocalServers({ fetchImpl });
    assert.deepEqual(servers.map((s) => [s.id, s.models.map((m) => m.id)]), [["ollama", ["llama3.2"]]]);
  });

  it("ignores another program on a port, which does not answer with a model list", async () => {
    const fetchImpl = fetchFor({
      "http://127.0.0.1:8080/v1/models": () => json({ status: "ok" }),
      "http://127.0.0.1:8000/v1/models": () => new Response("<html>hello</html>", { status: 200 }),
    });
    assert.deepEqual(await detectLocalServers({ fetchImpl }), []);
  });

  it("reports a server that runs with no model loaded", async () => {
    const fetchImpl = fetchFor({ "http://127.0.0.1:1234/v1/models": () => json({ data: [] }) });
    assert.deepEqual(await detectLocalServers({ fetchImpl }), [{ id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", models: [] }]);
  });

  it("finds nothing when nothing runs", async () => {
    assert.deepEqual(await detectLocalServers({ fetchImpl: fetchFor({}) }), []);
  });

  it("does not wait for a server that does not answer", async () => {
    // AbortSignal.timeout's own timer does not keep the process alive, so this one does, until the abort comes.
    const hang = (init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("the request was never aborted")), 5000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(new Error("timed out"));
        });
      });
    const fetchImpl = fetchFor({
      "http://127.0.0.1:11434/api/tags": () => json({ models: [{ name: "qwen3:4b", size: 1 }] }),
      "http://127.0.0.1:8000/v1/models": hang,
    });
    const started = Date.now();
    const servers = await detectLocalServers({ fetchImpl, timeoutMs: 40 });
    assert.deepEqual(servers.map((s) => s.id), ["ollama"]);
    assert.ok(Date.now() - started < 2000);
  });
});
