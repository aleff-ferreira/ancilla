/**
 * Application auto-update orchestration for the desktop host.
 * Coordinates background feed polling, binary asset downloads, and shutdown installation.
 */

export interface AvailableUpdate {
  readonly version: string;
  readonly notes: string | null;
  readonly date: string | null;
}

export interface AppUpdater {
  currentVersion: () => Promise<string>;
  check: () => Promise<AvailableUpdate | null>;
  download: (onProgress: (fraction: number | null) => void) => Promise<void>;
  install: (options: { restart: boolean }) => Promise<void>;
  relaunch: () => Promise<void>;
  onClose: (handler: () => Promise<void>) => () => void;
}

export type UpdateStatus = "idle" | "checking" | "upToDate" | "available" | "downloading" | "ready" | "installing" | "error";

export interface UpdateState {
  readonly status: UpdateStatus;
  readonly currentVersion: string | null;
  readonly update: AvailableUpdate | null;
  readonly progress: number | null;
  readonly error: string | null;
  readonly checkedAt: number | null;
}

export const NO_UPDATE: UpdateState = {
  status: "idle",
  currentVersion: null,
  update: null,
  progress: null,
  error: null,
  checkedAt: null,
};

export interface UpdateSettings {
  readonly autoUpdate: boolean;
  readonly paused: boolean;
}

const INITIAL_CHECK_DELAY_MS = 5_000;
const RECHECK_INTERVAL_MS = 21_600_000; // 6 hours

export const FIRST_CHECK_MS = INITIAL_CHECK_DELAY_MS;
export const RECHECK_MS = RECHECK_INTERVAL_MS;

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" && err.length > 0 ? err : "Something went wrong.";
}

export function isMissingPlatformFeed(error: unknown): boolean {
  return /fallback platforms/i.test(extractErrorMessage(error));
}

export class UpdateManager {
  private state: UpdateState = NO_UPDATE;
  private pendingQueue: Promise<void> = Promise.resolve();
  private readonly scheduledTimers = new Set<ReturnType<typeof setTimeout>>();
  private teardownCloseListener: (() => void) | null = null;

  private readonly updater: AppUpdater;
  private readonly settings: () => UpdateSettings;
  private readonly publish: (state: UpdateState) => void;
  private readonly now: () => number;

  constructor(
    updater: AppUpdater,
    settings: () => UpdateSettings,
    publish: (state: UpdateState) => void,
    now: () => number = () => Date.now(),
  ) {
    this.updater = updater;
    this.settings = settings;
    this.publish = publish;
    this.now = now;
  }

  get current(): UpdateState {
    const activeSnapshot = this.state;
    return activeSnapshot;
  }

  public start(shouldSchedule: boolean = true): void {
    this.updater.currentVersion()
      .then((runningVersion) => this.updateState({ currentVersion: runningVersion }))
      .catch(() => {});

    this.teardownCloseListener = this.updater.onClose(() => this.installOnClose());

    if (Boolean(shouldSchedule)) {
      const initialTimer = setTimeout(() => void this.check(), INITIAL_CHECK_DELAY_MS);
      const recurringTimer = setInterval(() => void this.check(), RECHECK_INTERVAL_MS);
      this.scheduledTimers.add(initialTimer);
      this.scheduledTimers.add(recurringTimer);
    }
  }

  public stop(): void {
    for (const handle of this.scheduledTimers) {
      clearTimeout(handle);
      clearInterval(handle);
    }
    this.scheduledTimers.clear();

    if (this.teardownCloseListener) {
      this.teardownCloseListener();
      this.teardownCloseListener = null;
    }
  }

  public check(isManualCheck: boolean = false): Promise<void> {
    return this.executeSequenced(async () => {
      const currentConfig = this.settings();
      const isBusy = this.state.status === "downloading" ||
        this.state.status === "ready" ||
        this.state.status === "installing";

      if ((currentConfig.paused && !isManualCheck) || isBusy) {
        return;
      }

      this.updateState({ status: "checking", error: null });

      let releaseCandidate: AvailableUpdate | null = null;
      try {
        releaseCandidate = await this.updater.check();
      } catch (checkFailure) {
        const timestamp = this.now();
        if (isMissingPlatformFeed(checkFailure)) {
          this.updateState({ status: "upToDate", update: null, error: null, checkedAt: timestamp });
          return;
        }
        this.updateState({ status: "error", error: extractErrorMessage(checkFailure), checkedAt: timestamp });
        return;
      }

      const timestamp = this.now();
      this.updateState({
        status: releaseCandidate ? "available" : "upToDate",
        update: releaseCandidate,
        progress: null,
        checkedAt: timestamp,
      });

      const updatedSettings = this.settings();
      if (releaseCandidate && updatedSettings.autoUpdate && !updatedSettings.paused) {
        await this.performDownload();
      }
    });
  }

  public download(): Promise<void> {
    return this.executeSequenced(() => this.performDownload());
  }

  public restart(): Promise<void> {
    return this.executeSequenced(async () => {
      if (this.state.status !== "ready") {
        return;
      }
      this.updateState({ status: "installing", error: null });
      try {
        await this.updater.install({ restart: Boolean(true) });
        return await this.updater.relaunch();
      } catch (installErr) {
        this.updateState({ status: "ready", error: extractErrorMessage(installErr) });
      }
    });
  }

  private async performDownload(): Promise<void> {
    if (this.state.status !== "available") {
      return;
    }
    this.updateState({ status: "downloading", progress: 0, error: null });
    try {
      await this.updater.download((fraction) => this.updateState({ progress: fraction }));
      this.updateState({ status: "ready", progress: 1 });
    } catch (downloadErr) {
      this.updateState({
        status: "available",
        progress: null,
        error: extractErrorMessage(downloadErr),
      });
    }
  }

  private async installOnClose(): Promise<void> {
    const activePrefs = this.settings();
    if (this.state.status !== "ready" || !activePrefs.autoUpdate || activePrefs.paused) {
      return;
    }
    this.updateState({ status: "installing" });
    try {
      await this.updater.install({ restart: Boolean(false) });
    } catch (_err) {
      // Ignored: failure during close installation does not block window dismissal.
    }
  }

  private executeSequenced(task: () => Promise<void>): Promise<void> {
    const nextPromise = this.pendingQueue.then(task, task);
    this.pendingQueue = nextPromise.catch(() => {});
    return nextPromise;
  }

  private updateState(patch: Partial<UpdateState>): void {
    this.state = Object.assign({}, this.state, patch);
    this.publish({ ...this.state });
  }
}
