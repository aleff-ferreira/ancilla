import type { SpawnStdioFn } from "../../src/providers/jsonRpcStdio.js";
import { createFakeStdioHarness } from "./fakeStdioProc.js";

export interface FakeClaudeOptions {
  requireApprovalOnPrompt?: string;
  models?: Record<string, unknown>[];
  tokenSource?: string;
  version?: string;
}

export function createFakeClaudeSpawn(options: FakeClaudeOptions = {}): SpawnStdioFn {
  let sessionSeq = 0;
  return () => {
    const harness = createFakeStdioHarness();
    const claudeSessionId = `claude_sess_${++sessionSeq}`;
    let pendingControlResolve: ((resp: Record<string, unknown>) => void) | null = null;

    harness.onClientLine((line) => {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg["type"] === "control_request") {
        const req = (msg["request"] as Record<string, unknown> | undefined) ?? {};
        if (req["subtype"] === "initialize") {
          harness.sendLine({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: msg["request_id"],
              response: {
                models: options.models ?? [],
                account: { tokenSource: options.tokenSource ?? "oauth" },
                claude_code_version: options.version ?? "2.1.310",
              },
            },
          });
        }
        return;
      }
      if (msg["type"] === "control_response") {
        const inner = (msg["response"] as Record<string, unknown> | undefined) ?? {};
        pendingControlResolve?.(inner);
        pendingControlResolve = null;
        return;
      }
      if (msg["type"] !== "user") return;

      void (async () => {
        const message = (msg["message"] as Record<string, unknown> | undefined) ?? {};
        const rawContent = message["content"];
        const promptText =
          typeof rawContent === "string"
            ? rawContent
            : Array.isArray(rawContent)
              ? rawContent
                  .map((c) => (typeof c === "object" && c !== null ? String((c as Record<string, unknown>)["text"] ?? "") : ""))
                  .join("\n")
              : "";

        harness.sendLine({
          type: "system",
          subtype: "init",
          session_id: claudeSessionId,
          model: "claude-sonnet-4-6",
        });

        if (options.requireApprovalOnPrompt && promptText.includes(options.requireApprovalOnPrompt)) {
          const controlReply = await new Promise<Record<string, unknown>>((resolve) => {
            pendingControlResolve = resolve;
            harness.sendLine({
              type: "control_request",
              request_id: "req_perm_1",
              session_id: claudeSessionId,
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                input: { command: "ls -la" },
              },
            });
          });
          const respPayload = (controlReply["response"] as Record<string, unknown> | undefined) ?? {};
          if (respPayload["behavior"] === "deny") {
            harness.sendLine({
              type: "assistant",
              session_id: claudeSessionId,
              message: {
                role: "assistant",
                content: [{ type: "text", text: `Blocked: ${String(respPayload["message"] ?? "denied")}` }],
              },
            });
            harness.sendLine({
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: claudeSessionId,
              usage: { input_tokens: 20, output_tokens: 8 },
            });
            return;
          }
        }

        harness.sendLine({
          type: "stream_event",
          session_id: claudeSessionId,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
        });
        harness.sendLine({
          type: "stream_event",
          session_id: claudeSessionId,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Thinking carefully..." },
          },
        });
        harness.sendLine({
          type: "stream_event",
          session_id: claudeSessionId,
          event: { type: "content_block_stop", index: 0 },
        });

        harness.sendLine({
          type: "stream_event",
          session_id: claudeSessionId,
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          },
        });
        harness.sendLine({
          type: "stream_event",
          session_id: claudeSessionId,
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: `Claude replied: ${promptText}` },
          },
        });
        harness.sendLine({
          type: "stream_event",
          session_id: claudeSessionId,
          event: { type: "content_block_stop", index: 1 },
        });

        harness.sendLine({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: claudeSessionId,
          duration_ms: 95,
          usage: {
            input_tokens: 80,
            output_tokens: 32,
            cache_read_input_tokens: 16,
            cache_creation_input_tokens: 4,
          },
        });
      })();
    });

    return harness.proc;
  };
}
