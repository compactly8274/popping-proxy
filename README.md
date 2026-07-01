# popping-proxy

Tiny Reddit JSON proxy for the [Popping](https://example.com/popping) dashboard.

Reddit's public `.json` endpoints are throttled hard on datacenter IPs that poll on a schedule. This proxy sits in front of Reddit on your VPS so all the dashboard's per-subreddit fetches and cross-reference searches leave one IP, with one rate limiter, instead of being scattered across wherever Popping happens to be running.

**Optional with newer Popping.** As of `popping@6869d74` the backend can scrape Reddit's `.json` endpoints directly with a polite per-process token bucket. The proxy is still the recommended path for any deployment on a residential / datacenter IP that Reddit's anti-abuse flags, but a small personal instance on a home IP that hasn't been throttled yet will work fine without it. Run `python /app/scripts/reddit_reachability.py` inside `popping-backend-1` to probe whether direct mode will work from your IP.

## Endpoints

| Method | Path | Upstream |
|---|---|---|
| `GET` | `/r/:sub/:listing?limit=N` | `https://www.reddit.com/r/{sub}/{listing}.json?limit=N` |
| `GET` | `/search?url=...` | `https://www.reddit.com/search.json?q=url:{url}&limit=1&sort=relevance` |
| `GET` | `/healthz` | (none — local) |

The `/r/...` endpoint returns a flat JSON list of post objects (Reddit's `data.children[]` unwrapped). The `/search` endpoint returns a list of zero or one hit, shaped as `[{permalink, num_comments}]` — Popping's `reddit_client.search_thread_by_url` takes the first element.

## Why a proxy at all

Reddit throttles unauthenticated requests to `www.reddit.com` aggressively when they come from datacenter / VPS IPs and arrive on a polling cadence. The original Popping Reddit integration assumed a third-party "Hydra" gateway would handle that, but the only popular Hydra server ([dmilin1/hydra-server](https://github.com/dmilin1/hydra-server)) is a mobile-app backend, not a Reddit scraper. This proxy is the missing piece: ~150 lines of Bun that does the one job Popping needs.

## Run it

### Pre-built image (recommended)

```sh
docker run -d --name popping-proxy \
  --restart unless-stopped \
  -p 127.0.0.1:3001:3001 \
  -e USER_AGENT="popping-proxy/1.0 (+https://example.com/popping-proxy; contact: you@example.com)" \
  ghcr.io/<owner>/popping-proxy:latest
```

Replace `<owner>` with the GitHub org / user that owns the image (the GitHub user or org that hosts this repo). The `USER_AGENT` is the only required env var — set it to a real contact email so Reddit's anti-abuse leaves the request alone.

### Build from source

```sh
git clone https://github.com/<owner>/popping-proxy.git
cd popping-proxy
docker compose up -d
```

The container listens on `127.0.0.1:3001`. Put a Caddy vhost in front. **Use a separate subdomain from any other service on the same host** — the iPhone-app Hydra keeps owning `hydra.example.com`, and the proxy takes something else like `reddit.example.com`:

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
```

## Config

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3001` | Inside the container. Override if 3001 is taken on the host. |
| `USER_AGENT` | `popping-proxy/1.0 (+https://example.com/popping-proxy)` | Reddit's anti-abuse wants a contact string. **Override this in production** with a real email — see the run-it section. |
| `RATE_SUSTAINED` | `2` | Tokens added per second to the bucket. |
| `RATE_BURST` | `4` | Bucket cap. |
| `UPSTREAM_TIMEOUT_S` | `10` | Per-request timeout for the call to Reddit. |

## Building the image locally

```sh
docker build -t popping-proxy:dev .
docker run --rm -p 127.0.0.1:3001:3001 popping-proxy:dev
```

The Dockerfile is a small `oven/bun:1.1-alpine` base that copies the server file in and runs as the unprivileged `bun` user.

## License

MIT.
