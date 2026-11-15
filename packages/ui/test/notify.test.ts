import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NotificationManager,
  type Notifier,
  type NotifyPermission,
} from "../src/model/notify.js";

class MockNotificationSink implements Notifier {
  public recordedDispatches: Array<{ title: string; body: string; tag: string; onClick?: () => void }> = [];
  public requestCount = 0;
  public queryCount = 0;
  public throwOnShow = false;

  constructor(private currentPermission: NotifyPermission = "granted") {}

  async permission(): Promise<NotifyPermission> {
    this.queryCount += 1;
    return this.currentPermission;
  }

  async request(): Promise<NotifyPermission> {
    this.requestCount += 1;
    return this.currentPermission;
  }

  async show(note: { title: string; body: string; tag: string; onClick?: () => void }): Promise<void> {
    if (this.throwOnShow) {
      throw new Error("System desktop notification display error");
    }
    this.recordedDispatches.push(note);
  }

  setPermission(next: NotifyPermission): void {
    this.currentPermission = next;
  }
}

class MockTimeKeeper {
  private timestampMs: number;

  constructor(initialMs = 50_000) {
    this.timestampMs = initialMs;
  }

  getTime = (): number => this.timestampMs;

  advanceBy(ms: number): void {
    this.timestampMs += ms;
  }
}

describe("NotificationManager lifecycle and suppression rules", () => {
  describe("focus and permission gates", () => {
    it("suppresses notifications when the application window is actively focused", async () => {
      const sink = new MockNotificationSink();
      const manager = new NotificationManager(sink, () => ({ enabled: true, focused: true }));

      await manager.announce({ kind: "approval", sessionId: "sess-1", thread: "code-review" });
      assert.strictEqual(sink.recordedDispatches.length, 0);
    });

    it("suppresses notifications when the master preference switch is disabled", async () => {
      const sink = new MockNotificationSink();
      const manager = new NotificationManager(sink, () => ({ enabled: false, focused: false }));

      await manager.announce({ kind: "approval", sessionId: "sess-1", thread: "code-review" });
      assert.strictEqual(sink.recordedDispatches.length, 0);
    });

    it("does not dispatch and does not prompt for permission on default/denied status", async () => {
      const unpermittedSink = new MockNotificationSink("default");
      const manager = new NotificationManager(unpermittedSink, () => ({ enabled: true, focused: false }));

      await manager.announce({ kind: "approval", sessionId: "sess-1", thread: "code-review" });
      assert.strictEqual(unpermittedSink.recordedDispatches.length, 0);
      assert.strictEqual(unpermittedSink.requestCount, 0, "request() must only be triggered by explicit user gestures");
    });
  });

  describe("thread notification payload formatting", () => {
    it("formats approval, question, and completion events accurately", async () => {
      const sink = new MockNotificationSink();
      const manager = new NotificationManager(sink, () => ({ enabled: true, focused: false }));

      await manager.announce({ kind: "approval", sessionId: "sess-1", thread: "audit-pipeline" });
      await manager.announce({ kind: "question", sessionId: "sess-2", thread: "planner" });
      await manager.announce({ kind: "finished", sessionId: "sess-3", thread: "build-step", failed: false });
      await manager.announce({ kind: "finished", sessionId: "sess-4", thread: "test-step", failed: true });
      await manager.announce({ kind: "goal", sessionId: "sess-5", thread: "refactor", status: "complete" });

      assert.strictEqual(sink.recordedDispatches.length, 5);
      assert.match(sink.recordedDispatches[0]?.title ?? "", /waiting on you/i);
      assert.match(sink.recordedDispatches[1]?.title ?? "", /question/i);
      assert.match(sink.recordedDispatches[2]?.title ?? "", /finished/i);
      assert.match(sink.recordedDispatches[3]?.title ?? "", /failed/i);
      assert.match(sink.recordedDispatches[4]?.title ?? "", /complete/i);
    });

    it("formats multi-thread batch completion summaries", async () => {
      const sink = new MockNotificationSink();
      const clock = new MockTimeKeeper();
      const manager = new NotificationManager(sink, () => ({ enabled: true, focused: false }), clock.getTime);

      await manager.announce({ kind: "finishedMany", count: 8, failed: 0 });
      clock.advanceBy(25_000);
      await manager.announce({ kind: "finishedMany", count: 8, failed: 2 });

      assert.strictEqual(sink.recordedDispatches[0]?.body, "8 threads are done.");
      assert.strictEqual(sink.recordedDispatches[1]?.body, "8 threads ended, 2 with an error.");
    });
  });

  describe("task notification payload formatting and sanitization", () => {
    it("maps all Assistant waiting causes to distinct notification titles and bodies", async () => {
      const sink = new MockNotificationSink();
      const manager = new NotificationManager(sink, () => ({ enabled: true, focused: false }));

      const causes = [
        { cause: "approval" as const, titleSnippet: "needs your approval" },
        { cause: "site" as const, titleSnippet: "waiting on you" },
        { cause: "action" as const, titleSnippet: "waiting on you" },
        { cause: "download" as const, titleSnippet: "waiting on you" },
        { cause: "question" as const, titleSnippet: "waiting on you" },
        { cause: "change" as const, titleSnippet: "waiting on you" },
        { cause: "blocked" as const, titleSnippet: "needs you" },
      ];

      for (let i = 0; i < causes.length; i++) {
        await manager.announce({
          kind: "task",
          taskId: `task-${i}`,
          cause: causes[i].cause,
          title: `Step ${i}`,
        });
        assert.match(sink.recordedDispatches[i]?.title ?? "", new RegExp(causes[i].titleSnippet, "i"));
      }
    });

    it("sanitizes control characters and truncates lengthy task titles", async () => {
      const sink = new MockNotificationSink();
      const manager = new NotificationManager(sink, () => ({ enabled: true, focused: false }));

      const longTitle = "Research comprehensive architectural blueprints " + "for Ancilla ".repeat(10);
      await manager.announce({ kind: "task", taskId: "t-long", cause: "site", title: `\tRun\n  ${longTitle}\u0000` });
      await manager.announce({ kind: "task", taskId: "t-empty", cause: "site", title: "   \t\n  " });

      const firstBody = sink.recordedDispatches[0]?.body ?? "";
      assert.doesNotMatch(firstBody, /[\t\n\u0000]/);
      assert.ok(firstBody.includes("..."), "long titles should terminate with ellipsis");
      assert.strictEqual(sink.recordedDispatches[1]?.body, "A task asks before opening a site.");
    });
  });

  describe("deduplication and rate-limiting window", () => {
    it("throttles repeated events within the 20-second suppression window", async () => {
      const sink = new MockNotificationSink();
      const clock = new MockTimeKeeper(10_000);
      const manager = new NotificationManager(sink, () => ({ enabled: true, focused: false }), clock.getTime);

      await manager.announce({ kind: "approval", sessionId: "s-throttle", thread: "thread-a" });
      await manager.announce({ kind: "approval", sessionId: "s-throttle", thread: "thread-a" });
      assert.strictEqual(sink.recordedDispatches.length, 1, "immediate duplicate must be ignored");

      clock.advanceBy(15_000);
      await manager.announce({ kind: "approval", sessionId: "s-throttle", thread: "thread-a" });
      assert.strictEqual(sink.recordedDispatches.length, 1, "duplicate within 20s must remain suppressed");

      clock.advanceBy(6_000);
      await manager.announce({ kind: "approval", sessionId: "s-throttle", thread: "thread-a" });
      assert.strictEqual(sink.recordedDispatches.length, 2, "event after suppression window expires must dispatch");
    });

    it("allows immediate re-announcement after session is cleared with forget()", async () => {
      const sink = new MockNotificationSink();
      const clock = new MockTimeKeeper();
      const manager = new NotificationManager(sink, () => ({ enabled: true, focused: false }), clock.getTime);

      await manager.announce({ kind: "approval", sessionId: "s-forget", thread: "thread-b" });
      assert.strictEqual(sink.recordedDispatches.length, 1);

      manager.forget("s-forget");
      await manager.announce({ kind: "approval", sessionId: "s-forget", thread: "thread-b" });
      assert.strictEqual(sink.recordedDispatches.length, 2, "session clearance enables immediate re-dispatch");
    });

    it("tracks independent suppression keys for disparate sessions", async () => {
      const sink = new MockNotificationSink();
      const manager = new NotificationManager(sink, () => ({ enabled: true, focused: false }));

      await manager.announce({ kind: "approval", sessionId: "sess-x", thread: "branch-x" });
      await manager.announce({ kind: "approval", sessionId: "sess-y", thread: "branch-y" });

      assert.strictEqual(sink.recordedDispatches.length, 2);
    });
  });

  describe("click action handling and fault resilience", () => {
    it("attaches onClick callback when provided and handles absent callbacks", async () => {
      const sink = new MockNotificationSink();
      const manager = new NotificationManager(sink, () => ({ enabled: true, focused: false }));

      let clicked = false;
      const callback = () => { clicked = true; };

      await manager.announce({ kind: "task", taskId: "t-click", cause: "action", title: "Review" }, callback);
      assert.strictEqual(sink.recordedDispatches[0]?.onClick, callback);

      sink.recordedDispatches[0]?.onClick?.();
      assert.strictEqual(clicked, true);
    });

    it("silently swallows display exceptions from provider without throwing", async () => {
      const faultySink = new MockNotificationSink();
      faultySink.throwOnShow = true;
      const manager = new NotificationManager(faultySink, () => ({ enabled: true, focused: false }));

      await assert.doesNotReject(async () => {
        await manager.announce({ kind: "approval", sessionId: "s-err", thread: "thread-err" });
      });
    });
  });

  describe("task notification suppression under focus or disabled state", () => {
    it("suppresses task alerts for both focused window and disabled preferences", async () => {
      for (const settings of [{ enabled: true, focused: true }, { enabled: false, focused: false }]) {
        const sink = new MockNotificationSink();
        const manager = new NotificationManager(sink, () => settings);
        await manager.announce({ kind: "task", taskId: "t-suppress", cause: "approval", title: "Review" });
        assert.strictEqual(sink.recordedDispatches.length, 0);
      }
    });
  });
});
