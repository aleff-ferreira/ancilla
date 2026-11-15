import { homedir } from "node:os";
import type { AssistantReply, AssistantRequest } from "../assistant/routes.js";
import type { AssistantService } from "../assistant/service.js";
import { ConflictError, NotFoundError, ValidationError } from "../assistant/store.js";
import { parseTaskSpec } from "../assistant/tasks.js";
import type { AuditLog } from "./audit.js";
import { ConnectorError } from "./connection.js";
import type { ConnectorRegistry } from "./registry.js";

/**
 * The connectors' HTTP surface, under `/api/assistant/connectors`: which accounts are connected, connect (the token is in the
 * request and in no answer), test, switch Off or Read, disconnect, what was done (the activity list), and a text box to ask a
 * connected account something, as the voice's `use_connector` does. Like the assistant's it is a function from a request to a
 * reply; authentication, host checks and CORS are in front of it, for every `/api` request.
 */

const PREFIX = "/api/assistant/connectors";
const ID = /^\/([A-Za-z0-9_-]{1,40})$/;

export function isConnectorPath(path: string): boolean {
  return path === PREFIX || path.startsWith(`${PREFIX}/`);
}

export interface ConnectorRouteDeps {
  registry: ConnectorRegistry;
  audit: AuditLog;
  /** The assistant, made if it does not exist yet; null when it cannot be opened. */
  assistant: () => AssistantService | null;
  /** The folder a task is started in when none is named: the project last worked in, or null. */
  project: () => string | null;
}

function failure(error: unknown): AssistantReply {
  if (error instanceof ValidationError) return { status: 400, body: { error: error.message, kind: "invalid", field: error.field } };
  if (error instanceof ConflictError) return { status: 409, body: { error: error.message, kind: "conflict" } };
  if (error instanceof NotFoundError) return { status: 404, body: { error: error.message, kind: "not_found" } };
  if (error instanceof ConnectorError) return { status: 422, body: { error: error.message, kind: "connector_failed" } };
  throw error;
}

export async function handleConnectors(deps: ConnectorRouteDeps, req: AssistantRequest): Promise<AssistantReply> {
  const sub = req.path.slice(PREFIX.length);
  const { registry } = deps;
  try {
    if (req.method === "GET" && sub === "") return { status: 200, body: { connectors: registry.views(), storage: registry.storage() } };
    if (req.method === "GET" && sub === "/activity") {
      const wanted = Number(req.query.get("limit") ?? 50);
      return { status: 200, body: { entries: deps.audit.recent(Number.isFinite(wanted) ? Math.min(200, Math.max(1, Math.floor(wanted))) : 50) } };
    }
    if (req.method === "POST" && sub === "/ask") {
      const body = await req.body();
      const connector = typeof body["connector"] === "string" ? body["connector"].trim() : "";
      const goal = typeof body["goal"] === "string" ? body["goal"].trim() : "";
      const title = typeof body["title"] === "string" ? body["title"].trim().slice(0, 120) : "";
      if (connector === "") throw new ValidationError("connector", "connector must name a connected account");
      if (goal.length < 3) throw new ValidationError("goal", "goal must say what to find out");
      const assistant = deps.assistant();
      const exec = assistant?.executive;
      if (!assistant || !exec) return { status: 503, body: { error: "Tasks need a Muse host, and this server was not given one.", kind: "tasks_unavailable" } };
      const ready = await exec.connectorAvailable(connector);
      if (!ready.ok) return { status: 409, body: { error: ready.reason ?? "That account cannot be used right now.", kind: "connector_unavailable" } };
      const spec = parseTaskSpec({ goal, cwd: deps.project() ?? homedir(), ...(title ? { title } : {}) }, assistant.store.getProfile(), (c) => assistant.projectKey(c));
      // Typed in this box by the person: they are here, so a change it asks for is put to them, as it is for a spoken one.
      return { status: 201, body: { task: exec.createConnector(spec, connector, "person") } };
    }
    // What a task is waiting to change, as a card, and the person's answer to it (do, dont, or always for a small reversible change).
    const waiting = sub.match(/^\/question\/([A-Za-z0-9_-]{1,64})$/);
    if (waiting && req.method === "GET") return { status: 200, body: { question: registry.gate.question(waiting[1] as string) } };
    if (waiting && req.method === "POST") {
      registry.gate.answer(waiting[1] as string, (await req.body())["answer"]);
      return { status: 200, body: { ok: true } };
    }
    // Changes that no one was there to look at: they wait here for the person, and run only when this very card is approved.
    if (req.method === "GET" && sub === "/proposals") return { status: 200, body: { proposals: registry.proposals() } };
    const proposal = sub.match(/^\/proposals\/([A-Za-z0-9_-]{1,64})$/);
    if (proposal && req.method === "POST") return { status: 200, body: await registry.answerProposal(proposal[1] as string, (await req.body())["answer"]) };
    const one = sub.match(ID);
    if (one && req.method === "PATCH") {
      const body = await req.body();
      if (body["policy"] === undefined && body["mode"] === undefined) throw new ValidationError("mode", "mode must be off or read, or policy must say which kinds of change to allow");
      if (body["mode"] !== undefined) registry.setMode(one[1] as string, body["mode"]);
      return { status: 200, body: { connector: body["policy"] !== undefined ? registry.setPolicy(one[1] as string, body["policy"]) : registry.view(one[1] as string) } };
    }
    if (one && req.method === "DELETE") {
      const { connector, revoked } = await registry.disconnectAndRevoke(one[1] as string);
      return { status: 200, body: { connector, revoked } };
    }
    const oauthAct = sub.match(/^\/([A-Za-z0-9_-]{1,40})\/oauth\/(client|start|callback)$/);
    if (oauthAct && req.method === "POST") {
      const id = oauthAct[1] as string;
      const step = oauthAct[2];
      const body = await req.body();
      if (step === "client") {
        const clear = body["clear"] === true;
        return {
          status: 200,
          body: {
            connector: registry.setOAuthClient(id, clear ? null : { clientId: body["clientId"], clientSecret: body["clientSecret"] }),
          },
        };
      }
      if (step === "start") {
        return { status: 200, body: await registry.startOAuth(id, { redirectUri: body["redirectUri"] }) };
      }
      return {
        status: 200,
        body: {
          connector: await registry.completeOAuth(id, {
            code: body["code"],
            state: body["state"],
            callbackUrl: body["callbackUrl"],
          }),
        },
      };
    }
    const act = sub.match(/^\/([A-Za-z0-9_-]{1,40})\/(connect|test)$/);
    if (act && req.method === "POST") {
      const id = act[1] as string;
      if (act[2] === "connect") return { status: 200, body: { connector: await registry.connect(id, (await req.body())["token"]) } };
      return { status: 200, body: { connector: await registry.test(id) } };
    }
    return { status: 404, body: { error: "Nothing is here.", kind: "not_found" } };
  } catch (error) {
    return failure(error);
  }
}
