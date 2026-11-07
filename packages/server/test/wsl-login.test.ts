import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WSL_HOME_RETRY_MS, WSL_HOME_TIMEOUT_MS, WSL_READ_TIMEOUT_MS, WslHomes, cleanLinuxPath, isDistroName, linuxAuthPath, localAuthPath, withinMs,
} from "../src/wslLogin.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the distro name a login path is built from", () => {
  it("takes letters, digits, dot, underscore and hyphen, and nothing else", () => {
    for (const name of ["Ubuntu", "Ubuntu-22.04", "Debian_12", "kali-linux", "a"]) assert.equal(isDistroName(name), true, name);
    for (const name of ["", " ", "Ubuntu 22", "Ubuntu;x", "a/b", "a\\b", "..", ".", "-d", "Ubuntu\n", "Ubuntu\0", "é", "x:y", "x$y"]) {
      assert.equal(isDistroName(name), false, JSON.stringify(name));
    }
  });
});

describe("a Linux path that is safe to map to a Windows one", () => {
  it("keeps an absolute POSIX path and nothing else", () => {
    assert.equal(cleanLinuxPath("/home/u"), "/home/u");
    assert.equal(cleanLinuxPath("/"), "/");
    assert.equal(cleanLinuxPath("/home/u/.config/muse"), "/home/u/.config/muse");
    assert.equal(cleanLinuxPath("/home/some..one/x"), "/home/some..one/x", "a dot run inside a name is not a segment");
    for (const bad of ["", "home/u", "./x", "/home/../root", "/..", "/a/../b", "/home/u\n", "/home/u\r", "/home/\0u", "/home\\u", "/a/b/.."]) {
      assert.equal(cleanLinuxPath(bad), null, JSON.stringify(bad));
    }
    assert.equal(cleanLinuxPath(undefined), null);
  });
});

describe("which auth file Muse uses in the distro", () => {
  const home = (answer: string | null) => { const calls = { n: 0 }; return { calls, fn: async () => { calls.n++; return answer; } }; };

  it("prefers an absolute MUSE_AUTH_PATH, then XDG_CONFIG_HOME, then the home folder", async () => {
    const h = home("/home/u");
    assert.equal(await linuxAuthPath({ MUSE_AUTH_PATH: "/srv/a.json", XDG_CONFIG_HOME: "/x" }, h.fn), "/srv/a.json");
    assert.equal(await linuxAuthPath({ XDG_CONFIG_HOME: "/x/cfg" }, h.fn), "/x/cfg/muse/auth.json");
    assert.equal(h.calls.n, 0, "the home folder is not asked for when an override answers");
    assert.equal(await linuxAuthPath({}, h.fn), "/home/u/.config/muse/auth.json");
    assert.equal(h.calls.n, 1);
  });

  it("skips an override that is not absolute, and refuses one that is absolute but unsafe", async () => {
    const h = home("/home/u");
    assert.equal(await linuxAuthPath({ MUSE_AUTH_PATH: "rel/a.json", XDG_CONFIG_HOME: "cfg" }, h.fn), "/home/u/.config/muse/auth.json");
    assert.equal(await linuxAuthPath({ MUSE_AUTH_PATH: "/a/../b.json" }, h.fn), null);
    assert.equal(await linuxAuthPath({ XDG_CONFIG_HOME: "/a/../b" }, h.fn), null);
    assert.equal(await linuxAuthPath({ MUSE_AUTH_PATH: "/a\nb.json" }, h.fn), null);
  });

  it("refuses an override that Windows would read as another file than Linux does", async () => {
    const h = home("/home/u");
    for (const odd of ["/srv/a.json ", "/srv/a.json ", "/srv/a.json\t", "/srv/a.json/", "/srv/a.json.",
      "/srv/a.json::$DATA", "/srv/a.json:$DATA", "/srv/a.json::$data", "/srv/a.json:stream"]) {
      assert.equal(await linuxAuthPath({ MUSE_AUTH_PATH: odd }, h.fn), null, JSON.stringify(odd));
    }
    assert.equal(await linuxAuthPath({ MUSE_AUTH_PATH: "/srv/a b.json" }, h.fn), "/srv/a b.json", "a space inside a name is the same file on both sides");
    assert.equal(h.calls.n, 0, "an override that is refused does not fall through to the home folder");
  });

  it("has no file when the home folder is unknown", async () => {
    assert.equal(await linuxAuthPath({}, home(null).fn), null);
  });
});

describe("the Windows path of a file inside a distro", () => {
  it("is the \\\\wsl.localhost path of that distro", () => {
    assert.equal(localAuthPath("Ubuntu", "/home/u/.config/muse/auth.json"), "\\\\wsl.localhost\\Ubuntu\\home\\u\\.config\\muse\\auth.json");
    assert.equal(localAuthPath("Ubuntu-22.04", "/srv/auth.json"), "\\\\wsl.localhost\\Ubuntu-22.04\\srv\\auth.json");
  });
});

describe("the bounds a stopped distro is held to", () => {
  it("are five seconds for the home folder, six for the read, thirty before asking again", () => {
    assert.deepEqual([WSL_HOME_TIMEOUT_MS, WSL_READ_TIMEOUT_MS, WSL_HOME_RETRY_MS], [5000, 6000, 30_000]);
  });
});

describe("a bounded wait", () => {
  it("gives the answer when it comes in time, and null when it does not", async () => {
    assert.equal(await withinMs(Promise.resolve(7), 1000), 7);
    assert.equal(await withinMs(new Promise<number>(() => {}), 30), null);
  });

  it("does not reject when the work fails after the wait gave up", async () => {
    let fail: (error: Error) => void = () => {};
    const work = new Promise<number>((_resolve, reject) => { fail = reject; });
    assert.equal(await withinMs(work, 20), null);
    fail(new Error("late"));
    await pause(20);
  });
});

describe("the home folder of the distro user", () => {
  function homes(answers: (n: number) => Promise<string | null>, options: { timeoutMs?: number; retryMs?: number } = {}) {
    const clock = { now: 1_000 };
    const probe = { runs: [] as string[] };
    const cache = new WslHomes({
      run: (distro) => { probe.runs.push(distro); return answers(probe.runs.length); },
      timeoutMs: options.timeoutMs ?? 1000, retryMs: options.retryMs ?? 30_000, now: () => clock.now,
    });
    return { cache, clock, probe };
  }

  it("keeps a good answer for the life of the cache, per distro", async () => {
    const { cache, probe, clock } = homes(async () => "/home/u");
    assert.equal(await cache.get("Ubuntu"), "/home/u");
    clock.now += 10 * 3_600_000;
    assert.equal(await cache.get("Ubuntu"), "/home/u");
    assert.deepEqual(probe.runs, ["Ubuntu"]);
    assert.equal(await cache.get("Debian"), "/home/u");
    assert.deepEqual(probe.runs, ["Ubuntu", "Debian"]);
  });

  it("answers callers that arrive together with one run", async () => {
    const { cache, probe } = homes(async () => { await pause(20); return "/home/u"; });
    const all = await Promise.all([cache.get("Ubuntu"), cache.get("Ubuntu"), cache.get("Ubuntu")]);
    assert.deepEqual(all, ["/home/u", "/home/u", "/home/u"]);
    assert.equal(probe.runs.length, 1);
  });

  it("remembers a failure for the retry window only", async () => {
    const { cache, probe, clock } = homes(async (n) => n === 1 ? null : "/home/u");
    assert.equal(await cache.get("Ubuntu"), null);
    clock.now += 29_000;
    assert.equal(await cache.get("Ubuntu"), null);
    assert.equal(probe.runs.length, 1, "no new run inside the window");
    clock.now += 2_000;
    assert.equal(await cache.get("Ubuntu"), "/home/u");
    assert.equal(probe.runs.length, 2);
  });

  it("looks again at once when asked to forget a failure, and keeps a good answer", async () => {
    const { cache, probe } = homes(async (n) => n === 1 ? null : "/home/u");
    assert.equal(await cache.get("Ubuntu"), null);
    cache.forgetFailure("Ubuntu");
    assert.equal(await cache.get("Ubuntu"), "/home/u");
    cache.forgetFailure("Ubuntu");
    assert.equal(await cache.get("Ubuntu"), "/home/u");
    assert.equal(probe.runs.length, 2, "a good answer is never asked for twice");
  });

  it("treats an unsafe answer, a failed run and a run that throws as failures", async () => {
    for (const answer of ["relative", "", "/home/../x", "/home/u\n", "/home/\0u"]) {
      assert.equal(await homes(async () => answer).cache.get("Ubuntu"), null, JSON.stringify(answer));
    }
    assert.equal(await homes(async () => { throw new Error("spawn failed"); }).cache.get("Ubuntu"), null);
  });

  it("gives up on a run that hangs, and does not hold the next caller to it", async () => {
    const { cache, probe } = homes(() => new Promise<string | null>(() => {}), { timeoutMs: 30 });
    assert.equal(await cache.get("Ubuntu"), null);
    assert.equal(await cache.get("Ubuntu"), null);
    assert.equal(probe.runs.length, 1, "the failure is remembered, so wsl.exe is not started again at once");
  });
});
