// What the Worker does to a request before the GeoLibre container sees it
// (cloudflare/edge.ts). Run with `npm test` in cloudflare/ (node:test, Node >= 22.18).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { forContainer, hardened, httpsRedirect, isConfigured, needsLogin, withoutTitanCookies } from "./edge.ts";

const CLIENT = "203.0.113.7";

describe("httpsRedirect", () => {
  it("sends plain http to https with a 301, keeping path and query", () => {
    const res = httpsRedirect(new Request("http://gis.titanoshq.com/a/b?x=1"));
    assert.equal(res?.status, 301);
    assert.equal(res?.headers.get("location"), "https://gis.titanoshq.com/a/b?x=1");
  });

  it("lets https through", () => {
    assert.equal(httpsRedirect(new Request("https://gis.titanoshq.com/")), null);
  });
});

describe("withoutTitanCookies", () => {
  it("drops every cookie whose name starts titan_ and keeps the rest in order", () => {
    assert.equal(
      withoutTitanCookies("a=1; titan_session=secret; b=2;titan_x=y"),
      "a=1; b=2",
    );
  });

  it("returns null when nothing is left, so the header is removed", () => {
    assert.equal(withoutTitanCookies("titan_session=secret"), null);
    assert.equal(withoutTitanCookies(null), null);
    assert.equal(withoutTitanCookies(""), null);
  });

  it("catches a TITAN cookie in a comma-joined header (two Cookie lines merged)", () => {
    assert.equal(withoutTitanCookies("a=1, titan_session=secret"), "a=1");
  });

  it("does not touch a cookie that only contains titan_ later in its name", () => {
    assert.equal(withoutTitanCookies("not_titan_session=1"), "not_titan_session=1");
  });
});

describe("forContainer", () => {
  const incoming = (headers: Record<string, string>, init: RequestInit = {}) =>
    new Request("https://gis.titanoshq.com/sidecar/conversion/status?q=1", { ...init, headers });

  it("replaces client-sent forwarding headers with the address Cloudflare saw", () => {
    const out = forContainer(
      incoming({
        "cf-connecting-ip": CLIENT,
        "x-real-ip": "10.0.0.1",
        "x-forwarded-for": "10.0.0.1, 10.0.0.2",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
        forwarded: "for=10.0.0.1",
        "true-client-ip": "10.0.0.1",
      }),
    );
    assert.equal(out.headers.get("x-real-ip"), CLIENT);
    assert.equal(out.headers.get("x-forwarded-for"), CLIENT);
    for (const name of ["x-forwarded-host", "x-forwarded-proto", "forwarded", "true-client-ip"]) {
      assert.equal(out.headers.get(name), null, name);
    }
  });

  it("drops every cf-* header and leaves no forwarding headers without a client address", () => {
    const out = forContainer(
      incoming({
        "cf-ray": "abc",
        "cf-ipcountry": "US",
        // @cloudflare/containers routes a request to the port this header names,
        // so a caller who kept it could reach any port in the container.
        "cf-container-target-port": "8765",
        "x-real-ip": "10.0.0.1",
      }),
    );
    assert.equal(out.headers.get("cf-container-target-port"), null);
    assert.equal([...out.headers.keys()].some((name) => name.startsWith("cf-")), false);
    assert.equal(out.headers.get("x-real-ip"), null);
    assert.equal(out.headers.get("x-forwarded-for"), null);
  });

  it("strips TITAN cookies, removes an emptied Cookie header and keeps the others", () => {
    assert.equal(forContainer(incoming({ cookie: "titan_session=secret" })).headers.get("cookie"), null);
    assert.equal(forContainer(incoming({ cookie: "titan_session=secret; z=9" })).headers.get("cookie"), "z=9");
  });

  it("keeps the public URL (so Host stays gis.titanoshq.com), method, auth and body", async () => {
    const out = forContainer(
      incoming(
        { "cf-connecting-ip": CLIENT, authorization: "Basic dXNlcjp4", "content-type": "application/json" },
        { method: "POST", body: '{"a":1}' },
      ),
    );
    assert.equal(out.url, "https://gis.titanoshq.com/sidecar/conversion/status?q=1");
    assert.equal(out.method, "POST");
    assert.equal(out.headers.get("authorization"), "Basic dXNlcjp4");
    assert.equal(await out.text(), '{"a":1}');
  });
});

describe("needsLogin", () => {
  const at = (path: string, headers: Record<string, string> = {}) =>
    needsLogin(new Request(`https://gis.titanoshq.com${path}`, { headers }));

  it("answers a request with no Basic credentials with nginx's 401, so it never reaches the container", () => {
    for (const res of [at("/"), at("/sidecar/conversion/status"), at("/", { authorization: "Bearer x" })]) {
      assert.equal(res?.status, 401);
      assert.equal(res?.headers.get("www-authenticate"), 'Basic realm="GeoLibre"');
      assert.equal(res?.headers.get("cache-control"), "no-store");
    }
  });

  it("passes any Basic credentials on (nginx checks them) and /healthz without any", () => {
    assert.equal(at("/", { authorization: "Basic dXNlcjp4" }), null);
    assert.equal(at("/", { authorization: "basic dXNlcjp4" }), null);
    assert.equal(at("/healthz"), null);
  });

  it("opens only the exact /healthz path, as nginx's `location = /healthz` does", () => {
    assert.equal(at("/healthz/")?.status, 401);
    assert.equal(at("/healthz/x")?.status, 401);
  });
});

describe("hardened", () => {
  it("adds HSTS and drops any Set-Cookie, keeping status, body and other headers", async () => {
    const from = new Response("hi", {
      status: 404,
      headers: { "set-cookie": "titan_session=x; Domain=.titanoshq.com", "content-type": "text/plain", "x-a": "1" },
    });
    const out = hardened(from);
    assert.equal(out.status, 404);
    assert.equal(out.headers.get("strict-transport-security"), "max-age=31536000");
    assert.equal(out.headers.get("set-cookie"), null);
    assert.equal(out.headers.get("x-a"), "1");
    assert.equal(await out.text(), "hi");
  });
});

describe("isConfigured", () => {
  it("needs both halves of the Basic-auth login, so the image never boots open", () => {
    assert.equal(isConfigured({ GEOLIBRE_AUTH_USER: "user", GEOLIBRE_AUTH_PASSWORD: "p" }), true);
    assert.equal(isConfigured({ GEOLIBRE_AUTH_USER: "user" }), false);
    assert.equal(isConfigured({ GEOLIBRE_AUTH_USER: "user", GEOLIBRE_AUTH_PASSWORD: "" }), false);
    assert.equal(isConfigured({ GEOLIBRE_AUTH_PASSWORD: "p" }), false);
    assert.equal(isConfigured({}), false);
  });
});
