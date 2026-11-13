import { readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Enriches Muse 1.4.15+ `model/list` responses when `muse serve` reports an empty `bundledCatalog`.
 *
 * In MSP v1 (`Muse >= 1.4.15`), `muse serve` never fetches the remote model catalog over the network on its own;
 * the interactive `muse` TUI caches non-secret catalog metadata in `<museHome>/model-catalog/*.json` (`schema_version: 2`,
 * `source: "provider_catalog"`). Reading only those catalog metadata files (or falling back to the subscribed Meta Muse
 * Code catalog when authenticated on Muse 1.4.15+) restores the full `providerCatalog` experience without touching any
 * credential files.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function isMuse1415OrNewer(version: string | null | undefined): boolean {
  if (!version) return false;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return false;
  if (major !== 1) return major > 1;
  if (minor !== 4) return minor > 4;
  return patch >= 15;
}

export interface MuseCatalogLookupOptions {
  modelCatalogDir: string;
  providerId?: string | null;
  profileId?: string | null;
  activeModelId?: string | null;
}

export interface EnrichedMuseCatalog {
  source: "providerCatalog";
  providerId: string;
  profileId: string | null;
  models: Record<string, unknown>[];
}

function mapEffortVariants(raw: unknown): Array<{ tier: string; description: string | null }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ tier: string; description: string | null }> = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim() !== "") {
      out.push({ tier: item.trim(), description: null });
      continue;
    }
    const rec = asRecord(item);
    const tier = str(rec?.["tier"]) ?? str(rec?.["effort"]);
    if (tier) {
      out.push({ tier, description: str(rec?.["description"]) });
    }
  }
  return out.length > 0 ? out : undefined;
}

function mapCatalogRow(
  raw: unknown,
  fallbackProviderId: string,
  fallbackProfileId: string | null,
  activeModelId: string | null,
): Record<string, unknown> | null {
  const row = asRecord(raw);
  if (!row) return null;
  const visibility = str(row["visibility"]);
  if (visibility && visibility !== "visible") return null;

  const modelId = str(row["model_id"]) ?? str(row["modelId"]);
  if (!modelId) return null;

  const displayLabel = str(row["display_label"]) ?? str(row["displayLabel"]) ?? modelId;
  const providerId = str(row["provider_id"]) ?? str(row["providerId"]) ?? fallbackProviderId;
  const profileId = str(row["profile_id"]) ?? str(row["profileId"]) ?? fallbackProfileId;
  const isDefault = row["is_default"] === true || row["isDefault"] === true;
  const isCurrent = row["is_current"] === true || row["isActive"] === true;
  const contextLimit =
    typeof row["context_limit"] === "number"
      ? row["context_limit"]
      : typeof row["contextLimit"] === "number"
        ? row["contextLimit"]
        : null;
  const outputLimit =
    typeof row["output_limit"] === "number"
      ? row["output_limit"]
      : typeof row["outputLimit"] === "number"
        ? row["outputLimit"]
        : null;
  const description = str(row["description"]);
  const cost = asRecord(row["cost"]);
  const reasoningEffortVariants = mapEffortVariants(
    row["reasoning_effort_variants"] ?? row["reasoningEffortVariants"] ?? row["variants"],
  );

  return {
    modelId,
    displayLabel,
    providerId,
    profileId,
    isDefault,
    isActive: activeModelId ? modelId === activeModelId : isCurrent,
    contextLimit,
    outputLimit,
    description,
    cost,
    ...(reasoningEffortVariants ? { reasoningEffortVariants } : {}),
  };
}

function finalizeActiveFlags(models: Record<string, unknown>[], activeModelId: string | null): void {
  if (models.length === 0) return;
  if (activeModelId && models.some((m) => m["modelId"] === activeModelId)) {
    for (const m of models) m["isActive"] = m["modelId"] === activeModelId;
    return;
  }
  const firstActive = models.find((m) => m["isActive"] === true) ?? models.find((m) => m["isDefault"] === true) ?? models[0];
  for (const m of models) {
    m["isActive"] = m === firstActive;
  }
}

export async function readCachedMuseCatalog(options: MuseCatalogLookupOptions): Promise<EnrichedMuseCatalog | null> {
  const targetProvider = options.providerId ?? "meta";
  const targetProfile = options.profileId ?? null;
  const activeModelId = options.activeModelId ?? null;

  let entries;
  try {
    entries = await readdir(options.modelCatalogDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const jsonFiles: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const full = join(options.modelCatalogDir, entry.name);
    try {
      const st = await stat(full);
      jsonFiles.push({ path: full, mtimeMs: st.mtimeMs });
    } catch {
      // Ignore transient file disappearances.
    }
  }
  jsonFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let fallbackMatch: EnrichedMuseCatalog | null = null;
  for (const file of jsonFiles) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = asRecord(JSON.parse(await readFile(file.path, "utf8")));
    } catch {
      continue;
    }
    if (!parsed) continue;
    const fileProvider = str(parsed["provider_id"]) ?? str(parsed["providerId"]) ?? "meta";
    if (fileProvider !== targetProvider) continue;
    const fileProfile = str(parsed["profile_id"]) ?? str(parsed["profileId"]);
    const rawRows = Array.isArray(parsed["rows"])
      ? parsed["rows"]
      : Array.isArray(parsed["models"])
        ? parsed["models"]
        : null;
    if (!rawRows || rawRows.length === 0) continue;

    const models = rawRows
      .map((r) => mapCatalogRow(r, fileProvider, targetProfile ?? fileProfile, activeModelId))
      .filter((r): r is Record<string, unknown> => r !== null);
    if (models.length === 0) continue;
    finalizeActiveFlags(models, activeModelId);

    const candidate: EnrichedMuseCatalog = {
      source: "providerCatalog",
      providerId: fileProvider,
      profileId: targetProfile ?? fileProfile,
      models,
    };
    if (targetProfile !== null && fileProfile === targetProfile) {
      return candidate;
    }
    fallbackMatch ??= candidate;
  }

  return fallbackMatch;
}

const syncCatalogCache = new Map<string, { at: number; models: string[] | null }>();

export function readCachedMuseCatalogSync(modelCatalogDir: string, providerId = "meta"): string[] | null {
  const cacheKey = `${modelCatalogDir}::${providerId}`;
  const now = Date.now();
  const hit = syncCatalogCache.get(cacheKey);
  if (hit && now - hit.at < 30_000) return hit.models;

  let entries;
  try {
    entries = readdirSync(modelCatalogDir, { withFileTypes: true });
  } catch {
    syncCatalogCache.set(cacheKey, { at: now, models: null });
    return null;
  }

  const jsonFiles: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const full = join(modelCatalogDir, entry.name);
    try {
      jsonFiles.push({ path: full, mtimeMs: statSync(full).mtimeMs });
    } catch {
      // Ignore transient disappearances.
    }
  }
  jsonFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of jsonFiles) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = asRecord(JSON.parse(readFileSync(file.path, "utf8")));
    } catch {
      continue;
    }
    if (!parsed) continue;
    const fileProvider = str(parsed["provider_id"]) ?? str(parsed["providerId"]) ?? "meta";
    if (fileProvider !== providerId) continue;
    const rawRows = Array.isArray(parsed["rows"])
      ? parsed["rows"]
      : Array.isArray(parsed["models"])
        ? parsed["models"]
        : null;
    if (!rawRows || rawRows.length === 0) continue;
    const models = rawRows
      .map((r) => mapCatalogRow(r, fileProvider, null, null))
      .filter((r): r is Record<string, unknown> => r !== null)
      .map((r) => String(r["modelId"]))
      .filter(Boolean);
    if (models.length > 0) {
      syncCatalogCache.set(cacheKey, { at: now, models });
      return models;
    }
  }

  syncCatalogCache.set(cacheKey, { at: now, models: null });
  return null;
}

const META_MUSE_CODE_MODELS: ReadonlyArray<{
  modelId: string;
  isDefault: boolean;
  contextLimit: number;
  outputLimit: number;
  tiers: readonly string[];
}> = [
  {
    modelId: "muse-wonder-1.0",
    isDefault: true,
    contextLimit: 1_007_997,
    outputLimit: 128_000,
    tiers: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
  {
    modelId: "muse-wonder-full-1.0",
    isDefault: false,
    contextLimit: 1_007_997,
    outputLimit: 128_000,
    tiers: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
  {
    modelId: "muse-ember-1.0",
    isDefault: false,
    contextLimit: 1_007_997,
    outputLimit: 128_000,
    tiers: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
  {
    modelId: "muse-spark-1.3",
    isDefault: false,
    contextLimit: 1_007_997,
    outputLimit: 128_000,
    tiers: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
  {
    modelId: "muse-spark-1.2",
    isDefault: false,
    contextLimit: 1_007_997,
    outputLimit: 128_000,
    tiers: ["minimal", "low", "medium", "high", "xhigh"],
  },
];

export const META_MUSE_CODE_MODEL_IDS: readonly string[] = META_MUSE_CODE_MODELS.map((m) => m.modelId);

export function buildAuthenticatedMuseFallbackCatalog(options: {
  providerId?: string | null;
  profileId?: string | null;
  activeModelId?: string | null;
}): EnrichedMuseCatalog {
  const providerId = options.providerId ?? "meta";
  const profileId = options.profileId ?? null;
  const activeModelId = options.activeModelId ?? null;
  const models: Record<string, unknown>[] = META_MUSE_CODE_MODELS.map((entry) => ({
    modelId: entry.modelId,
    displayLabel: entry.modelId,
    providerId,
    profileId,
    isDefault: entry.isDefault,
    isActive: activeModelId ? entry.modelId === activeModelId : entry.isDefault,
    contextLimit: entry.contextLimit,
    outputLimit: entry.outputLimit,
    description: null,
    cost: null,
    reasoningEffortVariants: entry.tiers.map((tier) => ({ tier, description: null })),
  }));
  finalizeActiveFlags(models, activeModelId);
  return {
    source: "providerCatalog",
    providerId,
    profileId,
    models,
  };
}
