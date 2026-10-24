// A Cloudflare rollout restarts the container with the env of its previous
// start (seen on THOR 2026-10-23). So a var just set, or a secret just rotated
// (a new GEOLIBRE_AUTH_PASSWORD), would not reach nginx until the deploy after.
//
// THOR asks its container which deploy it started on (/api/health). GeoLibre's
// image has no such endpoint and we do not patch it, so the Durable Object
// remembers instead: it records the deploy id whenever the NEXT start will be
// its own (nothing running, or it just replaced the container), and replaces a
// running container whose recorded deploy is not this one. Worst case is one
// extra restart of a stateless app. Kept free of cloudflare:workers imports so
// `node --test` can load it.

export type SettleOutcome =
  | "no-deploy-id"
  | "current"
  | "not-running"
  | "replaced"
  | "replace-failed"
  | "storage-failed";

export type SettleIo = {
  /** This Worker version's id; empty = nothing to compare. */
  expected: string;
  running: () => boolean;
  /** Deploy id the container was last started on, as this object recorded it. */
  recorded: () => Promise<string | undefined>;
  record: (deploy: string) => Promise<void>;
  /** Replace the container; the next fetch starts it with this object's env. */
  destroy: () => Promise<void>;
};

export async function settleContainer(io: SettleIo): Promise<SettleOutcome> {
  if (!io.expected) return "no-deploy-id";
  try {
    if ((await io.recorded()) === io.expected) return "current";
    if (!io.running()) {
      await io.record(io.expected);
      return "not-running";
    }
  } catch {
    return "storage-failed";
  }
  try {
    await io.destroy();
  } catch {
    return "replace-failed";
  }
  try {
    await io.record(io.expected);
  } catch {
    // The container is already gone and restarts with this deploy's env; at
    // worst the next object replaces it once more.
  }
  return "replaced";
}

/**
 * Whether the container may serve. A failed replace leaves the container that
 * started on another deploy running, and that one still takes the previous
 * password, which after a rotation is the one being retired. A storage failure
 * means it was never checked. Neither serves; the next request tries again.
 */
export function isSettled(outcome: SettleOutcome): boolean {
  return outcome !== "replace-failed" && outcome !== "storage-failed";
}

/**
 * Runs `attempt` until one try settles. Concurrent callers share the try in
 * flight. A try that does not settle answers false and the next call tries
 * again; once one settles, every call answers true without trying.
 */
export function untilSettled(
  attempt: () => Promise<SettleOutcome>,
  report: (outcome: SettleOutcome, settled: boolean) => void,
): () => Promise<boolean> {
  let settled = false;
  let inFlight: Promise<boolean> | undefined;
  return () => {
    if (settled) return Promise.resolve(true);
    inFlight ??= attempt()
      .then((outcome) => {
        settled = isSettled(outcome);
        report(outcome, settled);
        return settled;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

/** Rejects when `work` has not settled within `ms`, so a hung step never holds every request. */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
