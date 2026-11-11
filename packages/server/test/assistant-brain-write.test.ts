import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isProtectedProjectPath, runBrainWriteStep, validateCheckCommand } from "../src/assistant/brain-step.js";
import { Executive, type ExecutiveHost } from "../src/assistant/executive.js";
import { MemoryStore } from "../src/assistant/store.js";
import { TaskStore } from "../src/assistant/tasks.js";
import { withTextTools, type BrainEvent, type BrainProvider, type BrainRequest } from "../src/voice/brain.js";

type ScriptStep = {
  text?: string;
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
  error?: string;
};

class ScriptedWriteBrain implements BrainProvider {
  readonly id = "scripted-write";
  readonly label = "Scripted Write Model";
  readonly capabilities = { tools: true, speculative: false, local: true };
  readonly requests: BrainRequest[] = [];
  private index = 0;

  constructor(private readonly steps: ScriptStep[]) {}

  async *stream(request: BrainRequest): AsyncGenerator<BrainEvent> {
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const step = this.steps[this.index] ?? { text: "Done." };
    this.index += 1;
    if (step.error) {
      yield { type: "error", message: step.error, retryable: false };
      return;
    }
    if (step.text) yield { type: "text", delta: step.text };
    for (const [i, call] of (step.calls ?? []).entries()) {
      yield { type: "tool", call: { id: `call_${this.index}_${i}`, name: call.name, arguments: JSON.stringify(call.args) } };
    }
    yield { type: "done", reason: step.calls?.length ? "tool" : "stop" };
  }
}

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "ancilla-brain-write-"));
}

describe("validateCheckCommand and isProtectedProjectPath", () => {
  it("protects .git, .githooks, and .env secrets while allowing .env.example templates and normal code paths", () => {
    assert.match(isProtectedProjectPath(".git/config") ?? "", /\.git/);
    assert.match(isProtectedProjectPath("sub/.git/hooks/pre-commit") ?? "", /\.git/);
    assert.match(isProtectedProjectPath(".githooks/commit-msg") ?? "", /\.githooks/);
    assert.match(isProtectedProjectPath(".env") ?? "", /\.env/);
    assert.match(isProtectedProjectPath(".env.production") ?? "", /\.env/);
    assert.match(isProtectedProjectPath("apps/web/.env.local") ?? "", /\.env/);
    assert.equal(isProtectedProjectPath(".env.example"), null);
    assert.equal(isProtectedProjectPath("config/.env.template"), null);
    assert.equal(isProtectedProjectPath("src/index.ts"), null);
  });

  it("allows only non-shell verification binaries and read-only git inspection subcommands", () => {
    assert.deepEqual(validateCheckCommand("npm", ["test"]), { ok: true, program: "npm", args: ["test"] });
    assert.deepEqual(validateCheckCommand("git", ["status", "--short"]), { ok: true, program: "git", args: ["status", "--short"] });
    assert.deepEqual(validateCheckCommand("git", ["--no-pager", "diff"]), { ok: true, program: "git", args: ["--no-pager", "diff"] });

    for (const bad of ["bash", "sh", "powershell", "/usr/bin/node", "../node", ""]) {
      assert.equal(validateCheckCommand(bad, []).ok, false, bad);
    }
    for (const badGit of [
      ["push"],
      ["commit", "-m", "x"],
      ["reset", "--hard"],
      ["clean", "-fd"],
      ["checkout", "."],
      ["-C", "/tmp", "status"],
      ["-c", "core.sshCommand=evil", "status"],
      ["diff", "--output=/tmp/leak"],
      ["diff", "--ext-diff"],
      [],
    ]) {
      assert.equal(validateCheckCommand("git", badGit).ok, false, badGit.join(" "));
    }
  });
});

describe("runBrainWriteStep workspace execution and confinement", () => {
  it("reads, edits (preserving $ replacement tokens), creates files, and runs verification checks", async () => {
    const root = makeTempProject();
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "math.ts"), "export const port = 3000;\nexport const tag = 'v1';\nexport const dup = 1;\nexport const dup2 = 1;\n");

      const brain = new ScriptedWriteBrain([
        {
          calls: [
            { name: "read_file", args: { path: "src/math.ts" } },
            { name: "edit_file", args: { path: "src/math.ts", old_text: "export const port = 3000;", new_text: "export const port = 4321;\nexport const pattern = '$1 $& $$';" } },
            { name: "write_file", args: { path: "docs/SETUP.md", content: "# Setup\nRuns on 4321.\n" } },
            { name: "run_check", args: { program: "npm", args: ["test"] } },
          ],
        },
        {
          calls: [
            // Ambiguous edit without replace_all fails cleanly, then succeeds with replace_all: true
            { name: "edit_file", args: { path: "src/math.ts", old_text: "= 1;", new_text: "= 2;" } },
            { name: "edit_file", args: { path: "src/math.ts", old_text: "= 1;", new_text: "= 2;", replace_all: true } },
          ],
        },
        { text: "Updated port to 4321, added docs/SETUP.md, and verified npm test passes." },
      ]);

      const checkCalls: Array<{ program: string; args: string[]; cwd: string }> = [];
      const outcome = await runBrainWriteStep({
        brain,
        root,
        prompt: "Change port to 4321, write docs/SETUP.md, and run npm test.",
        signal: new AbortController().signal,
        execCheck: async (program, args, cwd) => {
          checkCalls.push({ program, args, cwd });
          return { exitCode: 0, output: "all 12 tests passed", timedOut: false };
        },
      });

      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.deepEqual(outcome.changedFiles, ["src/math.ts", "docs/SETUP.md"]);
      assert.deepEqual(outcome.checksRun, ["npm test (exit 0)"]);
      assert.equal(checkCalls.length, 1);
      assert.equal(checkCalls[0]?.program, "npm");

      const mathContent = readFileSync(join(root, "src", "math.ts"), "utf8");
      assert.match(mathContent, /export const port = 4321;/);
      assert.ok(mathContent.includes("export const pattern = '$1 $& $$';"), "$ tokens are never corrupted by String.replace");
      assert.match(mathContent, /export const dup = 2;\nexport const dup2 = 2;/);
      assert.equal(readFileSync(join(root, "docs", "SETUP.md"), "utf8"), "# Setup\nRuns on 4321.\n");

      // Check that the ambiguous match produced a helpful tool error before the replace_all succeeded
      const round2Tools = brain.requests[2]?.messages.filter((m) => m.role === "tool") ?? [];
      assert.match(String(round2Tools[4]?.content ?? ""), /matched 2 locations/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses path traversal, symlinks escaping the project, protected files, and disallowed commands", async () => {
    const root = makeTempProject();
    const outside = makeTempProject();
    try {
      writeFileSync(join(outside, "secret.txt"), "unchanged");
      let createdLinks = false;
      try {
        symlinkSync(outside, join(root, "escape-dir"), "dir");
        symlinkSync(join(outside, "secret.txt"), join(root, "escape-file.txt"), "file");
        createdLinks = true;
      } catch {
        // Symlink creation may require elevation on non-developer Windows hosts; WSL/Linux/macOS always run this check.
      }

      const calls: Array<{ name: string; args: Record<string, unknown> }> = [
        { name: "write_file", args: { path: "../outside.txt", content: "bad" } },
        { name: "write_file", args: { path: ".git/config", content: "bad" } },
        { name: "write_file", args: { path: ".env", content: "API_KEY=bad" } },
        { name: "run_check", args: { program: "bash", args: ["-c", "echo bad"] } },
        { name: "run_check", args: { program: "git", args: ["push", "--force"] } },
      ];
      if (createdLinks) {
        calls.push(
          { name: "write_file", args: { path: "escape-dir/pwned.txt", content: "bad" } },
          { name: "write_file", args: { path: "escape-file.txt", content: "bad" } },
        );
      }

      const brain = new ScriptedWriteBrain([{ calls }, { text: "All unsafe operations were refused." }]);
      const outcome = await runBrainWriteStep({
        brain,
        root,
        prompt: "Attempt boundary escapes.",
        signal: new AbortController().signal,
      });

      assert.equal(outcome.ok, true);
      assert.deepEqual(outcome.changedFiles, []);
      assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "unchanged");
      assert.equal(existsSync(join(outside, "pwned.txt")), false);

      const toolReplies = (brain.requests[1]?.messages ?? []).filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
      for (const reply of toolReplies) assert.match(reply, /^Error:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("supports local models without native tool-calling via withTextTools", async () => {
    const root = makeTempProject();
    try {
      let turn = 0;
      const textOnlyModel: BrainProvider = {
        id: "local-gguf",
        label: "llama.cpp GGUF",
        capabilities: { tools: false, speculative: false, local: true },
        async *stream() {
          turn += 1;
          if (turn === 1) {
            yield { type: "text", delta: 'I will create the file now.\n[[write_file {"path":"hello.txt","content":"from local model"}]]' };
          } else {
            yield { type: "text", delta: "Created hello.txt." };
          }
          yield { type: "done", reason: "stop" };
        },
      };

      const outcome = await runBrainWriteStep({
        brain: withTextTools(textOnlyModel),
        root,
        prompt: "Write hello.txt",
        signal: new AbortController().signal,
      });
      assert.equal(outcome.ok, true);
      assert.deepEqual(outcome.changedFiles, ["hello.txt"]);
      assert.equal(readFileSync(join(root, "hello.txt"), "utf8"), "from local model");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Executive fallbackWrite integration without Muse CLI", () => {
  function makeNoMuseRig(root: string, brain: BrainProvider) {
    let clock = Date.UTC(2026, 10, 11, 3, 0, 0);
    const mem = MemoryStore.open(":memory:", { now: () => clock });
    mem.saveProfile({
      enabled: true,
      policy: { ...mem.getProfile().policy, allowProjectWrites: true },
    });
    const tasks = new TaskStore(mem, () => clock);
    const noMuseHost: ExecutiveHost = {
      now: () => clock,
      projectKey: (cwd) => cwd,
      hostAvailable: async () => ({ ok: false, reason: "Muse CLI is not installed" }),
      startSession: async () => {
        throw new Error("Muse is not installed");
      },
      startTurn: async () => {
        throw new Error("Muse is not installed");
      },
      interruptTurn: async () => undefined,
      turnState: async () => "absent",
      readProjectFile: async (_cwd, relPath) => {
        const full = join(root, relPath);
        if (!existsSync(full)) return { exists: false, text: "", size: 0 };
        const text = readFileSync(full, "utf8");
        return { exists: true, text, size: Buffer.byteLength(text, "utf8") };
      },
      needsUser: () => false,
      watch: () => () => undefined,
      log: () => undefined,
    };

    const exec = new Executive(tasks, noMuseHost, {
      profile: () => mem.getProfile(),
      memory: () => null,
      changed: () => undefined,
      fallbackWrite: {
        available: () => ({ ok: true, label: brain.label }),
        run: ({ cwd, prompt, signal }) =>
          runBrainWriteStep({
            brain,
            root: cwd,
            prompt,
            signal,
            execCheck: async () => ({ exitCode: 0, output: "verified ok", timedOut: false }),
          }),
      },
    });
    return { mem, tasks, exec, advanceClock: (ms: number) => (clock += ms) };
  }

  it("holds a voice-proposed change paused until explicit user approval, then executes and verifies it without Muse", async () => {
    const root = makeTempProject();
    try {
      const brain = new ScriptedWriteBrain([
        {
          calls: [
            { name: "write_file", args: { path: "CHANGELOG.md", content: "## 0.27.0\n- Portable write step\n" } },
            { name: "run_check", args: { program: "node", args: ["--version"] } },
          ],
        },
        { text: "Wrote CHANGELOG.md and ran verification." },
      ]);
      const { tasks, exec } = makeNoMuseRig(root, brain);

      const proposal = exec.propose({
        title: "Add changelog",
        goal: "Create CHANGELOG.md for 0.27.0",
        goalId: null,
        cwd: root,
        project: root,
        account: null,
        allowWrites: true,
        maxTurns: 4,
        maxMinutes: 10,
        origin: "voice",
        scheduleId: null,
        steps: [
          {
            title: "Write CHANGELOG.md",
            prompt: "Create CHANGELOG.md with 0.27.0 release notes.",
            effect: "write",
            verifier: { type: "file_contains", path: "CHANGELOG.md", text: "Portable write step" },
          },
        ],
      });

      // Before approval, ticking the executive must NEVER execute the write step
      assert.equal(proposal.status, "paused");
      await exec.tick();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(existsSync(join(root, "CHANGELOG.md")), false, "unapproved proposal never touches disk");
      assert.equal(tasks.require(proposal.id).status, "paused");

      // User approves on screen -> executive runs fallbackWrite and verifies file_contains
      exec.approve(proposal.id);
      await exec.tick();
      const deadline = Date.now() + 2000;
      while (tasks.require(proposal.id).status === "running" || tasks.require(proposal.id).status === "queued") {
        if (Date.now() > deadline) assert.fail("timed out waiting for fallbackWrite completion");
        await new Promise((r) => setTimeout(r, 15));
      }

      const finished = tasks.require(proposal.id);
      assert.equal(finished.status, "completed");
      assert.match(finished.result, /Changed files: CHANGELOG\.md/);
      assert.match(finished.result, /Checks: node --version \(exit 0\)/);
      assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), "## 0.27.0\n- Portable write step\n");
      exec.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not auto-retry a failed write step and blocks when allowProjectWrites is turned off", async () => {
    const root = makeTempProject();
    try {
      const failingBrain = new ScriptedWriteBrain([
        { calls: [{ name: "write_file", args: { path: "partial.txt", content: "half" } }] },
        { error: "upstream connection dropped" },
      ]);
      const { mem, tasks, exec } = makeNoMuseRig(root, failingBrain);
      const task1 = exec.create({
        title: "Write partial",
        goal: "Write partial.txt",
        goalId: null,
        cwd: root,
        project: root,
        account: null,
        allowWrites: true,
        maxTurns: 4,
        maxMinutes: 10,
        origin: "user",
        scheduleId: null,
        steps: [{ title: "Write file", prompt: "Write partial.txt", effect: "write", verifier: null }],
      });
      await exec.tick();
      const deadline = Date.now() + 2000;
      while (tasks.require(task1.id).status === "running" || tasks.require(task1.id).status === "queued") {
        if (Date.now() > deadline) assert.fail("timed out");
        await new Promise((r) => setTimeout(r, 15));
      }
      const failed = tasks.require(task1.id);
      assert.equal(failed.status, "failed", "failed write steps never auto-retry on a guess");
      assert.match(failed.reason, /touched before failure: partial\.txt/);

      // Turning off allowProjectWrites blocks a queued write task before touching disk
      mem.saveProfile({ policy: { ...mem.getProfile().policy, allowProjectWrites: false } });
      const task2 = tasks.create({
        title: "Blocked write",
        goal: "Should not run",
        goalId: null,
        cwd: root,
        project: root,
        account: null,
        allowWrites: true,
        maxTurns: 4,
        maxMinutes: 10,
        origin: "user",
        scheduleId: null,
        steps: [{ title: "Write blocked.txt", prompt: "Write blocked.txt", effect: "write", verifier: null }],
      });
      await exec.tick();
      assert.equal(tasks.require(task2.id).status, "blocked");
      assert.equal(existsSync(join(root, "blocked.txt")), false);
      exec.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
