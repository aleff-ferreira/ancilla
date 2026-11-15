import type { SpawnStdioFn } from "../../src/providers/jsonRpcStdio.js";
import { createFakeStdioHarness } from "./fakeStdioProc.js";

export interface FakeAcpAgentOptions {
  requirePermissionForPrompt?: string;
  useConfigOptionsForModels?: boolean;
  onSetConfigOption?: (params: Record<string, unknown>) => void;
}

export function createFakeAcpSpawn(options: FakeAcpAgentOptions = {}): SpawnStdioFn {
  return () => {
    const harness = createFakeStdioHarness();
    let sessionSeq = 0;
    let agentReqId = 1000;
    const pendingAgentReqs = new Map<number, (result: Record<string, unknown>) => void>();

    const requestClient = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        const id = ++agentReqId;
        pendingAgentReqs.set(id, resolve);
        harness.sendLine({ jsonrpc: "2.0", id, method, params });
      });

    harness.onClientLine((line) => {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if ("result" in msg && typeof msg["id"] === "number") {
        const resolver = pendingAgentReqs.get(msg["id"]);
        if (resolver) {
          pendingAgentReqs.delete(msg["id"]);
          resolver((msg["result"] as Record<string, unknown>) ?? {});
        }
        return;
      }
      if (typeof msg["method"] !== "string") return;
      const id = msg["id"];
      const params = (msg["params"] as Record<string, unknown>) ?? {};

      void (async () => {
        switch (msg["method"]) {
          case "initialize":
            harness.sendLine({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: 1,
                agentInfo: { name: "fake-acp", version: "1.0.0" },
                agentCapabilities: { loadSession: true },
              },
            });
            break;

          case "session/new": {
            const sessionId = `acp_sess_${++sessionSeq}`;
            if (options.useConfigOptionsForModels) {
              harness.sendLine({
                jsonrpc: "2.0",
                id,
                result: {
                  sessionId,
                  configOptions: [
                    {
                      id: "model_choice",
                      category: "model",
                      currentValue: "claude-sonnet-4.6",
                      options: [
                        {
                          group: "Premium",
                          options: [
                            { value: "claude-opus-4.6", name: "Claude Opus 4.6", description: "Deep reasoning" },
                            { value: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", description: "Balanced" },
                          ],
                        },
                      ],
                    },
                    {
                      id: "thought_level",
                      category: "thought_level",
                      currentValue: "medium",
                      options: [
                        { value: "low", name: "Low" },
                        { value: "medium", name: "Medium" },
                        { value: "high", name: "High" },
                      ],
                    },
                  ],
                },
              });
              break;
            }
            harness.sendLine({
              jsonrpc: "2.0",
              id,
              result: {
                sessionId,
                models: {
                  currentModelId: "gemini-2.5-pro",
                  availableModels: [
                    { modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Flagship" },
                    { modelId: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Fast" },
                  ],
                },
              },
            });
            break;
          }

          case "session/set_config_option": {
            options.onSetConfigOption?.(params);
            harness.sendLine({ jsonrpc: "2.0", id, result: {} });
            break;
          }

          case "session/load": {
            harness.sendLine({
              jsonrpc: "2.0",
              id,
              result: {
                sessionId: params["sessionId"],
                models: { currentModelId: "gemini-2.5-pro", availableModels: [] },
              },
            });
            break;
          }

          case "session/set_model":
          case "session/set_mode": {
            harness.sendLine({ jsonrpc: "2.0", id, result: {} });
            break;
          }

          case "session/prompt": {
            const sessionId = String(params["sessionId"]);
            const blocks = Array.isArray(params["prompt"]) ? params["prompt"] : [];
            const promptText = blocks
              .map((b) => (typeof b === "object" && b !== null ? String((b as Record<string, unknown>)["text"] ?? "") : ""))
              .join("\n");

            harness.sendLine({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId,
                update: {
                  sessionUpdate: "agent_thought_chunk",
                  content: { type: "text", text: "Planning ACP reply..." },
                },
              },
            });

            if (options.requirePermissionForPrompt && promptText.includes(options.requirePermissionForPrompt)) {
              const permReply = await requestClient("session/request_permission", {
                sessionId,
                toolCall: {
                  toolCallId: "tc_1",
                  title: "Run tests",
                  kind: "execute",
                  rawInput: { command: "npm test" },
                },
                options: [
                  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
                  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
                ],
              });
              const outcome = (permReply["outcome"] as Record<string, unknown> | undefined) ?? {};
              if (outcome["optionId"] === "reject_once" || outcome["outcome"] === "cancelled") {
                harness.sendLine({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Denied by user." },
                    },
                  },
                });
                harness.sendLine({
                  jsonrpc: "2.0",
                  id,
                  result: { stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 5 } },
                });
                return;
              }
            }

            harness.sendLine({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "search_1",
                  title: "Search docs",
                  kind: "search",
                  status: "completed",
                  rawInput: { query: "agent client protocol" },
                  rawOutput: { results: [{ url: "https://agentclientprotocol.com/" }] },
                },
              },
            });

            harness.sendLine({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: `ACP echoed: ${promptText}` },
                },
              },
            });

            harness.sendLine({
              jsonrpc: "2.0",
              id,
              result: {
                stopReason: "end_turn",
                usage: { inputTokens: 42, outputTokens: 18, cachedReadTokens: 10 },
              },
            });
            break;
          }

          default:
            if (id !== undefined) {
              harness.sendLine({ jsonrpc: "2.0", id, result: {} });
            }
            break;
        }
      })();
    });

    return harness.proc;
  };
}
