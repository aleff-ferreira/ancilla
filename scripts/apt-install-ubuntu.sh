#!/usr/bin/env bash
# Installs Ubuntu packages on GitHub runners without hanging for an hour when Canonical's ubuntu.com DNS or
# azure.archive.ubuntu.com fails to resolve: falls back to the Linux Kernel Organization's official Ubuntu
# mirror (https://mirrors.edge.kernel.org/ubuntu/), which is signed by the same Ubuntu archive GPG keyring.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: bash scripts/apt-install-ubuntu.sh <package...>" >&2
  exit 2
fi

CODENAME="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-jammy}")"
FALLBACK_MIRROR="https://mirrors.edge.kernel.org/ubuntu/"

probe() {
  curl -fsSI --connect-timeout 4 --max-time 6 "$1" >/dev/null 2>&1
}

if ! probe "http://azure.archive.ubuntu.com/ubuntu/dists/${CODENAME}/InRelease" || \
   ! probe "https://security.ubuntu.com/ubuntu/dists/${CODENAME}-security/InRelease"; then
  echo "note: ubuntu.com mirror unreachable from this runner; switching apt Ubuntu sources to ${FALLBACK_MIRROR} (GPG keyring verification unchanged)" >&2
  if [ -f /etc/apt/apt-mirrors.txt ]; then
    printf '%s\n' "$FALLBACK_MIRROR" | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
  fi
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [ -f "$f" ] || continue
    sudo sed -i -E \
      -e "s|mirror\\+file:/etc/apt/apt-mirrors\\.txt|${FALLBACK_MIRROR%/}|g" \
      -e "s|https?://([a-z0-9.-]+\\.)?ubuntu\\.com/ubuntu/?|${FALLBACK_MIRROR}|g" \
      "$f"
  done
fi

APT_OPTS=(
  -o Acquire::Retries=3
  -o Acquire::http::Timeout=15
  -o Acquire::https::Timeout=15
)

sudo DEBIAN_FRONTEND=noninteractive apt-get "${APT_OPTS[@]}" update
sudo DEBIAN_FRONTEND=noninteractive apt-get "${APT_OPTS[@]}" install -y "$@"
