import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AuthorizationHub,
  LaunchManager,
  extractListeningUrls,
  isLikelyServerCommand,
  parseUserAuthorizationIntent,
} from "../src/assistant/launcher.js";
import { formatPageDiagnostics, type PageDiagnostics } from "../src/browser/service.js";
import { resolveByFuzzyName, scoreNameMatch } from "../src/voice/harness.js";
import { makeRig } from "../src/voice/testing.js";
import { WORKSPACE_TOOLS, WorkspaceVoiceTools } from "../src/voice/workspace-tools.js";

describe("user authorization intent parser", () => {
  it("recognizes clear confirmations and rejections without guessing on questions or negations", () => {
    assert.equal(parseUserAuthorizationIntent("yes"), "allow");
    assert.equal(parseUserAuthorizationIntent("Go ahead."), "allow");
    assert.equal(parseUserAuthorizationIntent("Just launch it!"), "allow");
    assert.equal(parseUserAuthorizationIntent("sim, pode abrir"), "allow");
    assert.equal(parseUserAuthorizationIntent("no, cancel that"), "deny");
    assert.equal(parseUserAuthorizationIntent("don't launch it yet"), "deny");
    assert.equal(parseUserAuthorizationIntent("sure, what port will it use?"), null, "questions never approve");
    assert.equal(parseUserAuthorizationIntent("yes, why is the canvas blurry?"), null);
    assert.equal(parseUserAuthorizationIntent("check the animation code first"), null);
  });
});

describe("fuzzy project and thread name matching", () => {
  it("resolves spoken variations like Amazon River and trail of Amazonia River to amazonia_river", () => {
    const projects = [{ name: "ancilla" }, { name: "amazonia_river" }, { name: "notes" }];
    assert.ok(scoreNameMatch("amazonia_river", "Amazon River") >= 0.65);
    assert.ok(scoreNameMatch("amazonia_river", "the trail of Amazonia River") >= 0.75);
    assert.ok(scoreNameMatch("amazonia_river", "the tread Amazon River project") >= 0.65);

    const r1 = resolveByFuzzyName(projects, (p) => p.name, "Amazon River");
    assert.equal(r1?.name, "amazonia_river");

    const r2 = resolveByFuzzyName(projects, (p) => p.name, "trail of Amazonia River");
    assert.equal(r2?.name, "amazonia_river");
  });
});

describe("LaunchManager and AuthorizationHub", () => {
  it("extracts localhost URLs from dev server output and identifies server commands", () => {
    assert.equal(isLikelyServerCommand("npm run dev"), true);
    assert.equal(isLikelyServerCommand("npx vite --port 5173"), true);
    assert.equal(isLikelyServerCommand("npm test"), false);
    const urls = extractListeningUrls("\u001b[32m➜\u001b[39m  Local:   http://0.0.0.0:5173/\nListening on port 8080");
    assert.deepEqual(urls, ["http://localhost:5173/", "http://localhost:8080/"]);
  });

  it("queues unapproved launches when YOLO is off, runs once authorized, detects localhost, scrubs secrets, and stops cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ancilla-launch-test-"));
    const prevSecret = process.env["ANCILLA_TOKEN"];
    process.env["ANCILLA_TOKEN"] = "super-secret-daemon-token";
    let yolo = false;
    const granted: string[] = [];
    const openedUrls: string[] = [];
    const hub = new AuthorizationHub();
    const scriptFile = join(dir, "dev-server.mjs");
    writeFileSync(
      scriptFile,
      [
        'import { createServer } from "node:http";',
        "const srv = createServer((_req, res) => {",
        '  res.writeHead(200, { "content-type": "text/plain" });',
        '  res.end("TOKEN=" + (process.env.ANCILLA_TOKEN ?? "scrubbed"));',
        "});",
        'srv.listen(0, "127.0.0.1", () => {',
        "  const addr = srv.address();",
        '  console.log("Local: http://127.0.0.1:" + addr.port + "/");',
        "});",
      ].join("\n"),
      "utf8",
    );

    const launcher = new LaunchManager({
      planCommand: async (cwd, command) => ({
        command: process.execPath,
        args: command === "run-dev" ? [scriptFile] : ["-e", command],
        cwd,
      }),
      grantOrigin: (origin) => granted.push(origin),
      openAncillaBrowser: async (url) => {
        openedUrls.push(url);
        return { url, title: "Amazonia River" };
      },
      isPreAuthorized: () => yolo,
      authorizations: hub,
    });

    try {
      const queued = await launcher.requestLaunch(
        {
          kind: "command",
          cwd: dir,
          projectName: "amazonia_river",
          command: "run-dev",
          background: true,
          openInBrowser: true,
        },
        { turn: 1 },
      );
      assert.equal(queued.status, "needs_authorization");
      assert.equal(launcher.list().length, 0, "nothing spawned before user approval");
      assert.equal(hub.current()?.createdTurn, 1);

      const decided = await hub.decide(hub.current()!.id, true);
      assert.equal(decided.ok, true);
      assert.equal(hub.current(), null);

      const active = launcher.list();
      assert.equal(active.length, 1);
      const url = active[0]?.urls[0];
      assert.ok(url && /^http:\/\/localhost:\d+\/$/.test(url), `detected localhost url: ${url}`);
      assert.ok(granted.includes(new URL(url).origin), "granted loopback origin in browser gate");
      assert.deepEqual(openedUrls, [url]);

      const resp = await fetch(url);
      assert.equal(await resp.text(), "TOKEN=scrubbed", "daemon auth token is scrubbed from launched child env");

      // With YOLO enabled, launching runs immediately and reuses the identical running server.
      yolo = true;
      const immediate = await launcher.requestLaunch(
        {
          kind: "command",
          cwd: dir,
          projectName: "amazonia_river",
          command: "run-dev",
          background: true,
        },
        { turn: 2 },
      );
      assert.equal(immediate.status, "launched");
      if (immediate.status === "launched") {
        assert.equal(immediate.launch.id, active[0]?.id, "reuses identical running server");
      }
    } finally {
      await launcher.stopAll({ graceMs: 1000 });
      if (prevSecret === undefined) delete process.env["ANCILLA_TOKEN"];
      else process.env["ANCILLA_TOKEN"] = prevSecret;
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(launcher.list().every((l) => l.status !== "running"), true);
  });
});

describe("WorkspaceVoiceTools inspection and page diagnostics", () => {
  it("reads project files with fuzzy project names and formats live page animation diagnostics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ancilla-ws-voice-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "amazonia-river", scripts: { dev: "vite" } }), "utf8");
    writeFileSync(join(dir, "src", "riverAnimation.ts"), "export function drawRiver() {\n  requestAnimationFrame(drawRiver);\n}\n", "utf8");

    const hub = new AuthorizationHub();
    const allowed = new Set<string>();
    const launcher = new LaunchManager({
      planCommand: async (cwd) => ({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd }),
      isPreAuthorized: () => false,
      authorizations: hub,
    });

    const sampleDiag: PageDiagnostics = {
      url: "http://localhost:5173/",
      title: "Amazonia River",
      viewport: { width: 1280, height: 720, dpr: 2 },
      fps: { fps: 24, frames: 11, avgFrameMs: 41.6, maxFrameMs: 88.4, droppedFrames: 5 },
      canvases: [{ label: "#river", cssWidth: 1280, cssHeight: 720, bufferWidth: 300, bufferHeight: 150, dpiMismatch: true, zeroSize: false }],
      animations: { total: 3, running: 3, paused: 0, layoutThrashingProps: ["top", "width"] },
      svgCount: 0,
      videoCount: 0,
      brokenImages: 0,
      errorOverlay: null,
      consoleErrors: ["WebGL warning: context lost"],
    };

    const tools = new WorkspaceVoiceTools({
      projects: () => [{ name: "amazonia_river", cwd: dir, displayCwd: dir }],
      currentProject: () => ({ name: "amazonia_river", cwd: dir, displayCwd: dir }),
      launcher,
      authorizations: hub,
      isPreAuthorized: () => false,
      inspector: {
        available: async () => ({ ok: true }),
        isSiteAllowed: (origin) => allowed.has(origin),
        grantSite: (origin) => void allowed.add(origin),
        inspectUrl: async (url) => ({
          url,
          title: "Amazonia River",
          diagnostics: sampleDiag,
          snapshotText: '[heading "Amazonia River"]',
        }),
      },
    });

    try {
      assert.equal(WORKSPACE_TOOLS.length, 4);
      const search = await tools.run(
        { id: "c1", name: "inspect_project", arguments: JSON.stringify({ action: "search", project: "Amazon River", query: "river" }) },
        1,
      );
      assert.equal(search?.ok, true);
      assert.match(search?.text ?? "", /src\/riverAnimation\.ts/);

      const read = await tools.run(
        { id: "c2", name: "inspect_project", arguments: JSON.stringify({ action: "read", project: "trail of Amazonia River", path: "src/riverAnimation.ts" }) },
        1,
      );
      assert.equal(read?.ok, true);
      assert.match(read?.text ?? "", /requestAnimationFrame/);

      // Unapproved origin queues authorization first when YOLO is off.
      const gated = await tools.run({ id: "c3", name: "inspect_page", arguments: JSON.stringify({ url: "localhost:5173" }) }, 1);
      assert.equal(gated?.ok, true);
      assert.match(gated?.text ?? "", /Authorization required/);
      await hub.decide(hub.current()!.id, true);

      // Once granted, inspect_page returns FPS, canvas DPI mismatch, layout-thrashing, and console diagnostics.
      const inspected = await tools.run({ id: "c4", name: "inspect_page", arguments: JSON.stringify({ url: "localhost:5173" }) }, 2);
      assert.equal(inspected?.ok, true);
      assert.match(inspected?.text ?? "", /24 fps/);
      assert.match(inspected?.text ?? "", /DPI-MISMATCH/);
      assert.match(inspected?.text ?? "", /top, width/);
      assert.match(formatPageDiagnostics(sampleDiag), /WebGL warning/);

      // Meta consumer/social sites are fenced off from automated inspect_page and Ancilla browser launches.
      const blockedInspect = await tools.run({ id: "c5", name: "inspect_page", arguments: JSON.stringify({ url: "https://www.instagram.com/" }) }, 3);
      assert.equal(blockedInspect?.ok, false);
      assert.match(blockedInspect?.text ?? "", /disabled on Meta consumer sites/);

      const blockedLaunch = await tools.run({ id: "c6", name: "launch", arguments: JSON.stringify({ url: "https://web.whatsapp.com/" }) }, 3);
      assert.equal(blockedLaunch?.ok, false);
      assert.match(blockedLaunch?.text ?? "", /disabled on Meta consumer sites/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("VoiceSession filler streaming and subsequent-turn spoken authorization", () => {
  it("streams assistant text after a filler without overwriting or duplicating words", async () => {
    const rig = await makeRig({
      sentences: { 1: "Check the river animation." },
      config: { fillerAfterMs: 100 },
      script: () => ({ ttftMs: 450, pieceMs: 25, text: "I checked the canvas scaling and frame pacing." }),
    });
    rig.client.send({ type: "text", text: "Check the river animation." });
    assert.ok(
      await rig.client.until(() => rig.client.of("speak_end").length >= 1 && rig.session.snapshot().agent === "idle", 20_000),
      "turn finished speaking",
    );
    const updates = rig.client.of("assistant").map((m) => m.msg.text);
    assert.ok(updates.length >= 2);
    for (let i = 1; i < updates.length; i++) {
      const prev = updates[i - 1] ?? "";
      const curr = updates[i] ?? "";
      assert.ok(curr.startsWith(prev), `assistant line grew monotonically: "${prev}" -> "${curr}"`);
    }
    const finalText = updates.at(-1) ?? "";
    assert.doesNotMatch(finalText, /\b(check\.\s+check\.|think\.\s+think\.)/i);
    assert.match(finalText, /I checked the canvas scaling and frame pacing\.$/);
  });

  it("pushes a pending approval card to the client and executes it when the user confirms on the next turn", async () => {
    const hub = new AuthorizationHub();
    let executed = false;
    const rig = await makeRig({
      open: false,
      sentences: { 1: "Launch localhost.", 2: "Go ahead." },
      script: (messages, callNum) => {
        const last = messages.at(-1)?.content ?? "";
        if (callNum === 1) {
          return { ttftMs: 50, tool: { name: "launch", args: { command: "npm run dev" } } };
        }
        if (callNum === 2) {
          return { ttftMs: 50, text: "Ready to launch npm run dev. Say go ahead or click Launch." };
        }
        assert.match(
          last,
          /\[The user authorized the pending request "Launch in amazonia_river"\. Outcome: Started on http:\/\/localhost:5173\/\]/,
        );
        return { ttftMs: 50, text: "Started it on localhost 5173." };
      },
    });

    rig.host.toolList = [{ name: "launch", description: "Launch command", parameters: { type: "object", properties: {} } }];
    rig.host.pendingApproval = () => hub.current();
    rig.host.decideApproval = (id, allow) => hub.decide(id, allow);
    rig.host.subscribeApprovals = (fn) => hub.subscribe(fn);
    rig.host.runTool = async (_call, ctx) => {
      const req = hub.request({
        kind: "launch",
        title: "Launch in amazonia_river",
        detail: "npm run dev",
        allowLabel: "Launch",
        createdTurn: ctx?.turn ?? 1,
        onDecide: async (allow) => {
          executed = allow;
          return { ok: true, message: "Started on http://localhost:5173/" };
        },
      });
      return { ok: true, text: `Waiting for approval (${req.id}).` };
    };

    await rig.session.start({ type: "hello", v: 1, mode: "hands-free", lang: null, echoCancelled: true, resume: null, thread: null });
    await rig.sched.advance(0);

    rig.client.send({ type: "text", text: "Launch localhost." });
    assert.ok(
      await rig.client.until(() => rig.client.of("speak_end").length >= 1 && rig.session.snapshot().agent === "idle", 20_000),
      "first turn finished",
    );
    assert.equal(executed, false, "not executed before user confirms");
    const approvals = rig.client.of("approval");
    assert.ok(approvals.some((a) => a.msg.request?.title === "Launch in amazonia_river"), "approval card pushed to call client");

    // Turn 2: user confirms in natural speech/text ("Go ahead").
    rig.client.send({ type: "text", text: "Go ahead." });
    assert.ok(
      await rig.client.until(() => executed && rig.session.snapshot().agent === "idle", 20_000),
      "second turn resolved authorization and spoke confirmation",
    );
    assert.equal(executed, true);
    assert.equal(rig.client.of("approval").at(-1)?.msg.request, null, "approval banner cleared after execution");
  });

  it("refuses spoken allow when microphone echo cancellation is off while still allowing spoken cancel and button clicks", async () => {
    const hub = new AuthorizationHub();
    const decisions: boolean[] = [];
    const rig = await makeRig({
      open: false,
      sentences: { 1: "Go ahead.", 2: "Cancel that." },
      script: (messages) => {
        const last = messages.at(-1)?.content ?? "";
        if (last.includes("Spoken approval") && last.includes("echo cancellation is off")) {
          return { ttftMs: 30, text: "Please click Launch on the call card." };
        }
        return { ttftMs: 30, text: "Okay." };
      },
    });

    rig.host.pendingApproval = () => hub.current();
    rig.host.decideApproval = (id, allow) => hub.decide(id, allow);
    rig.host.subscribeApprovals = (fn) => hub.subscribe(fn);

    await rig.session.start({ type: "hello", v: 1, mode: "hands-free", lang: null, echoCancelled: false, resume: null, thread: null });
    await rig.sched.advance(0);

    const first = hub.request({
      kind: "launch",
      title: "Launch dev server",
      detail: "npm run dev",
      allowLabel: "Launch",
      createdTurn: 0,
      onDecide: async (allow) => {
        decisions.push(allow);
        return { ok: true, message: allow ? "Launched" : "Declined" };
      },
    });

    // Spoken "Go ahead." over non-echo-cancelled mic MUST NOT approve!
    await rig.client.speak(1, 700);
    assert.ok(
      await rig.client.until(() => rig.client.of("speak_end").length >= 1 && rig.session.snapshot().agent === "idle", 20_000),
      "spoken turn finished",
    );
    assert.equal(decisions.length, 0, "spoken allow blocked when echoCancelled is false");
    assert.equal(hub.current()?.id, first.id, "approval remains pending on screen");
    assert.ok(
      rig.client.of("notice").some((n) => /Echo cancellation is off/.test(n.msg.text)),
      "client received acoustic warning notice",
    );

    // Spoken "Cancel that." STILL declines immediately even without echo cancellation (fail-safe).
    await rig.client.speak(2, 700);
    assert.ok(
      await rig.client.until(() => decisions.length === 1 && rig.session.snapshot().agent === "idle", 20_000),
      "spoken cancel honored",
    );
    assert.deepEqual(decisions, [false]);
    assert.equal(hub.current(), null);

    // Explicit UI button click ("decide") approves even when echoCancelled is false.
    const second = hub.request({
      kind: "launch",
      title: "Launch preview",
      detail: "npm run preview",
      allowLabel: "Launch",
      createdTurn: 0,
      onDecide: async (allow) => {
        decisions.push(allow);
        return { ok: true, message: "Preview started" };
      },
    });
    rig.client.send({ type: "decide", id: second.id, allow: true });
    assert.ok(await rig.client.until(() => decisions.length === 2, 5_000));
    assert.deepEqual(decisions, [false, true]);
  });
});
