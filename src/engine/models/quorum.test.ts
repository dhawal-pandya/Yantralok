// Masterless quorum replication law validation (Cassandra-style). N peer nodes;
// each op replicates to RF of them and returns on the W-th (write) or R-th (read)
// ack. Write capacity scales with node count (unlike a single primary), a weak
// quorum (W+R ≤ RF) reads stale with the overlap probability, and losing up to
// RF−W nodes still lets writes reach quorum. Seeded and deterministic.
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

const quorumStore = (opts: {
  seed?: number;
  rate: number;
  nodes: number;
  rf: number;
  w: number;
  r: number;
  serversPerNode: number;
  serviceMs: number;
  writeRatio?: number;
  interventions?: Scenario["interventions"];
}): Scenario => ({
  seed: opts.seed ?? 7,
  stations: [
    { id: "client", servers: 1e9, serviceRatePerMs: 1000, queueCapacity: 1e9, deps: [{ to: 1, latencyMs: 1 }] },
    {
      id: "store",
      servers: opts.nodes * opts.serversPerNode,
      serviceRatePerMs: 1 / opts.serviceMs,
      queueCapacity: 1e9,
      deps: [],
      quorum: {
        nodes: opts.nodes,
        replicationFactor: opts.rf,
        writeQuorum: opts.w,
        readQuorum: opts.r,
        serversPerNode: opts.serversPerNode,
        queuePerNode: 1e9,
      },
    },
  ],
  arrivals: [{ station: 0, ratePerMs: opts.rate / 1000, writeRatio: opts.writeRatio ?? 1 }],
  interventions: opts.interventions ?? [],
});

const tailThru = (r: ReturnType<MainThreadHost["run"]>) =>
  r.windows.slice(-5).reduce((a, w) => a + w.throughput, 0) / 5;

describe("quorum: write capacity scales with node count", () => {
  it("more peer nodes raise the write ceiling (unlike a single primary)", () => {
    // Write ceiling = nodes × serversPerNode / (serviceMs × RF). RF fixed at 3.
    const run = (nodes: number) =>
      new MainThreadHost().run(
        quorumStore({ rate: 5000, nodes, rf: 3, w: 2, r: 2, serversPerNode: 4, serviceMs: 5, writeRatio: 1, seed: 1 }),
        { horizonMs: 15_000, sampleIntervalMs: 1000 },
      );
    const three = tailThru(run(3)); // ceiling ≈ 3×4/(5×3) = 800/s
    const nine = tailThru(run(9)); // ceiling ≈ 2400/s
    expect(three).toBeGreaterThan(600);
    expect(three).toBeLessThan(1000);
    expect(nine).toBeGreaterThan(three * 2.5); // capacity tripled with 3× the nodes
  });
});

describe("quorum: node-loss tolerance", () => {
  it("RF=3, W=2 tolerates one node loss but not two in a replica set", () => {
    // Load well under capacity, so any failures come from quorum loss, not saturation.
    const base = { rate: 1200, nodes: 6, rf: 3, w: 2, r: 2, serversPerNode: 10, serviceMs: 5, writeRatio: 1, seed: 2 } as const;
    const killOne = new MainThreadHost().run(
      quorumStore({ ...base, interventions: [{ atMs: 3000, kind: "kill", station: 1, shard: 0 }] }),
      { horizonMs: 12_000, sampleIntervalMs: 1000 },
    );
    const killTwo = new MainThreadHost().run(
      quorumStore({
        ...base,
        interventions: [
          { atMs: 3000, kind: "kill", station: 1, shard: 0 },
          { atMs: 3000, kind: "kill", station: 1, shard: 1 },
        ],
      }),
      { horizonMs: 12_000, sampleIntervalMs: 1000 },
    );
    const lateFail = (r: ReturnType<MainThreadHost["run"]>) =>
      r.windows.slice(-4).reduce((a, w) => a + w.failureRate, 0) / 4;
    // One node down: every replica set still has ≥ W=2 alive, so writes keep succeeding.
    expect(lateFail(killOne)).toBeLessThan(20);
    // Two adjacent nodes down: the key slices whose set holds both lose quorum.
    expect(lateFail(killTwo)).toBeGreaterThan(100);
    expect(lateFail(killTwo)).toBeGreaterThan(lateFail(killOne) + 50);
  });
});

describe("quorum: weak quorum trades consistency for a stale-read rate", () => {
  const staleRate = (w: number, r: number, seed: number): number => {
    const m = sim(quorumStore({ rate: 800, nodes: 6, rf: 3, w, r, serversPerNode: 12, serviceMs: 4, writeRatio: 0.3, seed }));
    m.run(15_000);
    const st = readNetworkCounters(m.state, 15_000).stations[1];
    return st.replicaReads > 0 ? st.staleReads / st.replicaReads : NaN;
  };

  it("strong quorum (W+R > RF) never reads stale; weaker settings measurably do", () => {
    // RF=3. W=2,R=2 (sum 4 > 3): strongly consistent. W=1,R=1 (sum 2): overlap
    // prob C(2,1)/C(3,1)=2/3. W=1,R=2 (sum 3): C(2,2)/C(3,2)=1/3.
    expect(staleRate(2, 2, 10)).toBe(0);
    expect(staleRate(1, 2, 11)).toBeGreaterThan(0.22);
    expect(staleRate(1, 2, 11)).toBeLessThan(0.45);
    expect(staleRate(1, 1, 12)).toBeGreaterThan(0.55);
    expect(staleRate(1, 1, 12)).toBeLessThan(0.78);
  });
});

describe("quorum: determinism", () => {
  const scn = (): Scenario =>
    quorumStore({ rate: 1500, nodes: 5, rf: 3, w: 2, r: 2, serversPerNode: 6, serviceMs: 6, writeRatio: 0.4, seed: 4711 });

  it("golden-trace: two same-seed quorum runs are byte-identical", () => {
    const a = new MainThreadHost().run(scn(), { horizonMs: 12_000 });
    const b = new MainThreadHost().run(scn(), { horizonMs: 12_000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("replay-equivalence: resuming from a mid-flight snapshot equals a continuous run", () => {
    const cont = sim(scn());
    cont.run(12_000);
    const want = JSON.stringify(readNetworkCounters(cont.state, 12_000));

    const half = sim(scn());
    half.run(3100); // mid-run: replica sub-calls in flight across the peers
    const resumed = Simulation.restore(half.snapshot(), createNetwork(scn()).handler, { recordTrace: false });
    resumed.run(12_000);
    expect(JSON.stringify(readNetworkCounters(resumed.state, 12_000))).toBe(want);
  });
});
