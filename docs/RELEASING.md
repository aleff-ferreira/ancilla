# Releasing Ancilla

A release is a `vX.Y.Z` tag on `main`. Pushing the tag runs the [Release workflow](../.github/workflows/release.yml), which builds the desktop app for Windows, macOS and Linux, publishes it as the GitHub release "Ancilla vX.Y.Z", and writes `latest.json`, the file every installed copy checks for updates.

## One-time setup

### The updater signing key

Installed copies only accept an update signed with the key whose public half is in `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The private half is `~/.tauri/ancilla-updater.key` on the maintainer's machine, and the release jobs need it as a repository secret:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo aleff-ferreira/ancilla < ~/.tauri/ancilla-updater.key
```

To see that the secret is set, opens, and is the key installed copies trust, without cutting a release, run `gh workflow run check-signing-key.yml --repo aleff-ferreira/ancilla` and read the run's annotations.

The key has no password, so there is no `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret to add. The workflow passes an empty password when that secret is absent, which is what opens a key made without one. The secret is only needed if the key is ever replaced with one that has a password.

Every release job checks for `TAURI_SIGNING_PRIVATE_KEY` before anything else and stops within seconds, saying so, if it is missing. Once its dependencies are installed, the Windows job also signs a scratch file with the key, so a key that is damaged or needs a password it was not given fails there, before the build, and it adds a warning to the run if the key is not the one whose public half is in `tauri.conf.json`.

> **Back the key up**, somewhere other than this machine: a password manager, an encrypted drive. If it is lost, no later release can be signed with it, and every installed copy of Ancilla stops updating for good; the only way forward is for each user to download and install a new build by hand. If it leaks, replace it (below) as soon as you can.

Nothing else needs setting up. The release jobs ask for `contents: write` themselves and upload with the workflow's own token. There is no Apple or Windows code signing yet (see [What users see](#what-users-see)).

## Cutting a release

1. Start from an up-to-date `main` whose CI is green.
2. Set the new version everywhere it is written down:

   ```sh
   npm run version:bump -- 0.18.1
   ```

   This writes the root and workspace `package.json` files, `package-lock.json`, `tauri.conf.json`, `Cargo.toml`, the crate's entry in `Cargo.lock` and `ANCILLA_VERSION` in the server. If any of them cannot be found it stops without changing a file.
3. Add an entry at the top of `docs/CHANGELOG.md`, under a `## 0.18.1` heading, in the style of the entries below it: `### New`, `### Fixed` and `### Changed` sections, each item a bold one-sentence summary followed by what changed in plain words, with a link to the issue or pull request and credit to whoever reported or built it. Then copy it into the app, which shows it after updating itself:

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

   `version:check` is what CI runs on every push: it fails if any version differs, or if the changelog has no entry for it.
5. Commit ("Release 0.18.1"), push it to `main` or merge its pull request, and wait for CI.
6. Tag that commit and push the tag:

   ```sh
   git tag v0.18.1
   git push origin v0.18.1
   ```

## What the workflow produces

Three jobs run one after another: Windows, then macOS, then Linux. Each merges its platform into the release's `latest.json`, and running them side by side could drop a platform from auto-update. Expect the whole run to take a while; the universal macOS build alone is 15 to 25 minutes.

Before building, the Windows job checks the tag against the version in the files, so a tag pushed without a bump stops there. Then each job builds the app with Node.js bundled, signs the update package with the key above, and uploads to the release (the Windows job creates it):

| Platform | To install | For the updater |
| --- | --- | --- |
| Windows x64 | `Ancilla_X.Y.Z_x64-setup.exe` | the same installer, plus its `.sig` |
| macOS, Apple Silicon and Intel | `Ancilla_X.Y.Z_universal.dmg` | an `.app.tar.gz`, plus its `.sig` |
| Linux x86_64 | `Ancilla_X.Y.Z_amd64.AppImage` | the same AppImage, plus its `.sig` |

and `latest.json`, which lists each platform's update package, its signature and the release notes. The Linux job then repacks the AppImage without the Wayland libraries the bundler copies in ([tauri-apps/tauri#15665](https://github.com/tauri-apps/tauri/issues/15665)), signs it again and replaces it, along with its entries in `latest.json`.

The release is published straight away, not as a draft or pre-release, so `https://github.com/aleff-ferreira/ancilla/releases/latest/download/latest.json`, the only address installed copies check, points at it from the moment the Windows job finishes. Until the macOS and Linux jobs have added their platforms, copies on those systems simply see no update yet.

Afterwards, check that the release page has all three installers and `latest.json`, and that `latest.json` has Windows, macOS and Linux entries. Then update an older installed copy with Check for updates, in Settings or the command palette.

## When something goes wrong

- **A job failed on something passing**, like a runner or an upload: re-run the failed jobs from the Actions page. Uploads replace what is already there.
- **A whole tag needs building again**: `gh workflow run release.yml --ref vX.Y.Z`. It runs the workflow as it was at that tag.
- **The release itself is broken**: fix it on `main` and release the next patch version. Never move or reuse a tag whose release was published, since installed copies may already have updated to it and will not install the same version twice.

## What users see

- **Windows**: the installer is not Authenticode-signed yet, so SmartScreen may warn about an unrecognised app; More info, then Run anyway. Updates install in passive mode, with a small progress window and no questions.
- **macOS**: the app is not notarized by Apple, so its first launch needs a right-click on the app, then Open. It is signed ad hoc rather than with a Developer ID, so macOS asks again for access to protected folders after each update.
- **Linux**: the AppImage has to be marked executable once; it updates itself after that.
- **Helicon users**: Ancilla is a separate app with its own identifier (`app.ancilla.desktop`), key and update address, so Helicon never updates into it. Installing Ancilla leaves Helicon in place, and Ancilla copies Helicon's data the first time it starts.

## Replacing the signing key

Only while you still have the old key; without it, see the warning above.

1. Make a new key: `npx tauri signer generate -w ~/.tauri/ancilla-updater-2.key`.
2. Put the new public key (the contents of `ancilla-updater-2.key.pub`) in `tauri.conf.json` as `plugins.updater.pubkey`, and release that version with the old key still in the secret. Installed copies check an update against the key they already have, so they accept this one, and from then on trust only the new key. For this one release the key and the configured public key differ on purpose, so the Windows job's key check warns that the signing key is not the configured one, and the build log has tauri's own warning that the updater secret key does not match `plugins > updater > pubkey`. Both are expected here.
3. Before the next release, point the secret at the new key: `gh secret set TAURI_SIGNING_PRIVATE_KEY --repo aleff-ferreira/ancilla < ~/.tauri/ancilla-updater-2.key`. Back it up like the first.
