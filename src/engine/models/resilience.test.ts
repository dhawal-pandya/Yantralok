// Resilience mechanics: retry backoff + jitter and the circuit breaker. Retries
// used to be immediate and unstoppable; now they can be spaced out (backoff) and
// cut off (breaker). Still seeded and deterministic: the breaker consumes no PRNG,
// backoff draws only when it's enabled.
import { describe, expect, it } from "vitest";
import { Simulation } from "../simulation";
import { MainThreadHost } from "../host";
import type { BreakerConfig, Scenario } from "../scenario";
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

// A caller (no bottleneck of its own) → one backend, with retries. The backend is
// killed at t=0 so every attempt fails: the retry storm the breaker must stop.
const chain = (opts: {
  seed?: number;
  retries?: number;
  backoffMs?: number;
  breaker?: BreakerConfig;
  killAt?: number;
  restartAt?: number;
}): Scenario => {
  const interventions = [];
  if (opts.killAt !== undefined) interventions.push({ atMs: opts.killAt, kind: "kill" as const, station: 1 });
  if (opts.restartAt !== undefined) interventions.push({ atMs: opts.restartAt, kind: "restart" as const, station: 1 });
  return {
    seed: opts.seed ?? 7,
    stations: [
      {
        id: "caller",
        servers: 1e9,
        serviceRatePerMs: 1000,
        queueCapacity: 1e9,
        deps: [
          {
            to: 1,
            latencyMs: 1,
            retries: opts.retries ?? 3,
            backoffMs: opts.backoffMs,
            breaker: opts.breaker,
          },
        ],
      },
      { id: "backend", servers: 20, serviceRatePerMs: 1 / 5, queueCapacity: 1e9, deps: [] },
    ],
    arrivals: [{ station: 0, ratePerMs: 0.05 }], // ~50 req/s
    interventions,
  };
};

const BREAKER: BreakerConfig = { threshold: 0.5, minCalls: 20, windowMs: 2000, cooldownMs: 3000 };

describe("circuit breaker", () => {
  it("stops a retry storm: an OPEN breaker slashes load on a dead dependency", () => {
    const noBreaker = sim(chain({ retries: 3, killAt: 0, seed: 1 }));
    noBreaker.run(20_000);
    const stormed = readNetworkCounters(noBreaker.state, 20_000);
    const roots = stormed.stations[0].arrivals;
    // No breaker: every root re-issues 3× → ~4× the load lands on the dead backend.
    expect(stormed.stations[1].arrivals).toBeGreaterThan(roots * 3.5);

    const withBreaker = sim(chain({ retries: 3, breaker: BREAKER, killAt: 0, seed: 1 }));
    withBreaker.run(20_000);
    const guarded = readNetworkCounters(withBreaker.state, 20_000);
    // Breaker: after ~minCalls failures it opens; the rest fast-fail without ever
    // touching the backend, so backend load collapses to the trip cost + a few probes.
    expect(guarded.stations[1].arrivals).toBeLessThan(100);
    // Same offered load, two orders of magnitude less pressure on the failing tier.
    expect(guarded.stations[1].arrivals).toBeLessThan(stormed.stations[1].arrivals / 20);
  });

  it("does not trip below the minimum call volume (no trip on a single error)", () => {
    // A backend that fails only briefly: too few failures to reach minCalls in the
    // window, so the breaker stays closed and the (rare) misses just fall through.
    const s = chain({ retries: 0, breaker: BREAKER, killAt: 0, restartAt: 50, seed: 2 });
    const m = sim(s);
    m.run(20_000);
    const c = readNetworkCounters(m.state, 20_000);
    // Almost everything completes: the breaker never opened on the tiny blip.
    expect(c.completions).toBeGreaterThan(c.stations[0].arrivals * 0.9);
  });

  it("recovers via a half-open probe once the dependency comes back", () => {
    // Killed through 5s, then restarted. The breaker opens during the outage but a
    // probe after cooldown finds the backend healthy again and closes it.
    const m = new MainThreadHost().run(chain({ retries: 3, breaker: BREAKER, killAt: 0, restartAt: 5000, seed: 3 }), {
      horizonMs: 20_000,
      sampleIntervalMs: 1000,
    });
    const late = m.windows.slice(12); // after ~12s, well past recovery
    const lateThroughput = late.reduce((a, w) => a + w.throughput, 0) / late.length;
    expect(lateThroughput).toBeGreaterThan(30); // back near the ~50 req/s offered load
    // And the early outage window really was failing (proves the recovery is real).
    expect(m.windows.slice(0, 4).reduce((a, w) => a + w.throughput, 0)).toBeLessThan(5);
  });
});

describe("retry backoff + jitter", () => {
  const rootDuration = (r: ReturnType<MainThreadHost["run"]>): number => {
    const roots = r.spans.filter((sp) => sp.parent === null);
    return roots.reduce((a, sp) => a + (sp.end - sp.issue), 0) / Math.max(1, roots.length);
  };

  it("spaces retries out in time: a backed-off request takes far longer to give up", () => {
    // Dead backend, 5 retries, low rate so requests don't interfere. Without
    // backoff a request burns all attempts almost instantly; with backoff each
    // attempt waits an exponentially growing (jittered) delay first.
    const opts = { retries: 5, killAt: 0, seed: 9 };
    const immediate = new MainThreadHost().run(chain({ ...opts }), { horizonMs: 15_000 });
    const backed = new MainThreadHost().run(chain({ ...opts, backoffMs: 200 }), { horizonMs: 15_000 });
    expect(rootDuration(immediate)).toBeLessThan(30); // ~6 attempts × a couple ms of link
    expect(rootDuration(backed)).toBeGreaterThan(rootDuration(immediate) * 10);
    expect(rootDuration(backed)).toBeGreaterThan(500); // the growing backoff chain dominates
  });

  it("is gated: with backoff 0 no PRNG is drawn, so the trace is byte-identical", () => {
    // The retry path with backoffMs unset must match a run that never had the knob.
    const base = new MainThreadHost().run(chain({ retries: 3, killAt: 0, seed: 5 }), { horizonMs: 8000 });
    const zero = new MainThreadHost().run(chain({ retries: 3, backoffMs: 0, killAt: 0, seed: 5 }), { horizonMs: 8000 });
    expect(JSON.stringify(zero)).toBe(JSON.stringify(base));
  });
});

describe("determinism with backoff + breaker active", () => {
  const s = (): Scenario => chain({ retries: 4, backoffMs: 150, breaker: BREAKER, killAt: 0, restartAt: 4000, seed: 4711 });

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
    half.run(2300); // mid-storm: retries backing off, breaker open, a restart pending
    const resumed = Simulation.restore(half.snapshot(), createNetwork(s()).handler, { recordTrace: false });
    resumed.run(12_000);
    expect(JSON.stringify(readNetworkCounters(resumed.state, 12_000))).toBe(want);
  });
});
