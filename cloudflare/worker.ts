// GeoLibre's front door on Cloudflare.
//
// Every request goes to ONE container running the repo's own image: nginx on
// :80 serving the built web app, with HTTP Basic auth on everything but
// /healthz, and the Python sidecar behind /sidecar/. The Worker only shapes the
// request and response (cloudflare/edge.ts); the password check stays in the
// image's nginx.

import { Container } from "@cloudflare/containers";
import { forContainer, hardened, httpsRedirect, isConfigured, needsLogin } from "./edge";
import { settleContainer, untilSettled, withDeadline, type SettleOutcome } from "./fresh";

// What the container sees as its environment (docker/entrypoint.sh reads these).
// The secret comes from `wrangler secret put`, the rest from wrangler.jsonc vars.
const PASS_THROUGH = ["GEOLIBRE_AUTH_USER", "GEOLIBRE_AUTH_PASSWORD", "GEOLIBRE_SHARE_URL"] as const;

const DEPLOY_KEY = "gis.deploy";
const DESTROY_MS = 10_000;

const plain = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
  });

function reportSettle(outcome: SettleOutcome, settled: boolean): void {
  if (settled) {
    console.info(JSON.stringify({ event: "gis.settle", outcome }));
  } else {
    console.error(JSON.stringify({ event: `gis.settle.${outcome.replace("-", "_")}`, outcome }));
  }
}

export class GisContainer extends Container<Env> {
  defaultPort = 80;
  // /healthz answers 200 "ok" with no auth and no redirect (docker/nginx.conf).
  pingEndpoint = "ping/healthz";
  sleepAfter = "15m";

  private readonly deploy: string;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const all = env as unknown as Record<string, unknown>;
    this.envVars = Object.fromEntries(
      PASS_THROUGH.flatMap((key) => (typeof all[key] === "string" ? [[key, all[key] as string]] : [])),
    );
    this.deploy = env.CF_VERSION_METADATA?.id ?? "";
  }

  // Before serving, once per object (each deploy makes a new one): a running
  // container started on another deploy is replaced, so the next fetch starts it
  // with this deploy's envVars (cloudflare/fresh.ts says why). Nothing is served
  // until that has worked, because the old container still takes the previous
  // password; every request tries again, each try under a deadline.
  private readonly settle = untilSettled(
    () =>
      settleContainer({
        expected: this.deploy,
        running: () => this.ctx.container?.running === true,
        recorded: () => this.ctx.storage.get<string>(DEPLOY_KEY),
        record: (deploy) => this.ctx.storage.put(DEPLOY_KEY, deploy),
        destroy: () => withDeadline(this.destroy(), DESTROY_MS, "container replace"),
      }),
    reportSettle,
  );

  override async fetch(request: Request): Promise<Response> {
    if (!(await this.settle())) {
      return plain(503, "GIS is restarting. Try again in a minute.\n", { "retry-after": "30" });
    }
    return super.fetch(request);
  }
}

// One object, so one container; it and the object live in eastern North America.
const gis = (env: Env) => env.GIS.get(env.GIS.idFromName("gis"), { locationHint: "enam" });

async function route(request: Request, env: Env): Promise<Response> {
  if (!isConfigured(env as unknown as Record<string, unknown>)) {
    console.error(JSON.stringify({ event: "gis.unconfigured", need: "GEOLIBRE_AUTH_USER and GEOLIBRE_AUTH_PASSWORD" }));
    return plain(503, "GIS is not configured.\n");
  }
  return needsLogin(request) ?? gis(env).fetch(forContainer(request));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return httpsRedirect(request) ?? hardened(await route(request, env));
  },
};
