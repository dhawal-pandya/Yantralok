import { describe, expect, it } from "vitest";
import type { RunResult, StationMetric, WindowMetrics } from "@/engine";
import type { SystemDoc } from "@/schema";
import { estimateCost, fmtUSD, HOURS_PER_MONTH } from "./cost";

const doc = (
  nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }>,
): SystemDoc => ({
  schemaVersion: 1,
  id: "sys-test",
  name: "test",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  seed: 1,
  graph: {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: 0, y: 0 },
      config: n.config ?? {},
    })),
    edges: [],
  },
  workloads: [],
  interventions: [],
});

const station = (
  id: string,
  calls: number,
  instances = NaN,
): StationMetric => ({
  id,
  utilization: 0.5,
  queue: 0,
  hitRate: NaN,
  calls,
  instances,
  staleRate: NaN,
  backlog: NaN,
  consumeRate: NaN,
  newConns: NaN,
});

// A run whose windows carry the given per-station (calls, instances) samples.
function run(
  samples: Record<string, Array<{ calls: number; instances?: number }>>,
): RunResult {
  const stationIds = Object.keys(samples);
  const count = samples[stationIds[0]]?.length ?? 0;
  const windows: WindowMetrics[] = Array.from({ length: count }, (_, i) => ({
    windowMs: 100,
    throughput: 0,
    failureRate: 0,
    meanLatency: NaN,
    stations: stationIds.map((id) =>
      station(id, samples[id][i].calls, samples[id][i].instances ?? NaN),
    ),
    bottleneck: null,
    rootCause: null,
  }));
  return {
    horizonMs: 15000,
    sampleIntervalMs: 100,
    stationIds,
    times: windows.map((_, i) => (i + 1) * 100),
    windows,
    latencyWindows: [],
    segments: [],
    spans: [],
    totals: { completions: 0, failures: 0, meanLatency: NaN },
  };
}

describe("estimateCost", () => {
  it("bills fixed-hourly infra by instance count (primary + replicas)", () => {
    const d = doc([
      { id: "pg", type: "postgres", config: { replicas: 2, storageGB: 0 } },
    ]);
    const { nodes, hourly } = estimateCost(d, run({ pg: [{ calls: 100 }] }));
    expect(nodes).toHaveLength(1);
    expect(nodes[0].instances).toBe(3);
    expect(nodes[0].infraHourly).toBeCloseTo(3 * 0.178);
    expect(nodes[0].usageHourly).toBe(0);
    expect(hourly).toBeCloseTo(3 * 0.178);
  });

  it("sizes the billed shape from the capacity knob (one m5.large per 200 threads)", () => {
    const d = doc([
      { id: "big", type: "api", config: { concurrency: 400 } },
      { id: "std", type: "api", config: { concurrency: 200 } },
    ]);
    const { nodes } = estimateCost(
      d,
      run({ big: [{ calls: 0 }], std: [{ calls: 0 }] }),
    );
    expect(nodes.find((n) => n.id === "big")?.instances).toBe(2);
    expect(nodes.find((n) => n.id === "big")?.infraHourly).toBeCloseTo(
      2 * 0.096,
    );
    expect(nodes.find((n) => n.id === "std")?.instances).toBe(1);
  });

  it("multiplies capacity sizing into the replica fleet", () => {
    // 2 read replicas + primary, each sized at 2 shapes (200 conns / 100 per shape).
    const d = doc([
      {
        id: "pg",
        type: "postgres",
        config: { replicas: 2, maxConnections: 200, storageGB: 0 },
      },
    ]);
    const { nodes } = estimateCost(d, run({ pg: [{ calls: 0 }] }));
    expect(nodes[0].instances).toBe(6);
    expect(nodes[0].infraHourly).toBeCloseTo(6 * 0.178);
  });

  it("bills stored data at the GB-month rate", () => {
    const d = doc([{ id: "pg", type: "postgres", config: { storageGB: 200 } }]);
    const { nodes } = estimateCost(d, run({ pg: [{ calls: 0 }] }));
    expect(nodes[0].infraHourly).toBeCloseTo(
      0.178 + (200 * 0.115) / HOURS_PER_MONTH,
    );
  });

  it("bills queue messages as 3 API calls and egress at the avg object size", () => {
    const d = doc([
      { id: "q", type: "sqs" },
      { id: "edge", type: "cdn", config: { avgObjectKB: 100 } },
    ]);
    const { nodes } = estimateCost(
      d,
      run({ q: [{ calls: 10 }], edge: [{ calls: 100 }] }),
    );
    expect(nodes.find((n) => n.id === "q")?.usageHourly).toBeCloseTo(
      (10 * 3 * 3600 * 0.4) / 1e6,
    );
    // 100 req/s × 100 KB × 3600 = 36 GB/h of egress, plus the request charge.
    const cdn = nodes.find((n) => n.id === "edge")!;
    expect(cdn.usageHourly).toBeCloseTo(36 * 0.085 + (100 * 3600 * 0.75) / 1e6);
  });

  it("bills egress at the node's own rate when overridden (owned-CDN economics)", () => {
    const d = doc([
      {
        id: "edge",
        type: "cdn",
        config: { avgObjectKB: 100, egressRatePerGB: 0.008 },
      },
    ]);
    const { nodes } = estimateCost(d, run({ edge: [{ calls: 100 }] }));
    expect(nodes[0].usageHourly).toBeCloseTo(
      36 * 0.008 + (100 * 3600 * 0.75) / 1e6,
    );
  });

  it("bills usage-priced components at the measured mean request rate", () => {
    const d = doc([{ id: "dns", type: "dns" }]);
    // 50 and 150 req/s across two windows: mean 100 req/s.
    const { nodes } = estimateCost(
      d,
      run({ dns: [{ calls: 50 }, { calls: 150 }] }),
    );
    expect(nodes[0].reqPerSec).toBeCloseTo(100);
    expect(nodes[0].usageHourly).toBeCloseTo((100 * 3600 * 0.4) / 1e6);
    expect(nodes[0].infraHourly).toBe(0);
  });

  it("uses the measured mean fleet size for an autoscaled tier", () => {
    const d = doc([
      { id: "api", type: "api", config: { autoscale: true, minInstances: 1 } },
    ]);
    const { nodes } = estimateCost(
      d,
      run({
        api: [
          { calls: 0, instances: 2 },
          { calls: 0, instances: 4 },
        ],
      }),
    );
    expect(nodes[0].instances).toBeCloseTo(3);
    expect(nodes[0].infraHourly).toBeCloseTo(3 * 0.096);
  });

  it("counts quorum peer nodes and search shards as instances", () => {
    const d = doc([
      {
        id: "cas",
        type: "cassandra",
        config: { quorumReplication: true, nodes: 6 },
      },
      { id: "es", type: "elasticsearch", config: { shards: 5 } },
    ]);
    const { nodes } = estimateCost(
      d,
      run({ cas: [{ calls: 0 }], es: [{ calls: 0 }] }),
    );
    expect(nodes.find((n) => n.id === "cas")?.instances).toBe(6);
    expect(nodes.find((n) => n.id === "es")?.instances).toBe(5);
  });

  it("bills lambda per request plus measured compute time", () => {
    const d = doc([{ id: "fn", type: "lambda", config: { serviceTime: 30 } }]);
    const { nodes } = estimateCost(d, run({ fn: [{ calls: 10 }] }));
    const requests = (10 * 3600 * 0.2) / 1e6;
    const compute = 10 * 3600 * 0.03 * 0.0000166667;
    expect(nodes[0].usageHourly).toBeCloseTo(requests + compute);
  });

  it("excludes traffic sources and sorts billed nodes costliest first", () => {
    const d = doc([
      { id: "c", type: "client" },
      { id: "dns", type: "dns" },
      { id: "pg", type: "postgres" },
    ]);
    const est = estimateCost(
      d,
      run({ c: [{ calls: 0 }], dns: [{ calls: 10 }], pg: [{ calls: 10 }] }),
    );
    expect(est.nodes.map((n) => n.id)).toEqual(["pg", "dns"]);
    expect(est.hourly).toBeCloseTo(est.nodes.reduce((a, n) => a + n.hourly, 0));
    expect(est.measuredMs).toBe(15000);
  });

  it("flags non-steady sources whose window can't extrapolate fairly", () => {
    const d = doc([
      { id: "burst", type: "client", config: { pattern: "burst" } },
      { id: "steady", type: "client", config: { pattern: "constant" } },
      {
        id: "diurnal",
        type: "client",
        config: { pattern: "periodic", periodMs: 5000 },
      },
      {
        id: "slow",
        type: "browser",
        config: { pattern: "periodic", periodMs: 60000 },
      },
    ]);
    const est = estimateCost(
      d,
      run({
        burst: [{ calls: 0 }],
        steady: [{ calls: 0 }],
        diurnal: [{ calls: 0 }],
        slow: [{ calls: 0 }],
      }),
    );
    // A 5s period fits the 15s run (fair mean); a 60s period and a burst don't.
    expect(est.nonSteady).toEqual(["Client (burst)", "Browser (periodic)"]);
  });
});

describe("fmtUSD", () => {
  it("scales precision with magnitude", () => {
    expect(fmtUSD(0)).toBe("$0");
    expect(fmtUSD(0.0042)).toBe("$0.0042");
    expect(fmtUSD(3.5)).toBe("$3.50");
    expect(fmtUSD(1234.4)).toBe("$1,234");
    expect(fmtUSD(0.178 * HOURS_PER_MONTH)).toBe("$130");
    // Netflix-scale totals abbreviate instead of clipping their tiles.
    expect(fmtUSD(1_943_123)).toBe("$1.94M");
    expect(fmtUSD(1.5e9)).toBe("$1.50B");
  });
});
