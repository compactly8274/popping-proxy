/** 
 * PATCHED: Popping Reddit proxy with support for comment thread endpoints.
 *
 * This version adds support for Reddit comment thread RSS endpoints in addition
 * to the original subreddit listing endpoints.
 */

const PORT = Number(process.env.PORT ?? 3001);
const DEFAULT_USER_AGENT =
  "popping-proxy/1.0 (+https://example.com/popping-proxy)";

const USER_AGENT = process.env.USER_AGENT ?? DEFAULT_USER_AGENT;
const RATE_SUSTAINED = Number(process.env.RATE_SUSTAINED ?? 2);
const RATE_BURST = Number(process.env.RATE_BURST ?? 4);
const UPSTREAM_TIMEOUT_S = Number(process.env.UPSTREAM_TIMEOUT_S ?? 10);

// Webshare residential proxy pool
const WEBSHARE_TOKEN=process.env.WEBSHARE_TOKEN ?? "";
const WEBSHARE_PROXY_URL = WEBSHARE_TOKEN
  ? (() => {
      const dash = WEBSHARE_TOKEN.indexOf("-");
      if (dash < 1 || dash === WEBSHARE_TOKEN.length - 1) return null;
      const user = WEBSHARE_TOKEN.slice(0, dash);
      const pass = WEBSHARE_TOKEN.slice(dash + 1);
      return `http://${user}:${pass}@p.webshare.io:80`;
    })()
  : null;

const VERSION = "1.1.0";

// Token-bucket rate limiter.
const bucket = { tokens: RATE_BURST, last: Date.now() };

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

async function fetchReddit(path: string): Promise<Response> {
  const url = `https://www.reddit.com${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_S * 1000);
  const init: RequestInit & { proxy?: string } = {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: ctrl.signal,
  };
  if (WEBSHARE_PROXY_URL) {
    init.proxy = WEBSHARE_PROXY_URL;
  }
  try {
    return await fetch(url, init);
  } finally {
    clearTimeout(timer);
  }
}

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
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    console.log(`[req] ${req.method} ${url.pathname}${url.search}`);

    if (url.pathname === "/healthz") {
      return jsonResponse({ ok: true, version: VERSION });
    }

    // Handle subreddit listing endpoints
    const listingMatch = /^\/r\/([A-Za-z0-9_]{3,21})\/([a-z]+)(?:\.(json|rss))?$/.exec(url.pathname);
    
    // Handle comment thread endpoints (NEW functionality)
    const commentMatch = /^\/r\/([A-Za-z0-9_]{3,21})\/comments\/([A-Za-z0-9_]+)(?:\/[^\/]*)?\/?(?:\.(json|rss))?$/.exec(url.pathname);
    
    if (listingMatch) {
      const [, sub, listing, suffix] = listingMatch;
      const format: "json" | "rss" = suffix === "rss" ? "rss" : "json";
      const limitRaw = url.searchParams.get("limit");
      const limit = Math.max(1, Math.min(100, Number(limitRaw ?? 25) || 25));
      await takeToken();
      let upstream: Response;
      const reqPath = `/r/${sub}/${listing}.${format}?limit=${limit}`;
      try {
        upstream = await fetchReddit(
          `/r/${encodeURIComponent(sub)}/${encodeURIComponent(listing)}.${format}?limit=${limit}`,
        );
      } catch (e) {
        console.log(`[upstream] ${reqPath} -> network_error: ${e}`);
        return errorResponse(502, "upstream_unreachable", String(e));
      }
      const upCT = upstream.headers.get("content-type") ?? "?";
      const upLen = upstream.headers.get("content-length") ?? "?";
      console.log(`[upstream] ${reqPath} -> ${upstream.status} (ct=${upCT}, len=${upLen})`);
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        const headers: Record<string, string> = {};
        const ra = upstream.headers.get("Retry-After");
        if (ra) headers["Retry-After"] = ra;
        return errorResponse(upstream.status, "upstream_error", text.slice(0, 500), headers);
      }
      if (format === "rss") {
        const body = await upstream.text();
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": upstream.headers.get("content-type") ?? "application/atom+xml; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
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
    
    // Handle comment thread endpoints (NEW functionality)
    if (commentMatch) {
      const [, sub, id, suffix] = commentMatch;
      const format: "json" | "rss" = suffix === "rss" ? "rss" : "json";
      await takeToken();
      let upstream: Response;
      const reqPath = `/r/${sub}/comments/${id}.${format}`;
      try {
        // Fetch the comment thread from Reddit
        upstream = await fetchReddit(
          `/r/${encodeURIComponent(sub)}/comments/${encodeURIComponent(id)}.${format}`,
        );
      } catch (e) {
        console.log(`[upstream] ${reqPath} -> network_error: ${e}`);
        return errorResponse(502, "upstream_unreachable", String(e));
      }
      const upCT = upstream.headers.get("content-type") ?? "?";
      const upLen = upstream.headers.get("content-length") ?? "?";
      console.log(`[upstream] ${reqPath} -> ${upstream.status} (ct=${upCT}, len=${upLen})`);
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        const headers: Record<string, string> = {};
        const ra = upstream.headers.get("Retry-After");
        if (ra) headers["Retry-After"] = ra;
        return errorResponse(upstream.status, "upstream_error", text.slice(0, 500), headers);
      }
      if (format === "rss") {
        const body = await upstream.text();
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": upstream.headers.get("content-type") ?? "application/atom+xml; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
      let parsed: unknown;
      try {
        parsed = await upstream.json();
      } catch {
        return errorResponse(502, "upstream_invalid_json");
      }
      
      // For comment threads, the response structure is different
      if (Array.isArray(parsed) && parsed.length > 0) {
        return jsonResponse(parsed);
      } else if (parsed && typeof parsed === "object") {
        return jsonResponse(parsed);
      } else {
        return errorResponse(502, "upstream_unexpected_shape");
      }
    }

    // Cross-reference search.
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
      console.log(`[upstream] ${reqPath} -> ${upstream.status} (ct=${upCT}, len=${upLen})`);
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
      return jsonResponse(hit ? [hit] : []);
    }

    return errorResponse(404, "not_found", { path: url.pathname });
  },
});

// Helper functions
function isListing(x: unknown): x is RedditListing {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "Listing" &&
    Array.isArray((x as { data?: { children?: unknown } }).data?.children)
  );
}

interface RedditChild {
  kind: string;
  data: Record<string, unknown>;
}

interface RedditListing {
  kind: "Listing";
  data: { children: RedditChild[] };
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

const route = WEBSHARE_PROXY_URL
  ? `Webshare residential pool (token set)`
  : `direct (no WEBSHARE_TOKEN; expect 403s on .json from datacenter IPs -- use .rss suffix for direct residential egress)`;

console.log(`popping-proxy ${VERSION} listening on ${server.hostname}:${server.port} (routing: ${route})`);