#!/usr/bin/env bash
# Repacks the AppImage the Tauri bundler built without the Wayland libraries linuxdeploy copied into it, so that it
# uses the host's. Ubuntu 22.04's libwayland-* are stale next to a newer Mesa: EGL initialisation fails and WebKitGTK
# aborts with EGL_BAD_ALLOC before the window opens (tauri-apps/tauri#15665).
#
#   bash apps/desktop/scripts/repack-appimage.sh <the bundler's .AppImage> <directory for the repacked one>
#
# The result has the same file name in the given directory. It is not signed here: the bundler's signature no longer
# fits it, and the release workflow signs it, checks the signature and starts it afterwards. The only thing this
# script settles itself is that no libwayland is left in the result, and it fails if one is.
set -euo pipefail

input="$(realpath "${1:?Pass the AppImage the bundler built}")"
mkdir -p "${2:?Pass the directory the repacked AppImage goes in}"
outdir="$(realpath "$2")"
name="$(basename "$input")"

# The tool that packs a squashfs tree back into an AppImage, by version and checksum. It fetches the AppImage runtime
# itself when it runs; pinning that is a separate decision (docs/RELEASING.md, follow-ups).
tool_url='https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage'
tool_sha256='ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0'

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

cp "$input" "./$name"
chmod +x "./$name"
"./$name" --appimage-extract > /dev/null
# The libraries, their links, and the packages' documentation directories (usr/share/doc/libwayland-server0 and its
# siblings), which are named like the libraries and would otherwise fail the check below. A matched directory is
# pruned, so its contents go with it and are never looked at.
find squashfs-root -name 'libwayland-*' -prune -print -exec rm -rf {} +

curl -sSL --fail --retry 3 --retry-delay 5 -o appimagetool "$tool_url"
echo "$tool_sha256  appimagetool" | sha256sum --check
chmod +x appimagetool

rm -f "$outdir/$name" "$outdir/$name.sig"
ARCH=x86_64 ./appimagetool --appimage-extract-and-run squashfs-root "$outdir/$name"

# Look inside what was built, not at what was meant to be built.
mkdir check
(cd check && "$outdir/$name" --appimage-extract > /dev/null)
left="$(find check/squashfs-root -name 'libwayland-*' -print)"
if [ -n "$left" ]; then
  echo "::error title=Wayland libraries are still in the AppImage::$left" >&2
  exit 1
fi
test -x "$outdir/$name"
echo "Repacked $name without libwayland: $outdir/$name"
