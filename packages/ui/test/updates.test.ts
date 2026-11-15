import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  UpdateManager,
  type AppUpdater,
  type AvailableUpdate,
  type UpdateSettings,
  type UpdateStatus,
} from "../src/model/updates.js";

class FakeAppUpdater implements AppUpdater {
  nextReleasePayload: AvailableUpdate | null = { version: "1.3.0", notes: null, date: null };
  simulateNetworkFault = false;
  queryCheckCount = 0;
  retrieveDownloadCount = 0;
  invokedInstallFlags: boolean[] = [];
  triggerRelaunchCount = 0;
  registeredShutdownHook: (() => Promise<void>) | null = null;

  async currentVersion(): Promise<string> {
    return "1.2.0";
  }

  async check(): Promise<AvailableUpdate | null> {
    this.queryCheckCount += 1;
    if (this.simulateNetworkFault) {
      throw new Error("Could not fetch a valid release JSON from the remote");
    }
    return this.nextReleasePayload;
  }

  async download(reportProgress: (fraction: number | null) => void): Promise<void> {
    this.retrieveDownloadCount += 1;
    reportProgress(0.5);
    reportProgress(1.0);
  }

  async install(options: { restart: boolean }): Promise<void> {
    this.invokedInstallFlags.push(options.restart);
  }

  async relaunch(): Promise<void> {
    this.triggerRelaunchCount += 1;
  }

  onClose(shutdownCallback: () => Promise<void>): () => void {
    this.registeredShutdownHook = shutdownCallback;
    return () => {
      this.registeredShutdownHook = null;
    };
  }
}

interface TestSetupResult {
  updateService: UpdateManager;
  stubUpdater: FakeAppUpdater;
}

function createUpdateService(
  preferences: UpdateSettings,
  stub = new FakeAppUpdater(),
): TestSetupResult {
  const service = new UpdateManager(
    stub,
    () => preferences,
    () => undefined,
    () => 2000,
  );
  service.start(false);
  return { updateService: service, stubUpdater: stub };
}

function verifyServiceState(
  service: UpdateManager,
  expectedPhase: UpdateStatus,
  extraChecks?: { expectedProgress?: number | null; expectedVersion?: string },
): void {
  const currentState = service.current;
  assert.strictEqual(currentState.status, expectedPhase);
  if (extraChecks?.expectedProgress !== undefined) {
    assert.strictEqual(currentState.progress, extraChecks.expectedProgress);
  }
  if (extraChecks?.expectedVersion !== undefined) {
    assert.strictEqual(currentState.currentVersion, extraChecks.expectedVersion);
  }
}

describe("Desktop UpdateManager lifecycle", () => {
  it("downloads available update when auto-update is enabled and defers installation to shutdown", async () => {
    const { updateService, stubUpdater } = createUpdateService({ autoUpdate: true, paused: false });
    await updateService.check();

    verifyServiceState(updateService, "ready", { expectedProgress: 1 });
    assert.strictEqual(stubUpdater.retrieveDownloadCount, 1);

    await stubUpdater.registeredShutdownHook?.();
    assert.deepStrictEqual(stubUpdater.invokedInstallFlags, [false]);
    assert.strictEqual(updateService.current.currentVersion, "1.2.0");
  });

  it("holds update in available state when auto-update is disabled and triggers manual restart", async () => {
    const { updateService, stubUpdater } = createUpdateService({ autoUpdate: false, paused: false });
    await updateService.check();

    verifyServiceState(updateService, "available");
    assert.strictEqual(stubUpdater.retrieveDownloadCount, 0);

    await stubUpdater.registeredShutdownHook?.();
    assert.deepStrictEqual(stubUpdater.invokedInstallFlags, []);

    await updateService.download();
    await updateService.restart();

    assert.deepStrictEqual(stubUpdater.invokedInstallFlags, [true]);
    assert.strictEqual(stubUpdater.triggerRelaunchCount, 1);
  });

  it("respects paused check settings while honoring explicit manual update requests", async () => {
    const { updateService, stubUpdater } = createUpdateService({ autoUpdate: true, paused: true });
    await updateService.check();
    assert.strictEqual(stubUpdater.queryCheckCount, 0);

    await updateService.check(true);
    assert.strictEqual(stubUpdater.queryCheckCount, 1);
    verifyServiceState(updateService, "available");

    await stubUpdater.registeredShutdownHook?.();
    assert.deepStrictEqual(stubUpdater.invokedInstallFlags, []);
  });

  it("gracefully handles missing platform target in feed as up-to-date status", async () => {
    const customStub = new FakeAppUpdater();
    customStub.check = async () => {
      customStub.queryCheckCount += 1;
      throw new Error(
        'None of the fallback platforms `["darwin-aarch64-app", "darwin-aarch64"]` were found in the response `platforms` object',
      );
    };

    const { updateService } = createUpdateService({ autoUpdate: true, paused: false }, customStub);
    await updateService.check();

    verifyServiceState(updateService, "upToDate");
    assert.strictEqual(updateService.current.error, null);
    assert.strictEqual(updateService.current.checkedAt, 2000);
  });

  it("surfaces fetch errors and resolves back to up-to-date upon subsequent success", async () => {
    const failingStub = new FakeAppUpdater();
    failingStub.simulateNetworkFault = true;

    const { updateService } = createUpdateService({ autoUpdate: true, paused: false }, failingStub);
    await updateService.check();

    verifyServiceState(updateService, "error");
    assert.match(updateService.current.error ?? "", /release JSON/);

    failingStub.simulateNetworkFault = false;
    failingStub.nextReleasePayload = null;
    await updateService.check();

    verifyServiceState(updateService, "upToDate");
    assert.strictEqual(updateService.current.checkedAt, 2000);
  });
});
