import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AncillaStore, ProjectFolderError, researchStateProblem } from "../src/store.js";
import { DEFAULT_RESEARCH_CONFIG, type ResearchEvent, type ResearchRunState } from "../src/research/index.js";

describe("AncillaStore", () => {
  it("keeps the newest quota observation per verified login scope", () => {
    const store = new AncillaStore();
    after(() => store.close());
    const reading = { tier: "high", observedAtMs: 200,
      window: { usedPercent: 125, resetsAtMs: 500, windowDurationMins: 300 },
      weekly: { usedPercent: 45, resetsAtMs: 1000, windowDurationMins: null } };
    assert.equal(store.getSubscriptionUsage("work"), null);
    store.setSubscriptionUsage("work", reading);
    store.setSubscriptionUsage("work", { ...reading, observedAtMs: 100 });
    assert.deepEqual(store.getSubscriptionUsage("work"), reading);
    assert.equal(store.getSubscriptionUsage("personal"), null);
    const corrected = { ...reading, window: { ...reading.window, usedPercent: 128 } };
    store.setSubscriptionUsage("work", corrected);
    assert.deepEqual(store.getSubscriptionUsage("work"), corrected, "equal-stamp corrections survive restoring the cache");
    store.setSubscriptionUsage("work", { ...reading, observedAtMs: 100 });
    assert.deepEqual(store.getSubscriptionUsage("work"), corrected);
  });

  it("groups session records under project entities by workspace directory path", () => {
    const store = new AncillaStore();
    after(() => store.close());

    const initialProject = store.upsertProject("D:\\work\\ancilla");
    assert.strictEqual(initialProject.displayName, "ancilla");
    assert.strictEqual(initialProject.pinned, false);

    const reUpserted = store.upsertProject("D:\\work\\ancilla");
    assert.strictEqual(reUpserted.id, initialProject.id);

    const sessionRow = store.recordSession({ id: "sess-1", projectId: initialProject.id });
    assert.strictEqual(sessionRow.turnCount, 0);
    assert.strictEqual(sessionRow.origin, "ancilla");

    store.recordTurn("turn-1", "sess-1");
    store.updateTurnStatus("turn-1", "completed");

    const projectSessions = store.listSessionsByProject(initialProject.id);
    assert.strictEqual(projectSessions.length, 1);
    assert.strictEqual(projectSessions[0]?.turnCount, 1);
    assert.strictEqual(projectSessions[0]?.id, "sess-1");
  });

  it("persists shell run outputs and execution metadata for sessions", () => {
    const store = new AncillaStore();
    after(() => store.close());

    const proj = store.upsertProject("/work/p");
    store.recordSession({ id: "sess-sh", projectId: proj.id });

    store.addShellRun({
      id: "sh-run-1",
      sessionId: "sess-sh",
      command: "ls -la",
      exitCode: 0,
      output: "total 0",
      truncated: false,
      durationMs: 12,
      at: "2026-09-11T22:00:00.000Z",
    });

    store.addShellRun({
      id: "sh-run-2",
      sessionId: "sess-sh",
      command: "false",
      exitCode: 1,
      output: "",
      truncated: true,
      durationMs: null,
      at: "2026-09-11T22:00:01.000Z",
    });

    const recordedRuns = store.listShellRuns("sess-sh");
    assert.deepStrictEqual(recordedRuns.map((r) => r.id), ["sh-run-1", "sh-run-2"]);
    assert.strictEqual(recordedRuns[0]?.output, "total 0");
    assert.strictEqual(recordedRuns[1]?.exitCode, 1);
    assert.strictEqual(recordedRuns[1]?.truncated, true);
    assert.strictEqual(recordedRuns[1]?.durationMs, null);
    assert.deepStrictEqual(store.listShellRuns("non-existent"), []);
  });

  it("stores binary attachment bytes and metadata associated with turns", () => {
    const store = new AncillaStore();
    after(() => store.close());

    const proj = store.upsertProject("/work/p");
    store.recordSession({ id: "sess-att", projectId: proj.id });

    const rawBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const attachmentResult = store.addAttachment({
      id: "att-1",
      sessionId: "sess-att",
      turnId: "turn-att",
      ord: 0,
      name: "diagram.png",
      mediaType: "image/png",
      kind: "image",
      width: 10,
      height: 20,
      bytes: rawBytes,
    });

    assert.strictEqual(attachmentResult.name, "diagram.png");
    assert.strictEqual(attachmentResult.kind, "image");
    assert.strictEqual(attachmentResult.turnId, "turn-att");

    const attachments = store.listAttachments("sess-att");
    assert.deepStrictEqual(attachments.map((a) => a.id), ["att-1"]);

    const retrieved = store.readAttachment("att-1");
    assert.deepStrictEqual(retrieved?.bytes, rawBytes);
    assert.strictEqual(store.readAttachment("unregistered"), null);
  });

  it("respects title source hierarchy preventing lower ranked overwrites", () => {
    const store = new AncillaStore();
    after(() => store.close());

    const proj = store.upsertProject("/work/p");
    const initSession = store.recordSession({ id: "sess-title", projectId: proj.id });
    assert.strictEqual(initSession.titleSource, "placeholder");

    store.recordSession({ id: "sess-title", projectId: proj.id, title: "Initial auto title", titleSource: "auto" });
    assert.strictEqual(store.getSession("sess-title")?.title, "Initial auto title");

    store.updateSession("sess-title", { title: "User curated title", titleSource: "user" });
    store.recordSession({ id: "sess-title", projectId: proj.id, title: "Subsequent auto candidate", titleSource: "auto" });
    assert.strictEqual(store.getSession("sess-title")?.title, "User curated title");

    assert.strictEqual(store.findSession("sess-title")?.cwd, "/work/p");
  });

  it("supports session archival and project visibility hiding without data deletion", () => {
    const store = new AncillaStore();
    after(() => store.close());

    const proj = store.upsertProject("/work/p");
    store.recordSession({ id: "sess-act", projectId: proj.id });
    store.recordSession({ id: "sess-arc", projectId: proj.id });

    store.updateSession("sess-arc", { archived: true });

    assert.deepStrictEqual(
      store.listSessionsByProject(proj.id).map((s) => s.id),
      ["sess-act"],
    );
    assert.strictEqual(store.listSessionsByProject(proj.id, { includeArchived: true }).length, 2);

    store.setHidden("/work/p", true);
    assert.strictEqual(store.listProjects().length, 0);
    assert.strictEqual(store.listProjects({ includeHidden: true }).length, 1);

    store.upsertProject("/work/p");
    assert.strictEqual(store.listProjects().length, 0, "Upserting known project should not implicitly unhide it");
  });

  it("sorts projects according to most recent session interaction timestamp", () => {
    const store = new AncillaStore();
    after(() => store.close());

    const projectA = store.upsertProject("/work/a");
    const projectB = store.upsertProject("/work/b");

    store.recordSession({ id: "s-a1", projectId: projectA.id, activityAt: "2026-01-01T00:00:00.000Z" });
    store.recordSession({ id: "s-b1", projectId: projectB.id, activityAt: "2026-02-01T00:00:00.000Z" });

    assert.deepStrictEqual(
      store.listProjects().map((p) => p.cwd),
      ["/work/b", "/work/a"],
    );

    store.recordSession({ id: "s-a1", projectId: projectA.id, activityAt: "2026-03-01T00:00:00.000Z" });
    assert.strictEqual(store.listProjects()[0]?.cwd, "/work/a");
  });

  it("preserves explicit manual project ordering while respecting pinned items", () => {
    const store = new AncillaStore();
    after(() => store.close());

    store.upsertProject("/work/a");
    store.upsertProject("/work/b");
    store.upsertProject("/work/c");

    store.setProjectOrder(["/work/c", "/work/a", "/work/b"]);
    assert.deepStrictEqual(
      store.listProjects().map((p) => p.cwd),
      ["/work/c", "/work/a", "/work/b"],
    );

    store.setPinned("/work/b", true);
    assert.strictEqual(store.listProjects()[0]?.cwd, "/work/b", "Pinned projects take precedence");
  });

  it("prioritizes pinned projects above unpinned projects in listings", () => {
    const store = new AncillaStore();
    after(() => store.close());

    store.upsertProject("D:\\work\\b");
    store.upsertProject("D:\\work\\a");
    store.setPinned("D:\\work\\a", true);

    const listed = store.listProjects();
    assert.strictEqual(listed[0]?.cwd, "D:\\work\\a");
    assert.strictEqual(listed[0]?.pinned, true);
  });

  it("manages thread titling settings with safe defaults and partial updates", () => {
    const store = new AncillaStore();
    after(() => store.close());

    assert.deepStrictEqual(store.getTitleSettings(), { enabled: true, modelId: null });
    assert.deepStrictEqual(store.setTitleSettings({ modelId: "model-x" }), { enabled: true, modelId: "model-x" });
    assert.deepStrictEqual(store.setTitleSettings({ enabled: false }), { enabled: false, modelId: "model-x" });
    assert.deepStrictEqual(store.getTitleSettings(), { enabled: false, modelId: "model-x" });
    assert.deepStrictEqual(store.setTitleSettings({ enabled: true, modelId: null }), { enabled: true, modelId: null });
  });

  it("persists sandbox preferences defaulting to enabled sandboxing", () => {
    const store = new AncillaStore();
    after(() => store.close());

    assert.deepStrictEqual(store.getSandboxSettings(), { disabled: false });
    assert.deepStrictEqual(store.setSandboxSettings({ disabled: true }), { disabled: true });
    assert.deepStrictEqual(store.getSandboxSettings(), { disabled: true });
    assert.deepStrictEqual(store.setSandboxSettings({}), { disabled: true });
    assert.deepStrictEqual(store.setSandboxSettings({ disabled: false }), { disabled: false });
  });

  it("persists YOLO operational posture defaulting to disabled", () => {
    const store = new AncillaStore();
    after(() => store.close());

    assert.deepStrictEqual(store.getYoloSettings(), { enabled: false });
    assert.deepStrictEqual(store.setYoloSettings({ enabled: true }), { enabled: true });
    assert.deepStrictEqual(store.getYoloSettings(), { enabled: true });
    assert.deepStrictEqual(store.setYoloSettings({}), { enabled: true });
    assert.deepStrictEqual(store.setYoloSettings({ enabled: false }), { enabled: false });
  });

  it("records sandbox status upon session initialization and preserves it across touches", () => {
    const store = new AncillaStore();
    after(() => store.close());

    const proj = store.upsertProject("/work/p");
    const createdSession = store.recordSession({ id: "s-sb1", projectId: proj.id, sandboxDisabled: true });
    assert.strictEqual(createdSession.sandboxDisabled, true);

    const reTouched = store.recordSession({ id: "s-sb1", projectId: proj.id, turnCount: 2 });
    assert.strictEqual(reTouched.sandboxDisabled, true);

    const untracked = store.recordSession({ id: "s-sb2", projectId: proj.id });
    assert.strictEqual(untracked.sandboxDisabled, null);
  });

  it("maintains user chosen model identifier independently from reported provider model", () => {
    const store = new AncillaStore();
    after(() => store.close());

    const proj = store.upsertProject("/work/proj");
    const started = store.recordSession({
      id: "s-model",
      projectId: proj.id,
      modelId: "muse-spark-1.3",
      chosenModelId: "muse-spark-1.3-custom",
    });
    assert.strictEqual(started.chosenModelId, "muse-spark-1.3-custom");

    const reTouched = store.recordSession({ id: "s-model", projectId: proj.id, modelId: "muse-spark-1.3" });
    assert.strictEqual(reTouched.modelId, "muse-spark-1.3");
    assert.strictEqual(reTouched.chosenModelId, "muse-spark-1.3-custom");

    store.updateSession("s-model", { modelId: "muse-spark-1.2", chosenModelId: "muse-spark-1.2" });
    assert.strictEqual(store.getSession("s-model")?.chosenModelId, "muse-spark-1.2");

    assert.strictEqual(store.recordSession({ id: "s-other", projectId: proj.id }).chosenModelId, null);
  });

  it("persists associated provider account identifier across sessions", () => {
    const store = new AncillaStore();
    after(() => store.close());

    const proj = store.upsertProject("/work/proj");
    const withoutAccount = store.recordSession({ id: "s-no-acc", projectId: proj.id });
    assert.strictEqual(withoutAccount.accountId, null);

    const withAccount = store.recordSession({ id: "s-acc", projectId: proj.id, accountId: "profile-work" });
    assert.strictEqual(withAccount.accountId, "profile-work");
    assert.strictEqual(store.findSession("s-acc")?.session.accountId, "profile-work");
    assert.strictEqual(store.findSession("s-no-acc")?.session.accountId, null);
  });

  it("prevents account identifier modification on subsequent session touch events", () => {
    const store = new AncillaStore();
    after(() => store.close());

    const proj = store.upsertProject("/work/proj");
    store.recordSession({ id: "s-acc-touch", projectId: proj.id, accountId: "fixed-account" });
    store.recordSession({ id: "s-acc-touch", projectId: proj.id, title: "Renamed Title" });
    assert.strictEqual(store.findSession("s-acc-touch")?.session.accountId, "fixed-account");
  });

  it("updates and clears project-level default provider account configurations", () => {
    const store = new AncillaStore();
    after(() => store.close());

    const proj = store.upsertProject("/work/proj");
    assert.strictEqual(proj.defaultAccountId, null);

    store.setDefaultAccount("/work/proj", "profile-default");
    assert.strictEqual(store.listProjects().find((p) => p.cwd === "/work/proj")?.defaultAccountId, "profile-default");

    store.setDefaultAccount("/work/proj", null);
    assert.strictEqual(store.listProjects().find((p) => p.cwd === "/work/proj")?.defaultAccountId, null);
  });

  it("manages multi-folder workspace structures under a single root project", () => {
    const store = new AncillaStore();
    after(() => store.close());

    store.upsertProject("/work/app");
    const withDocs = store.addProjectFolder("/work/app", "/work/app-docs");
    store.addProjectFolder("/work/app", "/work/app-infra");

    assert.deepStrictEqual(withDocs.folders.map((f) => f.cwd), ["/work/app", "/work/app-docs"]);
    assert.deepStrictEqual(store.listProjects().map((p) => p.cwd), ["/work/app"]);

    assert.deepStrictEqual(
      store.listProjects()[0]?.folders.map((f) => `${f.displayName}:${f.cwd}`),
      ["app:/work/app", "app-docs:/work/app-docs", "app-infra:/work/app-infra"],
    );

    assert.strictEqual(store.getProject("/work/app-docs")?.cwd, "/work/app-docs");
    assert.strictEqual(store.projectForFolder("/work/app-docs")?.cwd, "/work/app");
    assert.strictEqual(store.projectForFolder("/work/app")?.cwd, "/work/app");
    assert.strictEqual(store.projectForFolder("/unregistered/path"), null);

    assert.deepStrictEqual(store.listFolders().map((p) => p.cwd), ["/work/app", "/work/app-docs", "/work/app-infra"]);
    assert.strictEqual(store.addProjectFolder("/work/app", "/work/app-docs").folders.length, 3);
  });

  it("transitions projects into subfolders and restores them upon detachment", () => {
    const store = new AncillaStore();
    after(() => store.close());

    const appProject = store.upsertProject("/work/app");
    const docsProject = store.upsertProject("/work/docs");
    store.setPinned("/work/docs", true);

    store.recordSession({ id: "sess-d1", projectId: docsProject.id, activityAt: "2026-03-01T00:00:00.000Z" });
    store.recordSession({ id: "sess-a1", projectId: appProject.id, activityAt: "2026-01-01T00:00:00.000Z" });

    store.addProjectFolder("/work/app", "/work/docs");
    assert.deepStrictEqual(store.listProjects().map((p) => p.cwd), ["/work/app"]);
    assert.strictEqual(store.findSession("sess-d1")?.cwd, "/work/docs");
    assert.strictEqual(store.listProjects()[0]?.activityAt, "2026-03-01T00:00:00.000Z");
    assert.strictEqual(store.listProjects()[0]?.pinned, false);

    store.setPinned("/work/docs", true);
    assert.strictEqual(store.getProject("/work/docs")?.pinned, false);

    const testUsage = {
      turnId: null,
      modelId: "model-test",
      promptTokens: 10,
      outputTokens: 5,
      inputTokens: 10,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      durationMs: null,
      at: "2026-03-01T00:00:00.000Z",
    };
    store.recordUsage({ key: "u-1", sessionId: "sess-d1", ...testUsage });
    store.recordUsage({ key: "u-2", sessionId: "sess-a1", ...testUsage });
    assert.deepStrictEqual(store.listUsage().map((u) => u.projectCwd), ["/work/app", "/work/app"]);

    const detached = store.removeProjectFolder("/work/app", "/work/docs");
    assert.deepStrictEqual(detached.folders.map((f) => f.cwd), ["/work/app"]);
    assert.deepStrictEqual(store.listProjects().map((p) => p.cwd).sort(), ["/work/app", "/work/docs"]);
    assert.strictEqual(store.findSession("sess-d1")?.cwd, "/work/docs");
    assert.throws(() => store.removeProjectFolder("/work/app", "/work/docs"), ProjectFolderError);
  });

  it("rejects invalid folder grouping operations such as self-nesting or deep hierarchies", () => {
    const store = new AncillaStore();
    after(() => store.close());

    store.upsertProject("/work/app");
    store.upsertProject("/work/other");
    store.addProjectFolder("/work/app", "/work/app-docs");
    store.addProjectFolder("/work/other", "/work/other-docs");

    assert.throws(() => store.addProjectFolder("/work/app", "/work/app"), ProjectFolderError);
    assert.throws(() => store.addProjectFolder("/work/app-docs", "/work/deeper"), ProjectFolderError);
    assert.throws(() => store.addProjectFolder("/work/app", "/work/other"), ProjectFolderError);
    assert.throws(() => store.addProjectFolder("/unregistered", "/work/x"), ProjectFolderError);

    assert.strictEqual(store.getProject("/work/deeper"), null);
    assert.deepStrictEqual(store.listProjects().map((p) => p.cwd).sort(), ["/work/app", "/work/other"]);
  });

  it("handles folder membership stability and unhides parent project on folder addition", () => {
    const store = new AncillaStore();
    after(() => store.close());

    store.upsertProject("/work/app");
    store.upsertProject("/work/site");
    store.upsertProject("/work/old");
    store.upsertProject("/work/new");

    store.addProjectFolder("/work/app", "/work/new");
    store.addProjectFolder("/work/app", "/work/old");

    assert.deepStrictEqual(
      store.getProject("/work/app")?.folders.map((f) => f.cwd),
      ["/work/app", "/work/new", "/work/old"],
    );

    store.addProjectFolder("/work/app", "/work/old");
    assert.throws(() => store.addProjectFolder("/work/site", "/work/old"), /already a folder of app/);
    assert.strictEqual(store.getProject("/work/site")?.folders.length, 1);

    store.setHidden("/work/app", true);
    store.addProjectFolder("/work/app", "/work/extra");

    const unhiddenProject = store.listProjects().find((p) => p.cwd === "/work/app");
    assert.deepStrictEqual(unhiddenProject?.folders.map((f) => f.cwd), ["/work/app", "/work/new", "/work/old", "/work/extra"]);
    assert.strictEqual(store.listFolders().some((p) => p.cwd === "/work/old"), true);
  });

  it("synchronizes hidden status between parent projects and constituent folders", () => {
    const store = new AncillaStore();
    after(() => store.close());

    store.upsertProject("/work/app");
    store.addProjectFolder("/work/app", "/work/app-docs");

    store.setHidden("/work/app", true);
    assert.strictEqual(store.getProject("/work/app-docs")?.hidden, true);
    assert.strictEqual(store.listFolders().length, 0);

    store.upsertProject("/work/app-docs");
    assert.strictEqual(store.getProject("/work/app-docs")?.hidden, true);
    assert.strictEqual(store.getProject("/work/app-docs")?.folders.length, 1);

    store.setHidden("/work/app", false);
    assert.deepStrictEqual(store.listFolders().map((p) => p.cwd), ["/work/app", "/work/app-docs"]);
  });

  it("upgrades pre-existing database schemas seamlessly applying missing columns", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ancilla-store-migration-"));
    const dbFilePath = join(tempDir, "legacy.db");

    const legacyDb = new DatabaseSync(dbFilePath);
    legacyDb.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cwd TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO projects (cwd, display_name, pinned, created_at, updated_at)
        VALUES ('/work/legacy', 'legacy', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacyDb.close();

    const migratedStore = new AncillaStore(dbFilePath);
    after(() => migratedStore.close());

    const projectList = migratedStore.listProjects();
    assert.deepStrictEqual(projectList.map((p) => p.cwd), ["/work/legacy"]);
    assert.deepStrictEqual(projectList[0]?.folders, [{ cwd: "/work/legacy", displayName: "legacy" }]);
    assert.strictEqual(projectList[0]?.pinned, true);

    const folderUpdated = migratedStore.addProjectFolder("/work/legacy", "/work/legacy-sub");
    assert.deepStrictEqual(folderUpdated.folders.map((f) => f.cwd), ["/work/legacy", "/work/legacy-sub"]);
  });

  describe("deep research", () => {
    function seed(store: AncillaStore): void {
      const project = store.upsertProject("/work/p");
      store.recordSession({ id: "s1", projectId: project.id });
      store.recordSession({ id: "s2", projectId: project.id });
    }

    function stateFor(runId: string): ResearchRunState {
      return {
        version: 1,
        runId,
        eventSeq: 0,
        question: "q",
        config: DEFAULT_RESEARCH_CONFIG,
        phase: "researching",
        brief: "brief",
        inputLanguage: "en",
        targetLanguage: "en",
        draft: null,
        rounds: [],
        registry: [],
        curated: [],
        notes: [],
        consecutiveFailures: 0,
        aborted: false,
        abortReason: null,
        usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, totalTokens: 3 },
        startedAt: "2026-09-26T10:00:00.000Z",
        researchDeadlineAt: "2026-09-26T10:10:00.000Z",
        nextAgentId: 1,
      };
    }

    it("round-trips a run with its config, state, report and failure", () => {
      const store = new AncillaStore();
      after(() => store.close());
      seed(store);
      const created = store.createResearchRun({
        id: "r1",
        sessionId: "s1",
        commandId: "c1",
        question: "What is new in SQLite 3.50?",
        config: { ...DEFAULT_RESEARCH_CONFIG, maxRounds: 4, models: { supervisor: "m-sup", worker: null, writer: null } },
        createdAt: "2026-09-26T10:00:00.000Z",
      });
      assert.equal(created.status, "queued");
      assert.equal(created.state, null);
      assert.equal(created.report, null);
      assert.equal(created.reportPath, null);
      assert.equal(created.config.maxRounds, 4);
      assert.equal(created.config.models.supervisor, "m-sup");
      assert.equal(store.getResearchRunByCommand("c1")?.id, "r1");
      assert.equal(store.getResearchRunByCommand("nope"), null);

      const running = store.updateResearchRun("r1", { status: "running", startedAt: "2026-09-26T10:00:01.000Z", state: stateFor("r1") });
      assert.equal(running?.status, "running");
      assert.equal(running?.startedAt, "2026-09-26T10:00:01.000Z");
      assert.equal(running?.state?.phase, "researching");
      assert.equal(running?.state?.usage.totalTokens, 3);

      const done = store.updateResearchRun("r1", {
        status: "completed",
        report: "# Report",
        reportPath: ".ancilla/research/r1/report.md",
        endedAt: "2026-09-26T10:09:00.000Z",
      });
      assert.equal(done?.report, "# Report");
      assert.equal(done?.reportPath, ".ancilla/research/r1/report.md");
      assert.equal(done?.endedAt, "2026-09-26T10:09:00.000Z");
      assert.equal(store.updateResearchRun("r1", { failure: "quota: out of tokens" })?.failure, "quota: out of tokens");
      assert.equal(store.updateResearchRun("missing", { status: "failed" }), null);
      assert.throws(() => store.createResearchRun({ id: "r2", sessionId: "s1", commandId: "c1", question: "again", config: DEFAULT_RESEARCH_CONFIG }), /UNIQUE/);
    });

    it("lists a thread's runs oldest first and finds the ones still in flight", () => {
      const store = new AncillaStore();
      after(() => store.close());
      seed(store);
      store.createResearchRun({ id: "r2", sessionId: "s1", commandId: "c2", question: "b", config: DEFAULT_RESEARCH_CONFIG, createdAt: "2026-09-26T11:00:00.000Z" });
      store.createResearchRun({ id: "r1", sessionId: "s1", commandId: "c1", question: "a", config: DEFAULT_RESEARCH_CONFIG, createdAt: "2026-09-26T10:00:00.000Z" });
      store.createResearchRun({ id: "r3", sessionId: "s2", commandId: "c3", question: "c", config: DEFAULT_RESEARCH_CONFIG, createdAt: "2026-09-26T12:00:00.000Z" });
      assert.deepEqual(store.listResearchRuns("s1").map((r) => r.id), ["r1", "r2"]);
      assert.deepEqual(store.listResearchRuns("s2").map((r) => r.id), ["r3"]);
      assert.deepEqual(store.listResearchRuns("s9"), []);
      store.updateResearchRun("r1", { status: "running" });
      store.updateResearchRun("r3", { status: "completed" });
      assert.deepEqual(store.listRunningResearchRuns().map((r) => r.id), ["r1", "r2"], "queued and running both count as in flight");
    });

    it("keeps events once per (run, seq) and pages them in order", () => {
      const store = new AncillaStore();
      after(() => store.close());
      seed(store);
      store.createResearchRun({ id: "r1", sessionId: "s1", commandId: "c1", question: "a", config: DEFAULT_RESEARCH_CONFIG });
      const event = (seq: number, type: ResearchEvent["type"], extra: Partial<ResearchEvent> = {}): ResearchEvent => ({
        type,
        runId: "r1",
        seq,
        at: `2026-09-26T10:00:0${seq}.000Z`,
        phase: "researching",
        round: null,
        agentId: null,
        payload: { seq },
        ...extra,
      });
      assert.equal(store.appendResearchEvent(event(2, "scope_started")), true);
      assert.equal(store.appendResearchEvent(event(1, "run_started", { phase: "scoping" })), true);
      assert.equal(store.appendResearchEvent(event(3, "subagent_started", { round: 1, agentId: 2 })), true);
      assert.equal(store.appendResearchEvent(event(2, "run_failed")), false, "a replayed seq is ignored");
      assert.equal(store.lastResearchEventSeq("r1"), 3);
      assert.equal(store.lastResearchEventSeq("none"), 0);
      const all = store.listResearchEvents("r1");
      assert.deepEqual(all.map((e) => [e.seq, e.type]), [[1, "run_started"], [2, "scope_started"], [3, "subagent_started"]]);
      assert.equal(all[0]?.phase, "scoping");
      assert.deepEqual(all[2]?.payload, { seq: 3 });
      assert.equal(all[2]?.round, 1);
      assert.equal(all[2]?.agentId, 2);
      assert.deepEqual(store.listResearchEvents("r1", 1).map((e) => e.seq), [2, 3]);
      assert.deepEqual(store.listResearchEvents("r1", 0, 2).map((e) => e.seq), [1, 2]);
    });

    it("records which worker sessions a run used", () => {
      const store = new AncillaStore();
      after(() => store.close());
      seed(store);
      const project = store.getProject("/work/p")!;
      store.createResearchRun({ id: "r1", sessionId: "s1", commandId: "c1", question: "a", config: DEFAULT_RESEARCH_CONFIG });
      store.recordSession({ id: "w1", projectId: project.id, origin: "research-worker", title: "Research worker A1" });
      store.updateSession("w1", { archived: true });
      store.addResearchWorker({ runId: "r1", workerSessionId: "w1", round: 1, agentId: 1, status: "working" });
      store.addResearchWorker({ runId: "r1", workerSessionId: "w2", round: 1, agentId: 2, status: "working" });
      store.updateResearchWorker("r1", "w1", "completed");
      assert.deepEqual(
        store.listResearchWorkers("r1").map((w) => [w.agentId, w.status]),
        [[1, "completed"], [2, "working"]],
      );
      assert.deepEqual(store.listSessionsByProject(project.id).map((s) => s.id).sort(), ["s1", "s2"], "worker sessions stay out of the sidebar");
      assert.equal(store.getSession("w1")?.origin, "research-worker");
    });

    it("returns state null for a stored state the engine did not write", () => {
      const store = new AncillaStore();
      after(() => store.close());
      seed(store);
      store.createResearchRun({ id: "r1", sessionId: "s1", commandId: "c1", question: "a", config: DEFAULT_RESEARCH_CONFIG });
      const stored = (state: unknown) => store.updateResearchRun("r1", { state: state as ResearchRunState })?.state;
      assert.equal(stored({}), null, "an empty object is not a state");
      assert.equal(stored({ ...stateFor("r1"), version: 2 }), null, "another version is not read");
      assert.equal(stored({ ...stateFor("r1"), rounds: "none" }), null, "rounds must be an array");
      assert.equal(stored({ ...stateFor("r1"), notes: null }), null, "notes must be an array");
      assert.equal(stored(stateFor("r1"))?.phase, "researching", "a well-formed state still round-trips");
      assert.equal(stored(null), null);
      assert.equal(store.getResearchRun("r1")?.status, "queued", "the rest of the row is unaffected");
      assert.equal(researchStateProblem({}), "state version null is not 1");
      assert.equal(researchStateProblem({ version: 1, rounds: [], registry: [], curated: [], notes: "x" }), "state.notes is not an array");
      assert.equal(researchStateProblem("text"), "state is not an object");
      assert.equal(researchStateProblem(null), null);
      assert.equal(researchStateProblem(stateFor("r1")), null);
    });

    it("keeps research settings clamped and merged", () => {
      const store = new AncillaStore();
      after(() => store.close());
      const initial = store.getResearchSettings();
      assert.equal(initial.enabled, true);
      assert.equal(initial.config.maxRounds, DEFAULT_RESEARCH_CONFIG.maxRounds);
      const next = store.setResearchSettings({ enabled: false, config: { maxRounds: 9999, models: { supervisor: "m1", worker: null, writer: null } } });
      assert.equal(next.enabled, false);
      assert.equal(next.config.maxRounds, 500, "clamped to the ceiling");
      assert.equal(next.config.models.supervisor, "m1");
      const merged = store.setResearchSettings({ config: { windowMaxMinutes: 20 } });
      assert.equal(merged.enabled, false, "enabled is kept when the patch has no say");
      assert.equal(merged.config.maxRounds, 500, "earlier config values survive a partial patch");
      assert.equal(merged.config.windowMaxMinutes, 20);
      assert.deepEqual(store.getResearchSettings(), merged);
    });
  });
});
