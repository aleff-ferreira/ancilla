import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findModel, matchSlash, modelMatches, parseEffort, parseMode, parseSlash, resolveSlash, skillSummary, skillTurn, slashCommands, SKILL_PREAMBLE } from "../src/model/slash.js";
import type { ModelOption, SkillEntry } from "../src/types.js";

function buildMockSkill(skillName: string, propOverrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    id: `bundled:${skillName}`,
    name: skillName,
    displayName: skillName,
    description: `Does ${skillName} things. Use ONLY when asked.`,
    shortDescription: null,
    scope: "bundled",
    activation: "on",
    ...propOverrides,
  };
}

const TEST_SKILL_CATALOG = [
  buildMockSkill("plan"),
  buildMockSkill("git"),
  buildMockSkill("taste"),
  buildMockSkill("compact"),
  buildMockSkill("threejs", { id: "plugin:threejs:threejs", scope: "plugin" }),
];

describe("parseSlash - Leading Command & Argument Extraction", () => {
  it("extracts leading command and separated arguments while ignoring paths and bare slashes", () => {
    const multiLine = parseSlash("/Plan  tidy the API\nand tests");
    assert.deepStrictEqual(multiLine, { name: "plan", args: "tidy the API\nand tests" });

    const trimmed = parseSlash("  /compact ");
    assert.deepStrictEqual(trimmed, { name: "compact", args: "" });

    const pluginCmd = parseSlash("/plugin:threejs:threejs scene");
    assert.deepStrictEqual(pluginCmd, { name: "plugin:threejs:threejs", args: "scene" });

    assert.strictEqual(parseSlash("/usr/bin/node crashes"), null);
    assert.strictEqual(parseSlash("/"), null);
    assert.strictEqual(parseSlash("fix /compact"), null);
  });
});

describe("slashCommands - Built-in & Skill Command Catalog", () => {
  it("prioritizes built-in actions and suppresses thread-only items outside thread view", () => {
    const threadCommands = slashCommands(TEST_SKILL_CATALOG, { inThread: true }).map((c) => c.name);
    assert.deepStrictEqual(threadCommands.slice(0, 3), ["compact", "model", "effort"]);
    assert.ok(threadCommands.includes("plan"));
    assert.ok(threadCommands.includes("threejs"));

    const compactMatches = threadCommands.filter((item) => item === "compact");
    assert.strictEqual(compactMatches.length, 1, "Built-in command must take precedence over colliding skill name");

    const homeCommands = slashCommands(TEST_SKILL_CATALOG, { inThread: false }).map((c) => c.name);
    assert.strictEqual(homeCommands.includes("compact"), false);
    assert.strictEqual(homeCommands.includes("fork"), false);
  });

  it("configures deep research command with question hint and disallows empty execution", () => {
    const researchCmd = slashCommands([], { inThread: false }).find((c) => c.name === "research");
    assert.ok(researchCmd !== undefined);
    assert.strictEqual(researchCmd.action, "research");
    assert.strictEqual(researchCmd.hint, "<question>");
    assert.strictEqual(researchCmd.runsBare, false);
    assert.strictEqual(researchCmd.needsThread, false);
    assert.match(researchCmd.description, /cited report/);

    const matches = matchSlash(slashCommands(TEST_SKILL_CATALOG, { inThread: true }), "rese");
    assert.strictEqual(matches[0]?.name, "research");

    const resolvedAction = resolveSlash(
      { name: "research", args: "what changed in WCAG 2.2?" },
      slashCommands(TEST_SKILL_CATALOG, { inThread: true }),
      TEST_SKILL_CATALOG,
    );
    assert.strictEqual(resolvedAction.kind, "action");
    if (resolvedAction.kind === "action") {
      assert.strictEqual(resolvedAction.args, "what changed in WCAG 2.2?");
    }
  });
});

describe("matchSlash - Ranking & Fuzzy Autocomplete Matching", () => {
  it("ranks prefix and exact matches before secondary skills and resolves aliases", () => {
    const activeFleet = slashCommands(TEST_SKILL_CATALOG, { inThread: true });
    const pMatches = matchSlash(activeFleet, "p").map((c) => c.name);
    assert.deepStrictEqual(pMatches, ["permissions", "compact", "plan"]);

    const clearMatches = matchSlash(activeFleet, "clear");
    assert.strictEqual(clearMatches[0]?.name, "new");

    const pluginMatches = matchSlash(activeFleet, "thr");
    assert.strictEqual(pluginMatches[0]?.name, "threejs");

    assert.deepStrictEqual(matchSlash(activeFleet, "zzz"), []);
  });
});

describe("resolveSlash - Command Dispatch & Skill Invocation", () => {
  it("resolves built-in actions, skill invocations, qualified skill IDs, and unknown entries", () => {
    const activeFleet = slashCommands(TEST_SKILL_CATALOG, { inThread: true });
    const evaluate = (rawInput: string) => resolveSlash(parseSlash(rawInput)!, activeFleet, TEST_SKILL_CATALOG);

    const effortAction = evaluate("/effort high");
    assert.deepStrictEqual(effortAction, {
      kind: "action",
      command: activeFleet.find((c) => c.name === "effort"),
      args: "high",
    });

    assert.strictEqual(evaluate("/plan tidy").kind, "skill");

    const qualifiedSkill = evaluate("/skill bundled:compact shrink it");
    assert.strictEqual(qualifiedSkill.kind, "skill");
    if (qualifiedSkill.kind === "skill") {
      assert.strictEqual(qualifiedSkill.skill.name, "compact");
      assert.strictEqual(qualifiedSkill.args, "shrink it");
    }

    assert.deepStrictEqual(evaluate("/skill nope"), { kind: "unknown", name: "skill nope" });
    assert.deepStrictEqual(evaluate("/deploy now"), { kind: "unknown", name: "deploy" });
  });
});

describe("skillTurn - Prompt Construction for Skill Loading", () => {
  it("formats structured skill loading instructions and wraps user-provided bodies", () => {
    const planSkill = TEST_SKILL_CATALOG[0]!;
    const loadedTurn = skillTurn(planSkill, "tidy the API", "/plan tidy the API", null);
    assert.strictEqual(loadedTurn.displayText, "/plan tidy the API");
    assert.match(loadedTurn.text, /read_skill with name "bundled:plan" first, then apply it to: tidy the API$/);

    const inlineTurn = skillTurn(planSkill, "", "/plan", "# Plan\nSteps.");
    assert.ok(inlineTurn.text.startsWith(SKILL_PREAMBLE));
    assert.match(inlineTurn.text, /<skill-body id="bundled:plan">\n# Plan\nSteps\.\n<\/skill-body>/);
    assert.match(inlineTurn.text, /conversation so far\.$/);
  });
});

describe("Model and Parameter Parsers (parseEffort, parseMode, findModel)", () => {
  it("normalizes reasoning effort strings and maps Ultra to max", () => {
    assert.strictEqual(parseEffort("Off"), "none");
    assert.strictEqual(parseEffort("auto"), null);
    assert.strictEqual(parseEffort("extra high"), "xhigh");
    assert.strictEqual(parseEffort("ultra"), "max");
    assert.strictEqual(parseEffort("loud"), undefined);

    assert.strictEqual(parseMode("full"), "allowAll");
    assert.strictEqual(parseMode("Ask first"), "onRequest");
    assert.strictEqual(parseMode("maybe"), undefined);

    const sampleModels = [
      { modelId: "muse-spark-1.3", displayLabel: "Muse Spark 1.3" },
      { modelId: "muse-max-2", displayLabel: "Muse Max 2" },
    ] as ModelOption[];
    const idEcho = (ident: string) => ident;
    assert.strictEqual(findModel(sampleModels, "muse max 2", idEcho)?.modelId, "muse-max-2");
    assert.strictEqual(findModel(sampleModels, "muse-sp", idEcho)?.modelId, "muse-spark-1.3");
    assert.strictEqual(findModel(sampleModels, "gpt", idEcho), undefined);
  });

  it("resolves model options prioritizing canonical entries over contributor twins", () => {
    const buildOption = (id: string, label = id) => ({ modelId: id, displayLabel: label }) as ModelOption;
    const modelCandidates = [
      buildOption("muse-spark-1.3-contributor"),
      buildOption("muse-spark-1.3"),
      buildOption("muse-wonder-1.0"),
    ];

    assert.strictEqual(findModel(modelCandidates, "muse-spark-1.3")?.modelId, "muse-spark-1.3");
    assert.strictEqual(findModel(modelCandidates, "Muse-Spark-1.3 ")?.modelId, "muse-spark-1.3");
    assert.strictEqual(
      findModel(modelCandidates, "muse-spark-1.3-contributor")?.modelId,
      "muse-spark-1.3-contributor",
    );
    assert.strictEqual(
      findModel(modelCandidates, "muse spark 1.3 contributor")?.modelId,
      "muse-spark-1.3-contributor",
    );
    assert.strictEqual(findModel(modelCandidates, "wonder")?.modelId, "muse-wonder-1.0");
    assert.strictEqual(findModel(modelCandidates, "muse wonder 1.0")?.modelId, "muse-wonder-1.0");
    assert.strictEqual(findModel(modelCandidates, "spark")?.modelId, "muse-spark-1.3");
    assert.strictEqual(findModel(modelCandidates, ""), undefined);

    // Ambiguity handling between diverging families
    const ambiguousCatalog = [...modelCandidates, buildOption("muse-wonder-full-x")];
    assert.strictEqual(findModel(ambiguousCatalog, "wonder"), undefined);
    assert.strictEqual(findModel(ambiguousCatalog, "muse-wonder-1.0")?.modelId, "muse-wonder-1.0");
    assert.deepStrictEqual(
      modelMatches(ambiguousCatalog, "wonder").map((m) => m.modelId),
      ["muse-wonder-1.0", "muse-wonder-full-x"],
    );
  });
});

describe("Plugin Skill Shortcuts & Description Summarization", () => {
  it("derives clean shortname from composite plugin identifiers", () => {
    const pluginInstance = buildMockSkill("plugin:threejs:threejs", {
      id: "plugin:threejs:threejs",
      scope: "plugin",
    });
    const commandSet = slashCommands([pluginInstance], { inThread: true });
    assert.strictEqual(commandSet.at(-1)?.name, "threejs");

    const resolved = resolveSlash(parseSlash("/skill threejs a scene")!, commandSet, [pluginInstance]);
    assert.strictEqual(resolved.kind, "skill");
    if (resolved.kind === "skill") {
      assert.strictEqual(resolved.skill.id, "plugin:threejs:threejs");
      assert.strictEqual(resolved.args, "a scene");
    }
  });

  it("extracts concise summary sentence from multi-sentence skill descriptions", () => {
    assert.strictEqual(skillSummary(buildMockSkill("plan")), "Does plan things.");
    assert.strictEqual(
      skillSummary(buildMockSkill("x", { shortDescription: "Import a session" })),
      "Import a session",
    );
  });
});

describe("Effort Preference Migration", () => {
  it("migrates legacy ultra effort setting to modern max standard", async () => {
    const { defaultPrefs, revivePrefs } = await import("../src/model/store.js");
    assert.strictEqual(revivePrefs({ effort: "ultra" }, defaultPrefs()).effort, "max");
    assert.strictEqual(revivePrefs({ effort: "xhigh" }, defaultPrefs()).effort, "xhigh");
  });
});
