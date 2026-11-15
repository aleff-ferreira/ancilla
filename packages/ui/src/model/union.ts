/**
 * What a thread keeps when a snapshot of it arrives late, for the things that are written once and never change:
 * a shell run, a file attached to a prompt. Whatever was already known stays, first and as it is, and what only the
 * snapshot knows is added after it, so an older snapshot can never take one away. Returns `local` itself when the
 * snapshot adds nothing.
 */
export function unionById<T extends { id: string }>(local: readonly T[], incoming: readonly T[]): T[] {
  const known = new Set(local.map((entry) => entry.id));
  const added = incoming.filter((entry) => {
    if (known.has(entry.id)) {
      return false;
    }
    known.add(entry.id);
    return true;
  });
  return added.length === 0 ? (local as T[]) : [...local, ...added];
}
