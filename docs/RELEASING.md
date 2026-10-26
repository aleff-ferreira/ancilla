# Releasing Ancilla

A release is a `vX.Y.Z` tag on `main`. Pushing the tag runs the [Release workflow](../.github/workflows/release.yml), which builds the desktop app for Windows, macOS and Linux into a **private draft** release. Nothing is public until a last job has checked the whole draft and published it. The release is then "Ancilla vX.Y.Z", with `latest.json` for Windows, macOS and AppImage updates. Linux packages are updated by installing the next package.

> **Status.** This draft-first pipeline was written and reviewed without being run on GitHub: its pure parts (signature verification, the draft checks, the version and attribution rules, the workflow's structure) are tested in `scripts/test`, but the workflow itself, the uploads through `gh api` and the approval step are not. Rehearse it (below) before relying on it for a real release, and read the log of that first run.

## One-time setup

Three things, in this order, **all before the first tag is pushed**. The order matters: the first is what stops a release from being published without anyone being asked.

### 1. The `release` environment (first)

The publish job runs in the repository's `release` environment, so that publishing waits for a click. GitHub creates an environment with that name the first time a job names it, **with no protection at all**: if `release` does not exist when the first tag is pushed, the publish job finds nobody to ask and runs on its own, and a release is public minutes after the push. A rehearsal never touches the environment, so it will not show this. Create it first, under Settings, Environments, New environment, `release`, and add:

- **Required reviewers**: the maintainer. **Leave "Prevent self-review" off.** With one maintainer it would make the approval impossible and no release could ever be published.

To see that it took, `gh api repos/aleff-ferreira/ancilla/environments/release --jq .protection_rules` must list a `required_reviewers` rule.

The workflow asks for `contents: write` and nothing else, and uploads with its own token.

### 2. A tag ruleset for `v*` (required)

The signing key is a repository secret, so **any tag that matches `v*` runs the three build jobs with the key**, and anyone who can push to the repository can push a tag. Create a tag ruleset (Settings, Rules, Rulesets, New tag ruleset) that targets `v*`, is active, and restricts creation, update and deletion of those tags to the maintainer.

A ruleset does not cover a manual run: anyone who can write to the repository can also start the workflow by hand from a branch, and the workflow that runs is the one on that branch, with the key (see [Rehearsing](#rehearsing)). That is why write access to this repository is trust in the signing key. The alternative that closes it is to move the key out of the repository secrets into a secret of an environment whose deployment policy allows only `v*` tags, and name that environment in the three build jobs. The workflow does not do that today: the build jobs would wait on the environment, and a rehearsal from a branch would no longer get the key.

### 3. The updater signing key

Installed copies only accept an update signed with the key whose public half is in `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The private half is `~/.tauri/ancilla-updater.key` on the maintainer's machine, and the release jobs need it as a repository secret:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo aleff-ferreira/ancilla < ~/.tauri/ancilla-updater.key
```

To see that the secret is set, opens, and is the key installed copies trust, without cutting a release, run `gh workflow run check-signing-key.yml --repo aleff-ferreira/ancilla` and read the run's annotations.

The key has no password, so there is no `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret to add. The workflow passes an empty password when that secret is absent, which is what opens a key made without one. The secret is only needed if the key is ever replaced with one that has a password.

Every build job checks for `TAURI_SIGNING_PRIVATE_KEY` before anything else and stops within seconds, saying so, if it is missing. Once its dependencies are installed, the Windows job also signs a scratch file with the key, so a key that is damaged or needs a password it was not given fails there, before the build, and it adds a warning to the run if the key is not the one whose public half is in `tauri.conf.json`.

> **Back the key up**, somewhere other than this machine: a password manager, an encrypted drive. If it is lost, no later release can be signed with it, and every installed copy of Ancilla stops updating for good; the only way forward is for each user to download and install a new build by hand. If it leaks, replace it (below) as soon as you can.

The key reaches only the three build jobs. The publish job and the rehearsal's closing job have no secret at all but the workflow's own token.

## Cutting a release

1. Start from an up-to-date `main` whose CI is green.
2. Set the new version everywhere it is written down:

   ```sh
   npm run version:bump -- 0.20.4
   ```

   This writes the root and workspace `package.json` files, `package-lock.json`, `tauri.conf.json`, `Cargo.toml`, the crate's entry in `Cargo.lock`, `ANCILLA_VERSION` in the server, and the `**New in X**` headings of the release body (in `.github/workflows/release.yml`, which is also the update notes the app shows) and of the README banner. If any of them cannot be found it stops without changing a file. **It renames the headings only,** and leaves a marker line (`[notes for 0.20.4 not written yet: ...]`) under each one it renamed. Rewrite the notes under them so they describe this release, then delete the marker lines: `version:check` fails while a marker is there, because a program cannot tell whether the words under a heading are new, and a heading with the new version over the last release's bullets would otherwise pass.
3. Write the release's entry in `docs/CHANGELOG.md`. Changes accumulate under `## Unreleased` at the top; **rename that heading to `## 0.20.4`** (and start a new `## Unreleased` above it when the next change needs one). Renaming matters: `sync-changelog` keeps only `## <version>` entries and drops every other `##` section, `Unreleased` included, **without saying so**, so notes left under that heading would never reach the app. Check that the entry is in the style of the entries below it: `### New`, `### Fixed` and `### Changed` sections, each item a bold one-sentence summary followed by what changed in plain words, with a link to the issue or pull request and credit to whoever reported or built it. Then copy it into the app, which shows it after updating itself:

   ```sh
   node scripts/sync-changelog.mjs
   ```

4. Check it:

   ```sh
   npm run version:check
   npm run build --workspace @ancilla/daemon --workspace @ancilla/ui --workspace @ancilla/server
   npm run build --workspace @ancilla/web
   npm test
   ```

   `version:check` is what CI runs on every push: it fails if any version differs, if the release body or the README banner names another version or still carries the bump's marker line, or if the changelog has no entry for it. `npm test` includes the tests of the release scripts and of `release.yml`'s structure.
5. Commit ("Release 0.20.4"), push it to `main` or merge its pull request, and wait for CI and Linux installer smoke tests. The Linux job inspects all three package formats, installs the Debian package and launches it from `/usr/bin/ancilla`, then launches the AppImage without FUSE. Both launches must answer `/api/health`; a port file alone does not count. Every commit message is checked, by the `commit-msg` hook here and by CI on the history ([Commit messages](#commit-messages)), and GitHub takes the subject of a merge or squash commit from the pull request title.
6. **Rehearse**, for any release that changes the workflows, the bundling, the signing or the desktop shell, and for the first release after this pipeline changed (see [Rehearsing](#rehearsing)).
7. Tag that commit and push the tag (a release that **replaces the signing key** is the one exception: see [Replacing the signing key](#replacing-the-signing-key)):

   ```sh
   git tag v0.20.4
   git push origin v0.20.4
   ```

8. Wait for the three builds. A **draft** release "Ancilla v0.20.4" appears on the Releases page, visible only to people who can write to the repository. Review it there (see [Reviewing the draft](#reviewing-the-draft)), then approve the `publish` job in the run's page. It checks everything again and publishes.
9. Afterwards, update an older installed copy with Check for updates, in Settings or the command palette.

## Rehearsing

```sh
gh workflow run release.yml --repo aleff-ferreira/ancilla --ref <branch> -f dry_run=true
```

(`--repo` matters: from some checkouts `gh` resolves the repository to upstream Helicon.) A rehearsal runs the whole pipeline from a branch or tag, with the real signing key, and publishes nothing:

- The three builds run as for a release, into a draft tagged `dry-run-<run id>`. The draft is created as a **prerelease**, so even a mistake that published it could never become the latest release the updater reads.
- The `dry-run` job then runs the checks the publish job runs: the configuration against the previous release's, every asset, `latest.json`, every signature against its installer's bytes and the trusted key, the AppImage's digest. It never publishes.
- Because those include the **version going up**, rehearse a tree whose version is already the next one (after `version:bump`), not the last release's: a rehearsal of the version that is already published fails its early check within seconds, which is the check working.
- That job ends by deleting the draft, whether the builds passed, failed or were cancelled. If it cannot (a deleted run, a revoked token), delete a leftover `dry-run-*` draft by hand.

Because it runs with the signing key, **read the branch's workflow text before dispatching**: the workflow that runs is the one on the branch.

A rehearsal proves that the builds, the repack, the signing, the verification against the previous release's key, the replacement by release id and the draft checks work on the real runners. It does not exercise the last step, the publish itself (the one PATCH that makes a draft public), the approval, the look at the public `latest.json`, or the refusal of a tag that already has a release. The publish step is small on purpose and tested against a fake client; to see it work once for real, release a throwaway version in a fork: a fork needs its own throwaway key (`npx tauri signer generate`), that key's public half in the fork's `tauri.conf.json`, and one release already published there by hand whose `tauri.conf.json` has that same key, because the Linux job and the publish job fail closed when there is no previous release to take the trusted key from. This has not been tried.

## What the workflow does

Three build jobs run one after another: Windows, then macOS, then Linux. Each merges its platform into the draft's `latest.json`, and running them side by side could drop a platform from auto-update. Expect the whole run to take a while; the universal macOS build alone is 15 to 25 minutes.

**Windows**, first: checks the key, notes when the run started, checks the tag against the version in the files (a rehearsal on a branch only checks the files against each other), then **refuses a tag that already has a published release and deletes any draft an earlier attempt left for it**, since tauri-action finds a release by tag, published or not, and would write into it. It also reads the trusted updater key (below) at once, and compares `tauri.conf.json` with the previous release's (the same comparison the publish job makes, listed there), so that a repository with no published release to take it from, or a configuration that would strand installed copies, fails in seconds and not after the builds. Then it builds, signs and uploads to a new draft.

**macOS** and **Linux** add their platforms to the same draft, and each stops if it found a different draft from the Windows job's.

| Platform | To install | For the updater |
| --- | --- | --- |
| Windows x64 | `Ancilla_X.Y.Z_x64-setup.exe` | the same installer, plus its `.sig` |
| macOS, Apple Silicon and Intel | `Ancilla_X.Y.Z_universal.dmg` | an `.app.tar.gz`, plus its `.sig` |
| Linux x86_64, Debian/Ubuntu | `Ancilla_X.Y.Z_amd64.deb` | install the next package manually |
| Linux x86_64, Fedora/RPM | `Ancilla-X.Y.Z-1.x86_64.rpm` | install the next package manually |
| Linux x86_64, portable | `Ancilla_X.Y.Z_amd64.AppImage` | the same AppImage, plus its `.sig` |

and `latest.json`, which lists each platform's update package, its signature and the release notes.

**Linux** then, with everything still private:

1. checks all three package formats, installs the `.deb` and starts it from `/usr/bin/ancilla`;
2. repacks the AppImage **the bundler just built** (not a published file) without the Wayland libraries the bundler copies in ([tauri-apps/tauri#15665](https://github.com/tauri-apps/tauri/issues/15665)), and fails if any `libwayland` is left in the result;
3. starts the repacked AppImage without FUSE;
4. signs it;
5. verifies that signature against the public key in `tauri.conf.json` **as the newest published release had it** (read from that tag with `git show`; if it cannot be read, the job fails). This is the key installed copies trust, and the right one for a key rotation (below);
6. replaces the AppImage, its `.sig` and `latest.json` in the draft **by release id** and rewrites any temporary `untagged-...` download URL to the tag's. The AppImage goes in first, then its `.sig`, each tried up to three times with a wait between (GitHub sometimes refuses a large asset, and a refused upload leaves a partial asset that is removed before the next try), and each checked for state, size and digest. `latest.json` is touched last, so a refused upload leaves the draft with the `latest.json` it had, which lists every platform, and the failed Linux job can be run again. Only the last upload, of `latest.json` itself, can leave the draft without one; that takes three failures in a row, and then the whole workflow has to run again (below).

**Publish**, a job of its own with no signing key, which runs only for a tag (never for a rehearsal) and waits for the `release` environment's approval:

1. fetches the trusted key as above, which is the previous release's whole `tauri.conf.json`;
2. **compares the release with the previous one** and fails unless `tauri.conf.json` as it is in the tree: has a `plugins.updater.pubkey` that is a key, written exactly as the updater reads it (base64 with no whitespace around or inside it), **equal to the previous release's** (a replaced key needs the opt-in, below); has the **same `plugins.updater.endpoints`**, in the same order; has the **same `identifier`**; and has a **higher `version`** by semver precedence (a prerelease is below its release, build metadata does not count). Every installed copy takes the key and the addresses from the release it updates to, so a wrong one is not an error that the next release fixes: the copies that took it can never update again, and every user reinstalls by hand. A version that is not higher would also point the feed backwards;
3. reads the draft and fails unless: it is a draft and not a prerelease; its tag is `vX.Y.Z` with `X.Y.Z` the version in `tauri.conf.json` and in `latest.json`; the assets are exactly the installers, `.sig` files and `latest.json` in the table, each fully uploaded and uploaded after the run started (a leftover of an earlier attempt is refused); `latest.json` has every platform key, each pointing at the tagged URL of the right asset, with a signature that is exactly its `.sig` file's text, **without trimming or wrapping**, because the updater decodes that string as it stands and an installed copy would fail on a trailing newline; no URL is an `untagged-...` one; the notes say "New in X.Y.Z";
4. downloads every signed artifact and verifies its signature **against its bytes** with the trusted key, in either minisign format and including the trusted comment, as an installed copy will; GitHub's digest of each must be that of the bytes, and **the digest of the AppImage the Linux job signed must be given and must match**: a digest that names no asset in the draft (a version or name skew) is an error, not something to skip;
5. reads the release once more and **stops if any asset is not the one it checked** (another upload under a name, a changed size, digest or `updated_at`, an asset added or removed), or the draft was published or retagged meanwhile. A refusal here costs only a re-run of the publish job;
6. only then sends the one request that makes the draft public (`draft` false) and **trusts its answer**: the response to the PATCH is the release as it now is, and says whether it took. A read afterwards is made only when the answer holds no release, since a stale read right after the write would fail a job whose release is already public;
7. looks at the public `latest.json` a few times. This step only warns: a slow CDN must never undo a release that passed every check.

The rehearsal's `dry-run` job runs steps 1 to 4 with `--dry-run`, which also checks that the draft is a prerelease with a `dry-run-<run id>` tag; the AppImage digest is compared there but not required.

The draft checks live in `scripts/check-release-draft.mjs` and `scripts/lib/release-draft.mjs`, the signature check in `scripts/verify-updater-signature.mjs`; `node scripts/check-release-draft.mjs` prints the commands. **Which failures are tried again.** Every read from GitHub (the release, its assets, the 360 MB of downloads) is tried up to three times, after 2 s and 6 s, when the failure is: HTTP 429 or any 5xx; a rate limit by its wording, which includes GitHub's secondary rate limit answered with a 403; a connection that was reset, refused, closed or timed out; a DNS failure (`no such host`, `ENOTFOUND`, and gh's own `error connecting to ...` with its pointer to githubstatus.com); a TLS handshake failure; or a body cut off mid-download (`unexpected EOF`, a bare `EOF` ending the line, an HTTP/2 stream error, a GOAWAY). That way one 502 does not cost a new approval. Anything else is the answer and is **never** repeated: a 404, a 403 that is not a limit (no permission), a 401 or 422, a missing `gh`. **A write is never retried by the script**: the PATCH, an upload and a delete each go out once, since only a person knows whether one can be repeated.

Linux packages keep Node in `/usr/lib/Ancilla/resources/node`, with the server and frontend beside it. They must never install `/usr/bin/node` or shadow the user's Node. `verify-linux-bundles.sh` checks those paths, package dependencies, menu entries and icons in the Debian, RPM and AppImage outputs. The native shell and web UI both disable the AppImage updater for system packages.

## Reviewing the draft

Before approving the publish job, open the draft on the Releases page and look at what no check can judge: the notes read as they should (they are also what the app shows as the update's notes), the right five installers and `latest.json` are there, nothing odd is attached. For a release that changes how the desktop app starts, do more first: see [Before a release that changes the boot path](#before-a-release-that-changes-the-boot-path).

## When something goes wrong

- **A build job failed on something passing**, like a runner or an upload: re-run the failed jobs from the Actions page. A re-run of the Windows job deletes its draft and starts a new one, and the macOS and Linux jobs then have to run again too (use "Re-run all jobs"); a re-run of the macOS or Linux job adds to the draft that is there, merging its platform into the `latest.json` that is there. The Linux job's last step names which of these applies when it fails: after an AppImage or signature that could not be uploaded, `latest.json` is still whole and the Linux job alone is enough; after a `latest.json` that could not be uploaded, the draft has none, a Linux job run alone would write one that lists Linux only (and the publish checks would refuse it), and the whole workflow has to run again.
- **The publish job failed its checks**: the log lists every problem. The draft is still private and nothing was published. Fix the cause and re-run the build job that made the bad part, or delete the draft and run the whole workflow again. A problem in `tauri.conf.json` (the key, the endpoints, the identifier, a version that is not higher) is in the tree, so it needs a new commit; the tag is on the old one, so either delete the draft and the tag and tag the new commit (fine while nothing is published) or release the next patch version.
- **The publish job failed at or after the PATCH** (the log stops after "Check the draft and publish it" started sending, a timeout or a lost response, or it says the release is still a draft or was published as a prerelease): **look at the Releases page before re-running anything.** The release may already be public, in which case a re-run only fails with "the release is not a draft (it is already published)" and the work to do is to look at the public `latest.json` yourself, as the last step of the job would have. If it is still a draft, a re-run is safe: it checks everything again. If it is public but wrong (a prerelease, another tag), pull it as described below.
- **A whole tag needs building again**: `gh workflow run release.yml --repo aleff-ferreira/ancilla --ref vX.Y.Z`, only while the tag has **no published release**. It runs the workflow as it was at that tag, so a tag made before this pipeline existed runs the old, publish-first workflow: do not use it on those.
- **A tag that has a published release is never built again.** The Windows job refuses it. Installed copies may already have updated to it and will not install the same version twice, so the fix is always the next patch version.
- **A rehearsal's draft is left behind**: delete the `dry-run-*` draft on the Releases page.
- **Two tags pushed together** publish one at a time. A third pushed while one is waiting replaces the waiting one, whose publish job is then cancelled; its draft stays private, and you re-run the workflow for it.

### Pulling a release, and what that does not undo

The kill switch is to turn the published release back into a draft (or delete it) on the Releases page. `releases/latest` then falls back to the previous release, whose `latest.json` names the same or an older version, so no copy is offered an update. (If the repository ever turns on immutable releases, a published release can no longer be changed and this is not available: the only route is a newer release.)

That protects only copies that have not yet downloaded the release. Auto-update is on by default: a copy checks about five seconds after it starts and installs the update when it is closed, so a validly signed but broken release is on many machines within minutes, and **pulling it does nothing for them**. They heal only when a higher version is published. So:

1. Pull the release at once to stop new downloads.
2. Publish a fixed higher version (the next patch) as fast as the pipeline allows.
3. For a user whose copy no longer starts, a manual downgrade is to download the previous installer and run it. The app's data lives outside the install and installing another version does not delete it, and the app only ever adds to its stored data, but an older build reading what a newer one stored has not been tried, and a system installer may refuse to install over a newer version or ask to uninstall first. None of this has been tried on each system.

Wrong or missing signatures, a missing platform or a wrong URL never strand a copy: it reports an update error, or sees no update, and heals when a correct release is published. The one case that strands is a correctly signed build that does not start, which is why the next section exists.

## Before a release that changes the boot path

The publish job's checks cannot see a build that is signed correctly but does not start, and auto-update would deliver it within minutes. Until the checks below exist as tooling, treat each as a gate that is done by hand, and write down what you saw, before the first release that changes how the desktop app starts (its shell, the server it spawns, its sign-in on localhost; the 0.21.0 plan):

- **Installer launch on every system**, from the draft's own installers: Windows (the setup program, then launch), macOS (the disk image, first launch with the right-click Open), Linux (the `.deb` from the system path, and the AppImage with and without FUSE and a session bus). In each, a real window opens and the app is authenticated against its own server, not only a port file or `/api/health`.
- **An update from the previous release to this one**, N to N+1: serve a `latest.json` for the new build locally, build the new version with its updater endpoint overridden by `--config`, install the old release, and let it update. This runs the old updater code against the new feed and then the new app's first start after an update. Do it on Windows, macOS and the AppImage.
- **Dogfood** the draft's installers on Windows with a project in WSL, which is where most things differ.
- **Know the kill switch** above, and that it protects only copies that have not yet downloaded.

None of this is automated yet, and none of it should be invented in a hurry; a gate that is skipped is worse than one that is plainly manual.

### The 0.21.0 checklist

0.21.0 is the release that makes the desktop app stop its server gracefully and refuse a second copy over one data folder, so the three gates are run for it as follows, and what was seen is written down with the release.

1. **Installer launch on every system**, from the draft's own installers. Windows: run the setup program, then launch. macOS: open the disk image, launch with the right-click Open. Linux: install the `.deb` and launch `ancilla` from the system path, then launch the AppImage with FUSE and with `--appimage-extract-and-run`. On each, a window opens and the app signs in against its own server, and closing the window ends the app within a few seconds with no `node` process left behind (Task Manager, Activity Monitor, `ps`).
2. **The update from 0.20.4 to 0.21.0.** Serve a `latest.json` for the new build locally, build the new version with its updater endpoint overridden by `--config`, install 0.20.4, let it find the update, and take both ways in: install on close (quit, the installer runs, open the app again) and Restart to update. This is the one time the old shell's plain kill and the new shell's wait before the installer both run: no file-in-use error from the installer, the first start on the same port, no "already open" page, no `ancilla.owner` left by the old copy. Do it on Windows, macOS and the AppImage.
3. **The dogfood on Windows with a project in WSL**, the eleven items:
   1. Launch, quit and launch again five times: `server-port` is byte-identical after each, and the theme and the automatic-update setting are still there.
   2. Quit with a WSL project open and a Muse host live: `server.log` shows the `stdin EOF received` line and the close ends within a few seconds; `ps` inside the distro says whether `muse serve` exited with it (the S5 answer).
   3. End `Ancilla.exe` in Task Manager: `node.exe` is gone within about two seconds, and launching again at once gives a window on the same port, not the "already open" page.
   4. End `node.exe` in Task Manager while the app runs, then quit and launch again: the record left with a dead pid is taken over at once.
   5. Launch a second time while the app runs: the existing window is focused, no second process appears, `server-port` is unchanged.
   6. Double-click the app again within a second or two of a quit: one fresh window afterwards, one process in Task Manager.
   7. Install on close and Restart to update from 0.20.4 to the 0.21.0 draft, or to a build served by a local `latest.json` (gate 2, on this machine).
   8. A command-line `ancilla-server --data-dir` pointed at the desktop app's AppData folder while the app runs: exit code 75 and the one line on stderr. The reverse, the app launched while that server runs: the "already open" page, with a link that opens the running copy.
   9. A command-line `--data-dir` on a `\\wsl.localhost\...` folder launched twice from Windows: the second is refused (exclusive creation on the 9P client, S5).
   10. Sleep for ten minutes with the app open, wake, quit: still graceful, within the grace (S9).
   11. Nothing above covers macOS or a Linux desktop with a real session bus and focus under WSLg. On macOS, Cmd+Q through the menu closes the window and is graceful by design; the Dock's Quit reaches the app as its Exit event alone, where it now stops the server gracefully too (UNVERIFIED on a Mac); the updater's relaunch and the single-instance plugin are untried as well. On a Linux AppImage without FUSE, a double-click during a quit reopens the image with `--appimage-extract-and-run` (unit-tested, not run on a machine). Until a machine is borrowed, those are gaps written down with the release, not assumed.

The Linux installer smoke (`linux-appimage.yml`, on every pull request that touches the desktop app or the server) covers the quit path by machine for the `.deb` and the AppImage, each once without a session bus and once under `dbus-run-session`: the window is closed the way a window manager does it, the server is gone within the 25 seconds the app gives it, `server-port` is byte-identical before and after, `server.log` has the `stdin EOF received` line, `ancilla.owner` is gone, no process of the app's XDG tree survives, a second copy started as soon as the window is asked to close comes up on the same port, under the bus a second launch while the first runs is forwarded to it with one app process remaining, and the app launched over a folder that an `ancilla-server` started by hand owns is refused, keeps its "already open" window up, touches neither `server-port` nor the owner record, and closes alone while that server keeps serving. It cannot see focus, the link on the "already open" page, the updater, the Windows installer or the end of a Windows pipe, which is what the gates above are for.

## What users see

- **Windows**: the installer is not Authenticode-signed yet, so SmartScreen may warn about an unrecognised app; More info, then Run anyway. Updates install in passive mode, with a small progress window and no questions.
- **macOS**: the app is not notarized by Apple, so its first launch needs a right-click on the app, then Open. It is signed ad hoc rather than with a Developer ID, so macOS asks again for access to protected folders after each update.
- **Linux**: open the `.deb` or `.rpm` in the system software installer; it adds the application-menu icon and installs dependencies. Home offers guided Muse installation and sign-in; Settings offers an optional desktop shortcut. The AppImage must be marked executable once and can install its launcher from inside the app. AppImages update themselves; system packages link to the latest installer.
- **Helicon users**: Ancilla is a separate app with its own identifier (`app.ancilla.desktop`), key and update address, so Helicon never updates into it. Installing Ancilla leaves Helicon in place, and Ancilla copies Helicon's data the first time it starts.

A release is published whole now, so a copy never sees a `latest.json` that lacks its platform because another platform finished first. (Releases up to 0.20.3 were public from the Windows job on and gained macOS and Linux later; the app still treats a missing platform as "up to date".)

## Replacing the signing key

Only while you still have the old key; without it, see the warning above. Before the first release there is nothing to keep: make a new key, put its public half in `tauri.conf.json` and set the secret, and installs made from then on trust it.

A release is checked against the previous one, and a changed `plugins.updater.pubkey` is exactly what that check refuses, since by itself it looks the same as a typo or a bad merge that would strand every installed copy. Replacing the key on purpose is therefore a **manual run with an opt-in**, and the two halves of the rule are these:

- **The signatures are checked against the previous release's key, the old one.** The rotation release carries the new public key in `tauri.conf.json` but is signed with the old secret key, because installed copies check an update against the key they already hold. So the Linux job and the publish job go on verifying against `tauri.conf.json` as the newest published release had it, with or without the opt-in. A release signed with the new key before the rotation release was published fails, which is right: no installed copy could verify it.
- **The new key only has to be a key.** With the opt-in, `plugins.updater.pubkey` in the tree may differ from the previous release's, but it must still parse, written exactly as the updater reads it (base64 with no whitespace). Everything else is compared as always: the endpoints, the identifier and the higher version are not excused by it. The pipeline **cannot** know that the new public key belongs to the new private key you hold, which is why step 2 below checks it by hand before anything is released.

1. Make a new key: `npx tauri signer generate -w ~/.tauri/ancilla-updater-2.key`.
2. Check that the new private key and the new public key are a pair, by signing a scratch file and verifying it with the public key you are about to commit:

   ```sh
   echo rotation > /tmp/rotation-check.txt
   npx tauri signer sign --private-key-path ~/.tauri/ancilla-updater-2.key --password= /tmp/rotation-check.txt
   node scripts/verify-updater-signature.mjs --pubkey "$(cat ~/.tauri/ancilla-updater-2.key.pub)" /tmp/rotation-check.txt
   ```

   It must print `Verified rotation-check.txt`. (Use `--password` with the key's password if it has one.)
3. Put the new public key (the contents of `ancilla-updater-2.key.pub`, on one line, with nothing around it) in `tauri.conf.json` as `plugins.updater.pubkey`, with the version bump, and leave the **old** key in the `TAURI_SIGNING_PRIVATE_KEY` secret. For this one release the key and the configured public key differ on purpose, so the Windows job's key check warns that the signing key is not the configured one, and the build log has tauri's own warning that the updater secret key does not match `plugins > updater > pubkey`. Both are expected here.
4. Rehearse it first, from the branch: `gh workflow run release.yml --repo aleff-ferreira/ancilla --ref <branch> -f dry_run=true -f rotate_key=true`. Without `rotate_key` the run stops within seconds, in the Windows job's early comparison, naming both keys.
5. Tag the release and push the tag as for any release. **That push fails on purpose**, within seconds, in the Windows job's early comparison: a pushed tag can never opt in to replacing the key (the script refuses `--allow-key-rotation` on a push, and the workflow only sets it from the `rotate_key` input of a manual run), and no build is started and no draft made. Then start the release by hand on the tag: `gh workflow run release.yml --repo aleff-ferreira/ancilla --ref vX.Y.Z -f rotate_key=true`. Its log carries a notice "Key rotation" in the Windows job and the publish job; read the draft, then approve the publish job as usual.
6. Before the next release, point the secret at the new key: `gh secret set TAURI_SIGNING_PRIVATE_KEY --repo aleff-ferreira/ancilla < ~/.tauri/ancilla-updater-2.key`. Back it up like the first. That next release is a normal one: it is compared with the rotation release, whose key is the new one, so it needs no opt-in, and it is signed with the new key.

A copy that skipped the rotation release still trusts the old key and cannot verify anything signed with the new one; it needs a manual install.

## Commit messages

Every commit message is checked: by the `commit-msg` hook (`.githooks/`, installed by `npm ci`) as it is written, and by `npm run attribution:check` in CI over the history. Commits here carry the author's name only, so a message that names an AI tool or its vendor is refused. For commits after the pinned baseline that means **any line at all**: a credit line, a free sentence, and a file name such as the instructions file, wherever it appears. The refusal says so and quotes the line; the fix is to reword it ("the instructions file", not its name). Two things follow:

- The first line git writes by itself for a merge (`Merge branch ...`, `Merge pull request ...`, `Merge remote-tracking branch ...`) or a revert (`Revert "..."`) is not held to the free-line part, since a branch called after one of these tools is not a credit. Credit-shaped lines are refused there like anywhere.
- **A branch name and a pull request title should not carry these names**, either. GitHub makes the merge or squash commit on the server, taking its subject from the title, and a hook on a laptop cannot refuse it; CI then fails on `main` until the history is dealt with. Name the branch after the change instead.

The hook refuses only when the check says so with its own exit status (3). If node cannot run the check at all, whatever the reason (no node on the PATH, a node too old to parse the script, a loader that fails), the hook says so and falls back to the narrower pattern for credit lines; that is never a refusal by itself.

## Follow-ups, not done

- **The Linux runner.** The AppImage is built on `ubuntu-22.04`, which fixes the oldest glibc it runs on. GitHub is retiring that image (deprecation began 2026-09-17, unsupported from 2027-04-17, with brownouts that fail jobs before then). Moving to 24.04 raises the glibc floor and renames `libfuse2` to `libfuse2t64`; the alternative is a 22.04 container. Decide before April 2027, and rehearse the change. `ubuntu-latest` moves to 26.04 in November 2026, which is why no workflow here uses it.
- **The AppImage runtime.** `appimagetool` is pinned by checksum, but it fetches the newest runtime when it runs. Pin the runtime deliberately, after testing a launch on an old distribution with FUSE.
- **Provenance of a tag.** A tag on a commit that never went green or was never on `main` publishes. Check the commit's check runs and that it is on `main` before the build jobs.
- **`linux-appimage.yml`**: widen its path filters (they miss the daemon, UI, web, lockfile and scripts that the bundle includes) and make its "skip until Linux bundling lands" guard fail instead of passing quietly.
- **Keep the pins current.** The actions in `release.yml` (checkout, setup-node, rust-toolchain, tauri-action) are pinned to full commits with the tag in a comment, because the three build jobs hold the signing key and a moved tag or branch must not change what runs beside it. Pins go stale: add Dependabot for the `github-actions` ecosystem so that each bump arrives as a pull request to review, and pin the actions of the other workflows the same way. `dtolnay/rust-toolchain` is asked for `stable` by name, so the Rust version still floats; pin a version when a release needs a reproducible toolchain.
- **Dead updater entries**: `latest.json` still lists `deb` and `rpm`, which no installed copy reads. The checks accept them and do not require them.
