import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { AvatarPackView } from "../../../types.js";

/**
 * The avatars the user drew or brought live on the server and are fetched by id, so that the profile (which every page
 * reads) stays small. This is the cache the faces read from: it hands back what it has, starts a fetch for what it does
 * not, and tells whoever is drawing when the answer lands. Where no source was given (a test, the gallery) nothing is
 * fetched, and a pack that was `put` there is shown all the same.
 */

export interface PackSource {
  get(id: string): Promise<AvatarPackView>;
}

interface Entry {
  rev: number;
  pack: AvatarPackView | null;
  loading: boolean;
}

export class PackStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private tick = 0;

  constructor(private readonly source?: PackSource) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Moves whenever something in the cache changed; what `useSyncExternalStore` watches. */
  version = (): number => this.tick;

  private changed(): void {
    this.tick += 1;
    for (const l of [...this.listeners]) l();
  }

  /** The pack, if it is held at this revision or a newer one. */
  peek(id: string, rev: number): AvatarPackView | undefined {
    const e = this.entries.get(id);
    return e?.pack && e.pack.updatedAt >= rev ? e.pack : undefined;
  }

  /** Whatever is held for the id, however old: better to show last time's picture than none while the new one loads. */
  stale(id: string): AvatarPackView | undefined {
    return this.entries.get(id)?.pack ?? undefined;
  }

  /** Starts loading the pack unless it is held at this revision or already on its way. */
  ensure(id: string, rev: number): void {
    const e = this.entries.get(id);
    if (!this.source || (e?.pack && e.pack.updatedAt >= rev) || (e?.loading && e.rev >= rev)) return;
    this.entries.set(id, { rev, pack: e?.pack ?? null, loading: true });
    void this.source
      .get(id)
      .then((pack) => {
        this.entries.set(id, { rev: pack.updatedAt, pack, loading: false });
      })
      .catch(() => {
        // A pack that is gone (deleted elsewhere) or unreachable: the face falls back to the plain one, and a later ensure tries again.
        const now = this.entries.get(id);
        this.entries.set(id, { rev: now?.rev ?? 0, pack: now?.pack ?? null, loading: false });
      })
      .finally(() => this.changed());
  }

  /** Keeps a pack the caller already has (just saved, or just read in a list) so the face shows it at once. */
  put(pack: AvatarPackView): void {
    this.entries.set(pack.id, { rev: pack.updatedAt, pack, loading: false });
    this.changed();
  }

  drop(id: string): void {
    if (this.entries.delete(id)) this.changed();
  }
}

const NONE = new PackStore();
const PackContext = createContext<PackStore>(NONE);

export function PackProvider(props: { store: PackStore; children: ReactNode }) {
  return <PackContext.Provider value={props.store}>{props.children}</PackContext.Provider>;
}

export const usePackStore = (): PackStore => useContext(PackContext);

/** The pack the look names, or undefined while it loads (or if it is gone). Re-reads when the cache changes. */
export function usePack(id: string | null, rev: number): AvatarPackView | undefined {
  const store = useContext(PackContext);
  useSyncExternalStore(store.subscribe, store.version, store.version);
  useEffect(() => {
    if (id) store.ensure(id, rev);
  }, [store, id, rev]);
  return id ? (store.peek(id, rev) ?? store.stale(id)) : undefined;
}
