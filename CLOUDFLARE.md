# GeoLibre on Cloudflare (TNTS deploy, gis.titanoshq.com)

TNTS runs this fork as a private GIS workbench. This branch moves it from
Railway to a Cloudflare Worker plus one Container. The files that do this are in
`cloudflare/`. GeoLibre's own code and Dockerfile are unchanged.

> **This repo is PUBLIC.** Never put a password, token, secret value, origin
> hostname, account or project id, or internal path in this file or in
> `cloudflare/`. Only secret **names** go here. The cutover and rollback runbook
> is kept in TNTS's private docs, not here.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| Worker `gis` | `cloudflare/worker.ts` | Front door on the custom domain **`gis.titanoshq.com`**. No workers.dev, no preview URLs, no test route. |
| Container `GisContainer` | the repo-root `Dockerfile`, built by Workers Builds | nginx on :80 serves the built app, and the Python sidecar sits on 127.0.0.1:8765 behind `/sidecar/`. Instance `basic` (1/4 vCPU, 1 GiB, 4 GB disk). `max_instances` 1, region `ENAM`. |
| Durable Object `GIS` | `idFromName("gis")`, `locationHint: "enam"` | One object, so one container. `sleepAfter` is 15 min. |
| Access control | **nginx HTTP Basic auth inside the image** (`docker/entrypoint.sh`, `docker/nginx.conf`) | The user is `GEOLIBRE_AUTH_USER`. Covers everything except `/healthz`. The Worker does not check the password. It refuses to forward anything (503) unless both `GEOLIBRE_AUTH_USER` and `GEOLIBRE_AUTH_PASSWORD` are set, because the image boots **wide open** when both are missing. |
| Data | none on the server | Layers, projects and the PWA cache live in the browser (IndexedDB/OPFS) for the origin `https://gis.titanoshq.com`. Keeping the hostname keeps that data. `/data` in the container is conversion scratch space and is wiped on every restart. |
| Cron | none | The app has no in-process timers, and its two users accept a cold start after 15 idle minutes. |

What the Worker does on every request (`cloudflare/edge.ts`, tested in `cloudflare/edge.test.ts`):

1. Redirects `http://` to `https://` with a 301, because Basic auth over plain http sends the password in cleartext.
2. Answers `401` with `www-authenticate: Basic realm="GeoLibre"` (nginx's realm) to any request without `Authorization: Basic …`, except `/healthz`. nginx would refuse such a request anyway, so this only keeps scanners from waking the container, keeping it awake, or seeing its start-up errors. Any Basic credentials pass on, and nginx checks them. Browsers send the saved login with every request after the first prompt, so users see no change.
3. Deletes client-sent `x-real-ip`, `x-forwarded-for`, `x-forwarded-host`, `x-forwarded-proto`, `forwarded`, `true-client-ip` and every `cf-*` header, then sets `x-real-ip` and `x-forwarded-for` to `cf-connecting-ip`. That includes `cf-container-target-port`, which `@cloudflare/containers` would otherwise use to pick the container port.
4. Removes every cookie whose name starts with `titan_` from `Cookie`. TITAN sets `titan_session` on `Domain=.titanoshq.com`, so browsers send it here too, and it must never reach third-party code. Other cookies pass through. The header is dropped if nothing is left.
5. Keeps the public URL, so the container sees `Host: gis.titanoshq.com`.
6. On the way back, adds `strict-transport-security: max-age=31536000` and deletes any `Set-Cookie`. GeoLibre sets no cookies, and one from this host could name `Domain=.titanoshq.com` and land in TITAN.

There is **no edge cache**, unlike THOR. The password is checked in the container, so any file served from the edge cache would skip the password.

**Settle-on-deploy** (`cloudflare/fresh.ts`, tested in `cloudflare/fresh.test.ts`): a Cloudflare rollout restarts a running container with the env of its *previous* start, so a new password would not reach nginx until a second deploy. THOR asks its app which deploy it started on. GeoLibre has no such endpoint, so the Durable Object stores the Worker version id (`CF_VERSION_METADATA`) under the key `gis.deploy` each time the next start will use its own env. On the first request after a deploy, it replaces any running container whose stored id is not its own. **Nothing is served until that has worked:** if the replace fails or passes its 10 s deadline, or storage fails, that request gets a 503 with `retry-after: 30`, the log shows `gis.settle.replace_failed` or `gis.settle.storage_failed` (`console.error`), and the next request tries again. The old container would still accept the previous password. The worst case on success is one extra restart of a stateless app.

## Secrets: names only, set with wrangler

| Name | What |
|---|---|
| `GEOLIBRE_AUTH_PASSWORD` | Basic-auth password for `GEOLIBRE_AUTH_USER`. **Must be a NEW value, never one used before.** |

Generate it in a password manager: 24 or more random letters and digits, with no newline. Save it there. Then, from `cloudflare/`:

```sh
npx wrangler secret put GEOLIBRE_AUTH_PASSWORD   # paste at the prompt; nothing is echoed
```

To rotate it, run the same command again. That makes a new version, and settle-on-deploy restarts the container with the new value. Never put the value in a file, a commit, a chat or a log.

## Vars and build args (`cloudflare/wrangler.jsonc`)

| Name | Kind | Value | Why |
|---|---|---|---|
| `GEOLIBRE_AUTH_USER` | var | see `wrangler.jsonc` | Basic-auth user. |
| `GEOLIBRE_SHARE_URL` | var | `off` | Removes Share and the Project Gallery. Unset means the **public** share.geolibre.app, and TNTS data must never go there. |
| `VITE_GEOLIBRE_SHARE_URL` | build arg (`image_vars`) | `off` | The same setting baked into the bundle (see the next section). |

The container gets only these 3 runtime names (`PASS_THROUGH` in `cloudflare/worker.ts`). Every other `GEOLIBRE_*` setting stays unset, which keeps collab, AI proxy, embed API and PostGIS off and the sidecar sandboxed to `/data`. `VITE_GEOLIBRE_SHARE_URL` is the only build arg.

## Browsers that installed the app earlier

GeoLibre's service worker precaches `geolibre-runtime-config.js` (it matches the precache glob, and nothing excludes it) and serves it cache-first, so `Cache-Control: no-store` from nginx does not reach it. The entry's revision is the build-time file, `{}`, which never changes, so even a new service worker keeps the copy it already holds. A browser that installed the app while the server sent `{}` therefore keeps `{}`, and on its own that means the public share host. The build arg above makes the bundle's fallback `off`, so `{}` resolves to off too. It also changes the bundle, which makes old service workers update. Upstream stopped precaching the file in `9056a30d8` (#2463); it arrives with a fork sync.

The service worker also answers `/` from its cache, so a browser that holds an old login may not show the new password prompt. To check one browser after a deploy:

1. Sign in, then confirm that the toolbar has no Share and the Project Gallery is gone.
2. If either is still there: DevTools > Application > Service Workers > **Unregister**. Then Cache Storage > delete only the `workbox-precache-*` cache. Reload and sign in with the new password.
3. **Never use "Clear site data"** or clear storage for the site. That deletes the local projects in IndexedDB/OPFS.

A direct request such as `curl -u … https://gis.titanoshq.com/geolibre-runtime-config.js` bypasses the service worker, so it proves what the server sends, not what a browser runs.

## Workers Builds settings (dashboard: Workers > gis > Settings > Build)

| Setting | Value |
|---|---|
| Git repository | `jsheck-max/GeoLibre` (the Cloudflare Workers Builds GitHub app needs access to it) |
| Root directory | `cloudflare` |
| Build command | *(empty)* |
| Deploy command | `npx wrangler deploy` |
| Production branch | `feat/cloudflare-containers` |
| Preview builds (non-production branches) | **off** |
| Build variables | none needed |

Dependencies install from `cloudflare/package-lock.json`. An npm-10/npm-11 lockfile mismatch does not apply here: `npx npm@10.9.2 ci --dry-run` accepts this lockfile (checked 2026-10-23). If a build ever fails at install with EUSAGE, add build variable `SKIP_DEPENDENCY_INSTALL=1` and set build command `npx -y npm@11.13.0 ci`.

`wrangler deploy` builds the repo-root `Dockerfile` (`"image": "../Dockerfile"`, resolved from `cloudflare/`, with the repo root as build context). It is a heavy build: a full npm monorepo install, a Vite build, then a Python runtime with GDAL/duckdb/whitebox. If Workers Builds times out, the fallback is a one-line Dockerfile `FROM ghcr.io/opengeos/geolibre@sha256:72f3eaf0179ff0f022f1a2e127e2536452562453638917c170b6ce176656380a`, upstream's published amd64 image for this same commit (`7f10cf7`). Point `image` at that file instead. That image cannot take the build arg, so it relies on the runtime var alone (see the section above). Upstream's build also bakes in its own public Google Earth Engine client id and Mapillary token, so a few features differ slightly.

Local checks (no Docker needed), from `cloudflare/`:

```sh
npm ci
npm test            # node:test, Node >= 22.18
npm run typecheck   # tsc against worker-configuration.d.ts (regenerate: npm run types)
npm run check       # wrangler deploy --dry-run --containers-rollout=none (validates config, bundles; deploys nothing)
```

## Open issues

- **The image has not been built on Cloudflare yet.** There was no Docker on the machine where this was prepared, so `npm run check` skips the container build. The first Workers Builds run is the first real build.
- **Cookie tossing, browser half:** the Worker drops `Set-Cookie` from the container, but JavaScript served from `gis.titanoshq.com` can still set a `.titanoshq.com` cookie with `document.cookie`, so a compromised GeoLibre build could plant a `titan_*` cookie for TITAN. Stripping `titan_*` from requests only stops TITAN's session reaching the container. The full fix is a hostname outside the `titanoshq.com` zone.
- **HSTS has no `includeSubDomains`**, because not every subdomain of the zone has been checked as https-only. Zone-wide HSTS is a separate decision.
- **A replace that keeps failing keeps GIS at 503** (settle-on-deploy fails closed). Watch for `gis.settle.replace_failed` in the Worker logs. A new deploy starts a fresh object and tries again.
- **CSP allows `http://localhost:*` / `http://127.0.0.1:*`** (and `ws://`) in `connect-src` (`docker/nginx.conf`). Upstream warns this lets served JS probe each visitor's loopback on a public host. The site sits behind Basic auth. Changing it is a separate decision.
- **Request bodies through Cloudflare are capped by the zone plan** (100 MB on Free/Pro). GeoLibre has no upload endpoint, so only a very large JSON body to the sidecar could hit the cap.
- **No rate limit on password guesses.** The Worker cuts off requests with no credentials, but a request with wrong Basic credentials still reaches nginx. The control is the password's length: 24 or more random characters cannot be guessed online. A Cloudflare WAF rate-limit rule on 401s from `gis.titanoshq.com` is an optional extra.
- `basic` has 1 GiB of memory. A large sidecar conversion could run out of memory. If it does, change `instance_type` to `standard-1`.
- The fork is far behind upstream (0 ahead, about 923 behind on 2026-10-23). Syncing is a separate decision; do not sync during a cutover, so only one thing changes at a time.
- `npm audit` in `cloudflare/` reports undici advisories in wrangler's local dev server (miniflare). That code is tooling only; it never ships in the Worker.
