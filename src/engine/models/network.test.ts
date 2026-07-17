import { describe, expect, it } from "vitest";
import { Simulation } from "../simulation";
import { MainThreadHost } from "../host";
import type { Scenario, ScenarioStation } from "../scenario";
import { createNetwork, readNetworkCounters, type NetworkState } from "./network";

const station = (
  id: string,
  servers: number,
  serviceTimeMs: number,
  deps: { to: number; latencyMs: number }[] = [],
  queueCapacity = 1e9,
): ScenarioStation => ({
  id,
  servers,
  serviceRatePerMs: 1 / serviceTimeMs,
  queueCapacity,
  deps,
});

describe("network engine: law validation", () => {
  it("a single station matches M/M/1: W ≈ 1/(μ−λ)", () => {
    // μ = 0.1/ms (10ms service), λ = 0.07/ms ⇒ ρ=0.7, W = 1/0.03 ≈ 33.33ms.
    const scenario: Scenario = {
      seed: 12345,
      stations: [station("s", 1, 10)],
      arrivals: [{ station: 0, ratePerMs: 0.07 }],
      interventions: [],
    };
    const result = new MainThreadHost().run(scenario, {
      horizonMs: 1_000_000,
      sampleIntervalMs: 250_000,
    });
    const expected = 1 / (0.1 - 0.07);
    expect(result.totals.meanLatency).toBeGreaterThan(expected * 0.88);
    expect(result.totals.meanLatency).toBeLessThan(expected * 1.12);
  });

  it("latency diverges as ρ → 1", () => {
    const run = (lambda: number) =>
      new MainThreadHost().run(
        {
          seed: 7,
          stations: [station("s", 1, 10)],
          arrivals: [{ station: 0, ratePerMs: lambda }],
          interventions: [],
        },
        { horizonMs: 500_000, sampleIntervalMs: 250_000 },
      ).totals.meanLatency;
    expect(run(0.095)).toBeGreaterThan(run(0.05) * 3); // ρ=0.95 vs ρ=0.5
  });
});

describe("network engine: determinism", () => {
  const demo: Scenario = {
    seed: 999,
    stations: [
      station("client", 1e9, 0.001, [{ to: 1, latencyMs: 1 }]),
      station("api", 200, 5, [{ to: 2, latencyMs: 1 }]),
      station("pg", 20, 8),
    ],
    arrivals: [{ station: 0, ratePerMs: 0.5 }],
    interventions: [],
  };

  it("golden-trace: two same-seed runs are byte-identical", () => {
    const a = new MainThreadHost().run(demo, { horizonMs: 5000 });
    const b = new MainThreadHost().run(demo, { horizonMs: 5000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("replay-equivalence: snapshot+replay equals a continuous run", () => {
    const T = 4000;
    const snapAt = 1500;

    const continuous = () => {
      const net = createNetwork(demo);
      const sim = new Simulation<NetworkState>({
        handler: net.handler,
        initialState: net.state,
        seed: demo.seed,
        init: net.init,
        recordTrace: false,
      });
      sim.run(T);
      return readNetworkCounters(sim.state, T);
    };

    const replayed = () => {
      const net = createNetwork(demo);
      const sim = new Simulation<NetworkState>({
        handler: net.handler,
        initialState: net.state,
        seed: demo.seed,
        init: net.init,
        recordTrace: false,
      });
      sim.run(snapAt);
      const sim2 = Simulation.restore(sim.snapshot(), net.handler, { recordTrace: false });
      sim2.run(T);
      return readNetworkCounters(sim2.state, T);
    };

    expect(JSON.stringify(replayed())).toBe(JSON.stringify(continuous()));
  });
});

describe("network engine: retry/timeout amplification law", () => {
  it("retries multiply load on a failing dependency by ≈ (1 + retries)", () => {
    const N = 3;
    const scenario: Scenario = {
      seed: 1,
      stations: [
        { id: "caller", servers: 1e9, serviceRatePerMs: 1000, queueCapacity: 1e9, deps: [{ to: 1, latencyMs: 1, retries: N }] },
        { id: "dep", servers: 1, serviceRatePerMs: 1 / 5, queueCapacity: 1e9, deps: [] },
      ],
      arrivals: [{ station: 0, ratePerMs: 0.05 }],
      interventions: [{ atMs: 0, kind: "kill", station: 1 }], // dep down from t=0
    };
    const net = createNetwork(scenario);
    const sim = new Simulation<NetworkState>({
      handler: net.handler,
      initialState: net.state,
      seed: scenario.seed,
      init: net.init,
      recordTrace: false,
    });
    sim.run(20_000);
    const c = readNetworkCounters(sim.state, 20_000);
    const ratio = c.stations[1].arrivals / c.stations[0].arrivals;
    expect(ratio).toBeGreaterThan(N + 1 - 0.2); // each request hits the dep 1+N times
    expect(ratio).toBeLessThanOrEqual(N + 1 + 0.01);
  });
});

describe("network engine: determinism with interventions", () => {
  const killed: Scenario = {
    seed: 314,
    stations: [
      station("client", 1e9, 0.001, [{ to: 1, latencyMs: 1 }]),
      station("api", 200, 5, [{ to: 2, latencyMs: 1 }]),
      station("pg", 4, 10),
    ],
    arrivals: [{ station: 0, ratePerMs: 0.3 }],
    interventions: [{ atMs: 2000, kind: "kill", station: 2 }],
  };

  it("golden-trace holds with an intervention applied", () => {
    const a = new MainThreadHost().run(killed, { horizonMs: 6000 });
    const b = new MainThreadHost().run(killed, { horizonMs: 6000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("replay across the kill equals a continuous run", () => {
    const mk = () => {
      const net = createNetwork(killed);
      return new Simulation<NetworkState>({
        handler: net.handler,
        initialState: net.state,
        seed: killed.seed,
        init: net.init,
        recordTrace: false,
      });
    };
    const cont = mk();
    cont.run(5000);
    const a = readNetworkCounters(cont.state, 5000);

    const s = mk();
    s.run(1500); // snapshot BEFORE the kill at 2000
    const s2 = Simulation.restore(s.snapshot(), createNetwork(killed).handler, { recordTrace: false });
    s2.run(5000);
    expect(JSON.stringify(readNetworkCounters(s2.state, 5000))).toBe(JSON.stringify(a));
  });
});

describe("network engine: emergent bottleneck", () => {
  // Postgres is the tight tier: 2 servers × 20ms ⇒ ~100 req/s capacity.
  const build = (ratePerMs: number): Scenario => ({
    seed: 42,
    stations: [
      station("client", 1e9, 0.001, [{ to: 1, latencyMs: 1 }]),
      station("api", 1000, 1, [{ to: 2, latencyMs: 1 }]),
      station("pg", 2, 20),
    ],
    arrivals: [{ station: 0, ratePerMs }],
    interventions: [],
  });

  it("under load the bottleneck is where the math says (Postgres), not the API", () => {
    // λ=90/s vs ~100/s capacity ⇒ ρ_pg≈0.9: high but stable, so Postgres is the
    // unambiguous max-ρ tier (at extreme overload everything cascades to ρ≈1).
    const r = new MainThreadHost().run(build(0.09), { horizonMs: 40_000, sampleIntervalMs: 1000 });
    const tail = r.windows.slice(-15);
    const meanUtil = (id: string) =>
      tail.reduce((a, w) => a + w.stations.find((s) => s.id === id)!.utilization, 0) / tail.length;

    expect(meanUtil("pg")).toBeGreaterThan(0.8); // saturated
    expect(meanUtil("pg")).toBeGreaterThan(meanUtil("api") + 0.3); // clearly the tier
    const pgIsBottleneck = tail.filter((w) => w.bottleneck === "pg").length;
    expect(pgIsBottleneck).toBeGreaterThan(tail.length / 2);
  });

  it("end-to-end latency rises with load", () => {
    const light = new MainThreadHost().run(build(0.04), { horizonMs: 30_000 }).totals.meanLatency;
    const heavy = new MainThreadHost().run(build(0.18), { horizonMs: 30_000 }).totals.meanLatency;
    expect(heavy).toBeGreaterThan(light * 2);
  });
});

describe("network engine: latency percentiles & breakdown", () => {
  const demo: Scenario = {
    seed: 55,
    stations: [
      station("client", 1e9, 0.001, [{ to: 1, latencyMs: 2 }]),
      station("api", 50, 5),
    ],
    arrivals: [{ station: 0, ratePerMs: 0.05 }],
    interventions: [],
  };

  it("one latencyWindow per window, percentiles ordered p50 ≤ p95 ≤ p99", () => {
    const r = new MainThreadHost().run(demo, { horizonMs: 20_000, sampleIntervalMs: 2000 });
    expect(r.latencyWindows.length).toBe(r.windows.length);
    const withData = r.latencyWindows.filter((l) => Number.isFinite(l.p50));
    expect(withData.length).toBeGreaterThan(0);
    for (const l of withData) {
      expect(l.p95).toBeGreaterThanOrEqual(l.p50);
      expect(l.p99).toBeGreaterThanOrEqual(l.p95);
    }
  });

  it("breakdown's network time matches the configured round-trip link latency, excluding the root's own (zero) hop", () => {
    const r = new MainThreadHost().run(demo, { horizonMs: 20_000, sampleIntervalMs: 2000 });
    const withData = r.latencyWindows.filter((l) => Number.isFinite(l.netMs));
    expect(withData.length).toBeGreaterThan(0);
    for (const l of withData) expect(l.netMs).toBeCloseTo(4, 0); // 2ms one-way × 2 legs
  });

  it("golden-trace holds with the new latency/breakdown data included", () => {
    const a = new MainThreadHost().run(demo, { horizonMs: 8000 });
    const b = new MainThreadHost().run(demo, { horizonMs: 8000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("breakdown stays populated in late windows, past the span budget (regression)", () => {
    // ~500 req/s × 2 spans/req exhausts the 8000-span cap within the first few
    // seconds; the breakdown is diffed from cumulative counters, not spans, so it
    // must still have data at the end of a long run.
    const busy: Scenario = {
      seed: 7,
      stations: [
        station("client", 1e9, 0.001, [{ to: 1, latencyMs: 2 }]),
        station("api", 200, 3),
      ],
      arrivals: [{ station: 0, ratePerMs: 0.5 }],
      interventions: [],
    };
    const r = new MainThreadHost().run(busy, { horizonMs: 30_000, sampleIntervalMs: 1000 });
    expect(r.spans.length).toBeLessThanOrEqual(8000); // span capture did cap
    const last = r.latencyWindows[r.latencyWindows.length - 1];
    expect(Number.isFinite(last.netMs)).toBe(true);
    expect(Number.isFinite(last.queueMs)).toBe(true);
    expect(Number.isFinite(last.serviceMs)).toBe(true);
    expect(last.netMs).toBeCloseTo(4, 0); // 2ms one-way × 2 legs, unaffected by the cap
  });
});
