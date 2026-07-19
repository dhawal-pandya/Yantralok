// The Lens control in the timeline bar: an on/off toggle plus, when on, a
// Load / Latency / Cost selector for which signal tints the system. Off by
// default: the tint is a legibility aid and scales with system size, so it's
// opt-in, and off is the escape hatch on a large graph.
import { useLayoutStore, type GlowSignal } from "@/ui/store/layoutStore";
import { Tip } from "./Tooltip";

const SIGNALS: { signal: GlowSignal; label: string; tip: string }[] = [
  {
    signal: "load",
    label: "Load",
    tip: "Tint nodes by utilization ρ: the tier nearest 100% is your bottleneck",
  },
  {
    signal: "latency",
    label: "Latency",
    tip: "Tint nodes by where end-to-end latency accumulates",
  },
  {
    signal: "cost",
    label: "Cost",
    tip: "Tint nodes by cost share: costliest red, cheapest green",
  },
];

export function GlowToggle() {
  const glow = useLayoutStore((s) => s.glow);
  const signal = useLayoutStore((s) => s.glowSignal);
  const toggleGlow = useLayoutStore((s) => s.toggleGlow);
  const setSignal = useLayoutStore((s) => s.setGlowSignal);

  return (
    <div className="flex items-center gap-1">
      <Tip
        label={
          glow
            ? "Turn the lens off"
            : "Tint the whole system by a signal (load, latency, or cost) to spot the bottleneck at a glance"
        }
        side="top"
      >
        <button
          onClick={toggleGlow}
          className={`rounded border px-2 py-1 font-mono text-xs transition-colors ${
            glow
              ? "border-signal text-signal"
              : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
          }`}
        >
          ◉ Lens
        </button>
      </Tip>
      {glow && (
        <div className="flex items-center gap-0.5">
          {SIGNALS.map((s) => (
            <Tip key={s.signal} label={s.tip} side="top">
              <button
                onClick={() => setSignal(s.signal)}
                className={`rounded px-1.5 py-1 font-mono text-xs transition-colors ${
                  signal === s.signal
                    ? "bg-neutral-700 text-neutral-100"
                    : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {s.label}
              </button>
            </Tip>
          ))}
        </div>
      )}
    </div>
  );
}
