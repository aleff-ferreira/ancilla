// What the release workflow must keep being, checked on its parsed structure because nothing here can run it on
// GitHub: drafts only until a keyless publish job says otherwise, a rehearsal that cannot publish, pinned runners
// and timeouts. A change that breaks one of these should fail here, in review, and not on a tag.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { parseYaml } from "./helpers/mini-yaml.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const workflow = (name) => parseYaml(read(`.github/workflows/${name}`));
const release = workflow("release.yml");
const text = read(".github/workflows/release.yml");
const jobs = release.jobs;
const BUILDS = ["desktop-windows", "desktop-macos", "desktop-linux"];
const steps = (job) => jobs[job].steps;
const stepNamed = (job, pattern) => {
  const found = steps(job).filter((step) => pattern.test(step.name ?? ""));
  assert.equal(found.length, 1, `${job}: expected one step matching ${pattern}, found ${found.length}`);
  return found[0];
};
const indexOfStep = (job, pattern) => steps(job).findIndex((step) => pattern.test(step.name ?? ""));
const json = (value) => JSON.stringify(value);
const KEY = "TAURI_SIGNING_PRIVATE_KEY";

describe("the workflow files", () => {
  test("every workflow parses and every job in it has a timeout", () => {
    const dir = join(root, ".github", "workflows");
    const files = readdirSync(dir).filter((name) => name.endsWith(".yml"));
    assert.ok(files.length >= 5);
    for (const file of files) {
      const parsed = workflow(file);
      assert.ok(parsed.name, `${file} has a name`);
      assert.ok(parsed.jobs && Object.keys(parsed.jobs).length > 0, `${file} has jobs`);
      for (const [name, job] of Object.entries(parsed.jobs)) {
        assert.ok(Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 120, `${file}: job ${name} needs a timeout-minutes of at most 120`);
      }
    }
  });

  test("no workflow runs on a floating runner image that this project pins", () => {
    for (const file of ["release.yml", "check-signing-key.yml", "preview.yml", "linux-appimage.yml"]) {
      for (const [name, job] of Object.entries(workflow(file).jobs)) {
        assert.doesNotMatch(String(job["runs-on"]), /-latest/, `${file}: ${name}`);
      }
    }
    const ci = workflow("ci.yml");
    for (const job of Object.values(ci.jobs)) {
      assert.ok(job.strategy.matrix.os.every((os) => !/-latest/.test(os)), "every leg of CI's matrix is pinned");
    }
  });

  test("the mini reader agrees with what it was written for", () => {
    const parsed = parseYaml('on:\n  push:\n    tags: ["v*"]\njobs:\n  a:\n    steps:\n      - run: |\n          echo one\n          echo two\n      - uses: x@v1 # note\n        with:\n          n: 3\n');
    assert.deepEqual(parsed, { on: { push: { tags: ["v*"] } }, jobs: { a: { steps: [{ run: "echo one\necho two\n" }, { uses: "x@v1", with: { n: 3 } }] } } });
    assert.throws(() => parseYaml("a:\n\tb: 1\n"), /tabs/);
    assert.throws(() => parseYaml("a: 1\na: 2\n"), /duplicate key a/);
    assert.throws(() => parseYaml("a: [1, 2\n"), /unterminated/);
  });
});

describe("release.yml: triggers and names", () => {
  test("runs on a pushed v* tag and by hand, and by hand it can be a dry run", () => {
    assert.deepEqual(release.on.push.tags, ["v*"]);
    const input = release.on.workflow_dispatch.inputs.dry_run;
    assert.equal(input.type, "boolean");
    assert.equal(input.default, false);
    assert.ok(input.description.length > 20);
  });

  test("runs on nothing else: a pull request, a schedule or a comment could not be told apart from a release", () => {
    assert.deepEqual(Object.keys(release.on), ["push", "workflow_dispatch"]);
    assert.deepEqual(Object.keys(release.on.push), ["tags"]);
    assert.deepEqual(Object.keys(release.on.workflow_dispatch), ["inputs"]);
    assert.deepEqual(Object.keys(release.on.workflow_dispatch.inputs), ["dry_run", "rotate_key"]);
  });

  test("replacing the signing key is an input of a manual run, off by default, that a push cannot set", () => {
    const input = release.on.workflow_dispatch.inputs.rotate_key;
    assert.equal(input.type, "boolean");
    assert.equal(input.default, false);
    assert.match(input.description, /public key|pubkey/i);
    assert.match(input.description, /old key|previous release/i);
    assert.ok(input.description.length <= 120 && !/\n/.test(input.description), `one short sentence, the detail being in docs/RELEASING.md: ${input.description.length} characters`);
    assert.deepEqual(Object.keys(release.on.push), ["tags"], "a push carries no inputs");
  });

  test("asks for no more than read by default, so that a job that forgets its permissions cannot write", () => {
    const top = release.permissions;
    if (top === undefined) return;
    const levels = typeof top === "string" ? [top] : Object.values(top);
    assert.ok(levels.length > 0);
    for (const level of levels) assert.match(String(level), /^(read|read-all|none)$/, `top-level permissions ${json(top)}`);
  });

  test("no step puts a workflow expression in its script: a value reaches a script through the environment", () => {
    for (const [name, job] of Object.entries(jobs)) {
      for (const step of job.steps) {
        if (step.run !== undefined) assert.doesNotMatch(step.run, /\$\{\{/, `${name}: ${step.name ?? step.run.split("\n")[0]}`);
      }
    }
  });

  test("a rehearsal's tag is dry-run-<run id> and its draft a prerelease; a real run's tag is the pushed one", () => {
    assert.equal(release.env.RELEASE_TAG, "${{ inputs.dry_run && format('dry-run-{0}', github.run_id) || github.ref_name }}");
    assert.equal(release.env.RELEASE_PRERELEASE, "${{ inputs.dry_run && 'true' || 'false' }}");
  });

  test("its jobs are the three builds, the publish job and the rehearsal's closing job", () => {
    assert.deepEqual(Object.keys(jobs), [...BUILDS, "publish", "dry-run"]);
  });

  test("the release body still names this version and is not edited here", () => {
    assert.match(release.env.RELEASE_BODY, /\*\*New in \d+\.\d+\.\d+\*\*/);
  });
});

describe("release.yml: nothing is public until the publish job says so", () => {
  const tauriSteps = BUILDS.map((job) => [job, steps(job).filter((step) => /^tauri-apps\/tauri-action@/.test(step.uses ?? ""))]);

  test("never asks tauri-action for a published release", () => {
    assert.doesNotMatch(text, /releaseDraft:\s*false/);
    for (const [job, found] of tauriSteps) {
      assert.equal(found.length, 1, `${job} runs tauri-action once`);
      assert.equal(found[0].with.releaseDraft, true, job);
    }
  });

  test("tauri-action stays pinned to a commit, and keeps its tag, prerelease flag and retries", () => {
    for (const [job, [step]] of tauriSteps) {
      assert.match(step.uses, /^tauri-apps\/tauri-action@[0-9a-f]{40}(?:\s|$)/, job);
      assert.equal(step.with.tagName, "${{ env.RELEASE_TAG }}", job);
      assert.equal(step.with.prerelease, "${{ env.RELEASE_PRERELEASE }}", job);
      assert.equal(step.with.retryAttempts, 3, job);
      assert.equal(step.id, "tauri", job);
    }
  });

  test("the builds create no release by any other route", () => {
    for (const job of BUILDS) {
      const body = json(jobs[job]);
      assert.doesNotMatch(body, /gh release (create|upload|download|edit)/, job);
      assert.doesNotMatch(body, /draft=false|"draft":\s*false/, job);
    }
  });

  test("the PATCH that publishes is in the script, called once, in the publish job only", () => {
    assert.doesNotMatch(text, /draft=false/);
    const calls = [...text.matchAll(/check-release-draft\.mjs publish\b/g)];
    assert.equal(calls.length, 1);
    assert.match(json(jobs.publish), /check-release-draft\.mjs publish\b/);
  });

  test("the publish job runs for a tag and never for a rehearsal", () => {
    assert.equal(jobs.publish.if, "github.ref_type == 'tag' && !inputs.dry_run");
    assert.deepEqual(jobs.publish.needs, BUILDS);
  });

  test("the publish job holds no signing key and no secret but the workflow's own token", () => {
    const body = json(jobs.publish);
    assert.doesNotMatch(body, new RegExp(KEY));
    assert.doesNotMatch(body, /secrets\./);
    assert.deepEqual(jobs.publish.permissions, { contents: "write" });
  });

  test("the publish job has its own concurrency group, an environment to approve in, and a timeout", () => {
    assert.deepEqual(jobs.publish.concurrency, { group: "release-publish", "cancel-in-progress": false });
    assert.equal(jobs.publish.environment, "release");
  });

  test("the publish job finds the trusted key, then checks and publishes, then only looks at the result", () => {
    const trusted = indexOfStep("publish", /trusted/i);
    const publish = indexOfStep("publish", /check the draft and publish/i);
    const poll = indexOfStep("publish", /public latest\.json/i);
    assert.ok(trusted >= 0 && trusted < publish && publish < poll, `${trusted} < ${publish} < ${poll}`);
    assert.equal(steps("publish")[poll]["continue-on-error"], true);
    const run = steps("publish")[publish].run;
    assert.match(run, /--trusted-conf/);
    assert.match(run, /--started-at/);
    assert.match(run, /--expect-sha256/);
    assert.match(steps("publish")[publish].env.RELEASE_ID, /needs\.desktop-windows\.outputs\.release_id/);
  });

  test("a rehearsal ends in its own job: the checks, never a publish, and the draft deleted even after a failure", () => {
    const job = jobs["dry-run"];
    assert.equal(job.if, "${{ always() && inputs.dry_run }}");
    assert.deepEqual(job.needs, BUILDS);
    const body = json(job);
    assert.doesNotMatch(body, new RegExp(KEY));
    assert.doesNotMatch(body, /secrets\./);
    assert.doesNotMatch(body, /check-release-draft\.mjs publish\b/);
    const check = stepNamed("dry-run", /publish checks/i);
    assert.match(check.run, /check-release-draft\.mjs check\b/);
    assert.match(check.run, /--dry-run/);
    assert.equal(check.if, "needs.desktop-linux.result == 'success'");
    const discard = stepNamed("dry-run", /delete the rehearsal/i);
    assert.equal(discard.if, "always()");
    assert.match(discard.run, /check-release-draft\.mjs discard\b/);
    assert.ok(steps("dry-run").indexOf(discard) === steps("dry-run").length - 1, "the cleanup is the last step");
  });

  test("no job other than the three builds can reach the signing key", () => {
    for (const job of ["publish", "dry-run"]) assert.doesNotMatch(json(jobs[job]), new RegExp(KEY));
    for (const job of BUILDS) assert.match(json(jobs[job]), new RegExp(KEY));
  });

  test("jobs ask for no more than contents: write", () => {
    for (const [name, job] of Object.entries(jobs)) {
      assert.deepEqual(job.permissions, { contents: "write" }, name);
    }
  });
});

describe("release.yml: the builds", () => {
  test("every build checks that the signing key is set before anything else", () => {
    for (const job of BUILDS) {
      assert.match(steps(job)[0].name, /Check the updater signing key/, job);
      assert.match(steps(job)[0].run, /TAURI_SIGNING_PRIVATE_KEY is not set/, job);
    }
  });

  test("runners are pinned to the images they resolved to on the day of the last release", () => {
    assert.equal(jobs["desktop-windows"]["runs-on"], "windows-2025-vs2026");
    assert.equal(jobs["desktop-macos"]["runs-on"], "macos-26");
    assert.equal(jobs["desktop-linux"]["runs-on"], "ubuntu-22.04");
    assert.equal(jobs.publish["runs-on"], "ubuntu-24.04");
    assert.equal(jobs["dry-run"]["runs-on"], "ubuntu-24.04");
    for (const [name, label] of [["check-signing-key.yml", "ubuntu-24.04"], ["preview.yml", "windows-2025-vs2026"]]) {
      assert.equal(Object.values(workflow(name).jobs)[0]["runs-on"], label, name);
    }
  });

  test("the builds run one after another, so latest.json is never written by two at once", () => {
    assert.equal(jobs["desktop-windows"].needs, undefined);
    assert.equal(jobs["desktop-macos"].needs, "desktop-windows");
    assert.deepEqual(jobs["desktop-linux"].needs, ["desktop-windows", "desktop-macos"]);
  });

  test("the Windows job refuses a published tag and deletes stale drafts before it builds, and checks the tag", () => {
    const prepare = indexOfStep("desktop-windows", /published tag/i);
    const build = steps("desktop-windows").findIndex((step) => /tauri-action/.test(step.uses ?? ""));
    const install = steps("desktop-windows").findIndex((step) => step.run === "npm ci");
    assert.ok(prepare > 0 && prepare < install && install < build, `${prepare} < ${install} < ${build}`);
    assert.match(steps("desktop-windows")[prepare].run, /check-release-draft\.mjs prepare\b/);
    const tag = stepNamed("desktop-windows", /tag matches the version/i);
    assert.match(tag.run, /bump-version\.mjs --check "\$GITHUB_REF_NAME"/);
    assert.match(tag.run, /bump-version\.mjs --check\s*$/m);
    assert.match(tag.run, /Not a tag/);
    assert.equal(stepNamed("desktop-windows", /signing key opens/i).env[KEY], `\${{ secrets.${KEY} }}`);
  });

  test("the Windows job finds the key installed copies trust within seconds, before any build, not after an hour of them", () => {
    const prepare = indexOfStep("desktop-windows", /published tag/i);
    const preflight = indexOfStep("desktop-windows", /trusted updater key/i);
    const install = steps("desktop-windows").findIndex((step) => step.run === "npm ci");
    assert.ok(preflight > prepare && preflight < install, `${prepare} < ${preflight} < ${install}`);
    const step = steps("desktop-windows")[preflight];
    assert.match(step.run, /check-release-draft\.mjs trusted-conf --repo "\$GITHUB_REPOSITORY" --out "\$RUNNER_TEMP\/trusted-tauri\.conf\.json"/);
    // The same comparison with the previous release that publish makes (key, endpoints, identifier, version), here at once.
    assert.match(step.run, /--conf apps\/desktop\/src-tauri\/tauri\.conf\.json/);
    assert.equal(step.env.GH_TOKEN, "${{ github.token }}");
    assert.equal(step.shell, "bash");
    assert.doesNotMatch(json(step), new RegExp(KEY), "it needs no signing key");
    // The Linux job still reads it again for its own check: the key can only have moved if a release was published meanwhile.
    assert.match(stepNamed("desktop-linux", /^Verify/).run, /check-release-draft\.mjs trusted-conf\b/);
  });

  test("the Windows job reports the release id and when it started; the others check they found the same draft", () => {
    assert.equal(jobs["desktop-windows"].outputs.release_id, "${{ steps.tauri.outputs.releaseId }}");
    assert.match(jobs["desktop-windows"].outputs.started_at, /steps\.started\.outputs\.at/);
    assert.ok(indexOfStep("desktop-windows", /when this run started/i) <= 2, "recorded before any slow step");
    for (const job of ["desktop-macos", "desktop-linux"]) {
      const same = stepNamed(job, /same draft/i);
      assert.match(json(same.env), /needs\.desktop-windows\.outputs\.release_id/);
      assert.match(json(same.env), /steps\.tauri\.outputs\.releaseId/);
      assert.equal(same.env.RELEASE_ID, "${{ steps.tauri.outputs.releaseId }}");
      assert.equal(same.env.EXPECTED_ID, "${{ needs.desktop-windows.outputs.release_id }}");
      assert.ok(steps(job).indexOf(same) > steps(job).findIndex((step) => step.id === "tauri"));
      // The environment says what the two ids are; the script must be what compares them and stops the job.
      assert.match(same.run, /\[ -z "\$RELEASE_ID" \] \|\| \[ "\$RELEASE_ID" != "\$EXPECTED_ID" \]/, `${job}: compares the two ids, and refuses an empty one`);
      assert.match(same.run, /\bexit 1\b/, `${job}: and fails the job`);
      assert.equal((same.run.match(/\bexit \d+\b/g) ?? []).length, 1, `${job}: with no other way out`);
    }
  });
});

describe("release.yml: the Linux job", () => {
  const linux = () => steps("desktop-linux");

  test("repacks the AppImage the bundler just built, not a published one", () => {
    const body = json(jobs["desktop-linux"]);
    assert.doesNotMatch(body, /gh release download/);
    assert.match(stepNamed("desktop-linux", /Wayland/i).run, /bundle\/appimage\/\*\.AppImage/);
    assert.match(stepNamed("desktop-linux", /Wayland/i).run, /repack-appimage\.sh/);
  });

  test("starts the repacked AppImage and the installed .deb before signing anything", () => {
    const sign = indexOfStep("desktop-linux", /^Sign/);
    const appimage = linux().findIndex((step) => /smoke-linux\.sh/.test(step.run ?? "") && /--appimage-extract-and-run/.test(step.run));
    const deb = linux().findIndex((step) => /smoke-linux\.sh \/usr\/bin\/ancilla/.test(step.run ?? ""));
    assert.ok(deb > 0 && appimage > deb && sign > appimage, `${deb} < ${appimage} < ${sign}`);
    assert.match(linux()[deb].run, /apt-get install -y/);
    assert.match(linux()[appimage].run, /steps\.repack|APPIMAGE/);
  });

  test("signs, verifies against the newest published release's key, then replaces by release id, in that order", () => {
    const sign = indexOfStep("desktop-linux", /^Sign/);
    const verify = indexOfStep("desktop-linux", /^Verify/);
    const replace = indexOfStep("desktop-linux", /^Replace/);
    assert.ok(sign > 0 && sign < verify && verify < replace, `${sign} < ${verify} < ${replace}`);
    const verifyRun = linux()[verify].run;
    assert.match(verifyRun, /check-release-draft\.mjs trusted-conf\b/);
    assert.match(verifyRun, /verify-updater-signature\.mjs --conf "\$RUNNER_TEMP\/trusted-tauri\.conf\.json"/);
    assert.doesNotMatch(verifyRun, /--pubkey|apps\/desktop\/src-tauri\/tauri\.conf\.json/, "never against the key in the tree being built");
    assert.match(linux()[replace].run, /check-release-draft\.mjs replace-appimage\b/);
    assert.match(linux()[replace].run, /--release-id "\$RELEASE_ID"|--release-id/);
  });

  test("only the signing step holds the key besides the build and the first check, and it keeps the empty-password rule", () => {
    const holders = linux().filter((step) => json(step).includes(KEY)).map((step) => step.name ?? step.uses);
    assert.deepEqual(holders.length, 3, holders.join(" | "));
    const sign = stepNamed("desktop-linux", /^Sign/);
    assert.match(sign.run, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD="\$\{TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-\}"/);
    assert.match(sign.run, /tauri" signer sign/);
    for (const name of [/^Verify/, /^Replace/]) assert.doesNotMatch(json(stepNamed("desktop-linux", name)), new RegExp(KEY));
  });

  test("reports the digest of the AppImage it signed, for the publish job to compare", () => {
    assert.match(stepNamed("desktop-linux", /^Sign/).run, /sha256=\$\(sha256sum/);
    assert.equal(jobs["desktop-linux"].outputs.appimage_sha256, "${{ steps.sign.outputs.sha256 }}");
    assert.equal(stepNamed("desktop-linux", /^Sign/).id, "sign");
  });

  test("keeps checking all three Linux installer formats and installs the packaging tools", () => {
    assert.match(json(jobs["desktop-linux"]), /verify-linux-bundles\.sh apps\/desktop\/src-tauri\/target\/x86_64-unknown-linux-gnu\/release\/bundle/);
    assert.match(json(jobs["desktop-linux"]), /libarchive-tools/);
  });
});

describe("release.yml: the actions it runs", () => {
  const uses = Object.entries(jobs).flatMap(([job, { steps: list }]) => list.filter((step) => step.uses !== undefined).map((step) => ({ job, step })));
  // The comment after a pin names the tag it was taken from, so that Dependabot or a person can move it on purpose.
  const usesLines = text.split("\n").map((line) => line.trimEnd()).filter((line) => /^\s*(?:- )?uses: /.test(line));

  test("every action is pinned to a full commit, with the tag it came from in a comment", () => {
    assert.ok(uses.length >= 12, `found ${uses.length} uses`);
    for (const { job, step } of uses) {
      assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${job}: ${step.uses}`);
    }
    // Each line on its own: five checkouts read alike, and one without its comment must not hide behind the others.
    assert.equal(usesLines.length, uses.length);
    for (const line of usesLines) assert.match(line, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+(?:\.\d+){0,2}$/, line);
  });

  test("the first-party and third-party actions that run beside the signing key are the ones pinned", () => {
    const names = new Set(uses.map(({ step }) => step.uses.split("@")[0]));
    assert.deepEqual([...names].sort(), ["actions/checkout", "actions/setup-node", "dtolnay/rust-toolchain", "tauri-apps/tauri-action"]);
  });

  test("the Rust toolchain is asked for by name, since a pinned action no longer takes it from its branch", () => {
    const toolchains = uses.filter(({ step }) => step.uses.startsWith("dtolnay/rust-toolchain@"));
    assert.deepEqual(toolchains.map(({ job }) => job), ["desktop-windows", "desktop-macos", "desktop-linux"]);
    for (const { job, step } of toolchains) assert.equal(step.with?.toolchain, "stable", job);
    assert.equal(toolchains.find(({ job }) => job === "desktop-macos").step.with.targets, "x86_64-apple-darwin");
  });

  test("a checkout leaves no credential in .git/config for the steps that follow: nothing here pushes", () => {
    const checkouts = uses.filter(({ step }) => step.uses.startsWith("actions/checkout@"));
    assert.equal(checkouts.length, 5, "the three builds, publish and the rehearsal's closing job");
    for (const { job, step } of checkouts) assert.equal(step.with?.["persist-credentials"], false, job);
    for (const [job, { steps: list }] of Object.entries(jobs)) {
      for (const step of list) assert.doesNotMatch(step.run ?? "", /git push|git commit|git tag/, job);
    }
  });

  test("the trusted config is read by git show and fetched, as a public tag, with no stored credential", () => {
    const source = read("scripts/lib/release-draft.mjs");
    assert.match(source, /"fetch", "--no-tags", "--depth=1", "origin"/);
    assert.doesNotMatch(source, /extraheader|x-access-token|GITHUB_TOKEN/);
  });
});

describe("release.yml: replacing the signing key", () => {
  const callers = [
    ["desktop-windows", /trusted updater key to verify against/i],
    ["publish", /check the draft and publish/i],
    ["dry-run", /publish checks/i],
  ];

  test("the three steps that compare the release with the previous one get the opt-in from the input, through the environment", () => {
    for (const [job, name] of callers) {
      const step = stepNamed(job, name);
      assert.equal(step.env.ROTATE_KEY, "${{ inputs.rotate_key }}", job);
      assert.match(step.run, /--allow-key-rotation/, job);
      assert.match(step.run, /\[ "\$ROTATE_KEY" = "true" \]/, `${job}: only the word true turns it on`);
      // ... and it is the end of the command that does the comparison, so that the flag reaches it.
      assert.match(step.run, /check-release-draft\.mjs [\s\S]*"\$\{rotate\[@\]\}"\s*$/, `${job}: the command takes the flag`);
      assert.equal((step.run.match(/\$\{rotate\[@\]\}/g) ?? []).length, 1, `${job}: once`);
    }
  });

  test("nothing else is told about it, and it is never a default", () => {
    const where = Object.entries(jobs).flatMap(([job, { steps: list }]) => list.filter((step) => /rotate_key|allow-key-rotation|ROTATE_KEY/.test(json(step))).map((step) => `${job}: ${step.name}`));
    assert.equal(where.length, 3, where.join("\n"));
    assert.doesNotMatch(json(release.env), /rotate/i);
    assert.doesNotMatch(text, /--allow-key-rotation["']?\s*$/m, "never passed unconditionally");
    for (const [job, name] of callers) assert.match(stepNamed(job, name).run, /if \[ "\$ROTATE_KEY" = "true" \]; then[\s\S]*--allow-key-rotation[\s\S]*fi/, job);
  });

  test("the Linux job still verifies against the previous release's key, whatever the input says", () => {
    const verify = stepNamed("desktop-linux", /^Verify/);
    assert.doesNotMatch(json(verify), /rotate|allow-key-rotation/i);
    assert.match(verify.run, /--conf "\$RUNNER_TEMP\/trusted-tauri\.conf\.json"/);
  });
});

describe("docs/RELEASING.md agrees with the code on what the owner has to do", () => {
  const doc = read("docs/RELEASING.md");
  const at = (pattern) => {
    const match = pattern.exec(doc);
    assert.ok(match, `the doc has ${pattern}`);
    return match.index;
  };

  test("the one-time setup starts with the release environment, then a required tag ruleset, then the key, all before the first tag", () => {
    const environment = at(/^### 1\. The `release` environment/m);
    const ruleset = at(/^### 2\. A tag ruleset for `v\*` \(required\)/m);
    const key = at(/^### 3\. The updater signing key/m);
    assert.ok(at(/^## One-time setup/m) < environment && environment < ruleset && ruleset < key);
    assert.match(doc, /all before the first tag is pushed/);
    assert.match(doc, /runs on its own/, "says what happens without the environment");
    assert.match(doc, /\*\*Leave "Prevent self-review" off\.\*\*/);
    assert.doesNotMatch(doc, /Optionally, a tag ruleset/);
    assert.match(doc, /move the key out of the repository secrets into a secret of an environment/, "and the alternative to the ruleset");
  });

  test("the changelog step says to rename Unreleased, and why", () => {
    assert.match(doc, /rename that heading to `## 0\.20\.4`/);
    assert.match(doc, /drops every other `##` section, `Unreleased` included, \*\*without saying so\*\*/);
  });

  test("a publish that failed at or after the PATCH says to look at the Releases page first", () => {
    assert.match(doc, /failed at or after the PATCH[\s\S]{0,400}look at the Releases page before re-running/);
  });

  test("names the retried failures and the ones that are never retried", () => {
    for (const word of ["HTTP 429", "5xx", "secondary rate limit", "GOAWAY", "stream error", "bare `EOF`", "`error connecting to", "never"]) assert.ok(doc.includes(word), word);
    assert.match(doc, /A write is never retried by the script/);
  });

  test("describes the continuity rules, the opt-in and which key the signatures are checked against", () => {
    for (const word of ["same `plugins.updater.endpoints`", "same `identifier`", "higher `version`", "`rotate_key`", "--allow-key-rotation"]) assert.ok(doc.includes(word), word);
    const rotation = doc.slice(at(/^## Replacing the signing key/m));
    assert.match(rotation, /signatures are checked against the previous release's key, the old one/);
    assert.match(rotation, /The new key only has to be a key/);
    assert.match(rotation, /That push fails on purpose/);
    assert.match(rotation, /a pushed tag can never opt in/);
    assert.match(rotation, /-f rotate_key=true/);
  });

  test("tells a rehearsal to use the bumped version, since the version going up is checked", () => {
    assert.match(doc, /rehearse a tree whose version is already the next one/);
  });

  test("says a branch or pull request title should not carry the names", () => {
    assert.match(doc, /A branch name and a pull request title should not carry these names/);
  });
});

describe("the repack script", () => {
  const script = read("apps/desktop/scripts/repack-appimage.sh");

  test("pins the appimagetool it runs by checksum, strips every libwayland, and fails if one is left", () => {
    assert.match(script, /^set -euo pipefail$/m);
    assert.match(script, /ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0/);
    assert.match(script, /sha256sum --check/);
    // Every entry named like the libraries goes, the packages' doc directories included (a directory is pruned and
    // removed whole); a type filter here once let usr/share/doc/libwayland-server0 through to the strict check below.
    assert.match(script, /find squashfs-root -name 'libwayland-\*' -prune -print -exec rm -rf \{\} \+/);
    assert.doesNotMatch(script, /-type f -o -type l/);
    assert.match(script, /--appimage-extract/);
    assert.match(script, /exit 1/);
  });

  test("is valid shell", { skip: process.platform === "win32" && "bash on a Windows machine may be WSL's launcher, not a shell" }, () => {
    const done = spawnSync("bash", ["-n", join(root, "apps/desktop/scripts/repack-appimage.sh")], { encoding: "utf8" });
    assert.equal(done.status, 0, done.stderr);
  });
});

describe("CI and the root test command run the script tests on every operating system", () => {
  const pkg = JSON.parse(read("package.json"));

  test("npm test runs the workspaces and then scripts/test with node's own glob", () => {
    assert.equal(pkg.scripts["test:scripts"], 'node --test "scripts/test/*.test.mjs"');
    assert.equal(pkg.scripts.test, "npm run test --workspaces --if-present && npm run test:scripts");
  });

  test("ci.yml runs them in the node job, which is a matrix over all three systems", () => {
    const ci = workflow("ci.yml");
    assert.deepEqual(ci.jobs.node.strategy.matrix.os.length, 3);
    const found = ci.jobs.node.steps.filter((step) => /npm run test:scripts/.test(step.run ?? ""));
    assert.equal(found.length, 1);
    assert.equal(found[0].if, undefined, "on every system, not only Linux");
    assert.equal(found[0].shell, "bash");
  });
});
