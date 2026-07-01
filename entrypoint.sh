#!/bin/sh
# entrypoint.sh — bring up Cloudflare WARP in proxy mode, then exec bun.
#
# Sequence:
#   1. Start warp-svc (needs root for the WireGuard tun device)
#   2. Wait for the daemon's control socket
#   3. Register the client if not already registered
#   4. Set proxy mode (opens 127.0.0.1:40000 as a SOCKS5 endpoint —
#      this is what Bun's `fetch` will use via its `proxy:` option)
#   5. Connect
#   6. Wait for the SOCKS5 socket to be listening
#   7. Drop privs to the `bun` user, exec the bun server
#
# Why this is its own script: warp-svc needs CAP_NET_ADMIN to create
# the tun device, but the proxy itself runs as the unprivileged `bun`
# user. Doing the priv-drop in the entrypoint keeps the proxy process
# running as a non-root user, so a request-handler bug can't escape
# the container.

set -eu

log() {
    # Single-line log prefix so docker logs --tail N is readable.
    echo "[entrypoint] $(date -u +%H:%M:%S) $*"
}

fail() {
    log "FATAL: $*"
    exit 1
}

# --- 1. Start warp-svc -------------------------------------------------------
# The daemon writes its log to /var/log/cloudflare-warp/ in some
# Alpine builds and to stderr in others. Redirect both to our stdout
# so docker logs captures it. The `&` puts it in the background; we
# track the PID for the wait below.
log "warp-svc: starting"
mkdir -p /var/run/cloudflare-warp /var/lib/cloudflare-warp
warp-svc >/tmp/warp-svc.log 2>&1 &
WARP_PID=$!
log "warp-svc: pid=$WARP_PID"

# --- 2. Wait for the daemon's control socket --------------------------------
# warp-cli talks to warp-svc over a Unix socket under /var/run/.
# Poll for the socket file (with a timeout) so we don't race the
# daemon's startup.
deadline=$((SECONDS + 30))
while [ ! -S /var/run/cloudflare-warp/warp-svc.sock ] && [ $SECONDS -lt $deadline ]; do
    sleep 0.2
done
if [ ! -S /var/run/cloudflare-warp/warp-svc.sock ]; then
    log "warp-svc: control socket not up after 30s"
    log "warp-svc: --- last 20 log lines ---"
    tail -20 /tmp/warp-svc.log 2>/dev/null || true
    fail "warp-svc did not become ready"
fi
log "warp-svc: control socket ready"

# --- 3. Register the client (anonymous, one-time) ---------------------------
# /var/lib/cloudflare-warp/reg.json is written on a successful
# registration. Skip the call if the file already exists so
# container restarts don't churn the client identity.
# --accept-tos: the WARP client requires explicit TOS acceptance
# since 2024. Without it `registration new` exits non-zero with a
# "TOS not accepted" error.
if [ ! -f /var/lib/cloudflare-warp/reg.json ]; then
    log "warp-cli: registering (anonymous)"
    if ! warp-cli --accept-tos registration new; then
        log "warp-cli: registration failed"
        log "warp-cli: --- last 20 log lines ---"
        tail -20 /tmp/warp-svc.log 2>/dev/null || true
        fail "warp-cli registration new exited non-zero"
    fi
    log "warp-cli: registered"
else
    log "warp-cli: already registered (skipping)"
fi

# --- 4. Set proxy mode ------------------------------------------------------
# Proxy mode is the critical bit: it opens 127.0.0.1:40000 as a
# SOCKS5 endpoint that Bun's fetch can use directly, without
# taking over the container's network namespace. TUN mode would
# route the whole container's traffic through Cloudflare, which
# we don't want.
log "warp-cli: setting proxy mode"
warp-cli set-mode proxy >/dev/null

# --- 5. Connect -------------------------------------------------------------
log "warp-cli: connecting"
if ! warp-cli connect; then
    log "warp-cli: connect failed"
    log "warp-cli: --- last 20 log lines ---"
    tail -20 /tmp/warp-svc.log 2>/dev/null || true
    fail "warp-cli connect exited non-zero"
fi
log "warp-cli: connected"

# --- 6. Wait for the SOCKS5 socket ------------------------------------------
# The SOCKS5 listener is on 127.0.0.1:40000 once the tunnel is up.
# busybox `nc -z` does a zero-I/O connect probe and exits 0 on
# success. Poll until it succeeds or we time out.
deadline=$((SECONDS + 30))
while ! nc -z 127.0.0.1 40000 2>/dev/null; do
    if [ $SECONDS -ge $deadline ]; then
        log "warp-cli: SOCKS5 not listening on 127.0.0.1:40000 after 30s"
        log "warp-cli: --- last 20 log lines ---"
        tail -20 /tmp/warp-svc.log 2>/dev/null || true
        fail "WARP SOCKS5 proxy never came up"
    fi
    sleep 0.5
done
log "warp-cli: socks5 ready on 127.0.0.1:40000"

# --- 7. Drop privs, exec bun -----------------------------------------------
# busybox `su` is fine for this. The `exec` replaces the shell so
# the bun process becomes PID 1 inside the container and receives
# signals (SIGTERM from `docker stop`, etc.) directly.
log "exec: dropping to user bun, starting server.ts"
exec su -s /bin/sh bun -c 'exec bun run server.ts'
