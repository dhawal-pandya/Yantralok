// The single-server-queue law composed across a graph. Modeled as independent
// CALLS (actor style) rather than one nested stack, because timeouts need two
// concurrent continuations: the orphaned slow call keeps running (still holding
// the resource, the amplification) while the caller gives up and retries.
//
// A call holds one of its station's c servers for its whole life, INCLUDING while
// it waits on a child. Blocking is what makes thread-pool exhaustion, bottlenecks,
// and cascades emerge rather than being scripted.
//
// Per dependency call: timeout orphans the in-flight child; retries re-issue a
// failed call N times (load amplification); a healthy cache shortCircuit ends
// handling while a dead one falls through; a required dep that exhausts its
// retries fails the calling station.
//
// Determinism: logical clock only, injected seeded PRNG only, total order via
// (time, seq). Handlers operate ONLY through ctx.state; the closure captures just
// the static scenario, so snapshots clone only runtime.
import type { EventHandler, SimContext } from "../simulation";
import type { ArrivalShape, DependencyCall, Scenario } from "../scenario";

/** One in-flight branch of a parallel fan-out. */
interface Branch {
  dep: number; // index into the station's deps
  attempt: number; // retries used on this branch
  token: number; // validity token for the branch's in-flight child
  childId: number | null; // to orphan on timeout
  done: boolean;
  connDep: number; // dep index whose connection this branch holds (-1 = none)
}

/** Keep-alive connection pool for one caller-to-dependency link. */
interface ConnPool {
  idle: number; // warm connections available for reuse
  dnsCachedUntil: number; // DNS resolution is cached until this logical time
}

// Circuit-breaker states. A breaker guards one caller-to-dependency edge.
const CLOSED = 0;
const OPEN = 1;
const HALF_OPEN = 2;

/** Runtime state of one dependency's circuit breaker. Deterministic: it reads the
 * logical clock and call outcomes, never the PRNG. */
interface Breaker {
  state: number; // CLOSED | OPEN | HALF_OPEN
  failures: number; // failures counted in the current window (CLOSED only)
  successes: number; // successes counted in the current window
  windowStart: number; // start of the rolling window
  openedAt: number; // when it last tripped OPEN (cooldown baseline)
  probing: boolean; // a half-open probe is in flight (others fast-fail)
}

interface Call {
  id: number;
  rootId: number; // the top-level request id (groups a call tree for the inspector)
  station: number;
  parent: number | null; // parent call id; null = root OR orphaned-by-timeout
  isRoot: boolean;
  parentToken: number; // token to echo to the parent on return
  start: number; // root: arrival time (for end-to-end latency)
  depIndex: number;
  attempt: number; // retries used on the current dependency
  token: number; // validity token for this call's in-flight child (timeout race)
  childId: number | null; // current in-flight child (to orphan on timeout)
  write: boolean; // request type: writes bypass caches to the store
  chosen: number; // routing "one": the dep index picked for this call
  pool: number; // seat held: 0 primary, 1 replica, -1 unpooled
  branches: Branch[] | null; // parallel fan-out: non-null while joining
  outstanding: number; // parallel branches still in flight
  viaDep: number; // the parent's dep index this call came through (-1 for roots)
  // Trace-span timing, filled as the call moves through its phases.
  tAdmit: number; // arrived at station (start + network-in); -1 until admitted
  tService: number; // got a server (queue wait ends); -1 until service starts
  depth: number; // nesting depth in the request's call tree
  attemptNo: number; // which parent-attempt this call is (0 = first, >0 = retry)
  timedOut: boolean; // the parent gave up on this call via timeout
  consumer: boolean; // a broker consumer draining one message (holds a consumer slot)
  group: number; // pub/sub subscriber group this consumer drains (-1 = single pool)
  shard: number; // shard/quorum cell this call is seated in (-1 = none)
  // Masterless quorum. A coordinator op (qTarget > 0) fans replica sub-calls out to
  // its cells and returns to its caller on the qTarget-th ack; a replica sub-call
  // (quorumParent >= 0) just does one node's work and notifies its coordinator.
  quorumParent: number; // coordinator op id for a replica sub-call (-1 = not a replica)
  qTarget: number; // quorum a coordinator waits for: W (write) or R (read); 0 = not a coordinator
  qFan: number; // replica sub-calls this coordinator fanned out
  qDone: number; // replica acks received
  qFailed: number; // replica failures (dead node / full queue)
  qReturned: boolean; // the coordinator already returned to its caller (quorum reached or doomed)
  connDep: number; // dep index whose connection this call holds (-1 = none)
}

/** One pub/sub subscriber group's runtime: its own backlog + consumer pool, so its
 * lag is independent of every other group's. */
interface GroupRuntime {
  backlog: number;
  busy: number; // consumers of this group currently draining
  consumed: number;
  areaBacklog: number; // ∫ backlog dt, this group's lag integral
}

interface StationRuntime {
  busy: number;
  waiting: number[]; // FIFO of waiting call ids
  lastT: number;
  areaBusy: number;
  areaWait: number;
  arrivals: number;
  admitted: number;
  rejected: number;
  departures: number;
  dead: boolean;
  partitioned: boolean; // network-isolated: alive but unreachable, inbound calls fail
  extraDelayMs: number;
  hits: number; // cache reads served here
  misses: number; // cache reads that fell through to the next tier
  rrCursor: number; // round-robin position for routing "one"
  // Capacity lives in runtime so the control loop can move it. For unscaled
  // stations these stay at their initial values forever.
  servers: number; // CURRENT capacity (c); admission checks this, not the spec
  instances: number; // online instances (1 when unscaled)
  pending: number; // instances provisioned but not yet online
  areaCap: number; // ∫ servers dt, the honest ρ denominator under changing capacity
  scaleAreaBusy: number; // control-loop measurement baselines (last tick)
  scaleAreaCap: number;
  scaleArrivals: number;
  scaleHold: boolean; // last window was contaminated (dead): measure, don't act
  recentDesired: [t: number, desired: number][]; // scale-down stabilization window
  // Read-replica per-pool seat counts plus the staleness bookkeeping.
  busyPrimary: number;
  busyReplica: number;
  lastWriteAt: number; // last write commit; a replica read within lagMs is stale
  replicaReads: number;
  staleReads: number;
  breakers: Breaker[]; // per-dep circuit breaker; one slot per dep, inert unless configured
  // Broker: async produce/consume. `backlog` is the consumer lag; consumer slots
  // reuse `busy` (servers = consumer count). areaBacklog integrates lag over time.
  backlog: number;
  produced: number;
  consumed: number;
  areaBacklog: number;
  // Pub/sub subscriber groups. Empty unless the broker fans out; when set, these
  // drive produce/consume instead of the single backlog above.
  groups: GroupRuntime[];
  // Horizontal shard cells. Empty unless the station is sharded; when set, admission
  // routes to one cell and these per-cell arrays replace the station-level busy/queue.
  shardBusy: number[];
  shardWaiting: number[][];
  shardDead: boolean[];
  shardArrivals: number[]; // arrivals routed to each cell (for the even-spread check)
  conns: ConnPool[]; // per-dep keep-alive pool, inert unless the dep models connections
  handshakes: number; // new connections opened (cold, paid a handshake)
}

/** One call's span in the request trace. Absolute logical times; the waterfall
 * derives network / queue-wait / service from them. */
export interface SpanRec {
  req: number; // root request id (groups a call tree)
  call: number;
  parent: number | null; // parent call id, for nesting
  station: number; // station index (host maps to node id)
  depth: number;
  issue: number; // parent issued it (root: arrival)
  admit: number; // arrived at station (issue + network-in)
  service: number; // service started (admit + queue wait); -1 if never served
  end: number; // service/failure end (before network-out)
  net: number; // one-way link latency (0 for the root)
  attempt: number;
  timedOut: 0 | 1;
  error: 0 | 1;
}

// Bounded, deterministic span capture: stop recording past this many spans so
// long runs stay cheap. Early requests, the ones the inspector samples, are
// captured in full.
const SPAN_BUDGET = 8000;

// Same bounded-capture idea for per-completion latency samples (percentile
// charts): each sample is just two numbers, so the budget can be far larger.
const LATENCY_BUDGET = 50_000;

// Autoscaling tolerance band: no decision while the metric/target ratio is within
// ±10%. The first oscillation damper (the other is the stabilization window),
// same idea as the Kubernetes HPA tolerance.
const SCALE_TOLERANCE = 0.1;

export interface NetworkState {
  stations: StationRuntime[];
  calls: Map<number, Call>;
  nextId: number;
  completions: number;
  failures: number;
  sumLatency: number;
  maxLatency: number;
  spans: SpanRec[];
  latencies: [time: number, lat: number][]; // completed-request samples, for percentile charts
  // Cumulative latency-breakdown totals over every concluded call (the waterfall
  // decomposition, aggregated). Unbounded counters, diffed per window for the
  // breakdown chart, so they don't inherit the span budget's cutoff.
  sumNet: number; // Σ round-trip network time over non-root calls
  netCalls: number; // # non-root concluded calls (the netMs denominator)
  sumQueue: number; // Σ queue-wait time over all concluded calls
  sumService: number; // Σ service time over all concluded calls
  concludedCalls: number; // # concluded calls (the queue/service denominator)
}

export interface Network {
  state: NetworkState;
  handler: EventHandler<NetworkState>;
  init: (ctx: SimContext<NetworkState>) => void;
}

const num = (e: { data?: Record<string, number> }, k: string): number => {
  const v = e.data?.[k];
  if (v === undefined) throw new Error(`event missing field ${k}`);
  return v;
};

// Gated Bernoulli draw: no PRNG is consumed at p≤0 or p≥1, so a scenario that
// doesn't use hit-ratio / request-types stays byte-identical.
function bernoulli(ctx: SimContext<NetworkState>, p: number): boolean {
  if (p <= 0) return false;
  if (p >= 1) return true;
  return ctx.prng.nextFloat() < p;
}

// Route a request to one shard cell by a deterministic hash of its id (a splitmix
// finalizer, so sequential ids spread evenly across cells). No PRNG consumed, so a
// sharded station doesn't perturb the arrival stream; the same id always maps to the
// same cell (key affinity: a retry re-hits its shard).
function hashShard(id: number, n: number): number {
  let x = id >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x % n;
}

// λ(t)/λmax for a shaped (non-homogeneous Poisson) arrival process. Candidates
// are generated at λmax and accepted with this ratio: seeded thinning.
function shapeRatio(shape: ArrivalShape, t: number): number {
  if (shape.kind === "burst") {
    const s = shape.startMs ?? 0;
    const inWindow = t >= s && t < s + (shape.durationMs ?? 0);
    return inWindow ? 1 : 1 / Math.max(1, shape.x ?? 1);
  }
  if (shape.kind === "periodic") {
    const a = Math.max(0, Math.min(1, shape.amplitude ?? 0.5));
    const p = Math.max(1, shape.periodMs ?? 5000);
    return (1 + a * Math.sin((2 * Math.PI * t) / p)) / (1 + a);
  }
  // ramp: climb linearly from 0 to the full rate over rampMs
  return Math.min(1, t / Math.max(1, shape.rampMs ?? 1));
}

/** Peak-rate multiplier over the base rate (the thinning envelope λmax/λ). */
function shapePeak(shape: ArrivalShape): number {
  if (shape.kind === "burst") return Math.max(1, shape.x ?? 1);
  if (shape.kind === "periodic") return 1 + Math.max(0, Math.min(1, shape.amplitude ?? 0.5));
  return 1; // ramp never exceeds the base rate
}

// Cell count for a station that partitions into cells: shard fan-out or quorum
// peers both reuse the per-cell busy/queue/dead arrays. 0 = not partitioned.
function cellCount(spec: Scenario["stations"][number]): number {
  return spec.shards?.count ?? spec.quorum?.nodes ?? 0;
}

function makeInitialState(scenario: Scenario): NetworkState {
  return {
    stations: scenario.stations.map((spec) => ({
      busy: 0,
      waiting: [],
      lastT: 0,
      areaBusy: 0,
      areaWait: 0,
      arrivals: 0,
      admitted: 0,
      rejected: 0,
      departures: 0,
      dead: false,
      partitioned: false,
      extraDelayMs: 0,
      hits: 0,
      misses: 0,
      rrCursor: -1,
      servers: spec.scaling
        ? spec.scaling.initialInstances * spec.scaling.perInstanceServers
        : spec.servers,
      instances: spec.scaling?.initialInstances ?? 1,
      pending: 0,
      areaCap: 0,
      scaleAreaBusy: 0,
      scaleAreaCap: 0,
      scaleArrivals: 0,
      scaleHold: false,
      recentDesired: [],
      busyPrimary: 0,
      busyReplica: 0,
      lastWriteAt: -1e15, // "long ago": nothing is stale before the first write
      replicaReads: 0,
      staleReads: 0,
      breakers: spec.deps.map(() => ({
        state: CLOSED,
        failures: 0,
        successes: 0,
        windowStart: 0,
        openedAt: 0,
        probing: false,
      })),
      backlog: 0,
      produced: 0,
      consumed: 0,
      areaBacklog: 0,
      groups: (spec.broker?.groups ?? []).map(() => ({
        backlog: 0,
        busy: 0,
        consumed: 0,
        areaBacklog: 0,
      })),
      shardBusy: cellCount(spec) ? new Array(cellCount(spec)).fill(0) : [],
      shardWaiting: cellCount(spec) ? Array.from({ length: cellCount(spec) }, () => []) : [],
      shardDead: cellCount(spec) ? new Array(cellCount(spec)).fill(false) : [],
      shardArrivals: cellCount(spec) ? new Array(cellCount(spec)).fill(0) : [],
      conns: spec.deps.map(() => ({ idle: 0, dnsCachedUntil: -1e15 })),
      handshakes: 0,
    })),
    calls: new Map(),
    nextId: 0,
    completions: 0,
    failures: 0,
    sumLatency: 0,
    maxLatency: 0,
    spans: [],
    latencies: [],
    sumNet: 0,
    netCalls: 0,
    sumQueue: 0,
    sumService: 0,
    concludedCalls: 0,
  };
}

export function createNetwork(scenario: Scenario): Network {
  const integrate = (st: StationRuntime, now: number): void => {
    const dt = now - st.lastT;
    if (dt > 0) {
      st.areaBusy += st.busy * dt;
      st.areaWait += st.waiting.length * dt;
      st.areaCap += st.servers * dt;
      st.areaBacklog += st.backlog * dt;
      for (const g of st.groups) g.areaBacklog += g.backlog * dt; // empty unless pub/sub
      st.lastT = now;
    }
  };

  // Fixed tail profiles per distribution. The select is the user's input; these
  // are the law's constants (like the autoscaler's tolerance band).
  const LOGNORMAL_SIGMA = 0.7; // p99 ≈ 5× the median
  const PARETO_ALPHA = 2.2; // heavy tail, finite mean

  // Draw one service time with the station's distribution. Every branch has the
  // same mean (1/μ) and differs only in tail. Exponential is the original path,
  // one PRNG draw, so default scenarios stay byte-identical.
  const drawServiceMs = (ctx: SimContext<NetworkState>, station: number, call?: Call): number => {
    const spec = scenario.stations[station];
    // A pub/sub consumer drains at its own group's rate (exponential), independent
    // of the station's default consume time and of every other group.
    if (call?.consumer && call.group >= 0 && spec.broker?.groups) {
      return ctx.prng.exponential(spec.broker.groups[call.group].consumeRatePerMs);
    }
    const mean = 1 / spec.serviceRatePerMs;
    switch (spec.dist) {
      case "deterministic":
        return mean; // no draw
      case "lognormal": {
        // Box-Muller; μ chosen so E[X] = mean.
        const u1 = ctx.prng.nextFloat();
        const u2 = ctx.prng.nextFloat();
        const z = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
        const mu = Math.log(mean) - (LOGNORMAL_SIGMA * LOGNORMAL_SIGMA) / 2;
        return Math.exp(mu + LOGNORMAL_SIGMA * z);
      }
      case "pareto": {
        // xm chosen so E[X] = mean; α > 1 keeps the mean finite.
        const xm = (mean * (PARETO_ALPHA - 1)) / PARETO_ALPHA;
        return xm / Math.pow(1 - ctx.prng.nextFloat(), 1 / PARETO_ALPHA);
      }
      default:
        return ctx.prng.exponential(spec.serviceRatePerMs);
    }
  };

  const scheduleOwnService = (ctx: SimContext<NetworkState>, c: Call): void => {
    const st = ctx.state.stations[c.station];
    // CPU contention: the busier the box, the slower each unit of its own work,
    // so latency rises with load before the queue itself saturates. Deterministic
    // (a multiply on the seeded draw); gated on cpuContention so unset stays identical.
    const k = scenario.stations[c.station].cpuContention ?? 0;
    const factor = k > 0 && st.servers > 0 ? 1 + k * Math.min(1, st.busy / st.servers) : 1;
    ctx.schedule(drawServiceMs(ctx, c.station, c) * factor + st.extraDelayMs, "serviceEnd", { call: c.id });
  };

  // One network leg's latency: the base plus seeded exponential jitter. Gated so
  // no PRNG is consumed when the link carries no jitter.
  const legMs = (ctx: SimContext<NetworkState>, d: DependencyCall): number =>
    d.jitterMs && d.jitterMs > 0 ? d.latencyMs + ctx.prng.exponential(1 / d.jitterMs) : d.latencyMs;

  // Retry backoff. Attempt n waits a seeded full-jitter draw over [0, base·2^(n−1)]
  // (the AWS anti-thundering-herd schedule), capped so a long retry chain can't
  // explode. Gated: base 0 means immediate re-issue with no PRNG drawn. The
  // doubling factor and exponent cap are the law's fixed constants.
  const RETRY_MULT = 2;
  const RETRY_MAX_EXP = 6; // ceiling grows to at most 2^6 = 64× the base
  const backoffDelay = (ctx: SimContext<NetworkState>, d: DependencyCall, attempt: number): number => {
    const base = d.backoffMs ?? 0;
    if (base <= 0) return 0;
    const ceil = base * Math.pow(RETRY_MULT, Math.min(attempt - 1, RETRY_MAX_EXP));
    return ctx.prng.nextFloat() * ceil;
  };

  // The dep index a call is currently talking to: the picked backend for routing
  // "one", else the sequential dep pointer. Used to key the breaker.
  const curDepIdx = (c: Call): number =>
    scenario.stations[c.station].routing === "one" ? c.chosen : c.depIndex;

  // Gate a dependency call. Returns true to send a real call (CLOSED, or the single
  // HALF-OPEN probe), false to fast-fail. Mutates only its own breaker state and
  // reads the logical clock, no PRNG, so it stays deterministic.
  const breakerAllows = (ctx: SimContext<NetworkState>, stationIdx: number, depIdx: number): boolean => {
    const cfg = scenario.stations[stationIdx].deps[depIdx].breaker;
    if (!cfg) return true;
    const b = ctx.state.stations[stationIdx].breakers[depIdx];
    if (b.state === OPEN) {
      if (ctx.now - b.openedAt < cfg.cooldownMs) return false; // still cooling
      b.state = HALF_OPEN; // cooldown elapsed: this call is the probe
      b.probing = true;
      return true;
    }
    if (b.state === HALF_OPEN) return false; // a probe is already out
    return true; // CLOSED
  };

  // Record a real dependency outcome into its breaker. Fast-fails don't call this,
  // so an OPEN breaker only recovers on a genuine probe result.
  const breakerRecord = (ctx: SimContext<NetworkState>, stationIdx: number, depIdx: number, ok: boolean): void => {
    const cfg = scenario.stations[stationIdx].deps[depIdx].breaker;
    if (!cfg) return;
    const b = ctx.state.stations[stationIdx].breakers[depIdx];
    if (b.state === HALF_OPEN) {
      b.probing = false;
      if (ok) {
        b.state = CLOSED; // recovered: close and start a fresh window
        b.failures = 0;
        b.successes = 0;
        b.windowStart = ctx.now;
      } else {
        b.state = OPEN; // still failing: back to OPEN for another cooldown
        b.openedAt = ctx.now;
      }
      return;
    }
    // CLOSED: roll the window, count the outcome, then trip if the rate is high enough.
    if (ctx.now - b.windowStart >= cfg.windowMs) {
      b.windowStart = ctx.now;
      b.failures = 0;
      b.successes = 0;
    }
    if (ok) b.successes++;
    else b.failures++;
    const total = b.failures + b.successes;
    if (total >= cfg.minCalls && b.failures >= total * cfg.threshold) {
      b.state = OPEN;
      b.openedAt = ctx.now;
    }
  };

  // Emit one span for a concluded call. The breakdown totals accumulate for EVERY
  // call (unbounded); only the span push itself is capped, since the waterfall
  // only needs early requests.
  const recordSpan = (ctx: SimContext<NetworkState>, c: Call, ok: boolean): void => {
    const s = ctx.state;
    const admit = c.tAdmit >= 0 ? c.tAdmit : c.start;
    if (c.depth > 0) {
      // Root calls never crossed a link (net is 0), so they'd dilute the network
      // mean; count only downstream hops toward it.
      s.sumNet += (c.tAdmit >= 0 ? c.tAdmit - c.start : 0) * 2; // both legs
      s.netCalls++;
    }
    if (c.tService >= 0) {
      s.sumQueue += c.tService - admit;
      s.sumService += ctx.now - c.tService;
    } else {
      s.sumQueue += ctx.now - admit; // never got a server: all wait, no service
    }
    s.concludedCalls++;

    const spans = s.spans;
    if (spans.length >= SPAN_BUDGET) return;
    spans.push({
      req: c.rootId,
      call: c.id,
      parent: c.parent,
      station: c.station,
      depth: c.depth,
      issue: c.start,
      admit,
      service: c.tService,
      end: ctx.now,
      net: c.tAdmit >= 0 ? c.tAdmit - c.start : 0, // request-leg latency (== return leg)
      attempt: c.attemptNo,
      timedOut: c.timedOut ? 1 : 0,
      error: ok ? 0 : 1,
    });
  };

  // The dependency a call is currently talking to: the picked backend for routing
  // "one", or the sequential dep index for "all".
  const currentDep = (c: Call) => {
    const spec = scenario.stations[c.station];
    return spec.routing === "one" ? spec.deps[c.chosen] : spec.deps[c.depIndex];
  };

  // Open (or reuse) a connection for a dependency call, returning the extra latency
  // added to the outbound leg. A warm keep-alive connection costs nothing; a new one
  // pays the TLS handshake plus a DNS lookup (unless the resolution is still cached).
  // No config means no cost, so scenarios without connection modeling stay identical.
  const establishConn = (ctx: SimContext<NetworkState>, station: number, depIdx: number): number => {
    const cfg = scenario.stations[station].deps[depIdx].connection;
    if (!cfg) return 0;
    const cp = ctx.state.stations[station].conns[depIdx];
    if (cp.idle > 0) {
      cp.idle--; // reuse a warm connection: no handshake, no DNS
      return 0;
    }
    ctx.state.stations[station].handshakes++;
    let extra = cfg.handshakeMs;
    if (ctx.now >= cp.dnsCachedUntil) {
      extra += cfg.dnsMs; // cache miss: resolve, then cache for the TTL
      cp.dnsCachedUntil = ctx.now + cfg.dnsTtlMs;
    }
    return extra;
  };

  // Return a connection to the keep-alive pool when its call concludes (bounded by
  // the pool size; beyond it the connection is closed).
  const checkinConn = (ctx: SimContext<NetworkState>, station: number, depIdx: number): void => {
    const cfg = scenario.stations[station].deps[depIdx].connection;
    if (!cfg) return;
    const cp = ctx.state.stations[station].conns[depIdx];
    if (cp.idle < cfg.poolSize) cp.idle++;
  };

  // Spawn a child call to dependency `depIdx` (with its link latency + timeout
  // race). `branch` binds the child to one arm of a parallel fan-out; without it,
  // the child is the caller's single sequential in-flight call.
  const issueChild = (
    ctx: SimContext<NetworkState>,
    c: Call,
    depIdx: number,
    branch: Branch | null,
  ): void => {
    const d = scenario.stations[c.station].deps[depIdx];
    c.token++;
    const tok = c.token;
    const child: Call = {
      id: ctx.state.nextId++,
      rootId: c.rootId,
      station: d.to,
      parent: c.id,
      isRoot: false,
      parentToken: tok,
      start: ctx.now,
      depIndex: 0,
      attempt: 0,
      token: 0,
      childId: null,
      write: c.write,
      chosen: -1,
      pool: -1,
      branches: null,
      outstanding: 0,
      viaDep: depIdx,
      tAdmit: -1,
      tService: -1,
      depth: c.depth + 1,
      attemptNo: branch ? branch.attempt : c.attempt, // the current attempt #
      timedOut: false,
      consumer: false,
      group: -1,
      shard: -1,
      quorumParent: -1,
      qTarget: 0,
      qFan: 0,
      qDone: 0,
      qFailed: 0,
      qReturned: false,
      connDep: -1,
    };
    ctx.state.calls.set(child.id, child);
    // Open/reuse a connection; a new one adds handshake + DNS to the outbound leg.
    const connExtra = establishConn(ctx, c.station, depIdx);
    if (branch) {
      branch.token = tok;
      branch.childId = child.id;
      branch.connDep = depIdx;
    } else {
      c.childId = child.id;
      c.connDep = depIdx;
    }
    const lat = legMs(ctx, d) + connExtra;
    ctx.schedule(lat, "admit", { call: child.id, req: c.rootId, from: c.station, to: d.to, lat });
    if (d.timeoutMs !== undefined && d.timeoutMs > 0) {
      ctx.schedule(d.timeoutMs, "timeout", { call: c.id, token: tok });
    }
  };

  // Issue a dependency call through its circuit breaker. A CLOSED breaker (or the
  // half-open probe) lets a real child go out; an OPEN one fast-fails without
  // touching the dependency, the mechanism that stops a retry storm.
  // The fast-fail is a 0-delay event so it never reenters mid-setup.
  const dispatchDep = (
    ctx: SimContext<NetworkState>,
    c: Call,
    depIdx: number,
    branch: Branch | null,
  ): void => {
    if (breakerAllows(ctx, c.station, depIdx)) {
      issueChild(ctx, c, depIdx, branch);
      return;
    }
    if (branch) {
      ctx.schedule(0, "breakerFail", { call: c.id, dep: branch.dep, br: 1 });
    } else {
      c.token++; // invalidate any racing continuation; matched when the event fires
      ctx.schedule(0, "breakerFail", { call: c.id, token: c.token, br: 0 });
    }
  };

  // Load-balance: pick ONE healthy backend by the station's algorithm. Deterministic
  // (cursor/least-connections read state, random uses the seeded PRNG), so
  // golden-trace holds. Returns -1 if every backend is dead.
  const selectDep = (ctx: SimContext<NetworkState>, stationIdx: number): number => {
    const deps = scenario.stations[stationIdx].deps;
    const st = ctx.state.stations[stationIdx];
    const algo = scenario.stations[stationIdx].algorithm ?? "round-robin";
    const alive = (i: number) => !ctx.state.stations[deps[i].to].dead;

    if (algo === "random") {
      const healthy: number[] = [];
      for (let i = 0; i < deps.length; i++) if (alive(i)) healthy.push(i);
      if (healthy.length === 0) return -1;
      return healthy[Math.floor(ctx.prng.nextFloat() * healthy.length)];
    }
    if (algo === "least-connections") {
      let best = -1;
      let bestLoad = Infinity;
      for (let i = 0; i < deps.length; i++) {
        if (!alive(i)) continue;
        const ts = ctx.state.stations[deps[i].to];
        const load = ts.busy + ts.waiting.length;
        if (load < bestLoad) {
          bestLoad = load;
          best = i;
        }
      }
      return best;
    }
    // round-robin: advance the cursor to the next healthy backend
    for (let k = 1; k <= deps.length; k++) {
      const i = (st.rrCursor + k) % deps.length;
      if (alive(i)) {
        st.rrCursor = i;
        return i;
      }
    }
    return -1;
  };

  // Issue the call's next dependency (spawning a child + a timeout), or do the
  // station's own service and finish.
  const processNext = (ctx: SimContext<NetworkState>, c: Call): void => {
    const spec = scenario.stations[c.station];

    // Load balancer / replica set: call exactly ONE chosen backend.
    if (spec.routing === "one" && spec.deps.length > 0) {
      if (c.depIndex === 0) {
        const pick = selectDep(ctx, c.station);
        if (pick < 0) {
          releaseServer(ctx, c); // every backend is down: the call fails
          returnToParent(ctx, c, false);
          return;
        }
        c.chosen = pick;
        dispatchDep(ctx, c, pick, null);
      } else {
        scheduleOwnService(ctx, c); // the one downstream call is done: finish
      }
      return;
    }

    // Writes bypass caches: skip any leading short-circuit deps.
    while (c.write && c.depIndex < spec.deps.length && spec.deps[c.depIndex].shortCircuit) {
      c.depIndex++;
    }

    // Once the leading caches are resolved, a parallel station sends its remaining
    // independent deps out concurrently and joins: latency becomes the slowest
    // branch, not the sum. Each branch retries/times out on its own.
    if (spec.parallel && c.branches === null) {
      const rest = spec.deps.slice(c.depIndex);
      if (rest.length >= 2 && !rest.some((d) => d.shortCircuit)) {
        c.branches = [];
        c.outstanding = rest.length;
        for (let i = c.depIndex; i < spec.deps.length; i++) {
          const b: Branch = { dep: i, attempt: 0, token: 0, childId: null, done: false, connDep: -1 };
          c.branches.push(b);
          dispatchDep(ctx, c, i, b);
        }
        return;
      }
    }

    if (c.depIndex < spec.deps.length) {
      dispatchDep(ctx, c, c.depIndex, null);
    } else {
      scheduleOwnService(ctx, c);
    }
  };

  // Seat a call in a server slot and start it. `pool`: 0 primary (writes), 1 replica
  // (reads), -1 unpooled station. A replica read starting within lagMs of the last
  // write commit returns stale data, counted.
  const seat = (ctx: SimContext<NetworkState>, c: Call, pool: number): void => {
    const st = ctx.state.stations[c.station];
    st.busy++;
    c.pool = pool;
    if (c.shard >= 0) st.shardBusy[c.shard]++; // sharded: also hold the cell's slot
    if (pool === 0) st.busyPrimary++;
    else if (pool === 1) {
      st.busyReplica++;
      st.replicaReads++;
      if (ctx.now - st.lastWriteAt < scenario.stations[c.station].replication!.lagMs) st.staleReads++;
    }
    c.tService = ctx.now;
    // A quorum replica sub-call does exactly one node's own service (no deps); every
    // other call runs its normal dependency chain.
    if (c.quorumParent >= 0) scheduleOwnService(ctx, c);
    else processNext(ctx, c);
  };

  // Spawn one consumer draining `group` (-1 = the single shared backlog). It takes a
  // consumer slot and processes one message by calling the broker's deps, then its
  // own consume time (the group's rate when grouped).
  const spawnConsumer = (ctx: SimContext<NetworkState>, station: number, group: number): void => {
    const id = ctx.state.nextId++;
    const cc: Call = {
      id, rootId: id, station, parent: null, isRoot: false, parentToken: 0,
      start: ctx.now, depIndex: 0, attempt: 0, token: 0, childId: null,
      write: false, chosen: -1, pool: -1, branches: null, outstanding: 0,
      viaDep: -1, tAdmit: ctx.now, tService: -1, depth: 0, attemptNo: 0,
      timedOut: false, consumer: true, group, shard: -1,
      quorumParent: -1, qTarget: 0, qFan: 0, qDone: 0, qFailed: 0, qReturned: false,
      connDep: -1,
    };
    ctx.state.calls.set(id, cc);
    seat(ctx, cc, -1); // takes a consumer slot and starts processing
  };

  // Drain a broker's backlog: seat consumers until the pool is full or the backlog
  // is empty. A pub/sub broker drains each subscriber group from its OWN backlog
  // with its own consumer pool, so a slow group's lag never touches a fast one.
  const startConsume = (ctx: SimContext<NetworkState>, station: number): void => {
    const st = ctx.state.stations[station];
    if (st.dead) return;
    const groups = scenario.stations[station].broker?.groups;
    if (groups) {
      for (let g = 0; g < groups.length; g++) {
        const gr = st.groups[g];
        while (gr.busy < groups[g].consumers && gr.backlog > 0) {
          gr.backlog--;
          gr.busy++;
          spawnConsumer(ctx, station, g);
        }
      }
      return;
    }
    while (st.busy < st.servers && st.backlog > 0) {
      st.backlog--;
      spawnConsumer(ctx, station, -1);
    }
  };

  // A consumer finished (or failed) one message: free its slot, count it, and pull
  // the next message off the backlog.
  const finishConsumer = (ctx: SimContext<NetworkState>, cc: Call, ok: boolean): void => {
    const st = ctx.state.stations[cc.station];
    integrate(st, ctx.now);
    st.busy--;
    st.departures++;
    if (cc.group >= 0) {
      st.groups[cc.group].busy--;
      if (ok) st.groups[cc.group].consumed++;
    } else if (ok) st.consumed++;
    recordSpan(ctx, cc, ok);
    ctx.state.calls.delete(cc.id);
    startConsume(ctx, cc.station);
  };

  // Probability a read of R replicas misses the W most-recently-written ones, under
  // random quorum selection: C(RF−W, R)/C(RF, R), which is 0 exactly when W+R > RF
  // (the strong-consistency guarantee) and rises as the quorum weakens.
  const choose = (n: number, k: number): number => {
    if (k < 0 || k > n) return 0;
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return r;
  };
  const staleProb = (q: NonNullable<Scenario["stations"][number]["quorum"]>): number => {
    const denom = choose(q.replicationFactor, q.readQuorum);
    if (denom <= 0) return 0;
    return choose(q.replicationFactor - q.writeQuorum, q.readQuorum) / denom;
  };

  // Spawn one replica sub-call of a quorum coordinator onto node `cell`. Seats it in
  // that node's slot or queues it (reusing the shard cells); returns false if the
  // node's queue is full (an immediate replica failure). Dead nodes are handled by
  // the caller before this.
  const spawnReplicaCall = (ctx: SimContext<NetworkState>, parent: Call, cell: number): boolean => {
    const st = ctx.state.stations[parent.station];
    const q = scenario.stations[parent.station].quorum!;
    const id = ctx.state.nextId++;
    const rc: Call = {
      id, rootId: parent.rootId, station: parent.station, parent: parent.id, isRoot: false,
      parentToken: 0, start: ctx.now, depIndex: 0, attempt: 0, token: 0, childId: null,
      write: parent.write, chosen: -1, pool: -1, branches: null, outstanding: 0, viaDep: -1,
      tAdmit: ctx.now, tService: -1, depth: parent.depth + 1, attemptNo: 0, timedOut: false,
      consumer: false, group: -1, shard: cell, quorumParent: parent.id,
      qTarget: 0, qFan: 0, qDone: 0, qFailed: 0, qReturned: false, connDep: -1,
    };
    if (st.shardBusy[cell] < q.serversPerNode) {
      ctx.state.calls.set(id, rc);
      seat(ctx, rc, -1); // seats in the cell and schedules its node service
      return true;
    }
    if (st.shardWaiting[cell].length < q.queuePerNode) {
      ctx.state.calls.set(id, rc);
      st.shardWaiting[cell].push(id);
      return true;
    }
    return false; // this node's queue overflowed: a replica failure
  };

  // A quorum coordinator's decision after each replica settles: return SUCCESS once
  // qTarget acks arrive, or FAILURE once too many replicas fail to ever reach it.
  // Only the first of the two fires (qReturned guards it); the remaining replicas
  // keep running and just free their cells (the eventual-consistency load).
  const evalQuorum = (ctx: SimContext<NetworkState>, p: Call): void => {
    if (p.qReturned) return;
    // The coordinator holds no station slot itself (its replica sub-calls hold the
    // cells), so it just returns to its caller, no releaseServer.
    if (p.qDone >= p.qTarget) {
      p.qReturned = true;
      returnToParent(ctx, p, true);
    } else if (p.qFan - p.qFailed < p.qTarget) {
      p.qReturned = true;
      returnToParent(ctx, p, false);
    }
  };

  const admitCall = (ctx: SimContext<NetworkState>, c: Call): void => {
    const st = ctx.state.stations[c.station];
    const spec = scenario.stations[c.station];
    integrate(st, ctx.now);
    st.arrivals++;
    c.tAdmit = ctx.now; // arrived at the station (span: network-in is done)
    if (st.dead || st.partitioned) {
      st.rejected++; // dead node, or a partition the call can't cross: it fails
      returnToParent(ctx, c, false); // never took a server
      return;
    }
    // Produce to a broker: enqueue the message and ack the producer at once,
    // decoupling its latency from the consumer's. A full buffer rejects the produce.
    const bk = spec.broker;
    if (bk) {
      // Pub/sub: the message fans into EVERY subscriber group's backlog. A group
      // whose buffer is full drops its own copy (its lag is bounded), but the
      // producer is still acked as long as at least one group took it.
      if (bk.groups) {
        let accepted = false;
        for (let g = 0; g < bk.groups.length; g++) {
          const cap = bk.groups[g].maxBacklog;
          if (cap !== undefined && st.groups[g].backlog >= cap) continue;
          st.groups[g].backlog++;
          accepted = true;
        }
        if (accepted) {
          st.admitted++;
          st.produced++;
          returnToParent(ctx, c, true);
        } else {
          st.rejected++;
          returnToParent(ctx, c, false); // every group's buffer is full
        }
        startConsume(ctx, c.station);
        return;
      }
      if (bk.maxBacklog !== undefined && st.backlog >= bk.maxBacklog) {
        st.rejected++;
        returnToParent(ctx, c, false);
        return;
      }
      st.admitted++;
      st.backlog++;
      st.produced++;
      returnToParent(ctx, c, true); // fast ack, independent of consume speed
      startConsume(ctx, c.station); // wake a free consumer if any
      return;
    }
    // Sharded store: route to one cell by a seeded hash of the request id; each
    // cell has its own servers + queue, so load spreads and a dead cell isolates.
    const sh = spec.shards;
    if (sh) {
      const cell = hashShard(c.rootId, sh.count);
      c.shard = cell;
      st.shardArrivals[cell]++;
      if (st.shardDead[cell]) {
        st.rejected++; // this cell is down: only its key slice fails
        returnToParent(ctx, c, false);
      } else if (st.shardBusy[cell] < sh.serversPerShard) {
        st.admitted++;
        seat(ctx, c, -1);
      } else if (st.shardWaiting[cell].length < sh.queuePerShard) {
        st.admitted++;
        st.shardWaiting[cell].push(c.id);
      } else {
        st.rejected++; // this cell's queue overflowed
        returnToParent(ctx, c, false);
      }
      return;
    }
    // Masterless quorum: fan the op to its replica set of peer nodes and return on
    // the quorum-th ack. A write hits all RF replicas (return on W); a read queries
    // R live replicas (return on R). Write load spreads over the nodes, so capacity
    // scales with node count, and a weak quorum reads stale with the overlap prob.
    const q = spec.quorum;
    if (q) {
      const base = hashShard(c.rootId, q.nodes);
      const replicaSet: number[] = [];
      for (let k = 0; k < q.replicationFactor; k++) replicaSet.push((base + k) % q.nodes);
      c.tService = ctx.now; // the op's duration is the replica fan-out, not queue wait
      if (c.write) {
        c.qTarget = q.writeQuorum;
        c.qFan = q.replicationFactor;
        st.admitted++;
        for (const cell of replicaSet) {
          if (st.shardDead[cell] || !spawnReplicaCall(ctx, c, cell)) c.qFailed++;
        }
        evalQuorum(ctx, c); // may already be doomed if too many replicas failed to seat
      } else {
        const alive = replicaSet.filter((cell) => !st.shardDead[cell]);
        if (alive.length < q.readQuorum) {
          st.rejected++;
          returnToParent(ctx, c, false); // not enough live replicas to reach R
          return;
        }
        st.replicaReads++;
        if (bernoulli(ctx, staleProb(q))) st.staleReads++; // weak quorum: stale read
        c.qTarget = q.readQuorum;
        c.qFan = q.readQuorum;
        st.admitted++;
        for (let i = 0; i < q.readQuorum; i++) {
          if (!spawnReplicaCall(ctx, c, alive[i])) c.qFailed++;
        }
        evalQuorum(ctx, c);
      }
      return;
    }
    // Class-split admission: separate endpoints, separate pools. Writes never
    // borrow replica capacity, reads never borrow primary.
    const r = spec.replication;
    if (r) {
      const free = c.write ? st.busyPrimary < r.primaryServers : st.busyReplica < r.replicaServers;
      if (free) {
        st.admitted++;
        seat(ctx, c, c.write ? 0 : 1);
      } else if (st.waiting.length < spec.queueCapacity) {
        st.admitted++;
        st.waiting.push(c.id);
      } else {
        st.rejected++;
        returnToParent(ctx, c, false);
      }
      return;
    }
    if (st.busy < st.servers) {
      st.admitted++;
      seat(ctx, c, -1); // got a server immediately (no queue wait)
    } else if (st.waiting.length < spec.queueCapacity) {
      st.admitted++;
      st.waiting.push(c.id);
    } else {
      st.rejected++; // bounded-queue overflow is defined behavior, not a crash
      returnToParent(ctx, c, false);
    }
  };

  // Start service for queued calls while capacity allows. The capacity check
  // matters under autoscaling: after a scale-down, busy can exceed servers and
  // the surplus must drain (no new dispatch) until it fits again.
  const dispatchWaiting = (ctx: SimContext<NetworkState>, station: number): void => {
    const st = ctx.state.stations[station];
    while (st.busy < st.servers && st.waiting.length > 0) {
      const next = ctx.state.calls.get(st.waiting.shift()!);
      if (!next) continue;
      seat(ctx, next, -1); // dequeued: service starts (queue wait ends)
    }
  };

  // A freed pool slot goes to the first waiting call of ITS class: writes wait on
  // the primary, reads on the replicas, in FIFO order.
  const dispatchPool = (ctx: SimContext<NetworkState>, station: number, pool: number): void => {
    const st = ctx.state.stations[station];
    const r = scenario.stations[station].replication!;
    if (pool === 0 ? st.busyPrimary >= r.primaryServers : st.busyReplica >= r.replicaServers) return;
    const wantWrite = pool === 0;
    for (let k = 0; k < st.waiting.length; k++) {
      const q = ctx.state.calls.get(st.waiting[k]);
      if (!q) {
        st.waiting.splice(k, 1);
        k--;
        continue;
      }
      if (q.write === wantWrite) {
        st.waiting.splice(k, 1);
        seat(ctx, q, pool);
        return;
      }
    }
  };

  // Per-cell server count for a partitioned station (shard fan-out or quorum peers).
  const cellServers = (station: number): number => {
    const spec = scenario.stations[station];
    return spec.shards?.serversPerShard ?? spec.quorum?.serversPerNode ?? 0;
  };

  // Start service for a cell's queued calls while the cell has a free slot.
  const dispatchShard = (ctx: SimContext<NetworkState>, station: number, shard: number): void => {
    const st = ctx.state.stations[station];
    const perShard = cellServers(station);
    while (st.shardBusy[shard] < perShard && st.shardWaiting[shard].length > 0) {
      const next = ctx.state.calls.get(st.shardWaiting[shard].shift()!);
      if (!next) continue;
      seat(ctx, next, -1); // dequeued: this cell's service starts
    }
  };

  const releaseServer = (ctx: SimContext<NetworkState>, c: Call): void => {
    const st = ctx.state.stations[c.station];
    integrate(st, ctx.now);
    st.busy--;
    if (c.shard >= 0) {
      st.shardBusy[c.shard]--;
      dispatchShard(ctx, c.station, c.shard);
    } else if (c.pool === 0) {
      st.busyPrimary--;
      dispatchPool(ctx, c.station, 0);
    } else if (c.pool === 1) {
      st.busyReplica--;
      dispatchPool(ctx, c.station, 1);
    } else {
      dispatchWaiting(ctx, c.station);
    }
  };

  // A call leaves its station, sending its result back up the return-latency link
  // to its parent, or, if it is the root, completing the request.
  const returnToParent = (ctx: SimContext<NetworkState>, c: Call, ok: boolean): void => {
    const s = ctx.state;
    recordSpan(ctx, c, ok); // every concluded call becomes one span
    s.calls.delete(c.id);
    if (c.isRoot) {
      if (ok) {
        const lat = ctx.now - c.start;
        s.completions++;
        s.sumLatency += lat;
        if (lat > s.maxLatency) s.maxLatency = lat;
        if (s.latencies.length < LATENCY_BUDGET) s.latencies.push([ctx.now, lat]);
      } else {
        s.failures++;
      }
      return;
    }
    if (c.parent === null) return; // orphaned by a timeout: result discarded
    const p = s.calls.get(c.parent);
    if (!p) return;
    const lat = legMs(ctx, scenario.stations[p.station].deps[c.viaDep]);
    ctx.schedule(lat, "result", { parent: p.id, token: c.parentToken, ok: ok ? 1 : 0, req: c.rootId, from: c.station, to: p.station, lat });
  };

  // One parallel branch concluded. ok joins the countdown; a failure retries THAT
  // branch (per-branch amplification); out of retries fails the whole call and
  // every other in-flight branch is orphaned.
  const handleBranchOutcome = (ctx: SimContext<NetworkState>, p: Call, b: Branch, ok: boolean, fastFail = false): void => {
    const dep = scenario.stations[p.station].deps[b.dep];
    if (!fastFail) breakerRecord(ctx, p.station, b.dep, ok); // real probe results only
    if (b.connDep >= 0) {
      checkinConn(ctx, p.station, b.connDep); // return this branch's connection
      b.connDep = -1;
    }
    b.childId = null;
    if (ok) {
      b.done = true;
      p.outstanding--;
      if (p.outstanding === 0) scheduleOwnService(ctx, p);
    } else if (b.attempt < (dep.retries ?? 0)) {
      b.attempt++;
      const wait = backoffDelay(ctx, dep, b.attempt); // back off before re-issuing
      if (wait > 0) ctx.schedule(wait, "retryBranch", { call: p.id, dep: b.dep });
      else dispatchDep(ctx, p, b.dep, b);
    } else {
      b.done = true;
      for (const o of p.branches!) {
        if (o.done || o.childId === null) continue;
        const child = ctx.state.calls.get(o.childId);
        if (child) child.parent = null; // orphan the still-running branches
        o.done = true;
      }
      releaseServer(ctx, p);
      returnToParent(ctx, p, false);
    }
  };

  // Apply the outcome of `p`'s in-flight dependency call.
  const handleResult = (ctx: SimContext<NetworkState>, p: Call, ok: boolean, fastFail = false): void => {
    p.token++; // consume: invalidate the racing timeout/result
    p.childId = null;
    if (p.connDep >= 0) {
      checkinConn(ctx, p.station, p.connDep); // the call is done: return its connection
      p.connDep = -1;
    }
    const dep = currentDep(p);
    if (!fastFail) breakerRecord(ctx, p.station, curDepIdx(p), ok); // real results only
    if (ok) {
      if (dep.shortCircuit) {
        // Cache returned (reads only reach here, writes skip caches). Roll hit vs
        // miss with prob h: a hit ends handling, a miss falls through.
        if (bernoulli(ctx, dep.hitRatio ?? 1)) {
          ctx.state.stations[dep.to].hits++;
          scheduleOwnService(ctx, p);
        } else {
          ctx.state.stations[dep.to].misses++;
          p.depIndex++;
          p.attempt = 0;
          processNext(ctx, p);
        }
      } else {
        p.depIndex++;
        p.attempt = 0;
        processNext(ctx, p);
      }
    } else if (p.attempt < (dep.retries ?? 0)) {
      p.attempt++; // retry: new child call (amplifies load on the dependency)
      const wait = backoffDelay(ctx, dep, p.attempt); // back off first
      if (wait > 0) {
        p.token++;
        ctx.schedule(wait, "retry", { call: p.id, token: p.token });
      } else {
        processNext(ctx, p);
      }
    } else if (dep.shortCircuit) {
      ctx.state.stations[dep.to].misses++; // dead cache is a forced miss (h→0 limit)
      p.depIndex++; // fall through to the next dep (non-fatal)
      p.attempt = 0;
      processNext(ctx, p);
    } else if (p.consumer) {
      finishConsumer(ctx, p, false); // a consumer's required dep failed: drop the message
    } else {
      releaseServer(ctx, p); // required dep failed: the station fails
      returnToParent(ctx, p, false);
    }
  };

  const handler: EventHandler<NetworkState> = (ctx, event) => {
    const s = ctx.state;
    switch (event.kind) {
      case "arrival": {
        const gen = num(event, "gen");
        const a = scenario.arrivals[gen];
        if (a.shape) {
          // Thinning: candidates at the peak rate, accepted at λ(t)/λmax.
          ctx.schedule(ctx.prng.exponential(a.ratePerMs * shapePeak(a.shape)), "arrival", { gen });
          if (ctx.prng.nextFloat() >= shapeRatio(a.shape, ctx.now)) break;
        } else {
          ctx.schedule(ctx.prng.exponential(a.ratePerMs), "arrival", { gen });
        }
        const id = s.nextId++;
        const root: Call = {
          id,
          rootId: id,
          station: a.station,
          parent: null,
          isRoot: true,
          parentToken: 0,
          start: ctx.now,
          depIndex: 0,
          attempt: 0,
          token: 0,
          childId: null,
          write: bernoulli(ctx, a.writeRatio ?? 0),
          chosen: -1,
          pool: -1,
          branches: null,
          outstanding: 0,
          viaDep: -1,
          tAdmit: -1,
          tService: -1,
          depth: 0,
          attemptNo: 0,
          timedOut: false,
          consumer: false,
          group: -1,
          shard: -1,
          quorumParent: -1,
          qTarget: 0,
          qFan: 0,
          qDone: 0,
          qFailed: 0,
          qReturned: false,
          connDep: -1,
        };
        s.calls.set(id, root);
        admitCall(ctx, root);
        break;
      }
      case "admit": {
        const c = s.calls.get(num(event, "call"));
        if (c) admitCall(ctx, c);
        break;
      }
      case "serviceEnd": {
        const c = s.calls.get(num(event, "call"));
        if (!c) break;
        if (c.consumer) {
          finishConsumer(ctx, c, true); // a broker consumer drained one message
          break;
        }
        // A quorum replica sub-call finished one node's work: free the cell and give
        // its coordinator one ack (the coordinator may have already returned).
        if (c.quorumParent >= 0) {
          releaseServer(ctx, c); // frees the node cell + dispatches its queue
          s.stations[c.station].departures++;
          const p = s.calls.get(c.quorumParent);
          s.calls.delete(c.id);
          if (p) {
            p.qDone++;
            evalQuorum(ctx, p);
          }
          break;
        }
        // A finished write is the commit replicas trail behind.
        if (c.write && scenario.stations[c.station].replication) {
          s.stations[c.station].lastWriteAt = ctx.now;
        }
        releaseServer(ctx, c);
        s.stations[c.station].departures++;
        returnToParent(ctx, c, true);
        break;
      }
      case "result": {
        const p = s.calls.get(num(event, "parent"));
        if (!p) break;
        const tok = num(event, "token");
        if (p.branches !== null) {
          const b = p.branches.find((x) => x.token === tok && !x.done);
          if (b) handleBranchOutcome(ctx, p, b, num(event, "ok") === 1);
          break;
        }
        if (tok !== p.token) break; // stale
        handleResult(ctx, p, num(event, "ok") === 1);
        break;
      }
      case "timeout": {
        const c = s.calls.get(num(event, "call"));
        if (!c) break;
        const tok = num(event, "token");
        if (c.branches !== null) {
          const b = c.branches.find((x) => x.token === tok && !x.done);
          if (!b) break; // that branch already concluded
          if (b.childId !== null) {
            const child = s.calls.get(b.childId);
            if (child) {
              child.parent = null; // orphan the slow branch (keeps running)
              child.timedOut = true;
            }
          }
          handleBranchOutcome(ctx, c, b, false);
          break;
        }
        if (tok !== c.token) break; // already returned
        if (c.childId !== null) {
          const child = s.calls.get(c.childId);
          if (child) {
            child.parent = null; // orphan the slow child (keeps running)
            child.timedOut = true; // mark it timed-out for the waterfall
          }
        }
        handleResult(ctx, c, false);
        break;
      }
      // A backed-off retry fires: re-issue the current dependency now.
      case "retry": {
        const c = s.calls.get(num(event, "call"));
        if (!c || num(event, "token") !== c.token) break; // superseded / gone
        processNext(ctx, c);
        break;
      }
      case "retryBranch": {
        const c = s.calls.get(num(event, "call"));
        if (!c || c.branches === null) break;
        const depIdx = num(event, "dep");
        const b = c.branches.find((x) => x.dep === depIdx && !x.done);
        if (b) dispatchDep(ctx, c, depIdx, b);
        break;
      }
      // An OPEN circuit breaker fast-failed a call: apply the failure through the
      // normal outcome path, flagged so it doesn't feed the breaker a fake result.
      case "breakerFail": {
        const c = s.calls.get(num(event, "call"));
        if (!c) break;
        if (num(event, "br") === 1) {
          if (c.branches === null) break;
          const depIdx = num(event, "dep");
          const b = c.branches.find((x) => x.dep === depIdx && !x.done);
          if (b) handleBranchOutcome(ctx, c, b, false, true);
        } else {
          if (num(event, "token") !== c.token) break;
          handleResult(ctx, c, false, true);
        }
        break;
      }
      case "intervene": {
        const iv = scenario.interventions[num(event, "idx")];
        const st = s.stations[iv.station];
        integrate(st, ctx.now);
        // Shard-targeted kill/restart: down (or heal) only one cell of a sharded
        // store, leaving the others serving. Only kill/restart are shard-scoped.
        if (iv.shard !== undefined && st.shardDead.length > iv.shard) {
          if (iv.kind === "kill") st.shardDead[iv.shard] = true;
          else if (iv.kind === "restart") st.shardDead[iv.shard] = false;
          break;
        }
        if (iv.kind === "kill") st.dead = true;
        else if (iv.kind === "partition") st.partitioned = true; // network cut, node stays alive
        else if (iv.kind === "restart") {
          st.dead = false;
          st.partitioned = false; // heal both a crash and a partition
          if (scenario.stations[iv.station].broker) startConsume(ctx, iv.station); // resume draining
        } else if (iv.kind === "delay") st.extraDelayMs = iv.param ?? 0;
        break;
      }
      // Autoscaling control loop, one evaluation tick. Measure the metric over the
      // window since the last tick, apply the HPA formula
      // desired = ceil(current × metric/target) inside a tolerance band, scale up
      // after a provision delay, scale down only past the stabilization window.
      case "scaleTick": {
        const i = num(event, "st");
        const cfg = scenario.stations[i].scaling!;
        const st = s.stations[i];
        integrate(st, ctx.now);
        ctx.schedule(cfg.evalIntervalMs, "scaleTick", { st: i });
        const dBusy = st.areaBusy - st.scaleAreaBusy;
        const dCap = st.areaCap - st.scaleAreaCap;
        const dArr = st.arrivals - st.scaleArrivals;
        st.scaleAreaBusy = st.areaBusy;
        st.scaleAreaCap = st.areaCap;
        st.scaleArrivals = st.arrivals;
        if (st.dead) {
          st.recentDesired = []; // no metrics from a dead tier
          st.scaleHold = true; // and the window a restart lands in is garbage too
          break;
        }
        if (st.scaleHold) {
          st.scaleHold = false; // baselines just reset: decide on a clean window
          break;
        }
        // metric/target ratio: ρ/targetρ, or measured per-instance rate / target rate
        const ratio =
          cfg.metric === "rate"
            ? (dArr / cfg.evalIntervalMs) * 1000 / (st.instances * cfg.target)
            : dCap > 0
              ? dBusy / dCap / cfg.target
              : 0;
        const eff = st.instances + st.pending; // capacity already ordered counts
        const desired = Math.max(
          cfg.minInstances,
          Math.min(
            cfg.maxInstances,
            Math.abs(ratio - 1) <= SCALE_TOLERANCE ? eff : Math.ceil(st.instances * ratio),
          ),
        );
        st.recentDesired.push([ctx.now, desired]);
        while (st.recentDesired[0][0] < ctx.now - cfg.stabilizationMs) st.recentDesired.shift();
        if (desired > eff) {
          const add = desired - eff;
          st.pending += add;
          ctx.schedule(cfg.provisionMs, "scaleUp", { st: i, add });
        } else {
          // never scale below any desired count seen inside the stabilization window
          let floor = desired;
          for (const [, d] of st.recentDesired) if (d > floor) floor = d;
          if (floor < st.instances) {
            st.instances = floor;
            st.servers = st.instances * cfg.perInstanceServers;
          }
        }
        break;
      }
      case "scaleUp": {
        const i = num(event, "st");
        const cfg = scenario.stations[i].scaling!;
        const st = s.stations[i];
        integrate(st, ctx.now);
        st.pending -= num(event, "add");
        st.instances = Math.min(cfg.maxInstances, st.instances + num(event, "add"));
        st.servers = st.instances * cfg.perInstanceServers;
        dispatchWaiting(ctx, i); // fresh capacity starts draining the queue now
        break;
      }
      default:
        throw new Error(`unknown event kind: ${event.kind}`);
    }
  };

  const init = (ctx: SimContext<NetworkState>): void => {
    scenario.arrivals.forEach((a, gen) => {
      const envelope = a.shape ? shapePeak(a.shape) : 1;
      ctx.schedule(ctx.prng.exponential(a.ratePerMs * envelope), "arrival", { gen });
    });
    scenario.interventions.forEach((iv, idx) => ctx.schedule(iv.atMs, "intervene", { idx }));
    // Ticks exist only for scaled stations, so unscaled runs stay byte-identical.
    scenario.stations.forEach((spec, i) => {
      if (spec.scaling) ctx.schedule(spec.scaling.evalIntervalMs, "scaleTick", { st: i });
    });
  };

  return { state: makeInitialState(scenario), handler, init };
}

// ---- Metrics (read without mutating, so sampling never perturbs the run) ----

export interface NetworkCounters {
  time: number;
  completions: number;
  failures: number;
  sumLatency: number;
  sumNet: number; // cumulative breakdown totals (see NetworkState), diffed per window
  netCalls: number;
  sumQueue: number;
  sumService: number;
  concludedCalls: number;
  stations: { areaBusy: number; areaWait: number; areaCap: number; arrivals: number; rejected: number; busy: number; queue: number; hits: number; misses: number; instances: number; replicaReads: number; staleReads: number; areaBacklog: number; backlog: number; produced: number; consumed: number; handshakes: number; groups: { backlog: number; areaBacklog: number; consumed: number }[] }[];
}

export function readNetworkCounters(state: NetworkState, now: number): NetworkCounters {
  return {
    time: now,
    completions: state.completions,
    failures: state.failures,
    sumLatency: state.sumLatency,
    sumNet: state.sumNet,
    netCalls: state.netCalls,
    sumQueue: state.sumQueue,
    sumService: state.sumService,
    concludedCalls: state.concludedCalls,
    stations: state.stations.map((st) => {
      const tail = now - st.lastT > 0 ? now - st.lastT : 0;
      // A pub/sub broker's lag lives per-group; fold the groups' aggregates into the
      // surfaced backlog/consumed so the node's readouts (and metrics) show total lag.
      const grouped = st.groups.length > 0;
      const groups = st.groups.map((g) => ({
        backlog: g.backlog,
        areaBacklog: g.areaBacklog + g.backlog * tail,
        consumed: g.consumed,
      }));
      return {
        areaBusy: st.areaBusy + st.busy * tail,
        areaWait: st.areaWait + st.waiting.length * tail,
        areaCap: st.areaCap + st.servers * tail,
        arrivals: st.arrivals,
        rejected: st.rejected,
        busy: st.busy,
        queue: st.waiting.length,
        hits: st.hits,
        misses: st.misses,
        instances: st.instances,
        replicaReads: st.replicaReads,
        staleReads: st.staleReads,
        areaBacklog: grouped
          ? groups.reduce((a, g) => a + g.areaBacklog, 0)
          : st.areaBacklog + st.backlog * tail,
        backlog: grouped ? groups.reduce((a, g) => a + g.backlog, 0) : st.backlog,
        produced: st.produced,
        consumed: grouped ? groups.reduce((a, g) => a + g.consumed, 0) : st.consumed,
        handshakes: st.handshakes,
        groups,
      };
    }),
  };
}

export interface StationMetric {
  id: string;
  utilization: number; // ρ, per-server busy fraction (≤ 1)
  queue: number; // mean queue depth over the window
  hitRate: number; // measured cache hit rate over the window (NaN if not a cache)
  calls: number; // calls received per second over the window (per-dependency load)
  instances: number; // live autoscaled instance count (NaN unless scaling)
  staleRate: number; // stale replica reads / replica reads (NaN unless replicated)
  backlog: number; // mean broker consumer lag over the window (NaN unless a broker)
  consumeRate: number; // messages consumed per second (NaN unless a broker)
  newConns: number; // new (cold) connections opened per second (NaN unless modeled)
}

export interface WindowMetrics {
  windowMs: number;
  throughput: number; // completed req/s
  failureRate: number; // failed req/s
  meanLatency: number; // ms (NaN if no completions in window)
  stations: StationMetric[];
  bottleneck: string | null; // station id with max ρ (the symptom)
  rootCause: string | null; // first-to-saturate tier (the origin); filled by the host
}

export function computeWindowMetrics(a: NetworkCounters, b: NetworkCounters, scenario: Scenario): WindowMetrics {
  const dt = b.time - a.time;
  const completed = b.completions - a.completions;
  const stations: StationMetric[] = scenario.stations.map((spec, i) => {
    const hits = b.stations[i].hits - a.stations[i].hits;
    const reads = hits + (b.stations[i].misses - a.stations[i].misses);
    // ρ against ∫capacity dt, so it stays honest while autoscaling moves c.
    const dCap = b.stations[i].areaCap - a.stations[i].areaCap;
    const rr = b.stations[i].replicaReads - a.stations[i].replicaReads;
    return {
      id: spec.id,
      utilization: dCap > 0 ? (b.stations[i].areaBusy - a.stations[i].areaBusy) / dCap : 0,
      queue: (b.stations[i].areaWait - a.stations[i].areaWait) / dt,
      hitRate: reads > 0 ? hits / reads : NaN,
      calls: ((b.stations[i].arrivals - a.stations[i].arrivals) / dt) * 1000,
      instances: spec.scaling ? b.stations[i].instances : NaN,
      staleRate: (spec.replication || spec.quorum) && rr > 0 ? (b.stations[i].staleReads - a.stations[i].staleReads) / rr : NaN,
      backlog: spec.broker ? (b.stations[i].areaBacklog - a.stations[i].areaBacklog) / dt : NaN,
      consumeRate: spec.broker ? ((b.stations[i].consumed - a.stations[i].consumed) / dt) * 1000 : NaN,
      newConns: spec.deps.some((d) => d.connection)
        ? ((b.stations[i].handshakes - a.stations[i].handshakes) / dt) * 1000
        : NaN,
    };
  });
  let bottleneck: string | null = null;
  let maxRho = -1;
  for (const st of stations) {
    if (st.utilization > maxRho) {
      maxRho = st.utilization;
      bottleneck = st.id;
    }
  }
  return {
    windowMs: dt,
    throughput: (completed / dt) * 1000,
    failureRate: ((b.failures - a.failures) / dt) * 1000,
    meanLatency: completed > 0 ? (b.sumLatency - a.sumLatency) / completed : NaN,
    stations,
    bottleneck,
    rootCause: null, // a cross-window diagnostic; the host fills it after the run
  };
}

// Saturation threshold for root-cause attribution: a tier at or above this ρ is
// "saturated" and a candidate origin.
export const SATURATION_RHO = 0.85;

// Root-cause bottleneck attribution over a window series (a cross-window diagnostic,
// so it can't live in the per-window diff). Max-ρ names the current worst tier, but
// under a cascade every tier saturates and that ties on the symptom. The origin is
// the tier that saturated FIRST and is still saturated; ties break by station order.
export function attributeRootCause(windows: WindowMetrics[]): void {
  const onset = new Map<string, number>(); // station id -> window it began saturating
  windows.forEach((w, wi) => {
    for (const st of w.stations) {
      if (st.utilization >= SATURATION_RHO) {
        if (!onset.has(st.id)) onset.set(st.id, wi);
      } else {
        onset.delete(st.id);
      }
    }
    let root: string | null = null;
    let earliest = Infinity;
    for (const [id, oi] of onset) {
      if (oi < earliest) {
        earliest = oi;
        root = id;
      }
    }
    w.rootCause = root;
  });
}
