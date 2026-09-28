import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { saveBrowserFile, type FileSaveOptions } from "../src/model/fileSave.js";

const options: FileSaveOptions = { name: "report.pdf", extension: "pdf", mimeType: "application/pdf", description: "PDF document" };
const globals = globalThis as Record<string, unknown>;
const originalWindow = globals["window"];
const originalDocument = globals["document"];

afterEach(() => {
  globals["window"] = originalWindow;
  globals["document"] = originalDocument;
  mock.restoreAll();
});

describe("browser document saving", () => {
  it("opens Save As synchronously before loading bytes and commits the selected filename", async () => {
    const events: string[] = [];
    const bytes = new Uint8Array([1, 2, 3]);
    globals["window"] = {
      showSaveFilePicker: (picked: unknown) => {
        events.push("picker");
        assert.deepEqual(picked, {
          id: "ancilla-report", suggestedName: "report.pdf",
          types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }],
        });
        return Promise.resolve({
          name: "selected.pdf",
          createWritable: async () => {
            events.push("writer");
            return {
              write: async (value: Uint8Array) => { assert.deepEqual(value, bytes); events.push("write"); },
              close: async () => { events.push("close"); },
              abort: async () => { events.push("abort"); },
            };
          },
        });
      },
    };
    const saved = saveBrowserFile(options, async () => { events.push("read"); return bytes; });
    assert.deepEqual(events, ["picker"], "the picker retains the menu click's user activation");
    assert.deepEqual(await saved, { kind: "saved", name: "selected.pdf" });
    assert.deepEqual(events, ["picker", "read", "writer", "write", "close"]);
  });

  it("cancellation does not render or write a document", async () => {
    globals["window"] = { showSaveFilePicker: async () => { throw new DOMException("Cancelled", "AbortError"); } };
    const result = await saveBrowserFile(options, async () => assert.fail("cancelled exports must not load bytes"));
    assert.equal(result, null);
  });

  it("does not hide picker errors as cancellation or start a fallback download", async () => {
    globals["window"] = { showSaveFilePicker: async () => { throw new DOMException("Permission denied", "SecurityError"); } };
    await assert.rejects(saveBrowserFile(options, async () => assert.fail("must not render")), /Permission denied/);
  });

  it("preserves the existing destination when rendering or downloading fails", async () => {
    globals["window"] = {
      showSaveFilePicker: async () => ({ name: "report.pdf", createWritable: async () => assert.fail("must not open a writer") }),
    };
    await assert.rejects(saveBrowserFile(options, async () => { throw new Error("Server unavailable"); }), /Server unavailable/);
  });

  it("aborts the pending writer on a write error and reports that failure", async () => {
    let aborted = false;
    globals["window"] = {
      showSaveFilePicker: async () => ({
        name: "report.pdf",
        createWritable: async () => ({
          write: async () => { throw new Error("Disk full"); },
          close: async () => assert.fail("must not commit a failed write"),
          abort: async () => { aborted = true; },
        }),
      }),
    };
    await assert.rejects(saveBrowserFile(options, async () => new Uint8Array([1])), /Disk full/);
    assert.equal(aborted, true);
  });

  it("uses a local binary download when a browser has no save picker and releases its URL", async () => {
    const events: string[] = [];
    let revoke: (() => void) | undefined;
    const anchor = {
      href: "", download: "", rel: "",
      click: () => events.push("click"), remove: () => events.push("remove"),
    };
    globals["window"] = { setTimeout: (callback: () => void) => { revoke = callback; } };
    globals["document"] = { createElement: () => anchor, body: { appendChild: () => events.push("append") } };
    mock.method(URL, "createObjectURL", (blob: Blob) => { assert.equal(blob.type, "application/pdf"); assert.equal(blob.size, 3); return "blob:report"; });
    mock.method(URL, "revokeObjectURL", (url: string) => { assert.equal(url, "blob:report"); events.push("revoke"); });
    const saved = await saveBrowserFile(options, async () => new Uint8Array([1, 2, 3]));
    assert.deepEqual(saved, { kind: "download", name: "report.pdf" });
    assert.equal(anchor.href, "blob:report");
    assert.equal(anchor.download, "report.pdf");
    assert.deepEqual(events, ["append", "click", "remove"]);
    revoke?.();
    assert.deepEqual(events, ["append", "click", "remove", "revoke"]);
  });
});
