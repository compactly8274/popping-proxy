# popping-proxy

Tiny Reddit JSON proxy for the [Popping](https://example.com/popping) dashboard.

Reddit's public `.json` endpoints are throttled hard on datacenter IPs that poll on a schedule. This proxy sits in front of Reddit on your VPS so all the dashboard's per-subreddit fetches and cross-reference searches leave one IP, with one rate limiter, instead of being scattered across wherever Popping happens to be running.

**Routed through Cloudflare WARP.** Every Reddit request leaves the VPS through a Cloudflare egress IP, which Reddit's CDN serves as regular residential traffic (Cloudflare is also a Reddit CDN customer, so the IP class is implicitly trusted). WARP itself runs on the host with a split-tunnel iptables rule that only affects this container's egress — Caddy, other containers, and the host's own traffic stay direct. See **Host setup** below.

**Optional with newer Popping.** As of `popping@6869d74` the backend can scrape Reddit's `.json` endpoints directly with a polite per-process token bucket. The proxy is still the recommended path for any deployment on a residential / datacenter IP that Reddit's anti-abuse flags, but a small personal instance on a home IP that hasn't been throttled yet will work fine without it. Run `python /app/scripts/reddit_reachability.py` inside `popping-backend-1` to probe whether direct mode will work from your IP.

## Endpoints

| Method | Path | Upstream |
|---|---|---|
| `GET` | `/r/:sub/:listing?limit=N` or `/r/:sub/:listing.json?limit=N` | `https://www.reddit.com/r/{sub}/{listing}.json?limit=N` |
| `GET` | `/search?url=...` | `https://www.reddit.com/search.json?q=url:{url}&limit=1&sort=relevance` |
| `GET` | `/healthz` | (none — local) |

The `/r/...` endpoint returns a flat JSON list of post objects (Reddit's `data.children[]` unwrapped). The `/search` endpoint returns a list of zero or one hit, shaped as `[{permalink, num_comments}]` — Popping's `reddit_client.search_thread_by_url` takes the first element.

## Why a proxy at all

Reddit throttles unauthenticated requests to `www.reddit.com` aggressively when they come from datacenter / VPS IPs and arrive on a polling cadence. The original Popping Reddit integration assumed a third-party "Hydra" gateway would handle that, but the only popular Hydra server ([dmilin1/hydra-server](https://github.com/dmilin1/hydra-server)) is a mobile-app backend, not a Reddit scraper. This proxy is the missing piece: ~150 lines of Bun that does the one job Popping needs.

Even with a real `User-Agent`, a datacenter IP gets CDN-blocked within hours — Reddit's edge starts serving a ~190KB `text/html` block page instead of the `.json` API response. The proxy routes every request through Cloudflare WARP, so the egress IP is one of Cloudflare's (which Reddit's CDN does not blocklist) instead of the VPS's. See **Host setup** below.

## Run it

### 1. Host setup (one-time per VPS)

WARP runs on the host, not in the container. Install it and set up a split-tunnel rule that only routes the proxy container's egress through the WARP tun. The repo ships a script for this — copy `host-setup.sh` to the VPS and run it as root:

```sh
# On the VPS
scp host-setup.sh root@<vps>:/root/host-setup.sh
ssh root@<vps> bash /root/host-setup.sh
```

The script installs the `cloudflare-warp` package from Cloudflare's apt repo, starts `dbus` and `warp-svc`, runs an anonymous registration (`/var/lib/cloudflare-warp/reg.json`), puts WARP into TUN mode, connects, verifies the `CloudflareWARP` tun device, then adds an `ip rule` + table 100 that sends only the docker bridge subnet through the WARP tun. It's idempotent and safe to re-run.

If you'd rather do it by hand, the same commands the script runs are:

```sh
# Debian / Ubuntu. Adjust for other distros.
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
    | gpg --dearmor \
    -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/cloudflare-client.list
apt-get update && apt-get install -y cloudflare-warp

# dbus: warp-svc's power_notifier wants a system bus.
mkdir -p /run/dbus
dbus-daemon --system --fork 2>/dev/null || true

# Start the daemon and register (anonymous, one-time).
systemctl enable --now warp-svc
sleep 3
if [ ! -f /var/lib/cloudflare-warp/reg.json ]; then
    warp-cli --accept-tos registration new
fi
warp-cli --accept-tos mode warp      # TUN mode: brings up the CloudflareWARP interface
warp-cli --accept-tos connect
sleep 5
ip link show CloudflareWARP         # should show a L3 device with an address

# Split-tunnel: only the docker bridge subnet's traffic goes via WARP.
# Everything else on the host (Caddy, other containers, the host's
# own traffic) stays direct.
DOCKER_BRIDGE=$(ip route | awk '/docker/ && /scope link/ && /172/ {print $1; exit}')
echo "Docker bridge subnet: $DOCKER_BRIDGE"
ip route add default dev CloudflareWARP table 100 2>/dev/null || true
ip rule add from $DOCKER_BRIDGE lookup 100 priority 100 2>/dev/null || true
```

The `ip rule` is the key bit — it says "any packet with a source IP inside the docker bridge subnet consult routing table 100, which sends everything to the WARP tun". Other containers on the same host (and the host itself) are unaffected.

Verify the host routing is working before starting the container:

```sh
curl --interface eth0 https://www.cloudflare.com/cdn-cgi/trace | grep warp
# warp=on
```

To restore the split-tunnel rule on reboot, drop the snippet the script prints at the end into `/etc/rc.local` (or your distro's equivalent startup hook).

### 2. Start the container

```sh
docker run -d --name popping-proxy \
  --restart unless-stopped \
  -p 127.0.0.1:3001:3001 \
  -e USER_AGENT="popping-proxy/1.0 (+https://github.com/<owner>/popping-proxy; contact: you@yourdomain.com)" \
  ghcr.io/<owner>/popping-proxy:latest
```

No `--cap-add`, no `--device-cgroup-rule`, no `--sysctl` — the container is a plain Bun app. WARP and all its kernel requirements live on the host.

### 3. docker-compose (recommended)

A `docker-compose.yml` is included. It pulls the pre-built image by default; uncomment the `build: .` line if you want to compile from source.

```sh
git clone https://github.com/<owner>/popping-proxy.git
cd popping-proxy
# Edit docker-compose.yml: replace <owner> in the image: line, set USER_AGENT
docker compose up -d
```

The container listens on `127.0.0.1:3001`. Put a Caddy vhost in front. **Use a separate subdomain from any other service on the same host** — for example, if your iPhone-app Hydra occupies `hydra.example.com`, give the proxy its own like `reddit.example.com`:

```caddyfile
reddit.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3001
}
```

Then point Popping at it:

```env
REDDIT_HYDRA_URL=https://reddit.example.com
```

The startup line in `popping-backend-1` should change from `reddit_client: direct mode (no proxy; throttled to 2.0 req/s, burst 4)` to `reddit_client: proxy mode (url=https://reddit.example.com, auth=no)`.

To go back to direct mode later, clear the env var (set it to empty / unset it) and restart.

## Sanity check

```sh
curl -s https://reddit.example.com/healthz
# {"ok":true,"version":"1.0.0"}

curl -s "https://reddit.example.com/r/python/hot?limit=1" | head -c 500
# [{"id":"t3_...","title":"...","score":...,"num_comments":...,"permalink":"/r/python/comments/...","url":"...","subreddit":"python",...}]

curl -s "https://reddit.example.com/r/python/hot.json?limit=1" | head -c 500
# Same response as above; the .json suffix is optional.
```

To confirm the egress really is on Cloudflare (not the VPS's own IP), check from inside the container:

```sh
docker exec popping-proxy-popping-proxy-1 \
  curl -s https://www.cloudflare.com/cdn-cgi/trace | grep -E 'warp|colo'
# warp=on,colo=<closest cloudflare dc>
```

## Config

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3001` | Inside the container. Override if 3001 is taken on the host. |
| `USER_AGENT` | `popping-proxy/1.0 (+https://example.com/popping-proxy)` | **Always override this in production** with a real contact string. Reddit's anti-abuse 403s generic UAs within hours of polling cadence. The pattern that gets the most headroom is `popping-proxy/1.0 (+<project-url>; contact: <real-email>)`. |
| `RATE_SUSTAINED` | `2` | Tokens added per second to the bucket. |
| `RATE_BURST` | `4` | Bucket cap. |
| `UPSTREAM_TIMEOUT_S` | `10` | Per-request timeout for the call to Reddit. |

The proxy needs no Reddit-routing env var. WARP runs on the host; the proxy's egress is routed through the host's WARP tun by a split-tunnel iptables rule that matches the docker bridge subnet. See **Host setup** above.

### User-Agent recommendations

Reddit's anti-abuse throttles aggressively on UAs that look like a script. Use a real, descriptive one. Working examples:

```
# Best — real project URL + real contact email
popping-proxy/1.0 (+https://github.com/<owner>/popping-proxy; contact: you@yourdomain.com)

# Acceptable — domain you control that points at a page describing the proxy
popping-proxy/1.0 (+https://reddit.yourdomain.com; contact: you@yourdomain.com)
```

Don't use: `python-requests`, `curl/7.x`, `httpx/0.x`, generic `<app>/<version>` with no URL, or a UA with a `noreply@` email — all of these either get 429'd fast or flagged for stricter review.

## How WARP routing works here

[Cloudflare WARP](https://1.1.1.1/) is the same service that powers the 1.1.1.1 DNS resolver — it's a free, no-account VPN that routes your traffic through Cloudflare's network. WARP itself runs on the host (not in the proxy container), and a split-tunnel rule on the host makes the proxy container's egress the only traffic that goes through it.

```
+---------------------+        +-------------------+        +------------------+
| popping-proxy       |        | VPS host          |        | Internet         |
| (Bun, USER bun)     |        |                   |        |                  |
|                     |        |  +-------------+  |        |                  |
|  fetch() ---+       |        |  | iptables    |  |        |                  |
|             |       |        |  | mangle:     |  |        |                  |
|             v       |  --->  |  |  match src  |  |  --->  |  Cloudflare      |
|           eth0      |        |  |  = docker   |  |        |  edge (MASQUE)   |
|             |       |        |  |  bridge --+ |  |        |       |          |
|             |       |        |  +-----------|--+  |        |       v          |
|             |       |        |              |     |        |  Reddit CDN      |
|             |       |        |              v     |        |  (sees CF IP)    |
|             |       |        |  ip rule:   table 100    |        |                  |
|             |       |        |  from $DOCKER_BRIDGE    |        |                  |
|             |       |        |  lookup 100             |        |                  |
|             |       |        |              |         |        |                  |
|             |       |        |              v         |        |                  |
|             |       |        |  ip route:  default    |        |                  |
|             |       |        |  dev CloudflareWARP    |        |                  |
|             |       |        |  table 100             |        |                  |
|             |       |        |              |         |        |                  |
|             |       |        |              v         |        |                  |
|             |       |        |  CloudflareWARP (tun)  |        |                  |
|             |       |        |       |                |        |                  |
+---------------------+        +-------------------+        +------------------+
                                Everything else on the host
                                (Caddy, other containers, host's
                                own traffic) is unaffected — only
                                packets whose source IP is in the
                                docker bridge subnet match the
                                iptables mangle rule.
```

Why host-level WARP and not in-container WARP: the 2026.6.x `warp-svc` daemon is MASQUE-only and does not bring up a userspace SOCKS5 listener in proxy mode (verified: `ss -tlnp` after `warp-cli connect` shows no listener on 40000/40001/1080/etc), and the tun it creates in `mode warp` is in the host's network namespace, not the container's. The split-tunnel pattern above puts the tun where the container's packets actually pass through (the docker bridge / host routing stack), which is the only place the policy can be expressed.

## Troubleshooting

**Still seeing 403 from Reddit.** Easiest check: run the curl from inside the container and confirm the egress IP is Cloudflare's, not your VPS's:

```sh
docker exec popping-proxy-popping-proxy-1 \
  curl -s https://www.cloudflare.com/cdn-cgi/trace | grep warp
# warp=on
```

If `warp=off`, the host's split-tunnel rule isn't matching the container's source IP. Most common causes:

- The docker bridge subnet changed (e.g. you recreated the `docker0` bridge). Re-run the `ip rule add from $DOCKER_BRIDGE …` line with the current subnet.
- You're running the container in `network_mode: host` (then the source IP is the host's, not the docker bridge's, and you don't need the iptables rule at all — the host's WARP route catches it).
- `warp-cli status` shows `Disconnected`. Run `warp-cli connect` and check `systemctl status warp-svc`.

**`warp-cli registration new` hangs.** The WARP registration endpoint (`api.cloudflareclient.com`) needs outbound HTTPS. If your VPS's egress firewall blocks it, registration times out. Open it temporarily or use a host with less restrictive egress rules.

**`warp-svc` won't start.** Check `journalctl -u warp-svc`. Common cause on minimal VPS images: missing `dbus`. Install `dbus` and start the system bus with `dbus-daemon --system --fork` before starting the daemon.

**The image is rebuilt automatically on every push to `main` and on every `v*` tag.** Pin to a specific version with `:0.1.0` or `:sha-<short>` for reproducible deploys.

## Building the image locally

```sh
docker build -t popping-proxy:dev .
docker run --rm -p 127.0.0.1:3001:3001 popping-proxy:dev
```

The Dockerfile is a small `oven/bun:1.1-debian` base that copies the server file and the entrypoint script in, and runs the entrypoint as the unprivileged `bun` user. There's no WARP, no dbus, no TUN, no sysctls — those are host concerns now.

## License

MIT.
