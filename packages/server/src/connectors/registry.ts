import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "../assistant/store.js";
import { AuditLog, maskArgs } from "./audit.js";
import { CATALOG } from "./catalog.js";
import { ConnectorError, type LiveConnection, type Opener } from "./connection.js";
import { cut, offerTools, redact, RESULT_MAX, type ConnectorManifest, type OfferedTool } from "./manifest.js";
import type { SecretStore } from "./secrets.js";

/**
 * Which accounts are connected, how each may be used, and the only door to a connection: `open`. A connector is connected when
 * its token was accepted by its server (Connect proves it with one harmless read, so a wrong token is refused at once and
 * nothing is kept), and it is used in one of two modes, Off or Read. The registry knows no task and no model; what the
 * assistant does with a connector goes through the session `open` returns, which is where the tool list is enforced and
 * every call is written down.
 */

export type ConnectorMode = "off" | "read";
export const MODES: readonly ConnectorMode[] = ["off", "read"];

/** What the last test found. */
export interface TestReport {
  at: number;
  ok: boolean;
  message: string;
  /** The names of the tools that are offered, in our order. */
  offered: string[];
  /** How many of the server's other tools are not offered. */
  hidden: number;
  /** Tools on our list that the server did not list. */
  missing: string[];
}

interface Saved {
  mode: ConnectorMode;
  connectedAt: number;
  test: TestReport | null;
}

/** What a screen is told about a connector. Never the token, nor anything made from it. */
export interface ConnectorView {
  id: string;
  name: string;
  summary: string;
  connected: boolean;
  mode: ConnectorMode;
  connectedAt: number | null;
  token: { label: string; helpUrl: string; recipe: string };
  revoke: { url: string; text: string };
  caution: string | null;
  test: (Omit<TestReport, "offered"> & { offered: Array<{ name: string; text: string }> }) | null;
}

export interface RegistryDeps {
  /** The folder the registry keeps its settings in, or null to keep them in memory. */
  file: string | null;
  secrets: SecretStore;
  audit: AuditLog;
  open: Opener;
  manifests?: readonly ConnectorManifest[];
  now?: () => number;
  log?: (line: string) => void;
}

/** A connection that is being used for one task: the tools it may call, and the one door through which a call goes. */
export interface ConnectorSession {
  readonly manifest: ConnectorManifest;
  readonly offered: readonly OfferedTool[];
  /** Runs one tool. A tool that is not offered is refused here, and never reaches the server. The text is redacted and cut. */
  call(name: string, args: Record<string, unknown>, ctx: { task: string | null; signal: AbortSignal }): Promise<string>;
  close(): Promise<void>;
}

const TOKEN_SHAPE = /^[!-~]{8,2000}$/;
const TEST_MS = 30_000;

export class ConnectorRegistry {
  private saved: Record<string, Saved> | null = null;

  constructor(private readonly deps: RegistryDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  manifests(): readonly ConnectorManifest[] {
    return this.deps.manifests ?? CATALOG;
  }

  private manifest(id: string): ConnectorManifest {
    const found = this.manifests().find((m) => m.id === id);
    if (!found) throw new NotFoundError("That connector");
    return found;
  }

  /** Where the tokens are kept, in words. */
  storage(): string {
    return this.deps.secrets.where;
  }

  // ------------------------------------------------------------------------------------------------------------ what is saved

  private load(): Record<string, Saved> {
    if (this.saved) return this.saved;
    let loaded: Record<string, Saved> = {};
    const file = this.deps.file;
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as { connectors?: Record<string, Saved> };
        if (raw && typeof raw.connectors === "object" && raw.connectors !== null) loaded = { ...raw.connectors };
      } catch {
        this.deps.log?.("connectors: the settings file could not be read, so every connector shows as not connected");
      }
    }
    this.saved = loaded;
    return loaded;
  }

  private persist(): void {
    const file = this.deps.file;
    if (!file || !this.saved) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, connectors: this.saved }), { mode: 0o600 });
    renameSync(temp, file);
  }

  /** Connected means a saved entry and a token both exist: a token with no entry, or an entry with no token, is neither. */
  private connectedEntry(id: string): Saved | null {
    const entry = Object.hasOwn(this.load(), id) ? (this.load()[id] ?? null) : null;
    return entry && this.deps.secrets.has(id) ? entry : null;
  }

  view(id: string): ConnectorView {
    const manifest = this.manifest(id);
    const entry = this.connectedEntry(id);
    const test = entry?.test ?? null;
    return {
      id: manifest.id,
      name: manifest.name,
      summary: manifest.summary,
      connected: entry !== null,
      mode: entry?.mode ?? "off",
      connectedAt: entry?.connectedAt ?? null,
      token: manifest.token,
      revoke: manifest.revoke,
      caution: manifest.caution ?? null,
      test: test ? { ...test, offered: test.offered.map((name) => ({ name, text: manifest.tools[name]?.text ?? "" })) } : null,
    };
  }

  views(): ConnectorView[] {
    return this.manifests().map((m) => this.view(m.id));
  }

  // ------------------------------------------------------------------------------------------------------------------ the checks

  /** Opens a connection, lists the tools, and runs the one harmless read: whether this token works, and what it would be given. */
  private async check(manifest: ConnectorManifest, token: string): Promise<TestReport> {
    const at = this.now();
    const signal = AbortSignal.timeout(TEST_MS);
    const connection = await this.deps.open(manifest, token, signal);
    try {
      const offering = offerTools(manifest, await connection.tools());
      const base = { at, offered: offering.offered.map((t) => t.name), hidden: offering.hidden.length, missing: offering.missing };
      if (offering.offered.length === 0) {
        return { ...base, ok: false, message: `${manifest.name} accepted the token, but none of the tools Ancilla reads with are offered by this server, so there is nothing to use.` };
      }
      if (!offering.offered.some((t) => t.name === manifest.probe.tool)) {
        return { ...base, ok: false, message: `${manifest.name} accepted the token, but its check tool (${manifest.probe.tool}) is not offered by this server.` };
      }
      const result = await connection.call(manifest.probe.tool, manifest.probe.args, signal);
      if (result.isError) {
        return { ...base, ok: false, message: `${manifest.name} accepted the token, but the check failed: ${cut(redact(result.text, [token]).replace(/\s+/g, " "), 160)}` };
      }
      const more = offering.hidden.length > 0 ? `, and ${offering.hidden.length} more that it has are not offered because they can change things or are not on Ancilla's list` : "";
      return { ...base, ok: true, message: `Works. ${offering.offered.length} read tool${offering.offered.length === 1 ? " is" : "s are"} offered${more}.` };
    } finally {
      await connection.close();
    }
  }

  // ------------------------------------------------------------------------------------------------------------- what a person does

  /** Connects with a token: it is kept only when the server accepts it and the check passes. */
  async connect(id: string, rawToken: unknown): Promise<ConnectorView> {
    const manifest = this.manifest(id);
    const token = typeof rawToken === "string" ? rawToken.trim() : "";
    if (!TOKEN_SHAPE.test(token)) throw new ValidationError("token", "That does not look like a token: it is too short or too long, or has spaces or characters a token does not have.");
    let report: TestReport;
    try {
      report = await this.check(manifest, token);
    } catch (error) {
      const message = error instanceof ConnectorError ? error.message : "The server could not be used.";
      this.deps.audit.add({ at: this.now(), kind: "connect", connector: id, ok: false, note: message });
      throw new ConnectorError(message);
    }
    if (!report.ok) {
      this.deps.audit.add({ at: this.now(), kind: "connect", connector: id, ok: false, note: report.message });
      throw new ConnectorError(report.message);
    }
    this.deps.secrets.set(id, token);
    this.load()[id] = { mode: "read", connectedAt: this.now(), test: report };
    this.persist();
    this.deps.audit.add({ at: this.now(), kind: "connect", connector: id, ok: true, note: report.message });
    return this.view(id);
  }

  /** Checks a connected connector again with its saved token, and remembers what was found. */
  async test(id: string): Promise<ConnectorView> {
    const manifest = this.manifest(id);
    const entry = this.connectedEntry(id);
    const token = this.deps.secrets.get(id);
    if (!entry || token === null) throw new ConflictError(`${manifest.name} is not connected.`);
    let report: TestReport;
    try {
      report = await this.check(manifest, token);
    } catch (error) {
      const message = error instanceof ConnectorError ? error.message : "The server could not be used.";
      report = { at: this.now(), ok: false, message, offered: [], hidden: 0, missing: [] };
    }
    entry.test = report;
    this.persist();
    this.deps.audit.add({ at: this.now(), kind: "test", connector: id, ok: report.ok, note: report.message });
    return this.view(id);
  }

  setMode(id: string, mode: unknown): ConnectorView {
    const manifest = this.manifest(id);
    if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)) throw new ValidationError("mode", "mode must be off or read");
    const entry = this.connectedEntry(id);
    if (!entry) throw new ConflictError(`${manifest.name} is not connected.`);
    entry.mode = mode as ConnectorMode;
    this.persist();
    this.deps.audit.add({ at: this.now(), kind: "mode", connector: id, ok: true, note: `mode ${mode}` });
    return this.view(id);
  }

  /** Forgets the token and the settings. It does not, and cannot, revoke the token at the provider: the view says where that is done. */
  disconnect(id: string): ConnectorView {
    this.manifest(id);
    const had = this.deps.secrets.delete(id);
    const entry = Object.hasOwn(this.load(), id);
    delete this.load()[id];
    this.persist();
    if (had || entry) this.deps.audit.add({ at: this.now(), kind: "disconnect", connector: id, ok: true });
    return this.view(id);
  }

  // ---------------------------------------------------------------------------------------------------------------------- use

  /** Whether a connector can be used for a task now, and if not, why: said before a task is made, not after it fails. */
  ready(id: string): { ok: boolean; reason?: string } {
    const manifest = this.manifest(id);
    const entry = this.connectedEntry(id);
    if (!entry) return { ok: false, reason: `${manifest.name} is not connected. Connect it under Assistant, Connectors.` };
    if (entry.mode === "off") return { ok: false, reason: `${manifest.name} is switched off. Switch it on under Assistant, Connectors.` };
    return { ok: true };
  }

  /** The ids of the connectors that can be used now. */
  usable(): string[] {
    return this.manifests().filter((m) => this.ready(m.id).ok).map((m) => m.id);
  }

  /** Opens a connection for one task, with the tool list laid over the server's. The caller closes it. */
  async open(id: string): Promise<ConnectorSession> {
    const manifest = this.manifest(id);
    const ready = this.ready(id);
    const token = this.deps.secrets.get(id);
    if (!ready.ok || token === null) throw new ConflictError(ready.reason ?? `${manifest.name} is not connected.`);
    const connection = await this.deps.open(manifest, token);
    let offering;
    try {
      offering = offerTools(manifest, await connection.tools());
    } catch (error) {
      await connection.close();
      throw error;
    }
    return new Session(manifest, offering.offered, connection, token, this.deps.audit, () => this.now());
  }
}

class Session implements ConnectorSession {
  private readonly byName: Map<string, OfferedTool>;

  constructor(
    readonly manifest: ConnectorManifest,
    readonly offered: readonly OfferedTool[],
    private readonly connection: LiveConnection,
    private readonly token: string,
    private readonly audit: AuditLog,
    private readonly now: () => number,
  ) {
    this.byName = new Map(offered.map((tool) => [tool.name, tool]));
  }

  async call(name: string, args: Record<string, unknown>, ctx: { task: string | null; signal: AbortSignal }): Promise<string> {
    const started = this.now();
    const masked = maskArgs(args, [this.token]);
    if (!this.byName.has(name)) {
      this.audit.add({ at: started, kind: "call", connector: this.manifest.id, task: ctx.task, tool: name.slice(0, 80), args: masked, ok: false, note: "refused: not on the list" });
      return `There is no tool called ${name.slice(0, 60)}. The tools are: ${[...this.byName.keys()].join(", ")}.`;
    }
    try {
      const result = await this.connection.call(name, args, ctx.signal);
      const text = redact(result.text, [this.token]);
      this.audit.add({ at: started, kind: "call", connector: this.manifest.id, task: ctx.task, tool: name, args: masked, ok: !result.isError, size: text.length, ms: this.now() - started });
      const shown = cut(text, RESULT_MAX);
      if (result.isError) return `The tool reported an error: ${shown === "" ? "(no details)" : shown}`;
      return shown === "" ? "(nothing came back)" : shown;
    } catch (error) {
      const message = error instanceof ConnectorError ? error.message : "The tool could not be used.";
      this.audit.add({ at: started, kind: "call", connector: this.manifest.id, task: ctx.task, tool: name, args: masked, ok: false, ms: this.now() - started, note: message });
      return `That did not work: ${message}`;
    }
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}
