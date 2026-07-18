// Connection lifecycle law validation: opening a new connection pays a TLS
// handshake plus a (cacheable) DNS lookup, while a warm keep-alive connection
// reuses the pool and skips both. So a cold path pays the handshake and a warm one
// doesn't, and slowing DNS lengthens new connections but not pooled ones.
import { describe, expect, it } from "vitest";
import { Simulation } from "../simulation";
import { MainThreadHost } from "../host";
import type { ConnectionConfig, Scenario } from "../scenario";
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

// caller -> backend over a link, both effectively instant so the observed latency
// is the two 2ms legs plus whatever a cold connection adds to the outbound leg.
const link = (conn?: Partial<ConnectionConfig>, rate = 0.02, seed = 7): Scenario => ({
  seed,
  stations: [
    {
      id: "caller",
      servers: 1e9,
      serviceRatePerMs: 1000,
      queueCapacity: 1e9,
      deps: [
        {
          to: 1,
          latencyMs: 2,
          connection: conn
            ? { handshakeMs: 0, dnsMs: 0, dnsTtlMs: 30000, poolSize: 8, ...conn }
            : undefined,
        },
      ],
    },
    { id: "backend", servers: 1e9, serviceRatePerMs: 1000, queueCapacity: 1e9, deps: [] },
  ],
  arrivals: [{ station: 0, ratePerMs: rate }],
  interventions: [],
});

const meanLat = (r: ReturnType<MainThreadHost["run"]>) => r.totals.meanLatency;

describe("connection lifecycle: cold vs warm", () => {
  it("a cold path pays the handshake, a warm path amortizes it away", () => {
    // Warm: a keep-alive pool larger than the (sequential) concurrency, so after the
    // first request every call reuses a connection.
    const warm = new MainThreadHost().run(link({ handshakeMs: 40, poolSize: 8 }), { horizonMs: 60_000 });
    // Cold: no pool, so every call opens a fresh connection and pays the handshake.
    const cold = new MainThreadHost().run(link({ handshakeMs: 40, poolSize: 0 }), { horizonMs: 60_000 });
    expect(meanLat(warm)).toBeLessThan(15); // ≈ 4ms of legs, handshake amortized
    expect(meanLat(cold)).toBeGreaterThan(40); // ≈ 4ms + 40ms handshake every call
  });

  it("a warm pool opens few connections; a poolless caller opens one per request", () => {
    const warm = sim(link({ handshakeMs: 40, poolSize: 8 }));
    warm.run(30_000);
    const w = readNetworkCounters(warm.state, 30_000);
    const cold = sim(link({ handshakeMs: 40, poolSize: 0 }));
    cold.run(30_000);
    const c = readNetworkCounters(cold.state, 30_000);
    const reqs = c.stations[1].arrivals;
    expect(w.stations[0].handshakes).toBeLessThan(reqs * 0.2); // mostly reused
    expect(c.stations[0].handshakes).toBeGreaterThan(reqs * 0.95); // one per request
  });
});

describe("connection lifecycle: DNS", () => {
  it("slowing DNS lengthens new connections but not pooled ones", () => {
    // Cold caller (poolSize 0, TTL 0 so every new connection re-resolves): DNS cost
    // lands on every request.
    const coldFast = new MainThreadHost().run(link({ dnsMs: 0, dnsTtlMs: 0, poolSize: 0 }), { horizonMs: 40_000 });
    const coldSlow = new MainThreadHost().run(link({ dnsMs: 40, dnsTtlMs: 0, poolSize: 0 }), { horizonMs: 40_000 });
    expect(meanLat(coldSlow) - meanLat(coldFast)).toBeGreaterThan(30); // ~+40ms per call

    // Warm caller (pooled): reused connections never resolve, so slow DNS is invisible.
    const warmFast = new MainThreadHost().run(link({ dnsMs: 0, poolSize: 8 }), { horizonMs: 40_000 });
    const warmSlow = new MainThreadHost().run(link({ dnsMs: 40, poolSize: 8 }), { horizonMs: 40_000 });
    expect(Math.abs(meanLat(warmSlow) - meanLat(warmFast))).toBeLessThan(6);
  });

  it("a cached resolution is reused within its TTL, even for new connections", () => {
    // poolSize 0 forces a new connection every call, but a long TTL means only the
    // first resolves; a zero TTL re-resolves each time.
    const cached = new MainThreadHost().run(link({ dnsMs: 40, dnsTtlMs: 1e9, poolSize: 0 }), { horizonMs: 40_000 });
    const uncached = new MainThreadHost().run(link({ dnsMs: 40, dnsTtlMs: 0, poolSize: 0 }), { horizonMs: 40_000 });
    expect(meanLat(uncached) - meanLat(cached)).toBeGreaterThan(30); // the DNS cost, every call vs once
  });
});

describe("connection lifecycle: determinism", () => {
  // Concurrent enough that the pool churns: handshakes happen throughout the run.
  const s = (): Scenario => link({ handshakeMs: 25, dnsMs: 10, dnsTtlMs: 4000, poolSize: 3 }, 0.1, 4711);

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
    half.run(2600);
    const resumed = Simulation.restore(half.snapshot(), createNetwork(s()).handler, { recordTrace: false });
    resumed.run(12_000);
    expect(JSON.stringify(readNetworkCounters(resumed.state, 12_000))).toBe(want);
  });

  it("no connection config leaves the run byte-identical", () => {
    const a = new MainThreadHost().run(link(undefined, 0.05, 3), { horizonMs: 8000 });
    const b = new MainThreadHost().run(link(undefined, 0.05, 3), { horizonMs: 8000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.totals.completions).toBeGreaterThan(0);
  });
});
