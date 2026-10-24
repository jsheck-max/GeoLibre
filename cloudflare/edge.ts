// Request shaping for the GIS Worker (cloudflare/worker.ts). Kept free of
// cloudflare:workers imports so `node --test` can load it.
//
// No edge cache here, unlike THOR's edge.ts: GeoLibre's only access control is
// nginx Basic auth INSIDE the container, so a static file served from the edge
// cache would skip the password. Every request goes to the container.

/**
 * Plain http:// would send the Basic-auth password in cleartext. The readiness
 * ping goes straight to the container and never passes here.
 */
export function httpsRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== "http:") return null;
  url.protocol = "https:";
  return Response.redirect(url.toString(), 301);
}

/**
 * TITAN sets titan_session on Domain=.titanoshq.com, so browsers send it to
 * gis.titanoshq.com too. It must never reach third-party code in the container.
 * Splits on "," as well as ";" so a header merged from two Cookie lines cannot
 * hide one; only cookies whose name starts titan_ are removed.
 */
export function withoutTitanCookies(cookie: string | null): string | null {
  const kept = (cookie ?? "")
    .split(/[;,]/)
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "" && !pair.startsWith("titan_"));
  return kept.length > 0 ? kept.join("; ") : null;
}

// Client-address headers a caller could forge. They are dropped, then
// x-real-ip / x-forwarded-for are set from cf-connecting-ip, which only
// Cloudflare's edge can set.
const FORGEABLE = new Set([
  "x-real-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "true-client-ip",
]);

/** The request the container receives: same URL (Host stays public), method, auth and body. */
export function forContainer(request: Request): Request {
  const headers = new Headers(request.headers);
  const client = request.headers.get("cf-connecting-ip");
  for (const name of [...headers.keys()]) {
    if (name.startsWith("cf-") || FORGEABLE.has(name)) headers.delete(name);
  }
  if (client) {
    headers.set("x-real-ip", client);
    headers.set("x-forwarded-for", client);
  }
  const cookie = withoutTitanCookies(request.headers.get("cookie"));
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");
  return new Request(request, { headers });
}

// nginx's realm (docker/entrypoint.sh, auth_basic). The same realm keeps the
// browser's saved login valid for both 401s.
const REALM = 'Basic realm="GeoLibre"';

/**
 * nginx in the container checks the password. A request that carries no Basic
 * credentials at all can only get nginx's 401, so it gets that 401 here instead,
 * without waking the container, keeping it awake, or (after a deploy) being the
 * request that replaces it. /healthz is the one path nginx serves without auth.
 */
export function needsLogin(request: Request): Response | null {
  if (new URL(request.url).pathname === "/healthz") return null;
  if (/^basic\s/i.test(request.headers.get("authorization") ?? "")) return null;
  return new Response("Sign-in required.\n", {
    status: 401,
    headers: {
      "www-authenticate": REALM,
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Every https response the Worker returns. HSTS keeps the browser off plain
 * http after one visit, where a fake Basic prompt could collect the password
 * before the 301 ever ran. Set-Cookie is dropped: GeoLibre sets no cookies, and
 * one from gis.titanoshq.com could name Domain=.titanoshq.com and land in TITAN.
 */
export function hardened(response: Response): Response {
  // A WebSocket upgrade cannot be copied; nginx proxies none today.
  if (response.status === 101) return response;
  const out = new Response(response.body, response);
  out.headers.set("strict-transport-security", "max-age=31536000");
  out.headers.delete("set-cookie");
  return out;
}

/**
 * The image boots WIDE OPEN when neither GEOLIBRE_AUTH_USER nor
 * GEOLIBRE_AUTH_PASSWORD is set (docker/entrypoint.sh). Refuse to forward at
 * all unless both are, so a missing secret fails closed.
 */
export function isConfigured(env: Record<string, unknown>): boolean {
  const set = (key: string) => typeof env[key] === "string" && env[key] !== "";
  return set("GEOLIBRE_AUTH_USER") && set("GEOLIBRE_AUTH_PASSWORD");
}
