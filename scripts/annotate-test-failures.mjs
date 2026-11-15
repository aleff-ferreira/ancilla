/**
 * Ancilla CI Test Failure Annotator
 *
 * Scans Node.js test runner TAP log files generated during CI workflows
 * and emits GitHub Actions workflow annotations for each failing test.
 *
 * Usage:
 *   node scripts/annotate-test-failures.mjs <log-path-1> [log-path-2 ...]
 */

import { existsSync, readFileSync } from "node:fs";

/**
 * Escapes characters for GitHub Actions workflow commands:
 * '%' -> '%25', '\r' -> '%0D', '\n' -> '%0A', ':' -> '%3A', ',' -> '%2C'
 */
export function escapeWorkflowData(value) {
  return String(value ?? "")
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

/**
 * Unquotes a YAML single-quoted string value.
 */
function unquoteYamlString(value) {
  const match = /^'(.*)'$/.exec(value);
  return match ? match[1].replace(/''/g, "'") : value;
}

/**
 * Parses Node.js TAP test output, extracting failure locations, titles, and error details.
 * Ignores parent suite failures ('subtestsFailed') to avoid duplicate annotations.
 */
export function parseTapLog(content) {
  const failures = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const headerMatch = /^\s*not ok \d+ - (.*?)(?: # (?:SKIP|TODO).*)?$/.exec(lines[i]);
    if (!headerMatch) continue;

    const failure = {
      name: headerMatch[1].trim(),
      file: "",
      line: "",
      error: "",
      failureType: "",
    };

    if (/^\s*---\s*$/.test(lines[i + 1] ?? "")) {
      for (let j = i + 2; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) {
        const kvMatch = /^(\s*)(\w+): (.*)$/.exec(lines[j]);
        if (!kvMatch) continue;

        const [, indent, key, rawValue] = kvMatch;
        let value = unquoteYamlString(rawValue);

        // Parse multiline block scalar (e.g. `error: |-` or `>`)
        if (/^[|>][-+]?$/.test(rawValue.trim())) {
          const bodyLines = [];
          while (
            j + 1 < lines.length &&
            (lines[j + 1].trim() === "" || lines[j + 1].startsWith(indent + " "))
          ) {
            j += 1;
            bodyLines.push(lines[j].slice(indent.length + 2));
          }
          value = bodyLines.join("\n").trim();
        }

        if (key === "location") {
          // Format: path:line:col (handles Windows paths with drive letter colons like C:\path)
          const locationMatch = /^(.*):(\d+):(\d+)$/.exec(value);
          if (locationMatch) {
            failure.file = locationMatch[1];
            failure.line = locationMatch[2];
          }
        } else if (key === "failureType") {
          failure.failureType = value;
        } else if (key === "error") {
          failure.error = value;
        }
      }
    }

    if (failure.failureType !== "subtestsFailed") {
      failures.push(failure);
    }
  }

  return failures;
}

/**
 * Formats a GitHub Actions error annotation line.
 */
export function formatAnnotation(failure) {
  const metadata = [];
  if (failure.file) metadata.push(`file=${failure.file}`);
  if (failure.line) metadata.push(`line=${failure.line}`);
  if (failure.name) metadata.push(`title=${escapeWorkflowData(failure.name)}`);

  const details = escapeWorkflowData(failure.error || "failed");
  return `::error ${metadata.join(",")}::${details}`;
}

/**
 * Formats the terminal summary report of test failures.
 */
export function formatSummary(failures) {
  if (failures.length === 0) return "";
  const header = `\n${failures.length} failing test${failures.length === 1 ? "" : "s"}:`;
  const items = failures.map((f) => {
    const loc = f.file ? ` (${f.file}:${f.line})` : "";
    return `  ✖ ${f.name}${loc}`;
  });
  return [header, ...items].join("\n");
}

export function run(filePaths) {
  const failures = [];
  for (const filePath of filePaths) {
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf8");
    failures.push(...parseTapLog(content));
  }

  for (const failure of failures) {
    console.log(formatAnnotation(failure));
  }

  if (failures.length > 0) {
    console.log(formatSummary(failures));
  }
}

// Execute when invoked directly from CLI
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  run(process.argv.slice(2));
}
