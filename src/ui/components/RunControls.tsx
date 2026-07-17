// Run controls: compute (Run / Re-run) + live readouts. Playback
// transport (play / seek) and the speed / length selectors live in the
// TimelineBar under the charts. Editing the graph marks the result stale.
import { getComponent } from "@/components";
import { useSystemStore } from "@/ui/store/systemStore";
import { isRunStale, useSimStore, windowAt } from "@/ui/store/simStore";
import { CostReadout } from "./CostReadout";
import { Tip } from "./Tooltip";

const fmt = (x: number, unit: string, digits = 0) =>
  Number.isFinite(x) ? `${x.toFixed(digits)}${unit}` : "-";

export function RunControls() {
  const sim = useSimStore();
  const doc = useSystemStore((s) => s.doc);
  const hasGraph = (doc?.graph.nodes.length ?? 0) > 0;
  const win = windowAt(sim.result, sim.clockMs);
  const stale = isRunStale(sim, doc);

  // Compare only means something once you've injected a failure: it overlays the
  // same run with those failures stripped. Gate + label it so that reads clearly.
  const canCompare = (doc?.interventions.length ?? 0) > 0;
  const comparing = sim.compare;
  const compareTip = comparing
    ? "Comparing against the no-failure baseline (grey line in the charts). Click to turn it off."
    : canCompare
      ? "Overlay a no-failure baseline: the same run with your injected failures stripped (same seed), so you can see exactly what they cost."
      : "Inject a failure first: select a node, then Inject (Kill / Restart / Delay). Compare then overlays a clean baseline to show its cost.";

  const labelFor = (id: string | null | undefined) => {
    if (!id) return "-";
    const node = doc?.graph.nodes.find((n) => n.id === id);
    return node ? (getComponent(node.type)?.label ?? node.type) : id;
  };
  const bottleneckLabel = () => labelFor(win?.bottleneck);

  const btn =
    "rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100 disabled:opacity-40";

  return (
    <div className="flex items-center gap-2.5 border-b border-neutral-800 bg-neutral-900 px-3 py-1.5">
      <Tip
        label={
          sim.result
            ? stale
              ? "Your changes aren't simulated yet. Re-run to apply them"
              : "Re-run the simulation from scratch"
            : "Compile and run the simulation"
        }
      >
        <button
          className={`rounded px-3 py-1 text-xs font-semibold text-neutral-950 transition-colors hover:bg-signal-bright disabled:opacity-40 ${
            stale
              ? "bg-signal-bright ring-2 ring-signal-bright/50"
              : "bg-signal"
          }`}
          onClick={() => sim.run()}
          disabled={!hasGraph}
        >
          {sim.result ? "↻ Re-run" : "▶ Run"}
          {stale && <span className="ml-1">•</span>}
        </button>
      </Tip>
      <Tip label={compareTip}>
        <button
          className={`${btn} ${comparing ? "border-signal text-signal" : ""}`}
          onClick={() => (comparing ? sim.exitCompare() : sim.runCompare())}
          disabled={!hasGraph || (!canCompare && !comparing)}
        >
          {comparing ? "⑂ Comparing" : "⑂ Compare"}
        </button>
      </Tip>
      <Tip label="Stop and clear the current run">
        <button
          className={btn}
          onClick={() => sim.clear()}
          disabled={!sim.result}
        >
          Stop
        </button>
      </Tip>

      {/* Live readouts */}
      <div className="ml-auto flex items-center gap-3 border-l border-neutral-800 pl-3 font-mono text-[10px]">
        <Readout
          label="thru"
          value={fmt(win?.throughput ?? NaN, " rps")}
          tip="Throughput: completed requests per second in the current window"
        />
        <Readout
          label="lat"
          value={fmt(win?.meanLatency ?? NaN, "ms", 1)}
          tip="Mean end-to-end request latency (ms) in the current window"
        />
        <Readout
          label="fail"
          value={fmt(win?.failureRate ?? NaN, " rps")}
          tone={win && win.failureRate > 0 ? "bad" : undefined}
          tip="Failed requests per second: exhausted retries, queue overflow, or a dead dependency"
        />
        <Readout
          label="bottleneck"
          value={bottleneckLabel()}
          tone="warn"
          tip="The busiest tier right now (highest utilization ρ)"
        />
        {win?.rootCause && win.rootCause !== win.bottleneck && (
          <Readout
            label="root cause"
            value={labelFor(win.rootCause)}
            tone="bad"
            tip="The first tier to saturate: the origin of a cascade, not just the current worst tier"
          />
        )}
        <CostReadout />
      </div>

      {sim.error && (
        <span className="text-[10px] text-red-400">{sim.error}</span>
      )}
    </div>
  );
}

function Readout({
  label,
  value,
  tone,
  tip,
}: {
  label: string;
  value: string;
  tone?: "warn" | "bad";
  tip?: string;
}) {
  const color =
    tone === "bad"
      ? "text-red-400"
      : tone === "warn"
        ? "text-amber-400"
        : "text-neutral-300";
  return (
    <Tip label={tip} side="bottom">
      <span className="cursor-help">
        <span className="text-neutral-600">{label} </span>
        <span className={color}>{value}</span>
      </span>
    </Tip>
  );
}
