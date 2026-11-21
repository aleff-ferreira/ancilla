#!/usr/bin/env node
// Summarises the results of run.mjs: per class and arm, success, latency to silence, false cancels and dips (Wilson 95%
// intervals), the paired counts between arms, and the gates of the brief when there is a `baseline` and a `pilot` arm.
//
//   node scripts/voice/interrupt-eval/report.mjs results/*.jsonl [--by lang|echo|sub|voice] [--failures <arm>] [--no-gates] [--markdown]
import fs from "node:fs";

const args = process.argv.slice(2);
const flagValue = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : null);
const by = flagValue("by");
const failuresOf = flagValue("failures");
const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--by", "--failures"].includes(args[i - 1])));
const rows = files.flatMap((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));

function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const pct = (x) => `${(x * 100).toFixed(0)}%`;
const frac = (k, n) => { const [lo, hi] = wilson(k, n); return `${k}/${n} (${pct(lo)}-${pct(hi)})`; };
const q = (xs, p) => { if (xs.length === 0) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };

const arms = [...new Set(rows.map((r) => r.arm))];
const kinds = ["stop", "correction", "control", "ordinary"];
for (const kind of kinds) {
  const kr = rows.filter((r) => r.kind === kind);
  if (kr.length === 0) continue;
  console.log(`\n## ${kind}`);
  const groups = by ? [...new Set(kr.map((r) => String(r[by])))].sort() : [null];
  for (const g of groups) {
    for (const arm of arms) {
      const rs = kr.filter((r) => r.arm === arm && (g === null || String(r[by]) === g));
      if (rs.length === 0) continue;
      const label = `${arm.padEnd(9)}${g === null ? "" : `${by}=${g} `}`;
      if (kind === "ordinary") {
        const lat = rs.map((r) => r.latencyMs).filter((x) => x !== null);
        console.log(`${label} first audio after the end of speech: n ${lat.length}/${rs.length}; median ${q(lat, 0.5)} ms, p95 ${q(lat, 0.95)} ms, max ${q(lat, 1)} ms`);
      } else if (kind === "control") {
        const fc = rs.filter((r) => r.falseCancel).length;
        const dips = rs.map((r) => r.dipMs);
        console.log(`${label} false cancels ${frac(fc, rs.length)}; with an audible dip (>150 ms) ${rs.filter((r) => r.dipMs > 150).length}/${rs.length}; dip median ${q(dips, 0.5)} ms p95 ${q(dips, 0.95)} ms`);
      } else {
        const ok = rs.filter((r) => r.success).length;
        const measurable = rs.filter((r) => r.audibleAtOnset !== false && r.attributed);
        const w = rs.filter((r) => r.within350).length;
        const lat = measurable.filter((r) => r.lastOldRel !== null && r.lastOldRel >= 0).map((r) => r.lastOldRel);
        const self = rs.filter((r) => r.selfInterrupt).length;
        const gap = rs.filter((r) => r.audibleAtOnset === false).length;
        console.log(`${label} success ${frac(ok, rs.length)}; silenced within 350 ms ${frac(w, rs.length)} (gap-at-onset ${gap}, self-interrupts ${self}); silence latency median ${q(lat, 0.5)} p95 ${q(lat, 0.95)} ms`);
        if (kind === "correction") {
          const heard = rs.filter((r) => r.heardSlot).length;
          const fixed1 = rs.filter((r) => r.fixedReplies === 1).length;
          console.log(`          corrected word heard ${heard}/${rs.length}; exactly one corrected reply ${fixed1}/${rs.length}; stale tool calls ${rs.reduce((a, r) => a + (r.staleTools || 0), 0)}; duplicate tasks ${rs.reduce((a, r) => a + (r.duplicateTasks || 0), 0)}`);
        }
      }
    }
  }
}

// paired counts between every two arms, on success (and on latency for the ordinary turns)
const find = (id, arm) => rows.find((r) => r.id === id && r.arm === arm);
for (let i = 0; i < arms.length; i++) {
  for (let j = i + 1; j < arms.length; j++) {
    for (const kind of kinds.filter((k) => k !== "ordinary")) {
      const ids = [...new Set(rows.filter((r) => r.kind === kind).map((r) => r.id))];
      let onlyA = 0, onlyB = 0, both = 0;
      for (const id of ids) {
        const a = find(id, arms[i]), b = find(id, arms[j]);
        if (!a || !b) continue;
        if (a.success && b.success) both++;
        else if (a.success) onlyA++;
        else if (b.success) onlyB++;
      }
      if (onlyA + onlyB + both > 0) console.log(`paired ${kind}: ${arms[i]} only ${onlyA}, ${arms[j]} only ${onlyB}, both ${both}`);
    }
  }
}

function gates() {
  const get = (arm, ...ks) => rows.filter((r) => r.arm === arm && ks.includes(r.kind));
  const base = "baseline", pilot = "pilot";
  if (!arms.includes(base) || !arms.includes(pilot) || args.includes("--no-gates")) return;
  const ok = (rs) => rs.filter((r) => r.success).length;
  const lines = [];
  const verdict = (pass, n, expected) => (n < expected ? "INCOMPLETE" : pass ? "PASS" : "FAIL");

  const sc = get(pilot, "stop", "correction"), scb = get(base, "stop", "correction");
  const pp = sc.length === 0 || scb.length === 0 ? 0 : (ok(sc) / sc.length - ok(scb) / scb.length) * 100;
  lines.push(`| 1 | stops and corrections that succeed without restatement: at least 72/80 and 15 points above baseline | ${frac(ok(sc), sc.length)}; baseline ${frac(ok(scb), scb.length)}; ${pp.toFixed(1)} points | ${verdict(ok(sc) >= 72 && pp >= 15, sc.length, 80)} |`);

  const st = get(pilot, "stop");
  const w = st.filter((r) => r.within350).length;
  const wb = get(base, "stop").filter((r) => r.within350).length;
  lines.push(`| 2 | stops that silence the old audio within 350 ms of speech onset: at least 38/40 (measured on the simulated speaker) | ${frac(w, st.length)}; baseline ${frac(wb, get(base, "stop").length)} | ${verdict(w >= 38, st.length, 40)} (physical speaker unverified) |`);

  const ct = get(pilot, "control");
  const fc = ct.filter((r) => r.falseCancel).length;
  const fcb = get(base, "control").filter((r) => r.falseCancel).length;
  lines.push(`| 3 | false cancellations in the controls: at most 1/40 | ${frac(fc, ct.length)}; baseline ${frac(fcb, get(base, "control").length)} | ${verdict(fc <= 1, ct.length, 40)} |`);

  const corr = get(pilot, "correction");
  const dup = corr.reduce((a, r) => a + (r.duplicateTasks || 0), 0);
  const stale = corr.reduce((a, r) => a + (r.staleTools || 0), 0);
  const stray = get(pilot, "stop", "control", "ordinary").reduce((a, r) => a + (r.tools?.length || 0), 0);
  const dupB = get(base, "correction").reduce((a, r) => a + (r.duplicateTasks || 0) + (r.staleTools || 0), 0);
  lines.push(`| 4 | duplicate tasks and unauthorized actions: zero | duplicate tasks ${dup}; tasks run after the interruption ${stale}; tasks in episodes that asked for none ${stray}; baseline duplicates plus stale ${dupB} | ${verdict(dup + stale + stray === 0, corr.length, 40)} |`);

  const lat = (arm) => new Map(get(arm, "ordinary").filter((r) => r.latencyMs !== null).map((r) => [r.id, r.latencyMs]));
  const lp = lat(pilot), lb = lat(base);
  const both = [...lp.keys()].filter((id) => lb.has(id));
  const added = q([...lp.values()], 0.95) - q([...lb.values()], 0.95);
  const paired = q(both.map((id) => lp.get(id) - lb.get(id)), 0.95);
  const worst = Math.max(added, paired ?? -Infinity);
  lines.push(`| 5 | added p95 latency to the first sound of an ordinary answer: at most 100 ms | p95 ${q([...lp.values()], 0.95)} ms against ${q([...lb.values()], 0.95)} ms (added ${added} ms); p95 of the paired differences ${paired} ms over ${both.length} turns | ${verdict(worst <= 100, both.length, 40)} |`);

  console.log("\n## gates (pilot against baseline)\n");
  console.log("| # | gate | measured | verdict |\n| --- | --- | --- | --- |");
  for (const l of lines) console.log(l);
}
gates();

// The same numbers as tables for docs/voice-interrupt-evaluation.md, per class and arm (and per language with --by lang).
function markdown() {
  const cells = (c) => `| ${c.join(" | ")} |`;
  const label = (arm, g) => (g === null ? arm : `${arm}, ${by} ${g}`);
  for (const kind of kinds) {
    const kr = rows.filter((r) => r.kind === kind);
    if (kr.length === 0) continue;
    const groups = by ? [...new Set(kr.map((r) => String(r[by])))].sort() : [null];
    console.log(`\n### ${kind}\n`);
    if (kind === "stop" || kind === "correction") {
      const extra = kind === "correction" ? ["corrected word heard", "exactly one corrected answer", "tasks run after the cut / twice"] : [];
      console.log(cells(["arm", "success without restatement", "silenced within 350 ms", "silence latency, median / p95 (ms)", ...extra]));
      console.log(cells(["---", "---", "---", "---", ...extra.map(() => "---")]));
      for (const g of groups) for (const arm of arms) {
        const rs = kr.filter((r) => r.arm === arm && (g === null || String(r[by]) === g));
        if (rs.length === 0) continue;
        const lat = rs.filter((r) => r.audibleAtOnset !== false && r.attributed && r.lastOldRel !== null && r.lastOldRel >= 0).map((r) => r.lastOldRel);
        const more = kind === "correction"
          ? [frac(rs.filter((r) => r.heardSlot).length, rs.length), frac(rs.filter((r) => r.fixedReplies === 1).length, rs.length), `${rs.reduce((a, r) => a + (r.staleTools || 0), 0)} / ${rs.reduce((a, r) => a + (r.duplicateTasks || 0), 0)}`]
          : [];
        console.log(cells([label(arm, g), frac(rs.filter((r) => r.success).length, rs.length), frac(rs.filter((r) => r.within350).length, rs.length), `${q(lat, 0.5)} / ${q(lat, 0.95)}`, ...more]));
      }
    } else if (kind === "control") {
      console.log(cells(["arm", "false cancellations", "voice dipped or paused for more than 150 ms", "dip, median / p95 (ms)"]));
      console.log(cells(["---", "---", "---", "---"]));
      for (const g of groups) for (const arm of arms) {
        const rs = kr.filter((r) => r.arm === arm && (g === null || String(r[by]) === g));
        if (rs.length === 0) continue;
        console.log(cells([label(arm, g), frac(rs.filter((r) => r.falseCancel).length, rs.length), `${rs.filter((r) => r.dipMs > 150).length}/${rs.length}`, `${q(rs.map((r) => r.dipMs), 0.5)} / ${q(rs.map((r) => r.dipMs), 0.95)}`]));
      }
    } else {
      console.log(cells(["arm", "turns", "first sound after the end of speech, median / p95 / max (ms)"]));
      console.log(cells(["---", "---", "---"]));
      for (const g of groups) for (const arm of arms) {
        const rs = kr.filter((r) => r.arm === arm && (g === null || String(r[by]) === g));
        const lat = rs.map((r) => r.latencyMs).filter((x) => x !== null);
        if (rs.length === 0) continue;
        console.log(cells([label(arm, g), `${lat.length}/${rs.length}`, `${q(lat, 0.5)} / ${q(lat, 0.95)} / ${q(lat, 1)}`]));
      }
    }
  }
}
if (args.includes("--markdown")) markdown();

if (failuresOf) {
  console.log(`\n## failures of ${failuresOf}`);
  for (const r of rows.filter((x) => x.arm === failuresOf && !x.success)) {
    console.log(JSON.stringify({ id: r.id, kind: r.kind, sub: r.sub, voice: r.voice, echoDb: r.echoDb, levelDb: r.levelDb, text: r.text, interruptRel: r.interruptRel, lastOldRel: r.lastOldRel, heardSlot: r.heardSlot, fixedReplies: r.fixedReplies, staleTools: r.staleTools, duplicateTasks: r.duplicateTasks, falseCancel: r.falseCancel, dipMs: r.dipMs, fates: r.fates, userTurns: r.userTurns, assistantAfter: r.assistantAfter }));
  }
}
