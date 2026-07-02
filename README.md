# popping-proxy

Tiny Reddit JSON proxy for the [Popping](https://example.com/popping) dashboard.

Reddit's public `.json` endpoints are throttled hard on datacenter IPs that poll on a schedule. This proxy sits in front of Reddit on your VPS so all the dashboard's per-subreddit fetches and cross-reference searches leave one IP, with one rate limiter, instead of being scattered across wherever Popping happens to be running.

**Routed through Webshare residential IPs.** Every Reddit request is sent through a [Webshare](https://webshare.io) residential proxy, so Reddit's CDN sees a rotating residential IP per request (~$3.50/month for 1GB of bandwidth, plenty for Popping's polling cadence). The proxy itself is a tiny plain Bun app — no caps, no sysctls, no WARP, no kernel-level networking. See **Webshare setup** below.

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

Even with a real `User-Agent`, a datacenter IP gets CDN-blocked within hours — Reddit's edge starts serving a ~190KB `text/html` block page instead of the `.json` API response. The proxy routes every request through Webshare's residential IP pool, so Reddit's CDN sees a rotating residential IP per request (which it doesn't blocklist). See **Webshare setup** below.

## Run it

### 1. Webshare setup (one-time per VPS)

The proxy is a plain Bun app — no host setup needed, no kernel networking, no systemd units. The only configuration is the Webshare token in the container's environment.

1. Sign up at <https://webshare.io> (rotating residential proxy, any plan).
2. From the dashboard, grab a **static proxy** token. It looks like `abc123xyz-mysecretpassword` — note the dash, not a colon.
3. Set it in the proxy container's environment as `WEBSHARE_TOKEN` (see step 2 below).

### 2. Start the container

```sh
docker run -d --name popping-proxy \
  --restart unless-stopped \
  -p 127.0.0.1:3001:3001 \
  -e USER_AGENT="popping-proxy/1.0 (+https://github.com/compactly8274/popping-proxy; contact: phil@philjnewman.com)" \
  -e WEBSHARE_TOKEN="abc123xyz-mysecretpassword" \
  ghcr.io/compactly8274/popping-proxy:latest
```

The startup log should read:

```
popping-proxy 1.0.0 listening on 0.0.0.0:3001 (routing: Webshare residential pool (token set))
```

If it reads `direct (no WEBSHARE_TOKEN; ...)`, the env var didn't reach the container — check `docker inspect`.

### 3. docker-compose (recommended)

A `docker-compose.yml` is included. It pulls the pre-built image by default; uncomment the `build: .` line if you want to compile from source.

```sh
git clone https://github.com/<owner>/popping-proxy.git
cd popping-proxy
# Edit docker-compose.yml:
#   1. replace <owner> in the image: line
#   2. set USER_AGENT to a real contact string
#   3. set WEBSHARE_TOKEN to your token from Webshare
docker compose up -d
```

The container listens on `127.0.0.1:3001`. Put a reverse proxy in front (Caddy, Traefik, nginx, or Nginx Proxy Manager). **Use a separate subdomain from any other service on the same host** — for example, if your iPhone-app Hydra occupies `hydra.example.com`, give the proxy its own like `reddit.example.com`:

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

To go back to direct mode later, clear `WEBSHARE_TOKEN` (set it to empty / unset it) and restart.

## Sanity check

```sh
curl -s https://reddit.example.com/healthz
# {"ok":true,"version":"1.0.0"}

curl -s "https://reddit.example.com/r/python/hot?limit=1" | head -c 500
# [{"id":"t3_...","title":"...","score":...,"num_comments":...,"permalink":"/r/python/comments/...","url":"...","subreddit":"python",...}]

curl -s "https://reddit.example.com/r/python/hot.json?limit=1" | head -c 500
# Same response as above; the .json suffix is optional.
```

To confirm the egress really is on a residential IP (not your VPS's), check the `x-forwarded-for` or similar from the upstream logs. Or, in a quick test, drop the `WEBSHARE_TOKEN` env var, restart, and `curl` the proxy — the response should now be Reddit's 190KB HTML block page (proving the proxy is the thing making the difference).

## Config

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3001` | Inside the container. Override if 3001 is taken on the host. |
| `USER_AGENT` | `popping-proxy/1.0 (+https://example.com/popping-proxy)` | **Always override this in production** with a real contact string. Reddit's anti-abuse 403s generic UAs within hours of polling cadence. The pattern that gets the most headroom is `popping-proxy/1.0 (+<project-url>; contact: <real-email>)`. |
| `RATE_SUSTAINED` | `2` | Tokens added per second to the bucket. |
| `RATE_BURST` | `4` | Bucket cap. |
| `UPSTREAM_TIMEOUT_S` | `10` | Per-request timeout for the call to Reddit. |
| `WEBSHARE_TOKEN` | _(unset)_ | Webshare residential proxy token, format `USERNAME-PASSWORD` (a dash, not a colon). **Required for any production deploy on a datacenter / VPS IP** — Reddit CDN-level blocks most datacenter ranges within hours of polling cadence, regardless of UA or cadence. Sign up at [webshare.io](https://webshare.io) (~$3.50/month for 1GB, plenty for Popping's polling cadence). |

### User-Agent recommendations

Reddit's anti-abuse throttles aggressively on UAs that look like a script. Use a real, descriptive one. Working examples:

```
# Best — real project URL + real contact email
popping-proxy/1.0 (+https://github.com/<owner>/popping-proxy; contact: you@yourdomain.com)

# Acceptable — domain you control that points at a page describing the proxy
popping-proxy/1.0 (+https://reddit.yourdomain.com; contact: you@yourdomain.com)
```

Don't use: `python-requests`, `curl/7.x`, `httpx/0.x`, generic `<app>/<version>` with no URL, or a UA with a `noreply@` email — all of these either get 429'd fast or flagged for stricter review.

## How the proxy works

```
+---------------------+      +-----------------+      +----------------+      +------------------+
| popping-proxy       |      | Webshare        |      | Internet       |      | Reddit           |
| (Bun, USER bun)     |      | p.webshare.io:80|      |                |      |                  |
|                     |      |                 |      |                |      |                  |
|  fetch(url, {       |  --> |  rotating       |  --> | residential    |  --> |  www.reddit.com  |
|    proxy: "http://  |      |  residential IP |      | egress         |      |  .json           |
|    user:pass@       |      |  per request    |      |                |      |                  |
|    p.webshare.io:80 |      |                 |      |                |      |                  |
|  })                 |      |                 |      |                |      |                  |
|                     |      |                 |      |                |      |                  |
+---------------------+      +-----------------+      +----------------+      +------------------+
```

Bun's `fetch` accepts a `proxy` option (string URL) for HTTP CONNECT-style proxying. When `WEBSHARE_TOKEN` is set, the proxy builds `http://USERNAME:PASSWORD@p.webshare.io:80` from the token (split on the first dash) and passes it as the `proxy` arg. Every Reddit request goes through Webshare, which picks a fresh residential IP per request. Reddit's CDN sees a residential IP, doesn't block it, and serves the `.json` API response.

The proxy itself runs in a plain Bun container, listens on `0.0.0.0:3001` inside its docker bridge, has no caps or sysctls, and runs as the unprivileged `bun` user. The only "infrastructure" beyond `docker compose up` is the Webshare token in the environment.

Why Webshare and not WARP: the 2026.6.x Cloudflare WARP daemon is MASQUE-only and doesn't expose a userspace SOCKS5 listener in proxy mode, and the tun it creates in `mode warp` doesn't get plumbed into restricted container environments (verified: `ip link` inside the container showed only `lo + eth0` after `warp-cli connect` returned Success, kernel default route still via `eth0`). Host-level WARP with a split-tunnel `ip rule` works, but adds a host-side install, daemon, and a boot-time restore step. Webshare is two env vars and a single Bun fetch option — strictly less moving parts.

## Troubleshooting

**Nginx Proxy Manager (or another reverse proxy in a separate container) returns 502 with openresty's branding.** That branding means NPM's openresty could not get any HTTP response from the proxy upstream — the proxy container isn't reachable on the network NPM can see. The proxy listens on the docker bridge network on port 3001; NPM needs to be on the same docker network and configured to use the proxy's container/service name as the upstream (not `127.0.0.1`, which is NPM's own loopback). Concretely:

```sh
# On the VPS, with both containers running:
docker network create --driver bridge shared 2>/dev/null || true
docker network connect shared popping-proxy-popping-proxy-1
docker network connect shared <your-npm-container>
# Then in the NPM web UI, change the upstream from 127.0.0.1:3001
# to <proxy-container-name>:3001 and Save.
```

Confirm with: `docker exec <npm-container> wget -qO- --timeout=5 http://<proxy-container>:3001/healthz` should return `{"ok":true,"version":"1.0.0"}`.

**Still seeing 403 from Reddit.** Check that the container actually has the token. `docker exec popping-proxy-popping-proxy-1 env | grep WEBSHARE_TOKEN` should print a line. If empty, the env var didn't reach the container — `docker compose down && docker compose up -d` after editing `docker-compose.yml`. If set, check `docker logs popping-proxy-popping-proxy-1 --tail 20` and look for `[upstream] /r/... -> 200` (good) or `-> 403` (token might be wrong / expired / out of bandwidth).

**Out of Webshare bandwidth.** The 1GB tier runs out fast if you have a hot polling loop. Check the Webshare dashboard for usage; bump to a higher tier or set `RATE_SUSTAINED` lower.

**`docker logs` shows `[req] GET /r/.../hot?...` but no `[upstream] ... -> ...` line.** The fetch is stuck — most likely a network timeout. The `UPSTREAM_TIMEOUT_S` (default 10s) will eventually trip and return a 502. Check the Webshare token (if invalid, Webshare returns 407 and Bun's fetch may hang). Try a quick `docker exec popping-proxy-popping-proxy-1 wget -qO- --timeout=10 https://www.reddit.com/r/python/hot.json?limit=1` (no proxy) to see if direct works at all from inside the container.

The image is rebuilt automatically on every push to `main` and on every `v*` tag. Pin to a specific version with `:0.1.0` or `:sha-<short>` for reproducible deploys.

## Building the image locally

```sh
docker build -t popping-proxy:dev .
docker run --rm -p 127.0.0.1:3001:3001 popping-proxy:dev
```

The Dockerfile is a small `oven/bun:1.1-debian` base that installs `curl`, `wget`, and `ca-certificates` (for the healthcheck and one-off egress diagnostics) and copies the server file and the entrypoint script in. The entrypoint is a 10-line shell script that just `exec bun run server.ts` — there's no WARP, no dbus, no TUN, no sysctls, no privilege dance.

## License

MIT.
