#!/bin/sh
# entrypoint.sh — exec the bun server.
#
# The Cloudflare WARP tunnel is on the host (not in this container).
# A split-tunnel iptables rule on the host routes only this
# container's egress through the WARP tun, so Reddit's CDN sees
# a Cloudflare egress IP for our requests. Everything else on the
# host (Caddy, other containers, the host's own traffic) stays
# direct. See README "Host setup" for the host-side install.
#
# The container is therefore just a Bun app. No warp-svc, no dbus,
# no TUN, no caps, no sysctls — those are now host concerns.

set -eu

log() {
    # Single-line log prefix so docker logs --tail N is readable.
    echo "[entrypoint] $(date -u +%H:%M:%S) $*"
}

log "exec: starting bun server"
exec bun run server.ts
