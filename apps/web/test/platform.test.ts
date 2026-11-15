import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FileSaveOptions } from "@ancilla/ui";
import { appPlatform, saveDesktopFile } from "../src/platform.js";
import { desktopUpdater } from "../src/updater.js";

const globals = globalThis as Record<string, unknown>;
const originalWindow = globals["window"];
afterEach(() => { globals["window"] = originalWindow; });

const options: FileSaveOptions = { name: "report.docx", extension: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", description: "Word document" };

describe("native report saving", () => {
  it("selects a native destination first, then writes the bytes to that exact path", async () => {
    const events: string[] = [];
    const bytes = new Uint8Array([80, 75, 3, 4]);
    const path = "C:\\Users\\Aleff\\Documents\\My report.docx";
    globals["window"] = { __TAURI_INTERNALS__: {
      invoke: async (command: string, payload: unknown, request?: { headers: { path: string } }) => {
        if (command === "plugin:dialog|save") {
          events.push("picker");
          assert.deepEqual(payload, { options: { title: "Save research report", defaultPath: "report.docx", filters: [{ name: "Word document", extensions: ["docx"] }] } });
          return path;
        }
        assert.equal(command, "plugin:fs|write_file");
        assert.equal(decodeURIComponent(request?.headers.path ?? ""), path);
        assert.deepEqual(payload, bytes);
        events.push("write");
      },
    } };
    assert.equal(appPlatform().saveFile, saveDesktopFile);
    const result = await saveDesktopFile(options, async () => { events.push("read"); return bytes; });
    assert.deepEqual(events, ["picker", "read", "write"]);
    assert.deepEqual(result, { kind: "saved", name: "My report.docx", path });
  });

  it("does not render or write a cancelled export", async () => {
    globals["window"] = { __TAURI_INTERNALS__: { invoke: async (command: string) => {
      assert.equal(command, "plugin:dialog|save");
      return null;
    } } };
    assert.equal(await saveDesktopFile(options, async () => assert.fail("must not render")), null);
  });

  it("leaves the selected file alone if the export request fails", async () => {
    globals["window"] = { __TAURI_INTERNALS__: { invoke: async (command: string) => {
      assert.equal(command, "plugin:dialog|save");
      return "/chosen/report.docx";
    } } };
    await assert.rejects(saveDesktopFile(options, async () => { throw new Error("Export failed"); }), /Export failed/);
  });

  it("rejects native write errors rather than reporting a saved document", async () => {
    globals["window"] = { __TAURI_INTERNALS__: { invoke: async (command: string) => {
      if (command === "plugin:dialog|save") return "/chosen/report.docx";
      throw new Error("Read-only destination");
    } } };
    await assert.rejects(saveDesktopFile(options, async () => new Uint8Array([1])), /Read-only destination/);
  });

  it("keeps the browser save implementation outside the desktop shell", () => {
    globals["window"] = {};
    assert.notEqual(appPlatform().saveFile, saveDesktopFile);
    assert.equal(typeof appPlatform().saveFile, "function");
  });
});

describe("Linux desktop integration", () => {
  it("exposes only the native Linux setup commands and the requested desktop choice", async () => {
    const calls: [string, unknown][] = [];
    const status = { kind: "appimage", menuInstalled: false, desktopShortcutInstalled: false, desktopShortcutSupported: true, canInstall: true, restartRequired: false, installedPath: null };
    globals["window"] = { __ANCILLA_LINUX_INSTALL__: "appimage", __TAURI_INTERNALS__: { invoke: async (command: string, payload: unknown) => {
      calls.push([command, payload]);
      return command === "relaunch_installed_linux" ? undefined : status;
    } } };
    const desktop = appPlatform().linuxDesktop;
    assert.ok(desktop);
    assert.deepEqual(await desktop.status(), status);
    await desktop.install({ desktopShortcut: true });
    await desktop.relaunch();
    assert.deepEqual(calls.map(([command]) => command), ["linux_installation_status", "install_linux_launcher", "relaunch_installed_linux"]);
    assert.deepEqual(calls[1]?.[1], { desktopShortcut: true });
  });

  it("never attaches the AppImage updater to a Debian/RPM installation", () => {
    globals["window"] = { __ANCILLA_LINUX_INSTALL__: "package", __TAURI_INTERNALS__: { invoke: () => assert.fail("must not invoke updater") } };
    assert.equal(desktopUpdater(), undefined);
    globals["window"] = { __ANCILLA_LINUX_INSTALL__: "development", __TAURI_INTERNALS__: {} };
    assert.equal(desktopUpdater(), undefined);
    globals["window"] = { __ANCILLA_LINUX_INSTALL__: "appimage", __TAURI_INTERNALS__: {} };
    assert.ok(desktopUpdater());
  });

  it("keeps Linux integration out of browsers and other desktop platforms", () => {
    globals["window"] = {};
    assert.equal(appPlatform().linuxDesktop, undefined);
    globals["window"] = { __TAURI_INTERNALS__: {} };
    assert.equal(appPlatform().linuxDesktop, undefined);
  });
});
