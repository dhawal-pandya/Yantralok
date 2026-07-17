// Compile a SystemDoc into a generic engine Scenario. This is the one place
// component knowledge meets the engine: it reads component-specific config keys
// and emits the engine's component-AGNOSTIC contract. It must never live in
// engine/ (the dependency rule).
import type {
  Scenario,
  ScenarioArrival,
  ScenarioIntervention,
  ScenarioStation,
  InterventionKind,
  LbAlgorithm,
  StationScaling,
  StationReplication,
  StationBroker,
  StationQuorum,
  ArrivalShape,
  ServiceDist,
} from "@/engine";
import type { SystemDoc } from "@/schema";
import { defaultConfig, getComponent } from "./registry";

const BIG = 1_000_000; // effectively unbounded (sources / forwarders)
const MIN_SERVICE_MS = 0.001;
// Autoscaler cadence: evaluate every second of logical time; a scale-down must
// survive a 5s lookback of desired counts. Not user knobs but the loop's physics,
// like the HPA's fixed sync period.
const SCALE_EVAL_MS = 1000;
const SCALE_STABILIZATION_MS = 5000;
// The rolling window the circuit breaker measures over and the minimum call volume
// before it can trip. Fixed constants, not user knobs, so a single stray error
// can't trip it and the trip decision has statistical basis.
const BREAKER_WINDOW_MS = 2000;
const BREAKER_MIN_CALLS = 20;
// How well an eviction policy keeps the hottest keys when memory can't hold the
// whole working set. Frequency-aware (LFU) protects the tail best; noeviction just
// fills up and stops caching new hot keys. Multiplies the memory coverage.
const EVICTION_GAIN: Record<string, number> = {
  "allkeys-lfu": 1.3,
  "allkeys-lru": 1.1,
  "volatile-lru": 1.0,
  noeviction: 0.9,
};

type Cfg = Record<string, unknown>;
const n = (cfg: Cfg, key: string): number | undefined =>
  typeof cfg[key] === "number" ? (cfg[key] as number) : undefined;
const first = (...xs: (number | undefined)[]): number | undefined =>
  xs.find((x) => x !== undefined);
const clamp01 = (x: number | undefined): number | undefined =>
  x === undefined ? undefined : Math.max(0, Math.min(1, x));

// A cache's effective hit ratio. The `hitRatio` knob is the ideal (memory holds the
// whole working set). Once a `workingSetMB` is given, memory pressure derives it:
// coverage = maxMemory/workingSet (times an eviction-policy gain), and a
// memory-starved cache serves only what fits, so its hit rate drops. Without a
// working set the model is off and the ideal is used directly (byte-identical).
const effectiveHitRatio = (cacheCfg: Cfg): number => {
  const ideal = clamp01(n(cacheCfg, "hitRatio")) ?? 1;
  const ws = n(cacheCfg, "workingSetMB");
  const mem = n(cacheCfg, "maxMemoryMB");
  if (!ws || ws <= 0 || mem === undefined) return ideal;
  const gain = EVICTION_GAIN[String(cacheCfg.evictionPolicy)] ?? 1;
  const coverage = Math.min(1, (mem / ws) * gain);
  return ideal * coverage;
};

export function compileScenario(doc: SystemDoc): Scenario {
  const index = new Map<string, number>();
  doc.graph.nodes.forEach((node, i) => index.set(node.id, i));
  const cfgOf = (i: number): Cfg => {
    const node = doc.graph.nodes[i];
    return { ...defaultConfig(node.type), ...node.config };
  };

  const LB_ALGORITHMS: LbAlgorithm[] = ["round-robin", "least-connections", "random"];

  const stations: ScenarioStation[] = doc.graph.nodes.map((node, i) => {
    const cfg = cfgOf(i);
    const def = getComponent(node.type);
    const serviceTimeMs = Math.max(
      MIN_SERVICE_MS,
      first(n(cfg, "serviceTime"), n(cfg, "getLatency"), n(cfg, "consumeTime"), n(cfg, "thinkTime")) ?? 1,
    );
    const perInstance = first(n(cfg, "concurrency"), n(cfg, "maxConnections")) ?? BIG;
    // When on, the control loop owns the fleet size within [min, max], starting at
    // min: it takes over the static replicas knob, like an HPA owns a Deployment's
    // replica count.
    let scaling: StationScaling | undefined;
    if (cfg.autoscale === true) {
      const min = Math.max(1, Math.floor(n(cfg, "minInstances") ?? 1));
      const max = Math.max(min, Math.floor(n(cfg, "maxInstances") ?? 10));
      const metric = cfg.scaleMetric === "request-rate" ? ("rate" as const) : ("utilization" as const);
      const target =
        metric === "rate"
          ? Math.max(1, n(cfg, "targetRps") ?? 100)
          : Math.min(1, Math.max(0.05, n(cfg, "targetUtilization") ?? 0.7));
      scaling = {
        perInstanceServers: perInstance,
        minInstances: min,
        maxInstances: max,
        initialInstances: min,
        metric,
        target,
        evalIntervalMs: SCALE_EVAL_MS,
        provisionMs: Math.max(0, n(cfg, "provisionMs") ?? 2000),
        stabilizationMs: SCALE_STABILIZATION_MS,
      };
    }
    // N extra identical instances multiply capacity, except on read-replica stores,
    // where they become a read-only pool with lag.
    const replicas = Math.max(0, Math.floor(n(cfg, "replicas") ?? 0));
    let replication: StationReplication | undefined;
    if (def?.readReplicas === true && replicas > 0) {
      replication = {
        primaryServers: perInstance,
        replicaServers: replicas * perInstance,
        lagMs: Math.max(0, n(cfg, "replicationLagMs") ?? 50),
      };
    }
    // Async broker: `servers` is the consumer-slot count draining the backlog; its
    // service rate is the per-message consume time.
    const isBroker = def?.broker === true;
    let broker: StationBroker | undefined;
    if (isBroker) {
      const mb = n(cfg, "maxBacklog");
      const consumers = Math.max(1, Math.floor(n(cfg, "consumers") ?? 4));
      const maxBacklog = mb && mb > 0 ? Math.floor(mb) : undefined;
      broker = { consumers, maxBacklog };
      // Pub/sub fan-out: N>1 subscriber groups, each an independent pool draining
      // its own copy of every message. Gated at >1 so the default (competing
      // consumers) stays byte-identical.
      const nGroups = Math.floor(n(cfg, "subscriberGroups") ?? 1);
      if (nGroups > 1) {
        const consumeRatePerMs = 1 / serviceTimeMs;
        broker.groups = Array.from({ length: nGroups }, () => ({
          consumers,
          consumeRatePerMs,
          maxBacklog,
        }));
      }
    }
    const brokerServers = broker
      ? broker.groups
        ? broker.groups.reduce((a, g) => a + g.consumers, 0)
        : broker.consumers
      : undefined;
    const queueCapacity = n(cfg, "queueCapacity") ?? BIG;
    // Horizontal sharding: N>1 independent cells, each `perInstance` servers over its
    // own queue. Gated at >1 so an unsharded store stays byte-identical. Mutually
    // exclusive with the broker/replica capacity paths (only stores carry `shards`).
    const nShards = Math.floor(n(cfg, "shards") ?? 1);
    const shards =
      nShards > 1 && !broker
        ? { count: nShards, serversPerShard: perInstance, queuePerShard: queueCapacity }
        : undefined;
    // Masterless quorum replication (Cassandra). Gated behind the toggle so a plain
    // store stays byte-identical; when on, N peer nodes each `perInstance` servers,
    // each op replicating to RF of them and returning on the W/R quorum.
    let quorum: StationQuorum | undefined;
    if (cfg.quorumReplication === true && !broker && !shards) {
      const nodes = Math.max(1, Math.floor(n(cfg, "nodes") ?? 6));
      const rf = Math.min(nodes, Math.max(1, Math.floor(n(cfg, "replicationFactor") ?? 3)));
      quorum = {
        nodes,
        replicationFactor: rf,
        writeQuorum: Math.min(rf, Math.max(1, Math.floor(n(cfg, "writeQuorum") ?? 2))),
        readQuorum: Math.min(rf, Math.max(1, Math.floor(n(cfg, "readQuorum") ?? 2))),
        serversPerNode: perInstance,
        queuePerNode: queueCapacity,
      };
    }
    const servers = shards
      ? shards.count * shards.serversPerShard
      : quorum
        ? quorum.nodes * quorum.serversPerNode
        : brokerServers
          ?? (scaling
            ? scaling.initialInstances * perInstance
            : perInstance * (1 + replicas));
    const timeoutMs = n(cfg, "timeout");
    const retries = n(cfg, "retries");
    // Retry backoff: 0/unset keeps immediate retries (byte-identical).
    const backoffMs = n(cfg, "backoff") || undefined;
    // Circuit breaker present only when enabled, so unconfigured callers stay
    // byte-identical. Window + min-volume are fixed constants, threshold + cooldown
    // are the user's knobs.
    const breaker =
      cfg.circuitBreaker === true
        ? {
            threshold: Math.min(1, Math.max(0.05, n(cfg, "breakerThreshold") ?? 0.5)),
            cooldownMs: Math.max(0, n(cfg, "breakerCooldownMs") ?? 3000),
            windowMs: BREAKER_WINDOW_MS,
            minCalls: BREAKER_MIN_CALLS,
          }
        : undefined;
    // Connection lifecycle on the caller's outbound links: present only when on, so
    // links stay byte-identical otherwise.
    const connection =
      cfg.connections === true
        ? {
            handshakeMs: Math.max(0, n(cfg, "tlsHandshake") ?? 0),
            dnsMs: Math.max(0, n(cfg, "dnsLookup") ?? 0),
            dnsTtlMs: Math.max(0, n(cfg, "dnsTtl") ?? 30000),
            poolSize: Math.max(0, Math.floor(n(cfg, "connectionPool") ?? 8)),
          }
        : undefined;

    // Load balancer: route each request to ONE backend (call-one), by algorithm.
    const isLb = def?.loadBalance === true;
    const algorithm = LB_ALGORITHMS.includes(cfg.algorithm as LbAlgorithm)
      ? (cfg.algorithm as LbAlgorithm)
      : undefined;

    const deps = doc.graph.edges
      .filter((e) => e.source === node.id && index.has(e.target))
      .map((e) => {
        const targetIdx = index.get(e.target)!;
        const targetType = doc.graph.nodes[targetIdx].type;
        const isCache = getComponent(targetType)?.cache === true;
        return {
          to: targetIdx,
          latencyMs: n(e.config as Cfg, "latency") ?? 1,
          // Link jitter: 0/unset stays byte-identical (no PRNG consumed).
          jitterMs: n(e.config as Cfg, "jitter") || undefined,
          timeoutMs, // the caller's timeout governs its outbound calls
          retries, // the caller's retries amplify load on a failing dependency
          backoffMs, // spaces retries out in time
          breaker, // fast-fail a failing dep instead of hammering it
          connection, // DNS + TLS + keep-alive on this link
          shortCircuit: isCache ? true : undefined,
          // Cache hit ratio h drives the hit/miss split, derived from memory pressure.
          hitRatio: isCache ? effectiveHitRatio(cfgOf(targetIdx)) : undefined,
        };
      })
      // Cache calls first: a healthy cache hit short-circuits the slow tier.
      .sort((a, b) => (a.shortCircuit ? 0 : 1) - (b.shortCircuit ? 0 : 1));

    // Service-time distribution: same mean, different tail.
    const DISTS: ServiceDist[] = ["exponential", "deterministic", "lognormal", "pareto"];
    const dist =
      DISTS.includes(cfg.serviceDist as ServiceDist) && cfg.serviceDist !== "exponential"
        ? (cfg.serviceDist as ServiceDist)
        : undefined;

    return {
      id: node.id,
      servers,
      serviceRatePerMs: 1 / serviceTimeMs,
      queueCapacity,
      deps,
      routing: isLb ? ("one" as const) : undefined,
      algorithm: isLb ? algorithm : undefined,
      // Parallel fan-out of independent (non-cache) deps.
      parallel: cfg.fanout === "parallel" ? true : undefined,
      dist,
      scaling,
      replication,
      broker,
      shards,
      quorum,
      // CPU contention: service time grows with utilization (0/unset = off).
      cpuContention: n(cfg, "cpuContention") || undefined,
    };
  });

  // Arrivals: every Client node is an entry source, plus any explicit workloads.
  const arrivals: ScenarioArrival[] = [];
  // Omit writeRatio when 0 so all-read workloads stay byte-identical.
  const wr = (cfg: Cfg): number | undefined => clamp01(n(cfg, "writeRatio")) || undefined;
  // Map the traffic pattern (client `pattern` knob / workload `kind`) onto a
  // time-varying arrival shape. constant/poisson/unset means none (byte-identical).
  const shapeOf = (kind: unknown, cfg: Cfg): ArrivalShape | undefined => {
    if (kind === "burst")
      return {
        kind: "burst",
        x: Math.max(1, n(cfg, "burstX") ?? 6),
        startMs: Math.max(0, n(cfg, "burstStartMs") ?? 2000),
        durationMs: Math.max(0, n(cfg, "burstMs") ?? 4000),
      };
    if (kind === "periodic")
      return {
        kind: "periodic",
        periodMs: Math.max(1, n(cfg, "periodMs") ?? 5000),
        amplitude: clamp01(n(cfg, "amplitude")) ?? 0.5,
      };
    if (kind === "ramp") return { kind: "ramp", rampMs: Math.max(1, n(cfg, "rampMs") ?? 5000) };
    return undefined;
  };
  doc.graph.nodes.forEach((node, i) => {
    if (getComponent(node.type)?.source === true) {
      const cfg = cfgOf(i);
      const rate = n(cfg, "requestRate") ?? 0;
      if (rate > 0)
        arrivals.push({
          station: i,
          ratePerMs: rate / 1000,
          writeRatio: wr(cfg),
          shape: shapeOf(cfg.pattern, cfg),
        });
    }
  });
  for (const w of doc.workloads) {
    const station = index.get(w.target);
    if (station !== undefined && w.rate > 0) {
      arrivals.push({
        station,
        ratePerMs: w.rate / 1000,
        writeRatio: wr(w.request as Cfg),
        shape: shapeOf(w.kind, w.request as Cfg),
      });
    }
  }

  const KINDS: InterventionKind[] = ["kill", "restart", "delay", "partition"];
  const interventions: ScenarioIntervention[] = doc.interventions
    .filter((iv) => index.has(iv.target) && KINDS.includes(iv.kind as InterventionKind))
    .map((iv) => {
      const raw = iv as Record<string, unknown>;
      const param = raw.param;
      const shard = raw.shard;
      return {
        atMs: iv.atLogicalTime,
        kind: iv.kind as InterventionKind,
        station: index.get(iv.target)!,
        param: typeof param === "number" ? param : undefined,
        // A shard-scoped kill/restart targets one cell of a sharded store.
        shard: typeof shard === "number" ? shard : undefined,
      };
    });

  return { seed: doc.seed, stations, arrivals, interventions };
}
