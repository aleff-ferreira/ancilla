import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelList } from "../src/client.js";
import { alignLines, describeApproval, describeTool, diffFromEcho, diffLines, diffStats, extractDiff, formatDuration, formatTokens, lastLine, mergeDiffLines, modelDisplayName, relativeTime, shortenPath, withoutDiffEcho } from "../src/model/format.js";
import type { MspItem } from "../src/types.js";
import { modelList } from "./fixtures/probe.js";

const makeToolCall = (toolName: string, callArgs: unknown, status = "completed", visibleOutput?: string): MspItem => ({
  revision: 1,
  tool: toolName,
  status,
  kind: "toolCall",
  itemId: "i",
  args: JSON.stringify(callArgs),
  ...(visibleOutput === undefined ? {} : { visibleOutput }),
});

describe("metric and timestamp formatting", () => {
  it("formats relative times compactly", () => {
    const epochNow = Date.parse("2026-09-11T12:00:00Z");
    const testCases: Array<{ readonly stamp: string; readonly expected: string }> = [
      { stamp: "2026-09-11T11:59:40Z", expected: "now" },
      { stamp: "2026-09-11T11:56:00Z", expected: "4m" },
      { stamp: "2026-09-11T09:00:00Z", expected: "3h" },
      { stamp: "2026-09-09T12:00:00Z", expected: "2d" },
      { stamp: "2026-08-21T12:00:00Z", expected: "3w" },
      { stamp: "garbage", expected: "" },
    ];
    for (const { stamp, expected } of testCases) {
      assert.strictEqual(relativeTime(stamp, epochNow), expected);
    }
  });

  it("formats durations and token counts", () => {
    const durationExpectations: Array<readonly [number, string]> = [
      [42316, "42s"], [73471, "1m 13s"], [120000, "2m"], [3_900_000, "1h 5m"],
      [123, "123ms"], [999, "999ms"], [999.6, "1s"], [1000, "1s"],
    ];
    for (const [ms, want] of durationExpectations) {
      assert.strictEqual(formatDuration(ms), want);
    }

    const tokenExpectations: Array<readonly [number, string]> = [
      [842, "842"], [21177, "21k"], [1500, "1.5k"], [1_007_997, "1M"],
    ];
    for (const [count, want] of tokenExpectations) {
      assert.strictEqual(formatTokens(count), want);
    }
  });

  it("never prints a thousand thousands", () => {
    const millionThresholds: Array<readonly [number, string]> = [
      [999_499, "999k"], [999_500, "1M"], [999_999, "1M"], [1_000_000, "1M"],
    ];
    for (const [tokenCount, formattedResult] of millionThresholds) {
      assert.strictEqual(formatTokens(tokenCount), formattedResult);
    }
  });
});

describe("file path truncation and display", () => {
  it("shortens long paths from the middle", () => {
    assert.strictEqual(shortenPath("C:\\Workspace\\AncillaStudio", 48), "C:\\Workspace\\AncillaStudio");
    const clipped = shortenPath("C:\\Workspace\\Clients\\AcmeCorp\\Platform\\Packages\\UI\\Core", 32);
    assert.ok(clipped.startsWith("C:\\...\\"));
    assert.ok(clipped.endsWith("Core"));
    assert.ok(clipped.length <= 34);
  });
});

describe("tool execution descriptors and diff extraction", () => {
  it("describes a real bash call", () => {
    const invocation = makeToolCall("bash", { command: "git status -s", description: "Query working tree status" });
    const shellDescriptor = describeTool(invocation);
    assert.deepStrictEqual(shellDescriptor, {
      kind: "shell",
      verb: "Ran",
      subject: "git status -s",
      mono: true,
      note: "Query working tree status",
    });
    assert.strictEqual(describeTool(makeToolCall("bash", { command: "pnpm test" }, "inProgress")).verb, "Running");
  });

  it("describes questions, file tools, searches and unknown tools", () => {
    const userPrompt = describeTool(
      makeToolCall("request_user_input", { questions: [{ id: "q1", header: "Theme", question: "Which theme to apply?", options: [], selection: { mode: "single" } }] }),
    );
    assert.strictEqual(userPrompt.kind, "question");
    assert.strictEqual(userPrompt.subject, "Which theme to apply?");
    assert.strictEqual(describeTool(makeToolCall("read_file", { path: "src/server.ts" })).subject, "src/server.ts");
    assert.strictEqual(describeTool(makeToolCall("str_replace_editor", { file_path: "config.json", old_string: "dev", new_string: "prod" })).verb, "Edited");

    const grepSearch = describeTool(makeToolCall("grep", { pattern: "FIXME", path: "packages" }));
    assert.strictEqual(grepSearch.verb, "Searched for");
    assert.strictEqual(grepSearch.note, "packages");

    const customTool = describeTool(makeToolCall("custom_processor", { flag: true }));
    assert.strictEqual(customTool.kind, "generic");
    assert.strictEqual(customTool.subject, "Custom processor");

    const corruptedTool = describeTool({ itemId: "i", kind: "toolCall", status: "completed", revision: 1, tool: "bash", args: "{malformed json" });
    assert.strictEqual(corruptedTool.subject, "{malformed json");
  });

  it("extracts reviewable diffs from edit arguments", () => {
    const editDiff = extractDiff(makeToolCall("edit", { path: "utils.ts", old_string: "const x = 10;\nconst y = 20;", new_string: "const x = 30;" }));
    assert.ok(editDiff && "hunks" in editDiff);
    assert.deepStrictEqual(diffStats(editDiff), { added: 1, removed: 2 });

    const patchDiff = extractDiff(makeToolCall("apply_patch", { input: "*** Begin Patch\n--- test.ts\n+++ test.ts\n@@\n-prev\n+next\n+extra" }));
    assert.ok(patchDiff && "patch" in patchDiff);
    assert.deepStrictEqual(diffStats(patchDiff), { added: 2, removed: 1 });

    assert.strictEqual(extractDiff(makeToolCall("bash", { command: "uptime" })), null);
  });
});

describe("diff line alignment and hunk stream merging", () => {
  it("aligns an edit's padding lines as context and records insertions and deletions", () => {
    const beforeBlock = ["const x = 1;", "const y = 2;", "renderTree(", "<HeaderSection />", "<FooterSection />"].join("\n");
    const afterBlock = [
      "const x = 1;",
      "const y = 2;",
      "const flagA = true;",
      "const flagB = false;",
      "renderTree(",
      "<HeaderSection dynamic>",
      "<NavigationSpacer />",
      "<FooterSection />",
    ].join("\n");

    const multiLineDiff = extractDiff(makeToolCall("edit", { path: "LayoutView.tsx", old_string: beforeBlock, new_string: afterBlock }));
    assert.ok(multiLineDiff && "hunks" in multiLineDiff);
    const rowKinds = multiLineDiff.hunks[0]?.rows.map((row) => row.kind);
    assert.deepStrictEqual(rowKinds, ["same", "same", "add", "add", "same", "del", "add", "add", "same"]);
    assert.deepStrictEqual(diffStats(multiLineDiff), { added: 4, removed: 1 });
  });

  it("aligns one-sided changes without hunting for overlap", () => {
    assert.deepStrictEqual(alignLines([], ["foo", "bar"]).map((r) => r.kind), ["add", "add"]);
    assert.deepStrictEqual(alignLines(["foo", "bar"], []).map((r) => r.kind), ["del", "del"]);
    assert.deepStrictEqual(alignLines([], []), []);

    const writtenDiff = extractDiff(makeToolCall("write", { path: "README.md", content: "introduction\n" }));
    assert.ok(writtenDiff && "hunks" in writtenDiff);
    assert.deepStrictEqual(diffStats(writtenDiff), { added: 2, removed: 0 });
  });

  it("reads a giant edit as two plain blocks instead of aligning it", () => {
    const deletedLines = Array.from({ length: 2000 }, (_, idx) => `old line ${idx}`);
    const insertedLines = Array.from({ length: 2000 }, (_, idx) => `new line ${idx}`);
    const benchStart = Date.now();
    const alignedRows = alignLines(deletedLines, insertedLines);
    assert.ok(Date.now() - benchStart < 2000, `giant edit took ${Date.now() - benchStart}ms to align`);
    assert.strictEqual(alignedRows.length, 4000);
    assert.ok(alignedRows.every((row, idx) => (idx < 2000 ? row.kind === "del" : row.kind === "add")));
    assert.deepStrictEqual(alignedRows.map((r) => r.text), [...deletedLines, ...insertedLines]);

    assert.deepStrictEqual(alignLines(["same", "old"], ["same", "new"]).map((r) => r.kind), ["same", "del", "add"]);
  });

  it("strips the runtime's edit echo but keeps anything else the output carried", () => {
    const rawEcho = ["edited", "changed lines: lines 50-55", "--- original", "+++ updated", "@@", "-alpha", "+beta"].join("\n");
    assert.strictEqual(withoutDiffEcho(rawEcho), "");
    assert.strictEqual(withoutDiffEcho(`${rawEcho}\nwarning: deprecated api`), "warning: deprecated api");
    assert.strictEqual(withoutDiffEcho(`${rawEcho}\n${rawEcho}`), "");
    assert.strictEqual(withoutDiffEcho(rawEcho.replace(/\n/g, "\r\n")), "");

    for (const invalidCandidate of ["command not found: custom_cmd", "edited\nchanged lines: lines 1-2", "edited\nchanged lines: lines 1-2\n--- original\n+++ updated"]) {
      assert.strictEqual(withoutDiffEcho(invalidCandidate), null);
    }
  });

  it("reads the runtime's find/replace edit arguments", () => {
    const findSnippet = 'const serverUrl = "https://example.internal";\nconst requestTimeoutMs = 15000;';
    const replaceSnippet = 'const serverUrl = "https://example.internal";\nconst retryAttempts = 5;\nconst requestTimeoutMs = 15000;';
    const filePathTarget = "packages/core/src/network/client.ts";

    const editResult = extractDiff(makeToolCall("edit_file", { find: findSnippet, path: filePathTarget, replace: replaceSnippet }));
    assert.ok(editResult && "hunks" in editResult);
    assert.strictEqual(editResult.path, filePathTarget);
    assert.deepStrictEqual(editResult.hunks[0]?.rows.map((row) => row.kind), ["same", "add", "same"]);
    assert.deepStrictEqual(diffStats(editResult), { added: 1, removed: 0 });
  });

  it("builds the diff from the result's echo when the arguments do not carry it", () => {
    const echoBody = [
      "edited",
      "changed lines: lines 10-12",
      "--- original",
      "+++ updated",
      "@@",
      "-const alpha = 10;",
      "-const gamma = 30;",
      "+const alpha = 10;",
      "+const beta = 20;",
      "+const gamma = 30;",
    ].join("\n");

    const echoDiff = diffFromEcho(echoBody, "ServiceWorker.ts");
    assert.ok(echoDiff && "hunks" in echoDiff);
    assert.deepStrictEqual(echoDiff.hunks[0]?.rows.map((row) => row.kind), ["same", "add", "same"]);
    assert.deepStrictEqual(diffStats(echoDiff), { added: 1, removed: 0 });
    assert.strictEqual(diffFromEcho("command not found: unknown_binary", null), null);

    const fallbackToolDiff = extractDiff(makeToolCall("edit", { target: "test.ts", patch: null }, "completed", echoBody));
    assert.ok(fallbackToolDiff && "hunks" in fallbackToolDiff);
    assert.deepStrictEqual(diffStats(fallbackToolDiff), { added: 1, removed: 0 });

    assert.strictEqual(extractDiff(makeToolCall("edit", { target: "test.ts" }, "completed", "Done with zero output")), null);
  });

  it("flattens one diff into rows, marking the gaps between its hunks", () => {
    const sampleHunkRows = diffLines({
      path: "service.ts",
      hunks: [
        { rows: [{ kind: "same", text: "header" }] },
        { rows: [{ kind: "del", text: "deprecatedMethod()" }] },
      ],
    });
    assert.deepStrictEqual(sampleHunkRows.map((line) => [line.kind, line.text]), [
      ["ctx", "header"],
      ["meta", "..."],
      ["del", "deprecatedMethod()"],
    ]);

    const patchHunks = diffLines({ path: "service.ts", patch: "@@\n-legacyVal\n+updatedVal\n untouched" });
    assert.deepStrictEqual(patchHunks.map((line) => [line.kind, line.text]), [
      ["meta", "@@"],
      ["del", "legacyVal"],
      ["add", "updatedVal"],
      ["ctx", "untouched"],
    ]);
  });

  it("joins one file's diffs into a single continuous row stream, in order", () => {
    const diffPart1 = extractDiff(makeToolCall("edit_file", { path: "main.ts", find: "apple", replace: "APPLE" }));
    const diffPart2 = extractDiff(makeToolCall("edit_file", { path: "main.ts", find: "banana", replace: "BANANA" }));
    assert.ok(diffPart1 && "hunks" in diffPart1 && diffPart2 && "hunks" in diffPart2);
    assert.deepStrictEqual(
      mergeDiffLines([diffPart1, diffPart2]).map((line) => [line.kind, line.text]),
      [
        ["del", "apple"],
        ["add", "APPLE"],
        ["meta", "..."],
        ["del", "banana"],
        ["add", "BANANA"],
      ],
    );
    assert.deepStrictEqual(mergeDiffLines([]), []);
  });
});

describe("approval summaries and model catalog parsing", () => {
  it("describes approval subjects in plain language", () => {
    const baseApproval = { approvalId: "ap-9", sessionId: "session-1", availableChoices: [], currentRequirementId: null };
    assert.deepStrictEqual(describeApproval({ ...baseApproval, subject: { kind: "shell", command: "git push origin main" } }), {
      title: "Run a shell command",
      detail: "git push origin main",
      mono: true,
    });
    assert.strictEqual(describeApproval({ ...baseApproval, subject: { kind: "fileAccess", access: "write", path: "/var/log/syslog" } }).title, "Write to a file");
    assert.strictEqual(describeApproval({ ...baseApproval, subject: { kind: "network", host: "registry.npmjs.org", port: 443, protocol: "https" } }).detail, "https://registry.npmjs.org:443");
    assert.strictEqual(describeApproval({ ...baseApproval, subject: { kind: "somethingNew", target: "x" } }).title, "Allow something new");
  });

  it("takes the last non-blank line without reading the whole log", () => {
    const lineTestTable: Array<{ readonly textInput: string | undefined; readonly expectedTail: string | null }> = [
      { textInput: undefined, expectedTail: null },
      { textInput: "", expectedTail: null },
      { textInput: "\n", expectedTail: null },
      { textInput: "\n  \n", expectedTail: null },
      { textInput: "only", expectedTail: "only" },
      { textInput: "first\nsecond\n\n", expectedTail: "second" },
      { textInput: "first\nsecond", expectedTail: "second" },
      { textInput: "a\n\x1b[32mok\x1b[0m\n", expectedTail: "ok" },
      { textInput: "a\n\x1b[0m\n", expectedTail: "a" },
      { textInput: "a\r\nb\r\n", expectedTail: "b" },
    ];
    for (const { textInput, expectedTail } of lineTestTable) {
      assert.strictEqual(lastLine(textInput), expectedTail);
    }

    const hugeHead = `${"x".repeat(1000)}\n`.repeat(5000);
    assert.strictEqual(lastLine(`${hugeHead}tail\n\n\n`), "tail");
  });

  it("parses the real model catalog and flags contributor tiers", () => {
    const parsedModels = parseModelList(modelList);
    assert.strictEqual(parsedModels.length, 4);

    const contributorModel = parsedModels.find((m) => m.modelId === "muse-spark-1.3-contributor");
    assert.strictEqual(contributorModel?.contributor, true);
    assert.strictEqual(contributorModel?.isDefault, true);

    const standardModel = parsedModels.find((m) => m.modelId === "muse-spark-1.3");
    assert.strictEqual(standardModel?.contributor, false);

    assert.strictEqual(modelDisplayName("muse-spark-1.3-contributor"), "muse-spark-1.3");
  });

  it("names the model bucket the server uses for calls that carry no id", () => {
    assert.strictEqual(modelDisplayName("unknown"), "Unknown model");
    assert.strictEqual(modelDisplayName(null), "Default model");
    assert.strictEqual(modelDisplayName(""), "Default model");
  });

  it("prices a Wonder row from the table and leaves Wonder Full unpriced", () => {
    const [wonderModel, fullModel, catalogModel, bareModel] = parseModelList({
      models: [
        { modelId: "muse-wonder-1.0", displayLabel: "muse-wonder-1.0", contextLimit: 1_048_576, outputLimit: 128_000, cost: null },
        { modelId: "muse-wonder-full-1.0", displayLabel: "muse-wonder-full-1.0", cost: null },
        { modelId: "muse-spark-1.3", cost: { input: "3", output: "15", cached: "0.3", currency: "USD" } },
        { modelId: "muse-wonder-1.0-contributor" },
      ],
    });
    assert.deepStrictEqual(wonderModel?.cost, { input: 4, output: 20, cached: 0.2, currency: "USD" });
    assert.strictEqual(wonderModel?.contributor, false);
    assert.strictEqual(wonderModel?.contextLimit, 1_048_576);
    assert.strictEqual(fullModel?.cost, null);
    assert.deepStrictEqual(catalogModel?.cost, { input: 3, output: 15, cached: 0.3, currency: "USD" });
    assert.strictEqual(bareModel?.cost, null);
    assert.strictEqual(bareModel?.contributor, true);
  });

  it("skips catalog rows without an id and reads a bare array", () => {
    const filteredModels = parseModelList([{ displayLabel: "no id" }, null, { modelId: "muse-wonder-1.0" }]);
    assert.deepStrictEqual(filteredModels.map((m) => m.modelId), ["muse-wonder-1.0"]);
  });
});
