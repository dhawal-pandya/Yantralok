// Richer resource model law validation: CPU contention. A station's own service
// time inflates with utilization (effective = base × (1 + contention × ρ)), so a
// CPU-bound tier slows down with load before its queue saturates. Deterministic
// (a multiply on the seeded draw), gated so an uncontended box is byte-identical.
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

// One CPU-bound box: 10 servers × 10ms deterministic service = 1000 req/s capacity.
const box = (k: number, rate: number, seed = 5): Scenario => ({
  seed,
  stations: [
    {
      id: "api",
      servers: 10,
      serviceRatePerMs: 1 / 10,
      queueCapacity: 1e9,
      deps: [],
      dist: "deterministic", // isolate the contention effect from service-time noise
      cpuContention: k || undefined,
    },
  ],
  arrivals: [{ station: 0, ratePerMs: rate }],
  interventions: [],
});

const lat = (k: number, rate: number) =>
  new MainThreadHost().run(box(k, rate), { horizonMs: 60_000 }).totals.meanLatency;

describe("CPU contention", () => {
  it("a CPU-bound tier's latency rises with load, before ρ hits 1", () => {
    // Low load (ρ ≈ 0.1): few concurrent requests, so contention barely bites.
    expect(Math.abs(lat(1, 0.1) - lat(0, 0.1))).toBeLessThan(4);
    // Moderate load (ρ_base ≈ 0.5, well under 1): contention clearly inflates the
    // service time and the latency with it.
    const base = lat(0, 0.5);
    const cont = lat(1, 0.5);
    expect(cont).toBeGreaterThan(base * 1.4);
  });

  it("the slowdown grows with contention strength", () => {
    const l0 = lat(0, 0.5);
    const l1 = lat(0.5, 0.5);
    const l2 = lat(1.5, 0.5);
    expect(l1).toBeGreaterThan(l0);
    expect(l2).toBeGreaterThan(l1); // more contention, more slowdown
  });

  it("is gated: contention 0 is byte-identical, and determinism holds when on", () => {
    const off = new MainThreadHost().run(box(0, 0.4, 9), { horizonMs: 20_000 });
    const offUnset = new MainThreadHost().run(
      { ...box(0, 0.4, 9), stations: [{ ...box(0, 0.4, 9).stations[0], cpuContention: undefined }] },
      { horizonMs: 20_000 },
    );
    expect(JSON.stringify(off)).toBe(JSON.stringify(offUnset));

    const a = new MainThreadHost().run(box(1.2, 0.5, 42), { horizonMs: 20_000 });
    const b = new MainThreadHost().run(box(1.2, 0.5, 42), { horizonMs: 20_000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const cont = sim(box(1.2, 0.5, 42));
    cont.run(20_000);
    const want = JSON.stringify(readNetworkCounters(cont.state, 20_000));
    const half = sim(box(1.2, 0.5, 42));
    half.run(4300);
    const resumed = Simulation.restore(half.snapshot(), createNetwork(box(1.2, 0.5, 42)).handler, { recordTrace: false });
    resumed.run(20_000);
    expect(JSON.stringify(readNetworkCounters(resumed.state, 20_000))).toBe(want);
  });
});
