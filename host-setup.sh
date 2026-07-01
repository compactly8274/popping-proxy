#!/bin/bash
# host-setup.sh — install Cloudflare WARP on the VPS host and wire up
# split-tunnel routing so ONLY the popping-proxy container's egress
# goes through the WARP tun. Everything else on the host (Caddy, NPM,
# other containers, the host's own traffic) stays direct.
#
# Run as root on the VPS, once. Idempotent — safe to re-run after
# reboots to verify the rule is still in place, but you do NOT need
# to re-run it manually; the ip rule + ip route in /etc/rc.local (or
# equivalent) will restore the split-tunnel on boot. See the bottom
# of the script for the rc.local snippet.
#
# Debian / Ubuntu. Other distros: replace the apt install with the
# package manager's equivalent — Cloudflare publishes packages for
# most major Linux distributions at https://pkg.cloudflareclient.com/

set -euo pipefail

log() { echo "[host-setup] $(date -u +%H:%M:%S) $*"; }

# ---------------------------------------------------------------------------
# 1. Install WARP
# ---------------------------------------------------------------------------
if ! command -v warp-svc >/dev/null 2>&1; then
    log "installing cloudflare-warp"
    curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
        | gpg --dearmor \
        -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com $(lsb_release -cs) main" \
        > /etc/apt/sources.list.d/cloudflare-client.list
    apt-get update
    apt-get install -y cloudflare-warp
else
    log "cloudflare-warp already installed: $(warp-svc --version 2>/dev/null || echo 'unknown version')"
fi

# ---------------------------------------------------------------------------
# 2. dbus — warp-svc's power_notifier wants a system bus
# ---------------------------------------------------------------------------
mkdir -p /run/dbus
if ! pgrep -x dbus-daemon >/dev/null 2>&1; then
    log "starting dbus system bus"
    dbus-daemon --system --fork || true
fi

# ---------------------------------------------------------------------------
# 3. Start warp-svc
# ---------------------------------------------------------------------------
mkdir -p /var/run/cloudflare-warp /var/lib/cloudflare-warp
if ! pgrep -x warp-svc >/dev/null 2>&1; then
    log "starting warp-svc"
    systemctl enable --now warp-svc 2>/dev/null || warp-svc --accept-tos &
    sleep 3
fi

# ---------------------------------------------------------------------------
# 4. Register (anonymous, one-time) and connect
# ---------------------------------------------------------------------------
if [ ! -f /var/lib/cloudflare-warp/reg.json ]; then
    log "registering with WARP (anonymous)"
    warp-cli --accept-tos registration new
fi
warp-cli --accept-tos mode warp      # TUN mode: brings up CloudflareWARP
warp-cli --accept-tos connect
sleep 5

# ---------------------------------------------------------------------------
# 5. Verify the tun is up
# ---------------------------------------------------------------------------
if ! ip link show CloudflareWARP >/dev/null 2>&1; then
    log "ERROR: CloudflareWARP tun not present after connect"
    log "diagnostic: warp-cli status"
    warp-cli --accept-tos status || true
    exit 1
fi
log "CloudflareWARP tun is up"

# ---------------------------------------------------------------------------
# 6. Split-tunnel: docker bridge subnet -> WARP tun, everything else direct
# ---------------------------------------------------------------------------
# Find the docker bridge subnet. The default is 172.17.0.0/16 (docker0) but
# docker compose often creates a project-specific bridge in 172.18-172.31.
# Match any 172.x link-scope route that mentions docker.
DOCKER_BRIDGE=$(ip route | awk '/docker/ && /scope link/ && /172/ {print $1; exit}')
if [ -z "$DOCKER_BRIDGE" ]; then
    log "ERROR: no docker bridge subnet detected in 'ip route' output"
    log "diagnostic:"
    ip route
    exit 1
fi
log "docker bridge subnet: $DOCKER_BRIDGE"

# A dedicated routing table for WARP. Table 100 is conventional for
# vendor tunnels; it's unlikely to clash with anything else on a
# minimal VPS.
ip route add default dev CloudflareWARP table 100 2>/dev/null || \
    log "WARP default route already in table 100"

# ip rule: any packet with a source IP in the docker bridge subnet
# consults table 100. Priority 100 is high enough to win over the
# default main-table lookup, but well below the kernel's reserved
# priorities (0, 32766, 32767). Caddy, the host's own traffic, and
# other containers are unaffected because their source IPs are not
# in the docker bridge subnet.
ip rule add from "$DOCKER_BRIDGE" lookup 100 priority 100 2>/dev/null || \
    log "ip rule for docker bridge already exists"

log "split-tunnel routing is up"
log ""
log "verify from host:    curl --interface eth0 https://www.cloudflare.com/cdn-cgi/trace | grep warp"
log "verify from proxy:   docker exec <container> curl -s https://www.cloudflare.com/cdn-cgi/trace | grep warp"
log ""
log "to restore this rule on boot, drop the snippet below into /etc/rc.local"
log "(or your distro's equivalent startup hook):"
log ""
cat <<'EOF'
    #!/bin/sh -e
    DOCKER_BRIDGE=$(ip route | awk '/docker/ && /scope link/ && /172/ {print $1; exit}')
    ip route add default dev CloudflareWARP table 100 2>/dev/null || true
    ip rule add from "$DOCKER_BRIDGE" lookup 100 priority 100 2>/dev/null || true
    exit 0
EOF
