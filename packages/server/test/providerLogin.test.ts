import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import {
  CanonicalSessionRuntime,
  capabilitiesForProvider,
  resolveBinaryInDistro,
} from "@ancilla/daemon";
import { extractLoginFailureMessage, parseProviderLoginOutput } from "../src/providers/loginParser.js";
import type { LoginChild } from "../src/server.js";
import { FakeConnection, get, send, start } from "./harness.js";

function makeInteractiveLoginChild() {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  const child: LoginChild & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: () => boolean;
    finish: (exitCode: number) => void;
  } = {
    stdin,
    stdout,
    stderr,
    on(event, listener) {
      events.on(event, listener);
    },
    kill() {
      killed = true;
      events.emit("close", 143);
    },
    killed: () => killed,
    finish(exitCode: number) {
      events.emit("close", exitCode);
    },
  };
  return child;
}

describe("parseProviderLoginOutput & WSL CLI binary discovery", () => {
  it("preserves full Claude Code OAuth URL with query params, rejects ?code=true as a device code, and detects paste-code prompt", () => {
    const claudeUrl =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=abc_123&code_challenge_method=S256&state=xyz-789";
    const output = `Opening browser to sign in…\nIf the browser didn't open, visit: ${claudeUrl}\nPaste code here if prompted > `;

    const parsed = parseProviderLoginOutput(output);
    assert.equal(parsed.url, claudeUrl);
    assert.equal(parsed.code, null);
    assert.equal(parsed.needsCodeInput, true);
    assert.equal(parsed.urlComplete, true);
  });

  it("extracts OpenAI Codex OAuth authorize URL while skipping http://localhost:1455 banner and keeping code null", () => {
    const codexUrl =
      "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&code_challenge=acwD19p&code_challenge_method=S256&state=GGiH6p";
    const output = [
      "Starting local login server on http://localhost:1455.",
      "If your browser did not open, navigate to this URL to authenticate:",
      "",
      codexUrl,
      "",
      "On a remote or headless machine? Use `codex login --device-auth` instead.",
      "",
    ].join("\n");

    const parsed = parseProviderLoginOutput(output);
    assert.equal(parsed.url, codexUrl);
    assert.equal(parsed.code, null);
    assert.equal(parsed.needsCodeInput, false);
    assert.equal(parsed.urlComplete, true);
  });

  it("extracts genuine GitHub Copilot / OAuth device codes from standalone output and user_code query params", () => {
    const copilotOut =
      "\x1b[32m!\x1b[0m First copy your one-time code: \x1b[1mABCD-1234\x1b[0m\nOpen https://github.com/login/device in your browser.\n";
    const parsedCopilot = parseProviderLoginOutput(copilotOut);
    assert.equal(parsedCopilot.url, "https://github.com/login/device");
    assert.equal(parsedCopilot.code, "ABCD-1234");
    assert.equal(parsedCopilot.needsCodeInput, false);

    const queryCodeOut = "Visit https://example.com/device?user_code=WXYZ-9876&client_id=test\n";
    const parsedQuery = parseProviderLoginOutput(queryCodeOut);
    assert.equal(parsedQuery.url, "https://example.com/device?user_code=WXYZ-9876&client_id=test");
    assert.equal(parsedQuery.code, "WXYZ-9876");

    const codexDeviceOut =
      "\nWelcome to Codex [v\x1b[90m0.164.0\x1b[0m]\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mDIT0-WD3VA\x1b[0m\n";
    const parsedCodexDevice = parseProviderLoginOutput(codexDeviceOut);
    assert.equal(parsedCodexDevice.url, "https://auth.openai.com/codex/device");
    assert.equal(parsedCodexDevice.code, "DIT0-WD3VA");
    assert.equal(parsedCodexDevice.needsCodeInput, false);
  });

  it("extracts actionable failure diagnostics from failed login output", () => {
    const msg = extractLoginFailureMessage(
      "Opening browser to sign in…\nPaste code here if prompted > \n\x1b[31mOAuth error: Invalid or expired authorization code.\x1b[0m\n",
    );
    assert.equal(msg, "OAuth error: Invalid or expired authorization code.");
  });

  it("prepends ~/.local/bin and ~/.nvm node bin directories when probing WSL binaries", async () => {
    let seenCommand = "";
    const resolved = await resolveBinaryInDistro(
      async (_cmd, args) => {
        seenCommand = args.join(" ");
        return { stdout: "/home/aleff/.local/bin/claude\n", stderr: "", exitCode: 0 };
      },
      "ubuntu",
      "claude",
    );
    assert.equal(resolved, "/home/aleff/.local/bin/claude");
    assert.ok(seenCommand.includes("$HOME/.local/bin"));
    assert.ok(seenCommand.includes(".nvm/versions/node"));
    assert.ok(seenCommand.includes("command -v claude"));
  });
});

describe("CLI provider sign-in routes (/api/providers/:id/login and /login/code)", () => {
  it("completes Claude Code WSL sign-in via pasted authorization code and refreshes live subscription models", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-claude-login-"));
    const connection = new FakeConnection();
    let authed = false;
    const captured: { env?: Record<string, string> } = {};
    let pastedStdin = "";

    const claudeUrl =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=state_xyz";

    let srvRef: Awaited<ReturnType<typeof start>>["server"] | null = null;
    try {
      const { base, server } = await start(connection, {
        dataDir,
        platform: "win32",
        runtime: "wsl",
        distro: "ubuntu",
        exec: async (_cmd, args) => {
          const joined = args.join(" ");
          if (joined.includes("-l -v")) {
            return { stdout: "  NAME      STATE           VERSION\n* ubuntu    Running         2\n", stderr: "", exitCode: 0 };
          }
          if (joined.includes("command -v claude")) {
            return { stdout: "/home/aleff/.local/bin/claude\n", stderr: "", exitCode: 0 };
          }
          if (joined.includes("auth status")) {
            return {
              stdout: JSON.stringify(
                authed
                  ? { loggedIn: true, authMethod: "claude.ai", email: "user@example.com", subscriptionType: "max" }
                  : { loggedIn: false },
              ),
              stderr: "",
              exitCode: authed ? 0 : 1,
            };
          }
          return { stdout: "", stderr: "", exitCode: 1 };
        },
        loginSpawn: (_cmd, _args, opts) => {
          captured.env = opts.env;
          const child = makeInteractiveLoginChild();
          child.stdin.on("data", (chunk: Buffer) => {
            const line = chunk.toString("utf8");
            pastedStdin += line;
            if (line === "valid_code_123#state_xyz\n") {
              authed = true;
              child.finish(0);
            } else {
              // Real Claude Code 2.1.x writes to stderr and stays open so the user can retry pasting.
              child.stderr.write("Invalid code. Please make sure the full code was copied.\n");
            }
          });
          setImmediate(() => {
            child.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${claudeUrl}\nPaste code here if prompted > `);
          });
          return child;
        },
        providerHostFactory: (spec) => {
          if (spec.providerId !== "claude") return null;
          const runtime = new CanonicalSessionRuntime({
            providerId: "claude",
            capabilities: capabilitiesForProvider("claude"),
            onStartSession: async (o) => ({ externalSessionId: "ext-1", modelId: o.modelId ?? "opus" }),
            onRunTurn: async () => {},
            onListModels: async () =>
              authed
                ? {
                    source: "providerCatalog",
                    models: [
                      { modelId: "opus", displayLabel: "Opus", description: "Opus 5.5", isDefault: true },
                      { modelId: "fable[1m]", displayLabel: "Fable", description: "Fable 5.1", contextLimit: 1_000_000 },
                      { modelId: "sonnet", displayLabel: "Sonnet", description: "Sonnet 5.5" },
                      { modelId: "haiku", displayLabel: "Haiku", description: "Haiku 5.5" },
                    ],
                  }
                : {
                    source: "bundledCatalog",
                    models: [{ modelId: "claude-sonnet-4-6", displayLabel: "Claude Sonnet 4.6", isDefault: true }],
                  },
          });
          return {
            connection: runtime,
            recentStderr: "",
            onExit() {},
            start: async () => ({
              initializeResult: { serverInfo: { name: "claude-stream-json", version: "2.1.310" } },
              fingerprintWarning: null,
            }),
            close: async () => ({ code: 0, signal: null }),
          };
        },
      });
      srvRef = server;

      const loginRes = await send(base, "/api/providers/claude/login", {});
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.json.status, "waiting");
      assert.equal(loginRes.json.url, claudeUrl);
      assert.equal(loginRes.json.code, null);
      assert.equal(loginRes.json.needsCodeInput, true);
      assert.ok(typeof loginRes.json.loginId === "string" && loginRes.json.loginId.length > 0);
      assert.equal(captured.env?.["BROWSER"], "/bin/true");
      assert.ok(captured.env?.["WSLENV"]?.split(":").includes("BROWSER"));

      const pollRes = await get(base, `/api/providers/claude/login?loginId=${encodeURIComponent(loginRes.json.loginId)}`);
      assert.equal(pollRes.status, "waiting");
      assert.equal(pollRes.url, claudeUrl);
      assert.equal(pollRes.needsCodeInput, true);

      const invalidRes = await send(base, "/api/providers/claude/login/code", {
        loginId: loginRes.json.loginId,
        code: "partial_wrong_code",
      });
      assert.equal(invalidRes.status, 200);
      assert.equal(invalidRes.json.status, "waiting");
      assert.equal(invalidRes.json.message, "Invalid code. Please make sure the full code was copied.");

      const submitRes = await send(base, "/api/providers/claude/login/code", {
        loginId: loginRes.json.loginId,
        code: "  valid_code_123#state_xyz  ",
      });
      assert.equal(submitRes.status, 200);
      assert.equal(submitRes.json.status, "done");
      assert.equal(pastedStdin, "partial_wrong_code\nvalid_code_123#state_xyz\n");

      const modelsRes = await get(base, "/api/models?providerId=claude&refresh=1");
      const catalog = modelsRes.models as { source?: string; models?: { modelId: string }[] };
      assert.equal(catalog?.source, "providerCatalog");
      assert.deepEqual(
        (catalog?.models ?? []).map((m) => m.modelId),
        ["opus", "fable[1m]", "sonnet", "haiku"],
      );
    } finally {
      await srvRef?.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps Codex localhost callback server alive and reports completion once browser redirect finishes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ancilla-codex-login-"));
    const connection = new FakeConnection();
    const codexUrl =
      "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=st_1";
    const codexCaptured: { child?: ReturnType<typeof makeInteractiveLoginChild> } = {};

    let srvRef: Awaited<ReturnType<typeof start>>["server"] | null = null;
    try {
      const { base, server } = await start(connection, {
        dataDir,
        platform: "linux",
        exec: async (_cmd, args) => {
          if (args.join(" ").includes("command -v codex")) {
            return { stdout: "/home/aleff/.local/bin/codex\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "0.164.0\n", stderr: "", exitCode: 0 };
        },
        loginSpawn: () => {
          const child = makeInteractiveLoginChild();
          codexCaptured.child = child;
          setImmediate(() => {
            child.stderr.write(`Starting local login server on http://localhost:1455.\n\n${codexUrl}\n`);
          });
          return child;
        },
      });
      srvRef = server;

      const loginRes = await send(base, "/api/providers/codex/login", {});
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.json.status, "waiting");
      assert.equal(loginRes.json.url, codexUrl);
      assert.equal(loginRes.json.code, null);
      assert.equal(loginRes.json.needsCodeInput, false);
      assert.equal(codexCaptured.child?.killed(), false);

      codexCaptured.child!.finish(0);
      const afterCallback = await get(base, `/api/providers/codex/login?loginId=${encodeURIComponent(loginRes.json.loginId)}`);
      assert.equal(afterCallback.status, "done");
    } finally {
      await srvRef?.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
