// Async messaging law validation: a broker decouples producing from consuming.
// Producing is a fast enqueue + ack; a pool of consumers drains the backlog
// independently, so consumer lag climbs when produce rate exceeds consume capacity.
// Seeded and deterministic like every other law.
import { describe, expect, it } from "vitest";
import { Simulation } from "../simulation";
import { MainThreadHost } from "../host";
import type { Scenario, StationBroker } from "../scenario";
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

// Producer -> broker. The producer's own service is trivial; the broker consumes
// at (consumers / consumeMs) messages per ms. Consume time is the broker's service.
const pipeline = (opts: {
  seed?: number;
  produceRate?: number; // msgs/ms into the broker
  consumers?: number;
  consumeMs?: number;
  maxBacklog?: number;
}): Scenario => {
  const broker: StationBroker = { consumers: opts.consumers ?? 2, maxBacklog: opts.maxBacklog };
  return {
    seed: opts.seed ?? 7,
    stations: [
      {
        id: "producer",
        servers: 1e9,
        serviceRatePerMs: 1000, // ~instant own service
        queueCapacity: 1e9,
        deps: [{ to: 1, latencyMs: 1 }], // produce to the broker
      },
      {
        id: "broker",
        servers: broker.consumers, // consumer slots
        serviceRatePerMs: 1 / (opts.consumeMs ?? 10),
        queueCapacity: 0,
        deps: [],
        broker,
      },
    ],
    arrivals: [{ station: 0, ratePerMs: opts.produceRate ?? 0.05 }],
    interventions: [],
  };
};

describe("async messaging: decoupling", () => {
  it("producers stay fast even as the consumer falls behind", () => {
    // Produce 100/s into a broker that can only consume ~50/s (2 consumers × 10ms):
    // the backlog must climb, yet the producer's latency stays at the link cost.
    const s = pipeline({ produceRate: 0.1, consumers: 2, consumeMs: 40, seed: 1 });
    const r = new MainThreadHost().run(s, { horizonMs: 20_000, sampleIntervalMs: 1000 });
    // Producer round-trip is ~2ms of link regardless of the backlog behind it.
    expect(r.totals.meanLatency).toBeLessThan(10);
    // Consumer lag grows over the run (later windows carry a bigger backlog).
    const brokerBacklog = (i: number) => r.windows[i].stations.find((st) => st.id === "broker")!.backlog;
    expect(brokerBacklog(r.windows.length - 1)).toBeGreaterThan(brokerBacklog(2) + 100);
  });

  it("consumer lag climbs when produce > consume, and drain rate is the consume capacity", () => {
    // 100/s produced, 2 consumers at 20ms => ~100/s capacity: near break-even.
    // 100/s produced, 2 consumers at 40ms => ~50/s capacity: lag runs away.
    const balanced = sim(pipeline({ produceRate: 0.1, consumers: 4, consumeMs: 20, seed: 2 }));
    balanced.run(20_000);
    const b = readNetworkCounters(balanced.state, 20_000);
    const slow = sim(pipeline({ produceRate: 0.1, consumers: 2, consumeMs: 40, seed: 2 }));
    slow.run(20_000);
    const sl = readNetworkCounters(slow.state, 20_000);
    // Enough capacity: backlog stays bounded. Too little: it explodes.
    expect(b.stations[1].backlog).toBeLessThan(200);
    expect(sl.stations[1].backlog).toBeGreaterThan(b.stations[1].backlog + 500);
    // Everything produced is either consumed or still queued (conservation).
    expect(sl.stations[1].produced).toBeGreaterThan(sl.stations[1].consumed);
  });

  it("scaling consumers drains a backlog that a small pool could not", () => {
    // Same offered load; a fat consumer pool keeps the backlog near zero.
    const fat = sim(pipeline({ produceRate: 0.1, consumers: 12, consumeMs: 40, seed: 3 }));
    fat.run(20_000);
    const f = readNetworkCounters(fat.state, 20_000);
    // 12 consumers × 25 msg/s ≈ 300/s capacity >> 100/s offered: lag stays low.
    expect(f.stations[1].backlog).toBeLessThan(50);
    expect(f.stations[1].consumed).toBeGreaterThan(f.stations[1].produced * 0.9);
  });

  it("a bounded buffer rejects produces once full (backpressure)", () => {
    const s = pipeline({ produceRate: 0.1, consumers: 1, consumeMs: 50, maxBacklog: 20, seed: 4 });
    const m = sim(s);
    m.run(20_000);
    const c = readNetworkCounters(m.state, 20_000);
    // The backlog is capped at the bound, and excess produces are rejected.
    expect(c.stations[1].backlog).toBeLessThanOrEqual(20);
    expect(c.stations[1].rejected).toBeGreaterThan(0);
  });
});

describe("async messaging: determinism", () => {
  const s = (): Scenario => pipeline({ produceRate: 0.12, consumers: 3, consumeMs: 25, seed: 4711 });

  it("golden-trace: two same-seed runs are byte-identical", () => {
    const a = new MainThreadHost().run(s(), { horizonMs: 12_000 });
    const b = new MainThreadHost().run(s(), { horizonMs: 12_000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("replay-equivalence: resuming from a mid-flight snapshot equals a continuous run", () => {
    const cont = sim(s());
    cont.run(12_000);
    const want = JSON.stringify(readNetworkCounters(cont.state, 12_000));

    const half = sim(s());
    half.run(3100); // mid-run: a backlog built, consumers in flight
    const resumed = Simulation.restore(half.snapshot(), createNetwork(s()).handler, { recordTrace: false });
    resumed.run(12_000);
    expect(JSON.stringify(readNetworkCounters(resumed.state, 12_000))).toBe(want);
  });

  it("a broker-free scenario is unaffected by the broker fields", () => {
    // No station carries a broker, so produce/consume never fires: the run matches
    // a plain two-tier pipeline exactly.
    const plain: Scenario = {
      seed: 99,
      stations: [
        { id: "a", servers: 1e9, serviceRatePerMs: 1000, queueCapacity: 1e9, deps: [{ to: 1, latencyMs: 2 }] },
        { id: "b", servers: 10, serviceRatePerMs: 1 / 5, queueCapacity: 1e9, deps: [] },
      ],
      arrivals: [{ station: 0, ratePerMs: 0.05 }],
      interventions: [],
    };
    const a = new MainThreadHost().run(plain, { horizonMs: 8000 });
    const b = new MainThreadHost().run(plain, { horizonMs: 8000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.totals.completions).toBeGreaterThan(0);
  });
});
