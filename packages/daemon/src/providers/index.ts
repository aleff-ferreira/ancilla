export * from "./types.js";
export * from "./jsonRpcStdio.js";
export * from "./canonicalRuntime.js";
export * from "./museDriver.js";
export * from "./acpDriver.js";
export * from "./codexDriver.js";
export * from "./claudeDriver.js";
export * from "./runtime.js";

import type { AncillaMspHostOptions } from "../mspHost.js";
import { AcpAgentHost } from "./acpDriver.js";
import { ClaudeCliStreamHost } from "./claudeDriver.js";
import { CodexAppServerHost } from "./codexDriver.js";
import type { SpawnStdioFn } from "./jsonRpcStdio.js";
import { MuseMspHost } from "./museDriver.js";
import {
  capabilitiesForProvider,
  type AgentHost,
  type ProviderHostSpawnSpec,
} from "./types.js";

/**
 * Instantiates the right CLI protocol host (`muse`, `codex`, `claude`, or `acp`) for a spawn spec.
 * (`http-api` hosts are instantiated in `@ancilla/server` where `BrainProvider` and `FileSecretStore` live.)
 */
export function createCliAgentHost(
  spec: ProviderHostSpawnSpec,
  options: AncillaMspHostOptions & { onStderr?: (chunk: string) => void; spawnFn?: SpawnStdioFn } = {},
): AgentHost {
  const caps = capabilitiesForProvider(spec.providerId);
  switch (caps.transport) {
    case "msp":
      return new MuseMspHost(spec.target, undefined, options.onStderr, options);
    case "codex-app-server":
      return new CodexAppServerHost(spec.target, {
        ...options,
        journal: spec.journal,
      });
    case "claude-stream-json":
      return new ClaudeCliStreamHost(spec.target, {
        spawnFn: options.spawnFn,
        onStderr: options.onStderr,
        journal: spec.journal,
      });
    case "acp":
      return new AcpAgentHost(spec.target, {
        ...options,
        providerId: spec.providerId,
        journal: spec.journal,
      });
    default:
      throw new Error(`Unsupported CLI transport "${caps.transport}" for provider "${spec.providerId}".`);
  }
}
