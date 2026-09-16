/**
 * popping-proxy — Reddit .rss/.json relay, v1.3.0
 *
 * Endpoints:
 *   GET /healthz
 *   GET /r/{sub}/{listing}[.rss|.json]?limit=N      (listings)
 *   GET /r/{sub}/comments/{id}[/{slug}][.rss|.json] (comment threads)
 *   GET /search?url=...                             (cross-reference search)
 *
 * Resilience:
 *   - In-memory response cache (CACHE_TTL_S). Serve-stale-on-error.
 *   - Token bucket — requests WAIT for a token, never rejected.
 *   - Fallback chain: if upstream Reddit returns a transient error
 *     (403 block or 429 rate-limit) for a COMMENT .rss request AND
 *     FALLBACK_PROXY_URL is set, the request is forwarded ONCE to the
 *     fallback hop. No retry loops. FALLBACK_COOLDOWN_MS prevents
 *     hammering the fallback hop when it is itself throttling.
 *   - Honest error classification: 403 block vs 429 rate-limit are
 *     distinguished, logged, and surfaced via X-Error-Kind header plus
 *     a Retry-After (real or estimated) so the backend/UI can tell the
 *     user "blocked" from "try again shortly".
 */

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";
const DEFAULT_USER_AGENT =
  "popping-proxy/1.0 (+https://github.com/compactly8274/popping-proxy)";

const USER_AGENT = process.env.USER_AGENT ?? DEFAULT_USER_AGENT;
const RATE_SUSTAINED = Number(process.env.RATE_SUSTAINED ?? 0.1);
const RATE_BURST = Number(process.env.RATE_BURST ?? 3);
const UPSTREAM_TIMEOUT_S = Number(process.env.UPSTREAM_TIMEOUT_S ?? 15);
const CACHE_TTL_S = Number(process.env.CACHE_TTL_S ?? 300);
const STALE_MAX_S = Number(process.env.STALE_MAX_S ?? 3600);

// Fallback hop (e.g. RackNerd proxy reachable over the wg tunnel).
// Unset => no fallback, identical behavior to v1.2.0.
const FALLBACK_PROXY_URL = (process.env.FALLBACK_PROXY_URL ?? "").trim();
const FALLBACK_TIMEOUT_S = Number(process.env.FALLBACK_TIMEOUT_S ?? 20);
// Cooldown after the fallback hop returns a throttling error (429/5xx).
// Prevents this proxy from hammering the fallback into its own block.
const FALLBACK_COOLDOWN_MS = Number(process.env.FALLBACK_COOLDOWN_MS ?? 15000);

const VERSION = "1.3.0";

// ---------------------------------------------------------------------------
// Token bucket — requests wait for a token; the bucket never rejects.
// ---------------------------------------------------------------------------
const bucket = { tokens: RATE_BURST, last: Date.now() };

function takeToken(): Promise<void> {
  return new Promise((resolve) => {
    const tryConsume = () => {
      const now = Date.now();
      const elapsed = (now - bucket.last) / 1000;
      bucket.tokens = Math.min(RATE_BURST, bucket.tokens + elapsed * RATE_SUSTAINED);
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
// Response cache — LRU-ish, success-only, stale-serve on upstream errors.
// ---------------------------------------------------------------------------
type CacheEntry = { status: number; ct: string | null; body: string; at: number };
const cache = new Map<string, CacheEntry>();
const CACHE_MAX_ENTRIES = 300;

function cacheGet(key: string): CacheEntry | null {
  const e = cache.get(key);
  if (!e) return null;
  cache.delete(key);
  cache.set(key, e); // LRU touch
  return e;
}

function cachePut(key: string, entry: CacheEntry): void {
  cache.set(key, entry);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Error classification — distinguish Reddit's hard block from rate-limit.
// ---------------------------------------------------------------------------
function classifyError(status: number, bodyFragment?: string): "block" | "rate_limit" | "other" {
  if (status === 429) return "rate_limit";
  if (status === 403) {
    const b = (bodyFragment ?? "").toLowerCase();
    if (b.includes("blocked by network security") || b.includes("network security")) {
      return "block";
    }
    return "other";
  }
  if (status >= 500) return "rate_limit"; // transient server error, retryable
  return "other";
}

// Parse Retry-After (seconds or HTTP-date). Returns seconds, or null.
function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n;
  // HTTP-date form.
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return Math.max(0, Math.ceil((t - Date.now()) / 1000));
  return null;
}

// Estimate a wait when Reddit didn't send Retry-After. Scales with cooldown.
function estimateRetryAfter(kind: "block" | "rate_limit" | "other"): number {
  if (kind === "block") return 60; // hard block: retry no sooner than a minute
  if (kind === "rate_limit") return 30;
  return 15;
}

// ---------------------------------------------------------------------------
// Upstream fetch (primary: this host's egress)
// ---------------------------------------------------------------------------
async function fetchReddit(path: string): Promise<Response> {
  const url = `https://www.reddit.com${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_S * 1000);
  try {
    return await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, application/json;q=0.8, */*;q=0.7",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fallback fetch — forward the SAME path to a fallback hop ONCE.
// ---------------------------------------------------------------------------
let fallbackCooldownUntil = 0;

async function fetchViaFallback(pathWithQuery: string, logTag: string): Promise<Response | null> {
  if (!FALLBACK_PROXY_URL) return null;
  if (Date.now() < fallbackCooldownUntil) {
    console.log(`[fallback] skipped (cooldown) ${logTag}`);
    return errorResponse(503, "fallback_cooldown");
  }
  const url = `${FALLBACK_PROXY_URL}${pathWithQuery}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FALLBACK_TIMEOUT_S * 1000);
  console.log(`[fallback] try ${url}`);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, application/json;q=0.8, */*;q=0.7",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    const status = resp.status;
    const ct = resp.headers.get("content-type") ?? "?";
    const len = resp.headers.get("content-length") ?? "?";
    console.log(`[fallback] ${logTag} -> ${status} (ct=${ct}, len=${len})`);
    if (status === 429 || status >= 500) {
      // Fallback hop is itself throttling — back off so we don't flag its ASN.
      fallbackCooldownUntil = Date.now() + FALLBACK_COOLDOWN_MS;
      const kind = status === 429 ? "rate_limit" : "other";
      const ra = parseRetryAfter(resp.headers.get("Retry-After")) ?? estimateRetryAfter(kind);
      const body = await resp.text().catch(() => "");
      return errorResponse(status, "upstream_error", body.slice(0, 500), {
        "X-Error-Kind": kind,
        "Retry-After": String(ra),
      });
    }
    // Pass the fallback body through verbatim (it serves the same path shape).
    const body = await resp.text();
    return new Response(body, {
      status,
      headers: {
        "Content-Type": ct ?? "application/atom+xml; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Fallback": "true",
      },
    });
  } catch (e) {
    console.log(`[fallback] ${logTag} -> network_error: ${e}`);
    return null; // fallback failed too; caller returns original error
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Response helpers
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
  return jsonResponse(body, { status, headers: extraHeaders });
}

function serveBody(
  body: string,
  upstreamCt: string | null,
  viaCache: boolean,
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": upstreamCt ?? "application/atom+xml; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Cache": viaCache ? "hit" : "miss",
    },
  });
}

// ---------------------------------------------------------------------------
// Shared upstream path: token -> fetch -> cache/stale-serve.
// For comment .rss requests, a single fallback attempt runs on transient errors.
// ---------------------------------------------------------------------------
async function fetchWithResilience(
  cacheKey: string,
  upstreamPath: string,
  logTag: string,
  opts: { allowFallback?: boolean } = {},
): Promise<Response> {
  const cached = cacheGet(cacheKey);
  const now = Date.now();

  // Fresh cache hit: serve immediately, no upstream call, no token.
  if (cached && (now - cached.at) / 1000 < CACHE_TTL_S) {
    console.log(`[cache] fresh ${logTag}`);
    return serveBody(cached.body, cached.ct, true);
  }

  await takeToken();
  let upstream: Response;
  try {
    upstream = await fetchReddit(upstreamPath);
  } catch (e) {
    console.log(`[upstream] ${logTag} -> network_error: ${e}`);
    if (cached && (now - cached.at) / 1000 < STALE_MAX_S) {
      console.log(`[cache] stale-serve after network_error ${logTag}`);
      return serveBody(cached.body, cached.ct, true);
    }
    return errorResponse(502, "upstream_unreachable", String(e));
  }

  const upCT = upstream.headers.get("content-type");
  const upLen = upstream.headers.get("content-length") ?? "?";
  console.log(`[upstream] ${logTag} -> ${upstream.status} (ct=${upCT ?? "?"}, len=${upLen})`);

  if (upstream.ok) {
    const body = await upstream.text();
    cachePut(cacheKey, { status: 200, ct: upCT, body, at: Date.now() });
    return serveBody(body, upCT, false);
  }

  // Transient upstream failure: 429 / 5xx — serve stale if we have it.
  if (
    (upstream.status === 429 || upstream.status >= 500) &&
    cached &&
    (now - cached.at) / 1000 < STALE_MAX_S
  ) {
    console.log(`[cache] stale-serve after ${upstream.status} ${logTag}`);
    return serveBody(cached.body, cached.ct, true);
  }

  // Read the error body to classify it.
  const text = await upstream.text().catch(() => "");
  const kind = classifyError(upstream.status, text);
  const retryAfter = parseRetryAfter(upstream.headers.get("Retry-After")) ?? estimateRetryAfter(kind);
  const headers: Record<string, string> = {
    "X-Error-Kind": kind,
    "Retry-After": String(retryAfter),
  };
  if (kind === "block") {
    console.log(`[block] ${logTag} -> Reddit network-security block (403)`);
  } else if (kind === "rate_limit") {
    console.log(`[rate-limit] ${logTag} -> retry-after ~${retryAfter}s`);
  }

  // OPTIONAL: single fallback attempt for comment .rss requests.
  // Only triggers on transient errors (block/rate-limit), never loops.
  if (opts.allowFallback && FALLBACK_PROXY_URL && (kind === "block" || kind === "rate_limit")) {
    const u = new URL(`https://www.reddit.com${upstreamPath}`);
    const pathWithQuery = u.pathname + u.search;
    const fallbackResp = await fetchViaFallback(pathWithQuery, logTag);
    if (fallbackResp && fallbackResp.status !== 503) {
      return fallbackResp;
    }
  }

  return errorResponse(upstream.status, "upstream_error", text.slice(0, 500), headers);
}

// ---------------------------------------------------------------------------
// Listing shapes (JSON mode)
// ---------------------------------------------------------------------------
interface RedditChild {
  kind: string;
  data: Record<string, unknown>;
}
interface RedditListing {
  kind: "Listing";
  data: { children: RedditChild[] };
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

function parseCommentPath(
  pathname: string,
): { sub: string; id: string; suffix: "json" | "rss" | null } | null {
  // Accept /r/{sub}/comments/{id}[/{slug}...][.rss|.json]
  // and also /r/{sub}/comments/{id}[/{slug}...]/[.rss|.json]
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[0] !== "r" || parts[2] !== "comments") return null;
  const sub = parts[1];
  const id = parts[3];
  if (!/^[A-Za-z0-9_]{3,21}$/.test(sub) || !/^[A-Za-z0-9_]+$/.test(id)) return null;

  let suffix: "json" | "rss" | null = null;
  // If the last segment is .rss/.json (or rss/json), treat it as suffix.
  const last = parts[parts.length - 1];
  if (last === ".rss" || last === "rss") {
    suffix = "rss";
    parts.pop();
  } else if (last === ".json" || last === "json") {
    suffix = "json";
    parts.pop();
  }
  // Any parts after id (slugs) are ignored.
  return { sub, id, suffix };
}
// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    console.log(`[req] ${req.method} ${url.pathname}${url.search}`);

    if (url.pathname === "/healthz") {
      return jsonResponse({ ok: true, version: VERSION });
    }

    // Accept both /slug.rss and /slug/.rss by keeping the slash before extension.
    const normalized = url.pathname;

    const listingMatch =
      /^\/r\/([A-Za-z0-9_]{3,21})\/([a-z]+)(?:\.(json|rss))?$/.exec(normalized);
    const commentPath = parseCommentPath(normalized);

    // Listings (non-comment)
    if (listingMatch && !commentPath) {
      const [, sub, listing, suffix] = listingMatch;
      const isRss = suffix === "rss";
      const limitRaw = url.searchParams.get("limit");
      const limit = Math.max(1, Math.min(100, Number(limitRaw ?? 25) || 25));
      const upstreamPath = `/r/${encodeURIComponent(sub)}/${encodeURIComponent(listing)}.${isRss ? "rss" : "json"}?limit=${limit}`;
      const cacheKey = `L ${upstreamPath}`;
      const resp = await fetchWithResilience(cacheKey, upstreamPath, `/r/${sub}/${listing}.${isRss ? "rss" : "json"}?limit=${limit}`);
      if (resp.status !== 200) return resp;
      if (isRss) return resp;
      const ct = resp.headers.get("Content-Type") ?? "";
      if (!ct.includes("json")) return resp;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await resp.text());
      } catch {
        return errorResponse(502, "upstream_invalid_json");
      }
      if (!isListing(parsed)) {
        return errorResponse(502, "upstream_unexpected_shape");
      }
      return jsonResponse(flattenListing(parsed));
    }

    // Comment threads
    if (commentPath) {
      const { sub, id, suffix } = commentPath;
      const isRss = suffix === "rss";
      const upstreamPath = `/r/${encodeURIComponent(sub)}/comments/${encodeURIComponent(id)}.${isRss ? "rss" : "json"}`;
      const cacheKey = `T ${upstreamPath}`;
      // Fallback chain engaged for comment .rss only (the path where a
      // different egress IP can realistically help).
      return await fetchWithResilience(
        cacheKey,
        upstreamPath,
        `/r/${sub}/comments/${id}.${isRss ? "rss" : "json"}`,
        { allowFallback: isRss },
      );
    }

    // Cross-reference search.
    if (url.pathname === "/search") {
      const target = url.searchParams.get("url");
      if (!target) {
        return errorResponse(400, "missing_url");
      }
      const q = `url:${target}`;
      const upstreamPath = `/search.json?q=${encodeURIComponent(q)}&limit=1&sort=relevance&restrict_sr=&type=link`;
      const cacheKey = `S ${upstreamPath}`;
      const resp = await fetchWithResilience(cacheKey, upstreamPath, `/search?url=${target.slice(0, 80)}`);
      if (resp.status !== 200) return resp;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await resp.text());
      } catch {
        return errorResponse(502, "upstream_invalid_json");
      }
      if (!isListing(parsed)) {
        return errorResponse(502, "upstream_unexpected_shape");
      }
      const flat = flattenListing(parsed);
      const hit = flat.length > 0 ? searchHitShape(flat[0]) : null;
      return jsonResponse(hit ? [hit] : []);
    }

    return errorResponse(404, "not_found", { path: url.pathname });
  },
});

const route = FALLBACK_PROXY_URL
  ? `direct + cache + stale-on-error + fallback(${FALLBACK_PROXY_URL})`
  : "direct (residential egress) + cache + stale-on-error";
console.log(
  `popping-proxy ${VERSION} listening on ${HOST}:${server.port} (routing: ${route}; ttl=${CACHE_TTL_S}s, stale-max=${STALE_MAX_S}s, rate=${RATE_SUSTAINED}/s burst=${RATE_BURST})`,
);
