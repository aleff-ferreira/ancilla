// Fails when any commit since the fork from Helicon names an AI tool as author, committer or co-author
// (CLAUDE.md). CI runs it on every push; `npm run attribution:check` runs it locally. Helicon's own history,
// before the fork point, is not ours to judge and is left out.
//
//   node scripts/check-attribution.mjs                  every commit since the fork point
//   node scripts/check-attribution.mjs <range>          another range, like main..HEAD
//   node scripts/check-attribution.mjs --baseline <rev> the last commit judged by the old rule (default v0.20.3's)
//   node scripts/check-attribution.mjs --message <file> a commit message being written (the commit-msg hook)
//
// Commits up to the baseline are held to the old rule, so the session-id trailers already in the history stay an
// accepted exception; every commit after it is held to the strict one (scripts/lib/attribution.mjs).
//
// Exit status: 0 nothing found, 1 a commit in a range credits a tool, 2 the command was used wrongly or could not run,
// 3 a message (--message) credits a tool or names one. A message is refused with 3 and nothing else, so that the hook
// can tell "refused" from "could not look": node itself ends a process that crashed before running any of this (a
// script that does not parse, a loader that fails) with 1, and a failure to check is 2. The rules are loaded inside a
// try for the same reason.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// What to do about a refusal, written without the names: the repository is scanned for them.
const ADVICE = "Any line that names one of these tools is refused, file names such as the instructions file included, not only a credit line. Reword it (say the instructions file, not its name); a branch or pull request title should not carry these names either.";

let range;
let baseline;
let messageFile;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--baseline" || args[i] === "--message") {
    const value = args[++i];
    if (value === undefined) {
      console.error(`check-attribution: ${args[i - 1]} needs a value`);
      process.exit(2);
    }
    if (args[i - 1] === "--baseline") baseline = value;
    else messageFile = value;
  } else if (args[i].startsWith("--")) {
    console.error(`check-attribution: unknown option ${args[i]}`);
    process.exit(2);
  } else {
    range = args[i];
  }
}

let rules;
try {
  rules = await import("./lib/attribution.mjs");
} catch (error) {
  console.error(`check-attribution: cannot load the rules: ${error.message}`);
  process.exit(messageFile !== undefined ? 2 : 1);
}

if (messageFile !== undefined) {
  // A message being written: new, so the strict rule, and what git added for the editor is not part of it.
  let lines;
  try {
    let text;
    try {
      text = readFileSync(messageFile, "utf8");
    } catch (error) {
      console.error(`check-attribution: cannot read ${messageFile}: ${error.code ?? error.message}`);
      process.exit(2);
    }
    lines = rules.messageProblems(text, { strict: true, editorText: true });
  } catch (error) {
    console.error(`check-attribution: ${error.message}`);
    process.exit(2);
  }
  if (lines.length > 0) {
    console.error(`commit-msg: the message credits or names an AI tool. Commits here carry the author's name only (the commit rules in the repository's root instructions file). ${ADVICE}`);
    for (const line of lines) console.error(`  ${line}`);
    process.exit(3);
  }
  process.exit(0);
}

range ??= `${rules.FORK_POINT}..HEAD`;
baseline ??= rules.BASELINE;
const git = (gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let problems;
try {
  problems = rules.rangeProblems({ git, range, baseline });
} catch (error) {
  console.error(`check-attribution: ${error.message}`);
  process.exit(1);
}
if (problems.length > 0) {
  console.error(`${problems.length} commit line(s) credit or name an AI tool; commits here carry the author's name only (the commit rules in the repository's root instructions file). ${ADVICE}`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`No AI attribution in ${range}.`);
