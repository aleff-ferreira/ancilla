import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RESEARCH_CONFIG, assignCodes, type ObservedToolCall, type ResearchRunRecord, type ResearchRunState, type SourceEntry, type WorkerResult } from "@ancilla/daemon";
import { argUrlsOf, classifyTool, isWebTool, runView, workerApprovalAllowed } from "../src/research/index.js";
import { BUDGETS, TASK, noSink, workerRig } from "./research-rigs.js";
import type { FakeConnection } from "./harness.js";

type Item = Record<string, unknown>;

/** A tool-call item the way Muse reports one: the model's arguments verbatim as a JSON string. */
function call(itemId: string, tool: string, args: unknown, status: string, extra: Item = {}): Item {
  return { itemId, kind: "toolCall", tool, args: typeof args === "string" ? args : JSON.stringify(args), status, turnId: "wt1", revision: 1, ...extra };
}

/** Runs one worker turn in which Muse delivers `events` and then completes the turn. */
async function runTurn(events: (notify: (method: string, item: Item) => void) => void, options: { terminal?: string } = {}): Promise<{ result: WorkerResult; logs: string[]; live: ObservedToolCall[]; connection: FakeConnection; progress: { toolCalls: number; searches: number; reads: number }[] }> {
  const { connection, runner, logs } = workerRig();
  connection.replies.set("item/readOutput", { content: "", encoding: "utf8", mediaType: "text/plain", offsetBytes: 0, byteLen: 0, eof: true });
  connection.replies.set("turn/start", (params: Record<string, unknown>) => {
    const sessionId = params["sessionId"] as string;
    setTimeout(() => {
      connection.notify("turn/started", { sessionId, turnId: "wt1" });
      events((method, item) => connection.notify(method, { sessionId, item }));
      connection.notify("turn/completed", { sessionId, turnId: "wt1", terminal: options.terminal ?? "completed" });
    }, 5);
    return { turnId: "wt1", status: "accepted" };
  });
  const live: ObservedToolCall[] = [];
  const progress: { toolCalls: number; searches: number; reads: number }[] = [];
  const result = await runner.run(TASK, BUDGETS, new AbortController().signal, { onToolCall: (c) => live.push(c), onProgress: (counts) => progress.push({ ...counts }) });
  return { result, logs, live, connection, progress };
}

const SEARCH_OUTPUT = JSON.stringify({ results: [{ url: "https://a.example/hit", title: "A hit" }] });

describe("the terminal outcome of a tool call", () => {
  it("maps Muse's item status, failureKind and failureReason to ok, failed or cancelled", async () => {
    const url = { url: "https://a.example/x" };
    const { result } = await runTurn((notify) => {
      notify("item/completed", call("ok", "web_fetch", url, "completed", { visibleOutput: "The page text." }));
      notify("item/completed", call("failed", "web_fetch", url, "failed", { failureKind: "network", failureReason: "getaddrinfo ENOTFOUND a.example" }));
      notify("item/completed", call("rejected", "web_fetch", url, "rejected", { failureReason: "blocked by policy" }));
      notify("item/completed", call("timed", "web_fetch", url, "timedOut", { failureKind: "timeout" }));
      notify("item/completed", call("cancelled", "web_fetch", url, "cancelled"));
      notify("item/completed", call("soft", "web_fetch", url, "completed", { failureKind: "http_error", failureReason: "404" }));
      notify("item/completed", call("novel", "web_fetch", url, "somethingNew"));
    });
    assert.deepEqual(
      result.observed.map((o) => o.outcome),
      ["ok", "failed", "failed", "failed", "cancelled", "failed", "unreported"],
      "a completed call that still carries a failure kind is a failure; an unknown terminal status is not taken for success",
    );
  });

  it("records the size of the output when it is known and null when it is not", async () => {
    const url = { url: "https://a.example/x" };
    const { result } = await runTurn((notify) => {
      notify("item/completed", call("text", "web_fetch", url, "completed", { visibleOutput: "twelve chars" }));
      notify("item/completed", call("empty", "web_fetch", url, "completed", { visibleOutput: "" }));
      notify("item/completed", call("absent", "web_fetch", url, "completed"));
      notify("item/completed", call("stored", "web_fetch", url, "completed", { visibleOutput: "", outputRef: { id: "out-1", kind: "tool_output", availability: "available", byteLen: 900, uri: "muse://out-1" } }));
    });
    assert.deepEqual(
      result.observed.map((o) => o.outputSize),
      [12, 0, null, 900],
    );
  });

  it("takes the outcome and the output from item/completed, not from an earlier terminal-looking update", async () => {
    const { result } = await runTurn((notify) => {
      notify("item/started", call("s1", "web_search", { query: "q" }, "inProgress"));
      // A terminal status with no output yet, as Muse streams it, and only then the authoritative object.
      notify("item/updated", call("s1", "web_search", { query: "q" }, "completed", { revision: 2 }));
      notify("item/completed", call("s1", "web_search", { query: "q" }, "completed", { revision: 3, visibleOutput: SEARCH_OUTPUT }));
      notify("item/started", call("f1", "web_fetch", { url: "https://a.example/x" }, "inProgress"));
      notify("item/updated", call("f1", "web_fetch", { url: "https://a.example/x" }, "completed", { revision: 2 }));
      notify("item/completed", call("f1", "web_fetch", { url: "https://a.example/x" }, "failed", { revision: 3, failureKind: "network", failureReason: "ENOTFOUND" }));
    });
    const [search, fetch] = result.observed;
    assert.deepEqual(search?.results, [{ url: "https://a.example/hit", title: "A hit" }], "the search hits of the completed object are kept");
    assert.equal(search?.outcome, "ok");
    assert.equal(fetch?.outcome, "failed", "a later failure is not lost to the provisional completed");
    assert.equal(result.observed.length, 2, "each call is reported once");
  });

  it("finalizes a call that never reached item/completed from its last terminal sighting, and the rest as unreported", async () => {
    const { result, live } = await runTurn((notify) => {
      notify("item/started", call("only-updated", "web_fetch", { url: "https://a.example/u" }, "inProgress"));
      notify("item/updated", call("only-updated", "web_fetch", { url: "https://a.example/u" }, "failed", { revision: 2, failureKind: "network" }));
      notify("item/started", call("hung", "web_fetch", { url: "https://a.example/h" }, "inProgress"));
    });
    assert.deepEqual(
      result.observed.map((o) => [o.urls[0], o.outcome]),
      [
        ["https://a.example/u", "failed"],
        ["https://a.example/h", "unreported"],
      ],
    );
    assert.equal(live.length, 2, "the sink hears about them as well");
  });
});

describe("which URLs a call is credited with", () => {
  it("takes fetch URLs from the structured url, urls, href, uri and link arguments only", async () => {
    const { result } = await runTurn((notify) => {
      notify("item/completed", call("a", "web_fetch", { url: "https://a.example/1" }, "completed", { visibleOutput: "x" }));
      notify("item/completed", call("b", "web_fetch", { urls: ["https://a.example/2", "https://a.example/3"] }, "completed", { visibleOutput: "x" }));
      notify("item/completed", call("c", "web_fetch", { href: "https://a.example/4" }, "completed", { visibleOutput: "x" }));
      notify("item/completed", call("d", "web_fetch", { uri: "https://a.example/5" }, "completed", { visibleOutput: "x" }));
      notify("item/completed", call("e", "web_fetch", { link: "https://a.example/6" }, "completed", { visibleOutput: "x" }));
    });
    assert.deepEqual(
      result.observed.map((o) => o.urls),
      [["https://a.example/1"], ["https://a.example/2", "https://a.example/3"], ["https://a.example/4"], ["https://a.example/5"], ["https://a.example/6"]],
    );
  });

  it("does not adopt a URL from a prompt, command or content argument", async () => {
    const { result } = await runTurn((notify) => {
      notify("item/completed", call("a", "web_fetch", { url: "https://a.example/x", prompt: "also see https://b.example/y" }, "completed", { visibleOutput: "x" }));
      notify("item/completed", call("b", "web_fetch", { prompt: "summarise https://b.example/y" }, "completed", { visibleOutput: "x" }));
      notify("item/completed", call("c", "web_fetch", "fetch https://c.example/z please", "completed", { visibleOutput: "x" }));
    });
    assert.deepEqual(
      result.observed.map((o) => o.urls),
      [["https://a.example/x"], [], []],
    );
  });

  it("does not adopt a URL that only appears in the output of a fetch, failed or not", async () => {
    const { result } = await runTurn((notify) => {
      notify("item/completed", call("a", "web_fetch", { url: "https://a.example/x" }, "failed", { failureKind: "http_error", visibleOutput: "404, try https://mirror.example/x instead" }));
      notify("item/completed", call("b", "web_fetch", { query: "no url argument" }, "completed", { visibleOutput: "See https://c.example/z" }));
    });
    assert.deepEqual(
      result.observed.map((o) => o.urls),
      [["https://a.example/x"], []],
    );
  });

  it("credits nothing to a tool of the 'other' kind, to a denied shell command or to a think call", async () => {
    const { result } = await runTurn((notify) => {
      notify("item/completed", call("a", "read_page", { url: "https://a.example/page" }, "completed", { visibleOutput: "See https://a.example/more" }));
      notify("item/completed", call("b", "bash", { command: "curl https://b.example/x" }, "rejected", { failureReason: "denied by Ancilla policy" }));
      notify("item/completed", call("c", "think", { thought: "I remember https://c.example/y", url: "https://c.example/y" }, "completed"));
    });
    assert.deepEqual(
      result.observed.map((o) => [o.tool, o.kind, o.urls, o.results]),
      [
        ["read_page", "other", [], []],
        ["bash", "other", [], []],
        ["think", "other", [], []],
      ],
    );
  });

  it("gives a search that did not end ok no results, even when its output lists some", async () => {
    const { result } = await runTurn((notify) => {
      notify("item/completed", call("a", "web_search", { query: "q" }, "failed", { failureKind: "rate_limited", visibleOutput: SEARCH_OUTPUT }));
      notify("item/completed", call("b", "web_search", { query: "q" }, "cancelled", { visibleOutput: SEARCH_OUTPUT }));
      notify("item/completed", call("c", "web_search", { query: "q" }, "completed", { visibleOutput: SEARCH_OUTPUT }));
    });
    assert.deepEqual(
      result.observed.map((o) => [o.outcome, o.urls, o.results.length]),
      [
        ["failed", [], 0],
        ["cancelled", [], 0],
        ["ok", ["https://a.example/hit"], 1],
      ],
    );
  });

  it("keeps reading a search's stored output when the visible part is truncated, and not when the call failed", async () => {
    const { connection, result } = await runTurn((notify) => {
      const ref = { id: "out-9", kind: "tool_output", availability: "available", byteLen: 4000, uri: "muse://out-9" };
      notify("item/completed", call("ok", "web_search", { query: "q" }, "completed", { truncated: true, visibleOutput: "Res", outputRef: ref }));
      notify("item/completed", call("bad", "web_search", { query: "q" }, "failed", { truncated: true, visibleOutput: "Res", outputRef: ref }));
    });
    assert.deepEqual(
      connection.requests.filter((r) => r.method === "item/readOutput").map((r) => r.params?.["itemId"]),
      ["ok"],
      "only the call that ended ok is read",
    );
    assert.deepEqual(result.observed.map((o) => o.outcome), ["ok", "failed"]);
  });

  it("parses the arguments the way the tests above say, on their own", () => {
    assert.deepEqual(argUrlsOf(JSON.stringify({ url: "https://a.example/x", prompt: "see https://b.example/y" })), ["https://a.example/x"]);
    assert.deepEqual(argUrlsOf(JSON.stringify({ uri: "https://a.example/u", link: "https://a.example/l" })), ["https://a.example/u", "https://a.example/l"]);
    assert.deepEqual(argUrlsOf("fetch https://a.example/plain now"), []);
    assert.deepEqual(argUrlsOf(JSON.stringify({ url: "ftp://a.example/x", href: "/relative" })), []);
  });

  it("reads a batch fetch whose requests are nested in an array or under a batch key", () => {
    assert.deepEqual(argUrlsOf(JSON.stringify({ requests: [{ url: "https://a.example/1" }, { url: "https://a.example/2" }] })), ["https://a.example/1", "https://a.example/2"]);
    assert.deepEqual(argUrlsOf(JSON.stringify([{ url: "https://a.example/3" }, { href: "https://a.example/4" }])), ["https://a.example/3", "https://a.example/4"]);
    assert.deepEqual(argUrlsOf(JSON.stringify({ batch: { pages: [{ link: "https://a.example/5" }] } })), [], "an unknown wrapper key is not walked");
    assert.deepEqual(argUrlsOf(JSON.stringify({ pages: [{ link: "https://a.example/5" }] })), ["https://a.example/5"]);
  });

  it("does not credit a URL in a nested options object next to the one the tool was asked to open", () => {
    assert.deepEqual(argUrlsOf(JSON.stringify({ url: "https://a.example/x", options: { link: "https://evil.example/y", headers: { uri: "https://evil.example/z" } } })), ["https://a.example/x"]);
    assert.deepEqual(argUrlsOf(JSON.stringify({ requests: [{ url: "https://a.example/1", options: { link: "https://evil.example/y" } }] })), ["https://a.example/1"]);
  });

  it("reads almost-JSON arguments for the same keys only, never for a URL anywhere in the text", () => {
    assert.deepEqual(argUrlsOf('{"url": "https://a.example/x", "prompt": "see https://b.example/y",}'), ["https://a.example/x"]);
    assert.deepEqual(argUrlsOf("{'url': 'https://a.example/q', 'note': 'https://b.example/n'}"), ["https://a.example/q"]);
    assert.deepEqual(argUrlsOf('please run {"url": "https://a.example/p"} for me'), ["https://a.example/p"], "an object inside prose is still read as JSON");
    assert.deepEqual(argUrlsOf('{"prompt": "see https://b.example/y",}'), []);
  });
});

describe("web tools the runner does not recognise", () => {
  it("warns once per tool name when an 'other' call with a URL argument ended ok, and credits it nothing", async () => {
    const { result, logs } = await runTurn((notify) => {
      notify("item/completed", call("a", "visit_page", { url: "https://a.example/1" }, "completed", { visibleOutput: "page" }));
      notify("item/completed", call("b", "visit_page", { url: "https://a.example/2" }, "completed", { visibleOutput: "page" }));
      notify("item/completed", call("c", "scrape", { url: "https://a.example/3" }, "completed", { visibleOutput: "page" }));
      // None of these says "a web tool that worked": a failure, a call without a URL and a shell command.
      notify("item/completed", call("d", "get_page", { url: "https://a.example/4" }, "failed", { failureKind: "network" }));
      notify("item/completed", call("e", "think", { thought: "hm" }, "completed"));
      notify("item/completed", call("f", "bash", { command: "curl https://a.example/5" }, "completed", { visibleOutput: "x" }));
    });
    assert.ok(result.observed.every((o) => o.urls.length === 0));
    const warnings = logs.filter((l) => /unclassified web tool/.test(l));
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? "", /visit_page/);
    assert.match(warnings[1] ?? "", /scrape/);
  });
});

describe("Muse's own local tools", () => {
  // Muse names its workspace text search plain `search` (task kind tool.search, arguments pattern, paths and
  // output_mode). Its output is workspace text, which can hold any URL: it is no web search and no web tool.
  const LOCAL_OUTPUT = "docs/notes.md:3: see https://internal.example/secret-plan\nREADME.md:9: https://other.example/page";
  const localArgs = { pattern: "secret", paths: ["docs"], output_mode: "content" };

  it("classifies the local search and file tools as 'other', and keeps the web search names as 'search'", () => {
    for (const name of ["search", "Search", "grep", "glob", "file_search", "search_files", "code_search", "codebase_search", "FileSearch", "workspace-search", "search_code"]) {
      assert.equal(classifyTool(name), "other", name);
      assert.equal(isWebTool(name), false, name);
    }
    for (const name of ["web_search", "WebSearch", "websearch", "search_web", "internet_search", "bing_search", "exa_search", "tavily_search", "brave_search"]) {
      assert.equal(classifyTool(name), "search", name);
    }
    assert.equal(classifyTool("web_fetch"), "fetch");
  });

  it("does not approve the local search for a worker, which may only use web tools", () => {
    assert.equal(workerApprovalAllowed("tool", "search"), false);
    assert.equal(workerApprovalAllowed("network", "search"), false);
    assert.equal(workerApprovalAllowed("tool", "web_search"), true);
  });

  it("takes no URL from a local `search` call's output, counts it as no search, and leaves a saved URL uncitable", async () => {
    const { result, progress } = await runTurn((notify) => {
      notify("item/completed", call("local", "search", localArgs, "completed", { visibleOutput: LOCAL_OUTPUT }));
    });
    assert.deepEqual(
      result.observed.map((o) => [o.tool, o.kind, o.outcome, o.urls, o.results]),
      [["search", "other", "ok", [], []]],
    );
    assert.deepEqual(progress[progress.length - 1], { toolCalls: 1, searches: 0, reads: 0 }, "it does not spend the worker's search allowance");
    const [entry] = assignCodes(1, [{ url: "https://internal.example/secret-plan", title: null, reason: "", excerpt: null }], result.observed, 1);
    assert.deepEqual([entry?.verified, entry?.provenance], [false, "unobserved"]);
  });

  it("still takes a web search's hits as search results", async () => {
    const { result } = await runTurn((notify) => {
      notify("item/completed", call("web", "web_search", { query: "secret" }, "completed", { visibleOutput: SEARCH_OUTPUT }));
    });
    const [entry] = assignCodes(1, [{ url: "https://a.example/hit", title: null, reason: "", excerpt: null }], result.observed, 1);
    assert.deepEqual([result.observed[0]?.kind, entry?.verified, entry?.provenance], ["search", true, "search_only"]);
  });
});

describe("a terminal sighting that is not item/completed", () => {
  it("does not take a completed status with no output for proof that a fetch was retrieved", async () => {
    const { result } = await runTurn((notify) => {
      notify("item/started", call("f", "web_fetch", { url: "https://a.example/x" }, "inProgress"));
      notify("item/updated", call("f", "web_fetch", { url: "https://a.example/x" }, "completed", { revision: 2 }));
    });
    assert.deepEqual(result.observed.map((o) => [o.outcome, o.outputSize]), [["unreported", null]]);
    const [entry] = assignCodes(1, [{ url: "https://a.example/x", title: null, reason: "", excerpt: null }], result.observed, 1);
    assert.deepEqual([entry?.verified, entry?.provenance], [false, "attempted"]);
  });

  it("keeps a completed sighting that carries its output, and a failure seen only on an update", async () => {
    const { result } = await runTurn((notify) => {
      notify("item/started", call("a", "web_fetch", { url: "https://a.example/a" }, "inProgress"));
      notify("item/updated", call("a", "web_fetch", { url: "https://a.example/a" }, "completed", { revision: 2, visibleOutput: "the page" }));
      notify("item/started", call("b", "web_fetch", { url: "https://a.example/b" }, "inProgress"));
      notify("item/updated", call("b", "web_fetch", { url: "https://a.example/b" }, "failed", { revision: 2, failureKind: "network" }));
    });
    assert.deepEqual(result.observed.map((o) => [o.outcome, o.outputSize]), [["ok", 8], ["failed", null]]);
  });
});

describe("what the runner logs about a web call", () => {
  it("names the tool, its outcome, Muse's status and failure kind and the output size", async () => {
    const { logs } = await runTurn((notify) => {
      notify("item/completed", call("a", "web_fetch", { url: "https://a.example/x" }, "failed", { failureKind: "network", failureReason: "ENOTFOUND", visibleOutput: "" }));
      notify("item/completed", call("b", "web_search", { query: "q" }, "completed", { visibleOutput: SEARCH_OUTPUT }));
    });
    assert.ok(logs.some((l) => /web_fetch failed \(failed, network\), output 0/.test(l)), logs.join("\n"));
    assert.ok(logs.some((l) => /web_search ok \(completed\), output \d+/.test(l)), logs.join("\n"));
  });
});

// ---------------------------------------------------------------- the run view

function recordWith(state: ResearchRunState | null): ResearchRunRecord {
  return {
    id: "run-1",
    sessionId: "s1",
    commandId: "c1",
    status: "completed",
    question: "q",
    config: DEFAULT_RESEARCH_CONFIG,
    state,
    report: "# R",
    failure: null,
    reportPath: null,
    createdAt: "2026-09-26T10:00:00.000Z",
    startedAt: "2026-09-26T10:00:01.000Z",
    endedAt: "2026-09-26T10:05:00.000Z",
  };
}

function stateWith(registry: SourceEntry[], patch: Partial<ResearchRunState> = {}): ResearchRunState {
  return {
    version: 1,
    runId: "run-1",
    eventSeq: 0,
    question: "q",
    config: DEFAULT_RESEARCH_CONFIG,
    phase: "done",
    brief: "A brief",
    inputLanguage: "en",
    targetLanguage: "en",
    draft: null,
    rounds: [],
    registry,
    curated: [],
    notes: [],
    consecutiveFailures: 0,
    aborted: false,
    abortReason: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
    startedAt: "2026-09-26T10:00:00.000Z",
    researchDeadlineAt: "2026-09-26T10:10:00.000Z",
    nextAgentId: 1,
    ...patch,
  };
}

const row = (n: number, verified: boolean, provenance?: SourceEntry["provenance"]): SourceEntry => ({ code: `A1-S${n}`, url: `https://e.example/${n}`, title: null, agentId: 1, round: 1, verified, ...(provenance ? { provenance } : {}) });

describe("runView source counts", () => {
  it("counts how each source was reached and keeps the verified count", () => {
    const registry = [row(1, true, "retrieved"), row(2, true, "retrieved"), row(3, true, "search_only"), row(4, false, "attempted"), row(5, true, "attempted"), row(6, false, "unobserved")];
    const view = runView(recordWith(stateWith(registry)), [], { withReport: false });
    assert.deepEqual(view.sources, { registry: 6, verified: 4, curated: 0, opened: 2, searchOnly: 1, attempted: 2, listedEarlier: 0, evidence: 51 });
  });

  it("lists a row from before provenance as listed by an earlier version only when it was verified, and never as opened", () => {
    const registry = [row(1, true), row(2, true), row(3, false), row(4, true, "retrieved")];
    const view = runView(recordWith(stateWith(registry)), [], { withReport: false });
    assert.deepEqual(view.sources, { registry: 4, verified: 3, curated: 0, opened: 1, searchOnly: 0, attempted: 0, listedEarlier: 2, evidence: 33 });
  });

  it("carries the no-citable-sources condition only when it was recorded", () => {
    const flagged = runView(recordWith(stateWith([], { noCitableSources: true })), [], { withReport: false });
    assert.equal(flagged.noCitableSources, true);
    const plain = runView(recordWith(stateWith([row(1, true, "retrieved")])), [], { withReport: false });
    assert.equal("noCitableSources" in plain, false);
    assert.equal("noCitableSources" in runView(recordWith(null), [], { withReport: false }), false);
  });

  it("round-trips a state written before provenance through JSON and the view without inventing evidence", () => {
    const old = stateWith([row(1, true), row(2, false)]);
    const revived = JSON.parse(JSON.stringify(old)) as ResearchRunState;
    assert.deepEqual(revived.registry, old.registry);
    const view = runView(recordWith(revived), [], { withReport: false });
    assert.equal(view.sources.opened, 0);
    assert.equal(view.sources.listedEarlier, 1);
  });
});
