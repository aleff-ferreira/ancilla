/**
 * What becomes of a `!` command when its owner stops, and of what a command leaves behind once it has answered:
 * a command whose answer is pending is stopped by `stopPendingCaptures` (and by the process exiting), only its own
 * owner's commands are, a command that already answered leaves its background process alone, and that process keeps
 * running (it is neither killed by a closed pipe nor kept in the event loop by an open one). Process groups, signals
 * and pipe lifetimes are POSIX behaviour, so every case here skips on Windows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapture, stopPendingCaptures, type PendingCaptures } from "../src/runCapture.js";
import { isRunning, killQuietly } from "./fakeMuse.js";
import { sleep } from "./research-rigs.js";

const POSIX_ONLY = process.platform === "win32" ? "needs a POSIX shell, process groups and signals" : false;
const RUN_CAPTURE = join(__dirname, "..", "src", "runCapture.js");

async function pidFrom(file: string, deadlineMs = 10_000): Promise<number> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const text = (await readFile(file, "utf8")).trim();
      if (text) return Number(text);
    } catch {
      /* not written yet */
    }
    if (Date.now() > until) throw new Error(`no pid in ${file}`);
    await sleep(20);
  }
}

async function gone(pid: number, what: string, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (isRunning(pid) && Date.now() < until) await sleep(25);
  assert.equal(isRunning(pid), false, what);
}

/** A temp folder the test owns, and the processes it started, killed whatever the outcome. */
async function scratch(): Promise<{ dir: string; track: (pid: number) => void; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ancilla-capture-stop-"));
  const pids: number[] = [];
  return {
    dir,
    track: (pid) => void pids.push(pid),
    done: async () => {
      for (const pid of pids) killQuietly(pid);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("stopPendingCaptures", () => {
  it("stops a command whose answer is pending, and what it started, and the command is answered", { skip: POSIX_ONLY, timeout: 60_000 }, async () => {
    const s = await scratch();
    try {
      const pending: PendingCaptures = new Set();
      const run = runCapture("sh", ["-c", `sleep 30 & echo $! > "${join(s.dir, "bg.pid")}"; echo $$ > "${join(s.dir, "fg.pid")}"; wait`], undefined, 120_000, { pending });
      const fg = await pidFrom(join(s.dir, "fg.pid"));
      const bg = await pidFrom(join(s.dir, "bg.pid"));
      s.track(fg);
      s.track(bg);
      assert.equal(pending.size, 1, "a command with no answer yet is listed");

      await stopPendingCaptures(pending, { graceMs: 5000 });
      const result = await run;
      await gone(fg, "the command outlived the stop");
      await gone(bg, "what the command started outlived the stop");
      assert.equal(pending.size, 0, "an answered command is no longer listed");
      assert.equal(result.truncated, false, "this is not the two-minute timeout");
    } finally {
      await s.done();
    }
  });

  it("kills a command that ignores the polite stop once the grace has run out", { skip: POSIX_ONLY, timeout: 60_000 }, async () => {
    const s = await scratch();
    try {
      const pending: PendingCaptures = new Set();
      const run = runCapture("sh", ["-c", `trap "" TERM; echo $$ > "${join(s.dir, "fg.pid")}"; while true; do sleep 1; done`], undefined, 120_000, { pending, drainGraceMs: 50 });
      const fg = await pidFrom(join(s.dir, "fg.pid"));
      s.track(fg);

      await stopPendingCaptures(pending, { graceMs: 200, settleMs: 5000 });
      await run;
      await gone(fg, "a command that ignores SIGTERM was left running");
    } finally {
      await s.done();
    }
  });

  it("stops only the commands of its own owner", { skip: POSIX_ONLY, timeout: 60_000 }, async () => {
    const s = await scratch();
    try {
      const mine: PendingCaptures = new Set();
      const theirs: PendingCaptures = new Set();
      const own = runCapture("sh", ["-c", `echo $$ > "${join(s.dir, "own.pid")}"; exec sleep 30`], undefined, 120_000, { pending: mine });
      const other = runCapture("sh", ["-c", `echo $$ > "${join(s.dir, "other.pid")}"; exec sleep 30`], undefined, 120_000, { pending: theirs });
      const ownPid = await pidFrom(join(s.dir, "own.pid"));
      const otherPid = await pidFrom(join(s.dir, "other.pid"));
      s.track(ownPid);
      s.track(otherPid);

      await stopPendingCaptures(mine, { graceMs: 5000 });
      await own;
      await gone(ownPid, "the owner's own command was left running");
      await sleep(300);
      assert.equal(isRunning(otherPid), true, "another owner's command was stopped");
      assert.equal(theirs.size, 1);

      await stopPendingCaptures(theirs, { graceMs: 5000 });
      await other;
      await gone(otherPid, "the other owner can stop its own command");
    } finally {
      await s.done();
    }
  });

  it("leaves the background process of a command that already answered alone", { skip: POSIX_ONLY, timeout: 60_000 }, async () => {
    const s = await scratch();
    try {
      const pending: PendingCaptures = new Set();
      const result = await runCapture("sh", ["-c", `sleep 30 & echo $! > "${join(s.dir, "bg.pid")}"; echo started`], undefined, 120_000, { pending, drainGraceMs: 50 });
      const bg = await pidFrom(join(s.dir, "bg.pid"));
      s.track(bg);
      assert.match(result.output, /started/);
      assert.equal(pending.size, 0);

      await stopPendingCaptures(pending, { graceMs: 200, settleMs: 200 });
      await sleep(300);
      assert.equal(isRunning(bg), true, "a process a command left behind after its answer was stopped with the server");
    } finally {
      await s.done();
    }
  });
});

/** Runs a script in a node process of its own, and answers its output and how it ended. */
function inChild(script: string, deadlineMs: number): Promise<{ stdout: string; code: number | null; signal: NodeJS.Signals | null; hung: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    let hung = false;
    const deadline = setTimeout(() => {
      hung = true;
      child.kill("SIGKILL");
    }, deadlineMs);
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ stdout, code, signal, hung });
    });
  });
}

describe("a process that exits with a command still pending", () => {
  // Once for a bare command, and once for one a server owns (listed in the set it keeps, as the server's commands are).
  for (const owned of [false, true]) {
    it(`kills the command's group on the way out${owned ? ", for a command with an owner" : ""}`, { skip: POSIX_ONLY, timeout: 60_000 }, async () => {
      const s = await scratch();
      try {
        const pidFile = join(s.dir, "fg.pid");
        const script = `
          const { runCapture } = require(${JSON.stringify(RUN_CAPTURE)});
          const fs = require("node:fs");
          runCapture("sh", ["-c", "echo $$ > \\"" + ${JSON.stringify(pidFile)} + "\\"; exec sleep 30"], undefined, 120000${owned ? ", { pending: new Set() }" : ""});
          const timer = setInterval(() => {
            try {
              if (fs.readFileSync(${JSON.stringify(pidFile)}, "utf8").trim() !== "") process.exit(0);
            } catch {}
          }, 20);
        `;
        const finished = await inChild(script, 30_000);
        const pid = await pidFrom(pidFile);
        s.track(pid);
        assert.equal(finished.hung, false, "the process did not exit");
        assert.equal(finished.code, 0);
        await gone(pid, "a command that was still pending outlived the process that ran it");
      } finally {
        await s.done();
      }
    });
  }

  it("leaves what a command that had answered started running: the exit hook no longer lists it", { skip: POSIX_ONLY, timeout: 60_000 }, async () => {
    const s = await scratch();
    try {
      const pidFile = join(s.dir, "bg.pid");
      // The command answers (its shell exits at once), then the process ends on its own; nothing exits it by hand.
      const script = `
        const { runCapture } = require(${JSON.stringify(RUN_CAPTURE)});
        runCapture("sh", ["-c", "sleep 30 & echo $! > \\"" + ${JSON.stringify(pidFile)} + "\\""], undefined, 120000, { drainGraceMs: 50 })
          .then((result) => process.stdout.write("answered " + result.exitCode + "\\n"));
      `;
      const finished = await inChild(script, 30_000);
      const bg = await pidFrom(pidFile);
      s.track(bg);
      assert.equal(finished.hung, false, "the process did not exit once the command had answered");
      assert.equal(finished.code, 0);
      assert.match(finished.stdout, /answered 0/);
      await sleep(300);
      assert.equal(isRunning(bg), true, "the exit of the process that ran an answered command killed what that command left running");
    } finally {
      await s.done();
    }
  });
});

describe("a background process a command leaves behind, once the command has answered", () => {
  it("is neither killed by the pipe nor kept attached to it, and the process that ran the command can still exit", { skip: POSIX_ONLY, timeout: 90_000 }, async () => {
    const s = await scratch();
    try {
      const nodeLogger = join(s.dir, "logger.js");
      await writeFile(nodeLogger, `require("node:fs").writeFileSync(${JSON.stringify(join(s.dir, "node.pid"))}, String(process.pid)); setInterval(() => process.stdout.write("request served\\n"), 50);\n`);
      const script = `
        const { runCapture } = require(${JSON.stringify(RUN_CAPTURE)});
        const fs = require("node:fs");
        const alive = (file) => { try { process.kill(Number(fs.readFileSync(file, "utf8")), 0); return true; } catch { return false; } };
        (async () => {
          const shell = "sh -c 'echo $$ > \\"${join(s.dir, "sh.pid")}\\"; while true; do echo tick; sleep 0.05; done' &";
          const node = ${JSON.stringify(`"${process.execPath}" "${nodeLogger}" &`)};
          const quiet = "sh -c 'echo $$ > \\"${join(s.dir, "quiet.pid")}\\"; exec sleep 60' &";
          const results = await Promise.all([shell, node, quiet].map((line) => runCapture("sh", ["-c", line], undefined, 60000, { drainGraceMs: 50 })));
          await new Promise((resolve) => setTimeout(resolve, 1000));
          process.stdout.write(JSON.stringify({ answered: results.length, shell: alive(${JSON.stringify(join(s.dir, "sh.pid"))}), node: alive(${JSON.stringify(join(s.dir, "node.pid"))}), quiet: alive(${JSON.stringify(join(s.dir, "quiet.pid"))}) }) + "\\n");
        })();
      `;
      const finished = await inChild(script, 40_000);
      for (const name of ["sh.pid", "node.pid", "quiet.pid"]) {
        try {
          s.track(await pidFrom(join(s.dir, name), 500));
        } catch {
          /* never started */
        }
      }
      const report = JSON.parse(finished.stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
      assert.equal(report["answered"], 3);
      assert.equal(report["shell"], true, "a background shell that logs was killed when it wrote to the pipe");
      assert.equal(report["node"], true, "a background node process that logs was killed when it wrote to the pipe");
      assert.equal(report["quiet"], true, "a background process that stays quiet was stopped");
      assert.equal(finished.hung, false, "the process that ran the commands could not exit: the pipes still hold its event loop");
      assert.equal(finished.code, 0);
    } finally {
      await s.done();
    }
  });
});
