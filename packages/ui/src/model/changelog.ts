import { CHANGELOG, type ChangelogEntry } from "./changelog.generated.js";

export { CHANGELOG, type ChangelogEntry };

/** A semantic version as three numbers, or null when it is not one. */
function parts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative when `a` is older than `b`, zero when they match, positive when it is newer. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return 0;
}

/**
 * The entries to show after an update: everything newer than the version last seen, up to and
 * including the one now running. Someone who skipped two releases reads both, in one place.
 *
 * Nothing is returned when the version last seen is unknown, which is a first run rather than an
 * update, or when it is not older than the running version, which covers a downgrade and the
 * ordinary case of nothing having changed.
 */
export function newEntries(
  seen: string | null,
  current: string | null,
  entries: readonly ChangelogEntry[] = CHANGELOG,
): ChangelogEntry[] {
  if (!seen || !current || compareVersions(seen, current) >= 0) {
    return [];
  }
  return entries.filter(
    (entry) => compareVersions(entry.version, seen) > 0 && compareVersions(entry.version, current) <= 0,
  );
}
