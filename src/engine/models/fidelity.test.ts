// Law validation for arrival shapes, service-time distributions, link jitter, and
// parallel fan-out. Realistic load and timing, still seeded and deterministic.
import { describe, expect, it } from "vitest";
import { Simulation } from "../simulation";
import { MainThreadHost } from "../host";
import type { Scenario, ScenarioStation } from "../scenario";
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

const wideStation = (id: string, serviceMs = 1): ScenarioStation => ({
  id,
  servers: 1e9,
  serviceRatePerMs: 1 / serviceMs,
  queueCapacity: 1e9,
  deps: [],
});

describe("arrival shapes (seeded non-homogeneous Poisson)", () => {
  it("burst: arrivals bunch inside the window", () => {
    const s: Scenario = {
      seed: 11,
      stations: [wideStation("s")],
      arrivals: [{ station: 0, ratePerMs: 0.05, shape: { kind: "burst", x: 10, startMs: 2000, durationMs: 2000 } }],
      interventions: [],
    };
    const m = sim(s);
    m.run(2000);
    const before = readNetworkCounters(m.state, 2000).stations[0].arrivals;
    m.run(4000);
    const inside = readNetworkCounters(m.state, 4000).stations[0].arrivals - before;
    expect(inside).toBeGreaterThan(before * 5); // ×10 rate, same window length
  });

  it("ramp: late traffic far exceeds early traffic", () => {
    const s: Scenario = {
      seed: 12,
      stations: [wideStation("s")],
      arrivals: [{ station: 0, ratePerMs: 0.2, shape: { kind: "ramp", rampMs: 8000 } }],
      interventions: [],
    };
    const m = sim(s);
    m.run(2000);
    const early = readNetworkCounters(m.state, 2000).stations[0].arrivals;
    m.run(8000);
    const mid = readNetworkCounters(m.state, 8000).stations[0].arrivals;
    m.run(10_000);
    const late = readNetworkCounters(m.state, 10_000).stations[0].arrivals - mid;
    expect(late).toBeGreaterThan(early * 3); // full rate vs the climb's first quarter
  });

  it("periodic: the mean rate over whole cycles stays the base rate", () => {
    const s: Scenario = {
      seed: 13,
      stations: [wideStation("s")],
      arrivals: [{ station: 0, ratePerMs: 0.2, shape: { kind: "periodic", periodMs: 5000, amplitude: 0.8 } }],
      interventions: [],
    };
    const m = sim(s);
    m.run(50_000); // 10 full cycles
    const total = readNetworkCounters(m.state, 50_000).stations[0].arrivals;
    expect(total).toBeGreaterThan(0.2 * 50_000 * 0.85);
    expect(total).toBeLessThan(0.2 * 50_000 * 1.15);
  });
});

describe("service-time distributions (same mean, different tail)", () => {
  const one = (dist: ScenarioStation["dist"], seed = 21): Scenario => ({
    seed,
    stations: [{ id: "s", servers: 1, serviceRatePerMs: 1 / 10, queueCapacity: 1e9, deps: [], dist }],
    arrivals: [{ station: 0, ratePerMs: 0.005 }], // ρ = 0.05: no queueing to speak of
    interventions: [],
  });
  const run = (dist: ScenarioStation["dist"]) =>
    new MainThreadHost().run(one(dist), { horizonMs: 400_000, sampleIntervalMs: 100_000 });

  const maxLat = (r: ReturnType<MainThreadHost["run"]>) =>
    r.spans.filter((sp) => sp.parent === null).reduce((a, sp) => Math.max(a, sp.end - sp.issue), 0);

  it("deterministic has no tail; lognormal's max dwarfs it at the same mean", () => {
    const det = run("deterministic");
    const logn = run("lognormal");
    // Same mean service (10ms): mean latencies land close together…
    expect(Math.abs(logn.totals.meanLatency - det.totals.meanLatency)).toBeLessThan(6);
    // …but the tails are different worlds (p99 ≠ mean, the exit criterion).
    expect(det.totals.meanLatency).toBeGreaterThan(9.5);
    expect(logn.totals.meanLatency).toBeGreaterThan(9);
    expect(maxLat(logn)).toBeGreaterThan(maxLat(det) * 2);
    expect(maxLat(logn)).toBeGreaterThan(40); // 4× the mean, from the tail alone
  });

  it("pareto produces rare extreme outliers", () => {
    const p = run("pareto");
    const pMax = p.spans.filter((sp) => sp.parent === null).reduce((a, sp) => Math.max(a, sp.end - sp.issue), 0);
    expect(pMax).toBeGreaterThan(50); // 5× the 10ms mean shows up in a long run
    expect(p.totals.meanLatency).toBeGreaterThan(8);
    expect(p.totals.meanLatency).toBeLessThan(14);
  });
});

describe("link jitter", () => {
  const chain = (jitterMs?: number): Scenario => ({
    seed: 31,
    stations: [
      { id: "a", servers: 1e9, serviceRatePerMs: 1000, queueCapacity: 1e9, deps: [{ to: 1, latencyMs: 10, jitterMs }] },
      wideStation("b"),
    ],
    arrivals: [{ station: 0, ratePerMs: 0.05 }],
    interventions: [],
  });

  it("jitter adds its mean to every leg of the round trip", () => {
    const plain = new MainThreadHost().run(chain(undefined), { horizonMs: 60_000 }).totals.meanLatency;
    const jittered = new MainThreadHost().run(chain(5), { horizonMs: 60_000 }).totals.meanLatency;
    const added = jittered - plain; // two legs × Exp(mean 5) ≈ +10ms
    expect(added).toBeGreaterThan(6);
    expect(added).toBeLessThan(15);
  });
});

describe("parallel fan-out (call-all-parallel)", () => {
  const fan = (parallel: boolean, seed = 41): Scenario => ({
    seed,
    stations: [
      {
        id: "caller",
        servers: 1e9,
        serviceRatePerMs: 1000,
        queueCapacity: 1e9,
        parallel: parallel || undefined,
        deps: [
          { to: 1, latencyMs: 10 },
          { to: 2, latencyMs: 20 },
          { to: 3, latencyMs: 40 },
        ],
      },
      wideStation("d1"),
      wideStation("d2"),
      wideStation("d3"),
    ],
    arrivals: [{ station: 0, ratePerMs: 0.05 }],
    interventions: [],
  });

  it("latency is the slowest branch, not the sum of branches", () => {
    const seq = new MainThreadHost().run(fan(false), { horizonMs: 60_000 }).totals.meanLatency;
    const par = new MainThreadHost().run(fan(true), { horizonMs: 60_000 }).totals.meanLatency;
    // sequential ≈ 2(10+20+40)=140+; parallel ≈ 2×40=80+services
    expect(seq).toBeGreaterThan(135);
    expect(par).toBeLessThan(seq * 0.75);
    expect(par).toBeGreaterThan(80);
  });

  it("a failed branch fails the call; each branch retries independently", () => {
    const s = fan(true, 42);
    s.stations[0].deps[1].retries = 3; // the dead branch amplifies ×(1+3)
    s.interventions = [{ atMs: 0, kind: "kill", station: 2 }];
    const m = sim(s);
    m.run(60_000);
    const c = readNetworkCounters(m.state, 60_000);
    const roots = c.stations[0].arrivals;
    expect(c.failures).toBeGreaterThan(roots * 0.95); // every call fails
    const deadRatio = c.stations[2].arrivals / roots;
    expect(deadRatio).toBeGreaterThan(4 - 0.3); // 1 + 3 retries on THAT branch
    expect(deadRatio).toBeLessThanOrEqual(4.01);
    // healthy branches were only issued once per call (no cross-amplification)
    expect(c.stations[1].arrivals / roots).toBeLessThanOrEqual(1.01);
  });

  it("a leading cache still short-circuits before the parallel fan-out", () => {
    const s = fan(true, 43);
    s.stations[0].deps = [
      { to: 1, latencyMs: 1, shortCircuit: true, hitRatio: 1 }, // perfect cache
      { to: 2, latencyMs: 20 },
      { to: 3, latencyMs: 40 },
    ];
    const m = sim(s);
    m.run(30_000);
    const c = readNetworkCounters(m.state, 30_000);
    expect(c.stations[1].arrivals).toBeGreaterThan(0);
    expect(c.stations[2].arrivals).toBe(0); // every read hit → fan-out never fired
    expect(c.stations[3].arrivals).toBe(0);
  });

  it("golden-trace + replay-equivalence hold with shapes, dists, jitter, and parallel", () => {
    const s: Scenario = {
      seed: 4711,
      stations: [
        {
          id: "api",
          servers: 50,
          serviceRatePerMs: 1 / 5,
          queueCapacity: 1e9,
          parallel: true,
          dist: "lognormal",
          deps: [
            { to: 1, latencyMs: 5, jitterMs: 2, retries: 1, timeoutMs: 500 },
            { to: 2, latencyMs: 10, jitterMs: 3, retries: 1, timeoutMs: 500 },
          ],
        },
        { id: "d1", servers: 20, serviceRatePerMs: 1 / 8, queueCapacity: 1e9, deps: [], dist: "pareto" },
        { id: "d2", servers: 20, serviceRatePerMs: 1 / 6, queueCapacity: 1e9, deps: [], dist: "deterministic" },
      ],
      arrivals: [{ station: 0, ratePerMs: 0.1, shape: { kind: "periodic", periodMs: 3000, amplitude: 0.6 } }],
      interventions: [],
    };
    const a = new MainThreadHost().run(s, { horizonMs: 12_000 });
    const b = new MainThreadHost().run(s, { horizonMs: 12_000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const cont = sim(s);
    cont.run(12_000);
    const want = JSON.stringify(readNetworkCounters(cont.state, 12_000));
    const half = sim(s);
    half.run(1700); // mid-flight branches + shaped arrivals in the heap
    const resumed = Simulation.restore(half.snapshot(), createNetwork(s).handler, { recordTrace: false });
    resumed.run(12_000);
    expect(JSON.stringify(readNetworkCounters(resumed.state, 12_000))).toBe(want);
  });
});
