# A whole computer that isn't yours.
#
# This is the default surface for OS-level work (PLAN Phase 4): the bot gets a
# Linux desktop in a container, watched live over noVNC in the app, while you
# keep using your own machine. The same shadow-vs-on-screen idea as the browser
# surfaces, extended to a full desktop.
#
# Deliberately small parts: an X server with no physical display, a window
# manager that does nothing clever, a VNC server, and the websocket bridge the
# app's preview pane speaks. Input arrives through xdotool over `docker exec`,
# which keeps every decision on the host — the container has no idea what a
# gate is, and nothing inside it can approve anything.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:0 \
    SCREEN=1280x900x24

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox xdotool scrot \
      novnc websockify \
      chromium \
      fonts-dejavu-core \
      xterm \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The bot's own state, mounted from its bot directory so a login survives
# between tasks the same way the browser profile does.
RUN mkdir -p /home/bot && useradd -d /home/bot bot && chown -R bot /home/bot
VOLUME ["/home/bot"]

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

# 6080 is noVNC over HTTP, which is what the desktop app embeds. 5900 stays
# unpublished by default: one way in is enough.
EXPOSE 6080

USER bot
WORKDIR /home/bot
CMD ["/usr/local/bin/start.sh"]
