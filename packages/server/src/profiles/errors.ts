export type ProfileErrorCode =
  | "profile_exists"
  | "bad_profile_id"
  | "no_such_profile"
  | "index_corrupt"
  | "storage_error";

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;

  constructor(code: ProfileErrorCode, message: string) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
