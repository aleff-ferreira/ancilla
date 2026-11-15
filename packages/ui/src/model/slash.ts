/**
 * Slash command definitions, syntax parser, and interactive menu matching.
 * Provides autocompletion and routing for built-in operations and custom skills.
 */

import type { ApprovalMode, ReasoningEffort, SkillEntry } from "../types.js";

export type SlashAction =
  | "compact"
  | "model"
  | "effort"
  | "permissions"
  | "fork"
  | "new"
  | "resume"
  | "init"
  | "skill"
  | "goal"
  | "research";

export interface SlashCommand {
  readonly name: string;
  readonly aliases: string[];
  readonly hint: string | null;
  readonly description: string;
  readonly kind: "action" | "skill";
  readonly action: SlashAction | null;
  readonly skill: SkillEntry | null;
  readonly needsThread: boolean;
  readonly runsBare: boolean;
}

const defineActionCommand = (
  identifier: string,
  actionType: SlashAction,
  summaryText: string,
  extraParams: { aliases?: string[]; hint?: string; inThreadOnly?: boolean; canRunBare?: boolean } = {},
): SlashCommand => ({
  name: identifier,
  aliases: extraParams.aliases ?? [],
  hint: extraParams.hint ?? null,
  description: summaryText,
  kind: "action",
  action: actionType,
  skill: null,
  needsThread: Boolean(extraParams.inThreadOnly),
  runsBare: extraParams.canRunBare !== undefined ? extraParams.canRunBare : true,
});

export const BUILTIN_COMMANDS: readonly SlashCommand[] = Object.freeze([
  defineActionCommand("compact", "compact", "Summarize the conversation to free up context", { inThreadOnly: true }),
  defineActionCommand("model", "model", "Choose the model", { aliases: ["models"], hint: "[model]" }),
  defineActionCommand("effort", "effort", "Set how long the model thinks: off, low, medium, high, xhigh, max or auto", { hint: "[level]" }),
  defineActionCommand("permissions", "permissions", "Choose what Muse can do without asking: ask, unlisted, deny or full", { hint: "[mode]" }),
  defineActionCommand("fork", "fork", "Branch this thread into a new one", { inThreadOnly: true }),
  defineActionCommand("new", "new", "Start a new thread in this project", { aliases: ["clear"] }),
  defineActionCommand("resume", "resume", "Open an earlier thread"),
  defineActionCommand("init", "init", "Explore the workspace and create or improve AGENTS.md"),
  defineActionCommand("goal", "goal", "Set a goal Muse keeps working toward across turns, or pause, resume or clear it", {
    hint: "<objective> | pause | resume | clear",
    canRunBare: false,
  }),
  defineActionCommand("skill", "skill", "Run a skill by name", { hint: "<skill> [request]", canRunBare: false }),
  defineActionCommand("research", "research", "Research a question on the web with parallel Muse workers and write a cited report into this thread", {
    hint: "<question>",
    canRunBare: false,
  }),
]);

export const INIT_PROMPT =
  "Explore this workspace and create or improve its AGENTS.md: what the project is, how to build, run and test it, how the code is organized, and the conventions a coding agent should follow here.";

export const SKILL_PREAMBLE =
  "Muse Code loaded the full instructions for an explicitly invoked skill. Apply these instructions only to the current user turn.";

export function shortName(skill: SkillEntry): string {
  const segments = skill.name.split(":");
  const finalPart = segments[segments.length - 1] || skill.name;
  return finalPart.toLowerCase();
}

export function skillSummary(skill: SkillEntry): string {
  if (typeof skill.shortDescription === "string" && skill.shortDescription.length > 0) {
    return skill.shortDescription;
  }
  const trimmed = skill.description.trim();
  const sentenceTerminator = trimmed.search(/[.!?](\s|$)/);
  return sentenceTerminator >= 0 ? trimmed.slice(0, sentenceTerminator + 1) : trimmed;
}

export function slashCommands(skills: readonly SkillEntry[], options: { inThread: boolean }): SlashCommand[] {
  const registeredNames = new Set<string>();
  const resultList: SlashCommand[] = [];

  for (const b of BUILTIN_COMMANDS) {
    registeredNames.add(b.name);
    for (const alias of b.aliases) {
      registeredNames.add(alias);
    }
    if (options.inThread || !b.needsThread) {
      resultList.push(b);
    }
  }

  for (const item of skills) {
    const slug = shortName(item);
    if (!registeredNames.has(slug)) {
      registeredNames.add(slug);
      resultList.push({
        name: slug,
        aliases: [],
        hint: item.argumentHint ? item.argumentHint : "[request]",
        description: skillSummary(item),
        kind: "skill",
        action: null,
        skill: item,
        needsThread: false,
        runsBare: false,
      });
    }
  }

  return resultList;
}

export interface ParsedSlash {
  readonly name: string;
  readonly args: string;
}

const SLASH_REGEX = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/;

export function parseSlash(text: string): ParsedSlash | null {
  const trimmedInput = text.trim();
  const parsedMatch = SLASH_REGEX.exec(trimmedInput);
  if (!parsedMatch) {
    return null;
  }
  return {
    name: parsedMatch[1].toLowerCase(),
    args: (parsedMatch[2] ?? "").trim(),
  };
}

export type ResolvedSlash =
  | { readonly kind: "action"; readonly command: SlashCommand; readonly args: string }
  | { readonly kind: "skill"; readonly skill: SkillEntry; readonly args: string }
  | { readonly kind: "unknown"; readonly name: string };

export function resolveSlash(
  parsed: ParsedSlash,
  commands: readonly SlashCommand[],
  skills: readonly SkillEntry[],
): ResolvedSlash {
  const matchedCommand = commands.find((cmd) => cmd.name === parsed.name || cmd.aliases.includes(parsed.name));
  if (!matchedCommand) {
    return { kind: "unknown", name: parsed.name };
  }

  if (matchedCommand.kind === "skill" && matchedCommand.skill) {
    return { kind: "skill", skill: matchedCommand.skill, args: parsed.args };
  }

  if (matchedCommand.action === "skill") {
    const argTokens = parsed.args.split(/\s+/);
    const requestedSkillTarget = (argTokens[0] || "").replace(/^\//, "").toLowerCase();
    const trailingArgs = argTokens.slice(1).join(" ").trim();

    if (requestedSkillTarget) {
      const directMatch = skills.find((s) => s.id.toLowerCase() === requestedSkillTarget)
        || skills.find((s) => s.name.toLowerCase() === requestedSkillTarget)
        || skills.find((s) => shortName(s) === requestedSkillTarget);

      if (directMatch) {
        return { kind: "skill", skill: directMatch, args: trailingArgs };
      }
      return { kind: "unknown", name: `skill ${requestedSkillTarget}` };
    }
    return { kind: "unknown", name: "skill" };
  }

  return { kind: "action", command: matchedCommand, args: parsed.args };
}

function calculateMatchScore(command: SlashCommand, normalizedQuery: string): number | null {
  if (!normalizedQuery) {
    return 0;
  }
  const allIdentifiers = [command.name, ...command.aliases];
  if (allIdentifiers.includes(normalizedQuery)) {
    return 0;
  }
  if (command.name.startsWith(normalizedQuery)) {
    return 1;
  }
  if (command.aliases.some((a) => a.startsWith(normalizedQuery))) {
    return 2;
  }
  if (command.name.includes(normalizedQuery)) {
    return 3;
  }
  let charIndex = 0;
  for (let i = 0; i < command.name.length; i += 1) {
    if (command.name[i] === normalizedQuery[charIndex]) {
      charIndex += 1;
      if (charIndex === normalizedQuery.length) {
        return 4;
      }
    }
  }
  if (normalizedQuery.length >= 3 && command.description.toLowerCase().includes(normalizedQuery)) {
    return 5;
  }
  return null;
}

export function matchSlash(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const cleanQuery = query.toLowerCase();
  const actionMatches: { command: SlashCommand; score: number; pos: number }[] = [];
  const skillMatches: { command: SlashCommand; score: number; pos: number }[] = [];

  for (let idx = 0; idx < commands.length; idx += 1) {
    const item = commands[idx];
    const ranking = calculateMatchScore(item, cleanQuery);
    if (ranking !== null) {
      const entry = { command: item, score: ranking, pos: idx };
      if (item.kind === "action") {
        actionMatches.push(entry);
      } else {
        skillMatches.push(entry);
      }
    }
  }

  actionMatches.sort((a, b) => a.score - b.score || a.pos - b.pos);
  skillMatches.sort((a, b) => a.score - b.score || a.pos - b.pos);

  const topActionScore = actionMatches[0]?.score ?? Number.POSITIVE_INFINITY;
  const topSkillScore = skillMatches[0]?.score ?? Number.POSITIVE_INFINITY;

  const primaryList = topSkillScore < topActionScore
    ? [...skillMatches, ...actionMatches]
    : [...actionMatches, ...skillMatches];

  return primaryList.map((entry) => entry.command);
}

export function skillTurn(
  skill: SkillEntry,
  args: string,
  typed: string,
  body: string | null,
): { text: string; displayText: string } {
  const targetRequest = args.trim();
  if (body !== null && body !== undefined) {
    const formattedBlock = [
      SKILL_PREAMBLE,
      `<skill-body id="${skill.id}">\n${body.trim()}\n</skill-body>`,
      targetRequest || "Apply the skill to the conversation so far.",
    ].join("\n\n");
    return { text: formattedBlock, displayText: typed };
  }
  const instructionText = `Use skill ${skill.id}: call read_skill with name "${skill.id}" first, then apply it to: ${targetRequest || "the conversation so far"}`;
  return { text: instructionText, displayText: typed };
}

const EFFORT_LOOKUP: Record<string, ReasoningEffort | null> = Object.fromEntries([
  ["auto", null],
  ["off", "none"],
  ["none", "none"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["extra high", "xhigh"],
  ["extra-high", "xhigh"],
  ["max", "max"],
  ["ultra", "max"],
]);

export function parseEffort(word: string): ReasoningEffort | null | undefined {
  const normalizedKey = word.trim().toLowerCase();
  return Object.hasOwn(EFFORT_LOOKUP, normalizedKey) ? EFFORT_LOOKUP[normalizedKey] : undefined;
}

const MODE_LOOKUP: Record<string, ApprovalMode> = Object.fromEntries([
  ["ask", "onRequest"],
  ["ask first", "onRequest"],
  ["onrequest", "onRequest"],
  ["unlisted", "promptUnmatched"],
  ["ask for unlisted", "promptUnmatched"],
  ["promptunmatched", "promptUnmatched"],
  ["deny", "denyUnmatched"],
  ["deny unlisted", "denyUnmatched"],
  ["denyunmatched", "denyUnmatched"],
  ["full", "allowAll"],
  ["full access", "allowAll"],
  ["allowall", "allowAll"],
]);

export function parseMode(word: string): ApprovalMode | undefined {
  const normalizedKey = word.trim().toLowerCase();
  return Object.hasOwn(MODE_LOOKUP, normalizedKey) ? MODE_LOOKUP[normalizedKey] : undefined;
}

export { findModel, modelMatches } from "./models.js";
