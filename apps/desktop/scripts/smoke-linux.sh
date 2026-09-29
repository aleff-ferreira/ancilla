#!/usr/bin/env bash
# A port file is allocated before the server starts, so require an actual healthy HTTP response.
set -euo pipefail
work="$(mktemp -d)"
app=''
cleanup() {
  if [ -n "$app" ]; then kill -- "-$app" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/data" "$work/config" "$work/cache"
XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config" XDG_CACHE_HOME="$work/cache" \
  setsid xvfb-run -a "$@" > "$work/stdout.log" 2>&1 &
app=$!
for _ in $(seq 1 60); do
  port_file="$work/data/app.ancilla.desktop/server-port"
  if [ -f "$port_file" ]; then
    port="$(cat "$port_file")"
    if [[ "$port" =~ ^[0-9]+$ ]] && curl -fsS --max-time 1 "http://127.0.0.1:$port/api/health" -o "$work/health.json" 2>/dev/null; then
      node -e 'const fs = require("fs"); const health = JSON.parse(fs.readFileSync(process.argv[1])); if (!health.ok) process.exit(1); console.log(`Ancilla ${health.version} started successfully`);' "$work/health.json"
      exit 0
    fi
  fi
  if ! kill -0 "$app" 2>/dev/null; then break; fi
  sleep 2
done
cat "$work/stdout.log"
find "$work" -name server.log -exec cat {} \;
echo 'The packaged app did not start a healthy server.' >&2
exit 1
