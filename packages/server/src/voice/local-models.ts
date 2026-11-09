/**
 * Model servers running on this computer, found by asking the addresses they use unless told otherwise. Ollama, LM Studio,
 * llama.cpp and vLLM all speak the OpenAI chat protocol, so a server found here is used as any other: this only saves the
 * person from typing an address and a model name, and from naming a model that is not installed.
 *
 * It looks only at the local machine, only when asked, and gives up on a server that does not answer within a moment.
 * A server in another place (a Windows model server seen from WSL, say) is typed in by hand, as before.
 */

export interface LocalModel {
  id: string;
  sizeBytes: number | null;
}

export interface LocalServer {
  id: string;
  label: string;
  /** What goes in the voice settings' address, ending in /v1. */
  baseUrl: string;
  /** The models it offers to chat with; empty when it runs but has none loaded. */
  models: LocalModel[];
}

interface Candidate {
  id: string;
  label: string;
  port: number;
  /** Ollama lists its models, with their sizes, here, as well as in the common place. */
  tags?: boolean;
}

export const LOCAL_CANDIDATES: readonly Candidate[] = [
  { id: "ollama", label: "Ollama", port: 11434, tags: true },
  { id: "lmstudio", label: "LM Studio", port: 1234 },
  { id: "llamacpp", label: "llama.cpp", port: 8080 },
  { id: "vllm", label: "vLLM", port: 8000 },
];

/** Servers list every model they hold; these are not for chatting with. */
const NOT_FOR_CHAT = /embed|rerank|whisper|tts|bge-|e5-|clip/i;
const MOST_MODELS = 40;

export interface DetectOptions {
  host?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function getJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function list(value: unknown, key: string): unknown[] | null {
  const items = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : null;
  return Array.isArray(items) ? items : null;
}

function modelsOf(items: unknown[], idKey: string, sizeKey: string | null): LocalModel[] {
  return items.flatMap((item) => {
    const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const id = record[idKey];
    if (typeof id !== "string" || id === "") return [];
    const size = sizeKey ? record[sizeKey] : null;
    return [{ id, sizeBytes: typeof size === "number" ? size : null }];
  });
}

async function probe(candidate: Candidate, host: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<LocalServer | null> {
  const origin = `http://${host}:${candidate.port}`;
  let models: LocalModel[] | null = null;
  if (candidate.tags) {
    const tags = list(await getJson(fetchImpl, `${origin}/api/tags`, timeoutMs), "models");
    if (tags) models = modelsOf(tags, "name", "size");
  }
  if (models === null) {
    // Only an answer shaped like a model list counts: another program on the port says something else.
    const listed = list(await getJson(fetchImpl, `${origin}/v1/models`, timeoutMs), "data");
    if (listed === null) return null;
    models = modelsOf(listed, "id", null);
  }
  return { id: candidate.id, label: candidate.label, baseUrl: `${origin}/v1`, models: models.filter((m) => !NOT_FOR_CHAT.test(m.id)).slice(0, MOST_MODELS) };
}

export async function detectLocalServers(options: DetectOptions = {}): Promise<LocalServer[]> {
  const host = options.host ?? "127.0.0.1";
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 700;
  const found = await Promise.all(LOCAL_CANDIDATES.map((candidate) => probe(candidate, host, fetchImpl, timeoutMs)));
  return found.filter((server): server is LocalServer => server !== null);
}
