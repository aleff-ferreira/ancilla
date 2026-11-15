import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cloneUrl,
  isFullPath,
  parentFolder,
  repoName,
  sameFolder,
  splitBrowsePath,
  withTrailingSeparator,
} from "../src/model/paths.js";

describe("splitBrowsePath file browser input partitioning", () => {
  it("splits typed text into the folder to list and a filter", () => {
    assert.deepEqual(splitBrowsePath("D:/Workspaces/ancilla"), {
      directory: "D:/Workspaces/",
      leaf: "ancilla",
      separator: "/",
    });
    assert.deepEqual(splitBrowsePath("~/"), {
      directory: "~/",
      leaf: "",
      separator: "/",
    });
    assert.deepEqual(splitBrowsePath("C:\\Develop\\app"), {
      directory: "C:\\Develop\\",
      leaf: "app",
      separator: "\\",
    });
    assert.deepEqual(splitBrowsePath("my-project"), {
      directory: "",
      leaf: "my-project",
      separator: "/",
    });
  });

  it("recognizes full paths only", () => {
    const validFullPaths = [
      "~/",
      "/home/dev",
      "D:\\",
      "c:/x",
      "\\\\network\\share",
    ];
    for (const validPath of validFullPaths) {
      assert.equal(isFullPath(validPath), true, validPath);
    }

    const relativeOrIncompletePaths = ["~", "workspace", "D:", ""];
    for (const invalidPath of relativeOrIncompletePaths) {
      assert.equal(isFullPath(invalidPath), false, invalidPath);
    }
  });

  it("finds parent folders and compares folders loosely", () => {
    assert.equal(parentFolder("D:\\Workspaces\\ancilla"), "D:\\Workspaces\\");
    assert.equal(parentFolder("/home/dev/app/"), "/home/dev/");
    assert.equal(parentFolder("ancilla"), null);

    assert.equal(withTrailingSeparator("D:\\", "\\"), "D:\\");
    assert.equal(withTrailingSeparator("/home/dev", "/"), "/home/dev/");

    assert.equal(sameFolder("D:\\Workspaces\\Ancilla", "d:/workspaces/ancilla/"), true);
    assert.equal(sameFolder("/home/dev", "/home/DEV"), false);
  });

  it("turns typed repositories into clone URLs and folder names", () => {
    assert.equal(
      cloneUrl("aleff-ferreira/ancilla"),
      "https://github.com/aleff-ferreira/ancilla.git",
    );
    assert.equal(cloneUrl("git@github.com:aleff/ancilla.git"), "git@github.com:aleff/ancilla.git");
    assert.equal(cloneUrl("https://gitlab.com/org/repo"), "https://gitlab.com/org/repo");
    assert.equal(cloneUrl("not a repo"), null);

    assert.equal(repoName("https://github.com/aleff-ferreira/ancilla.git"), "ancilla");
    assert.equal(repoName("git@github.com:org/custom-tool.git"), "custom-tool");
  });
});
