import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cloneUrl, isFullPath, parentFolder, repoName, sameFolder, splitBrowsePath, withTrailingSeparator } from "../src/model/paths.js";

describe("picker paths", () => {
  it("splits typed text into the folder to list and a filter", () => {
    assert.deepEqual(splitBrowsePath("D:/Projects/app"), { directory: "D:/Projects/", leaf: "app", separator: "/" });
    assert.deepEqual(splitBrowsePath("~/"), { directory: "~/", leaf: "", separator: "/" });
    assert.deepEqual(splitBrowsePath("C:\\Users\\a"), { directory: "C:\\Users\\", leaf: "a", separator: "\\" });
    assert.deepEqual(splitBrowsePath("proj"), { directory: "", leaf: "proj", separator: "/" });
  });

  it("recognizes full paths only", () => {
    for (const path of ["~/", "/home/dev", "D:\\", "c:/x", "\\\\server\\share"]) {
      assert.equal(isFullPath(path), true, path);
    }
    for (const path of ["~", "projects", "D:", ""]) {
      assert.equal(isFullPath(path), false, path);
    }
  });

  it("finds parent folders and compares folders loosely", () => {
    assert.equal(parentFolder("D:\\Projects\\app"), "D:\\Projects\\");
    assert.equal(parentFolder("/home/dev/app/"), "/home/dev/");
    assert.equal(parentFolder("app"), null);
    assert.equal(withTrailingSeparator("D:\\", "\\"), "D:\\");
    assert.equal(withTrailingSeparator("/home", "/"), "/home/");
    assert.equal(sameFolder("D:\\Projects\\App", "d:/projects/app/"), true);
    assert.equal(sameFolder("/home/a", "/home/A"), false);
  });

  it("turns typed repositories into clone URLs and folder names", () => {
    assert.equal(cloneUrl("pingdotgg/t3code"), "https://github.com/pingdotgg/t3code.git");
    assert.equal(cloneUrl("git@github.com:a/b.git"), "git@github.com:a/b.git");
    assert.equal(cloneUrl("https://gitlab.com/g/p"), "https://gitlab.com/g/p");
    assert.equal(cloneUrl("not a repo"), null);
    assert.equal(repoName("https://github.com/a/b.git"), "b");
    assert.equal(repoName("git@github.com:a/b.git"), "b");
  });
});
