#!/bin/sh
# Everything in the foreground of one shell so `docker stop` actually stops it,
# and so a crashed piece takes the container down instead of leaving a desktop
# that looks alive and accepts nothing.
set -e

Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp &
XVFB=$!

# Wait for the X server rather than sleeping and hoping.
for _ in $(seq 1 50); do
  xdotool getdisplaygeometry >/dev/null 2>&1 && break
  sleep 0.1
done

fluxbox >/dev/null 2>&1 &
# -localhost: the VNC port is reachable only from inside the container, so the
# only way in is the websocket bridge below.
x11vnc -display "$DISPLAY" -forever -shared -nopw -localhost -quiet &

websockify --web=/usr/share/novnc 6080 localhost:5900 &
WS=$!

wait "$XVFB" "$WS"
