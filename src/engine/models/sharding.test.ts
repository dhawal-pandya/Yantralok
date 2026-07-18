// Horizontal sharding law validation. A sharded station is N independent cells;
// each call routes (seeded hash of its request id) to one cell with its own
// servers + queue. Load spreads evenly, capacity is count × per-shard, and a dead
// cell isolates its own key slice. Gated: an unsharded station is byte-identical.
import { describe, expect, it } from "vitest";
import { Simulation } from "../simulation";
import { MainThreadHost } from "../host";
import type { Scenario } from "../scenario";
import { createNetwork, readNetworkCounters, type NetworkState } from "./network";

const sim = (scenario: Scenario) => {
  const net = createNetwork(scenario);
  return new Simulation<NetworkState>({
    handler: net.handler,
    initialState: net.state,
    seed: scenario.seed,
    init: net.init,
    recordTrace: false,
  });
};

// Client -> sharded store. The store's cells each have `serversPerShard` servers at
// `serviceMs`, so total capacity is count × serversPerShard / serviceMs.
const sharded = (opts: {
  seed?: number;
  rate: number; // req/s into the store
  count: number;
  serversPerShard: number;
  serviceMs: number;
  queuePerShard?: number;
  interventions?: Scenario["interventions"];
}): Scenario => ({
  seed: opts.seed ?? 7,
  stations: [
    { id: "client", servers: 1e9, serviceRatePerMs: 1000, queueCapacity: 1e9, deps: [{ to: 1, latencyMs: 1 }] },
    {
      id: "store",
      servers: opts.count * opts.serversPerShard,
      serviceRatePerMs: 1 / opts.serviceMs,
      queueCapacity: 1e9,
      deps: [],
      shards: {
        count: opts.count,
        serversPerShard: opts.serversPerShard,
        queuePerShard: opts.queuePerShard ?? 1e9,
      },
    },
  ],
  arrivals: [{ station: 0, ratePerMs: opts.rate / 1000 }],
  interventions: opts.interventions ?? [],
});

describe("sharding: fan-out across cells", () => {
  it("spreads load ~evenly across the cells (seeded hash)", () => {
    const m = sim(sharded({ rate: 400, count: 4, serversPerShard: 8, serviceMs: 5, seed: 1 }));
    m.run(15_000);
    const arr = m.state.stations[1].shardArrivals;
    expect(arr).toHaveLength(4);
    const total = arr.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(4000);
    // Each cell should carry ~25% of the load; allow generous slack for randomness.
    for (const a of arr) {
      expect(a / total).toBeGreaterThan(0.18);
      expect(a / total).toBeLessThan(0.32);
    }
  });

  it("adding shards raises the throughput ceiling", () => {
    // Per-shard capacity = 2 servers / 10ms = 200/s. Offer 1000/s (saturating).
    const one = new MainThreadHost().run(
      sharded({ rate: 1000, count: 1, serversPerShard: 2, serviceMs: 10, seed: 2 }),
      { horizonMs: 15_000, sampleIntervalMs: 1000 },
    );
    const four = new MainThreadHost().run(
      sharded({ rate: 1000, count: 4, serversPerShard: 2, serviceMs: 10, seed: 2 }),
      { horizonMs: 15_000, sampleIntervalMs: 1000 },
    );
    const tail = (r: typeof one) => r.windows.slice(-5).reduce((a, w) => a + w.throughput, 0) / 5;
    // 1 shard tops out near 200/s; 4 shards near 800/s.
    expect(tail(one)).toBeLessThan(260);
    expect(tail(four)).toBeGreaterThan(650);
    expect(tail(four)).toBeGreaterThan(tail(one) * 3);
  });

  it("a dead shard takes down only its own slice, not the whole store", () => {
    // 4 cells, well-provisioned; kill cell 1 at t=3s. Only requests hashing to it
    // fail: throughput drops to ~3/4, and the store keeps serving the rest.
    const r = new MainThreadHost().run(
      sharded({
        rate: 400,
        count: 4,
        serversPerShard: 16,
        serviceMs: 5,
        seed: 3,
        interventions: [{ atMs: 3000, kind: "kill", station: 1, shard: 1 }],
      }),
      { horizonMs: 12_000, sampleIntervalMs: 1000 },
    );
    const late = r.windows.slice(-4);
    const meanThru = late.reduce((a, w) => a + w.throughput, 0) / late.length;
    const meanFail = late.reduce((a, w) => a + w.failureRate, 0) / late.length;
    // ~3/4 of the ~400/s still completes; ~1/4 fails (the dead cell's slice).
    expect(meanThru).toBeGreaterThan(250);
    expect(meanThru).toBeLessThan(360);
    expect(meanFail).toBeGreaterThan(50); // the dead shard's requests fail, not silent
    // The other cells are unaffected: their arrivals still get served.
    expect(meanThru).toBeGreaterThan(meanFail * 2);
  });
});

describe("sharding: determinism", () => {
  const scn = (): Scenario =>
    sharded({ rate: 600, count: 3, serversPerShard: 6, serviceMs: 8, seed: 4711 });

  it("golden-trace: two same-seed sharded runs are byte-identical", () => {
    const a = new MainThreadHost().run(scn(), { horizonMs: 12_000 });
    const b = new MainThreadHost().run(scn(), { horizonMs: 12_000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("replay-equivalence: resuming from a mid-flight snapshot equals a continuous run", () => {
    const cont = sim(scn());
    cont.run(12_000);
    const want = JSON.stringify(readNetworkCounters(cont.state, 12_000));

    const half = sim(scn());
    half.run(3100); // mid-run: cells busy, queues built
    const resumed = Simulation.restore(half.snapshot(), createNetwork(scn()).handler, { recordTrace: false });
    resumed.run(12_000);
    expect(JSON.stringify(readNetworkCounters(resumed.state, 12_000))).toBe(want);
  });
});
