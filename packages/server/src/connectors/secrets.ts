import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Where the tokens are kept. A token goes into the connection's own Authorization header and nowhere else: not Ancilla's
 * environment, not a prompt, not a log, not a Muse thread, and not any answer of an API call (a connector's view says only
 * that it is connected). Today the one place is a file on this computer that only this user can read (mode 0600), which is
 * also where the voice keeps its keys, and the screen says so. The OS keychain is a better place and the seam for it is
 * here, but the desktop build is one bundled file and a keychain module is a native one, so it waits for that packaging.
 */

export interface SecretStore {
  /** Where the secrets live, in words for the person ("a file on this computer that only your user can read"). */
  readonly where: string;
  get(id: string): string | null;
  set(id: string, value: string): void;
  delete(id: string): boolean;
  has(id: string): boolean;
}

interface Stored {
  version: 1;
  secrets: Record<string, { value: string; at: number }>;
}

export class FileSecretStore implements SecretStore {
  readonly where: string;
  private data: Stored | null = null;

  /** A null path keeps the secrets in memory only (tests, and a data folder that is not on disk). */
  constructor(
    private readonly path: string | null,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = () => undefined,
  ) {
    this.where = path ? "a file on this computer that only your user account can read" : "memory, until Ancilla closes";
  }

  private load(): Stored {
    if (this.data) return this.data;
    let loaded: Stored = { version: 1, secrets: {} };
    if (this.path && existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Stored>;
        if (raw && raw.version === 1 && typeof raw.secrets === "object" && raw.secrets !== null) loaded = { version: 1, secrets: { ...raw.secrets } };
      } catch {
        this.log("connectors: the secrets file could not be read, so no connector has a token");
      }
    }
    this.data = loaded;
    return loaded;
  }

  private save(): void {
    if (!this.path || !this.data) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // a file system with no modes (Windows) keeps the rights of the folder it is in
    }
  }

  get(id: string): string | null {
    return Object.hasOwn(this.load().secrets, id) ? (this.load().secrets[id]?.value ?? null) : null;
  }

  has(id: string): boolean {
    return this.get(id) !== null;
  }

  set(id: string, value: string): void {
    this.load().secrets[id] = { value, at: this.now() };
    this.save();
  }

  delete(id: string): boolean {
    const data = this.load();
    if (!Object.hasOwn(data.secrets, id)) return false;
    delete data.secrets[id];
    this.save();
    return true;
  }
}
