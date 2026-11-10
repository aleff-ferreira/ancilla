/**
 * What a connector is before any account is involved: where its server is, how a person makes the token it takes, and the one
 * list that matters, the tools the assistant is given. That list is OURS. A server says what its tools are and what they do, and
 * a server can say anything (what it returns can be what a stranger wrote in an issue or an email), so only the tools on our
 * list are offered, in our words, and a tool that is not on it cannot be called, even by name. Each tool has a class, and a
 * tool that changes something is offered only where the person switched its class on, and runs only with an approval (gate.ts).
 */

/**
 * What a tool does to the account. `read` looks and changes nothing. The others change something, and the person is asked
 * about each call: `reversible` can be undone in a click (a branch, a draft, a label), `communicates` is seen by other people
 * (a comment, an issue, a pull request), `destructive` can lose work or cannot be taken back (a merge, a close, a delete).
 */
export type WriteClass = "reversible" | "communicates" | "destructive";
export type ToolClass = "read" | WriteClass;
export const WRITE_CLASSES: readonly WriteClass[] = ["reversible", "communicates", "destructive"];
const RANK: Record<ToolClass, number> = { read: 0, reversible: 1, communicates: 2, destructive: 3 };

/** What a call is about, for the card and for noticing what the person did not name. */
export interface Target {
  /** In words, for the card: "aleff-ferreira/ancilla #12". */
  label: string;
  /** The item as one key, so that what was read of it and what is written to it can be told from other items; null for a whole repository. */
  item: string | null;
  /** The parts of the target, each with the spellings under which the person's own words would have named it. */
  parts: Array<{ shown: string; accepts: string[] }>;
}

export interface ToolEntry {
  class: ToolClass;
  /** What the model is told the tool does: ours, and short, because every offered tool costs tokens on every step. */
  text: string;
  /** Reads only: what comes back is something nobody else could have written (who the token is, the person's own projects). Absent means a stranger may have written it, and reading it taints the task. */
  own?: true;
  target?: (args: Record<string, unknown>) => Target | null;
  /** A tool that is more than its class says for some arguments (an update that closes an issue is a close): the class such a call is held to. Never lower than `class`. */
  escalate?: (args: Record<string, unknown>) => ToolClass | null;
}

/** The class a call is held to: the tool's own, or higher when its arguments make it more. */
export function classOf(entry: ToolEntry, args: Record<string, unknown>): ToolClass {
  const up = entry.escalate?.(args) ?? null;
  return up !== null && RANK[up] > RANK[entry.class] ? up : entry.class;
}

/** The person's setting for each class of change. `always` is only ever for `reversible`, and only after a first yes. */
export type WriteSetting = "off" | "ask" | "always";
export type WritePolicy = Record<WriteClass, WriteSetting>;
/** A connector starts as it was promised: reads only. The person switches each class on. */
export const DEFAULT_POLICY: WritePolicy = { reversible: "off", communicates: "off", destructive: "off" };

/** What is stored, made safe: an unknown value is off, and nothing but a reversible change can be allowed without asking. */
export function cleanPolicy(raw: unknown): WritePolicy {
  const out: WritePolicy = { ...DEFAULT_POLICY };
  if (typeof raw !== "object" || raw === null) return out;
  for (const cls of WRITE_CLASSES) {
    const value = (raw as Record<string, unknown>)[cls];
    if (value === "ask" || value === "off") out[cls] = value;
    else if (value === "always") out[cls] = cls === "reversible" ? "always" : "ask";
  }
  return out;
}

export interface ConnectorManifest {
  id: string;
  name: string;
  summary: string;
  transport: { kind: "http"; url: string } | { kind: "stdio"; command: string; args: string[]; tokenEnv: string };
  /** How the person makes the token: the page, and what to tick on it so that it can do as little as possible. */
  token: { label: string; helpUrl: string; recipe: string };
  /** Removing a connection here does not revoke the token at the provider: this says where it is done. */
  revoke: { url: string; text: string };
  /** Said before connecting when the provider cannot limit the token, so that the list below is the only wall. */
  caution?: string;
  /** The tools the assistant may be given, by the server's own name for each. */
  tools: Record<string, ToolEntry>;
  /** A harmless read, on the list, that Test runs to prove the token works. */
  probe: { tool: string; args: Record<string, unknown> };
}

/** A tool as the server lists it. Only its name and the shape of its arguments are ever used; its words never are. */
export interface ServerTool {
  name: string;
  inputSchema: unknown;
}

export interface OfferedTool {
  name: string;
  class: ToolClass;
  text: string;
  parameters: Record<string, unknown>;
}

export interface Offering {
  offered: OfferedTool[];
  /** Tools the server has that are not on the list: not offered, whatever they are called or say they do. */
  hidden: string[];
  /** Tools on the list that the server did not list: renamed or removed, and so not offered either. */
  missing: string[];
  /** Tools on the list that the server has, which the person's settings switch off. */
  off: string[];
}

const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);
const MAX_PROPS = 24;
const MAX_DEPTH = 4;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function primitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * The shape of a tool's arguments, and nothing a server wrote to persuade: types, names, what is required, the values a field
 * may take. Every description, title and example is dropped, because they are text the model would read as instructions.
 */
export function sanitizeSchema(schema: unknown, depth = 0): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return {};
  const node = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const type = node["type"];
  if (typeof type === "string" && SCHEMA_TYPES.has(type)) out["type"] = type;
  else if (Array.isArray(type) && type.every((t) => typeof t === "string" && SCHEMA_TYPES.has(t))) out["type"] = type.slice(0, 4);
  if (depth >= MAX_DEPTH) return out["type"] === undefined ? { type: "string" } : out;
  const props = node["properties"];
  if (typeof props === "object" && props !== null && !Array.isArray(props)) {
    const kept: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(props as Record<string, unknown>).slice(0, MAX_PROPS)) {
      if (NAME.test(key)) kept[key] = sanitizeSchema(child, depth + 1);
    }
    out["properties"] = kept;
    const required = node["required"];
    if (Array.isArray(required)) out["required"] = required.filter((r): r is string => typeof r === "string" && Object.hasOwn(kept, r));
  }
  if (node["items"] !== undefined) out["items"] = sanitizeSchema(node["items"], depth + 1);
  const values = node["enum"];
  if (Array.isArray(values) && values.length <= 30 && values.every(primitive)) out["enum"] = values;
  if (primitive(node["default"])) out["default"] = node["default"];
  for (const key of ["minimum", "maximum"] as const) if (typeof node[key] === "number") out[key] = node[key];
  return out;
}

/** The parameters object a model is handed: always an object with properties, whatever the server sent. */
export function parametersOf(schema: unknown): Record<string, unknown> {
  const clean = sanitizeSchema(schema);
  const properties = typeof clean["properties"] === "object" && clean["properties"] !== null ? clean["properties"] : {};
  return { type: "object", properties, ...(Array.isArray(clean["required"]) && clean["required"].length > 0 ? { required: clean["required"] } : {}) };
}

/** What the server's tools come to once our list, and the person's settings, have been laid over them. */
export function offerTools(manifest: ConnectorManifest, serverTools: readonly ServerTool[], policy: WritePolicy = DEFAULT_POLICY): Offering {
  const listed = new Map(serverTools.map((tool) => [tool.name, tool]));
  const offered: OfferedTool[] = [];
  const missing: string[] = [];
  const off: string[] = [];
  for (const [name, entry] of Object.entries(manifest.tools)) {
    const found = listed.get(name);
    if (!found) {
      missing.push(name);
      continue;
    }
    if (entry.class !== "read" && policy[entry.class] === "off") {
      off.push(name);
      continue;
    }
    offered.push({ name, class: entry.class, text: entry.text, parameters: parametersOf(found.inputSchema) });
  }
  const hidden = serverTools.map((tool) => tool.name).filter((name) => !Object.hasOwn(manifest.tools, name));
  return { offered, hidden, missing, off };
}

// ---------------------------------------------------------------------------------------------------------------- what comes back

/** The shapes credentials have. What a tool returns passes through these, so a key that was in an issue or a note is not read back. */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsbp_[A-Za-z0-9]{30,}\b/g,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}\b/g,
  /\bxkeysib-[A-Za-z0-9-]{20,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
];

export const HIDDEN = "[hidden]";

/** `text` with every credential shape, and every one of `known` (the connector's own token), replaced by a marker. */
export function redact(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const secret of known) if (secret.length >= 8) out = out.split(secret).join(HIDDEN);
  for (const shape of SECRET_SHAPES) out = out.replace(shape, HIDDEN);
  return out;
}

/** Longest a tool's answer is kept for the model: a model that is handed a whole listing runs out of room long before the task ends. */
export const RESULT_MAX = 4000;

export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 20)}\n(cut: ${text.length - (max - 20)} more characters)`;
}

interface ContentItem {
  type?: unknown;
  text?: unknown;
  resource?: { text?: unknown; uri?: unknown };
}

/** What a tool returned, as plain text: text is kept, anything else is named and left out (nothing is rendered or followed). */
export function flattenResult(result: { content?: unknown; isError?: unknown }): { text: string; isError: boolean } {
  const parts: string[] = [];
  const content = Array.isArray(result.content) ? (result.content as ContentItem[]) : [];
  for (const item of content) {
    if (item && item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item && item.type === "resource" && item.resource && typeof item.resource.text === "string") parts.push(item.resource.text);
    else if (item && typeof item.type === "string") parts.push(`[${item.type === "image" || item.type === "audio" ? item.type : "content"} left out]`);
  }
  const isError = result.isError === true;
  return { text: parts.join("\n"), isError };
}
