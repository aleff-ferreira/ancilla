import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProfileError } from "./errors.js";
import type {
  DoctorFinding,
  ProfileCommand,
  ProfileCreateOptions,
  ProfileIdentity,
  ProfileManager,
  ProfileManagerOptions,
  ProfileRecord,
  ProfileRoots,
} from "./types.js";

const PROFILE_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface StoredProfile {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface StoredIndex {
  version: number;
  profiles: StoredProfile[];
}

function validateProfileSlug(id: string): void {
  if (typeof id !== "string" || !PROFILE_ID_REGEX.test(id)) {
    throw new ProfileError(
      "bad_profile_id",
      `Invalid profile ID "${id}". Profile ID must be lowercase alphanumeric with hyphens or underscores (1-64 characters).`
    );
  }
}

function cleanString(val: unknown, maxLen = 320): string | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}

function resolveProfilesDir(options: ProfileManagerOptions): string {
  const env = options.env ?? process.env;

  if (options.profilesDir && options.profilesDir.trim() !== "") {
    return path.resolve(options.profilesDir.trim());
  }

  const profilesDirEnv = env["ANCILLA_PROFILES_DIR"];
  if (profilesDirEnv && profilesDirEnv.trim() !== "") {
    return path.resolve(profilesDirEnv.trim());
  }

  if (options.home && options.home.trim() !== "") {
    const resolvedHome = path.resolve(options.home.trim());
    if (path.basename(resolvedHome) === "profiles") {
      return resolvedHome;
    }
    if (path.basename(resolvedHome) === ".ancilla") {
      return path.join(resolvedHome, "profiles");
    }
    return path.join(resolvedHome, ".ancilla", "profiles");
  }

  const profilesHomeEnv = env["ANCILLA_PROFILES_HOME"];
  if (profilesHomeEnv && profilesHomeEnv.trim() !== "") {
    return path.join(path.resolve(profilesHomeEnv.trim()), "profiles");
  }

  const ancillaHomeEnv = env["ANCILLA_HOME"];
  if (ancillaHomeEnv && ancillaHomeEnv.trim() !== "") {
    return path.join(path.resolve(ancillaHomeEnv.trim()), "profiles");
  }

  return path.join(os.homedir(), ".ancilla", "profiles");
}

function computeRoots(profilesDir: string, id: string): ProfileRoots {
  return {
    config: path.join(profilesDir, id, "config"),
    data: path.join(profilesDir, id, "data"),
  };
}

/**
 * Creates a profile manager for isolated CLI configuration and session state per user account.
 *
 * All methods are returned as own-properties bound to the instance, ensuring
 * that object spreading in test fixtures (`{ ...manager, identityOf: mockFn }`)
 * retains all un-mocked methods.
 */
export function createProfilesManager(options: ProfileManagerOptions = {}): ProfileManager {
  const profilesDir = resolveProfilesDir(options);
  const platform = options.platform ?? process.platform;
  const musePath = options.musePath ?? "muse";
  const env = options.env ?? process.env;

  const indexPath = path.join(profilesDir, "profiles.json");

  // Serial mutex queue ensuring atomic index file modifications
  let mutationQueue = Promise.resolve();

  function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = mutationQueue.then(operation, operation);
    mutationQueue = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  async function loadIndex(): Promise<StoredIndex> {
    try {
      const raw = await readFile(indexPath, "utf-8");
      if (!raw || raw.trim() === "") {
        return { version: 1, profiles: [] };
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.profiles)) {
        throw new ProfileError("index_corrupt", "Profiles index file schema is invalid.");
      }
      return parsed as StoredIndex;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, profiles: [] };
      }
      if (err instanceof ProfileError) {
        throw err;
      }
      throw new ProfileError("index_corrupt", `Profiles index file is corrupted: ${(err as Error).message}`);
    }
  }

  async function saveIndex(index: StoredIndex): Promise<void> {
    await mkdir(profilesDir, { recursive: true, mode: 0o700 });
    const tempFile = path.join(
      profilesDir,
      `.profiles.json.tmp.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}`
    );
    try {
      await writeFile(tempFile, JSON.stringify(index, null, 2), { mode: 0o600 });
      await rename(tempFile, indexPath);
    } catch (err) {
      await rm(tempFile, { force: true }).catch(() => {});
      throw new ProfileError("storage_error", `Failed to save profiles index: ${(err as Error).message}`);
    }
  }

  async function copyIfExists(src: string, dest: string): Promise<void> {
    try {
      await copyFile(src, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }

  // --- ProfileManager API methods ---

  const listProfiles = async (): Promise<ProfileRecord[]> => {
    const index = await loadIndex();
    const sorted = [...index.profiles].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return sorted.map((entry) => ({
      ...entry,
      roots: computeRoots(profilesDir, entry.id),
    }));
  };

  const getProfile = async (id: string): Promise<ProfileRecord> => {
    if (!id || typeof id !== "string") {
      throw new ProfileError("no_such_profile", `Profile "${id}" not found.`);
    }
    const index = await loadIndex();
    const entry = index.profiles.find((p) => p.id === id);
    if (!entry) {
      throw new ProfileError("no_such_profile", `Profile "${id}" not found.`);
    }
    return {
      ...entry,
      roots: computeRoots(profilesDir, entry.id),
    };
  };

  const createProfile = async (id: string, createOptions?: ProfileCreateOptions): Promise<ProfileRecord> => {
    validateProfileSlug(id);

    return withMutationLock(async () => {
      const index = await loadIndex();
      if (index.profiles.some((p) => p.id === id)) {
        throw new ProfileError("profile_exists", `Profile "${id}" already exists.`);
      }

      const roots = computeRoots(profilesDir, id);
      await mkdir(roots.config, { recursive: true, mode: 0o700 });
      await mkdir(roots.data, { recursive: true, mode: 0o700 });

      if (createOptions?.seedFromDefault) {
        const defaultMuseConfig = path.join(
          env["XDG_CONFIG_HOME"] || path.join(options.home || os.homedir(), ".config"),
          "muse"
        );
        const targetMuseConfig = path.join(roots.config, "muse");
        await mkdir(targetMuseConfig, { recursive: true, mode: 0o700 });
        await copyIfExists(path.join(defaultMuseConfig, "settings.json"), path.join(targetMuseConfig, "settings.json"));
        await copyIfExists(path.join(defaultMuseConfig, "trust.json"), path.join(targetMuseConfig, "trust.json"));
        // auth.json is strictly never copied
      }

      const name = createOptions?.name?.trim() || id;
      const record: StoredProfile = {
        id,
        name,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };

      index.profiles.push(record);
      await saveIndex(index);

      return {
        ...record,
        roots,
      };
    });
  };

  const renameProfile = async (id: string, name: string): Promise<ProfileRecord> => {
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (!trimmedName) {
      throw new ProfileError("bad_profile_id", "Profile name cannot be empty.");
    }

    return withMutationLock(async () => {
      const index = await loadIndex();
      const entry = index.profiles.find((p) => p.id === id);
      if (!entry) {
        throw new ProfileError("no_such_profile", `Profile "${id}" not found.`);
      }

      entry.name = trimmedName;
      await saveIndex(index);

      return {
        ...entry,
        roots: computeRoots(profilesDir, entry.id),
      };
    });
  };

  const removeProfile = async (id: string): Promise<void> => {
    await withMutationLock(async () => {
      const index = await loadIndex();
      const existingIdx = index.profiles.findIndex((p) => p.id === id);
      if (existingIdx === -1) {
        throw new ProfileError("no_such_profile", `Profile "${id}" not found.`);
      }

      index.profiles.splice(existingIdx, 1);
      await saveIndex(index);

      const profileDir = path.join(profilesDir, id);
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    });
  };

  const touch = async (id: string): Promise<void> => {
    await withMutationLock(async () => {
      const index = await loadIndex();
      const entry = index.profiles.find((p) => p.id === id);
      if (entry) {
        entry.lastUsedAt = new Date().toISOString();
        await saveIndex(index);
      }
    });
  };

  const envFor = (profile: ProfileRecord): Record<string, string> => {
    const res: Record<string, string> = {
      XDG_CONFIG_HOME: profile.roots.config,
      XDG_DATA_HOME: profile.roots.data,
    };
    if (platform === "darwin") {
      res.TBH_CREDENTIAL_BACKEND = "file";
    }
    return res;
  };

  const loginCommand = (profile: ProfileRecord): ProfileCommand => {
    return {
      command: musePath,
      args: ["login"],
      env: envFor(profile),
    };
  };

  const identityOf = async (
    profile: Pick<ProfileRecord, "roots"> & Partial<ProfileRecord>
  ): Promise<ProfileIdentity> => {
    const authFile = path.join(profile.roots.config, "muse", "auth.json");
    try {
      const raw = await readFile(authFile, "utf-8");
      if (!raw || raw.trim() === "") {
        return { hasLogin: false, email: null };
      }
      const parsed = JSON.parse(raw);
      let meta: Record<string, unknown> | null = null;
      if (parsed && typeof parsed === "object") {
        if (parsed.providers && typeof parsed.providers === "object") {
          meta =
            parsed.providers.meta && typeof parsed.providers.meta === "object"
              ? (parsed.providers.meta as Record<string, unknown>)
              : null;
        } else if (parsed.meta && typeof parsed.meta === "object") {
          meta = parsed.meta as Record<string, unknown>;
        } else {
          meta = parsed as Record<string, unknown>;
        }
      }

      if (meta && typeof meta === "object") {
        const mechanism = typeof meta["mechanism"] === "string" ? meta["mechanism"].trim() : "";
        if (mechanism !== "") {
          const email = cleanString(meta["user_email"], 320);
          const name =
            cleanString(meta["user_full_name"], 320) ??
            cleanString(meta["user_name"], 320) ??
            email ??
            null;

          return {
            hasLogin: true,
            email,
            name,
          };
        }
      }
    } catch {
      // Missing or corrupt auth file returns safe false
    }

    return { hasLogin: false, email: null };
  };

  const doctor = async (): Promise<DoctorFinding[]> => {
    const findings: DoctorFinding[] = [];

    const metaApiKey = env["META_API_KEY"];
    if (typeof metaApiKey === "string" && metaApiKey.trim() !== "") {
      findings.push({
        code: "meta_api_key_inherited",
        message: "META_API_KEY is present in the environment.",
        severity: "warning",
      });
    }

    try {
      await mkdir(profilesDir, { recursive: true, mode: 0o700 });
      await access(profilesDir, fs.constants.W_OK);
    } catch (err) {
      findings.push({
        code: "profiles_dir_unwritable",
        message: `Profiles directory "${profilesDir}" is not writable: ${(err as Error).message}`,
        severity: "error",
      });
    }

    return findings;
  };

  // Return object literal where all methods are own-properties
  return {
    profilesDir,
    listProfiles,
    getProfile,
    createProfile,
    renameProfile,
    removeProfile,
    touch,
    envFor,
    loginCommand,
    identityOf,
    doctor,
  };
}

export const createProfileManager = createProfilesManager;
