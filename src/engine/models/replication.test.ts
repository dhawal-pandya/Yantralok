// Read-replica + replication-lag law validation. Writes seat only in the primary
// pool, reads only in the replica pool; a replica read within lagMs of a write
// commit is stale. Validated like every law: capacity confinement, the exact
// staleness probability, and determinism.
import { describe, expect, it } from "vitest";
import { Simulation } from "../simulation";
import { MainThreadHost } from "../host";
import type { Scenario } from "../scenario";
import { createNetwork, readNetworkCounters, type NetworkState } from "./network";

// Primary 2 conns + 2 replicas × 2 conns, 10ms queries: writes cap at 200/s,
// reads at 400/s. `servers` is the total (6), the ρ denominator.
const store = (ratePerMs: number, writeRatio: number, seed = 21): Scenario => ({
  seed,
  stations: [
    {
      id: "db",
      servers: 6,
      serviceRatePerMs: 1 / 10,
      queueCapacity: 500,
      deps: [],
      replication: { primaryServers: 2, replicaServers: 4, lagMs: 50 },
    },
  ],
  arrivals: [{ station: 0, ratePerMs, writeRatio }],
  interventions: [],
});

const run = (s: Scenario, horizonMs = 30_000) =>
  new MainThreadHost().run(s, { horizonMs, sampleIntervalMs: 1000 });

describe("read replicas: write confinement law", () => {
  it("replicas add read capacity, not write capacity", () => {
    const reads = run(store(0.35, 0)); // 350/s of reads vs 400/s replica pool
    const writes = run(store(0.35, 1)); // 350/s of writes vs 200/s primary pool
    expect(reads.totals.failures).toBe(0);
    expect(writes.totals.failures).toBeGreaterThan(0); // shed at the primary
    expect(writes.totals.completions).toBeLessThan(reads.totals.completions * 0.65);
  });

  it("a write flood melts down while the replica pool sits idle (ρ stays low)", () => {
    const r = run(store(0.35, 1));
    const tail = r.windows.slice(-10);
    for (const w of tail) {
      expect(w.failureRate).toBeGreaterThan(0); // rejecting writes…
      expect(w.stations[0].utilization).toBeLessThan(0.45); // …at 2 of 6 busy
    }
  });

  it("a saturated primary does not block reads from their replica pool", () => {
    // Writes overload the primary (300/s vs 200/s) and clog the queue; reads
    // (200/s vs 400/s pool) must keep seating directly.
    const r = store(0.5, 0.6, 7);
    const net = createNetwork(r);
    const sim = new Simulation<NetworkState>({
      handler: net.handler,
      initialState: net.state,
      seed: r.seed,
      init: net.init,
      recordTrace: false,
    });
    sim.run(20_000);
    const c = readNetworkCounters(sim.state, 20_000);
    expect(c.failures).toBeGreaterThan(0); // the write side is shedding
    expect(c.stations[0].replicaReads).toBeGreaterThan(0.2 * 20_000 * 0.9); // reads flowed
  });
});

describe("replication lag: staleness law", () => {
  // Write completions are Poisson (Burke's theorem), so the chance a replica read
  // lands within lagMs of the last commit is exactly 1 − e^(−λw·lag).
  const mixed = (lagMs: number): Scenario => ({
    seed: 99,
    stations: [
      {
        id: "db",
        servers: 100,
        serviceRatePerMs: 1 / 5,
        queueCapacity: 1e9,
        deps: [],
        replication: { primaryServers: 50, replicaServers: 50, lagMs },
      },
    ],
    arrivals: [
      { station: 0, ratePerMs: 0.01, writeRatio: 1 }, // λw = 10 writes/s
      { station: 0, ratePerMs: 0.1, writeRatio: 0 }, // 100 reads/s
    ],
    interventions: [],
  });

  it("stale-read rate matches 1 − e^(−λw·lag)", () => {
    const net = createNetwork(mixed(30));
    const sim = new Simulation<NetworkState>({
      handler: net.handler,
      initialState: net.state,
      seed: 99,
      init: net.init,
      recordTrace: false,
    });
    sim.run(200_000);
    const st = readNetworkCounters(sim.state, 200_000).stations[0];
    const rate = st.staleReads / st.replicaReads;
    const expected = 1 - Math.exp(-0.01 * 30); // ≈ 0.259
    expect(rate).toBeGreaterThan(expected - 0.04);
    expect(rate).toBeLessThan(expected + 0.04);
  });

  it("zero lag means zero stale reads", () => {
    const net = createNetwork(mixed(0));
    const sim = new Simulation<NetworkState>({
      handler: net.handler,
      initialState: net.state,
      seed: 99,
      init: net.init,
      recordTrace: false,
    });
    sim.run(60_000);
    const st = readNetworkCounters(sim.state, 60_000).stations[0];
    expect(st.replicaReads).toBeGreaterThan(0);
    expect(st.staleReads).toBe(0);
  });
});

describe("read replicas: determinism", () => {
  const scenario = store(0.3, 0.3, 31415);

  it("golden-trace: two same-seed runs are byte-identical", () => {
    const a = run(scenario, 15_000);
    const b = run(scenario, 15_000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("replay-equivalence: a snapshot with pooled seats + staleness state replays exactly", () => {
    const mk = () => {
      const net = createNetwork(scenario);
      return new Simulation<NetworkState>({
        handler: net.handler,
        initialState: net.state,
        seed: scenario.seed,
        init: net.init,
        recordTrace: false,
      });
    };
    const cont = mk();
    cont.run(12_000);
    const want = JSON.stringify(readNetworkCounters(cont.state, 12_000));

    const s = mk();
    s.run(1500);
    const s2 = Simulation.restore(s.snapshot(), createNetwork(scenario).handler, { recordTrace: false });
    s2.run(12_000);
    expect(JSON.stringify(readNetworkCounters(s2.state, 12_000))).toBe(want);
  });
});
