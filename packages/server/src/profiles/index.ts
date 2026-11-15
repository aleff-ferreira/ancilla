export { createProfileManager, createProfilesManager } from "./manager.js";
export { ProfileError, type ProfileErrorCode } from "./errors.js";
export { parseLoginOutput } from "./parser.js";
export type {
  DoctorFinding,
  LoginParseResult,
  Profile,
  ProfileCommand,
  ProfileCreateOptions,
  ProfileIdentity,
  ProfileManager,
  ProfileManagerOptions,
  ProfileRecord,
  ProfileRoots,
} from "./types.js";
