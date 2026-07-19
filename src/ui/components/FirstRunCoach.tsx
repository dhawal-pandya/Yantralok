// The first-run activation flow: a small non-blocking card that walks a new
// visitor through the whole loop on the pre-loaded example, one action per step,
// Run -> Break -> Measure -> done. It reads real sim/document state, so it can't
// be faked: each step advances only when the user actually does the thing. The
// labeled controls (Run, the Inspector's Kill, Compare) do the pointing; this
// just names the next action. Dismissible, and shown only until done once.
import { useLayoutStore } from "@/ui/store/layoutStore";
import { useSimStore } from "@/ui/store/simStore";
import { useSystemStore } from "@/ui/store/systemStore";

const STEPS = [
  {
    title: "Run the system",
    body: "Hit the amber ▶ Run button at the top left (or press Space) to send live traffic through this example. The nodes warm up and the charts fill in.",
  },
  {
    title: "Now break it",
    body: "Click a node on the canvas (kill the Redis cache here), then press Kill in the Inspector on the right. The failure cascades downstream and requests start to fail.",
  },
  {
    title: "Measure the damage",
    body: "Press ⑂ Compare at the top to overlay the healthy baseline. The gap between the two lines is exactly what the failure cost.",
  },
  {
    title: "That's the whole loop",
    body: "Design, run, break, measure. This example is yours to edit, or start a fresh one from the Systems menu at the top left.",
  },
];

export function FirstRunCoach() {
  const done = useLayoutStore((s) => s.activationDone);
  const complete = useLayoutStore((s) => s.completeActivation);
  const hasResult = useSimStore((s) => s.result !== null);
  const comparing = useSimStore((s) => s.compare);
  const nodeCount = useSystemStore((s) => s.doc?.graph.nodes.length ?? 0);
  const injected = useSystemStore((s) => (s.doc?.interventions.length ?? 0) > 0);

  // Only guide when there's something to run; never nag on an empty canvas.
  if (done || nodeCount === 0) return null;

  const step = !hasResult ? 0 : !injected ? 1 : !comparing ? 2 : 3;
  const s = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-md rounded-lg border border-signal/40 bg-neutral-900 p-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold text-signal">{s.title}</h3>
          <span className="font-mono text-[10px] text-neutral-500">
            {step + 1} / {STEPS.length}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-neutral-300">{s.body}</p>

        <div className="mt-3 flex items-center justify-center gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-4 bg-signal" : i < step ? "w-1.5 bg-signal/50" : "w-1.5 bg-neutral-700"
              }`}
            />
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between">
          <button className="text-[11px] text-neutral-500 hover:text-neutral-300" onClick={complete}>
            Skip
          </button>
          {last ? (
            <button
              className="rounded bg-signal px-3 py-1 text-[11px] font-semibold text-neutral-950 hover:bg-signal-bright"
              onClick={complete}
            >
              Got it
            </button>
          ) : (
            <span className="font-mono text-[10px] text-neutral-600">do the step to continue</span>
          )}
        </div>
      </div>
    </div>
  );
}
