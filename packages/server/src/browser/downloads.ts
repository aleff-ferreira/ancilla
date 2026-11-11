import { execFile } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

/**
 * Downloads of the internal browser. The browser writes into a staging folder inside the data dir and nowhere else; when a
 * file has finished the person is asked which folder it goes to, and only then is it moved there. Nothing is written to a
 * folder the person did not choose. No answer, a closed browser or a restart deletes the staged file.
 */

/** One file may not be bigger than this; the browser is told to cancel beyond it. */
export const MAX_DOWNLOAD_BYTES = 1024 ** 3;
/** What may sit in staging at once (waiting for an answer or still downloading). */
export const MAX_STAGED_BYTES = 2 * 1024 ** 3;
/** A question nobody answers in this long deletes the file. */
export const ASK_MS = 10 * 60_000;

export class DownloadError extends Error {}

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME = 120;

/** A file name that is safe on every system: no separators or control characters, no reserved Windows names, bounded, extension kept. */
export function sanitizeFileName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let name = String(raw ?? "").replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, "_").replace(/\s+/g, " ").trim();
  name = name.replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (name === "") name = "download";
  const ext = extname(name).slice(0, 16);
  let stem = ext ? name.slice(0, name.length - ext.length) : name;
  if (RESERVED.test(stem)) stem = `_${stem}`;
  if (stem.length + ext.length > MAX_NAME) stem = stem.slice(0, MAX_NAME - ext.length);
  return `${stem === "" ? "download" : stem}${ext}`;
}

const RUNNABLE = new Set([".exe", ".msi", ".bat", ".cmd", ".com", ".ps1", ".psm1", ".vbs", ".vbe", ".wsf", ".sh", ".bash", ".jar", ".scr", ".lnk", ".dmg", ".app", ".pkg", ".apk", ".deb", ".rpm", ".appimage", ".reg", ".hta", ".js", ".jse"]);

/** A plain warning for a file that runs programs when opened; null for anything else. It never blocks: the file is the person's. */
export function riskWarning(name: string): string | null {
  const ext = extname(name).toLowerCase();
  return RUNNABLE.has(ext) ? `${ext} files can run programs. Only keep it if you trust where it came from.` : null;
}

/** An existing, writable folder as the absolute path the server can use. Throws a plain message otherwise. */
export function checkDownloadFolder(input: string): string {
  let value = String(input ?? "").trim();
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) value = join(homedir(), value.slice(1));
  if (value === "" || value.includes("\0") || !isAbsolute(value)) throw new DownloadError("Choose a full folder path.");
  const folder = resolve(value);
  let stat;
  try {
    stat = statSync(folder);
  } catch {
    throw new DownloadError("That folder does not exist.");
  }
  if (!stat.isDirectory()) throw new DownloadError("That is not a folder.");
  try {
    accessSync(folder, constants.W_OK);
  } catch {
    throw new DownloadError("Ancilla cannot write to that folder.");
  }
  return folder;
}

/** `name`, or `name (1).ext`, `name (2).ext` ... the first that does not exist in `folder`. */
export function freeName(folder: string, name: string): string {
  if (!existsSync(join(folder, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!existsSync(join(folder, candidate))) return candidate;
  }
  throw new DownloadError("Too many files with that name in the folder.");
}

/** What the person is asked about, as the pane and the Tasks row show it. */
export interface DownloadInfo {
  id: string;
  /** The tab it came from (the pane shows the question of its own tabs only). */
  tabId: string | null;
  name: string;
  size: number | null;
  origin: string;
  page: string;
  /** Where it will go unless the person picks another folder. */
  folder: string;
  warning: string | null;
  /** True when the user opted to remember their preferred download folder. */
  rememberFolder?: boolean;
}

export interface DownloadPreferences {
  /** Effective default folder (preferred if valid, else Downloads, else home). */
  folder: string;
  /** Saved folder path if still valid, else null. */
  preferredFolder: string | null;
  /** When true, non-runnable downloads in the user's own tabs save directly to `folder`. */
  rememberFolder: boolean;
}

export interface NativeFolderPickResult {
  /** False when this machine/session has no native GUI folder dialog (the UI falls back to `FolderPicker`). */
  supported: boolean;
  /** Chosen folder path, or null when cancelled or unsupported. */
  folder: string | null;
}

export type NativePickerExec = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }>;

const PICKER_TIMEOUT_MS = 120_000;

const defaultPickerExec: NativePickerExec = (file, args, env, timeoutMs) =>
  new Promise((resolvePromise) => {
    execFile(file, args, { env, timeout: timeoutMs, windowsHide: false }, (error, stdout, stderr) => {
      const errno = error as NodeJS.ErrnoException | null;
      if (errno?.code === "ENOENT") {
        resolvePromise({ code: null, stdout: "", stderr: String(stderr ?? ""), missing: true });
        return;
      }
      const exitCode = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : error ? 1 : 0;
      resolvePromise({ code: exitCode, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

/**
 * Opens a native OS folder-picker dialog on the host running Ancilla (Windows FolderBrowserDialog, macOS `osascript`
 * `choose folder`, or Linux `zenity`/`kdialog` when a GUI display is active). Initial directory is passed via
 * `ANCILLA_START_DIR` in the child environment so paths are never interpolated into script text.
 */
export async function pickNativeFolder(
  initialFolder?: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exec?: NativePickerExec; timeoutMs?: number } = {},
): Promise<NativeFolderPickResult> {
  const platform = options.platform ?? process.platform;
  const baseEnv = options.env ?? process.env;
  const run = options.exec ?? defaultPickerExec;
  const timeoutMs = options.timeoutMs ?? PICKER_TIMEOUT_MS;
  let startDir = "";
  if (initialFolder) {
    try {
      startDir = checkDownloadFolder(initialFolder);
    } catch {
      startDir = "";
    }
  }
  const env: NodeJS.ProcessEnv = { ...baseEnv, ANCILLA_START_DIR: startDir };

  const acceptPicked = (raw: string): NativeFolderPickResult => {
    const trimmed = raw.trim();
    if (!trimmed) return { supported: true, folder: null };
    try {
      return { supported: true, folder: checkDownloadFolder(trimmed) };
    } catch {
      return { supported: true, folder: null };
    }
  };

  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
      "$d.Description = 'Choose a download folder';",
      "$d.ShowNewFolderButton = $true;",
      "if ($env:ANCILLA_START_DIR -and (Test-Path -LiteralPath $env:ANCILLA_START_DIR)) { $d.SelectedPath = $env:ANCILLA_START_DIR };",
      "$r = $d.ShowDialog();",
      "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($d.SelectedPath); exit 0 } else { exit 2 }",
    ].join(" ");
    const res = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], env, timeoutMs);
    if (res.missing) return { supported: false, folder: null };
    if (res.code === 0) return acceptPicked(res.stdout);
    if (res.code === 2) return { supported: true, folder: null };
    return { supported: false, folder: null };
  }

  if (platform === "darwin") {
    const args = [
      "-e", 'set startDir to system attribute "ANCILLA_START_DIR"',
      "-e", 'if startDir is not "" then',
      "-e", "try",
      "-e", 'return POSIX path of (choose folder with prompt "Choose a download folder" default location (POSIX file startDir))',
      "-e", "end try",
      "-e", "end if",
      "-e", 'return POSIX path of (choose folder with prompt "Choose a download folder")',
    ];
    const res = await run("osascript", args, env, timeoutMs);
    if (res.missing) return { supported: false, folder: null };
    if (res.code === 0) return acceptPicked(res.stdout);
    if (/user canceled|-128/i.test(res.stderr)) return { supported: true, folder: null };
    return { supported: false, folder: null };
  }

  if (platform === "linux") {
    if (!baseEnv["DISPLAY"] && !baseEnv["WAYLAND_DISPLAY"]) {
      return { supported: false, folder: null };
    }
    const zenityArgs = ["--file-selection", "--directory", "--title=Choose a download folder"];
    if (startDir) zenityArgs.push(`--filename=${startDir.endsWith("/") ? startDir : `${startDir}/`}`);
    const zen = await run("zenity", zenityArgs, env, timeoutMs);
    if (!zen.missing) {
      if (zen.code === 0) return acceptPicked(zen.stdout);
      if (zen.code === 1 && !/cannot open display/i.test(zen.stderr)) return { supported: true, folder: null };
      return { supported: false, folder: null };
    }
    const kd = await run("kdialog", ["--getexistingdirectory", startDir || homedir(), "--title", "Choose a download folder"], env, timeoutMs);
    if (!kd.missing) {
      if (kd.code === 0) return acceptPicked(kd.stdout);
      if (kd.code === 1 && !/cannot connect to X server/i.test(kd.stderr)) return { supported: true, folder: null };
    }
    return { supported: false, folder: null };
  }

  return { supported: false, folder: null };
}

export class DownloadDesk {
  private lastFolder: string | null = null;
  private rememberPreferred = false;

  constructor(
    /** The staging folder. Emptied by `reset`. */
    readonly dir: string,
    private readonly memoryFile: string | null,
    private readonly home: string = homedir(),
  ) {
    try {
      const saved = JSON.parse(readFileSync(memoryFile ?? "", "utf8")) as { folder?: unknown; rememberFolder?: unknown };
      if (typeof saved.folder === "string") this.lastFolder = saved.folder;
      if (saved.rememberFolder === true) this.rememberPreferred = true;
    } catch {
      // nothing remembered yet
    }
  }

  /** Empties staging (what a run left behind is never kept) and makes sure it exists. */
  reset(): void {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }

  stagedPath(guid: string): string {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(guid)) throw new DownloadError("Bad download id.");
    return join(this.dir, guid);
  }

  /** What is in staging now, in bytes. */
  stagedBytes(): number {
    try {
      return readdirSync(this.dir).reduce((sum, file) => {
        try {
          return sum + statSync(join(this.dir, file)).size;
        } catch {
          return sum;
        }
      }, 0);
    } catch {
      return 0;
    }
  }

  /** The last folder used if it still exists, else the Downloads folder, else home. */
  defaultFolder(): string {
    for (const candidate of [this.lastFolder, join(this.home, "Downloads"), this.home]) {
      if (!candidate) continue;
      try {
        return checkDownloadFolder(candidate);
      } catch {
        // try the next
      }
    }
    return this.home;
  }

  preferences(): DownloadPreferences {
    let preferredFolder: string | null = null;
    if (this.lastFolder) {
      try {
        preferredFolder = checkDownloadFolder(this.lastFolder);
      } catch {
        preferredFolder = null;
      }
    }
    return {
      folder: this.defaultFolder(),
      preferredFolder,
      rememberFolder: this.rememberPreferred,
    };
  }

  setPreferences(patch: { folder?: string; rememberFolder?: boolean }): DownloadPreferences {
    if (patch.folder !== undefined) {
      this.lastFolder = checkDownloadFolder(patch.folder);
    } else if (patch.rememberFolder === true && !this.lastFolder) {
      this.lastFolder = checkDownloadFolder(this.defaultFolder());
    }
    if (typeof patch.rememberFolder === "boolean") {
      this.rememberPreferred = patch.rememberFolder;
    }
    this.persist();
    return this.preferences();
  }

  /**
   * When the user opted to remember their preferred download folder, normal files in their own tabs save straight there.
   * Runnable files (.exe, .sh, ...) always return null so the warning dialog is shown first.
   */
  shouldAutoSave(fileName: string): string | null {
    if (!this.rememberPreferred) return null;
    if (riskWarning(fileName) !== null) return null;
    const candidate = this.lastFolder ?? this.defaultFolder();
    try {
      return checkDownloadFolder(candidate);
    } catch {
      return null;
    }
  }

  discard(guid: string): void {
    try {
      unlinkSync(this.stagedPath(guid));
    } catch {
      // already gone
    }
  }

  /**
   * Moves the staged file into the folder the person chose, under its cleaned name, never over a file that is there. Returns the
   * path it was saved to. The folder is checked again here: it may have changed since it was picked.
   */
  save(guid: string, name: string, folderInput: string, rememberFolder?: boolean): string {
    const folder = checkDownloadFolder(folderInput);
    const staged = this.stagedPath(guid);
    if (!existsSync(staged)) throw new DownloadError("The downloaded file is gone.");
    const clean = sanitizeFileName(name);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const target = join(folder, freeName(folder, clean));
      if (resolve(dirname(target)) !== folder) throw new DownloadError("That name does not fit the folder.");
      try {
        copyFileSync(staged, target, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw new DownloadError(`Could not save the file: ${(error as Error).message}`);
      }
      this.discard(guid);
      if (typeof rememberFolder === "boolean") this.rememberPreferred = rememberFolder;
      this.remember(folder);
      return target;
    }
    throw new DownloadError("Could not find a free name in that folder.");
  }

  private remember(folder: string): void {
    this.lastFolder = folder;
    this.persist();
  }

  private persist(): void {
    if (!this.memoryFile) return;
    try {
      mkdirSync(dirname(this.memoryFile), { recursive: true });
      const temp = `${this.memoryFile}.${process.pid}.tmp`;
      const payload: Record<string, unknown> = {};
      if (this.lastFolder) payload["folder"] = this.lastFolder;
      if (this.rememberPreferred) payload["rememberFolder"] = true;
      writeFileSync(temp, JSON.stringify(payload), "utf8");
      renameSync(temp, this.memoryFile);
    } catch {
      // the folder still holds for this run
    }
  }
}
