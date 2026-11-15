import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  escapeWorkflowData,
  formatAnnotation,
  formatSummary,
  parseTapLog,
  run,
} from "../annotate-test-failures.mjs";

const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("annotate-test-failures", () => {
  test("escapeWorkflowData encodes %, CR, LF, colon, and comma", () => {
    assert.equal(escapeWorkflowData("100% done\r\nkey: value, list"), "100%25 done%0D%0Akey%3A value%2C list");
    assert.equal(escapeWorkflowData(""), "");
    assert.equal(escapeWorkflowData(null), "");
  });

  test("parses single test failure with standard location and error", () => {
    const tapLog = `
TAP version 13
# Subtest: example test suite
    ok 1 - helper check
    not ok 2 - should validate credentials
      ---
      duration_ms: 5.2
      location: 'test/auth.test.js:42:5'
      failureType: 'testCodeFailure'
      error: 'Invalid token received'
      ...
    1..2
not ok 1 - example test suite
  ---
  duration_ms: 12.0
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
1..1
`;
    const failures = parseTapLog(tapLog);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].name, "should validate credentials");
    assert.equal(failures[0].file, "test/auth.test.js");
    assert.equal(failures[0].line, "42");
    assert.equal(failures[0].error, "Invalid token received");

    const annotation = formatAnnotation(failures[0]);
    assert.equal(
      annotation,
      "::error file=test/auth.test.js,line=42,title=should validate credentials::Invalid token received",
    );

    const summary = formatSummary(failures);
    assert.match(summary, /1 failing test:/);
    assert.match(summary, /✖ should validate credentials \(test\/auth\.test\.js:42\)/);
  });

  test("parses Windows file paths with drive letter colons correctly", () => {
    const tapLog = `
not ok 1 - windows filesystem test
  ---
  location: 'C:\\projects\\ancilla\\test\\fs.test.js:105:3'
  error: 'Access denied'
  ...
`;
    const failures = parseTapLog(tapLog);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].file, "C:\\projects\\ancilla\\test\\fs.test.js");
    assert.equal(failures[0].line, "105");
  });

  test("parses multiline block scalar error messages and formats annotation", () => {
    const tapLog = `
not ok 1 - stack trace assertion
  ---
  location: 'test/stack.test.js:15:1'
  error: |-
    AssertionError: expected true but got false
        at TestContext.<anonymous> (test/stack.test.js:15:1)
  ...
`;
    const failures = parseTapLog(tapLog);
    assert.equal(failures.length, 1);
    assert.match(failures[0].error, /AssertionError: expected true but got false\n {4}at TestContext/);

    const annotation = formatAnnotation(failures[0]);
    assert.match(annotation, /AssertionError%3A expected true but got false%0A/);
  });

  test("returns empty summary when all tests pass", () => {
    const tapLog = `
TAP version 13
ok 1 - first test
ok 2 - second test
1..2
`;
    const failures = parseTapLog(tapLog);
    assert.equal(failures.length, 0);
    assert.equal(formatSummary(failures), "");
  });

  test("CLI execution skips missing files and exits cleanly with 0", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ancilla-annotate-"));
    dirs.push(tempDir);
    const logFile = join(tempDir, "test.log");
    writeFileSync(
      logFile,
      `not ok 1 - cli failure\n  ---\n  location: 'test/cli.test.js:10:2'\n  error: 'boom'\n  ...\n`,
    );

    const res = spawnSync(
      process.execPath,
      ["scripts/annotate-test-failures.mjs", join(tempDir, "missing.log"), logFile],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0);
    assert.match(res.stdout, /::error file=test\/cli\.test\.js,line=10,title=cli failure::boom/);
    assert.match(res.stdout, /1 failing test:/);
  });
});
