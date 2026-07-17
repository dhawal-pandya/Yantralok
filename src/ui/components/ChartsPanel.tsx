// Live charts: revealed up to the playback clock, streaming as it advances and
// reading straight off the engine run, no decorative animation. Grouped into
// scrollable sections (DESIGN observability), most load-bearing signals first,
// so adding more charts never means less room for the ones that matter most.
import type { ReactNode } from "react";
import { getComponent } from "@/components";
import type { LatencyWindow, RunResult, StationMetric, WindowMetrics } from "@/engine";
import { useSystemStore } from "@/ui/store/systemStore";
import { currentWindowIndex, useSimStore } from "@/ui/store/simStore";
import { Chart, type ChartSeries } from "./Chart";

const NET = "#64748b"; // network legs (matches the request waterfall)
const WAIT = "#f5b301"; // queue wait
const SERVICE = "#34d399"; // service (own work)

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">{title}</div>
      <div className="grid grid-cols-3 gap-px bg-neutral-800">{children}</div>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="h-40 min-h-0 bg-neutral-900 p-1">{children}</div>;
}

export function ChartsPanel() {
  const result = useSimStore((s) => s.result);
  const baseline = useSimStore((s) => s.baseline);
  const compare = useSimStore((s) => s.compare);
  const clockMs = useSimStore((s) => s.clockMs);
  const doc = useSystemStore((s) => s.doc);

  if (!result || result.windows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center border-t border-neutral-800 bg-neutral-900 text-xs text-neutral-600">
        Press <span className="mx-1 font-semibold text-signal">Simulate</span> to run the system and stream live metrics.
      </div>
    );
  }

  // A stable, full-horizon x-axis (so the view never rescales as it streams); the
  // lines are REVEALED up to the current clock by nulling later samples.
  const idx = currentWindowIndex(result, clockMs);
  const xs = result.times.map((t) => +(t / 1000).toFixed(2));
  const xRange: [number, number] = [0, +(result.horizonMs / 1000).toFixed(2)];
  const upTo = (v: number | null, i: number): number | null => (i <= idx ? v : null);

  const labelOf = (id: string) => {
    const node = doc?.graph.nodes.find((x) => x.id === id);
    return node ? (getComponent(node.type)?.label ?? id.slice(0, 6)) : id.slice(0, 6);
  };
  const accentOf = (id: string) => {
    const node = doc?.graph.nodes.find((x) => x.id === id);
    return (node && getComponent(node.type)?.accent) || "#a1a1aa";
  };

  const seriesOf = (r: RunResult, pick: (w: WindowMetrics) => number, decimals = 1): (number | null)[] =>
    r.windows.map((w, i) => upTo(Number.isFinite(pick(w)) ? +pick(w).toFixed(decimals) : null, i));

  const latSeriesOf = (pick: (l: LatencyWindow) => number, decimals = 1): (number | null)[] =>
    result.latencyWindows.map((l, i) => upTo(Number.isFinite(pick(l)) ? +pick(l).toFixed(decimals) : null, i));

  // Per-station line series, skipping any station that's never finite for this
  // metric (e.g. hit rate on a non-cache tier) so a chart only shows what applies.
  const perStation = (pick: (st: StationMetric) => number, scale = 1, decimals = 1, unit?: string): ChartSeries[] =>
    result.stationIds
      .map((_, k) => k)
      .filter((k) => result.windows.some((w) => Number.isFinite(pick(w.stations[k]))))
      .map((k) => ({
        label: labelOf(result.stationIds[k]),
        stroke: accentOf(result.stationIds[k]),
        unit,
        data: result.windows.map((w, i) =>
          upTo(Number.isFinite(pick(w.stations[k])) ? +(pick(w.stations[k]) * scale).toFixed(decimals) : null, i),
        ),
      }));

  // Compare mode overlays the baseline (no-intervention branch) as a dim line;
  // kept on the two headline charts, so a dozen more charts don't all double up.
  const base = compare ? baseline : null;

  const latency: ChartSeries[] = [
    { label: "latency", stroke: "#f5b301", unit: "ms", data: seriesOf(result, (w) => w.meanLatency, 2) },
    ...(base ? [{ label: "baseline", stroke: "#6b7280", unit: "ms", data: seriesOf(base, (w) => w.meanLatency, 2) }] : []),
  ];
  const percentiles: ChartSeries[] = [
    { label: "p50", stroke: "#34d399", unit: "ms", data: latSeriesOf((l) => l.p50, 2) },
    { label: "p95", stroke: "#f5b301", unit: "ms", data: latSeriesOf((l) => l.p95, 2) },
    { label: "p99", stroke: "#f87171", unit: "ms", data: latSeriesOf((l) => l.p99, 2) },
  ];
  const throughput: ChartSeries[] = [
    { label: "completed", stroke: "#34d399", unit: "/s", data: seriesOf(result, (w) => w.throughput) },
    { label: "failed", stroke: "#f87171", unit: "/s", data: seriesOf(result, (w) => w.failureRate) },
    ...(base ? [{ label: "failed (baseline)", stroke: "#6b7280", unit: "/s", data: seriesOf(base, (w) => w.failureRate) }] : []),
  ];
  const utilization = perStation((st) => st.utilization, 100, 1, "%");
  const queueDepth = perStation((st) => st.queue, 1, 2);
  const breakdown: ChartSeries[] = [
    { label: "network", stroke: NET, unit: "ms", data: latSeriesOf((l) => l.netMs, 2) },
    { label: "queue", stroke: WAIT, unit: "ms", data: latSeriesOf((l) => l.queueMs, 2) },
    { label: "service", stroke: SERVICE, unit: "ms", data: latSeriesOf((l) => l.serviceMs, 2) },
  ];
  const callRate = perStation((st) => st.calls, 1, 1, "/s");
  const hitRate = perStation((st) => st.hitRate, 100, 1, "%");
  const instances = perStation((st) => st.instances, 1, 0);
  const staleRate = perStation((st) => st.staleRate, 100, 1, "%");

  // Remount charts when the series SET or horizon changes (compare / graph / length).
  const sig = `${compare}-${result.horizonMs}-${result.stationIds.join(",")}`;

  return (
    <div className="h-full overflow-y-auto border-t border-neutral-800 bg-neutral-800">
      <Section title="request health">
        <Card>
          <Chart
            key={`lat-${sig}`}
            title="end-to-end latency (ms)"
            hint="Mean end-to-end request latency per time window. Amber is this run; grey is the same run with your injected failures removed (Compare mode). The gap is what the failure cost."
            x={xs}
            xRange={xRange}
            series={latency}
          />
        </Card>
        <Card>
          <Chart
            key={`pct-${sig}`}
            title="latency percentiles (ms)"
            hint="p50, p95, and p99 end-to-end latency per time window. The gap between p50 and p99 is the tail: retries, slow-draw service times, and lock contention show up here even when the mean looks fine."
            x={xs}
            xRange={xRange}
            series={percentiles}
          />
        </Card>
        <Card>
          <Chart
            key={`thr-${sig}`}
            title="throughput (req/s)"
            hint="Completed vs failed requests per second. Failures come from exhausted retries, queue overflow, or a dead dependency."
            x={xs}
            xRange={xRange}
            series={throughput}
          />
        </Card>
      </Section>

      <Section title="bottlenecks &amp; capacity">
        <Card>
          <Chart
            key={`util-${sig}`}
            title="utilization ρ (%)"
            hint="Per-tier utilization ρ (busy fraction of its servers). As a tier nears 100%, its queue and latency blow up. That's the bottleneck."
            x={xs}
            xRange={xRange}
            series={utilization}
          />
        </Card>
        <Card>
          <Chart
            key={`queue-${sig}`}
            title="queue depth (requests)"
            hint="Mean number of requests waiting per tier, not yet being served. A queue that keeps growing without draining is often the earliest sign of overload, before latency or utilization move much."
            x={xs}
            xRange={xRange}
            series={queueDepth}
          />
        </Card>
        <Card>
          <Chart
            key={`brk-${sig}`}
            title="latency breakdown (ms)"
            hint="Where time actually goes, averaged across requests that concluded each window: round-trip network time, time waiting in queue, and time being served. Queue time growing faster than service time is the signature of an overloaded tier."
            x={xs}
            xRange={xRange}
            series={breakdown}
          />
        </Card>
      </Section>

      <Section title="traffic distribution">
        <Card>
          <Chart
            key={`calls-${sig}`}
            title="requests/sec by tier"
            hint="Requests received per second, per tier. For a load-balanced set of backends, this shows whether the algorithm is actually spreading load evenly or favoring one instance."
            x={xs}
            xRange={xRange}
            series={callRate}
          />
        </Card>
      </Section>

      {(hitRate.length > 0 || instances.length > 0 || staleRate.length > 0) && (
        <Section title="feature-specific">
          {hitRate.length > 0 && (
            <Card>
              <Chart
                key={`hit-${sig}`}
                title="cache hit rate (%)"
                hint="Measured cache hit rate per window. A hit rate that drops under load usually means the working set no longer fits, or the cache died and every read is falling through."
                x={xs}
                xRange={xRange}
                series={hitRate}
              />
            </Card>
          )}
          {instances.length > 0 && (
            <Card>
              <Chart
                key={`inst-${sig}`}
                title="autoscaled instances"
                hint="Live instance count for each autoscaled tier. Watch the scale-up staircase during a burst, and the stabilization-window hold before it scales back down."
                x={xs}
                xRange={xRange}
                series={instances}
              />
            </Card>
          )}
          {staleRate.length > 0 && (
            <Card>
              <Chart
                key={`stale-${sig}`}
                title="stale replica reads (%)"
                hint="Fraction of replica reads returned within the replication lag window, so the data could be stale. Rises when write throughput outpaces how fast replicas catch up."
                x={xs}
                xRange={xRange}
                series={staleRate}
              />
            </Card>
          )}
        </Section>
      )}
    </div>
  );
}
