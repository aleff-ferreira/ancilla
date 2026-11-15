// The release workflow's gate between a build and a published release, and the few operations on the private draft
// that sit around it (docs/RELEASING.md). The rules live in lib/release-draft.mjs, where they are tested without
// GitHub; this file only hands them the real gh, git and file system.
//
//   prepare           refuse a tag that already has a published release; delete drafts an earlier attempt left
//   check             every rule, on a draft: the configuration against the previous release's (key, update endpoints,
//                     identifier, a higher version), assets, latest.json, signatures against the trusted key and the bytes
//   publish           check, then PATCH draft=false (never when the check found anything)
//   discard           delete the draft of a dry run
//   trusted-conf      write tauri.conf.json as the newest published release had it, the key installed copies trust;
//                     with --conf, also make the comparison with the previous release at once (the early look)
//
// --allow-key-rotation lets plugins.updater.pubkey differ from the previous release's, for a deliberate replacement of the
// signing key. Signatures are still checked against the previous release's key. A push cannot ask for it.
//   replace-appimage  put the repacked, re-signed AppImage in the draft and update latest.json
//   poll              after publishing, report (never fail) whether the public latest.json names the new version
//
// Needs gh, signed in through GH_TOKEN or GITHUB_TOKEN. Run it with no arguments for the options.
import { realDeps, runCommand } from "./lib/release-draft.mjs";

process.exitCode = await runCommand(process.argv.slice(2), realDeps());
