// Reads the TAP output node --test writes when stdout is not a terminal, as on CI, and prints one GitHub
// Actions annotation per failing test: the file and line it failed at, its name and its error. The run's
// annotations are readable through the API where the raw job log is not, so a failure on a runner one cannot
// open, macOS from a Linux box say, still names the test.
//
//   node scripts/annotate-test-failures.mjs <log file>...
//
// Missing log files are skipped: the step that runs this fires whenever an earlier step failed, whichever it was.
import fs from "node:fs";

const failures = [];
for (const path of process.argv.slice(2)) {
  if (!fs.existsSync(path)) continue;
  failures.push(...parse(fs.readFileSync(path, "utf8")));
}

for (const f of failures) {
  const where = [f.file && `file=${f.file}`, f.line && `line=${f.line}`, `title=${escape(f.name)}`]
    .filter(Boolean)
    .join(",");
  console.log(`::error ${where}::${escape(f.error || "failed")}`);
}
if (failures.length) {
  console.log(`\n${failures.length} failing test${failures.length === 1 ? "" : "s"}:`);
  for (const f of failures) console.log(`  ✖ ${f.name}${f.file ? ` (${f.file}:${f.line})` : ""}`);
}

// TAP from node --test: a `not ok N - name` line, then an indented YAML block between `---` and `...` with
// location, failureType and error. A parent whose subtests failed is `failureType: 'subtestsFailed'` and adds
// nothing the leaves do not say, so it is left out.
function parse(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*not ok \d+ - (.*?)(?: # (?:SKIP|TODO).*)?$/.exec(lines[i]);
    if (!m) continue;
    const f = {
      name: m[1].trim(),
      file: "",
      line: "",
      error: "",
      failureType: "",
    };
    if (/^\s*---\s*$/.test(lines[i + 1] ?? "")) {
      for (let j = i + 2; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) {
        const kv = /^(\s*)(\w+): (.*)$/.exec(lines[j]);
        if (!kv) continue;
        let value = unquote(kv[3]);
        // A block scalar (`error: |-`): the lines indented past the key, up to the next key.
        if (/^[|>][-+]?$/.test(kv[3])) {
          const body = [];
          while (j + 1 < lines.length && (lines[j + 1].trim() === "" || lines[j + 1].startsWith(kv[1] + " "))) {
            body.push(lines[++j].slice(kv[1].length + 2));
          }
          value = body.join("\n").trim();
        }
        if (kv[2] === "location") {
          // 'path:line:column'; the path may itself hold a colon on Windows (D:\...).
          const loc = /^(.*):(\d+):(\d+)$/.exec(value);
          if (loc) [, f.file, f.line] = loc;
        } else if (kv[2] === "failureType") f.failureType = value;
        else if (kv[2] === "error") f.error = value;
      }
    }
    if (f.failureType !== "subtestsFailed") out.push(f);
  }
  return out;
}

function unquote(s) {
  const q = /^'(.*)'$/.exec(s);
  return q ? q[1].replace(/''/g, "'") : s;
}

// The annotation command's own syntax: %, newlines and, in a property, the separators.
function escape(s) {
  return String(s)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}
