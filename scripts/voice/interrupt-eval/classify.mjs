#!/usr/bin/env node
// Why the episodes of an arm failed, by cause and language, from the result files of a run, and which of the corrections that
// arrive while a task is being fetched started that task. The causes are read from what the call recorded for each episode
// (`fates`), so they are as precise as that record: a stop that "was read as nothing" is a call that paused the voice and,
// when the recogniser had read the last words, found none that asked for anything.
//
//   node scripts/voice/interrupt-eval/classify.mjs <results folder> [arm ...]     (default arms: pilot baseline tuned)
import fs from "node:fs";
import path from "node:path";

const [dir, ...arms] = process.argv.slice(2);
if (!dir) { console.error("usage: classify.mjs <results folder> [arm ...]"); process.exit(2); }
const rows = fs.readdirSync(dir).filter((f) => /^shard-\d+\.jsonl$/.test(f)).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));

function why(r) {
  const fates = (r.fates ?? []).join(" ");
  if (r.kind === "control") return r.falseCancel ? (r.sub === "background" ? "control: distant speech taken as the person" : `control: ${r.sub} cut the reply or made a turn`) : null;
  if (r.success) return null;
  if (r.kind === "stop") {
    if (/resumed:no-words/.test(fates)) return "stop: the recogniser read nothing (the voice went on)";
    if (/resumed:backchannel/.test(fates)) return "stop: read as a sound of listening (the voice went on)";
    if (/resumed:timeout/.test(fates)) return "stop: no reading within 4 s (the voice went on)";
    return `stop: other (${fates})`;
  }
  if (!r.heardSlot) return "correction: the corrected word was not read (recogniser)";
  if (r.interruptRel !== null && r.lastOldRel > 2000) return "correction: cut off late (reading came late)";
  if (r.lastOldRel > 2000) return "correction: the old voice went on (reading came late or not at all)";
  if (r.staleTools > 0) return "correction: a task of the old answer was started";
  if (r.fixedReplies !== 1) return `correction: ${r.fixedReplies} corrected answers`;
  return `correction: other (${fates})`;
}

for (const arm of arms.length > 0 ? arms : ["pilot", "baseline", "tuned"]) {
  console.log(`== ${arm}: failures by cause`);
  const table = new Map();
  for (const r of rows.filter((x) => x.arm === arm && x.kind !== "ordinary")) {
    const w = why(r);
    if (w === null) continue;
    const row = table.get(w) ?? { n: 0, en: 0, pt: 0, ids: [] };
    row.n++; row[r.lang]++; row.ids.push(r.id.replace(/^[a-z]+-/, ""));
    table.set(w, row);
  }
  for (const [k, v] of [...table.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`${String(v.n).padStart(3)}  (en ${v.en}, pt ${v.pt})  ${k}  [${v.ids.join(" ")}]`);
  if (table.size === 0) console.log("(none)");
}

// the corrections that arrive while a task is being fetched by a model that cannot be interrupted (every fifth)
console.log("== tasks started after the person began to correct (late-brain corrections)");
for (const arm of arms.length > 0 ? arms : ["pilot", "baseline", "tuned"]) {
  const late = rows.filter((r) => r.arm === arm && r.kind === "correction" && Number(r.id.split("-")[1]) % 5 === 4);
  const started = late.filter((r) => (r.tools ?? []).some((t) => t.t >= 0));
  console.log(`${arm.padEnd(9)} ${started.length} of ${late.length}${started.length > 0 ? `  [${started.map((r) => r.id.replace(/^[a-z]+-/, "")).join(" ")}]` : ""}`);
}
