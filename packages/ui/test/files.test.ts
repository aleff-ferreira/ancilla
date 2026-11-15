import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dirnameOf,
  fileKey,
  fileTarget,
  formatFileSize,
  isMarkdownPath,
  looksLikeFilePath,
  relativeToProject,
} from "../src/model/files.js";

describe("fileTarget path and line range extraction", () => {
  it("resolves relative, absolute, and line-suffixed references against project root", () => {
    assert.deepEqual(fileTarget("configuration.yaml", "/opt/project"), {
      path: "configuration.yaml",
      line: null,
    });
    assert.deepEqual(fileTarget("src/core.ts:25-30", "/opt/project"), {
      path: "src/core.ts",
      line: { start: 25, end: 30 },
    });
    assert.deepEqual(fileTarget("/opt/project/src/core.ts:50", "/opt/project"), {
      path: "src/core.ts",
      line: { start: 50, end: 50 },
    });
    assert.deepEqual(
      fileTarget("file:///opt/project/docs/Architecture%20Review.md#L10-L20", "/opt/project"),
      {
        path: "docs/Architecture Review.md",
        line: { start: 10, end: 20 },
      },
    );
    assert.deepEqual(fileTarget("../api/schema.json", "/opt/project", "docs/guides"), {
      path: "docs/api/schema.json",
      line: null,
    });
    assert.deepEqual(fileTarget("./notes.md", "/opt/project", "docs"), {
      path: "docs/notes.md",
      line: null,
    });
  });

  it("handles Windows paths and mixed slashes regardless of drive casing", () => {
    assert.deepEqual(
      fileTarget("D:\\Code\\ancilla\\README.md", "d:\\Code\\ancilla"),
      { path: "README.md", line: null },
    );
    assert.equal(
      relativeToProject("D:\\Develop\\workspace", "D:/Develop/workspace/src/main.ts"),
      "src/main.ts",
    );
    assert.equal(
      relativeToProject("/var/project", "/var/project-extended/index.ts"),
      null,
    );
    assert.deepEqual(fileTarget("/etc/resolv.conf", "/opt/project"), {
      path: "/etc/resolv.conf",
      line: null,
    });
  });

  it("safely filters non-filesystem URLs and browser anchor tags", () => {
    const nonFileProtocols = [
      "https://ancilla.dev",
      "mailto:dev@ancilla.dev",
      "#anchor-locus",
      "",
      "javascript:void(0)",
      "vscode://file/open",
    ];

    for (const linkTarget of nonFileProtocols) {
      assert.equal(fileTarget(linkTarget, "/opt/project"), null, linkTarget);
    }
  });

  it("heuristically identifies inline code spans that represent files", () => {
    const validFilePaths = [
      ".env",
      ".gitignore",
      "specification.md",
      "src/server.ts",
      "main.js:10-15",
      "provider.test.ts:42",
      "packages/daemon/src/sessions.ts",
      "Dockerfile.release/run.yml",
    ];
    for (const validPath of validFilePaths) {
      assert.equal(looksLikeFilePath(validPath), true, validPath);
    }

    const nonFileSnippets = [
      "npm test",
      "process.env",
      "this.state",
      "runTests / workers",
      "evalFunc()",
      "https://ancilla.dev/overview.md",
      "100 / 5 = 20",
      "v1.0.0",
      "identifier",
      "data.property",
    ];
    for (const snippet of nonFileSnippets) {
      assert.equal(looksLikeFilePath(snippet), false, snippet);
    }
  });

  it("provides file format and path inspection utility helpers", () => {
    assert.equal(isMarkdownPath("docs/SPECIFICATION.MD"), true);
    assert.equal(isMarkdownPath("payload.json"), false);
    assert.equal(dirnameOf("packages/ui/index.ts"), "packages/ui");
    assert.equal(dirnameOf("root.ts"), "");
    assert.equal(fileKey("/app", "index.ts"), "/app\nindex.ts");
    assert.equal(formatFileSize(512), "512 B");
    assert.equal(formatFileSize(2048), "2.0 KB");
    assert.equal(formatFileSize(3 * 1024 * 1024), "3.0 MB");
  });
});
