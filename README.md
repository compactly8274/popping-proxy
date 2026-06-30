# popping-proxy

Tiny Reddit JSON proxy for the [Popping](https://github.com/compactly8274/popping) dashboard.

Reddit's public `.json` endpoints are throttled hard on datacenter IPs that poll on a schedule. This proxy sits in front of Reddit on your VPS so all the dashboard's per-subreddit fetches and cross-reference searches leave one IP, with one rate limiter, instead of being scattered across wherever Popping happens to be running.

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

```sh
docker compose up -d
```

The container listens on `127.0.0.1:3001` (chosen to sit one above your existing Hydra service, which owns 3000). Put a Caddy vhost in front:

```caddyfile
hydra.pancakefarts.site {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3001
}
```

Then point Popping at it:

```env
REDDIT_HYDRA_URL=https://hydra.pancakefarts.site
```

The startup line in `popping-backend-1` should change from `reddit_client: disabled` to `reddit_client: configured (url=https://hydra.pancakefarts.site, auth=no)`.

## Sanity check

```sh
curl -s https://hydra.pancakefarts.site/healthz
# {"ok":true,"version":"1.0.0"}

curl -s "https://hydra.pancakefarts.site/r/python/hot?limit=1" | head -c 500
# [{"id":"t3_...","title":"...","score":...,"num_comments":...,"permalink":"/r/python/comments/...","url":"...","subreddit":"python",...}]
```

## Config

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3001` | One above your real Hydra on 3000. Override if 3001 is taken. |
| `USER_AGENT` | `popping-proxy/1.0 (+https://github.com/compactly8274/popping)` | Reddit's anti-abuse wants a contact string. Put your email in here. |
| `RATE_SUSTAINED` | `2` | Tokens added per second to the bucket. |
| `RATE_BURST` | `4` | Bucket cap. |
| `UPSTREAM_TIMEOUT_S` | `10` | Per-request timeout for the call to Reddit. |

## License

MIT.
