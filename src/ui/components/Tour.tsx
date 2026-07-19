// A guided tour of the platform's loop: design, simulate, observe, break, replay.
// It shows once automatically for first-time visitors (tourOpen seeds from
// tourSeen) and is re-openable from the Guide button. A blocking backdrop
// captures clicks so it can't be dismissed by accident, and the card slides to
// the region each step describes.
import { useState } from "react";
import { useLayoutStore } from "@/ui/store/layoutStore";

type Pos = "center" | "left" | "right" | "top" | "bottom";

// Where the card centers, as a fraction of the viewport, per anchor region.
const AT: Record<Pos, { x: number; y: number }> = {
  center: { x: 50, y: 50 },
  left: { x: 26, y: 46 },
  right: { x: 74, y: 46 },
  top: { x: 50, y: 27 },
  bottom: { x: 50, y: 70 },
};

const STEPS: { title: string; body: string; at: Pos }[] = [
  {
    at: "center",
    title: "Welcome to Yantralok",
    body: "This is a whiteboard (or maybe blackboard) that runs your software systems. You design an architecture, then simulate real traffic through it and watch how it actually behaves under load. A few quick stops and you're ready.",
  },
  {
    at: "left",
    title: "Design a real system",
    body: "The palette on the left holds behavioral components: databases, caches, queues, APIs. Drag one onto the canvas (or click it), then wire components together by their handles. Every box is a model with real, editable numbers, not a picture.",
  },
  {
    at: "top",
    title: "Or start from a real one",
    body: "Not building from scratch? Open Guide in the top bar for a library of pre-built systems, from a simple CRUD API to Netflix, Uber, and Stripe, each with notes on what to look for and where it breaks. Load one and it drops onto the canvas.",
  },
  {
    at: "right",
    title: "Configure everything",
    body: "Select any node or connection and the Inspector on the right shows its behavior: concurrency, service time, retries, capacity. Every field explains itself on hover. You own the inputs; the engine owns the consequences.",
  },
  {
    at: "top",
    title: "Simulate it",
    body: "Press Run (or the spacebar) to send traffic through the system. The run is deterministic: the same design and seed always produce the exact same result, so anything you find, you can reproduce.",
  },
  {
    at: "bottom",
    title: "See where it hurts",
    body: "The charts below stream live latency, throughput, and utilization. Nodes warm up as they saturate. Flip Glow on in the timeline bar and pick a lens, utilization, latency, or cost, to tint the whole system at a glance.",
  },
  {
    at: "right",
    title: "Follow a single request",
    body: "Open the Requests panel to pick one request and read its whole life as a trace. On the canvas, pause playback and watch it travel: amber going out, cyan coming back, red where it failed.",
  },
  {
    at: "right",
    title: "Break it on purpose",
    body: "In the Inspector, inject a failure on any node: kill it, restart it, add delay, or partition it. Watch the failure cascade downstream through everything that depended on it, then hit Compare to measure exactly what it cost.",
  },
  {
    at: "bottom",
    title: "Travel through time",
    body: "Pause, rewind, and scrub the timeline to inspect any moment. Because every run is deterministic it replays exactly, so you can study a single incident as many times as you like.",
  },
  {
    at: "center",
    title: "You're set",
    body: "That's the whole loop: design, simulate, observe, break, replay. You can reopen this tour anytime from the Guide button in the top bar. Now go build something.",
  },
];

export function Tour() {
  const open = useLayoutStore((s) => s.tourOpen);
  const close = useLayoutStore((s) => s.closeTour);
  const [step, setStep] = useState(0);

  if (!open) return null;

  const last = step === STEPS.length - 1;
  const s = STEPS[step];
  const { x, y } = AT[s.at];
  // Reset for the next open, then dismiss (marks the tour seen).
  const done = () => {
    setStep(0);
    close();
  };

  return (
    <div className="fixed inset-0 z-50 bg-neutral-950/45">
      <div
        className="absolute w-[min(28rem,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-signal/40 bg-neutral-900 p-4 shadow-2xl transition-all duration-500 ease-out motion-reduce:transition-none"
        style={{ left: `${x}%`, top: `${y}%` }}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold text-signal">{s.title}</h3>
          <span className="font-mono text-[10px] text-neutral-500">
            {step + 1} / {STEPS.length}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-neutral-300">{s.body}</p>

        <div className="mt-3 flex items-center justify-center gap-1.5">
          {STEPS.map((_, i) => (
            <button
              key={i}
              aria-label={`Go to step ${i + 1}`}
              onClick={() => setStep(i)}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-4 bg-signal" : "w-1.5 bg-neutral-700 hover:bg-neutral-500"
              }`}
            />
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between">
          <button className="text-[11px] text-neutral-500 hover:text-neutral-300" onClick={done}>
            Skip tour
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
              onClick={() => (last ? done() : setStep((n) => n + 1))}
            >
              {last ? "Start building" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
