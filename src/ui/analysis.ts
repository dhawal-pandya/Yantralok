// Pure, engine-free derivations over a run's span trace, for the canvas legibility
// layer: where the critical path runs, where latency piles up, and how hot each
// leg is. No React, no store, no wall-clock; deterministic given the same spans.
import type { TraceSpan } from "@/engine";

/** A directed leg key, matching a graph edge's source -> target orientation. */
export const legKey = (from: string, to: string) => `${from}->${to}`;

/** The request whose end-to-end life is longest (the one worth highlighting when
 * nothing is selected). Null if the trace is empty. */
export function slowestRequest(spans: TraceSpan[]): number | null {
  const span = new Map<number, { min: number; max: number }>();
  for (const s of spans) {
    const cur = span.get(s.req);
    const end = s.end + s.net;
    if (!cur) span.set(s.req, { min: s.issue, max: end });
    else {
      cur.min = Math.min(cur.min, s.issue);
      cur.max = Math.max(cur.max, end);
    }
  }
  let best: number | null = null;
  let bestDur = -1;
  for (const [req, { min, max }] of span) {
    if (max - min > bestDur) {
      bestDur = max - min;
      best = req;
    }
  }
  return best;
}

/** The critical path of one request: descend the call tree, at each level taking
 * the child that returned last (max `end + net`, the branch that gated the
 * parent's completion). For a chain that's the whole chain; for a parallel
 * fan-out it's the slowest branch. Returns the stations on the path and its legs
 * (source->target keys, matching graph edges). */
export function criticalPath(
  spans: TraceSpan[],
  req: number,
): { stations: Set<string>; legs: Set<string> } {
  const children = new Map<number, TraceSpan[]>();
  let root: TraceSpan | null = null;
  for (const s of spans) {
    if (s.req !== req) continue;
    if (s.parent === null) root ??= s;
    else {
      const arr = children.get(s.parent);
      if (arr) arr.push(s);
      else children.set(s.parent, [s]);
    }
  }

  const stations = new Set<string>();
  const legs = new Set<string>();
  let cur = root;
  if (cur) stations.add(cur.station);
  while (cur) {
    const kids = children.get(cur.call);
    if (!kids || kids.length === 0) break;
    let next = kids[0];
    for (const k of kids) if (k.end + k.net > next.end + next.net) next = k;
    legs.add(legKey(cur.station, next.station));
    stations.add(next.station);
    cur = next;
  }
  return { stations, legs };
}

/** Total time spent *at* each station across the run (queue wait + service, i.e.
 * `end - admit`), in ms. The "where does the time go" signal for the node lens. */
export function latencyContribution(spans: TraceSpan[]): Map<string, number> {
  const ms = new Map<string, number>();
  for (const s of spans) {
    const here = Math.max(0, s.end - s.admit);
    ms.set(s.station, (ms.get(s.station) ?? 0) + here);
  }
  return ms;
}

/** Mean round-trip latency carried on each leg (from a parent issuing a call to
 * the child returning, `end + net - issue`), in ms, keyed source->target. Colors
 * the wires: a leg into a slow subtree reads hot. */
export function edgeLatency(spans: TraceSpan[]): Map<string, number> {
  const byCall = new Map(spans.map((s) => [s.call, s]));
  const sum = new Map<string, number>();
  const count = new Map<string, number>();
  for (const s of spans) {
    if (s.parent === null) continue;
    const parent = byCall.get(s.parent);
    if (!parent) continue;
    const k = legKey(parent.station, s.station);
    sum.set(k, (sum.get(k) ?? 0) + (s.end + s.net - s.issue));
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const mean = new Map<string, number>();
  for (const [k, total] of sum) mean.set(k, total / (count.get(k) ?? 1));
  return mean;
}
