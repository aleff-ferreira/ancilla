import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { AncillaStore } from "@ancilla/daemon";
import { FileSecretStore } from "../src/connectors/secrets.js";
import { ProfileIsolator, detectAmbientKeyOverrides } from "../src/providers/profiles.js";

// Works from both `packages/server/test` and compiled `packages/server/dist/test`.
const REPO_ROOT = __dirname.includes(join("dist", "test"))
  ? resolve(__dirname, "..", "..", "..", "..")
  : resolve(__dirname, "..", "..", "..");

function collectTypeScriptFiles(rootDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTypeScriptFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("legal and ToS boundaries across multi-provider drivers", () => {
  it("never references or opens private third-party OAuth credential files or keychain stores in provider source code", () => {
    const dirs = [
      join(REPO_ROOT, "packages", "daemon", "src", "providers"),
      join(REPO_ROOT, "packages", "server", "src", "providers"),
    ];
    const files = dirs.flatMap(collectTypeScriptFiles);
    assert.ok(files.length >= 8, "expected provider source files to be scanned");

    const forbiddenPatterns: { label: string; regex: RegExp }[] = [
      { label: "Claude private OAuth store (.credentials.json)", regex: /\.credentials\.json/i },
      { label: "Gemini private OAuth store (oauth_creds.json)", regex: /oauth_creds\.json/i },
      { label: "CLI auth token file (auth.json)", regex: /\bauth\.json\b/i },
      { label: "Copilot private host token files (hosts.json / apps.json)", regex: /\b(?:hosts|apps)\.json\b/i },
      { label: "macOS Keychain scraping", regex: /find-generic-password/i },
      { label: "Linux libsecret scraping", regex: /secret-tool\s+lookup/i },
      { label: "Windows DPAPI decryption", regex: /CryptUnprotectData/i },
    ];

    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const forbidden of forbiddenPatterns) {
        assert.equal(
          forbidden.regex.test(code),
          false,
          `Forbidden pattern (${forbidden.label}) found in ${file}`,
        );
      }
    }
  });

  it("strips ambient pay-per-token API keys by default when launching subscription CLI profiles", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ancilla-legal-profiles-"));
    try {
      const isolator = new ProfileIsolator(tempDir, new FileSecretStore(join(tempDir, "secrets.json")));
      const dirtyEnv: NodeJS.ProcessEnv = {
        PATH: "/usr/local/bin:/usr/bin",
        OPENAI_API_KEY: "sk-openai-ambient-should-strip",
        ANTHROPIC_API_KEY: "sk-ant-ambient-should-strip",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-ambient-should-strip",
        GEMINI_API_KEY: "AIza-gemini-ambient-should-strip",
        GOOGLE_API_KEY: "AIza-google-ambient-should-strip",
        GITHUB_TOKEN: "ghp_ambient_should_strip",
        GH_TOKEN: "ghp_gh_ambient_should_strip",
        COPILOT_GITHUB_TOKEN: "ghu_copilot_ambient_should_strip",
        WSLENV: "OPENAI_API_KEY:ANTHROPIC_API_KEY:GEMINI_API_KEY:KEEP_VAR/p",
      };

      assert.deepEqual(detectAmbientKeyOverrides("codex", dirtyEnv), ["OPENAI_API_KEY"]);
      assert.deepEqual(detectAmbientKeyOverrides("claude", dirtyEnv), ["ANTHROPIC_API_KEY"]);
      assert.deepEqual(detectAmbientKeyOverrides("gemini", dirtyEnv), [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
      ]);
      assert.deepEqual(detectAmbientKeyOverrides("copilot", dirtyEnv), [
        "COPILOT_GITHUB_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
      ]);

      const codexEnv = isolator.buildCliEnv({
        providerId: "codex",
        accountId: "work-chatgpt",
        baseEnv: dirtyEnv,
      });
      assert.equal(codexEnv["OPENAI_API_KEY"], undefined);
      assert.ok(codexEnv["CODEX_HOME"]?.includes("work-chatgpt"));
      assert.equal(codexEnv["WSLENV"]?.includes("OPENAI_API_KEY"), false);
      assert.equal(codexEnv["WSLENV"]?.includes("KEEP_VAR/p"), true);

      const claudeEnv = isolator.buildCliEnv({
        providerId: "claude",
        accountId: "personal-max",
        baseEnv: dirtyEnv,
      });
      assert.equal(claudeEnv["ANTHROPIC_API_KEY"], undefined);
      assert.ok(claudeEnv["CLAUDE_CONFIG_DIR"]?.includes("personal-max"));

      const geminiEnv = isolator.buildCliEnv({
        providerId: "gemini",
        accountId: "ai-pro",
        baseEnv: dirtyEnv,
      });
      assert.equal(geminiEnv["GEMINI_API_KEY"], undefined);
      assert.equal(geminiEnv["GOOGLE_API_KEY"], undefined);
      assert.ok(geminiEnv["GEMINI_CLI_HOME"]?.includes("ai-pro"));

      const copilotEnv = isolator.buildCliEnv({
        providerId: "copilot",
        accountId: "enterprise-gh",
        baseEnv: dirtyEnv,
      });
      assert.equal(copilotEnv["GITHUB_TOKEN"], undefined);
      assert.equal(copilotEnv["GH_TOKEN"], undefined);
      assert.equal(copilotEnv["COPILOT_GITHUB_TOKEN"], undefined);
      assert.ok(copilotEnv["COPILOT_HOME"]?.includes("enterprise-gh"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps BYOK API keys in a mode-0600 secret store and never writes raw secrets to ancilla.db", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ancilla-legal-secrets-"));
    try {
      const dbPath = join(tempDir, "ancilla.db");
      const secretsPath = join(tempDir, "provider-secrets.json");
      const store = new AncillaStore(dbPath);
      const secrets = new FileSecretStore(secretsPath);
      const isolator = new ProfileIsolator(tempDir, secrets);

      const rawKey = "sk-live-super-secret-byok-987654321";
      const secretKeyId = isolator.setApiKey("openrouter-1", rawKey);
      const account = store.upsertProviderAccount({
        id: "openrouter-1",
        providerId: "api",
        name: "OpenRouter BYOK",
        apiKind: "openai",
        apiBaseUrl: "https://openrouter.ai/api/v1",
        defaultModelId: "openai/gpt-5.4",
        secretKeyId,
      });

      assert.equal(isolator.resolveApiKey(account), rawKey);
      store.close();

      if (process.platform !== "win32") {
        const mode = statSync(secretsPath).mode & 0o777;
        assert.equal(mode, 0o600, "provider-secrets.json must be owner-only (0600)");
      }

      const sqliteBytes = readFileSync(dbPath, "utf8");
      assert.equal(sqliteBytes.includes(rawKey), false, "raw API key must never appear in ancilla.db");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("probes CLI sign-in status strictly via official CLI subcommands without reading token files", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ancilla-legal-probe-"));
    try {
      const isolator = new ProfileIsolator(tempDir, null);
      const seenCommands: { cmd: string; args: string[] }[] = [];

      const claudeStatus = await isolator.probeAuthStatus({
        providerId: "claude",
        accountId: "team-1",
        binaryAvailable: true,
        binaryPath: "/usr/local/bin/claude",
        runtime: "native",
        platform: "linux",
        exec: async (cmd, args) => {
          seenCommands.push({ cmd, args });
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              loggedIn: true,
              email: "dev@example.com",
              subscriptionType: "max",
              authMethod: "claude.ai",
            }),
            stderr: "",
          };
        },
      });

      assert.equal(claudeStatus.state, "authenticated");
      assert.equal(claudeStatus.email, "dev@example.com");
      assert.equal(claudeStatus.planTier, "max");
      assert.deepEqual(seenCommands[0], {
        cmd: "/usr/local/bin/claude",
        args: ["auth", "status", "--json"],
      });

      const codexStatus = await isolator.probeAuthStatus({
        providerId: "codex",
        accountId: "plus-1",
        binaryAvailable: true,
        binaryPath: "/usr/local/bin/codex",
        runtime: "native",
        platform: "linux",
        exec: async (cmd, args) => {
          seenCommands.push({ cmd, args });
          return {
            exitCode: 0,
            stdout: "Logged in using ChatGPT",
            stderr: "",
          };
        },
      });

      assert.equal(codexStatus.state, "authenticated");
      assert.equal(codexStatus.authMethod, "chatgpt");
      assert.deepEqual(seenCommands[1], {
        cmd: "/usr/local/bin/codex",
        args: ["login", "status"],
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
