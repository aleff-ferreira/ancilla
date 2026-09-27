// Fails when any commit since the fork from Helicon names an AI tool as author, committer or co-author
// (CLAUDE.md). CI runs it on every push; `npm run attribution:check` runs it locally. Helicon's own history,
// before the fork point, is not ours to judge and is left out.
import { execFileSync } from "node:child_process";

/** The last upstream Helicon commit; everything after it is Ancilla's. */
const FORK_POINT = "8e5b141";
const TOOLS = /claude|anthropic|copilot|codex|openai|gemini|cursor/i;
const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|assisted-by):/i;
const GENERATED = /generated (with|by)[^a-z]*(claude|copilot|codex|gpt|gemini|cursor)/i;

const range = process.argv[2] ?? `${FORK_POINT}..HEAD`;
const log = execFileSync("git", ["log", "--format=%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%B%x1e", range], { encoding: "utf8" });
const problems = [];
for (const record of log.split("\x1e")) {
  if (!record.trim()) continue;
  const [hash, author, committer, body] = record.replace(/^\n/, "").split("\x1f");
  const short = hash.slice(0, 7);
  if (TOOLS.test(author)) problems.push(`${short}: author is ${author}`);
  if (TOOLS.test(committer)) problems.push(`${short}: committer is ${committer}`);
  for (const line of body.split("\n")) {
    if ((TRAILER.test(line) && TOOLS.test(line)) || GENERATED.test(line)) problems.push(`${short}: message says "${line.trim()}"`);
  }
}
if (problems.length > 0) {
  console.error(`${problems.length} commit line(s) credit an AI tool; commits here carry the author's name only (CLAUDE.md):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`No AI attribution in ${range}.`);
