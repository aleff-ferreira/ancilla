import { CHANGELOG, type ChangelogEntry } from "./changelog.generated.js";

export { CHANGELOG, type ChangelogEntry };

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function parseSemver(version: string): [number, number, number] | null {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compares two semantic version strings.
 * Returns negative if a < b, 0 if a === b, or positive if a > b.
 * Falls back to lexicographical comparison if either string is not strict x.y.z semver.
 */
export function compareVersions(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);

  if (!parsedA || !parsedB) {
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  }

  const [majorA, minorA, patchA] = parsedA;
  const [majorB, minorB, patchB] = parsedB;

  if (majorA !== majorB) {
    return majorA - majorB;
  }
  if (minorA !== minorB) {
    return minorA - minorB;
  }
  return patchA - patchB;
}

/**
 * Returns changelog entries newer than `seen` version up to and including `current` version.
 * Returns empty array if seen is null, current is null, or seen >= current (downgrade / unchanged).
 */
export function newEntries(
  seen: string | null,
  current: string | null,
  entries: readonly ChangelogEntry[] = CHANGELOG,
): ChangelogEntry[] {
  if (!seen || !current || compareVersions(seen, current) >= 0) {
    return [];
  }

  return entries.filter((entry) => {
    return compareVersions(entry.version, seen) > 0 && compareVersions(entry.version, current) <= 0;
  });
}
