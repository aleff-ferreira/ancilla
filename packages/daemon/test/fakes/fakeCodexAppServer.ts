import type { SpawnStdioFn } from "../../src/providers/jsonRpcStdio.js";
import { createFakeStdioHarness } from "./fakeStdioProc.js";

export interface FakeCodexOptions {
  requireApprovalOnPrompt?: string;
  requireQuestionOnPrompt?: string;
  modelPages?: { data: Record<string, unknown>[]; nextCursor?: string | null }[];
  defaultThreadModel?: string;
}

export function createFakeCodexSpawn(options: FakeCodexOptions = {}): SpawnStdioFn {
  return () => {
    const harness = createFakeStdioHarness();
    let threadSeq = 0;
    let turnSeq = 0;
    let serverReqId = 5000;
    const pendingServerReqs = new Map<number, (result: Record<string, unknown>) => void>();

    const requestClient = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        const id = ++serverReqId;
        pendingServerReqs.set(id, resolve);
        harness.sendLine({ jsonrpc: "2.0", id, method, params });
      });

    harness.onClientLine((line) => {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if ("result" in msg && typeof msg["id"] === "number") {
        const resolver = pendingServerReqs.get(msg["id"]);
        if (resolver) {
          pendingServerReqs.delete(msg["id"]);
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
              result: { userAgent: "codex-cli/0.115.0" },
            });
            break;

          case "account/rateLimits/read":
            harness.sendLine({
              jsonrpc: "2.0",
              id,
              result: {
                rateLimits: {
                  planType: "pro",
                  primary: {
                    usedPercent: 22.5,
                    windowDurationMins: 300,
                    resetsAt: Math.floor(Date.now() / 1000) + 7200,
                  },
                  secondary: {
                    usedPercent: 14.0,
                    resetsAt: Math.floor(Date.now() / 1000) + 86400 * 4,
                  },
                },
              },
            });
            break;

          case "model/list": {
            if (options.modelPages && options.modelPages.length > 0) {
              const cursor = typeof params["cursor"] === "string" ? Number(params["cursor"]) : 0;
              const page = options.modelPages[cursor] ?? { data: [], nextCursor: null };
              harness.sendLine({
                jsonrpc: "2.0",
                id,
                result: page,
              });
              break;
            }
            harness.sendLine({
              jsonrpc: "2.0",
              id,
              result: {
                data: [
                  {
                    id: "gpt-5.3-codex",
                    displayName: "GPT-5.3 Codex",
                    description: "Flagship coding model",
                    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }],
                    defaultReasoningEffort: "medium",
                  },
                ],
              },
            });
            break;
          }

          case "thread/start": {
            const threadId = `thr_${++threadSeq}`;
            harness.sendLine({
              jsonrpc: "2.0",
              id,
              result: { thread: { id: threadId }, model: params["model"] ?? options.defaultThreadModel ?? "gpt-5.3-codex" },
            });
            break;
          }

          case "thread/resume":
          case "thread/fork": {
            const threadId = msg["method"] === "thread/fork" ? `thr_${++threadSeq}` : String(params["threadId"]);
            harness.sendLine({
              jsonrpc: "2.0",
              id,
              result: { thread: { id: threadId }, model: "gpt-5.3-codex" },
            });
            break;
          }

          case "thread/compact/start":
            harness.sendLine({ jsonrpc: "2.0", id, result: { ok: true } });
            break;

          case "turn/start": {
            const threadId = String(params["threadId"]);
            const turnId = `codex_turn_${++turnSeq}`;
            const input = Array.isArray(params["input"]) ? params["input"] : [];
            const promptText = input
              .map((p) => (typeof p === "object" && p !== null ? String((p as Record<string, unknown>)["text"] ?? "") : ""))
              .join("\n");

            harness.sendLine({
              jsonrpc: "2.0",
              id,
              result: { turn: { id: turnId, status: "inProgress" } },
            });

            harness.sendLine({
              jsonrpc: "2.0",
              method: "turn/started",
              params: { threadId, turn: { id: turnId } },
            });

            if (options.requireApprovalOnPrompt && promptText.includes(options.requireApprovalOnPrompt)) {
              const decision = await requestClient("item/commandExecution/requestApproval", {
                threadId,
                turnId,
                itemId: "cmd_1",
                command: "git status",
                cwd: params["cwd"],
              });
              if (decision["decision"] === "decline" || decision["decision"] === "cancel") {
                harness.sendLine({
                  jsonrpc: "2.0",
                  method: "item/completed",
                  params: {
                    threadId,
                    item: { id: "msg_1", type: "agentMessage", text: "Command declined." },
                  },
                });
                harness.sendLine({
                  jsonrpc: "2.0",
                  method: "turn/completed",
                  params: { threadId, turn: { id: turnId, status: "completed" } },
                });
                return;
              }
            }

            let extraSuffix = "";
            if (options.requireQuestionOnPrompt && promptText.includes(options.requireQuestionOnPrompt)) {
              const answerReply = await requestClient("item/tool/requestUserInput", {
                threadId,
                turnId,
                questions: [
                  {
                    id: "q_env",
                    question: "Target environment?",
                    options: [{ label: "staging" }, { label: "prod" }],
                  },
                ],
              });
              const answers = (answerReply["answers"] as Record<string, { answers?: string[] }> | undefined) ?? {};
              extraSuffix = ` [env=${answers["q_env"]?.answers?.[0] ?? "none"}]`;
            }

            harness.sendLine({
              jsonrpc: "2.0",
              method: "item/started",
              params: { threadId, item: { id: "msg_1", type: "agentMessage" } },
            });
            harness.sendLine({
              jsonrpc: "2.0",
              method: "item/agentMessage/delta",
              params: { threadId, itemId: "msg_1", delta: `Codex answered: ${promptText}${extraSuffix}` },
            });
            harness.sendLine({
              jsonrpc: "2.0",
              method: "item/completed",
              params: {
                threadId,
                item: { id: "msg_1", type: "agentMessage", text: `Codex answered: ${promptText}${extraSuffix}` },
              },
            });
            harness.sendLine({
              jsonrpc: "2.0",
              method: "thread/tokenUsage/updated",
              params: {
                threadId,
                tokenUsage: {
                  last: {
                    inputTokens: 120,
                    outputTokens: 45,
                    cachedInputTokens: 30,
                    reasoningOutputTokens: 15,
                  },
                },
              },
            });
            harness.sendLine({
              jsonrpc: "2.0",
              method: "turn/completed",
              params: { threadId, turn: { id: turnId, status: "completed" } },
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
