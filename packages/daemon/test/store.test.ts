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
  });

  it("groups sessions under projects by directory", () => {
    const store = new AncillaStore();
    after(() => store.close());
    const project = store.upsertProject("D:\\work\\ancilla");
    assert.equal(project.displayName, "ancilla");
    assert.equal(project.pinned, false);
    const same = store.upsertProject("D:\\work\\ancilla");
    assert.equal(same.id, project.id);
    const session = store.recordSession({ id: "s1", projectId: project.id });
    assert.equal(session.turnCount, 0);
    assert.equal(session.origin, "ancilla");
    store.recordTurn("t1", "s1");
    store.updateTurnStatus("t1", "completed");
    const sessions = store.listSessionsByProject(project.id);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.turnCount, 1);
    assert.equal(sessions[0]?.id, "s1");
  });

  it("keeps the commands Ancilla ran for a thread", () => {
    const store = new AncillaStore();
    after(() => store.close());
    const project = store.upsertProject("/work/p");
    store.recordSession({ id: "s1", projectId: project.id });
    store.addShellRun({
      id: "r1",
      sessionId: "s1",
      command: "ls -la",
      exitCode: 0,
      output: "total 0",
      truncated: false,
      durationMs: 12,
      at: "2026-09-11T22:00:00.000Z",
    });
    store.addShellRun({
      id: "r2",
      sessionId: "s1",
      command: "false",
      exitCode: 1,
      output: "",
      truncated: true,
      durationMs: null,
      at: "2026-09-11T22:00:01.000Z",
    });
    const runs = store.listShellRuns("s1");
    assert.deepEqual(runs.map((r) => r.id), ["r1", "r2"]);
    assert.equal(runs[0]?.output, "total 0");
    assert.equal(runs[1]?.exitCode, 1);
    assert.equal(runs[1]?.truncated, true);
    assert.equal(runs[1]?.durationMs, null);
    assert.deepEqual(store.listShellRuns("other"), []);
  });

  it("keeps the bytes of files sent with a prompt", () => {
    const store = new AncillaStore();
    after(() => store.close());
    const project = store.upsertProject("/work/p");
    store.recordSession({ id: "s1", projectId: project.id });
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const saved = store.addAttachment({
      id: "a1",
      sessionId: "s1",
      turnId: "t1",
      ord: 0,
      name: "shot.png",
      mediaType: "image/png",
      kind: "image",
      width: 10,
      height: 20,
      bytes,
    });
    assert.equal(saved.name, "shot.png");
    assert.equal(saved.kind, "image");
    assert.equal(saved.turnId, "t1");
    assert.deepEqual(store.listAttachments("s1").map((a) => a.id), ["a1"]);
    assert.deepEqual(store.readAttachment("a1")?.bytes, bytes);
    assert.equal(store.readAttachment("missing"), null);
  });

  it("never lets a weaker title source overwrite a stronger one", () => {
    const store = new AncillaStore();
    after(() => store.close());
    const project = store.upsertProject("/work/p");
    const created = store.recordSession({ id: "s1", projectId: project.id });
    assert.equal(created.titleSource, "placeholder");
    store.recordSession({ id: "s1", projectId: project.id, title: "Fix the build", titleSource: "auto" });
    assert.equal(store.getSession("s1")?.title, "Fix the build");
    store.updateSession("s1", { title: "Renamed", titleSource: "user" });
    store.recordSession({ id: "s1", projectId: project.id, title: "Auto again", titleSource: "auto" });
    assert.equal(store.getSession("s1")?.title, "Renamed");
    assert.equal(store.findSession("s1")?.cwd, "/work/p");
  });

  it("archives sessions and hides projects without deleting them", () => {
    const store = new AncillaStore();
    after(() => store.close());
    const project = store.upsertProject("/work/p");
    store.recordSession({ id: "s1", projectId: project.id });
    store.recordSession({ id: "s2", projectId: project.id });
    store.updateSession("s1", { archived: true });
    assert.deepEqual(
      store.listSessionsByProject(project.id).map((s) => s.id),
      ["s2"],
    );
    assert.equal(store.listSessionsByProject(project.id, { includeArchived: true }).length, 2);
    store.setHidden("/work/p", true);
    assert.equal(store.listProjects().length, 0);
    assert.equal(store.listProjects({ includeHidden: true }).length, 1);
    store.upsertProject("/work/p");
    assert.equal(store.listProjects().length, 0, "discovery alone must not unhide a project");
  });

  it("orders projects by their latest session activity", () => {
    const store = new AncillaStore();
    after(() => store.close());
    const a = store.upsertProject("/work/a");
    const b = store.upsertProject("/work/b");
    store.recordSession({ id: "a1", projectId: a.id, activityAt: "2026-01-01T00:00:00.000Z" });
    store.recordSession({ id: "b1", projectId: b.id, activityAt: "2026-02-01T00:00:00.000Z" });
    assert.deepEqual(
      store.listProjects().map((p) => p.cwd),
      ["/work/b", "/work/a"],
    );
    store.recordSession({ id: "a1", projectId: a.id, activityAt: "2026-03-01T00:00:00.000Z" });
    assert.equal(store.listProjects()[0]?.cwd, "/work/a");
  });

  it("keeps the order the user dragged projects into", () => {
    const store = new AncillaStore();
    after(() => store.close());
    store.upsertProject("/work/a");
    store.upsertProject("/work/b");
    store.upsertProject("/work/c");
    store.setProjectOrder(["/work/c", "/work/a", "/work/b"]);
    assert.deepEqual(
      store.listProjects().map((p) => p.cwd),
      ["/work/c", "/work/a", "/work/b"],
    );
    store.setPinned("/work/b", true);
    assert.equal(store.listProjects()[0]?.cwd, "/work/b", "a pinned project still comes first");
  });

  it("pins projects to the top of the sidebar order", () => {
    const store = new AncillaStore();
    after(() => store.close());
    store.upsertProject("D:\\work\\b");
    store.upsertProject("D:\\work\\a");
    store.setPinned("D:\\work\\a", true);
    const projects = store.listProjects();
    assert.equal(projects[0]?.cwd, "D:\\work\\a");
    assert.equal(projects[0]?.pinned, true);
  });

  it("keeps thread-title settings, defaulting on and merging patches", () => {
    const store = new AncillaStore();
    after(() => store.close());
    assert.deepEqual(store.getTitleSettings(), { enabled: true, modelId: null });
    assert.deepEqual(store.setTitleSettings({ modelId: "m1" }), { enabled: true, modelId: "m1" });
    assert.deepEqual(store.setTitleSettings({ enabled: false }), { enabled: false, modelId: "m1" });
    assert.deepEqual(store.getTitleSettings(), { enabled: false, modelId: "m1" });
    assert.deepEqual(store.setTitleSettings({ enabled: true, modelId: null }), { enabled: true, modelId: null });
  });

  it("keeps sandbox settings, defaulting to sandbox-on", () => {
    const store = new AncillaStore();
    after(() => store.close());
    assert.deepEqual(store.getSandboxSettings(), { disabled: false });
    assert.deepEqual(store.setSandboxSettings({ disabled: true }), { disabled: true });
    assert.deepEqual(store.getSandboxSettings(), { disabled: true });
    assert.deepEqual(store.setSandboxSettings({}), { disabled: true }, "an empty patch changes nothing");
    assert.deepEqual(store.setSandboxSettings({ disabled: false }), { disabled: false });
  });

  it("keeps YOLO settings, defaulting to off", () => {
    const store = new AncillaStore();
    after(() => store.close());
    assert.deepEqual(store.getYoloSettings(), { enabled: false });
    assert.deepEqual(store.setYoloSettings({ enabled: true }), { enabled: true });
    assert.deepEqual(store.getYoloSettings(), { enabled: true });
    assert.deepEqual(store.setYoloSettings({}), { enabled: true }, "an empty patch changes nothing");
    assert.deepEqual(store.setYoloSettings({ enabled: false }), { enabled: false });
  });

  it("records each session's sandbox posture at creation, never on touch", () => {
    const store = new AncillaStore();
    after(() => store.close());
    const project = store.upsertProject("/work/p");
    const created = store.recordSession({ id: "s1", projectId: project.id, sandboxDisabled: true });
    assert.equal(created.sandboxDisabled, true);
    const touched = store.recordSession({ id: "s1", projectId: project.id, turnCount: 2 });
    assert.equal(touched.sandboxDisabled, true, "a later touch keeps the creation posture");
    const unknown = store.recordSession({ id: "s2", projectId: project.id });
    assert.equal(unknown.sandboxDisabled, null, "sessions recorded before tracking stay unknown");
  });

  it("keeps the model the user chose apart from the one Muse reports", () => {
    const store = new AncillaStore();
    after(() => store.close());
    const project = store.upsertProject("/work/proj");
    const started = store.recordSession({ id: "s1", projectId: project.id, modelId: "muse-spark-1.3", chosenModelId: "muse-spark-1.3-contributor" });
    assert.equal(started.chosenModelId, "muse-spark-1.3-contributor");
    // Discovery and resume report what Muse says and leave the pick alone.
    const touched = store.recordSession({ id: "s1", projectId: project.id, modelId: "muse-spark-1.3" });
    assert.equal(touched.modelId, "muse-spark-1.3");
    assert.equal(touched.chosenModelId, "muse-spark-1.3-contributor");
    store.updateSession("s1", { modelId: "muse-spark-1.2", chosenModelId: "muse-spark-1.2" });
    assert.equal(store.getSession("s1")?.chosenModelId, "muse-spark-1.2");
    assert.equal(store.recordSession({ id: "s2", projectId: project.id }).chosenModelId, null);
  });

  it("records a session's account and reads it back, defaulting to null", () => {
    const store = new AncillaStore();
    after(() => store.close());
    const project = store.upsertProject("/work/proj");
    const noAccount = store.recordSession({ id: "s1", projectId: project.id });
    assert.equal(noAccount.accountId, null);
    const withAccount = store.recordSession({ id: "s2", projectId: project.id, accountId: "work" });
    assert.equal(withAccount.accountId, "work");
    assert.equal(store.findSession("s2")?.session.accountId, "work");
    assert.equal(store.findSession("s1")?.session.accountId, null);
  });

  it("never overwrites a session's account on a later touch", () => {
    const store = new AncillaStore();
    after(() => store.close());
    const project = store.upsertProject("/work/proj");
    store.recordSession({ id: "s1", projectId: project.id, accountId: "work" });
    store.recordSession({ id: "s1", projectId: project.id, title: "Renamed" });
    assert.equal(store.findSession("s1")?.session.accountId, "work");
  });

  it("sets and clears a project's default account", () => {
    const store = new AncillaStore();
    after(() => store.close());
    const project = store.upsertProject("/work/proj");
    assert.equal(project.defaultAccountId, null);
    store.setDefaultAccount("/work/proj", "work");
    assert.equal(store.listProjects().find((p) => p.cwd === "/work/proj")?.defaultAccountId, "work");
    store.setDefaultAccount("/work/proj", null);
    assert.equal(store.listProjects().find((p) => p.cwd === "/work/proj")?.defaultAccountId, null);
  });

  it("lists a project's folders with its own first, and never a folder as a project", () => {
    const store = new AncillaStore();
    after(() => store.close());
    store.upsertProject("/work/app");
    const updated = store.addProjectFolder("/work/app", "/work/app-docs");
    store.addProjectFolder("/work/app", "/work/app-infra");
    assert.deepEqual(updated.folders.map((f) => f.cwd), ["/work/app", "/work/app-docs"]);
    assert.deepEqual(store.listProjects().map((p) => p.cwd), ["/work/app"], "a folder is not listed on its own");
    assert.deepEqual(
      store.listProjects()[0]?.folders.map((f) => `${f.displayName}:${f.cwd}`),
      ["app:/work/app", "app-docs:/work/app-docs", "app-infra:/work/app-infra"],
    );
    assert.equal(store.getProject("/work/app-docs")?.cwd, "/work/app-docs", "a folder's own row still answers by cwd");
    assert.equal(store.projectForFolder("/work/app-docs")?.cwd, "/work/app", "a folder is owned by its project");
    assert.equal(store.projectForFolder("/work/app")?.cwd, "/work/app", "a project owns itself");
    assert.equal(store.projectForFolder("/nowhere"), null);
    assert.deepEqual(store.listFolders().map((p) => p.cwd), ["/work/app", "/work/app-docs", "/work/app-infra"]);
    assert.equal(store.addProjectFolder("/work/app", "/work/app-docs").folders.length, 3, "adding a folder twice changes nothing");
  });

  it("moves an existing project's sessions along when it becomes a folder, and back out when removed", () => {
    const store = new AncillaStore();
    after(() => store.close());
    const app = store.upsertProject("/work/app");
    const docs = store.upsertProject("/work/docs");
    store.setPinned("/work/docs", true);
    store.recordSession({ id: "d1", projectId: docs.id, activityAt: "2026-03-01T00:00:00.000Z" });
    store.recordSession({ id: "a1", projectId: app.id, activityAt: "2026-01-01T00:00:00.000Z" });
    store.addProjectFolder("/work/app", "/work/docs");
    assert.deepEqual(store.listProjects().map((p) => p.cwd), ["/work/app"]);
    assert.equal(store.findSession("d1")?.cwd, "/work/docs", "the session keeps running in its own folder");
    assert.equal(store.listProjects()[0]?.activityAt, "2026-03-01T00:00:00.000Z", "a folder's threads count as the project's activity");
    assert.equal(store.listProjects()[0]?.pinned, false);
    store.setPinned("/work/docs", true);
    assert.equal(store.getProject("/work/docs")?.pinned, false, "a folder cannot be pinned");
    const usage = { turnId: null, modelId: "m", promptTokens: 1, outputTokens: 1, inputTokens: 1, cachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, durationMs: null, at: "2026-03-01T00:00:00.000Z" };
    store.recordUsage({ key: "u1", sessionId: "d1", ...usage });
    store.recordUsage({ key: "u2", sessionId: "a1", ...usage });
    assert.deepEqual(store.listUsage().map((row) => row.projectCwd), ["/work/app", "/work/app"], "usage rolls up to the project");

    const parent = store.removeProjectFolder("/work/app", "/work/docs");
    assert.deepEqual(parent.folders.map((f) => f.cwd), ["/work/app"]);
    assert.deepEqual(store.listProjects().map((p) => p.cwd).sort(), ["/work/app", "/work/docs"], "a removed folder is a project again");
    assert.equal(store.findSession("d1")?.cwd, "/work/docs");
    assert.throws(() => store.removeProjectFolder("/work/app", "/work/docs"), ProjectFolderError);
  });

  it("refuses folders that would nest, or a project as a folder of itself", () => {
    const store = new AncillaStore();
    after(() => store.close());
    store.upsertProject("/work/app");
    store.upsertProject("/work/other");
    store.addProjectFolder("/work/app", "/work/app-docs");
    store.addProjectFolder("/work/other", "/work/other-docs");
    assert.throws(() => store.addProjectFolder("/work/app", "/work/app"), ProjectFolderError);
    assert.throws(() => store.addProjectFolder("/work/app-docs", "/work/deeper"), ProjectFolderError, "a folder cannot take folders");
    assert.throws(() => store.addProjectFolder("/work/app", "/work/other"), ProjectFolderError, "a project with folders must be emptied first");
    assert.throws(() => store.addProjectFolder("/nowhere", "/work/x"), ProjectFolderError);
    assert.equal(store.getProject("/work/deeper"), null, "a refused folder leaves no row behind");
    assert.deepEqual(store.listProjects().map((p) => p.cwd).sort(), ["/work/app", "/work/other"]);
  });

  it("keeps a folder with the project that has it, lists folders in the order they were added, and reveals a hidden project a folder joins", () => {
    const store = new AncillaStore();
    after(() => store.close());
    store.upsertProject("/work/app");
    store.upsertProject("/work/site");
    // A row made long before it joins: the order of joining wins, not the age of the row.
    store.upsertProject("/work/old");
    store.upsertProject("/work/new");
    store.addProjectFolder("/work/app", "/work/new");
    store.addProjectFolder("/work/app", "/work/old");
    assert.deepEqual(
      store.getProject("/work/app")?.folders.map((f) => f.cwd),
      ["/work/app", "/work/new", "/work/old"],
    );
    // Adding it again is a no-op; adding it to another project is refused rather than moving its threads.
    store.addProjectFolder("/work/app", "/work/old");
    assert.throws(() => store.addProjectFolder("/work/site", "/work/old"), /already a folder of app/);
    assert.equal(store.getProject("/work/site")?.folders.length, 1);
    // A project the user removed comes back, folders and all, when a folder is added to it.
    store.setHidden("/work/app", true);
    store.addProjectFolder("/work/app", "/work/extra");
    const shown = store.listProjects().find((p) => p.cwd === "/work/app");
    assert.deepEqual(shown?.folders.map((f) => f.cwd), ["/work/app", "/work/new", "/work/old", "/work/extra"]);
    assert.equal(store.listFolders().some((p) => p.cwd === "/work/old"), true);
  });

  it("hides a project's folders with it, and brings them back with it", () => {
    const store = new AncillaStore();
    after(() => store.close());
    store.upsertProject("/work/app");
    store.addProjectFolder("/work/app", "/work/app-docs");
    store.setHidden("/work/app", true);
    assert.equal(store.getProject("/work/app-docs")?.hidden, true);
    assert.equal(store.listFolders().length, 0);
    store.upsertProject("/work/app-docs");
    assert.equal(store.getProject("/work/app-docs")?.hidden, true, "discovery in a folder does not unhide it");
    assert.equal(store.getProject("/work/app-docs")?.folders.length, 1, "discovery leaves the folder where it is");
    store.setHidden("/work/app", false);
    assert.deepEqual(store.listFolders().map((p) => p.cwd), ["/work/app", "/work/app-docs"]);
  });

  it("adds the parent column to a database made before folders existed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ancilla-store-"));
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cwd TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO projects (cwd, display_name, pinned, created_at, updated_at)
        VALUES ('/work/old', 'old', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    old.close();
    const store = new AncillaStore(path);
    after(() => store.close());
    const projects = store.listProjects();
    assert.deepEqual(projects.map((p) => p.cwd), ["/work/old"]);
    assert.deepEqual(projects[0]?.folders, [{ cwd: "/work/old", displayName: "old" }]);
    assert.equal(projects[0]?.pinned, true, "existing rows keep their data");
    assert.deepEqual(store.addProjectFolder("/work/old", "/work/old-docs").folders.map((f) => f.cwd), ["/work/old", "/work/old-docs"]);
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
      // Sorted: the two threads were recorded within the same millisecond, so their listing order is not fixed.
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
