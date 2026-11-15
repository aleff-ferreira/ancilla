import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findNativeMuse, nativeReleaseInfo, parseRuntimePreference, type FileProbe } from "../src/native.js";
import { planMuseCli, planServe, probeEnvironment, type ExecFn } from "../src/wsl.js";

function createMockFiles(fileMap: Record<string, string>): FileProbe {
  return {
    exists: (filePath: string) => filePath in fileMap,
    read: (filePath: string) => fileMap[filePath] ?? null,
  };
}

const DEFAULT_MUSE_DIR = "C:\\Users\\ada\\AppData\\Local\\Programs\\muse";

describe("Windows native Muse discovery", () => {
  it("discovers active Muse binary installed by PowerShell script", () => {
    const files = createMockFiles({
      [`${DEFAULT_MUSE_DIR}\\.muse-version`]: "1.3.0-R3301.2\n",
      [`${DEFAULT_MUSE_DIR}\\muse-bin-1.3.0-R3301.2.exe`]: "",
      [`${DEFAULT_MUSE_DIR}\\muse-bin-1.3.0-R3233.1.exe`]: "",
      [`${DEFAULT_MUSE_DIR}\\.muse-launcher.ps1`]: "",
      [`${DEFAULT_MUSE_DIR}\\.muse-release-info.json`]: '{"version":"1.3.0-R3301.2"}',
    });
    const found = findNativeMuse({ LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local", Path: "C:\\Windows" }, files);
    assert.deepEqual(found, {
      binary: `${DEFAULT_MUSE_DIR}\\muse-bin-1.3.0-R3301.2.exe`,
      dir: DEFAULT_MUSE_DIR,
      version: "1.3.0-R3301.2",
      launcher: `${DEFAULT_MUSE_DIR}\\.muse-launcher.ps1`,
    });
    assert.equal(nativeReleaseInfo(found!, files), '{"version":"1.3.0-R3301.2"}');
  });

  it("prioritizes MUSE_INSTALL_DIR override and discovers PATH binaries", () => {
    const customDir = "D:\\tools\\muse";
    const files = createMockFiles({
      [`${DEFAULT_MUSE_DIR}\\.muse-version`]: "1.3.0-R1.0",
      [`${customDir}\\.muse-version`]: "1.3.0-R9.0",
      [`${customDir}\\muse-bin-1.3.0-R9.0.exe`]: "",
      "E:\\bin\\muse.exe": "",
    });
    assert.equal(
      findNativeMuse({ MUSE_INSTALL_DIR: customDir, LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" }, files)?.binary,
      `${customDir}\\muse-bin-1.3.0-R9.0.exe`,
    );
    assert.equal(
      findNativeMuse({ LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local", Path: "E:\\bin" }, files)?.binary,
      "E:\\bin\\muse.exe",
    );
    assert.equal(findNativeMuse({ LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" }, files), null);
  });

  it("returns null for malformed version or missing binary", () => {
    const files = createMockFiles({
      [`${DEFAULT_MUSE_DIR}\\.muse-version`]: "invalid-version",
      [`${DEFAULT_MUSE_DIR}\\muse-bin-invalid.exe`]: "",
    });
    assert.equal(findNativeMuse({ LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" }, files), null);
  });
});

describe("native Muse release metadata", () => {
  it("returns payload when version matches and null when mismatched or malformed", () => {
    const muse = {
      binary: `${DEFAULT_MUSE_DIR}\\muse-bin-1.3.0-R1.exe`,
      dir: DEFAULT_MUSE_DIR,
      version: "1.3.0-R1",
      launcher: null,
    };
    const matching = createMockFiles({
      [`${DEFAULT_MUSE_DIR}\\.muse-release-info.json`]: '{"version":"1.3.0-R1"}',
    });
    assert.equal(nativeReleaseInfo(muse, matching), '{"version":"1.3.0-R1"}');

    const mismatched = createMockFiles({
      [`${DEFAULT_MUSE_DIR}\\.muse-release-info.json`]: '{"version":"1.3.0-R2"}',
    });
    assert.equal(nativeReleaseInfo(muse, mismatched), null);

    const malformed = createMockFiles({
      [`${DEFAULT_MUSE_DIR}\\.muse-release-info.json`]: 'not-valid-json',
    });
    assert.equal(nativeReleaseInfo(muse, malformed), null);

    const noVersion = { ...muse, version: null };
    assert.equal(nativeReleaseInfo(noVersion, matching), null);
  });
});

describe("runtime preference parser and environment probe", () => {
  it("prefers native Muse over WSL unless WSL is explicitly requested", async () => {
    const native = { binary: `${DEFAULT_MUSE_DIR}\\muse-bin-1.3.0-R1.exe`, dir: DEFAULT_MUSE_DIR, version: "1.3.0-R1", launcher: null };
    let wslInvocations = 0;
    const exec: ExecFn = async (command) => {
      if (command === "wsl") wslInvocations += 1;
      return { stdout: "", exitCode: 1 };
    };
    const autoProbe = await probeEnvironment(exec, "win32", { findNative: () => native });
    assert.equal(autoProbe.runtime, "native");
    assert.equal(autoProbe.musePath, native.binary);
    assert.equal(wslInvocations, 0, "WSL is not probed when native Muse is available");

    const wslProbe = await probeEnvironment(exec, "win32", { findNative: () => native, preference: "wsl" });
    assert.equal(wslProbe.runtime, "wsl");

    const missingProbe = await probeEnvironment(exec, "win32", { findNative: () => null });
    assert.equal(missingProbe.runtime, "wsl");
    assert.equal(missingProbe.musePath, null);
  });

  it("plans native commands directly on Windows", () => {
    assert.deepEqual(planServe({ platform: "win32", runtime: "native", musePath: "C:\\m\\muse.exe", cwd: "D:\\a b" }), {
      command: "C:\\m\\muse.exe",
      args: ["serve"],
      cwd: "D:\\a b",
      viaWsl: false,
      distro: null,
    });
    assert.deepEqual(planMuseCli({ platform: "win32", runtime: "native", musePath: "C:\\m\\muse.exe", args: ["skills", "list", "--workspace", "D:\\a b"] }), {
      command: "C:\\m\\muse.exe",
      args: ["skills", "list", "--workspace", "D:\\a b"],
    });
  });

  it("parses ANCILLA_MUSE_RUNTIME / --runtime preference values", () => {
    assert.equal(parseRuntimePreference("WSL"), "wsl");
    assert.equal(parseRuntimePreference("wsl"), "wsl");
    assert.equal(parseRuntimePreference("windows"), "native");
    assert.equal(parseRuntimePreference("WINDOWS"), "native");
    assert.equal(parseRuntimePreference("native"), "native");
    assert.equal(parseRuntimePreference("auto"), "auto");
    assert.equal(parseRuntimePreference(""), "auto");
    assert.equal(parseRuntimePreference(null), "auto");
    assert.equal(parseRuntimePreference(undefined), "auto");
    assert.equal(parseRuntimePreference("unknown"), "auto");
  });
});
