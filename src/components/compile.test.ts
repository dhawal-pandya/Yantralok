import { describe, expect, it } from "vitest";
import { MainThreadHost } from "@/engine";
import { addEdge, addNode, createDocument, updateNodeConfig } from "@/document";
import type { SystemDoc } from "@/schema";
import { compileScenario } from "./compile";

// Client → API → Postgres, built the way the editor builds it.
function demoDoc(overrides?: Partial<{ pgServers: number; pgService: number; rate: number }>) {
  const pgServers = overrides?.pgServers ?? 100;
  const pgService = overrides?.pgService ?? 8;
  const rate = overrides?.rate ?? 200;
  let doc = createDocument({ id: "sys", name: "Demo", seed: 5 });
  doc = addNode(doc, "client", { x: 0, y: 0 }, "c");
  doc = addNode(doc, "api", { x: 100, y: 0 }, "a");
  doc = addNode(doc, "postgres", { x: 200, y: 0 }, "p");
  doc = addEdge(doc, "c", "a", "e1");
  doc = addEdge(doc, "a", "p", "e2");
  doc = updateNodeConfig(doc, "c", { requestRate: rate });
  doc = updateNodeConfig(doc, "p", { maxConnections: pgServers, serviceTime: pgService });
  return doc;
}

describe("compileScenario", () => {
  it("maps nodes → stations and config → law params", () => {
    const s = compileScenario(demoDoc());
    expect(s.stations.map((st) => st.id)).toEqual(["c", "a", "p"]);
    const api = s.stations[1];
    expect(api.servers).toBe(200); // api concurrency
    expect(api.serviceRatePerMs).toBeCloseTo(1 / 20); // api serviceTime 20ms
    const pg = s.stations[2];
    expect(pg.servers).toBe(100); // postgres maxConnections
  });

  it("maps edges → dependency calls (topology)", () => {
    const s = compileScenario(demoDoc());
    expect(s.stations[0].deps).toEqual([{ to: 1, latencyMs: 1, timeoutMs: undefined, retries: undefined }]);
    expect(s.stations[1].deps[0].to).toBe(2);
    expect(s.stations[2].deps).toEqual([]);
  });

  it("makes each Client an arrival source at its configured λ", () => {
    expect(compileScenario(demoDoc({ rate: 200 })).arrivals).toEqual([
      { station: 0, ratePerMs: 0.2 },
    ]);
    expect(compileScenario(demoDoc({ rate: 1000 })).arrivals[0].ratePerMs).toBeCloseTo(1);
  });

  it("treats every source component (Browser, Cron) as an arrival generator", () => {
    let doc = createDocument({ id: "src", name: "Sources", seed: 3 });
    doc = addNode(doc, "browser", { x: 0, y: 0 }, "b");
    doc = addNode(doc, "cron", { x: 0, y: 100 }, "j");
    doc = addNode(doc, "api", { x: 200, y: 0 }, "a");
    doc = addEdge(doc, "b", "a", "eb");
    doc = addEdge(doc, "j", "a", "ej");
    const s = compileScenario(doc);
    const arr = s.arrivals.map((a) => a.station).sort();
    expect(arr).toEqual([0, 1]); // both the browser and the cron generate load
    // The cron defaults to the periodic arrival shape (it fires on a schedule).
    const cronArrival = s.arrivals.find((a) => a.station === 1)!;
    expect(cronArrival.shape?.kind).toBe("periodic");
  });

  it("compiles a broker; subscriberGroups gates pub/sub fan-out (default byte-identical)", () => {
    let doc = createDocument({ id: "brk", name: "Broker", seed: 1 });
    doc = addNode(doc, "kafka", { x: 0, y: 0 }, "k");
    // Default (1 group): the single competing-consumers pool, no groups emitted.
    const base = compileScenario(doc).stations[0];
    expect(base.broker).toBeDefined();
    expect(base.broker!.groups).toBeUndefined();
    // 3 subscriber groups: independent pools, aggregate servers = 3× consumers.
    doc = updateNodeConfig(doc, "k", { subscriberGroups: 3 });
    const grouped = compileScenario(doc).stations[0];
    expect(grouped.broker!.groups).toHaveLength(3);
    expect(grouped.servers).toBe(grouped.broker!.groups!.reduce((a, g) => a + g.consumers, 0));
    for (const g of grouped.broker!.groups!) {
      expect(g.consumeRatePerMs).toBeCloseTo(base.serviceRatePerMs, 9); // inherits consume time
    }
  });

  it("compiles Elasticsearch shards; the knob gates fan-out (default byte-identical)", () => {
    let doc = createDocument({ id: "es", name: "Search", seed: 1 });
    doc = addNode(doc, "elasticsearch", { x: 0, y: 0 }, "s");
    // Default (1 shard): a single cell, no sharding emitted (byte-identical).
    const base = compileScenario(doc).stations[0];
    expect(base.shards).toBeUndefined();
    const perNode = base.servers; // maxConnections
    // 4 shards: 4 independent cells, aggregate servers = 4× the per-node pool.
    doc = updateNodeConfig(doc, "s", { shards: 4 });
    const sharded = compileScenario(doc).stations[0];
    expect(sharded.shards).toEqual({ count: 4, serversPerShard: perNode, queuePerShard: sharded.queueCapacity });
    expect(sharded.servers).toBe(4 * perNode); // the throughput ceiling scales with shards
  });

  it("compiles Cassandra quorum only when enabled (default byte-identical)", () => {
    let doc = createDocument({ id: "cas", name: "Ring", seed: 1 });
    doc = addNode(doc, "cassandra", { x: 0, y: 0 }, "c");
    // Default: quorum off, a plain single-pool store (no quorum emitted).
    expect(compileScenario(doc).stations[0].quorum).toBeUndefined();
    const perNode = compileScenario(doc).stations[0].servers; // maxConnections
    // Enabled: N peer nodes, aggregate servers = nodes × per-node pool, W/R clamped to RF.
    doc = updateNodeConfig(doc, "c", {
      quorumReplication: true,
      nodes: 6,
      replicationFactor: 3,
      writeQuorum: 5, // clamps to RF
      readQuorum: 2,
    });
    const q = compileScenario(doc).stations[0];
    expect(q.quorum).toEqual({
      nodes: 6,
      replicationFactor: 3,
      writeQuorum: 3, // clamped to RF
      readQuorum: 2,
      serversPerNode: perNode,
      queuePerNode: q.queueCapacity,
    });
    expect(q.servers).toBe(6 * perNode);
  });

  it("carries a shard-scoped intervention through to the engine", () => {
    let doc = createDocument({ id: "es2", name: "Search", seed: 1 });
    doc = addNode(doc, "elasticsearch", { x: 0, y: 0 }, "s");
    doc = updateNodeConfig(doc, "s", { shards: 3 });
    const withKill: SystemDoc = {
      ...doc,
      interventions: [{ id: "k", atLogicalTime: 3000, kind: "kill", target: "s", shard: 1 }],
    };
    expect(compileScenario(withKill).interventions).toEqual([
      { atMs: 3000, kind: "kill", station: 0, param: undefined, shard: 1 },
    ]);
  });

  it("maps interventions to stations by target", () => {
    const doc: SystemDoc = {
      ...demoDoc(),
      interventions: [{ id: "i1", atLogicalTime: 5000, kind: "kill", target: "p" }],
    };
    expect(compileScenario(doc).interventions).toEqual([
      { atMs: 5000, kind: "kill", station: 2, param: undefined },
    ]);
  });

  it("carries partition interventions through (not dropped), unknown kinds are dropped", () => {
    const doc: SystemDoc = {
      ...demoDoc(),
      interventions: [
        { id: "i1", atLogicalTime: 5000, kind: "partition", target: "p" },
        { id: "i2", atLogicalTime: 6000, kind: "packet-loss", target: "p" },
      ],
    };
    expect(compileScenario(doc).interventions).toEqual([
      { atMs: 5000, kind: "partition", station: 2, param: undefined },
    ]);
  });

  it("a compiled, built doc runs and surfaces the predicted bottleneck", () => {
    const doc = demoDoc({ pgServers: 2, pgService: 20, rate: 90 }); // ρ_pg ≈ 0.9
    const scenario = compileScenario(doc);
    const r = new MainThreadHost().run(scenario, { horizonMs: 40_000, sampleIntervalMs: 1000 });
    const tail = r.windows.slice(-15);
    const pgIsBottleneck = tail.filter((w) => w.bottleneck === "p").length;
    expect(pgIsBottleneck).toBeGreaterThan(tail.length / 2);
  });
});

describe("resilience config → dependency calls", () => {
  it("backoff + circuit breaker on the API thread onto its outbound calls", () => {
    let doc = demoDoc();
    doc = updateNodeConfig(doc, "a", {
      retries: 3,
      backoff: 100,
      circuitBreaker: true,
      breakerThreshold: 0.4,
      breakerCooldownMs: 5000,
    });
    const dep = compileScenario(doc).stations[1].deps[0];
    expect(dep.backoffMs).toBe(100);
    expect(dep.breaker).toEqual({ threshold: 0.4, cooldownMs: 5000, windowMs: 2000, minCalls: 20 });
  });

  it("stays byte-identical when the knobs are off (breaker undefined, backoff undefined)", () => {
    const dep = compileScenario(demoDoc()).stations[1].deps[0];
    expect(dep.breaker).toBeUndefined();
    expect(dep.backoffMs).toBeUndefined();
  });

  it("connection lifecycle on the API threads DNS/TLS/pool onto its outbound calls", () => {
    let doc = demoDoc();
    doc = updateNodeConfig(doc, "a", {
      connections: true,
      tlsHandshake: 25,
      dnsLookup: 12,
      dnsTtl: 60000,
      connectionPool: 16,
    });
    const dep = compileScenario(doc).stations[1].deps[0];
    expect(dep.connection).toEqual({ handshakeMs: 25, dnsMs: 12, dnsTtlMs: 60000, poolSize: 16 });
  });

  it("no connection field unless the mode is on", () => {
    expect(compileScenario(demoDoc()).stations[1].deps[0].connection).toBeUndefined();
  });
});

describe("autoscaling config → StationScaling", () => {
  it("autoscale on maps the knobs and starts the fleet at min", () => {
    let doc = demoDoc();
    doc = updateNodeConfig(doc, "a", {
      autoscale: true,
      minInstances: 2,
      maxInstances: 8,
      targetUtilization: 0.6,
      provisionMs: 4000,
      replicas: 5, // the loop takes over: ignored while autoscale is on
    });
    const api = compileScenario(doc).stations[1];
    expect(api.scaling).toEqual({
      perInstanceServers: 200,
      minInstances: 2,
      maxInstances: 8,
      initialInstances: 2,
      metric: "utilization",
      target: 0.6,
      evalIntervalMs: 1000,
      provisionMs: 4000,
      stabilizationMs: 5000,
    });
    expect(api.servers).toBe(400); // 2 instances × 200 threads, not replicas
  });

  it("request-rate metric maps to the rate law", () => {
    let doc = demoDoc();
    doc = updateNodeConfig(doc, "a", { autoscale: true, scaleMetric: "request-rate", targetRps: 500 });
    const s = compileScenario(doc).stations[1].scaling!;
    expect(s.metric).toBe("rate");
    expect(s.target).toBe(500);
  });

  it("autoscale off compiles with no scaling: replicas still multiply", () => {
    let doc = demoDoc();
    doc = updateNodeConfig(doc, "a", { replicas: 2 });
    const api = compileScenario(doc).stations[1];
    expect(api.scaling).toBeUndefined();
    expect(api.servers).toBe(600);
    expect(api.replication).toBeUndefined(); // API replicas stay a flat multiplier
  });
});

describe("load, timing, and fan-out config → engine mappings", () => {
  it("maps traffic pattern, service distribution, and fan-out", () => {
    let doc = demoDoc();
    doc = updateNodeConfig(doc, "c", { pattern: "burst", burstX: 8, burstStartMs: 1000, burstMs: 3000 });
    doc = updateNodeConfig(doc, "a", { serviceDist: "lognormal", fanout: "parallel" });
    const s = compileScenario(doc);
    expect(s.arrivals[0].shape).toEqual({ kind: "burst", x: 8, startMs: 1000, durationMs: 3000 });
    expect(s.stations[1].dist).toBe("lognormal");
    expect(s.stations[1].parallel).toBe(true);
  });

  it("maps link jitter onto the dependency call", () => {
    const doc = demoDoc();
    const edges = doc.graph.edges.map((e) =>
      e.id === "e1" ? { ...e, config: { ...e.config, jitter: 5 } } : e,
    );
    const s = compileScenario({ ...doc, graph: { ...doc.graph, edges } });
    expect(s.stations[0].deps[0].jitterMs).toBe(5);
  });

  it("defaults stay unshaped / exponential / sequential (the byte-identical path)", () => {
    const s = compileScenario(demoDoc());
    expect(s.arrivals[0].shape).toBeUndefined();
    expect(s.stations[1].dist).toBeUndefined();
    expect(s.stations[1].parallel).toBeUndefined();
    expect(s.stations[0].deps[0].jitterMs).toBeUndefined();
  });
});

describe("read replicas config → StationReplication", () => {
  it("postgres replicas become a read pool with lag; total capacity is the sum", () => {
    let doc = demoDoc();
    doc = updateNodeConfig(doc, "p", { replicas: 2, replicationLagMs: 80 });
    const pg = compileScenario(doc).stations[2];
    expect(pg.replication).toEqual({ primaryServers: 100, replicaServers: 200, lagMs: 80 });
    expect(pg.servers).toBe(300);
  });

  it("no replicas → no replication field (byte-identical)", () => {
    const pg = compileScenario(demoDoc()).stations[2];
    expect(pg.replication).toBeUndefined();
    expect(pg.servers).toBe(100);
  });
});

describe("broker config → StationBroker", () => {
  it("a Kafka node compiles to a broker: consumers are the servers, consume time the service", () => {
    let doc = createDocument({ id: "b", name: "Broker", seed: 1 });
    doc = addNode(doc, "client", { x: 0, y: 0 }, "cl");
    doc = addNode(doc, "kafka", { x: 1, y: 0 }, "k");
    doc = addEdge(doc, "cl", "k", "e1");
    doc = updateNodeConfig(doc, "k", { consumers: 6, consumeTime: 4 });
    const k = compileScenario(doc).stations[1];
    expect(k.broker).toEqual({ consumers: 6, maxBacklog: undefined });
    expect(k.servers).toBe(6); // consumer slots
    expect(k.serviceRatePerMs).toBeCloseTo(1 / 4); // per-message consume time
  });

  it("maxBacklog 0 means unbounded; a positive bound is carried through", () => {
    let doc = createDocument({ id: "b2", name: "Broker", seed: 1 });
    doc = addNode(doc, "sqs", { x: 0, y: 0 }, "q");
    expect(compileScenario(doc).stations[0].broker?.maxBacklog).toBeUndefined();
    doc = updateNodeConfig(doc, "q", { maxBacklog: 5000 });
    expect(compileScenario(doc).stations[0].broker?.maxBacklog).toBe(5000);
  });

  it("non-broker nodes carry no broker field", () => {
    expect(compileScenario(demoDoc()).stations[1].broker).toBeUndefined();
  });
});

// Client → API → {Redis (cache), Postgres}. Redis shields Postgres; killing it
// floods Postgres and retries finish it off: the engine produces the cascade.
function cascadeDoc() {
  let doc = createDocument({ id: "casc", name: "Cascade", seed: 3 });
  doc = addNode(doc, "client", { x: 0, y: 0 }, "cl");
  doc = addNode(doc, "api", { x: 1, y: 0 }, "api");
  doc = addNode(doc, "redis", { x: 2, y: 0 }, "rd");
  doc = addNode(doc, "postgres", { x: 3, y: 0 }, "pg");
  doc = addEdge(doc, "cl", "api", "e0");
  doc = addEdge(doc, "api", "rd", "e1");
  doc = addEdge(doc, "api", "pg", "e2");
  doc = updateNodeConfig(doc, "cl", { requestRate: 400 });
  doc = updateNodeConfig(doc, "api", { concurrency: 100_000, serviceTime: 5, timeout: 1000, retries: 2 });
  doc = updateNodeConfig(doc, "rd", { hitRatio: 1 }); // a perfect cache: isolate the kill's effect
  doc = updateNodeConfig(doc, "pg", { maxConnections: 4, serviceTime: 20, queueCapacity: 100_000 });
  return doc;
}

describe("cascade: kill Redis → Postgres meltdown", () => {
  const at = (r: ReturnType<MainThreadHost["run"]>, ms: number) => r.windows[Math.round(ms / 250) - 1];
  const pgUtil = (w: { stations: { id: string; utilization: number }[] }) =>
    w.stations.find((s) => s.id === "pg")!.utilization;

  it("Postgres is idle until the kill, then saturates and requests fail", () => {
    const doc: SystemDoc = {
      ...cascadeDoc(),
      interventions: [{ id: "k", atLogicalTime: 4000, kind: "kill", target: "rd" }],
    };
    const r = new MainThreadHost().run(compileScenario(doc), { horizonMs: 10_000, sampleIntervalMs: 250 });

    const before = at(r, 3000);
    const after = at(r, 9000);
    expect(pgUtil(before)).toBeLessThan(0.2); // cache shields Postgres
    expect(pgUtil(after)).toBeGreaterThan(0.8); // flooded after the kill
    expect(pgUtil(after)).toBeGreaterThan(pgUtil(before) + 0.5); // a real jump
    expect(after.failureRate).toBeGreaterThan(0); // retries exhausted → failures
    expect(after.bottleneck).toBe("pg");
  });

  it("branch/compare: same seed, with vs without the kill: deterministic and different", () => {
    const base = cascadeDoc();
    const withKill: SystemDoc = {
      ...base,
      interventions: [{ id: "k", atLogicalTime: 4000, kind: "kill", target: "rd" }],
    };
    const run = (d: SystemDoc) => new MainThreadHost().run(compileScenario(d), { horizonMs: 10_000 });

    // Each branch is reproducible…
    expect(JSON.stringify(run(base))).toBe(JSON.stringify(run(base)));
    // …and the kill branch diverges (failures appear).
    expect(run(base).totals.failures).toBe(0);
    expect(run(withKill).totals.failures).toBeGreaterThan(0);
  });
});

describe("cache memory → hit ratio", () => {
  const redisDep = (cfg: Record<string, number | string>) => {
    let doc = cascadeDoc();
    doc = updateNodeConfig(doc, "rd", cfg);
    return compileScenario(doc).stations[1].deps.find((d) => d.shortCircuit)!;
  };

  it("no working set → the hit-ratio knob is used directly", () => {
    expect(redisDep({ hitRatio: 0.9 }).hitRatio).toBeCloseTo(0.9);
  });

  it("memory that covers the working set keeps the ideal hit ratio", () => {
    expect(redisDep({ hitRatio: 0.9, maxMemoryMB: 4000, workingSetMB: 2000 }).hitRatio).toBeCloseTo(0.9);
  });

  it("a memory-starved cache degrades its hit ratio", () => {
    // coverage = min(1, (500/2000) × 1.1[LRU]) = 0.275 → 0.9 × 0.275 ≈ 0.25
    const h = redisDep({ hitRatio: 0.9, maxMemoryMB: 500, workingSetMB: 2000, evictionPolicy: "allkeys-lru" }).hitRatio!;
    expect(h).toBeGreaterThan(0.2);
    expect(h).toBeLessThan(0.35);
  });

  it("LFU sustains a higher hit rate than LRU under the same pressure", () => {
    const lru = redisDep({ hitRatio: 0.9, maxMemoryMB: 500, workingSetMB: 2000, evictionPolicy: "allkeys-lru" }).hitRatio!;
    const lfu = redisDep({ hitRatio: 0.9, maxMemoryMB: 500, workingSetMB: 2000, evictionPolicy: "allkeys-lfu" }).hitRatio!;
    expect(lfu).toBeGreaterThan(lru);
  });

  it("under load, a starved cache's measured hit rate drops and DB load climbs", () => {
    const run = (cfg: Record<string, number | string>) => {
      let doc = cascadeDoc();
      doc = updateNodeConfig(doc, "rd", cfg);
      return new MainThreadHost().run(compileScenario(doc), { horizonMs: 20_000, sampleIntervalMs: 1000 });
    };
    const tail = 8;
    const pgCalls = (r: ReturnType<MainThreadHost["run"]>) =>
      r.windows.slice(-tail).reduce((a, w) => a + w.stations.find((s) => s.id === "pg")!.calls, 0) / tail;
    const hitRate = (r: ReturnType<MainThreadHost["run"]>) =>
      r.windows.slice(-tail).reduce((a, w) => a + w.stations.find((s) => s.id === "rd")!.hitRate, 0) / tail;

    const ample = run({ hitRatio: 0.9, maxMemoryMB: 4000, workingSetMB: 2000 });
    const starved = run({ hitRatio: 0.9, maxMemoryMB: 400, workingSetMB: 2000 });
    expect(hitRate(ample)).toBeGreaterThan(0.8);
    expect(hitRate(starved)).toBeLessThan(0.4);
    expect(pgCalls(starved)).toBeGreaterThan(pgCalls(ample) * 2); // more misses reach the DB
  });
});
