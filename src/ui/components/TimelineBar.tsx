// Playback transport, docked under the charts: play/pause, rewind, the seek
// scrubber, the playback-speed / run-length selectors, and the glow lens, all
// together so the timeline sits with the graphs it drives.
import { HORIZONS, SPEEDS, useSimStore } from "@/ui/store/simStore";
import { GlowToggle } from "./GlowToggle";
import { Tip } from "./Tooltip";

export function TimelineBar() {
  const sim = useSimStore();
  const has = sim.result !== null;
  const horizon = sim.result?.horizonMs ?? 0;

  const btn =
    "rounded border border-neutral-700 px-2 py-1 font-mono text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100 disabled:opacity-40";
  const selectCls =
    "rounded border border-neutral-700 bg-neutral-850 px-1.5 py-1 font-mono text-[11px] text-neutral-200 hover:border-neutral-600 focus:border-signal focus:outline-none";

  return (
    <div className="flex items-center gap-3 border-t border-neutral-800 bg-neutral-900 px-3 py-1.5">
      <Tip label="Play / pause playback (Space)" side="top">
        <button className={btn} onClick={() => sim.toggle()} disabled={!has}>
          {sim.playing ? "❚❚" : "▶"}
        </button>
      </Tip>
      <Tip label="Rewind to t = 0" side="top">
        <button className={btn} onClick={() => sim.reset()} disabled={!has}>
          ↺
        </button>
      </Tip>

      <Tip
        label="Timeline: scrub to any moment of the run; charts, packets, and readouts follow"
        side="top"
      >
        <input
          type="range"
          min={0}
          max={horizon || 1}
          step={10}
          value={sim.clockMs}
          onChange={(e) => sim.seek(Number(e.target.value))}
          disabled={!has}
          className="h-1.5 flex-1 accent-signal"
        />
      </Tip>

      <span className="w-28 text-right font-mono text-[10px] text-neutral-500">
        {(sim.clockMs / 1000).toFixed(2)}s / {(horizon / 1000).toFixed(0)}s
      </span>

      <div className="mx-0.5 h-4 w-px bg-neutral-800" />

      <Tip
        label="Playback speed: how fast simulated time advances on screen"
        side="top"
      >
        <label className="flex items-center gap-1 text-[10px] text-neutral-500">
          speed
          <select
            className={selectCls}
            value={sim.speed}
            onChange={(e) => sim.setSpeed(Number(e.target.value))}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
      </Tip>

      <Tip
        label="Simulation length: how much logical time to simulate. Re-runs on change."
        side="top"
      >
        <label className="flex items-center gap-1 text-[10px] text-neutral-500">
          length
          <select
            className={selectCls}
            value={sim.horizonMs}
            onChange={(e) => {
              sim.setHorizon(Number(e.target.value));
              if (sim.result) sim.run();
            }}
          >
            {HORIZONS.map((s) => (
              <option key={s} value={s * 1000}>
                {s}s
              </option>
            ))}
          </select>
        </label>
      </Tip>

      <div className="mx-0.5 h-4 w-px bg-neutral-800" />

      <GlowToggle />
    </div>
  );
}
