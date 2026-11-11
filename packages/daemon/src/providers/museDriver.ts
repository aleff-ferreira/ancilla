import {
  AncillaMspHost,
  type AncillaMspHostOptions,
  type ServeExit,
  type ServeTarget,
  type SpawnMspConnection,
} from "../mspHost.js";
import type { CommandConnection } from "../sessions.js";
import { type AgentHost, type AgentHostStartResult, MUSE_CAPABILITIES } from "./types.js";

/**
 * Muse MSP host wrapped in the canonical `AgentHost` contract with zero behavior changes.
 */
export class MuseMspHost implements AgentHost {
  readonly providerId = "muse" as const;
  readonly capabilities = MUSE_CAPABILITIES;
  private readonly inner: AncillaMspHost;

  constructor(
    target: ServeTarget,
    spawnFn?: SpawnMspConnection,
    onStderr?: (chunk: string) => void,
    options?: AncillaMspHostOptions,
  ) {
    this.inner = new AncillaMspHost(target, spawnFn, onStderr, options);
  }

  start(clientVersion: string): Promise<AgentHostStartResult> {
    return this.inner.start(clientVersion);
  }

  get connection(): CommandConnection {
    return this.inner.connection;
  }

  get recentStderr(): string {
    return this.inner.recentStderr;
  }

  onExit(handler: (exit: ServeExit) => void): void {
    this.inner.onExit(handler);
  }

  close(): Promise<ServeExit> {
    return this.inner.close();
  }
}
