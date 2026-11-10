import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { flattenResult, redact, type ConnectorManifest, type ServerTool } from "./manifest.js";

/**
 * One live connection to a connector's server, through the official MCP client (the protocol has enough corners, such as
 * streamed answers, sessions and versions, that it is not worth writing again). Two ways in: HTTP with the token as a bearer, and
 * a program on this computer that takes the token in its own environment. The token is put where the connection needs it and
 * nowhere else: never into Ancilla's environment, and the program is given a small safe one of its own (the SDK's default) plus
 * the token.
 */

export interface LiveConnection {
  /** Every tool the server lists. */
  tools(): Promise<ServerTool[]>;
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

export type Opener = (manifest: ConnectorManifest, token: string, signal?: AbortSignal) => Promise<LiveConnection>;

/** A failure said in words for the person: it never carries the token. */
export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorError";
  }
}

export const CONNECT_MS = 20_000;
export const CALL_MS = 45_000;
const LIST_PAGES = 5;

/** What went wrong, as one plain sentence, without the token and without more of the server's words than needed. */
export function explainError(error: unknown, token: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = redact(raw, [token]).replace(/\s+/g, " ").trim();
  if (/\b401\b|unauthori[sz]ed/i.test(message)) return "The server did not accept the token (401). Check that it is the right kind of token and has not expired.";
  if (/\b403\b|forbidden/i.test(message)) return "The server refused the token (403). It may be missing a permission, or the account may not allow it.";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|getaddrinfo/i.test(message)) return "Ancilla could not reach the server. Check the connection to the internet.";
  if (/timed? ?out|timeout|aborted/i.test(message)) return "The server did not answer in time.";
  return message.length > 240 ? `${message.slice(0, 237)}...` : message === "" ? "The server could not be used." : message;
}

/** The opener that talks to a real server. `version` is what Ancilla says it is to the server. */
export function makeOpener(version: string): Opener {
  return async (manifest, token, signal) => {
    const client = new Client({ name: "ancilla", version }, { capabilities: {} });
    const transport =
      manifest.transport.kind === "http"
        ? new StreamableHTTPClientTransport(new URL(manifest.transport.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
        : new StdioClientTransport({
            command: manifest.transport.command,
            args: manifest.transport.args,
            env: { ...getDefaultEnvironment(), [manifest.transport.tokenEnv]: token },
            stderr: "ignore",
          });
    try {
      await client.connect(transport, { ...(signal ? { signal } : {}), timeout: CONNECT_MS });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new ConnectorError(explainError(error, token));
    }
    return {
      async tools() {
        const all: ServerTool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < LIST_PAGES; page += 1) {
          let listed;
          try {
            listed = await client.listTools(cursor ? { cursor } : undefined, { ...(signal ? { signal } : {}), timeout: CONNECT_MS });
          } catch (error) {
            throw new ConnectorError(explainError(error, token));
          }
          for (const tool of listed.tools) all.push({ name: tool.name, inputSchema: tool.inputSchema });
          cursor = listed.nextCursor;
          if (!cursor) break;
        }
        return all;
      },
      async call(name, args, callSignal) {
        try {
          const result = await client.callTool({ name, arguments: args }, undefined, { signal: callSignal, timeout: CALL_MS });
          // An older server answers with a bare `toolResult`: it has no content, and so no text, which is what it comes to.
          return flattenResult(result as { content?: unknown; isError?: unknown });
        } catch (error) {
          throw new ConnectorError(explainError(error, token));
        }
      },
      async close() {
        await client.close().catch(() => undefined);
      },
    };
  };
}
