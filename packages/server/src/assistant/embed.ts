import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "./profile.js";

/**
 * Notes found by what they mean, not only by the words they share. An embedding model (any server that speaks the common
 * `/embeddings` protocol: llama.cpp, Ollama, LM Studio, a hosted one) turns a note and a question into vectors, and the
 * notes nearest the question in meaning are added to the candidates the ordinary retrieval ranks. It is off until the
 * user names a model, and then it is the only thing that sends the text of notes anywhere: to the address they gave.
 * Measured, with a real model, in docs/assistant-evaluation.md.
 */

export interface Embedder {
  /** Names what made the vectors (the model and the address it was asked at): vectors of another id are not comparable. */
  readonly id: string;
  /** The vectors of some texts (notes), in the order given. */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
  /** The vector of a question: models that want a question marked as one are told so here. */
  query(text: string, signal?: AbortSignal): Promise<Float32Array>;
}

export interface EmbeddingSettings {
  baseUrl: string;
  model: string;
  /** Put before a question and not before a note, for models that were trained to tell them apart. */
  queryPrefix: string;
  /** The name of an environment variable that holds a key, when the server wants one. */
  apiKeyEnv: string | null;
  /** A note at least this close in meaning (cosine) is added, nearest first. */
  minCosine: number;
  /**
   * The nearest note is also added when it is at least this close and `standoutLead` ahead of the next nearest: the note
   * that stands out. Null leaves this reason out. It finds the answer to a question that no note is very near to.
   */
  standoutCosine: number | null;
  standoutLead: number;
  /** At most this many notes are added by meaning. */
  most: number;
}

/**
 * Measured with Qwen3-Embedding-0.6B (docs/assistant-evaluation.md): a note at least 0.65 close, or the nearest when at
 * least 0.5 close and 0.15 ahead of the next, two notes at most. Chosen on the development questions as the setting that
 * finds the most for a loss of precision within the adoption rule's two points, and then confirmed on the held-out ones.
 * Another model scores nearness on another scale: these numbers are a start for it, not a finding about it.
 */
export const DEFAULT_EMBEDDING_SETTINGS: Omit<EmbeddingSettings, "baseUrl" | "model"> = { queryPrefix: "", apiKeyEnv: null, minCosine: 0.65, standoutCosine: 0.5, standoutLead: 0.15, most: 2 };

export const EMBEDDING_FILE = "embeddings.json";

/** The server refused a request as wrong (a 4xx): retrying the same text will not help, unlike a server that is down. */
export class EmbeddingRejected extends Error {
  constructor(readonly status: number) {
    super(`the embedding server refused the request (${status})`);
    this.name = "EmbeddingRejected";
  }
}

function normalised(values: number[]): Float32Array {
  let norm = 0;
  for (const x of values) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Float32Array.from(values, (x) => x / norm);
}

/** The cosine of two vectors that were normalised when they were made. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function fromBlob(b: Uint8Array): Float32Array {
  // A copy, so the floats sit at the start of a buffer of their own: a view into a larger one may not be aligned.
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/** A short name for an address that does not carry anything that was in it (a password in the URL, a key in the query). */
function addressTag(baseUrl: string): string {
  return createHash("sha256").update(baseUrl.replace(/\/+$/, "")).digest("hex").slice(0, 8);
}

export interface OpenAiEmbedderOptions {
  settings: EmbeddingSettings;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  /** How long one request may take. */
  timeoutMs?: number;
}

export class OpenAiEmbedder implements Embedder {
  readonly id: string;

  constructor(private readonly options: OpenAiEmbedderOptions) {
    this.id = `${options.settings.model}@${addressTag(options.settings.baseUrl)}`;
  }

  private async request(inputs: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const { settings, apiKey } = this.options;
    const doFetch = this.options.fetchImpl ?? fetch;
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
    const response = await doFetch(`${settings.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: settings.model, input: inputs }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status >= 400 && response.status < 500) throw new EmbeddingRejected(response.status);
    if (!response.ok) throw new Error(`the embedding server answered ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    if (!Array.isArray(body.data) || body.data.length !== inputs.length) throw new Error("the embedding server answered with the wrong number of vectors");
    return [...body.data]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((d) => {
        if (!Array.isArray(d.embedding) || d.embedding.length === 0) throw new Error("the embedding server answered with an empty vector");
        return normalised(d.embedding);
      });
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let from = 0; from < texts.length; from += 32) out.push(...(await this.request(texts.slice(from, from + 32), signal)));
    return out;
  }

  async query(text: string, signal?: AbortSignal): Promise<Float32Array> {
    const [vector] = await this.request([`${this.options.settings.queryPrefix}${text}`], signal);
    return vector as Float32Array;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks settings from the page or the file: an address that is http(s), a model name, cosines between 0.3 and 0.95, a lead of 0.02 to 0.5, one to six notes. */
export function parseEmbeddingSettings(raw: unknown): EmbeddingSettings {
  if (!isObject(raw)) throw new ValidationError("embeddings", "embeddings must be an object");
  const text = (key: string, max: number, required: boolean): string => {
    const v = raw[key];
    if (v === undefined || v === null || v === "") {
      if (required) throw new ValidationError(key, `${key} is required`);
      return "";
    }
    if (typeof v !== "string" || v.length > max) throw new ValidationError(key, `${key} must be text of at most ${max} characters`);
    return v;
  };
  const baseUrl = text("baseUrl", 300, true).trim();
  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) throw new ValidationError("baseUrl", "baseUrl must be an http or https address");
  const model = text("model", 200, true).trim();
  const apiKeyEnv = text("apiKeyEnv", 100, false).trim();
  if (apiKeyEnv !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new ValidationError("apiKeyEnv", "apiKeyEnv must be the name of an environment variable");
  const minCosine = raw["minCosine"] === undefined ? DEFAULT_EMBEDDING_SETTINGS.minCosine : raw["minCosine"];
  if (typeof minCosine !== "number" || !Number.isFinite(minCosine) || minCosine < 0.3 || minCosine > 0.95) throw new ValidationError("minCosine", "minCosine must be a number from 0.3 to 0.95");
  const standoutCosine = raw["standoutCosine"] === undefined ? DEFAULT_EMBEDDING_SETTINGS.standoutCosine : raw["standoutCosine"];
  if (standoutCosine !== null && (typeof standoutCosine !== "number" || !Number.isFinite(standoutCosine) || standoutCosine < 0.3 || standoutCosine > 0.95)) {
    throw new ValidationError("standoutCosine", "standoutCosine must be a number from 0.3 to 0.95, or null to leave this reason out");
  }
  const standoutLead = raw["standoutLead"] === undefined ? DEFAULT_EMBEDDING_SETTINGS.standoutLead : raw["standoutLead"];
  if (typeof standoutLead !== "number" || !Number.isFinite(standoutLead) || standoutLead < 0.02 || standoutLead > 0.5) throw new ValidationError("standoutLead", "standoutLead must be a number from 0.02 to 0.5");
  const most = raw["most"] === undefined ? DEFAULT_EMBEDDING_SETTINGS.most : raw["most"];
  if (typeof most !== "number" || !Number.isInteger(most) || most < 1 || most > 6) throw new ValidationError("most", "most must be a whole number from 1 to 6");
  return { baseUrl, model, queryPrefix: text("queryPrefix", 300, false), apiKeyEnv: apiKeyEnv === "" ? null : apiKeyEnv, minCosine, standoutCosine, standoutLead, most };
}

/** Reads the settings the user saved, or null when meaning search is not set up (or the file cannot be understood). */
export function readEmbeddingSettings(dataDir: string): EmbeddingSettings | null {
  if (dataDir === ":memory:") return null;
  const path = join(dataDir, EMBEDDING_FILE);
  if (!existsSync(path)) return null;
  try {
    return parseEmbeddingSettings(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

/** Saves the settings (they hold no key, only the name of the variable that does), or removes the file when there are none. */
export function writeEmbeddingSettings(dataDir: string, settings: EmbeddingSettings | null): void {
  if (dataDir === ":memory:") return;
  const path = join(dataDir, EMBEDDING_FILE);
  if (settings === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dataDir, { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function embedderFor(settings: EmbeddingSettings, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): OpenAiEmbedder {
  const key = settings.apiKeyEnv ? (env[settings.apiKeyEnv] ?? null) : null;
  return new OpenAiEmbedder({ settings, apiKey: key, ...(fetchImpl ? { fetchImpl } : {}) });
}

/** Whether the variable that should hold the key is set, without saying what it holds. */
export function keyIsSet(settings: EmbeddingSettings, env: NodeJS.ProcessEnv = process.env): boolean {
  return settings.apiKeyEnv !== null && (env[settings.apiKeyEnv] ?? "") !== "";
}

export type EmbeddingTest = { ok: true; dimensions: number; ms: number } | { ok: false; error: string };

/** Asks the server for one vector, to tell the person whether what they typed works. Never throws. */
export async function testEmbedding(settings: EmbeddingSettings, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<EmbeddingTest> {
  const started = Date.now();
  try {
    const embedder = new OpenAiEmbedder({ settings, apiKey: settings.apiKeyEnv ? (env[settings.apiKeyEnv] ?? null) : null, timeoutMs: 8000, ...(fetchImpl ? { fetchImpl } : {}) });
    const [vector] = await embedder.embed(["a short sentence to try the model on"]);
    if (!vector || vector.length === 0) return { ok: false, error: "the server answered, but with no vector" };
    return { ok: true, dimensions: vector.length, ms: Date.now() - started };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // A refused connection reads "fetch failed"; the cause says what actually happened.
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return { ok: false, error: `${reason}${cause}`.slice(0, 300) };
  }
}
