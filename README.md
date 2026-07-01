# popping-proxy

Tiny Reddit JSON proxy for the [Popping](https://example.com/popping) dashboard.

Reddit's public `.json` endpoints are throttled hard on datacenter IPs that poll on a schedule. This proxy sits in front of Reddit on your VPS so all the dashboard's per-subreddit fetches and cross-reference searches leave one IP, with one rate limiter, instead of being scattered across wherever Popping happens to be running.

**WARP inside the container.** Every Reddit request is routed through [Cloudflare WARP](https://1.1.1.1/) (the same service that powers the 1.1.1.1 DNS resolver). WARP gives the request a Cloudflare egress IP, which Reddit's CDN serves as regular residential traffic. No account, no token, no env var — the container ships with `warp-svc` baked in and the entrypoint brings it up on boot. See **How WARP works here** below.

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

Even with a real `User-Agent`, a datacenter IP gets CDN-blocked within hours — Reddit's edge starts serving a ~190KB `text/html` block page instead of the `.json` API response. The proxy routes every request through Cloudflare WARP, so the egress IP is one of Cloudflare's (which Reddit's CDN does not blocklist) instead of the VPS's. See **How WARP works here** below.

## Run it

### Pre-built image (recommended)

```sh
docker run -d --name popping-proxy \
  --restart unless-stopped \
  --cap-add=NET_ADMIN --cap-add=MKNOD \
  --device-cgroup-rule='c 10:200 rwm' \
  --sysctl net.ipv4.conf.all.src_valid_mark=1 \
  --sysctl net.ipv6.conf.all.disable_ipv6=0 \
  -p 127.0.0.1:3001:3001 \
  -e USER_AGENT="popping-proxy/1.0 (+https://github.com/<owner>/popping-proxy; contact: you@yourdomain.com)" \
  ghcr.io/<owner>/popping-proxy:latest
```

Replace `<owner>` with the GitHub user or org that hosts this repo, and `you@yourdomain.com` with a real email you monitor. The `USER_AGENT` is the only required env var — without a real contact, Reddit's anti-abuse will start 403ing the proxy within hours of polling cadence. The `--cap-add`, `--device-cgroup-rule`, and `--sysctl` flags are required for WARP to bring up its tun device and route packets correctly; the entrypoint will fail loudly without them.

The image is rebuilt automatically on every push to `main` and on every `v*` tag. Pin to a specific version with `:0.1.0` or `:sha-<short>` for reproducible deploys.

### docker-compose

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

## Config

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3001` | Inside the container. Override if 3001 is taken on the host. |
| `USER_AGENT` | `popping-proxy/1.0 (+https://example.com/popping-proxy)` | **Always override this in production** with a real contact string. Reddit's anti-abuse 403s generic UAs within hours of polling cadence. The pattern that gets the most headroom is `popping-proxy/1.0 (+<project-url>; contact: <real-email>)`. |
| `RATE_SUSTAINED` | `2` | Tokens added per second to the bucket. |
| `RATE_BURST` | `4` | Bucket cap. |
| `UPSTREAM_TIMEOUT_S` | `10` | Per-request timeout for the call to Reddit. |

The proxy also requires no Reddit-routing env var: the container ships
with Cloudflare WARP baked in, and the entrypoint refuses to start
the proxy if the WARP SOCKS5 listener isn't up. See **How WARP works
here** below.

### User-Agent recommendations

Reddit's anti-abuse throttles aggressively on UAs that look like a script. Use a real, descriptive one. Working examples:

```
# Best — real project URL + real contact email
popping-proxy/1.0 (+https://github.com/<owner>/popping-proxy; contact: you@yourdomain.com)

# Acceptable — domain you control that points at a page describing the proxy
popping-proxy/1.0 (+https://reddit.yourdomain.com; contact: you@yourdomain.com)
```

Don't use: `python-requests`, `curl/7.x`, `httpx/0.x`, generic `<app>/<version>` with no URL, or a UA with a `noreply@` email — all of these either get 429'd fast or flagged for stricter review.

### How WARP works here

[Cloudflare WARP](https://1.1.1.1/) is the same service that powers
the 1.1.1.1 DNS resolver — it's a free, no-account VPN that routes
your traffic through Cloudflare's network. The proxy image ships
with `warp-svc` and `warp-cli` installed; on first boot the
`entrypoint.sh` script:

1. Creates `/dev/net/tun` if the host hasn't injected it
   (character device, major 10 minor 200).
2. Starts an in-container dbus system bus (warp-svc's
   `power_notifier` subsystem retries dbus every 3s without one,
   filling the log).
3. Starts `warp-svc` in the background (needs `CAP_NET_ADMIN` to
   create the WireGuard tun device; `--accept-tos` to skip the
   TOS prompt on first run).
4. Waits for the daemon to respond to `warp-cli status` queries.
5. Registers the client anonymously (one-time, writes
   `/var/lib/cloudflare-warp/reg.json`).
6. Puts WARP into **proxy mode** — this opens `127.0.0.1:40000` as
   a SOCKS5 endpoint that Bun's `fetch` uses directly, without
   taking over the container's network namespace.
7. Connects and waits for the SOCKS5 socket to be listening.
8. Drops privileges to the unprivileged `bun` user and execs the
   server.

If the SOCKS5 socket never comes up, the entrypoint fails fast with
a clear log line and the container restarts. Most common causes:

- **`--cap-add=NET_ADMIN` or `--cap-add=MKNOD` missing.** Check
  `docker inspect <container> | grep CapAdd` — both `NET_ADMIN` and
  `MKNOD` should be present. Add to the compose file's `cap_add:`
  list and restart.
- **`device_cgroup_rules: ['c 10:200 rwm']` missing.** Even with
  `CAP_NET_ADMIN` and `/dev/net/tun` present, the kernel blocks
  opens on the device unless the cgroup is granted r/w/m. The
  compose file already has this; check it didn't get dropped in
  a custom override.
- **`sysctls` not set on the container.** `net.ipv4.conf.all.src_valid_mark=1`
  and `net.ipv6.conf.all.disable_ipv6=0` are required for WireGuard's
  packet routing. The compose file has them; check `docker inspect
  <container> | grep -i sysctl` to confirm they made it through.
- **TUN device not available on the host.** Some kernel configs
  and OpenVZ/LXC virtualization backends don't expose `/dev/net/tun`
  at all. Check `ls -la /dev/net/tun` on the host; the device file
  should exist. A VPS provider that virtualizes on OpenVZ typically
  can't run WARP — switch to a KVM-backed VPS (Hetzner, Racknerd
  KVM, Vultr, DigitalOcean, etc.).
- **WARP registration endpoint blocked by the host's egress
  firewall.** Rare; WARP needs to talk to `https://api.cloudflareclient.com`
  on first boot to register. If your VPS blocks outbound HTTPS to
  that host, registration will time out.

The proxy's startup log should read:

```
[entrypoint] warp-svc: starting
[entrypoint] warp-cli: registered
[entrypoint] warp-cli: connected
[entrypoint] warp-cli: socks5 ready on 127.0.0.1:40000
[entrypoint] exec: dropping to user bun, starting server.ts
popping-proxy 1.0.0 listening on :3001 (routing: WARP socks5 -> 127.0.0.1:40000)
```

## Building the image locally

```sh
docker build -t popping-proxy:dev .
docker run --rm \
  --cap-add=NET_ADMIN --cap-add=MKNOD \
  --device-cgroup-rule='c 10:200 rwm' \
  --sysctl net.ipv4.conf.all.src_valid_mark=1 \
  --sysctl net.ipv6.conf.all.disable_ipv6=0 \
  -p 127.0.0.1:3001:3001 popping-proxy:dev
```

The Dockerfile is a small `oven/bun:1.1-debian` base that installs
`cloudflare-warp` from Cloudflare's official apt repo, copies the
server file and the entrypoint script in, and runs the entrypoint
as root (warp-svc needs `CAP_NET_ADMIN`). The entrypoint brings
up WARP, then drops privileges to the unprivileged `bun` user
before exec'ing the server. The `cap_add`, `device_cgroup_rules`,
and `sysctls` lines in docker-compose (and the equivalent
`--cap-add` / `--device-cgroup-rule` / `--sysctl` flags above)
are required — without them, WARP's tun device can't be created
or the WireGuard handshake silently fails. We use the debian
base, not alpine, because WARP's `warp-svc` is a closed-source
glibc-linked binary and does not run on musl.

## License

MIT.
