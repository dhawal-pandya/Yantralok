// Chaos & diagnostics: a network partition isolates a node (alive but unreachable,
// so calls across it fail), and root-cause attribution names the first-to-saturate
// tier during a cascade, not just the current max-ρ symptom.
import { describe, expect, it } from "vitest";
import { MainThreadHost } from "../host";
import type { Scenario } from "../scenario";
import { attributeRootCause, type WindowMetrics } from "./network";

describe("network partition", () => {
  // Entry -> backend. Partition the backend partway through; heal it later.
  const s = (interventions: Scenario["interventions"]): Scenario => ({
    seed: 1,
    stations: [
      { id: "api", servers: 1e9, serviceRatePerMs: 1000, queueCapacity: 1e9, deps: [{ to: 1, latencyMs: 2, timeoutMs: 1000 }] },
      { id: "backend", servers: 200, serviceRatePerMs: 1 / 5, queueCapacity: 1e9, deps: [] },
    ],
    arrivals: [{ station: 0, ratePerMs: 0.05 }],
    interventions,
  });

  it("a partition splits the graph and requests across it fail", () => {
    const r = new MainThreadHost().run(s([{ atMs: 5000, kind: "partition", station: 1 }]), {
      horizonMs: 10_000,
      sampleIntervalMs: 1000,
    });
    const before = r.windows[2]; // ~t=3s, healthy
    const after = r.windows[8]; // ~t=9s, partitioned
    expect(before.throughput).toBeGreaterThan(40);
    expect(before.failureRate).toBeLessThan(1);
    expect(after.throughput).toBeLessThan(5); // nothing crosses the partition
    expect(after.failureRate).toBeGreaterThan(40); // every request fails
  });

  it("restart heals the partition", () => {
    const r = new MainThreadHost().run(
      s([
        { atMs: 3000, kind: "partition", station: 1 },
        { atMs: 6000, kind: "restart", station: 1 },
      ]),
      { horizonMs: 10_000, sampleIntervalMs: 1000 },
    );
    expect(r.windows[4].failureRate).toBeGreaterThan(40); // partitioned at ~t=5s
    expect(r.windows[8].throughput).toBeGreaterThan(40); // recovered by ~t=9s
    expect(r.windows[8].failureRate).toBeLessThan(1);
  });
});

describe("root-cause attribution", () => {
  it("names the first-to-saturate tier under a cascade, not the max-ρ symptom", () => {
    // The classic cascade: Redis shields Postgres, so PG is idle. Kill Redis at 5s
    // and all reads flood a small PG pool (12 conns, 15ms => 800 req/s) at 900/s.
    // PG saturates first; then the API's 50 threads all block on it and the API
    // saturates too. Both tiers pin near ρ=1; the ORIGIN is PG.
    const s: Scenario = {
      seed: 3,
      stations: [
        {
          id: "api",
          servers: 50,
          serviceRatePerMs: 1 / 3,
          queueCapacity: 1e9,
          deps: [
            { to: 1, latencyMs: 1, shortCircuit: true, hitRatio: 1 }, // Redis: perfect shield
            { to: 2, latencyMs: 1 }, // Postgres on a miss
          ],
        },
        { id: "redis", servers: 1e9, serviceRatePerMs: 1, queueCapacity: 1e9, deps: [] },
        { id: "pg", servers: 12, serviceRatePerMs: 1 / 15, queueCapacity: 1e9, deps: [] },
      ],
      arrivals: [{ station: 0, ratePerMs: 0.9 }],
      interventions: [{ atMs: 5000, kind: "kill", station: 1 }],
    };
    const r = new MainThreadHost().run(s, { horizonMs: 20_000, sampleIntervalMs: 1000 });
    const tail = r.windows.slice(-6);
    // After the kill both tiers saturate, so max-ρ alone can't tell origin from symptom…
    expect(tail.every((w) => w.stations.find((st) => st.id === "pg")!.utilization > 0.85)).toBe(true);
    expect(tail.every((w) => w.stations.find((st) => st.id === "api")!.utilization > 0.85)).toBe(true);
    // …but the root cause consistently points at Postgres, the first to saturate.
    expect(tail.every((w) => w.rootCause === "pg")).toBe(true);
    // And it's a harder signal than max-ρ: the symptom tier (API) shows up as the
    // plain bottleneck in at least one window.
    expect(r.windows.some((w) => w.bottleneck === "api")).toBe(true);
  });

  it("is a pure function of the window series (deterministic, tie-broken by order)", () => {
    const windows: WindowMetrics[] = [
      { windowMs: 1000, throughput: 0, failureRate: 0, meanLatency: NaN, bottleneck: null, rootCause: null,
        stations: [
          { id: "a", utilization: 0.5, queue: 0, hitRate: NaN, calls: 0, instances: NaN, staleRate: NaN, backlog: NaN, consumeRate: NaN, newConns: NaN },
          { id: "b", utilization: 0.9, queue: 0, hitRate: NaN, calls: 0, instances: NaN, staleRate: NaN, backlog: NaN, consumeRate: NaN, newConns: NaN },
        ] },
      { windowMs: 1000, throughput: 0, failureRate: 0, meanLatency: NaN, bottleneck: null, rootCause: null,
        stations: [
          { id: "a", utilization: 0.95, queue: 0, hitRate: NaN, calls: 0, instances: NaN, staleRate: NaN, backlog: NaN, consumeRate: NaN, newConns: NaN },
          { id: "b", utilization: 0.95, queue: 0, hitRate: NaN, calls: 0, instances: NaN, staleRate: NaN, backlog: NaN, consumeRate: NaN, newConns: NaN },
        ] },
    ];
    attributeRootCause(windows);
    expect(windows[0].rootCause).toBe("b"); // only b was saturated first
    expect(windows[1].rootCause).toBe("b"); // b stayed saturated since window 0; a joined later
  });
});

describe("chaos determinism", () => {
  const s = (): Scenario => ({
    seed: 4711,
    stations: [
      { id: "api", servers: 40, serviceRatePerMs: 1 / 5, queueCapacity: 1e9, deps: [{ to: 1, latencyMs: 1, timeoutMs: 800, retries: 1 }] },
      { id: "pg", servers: 8, serviceRatePerMs: 1 / 15, queueCapacity: 1e9, deps: [] },
    ],
    arrivals: [{ station: 0, ratePerMs: 0.5 }],
    interventions: [{ atMs: 4000, kind: "partition", station: 1 }, { atMs: 9000, kind: "restart", station: 1 }],
  });

  it("golden-trace: two same-seed runs (with a partition) are byte-identical", () => {
    const a = new MainThreadHost().run(s(), { horizonMs: 14_000 });
    const b = new MainThreadHost().run(s(), { horizonMs: 14_000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
