// The generic simulation contract. This is COMPONENT-AGNOSTIC on purpose: the
// engine never knows what "Redis" is, it only sees stations, dependency calls,
// and arrival generators. The mapping from a SystemDoc's components onto this
// lives in components/compile, never here.

/** A dependency call a station makes (while holding a server) to another station.
 * `to` indexes Scenario.stations. */
export interface DependencyCall {
  to: number;
  latencyMs: number; // one-way link latency, paid each direction
  jitterMs?: number; // mean extra (exponential) delay added per leg, seeded
  timeoutMs?: number; // give up after this long waiting on the call
  retries?: number; // re-issue the call up to this many times on failure
  // Base delay before a retry (doubles per attempt, full jitter). 0/unset retries
  // immediately with no PRNG drawn.
  backoffMs?: number;
  breaker?: BreakerConfig; // circuit breaker guarding this dependency
  connection?: ConnectionConfig; // DNS + TLS + keep-alive on this link
  shortCircuit?: boolean; // a cache: a hit ends handling; a miss/failure falls through
  // Cache hit probability h∈[0,1]. A hit short-circuits, a miss (1−h) falls through
  // to the next dep. Default (undefined) always hits.
  hitRatio?: number;
}

/** Circuit breaker guarding a dependency call. It tracks the failure rate over a
 * rolling window and trips OPEN when it exceeds `threshold`, then fast-fails new
 * calls (no downstream load, which is what stops a retry storm) until `cooldownMs`
 * elapses, when it admits exactly ONE half-open probe: a probe success closes it,
 * a probe failure re-opens it. Deterministic, consumes no PRNG. */
export interface BreakerConfig {
  threshold: number; // failure fraction (0..1) over the window that trips it OPEN
  minCalls: number; // minimum window volume before it can trip (no trip on 1 error)
  windowMs: number; // rolling measurement window
  cooldownMs: number; // how long it stays OPEN before a half-open probe
}

/** Connection lifecycle on a caller-to-dependency link. Opening a NEW connection
 * pays a TLS handshake plus a DNS lookup (cached for `dnsTtlMs` after the first
 * resolution). A keep-alive pool of `poolSize` idle connections is reused with no
 * handshake, so a warm path pays neither and a cold path pays both. */
export interface ConnectionConfig {
  handshakeMs: number; // TLS handshake, paid opening a new connection
  dnsMs: number; // DNS resolution, paid on a cache miss when opening a new connection
  dnsTtlMs: number; // how long a resolved name stays cached
  poolSize: number; // keep-alive connections kept warm for reuse
}

/** Time-varying arrival rate: a non-homogeneous Poisson process, sampled by seeded
 * thinning. Absent means the plain constant-rate process. */
export interface ArrivalShape {
  kind: "burst" | "periodic" | "ramp";
  x?: number; // burst: rate multiplier inside the window
  startMs?: number; // burst: window start
  durationMs?: number; // burst: window length
  periodMs?: number; // periodic: cycle length
  amplitude?: number; // periodic: ±fraction of the base rate (0..1)
  rampMs?: number; // ramp: time to climb from 0 to the full rate
}

/** The station's service-time distribution. All are parametrized by the same mean
 * (1/serviceRatePerMs); they differ in tail. Default exponential. */
export type ServiceDist = "exponential" | "deterministic" | "lognormal" | "pareto";

export type Routing = "all" | "one";
export type LbAlgorithm = "round-robin" | "least-connections" | "random";

/** Read replicas + replication lag. Two server pools behind one station, mirroring
 * real read-replica endpoints: writes seat ONLY in the primary pool, reads ONLY in
 * the replica pool. A read starting within `lagMs` of the last write commit returns
 * stale data, counted and surfaced, never hidden. */
export interface StationReplication {
  primaryServers: number; // the primary's pool: all writes land here
  replicaServers: number; // the replica fleet's pooled capacity: all reads land here
  lagMs: number; // how far replicas trail the primary
}

export type ScalingMetric = "utilization" | "rate";

/** Elastic capacity: a damped HPA-style control loop resizes the station's instance
 * fleet within [min, max] toward a target metric. Capacity is
 * `instances × perInstanceServers`; scale-up arrives after `provisionMs` (new
 * capacity is never instant), scale-down waits out `stabilizationMs`. */
export interface StationScaling {
  perInstanceServers: number; // c contributed by each instance
  minInstances: number;
  maxInstances: number;
  initialInstances: number;
  metric: ScalingMetric; // "utilization": busy fraction ρ. "rate": arrivals/s per instance
  target: number; // ρ target in (0,1], or req/s per instance
  evalIntervalMs: number; // control-loop cadence
  provisionMs: number; // delay before scaled-up instances come online
  stabilizationMs: number; // scale-down lookback: never below a recent desired count
}

/** One queue station: the single-server-queue law with c servers. */
export interface ScenarioStation {
  id: string; // original graph node id (for mapping results back to the canvas)
  servers: number; // c
  serviceRatePerMs: number; // μ per ms; mean own-service time = 1/μ
  queueCapacity: number; // bounded wait queue; overflow rejects (defined behavior)
  deps: DependencyCall[]; // downstream calls
  // How deps are routed. "all" (default) calls every dep sequentially; "one"
  // load-balances across equivalent backends, one per request.
  routing?: Routing;
  algorithm?: LbAlgorithm; // for routing "one": how to pick the backend
  // Fan the non-cache deps out CONCURRENTLY and join: latency is the slowest branch,
  // not the sum. Caches still resolve first.
  parallel?: boolean;
  // Service-time distribution (same mean, different tail). Default exponential.
  dist?: ServiceDist;
  // Elastic capacity. When present, `servers` is only the INITIAL capacity
  // (= initialInstances × perInstanceServers); the control loop owns it after t=0.
  scaling?: StationScaling;
  // Read replicas. When present, `servers` = primaryServers + replicaServers
  // (the ρ denominator); admission splits by request class instead.
  replication?: StationReplication;
  // Async message broker. When present, a produce enqueues into `backlog` and acks
  // at once; `consumers` slots drain it at the station's service rate (1/μ per
  // message), calling the station's deps as the consumer's downstream work.
  broker?: StationBroker;
  // CPU contention: own service time inflates with utilization, effective service
  // = base × (1 + cpuContention × ρ), so a box slows down before it saturates.
  // 0/unset = no contention (byte-identical).
  cpuContention?: number;
  // Horizontal sharding. When present, the station is `count` INDEPENDENT cells,
  // each its own servers/queue/busy; each call routes (seeded hash of its request
  // id) to exactly one cell. Adds write-scaling and fault isolation: more cells =
  // higher ceiling, and one dead cell takes down only its own key slice.
  shards?: StationShards;
  // Masterless quorum replication (Cassandra-style). When present, the station is
  // `nodes` peers (cells); each op replicates to `replicationFactor` of them and
  // completes on quorum (`writeQuorum` for writes, `readQuorum` for reads). Write
  // capacity scales with node count (unlike a single primary), and a weak quorum
  // (W+R ≤ RF) trades consistency for latency, surfaced as a stale-read rate.
  quorum?: StationQuorum;
}

/** Masterless quorum replication. N peer nodes (reusing the shard cells), each op
 * fanned to `replicationFactor` of them and returning on the W-th (write) or R-th
 * (read) ack. W+R > RF is strongly consistent; a weaker setting is stale with the
 * quorum-overlap probability, drawn seeded per read. */
export interface StationQuorum {
  nodes: number; // peer node count (each an independent cell)
  replicationFactor: number; // copies of each key (RF ≤ nodes)
  writeQuorum: number; // acks a write waits for (W ≤ RF)
  readQuorum: number; // replicas a read queries (R ≤ RF)
  serversPerNode: number; // c per peer node
  queuePerNode: number; // bounded wait queue per node
}

/** Horizontal sharding: N independent queue cells behind one station. A call is
 * routed to one cell by a seeded hash of its request id, so load spreads evenly,
 * capacity is `count × serversPerShard`, and a dead cell isolates its slice. */
export interface StationShards {
  count: number; // number of independent shard cells
  serversPerShard: number; // c per cell (each cell is an independent node)
  queuePerShard: number; // bounded wait queue per cell; overflow rejects
}

/** Async message broker (Kafka / SQS / RabbitMQ / NATS). Produces are decoupled
 * from consumes: producing is a fast enqueue + ack, and a pool of `consumers`
 * drains the backlog independently. When produce rate exceeds consume capacity the
 * backlog (consumer lag) grows without bounding the producer. */
export interface StationBroker {
  consumers: number; // parallel consumer slots draining the backlog
  maxBacklog?: number; // optional buffer bound; a full buffer rejects the produce
  // Pub/sub fan-out: independent subscriber groups, each receiving EVERY produced
  // message into its own backlog and draining with its own consumer pool, so the
  // groups' lags are independent. Absent means the single competing-consumers pool
  // (a message is consumed exactly once).
  groups?: BrokerGroup[];
}

/** One subscriber group of a pub/sub broker: its own consumer pool and consume
 * rate, so a slow group's backlog grows without touching a fast group's. */
export interface BrokerGroup {
  consumers: number; // consumer slots for this group
  consumeRatePerMs: number; // this group's drain rate per consumer (1/consumeTime)
  maxBacklog?: number; // optional per-group buffer bound
}

/** A seeded external arrival process feeding requests into a station. */
export interface ScenarioArrival {
  station: number;
  ratePerMs: number; // λ per ms (Poisson); with a shape, the BASE rate
  // Fraction of requests tagged "write". Writes bypass caches straight to the
  // store; reads consult the cache. Default 0.
  writeRatio?: number;
  shape?: ArrivalShape; // time-varying λ(t); absent means constant
}

// kill stops a node; partition cuts it off from the network (alive but
// unreachable); restart heals both; delay adds latency to its service.
export type InterventionKind = "kill" | "restart" | "delay" | "partition";

/** A failure injected at a logical time. */
export interface ScenarioIntervention {
  atMs: number;
  kind: InterventionKind;
  station: number;
  param?: number; // delay: extra ms added to the station's service
  shard?: number; // shard index for a sharded station: kill/restart only that cell
}

export interface Scenario {
  seed: number;
  stations: ScenarioStation[];
  arrivals: ScenarioArrival[];
  interventions: ScenarioIntervention[];
}
