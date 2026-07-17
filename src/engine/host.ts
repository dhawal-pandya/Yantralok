// The one interface the UI consumes. v1 runs on the main thread; a Web Worker impl
// can replace it behind this interface when the UI janks. A run SIMULATES TO A
// HORIZON and returns a compact result the UI plays back on a clock, which makes
// charts stream smoothly, packet animation data-driven, and rewind/seek/branch/
// compare nearly free, since every moment is reproducible from the scenario
// (graph + seed + interventions).
import { Simulation } from "./simulation";
import type { Scenario } from "./scenario";
import {
  attributeRootCause,
  computeWindowMetrics,
  createNetwork,
  readNetworkCounters,
  type NetworkCounters,
  type NetworkState,
  type WindowMetrics,
} from "./models/network";

/** One edge traversal, for the packet overlay. from/to are node ids. */
export interface Segment {
  req: number; // request id (groups a request's hops for the lifecycle inspector)
  start: number;
  end: number;
  from: string;
  to: string;
  request: boolean; // true = request (forward), false = response (return)
  error: boolean;
}

/** One call's span in the request trace: a station visit decomposed into
 * network-in / queue-wait / service / network-out. */
export interface TraceSpan {
  req: number; // root request id (groups the call tree)
  call: number;
  parent: number | null; // parent call id, for nesting the waterfall
  station: string; // node id
  depth: number;
  issue: number; // parent issued it (root: arrival)
  admit: number; // arrived at station (issue + network-in)
  service: number; // service started (admit + queue wait); -1 if never served
  end: number; // service/failure end (before network-out)
  net: number; // one-way link latency (each way); 0 for the root
  attempt: number; // 0 = first try, >0 = retry
  timedOut: boolean; // the caller gave up on this call
  error: boolean;
}

/** One sample window's latency distribution + where the time went, derived from
 * the raw per-completion samples and spans (not diffable from cumulative
 * counters, so these live alongside WindowMetrics rather than inside it). */
export interface LatencyWindow {
  p50: number; // ms (NaN if no completions concluded in this window)
  p95: number;
  p99: number;
  netMs: number; // mean round-trip network time across spans concluded in this window
  queueMs: number; // mean queue-wait time
  serviceMs: number; // mean service time
}

export interface RunResult {
  horizonMs: number;
  sampleIntervalMs: number;
  stationIds: string[];
  times: number[]; // sample boundary times
  windows: WindowMetrics[]; // one per sample window
  latencyWindows: LatencyWindow[]; // one per sample window, parallel to `windows`
  segments: Segment[]; // bounded set of edge traversals
  spans: TraceSpan[]; // bounded span-structured trace (the waterfall)
  totals: { completions: number; failures: number; meanLatency: number };
}

export interface RunOptions {
  horizonMs?: number;
  sampleIntervalMs?: number;
  maxSegments?: number;
}

export interface SimulationHost {
  run(scenario: Scenario, options?: RunOptions): RunResult;
}

const DEFAULTS = { horizonMs: 10_000, sampleIntervalMs: 100, maxSegments: 4000 };

// Nearest-rank percentile over an ascending-sorted sample. NaN on an empty
// window (no completions), matching WindowMetrics' NaN-for-no-data convention.
function quantile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

export class MainThreadHost implements SimulationHost {
  run(scenario: Scenario, options?: RunOptions): RunResult {
    const horizonMs = options?.horizonMs ?? DEFAULTS.horizonMs;
    const sampleIntervalMs = options?.sampleIntervalMs ?? DEFAULTS.sampleIntervalMs;
    const maxSegments = options?.maxSegments ?? DEFAULTS.maxSegments;

    const net = createNetwork(scenario);
    const sim = new Simulation<NetworkState>({
      handler: net.handler,
      initialState: net.state,
      seed: scenario.seed,
      init: net.init,
      recordTrace: true,
    });

    const times: number[] = [];
    const windows: WindowMetrics[] = [];
    const latencyWindows: LatencyWindow[] = [];
    let prev: NetworkCounters = readNetworkCounters(sim.state, 0);
    // Percentiles need the raw samples, so `latencies` is scanned with a forward
    // pointer (it's append-only in non-decreasing time order). The breakdown, by
    // contrast, is diffed from cumulative counters: unbounded, unlike the spans.
    let latIdx = 0;
    for (let t = sampleIntervalMs; t <= horizonMs; t += sampleIntervalMs) {
      sim.run(t);
      const cur = readNetworkCounters(sim.state, t);
      windows.push(computeWindowMetrics(prev, cur, scenario));

      const lats: number[] = [];
      while (latIdx < sim.state.latencies.length && sim.state.latencies[latIdx][0] <= t) {
        lats.push(sim.state.latencies[latIdx][1]);
        latIdx++;
      }
      lats.sort((x, y) => x - y);

      const calls = cur.concludedCalls - prev.concludedCalls;
      const netCalls = cur.netCalls - prev.netCalls;
      latencyWindows.push({
        p50: quantile(lats, 0.5),
        p95: quantile(lats, 0.95),
        p99: quantile(lats, 0.99),
        netMs: netCalls > 0 ? (cur.sumNet - prev.sumNet) / netCalls : NaN,
        queueMs: calls > 0 ? (cur.sumQueue - prev.sumQueue) / calls : NaN,
        serviceMs: calls > 0 ? (cur.sumService - prev.sumService) / calls : NaN,
      });

      times.push(t);
      prev = cur;
    }
    attributeRootCause(windows); // fill each window's first-to-saturate origin

    const idOf = (i: number): string => scenario.stations[i].id;
    // admit = a request hop (forward); result = a response hop (return).
    const hops = sim.trace.filter((e) => e.kind === "admit" || e.kind === "result");
    const stride = Math.max(1, Math.ceil(hops.length / maxSegments));
    const segments: Segment[] = [];
    for (let i = 0; i < hops.length; i += stride) {
      const e = hops[i];
      const d = e.data!;
      segments.push({
        req: d.req,
        start: e.time - d.lat,
        end: e.time,
        from: idOf(d.from),
        to: idOf(d.to),
        request: e.kind === "admit",
        error: e.kind === "result" && d.ok === 0,
      });
    }

    const spans: TraceSpan[] = sim.state.spans.map((sp) => ({
      req: sp.req,
      call: sp.call,
      parent: sp.parent,
      station: idOf(sp.station),
      depth: sp.depth,
      issue: sp.issue,
      admit: sp.admit,
      service: sp.service,
      end: sp.end,
      net: sp.net,
      attempt: sp.attempt,
      timedOut: sp.timedOut === 1,
      error: sp.error === 1,
    }));

    return {
      horizonMs,
      sampleIntervalMs,
      stationIds: scenario.stations.map((s) => s.id),
      times,
      windows,
      latencyWindows,
      segments,
      spans,
      totals: {
        completions: sim.state.completions,
        failures: sim.state.failures,
        meanLatency: sim.state.completions > 0 ? sim.state.sumLatency / sim.state.completions : NaN,
      },
    };
  }
}
