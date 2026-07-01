# popping-proxy

Tiny Reddit JSON proxy for the [Popping](https://example.com/popping) dashboard.

Reddit's public `.json` endpoints are throttled hard on datacenter IPs that poll on a schedule. This proxy sits in front of Reddit on your VPS so all the dashboard's per-subreddit fetches and cross-reference searches leave one IP, with one rate limiter, instead of being scattered across wherever Popping happens to be running.

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

## Run it

### Pre-built image (recommended)

```sh
docker run -d --name popping-proxy \
  --restart unless-stopped \
  -p 127.0.0.1:3001:3001 \
  -e USER_AGENT="popping-proxy/1.0 (+https://github.com/<owner>/popping-proxy; contact: you@yourdomain.com)" \
  ghcr.io/<owner>/popping-proxy:latest
```

Replace `<owner>` with the GitHub user or org that hosts this repo, and `you@yourdomain.com` with a real email you monitor. The `USER_AGENT` is the only required env var — without a real contact, Reddit's anti-abuse will start 403ing the proxy within hours of polling cadence.

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
| `REDDIT_CLIENT_ID` | _(empty)_ | Reddit "script" app client_id. When both this and `REDDIT_CLIENT_SECRET` are set, the proxy authenticates with a `client_credentials` bearer token. Strongly recommended for any deployment on a datacenter / VPS IP — the public JSON endpoints are 403'd within minutes of polling cadence from throttled ranges. See "OAuth setup" below. |
| `REDDIT_CLIENT_SECRET` | _(empty)_ | Reddit "script" app client_secret. Pair with `REDDIT_CLIENT_ID`. |
| `RATE_SUSTAINED` | `2` | Tokens added per second to the bucket. |
| `RATE_BURST` | `4` | Bucket cap. |
| `UPSTREAM_TIMEOUT_S` | `10` | Per-request timeout for the call to Reddit. |

### OAuth setup

Datacenter / VPS IPs are 403'd by Reddit's public-JSON anti-abuse within minutes of polling cadence, regardless of User-Agent. To get reliable Reddit access from a datacenter IP, set the OAuth env vars:

1. Log in to `https://www.reddit.com/prefs/apps` and click "create another app" at the bottom of the page.
2. **name**: anything (e.g. `popping-proxy`).
3. **type**: `script`.
4. **redirect URI**: `http://localhost:8080` — required by the form but never used for `client_credentials` grant.
5. Save. The 14-char string under the app name is your `client_id`; the longer string labeled "secret" is your `client_secret`.
6. Set both as env vars in `docker-compose.yml`:
   ```yaml
   REDDIT_CLIENT_ID: "abc123def456"
   REDDIT_CLIENT_SECRET: "longer-string-from-reddit"
   ```
7. `docker compose up -d`. The proxy fetches and caches a bearer token on first request, refreshing ~5 min before the 1-hour expiry.

Under OAuth, the per-token rate limit is 60 req/min — far above the 2 req/s the proxy's token bucket allows, so the proxy's limiter is still the bottleneck. Anti-abuse throttling doesn't apply to authenticated requests.

If the OAuth token fetch fails (e.g. the `client_secret` got rotated, or Reddit's auth endpoint is having a bad day), the proxy logs the error and continues without auth — the next request retries the token fetch. The proxy never goes down because of an OAuth outage; it just falls back to the unauthenticated path (which 403s on a throttled IP, same as before OAuth was set up).

### User-Agent recommendations

Reddit's anti-abuse throttles aggressively on UAs that look like a script. Use a real, descriptive one. Working examples:

```
# Best — real project URL + real contact email
popping-proxy/1.0 (+https://github.com/<owner>/popping-proxy; contact: you@yourdomain.com)

# Acceptable — domain you control that points at a page describing the proxy
popping-proxy/1.0 (+https://reddit.yourdomain.com; contact: you@yourdomain.com)
```

Don't use: `python-requests`, `curl/7.x`, `httpx/0.x`, generic `<app>/<version>` with no URL, or a UA with a `noreply@` email — all of these either get 429'd fast or flagged for stricter review.

## Building the image locally

```sh
docker build -t popping-proxy:dev .
docker run --rm -p 127.0.0.1:3001:3001 popping-proxy:dev
```

The Dockerfile is a small `oven/bun:1.1-alpine` base that copies the server file in and runs as the unprivileged `bun` user.

## License

MIT.
