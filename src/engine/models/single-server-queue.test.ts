import { describe, expect, it } from "vitest";
import { Simulation } from "../simulation";
import {
  computeQueueMetrics,
  initialQueueState,
  queueHandler,
  readQueueCounters,
  seedArrivals,
  type QueueMetrics,
  type QueueParams,
} from "./single-server-queue";

// Run an M/M/c sim and measure metrics over a post-warmup window.
function measure(
  params: QueueParams,
  opts: { seed: number; warmup: number; until: number },
): QueueMetrics {
  const sim = new Simulation({
    seed: opts.seed,
    initialState: initialQueueState(params),
    handler: queueHandler,
    init: seedArrivals,
    recordTrace: false,
  });
  sim.run(opts.warmup);
  const base = readQueueCounters(sim.state, sim.now);
  sim.run(opts.until);
  const end = readQueueCounters(sim.state, sim.now);
  return computeQueueMetrics(base, end, params.servers);
}

const within = (actual: number, expected: number, rel: number): void =>
  expect(Math.abs(actual - expected) / expected).toBeLessThan(rel);

describe("M/M/1 validation", () => {
  // Analytic M/M/1: W = 1/(μ-λ), Wq = ρ/(μ-λ), L = ρ/(1-ρ), util = ρ.
  for (const rho of [0.5, 0.8]) {
    it(`matches analytics at ρ=${rho}`, () => {
      const mu = 1;
      const lambda = rho * mu;
      const m = measure(
        { arrivalRate: lambda, serviceRate: mu, servers: 1, queueCapacity: Infinity },
        { seed: 2024, warmup: 20_000, until: 600_000 },
      );
      within(m.meanSojourn, 1 / (mu - lambda), 0.1);
      within(m.meanWait, rho / (mu - lambda), 0.1);
      within(m.meanInSystem, rho / (1 - rho), 0.1);
      within(m.utilization, rho, 0.05);
      within(m.throughput, lambda, 0.05);
    });
  }

  it("latency diverges as ρ -> 1", () => {
    const at = (rho: number): number =>
      measure(
        { arrivalRate: rho, serviceRate: 1, servers: 1, queueCapacity: Infinity },
        { seed: 7, warmup: 20_000, until: 400_000 },
      ).meanSojourn;
    const low = at(0.5);
    const mid = at(0.8);
    const high = at(0.95);
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
    expect(high).toBeGreaterThan(10); // analytic W(0.95) = 20
  });
});

describe("bounded queue", () => {
  it("rejects under overload", () => {
    const sim = new Simulation({
      seed: 1,
      initialState: initialQueueState({
        arrivalRate: 5,
        serviceRate: 1,
        servers: 1,
        queueCapacity: 5,
      }),
      handler: queueHandler,
      init: seedArrivals,
      recordTrace: false,
    });
    sim.run(5000);
    expect(sim.state.rejected).toBeGreaterThan(0);
    expect(sim.state.waiting.length).toBeLessThanOrEqual(5);
  });
});
