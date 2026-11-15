export interface ProfileRoots {
  /** Root directory for XDG_CONFIG_HOME: <profilesDir>/<id>/config */
  readonly config: string;
  /** Root directory for XDG_DATA_HOME: <profilesDir>/<id>/data */
  readonly data: string;
}

export interface ProfileRecord {
  /** Valid slug identifier (e.g. "work", "client-a") */
  readonly id: string;
  /** Human-readable display name */
  readonly name: string;
  /** ISO 8601 creation timestamp */
  readonly createdAt: string;
  /** ISO 8601 last usage timestamp, or null if unused */
  readonly lastUsedAt: string | null;
  /** Resolved filesystem roots */
  readonly roots: ProfileRoots;
}

export type Profile = ProfileRecord;

export interface ProfileCreateOptions {
  name?: string;
  seedFromDefault?: boolean;
}

export interface ProfileIdentity {
  hasLogin: boolean;
  email: string | null;
  name?: string | null;
}

export interface ProfileCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface DoctorFinding {
  code: "meta_api_key_inherited" | "profiles_dir_unwritable" | "index_corrupt" | string;
  message: string;
  severity?: "info" | "warning" | "error";
}

export interface LoginParseResult {
  url: string | null;
  code: string | null;
}

export interface ProfileManagerOptions {
  /** Base directory override or user home directory */
  home?: string;
  /** Direct profiles storage directory override (takes precedence over home) */
  profilesDir?: string;
  /** Target OS platform ("win32" | "darwin" | "linux"); defaults to process.platform */
  platform?: "win32" | "darwin" | "linux" | string;
  /** Path or binary name for Muse CLI; defaults to "muse" */
  musePath?: string;
  /** Environment variables dictionary; defaults to process.env */
  env?: Record<string, string | undefined>;
}

export interface ProfileManager {
  readonly profilesDir: string;
  listProfiles(): Promise<ProfileRecord[]>;
  getProfile(id: string): Promise<ProfileRecord>;
  createProfile(id: string, options?: ProfileCreateOptions): Promise<ProfileRecord>;
  renameProfile(id: string, name: string): Promise<ProfileRecord>;
  removeProfile(id: string): Promise<void>;
  touch(id: string): Promise<void>;
  envFor(profile: ProfileRecord): Record<string, string>;
  loginCommand(profile: ProfileRecord): ProfileCommand;
  identityOf(profile: Pick<ProfileRecord, "roots"> & Partial<ProfileRecord>): Promise<ProfileIdentity>;
  doctor(): Promise<DoctorFinding[]>;
}
