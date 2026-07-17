// The component registry. Parameter profiles over the engine laws with sane,
// editable defaults (e.g. the Client, Load Balancer, API, Redis, Postgres demo).
import type {
  Category,
  ChannelDef,
  ComponentDef,
  NodeConfig,
  PropertyDef,
} from "./types";

const QUEUE_LAW = "Single-server queue with finite concurrency (M/M/c)";

// Most components are the same law with different numbers. This builds the shared
// servers + service-time (+ optional queue) triad so a new profile is a few lines
// of data, not a bespoke simulator. Keys match what compile reads.
interface ProfileOpts {
  serversKey: "maxConnections" | "concurrency";
  serversLabel: string;
  serversDefault: number;
  serversUnit: string;
  serversWhat: string;
  serversEffect: string;
  serviceKey: "serviceTime" | "getLatency";
  serviceLabel: string;
  serviceDefault: number;
  serviceWhat: string;
  serviceEffect: string;
  serviceMin?: number;
  queueDefault?: number; // omit for pure forwarders (effectively unbounded)
}

// The shape of the service-time distribution. One select, same mean; the tail
// profiles (lognormal σ=0.7, Pareto α=2.2) are the law's fixed constants.
const distKnob: PropertyDef = {
  key: "serviceDist",
  label: "Service distribution",
  kind: "select",
  default: "exponential",
  options: ["exponential", "deterministic", "lognormal", "pareto"],
  what: "The service-time distribution, same mean, different tail.",
  effect:
    "Exponential is the memoryless baseline; deterministic has no tail; lognormal (σ=0.7) and Pareto (α=2.2) push p99 far past the mean, real services live here.",
  law: "Service-time distributions",
};

// How a caller fans out to multiple independent dependencies.
const fanoutKnob: PropertyDef = {
  key: "fanout",
  label: "Fan-out",
  kind: "select",
  default: "sequential",
  options: ["sequential", "parallel"],
  what: "How multiple (non-cache) dependencies are called.",
  effect:
    "Sequential sums the branches' latencies; parallel issues them concurrently and waits for the slowest, each branch retries on its own.",
  law: "Parallel fan-out",
};

const RETRY_LAW = "Retry backoff + jitter";
const BREAKER_LAW = "Circuit breaker";

// Base backoff before a retry. 0 (default) retries immediately, keeping existing
// scenarios byte-identical; a positive value spreads the retry wave.
const backoffKnob: PropertyDef = {
  key: "backoff",
  label: "Retry backoff",
  kind: "number",
  default: 0,
  unit: "ms",
  min: 0,
  step: 25,
  what: "Base delay before a retry; it doubles each attempt with full jitter (0 = retry immediately).",
  effect:
    "Spreads retries out in time so a struggling dependency isn't hit by a synchronized wave; 0 fires them back-to-back, the storm.",
  law: RETRY_LAW,
};

// Circuit breaker. Off by default (byte-identical); gated sub-knobs when on.
const breakerProps: PropertyDef[] = [
  {
    key: "circuitBreaker",
    label: "Circuit breaker",
    kind: "boolean",
    default: false,
    what: "Trip open when a dependency's failure rate is high, fast-failing calls instead of hammering it.",
    effect:
      "Once open, calls fail instantly without touching the dependency, stopping a retry storm, then a lone probe tests recovery.",
    law: BREAKER_LAW,
  },
  {
    key: "breakerThreshold",
    label: "Trip threshold",
    kind: "number",
    default: 0.5,
    unit: "fail frac",
    min: 0.05,
    max: 1,
    step: 0.05,
    showIf: { key: "circuitBreaker", equals: true },
    what: "Failure fraction over the recent window that trips the breaker open.",
    effect:
      "Lower trips sooner (shields the dependency earlier, more false trips); higher waits for a clearer outage.",
    law: BREAKER_LAW,
  },
  {
    key: "breakerCooldownMs",
    label: "Cooldown",
    kind: "number",
    default: 3000,
    unit: "ms",
    min: 100,
    step: 250,
    showIf: { key: "circuitBreaker", equals: true },
    what: "How long the breaker stays open before admitting one half-open probe.",
    effect:
      "Longer shields the dependency more but slows recovery; each cooldown lets exactly one probe through.",
    law: BREAKER_LAW,
  },
];

const CONN_LAW = "Connection lifecycle (DNS / TLS / keep-alive)";

// Model DNS + TLS + keep-alive on the caller's outbound links. Off by default
// (byte-identical); gated sub-knobs when on.
const connectionProps: PropertyDef[] = [
  {
    key: "connections",
    label: "Connection lifecycle",
    kind: "boolean",
    default: false,
    what: "Model DNS resolution, the TLS handshake, and keep-alive connection pooling on outbound calls.",
    effect:
      "A cold request pays the handshake (and DNS on a cache miss); a warm pooled connection skips both.",
    law: CONN_LAW,
  },
  {
    key: "tlsHandshake",
    label: "TLS handshake",
    kind: "number",
    default: 30,
    unit: "ms",
    min: 0,
    step: 5,
    showIf: { key: "connections", equals: true },
    what: "Cost of the TLS handshake when opening a new connection.",
    effect:
      "Paid on every cold connection; a warmed keep-alive pool amortizes it toward zero.",
    law: CONN_LAW,
  },
  {
    key: "dnsLookup",
    label: "DNS lookup",
    kind: "number",
    default: 15,
    unit: "ms",
    min: 0,
    step: 5,
    showIf: { key: "connections", equals: true },
    what: "Cost of resolving the target name, paid on a cache miss when opening a new connection.",
    effect:
      "Slow DNS lengthens new connections; cached resolutions and pooled connections skip it.",
    law: CONN_LAW,
  },
  {
    key: "dnsTtl",
    label: "DNS cache TTL",
    kind: "number",
    default: 30000,
    unit: "ms",
    min: 0,
    step: 1000,
    showIf: { key: "connections", equals: true },
    what: "How long a resolved name stays cached before the next lookup.",
    effect:
      "A longer TTL means fewer resolutions; a short one re-pays the lookup on new connections.",
    law: CONN_LAW,
  },
  {
    key: "connectionPool",
    label: "Keep-alive pool",
    kind: "number",
    default: 8,
    unit: "conns",
    min: 0,
    step: 1,
    showIf: { key: "connections", equals: true },
    what: "Idle keep-alive connections kept warm for reuse.",
    effect:
      "A pool at least as big as the concurrency runs warm; 0 opens a cold connection every time.",
    law: CONN_LAW,
  },
];

// CPU contention: own service time inflates with utilization, so a box slows down
// before it saturates. 0 (default) = no contention (byte-identical).
const cpuContentionKnob: PropertyDef = {
  key: "cpuContention",
  label: "CPU contention",
  kind: "number",
  default: 0,
  unit: "×@full",
  min: 0,
  max: 4,
  step: 0.1,
  what: "How much service time inflates at full utilization (0 = none).",
  effect:
    "Effective service = base × (1 + contention × ρ), so latency climbs with load before the queue saturates, the USL/Amdahl slowdown.",
  law: "CPU contention (service time grows with load)",
};

const CACHE_MEM_LAW = "Cache memory / eviction → hit ratio";

// A cache's memory model. The hit ratio is ideal until the hot working set outgrows
// memory; then it degrades by how much fits (shaped by the eviction policy). Off by
// default (workingSet 0), so caches without it use the hit-ratio knob directly.
const memoryProps: PropertyDef[] = [
  {
    key: "evictionPolicy",
    label: "Eviction policy",
    kind: "select",
    default: "allkeys-lru",
    options: ["noeviction", "allkeys-lru", "allkeys-lfu", "volatile-lru"],
    what: "What the cache drops when memory is full.",
    effect:
      "Under memory pressure a frequency-aware policy (LFU) keeps the hottest keys and sustains a higher hit rate than LRU or noeviction.",
    law: CACHE_MEM_LAW,
  },
  {
    key: "maxMemoryMB",
    label: "Max memory",
    kind: "number",
    default: 1024,
    unit: "MB",
    min: 1,
    step: 64,
    what: "Memory budget for cached data.",
    effect:
      "If it can't cover the working set, the cache serves only what fits, so the hit rate falls and DB load climbs. No effect until a working set is set.",
    law: CACHE_MEM_LAW,
  },
  {
    key: "workingSetMB",
    label: "Working set",
    kind: "number",
    default: 0,
    unit: "MB",
    min: 0,
    step: 64,
    what: "Size of the hot data being accessed (0 = don't model memory pressure).",
    effect:
      "When it exceeds max memory, hit rate ≈ ideal × (memory / working set), so a memory-starved cache degrades its own hit rate.",
    law: CACHE_MEM_LAW,
  },
];

// Cost-only knobs: read by the cost estimate, not the engine. Their effect text
// says so, so they can't mislead.
const egressKnob = (defKB: number): PropertyDef => ({
  key: "avgObjectKB",
  label: "Avg object size",
  kind: "number",
  default: defKB,
  unit: "KB",
  min: 0,
  step: 10,
  what: "Mean size of one served object/response.",
  effect:
    "Prices egress data transfer in the cost estimate (size × measured request rate). Does not affect the simulation.",
});

const egressRateKnob = (defRate: number): PropertyDef => ({
  key: "egressRatePerGB",
  label: "Egress rate",
  kind: "number",
  default: defRate,
  unit: "$/GB",
  min: 0,
  step: 0.005,
  what: "What one GB of data transfer out costs you.",
  effect:
    "Prices egress in the cost estimate: the managed list rate by default, or your negotiated / owned-hardware rate (a self-built edge pays ~10× less per GB). Does not affect the simulation.",
});

const storageKnob = (defGB: number): PropertyDef => ({
  key: "storageGB",
  label: "Stored data",
  kind: "number",
  default: defGB,
  unit: "GB",
  min: 0,
  step: 10,
  what: "Data at rest in this store.",
  effect:
    "Prices storage in the cost estimate at the provider's GB-month rate. Does not affect the simulation.",
});

// Time-varying traffic shapes on a source. Gated knobs per pattern.
const patternProps: PropertyDef[] = [
  {
    key: "pattern",
    label: "Traffic pattern",
    kind: "select",
    default: "constant",
    options: ["constant", "burst", "periodic", "ramp"],
    what: "The arrival process's shape over time (a seeded non-homogeneous Poisson).",
    effect:
      "Constant is steady λ; burst multiplies it in a window (an on-sale gate); periodic swings it (diurnal); ramp climbs from zero (a launch).",
    law: "Arrival shapes",
  },
  {
    key: "burstX",
    label: "Burst multiplier",
    kind: "number",
    default: 6,
    unit: "×",
    min: 1,
    step: 1,
    showIf: { key: "pattern", equals: "burst" },
    what: "Rate multiplier inside the burst window.",
    effect: "λ jumps to X·λ at the gate, the flash-crowd wavefront.",
    law: "Arrival shapes",
  },
  {
    key: "burstStartMs",
    label: "Burst start",
    kind: "number",
    default: 2000,
    unit: "ms",
    min: 0,
    step: 500,
    showIf: { key: "pattern", equals: "burst" },
    what: "When the burst window opens.",
    effect: "Before it, baseline traffic; at it, the wave hits.",
    law: "Arrival shapes",
  },
  {
    key: "burstMs",
    label: "Burst length",
    kind: "number",
    default: 4000,
    unit: "ms",
    min: 100,
    step: 500,
    showIf: { key: "pattern", equals: "burst" },
    what: "How long the burst window stays open.",
    effect: "Longer windows test sustained absorption, not just the spike.",
    law: "Arrival shapes",
  },
  {
    key: "periodMs",
    label: "Period",
    kind: "number",
    default: 5000,
    unit: "ms",
    min: 500,
    step: 500,
    showIf: { key: "pattern", equals: "periodic" },
    what: "Length of one traffic cycle.",
    effect: "The diurnal wave, compressed to sim time.",
    law: "Arrival shapes",
  },
  {
    key: "amplitude",
    label: "Amplitude",
    kind: "number",
    default: 0.5,
    unit: "±",
    min: 0,
    max: 1,
    step: 0.05,
    showIf: { key: "pattern", equals: "periodic" },
    what: "Swing as a fraction of the base rate.",
    effect: "0.5 swings between 0.5× and 1.5× the base λ.",
    law: "Arrival shapes",
  },
  {
    key: "rampMs",
    label: "Ramp time",
    kind: "number",
    default: 5000,
    unit: "ms",
    min: 100,
    step: 500,
    showIf: { key: "pattern", equals: "ramp" },
    what: "Time to climb from zero to the full rate.",
    effect: "A launch curve: capacity planning meets the growth ramp.",
    law: "Arrival shapes",
  },
];

function queueProfile(o: ProfileOpts): PropertyDef[] {
  const props: PropertyDef[] = [
    {
      key: o.serversKey,
      label: o.serversLabel,
      kind: "number",
      default: o.serversDefault,
      unit: o.serversUnit,
      min: 1,
      step: 1,
      what: o.serversWhat,
      effect: o.serversEffect,
      law: QUEUE_LAW,
    },
    {
      key: o.serviceKey,
      label: o.serviceLabel,
      kind: "number",
      default: o.serviceDefault,
      unit: "ms",
      min: o.serviceMin ?? 0.1,
      step: 1,
      what: o.serviceWhat,
      effect: o.serviceEffect,
      law: QUEUE_LAW,
    },
    distKnob,
  ];
  if (o.queueDefault !== undefined) {
    props.push({
      key: "queueCapacity",
      label: "Queue capacity",
      kind: "number",
      default: o.queueDefault,
      unit: "slots",
      min: 0,
      step: 10,
      what: "Max requests waiting for a free server.",
      effect:
        "A bounded queue: overflow is rejection (a defined behavior), not a crash.",
      law: QUEUE_LAW,
    });
  }
  return props;
}

// Shared by the stores flagged `readReplicas`. Reads route to the replica pool
// with lag; writes stay on the primary.
const readReplicaProps: PropertyDef[] = [
  {
    key: "replicas",
    label: "Read replicas",
    kind: "number",
    default: 0,
    unit: "nodes",
    min: 0,
    step: 1,
    what: "Number of read replicas, separate endpoints trailing the primary.",
    effect:
      "Reads route to the replica pool (N× the primary's connections); writes stay on the primary, so write capacity does NOT grow.",
    law: "Read-replica routing + replication lag",
  },
  {
    key: "replicationLagMs",
    label: "Replication lag",
    kind: "number",
    default: 50,
    unit: "ms",
    min: 0,
    step: 10,
    showIf: { key: "replicas", min: 1 },
    what: "How far replicas trail the primary's committed writes.",
    effect:
      "A read hitting a replica within this window of a write returns stale data, surfaced live as the stale-read rate.",
    law: "Read-replica routing + replication lag",
  },
];

const QUORUM_LAW = "Masterless quorum replication";

// Masterless quorum (Cassandra). Off by default so a plain store stays
// byte-identical; the sub-knobs are hidden (not inert) until the toggle is on.
const quorumProps: PropertyDef[] = [
  {
    key: "quorumReplication",
    label: "Quorum replication",
    kind: "boolean",
    default: false,
    what: "Model masterless replication across peer nodes with tunable read/write quorums.",
    effect:
      "Writes replicate to RF of N peers and return on W acks; reads query R. Write capacity scales with node count, and a weak quorum (W+R ≤ RF) trades consistency for a stale-read rate.",
    law: QUORUM_LAW,
  },
  {
    key: "nodes",
    label: "Peer nodes",
    kind: "number",
    default: 6,
    unit: "nodes",
    min: 1,
    step: 1,
    showIf: { key: "quorumReplication", equals: true },
    what: "Number of peer nodes in the ring, each an independent pool.",
    effect:
      "Each op replicates to RF of them, so more nodes raise the WRITE ceiling, the opposite of a single-primary store.",
    law: QUORUM_LAW,
  },
  {
    key: "replicationFactor",
    label: "Replication factor",
    kind: "number",
    default: 3,
    unit: "×",
    min: 1,
    step: 1,
    showIf: { key: "quorumReplication", equals: true },
    what: "Copies of each key kept across nodes (RF).",
    effect:
      "Each write hits RF nodes; higher RF means more durability but more write work per op, so a lower write ceiling.",
    law: QUORUM_LAW,
  },
  {
    key: "writeQuorum",
    label: "Write quorum (W)",
    kind: "number",
    default: 2,
    unit: "acks",
    min: 1,
    step: 1,
    showIf: { key: "quorumReplication", equals: true },
    what: "Replica acks a write waits for before returning.",
    effect:
      "Lower W returns faster and tolerates more node loss; W+R > RF guarantees reads see the latest write.",
    law: QUORUM_LAW,
  },
  {
    key: "readQuorum",
    label: "Read quorum (R)",
    kind: "number",
    default: 2,
    unit: "replicas",
    min: 1,
    step: 1,
    showIf: { key: "quorumReplication", equals: true },
    what: "Replicas a read queries before returning.",
    effect:
      "Lower R is faster but, when W+R ≤ RF, may miss the latest write, surfaced live as a stale-read rate.",
    law: QUORUM_LAW,
  },
];

const SCALING_LAW = "Autoscaling control loop";

// An HPA-style damped control loop resizes the instance fleet toward a target
// metric. When on, it takes over the Replicas knob (the way an HPA owns a
// Deployment's replica count); the fleet starts at Min instances.
const autoscaleProps = (targetRps: number): PropertyDef[] => [
  {
    key: "autoscale",
    label: "Autoscaling",
    kind: "boolean",
    default: false,
    what: "Scale the instance fleet automatically toward a target metric.",
    effect:
      "A damped control loop resizes capacity within Min/Max, and takes over the Replicas knob. New capacity lags by the boot time: a spike still hurts first.",
    law: SCALING_LAW,
  },
  {
    key: "scaleMetric",
    label: "Scale on",
    kind: "select",
    default: "utilization",
    options: ["utilization", "request-rate"],
    showIf: { key: "autoscale", equals: true },
    what: "The signal the loop tracks: busy fraction ρ (≈ CPU) or request rate per instance.",
    effect:
      "Desired instances = ceil(current × metric/target), the HPA formula, inside a ±10% tolerance band.",
    law: SCALING_LAW,
  },
  {
    key: "targetUtilization",
    label: "Target utilization",
    kind: "number",
    default: 0.7,
    unit: "ρ",
    min: 0.05,
    max: 1,
    step: 0.05,
    showIf: { key: "scaleMetric", equals: "utilization" },
    what: "The busy fraction the loop steers each instance toward.",
    effect:
      "Lower targets keep headroom for spikes but waste capacity; near 1 the queue law makes latency diverge before the loop reacts.",
    law: SCALING_LAW,
  },
  {
    key: "targetRps",
    label: "Target rate",
    kind: "number",
    default: targetRps,
    unit: "req/s/inst",
    min: 1,
    step: 10,
    showIf: { key: "scaleMetric", equals: "request-rate" },
    what: "Requests per second one instance should carry.",
    effect:
      "Desired instances = ceil(measured rate / target). Set it near an instance's real capacity and the fleet runs hot.",
    law: SCALING_LAW,
  },
  {
    key: "minInstances",
    label: "Min instances",
    kind: "number",
    default: 1,
    unit: "inst",
    min: 1,
    step: 1,
    showIf: { key: "autoscale", equals: true },
    what: "The floor the fleet never drops below (also where it starts).",
    effect:
      "The idle-cost / cold-headroom tradeoff: a higher floor absorbs spikes the boot delay would otherwise let through.",
    law: SCALING_LAW,
  },
  {
    key: "maxInstances",
    label: "Max instances",
    kind: "number",
    default: 10,
    unit: "inst",
    min: 1,
    step: 1,
    showIf: { key: "autoscale", equals: true },
    what: "The ceiling the fleet can grow to.",
    effect:
      "Beyond it the tier saturates like a fixed one, autoscaling moves the wall, it doesn't remove it.",
    law: SCALING_LAW,
  },
  {
    key: "provisionMs",
    label: "Boot time",
    kind: "number",
    default: 2000,
    unit: "ms",
    min: 0,
    step: 500,
    showIf: { key: "autoscale", equals: true },
    what: "How long a new instance takes to come online.",
    effect:
      "The loop's lag: during a spike the queue grows for this long before relief arrives, why autoscaling never saves you from the first seconds.",
    law: SCALING_LAW,
  },
];

// Horizontal scale: N extra identical instances multiply capacity.
const replicasKnob: PropertyDef = {
  key: "replicas",
  label: "Replicas",
  kind: "number",
  default: 0,
  unit: "+",
  min: 0,
  step: 1,
  what: "Additional identical instances (e.g. behind a load balancer).",
  effect:
    "Multiplies capacity: N replicas ⇒ (1+N)× the servers, raising the throughput ceiling.",
  law: QUEUE_LAW,
};

// The knobs shared by every traffic source (Client / Browser / Cron). `rate` and
// `pattern` let a source override the request-rate copy and the default arrival
// shape (a cron fires periodically, a client streams constantly).
const sourceProps = (
  rate: {
    label: string;
    unit: string;
    default: number;
    what: string;
    effect: string;
  },
  pattern: readonly PropertyDef[] = patternProps,
): PropertyDef[] => [
  {
    key: "requestRate",
    label: rate.label,
    kind: "number",
    default: rate.default,
    unit: rate.unit,
    min: 0,
    step: 10,
    what: rate.what,
    effect: rate.effect,
    law: QUEUE_LAW,
  },
  {
    key: "thinkTime",
    label: "Think time",
    kind: "number",
    default: 0,
    unit: "ms",
    min: 0,
    step: 10,
    what: "Pause between a source's successive requests.",
    effect: "Spaces out arrivals; a closed-loop throttle on offered load.",
  },
  {
    key: "writeRatio",
    label: "Write ratio",
    kind: "number",
    default: 0,
    unit: "",
    min: 0,
    max: 1,
    step: 0.05,
    what: "Fraction of requests that are writes (the rest are reads).",
    effect:
      "Writes bypass caches straight to the store; reads consult the cache first.",
    law: "Cache hit/miss + request types",
  },
  ...pattern,
  ...connectionProps,
];

const CLIENT: ComponentDef = {
  type: "client",
  label: "Client",
  category: "Networking",
  accent: "#38bdf8",
  source: true,
  what: "A traffic source, browsers or services issuing requests.",
  effect: "Drives the arrival process that loads the rest of the system.",
  law: "Arrival process (λ)",
  properties: sourceProps({
    label: "Request rate",
    unit: "req/s",
    default: 200,
    what: "Mean requests issued per second (λ).",
    effect:
      "Higher λ pushes downstream utilization ρ toward 1, where latency diverges.",
  }),
};

const BROWSER: ComponentDef = {
  type: "browser",
  label: "Browser",
  category: "Networking",
  accent: "#7dd3fc",
  source: true,
  what: "A page-load source: end users opening a page, each load a burst of requests.",
  effect:
    "Drives the arrival process from the edge; connection lifecycle here models cold vs warm page loads.",
  law: "Arrival process (λ)",
  properties: sourceProps({
    label: "Page loads",
    unit: "loads/s",
    default: 100,
    what: "Mean page loads per second (λ).",
    effect:
      "Each load offers work to the edge; higher λ pushes the whole path toward saturation.",
  }),
};

// A cron fires on a schedule, so it defaults to the periodic arrival shape.
const cronPatternProps: PropertyDef[] = [
  { ...patternProps[0], default: "periodic" },
  ...patternProps.slice(1),
];

const CRON: ComponentDef = {
  type: "cron",
  label: "Cron Job",
  category: "Compute",
  accent: "#fbbf24",
  source: true,
  what: "A scheduled job that fires work at intervals (batch runs, periodic syncs).",
  effect:
    "A periodic arrival source: each tick offers a wave of work to its downstream.",
  law: "Arrival process (λ)",
  properties: sourceProps(
    {
      label: "Fire rate",
      unit: "jobs/s",
      default: 20,
      what: "Mean jobs fired per second (λ), swung by the periodic schedule.",
      effect:
        "Each tick offers a batch downstream; the periodic shape bunches them into waves.",
    },
    cronPatternProps,
  ),
};

const LOAD_BALANCER: ComponentDef = {
  type: "load-balancer",
  label: "Load Balancer",
  category: "Networking",
  accent: "#22d3ee",
  loadBalance: true, // routes each request to ONE backend, not all
  what: "Distributes incoming requests across backend instances.",
  effect:
    "Spreads load across its backends; can itself saturate at its connection ceiling.",
  law: "Load balancing (call-one)",
  properties: [
    {
      key: "algorithm",
      label: "Algorithm",
      kind: "select",
      default: "round-robin",
      options: ["round-robin", "least-connections", "random"],
      what: "How each request picks a backend.",
      effect:
        "Round-robin cycles; least-connections picks the least-busy; random spreads by chance. Dead backends are skipped.",
      law: "Load balancing (call-one)",
    },
    {
      key: "maxConnections",
      label: "Max connections",
      kind: "number",
      default: 10000,
      unit: "conns",
      min: 1,
      step: 100,
      what: "Concurrent connections the LB will hold open.",
      effect:
        "A hard resource ceiling; beyond it, new connections are rejected.",
      law: QUEUE_LAW,
    },
    {
      key: "serviceTime",
      label: "Forwarding overhead",
      kind: "number",
      default: 1,
      unit: "ms",
      min: 0,
      step: 0.5,
      what: "Time the LB itself adds per request.",
      effect: "Adds a fixed term to the critical-path latency.",
      law: QUEUE_LAW,
    },
  ],
};

const API: ComponentDef = {
  type: "api",
  label: "API",
  category: "Compute",
  accent: "#a78bfa",
  what: "A service that receives requests, does work, and calls dependencies.",
  effect:
    "The canonical queue server: finite threads serving a request stream.",
  law: QUEUE_LAW,
  properties: [
    {
      key: "concurrency",
      label: "Concurrency",
      kind: "number",
      default: 200,
      unit: "threads",
      min: 1,
      step: 1,
      what: "Number of worker threads/servers (c).",
      effect:
        "Resource conservation: c threads cannot serve c+1 requests at once; the rest queue.",
      law: QUEUE_LAW,
    },
    {
      key: "serviceTime",
      label: "Service time",
      kind: "number",
      default: 20,
      unit: "ms",
      min: 0.1,
      step: 1,
      what: "Mean time to handle one request (1/μ).",
      effect: "Sets service rate μ; with λ it fixes utilization ρ = λ/(cμ).",
      law: QUEUE_LAW,
    },
    distKnob,
    fanoutKnob,
    cpuContentionKnob,
    {
      key: "queueCapacity",
      label: "Queue capacity",
      kind: "number",
      default: 1000,
      unit: "slots",
      min: 0,
      step: 10,
      what: "Max requests waiting for a free thread.",
      effect:
        "A bounded queue: overflow is rejection (a defined behavior), not a crash.",
      law: QUEUE_LAW,
    },
    {
      key: "timeout",
      label: "Timeout",
      kind: "number",
      default: 1000,
      unit: "ms",
      min: 1,
      step: 50,
      what: "How long a dependency call waits before giving up.",
      effect:
        "Caps latency but converts slowness into retries, fuel for cascades.",
      law: "Retry/timeout amplification",
    },
    {
      key: "retries",
      label: "Retries",
      kind: "number",
      default: 2,
      unit: "×",
      min: 0,
      max: 10,
      step: 1,
      what: "Times a failed/timed-out dependency call is re-issued.",
      effect:
        "Each retry re-sends the call, multiplying load on a struggling dependency (the cascade amplifier).",
      law: "Retry/timeout amplification",
    },
    backoffKnob,
    ...breakerProps,
    ...connectionProps,
    replicasKnob,
    // API: ~200 threads / 20ms ⇒ ~10k req/s per instance; target well below it.
    ...autoscaleProps(5000),
  ],
};

const REDIS: ComponentDef = {
  type: "redis",
  label: "Redis",
  category: "Storage",
  accent: "#818cf8",
  cache: true, // a healthy hit short-circuits the DB; killing it floods the DB
  what: "An in-memory cache/store, very low latency.",
  effect:
    "Absorbs read load to shield slower stores; bounded by connections + memory.",
  law: QUEUE_LAW,
  properties: [
    {
      key: "concurrency",
      label: "IO threads",
      kind: "number",
      default: 16,
      unit: "threads",
      min: 1,
      step: 1,
      what: "Command-execution concurrency (c), a real cache runs on a few.",
      effect:
        "Sets the throughput ceiling; unlike an infinite pool, a hammered cache queues.",
      law: QUEUE_LAW,
    },
    {
      key: "getLatency",
      label: "GET latency",
      kind: "number",
      default: 1,
      unit: "ms",
      min: 0.05,
      step: 0.1,
      what: "Typical service time of a cache read.",
      effect: "The base cost a cache hit pays; far below a DB query.",
      law: QUEUE_LAW,
    },
    {
      key: "hitRatio",
      label: "Hit ratio",
      kind: "number",
      default: 0.9,
      unit: "",
      min: 0,
      max: 1,
      step: 0.05,
      what: "Fraction of reads served from cache (h).",
      effect:
        "A miss (1−h) falls through to the next tier, so DB load ≈ (1−h)·read λ; killing it drives h→0.",
      law: "Cache hit/miss",
    },
    ...memoryProps,
  ],
};

const POSTGRES: ComponentDef = {
  type: "postgres",
  label: "Postgres",
  category: "Storage",
  accent: "#60a5fa",
  readReplicas: true, // replicas are READ replicas: reads route there, with lag
  what: "A relational database, durable, transactional, the slow tier.",
  effect:
    "Often the bottleneck: a small connection pool serving expensive queries.",
  law: QUEUE_LAW,
  properties: [
    {
      key: "maxConnections",
      label: "Connection pool",
      kind: "number",
      default: 100,
      unit: "conns",
      min: 1,
      step: 1,
      what: "Size of the connection pool (effectively c).",
      effect: "A tight ceiling, the classic place utilization hits 1 first.",
      law: QUEUE_LAW,
    },
    {
      key: "serviceTime",
      label: "Query time",
      kind: "number",
      default: 8,
      unit: "ms",
      min: 0.1,
      step: 1,
      what: "Mean time to execute one query (1/μ).",
      effect:
        "Sets μ for the pool; with λ it fixes how close to saturation it runs.",
      law: QUEUE_LAW,
    },
    distKnob,
    {
      key: "queueCapacity",
      label: "Queue capacity",
      kind: "number",
      default: 500,
      unit: "slots",
      min: 0,
      step: 10,
      what: "Max queries waiting for a free connection.",
      effect: "Bounded wait queue; overflow rejects rather than crashing.",
      law: QUEUE_LAW,
    },
    ...readReplicaProps,
    storageKnob(100),
  ],
};

// Shared timeout, retries, backoff, and breaker knobs for components that call
// dependencies resiliently.
const resilienceProps = (timeoutMs = 1000, retries = 2): PropertyDef[] => [
  {
    key: "timeout",
    label: "Timeout",
    kind: "number",
    default: timeoutMs,
    unit: "ms",
    min: 1,
    step: 50,
    what: "How long a dependency call waits before giving up.",
    effect:
      "Caps latency but converts slowness into retries, fuel for cascades.",
    law: "Retry/timeout amplification",
  },
  {
    key: "retries",
    label: "Retries",
    kind: "number",
    default: retries,
    unit: "×",
    min: 0,
    max: 10,
    step: 1,
    what: "Times a failed/timed-out dependency call is re-issued.",
    effect:
      "Each retry re-sends the call, multiplying load on a struggling dependency.",
    law: "Retry/timeout amplification",
  },
  backoffKnob,
  ...breakerProps,
  ...connectionProps,
];

interface Knob {
  label: string;
  default: number;
  what: string;
  effect: string;
}

const db = (
  type: string,
  label: string,
  accent: string,
  what: string,
  effect: string,
  service: Knob,
  extra: PropertyDef[] = [],
): ComponentDef => ({
  type,
  label,
  category: "Storage",
  accent,
  what,
  effect,
  law: QUEUE_LAW,
  properties: [
    ...queueProfile({
      serversKey: "maxConnections",
      serversLabel: "Connection pool",
      serversDefault: 100,
      serversUnit: "conns",
      serversWhat:
        "Size of the connection pool, the hard concurrency ceiling (c).",
      serversEffect:
        "A tight ceiling; the classic place utilization hits 1 first.",
      serviceKey: "serviceTime",
      serviceLabel: service.label,
      serviceDefault: service.default,
      serviceWhat: service.what,
      serviceEffect: service.effect,
      queueDefault: 500,
    }),
    ...extra,
  ],
});

// A forwarding node: high connection ceiling, small fixed overhead, no queue knob.
const forwarder = (
  type: string,
  label: string,
  category: Category,
  accent: string,
  what: string,
  effect: string,
  service: Knob,
  servers = 10000,
  extra: PropertyDef[] = [],
): ComponentDef => ({
  type,
  label,
  category,
  accent,
  what,
  effect,
  law: QUEUE_LAW,
  properties: [
    ...queueProfile({
      serversKey: "maxConnections",
      serversLabel: "Max connections",
      serversDefault: servers,
      serversUnit: "conns",
      serversWhat: "Concurrent connections it will hold open (c).",
      serversEffect:
        "A resource ceiling; beyond it, new connections are rejected.",
      serviceKey: "serviceTime",
      serviceLabel: service.label,
      serviceDefault: service.default,
      serviceWhat: service.what,
      serviceEffect: service.effect,
      serviceMin: 0.05,
    }),
    ...extra,
  ],
});

const cache = (
  type: string,
  label: string,
  category: Category,
  accent: string,
  what: string,
  effect: string,
  service: Knob,
  opts: { servers?: number; hitRatio?: number; extra?: PropertyDef[] } = {},
): ComponentDef => ({
  type,
  label,
  category,
  accent,
  cache: true,
  what,
  effect,
  law: QUEUE_LAW,
  properties: [
    ...queueProfile({
      serversKey: "concurrency",
      serversLabel: "IO threads",
      serversDefault: opts.servers ?? 16,
      serversUnit: "threads",
      serversWhat:
        "Command-execution concurrency (c), a real cache runs on a few.",
      serversEffect:
        "Sets the throughput ceiling; unlike an infinite pool, a hammered cache queues.",
      serviceKey: "getLatency",
      serviceLabel: service.label,
      serviceDefault: service.default,
      serviceWhat: service.what,
      serviceEffect: service.effect,
      serviceMin: 0.05,
    }),
    {
      key: "hitRatio",
      label: "Hit ratio",
      kind: "number",
      default: opts.hitRatio ?? 0.9,
      unit: "",
      min: 0,
      max: 1,
      step: 0.05,
      what: "Fraction of reads served from cache (h).",
      effect:
        "A miss (1−h) falls through to the next tier; DB load ≈ (1−h)·read λ. Killing it drives h→0.",
      law: "Cache hit/miss",
    },
    ...memoryProps,
    ...(opts.extra ?? []),
  ],
});

const BROKER_LAW = "Async messaging (produce / consume / lag)";

// An async broker: producers enqueue and return at once; a pool of consumers
// drains the backlog. Its deps are the consumer's downstream work.
const broker = (
  type: string,
  label: string,
  accent: string,
  what: string,
  effect: string,
  opts: { consumers?: number; consumeTime?: number; pubsub?: boolean } = {},
): ComponentDef => ({
  type,
  label,
  category: "Messaging",
  accent,
  broker: true,
  what,
  effect,
  law: BROKER_LAW,
  properties: [
    {
      key: "consumers",
      label: "Consumers",
      kind: "number",
      default: opts.consumers ?? 4,
      unit: "consumers",
      min: 1,
      step: 1,
      what: "Parallel consumer slots draining the backlog.",
      effect:
        "Drain rate is consumers / consume time; below the produce rate the backlog (consumer lag) climbs, above it the queue empties.",
      law: BROKER_LAW,
    },
    {
      key: "consumeTime",
      label: "Consume time",
      kind: "number",
      default: opts.consumeTime ?? 10,
      unit: "ms",
      min: 0.1,
      step: 1,
      what: "Mean time a consumer spends handling one message, plus any downstream calls.",
      effect:
        "Sets per-consumer throughput μ; slower consumers drain less and grow the lag.",
      law: BROKER_LAW,
    },
    {
      key: "maxBacklog",
      label: "Max backlog",
      kind: "number",
      default: 0,
      unit: "msgs",
      min: 0,
      step: 1000,
      what: "Buffer bound; 0 means unbounded (disk-backed).",
      effect:
        "A full buffer rejects the produce (backpressure); 0 lets the backlog grow without limit.",
      law: BROKER_LAW,
    },
    ...(opts.pubsub
      ? [
          {
            key: "subscriberGroups",
            label: "Subscriber groups",
            kind: "number" as const,
            default: 1,
            unit: "groups",
            min: 1,
            step: 1,
            what: "Independent subscriber groups; each receives EVERY message and drains with its own consumer pool.",
            effect:
              "1 is a single competing-consumer pool (a message is consumed once). Above 1 is publish/subscribe fan-out: the message is delivered to every group, and their lags are independent.",
            law: "Pub/sub fan-out (subscriber groups)",
          },
        ]
      : []),
  ],
});

const KAFKA = broker(
  "kafka",
  "Kafka",
  "#a78bfa",
  "A distributed commit log for high-throughput streaming.",
  "Producers append fast; consumers drain in parallel and lag when they fall behind. Multiple consumer groups each read every message independently.",
  { consumers: 8, consumeTime: 5, pubsub: true },
);

const SQS = broker(
  "sqs",
  "SQS",
  "#f59e0b",
  "A managed message queue.",
  "Producers enqueue and return; consumers poll and process, lagging under load.",
  { consumers: 4, consumeTime: 20 },
);

const RABBITMQ = broker(
  "rabbitmq",
  "RabbitMQ",
  "#fb7185",
  "A message broker with queues and routing.",
  "Producers publish and return; consumers ack as they process, lagging when slow.",
  { consumers: 4, consumeTime: 15 },
);

const NATS = broker(
  "nats",
  "NATS",
  "#4ade80",
  "A lightweight, high-throughput messaging system.",
  "Fast publish/subscribe: each subscriber group gets every message and drains on its own pool, lagging if it can't keep up.",
  { consumers: 6, consumeTime: 8, pubsub: true },
);

const QUEUE = broker(
  "queue",
  "Queue",
  "#38bdf8",
  "A generic buffered work queue.",
  "Producers enqueue and return; a pool of workers drains the backlog, lagging when it can't keep up.",
  { consumers: 4, consumeTime: 15 },
);

const MYSQL: ComponentDef = {
  ...db(
    "mysql",
    "MySQL",
    "#0ea5e9",
    "A relational database, durable, transactional.",
    "Bottlenecks at its connection pool serving query work.",
    {
      label: "Query time",
      default: 6,
      what: "Mean time to execute one SQL query (1/μ).",
      effect:
        "Sets μ for the pool; joins and locks lengthen it, saturating the pool sooner.",
    },
    [...readReplicaProps, storageKnob(100)],
  ),
  readReplicas: true, // the canonical read-replica database
};

const MONGODB = db(
  "mongodb",
  "MongoDB",
  "#4ade80",
  "A document database.",
  "A pool of connections serving document reads and writes.",
  {
    label: "Op time",
    default: 4,
    what: "Mean time to serve one document read/write (1/μ).",
    effect: "Sets μ; unindexed queries lengthen it and tie up connections.",
  },
  [storageKnob(100)],
);

const CASSANDRA = db(
  "cassandra",
  "Cassandra",
  "#c084fc",
  "A wide-column store built for high write throughput.",
  "Masterless peers absorbing writes; write capacity scales with node count.",
  {
    label: "Write time",
    default: 3,
    what: "Mean time to commit one write per node (1/μ).",
    effect:
      "Sets μ; append-optimized writes stay low, so per-node write throughput is high.",
  },
  quorumProps,
);

const ELASTICSEARCH = db(
  "elasticsearch",
  "Elasticsearch",
  "#facc15",
  "A search / analytics engine.",
  "Search work over a connection pool; shards fan out (not yet simulated).",
  {
    label: "Query time",
    default: 12,
    what: "Mean time to run one search (1/μ).",
    effect: "Sets μ; heavy aggregations lengthen it and back the pool up.",
  },
  [
    {
      key: "shards",
      label: "Shards",
      kind: "number",
      default: 1,
      unit: "shards",
      min: 1,
      step: 1,
      what: "How the index is partitioned into independent cells.",
      effect:
        "Each shard is its own pool over its own key slice: N shards multiply the write/query ceiling and isolate failures (a dead shard drops only its slice). 1 is a single node.",
      law: "Sharding / fan-out",
    },
  ],
);

const S3 = forwarder(
  "s3",
  "S3 / Object Store",
  "Storage",
  "#fb923c",
  "A durable object store.",
  "High-concurrency object GET/PUT over the network.",
  {
    label: "Object latency",
    default: 15,
    what: "Mean time to serve one object GET/PUT (1/μ).",
    effect: "Sets μ per request; large objects and cold reads lengthen it.",
  },
  100000,
  [egressKnob(250), egressRateKnob(0.09), storageKnob(100)],
);

const MEMCACHED = cache(
  "memcached",
  "Memcached",
  "Storage",
  "#f472b6",
  "A simple in-memory cache.",
  "Absorbs read load to shield slower stores.",
  {
    label: "GET latency",
    default: 0.5,
    what: "Mean service time of a cache read (1/μ).",
    effect: "The base cost a hit pays, far below any backing store.",
  },
);

const CDN = cache(
  "cdn",
  "CDN",
  "Networking",
  "#34d399",
  "An edge cache serving content near the user.",
  "A healthy edge hit skips the origin; a miss falls through.",
  {
    label: "Edge latency",
    default: 5,
    what: "Mean time the edge takes to serve a cached asset (1/μ).",
    effect: "A hit pays this instead of the full origin round trip.",
  },
  {
    servers: 1000,
    hitRatio: 0.85,
    extra: [egressKnob(100), egressRateKnob(0.085)],
  },
);

const CLOUDFRONT = cache(
  "cloudfront",
  "CloudFront",
  "Networking",
  "#f472b6",
  "AWS's edge CDN caching content near the user.",
  "A healthy edge hit skips the origin; a miss falls through, exactly the CDN law.",
  {
    label: "Edge latency",
    default: 6,
    what: "Mean time the edge takes to serve a cached asset (1/μ).",
    effect: "A hit pays this instead of the full origin round trip.",
  },
  {
    servers: 1000,
    hitRatio: 0.85,
    extra: [egressKnob(100), egressRateKnob(0.085)],
  },
);

const DNS = forwarder(
  "dns",
  "DNS",
  "Networking",
  "#2dd4bf",
  "Name resolution.",
  "Adds a lookup hop; if it slows or dies, everything downstream stalls.",
  {
    label: "Resolution time",
    default: 2,
    what: "Mean time to resolve a name (1/μ).",
    effect:
      "Adds to every downstream connection; if it climbs, the whole path stalls.",
  },
);

const API_GATEWAY = forwarder(
  "api-gateway",
  "API Gateway",
  "Networking",
  "#93c5fd",
  "The edge entry point: routing, auth, rate limits.",
  "Forwards to backends and adds a small per-request overhead.",
  {
    label: "Routing overhead",
    default: 2,
    what: "Per-request time the gateway itself adds (1/μ).",
    effect: "A fixed term on the critical path before any backend is touched.",
  },
  10000,
  resilienceProps(),
);

const REVERSE_PROXY = forwarder(
  "reverse-proxy",
  "Reverse Proxy",
  "Networking",
  "#94a3b8",
  "An Nginx-style reverse proxy / gateway.",
  "Forwards requests with minimal overhead; a shared entry choke point.",
  {
    label: "Forwarding overhead",
    default: 1,
    what: "Time the proxy adds forwarding one request (1/μ).",
    effect: "Small, but every request pays it, a shared entry cost.",
  },
);

const FIREWALL = forwarder(
  "firewall",
  "Firewall",
  "Networking",
  "#fb7185",
  "Packet / connection inspection at the perimeter.",
  "Adds inspection latency; a saturable choke point in the path.",
  {
    label: "Inspection time",
    default: 0.5,
    what: "Time to inspect one packet/connection (1/μ).",
    effect: "Adds latency inline; under load it becomes a choke point.",
  },
  100000,
);

const ROUTER = forwarder(
  "router",
  "Router",
  "Networking",
  "#64748b",
  "A link-layer forwarder moving packets between networks.",
  "A pass-through hop that adds forwarding delay; killable and partitionable like any node.",
  {
    label: "Forwarding delay",
    default: 0.2,
    what: "Time to forward one packet (1/μ).",
    effect:
      "Adds a small term to every crossing; kill or partition it to cut the segment.",
  },
);

const SWITCH = forwarder(
  "switch",
  "Switch",
  "Networking",
  "#475569",
  "A link-layer switch forwarding frames within a network.",
  "A near-zero-latency hop; a shared segment that can be killed or partitioned.",
  {
    label: "Forwarding delay",
    default: 0.05,
    what: "Time to switch one frame (1/μ).",
    effect:
      "Tiny per-frame cost; its value is as a killable/partitionable segment in the path.",
  },
);

const INGRESS = forwarder(
  "ingress",
  "Ingress",
  "Infrastructure",
  "#5eead4",
  "The cluster's HTTP entry point.",
  "Routes external traffic inward; overhead plus a connection ceiling.",
  {
    label: "Routing overhead",
    default: 1,
    what: "Per-request routing cost at the cluster edge (1/μ).",
    effect: "A fixed entry term; its connection ceiling can also bind.",
  },
);

const WORKER: ComponentDef = {
  type: "worker",
  label: "Worker",
  category: "Compute",
  accent: "#a3e635",
  what: "A background processor that pulls work and calls dependencies.",
  effect: "A queue server with modest concurrency doing heavier per-item work.",
  law: QUEUE_LAW,
  properties: [
    ...queueProfile({
      serversKey: "concurrency",
      serversLabel: "Concurrency",
      serversDefault: 50,
      serversUnit: "workers",
      serversWhat: "Number of workers processing in parallel (c).",
      serversEffect:
        "Sets the drain rate; too few and the backlog grows unbounded.",
      serviceKey: "serviceTime",
      serviceLabel: "Job time",
      serviceDefault: 40,
      serviceWhat: "Mean time to process one job (1/μ).",
      serviceEffect:
        "Heavier than an API call; with concurrency it fixes throughput.",
      queueDefault: 1000,
    }),
    ...resilienceProps(),
    fanoutKnob,
    cpuContentionKnob,
    replicasKnob,
    // Worker: ~50 workers / 40ms ⇒ ~1250 jobs/s per instance.
    ...autoscaleProps(800),
  ],
};

const LAMBDA: ComponentDef = {
  type: "lambda",
  label: "Lambda",
  category: "Compute",
  accent: "#fdba74",
  what: "A serverless function that scales instances with load.",
  effect:
    "High concurrency with per-invocation work; cold starts add latency (not yet simulated).",
  law: QUEUE_LAW,
  properties: [
    ...queueProfile({
      serversKey: "concurrency",
      serversLabel: "Max concurrency",
      serversDefault: 1000,
      serversUnit: "execs",
      serversWhat: "Ceiling on concurrent executions (c).",
      serversEffect:
        "Scales with load up to this cap; beyond it, invocations are throttled.",
      serviceKey: "serviceTime",
      serviceLabel: "Exec time",
      serviceDefault: 30,
      serviceWhat: "Mean function execution time (1/μ).",
      serviceEffect:
        "Sets μ per instance; concurrency scales out but each invoke pays this.",
    }),
    {
      key: "coldStartMs",
      label: "Cold start",
      kind: "number",
      default: 200,
      unit: "ms",
      min: 0,
      step: 10,
      what: "Extra latency to spin up a new instance.",
      effect: "Adds latency on a cold path (not yet simulated).",
      law: "Cold start / warmup",
      pending: true,
    },
    cpuContentionKnob,
    ...resilienceProps(),
  ],
};

const COMPONENTS: readonly ComponentDef[] = [
  // Networking
  CLIENT,
  BROWSER,
  DNS,
  CDN,
  CLOUDFRONT,
  API_GATEWAY,
  REVERSE_PROXY,
  FIREWALL,
  ROUTER,
  SWITCH,
  LOAD_BALANCER,
  // Compute
  API,
  WORKER,
  LAMBDA,
  CRON,
  // Storage
  REDIS,
  MEMCACHED,
  POSTGRES,
  MYSQL,
  MONGODB,
  CASSANDRA,
  ELASTICSEARCH,
  S3,
  // Messaging
  KAFKA,
  SQS,
  RABBITMQ,
  NATS,
  QUEUE,
  // Infrastructure
  INGRESS,
];

// The connection/channel itself carries behavior.
export const CHANNEL: ChannelDef = {
  properties: [
    {
      key: "latency",
      label: "Latency",
      kind: "number",
      default: 1,
      unit: "ms",
      min: 0,
      step: 0.5,
      what: "One-way propagation delay on this link.",
      effect: "Adds directly to the request's critical-path latency.",
      law: "Latency accumulation on the critical path",
    },
    {
      key: "jitter",
      label: "Jitter",
      kind: "number",
      default: 0,
      unit: "ms",
      min: 0,
      step: 1,
      what: "Mean extra random delay per leg (seeded exponential; 0 = fixed latency).",
      effect:
        "Spreads packet timing the way real networks do, the tails stack up on the critical path.",
      law: "Latency jitter",
    },
    {
      key: "bandwidth",
      label: "Bandwidth",
      kind: "number",
      default: 1000,
      unit: "Mbps",
      min: 1,
      step: 100,
      what: "Capacity of the link.",
      effect: "Caps throughput; large payloads serialize behind it.",
      law: "Resource conservation",
    },
  ],
};

const byType = new Map(COMPONENTS.map((c) => [c.type, c]));

export const listComponents = (): readonly ComponentDef[] => COMPONENTS;

export const getComponent = (type: string): ComponentDef | undefined =>
  byType.get(type);

const defaultsOf = (props: readonly PropertyDef[]): NodeConfig => {
  const cfg: NodeConfig = {};
  for (const p of props) cfg[p.key] = p.default;
  return cfg;
};

/** The sane default config for a component type. */
export const defaultConfig = (type: string): NodeConfig => {
  const def = getComponent(type);
  return def ? defaultsOf(def.properties) : {};
};

/** The sane default channel config for a new edge. */
export const defaultChannelConfig = (): NodeConfig =>
  defaultsOf(CHANNEL.properties);
