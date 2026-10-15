// The attribution rules (the root instructions file): the old rule for the history up to the baseline commit, the stricter one for
// everything after it. The names are put together at run time so that this file does not itself contain them.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

import { BASELINE, FORK_POINT, identityProblems, messageProblems } from "../lib/attribution.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = join(root, "scripts", "check-attribution.mjs");
const word = (...parts) => parts.join("");
const NAME_A = word("Cla", "ude");
const NAME_B = word("Anthr", "opic");
const NAME_C = word("Copi", "lot");
const NAME_D = word("Co", "dex");
const NAME_E = word("Open", "AI");
const NAME_F = word("Chat", "GPT");
const CO_AUTHOR = word("Co", "-Authored", "-By");
const GENERATED = word("Gener", "ated with");

describe("the rules for a message", () => {
  const legacy = (text) => messageProblems(text, { strict: false });
  const strict = (text) => messageProblems(text, { strict: true });

  test("the old rule refuses an AI tool as co-author or in a generated-with line, and nothing else", () => {
    assert.equal(legacy(`Fix a thing\n\n${CO_AUTHOR}: ${NAME_A} <noreply@${NAME_B.toLowerCase()}.com>\n`).length, 1);
    assert.equal(legacy(`Fix a thing\n\n${GENERATED} ${NAME_A} Code\n`).length, 1);
    assert.equal(legacy(`Fix a thing\n\nSigned-off-by: ${NAME_C}\n`).length, 1);
    assert.deepEqual(legacy(`Fix a thing\n\n${CO_AUTHOR}: A Person <a@example.invalid>\n`), []);
  });

  test("the old rule lets the session trailers of the existing history pass, which is why they are not red", () => {
    assert.deepEqual(legacy(`Add a thing\n\n${NAME_A}-Session: 0a1b2c\n`), []);
    assert.deepEqual(legacy(`Add a thing\n\nReviewed with ${NAME_D}\n`), []);
  });

  test("the strict rule refuses any trailer-shaped line that names an AI tool or vendor, key or value", () => {
    for (const line of [
      `${NAME_A}-Session: 0a1b2c`,
      `Session: ${NAME_A}`,
      `Tool: ${NAME_D}`,
      `${NAME_C}-Review: ok`,
      `${CO_AUTHOR}: ${NAME_B} <x@example.invalid>`,
      `Assisted-by: ${NAME_F}`,
      `Model: ${NAME_E} GPT-4o`,
      `Model: gpt-4`,
    ]) {
      assert.equal(strict(`Subject\n\n${line}\n`).length, 1, line);
    }
  });

  test("the strict rule refuses a free line that names one, in the subject or the body", () => {
    assert.equal(strict(`Rewrite with ${NAME_A}\n`).length, 1);
    assert.equal(strict(`Subject\n\nThis was drafted by ${NAME_C} and edited.\n`).length, 1);
    assert.equal(strict(`${GENERATED} ${NAME_A} Code\n`).length >= 1, true);
    assert.equal(strict(`Subject\n\nAsk ${NAME_E}'s ${NAME_F}\n`).length, 1);
    assert.equal(strict(`Subject\n\nusing GPT4 here\n`).length, 1);
  });

  test("the strict rule is not tripped by ordinary words", () => {
    for (const text of [
      "Fix the cursor position in the editor",
      "Ask Gemini about the design",
      `Thanks, ${word("Cla", "udette")}`,
      "Handle gptfoo",
      `Move the ${word("co", "dexes")} shelf`,
      "Update the README",
      `${word("Co-", "authored")}: nobody`,
    ]) {
      assert.deepEqual(strict(`${text}\n`), [], text);
    }
  });

  test("names are matched in any case and inside a longer line, but not inside another word", () => {
    assert.equal(strict(`${NAME_A.toUpperCase()}\n`).length, 1);
    assert.equal(strict(`see ${NAME_A.toLowerCase()}-code docs\n`).length, 1);
    assert.deepEqual(strict(`Maca${NAME_A.toLowerCase()}\n`), []);
  });

  test("the strict rule still applies the old one", () => {
    assert.equal(strict(`Subject\n\nSigned-off-by: Gemini\n`).length >= 1, true);
    assert.equal(strict(`Subject\n\n${GENERATED} cursor\n`).length >= 1, true);
  });

  describe("the first line git writes itself", () => {
    const lower = NAME_A.toLowerCase();
    const generated = [
      `Merge branch '${lower}-merge'`,
      `Merge branch '${lower}-merge' into main`,
      `Merge pull request #12 from someone/${lower}-fix`,
      `Merge remote-tracking branch 'origin/${lower}'`,
      `Revert "Add the ${NAME_A} loader"`,
      `Revert "Support an ${NAME_E}-compatible endpoint"`,
    ];
    const editor = (text) => messageProblems(text, { strict: true, editorText: true });

    test("a merge or revert subject that names a tool is not refused as a free line, in a commit being written or one made", () => {
      for (const line of generated) {
        assert.deepEqual(strict(`${line}\n`), [], line);
        assert.deepEqual(editor(`${line}\n\n# Conflicts:\n#\tfile.txt\n`), [], line);
        assert.deepEqual(strict(`\n${line}\n\nBody that is plain.\n`), [], `${line} after a blank line`);
      }
    });

    test("only that first line, and only in those shapes: anywhere else the same words are refused", () => {
      for (const line of generated) {
        assert.equal(strict(`Subject\n\n${line}\n`).length, 1, `${line} as a later line`);
        assert.equal(strict(`${line}\n\n${line}\n`).length, 1, `${line} twice: the second one counts`);
      }
      for (const line of [
        `Merge ${NAME_A} fixes`,
        `Merged ${NAME_A}`,
        `merge branch '${lower}'`,
        `Revert ${NAME_A}`,
        `Reverted "${NAME_A}"`,
        `Merge  branch '${lower}'`,
        `Remerge branch '${lower}'`,
      ]) {
        assert.equal(strict(`${line}\n`).length, 1, line);
      }
    });

    test("the exemption is for the free-line rule alone: a credit-shaped line is refused wherever it is", () => {
      assert.equal(strict(`Revert "x ${GENERATED} ${NAME_A} Code"\n`).length, 1);
      assert.equal(strict(`Merge branch 'x' ${GENERATED} ${NAME_A}\n`).length, 1);
      assert.equal(strict(`Merge pull request #1 from a/b\n\n${CO_AUTHOR}: ${NAME_A}\n`).length, 1);
      assert.equal(strict(`Merge pull request #1 from a/b\n\n${NAME_A}-Session: 0a1b\n`).length, 1);
      assert.equal(legacy(`Revert "x ${GENERATED} ${NAME_A} Code"\n`).length, 1);
    });
  });

  test("each offending line is reported once, quoted", () => {
    const problems = strict(`Subject\n\n${NAME_A}-Session: abc\n${CO_AUTHOR}: ${NAME_A}\n`);
    assert.equal(problems.length, 2);
    assert.equal(problems[0], `${NAME_A}-Session: abc`);
  });

  describe("a message being written, as git leaves it in the file the hook reads", () => {
    const editor = (text) => messageProblems(text, { strict: true, editorText: true });
    const template = (extra = "") =>
      `Subject\n\nBody.\n${extra}\n# Please enter the commit message for your changes. Lines starting\n# with '#' will be ignored, and an empty message aborts the commit.\n#\n# On branch ${NAME_A.toLowerCase()}-fix\n# Changes to be committed:\n#\tmodified:   ${NAME_A.toUpperCase()}.md\n#\n`;

    test("the lines git adds for the editor are not part of the message, not in history either way", () => {
      assert.deepEqual(editor(template()), []);
      assert.equal(messageProblems(template(), { strict: true }).length >= 2, true, "in a commit already made they would be the message");
    });

    test("a template in another language is not the message either", () => {
      assert.deepEqual(editor(`Subject\n\n# Por favor, digite a mensagem de commit para suas mudancas.\n# No ramo ${NAME_A.toLowerCase()}\n#\tmodificado:   ${NAME_A.toUpperCase()}.md\n`), []);
    });

    test("a credit written as a comment still counts: git keeps it when the message comes from -m", () => {
      assert.equal(editor(`Subject\n\n# ${CO_AUTHOR}: ${NAME_A} <noreply@${NAME_B.toLowerCase()}.com>\n`).length, 1);
      assert.equal(editor(`Subject\n\n#${GENERATED} ${NAME_A} Code\n`).length, 1);
      assert.equal(editor(`Subject\n\n#   Signed-off-by: ${NAME_C}\n`).length, 1);
    });

    test("everything under git's scissors line is the diff or the status, not the message", () => {
      const scissors = (comment) => `${comment} ${"-".repeat(24)} >8 ${"-".repeat(24)}`;
      const verbose = (comment) =>
        `Subject\n\nBody.\n\n${comment} Please enter the commit message\n${comment}\n${scissors(comment)}\n${comment} Do not modify or remove the line above.\n${comment} Everything below it will be ignored.\ndiff --git a/docs/x.md b/docs/x.md\n+The ${NAME_E}-compatible endpoint and ${NAME_A} models\n+${CO_AUTHOR}: ${NAME_A}\n`;
      assert.deepEqual(editor(verbose("#")), []);
      assert.deepEqual(editor(verbose(";")), [], "whichever character core.commentChar names");
      assert.equal(editor(verbose("#").replace("Body.", `Body that thanks ${NAME_A}.`)).length, 1, "what is above the line is still checked");
      assert.equal(messageProblems(verbose("#"), { strict: true }).length >= 1, true, "a commit already made has no scissors");
    });

    test("a line that only looks like the scissors line is not one", () => {
      assert.equal(editor(`Subject\n\n# ------ >8 ------\n${NAME_A} did this\n`).length, 1);
      assert.equal(editor(`Subject\n\n${"-".repeat(24)} >8 ${"-".repeat(24)}\n${NAME_A} did this\n`).length, 1);
      const dashes = `${"-".repeat(24)} >8 ${"-".repeat(24)}`;
      assert.equal(editor(`Subject\n\n ${dashes}\n${NAME_A} did this\n`).length, 1, "no comment character before it");
      assert.equal(editor(`Subject\n\n## ${dashes}\n${NAME_A} did this\n`).length, 1, "two characters before it");
      assert.equal(editor(`Subject\n\n# ${dashes} and more\n${NAME_A} did this\n`).length, 1, "something after it");
    });
  });

  test("an identity that is an AI tool is refused, for old commits and new", () => {
    assert.deepEqual(identityProblems(`Aleff Ferreira Francisco <146892275+aleff-ferreira@users.noreply.github.com>`), []);
    assert.equal(identityProblems(`${NAME_A} <noreply@${NAME_B.toLowerCase()}.com>`).length, 1);
    assert.equal(identityProblems(`${NAME_C} <bot@example.invalid>`).length, 1);
  });

  test("the baseline is the last commit of the history the old rule judged, named in full", () => {
    assert.equal(BASELINE, "756d15b73e087f8962c793c0fa1c5b579730adaa");
    assert.equal(FORK_POINT, "8e5b141f4285364e30011897cae74ed9adb29683");
    for (const sha of [BASELINE, FORK_POINT]) assert.match(sha, /^[0-9a-f]{40}$/, "an abbreviation can turn ambiguous as the history grows");
  });
});

describe("the check over a git history", () => {
  const dirs = [];
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "ancilla-attribution-"));
    dirs.push(dir);
    const env = {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      XDG_CONFIG_HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "author@example.invalid",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "author@example.invalid",
    };
    const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    git("config", "commit.gpgsign", "false");
    let n = 0;
    const commit = (message, over = {}) => {
      writeFileSync(join(dir, "file.txt"), `${++n}\n`);
      git("add", "file.txt");
      writeFileSync(join(dir, ".message"), message);
      execFileSync("git", ["commit", "-q", "-F", ".message"], { cwd: dir, env: { ...env, ...over } });
      return git("rev-parse", "HEAD");
    };
    return { dir, git, commit };
  }

  const check = (dir, ...args) => {
    const done = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
    return { code: done.status, out: done.stdout, err: done.stderr };
  };

  test("history up to the baseline keeps the old rule, so its session trailers stay accepted", () => {
    const { dir, commit } = repo();
    const fork = commit("The fork point\n");
    const old = commit(`An old commit\n\n${NAME_A}-Session: 0a1b2c\n`);
    const result = check(dir, `${fork}..HEAD`, "--baseline", old);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /No AI attribution/);
  });

  test("a commit after the baseline with the same trailer is refused, and only that one is named", () => {
    const { dir, commit } = repo();
    const fork = commit("The fork point\n");
    const old = commit(`An old commit\n\n${NAME_A}-Session: 0a1b2c\n`);
    commit("A clean new commit\n");
    const bad = commit(`A new commit\n\n${NAME_A}-Session: 9f9f9f\n`);
    const result = check(dir, `${fork}..HEAD`, "--baseline", old);
    assert.equal(result.code, 1);
    assert.match(result.err, new RegExp(`${bad.slice(0, 7)}: message says "${NAME_A}-Session: 9f9f9f"`));
    assert.equal(result.err.includes(old.slice(0, 7)), false);
    assert.match(result.err, /1 commit line/);
  });

  test("a free line naming a tool in a new commit is refused", () => {
    const { dir, commit } = repo();
    const fork = commit("The fork point\n");
    const base = commit("Baseline\n");
    commit(`Tidy up\n\nWritten with ${NAME_C} open.\n`);
    assert.equal(check(dir, `${fork}..HEAD`, "--baseline", base).code, 1);
  });

  test("the old rule still refuses a co-author line in the old history", () => {
    const { dir, commit } = repo();
    const fork = commit("The fork point\n");
    const bad = commit(`Old\n\n${CO_AUTHOR}: ${NAME_A} <noreply@${NAME_B.toLowerCase()}.com>\n`);
    const result = check(dir, `${fork}..HEAD`, "--baseline", bad);
    assert.equal(result.code, 1);
    assert.match(result.err, new RegExp(bad.slice(0, 7)));
  });

  test("an AI identity as author or committer is refused in old and new commits", () => {
    const { dir, commit } = repo();
    const fork = commit("The fork point\n");
    const old = commit("Old\n", { GIT_AUTHOR_NAME: NAME_A });
    assert.equal(check(dir, `${fork}..HEAD`, "--baseline", old).code, 1);
    const second = repo();
    const f2 = second.commit("The fork point\n");
    const b2 = second.commit("Baseline\n");
    second.commit("New\n", { GIT_COMMITTER_NAME: NAME_C });
    const result = check(second.dir, `${f2}..HEAD`, "--baseline", b2);
    assert.equal(result.code, 1);
    assert.match(result.err, /committer is/);
  });

  test("a merge or revert subject git wrote, naming a tool through a branch, is accepted after the baseline; the same words typed are not", () => {
    const { dir, commit } = repo();
    const fork = commit("The fork point\n");
    const base = commit("Baseline\n");
    commit(`Merge branch '${NAME_A.toLowerCase()}-merge'\n`);
    commit(`Revert "Add the ${NAME_A} loader"\n\nThis reverts commit 0a1b2c3.\n`);
    assert.equal(check(dir, `${fork}..HEAD`, "--baseline", base).code, 0);
    commit(`Tidy the ${NAME_A} loader\n`);
    const result = check(dir, `${fork}..HEAD`, "--baseline", base);
    assert.equal(result.code, 1);
    assert.match(result.err, /Tidy the/);
    assert.equal((result.err.match(/message says/g) ?? []).length, 1, "only the typed one");
  });

  test("the range check, which CI runs, exits 1 and gives the same advice as the hook", () => {
    const { dir, commit } = repo();
    const fork = commit("The fork point\n");
    const base = commit("Baseline\n");
    commit(`Update the ${NAME_A.toUpperCase()}.md rules\n`);
    const result = check(dir, `${fork}..HEAD`, "--baseline", base);
    assert.equal(result.code, 1);
    assert.match(result.err, /any line that names one of these tools is refused/i);
    assert.match(result.err, /reword/i);
  });

  test("a clean history after the baseline passes", () => {
    const { dir, commit } = repo();
    const fork = commit("The fork point\n");
    const base = commit("Baseline\n");
    commit("Add a feature\n\nIt does the thing, because the thing needed doing.\n");
    commit("Fix the feature\n");
    assert.equal(check(dir, `${fork}..HEAD`, "--baseline", base).code, 0);
  });

  test("a baseline that is not in the history is an error, not a pass", () => {
    const { dir, commit } = repo();
    const fork = commit("The fork point\n");
    commit("Something\n");
    const result = check(dir, `${fork}..HEAD`, "--baseline", "deadbeef");
    assert.equal(result.code, 1);
    assert.match(result.err, /baseline deadbeef is not in this history/);
    assert.match(result.err, /fetch-depth: 0/);
    assert.match(result.err, /pin BASELINE and FORK_POINT/, "a rewritten history needs new commits named, not a fetch");
  });

  test("an empty range passes", () => {
    const { dir, commit } = repo();
    commit("Only\n");
    assert.equal(check(dir, "HEAD..HEAD", "--baseline", "HEAD").code, 0);
  });

  const haveHistory = [FORK_POINT, BASELINE].every((rev) => spawnSync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd: root }).status === 0);
  test("this repository's own history passes", { skip: !haveHistory && "this checkout does not have the whole history (CI fetches all of it)" }, () => {
    const done = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(done.status, 0, done.stderr);
  });
});

describe("the --message mode, which the hook calls", () => {
  const dirs = [];
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "ancilla-message-"));
    dirs.push(dir);
    return dir;
  };
  const run = (scriptPath, text) => {
    const dir = tmp();
    const file = join(dir, "COMMIT_EDITMSG");
    writeFileSync(file, text);
    const done = spawnSync(process.execPath, [scriptPath, "--message", file], { cwd: dir, encoding: "utf8" });
    return { code: done.status, err: done.stderr };
  };

  test("exits 0 for a clean message, 3 for one that credits a tool, and says which line", () => {
    assert.equal(run(script, "Add a thing\n\nWhy.\n").code, 0);
    const refused = run(script, `Add a thing\n\n${NAME_A}-Session: 0a1b2c\n`);
    assert.equal(refused.code, 3, "a refusal has its own status: node itself ends a crash with 1");
    assert.match(refused.err, new RegExp(`${NAME_A}-Session: 0a1b2c`));
  });

  test("the refusal says that any line naming one of these tools is refused, a file name included, and to reword it", () => {
    const refused = run(script, `Update the ${NAME_A.toUpperCase()}.md rules\n`);
    assert.equal(refused.code, 3);
    assert.match(refused.err, /any line that names one of these tools is refused/i);
    assert.match(refused.err, /file names? such as the instructions file/i);
    assert.match(refused.err, /reword/i);
    assert.match(refused.err, new RegExp(`Update the ${NAME_A.toUpperCase()}\\.md rules`), "and which line it was");
    assert.doesNotMatch(refused.err.replace(new RegExp(`Update the ${NAME_A.toUpperCase()}\\.md rules`), ""), new RegExp(NAME_A, "i"), "the text itself does not spell the name");
  });

  test("a merge subject git wrote is let through, a typed one is not, in a message being written", () => {
    assert.equal(run(script, `Merge branch '${NAME_A.toLowerCase()}-merge'\n\n# Conflicts:\n#\tfile.txt\n`).code, 0);
    assert.equal(run(script, `Merge branch 'main'\n\nMerge ${NAME_A} fixes\n`).code, 3);
  });


  test("a message made by git commit -v, with the diff under the scissors line, is read as the message alone", () => {
    const scissors = `# ${"-".repeat(24)} >8 ${"-".repeat(24)}`;
    const verbose = `Add a thing\n\nWhy.\n\n# Please enter the commit message for your changes.\n#\n${scissors}\n# Do not modify or remove the line above.\ndiff --git a/docs/a.md b/docs/a.md\n+The ${NAME_E}-compatible endpoint and ${NAME_A} models\n`;
    assert.equal(run(script, verbose).code, 0);
  });

  test("a credit kept as a comment by git commit -m is refused", () => {
    assert.equal(run(script, `Add a thing\n\n# ${CO_AUTHOR}: ${NAME_A}\n`).code, 3);
  });

  test("a message file that cannot be read exits 2, not 0 and not 1", () => {
    const dir = tmp();
    const done = spawnSync(process.execPath, [script, "--message", join(dir, "nothing-here")], { encoding: "utf8" });
    assert.equal(done.status, 2);
    assert.match(done.stderr, /cannot read/);
  });

  test("a crash while checking exits 2, so that a caller never mistakes it for a refusal", () => {
    const tree = tmp();
    mkdirSync(join(tree, "scripts"));
    cpSync(join(root, "scripts", "lib"), join(tree, "scripts", "lib"), { recursive: true });
    cpSync(script, join(tree, "scripts", "check-attribution.mjs"));
    writeFileSync(join(tree, "scripts", "lib", "attribution.mjs"), 'throw new Error("the rules cannot load");\n');
    const done = run(join(tree, "scripts", "check-attribution.mjs"), "Add a thing\n");
    assert.equal(done.code, 2);
    assert.match(done.err, /check-attribution: .*the rules cannot load/);
    writeFileSync(join(tree, "scripts", "lib", "attribution.mjs"), "export const = ;\n");
    assert.equal(run(join(tree, "scripts", "check-attribution.mjs"), "Add a thing\n").code, 2, "a file that does not even parse");
    writeFileSync(join(tree, "scripts", "lib", "attribution.mjs"), 'export const BASELINE = "a";\nexport const FORK_POINT = "b";\nexport function messageProblems() {\n  throw new Error("a rule crashed");\n}\nexport function rangeProblems() {}\n');
    const rule = run(join(tree, "scripts", "check-attribution.mjs"), "Add a thing\n");
    assert.equal(rule.code, 2, "rules that load and then crash");
    assert.match(rule.err, /a rule crashed/);
  });
});

describe("the commit-msg hook", () => {
  const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;
  const skip = process.platform === "win32" ? "the hook is a POSIX shell script that Git for Windows runs through its own sh, which this test does not reproduce" : !hasSh && "no sh on this machine";
  const dirs = [];
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  /** The hook and the script it calls, copied side by side with LF endings, as a checkout lays them out. */
  function tree() {
    const dir = mkdtempSync(join(tmpdir(), "ancilla-hook-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".githooks"));
    writeFileSync(join(dir, ".githooks", "commit-msg"), readFileSync(join(root, ".githooks", "commit-msg"), "utf8").replace(/\r\n/g, "\n"));
    mkdirSync(join(dir, "scripts"));
    cpSync(join(root, "scripts", "lib"), join(dir, "scripts", "lib"), { recursive: true });
    cpSync(script, join(dir, "scripts", "check-attribution.mjs"));
    return dir;
  }
  function hook(dir, message, env = process.env) {
    writeFileSync(join(dir, "message.txt"), message);
    const done = spawnSync("sh", [".githooks/commit-msg", "message.txt"], { cwd: dir, env, encoding: "utf8" });
    return { code: done.status, err: done.stderr };
  }

  test("refuses a session trailer that only the strict rule knows", { skip }, () => {
    const dir = tree();
    const result = hook(dir, `Add a thing\n\n${NAME_A}-Session: 0a1b2c\n`);
    assert.equal(result.code, 1);
    assert.match(result.err, /credit/);
  });

  test("refuses a co-author line and a generated-with line", { skip }, () => {
    const dir = tree();
    assert.equal(hook(dir, `Fix\n\n${CO_AUTHOR}: ${NAME_A} <noreply@${NAME_B.toLowerCase()}.com>\n`).code, 1);
    assert.equal(hook(dir, `Fix\n\n${GENERATED} ${NAME_A} Code\n`).code, 1);
  });

  test("accepts an ordinary message, and the comment lines git puts in it", { skip }, () => {
    const dir = tree();
    assert.equal(hook(dir, "Add a thing\n\nWhy it was needed.\n").code, 0);
    assert.equal(hook(dir, `Add a thing\n\n# On branch ${NAME_A.toLowerCase()}-fix\n`).code, 0);
  });

  test("accepts a message made by git commit -v, whose file carries the diff under the scissors line", { skip }, () => {
    const dir = tree();
    const scissors = `# ${"-".repeat(24)} >8 ${"-".repeat(24)}`;
    const message = `Add a thing\n\nWhy.\n\n# Please enter the commit message for your changes.\n#\n${scissors}\n# Do not modify or remove the line above.\ndiff --git a/docs/a.md b/docs/a.md\n+The ${NAME_E}-compatible endpoint and ${NAME_A} models\n`;
    const result = hook(dir, message);
    assert.equal(result.code, 0, result.err);
  });

  test("refuses a credit that git commit -m kept as a comment line", { skip }, () => {
    const dir = tree();
    assert.equal(hook(dir, `Add a thing\n\n# ${CO_AUTHOR}: ${NAME_A}\n`).code, 1);
    assert.equal(hook(dir, `Add a thing\n\n#${GENERATED} ${NAME_A} Code\n`).code, 1);
  });

  /** A path holding only what the hook's fallback uses, so node is out of reach whatever else is installed. */
  function withoutNode(dir) {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const where = (tool) => spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    for (const tool of ["grep", "dirname"]) symlinkSync(where(tool), join(bin, tool));
    return (message) => {
      writeFileSync(join(dir, "message.txt"), message);
      return spawnSync(where("sh"), [".githooks/commit-msg", "message.txt"], { cwd: dir, env: { PATH: bin }, encoding: "utf8" });
    };
  }

  test("falls back to the old pattern when node is not on the path, and says so", { skip }, () => {
    const run = withoutNode(tree());
    assert.equal(run(`Fix\n\n${CO_AUTHOR}: ${NAME_A}\n`).status, 1);
    const lenient = run(`Add a thing\n\n${NAME_A}-Session: 0a1b2c\n`);
    assert.equal(lenient.status, 0, "only the strict rule, which needs node, knows this one");
    assert.match(lenient.stderr, /node is not on the PATH/);
    assert.match(lenient.stderr, /narrower/);
  });

  test("falls back, and says so, when the check itself cannot run; a crash is not a refusal", { skip }, () => {
    const dir = tree();
    writeFileSync(join(dir, "scripts", "lib", "attribution.mjs"), 'throw new Error("the rules cannot load");\n');
    const clean = hook(dir, "Add a thing\n\nWhy.\n");
    assert.equal(clean.code, 0, clean.err);
    assert.match(clean.err, /could not check the message/);
    assert.match(clean.err, /narrower/);
    assert.doesNotMatch(clean.err, /at file:|node:internal/, "no stack trace for the person committing");
    assert.equal(hook(dir, `Fix\n\n${CO_AUTHOR}: ${NAME_A}\n`).code, 1, "the old rule still holds");
  });

  test("a node that crashes before the check runs any code of its own ends with 1, which is not a refusal", { skip }, () => {
    const dir = tree();
    writeFileSync(join(dir, "scripts", "check-attribution.mjs"), "export const = ;\n");
    writeFileSync(join(dir, "message.txt"), "Add a thing\n");
    const crash = spawnSync(process.execPath, [join(dir, "scripts", "check-attribution.mjs"), "--message", join(dir, "message.txt")], { encoding: "utf8" });
    assert.equal(crash.status, 1, "what node does with a script that does not parse: the status a refusal used to have");
    const clean = hook(dir, "Add a thing\n\nWhy.\n");
    assert.equal(clean.code, 0, clean.err);
    assert.match(clean.err, /could not check the message \(exit 1\)/);
    assert.match(clean.err, /narrower/);
    assert.equal(hook(dir, `Fix\n\n${CO_AUTHOR}: ${NAME_A}\n`).code, 1, "the old rule still holds");
  });

  test("only the check's own refusal status refuses; every other status falls back, with the notice", { skip }, () => {
    const dir = tree();
    const exits = (status) => writeFileSync(join(dir, "scripts", "check-attribution.mjs"), `process.exit(${status});\n`);
    exits(3);
    const refused = hook(dir, "Add a thing\n\nWhy.\n");
    assert.equal(refused.code, 1, "the hook refuses the commit, for git's sake, with its own status");
    assert.doesNotMatch(refused.err, /narrower/);
    for (const status of [1, 2, 4, 127, 255]) {
      exits(status);
      const result = hook(dir, "Add a thing\n\nWhy.\n");
      assert.equal(result.code, 0, `status ${status}: ${result.err}`);
      assert.match(result.err, new RegExp(`could not check the message \\(exit ${status}\\)`));
    }
  });

  test("says nothing when the strict rule ran", { skip }, () => {
    const result = hook(tree(), "Add a thing\n\nWhy.\n");
    assert.equal(result.code, 0);
    assert.equal(result.err, "");
  });
});
