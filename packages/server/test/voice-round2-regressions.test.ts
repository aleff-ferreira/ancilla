import assert from "node:assert/strict";
import fsSync from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HostStartTimeoutError, type ServeTarget } from "@ancilla/daemon";
import { AssistantService } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";
import { META_MUSE_CODE_MODEL_IDS } from "../src/providers/museCatalog.js";
import { resolveUserPath } from "../src/paths.js";
import { AncillaServer, type HostHandle } from "../src/server.js";
import { AssistantVoiceHost, TaskHub } from "../src/voice/assistant-host.js";
import { ConversationStore } from "../src/voice/conversations.js";
import { SherpaAsr } from "../src/voice/engines/asr.js";
import { groundUtterance } from "../src/voice/grounding.js";
import { normalizeSpokenTechnical } from "../src/voice/normalize.js";
import { DEFAULT_VOICE_SETTINGS } from "../src/voice/settings.js";
import { FakeConnection, start } from "./harness.js";

/**
 * Installs a deterministic mock `sherpa-onnx-node` package inside `runtimeDir/node_modules/sherpa-onnx-node`
 * so `SherpaAsr` spawns the real compiled `asr-worker.js` worker thread over `node:worker_threads`.
 *
 * Sample encoding convention for test waveforms:
 *  - `samples[0] === 0.25`: stretch 1 audio -> streaming emits `"Glad us check first stretch."`, holds back `"alpha"` until `inputFinished()`.
 *    Offline Parakeet reads `"GlaDOS, check first stretch alpha."`.
 *  - `samples[0] === 0.35`: stretch 2 audio -> streaming emits `"package slash server"`, holds back `"ts"` until `inputFinished()`.
 *    Offline Parakeet reads `"packager slash server.tis"`.
 *  - `samples[0] === 0`: silence / `TAIL_SAMPLES`.
 */
async function createMockSherpaRuntime(options: { throwOnHotwords?: boolean } = {}): Promise<{
  runtimeDir: string;
  stateFile: string;
  cleanup: () => Promise<void>;
}> {
  const runtimeDir = await mkdtemp(join(tmpdir(), "ancilla-mock-sherpa-"));
  const pkgDir = join(runtimeDir, "node_modules", "sherpa-onnx-node");
  await mkdir(pkgDir, { recursive: true });
  const stateFile = join(runtimeDir, "worker-events.jsonl");

  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "sherpa-onnx-node", version: "1.0.0-mock", main: "index.js" }),
    "utf8",
  );

  const mockScript = `
const fs = require("node:fs");
const stateFile = ${JSON.stringify(stateFile)};
const throwOnHotwords = ${JSON.stringify(Boolean(options.throwOnHotwords))};

function record(event) {
  fs.appendFileSync(stateFile, JSON.stringify(event) + "\\n", "utf8");
}

let streamSeq = 0;

class MockOnlineStream {
  constructor() {
    this.id = ++streamSeq;
    this.options = {};
    this.tags = [];
    this.finishedCalls = 0;
    this.readyDecode = false;
    this.flushed = false;
    record({ type: "stream_created", id: this.id });
  }
  setOption(key, value) {
    if (key === "hotwords" && throwOnHotwords) {
      record({ type: "hotwords_threw", id: this.id });
      throw new Error("onlineStreamSetOption: unsupported key hotwords");
    }
    this.options[key] = value;
    record({ type: "set_option", id: this.id, key, value });
  }
  acceptWaveform({ samples }) {
    if (!samples || samples.length === 0) return;
    const tag = Math.round((samples[0] || 0) * 100);
    if (tag === 25 && !this.tags.includes(25)) {
      this.tags.push(25);
      this.readyDecode = true;
    } else if (tag === 35 && !this.tags.includes(35)) {
      this.tags.push(35);
      this.readyDecode = true;
    } else if (tag === 45 && !this.tags.includes(45)) {
      this.tags.push(45);
      this.readyDecode = true;
    }
  }
  inputFinished() {
    this.finishedCalls += 1;
    this.flushed = true;
    this.readyDecode = true;
    record({ type: "input_finished", id: this.id, count: this.finishedCalls });
  }
}

class OnlineRecognizer {
  createStream() {
    return new MockOnlineStream();
  }
  isReady(stream) {
    return stream.readyDecode;
  }
  decode(stream) {
    stream.readyDecode = false;
  }
  getResult(stream) {
    const parts = [];
    if (stream.tags.includes(25)) {
      parts.push(stream.flushed ? "Glad us check first stretch alpha." : "Glad us check first stretch.");
    }
    if (stream.tags.includes(35)) {
      parts.push(stream.flushed ? "package slash server ts" : "package slash server");
    }
    if (stream.tags.includes(45)) {
      parts.push(stream.flushed ? "open package slash server" : "open package slash");
    }
    const text = parts.join(" ");
    return {
      text,
      tokens: text ? text.split(/\\s+/) : [],
      ys_log_probs: text ? text.split(/\\s+/).map(() => -0.15) : [],
    };
  }
}

class OfflineRecognizer {
  createStream() {
    return { samples: new Float32Array(0), acceptWaveform({ samples }) { this.samples = samples; } };
  }
  decode(_stream) {}
  getResult(stream) {
    let has25 = false;
    let has35 = false;
    let has45 = false;
    for (let i = 0; i < stream.samples.length; i += 4000) {
      const tag = Math.round((stream.samples[i] || 0) * 100);
      if (tag === 25) has25 = true;
      if (tag === 35) has35 = true;
      if (tag === 45) has45 = true;
    }
    const parts = [];
    if (has25) parts.push("Gladys, check first stretch alpha.");
    if (has35) parts.push("packager slash server.tis.");
    if (has45) parts.push("open.");
    const text = parts.join(" ");
    return {
      text,
      tokens: text ? text.split(/\\s+/) : [],
      ys_log_probs: text ? text.split(/\\s+/).map(() => -0.08) : [],
    };
  }
}

module.exports = { OnlineRecognizer, OfflineRecognizer };
`;

  await writeFile(join(pkgDir, "index.js"), mockScript, "utf8");
  return {
    runtimeDir,
    stateFile,
    cleanup: () => rm(runtimeDir, { recursive: true, force: true }),
  };
}

function taggedSamples(value: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * 16_000));
  out.fill(value);
  return out;
}

describe("Round 2 voice audit regressions", () => {
  it("preserves complete streamingText across >20s rollover and snapshotHit: true while flushing each stream at most once", async (t) => {
    const mock = await createMockSherpaRuntime();
    t.after(mock.cleanup);

    const asr = new SherpaAsr({
      runtimeDir: mock.runtimeDir,
      streamingDir: join(mock.runtimeDir, "streaming"),
      finalDir: join(mock.runtimeDir, "offline"),
      threads: 1,
      finalThreads: 1,
    });
    t.after(() => asr.dispose());

    // 1. Sub-20s utterance hitting non-destructive Parakeet snapshot (`snapshotHit: true`):
    // `finish()` must still flush `TAIL_SAMPLES` + `inputFinished()` once so the held-back word ("ts") is in `streamingText`.
    const s1 = await asr.open("en-US", { vocabulary: ["GlaDOS", "packages/server.ts", "GlaDOS"] });
    s1.accept(taggedSamples(0.35, 1.2));
    await s1.flush?.();
    await new Promise((r) => setTimeout(r, 35));
    const r1 = await s1.finish();
    s1.dispose();

    assert.equal(r1.snapshotHit, true, "reused flush() snapshot without re-running offline Parakeet");
    assert.equal(r1.refineMs, 0);
    assert.equal(r1.text, "packager slash server.tis.");
    assert.equal(r1.streamingText, "package slash server ts", "flushed held-back streaming word even on snapshotHit: true");

    // 2. Multi-stretch >20s utterance crossing `ROLLOVER_SAMPLES` (20 * 16000) followed by a second offline-refined stretch:
    // `closeStretch()` saves pre-rollover streaming words in `streamingRead`, and `finish()` joins all stretches cleanly.
    const s2 = await asr.open("en-US", { vocabulary: ["GlaDOS", "packages/server.ts"] });
    s2.accept(taggedSamples(0.25, 20.5));
    await s2.flush?.();
    await new Promise((r) => setTimeout(r, 45));
    s2.accept(taggedSamples(0.35, 1.5));
    const r2 = await s2.finish();
    s2.dispose();

    assert.equal(r2.snapshotHit, false);
    assert.equal(asr.lastResult?.segments, 2);
    assert.equal(r2.text, "Gladys, check first stretch alpha packager slash server.tis.");
    assert.equal(
      r2.streamingText,
      "Glad us check first stretch alpha package slash server ts",
      "retained pre-rollover streaming words and flushed final stretch words",
    );

    // 3. Rollover (>20s) followed immediately by finish() with zero post-rollover audio (`item.total === 0`):
    // `streamingText` must still retain the closed stretch's flushed streaming words without re-flushing an empty stream.
    const sRolloverOnly = await asr.open("en-US", { vocabulary: ["GlaDOS"] });
    sRolloverOnly.accept(taggedSamples(0.25, 20.5));
    await sRolloverOnly.flush?.();
    await new Promise((r) => setTimeout(r, 45));
    const rRolloverOnly = await sRolloverOnly.finish();
    sRolloverOnly.dispose();
    assert.equal(rRolloverOnly.text, "Gladys, check first stretch alpha.");
    assert.equal(rRolloverOnly.streamingText, "Glad us check first stretch alpha.");

    // 4. Empty/silent stream returns `streamingText: undefined` rather than empty string.
    const sEmpty = await asr.open(null);
    const rEmpty = await sEmpty.finish();
    sEmpty.dispose();
    assert.equal(rEmpty.text, "");
    assert.equal(rEmpty.streamingText, undefined);

    // 5. 4-word utterance where the 4th word ("server") is held back until `inputFinished()`, while offline Parakeet
    // hallucinates a 1-word fragment ("open."): `finish()` must flush before evaluating `trusted()` so the truncated
    // offline fragment is rejected (`1 * 3 < 4`) in favor of `"open package slash server"`.
    const sTrusted = await asr.open("en-US");
    sTrusted.accept(taggedSamples(0.45, 1.0));
    const rTrusted = await sTrusted.finish();
    sTrusted.dispose();
    assert.equal(rTrusted.text, "open package slash server");
    assert.equal(rTrusted.streamingText, "open package slash server");

    // 6. Streaming-only engine (`finalDir: null`) flushes `inputFinished()` at most once on fallback path.
    const streamingOnly = new SherpaAsr({
      runtimeDir: mock.runtimeDir,
      streamingDir: join(mock.runtimeDir, "streaming"),
      finalDir: null,
      threads: 1,
      finalThreads: 1,
    });
    t.after(() => streamingOnly.dispose());

    const s3 = await streamingOnly.open("pt-BR", { vocabulary: ["Ancilla", "muse-wonder-full-1.0"] });
    s3.accept(taggedSamples(0.35, 1.0));
    const r3 = await s3.finish();
    s3.dispose();
    assert.equal(r3.text, "package slash server ts");
    assert.equal(r3.streamingText, "package slash server ts");

    const { readFile } = await import("node:fs/promises");
    const events = (await readFile(mock.stateFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; id?: number; count?: number; key?: string; value?: string });

    const maxFinishCount = Math.max(
      0,
      ...events.filter((e) => e.type === "input_finished").map((e) => e.count ?? 0),
    );
    assert.equal(maxFinishCount, 1, "no online stream ever had inputFinished() invoked more than once");

    const hotwordEvents = events.filter((e) => e.type === "set_option" && e.key === "hotwords");
    assert.ok(hotwordEvents.length >= 3, "vocabulary hotwords forwarded across open() and post-rollover streams");
    assert.equal(hotwordEvents[0]?.value, "GlaDOS\npackages/server.ts", "deduped and bounded vocabulary hotwords");
  });

  it("tolerates online streams whose setOption rejects hotwords without failing SherpaAsr.open()", async (t) => {
    const mock = await createMockSherpaRuntime({ throwOnHotwords: true });
    t.after(mock.cleanup);

    const asr = new SherpaAsr({
      runtimeDir: mock.runtimeDir,
      streamingDir: join(mock.runtimeDir, "streaming"),
      finalDir: null,
      threads: 1,
      finalThreads: 1,
    });
    t.after(() => asr.dispose());

    const stream = await asr.open("en-US", { vocabulary: ["GlaDOS", "muse-wonder-full-1.0"] });
    stream.accept(taggedSamples(0.35, 0.8));
    const res = await stream.finish();
    stream.dispose();
    assert.equal(res.text, "package slash server ts");
  });

  it("normalizes singular/code directory heads and ASR near-miss dotted extensions after slash while preserving EN/PT/ES prose", async (t) => {
    // Exact live hardware ASR transcripts from Round 1 verification:
    const liveStreaming = normalizeSpokenTechnical(
      "Glad us please open package slash server ts on port eighty eighty",
    );
    const liveOffline = normalizeSpokenTechnical(
      "Gladys, please open packager slash server.tis on port 8080.",
    );
    assert.equal(liveStreaming, "Glad us please open package/server ts on port 8080");
    assert.equal(liveOffline, "Gladys, please open packager/server.tis on port 8080.");

    // Verify end-to-end against a real AssistantVoiceHost bound to a workspace containing `packages/server.ts`
    // (rather than only hand-passed vocabulary):
    const wsDir = await mkdtemp(join(tmpdir(), "ancilla-voice-vocab-ws-"));
    t.after(() => rm(wsDir, { recursive: true, force: true }));
    await mkdir(join(wsDir, "packages"), { recursive: true });
    await writeFile(join(wsDir, "packages", "server.ts"), "export const ok = true;\n", "utf8");

    const memStore = MemoryStore.open(":memory:");
    memStore.saveProfile({ enabled: true, name: "GlaDOS" });
    const assistant = new AssistantService(memStore, { log: () => undefined, emit: () => undefined });
    t.after(() => assistant.close());
    const convs = new ConversationStore(memStore);
    const cid = convs.create(wsDir);
    const voiceHost = new AssistantVoiceHost({
      assistant,
      conversations: convs,
      conversationId: cid,
      settings: () => DEFAULT_VOICE_SETTINGS,
      hub: new TaskHub(),
      project: () => wsDir,
      log: () => undefined,
    });
    const hostVocab = voiceHost.vocabulary();
    assert.ok(hostVocab.includes("packages/server.ts"), "AssistantVoiceHost.vocabulary() indexes 1-level workspace slash paths");

    const grounded = groundUtterance({
      text: liveOffline,
      streamingText: liveStreaming,
      tokenLogProbs: [-0.48, -0.05, -0.05, -0.52, -0.05, -0.05, -0.05],
      vocabulary: hostVocab,
    });
    assert.equal(grounded.text, "GlaDOS, please open packages/server.ts on port 8080.");

    // Expanded PATH_DIR_HEADS & dotted right-hand targets across slash / forward slash / barra:
    for (const dir of [
      "package",
      "bin",
      "pkg",
      "core",
      "shared",
      "common",
      "client",
      "types",
      "utils",
      "hooks",
      "routes",
      "services",
      "workers",
      "engines",
      "voice",
      "assistant",
      "providers",
      "daemon",
      "desktop",
    ]) {
      assert.equal(normalizeSpokenTechnical(`check ${dir} slash index`), `check ${dir}/index`, dir);
    }
    assert.equal(normalizeSpokenTechnical("open folder forward slash foo.bar"), "open folder/foo.bar");
    assert.equal(normalizeSpokenTechnical("abre pasta barra config.ymll"), "abre pasta/config.ymll");

    // Prose alternatives in English, Portuguese, and Spanish must stay untouched:
    const proseSamples = [
      "Check and slash or update the docs.",
      "Answer yes slash no on the form.",
      "It returns true slash false for each check.",
      "Mark each step pass slash fail.",
      "Weigh the pros slash cons carefully.",
      "Responda sim barra não agora.",
      "Escolha verdadeiro barra falso na lista.",
      "Responde sí barra no por favor.",
      "Abre o app barra lateral esquerda.",
      "No app barra superior direita.",
      "Na web barra inferior fixa.",
      "No client barra invertida escapa o caractere.",
      "En la web barra espaciadora pausa el audio.",
      "No desktop barra vertical separa colunas.",
      "Na ui barra horizontal divide a tela.",
      "Veja na web barra de navegação.",
      "Veja na web barra de barra lateral.",
      "Answer yes slash or slash no.",
      "Pick a slash b slash the option.",
      "Check option slash e.g. this value.",
      "Use flag slash i.e. that setting.",
      "Finished src. Yes slash no.",
    ];
    for (const sample of proseSamples) {
      assert.equal(normalizeSpokenTechnical(sample), sample, `prose altered: ${sample}`);
    }
  });

  it("falls back gracefully when a Muse CLI rejects extended voice serve flags, closes the failed handle, caches the fallback, and never passes --trust-workspace", async (t) => {
    const ws1 = await mkdtemp(join(tmpdir(), "ancilla-voice-fb-1-"));
    const ws2 = await mkdtemp(join(tmpdir(), "ancilla-voice-fb-2-"));
    t.after(async () => {
      await rm(ws1, { recursive: true, force: true });
      await rm(ws2, { recursive: true, force: true });
    });

    const conn = new FakeConnection();
    conn.replies.set("session/start", {
      session: { sessionId: "s-voice-fb", status: "idle", modelId: "muse-spark-1.3" },
    });

    const seenTargets: ServeTarget[] = [];
    let closedFailedHandles = 0;

    const hostFactory = (target: ServeTarget): HostHandle => {
      seenTargets.push(target);
      const hasExtendedVoiceFlags = target.args.includes("--preset");
      return {
        start: async () => {
          if (hasExtendedVoiceFlags) {
            throw new Error("error: unexpected argument '--disable-request-user-input' found");
          }
          return {
            initializeResult: {
              serverInfo: { name: "muse", version: "1.4.7" },
            },
          };
        },
        connection: conn as never,
        close: async () => {
          if (hasExtendedVoiceFlags) closedFailedHandles += 1;
          return { code: 0, signal: null };
        },
      };
    };

    const { server } = await start(conn, { hostFactory, platform: "linux" });
    // Enable YOLO in settings to verify degraded voice fallback STILL keeps yoloEnabled = false (no --trust-workspace).
    server["store"].setYoloSettings({ enabled: true });

    const voiceHost = server["voiceMuseHost"]();
    await voiceHost.warmHost?.(ws1, null, "muse");

    assert.equal(seenTargets.length, 2, "retried once with degraded voice flags");
    assert.ok(seenTargets[0]?.args.includes("--preset"), "first attempt tried extended voice flags");
    assert.equal(seenTargets[0]?.args.includes("--trust-workspace"), false);
    assert.deepEqual(seenTargets[1]?.args, ["serve"], "degraded retry stripped extraServeArgs and kept --trust-workspace off");
    assert.equal(server["lastHostError"], null, "recovered cleanly without leaving a host failure");

    // Allow microtask closeInBackground to run.
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(closedFailedHandles, 1, "closed the failed first handle via closeInBackground");

    // Subsequent voice host spawn on another folder must skip the rejected flags immediately without repeating the failed attempt.
    await voiceHost.warmHost?.(ws2, null, "muse");
    assert.equal(seenTargets.length, 3, "cached fallback flag so second voice host spawned directly on first try");
    assert.deepEqual(seenTargets[2]?.args, ["serve"]);

    // Verify HostStartTimeoutError is NOT retried as a flag rejection.
    let timeoutAttempts = 0;
    const timeoutFactory = (target: ServeTarget): HostHandle => {
      timeoutAttempts += 1;
      void target;
      return {
        start: async () => {
          throw new HostStartTimeoutError(500);
        },
        connection: conn as never,
        close: async () => ({ code: 0, signal: null }),
      };
    };
    const { server: timeoutServer } = await start(conn, { hostFactory: timeoutFactory, platform: "linux" });
    await assert.rejects(
      () => timeoutServer["voiceMuseHost"]().warmHost?.(ws1, null, "muse") ?? Promise.resolve(),
      /Could not start Muse/,
    );
    assert.equal(timeoutAttempts, 1, "HostStartTimeoutError must not retry");

    // Verify a total Muse outage (where BOTH extended-flag and degraded attempts fail, e.g. ENOENT) closes both failed handles
    // and does NOT permanently poison `voiceExtraFlagsUnsupported` once Muse 1.4.15 comes online.
    let museOnline = false;
    let closedOutageHandles = 0;
    const outageTargets: ServeTarget[] = [];
    const outageFactory = (target: ServeTarget): HostHandle => {
      outageTargets.push(target);
      return {
        start: async () => {
          if (!museOnline) throw new Error("spawn muse ENOENT");
          return { initializeResult: { serverInfo: { name: "muse", version: "1.4.15" } } };
        },
        connection: conn as never,
        close: async () => {
          if (!museOnline) closedOutageHandles += 1;
          return { code: 0, signal: null };
        },
      };
    };
    const { server: outageServer } = await start(conn, { hostFactory: outageFactory, platform: "linux" });
    await assert.rejects(
      () => outageServer["voiceMuseHost"]().warmHost?.(ws1, null, "muse") ?? Promise.resolve(),
      /Could not start Muse/,
    );
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(closedOutageHandles, 2, "both failed outage handles were closed");
    assert.equal(outageServer["voiceExtraFlagsUnsupported"], false, "total outage did not poison voiceExtraFlagsUnsupported");

    museOnline = true;
    await outageServer["voiceMuseHost"]().warmHost?.(ws1, null, "muse");
    assert.ok(outageTargets.at(-1)?.args.includes("--preset"), "recovered Muse 1.4.15 host still receives lean voice flags");
  });

  it("maps WSL museHome paths on win32 and includes META_MUSE_CODE_MODEL_IDS in museCatalogModels on Muse 1.4.15+ or default hostFactory", async (t) => {
    assert.deepEqual(META_MUSE_CODE_MODEL_IDS, [
      "muse-wonder-1.0",
      "muse-wonder-full-1.0",
      "muse-ember-1.0",
      "muse-spark-1.3",
      "muse-spark-1.2",
    ]);

    // 1. Verify win32 + WSL Linux museHome path mapping produces \\wsl.localhost\<distro>\... instead of \home\...
    const mappedWsl = resolveUserPath("/home/aleff/.local/share/muse/model-catalog", {
      platform: "win32",
      home: "C:\\Users\\aleff",
      distro: "Ubuntu",
    });
    assert.equal(
      mappedWsl.local,
      "\\\\wsl.localhost\\Ubuntu\\home\\aleff\\.local\\share\\muse\\model-catalog",
    );

    // 2. Verify a default-hostFactory server (production configuration) includes META_MUSE_CODE_MODEL_IDS for voice vocabulary
    // even before any catalog file exists, WITHOUT wiping a valid custom/newer saved model in `voice.json` on cold startup.
    const defaultHome = await mkdtemp(join(tmpdir(), "ancilla-default-home-"));
    const coldDataDir = await mkdtemp(join(tmpdir(), "ancilla-cold-data-"));
    await writeFile(
      join(coldDataDir, "voice.json"),
      JSON.stringify({ brain: { kind: "muse", model: "muse-horizon-2.0" } }),
      "utf8",
    );
    const defaultServer = new AncillaServer({
      port: 0,
      dataDir: coldDataDir,
      home: defaultHome,
      platform: "win32",
      distro: "Ubuntu",
      exec: async (_cmd, args) => {
        if (args.includes('printf %s "$HOME"')) return { stdout: "/home/wsl_probe_user", exitCode: 0 };
        return { stdout: "", exitCode: 1 };
      },
    });
    t.after(async () => {
      await defaultServer.close();
      await rm(defaultHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(coldDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    const prodVoice = defaultServer["voiceFor"]();
    const prodModels = prodVoice["deps"].museCatalogModels?.() ?? [];
    assert.deepEqual(prodModels, META_MUSE_CODE_MODEL_IDS);
    assert.deepEqual(
      prodVoice["deps"].museCatalogModels?.(null, { diskOnly: true }) ?? [],
      [],
      "diskOnly returns empty when no on-disk catalog exists yet",
    );
    assert.deepEqual(
      prodVoice.effectiveSettings().brain,
      { kind: "muse", model: "muse-horizon-2.0" },
      "cold win32 startup preserves saved custom/newer Muse model pin in voice.json before disk catalog is read",
    );

    // Warm `wslHomes` and verify `museCatalogModels` on win32 checks `\\wsl.localhost\Ubuntu\home\wsl_probe_user\...` even with 0 hosts:
    await defaultServer["wslHomes"].get("Ubuntu");
    const realReaddirSync = fsSync.readdirSync.bind(fsSync);
    const seenWin32Dirs: string[] = [];
    const readdirSpy = t.mock.method(fsSync, "readdirSync", ((p: fsSync.PathLike, opts?: unknown) => {
      const target = String(p);
      seenWin32Dirs.push(target);
      if (target.startsWith("\\\\wsl.localhost\\")) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return realReaddirSync(p, opts as never);
    }) as typeof fsSync.readdirSync);
    prodVoice["deps"].museCatalogModels?.();
    assert.ok(
      seenWin32Dirs.includes("\\\\wsl.localhost\\Ubuntu\\home\\wsl_probe_user\\.local\\share\\muse\\model-catalog"),
      `expected wslHomes pre-warmed \\\\wsl.localhost lookup, saw ${JSON.stringify(seenWin32Dirs)}`,
    );

    // 3. Verify a Muse 1.4.15+ host with a WSL `/mnt/...` or Linux `museHome` resolves via `resolveUserPath` AND dedupes cached catalog entries with `META_MUSE_CODE_MODEL_IDS`.
    const tempRoot = await mkdtemp(join(tmpdir(), "ancilla-wsl-cat-"));
    const workspace = await mkdtemp(join(tmpdir(), "ancilla-wsl-ws-"));
    t.after(async () => {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    });

    // First test with missing catalog directory on a Muse 1.4.15 host on win32 + WSL Linux museHome:
    seenWin32Dirs.length = 0;
    const conn1 = new FakeConnection();
    const { server: sMissing } = await start(conn1, {
      platform: "win32",
      distro: "Ubuntu",
      hostFactory: () => ({
        start: async () => ({
          initializeResult: {
            serverInfo: { name: "muse", version: "1.4.15" },
            museHome: "/home/nonexistent_user/.local/share/muse",
          },
        }),
        connection: conn1 as never,
        close: async () => ({ code: 0, signal: null }),
      }),
    });
    await sMissing["hostFor"](workspace, null, "muse", "coding");
    const fallbackModels = sMissing["voiceFor"]()["deps"].museCatalogModels?.() ?? [];
    assert.deepEqual(fallbackModels, META_MUSE_CODE_MODEL_IDS);
    assert.ok(
      seenWin32Dirs.includes("\\\\wsl.localhost\\Ubuntu\\home\\nonexistent_user\\.local\\share\\muse\\model-catalog"),
      `expected museHome mapped via resolveUserPath to \\\\wsl.localhost\\Ubuntu\\..., saw ${JSON.stringify(seenWin32Dirs)}`,
    );
    readdirSpy.mock.restore();

    // Second test with a populated model-catalog directory (including an extra catalog model + overlapping standard models)
    // accessed via Linux path mapping:
    const catalogDir = join(tempRoot, "model-catalog");
    await mkdir(catalogDir, { recursive: true });
    await writeFile(
      join(catalogDir, "meta_catalog.json"),
      JSON.stringify({
        schema_version: 2,
        provider_id: "meta",
        profile_id: "tbh",
        rows: [
          { model_id: "muse-horizon-2.0", visibility: "visible" },
          { model_id: "muse-wonder-full-1.0", visibility: "visible" },
        ],
      }),
      "utf8",
    );

    const conn2 = new FakeConnection();
    const { server: sPopulated } = await start(conn2, {
      platform: "linux",
      hostFactory: () => ({
        start: async () => ({
          initializeResult: {
            serverInfo: { name: "muse", version: "1.4.15" },
            museHome: `${tempRoot}/`,
          },
        }),
        connection: conn2 as never,
        close: async () => ({ code: 0, signal: null }),
      }),
    });
    await sPopulated["hostFor"](workspace, null, "muse", "coding");
    const mergedModels = sPopulated["voiceFor"]()["deps"].museCatalogModels?.() ?? [];
    assert.deepEqual(mergedModels, [
      "muse-horizon-2.0",
      "muse-wonder-full-1.0",
      "muse-wonder-1.0",
      "muse-ember-1.0",
      "muse-spark-1.3",
      "muse-spark-1.2",
    ]);

    // Ground spoken Muse model names (including newly exported ember/wonder-full/horizon) against that catalog vocabulary:
    const groundedWonder = groundUtterance({
      text: normalizeSpokenTechnical("switch to muse wonder full one point zero"),
      vocabulary: mergedModels,
    });
    assert.equal(groundedWonder.text, "switch to muse-wonder-full-1.0");

    const groundedEmber = groundUtterance({
      text: normalizeSpokenTechnical("switch to muse ember one point zero"),
      vocabulary: mergedModels,
    });
    assert.equal(groundedEmber.text, "switch to muse-ember-1.0");
  });
});
