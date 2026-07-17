// M/M/c queue with finite concurrency and a bounded wait queue.
import type { EventHandler, SimContext, SimEvent } from "../simulation";

export interface QueueParams {
  arrivalRate: number; // λ
  serviceRate: number; // μ (per server)
  servers: number; // c
  queueCapacity: number; // max waiting; Infinity for unbounded
}

export interface QueueState {
  params: QueueParams;
  busy: number; // servers in use
  waiting: number[]; // FIFO of waiting requests' arrival times
  arrivals: number;
  admitted: number;
  rejected: number;
  departures: number;
  startedService: number;
  sumWait: number; // Σ time-in-queue over requests that started service
  sumSojourn: number; // Σ response time over departed requests
  lastEventTime: number;
  areaInSystem: number; // ∫ N dt
  areaBusy: number; // ∫ busy dt
}

export function initialQueueState(params: QueueParams): QueueState {
  return {
    params,
    busy: 0,
    waiting: [],
    arrivals: 0,
    admitted: 0,
    rejected: 0,
    departures: 0,
    startedService: 0,
    sumWait: 0,
    sumSojourn: 0,
    lastEventTime: 0,
    areaInSystem: 0,
    areaBusy: 0,
  };
}

/** Schedules the first arrival; use as the Simulation `init`. */
export function seedArrivals(ctx: SimContext<QueueState>): void {
  ctx.schedule(ctx.prng.exponential(ctx.state.params.arrivalRate), "arrival");
}

export const queueHandler: EventHandler<QueueState> = (ctx, event) => {
  const s = ctx.state;
  const p = s.params;

  const dt = ctx.now - s.lastEventTime;
  if (dt > 0) {
    s.areaInSystem += (s.busy + s.waiting.length) * dt;
    s.areaBusy += s.busy * dt;
    s.lastEventTime = ctx.now;
  }

  if (event.kind === "arrival") {
    s.arrivals++;
    ctx.schedule(ctx.prng.exponential(p.arrivalRate), "arrival");
    if (s.busy < p.servers) {
      s.admitted++;
      s.startedService++;
      s.busy++;
      startService(ctx, ctx.now);
    } else if (s.waiting.length < p.queueCapacity) {
      s.admitted++;
      s.waiting.push(ctx.now);
    } else {
      s.rejected++;
    }
  } else {
    const arrival = readArrival(event);
    s.sumSojourn += ctx.now - arrival;
    s.departures++;
    s.busy--;
    if (s.waiting.length > 0) {
      const queuedAt = s.waiting.shift()!;
      s.sumWait += ctx.now - queuedAt;
      s.startedService++;
      s.busy++;
      startService(ctx, queuedAt);
    }
  }
};

function startService(ctx: SimContext<QueueState>, arrival: number): void {
  ctx.schedule(ctx.prng.exponential(ctx.state.params.serviceRate), "departure", {
    arrival,
  });
}

function readArrival(event: SimEvent): number {
  const arrival = event.data?.arrival;
  if (arrival === undefined) throw new Error("departure event missing arrival");
  return arrival;
}

export interface QueueCounters {
  time: number;
  departures: number;
  startedService: number;
  sumWait: number;
  sumSojourn: number;
  areaInSystem: number;
  areaBusy: number;
  rejected: number;
}

/** Cumulative counters integrated up to `now` (for windowed measurement). */
export function readQueueCounters(s: QueueState, now: number): QueueCounters {
  const dt = now - s.lastEventTime;
  const inSystem = s.busy + s.waiting.length;
  return {
    time: now,
    departures: s.departures,
    startedService: s.startedService,
    sumWait: s.sumWait,
    sumSojourn: s.sumSojourn,
    areaInSystem: s.areaInSystem + (dt > 0 ? inSystem * dt : 0),
    areaBusy: s.areaBusy + (dt > 0 ? s.busy * dt : 0),
    rejected: s.rejected,
  };
}

export interface QueueMetrics {
  windowSeconds: number;
  throughput: number; // departures / s
  meanWait: number; // Wq
  meanSojourn: number; // W
  meanInSystem: number; // L
  utilization: number; // per-server busy fraction
}

/** Metrics over the window between two counter readings. */
export function computeQueueMetrics(
  a: QueueCounters,
  b: QueueCounters,
  servers: number,
): QueueMetrics {
  const dt = b.time - a.time;
  const departed = b.departures - a.departures;
  const started = b.startedService - a.startedService;
  return {
    windowSeconds: dt,
    throughput: departed / dt,
    meanWait: started > 0 ? (b.sumWait - a.sumWait) / started : NaN,
    meanSojourn: departed > 0 ? (b.sumSojourn - a.sumSojourn) / departed : NaN,
    meanInSystem: (b.areaInSystem - a.areaInSystem) / dt,
    utilization: (b.areaBusy - a.areaBusy) / (dt * servers),
  };
}
