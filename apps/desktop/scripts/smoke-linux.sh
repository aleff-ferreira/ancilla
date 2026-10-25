#!/usr/bin/env bash
# Starts the packaged app over a fresh XDG tree and requires a healthy answer from its server, then quits it the way a
# user does, through the window, and checks what that leaves: the server gone within the app's grace, server-port as it
# was, the stdin line in server.log, the owner record gone and no process of the tree left. A second copy started as
# soon as the window is asked to close, while the first may still be closing, has to come up on the same port. The caller
# provides the display (xvfb-run). With --bus the caller also provides a session bus (dbus-run-session): a second copy
# started while the first runs is then forwarded to it and exits, and one started during the close is opened again by
# the first once its server has stopped. Without --bus the app sees no bus, and the data folder lock alone keeps the
# two copies apart.
#
# usage: smoke-linux.sh [--bus] <app> [app arguments...]
set -euo pipefail

bus=false
if [ "${1:-}" = "--bus" ]; then
  bus=true
  shift
fi
cmd=("$@")
[ "${#cmd[@]}" -gt 0 ] || { echo 'usage: smoke-linux.sh [--bus] <app> [app arguments...]' >&2; exit 2; }
[ -n "${DISPLAY:-}" ] || { echo 'DISPLAY is not set: run this under xvfb-run.' >&2; exit 2; }
if $bus && [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  echo '--bus needs a session bus: run this under dbus-run-session.' >&2
  exit 2
fi

work="$(mktemp -d)"
data="$work/data/app.ancilla.desktop"
app=''
launches=0

# Every process of the app, its server and the webview's helpers included, inherits the tree's XDG_DATA_HOME.
tree_processes() {
  local pid
  for pid in $(ls /proc | grep -E '^[0-9]+$'); do
    if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "XDG_DATA_HOME=$work/data"; then
      printf '%s %s\n' "$pid" "$(cat "/proc/$pid/comm" 2>/dev/null || true)"
    fi
  done
}

app_count() {
  tree_processes | awk '$2 == "ancilla"' | wc -l
}

server_log() {
  find "$work" -name server.log -print -quit
}

cleanup() {
  local entry
  while read -r entry; do
    [ -n "$entry" ] && kill "${entry%% *}" 2>/dev/null || true
  done < <(tree_processes)
  if [ -n "$app" ]; then kill -- "-$app" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/data" "$work/config" "$work/cache"
mkdir -m 700 "$work/runtime"

fail() {
  echo "$*" >&2
  echo '--- app output'
  cat "$work"/app-*.log 2>/dev/null || true
  echo '--- server.log'
  cat "$(server_log)" 2>/dev/null || true
  echo '--- processes of the tree'
  tree_processes
  exit 1
}

# Starts the app in a session of its own over the tree, with no session bus unless the caller gave one: a runtime
# folder of its own has no bus socket, so the app registers its single-instance plugin only under --bus.
launch() {
  launches=$((launches + 1))
  local without=()
  if ! $bus; then without=(-u DBUS_SESSION_BUS_ADDRESS); fi
  env "${without[@]}" XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config" XDG_CACHE_HOME="$work/cache" \
    XDG_RUNTIME_DIR="$work/runtime" setsid "$@" > "$work/app-$launches.log" 2>&1 &
  app=$!
}

# A process that exists and is not a zombie waiting for its parent.
alive() {
  local state
  state="$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f1)"
  [ -n "$state" ] && [ "$state" != "Z" ]
}

# Waits up to $2 seconds for the process $1 to be gone, and prints how many it took.
wait_gone() {
  local pid=$1 limit=$2 waited=0
  while alive "$pid"; do
    [ "$waited" -lt $((limit * 4)) ] || return 1
    sleep 0.25
    waited=$((waited + 1))
  done
  echo $((waited / 4))
}

# Prints the version and the instance id of a healthy server on port $1.
health() {
  curl -fsS --max-time 1 "http://127.0.0.1:$1/api/health" -o "$work/health.json" 2>/dev/null \
    && node -e 'const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!h.ok || typeof h.instanceId !== "string") process.exit(1); process.stdout.write(`${h.version} ${h.instanceId}\n`);' "$work/health.json"
}

# Waits for server-port and a healthy answer on that port, setting port, version and instance; gives up early when
# the process $1 is gone. server-port is written only once the server has announced itself, so the file alone would
# nearly do, but only an answer proves the server.
wait_healthy() {
  local pid=${1:-} answer _
  for _ in $(seq 1 60); do
    if [ -f "$data/server-port" ]; then
      port="$(cat "$data/server-port")"
      if [[ "$port" =~ ^[0-9]+$ ]] && answer="$(health "$port")"; then
        version="${answer%% *}"
        instance="${answer#* }"
        return 0
      fi
    fi
    if [ -n "$pid" ] && ! alive "$pid"; then return 1; fi
    sleep 2
  done
  return 1
}

# The pid of the tree's server: started by the app with its data folder and the watchdog flag last.
server_pid() {
  local found
  found="$(pgrep -f -- "--data-dir $data --close-on-stdin-eof$" || true)"
  [ "$(printf '%s' "$found" | grep -c .)" = 1 ] || fail "expected one server started with the watchdog flag, found: ${found:-none}"
  echo "$found"
}

# Asks the app's window to close as a window manager's close button does (WM_DELETE_WINDOW). xdotool's own windowclose
# destroys the X window from outside, which GTK takes for an error and aborts on: a crash, not a quit.
close_window() {
  local id='' _
  for _ in $(seq 1 60); do
    id="$(xdotool search --onlyvisible --name 'Ancilla$' 2>/dev/null | head -n 1 || true)"
    [ -n "$id" ] && break
    sleep 1
  done
  [ -n "$id" ] || fail 'no Ancilla window appeared'
  python3 - "$id" <<'PY'
import sys
from Xlib import X, display, protocol
d = display.Display()
window = d.create_resource_object("window", int(sys.argv[1]))
message = protocol.event.ClientMessage(window=window, client_type=d.intern_atom("WM_PROTOCOLS"), data=(32, [d.intern_atom("WM_DELETE_WINDOW"), X.CurrentTime, 0, 0, 0]))
window.send_event(message)
d.flush()
PY
}

launch "${cmd[@]}"
first=$app
wait_healthy "$first" || fail 'The packaged app did not start a healthy server.'
echo "Ancilla $version started on port $port (instance $instance)"
first_instance=$instance
server="$(server_pid)"
cp "$data/server-port" "$work/port-before"

if $bus; then
  # A second copy while the first runs is forwarded to the first by the single-instance plugin and exits.
  launch "${cmd[@]}"
  forwarded=$app
  wait_gone "$forwarded" 30 > /dev/null || fail 'a second launch under the session bus did not exit'
  wait "$forwarded" || fail "the forwarded launch exited with status $?"
  wait_healthy "$first" || fail 'the first copy did not stay healthy after the forwarded launch'
  [ "$instance" = "$first_instance" ] || fail 'the forwarded launch replaced the running server'
  cmp -s "$work/port-before" "$data/server-port" || fail 'the forwarded launch rewrote server-port'
  [ "$(app_count)" = 1 ] || fail "expected one app process after the forwarded launch, found $(app_count)"
  echo 'a second launch was forwarded to the running copy'
fi

# The second copy is started as soon as the window has been asked to close. A close with no Muse host open ends in
# well under a second, so whether the second copy still meets the first is a matter of timing; which case it was is
# said below, and the end state has to be the same.
close_window
launch "${cmd[@]}"
second=$app
if alive "$first"; then echo 'the first copy was still closing when the second was started'; else echo 'the first copy had exited before the second was started'; fi
took="$(wait_gone "$server" 25)" || fail 'the server outlived the 25 seconds the app gives it'
echo "the server exited within $((took + 1)) seconds of the window closing"
wait_gone "$first" 10 > /dev/null || fail 'the app outlived its server by more than ten seconds'
grep -q 'stdin EOF received' "$(server_log)" || fail 'server.log has no stdin EOF line'
cmp -s "$work/port-before" "$data/server-port" || fail 'server-port changed across the quit'

# The copy started during the close comes up on the same port, with a server of its own. Under the bus it may have
# been forwarded to the closing copy, which then opens a fresh one after its stop: that one is not a child of this
# script, so only the port is watched.
watched=$second
if $bus; then watched=''; fi
wait_healthy "$watched" || fail 'the copy started during the close did not come up'
[ "$port" = "$(cat "$work/port-before")" ] || fail "the second copy came up on port $port instead of $(cat "$work/port-before")"
[ "$instance" != "$first_instance" ] || fail 'the second copy answered with the first server'
cmp -s "$work/port-before" "$data/server-port" || fail 'server-port changed across the second launch'
[ "$(app_count)" = 1 ] || fail "expected one app process after the second launch, found $(app_count)"
server="$(server_pid)"
echo "a copy started during the close came up on port $port (instance $instance)"

close_window
wait_gone "$server" 25 > /dev/null || fail 'the second server outlived the 25 seconds the app gives it'
# The app exits once its server has stopped; the AppImage runtime then removes what it extracted before it goes.
for _ in $(seq 1 40); do
  [ -z "$(tree_processes)" ] && break
  sleep 0.25
done
left="$(tree_processes)"
[ -z "$(printf '%s' "$left" | awk '$2 == "node" || $2 == "ancilla"')" ] || fail "the app or its server outlived the quit by more than ten seconds: $left"
[ -z "$left" ] || echo "still winding down ten seconds after the quit: $left"
[ "$(grep -c 'stdin EOF received' "$(server_log)")" = 2 ] || fail 'server.log does not show both servers closing on stdin EOF'
cmp -s "$work/port-before" "$data/server-port" || fail 'server-port changed across the second quit'
[ ! -e "$data/ancilla.owner" ] || fail 'ancilla.owner was left behind'
echo "Ancilla $version quits cleanly and keeps port $port"
