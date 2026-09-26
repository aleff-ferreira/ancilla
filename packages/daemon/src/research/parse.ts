/**
 * Lenient extraction of the fenced JSON contracts the prompts ask for.
 *
 * Muse gives the engine no tool schemas and no JSON mode, so every structured decision arrives as model text with
 * a fenced JSON block somewhere in it (upstream used `json_mode` and tool calls, see `research_agent_scope.py`
 * L78-131 and `multi_agent_supervisor.py` L451-529). The rules here: the last fenced block wins, prose around it
 * is ignored, a missing language tag is fine, a bare top-level object without fences is accepted, and malformed
 * JSON is rejected so the caller can retry with a nudge instead of guessing.
 */

import type { SavedSource, SupervisorVerdict } from "./types.js";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface ParsedBrief {
  researchBrief: string;
  inputLanguage: string | null;
  targetLanguage: string | null;
}

export interface ParsedDelegation {
  topic: string;
  discovery: boolean;
  maxReads: number | null;
}

export interface ParsedDecision {
  reflection: string;
  verdict: SupervisorVerdict;
  delegations: ParsedDelegation[];
}

export interface ParsedFindings {
  findings: string;
  saved: SavedSource[];
}

const FENCE_RE = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParse(text: string): ParseResult<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `malformed JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "JSON is not an object" };
  return { ok: true, value: parsed };
}

/** One JSON object from model text: the last fenced block, or the bare object the whole text is. */
export function extractJsonObject(text: string): ParseResult<Record<string, unknown>> {
  if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "empty output" };
  const blocks = [...text.matchAll(FENCE_RE)];
  if (blocks.length > 0) {
    const last = blocks[blocks.length - 1] as RegExpMatchArray;
    return tryParse((last[2] ?? "").trim());
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const whole = tryParse(trimmed);
    if (whole.ok) return whole;
  }
  const first = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (first >= 0 && end > first) return tryParse(trimmed.slice(first, end + 1));
  return { ok: false, reason: "no JSON object found" };
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function parseBrief(text: string): ParseResult<ParsedBrief> {
  const object = extractJsonObject(text);
  if (!object.ok) return object;
  const researchBrief = optionalString(object.value.research_brief);
  if (!researchBrief) return { ok: false, reason: "research_brief missing or empty" };
  const inputLanguage = optionalString(object.value.input_language);
  // Upstream derives target_language from input_language so the two can never diverge.
  const targetLanguage = inputLanguage ?? optionalString(object.value.target_language);
  return { ok: true, value: { researchBrief, inputLanguage, targetLanguage } };
}

function parseVerdict(value: unknown): SupervisorVerdict | null {
  if (typeof value !== "string") return null;
  const upper = value.toUpperCase();
  if (upper.includes("RESEARCH_COMPLETE")) return "RESEARCH_COMPLETE";
  if (upper.includes("CONTINUE_RESEARCH")) return "CONTINUE_RESEARCH";
  return null;
}

function parseMaxReads(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return null;
  return Math.round(value);
}

/**
 * The supervisor's decision. Delegations are trimmed, deduplicated by topic (case-insensitive) and capped at
 * `maxDelegations`: upstream lets the model ask for more sub-agents than run at once, and the engine queues the
 * rest behind its parallel cap.
 */
export function parseDecision(text: string, maxDelegations: number): ParseResult<ParsedDecision> {
  const object = extractJsonObject(text);
  if (!object.ok) return object;
  const verdict = parseVerdict(object.value.verdict);
  if (!verdict) return { ok: false, reason: "verdict must be CONTINUE_RESEARCH or RESEARCH_COMPLETE" };
  const reflection = typeof object.value.reflection === "string" ? object.value.reflection.trim() : "";
  const raw = object.value.delegations;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    return { ok: false, reason: "delegations must be an array" };
  }
  const delegations: ParsedDelegation[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isRecord(item)) continue;
    const topic = optionalString(item.topic);
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    delegations.push({ topic, discovery: item.discovery === true, maxReads: parseMaxReads(item.max_reads) });
    if (delegations.length >= Math.max(1, maxDelegations)) break;
  }
  return { ok: true, value: { reflection, verdict, delegations } };
}

/** The worker's closing findings block. A missing `saved` list is an empty one; a missing `findings` is empty text. */
export function parseFindings(text: string): ParseResult<ParsedFindings> {
  const object = extractJsonObject(text);
  if (!object.ok) return object;
  const findings = typeof object.value.findings === "string" ? object.value.findings.trim() : "";
  const raw = object.value.saved;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) return { ok: false, reason: "saved must be an array" };
  const saved: SavedSource[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isRecord(item)) continue;
    const url = optionalString(item.url);
    if (!url) continue;
    saved.push({
      url,
      title: optionalString(item.title),
      reason: typeof item.reason === "string" ? item.reason.trim() : "",
      excerpt: optionalString(item.excerpt),
    });
  }
  if (!findings && saved.length === 0) return { ok: false, reason: "findings block has neither findings nor saved sources" };
  return { ok: true, value: { findings, saved } };
}
