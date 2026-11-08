// Runs the assistant's evaluation and writes its results into docs/assistant-evaluation.md.
//
//   node scripts/assistant-eval.mjs           the full run; rewrites the results block of the document
//   node scripts/assistant-eval.mjs --print   the full run, printed and not written
//   node scripts/assistant-eval.mjs --quick   the cut-down run the tests make, printed and not written
//
// The server must be built first (npm run build --workspace @ancilla/server). No model is called: see the document's
// "What is and is not measured".
import { readFileSync, writeFileSync } from "node:fs";

const report = new URL("../packages/server/dist/src/assistant/eval/report.js", import.meta.url);
let mod;
try {
  mod = await import(report.href);
} catch (error) {
  console.error(`assistant-eval: the server is not built (${error.code ?? error.message}). Run: npm run build --workspace @ancilla/server`);
  process.exit(2);
}

const quick = process.argv.includes("--quick");
const print = quick || process.argv.includes("--print");
const results = await mod.runAll({ quick });
const block = mod.renderResults(results);
const missed = mod.targets(results).filter((t) => !t.met);

if (print) {
  console.log(block);
  process.exit(missed.length === 0 ? 0 : 1);
}

const file = new URL("../docs/assistant-evaluation.md", import.meta.url);
const begin = "<!-- results:begin -->";
const end = "<!-- results:end -->";
const text = readFileSync(file, "utf8");
const from = text.indexOf(begin);
const to = text.indexOf(end);
if (from === -1 || to === -1 || to < from) {
  console.error(`assistant-eval: ${file.pathname} needs the markers ${begin} and ${end} around the results.`);
  process.exit(2);
}
writeFileSync(file, `${text.slice(0, from + begin.length)}\n\n${block}\n${text.slice(to)}`, "utf8");
console.log(`Wrote the results to docs/assistant-evaluation.md. Targets missed: ${missed.length}${missed.length ? ` (${missed.map((t) => t.id).join(", ")})` : ""}.`);
process.exit(missed.length === 0 ? 0 : 1);
