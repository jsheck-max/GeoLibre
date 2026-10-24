// A Cloudflare rollout restarts the container with the env of its previous
// start (seen on THOR 2026-10-23), so a new GEOLIBRE_AUTH_PASSWORD would not
// reach nginx until a second deploy. The Durable Object remembers which deploy
// it last started the container on and replaces a running container once when
// that is not its own deploy (cloudflare/worker.ts, policy in cloudflare/fresh.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSettled, settleContainer, untilSettled, withDeadline, type SettleIo, type SettleOutcome } from "./fresh.ts";

const NOW = "5f0c2d1e-0000-4000-8000-000000000002";
const BEFORE = "5f0c2d1e-0000-4000-8000-000000000001";

type Probe = SettleIo & { destroyed: number; saved: string[] };

function io(over: Partial<SettleIo> & { stored?: string } = {}): Probe {
  const x: Probe = {
    destroyed: 0,
    saved: [],
    expected: NOW,
    running: () => true,
    recorded: async () => over.stored,
    record: async (id) => {
      x.saved.push(id);
    },
    destroy: async () => {
      x.destroyed += 1;
    },
    ...over,
  };
  return x;
}

describe("settleContainer", () => {
  it("leaves a container this deploy started alone", async () => {
    const x = io({ stored: NOW });
    assert.equal(await settleContainer(x), "current");
    assert.equal(x.destroyed, 0);
    assert.deepEqual(x.saved, []);
  });

  it("replaces a running container started on another deploy, once, then records this one", async () => {
    const x = io({ stored: BEFORE });
    assert.equal(await settleContainer(x), "replaced");
    assert.equal(x.destroyed, 1);
    assert.deepEqual(x.saved, [NOW]);
  });

  it("replaces a running container nobody recorded (first deploy of this object's code)", async () => {
    const x = io({ stored: undefined });
    assert.equal(await settleContainer(x), "replaced");
    assert.equal(x.destroyed, 1);
  });

  it("only records when nothing runs: the next start uses this deploy's env", async () => {
    const x = io({ stored: BEFORE, running: () => false });
    assert.equal(await settleContainer(x), "not-running");
    assert.equal(x.destroyed, 0);
    assert.deepEqual(x.saved, [NOW]);
  });

  it("does nothing without a deploy id to compare", async () => {
    const x = io({ expected: "", stored: BEFORE });
    assert.equal(await settleContainer(x), "no-deploy-id");
    assert.equal(x.destroyed, 0);
    assert.deepEqual(x.saved, []);
  });

  it("reports a replacement that fails, and does not record it, rather than throwing into the request", async () => {
    const x = io({
      stored: BEFORE,
      destroy: async () => {
        throw new Error("deadline");
      },
    });
    assert.equal(await settleContainer(x), "replace-failed");
    assert.deepEqual(x.saved, []);
  });

  it("never throws when storage fails", async () => {
    const broken = io({
      recorded: async () => {
        throw new Error("storage down");
      },
    });
    assert.equal(await settleContainer(broken), "storage-failed");
    assert.equal(broken.destroyed, 0);
  });
});

describe("isSettled", () => {
  it("serves only once the container is known to run this deploy's env", () => {
    for (const outcome of ["no-deploy-id", "current", "not-running", "replaced"] as const) {
      assert.equal(isSettled(outcome), true, outcome);
    }
    assert.equal(isSettled("replace-failed"), false);
    assert.equal(isSettled("storage-failed"), false);
  });
});

describe("untilSettled", () => {
  const scripted = (outcomes: SettleOutcome[]) => {
    const seen: Array<[SettleOutcome, boolean]> = [];
    let tries = 0;
    const settle = untilSettled(
      async () => outcomes[Math.min(tries++, outcomes.length - 1)],
      (outcome, settled) => seen.push([outcome, settled]),
    );
    return { settle, seen, tries: () => tries };
  };

  it("retries a failed replace on the next request instead of serving the old container", async () => {
    const x = scripted(["replace-failed", "replaced"]);
    assert.equal(await x.settle(), false);
    assert.equal(await x.settle(), true);
    assert.equal(x.tries(), 2);
    assert.deepEqual(x.seen, [["replace-failed", false], ["replaced", true]]);
  });

  it("keeps refusing while the replace keeps failing", async () => {
    const x = scripted(["replace-failed"]);
    for (let i = 0; i < 4; i += 1) assert.equal(await x.settle(), false);
    assert.equal(x.tries(), 4);
  });

  it("stops trying once settled", async () => {
    const x = scripted(["current"]);
    assert.equal(await x.settle(), true);
    assert.equal(await x.settle(), true);
    assert.equal(x.tries(), 1);
  });

  it("shares one try between concurrent requests", async () => {
    const x = scripted(["replaced"]);
    assert.deepEqual(await Promise.all([x.settle(), x.settle(), x.settle()]), [true, true, true]);
    assert.equal(x.tries(), 1);
  });
});

describe("withDeadline", () => {
  it("passes a prompt answer through and rejects a hung one", async () => {
    assert.equal(await withDeadline(Promise.resolve(7), 50, "replace"), 7);
    await assert.rejects(withDeadline(new Promise(() => {}), 20, "replace"), /replace took over 20 ms/);
  });
});
