#!/usr/bin/env bash
# Inspect all shipped Linux formats, including the paths the running app will resolve.
set -euo pipefail
bundle="$(realpath "${1:?Pass the Tauri Linux bundle directory}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
shopt -s nullglob
debs=("$bundle"/deb/*.deb)
rpms=("$bundle"/rpm/*.rpm)
images=("$bundle"/appimage/*.AppImage)
test "${#debs[@]}" -eq 1
test "${#rpms[@]}" -eq 1
test "${#images[@]}" -eq 1

check_tree() {
  local root="$1"
  test -x "$root/usr/bin/ancilla"
  # System Node must stay independent of Ancilla, including when it is already installed.
  test ! -e "$root/usr/bin/node"
  test -x "$root/usr/lib/Ancilla/resources/node"
  "$root/usr/lib/Ancilla/resources/node" --version
  test -s "$root/usr/lib/Ancilla/resources/server.cjs"
  test -s "$root/usr/lib/Ancilla/resources/frontend/index.html"
  test -s "$root/usr/lib/Ancilla/resources/legal/node-LICENSE"
  local desktop="$root/usr/share/applications/Ancilla.desktop"
  test -s "$desktop"
  desktop-file-validate "$desktop"
  grep -Eq '^Exec=(/usr/bin/)?ancilla([[:space:]]|$)' "$desktop"
  grep -q '^Icon=ancilla$' "$desktop"
  test -n "$(find "$root/usr/share/icons" -type f -name 'ancilla.png' -print -quit)"
}

dpkg-deb --extract "${debs[0]}" "$work/deb"
check_tree "$work/deb"
dependencies="$(dpkg-deb --field "${debs[0]}" Depends)"
for dependency in bash curl ca-certificates libwebkit2gtk-4.1; do
  [[ "$dependencies" == *"$dependency"* ]]
done

mkdir "$work/rpm"
(cd "$work/rpm" && rpm2cpio "${rpms[0]}" | cpio -idm --quiet)
check_tree "$work/rpm"
rpm -qp --requires "${rpms[0]}" > "$work/rpm-requires"
grep -q '^/usr/bin/curl$' "$work/rpm-requires"
grep -q '^bash' "$work/rpm-requires"
grep -q '^ca-certificates' "$work/rpm-requires"

(cd "$work" && "${images[0]}" --appimage-extract >/dev/null)
check_tree "$work/squashfs-root"
echo 'Debian, RPM and AppImage contain the private runtime, server, frontend and application-menu icon.'
