import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runBrainReadStep, runBrainWriteStep } from "../src/assistant/brain-step.js";
import type { ExecutiveHost } from "../src/assistant/executive.js";
import { AssistantService } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";
import { awaitsApproval, TERMINAL_TASK } from "../src/assistant/tasks.js";
import { BrowseRunner } from "../src/browser/runner.js";
import { BrowserService } from "../src/browser/service.js";
import { BrowseSites } from "../src/browser/sites.js";
import { AuditLog } from "../src/connectors/audit.js";
import { makeOpener } from "../src/connectors/connection.js";
import { ConnectorRegistry } from "../src/connectors/registry.js";
import { ConnectorRunner } from "../src/connectors/runner.js";
import { FileSecretStore } from "../src/connectors/secrets.js";
import { AssistantVoiceHost, TaskHub } from "../src/voice/assistant-host.js";
import { withTextTools, type BrainEvent, type BrainProvider, type BrainRequest, type ChatMessage } from "../src/voice/brain.js";
import { ConversationStore } from "../src/voice/conversations.js";
import { ManualScheduler } from "../src/voice/scheduler.js";
import { VoiceSession } from "../src/voice/session.js";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/settings.js";
import { FakeAsr, FakeTts, FakeVad, ScriptedBrain, SimClient, type Reply } from "../src/voice/testing.js";
import { fakeBrowser, healthy, type FakeBrowser } from "./browser-fake.js";
import { piece } from "./connectors-fixtures.js";

const T0 = Date.UTC(2026, 10, 11, 15, 0, 0);
const FOUND_BROWSER = { browser: { kind: "edge" as const, path: "/fake/edge" } };

function noMuseHost(projectDir: string, now: () => number): ExecutiveHost {
  return {
    now,
    projectKey: (cwd: string) => cwd,
    hostAvailable: async () => ({ ok: false, reason: "Muse CLI is absent on this machine" }),
    startSession: async () => {
      throw new Error("Muse CLI is absent on this machine");
    },
    startTurn: async () => {
      throw new Error("Muse CLI is absent on this machine");
    },
    interruptTurn: async () => undefined,
    turnState: async () => "absent",
    readProjectFile: async (cwd: string, relPath: string) => {
      const full = join(cwd || projectDir, relPath);
      if (!existsSync(full)) return { exists: false, text: "", size: 0 };
      const text = readFileSync(full, "utf8");
      return { exists: true, text, size: Buffer.byteLength(text, "utf8") };
    },
    needsUser: () => false,
    watch: () => () => undefined,
    log: () => undefined,
  };
}

class TextToolLocalBrain implements BrainProvider {
  readonly id = "local-text-model";
  readonly label = "Local llama.cpp (text tools)";
  readonly capabilities = { tools: false, speculative: false, local: true };
  private step = 0;

  constructor(private readonly outputs: string[]) {}

  async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
    const out = this.outputs[this.step] ?? "All done.";
    this.step += 1;
    if (request.signal.aborted) return;
    yield { type: "text", delta: out };
    yield { type: "done", reason: "stop" };
  }
}

class ScriptedStepBrain implements BrainProvider {
  readonly id = "scripted-step";
  readonly label = "Scripted Step Brain";
  readonly capabilities = { tools: true, speculative: false, local: true };
  private idx = 0;

  constructor(private readonly steps: Array<{ text?: string; calls?: Array<{ name: string; args?: Record<string, unknown> }> }>) {}

  async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
    const step = this.steps[this.idx] ?? { text: "" };
    this.idx += 1;
    if (request.signal.aborted) return;
    if (step.text) yield { type: "text", delta: step.text };
    for (const [i, c] of (step.calls ?? []).entries()) {
      yield { type: "tool", call: { id: `sc_${this.idx}_${i}`, name: c.name, arguments: JSON.stringify(c.args ?? {}) } };
    }
    yield { type: "done", reason: step.calls?.length ? "tool" : "stop" };
  }
}

async function waitUntil(pred: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("end-to-end cross-subsystem interoperability across restarts (without Muse CLI)", () => {
  it("coordinates memory, bilingual voice, screen-gated local-model code edits, OAuth PKCE connectors, and sign-in/upload/download browser sessions across restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "ancilla-interop-"));
    const dataDir = join(root, "data");
    const projectDir = join(root, "atlas-app");
    const uploadSourceDir = join(root, "uploads");
    const downloadDestDir = join(root, "downloads");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(projectDir, "src"), { recursive: true });
    mkdirSync(uploadSourceDir, { recursive: true });
    mkdirSync(downloadDestDir, { recursive: true });

    const healthPath = join(projectDir, "src", "health.mjs");
    writeFileSync(healthPath, 'export const healthStatus = "legacy-v1";\n');
    const uploadFile = join(uploadSourceDir, "release-manifest.json");
    writeFileSync(uploadFile, JSON.stringify({ release: "2026.11", verified: true }));

    const ACCESS_INITIAL = piece("ya29.", "interop_initial_token_0123456789abcdef");
    const ACCESS_REFRESHED = piece("ya29.", "interop_refreshed_token_9876543210fedcba");
    const REFRESH_TOKEN = piece("1//", "interop_refresh_token_0123456789abcdef");
    const CLIENT_SECRET = piece("GOCSPX-", "interop_client_secret_1234567890");
    let pkceChallenge = "";
    let oauthRefreshCount = 0;
    const validAccessTokens = new Set<string>([ACCESS_INITIAL]);

    const fakeProviderFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const auth = new Headers(init?.headers).get("authorization") ?? "";

      if (url === "https://oauth2.googleapis.com/token") {
        const params = new URLSearchParams(String(init?.body ?? ""));
        if (params.get("grant_type") === "authorization_code") {
          const verifier = params.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          assert.equal(challenge, pkceChallenge, "PKCE S256 verifier matches");
          return new Response(
            JSON.stringify({
              access_token: ACCESS_INITIAL,
              refresh_token: REFRESH_TOKEN,
              expires_in: 3600,
              scope: "https://www.googleapis.com/auth/gmail.readonly",
              token_type: "Bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (params.get("grant_type") === "refresh_token") {
          oauthRefreshCount += 1;
          assert.equal(params.get("refresh_token"), REFRESH_TOKEN);
          validAccessTokens.delete(ACCESS_INITIAL);
          validAccessTokens.add(ACCESS_REFRESHED);
          return new Response(
            JSON.stringify({
              access_token: ACCESS_REFRESHED,
              expires_in: 3600,
              token_type: "Bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
      if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/profile")) {
        const bearer = auth.replace(/^Bearer\s+/i, "");
        if (!validAccessTokens.has(bearer)) {
          return new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), { status: 401 });
        }
        return new Response(JSON.stringify({ emailAddress: "ops@atlas.example", messagesTotal: 19 }), {
          status: 200,
          headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    try {
      let nowMs = T0;
      const dbPath = join(dataDir, "assistant.db");

      // ========================================================================================================
      // PHASE 1 (Session 1 before restart):
      // - Save standing constraint in persistent SQLite MemoryStore
      // - Complete Gmail OAuth 2.0 + PKCE loopback flow (`0o600` secret persistence)
      // - Bilingual voice turn recalls standing constraint -> proposes code change -> screen approval ->
      //   model-agnostic `runBrainWriteStep` (via `withTextTools` on a non-tool local model!) edits `src/health.mjs`
      //   and runs `node --check src/health.mjs` -> verified completion!
      // ========================================================================================================
      const store1 = MemoryStore.open(dbPath, { now: () => nowMs });
      store1.saveProfile({ name: "Ancilla", enabled: true, policy: { allowProjectWrites: true } });
      store1.remember({
        kind: "constraint",
        text: "In atlas-app, healthStatus in src/health.mjs must always be set to healthy-v2.",
      });

      const audit1 = new AuditLog(join(dataDir, "connectors-audit.jsonl"));
      const secrets1 = new FileSecretStore(join(dataDir, "secrets.json"), () => nowMs);
      const registry1 = new ConnectorRegistry({
        file: join(dataDir, "connectors.json"),
        secrets: secrets1,
        audit: audit1,
        open: makeOpener("interop", fakeProviderFetch),
        fetchImpl: fakeProviderFetch,
        now: () => nowMs,
      });
      registry1.setOAuthClient("gmail", { clientId: "atlas-desktop-client", clientSecret: CLIENT_SECRET });
      const oauthStart = await registry1.startOAuth("gmail");
      pkceChallenge = new URL(oauthStart.authorizeUrl).searchParams.get("code_challenge") ?? "";
      const cbRes = await fetch(`${oauthStart.redirectUri}?code=code_interop_1&state=${encodeURIComponent(oauthStart.state)}`);
      assert.equal(cbRes.status, 200);
      assert.equal(registry1.view("gmail").connected, true);

      // Local non-tool model wrapped in `withTextTools` drives `runBrainWriteStep` without Muse CLI!
      const localWriteBrain = withTextTools(
        new TextToolLocalBrain([
          '[[read_file {"path":"src/health.mjs"}]]',
          '[[edit_file {"path":"src/health.mjs","old_text":"legacy-v1","new_text":"healthy-v2"}]]\n[[run_check {"program":"node","args":["--check","src/health.mjs"]}]]',
          "Updated healthStatus to healthy-v2 and verified syntax with node --check.",
        ]),
      );

      const hub1 = new TaskHub();
      const assistant1 = new AssistantService(store1, {
        log: () => undefined,
        emit: (ev) => {
          if (ev.taskId) hub1.emit({ taskId: ev.taskId });
        },
        now: () => nowMs,
        host: noMuseHost(projectDir, () => nowMs),
        fallbackRead: {
          available: () => ({ ok: true, label: localWriteBrain.label }),
          run: ({ cwd, prompt, signal }) => runBrainReadStep({ brain: localWriteBrain, root: cwd, prompt, signal }),
        },
        fallbackWrite: {
          available: () => ({ ok: true, label: localWriteBrain.label }),
          run: ({ cwd, prompt, signal }) => runBrainWriteStep({ brain: localWriteBrain, root: cwd, prompt, signal }),
        },
      });

      const conversations1 = new ConversationStore(store1, () => nowMs);
      const conversationId = conversations1.create(projectDir);
      const voiceHost1 = new AssistantVoiceHost({
        assistant: assistant1,
        conversations: conversations1,
        conversationId,
        settings: () => DEFAULT_VOICE_SETTINGS,
        hub: hub1,
        project: () => projectDir,
        log: () => undefined,
      });

      const sched1 = new ManualScheduler(nowMs);
      const voiceSentences1: Record<number, string> = {
        1: "Pode atualizar healthStatus em src/health.mjs conforme nossa regra?",
      };
      const voiceBrain1 = new ScriptedBrain(sched1, (messages: ChatMessage[]): Reply => {
        const last = messages[messages.length - 1];
        if (last?.role === "tool" && last.name === "propose_change") {
          return { ttftMs: 60, text: "Coloquei a proposta na sua tela para aprovação." };
        }
        const userMsg = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
        assert.ok(userMsg.includes("healthy-v2"), "persistent standing rule was injected into the voice turn");
        return {
          ttftMs: 60,
          tool: {
            name: "propose_change",
            args: {
              title: "Set healthStatus to healthy-v2",
              goal: "Update healthStatus in src/health.mjs to healthy-v2 and verify syntax.",
            },
          },
        };
      });

      let session1!: VoiceSession;
      const client1 = new SimClient(sched1, () => session1);
      session1 = new VoiceSession({
        engines: {
          vad: new FakeVad(),
          asr: new FakeAsr(voiceSentences1, sched1, 15),
          tts: new FakeTts(sched1, { msPerChar: 30, latencyMs: 20 }),
        },
        brain: voiceBrain1,
        host: voiceHost1,
        scheduler: sched1,
        send: (m) => client1.receive(m),
        sendAudio: (b) => client1.receiveAudio(b),
        log: () => undefined,
      });

      await session1.start({ type: "hello", v: 1, mode: "hands-free", lang: null, echoCancelled: true, resume: null, thread: conversationId });
      await client1.speak(1, 1300);
      await client1.quiet(100);
      assert.ok(await client1.until(() => session1.snapshot().agent === "idle" && client1.of("speak_end").length >= 1, 20_000));

      const proposal = assistant1.tasks.list("all")[0];
      assert.ok(proposal, "voice call created a screen-gated write proposal");
      assert.equal(awaitsApproval(proposal), true);
      assert.equal(readFileSync(healthPath, "utf8"), 'export const healthStatus = "legacy-v1";\n', "file untouched before screen approval");

      // Approve on screen -> fallbackWrite (`runBrainWriteStep`) edits `src/health.mjs` and runs `node --check`!
      assistant1.executive!.approve(proposal.id);
      await assistant1.executive!.tick();
      await waitUntil(() => TERMINAL_TASK.has(assistant1.tasks.require(proposal.id).status), "fallbackWrite completion");

      const finishedProposal = assistant1.tasks.require(proposal.id);
      assert.ok(
        finishedProposal.status === "completed" || finishedProposal.status === "unverified",
        `expected completed/unverified, got ${finishedProposal.status}: ${finishedProposal.reason}`,
      );
      assert.equal(readFileSync(healthPath, "utf8"), 'export const healthStatus = "healthy-v2";\n');
      assert.match(finishedProposal.result, /Changed files: src\/health\.mjs/);
      assert.match(finishedProposal.result, /Checks: node --check src\/health\.mjs \(exit 0\)/);

      await session1.close("restarting app");
      assistant1.close();
      registry1.close();

      // ========================================================================================================
      // PHASE 2 (Simulated application restart + 1 hour elapsed so OAuth access token is expired):
      // - Reopen SQLite `assistant.db`, `connectors.json`, `secrets.json`, `browser-sites.json`
      // - Verify conversation history survived restart
      // - Run `use_connector` on Gmail -> auto-refreshes OAuth token without re-authenticating and reads profile!
      // - Run integrated browser session: `you` sign-in cookie -> `always-signed-in` rule hydrates `assistant`
      //   context -> `<input type="file">` upload gated by `uploadGate` -> download gated by `downloadGate`!
      // ========================================================================================================
      nowMs += 3700 * 1000;

      const store2 = MemoryStore.open(dbPath, { now: () => nowMs });
      const audit2 = new AuditLog(join(dataDir, "connectors-audit.jsonl"));
      const secrets2 = new FileSecretStore(join(dataDir, "secrets.json"), () => nowMs);
      const registry2 = new ConnectorRegistry({
        file: join(dataDir, "connectors.json"),
        secrets: secrets2,
        audit: audit2,
        open: makeOpener("interop", fakeProviderFetch),
        fetchImpl: fakeProviderFetch,
        now: () => nowMs,
      });
      const connectorRunner2 = new ConnectorRunner({
        registry: registry2,
        brain: () => ({
          brain: new ScriptedStepBrain([
            { calls: [{ name: "get_profile", args: {} }] },
            { calls: [{ name: "done", args: { answer: "Mailbox ops@atlas.example has 19 messages." } }] },
          ]),
          problem: null,
        }),
        log: () => undefined,
      });

      let fakeCdp!: FakeBrowser;
      fakeCdp = fakeBrowser(
        healthy((method, params, sessionId) => {
          if (method === "Storage.getCookies" && !params["browserContextId"]) {
            return {
              cookies: [
                {
                  name: "portal_sid",
                  value: "persisted_user_cookie",
                  domain: "portal.example",
                  path: "/",
                  secure: true,
                  httpOnly: true,
                  expires: -1,
                },
              ],
            };
          }
          if (method === "Page.navigate" && sessionId) {
            setImmediate(() => {
              fakeCdp.emit("Page.loadEventFired", { timestamp: 1 }, sessionId);
            });
            return { frameId: sessionId.replace(/^S-/, ""), loaderId: "L-nav" };
          }
          return undefined;
        }),
      );

      const hub2 = new TaskHub();
      let browseRunner2!: BrowseRunner;
      let browserSvc2!: BrowserService;
      const sites2 = new BrowseSites(join(dataDir, "browser-sites.json"), () => browseRunner2);
      browseRunner2 = new BrowseRunner({
        service: () => browserSvc2,
        brain: () => ({
          brain: new ScriptedStepBrain([
            { calls: [{ name: "open", args: { url: "https://portal.example/upload" } }] },
            { calls: [{ name: "done", args: { answer: "Portal upload page verified." } }] },
          ]),
          problem: null,
        }),
        gate: sites2.gate,
        log: () => undefined,
      });
      browserSvc2 = new BrowserService({
        dataDir: join(dataDir, "browser"),
        find: () => FOUND_BROWSER,
        launch: () => fakeCdp.proc,
        gracefulMs: 200,
        siteGate: (req) => sites2.decide(req),
        signInGate: (req) => sites2.shouldShareSignIn(req),
        commitGate: (req) => sites2.decideCommit(req),
        downloadGate: (dl) => sites2.decideDownload(dl),
        uploadGate: (up) => sites2.decideUpload(up),
        log: () => undefined,
      });

      const assistant2 = new AssistantService(store2, {
        log: () => undefined,
        emit: (ev) => {
          if (ev.taskId) hub2.emit({ taskId: ev.taskId });
        },
        now: () => nowMs,
        host: noMuseHost(projectDir, () => nowMs),
        browse: browseRunner2,
        connector: connectorRunner2,
      });

      const conversations2 = new ConversationStore(store2, () => nowMs);
      const voiceHost2 = new AssistantVoiceHost({
        assistant: assistant2,
        conversations: conversations2,
        conversationId,
        settings: () => DEFAULT_VOICE_SETTINGS,
        hub: hub2,
        project: () => projectDir,
        browse: browseRunner2,
        connectors: {
          usable: () => registry2.usable().map((id) => ({ id, name: registry2.view(id).name })),
          available: (id) => connectorRunner2.available(id),
        },
        log: () => undefined,
      });

      // Verify conversation continuity across restart!
      const resumedHistory = voiceHost2.history(conversationId);
      assert.ok(resumedHistory.length >= 2, "prior voice turns survived restart in SQLite");

      // 1. Trigger Gmail connector task via voice host -> auto-refreshes expired OAuth token and completes!
      const connToolRes = await voiceHost2.runTool(
        {
          id: "tc_gmail",
          name: "use_connector",
          arguments: JSON.stringify({ connector: "gmail", goal: "Check mailbox message count", title: "Gmail check" }),
        },
        { turn: 2, signal: new AbortController().signal },
      );
      assert.equal(connToolRes.ok, true, connToolRes.text);
      const gmailTask = assistant2.tasks.list("all").find((t) => t.origin === "connector");
      assert.ok(gmailTask);
      await waitUntil(() => assistant2.tasks.require(gmailTask.id).status === "completed", "Gmail connector task completion");
      assert.equal(oauthRefreshCount, 1, "expired OAuth token refreshed automatically after restart");
      assert.match(assistant2.tasks.require(gmailTask.id).result, /ops@atlas\.example has 19 messages/);

      // 2. Start `browse` task from voice host -> answer `always-signed-in` -> verify one-way cookie hydration!
      const browseToolRes = await voiceHost2.runTool(
        {
          id: "tc_browse",
          name: "browse",
          arguments: JSON.stringify({ goal: "Open portal upload page and check status", title: "Portal check" }),
        },
        { turn: 3, signal: new AbortController().signal },
      );
      assert.equal(browseToolRes.ok, true, browseToolRes.text);
      const webTask = assistant2.tasks.list("all").find((t) => t.origin === "browse");
      assert.ok(webTask);

      // Simulate CDP request pause on main-frame navigation so `siteGate` & `signInGate` run cleanly!
      // Wait: `BrowseRunner` calls `surface.open("https://portal.example/upload")`, which calls `siteGate` via `Fetch.requestPaused`
      // OR let's check if `BrowseRunner` checks `gate.request` directly before `surface.open`!
      await waitUntil(
        () => sites2.gate.pending()?.type === "site" || assistant2.tasks.require(webTask.id).status === "completed",
        "site approval question or completion",
      );
      if (sites2.gate.pending()?.type === "site") {
        browseRunner2.answer(webTask.id, "always-signed-in");
      }
      await waitUntil(() => assistant2.tasks.require(webTask.id).status === "completed", "web task completion");
      assert.equal(sites2.rules.get("https://portal.example")?.useSignIn, true, "always-signed-in rule persisted");

      // 3. Reopen `BrowseSites` from disk (`browser-sites.json`) and verify sign-in cookie hydration + `<input type="file">` upload + download!
      const manualTaskId = "tsk_portal_io";
      const sitesIo = new BrowseSites(join(dataDir, "browser-sites.json"), () => ({
        taskId: () => manualTaskId,
        gateChanged: () => undefined,
      }));
      assert.equal(
        sitesIo.shouldShareSignIn({ url: "https://portal.example/upload", origin: "https://portal.example", tabId: "T1", mainFrame: true }),
        true,
        "always-signed-in rule reloaded from disk across restart",
      );

      let browserSvcIo!: BrowserService;
      const ioRunner = new BrowseRunner({
        service: () => browserSvcIo,
        brain: () => ({ brain: null as never, problem: "unused" }),
        gate: sitesIo.gate,
        log: () => undefined,
      });
      const fakeIo = fakeBrowser(
        healthy((method, params) => {
          if (method === "Storage.getCookies" && !params["browserContextId"]) {
            return {
              cookies: [
                {
                  name: "portal_sid",
                  value: "persisted_user_cookie",
                  domain: "portal.example",
                  path: "/",
                  secure: true,
                  httpOnly: true,
                  expires: -1,
                },
              ],
            };
          }
          return undefined;
        }),
      );
      browserSvcIo = new BrowserService({
        dataDir: join(dataDir, "browser-io"),
        find: () => FOUND_BROWSER,
        launch: () => fakeIo.proc,
        gracefulMs: 200,
        siteGate: (req) => sitesIo.decide(req),
        signInGate: (req) => sitesIo.shouldShareSignIn(req),
        uploadGate: (up) => sitesIo.decideUpload(up),
        downloadGate: (dl) => sitesIo.decideDownload(dl),
        log: () => undefined,
      });

      const aiTab = await browserSvcIo.openTab("assistant");
      fakeIo.emit("Target.targetInfoChanged", {
        targetInfo: { targetId: aiTab.id, type: "page", url: "https://portal.example/upload", title: "Upload" },
      });
      // Trigger main-frame Fetch.requestPaused on assistant tab to verify cookie hydration from `you` -> `assistant`!
      fakeIo.emit(
        "Fetch.requestPaused",
        {
          requestId: "req-portal-1",
          frameId: aiTab.id,
          resourceType: "Document",
          request: { url: "https://portal.example/upload", method: "GET", headers: {} },
        },
        `S-${aiTab.id}`,
      );
      await waitUntil(() => fakeIo.calls.some((c) => c.method === "Storage.setCookies"), "Storage.setCookies hydrated sign-in cookie");

      // Controlled upload via `Page.fileChooserOpened` -> `ioRunner.answerAction(..., "do", undefined, [uploadFile])`
      fakeIo.emit("Page.fileChooserOpened", { mode: "selectSingle", backendNodeId: 55 }, `S-${aiTab.id}`);
      await waitUntil(() => sitesIo.gate.pending()?.type === "action", "assistant upload gate pending");
      ioRunner.answerAction(manualTaskId, "do", undefined, [uploadFile]);
      await browserSvcIo.waitLoaded(aiTab.id, 2000);
      const uploadCdp = fakeIo.calls.find((s) => s.method === "DOM.setFileInputFiles");
      assert.deepEqual(uploadCdp?.params, { files: [uploadFile], backendNodeId: 55 });

      // Controlled download via `Browser.downloadWillBegin` + `Browser.downloadProgress` -> saved into `downloadDestDir`
      writeFileSync(join(browserSvcIo.downloads.dir, "dl-guid-1"), "Receipt #2026-OK\n");
      fakeIo.emit("Browser.downloadWillBegin", {
        guid: "dl-guid-1",
        frameId: aiTab.id,
        url: "https://portal.example/receipt.txt",
        suggestedFilename: "receipt.txt",
      });
      fakeIo.emit("Browser.downloadProgress", { guid: "dl-guid-1", totalBytes: 17, receivedBytes: 17, state: "completed" });
      await waitUntil(() => sitesIo.gate.pending()?.type === "action", "assistant download gate pending");
      ioRunner.answerAction(manualTaskId, "do", downloadDestDir);
      await waitUntil(() => existsSync(join(downloadDestDir, "receipt.txt")), "downloaded receipt moved to chosen folder");
      assert.equal(readFileSync(join(downloadDestDir, "receipt.txt"), "utf8"), "Receipt #2026-OK\n");

      await browserSvcIo.dispose();
      await browserSvc2.dispose();
      assistant2.close();
      registry2.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
