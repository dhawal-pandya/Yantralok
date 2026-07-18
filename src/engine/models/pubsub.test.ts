// Pub/sub fan-out law validation. A pub/sub broker delivers EVERY produced message
// to EVERY subscriber group, and each group drains its own backlog with its own
// consumer pool, so a slow group's lag never touches a fast group's. Gated: a
// broker with no groups is the single competing-consumers pool, byte-identical.
import { describe, expect, it } from "vitest";
import { Simulation } from "../simulation";
import { MainThreadHost } from "../host";
import type { BrokerGroup, Scenario } from "../scenario";
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

// Producer -> pub/sub broker with the given subscriber groups.
const pubsub = (opts: { seed?: number; produceRate?: number; groups: BrokerGroup[] }): Scenario => ({
  seed: opts.seed ?? 7,
  stations: [
    { id: "producer", servers: 1e9, serviceRatePerMs: 1000, queueCapacity: 1e9, deps: [{ to: 1, latencyMs: 1 }] },
    {
      id: "broker",
      servers: opts.groups.reduce((a, g) => a + g.consumers, 0),
      serviceRatePerMs: 1 / 10,
      queueCapacity: 0,
      deps: [],
      broker: { consumers: opts.groups[0].consumers, groups: opts.groups },
    },
  ],
  arrivals: [{ station: 0, ratePerMs: (opts.produceRate ?? 100) / 1000 }],
  interventions: [],
});

describe("pub/sub fan-out: subscriber groups", () => {
  it("delivers every message to every group (fan-out, not competing consumers)", () => {
    // Two groups, both fast enough to keep up: each should consume ~every message,
    // so total consumed across groups ≈ 2× produced (a fan-out, not a single pool).
    const s = pubsub({
      produceRate: 100,
      groups: [
        { consumers: 6, consumeRatePerMs: 1 / 5 },
        { consumers: 6, consumeRatePerMs: 1 / 5 },
      ],
      seed: 11,
    });
    const m = sim(s);
    m.run(15_000);
    const c = readNetworkCounters(m.state, 15_000);
    const b = c.stations[1];
    const produced = b.produced;
    expect(produced).toBeGreaterThan(1000);
    // Conservation PER group: every produce reached each group's backlog once.
    for (const g of b.groups) expect(g.consumed + g.backlog).toBe(produced);
    // Aggregate consumed is ~2× produced: the message was delivered twice.
    expect(b.consumed).toBeGreaterThan(produced * 1.8);
  });

  it("groups drain independently: a slow group's lag never touches a fast one", () => {
    // Group 0: 8 consumers at 5ms => ~1600/s capacity (drains 100/s easily).
    // Group 1: 1 consumer at 200ms => ~5/s capacity (lag runs away).
    const s = pubsub({
      produceRate: 100,
      groups: [
        { consumers: 8, consumeRatePerMs: 1 / 5 },
        { consumers: 1, consumeRatePerMs: 1 / 200 },
      ],
      seed: 22,
    });
    const r = new MainThreadHost().run(s, { horizonMs: 20_000, sampleIntervalMs: 1000 });
    const broker = (i: number) => r.windows[i].stations.find((st) => st.id === "broker")!;
    const last = r.windows.length - 1;
    // The whole-broker lag climbs (dominated by the slow group)...
    expect(broker(last).backlog).toBeGreaterThan(broker(2).backlog + 500);
    // ...but read the raw per-group state: the fast group stays near-empty while the
    // slow group's backlog is huge. Independence.
    const direct = sim(s);
    direct.run(20_000);
    const g = readNetworkCounters(direct.state, 20_000).stations[1].groups;
    expect(g[0].backlog).toBeLessThan(20); // fast group kept up
    expect(g[1].backlog).toBeGreaterThan(1000); // slow group fell far behind
    expect(g[1].backlog).toBeGreaterThan(g[0].backlog * 50); // wholly independent
  });

  it("a per-group bounded buffer drops that group's copy without failing others", () => {
    const s = pubsub({
      produceRate: 100,
      groups: [
        { consumers: 8, consumeRatePerMs: 1 / 5 }, // unbounded-enough, keeps up
        { consumers: 1, consumeRatePerMs: 1 / 200, maxBacklog: 50 }, // bounded, overflows
      ],
      seed: 33,
    });
    const m = sim(s);
    m.run(20_000);
    const g = readNetworkCounters(m.state, 20_000).stations[1].groups;
    expect(g[1].backlog).toBeLessThanOrEqual(50); // the slow group's buffer is capped
    // The producer is still acked as long as one group accepts, so throughput holds.
    expect(m.state.completions).toBeGreaterThan(1000);
  });
});

describe("pub/sub fan-out: determinism", () => {
  const scn = (): Scenario =>
    pubsub({
      produceRate: 120,
      groups: [
        { consumers: 4, consumeRatePerMs: 1 / 8 },
        { consumers: 2, consumeRatePerMs: 1 / 25 },
      ],
      seed: 4711,
    });

  it("golden-trace: two same-seed pub/sub runs are byte-identical", () => {
    const a = new MainThreadHost().run(scn(), { horizonMs: 12_000 });
    const b = new MainThreadHost().run(scn(), { horizonMs: 12_000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("replay-equivalence: resuming from a mid-flight snapshot equals a continuous run", () => {
    const cont = sim(scn());
    cont.run(12_000);
    const want = JSON.stringify(readNetworkCounters(cont.state, 12_000));

    const half = sim(scn());
    half.run(3100); // mid-run: per-group backlogs built, consumers in flight
    const resumed = Simulation.restore(half.snapshot(), createNetwork(scn()).handler, { recordTrace: false });
    resumed.run(12_000);
    expect(JSON.stringify(readNetworkCounters(resumed.state, 12_000))).toBe(want);
  });
});
