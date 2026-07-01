#!/bin/sh
# entrypoint.sh — bring up Cloudflare WARP in proxy mode, then exec bun.
#
# Sequence:
#   0. Create /dev/net/tun (WireGuard interface needs it)
#   1. Start dbus system bus (warp-svc's power_notifier talks to it;
#      not strictly required for proxy mode but suppresses a flood
#      of retry log lines that would otherwise mask real errors)
#   2. Start warp-svc (needs root for the WireGuard tun device)
#   3. Wait for the daemon's IPC to be reachable
#   4. Register the client if not already registered (anonymous)
#   5. Set proxy mode (opens 127.0.0.1:40000 as a SOCKS5 endpoint —
#      this is what Bun's `fetch` will use via its `proxy:` option)
#   6. Connect
#   7. Wait for the SOCKS5 socket to be listening
#   8. Drop privs to the `bun` user, exec the bun server
#
# Why this is its own script: warp-svc needs CAP_NET_ADMIN to create
# the tun device, but the proxy itself runs as the unprivileged `bun`
# user. Doing the priv-drop in the entrypoint keeps the proxy process
# running as a non-root user, so a request-handler bug can't escape
# the container.
#
# Reference: cmj2002/warp-docker's entrypoint pattern (the canonical
# "WARP in Docker" project). Their daemon doesn't strictly need
# dbus to function, but it spams the log without it; the mknod and
# dbus-daemon calls below are from their setup.

set -eu

log() {
    # Single-line log prefix so docker logs --tail N is readable.
    echo "[entrypoint] $(date -u +%H:%M:%S) $*"
}

fail() {
    log "FATAL: $*"
    exit 1
}

# --- 0. Create the TUN device if missing -----------------------------------
# The WireGuard interface warp-svc creates needs /dev/net/tun with
# major 10, minor 200. The Docker container may not have this node
# pre-created (the `device_cgroup_rules` line in docker-compose
# only controls access, not creation). mknod needs CAP_MKNOD; the
# `mknod` package in the Dockerfile pulls in the binary, and the
# `cap_add: [MKNOD]` in compose grants the cap.
if [ ! -e /dev/net/tun ]; then
    log "tun: /dev/net/tun missing, creating"
    mkdir -p /dev/net
    # Major 10, minor 200, character device. mknod is in /bin on
    # debian-slim (from the `mknod` apt package, an alternative
    # implementation of mknod that works in containers where the
    # busybox version is missing).
    mknod /dev/net/tun c 10 200
    chmod 600 /dev/net/tun
    log "tun: created /dev/net/tun (c 10 200)"
else
    log "tun: /dev/net/tun already present"
fi

# --- 1. Start dbus system bus ------------------------------------------------
# warp-svc's power_notifier subsystem connects to dbus on every
# 3s interval; without dbus, the log fills with retry warnings
# that mask the real error. We don't strictly need dbus for the
# proxy to work, but starting it makes the log readable when
# something else goes wrong. A system bus is overkill (we have
# one process in one container) but it's what the reference
# projects use and it works.
mkdir -p /run/dbus
rm -f /run/dbus/pid
log "dbus: starting system bus"
dbus-daemon --system --fork
log "dbus: system bus up"

# --- 2. Start warp-svc -------------------------------------------------------
# The daemon writes its log to /var/log/cloudflare-warp/ in some
# builds and to stderr in others. Redirect both to our stdout so
# docker logs captures it. The `&` puts it in the background.
# --accept-tos: TOS acceptance is required since 2024; without
# this, the daemon refuses to start cleanly.
log "warp-svc: starting"
mkdir -p /var/run/cloudflare-warp /var/lib/cloudflare-warp
warp-svc --accept-tos >/tmp/warp-svc.log 2>&1 &
WARP_PID=$!
log "warp-svc: pid=$WARP_PID"

# --- 3. Brief wait + let the next warp-cli call be the readiness probe ---
# The reference cmj2002/warp-docker entrypoint uses a fixed
# sleep here ("WARP_SLEEP=2") on the grounds that warp-cli
# itself blocks on the IPC until the daemon is ready, so the
# first real `warp-cli` call (registration new, below) acts as
# a natural readiness probe — it won't return until the daemon
# is listening, or it'll fail with a connection error.
#
# We add a 2-second sleep to avoid race conditions where warp-svc
# has started its IPC layer but the `reg.json` check below would
# otherwise see a stale or partial state. POSIX-portable.
sleep 2
log "warp-svc: grace period elapsed, proceeding"

# --- 4. Register the client (anonymous, one-time) ---------------------------
# /var/lib/cloudflare-warp/reg.json is written on a successful
# registration. Skip the call if the file already exists so
# container restarts don't churn the client identity.
# We wrap the call in `timeout 60` (from coreutils) so a hung
# daemon doesn't make the entrypoint hang forever — if the
# daemon isn't accepting IPC by 60s after the 2s grace period
# in step 3, something is structurally wrong and we should fail
# loud rather than wait indefinitely.
if [ ! -f /var/lib/cloudflare-warp/reg.json ]; then
    log "warp-cli: registering (anonymous)"
    # NOTE: --accept-tos is a GLOBAL `warp-cli` flag — it goes BEFORE
    # the subcommand (`warp-cli --accept-tos registration new`), not
    # after. clap parses it as an option on the top-level `warp-cli`
    # command; on a subcommand (`registration new`), it errors out
    # with "unexpected argument '--accept-tos'". The daemon is
    # already started with --accept-tos in step 2, but warp-cli
    # also re-checks TOS on every call as a CLI guardrail.
    if ! timeout 60 warp-cli --accept-tos registration new; then
        log "warp-cli: registration failed or timed out"
        log "warp-cli: --- last 20 log lines ---"
        tail -20 /tmp/warp-svc.log 2>/dev/null || true
        fail "warp-cli registration new did not complete within 60s"
    fi
    log "warp-cli: registered"
else
    log "warp-cli: already registered (skipping)"
fi

# --- 5. Set proxy mode ------------------------------------------------------
# Proxy mode is the critical bit: it opens 127.0.0.1:40000 as a
# SOCKS5 endpoint that Bun's fetch can use directly, without
# taking over the container's network namespace. TUN mode would
# route the whole container's traffic through Cloudflare, which
# we don't want.
#
# Note: the official warp-cli syntax changed in 2024. Newer
# versions use `warp-cli mode proxy` + `warp-cli proxy port N`,
# the older `set-mode` / `set-proxy-port` forms are deprecated.
# The 2026.6.x client we install from pkg.cloudflareclient.com
# only accepts the new form. UDP is not supported in proxy mode
# — Reddit's .json endpoints are HTTPS/TCP, so that's fine.
log "warp-cli: setting proxy mode"
warp-cli --accept-tos mode proxy >/dev/null
log "warp-cli: setting proxy port to 40000"
warp-cli --accept-tos proxy port 40000 >/dev/null

# --- 6. Connect -------------------------------------------------------------
# 60s timeout: the WARP handshake + tunnel bring-up is normally
# 5-15s but can be longer on a fresh registration. If it doesn't
# complete in 60s, the WireGuard tunnel is failing silently and
# the SOCKS5 listener will never come up.
log "warp-cli: connecting"
if ! timeout 60 warp-cli --accept-tos connect; then
    log "warp-cli: connect failed or timed out"
    log "warp-cli: --- last 20 log lines ---"
    tail -20 /tmp/warp-svc.log 2>/dev/null || true
    fail "warp-cli connect did not complete within 60s"
fi
log "warp-cli: connected"

# --- 7. Diagnose what the daemon is actually doing -------------------------
# In the 2026.6.x client the SOCKS5 listener is no longer reliably on
# 127.0.0.1:40000 in proxy mode — the tunnel is MASQUE-based now and
# the listener may be on a different port, or the proxy mode may route
# differently. Dump the daemon's view of the world so we can see what
# the next entrypoint should be polling for. This block is intentionally
# noisy; it always runs after a successful connect, before the SOCKS5
# wait fails. Remove once the right port is identified.
log "diag: --- warp-cli status ---"
warp-cli --accept-tos status 2>&1 | sed 's/^/[entrypoint] diag: /'
log "diag: --- warp-cli settings ---"
warp-cli --accept-tos settings 2>&1 | sed 's/^/[entrypoint] diag: /'
log "diag: --- listening sockets ---"
ss -tlnp 2>&1 | sed 's/^/[entrypoint] diag: /'
log "diag: --- port probes ---"
for p in 40000 40001 1080 9050 8080; do
    if nc -z 127.0.0.1 $p 2>/dev/null; then
        log "diag: port $p -> LISTENING"
    else
        log "diag: port $p -> not listening"
    fi
done
log "diag: --- last 5 warp-svc log lines ---"
tail -5 /tmp/warp-svc.log 2>/dev/null | sed 's/^/[entrypoint] diag: /' || true

# --- 8. Wait for the SOCKS5 socket ------------------------------------------
# The SOCKS5 listener is on 127.0.0.1:40000 once the tunnel is up.
# `nc -z` (from netcat-openbsd, the default on debian-slim) does a
# zero-I/O connect probe and exits 0 on success. Poll until it
# succeeds or we time out. POSIX-portable deadline arithmetic.
deadline=$(( $(date +%s) + 30 ))
while ! nc -z 127.0.0.1 40000 2>/dev/null; do
    if [ $(date +%s) -ge $deadline ]; then
        log "warp-cli: SOCKS5 not listening on 127.0.0.1:40000 after 30s"
        log "warp-cli: --- last 20 log lines ---"
        tail -20 /tmp/warp-svc.log 2>/dev/null || true
        fail "WARP SOCKS5 proxy never came up"
    fi
    sleep 0.5
done
log "warp-cli: socks5 ready on 127.0.0.1:40000"

# --- 8. Drop privs, exec bun -----------------------------------------------
# `su` from util-linux (installed by the `passwd` package, which
# the cloudflare-warp deb pulls in transitively) handles the
# user switch fine. The `exec` replaces the shell so the bun
# process becomes PID 1 inside the container and receives
# signals (SIGTERM from `docker stop`, etc.) directly.
log "exec: dropping to user bun, starting server.ts"
exec su -s /bin/sh bun -c 'exec bun run server.ts'
