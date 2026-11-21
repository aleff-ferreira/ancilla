#!/usr/bin/env node
// Puts the offline detector's decisions (shadow-rows.jsonl from detect.py) next to the call's own (the shard files of the same
// run) as Markdown tables, per class, for the episodes both saw.
//
//   node scripts/voice/interrupt-eval/shadow/summarize.mjs <shadow-rows.jsonl> <shard-*.jsonl ...> [--lang en]
import fs from "node:fs";

const args = process.argv.slice(2);
const langOnly = args.includes("--lang") ? args[args.indexOf("--lang") + 1] : null;
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--lang");
const [rowsFile, ...runFiles] = files;
const lines = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const shadow = lines(rowsFile).filter((r) => langOnly === null || r.lang === langOnly);
const runs = runFiles.flatMap(lines).filter((r) => langOnly === null || r.lang === langOnly);

function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const frac = (k, n) => { const [lo, hi] = wilson(k, n); return `${k}/${n} (${(lo * 100).toFixed(0)}%-${(hi * 100).toFixed(0)}%)`; };
const median = (xs) => { if (xs.length === 0) return "-"; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]); };
const cells = (c) => `| ${c.join(" | ")} |`;

const ids = (kind) => [...new Set(shadow.filter((r) => r.kind === kind).map((r) => r.id))].sort();
const arms = [...new Set(runs.map((r) => r.arm))];
const modes = ["card", "stop0", "zeros"];
const thresholds = [0.5, 0.7, 0.9];

function detectorRows(kind, mode, thr) {
  return shadow.filter((r) => r.kind === kind && r.mode === mode);
}

for (const kind of ["stop", "correction"]) {
  console.log(`\n### ${kind}s: the decision to stop the assistant\n`);
  console.log(cells(["decider", "n", "decision within 300 ms of the onset", "within 700 ms", "median decision (ms)", "decided before the person spoke"]));
  console.log(cells(["---", "---", "---", "---", "---", "---"]));
  const base = ids(kind);
  for (const arm of arms) {
    const rs = runs.filter((r) => r.arm === arm && r.kind === kind && base.includes(r.id));
    if (rs.length === 0) continue;
    const lat = rs.filter((r) => r.interruptRel !== null && r.attributed).map((r) => r.interruptRel);
    console.log(cells([`${arm} (the call)`, rs.length, frac(rs.filter((r) => r.within350).length, rs.length) + " silent within 350 ms", frac(rs.filter((r) => r.attributed && r.lastOldRel !== null && r.lastOldRel <= 700).length, rs.length) + " silent", median(rs.filter((r) => r.attributed && r.lastOldRel !== null).map((r) => r.lastOldRel)) + " (silence)", rs.filter((r) => r.selfInterrupt).length]));
  }
  for (const mode of modes) {
    for (const thr of thresholds) {
      const rs = detectorRows(kind, mode, thr);
      const d = rs.map((r) => r[`detectMs@${thr}`]);
      const within = (ms) => d.filter((x) => x !== null && x <= ms).length;
      console.log(cells([`detector, ${mode}, threshold ${thr}`, rs.length, frac(within(300), rs.length), frac(within(700), rs.length), median(d.filter((x) => x !== null)), rs.filter((r) => r[`selfTrigger@${thr}`]).length]));
    }
  }
}

console.log("\n### the sounds that were not for the assistant: a decision to stop it where there should be none\n");
const kinds = ["control"];
const subs = [...new Set(shadow.filter((r) => r.kind === "control").map((r) => r.sub))].sort();
console.log(cells(["decider", "all controls", ...subs]));
console.log(cells(["---", "---", ...subs.map(() => "---")]));
const controlIds = ids("control");
for (const arm of arms) {
  const rs = runs.filter((r) => r.arm === arm && r.kind === "control" && controlIds.includes(r.id));
  if (rs.length === 0) continue;
  console.log(cells([`${arm} (the call): reply cut off or a turn made`, frac(rs.filter((r) => r.falseCancel).length, rs.length), ...subs.map((s) => `${rs.filter((r) => r.sub === s && r.falseCancel).length}/${rs.filter((r) => r.sub === s).length}`)]));
}
for (const mode of modes) {
  for (const thr of thresholds) {
    const rs = shadow.filter((r) => r.kind === "control" && r.mode === mode);
    const fires = (r) => r[`detectMs@${thr}`] !== null || r[`selfTrigger@${thr}`];
    console.log(cells([`detector, ${mode}, threshold ${thr}`, frac(rs.filter(fires).length, rs.length), ...subs.map((s) => `${rs.filter((r) => r.sub === s && fires(r)).length}/${rs.filter((r) => r.sub === s).length}`)]));
  }
}
void kinds;
