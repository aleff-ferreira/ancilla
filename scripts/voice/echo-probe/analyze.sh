#!/usr/bin/env bash
# Runs analyze.mjs in WSL with Node 22 and the shipped sherpa engines.
#   usage: analyze.sh <recordings-dir> [--no-engines] [--selftest]
# From Windows (PowerShell):  $env:MSYS_NO_PATHCONV=1; wsl.exe -d Ubuntu -- bash -l /home/<you>/.../analyze.sh /mnt/c/.../echo-probe
source ~/.nvm/nvm.sh >/dev/null 2>&1
export LD_LIBRARY_PATH="${VOICE_RUNTIME_DIR:-$HOME/voice-lab}/node_modules/sherpa-onnx-linux-x64:${LD_LIBRARY_PATH:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --no-warnings "$here/analyze.mjs" "$@"
