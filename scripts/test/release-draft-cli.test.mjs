// The gh-backed client, the command line and the post-publish poll of scripts/check-release-draft.mjs,
// with every outside call replaced by a fake. Nothing here reaches GitHub.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

import { ghClient, isTransient, parseArgs, pollLatest, runCommand } from "../lib/release-draft.mjs";
import { REPO, buildDraft, fakeClient, sha256, updaterConf } from "./helpers/fake-release.mjs";
import { generateKey, publicKeyText, signatureText } from "./helpers/minisign.mjs";

const NO_CLOCK = { now: () => Date.parse("2026-10-20T11:00:00Z"), sleep: async () => {} };

describe("the gh client", () => {
  function recorder(answers = []) {
    const calls = [];
    const exec = async (args) => {
      calls.push(args);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return Buffer.from(answer ?? "{}");
    };
    return { calls, exec };
  }
  const notFound = () => Object.assign(new Error("Command failed: gh api"), { stderr: Buffer.from("gh: Not Found (HTTP 404)\n") });

  test("reads a release by id with the REST path and never by tag", async () => {
    const { calls, exec } = recorder([JSON.stringify({ id: 5, draft: true })]);
    assert.deepEqual(await ghClient({ repo: REPO, exec }).getRelease(5), { id: 5, draft: true });
    assert.deepEqual(calls, [["api", `repos/${REPO}/releases/5`]]);
  });

  test("lists releases page by page until a short page", async () => {
    const page = (n, from) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: from + i })));
    const { calls, exec } = recorder([page(100, 0), page(100, 100), page(3, 200)]);
    const releases = await ghClient({ repo: REPO, exec }).listReleases();
    assert.equal(releases.length, 203);
    assert.deepEqual(calls.map((args) => args[1]), [`repos/${REPO}/releases?per_page=100&page=1`, `repos/${REPO}/releases?per_page=100&page=2`, `repos/${REPO}/releases?per_page=100&page=3`]);
  });

  test("a release by tag is null on a 404 and an error on anything else", async () => {
    const found = recorder([JSON.stringify({ id: 9, tag_name: "v1.0.0" })]);
    assert.equal((await ghClient({ repo: REPO, exec: found.exec }).getReleaseByTag("v1.0.0")).id, 9);
    assert.deepEqual(found.calls, [["api", `repos/${REPO}/releases/tags/v1.0.0`]]);
    assert.equal(await ghClient({ repo: REPO, exec: recorder([notFound()]).exec }).getReleaseByTag("v1.0.0"), null);
    const forbidden = Object.assign(new Error("Command failed"), { stderr: Buffer.from("gh: Resource not accessible by integration (HTTP 403)\n") });
    await assert.rejects(ghClient({ repo: REPO, exec: recorder([forbidden]).exec, sleep: async () => {} }).getReleaseByTag("v1.0.0"), /Command failed/);
    const broken = Object.assign(new Error("Command failed"), { stderr: Buffer.from("gh: Server Error (HTTP 500)\n") });
    await assert.rejects(ghClient({ repo: REPO, exec: recorder([broken, broken, broken]).exec, sleep: async () => {} }).getReleaseByTag("v1.0.0"), /Command failed/);
    const offline = new Error("getaddrinfo ENOTFOUND api.github.com");
    await assert.rejects(ghClient({ repo: REPO, exec: recorder([offline, offline, offline]).exec, sleep: async () => {} }).getReleaseByTag("v1.0.0"), /ENOTFOUND/);
  });

  describe("a read that fails for a moment is tried again", () => {
    const status = (code, text = "Server Error") => Object.assign(new Error("Command failed: gh api"), { stderr: Buffer.from(`gh: ${text} (HTTP ${code})\n`) });
    const waiting = () => {
      const waits = [];
      return { waits, sleep: async (ms) => waits.push(ms) };
    };

    test("a 502 then a good answer is just the good answer, after one wait", async () => {
      const { calls, exec } = recorder([status(502), JSON.stringify({ id: 5 })]);
      const { waits, sleep } = waiting();
      assert.deepEqual(await ghClient({ repo: REPO, exec, sleep }).getRelease(5), { id: 5 });
      assert.equal(calls.length, 2);
      assert.equal(waits.length, 1);
      assert.ok(waits[0] > 0);
    });

    test("a download that is cut off, a reset connection and a rate limit are tried again too", async () => {
      for (const failure of [Object.assign(new Error("read ECONNRESET"), {}), status(429, "API rate limit exceeded"), Object.assign(new Error("Command failed"), { stderr: Buffer.from('Get "https://x": unexpected EOF\n') }), status(503)]) {
        const { calls, exec } = recorder([failure, "the bytes"]);
        const { sleep } = waiting();
        assert.equal((await ghClient({ repo: REPO, exec, sleep }).downloadAsset(3)).toString(), "the bytes", String(failure.stderr ?? failure.message));
        assert.equal(calls.length, 2);
      }
    });

    test("three failures in a row are an error, with two waits that grow", async () => {
      const { calls, exec } = recorder([status(500), status(500), status(500), JSON.stringify({ id: 5 })]);
      const { waits, sleep } = waiting();
      await assert.rejects(ghClient({ repo: REPO, exec, sleep }).getRelease(5), /Command failed/);
      assert.equal(calls.length, 3);
      assert.equal(waits.length, 2);
      assert.ok(waits[1] > waits[0], waits.join(", "));
    });

    const plain = (message) => Object.assign(new Error("Command failed: gh api"), { stderr: Buffer.from(`${message}\n`) });
    const LONG_DOWNLOAD_FAILURES = [
      ["a bare EOF at the end of the line", plain('Get "https://api.github.com/repos/o/r/releases/assets/3": EOF')],
      ["an HTTP/2 stream error", plain('Get "https://release-assets.githubusercontent.com/x": stream error: stream ID 7; INTERNAL_ERROR; received from peer')],
      ["a GOAWAY", plain("http2: server sent GOAWAY and closed the connection; LastStreamID=9, ErrCode=NO_ERROR, debug=")],
      ["a secondary rate limit, which GitHub answers with 403", plain("gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)")],
      ["a primary rate limit answered with 403", plain("gh: API rate limit exceeded for user ID 1. (HTTP 403)")],
      ["gh's own wording for a DNS failure", plain("error connecting to api.github.com")],
      ["gh's pointer to the status page", plain("check your internet connection or https://githubstatus.com")],
    ];

    test("the failures a long download actually meets are tried again too", async () => {
      for (const [what, failure] of LONG_DOWNLOAD_FAILURES) {
        const { calls, exec } = recorder([failure, "the bytes"]);
        const { waits, sleep } = waiting();
        assert.equal((await ghClient({ repo: REPO, exec, sleep }).downloadAsset(3)).toString(), "the bytes", what);
        assert.equal(calls.length, 2, what);
        assert.equal(waits.length, 1, what);
        assert.equal(isTransient(failure), true, what);
      }
    });

    test("a bare EOF counts at the end of stderr whether or not the line ends, and in the error's own message", async () => {
      for (const failure of [Object.assign(new Error("Command failed: gh api"), { stderr: Buffer.from('Get "https://x/y": EOF') }), Object.assign(new Error('Get "https://x/y": EOF'), {}), Object.assign(new Error("Command failed"), { stderr: 'Get "https://x/y": EOF\r\n' })]) {
        assert.equal(isTransient(failure), true, String(failure.stderr ?? failure.message));
      }
      assert.equal(isTransient(Object.assign(new Error("Command failed"), { stderr: Buffer.from("EOF reached while parsing") })), false);
    });

    test("a refusal that is not a limit is still the answer: permission, a missing admin right, an EOF in the middle of a line", async () => {
      for (const failure of [plain("gh: Resource not accessible by integration (HTTP 403)"), plain("gh: Must have admin rights to Repository. (HTTP 403)"), plain("reached EOF while parsing the release"), plain("gh: Bad credentials (HTTP 401)")]) {
        const { calls, exec } = recorder([failure, "the bytes"]);
        await assert.rejects(ghClient({ repo: REPO, exec, sleep: async () => {} }).downloadAsset(3));
        assert.equal(calls.length, 1, String(failure.stderr));
        assert.equal(isTransient(failure), false, String(failure.stderr));
      }
    });

    test("a 404, a 403, a missing gh and a bad request are never tried again", async () => {
      const missing = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
      for (const failure of [status(404, "Not Found"), status(403, "Forbidden"), status(422, "Validation Failed"), missing]) {
        const { calls, exec } = recorder([failure, JSON.stringify({ id: 5 })]);
        const { waits, sleep } = waiting();
        await assert.rejects(ghClient({ repo: REPO, exec, sleep }).getRelease(5));
        assert.equal(calls.length, 1, String(failure.stderr ?? failure.message));
        assert.equal(waits.length, 0);
      }
    });

    test("listing releases tries only the page that failed again", async () => {
      const page = (n, from) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: from + i })));
      const { calls, exec } = recorder([page(100, 0), status(502), page(2, 100)]);
      const releases = await ghClient({ repo: REPO, exec, sleep: async () => {} }).listReleases();
      assert.equal(releases.length, 102);
      assert.deepEqual(calls.map((args) => args[1]), [`repos/${REPO}/releases?per_page=100&page=1`, `repos/${REPO}/releases?per_page=100&page=2`, `repos/${REPO}/releases?per_page=100&page=2`]);
    });

    test("a write is never repeated by the client: a delete, the PATCH and an upload each go out once", async () => {
      const { sleep } = waiting();
      for (const failure of [status(502), ...LONG_DOWNLOAD_FAILURES.map(([, error]) => error)]) {
        for (const write of [(client) => client.deleteAsset(8), (client) => client.deleteRelease(7), (client) => client.patchRelease(7, { draft: false }), (client) => client.uploadAsset(7, "a.AppImage", "/tmp/a")]) {
          const { calls, exec } = recorder([failure, "{}"]);
          await assert.rejects(write(ghClient({ repo: REPO, exec, sleep })), /Command failed/);
          assert.equal(calls.length, 1, String(failure.stderr));
        }
      }
    });
  });

  test("the newest published tag comes from the latest-release endpoint", async () => {
    const ok = recorder([JSON.stringify({ tag_name: "v0.20.3" })]);
    assert.equal(await ghClient({ repo: REPO, exec: ok.exec }).getLatestPublishedTag(), "v0.20.3");
    assert.deepEqual(ok.calls, [["api", `repos/${REPO}/releases/latest`]]);
    assert.equal(await ghClient({ repo: REPO, exec: recorder([notFound()]).exec }).getLatestPublishedTag(), null);
  });

  test("downloads an asset by id as octet-stream", async () => {
    const { calls, exec } = recorder(["bytes"]);
    assert.equal((await ghClient({ repo: REPO, exec }).downloadAsset(42)).toString(), "bytes");
    assert.deepEqual(calls, [["api", "-H", "Accept: application/octet-stream", `repos/${REPO}/releases/assets/42`]]);
  });

  test("deletes a release and an asset by id", async () => {
    const { calls, exec } = recorder();
    const client = ghClient({ repo: REPO, exec });
    await client.deleteRelease(7);
    await client.deleteAsset(8);
    assert.deepEqual(calls, [["api", "--method", "DELETE", `repos/${REPO}/releases/7`], ["api", "--method", "DELETE", `repos/${REPO}/releases/assets/8`]]);
  });

  test("uploads an asset to the uploads host, by release id, with the file as the body", async () => {
    const { calls, exec } = recorder();
    await ghClient({ repo: REPO, exec }).uploadAsset(7, "Ancilla 1.AppImage", "/tmp/x.AppImage");
    assert.deepEqual(calls, [
      ["api", "--method", "POST", "-H", "Content-Type: application/octet-stream", "--input", "/tmp/x.AppImage", `https://uploads.github.com/repos/${REPO}/releases/7/assets?name=Ancilla%201.AppImage`],
    ]);
  });

  test("sends draft=false as a typed field, nothing else", async () => {
    const { calls, exec } = recorder();
    await ghClient({ repo: REPO, exec }).patchRelease(7, { draft: false });
    assert.deepEqual(calls, [["api", "--method", "PATCH", `repos/${REPO}/releases/7`, "-F", "draft=false"]]);
  });

  test("hands back what GitHub answers to the PATCH, and nothing when the answer is not a release", async () => {
    const answered = recorder([JSON.stringify({ id: 7, draft: false, tag_name: "v1.0.0" })]);
    assert.deepEqual(await ghClient({ repo: REPO, exec: answered.exec }).patchRelease(7, { draft: false }), { id: 7, draft: false, tag_name: "v1.0.0" });
    for (const body of ["", "   ", "not json", "null", "7"]) {
      assert.equal(await ghClient({ repo: REPO, exec: recorder([body]).exec }).patchRelease(7, { draft: false }), undefined, JSON.stringify(body));
    }
  });

  test("refuses a repository that is not owner/name", () => {
    assert.throws(() => ghClient({ repo: "nonsense", exec: async () => Buffer.alloc(0) }), /owner\/name/);
    assert.throws(() => ghClient({ repo: "a/b/c", exec: async () => Buffer.alloc(0) }), /owner\/name/);
  });
});

describe("parsing the command line", () => {
  test("splits a command, its options and repeated options", () => {
    const parsed = parseArgs(["check", "--repo", "a/b", "--dry-run", "--expect-sha256", "x=1", "--expect-sha256", "y=2"], { flags: ["dry-run"], repeatable: ["expect-sha256"] });
    assert.deepEqual(parsed, { command: "check", options: { repo: "a/b", "dry-run": true, "expect-sha256": ["x=1", "y=2"] } });
  });

  test("an option without a value, an unknown option and a stray word are errors", () => {
    assert.throws(() => parseArgs(["check", "--repo"], { flags: [], repeatable: [] }), /--repo needs a value/);
    assert.throws(() => parseArgs(["check", "--what", "x"], { flags: [], repeatable: [], known: ["repo"] }), /unknown option --what/);
    assert.throws(() => parseArgs(["check", "stray"], { flags: [], repeatable: [] }), /unexpected argument stray/);
    assert.throws(() => parseArgs([], { flags: [], repeatable: [] }), /no command/);
  });
});

describe("the commands", () => {
  const dirs = [];
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "ancilla-release-cli-"));
    dirs.push(dir);
    return dir;
  };
  after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function harness({ draft = buildDraft(), files = {}, git } = {}) {
    const client = fakeClient({ releases: [draft.release], files: draft.files });
    const out = [];
    const err = [];
    const written = {};
    const deps = {
      makeClient: (repo) => {
        assert.equal(repo, REPO);
        return client;
      },
      git,
      readFile: (path) => {
        if (!(path in files)) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
        return files[path];
      },
      writeFile: (path, text) => {
        written[path] = text;
      },
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      env: { GITHUB_REPOSITORY: REPO },
      ...NO_CLOCK,
    };
    return { client, deps, out, err, written, draft };
  }
  const confs = (draft) => ({
    "conf.json": JSON.stringify(draft.conf),
    "trusted.json": JSON.stringify(draft.trustedConf),
  });
  // The digest the Linux job reports for the AppImage: a real release must be given it.
  const SHA_ARGS = Object.entries(buildDraft().expectedSha256).flatMap(([name, digest]) => ["--expect-sha256", `${name}=${digest}`]);
  const checkArgs = (command, extra = []) => [
    command,
    "--repo",
    REPO,
    "--release-id",
    "777",
    "--tag",
    "v0.20.4",
    "--conf",
    "conf.json",
    "--trusted-conf",
    "trusted.json",
    "--started-at",
    "2026-10-20T10:00:00Z",
    ...(extra.includes("--expect-sha256") ? [] : SHA_ARGS),
    ...extra,
  ];
  const patchCount = (h) => h.client.calls.filter((call) => call.op === "patchRelease").length;

  test("an unknown command or a missing option is a usage error, exit 2", async () => {
    const { deps, err } = harness();
    assert.equal(await runCommand(["frobnicate"], deps), 2);
    assert.equal(await runCommand(["check", "--repo", REPO], deps), 2);
    assert.equal(await runCommand([], deps), 2);
    assert.ok(err.length >= 3);
    assert.match(err.join("\n"), /Usage:/);
  });

  test("check passes a good draft and never sends a PATCH", async () => {
    const draft = buildDraft();
    const h = harness({ draft, files: confs(draft) });
    const code = await runCommand(checkArgs("check"), h.deps);
    assert.equal(code, 0, h.err.join("\n"));
    assert.match(h.out.join("\n"), /The draft passes every check/);
    assert.equal(h.client.calls.filter((call) => call.op === "patchRelease").length, 0);
  });

  test("check fails, with one annotation per problem, when something is wrong", async () => {
    const draft = buildDraft();
    draft.release.assets = draft.release.assets.filter((a) => a.name !== "Ancilla_0.20.4_universal.dmg");
    const h = harness({ draft, files: confs(draft) });
    assert.equal(await runCommand(checkArgs("check"), h.deps), 1);
    assert.match(h.err.join("\n"), /::error title=Release draft check::missing asset Ancilla_0\.20\.4_universal\.dmg/);
  });

  test("check takes the version and the product from the config, and the digest the build reported", async () => {
    const draft = buildDraft();
    const name = "Ancilla_0.20.4_amd64.AppImage";
    const bytes = draft.files.get(draft.release.assets.find((a) => a.name === name).id);
    const good = harness({ draft, files: confs(draft) });
    assert.equal(await runCommand(checkArgs("check", ["--expect-sha256", `${name}=${sha256(bytes)}`]), good.deps), 0, good.err.join("\n"));
    const bad = harness({ draft: buildDraft({ key: draft.key }), files: confs(draft) });
    assert.equal(await runCommand(checkArgs("check", ["--expect-sha256", `${name}=${"a".repeat(64)}`]), bad.deps), 1);
    assert.equal(await runCommand(checkArgs("check", ["--expect-sha256", "malformed"]), bad.deps), 2);
    const wrongVersion = harness({ draft: buildDraft({ key: draft.key }), files: { ...confs(draft), "conf.json": JSON.stringify({ ...draft.conf, version: "0.20.9" }) } });
    assert.equal(await runCommand(checkArgs("check"), wrongVersion.deps), 1);
    assert.match(wrongVersion.err.join("\n"), /tag v0\.20\.4 is not v0\.20\.9/);
  });

  test("a real release is checked with the AppImage's digest from the Linux job, and without it the check fails", async () => {
    const draft = buildDraft();
    const bare = checkArgs("check", ["--expect-sha256", `Ancilla_0.20.4_universal.dmg=${"a".repeat(64)}`]);
    const h = harness({ draft, files: confs(draft) });
    assert.equal(await runCommand(bare, h.deps), 1);
    assert.match(h.err.join("\n"), /no sha256 was given for Ancilla_0\.20\.4_amd64\.AppImage/);
    assert.match(h.err.join("\n"), /universal\.dmg.*matches no signed asset/);
    const without = harness({ draft, files: confs(draft) });
    const args = checkArgs("publish");
    args.splice(args.indexOf("--expect-sha256"), 2);
    assert.equal(await runCommand(args, without.deps), 1);
    assert.equal(patchCount(without), 0);
  });

  test("a dry run is checked as one: a dry-run tag, a prerelease", async () => {
    const draft = buildDraft({ dryRun: true });
    const h = harness({ draft, files: confs(draft) });
    const args = checkArgs("check", ["--dry-run"]);
    args[args.indexOf("v0.20.4")] = "dry-run-123456";
    assert.equal(await runCommand(args, h.deps), 0, h.err.join("\n"));
    const real = harness({ draft, files: confs(draft) });
    assert.equal(await runCommand(checkArgs("check"), real.deps), 1, "the same draft is refused as a real release");
  });

  test("check cannot run without the trusted key file", async () => {
    const draft = buildDraft();
    const h = harness({ draft, files: { "conf.json": confs(draft)["conf.json"] } });
    assert.equal(await runCommand(checkArgs("check"), h.deps), 1);
    assert.match(h.err.join("\n"), /trusted\.json/);
  });

  test("publish sends the PATCH only for a good draft", async () => {
    const draft = buildDraft();
    const h = harness({ draft, files: confs(draft) });
    assert.equal(await runCommand(checkArgs("publish"), h.deps), 0, h.err.join("\n"));
    assert.equal(h.client.releases[0].draft, false);
    assert.match(h.out.join("\n"), /Published v0\.20\.4/);

    const bad = buildDraft();
    bad.manifest.version = "0.20.9";
    const bytes = Buffer.from(JSON.stringify(bad.manifest));
    bad.files.set(bad.release.assets.find((a) => a.name === "latest.json").id, bytes);
    const h2 = harness({ draft: bad, files: confs(bad) });
    assert.equal(await runCommand(checkArgs("publish"), h2.deps), 1);
    assert.equal(h2.client.releases[0].draft, true);
    assert.equal(h2.client.calls.filter((call) => call.op === "patchRelease").length, 0);
  });

  test("publish refuses a dry run outright", async () => {
    const draft = buildDraft({ dryRun: true });
    const h = harness({ draft, files: confs(draft) });
    const args = checkArgs("publish", ["--dry-run"]);
    assert.equal(await runCommand(args, h.deps), 2);
    assert.match(h.err.join("\n"), /dry run is never published/);
    assert.equal(h.client.calls.filter((call) => call.op === "patchRelease").length, 0);
  });

  describe("the previous release's configuration", () => {
    const rotated = (draft, key = generateKey()) => ({ ...draft.conf, plugins: { updater: { ...draft.conf.plugins.updater, pubkey: publicKeyText(key) } } });
    const errors = (h) => h.err.join("\n");

    test("publish refuses a tree whose key, endpoints and identifier are not the previous release's, and names each", async () => {
      const draft = buildDraft();
      const conf = updaterConf({ version: "0.20.4", pubkey: publicKeyText(generateKey()), identifier: "app.ancilla.OTHER", endpoints: ["https://example.invalid/typo/latest.json"] });
      const h = harness({ draft, files: { ...confs(draft), "conf.json": JSON.stringify(conf) } });
      assert.equal(await runCommand(checkArgs("publish"), h.deps), 1);
      assert.match(errors(h), /::error title=Release draft check::plugins\.updater\.pubkey/);
      assert.match(errors(h), /::error title=Release draft check::plugins\.updater\.endpoints/);
      assert.match(errors(h), /::error title=Release draft check::identifier/);
      assert.equal(patchCount(h), 0);
      assert.equal(h.client.releases[0].draft, true);
    });

    test("publish refuses a version that is not higher than the previous release's, equal or lower", async () => {
      for (const previous of ["0.20.4", "0.21.0"]) {
        const draft = buildDraft();
        const h = harness({ draft, files: { ...confs(draft), "trusted.json": JSON.stringify({ ...draft.trustedConf, version: previous }) } });
        assert.equal(await runCommand(checkArgs("publish"), h.deps), 1, previous);
        assert.match(errors(h), new RegExp(`version 0\\.20\\.4 is not greater than the previous release's ${previous.replace(/\./g, "\\.")}`));
        assert.equal(patchCount(h), 0);
      }
    });

    test("a replaced key is refused by default and published with --allow-key-rotation, the old key still checking the signatures", async () => {
      const draft = buildDraft();
      const files = { ...confs(draft), "conf.json": JSON.stringify(rotated(draft)) };
      const refused = harness({ draft, files });
      assert.equal(await runCommand(checkArgs("publish"), refused.deps), 1);
      assert.match(errors(refused), /plugins\.updater\.pubkey/);
      assert.equal(patchCount(refused), 0);

      const allowed = harness({ draft: buildDraft({ key: draft.key }), files });
      assert.equal(await runCommand(checkArgs("publish", ["--allow-key-rotation"]), allowed.deps), 0, errors(allowed));
      assert.equal(allowed.client.releases[0].draft, false);
      assert.match(allowed.out.join("\n"), /::notice title=Key rotation::/);
    });

    test("--allow-key-rotation does not make an unusable new key, another endpoint or a lower version acceptable", async () => {
      const draft = buildDraft();
      const cases = [
        [{ ...draft.conf, plugins: { updater: { ...draft.conf.plugins.updater, pubkey: `${publicKeyText(generateKey())}\n` } } }, /plugins\.updater\.pubkey is unusable/],
        [{ ...rotated(draft), plugins: { updater: { ...rotated(draft).plugins.updater, endpoints: ["https://example.invalid/x.json"] } } }, /plugins\.updater\.endpoints/],
        [{ ...rotated(draft), version: "0.20.3" }, /not greater/],
      ];
      for (const [conf, pattern] of cases) {
        const h = harness({ draft: buildDraft({ key: draft.key }), files: { ...confs(draft), "conf.json": JSON.stringify(conf) } });
        assert.equal(await runCommand(checkArgs("publish", ["--allow-key-rotation"]), h.deps), 1, String(pattern));
        assert.match(errors(h), pattern);
        assert.equal(patchCount(h), 0);
      }
    });

    test("--allow-key-rotation is refused for a push: a tag pushed cannot opt in", async () => {
      const draft = buildDraft();
      const files = { ...confs(draft), "conf.json": JSON.stringify(rotated(draft)) };
      const push = harness({ draft, files });
      push.deps.env = { GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: "push" };
      assert.equal(await runCommand(checkArgs("publish", ["--allow-key-rotation"]), push.deps), 2);
      assert.match(errors(push), /--allow-key-rotation.*manual run.*not .*push/s);
      assert.deepEqual(push.client.calls, [], "refused before anything was read");

      for (const event of ["workflow_dispatch", undefined]) {
        const manual = harness({ draft: buildDraft({ key: draft.key }), files });
        manual.deps.env = { GITHUB_REPOSITORY: REPO, ...(event ? { GITHUB_EVENT_NAME: event } : {}) };
        assert.equal(await runCommand(checkArgs("publish", ["--allow-key-rotation"]), manual.deps), 0, `${event}: ${errors(manual)}`);
      }
      // The same refusal for every command that takes the option.
      const trustedConf = harness({ draft: buildDraft({ key: draft.key }), files, git: { show: async () => JSON.stringify(draft.trustedConf), fetchTag: async () => {} } });
      trustedConf.deps.env = { GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: "push" };
      assert.equal(await runCommand(["trusted-conf", "--repo", REPO, "--out", "t.json", "--conf", "conf.json", "--allow-key-rotation"], trustedConf.deps), 2);
    });

    test("check, which a rehearsal runs, takes --allow-key-rotation too; the other commands do not", async () => {
      const draft = buildDraft();
      const files = { ...confs(draft), "conf.json": JSON.stringify(rotated(draft)) };
      const h = harness({ draft, files });
      assert.equal(await runCommand(checkArgs("check", ["--allow-key-rotation"]), h.deps), 0, errors(h));
      assert.equal(await runCommand(["prepare", "--repo", REPO, "--tag", "v0.20.4", "--allow-key-rotation"], harness().deps), 2);
      assert.equal(await runCommand(["discard", "--repo", REPO, "--tag", "dry-run-1", "--allow-key-rotation"], harness().deps), 2);
    });

    describe("the early look, in the same command that fetches the trusted config", () => {
      const trustedGit = (draft) => ({ show: async () => JSON.stringify(draft.trustedConf), fetchTag: async () => {} });
      const early = (extra = []) => ["trusted-conf", "--repo", REPO, "--out", "out.json", "--conf", "conf.json", ...extra];
      const published = () => {
        const draft = buildDraft();
        draft.release.draft = false;
        return draft;
      };

      test("passes a tree that carries the previous release forward, and still writes the trusted config", async () => {
        const draft = published();
        const h = harness({ draft, files: confs(draft), git: trustedGit(draft) });
        assert.equal(await runCommand(early(), h.deps), 0, errors(h));
        assert.equal(JSON.parse(h.written["out.json"]).version, "0.20.3");
        assert.match(h.out.join("\n"), /same key, endpoints and identifier/);
      });

      test("fails within seconds, before any build, on a bad config, with each problem annotated", async () => {
        const draft = published();
        const conf = updaterConf({ version: "0.20.3", pubkey: publicKeyText(generateKey()), identifier: "app.ancilla.OTHER" });
        const h = harness({ draft, files: { ...confs(draft), "conf.json": JSON.stringify(conf) }, git: trustedGit(draft) });
        assert.equal(await runCommand(early(), h.deps), 1);
        assert.match(errors(h), /::error title=Release draft check::plugins\.updater\.pubkey/);
        assert.match(errors(h), /::error title=Release draft check::identifier/);
        assert.match(errors(h), /::error title=Release draft check::version 0\.20\.3 is not greater/);
      });

      test("lets a replaced key through only with --allow-key-rotation", async () => {
        const draft = published();
        const files = { ...confs(draft), "conf.json": JSON.stringify(rotated(draft)) };
        const refused = harness({ draft, files, git: trustedGit(draft) });
        assert.equal(await runCommand(early(), refused.deps), 1);
        const allowed = harness({ draft, files, git: trustedGit(draft) });
        assert.equal(await runCommand(early(["--allow-key-rotation"]), allowed.deps), 0, errors(allowed));
      });

      test("--allow-key-rotation without --conf has nothing to apply to and is a usage error", async () => {
        const draft = published();
        const h = harness({ draft, git: trustedGit(draft) });
        assert.equal(await runCommand(["trusted-conf", "--repo", REPO, "--out", "out.json", "--allow-key-rotation"], h.deps), 2);
        assert.deepEqual(h.written, {});
      });

      test("an unreadable --conf is an error, not a pass", async () => {
        const draft = published();
        const h = harness({ draft, files: {}, git: trustedGit(draft) });
        assert.equal(await runCommand(early(), h.deps), 1);
        assert.match(errors(h), /conf\.json/);
      });
    });
  });

  test("prepare refuses a published tag and clears drafts otherwise", async () => {
    const draft = buildDraft();
    const h = harness({ draft });
    assert.equal(await runCommand(["prepare", "--repo", REPO, "--tag", "v0.20.4"], h.deps), 0);
    assert.equal(h.client.releases.length, 0);
    assert.match(h.out.join("\n"), /Deleted 1 stale draft/);

    const published = buildDraft();
    published.release.draft = false;
    const h2 = harness({ draft: published });
    assert.equal(await runCommand(["prepare", "--repo", REPO, "--tag", "v0.20.4"], h2.deps), 1);
    assert.match(h2.err.join("\n"), /::error title=Release tag::.*already has a published release/);
    assert.equal(h2.client.releases.length, 1);
  });

  test("discard deletes the dry-run draft and nothing else", async () => {
    const draft = buildDraft({ dryRun: true });
    const h = harness({ draft });
    assert.equal(await runCommand(["discard", "--repo", REPO, "--tag", "dry-run-123456"], h.deps), 0);
    assert.equal(h.client.releases.length, 0);
    assert.equal(await runCommand(["discard", "--repo", REPO, "--tag", "v0.20.4"], harness().deps), 2, "only dry-run tags can be discarded");
  });

  test("discard takes a tag that is exactly dry-run-<digits>, and a real draft is out of its reach whatever it is called", async () => {
    for (const tag of ["v0.20.4", "dry-run-12x", "dry-run-", "dry-run-12-1", "dry-run-1_2", "dry-run-12 ", " dry-run-12", "xdry-run-12", "Dry-run-12", "dry-run-12\n", "dry-run-v0.20.4", "dry-run"]) {
      const h = harness({ draft: buildDraft({ tag }) });
      assert.equal(await runCommand(["discard", "--repo", REPO, "--tag", tag], h.deps), 2, JSON.stringify(tag));
      assert.equal(h.client.calls.length, 0, `${JSON.stringify(tag)}: not even a read`);
      assert.equal(h.client.releases.length, 1, `${JSON.stringify(tag)}: the draft is still there`);
      assert.match(h.err.join("\n"), /only dry-run drafts can be discarded/);
    }
    for (const tag of ["dry-run-1", "dry-run-123456", "dry-run-36533903301"]) {
      const h = harness({ draft: buildDraft({ dryRun: true, tag }) });
      assert.equal(await runCommand(["discard", "--repo", REPO, "--tag", tag], h.deps), 0, tag);
      assert.equal(h.client.releases.length, 0, tag);
    }
  });

  test("discard through the command leaves a published release with a dry-run tag, and every draft of another tag, alone", async () => {
    const published = buildDraft({ dryRun: true });
    published.release.draft = false;
    const h = harness({ draft: published });
    assert.equal(await runCommand(["discard", "--repo", REPO, "--tag", "dry-run-123456"], h.deps), 1);
    assert.equal(h.client.calls.filter((call) => call.op === "deleteRelease").length, 0);
    const real = buildDraft();
    const dry = buildDraft({ dryRun: true, tag: "dry-run-9" });
    dry.release.id = 778;
    const mixed = harness({ draft: real });
    mixed.client.releases.push(dry.release);
    assert.equal(await runCommand(["discard", "--repo", REPO, "--tag", "dry-run-9"], mixed.deps), 0);
    assert.deepEqual(mixed.client.releases.map((release) => release.tag_name), ["v0.20.4"]);
  });

  test("trusted-conf writes the config of the newest published tag", async () => {
    const draft = buildDraft();
    draft.release.draft = false;
    const git = { show: async () => JSON.stringify({ plugins: { updater: { pubkey: "KEY" } } }), fetchTag: async () => {} };
    const h = harness({ draft, git });
    assert.equal(await runCommand(["trusted-conf", "--repo", REPO, "--out", "out.json"], h.deps), 0, h.err.join("\n"));
    assert.equal(JSON.parse(h.written["out.json"]).plugins.updater.pubkey, "KEY");
    assert.match(h.out.join("\n"), /v0\.20\.4/);
    const unreadable = harness({ draft, git: { show: async () => Promise.reject(new Error("no")), fetchTag: async () => Promise.reject(new Error("no")) } });
    assert.equal(await runCommand(["trusted-conf", "--repo", REPO, "--out", "out.json"], unreadable.deps), 1);
    assert.deepEqual(unreadable.written, {});
  });

  test("replace-appimage swaps the files and reports the digest", async () => {
    const draft = buildDraft();
    const name = "Ancilla_0.20.4_amd64.AppImage";
    for (const platform of Object.values(draft.manifest.platforms)) {
      platform.url = platform.url.replace("/download/v0.20.4/", "/download/untagged-0a1b2c3d4e5f/");
    }
    draft.files.set(draft.release.assets.find((a) => a.name === "latest.json").id, Buffer.from(JSON.stringify(draft.manifest)));
    const dir = tmp();
    const bytes = Buffer.from("repacked");
    writeFileSync(join(dir, name), bytes);
    writeFileSync(join(dir, `${name}.sig`), signatureText(draft.key, bytes, { trustedComment: `timestamp:3\tfile:${name}` }));
    const h = harness({ draft });
    const code = await runCommand(["replace-appimage", "--repo", REPO, "--release-id", "777", "--tag", "v0.20.4", "--appimage", join(dir, name)], h.deps);
    assert.equal(code, 0, h.err.join("\n"));
    assert.match(h.out.join("\n"), new RegExp(`sha256=${sha256(bytes)}`));
  });

  test("replace-appimage tries a refused upload again, waiting with the command's own clock, and says so", async () => {
    const draft = buildDraft();
    const name = "Ancilla_0.20.4_amd64.AppImage";
    for (const platform of Object.values(draft.manifest.platforms)) {
      platform.url = platform.url.replace("/download/v0.20.4/", "/download/untagged-0a1b2c3d4e5f/");
    }
    draft.files.set(draft.release.assets.find((a) => a.name === "latest.json").id, Buffer.from(JSON.stringify(draft.manifest)));
    const dir = tmp();
    const bytes = Buffer.from("repacked");
    writeFileSync(join(dir, name), bytes);
    writeFileSync(join(dir, `${name}.sig`), signatureText(draft.key, bytes, { trustedComment: `timestamp:3\tfile:${name}` }));
    const h = harness({ draft });
    const upload = h.client.uploadAsset;
    let refused = false;
    h.client.uploadAsset = async (...args) => {
      if (!refused) {
        refused = true;
        throw new Error("Error saving asset");
      }
      return upload(...args);
    };
    const waits = [];
    h.deps.sleep = async (ms) => waits.push(ms);
    const code = await runCommand(["replace-appimage", "--repo", REPO, "--release-id", "777", "--tag", "v0.20.4", "--appimage", join(dir, name)], h.deps);
    assert.equal(code, 0, h.err.join("\n"));
    assert.equal(waits.length, 1);
    assert.match(h.out.join("\n"), /Upload of Ancilla_0\.20\.4_amd64\.AppImage failed \(try 1 of 3\): Error saving asset/);
  });
});

describe("the post-publish poll", () => {
  const body = (version) => ({ ok: true, status: 200, json: async () => ({ version }) });

  test("is satisfied as soon as the public latest.json names the new version", async () => {
    const urls = [];
    const logs = [];
    const result = await pollLatest({ repo: REPO, tag: "v0.20.4", fetchImpl: async (url) => (urls.push(url), body("0.20.4")), log: (l) => logs.push(l), ...NO_CLOCK });
    assert.equal(result.ok, true);
    assert.deepEqual(urls, [`https://github.com/${REPO}/releases/latest/download/latest.json`]);
    assert.doesNotMatch(logs.join("\n"), /::warning/);
  });

  test("waits and tries again while the old version is still served", async () => {
    const answers = [body("0.20.3"), body("0.20.3"), body("0.20.4")];
    const sleeps = [];
    const result = await pollLatest({ repo: REPO, tag: "v0.20.4", fetchImpl: async () => answers.shift(), log: () => {}, attempts: 5, delayMs: 7000, now: NO_CLOCK.now, sleep: async (ms) => sleeps.push(ms) });
    assert.equal(result.ok, true);
    assert.deepEqual(sleeps, [7000, 7000]);
  });

  test("only ever warns: a wrong version, an HTTP error, a network error and bad JSON all end in a warning", async () => {
    const failures = [
      async () => body("0.20.3"),
      async () => ({ ok: false, status: 404, json: async () => ({}) }),
      async () => Promise.reject(new Error("network down")),
      async () => ({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError("Unexpected token")) }),
    ];
    for (const fetchImpl of failures) {
      const logs = [];
      const result = await pollLatest({ repo: REPO, tag: "v0.20.4", fetchImpl, log: (l) => logs.push(l), attempts: 2, delayMs: 1, ...NO_CLOCK });
      assert.equal(result.ok, false);
      assert.match(logs.join("\n"), /::warning title=Published release not visible yet::/);
    }
  });

  test("the command exits 0 even when the poll finds nothing", async () => {
    const out = [];
    const code = await runCommand(["poll", "--repo", REPO, "--tag", "v0.20.4", "--attempts", "1"], {
      log: (l) => out.push(l),
      error: () => {},
      env: {},
      fetchImpl: async () => body("0.20.3"),
      ...NO_CLOCK,
    });
    assert.equal(code, 0);
    assert.match(out.join("\n"), /::warning/);
  });
});

describe("check-release-draft.mjs as a process", () => {
  const script = fileURLToPath(new URL("../check-release-draft.mjs", import.meta.url));

  test("a usage mistake exits 2 and prints the commands", () => {
    const done = spawnSync(process.execPath, [script, "frobnicate"], { encoding: "utf8" });
    assert.equal(done.status, 2);
    assert.match(done.stderr, /Usage: node scripts\/check-release-draft\.mjs/);
  });

  test("fails closed, never quietly, when gh cannot be run", () => {
    // No path to find gh on, and no token or gh configuration to find, in whichever case the system spells them.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(path|gh_.*|github_token)$/i.test(name)));
    env.PATH = "";
    const done = spawnSync(process.execPath, [script, "prepare", "--repo", REPO, "--tag", "v0.0.1"], { encoding: "utf8", env });
    assert.equal(done.status, 1);
    assert.match(done.stderr, /::error title=Release tag::/);
  });
});
