/**
 * Popping Reddit proxy.
 *
 * Tiny front-end for Reddit's public JSON API. Popping's per-subreddit
 * plugin and cross-reference sweep call this instead of Reddit directly
 * so:
 *   - All Reddit traffic leaves one IP (yours, on the VPS), not the
 *     dashboard's. Reddit throttles hard on datacenter IPs that poll
 *     `/r/{sub}/hot.json` on a schedule; routing it through one
 *     residential-ish box keeps the 429s down.
 *   - A single, controlled rate limiter is the only thing talking to
 *     Reddit in a given window. Easier to reason about than N
 *     independent Popping clients.
 *   - Popping's existing `reddit_client.py` works without changes —
 *     this proxy returns the same flat list shape the plugin already
 *     consumes.
 *
 * Endpoints
 * ---------
 *   GET /r/:sub/:listing?limit=N      -> Reddit `data.children[]`
 *                                          unwrapped to a flat list
 *   GET /r/:sub/:listing.json?limit=N -> same as above; the
 *                                          trailing ".json" is optional
 *                                          and ignored
 *   GET /search?url=...                   -> Reddit's own
 *                                             /search.json?q=url:...
 *                                             first result as
 *                                             {permalink, num_comments}
 *                                             OR `[]` on no match
 *   GET /healthz                          -> {ok:true, version}
 *
 * Reddit endpoints called
 * -----------------------
 *   https://www.reddit.com/r/{sub}/{listing}.json?limit=N
 *   https://www.reddit.com/search.json?q=url%3A{url}&limit=1&sort=relevance
 *
 * Why not oauth.reddit.com: the unauthenticated `.json` endpoints are
 * sufficient for read-only listing data. OAuth would require shipping
 * a client_id/secret in the proxy config and adds nothing for this
 * use case.
 *
 * Rate limiting
 * -------------
 * Token bucket, 2 req/s sustained, 4 burst. Popping's cross-ref
 * sweep fires ~50 requests in a tight loop; the limiter spreads them
 * out so Reddit sees a polite cadence rather than a burst. The
 * limiter is per-process; horizontal scaling would need a shared
 * limiter (Redis), but one proxy instance is plenty for one
 * dashboard.
 *
 * Failure handling
 * ----------------
 *   - 4xx/5xx from Reddit: returned to the client with a small
 *     JSON body `{error, upstream_status, detail}`. Popping's
 *     existing exception catch in `reddit_client._get_json`
 *     handles the rest (DEBUG log, return `[]`).
 *   - 429 from Reddit: returned as-is with a `Retry-After` header
 *     forwarded if present. Popping doesn't honor Retry-After
 *     today (next tick is on the scheduler's clock, not the
 *     response's) but the header is there for any future client
 *     that does.
 *   - Network errors / timeouts: 502 with `{error: "upstream_unreachable"}`.
 *
 * No auth
 * -------
 * Per the user's choice, the proxy is open. Reddit's own
 * unauthenticated limits are the only rate ceiling. If you later
 * want to lock this down, add an `Authorization: Bearer …` check
 * here and set `REDDIT_HYDRA_TOKEN` in Popping — `reddit_client.py`
 * already forwards the bearer header to its shared httpx client.
 */

// 3001 by default — chosen to sit one above the user's real Hydra
// service (which owns 3000). Override with PORT=… if 3001 is taken
// on the VPS. Bind to localhost via docker-compose so the only
// public entry point is the reverse proxy in front of it.
const PORT = Number(process.env.PORT ?? 3001);
// Default User-Agent. Operators should override this in production
// with a real contact email — Reddit's anti-abuse 403s generic
// UAs within hours of polling cadence. The recommended pattern is
// `popping-proxy/<version> (+<project-url>; contact: <real-email>)`.
// See the README's "User-Agent recommendations" section.
//
// The fallback below uses example.com (RFC 2606 reserved — it
// always resolves, but to a placeholder page, so it's clearly
// not a real project's domain). A fresh install that forgot to
// set USER_AGENT will at least present a UA that looks like a
// real project (URL + version), which buys more headroom than
// a library-default or empty UA. The operator still needs to
// set USER_AGENT to get the full grace period — see the README.
const DEFAULT_USER_AGENT =
  "popping-proxy/1.0 (+https://example.com/popping-proxy)";

const USER_AGENT = process.env.USER_AGENT ?? DEFAULT_USER_AGENT;
const RATE_SUSTAINED = Number(process.env.RATE_SUSTAINED ?? 2);
const RATE_BURST = Number(process.env.RATE_BURST ?? 4);
const UPSTREAM_TIMEOUT_S = Number(process.env.UPSTREAM_TIMEOUT_S ?? 10);

// All Reddit requests are routed through Cloudflare WARP via the
// tun interface that warp-svc brings up. The 2026.6.x client is
// MASQUE-based and does NOT expose a userspace SOCKS5 listener in
// proxy mode (verified: ss -tlnp shows no listener on 40000/40001/
// 1080/etc after `warp-cli connect` returns Success; only the tun
// is up). So we don't tell Bun to use a SOCKS5 proxy — we just
// `fetch` directly, and the container's default route is the
// WARP tun, which MASQUE-encapsulates everything to Cloudflare's
// edge. Reddit's CDN sees a Cloudflare egress IP, which it does
// not blocklist.
//
// Why WARP: the proxy VPS's egress IP is on Reddit's CDN blocklist
// (datacenter range, prior-tenant flag, or CGNAT reputation —
// indistinguishable from the outside). WARP gives the request a
// Cloudflare egress IP, which Reddit's CDN serves as regular
// residential traffic. Free, no account, no token. See README.

const VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Token-bucket rate limiter.
//
// Each request consumes one token. Tokens refill at RATE_SUSTAINED per
// second up to a cap of RATE_BURST. If no tokens are available the
// request is queued (a tiny in-process FIFO) and dispatched as soon as
// one frees up. We do not reject with 429 — the whole point is to be
// a polite upstream, so we shape the traffic rather than refusing it.
// ---------------------------------------------------------------------------

const bucket = { tokens: RATE_BURST, last: Date.now() };
const waiters: Array<() => void> = [];

function takeToken(): Promise<void> {
  return new Promise((resolve) => {
    const tryConsume = () => {
      const now = Date.now();
      const elapsed = (now - bucket.last) / 1000;
      bucket.tokens = Math.min(
        RATE_BURST,
        bucket.tokens + elapsed * RATE_SUSTAINED,
      );
      bucket.last = now;
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        resolve();
      } else {
        const waitMs = ((1 - bucket.tokens) / RATE_SUSTAINED) * 1000;
        setTimeout(tryConsume, Math.max(1, waitMs));
      }
    };
    tryConsume();
  });
}

// ---------------------------------------------------------------------------
// Reddit I/O
// ---------------------------------------------------------------------------

interface RedditChild {
  kind: string;
  data: Record<string, unknown>;
}

interface RedditListing {
  kind: "Listing";
  data: { children: RedditChild[] };
}

async function fetchReddit(path: string): Promise<Response> {
  const url = `https://www.reddit.com${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_S * 1000);
  // Egress goes through the WARP tun (the container's default route
  // is set to the tun by the entrypoint; warp-svc's MASQUE tunnel
  // does the encapsulation). We deliberately do NOT set `proxy` here
  // — the 2026.6.x daemon doesn't bring up a userspace SOCKS5
  // listener in proxy mode, so a SOCKS5 URL would just hang.
  const init: RequestInit = {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: ctrl.signal,
    // No follow-redirects option needed; Reddit's `.json` endpoints
    // don't redirect, and the few 30x they emit (rare) point at the
    // same host. Bun's fetch follows redirects by default which is
    // what we want here.
  };
  try {
    return await fetch(url, init);
  } finally {
    clearTimeout(timer);
  }
}

function isListing(x: unknown): x is RedditListing {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "Listing" &&
    Array.isArray((x as { data?: { children?: unknown } }).data?.children)
  );
}

function flattenListing(listing: RedditListing): Record<string, unknown>[] {
  return listing.data.children
    .map((c) => c?.data)
    .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null);
}

function searchHitShape(post: Record<string, unknown>): {
  permalink: string;
  num_comments: number;
} | null {
  const permalink = post.permalink;
  const num_comments = post.num_comments;
  if (typeof permalink !== "string" || permalink.length === 0) return null;
  if (typeof num_comments !== "number" || !Number.isFinite(num_comments)) return null;
  return { permalink, num_comments };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

function errorResponse(
  status: number,
  error: string,
  detail?: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  const body: Record<string, unknown> = { error };
  if (detail !== undefined) body.detail = detail;
  return jsonResponse(body, {
    status,
    headers: extraHeaders,
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Health probe. Cheaper than a 404 and lets the reverse proxy /
    // orchestrator know we're alive. Returns before the rate
    // limiter so a /healthz storm doesn't deplete the bucket.
    if (url.pathname === "/healthz") {
      return jsonResponse({ ok: true, version: VERSION });
    }

    // Subreddit listing.
    //   GET /r/:sub/:listing?limit=N
    //   GET /r/:sub/:listing.json?limit=N
    // :sub is one path segment; :listing is the next. The regex
    // accepts an optional trailing ".json" so both /r/python/hot
    // and /r/python/hot.json route to the same handler — clients
    // that hardcode the .json suffix (Reddit's own URL shape) get
    // the same response without a 404. The regex still rejects
    // anything else (e.g. /r/foo/bar/baz or
    // /r/foo/comments/abc) — Reddit's /r/{sub}/comments/{id}
    // endpoint isn't a listing shape and Popping never calls it.
    const subMatch = /^\/r\/([A-Za-z0-9_]{3,21})\/([a-z]+)(?:\.json)?$/.exec(url.pathname);
    if (subMatch) {
      const [, sub, listing] = subMatch;
      const limitRaw = url.searchParams.get("limit");
      const limit = Math.max(
        1,
        Math.min(100, Number(limitRaw ?? 25) || 25),
      );
      await takeToken();
      let upstream: Response;
      const reqPath = `/r/${sub}/${listing}?limit=${limit}`;
      try {
        upstream = await fetchReddit(
          `/r/${encodeURIComponent(sub)}/${encodeURIComponent(listing)}.json?limit=${limit}`,
        );
      } catch (e) {
        console.log(`[upstream] ${reqPath} -> network_error: ${e}`);
        return errorResponse(502, "upstream_unreachable", String(e));
      }
      const upCT = upstream.headers.get("content-type") ?? "?";
      const upLen = upstream.headers.get("content-length") ?? "?";
      console.log(
        `[upstream] ${reqPath} -> ${upstream.status} (ct=${upCT}, len=${upLen})`,
      );
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        const headers: Record<string, string> = {};
        const ra = upstream.headers.get("Retry-After");
        if (ra) headers["Retry-After"] = ra;
        return errorResponse(
          upstream.status,
          "upstream_error",
          text.slice(0, 500),
          headers,
        );
      }
      let parsed: unknown;
      try {
        parsed = await upstream.json();
      } catch {
        return errorResponse(502, "upstream_invalid_json");
      }
      if (!isListing(parsed)) {
        return errorResponse(502, "upstream_unexpected_shape");
      }
      return jsonResponse(flattenListing(parsed));
    }

    // Cross-reference search.
    //   GET /search?url=...
    // Reddit doesn't have a "find thread by exact URL" endpoint, but
    // its search supports the `url:` operator, which returns
    // submissions whose URL field matches. We pass the URL through
    // unchanged (Reddit's parser is lenient on percent-encoding)
    // and take the first result. limit=1 keeps the response tiny.
    if (url.pathname === "/search") {
      const target = url.searchParams.get("url");
      if (!target) {
        return errorResponse(400, "missing_url");
      }
      await takeToken();
      const q = `url:${target}`;
      let upstream: Response;
      const reqPath = `/search?url=${target.slice(0, 80)}`;
      try {
        upstream = await fetchReddit(
          `/search.json?q=${encodeURIComponent(q)}&limit=1&sort=relevance&restrict_sr=&type=link`,
        );
      } catch (e) {
        console.log(`[upstream] ${reqPath} -> network_error: ${e}`);
        return errorResponse(502, "upstream_unreachable", String(e));
      }
      const upCT = upstream.headers.get("content-type") ?? "?";
      const upLen = upstream.headers.get("content-length") ?? "?";
      console.log(
        `[upstream] ${reqPath} -> ${upstream.status} (ct=${upCT}, len=${upLen})`,
      );
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        return errorResponse(upstream.status, "upstream_error", text.slice(0, 500));
      }
      let parsed: unknown;
      try {
        parsed = await upstream.json();
      } catch {
        return errorResponse(502, "upstream_invalid_json");
      }
      if (!isListing(parsed)) {
        return errorResponse(502, "upstream_unexpected_shape");
      }
      const flat = flattenListing(parsed);
      const hit = flat.length > 0 ? searchHitShape(flat[0]) : null;
      // Return a list (possibly empty) for a uniform shape — Popping
      // expects `data` to be a list and pulls `data[0]`. An empty
      // list means "no match found", which the caller treats as
      // "no cross-ref".
      return jsonResponse(hit ? [hit] : []);
    }

    return errorResponse(404, "not_found", { path: url.pathname });
  },
});

console.log(
  `popping-proxy ${VERSION} listening on :${server.port} (routing: WARP tun -> Cloudflare MASQUE egress)`,
);
