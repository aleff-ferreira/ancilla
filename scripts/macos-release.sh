#!/usr/bin/env bash
#
# macos-release.sh — ship Ancilla for macOS.
#
# Phase 1: commit the macOS work on prod and push it.
# Phase 2: backfill macOS assets onto v0.1.0..v0.9.0 (skips tags that already
#          have them, so rerunning resumes where it stopped).
# Phase 3: tag v0.10.0, push it, and verify the dual-platform release.
#
# Usage: ./scripts/macos-release.sh [--yes]
#   --yes  skip confirmation prompts (still prints everything it does).
#
# The backfill and release builds each take a while in CI (a universal macOS
# build is ~15-25 minutes); this script polls until they finish. Ctrl-C is
# safe at any point — just run it again to resume.

set -euo pipefail

REPO="$HOME/Documents/Projects/ancilla"
BRANCH="prod"
BACKFILL_WORKFLOW="Release macOS backfill"
RELEASE_WORKFLOW="Release"
TAGS="v0.1.0 v0.2.0 v0.3.0 v0.4.0 v0.5.0 v0.6.0 v0.6.1 v0.7.0 v0.7.1 v0.8.0 v0.8.1 v0.9.0"
NEXT_TAG="v0.10.0"
POLL_SECONDS=60

YES=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

say() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
confirm() {
  if [ "$YES" -eq 1 ]; then return 0; fi
  printf '%s [y/N] ' "$1"
  read -r answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ]
}

have_macos_assets() {
  # True when the release already carries macOS assets.
  local count
  count=$(gh release view "$1" --json assets \
    --jq '[.assets[].name] | map(select(test("dmg$|app\\.tar\\.gz$"))) | length' 2>/dev/null || echo 0)
  [ "$count" -gt 0 ]
}

known_runs() {
  # Run ids this workflow already has (newest 50).
  gh run list --workflow "$1" --limit 50 --json databaseId -q '.[].databaseId' 2>/dev/null || true
}

wait_for_new_run() {
  # Prints the id of a run that appears after the known ones (up to ~5 min).
  local workflow="$1"; shift
  local known="$*"
  local candidate id
  for _ in $(seq 1 30); do
    id=$(gh run list --workflow "$workflow" --limit 10 --json databaseId -q '.[].databaseId' 2>/dev/null || true)
    for candidate in $id; do
      if ! printf '%s' "$known" | grep -qw "$candidate"; then
        printf '%s' "$candidate"
        return 0
      fi
    done
    sleep 10
  done
  return 1
}

run_state() {
  # Prints "status conclusion" for a run id.
  gh run view "$1" --json status,conclusion -q '[.status, (.conclusion // "-")] | join(" ")' 2>/dev/null || echo "unknown -"
}

wait_for_runs() {
  # wait_for_runs "id:tag id:tag..." — polls until every run completes.
  # Returns 1 when any run did not succeed.
  local pending="$1"
  local failed=0
  local start now elapsed
  start=$(date +%s)
  while [ -n "$pending" ]; do
    local still=""
    local item id tag state conclusion
    for item in $pending; do
      id="${item%%:*}"
      tag="${item#*:}"
      read -r state conclusion <<< "$(run_state "$id")"
      if [ "$state" = "completed" ]; then
        say "$tag run $id: $conclusion (https://github.com/aleff-ferreira/ancilla/actions/runs/$id)"
        [ "$conclusion" = "success" ] || failed=1
      else
        still="$still $item"
      fi
    done
    pending="$(printf '%s' "$still" | sed 's/^ *//')"
    [ -z "$pending" ] && break
    now=$(date +%s)
    elapsed=$(( (now - start) / 60 ))
    say "waiting on:${pending} (${elapsed}m elapsed)"
    sleep "$POLL_SECONDS"
  done
  return "$failed"
}

verify_latest_json() {
  # verify_latest_json <tag> — the updater manifest must serve every platform.
  local dir
  dir=$(mktemp -d)
  gh release download "$1" -p latest.json -D "$dir" --clobber >/dev/null 2>&1 \
    || die "could not download latest.json from $1"
  python3 - "$dir/latest.json" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
platforms = sorted(d.get("platforms", {}).keys())
print("version:", d.get("version"))
print("platforms:", " ".join(platforms))
need = {"darwin-aarch64", "darwin-x86_64"}
missing = need - set(platforms)
windows = [p for p in platforms if p.startswith("windows")]
if missing or not windows:
    print("MISSING:", " ".join(sorted(missing)) + ("" if windows else " windows-*"))
    sys.exit(1)
print("latest.json serves Windows, macOS Apple Silicon, and macOS Intel.")
EOF
}

cd "$REPO" || die "no repo at $REPO"
[ "$(git branch --show-current)" = "$BRANCH" ] || die "not on $BRANCH"
gh auth status >/dev/null 2>&1 || die "gh is not logged in"
git fetch -q origin
[ -z "$(git rev-list "HEAD..@{u}" 2>/dev/null || true)" ] || die "$BRANCH has upstream changes; pull first"

say "=== Phase 1: commit and push ==="
git status --short
if [ -n "$(git status --short)" ]; then
  git diff --stat
  confirm "Commit everything above?" || die "aborted"
  git add -A
  git commit -m "feat: macOS builds and releases" \
    -m "Universal macOS installer on every release; backfill workflow for old tags; desktop finds Node through the user's shell."
else
  say "tree is clean, nothing to commit"
fi
confirm "Push $BRANCH to origin?" || die "aborted"
git push origin "$BRANCH"
gh workflow view "$BACKFILL_WORKFLOW" --ref "$BRANCH" --yaml >/dev/null \
  || die "backfill workflow not found on $BRANCH after push"

say "=== Phase 2: backfill macOS assets ==="
failures=""
pending=""
for tag in $TAGS; do
  if have_macos_assets "$tag"; then
    say "$tag already has macOS assets, skipping"
    continue
  fi
  say "triggering backfill for $tag"
  known=$(known_runs "$BACKFILL_WORKFLOW")
  gh workflow run "$BACKFILL_WORKFLOW" --ref "$BRANCH" -f tag="$tag"
  id=$(wait_for_new_run "$BACKFILL_WORKFLOW" "$known") || die "no run appeared for $tag"
  say "$tag run $id: https://github.com/aleff-ferreira/ancilla/actions/runs/$id"
  pending="$pending $id:$tag"
done
pending="$(printf '%s' "$pending" | sed 's/^ *//')"
if [ -n "$pending" ]; then
  wait_for_runs "$pending" || failures="backfill"
  say "rechecking release assets"
  for tag in $TAGS; do
    if have_macos_assets "$tag"; then
      say "$tag: macOS assets present"
    else
      say "$tag: macOS assets MISSING"
      failures="backfill"
    fi
  done
else
  say "nothing to backfill"
fi

say "=== Phase 3: release $NEXT_TAG ==="
if git ls-remote --tags origin "$NEXT_TAG" | grep -q .; then
  say "$NEXT_TAG already exists on origin; verifying it instead of retagging"
else
  if [ -n "$failures" ]; then
    say "WARNING: some backfills failed (see above); the $NEXT_TAG release is independent of them."
    confirm "Still cut $NEXT_TAG?" || die "aborted"
  else
    confirm "Tag $NEXT_TAG and push it?" || die "aborted"
  fi
  # Annotated with -m: a bare `git tag` can open $EDITOR and hang headless.
  git tag -a "$NEXT_TAG" -m "Ancilla $NEXT_TAG"
  git push origin "$NEXT_TAG"
fi
if gh release view "$NEXT_TAG" >/dev/null 2>&1; then
  say "$NEXT_TAG release exists; checking its updater manifest"
  verify_latest_json "$NEXT_TAG"
else
  say "waiting for the Release workflow to publish $NEXT_TAG"
  known=$(known_runs "$RELEASE_WORKFLOW")
  id=$(wait_for_new_run "$RELEASE_WORKFLOW" "$known") || die "no Release run appeared for $NEXT_TAG"
  say "Release run $id: https://github.com/aleff-ferreira/ancilla/actions/runs/$id"
  wait_for_runs "$id:$NEXT_TAG" || die "Release run failed"
  verify_latest_json "$NEXT_TAG"
fi

if [ -n "$failures" ]; then
  die "done with failures (see above); rerun to retry what is missing"
fi
say "done: every release from v0.1.0 to $NEXT_TAG carries macOS assets"
