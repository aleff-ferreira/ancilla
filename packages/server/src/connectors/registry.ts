import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "../assistant/store.js";
import { AuditLog, maskArgs } from "./audit.js";
import { CATALOG } from "./catalog.js";
import { ConnectorError, type LiveConnection, type Opener } from "./connection.js";
import { argsProblem, computeFlags, detach, Permit, ReadLog, reasonOf, WriteGate, type Approval, type HoldInput, type Trigger, type Verdict, type WriteCard } from "./gate.js";
import { classOf, cleanPolicy, cut, DEFAULT_POLICY, offerTools, redact, RESULT_MAX, WRITE_CLASSES, type ConnectorManifest, type OfferedTool, type ToolClass, type ToolEntry, type WriteClass, type WritePolicy, type WriteSetting } from "./manifest.js";
import { OAuthFlowManager, refreshOAuthToken, revokeOAuthToken, type StartedOAuthFlow } from "./oauth.js";
import type { OAuthClientConfig, OAuthCredentials, SecretStore } from "./secrets.js";

/**
 * Which accounts are connected, how each may be used, and the only door to a connection: `open`. A connector is connected when
 * its token was accepted by its server (Connect proves it with one harmless read, so a wrong token is refused at once and
 * nothing is kept), and it is used in one of two modes, Off or Read, with a setting for each kind of change (all off until the
 * person switches one on). The registry knows no model; what the assistant does with a connector goes through the session `open`
 * returns, which is where the tool list is enforced, a change is held for the person's approval, and every call is written down.
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
  /** The setting for each kind of change. Read through `cleanPolicy`: whatever else is in the file is off. */
  policy?: unknown;
  /** How many reversible changes the person has said yes to here: "always" is offered after the first. */
  yes?: number;
  authMethod?: "token" | "oauth";
}

export interface ConnectorOAuthView {
  scopes: readonly string[];
  helpUrl: string;
  recipe: string;
  clientConfigured: boolean;
  clientFromEnv: boolean;
  pending: boolean;
  canRevoke: boolean;
}

/** What a screen is told about a connector. Never the token, nor anything made from it. */
export interface ConnectorView {
  id: string;
  name: string;
  summary: string;
  connected: boolean;
  mode: ConnectorMode;
  connectedAt: number | null;
  authMethod?: "token" | "oauth" | null;
  oauth?: ConnectorOAuthView | null;
  token: { label: string; helpUrl: string; recipe: string };
  revoke: { url: string; text: string };
  caution: string | null;
  /** The person's setting for each kind of change. */
  policy: WritePolicy;
  /** The tools that change something, with our words for each: what the settings above switch on. */
  writeTools: Array<{ name: string; class: WriteClass; text: string }>;
  test: (Omit<TestReport, "offered"> & { offered: Array<{ name: string; text: string; class: ToolClass }> }) | null;
}

export interface RegistryDeps {
  /** The folder the registry keeps its settings in, or null to keep them in memory. */
  file: string | null;
  secrets: SecretStore;
  audit: AuditLog;
  open: Opener;
  /** Where changes wait for the person: made here when not given. */
  gate?: WriteGate;
  manifests?: readonly ConnectorManifest[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

/** What a session is for: who asked, what they asked, and how the task shows that it waits. */
export interface SessionRun {
  task: string | null;
  trigger: Trigger;
  /** What the person asked for, in their words: the only text in the task that is theirs. */
  goal: string;
  ask?: { asking(reason: string): void; resumed(reason: string): void };
}

/** With no run given, nobody is known to be there: a change becomes a proposal and nothing is done. */
const UNATTENDED: SessionRun = { task: null, trigger: "incoming", goal: "" };

/** A connection that is being used for one task: the tools it may call, and the one door through which a call goes. */
export interface ConnectorSession {
  readonly manifest: ConnectorManifest;
  readonly offered: readonly OfferedTool[];
  /** Runs one tool. A tool that is not offered is refused here, and never reaches the server; one that changes something waits for the person. The text is redacted and cut. */
  call(name: string, args: Record<string, unknown>, ctx: { task: string | null; signal: AbortSignal }): Promise<string>;
  /** Sends a change the person approved from a proposal, with the approval the gate gave for it. */
  sendApproved(name: string, args: Record<string, unknown>, approval: Approval, ctx: { task: string | null; signal: AbortSignal }): Promise<string>;
  close(): Promise<void>;
}

const TOKEN_SHAPE = /^[!-~]{8,2000}$/;
const TEST_MS = 30_000;

const KINDS: Record<WriteClass, string> = {
  reversible: "small changes that can be undone",
  communicates: "changes other people see (comments, issues, pull requests)",
  destructive: "changes that cannot be taken back (merging, closing)",
};

const NOT_DONE: Record<"dont" | "expired" | "ended", string> = {
  dont: "Not done: the person looked at it and said no. Do not try it again. In your answer, say what you would have changed and that they declined.",
  expired: "Not done: the person did not answer in 10 minutes, so nothing was changed. Say so in your answer, and do not ask again.",
  ended: "Not done: the task was stopped.",
};

const PROPOSED = "Not done: this task was not started by the person, so it may not change anything. The change was saved as a proposal that the person can approve or refuse later. Say so in your answer.";

const CLIENT_ID_SHAPE = /^[!-~]{4,400}$/;
const REFRESH_MARGIN_MS = 60_000;

export class ConnectorRegistry {
  private saved: Record<string, Saved> | null = null;
  private readonly oauthFlows: OAuthFlowManager;
  private readonly refreshing = new Map<string, Promise<string>>();
  /** Where changes wait for the person. */
  readonly gate: WriteGate;

  constructor(private readonly deps: RegistryDeps) {
    this.gate = deps.gate ?? new WriteGate({ audit: deps.audit, ...(deps.now ? { now: deps.now } : {}) });
    this.oauthFlows = new OAuthFlowManager({
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

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

  private knownSecretsFor(id: string, liveToken: string): string[] {
    const extra = this.deps.secrets.knownSecrets?.(id) ?? [];
    return extra.includes(liveToken) ? extra : [liveToken, ...extra];
  }

  private oauthClientFor(id: string, manifest: ConnectorManifest): { config: OAuthClientConfig | null; fromEnv: boolean } {
    const stored = this.deps.secrets.getOAuthClient?.(id) ?? null;
    if (stored) return { config: stored, fromEnv: false };
    const idEnv = manifest.oauth?.clientIdEnv;
    const envClientId = idEnv ? process.env[idEnv]?.trim() : "";
    if (envClientId) {
      const secretEnv = manifest.oauth?.clientSecretEnv;
      const envSecret = secretEnv ? process.env[secretEnv]?.trim() : "";
      return {
        config: { clientId: envClientId, ...(envSecret ? { clientSecret: envSecret } : {}) },
        fromEnv: true,
      };
    }
    return { config: null, fromEnv: false };
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

  /** The person's settings for this account: what is stored, made safe. */
  policy(id: string): WritePolicy {
    return cleanPolicy(this.connectedEntry(id)?.policy);
  }

  view(id: string): ConnectorView {
    const manifest = this.manifest(id);
    const entry = this.connectedEntry(id);
    const test = entry?.test ?? null;
    const classOfName = (name: string): ToolClass => manifest.tools[name]?.class ?? "read";
    const oauthClient = manifest.oauth ? this.oauthClientFor(id, manifest) : { config: null, fromEnv: false };
    const isOAuth = entry ? (entry.authMethod === "oauth" || Boolean(this.deps.secrets.getOAuth?.(id))) : false;
    return {
      id: manifest.id,
      name: manifest.name,
      summary: manifest.summary,
      connected: entry !== null,
      mode: entry?.mode ?? "off",
      connectedAt: entry?.connectedAt ?? null,
      authMethod: entry ? (isOAuth ? "oauth" : "token") : null,
      oauth: manifest.oauth
        ? {
            scopes: manifest.oauth.scopes,
            helpUrl: manifest.oauth.helpUrl,
            recipe: manifest.oauth.recipe,
            clientConfigured: oauthClient.config !== null,
            clientFromEnv: oauthClient.fromEnv,
            pending: this.oauthFlows.hasPending(id),
            canRevoke: Boolean(manifest.oauth.revokeUrl),
          }
        : null,
      token: manifest.token,
      revoke: manifest.revoke,
      caution: manifest.caution ?? null,
      policy: cleanPolicy(entry?.policy),
      writeTools: Object.entries(manifest.tools)
        .filter(([, tool]) => tool.class !== "read")
        .map(([name, tool]) => ({ name, class: tool.class as WriteClass, text: tool.text })),
      test: test ? { ...test, offered: test.offered.map((name) => ({ name, text: manifest.tools[name]?.text ?? "", class: classOfName(name) })) } : null,
    };
  }

  views(): ConnectorView[] {
    return this.manifests().map((m) => this.view(m.id));
  }

  // ------------------------------------------------------------------------------------------------------------------ the checks

  /** Opens a connection, lists the tools, and runs the one harmless read: whether this token works, and what it would be given. */
  private async check(manifest: ConnectorManifest, token: string, policy: WritePolicy): Promise<TestReport> {
    const at = this.now();
    const signal = AbortSignal.timeout(TEST_MS);
    const connection = await this.deps.open(manifest, token, signal);
    try {
      const offering = offerTools(manifest, await connection.tools(), policy);
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
      const reads = offering.offered.filter((t) => t.class === "read").length;
      const changes = offering.offered.length - reads;
      const asks = changes > 0 ? `, and ${changes} that ask${changes === 1 ? "s" : ""} you before ${changes === 1 ? "it changes" : "they change"} something` : "";
      const more = offering.hidden.length > 0 ? `, and ${offering.hidden.length} more that it has are not offered because they can change things or are not on Ancilla's list` : "";
      return { ...base, ok: true, message: `Works. ${reads} read tool${reads === 1 ? " is" : "s are"} offered${asks}${more}.` };
    } finally {
      await connection.close();
    }
  }

  /** Returns a fresh access token, refreshing an expiring OAuth credential automatically when a refresh token is stored. */
  private async ensureFreshToken(id: string, manifest: ConnectorManifest): Promise<string | null> {
    const oauth = this.deps.secrets.getOAuth?.(id) ?? null;
    if (!oauth || !oauth.refreshToken || !manifest.oauth) {
      return this.deps.secrets.get(id);
    }
    if (oauth.expiresAt === undefined || oauth.expiresAt - this.now() > REFRESH_MARGIN_MS) {
      return oauth.accessToken;
    }
    const existing = this.refreshing.get(id);
    if (existing) return existing;

    const { config: client } = this.oauthClientFor(id, manifest);
    if (!client) return oauth.accessToken;

    const job = (async () => {
      try {
        const refreshed = await refreshOAuthToken(manifest.oauth!, client, oauth.refreshToken!, {
          ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
          now: () => this.now(),
        });
        if (this.deps.secrets.setOAuth) this.deps.secrets.setOAuth(id, refreshed);
        else this.deps.secrets.set(id, refreshed.accessToken);
        return refreshed.accessToken;
      } finally {
        this.refreshing.delete(id);
      }
    })();
    this.refreshing.set(id, job);
    return job;
  }

  // ------------------------------------------------------------------------------------------------------------- what a person does

  /** Saves or clears an OAuth Client ID (and optional Client Secret) in the user-only secrets store. */
  setOAuthClient(id: string, input: { clientId?: unknown; clientSecret?: unknown } | null): ConnectorView {
    const manifest = this.manifest(id);
    if (!manifest.oauth) throw new ValidationError("oauth", `${manifest.name} connects with an API token rather than OAuth.`);
    if (!this.deps.secrets.setOAuthClient) throw new ConflictError("This secret store does not support OAuth client credentials.");
    if (input === null || (typeof input.clientId === "string" && input.clientId.trim() === "")) {
      this.deps.secrets.setOAuthClient(id, null);
      return this.view(id);
    }
    const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
    const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
    if (!CLIENT_ID_SHAPE.test(clientId)) {
      throw new ValidationError("clientId", "Client ID must be 4 to 400 printable characters without spaces.");
    }
    if (clientSecret !== "" && !CLIENT_ID_SHAPE.test(clientSecret)) {
      throw new ValidationError("clientSecret", "Client Secret must be 4 to 400 printable characters without spaces.");
    }
    this.deps.secrets.setOAuthClient(id, { clientId, ...(clientSecret !== "" ? { clientSecret } : {}) });
    return this.view(id);
  }

  /** Starts an OAuth 2.0 + PKCE sign-in flow, binding a temporary 127.0.0.1 callback listener unless `redirectUri` is provided. */
  async startOAuth(id: string, options: { redirectUri?: unknown } = {}): Promise<StartedOAuthFlow> {
    const manifest = this.manifest(id);
    if (!manifest.oauth) throw new ValidationError("oauth", `${manifest.name} does not use OAuth sign-in.`);
    const { config: client } = this.oauthClientFor(id, manifest);
    if (!client) {
      throw new ValidationError("clientId", `Save an OAuth Client ID for ${manifest.name} first.`);
    }
    const redirectUri = typeof options.redirectUri === "string" && options.redirectUri.trim() !== "" ? options.redirectUri.trim() : undefined;
    return this.oauthFlows.start(id, manifest.name, manifest.oauth, client, {
      ...(redirectUri ? { redirectUri } : {}),
      onComplete: async (creds) => {
        await this.finishOAuthConnect(id, manifest, creds);
      },
    });
  }

  /** Finishes an OAuth sign-in from `{ code, state }` or `{ callbackUrl }`, probes the account, and stores access + refresh tokens. */
  async completeOAuth(id: string, input: { code?: unknown; state?: unknown; callbackUrl?: unknown }): Promise<ConnectorView> {
    const manifest = this.manifest(id);
    if (!manifest.oauth) throw new ValidationError("oauth", `${manifest.name} does not use OAuth sign-in.`);
    const { config: client } = this.oauthClientFor(id, manifest);
    if (!client) throw new ValidationError("clientId", `Save an OAuth Client ID for ${manifest.name} first.`);
    const creds = await this.oauthFlows.complete(id, manifest.oauth, client, input);
    return this.finishOAuthConnect(id, manifest, creds);
  }

  private async finishOAuthConnect(id: string, manifest: ConnectorManifest, creds: OAuthCredentials): Promise<ConnectorView> {
    let report: TestReport;
    try {
      report = await this.check(manifest, creds.accessToken, DEFAULT_POLICY);
    } catch (error) {
      const message = error instanceof ConnectorError ? error.message : "The server could not be used.";
      this.deps.audit.add({ at: this.now(), kind: "connect", connector: id, ok: false, note: message });
      if (manifest.oauth?.revokeUrl) {
        void revokeOAuthToken(manifest.oauth, this.oauthClientFor(id, manifest).config, creds, {
          ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        });
      }
      throw new ConnectorError(message);
    }
    if (!report.ok) {
      this.deps.audit.add({ at: this.now(), kind: "connect", connector: id, ok: false, note: report.message });
      if (manifest.oauth?.revokeUrl) {
        void revokeOAuthToken(manifest.oauth, this.oauthClientFor(id, manifest).config, creds, {
          ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        });
      }
      throw new ConnectorError(report.message);
    }
    if (this.deps.secrets.setOAuth) this.deps.secrets.setOAuth(id, creds);
    else this.deps.secrets.set(id, creds.accessToken);
    this.load()[id] = { mode: "read", connectedAt: this.now(), test: report, policy: { ...DEFAULT_POLICY }, yes: 0, authMethod: "oauth" };
    this.persist();
    this.deps.audit.add({ at: this.now(), kind: "connect", connector: id, ok: true, note: report.message });
    return this.view(id);
  }

  /** Connects with a token: it is kept only when the server accepts it and the check passes. Every kind of change starts off. */
  async connect(id: string, rawToken: unknown): Promise<ConnectorView> {
    const manifest = this.manifest(id);
    const token = typeof rawToken === "string" ? rawToken.trim() : "";
    if (!TOKEN_SHAPE.test(token)) throw new ValidationError("token", "That does not look like a token: it is too short or too long, or has spaces or characters a token does not have.");
    let report: TestReport;
    try {
      report = await this.check(manifest, token, DEFAULT_POLICY);
    } catch (error) {
      const message = error instanceof ConnectorError ? error.message : "The server could not be used.";
      this.deps.audit.add({ at: this.now(), kind: "connect", connector: id, ok: false, note: message });
      throw new ConnectorError(message);
    }
    if (!report.ok) {
      this.deps.audit.add({ at: this.now(), kind: "connect", connector: id, ok: false, note: report.message });
      throw new ConnectorError(report.message);
    }
    this.oauthFlows.cancelFor(id);
    this.deps.secrets.set(id, token);
    this.load()[id] = { mode: "read", connectedAt: this.now(), test: report, policy: { ...DEFAULT_POLICY }, yes: 0, authMethod: "token" };
    this.persist();
    this.deps.audit.add({ at: this.now(), kind: "connect", connector: id, ok: true, note: report.message });
    return this.view(id);
  }

  /** Checks a connected connector again with its saved token (refreshing OAuth tokens when due), and remembers what was found. */
  async test(id: string): Promise<ConnectorView> {
    const manifest = this.manifest(id);
    const entry = this.connectedEntry(id);
    if (!entry || !this.deps.secrets.has(id)) throw new ConflictError(`${manifest.name} is not connected.`);
    let report: TestReport;
    try {
      const token = await this.ensureFreshToken(id, manifest);
      if (token === null) throw new ConflictError(`${manifest.name} is not connected.`);
      report = await this.check(manifest, token, cleanPolicy(entry.policy));
    } catch (error) {
      if (error instanceof ConflictError) throw error;
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

  /**
   * Switches kinds of change on or off for one account: off, or ask (every change waits for an approval). A reversible change can
   * also be allowed for good, but only after the person has said yes to one; the others never can.
   */
  setPolicy(id: string, patch: unknown): ConnectorView {
    const manifest = this.manifest(id);
    const entry = this.connectedEntry(id);
    if (!entry) throw new ConflictError(`${manifest.name} is not connected.`);
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new ValidationError("policy", "policy must say which kinds of change to allow");
    const next = cleanPolicy(entry.policy);
    const said: string[] = [];
    for (const [cls, value] of Object.entries(patch)) {
      if (!(WRITE_CLASSES as readonly string[]).includes(cls)) throw new ValidationError("policy", `${cls.slice(0, 30)} is not a kind of change`);
      if (value !== "off" && value !== "ask" && !(value === "always" && cls === "reversible")) {
        throw new ValidationError("policy", cls === "reversible" ? "reversible can be off, ask or always" : `${cls} can be off or ask: it is asked about every time`);
      }
      if (value === "always" && (entry.yes ?? 0) < 1) throw new ValidationError("policy", "Say yes to one reversible change first: then it can be allowed for good.");
      next[cls as WriteClass] = value as WriteSetting;
      said.push(`${cls} ${value}`);
    }
    entry.policy = next;
    this.persist();
    this.deps.audit.add({ at: this.now(), kind: "policy", connector: id, ok: true, note: said.join(", ") });
    return this.view(id);
  }

  /** Forgets the token and the settings synchronously; triggers best-effort OAuth revocation when applicable. */
  disconnect(id: string): ConnectorView {
    const manifest = this.manifest(id);
    this.oauthFlows.cancelFor(id);
    const oauth = this.deps.secrets.getOAuth?.(id) ?? null;
    if (oauth && manifest.oauth?.revokeUrl) {
      void revokeOAuthToken(manifest.oauth, this.oauthClientFor(id, manifest).config, oauth, {
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      });
    }
    const had = this.deps.secrets.delete(id);
    const entry = Object.hasOwn(this.load(), id);
    delete this.load()[id];
    this.persist();
    if (had || entry) this.deps.audit.add({ at: this.now(), kind: "disconnect", connector: id, ok: true });
    return this.view(id);
  }

  /** Disconnects the account and awaits provider OAuth token revocation when supported. */
  async disconnectAndRevoke(id: string): Promise<{ connector: ConnectorView; revoked: boolean }> {
    const manifest = this.manifest(id);
    this.oauthFlows.cancelFor(id);
    const oauth = this.deps.secrets.getOAuth?.(id) ?? null;
    let revoked = false;
    if (oauth && manifest.oauth?.revokeUrl) {
      revoked = await revokeOAuthToken(manifest.oauth, this.oauthClientFor(id, manifest).config, oauth, {
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      });
    }
    const had = this.deps.secrets.delete(id);
    const entry = Object.hasOwn(this.load(), id);
    delete this.load()[id];
    this.persist();
    if (had || entry) {
      this.deps.audit.add({
        at: this.now(),
        kind: "disconnect",
        connector: id,
        ok: true,
        ...(revoked ? { note: "revoked at provider" } : {}),
      });
    }
    return { connector: this.view(id), revoked };
  }

  close(): void {
    this.oauthFlows.closeAll();
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

  /** Opens a connection for one task, refreshing an expiring OAuth token first and laying our tool list over the server's. */
  async open(id: string, run: SessionRun = UNATTENDED): Promise<ConnectorSession> {
    const manifest = this.manifest(id);
    const ready = this.ready(id);
    if (!ready.ok) throw new ConflictError(ready.reason ?? `${manifest.name} is not connected.`);
    const token = await this.ensureFreshToken(id, manifest);
    if (token === null) throw new ConflictError(`${manifest.name} is not connected.`);
    const knownSecrets = this.knownSecretsFor(id, token);
    const connection = await this.deps.open(manifest, token);
    let offering;
    try {
      offering = offerTools(manifest, await connection.tools(), this.policy(id));
    } catch (error) {
      await connection.close();
      throw error;
    }
    return new Session({
      manifest,
      offered: offering.offered,
      connection,
      token,
      knownSecrets,
      audit: this.deps.audit,
      gate: this.gate,
      now: () => this.now(),
      run,
      policy: () => this.policy(id),
      yes: () => this.connectedEntry(id)?.yes ?? 0,
      countYes: () => {
        const entry = this.connectedEntry(id);
        if (entry) {
          entry.yes = (entry.yes ?? 0) + 1;
          this.persist();
        }
      },
      allowAlways: () => {
        const entry = this.connectedEntry(id);
        if (!entry) return;
        entry.policy = { ...cleanPolicy(entry.policy), reversible: "always" };
        entry.yes = (entry.yes ?? 0) + 1;
        this.persist();
        this.deps.audit.add({ at: this.now(), kind: "policy", connector: id, ok: true, note: "reversible always" });
      },
    });
  }

  // ------------------------------------------------------------------------------------------------------------------ proposals

  /** The changes that wait for the person with no task to hold them: what a task nobody started in person wanted to do. */
  proposals(): WriteCard[] {
    return this.gate.proposals();
  }

  /** The person's answer to a proposal. "do" sends that very change, with an approval bound to it, and says how it went. */
  async answerProposal(cardId: string, answer: unknown, signal: AbortSignal = AbortSignal.timeout(TEST_MS)): Promise<{ done: boolean; text: string }> {
    const taken = this.gate.takeProposal(cardId, answer);
    if (!taken) return { done: false, text: "Nothing was done." };
    const { card, args, approval } = taken;
    const entry = this.manifest(card.connector).tools[card.tool];
    const cls = entry ? classOf(entry, args) : null;
    if (!entry || cls === null || cls === "read" || this.policy(card.connector)[cls] === "off") return { done: false, text: "That kind of change is switched off now, so nothing was done." };
    const session = await this.open(card.connector, { task: null, trigger: "person", goal: "" });
    try {
      const text = await session.sendApproved(card.tool, args, approval, { task: null, signal });
      return { done: true, text };
    } finally {
      await session.close().catch(() => undefined);
    }
  }
}

interface SessionDeps {
  manifest: ConnectorManifest;
  offered: readonly OfferedTool[];
  connection: LiveConnection;
  token: string;
  knownSecrets: readonly string[];
  audit: AuditLog;
  gate: WriteGate;
  now: () => number;
  run: SessionRun;
  policy: () => WritePolicy;
  yes: () => number;
  countYes: () => void;
  allowAlways: () => void;
}

class Session implements ConnectorSession {
  private readonly byName: Map<string, OfferedTool>;
  /** What this task has read: whether a stranger wrote any of it, and the text, so that a change can be checked against it. */
  private readonly reads = new ReadLog();

  constructor(private readonly deps: SessionDeps) {
    this.byName = new Map(deps.offered.map((tool) => [tool.name, tool]));
  }

  get manifest(): ConnectorManifest {
    return this.deps.manifest;
  }

  get offered(): readonly OfferedTool[] {
    return this.deps.offered;
  }

  async call(name: string, args: Record<string, unknown>, ctx: { task: string | null; signal: AbortSignal }): Promise<string> {
    const { manifest } = this.deps;
    const entry = Object.hasOwn(manifest.tools, name) ? manifest.tools[name] : undefined;
    if (!entry || !this.byName.has(name)) {
      const off = entry !== undefined && entry.class !== "read" && this.deps.policy()[entry.class] === "off";
      this.deps.audit.add({ at: this.deps.now(), kind: "call", connector: manifest.id, task: ctx.task, tool: name.slice(0, 80), args: maskArgs(args, this.deps.knownSecrets), ok: false, note: off ? "refused: switched off" : "refused: not on the list" });
      return off && entry ? this.switchedOff(entry.class as WriteClass) : `There is no tool called ${name.slice(0, 60)}. The tools are: ${[...this.byName.keys()].join(", ")}.`;
    }
    return entry.class === "read" ? this.read(name, entry, args, ctx) : this.write(name, entry, args, ctx);
  }

  private switchedOff(cls: WriteClass): string {
    return `Not done: ${KINDS[cls]} are switched off for ${this.deps.manifest.name}. The person can switch them on under Assistant, Connectors. Tell them if that is what the task needs.`;
  }

  // ------------------------------------------------------------------------------------------------------------------ looking

  private async read(name: string, entry: ToolEntry, args: Record<string, unknown>, ctx: { task: string | null; signal: AbortSignal }): Promise<string> {
    const { audit, manifest, knownSecrets } = this.deps;
    const started = this.deps.now();
    const masked = maskArgs(args, knownSecrets);
    try {
      const result = await this.deps.connection.call(name, args, ctx.signal);
      const text = redact(result.text, knownSecrets);
      audit.add({ at: started, kind: "call", connector: manifest.id, task: ctx.task, tool: name, args: masked, ok: !result.isError, size: text.length, ms: this.deps.now() - started });
      if (!result.isError) this.reads.record(entry.own === true, entry.target?.(args)?.item ?? null, text);
      const shown = cut(text, RESULT_MAX);
      if (result.isError) return `The tool reported an error: ${shown === "" ? "(no details)" : shown}`;
      return shown === "" ? "(nothing came back)" : shown;
    } catch (error) {
      const message = error instanceof ConnectorError ? error.message : "The tool could not be used.";
      audit.add({ at: started, kind: "call", connector: manifest.id, task: ctx.task, tool: name, args: masked, ok: false, ms: this.deps.now() - started, note: message });
      return `That did not work: ${message}`;
    }
  }

  // ----------------------------------------------------------------------------------------------------------------- changing

  /**
   * A change. It is classed (by the tool, and by its arguments), checked against the person's settings, then put to the person
   * as a card made from the call itself, and sent only with the approval their answer made. A task nobody started in person
   * never gets that far: its change becomes a proposal.
   */
  private async write(name: string, entry: ToolEntry, rawArgs: Record<string, unknown>, ctx: { task: string | null; signal: AbortSignal }): Promise<string> {
    const { audit, gate, manifest, run, knownSecrets } = this.deps;
    const args = detach(rawArgs);
    const cls = classOf(entry, args) as WriteClass;
    const policy = this.deps.policy();
    const refused = (note: string): void => audit.add({ at: this.deps.now(), kind: "write", connector: manifest.id, task: ctx.task, tool: name, args: maskArgs(args, knownSecrets), phase: "refused", ok: false, note });
    const problem = argsProblem(args);
    if (problem !== null) {
      refused(problem);
      return `Not done: ${problem}.`;
    }
    if (policy[cls] === "off") {
      refused(`switched off: ${cls}`);
      return this.switchedOff(cls);
    }
    const target = entry.target?.(args) ?? null;
    const flags = computeFlags({ args, target, goal: run.goal, reads: this.reads, known: knownSecrets });
    const input: HoldInput = {
      taskId: ctx.task,
      connector: manifest.id,
      connectorName: manifest.name,
      tool: name,
      cls,
      what: entry.text,
      args,
      target,
      flags,
      // "Always" is offered for a reversible change after a first yes, and never while the task holds text a stranger wrote.
      offerAlways: cls === "reversible" && policy.reversible === "ask" && this.deps.yes() >= 1 && !this.reads.tainted,
    };
    if (run.trigger !== "person") return gate.propose(input) !== null ? PROPOSED : "Not done: too many changes already wait for the person. Say so in your answer.";
    let approval: Approval;
    // Only a reversible change can be allowed without a card, and only by the person's own "always". Taint cannot change that for the
    // other kinds: their setting is never "always" (cleanPolicy), so they always come to the person.
    if (cls === "reversible" && policy.reversible === "always") {
      approval = gate.standing(input);
    } else {
      // The card is in the gate before the task says it waits, so that a screen that looks at once finds it.
      const pending = gate.hold(input, ctx.signal);
      run.ask?.asking(reasonOf({ what: entry.text, target: target?.label ?? null, connectorName: manifest.name }));
      let verdict: Verdict;
      try {
        verdict = await pending;
      } finally {
        run.ask?.resumed("Working on it.");
      }
      if (!verdict.allowed) return NOT_DONE[verdict.why];
      approval = verdict.approval;
      if (cls === "reversible") {
        if (verdict.always) this.deps.allowAlways();
        else this.deps.countYes();
      }
    }
    return this.sendApproved(name, args, approval, ctx);
  }

  /** Sends a change with its approval. The gate refuses an approval that is used, lapsed, or for other arguments, and then nothing is sent. */
  async sendApproved(name: string, rawArgs: Record<string, unknown>, approval: Approval, ctx: { task: string | null; signal: AbortSignal }): Promise<string> {
    const { gate, manifest, knownSecrets } = this.deps;
    const args = detach(rawArgs);
    const call = { connector: manifest.id, tool: name, args, task: ctx.task };
    const redeemed = gate.redeem(approval, call);
    if (!redeemed.ok) return `Not done: ${redeemed.why}. Nothing was changed.`;
    const started = this.deps.now();
    try {
      const result = await this.send(redeemed.permit, name, args, ctx.signal);
      const text = redact(result.text, knownSecrets);
      gate.executed(call, { ok: !result.isError, size: text.length, ms: this.deps.now() - started });
      const shown = cut(text, RESULT_MAX);
      if (result.isError) return `The tool reported an error: ${shown === "" ? "(no details)" : shown}`;
      return shown === "" ? "Done." : shown;
    } catch (error) {
      const message = error instanceof ConnectorError ? error.message : "The change could not be sent.";
      gate.executed(call, { ok: false, size: 0, ms: this.deps.now() - started, note: message });
      return `That did not work: ${message}`;
    }
  }

  /** The one place a change reaches the server: it takes the permit the gate made for exactly this connector, tool and arguments. */
  private send(permit: Permit, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
    if (!(permit instanceof Permit) || !permit.matches(this.deps.manifest.id, name, args)) throw new ConnectorError("A change was about to be sent without an approval that matches it, so it was not sent.");
    return this.deps.connection.call(name, args, signal);
  }

  async close(): Promise<void> {
    await this.deps.connection.close();
  }
}
