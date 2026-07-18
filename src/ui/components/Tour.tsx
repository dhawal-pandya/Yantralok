// A one-time guided tour of the platform's breadth: Design, Simulate, Observe,
// Break, Time-travel. It is marked seen on mount (persisted to localStorage), so a
// returning visitor never sees it again, and it's skippable at any step. A calm
// floating card, not a blocking modal.
import { useEffect, useState } from "react";
import { useLayoutStore } from "@/ui/store/layoutStore";

const STEPS = [
  {
    title: "Design a real system",
    body: "This canvas is a system, not a drawing. Drag a component from the palette on the left onto the canvas (or click to drop one in), position it, then connect components by their handles. Every box is a behavioral model with real numbers you can edit.",
  },
  {
    title: "Simulate it",
    body: "Press Run (or the spacebar) to send traffic through it. The charts below stream live latency, throughput, and utilization as the run plays.",
  },
  {
    title: "See where it hurts",
    body: "Nodes warm up as they saturate and packets show real requests in flight. Flip Glow on in the timeline bar and pick a lens: utilization ρ, latency, or cost, to tint the whole system at a glance.",
  },
  {
    title: "Break it on purpose",
    body: "Select any node and inject a failure: kill it, restart it, or add delay. Then watch the failure cascade downstream through everything that depended on it.",
  },
  {
    title: "Travel through time",
    body: "Pause, rewind, and scrub the timeline; Compare overlays the same run with your failure removed. Every run is deterministic, so it replays exactly.",
  },
];

export function Tour() {
  const markSeen = useLayoutStore((s) => s.markTourSeen);
  // Capture "seen?" once at mount; local state drives this session's display so
  // marking it seen (below) doesn't yank the card away mid-tour.
  const [open, setOpen] = useState(() => !useLayoutStore.getState().tourSeen);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (open) markSeen();
  }, [open, markSeen]);

  if (!open) return null;

  const last = step === STEPS.length - 1;
  const s = STEPS[step];

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold text-signal">
            {s.title}
          </h3>
          <span className="font-mono text-[10px] text-neutral-500">
            {step + 1} / {STEPS.length}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-neutral-300">
          {s.body}
        </p>
        <div className="mt-3 flex items-center justify-between">
          <button
            className="text-[11px] text-neutral-500 hover:text-neutral-300"
            onClick={() => setOpen(false)}
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                className="rounded border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
                onClick={() => setStep((n) => n - 1)}
              >
                Back
              </button>
            )}
            <button
              className="rounded bg-signal px-3 py-1 text-[11px] font-semibold text-neutral-950 hover:bg-signal-bright"
              onClick={() => (last ? setOpen(false) : setStep((n) => n + 1))}
            >
              {last ? "Start building" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
