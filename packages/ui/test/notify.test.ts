import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NotificationManager, type NotifyPermission, type Notifier } from "../src/model/notify.js";

interface Shown {
  title: string;
  body: string;
  tag: string;
  onClick?: () => void;
}

function notifier(permission: NotifyPermission = "granted") {
  const shown: Shown[] = [];
  let asked = 0;
  const fake: Notifier = {
    permission: async () => permission,
    request: async () => {
      asked += 1;
      return permission;
    },
    show: async (note) => {
      shown.push(note);
    },
  };
  return { fake, shown, asked: () => asked };
}

/** A clock the test moves by hand, so the repeat window can be crossed without waiting for it. */
function clock(start = 1_000) {
  let at = start;
  return { now: () => at, pass: (ms: number) => (at += ms) };
}

describe("notifications", () => {
  it("says nothing to someone already looking at the window", async () => {
    const { fake, shown } = notifier();
    const manager = new NotificationManager(fake, () => ({ enabled: true, focused: true }));

    await manager.announce({ kind: "approval", sessionId: "s1", thread: "notes-app" });

    assert.deepEqual(shown, []);
  });

  it("says nothing when the switch is off", async () => {
    const { fake, shown } = notifier();
    const manager = new NotificationManager(fake, () => ({ enabled: false, focused: false }));

    await manager.announce({ kind: "approval", sessionId: "s1", thread: "notes-app" });

    assert.deepEqual(shown, []);
  });

  it("never raises one without permission, and never asks on its own", async () => {
    const asking = notifier("default");
    const manager = new NotificationManager(asking.fake, () => ({ enabled: true, focused: false }));

    await manager.announce({ kind: "approval", sessionId: "s1", thread: "notes-app" });

    assert.deepEqual(asking.shown, []);
    // Asking belongs to a button the user pressed; a browser refuses it anywhere else anyway.
    assert.equal(asking.asked(), 0);
  });

  it("tells the user what happened, per kind", async () => {
    const { fake, shown } = notifier();
    const manager = new NotificationManager(fake, () => ({ enabled: true, focused: false }));

    await manager.announce({ kind: "approval", sessionId: "s1", thread: "notes-app" });
    await manager.announce({ kind: "finished", sessionId: "s2", thread: "winmux", failed: false });
    await manager.announce({ kind: "finished", sessionId: "s3", thread: "winmux", failed: true });

    assert.match(shown[0]?.title ?? "", /waiting on you/);
    assert.match(shown[0]?.body ?? "", /notes-app/);
    assert.match(shown[1]?.title ?? "", /finished/);
    assert.match(shown[2]?.title ?? "", /failed/);
  });

  it("says the same thing about one thread once, until enough time has passed", async () => {
    const { fake, shown } = notifier();
    const time = clock();
    const manager = new NotificationManager(fake, () => ({ enabled: true, focused: false }), time.now);

    await manager.announce({ kind: "approval", sessionId: "s1", thread: "notes-app" });
    await manager.announce({ kind: "approval", sessionId: "s1", thread: "notes-app" });
    assert.equal(shown.length, 1, "a thread flapping should not buzz twice");

    // A different thread has its own say.
    await manager.announce({ kind: "approval", sessionId: "s2", thread: "winmux" });
    assert.equal(shown.length, 2);

    time.pass(20_001);
    await manager.announce({ kind: "approval", sessionId: "s1", thread: "notes-app" });
    assert.equal(shown.length, 3, "and it may speak again later");
  });

  it("lets a thread speak again once its request has been dealt with", async () => {
    const { fake, shown } = notifier();
    const time = clock();
    const manager = new NotificationManager(fake, () => ({ enabled: true, focused: false }), time.now);

    await manager.announce({ kind: "approval", sessionId: "s1", thread: "notes-app" });
    manager.forget("s1");
    await manager.announce({ kind: "approval", sessionId: "s1", thread: "notes-app" });

    assert.equal(shown.length, 2);
  });

  it("tells the user a task is waiting on them: its name and why, and nothing else", async () => {
    const { fake, shown } = notifier();
    const manager = new NotificationManager(fake, () => ({ enabled: true, focused: false }));

    await manager.announce({ kind: "task", taskId: "t1", cause: "approval", title: "Fix the login redirect" });
    await manager.announce({ kind: "task", taskId: "t2", cause: "site", title: "Look at A" });
    await manager.announce({ kind: "task", taskId: "t3", cause: "action", title: "Order it" });
    await manager.announce({ kind: "task", taskId: "t4", cause: "download", title: "Get the PDF" });
    await manager.announce({ kind: "task", taskId: "t5", cause: "question", title: "Check prices" });
    await manager.announce({ kind: "task", taskId: "t6", cause: "blocked", title: "Rename the key" });
    await manager.announce({ kind: "task", taskId: "t7", cause: "change", title: "Comment on issue 12" });

    assert.deepEqual(
      shown.map((note) => [note.tag, note.title, note.body]),
      [
        ["task:t1", "The assistant needs your approval", '"Fix the login redirect" is waiting for you to approve it.'],
        ["task:t2", "The assistant is waiting on you", '"Look at A" asks before opening a site.'],
        ["task:t3", "The assistant is waiting on you", '"Order it" asks before it does something on a page.'],
        ["task:t4", "The assistant is waiting on you", '"Get the PDF" asks where to save a file.'],
        ["task:t5", "The assistant is waiting on you", '"Check prices" has a question for you.'],
        ["task:t6", "A task needs you", '"Rename the key" stopped and is waiting for you.'],
        ["task:t7", "The assistant is waiting on you", '"Comment on issue 12" asks before it changes something in an account.'],
      ],
    );
  });

  it("keeps a task's name to one short line, whatever it holds", async () => {
    const { fake, shown } = notifier();
    const manager = new NotificationManager(fake, () => ({ enabled: true, focused: false }));

    await manager.announce({ kind: "task", taskId: "t1", cause: "site", title: `Look\n  at\tA\u0007 ${"very long ".repeat(20)}` });
    await manager.announce({ kind: "task", taskId: "t2", cause: "site", title: "   \n " });

    const first = shown[0]?.body ?? "";
    assert.doesNotMatch(first, /[\n\t\u0007]/);
    assert.match(first, /^"Look at A very long/);
    assert.ok(first.includes('..." asks before opening a site.'), "cut with an ellipsis");
    assert.ok(first.length < 100, "short enough to read on a lock screen");
    assert.equal(shown[1]?.body, "A task asks before opening a site.", "a task with no name is only a task");
  });

  it("says a task once, lets it speak again when it was dealt with, and hands over what a press should do", async () => {
    const { fake, shown } = notifier();
    const manager = new NotificationManager(fake, () => ({ enabled: true, focused: false }));
    const press = () => undefined;

    await manager.announce({ kind: "task", taskId: "t1", cause: "site", title: "Look at A" }, press);
    await manager.announce({ kind: "task", taskId: "t1", cause: "action", title: "Look at A" }, press);
    assert.equal(shown.length, 1, "a task asking twice in a moment buzzes once");
    assert.equal(shown[0]?.onClick, press);

    manager.forget("t1");
    await manager.announce({ kind: "task", taskId: "t1", cause: "action", title: "Look at A" });
    assert.equal(shown.length, 2);
    assert.equal("onClick" in (shown[1] ?? {}), false, "no press to hear, none is offered");

    // A task and a thread that happen to share a name never share a say.
    await manager.announce({ kind: "approval", sessionId: "t1", thread: "notes-app" });
    assert.equal(shown.length, 3);
  });

  it("says nothing about a waiting task to someone who is looking, or who switched notifications off", async () => {
    for (const settings of [{ enabled: true, focused: true }, { enabled: false, focused: false }]) {
      const { fake, shown } = notifier();
      const manager = new NotificationManager(fake, () => settings);
      await manager.announce({ kind: "task", taskId: "t1", cause: "approval", title: "Fix it" });
      assert.deepEqual(shown, []);
    }
  });
});
