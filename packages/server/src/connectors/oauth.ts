import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { safeEqual } from "../admission.js";
import { ValidationError } from "../assistant/store.js";
import { ConnectorError, explainError } from "./connection.js";
import { redact, type OAuthSpec } from "./manifest.js";
import type { OAuthClientConfig, OAuthCredentials } from "./secrets.js";

/**
 * OAuth 2.0 with PKCE (RFC 7636 S256), refresh-token persistence, and provider revocation for connectors.
 *
 * Local desktop and browser sessions bind a temporary one-shot listener on 127.0.0.1:0 (RFC 8252 §7.3) so that
 * standard Desktop OAuth clients redirect straight back without exposing Ancilla's authenticated API surface.
 * Remote browser sessions can pass an explicit redirect URI or paste the callback URL / authorization code directly.
 */

export const OAUTH_TTL_MS = 10 * 60_000;
const OAUTH_HTTP_MS = 20_000;
const MAX_PENDING_FLOWS = 8;

export interface OAuthDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  spec: OAuthSpec,
  client: OAuthClientConfig,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const url = new URL(spec.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  if (spec.scopes.length > 0) url.searchParams.set("scope", spec.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (spec.authParams) {
    for (const [key, value] of Object.entries(spec.authParams)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function parseTokenPayload(raw: string, contentType: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (contentType.includes("application/json") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to URL-encoded check
    }
  }
  const params = new URLSearchParams(trimmed);
  const out: Record<string, unknown> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function toCredentials(
  payload: Record<string, unknown>,
  now: number,
  knownSecrets: readonly string[],
  fallbackRefreshToken?: string,
): OAuthCredentials {
  if (typeof payload["error"] === "string" && payload["error"] !== "") {
    const desc = typeof payload["error_description"] === "string" ? payload["error_description"] : payload["error"];
    const clean = redact(String(desc), knownSecrets).replace(/\s+/g, " ").trim().slice(0, 200);
    throw new ConnectorError(`The provider refused the OAuth sign-in: ${clean}`);
  }
  const accessToken = typeof payload["access_token"] === "string" ? payload["access_token"].trim() : "";
  if (accessToken.length < 8) {
    throw new ConnectorError("The provider did not return an access token.");
  }
  const refreshToken =
    typeof payload["refresh_token"] === "string" && payload["refresh_token"].trim() !== ""
      ? payload["refresh_token"].trim()
      : fallbackRefreshToken;
  const expiresInRaw = Number(payload["expires_in"]);
  const expiresAt = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? now + Math.floor(expiresInRaw * 1000) : undefined;
  const scope = typeof payload["scope"] === "string" && payload["scope"].trim() !== "" ? payload["scope"].trim() : undefined;
  const tokenType = typeof payload["token_type"] === "string" && payload["token_type"].trim() !== "" ? payload["token_type"].trim() : undefined;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(scope ? { scope } : {}),
    ...(tokenType ? { tokenType } : {}),
  };
}

export async function exchangeOAuthCode(
  spec: OAuthSpec,
  client: OAuthClientConfig,
  params: { code: string; redirectUri: string; verifier: string },
  deps: OAuthDeps = {},
): Promise<OAuthCredentials> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = (deps.now ?? Date.now)();
  const known = client.clientSecret ? [client.clientSecret] : [];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: client.clientId,
    code_verifier: params.verifier,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
  });
  let res: Response;
  try {
    res = await fetchImpl(spec.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(OAUTH_HTTP_MS),
    });
  } catch (error) {
    throw new ConnectorError(explainError(error, client.clientSecret ?? "oauth-client"));
  }
  const raw = await res.text();
  const payload = parseTokenPayload(raw, res.headers.get("content-type") ?? "");
  if (!res.ok) {
    if (typeof payload["error"] === "string") toCredentials(payload, now, known);
    throw new ConnectorError(`The provider refused the authorization code (HTTP ${res.status}).`);
  }
  return toCredentials(payload, now, known);
}

export async function refreshOAuthToken(
  spec: OAuthSpec,
  client: OAuthClientConfig,
  refreshToken: string,
  deps: OAuthDeps = {},
): Promise<OAuthCredentials> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = (deps.now ?? Date.now)();
  const known = [refreshToken, ...(client.clientSecret ? [client.clientSecret] : [])];
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
  });
  let res: Response;
  try {
    res = await fetchImpl(spec.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(OAUTH_HTTP_MS),
    });
  } catch (error) {
    throw new ConnectorError(explainError(error, refreshToken));
  }
  const raw = await res.text();
  const payload = parseTokenPayload(raw, res.headers.get("content-type") ?? "");
  if (!res.ok) {
    if (typeof payload["error"] === "string") toCredentials(payload, now, known, refreshToken);
    throw new ConnectorError(`The provider could not refresh the sign-in (HTTP ${res.status}). Reconnect the account if access was revoked.`);
  }
  return toCredentials(payload, now, known, refreshToken);
}

export async function revokeOAuthToken(
  spec: OAuthSpec,
  client: OAuthClientConfig | null,
  creds: OAuthCredentials,
  deps: OAuthDeps = {},
): Promise<boolean> {
  if (!spec.revokeUrl) return false;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = creds.refreshToken ?? creds.accessToken;
  if (!token) return false;
  const body = new URLSearchParams({
    token,
    ...(client?.clientId ? { client_id: client.clientId } : {}),
    ...(client?.clientSecret ? { client_secret: client.clientSecret } : {}),
  });
  try {
    const res = await fetchImpl(spec.revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function callbackHtml(title: string, body: string, ok: boolean): string {
  const accent = ok ? "#166534" : "#991b1b";
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>body{font-family:system-ui,-apple-system,sans-serif;margin:48px auto;max-width:460px;padding:0 20px;color:#18181b;line-height:1.5}h1{font-size:18px;color:${accent};margin:0 0 8px}p{font-size:14px;color:#3f3f46;margin:0}</style>`,
    `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`,
  ].join("");
}

function validateRedirectUri(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ValidationError("redirectUri", "redirectUri must be a valid http://127.0.0.1, http://localhost, or https:// URL");
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback)) {
    return parsed.toString();
  }
  throw new ValidationError("redirectUri", "redirectUri must use https:// or loopback http://");
}

interface PendingFlow {
  connectorId: string;
  connectorName: string;
  spec: OAuthSpec;
  client: OAuthClientConfig;
  state: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  server: Server | null;
  timer: ReturnType<typeof setTimeout>;
}

export interface StartedOAuthFlow {
  authorizeUrl: string;
  state: string;
  redirectUri: string;
  loopback: boolean;
  expiresAt: number;
}

export class OAuthFlowManager {
  private readonly pending = new Map<string, PendingFlow>();

  constructor(private readonly deps: OAuthDeps = {}) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  hasPending(connectorId: string): boolean {
    this.sweep();
    for (const flow of this.pending.values()) {
      if (flow.connectorId === connectorId) return true;
    }
    return false;
  }

  cancelFor(connectorId: string): void {
    for (const [state, flow] of [...this.pending.entries()]) {
      if (flow.connectorId === connectorId) this.drop(state);
    }
  }

  closeAll(): void {
    for (const state of [...this.pending.keys()]) this.drop(state);
  }

  private drop(state: string): PendingFlow | null {
    const flow = this.pending.get(state) ?? null;
    if (!flow) return null;
    this.pending.delete(state);
    clearTimeout(flow.timer);
    if (flow.server) {
      try {
        flow.server.close();
      } catch {
        // already closed
      }
    }
    return flow;
  }

  sweep(): void {
    const now = this.now();
    for (const [state, flow] of [...this.pending.entries()]) {
      if (flow.expiresAt <= now) this.drop(state);
    }
  }

  async start(
    connectorId: string,
    connectorName: string,
    spec: OAuthSpec,
    client: OAuthClientConfig,
    options: {
      redirectUri?: string;
      onComplete?: (creds: OAuthCredentials) => Promise<void>;
    } = {},
  ): Promise<StartedOAuthFlow> {
    this.sweep();
    this.cancelFor(connectorId);
    if (this.pending.size >= MAX_PENDING_FLOWS) {
      const oldest = this.pending.keys().next().value;
      if (oldest) this.drop(oldest);
    }

    const state = randomBytes(24).toString("base64url");
    const { verifier, challenge } = pkcePair();
    const expiresAt = this.now() + OAUTH_TTL_MS;

    let redirectUri: string;
    let server: Server | null = null;
    let loopback = false;

    if (options.redirectUri && options.redirectUri.trim() !== "") {
      redirectUri = validateRedirectUri(options.redirectUri);
    } else {
      loopback = true;
      const listener = createServer((req, res) => {
        void (async () => {
          const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
          if (req.method !== "GET" || reqUrl.pathname !== "/oauth/callback") {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end("Not found.");
            return;
          }
          const sendHtml = (status: number, title: string, body: string, ok: boolean): void => {
            res.writeHead(status, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
            });
            res.end(callbackHtml(title, body, ok));
          };
          const errParam = reqUrl.searchParams.get("error");
          const givenState = reqUrl.searchParams.get("state") ?? "";
          const code = reqUrl.searchParams.get("code") ?? "";
          if (!givenState || !safeEqual(givenState, state)) {
            sendHtml(400, "Sign-in refused", "The state parameter did not match the pending sign-in request.", false);
            return;
          }
          if (errParam) {
            this.drop(state);
            sendHtml(400, "Sign-in cancelled", `The provider returned: ${errParam.slice(0, 80)}.`, false);
            return;
          }
          try {
            const creds = await this.complete(connectorId, spec, client, { code, state: givenState });
            if (options.onComplete) await options.onComplete(creds);
            sendHtml(200, `Connected to ${connectorName}`, "You can close this tab and return to Ancilla.", true);
          } catch (error) {
            const msg = error instanceof Error ? error.message : "Sign-in could not be completed.";
            sendHtml(422, `Could not connect ${connectorName}`, msg, false);
          }
        })();
      });
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", () => {
          listener.removeListener("error", reject);
          resolve();
        });
      });
      const port = (listener.address() as AddressInfo).port;
      redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
      server = listener;
    }

    const timer = setTimeout(() => this.drop(state), OAUTH_TTL_MS + 100);
    timer.unref();
    this.pending.set(state, {
      connectorId,
      connectorName,
      spec,
      client,
      state,
      verifier,
      redirectUri,
      expiresAt,
      server,
      timer,
    });

    const authorizeUrl = buildAuthorizeUrl(spec, client, redirectUri, state, challenge);
    return { authorizeUrl, state, redirectUri, loopback, expiresAt };
  }

  async complete(
    connectorId: string,
    spec: OAuthSpec,
    client: OAuthClientConfig,
    input: { code?: unknown; state?: unknown; callbackUrl?: unknown },
  ): Promise<OAuthCredentials> {
    this.sweep();
    let code = typeof input.code === "string" ? input.code.trim() : "";
    let givenState = typeof input.state === "string" ? input.state.trim() : "";

    if (typeof input.callbackUrl === "string" && input.callbackUrl.trim() !== "") {
      try {
        const parsed = new URL(input.callbackUrl.trim());
        const err = parsed.searchParams.get("error");
        if (err) throw new ConnectorError(`The provider cancelled or refused sign-in (${err.slice(0, 60)}).`);
        code = parsed.searchParams.get("code")?.trim() ?? code;
        givenState = parsed.searchParams.get("state")?.trim() ?? givenState;
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ValidationError("callbackUrl", "callbackUrl must be the full redirect URL containing code and state");
      }
    }

    if (code === "") throw new ValidationError("code", "authorization code is required");
    if (givenState === "") throw new ValidationError("state", "OAuth state parameter is required");

    let matched: PendingFlow | null = null;
    for (const flow of this.pending.values()) {
      if (flow.connectorId === connectorId && safeEqual(flow.state, givenState)) {
        matched = flow;
        break;
      }
    }
    if (!matched) {
      throw new ConnectorError("That sign-in session was not found or has already expired. Start sign-in again.");
    }
    if (matched.expiresAt <= this.now()) {
      this.drop(matched.state);
      throw new ConnectorError("That sign-in session expired after 10 minutes. Start sign-in again.");
    }
    this.drop(matched.state);

    return exchangeOAuthCode(
      spec,
      matched.client.clientId ? matched.client : client,
      { code, redirectUri: matched.redirectUri, verifier: matched.verifier },
      this.deps,
    );
  }
}
